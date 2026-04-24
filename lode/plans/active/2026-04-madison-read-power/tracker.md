# Madison Read Power — Full Inbox Mirror + Session Freshness

Branch: `mail-push-redesign` (this plan's `madison-read-power` branch will be spun off `mail-push-redesign` after its Phases 9.1–9.6 land)

## Goal

Transform the mailroom store from a content-only archive into a **true mirror** of upstream mailbox state (labels, folder membership, direction, archive/delete, message identity) across Gmail and Proton. Give Madison a structured `mcp__inbox__query` tool that can answer questions `search`/`thread`/`recent` cannot — including label hygiene, unread-by-sender counts, cross-label aggregates, and "what did upstream filters auto-archive." Also fix the session-staleness pattern that hid Phase 10 tools on 2026-04-22 and the a-mem staleness that quotes already-fixed issues as current.

**Why this is one plan, not three**: every prior attempt to add a feature (read power, write power, auto-triage) has collided with the same foundation gap — our DB is not a mirror. Fix the foundation once, on one branch, and the dependent capabilities fall into place.

## Acceptance criteria (goal-backward)

### Mirror foundation

- **AC-M1** `messages` table has typed structural columns: `direction`, `archived_at`, `deleted_at`, `deleted_inferred`, `rfc822_message_id`. Drafts and spam purged at migration; skipped at ongoing ingest.
- **AC-M2** `message_labels(message_id, label, canonical, source_id)` populated from Gmail `labelIds` and Proton folder membership. `label_catalog(account_id, label, canonical, source_id, system)` with periodic rename-diff via `labels.list` (Gmail) and `LIST` (Proton). `label_map(canonical, account_id, label)` for user-curated cross-account equivalence.
- **AC-M3** `message_folder_uids(message_id, folder, uid)` (Proton only) — replaces per-write IMAP search in write tools; makes messages in `Trash` and `Labels/*` reachable (fixes the v1 limitation at `apply_action.ts:182`).
- **AC-M4** Label canonicalization helper: NFC normalize, strip zero-width chars, strip `Labels/` prefix, trim, collapse whitespace, Unicode case-fold. Applied consistently at ingest, hydration, and `label_map` insert.

### Write-through

- **AC-W1** Every mailroom write tool (`apply_action`, `archive`, `add_label`, `remove_label`, `label`, `delete`) performs a transactional local-DB update after upstream success. Set operations use `INSERT OR IGNORE` / `DELETE WHERE` (idempotent, commutative).
- **AC-W2** Write tools use `message_folder_uids` to resolve UIDs — no per-write IMAP search.
- **AC-W3** Rules engine at ingest persists label/archive decisions into the DB in the same transaction as the upstream action.
- **AC-W4** Batch tools retry on `SQLITE_BUSY` (3x, 50/100/200ms backoff) per-item, not per-batch.

### Sync worker

- **AC-S1** Gmail: `users.history.list` per account with stored `last_history_id`. On 404 (7-day expiry), falls back to per-account hydration then resumes incremental. Daily heartbeat `history.list` call prevents expiry on dormant accounts.
- **AC-S2** Proton: IMAP IDLE on INBOX + CONDSTORE per-folder MODSEQ polling. Stored `last_modseq` per `(account_id, folder)`. `HIGHESTMODSEQ` monotonicity check on reconnect → regression triggers per-folder hydration.
- **AC-S3** IDLE robustness: re-IDLE every 29 min (RFC 2177), NOOP watchdog every 5 min, auto-reconnect on failure.
- **AC-S4** Nightly reconcile at 04:00 local (configurable). Two-phase: non-blocking read-only folder walk → short apply transaction. Additions via `INSERT OR IGNORE`. Removals re-verify the specific `(message_id, folder/label)` tuple upstream before deleting. Skip if ran in last 20h.
- **AC-S5** Reconcile emits metrics: items checked, adds applied, removes applied, removes skipped after re-verify.
- **AC-S6** Label-deletion storms handled: `history.list` pages processed in 500-event batches; catalog-removal detected → collapse to `DELETE FROM message_labels WHERE canonical=?`.

### Migration (one-time)

- **AC-X1** Proton rows: `UPDATE messages SET rfc822_message_id = source_message_id WHERE source='protonmail'` (Proton's `source_message_id` is already the RFC-822 Message-ID per `proton/poller.ts:177`).
- **AC-X2** Full hydration pass populates `message_labels`, `message_folder_uids`, `direction`, `archived_at` for every existing row from upstream folder/label walk. Same code path as nightly reconcile's full-walk mode.
- **AC-X3** Rows absent from all upstream folders → `deleted_at = NOW()`, `deleted_inferred = 1`.
- **AC-X4** Draft and spam rows purged from DB.
- **AC-X5** Migration completes in <30 min wall time.
- **AC-X6** Startup guard in `db.ts`: if `store.db` exists but decryption fails, refuse to reinit — require explicit operator action. Prevents silent blank-DB-on-top-of-encrypted.

### `mcp__inbox__query` tool

- **AC-Q1** Registered on inbox-mcp as a read-only tool (no `deps` guard).
- **AC-Q2** Filters: `sender`, `account_id`, `account_tag`, `source`, `direction`, `received_after`, `received_before`, `subject_contains`, `body_contains`, `subject_matches`, `body_matches`, `thread_id`, `labels`, `canonical_label`, `no_labels`, `archived`, `include_sent`, `include_deleted`.
- **AC-Q3** `group_by: 'subject' | 'sender' | 'account_id' | 'thread_id' | 'day' | 'week' | 'label'` + `count: true` for aggregation.
- **AC-Q4** Parameterized SQL; no user-input interpolation. Regex filters compile-checked. Default limit 100, max 1000.
- **AC-Q5** Default filter: `direction = 'received' AND deleted_at IS NULL`. `search`, `recent`, `thread`, `query` share this default; `thread` ignores direction to keep thread views whole.
- **AC-Q6** `canonical_label` expands via `label_map` to all mapped source labels.
- **AC-Q7** Perf: count-by-subject across 100k messages with FTS predicate <500ms.
- **AC-Q8** Answers all of:
  - "How many emails from bob@builder.com mentioned 'late payment' last 6 months, count by subject"
  - "Every label with fewer than 3 messages in the past year"
  - "Messages with zero labels last 90 days"
  - "Labels on Gmail not mapped to any Proton label"

### Session toolset-hash invalidation (nanoclaw)

- **AC-T1** `sessions` table gains `tool_list_hash TEXT` column (migration).
- **AC-T2** On spawn, compute SHA-256 of current MCP tool list (tool names, sorted). If stored hash differs, clear session. Logged at INFO with old/new hash.
- **AC-T3** Tests: hash stable across calls when unchanged; differs on add/remove.

### Persona + docs

- **AC-P1** Madison's `CLAUDE.md` documents `mcp__inbox__query` (signature, patterns); removes references to tools she lost in M5/M6.2; documents "ask Jeff to clear session on stale tools" workflow.
- **AC-P2** `CLAUDE.md` "Truthful action reporting" extended with verify-before-quoting-a-mem rule.
- **AC-P3** `lode/practices.md` documents counter-note pattern (fix-ships → write RESOLVED a-mem note).
- **AC-P4** One-time a-mem cleanup: scan for stale "Known gaps" notes from 2026-04-22 (watermark NaN, missing tools) and delete or append RESOLVED markers.

### Lode graduation

- **AC-G1** `lode/architecture/madison-pipeline.md` — session-hash pattern, mirror architecture.
- **AC-G2** `lode/infrastructure/mailroom-mirror.md` (new) — sync architecture: `history.list`, IDLE+CONDSTORE, reconcile.
- **AC-G3** `lode/practices.md` — deploy checklist (env-vault prefix, both-containers-rebuild), counter-note pattern.

### End-to-end verification

- **AC-V1** Fresh Madison spawn answers Bob-late-payment query with grouped counts in one tool call.
- **AC-V2** Toolset change (add placeholder tool + MCP restart) invalidates Madison's session on next spawn.
- **AC-V3** Jeff archives a message in Gmail web → local DB reflects within 5 min (sync incremental working).
- **AC-V4** Jeff renames a Gmail label → within 24h, `label_catalog` reflects new display name; all `message_labels` rows still join correctly (labelId-keyed).
- **AC-V5** Madison `add_label` via tool → immediate subsequent `query({labels:[X]})` returns the message (write-through confirmed).
- **AC-V6** a-mem freshness: ask "are Proton watermarks working?" — Madison does not cite the now-fixed NaN issue.
- **AC-V7** All 303 nanoclaw tests + mailroom tests pass.

## Decisions (locked)

### Identity / dedup

| Decision | Rationale |
|---|---|
| Dedup key is RFC-822 Message-ID (already used for Proton `source_message_id`); Gmail rows get `rfc822_message_id` column backfilled during hydration | Single cross-source identity; avoids per-folder UID bloat |
| Same logical message across Gmail + Proton stored as separate rows (per-account state is real) | Archiving on Gmail ≠ archiving on Proton; grouping is a query-time concern (`GROUP BY rfc822_message_id`) |
| Synthetic fallback `sha256(sender + received_at_ms + subject + body_size)` when Message-ID absent | Rare; log when invoked |
| Proton physical location tracked in `message_folder_uids(message_id, folder, uid)` | Replaces per-write IMAP search; fixes Labels/*-unreachable v1 limitation |

### Label semantics

| Decision | Rationale |
|---|---|
| `label_catalog` keyed on `source_id` (Gmail labelId / Proton folder path) with display name as mutable metadata | Gmail renames preserve labelId; free rename support |
| Periodic `labels.list` + Proton `LIST` diff to catch dormant renames | `history.list` doesn't emit rename events |
| Label deletion storms: paginated batch commits, bulk collapse on catalog-delete | Avoid per-event SQL on 5k-event bursts |
| Per-account label storage + optional user-curated `label_map` for cross-source equivalence | Accounts are genuinely independent; map is a queryable fact, not a storage merge |
| Gmail system labels extracted to typed columns (`INBOX` → `archived_at`, `TRASH` → `deleted_at`, `SENT`/`DRAFT`/`SPAM` → `direction`); remainder (`STARRED`, `IMPORTANT`, `CATEGORY_*`) kept in `label_catalog` with `system=1` | Structural state deserves columns; labels are for user concepts |

### Message classes

| Decision | Rationale |
|---|---|
| Ingest received + sent mail; `direction` column discriminates | Thread reconstruction needs sent mail; default-filter keeps inbox views clean |
| Skip drafts at ingest; purge existing | Mutable content, not a triage surface |
| Skip spam at ingest; purge existing | Noise + phishing surface; ingest spam would require default-exclude filter everywhere |
| `thread` tool ignores direction filter | Threads are intrinsically bidirectional |

### Sync robustness

| Decision | Rationale |
|---|---|
| Gmail history.list 404 → per-account hydration + daily heartbeat ping | History expires at 7d; heartbeat prevents expiry on dormant accounts |
| Proton IDLE re-issue every 29 min + 5-min NOOP watchdog | RFC 2177 timeout guidance; IDLE can die silently |
| CONDSTORE MODSEQ regression → per-folder hydration | Bridge reconnects can reset; detect on SELECT |
| Nightly reconcile two-phase: non-blocking scan → short apply tx with remove-reverify | Never blocks Madison; correctness on removals |
| Reconcile at 04:00 local, skip if run in last 20h | Off-peak, idempotent-safe scheduling |

### Backfill / hydration

| Decision | Rationale |
|---|---|
| Hydration ≡ reconcile's full-walk mode | One code path; migration is first invocation |
| Inferred deletions marked `deleted_inferred=1` with `deleted_at=NOW()` | Keep row (search + thread integrity); honest about unknown delete date |
| No body re-fetch; hydrate state only | Preserves FTS; ~20 min vs ~1 hour |
| Proton `rfc822_message_id` backfilled via SQL `UPDATE` (no fetch needed) | Already stored in `source_message_id` |

### Concurrency

| Decision | Rationale |
|---|---|
| SQLite WAL + idempotent writes; no explicit mutex | Set ops commute; SQLite serializes writers |
| Reconcile apply phase only removes after upstream re-verify | Prevents races with concurrent write-throughs |
| Batch tools retry on `SQLITE_BUSY` per-item | Don't fail whole batch on transient lock |

### Operational

| Decision | Rationale |
|---|---|
| btrfs hourly snapshots at `/home/jeff/containers/data/.snapshots/mailroom/` handle backup — no separate job | Existing infrastructure; encrypted-at-source |
| Startup guard in `db.ts` refuses reinit on decrypt failure | Prevents silent blank DB on key mismatch (2026-04-22 Sonnet-executor class of incident) |
| `INBOX_DB_KEY` in env.vault + password manager (document in `lode/infrastructure/`) | Snapshots worthless without key |
| Label canonical form stored alongside display form (both columns, canonical indexed) | Enables case/unicode/whitespace-insensitive match without corrupting display |

## Read first

**Design discussion context:**
- `lode/plans/active/2026-04-madison-read-power/findings.md` — 2026-04-22 diagnostic and design session (all 9 architecture groups discussed here).

**Mailroom code (ConfigFiles repo, `~/Projects/ConfigFiles/containers/mailroom/mailroom/`):**
- `src/store/db.ts` — schema, encryption, open path. Add migration, startup guard here.
- `src/store/queries.ts` — existing `searchMessages`, `getThread`, `getRecentMessages`. Add `queryMessages`, `aggregateMessages`.
- `src/store/ingest.ts` — current insert path. Add draft/spam skip, direction derivation, `message_labels` / `message_folder_uids` write-through.
- `src/store/types.ts` — InboxMessage shape. Extend with new columns.
- `src/proton/poller.ts:177` — confirms Proton `source_message_id = envelope.messageId` (RFC-822 Message-ID).
- `src/mcp/tools/apply_action.ts:162-184` — current per-write IMAP search; replace with `message_folder_uids` lookup. Line 182 "v1 limitation" comment goes away.
- `src/mcp/tools/archive.ts`, `add_label.ts`, `remove_label.ts`, `label.ts`, `delete.ts` — write-through targets.
- `src/rules/apply/proton.ts`, `src/rules/apply/gmail.ts` — rules-engine write paths; add transactional local write.
- `src/backfill/proton.ts`, `src/backfill/gmail.ts` — pattern reference for folder/label walkers.
- `src/mcp/server.ts:114-174` — read-only tool registration pattern (no `deps` guard).

**Nanoclaw code (this repo, `~/containers/nanoclaw/`):**
- `src/db.ts` — `sessions` table. Add `tool_list_hash` column migration.
- `src/index.ts:345-375` — session rotation. Insert hash check here.
- `container/agent-runner/src/index.ts:495-555` — Trawl tool discovery pattern for fetching MCP tool list.

**Madison persona:**
- `~/containers/data/NanoClaw/groups/telegram_inbox/CLAUDE.md` — docs target.

## Phases / Waves

### Wave 0 — Pre-reqs (sequential)

- [x] 0.1 `mail-push-redesign` Phases 9.1–9.6 complete (`ff180f5` closed it; plan moved to `lode/plans/complete/2026-04-mail-push-redesign`)
- [x] 0.2 Spin `madison-read-power` branch off `mail-push-redesign` in nanoclaw (tip `b866105`)
- [x] 0.3 Spin `madison-read-power` branch in ConfigFiles mailroom (off `main`, tip `58a290f`)

### Wave 1 — Schema foundation (single agent; blocks Wave 2)

**Execution model: 1 Sonnet executor, serialized.**

- [x] 1.1 Mailroom schema migration: `rfc822_message_id`, `direction`, `archived_at`, `deleted_at`, `deleted_inferred`, `message_labels`, `message_folder_uids`, `label_catalog`, `label_map`, `proton_folder_state`. Indexes on canonical forms, direction+archived, rfc822. (CF `f8f827e`)
- [x] 1.2 Startup guard in `db.ts`: refuse reinit on decrypt failure (`MailroomDbDecryptError`; runs `SELECT count(*) FROM sqlite_master` after PRAGMA cipher+key, throws iff file exists + size > 0). (CF `f8f827e`)
- [x] 1.3 Canonicalization helper `src/labels/canonicalize.ts` + unit tests (10 tests: NFC, ZW chars, `Labels/` prefix, whitespace, Unicode case-fold). (CF `f8f827e`)
- [x] 1.4 `accounts` table gains `last_history_id`, `last_history_refresh_at` (Gmail). `proton_folder_state` table for MODSEQ + IDLE state. (CF `f8f827e`)
- [x] 1.5 Migration fails fast if run against old schema incompatibly (`MailroomSchemaError`; new `meta(schema_version='2')` sentinel). (CF `f8f827e`)

### Wave 2 — Parallel implementation (5 concurrent agents)

**Execution model: 5 Sonnet executors in parallel, one per workstream. Orchestrator merges/coordinates.**

**2A: Hydration/reconcile pipeline** (mailroom) — CF `7afa3ab`
- [x] 2A.1 Proton folder walker: per-folder `UID FETCH 1:* (BODY.PEEK[HEADER.FIELDS (MESSAGE-ID)])` (`src/reconcile/proton-walker.ts`, AsyncGenerator, skips `\Noselect`)
- [x] 2A.2 Gmail walker: per-label `messages.list` → `messages.get(format='metadata', metadataHeaders:['Message-ID'])` batched (max 250) (`src/reconcile/gmail-walker.ts`)
- [x] 2A.3 In-memory delta builder: `buildLabelDelta`, `buildFolderUidDelta`, `findInferredDeletes`, `collapseStormRemovals` (storm threshold 100) (`src/reconcile/delta.ts`)
- [x] 2A.4 Apply phase: adds via `INSERT OR IGNORE`; removes re-verify upstream via injected callback before delete (`src/reconcile/apply.ts`)
- [x] 2A.5 Reconcile scheduler — `setInterval` 5-min check targeting 04:00 local, skip if `meta.last_reconcile_at` within 20h (`src/reconcile/scheduler.ts`; `node-cron` not in deps)
- [x] 2A.6 Metrics emission as JSON log line (`src/reconcile/metrics.ts`)
- [x] 2A.7 Tests: happy path, race with write-through, inferred-delete, label-deletion-storm collapse — 33 tests. MODSEQ regression detection deferred to 2B's scope.

**2B: Incremental sync worker** (mailroom) — CF `16886aa`
- [x] 2B.1 Gmail `history.list` handler per account, paginated, with event dispatch (`src/sync/gmail-history.ts`, `gmail-events.ts`)
- [x] 2B.2 404 handler → calls `runGmailHydration` if 2A available, else sets `last_history_id='__needs_hydration__'` sentinel (Wave 3 resolves)
- [x] 2B.3 Daily heartbeat ping; tracks `last_history_refresh_at` (`src/sync/gmail-heartbeat.ts`)
- [x] 2B.4 Proton IDLE on INBOX with 29-min re-IDLE loop (`src/sync/proton-idle.ts`)
- [x] 2B.5 NOOP watchdog every 5 min; 30s timeout → reconnect with exponential backoff
- [x] 2B.6 CONDSTORE MODSEQ poller per folder, every 5 min (`src/sync/proton-condstore.ts`)
- [x] 2B.7 `HIGHESTMODSEQ` monotonicity check on reconnect/SELECT; regression → calls `runProtonHydration` if 2A available, else sets `last_modseq=-1` sentinel
- [x] 2B.8 Event-to-DB applier: typed-column updates + message_labels INSERT/DELETE (`src/sync/gmail-events.ts`, `proton-events.ts`)
- [x] 2B.9 Tests: history expiry, MODSEQ regression, IDLE silent death, storm pagination (5000 events / 10 pages), out-of-order events — 25 tests

**2C: Write-through refactor** (mailroom) — CF `f6c8019`
- [x] 2C.1 Transactional local-DB update in `apply_action.ts` after upstream success
- [x] 2C.2 Same for `archive`, `add_label`, `remove_label`, `label` (replace-set), `delete`
- [x] 2C.3 `getProtonFolderUids()` helper added to `src/store/queries.ts`; `apply_action.ts` UID lookup now DB-first
- [x] 2C.4 v1 limitation comment removed from `apply_action.ts`; Labels/*-only Proton message reachability test passes
- [x] 2C.5 Rules engine `src/rules/apply/{proton,gmail}.ts` write through after each label COPY / archive MOVE
- [x] 2C.6 Ingest path skips Gmail DRAFT/SPAM + Proton Drafts/Spam folders; populates `direction` from source state; sets `archived_at` when Gmail INBOX label absent
- [x] 2C.7 `SQLITE_BUSY` retry helper (3x, 50/100/200ms) in `src/store/sqlite-busy.ts`; per-item not per-batch
- [x] 2C.8 74 new tests covering all 6 tools, ingest skip, busy retry, Labels/*-only reachability, rules-engine transactional integrity

**2D: Query tool + read-tool defaults** (mailroom) — CF `ab6febd` (with `queries.ts` portion swept into `f6c8019` due to parallel-edit attribution race; functionally complete)
- [x] 2D.1 `src/store/types.ts` — `QueryArgs`, `QueryResult`, `AggregateResult`, `QueryGroupBy`; `Search/Recent/Thread` extended with `include_sent`/`include_deleted`
- [x] 2D.2 `queryMessages()` in `src/store/queries.ts` with dynamic parameterized SQL builder, 18 filters
- [x] 2D.3 `aggregateMessages()` for grouped count (subject/sender/account_id/thread_id/day/week/label)
- [x] 2D.4 `canonical_label` expansion via `label_map` JOIN (account-scoped) with direct-canonical fallback
- [x] 2D.5 `src/mcp/tools/query.ts` MCP wrapper; registered as read-only in `src/mcp/server.ts`
- [x] 2D.6 `search` and `recent` apply default `direction='received' AND deleted_at IS NULL`; `include_sent`/`include_deleted` opt-outs added
- [x] 2D.7 `thread` ignores direction filter; `include_deleted` opt-out added
- [x] 2D.8 49 tests: each filter, combos, regex compile-safety, limit cap (1000 max), canonical_label expansion, default-filter on search/recent
- [x] 2D.9 100k-message perf test in `queries.perf.test.ts` (`describe.skip`, manual run) — defers measurement to Wave 5 verification

**2E: Session toolset-hash** (nanoclaw) — NC `c6cdd3a`
- [x] 2E.1 `sessions` table gains `tool_list_hash TEXT` migration in `src/db.ts`
- [x] 2E.2 `getSessionToolHash` / `setSessionToolHash` helpers in `src/db.ts`; `SessionInfo` type extended
- [x] 2E.3 `src/mcp-tool-discovery.ts` — `computeGroupMcpHash` derives hash from sorted active MCP server names per group config (host-side derivation, no live network query)
- [x] 2E.4 Hash check wired into `runAgent()` in `src/index.ts` after age/count rotation; clears session on mismatch with INFO log
- [x] 2E.5 21 new tests across `src/db.test.ts` + new `src/mcp-tool-discovery.test.ts` (hash stability, change detection, mismatch clear)

### Wave 3 — Integration + migration (single agent, after Wave 2 merges)

**Execution model: 1 Sonnet executor, serialized.**

- [x] 3.1 Migration orchestrator script `scripts/migrate-mirror.ts`: 7 phases (open → schema → purge → rfc822 backfill → `runFullHydration` → inferred-deletes → metrics) (CF `1e46257` + `f398393` gap closure to call `runFullHydration` instead of inline composition)
- [x] 3.2 `--dry-run` flag: walkers naturally read-only via `BODY.PEEK`; Gmail metadata-only; `dryRun` flag plumbed through `runFullHydration` (CF `1e46257` + `f398393`)
- [x] 3.3 Integration tests: 8 in `migrate-mirror.test.ts` (end-to-end migration, dry-run idempotence, re-run idempotence, hydration label adds, inferred deletion, write-through+query round-trip, sync event applier round-trip, reconcile race re-verify) + 4 in `sync-hydrate-fallback.test.ts` (Gmail 404 → hydrate, Proton MODSEQ regression → hydrate) (CF `1e46257` + `f398393`)
- [x] 3.4 Deploy: rebuild mailroom containers, rebuild agent container, restart nanoclaw (CF `86b9072` deploy fixes + `57e631b` Wave 3.5 audit). First attempt produced silently-wrong data (60k rows incorrectly marked deleted, message_labels empty). Rolled back via btrfs snapshot, fixed root causes (Wave 3.5), re-ran successfully.

### Wave 3.5 — apply.ts audit + self-verifying migration (CF `57e631b`)

Wave 3.4 first attempt completed without errors but wrote silently-wrong data. Sanity SQL revealed: `message_labels=0`, `label_catalog=0`, `deleted_inferred=60,167` (literally every row), reported metrics didn't match actual DB state. Rolled back to btrfs snapshot `2026-04-23-085005`. Spawned focused Sonnet executor to fix root causes:

**Bugs identified + fixed:**
- **A — Metrics-vs-writes mismatch:** `applyInferredDeletes` wrote rows but `hydrate.ts:280` hardcoded `inferred_deletes: 0` instead of capturing the return. Same drift in `total_inferred_deletes` plumbing. Fix: function returns `number`; hydrate captures + aggregates.
- **B — Empty `message_labels`:** Proton accounts only called `applyFolderUidDelta`, never `applyLabelDelta`. Per Wave 1 decision, Proton folder paths are stored as label entries — call both. `applyLabelDelta` now also writes `label_catalog` via `INSERT OR IGNORE`.
- **C — Inferred-delete blast:** comparison built `seenMessageIds` from `rfc822_message_id` strings but `applyInferredDeletes` queried `SELECT message_id` (internal UUID). Two incompatible key spaces → zero intersection → all rows marked deleted. Fix: comparison uses `source_message_id` throughout.
- **D — Gmail rfc822 join:** Gmail walker triples dropped `gmailId` when mapped, losing the source-native id. Fix: triples carry `sourceMessageId` from the source's native id (gmailId for Gmail, rfc822 for Proton).

**Self-audit added to `migrate-mirror.ts`:** runs after hydration, queries actual DB state, fails the script (exit 1) if reported metrics drift from actual, or if invariants break (`message_labels` empty when Proton messages exist; `label_catalog` empty when adds were reported; `deleted_inferred > 50%` blast guard). Future deploys can't silently produce wrong data.

**Tests:** new `src/integration/apply-bugs-wave35.test.ts` (8 tests) seeds synthetic state, runs the apply chain, asserts every row matches expectation (not just counts). Pre-existing apply.test.ts mock fixed for the new key shape. Total 300/302 (2 perf skipped).

### Wave 3.4 deploy results (post-Wave 3.5 retry)

Live migration completed in 9.7 min. Self-audit passed. Final DB state:

| Table / Column | Value |
|---|---|
| `messages.rfc822_message_id` NOT NULL | 59,673 (Proton rows backfilled via SQL UPDATE) |
| `message_labels` rows | 190,286 (Proton folder memberships) |
| `message_folder_uids` rows | 190,286 (Proton (folder, uid) pairs) |
| `label_catalog` rows | 147 (unique Proton folders across 5 accounts) |
| `messages.deleted_inferred=1` | 51 (genuinely orphaned rows; 0.08% of total — well under blast guard) |
| Total messages | 60,163 |

Per-account walks all clean. Gmail walked 1,808 items but 0 adds applied (separate known issue — see deferred items below). Services brought back up: 5 IDLE sessions + 5 CONDSTORE pollers + reconcile scheduler all started clean, zero auth errors. Nanoclaw restarted on new agent image (Wave 2E session-hash invalidation active).

### Deferred to follow-up

- **Codex review findings on Wave 2E** (P1 + P1 + P2 — recorded in tracker checkbox below):
  - P1: `setSession()` resets `created_at` and `message_count=0` on every resume → rotation counters never trigger
  - P1: pre-migration sessions with NULL `tool_list_hash` not invalidated on first run after deploy → first spawn after MCP changes still resumes stale conversation
  - P2: Trawl config changes that don't add/remove the server itself aren't caught by the hash
- ~~**Gmail hydrated_adds=0**~~ → **CLOSED Wave 3.6 (CF `a7baeed`)**: root cause was `buildLabelDelta` and `applyLabelDelta` still keyed on `rfc822_message_id` after Wave 3.5 (which only fixed inferred-delete keying). Local Gmail rows have NULL rfc822 (only Proton was SQL-backfilled), so all Gmail upstream entries fell into the `unknowns` bucket. Fix: shift apply path to use `source_message_id` end-to-end (gmailId for Gmail, rfc822 for Proton — both already on every row by Wave 1 contract). Wave 3.6 re-run migration: Gmail message_labels 0 → **1,784**, Gmail label_catalog 0 → **28**. Architectural side-benefit: Gmail rfc822 backfill is now truly optional (apply doesn't need it). 305 tests pass (was 300).
- **Audit invariants need re-run awareness** — Wave 3.6 re-run audit fired exit 1 with 3 false positives (51 deleted_inferred from Wave 3.5 marked as drift; 2 Proton accounts walked-but-no-new-adds correctly idempotent). Audit was right to halt — the right fix is to compare against pre-migration state (deltas, not absolutes) and relax `adds==0` when prior coverage exists.

### Wave 3 gap closure (2026-04-23, design-corrected) — CF `f398393`

Wave 3 first pass shipped with 6 tsc errors + a no-op reconcile scheduler stub. Root cause: Wave 2A exposed only primitives (walkers/delta/apply), 2B worked around the missing composed API with runtime late-binding (`mod.runGmailHydration as …`), Wave 3 stubbed `runFn`. Closed by:

- New `src/reconcile/hydrate.ts` exposes `hydrateGmailAccount(email, deps)`, `hydrateProtonFolder(account, folder, deps)`, `runFullHydration(deps)` — composes walker → delta → apply.
- `src/reconcile/index.ts` exports the new functions as the public reconcile API.
- Late-binding scaffolding deleted from `src/sync/gmail-history.ts` and `src/sync/proton-condstore.ts`; replaced with direct imports.
- `src/ingestor.ts` wires the scheduler `runFn` by passing `runFullHydration` (composition root pattern; scheduler stays decoupled).
- `scripts/migrate-mirror.ts` hydration phase collapsed into a single `runFullHydration()` call — same code path as nightly reconcile per the locked decision.
- 4 new integration tests in `src/integration/sync-hydrate-fallback.test.ts` exercise the sync→hydrate fallback that the original Wave 3 didn't test.
- 2 implicit-`any` errors in `gmail-history.ts:144,157` annotated.
- `tsc --noEmit` zero errors. Test suite 288 passing / 2 skipped. Lessons file updated with the cross-workstream-API-contract pattern.

`__needs_hydration__` / `last_modseq=-1` sentinel paths kept — they now serve a real failure mode (no IMAP/OAuth client available at hydration time), no longer the primary path.

### Wave 4 — Docs + persona (single agent)

**Execution model: 1 Sonnet executor.**

- [x] 4.1 Madison `CLAUDE.md`: `mcp__inbox__query` docs (signature, 5 example patterns); session-stale workflow; verify-before-quoting-a-mem extended truthful-reporting rule (NC `540e98e`)
- [~] 4.2 a-mem cleanup: tools available but Madison's `telegram_inbox` ChromaDB is per-group isolated (only reachable from inside Madison's container). Wave 4 executor produced recommended search queries Jeff can run interactively from Madison's session: `search_memories({query:"watermark NaN Proton bug"})`, `search_memories({query:"Known gap missing tools Phase 10"})`, `search_memories({query:"session stale tool list"})` — append `RESOLVED 2026-04-23 — see CF 58a290f / NC c6cdd3a / CF 57e631b` or delete obsolete notes.
- [x] 4.3 `lode/architecture/madison-pipeline.md` created (mirror architecture + session-hash pattern + mermaid data-flow diagram); `lode/infrastructure/mailroom-mirror.md` created (sync architecture, IDLE/CONDSTORE, reconcile, mermaid startup wiring + apply path) (NC `540e98e`)
- [x] 4.4 `lode/practices.md` deploy checklist + counter-note pattern + cross-workstream + self-audit pointers (NC `540e98e`)
- [x] 4.5 `lode/infrastructure/mailroom-rules.md` env-vault requirement section added (NC `540e98e`)

### Wave 4.5 — Agent-side read tracking (CLOSED — CF `1ad00ee`)

Bonus phase added 2026-04-23 after Jeff asked whether Madison could query/mark read state. Wave 1's filter inventory had no read/unread; Gmail UNREAD worked via labels but Proton had no read tracking at all. Solution: agent-side `read_at` column populated when Madison surfaces a message.

- [x] 4.5.1 Schema v3→v4: `messages.read_at INTEGER` (nullable epoch ms) + `idx_messages_read_at` index. Schema guard accepts v3 silently; rejects v1/v2 multi-step regression.
- [x] 4.5.2 `QueryArgs.read?: boolean` filter on `queryMessages` and `aggregateMessages` (parameterized SQL; `read_at IS NOT NULL` / `IS NULL`).
- [x] 4.5.3 `mcp__inbox__mark_read({message_ids: string[]})` — batch verb, idempotent (preserves original `read_at` on re-call), per-id results, summary aggregate. SQLITE_BUSY retry.
- [x] 4.5.4 `mcp__inbox__mark_unread({message_ids: string[]})` — symmetric, clears `read_at`.
- [x] 4.5.5 25 new tests (mark_read/mark_unread tool tests + read-filter on queryMessages/aggregateMessages + schema v4 migration). Total 307 → 332.
- [x] 4.5.6 Madison `CLAUDE.md` updated: `read` added to filter inventory; example #5 rewritten to use `read: false`; mark_read/mark_unread documented in batch verb section; explicit workflow ("call mark_read at the end of every digest with every surfaced id").
- [x] 4.5.7 Deployed: mailroom rebuilt + recreated; schema_version bumped to 4 in live DB; read_at column + index present; 5 IDLE + 5 CONDSTORE + reconcile scheduler all up clean.

**Tools surface (post-4.5):** 15 inbox MCP tools — `search`, `thread`, `recent`, `query`, `mark_read`, `mark_unread`, `apply_action`, `archive`, `label`, `add_label`, `remove_label`, `delete`, `send_message`, `send_reply`, `validate_rules`.

**Decision (locked):** read state is agent-side only — NOT mirrored to upstream Gmail UNREAD label or Proton `\Seen` flag. Rationale: web-UI reads on Proton don't propagate through IMAP bridge; agent-side state matches the actual triage workflow ("Madison surfaced this to me, did I act on it?"). Could add upstream mirroring later if web-UI read state ever becomes accessible.

### Wave 5 — Verify + graduate (Jeff-driven)

- [ ] 5.1 Clear Madison's session; fresh spawn via container rebuild
- [ ] 5.2 AC-V1: Bob-late-payment `query` with group_by=subject + count=true returns grouped counts in one call
- [ ] 5.3 AC-V2: add a placeholder MCP tool, restart MCP → next Madison spawn invalidates session (check INFO log)
- [ ] 5.4 AC-V3: archive a test message in Gmail web → `SELECT archived_at FROM messages WHERE ...` within 5 min
- [ ] 5.5 AC-V4: rename a Gmail label → verify `label_catalog.label` updates within 24h; all existing `message_labels` rows still queryable under new name
- [x] 5.6 AC-V5: `mark_read` and `add_label` via HTTP MCP both write through to local DB; subsequent `query()` returns immediately. **Initial fail uncovered Wave 2C silent write-failure** (inbox-mcp had `MAILROOM_DB_READONLY=true` from Phase M2 — Wave 2C's writes were swallowed, masked by nightly reconcile). Fixed CF `5935bf9` (drop env var); both write paths verified end-to-end.
- [ ] 5.7 AC-V6: "are Proton watermarks working?" — Madison doesn't cite NaN issue
- [x] 5.8 AC-V7: nanoclaw 334/334 + mailroom 332/334 (2 perf skipped) green
- [ ] 5.9 Move plan to `lode/plans/complete/`

### Wave 5.5 — Push-ingest parity (blocks AC-V3 / AC-V6 truth)

**Execution model: 1 Sonnet executor, serialized. Bundles the push-ingest label gap (discovered 2026-04-23 during Wave 5 verification) with `TD-MAIL-PUSH-WATERMARK` (same conceptual root cause: Wave 2B workers don't fully replicate what migration hydration does).**

**Brief**: `wave-5.5-push-ingest-parity.md` (full diagnosis, SQL counts, root-cause hypothesis, proposed fix shape, test + audit invariant spec).

- [x] 5.5.1 Verify ingest path — **done 2026-04-23 evening**. Both legacy `proton/poller.ts` and `gmail/poller.ts` are the **primary** ingest paths today. Wave 2B workers (idle/condstore/history) are up but acting as change-detectors on existing rows; zero `applyProtonUidAdded` / `applyLabelsAdded` log lines in last 3h. Today's 6 zero-label Proton messages all came from `proton/poller.ts:211` → `ingestMessage()`, which writes `messages` but never touches `message_labels` / `label_catalog` / `message_folder_uids`. See progress.md.
- [x] 5.5.2 Extend `ingestMessage()` in `src/store/ingest.ts`: optional `labels?: string[]` + `folder_uid?: { folder, uid }`; 4 new prepared stmts; label/catalog/folder_uid writes inside existing transaction; `canonicalizeLabel` applied; existing callers unchanged. (CF `6dfeba8`)
- [x] 5.5.3 `src/proton/poller.ts` call site: passes `labels:['INBOX'], folder_uid:{folder:'INBOX',uid}`. (CF `6324d2b`)
- [x] 5.5.4 `src/gmail/poller.ts` call site: passes `labels: msg.data.labelIds ?? []`. (CF `6324d2b`)
- [x] 5.5.5 Wave 2B event-applier hardening:
  - `applyProtonUidAdded` now writes `message_labels` + `label_catalog` alongside `message_folder_uids` (CF `a92e8e8`)
  - `applyLabelsAdded` in gmail-events.ts now also writes `label_catalog` `INSERT OR IGNORE` when new labelId first seen (CF `a92e8e8`)
- [x] 5.5.6 Watermark bump folded into `ingestMessage` transaction. **Deviation**: used existing `watermarks` table (not a new `accounts.watermark_received_at` column) — `watermarks` is what `getRecentMessages` already reads; no schema bump needed. Closes `TD-MAIL-PUSH-WATERMARK`. (CF `6dfeba8`, same commit as 5.5.2)
- [x] 5.5.7 `mcp__messages__audit_label_coverage({since_hours?})` registered read-only on inbox-mcp; returns `{missing_label_count, sample_message_ids[]}`. (CF `3b186f0`)
- [x] 5.5.8 Integration tests (new, `src/integration/wave-5.5-push-ingest-parity.test.ts`): 6 new tests, 332 → 338 passing, 2 skipped. `tsc --noEmit` zero errors. (CF `44ed487`)

  *Original test spec for reference:*
  - Seed: Proton poller ingest of message in INBOX → assert `messages`, `message_labels(label='INBOX', canonical='inbox')`, `label_catalog` entry, `message_folder_uids(folder='INBOX', uid=N)` all present.
  - Seed: Gmail poller ingest of message with `labelIds:['INBOX','IMPORTANT','UNREAD']` → assert three `message_labels` rows + three `label_catalog` rows.
  - Seed: push-only-day simulation — ingest N messages without calling `recent`; assert per-account watermark advanced to max `received_at`; assert subsequent `recent` call returns 0 new messages.
  - Seed: new-message event via `applyProtonUidAdded` → assert `message_folder_uids` + `message_labels` + `label_catalog` all written (Wave 2B parity).
  - Seed: audit-tool — insert a row directly in `messages` bypassing labels → `audit_label_coverage` returns non-zero with the message_id.
- [x] 5.5.9 Backfill via `docker exec mailroom-ingestor-1 npx tsx scripts/migrate-mirror.ts` (full `runFullHydration` run). Result: 165 label adds across 4 accounts (jstone.pro 26, thestonefamily.us 57 +11 removes, gmail americanvoxpop 29, registrations 53), 1 inferred-delete, audit_passed. Re-run immediately after was idempotent — confirms gap closed. Final DB: `message_labels=192,130`, `message_folder_uids=190,317`, `label_catalog=175`, `total_messages=60,179`.
- [x] 5.5.10 Deploy: both containers rebuilt + recreated via `cd ~/containers/mailroom && env-vault env.vault -- docker compose build/up -d`. Gotcha: compose's `../data/...` paths only resolve correctly when cwd is the `~/containers/mailroom` symlink — using the real `~/Projects/ConfigFiles/...` path mounts the wrong dir and ingestor crash-loops with "Gmail credentials not found". Post-deploy: 5 IDLE + 5 CONDSTORE + reconcile scheduler all up clean, zero auth errors. **Practices lesson captured below.**
- [x] 5.5.11 Live verify 2026-04-23 15:57 CDT. Test: Jeff sent `americanvoxpop@gmail.com` → `jeff@jstone.pro`. Result: `messages` row written (`protonmail:<CAKrEtEkhNYn3ieHKhgaqN...@mail.gmail.com>`, subject "Test Message", received_at 20:54:49 UTC); `message_labels` = INBOX; `message_folder_uids` = INBOX:11; `watermarks.watermark_value` advanced to 20:54:49 with `updated_at` 20:57:36.818 (matches ingest log line → watermark bump runs in same tx as label write); `audit_label_coverage(since_hours:1)` → missing_label_count: 0; Madison pipeline fired end-to-end (Jeff notified via Telegram). Gmail-SENT side not yet polled (Gmail poller runs on cycle; orthogonal to Wave 5.5 scope).
- [x] 5.5.12 `lode/tech-debt.md`: `TD-MAIL-PUSH-WATERMARK` CLOSED with CF `6dfeba8`. `lode/infrastructure/mailroom-mirror.md`: ingest-path label invariant + audit tool documented. Madison's `CLAUDE.md`: audit tool added in a Diagnostic subsection between reads and writes.
- [ ] 5.5.13 **(Jeff-driven)** Re-run Wave 5 AC-V3 (archive in Gmail web → local DB reflects) and AC-V6 (a-mem freshness sanity) now that push-ingest parity holds.

### Wave 5.6 — CONDSTORE non-INBOX folder seeding (blocks AC-S2 real-world claim)

**Discovered 2026-04-23 during 5.5.11 follow-up test**: Jeff applied the "Family" label to the test message in Proton web; no event fired on our side. Root cause: `proton_folder_state` is **empty for every Proton account**, so ingestor's CONDSTORE setup falls back to polling `['INBOX']` only. Label/folder changes outside INBOX are invisible to Wave 2B push paths and only surface via 04:00 nightly reconcile. The AC-S2 promise ("per-folder CONDSTORE polling") has the machinery but was never seeded.

**This is not a Wave 5.5 regression** — Wave 5.5 hardened `applyProtonUidAdded` to write labels + catalog correctly. The seed gap is upstream. Closing it delivers AC-S2's real behavior and makes Jeff's label-in-web test work within 5 min.

**Execution model: 1 Sonnet executor, serialized.** ~100 LOC + tests. Same branch (`madison-read-power`) in both repos.

**Goal**: every Proton folder discovered upstream has a row in `proton_folder_state`; CONDSTORE polls them all; label/folder changes in Proton web propagate to the local mirror within 5 min.

**Acceptance criteria**:
- AC-5.6-1 `proton_folder_state` seeded for every folder on every Proton account, via both startup and hydration paths.
- AC-5.6-2 CONDSTORE polls all seeded folders, not just INBOX (verified post-deploy: `SELECT COUNT(*) FROM proton_folder_state` >> N_accounts).
- AC-5.6-3 Integration test: fake IMAP LIST → seed populates → CONDSTORE-poll loop fires per folder in the seeded set.
- AC-5.6-4 Live verify: Jeff's "Family" label test (or equivalent) works end-to-end within 5 min of applying the label in Proton web.

**Locked decisions**:

| Decision | Rationale |
|---|---|
| Seed via **both** startup hook AND hydration walker | Startup heals on restart; walker heals on reconcile. Either alone leaves a failure mode uncovered. |
| Initial `last_modseq = 0` on seed | First CONDSTORE poll per folder fires for all existing messages; `INSERT OR IGNORE` keeps writes cheap and heals accumulated non-INBOX label gaps for free. Jeff approved the one-time bulk-fire cost. |
| Skip `\Noselect` folders (matches Wave 2A.1 walker pattern) | They can't be SELECTed; CONDSTORE would fail. |
| Startup seed is best-effort; failure logs and falls through to INBOX-only | Don't crash the ingestor on transient bridge unavailability. Nightly reconcile self-heals. |
| Skip IMAP NOTIFY (RFC 5465) | Unknown bridge support; coverage (not latency) is the bottleneck. Revisit if future latency concerns surface. |

**Sub-tasks**:
- [x] 5.6.1 + 5.6.2 New `src/sync/proton-folder-discovery.ts` with `seedFolderState(accountId, getImapClient)`: LIST, filter `\Noselect`, batch `INSERT OR IGNORE` with `last_modseq=0`. Error-swallow on IMAP unavailable. Exported via `sync/index.ts`. (CF `aea0062`)
- [x] 5.6.3 `src/ingestor.ts` wire-in: per-account guard reads `proton_folder_state`; if zero rows, calls `seedFolderState` before `folderRows` read. Extracted `openImap(address)` helper so seed + CONDSTORE share one IMAP constructor. Best-effort with try/catch. (CF `428e2f6`)
- [x] 5.6.4 `src/reconcile/hydrate.ts` walker hookup: every folder walked → `INSERT OR IGNORE INTO proton_folder_state`. **Deviation**: did NOT use `upsertFolderState` helper because its `ON CONFLICT DO UPDATE SET last_modseq=excluded.last_modseq` would reset real MODSEQ values back to 0; using direct `INSERT OR IGNORE` preserves existing state. (CF `c939881`)
- [x] 5.6.5 + 5.6.6 Integration tests `src/integration/wave-5.6-folder-seeding.test.ts`: empty-state-seeded, pre-populated-idempotent, IMAP-throws-handled, walker-upsert-path, duplicate-run-safe. **Deviation**: logger.warn spy simplified — pino child loggers hold their own reference and can't be intercepted via `vi.spyOn(logger, 'warn')`. Test validates no-throw + no-DB-mutation instead, which are the actual safety properties. TODO comment for folder-rename deferred. 338 → 344 passing. (CF `aaa32fe`)
- [x] 5.6.7 Deploy: rebuilt ingestor image + recreated container via `cd ~/containers/mailroom && env-vault env.vault -- docker compose build ingestor && ... up -d ingestor`. Post-deploy logs: 5 "proton_folder_state seeded" INFO lines + 5 IDLE + 5 CONDSTORE + reconcile scheduler. Zero errors. Final state: `SELECT COUNT(*) FROM proton_folder_state` = 305 rows (61 folders × 5 Proton accounts); Labels/Family present for every account.
- [ ] 5.6.8 **(Jeff-driven)** Live verify: apply any label to any test message in Proton web; within 5 min, `SELECT labels FROM message_labels WHERE message_id = <msg>` reflects it. (The existing test-message / Family label has already been healed via the migrate-mirror run that ran in parallel with this deploy — pick a different label/message to exercise the CONDSTORE-push path fresh.)
- [x] 5.6.9 `TD-MAIL-CONDSTORE-NONINBOX` CLOSED in `lode/tech-debt.md` with CF `aea0062` + `428e2f6` + `c939881`.
- [x] 5.6.10 `lode/infrastructure/mailroom-mirror.md` CONDSTORE section extended with "Folder-state seeding (Wave 5.6)" subsection + startup-wiring diagram refreshed with `seedFolderState` node and walker → CONDSTORE edge.

**Risks**:
- First CONDSTORE cycle per newly-seeded folder sees ALL messages as MODSEQ>0. For large folders (e.g. `All Mail` with 60k+ rows) this is one bulk fire. Additions are all `INSERT OR IGNORE`, storm-collapse handles bulk removals. Accepted one-time cost. If it bogs the ingestor for long enough that IDLE reconnect cycles drop, we'll see it in logs and can mitigate (e.g. initial seed to current HIGHESTMODSEQ instead, losing gap-heal).
- Proton bridge unavailable at startup → no seed, fall back to INBOX-only. Next ingestor restart re-tries; 04:00 reconcile self-heals via 5.6.4. Acceptable.

**Dependencies**:
- Requires Wave 5.5 landed (DONE). Without it, seeding produces empty label writes.

### Wave 5.7 — Replace CONDSTORE with UIDNEXT polling + recency-tiered reconcile

**Discovered 2026-04-24 during Wave 5.6 diagnostic.** The Proton bridge does not advertise the CONDSTORE IMAP capability at all (`c.capability.filter(CONDSTORE|QRESYNC|ENABLE) = []`). `client.status(folder, {highestModseq:true})` returns `{path, messages}` with no `highestModseq` field. `client.mailbox.highestModseq` after `getMailboxLock` is `undefined`. All three candidate API paths confirmed against live `jeff@jstone.pro` INBOX + `Labels/Family`.

Wave 2B's entire CONDSTORE-based incremental sync design (AC-S2) is **not achievable** with the current bridge. Wave 5.6 exposed this by populating `proton_folder_state` and forcing the code path to run; in practice every CONDSTORE poll sees `highestModseq=0`, skips the MODSEQ-advance, and stays at `last_modseq=0` forever. Polls run cleanly and do nothing.

**This wave**: replace CONDSTORE with per-folder `STATUS (MESSAGES UIDNEXT)` polling (Option B) + a recency-tiered reconcile that replaces the single 04:00 nightly walk with three cadences matched to how often changes are expected. Combined, this delivers sub-30-min propagation on recent mail without needing CONDSTORE, native Proton API, or a full hash layer.

**Execution model**: 1 Sonnet executor, serialized. ~300 LOC + tests. Same branch (`madison-read-power`) in both repos.

**Goal**: push-like latency for upstream-initiated changes (label applied, archive, move, new mail) on recent messages; weekly full catch-up for the long tail; zero CONDSTORE dependency.

**Acceptance criteria**:
- AC-5.7-1 `proton_folder_state.last_modseq` column replaced with `last_uidnext INTEGER` and `last_exists INTEGER`. Migration clears old MODSEQ data (it was all 0 anyway).
- AC-5.7-2 New `pollFolderUidnext(client, accountId, folder)` in `src/sync/proton-condstore.ts` (or renamed file) does `STATUS (MESSAGES UIDNEXT)`, compares against stored `last_uidnext` AND `last_exists`. New UIDs via `UID FETCH stored+1:*`. Expunges detected on EXISTS decrease via per-folder `UID SEARCH ALL` + set-diff vs `message_folder_uids`. Applies via existing `applyProtonUidAdded` / `applyProtonFolderMembershipChanges`. INBOX is skipped (IDLE handles it per 5.7.3a verification).
- AC-5.7-3 All dead CONDSTORE code removed (`checkModseqMonotonicity`, `MODSEQ_REGRESSION_SENTINEL`, `triggerFolderHydration`, unused `hydrate.ts` sentinel paths). Tests updated.
- AC-5.7-4 Three-tier reconcile replaces `startReconcileScheduler`:
  - **Hot**: INBOX fully + all-folders `SINCE <7d ago>`. Cadence: every 30 min.
  - **Warm**: all-folders `SINCE <90d ago>` (excluding hot range). Cadence: every 6 hours.
  - **Cold**: full historical walk (current nightly behavior). Cadence: weekly, Sunday 04:00 local.
- AC-5.7-5 `runFullHydration` accepts `{ sinceDate?: Date }` — pushes down `UID SEARCH SINCE <date>` into `proton-walker.ts` and `gmail-walker.ts`. Walkers yield only UIDs matching the filter. Existing full-walk call sites default to no filter.
- AC-5.7-6 UIDNEXT poll cadence configurable via env var `UIDNEXT_POLL_INTERVAL_MS` (default 600000 = 10 min). Recency reconcile cadences configurable via env vars; documented in `lode/infrastructure/mailroom-mirror.md`.
- AC-5.7-7 Integration tests: UIDNEXT poll catches new-UID + missing-UID; recency filter reduces walker output; hot tier catches label-apply within one cycle; AC-V-Family repro (apply Family label → mirror reflects within 30 min) is now a test fixture.

**Locked decisions**:

| Decision | Rationale |
|---|---|
| Drop CONDSTORE entirely from the code (not gate it behind a capability check) | Proton bridge doesn't support it; other IMAP servers that would support it aren't on the roadmap. Dead code is harmful. |
| Replace `last_modseq` with `last_uidnext` (drop MODSEQ semantics) | UIDNEXT is monotonic per-folder unless UIDVALIDITY resets; same invariant we actually need. |
| UIDVALIDITY reset (rare) → mark folder for re-walk (sentinel `last_uidnext=-1`) | Same pattern as old MODSEQ regression sentinel; well-understood. |
| Keep `proton_folder_state` seeding from Wave 5.6 (just store UIDNEXT instead of MODSEQ) | Seeding of folder names is still valuable. The bug was in the MODSEQ code, not the seed. |
| No content_hash / flags_hash layer | Content doesn't change (verified above); flags unneeded per Wave 4.5 decision. Strict surplus cost. |
| Hot tier includes INBOX fully, not just `SINCE 7d` | INBOX is small and always active — always reconcile fully. No point being clever. |
| Recency-reconcile uses existing `runFullHydration` with new `sinceDate` arg | One apply path; tests already cover it; just push filter down into walkers. |
| UIDNEXT poll interval default 10 min; hot reconcile 30 min | UIDNEXT is cheap enough for 10-min; hot reconcile is heavier so 30-min. Both configurable. |

**Scope order**:

- [x] 5.7.1 Dead CONDSTORE code removed from `src/sync/proton-condstore.ts`. Wave 5.6's `proton-folder-discovery.ts`, ingestor wire-in, and walker hookup kept. `checkModseqMonotonicity`, `MODSEQ_REGRESSION_SENTINEL`, MODSEQ-regression hydration branch, and CONDSTORE-specific tests removed. (CF `1dd3951`)
- [x] 5.7.2 Schema v4 → v5 migration: `proton_folder_state.last_modseq` dropped; `last_uidnext`, `last_exists`, `last_uidnext_checked_at` added. Rows preserved, MODSEQ values discarded. (CF `1dd3951`)
- [x] 5.7.3 `pollFolderUidnext` written, replacing `pollFolderCondstore`. STATUS (MESSAGES UIDNEXT) → UID FETCH for advances + UID SEARCH ALL + set-diff for EXISTS decreases; INBOX skipped; noop on no-delta. (CF `1dd3951`)
- [x] 5.7.3a **BUG FOUND + FIXED.** Wave 2B's IDLE handler in `src/sync/proton-idle.ts` subscribed to `'exists'` events only — never wired `'expunge'`. INBOX deletions were silently dropped; only nightly reconcile caught them. Fixed: `expunge` event now wired to `applyProtonFolderMembershipChanges`. Caveat: imapflow's expunge callback delivers SEQUENCE NUMBER (not UID — RFC 3501), so production runs use seqno as a best-effort UID; hot-tier reconcile (30 min, `sinceDate=7d`) provides authoritative cleanup. Capture as `TD-MAIL-IDLE-EXPUNGE-SEQNO` in tech-debt (5.7.9). (CF `4dba8b9`)
- [x] 5.7.4 `runFullHydration({ sinceDate })` option threaded through `proton-walker.ts` (uses `client.search({since})` → `UID SEARCH SINCE`) and `gmail-walker.ts` (uses `q: 'after:<yyyy-mm-dd>'`). Existing no-filter call sites unchanged. (CF `4dba8b9`)
- [x] 5.7.5 `src/reconcile/recency-scheduler.ts` created. Hot every 30 min (`sinceDate=7d`), warm every 6h (`sinceDate=90d`), cold weekly Sun 04:00 (full walk). Env var overrides for intervals. Overlap protection via `meta.reconcile_running` flag. Wired into `src/ingestor.ts` replacing `startReconcileScheduler`. (CF `4dba8b9`)
- [x] 5.7.6 Integration tests `src/integration/wave-5.7-uidnext-reconcile.test.ts` + updates to `migrate-mirror.test.ts`, `sync-hydrate-fallback.test.ts`, `wave-5.6-folder-seeding.test.ts`. 15 new test cases (UIDNEXT add path, UIDNEXT expunge path, no-op, INBOX skip, sinceDate walker Proton+Gmail, scheduler tiers, schema v4→v5 migration, IDLE expunge wiring). 5 CONDSTORE-specific tests deleted. Test total 342 → 357 passing, 2 skipped. (CF `8de101c`)
- [x] 5.7.7 Deploy 2026-04-24 12:13 UTC. Ingestor rebuilt + recreated. Schema v4→v5 migration ran at startup ("migrating v4 → v5" + "migration complete"). 5 IDLE + 5 UIDNEXT pollers + recency-scheduler started clean. Zero errors. `proton_folder_state` preserved at 305 rows with new column set.
- [~] 5.7.8 Live verify ATTEMPTED 2026-04-24 but EXPOSED Wave 5.7 data-loss bug. Hot reconcile on first fire blew away 99% of labels/folder_uids (59k messages flagged deleted_inferred). Hotfix in 3 commits: `6f2237e` (repro test) → `7539652` (scope delta to sinceDate) → `32a8682` (blast-guard). Ingestor redeployed with hotfix at 17:56 UTC, running stably. Live verify of UIDNEXT/IDLE-expunge/label-propagation deferred until Wave 5.8 write-through fixes land + restore completes. See `lode/plans/active/2026-04-wave-5.8-writethrough-correctness/`.
- [x] 5.7.9 Tech-debt entries added:
  - `TD-MAIL-BRIDGE-NO-CONDSTORE` OPEN — root-cause memory for why CONDSTORE is permanently off.
  - `TD-MAIL-IDLE-EXPUNGE-SEQNO` OPEN — seqno-based best-effort IDLE expunges, pending bridge QRESYNC/UIDPLUS support.
  - `TD-MAIL-PROTON-ALIAS-DOUBLE-POLL` OPEN — `pm.me`/`protonmail.com` alias double-poll.
  - `TD-MAIL-CONDSTORE-NONINBOX` retagged SUPERSEDED by `TD-MAIL-BRIDGE-NO-CONDSTORE`.
- [ ] 5.7.10 Graduate: `lode/infrastructure/mailroom-mirror.md` — rewrite sync architecture section (drop CONDSTORE, describe UIDNEXT polling + recency tiers); refresh startup diagram.

**Risks**:
- `UID SEARCH SINCE <date>` on large folders (`All Mail` with 30k messages) may return a large UID list for a 90d warm window. Mitigation: chunked FETCH, paginate if needed. Realistically for 7-day hot window it's small.
- **Expunge detection gated on `EXISTS` delta**: per-folder `UID SEARCH ALL` enumeration only fires when `EXISTS` decreased since last poll (message was removed). Compute `stored_uids - current_uids` to find expunged UIDs. For a hot cycle where nothing was archived or unlabeled, every folder is a single-STATUS no-op. UID-list responses are small (~KB even for 30k-message folders — just UIDs, not headers).
- **Jeff actively uses labels and archive** → expunge detection must run every hot cycle, not deferred to cold. The EXISTS-delta gating keeps the cost acceptable.
- **Wave 2B IDLE→EXPUNGE→DB path is unverified** (same risk class as the CONDSTORE bug we just found). 5.7.3a is a dedicated live-verify step before trusting that INBOX expunges propagate without hot-tier help.
- Interval clocks drift; two-phase lock needed to avoid overlapping hot+warm+cold runs. Mitigation: `meta` table lock column; skip-if-running pattern already established by current nightly scheduler.

**Dependencies**: Wave 5.6 CONDSTORE code is currently deployed + running; Wave 5.7 starts with removing/refactoring that. No new external dependencies.

## Errors

| Error | Resolution |
|---|---|

*(none yet)*

## Current status

**Waves 0–4.5 complete (2026-04-23).** Mirror foundation live + persona refreshed + lode graduated + read-tracking added. Day's commits: NC `b866105` `c6cdd3a` `7e366ca` `540e98e`; CF `f8f827e` `7afa3ab` `16886aa` `f6c8019` `ab6febd` `1e46257` `f398393` `86b9072` `57e631b` `a7baeed` `a26b590` `1ad00ee`. Mailroom 332 tests. Nanoclaw 334 tests. Live mirror: 60,166 messages, 192,080 label entries, 175 catalog entries, 51 inferred-deletes (within blast guard), schema_version=4, `read_at` column populated on demand. 15 inbox MCP tools live. Madison's session auto-invalidates on next spawn (Trawl-config-in-hash + Codex P1 NULL-hash-clear).

Mirror foundation live in production with full source coverage:
- 60,166 messages mirrored across 6 accounts (5 Proton + 1 Gmail)
- **192,080 label entries** (190,296 Proton folder memberships + 1,784 Gmail labels)
- 190,296 Proton (folder, uid) pairs in `message_folder_uids`
- **175 unique label entries catalogued** (147 Proton folders + 28 Gmail labels including system/CATEGORY/user)
- 51 inferred-delete flags (0.08% of total — within blast guard)
- 59,676 Proton rows backfilled with rfc822_message_id
- All 5 IDLE sessions + CONDSTORE pollers + reconcile scheduler running healthy
- Migration script self-audits with metric-vs-actual + per-source + ratio invariants; fails-fast on drift
- `tsc --noEmit` zero errors. Test suite: 307/309 (2 perf skipped). Nanoclaw 334/334.

Ready for Wave 5 (Jeff-driven verification) + Wave 5.5 (push-ingest parity — blocks AC-V3/V6 truth). Wave 5.5 added 2026-04-23 evening after discovering the push-ingest label gap during verification; bundles `TD-MAIL-PUSH-WATERMARK`. Brief: `wave-5.5-push-ingest-parity.md`. Execute Wave 5.5 first, then finish Wave 5.

### Codex Wave 2E findings (CLOSED — NC `7e366ca`)

- **P1 — Resume preserves rotation counters:** `setSession` now uses `INSERT … ON CONFLICT DO UPDATE` with conditional expressions; new session inserts stamp fresh `created_at`+`message_count=0`; same-session resume preserves `created_at` and increments `message_count`. Rotation gates (`sessionMaxAgeHours` / `sessionMaxMessages`) now actually trigger.
- **P1 — Pre-migration NULL-hash sessions get cleared:** the hash check distinguishes "no session row exists" (just stamp) from "row exists with NULL hash" (treat as stale pre-migration row → DELETE + log INFO). Structural session-staleness fix now applies to migrated sessions too.
- **P2 — Trawl config in hash:** `computeGroupMcpHash` appends Trawl `url`/`mode`/`allowedTools`/`allowedCategories`/`excludedTools` (sorted) to the SHA-256 input when `trawl.enabled === true`. Trawl URL/mode/allowlist changes now invalidate the session even when the server name is unchanged.

7 new tests added. Total nanoclaw tests: 324 → 334.

### Audit re-run awareness (CLOSED — CF `a26b590`)

Pre-migration count snapshot taken after schema verify, before any writes. Audit invariants now compare DELTAS (post − pre) against the script's reported metrics (which are also deltas). Per-account `adds_applied=0` check distinguishes first-migration (`prior_coverage === 0` → fail loudly) vs re-run idempotency (`prior_coverage > 0` → emit INFO `re-run idempotent` log + pass). Blast guard + Gmail label parity + reconcile_unknowns ratio + label_catalog/message_labels invariants retained but refined for delta semantics. 2 new integration tests for re-run idempotent path. Mailroom tests: 305 → 307 (+2 skipped perf).

**Execution strategy**: Wave 2 runs **5 Sonnet executors in parallel** (2A-E), dramatically compressing wall time. Wave 1 and Waves 3-4 are single-executor. Wave 5 is Jeff-driven verification. Opus orchestrator used only for cross-wave integration and review — minimizing Opus burn per Jeff's budget constraint.
