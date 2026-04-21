# Mailroom Extraction — Progress Log

## Timeline

### 2026-04-21

- **18:07 CDT** — **Phase M3 complete.** 2 parallel general-purpose subagents ported the backfill scripts (Gmail: 265 → 343 LOC; Proton: 501 → 617 LOC — line growth is mostly new cursor-atomic-rename + signal handling). Idempotency is "free" via `ingestMessage`'s `ON CONFLICT DO NOTHING` on `(source, source_message_id)`. Ingestor stopped during smoke test to respect the bridge's concurrent-session limits. Gmail: 2 inserted then 0 (idempotent). Proton (single address --batch-size 5): 13 inserted then 0 (cursor at floor). Learned: `dcc up` handles env.vault injection but `dcc` has no `run` target, so backfills invoke via `env-vault env.vault -- docker compose --profile backfill run --rm ...` directly. Ingestor restarted post-test; still polling both sources. Commit `6e2ad9d` in ConfigFiles.
- **17:55 CDT** — **Phase M2 complete.** Written inline (~300 LOC across `src/mcp/server.ts` factory + `src/mcp-server.ts` HTTP wrapper + a `MAILROOM_DB_READONLY` branch on `src/store/db.ts`). Design call: reuse mailroom's existing `src/store/queries.ts` + `types.ts` instead of vendoring a copy like nanoclaw had. HTTP server is Node `http` stdlib (no express dep); stateful session mode with session-id tracking in a Map; `/health` endpoint returns sessions count; Docker healthcheck via a node one-liner in `docker-compose.yml`. Stateful was the right call — initialize → tools/list chain needs session continuity and the SDK examples use stateful as the default pattern. Rebuild + `dcc up inbox-mcp` succeeded on first try. Verified end-to-end from a peer `curlimages/curl` container on `mailroom_shared`: initialize handshake returns session-id + serverInfo; tools/list returns all three tools; tools/call for `mcp__inbox__search {query: "burger"}` matched the P. Terry's email FTS5-style. inbox-mcp service marked `(healthy)`. Commit `d5d79a6` in ConfigFiles.
- **17:45 CDT** — **Phase M1 complete.** Executed via 3 parallel general-purpose subagents (chosen over lode-executor to avoid atomic-commit races in a foreign repo, and to bundle the cross-subdomain port into a single reviewable commit). Scope per agent: (a) store + event schema + logger + tsconfig, (b) Gmail poller + email-body, (c) Proton poller + thread helpers. All 3 returned clean, no conflicts, files in disjoint directories. Inline after agents returned: `src/ingestor.ts` entry point (35 lines); `.gitignore`; one 1-line type fix promoting `_closeInboxDb` → `closeInboxDb` in the store module so ingestor's SIGTERM path can call it. `npm install` generated the lockfile. `npx tsc --noEmit` passed. `docker compose build` succeeded on first try (tsc inside container ran cleanly, 13.8s total build). `dcc up ingestor` smoke test worked on first try — env.vault injected INBOX_DB_KEY + PROTONMAIL_BRIDGE_PASSWORD + PROTONMAIL_ADDRESSES into the container, SQLCipher store opened, Gmail OAuth connected, Proton IMAP connected via Docker service DNS for the first time (ENOTFOUND resolved), 3 backlogged Protonmail emails ingested and events emitted. Commit `a74e8c7` in ConfigFiles. Mailroom ingestor is currently RUNNING on jarvis alongside nanoclaw; Jeff to decide whether to stop it before M4 subscriber is wired or leave running to accumulate events for M2-M4 testing.
- **23:50 CDT** — **Phase M0 complete.** Executed as three waves. Wave A (filesystem): M0.1 ConfigFiles dir + stow symlink to `~/containers/mailroom/` matching trawl's relative-link pattern; M0.2 btrfs subvolume (sudo required — `~/containers/data` is root-owned); M0.7 Gmail creds `cp -r` into the new subvolume (preserves nanoclaw's `~/.gmail-mcp/` for parallel operation). Wave B (files): `Dockerfile` (Phase 1.6 recipe: --ignore-scripts + explicit rebuild), `package.json` (all listed deps + vitest), `docker-compose.yml` (4 services, two networks — `mailroom_shared` owned-with-explicit-`name` so external consumers attach by literal name). Wave C: stow-link via direct `stow` (skipped `stow-all.sh` to avoid its `git pull` side effect on pre-existing uncommitted CF changes); Jeff created the env.vault interactively; M0.8 single commit `421c97e` in ConfigFiles — only `containers/mailroom/` staged. Also created `~/containers/data/mailroom/ipc-out/` out of band (referenced by M1.4 event schema).
- **23:30 CDT** — Plan created. Three-file pattern initialized at `lode/plans/active/2026-04-mailroom-extraction/`. Branch context: mailroom stack itself lives in a separate repo (`~/Projects/ConfigFiles/containers/mailroom/`); nanoclaw-side changes (Phases M4, M5) layer on the existing `unified-inbox` branch (currently 33 commits ahead of main with Phase 0/1/1.5/1.6 landed). Decisions table fully populated from chat-mode design session with Jeff: separate bridge/mailroom stacks, stow-managed mailroom, direct bridge, single `mailroom-local` image, internal-only inbox-mcp (no tsdproxy), RW bind mount for Gmail creds, env.vault for static secrets, IPC-file event channel, staged cutover. Ready to begin M0 scaffolding.
- **23:05 CDT** — **Architectural pivot from `unified-inbox`** (see that plan's progress.md entry at same timestamp for full diagnosis). Summary: host-side Protonmail channel has been ENOTFOUND-dark since 2026-03-30 because `host.docker.internal` doesn't resolve from the host process; Madison's container-side path worked because nanoclaw's container-runner injects `--add-host=host.docker.internal:host-gateway`. Jeff raised the deeper question of whether mail ingestion belongs in nanoclaw at all. Agreed extraction approach. Unified-inbox tracker has Phase 1.6 SQLCipher checked off and the pivot decision recorded; further phases of that tracker reincarnate here.

## Test results

| Test | Status | Notes |
|---|---|---|

*(none yet — first build after M0.6)*

## Error log

*(none yet)*

## 5-question reboot check

Update before any resumption after a session break.

1. **Where am I?** Phases M1 + M2 + M3 complete (ConfigFiles `a74e8c7`, `d5d79a6`, `6e2ad9d`). Mailroom stack is fully self-sufficient: ingestion + encrypted store + HTTP MCP server + idempotent backfill, all smoke-tested. Running on jarvis: `mailroom-ingestor-1` (up) and `mailroom-inbox-mcp-1` (healthy).
2. **Where am I going?** Phase M4 — wire the nanoclaw side to talk to mailroom. Four tasks: (1) `src/channels/mailroom-subscriber.ts` that watches `~/containers/data/mailroom/ipc-out/` with chokidar and routes `inbox:new` events into Madison's Telegram group via the existing router/group-queue, (2) `--network mailroom_shared` on Madison's spawned container (via `src/container-runner.ts`, gated on `folder === EMAIL_TARGET_FOLDER`), (3) swap inbox MCP registration in `container/agent-runner/src/index.ts` from stdio to `{type: 'http', url: 'http://inbox-mcp:8080/mcp'}` (same shape trawl uses), (4) audit `groups/telegram_inbox/CLAUDE.md` for any user-visible strings that reference the stdio path.
3. **What is the goal?** Unchanged — clean component boundary. M3 closed out mailroom-side work; M4 connects the other half of the bridge (nanoclaw-as-consumer).
4. **What have I learned?** (a) `dcc` wraps `up` / `down` / `restart` / etc. but NOT `run` — backfills invoke via `env-vault env.vault -- docker compose --profile backfill run --rm ...` directly. (b) Proton bridge rate-limits concurrent IMAP sessions for one user — live poller + backfill on the same address is a bad combo. Stop the ingestor before backfilling any address the live poller owns. (c) Shared cursor file (`backfill-cursor.json`) between Gmail + Proton backfills has a lost-update race if both run concurrently; not a correctness issue thanks to `ON CONFLICT DO NOTHING`, but worth splitting later if they ever need to run simultaneously.
5. **What have I done?** M3 landed as ConfigFiles `6e2ad9d`: 3 files (2 new — `src/backfill/{gmail,proton}.ts`; 1 tiny modified — `src/proton/poller.ts` promoted `extractProtonmailBody` to export). Gmail + Proton backfills both tested real → re-run, idempotent. Nanoclaw lode tracker + progress.md updated.

## Decisions resolved 2026-04-21

All design decisions are in the tracker Decisions table. Briefly:

1. **Separate stacks** — bridge and mailroom are distinct; bridge stays direct pattern, mailroom is stow.
2. **Single image** — one `mailroom-local` image, services differ by `command:`.
3. **Internal MCP** — inbox-mcp stays on `mailroom_shared` network; no tsdproxy exposure.
4. **Gmail creds** — RW bind mount `~/containers/data/mailroom/gmail-mcp/`.
5. **Proton password** — env.vault pass-through.
6. **INBOX_DB_KEY** — moves to mailroom env.vault (leaves nanoclaw `.env`).
7. **Event channel** — IPC file directory; nanoclaw's `mailroom-subscriber` watches with chokidar.
8. **Madison ↔ inbox-mcp** — shared `mailroom_shared` network; service-name DNS.
9. **Cutover** — staged; mailroom runs alongside old path until verified.
10. **Branch** — nanoclaw-side changes layer on `unified-inbox`.
11. **Classification** — stays in nanoclaw subscriber; mailroom is ingestion/storage only.
