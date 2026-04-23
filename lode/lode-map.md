# Lode Map

Authoritative index of project memory. Read this first.

## Root
- [summary.md](summary.md) — one-paragraph living snapshot
- [terminology.md](terminology.md) — domain vocabulary
- [practices.md](practices.md) — patterns and invariants
- [groups.md](groups.md) — current Telegram group roster and identities
- [tech-debt.md](tech-debt.md) — registry of deferred work with trigger conditions
- [lessons.md](lessons.md) — operational rules distilled from incidents (env-vault prefix, session-resume staleness, Madison confabulation patterns, watermark uniformity)

## Plans
- `plans/active/` — in-progress trackers
  - [2026-04-trading-group](plans/active/2026-04-trading-group/tracker.md) — Telegram trading-research group with PDF ingestion, nightly web research, backtest orchestration, and 6-agent swarm
    - **[topics-status.md](plans/active/2026-04-trading-group/topics-status.md)** — topic-by-topic current state (read this first for the design map)
  - [2026-04-trawl-mcp-integration](plans/active/2026-04-trawl-mcp-integration/tracker.md) — expose Trawl's 40+ tools as a tailnet-reachable MCP service at `trawl.crested-gecko.ts.net`; usable from Madison, dev Claude Code, and future clients. Server-first rollout.
  - [2026-04-unified-inbox](plans/active/2026-04-unified-inbox/tracker.md) — **suspended** pending mailroom extraction. Phases 0/1/1.5/1.6 shipped in-place on nanoclaw (SQLCipher-encrypted inbox `store.db` is live); Phase 2–7 reincarnate as mailroom phases.
  - [2026-04-mailroom-extraction](plans/active/2026-04-mailroom-extraction/tracker.md) — extract mail ingestion + storage + MCP + backfill out of nanoclaw's host process into a standalone Docker stack at `~/Projects/ConfigFiles/containers/mailroom/`. Nanoclaw shrinks to router + chat channels + a `mailroom-subscriber`. Bridge drops `0.0.0.0` port publishing. 10 phases (M0 scaffolding → M9 Proton docs).
  - [2026-04-mail-push-redesign](plans/active/2026-04-mail-push-redesign/tracker.md) — push-driven rules engine at mailroom ingest replaces Madison's polling. Phases 1–8 + Phase 10 implementation shipped; Phase 9 + 10.9 audits pending. See `infrastructure/mailroom-rules.md` + `infrastructure/madison-pipeline.md`.
  - [2026-04-madison-read-power](plans/active/2026-04-madison-read-power/tracker.md) — `mcp__inbox__query` (structured filters + count aggregation) for Madison's read surface, plus session-toolset-hash invalidation so MCP-tool deploys actually reach her. Driven by 2026-04-22 confabulation incident.
- `plans/complete/` — historical reference
  - [2026-04-amem-integration](plans/complete/2026-04-amem-integration/tracker.md) — per-group a-mem in AlgoTrader + AVP + Jeff main + Inbox containers; see `infrastructure/a-mem.md` for current state
  - [2026-04-nanoclaw-migration](plans/complete/2026-04-nanoclaw-migration/tracker.md) — migrated persistent data to `~/containers/data/NanoClaw/` BTRFS subvolume; see `infrastructure/persistence.md` for convention
  - [2026-04-context-mode-integration](plans/complete/2026-04-context-mode-integration/tracker.md) — context-mode MCP + vendored skill integrated into the agent container with per-group FTS5 DBs; see `infrastructure/context-mode.md`

## History
- `history/` — timestamped daily summaries of notable changes (created as needed)

## Infrastructure
- [infrastructure/persistence.md](infrastructure/persistence.md) — `~/containers/data/<Project>/` BTRFS subvolume convention + hourly snapshots
- [infrastructure/config-management.md](infrastructure/config-management.md) — GNU Stow + `~/Projects/ConfigFiles/` for dotfiles; rebuild goal
- [infrastructure/a-mem.md](infrastructure/a-mem.md) — per-group a-mem MCP baked into the agent container; host Ollama for note generation; per-group ChromaDB
- [infrastructure/context-mode.md](infrastructure/context-mode.md) — context-mode MCP + vendored skill baked into the agent container; per-group FTS5 DB; hook wiring + path-resolution nuances documented
- [infrastructure/mailroom-rules.md](infrastructure/mailroom-rules.md) — backend rule engine in the mailroom-ingestor container; rules.json + accounts.json + changelog live in `~/containers/data/mailroom/` (symlinked into Obsidian)
- [infrastructure/madison-pipeline.md](infrastructure/madison-pipeline.md) — push-driven delivery path for inbound mail: mailroom → ipc-out → subscriber → group-queue → Madison; urgent bypasses the 2s POLL_INTERVAL
- [infrastructure/session-context-budget.md](infrastructure/session-context-budget.md) — Obsidian `_Settings/` layout: `defaults.json` (global ops), `group-overrides.json` (per-group model + rotation), `tasks/{folder}.json` (auto-generated task snapshots). `.env` is the legacy fallback.

## Reference
- [reference/rules-schema.md](reference/rules-schema.md) — mailroom rules.json schema digest (canonical source is `mailroom/src/rules/schema.md` inside the container)

## Domain areas
_(None yet. Create focused directories as the project grows: `channels/`, `groups/`, `ipc/`, etc.)_

## External lodes
- `~/Projects/AlgoTrader/lode/` — Python backtesting framework with ORB research, strategy architecture, and anti-overfit practices. The trading group defers to this lode for backtest methodology.
