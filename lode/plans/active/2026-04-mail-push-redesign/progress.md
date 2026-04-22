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

1. **Phase 2.3** — `src/rules/matcher.ts`. Pure function `matches(predicate, ctx: RuleMatchContext): boolean`. Recursive eval across all leaf fields and `all`/`any`/`not`. Case-insensitive for sender/subject/body `_contains`/`_equals` (users expect substring case-insensitivity; email addresses are case-insensitive per RFC). `_matches` uses ECMAScript regex default (case-sensitive); users can add `(?i)` inline flag via `(?i:pattern)` or the `i` flag via `/pattern/i`-like convention — decision: matcher interprets `sender_matches` strings as the regex body; no flags prefix needed. If users want case-insensitive regex, they use `(?i)...` inline modifier (supported by V8). Document this in schema.md (2.7). `has_label` reads `ctx.labels_at_ingest` not accumulator state (decisions table).
2. 2.4 evaluate → 2.5 CLI validate → 2.6 unit tests → 2.7 schema.md.
3. Then 3 → 9 in order; 3 (apply + events) and 4 (MCP writes) are the next heaviest.

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
