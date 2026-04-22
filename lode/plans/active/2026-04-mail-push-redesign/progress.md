# Progress — Mail Push Redesign

## 2026-04-22 — Design session

Full design agreed in conversation between Jeff and Claude on the `unified-inbox` branch. Plan captured; `mail-push-redesign` branch created; no code yet.

### Actions

- Investigated "DocuSigns missed this morning" — found 3 DocuSigns ingested into store at 14:42–14:43 UTC. Live poller is fine. Bug is downstream of ingestion (see `findings.md`).
- Diagnosed auto-labeler dormancy (ephemeral in Madison's container, dying with each session).
- Diagnosed CLAUDE.md / tool staleness from M5 + M6.2.
- Iterated design across 8 conversation turns refining: rules schema (unified vs split, predicates, combinators, action semantics, label primitives), push vs polling, write MCP surface for Madison, account tags for multi-account future, mailroom-owns-writes pattern.
- Locked all decisions in `tracker.md` decisions table.
- Created branch `mail-push-redesign` off `unified-inbox` HEAD.

### Key conversation outcomes

1. **No live-poller scope change** — ingest isn't broken; the "All Mail" direction earlier was wrong.
2. **Push-only wakeups** — retire `:07` hourly and `*/15` labeler check; keep `7 AM` brief.
3. **Three-way event outcome**: urgent / routine / silent.
4. **Unified rules.json**, accumulate-and-override action semantics, array order = priority.
5. **Three label primitives**: `label`, `add_label`, `remove_label`.
6. **Separate `accounts.json`** with per-account tags (`work`, `personal`, `contractor:x`).
7. **Canonical label names** (no `Labels/` prefix); mailroom translates per source.
8. **Mailroom owns all email writes**; Madison's surface is `mcp__inbox__*` only (with 4 new tools: `apply_action`, `delete`, `send_reply`, `send_message`).
9. **Send rate-limit 20/hour/account** + send-log for audit.
10. **Soft-delete only** in v1 (no hard expunge).

### Test results

*(none yet — design-only session)*

## 2026-04-22 — Phase 1.1: Madison CLAUDE.md patched

### Actions

- Read tracker, findings, and progress to ground in the agreed design before touching any file.
- Confirmed `~/containers/data/NanoClaw/groups/telegram_inbox/CLAUDE.md` is in the data volume (no git ancestor) — patch is live on next Madison spawn; no commit needed for that file.
- Inserted new `## Current limitation (2026-04-22 — pending mail-push-redesign Phase 4)` section between the intro paragraph and `## Triage workflow`. Spells out the M5 (Gmail MCP removed, commit 87e658b) and M6.2 (Proton bridge loopback bind) causes, lists the four future `mcp__inbox__*` write tools, and tells Madison three concrete behaviors: (a) reads still work, (b) for any write surface the recommendation and tell Jeff explicitly she can't execute it, (c) capture Jeff's action commands in `_digests/<date>.md` for batch application post-Phase-4.
- Replaced the stale "Actions" subsection under *Inboxes to sweep* — the one that previously listed `mcp__gmail__send_email`, `mcp__gmail__modify_email`, `mcp__gmail__read_email`, and direct ProtonMail IMAP/SMTP via bridge.
- Replaced the stale "Email actions" line in the Tools list near the bottom with the same Phase-4 pointer.
- Grep swept for residual `mcp__gmail|imap|smtp|bridge|protonmail-bridge` matches: only my new explanatory text and the auto-labeler scheduled-task roster row remain. The roster row is correctly scoped to Phase 8.

### Test results

| Test | Status | Notes |
|---|---|---|
| Verify no residual stale write-tool references | pass | Only the new `## Current limitation` section, the neutralized Actions/Tools entries, and the Phase-8-owned auto-labeler roster row remain. |

### Reboot check (for next session)

1. **Where am I?**
   Phase 1 complete. Madison's CLAUDE.md no longer claims Gmail write tools or direct Proton bridge access. Ready to start Phase 2.

2. **Where am I going?**
   Phase 2 — rule engine in mailroom (types, loader, matcher, evaluate, CLI validate, unit tests, schema doc). All code under `~/Projects/ConfigFiles/containers/mailroom/mailroom/src/rules/` (stow-managed; not in this nanoclaw repo). Then Phase 3 (apply + events), Phase 4 (MCP writes), Phase 5 (subscriber branch), Phase 6 (initial rules.json + accounts.json), Phase 7 (Madison rewrite), Phase 8 (retire legacy), Phase 9 (verify + graduate).

3. **What is the goal?**
   Replace Madison's polling-based triage with event-driven push from mailroom. Unified cross-source rules engine evaluates at ingest, emits urgent/routine/silent events, owns all email write operations behind an `mcp__inbox__*` surface.

4. **What have I learned?**
   - The Madison CLAUDE.md file is in `~/containers/data/NanoClaw/groups/telegram_inbox/` — a data volume, not under git. Edits land live on next spawn; commit-on-this-branch language in tracker.md only applies to lode bookkeeping for that phase.
   - Beyond the two lines the plan called out (41, 274), the stale references were paragraph-shaped (the whole "Actions" subsection plus its "Why the split" paragraph that justified backend-tool writes). Worth reading the full file before assuming line targets are exhaustive.
   - The auto-labeler scheduled-task roster row at line 296 is owned by Phase 8 (retire legacy), not Phase 1.1. Leaving it intact preserved scope.

5. **What have I done?**
   - Three Edit operations on Madison's CLAUDE.md.
   - Tracker checkbox for 1.1 flipped; "Current status" rewritten to point at Phase 2.1 as the next action.
   - This progress entry.

## Next steps (to resume)

1. **Phase 9** — verify end-to-end:
   - Rebuild both mailroom containers (`./container/build.sh && dcc up -d`) and restart nanoclaw (systemctl --user restart nanoclaw).
   - Send a test DocuSign-style email; verify `inbox:urgent` event fires within one ingest cycle (<2 min) and Madison spawns immediately.
   - Send a test routine email (e.g. an Amazon shipping notification); verify it's labeled but waits for the next polling cycle, then routine spawn.
   - Measure spawn count over the next 24h vs the historical ~180/day baseline.
   - Graduate durable findings to permanent lode files: `lode/architecture/mailroom-rules.md`, `lode/architecture/madison-pipeline.md`, `lode/reference/rules-schema.md` (per `findings.md` "Graduation pointers").
   - Move this plan from `lode/plans/active/` to `lode/plans/complete/`.

The decisions table in `tracker.md` is the implementation contract. If a decision seems wrong mid-build, stop and re-plan rather than drift.

## 2026-04-22 — Phase 2.1: rules engine types

### Actions

- Inspected mailroom `src/store/types.ts`, `src/events/types.ts`, and `src/ingestor.ts` to align on conventions: ESM `.js` imports, `import type` for type-only, 2-space indent, strict TS, snake_case field names for persisted shapes (matches the JSON file format users will edit).
- Created `~/Projects/ConfigFiles/containers/mailroom/mailroom/src/rules/types.ts`. Exports:
  - `StringMatcher = string | string[]` — uniform "any-of" semantics across all string predicates.
  - `LeafPredicate` — every field operator from AC-1 (sender_equals/contains/matches, subject_*, body_contains/matches, has_label, source, account, account_tag).
  - `Combinators` — `all` / `any` / `not`. Composed via `Predicate = LeafPredicate & Combinators`, so leaf fields and combinators on the same object are AND-ed.
  - `Actions` — `urgent`, `auto_archive`, `qcm_alert`, plus the three label primitives (`label` replace / `add_label` union / `remove_label` subtract).
  - `Rule` (with optional `name` + `comment`), `RulesFile`, `AccountEntry`, `AccountsFile`.
  - `RuleMatchContext` — the matcher-visible bundle of `{message, labels_at_ingest, account_tags}`. Encodes the locked decision that `has_label` predicates evaluate against ingest-time labels, NOT against labels accumulated by earlier rules in the same pass.
  - `ResolvedActions` — the apply-layer input: `{urgent, auto_archive, qcm_alert, labels[]}` after accumulation + conflict resolution (urgent forces auto_archive false).
- Verified clean compile: `cd ~/Projects/ConfigFiles/containers/mailroom/mailroom && npx tsc --noEmit` exited 0.
- Committed `a5896fe` in ConfigFiles. Mailroom repo lives on `main` (trunk-based per parent mailroom-extraction plan); no feature branch in ConfigFiles.

### Test results

| Test | Status | Notes |
|---|---|---|
| `tsc --noEmit` against full mailroom tree | pass | exit 0 |

### Reboot check (for next session)

1. **Where am I?** Phase 2.1 done. types.ts compiles. Next is loader.ts.
2. **Where am I going?** Through Phase 2 (loader / matcher / evaluate / CLI validate / unit tests / schema.md), then 3, 4, 5, 6, 7, 8, 9.
3. **What is the goal?** Push-driven, rules-engine-powered mail triage replacing Madison's polling. See top-level tracker Goal.
4. **What have I learned?**
   - Mailroom repo (`~/Projects/ConfigFiles/containers/mailroom/mailroom/`) is on `main`, not on a feature branch — every mailroom commit goes to ConfigFiles main. Only the lode and the nanoclaw-side subscriber/runner edits live on the `mail-push-redesign` branch.
   - Bookkeeping pattern: the cross-repo commit hash gets backfilled into the nanoclaw lode tracker so the audit trail crosses the repo boundary cleanly.
5. **What have I done?** Created `src/rules/types.ts` (138 lines), tsc clean, committed.

## 2026-04-22 — Phase 2.2: rules loader

### Actions

- Inspected `events/emit.ts`, `ingestor.ts`, `logger.ts`, and the `MAILROOM_DATA_DIR` env pattern used across `store/db.ts`, `gmail/poller.ts`, `proton/poller.ts`. Standardized on the same `process.env.MAILROOM_DATA_DIR ?? '/var/mailroom/data'` resolver.
- Wrote `src/rules/loader.ts`. Public surface: `startRulesLoader({dataDir?, pollIntervalMs?})` returning `{getRules(), getAccounts(), getAccountTags(account_id), stop()}`. Also exports `validateRulesFile`, `validateAccountsFile`, `RulesValidationError` for the Phase 2.5 CLI.
- Validation walks the entire document and throws `RulesValidationError(docPath, reason)` with paths like `rules[2].match.all[1].subject_matches`. Validates: top-level `version: 1`, every leaf predicate field, `all`/`any`/`not` combinators recursively, every action field (boolean vs. StringMatcher), source enum, account-entry shape, duplicate account ids, regex compilability via `new RegExp(s)`. Unknown fields anywhere in rules / predicates / actions / accounts are rejected (catches typos like `actoins`).
- Hot reload via 5s mtime poll (configurable, `interval.unref()` so it doesn't pin the event loop). On parse / schema / regex failure, last-valid stays in memory and an error is logged. ENOENT for either file is treated as "empty defaults" plus a one-shot warning so first boot before files exist is not fatal.
- `getAccountTags` lookup-cache rebuilt per accounts reload (`Map<id, tags[]>`). Returns `[]` for unknown ids — matcher.ts can call without a presence check.
- TS strip-only mode (Node `--input-type=module` against `.ts` source) doesn't support parameter properties; refactored `RulesValidationError` to plain field assignments so the file works under any TS-strip runtime, including the CLI in Phase 2.5.
- Smoke tests against `dist/`:
  - Initial load with valid rules + accounts: parsed, account-tag map populated, unknown id → `[]`.
  - Malformed JSON write: last-valid (2 rules) preserved.
  - Bad regex write (`sender_matches: '(unclosed'`): last-valid preserved.
  - Subsequent valid write: hot-reloaded within one poll cycle (250ms wait, 100ms poll).
  - Direct `validateRulesFile` rejections: version mismatch, unknown rule key (`actoins`), unknown predicate field, unknown action field, non-boolean for boolean action, non-enum source value — all returned doc-pathed error messages.
  - Edge case: empty `match: {}` accepted as a catch-all (matches every message; intentional — useful for trailing default-action rules).

### Test results

| Test | Status | Notes |
|---|---|---|
| `tsc --noEmit` after refactor | pass | exit 0 |
| smoke test against `dist/rules/loader.js` | pass | 7 schema-rejection cases + 4 hot-reload cases all behaved as designed |

### Reboot check (for next session)

1. **Where am I?** Phase 2.2 done. Loader compiles and behaves correctly across malformed-edit / bad-regex / hot-reload paths.
2. **Where am I going?** Phase 2.3 matcher → 2.4 evaluate → 2.5 CLI validate → 2.6 unit tests → 2.7 schema.md, then Phase 3+.
3. **What is the goal?** Push-driven, rules-engine-powered mail triage replacing Madison's polling. See top-level tracker Goal.
4. **What have I learned?**
   - Node 22's TS strip-only mode cannot parse parameter properties (`constructor(public readonly x: T)`). For modules that may be loaded via `node --input-type=module` (the CLI in Phase 2.5 will), keep `class` fields in plain assignment form.
   - Source-from-`.ts` execution under Node strip mode also requires `.ts` extensions in import specifiers (the codebase uses `.js` per ESM compile-target convention). So smoke testing source-files directly isn't viable here; build to `dist/` and run from there.
   - `setInterval(...).unref()` keeps the loader from preventing process exit when the poll timer is the only remaining work.
5. **What have I done?** `src/rules/loader.ts` (442 lines incl. validators), `tsc` clean, smoke-tested across malformed/bad-regex/recovery paths, committed `f664d54`.

## 2026-04-22 — Phases 2.3 through 2.7: rules engine complete

### Actions (by sub-phase)

- **2.3** — `src/rules/matcher.ts`. Pure `matches(Predicate, RuleMatchContext): boolean` recursively walks leaves and `all`/`any`/`not` combinators, short-circuiting on AND/OR. `_equals`+`_contains` for sender/subject/body are case-insensitive; `_matches`/`has_label`/`account`/`account_tag` case-sensitive. Extended `RuleMatchContext` with `sender_email`/`sender_name` (InboxMessage only carries sender_id hash; matcher needs the actual address). V8-in-Node-22 does NOT support inline flag syntax `(?i)` or `(?i:...)` — discovered via smoke test; corrected the docstring and schema.md to recommend `_contains` for case-blind substring needs. Also exports `matchingRuleIndices` for provenance. Commit `668769c`.
- **2.4** — `src/rules/evaluate.ts`. Walks rules, accumulates actions, resolves conflict (urgent forces auto_archive false). Labels accumulate via set ops (within one rule: replace → union → subtract; across rules: array order). Exports `evaluate`, `evaluateWithProvenance` (returns resolved + matched_rule_indices), `anyRuleMatches`. Commit `edd5d96`.
- **2.5** — `src/cli/rules-validate.ts`. Standalone CLI: emits JSON on stdout with per-file ok/error shape, exits 0 on both-valid / 1 on invalid / 2 on bad usage. Reuses `validateRulesFile` / `validateAccountsFile` / `RulesValidationError` from the loader — single validation codepath. Args: `--rules PATH`, `--accounts PATH`, `--help`. Commit `37c6593`.
- **2.6** — vitest suites at `matcher.test.ts` (21 tests) + `evaluate.test.ts` (17 tests) + `loader.test.ts` (16 tests). All 54 passing. Covers every bullet of tracker §2.6: predicate eval with all leaf types and combinators incl. empty-predicate / empty-all / empty-any / empty-not edge cases; accumulation (label set ops + scalar last-writer-wins + missing-field-doesn't-overwrite); conflict resolution in all four urgent/auto_archive combinations; hot-reload on valid-edit / malformed-JSON / schema-violation / bad-regex / recovery-after-error; cross-source rules via source/account/account_tag; shared validator error-path cases with exact doc-path assertions. Commit `6cd7bad`.
- **2.7** — `src/rules/schema.md`. Authoritative reference for Madison: file shapes, predicate leaf field table with case-sensitivity, combinator edge cases, action table with accumulation rules, urgent-vs-auto_archive conflict explanation, silent-event behavior (auto_archive + !urgent → no event), six common-pattern examples (urgent sender, auto-archive newsletter, multi-dim label, broad+narrow override, cross-account tag rule, QCM preservation), editing workflow with the rules-validate CLI, failure-mode cheat-sheet. Commit `3d0d582`.

### Test results

| Test | Status | Notes |
|---|---|---|
| `npm test` (vitest run) | pass | 54/54 across 3 files in 1.6s |
| `tsc --noEmit` | pass | clean |
| CLI end-to-end smoke | pass | valid / bad-regex / missing-tags / nonexistent file / --help all behaved as designed |
| Evaluator smoke (9 cases) | pass | defaults, conflict resolution, label set ops, last-writer, provenance |
| Matcher smoke (41 cases) | pass | every leaf + combinator path + V8-regex-behavior probe |

### Reboot check (for next session)

1. **Where am I?** Phase 2 complete — rules engine fully functional but not yet wired into the ingestor. No message currently triggers rule evaluation; next phase hooks it in.
2. **Where am I going?** Phase 3 wires the engine into mailroom's ingest pipeline: apply/proton.ts + apply/gmail.ts + apply.ts dispatcher, new event types (inbox:urgent / inbox:routine), `emit` helpers, ingestor.ts call that evaluates and applies on every successful insert.
3. **What is the goal?** Push-driven, rules-engine-powered mail triage replacing Madison's polling. See top-level tracker Goal.
4. **What have I learned?**
   - Node 22's V8 does NOT support inline regex flag syntax (`(?i)`, `(?i:...)`, `(?-i:...)`). Only the full RegExp constructor `i` flag, which is not exposed through a pattern-string API. The realistic workaround for case-blind substring matching is the `_contains` operator (already case-insensitive). Pattern-level case folding requires explicit character classes like `[Dd][Ss][Ee]`.
   - Node strip-only mode (when running `.ts` files directly) does NOT support TS parameter properties — `constructor(public readonly x: T)` — and requires `.ts` in import specifiers rather than the `.js`-target-convention the codebase uses. For modules loaded via `node --input-type=module` (like the CLI will be in prod via `node dist/cli/rules-validate.js`), always compile to `dist/` first and run from there; keep class fields in plain-assignment form.
   - InboxMessage carries `sender_id` (a hash), not the email address. Anything evaluating sender-based predicates needs the denormalized email+name. Updated `RuleMatchContext` accordingly; ingestor.ts will populate these at the same point it builds the InboxNewEvent payload.
   - Vitest runs TS sources directly via Vite transform — no build step needed for test running.
5. **What have I done?** 7 mailroom commits (a5896fe, f664d54, 668769c, edd5d96, 37c6593, 6cd7bad, 3d0d582), roughly 1800 lines of code + tests + docs. All committed to ConfigFiles main.

## 2026-04-22 — Phase 3: rules engine wired into ingest pipeline

### Actions

- **Pre-Phase-3 design fix** (commit `8b21b87`) — Discovered while planning the apply layer that `ResolvedActions.labels: string[]` collapsed every label primitive into a single "final set" output, which lost `remove_label` intent. Refactored to two disjoint sets — `labels_to_add` and `labels_to_remove` — that survive the evaluation pass intact. Updated evaluator (set ops keep them disjoint by construction), tests (added explicit remove-intent and add↔remove cancellation cases), and schema.md (documented the two-set model). 56 tests passing after refactor.
- **Inspected existing pollers** to understand connection/client lifecycles:
  - Proton: ephemeral IMAP connection per address per poll cycle (closes after); poller holds INBOX lock during message processing. New apply happens INSIDE the poller iteration so we can reuse the same client + UID. Multiple sessions per Proton account work fine on the bridge.
  - Gmail: long-lived `OAuth2Client` + `gmail_v1.Gmail` instance owned by `GmailPoller`. Apply reuses both.
  - Both use `ingestMessage` returning `{message_id, inserted}`. Extended additively to also return the canonical `InboxMessage` shape so pollers don't have to rebuild it for the rule engine.
- **3.1 Proton apply** (`src/rules/apply/proton.ts`): COPY to `Labels/<name>` with auto-create-if-missing (per-account `Set<string>` cache; ignores "already exists" errors), Archive MOVE for `auto_archive`, ordered correctly (COPY first while UID is valid in INBOX, MOVE last). `remove_label` intent recorded in apply-result but not applied at ingest time — would need a lock switch to the `Labels/<name>` folder + EXPUNGE; deferred to a follow-up. Logged loudly so the gap is observable.
- **3.2 Gmail apply** (`src/rules/apply/gmail.ts`): batched `users.messages.modify` per message with resolved IDs. Per-account `Map<string,string>` name→ID cache with two phases — eager `users.labels.list` on first use, then lazy `users.labels.create` for unknown names. `auto_archive` = `removeLabelIds: ['INBOX']` in the same modify call. `remove_label` for an unknown label is a silent no-op (no point creating-then-removing).
- **3.3 Apply dispatcher** (`src/rules/apply.ts`): discriminated `ApplyContext` union (`{source: 'gmail', gmail, account_email}` or `{source: 'protonmail', client, uid, account_address}`). TS prevents callers from passing the wrong shape. Returns a uniform `ApplyResult` shape with the per-source-specific `labels_remove_skipped` field for Proton's deferred-remove case.
- **3.4 Event types + emitters** (`src/events/types.ts`, `src/events/emit.ts`): added `InboxClassifiedBase` + `InboxUrgentEvent` + `InboxRoutineEvent`, where the base carries an `applied: { labels_added, labels_removed, archived, qcm_alert, matched_rule_indices }` summary so the subscriber and the future `mcp__inbox__why` tool can explain the decision without re-running the engine. `emitInboxUrgent` and `emitInboxRoutine` write files prefixed `inbox-urgent-`/`inbox-routine-` so the subscriber can glob by priority. Legacy `emitInboxNew` retained for the Phase-5 transition window.
- **3.5 Ingestor wiring**:
  - `src/ingestor.ts`: starts the rules loader at bootstrap and passes it into both pollers; calls `loader.stop()` on shutdown.
  - `src/proton/poller.ts` + `src/gmail/poller.ts`: accept `rulesLoader` opt; each `processMessage` now calls `processIngestedMessage` instead of `emitInboxNew`. Proton passes `labels_at_ingest: []` (per-message cross-folder search would be expensive; deferred). Gmail builds a lazy reverse `id→name` cache from `users.labels.list` to translate `msg.data.labelIds` → canonical names for `has_label` predicates.
- **3.6 QCM side-channel** (`src/rules/qcm.ts`): appends a JSON record to `${MAILROOM_QCM_ALERTS_PATH:-$MAILROOM_DATA_DIR/qcm_alerts.jsonl}` BEFORE the event fires (so any downstream poller of that file sees the alert no later than the subscriber). Best-effort — write failures log and return without throwing.
- **process-ingested orchestrator** (`src/rules/process-ingested.ts`): single per-message function called by both pollers. Builds `RuleMatchContext`, runs `evaluateWithProvenance`, runs `applyActions`, runs the QCM side-channel, emits the correct event (urgent / routine / silent). Apply errors are caught and logged but the event still fires — ingest contract says "we always tell you about new mail unless you explicitly archived it silently."
- **3.7 Integration tests** (`src/rules/process-ingested.test.ts`, 8 tests): real rules.json through the loader, real evaluator, real event-file emission to a temp `MAILROOM_DATA_DIR`, apply layer stubbed via `vi.hoisted` (had to use `vi.hoisted` because `vi.mock` is hoisted above plain `const` declarations — first attempt with a top-level mock fn threw `Cannot access 'applyActionsMock' before initialization`). Covers: urgent rule → urgent event, routine rule → routine event, silent (auto_archive + !urgent) → no event but apply still runs, urgent overrides auto_archive in conflict, qcm_alert writes JSONL before event, empty rules → routine with empty applied, apply failure non-blocking, account_tag predicate firing for tagged vs untagged accounts.

### Test results

| Test | Status | Notes |
|---|---|---|
| `tsc --noEmit` after Phase 3 | pass | clean |
| `npm test` (vitest) | pass | 64 / 64 (4 files: matcher, evaluate, loader, process-ingested) |

### Reboot check (for next session)

1. **Where am I?** Phase 3 done. Mailroom now classifies and acts on every newly-ingested message. The container will emit `inbox-urgent-*.json` / `inbox-routine-*.json` files instead of `inbox-new-*.json` after the next rebuild — but the nanoclaw subscriber won't pick them up until Phase 5 ships. Hold the container restart.
2. **Where am I going?** Phase 4 — MCP write tools (`apply_action` / `delete` / `send_reply` / `send_message`) on the existing HTTP MCP at `http://host.docker.internal:18080/mcp`, plus a send-log JSONL with 20/hour per-from-account rate limit.
3. **What is the goal?** Push-driven, rules-engine-powered mail triage replacing Madison's polling + give Madison the four write tools she needs to actually act on mail.
4. **What have I learned?**
   - Big design fix discovered while planning Phase 3 implementation: a "final-set" model for resolved labels loses `remove_label` intent. Two-set model (add + remove disjoint) is the right shape. Lesson: when a contract collapses information at a stage, look hard at what the next stage needs before declaring it final.
   - `vi.mock` calls hoist to the top of the file, ABOVE plain top-level `const` declarations. To share a mock fn between the factory and test code, use `vi.hoisted(() => ({ ... }))` — that hoists the destructured const alongside the mock.
   - `ingestMessage` was a clean hook to extend additively for Phase 3 (returning the full InboxMessage from a single insert avoids upstream rebuilding). When designing return shapes for shared functions, prefer returning the canonical row over computed scalars — future consumers usually want the row.
   - Proton bridge supports multiple IMAP sessions per account — the existing poller holds an INBOX lock on its connection but apply can either reuse that connection (since we're inside the poller iteration) or open another session without contention. We picked reuse for simplicity at ingest time.
   - The Proton `remove_label` operation (delete from `Labels/<name>` folder) is awkward to do at ingest time because it requires a lock switch to the destination folder. Recorded as a known gap in `apply/proton.ts` for a Phase-4-or-later follow-up; for now the intent is reported but not applied.
5. **What have I done?** Phase 3 body in commit `a493fcb` (12 files, +1251/-64). Plus the design-fix prereq `8b21b87` (5 files, +142/-114). 64 tests across 4 files passing.

## 2026-04-22 — Phase 4: MCP write surface

### Actions

- **4a** (`dfbe804`, 9 files, +789 lines) — apply_action + delete + send-log foundation + DI refactor.
  - `src/mcp/server.ts` refactored to accept `InboxMcpDeps = { rulesLoader, gmail?, gmailAccountEmail?, protonConfig? }`. Write tools registered conditionally; per-tool guards return clean errors when a needed dep is missing (e.g. Gmail tool against a Proton-only deploy).
  - `src/mcp-server.ts` builds deps at startup: loads rules, best-effort Gmail client, best-effort Proton config. Same dep handles passed to every per-session `createInboxMcpServer` call.
  - `src/mcp/tools/apply_action.ts` — validates actions via `validateActions` (re-exported from loader.ts) + runs them through `evaluate()` with a single synthetic rule so the MCP path gets the same conflict-resolution and label-set-normalization as ingest. Dispatches via `applyActions` with a discriminated `ApplyContext`. For Proton, opens an ephemeral IMAP session and searches INBOX → Archive for the message by RFC 5322 Message-ID.
  - `src/mcp/tools/delete.ts` — Gmail `messages.trash` or Proton IMAP MOVE to Trash. Soft-delete only (locked decision).
  - `src/mcp/proton-client.ts` — `openProtonClient(address, password)` + `findMessageByMessageId(client, rfc5322Id)`. v1 searches INBOX → Archive; Labels/* and Trash are a follow-up.
  - `src/mcp/send-log.ts` — append-per-send JSONL at `${MAILROOM_SEND_LOG_PATH:-…/send-log.jsonl}` + per-from-account rolling-hour rate limiter (default 20, configurable via `MAILROOM_SEND_RATE_PER_HOUR`). Hydrates from disk on first check so the limit survives MCP restarts.
  - `src/store/queries.ts` — `getMessageById(message_id)` + `getSenderEmailById(sender_id)` helpers (later 4b commit adds getSenderEmailById).
  - `docker-compose.yml` — inbox-mcp service switched data mount to RW (send-log writes), added Gmail OAuth RW mount (token refresh), added PROTONMAIL_* envs, attached `protonmail` external network. Kept `MAILROOM_DB_READONLY=true` so MCP can't corrupt the ingestor's store writes — belt-and-suspenders.
- **4b** (`e5ff729`, 8 files, +866 lines) — send_message + send_reply + nodemailer transport + tests.
  - `src/mcp/sender.ts` — owns RFC 5322 assembly via nodemailer (built to a Buffer when targeting Gmail's raw API; streamed directly to the bridge SMTP transport for Proton). Rate-limit check + send-log record happen here (single place, regardless of which tool originates the call).
  - `src/mcp/tools/send_message.ts` — fresh outbound; accepts single-string or array `to`/`cc`/`bcc`; fail-fast on empty to-list; validates `from_account` against `accounts.json`.
  - `src/mcp/tools/send_reply.ts` — pulls thread via `getThread`, picks the latest message's sender (resolved via `getSenderEmailById`) as To:, its receiving account as From:, `"Re: <subject>"` without double-Re, `In-Reply-To: <last.source_message_id>` wrapped, `References: [last.source_id]` (v1 doesn't store full chain; mail clients are forgiving).
  - Gmail transport: `users.messages.send` with base64url raw bytes; passes `threadId` (stripped of the `gmail:` prefix) so Gmail threads correctly.
  - Proton transport: nodemailer SMTP to `protonmail-bridge:25`, auth with the same bridge user/password the IMAP path uses.
  - 17 new tests: 7 send-log (rate allow + boundary-block + per-account isolation + hydrate-from-disk + stale-outside-window + append + env override), 6 send_reply (dispatch correctness + no-double-Re + already-wrapped Message-ID + cc/bcc forwarding + nonexistent-thread + missing-arg), 4 send_message (single vs array to + cc/bcc + missing-required + empty-to rejection). All mock via `vi.hoisted` (sender mock for the tool tests; send-log uses real fs with tempdir isolation).

### Test results

| Test | Status | Notes |
|---|---|---|
| `tsc --noEmit` after Phase 4a + 4b | pass | clean |
| `npm test` (vitest) | pass | 81 / 81 across 7 files |

### Reboot check (for next session)

1. **Where am I?** Phase 4 done. Mailroom's inbox-mcp now exposes four write tools: apply_action, delete, send_message, send_reply. Plus send-log + rate limiter. Write tools only register when deps are supplied so backward compat for the read-only deployment is preserved.
2. **Where am I going?** Phase 5 — nanoclaw subscriber update + the Madison RW mount for `rules.json` / `accounts.json`. That's the other half of the transition: until Phase 5 lands, mailroom emits `inbox-urgent-*.json` / `inbox-routine-*.json` files that the subscriber doesn't pick up.
3. **What is the goal?** Push-driven, rules-engine-powered mail triage replacing Madison's polling + give Madison the four write tools she needs to actually act on mail. Rule engine is live post-Phase-3; MCP writes are live post-Phase-4; subscriber + Madison-side lands Phase 5+.
4. **What have I learned?**
   - `createInboxMcpServer` was called per-session; sharing stateful deps (rules loader, Gmail client, send-log rate state) across sessions means those deps must live at the process level, not the session level. The DI pattern (inject a `InboxMcpDeps` bag) keeps test isolation cheap while fixing the shared-state problem.
   - The MCP process doesn't need write access to the SQLite store — all Phase 4 writes go to Gmail/Proton (external systems) + `send-log.jsonl` (sibling file). Keeping `MAILROOM_DB_READONLY=true` defends against future drift where a tool accidentally tries to update the store.
   - Proton bridge accepts SMTP on `protonmail-bridge:25` with the same user/password as IMAP — nodemailer just works once the `protonmail` external network is attached.
   - Gmail's `users.messages.send` API accepts a `threadId` to thread replies correctly, but only the raw numeric part — the store prefixes with `gmail:`, so strip before passing.
   - nodemailer's `streamTransport: true, buffer: true` mode builds a Buffer of the RFC 5322 message without sending it — exactly what Gmail's base64url-raw API needs. Same composer, two transports.
   - Store helpers are the right abstraction boundary. Every time I wrote an inline `db.prepare('SELECT ...').get(...)` in a tool, I was making the tool harder to test and duplicating a pattern. Promoted `getMessageById` + `getSenderEmailById` to `queries.ts`; the follow-on tools stayed clean.
5. **What have I done?** 2 mailroom commits: `dfbe804` (Phase 4a, 789 lines) + `e5ff729` (Phase 4b, 866 lines). 81 tests passing across 7 files.

## 2026-04-22 — Phase 5: nanoclaw subscriber transition

### Actions

- Read the existing subscriber + `index.ts` `onMessage` handler + `group-queue.ts` to understand the actual architecture. **Discovery:** there is NO existing N-message / T-timer batch threshold for routine events — the tracker §5.2 wording assumed one that doesn't exist. Today every stored message → main loop's POLL_INTERVAL (2s) polling cycle → spawn (for `requiresTrigger: false` groups, which is how the email target is configured). The implicit batch window IS the 2s polling interval.
- This changed the design: instead of wiring "bypass N-msg threshold", the urgent path bypasses the 2s POLL_INTERVAL by enqueueing immediately. Routine just stores; the next poll cycle picks it up. Explicit routine batching deferred — most spawn-rate reduction comes from mailroom's silent-event filtering (`auto_archive && !urgent` → no event), which Phase 3 already shipped. If post-deploy measurements show routine spawns are still too frequent, a real batch threshold becomes a focused follow-up.
- Extended `ChannelOpts` with `requestImmediateProcessing?: (jid) => void` callback. Wired in `index.ts` to call `queue.enqueueMessageCheck(chatJid)`. Defensive no-op when the target group isn't registered (handles the boot race where events arrive before group config loads).
- Rewrote `src/channels/mailroom-subscriber.ts`:
  - Glob both `inbox-urgent-*.json` and `inbox-routine-*.json`. Keeps the legacy `inbox-new-*.json` glob during transition so any in-flight events from the previous emit version aren't quarantined.
  - Discriminates by the `event.event` field in the payload (single source of truth). Logs a warning when filename prefix and payload event field disagree; payload wins.
  - Surfaces the rule-engine `applied` summary in Madison's prompt content (labels added/removed/archived/qcm_alert), so she has the rule decision context without re-running the engine.
  - Urgent triggers `requestImmediateProcessing(targetJid)` after `onMessage`; routine and legacy don't.
- Added the gated RW mount in `src/container-runner.ts`: when `group.folder === EMAIL_TARGET_FOLDER`, mount `~/containers/data/mailroom → /workspace/extra/mailroom`. Gated by group folder check (not the external mount allowlist) since this is a system integration, not a Madison-configured choice. Logs a warning if the host dir is missing rather than failing container startup.
- Wrote 9 vitest cases in `src/channels/mailroom-subscriber.test.ts`: temp `MAILROOM_IPC_OUT_DIR`, mock `ChannelOpts.onMessage` + `requestImmediateProcessing` via `vi.fn<T>()`. Covers urgent + routine + legacy + filename-payload mismatch + unknown-prefix-ignored + invalid-JSON-quarantined + schema-invalid-quarantined + multiple-routine-don't-spawn + no-target-group-silent-drop. Each test waits 1.2s for the 1s poll cycle (the test takes ~11s total because of polling latency; acceptable for now — could parametrize POLL_INTERVAL_MS for tests if it gets annoying).
- `tsc --noEmit` initially failed on the inline factory call in the "no email target group" test because `vi.fn()` returns `Mock<Procedure | Constructable>` which TS can't narrow to specific channel-callback signatures. Fixed by switching to `vi.fn<OnMessageFn>()` typed generics — both the helper-built and inline call sites type-check cleanly while assertions keep working. (Footnote: vitest doesn't enforce strict TS during test runs, so this only surfaced when I re-ran tsc after the prettier pre-commit hook reformatted the file.)

### Test results

| Test | Status | Notes |
|---|---|---|
| `tsc --noEmit` after Phase 5 | pass | clean |
| `npm test` | pass | 303 / 303 (was 294 before; +9 subscriber tests) |

### Reboot check (for next session)

1. **Where am I?** Phase 5 done. Both halves of the event-type transition are live. The system is now safe to restart in any order: nanoclaw picks up Phase 5 on process restart; mailroom containers (`ingestor` + `inbox-mcp`) need `./container/build.sh` + restart for Phases 3 + 4.
2. **Where am I going?** Phase 6 — seed `rules.json` + `accounts.json` with the actual Jeff content (port 27 imap_autolabel.py rules, add DocuSign + QCM urgents, build accounts roster, seed changelog). Then Phase 7 (Madison CLAUDE.md rewrite), Phase 8 (retire legacy), Phase 9 (verify + graduate).
3. **What is the goal?** Push-driven, rules-engine-powered mail triage replacing Madison's polling. Sub-minute urgent surface latency. ~5-10x reduction in Madison spawn count via silent-event filtering at mailroom + retired scheduled tasks.
4. **What have I learned?**
   - **Verify the architecture before honoring tracker assumptions.** The tracker §5.2 mentioned "bypass the N-message batch threshold" but no such threshold exists today; the implicit batch is the 2s POLL_INTERVAL. Reading the actual code before designing saved me from building a fake threshold to bypass.
   - `vi.fn()` without generics returns `Mock<Procedure | Constructable>` which TS won't narrow at the call site of a function that wants a specific callable signature. Use `vi.fn<MyFn>()` to give the mock the precise signature; assertions still work and the factory call type-checks.
   - The pre-commit hook in this repo runs `prettier --write` and re-formats files. It does NOT run `tsc`. So a commit can succeed with type errors. Always run `npx tsc --noEmit` separately when adding new test files; vitest's transpilation doesn't catch this.
   - Tests that wait on a polling subscriber are slow (1.2s per test for a 1s poller). Tolerate it for now; if it becomes a constraint, parametrize the poll interval via env or constructor option.
5. **What have I done?** 2 nanoclaw commits: `f5be6f0` (Phase 5 body, 5 files +383/-19) + `5d84dde` (mock-typing tsc fix). 303 tests passing.

## 2026-04-22 — Phase 6: seed rules.json + accounts.json

### Actions

- Read `~/containers/data/NanoClaw/groups/telegram_inbox/imap_autolabel.py` to capture the live 27-rule list.
- Inspected the running `mailroom-ingestor-1` container's environment to get the canonical Proton address roster (`docker inspect`). Result: 5 Proton addresses (matches tracker count) — `jeff@jstone.pro`, `jeff@thestonefamily.us`, `registrations@thestonefamily.us`, `stone.jeffrey@protonmail.com`, `stone.jeffrey@pm.me`. Madison's stale CLAUDE.md listed extras (`alice@thestonefamily.us`, `stone.jeffrey@proton.me`) that aren't actually configured in env.
- Wrote `~/containers/data/mailroom/rules.json`: 28 rules total. Auto-archive (silent label + archive, no Madison spawn) on the categories where Jeff's historical pattern is "archive without reading": Subscriptions (15), Free Books (1), Job Postings (3). NOT auto-archived: Shopping, Household, T-Mobile, Finances, Personal — those still need surfacing. New urgent rules at the bottom of the array (positional priority): `urgent-docusign` (no label, stays in INBOX) and `urgent-qcm-notifications` (label + qcm_alert side-channel; supersedes the plain-label QCM rule from imap_autolabel.py).
- Wrote `~/containers/data/mailroom/accounts.json`: 6 entries with the tag scheme from the tracker (`work`/`avp` for the AVP Gmail; `personal` plus per-address tags `primary`/`family`/`low-priority`/`alias` for Proton).
- Wrote `~/containers/data/mailroom/rules-changelog.md`: format spec (newest at bottom, who/what/why per entry) plus the seed entry documenting auto-archive judgment calls, the QCM enrichment, and related commit hashes for traceability.
- Built mailroom dist locally and ran `MAILROOM_DATA_DIR=~/containers/data/mailroom node dist/cli/rules-validate.js` — returned `ok: true` for both files (28 rules, 6 accounts).
- All three files live in the data volume; not under git. They're live state — when the mailroom container restarts to pick up Phases 3+4, the loader will hot-load them on first poll.

### Test results

| Test | Status | Notes |
|---|---|---|
| `npx tsc` (mailroom build) | pass | clean |
| `node dist/cli/rules-validate.js` against seeded files | pass | `{ok:true, rules:28, accounts:6}` |

### Reboot check (for next session)

1. **Where am I?** Phase 6 done. Three files seeded in `~/containers/data/mailroom/`: rules.json (28 rules), accounts.json (6 entries), rules-changelog.md. CLI validates clean.
2. **Where am I going?** Phase 7 — rewrite Madison's CLAUDE.md to reflect the new write surface + add the rules-maintenance section + Obsidian symlink. Then 8 (retire legacy scheduled tasks + script), then 9 (verify + graduate).
3. **What is the goal?** Push-driven, rules-engine-powered mail triage replacing Madison's polling.
4. **What have I learned?**
   - The running container's env is the authoritative source for runtime config (PROTONMAIL_ADDRESSES). Tracker counts and stale CLAUDE.md docs can drift — `docker inspect` is the cheapest way to verify.
   - Per CLAUDE.md "no features beyond what was asked": resist the urge to seed every rule with `auto_archive: true`. The conservative default (label-only) is reversible at any time; over-aggressive auto-archive silently hides mail Jeff might have wanted to see.
   - Seeded files live in the data volume — they survive container rebuilds. The rules-validate CLI is the right verification tool both for seed-time and for Madison's edit-time use.
5. **What have I done?** Three on-disk files in `~/containers/data/mailroom/` (rules.json, accounts.json, rules-changelog.md). All validate clean. No git commits in this phase since the files don't live in either repo — they ARE the system state.

## 2026-04-22 — Phase 7: Madison CLAUDE.md rewrite + Obsidian symlinks

### Actions

- Read the current Madison CLAUDE.md (291 lines from Phase 1; data volume; not under git).
- **7.1 Drop the temporary callout, document the new write surface** — Removed the entire `## Current limitation (2026-04-22 — pending Phase 4)` section that Phase 1 inserted as a band-aid. Replaced it with a new `## How mail reaches you (post mail-push-redesign)` section explaining the three event outcomes (urgent / routine / silent), what mailroom does at ingest, and how Madison's job has changed (no more initial classification for the 28 seeded rules; she classifies novel patterns + acts on what reaches her).
- Rewrote the "Actions" subsection under "Inboxes to sweep" with full docs for the four `mcp__inbox__*` write tools — signatures, semantics, the 20/hour rate limit + `SendRateLimitError.retry_after_ms`, the send-log audit at `/workspace/extra/mailroom/send-log.jsonl`. Also corrected the account-IDs list to match the live `PROTONMAIL_ADDRESSES` env (dropped stale `alice@thestonefamily.us` and `stone.jeffrey@proton.me`).
- **7.2 Mail rules maintenance section** — New ~50-line section covering: schema summary (predicates / combinators / actions / array-order priority / urgent-vs-archive conflict / silent semantics), edit→validate→save→changelog workflow, the `docker exec ... rules-validate.js` command pattern, accounts.json edit considerations, the diff-before-confirm convention, and the Obsidian-sync ground-truth note (Jeff's iPad edits override Madison's drafts via mtime hot reload).
- **7.3 Classification taxonomy update** — Added a "backend classifies first" preamble: trust `inbox:urgent` arrivals (rule-driven, don't re-classify); classify `inbox:routine` yourself; silents never reach you. Updated the pre-classification consult-list with `rules.json` as the new authoritative first-check (was sender-preferences.md). Added a "promote to rules.json" note for the N=3 promotion target — the goal of Madison's learning loop is to eventually fold every recurring pattern into the backend so she stops seeing it.
- **Action commands table refresh** — Updated the table with a third column mapping each command to its underlying tool call (`unsubscribe a1` → `mcp__inbox__send_message` for mailto + `apply_action({auto_archive: true})`; `delete a1` → `mcp__inbox__delete`; etc.). Added new commands: `untag a3 #foo` (remove_label) and `delete a1`.
- **Tools list refresh** — Replaced the stale "temporarily unavailable" line with the actual write-tools enumeration + a pointer to the maintenance section.
- **"What this group is for" preface** — Honest current-state phrasing: "the legacy `:07` hourly sweep and `*/15` auto-labeler health check are being retired (Phase 8)." Phase 8 will flip that to past tense.
- **7.4 Obsidian symlinks** — Created three symlinks in `~/Documents/Obsidian/Main/NanoClaw/Inbox/` pointing at the live data-volume files: `rules.json`, `accounts.json`, `rules-changelog.md`. Jeff can now edit any of them from phone/iPad via Obsidian sync; the loader picks up changes within 5s.
- **7.5 Agent-runner verification** — Confirmed `mcp__inbox__*` is wildcard-allowlisted in `container/agent-runner/src/index.ts:752`. The four new write tools auto-register on the existing inbox MCP server (`http://host.docker.internal:18080/mcp`), so no agent-runner code change needed.
- Final check: `grep -iE 'mcp__gmail|temporarily unavailable|imap_autolabel.*health|Current limitation'` against the rewritten file returns zero hits — no residual stale references.

### Test results

| Test | Status | Notes |
|---|---|---|
| residual-stale-reference grep | pass | zero matches |
| symlink read-through (rules.json + accounts.json) | pass | both render the live file content via Obsidian path |
| agent-runner wildcard allowlist | pass | `mcp__inbox__*` present at line 752 |

CLAUDE.md grew 291 → 355 lines (+64 net: dropped Phase-1 callout, added "How mail reaches you" + "Mail rules maintenance" + write-tools docs + per-row tool mappings in the action commands table).

### Reboot check (for next session)

1. **Where am I?** Phase 7 done. Madison's CLAUDE.md is fully rewritten to reflect the new write surface; Obsidian symlinks are live. The configuration / behavior changes for Madison take effect on her next spawn (CLAUDE.md is loaded fresh per spawn).
2. **Where am I going?** Phase 8 (retire legacy: delete imap_autolabel.py, remove the two retired scheduled tasks, decide qcm_alerts.jsonl poller fate, flip CLAUDE.md "are being retired" → "have been retired") then Phase 9 (verify end-to-end + graduate to permanent lode + move plan to complete).
3. **What is the goal?** Push-driven, rules-engine-powered mail triage replacing Madison's polling.
4. **What have I learned?**
   - Madison's CLAUDE.md and the mailroom CLAUDE.md / docs co-evolve. When mailroom adds a tool, Madison needs to know how to call it AND what the safety rails are. When the rules schema changes, Madison's maintenance docs need to mirror it. The schema lives in mailroom (`src/rules/schema.md`) and Madison's CLAUDE.md mostly summarizes; pointing at the canonical source via `docker exec ... cat /app/dist/rules/schema.md` keeps Madison's doc lean.
   - Action commands work better when the command-to-tool mapping is explicit. The previous Madison-CLAUDE.md table was action-only; agents do better when the tool path is named in-table because they don't have to chain "what tool does archive use?" → "find it in another section."
   - Live data-volume files (CLAUDE.md, rules.json, accounts.json, etc.) are NOT under git but ARE part of the system. Symlinks from Obsidian into the data volume create a third edit path (Jeff via Obsidian, Madison via Edit, this AI via Edit) that all converge on one file, hot-reloaded by mailroom's mtime poll. Worth documenting in Madison's CLAUDE.md so she knows the convergence behavior and treats Jeff's edits as ground truth.
5. **What have I done?** CLAUDE.md edits (data volume; not under git). Three Obsidian symlinks created. No new git commits required for the file content; lode bookkeeping commit follows.

## 2026-04-22 — Phase 8: retire legacy

### Actions

- **Discovered** while editing `~/containers/data/NanoClaw/data/ipc/telegram_inbox/current_tasks.json` that the file is REGENERATED by `container-runner.ts:writeTasksSnapshot` from `getAllTasks()` on every container spawn — file edits get clobbered on the next spawn. Real source of truth is the SQLite `scheduled_tasks` table at `~/containers/data/NanoClaw/store/messages.db`. Pivoted to direct DB DELETE via `sqlite3` CLI.
- Backed up the two retired task rows to `~/containers/data/NanoClaw/groups/telegram_inbox/archive/retired-tasks-2026-04-22.json` via `sqlite3 -mode json` (fully-recoverable JSON dump including all columns).
- Backed up `imap_autolabel.py` to `archive/imap_autolabel.py.bak-2026-04-22-mail-push-redesign`.
- `DELETE FROM scheduled_tasks WHERE id IN ('task-1776031812627-2iufvk', 'task-1774900431005-dmm28r')` — gone. Only `task-1775007854701-zupz0a` (7am morning routine) remains for telegram_inbox.
- `rm ~/containers/data/NanoClaw/groups/telegram_inbox/imap_autolabel.py` — live script gone.
- Updated Madison's CLAUDE.md "Scheduled email checks" line: "are being retired" → "were retired in mail-push-redesign Phase 8" with a pointer to `archive/`. Updated the scheduled-tasks roster table at the bottom: down to one row + footnote explaining what was retired and the QCM-poller-keep rationale.
- **QCM poller decision: KEEP.** Inspected `check_qcm_alerts.sh` — gates spawns via `wakeAgent: false` when no pending alerts in the JSONL. The 3-min cron is mostly cheap no-ops (Bash check; no agent spawn). Retiring it would also change delivery topology (QCM moves from `telegram_main` to `telegram_inbox` only), which is a Jeff-judgment call worth deferring rather than making unilaterally. Both delivery paths are intentionally redundant for trading-signal reliability.

### Test results

| Test | Status | Notes |
|---|---|---|
| `sqlite3 ... SELECT ... WHERE group_folder='telegram_inbox'` post-delete | pass | 1 row remaining (morning routine) |
| Live script absent | pass | `ls imap_autolabel.py` returns ENOENT |
| Backups present | pass | `archive/` contains both the script `.bak` + the rows JSON |

### Reboot check (for next session)

1. **Where am I?** Phase 8 done. Two scheduled tasks retired (in DB, scheduler picks up live each tick). Auto-labeler script deleted (backup in archive). Madison's CLAUDE.md flipped to past-tense + footnote with what was retired + QCM-keep rationale. QCM poller intentionally kept pending Jeff's topology decision.
2. **Where am I going?** Phase 9 — verify end-to-end (rebuild containers, restart nanoclaw, test DocuSign + routine + silent paths, measure spawn count over 24h, graduate to permanent lode, move plan to complete/).
3. **What is the goal?** Push-driven, rules-engine-powered mail triage replacing Madison's polling.
4. **What have I learned?**
   - **`current_tasks.json` is regenerated from DB on every container spawn.** Editing the file directly is futile — `writeTasksSnapshot` clobbers it from `getAllTasks()`. Lesson: when an on-disk file looks like config, check whether something is regenerating it from a more-authoritative source. The IPC file pattern in NanoClaw is "snapshot of DB state for the container to read"; never the source of truth.
   - **Direct SQLite writes against a running app are safe under WAL mode** — better-sqlite3 + WAL handles single-writer + concurrent readers cleanly. Only acceptable when the action is in-scope of what the user asked for and recoverable. Always dump rows to a backup file first via `sqlite3 -mode json` (one-shot recovery target).
   - **QCM poller decision was a topology question, not a spawn-count question.** The 3-min poll fires a Bash check that gates further work; almost zero spawn cost. The interesting question was "where do QCM alerts surface" (telegram_main vs telegram_inbox) — that's a Jeff-judgment call I should not unilaterally make.
5. **What have I done?** Two backups in `archive/` (script + retired-tasks JSON). DB DELETE of 2 task rows. Live script deleted. CLAUDE.md "are being retired" → past-tense + scheduled-tasks roster trimmed. No git commits for these (data volume + live DB); lode bookkeeping commit follows.

## 2026-04-22 evening — Phase 9 deploy + mid-deploy fixes

### Actions

- **QCM poller retired** (Jeff confirmed Euclid's source system pushes to Telegram directly; the 3-min email-side poller was redundancy on top of redundancy). DB DELETE + row backup + stripped `qcm_alert: true` from rules.json + changelog appended + CLAUDE.md flipped past-tense. Lode `53481b2`.
- **Lode graduation** (pre-Phase-9): wrote `lode/infrastructure/mailroom-rules.md`, `lode/infrastructure/madison-pipeline.md`, `lode/reference/rules-schema.md`. Updated `lode-map.md` + `summary.md`. Replaced findings.md "to create" pointers with where-it-landed links. Lode `3220f9e`.
- **Container rebuild + restart sequence (attempt 1):**
  - `dcc build` + `dcc down` + `dcc up` from `~/Projects/ConfigFiles/containers/mailroom/mailroom/` — wrong cwd; mounted bogus auto-created `data/mailroom/` dir; logs showed "rules.json missing".
  - Recovered by running from `~/containers/mailroom` (the symlink). Real data mounted; 28 rules + 6 accounts loaded; `inbox-mcp` healthy.
  - Restarted nanoclaw via `systemctl --user restart nanoclaw`. Old Madison container died with stdin-attached parent (contrary to the GroupQueue "detach not kill" comment).
  - Lode lessons committed `095d724` (mount-CWD-symlink, stdin-attached-die-with-parent).
- **Symlink → real-file Obsidian migration** (Jeff feedback: Obsidian Sync doesn't transport symlink targets to mobile). Moved rules.json + accounts.json + rules-changelog.md from `~/containers/data/mailroom/` to `~/Documents/Obsidian/Main/NanoClaw/Inbox/_Settings/` as real bytes. Reverted Phase-5.4 mailroom mount on Madison (was exposing gmail-mcp/store.db). docker-compose.yml first attempt: per-file bind mounts overlaying `_Settings/{rules,accounts}.json` into `/var/mailroom/data/`. Rebuilt + restarted. nanoclaw `304292f`, ConfigFiles `2f0f513`.
- **Madison's first rule edit hit the per-file inode trap.** She added `family-flex-rent` (getflex.com → Family + Finances + auto_archive); host file = 29 rules, but mailroom container kept seeing 28. Stat confirmed inode mismatch — Claude Code's `Edit` tool atomic-renames, breaking the per-file mount.
- **`MAILROOM_CONFIG_DIR` redesign:** dropped per-file overlays, added a whole-`_Settings/` dir mount at `/var/mailroom/config`. Loader + CLI + tests updated. ConfigFiles `05961ca`. Lode `732d112`. Verified: 29 rules visible from inside both containers; `touch` triggers a `rules.json loaded` log within 5s.
- **Madison referenced "docker validation isn't reachable from the sandbox"** — confirmed her container has no docker socket (correct privilege boundary). Three `docker exec` references in her CLAUDE.md were unreachable. Added `mcp__inbox__validate_rules` tool: validates live files OR draft strings (rules_content / accounts_content args), returns same `{ok, rule_count, doc_path on errors}` shape as the CLI. Wired into MCP server, registered as a write-tool. Verified by direct invocation inside the rebuilt MCP container — returns `ok: true, rule_count: 29`. CLAUDE.md `docker exec ... rules-validate` references replaced; the other two `docker exec` references (send-log + schema.md) reworded honestly. ConfigFiles `999b23c`.

### Test results

| Test | Status | Notes |
|---|---|---|
| `tsc --noEmit` (mailroom) | pass | clean after every refactor |
| `npm test` (vitest) | pass | 81/81 mailroom; 303/303 nanoclaw — both held steady |
| `mcp__inbox__validate_rules` direct call | pass | `{ok:true, rule_count:29, account_count:6}` |
| Hot-reload via `touch` | pass | `rules.json loaded` log within 5s |
| Madison's first rule landed on disk | pass | 29 rules; mailroom sees them post-config-dir-fix |
| Containers rebuilt + restarted | pass | both ingestor + inbox-mcp healthy from symlinked-cwd dcc up |

### Reboot check (for next session)

1. **Where am I?** Phases 1–8 fully complete; Phase 9 is partially done. The pipeline is live: mailroom rebuilt, nanoclaw restarted, Madison can edit rules.json end-to-end (validated via the new `mcp__inbox__validate_rules` MCP tool, hot-reload works via dir-mount of `_Settings/` from Obsidian).
2. **Where am I going?** Three things left for Phase 9 to graduate:
   (a) Tighten Madison's CLAUDE.md to make changelog appends mandatory (she skipped one for the Flex rule). Or accept casual edits and rewrite the workflow as "best effort" — Jeff's call.
   (b) Measure 24h spawn count vs the historical ~180/day baseline once enough mail flows.
   (c) Move plan from `lode/plans/active/2026-04-mail-push-redesign/` to `lode/plans/complete/`.
3. **What is the goal?** Push-driven, rules-engine-powered mail triage replacing Madison's polling. Sub-minute urgent surface latency. ~5–10x reduction in Madison spawn count. Inbound to Madison is now event-driven (urgent/routine/silent at ingest), Madison can read + write + label + archive + reply + send + edit-rules, all without polling.
4. **What have I learned?**
   - Five mid-deploy lessons captured in `findings.md` "Mid-Phase-9 deployment lessons" + relevant infrastructure docs: dcc-cwd-symlink-resolution, stdin-attached-die-with-parent, Obsidian-sync-doesn't-transport-symlinks, per-file-bind-mount-inode-trap, no-docker-socket-in-Madison's-sandbox.
   - The `_Settings/` pattern is the right home for backend-readable config that should sync via Obsidian. Documented as a transferable pattern in `lode/infrastructure/mailroom-rules.md`.
   - `MAILROOM_CONFIG_DIR` cleanly separates source-of-truth config (Obsidian, rare edits, schema-validated) from runtime data (`MAILROOM_DATA_DIR`: store.db, ipc-out, send-log, gmail creds).
5. **What have I done?** 18 commits across nanoclaw `mail-push-redesign` branch + ConfigFiles main. Roughly:
   - nanoclaw branch (10 commits): `923ba1e` (Phase 1) through `732d112` (mid-Phase-9 lode lesson).
   - ConfigFiles main (8 commits): `a5896fe` (Phase 2.1 types) through `999b23c` (validate_rules tool).
   - Plus three lode infrastructure files graduated, Madison's CLAUDE.md fully rewritten + corrected mid-deploy, mailroom containers rebuilt twice, nanoclaw restarted twice, all tests passing.

## Next steps (to resume)

1. **Pick up Phase 9 final steps:**
   - Decide on changelog-append-mandatory vs best-effort in Madison's CLAUDE.md "Mail rules maintenance" section (or just leave it and trust her judgment).
   - Sample mailroom-ingestor logs after 24h of real mail to count `inbox:urgent` + `inbox:routine` + silent events — compare to ~180/day baseline.
   - When the spawn-rate measurement validates the goal, move the plan to `lode/plans/complete/`.
2. **Phase 10 — Batch write tools (ready to implement):**
   - See tracker.md "Phase 10 — Batch write tools + confabulation hardening" for the 9-item checklist (10.1 through 10.9).
   - Code lives in ConfigFiles repo at `~/Projects/ConfigFiles/containers/mailroom/mailroom/src/mcp/tools/` — new files `archive.ts`, `label.ts`, `add_label.ts`, `remove_label.ts` alongside existing `apply_action.ts` (use that as the structural template).
   - Persona half already shipped 2026-04-22: "Truthful action reporting (non-negotiable)" section added early to Madison's CLAUDE.md at `~/containers/data/NanoClaw/groups/telegram_inbox/CLAUDE.md`. Code half is Phase 10.
   - Driver: 2026-04-22 confabulation incident where Madison told Jeff "both renewal notice and order confirmation archived" while `mailroom-inbox-mcp-1` logs show only one `apply_action` call (renewal only). Also invented a "not found in INBOX" error that never appeared in any log. Investigation confirmed MCP logs are authoritative ground truth. Flat-array batch tools (one verb each, no nested objects) make confabulation structurally harder and are easier for smaller models (Sonnet/Haiku) to call correctly.
3. **Optional follow-ups (filed in `lode/tech-debt.md`):**
   - `mcp__inbox__preview_rule` — dry-run a rule against recent messages to see what it would catch (Jeff suggested; deferred this session).
   - `mcp__inbox__send_log` — let Madison read send-log.jsonl from her sandbox without docker exec.
   - Backfill rule application — replay rules over the historical store to retroactively label.
