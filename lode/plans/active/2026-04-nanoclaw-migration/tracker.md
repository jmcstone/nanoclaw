# 2026-04 NanoClaw Persistence Migration

Branch: `main`

## Goal

Migrate NanoClaw persistent data from `~/Data/Nanoclaw/` (outside convention, not snapshotted) to `~/containers/data/NanoClaw/` (BTRFS subvolume, auto-snapshotted), bringing NanoClaw into conformance with the jarvis persistence convention documented in [lode/infrastructure/persistence.md](../../../infrastructure/persistence.md).

Data controlled by the `NANOCLAW_DATA_ROOT` env var — the code already supports arbitrary roots, so the migration is a data move + two env edits.

## Phases

### Phase 1 — Pre-flight & docs
- [x] Document persistence convention in lode (`infrastructure/persistence.md`)
- [x] Document config-management convention in lode (`infrastructure/config-management.md`)
- [x] Inventory all path references to `~/Data/Nanoclaw` in codebase, env files, and group CLAUDE.md (captured in findings.md)
- [x] Confirm no in-flight tasks / active conversations that would be disrupted by a restart (no running containers at stop time)

### Phase 2 — Migrate data
- [x] Stop nanoclaw service: `systemctl --user stop nanoclaw`
- [x] Create BTRFS subvolume: `sudo btrfs subvolume create /home/jeff/containers/data/NanoClaw`
- [x] Set ownership to `jeff:jeff`, mode `2775` (match calibre/gitlab/siftly)
- [x] rsync contents (10,718 files, 218MB, zero diff)
- [x] Verify file counts, sizes, and SQLite DB integrity (`integrity_check: ok`, 8 tables)

### Phase 3 — Update config
- [x] Update `.env`: `NANOCLAW_DATA_ROOT=~/containers/data/NanoClaw`
- [x] Update `data/env/env`: same change
- [x] Update `src/config.ts` comment example
- [x] Update `lode/summary.md` to reflect new data path
- [x] Update `lode/practices.md` group data path
- [x] Update trading-group plan docs (`progress.md`, `findings.md`, handover)
- [x] Update `lode/lode-map.md` to index new plan + `infrastructure/`

### Phase 4 — Restart & validate
- [x] Start nanoclaw service
- [x] Confirm startup clean — DB initialized, 3 groups loaded, Telegram+Gmail connected, no errors in main log (Protonmail `host.docker.internal` warning is preexisting, unrelated)
- [x] Confirm SQLite state (group registrations intact — 3 groups loaded)
- [x] Confirm service holds DB at new path (`fuser` on new DB returns nanoclaw PID; old DB has no open handles)
- [x] Send test message to main group, verify round-trip response (Jeff confirmed 2026-04-18 17:51)
- [x] Confirm downloads directory still works (implicit — message round-trip exercised full container path)
- [x] First hourly snapshot captured: `~/containers/data/.snapshots/NanoClaw/2026-04-18-170100/`

### Phase 5 — Cleanup (after 24h of stable operation)
- [ ] Archive old `~/Data/Nanoclaw/` (tar.gz to `/tmp/` or delete directly if confident)
- [ ] If parent `~/Data/` is now empty, remove it
- [ ] Close out plan, graduate to `plans/complete/`

## Decisions

| Decision | Rationale |
|----------|-----------|
| Use `~/containers/data/NanoClaw/` (capitalized) | Matches stow-package style (`NanoClaw` in Obsidian vault and mount-allowlist already uses this form); other subvolumes are lowercase but NanoClaw's brand is CamelCase |
| Own as `jeff:jeff` `2775` with setgid | Matches user-mode-service neighbors (calibre, gitlab, siftly); setgid keeps new files in `jeff` group |
| `NANOCLAW_DATA_ROOT` env var stays the mechanism | Code already supports it; no code changes needed — only path values in `.env` and `data/env/env` |
| Keep old `~/Data/Nanoclaw/` until validation + one snapshot cycle | Cheap rollback insurance; 238MB is negligible |
| Do not bundle a-mem integration into this migration | Separate phase per user decision (Phase B, to be planned after A lands) |

## Errors

| Error | Resolution |
|-------|-----------|
| _(none yet)_ | |

## Current Status

Phase 4 complete — migration fully validated end-to-end. Round-trip message works, hourly snapshot captured at `2026-04-18-170100`. Phase 5 cleanup (delete old `~/Data/Nanoclaw/`) scheduled for 2026-04-19 or later after 24h of stable operation.
