# Push-Ingest Label Gap

**Discovered**: 2026-04-23 evening, during Wave 5 verification of madison-read-power plan.
**Severity**: P1 — silently corrupts the mirror's label coverage; user-facing (Madison undercounts inbox by ~30% on push-ingest days).
**Repo**: `~/Projects/ConfigFiles/containers/mailroom/mailroom/`
**Branch**: `madison-read-power`

## Symptom

Jeff asked Madison "what's in my Proton inbox today?" Madison correctly used `mcp__messages__query({source:'protonmail', labels:['INBOX'], received_after:'2026-04-23T00:00:00.000Z'})` and returned 8 messages. Jeff sees 15 in his actual Proton inbox UI. Discrepancy of 7.

## Diagnostic numbers (run today)

```
SELECT COUNT(*) FROM messages WHERE source='protonmail' AND received_at >= today AND deleted_at IS NULL AND direction='received';
-- 21 (true total Proton received today)

SELECT COUNT(DISTINCT m.message_id) FROM messages m JOIN message_labels ml ON m.message_id=ml.message_id WHERE m.source='protonmail' AND m.received_at >= today AND m.deleted_at IS NULL AND m.direction='received';
-- 15 (with ANY label entry)

SELECT COUNT(DISTINCT m.message_id) FROM messages m JOIN message_labels ml ON m.message_id=ml.message_id WHERE ... AND ml.label='INBOX';
-- 8 (with INBOX label specifically — Madison's correct count)
```

So **6 of today's Proton messages have ZERO label entries** in `message_labels`, and 7 more have non-INBOX labels (likely auto-archived after ingest by Wave 2C write-through into Archive folder, which IS getting written correctly).

The 6 zero-label-entry messages today (subjects):
- Saab director-software-engineering jobs
- New director Job Matches
- Hull polarization Trek question
- lazerqi mention on NanoClaw
- Miami University Foundation
- BookBub best new popular nonfiction

## Root cause hypothesis

The Wave 2B incremental sync workers (`src/sync/proton-events.ts` for Proton IDLE+CONDSTORE; `src/sync/gmail-events.ts` for Gmail history.list) consume upstream events and apply them to the local DB. Their event applier:

- ✅ Inserts the `messages` row (or this work happens via the still-running legacy `proton/poller.ts` path; need to verify which path actually ingests today)
- ❌ Does NOT insert into `message_labels` for the source folder/labelId

Compare to:
- **Migration hydration** (Wave 3.6 `src/reconcile/apply.ts` + `applyLabelDelta`): correctly populates `message_labels` for every walker triple. This is why 190k historical entries are present.
- **Wave 2C write-through** (when Madison calls `add_label` / `archive`): correctly populates label entries via `src/store/write-through.ts` writeLabelAdded, etc. This is why archived-today messages DO have label entries — just not INBOX.

So the gap is the **fresh-arrival ingest path** (whether via `proton/poller.ts` legacy poll OR Wave 2B IDLE/CONDSTORE event applier). The new message lands in `messages` but the source folder it arrived in (e.g., Proton's INBOX) is never recorded as a label entry.

## What to verify before fixing

**5.5.1 VERIFIED 2026-04-23 evening** (findings in tracker + progress.md):

1. **Both legacy pollers are primary inserters today.** `proton/poller.ts:211` and `gmail/poller.ts:269` call `ingestMessage()`. In last 3h of ingestor logs: 3× "Protonmail message classified" + 5× "Gmail message classified". These are the sources of today's 6 zero-label Proton rows. Wave 2B workers (idle, condstore, history) are up but emit zero `applyProtonUidAdded` / `applyLabelsAdded` log lines — they're detectors on existing rows, not inserters.

2. **`ingestMessage` in `src/store/ingest.ts` does NOT write labels.** It inserts into `messages` + `threads` + `senders` + `accounts`. It never touches `message_labels`, `label_catalog`, or `message_folder_uids`. Wave 2C added draft/spam skip + direction + archived_at writes but stopped short of label writes.

3. **Wave 2B event appliers are partially correct but will bite when they become primary.** `applyProtonUidAdded` (proton-events.ts:154) only writes `message_folder_uids`; needs to also write `message_labels` + `label_catalog`. `applyLabelsAdded` in gmail-events.ts writes labels per its name but confirm `label_catalog` `INSERT OR IGNORE` coverage.

**Implication for fix shape**: primary work is in `ingestMessage` + the two poller call sites, not in the sync event appliers. Event-applier hardening is still in scope but secondary.

## Proposed fix shape (updated post-5.5.1)

**Primary fix: extend `ingestMessage()` itself.** Both pollers already call it; centralize the label-write in one place.

1. `src/store/ingest.ts` — add optional params to `MessageIngestInput`:
   ```ts
   labels?: string[];                             // source-native label/folder ids
   folder_uid?: { folder: string; uid: number }; // Proton only
   ```
   Inside the existing `db.transaction` wrapper, after the `messages` insert, iterate `labels`:
   - `INSERT OR IGNORE INTO label_catalog (account_id, label, canonical, source_id, system) VALUES (?, ?, ?, ?, ?)` — `canonical` from `canonicalizeLabel()`, `system` derived (Gmail system labels: INBOX/SENT/DRAFT/SPAM/TRASH/UNREAD/IMPORTANT/STARRED/CATEGORY_*).
   - `INSERT OR IGNORE INTO message_labels (message_id, label, canonical, source_id) VALUES (?, ?, ?, ?)`.
   If `folder_uid`: `INSERT OR IGNORE INTO message_folder_uids (message_id, folder, uid)`.
   Wrap with `withSqliteBusy(...)` from `src/store/sqlite-busy.ts`.

2. `src/proton/poller.ts:211` — pass `labels: [sourceFolder]` and `folder_uid: { folder: sourceFolder, uid }`. `sourceFolder` is the folder being polled (typically `INBOX`); already in scope at the call site.

3. `src/gmail/poller.ts:269` — pass `labels: fullMessage.labelIds ?? []`. Gmail's per-message fetch already returns labelIds; no new API call.

4. Watermark bump: at the end of `ingestMessage` when `inserted === true`, `UPDATE accounts SET watermark_received_at = MAX(watermark_received_at, ?) WHERE account_id = ?`. Closes `TD-MAIL-PUSH-WATERMARK` in the same change.

**Secondary fix: Wave 2B event-applier hardening** (so they're correct when/if they become primary).

- `src/sync/proton-events.ts:applyProtonUidAdded` — in addition to `upsertFolderUid`, also write `label_catalog` + `message_labels` entries for the folder.
- `src/sync/gmail-events.ts:applyLabelsAdded` — confirm it does `INSERT OR IGNORE INTO label_catalog` when a new labelId is first seen.

**Audit tool (5.5.7)** — `mcp__inbox__audit_label_coverage({since_hours?})` registered read-only on inbox-mcp, returns `{missing_label_count: number, sample_message_ids: string[]}`. Uses:
```sql
SELECT message_id FROM messages m
WHERE source IN ('protonmail','gmail')
  AND deleted_at IS NULL
  AND received_at > ?
  AND NOT EXISTS (SELECT 1 FROM message_labels WHERE message_id = m.message_id)
LIMIT 50;
```

## Audit invariant to add

Like the Wave 3.5/3.6 self-audit but as a runtime/health check: periodically (or in a test) assert:
```
SELECT COUNT(*) FROM messages m WHERE NOT EXISTS (SELECT 1 FROM message_labels WHERE message_id=m.message_id) AND source IN ('protonmail','gmail') AND deleted_at IS NULL AND received_at > '<today_start>'
```
should be **0**. If non-zero, push-ingest is silently dropping label entries again. Could be a Madison-callable diagnostic tool, or a periodic logger metric.

## Test to write before fixing

Integration test that simulates a Wave 2B IDLE event for a new Proton message arriving in INBOX, runs the event applier, and asserts:
- `messages` has the row ✓
- `message_labels` has at least one entry for that message_id with `label='INBOX'` ✓
- `label_catalog` has the (account_id, source_id) pair ✓

Currently the existing 2B tests probably assert only the `messages` insert.

## Related

- `lode/tech-debt.md` `TD-MAIL-PUSH-WATERMARK` — sibling bug; push-ingest also doesn't bump per-account watermark. Same conceptual root cause: "Wave 2B sync workers don't fully replicate what the migration's hydration path does." Both should likely be fixed together — one focused executor, ~60 LOC + tests.
- `lode/lessons.md` "Migration scripts must self-audit the DB state against their own reported metrics" — applies here too at the runtime level (audit invariant on push-ingest).
- Madison interaction transcript: `~/containers/data/NanoClaw/data/sessions/telegram_inbox/.claude/projects/-workspace-group/397ea19a-c76a-461d-8f1c-1548d68a5002.jsonl` — the moment of discovery; her query was correct, the data was wrong.

## Resume sequence

1. Read this file + the related TD-MAIL-PUSH-WATERMARK entry.
2. Verify the diagnosis with current SQL counts (numbers above are from one moment in time; expected to grow until fix lands).
3. Inspect the actual code paths: `src/store/ingest.ts`, `src/sync/proton-events.ts`, `src/sync/gmail-events.ts`, `src/proton/poller.ts`. Confirm where the gap is.
4. Spawn focused Sonnet executor with the proposed-fix-shape brief above + tests + audit invariant. Likely fold both this AND `TD-MAIL-PUSH-WATERMARK` into one executor since they're the same conceptual bug.
5. Deploy: ingestor only (label-write changes touch sync workers in `src/sync/` + possibly `src/store/ingest.ts`). Inbox-mcp doesn't need rebuild unless `src/store/` changes.
6. Verify via: send Madison a test message, ingest fires, check `message_labels` has the new entry within seconds. AC-V3-style observation works.

## Out of context but worth flagging when picked up

- AC-V2 was still pending when context filled — the phantom Trawl tool (`ac_v2_phantom_tool`) is still in `telegram_inbox` group config awaiting a Madison container recycle to fire the auto-clear. Should be reverted if not already (see handover doc `lode/tmp/handover-2026-04-23-evening.md` for the revert command).
- The Gmail `accounts` row analysis showed only `gmail:jeff@americanvoxpop.com` — but Jeff has Proton aliases that look like `jeff@jstone.pro` (same address as a Gmail-labeled row in earlier sanity output). Worth one more sanity pass on accounts-table cleanliness.
