# Mailroom Extraction

Branch: `unified-inbox` (nanoclaw-side changes layer on top of the existing SQLCipher work). Mailroom stack itself lives in a different repo: `~/Projects/ConfigFiles/containers/mailroom/mailroom/` (stow-managed).

## Goal

Extract mail ingestion, storage, MCP query API, and backfill out of the `nanoclaw` host process into a standalone Docker-native stack (`mailroom`). Nanoclaw retains router + agent orchestration + chat channels + credential proxy + container spawner; all mail-specific code leaves. The Protonmail bridge stays as its own stack, unchanged except that its `0.0.0.0:1143 / 1025` ports move to loopback-only and eventually drop entirely.

## Guiding constraints

- Everything in Docker; nothing mail-related on the host. Jeff's architectural principle.
- Match existing conventions: stow-managed compose, `dcc` wrapper, `env-vault` secrets, BTRFS data subvolumes under `~/containers/data/`.
- No destructive cut of the running nanoclaw ingestion. Mailroom deploys alongside; cutover only after verification.
- SQLCipher Phase 1.6 work transplants intact — same package alias, same `loadInboxDbKey` helper, same `PRAGMA cipher + key` mechanism, same encryption at rest.
- Host-side Protonmail channel is already dark (since 2026-03-30 20:21) — migration resolves it by reaching the bridge via Docker service-name DNS on `protonmail_default`.

## Overall acceptance criteria (goal-backward)

- **AC-1** `~/Projects/ConfigFiles/containers/mailroom/mailroom/docker-compose.yml` exists, is stow-linked to `~/containers/mailroom/`, and `dcc up mailroom` brings up `ingestor` + `inbox-mcp` services cleanly.
- **AC-2** Single `mailroom-local` image built from a single Dockerfile contains ingestor + inbox-mcp + both backfill entrypoints. Compose services differ only in their `command:` line.
- **AC-3** `~/containers/data/mailroom/store.db` is created **encrypted** on first `ingestor` start. `sqlite3 store.db ".tables"` returns "file is not a database"; keyed open lists the full schema.
- **AC-4** `ingestor` polls Gmail API and writes rows to `store.db` through the cipher layer within one poll cycle after a test email arrives. `SELECT COUNT(*) FROM messages WHERE source='gmail'` increments.
- **AC-5** `ingestor` polls Protonmail IMAP via `protonmail-bridge:143` (Docker service DNS on `protonmail_default`) with **zero `ENOTFOUND` errors**. `SELECT COUNT(*) FROM messages WHERE source='protonmail'` increments on next poll cycle.
- **AC-6** `inbox-mcp` exposes Streamable HTTP at `http://inbox-mcp:8080/mcp` on `mailroom_shared` network. A Madison-agent container joined to that network can call `tools/list` and get back `mcp__inbox__{search,thread,recent}`.
- **AC-7** `docker compose run --rm backfill-proton` and `docker compose run --rm backfill-gmail` populate historical rows into `store.db`. Both are idempotent, resumable via `~/containers/data/mailroom/backfill-cursor.json`, rate-limited for Gmail.
- **AC-8** Mailroom publishes `inbox:new` events to `~/containers/data/mailroom/ipc-out/`. Nanoclaw's new `mailroom-subscriber` channel watches that directory and dispatches urgent items to Telegram via the existing router/group-queue flow.
- **AC-9** Madison's agent container mounts `mailroom_shared` when `folder === telegram_inbox`, and her agent-runner MCP registration points `inbox` at `http://inbox-mcp:8080/mcp` instead of the stdio subprocess.
- **AC-10** Nanoclaw drops: `src/channels/gmail.ts`, `src/channels/protonmail.ts`, `src/inbox-store/*`, `container/inbox-mcp/*`, `scripts/inbox-backfill-{proton,gmail}.ts`, the `better-sqlite3` + `googleapis` + `imapflow` + `turndown` + `nodemailer` + `google-auth-library` + `@types/better-sqlite3` dependencies, and the Dockerfile's inbox-mcp stanza. Full test suite still passes.
- **AC-11** Protonmail bridge compose at `~/containers/protonmail/docker-compose.yml` has `ports:` stanza bound to `127.0.0.1:1143:143` and `127.0.0.1:1025:25` (loopback-only), then dropped entirely once no host process reaches the bridge.
- **AC-12** `INBOX_DB_KEY` lives only in `~/Projects/ConfigFiles/containers/mailroom/mailroom/env.vault`. Removed from `~/containers/nanoclaw/.env`. Nanoclaw no longer reads or refers to it.

## Decisions (locked)

| Decision | Rationale |
|---|---|
| Extract mail stack out of nanoclaw | Jeff's architectural principle: everything in Docker, nothing on host. Nanoclaw is agent orchestrator, not mail infrastructure. Phase 1/1.5/1.6 code lives in the wrong component. |
| Separate stacks: bridge and mailroom not co-located | Bridge is a vendor package (rebuilds on Proton bridge releases); mailroom is our code (iterates on our schedule). Consumers shouldn't own dependency lifecycle. Matches the tsdproxy_default precedent — dependency stack owns the network, consumer stack references it external. |
| Bridge stays on direct (non-stow) pattern | Already working; not worth touching in this migration. Migrate to stow later as a separate low-cost task. |
| Mailroom is stow-managed at `~/Projects/ConfigFiles/containers/mailroom/mailroom/` | Matches new-stack convention (trawl, mealie, gitlab, etc.). |
| Single `mailroom-local` image, multi-service by command | Matches trawl pattern. One Dockerfile, one `npm ci`, smaller surface to maintain. |
| inbox-mcp is internal-only, no tsdproxy | Madison is the only consumer; lives on jarvis. Tailnet exposure can be retrofitted later if cross-machine inbox access becomes a need. |
| inbox-mcp uses Streamable HTTP transport (not stdio) | Required for network-accessed MCP service. MCP SDK supports `StreamableHTTPServerTransport`. Same pattern trawl uses (FastMCP side). |
| Gmail OAuth credentials as RW bind mount, not env.vault | `credentials.json` is autowritten on token refresh — must be a writable file, not an env var. Migrate `~/.gmail-mcp/` to `~/containers/data/mailroom/gmail-mcp/` and bind-mount into ingestor. |
| Proton bridge password via env.vault pass-through | Stable secret, no in-place rewrite. `environment: - PROTONMAIL_BRIDGE_PASSWORD` in compose; pass-through matches trawl's OPENROUTER_API_KEY pattern. |
| `INBOX_DB_KEY` moves to mailroom env.vault | Same hex value, same SQLCipher behavior. Leaves nanoclaw's `.env` after the migration is verified. |
| Mailroom → nanoclaw event channel = IPC file directory | Simplest: mailroom writes event JSON files to a shared bind mount; nanoclaw's new `mailroom-subscriber` channel watches with `chokidar` (same pattern as existing `src/ipc.ts` IPC watcher). Avoids new HTTP webhook infrastructure. |
| Madison → inbox-mcp coupling = shared Docker network | New `mailroom_shared` external network. Bridge is on `protonmail_default`; mailroom's inbox-mcp is on `mailroom_shared`. Madison's container joins `mailroom_shared` when `folder === telegram_inbox`. Consistent with the tsdproxy_default pattern. |
| Cutover is staged, not flag-day | Mailroom deploys alongside running nanoclaw. New mailroom writes to its OWN `store.db` (different volume). Old nanoclaw ingestion keeps running during verification. Only after mailroom is stable do we switch Madison's MCP config, wire the subscriber, and retire nanoclaw's mail code. |

## Read first (for executors)

**Mailroom-side sources of truth**:
- `~/Projects/ConfigFiles/containers/trawl/trawl/docker-compose.yml` — stow stack exemplar (FastMCP, env.vault pass-through, tsdproxy network pattern).
- `~/Projects/ConfigFiles/containers/mealie/mealie/docker-compose.yml` — multi-service compose with health checks + dependencies.
- `~/Projects/ConfigFiles/bin/docker-compose/dcc` + Makefile — wrapper behavior; how env-vault integrates.
- `~/containers/tsdproxy/docker-compose.yml` — external network reference pattern.

**Code to transplant**:
- `src/inbox-store/db.ts` (includes Phase 1.6 `loadInboxDbKey` + cipher/key PRAGMAs).
- `src/inbox-store/{ingest,queries,watermarks,types}.ts`.
- `src/channels/gmail.ts` — Gmail API + poll loop.
- `src/channels/protonmail.ts` — IMAP via imapflow, HTML→Markdown, thread derivation.
- `src/channels/email-body.ts` — `pickBody`/`htmlToMarkdown` helper.
- `scripts/inbox-backfill-proton.ts` and `scripts/inbox-backfill-gmail.ts` — one-shot logic to become compose services.
- `container/inbox-mcp/src/{db,queries,index,types}.ts` — current stdio server; `index.ts` needs `StreamableHTTPServerTransport` wrap.
- `src/env.ts` — `readEnvFile` helper (mailroom should use env.vault pass-through instead; no need to port this).

**Nanoclaw-side integration**:
- `src/channels/registry.ts` — how channels self-register via `registerChannel(name, factory)`.
- `src/ipc.ts` — existing IPC watcher (chokidar on `~/containers/data/NanoClaw/data/ipc/`); mirror for mailroom-subscriber.
- `src/router.ts` + `src/group-queue.ts` — how inbound messages reach the group-queue + agent-runner.
- `src/container-runner.ts` — `--network` flag injection; `buildVolumeMounts` + `buildContainerArgs` gates on `folder === EMAIL_TARGET_FOLDER`.
- `container/agent-runner/src/index.ts` — MCP server registration (change `inbox` from stdio to HTTP: `{ type: 'http', url: 'http://inbox-mcp:8080/mcp' }` like trawl does).

## Phases

### Phase M0 — Scaffolding (setup) ✅

All items landed in ConfigFiles commit `421c97e` (2026-04-21). Executed as three waves: A (filesystem) → B (files) → C (stow + vault + commit).

- [x] **M0.1** `~/Projects/ConfigFiles/containers/mailroom/mailroom/` created; stowed directly via `stow --target=~/containers mailroom` (not `stow-all.sh` — the wrapper does `git pull` first which would interact with Jeff's pre-existing uncommitted CF changes). Symlink: `~/containers/mailroom → ../Projects/ConfigFiles/containers/mailroom/mailroom` — matches the trawl pattern exactly (`421c97e`).
- [x] **M0.2** `btrfs subvolume create ~/containers/data/mailroom` + `chown jeff:jeff` + `chmod 2775` (sudo required — the `~/containers/data` parent is root-owned). UUID `d0fd176c-eaff-044e-937b-4810f3657215`. Hourly snapshots auto-inherit via Jeff's standard policy — no per-subvol wiring needed.
- [x] **M0.3** `Dockerfile` scaffolded with the Phase 1.6 recipe: `npm ci --ignore-scripts && npm rebuild better-sqlite3 && npm run build && npm prune --omit=dev`. Build deps: python3/make/g++/libssl-dev for better-sqlite3-multiple-ciphers native compile (`421c97e`).
- [x] **M0.4** `package.json` with all listed deps + devDeps; `"type": "module"` + `"build": "tsc"`; scripts for start / start:mcp / backfill:{proton,gmail} / test (`421c97e`).
- [x] **M0.5** `docker-compose.yml` with 4 services (ingestor default, inbox-mcp, backfill-{proton,gmail} under `profiles: [backfill]`). Networks: `protonmail_default` declared external (bridge-owned); `mailroom_shared` owned here via `name: mailroom_shared` so Madison's container can attach by literal name. Env pass-through: INBOX_DB_KEY, PROTONMAIL_BRIDGE_PASSWORD, PROTONMAIL_ADDRESSES (`421c97e`).
- [x] **M0.6** `env.vault` created by Jeff via `env-vault edit env.vault`. 505B AES-256 ciphertext, mode 700. Holds INBOX_DB_KEY (same hex as nanoclaw `.env` — will be removed from nanoclaw at M5.7 cutover), PROTONMAIL_BRIDGE_PASSWORD, PROTONMAIL_ADDRESSES (`421c97e`).
- [x] **M0.7** Gmail creds migrated: `cp -r ~/.gmail-mcp/ ~/containers/data/mailroom/gmail-mcp/` — copy, not move, so nanoclaw's host-side Gmail channel keeps working during parallel operation until M5 cutover. Both files (`gcp-oauth.keys.json`, `credentials.json`) landed. RW perms preserved for token-refresh rewrite.
- [x] **M0.8** Committed to ConfigFiles as `421c97e` "mailroom: scaffold stow-managed stack (Phase M0)". Only `containers/mailroom/` staged; Jeff's pre-existing uncommitted files (`claude-code-url-handler.desktop` + `ollama-nvidia/cleanup-nvidia-symlinks.sh`) left untouched. Not pushed.

Out-of-band: `~/containers/data/mailroom/ipc-out/` created (dir for inbox event JSON files — referenced by M1.4 event schema).

### Phase M1 — Port ingestion code ✅

All items landed in ConfigFiles commit `a74e8c7` (2026-04-21). Executed as 3 parallel general-purpose subagents (store + events; gmail; proton) writing to disjoint directories, then inline ingestor + build + smoke test.

- [x] **M1.1** Store ported: `src/store/{db,ingest,queries,watermarks,types}.ts` from `nanoclaw src/inbox-store/`. `loadInboxDbKey()` reads only `process.env` (no `readEnvFile` — env.vault pass-through covers it). DATA_DIR hardcoded to `/var/mailroom/data` (override `MAILROOM_DATA_DIR`); store at `store.db` without an `inbox/` subdir (mailroom IS the inbox stack). `closeInboxDb()` promoted from `_closeInboxDb` internal-test export to public API — graceful shutdown is a production path in mailroom (`a74e8c7`).
- [x] **M1.2** Gmail ported: `src/gmail/{email-body,poller}.ts`. Refactored class-internal poll loop with `startGmailPoller({pollIntervalMs?})` as the only public export. Cred dir `/var/mailroom/gmail-mcp` (override `MAILROOM_GMAIL_CRED_DIR`); no `os.homedir()`. Removed: `Channel`/`sendMessage`/`onMessage`/`onChatMetadata`/`findEmailTargetJid`/preview formatting/`registerChannel`. Added: `emitInboxNew` after each `inserted: true` ingest. Missing creds throws (fatal in mailroom, unlike nanoclaw's warn-and-skip) (`a74e8c7`).
- [x] **M1.3** Protonmail ported: `src/proton/{thread,poller}.ts`. Host hardcoded to `protonmail-bridge:143` (Docker service DNS on `protonmail_default`, not the published `1143`). `tls: false`, `tls.rejectUnauthorized: false`. Config from `process.env`: `PROTONMAIL_BRIDGE_PASSWORD` (required), `PROTONMAIL_ADDRESSES` (CSV, trimmed). Extracted `parseReferencesHeader` + `deriveProtonThreadId` into `thread.ts`. Kept: POLL_STAGGER_MS=2000, per-address cooldown base 60s / max 15min, channel backoff max 30min, processedIds 5000/2500 trim, `\\Seen` flag after processing (`a74e8c7`).
- [x] **M1.4** Event schema + emitter: `src/events/types.ts` defines `InboxNewEvent` (event, version:1, source, account_id, message_id, source_message_id, thread_id, subject, sender:{email,name}, received_at, body_preview — 500-char truncation). `src/events/emit.ts` writes atomically (tmp + `fs.rename`) into `ipc-out/` with `crypto.randomUUID()` filename; creates the dir with `mkdirSync({recursive: true})` on first call (`a74e8c7`).
- [x] **M1.5** Ingestor entry `src/ingestor.ts`: eagerly opens DB (surfaces key/cipher errors at startup), awaits both pollers, registers SIGTERM/SIGINT → `Promise.allSettled([gmail.stop(), proton.stop()]) → closeInboxDb()` → exit(0). Fatal-logs + exits(1) on startup failure (`a74e8c7`).
- [x] **M1.6** Build + smoke test passed. `docker compose build` produced `mailroom-local:latest` (tsc ran cleanly in container; `npm prune --omit=dev` shrank image). `dcc up ingestor` smoke test: SQLCipher `store.db` created at `/var/mailroom/data/store.db`, Gmail poller connected as `jeff@americanvoxpop.com`, Protonmail poller connected to **5 addresses via Docker service DNS — zero ENOTFOUND**. First poll cycle ingested 3 previously-unread Protonmail emails and emitted matching `inbox:new` event JSON files. `inbox-mcp` service moved behind `profiles: [mcp]` so `dcc up ingestor` doesn't crash-loop on missing `dist/mcp-server.js` (Phase M2 lands that) (`a74e8c7`).

Side effect: the smoke test drained 3 weeks of backlogged Protonmail into mailroom's store. These emails will NOT appear in nanoclaw's host-side inbox store (which has been dark for that source since 2026-03-30); they are reachable only via mailroom once M2 lands the MCP server and M4 wires Madison's container. Acceptable per plan — nanoclaw's Proton path is already broken and scheduled for removal at M5.

### Phase M2 — HTTP MCP server ✅

All items landed in ConfigFiles commit `d5d79a6` (2026-04-21). Written inline (single subdomain, ~300 LOC including store/db.ts change). Verified end-to-end: initialize + tools/list + tools/call on live data.

- [x] **M2.1** Queries + types reused from `src/store/` rather than vendored — mailroom already has them from M1, and the nanoclaw `container/inbox-mcp/` copy was byte-for-byte identical below its "Vendored from…" banner. Single source of truth now. Only a read-only DB wrapper needed: added `MAILROOM_DB_READONLY=true` branch to `src/store/db.ts` that opens with `{readonly: true, fileMustExist: true}`, applies cipher PRAGMA, sets `query_only=true`, skips WAL + createSchema (`d5d79a6`).
- [x] **M2.2** `src/mcp/server.ts` — `createInboxMcpServer()` factory returning a configured MCP `Server` instance. Three tools (`mcp__inbox__{search,thread,recent}`) with the exact schemas from nanoclaw's stdio server. Handlers delegate to `searchMessages`/`getThread`/`getRecentMessages` from `../store/queries.js`. Helpers for arg-parsing (`requireString`, `optionalNumber`, etc.) ported verbatim (`d5d79a6`).
- [x] **M2.3** `src/mcp-server.ts` — Node `http.createServer` wrapping `StreamableHTTPServerTransport`. **Stateful session mode** (`sessionIdGenerator: crypto.randomUUID`); session-id tracked in `transports` Map, populated via `onsessioninitialized`, deleted via `transport.onclose`. `GET /health` returns `{status, sessions}` JSON. `POST /mcp` with no `mcp-session-id` initializes a new session; `POST /mcp` with known session-id routes to that transport; unknown session-id → 404. Listens on `MAILROOM_MCP_HOST:MAILROOM_MCP_PORT` (default `0.0.0.0:8080`). SIGTERM/SIGINT closes http server, closes all transports, closes DB, exits (`d5d79a6`).
- [x] **M2.4** Verified from peer container on `mailroom_shared` via `curlimages/curl` one-shot:
  - `GET /health` → `{"status":"ok","sessions":0}` (before handshake)
  - `POST /mcp initialize` → HTTP 200 + `mcp-session-id: 6a63e9b7-...` header + serverInfo `inbox-mcp@0.1.0`
  - `POST /mcp tools/list` (with session-id) → all three tool schemas returned as SSE event
  - `POST /mcp tools/call mcp__inbox__search {query:"burger"}` → FTS5 matched the P. Terry's Burger Stand email ingested earlier, returned full `SearchResult` through the SSE stream. End-to-end HTTP → MCP → SQLCipher-ro → SSE confirmed (`d5d79a6`).

Ops: `mailroom-inbox-mcp-1` container reports `(healthy)` per Docker healthcheck (node one-liner GETs `/health` every 30s). Both services (ingestor + inbox-mcp) running from the same `mailroom-local:latest` image.

### Phase M3 — Backfill as compose services ✅

All items landed in ConfigFiles commit `6e2ad9d` (2026-04-21). Ported by 2 parallel general-purpose subagents; tested inline with ingestor stopped.

- [x] **M3.1** Proton backfill `src/backfill/proton.ts` — descending UID walk per address (newest-first; Ctrl-C-safe). Connects to `protonmail-bridge:143` via Docker service DNS. Reads config from `process.env` only (no config.json, no readEnvFile). Cursor `proton.<addr>.{ceiling_uid, lowest_processed_uid}` in `/var/mailroom/data/backfill-cursor.json`. Reuses `deriveProtonThreadId` + `parseReferencesHeader` from `../proton/thread.js` and `extractProtonmailBody` from `../proton/poller.js` (promoted to export). Legacy flat-cursor migration dropped (mailroom starts fresh). CLI: `--address`, `--from-scratch`, `--dry-run`, `--batch-size`, `--floor-uid`. Sequential addresses with 2s stagger + 250ms between batches (`6e2ad9d`).
- [x] **M3.2** Gmail backfill `src/backfill/gmail.ts` — paginated `users.messages.list` from `--since` date (default 2 years). Reuses `createGmailClient` + `extractGmailBodyParts` from `../gmail/poller.js` (no OAuth duplication). Rate-limited (≤ 5 msg/sec per acceptance criterion). Atomic cursor writes (tmp+rename) into shared `backfill-cursor.json` keyed under `gmail`. CLI: `--since`, `--from-scratch`, `--dry-run`, `--max-messages`. SIGINT flushes cursor and exits 130 (`6e2ad9d`).
- [x] **M3.3** Compose services were scaffolded in M0 already (`profiles: [backfill]`); M3 just wired the `command:` entry points to the new `dist/backfill/{gmail,proton}.js` paths (already compose-declared). Invocation pattern: `env-vault env.vault -- docker compose --profile backfill run --rm backfill-{gmail,proton}` (plus any CLI flags). **Note**: `dcc` does not wrap `run`, so env-vault is called directly (`6e2ad9d`).
- [x] **M3.4** Idempotency verified in both directions:
  - Gmail: 1st real run → 2 inserted, 1 skipped. 2nd run → 0 inserted, 3 skipped. ✅
  - Proton (jeff@thestonefamily.us, batch-size 5) → 13 inserted (new), 4 skipped (overlap with live ingestor's earlier work), 0 errors. 2nd run → 0 inserted, 0 walked (cursor at floor). ✅
  - Dry-runs work cleanly (0 writes, full walk).

**Concurrency caveat (documented in the Proton port)**: the backfill and the live ingestor must NOT connect to the same Proton address simultaneously — the bridge rate-limits concurrent IMAP sessions for one user. The M3 smoke test stopped the ingestor via `docker compose stop ingestor` for ~90s and restarted after. Future full-history Proton backfill runs should follow the same pattern (or add a flag to the live poller that temporarily disables per-address polling while a backfill owns that address). Gmail has no equivalent concern — the API tolerates parallel reads fine.

Cursor race note from the Gmail agent's port: both backfills write the same `backfill-cursor.json`; atomic rename prevents torn writes but not lost updates if both run simultaneously (last writer wins for the other source's top-level key). In practice one page re-list on the next run; dedup absorbs. Could split into `backfill-cursor.{gmail,proton}.json` later if it matters.

### Phase M4 — Nanoclaw-side wiring (on `unified-inbox` branch)

- [ ] **M4.1** Add `src/channels/mailroom-subscriber.ts` — watches `~/containers/data/mailroom/ipc-out/` with chokidar, reads event JSON, calls `onMessage(targetJid, ...)` via existing router flow. Routes inbox events to Madison's Telegram group.
- [ ] **M4.2** Update `src/container-runner.ts` — when `folder === EMAIL_TARGET_FOLDER`, attach to `mailroom_shared` network so Madison can reach `http://inbox-mcp:8080/mcp`.
- [ ] **M4.3** Update `container/agent-runner/src/index.ts` — replace the stdio inbox MCP registration with HTTP: `{ type: 'http', url: 'http://inbox-mcp:8080/mcp' }` (same shape trawl uses).
- [ ] **M4.4** Update Madison's `groups/telegram_inbox/CLAUDE.md` if any behavior details reference the stdio path (probably nothing user-visible, but verify).

### Phase M5 — Cutover and cleanup (sequential, after M1–M4 verified)

- [ ] **M5.1** With mailroom stably ingesting, drain nanoclaw's host-side Gmail/Proton poll loops: set env flags to disable `GmailChannel` and `ProtonmailChannel` registration OR comment-out `import './gmail.js'` / `import './protonmail.js'` in `src/channels/index.ts`. Restart nanoclaw; verify no more duplicate writes.
- [ ] **M5.2** Delete `src/channels/gmail.ts`, `src/channels/gmail.test.ts`, `src/channels/protonmail.ts`, `src/channels/protonmail.test.ts`, `src/channels/email-body.ts`, `src/channels/email-body.test.ts`, `src/channels/email-routing.ts`, `src/channels/email-routing.test.ts`.
- [ ] **M5.3** Delete `src/inbox-store/` entirely.
- [ ] **M5.4** Delete `container/inbox-mcp/` entirely; remove Dockerfile stanza that builds it.
- [ ] **M5.5** Delete `scripts/inbox-backfill-proton.ts` and `scripts/inbox-backfill-gmail.ts`.
- [ ] **M5.6** Uninstall: `npm uninstall googleapis google-auth-library imapflow turndown nodemailer better-sqlite3 @types/better-sqlite3 @types/turndown @types/nodemailer`.
- [ ] **M5.7** Remove `INBOX_DB_KEY` from `~/containers/nanoclaw/.env`.
- [ ] **M5.8** Remove Gmail mount from `src/container-runner.ts`; remove Protonmail mount; remove inbox store bind mount (store.db lives in mailroom now).
- [ ] **M5.9** Remove `mcp__gmail__*` allowed tool from agent-runner allowlist (Madison uses mcp__inbox__* instead for reads; writes/replies go through mailroom if needed or are out of scope until Phase 2 of the original unified-inbox plan reincarnates).
- [ ] **M5.10** Full test suite + typecheck pass.
- [ ] **M5.11** Archive `~/containers/data/NanoClaw/data/inbox/` (the old store.db) to a backup location; it's no longer needed post-cutover.

### Phase M6 — Bridge hardening

- [ ] **M6.1** Verify no host process still reaches `protonmail-bridge` at `127.0.0.1:1143`. `ss -tnp | grep 1143` should show only docker-proxy.
- [ ] **M6.2** Edit `~/containers/protonmail/docker-compose.yml`: change `ports: ["1143:143/tcp", "1025:25/tcp"]` → `ports: ["127.0.0.1:1143:143/tcp", "127.0.0.1:1025:25/tcp"]`. `dcc up protonmail` to apply. Intermediate step — keeps loopback available in case of surprise host consumers.
- [ ] **M6.3** After 24h of stable operation with loopback binding, drop the `ports:` stanza entirely. Bridge is now reachable ONLY via `protonmail_default` Docker network. `dcc up protonmail` to apply.

### Phase M7 — Lode graduation

- [ ] **M7.1** Create `lode/architecture/mailroom.md` — high-level architecture snapshot (what's in each stack, networks, data flow, secrets).
- [ ] **M7.2** Update `lode/lode-map.md` + `lode/summary.md` to reflect the new component boundary.
- [ ] **M7.3** Update `lode/groups.md` with the new Madison Inbox MCP integration shape.
- [ ] **M7.4** Move this plan to `lode/plans/complete/` once all phases checked off.
- [ ] **M7.5** Graduate durable findings from this plan's `findings.md` into lode domain files; leave pointer notes in findings.md.

### Phase M8 — Update `/add-gmail` skill for mailroom-era fresh install

- [ ] **M8.1** Change target credentials dir: `~/.gmail-mcp/` → `~/containers/data/mailroom/gmail-mcp/`. The `npx -y @gongrzhe/server-gmail-autoauth-mcp auth` browser flow still runs on the host (OAuth callback needs host-side listener); only the output dir changes.
- [ ] **M8.2** Remove the "merge gmail channel into nanoclaw" steps (the `git remote add gmail`, `git merge gmail/main`, `src/channels/gmail.ts` validation) — obsolete because nanoclaw no longer owns that code post-extraction.
- [ ] **M8.3** Add a step to ensure `INBOX_DB_KEY` exists in mailroom's env.vault (generate via `scripts/inbox-keygen.ts` equivalent in the mailroom repo, paste via `env-vault edit`).
- [ ] **M8.4** Change the restart verb at the end from `systemctl --user restart nanoclaw` / `launchctl kickstart` → `dcc up mailroom` (picks up new credentials from the bind-mounted dir).
- [ ] **M8.5** Update the "Removal" section of the skill analogously.

### Phase M9 — Protonmail fresh-install documentation

- [ ] **M9.1** Audit: does an `/add-protonmail` skill exist in the nanoclaw skills dir? If yes, adapt it (similar changes to M8). If no, mailroom's README.md owns the fresh-install Proton setup docs.
- [ ] **M9.2** Document: `env-vault edit env.vault` → add `PROTONMAIL_BRIDGE_PASSWORD` + `PROTONMAIL_ADDRESSES` (comma-separated). Then `dcc up mailroom`. The bridge itself (login, creds) is a separate pre-req handled by the existing `~/containers/protonmail/` setup — mailroom docs reference but don't duplicate it.
- [ ] **M9.3** Note the migration-from-existing-install path separately from fresh-install: existing users have `~/.protonmail-bridge/config.json` + `PROTONMAIL_BRIDGE_PASSWORD` in nanoclaw's `.env`; one-time script to populate mailroom's env.vault from those sources.

## Errors

| Error | Resolution |
|---|---|

*(none yet)*

## Current status

**Phases M0 + M1 + M2 + M3 complete (ConfigFiles `421c97e`, `a74e8c7`, `d5d79a6`, `6e2ad9d`). Phase M4 (nanoclaw wiring) next.** Mailroom stack is self-sufficient — ingestion, encrypted storage, MCP query API, idempotent backfill all working end-to-end. Remaining work is on the nanoclaw side: wire Madison's agent container to reach mailroom's MCP, plus a `mailroom-subscriber` channel that drains `ipc-out/` events into the existing router/group-queue so fresh inbox arrivals surface in Madison's Telegram group.

Running on jarvis: `mailroom-ingestor-1` (up) + `mailroom-inbox-mcp-1` (healthy). Parallel-operation caveat unchanged — nanoclaw's host-side Gmail poller still racing with mailroom's until M5.

Known blockers: none. Next is M4 — 4 tasks: (1) `src/channels/mailroom-subscriber.ts` watching `~/containers/data/mailroom/ipc-out/`, (2) `--network mailroom_shared` on Madison's container at spawn (container-runner), (3) swap inbox MCP registration in agent-runner from stdio to `{type: 'http', url: 'http://inbox-mcp:8080/mcp'}`, (4) verify Madison's CLAUDE.md if any user-visible strings reference the stdio path.
