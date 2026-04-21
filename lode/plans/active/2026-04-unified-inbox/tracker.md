# Unified Inbox Tracker

Branch: `unified-inbox`

## Goal

Transform Madison Inbox from a reactive email-polling agent into a unified, autonomous message-management agent that is a viable alternative to Jeff opening Gmail / Proton Mail / Slack / Google Messages manually. Coverage: Proton + Gmail + Slack + Google Messages. Properties: durable message store, push ingestion, one consistent action verb set, auditable + reversible auto-actions.

## Overall acceptance criteria (goal-backward)

- Jeff uses the Madison Inbox group as his primary triage surface and stops opening individual apps for routine inbox checking.
- Every message across all sources flows through one normalized classification pipeline (urgent / needs-reply / fyi / auto-handled / spam).
- Madison's actions (reply, archive, label, snooze, unsubscribe) behave identically regardless of source backend.
- Every auto-action has recorded rationale and is reversible.
- HTML-only emails never silently drop; attachments are surfaced.
- Ingestion is push-based where the backend supports it (IMAP IDLE for Proton; push/poll for Gmail; Socket Mode for Slack).
- Semantic recall works across months of historical conversations via hybrid FTS+vector.

## Phase 0 — Stabilize current state (P0, days)

- [ ] 0.1 Add `proposed_action` column to Madison's digest schema in `groups/telegram_inbox/CLAUDE.md`; require one of {action_taken, proposed_action} on every row.
- [ ] 0.2 Add "carry-over re-propose" rule to CLAUDE.md: every morning brief re-proposes action (or asks if still relevant) for each pending item.
- [ ] 0.3 Keep all 7 Proton addresses in `~/.protonmail-bridge/config.json` (decision: Jeff actively receives on all 7). Audit the polling loop for robustness against the bridge's rate-limit cascade — stagger more aggressively, skip addresses that recently errored, or switch polling to a single-session multi-folder IMAP connection.
- [ ] 0.4 Add HTML→Markdown fallback in `src/channels/protonmail.ts` + `src/channels/gmail.ts` using `turndown` (decision: Markdown preserves structure better for LLM consumption than plaintext).
- [ ] 0.5 Implement priority-gated per-email-arrival policy: on arrival, Madison performs a fast classification (sender-preferences.md + a-mem fuzzy match; LLM fallback if novel). If classified `urgent` / `needs-reply` or any action is required → post immediately to the group with `proposed_action`. Otherwise stay silent and let the `:07` sweep absorb it into the next digest. Update CLAUDE.md triage workflow to codify this.
- [ ] 0.6 Monitor bridge auth-cascade for 24h after 0.3 lands. Expect zero "no such user" entries attributable to login budget exhaustion.

## Phase 1 — Durable message store (P1, PLANNED)

### Acceptance criteria

- [ ] **AC-1** `~/containers/data/NanoClaw/inbox/store.db` exists with tables `messages`, `threads`, `senders`, `accounts`, `watermarks` and an FTS5 virtual table `messages_fts` indexed on `subject`, `body_markdown`, and `sender_address`. Verify: `sqlite3 ~/containers/data/NanoClaw/inbox/store.db ".tables"` lists all five.
- [ ] **AC-2** Every email delivered by `gmail.ts` and `protonmail.ts` is written to `inbox/store.db` within the same poll cycle, without altering the existing `onMessage` IPC flow. Verify: after a test email arrives, `SELECT count(*) FROM messages` increments and the IPC file is also written normally.
- [ ] **AC-3** Gmail messages are stored with `thread_id` populated from the Gmail API `threadId` field; Protonmail messages have `thread_id` derived from `In-Reply-To`/`References` headers. Verify: `SELECT thread_id, source FROM messages` shows non-null `thread_id` for both sources.
- [ ] **AC-4** `src/inbox-store/watermarks.ts` exposes `getWatermark(account)` and `setWatermark(account, value)` backed by the `watermarks` table. Verify: unit test exercises round-trip read/write.
- [ ] **AC-5** `container/inbox-mcp/` is a working MCP server exposing `mcp__inbox__search` (FTS5 query), `mcp__inbox__thread` (messages by `thread_id`), and `mcp__inbox__recent` (messages since watermark). Verify: `node container/inbox-mcp/dist/index.js` responds to JSON-RPC `tools/list` with all three names.
- [ ] **AC-6** `src/container-runner.ts` mounts `~/containers/data/NanoClaw/inbox/store.db` read-only into the Madison Inbox container (JID `tg:-5273779685`) and registers the inbox MCP server only for that JID. Verify: `docker inspect` on a spawned Madison Inbox container shows the bind mount and the MCP entry; other group containers do not.
- [ ] **AC-7** Madison's hourly triage reads `watermarks` + `mcp__inbox__recent` to determine "new since last sweep" rather than re-querying IMAP/Gmail; `groups/telegram_inbox/CLAUDE.md` documents the new read flow. Backend tools (`mcp__gmail__*`, Proton IMAP) remain available for *actions* (archive/reply/label), not reads. Verify: CLAUDE.md sweep section references `mcp__inbox__recent` instead of `mcp__gmail__search_emails` for per-sweep reads.

### Read first

- `src/db.ts` — reference for `better-sqlite3` + WAL + migration patterns to replicate in the new DB module.
- `src/channels/gmail.ts` — where `threadId` is available and where the ingestion hook must be inserted.
- `src/channels/protonmail.ts` — where `In-Reply-To`/`References` headers are parsed and where the ingestion hook goes.
- `src/container-runner.ts` — `buildVolumeMounts` + MCP registration pattern to follow for Madison-only mounting.
- `container/Dockerfile` — shows how `a-mem-mcp` is baked in; `inbox-mcp` follows the same `COPY` + `RUN npm install && npm run build` pattern.
- `container/a-mem-mcp/` — reference MCP layout; inbox-mcp will be Node/TypeScript but the `server.json` registration pattern is the same.
- `container/build.sh` — must include the new `inbox-mcp/` directory in the build.

### Wave 1 — Contracts and schema (parallel) ✅

- [x] **1.1** Define TypeScript types for the inbox store — `src/inbox-store/types.ts` (`b4fe57c`).
- [x] **1.2** Create the inbox SQLite DB module with FTS5 triggers — `src/inbox-store/db.ts` (`e707a99`).
- [x] **1.3** Unit tests for the schema (8 tests, all pass) — `src/inbox-store/db.test.ts` (`e707a99`).

### Wave 2 — Ingestion and queries (parallel, depends on Wave 1) ✅

- [x] **2.1** Ingestion with thread derivation (10 tests) — `src/inbox-store/ingest.ts` (`bb82006`).
- [x] **2.2** Watermarks module (6 tests) — `src/inbox-store/watermarks.ts` (`98870ba`).
- [x] **2.3** Read-side queries search/thread/recent (15 tests) — `src/inbox-store/queries.ts` (`05cad11`).

### Wave 3 — Channel wiring + MCP server (parallel, depends on Wave 2) ✅

- [x] **3.1** Wire `ingestGmail` into Gmail channel — `src/channels/gmail.ts` (`42781ef`).
- [x] **3.2** Wire `ingestProtonmail` into Protonmail channel + `parseReferencesHeader` helper — `src/channels/protonmail.ts` (`f72a528`).
- [x] **3.3** Scaffold `container/inbox-mcp/` — 10 files; MCP SDK 1.13.3; `tools/list` returns all three tool names — (`7c516cd`).

### Wave 4 — Container wiring and CLAUDE.md update (parallel, depends on Wave 3) ✅

- [x] **4.1** Gate inbox store bind mount + MCP registration on `folder === 'telegram_inbox'`; startup `getInboxDb()` init; 3 gating tests — `src/container-runner.ts` + `container/agent-runner/src/index.ts` + `src/index.ts` (`95740df`).
- [x] **4.2** `COPY inbox-mcp/` + `npm ci --omit=dev && npm run build` into `/opt/inbox-mcp/` — `container/Dockerfile` (`b530363`).
- [x] **4.3** Madison CLAUDE.md reads via `mcp__inbox__*`, actions stay on `mcp__gmail__*` + Proton; `lode/groups.md` note added — (`5adccfb`).

## Phase 1.5 — Historical backfill (P1, days, PLANNED)

Fills the inbox store with pre-deploy historical mail so Madison's `mcp__inbox__search` works back through 2+ years of history, not just "from this moment forward." Asymmetric backfill cost: Proton is cheap (bridge is a full local mirror already — we just read what's already on localhost). Gmail is moderate (paginated API with quota). Both share the Phase 1 ingest layer, so no duplication.

Gating: Phase 1.5 execution waits until Phase 1 has been deployed (agent container rebuilt + nanoclaw service restarted) — the scripts need `~/containers/data/NanoClaw/inbox/store.db` to exist with schema, which happens on orchestrator startup.

### Acceptance criteria

- [ ] **AC-1.5-1** `scripts/inbox-backfill-proton.ts` exists and, run via `tsx`, iterates all 7 Proton addresses via localhost IMAP and ingests every historical message through `ingestProtonmail`. Idempotent (second run is a no-op). Verify: `SELECT COUNT(*) FROM messages WHERE source='protonmail'` grows on first run, stays constant on second.
- [ ] **AC-1.5-2** `scripts/inbox-backfill-gmail.ts` exists and, run via `tsx`, paginates `users.messages.list` from a configurable `--since` date (default 2 years back) and ingests every matching message through `ingestGmail`. Idempotent. Rate-limited (≤ 5 msg/sec) to stay well under Gmail daily quota. Verify: first run populates rows; second run inserts zero new rows.
- [ ] **AC-1.5-3** Both scripts checkpoint progress at `~/containers/data/NanoClaw/inbox/backfill-cursor.json` so a mid-run crash or Ctrl-C can resume without redoing completed work. Verify: kill mid-run, re-run, it picks up from the checkpoint.
- [ ] **AC-1.5-4** After both scripts complete, Madison's `mcp__inbox__search` can find historical threads by subject fragment (e.g. "Guardian invoice 9246") that pre-date Phase 1 deployment.

### Read first

- `/home/jeff/containers/nanoclaw/src/inbox-store/ingest.ts` — `ingestGmail` / `ingestProtonmail` signatures.
- `/home/jeff/containers/nanoclaw/src/channels/protonmail.ts` — IMAP connect/search/fetch pattern to adapt; `parseReferencesHeader` helper.
- `/home/jeff/containers/nanoclaw/src/channels/gmail.ts` — Gmail API fetch + body extraction pattern to adapt.
- `/home/jeff/containers/nanoclaw/src/channels/email-body.ts` — `pickBody` helper for Markdown body extraction.
- `/home/jeff/containers/nanoclaw/.env` (via `readEnvFile`) — Proton bridge password + Gmail OAuth tokens.

### Wave 1.5 — Two independent backfill scripts ✅

- [x] **1.5.1** Proton backfill script (newest-first, descending UID walk) + `extractProtonmailBody` refactor + `parseReferencesHeader` export + 11 new tests — `scripts/inbox-backfill-proton.ts`, `src/channels/protonmail.ts` (`3f9df7b` for substance, `0f881de` for prettier tidy, refactored to newest-first in later commit — attribution note below). Cursor shape: nested `proton.<address>.{ceiling_uid, lowest_processed_uid}`; legacy flat `proton.<address>.last_uid` is migrated-and-deleted on first use. `--floor-uid` flag caps how far back the walk goes. Ctrl-C safe: most recent mail is in the store immediately.
- [x] **1.5.2** Gmail backfill script + `extractGmailBodyParts` module-level export + 5 new tests — `scripts/inbox-backfill-gmail.ts`, `src/channels/gmail.ts` (`3f9df7b`).

**Attribution note**: the Gmail executor committed first and swept in the Proton executor's unstaged files from the working tree, so both substantive changes landed under `3f9df7b`. `0f881de` is a small prettier-only follow-up. All substance is in history; split attribution is noisy but not lossy. Future parallel lode-execute runs: keep executors out of overlapping file paths even at the working-tree level, or have them `git stash` before committing to avoid sweeping in sibling work.

## Phase 2 — Unified messaging API (MCP server) (P1, 1–2 weeks)

- [ ] 2.1 Design API surface: `list`, `read`, `search`, `reply`, `archive`, `label`, `thread`, `snooze`, `unsubscribe`, `mark_read`, `mark_unread`. Shared across all sources.
- [ ] 2.2 Implement MCP server (`mcp__inbox`) routing by JID prefix to the correct backend adapter (gmail API, Proton IMAP/SMTP, Slack API).
- [ ] 2.3 Backend adapters implement the same verb set; abstract IMAP / Gmail / Slack quirks behind consistent responses.
- [ ] 2.4 Mount MCP server into the Madison Inbox container; remove direct `mcp__gmail__*` + `fetch-protonmail.js` usage from Madison's CLAUDE.md.
- [ ] 2.5 Rewrite CLAUDE.md action-commands section to use unified verbs only; ensure behavior is identical per source.
- [ ] 2.6 Verify: same action command (e.g. `archive a1`) produces identical end state regardless of whether `a1` is a Gmail or Proton message.

## Phase 3 — Push ingestion (P1, ~1 week)

- [ ] 3.1 Replace polling in `protonmail.ts` with IMAP IDLE; add reconnect + exponential backoff for dropped IDLE sessions.
- [ ] 3.2 Evaluate Gmail push (`users.watch` + Cloud Pub/Sub) vs sustained polling; pick and implement.
- [ ] 3.3 Gate each source behind a feature flag so we can fall back to polling if IDLE misbehaves.
- [ ] 3.4 Verify: median message-arrival latency <30s; bridge LOGIN attempts per hour drops by >80%; zero auth-cascade events over a 7-day window.

## Phase 4 — Slack as a source (P2, ~2 weeks)

- [ ] 4.1 Socket Mode Slack adapter in `src/channels/slack.ts` — DMs + mentions + messages in selected channels.
- [ ] 4.2 Ingestion writes Slack messages into the unified store with source=`slack`.
- [ ] 4.3 Classification taxonomy extended for Slack semantics (thread replies, reactions, mentions-as-urgent).
- [ ] 4.4 Outbound actions routed via the unified MCP API: reply in thread, mark read, add reaction.
- [ ] 4.5 Update CLAUDE.md digest schema to include Slack items alongside email items.
- [ ] 4.6 Verify: Slack DMs + emails appear in the same hourly digest and can be actioned interchangeably.

## Phase 5 — Google Messages (P3, scope TBD)

- [ ] 5.1 Decide ingestion path: Messages-for-Web (headless Playwright), Google Voice API, or always-on Android via ADB.
- [ ] 5.2 Write chosen-path ingestion adapter.
- [ ] 5.3 Outbound SMS send path through same chosen mechanism.
- [ ] 5.4 Classification rules for SMS (different cadence, different urgency defaults).
- [ ] 5.5 Verify: SMS flows through same digest + action surface; send works.

## Phase 6 — Selective semantic layer (P3, ~1 week)

- [ ] 6.1 Policy spec: what gets embedded (sender dossiers, thread summaries, classification rationales, action-outcome pairs) and what does NOT (raw bodies, OTPs, PII).
- [ ] 6.2 Pipeline to generate + embed derived artifacts into Madison Inbox's existing a-mem.
- [ ] 6.3 Hybrid retrieval wrapper: FTS on the store first, vector rerank via a-mem.
- [ ] 6.4 Verify: Madison can answer "have I ever received something like this?" across multi-month history with high precision.

## Phase 7 — Trust properties (P3, ~1 week)

- [ ] 7.1 Confidence scoring on classifications; threshold gate for silent auto-actions (below threshold → ask Jeff).
- [ ] 7.2 `undo last N actions` command with full reversal (re-mark unread, un-archive, un-label, un-send where possible).
- [ ] 7.3 Replay tool: "with current rules, what would Madison do to messages from {date range}?" — non-destructive dry-run.
- [ ] 7.4 Audit log browser accessible to Jeff (either a Madison command or a small CLI).
- [ ] 7.5 Verify: Jeff can reconstruct any past action's rationale and reverse it.

## Decisions

| Decision | Rationale |
|---|---|
| Start with Phase 0 stabilization before any new architecture | Phase 0 fixes current pain immediately; the rest of the spine is meaningless if Madison's baseline digests drift. |
| Build durable store (Phase 1) before unified API (Phase 2) | The API is a projection of the store; writing the API first would require re-doing it after the store lands. |
| Defer Google Messages (Phase 5) until after Slack | Google Messages has no clean API path — its choice depends on tradeoffs we'll understand better once Slack is in. |
| Vector DB is Phase 6, not earlier | Blindly embedding email bodies is cargo-cult; embeddings are high-value only over derived artifacts, which requires Phase 1 to exist first. |
| Keep all 7 Proton addresses polling | Jeff receives mail on all 7. Robustness against bridge rate-limit cascade becomes a polling-loop concern (staggering / backoff / error-skip), not a config-pruning concern. |
| Use `turndown` for HTML→Markdown | Markdown preserves semantic structure (lists, headings, links) better than flat text, which is materially useful for LLM classification and summarization. Replaces the empty-body silent-drop path in both channels. |
| Per-email arrivals gated by priority | On arrival, fast classification decides: urgent / needs-reply / action-required → immediate post with `proposed_action`; otherwise silent, absorbed by the next `:07` sweep. Preserves the sweep's batching value for noise while giving urgent items near-real-time surfacing. The hourly sweep was originally added because Proton didn't push — the per-email path complements it, doesn't replace it. |
| Work on `unified-inbox` feature branch | Multi-phase effort spanning weeks; isolates in-progress changes from `main` until a phase is shippable. |
| Backfill walks newest-first on both sources | Gmail does this by API default; Proton now flipped to descending UID. Lets Jeff Ctrl-C the backfill at any time with the most recent mail already present. Length of full-history completion is no longer load-bearing on utility. |
| Cold-start default = NOW - 24h, env-overridable via `INBOX_COLD_START_LOOKBACK_MS` | Eliminates the need for a manual watermark-seed step after Phase 1.5 backfill. `getRecentMessages` with no watermark returns the last 24h of mail; second call self-heals into native per-source semantics via the `new_watermark` it emitted on the first call. Env override lets Jeff widen the window after a long weekend without code change. |

## Errors

| Error | Resolution |
|---|---|

*(none yet)*

## Current status

Phase 0 + Phase 1 code-complete on `unified-inbox`. Phase 1.5 (historical backfill) planned with 2 tasks. 365/365 tests pass. Next: `/lode:verify unified-inbox` to confirm each Phase 1 AC against the codebase, then rebuild the agent container (`./container/build.sh`) and restart nanoclaw to bring Phase 0 + 1 into production. Phase 1.5 executes after that deploy (scripts need the live store.db).
