# Progress — NanoClaw Persistence Migration

## 2026-04-18 — Plan opened

Plan drafted from chat discussion about a-mem integration. NanoClaw persistence convention violation surfaced while scoping where ChromaDB data should live. Decision: fix the underlying convention gap (this plan) before bolting on a-mem (deferred Phase B).

Pre-flight research completed:
- Path references inventoried across codebase + env + lode (see findings.md)
- Ownership pattern confirmed against neighbors (`jeff:jeff 2775` for user-mode services)
- Snapshot directory confirmed at `~/containers/data/.snapshots/`
- Code mechanism (`NANOCLAW_DATA_ROOT` env var in `src/config.ts:45`) verified — no code changes needed

## Session actions

| Time | Action | Result |
|------|--------|--------|
| 16:47 | Wrote `lode/infrastructure/persistence.md` + `config-management.md` | ✓ |
| 16:47 | Created plan tracker/findings/progress | ✓ |
| 16:47 | Updated `lode/lode-map.md` to index new plan + infrastructure section | ✓ |
| 16:48 | Stopped nanoclaw service | ✓ (inactive) |
| 16:52 | `sudo btrfs subvolume create` + chown/chmod to `jeff:jeff 2775` | ✓ |
| 16:52 | rsync `~/Data/Nanoclaw/` → `~/containers/data/NanoClaw/` | ✓ 10,718 files, 218MB |
| 16:52 | Verify: `diff` of find/stat output + sqlite `PRAGMA integrity_check` | ✓ zero diff, integrity ok, 8 tables |
| 16:52 | Updated `.env`, `data/env/env`, `src/config.ts` comment | ✓ |
| 16:52 | Updated lode references: `summary.md`, `practices.md`, trading-group `progress.md`/`findings.md`, `tmp/handover-2026-04-18.md` | ✓ |
| 16:53 | Started nanoclaw; confirmed clean startup, 3 groups loaded, Telegram+Gmail connected | ✓ |
| 16:53 | `fuser` confirms service holds new DB; old DB has no open handles | ✓ |

## Tests / validation

| Test | Status | Notes |
|------|--------|-------|
| Service starts clean post-migration | ✓ | No errors in main log at 16:53; Telegram + Gmail connected |
| SQLite group state intact | ✓ | 3 groups loaded on startup (Jeff + telegram_trading + Nexus) |
| Service holds DB at new path | ✓ | `fuser` on new DB shows PID 2141818; old DB has no open handles |
| Test message round-trip in main group | ✓ | Jeff confirmed 17:51 |
| Downloads dir writable | ✓ | Round-trip exercised full container path |
| Snapshot picks up NanoClaw subvolume within 1hr | ✓ | `~/containers/data/.snapshots/NanoClaw/2026-04-18-170100/` captured at 17:01 |

## Error log

_(none yet)_

## Reboot check (for fresh session)

1. **Where am I?** Phase 1 complete (lode docs + plan written). Phase 2 (data migration) next.
2. **Where am I going?** Migrate `~/Data/Nanoclaw/` → `~/containers/data/NanoClaw/` as a BTRFS subvolume, update two env files, restart service.
3. **What is the goal?** Bring NanoClaw into conformance with the jarvis persistence convention so hourly snapshots cover its data.
4. **What have I learned?** The `NANOCLAW_DATA_ROOT` env var already decouples data location from code, so migration is a data move + env edit. No source changes. Ownership should match `jeff:jeff 2775` per neighboring user-mode subvolumes.
5. **What have I done?** Written `lode/infrastructure/{persistence,config-management}.md`, built plan files with full findings.

## Next after this plan completes

Phase B: a-mem integration into NanoClaw agent containers. Discussion pending with Jeff — do not start without alignment.
