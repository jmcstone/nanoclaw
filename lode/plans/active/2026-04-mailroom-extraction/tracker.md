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

### Phase M0 — Scaffolding (setup)

- [ ] **M0.1** Create `~/Projects/ConfigFiles/containers/mailroom/mailroom/` directory tree; run `bin/stow/stow-all.sh` (or equivalent) to symlink into `~/containers/mailroom/`.
- [ ] **M0.2** Initialize BTRFS subvolume at `~/containers/data/mailroom/` matching the other stacks (permissions `jeff:jeff 2775`, hourly snapshot policy).
- [ ] **M0.3** Scaffold `Dockerfile` (FROM node:22-slim, single build stage, `npm ci --ignore-scripts && npm rebuild better-sqlite3 && npm run build && npm prune --omit=dev` — same pattern as the Phase 1.6 fix).
- [ ] **M0.4** Scaffold `package.json` — deps: `better-sqlite3` (aliased to `better-sqlite3-multiple-ciphers@11.10.0`), `imapflow`, `googleapis`, `google-auth-library`, `turndown`, `nodemailer`, `pino`, `pino-pretty`, `@modelcontextprotocol/sdk`, `chokidar`. Dev deps: typescript, types, vitest.
- [ ] **M0.5** Scaffold `docker-compose.yml` with the 4 services (ingestor, inbox-mcp, backfill-proton, backfill-gmail), two external networks (`protonmail_default`, `mailroom_shared`), `.env`-passthrough pattern.
- [ ] **M0.6** Create `env.vault` via `env-vault edit env.vault` with `INBOX_DB_KEY`, `PROTONMAIL_BRIDGE_PASSWORD` (copied from nanoclaw's `.env`).
- [ ] **M0.7** Migrate Gmail credentials: `cp -r ~/.gmail-mcp/ ~/containers/data/mailroom/gmail-mcp/`.
- [ ] **M0.8** Commit the new ConfigFiles directory to the ConfigFiles repo.

### Phase M1 — Port ingestion code

- [ ] **M1.1** Transplant `src/inbox-store/{db,ingest,queries,watermarks,types}.ts` from nanoclaw → mailroom `src/store/`. Adjust imports (mailroom's `DATA_DIR` = `/var/mailroom/data` inside container, or whatever the mount path is).
- [ ] **M1.2** Transplant `src/channels/gmail.ts` + `src/channels/email-body.ts` → mailroom `src/gmail/`. Decouple from nanoclaw's `onMessage(targetJid, msg)` dispatch — in mailroom, ingestion writes to store.db AND emits an IPC event JSON to `ipc-out/`.
- [ ] **M1.3** Transplant `src/channels/protonmail.ts` → mailroom `src/proton/`. Change `config.host` from `host.docker.internal` to `protonmail-bridge` (Docker service DNS) and port from `1143` to `143` (internal, not published). Ingest path mirrors M1.2.
- [ ] **M1.4** Define event schema: `~/containers/data/mailroom/ipc-out/inbox-new-<uuid>.json` with shape `{ source, account_id, message_id, subject, sender, received_at, urgency_hint? }`.
- [ ] **M1.5** Write `src/ingestor.ts` entry point — loads config, starts gmail + proton pollers, handles graceful shutdown on SIGTERM.
- [ ] **M1.6** Build + test: `docker compose build`, then `dcc up mailroom` starts the ingestor cleanly.

### Phase M2 — HTTP MCP server

- [ ] **M2.1** Port `container/inbox-mcp/src/{db,queries,types}.ts` → mailroom `src/mcp/`. Adjust for Streamable HTTP.
- [ ] **M2.2** Replace stdio transport with `StreamableHTTPServerTransport` from `@modelcontextprotocol/sdk/server/streamableHttp`. Listen on port 8080 inside container. Follow MCP SDK HTTP server example.
- [ ] **M2.3** Write `src/mcp-server.ts` entry point — session management, graceful shutdown, health check endpoint.
- [ ] **M2.4** Verify: `curl -X POST http://<inbox-mcp-ip>:8080/mcp` handshake from another container on `mailroom_shared` returns all three tool names.

### Phase M3 — Backfill as compose services

- [ ] **M3.1** Port `scripts/inbox-backfill-proton.ts` → mailroom `src/backfill/proton.ts`. Same logic, different imports, different config entry (from env.vault).
- [ ] **M3.2** Port `scripts/inbox-backfill-gmail.ts` → mailroom `src/backfill/gmail.ts`.
- [ ] **M3.3** Add `backfill-proton` and `backfill-gmail` services to docker-compose with `profiles: [backfill]` so they don't start with `dcc up mailroom`. Invoked via `docker compose run --rm backfill-proton`.
- [ ] **M3.4** Test both — dry-runs first, then real runs. Verify idempotency (second run inserts 0 new rows).

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

**Phase M0 pending.** All design decisions locked. Ready to begin scaffolding the ConfigFiles mailroom directory. Running nanoclaw service continues to ingest Gmail into its own encrypted `store.db` (Phase 1.6 deployed on `unified-inbox`) — unaffected by mailroom work until M5 cutover.

Known blockers: none. The bridge's `host: "host.docker.internal"` in `~/.protonmail-bridge/config.json` stays in place until M5 (nanoclaw no longer reads it); mailroom's ingestor reads its own config with `host: "protonmail-bridge"`.
