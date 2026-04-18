# Lode Map

Authoritative index of project memory. Read this first.

## Root
- [summary.md](summary.md) — one-paragraph living snapshot
- [terminology.md](terminology.md) — domain vocabulary
- [practices.md](practices.md) — patterns and invariants
- [groups.md](groups.md) — current Telegram group roster and identities

## Plans
- `plans/active/` — in-progress trackers
  - [2026-04-trading-group](plans/active/2026-04-trading-group/tracker.md) — Telegram trading-research group with PDF ingestion, nightly web research, backtest orchestration, and 6-agent swarm
    - **[topics-status.md](plans/active/2026-04-trading-group/topics-status.md)** — topic-by-topic current state (read this first for the design map)
  - [2026-04-nanoclaw-migration](plans/active/2026-04-nanoclaw-migration/tracker.md) — migrate persistent data from `~/Data/Nanoclaw/` to `~/containers/data/NanoClaw/` (BTRFS subvolume, snapshotted)
- `plans/complete/` — historical reference

## History
- `history/` — timestamped daily summaries of notable changes (created as needed)

## Infrastructure
- [infrastructure/persistence.md](infrastructure/persistence.md) — `~/containers/data/<Project>/` BTRFS subvolume convention + hourly snapshots
- [infrastructure/config-management.md](infrastructure/config-management.md) — GNU Stow + `~/Projects/ConfigFiles/` for dotfiles; rebuild goal

## Domain areas
_(None yet. Create focused directories as the project grows: `channels/`, `groups/`, `ipc/`, etc.)_

## External lodes
- `~/Projects/AlgoTrader/lode/` — Python backtesting framework with ORB research, strategy architecture, and anti-overfit practices. The trading group defers to this lode for backtest methodology.
