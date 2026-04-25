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
  - [2026-04-rule-schema-unification](plans/active/2026-04-rule-schema-unification/tracker.md) — unify `rules.json` + `sender-preferences.md` into one schema-validated JSON with `classification` + `instructions` fields; extend validator with non-blocking lint that flags overlapping rules with contradicting instructions (empirical overlap via store.db replay). Motivated by a live LinkedIn-DM silent-archive drift. **Not started** — awaits branch + go-ahead.
  - [2026-04-morning-brief-blindness](plans/active/2026-04-morning-brief-blindness/tracker.md) — fix the 7am brief silently reporting "0 overnight" when store has overnight rows. Add a `mcp__messages__count_in_window` audit precondition and tighten Madison's morning routine to refuse a "0 overnight" brief unless the audit confirms it. Triggered by 2026-04-25 brief that missed 11 overnight Protonmail rows. **Not started** — awaits branch + go-ahead.
  - [2026-04-message-enrichment](plans/active/2026-04-message-enrichment/tracker.md) — add recipients (To/CC/BCC/Reply-To, normalized table), list headers (List-Id / List-Unsubscribe), and attachments (count + metadata + optional cached blobs in a three-state design) to the mailroom mirror. Recipients + attachment metadata default-projected on `InboxMessage` with a `cached: boolean` per attachment. New MCP tools: `fetch_attachment`, `attachment_to_path`, `send_reply_all`, `send_forward`; `send_reply` extended to honor Reply-To. One-shot resumable two-phase backfill (metadata pass then blob pass) for all 60k existing messages, ingest-path parity for new mail. Ships in lockstep with the [document-to-markdown](plans/active/2026-04-document-to-markdown/tracker.md) companion skill at Wave 6 verification. **Not started** — awaits branch + go-ahead; Wave 1 size-discovery should run first.
  - [2026-04-document-to-markdown](plans/active/2026-04-document-to-markdown/tracker.md) — committed companion to `2026-04-message-enrichment`. NanoClaw container skill `add-document-to-markdown` backed by `markitdown` (Microsoft, MIT) for PDF / DOCX / XLSX / PPTX / HTML / EPUB / CSV. Per-format extras keep the image lean (~50 MB). Image and audio MIMEs fall through to existing `add-image-vision` / `use-local-whisper` skills. Lands upstream so other Jeff instances (americanvoxpop, etc.) pick it up via `/update-nanoclaw`. **Not started** — can develop in parallel with enrichment.
- `plans/complete/` — historical reference
  - [2026-04-amem-integration](plans/complete/2026-04-amem-integration/tracker.md) — per-group a-mem in AlgoTrader + AVP + Jeff main + Inbox containers; see `infrastructure/a-mem.md` for current state
  - [2026-04-nanoclaw-migration](plans/complete/2026-04-nanoclaw-migration/tracker.md) — migrated persistent data to `~/containers/data/NanoClaw/` BTRFS subvolume; see `infrastructure/persistence.md` for convention
  - [2026-04-context-mode-integration](plans/complete/2026-04-context-mode-integration/tracker.md) — context-mode MCP + vendored skill integrated into the agent container with per-group FTS5 DBs; see `infrastructure/context-mode.md`
  - [2026-04-mail-push-redesign](plans/complete/2026-04-mail-push-redesign/tracker.md) — **closed 2026-04-23 with retrospective (goal achievement: partial).** Infrastructure shipped (rules engine, `mcp__inbox__*` write tools, event-driven subscriber, batch tools). Product claim — "Madison replaces opening your mail" — failed because the store is content-only, not a mirror. Continues as `madison-read-power`. See `infrastructure/mailroom-rules.md` + `infrastructure/madison-pipeline.md`.
  - [2026-04-madison-read-power](plans/complete/2026-04-madison-read-power/tracker.md) — **closed 2026-04-25.** Full DB mirror of upstream mailbox state (Gmail history.list + Proton IDLE + UIDNEXT polling + three-tier recency reconcile), write-through for mutation tools, `mcp__inbox__query` with full filter set, session-toolset-hash invalidation. Wave 5.7 replaced CONDSTORE with UIDNEXT after the bridge was confirmed not to advertise it. See `architecture/madison-pipeline.md` + `infrastructure/mailroom-mirror.md`. Branch `madison-read-power` merged; left around as a safety net.

## History
- `history/` — timestamped daily summaries of notable changes (created as needed)

## Infrastructure
- [infrastructure/persistence.md](infrastructure/persistence.md) — `~/containers/data/<Project>/` BTRFS subvolume convention + hourly snapshots
- [infrastructure/config-management.md](infrastructure/config-management.md) — GNU Stow + `~/Projects/ConfigFiles/` for dotfiles; rebuild goal
- [infrastructure/a-mem.md](infrastructure/a-mem.md) — per-group a-mem MCP baked into the agent container; host Ollama for note generation; per-group ChromaDB
- [infrastructure/context-mode.md](infrastructure/context-mode.md) — context-mode MCP + vendored skill baked into the agent container; per-group FTS5 DB; hook wiring + path-resolution nuances documented
- [infrastructure/mailroom-rules.md](infrastructure/mailroom-rules.md) — backend rule engine in the mailroom-ingestor container; rules.json + accounts.json + changelog live in `~/containers/data/mailroom/` (symlinked into Obsidian)
- [infrastructure/mailroom-mirror.md](infrastructure/mailroom-mirror.md) — sync worker architecture: Gmail history.list incremental + Proton IDLE on INBOX + per-folder UIDNEXT polling (Wave 5.7) + three-tier recency reconcile (hot 30 min / warm 6 h / cold weekly Sunday 04:00). Wave 5.8 shape contract, restore tool, migration orchestrator, deploy checklist.
- [infrastructure/madison-pipeline.md](infrastructure/madison-pipeline.md) — push-driven delivery path for inbound mail: mailroom → ipc-out → subscriber → group-queue → Madison; urgent bypasses the 2s POLL_INTERVAL
- [infrastructure/session-context-budget.md](infrastructure/session-context-budget.md) — Obsidian `_Settings/` layout: `defaults.json` (global ops), `group-overrides.json` (per-group model + rotation), `tasks/{folder}.json` (auto-generated task snapshots). `.env` is the legacy fallback.

## Architecture

- [architecture/madison-pipeline.md](architecture/madison-pipeline.md) — mirror data model (RFC-822 identity, message_labels, message_folder_uids, label_catalog, label_map), session-hash invalidation pattern, hydration/reconcile flow, locked Decisions table summary, data-flow Mermaid diagram. Graduate of `findings.md` 2026-04-22 design session.

## Reference
- [reference/rules-schema.md](reference/rules-schema.md) — mailroom rules.json schema digest (canonical source is `mailroom/src/rules/schema.md` inside the container)

## Domain areas
_(None yet. Create focused directories as the project grows: `channels/`, `groups/`, `ipc/`, etc.)_

## External lodes
- `~/Projects/AlgoTrader/lode/` — Python backtesting framework with ORB research, strategy architecture, and anti-overfit practices. The trading group defers to this lode for backtest methodology.
