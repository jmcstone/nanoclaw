# Madison Read Power + Session Freshness

Branch: `mail-push-redesign` (will spin a new branch when implementation starts)

## Goal

Give Madison structured read/aggregation power that matches her write power, AND prevent the session-staleness pattern that hid Phase 10 tools from her on 2026-04-22 evening. Today she has 9 write tools but only 3 read tools (`search`, `thread`, `recent`) — none of which can answer "count emails from sender X mentioning phrase Y in body, last N days, grouped by subject." Worse, she didn't even know about her new Phase 10 batch tools because her container resumed a session that pre-dated their existence.

## Acceptance criteria (goal-backward)

- **AC-1** New MCP tool `mcp__inbox__query(filters, group_by?, count?, limit?)` exposed on the inbox-mcp server. Filters: `sender`, `account_id`, `account_tag`, `source`, `received_after`, `received_before`, `subject_contains`, `body_contains`, `subject_matches` (regex), `body_matches` (regex), `thread_id`. Optional `group_by: 'subject' | 'sender' | 'account_id' | 'thread_id' | 'day' | 'week'` + `count: true` for aggregation. Backed by SQLite over `messages` + `messages_fts` + `senders` joins. Default limit 100; max 1000.
- **AC-2** Madison can answer "How many emails from bob@builder.com mentioned 'late payment' in body, last 6 months, count by subject" with a single tool call.
- **AC-3** Session toolset-hash invalidation in nanoclaw: `sessions` table gains `tool_list_hash TEXT` column. On every spawn, compute SHA-256 of the current MCP tool list (sorted by name). If stored hash differs from current, clear the session before spawning so the new container starts a fresh conversation. Logged at INFO with old/new hash.
- **AC-4** Madison's `CLAUDE.md` documents `mcp__inbox__query`: signature, common patterns ("count by sender for date range", "show all unread from family", etc.), the truthfulness link (always quote the count, don't paraphrase). Also: when she suspects her tool list is stale, she's instructed to ask Jeff to clear her session rather than confabulating capabilities.
- **AC-5** Lode lessons + infrastructure docs updated: env-vault prefix required for mailroom deploys from fresh shell; both `ingestor` + `inbox-mcp` need rebuild when `src/store/` changes; session-toolset-hash pattern documented in `lode/architecture/madison-pipeline.md` (graduated from this plan on completion).
- **AC-6** **a-mem staleness handling** — Madison's per-group a-mem can persist "known issue" notes that survive session clears, leading her to quote stale facts as current state (observed 2026-04-22 evening: she reported "Proton watermarks return NaN" hours after the fix landed). Two complementary mechanisms:
  - (a) **Persona rule**: when quoting a fact from a-mem about a "gap" / "limitation" / "known issue" / "broken", Madison must first verify the claim against current behavior (call the relevant tool, check logs, OR explicitly note "as of [date in the note]") rather than asserting current state. Added to her CLAUDE.md "Truthful action reporting" section.
  - (b) **Counter-note pattern**: when a fix lands that resolves an issue Madison may have noted, write a follow-up a-mem note tagged with the original's keywords plus `RESOLVED <date>` so a-mem search surfaces both. Documented as a workflow in `lode/practices.md`. The `update-nanoclaw` / lode-executor pattern can include this as a checklist item for fix-shipping.
- **AC-7** End-to-end verified: Madison's session cleared, container rebuilt, fresh spawn answers the Bob-late-payment query correctly with grouped counts; session-hash invalidation triggers on next MCP tool change; she does NOT quote stale "known gap" notes (e.g. the now-fixed NaN watermark) as current.

## Decisions (locked)

| Decision | Rationale |
|---|---|
| **Single `query` tool, not separate `list_inbox` + `count` + `group`** | One tool with optional aggregation is easier for Madison to reach for than three. Reduces tool-count cognitive load. |
| **SQLite-backed, not live IMAP** | Store has every ingested message with FTS5 already. Sub-second response. Cost: doesn't see in-INBOX-vs-archived state, but that's a different problem (see `lode/tech-debt.md` — `mcp__inbox__list_inbox` for live state is a separate v2 ask). |
| **Hash on tool *names* (sorted), not full tool definitions** | Description/schema changes shouldn't invalidate sessions; only tool addition/removal does. Cheaper to compute, less churn. |
| **Clear session on hash mismatch, don't try to merge** | Resuming a stale session injects misleading conversation context. Cleaner to start fresh — Madison loses recent task memory but gains a correct world model. |
| **Hash check happens in nanoclaw orchestrator, not in agent-runner** | The orchestrator already owns `clearSession()`; adding the check there is a 5-line edit. Agent-runner would need to plumb the hash back up which is more code. |
| **Aggregation limited to count for v1** | "How many" answers most analytics needs. `sum`/`avg`/`min`/`max` add complexity (need numeric columns) — defer until a real use case lands. |
| **Date filters use `received_at` (ISO timestamp), not Proton UID** | After the 2026-04-22 watermark fix, `received_at` is the single source of truth for "when". Don't reintroduce the UID confusion. |
| **No write actions in `query`** | Read-only by contract — listed in the no-deps registration block alongside `search`/`recent`/`thread`. Lower deploy risk. |

## Read first (for executors)

**Today's diagnostic context:**
- `lode/plans/active/2026-04-madison-read-power/findings.md` — captured 2026-04-22 evening: confabulation incident, watermark NaN root cause, env-vault deploy gotcha, session staleness diagnosis, full tool inventory of what exists vs what's missing.

**Mailroom (where the new tool lives):**
- `~/Projects/ConfigFiles/containers/mailroom/mailroom/src/store/queries.ts` — existing `searchMessages`, `getThread`, `getRecentMessages`. New `queryMessages` joins this set.
- `~/Projects/ConfigFiles/containers/mailroom/mailroom/src/store/types.ts` — InboxMessage shape; will need new `QueryArgs` / `QueryResult` types
- `~/Projects/ConfigFiles/containers/mailroom/mailroom/src/mcp/server.ts` — registration pattern (read-only tools have no `deps` guard)
- `~/Projects/ConfigFiles/containers/mailroom/mailroom/src/store/db.ts` — `messages_fts` schema reference

**Nanoclaw (session invalidation):**
- `src/db.ts` — `sessions` table schema (line ~74); add migration for `tool_list_hash` column
- `src/index.ts:345-375` — session rotation logic; the place to insert hash check
- `src/container-runner.ts` — passes `sessionId` to agent-runner; doesn't need changes
- `container/agent-runner/src/index.ts:495-555` — Trawl tool discovery pattern (reference for how to fetch the inbox-mcp tool list)

**Madison persona:**
- `~/containers/data/NanoClaw/groups/telegram_inbox/CLAUDE.md` — Writes section (Phase 10.7); add `query` to her surface

## Phases

### Phase 1 — Discuss / lock open questions
- [ ] **1.1** Confirm AC-1 filter set with Jeff. Anything to add (e.g. `has_attachment`, `read_status`)? Note: read_status would require persisted unread state which the store doesn't track today.
- [ ] **1.2** Confirm aggregation v1 = count only.
- [ ] **1.3** Confirm session-hash strategy: invalidate on any add/remove vs only on remove. (Conservative = both, since adds can also reshape behavior.)
- [ ] **1.4** Confirm a-mem AC-6 approach: persona-rule-only (Madison verifies before quoting) vs persona-rule + counter-note pattern vs adding a programmatic stale-tag field. Recommend the persona+counter-note combo since it's cheap and doesn't require a-mem schema changes.

### Phase 2 — `mcp__inbox__query` tool
- [ ] **2.1** `src/store/types.ts` — `QueryArgs`, `QueryResult` types
- [ ] **2.2** `src/store/queries.ts` — `queryMessages(args)` with dynamic SQL builder; safe parameterized queries (no string interpolation of user input)
- [ ] **2.3** `src/store/queries.ts` — `aggregateMessages(args)` for grouped count
- [ ] **2.4** `src/mcp/tools/query.ts` — MCP wrapper (no deps; pure read)
- [ ] **2.5** Register in `src/mcp/server.ts` (read-only tool block)
- [ ] **2.6** Unit tests: each filter alone, combinations, aggregation, limit cap, regex safety
- [ ] **2.7** Performance check: count-by-subject across 100k messages with FTS predicate — should be <500ms

### Phase 3 — Session toolset-hash invalidation
- [ ] **3.1** Add `tool_list_hash TEXT` column to `sessions` table (db migration)
- [ ] **3.2** New helper in `src/db.ts`: `getSessionToolHash(group_folder)`, `setSessionToolHash(group_folder, hash)`
- [ ] **3.3** New module `src/mcp-tool-discovery.ts`: fetches tool list from registered MCP servers, returns sorted-name SHA-256
- [ ] **3.4** Wire into `src/index.ts` rotation block: compute current hash; if differs from stored, log and clear session
- [ ] **3.5** Tests: hash stable across calls when toolset unchanged; differs when tool added/removed; mock the MCP fetch

### Phase 4 — Documentation + persona
- [ ] **4.1** Madison's `CLAUDE.md`: add `mcp__inbox__query` docs with examples ("Bob's late payments", "unread from family last week", "thread density by subject")
- [ ] **4.2** `lode/architecture/madison-pipeline.md`: graduate session-hash invalidation pattern
- [ ] **4.3** `lode/infrastructure/mailroom-rules.md`: note the env-vault deploy requirement (cross-link to lessons.md)
- [ ] **4.4** `lode/practices.md`: add deploy-checklist subsection covering the env-vault prefix and the both-containers-rebuild rule
- [ ] **4.5** Madison's `CLAUDE.md` "Truthful action reporting" section: extend with the verify-before-quoting-a-mem rule (AC-6a). Concrete instruction: when about to quote any a-mem fact that says "X is broken" / "Y returns NaN" / "Z is timing out" / "<feature> is unavailable", first run a quick verification (the relevant tool, `tail` of logs, etc.) OR explicitly note "as of [date from the a-mem entry]" so Jeff knows the claim isn't fresh.
- [ ] **4.6** `lode/practices.md`: add the **counter-note pattern** (AC-6b) — when shipping a fix that resolves a known-issue note in a-mem, the fix-author writes a follow-up note containing the original keywords + `RESOLVED <ISO date>` + commit hash. Document as a step in fix-shipping checklist.
- [ ] **4.7** Initial cleanup pass: scan Madison's a-mem for "Known gaps" / "Broken" / "Limitation" notes from 2026-04-22 (today's diagnostic session) and either delete the now-fixed ones or append RESOLVED markers. Confirm the watermark NaN claim is no longer reachable as current state.

### Phase 5 — Verify + graduate
- [ ] **5.1** Rebuild + restart mailroom (env-vault prefix); restart nanoclaw
- [ ] **5.2** End-to-end: ask Madison the Bob-late-payment-by-subject question; verify she uses `query` not `search`+manual count
- [ ] **5.3** Trigger a tool change (add a placeholder tool, restart MCP) → verify Madison's session is invalidated on next spawn
- [ ] **5.4** **a-mem freshness check (AC-7)**: ask Madison "are Proton watermarks working?" — verify she does NOT cite the NaN issue as current. If she does, Phase 4.5 / 4.7 needs another pass.
- [ ] **5.5** Graduate findings to permanent lode files
- [ ] **5.6** Move plan to `lode/plans/complete/`

## Errors

| Error | Resolution |
|---|---|

*(none yet)*

## Current status

**Discussion phase.** Plan written 2026-04-22 evening following live diagnostic of the confabulation + watermark NaN + session staleness incidents. Watermark fix already shipped (ConfigFiles `58a290f`); Madison's session cleared from nanoclaw db. Next: confirm Phase 1 questions with Jeff, then start Phase 2.
