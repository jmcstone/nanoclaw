# Lessons

Operational and design lessons distilled from incidents, corrections, and validated approaches. Each entry: the rule, why it matters, how to apply it.

---

## A mirror is not a snapshot — content-only archives cannot service inbox triage

**Rule**: If the product goal is "agent manages/triages a live-state system" (inbox, ticket queue, task tracker, calendar), the local store must mirror upstream *mutable* state — labels, folder membership, archived/deleted flags, read state — not just content. A write-once-at-ingest archive is insufficient regardless of how smart the agent is or how well the rules engine runs.

**Why**: `mail-push-redesign` (closed 2026-04-23) shipped a correct, tested event-driven rules engine + write-tool surface, but the store had zero label/folder/archive/direction columns. Madison could not answer "what's in my inbox right now" — she had every message ever ingested, indistinguishable from each other. When Jeff read or deleted mail on his phone, mailroom never learned. She prompted on stale items and missed upstream status changes. Net effect: using Madison was more work than opening Gmail/Proton directly. Testing exposed this at the product level even though every infrastructure metric (tests, deploys, event latency) was green.

**How to apply**:
- For any plan whose product claim is "agent replaces a live-state UI," the first question in design is "what upstream mutable state is being mirrored, and how does it stay in sync?" — not "which tool surface do we expose."
- Accept that a mirror needs write-through (agent/rule writes update local DB in same txn as upstream call) AND a sync loop (picks up drift from foreign-origin changes).
- Content immutable → write-once safe. Mutable state → needs a sync mechanism per source backend (Gmail `history.list`, IMAP IDLE+CONDSTORE).

**Incident**: `mail-push-redesign` plan — 9 phases of infrastructure, all tests green, and the product was worse than doing nothing. Retrospective in the closed plan at `lode/plans/complete/2026-04-mail-push-redesign/tracker.md`.

---

## Branch-proliferation anti-pattern — fold foundation work into one plan

**Rule**: When successive features keep colliding with the same missing piece of infrastructure, stop adding features and fold the foundation work into the active plan. Don't spin a new branch for every symptom.

**Why**: Each feature workaround treats the symptom, not the cause. `mail-push-redesign` worked around the store's missing state by pushing labels upstream without mirroring back. The original `madison-read-power` tried to add a `query` tool over the same hole. A proposed `madison-upstream-mirror` would have been a fourth concurrent branch. Branch count grew; product goal never converged. Folding all mutable-state work into the rewritten `madison-read-power` collapsed three planned branches into one.

**How to apply**:
- At plan-design time, ask: "Is this feature relying on a foundation that doesn't exist yet? Could it be the foundation's problem?" If yes, widen the current plan's scope, don't spin a new one.
- When a review discovers a foundation gap, the first-instinct response "let's put the fix in a separate plan" is usually wrong. That instinct produces branch sprawl. Widen instead.
- Signal: three different pain points tracing to the same missing infrastructure = build the infrastructure.

**Incident**: the chain `mail-push-redesign` → original `madison-read-power` → proposed `madison-upstream-mirror` was three branches around one missing mirror foundation. Collapsed into one rewritten `madison-read-power` plan on 2026-04-22.

---

## Infrastructure completion ≠ product completion

**Rule**: A plan is not complete when all technical boxes are checked — it's complete when the product goal is actually achieved in real user conditions. Validate against the goal statement, not just the acceptance criteria.

**Why**: `mail-push-redesign` passed every AC (rules engine ✓, write tools ✓, push dispatch ✓, legacy retired ✓, 303/303 tests ✓) and shipped to production. Product outcome: Jeff found it net-negative to use. The AC set was correct for what it named; it just didn't name "does this actually replace opening mail?" The goal statement did name that; nobody ran the product-level test.

**How to apply**:
- Every plan's Verify phase should include at least one test of the form "in the real environment, does the feature deliver the stated goal?" — not derived from AC, but written against the plain-English goal statement.
- A 24h use-in-anger period with honest reflection ("did this make my life better?") should gate plan closure for user-facing plans.
- When a plan ships but the user immediately starts working around it or reverting to the old way, that's a signal the goal wasn't met — not a signal to add documentation or polish.

**Incident**: `mail-push-redesign` closed-with-retrospective on 2026-04-23. Infrastructure works and is carried forward; the product claim failed and migrates to `madison-read-power`.

---

## Mailroom deploys must use `env-vault env.vault --` prefix

**Rule**: When bringing up `mailroom-ingestor-1` or `mailroom-inbox-mcp-1` from a fresh shell, always prefix with `env-vault env.vault --`:

```
cd ~/containers/mailroom && env-vault env.vault -- docker compose up -d ingestor inbox-mcp
```

The `--` separator is required so flags like `-d` reach docker-compose, not env-vault.

**Why**: `dcc` (`/usr/local/bin/dcc`) is just a Makefile wrapper — it does NOT decrypt env.vault. Without the env-vault prefix, `INBOX_DB_KEY` is unset and both containers crash-loop with `INBOX_DB_KEY is required for inbox store encryption`. Phase 10.8's `dcc up` succeeded only because Jeff's interactive shell had env vars from a prior `env-vault` invocation already exported. Fresh shells (subagents, new tmux panes, ssh sessions) won't have them.

**How to apply**: Any agent or script doing a mailroom deploy must use the prefix. When delegating to a subagent, include the full command in the prompt — don't assume the agent's shell has cached env vars. If a deploy crash-loops on `INBOX_DB_KEY`, this is the first thing to check.

**Incident**: 2026-04-22 evening — Sonnet executor running watermark-fix deploy used `dcc up` and brought the entire mail pipeline down. Recovered when Jeff ran the env-vault command interactively.

---

## Both mailroom containers need rebuild when `src/store/` changes

**Rule**: When changing files in `~/Projects/ConfigFiles/containers/mailroom/mailroom/src/store/`, rebuild and restart BOTH `mailroom-ingestor-1` and `mailroom-inbox-mcp-1`.

**Why**: The store layer (queries.ts, types.ts, db.ts, ingest.ts, watermarks.ts) is imported by both services. The ingestor uses it for live polling, watermark persistence, and message inserts. The inbox-mcp uses it for `search`, `recent`, `thread`, and message lookups in write tools. Rebuilding only one leaves the other on stale code.

**How to apply**:
- Changes in `src/store/` → both
- Changes in `src/mcp/` (server, tools) → only `inbox-mcp`
- Changes in `src/proton/`, `src/gmail/`, `src/rules/process-ingested.ts` → only `ingestor`
- Changes in `src/rules/` (engine, types, evaluator) → both (used by ingest path AND by `apply_action` MCP tool)

---

## Session resume hides MCP tool changes from Madison

**Rule**: NanoClaw's orchestrator persists `sessionId` per group and resumes the conversation on every spawn. When the MCP tool list changes (new tool registered, old tool removed), the model's in-context self-image stays anchored to the prior toolset because models heavily weight conversation history over fresh system prompts.

**Why**: `src/index.ts:348` reads the saved sessionId; `container/agent-runner/src/index.ts:761` passes it to the SDK as `resume: sessionId`. Even though CLAUDE.md is loaded fresh and the SDK fetches the new MCP tool list, the resumed conversation history is dominant in the model's self-model. Symptom: agent doesn't mention or use newly added tools, may invent errors for tools that don't exist in its old worldview.

**How to apply**:
- **Workaround until Phase 3 of `2026-04-madison-read-power`**: after deploying new MCP tools, manually clear the agent's session: `sqlite3 ~/containers/data/NanoClaw/store/messages.db "DELETE FROM sessions WHERE group_folder = '<group>'"`. Next spawn starts fresh.
- **Structural fix in flight**: see `lode/plans/active/2026-04-madison-read-power/tracker.md` AC-3 — adds tool-list-hash to sessions table; orchestrator invalidates session on hash mismatch automatically.
- **Until structural fix lands**: any MCP-tool deploy script should `clearSession()` for affected groups as the final step.

**Incident**: 2026-04-22 evening — Madison's capabilities list omitted ALL Phase 10 batch tools (`archive`, `label`, `add_label`, `remove_label`) plus `validate_rules` and `delete`, despite all being registered correctly on `mailroom-inbox-mcp-1` and documented in her fresh-loaded CLAUDE.md.

---

## Madison's confabulation has multiple distinct patterns

**Rule**: When investigating Madison reporting incorrectly, identify which confabulation pattern is in play before designing a fix:

1. **Bulk-action paraphrase**: claims action results without checking the per-id response shape (Phase 10's target — fixed by flat-array verb tools)
2. **Invented tool errors**: reports errors for tool calls she didn't make, often when asked to do something she lacks a tool for (no fix yet — needs persona reinforcement: "honest 'I don't have that tool' beats fabricated error")
3. **Self-citing prior fabrications**: justifies new claims by referencing her own prior false claims as precedent (compounds the others; only break by clearing context)
4. **Pre-rule-engine classification reports**: labels routine events as "silent / auto-handled" because she doesn't reconcile her event-stream view against the actual `applied` summary (could be fixed with a `mcp__inbox__why_classified(message_id)` tool that quotes the persisted decision)

**Why**: A single fix won't address all of them. Phase 10 verb tools structurally prevent #1 but don't touch #2, #3, or #4.

**How to apply**: When reviewing a Madison incident, classify which pattern(s) it matches before proposing a fix. Cite this lessons entry in the fix proposal so the right tool/persona/process change targets the actual pattern.

**Incident**: 2026-04-22 evening — Madison exhibited #2 and #3 in the "3 unread emails" thread; #4 in the earlier evening "auto-handled all silent" summary; #1 was the original 2026-04-22 morning incident that drove Phase 10.

---

## Watermarks must use a uniform `received_at` strategy across sources

**Rule**: The mailroom store's per-account watermark uses `received_at` (ISO 8601 timestamp) for both Gmail and Proton. Do not introduce source-specific watermark types (UID, ID hash, etc.) — they create parsing pitfalls and asymmetric SQL.

**Why**: An earlier design called for Proton's watermark to be the highest IMAP UID, but the actual `source_message_id` stored is the RFC 5322 Message-ID (`protonmail:<...@host>`), not a UID. `parseInt(...)` on that returns NaN, and the bad value got persisted as the literal string `"NaN"`. Subsequent `received_at > 'NaN'` matched everything → full backlog every sweep. Fixed in ConfigFiles `58a290f` by switching to `received_at`.

**How to apply**: When adding a new mail source (Outlook, Fastmail, etc.), wire its watermark strategy to `maxReceivedAt` and reuse the Gmail-style `recentStmt` SQL. Avoid writing custom UID parsing — `received_at` is already canonical and indexed.

**Reference**: `~/Projects/ConfigFiles/containers/mailroom/mailroom/src/store/queries.ts` `buildStrategies()`.

---

## Service-level invariants (env vars / mounts) outlive the design choices that put them there

**Rule**: When you add new behavior to a service that contradicts an existing service-level invariant (env var, mount mode, network constraint, port binding), audit and update the invariant in the same commit. Don't ship code that "should work" but is silently broken by an env var written months ago.

**Why**: madison-read-power Wave 2C added local-DB write-through to the inbox-mcp tools (`apply_action`, `archive`, `add_label`, etc.). Wave 4.5 added `mark_read` / `mark_unread`. Both shipped tests that ran on writeable test DBs and passed. Production failed silently because Phase M2 (mailroom-extraction) had set `MAILROOM_DB_READONLY=true` on the inbox-mcp service in compose — a deliberate "inbox-mcp is read-only" property at the time. Wave 2C's writes returned `attempt to write a readonly database` errors that were either caught by upstream-call-succeeded logic or mostly invisible because the next nightly reconcile populated the same data via the ingestor's writeable connection. The bug masqueraded as eventual consistency for weeks. AC-V5 surfaced it on 2026-04-23 because the AC explicitly tests "immediate query reflects the write" (no reconcile delay). Fix: drop `MAILROOM_DB_READONLY=true` from the inbox-mcp service env (CF `5935bf9`). Wave 2C's intent is now actually realized.

**How to apply**:
- Any wave that adds write paths to a service: grep the compose file for env vars / mount modes that imply read-only behavior on that service. Update them in the same PR.
- Integration tests that exercise the live deploy path catch this; tests against a writeable test DB do not. AC-style tests that include "via the actual MCP HTTP endpoint" are the right shape.
- When deprecating an architectural property (e.g., "service X is read-only"), also delete the comment and env var that asserted it. Stale comments saying "stays readonly via X=true" while the code writes through is exactly the smell. Mismatch between docstring and behavior is more dangerous than no docstring.
- Service-level invariants accumulate: each wave adds capability, often without noticing what it just contradicted. A "service capability matrix" reviewed at end-of-wave (does this service still hold the invariants the compose file claims?) would catch these.

**Incident**: 2026-04-23 — AC-V5 caught Wave 2C's silent local-DB write failure that had been live for weeks. Fixed in `5935bf9`. The Wave 4.5 mark_read tool surfaced the same bug immediately on first call (no reconcile path to mask it).

---

## Migration scripts must self-audit the DB state against their own reported metrics

**Rule**: A multi-phase migration script that mutates a production datastore must, before its own success exit, query the resulting DB and assert that observable counts match the metrics it reported. If they don't, the script must exit non-zero with a clear message naming the mismatch — never `phase=complete status=success` while the data is wrong.

**Why**: madison-read-power Wave 3.4 first-attempt deploy ran a 10-minute live migration that completed cleanly per its own logs (`phase=complete drafts_purged=0 spam_purged=0 rfc822_backfilled=59677 hydrated_adds=190381 inferred_deletes=0`). Sanity SQL afterward revealed three independent silent failures: (1) `message_labels=0` despite reported 190k adds, (2) `label_catalog=0` despite the catalog being part of the same write path, (3) `deleted_inferred=60,167` despite reported 0 — every pre-existing message marked deleted. The bugs were caught only because Jeff's reflex was to query the DB after deploy. Without that, the mirror would have looked correct via Madison's tooling for hours (queries with the new default `deleted_at IS NULL` filter would just return empty results) before someone noticed. Test suites + tsc were green throughout because vitest used in-memory mocks, never the real apply chain end-to-end against expected DB state.

**How to apply**:
- Every migration phase should have an audit query that's INDEPENDENT of the metrics counter — query the actual table, count the actual rows, compare to what the script claims it did.
- Make the audit fail loud: throw / exit 1 with a clear `audit_failed` log naming each mismatch and the rollback command (e.g., "Restore from btrfs snapshot and investigate before retrying"). Don't trust the script to recover gracefully on its own.
- Add invariant guards beyond just-equal-numbers: e.g., "if N Proton messages exist, `message_labels` must be ≥ N (every message has ≥1 folder)"; "deleted_inferred must not exceed 50% of total (blast guard)"; "if any adds were reported, `label_catalog` cannot be empty".
- Integration tests for migration scripts must seed synthetic state, run the script, and assert ROWS — not just counts. A test that asserts "applyLabelDelta returns adds_applied >= 1" passes for buggy code that returns the right metric but writes nothing. A test that asserts the message_labels table has rows X, Y, Z catches the silent-drop.
- When deploying, always have a one-line sanity SQL ready to run after the migration completes. Make it a checklist item in the deploy plan.

**Incident**: 2026-04-23 madison-read-power Wave 3.4 first attempt — cleanly-reported migration with 60,167 silently-wrong deleted flags + empty `message_labels` table. Rolled back via btrfs snapshot, fixed in Wave 3.5 (CF `57e631b`) which added the self-audit + integration tests that catch this class of bug.

---

## Cross-workstream API contracts must be specified in the orchestrator prompt, not inferred by executors

**Rule**: When parallel wave executors share an API surface across workstreams (e.g., one workstream produces a function the other consumes), the orchestrator's wave prompts MUST name the public-API shape (function names, signatures, ownership) — not just each side's primitives. If only the producing side's primitives are specified, the consuming side will work around the missing composed API with defensive scaffolding (runtime late-binding, sentinel flags, silent no-ops) that hides bugs from the type system.

**Why**: madison-read-power Wave 2A was prompted to "build walkers + delta builder + apply phase". Wave 2B was prompted to "fall back to per-account hydration on 404". 2A only exposed primitives; 2B couldn't import a composed `runGmailHydration` because it didn't exist, so it wrote runtime late-binding (`mod.runGmailHydration as ...`) that silently no-ops if the function is missing. Wave 3 then bypassed the gap by stubbing the reconcile scheduler's `runFn`. Production tsc failed; nightly reconcile silently broken; tests passed because vitest uses esbuild without strict tsc. Caught only by `tsc --noEmit` in design review. Required a follow-up gap-closure executor to: (1) add the composed `runFullHydration` API, (2) delete the late-binding scaffolding, (3) wire the scheduler from the composition root, (4) refactor the migration script to share the same code path. All this work could have been one cleaner Wave 2 if 2A's prompt had named "expose `runFullHydration` as the public reconcile entrypoint; primitives are internal".

**How to apply**:
- For any parallel wave with a producer/consumer split, the orchestrator's prompt to BOTH executors must name the cross-workstream API: function names, signatures, who exports it, who imports it. Consumers should be told to use direct imports — never runtime discovery via `typeof mod.fn === 'function'`.
- Run `tsc --noEmit` (or the strict project equivalent) at end-of-wave verification, not just `npm test`. Vitest with esbuild does NOT strict-type-check by default.
- If an executor writes late-binding scaffolding to defend against a missing dependency, treat that as a design-prompt failure and re-spec — don't ship the scaffolding.
- Schedulers that take a `runFn` parameter should always be wired from the composition root (the entrypoint that owns the application's wiring), not by burying default imports inside the scheduler module itself.

**Incident**: 2026-04-23 madison-read-power Wave 3 first pass shipped with 6 tsc errors and a no-op `runFn` stub. Gap closure committed as ConfigFiles `f398393`.

---

## Name things by what they ARE, not where they live

**Rule**: MCP tool family names should reflect the content domain they operate on, not the implementation container or folder they happen to live in. When the service is named "inbox-mcp" but the tool family is named "inbox", you conflate the service name with a content-scope (the Inbox folder). As the service grows to include archived mail, sent mail, and eventually Slack/SMS, the "inbox" name becomes increasingly misleading.

**Why**: the `mcp__inbox__*` tool family actually searched the unified message store — all ingested mail across 6 accounts, regardless of folder. A query returning an archived Proton message was correct behavior, but the name "inbox" implied it should only return current-inbox items. This forced users to add mental corrections ("when it says inbox it means the whole store"). The rename to `mcp__messages__*` plus documenting `labels: ["INBOX"]` as the explicit narrow-inbox filter makes the model match the reality.

**How to apply**: when naming a tool family or service API: (a) ask "what is the data domain this operates on?" (messages/emails), not "what is the service named?" (inbox-mcp) or "what is the primary use-case today?" (triage current inbox); (b) expose orthogonal concerns (inbox filter, sent/received, date range) as parameters rather than baking them into the name; (c) if today's use-case is a subset of the data domain, make the narrow view explicit via a parameter, not implicit in the name.

**Incident**: 2026-04-23 AC-V1 test — `query` returned archived Proton messages (correct behavior for the store), which looked wrong given the `mcp__inbox__` name. Renamed in Wave 5 to `mcp__messages__*` with `labels: ["INBOX"]` documented as the explicit inbox-view filter.

---

## Sonnet is the right model for template-following implementation work

**Rule**: When work follows a clear template (existing tool to copy, established pattern to mirror, ops script to run), delegate to Sonnet via the `lode-executor` subagent. Reserve Opus for orchestration: decomposition, trade-off acceptance, cross-agent synthesis, design review.

**Why**: Phase 10's three-wave parallel execution (Wave 1: 4× tools, Wave 2: register/test/document, Cleanup, Wave 3: deploy) used Sonnet executors throughout. All commits landed clean with tsc + tests passing. Total Opus orchestrator time was minimal (decomposition + result review). Cost win is significant when running 4 parallel implementers.

**How to apply**:
- 1-2 file changes following an existing pattern → Sonnet
- Tests mirroring existing test patterns → Sonnet
- Operational deploys with clear commands → Sonnet
- New architecture / cross-cutting design / trade-off resolution → Opus
- Reviewing parallel-agent outputs and surfacing inconsistencies → Opus

**Reference**: `lode/plans/active/2026-04-mail-push-redesign/progress.md` Phase 10 entries for the working pattern.
