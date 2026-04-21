# Groups

Current Telegram group roster (source of truth is `registered_groups` in SQLite; this doc captures *why* each one exists and its current identity).

| JID | Display name | Folder | Obsidian mount (host) | a-mem | Requires `@Madison` trigger |
|-----|--------------|--------|-----------------------|-------|-----|
| `tg:6847601234` | Jeff | `telegram_main` | `NanoClaw/Personal/` | ✓ | No (responds to everything) |
| `tg:-5273779685` | Madison Inbox | `telegram_inbox` | `NanoClaw/Inbox/` | ✓ | No (responds to everything) |
| `tg:-5211322204` | Madison AlgoTrader | `telegram_trading` | `NanoClaw/AlgoTrader/` | ✓ | No (responds to everything) |
| `tg:-1003800188692` | Madison AmericanVoxPop | `telegram_avp` | `NanoClaw/AmericanVoxPop/` | ✓ | Yes |

All Obsidian host paths are under `~/Documents/Obsidian/Main/` and mount into each container at `/workspace/extra/obsidian/` (Jeff, AVP) or `/workspace/extra/algotrader/` (AlgoTrader, renamed for clarity of role).

All a-mem ChromaDBs live under `~/containers/data/NanoClaw/a-mem/<folder>/` (BTRFS subvolume, hourly snapshots). Per-group isolation — no cross-group memory visibility.

## Email delivery target

Gmail and Protonmail channels deliver inbound emails via `findEmailTargetJid` in `src/channels/email-routing.ts`. Resolution order:

1. The group whose folder is `telegram_inbox` (the dedicated email-triage group — Madison Inbox).
2. Fallback: the first group flagged `isMain`.
3. If neither exists, the email is dropped with a debug log.

This exists because multiple groups can carry `is_main=1` (elevated-privilege flag), so picking "the main" is ambiguous for email delivery. The inbox folder is the unambiguous target.

## Base persona + specializations

All four groups share a common `@Madison` trigger and a base "Madison" persona. Each adds a specialization on top via its per-group CLAUDE.md:

- **Jeff main** — personal assistant, Obsidian workspace at `NanoClaw/Personal/`, a-mem for remembering preferences/habits.
- **Madison Inbox** — email-triage specialist; receives all email-related scheduled tasks (8 cron jobs: Proton sweeps, Samsung/BuilderTrend/etc. filters, auto-labeler health, 7am/9pm pause-resume). Email-worker scripts (`check-senders.mjs`, `cleanup-inbox.mjs`, `imap_autolabel.py`, `inbox-cleaner*`, `process-inbox.mjs`, `unsub-asked.json`, etc.) live in this group's workspace. Terse "TL;DR by default" posting style so the chat doesn't become a wall of text. *Inbox store access*: reads (sweep, search, thread fetch) go through `mcp__inbox__*` MCP tools; writes (reply, archive, label) still use `mcp__gmail__*` and Proton IMAP/SMTP directly.
- **AlgoTrader** — trading-strategy research. Full design in `plans/active/2026-04-trading-group/`. Heaviest specialization (6-agent roster, component library, Skeptic rubric, regime classifiers).
- **AmericanVoxPop** — company research. Thinner specialization; Obsidian vault pre-populated with Company Overview/, Digital Presence/, Organizations/, etc.

## Historical names (avoid confusion when reading older logs)

- `telegram_avp` was previously `telegram_nexus` with display name "Madison Nexus" (renamed 2026-04-18). Historical session logs under `~/containers/data/NanoClaw/groups/telegram_avp/logs/` reference the old name.

## Naming collision note

There are two `AlgoTrader` directories in the Obsidian vault:
- `~/Documents/Obsidian/Main/AlgoTrader/` (top-level, currently empty, reserved for Jeff's future ORB vault migration from `~/Projects/AlgoTrader/obsidian_vault/`)
- `~/Documents/Obsidian/Main/NanoClaw/AlgoTrader/` (Madison's workspace — the only one mounted into the container)

Resolve when the ORB migration begins — probably rename Jeff's personal one to `ORB/` or similar.

## Related

- `plans/active/2026-04-trading-group/` — full design for the AlgoTrader group (Phase 1 complete)
- `plans/active/2026-04-amem-integration/` — a-mem wiring plan (current)
- `practices.md` — per-group data layout convention
- `infrastructure/persistence.md` — where group data lives on disk
