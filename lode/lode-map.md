# Lode Map

Authoritative index of project memory. Read this first.

## Root
- [summary.md](summary.md) — one-paragraph living snapshot
- [terminology.md](terminology.md) — domain vocabulary
- [practices.md](practices.md) — patterns and invariants
- [groups.md](groups.md) — current Telegram group roster and identities
- [tech-debt.md](tech-debt.md) — registry of deferred work with trigger conditions

## Plans
- `plans/active/` — in-progress trackers
  - [2026-04-trading-group](plans/active/2026-04-trading-group/tracker.md) — Telegram trading-research group with PDF ingestion, nightly web research, backtest orchestration, and 6-agent swarm
    - **[topics-status.md](plans/active/2026-04-trading-group/topics-status.md)** — topic-by-topic current state (read this first for the design map)
  - [2026-04-context-mode-integration](plans/active/2026-04-context-mode-integration/tracker.md) — add context-mode MCP + hooks to agent container for ~98% tool-output context-window savings; supersedes earlier defer decision
  - [2026-04-trawl-mcp-integration](plans/active/2026-04-trawl-mcp-integration/tracker.md) — expose Trawl's 40+ tools as a tailnet-reachable MCP service at `trawl.crested-gecko.ts.net`; usable from Madison, dev Claude Code, and future clients. Server-first rollout.
- `plans/complete/` — historical reference
  - [2026-04-amem-integration](plans/complete/2026-04-amem-integration/tracker.md) — per-group a-mem in AlgoTrader + AVP + Jeff main + Inbox containers; see `infrastructure/a-mem.md` for current state
  - [2026-04-nanoclaw-migration](plans/complete/2026-04-nanoclaw-migration/tracker.md) — migrated persistent data to `~/containers/data/NanoClaw/` BTRFS subvolume; see `infrastructure/persistence.md` for convention

## History
- `history/` — timestamped daily summaries of notable changes (created as needed)

## Infrastructure
- [infrastructure/persistence.md](infrastructure/persistence.md) — `~/containers/data/<Project>/` BTRFS subvolume convention + hourly snapshots
- [infrastructure/config-management.md](infrastructure/config-management.md) — GNU Stow + `~/Projects/ConfigFiles/` for dotfiles; rebuild goal
- [infrastructure/a-mem.md](infrastructure/a-mem.md) — per-group a-mem MCP baked into the agent container; host Ollama for note generation; per-group ChromaDB

## Domain areas
_(None yet. Create focused directories as the project grows: `channels/`, `groups/`, `ipc/`, etc.)_

## External lodes
- `~/Projects/AlgoTrader/lode/` — Python backtesting framework with ORB research, strategy architecture, and anti-overfit practices. The trading group defers to this lode for backtest methodology.
