# Progress — Madison Read Power + Session Freshness

## 2026-04-23 evening — Wave 5.5.1 done, fix surface corrected

### Actions (5.5.1 verification)

- Grepped mailroom src + sampled `mailroom-ingestor-1` logs (last 3h). Both legacy pollers (`gmail/poller.ts:269`, `proton/poller.ts:211`) are **actively ingesting** — 8 "classified" log lines in the sample. Wave 2B workers (`proton-idle`, `proton-condstore`, `gmail-history`) are up but emit **zero** `applyProtonUidAdded` / `applyLabelsAdded` lines → they're detectors on existing rows, not inserters.
- Confirmed `ingestMessage` in `src/store/ingest.ts` writes `messages`/`threads`/`senders`/`accounts` but never `message_labels` / `label_catalog` / `message_folder_uids`. That's the hole.
- Corrected Wave 5.5 tracker scope:
  - 5.5.1 checked off with findings.
  - Primary fix moves into `ingestMessage()` itself (extend signature with optional `labels[]` + `folder_uid`); both poller call sites pass their source-native data.
  - Legacy `proton/poller.ts` promoted from "if still running" to primary fix target (5.5.3). **Added `gmail/poller.ts` as peer fix target** (5.5.4) — the original brief missed this because it focused on Wave 2B paths.
  - Wave 2B event-applier hardening demoted to "secondary/future-proofing" (5.5.5).
  - Watermark bump (5.5.6) moves into `ingestMessage` — one place, one tx.
  - Audit invariant (5.5.7) clarified as Madison-callable MCP tool `audit_label_coverage`, not just log metric.
  - 5.5.10 deploy scope widened to both containers (inbox-mcp needs the new audit tool).
- Updated `wave-5.5-push-ingest-parity.md` brief with the corrected fix shape — single-inlined transactional extension of `ingestMessage`, not scattered across three appliers.

## 2026-04-23 evening — Wave 5.5 added (push-ingest parity)

### Actions

- Wave 5 verification (AC-V3 / AC-V6) surfaced that push-ingest workers skip `message_labels` / `label_catalog` writes. Today's diagnostic: 21 received Proton messages, only 15 with any label entry, 8 with INBOX specifically — Madison under-counts the live inbox by ~30%.
- Sibling tech-debt `TD-MAIL-PUSH-WATERMARK` is the same conceptual root cause (Wave 2B doesn't fully replicate migration hydration's writes).
- Moved `lode/tmp/issue-push-ingest-labels-2026-04-23.md` → `lode/plans/active/2026-04-madison-read-power/wave-5.5-push-ingest-parity.md` so the executor brief lives with the plan.
- Added Wave 5.5 to tracker.md with 12 sub-tasks spanning: ingest-path verification, event-applier label writes (Proton + Gmail + legacy poller), watermark bump, runtime audit invariant, integration tests, one-shot gap backfill, ingestor-only deploy, live verify, tech-debt graduation, and AC-V3/V6 re-run.
- Current status line updated: Wave 5.5 blocks AC-V3/V6 truth → execute 5.5 before finishing Wave 5.

### Reboot check (for next session)

1. **Where am I?** Wave 5.5 scoped and tracker updated. Executor brief at `wave-5.5-push-ingest-parity.md`. Not yet spawned.
2. **Where am I going?** Spawn one focused Sonnet executor on Wave 5.5 (5.5.1 → 5.5.11). Then resume Wave 5 verification (5.1, 5.2, 5.3, 5.4, 5.5, 5.7) and finally 5.9 move-to-complete.
3. **What is the goal?** Close the push-ingest label + watermark gap so AC-V3 / AC-V6 / the whole "true mirror" promise hold end-to-end, not just on the migration-hydrated subset.
4. **What have I learned?**
   - Wave 2B ships rows to `messages` but not to `message_labels` / `label_catalog` — same shape as the Wave 3.5 apply.ts bug that required the self-audit invariant. Pattern: "new write path doesn't replicate everything the migration path does." Fix-shape template: make push-ingest transactional over messages + labels + catalog + watermark, with a runtime invariant to guard the promise.
   - Symptom was quiet (under-count, not error), surfaced only because Jeff eyeballed the actual Proton UI vs Madison's response. Argues for the runtime audit invariant being a Madison-callable diagnostic tool, not just a log metric.
5. **What have I done?**
   - Moved tmp bug doc into plan dir.
   - Added Wave 5.5 section with 12 sub-tasks to tracker.md.
   - Updated tracker "Current status" to reflect Wave 5.5 ordering.
   - This progress.md entry.

## 2026-04-22 evening — Plan created

### Actions

- Diagnosed three failures in Madison's behavior tonight: confabulation of tool errors, stale tool-list awareness from session resume, watermark NaN bug in `recent`. See `findings.md` for full record.
- Shipped two immediate fixes alongside this plan:
  - Watermark NaN fix in ConfigFiles `58a290f`: Proton strategy switched from `parseInt(message_id)` to `received_at` (uniform with Gmail). Tests 106 → 110 passing.
  - Cleared Madison's `telegram_inbox` session row from `~/containers/data/NanoClaw/store/messages.db` so her next spawn starts a fresh conversation with the full Phase 10 + post-Phase-10 toolset visible.
- Surfaced the env-vault deploy gotcha: a Sonnet executor brought down both mailroom containers by running `dcc up` without `env-vault env.vault --` prefix → `INBOX_DB_KEY` unset → crash-loop. Recovered by Jeff running `env-vault env.vault -- docker compose up -d ingestor inbox-mcp` interactively. Both containers healthy as of 02:17 UTC.
- Captured the env-vault prefix as a lode lesson (`lode/lessons.md`) plus referenced it in `findings.md`.
- Wrote tracker.md with 6 acceptance criteria across 5 phases. Next phase = Phase 1 (discuss / lock open questions with Jeff).

### Test results

| Test | Status | Notes |
|---|---|---|
| Watermark fix tests (queries.test.ts) | pass | 4 new tests, 110/110 total |
| `tsc --noEmit` after watermark fix | pass | clean |
| `mailroom-ingestor-1` post-restart | healthy | processing mail (saw IBKR insert at 02:17:03) |
| `mailroom-inbox-mcp-1` post-restart | healthy | listening on 0.0.0.0:8080, 6 accounts loaded |
| `maxUid` removed from running ingestor dist | pass | `grep -c` returned 0 |

### Reboot check (for next session)

1. **Where am I?** Plan written; immediate fixes shipped (watermark + session clear). Ready for Phase 1 discussion with Jeff.
2. **Where am I going?** Phase 1 = lock open questions on filter set, aggregation v1 scope, and session-hash invalidation strategy. Then Phase 2 (build `mcp__inbox__query`), Phase 3 (session-hash invalidation), Phase 4 (docs), Phase 5 (verify + graduate).
3. **What is the goal?** Give Madison structured query/aggregation power matching her write power, AND prevent the session-staleness pattern that hid Phase 10 tools from her tonight.
4. **What have I learned?**
   - Madison's confabulation has at least three flavors (so far): bulk-action paraphrase (Phase 10's target), invented tool errors for tools she didn't call, and self-citing prior fabrications. Each needs a different fix.
   - Resumed sessions across MCP toolset changes anchor the model's self-image to the prior toolset. Fresh CLAUDE.md alone doesn't dislodge it. Real fix is session invalidation on tool-list change.
   - `dcc` (`/usr/local/bin/dcc`) is a Makefile wrapper, NOT an env-vault decrypter. Mailroom deploys must use `env-vault env.vault -- docker compose ...` from any fresh shell.
   - When `src/store/` changes in mailroom, BOTH `ingestor` and `inbox-mcp` need rebuild + restart.
5. **What have I done?**
   - 1 ConfigFiles commit (`58a290f`) for watermark fix
   - 1 SQL DELETE on nanoclaw `sessions` table for telegram_inbox
   - Plan created (`tracker.md` + `findings.md` + `progress.md`)
   - Lode lessons file created (env-vault prefix + session-resume lessons)
   - Both mailroom containers redeployed cleanly with INBOX_DB_KEY populated

## 2026-04-23 — Wave 0 complete; Wave 1 starting

### Actions

- nanoclaw working tree had an uncommitted `@openai/codex@^0.123.0` package.json/lock change unrelated to this plan; committed as `b866105` "chore: add @openai/codex dependency" before branching.
- 0.1 verified — `mail-push-redesign` plan was closed by `ff180f5` and is in `lode/plans/complete/2026-04-mail-push-redesign`.
- 0.2 spun `madison-read-power` branch in nanoclaw off `mail-push-redesign` tip (`b866105`).
- 0.3 spun `madison-read-power` branch in `~/Projects/ConfigFiles` off `main` tip (`58a290f`). Pre-existing uncommitted files (`claude-code-url-handler.desktop`, `cleanup-nvidia-symlinks.sh`) left untouched.
- Wave 1 to be executed by a single Sonnet lode-executor in the ConfigFiles mailroom repo (tasks 1.1–1.5 sequential per the tracker's "single agent, serialized" execution model). Per Jeff's instruction to conserve Opus credits.

### Reboot check

1. **Where am I?** Wave 0 done; Wave 1 (single Sonnet executor) about to start in `~/Projects/ConfigFiles/containers/mailroom/mailroom/` on the new `madison-read-power` branch.
2. **Where am I going?** Wave 1 = schema migration + startup guard + canonicalization helper + accounts/proton_folder_state columns + fail-fast migration. Then Wave 2 (5 parallel Sonnet executors).
3. **What is the goal?** Land the mirror schema foundation that Wave 2's hydration/sync/write-through/query/session-hash workstreams all build on.
4. **What have I learned?** Two repos (nanoclaw + ConfigFiles) both run on `madison-read-power` for this plan. Branching cleanly required committing an unrelated codex dep first.
5. **What have I done?** Wave 0 (3/3 ✅).

## 2026-04-23 — Wave 1 complete

### Actions

- Single Sonnet lode-executor landed all 5 Wave 1 tasks as ConfigFiles commit `f8f827e`. One atomic commit because 1.1/1.4/1.5 all touch `db.ts` with no clean logical split.
- Files: `src/store/db.ts` (+241), `src/labels/canonicalize.ts` (new, 37 LOC), `src/labels/canonicalize.test.ts` (new, 52 LOC, 10 tests).
- Schema additions:
  - `messages`: `rfc822_message_id`, `direction` (CHECK received/sent, default received), `archived_at`, `deleted_at`, `deleted_inferred`.
  - `accounts`: `last_history_id`, `last_history_refresh_at` (Gmail watermarks).
  - New tables: `message_labels`, `message_folder_uids`, `label_catalog`, `label_map`, `proton_folder_state`, `meta`.
  - Indexes: `idx_messages_rfc822`, `idx_messages_direction_archived`, `idx_message_labels_canonical`, `idx_label_catalog_canonical`.
- `MailroomDbDecryptError` raised when an existing non-empty `store.db` fails the post-PRAGMA sentinel read; in-memory + fresh-install paths skip the guard.
- `MailroomSchemaError` raised on old-schema mismatch; `meta.schema_version='2'` stamped via `INSERT OR IGNORE`; pre-v2 detection promotes silently.
- Used `addColumnIfMissing` (try/catch on duplicate column) to match existing migration style.
- Tests: 120/120 pass (10 new canonicalize tests + 110 pre-existing). No regressions.
- Not deployed (Wave 3 work). No nanoclaw-side changes (Wave 2E work).

### Test results

| Test | Status | Notes |
|---|---|---|
| `npm test` (mailroom) | pass | 13 files / 120 tests / 1.75s |
| Build | pass | tsc clean before commit |

### Reboot check

1. **Where am I?** Wave 1 complete; foundation landed in mailroom. Ready for Wave 2 (5 parallel workstreams).
2. **Where am I going?** Wave 2 spawns 5 parallel Sonnet executors:
   - 2A hydration/reconcile pipeline (mailroom)
   - 2B incremental sync worker (mailroom: Gmail history.list, Proton IDLE+CONDSTORE)
   - 2C write-through refactor (mailroom: every write tool transactionally updates DB after upstream success; replace per-write IMAP search with `message_folder_uids` lookup)
   - 2D `mcp__inbox__query` tool + read-tool default filters (mailroom)
   - 2E session toolset hash (nanoclaw — independent of mailroom; runs in parallel from start)
3. **What is the goal?** Build the four mirror workstreams + the nanoclaw session-freshness fix on top of the Wave 1 schema, so Madison's Wave 5 verification can pass.
4. **What have I learned?** When a wave touches one file across multiple tasks (db.ts here), batching to one commit is cleaner than three half-edits. Tracker still attributes via the same commit hash on each checkbox.
5. **What have I done?** Waves 0–1 complete. 8/8 task checkboxes ticked.

## 2026-04-23 — Wave 2 complete (5 parallel Sonnet executors)

### Actions

Spawned 5 lode-executor subagents in parallel (model: sonnet), one per workstream:

| Workstream | Repo | Commit | Files | Tests |
|---|---|---|---|---|
| 2A reconcile pipeline | ConfigFiles | `7afa3ab` | 12 new in `src/reconcile/` | 33 new |
| 2B incremental sync | ConfigFiles | `16886aa` | 8 new in `src/sync/` | 25 new |
| 2C write-through refactor | ConfigFiles | `f6c8019` | 19 (10 modified, 9 new) | 74 new |
| 2D query tool + defaults | ConfigFiles | `ab6febd` | 8 (mostly new tests + `query.ts` + types) | 49 new + 2 skipped (perf) |
| 2E session toolset hash | nanoclaw | `c6cdd3a` | 5 (3 modified, 2 new) | 21 new |

Final test counts after all 5 land:
- Mailroom: **276 passed / 2 skipped (perf) / 0 failing** (up from 120 at end of Wave 1)
- Nanoclaw: **324 passed / 0 failing** (was 303 per AC-V7)

### Concurrency observations

- All 5 executors operated in the same checkout per repo. Whitelisted file scopes prevented direct file conflicts.
- One **commit-attribution race** observed: 2C committed `queries.ts` after 2D had already written `queryMessages`/`aggregateMessages` to the file but before 2D committed → 2C's commit `f6c8019` swept in 2D's `queries.ts` additions. 2D's commit `ab6febd` covers the remaining 2D files (types.ts, server.ts, query.ts, tests). Functionally identical end state; just attribution noise. Same pattern Phase 1.5.1/1.5.2 of the unified-inbox tracker recorded — recurring failure mode of parallel executors in shared working trees.
- 2C and 2D both saw transient test failures from each other's pending changes during their solo `npm test` runs; final integration suite (276 passed) confirms compatibility once all commits land.

### Deferred to Wave 3 (per executor reports)

- 2A: wiring `startReconcileScheduler` into a startup entrypoint; `reconcile_unknowns` table persistence (currently log-only).
- 2B: wiring `startIdleForAllAddresses` + `startCondstorePoller` into startup; resolving accounts list for heartbeat runner.
- 2C: backfilling existing draft/spam rows out of the DB.
- 2C: backfilling `message_folder_uids` for existing rows (drives Wave 3 hydration).
- 2D: 100k-message perf measurement (skipped tests in `queries.perf.test.ts`).

### Reboot check

1. **Where am I?** Wave 2 complete (all 5 workstreams). Code lands in branches but not deployed.
2. **Where am I going?** Wave 3 = single-executor migration orchestrator (schema → purge drafts+spam → Proton rfc822 UPDATE → full hydration via reconcile's full-walk mode → metrics report). Then deploy: rebuild mailroom containers (env-vault prefix!), rebuild agent container, restart nanoclaw.
3. **What is the goal?** Run the migration on the live DB and bring sync workers + reconcile online. Then Wave 4 docs/persona, then Wave 5 verification (Jeff-driven).
4. **What have I learned?** Whitelisted file scopes worked; commit-attribution races didn't break correctness. Sonnet executors can produce 80–200 LOC per task with consistent test discipline. Some tasks (`reconcile_unknowns` persistence, scheduler wiring) are inherently Wave 3 work and the Wave 2 executors correctly recognized that.
5. **What have I done?** Waves 0/1/2 — 8/8 prereq+schema items, 39 Wave 2 sub-items.

## 2026-04-23 — Wave 3 (code) complete; deploy held

### Actions

**Wave 3 first pass** (single Sonnet executor, ConfigFiles `1e46257`):
- `scripts/migrate-mirror.ts` — 7-phase migration orchestrator with `--dry-run`
- `src/integration/migrate-mirror.test.ts` — 8 integration tests
- `src/store/db.ts` — schema_version bumped to 3, `reconcile_unknowns` table, guard updated for v2→v3 forward
- `src/reconcile/apply.ts` — persists unknowns to `reconcile_unknowns` (was log-only)
- `src/ingestor.ts` — wires sync workers + reconcile scheduler at startup

Two issues surfaced in design review:
1. `tsc --noEmit` failed with 6 errors (4 missing `runGmailHydration`/`runProtonHydration` exports; 2 implicit `any` in `gmail-history.ts`)
2. Reconcile scheduler `runFn` was a no-op stub — wired at startup but did nothing when fired

Root cause: Wave 2A's prompt only specified primitives (walkers/delta/apply). 2B assumed a composed `runGmailHydration` would exist; when it didn't, 2B wrote runtime late-binding (`mod.runGmailHydration as …`) that silently no-ops if absent. Wave 3 dodged the issue with a stub. Tests passed (vitest uses esbuild — no strict tsc). Production tsc would have failed at deploy.

**Wave 3 gap closure** (single Sonnet executor, ConfigFiles `f398393`):
- New `src/reconcile/hydrate.ts` exposes `hydrateGmailAccount`, `hydrateProtonFolder`, `runFullHydration` (composed walker → delta → apply)
- Reconcile barrel exports the new functions
- Late-binding scaffolding deleted from `src/sync/gmail-history.ts` and `src/sync/proton-condstore.ts`; direct imports
- `src/ingestor.ts` passes `runFullHydration` as the scheduler's `runFn` (composition root pattern)
- `scripts/migrate-mirror.ts` hydration phase collapses to a single `runFullHydration()` call — same code path as nightly reconcile (locked decision satisfied)
- 4 new integration tests in `src/integration/sync-hydrate-fallback.test.ts` exercise sync→hydrate fallback (the path Wave 3 didn't test)
- 2 implicit `any` annotated
- Sentinel-flag paths (`__needs_hydration__`, `last_modseq=-1`) kept as actual error fallback (no IMAP/OAuth available)

Lesson captured in `lode/lessons.md`: "Cross-workstream API contracts must be specified in the orchestrator prompt, not inferred by executors". Pattern applies whenever parallel wave executors share an API surface — the orchestrator must name function names + signatures + ownership in BOTH executor prompts so consumers don't write defensive scaffolding around missing producer APIs.

### Test results

| Test | Status | Notes |
|---|---|---|
| `tsc --noEmit` (mailroom) | ✓ clean | was 6 errors before gap closure |
| `npm test` (mailroom) | ✓ 288 passed / 2 skipped | up from 276 (Wave 2) → 284 (Wave 3 first pass) → 288 (gap closure) |
| `npm run build` | ✓ clean | tsc compilation |

### Reboot check

1. **Where am I?** Wave 3 code complete + gap closed. Ready for Wave 4 (docs/persona) and ready for Jeff to authorize 3.4 deploy.
2. **Where am I going?** Two parallel paths: (a) Wave 4 = Madison CLAUDE.md update + a-mem cleanup + lode graduation (single Sonnet executor, can run before deploy); (b) Wave 3.4 = manual deploy by Jeff using the deploy plan in `progress.md`. Then Wave 5 = Jeff-driven verification.
3. **What is the goal?** Get the mirror foundation into production safely — code is done, deploy is the gate.
4. **What have I learned?** Type checking must run at end-of-wave, not just tests. Cross-workstream API contracts need explicit specification in orchestrator prompts. Composition roots (entrypoints) own DI wiring; modules that take `runFn` parameters should never bury defaults.
5. **What have I done?** Waves 0–3 (code). 9 wave-level tasks + 39 sub-items checked off. 0 deploy yet. Zero tsc errors. 288 passing tests across mailroom; 324 across nanoclaw.

### Wave 3.4 deploy plan (HELD — Jeff approves manually)

Pre-flight (idempotent dry-run on the live encrypted DB — does not mutate):
```bash
cd ~/containers/mailroom
env-vault env.vault -- docker compose exec ingestor \
  npx tsx scripts/migrate-mirror.ts --dry-run
```

Deploy sequence (when ready):
```bash
# Backup the encrypted store first
cp /home/jeff/containers/data/mailroom/store.db \
  /home/jeff/containers/data/mailroom/store.db.pre-wave3-$(date +%Y%m%d%H%M%S)

# Rebuild + restart mailroom containers (env-vault prefix non-negotiable)
cd ~/containers/mailroom
env-vault env.vault -- docker compose build ingestor inbox-mcp
env-vault env.vault -- docker compose up -d ingestor inbox-mcp
docker compose ps  # verify both healthy

# Run the migration (idempotent — safe to re-run)
env-vault env.vault -- docker compose exec ingestor \
  npx tsx scripts/migrate-mirror.ts

# Rebuild + restart nanoclaw agent container
cd ~/containers/nanoclaw && ./container/build.sh
systemctl --user restart nanoclaw
```

Rollback if migration fails partway: restore `store.db` from the pre-deploy backup. Migration is additive (`INSERT OR IGNORE`, `UPDATE … WHERE … IS NULL`) plus a draft/spam purge; the only destructive step is the purge, which re-runs cleanly post-restore.

## 2026-04-23 — Wave 3.4 deploy: first attempt failed silently, Wave 3.5 closed gap, retry succeeded

### What happened (chronologically)

**Pre-deploy bugs found + fixed before first attempt** (CF `86b9072`):
- Wrong env var names across `ingestor.ts`, `migrate-mirror.ts`, `hydrate.ts` (`PROTON_BRIDGE_PASSWORD` vs actual `PROTONMAIL_BRIDGE_PASSWORD`).
- Hand-rolled OAuth in `ingestor.ts` and `migrate-mirror.ts` reading made-up env vars (`GMAIL_CLIENT_ID/SECRET`); replaced with `createGmailClient()` from `gmail/poller.ts`.
- `proton-walker.ts` used `bodyParts: ['HEADER.FIELDS (MESSAGE-ID)']` which the bridge rejected with "unknown section msg text value ''"; replaced with `envelope: true` and `msg.envelope?.messageId` (matches existing poller pattern).
- `Dockerfile` didn't `COPY scripts/`; added.

**First live migration attempt:** completed in 10 min, reported all-clean metrics. **But sanity SQL revealed silently-wrong data:**
- `message_labels=0` (expected ~190k Proton folder entries)
- `label_catalog=0` (never populated)
- `deleted_inferred=60,167` (literally every pre-migration row marked deleted)
- Reported `inferred_deletes=0` but DB had 60,167 → metrics lying

**Rolled back** via btrfs snapshot `2026-04-23-085005`. Pre-migration state restored cleanly (60,163 messages, no mirror columns, accounts intact).

**Wave 3.5 gap closure** (CF `57e631b`) — Sonnet executor traced 4 root causes:
- A: `applyInferredDeletes` wrote rows but the count wasn't plumbed back into the metrics aggregator (hardcoded 0).
- B: Proton accounts only called `applyFolderUidDelta`, never `applyLabelDelta` — folders weren't being recorded as label entries despite the Wave 1 decision.
- C: inferred-delete comparison built the upstream-seen set from `rfc822_message_id` strings but the local query selected `message_id` (internal UUID) — two incompatible key spaces, zero intersection, every local row flagged.
- D: Gmail walker triples dropped `gmailId` when mapping to apply-input, losing the source-native id needed for source-correct join.

Plus added a **self-audit phase** to `migrate-mirror.ts` that queries actual DB state after hydration and **fails the script (exit 1)** if reported metrics drift from actual, or if any invariant breaks (`message_labels` empty when Proton exists; `label_catalog` empty when adds reported; `deleted_inferred > 50%` blast guard). 8 new integration tests in `apply-bugs-wave35.test.ts` seed synthetic state and assert every row, not just counts.

**Second live migration attempt** (after Wave 3.5 fixes): completed in 9.7 min. **Self-audit passed.** Final state:
- `message_labels: 190,286` (Proton folder memberships properly recorded)
- `label_catalog: 147` (unique folders across 5 accounts)
- `message_folder_uids: 190,286` (consistent with labels)
- `deleted_inferred: 51` (genuinely orphaned rows — 0.08%, well under blast guard)
- `rfc822_message_id NOT NULL: 59,673` (matches reported)
- Reported metrics match DB exactly across the board

**Services brought back up:**
- Mailroom containers recreated with new image: 5 Proton IDLE + 5 CONDSTORE pollers + reconcile scheduler all started clean, zero auth errors.
- Nanoclaw restarted: new agent image with Wave 2E session-hash invalidation active.

### Test results

| Test | Status | Notes |
|---|---|---|
| `tsc --noEmit` (mailroom) | clean | zero errors throughout |
| `npm test` (mailroom) | 300 passed / 2 skipped | up from 288 (Wave 3) → 300 (Wave 3.5) |
| Live migration self-audit | passed | reported = actual |
| Live ingestor post-deploy | healthy | IDLE/CONDSTORE/reconcile all up, no errors |

### Deferred to follow-up

- **Codex review findings on Wave 2E** (3 items: 2× P1 session rotation/migration, 1× P2 Trawl config in hash). None are mailroom-related; defer until Wave 4 docs land.
- **Gmail hydrated_adds=0**: 1,808 walked, 0 applied. Wave 3.5 fixed Bug D's missing `gmailId` in triples but Gmail apply path may still have a join gap. Madison's existing-Gmail-row label visibility limited until investigated; new Gmail mail uses Wave 2C write-through path (unaffected).

### Reboot check

1. **Where am I?** Wave 3.4 deployed successfully (after Wave 3.5 fix). Mirror live in production. 5 IDLE + 5 CONDSTORE + reconcile scheduler running healthy.
2. **Where am I going?** Wave 4 (docs + persona — single Sonnet executor) and addressing Codex Wave 2E findings + Gmail hydrated_adds investigation as gap closures. Then Wave 5 (Jeff-driven verification: AC-V1 through AC-V7).
3. **What is the goal?** Madison can answer structured queries with `mcp__inbox__query`, label hygiene questions across all 6 accounts, and a-mem/session staleness has structural fixes.
4. **What have I learned?** Self-audits in migration scripts catch silent-write bugs that test suites + tsc miss. Cross-workstream API contracts must be specified explicitly in orchestrator prompts (already in lessons.md). When metrics report success but data looks wrong, **always trust the data and roll back** rather than papering over with SQL fixes. Btrfs snapshots make rollback cheap enough to use as the default response.
5. **What have I done?** Waves 0/1/2/3 + 3.4 deploy + 3.5 audit. 47 task checkboxes ticked. 5 commits in ConfigFiles, 1 in nanoclaw on `madison-read-power` branch.

## 2026-04-23 — Wave 3.6 closes Gmail label gap

### Actions

After Wave 3.5 deploy succeeded, sanity SQL revealed Gmail had 0 entries in `message_labels` despite 1,808 items walked. Diagnosed: `applyLabelDelta` and `buildLabelDelta` still keyed on `rfc822_message_id` (Wave 3.5 fixed only the inferred-delete keying). Local Gmail rows have `rfc822_message_id IS NULL` (only Proton was SQL-backfilled in Phase 4); Gmail entries fell entirely into the `unknowns` bucket and were never written.

**Wave 3.6 gap closure** (CF `a7baeed`) — Sonnet executor, focused scope:
- `delta.ts` — `LabelEntry` gains `sourceMessageId`; `buildLabelDelta` shifts from `knownRfc822Ids` to `knownSourceMessageIds`; composite key uses sourceMessageId.
- `apply.ts` — `localEntries` query fetches `source_message_id`; `knownSourceRows` replaces `knownRfc822Rows`; `lookupMessage` joins on `source_message_id`; `applyAdds` uses `entry.sourceMessageId`.
- `hydrate.ts` — `runFullHydration` plumbs `sourceMessageId` (gmailId for Gmail, rfc822 for Proton) through Gmail upstream and Proton label upstream; `hydrateGmailAccount` single-target updated.
- `scripts/migrate-mirror.ts` — three new audit invariants: Gmail label parity, per-source `items_walked > 0 → adds_applied > 0` (first-migration shape), `reconcile_unknowns > messages × 2` blast guard.
- New `src/integration/apply-bugs-wave36.test.ts` (5 cases: Gmail apply with NULL rfc822, mixed-source apply, audit-fires-on-Gmail-zero, etc.).
- Existing tests in `apply.test.ts`, `delta.test.ts`, `apply-bugs-wave35.test.ts`, `migrate-mirror.test.ts`, `sync-hydrate-fallback.test.ts` updated to include `sourceMessageId` on `LabelEntry` instances.
- Tests: 305/307 (2 perf skipped); zero regressions on Proton path.

**Wave 3.6 re-run migration** (Wave 3.5's already-mirrored Proton state preserved; Gmail labels added):

| Metric | Pre-Wave 3.6 | Post-Wave 3.6 |
|---|---|---|
| `message_labels` total | 190,286 | **192,080** (+1,794) |
| Gmail `message_labels` | 0 | **1,784** ✓ |
| `label_catalog` total | 147 | **175** (+28 Gmail labels) |
| `messages.deleted_inferred=1` | 51 | 51 (unchanged — re-run idempotent) |
| Self-audit | passed | exited 1 (3 false positives — see below) |

**Audit fired exit 1 on the re-run with 3 false positives** — all are correct idempotency outcomes for a re-run, not real failures:
1. `inferred_deletes: reported 0 but DB has 51` — those 51 were correctly created by Wave 3.5; Wave 3.6 added 0 new ones (true). Audit compared reported vs absolute, treated as drift.
2. `stone.jeffrey@protonmail.com walked 18, adds 0` — already mirrored in Wave 3.5; no new entries to add.
3. `stone.jeffrey@pm.me walked 11, adds 0` — same.

The audit erred toward halting + escalation, which is the right safety stance — but the invariants need re-run awareness (compare against pre-migration counts; relax `adds==0` when existing coverage exists). Logged as deferred follow-up in tracker.

**Architectural improvement worth noting**: with Wave 3.6's source-key-aware apply, **Gmail rfc822 backfill is now truly optional**. The apply path uses `source_message_id` exclusively. rfc822 is still useful for cross-source thread/identity later but no longer required for label hydration.

**Services brought back up**: ingestor recreated on new image, 5 IDLE + 5 CONDSTORE + reconcile scheduler all up clean, zero auth errors.

### Reboot check

1. **Where am I?** Mirror foundation fully live + Gmail label coverage closed. 192,080 label entries, 175 catalog entries, 51 inferred-deletes (within blast guard).
2. **Where am I going?** Wave 4 (docs + persona) — single Sonnet executor for Madison CLAUDE.md update + a-mem cleanup + lode graduation. Plus address Codex Wave 2E findings (P1×2 + P2) as a separate gap closure.
3. **What is the goal?** Hand off mirror foundation to Wave 5 verification with all data correct.
4. **What have I learned?** Layer-specific bug fixes (Wave 3.5 fixed inferred-delete key, missed apply-add key) require systematic search for the same pattern across all callers. Self-audits surfaced this within minutes of re-deploy — the 60-second post-deploy SQL check is now part of the deploy ritual. Audit invariants designed for first-deploys produce false positives on re-runs; rerun awareness (deltas not absolutes) needed.
5. **What have I done?** Waves 0–3.6 complete. 49 task checkboxes ticked. 7 commits in ConfigFiles, 1 in nanoclaw on `madison-read-power` branch.

## 2026-04-23 — Wave 4.5 read tracking (bonus phase)

### Actions

After Wave 4 docs landed, Jeff asked: "did we ever create the MCP for advanced querying — sender, subject, body, read/unread, labels?" Tool inventory check showed `mcp__inbox__query` shipped in Wave 2D with sender/subject/body/labels/dates/aggregations — but **no read/unread filter**. Gmail UNREAD worked via the labels filter (Wave 3.6 hydrated 38 UNREAD entries); Proton had no read tracking at all (every row `\Seen`'d at ingest time).

Decision (Jeff): agent-side `read_at` column. Madison populates on `mark_read`. Not mirrored to Gmail UNREAD or Proton `\Seen`. Batch operation matching Phase 10 batch-verb pattern.

Sonnet executor (CF `1ad00ee`):
- Schema v3→v4 with `messages.read_at INTEGER` + `idx_messages_read_at` + version-stamp via existing `ON CONFLICT DO UPDATE`.
- `QueryArgs.read?: boolean` filter on `queryMessages` + `aggregateMessages`.
- New `mcp__inbox__mark_read({message_ids})` batch tool — idempotent (preserves original `read_at` on re-call). New `mcp__inbox__mark_unread` symmetric.
- Both tools registered as local-only (no upstream deps); appear in MCP tool list regardless of gmail/proton config.
- 25 new tests; total 307 → 332.

Deployed via `env-vault env.vault -- docker compose build ingestor && env-vault env.vault -- docker compose up -d --force-recreate ingestor inbox-mcp`. Schema migrated cleanly to v4; read_at column + index present; sync workers all up clean.

Madison's CLAUDE.md updated in 4 spots:
- Filter list line includes `read` with semantic note (agent-side, not mirrored upstream)
- Example #5 rewritten to use `read: false` (was incorrectly using `include_sent: false`)
- Batch verb tools section added `mark_read` + `mark_unread` with full signatures + idempotency contract
- New workflow paragraph: "call `mark_read` at the end of every digest with every surfaced id — without it, unread queries are meaningless"

### Reboot check

1. **Where am I?** Plan code + deploy + persona complete through Wave 4.5. Mirror live, read-tracking live, all sync workers healthy.
2. **Where am I going?** Wave 5 (Jeff-driven verification: AC-V1 through AC-V7 + a-mem cleanup queries). Then move plan to `lode/plans/complete/`.
3. **What is the goal?** Demonstrate the mirror serves Madison's daily workflow (structured queries by labels/sender/date/read; immediate write-through visibility; session-staleness fixed).
4. **What have I learned?** Wave 4.5 was a "follow-up question that turned into a small phase" pattern — design discussions naturally uncover gaps the original spec didn't name. Documenting agent-side semantics explicitly (vs upstream mirroring) prevents future confusion about why Proton web-UI reads don't show up.
5. **What have I done?** Waves 0/1/2/3/3.4/3.5/3.6/4/4.5 complete. 50+ task checkboxes ticked. 17 commits across both repos on `madison-read-power` branch.

## Next steps (to resume)

1. **Phase 1 discussion**: confirm with Jeff:
   - Final filter set for `mcp__inbox__query` — anything to add (read_status would need new state column; has_attachment would need attachment metadata persistence; both deferable)
   - Aggregation v1 = count only?
   - Session-hash invalidation: any toolset change vs only on-remove?
2. After Phase 1 lock, switch to a fresh feature branch (`madison-read-power` off `mail-push-redesign`) and start Phase 2.
3. Update Madison's CLAUDE.md instruction: when she suspects her tool-awareness is stale, she should ask Jeff to clear her session, NOT confabulate capabilities. (Persona reinforcement complementary to the structural session-hash fix.)

## 2026-04-22 late evening — Design session: scope expanded to full mirror

### Actions

- Extended design discussion with Jeff, walking all 9 architecture-group edge cases (identity/dedup, label semantics, message classes, sync robustness, backfill/hydration, concurrency, operational).
- Key reframing: Jeff's core product goal is "keep labels clean and consistent" — not just a `query` tool. Current store is content-only with no label/folder/archive/direction state, and 10k+ Proton rows from the `All Mail` backfill look identical to current inbox mail to Madison. "Thin ledger" approach was considered and rejected for this reason.
- Code verification (not assumed): confirmed Proton `source_message_id` = RFC-822 Message-ID (`proton/poller.ts:177`); confirmed write tools resolve Proton UIDs via per-write IMAP search with an explicit v1 limitation on Labels/*-only messages (`apply_action.ts:162-184,182`); confirmed no label/folder/archive state in `messages` schema.
- 9 decision groups locked — full list now in `tracker.md`'s Decisions section.
- Tracker rewritten with 7 acceptance-criteria groups + 6 execution waves (Wave 2 parallelizable across 5 Sonnet subagents, minimizing Opus usage per Jeff's budget constraint).
- btrfs hourly snapshots at `/home/jeff/containers/data/.snapshots/mailroom/` confirmed — removed backup-job and recovery-drill tasks from the plan. Key backup and startup guard remain.

### Reboot check (for next session)

1. **Where am I?** Design discussion complete. Tracker fully rewritten with all locked decisions. Awaiting `mail-push-redesign` Phases 9.1–9.6 before spinning branch.
2. **Where am I going?** Wave 0 → 1 → (2A||2B||2C||2D||2E) → 3 → 4 → 5. Wave 2 is the big parallel push — 5 Sonnet executors working concurrently on hydration/reconcile, incremental sync, write-through refactor, query tool, and session-hash (nanoclaw side).
3. **What is the goal?** Turn the store from a content-only archive into a true mirror of upstream mailbox state, so Madison can service the "keep my labels clean and consistent" goal. Plus the structured `query` tool and session/a-mem freshness fixes from the original scope.
4. **What have I learned?**
   - Every prior plan (`mail-push-redesign`, original `madison-read-power`, proposed `madison-upstream-mirror`) was working around the same missing foundation. Folding the mirror work into one plan on one branch stops the branch-proliferation pattern.
   - Gmail and Proton need fundamentally different sync primitives: Gmail `history.list` vs Proton IMAP IDLE + CONDSTORE. Gmail quota is a non-issue (5,760 units/day for full sync, out of 1B budget).
   - Write-through + sync loop act as each other's safety net: Madison's writes hit DB immediately; sync corrects any drift from foreign-origin changes. Idempotent set-ops make collisions free.
   - Two-phase reconcile (non-blocking read → short apply tx with remove-reverify) is the pattern for correctness without blocking Madison.
   - btrfs hourly snapshots at `~/containers/data/.snapshots/mailroom/` already provide the backup story. Key loss remains the only hard failure; mitigated via multi-location key storage + startup guard.
5. **What have I done?**
   - Full design discussion with Jeff (9 architecture groups).
   - Code verification (3 critical assumptions checked against source).
   - Tracker rewritten with 29 acceptance criteria across 8 outcome groups, 6 execution waves, and a full Decisions table.
   - Progress + findings updates.
