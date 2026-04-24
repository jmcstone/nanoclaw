# Wave 5.8 — Wave 2C write-through correctness

Branch: `madison-read-power` (continues off Wave 5.7 work)

## Goal

Fix the Wave 2C write-through tools (`add_label`, `archive`, `delete`, `label`/replace-set) so their local-DB mutations leave `message_labels`, `label_catalog`, and `message_folder_uids` in a consistent state. Today these tools punt cross-table cleanup to reconcile; reconcile has been broken in ways that let inconsistent state accumulate for weeks.

## Context this plan depends on

This session (2026-04-24) surfaced the bugs by running **live test transactions against the damaged production DB** after Wave 5.7 deploy + data-loss hotfix. The damaged DB and the hotfixed ingestor are both still in place when this plan starts. Restore (migrate-mirror) has NOT been run yet — Jeff chose to fix these bugs first so we restore once, cleanly.

Prior waves resolved in this same branch:
- **Wave 5.5** (DONE): extended `ingestMessage` to write `message_labels` + `label_catalog` + `message_folder_uids` at ingest time. This fixed the INGEST path but left the Wave 2C WRITE-THROUGH path unchanged.
- **Wave 5.6** (DONE): seeded `proton_folder_state` on ingestor startup + walker.
- **Wave 5.7** (DONE + INCIDENT + HOTFIX): replaced CONDSTORE (unsupported by Proton bridge) with UIDNEXT polling + three-tier recency reconcile. Hot-tier caused 99% data loss on first fire due to `sinceDate` vs full-DB-delta mismatch in `apply.ts`. Hotfixed (`32a8682`) by scoping DB-side delta to sinceDate window and adding blast-guard. Incident chain: `6f2237e` (repro test) → `7539652` (delta fix) → `32a8682` (blast-guard).

## Acceptance criteria

- **AC-5.8-1** `add_label` for Proton writes `message_labels` row with `label = "Labels/<name>"`, `source_id = "Labels/<name>"`, correct `canonical` via `canonicalizeLabel()`. Matches the shape produced by `ingestMessage` (Wave 5.5).
- **AC-5.8-2** `add_label` for Proton `INSERT OR IGNORE`s a `label_catalog` row for the new `(account_id, source_id)` pair.
- **AC-5.8-3** `archive` for Proton removes the `INBOX` row from `message_labels` in the same transaction as it sets `archived_at`. (`message_folder_uids` already removes the INBOX row correctly — retain that.) Optionally also inserts an `Archive` row in `message_labels` (Proton's archive MOVE destination is `Archive`). Decide during implementation whether inserting `Archive` is consistent with ingest semantics or should be left to sync.
- **AC-5.8-4** `delete` for Proton removes ALL folder rows from `message_labels` in the same transaction as it sets `deleted_at` (message is soft-deleted to Trash upstream; local DB reflects "message not in any folder anymore"). Keep `archived_at` alone (deletion is orthogonal to archive state).
- **AC-5.8-5** `label` (replace-set) for Proton writes rows matching the `Labels/<name>` shape (same fix as AC-5.8-1) AND maintains consistency with `message_folder_uids` — after replace-set, if the message was in INBOX (message_folder_uids[INBOX:N]), that row should remain (upstream INBOX membership unchanged by label-apply) AND `message_labels[INBOX]` should also remain (don't strip INBOX just because user provided only labels). Re-read Proton's `label` tool semantics to confirm.
- **AC-5.8-6** `remove_label` for Proton remains a documented no-op (v1 limitation per existing `lode/plans/active/2026-04-madison-read-power/tracker.md` AC). No change needed; just ensure the doc comment + MCP tool response still explain it clearly.
- **AC-5.8-7** All bugs have regression tests in `src/integration/wave-5.8-writethrough.test.ts`. Test pattern: stub MCP tool deps, invoke tool against in-memory DB with realistic seed state, assert full cross-table post-conditions (message_labels + label_catalog + message_folder_uids + archived_at/deleted_at/read_at).
- **AC-5.8-8** Live verification via the same MCP HTTP harness this session used (documented in `findings.md`). Re-test each tool on a non-damaged post-restore DB and confirm green.

## Locked decisions

| Decision | Rationale |
|---|---|
| Fix write-through BEFORE restore | Restore heals the damaged state; without the write-through fixes, the next Madison archive/add_label call after restore re-introduces inconsistency. Fix once, restore once. |
| Retain `remove_label`'s v1 no-op semantics | Proton IMAP can't easily untag a message from a label folder without knowing its UID in that folder — same UIDPLUS-absence issue that prevents adding Archive UID on archive. Don't paper over. Document + revisit when bridge adds UIDPLUS. |
| Match Wave 5.5 ingest shape, not invent a new one | `ingestMessage` for Proton writes `label="Labels/Foo"`, `source_id="Labels/Foo"`, `canonical=canonicalizeLabel("Labels/Foo")`. Write-through tools must produce identical rows so reconcile's INSERT OR IGNORE doesn't create duplicates. |
| Extend existing Wave 2C tool files (`src/mcp/tools/archive.ts` etc.), don't create new ones | They already have the right integration points (MCP deps, imap/gmail clients). Minimal surface change. |
| Add a shared helper `writeThroughLabelAdd(db, accountId, messageId, folderPath)` in `src/store/write-through.ts` | All three add-paths (add_label, apply_action's label add, label replace-set) share this; factor once. Mirror pattern from `ingestMessage`'s extension. |
| No content_hash/flags_hash layer | Per the earlier Wave 5.7 planning discussion — content doesn't change in email; flags unneeded per Wave 4.5 agent-side read tracking. Pure surplus cost. |

## Read first

**This session's findings doc**: `findings.md` in this plan directory — has full reproducer methodology (MCP HTTP harness via docker exec), before/after snapshots per tool, exact bug shapes.

**Wave 2C tool source**:
- `~/Projects/ConfigFiles/containers/mailroom/mailroom/src/mcp/tools/add_label.ts`
- `~/Projects/ConfigFiles/containers/mailroom/mailroom/src/mcp/tools/archive.ts`
- `~/Projects/ConfigFiles/containers/mailroom/mailroom/src/mcp/tools/delete.ts`
- `~/Projects/ConfigFiles/containers/mailroom/mailroom/src/mcp/tools/label.ts`
- `~/Projects/ConfigFiles/containers/mailroom/mailroom/src/mcp/tools/remove_label.ts`
- `~/Projects/ConfigFiles/containers/mailroom/mailroom/src/mcp/tools/apply_action.ts` (also needs same treatment — the unified "do these actions" tool)
- `~/Projects/ConfigFiles/containers/mailroom/mailroom/src/store/write-through.ts` — existing helper module, extend here.

**Wave 5.5 ingest-path reference shape** (the contract write-through must match):
- `~/Projects/ConfigFiles/containers/mailroom/mailroom/src/store/ingest.ts` — `ingestMessage` extension that writes all 3 tables transactionally with correct label shape.

**Canonicalization**:
- `~/Projects/ConfigFiles/containers/mailroom/mailroom/src/labels/canonicalize.ts` — `canonicalizeLabel()`. Must be used consistently.

**Existing Wave 2C tests**:
- `~/Projects/ConfigFiles/containers/mailroom/mailroom/src/mcp/tools/add_label.test.ts` and peers — reference for existing test scaffolding. These tests pass today despite the bugs — they don't assert the Wave 5.5-consistent shape.

**Live reproducer harness** (see findings.md for full script): use `docker exec mailroom-ingestor-1 node --input-type=module -e "..."` with an inline MCP HTTP client against `http://inbox-mcp:8080/mcp`. Pattern validated this session.

## Current state (2026-04-24 18:30 UTC snapshot)

**Ingestor running** with Wave 5.7 + data-loss hotfix code. Commits on mailroom `madison-read-power`:
- tip `32a8682` (blast-guard) ← current
- `7539652` (delta fix)
- `6f2237e` (repro test)
- `8de101c` `4dba8b9` `1dd3951` (Wave 5.7)
- `aaa32fe` `c939881` `428e2f6` `aea0062` (Wave 5.6)
- `44ed487` `3b186f0` `a92e8e8` `6324d2b` `6dfeba8` (Wave 5.5)

**DB damaged**: 99% of `message_labels` + `message_folder_uids` deleted during Wave 5.7 hot-tier first cycle. 59,663 messages flagged `deleted_inferred`. Specific row counts:
- messages: 60,203
- message_labels: 961
- message_folder_uids: 1,323
- label_catalog: 177
- deleted_inferred: 59,663

**Test labels applied** during this session's live tests (will need cleanup post-restore OR leave in Proton as cheap-to-remove clutter):
- `Test-Hotfix-A` on BeiGene message (jeff@thestonefamily.us, Indeed director jobs)
- `Test-Hotfix-B` on Uber points message (jeff@thestonefamily.us)
- `Test-Hotfix-D1`, `Test-Hotfix-D2` on NYC Financial Innovation Forum message (jeff@thestonefamily.us)
- Plus 2 test messages that were archived/deleted via test calls (Uber "40% off" archived; Amazon SES "crediting Points" deleted)

**Waiting on**: Jeff's next session. Restore is pending. Fixes in this plan come first.

## Phases / Waves

### Phase 1 — Write-through helper consolidation

- [ ] 5.8.1 Inspect `src/store/write-through.ts`. If exists, extend it. If not, create it. Add exported helpers:
  - `writeThroughAddLabel(db, accountId, messageId, folderPath)` — INSERT OR IGNORE into `message_labels` with `label=folderPath`, `source_id=folderPath`, `canonical=canonicalizeLabel(folderPath)`; INSERT OR IGNORE into `label_catalog` with matching fields and system=0.
  - `writeThroughRemoveLabel(db, accountId, messageId, folderPath)` — DELETE from `message_labels` WHERE message_id=? AND label=?.
  - `writeThroughSetLabels(db, accountId, messageId, folderPaths)` — replace-set: DELETE non-system rows for this message from message_labels, then batch INSERT OR IGNORE.
  - `writeThroughArchive(db, messageId)` — set archived_at=NOW, DELETE message_labels[INBOX], DELETE message_folder_uids[INBOX]. Optionally INSERT message_labels[Archive] if we decide to match ingest semantics.
  - `writeThroughDelete(db, messageId)` — set deleted_at=NOW, DELETE ALL message_labels for this message, DELETE ALL message_folder_uids for this message.
  - All helpers synchronous within a transaction; callers wrap with `db.transaction(...)`.

### Phase 2 — Tool rewrites

Each tool in `src/mcp/tools/` has a block that writes to DB after IMAP success. Replace those inline writes with calls to the helpers.

- [ ] 5.8.2 `add_label.ts` — after successful Proton COPY: call `writeThroughAddLabel(db, accountId, messageId, 'Labels/' + labelName)`. Update Gmail path to use `writeThroughAddLabel` with the Gmail labelId as folderPath (or a Gmail-specific variant).
- [ ] 5.8.3 `archive.ts` — after successful Proton MOVE from INBOX: call `writeThroughArchive(db, messageId)`. Add archive-destination label if deciding per AC-5.8-3.
- [ ] 5.8.4 `delete.ts` — after successful Proton MOVE to Trash: call `writeThroughDelete(db, messageId)`.
- [ ] 5.8.5 `label.ts` (replace-set) — after successful Proton COPY operations: call `writeThroughSetLabels(db, accountId, messageId, folderPathsList)`. Confirm that `label` doesn't unmount from INBOX (since in Proton, label apply is COPY to Labels/, not MOVE — INBOX membership unchanged).
- [ ] 5.8.6 `apply_action.ts` — this is the unified-actions path used by rule engine and MCP calls. Audit every branch that modifies labels/archive/delete and route through the same helpers. Don't skip — this is a heavily-used path.
- [ ] 5.8.7 `remove_label.ts` — no-op path for Proton already documented; just ensure the existing `labels_remove_skipped` response is preserved. Audit Gmail path for same correctness concerns (DELETE message_labels row on successful Gmail label removal; don't leave stale).

### Phase 3 — Tests

- [ ] 5.8.8 `src/integration/wave-5.8-writethrough.test.ts`: one describe block per tool. Each test:
  1. Initializes an in-memory DB with seed state (1-2 messages with realistic rows across all 3 tables).
  2. Stubs the IMAP/Gmail deps with minimal fakes (return success from the IMAP op so the write-through runs).
  3. Invokes the tool function directly (not through MCP — unit-level).
  4. Asserts post-state on ALL affected tables, NOT just the primary column/row.

  Must-have assertions:
  - add_label: message_labels has new row with `label="Labels/<name>"`, `source_id="Labels/<name>"`, `canonical=canonicalizeLabel(...)`. label_catalog has matching row.
  - archive: message_labels[INBOX] GONE, message_folder_uids[INBOX] gone, archived_at set.
  - delete: message_labels all rows GONE, message_folder_uids all rows gone, deleted_at set.
  - label: message_labels rows = exactly the provided set (correct shape); INBOX folder_uid preserved; INBOX label... (decide — probably preserved since Proton label-apply doesn't un-INBOX the message).
  - remove_label (Proton): no DB change, response shape matches v1 doc.

- [ ] 5.8.9 Add existing add_label.test.ts / archive.test.ts / etc. updates: change their assertions to require the correct shape (currently they pass because they don't assert the shape). These pre-existing tests are **false negatives** — they "succeeded" for years while the underlying bug existed.

### Phase 4 — Reconcile idempotency check

- [ ] 5.8.10 Add one integration test asserting: when a write-through tool runs (producing the correct-shape rows), and then reconcile runs on the same folder, reconcile is a NO-OP (adds_applied=0, removes_applied=0). This catches future regressions where write-through + reconcile might duplicate or double-toggle rows. Run against a seeded DB, stub the walker to return upstream state that matches what write-through just wrote.

### Phase 5 — Live test harness (resurrect and use)

- [ ] 5.8.11 Save the MCP HTTP test harness to `scripts/test-writethrough.ts` (from the inline script in findings.md). Accept `--tool <name> --args <json> --target <message_id>`; print before/after diffs for the 3 tables. Turns the ad-hoc session pattern into a repeatable CLI. Use post-restore for live verification of each fix.

### Phase 6 — Deploy + restore

- [ ] 5.8.12 Rebuild ingestor with write-through fixes. `env-vault env.vault -- docker compose build ingestor`.
- [ ] 5.8.13 Run live test harness (5.8.11) for each tool against the CURRENT (still-damaged) DB. Verify fixes work on the broken DB.
- [ ] 5.8.14 Recreate ingestor. Run migrate-mirror via `docker compose run --rm ingestor npx tsx scripts/migrate-mirror.ts` to restore the ~190k deleted label/folder_uid rows and clear deleted_inferred.
- [ ] 5.8.15 Re-run live test harness against the restored DB. Verify clean.
- [ ] 5.8.16 Close Wave 5.7 in its tracker (add reference to Wave 5.8 as the follow-up), move 5.7 plan to `lode/plans/complete/` if fully done.
- [ ] 5.8.17 Graduate: update `lode/infrastructure/mailroom-mirror.md` with the write-through/reconcile invariant ("write-through rows must match the shape ingest produces, so reconcile is a no-op under steady state"). Add new `TD-MAIL-WRITETHROUGH-CORRECTNESS` CLOSED entry in `lode/tech-debt.md` with commit hash.

## Errors

| Error | Resolution |
|---|---|

*(none yet)*

## Current status

Plan drafted 2026-04-24 18:30 UTC. Awaiting next session for execution. Live reproducer harness validated; bugs are reproducible on-demand against current damaged DB. Ingestor running stably with hotfix code; no further data loss risk (blast-guard is armed). Restore intentionally deferred until write-through fixes land.

Jeff's stated preference: **fix these bugs before restore** so we restore to a clean codebase that doesn't immediately re-introduce inconsistency.
