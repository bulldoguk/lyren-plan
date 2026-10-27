// Our own SMTP submission client (design §5.10.4), shared by both runtimes: each supplies a connector
// (runtime/node/smtpConnector.ts over node:net and node:tls, runtime/cloudflare/smtpConnector.ts over
// cloudflare:sockets). worker-mailer and nodemailer are not used (§5.10.4: a Bcc leak, header injection
// and clear-text AUTH in one, DNS trouble on Workers and 62 KB in the other).
//
// One message per connection:
//   1. the 220 greeting, then EHLO <SMTP_EHLO_NAME> (multi-line 250- replies);
//   2. SMTP_SECURITY=starttls: STARTTLS must be advertised, else the message is refused before anything
//      else is sent; after the 220, any bytes the server sent along with it are refused (a man in the
//      middle could have injected replies there), the connection becomes TLS and EHLO is sent again;
//      SMTP_SECURITY=tls connects with TLS from the start. The connector verifies the certificate against
//      SMTP_HOST, always;
//   3. with SMTP_USER: AUTH PLAIN, or AUTH LOGIN when only that is offered, and only over TLS;
//   4. MAIL FROM, RCPT TO, DATA, the dot-stuffed message and the final dot, then QUIT.
// SMTP_SECURITY=none (a mail server on this machine, without AUTH; core/config.ts) skips step 2.
// Each reply has 15 s and at most 64 KiB in 512 lines, the whole message 60 s (fewer when the caller gives a
// shorter timeout). Errors are MailErrors that name the step and carry the reply code; neither the password
// nor the AUTH line ever appears in one (the server's text is redacted too, in case it echoes them).

import type { MailFrom, SmtpConfig } from '../../core/config';
import { toBase64 } from '../../core/crypto';
import { MailError, redact } from '../errors';
import { buildMimeMessage, checkAddress, dotStuff, type Envelope } from '../message';
import type { MailMessage, MailTransport, SendOptions } from '../transport';

export interface SmtpSocket {
  /** The next bytes received; null once the connection is closed. */
  read(): Promise<Uint8Array | null>;
  write(data: Uint8Array): Promise<void>;
  /** The same connection over TLS, its certificate verified against `servername`. */
  startTls(servername: string): Promise<SmtpSocket>;
  close(): Promise<void>;
}

export interface SmtpConnector {
  /** A connection to host:port, TLS from the start when `implicitTls` (the certificate verified against `host`). */
  connect(o: { host: string; port: number; implicitTls: boolean; timeoutMs: number }): Promise<SmtpSocket>;
}

export interface SmtpTimeouts {
  /** How long one reply may take (and the connection, and each write). */
  replyMs: number;
  /** How long a whole message may take. */
  totalMs: number;
}

/** §5.10.4: 15 s per reply, 60 s in total. */
export const SMTP_TIMEOUTS: SmtpTimeouts = { replyMs: 15_000, totalMs: 60_000 };

/** The refusal of §5.10.4 when STARTTLS is required and not offered. */
export const STARTTLS_MISSING = 'The SMTP server does not offer STARTTLS; refusing to send credentials in clear text';

/** A reply longer than this (all its lines together), or with more lines, ends the connection. */
const MAX_REPLY_BYTES = 64 * 1024;
const MAX_REPLY_LINES = 512;
/** How long QUIT waits for its reply once the message was accepted. */
const QUIT_WAIT_MS = 2_000;

interface Reply {
  code: number;
  /** The text of each line, after the code and its separator. */
  lines: string[];
}

const encoder = new TextEncoder();

/** `work`, or `error()` once `ms` have passed first. The losing side never ends as an unhandled rejection. */
async function within<T>(work: Promise<T>, ms: number, error: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(error()), Math.max(0, ms));
  });
  work.catch(() => {});
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** One SMTP conversation over a connection (which it may replace by its TLS upgrade). */
class Session {
  /** Bytes received are buffer[start, end) (those before `start` are read already); no line break before `scanned`. */
  private buffer = new Uint8Array(0);
  private start = 0;
  private end = 0;
  private scanned = 0;
  private readonly decoder = new TextDecoder();
  constructor(
    private socket: SmtpSocket,
    private readonly timeouts: SmtpTimeouts,
    /** When the whole message must be done (ms epoch). */
    private readonly endsAt: number,
    private readonly secrets: ReadonlyArray<string>,
  ) {}

  get connection(): SmtpSocket {
    return this.socket;
  }

  /** `work`, unless the reply timeout or the end of the whole message comes first. */
  timed<T>(work: Promise<T>, step: string, replyMs = this.timeouts.replyMs): Promise<T> {
    const left = this.endsAt - Date.now();
    return within(work, Math.min(replyMs, left), () =>
      left <= replyMs ? new MailError(`The SMTP conversation took too long (${step})`) : new MailError(`The SMTP server did not answer in time (${step})`),
    );
  }

  /** Writes one command line (CRLF added; a command never contains a line break). */
  async command(line: string, step: string): Promise<void> {
    await this.timed(this.socket.write(encoder.encode(`${line}\r\n`)), step);
  }

  async writeData(data: string, step: string): Promise<void> {
    await this.timed(this.socket.write(encoder.encode(data)), step);
  }

  /**
   * The next complete reply: multi-line ("250-…" lines up to "250 …"), every line with the same code, at
   * most MAX_REPLY_BYTES and MAX_REPLY_LINES (a server that never ends its reply is refused, not buffered).
   */
  async reply(step: string, replyMs?: number): Promise<Reply> {
    const lines: string[] = [];
    let code = 0;
    let bytes = 0;
    for (;;) {
      const { line, size } = await this.line(step, replyMs, MAX_REPLY_BYTES - bytes);
      bytes += size;
      if (lines.length >= MAX_REPLY_LINES) throw new MailError(`The SMTP server sent a reply that is too long (${step})`);
      const match = /^(\d{3})(?:([ -])(.*))?$/.exec(line);
      if (!match) throw new MailError(`The SMTP server sent a malformed reply (${step}): ${this.clean(line)}`);
      const lineCode = Number(match[1]);
      if (lines.length > 0 && lineCode !== code) throw new MailError(`The SMTP server sent a malformed reply (${step}): mixed reply codes`);
      code = lineCode;
      lines.push(match[3] ?? '');
      if (match[2] !== '-') return { code, lines };
    }
  }

  /** Sends a command and reads its reply, which must have one of the `expected` codes. */
  async expect(line: string | null, step: string, expected: readonly number[]): Promise<Reply> {
    if (line !== null) await this.command(line, step);
    const reply = await this.reply(step);
    if (!expected.includes(reply.code)) throw this.refusal(step, reply);
    return reply;
  }

  refusal(step: string, reply: Reply): MailError {
    return new MailError(`The SMTP server refused ${step} (${reply.code}): ${this.clean(reply.lines.join(' '))}`, reply.code);
  }

  /** Server text, safe to log: the secrets (and their base64 forms) redacted. */
  clean(text: string): string {
    return redact(text, this.secrets);
  }

  /** Bytes received but not read yet (the check after STARTTLS's 220). */
  get pending(): number {
    return this.end - this.start;
  }

  /** The connection is now `socket` (after STARTTLS); nothing of the old one is kept. */
  upgraded(socket: SmtpSocket): void {
    this.socket = socket;
    this.buffer = new Uint8Array(0);
    this.start = this.end = this.scanned = 0;
  }

  /**
   * The next line (without its CRLF) and its size in bytes (with it), which must stay within `maxBytes`.
   * Each byte received is searched once and copied about once (a line is a view, the buffer grows by
   * doubling), so a stream of short lines, which arrives as one chain of microtasks, costs time in
   * proportion to its length, and the caller's bounds end it.
   */
  private async line(step: string, replyMs: number | undefined, maxBytes: number): Promise<{ line: string; size: number }> {
    for (;;) {
      const lf = this.buffer.subarray(0, this.end).indexOf(0x0a, this.scanned);
      if (lf >= 0) {
        const size = lf + 1 - this.start;
        if (size > maxBytes) break;
        const end = lf > this.start && this.buffer[lf - 1] === 0x0d ? lf - 1 : lf;
        const line = this.decoder.decode(this.buffer.subarray(this.start, end));
        this.start = this.scanned = lf + 1;
        return { line, size };
      }
      this.scanned = this.end;
      if (this.pending > maxBytes) break;
      const chunk = await this.timed(this.socket.read(), step, replyMs);
      if (chunk === null) throw new MailError(`The SMTP server closed the connection (${step})`);
      this.append(chunk);
    }
    throw new MailError(`The SMTP server sent a reply that is too long (${step})`);
  }

  /**
   * Adds `chunk` after the bytes not read yet. When it does not fit, the bytes read are dropped: in place
   * while that leaves half the buffer free, else into one twice as large (or as large as needed).
   */
  private append(chunk: Uint8Array): void {
    if (this.end + chunk.length > this.buffer.length) {
      const pending = this.pending;
      const room = pending + chunk.length;
      if (2 * room <= this.buffer.length) {
        this.buffer.copyWithin(0, this.start, this.end);
      } else {
        const grown = new Uint8Array(Math.max(room, 2 * this.buffer.length, 4096));
        grown.set(this.buffer.subarray(this.start, this.end));
        this.buffer = grown;
      }
      this.scanned -= this.start;
      this.start = 0;
      this.end = pending;
    }
    this.buffer.set(chunk, this.end);
    this.end += chunk.length;
  }
}

/** The EHLO keywords (upper case) and their parameters, from the lines after the first. */
function capabilities(reply: Reply): Map<string, string[]> {
  const caps = new Map<string, string[]>();
  for (const line of reply.lines.slice(1)) {
    const [keyword = '', ...params] = line.trim().split(/[\s=]+/);
    if (keyword !== '') caps.set(keyword.toUpperCase(), params.map((p) => p.toUpperCase()));
  }
  return caps;
}

const base64 = (text: string) => toBase64(encoder.encode(text));

/** The host as a connector gets it: an IPv6 literal without its brackets. */
export const bareHost = (host: string) => (host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host);

export interface SmtpTransportOptions {
  /** MAIL_REPLY_TO, or null. */
  replyTo?: string | null;
  /** Tests make the conversation fast to time out. */
  timeouts?: SmtpTimeouts;
}

/**
 * Why a connection failed. When a host has several addresses (localhost: ::1 and 127.0.0.1) and every
 * one fails, Node's autoSelectFamily rejects with an AggregateError whose message is empty: name each
 * address's error instead.
 */
function connectErrorText(err: unknown): string {
  if (err instanceof AggregateError && !err.message) {
    const causes = err.errors.map((e) => String((e as Error)?.message ?? e)).filter(Boolean);
    if (causes.length > 0) return causes.join('; ');
    if ('code' in err && typeof err.code === 'string') return err.code;
  }
  return String((err as Error)?.message ?? err);
}

/** Sends one message over a new connection; returns its Message-ID. */
export async function sendSmtp(
  config: SmtpConfig,
  connector: SmtpConnector,
  envelope: Envelope,
  message: MailMessage,
  o: { timeouts?: SmtpTimeouts; timeoutMs?: number } = {},
): Promise<{ messageId: string }> {
  const timeouts = o.timeouts ?? SMTP_TIMEOUTS;
  const totalMs = Math.min(timeouts.totalMs, o.timeoutMs ?? Number.POSITIVE_INFINITY);
  const startedAt = Date.now();
  // Refused before connecting: an invalid header or address sends nothing at all.
  const mime = buildMimeMessage(message, envelope, startedAt);
  const from = checkAddress('From', envelope.from.address);
  const to = checkAddress('To', message.to);
  const secrets = config.pass === null ? [] : [config.pass, base64(config.pass), base64(`\0${config.user ?? ''}\0${config.pass}`)];
  const host = bareHost(config.host);
  const where = `${config.host}:${config.port}`;

  const connectMs = Math.min(timeouts.replyMs, totalMs);
  const connecting = connector.connect({ host, port: config.port, implicitTls: config.security === 'tls', timeoutMs: connectMs });
  let socket: SmtpSocket;
  try {
    socket = await within(connecting, connectMs, () => new MailError('no answer in time'));
  } catch (err) {
    // A connection that arrives after its timeout is closed at once.
    void connecting.then((late) => late.close()).catch(() => {});
    const how = config.security === 'tls' ? ` with TLS (its certificate must be valid for ${config.host})` : '';
    throw new MailError(`Could not connect to the SMTP server ${where}${how}: ${redact(connectErrorText(err), secrets)}`);
  }

  const session = new Session(socket, timeouts, startedAt + totalMs, secrets);
  let tls = config.security === 'tls';
  try {
    await session.expect(null, 'the connection (greeting)', [220]);
    let caps = capabilities(await session.expect(`EHLO ${config.ehloName}`, 'EHLO', [250]));
    if (config.security === 'starttls') {
      if (!caps.has('STARTTLS')) throw new MailError(STARTTLS_MISSING);
      await session.expect('STARTTLS', 'STARTTLS', [220]);
      if (session.pending > 0) throw new MailError('The SMTP server sent data after its STARTTLS reply; refusing to go on');
      try {
        session.upgraded(await session.timed(session.connection.startTls(host), 'the TLS handshake'));
        tls = true;
        caps = capabilities(await session.expect(`EHLO ${config.ehloName}`, 'EHLO', [250]));
      } catch (err) {
        // A refused certificate shows only as a failed handshake or a lost connection (workerd).
        if (err instanceof MailError && err.status !== null) throw err;
        const reason = err instanceof MailError ? err.message : redact(String((err as Error)?.message ?? err), secrets);
        throw new MailError(`The TLS handshake with ${where} failed (its certificate must be valid for ${config.host}): ${reason}`);
      }
    }
    if (config.user !== null && config.pass !== null) {
      // Defence in depth: the configuration allows AUTH only with tls or starttls.
      if (!tls) throw new MailError('Refusing to send SMTP credentials without TLS');
      const mechanisms = caps.get('AUTH') ?? [];
      if (mechanisms.includes('PLAIN')) {
        await session.expect(`AUTH PLAIN ${base64(`\0${config.user}\0${config.pass}`)}`, 'AUTH', [235]);
      } else if (mechanisms.includes('LOGIN')) {
        await session.expect('AUTH LOGIN', 'AUTH', [334]);
        await session.expect(base64(config.user), 'AUTH', [334]);
        await session.expect(base64(config.pass), 'AUTH', [235]);
      } else {
        throw new MailError('The SMTP server offers neither AUTH PLAIN nor AUTH LOGIN, and SMTP_USER is set');
      }
    }
    await session.expect(`MAIL FROM:<${from}>`, 'MAIL FROM', [250]);
    await session.expect(`RCPT TO:<${to}>`, 'RCPT TO', [250, 251]);
    await session.expect('DATA', 'DATA', [354]);
    const stuffed = dotStuff(mime.data);
    await session.writeData(`${stuffed.endsWith('\r\n') ? stuffed : `${stuffed}\r\n`}.\r\n`, 'the message');
    const accepted = await session.reply('the message');
    if (accepted.code !== 250) throw session.refusal('the message', accepted);
    // The message is accepted: QUIT is a courtesy, and its failures change nothing.
    try {
      await session.command('QUIT', 'QUIT');
      await session.reply('QUIT', QUIT_WAIT_MS);
    } catch {
      // ignored
    }
    return { messageId: mime.messageId };
  } catch (err) {
    if (err instanceof MailError) throw err;
    // A connection error (a failed TLS handshake, a reset): its text is the platform's.
    throw new MailError(`The SMTP connection to ${where} failed: ${redact(String((err as Error)?.message ?? err), secrets)}`);
  } finally {
    await session.connection.close().catch(() => {});
  }
}

/** The smtp transport (§5.10.2): one connection per message, through the runtime's connector. */
export function createSmtpTransport(config: SmtpConfig, connector: SmtpConnector, from: MailFrom, options: SmtpTransportOptions = {}): MailTransport {
  const envelope: Envelope = { from, replyTo: options.replyTo ?? null };
  return {
    kind: 'smtp',
    deliversMail: true,
    send: (message: MailMessage, o: SendOptions = {}) => sendSmtp(config, connector, envelope, message, { timeouts: options.timeouts, timeoutMs: o.timeoutMs }),
  };
}
