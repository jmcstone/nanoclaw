# Findings — NanoClaw Persistence Migration

## Path references to `~/Data/Nanoclaw` in the codebase

Searched 2026-04-18. All references are documentation or env config — no hardcoded paths in source code.

| File | Line | Context | Action |
|------|------|---------|--------|
| `.env` | 7 | `NANOCLAW_DATA_ROOT=~/Data/Nanoclaw` | Change |
| `data/env/env` | 7 | `NANOCLAW_DATA_ROOT=~/Data/Nanoclaw` | Change (mirrors `.env` for container visibility) |
| `src/config.ts` | 45 | Comment: `// Optional external data root (e.g. ~/Data/Nanoclaw for BTRFS snapshots).` | Update example to new path |
| `lode/summary.md` | 3 | `persistent data under ~/Data/Nanoclaw` | Update |
| `lode/practices.md` | (tbc) | — | Update if referenced |
| `lode/plans/active/2026-04-trading-group/progress.md` | multiple | Path references in Phase 1 infra log | Update |
| `lode/plans/active/2026-04-trading-group/findings.md` | (tbc) | — | Update if referenced |
| `lode/tmp/handover-2026-04-18.md` | multiple | Handover doc mentions path in gotchas + critical facts | Update |

## Code mechanism

From `src/config.ts:45-64`:

```typescript
const rawDataRoot = process.env.NANOCLAW_DATA_ROOT || envConfig.NANOCLAW_DATA_ROOT || '';
const DATA_ROOT = rawDataRoot ? path.resolve(rawDataRoot.replace(/^~/, HOME_DIR)) : '';

export const STORE_DIR     = DATA_ROOT ? path.resolve(DATA_ROOT, 'store')     : path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR    = DATA_ROOT ? path.resolve(DATA_ROOT, 'groups')    : path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR      = DATA_ROOT ? path.resolve(DATA_ROOT, 'data')      : path.resolve(PROJECT_ROOT, 'data');
export const DOWNLOADS_DIR = DATA_ROOT ? path.resolve(DATA_ROOT, 'downloads') : path.resolve(PROJECT_ROOT, 'downloads');
```

`~` is expanded against `$HOME` at startup. No other code touches these paths directly — `STORE_DIR`, `GROUPS_DIR`, `DATA_DIR`, `DOWNLOADS_DIR` are the exports consumed elsewhere.

## Current data under `~/Data/Nanoclaw/`

```
238M total
├── data/
├── downloads/
├── groups/           # per-group state (CLAUDE.md, session state, logs)
└── store/            # SQLite (messages.db)
```

Small enough that rsync is trivial. Critical file: `store/messages.db` (group registrations, message history, session IDs).

## Ownership parity check on `~/containers/data/`

Neighbors by ownership:

- **jeff:jeff 2775** (user-mode services): calibre, gitlab, siftly
- **root:root 0755** (Docker-managed): beszel, mealie, karakeep, paperless, obsidian-livesync, ollama-nvidia
- **999:jeff** (container-UID-specific): neural-finance

NanoClaw runs as systemd `--user` service under `jeff` — matches the first group. Use `2775` + `jeff:jeff`.

## Snapshot directory

Confirmed: `~/containers/data/.snapshots/` contains one directory per existing subvolume. A new subvolume at `~/containers/data/NanoClaw/` will be picked up on the next snapshot cycle automatically.

## Service management

```
/home/jeff/.config/systemd/user/nanoclaw.service
```

Unit definition:
- `ExecStart=/usr/bin/node /home/jeff/containers/nanoclaw/dist/index.js`
- `WorkingDirectory=/home/jeff/containers/nanoclaw`
- `Environment=HOME=/home/jeff` — `~` expansion in `NANOCLAW_DATA_ROOT` resolves against this

No systemd-level changes needed; the env var change in `.env` + `data/env/env` is sufficient.

## Config files NOT stow-managed (noted for gap tracking, not migration scope)

- `~/.claude.json` — holds MCP server registrations; not in `~/Projects/ConfigFiles/home/claude/`
- `~/.config/nanoclaw/mount-allowlist.json` — jeff-owned, not in stow
- `~/.config/systemd/user/nanoclaw.service` — may or may not be in stow; check separately

These are gaps in the rebuild story but not in scope for this plan.

## Related

- [tracker.md](tracker.md)
- [progress.md](progress.md)
- [../../../infrastructure/persistence.md](../../../infrastructure/persistence.md)
