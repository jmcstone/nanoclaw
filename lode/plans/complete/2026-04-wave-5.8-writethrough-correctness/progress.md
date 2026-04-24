# Progress — Wave 5.8 write-through correctness

## 2026-04-24 late afternoon — plan drafted from live test session

### What happened this session

Wave 5.7 deployed at 12:13 UTC. First hot-tier reconcile fired at 12:43 and caused catastrophic data loss (99% of `message_labels` + `message_folder_uids` rows deleted; 59,611 messages flagged `deleted_inferred`). Root cause: `sinceDate`-scoped walker output + full-DB delta computation in `apply.ts` → every message outside the 7-day window was treated as "missing upstream".

Ingestor stopped, damage assessed, hotfix scoped/executed/tested:
- Commit `6f2237e`: regression test that reproduces the bug (failed on pre-fix code, passed on post-fix).
- Commit `7539652`: fix — `applyLabelDelta` / `applyFolderUidDelta` / `applyInferredDeletes` accept optional `sinceDate?`; when set, DB-side candidate set is filtered to match the walker's window.
- Commit `32a8682`: blast-guard — `runWithBlastGuard()` wraps each recency tier; trips and `process.exit(1)` if ml/mfu drop >50% OR di grows by >50% of total messages in a single run.

Tests: 357 → 364 passing. `tsc` clean.

Ingestor rebuilt with hotfix + restarted at 17:56 UTC. Running stably since. Next hot reconcile cycle would fire at ~18:26 — safe with hotfix + blast-guard.

### Why Wave 5.8 exists

Jeff proposed: "use the damaged DB as a test environment — run critical transactions through the tools, see what breaks, restore afterwards." Live-tested Wave 2C write-through tools via MCP HTTP client over `docker exec`. Five bugs surfaced (see `findings.md` for full reproducers):

1. **B1**: `add_label` writes wrong shape (no `Labels/` prefix, `source_id=null`, missing `label_catalog` entry). HIGH — breaks Madison's own label queries.
2. **B2**: `archive` leaves stale `INBOX` in `message_labels`. HIGH — default queries return archived messages as inbox items.
3. **B3**: `delete` leaves all stale labels in `message_labels`. HIGH — deleted messages appear in any label query.
4. **B4**: `label` (replace-set) produces cross-table divergence: `message_labels` removes INBOX but `message_folder_uids` keeps it. HIGH — upstream says in-INBOX, local says not-in-INBOX.
5. **N1** (not a bug): `remove_label` Proton path is a documented v1 no-op.

All of these are pre-existing Wave 2C latent bugs — not regressions from Wave 5.5/5.6/5.7. They persisted because sync was supposed to clean up behind them, and sync had multiple broken paths (CONDSTORE absent, hot reconcile buggy).

Jeff's preference: **fix these bugs before restore**, so we restore to a codebase that doesn't immediately re-introduce inconsistency.

### Current state at session end

- **DB damaged**: `messages=60,203`, `message_labels=961`, `message_folder_uids=1,323`, `label_catalog=177`, `deleted_inferred=59,663`.
- **Ingestor running** with Wave 5.7 hotfix code (tip: `32a8682`). Hot reconcile safe (blast-guard armed).
- **Test labels applied** during session: `Test-Hotfix-A` on BeiGene message, `Test-Hotfix-B` on Amazon SES points, `Test-Hotfix-D1/D2` on NYC Financial Forum message. Target messages also archived/deleted during testing.
- **Restore pending** (`migrate-mirror.ts` full walk) until Wave 5.8 fixes land.

### What the next session should do

1. **Read `tracker.md` in this plan dir** — it has goal, ACs, locked decisions, and 17 sub-tasks organized into 6 phases.
2. **Read `findings.md`** for the full reproducer harness + bug details. The MCP HTTP client pattern in there is reusable (and will graduate to `scripts/test-writethrough.ts` in Phase 5).
3. **Execute Phase 1 (write-through helper consolidation)** first — single new/extended file (`src/store/write-through.ts`) that gives tool rewrites a clean API to call.
4. **Phases 2 + 3** rewrite each tool to use the helper + add regression tests that assert full cross-table post-conditions.
5. **Phase 6 (deploy + restore)** is the final step — deploy fixed image, run live test harness, run migrate-mirror to restore the damaged DB, verify clean.

Estimated executor scope: ~400-500 LOC + ~15-20 new tests. Single Sonnet executor should handle Phases 1-4 in one pass.

## 2026-04-24 Wave 1 — helper module landed

- **5.8.1** DONE — mailroom commit `121b8e4` extends `src/store/write-through.ts` with `writeThroughAddLabel/RemoveLabel/SetLabels/Archive/Delete`. All five synchronous, caller owns transaction, shapes match `ingestMessage`.
- **Executor findings** (inform Phase 2 rewrites):
  - INBOX stored as `label="INBOX"` (no `Labels/` prefix). `writeThroughArchive` filters by `label='INBOX'` and `folder='INBOX'`.
  - `writeThroughSetLabels` deletes only `label LIKE 'Labels/%'` — preserves INBOX and other system rows. This is the Bug B4 fix (Proton label-apply is COPY, doesn't un-INBOX).
  - `writeThroughRemoveLabel` signature carries unused `_accountId` for symmetry with `writeThroughAddLabel`.
  - Archive-destination row insertion deferred: `TODO(5.8-3)` in helper. Task 5.8.3 must decide whether to call `writeThroughAddLabel(db, accountId, messageId, 'Archive')` after `writeThroughArchive`.
  - `label_catalog` PK confirmed `(account_id, source_id)`; `source_id=folderPath` makes `INSERT OR IGNORE` idempotent.
- Build + tests green before commit.

## 2026-04-24 Wave 2 — 6 tools rewritten in parallel

All 6 tool rewrites succeeded on first pass. Commits (all on mailroom `madison-read-power`):

- **5.8.2** `3e55260` — `add_label.ts` uses `writeThroughAddLabel` for Proton (`Labels/<name>`) and Gmail (plain label name). Single transaction wraps all labels for a message.
- **5.8.3** `b4aeec8` — `archive.ts` uses `writeThroughArchive` + `writeThroughAddLabel('Archive')`. **Archive-row decision: YES** — evidence from `ingest.ts:292-296` shows ingest writes `label='Archive'` for Proton messages in the Archive folder. Also minor edit to `write-through.ts` to update the TODO comment (decision now made at call site).
- **5.8.4** `014ef53` — `delete.ts` uses `writeThroughDelete` for both Proton and Gmail; same final state for both paths. Commit also touches `delete.test.ts`.
- **5.8.5** `672e893` — `label.ts` uses `writeThroughSetLabels` for Proton. Gmail `writeLabelSet` call removed entirely (redundant — `applyGmailActions` already calls `writeLabelAdded`/`writeLabelRemoved` per delta). **Confirmed old code unconditionally stripped INBOX** — pre-existing bug beyond B4's cross-table scope.
- **5.8.6** `1b34b81` — `apply_action.ts` routes all 6 branches (label-add P/G, label-remove P no-op / G, archive P/G) through helpers. Entire per-message side-effect block wrapped in single `db.transaction(...)`. Mirrors archive.ts's Archive-row pattern.
- **5.8.7** `9bfe446` — `remove_label.ts` Gmail uses `writeThroughRemoveLabel` (exact `label` PK match — fixes latent canonical-match bug where Bug-B1 wrong-shape rows could cause wrong-row deletion). Proton no-op preserved, doc comment expanded.

### ⚠️ Unplanned gap surfaced by Wave 2

**`src/rules/apply/proton.ts` has its own internal `writeLabelAdded` call** inside `applyProtonActions()`, executed after every successful IMAP COPY. This means when `add_label.ts` (or any tool) invokes `applyActions()`, the buggy-shape row is written by `applyProtonActions` BEFORE the tool layer's correct-shape write. Result: double rows per label (`label='Shopping'` AND `label='Labels/Shopping'`). Wave 2's helper fixes stacked ON TOP OF the pre-existing buggy writes rather than replacing them.

Same pattern likely in `src/rules/apply/gmail.ts` — needs audit.

This was not captured as a task in the Phase 2 plan. It's required for Wave 6 live verification to show clean post-conditions.

## 2026-04-24 Wave 2.5 — apply-layer gap-closure (5.8.6b, mailroom `0b2f9a3`)

Converted `src/rules/apply/proton.ts` and `src/rules/apply/gmail.ts` to Wave 5.8 helpers inside per-message `db.transaction(...)` blocks. Key findings:

- **Rule engine bypasses MCP tool layer**: `src/rules/process-ingested.ts` calls `applyActions()` directly. Apply layer is the convergence point for both rule-fired and tool-fired actions, so fixing it here closes the gap for both.
- **Corrected belief about Gmail INBOX**: ingest.ts:292-296 iterates `input.labels` unconditionally and writes each to `message_labels`. `gmail/poller.ts:279` passes `labels: msg.data.labelIds ?? []`, and `labelIds` includes `'INBOX'` for inbox messages. So Gmail DOES have `message_labels[INBOX]` rows at ingest, and `writeThroughArchive`'s `DELETE WHERE label='INBOX'` is the correct mirror. Previous assumption (Gmail INBOX column-only) was wrong.
- **accountId source**: `args.message.account_id` is always populated (format `"${source}:${account_email}"`). Used directly in both apply functions.
- **Integrity test update**: `src/rules/apply/write-through-integrity.test.ts` mocks updated mechanically — new helper imports, getInboxDb stub, archive assertion now matches two-arg `writeThroughArchive(db, id)` signature. No semantic test-intent changes.

### Resulting redundancy (not a bug — cleanup-later)

Tool-layer Wave 2 writes are now redundant with apply-layer writes, since tools call `applyActions` which does the correct writes, then the tool layer writes again. All writes are idempotent (`INSERT OR IGNORE`, `UPDATE ... SET archived_at = ?`), so the final DB state is correct. Cleanup (removing the tool-layer writes, making apply-layer authoritative) is refactor scope, not Wave 5.8.

One exception noted: `archive.ts:277` still calls `writeArchived` for the Gmail branch. Set-once of `archived_at` is correct but redundant with apply-layer's `writeThroughArchive`. Safe but noisy. Defer.

## 2026-04-24 Wave 6 — deploy + restore COMPLETE

### Operational discoveries that shaped the run

- **Repo location split**: `~/Projects/ConfigFiles/containers/mailroom/mailroom/` (git source) vs `~/containers/mailroom/` (runtime, NAS-backed `~/containers/data/mailroom/`). Both share `mailroom-local:latest` image tag. Build from source repo, deploy from runtime. Empty stub at the source repo's `../data/` should NOT be used.
- **Pre-existing index gap**: `lookupMessage` queries in apply.ts had no covering index. First-pass dry-run with delta preview took >40 min for one account (full SCAN per lookup). Added `idx_messages_account_source_message_id` (`c106219`) — query plan now SEARCH USING INDEX, full hydration completes in 7 min.
- **Dry-run was misleading**: pre-patch `--dry-run` skipped apply phase entirely, reporting `total_adds: 0` regardless. Patched (`c3de724`) so apply phase computes delta and reports counts in dry-run; only writes are gated.
- **Stale inferred-delete blast was unrecoverable** with the existing code: `applyInferredDeletes` only ever SET the flag, never UNSET. Wave 5.7's blast left 59,668 messages flagged. Added inverse `clearInferredDeletes` (`c3de724`) — when walker re-confirms a message upstream, clear its flag. Restored 59,540 messages in this run.

### Real run outcome (mailroom-ingestor stopped, 2026-04-24)

```
Pre  → Post:
  message_labels:        1,445 → 192,062     (+190,617)
  message_folder_uids:   1,331 → 190,232     (+188,901)
  label_catalog:           181 →     181     (already covered all labels)
  deleted_inferred:     59,668 →     128     (-59,540 cleared, 0 new)
  rfc822_backfilled:    59,686 →  59,721     (+35)

Hydration:
  total_adds:                    379,601
  total_removes:                       0
  removes_skipped (race protect):      5  ← verifyUpstream caught test labels
  total_inferred_deletes:              0
  total_inferred_deletes_cleared: 59,540
  total_ms:                       506,387 (8:26)
  audit_passed:                     true
```

### End-to-end cascade verified through restore

Jeff removed `Labels/Test-5.8-addlabel` from a message via Proton UI mid-execution. Sequence observed:
1. Proton UI removal → bridge EXPUNGE in Labels/Test-5.8-addlabel folder
2. Hot-tier reconcile fired ~15 min later → `applyLabelDelta` removed the local row (`removes_applied: 1`); 5 other potential removes correctly skipped via `verifyUpstream`
3. Real migrate-mirror walked → walker confirmed upstream absence → preserved removed state
4. Post-restore query shows the message has `All Mail|INBOX|Labels/Bulk` (no `Labels/Test-5.8-addlabel`) — clean cascade through 3 independent code paths

### Sanity-check highlights

```
Top labels post-restore:
  All Mail:        59,593
  Archive:         44,057
  Labels/Bulk:     26,873
  Labels/COVID19:  23,604  ← Jeff's largest user label
  Trash:           14,853
  ...
Sample COVID19 row shape: label="Labels/COVID19" source_id="Labels/COVID19" canonical="covid19"
```

### Mailroom commits this Wave (in order)

| Phase | Commit | Description |
|---|---|---|
| 5.8.1 | `121b8e4` | write-through helper module |
| 5.8.2 | `3e55260` | add_label tool |
| 5.8.3 | `b4aeec8` | archive tool (+Archive row) |
| 5.8.4 | `014ef53` | delete tool |
| 5.8.5 | `672e893` | label replace-set tool |
| 5.8.7 | `9bfe446` | remove_label tool (Gmail PK fix) |
| 5.8.6 | `1b34b81` | apply_action unified branches |
| 5.8.6b | `0b2f9a3` | apply-layer rule-engine gap |
| 5.8.8 | `3c123d5` | integration tests (32 cases) |
| 5.8.9 | `88af2cc` | existing test updates |
| 5.8.10 | `ccde50b` | reconcile idempotency test |
| 5.8.11 | `7462fd0` | live test harness script |
| 5.8.X1 | `c106219` | composite index for reconcile lookups |
| 5.8.X2 | `c3de724` | dry-run preview + clearInferredDeletes |

## 2026-04-24 Waves 3, 4, 5 — tests + harness complete

- **5.8.8** `3c123d5` — `src/integration/wave-5.8-writethrough.test.ts` (588 LOC, 32 tests) covers all helpers + cross-table assertions. Executor tested helpers directly against in-memory DB (not full tool chain) because tool-layer tests mock `applyActions` at a boundary where DB state isn't reachable. Tool-level wiring validated separately by live harness in Phase 6.
- **5.8.9** `88af2cc` — `apply_action.test.ts` mocks updated to new helpers (adds `fakeDb` stub + `getInboxDb` mock). `write-through.test.ts` gains 15 helper tests. Pre-audit: add_label/archive/label/remove_label tests mock applyActions at a boundary where DB assertions aren't reachable; those are covered by 5.8.8. Suite: 362 → 409 tests, 2 failing → 0 failing.
- **5.8.10** `ccde50b` — `src/integration/wave-5.8-reconcile-idempotency.test.ts` (4 scenarios: label, archive, delete, negative-sanity). Targets `applyLabelDelta` in `src/reconcile/apply.ts:89`. All idempotent on correct write-through shape. Negative sanity confirms the harness is load-bearing.
- **5.8.11** `7462fd0` — `scripts/test-writethrough.ts` (430 LOC). Zero new deps. Uses `MAILROOM_DATA_DIR` env (matches ingestor pattern + `migrate-mirror.ts`). `--help` works; error paths print clear messages. Intended invocation: `docker exec mailroom-ingestor-1 npx tsx scripts/test-writethrough.ts --tool <name> --args '<json>'`.

## 2026-04-24 Phases 1-5 sanity check

Run from mailroom repo root at tip `7462fd0`:
- `npx tsc --noEmit` → exit 0, zero errors.
- `npm test` → 42 test files passed, 1 skipped; 413 tests passed, 2 skipped. Duration 2.3s. **No failing tests.**

### Waves 2.5 gap-closure summary (for Wave 6 mental model)

The apply layer (`src/rules/apply/proton.ts` + `gmail.ts`) is the **convergence point for both MCP tool calls and rule-engine actions**. After 5.8.6b, it uses the new helpers via `db.transaction(...)`. The MCP tool layer (Wave 2 commits) redundantly writes via the same helpers — all writes are idempotent so the final DB state is correct. Cleanup of tool-layer redundancy is refactor scope, not Wave 5.8.

## 2026-04-24 Wave 6 deploy — operational detour + 5.8.12 + 5.8.13

**Deploy-location confusion resolved**: Repo has been copied to `/home/jeff/Projects/ConfigFiles/containers/mailroom/mailroom/` (git source, Wave 5.8 commits) but the ACTIVE runtime/data remains at `/home/jeff/containers/mailroom/` (runtime-only, `dist/` + docker-compose.yml pointing at NAS-backed `/home/jeff/containers/data/mailroom/` with btrfs hourly snapshots). Image tag `mailroom-local:latest` is shared between both.

**Correct deploy path**: rebuild from Projects/ConfigFiles repo (git source), recreate containers from `/home/jeff/containers/mailroom/` compose file (correct mounts). Both use the rebuilt image. Do NOT recreate from the Projects/ConfigFiles repo — its `../data/` path resolves to an empty stub.

### 5.8.12 — Rebuild + deploy (done)

- Rebuild: `env-vault env.vault -- docker compose build ingestor` from Projects/ConfigFiles repo → image manifest `26664ba8...` tagged `mailroom-local:latest`.
- Deploy: `env-vault env.vault -- docker compose up -d --force-recreate ingestor inbox-mcp` from `/home/jeff/containers/mailroom/` → correct 4.5 GB DB mounted at `/var/mailroom/data/store.db`, Gmail creds mounted at `/var/mailroom/gmail-mcp/`. Both services healthy; ingestor has 5 Proton IDLE sessions established; inbox-mcp listening on :8080 with Gmail client ready.
- Safety: btrfs hourly snapshots at `/home/jeff/containers/data/.snapshots/mailroom/` provide pre-deploy rollback capability (my manual `cp` snapshot was of the wrong empty stub — deleted).

### 5.8.13 — Live harness validation on real damaged DB (done)

Four tool tests via `scripts/test-writethrough.ts`, all verified correct Wave 5.8 shape on the 4.5 GB damaged DB:

| Tool | Target | Verified |
|---|---|---|
| add_label | Shuggie's Burger @ jeff@thestonefamily.us | +`Labels/Test-5.8-addlabel` with matching `source_id` + correct canonical (**B1 fixed**) |
| archive | 4/20 Celebrate #1 | INBOX removed from `message_labels` + `message_folder_uids`; Archive row added with ingest-matching shape; `archived_at` set (**B2 fixed**) |
| delete | 4/20 Celebrate #2 | All `message_labels` + `message_folder_uids` rows deleted; `deleted_at` set; `archived_at` untouched (**B3 fixed**) |
| label (replace-set) | Parallel Agents | Only `Labels/*` replaced; INBOX row + `All Mail` + `message_folder_uids` PRESERVED (**B4 fixed**) |

Live test mutations are intentional clutter (same category as prior session's Test-Hotfix-X labels).

### Outstanding reminders

- `docker-compose.override.yml` with LOG_LEVEL=debug is NOT currently present (was deleted at Wave 5.7 deploy). Debug logging is OFF.
- Ingestor is running the hotfix code; don't restart without intent.
- Wave 5.6 seeding added 305 rows to `proton_folder_state` — intact and correct.
- The Wave 5.7 hotfix correctly protects against recurrence of the data-loss class — confident we can do a fresh hot reconcile post-restore.

### Reboot check

1. **Where am I?** Wave 5.7 shipped with a data-loss bug that was immediately hotfixed (3 commits: test, fix, blast-guard). Live testing on the damaged DB surfaced 4 independent Wave 2C write-through bugs. Wave 5.8 plan drafted with reproducers + fix shapes. Restore intentionally deferred until 5.8 lands.
2. **Where am I going?** Phase 1 (helper) → Phase 2-3 (rewrites + tests) → Phase 5 (harness script) → Phase 6 (deploy + restore + verify).
3. **What is the goal?** Every Wave 2C write-through tool maintains `message_labels` + `label_catalog` + `message_folder_uids` in cross-table consistency matching Wave 5.5 ingest-path shape. Reconcile should be a no-op on steady state when write-through ran correctly.
4. **What have I learned?**
   - **Wave 5.7 incident lesson**: scoping a walker by `sinceDate` requires scoping the DB-side of the delta too, or the "missing upstream" logic falsely flags everything older. Blast-guard is mandatory defense-in-depth on any reconcile that might mass-delete.
   - **Live testing on a damaged instance is high-value**: Jeff's insight that "we're restoring anyway, so mutations don't matter" lets us exercise real code paths with real bridge semantics and catch bugs stubs miss.
   - **Write-through + reconcile must agree on shape**: if ingest writes `Labels/Foo` and write-through writes `Foo`, reconcile creates duplicates. All three write paths (ingest, write-through, reconcile-apply) must produce identical rows for steady-state reconcile to be a no-op.
   - **Pre-existing-but-latent is more common than we think**: Wave 2B had CONDSTORE + IDLE-expunge latent bugs. Wave 2C has write-through latent bugs. Pattern: new feature flag or table gates whether the code path runs; "working" tests use stubs that don't exercise the real integration. Need live-data validation as part of any wave's AC.
5. **What have I done?**
   - 3 hotfix commits on mailroom (`6f2237e`, `7539652`, `32a8682`).
   - 5 bugs surfaced via live MCP testing on damaged DB.
   - Wave 5.8 plan drafted (tracker + findings + this progress.md).
   - Ingestor redeployed with hotfix, running stably.
   - (Not yet: restore; not yet: Wave 5.8 fixes.)
