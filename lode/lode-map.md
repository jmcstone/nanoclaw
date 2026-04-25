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
  - [2026-04-unified-inbox](plans/active/2026-04-unified-inbox/tracker.md) — **suspended** pending mailroom extraction. Phases 0/1/1.5/1.6 shipped in-place on nanoclaw (SQLCipher-encrypted inbox `store.db` is live); Phase 2–7 reincarnated as mailroom phases (now tracked in the mailroom repo).
  - [2026-04-document-to-markdown](plans/active/2026-04-document-to-markdown/tracker.md) — committed companion to mailroom's `message-enrichment` plan. NanoClaw container skill `add-document-to-markdown` backed by `markitdown` (Microsoft, MIT) for PDF / DOCX / XLSX / PPTX / HTML / EPUB / CSV. Per-format extras keep the image lean (~50 MB). Image and audio MIMEs fall through to existing `add-image-vision` / `use-local-whisper` skills. Lands upstream so other Jeff instances (americanvoxpop, etc.) pick it up via `/update-nanoclaw`. **Not started** — can develop in parallel with enrichment.
  - [2026-04-mailroom-repo-extraction](plans/active/2026-04-mailroom-repo-extraction/tracker.md) — Waves 0–6 complete (mailroom source split to its own GitLab repo + lode migration done). Tracker stays here through Wave 7 (24h soak + final closure), then migrates to the mailroom repo.
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
- [infrastructure/madison-pipeline.md](infrastructure/madison-pipeline.md) — push-driven delivery path for inbound mail: mailroom → ipc-out → subscriber → group-queue → Madison; urgent bypasses the 2s POLL_INTERVAL
- [infrastructure/session-context-budget.md](infrastructure/session-context-budget.md) — Obsidian `_Settings/` layout: `defaults.json` (global ops), `group-overrides.json` (per-group model + rotation), `tasks/{folder}.json` (auto-generated task snapshots). `.env` is the legacy fallback.

## Domain areas
_(None yet. Create focused directories as the project grows: `channels/`, `groups/`, `ipc/`, etc.)_

## Cross-repo lodes
- **Mailroom** (`~/Projects/mailroom/lode/`, `gitlab.com/jmcstone/mailroom`) — mail data plane: ingestion, store.db mirror, rule engine, MCP tools. Mailroom's domain docs (`mailroom-mirror`, `mailroom-rules`, mirror data model `madison-pipeline`, rule-schema reference) and the 7 mailroom-belonging plans (madison-read-power, mail-push-redesign, mailroom-extraction, wave-5.8-writethrough-correctness, message-enrichment, morning-brief-blindness, rule-schema-unification) live there as of 2026-04-25 (Wave 6 of mailroom-repo-extraction). Nanoclaw interfaces with mailroom via `ipc-out/*.json` events (consumed by `mailroom-subscriber` channel) and HTTP MCP at port 8080 (Madison's `mcp__messages__*` / `mcp__inbox__*` tools).
- `~/Projects/AlgoTrader/lode/` — Python backtesting framework with ORB research, strategy architecture, and anti-overfit practices. The trading group defers to this lode for backtest methodology.
