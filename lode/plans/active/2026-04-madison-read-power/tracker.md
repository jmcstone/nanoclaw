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

- [ ] 0.1 `mail-push-redesign` Phases 9.1–9.6 complete
- [ ] 0.2 Spin `madison-read-power` branch off `mail-push-redesign` in nanoclaw
- [ ] 0.3 Spin `madison-read-power` branch in ConfigFiles mailroom

### Wave 1 — Schema foundation (single agent; blocks Wave 2)

**Execution model: 1 Sonnet executor, serialized.**

- [ ] 1.1 Mailroom schema migration: `rfc822_message_id`, `direction`, `archived_at`, `deleted_at`, `deleted_inferred`, `message_labels`, `message_folder_uids`, `label_catalog`, `label_map`, `proton_folder_state`. Indexes on canonical forms, direction+archived, rfc822.
- [ ] 1.2 Startup guard in `db.ts`: refuse reinit on decrypt failure.
- [ ] 1.3 Canonicalization helper `src/labels/canonicalize.ts` + unit tests (edge cases: Labels/ prefix, ZW chars, unicode case).
- [ ] 1.4 `accounts` table gains `last_history_id`, `last_history_refresh_at` (Gmail). `proton_folder_state` table for MODSEQ + IDLE state.
- [ ] 1.5 Migration fails fast if run against old schema incompatibly.

### Wave 2 — Parallel implementation (5 concurrent agents)

**Execution model: 5 Sonnet executors in parallel, one per workstream. Orchestrator merges/coordinates.**

**2A: Hydration/reconcile pipeline** (mailroom)
- [ ] 2A.1 Proton folder walker: per-folder `UID FETCH 1:* (BODY.PEEK[HEADER.FIELDS (MESSAGE-ID)])`
- [ ] 2A.2 Gmail walker: per-label `messages.list` → `messages.get(format='metadata', metadataHeaders:['Message-ID'])` batched
- [ ] 2A.3 In-memory delta builder: `(adds, removes, unknowns)` per source
- [ ] 2A.4 Apply phase: adds via `INSERT OR IGNORE`; removes re-verify upstream before delete
- [ ] 2A.5 Reconcile scheduler (node-cron 04:00 local; skip if run in last 20h)
- [ ] 2A.6 Metrics emission (prom-format)
- [ ] 2A.7 Tests: happy path, MODSEQ regression, race with write-through, inferred-delete, label-deletion-storm

**2B: Incremental sync worker** (mailroom)
- [ ] 2B.1 Gmail `history.list` handler per account with event dispatch (`messagesAdded/Deleted/labelsAdded/Removed`)
- [ ] 2B.2 404 handler → trigger per-account hydration, resume incremental
- [ ] 2B.3 Daily heartbeat ping
- [ ] 2B.4 Proton IDLE on INBOX with auto re-IDLE every 29 min
- [ ] 2B.5 NOOP watchdog (every 5 min); reconnect on failure
- [ ] 2B.6 CONDSTORE MODSEQ poller per folder
- [ ] 2B.7 `HIGHESTMODSEQ` monotonicity check on reconnect; regression → folder hydration
- [ ] 2B.8 Event-to-DB applier: `INSERT/DELETE message_labels`, `UPDATE messages.archived_at/deleted_at`
- [ ] 2B.9 Tests: history expiry, MODSEQ regression, IDLE silent death, storm pagination, out-of-order events

**2C: Write-through refactor** (mailroom)
- [ ] 2C.1 Transactional local-DB update in `apply_action.ts` after upstream success
- [ ] 2C.2 Same for `archive`, `add_label`, `remove_label`, `label`, `delete`
- [ ] 2C.3 Replace per-write IMAP search in `apply_action.ts:162-184` with `message_folder_uids` lookup
- [ ] 2C.4 Remove "v1 limitation" comment at `apply_action.ts:182`; verify Labels/*-only messages are now reachable
- [ ] 2C.5 Rules engine `src/rules/apply/{proton,gmail}.ts`: transactional local write in same logical unit as upstream action
- [ ] 2C.6 Ingest path: skip drafts (Gmail `DRAFT` label / Proton `Drafts` folder), skip spam (Gmail `SPAM` / Proton `Spam` folder), populate `direction` from source state
- [ ] 2C.7 `SQLITE_BUSY` retry (3x, 50/100/200ms) in batch tools
- [ ] 2C.8 Tests: per-tool write-through, busy retry, Labels-only message reachability, rules-engine transactional integrity

**2D: Query tool + read-tool defaults** (mailroom)
- [ ] 2D.1 `src/store/types.ts` — `QueryArgs`, `QueryResult`
- [ ] 2D.2 `src/store/queries.ts` — `queryMessages()` with dynamic parameterized SQL builder
- [ ] 2D.3 `aggregateMessages()` for grouped count
- [ ] 2D.4 `canonical_label` expansion via `label_map` (JOIN at query time)
- [ ] 2D.5 `src/mcp/tools/query.ts` MCP wrapper; registered in `src/mcp/server.ts`
- [ ] 2D.6 Update `search`, `recent` to apply default `direction='received' AND deleted_at IS NULL` filter (opt-out via `include_sent`/`include_deleted`)
- [ ] 2D.7 `thread` continues ignoring direction filter
- [ ] 2D.8 Tests: each filter alone, combinations, regex safety, limit cap, canonical_label expansion
- [ ] 2D.9 Perf: 100k-message FTS count-by-subject <500ms

**2E: Session toolset-hash** (nanoclaw — independent of mailroom; parallel from start)
- [ ] 2E.1 `sessions` table gains `tool_list_hash TEXT` (migration)
- [ ] 2E.2 `getSessionToolHash()` / `setSessionToolHash()` helpers in `src/db.ts`
- [ ] 2E.3 `src/mcp-tool-discovery.ts`: fetch MCP tool list, return sorted-name SHA-256
- [ ] 2E.4 Wire hash check into `src/index.ts:345-375` rotation
- [ ] 2E.5 Tests: stability, change detection, on-mismatch clear + log

### Wave 3 — Integration + migration (single agent, after Wave 2 merges)

**Execution model: 1 Sonnet executor, serialized.**

- [ ] 3.1 Migration orchestrator script: schema → purge drafts+spam → Proton rfc822 UPDATE → full hydration → metrics report
- [ ] 3.2 Dry-run mode reports changes without applying
- [ ] 3.3 Integration tests: ingest → hydrate → query end-to-end; write-through + sync round-trip; reconcile correctness
- [ ] 3.4 Deploy: rebuild mailroom containers (env-vault prefix!); rebuild agent container; restart nanoclaw

### Wave 4 — Docs + persona (single agent)

**Execution model: 1 Sonnet executor.**

- [ ] 4.1 Madison `CLAUDE.md`: `mcp__inbox__query` docs (signature, 5 example patterns); remove stale tool references; add session-stale instruction; add verify-before-quoting-a-mem rule
- [ ] 4.2 a-mem cleanup: scan telegram_inbox a-mem for "Known gaps" / "limitation" / "broken" notes ≥ 2026-04-22; delete obsolete or append `RESOLVED <date>` tags
- [ ] 4.3 Graduate `findings.md` content to `lode/architecture/madison-pipeline.md` (mirror architecture, session-hash pattern) and new `lode/infrastructure/mailroom-mirror.md` (sync details)
- [ ] 4.4 `lode/practices.md`: deploy-checklist subsection, counter-note pattern
- [ ] 4.5 `lode/infrastructure/mailroom-rules.md`: env-vault deploy requirement

### Wave 5 — Verify + graduate (Jeff-driven)

- [ ] 5.1 Clear Madison's session; fresh spawn via container rebuild
- [ ] 5.2 AC-V1: Bob-late-payment `query` with group_by=subject + count=true returns grouped counts in one call
- [ ] 5.3 AC-V2: add a placeholder MCP tool, restart MCP → next Madison spawn invalidates session (check INFO log)
- [ ] 5.4 AC-V3: archive a test message in Gmail web → `SELECT archived_at FROM messages WHERE ...` within 5 min
- [ ] 5.5 AC-V4: rename a Gmail label → verify `label_catalog.label` updates within 24h; all existing `message_labels` rows still queryable under new name
- [ ] 5.6 AC-V5: Madison `add_label` → immediate `query({labels:[X]})` returns the message
- [ ] 5.7 AC-V6: "are Proton watermarks working?" — Madison doesn't cite NaN issue
- [ ] 5.8 AC-V7: `npm test` green in nanoclaw; mailroom tests green
- [ ] 5.9 Move plan to `lode/plans/complete/`

## Errors

| Error | Resolution |
|---|---|

*(none yet)*

## Current status

**Discussion phase complete.** All 9 architecture-group decisions locked (identity/dedup, label semantics, message classes, sync robustness, backfill/hydration, concurrency, operational, plus the original AC-3/4/6/7). Tracker rewritten 2026-04-22 evening. Awaiting `mail-push-redesign` Phases 9.1–9.6 to complete, then branch-spin + Wave 0.

**Execution strategy**: Wave 2 runs **5 Sonnet executors in parallel** (2A-E), dramatically compressing wall time. Wave 1 and Waves 3-4 are single-executor. Wave 5 is Jeff-driven verification. Opus orchestrator used only for cross-wave integration and review — minimizing Opus burn per Jeff's budget constraint.
