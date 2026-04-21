# Mailroom Extraction — Progress Log

## Timeline

### 2026-04-21

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

1. **Where am I?** Phase M0 complete (ConfigFiles `421c97e`). Scaffold exists: stow package + btrfs subvolume + Dockerfile/package.json/compose + encrypted env.vault + Gmail creds staged. `docker compose build` hasn't been attempted yet — will fail until M1 puts source under `src/` (Dockerfile's `COPY src/` has no source). Nanoclaw's host-side Gmail ingestion still running in parallel.
2. **Where am I going?** Phase M1 — port nanoclaw's mail ingestion into `mailroom/src/`: `src/inbox-store/*` → `mailroom/src/store/`; `src/channels/gmail.ts` + `email-body.ts` → `mailroom/src/gmail/`; `src/channels/protonmail.ts` → `mailroom/src/proton/` with `host: protonmail-bridge` / port 143 (not 1143); event-schema IPC emitter (M1.4); `src/ingestor.ts` entry point.
3. **What is the goal?** Unchanged — clean component boundary, everything in Docker, Protonmail ENOTFOUND resolved via Docker service DNS.
4. **What have I learned?** See findings.md. M0-specific additions: `~/containers/data` is root-owned (subvolume create needs sudo); `stow-all.sh` does `git pull` first so prefer direct `stow` when CF has pre-existing uncommitted changes; env.vault format is AES-256 text, mode 700, committed in ConfigFiles.
5. **What have I done?** M0 landed as commit `421c97e`: 4 files (Dockerfile, package.json, docker-compose.yml, env.vault) + btrfs subvolume + Gmail creds copy + ipc-out/ dir. Nanoclaw lode tracker + progress.md + MEMORY index updated to reflect. Next session: start M1 (port ingestion code).

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
