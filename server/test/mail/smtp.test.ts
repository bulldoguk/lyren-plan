// The SMTP client (mail/smtp/client.ts, design §5.10.4) over Node's connector (runtime/node/smtpConnector.ts),
// against fake servers on 127.0.0.1 (support/fakeSmtp.ts) with throwaway certificates made by openssl at
// test time (support/testCerts.ts): plain, STARTTLS and implicit TLS; STARTTLS missing (refused before
// any AUTH); AUTH PLAIN and LOGIN, and a refused AUTH; certificates that do not verify; slow replies and
// the total timeout (short, injected timeouts); a 5xx on RCPT; long multi-line and split replies; a
// reply that never ends; bytes injected after STARTTLS. The password appears in no error.

import fs from 'node:fs';
import net from 'node:net';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { SmtpConfig } from '../../src/core/config';
import { MailError } from '../../src/mail/errors';
import { createSmtpTransport, sendSmtp, STARTTLS_MISSING, type SmtpTimeouts } from '../../src/mail/smtp/client';
import { createNodeSmtpConnector } from '../../src/runtime/node/smtpConnector';
import { startFakeSmtp, type FakeSmtpOptions, type FakeSmtpServer } from '../support/fakeSmtp';
import { makeTestCerts, missingOpenssl, type TestCerts } from '../support/testCerts';

const PASSWORD = 's3cret-Pa55word';
const USER = 'mailer@example.com';
const B64_PLAIN = Buffer.from(`\0${USER}\0${PASSWORD}`).toString('base64');
const B64_PASS = Buffer.from(PASSWORD).toString('base64');

const envelope = { from: { address: 'no-reply@plan.example.com', name: 'Lyren Plan' }, replyTo: null };
const message = { to: 'alice@example.com', subject: 'Hello', text: 'Hello Alice\n.dot line', html: '<p>Hello Alice</p>', template: 'mail_test' };
const FAST: SmtpTimeouts = { replyMs: 300, totalMs: 2_000 };

const servers: FakeSmtpServer[] = [];
async function server(o: FakeSmtpOptions = {}) {
  const s = await startFakeSmtp(o);
  servers.push(s);
  return s;
}
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

const smtp = (port: number, o: Partial<SmtpConfig> = {}): SmtpConfig => ({
  host: 'localhost',
  port,
  security: 'none',
  user: null,
  pass: null,
  ehloName: 'plan.example.com',
  ...o,
});

/** The rejection of `p` (a MailError), or a failure when it resolved. */
async function failure(p: Promise<unknown>): Promise<MailError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(MailError);
    const text = (err as Error).message;
    for (const secret of [PASSWORD, B64_PLAIN, B64_PASS]) expect(text).not.toContain(secret);
    return err as MailError;
  }
  throw new Error('expected the send to fail');
}

const verbs = (s: FakeSmtpServer) => s.sessions.at(-1)!.commands.map((c) => `${c.secure ? 'tls ' : ''}${c.line.split(' ')[0]}`);

describe('plain connections (SMTP_SECURITY=none)', () => {
  it('sends one message: greeting, EHLO, MAIL FROM, RCPT TO, DATA, the message, QUIT', async () => {
    const s = await server();
    const connector = createNodeSmtpConnector();
    const transport = createSmtpTransport(smtp(s.port), connector, envelope.from, { timeouts: FAST });
    expect(transport).toMatchObject({ kind: 'smtp', deliversMail: true });
    const { messageId } = await transport.send(message);
    const session = s.sessions.at(-1)!;
    expect(session.commands.map((c) => c.line)).toEqual([
      'EHLO plan.example.com',
      'MAIL FROM:<no-reply@plan.example.com>',
      'RCPT TO:<alice@example.com>',
      'DATA',
      'QUIT',
    ]);
    expect(session.messages).toHaveLength(1);
    const data = session.messages[0]!;
    expect(data).toContain(`Message-ID: ${messageId}\r\n`);
    expect(data).toContain('To: alice@example.com\r\n');
    expect(data.endsWith('--\r\n')).toBe(true);
    const text = /charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n([^-]+)/.exec(data)![1]!;
    expect(Buffer.from(text.replace(/\r\n/g, ''), 'base64').toString()).toBe('Hello Alice\r\n.dot line');
  });

  it('parses long multi-line EHLO replies and replies split across many reads', async () => {
    const capabilities = Array.from({ length: 60 }, (_, i) => `X-CAPABILITY-${i} with some parameters`);
    const s = await server({ capabilities, chunkBytes: 3 });
    await sendSmtp(smtp(s.port), createNodeSmtpConnector(), envelope, message, { timeouts: { replyMs: 2_000, totalMs: 10_000 } });
    expect(s.sessions.at(-1)!.messages).toHaveLength(1);
  });

  it('refuses a reply whose lines carry different codes, and a malformed reply', async () => {
    const mixed = await server({ replies: { EHLO: ['250-fake.example', '220 STARTTLS'] } });
    expect((await failure(sendSmtp(smtp(mixed.port), createNodeSmtpConnector(), envelope, message, { timeouts: FAST }))).message).toMatch(
      /malformed reply \(EHLO\): mixed reply codes/,
    );
    const garbage = await server({ replies: { GREETING: 'hello there' } });
    expect((await failure(sendSmtp(smtp(garbage.port), createNodeSmtpConnector(), envelope, message, { timeouts: FAST }))).message).toMatch(
      /malformed reply/,
    );
  });

  it('stops at a 5xx to RCPT TO, with the code, and sends no DATA', async () => {
    const s = await server({ replies: { RCPT: '550 5.1.1 <alice@example.com>: Recipient address rejected' } });
    const err = await failure(sendSmtp(smtp(s.port), createNodeSmtpConnector(), envelope, message, { timeouts: FAST }));
    expect(err.status).toBe(550);
    expect(err.message).toBe('The SMTP server refused RCPT TO (550): 5.1.1 <alice@example.com>: Recipient address rejected');
    expect(verbs(s)).not.toContain('DATA');
  });

  it('stops at a refused greeting and a refused message', async () => {
    const busy = await server({ replies: { GREETING: '554 5.3.2 Too busy' } });
    expect((await failure(sendSmtp(smtp(busy.port), createNodeSmtpConnector(), envelope, message, { timeouts: FAST }))).status).toBe(554);
    const spam = await server({ replies: { MESSAGE: '552 5.3.4 Message too big' } });
    const err = await failure(sendSmtp(smtp(spam.port), createNodeSmtpConnector(), envelope, message, { timeouts: FAST }));
    expect(err.message).toBe('The SMTP server refused the message (552): 5.3.4 Message too big');
  });

  it('times out a slow reply (the per-reply timeout) and a slow conversation (the total)', async () => {
    const slow = await server({ delays: { GREETING: 1_000 } });
    const err = await failure(sendSmtp(smtp(slow.port), createNodeSmtpConnector(), envelope, message, { timeouts: { replyMs: 100, totalMs: 5_000 } }));
    expect(err.message).toBe('The SMTP server did not answer in time (the connection (greeting))');
    const steady = await server({ delays: { EHLO: 80, MAIL: 80, RCPT: 80, DATA: 80 } });
    const total = await failure(sendSmtp(smtp(steady.port), createNodeSmtpConnector(), envelope, message, { timeouts: { replyMs: 150, totalMs: 200 } }));
    expect(total.message).toMatch(/^The SMTP conversation took too long/);
    // The caller's own deadline (the invitation's 10 s) shortens the total too.
    const capped = await server({ delays: { EHLO: 300 } });
    const short = await failure(sendSmtp(smtp(capped.port), createNodeSmtpConnector(), envelope, message, { timeouts: { replyMs: 1_000, totalMs: 5_000 }, timeoutMs: 100 }));
    expect(short.message).toMatch(/took too long \(EHLO\)/);
  });

  it('reports a server that closes the connection, and one that is not there', async () => {
    const s = await server({ replies: { MAIL: [] } });
    // A server that never answers MAIL FROM and is then stopped.
    const pending = failure(sendSmtp(smtp(s.port), createNodeSmtpConnector(), envelope, message, { timeouts: { replyMs: 2_000, totalMs: 5_000 } }));
    await new Promise((r) => setTimeout(r, 100));
    await s.close();
    expect((await pending).message).toMatch(/closed the connection \(MAIL FROM\)|connection to localhost:\d+ failed/);
    const gone = await failure(sendSmtp(smtp(s.port), createNodeSmtpConnector(), envelope, message, { timeouts: FAST }));
    expect(gone.message).toMatch(new RegExp(`^Could not connect to the SMTP server localhost:${s.port}: .*ECONNREFUSED`));
  });

  it('names every address that refused when the host has several (an empty AggregateError)', async () => {
    const refused = (address: string) => Object.assign(new Error(`connect ECONNREFUSED ${address}:2525`), { code: 'ECONNREFUSED' });
    const both = Object.assign(new AggregateError([refused('::1'), refused('127.0.0.1')]), { code: 'ECONNREFUSED' });
    const err = await failure(sendSmtp(smtp(2525), { connect: () => Promise.reject(both) }, envelope, message, { timeouts: FAST }));
    expect(err.message).toBe(
      'Could not connect to the SMTP server localhost:2525: connect ECONNREFUSED ::1:2525; connect ECONNREFUSED 127.0.0.1:2525',
    );
    const bare = Object.assign(new AggregateError([]), { code: 'ECONNREFUSED' });
    const none = await failure(sendSmtp(smtp(2525), { connect: () => Promise.reject(bare) }, envelope, message, { timeouts: FAST }));
    expect(none.message).toBe('Could not connect to the SMTP server localhost:2525: ECONNREFUSED');
  });

  it('never sends credentials without TLS (the configuration refuses that too)', async () => {
    const s = await server();
    const err = await failure(sendSmtp(smtp(s.port, { user: USER, pass: PASSWORD }), createNodeSmtpConnector(), envelope, message, { timeouts: FAST }));
    expect(err.message).toBe('Refusing to send SMTP credentials without TLS');
    expect(s.sessions.at(-1)!.auth).toEqual([]);
    expect(verbs(s)).toEqual(['EHLO']);
  });

  it('refuses a reply that never ends (64 KiB or 512 lines) at once, without holding up the event loop', async () => {
    // A hostile server (or anyone before STARTTLS): after the greeting, '250-' lines as fast as it can write.
    const hostile = (line: string) =>
      new Promise<{ port: number; close(): Promise<void> }>((resolve) => {
        const sockets = new Set<net.Socket>();
        const srv = net.createServer((socket) => {
          sockets.add(socket);
          socket.on('error', () => {});
          socket.write('220 hostile.example ESMTP\r\n');
          socket.once('data', () => {
            const chunk = Buffer.from(line.repeat(Math.floor(65_536 / line.length)));
            const pump = () => {
              while (!socket.destroyed) if (!socket.write(chunk)) return void socket.once('drain', pump);
            };
            pump();
          });
        });
        srv.listen(0, '127.0.0.1', () =>
          resolve({
            port: (srv.address() as net.AddressInfo).port,
            close: () => new Promise((done) => {
              for (const s of sockets) s.destroy();
              srv.close(() => done());
            }),
          }),
        );
      });
    for (const line of [`250-${'A'.repeat(1020)}\r\n`, '250-\r\n']) {
      const s = await hostile(line);
      const delay = monitorEventLoopDelay({ resolution: 10 });
      delay.enable();
      const started = Date.now();
      const err = await failure(sendSmtp(smtp(s.port), createNodeSmtpConnector(), envelope, message, { timeouts: { replyMs: 5_000, totalMs: 10_000 } }));
      delay.disable();
      await s.close();
      expect(err.message).toBe('The SMTP server sent a reply that is too long (EHLO)');
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(delay.max / 1e6).toBeLessThan(500);
    }
  });

  it('sends nothing for a message it refuses (an injected header)', async () => {
    const s = await server();
    await expect(sendSmtp(smtp(s.port), createNodeSmtpConnector(), envelope, { ...message, subject: 'x\r\nBcc: evil@example.com' })).rejects.toThrow(
      /line break/,
    );
    expect(s.sessions).toEqual([]);
  });
});

const skipTls = missingOpenssl();

describe.skipIf(skipTls !== null)(`TLS${skipTls ? ` (skipped: ${skipTls})` : ''}`, () => {
  let certs: TestCerts;
  beforeAll(() => {
    certs = makeTestCerts();
  });
  afterAll(() => {
    if (certs) fs.rmSync(certs.dir, { recursive: true, force: true });
  });
  const trusted = () => createNodeSmtpConnector({ ca: certs.ca });
  const tls = () => ({ key: certs.key, cert: certs.cert });

  it('STARTTLS: upgrades, says EHLO again, then AUTH PLAIN, all over TLS', async () => {
    const s = await server({ tls: tls(), credentials: { user: USER, pass: PASSWORD } });
    await sendSmtp(smtp(s.port, { security: 'starttls', user: USER, pass: PASSWORD }), trusted(), envelope, message, { timeouts: FAST });
    expect(verbs(s)).toEqual(['EHLO', 'STARTTLS', 'tls EHLO', 'tls AUTH', 'tls MAIL', 'tls RCPT', 'tls DATA', 'tls QUIT']);
    expect(s.sessions.at(-1)!.auth).toEqual([{ mechanism: 'PLAIN', user: USER, pass: PASSWORD }]);
    expect(s.sessions.at(-1)!.messages).toHaveLength(1);
  });

  it('implicit TLS with AUTH LOGIN when the server offers only LOGIN', async () => {
    const s = await server({ mode: 'implicit', tls: tls(), auth: ['LOGIN'], credentials: { user: USER, pass: PASSWORD } });
    await sendSmtp(smtp(s.port, { security: 'tls', user: USER, pass: PASSWORD }), trusted(), envelope, message, { timeouts: FAST });
    const session = s.sessions.at(-1)!;
    expect(session.commands.every((c) => c.secure)).toBe(true);
    expect(session.commands.map((c) => c.line)).toEqual([
      'EHLO plan.example.com',
      'AUTH LOGIN',
      Buffer.from(USER).toString('base64'),
      B64_PASS,
      'MAIL FROM:<no-reply@plan.example.com>',
      'RCPT TO:<alice@example.com>',
      'DATA',
      'QUIT',
    ]);
    expect(session.auth).toEqual([{ mechanism: 'LOGIN', user: USER, pass: PASSWORD }]);
  });

  it('implicit TLS to an IP address checks the address against the certificate', async () => {
    const s = await server({ mode: 'implicit', tls: tls() });
    await sendSmtp(smtp(s.port, { host: '127.0.0.1', security: 'tls' }), trusted(), envelope, message, { timeouts: FAST });
    expect(s.sessions.at(-1)!.messages).toHaveLength(1);
  });

  it('refuses STARTTLS that is not offered, before any AUTH', async () => {
    const s = await server({ tls: tls(), offerStartTls: false });
    const err = await failure(sendSmtp(smtp(s.port, { security: 'starttls', user: USER, pass: PASSWORD }), trusted(), envelope, message, { timeouts: FAST }));
    expect(err.message).toBe(STARTTLS_MISSING);
    expect(err.message).toBe('The SMTP server does not offer STARTTLS; refusing to send credentials in clear text');
    expect(verbs(s)).toEqual(['EHLO']);
    expect(s.sessions.at(-1)!.auth).toEqual([]);
  });

  it('refuses bytes injected after the STARTTLS reply', async () => {
    const s = await server({ tls: tls(), afterStartTls: '250-fake.example\r\n250 AUTH PLAIN\r\n' });
    const err = await failure(sendSmtp(smtp(s.port, { security: 'starttls', user: USER, pass: PASSWORD }), trusted(), envelope, message, { timeouts: FAST }));
    expect(err.message).toBe('The SMTP server sent data after its STARTTLS reply; refusing to go on');
    expect(s.sessions.at(-1)!.auth).toEqual([]);
  });

  it('a refused AUTH (535) carries the code and never the password, even when the server repeats it', async () => {
    const s = await server({ tls: tls(), credentials: { user: USER, pass: 'another' } });
    const err = await failure(sendSmtp(smtp(s.port, { security: 'starttls', user: USER, pass: PASSWORD }), trusted(), envelope, message, { timeouts: FAST }));
    expect(err.status).toBe(535);
    expect(err.message).toBe('The SMTP server refused AUTH (535): 5.7.8 Authentication credentials invalid');
    expect(verbs(s)).not.toContain('tls MAIL');
    const echo = await server({ tls: tls(), replies: { AUTH: `535 5.7.8 Bad: AUTH PLAIN ${B64_PLAIN} (${PASSWORD})` } });
    const echoed = await failure(sendSmtp(smtp(echo.port, { security: 'starttls', user: USER, pass: PASSWORD }), trusted(), envelope, message, { timeouts: FAST }));
    expect(echoed.message).toBe('The SMTP server refused AUTH (535): 5.7.8 Bad: AUTH PLAIN [redacted] ([redacted])');
    const login = await server({ mode: 'implicit', tls: tls(), auth: ['LOGIN'], replies: { AUTH: `535 5.7.8 not ${B64_PASS}` } });
    const viaLogin = await failure(sendSmtp(smtp(login.port, { security: 'tls', user: USER, pass: PASSWORD }), trusted(), envelope, message, { timeouts: FAST }));
    expect(viaLogin.message).toBe('The SMTP server refused AUTH (535): 5.7.8 not [redacted]');
  });

  it('refuses a server that offers no AUTH this client speaks while SMTP_USER is set', async () => {
    const s = await server({ tls: tls(), auth: [] });
    const err = await failure(sendSmtp(smtp(s.port, { security: 'starttls', user: USER, pass: PASSWORD }), trusted(), envelope, message, { timeouts: FAST }));
    expect(err.message).toBe('The SMTP server offers neither AUTH PLAIN nor AUTH LOGIN, and SMTP_USER is set');
  });

  it('verifies the certificate: an unknown authority and another host name are refused, and no credentials are sent', async () => {
    const st = await server({ tls: tls() });
    const unknown = await failure(sendSmtp(smtp(st.port, { security: 'starttls', user: USER, pass: PASSWORD }), createNodeSmtpConnector(), envelope, message, { timeouts: FAST }));
    expect(unknown.message).toMatch(
      /^The TLS handshake with localhost:\d+ failed \(its certificate must be valid for localhost\): .*(self-signed|unable to get local issuer|unable to verify)/i,
    );
    expect(st.sessions.at(-1)!.auth).toEqual([]);
    const implicit = await server({ mode: 'implicit', tls: tls() });
    const unknownImplicit = await failure(sendSmtp(smtp(implicit.port, { security: 'tls' }), createNodeSmtpConnector(), envelope, message, { timeouts: FAST }));
    expect(unknownImplicit.message).toMatch(/^Could not connect to the SMTP server localhost:\d+ with TLS \(its certificate must be valid for localhost\): .*(self-signed|unable to get local issuer|unable to verify)/i);
    const other = await server({ mode: 'implicit', tls: { key: certs.otherKey, cert: certs.otherCert } });
    const wrongHost = await failure(sendSmtp(smtp(other.port, { security: 'tls', user: USER, pass: PASSWORD }), trusted(), envelope, message, { timeouts: FAST }));
    expect(wrongHost.message).toMatch(/Hostname\/IP does not match certificate's altnames/);
    expect(other.sessions.every((s) => s.auth.length === 0)).toBe(true);
    const otherStartTls = await server({ tls: { key: certs.otherKey, cert: certs.otherCert } });
    await failure(sendSmtp(smtp(otherStartTls.port, { security: 'starttls', user: USER, pass: PASSWORD }), trusted(), envelope, message, { timeouts: FAST }));
    expect(otherStartTls.sessions.at(-1)!.auth).toEqual([]);
  });
});
