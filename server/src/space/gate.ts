// The gate (design §6.4): the first middleware of the space app. It runs after Hono has routed the
// request and judges it by the rule of the route that will actually handle it (matchedRoutes), never by
// a path pattern, so a percent-encoded path, a HEAD request (Hono runs the GET handler) or any other
// spelling gets the rule of the handler that runs. A matched handler without a rule is refused (500):
// the gate fails closed and never falls back to a default.
//
// Order of checks (a refusal answers before the handler runs):
//   1. the rule (c.var.rule);  2. ?mode= of the import routes (c.var.importMode);  3. the space's status;
//   4. a fresh identity for `fresh` rules served from the auth cache;  5. the role;  6. the re-auth window;
//   7. for writes without allowWhenFull: SPACE_MAX_BYTES and today's write budget;  8. for conditional
//   reads, If-None-Match → 304;  9. the route, then for writes the write generation's bump (§6.4.2).
// A request with a body passes 3-7 twice (Appendix D 27): on the identity the host authorized, so that a
// refusal reads none of the body, and again once the whole body has arrived (under BODY_LIMIT, or
// IMPORT_BODY_LIMIT for imports), on the request's authorization as of then. Other requests run while a
// body arrives, and one of them may have removed or demoted the member or ended the session; the route
// then reads the buffered body without another network wait.

import type { Context, MiddlewareHandler } from 'hono';
import { matchedRoutes } from 'hono/route';
import { ROLE_RANK, type SpaceRole } from '@shared/roles';
import { importModeQuery } from '@shared/schemas';
import { sha256Hex } from '../core/crypto';
import type { SpaceIdentity } from '../core/ports';
import { systemClock } from '../core/runtime';
import type { AppEnv, Deps } from '../env';
import {
  conflict,
  forbidden,
  HttpError,
  payloadTooLarge,
  quotaExceeded,
  rateLimited,
  reauthRequired,
  spaceUnavailable,
  unauthorized,
} from '../http/errors';
import { readQuery } from '../http/validate';
import { spaceActor } from './context';

export interface GateRule {
  need: SpaceRole;
  /**
   * May change data: refused when the space is full or over its daily write budget (unless
   * allowWhenFull); bumps the write generation (§6.4.2).
   */
  write: boolean;
  /** A read that may be answered 304 (§6.4.2). */
  conditional?: boolean;
  /** Re-authorize, bypassing the Cloudflare auth cache (current role and reauth_at). */
  fresh?: boolean;
  /** Needs the re-auth window (§5.4.4); 'replace' = only when ?mode=replace. */
  reauth?: 'always' | 'replace';
  /** Default: refused while the space is 'importing'. */
  importing?: 'allowed';
  /** Deletes, bulk delete, import analyze (§11.4). */
  allowWhenFull?: boolean;
}

const view = (need: SpaceRole = 'viewer'): GateRule => ({ need, write: false, conditional: true });
const edit = (need: SpaceRole = 'member'): GateRule => ({ need, write: true });
/** A delete: a write that still passes when the space is full, so the owner can make room. */
const remove = (need: SpaceRole = 'member'): GateRule => ({ need, write: true, allowWhenFull: true });

/** One entry per mounted route, keyed `${method} ${routePath}` with the full path Hono reports. */
export const GATE_RULES: Readonly<Record<string, GateRule>> = {
  'GET /api/bootstrap': view(),

  'GET /api/projects': view(),
  'POST /api/projects': edit(),
  'POST /api/projects/reorder': edit(),
  'GET /api/projects/:id': view(),
  'PATCH /api/projects/:id': edit(),
  'DELETE /api/projects/:id': remove('admin'),
  'GET /api/projects/:id/milestones': view(),
  'GET /api/projects/:id/epics': view(),

  'POST /api/milestones': edit(),
  'POST /api/milestones/reorder': edit(),
  'GET /api/milestones/:id': view(),
  'PATCH /api/milestones/:id': edit(),
  'DELETE /api/milestones/:id': remove(),

  'POST /api/epics': edit(),
  'POST /api/epics/reorder': edit(),
  'GET /api/epics/:id': view(),
  'PATCH /api/epics/:id': edit(),
  'DELETE /api/epics/:id': remove(),

  'POST /api/tasks/query': view(), // a read sent as POST
  'POST /api/tasks/bulk': edit(),
  'POST /api/tasks/bulk-delete': remove(),
  'POST /api/tasks': edit(),
  'GET /api/tasks/ref/:ref': view(),
  'GET /api/tasks/:id': view(),
  'PATCH /api/tasks/:id': edit(),
  'DELETE /api/tasks/:id': remove(),
  'POST /api/tasks/:id/duplicate': edit(),
  'POST /api/tasks/:id/blockers': edit(),
  'DELETE /api/tasks/:id/blockers/:blockerId': remove(),
  'POST /api/tasks/rebaseline/preview': view(), // a read sent as POST
  'POST /api/tasks/rebaseline': edit(),

  'GET /api/tasks/:id/timeline': view(),
  'POST /api/tasks/:id/comments': edit(),
  'PATCH /api/comments/:id': edit(),
  'DELETE /api/comments/:id': remove(), // admins and owners may delete anyone's (routes/timeline.ts)
  'POST /api/tasks/:id/worklogs': edit(),
  'PATCH /api/worklogs/:id': edit(),
  'DELETE /api/worklogs/:id': remove(),
  'GET /api/worklogs': view(),
  'GET /api/activity': view(),

  'GET /api/boards': view(),
  'POST /api/boards': edit(),
  'POST /api/boards/reorder': edit(),
  'GET /api/boards/:id': view(),
  'PATCH /api/boards/:id': edit(),
  'DELETE /api/boards/:id': remove(),
  'POST /api/boards/:id/duplicate': edit(),

  'GET /api/tags': view(),
  'POST /api/tags': edit(),
  'PATCH /api/tags/:id': edit(),
  'DELETE /api/tags/:id': remove('admin'),
  'POST /api/tags/:id/merge': edit('admin'),

  'GET /api/statuses': view(),
  'POST /api/statuses': edit('admin'),
  'POST /api/statuses/reorder': edit('admin'),
  'PATCH /api/statuses/:id': edit('admin'),
  'DELETE /api/statuses/:id': remove('admin'),

  'GET /api/settings': view(),
  'PATCH /api/settings': edit('admin'),

  // The archive (§8): no 304 for the export, always a fresh download; the import's re-auth only for a replace.
  'GET /api/data/export': { need: 'owner', write: false, fresh: true, reauth: 'always' },
  'POST /api/data/import/analyze': { need: 'owner', write: false, fresh: true, reauth: 'replace', importing: 'allowed', allowWhenFull: true },
  'POST /api/data/import/commit': { need: 'owner', write: true, fresh: true, reauth: 'replace', importing: 'allowed' },

  'POST /api/people/:personId/reassign': edit('admin'),
  'POST /api/people/me/disown': edit('viewer'), // anyone may disown imported rows attributed to them (§8.6)

  'GET /api/dashboard': view(),
  'GET /api/search': view(),
};

/** The routes whose ?mode= the gate parses (step 2; the import, §8.4). */
const IMPORT_MODE_ROUTES: ReadonlySet<string> = new Set(['POST /api/data/import/analyze', 'POST /api/data/import/commit']);

/**
 * Import writes: they have their own budget (the instance's daily import budget, §8.9), so the space's
 * write budget does not refuse them, and they write their rows inside writeState.uncounted (§6.4.2).
 */
export const IMPORT_WRITE_ROUTES: ReadonlySet<string> = new Set(['POST /api/data/import/commit']);

/** Routes that take an import file: their body may have IMPORT_BODY_LIMIT bytes, every other one BODY_LIMIT. */
const IMPORT_BODY_ROUTES: ReadonlySet<string> = new Set(['POST /api/data/import/analyze', 'POST /api/data/import/commit']);

const ROLE_MESSAGES: Record<SpaceRole, string> = {
  viewer: 'You cannot do this in this space.',
  member: 'You have view-only access to this space.',
  admin: 'Only admins and owners can do this.',
  owner: 'Only owners can do this.',
};

const DAY_MS = 86_400_000;

/**
 * `${method} ${path}` of the handler that will run, or null when only middleware matched (Hono's 404).
 * matchedRoutes lists the handlers in the order Hono runs them; middleware (app.use) has method ALL,
 * and the first handler is the one that answers. HEAD requests match GET handlers.
 */
export function routeKey(c: Context): string | null {
  const route = matchedRoutes(c).find((r) => r.method !== 'ALL');
  return route ? `${route.method} ${route.path}` : null;
}

/** The re-auth window is open: a credential was proven less than reauthMinutes ago (§5.4.4). */
export function isRecent(reauthAt: string, reauthMinutes: number, nowMs: number): boolean {
  return nowMs - Date.parse(reauthAt) < reauthMinutes * 60_000;
}

/**
 * The whole request body, refused past maxBytes (413), as hono/body-limit buffers one: the request is
 * replaced by a copy holding the bytes, which the route reads without waiting for the network again.
 */
async function bufferBody(c: Context, body: ReadableStream<Uint8Array>, maxBytes: number): Promise<Uint8Array> {
  const request = c.req.raw;
  const declared = request.headers.get('content-length');
  if (declared !== null && !request.headers.has('transfer-encoding') && Number(declared) > maxBytes) throw payloadTooLarge();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      // Not awaited: nothing is left to wait for once the request is refused.
      reader.cancel().catch(() => {});
      throw payloadTooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  c.req.raw = new Request(request, { body: bytes });
  return bytes;
}

/**
 * The ETag a conditional route answers with (§6.4.2): `"<gen>.<actor id>.<role rank>.<k>"`, k = the first
 * 12 hex characters of sha256 over the method, the rewritten path, the sorted query (`today` resolved
 * to the server's UTC date when absent), for a POST the body, and (Appendix D 18) what else an answer
 * can depend on: the space, the identity's names that bootstrap shows (the directory's, which reach
 * the generation only through a sync that may fail), and the UTC hour, since closedWithinDays cutoffs
 * follow the clock (such answers are rechecked at least hourly).
 */
export function conditionalEtag(
  o: { method: string; path: string; query: URLSearchParams; body: string; nowMs: number },
  gen: number,
  identity: SpaceIdentity,
): string {
  const now = new Date(o.nowMs).toISOString();
  const query = [...o.query.entries()];
  if (!o.query.has('today')) query.push(['today', now.slice(0, 10)]);
  query.sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0));
  const hashed = [o.method, o.path, new URLSearchParams(query).toString(), o.body];
  hashed.push(identity.space.id, identity.space.name, identity.displayName, now.slice(0, 13));
  const k = sha256Hex(JSON.stringify(hashed)).slice(0, 12);
  return `"${gen}.${identity.userId}.${ROLE_RANK[identity.role]}.${k}"`;
}

/** Seconds until the next 00:00 UTC, when the daily write budget starts again. */
const untilMidnightUtc = (nowMs: number) => Math.ceil((DAY_MS - (nowMs % DAY_MS)) / 1000);

/** The gate middleware. `rules` defaults to GATE_RULES (tests pass their own for test-only routes). */
export function createGate(deps: Deps, rules: Readonly<Record<string, GateRule>> = GATE_RULES): MiddlewareHandler<AppEnv> {
  const { db, config, space } = deps;
  const clock = space.clock ?? systemClock;
  return async (c, next) => {
    // 1. The rule of the handler that will run.
    const key = routeKey(c);
    if (key === null) return next();
    const rule = rules[key];
    if (!rule) {
      console.error(`[lyren] No gate rule for ${key}`);
      throw new HttpError(500, 'internal', 'Internal server error');
    }
    c.set('rule', rule);

    // 2. Import mode, parsed once here so that the gate and the route cannot disagree about it.
    const mode = IMPORT_MODE_ROUTES.has(key) ? readQuery(c, importModeQuery).mode : undefined;
    if (mode !== undefined) c.set('importMode', mode);

    /** Steps 3-7 for `identity`; returns the identity to go on with (step 4 may replace it). */
    const judge = async (identity: SpaceIdentity, fromCache: boolean): Promise<SpaceIdentity> => {
      // 3. The space's status.
      const status = identity.space.status;
      if (mode === 'new') {
        if (status !== 'importing') throw conflict('This space has already been imported');
      } else if (status === 'importing' && (rule.importing !== 'allowed' || mode === 'replace')) {
        throw spaceUnavailable();
      }

      // 4. Current role and reauth_at for fresh rules (only a cached identity can be stale).
      if (rule.fresh && fromCache) {
        const fresh = await c.env.reauthorize();
        if (!fresh) throw unauthorized();
        identity = fresh;
      }

      // 5. Role.
      if (ROLE_RANK[identity.role] < ROLE_RANK[rule.need]) throw forbidden(ROLE_MESSAGES[rule.need]);

      // 6. Re-auth window.
      const nowMs = clock.now();
      const needsReauth = rule.reauth === 'always' || (rule.reauth === 'replace' && mode === 'replace');
      if (needsReauth && !isRecent(identity.reauthAt, config.reauthMinutes, nowMs)) throw reauthRequired();

      // 7. Size and today's write budget (§11.4); import writes have their own budget.
      if (rule.write && !rule.allowWhenFull) {
        if (config.spaceMaxBytes > 0 && space.storageBytes && space.storageBytes() > config.spaceMaxBytes) {
          throw quotaExceeded('This space is full. Delete something to make room.');
        }
        if (!IMPORT_WRITE_ROUTES.has(key) && space.writeState.budgetLeft(nowMs) <= 0) {
          throw rateLimited(
            "This space has reached today's write limit on this instance. It resets at 00:00 UTC.",
            untilMidnightUtc(nowMs),
          );
        }
      }
      return identity;
    };

    /** Everything after the first steps 3-7: the body, steps 3-7 again, 8 and 9. */
    const proceed = async (first: SpaceIdentity): Promise<Response | void> => {
      let identity = first;
      // The body, and steps 3-7 again on the authorization as of its arrival (see the header).
      let body: Uint8Array | null = null;
      const stream = c.req.raw.body;
      if (stream !== null) {
        body = await bufferBody(c, stream, IMPORT_BODY_ROUTES.has(key) ? config.importBodyLimit : config.bodyLimit);
        const again = await c.env.recheck();
        identity = await judge(again.identity, again.fromCache);
      }
      c.set('identity', identity);
      c.set('user', spaceActor(identity));

      // 8. Conditional read. The generation is taken here, after the body and before the route reads
      // anything: a write that commits meanwhile bumps it only afterwards, so this ETag can only be older
      // than the data.
      let etag: string | null = null;
      if (rule.conditional) {
        const url = new URL(c.req.url);
        const method = c.req.method === 'HEAD' ? 'GET' : c.req.method;
        const text = method === 'POST' && body !== null ? new TextDecoder().decode(body) : '';
        const nowMs = clock.now();
        etag = conditionalEtag({ method, path: url.pathname, query: url.searchParams, body: text, nowMs }, space.writeState.gen, identity);
        // If-None-Match compares weakly (RFC 9110 §13.1.2): the Node gateway's compression sends the tag as W/"…".
        if (c.req.header('If-None-Match')?.replace(/^W\//, '') === etag) {
          return c.body(null, 304, { ETag: etag, 'Cache-Control': 'no-store' });
        }
      }

      // 9. The route; then, after all of its writes, the bump (whatever the response's status).
      const since = db.meter?.rowsWritten ?? 0;
      await next();
      if (rule.write) space.writeState.bump(since);
      if (etag !== null && c.res.status === 200) c.header('ETag', etag);
    };

    const judged = await judge(c.env.identity, c.env.fromCache);
    // An import holds the import gate (§8.4) from here, before a byte of its body is read, until its
    // response: a second import is refused 503 without buffering its upload, so one account cannot hold
    // several IMPORT_BODY_LIMIT bodies in memory at once by sending them in parallel.
    if (IMPORT_BODY_ROUTES.has(key)) return space.importGate.run(() => proceed(judged));
    return proceed(judged);
  };
}
