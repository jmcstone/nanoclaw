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
