# Groups

Current Telegram group roster (source of truth is `registered_groups` in SQLite; this doc captures *why* each one exists and its current identity).

| JID | Display name | Folder | Role | Requires `@Madison` trigger |
|-----|--------------|--------|------|-----|
| `tg:6847601234` | Jeff | `telegram_main` | Personal chat — general assistant, scheduled tasks, daily briefing | No (responds to everything) |
| `tg:-5211322204` | Madison AlgoTrader | `telegram_trading` | Trading research + strategy R&D. See `plans/active/2026-04-trading-group/` | No (responds to everything) |
| `tg:-1003800188692` | Madison AmericanVoxPop | `telegram_avp` | Company research for American Vox Pop. Obsidian vault at `~/Documents/Obsidian/Main/NanoClaw/AmericanVoxPop/` | Yes |

## Base persona + specializations

All three groups share a common `@Madison` trigger and a base "Madison" persona. AlgoTrader and AmericanVoxPop add thin specializations on top of the base via their per-group CLAUDE.md. The main (Jeff) group has no specialization — it's Madison at her most general.

## Historical names (avoid confusion when reading older logs)

- `telegram_avp` was previously `telegram_nexus` with display name "Madison Nexus" (renamed 2026-04-18). Historical session logs under `~/containers/data/NanoClaw/groups/telegram_avp/logs/` reference the old name.

## Related

- `plans/active/2026-04-trading-group/` — full design for the AlgoTrader group (Phase 1 complete)
- `practices.md` — per-group data layout convention
- `infrastructure/persistence.md` — where group data lives on disk
