# Lyren Plan — Engineering Spec (the contract)

Lyren Plan is a **self-hosted project management app** for one person or a small team: accounts, and spaces
that each hold their own projects → milestones → epics → tasks, with highly configurable boards, tags,
comments, work logs and an activity history, shared with members by role (docs/design/multi-user-and-cloudflare.md).
One Node.js process serves a JSON API and a React SPA, storing the accounts in one SQLite file (the directory)
and each space in a file of its own; the same apps also run on Cloudflare, a Worker in front of one SQLite-backed
Durable Object for the directory and one per space (§12.2). **No third-party services, CDNs,
web fonts, analytics or outbound network calls — ever** (the browser must never fetch anything from another
origin either). It must work well on phones (mobile browsers, installable as a PWA) and desktops.

This document is binding for everyone working on the codebase. If something here is ambiguous, choose the
simplest behaviour consistent with it and note the decision in your final report. Never change a shared
contract (shared/, the DB schema, web/src/api/, exported props of cross-feature components) silently —
report it instead.

---------------------------------------------------------------------------------------------------------

## 1. Feature checklist (what "done" means)

- Projects (key like `LYR`, color, status active/on hold/completed/archived, description in Markdown, progress).
- Milestones per project (status, start/due dates, progress rolled up from epics' tasks).
- Epics per project, optionally assigned to a milestone (color, status, dates, progress).
- Tasks per project, optionally in an epic (milestone derived from epic). Fields: title, Markdown description,
  status (user-configurable statuses with fixed categories), priority (none/low/medium/high/urgent),
  tags, start date, due date, estimate (points or hours — a setting), manual order, archive flag.
  Human refs: `LYR-42`.
- Task dependencies (docs/design/task-dependencies.md): finish-to-start links between tasks of a space, the
  adjusted start and due dates they imply (worked out when read, against the client's `today`), slipped tasks,
  and rebaselining a project's or a selection's slipped tasks.
- Tags: global, colored, rename/recolor/merge/delete; created inline while tagging.
- Comments on tasks (Markdown, edit/delete own).
- Work log on tasks ("log activity"): date, time spent (e.g. `1h 30m`), note. Work-log report page.
- Activity history: automatic, field-level change history for tasks and structural changes
  (project/milestone/epic), per task, per project and global feeds.
- Boards (§8): saved, highly configurable views over tasks — filters, column grouping by any field or by
  user-defined custom columns, swimlanes (also custom), sorting, card display options, WIP limits,
  collapsed/hidden/reordered groups, kanban or grouped-list layout, drag & drop that edits tasks, quick
  filters. **Global boards** (Boards page) and **project boards** (each project's Board tab, persisted
  server-side, several per project).
- Dashboard (overdue / due today / due soon / in progress / recently done / activity / project progress).
- Global search + command palette (mod+K).
- Settings: the account's (profile: name, email address with its verification and changes; security: password,
  passkeys, sessions, security events; preferences: theme, week start, home page; danger zone: delete the account), a
  space's (general: name, estimate unit, default board; members; invitations; statuses; tags; data: the space
  archive's download, importing into a new space, replacing the space; danger zone: leave, transfer, delete), and
  the instance administration (overview: warnings, the instance and its configuration, the recent
  administrative actions of every admin, a test email, the backup set download and the self-hosting notes on
  Node; settings: the sign-up policy and the password minimum; users: search, disable or enable, administrator
  rights, reset links, delete; instance invitations; spaces: search, delete, restore). Each shown by the role
  (§9 "Viewer mode").
- Accounts and spaces (design §5, §6): sign-in by email address or the username of a 1.x account; every
  account gets a space of its own; spaces can be created, renamed, deleted (restorable for
  `SPACE_DELETE_GRACE_DAYS`) and shared with members as owner, admin, member or viewer; instance admins.
  Invitations to a space (by mail, or without mail a link the inviter passes on) and instance invitations;
  open sign-up with email verification (`SIGNUP_POLICY` `open`; `invite_only` by default, or `closed`); email
  verification and email change (both confirmed in the account's own session); forgotten passwords by mail, reset
  links from an admin, and the operator's recovery token (`RECOVERY_TOKEN`); the security notices (design
  §5.8.5-§5.8.11, §5.8.19).
- Space archives (design §8, §12.10; §5.10): a space's owners download its archive (gzip JSON, the people its
  entries name included); anyone imports one into a new space of their own (/spaces → "Import a space…"), and
  owners replace a space's content with one, after mapping each person the archive names to an account they can
  see or keeping the name only; entries attributed to someone else say who imported them, the person can disown
  them, and admins reassign a former member's entries to a member.
- Passkeys (design §5.6, §5.8.3, §5.8.12-§5.8.14): sign-in with a discoverable passkey (no identifier; a button
  and the sign-in field's autofill), up to 20 per account, added, renamed and removed in Account settings →
  Security, re-authentication with one, an account without a password (only with a passkey that works here and a
  way back in), and sign-up, invitation acceptance and a reset link with a passkey instead of a password (a reset's
  passkey replaces the password unless the account would then have no way back in). On only
  when `PUBLIC_URL` is an https origin (or `http://localhost`) whose host is a name; the RP ID is
  `WEBAUTHN_RP_ID` or that host, never taken from a request. A passkey registered for another RP ID (a domain
  move) is shown as such and no longer counts as a way to sign in.
- Mail (design §5.10, §12 below): `MAIL_TRANSPORT` `log` (the default: nothing is sent, one line is logged),
  `smtp` (our own client: implicit TLS or STARTTLS, the certificate verified against `SMTP_HOST`, AUTH PLAIN or
  LOGIN only over TLS; `none` only to a mail server on this machine), `resend` or `cloudflare` (a `send_email`
  binding, Workers Paid); daily budgets (`MAIL_DAILY_CAP`, 40% of it for anonymous requests, 5 messages a day
  per address except the security notices); a test message from Administration (`POST /api/admin/mail/test`).
- First-run setup screen (setup code from the server log, create the first account, an instance admin, by
  email, optional sample data), login, logout, and the CLI's backup, restore, reset-password, promote-admin,
  policy and spaces commands (§12).
- Mobile: every screen usable at 360px wide; touch drag & drop with long-press plus non-drag alternatives
  (menus) for every drag action; bottom navigation; full-screen sheets for dialogs/drawers; Back gesture
  closes sheets; installable PWA with an offline app shell.
- Self-hosting: `npm ci && npm run build && npm start`, the release archive `lyren-plan-<version>-node.tar.gz` on any
  Node ≥ 22.13 (systemd on Ubuntu 26.04: `docs/ubuntu-server.md`, §12), or Docker / docker-compose. Data in `DATA_DIR`
  (`lyren.db`, `spaces/`, `backups/`).
- Single-file desktop app (§12.1): `npm run package:win` → one Windows exe that needs nothing installed;
  double-click starts the server and opens the browser; data in `%LOCALAPPDATA%\Lyren Plan`.
- Cloudflare (§12.2; docs/cloudflare.md): the Worker and Durable Objects runtime on the Workers Free plan, its
  defaults sized for it; deployed from this repository with nothing of one deployment committed, by `wrangler
  deploy` from a checkout, the manual GitHub workflow `deploy-cloudflare.yml` in a fork, or the Deploy to
  Cloudflare button (README); `npm run dev:cf` locally and `npm run check:cf` (an offline dry run).

---------------------------------------------------------------------------------------------------------

## 2. Stack (do not add dependencies)

| Layer   | Choice |
|---------|--------|
| Runtime | Node.js ≥ 22.13 (dev: 24). **`node:sqlite`** built-in (no native modules). |
| Server  | Hono 4.13.9, pinned exactly (the gate relies on `matchedRoutes`, design Appendix D 2) + @hono/node-server 1, zod 4, fractional-indexing 3, @simplewebauthn/server 14.0.3 (passkeys; npm `overrides` hold its @peculiar/asn1-* at 2.10.0, @peculiar/x509 at 2.1.0 and asn1js at 3.0.10). Bundled to one file by esbuild. |
| Web     | React 19, react-router 7 (library mode, import from `react-router`), @tanstack/react-query 5, Tailwind CSS 4, @dnd-kit/core 6 + sortable 10 + utilities 3, @floating-ui/react 0.27, lucide-react (0.5xx icon names), react-markdown 10 + remark-gfm 4, clsx, @simplewebauthn/browser 14.0.0. |
| Tests   | vitest 4, two projects (§10): `node` (node environment) and `workers` (@cloudflare/vitest-plugin 1.3.6, in workerd). |
| TS      | TypeScript 5.9, strict, `noUncheckedIndexedAccess`, `verbatimModuleSyntax` (use `import type`). |
| Cloudflare | Dev-only, pinned to exact versions: `wrangler` 4.147.0, `@cloudflare/workers-types` 5.20261001.1, `@cloudflare/vitest-plugin` 1.3.6 (the Cloudflare runtime's typecheck and tests; docs/design/multi-user-and-cloudflare.md §10). |

**No new npm dependencies** may be installed (parallel installs corrupt node_modules). If you truly need one,
say so in your report. Build-time only, for the single-file app (§12.1), pinned to exact versions:
`postject` 1.0.0-alpha.6 (injects the SEA blob) and `resedit` 3.1.0 (icon and version information); nothing
at runtime depends on them. zod 4 notes: use `.prefault()` for nested object defaults, `z.partialRecord` for
enum-keyed partial maps; input schemas in shared have no `.default()`s (servers apply defaults explicitly).

Path aliases: `@shared/*` → `shared/src/*` (server and web); `@/*` → `web/src/*` (web only; relative imports
are also fine).

---------------------------------------------------------------------------------------------------------

## 3. Repository layout and ownership

```
shared/src/            CONTRACT (owner: lead). constants, dates, duration, schemas (zod inputs), board (config +
                       grouping helpers), filter (reference filter/sort semantics), export (v1 import schema),
                       archive (archive v2 schema, file names, gzip detection; design §8.2),
                       types (DTOs), email (emailSchema; normalizeEmail, from emailAddress, which imports no zod so
                       that a deploy can bundle core/config.ts alone, design Appendix D 70), ids (space ids), roles
                       (space roles and permissions; docs/design/multi-user-and-cloudflare.md §5.2, §4.2, §6), bounded
                       (parseBounded: bounded validation of large values, design Appendix D 44). Pure TS — no Node/DOM
                       APIs.
server/src/
  index.ts             entry of the Node build / Docker (lead); cli.ts: the commands serve, backup, restore,
                       reset-password, promote-admin, policy, spaces, help (lead); startupErrors.ts: plain-language
                       start-up failures (lead)
  sea.ts desktop/      entry and runtime of the single-file desktop app (§12.1) (lead)
  config.ts env.ts     config (lead); env.ts: the space app's Deps, SpaceActor and AppEnv (design §2.5) (lead)
  gateway/             the gateway (design §2.1): guards.ts (canonical paths, CSRF, Content-Length, routing, the
                       session token; shared with the Cloudflare Worker), app.ts (createGatewayApp, Node's gateway)
                       (lead)
  core/                runtime-neutral: db.ts (the Db interface, SQL scanner), migrate.ts, config.ts (the settings
                       both runtimes share, from a string map; config.ts adds Node's), ports, cookies, … (lead)
  directory/ space/    the directory and space databases' schemas (schema.ts; design §3.2, §3.3) (lead);
                       directory/ also the directory app and service: accounts, sessions, throttles, spaces and
                       memberships (createDirectoryApp; design §2.5, §5, §6.3) (lead); space/ also the space app
                       (app.ts: the gate, then the routes below), its host (host.ts: path rewrite, authorization,
                       auth cache, mirror sync), gate.ts (GATE_RULES, §6.4), writeState.ts (ETags and the write
                       budget), mirror.ts (the users mirror), init.ts (a new space's database), safety.ts,
                       context.ts (currentUser, currentIdentity), people.ts (reassign and disown, §5.10), archive/
                       (archive v2: export.ts, read.ts with values.ts, validate.ts, analysis.ts, estimate.ts,
                       commit.ts; design §8) (lead)
  mail/                mail (design §5.10): transport.ts (createMailTransport, MailTransport), log.ts, smtp/client.ts
                       (our SMTP client over a runtime's connector), resend.ts, cloudflare.ts (the drivers),
                       message.ts (the MIME builder, header checks, mailSafeName), templates.ts (every message as
                       text and HTML), errors.ts (MailError, redact); the sending policy is directory/mailer.ts
                       (budgets, deferral, mail_failed events); the connectors are runtime/node/smtpConnector.ts
                       (node:net, node:tls) and runtime/cloudflare/smtpConnector.ts (cloudflare:sockets) (lead)
  runtime/node/        nodeDb.ts: NodeDb, the Db on node:sqlite, openDb; stack.ts: openNodeStack (everything a Node
                       process serves); spaceStore.ts, spaceClient.ts, directoryClient.ts; clientIp.ts (TRUST_PROXY,
                       COOKIE_SECURE); desktop.ts (what the web client learns about the desktop app); legacy.ts
                       (the 1.x upgrade), backupSet.ts and tar.ts (backup sets), restore.ts (staging and applying a
                       restore), owner.ts (the root check), files.ts (retried renames, fsync), maintenance.ts (lead);
                       runtime/cloudflare/: the Cloudflare runtime (design §10): worker.ts (the Worker: the gateway's
                       guards, the host check, HSTS; the entry Wrangler bundles), directoryDo.ts and spaceDo.ts (the
                       Durable Objects), clients.ts (stub.fetch and RPC between them), config.ts (env → AppConfig),
                       objects.ts, env.ts, DoDb (lead)
  db/index.ts          Db types (lead)          db/schema.ts  migrations (lead)   db/seed.ts (lead; createSampleData: server-domain)
  db/snapshots.ts      automatic snapshot names and retention (SNAPSHOT_KEEP, §12) (lead)
  http/                errors, validate, headers (the security headers), static (lead)
  services/            domain services (server-domain agent) — see §6
  routes/<area>.ts     one Hono router factory per area (feature agents) — stubs exist
server/test/           vitest API tests; helpers.ts gives createTestContext() (lead)
web/index.html web/public/   (web-foundation agent: manifest, icons, favicon, service worker; theme-init.js and _headers,
                       the static assets' security headers on Cloudflare, are lead's)
web/vite.config.ts web/devProxy.ts   build config; the dev server proxies /api to PORT/HOST or LYREN_API_URL (lead)
scripts/package.mjs scripts/lib/   the single-file app's packaging and its pure helpers, tested in scripts/test (lead)
wrangler.jsonc .dev.vars.example scripts/cf/build-web.mjs   the Cloudflare Worker's configuration, its local secrets
                       template, and the web build Wrangler runs, which refuses a deploy that leaves the instance
                       configuration out (design §10.8, Appendix D 70); server/test-workers/ its tests (lead)
scripts/pack-node.mjs scripts/lib/node-tarball.mjs   the release archive for Node.js installs (§12) (lead)
.github/workflows/release.yml scripts/ci/   release workflow, its smoke tests (Windows exe, Node.js archive) and publishing script (§12.1) (lead)
wrangler.instance.example.jsonc scripts/cf/wrangler.mjs scripts/lib/{instance,app-config,wrangler-run}.mjs   the
                       instance configuration's example, and the wrapper that checks it and runs Wrangler with it
                       (§12.2, design Appendix D 70), tested in scripts/test/{instance,app-config,wrangler-run,
                       cf-wrangler}.test.mjs (lead)
.github/workflows/deploy-cloudflare.yml scripts/ci/write-secrets-file.sh scripts/lib/cloudflare.mjs   the Cloudflare
                       deploy workflow, its secrets file, and the JSONC and build-command helpers (§12.2), tested in
                       scripts/test/deploy-cloudflare.test.mjs and wrangler-config.test.mjs (lead)
docs/cloudflare.md     the Cloudflare runbook, configuration reference and measured costs (§12.2) (lead)
docs/ubuntu-server.md   installing on Ubuntu Server 26.04 with systemd and Ubuntu's nodejs (§12) (lead)
web/src/
  main.tsx app/        root, router, auth gates, the space context and layouts (space.ts, SpaceLayout.tsx,
                       DirectoryLayout.tsx), the old links' redirect (legacyRedirect.ts) (lead)
  api/                 fetch client (the ETag store, error mapping) + ALL React Query hooks (lead) — the web↔API contract
  lib/                 theme, format, colors, hooks, events, taskLinks, overlays, spaceStorage (lead)
  components/ui/       design-system primitives (web-foundation agent)
  components/layout/   AppShell, PageHeader, nav (web-foundation agent)
  components/domain/   task/status/tag/... display components, pickers, TaskActionsMenu (web-domain agent)
  features/<area>/     pages and feature components (feature agents)
```

Feature ownership (web + server):

| Agent             | Server routes (server/src/routes)                         | Web (web/src/features)                           |
|-------------------|-----------------------------------------------------------|--------------------------------------------------|
| server-domain     | bootstrap.ts + services/*                                 | —                                                |
| web-foundation    | —                                                         | components/ui, components/layout, auth/, common/, web/public |
| web-domain        | —                                                         | components/domain                                |
| projects          | projects.ts, milestones.ts, epics.ts                      | projects/                                        |
| tasks             | tasks.ts (+ services/taskMutations.ts)                    | tasks/                                           |
| timeline          | timeline.ts                                               | timeline/                                        |
| boards            | boards.ts                                                 | boards/                                          |
| admin             | tags.ts, statuses.ts, settings.ts, data.ts                | settings/, import/                               |
| dashboard-search  | dashboard.ts, search.ts                                   | dashboard/, search/                              |

Only edit files you own. If you need a change elsewhere (a bug in a shared component, a missing hook),
make the smallest possible fix, keep exported signatures backwards compatible, and list it in your report.

---------------------------------------------------------------------------------------------------------

## 4. Server conventions

- **Route factories**: `export function xRoutes({ db, config, space }: Deps) { const r = new Hono<AppEnv>(); ...; return r; }`.
  Paths inside a router are relative to its mount point (see space/app.ts). The routes in `routes/` are the
  **space app**, one per space: its space host (`space/host.ts`) has already authorized the request against the
  directory and rewritten `/api/s/<spaceId>/…` to `/api/…`, and hands over the identity as bindings (never
  cookies or headers). Use `currentUser(c)` from `space/context.ts` (a `SpaceActor { id, display_name }`; `id` is
  also the user's row in the space's users mirror) and `currentIdentity(c)` for the role. Middleware order in
  space/app.ts: the gate (`space/gate.ts`) → security headers → `Cache-Control: no-store`. The gate judges the
  route that will run (Hono's matched route, so any spelling of a path gets its rule): role, re-auth, import
  status, size and daily write budget, and conditional reads (`ETag` / `If-None-Match` → 304, design §6.4.2).
  It also reads a request's whole body (imports `IMPORT_BODY_LIMIT`, else `BODY_LIMIT`; 413 past it) and judges
  the request again on its authorization as of then, so a member removed or demoted, or a session ended, while a
  body was on its way writes nothing (design Appendix D 27); routes read the buffered body as before.
  **Every new route needs a `GATE_RULES` entry**; a route without one answers 500
  (`server/test/space/gate.test.ts` lists them all). CSRF and `Content-Length` checks are the gateway's.
- **Validation**: `await readJson(c, schema)`, `readQuery(c, schema)`, `readId(c, 'id')` from `http/validate.ts`
  with the zod schemas in `shared/src/schemas.ts` / `board.ts` / `export.ts`. Never trust unvalidated input.
  Validation is bounded (design Appendix D 44): a 400 lists the first 20 problems and counts the rest, and a body
  of more than 5,000 list items and object members (`DESCRIBED_VALUES`) that fails is refused as "Invalid input
  (too many values to list its problems)" without its problems (`shared/src/bounded.ts#parseBounded`, which walks
  such a value along its schema and stops at the first part that fails; zod's `validate()` does not stop at items
  that fail a check). Never call `safeParse` or `validate()` on a large untrusted value yourself: an imported
  board's config, for one, is read with `parseBoardConfigLenient`, which bounds every part it parses and the work
  of its repairs.
- **Directory writes** (`directory/routes/`): read the body first, then `freshSession(c, ctx)` (the session and
  account read again, 401 when revoked meanwhile) and the rows you check (membership, role), and write without
  another await in between; after any later await (a hash, `spaces.init`) read again (design §5, Appendix D 21).
  A sign-in's password check holds only while the account's `auth_epoch` is unchanged (every credential change
  bumps it); otherwise it fails like a wrong password.
- **Errors**: throw `badRequest(msg, details?)`, `notFound('Task')`, `conflict(msg)`, `forbidden()` from
  `http/errors.ts`. The error handler renders `{ error: { code, message, details? } }`. For a field-specific
  400 use `badRequest('Due date must be on or after start date', [{ path: 'dueDate', message: '...' }])`.
- **Status codes**: 200 OK (GET/PATCH/DELETE/actions), 201 for creates (POST that creates a resource), body = DTO.
  Deletes return `{ ok: true }`.
- **Database** (`Db`, `core/db.ts`; on Node `NodeDb`, `runtime/node/nodeDb.ts`): `db.all<T>(sql, params)`, `db.get<T>`, `db.run` → `{changes, lastInsertRowid}`,
  `db.tx(() => {...})` (synchronous only; nests with savepoints); Node-only code (`runtime/node`) also has
  `NodeDb#backupTo(file)` (VACUUM INTO; not inside tx). Named params use `:name` in SQL with a plain object. **A named param missing from the object throws;
  extra keys are ignored**; explicit `undefined` binds NULL; booleans bind 0/1. One statement per `all`/`get`/`run`
  (`db.exec` runs several, without params). Rows are snake_case; map to
  camelCase DTOs in services/mappers.ts. Every multi-statement mutation runs inside `db.tx`.
  `PRAGMA foreign_keys=ON` (cascades are relied upon). Ids are AUTOINCREMENT (never reused).
- **Timestamps**: `new Date().toISOString()` (always this exact format — SQL compares them as strings).
  Calendar dates are `'YYYY-MM-DD'` strings. The server's "today" (`new Date().toISOString().slice(0,10)`) is
  only a fallback — APIs that depend on the user's day take a `today` parameter from the client.
- **Activity**: every create/update/delete of a project, milestone, epic, task, comment or work log records
  activity (§5.8) in the same transaction, via `services/activity.ts`.
- **SQL injection**: never interpolate values into SQL; only interpolate trusted fragments you built
  (column names from a fixed whitelist, placeholders).
- Case-insensitive text matching uses **fold columns** (design §3.4): `projects.name|description`,
  `milestones.name|description`, `epics.name|description`, `tasks.title|description`, `tags.name` and
  `statuses.name` each have a `*_fold` column holding `fold(value)` (`core/fold.ts`, JS `toLowerCase()`), and every
  statement that writes the column writes its fold in the same statement (the columns are NOT NULL without a
  default, so a forgotten one fails). Search tokens (already folded by `searchTokens`) travel as ONE JSON
  parameter: `NOT EXISTS (SELECT 1 FROM json_each(:tokens) tk WHERE instr(p.name_fold || char(10) ||
  p.description_fold, tk.value) = 0)` (`allTokensSql` / `tokenHitsSql` in services/tasks.ts; a task's title,
  description and ref are checked one by one, the ref last), so no statement grows with the input. Tag and status
  names are unique by `name_fold`. There is no `lyren_lower()` (a Durable Object cannot register functions) and no
  `LIKE` on user input.
- **Rows read** (on Cloudflare every row a statement reads is billed, design §11.2, Appendix D 42): task queries
  use `TASK_FROM` (`tasks t` alone) and reach a task's project, status and epic through `IN (SELECT … FROM <small
  table>)`, not joins; task lists select `TASK_COLUMNS` (the row alone) and hydrate with `hydrateTasks`, which
  looks the projects, epics and tags up by id (`byJsonIds`); a task's tags are `tasks.tag_ids` (a JSON array that
  triggers keep from `task_tags`: write `task_tags`, never `tag_ids`), and its comment count and logged minutes
  `tasks.comment_count` and `tasks.worklog_minutes` (triggers keep them from `comments` and `work_logs`; never
  write them). A page (`limit` ≤ `TASK_PAGE_MAX`, 500) reads the ids of every match in order, then its own rows by
  id (Appendix D 47). Statistics and the dashboard read the tasks once and aggregate in JS, with
  `compareText` and `RealSum` (services/sql.ts) where they replace SQL's text order and `SUM()`.
  `server/test-workers/cost.test.ts` holds the budget; `docs/cloudflare.md` has the numbers.
- Pass id lists as one JSON parameter: `WHERE id IN (SELECT value FROM json_each(:ids))` with
  `{ ids: JSON.stringify(ids) }` (keeps SQL text constant). `IN` never matches NULL: when a filter array
  contains `null`, strip it from the JSON and OR in `col IS NULL`. Deduplicate id arrays first.
- Tests run on Linux and natively on Windows: start server sources with `tsxCommand`/`tsxEnv`
  (server/test/tsxNode.ts: node + tsx's loader in ONE process; never node_modules/.bin/tsx, a shell script on
  Windows, nor tsx's CLI, whose second process a Windows kill would orphan); expect host paths via
  `path.resolve`/`path.join`; never create two names differing only in case; directory links as junctions
  on win32; no graceful-signal assertions on win32 (child.kill() is TerminateProcess).
- Tests: `server/test/<area>.test.ts` with `createTestContext(overrides?)` from `server/test/helpers.ts`
  (the whole Node stack on in-memory databases, design §14.3; `ctx.signedIn()` sets up the owner,
  owner@example.com, and returns a client that sends its cookies and the CSRF header and rewrites unprefixed
  space paths, `/api/tasks` to `/api/s/<ctx.spaceId>/tasks`; `ctx.addUser()` adds a member; `ctx.db` is that
  space's database and `ctx.directoryDb` the directory's; `ctx.config.dataDir` is a temp dir, removed after
  the test, when every space's fold columns are checked). The directory or a space alone:
  `server/test/support/{directoryHarness,spaceHarness}.ts`. Run with `npx vitest run server/test/<file>`.

## 5. Domain rules

### 5.1 Projects
- `key` 2–10 chars `[A-Z][A-Z0-9]+`, unique (case-insensitive; 409 on duplicate). If omitted on create,
  generate from the name: initials of up to 4 words when the name has ≥2 words, else the first 3 letters;
  letters/digits only, uppercase; prefix `P` if it doesn't start with a letter; pad short keys with `X`; if
  taken append 2, 3, … (truncating to stay ≤ 10). Changing a key changes every task ref (refs are computed).
- Default color: `DEFAULT_PROJECT_COLOR`. Position: appended (max+1).
- Status `archived` hides the project's tasks from task queries unless a filter lists the project explicitly
  or sets `includeArchivedProjects` (§7). Archived projects are listed separately in the UI.
- Delete cascades to everything (milestones, epics, tasks, comments, logs, activity, project boards). Activity
  rows of tasks that were moved out of the project earlier (and still exist elsewhere) are not part of it: they
  are re-homed to the task's current project first, so the task keeps its full history. Records
  `project.deleted` with `project_id NULL`, `entity_id` = old id, data `{ name, key }`. If settings.defaultBoardId
  pointed at a cascaded board it becomes null. Board references are cleaned (§5.11).
- `GET /api/projects(/:id)` accept `?today=` for `stats.tasksOverdue`.

### 5.2 Milestones
- Belong to one project (immutable). Position appended within the project.
- `completedAt` set when status becomes `completed` or `cancelled` (if not already set); cleared otherwise.
- If both dates are set, `startDate <= dueDate` (checked on the merged result; 400 with path `dueDate`).
- Delete: `?epics=detach` (default; FK sets epics' milestone to NULL) or `?epics=delete` (deletes its epics,
  logging `epic.deleted` for each; their tasks lose the epic via FK).

### 5.3 Epics
- Belong to one project (immutable); optional milestone **of the same project** (else 400 `milestoneId`).
- `completedAt` set when status becomes `done`/`cancelled`; cleared otherwise. Same date rule as milestones.
- Delete: `?tasks=detach` (default) or `?tasks=delete` (delete the epic's tasks, each logging `task.deleted`).

### 5.4 Statuses
- User-configurable list with a fixed `category` (`backlog|unstarted|started|completed|cancelled`).
  Closed = completed or cancelled. At least one status must always exist (deleting the last → 409).
  Default color `DEFAULT_STATUS_COLOR`. Names unique case-insensitively (409).
- Default status for new tasks: first by position with category `unstarted`, else first status.
- Order: `position` (dense 0…n−1) is the column order everywhere (boards, pickers, grouping). Settings shows
  statuses grouped by category in `STATUS_CATEGORIES` order, so a created status is inserted right after the
  last status whose category comes no later than its own (else first), and later statuses shift by one
  (their `updated_at` untouched). `POST /api/statuses/reorder` sets any order.
- Changing a status's category updates its tasks' `completedAt` (entering closed: set to now where NULL;
  leaving closed: NULL).
- Deleting a status in use requires `?reassignTo=<otherId>`; tasks move (with completedAt transitions).
  Without it → 409 `conflict` with message mentioning the task count; `reassignTo` = itself or unknown → 400.

### 5.5 Tasks
- `number` = `++projects.task_counter` (in the same transaction). `ref` = `${project.key}-${number}`.
- `projectId` required on create. `epicId` must belong to the task's project. On update, if `epicId` refers
  to an epic in another project and `projectId` is omitted, the task **moves to that epic's project**.
  If both are given and disagree → 400.
- Moving to another project (`projectId` change): new number from the target project; epic cleared unless a
  valid target-project epic is given in the same request; records `task.moved` (`fromProjectId/Name`,
  `toProjectId/Name`, `fromRef`, `toRef`; row `project_id` = the NEW project) in addition to `task.updated`
  for other changed fields. **Returning** to a project the task left before (e.g. the Undo of a move): the
  number from its latest `task.moved` away from that project (`fromRef`) is reused when no task holds it and
  it is ≤ that project's `task_counter` (numbers are never issued twice, so it normally is free), so the old
  ref and links to it work again; otherwise a new number as above (`returningNumber` in taskMutations.ts).
- `completedAt`: set to now when the status category goes non-closed → closed; NULL when closed → non-closed;
  unchanged for closed → closed.
- Tags: `tagIds` replaces the set; `addTagIds`/`removeTagIds` adjust it; `tagIds` with add/remove → 400.
  Unknown tag ids → 400 (path `tagIds`). TaskDTO.tags sorted by name, case-insensitive.
- `archived: true|false` sets/clears `archivedAt`. Archived tasks are hidden by default filters. Archived
  closed tasks still count towards project/milestone/epic progress; archived open tasks do not (§6 `stats.ts`).
- Dates: `startDate <= dueDate` when both set (400 path `dueDate`).
- **Rank** (manual order) is a global fractional index (`fractional-indexing`); ranks are kept unique.
  Positions (`rankPositionSchema`, always in ascending-rank terms):
  - `'bottom'` (default for create): after the current max rank. `'top'`: before the min rank.
  - `{ afterId }` (beforeId optional, only validated): place **directly after `after` in the GLOBAL order**:
    lo = rank(after), hi = the next rank after `after` ordered by (rank, id), excluding the moving task
    (null if none); new rank = generateKeyBetween(lo, hi).
  - `{ beforeId }` only: hi = rank(before), lo = the previous rank before it (excluding the moving task).
  - `{}` / both null: no-op (rank unchanged). Neighbours must exist (400) and must not be the task itself
    (400); `afterId === beforeId` → 400.
  - `{ rank }` (updates only, `taskPositionSchema`; the Undo of a move): that exact rank again when no other
    task holds it — the task is back in its old place among ALL tasks, including ones a view filters out —
    else directly after the task holding it. A malformed key → 400 (path `position.rank`). In updates the
    neighbour object is strict, so `{ rank: <malformed> }` can't pass as a no-op `{}`.
  - If lo === hi (duplicate ranks), renormalize all task ranks (`generateNKeysBetween(null, null, n)` over
    tasks ordered by rank, id — no updated_at bump, no activity) and recompute.
  - Rank-only changes do NOT bump `updated_at` and create no activity.
- `updated_at` changes only when something other than rank actually changed; a no-op PATCH returns the task
  unchanged and logs nothing.
- Delete: cascades. Records `task.deleted` with `task_id NULL`, `project_id`, `entity_id` = old id, data `{ title, ref }`.
- Duplicate: same fields/tags/epic, title + ` (copy)`, status kept unless closed (then default status),
  `completedAt` NULL, not archived, placed right after the original. Activity `task.created` with
  `data.duplicatedFrom = <ref>`.
- Links (docs/design/task-dependencies.md): `task_links (blocker_id, blocked_id)`, finish-to-start, within the space,
  no cycles (400 path `blockerId`), removed with either task. TaskDTO carries `blockedBy`, `blocks`,
  `adjustedStartDate`, `adjustedDueDate` and `slipDays`, worked out when read (`services/schedule.ts`, the rules in
  `shared/src/schedule.ts`); nothing derived is stored. A link change logs `task.updated` on the blocked task with
  `{ field: 'blockedBy', added, removed }` (refs); deleting a blocker logs that on each task it blocked. A
  rebaseline logs its date changes with `data.rebaseline: true`.
- Bulk update/delete: all-or-nothing transaction; unknown ids → 400 listing them; one activity entry per task.
  Bulk `epicId` must belong to each task's project (400 listing offenders); bulk never moves projects.

### 5.6 Comments & work logs
- Comments: body trimmed, 1–50 000 chars, Markdown. Only the author may edit (403 otherwise); the author, or
  an admin or owner of the space, may delete (design §6.5). Rows of a deleted account or of a placeholder can
  be edited by nobody. Editing sets `edited_at`. Work logs: `date` required, `minutes` (int ≥ 0, nullable)
  and/or `note`; at least one of minutes>0 or a non-empty note — on create and on the MERGED row for updates
  (400, path `note`). The same author and moderation rules as comments.
- Comment, work-log and activity DTOs carry `importedBy`/`importedAt` (import provenance, design §8.6; null for
  rows written in the space).
- TaskDTO.commentCount and worklogMinutes are aggregates over existing rows (kept in the task's row by triggers,
  space migration 3).

### 5.7 Tags
- Name unique case-insensitive (duplicate → 409). Default color `DEFAULT_TAG_COLOR`.
- Merge `POST /tags/:id/merge {targetId}`: retag (no duplicates), delete source, return target. id == targetId → 400.
- Tag changes are not logged as activity (task tag changes are).

### 5.8 Activity
Row: `user_id, project_id, task_id, entity_type, entity_id, action, data(JSON), created_at`. Actions are
listed in `ActivityAction` (shared/src/types.ts). `data` follows `ActivityData`:
- `*.created`: `{ title|name, ref? }`. Task: `{ title, ref }`.
- `*.updated`: `{ changes: FieldChange[], title|name, ref? }` — only fields that actually changed.
  Task fields: `title` (from/to), `description` (no values), `status` (ids + `fromLabel/toLabel` names),
  `priority` (numbers + labels), `epic` (ids + names), `startDate`, `dueDate`, `estimate`, `tags`
  (`added`/`removed` = tag names), `archived` (booleans). Milestone/epic/project fields similarly
  (`name`, `status`, `startDate`, `dueDate`, `milestone` (epic), `key`, `color` (no values), `description`).
- `comment.*`: `{ excerpt }` (first 200 chars), `task_id` set. `worklog.*`: `{ minutes, date, note }`, `task_id` set.
- Task events have `task_id` = the task (except `task.deleted`). All entries have `project_id` (except
  `project.deleted`). Structural events (milestone/epic) have `task_id NULL`.
- **Indirect changes are not logged** and do not bump `tasks.updated_at`: FK SET NULL effects (milestone/epic
  deletion with detach), status reassignment on status delete, status category changes, tag delete/merge.
- `TaskTimelineDTO.activity` contains only `entity_type = 'task'` entries (comments and work logs come
  through their own lists). Feeds (`GET /api/activity`) contain everything, newest first by id.
- Stored `data` is served (and exported) through `sanitizeActivityData` (shared/src/export.ts): keys whose value
  doesn't match the `ActivityData` shape, and malformed `changes` entries, are dropped, so clients can rely on it.

### 5.9 Settings
Split (design §3.6): each space stores its `SpaceSettings` (`estimateUnit`, `defaultBoardId`) per key as JSON
in its `settings` table; `GET /api/settings` returns `DEFAULT_SPACE_SETTINGS` merged with stored values (other
keys, `weekStartsOn` and `homePage` included, are ignored, and PATCH strips them). Each account's
`UserPreferences` (`weekStartsOn`, `homePage`) are `PATCH /api/account/preferences` in the directory; server
code that needs `weekStartsOn` takes it from the request (`POST /api/tasks/query` body, `GET /api/dashboard?weekStartsOn=`),
default 1. Keys starting with `_` are internal (never exported/overwritten by import). `defaultBoardId` must
reference an existing board (or null). Deleting that board (directly or via project cascade) resets it to null.
Theme is a per-device preference (localStorage), not a server setting. The web client edits the preferences
(and the theme) in Account settings → Preferences (`/settings/preferences`), a space's settings in its
Settings → General (`/s/:spaceId/settings`).

### 5.10 Export and import (archive v2; design §8)
**Export** (`GET /api/s/:spaceId/data/export`, owners, re-auth): the space's **archive**, format
`lyren-plan-space` version 2 (`shared/src/archive.ts`, `SpaceArchiveDTO`), gzip-compressed, attachment
`lyren-space-<slug>-<YYYY-MM-DD>.json.gz` (`archiveFileName`: the space's name lower-cased, runs outside `[a-z0-9]`
one `-`, at most 40 characters, `space` when empty; the server's UTC date). Every row has its v1 shape with its
original id, in id order (statuses and boards in their v1 order); the derived columns (`tag_ids`, `comment_count`,
`worklog_minutes`), the fold columns, `_meta` and the `_` settings are left out. User references (`createdBy`,
`authorId`, `actorId`, and `importedBy` of the comments, work logs and activity an import attributed, which also
carry `importedAt`) are null or ids of `users`: the mirror rows rows reference plus the exporter, positive for
accounts, negative for placeholders, with the address of live accounts only. `settings` holds the space's settings.
The archive is written on one read view of the space (a read transaction of its own on Node), in keyset pages of
1,000 rows, compressed as it goes. `HEAD` answers with the headers only.

**Import** into a **new space** (`POST /api/spaces` `{ name, forImport: true }` makes it `importing`, the importer
its only owner) or over **this space** (owner, re-auth, typed confirmation in the web): `POST
…/data/import/analyze?mode=new|replace` then `POST …/data/import/commit?mode=new|replace`, each with the file as the
multipart field `file` (gzip, told by its magic bytes `1f 8b`, or plain JSON; v2 archives and v1 exports
`lyren-plan-export`/1); the commit also sends `mapping` (JSON `ImportMappingInput`: a target for every user rows
reference, an account among the analysis's candidates or `{ kind: 'placeholder' }`, and `skipActivity`). The gate
checks the mode against the space's status (`mode=new` needs `importing`, else 409 "This space has already been
imported"; `replace` needs `active`). One import runs at a time on Node (503 "Another import is running. Try
again in a minute.") and in each space on Cloudflare (503 "Another import into this space is running. Try again in
a minute."). Every analyze and commit counts on `im:<userId>` as it starts, whatever it answers, 10 an hour (429
"You have started too many imports in the last hour. Try again in about <n> minutes.", with `Retry-After`).
Reading: the unpacked bytes count against `IMPORT_BODY_LIMIT` (413 "The archive is larger
than <n> MB unpacked"), the text must be UTF-8, the JSON values (`{`, `[`, `,` outside strings) are counted before
parsing (413 "The archive has more entries than this instance accepts." past `IMPORT_MAX_JSON_VALUES`; 400 for a
nesting deeper than 64), then JSON, the format ("This is not a Lyren Plan export file") and its version
("Unsupported export format version <v>", <v> named only when it is a number or a string of at most 20 characters;
detail "Only versions 1 and 2 are supported"). A refusal never repeats the file: a problem names at most 10 unknown
tag ids ("<ids> and <n> more"), and every detail's path and message is clipped to 300 characters. Validation: the frame,
then each row through `parseBounded` (`exportRowSchemas`, `archiveRowSchemas`, `archiveUserSchema`), stopping after
50 problems — 400 listing them, nothing changed. Then referential integrity (400 listing the first 50 of all
problems): unique ids per table, unique project keys / tag names / status names (case-insensitive); milestone/epic/
task `projectId` exist; epic `milestoneId` in the same project; task `statusId` exists; task `epicId` in the same
project; task `tagIds` exist; task `blockedBy` (v2, optional) are other tasks of the file and do not loop; comment/worklog `taskId` exist; activity `taskId`/`projectId` exist or are null (drop
entries that dangle); `settings.defaultBoardId` exists else becomes null; board `projectId` exists or null;
`startDate <= dueDate` for tasks/milestones/epics (path `<table>.<i>.dueDate`) and work logs with minutes>0 or a
non-blank note (path `worklogs.<i>.note`); for v2 also `users` ids unique, a placeholder's id negative and an
account's positive, every user reference (path e.g. `tasks.12.createdBy`) and `space.exportedBy` one of `users`. The
schema caps ids, task numbers, `taskCounter` and positions at `IMPORT_INT_MAX` (2^40), and activity `data` must match
`ActivityData` (§5.8; extra keys allowed), at most 262,144 characters as JSON (`ACTIVITY_DATA_MAX_CHARS`). An invalid
address in `users` counts as none.

Analyze (`ImportAnalysisDTO`, stateless) lists the counts, the users rows reference (with how many rows of each
kind), the **candidates** (the importer and every active account that shares an active space with them; for an
instance admin every active account, at most 1,000; nobody else is ever matched or named), a suggestion per user
(the candidate with its address, else the importer when only one user is referenced or for the exporter, else a
placeholder) and the estimate (rows written, without the activity, `IMPORT_MAX_ROW_WRITES`, what is left of today's
`IMPORT_DAILY_ROW_WRITES`). Commit: the mapping is checked against the candidates asked for again (400
`validation_error` at `mapping`: every referenced user exactly once, a `user` target a candidate; v1 ignores it),
the estimate against `IMPORT_MAX_ROW_WRITES` (409 `quota_exceeded` "This import needs about <n> row writes; this
instance allows <m> per import."), the instance's daily budget is reserved (429 "This instance has reached today's
import limit. It resets at 00:00 UTC."), for a replace
the safety point is taken (`Deps.space.safety.beforeReplace()`; on Node a snapshot
`backups/spaces/<id>/pre-import-<timestamp>.db` next to the directory file, the oldest beyond `SNAPSHOT_KEEP`
deleted, §12, with the command that undoes the import, `restore "<path>"`; on Cloudflare none), then in ONE `db.tx`:
delete all domain rows (the tasks first) and the space's settings, and the mirror's rows of non-members and
placeholders; upsert the accounts users are mapped to (members stay members) and create a placeholder per user mapped
to one (its archive name, ids below 0); insert everything with the ORIGINAL ids, references through the mapping (v1:
every non-null reference, and every comment/work-log author, to the importer), comments, work logs and activity of
someone other than the importer with `imported_by` (the importer) and `imported_at` (now); an archive's own
provenance is kept only when its `importedBy` maps to the importer (the importer's own earlier import), as the
importer is the one person an import can vouch for; `task_counter = max(taskCounter, max(number))`, the fold
columns, task ranks generated in the exported (rank, id) order, the tasks' tag lists, comment counts and logged
minutes, activity `data` with the file's key order, `completedAt` consistency (closed without completedAt → now;
open → NULL), board configs read leniently with project boards forced to their project (the repairs of one
import's boards bounded together, 5,000 custom columns; a config over 262,144 characters of JSON gets the
defaults), any AUTOINCREMENT counter above `IMPORT_INT_MAX` reset to the table's max id; `PRAGMA
foreign_key_check` must be empty; `_meta.imported_at` and the result. A failed commit gives its reservation back,
less the rows its rolled-back transaction was billed for (the space's meter, on Cloudflare). The directory then activates a new
space and records the mapped accounts with the space (their later profile changes and deletion reach its mirror).
Returns `ImportResultDTO` `{ ok, counts, safety, nonMemberAuthors }`. A `mode=new` commit on a space already filled
(the directory call failed afterwards) writes nothing again and answers the stored result. The rows an import writes
are not counted in the space's daily write budget. An `importing` space can be deleted by its owner at once
(`{ confirmName: '' }`), and maintenance purges one older than 24 hours.

**People** (§8.6): `POST …/people/:personId/reassign` `{ toUserId }` (admins and owners) moves the tasks, comments,
work logs and activity of a placeholder or a former member to a member (the moved comments, work logs and
activity get `imported_by` = the admin and `imported_at` = now, also those an import had labelled: the reassignment
is the attribution now; a placeholder's row goes); `POST …/people/me/disown` (anyone) moves the imported rows
attributed to the caller to the space's placeholder "Unknown (imported)" (made by the first disown, shared by the
later ones). Neither records activity.

### 5.11 Board references
Board configs store entity ids in JSON (no FKs). `services/boardRefs.ts#rewriteBoardRefs(db, kind, fromId,
toId|null)` applies `remapBoardConfigIds` (shared/src/board.ts) to every board and saves changed configs. Call it
in the same transaction from: tag merge (→ target) and tag delete (null), status delete (→ reassignTo),
milestone / epic / project delete (null). Deletions leave filter ids in place (they match nothing; the UI shows
them as "(deleted)") but remove them from drop patches and group prefs. Clients must ignore unknown ids.

---------------------------------------------------------------------------------------------------------

## 6. Server services (server-domain agent builds these first; feature agents use them)

`server/src/services/`:

- `rows.ts` — row interfaces for every table of a space (`MirrorUserRow`, `ProjectRow`, `MilestoneRow`, `EpicRow`,
  `StatusRow`, `TagRow`, `TaskRow`, `CommentRow`, `WorklogRow`, `ActivityRow`, `BoardRow`), fold columns,
  `tasks.tag_ids`, `tasks.comment_count` and `tasks.worklog_minutes` included.
- `mappers.ts` — row → DTO (`toProjectDTO(row, stats)`, `toMilestoneDTO`, `toEpicDTO`, `toStatusDTO`,
  `toTagDTO`, `toBoardDTO` (config via `parseBoardConfigLenient`), `toCommentDTO`, `toWorklogDTO`, `toPersonDTO`).
- `stats.ts` — project stats (needs `today`), milestone & epic progress, status/tag task counts: each one scan of
  the tasks in its scope, aggregated in JS; `spaceStats(db, today)` all of them from one scan (bootstrap). No N+1
  queries. Progress (tasksTotal/tasksClosed/estimates) counts non-archived
  tasks plus archived **closed** tasks, so archiving finished work never moves progress backwards; archived
  open tasks count nowhere (not in tasksOpen/tasksOverdue either). Tag counts exclude archived tasks; status
  counts include them.
- `entities.ts` — `listProjects/getProject(DTO)`, `listMilestones(projectId?)/getMilestone`,
  `listEpics(projectId?)/getEpic`, `listStatuses`, `listTags` (each list optionally takes its statistics
  precomputed, as bootstrap passes `spaceStats`'), `listBoards/getBoard`, `listPeople` (the mirror);
  `requireProject/requireMilestone/requireEpic/requireStatus/requireTask/requireBoard` (row or 404);
  `requireTagIds(ids)` (400 listing unknown ids); `defaultStatusId()`; `generateProjectKey(name)`;
  `nextPosition(table, scope?)`; `assertExactIdSet(ids, expected)` (400 for reorder mismatches).
- `tasks.ts` — `hydrateTasks(db, rows)` → TaskDTO[] (batched milestone / ref / tag names from `tag_ids`; the
  counts from the row),
  `getTaskDTO(db, id)`, `queryTasks(db, input, { nowMs?, today?, weekStartsOn? })` → `TaskQueryResult`,
  `buildTaskWhere(filter, ctx)` → `{ sql, params }` (exact SQL equivalent of `matchesTaskFilter`),
  `taskOrderBy(sort)` (equivalent of `compareTasks`), `findTaskByRef(db, ref)`.
- `rank.ts` — `rankForPosition(db, position, movingTaskId?)`, `renormalizeRanks(db)` (§5.5).
- `activity.ts` — `recordActivity(db, entry)`, diff helpers to build `FieldChange[]`,
  `listActivity(db, query)` → `ActivityPage`, `hydrateActivity(db, rows)`, `taskActivity(db, taskId)`.
- `settings.ts` — `getSettings(db)` → `SpaceSettings`, `saveSettings(db, patch)`.
- `boardRefs.ts` — `rewriteBoardRefs(db, kind, fromId, toId)` (§5.11).
- `routes/bootstrap.ts` — `GET /api/bootstrap` → `BootstrapDTO` (accepts `?today=`).
- `db/seed.ts#ensureDefaults(db)` and `createSampleData(db, userId)` (§11; `userId` is the space owner's mirror row),
  run by `space/init.ts#initSpaceDb` when a space is created.

---------------------------------------------------------------------------------------------------------

## 7. API reference

All bodies are JSON. All mutating requests carry header `X-Lyren-Request: 1` (web/src/api/client.ts does).
Types: inputs in `shared/src/schemas.ts` / `board.ts` / `export.ts`, outputs in `shared/src/types.ts`.
Every reorder endpoint requires the exact full id set of its scope (400 otherwise). The account, space and
admin endpoints are the directory's (server/src/directory/); their rules per endpoint (re-auth, roles, limits)
are in docs/design/multi-user-and-cloudflare.md §7.2.

| Method & path | Input | Output |
|---|---|---|
| GET `/api/health` | – | `{ ok, version }` |
| GET `/api/auth/status` | – | `AuthStatusDTO` |
| POST `/api/auth/setup` | `SetupInput` (an email; incl. `setupCode`) | 201 `{ user }` + cookies |
| POST `/api/auth/login` | `LoginInput` (`identifier`: an email or a legacy username) | `{ user }` + cookies |
| POST `/api/auth/logout` | – | `{ ok }` |
| GET/PATCH `/api/account` · PATCH `/api/account/preferences` | `UpdateAccountInput` · `PreferencesUpdateInput` | `UserDTO` · `UserPreferences` |
| POST `/api/account/password` · POST `/api/account/reauth/password` | `ChangePasswordInput` · `ReauthPasswordInput` | `{ ok }` (other sessions revoked) · `ReauthDTO` `{ ok, reauthUntil }` |
| DELETE `/api/account/password` | – (re-auth) | `{ ok }`; 409 `last_credential` with the reason without a passkey that works here or a way back in (a verified address with mail, an admin who may make a reset link, or the Node command line), 409 `conflict` without a password |
| POST `/api/auth/passkey/login/options` · POST `/api/auth/passkey/login` | `PasskeyLoginOptionsInput` · `CeremonyResponseInput` | `CeremonyDTO` (a signed ceremony; nothing stored) · `{ user }` + cookies; 400 `passkey_error` (details `credential: unknown` for a passkey the instance does not know whose user handle is an account's here: removed since), not held back by the password limits |
| GET `/api/account/passkeys` · POST `/api/account/passkeys/options` · POST `/api/account/passkeys` | – · – (re-auth; fewer than 20) · `PasskeyRegisterInput` | `PasskeyDTO[]` · `CeremonyDTO` · 201 `PasskeyDTO` (409 `quota_exceeded` at 20) |
| PATCH/DELETE `/api/account/passkeys/:passkeyId` | `PasskeyRenameInput` · – (re-auth) | `PasskeyDTO` · `PasskeyRemovedDTO` `{ ok, acceptedCredentialIds, userHandle }` (409 `last_credential` for the last usable credential) |
| POST `/api/account/reauth/passkey/options` · POST `/api/account/reauth/passkey` | – · `CeremonyResponseInput` | `CeremonyDTO` (the account's passkeys that work here) · `ReauthDTO` |
| GET `/api/account/sessions` · DELETE `/api/account/sessions/:sessionId` · POST `/api/account/sessions/revoke-others` | – | `SessionDTO[]` · `{ ok }` · `{ ok, revoked }` |
| GET `/api/account/security-events?before=` · POST `/api/account/notices/seen` · DELETE `/api/account` | – · – · `AccountDeleteInput` | `SecurityEventDTO[]` (no address or agent on events an admin or the operator caused) · `{ ok }` · `{ ok }` |
| GET/POST `/api/spaces` · GET `/api/spaces/deleted` · GET/PATCH/DELETE `/api/spaces/:spaceId` · POST `…/restore` | – / `SpaceCreateInput` · – · – / `SpaceUpdateInput` / `SpaceDeleteInput` · – | `SpaceSummaryDTO[]` / 201 `SpaceSummaryDTO` · `DeletedSpaceDTO[]` · `SpaceDetailDTO` / `SpaceSummaryDTO` / `{ ok, purgeAfter }` · `SpaceSummaryDTO` |
| GET `/api/spaces/:spaceId/members` · PATCH/DELETE `…/members/:userId` · POST `…/leave` · POST `…/transfer` | `MemberRoleInput` · `TransferInput` | `MemberDTO[]` · `MemberDTO` · `{ ok }` |
| POST `/api/auth/signup` · `/api/auth/signup/inspect` · `/api/auth/signup/complete` | `SignupInput` · `TokenInput` · `SignupCompleteInput` | 202 `{ ok }` whatever the address (policy `open`, else 403 `signup_disabled`) · `SignupPreviewDTO` · 201 `{ user }` + cookies |
| POST `/api/auth/signup/passkey/options` · `/api/auth/signup/passkey/complete` | `SignupPasskeyOptionsInput` · `SignupPasskeyCompleteInput` | `CeremonyDTO` (the link is not used up) · 201 `{ user }` + cookies (the account has the passkey and no password) |
| POST `/api/auth/password/forgot` · `/api/auth/password/reset/inspect` · `/api/auth/password/reset` | `ForgotPasswordInput` · `TokenInput` · `ResetPasswordInput` | 202 `{ ok }` whatever the address · `PasswordResetPreviewDTO` (`canUsePasskey`, `passkeyKeepsPassword`) · `{ ok }` (signed out everywhere, no sign-in) |
| POST `/api/auth/password/reset/passkey/options` · `/api/auth/password/reset/passkey` | `TokenInput` · `ResetPasskeyInput` | `CeremonyDTO` · `PasskeyResetDTO` `{ ok, passwordRemoved, passwordKept }` (a passkey added instead of a password, which it replaces unless the account would then have no way back in, the reason in `passwordKept`: signed out everywhere, the `passkey_added` notice by mail) |
| POST `/api/auth/email/confirm` | `TokenInput` | `EmailConfirmedDTO`; a verification or email-change link only in a session of the token's account (401 signed out, naming the account; 403 another account; nothing consumed) |
| POST `/api/auth/recover` | `RecoverInput` | `RecoveryLinkDTO` (404 while `RECOVERY_TOKEN` is unset) |
| POST `/api/account/email` · POST `/api/account/email/verify` | `EmailChangeInput` (re-auth) · – | `EmailChangeDTO` (202 pending with mail; 200 at once without) · 202 `{ ok }` (409 `mail_not_configured` without mail) |
| GET/POST `/api/spaces/:spaceId/invitations` · POST `…/:invitationId/resend` · DELETE `…/:invitationId` | – / `InvitationCreateInput` · – · – | `InvitationDTO[]` / 201 `InvitationCreatedDTO` (503 when the mail could not be sent) · `InvitationCreatedDTO` · `{ ok }` |
| POST `/api/invitations/inspect` · POST `/api/invitations/accept` (both work signed out) | `TokenInput` · `InvitationAcceptInput` | `InvitationPreviewDTO` · `InvitationAcceptedDTO` (201 + cookies for a new account) |
| POST `/api/invitations/accept/passkey/options` · POST `/api/invitations/accept/passkey` (signed out) | `InvitationPasskeyOptionsInput` · `InvitationPasskeyAcceptInput` | `CeremonyDTO` · 201 `{ user, spaceId }` + cookies (a new account with the passkey and no password) |
| GET `/api/invitations` · POST `/api/invitations/:invitationId/accept` · `…/decline` | – | `PendingInvitationDTO[]` (with mail, for a verified address) · `{ ok, spaceId }` · `{ ok }` |
| GET `/api/admin/overview` | – | `AdminOverviewDTO`: the instance, its configuration (no secret), counts, warnings (`orphanedPasskeyAccounts`: the accounts left with passkeys that do not work here) and the last 20 administrative events (`AdminEventDTO`: actor and target) of every admin, the command line and the recovery token |
| PATCH `/api/admin/settings` | `AdminSettingsInput` (re-auth) | `InstanceInfoDTO` (409 `mail_not_configured` for `open` while sign-up links cannot be mailed: no transport that delivers mail, and no `MAIL_LOG_BODIES`) |
| GET `/api/admin/users?q&orphaned&cursor&limit` · GET `/api/admin/users/:userId` | `AdminUsersQuery` | `Page<AdminUserDTO>` (newest first; `q` in the address, username or name; `orphaned=1` only the active accounts without a password none of whose passkeys works here; `usablePasskeys` beside `passkeys`) · `AdminUserDetailDTO` (its spaces, its last 50 security events) |
| PATCH/DELETE `/api/admin/users/:userId` | `AdminUserUpdateInput` (re-auth) · – (re-auth) | `AdminUserDTO` · `{ ok }` (never one's own account, 403; the last active admin stays one, 409 `last_admin`; DELETE as design §5.8.17, 409 `last_owner`). Disabling ends the account's sessions and device tokens, revokes its open invitations and tells its spaces before it answers; demoting revokes the instance invitations it sent |
| POST `/api/admin/users/:userId/reset-link` | – | `ResetLinkDTO` (instance admins, re-auth; not for an admin's account, nor one demoted lately) |
| GET/POST `/api/admin/invitations` · DELETE `…/:invitationId` | – / `AdminInvitationInput` (re-auth) · – (re-auth) | `InvitationDTO[]` / 201 `InvitationCreatedDTO` · `{ ok }` (instance invitations: an account, no space) |
| GET `/api/admin/spaces?q&cursor&limit` · DELETE `/api/admin/spaces/:spaceId` · POST `…/restore` | `AdminSpacesQuery` · – (re-auth) · – (re-auth) | `Page<AdminSpaceDTO>` (every space, no content; `bytes` on Node only) · `{ ok, purgeAfter }` · `AdminSpaceDTO` (409 once the grace period is over, or when no member is left) |
| GET/HEAD `/api/admin/backup` | – | a backup set (`application/x-tar`; instance admins, re-auth; 403 for an image, a frame or another site by Fetch Metadata, design §13.4) |
| POST `/api/admin/mail/test` | – | `MailTestDTO` `{ ok, messageId? }`: a test message to the admin's own address, sent at once (instance admins); 502 `unavailable` with the transport's error (never a secret), 409 for an account without an email address |
| *Space endpoints, from here down to `/api/search`: served as `/api/s/:spaceId/<path after /api>` (design §7.3); the role each needs is the gate's (design §6.4), and reads answer `If-None-Match` with 304. Without a known session 401, for a space the account cannot open 404, whether or not the space exists. Unprefixed (`/api/bootstrap`, …) they are no space's: the directory answers them as any path it does not know, 401 signed out and 404 signed in, with the message "Lyren Plan has been updated. Reload the page to continue." for the tab of an old client* | | |
| GET `/api/bootstrap?today=` | – | `BootstrapDTO` (`user`: `UserRef`; `space`: `SpaceInfoDTO` with the viewer's role; `people`: the mirror; `settings`: `SpaceSettings`) |
| GET `/api/projects?today=` · GET `/api/projects/:id?today=` | – | `ProjectDTO[]` · `ProjectDTO` |
| POST `/api/projects` · PATCH `/api/projects/:id` | `ProjectCreateInput` · `ProjectUpdateInput` | `ProjectDTO` |
| DELETE `/api/projects/:id` | – | `{ ok }` |
| POST `/api/projects/reorder` | `ReorderInput` | `{ ok }` |
| GET `/api/projects/:id/milestones` · `/epics` | – | `MilestoneDTO[]` · `EpicDTO[]` |
| POST `/api/milestones` · GET/PATCH `/api/milestones/:id` | `MilestoneCreateInput` · `MilestoneUpdateInput` | `MilestoneDTO` |
| DELETE `/api/milestones/:id?epics=detach\|delete` | – | `{ ok }` |
| POST `/api/milestones/reorder` | `ReorderInput` (all of one project) | `{ ok }` |
| POST `/api/epics` · GET/PATCH `/api/epics/:id` | `EpicCreateInput` · `EpicUpdateInput` | `EpicDTO` |
| DELETE `/api/epics/:id?tasks=detach\|delete` | – | `{ ok }` |
| POST `/api/epics/reorder` | `ReorderInput` (all of one project) | `{ ok }` |
| POST `/api/tasks/query` | `TaskQueryInput` | `TaskQueryResult` |
| POST `/api/tasks` | `TaskCreateInput` | 201 `TaskDTO` |
| GET `/api/tasks/:id?today=` · GET `/api/tasks/ref/:ref?today=` | – | `TaskDTO` |
| PATCH `/api/tasks/:id` | `TaskUpdateInput` | `TaskDTO` |
| DELETE `/api/tasks/:id` | – | `{ ok }` |
| POST `/api/tasks/:id/duplicate` | – | 201 `TaskDTO` |
| POST `/api/tasks/:id/blockers` · DELETE `/api/tasks/:id/blockers/:blockerId` | `TaskLinkInput` · – | `TaskDTO` (the blocked task; design task-dependencies §6) |
| POST `/api/tasks/rebaseline/preview` · POST `/api/tasks/rebaseline` | `RebaselineInput` (`projectId` or `ids`, `today`) | `{ items: RebaselineItemDTO[] }` |
| POST `/api/tasks/bulk` | `TaskBulkUpdateInput` | `{ tasks: TaskDTO[] }` |
| POST `/api/tasks/bulk-delete` | `TaskBulkDeleteInput` | `{ deleted }` |
| GET `/api/tasks/:id/timeline` | – | `TaskTimelineDTO` (each list oldest first) |
| POST `/api/tasks/:id/comments` · PATCH/DELETE `/api/comments/:id` | `CommentCreateInput` | `CommentDTO` (DELETE: the author, an admin or an owner) |
| POST `/api/tasks/:id/worklogs` · PATCH/DELETE `/api/worklogs/:id` | `WorklogCreateInput` · `WorklogUpdateInput` | `WorklogDTO` (DELETE: the author, an admin or an owner) |
| GET `/api/worklogs?from&to&projectId&today&userId` | `WorklogReportQuery` (default [today-29, today]; `userId`: only that user's) | `WorklogReportDTO` |
| GET `/api/activity?projectId&taskId&before&limit` | `ActivityQueryInput` | `ActivityPage` |
| GET/POST `/api/boards` · GET/PATCH/DELETE `/api/boards/:id` | `BoardCreateInput` · `BoardUpdateInput` | `BoardDTO` |
| POST `/api/boards/:id/duplicate` · POST `/api/boards/reorder` | – · `ReorderInput` (one scope: global or one project) | 201 `BoardDTO` · `{ ok }` |
| GET/POST `/api/tags` · PATCH/DELETE `/api/tags/:id` · POST `/api/tags/:id/merge` | `TagCreateInput` · `TagUpdateInput` · `TagMergeInput` | `TagDTO` |
| GET/POST `/api/statuses` · PATCH `/api/statuses/:id` · DELETE `/api/statuses/:id?reassignTo=` · POST `/api/statuses/reorder` | `StatusCreateInput` · `StatusUpdateInput` · `ReorderInput` | `StatusDTO` |
| GET/PATCH `/api/settings` | `SpaceSettingsUpdateInput` | `SpaceSettings` (§5.9) |
| GET/HEAD `/api/data/export` | – | the space's archive v2 (`application/gzip`, attachment `lyren-space-<slug>-YYYY-MM-DD.json.gz`, `SpaceArchiveDTO`; owner, re-auth; 403 for an image, a frame or another site by Fetch Metadata, design §13.4; §5.10) |
| POST `/api/data/import/analyze?mode=new\|replace` | multipart `file` | `ImportAnalysisDTO` (§5.10; owner, re-auth for `replace`; `new` only while the space is `importing`) |
| POST `/api/data/import/commit?mode=new\|replace` | multipart `file`, `mapping` (JSON `ImportMappingInput`) | `ImportResultDTO` (§5.10; 409 `quota_exceeded` over `IMPORT_MAX_ROW_WRITES`, 429 past the day's import budget) |
| POST `/api/people/:personId/reassign` · POST `/api/people/me/disown` | `PeopleReassignInput` · – | `PeopleReassignedDTO` (admins and owners) · `PeopleDisownedDTO` (anyone) |
| GET `/api/dashboard?today=&weekStartsOn=` | – | `DashboardDTO` (lists capped at 50 / 20; `counts` = uncapped totals per list, `inProgressProjects` = distinct projects with started tasks; `slipped` = open slipped tasks; `worklog` = the viewer's own time) |
| GET `/api/search?q&limit` | `SearchQueryInput` | `SearchResultDTO` (tasks of every project, archived tasks included and ranked after live ones at equal relevance) |

The instance backup is the directory's `GET /api/admin/backup` (design §9.5); the space app has no backup route.

Boards: `projectId` is immutable (create only). For project boards the server forces
`config.filter.projectIds = [projectId]` on create/update/duplicate. `GET /api/boards` returns all boards.

### Filter semantics (`TaskFilter`, implemented by `matchesTaskFilter` in shared/src/filter.ts)
All present criteria are ANDed; within an array values are ORed; **an omitted or empty array means "no
constraint"**. `ids` restricts the result to those tasks (the palette refreshes its Recent list with it).
`null` inside `milestoneIds`/`epicIds`/`tagIds` means "has none". The due criteria and the `dueDate` sort go by
`effectiveDueDate`: a slipped task's adjusted due date, else its own (the SQL passes the slipped tasks' dates as
`:slips`); `slipped: true` keeps the slipped tasks only. `tagMode: 'all'` requires
every listed (non-null) tag (only `[null]` → untagged). `due` presets are ORed and resolved against the
request's `today`/`weekStartsOn` (`overdue` excludes closed tasks). `search`: every whitespace token must
appear (case-insensitive) in title, description or ref. `archived`: default `exclude`. `closedWithinDays`:
0 hides every closed task; N>0 keeps closed tasks with `completedAt >= now − N days` (closed with NULL
completedAt count as recent) — SQL: `NOT closed OR (:n > 0 AND (completed_at IS NULL OR completed_at >= :cutoffIso))`.
Projects with status `archived` are excluded unless listed in `projectIds` or `includeArchivedProjects` is
true. Sorting: `compareTasks` (same file). The server SQL must match these functions exactly (the
server-domain tests cross-check them on randomized data).

---------------------------------------------------------------------------------------------------------

## 8. Boards

A board = name + description + optional `projectId` + `BoardConfig` (shared/src/board.ts; always parse with
`boardConfigSchema` / `parseBoardConfigLenient`). Global boards (`projectId` null) are listed on /boards;
project boards on the project's Board tab (several per project, ordered by position, switchable as tabs).
For project boards the effective filter always has `projectIds = [projectId]`, and the editor hides
"project" grouping and the project filter.

**Saving**: config edits on a saved board (config panel, collapsing/reordering/hiding groups, card options)
**auto-save** (debounced ~400 ms via the optimistic `useUpdateBoard`). "Duplicate" exists for experiments.
**Quick filters** in the board header (text search, tags, priorities, assignee-free "hide closed" toggle)
are view state in URL search params (`?q=&tags=1,2&pri=3,4&closed=0`), ANDed with `config.filter`, never
saved. Below md, tags, priorities and "hide closed" sit in a "Filters" sheet behind one button that shows the
number of active ones (`quickFilterCount`), so the search, the filters and the board buttons fit in one row.
That button is not part of the scrolling strip (it can't scroll away or sit under the fade); it shows only its
icon / count below 22rem and while the search is in use (a query set or being typed); a set query shrinks to
the room left (the project Board tab's row also holds Configure and ⋯) and gets the active-filter look; while
the search has focus the list toggle and Select step aside so it gets the row, Filters staying at hand.
A project's Board tab with no saved boards renders `defaultBoardConfig({ filter: { projectIds: [id] } })`
and the first config change creates a project board named "Board" (nothing is lost).

**Data flow**: fetch with `useTaskQuery({ filter: effectiveFilter, sort: config.sort, today, weekStartsOn,
limit: LIMITS.queryLimitMax })`. Derive the view from the cached result as
`tasks.filter(t => matchesTaskFilter(t, effectiveFilter, fctx)).sort((a, b) => compareTasks(a, b, sort, sctx))`
(equals server order when nothing is pending, and makes optimistic edits move cards immediately), then group
stably. When `total > tasks.length` show "Showing N of M tasks — narrow the filter".

### 8.1 Groups
Keys: see the table at the end of board.ts. A task with several tags appears in several tag groups.
Custom grouping: `customGroupKey()` (first match, archive defaults ignored), else `'__other'`.

**Enumeration** (`enumerateGroups(field, axis, filter, lookups, tasks)` in features/boards/grouping.ts,
unit-tested) — natural order, then restricted by the filter:
| field | natural order & scope |
|---|---|
| status | by position; ∩ filter.statusIds; ∩ category ∈ filter.statusCategories (each when non-empty) |
| statusCategory | STATUS_CATEGORIES order; only categories with ≥1 status; ∩ filter.statusCategories; ∩ categories of filter.statusIds |
| priority | 4, 3, 2, 1, 0; ∩ filter.priorities |
| project | by position; filter.projectIds if non-empty, else non-archived projects (all if includeArchivedProjects) |
| milestone / epic | entities of the in-scope projects (project position, then own position); ∩ filter.milestoneIds / filter.epicIds (epics also ∩ milestoneId ∈ filter.milestoneIds when set). Completed/cancelled milestones and done/cancelled epics only when they have tasks in the result. `none` only when the id filter is empty or contains null |
| tag | by name; with non-empty tagIds and tagMode 'any' only the listed tags; minus excludeTagIds; `none` only when tagIds is empty or contains null |
| due | DUE_BUCKETS order (`dueBucket(due, today, ws, closed)`; closed past-due tasks go to `past`) |
| custom | array order of `custom`, then `__other` (when showUnmatched) |

`none` and `__other` come last. A key present in the tasks but not enumerated (stale data) is appended, so
tasks never disappear. Then apply the axis prefs for the current field (`activePrefs(axis)`): `order`
(listed keys first in that order; ignored for custom), `hidden`, `collapsed`.
Visible(g) = not hidden && (g.key !== 'none' || showNone) && (count > 0 || showEmpty); custom columns are
always visible unless hidden; empty lanes hidden unless swimlanes.showEmpty. The header shows
"N tasks in hidden groups" when applicable.

**WIP**: `wipLimits[key]` (columns only) counts tasks in the column across all lanes. Header shows `7 / 5`
with a warning icon and visually-hidden text "over WIP limit" when exceeded (soft; never blocks).

### 8.2 Drag & drop
A drop from cell (srcLane, srcCol) to (dstLane, dstCol) sends `colPatch(srcCol→dstCol) ∪ lanePatch(srcLane→dstLane)`;
an axis whose key is unchanged contributes nothing. One pure function, unit-tested:
`computeDropPatch(config, ctx, task, from: {lane, col}, to: {lane, col}) → TaskUpdateInput | null` (null = not
droppable). If a changed axis is not droppable, or the merged patch sets the same field twice, or sets
projectId together with an epic of a different project, the target is not droppable (rendered disabled
while dragging). Per-axis patches:
| field | patch for src → dst |
|---|---|
| status | `statusId` = dst |
| statusCategory | `statusId` = first status (by position) of the dst category that `filter.statusIds` allows (when set), else the first of the category (`categoryTargetStatus`) |
| priority | `priority` = dst |
| project | `projectId` = dst (server clears the epic) |
| epic | `epicId` = dst or null for `none` (may move the task to the epic's project); `none` inside a project lane = `{ projectId: lane, epicId: null }` |
| milestone | not droppable across groups (milestone comes from the epic) — reorder only |
| tag | dst `none` → `tagIds: []` ("Remove all tags"); src `none` → `addTagIds: [dst]`; else `removeTagIds: [src], addTagIds: [dst]` |
| due | `dueDate = dueBucketDropDate(dst, today, ws)`; `undefined` = not droppable (past/overdue/later) |
| custom | `resolveDropPatch(dst.onDrop)`; plus `removeTagIds` = src.onDrop.addTagIds − dst.onDrop.addTagIds when src is custom; `__other` and `onDrop: null` are not droppable; `onDrop: {}` = reorder-only. After patching, if `customGroupKey(applyTaskPatch(task, patch))` ≠ dst, still send it and toast "Moved — it now matches “<group>”". |

Feedback and Undo: a drop into another cell (and a card-menu "Move to column / lane") shows a success toast
naming the target ("Moved WEB-7 to Payments · Todo", or the custom landing message above; after a move to
another project also the new ref: "… (now ME-5)", `withNewRef`) with **Undo**, which applies
`inverseTaskPatch(task, patch)` (api/tasks.ts: the old values of every changed field; project and epic
together — the server gives the task its old number back, §5.5; the full tag set; after a manual-sort drop
the old rank, `position: { rank }`, so the card returns to its exact place in the global order even when it
was alone in its cell). Reordering within a cell shows no toast. Above the dragged card the DragOverlay shows
"→ Lane · Column" on boards with lanes, "Can't move here" over a cell that can't take it, and "Release to
cancel" while the pointer is off the board (any layout).

Phones with lanes stack each column's lanes separately, so the lane under the finger in another column is
arbitrary: a **touch** drag that enters another column keeps the card's own lane (`keepLaneTarget` in
features/boards/laneKeep.ts, unit-tested) and scrolls that lane's cell under the finger, until the finger moves
vertically more than `LANE_SLOP` (32px) inside that column; from then on the cell under the finger is the
target. Nothing may change the layout when a drag starts: "Add task" rows are hidden (not removed) while
dragging, and an empty lane's one-row header on phones is itself the drop target (it does not expand).

Ordering: only when `sort.field === 'manual'`. Neighbours are the cards directly above/below the drop point
**in the target cell** (lane × column) of the rendered list. dir `asc`: `{ afterId: above, beforeId: below }`;
dir `desc`: `{ afterId: below, beforeId: above }`. Both null (empty cell, collapsed group, header) → omit
`position`. With other sorts, never send `position` (cards can only move between groups). A multi-tag
card's rank is global, so reordering it also changes its order in its other tag groups (expected).
Draggable/sortable ids are `${laneKey}|${colKey}|${taskId}`; read the source keys from the active id.

### 8.3 Layouts and mobile
- **Kanban (≥ md)**: horizontal scrolling columns (~18–19rem); collapsed columns render as a narrow vertical
  strip (name + count); lanes are collapsible horizontal bands with aligned columns.
- **Kanban (< md)**: columns `w-[85vw] max-w-[22rem]` in one horizontal scroller with
  `scroll-snap-type: x mandatory` and `snap-start` columns; a sticky strip of column chips (name + count)
  jumps to a column. Swimlanes render as collapsible sections inside each column (no 2-D grid). A per-device
  "Show as list on this device" toggle (localStorage) switches to list layout.
- Every board scroller is `position: relative`, so absolutely positioned descendants (sr-only labels) can't
  escape its clipping and make the page scroller around the board scrollable (drag auto-scroll would then
  scroll the page sideways instead of the board).
- **List layout**: one collapsible section per column group (same order/hidden/collapsed/showEmpty/showNone
  and WIP badge), rows show `card.fields` inline (domain TaskRow), swimlanes ignored (editor disables lane
  controls). Dragging rows between sections uses only the column patch. (Boards do NOT use features/tasks
  TaskList; they render their own groups with domain components.)
- **DnD sensors**: MouseSensor `{ distance: 4 }`, TouchSensor `{ delay: 250, tolerance: 8 }`, KeyboardSensor with
  sortableKeyboardCoordinates. Never PointerSensor with `touch-action: none` on cards (it blocks scrolling).
  Collision: off the board — outside BoardView's `data-board-area` element, except past an edge it shares with
  the window (the bottom counts up to the phone tab bar / offline banner, `data-bottom-chrome`, so a finger
  pushed onto the tab bar still auto-scrolls and drops; `isOverBoard` in `pointerTarget.ts`, unit-tested) —
  nothing, so releasing over the sidebar, the header or a toolbar cancels the drag ("not moved"). On the board: the droppables under the pointer; over none
  (a gap, or past the board's edge while it auto-scrolls) the nearest column to the pointer, then the nearest
  cell in it (`nearestToPoint`) — not the droppable nearest the dragged card's corners, which reach into the
  next column. Keyboard drags (no pointer) use closestCorners.
  Cards: `touch-action: manipulation; -webkit-touch-callout: none; user-select: none`, open on click (not an
  `<a href>`), `navigator.vibrate?.(10)` on drag start, DragOverlay, edge auto-scroll.
- **Long-press is reserved for drag**: on touch, each card shows an always-visible "⋯" button (TaskActionsMenu
  with board `extraItems`: "Move to column ▸", "Move to lane ▸" (droppable targets via computeDropPatch),
  and with manual sort "Move to top/bottom of column"). Multi-select is an explicit "Select" mode whose
  Actions menu is the task lists' bulk menu (`useBulkTaskActions`, §9.1). Below 22rem its bar shows the
  count without "selected" and an icon-only Actions button, so Clear, Actions and Done fit at 320px.
- **Performance**: React.memo cards with stable props; each cell renders its first cards with "Show N more"
  (adds 50): without swimlanes the first 50 per cell; with swimlanes the visible, expanded, non-empty cells share
  a ~300-card budget, 5–50 per cell (`cellPageSize` in grouping.ts). On phones with swimlanes only the column in
  view and its neighbours render cards; the others show lane headers and mount when scrolled or jumped to.
- **Cards**: the description preview (card field `description`) is one line in compact density and two in
  comfortable.
- **Quick add**: "+" per column/cell calls `openCreateTask(defaults)` with the cell's patch as create
  defaults (statusId, priority, epicId, dueDate, tagIds = addTagIds; projectId from the lane/column project,
  else the board's project / filter.projectIds when it has exactly one entry).

---------------------------------------------------------------------------------------------------------

## 9. Web conventions

- **Spaces** (design §12.2–§12.4): every page of a space is under `/s/:spaceId/…` (`SpaceLayout`: the space
  context from `AuthStatusDTO.spaces`, its bootstrap, the shell); `/spaces`, `/settings` (the account) and
  `/admin` (instance admins) are outside any space (`DirectoryLayout`). `/` opens the last space used
  (`lyren.lastSpace`), else the first, else `/spaces`. Links inside a space are built with `useSpacePath()`
  (`sp('/projects/3')`) or `spaceLink(spaceId, path)` (app/space.ts), never written unprefixed
  (`routeLiterals.test.ts` fails on one); the old paths (`/dashboard`, `/projects/…`, `/boards/…`,
  `/tasks/…`, `/activity`, `/worklog`, `/settings/statuses|tags|data`) redirect to the same path, search
  and hash in `AuthStatusDTO.legacySpaceId`'s space, else the last used one (app/legacyRedirect.ts), so
  bookmarks and links in descriptions keep working. A space the account cannot open shows "Space not
  found". Role-aware UI reads `useSpace().permissions` (`spacePermissions(role)`, shared/src/roles.ts) and the
  decisions in app/permissions.ts (`entryActions`, `spaceSettingsSections`, `memberActions`, `leaveRefusal`).
- **Spaces in the shell** (design §12.9): the sidebar's top row is the space switcher (the space's name, on up
  to two lines before it is cut, and the account's role there; a Menu of the account's spaces with the current one checked, "All spaces…",
  "Create space…" → `/spaces?create=1`); on phones the More sheet's "Space: <name>" row opens the same list as a
  sheet. Switching opens `/s/<id>/` and stores `lyren.lastSpace`. The palette searches the current space and
  has "Switch space…" (its list becomes the spaces; Backspace in the empty field goes back). `/spaces` lists
  the spaces (role, member count), creates one (name, optional sample data) and restores recently deleted
  ones until their purge date.
- **Viewer mode** (design §12.9): a role that may not write (viewers) gets no "New task" (sidebar, "+",
  `c`, palette, the shortcut help, which also leaves out writing and moving cards), quick-add rows, bulk select, card or row "⋯" menus, task-menu edits (the drawer's and task
  page's menus keep Open, Copy link and Open full page), drags (cards, projects, milestones, epics, boards),
  create/edit/delete of projects, milestones, epics and boards, comment composer or "Log time"; the task's
  title, properties and description, and milestone and epic fields, show their values only
  (`PropertyButton readOnly`, `InlineEdit disabled`). Board configuration changes then apply to the view and
  are not saved. Every PageHeader in such a space carries a "View only" badge. Members may not delete
  projects, merge or delete tags, or change statuses and the space settings; admins and owners also delete
  anyone's comments and work logs (`entryActions`). Authors and task creators who left the space read
  "<name> (former member)", deleted accounts "(deleted account)" (lib/people.ts). The server enforces the same
  rules (the space gate, design §6.4).
- **Data**: use the hooks in `web/src/api/*` (they define keys and invalidation). Space requests go through
  `spaceApi(spaceId)` (`/api/s/<id>…`), directory requests through `http`/`request`; every key of a space's
  data starts with `['space', spaceId]` (`qk.*(sid, …)`, api/keys.ts), and hooks capture the space when they
  start, so an answer that arrives after a switch lands in its own space. Space reads are conditional: the
  client keeps each one's last ETag and body in memory (api/etagStore.ts: 200 entries, 20 MB of JSON text,
  least recently used out; cleared with the user's data and per space left or lost), sends `If-None-Match`
  and answers a 304 with the stored body. Read projects, milestones, epics, statuses, tags, boards, people,
  settings (the space's merged with the account's preferences) and the user from `useLookups()` (bootstrap,
  memoized per payload) — never refetch them per page. Mutations already invalidate the right caches; show
  `toast.error(err)` on failure; `errorMessage` (api/errors.ts) maps the error codes to texts (§12.11 of the
  design; an answer without our error body that names Cloudflare's error 1027 is the daily usage limit, any other
  such 429 "Too many requests. Wait a moment and try again."), and a 421 `wrong_host` moves the page to
  `PUBLIC_URL` once per load.
- **Navigation model**: ≥ md: collapsible left sidebar (the space switcher, Dashboard, Projects list, Boards
  list, Activity, Work log, Settings (the space's); search + new-task buttons; user menu with Account settings
  and, for instance admins, Administration). < md: bottom bar (h-14 + safe area) with Home (dashboard) ·
  Projects · Boards · Search (palette) · More (sheet: the account's email address, the "Space" row, Activity,
  Work log, Settings, Account settings, Administration (instance admins), theme,
  sign out; also opened by the 'toggle-nav' event; it rests on top of the bar, which stays usable by touch:
  More closes it again, the other tabs leave it. While the sheet is shown the bar is aria-hidden and out of
  the Tab order, and the sheet has its own Close button (first Tab stop; Esc works too)), plus a floating "+"
  above the bar, hidden while a sheet is open. New-task defaults (the "+", `c`, the sidebar's New task and the
  palette's) come from `createTaskDefaults` (components/layout/navigation.ts), read when the action fires:
  the task open in the drawer (`?task=`) or on its `/tasks/:key` page first (its project, and its epic when
  that belongs to the project), else the page's project / epic / board.
- **Scrolling**: pages scroll the DOCUMENT (so mobile browser toolbars collapse and tap-status-bar works):
  sticky headers use `top-0` + safe-area padding; main content gets bottom padding for the bottom bar on
  mobile. Only board pages use a fixed-height layout (`100dvh`-based, never `vh`) with an inner scroller.
- **PageHeader**: every page renders one; nested pages (project sub-pages, milestone, epic, task, settings
  sections) pass `backTo` so installed PWAs (no browser back button) can navigate up.
- **Task drawer** (`?task=<id>` via `useOpenTask()` / `useCloseTask()` in lib/taskLinks.ts, which handle
  history): ≥ md a NON-modal right panel (~36rem, no scrim; the page stays interactive; clicking another card
  swaps the task; Esc closes; focus moves to the title on open and back to the origin on close). < md a modal
  full-screen sheet with ← (close), the ref and "⋯" (TaskActionsMenu). The comment composer is sticky at the
  bottom of the drawer's scroll container.
- **Overlays**: every dialog/drawer/sheet/menu/popover registers with `useOverlay()` (lib/overlays.ts): only
  the top overlay handles Esc; single-key hotkeys are suppressed while any overlay is open; full-screen
  sheets on phones use `history: true` so Back closes them (and call `dismissForNavigation()` before closing
  due to a navigation). Confirm before discarding a non-empty create-task or comment draft.
- **Toasts** draw above every overlay (z-60) so Undo / Open stay reachable, and move out of an open panel's
  way (`placeToasts` in components/ui/toastPlacement.ts; components/ui/README.md): the usual spot when no panel
  is there, else right above a bottom sheet or centred card, else beside the docked desktop drawer, else
  inside a full-screen panel in the free band nearest the usual spot (no control under it), else the top
  edge. Panels are measured where they settle (untransformed box), and the stack is re-placed when toasts
  come or go, a panel opens, finishes its enter transition, resizes, changes content or gets focus, and on
  window resize — never while a panel scrolls. TaskList's bulk bar lifts the usual spot above itself
  (`--selection-bar-h`).
- **Global UI**: `openCreateTask(defaults)`, `openCommandPalette()`, `emit('toggle-nav', {})` (lib/events.ts).
  Global hosts (TaskDrawerHost, TaskCreateDialogHost, CommandPalette) stay tiny and eagerly mounted (they must
  subscribe at startup) but lazy-load their heavy content (`lazy(() => import(...))`) on first open; prefetch
  the task drawer chunk when idle.
- **Offline / network**: mutations fail fast when offline (queryClient `networkMode: 'always'`) → roll back
  + toast "Could not reach the server". AppShell shows a thin "Offline — changes can't be saved" banner
  (navigator.onLine / onlineManager). Forms keep their content when a submit fails. Unsent drafts (comment,
  work log, create-task) may be kept per task in sessionStorage. `localStorage` only for per-device prefs
  (theme, sidebar collapsed, last-used project, per-device board list toggle, recent items). Keys that hold a
  space's ids are the space's (lib/spaceStorage.ts: `lyren.s.<spaceId>.palette.recent`, `.lastProjectId`,
  `.projectBoard.<id>`, `.overview.<id>`, `.createTaskDraft`, `.draft.<kind>.<taskId>`); device preferences stay
  global (`lyren.theme`, `lyren.sidebar.*`, `lyren.board.listOnPhone`, `lyren.project.showDescription`,
  `lyren.trayHint.dismissed`, `lyren.chunkReloadAt`, `lyren.lastSpace`). The unprefixed keys of the client
  before spaces move into `AuthStatusDTO.legacySpaceId`'s space (the upgraded data; named only to its members)
  the first time it is opened while `lyren.legacyKeysMoved` is unset, which is then set; no other space gets
  them. Unsent drafts belong to the account signed in in the tab (sessionStorage `lyren.draftsAccount`):
  signing out drops them, and they are dropped before another account's pages read any.
- **Styling**: Tailwind utilities with the semantic tokens in `web/src/index.css` (`bg-surface`, `text-fg-muted`,
  `border-border`, `bg-accent text-accent-fg` …). Never hard-code grays/blacks/whites for UI chrome — both
  light and dark themes must look right. Entity colors (user data) via inline style + lib/colors.ts.
  Icons: lucide-react, 16px default (`size-4`), `aria-hidden` when decorative.
- **Markdown** (components/ui/Markdown): react-markdown + remark-gfm, never raw HTML; links get
  `target="_blank" rel="noopener noreferrer"`; images whose src is not same-origin/data: render as a link with
  the alt text (CSP blocks remote images anyway). Lazy-load the renderer with a plain-text fallback.
- **Components**: build on `components/ui` and `components/domain`; don't re-implement buttons, dialogs,
  menus, pickers or task cards in feature code. §9.1 lists the cross-team contracts.
- **Mobile first**: design for 360–430px widths first, then `md:` (≥768px) for desktop. Touch targets
  ≥ 40px. No hover-only affordances. Dialogs/drawers become full-screen or bottom sheets on mobile (the UI
  kit handles this). Respect safe areas (`pt-safe`/`pb-safe`). Horizontal scrolling only inside explicit
  containers (boards). Inputs ≥ 16px font on mobile (index.css handles it).
- **Accessibility**: semantic elements, labels for every input, `aria-label` on icon-only buttons,
  keyboard reachable menus/dialogs (Esc closes, focus trapped in modals and restored), visible focus rings,
  color never the only signal (status icons have shapes, overdue has text, WIP has text).
- **Pages** default-export their component (lazy routes in app/App.tsx) and set `document.title` via
  `useDocumentTitle()`. Empty/loading/error states everywhere (`EmptyState`, `Skeleton`/`Spinner`, `ErrorState`).
- **Optimistic UI**: task edits via `useUpdateTask` are optimistic (cards move immediately); board config
  edits via `useUpdateBoard` are optimistic and serialized.
- **Re-auth** (design §5.4.4, §12.8): one `ReauthHost` (features/account/ReauthDialog.tsx, mounted by AuthedApp)
  asks for the password (`POST /api/account/reauth/password`) when the account has one, and offers "Use a passkey"
  (`POST /api/account/reauth/passkey`) where passkeys are available and one of the account's works on this address
  (`GET /api/account/passkeys`, `rpIdMatches`; `reauth.ts#reauthMethods`). Actions that know they need the window call
  `ensureReauth()` first (the space archive's download, Replace this space's analysis and commit and its
  "Download the current data first", every write of Administration and its Download
  backup, deleting the account or a space, transferring ownership, role changes to or from admin and owner, adding or
  removing a passkey, setting a first password): it goes on at once while `AuthStatusDTO.reauthUntil` is more than 30 s
  ahead, else opens the dialog and resolves false when it is cancelled. Any request answered `reauth_required`
  opens the dialog too (the API client's `setReauthHandler`) and is sent once more after the confirmation;
  requests refused together share one dialog, and a closed dialog rejects them with a `ReauthDeclinedError`
  (api/errors.ts), for which `toast.error` shows nothing. An account that cannot confirm here (no password, no
  passkey that works here) is told how a reset link gets it one (`reauth.ts#resetLinkWayText`).
  Downloads start after the check, never from a plain link.
- **Administration** (`/admin`, instance admins; design §12.2): Overview, Settings, Users (and a page per
  account), Invitations and Spaces, from `GET /api/admin/*`; the texts are pure modules in features/admin/
  (`overview.ts`, `settings.ts`, `users.ts`, `spaces.ts`, `invitations.ts`). A link to pass on (an instance
  invitation's or a reset link, when the instance sends no mail) is shown with `ShareLinkField`
  (lib/shareLinks.ts: made absolute, a choice among `shareOrigins`, a warning on a loopback address) and a copy
  button (`CopyField`, lib/clipboard.ts). Actions whose row may leave its list await `mutateAsync()` for their
  toasts.
- **Security notices** (design §5.8.11, §12.7): `AuthStatusDTO.notices` (an administrator created a reset link,
  the recovery token was used) show once as a banner after sign-in (`NoticesBanner`) and are marked seen
  (`POST /api/account/notices/seen`) as soon as they arrive.
- **Public pages** (design §12.2, §12.7): `/login`, `/setup`, `/signup` and `/forgot` are for signed-out browsers
  (`PublicOnly`); the pages a link opens, `/signup/complete`, `/reset`, `/email/confirm`, `/invite` and
  `/recover`, work signed in or out (`PublicPage`) and ask for nothing but the auth status before their own
  request. The sign-in page offers "Forgot password?" only when `instance.mailLinks` (links can be mailed: `mail`,
  or `MAIL_LOG_BODIES` in development, which writes them to the log), else "ask an administrator for a reset link"
  (plus the `reset-password` command on Node), and "Create an account" only under the `open` policy while links can
  be mailed (`features/auth/linkPages.ts`; `/signup` says sign-up is not available otherwise). Verification, the
  email change's confirmation and the policy's `open` follow `mailLinks` too; invitations follow `instance.mail`. A link's token is in its fragment (`#t=…`): it leaves the address bar
  before the router reads the address (`lib/linkToken.ts`, called by app/App.tsx) and is kept in memory for its
  page only, never in a query string or storage; a reload therefore asks for the link again. Every refused token
  (unknown, used, expired, revoked: one server answer) gets the page's "can't be used" state with the server's
  message and where a new link comes from; password fields show and check `instance.passwordMinLength`. The
  email confirmation sends its link on load: a verification or an email change works only in a session of the
  link's account, on any device (signed out: an inline sign-in as the account the server names, then the link
  again; another account: sign out first). `/invite` shows who invited whom to what and offers, by
  `InvitationPreviewDTO`: join (a member already is told what accepting changes, `signedIn.memberRole`), "this
  invitation is for <address>" with sign-out, create the account, sign in and join, or both when a copied link
  cannot say whether the address has an account; accepting lands in the space. Refusals the reader cannot fix
  say what to do: sign-up closed (sign in with an account of one's own, or ask the inviter or an
  administrator), a full space (ask the inviter to make room). Where passkeys are available, the pages that give
  an account a way in offer a passkey instead of a password (`features/auth/PasskeyChoice.tsx`: "Use a passkey
  instead" on `/signup/complete` and a new account's `/invite`, "Set up a passkey instead" on `/reset` when
  `canUsePasskey`; the page says whether the passkey replaces the password, and the reset then opens the sign-in
  page with "Passkey set up, and your password removed. Sign in with the passkey." or why the password stays,
  `linkPages.ts#passkeyResetText`/`passkeyResetNotice`, the focus on "Sign in with a passkey").
- **Passkeys** (design §5.6, §5.8.3, §5.8.12, §5.8.13, §12.7): nothing about them shows unless
  `lib/passkeys.ts#passkeysAvailable`: `instance.passkeys.enabled`, `window.isSecureContext`, `location.origin ===
  instance.passkeys.origin` and `browserSupportsWebAuthn()` (so never in the desktop app, on an IP or LAN
  address, or at another origin of the instance). `api/passkeys.ts` runs every ceremony (the options call,
  @simplewebauthn/browser's `startRegistration`/`startAuthentication`, the answer with its `ceremonyId`). The
  sign-in form (`SignInForm`, also on `/invite` and `/email/confirm`) has "Sign in with a passkey" and the
  identifier field's autofill (`autocomplete="username webauthn"`, a conditional request asked for on mount,
  `features/auth/usePasskeySignIn.ts`): the button aborts the pending autofill request before its own, the
  autofill asks again after a picked passkey failed or a timeout and is renewed before its 10-minute ceremony
  expires, and a passkey the server calls unknown is reported to the browser (`signalUnknownCredential`). A
  ceremony a button started and the browser ended with NotAllowedError says so quietly ("No passkey was used…",
  `lib/passkeys.ts#failureText`); `@simplewebauthn/browser` is loaded with the first ceremony (`import()`, ahead of
  time where a page offers one, `usePreloadedWebAuthn`), never in the entry chunk.
  Account settings → Security lists the passkeys (name, renamed in place; "Synced", "Not backed up" or "This
  device only"; added, last used; "Doesn't work here" with an explanation for another RP ID), adds one (re-auth
  first; the name proposed from the browser and system, `settings/passkeys.ts#proposedPasskeyName`), removes one
  (the last that works here of an account without a password says why it cannot go, as the server would;
  `signalAllAcceptedCredentials` afterwards), nudges an account without a password whose passkeys are all
  single-device (`suggestsAnotherPasskey`), offers "Remove password" with a passkey that works here (the
  server's 409 reasons shown in the card) and "Set password" to an account without one (re-auth first). The
  sessions list says which sign-ins used a passkey, the security log names the passkey events, and
  Administration → Users shows "Signs in with" (a password and the number of passkeys, and how many do not work
  here) and marks "Can’t sign in here" the accounts without a password none of whose passkeys works here, which
  `?orphaned=1` (the link of the overview's warning) lists alone.
- **Invitations in the app** (design §5.8.8, §12.9): a space's Settings → Invitations (admins and owners; the
  Members page has "Invite people") invites an address with a role (`canInviteRole`; admin invitations ask for
  the password first), mails it or, without mail, shows the link once with `ShareLinkField`, and lists the open
  invitations with "Send again" and "Revoke" (an admin invitation is an owner's). Refusals keep the form filled
  in: the address at the field, quotas and daily limits above it with what to do, an unverified inviter pointed
  at Account settings (with mail, said in place of the form before anything is sent, here and in Administration →
  Invitations). `/spaces` lists the account's own pending invitations (`GET /api/invitations`, instances
  with mail and a verified address) to accept or decline. Account settings → Profile changes the address
  (re-auth; with mail a confirmation link to the new address, without mail at once), sends a new verification
  link, and prompts an account from before email addresses to add one.
- **Space archive in the app** (design §12.10, §8): Settings → Data (owners) has "Download space archive"
  (`ensureReauth()`, then the plain GET of `api/importExport.ts#exportUrl`), "Import a space…" and "Replace this
  space". An import into a new space runs on `/spaces/import` (also from /spaces): choose the file, which the
  browser checks first (`features/import/archiveFile.ts`: gzip unpacked with `DecompressionStream`, at most
  `instance.limits.importMaxBytes` packed and unpacked; v1 or v2; the frame, then each row through
  `parseBounded`, the first 5 problems listed; a file that is no JSON object at all, "This is not a Lyren Plan
  archive (.json.gz) or 1.x export (.json)."), name the space (the archive's name by default), Continue (`POST
  /api/spaces {forImport: true}`, then analyze; `?space=<id>` keeps the page on that space, which /spaces lists as
  "Import not finished" with Continue and Discard, and `/s/<id>/…` of an importing space leads there; a refusal
  after Continue says that the space waits for an archive, not that nothing was changed), map the people, Import,
  and the result. The mapping step (`MappingStep`, `mapping.ts`) has a row per person the
  archive names (name, address, how many tasks, comments, work logs and activity entries name them) with a
  picker and its filter box: "Keep as former member (name only)", "<name> (you)", then the candidates with their
  addresses, preselected from the suggestions; Import waits until everyone is mapped and the estimate fits
  `limit` and `dailyLeft`, offering "Import without the activity history" when that makes it fit, and saying
  either limit otherwise ("has reached today's import limit" only when nothing is left of it, else what is left,
  and to try again after 00:00 UTC when that is all that stands in the way). Replace this space (`ReplaceSpace`)
  asks for the re-auth window, analyzes with `mode=replace`, shows the same step, "Download the current data
  first" (on Cloudflare, where the server keeps no copy, Replace stays disabled until it was used for this
  analysis: a second replace needs a download of what the first wrote) and the typed `REPLACE` confirmation; the
  result names Node's snapshot and, for instance admins, the command that undoes the import, whole, to copy (the
  desktop app's own program with the data it opened; else `DATA_DIR=/path/to/data node dist/server.mjs restore
  "<path>"`, with the Docker form under it). A result's
  `nonMemberAuthors` get "Invite them to this space": Settings → Invitations opens with a prefilled form for
  each (router state, `importResult.ts#invitesFromState`). Comments, work logs and activity entries an import
  or a reassignment attributed to their author say "Imported by <importer> on <date>"
  (`features/timeline/ImportedNote.tsx`, `lib/people.ts#importedText`), with "Not yours?" on the viewer's own;
  that, and the Members page's "These entries aren't mine…", disowns them (`POST …/people/me/disown`, after a
  confirmation). Members → Former members has "Reassign…" for admins (`features/settings/authorship.tsx`: a
  member to move the person's entries to, `POST …/people/:personId/reassign`).
- **Dashboard**: tiles and section badges show `DashboardDTO.counts` (exact totals) and "Across N projects"
  `inProgressProjects`. A section shows 5 rows, then all rows of its list; when `counts.x` exceeds the capped
  list, expanding loads the whole section once (`useFullSection`: POST /api/tasks/query with the section's
  filter, limit `LIMITS.queryLimitMax`, sorted by `compareDashboardTasks` = the server's dashboard order) and
  renders it 200 rows per "Show N more". (Paging through the server's sort would not be a prefix of the
  dashboard order.) A failed load keeps the rows shown and offers Retry.
- **Command palette**: archived tasks (search results and Recent) carry an "Archived" label. The Recent list
  (localStorage, `features/search/recent.ts`) is read once per opening and refreshed from the server with one
  `POST /api/tasks/query { filter: { ids, archived: 'include', includeArchivedProjects: true } }`: labels,
  refs and titles follow the server, and tasks it no longer returns (deleted) are dropped, in storage too.
- **Editing text**: the task description saves on blur, mod+Enter and Esc; only its Cancel button discards
  (asking when changed). Closing the drawer (Back, ←, ×, another task) while editing an existing comment or
  work-log entry saves the edit; only Cancel (or Esc in a comment) discards it, and a changed comment asks first.
- Keyboard shortcuts: `c` new task (not for viewers), `mod+k` and `/` search, `?` shortcuts help, `Esc` close (top
  overlay).

### 9.1 Cross-team component contracts
- `MenuItem` (components/ui/Menu): `{ label: string; icon?: ReactNode; onSelect?: () => void; danger?: boolean;
  disabled?: boolean; checked?: boolean; hint?: string; items?: MenuItem[] } | { separator: true } | { heading: string }`;
  `<Menu trigger={ReactElement} items={MenuItem[]} />` — anchored dropdown ≥ md, bottom action sheet on touch.
- `PageHeader` (components/layout): `{ title: ReactNode; subtitle?: ReactNode; icon?: ReactNode; backTo?: string;
  breadcrumbs?: {label, to?}[]; actions?: ReactNode; menu?: MenuItem[]; tabs?: {to, label, end?, count?}[] }`.
- `Dialog`, `Drawer`/`Sheet`, `useConfirm()` (`(o: {title, body?, confirmLabel?, danger?, typeToConfirm?}) =>
  Promise<boolean>`), `EmptyState {icon?, title, body?, action?}`, `ErrorState {error, onRetry?}`,
  `Skeleton`, `Spinner`, `Markdown {source}`, `MarkdownEditor {value, onChange, onSubmit?, onCancel?, placeholder?}`,
  `toast` — documented in components/ui/README.md.
- Domain (components/domain/README.md): `TaskCard {task, fields?, density?, colorBy?, onOpen?, extraMenuItems?, selected?, dragging?}`
  (React.memo); `TaskRow {task, hide?, fields?, onOpen?, selectable?, selected?, onSelectedChange?, extraMenuItems?}`
  (React.memo); `useTaskActions(task, extra?) → MenuItem[]` + `TaskActionsMenu {task, extraItems?}` (Status ▸,
  Priority ▸, Move to project/epic ▸, Due ▸, Tags…, Duplicate, Archive, Delete) — the shared non-drag
  alternative; pickers `StatusPicker`, `PriorityPicker`, `TagPicker {allowCreate}`, `EpicPicker {projectId}`,
  `MilestonePicker {projectId}`, `ProjectPicker`, `DateField`; display `StatusIcon`, `PriorityIcon`, `TagChip`,
  `ProjectBadge`, `EpicBadge`, `DueDateLabel`, `ProgressBar`.
- Timeline (features/timeline): `TaskTimeline {task}` (segmented: Comments (default) · Work log · History, with
  counts, sticky composer), `ActivityFeed {projectId?, limit?, compact?, paginate?}`, `ActivityItem {entry,
  compact?, showTask?, showProject?}` (the dashboard and the activity feeds render entries with it; it and the
  task History panel build their sentences from `activityPhrases` in activityText.ts) and pure
  `describeActivity(entry, lookups): string` (a unit-tested plain-text helper; no page uses it).
- Tasks (features/tasks): `TaskList` (props in its file), `TaskDrawerHost`, `TaskCreateDialogHost`, `TaskPage`.
  TaskList's toolbar has per-list "Show closed" and "Show archived" toggles (seeded from the filter, not
  persisted; below the 44rem container they read "Closed" / "Archived" and wrap onto their own line when the
  buttons don't fit). An empty list says when everything in it is closed or archived and offers to show it
  (toolbar-less lists too). `useBulkTaskActions(tasks, { onDeleted })` (features/tasks/bulkActions.tsx) is the
  one bulk menu — status, priority, due date, Set epic (single-project selections), add/remove tags,
  Archive/Unarchive (each only on the tasks it changes), Delete — used by TaskList's `BulkActionBar` and by a
  board's select mode.
- Boards (features/boards): `ProjectBoardPage` (route), `BoardView` used internally.

---------------------------------------------------------------------------------------------------------

## 10. Testing & verification (every agent)

- Typecheck your area: `npx tsc -p tsconfig.server.json` and/or `npx tsc -p tsconfig.web.json`, and
  `npx tsc -p tsconfig.worker.json` for server code that also runs on Cloudflare (`server/src` except
  `index.ts`, `sea.ts`, `cli.ts`, `config.ts`, `desktop/` and `runtime/node/`; there, encode bytes with
  `core/crypto.ts` instead of `Buffer#toString`). Other agents work in parallel, so errors in files you don't
  own may appear — ignore those, but your files must be clean.
- Two vitest projects (`vitest.config.ts`), both offline: `node` (`shared`, `server/test`, `web/src`,
  `scripts/test`) and `workers` (`server/test-workers`, run inside workerd from
  `server/test-workers/wrangler.test.jsonc`). Pick one with `--project node` / `--project workers`. In the node
  project NodeDb's portability checks are on (they also run with `LYREN_DB_STRICT=1`): SQL a Durable Object
  would reject or run differently throws (more than 100 parameters, `BEGIN`, `PRAGMA user_version`, `LIKE :param`,
  `INSERT OR ROLLBACK`, `last_insert_rowid()`, a 6-term `UNION`, …; design §9.4); Node-only
  maintenance SQL goes through `db.raw`. The Db contract (`server/test/contract/db.contract.ts`), the space
  service suites (`server/test/contract/services.*.contract.ts`, each given a `WithSpaceDb` that runs a body on a
  fresh space database) and the statistics' equivalence test against the queries they replaced
  (`contract/stats.contract.ts`) run on both: the node files of the same names are thin wrappers, and
  `server/test-workers/{db.contract,services,stats}.test.ts` run them on `DoDb`. `server/test-workers/cost.test.ts`
  is the rows-read budget of design §11.2 (`--reporter=verbose` prints its measurements).
  Each `workers` run makes wrangler write a debug log to `~/.config/.wrangler/logs`; for hermetic runs set
  `WRANGLER_LOG_PATH` to a temporary directory (and `WRANGLER_SEND_METRICS=false`). The workers tests that go
  through the real Worker and Durable Objects (`SELF.fetch` to `https://plan.example.com`) share
  `server/test-workers/support.ts`; `entry.ts` counts the calls that reach each object. The workers project's
  global setup (`server/test/support/smtpGlobalSetup.ts`) starts fake SMTP servers in Node on 127.0.0.1 for
  `server/test-workers/smtp.test.ts` (ports and certificates through `provide`/`inject`); the SMTP tests make
  their TLS certificates with `openssl` at test time (`server/test/support/testCerts.ts`; never committed) and
  skip the TLS cases, saying so, without it. The mail tests send through the recording transport
  (`server/test/support/mail.ts`: `outbox`, `failWith`, `hold`; `linkToken(message)` reads a link's token).
  The account flows have a file each in `server/test/directory/` (signup, reset, emailChange, invitations,
  adminResetLink, recovery, tokens, the §5.3 matrix in policy.test.ts, and enumeration.test.ts, which checks that
  an address with and one without an account get the same answer and run the same statements), and so does the
  instance administration (adminOverview, adminUsers, adminSpaces; `server/test-workers/admin.test.ts` through
  the Worker). The gateway table
  (`server/test/gateway/cases.ts`) runs on both runtimes. `npm run check:cf` bundles the Worker the way a deploy
  would (`wrangler deploy --dry-run`, offline, with the instance configuration when there is one) and leaves the
  result in `dist/worker`. `scripts/test/deploy-cloudflare.test.mjs` reads the deploy workflow with a strict
  YAML-subset reader (`scripts/test/support/workflow-yaml.mjs`) and runs `write-secrets-file.sh`;
  `scripts/test/cf-wrangler.test.mjs` runs `scripts/cf/wrangler.mjs` against a fake Wrangler that records what it
  would get; `scripts/test/wrangler-config.test.mjs` pins `wrangler.jsonc` and runs the pinned Wrangler offline
  against the build command's guard.
- Server: API tests for every endpoint you own — happy paths, validation (400), not found (404), conflicts,
  activity entries written, edge cases from §5. `npx vitest run server/test/<yours>.test.ts`.
- Web: unit tests for non-trivial pure logic (`*.test.ts` next to it, node environment).
- **Do not** run `npm install`, `npm run build`, or write into `dist/`. To check a web build, use
  `npx vite build --config web/vite.config.ts --outDir <your scratch dir>/web-build --emptyOutDir`.
- If you start a server for manual testing, use your own `PORT` and `DATA_DIR` (in your scratch dir) and stop
  it. First-run setup needs the setup code printed in the server log (or set `SETUP_TOKEN=test`).

## 11. Sample data (`createSampleData`)
Project "Website Relaunch" (key WEB, active): milestones "MVP launch" (active, due today+21) and
"Post-launch polish" (planned, due today+60); epics "Design system", "Content migration" (MVP),
"Performance" (polish), "Analytics" (no milestone); ~16 tasks across all statuses, priorities and due
dates (some overdue, some due today/this week), tags `bug`, `idea`, `blocked`, `quick win`; a few comments
and work logs; activity entries for creations. Project "Personal" (key ME): 4 tasks without epics.
A project board "WEB board" for WEB (columns by status, swimlanes by epic) and a global board
"Priority triage" (columns by priority, swimlanes by project, hide closed after 7 days).

## 12. Deployment
- `npm ci && npm run build && npm start` → http://localhost:8080. Env: see `node dist/server.mjs help`. A
  single-file desktop app is built from the same sources (§12.1).
- `dist/` is self-contained (server bundle + web assets); only Node ≥ 22.13 is needed at runtime.
- **Node.js release archive** (`npm run package:node` = `scripts/pack-node.mjs [--no-build]`, helpers in
  `scripts/lib/node-tarball.mjs`): `dist/lyren-plan-<version>-node.tar.gz` + `.sha256` (`<hex>  <name>`). One top folder
  `lyren-plan-<version>/` with `server.mjs` and `web/` only, every `*.map` left out; written by its own ustar writer:
  each folder before its contents, names in byte order, uid/gid 0 (`root`), dirs 0755, files 0644, one mtime
  (`SOURCE_DATE_EPOCH`, else the mtime of `dist/server.mjs`), padded to 10240 bytes, gzip level 9 with mtime 0 and OS
  3; only regular files and folders (a symlink is refused); names over 100 bytes use the ustar prefix. Refused unless
  `node dist/server.mjs help` prints `Lyren Plan <package.json version>` (a stale `dist/`). The archive is read back and
  checked before it is written. `docs/ubuntu-server.md` installs it on Ubuntu 26.04 (`/usr/bin/node` from the
  `nodejs` package, `/opt/lyren-plan/lyren-plan-<version>` + `current` symlink, user `lyren`, `StateDirectory=`
  `/var/lib/lyren-plan`, sandboxed unit, backup service + timer); README's systemd, backup, restore, upgrade and
  reset-password examples use the same paths. When
  `WEB_DIR` is set but has no `index.html`, the server logs "Web client not found: no index.html in <dir>"
  (and keeps serving the API), and app routes answer 503 with a short self-contained HTML page saying so
  (no paths in it); a later build is picked up without a restart.
- Start-up failures a self-hoster can fix are printed as plain lines, not stack traces (`startupErrors.ts`): an
  invalid env value (exit 2), a database that can't be opened for permission reasons (path, uid and a
  `chown` hint: the Docker bind mount's only in a container, `LYREN_CONTAINER=1` in the image, `/.dockerenv` or
  `/run/.containerenv`, else for this user and folder, or, when the folder's `mkdir` was refused, the nearest
  existing folder above it and an `install -d -o <uid> -m 700` hint; exit 1), a data directory that can't be created because its drive or a parent is missing
  (ENOENT) or a file stands in the way (EEXIST/ENOTDIR, naming the file; `fileInTheWay`), a Windows path too
  long for SQLite (CANTOPEN with a folder of ≥ 248 characters; exit 1), and listen errors (port in use,
  privileged port, bad HOST; exit 1). Only unknown causes (a failed migration, a corrupt file) add the stack. A
  space's file the server cannot open or write (its owner or mode, a read-only disk) answers 503 "The server cannot
  open this space's data; its log says why." and the log explains it once, as above, until the file opens again.
  `LOG_REQUESTS` lines carry Hono's colours only on a terminal without `NO_COLOR` (journald, `docker logs` and
  files get plain text).
- **First run**: the server prints a one-time **setup code** to its log (or use `SETUP_TOKEN`); the setup
  page asks for it, so a freshly exposed instance can't be claimed by someone else.
- **Passkeys** (design §5.6, Appendix B): on when `PUBLIC_URL` is an https origin (or `http://localhost`) whose host
  is a name, so the desktop app (127.0.0.1) and installs reached by a LAN address stay password-only. The RP ID is
  `WEBAUTHN_RP_ID` (the host or a parent domain of it with at least two labels, never `workers.dev` or
  `pages.dev`) or the host; a value that does not fit, or one set while passkeys are off, stops the start (exit 2;
  on Cloudflare the API answers 503 with the reason). Passkeys belong to their RP ID: a later move to another
  host orphans them, and the start-up log (on Cloudflare the hourly maintenance's log) and Administration → Overview
  count the accounts that can then only sign in with passkeys that do not work; Administration → Users lists them
  (create reset links for them; the `reset-password` command on Node, the recovery token on Cloudflare for an
  administrator's account).
- **Mail** (design §5.10, Appendix B; README → Configuration): `MAIL_TRANSPORT=log` by default, the desktop
  app included: nothing is sent, and each message is one log line naming its template and the recipient's
  domain (`MAIL_LOG_BODIES=1`, development only, prints the text part, links included, so the flows that need a link
  work, `open` sign-up included, and is warned about unless `PUBLIC_URL` is on this machine; always on Cloudflare). `smtp`, `resend` and `cloudflare` need `MAIL_FROM` (an address) and
  `PUBLIC_URL` (the links); `MAIL_FROM_NAME` (default `INSTANCE_NAME`), `MAIL_REPLY_TO`, `MAIL_DAILY_CAP`
  (200). SMTP: `SMTP_HOST`, `SMTP_SECURITY` `tls` (implicit, port 465, the default) or `starttls` (587; the
  server must offer it) — the certificate is always verified against `SMTP_HOST` — or `none` (25), only for a
  mail server on this machine (`localhost`, `127.x.x.x`, `[::1]`) and without credentials; `SMTP_USER` and
  `SMTP_PASS` together (AUTH PLAIN, or LOGIN, only over TLS); `SMTP_EHLO_NAME` (default the host of
  `PUBLIC_URL`). Resend: `RESEND_API_KEY`. Cloudflare: a `send_email` binding named `EMAIL`. A bad value stops the
  start with the variable's name (exit 2); `SMTP_PASS` and `RESEND_API_KEY` appear in no message, log line or
  API answer. Messages are multipart text and HTML, `Auto-Submitted: auto-generated`, with no images or tracking;
  subjects hold no user text, names people chose are cut and replaced by neutral text when they look like
  links or addresses. Each message counts on `mail:<UTC day>` (`MAIL_DAILY_CAP`), the ones anonymous requests
  cause (sign-up, forgot password, the failed sign-ins' notice) also on `ma:<day>` (40% of it), and every one
  but the security notices on `mr:<address>` (5 a day); a forgot request for an address without an active
  account counts as its message would. One over a budget, or one the transport fails, is dropped with a log
  line and a `mail_failed` security event of the recipient's account (none for an email change's message to
  the new address). The SMTP client refuses a reply over 64 KiB or 512 lines.
  Invitations and the admin's test message are sent at once, everything else after the response.
- Docker: multi-stage `Dockerfile` (node:24-alpine), volume `/data`, non-root user (uid 1000), healthcheck on
  `/api/health`. Bind mounts need `chown 1000:1000` (or `user:` in compose).
- Behind a TLS reverse proxy set `TRUST_PROXY=true` (secure cookies + real client IPs from the RIGHTMOST
  X-Forwarded-For entry) and publish the port only on localhost (`127.0.0.1:8080:8080`) so clients can't
  bypass the proxy.
- Data layout (design §3.1, §9.2): `DB_PATH` (default `DATA_DIR/lyren.db`) is the directory (accounts, sessions,
  spaces, memberships); each space is `spaces/<id>.db` next to it (`<file name>.spaces/` for a `DB_PATH` not named
  `lyren.db`), kept open in an LRU of `SPACES_OPEN_MAX` (32); both are marked `user_version = 100`, so builds from
  before the split refuse them.
- Backups (design §9.5, `runtime/node/backupSet.ts`): a backup set is one ustar file holding `lyren-backup.json`
  (the manifest: format, version, createdAt, appVersion, the directory's and each space's file, schema version and
  size), `directory.db` and `spaces/<id>.db` for every space the directory lists (active, importing, and deleted
  within the grace period). An instance admin downloads one (`GET /api/admin/backup`, Administration → Overview; off with
  `ALLOW_ADMIN_BACKUP_DOWNLOAD=false`), or `node dist/server.mjs backup <file>` writes one (safe while running; e.g.
  `docker exec lyren-plan node dist/server.mjs backup /data/backups/x.tar` from cron; a name ending in `.db` still
  works and gets the note "Note: the backup is a .tar backup set; name it .tar"). Each database in it is a consistent
  snapshot; the directory is taken first and the spaces are those it lists (a space whose file is missing fails the
  backup, exit 1). Sessions, device tokens, sign-in tokens, passkey challenges, throttle counters and open
  invitations are left out.
- Restore (design §9.6, `runtime/node/restore.ts`): `node dist/server.mjs restore <file|->` stages a backup set, one
  space's database (a pre-import or space-v<N>-before-upgrade snapshot; its space must be one the current directory
  lists and has not purged, else "This space no longer exists here") or a 1.x database, told apart by content; a
  directory file alone ("This is only the directory of a backup; restore the .tar backup set"), anything else, damaged
  databases (`quick_check`) and data from a newer build ("This backup was made by a newer version of Lyren Plan.
  Install that version, or a newer one, to restore it.") are refused before anything is staged, and so is every
  restore while DB_PATH still holds a 1.x database (the §3.8 message below), or while the folder of DB_PATH has less
  free space than the staged copy plus 64 MiB ("Not enough free disk space to restore this backup: about <n> MB are
  needed in <folder>, <m> MB are free. Nothing was staged."). `-` reads standard input into
  `.restore-<16 hex>.in` in the data folder first (a refusal then names "Standard input", not that copy); a relative
  name that is not in the working folder (or that this user cannot reach there) is looked up in the data folder (the
  import's `backups/spaces/<id>/pre-import-….db`); a file this user cannot read gets "<file> cannot be read as this
  user (<name>): pipe it in with `restore -` (see the README)." (exit 1). The staging folder is DB_PATH's:
  `.restore-pending/` next to `lyren.db`, `.<file name>.restore-pending/` next to any other name. Staging extracts (or
  copies with `VACUUM INTO`) into a folder of its own, `.restore-<16 hex>.partial/` (`directory.db` + `spaces/`,
  `spaces/<id>.db`, or `legacy.db` with its sign-in sessions deleted), sets every staged space's `_meta.sync_version`
  to 0 (its mirror syncs at its first request), fsyncs, writes `READY` (DB_PATH's file name, the build, the kind, the
  stamp, the manifest or space) and renames the folder to the staging folder; then prints "Restart Lyren Plan to
  complete the restore (systemctl restart lyren-plan, or docker restart lyren-plan)." plus, when there is current data,
  " The current data will be moved to backups/before-restore-<stamp>/." (desktop: "Quit Lyren Plan and start it again
  to complete the restore."). The next serving start (`openNodeStack` mode 'serve', the desktop app after its instance
  lock) applies it before anything is opened, under a lock of its own (an exclusive SQLite lock on `APPLYING` in the
  staging folder, which ends with the process; another start at the same moment waits for it like the lock on
  DB_PATH, then stops with the message that follows and moves nothing, or finds the restore applied): an exclusive
  lock on DB_PATH proves nobody else uses the data ("Lyren Plan is still running with this data folder. Stop it,
  then start it again to complete the restore.", exit 1; DB_PATH is opened by the `file:` URI with `mode=rw` where
  node:sqlite takes URIs, so it is never created, and on Node 22.13 by name, the empty file SQLite creates when
  DB_PATH was moved away a moment before being removed again); before anything moves, every staged database must
  be there and be one this build can use ("The staged restore in <folder>
  is incomplete. Delete that folder, then run restore again." / "… was made by a newer version of Lyren Plan. Install
  that version, or a newer one, to complete it, or delete that folder to cancel it.", exit 1); `PHASE` moving-out
  moves DB_PATH (+ `-wal`/`-shm`/`-journal`) and the spaces folder (one space: its file) to
  `backups/before-restore-<stamp>/` (never pruned), moving-in puts the staged files in place (a `legacy.db` becomes
  DB_PATH, and the legacy upgrade then runs), each move skipping what is done, so an interrupted apply finishes at the
  next start; `READY` is deleted first, then the folder (when that fails, "Could not remove <folder> (<code>); the next
  start removes it." and the start goes on). While `READY` exists every maintenance command (`backup` and `restore`
  included) stops with "A restore is waiting: restart Lyren Plan to complete it, or delete <staging folder> to cancel
  it.", and once the apply has begun (`PHASE` exists) with "A restore was interrupted while it was being applied:
  start Lyren Plan to finish it. Do not delete <staging folder>; the data it replaces is in
  backups/before-restore-<stamp>/." (exit 1). Restore by hand: stop the server, move `lyren.db*` and `spaces/` away,
  extract the set as the service user, put `directory.db` as `lyren.db` and `spaces/` in place, start; a space whose
  file holds a newer `_meta.sync_version` than the directory syncs its mirror at its first request all the same.
- Other maintenance commands: `promote-admin <email-or-username>` sets `is_instance_admin = 1`; `policy
  [open|invite_only|closed]` prints or sets `instance_settings.signupPolicy` (`open` refused while sign-up links
  cannot be mailed: no transport that delivers mail and no `MAIL_LOG_BODIES`, exit 1); a promotion and a policy change are security events without an actor (`data.via: 'cli'`),
  listed in Administration → Overview; `spaces` prints a table of every space (id, status, name, owners' emails or usernames, the
  size of its database with its `-wal`, as Administration → Spaces shows it); an unknown account lists up to 20 (as reset-password); `help` lists the commands and the variables by group
  and ends "See README → Configuration.". Usage errors exit 2, failures 1. Before touching any file the server, the
  desktop app and every command but `help` run the owner check (`runtime/node/owner.ts`, design §9.2): as root
  (`process.getuid() === 0`) on a data folder (the folder of DB_PATH) another uid owns, they stop with "Run this as the
  owner of <folder>, for example: sudo -u <name> …" (exit 1; the name from /etc/passwd, else `#<uid>`); Windows has no
  check.
- Upgrading: pull/build/restart (`docker compose build --pull && docker compose up -d`); migrations run
  automatically on start after writing a snapshot (`directory-v<N>-before-upgrade-<timestamp>.db` in `backups/`
  next to the directory file, `space-v<N>-…` in `backups/spaces/<id>/`); a build refuses data from a newer one. A
  1.x database (one file, no `_meta`, `user_version` 1) is upgraded by the first start of the server or the desktop
  app (design §3.8, `runtime/node/legacy.ts`), as its only user (it stops with "Lyren Plan or another program still
  has <DB_PATH> open. Stop it and start Lyren Plan again." while anything else has the file open, and leaves a file
  that another start upgraded meanwhile to the normal open): a snapshot
  `backups/lyren-v1-before-upgrade-<timestamp>.db`, then a space "<owner's display name>'s space" with every row and
  id, and a directory with the same accounts (the lowest id an instance admin, the 1.x preferences the owner's),
  their unexpired sessions (signed-in browsers stay signed in) and `legacySpaceId`; an interrupted upgrade is redone
  from the 1.x file at the next start. A start or command that finds the directory file held by another connection
  (another start upgrading it, or switching a restored file to WAL) stops with that same message (exit 1): at once
  at its first, read-only look, and after the busy timeout (5 s) when it opens and migrates the file. Maintenance
  commands never upgrade: on a 1.x file `backup` writes the old
  single-file backup (sessions removed) with "Note: this data has not been upgraded yet, so this is an old-format
  backup. Lyren Plan upgrades the data the next time it starts.", and every other command stops with "This data has
  not been upgraded yet. Start Lyren Plan once with this version, then run the command again." (exit 1).
- Snapshot retention (`db/snapshots.ts`): after writing an automatic snapshot, keep the newest `SNAPSHOT_KEEP`
  (default 10; 0 = keep all) of that kind in its folder — pre-import and each pre-upgrade kind counted separately
  — and delete the rest. Only regular files whose whole name matches the kind's pattern are candidates (user backups, renamed
  copies, symlinks and directories are never touched); the new snapshot always stays; "newest" is the
  timestamp in the name; failures are logged and never fail the import or the start-up.
- Lost password: `node dist/server.mjs reset-password <email-or-username>` (prints a random password, or pipe one
  in; a piped password must have the instance's minimum length (8 by default) to 256 characters, else exit 2 and
  nothing changes; an unknown account lists up to 20). One transaction: the new hash, `password_changed_at`,
  `auth_epoch + 1`, the account's sessions and device tokens deleted, and the lock-outs cleared (the account's
  `lid`/`lda` counters and every address's `li`, `ln` and `lg`), also for a running server.
  Without a shell (and on Cloudflare): an instance admin creates a reset link for another account
  (`POST /api/admin/users/:userId/reset-link`; mailed to a verified address, else handed to the admin for 24
  hours; never for an admin's account, nor for one demoted less than 30 days ago or not signed in since), and an
  operator locked out of every admin account sets `RECOVERY_TOKEN` (at least 32 characters) for a while and
  posts it with the account to `POST /api/auth/recover` (the page `/recover`; README and docs/cloudflare.md
  "Locked out"), which returns a reset link and makes the account an instance admin when no active one is left
  (`RecoveryLinkDTO.madeAdmin`; design §5.8.11, §5.8.19).
- File permissions: `index.ts` (and `sea.ts`) set `process.umask(0o077)` for the server and every CLI command, and the DB
  layer creates its directories with mode 0700, so DATA_DIR, spaces/, backups/, the databases, WAL and snapshots
  are owner-only (a space file is created 0600).
  On Windows modes are ignored and a new folder inherits its parent's ACL (a drive root grants Users read and
  Authenticated Users modify). The desktop app therefore gives the folder of the database a protected DACL when
  it creates it (`desktop/folder.ts`: `icacls <dir> /inheritance:r /grant:r *<user SID>:(OI)(CI)F
  *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F`, SID from `whoami /user`, both by absolute path, no shell; a
  failure, e.g. FAT, is a banner warning). An existing folder is never changed: when its SDDL (`icacls /save`)
  has an allow ACE with read/write/generic/full rights for Everyone, Users, Authenticated Users, Interactive,
  Domain Users or Guests, the banner warns and prints the icacls command that makes it private (for Command
  Prompt, a trailing backslash doubled; for PowerShell, single-quoted (`psArg`, a trailing backslash doubled when
  the path has whitespace), when the path has a `%`: `commandShell`, see `stop`; measured: icacls accepts both the
  single trailing backslash 5.1 then hands it and the doubled one PowerShell 7 would). icacls is not long-path aware (measured: a folder path of 259 characters works, 260 fails, and `/save`
  then exits 0 with an empty file), so a path of MAX_PATH (260) characters or more is passed, and printed, as
  `\\?\<path>` (`\\?\UNC\<server>\<share>\…` for a UNC path; `icaclsPath`); an empty `/save` gives no verdict.
- Static serving (`http/static.ts`): one handler over a `StaticSource` — `diskSource(webDir)` (dist/web or
  WEB_DIR; unhashed files re-validated by mtime, no ETag) or `memorySource(files)` (the embedded client; strong
  ETag per file, `<etag>-gz` for the gzip body, If-None-Match → 304). Same rules for both: `/assets/*`
  `public, max-age=31536000, immutable`, everything else `no-cache`; gzip for text files > 1 KiB with
  `Vary: Accept-Encoding`; HEAD = GET headers without body; extension-less unknown paths → index.html; other
  unknown paths 404; only canonical paths are looked up; the missing-client 503 page. The disk cache is keyed
  by resolved path, case-folded on win32/darwin, and on Windows paths the file system would rewrite (trailing
  `.`/space in a segment, `:` streams) or that may be an 8.3 short name (any `~`) are never looked up, so URL
  aliases can't grow it. A web folder at a drive or file-system root (`W:\`, `/`) works (the root already ends
  with the separator).
- Windows file-system rules (all code): never rename over or delete a file that may be open (SQLite opens
  without FILE_SHARE_DELETE); the backup download's snapshots (`DATA_DIR/.backup-<16 hex>/`) are deleted once its tar
  (`DATA_DIR/.backup-<16 hex>.tar`) is written, the tar is unlinked while Node holds it open (allowed: libuv shares
  delete access) and again on stream close, and anything a crash left is deleted at the next start
  (`removeStaleBackupTemps`, at a serving start only: a maintenance command may run beside a backup); a space's files are deleted only after its database is closed; snapshot pruning tolerates EBUSY/EPERM (logged,
  retried at the next prune); `VACUUM INTO` targets are bound parameters (any path, spaces, non-ASCII); state
  files are rewritten in place; piped passwords lose one trailing LF or CRLF and a leading BOM, and must be
  valid UTF-8 (cmd.exe pipes in the OEM code page): otherwise `reset-password` changes nothing and exits 2
  with a `chcp 65001` hint (on win32 a piped password containing `?` gets a PowerShell 5.1 warning). SQLite
  gets `\\?\` paths on win32 (`runtime/node/nodeDb.ts` `sqlitePath`: the databases, backup copies, `VACUUM INTO`
  targets), because its VFS passes names to CreateFileW unchanged and MAX_PATH (260) would otherwise break
  long data folders and the snapshots in them.

### 12.1 Single-file desktop app

- **Build**: `npm run package:win` (`scripts/package.mjs --target win-x64`; also `win-arm64`, `linux-x64`,
  `linux-arm64`; `npm run package:linux` = linux-x64) → `dist/lyren-plan-<version>-<target>[.exe]` + `.sha256`.
  Steps: `npm run build` (unless `--no-build`); esbuild bundles `server/src/sea.ts` as ONE CommonJS file
  (format cjs, no top-level await, no import.meta, no warnings allowed; SEA's require() loads built-ins only);
  every dist/web file except `*.map` becomes SEA asset `web/<path>` plus `lyren/manifest.json`
  (`{format:1, version, builtAt, files:[{path,key,size,sha256,etag}]}`); `sea-config.json` with
  `useSnapshot:false, useCodeCache:false` (portable blob), `disableExperimentalSEAWarning:true`,
  `execArgv:["--disable-warning=ExperimentalWarning"]`, `execArgvExtension:"none"` (NODE_OPTIONS ignored); blob
  from `node --experimental-sea-config` of the running Node (= target version); official node binary of that
  version from nodejs.org (or `LYREN_NODE_MIRROR`), SHA-256 verified against `SHASUMS256.txt`, cached in
  `.cache/node/<version>/`, or `LYREN_NODE_BINARY` (+ optional `LYREN_NODE_SHASUMS`) offline; Windows: strip
  the Authenticode signature (clear the certificate-table directory entry, truncate the table); inject with
  postject (`NODE_SEA_BLOB`, fuse `NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`); Windows: then set icon
  (scripts/lib/icons.mjs) and VERSIONINFO with resedit (after postject: resedit before it moves .reloc, which
  LIEF rejects), add `consoleAllocationPolicy` `detached` (xmlns `http://schemas.microsoft.com/SMI/2024/WindowsSettings`)
  to RT_MANIFEST 1 (`scripts/lib/manifest.mjs`: inserted as bytes, every other byte of node.exe's manifest kept
  (asInvoker, supportedOS, any windowsSettings); inside an existing `windowsSettings`, else in a new
  `<application xmlns="urn:schemas-microsoft-com:asm.v3"><windowsSettings>` before `</assembly>`; refused when
  already present; the image stays IMAGE_SUBSYSTEM_WINDOWS_CUI (3)) and recompute the PE checksum; Windows targets
  also embed `lyren/tray-icon.ico` (the app icon at 16, 20, 24, 32, 40, 48 px) as a SEA asset; Windows, optional: sign (below); self-test `help` when the
  target runs on the build host; then write `.sha256` (the old one is removed before the new exe is written, so
  a build that fails after that leaves none). Not part of `npm run check`; its pure helpers are (scripts/test).
  The SEA main script is `lyren-plan.cjs` and every sea-config path is relative to the work folder (the
  generator's cwd), so stack traces show `lyren-plan.cjs:<line>`; the build fails when the exe contains the
  checkout path or the home folder (either slash, UTF-8 or UTF-16; `buildPathNeedles`), checked before signing.
  `npm run build` runs as `node $npm_execpath run build` under npm (no shell), else as `npm run build` (on
  Windows one shell command string: no DEP0190) (`scripts/lib/npm-run.mjs`, also used by `scripts/dev.mjs`,
  which stops each npm's whole process tree, `taskkill /T` on Windows).
- **Signing** (`scripts/lib/sign.mjs`, Windows targets; Linux targets ignore it with a note):
  `LYREN_SIGN_CMD` = a command template run WITHOUT a shell: split at spaces/tabs, `"…"`/`'…'` group and are
  removed, no escapes (backslashes literal), or a JSON array of strings when it starts with `[`; `{file}` (the
  exe, required) and `{out}` (optional separate output, moved over the exe afterwards) are replaced in every
  word. Validated before the build starts; no error message quotes the value (it may hold a password: a JSON
  syntax error reports at most a character position, never V8's excerpt). A template whose program is cmd(.exe)
  is refused when the `{file}`/`{out}` path has one of `& | < > ^ % , ; =` (cmd.exe re-parses its command line);
  README recommends `powershell.exe -NoProfile -ExecutionPolicy Bypass -File sign.ps1 {file}` for scripts.
  Runs after the PE checksum update (stdio inherited); then
  `verifySignedImage`: a certificate table at the old end of file (8-byte aligned, zero padding only), holding a
  WIN_CERTIFICATE rev 2.0 / PKCS_SIGNED_DATA, and every byte before it unchanged except the PE checksum and the
  certificate-table directory entry; the SEA blob and the set fuse still present. Any failure fails the build:
  the unsigned bytes are written back over the exe and `{out}` is removed (a signer may have changed the file
  before failing), no `.sha256`. The self-test runs on the signed exe and `.sha256` is of the signed file.
- **Self-test** (`scripts/lib/self-test.mjs`): Windows targets are first checked to be PE images whose COFF
  Machine is the target's (0x8664 / 0xAA64), on every build host. The self-test passes on exit 0 with
  `Lyren Plan <version>` in stdout. On win32 a spawn error UNKNOWN/EACCES/EPERM with status null
  (`refusedToStart`) hides the Win32 error (libuv reports a policy block and a broken image, 216/193, alike as
  UNKNOWN), so `windowsStartError` starts the exe once more through Windows PowerShell and .NET
  (`Process.Start`, UseShellExecute off; path in an environment variable, script via -EncodedCommand) and reads
  `NativeErrorCode`. Only a policy error (`POLICY_BLOCK_ERRORS`: 1260, 4551, 4556-4559, 4580-4583), or
  "Device Guard" / "Application Control policy" text in the output, counts as a block, which is not a build
  failure: it prints why (unsigned, or signed but not trusted), keeps the exe, writes `.sha256` and exits 0, or 3
  with `--require-self-test`. Any other failure (another or an unknown Win32 error included) names the spawn
  error / signal / exit code, the Win32 error and the output (never "undefined"), writes no `.sha256`, exits 1.
- **Node binary verification** (`scripts/lib/node-dist.mjs`): the expected SHA-256 comes from
  `scripts/lib/node-hashes.mjs` for pinned versions (v24.19.0, all four targets; values from a SHASUMS256.txt
  whose signature was checked against the Node.js release keys), else `LYREN_NODE_SHASUMS`, else SHASUMS256.txt
  from `https://nodejs.org/dist` (cached as `SHASUMS256.nodejs.org.txt`), never from the mirror.
  `LYREN_NODE_MIRROR` is a transport only and must be https (http only with `LYREN_NODE_ALLOW_HTTP=1`). The
  cached download is re-checked every build and fetched again on mismatch; `LYREN_NODE_BINARY` is checked when
  its hash is known, else used with a warning. `LYREN_NODE_PINNED_ONLY=1` (`requirePinned`; any other non-empty
  value is an error) allows pinned versions only: package.mjs checks it before the build, `fetchNodeBinary` again,
  and an uncheckable `LYREN_NODE_BINARY` (a Linux target: the pinned hash is of the .tar.gz) is refused. `.nvmrc`
  is an exact version and must be pinned (a test checks it).
- **Releases** (`.github/workflows/release.yml`; README "Releases"): a pushed tag `v*` → build (ubuntu-24.04: the
  tag must equal `v` + package.json version, which must be `x.y.z` or `x.y.z-<prerelease>`; setup-node from
  `.nvmrc`; `LYREN_NODE_PINNED_ONLY=1`; `npm ci --ignore-scripts`, `npm run check`, `pack-node.mjs --no-build` with
  `SOURCE_DATE_EPOCH` = the commit time, `package.mjs --no-build` for win-x64 and linux-x64, after win-x64 `scripts/test/manifest.test.mjs` with `LYREN_TEST_REQUIRE_CACHED_NODE=1`
  (its official-node.exe case, which `npm run check` skips without `.cache/node`); artifact kept 7 days, 3 for a
  dry run), test-oldest-node (ubuntu-24.04, setup-node 22.13.0 = the `engines` minimum, a test keeps them equal;
  `npm ci --ignore-scripts`, `npx vitest run --project node`: the legacy upgrade of the 1.x fixture and the staged
  restores on Node 22.13's `node:sqlite`, with no previous release needed) → smoke-windows (windows-2025, `scripts/ci/smoke-windows.ps1` in PowerShell 7 and Windows PowerShell
  5.1: .sha256, `help`, serve with `--no-browser --data-dir --port` and every standard handle redirected to a file
  (console mode), `/api/health` with that version, `/`, `stop` exit 0, server exit 0, port closed; then the upgrade
  check below with the previous release's exe (`-PreviousExe`, else `SMOKE_PREVIOUS_RELEASE`, else `gh release
  download` of `lyren-plan-*-win-x64.exe` of the newest published release other than this version that has one, or
  `SMOKE_PREVIOUS_TAG`; skipped with a `::notice::` without one, or without gh or `GH_TOKEN`; with `-CrashPrevious`,
  the Windows PowerShell 5.1 run, the previous exe is ended with `Stop-Process -Force` and must leave `lyren.db-wal`,
  so the upgrade starts from a crashed 1.x database; only these steps get `GH_TOKEN`); the server is
  killed on any failure; refuses without `-Exe`, a new or empty `-WorkDir` and a free `-Port` outside 43770–43779,
  or with any other argument, and removes the app's variables (and `GH_TOKEN`, which only gh gets) for what it
  starts), and smoke-node (matrix: setup-node
  22.13.0 = the `engines` minimum on ubuntu-24.04, a test keeps them equal; apt `nodejs` on ubuntu-26.04, run as
  `/usr/bin/node`; `scripts/ci/smoke-node.sh [--node <node>] <archive> <work-dir> <port>`: `sha256sum -c`, every entry
  0/0 below `lyren-plan-<version>/`, no `.`/`..`, no `*.map`, has server.mjs and web/index.html, `tar -xzf
  --no-same-owner`, `help` = version, serve with `env -i` PATH/DATA_DIR/HOST=127.0.0.1/PORT from another cwd,
  `/api/health` with that version, `/` text/html + its script, setup code in the log, `backup backup.tar` while
  running with `tar -tf` listing `lyren-backup.json` and `directory.db`, SIGTERM → exit 0, `Received SIGTERM`, port
  closed, no `-wal`; `restore backup.tar` ("Staged the restore of the backup set made …", `.restore-pending/READY`),
  the next start logs "Restored the backup set made … The data it replaced was moved to backups/before-restore-…/."
  and leaves no `.restore-pending`, the old `lyren.db` in `backups/before-restore-*/`; then the upgrade check (design §9.9) with the previous release's archive
  (`SMOKE_PREVIOUS_RELEASE`, else `gh release download` as above, of the newest release with a
  `lyren-plan-*-node.tar.gz`): it sets up an account by username, a project UPG
  and the task UPG-1 (`SETUP_TOKEN` given) and is stopped, leaving `lyren.db` alone; this build's first start logs
  the upgrade line naming `spaces/<id>.db` and the `lyren-v1-before-upgrade-*.db` snapshot, both exist, the old
  username and password sign in, `/api/s/<id>/projects` has UPG and `…/tasks/ref/UPG-1` the task; the previous
  release then refuses the data (exit ≠ 0, "is newer than this build supports", within 30 s) and leaves `lyren.db`
  and the space file unchanged (sha256). A previous release whose setup wants an email (one with spaces) skips the check
  with a notice. Both workflow jobs get `GH_TOKEN` (the read-only token) and `GH_REPO`; refuses a used or reserved
  port (8080, 43770–43779) and a work dir that is not new/empty; kills the server on failure) → release (contents: write;
  `scripts/ci/publish-release.sh`: checks the three .sha256 files (exe, linux binary, Node.js archive), writes
  SHA256SUMS (three lines), seven assets, `gh release create --verify-tag
  --generate-notes` with a notes header, prerelease when the version has `-`; a draft for the tag by
  github-actions[bot] is deleted first, any other draft stops it; a published release is never changed: same asset
  names and SHA-256 digests → success, else an error; replacing one = delete the release, keep the tag, re-run,
  impossible with immutable releases, whose tags can't be reused). `workflow_dispatch` = build + smoke tests + a
  notes preview in the job summary, nothing published. Top-level permissions `contents: read`; only actions/*,
  pinned to commit SHAs; no caches; untrusted text (tag names) only through environment variables. No signing in
  CI.
- **Runtime** (`sea.ts` → `desktop/main.ts`): `require('node:sea').isSea()` → web client from the embedded
  assets (`desktop/assets.ts`; size + SHA-256 checked at start, else "This copy of Lyren Plan is damaged").
  `WEB_DIR` set explicitly serves from disk (empty = API only). Same commands as the Node CLI plus `stop` (below); options map to
  variables and win over them: `--no-browser` (OPEN_BROWSER=false), `--lan` (HOST=0.0.0.0), `--port <n>`
  (PORT), `--data-dir <dir>` (DATA_DIR), `--db-path <file>` (DB_PATH); `--console` sets no variable (Modes);
  `help` explains desktop mode (on Windows the icon, Quit, `stop`, a terminal start, the log file and
  `--console`; on Linux / macOS as before plus `stop`). Unset (or empty) variables take the
  desktop defaults: DATA_DIR `%LOCALAPPDATA%\Lyren Plan` (Linux `$XDG_DATA_HOME/lyren-plan` or
  `~/.local/share/lyren-plan`, macOS `~/Library/Application Support/Lyren Plan`), HOST `127.0.0.1`, PORT 43770
  (`desktop/defaults.ts` explains the choice). The Node build and Docker keep SERVER_DEFAULTS (config.ts).
- **One server per database** (`desktop/instance.ts`): an exclusive named pipe (Windows) / abstract socket
  (Linux) named after the canonical DB path. A second start asks the holder for its URL with a random
  challenge and accepts only an answer carrying HMAC(secret, challenge + url), the secret being in
  `desktop.json` next to the DB (private folder, see File permissions), then opens the browser there and exits
  0. Never two servers on one DB. A start that fails after taking the name (data folder, database, port)
  closes the database and the name, dropping clients that wait for its address (they retry and take the
  name), before it waits for Enter. A second start waits at most 15 s for an answer and says "Waiting for the
  Lyren Plan that is already running with this data folder [this database with DB_PATH] to answer..." after
  2 s (tray mode: also a non-blocking Information box, `waitingMessage`: "It opens in your browser as soon as it
  answers ...", or when this start opens no browser "This start opens no browser (<reason>), so nothing else
  happens once it answers.", the reason being `--no-browser` when the option was given, else `OPEN_BROWSER=<value>`
  from the environment: `noBrowserReason`). A name that can't be asked ends with a plain
  explanation (`unusableInstanceMessage`), never a stack: connecting refused for lack of permission (EACCES /
  EPERM, e.g. another Windows account's copy on a shared folder) → 'denied' at once; still EADDRINUSE after 20
  attempts against a holder that drops every connection → 'unreachable'. The texts name the database instead
  of the data folder with DB_PATH.
- **Files next to the DB** (`desktop/files.ts`): `desktop.json` and `logs\lyren-plan.log` for `lyren.db` (any
  case on Windows / macOS); for another file name `<name>.desktop.json` and `logs\<name>.log` (rotating to
  `<name>.1.log`), so two databases in one folder never share a secret, port or log. Until a DB's own file
  exists, a `desktop.json` of an older version in that folder is read (port, secret of a running older copy),
  unless `lyren.db` is in the same folder.
- **`stop`** (`instance.ts` `requestStop`, `main.ts` `stopRunning`): `<exe> stop [--data-dir | --db-path]` connects
  to the instance endpoint of that database and sends `{challenge, stop: true}`; the server answers (once ready)
  with its usual `{app, url, proof}` plus a fresh 16-byte hex `nonce` and keeps the connection open; the client
  checks the proof with the secret from `desktop.json` (no readable secret: exit 1 "... could not be read, so it
  can't be asked to stop"; a wrong proof: exit 1 "Another program answers as Lyren Plan ... could not prove it.
  Nothing was stopped."; a valid proof without a nonce, i.e. a version before `stop`: exit 1 "Lyren Plan (<url>)
  runs with ..., but it is an older version, which the stop command can't stop." + "Close its window (or press
  Ctrl+C in it) to stop it."; connecting refused for lack of permission: exit 1 "... this Windows account may
  not ask it to stop") and sends `{stop: HMAC(secret, "stop\n" + nonce)}` (the prefix keeps it apart from the
  server's proofs, whose challenge is hex; a proof for another nonce is worthless). A valid proof gets
  `{stopping: true}` and the same graceful shutdown as Ctrl+C (reason "stop command"); anything else
  `{stopping: false}` and nothing happens (a server without a stop handler refuses). The client waits up to
  15 s until the name is free (database closed, then the name, then exit): "Lyren Plan (<url>) has stopped.",
  exit 0. A connection dropped without an answer, before or after the proof (the server is already shutting
  down: another `stop`, Quit), also waits for the name: free → stopped ("Lyren Plan (with the data folder
  <dir>) has stopped." when no URL was answered), else no answer / refused. Nothing listening: "Lyren Plan is
  not running with the data folder <dir>" (or "the database <file>" with DB_PATH), exit 1; no answer, refused or
  still running: exit 1 with the reason. Works on Linux (abstract socket) and from source. The answer to a
  second start also carries `mode` ('tray' | 'terminal', absent for a console window) so it can say how the
  running copy is stopped. The stop command the app prints itself (tray banner, a second start's
  `runningHint`) is `commandLine(exe, 'stop', commandTargetOption(...))`: with `--db-path "<file>"` when DB_PATH
  makes the DB a separate file, else `--data-dir "<dir>"` when the data folder is not the per-user default (the
  web client's `targetOption` rule; Command Prompt quoting with a trailing backslash doubled). Command Prompt
  expands `%NAME%` even inside double quotes and its command line has no escape for it (a data folder "R&D
  100%PATH%" arrived with the PATH in it), so when the program's name or the option's value contains a `%`
  (`commandShell`, the same rule as the web client's) the command is for Windows PowerShell instead:
  `& '.\<exe>' stop --data-dir '<dir>'` (`psQuote`: single quotes, `'` and the typographic ‘ ’ ‚ ‛ doubled; nothing
  else is special in them), printed as "run in PowerShell: …" instead of "run: …" (`howToRun`). A program's argument
  there is `psArg` = `psQuote(ps51ArgText(value))`: Windows PowerShell 5.1 wraps an argument containing whitespace
  (.NET `char.IsWhiteSpace`: \t–\r, space, U+0085, U+00A0, U+1680, U+2000–U+200A, U+2028, U+2029, U+202F,
  U+205F, U+3000; measured, not U+180E, U+200B, U+FEFF) in double quotes without escaping the backslashes before
  the closing quote, so a value ending in backslashes (a share's root: `path.win32.resolve` keeps
  `\\nas\Lyren 100%\`) has that run doubled then (`'\\nas\Lyren 100%\\'`, which 5.1 hands over as
  `\\nas\Lyren 100%\`; the single one arrived as `\\nas\Lyren 100%"`); without whitespace it is passed as it
  is and left alone. PowerShell 7 passes the doubled backslashes on, which the app resolves away. The same rule for
  `help` (a program name with a `%`: Usage "(in PowerShell: …)", the piped-password example for PowerShell), the
  "To see the options" line and the icacls command (File permissions).
- **Port**: explicit PORT/`--port` is used or the start fails (exit 1, plain message). Otherwise the port
  remembered in `desktop.json`, then 43770…43779; the first that is not EADDRINUSE/EACCES (Windows excluded
  port ranges) is used. On win32 each candidate is first probed with a TCP connect to the browser's address
  (`connectProbe`, 300 ms, a timeout counts as free): Windows lets 127.0.0.1:P be bound while another program
  holds 0.0.0.0:P (and vice versa), so an answer counts as EADDRINUSE, for an explicit port too. The origin
  (browser storage, an installed PWA, bookmarks, the port-blind session cookie) depends on the port, so
  (`portToRemember`): a start without a remembered port remembers where it fell back to (banner note); a
  remembered port that is taken this time stays remembered, and the banner warns that bookmarks and the
  installed app for the usual address now reach another program (don't sign in there) and that the app
  returns once it is free.
- **Browser**: opened at the app unless `OPEN_BROWSER` is set to anything but 1/true/yes/on (the rule of every
  boolean variable, `envBool`) (`rundll32 url.dll,FileProtocolHandler <url>` by absolute path on Windows,
  `open` on macOS, `xdg-open` with a display elsewhere; no shell; http(s) URLs only). While no account exists
  (`browserTarget`): on win32 `/setup#code=<code>` (`SETUP_CODE_FRAGMENT_PARAM`; a fragment, never a query
  string); on other platforms `/setup` without the code, since every local user can read the command line
  of xdg-open / open and of a newly started browser. SetupPage fills the code in and replaces the history
  entry without it at once. The code is also printed (banner: "already filled in" or "enter it on the page
  that opened"), and written to `desktop.json` by a first start (dropped at the next start). A second start
  opens the setup page only while the running server answers `GET /api/auth/status` with
  `setupRequired: true`, else the app.
- **Console**: banner with the URL (and LAN URLs with a wildcard HOST), data folder, setup code, and how to stop:
  "Keep this window open ...; close it to stop" (console mode), plus "or right-click the Lyren Plan icon in the
  notification area (near the clock) and choose Quit Lyren Plan" (terminal mode), or "Lyren Plan keeps running in
  the notification area (near the clock). To stop it, right-click its icon and choose Quit Lyren Plan, or run:
  <exe> stop [--data-dir "<dir>" | --db-path "<file>"]" (tray mode, in the log file; "or run in PowerShell: & '.\<exe>'
  stop …" for a `%`, see `stop`); window title
  `Lyren Plan - <url>` on Windows. A stop or crash that begins while the start is still going on (the stop
  command answered once the name is ready, the session ending) ends the start there (`onStopping`): no browser,
  no banner. A fatal start-up error
  waits for Enter when stdin is a TTY (tray mode: a message box). No Node warnings (node:sqlite emits none on
  24.19; ExperimentalWarning is disabled). SIGINT, SIGTERM, SIGBREAK and SIGHUP (console window closed; Windows
  allows a few seconds), Quit in the icon's menu, the `stop` command and the end of the Windows session stop the
  server (`installShutdown` returns that stop): new connections refused, 1.5 s for requests in flight,
  `db.close()` (WAL checkpointed, -wal/-shm removed), the instance name released, then the icon removed (at most
  3 s), exit 0. An uncaught error (`installShutdown`) at once closes the HTTP server (and its connections), the
  instance name and the DB, prints the error and waits for Enter (tray mode: removes the icon and shows a message
  box with the crash's own text, "Lyren Plan stopped because of an unexpected error:" and the error, not the
  run's earlier stderr); a stop signal then exits 1 immediately. A second start says how the running copy is stopped (its window;
  the notification area and `stop`; or its terminal and the icon), and when the running one can't be used
  (Windows): "Quit the other Lyren Plan (close its window, or choose Quit Lyren Plan from its icon in the
  notification area), or end it in Task Manager, and start Lyren Plan again." (Linux unchanged.)
- **Modes** (`desktop/mode.ts` `decideMode`, Windows SEA only; from source, on Linux and macOS always `console`):
  `--console` → `console` when there is a console or the output is redirected, else `relaunch-console`; no
  console: output redirected to a file or pipe (fstat of fd 1/2 neither a TTY nor a character device; a Windows
  pipe has no isFIFO()) → `console`, else (double-clicked; Node opened NUL) → `tray`; a console: build ≥ 26100
  (24H2, where the manifest applies) or the copy started hidden (`LYREN_DESKTOP_RELAUNCHED=1`, removed at start) →
  `terminal`; older Windows → the parent's image (`tasklist /FI "PID eq <ppid>" /FO CSV /NH`, hidden, by
  absolute path; a failing tasklist counts as a terminal) `explorer.exe` or gone → `relaunch-hidden`, else
  `terminal`. Other commands (`backup`, `restore`, `reset-password`, `promote-admin`, `policy`, `spaces`, `stop`,
  `help`; `commandMode`) without a console and
  without redirection are `unattended` only where nobody can be at the screen: the process's own session is 0
  (services, no interactive desktop, e.g. a task that runs "whether user is logged on or not"; `tasklist /FI "PID
  eq <pid>" /FO CSV /NH`, the Session# field, asked first), or its parent's image (tasklist as above) is one of
  `UNATTENDED_PARENTS`: svchost.exe (Task Scheduler's service), taskhostw.exe, taskhost.exe, taskhostex.exe,
  taskeng.exe, services.exe, wmiprvse.exe. Every other start may be a person's and runs in `tray` mode: Explorer
  (a shortcut, Win+R), another file manager or launcher, Start-Process in a PowerShell window, a program's
  DETACHED_PROCESS child, a parent that has ended, an unknown session or parent (tasklist failing). `tray`: no
  log file; everything printed (stdout and stderr in order, `runtime.showOutput`) is shown when the command ends,
  in a message box (Information on success, Error on failure; reset-password adds "(Ctrl+C copies the text of this
  message.)"), else a console window (`LYREN_DESKTOP_MESSAGE`); a text over 3000 characters or 30 lines (help) goes
  to the console window first and to a shortened box only when that can't be opened. The command's own process
  waits for neither, so a scheduled start taken for a person's does not hang on it: the box is an `outlive` box
  (Message boxes) and the process exits with the command's exit code as soon as it is up (measured: 0.3–0.8 s after the start for `stop` from a
  shortcut, Start-Process and a DETACHED_PROCESS launcher; the box stayed until OK); the console window is a new
  process started by cmd.exe's `start`. A caller that waits for the whole process tree still waits for the box:
  Windows PowerShell's `Start-Process -Wait` puts the command in a job without breakaway and returns only when
  every process in it has ended (measured: the exe exited after 0.7 s, Start-Process returned right after OK);
  the README tells scripts to use `& '<exe>' …` or `Start-Process -PassThru` with `.WaitForExit()` instead. A
  start through "Run as different user" (Secondary Logon, a service in svchost.exe) is taken for unattended
  (untested). `unattended`: no message box, no console window, nothing waited for;
  stdout and stderr go to the log file next to the database (Log file; opened only when the folder that holds the
  database exists, which a command never creates, and not for `help`) after "Command: <command>, started without
  a window by <parent image>: nothing is shown, its output follows." ("… in session 0 (Windows services, no
  desktop) …") and end with "<command> ended with exit code <n>."; then the exit code at once. `reset-password` there without a password (none given, none piped) refuses
  before it opens the database (`MaintenanceContext.noRandomPassword`: "reset-password was started without a
  window by Task Scheduler or a service, so nobody would see a new random password. Nothing was changed.", exit 2): the password would be lost (it is never written to the log). `tray`:
  no console; stdout/stderr go to the log file (`log.ts`); `terminal`: the console as before plus the log file and
  the icon; `console`: as before (no log file, no icon). A relaunch that fails is noted in the log (`--console`
  without a console then runs in `tray`).
- **Relaunches** (`desktop/relaunch.ts`): `relaunch-console`, the tray fallback, the message fallback and a
  long command output start
  `cmd.exe /d /v:off /c start "Lyren Plan" "<System32>\conhost.exe" "%LYREN_RELAUNCH_REF%"` (hidden, verbatim,
  waited for; Node can't start conhost.exe with working standard handles, and the detached policy outranks
  CREATE_NEW_CONSOLE): a classic console window. No user data is in that command line: `LYREN_RELAUNCH_REF` holds
  the text `%LYREN_RELAUNCH_EXE%`, which cmd.exe's single expansion leaves for conhost.exe, whose single expansion
  turns it into the exe path without looking into it (an exe in "…100%PATH%…" works; only `"` is refused); the
  arguments are a JSON array in `LYREN_RELAUNCH_ARGS`, which the new copy uses as its command line when it has none
  (conhost.exe rebuilds the client's command line and expands `%VARIABLES%` in it: a data folder "…100%PATH%…"
  arrived expanded). The variables are removed from the new copy's environment at once. `relaunch-hidden`: the exe with the same
  arguments, `detached`, `windowsHide`, stdio ignored, `LYREN_DESKTOP_RELAUNCHED=1`; the visible copy exits 0.
  A `relaunch-console` that fails continues as `tray`; a `relaunch-hidden` that fails as `terminal`.
- **Notification-area icon** (`desktop/tray.ts`, `scripts.ts` TRAY_SCRIPT, `powershell.ts`): Windows PowerShell
  5.1 by absolute path (`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`, checked to exist), started
  as `cmd.exe /d /s /c ""<powershell.exe>" -NoProfile -NonInteractive -Command "<BOOTSTRAP>""` with pipes and
  windowsHide (`outsideJobLaunch`, also used for a command's result box; not detached: a detached powershell.exe exits at once; not directly: Node's kill-on-close job would
  end it with the app before it removes its icon; started by cmd.exe it is outside that job). BOOTSTRAP (no `"`,
  `%` or `!`) prints `lyren-ps-boot <LanguageMode>`, reads the script as text lines from stdin up to
  `#lyren-script-end` and runs it with the same reader; no file, no ExecutionPolicy, no -EncodedCommand. Then
  newline-delimited JSON, UTF-8: app → helper `init {parentPid, tooltip, icon (base64 .ico, null = stock icon),
  menu [{id, text, default?} | {separator}], testHooks}`, `tooltip {text}`, `copy {text}`, `ping {id}`, `exit`,
  `test {op}` (only with testHooks: `click:<id>` = that MenuItem's PerformClick, `describe` = the built menu);
  helper → app `hello {languageMode, ps, pid}`, `ready {iconSize, dpi}`, `action {id, via: menu|left-click}`,
  `session-ending {reason}`, `copied`, `pong`, `described`, `error {message}`, `bye {reason}`; garbage, partial
  lines (joined), lines over 64 KiB (dropped) and unknown types are ignored. Every value is JSON data, never
  code. The scripts contain none of the words for which PowerShell logs a script block as suspicious (event 4104,
  Warning; the list is in the tests): WinForms and Drawing load by full assembly name
  (`[System.Reflection.Assembly]::Load('System.Windows.Forms, Version=4.0.0.0, …')`, not Add-Type), and the icon
  comes from `System.Drawing.IconConverter` (not a MemoryStream). The helper runs in System32 (cmd.exe would warn
  about a UNC working folder on stderr, which ends up in the logged exit reasons). The helper: NotifyIcon with the
  icon of 16 × AppliedDPI/96 px (HKCU\Control
  Panel\Desktop\WindowMetrics; powershell.exe is DPI-unaware), tooltip "Lyren Plan - <url>" cut to 63 characters
  (sent with `init`, and as `tooltip` to a helper that got its `init`, ready or not: a slow start sets the address
  between hello and ready), a native ContextMenu: **Open Lyren Plan** (DefaultItem, bold; also the left click; setup
  page with the code while no account exists, `browserTarget`), **Open data folder** (`explorer.exe "<dir>"` by
  absolute path, verbatim and quoted, a drive root unquoted: unquoted, explorer.exe splits at `,` `;` `=` and opens
  Documents; a path over 259 characters, which it can't open, gives an Information box with the path instead; NOT
  windowsHide: with it the folder opens hidden), with `--lan` **Copy address for other devices** (the first LAN
  URL to the clipboard), separator, **Quit Lyren Plan**. It removes the icon and exits on `exit`, stdin EOF (the
  app ended, also when killed: measured 85–119 ms), the app's process gone (polled every 500 ms) and
  SessionEnded (after serving stdin for at most 4 s), in a `finally` on every path; SessionEnding/SessionEnded
  → `session-ending` → the app stops ("Windows is ending the session"). The helper is started right after this
  run holds the instance name; the start waits at most 3 s for `ready` before it opens the browser. Not
  FullLanguage, or PowerShell missing → failed at once; exited before ready or no ready within 15 s (the
  PowerShell pid from `hello` is killed, killing cmd.exe would not end it) → started again after 1, 2, 3 s, at
  most 3 restarts per run, also after it was ready; then failed. Failed in tray mode → "The Lyren Plan icon could
  not be shown in the notification area (<reason>). Lyren Plan stops and starts again in a console window." (log),
  graceful stop, then a console relaunch with `--console`, `--no-browser` when the browser was already opened and
  `SETUP_TOKEN` = the setup code of this first start (the page already open keeps working); "Lyren Plan continues
  in a console window." is logged once that relaunch started, else an Error box (waited for) and the log say
  that Lyren Plan has stopped and to start it from Command Prompt or PowerShell. Failed in terminal mode
  → a note in the terminal, `stopMode` dropped, it keeps running. close(): `exit` + stdin end, at most 3 s, then
  the PowerShell pid is killed (logged: the icon may stay until the mouse passes over it). Windows lists the icon
  under powershell.exe (HKCU\Control Panel\NotifyIconSettings: ExecutablePath …\powershell.exe, UID 1).
- **Message boxes** (`desktop/dialog.ts`, `scripts.ts` DIALOG_SCRIPT, `runtime.ts`): tray mode only. powershell.exe
  directly (windowsHide, the same bootstrap), then `{title: "Lyren Plan", text, icon: Error|Warning|Information}`
  as one JSON line; the script prints `hello {pid}`, `showing` just before the box and `closed` after OK (ignoring
  a closed pipe); `MessageBox.Show(…, MessageBoxOptions.DefaultDesktopOnly)` (a top-most box on the user's
  desktop, hosted by csrss: a box owned by a hidden TopMost form was neither top-most nor in the foreground when
  the app was started in the background). A command's result (Modes) is an `outlive` box: PowerShell started like
  the tray helper (`outsideJobLaunch`: through `cmd.exe /d /s /c`, outside Node's kill-on-close job), resolved at
  `showing`, then the app lets go of it (child unref'd, pipes destroyed) and exits; when the job closes, cmd.exe
  ends and the box stays until OK, after which its PowerShell ends (measured). A box not up within 30 s ends
  the PowerShell named in `hello` too (killing cmd.exe would not end it). The boxes of `serve` are direct
  children and go away with the app. Fatal problems of `serve` (a failed start: the stderr text of this run, the
  same lines as the console, at most 3000 characters plus where the rest is; a crash; a damaged exe; a second
  start that can't reach the running one) are waited for, then exit 1; when no box can be shown (PowerShell
  missing, not FullLanguage, exited before `showing`, no `showing` within 30 s) a console relaunch shows the text
  (`LYREN_DESKTOP_MESSAGE`: print it, wait for Enter, exit 1; for a command's result not waited for either; a
  ConstrainedLanguage PowerShell outside the job ends by itself, measured). Not waited for: the browser could not
  be opened (the address, and the setup code on a first start), the banner's notices (`bannerNotices`: port fallback, usual address taken, folder permission warnings), Open /
  Open data folder failing (or the folder's path too long for File Explorer), no LAN address to copy, a second
  start still waiting for the running copy after 2 s. A command's output: see Modes.
- **Log file** (`desktop/log.ts`, tray and terminal mode): `<folder of the database>\logs\lyren-plan.log`
  (`<name>.log` for a DB not named lyren.db, see Files next to the DB; created 0700/0600 after the data folder
  exists, earlier output kept in memory, at most 256 KiB), everything written to stdout/stderr (banner, warnings,
  errors, Hono's request log with LOG_REQUESTS) plus tray events, as plain text: ANSI escape sequences (Hono
  colours the status) are removed, and the setup code of a first start (`redact`) and the token of every link that
  carries one in its fragment (`#t=<token>`, also percent-encoded `%23t%3D<token>`; design §9.7) are written as
  `[not in the log]` (the terminal still shows them); a line is written once it is complete (what is left without a
  line break at close or exit), so a secret printed in pieces is found too; each line prefixed with local `YYYY-MM-DD HH:MM:SS `; first line "Lyren Plan <version> started
  (<mode> mode, process <pid>, Windows build <n>)". At 1 MiB it is renamed to `lyren-plan.1.log` (replacing it;
  if that fails the file starts over) and a new one starts. Writing never throws. Besides an unattended command
  (Modes), which appends to it (each write at the end of the file), only the run that holds the
  instance name writes it.
- **Child processes on Windows** never flash a console window: icacls (a long path as `\\?\<path>`, File
  permissions), whoami, tasklist, rundll32, cmd.exe and
  powershell.exe are started with windowsHide (relaunch-hidden also detached); explorer.exe (a windowed program)
  is the only exception. The tray helper and the message boxes run with System32 as their working folder.
- **Test-only hooks** (`desktop/hooks.ts`; environment variables, inert unless set, nothing sets them in normal
  use): `LYREN_TEST_BROWSER_LOG=<file>` appends each URL the app would open in the browser instead of opening it;
  `LYREN_TEST_DIALOG_LOG=<file>` appends each message box as JSON instead of showing it; `LYREN_TEST_TRAY_CONTROL=<file>`
  polls <file> every 250 ms (read, deleted) and sends each line to the helper as a test operation (`init.testHooks`
  true): `click:<id>` runs that menu item's own Click handler (no synthetic input), `describe` logs the menu;
  `LYREN_TEST_POWERSHELL_CLM=1` prefixes the bootstrap with `$ExecutionContext.SessionState.LanguageMode =
  'ConstrainedLanguage'` (Windows PowerShell 5.1 ignores `__PSLockdownPolicy` in a process environment).
- **In-app guidance** (`runtime/node/desktop.ts`): only the desktop app passes `desktop` to `openNodeStack` (which
  hands the directory app `DirectoryDeps.desktop`), and only then do responses gain a field (the Node build's and
  Docker's stay byte-identical, no `desktop` key):
  `GET /api/auth/status` (public) adds `desktop: DesktopAppDTO` `{ exe, windows }` (the program's file name,
  never a path), plus `stopMode: 'tray' | 'terminal'` while the icon is in use (read per response; absent for a
  console window, Linux and macOS, so their responses are unchanged); for instance admins it also adds `desktopData: DesktopDataDTO` (also `dataDir`, `dbPath`
  when DB_PATH makes the database anything but `<dataDir>/lyren.db`, another folder or another name, else null
  (`separateDbPath`, compared without case on Windows; also the banner's "Database:" line), `customDataDir`
  when it is not the per-user default, `exeFolder`, null from source). LoginPage (`PasswordResetHint`) and Administration → Overview (`SelfHostingNotes`, card "Data
  folder and commands") then show the app's commands instead of `node dist/server.mjs`, Docker and cron:
  Command Prompt in the program's folder with the file name always quoted (`"<exe>" reset-password <user>`,
  `"<exe>" backup "%USERPROFILE%\Documents\Lyren Plan backups\lyren-<date>.tar"`, `--db-path "<dbPath>"`
  appended when `dbPath` is set, else `--data-dir "<dir>"` when `customDataDir`, since a Command Prompt opened
  later lacks the app's DATA_DIR/DB_PATH; a trailing backslash doubled); when the file name or that option's value
  contains a `%` (`commandShell`, see `stop`) every command is for Windows PowerShell instead (`& '.\<exe>' …`,
  values `psQuote`d with a trailing backslash doubled where 5.1 needs it (`ps51ArgText`, see `stop`), the backup file `"$env:USERPROFILE\Documents\Lyren Plan backups\lyren-<date>.tar"`; "run in
  PowerShell", "Not in Command Prompt: it would change the % in the path of the data folder" (of the database /
  in the name of the program), "type powershell in the address bar"; the sign-in page by the file name alone); a
  Windows Task Scheduler entry (`powershell.exe` with `& '<exeFolder>\<exe>' backup (… Get-Date -Format
  yyyy-MM-dd …)` and the same option; PowerShell single quotes double `'` and the typographic ‘ ’ ‚ ‛, which also
  end such a string; a `%` in the program's path or the option's value is written as `[char]37`, `('…' + [char]37
  + '…')` (`psLiteral`), since Task Scheduler may expand %NAME% in a task's arguments; the option's value is
  `ps51ArgText`'d first, as PowerShell passes the expression's value to the program like any argument); or `./<exe>` in a
  terminal elsewhere; a "Stop Lyren Plan" note (how, by `stopMode`, and `"<exe>" stop` with the same option);
  the data folder's contents (`lyren.db`, `spaces\` or `<file>.spaces\` next to a `dbPath`, `backups\`); a restore:
  `"<exe>" restore "<the backup file>"` with the same option, then the stop step by `stopMode` ("Close the Lyren Plan
  window." / "Quit Lyren Plan: right-click its icon in the notification area (near the clock) and choose Quit Lyren
  Plan." / "Stop Lyren Plan: press Ctrl+C in its window, or …"), then "Start Lyren Plan again."; reset-password by
  email (or the old username), which also clears lock-outs. With `stopMode` 'tray' the app shell shows a one-time note
  (`TrayHint`, dismissed for good in localStorage `lyren.trayHint.dismissed`, not on phones): it keeps running in
  the notification area, Quit there, the ^ overflow and Settings → Personalization → Taskbar → Other system tray
  icons (maybe listed as Windows PowerShell); the setup page then says "Start Lyren Plan again to open this page
  with the code filled in." (`setupCodeHelp`; the log file leaves the code out). "Can't reach Lyren Plan" on a loopback address says
  "start it again (it must keep running while you use it)". Desktop wording elsewhere: Account settings → Profile's
  Sign out card ("Your data stays in the data folder on the computer that runs Lyren Plan") and the import
  card's error texts ("Lyren Plan" instead of "the server"). `reset-password` ends with `lockoutAdvice` (cli.ts),
  the same line for every audience: "Any lock-out from failed sign-ins has been cleared." The sign-in page's hint
  shows `reset-password <email-or-username>`.

### 12.2 Cloudflare

The runtime of design §10, deployed by docs/cloudflare.md's runbook. Nothing in the repository belongs to one
deployment: no account id, route, custom domain, variable value or secret. What belongs to one deployment is its
instance configuration, a file the repository never has (below; design Appendix D 70).

- **The Worker** (`runtime/cloudflare/worker.ts`, Wrangler's entry; it exports only `default`, the two object
  classes and `handleRequest`): every `/api` and `/api/*` request (`run_worker_first`); everything else is Workers
  Static Assets (`dist/web`, `not_found_handling: single-page-application`, `web/public/_headers` with Node's CSP,
  §10.7). It parses the configuration once per isolate (an invalid one: every `/api` request 503 "Configuration
  error: …"), answers `GET /api/health` itself, refuses another origin than `PUBLIC_URL`'s (another host or port, or
  plain HTTP) with 421 `wrong_host` "This Lyren Plan instance is at <PUBLIC_URL>" (the SPA then moves there; without
  `PUBLIC_URL`, plain HTTP is refused the same way, naming `https://<host>`, except for localhost, 127.x and [::1]
  under `wrangler dev`), and applies the gateway's guards
  (`gateway/guards.ts`: canonical paths, CSRF, `Content-Length`, the space id and session cookie) without a Durable
  Object request. The client's address is `CF-Connecting-IP`. It removes any client-sent `x-lyren-meta` and sends
  its own (`TrustedMeta`, base64url JSON) with `stub.fetch` to `DIRECTORY.getByName('directory')`, or, for
  `/api/s/<id>/…` without the `Cookie` header, to `SPACES.getByName(<id>)`; a failed `stub.fetch` is 503 "Lyren
  Plan is temporarily unavailable. Try again in a minute.". Every `/api` answer gets the security headers and
  `Cache-Control: no-store` (unless it has its own), and every answer over HTTPS `Strict-Transport-Security:
  max-age=31536000`. No compression (Cloudflare
  compresses). `LOG_REQUESTS`: `[lyren] <method> <path> <status>`.
- **`DirectoryDO`** (one, `directory`) runs the directory app and service; **`SpaceDO`** (one per space id) the
  space host and app, with an auth cache of `AUTH_CACHE_SECONDS` (30 s; a sign-out reaches a space within it, the
  security revocations are pushed at once). Directory↔space calls are RPC. Migrations run in the constructor under
  `blockConcurrencyWhile`; an error never escapes it: the object answers 503 "Configuration error: …", "This data
  was upgraded by a newer version of Lyren Plan. Deploy that version again." or "The database could not be opened:
  …". The directory's hourly alarm runs the maintenance (§9.8; at most 20 purges a run) and logs the orphaned-passkey
  warning. An uninitialized `SpaceDO` writes nothing and answers 401 or 404 as a space answers someone who may not
  open it. A Durable Object's daily-quota error answers 503 "This Lyren Plan instance has reached its daily usage
  limit. It resets at 00:00 UTC."; a full object (`SQLITE_FULL`) 409 `quota_exceeded`.
- **Configuration**: `core/config.ts` with the Cloudflare defaults (design Appendix B, docs/cloudflare.md
  "Configuration"): passwords of at least 12 characters, scrypt p = 1, sessions of at most 90 days, 5 spaces per
  account and 10 created a day, 20 members per space, imports of 4 MiB, 300,000 JSON values, 50,000 row writes and
  60,000 a day, 20,000 row writes per space and day, 200 MiB per space. Variables come from the instance
  configuration's `vars` (as text, at every deploy), the dashboard (`keep_vars: true` keeps the ones the instance
  configuration does not list) or `.dev.vars`. `SETUP_TOKEN`, `SMTP_PASS`, `RESEND_API_KEY` and `RECOVERY_TOKEN` are
  always secrets, `SMTP_USER` and `MAIL_REPLY_TO` may be either, and every other setting is a variable (a deploy
  checks the file's variables alone; the app reads both alike). Secrets come from `npm run cf -- secret put`, the
  dashboard or a deploy's `--secrets-file`, which may carry `SETUP_TOKEN`, `SMTP_USER`, `SMTP_PASS`, `MAIL_REPLY_TO`
  and `RESEND_API_KEY`; `RECOVERY_TOKEN` is set only by hand (`secret put` or the dashboard), never through a secrets
  file. An empty value counts as unset. `PUBLIC_URL` must be https (http only for localhost, 127.x or [::1], under
  `wrangler dev`). The Node-only variables are not read. `MAIL_TRANSPORT=cloudflare` needs a `send_email` binding
  `EMAIL` (Workers Paid), not in the committed `wrangler.jsonc`: the generated configuration of every run adds it when
  the instance configuration's `MAIL_TRANSPORT` is `cloudflare`; SMTP runs over `cloudflare:sockets` (port 25 refused).
- **What Cloudflare lacks**: no CLI (`RECOVERY_TOKEN` and `/recover` replace `reset-password` and `promote-admin`
  for operators), no backup download (`capabilities.backupDownload` false), no safety point before a replace import
  (the web client requires an archive download first), no file snapshots.
- **`wrangler.jsonc`** (repository root): `main` the TS entry, bundled by Wrangler with `tsconfig.worker.json` (the
  `@shared` alias), `compatibility_date` 2026-10-01 (the workerd of the pinned wrangler 4.147.0; raise both together),
  `nodejs_compat`, `build.command` `node scripts/cf/build-web.mjs`, the `DIRECTORY` and `SPACES` bindings, the
  append-only `migrations` (`v1`, `new_sqlite_classes`), `workers_dev: true`, `preview_urls: false`, `keep_vars: true`,
  observability on, `send_metrics: false`. `build-web.mjs` first refuses (exit 1, before it builds anything) a
  Wrangler run whose `WRANGLER_COMMAND` is neither unset, `dev` nor `types` and that `scripts/cf/wrangler.mjs` did
  not start (its `--run=<token>` equal to `LYREN_WRANGLER_RUN`) while the checkout has an instance configuration
  (`wrangler.instance.jsonc`, or `LYREN_INSTANCE_FILE` set; `scripts/lib/cloudflare.mjs#wranglerRunRefusal`). Then it
  runs `npm run build:web`, except that it keeps a built `dist/web/index.html` with `LYREN_PREBUILT=1`, and in a
  Workers Builds build (`WORKERS_CI=1`) one newer than `package.json` (the Deploy button's prefilled `npm run build`
  built it). `.gitignore` covers `.wrangler/`, `.dev.vars*` (but `.dev.vars.example`), `wrangler.instance*.jsonc` (but
  `wrangler.instance.example.jsonc`), `wrangler.deploy*.jsonc` (the generated files) and `wrangler.local.jsonc` (no
  longer read); `.dockerignore` the same files.
- **The instance configuration** (design Appendix D 70; docs/cloudflare.md "Your instance configuration"): a JSONC
  partial Wrangler configuration of one instance, never a secret's value: `--instance=<file>` given to the wrapper, else
  `LYREN_INSTANCE_FILE`, else `wrangler.instance.jsonc` at the root (a relative path from `INIT_CWD`, else the working
  directory; a named file that does not exist is an error). Its keys (`scripts/lib/instance.mjs`, `INSTANCE_KEYS`):
  `name` (required), `account_id`, `workers_dev`, `routes` (custom domains only, `PUBLIC_URL`'s host among them),
  `send_email` (the one binding `EMAIL`, optionally `allowed_sender_addresses` holding `MAIL_FROM`), `vars`
  (`APP_VARIABLES`: the 36 variables `core/config.ts` reads on Cloudflare but the secrets and `MAIL_LOG_BODIES`; numbers
  and booleans become text; no empty value), `secrets` (`required`, among `SMTP_USER`, `SMTP_PASS`, `MAIL_REPLY_TO` and
  `RESEND_API_KEY`), `keep_vars`, `limits`, `observability`, `placement`, `logpush`, `tail_consumers` and `$schema`.
  Everything else is refused with the reason and the nearest name: `wrangler.jsonc`'s keys, `env`, `route`, other
  bindings, and in `vars` the secrets, Node-only names and the retired `WORKER_NAME`, `WORKERS_DEV` and `EMAIL_BINDING`.
  Refused too: a member name given twice in one object (`<file>:<line>:<column>: "vars.MAIL_TRANSPORT" is given twice`,
  for every command, like a syntax error), a file saved as UTF-16 or UTF-32 (one leading UTF-8 byte-order mark is
  dropped), and the values only `wrangler dev` uses: a loopback `PUBLIC_URL` or `SMTP_HOST`, `SMTP_SECURITY` `none`. A
  `PUBLIC_URL` off workers.dev with neither `routes` nor `workers_dev` is a warning (that deploy turns workers.dev on).
  `scripts/cf/wrangler.mjs` checks it with `wrangler.jsonc` (which may then hold no instance setting, `route` and `env`
  included) and with `parseAppConfig` (`scripts/lib/app-config.mjs`: bundled in memory by Wrangler's esbuild and refused
  unless it comes from `server/src` and `shared/src` alone and imports nothing; values in its messages become
  `<value>`). The parser sees the file's variables alone, with placeholders for the secrets that `secrets.required` or
  the deploy's `--secrets-file` names (names only, never values): the run says `the file's variables are valid`, notes a
  mail variable that only a `MAIL_TRANSPORT` outside the file would read, and adds `(the check reads only this file's
  variables: put <NAME> here)` to a refusal that names a setting the file lacks. It writes `wrangler.deploy.<id>.jsonc`
  at the root (`<id>` 8 random hex digits, one file per run, flag `wx`; its header records the wrapper's pid, its place,
  `os.hostname()` plus on Linux the `/proc/self/ns/pid` link, and its kind, `build` for `deploy` and `versions upload`,
  dry runs included, else `other`), removed when Wrangler ends: `wrangler.jsonc` with the instance's keys,
  `workers_dev: false` when `routes` is listed, `send_email: [{ name: 'EMAIL' }]` when `MAIL_TRANSPORT` is `cloudflare`,
  `secrets.required` (the declared names and those the parser requires: `SMTP_PASS` with `SMTP_USER`, `RESEND_API_KEY`
  with `resend`), and the build command with a run token of 32 hex digits. Before it writes its own, a run removes the
  generated files of its place whose pid is gone (runs that were stopped), leaves the others alone (those of another
  place, a container or another WSL distribution, among them), and notes a `wrangler.deploy.jsonc` of an earlier
  version. A run of kind `build` is refused, exit 1, while another `build` file that is not a stopped run's is there,
  since each build empties `dist/web`:
  `another deploy or check may be running in this checkout (<file>): wait for it to end, or remove the file if none is`
  (a pid can be reused, and one of another place cannot be judged; two runs started at the same moment can both get
  past this check, which keeps a habit from breaking a deploy and is no lock). A run of kind `other` never waits, and
  runs without an instance configuration write no file and are not part of it. Then it runs
  `node_modules/wrangler/bin/wrangler.js` (the pinned version, no shell) from the root with
  `--config=wrangler.deploy.<id>.jsonc`, each variable as `--var NAME:value` too for a deploy, and
  `LYREN_WRANGLER_RUN=<token>` and an empty `CLOUDFLARE_ENV` in its environment. Every Wrangler run, with an instance
  configuration or without, also gets `--env=` (Wrangler's top-level environment): Wrangler loads a `.env` or
  `.env.local` of the checkout into its environment, where a `CLOUDFLARE_ENV` set there would win over the empty one,
  but not over the argument. Commands other than `deploy` and `versions upload` (read as Wrangler reads them:
  `versions --message hi upload` is an upload) get `wrangler.jsonc` with only the instance's `name` and `account_id` (if
  any), and no `--var`. Refused, exit 2: `--config`, `--cwd`, `--env`, `--env-file`, `--name` and a `--` for every
  command; `--var`, `--routes`, `--domains`, `--keep-vars`, the compatibility options and a script path for `deploy` and
  `versions upload`; `dev`, `preview`, `triggers deploy` and `types`; a non-blank `CLOUDFLARE_ENV`; and a wrapper option
  that npm took for itself (a non-blank `npm_config_instance`, `npm_config_secrets_file` or `npm_config_validate`, and
  `npm_config_dry_run` for a deploy that is no dry run; the example names the script from `npm_lifecycle_event`).
  Deploys, dry runs and `--validate` stop at any problem; other commands need only a file that parses, a valid `name`,
  and an `account_id`, if any, that is valid (both pick the Worker the command acts on). Without an instance
  configuration a dry run checks `wrangler.jsonc` as it is, `--validate` fails, a deploy under `WORKERS_CI=1` deploys it
  as it is, and anything else is refused. `--secrets-file` (deploys only; never read for a dry run; read before the app
  check): a JSON object of non-blank `SETUP_TOKEN`, `SMTP_USER`, `SMTP_PASS`, `MAIL_REPLY_TO` or `RESEND_API_KEY`, no
  name that is also a variable, never `RECOVERY_TOKEN`; a file that lists none is not passed on. The output names
  settings, never a value, the Worker's name, a host, the account ID or the token, and goes to stderr: stdout is
  Wrangler's. Exit status: Wrangler's; 1 when refused; 2 for bad usage.
- **Scripts**: `dev:cf` (`wrangler dev` on 127.0.0.1:8787 with `wrangler.jsonc` and `.dev.vars`, local state in
  `.wrangler/state`; never the instance configuration), `check:cf` (`node scripts/cf/wrangler.mjs deploy --dry-run
  --outdir dist/worker`), `deploy:cf` and `deploy` (`node scripts/cf/wrangler.mjs deploy`; `deploy` is the deploy
  command the Deploy button fills in), `cf` (`node scripts/cf/wrangler.mjs`: any Wrangler command for the instance,
  or `--validate`). The wrapper removes the empty `.wrangler/tmp` and `.wrangler` that Wrangler leaves.
- **The deploy workflow** (`.github/workflows/deploy-cloudflare.yml`; design §10.10, Appendix D 63 and 70): manual
  (`workflow_dispatch`, `dry_run` default true), `contents: read`, concurrency `deploy-cloudflare`, only `actions/*`
  pinned to release.yml's SHAs, no `${{ }}` in a `run:`. Job **check** runs `npm ci --ignore-scripts`, `node
  scripts/cf/wrangler.mjs --validate` (its env only `LYREN_INSTANCE_FILE`, the repository variable; it fails without an
  instance configuration, before any approval) and `npm run check` with no secret, and keeps `dist/web` (artifact `web`,
  1 day); job **deploy** (environment `cloudflare`, a new runner) installs with `--ignore-scripts`, downloads
  `dist/web`, writes the secrets file unless it is a dry run (`scripts/ci/write-secrets-file.sh`: the non-empty
  `SETUP_TOKEN`, `SMTP_USER`, `SMTP_PASS`, `MAIL_REPLY_TO` and `RESEND_API_KEY` as JSON, mode 0600, never over an
  existing file), then runs either **Dry run** (`node scripts/cf/wrangler.mjs deploy --dry-run --outdir dist/worker`,
  with `LYREN_PREBUILT=1` and `LYREN_INSTANCE_FILE`, no Cloudflare token) or **Deploy** (`node scripts/cf/wrangler.mjs
  deploy --secrets-file="$RUNNER_TEMP/lyren-secrets.json"`, with the two `CLOUDFLARE_*` secrets as well), and always
  removes the file. `vars.` appears only as `vars.LYREN_INSTANCE_FILE`: the instance configuration is committed to the
  fork (`wrangler.instance.jsonc` at its root, or at that variable's path), on the branch it deploys; this repository
  has none and never deploys through the workflow. Next to the token run only Wrangler and the app's own configuration
  parser. The secrets are the `cloudflare` environment's (deployment branch: the branch that holds the instance
  configuration, either the fork's default branch, `master` for this repository, or, in a fork that also sends pull
  requests, a branch of its own such as `deploy`; required reviewers; docs/cloudflare.md step 4B), never repository
  secrets, which every workflow run could read.
- **The Deploy button** (README): Cloudflare copies the repository into a repository of the user's and builds it with
  Workers Builds; it prompts for `SETUP_TOKEN`, the one active line of `.dev.vars.example`, described by
  `package.json`'s `cloudflare.bindings`. Its deploy command is `npm run deploy` (`package.json`'s `deploy` script).
  The first build has no instance configuration and deploys `wrangler.jsonc` as it is; the copy then commits
  `wrangler.instance.jsonc`, whose `name` must be the Worker the build deploys (`WRANGLER_CI_OVERRIDE_NAME`).
