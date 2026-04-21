# Mailroom Extraction — Progress Log

## Timeline

### 2026-04-21

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

1. **Where am I?** Plan just created. All design decisions locked (see tracker Decisions table). No code written yet. Nanoclaw's existing `unified-inbox` branch has Phase 1.6 (SQLCipher) deployed and running; it ingests Gmail into its own encrypted `store.db`. That keeps running in parallel until mailroom's M5 cutover.
2. **Where am I going?** A standalone `mailroom` Docker stack at `~/Projects/ConfigFiles/containers/mailroom/mailroom/` that owns Proton + Gmail ingestion, SQLCipher-encrypted `store.db`, Streamable HTTP MCP query API, and backfill-as-compose-services. Nanoclaw shrinks to router + orchestrator + chat channels + a new `mailroom-subscriber` channel.
3. **What is the goal?** Clean component boundary: mail infrastructure is Docker-native, nanoclaw is lean. Bridge drops its `0.0.0.0` port publishing. Host-side Protonmail channel disappears (along with the ENOTFOUND problem). Everything aligns with Jeff's architectural principle: "everything in Docker, nothing on the host."
4. **What have I learned?** See findings.md — stow + env-vault + dcc patterns, cross-compose networking via external networks, Gmail OAuth needs RW bind mount (not env), Phase 1.6 SQLCipher transplants intact, Protonmail ENOTFOUND dates back to 2026-03-30 config edit + 20:21 restart.
5. **What have I done?** Nothing yet in this plan. Session that produced this plan included: diagnosing the ENOTFOUND issue back to its origin PID-by-PID, co-designing the mailroom architecture with Jeff, running discovery on his compose/env-vault/dcc/tsdproxy conventions, documenting findings, writing this tracker.

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
