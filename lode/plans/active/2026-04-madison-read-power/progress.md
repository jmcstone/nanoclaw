# Progress — Madison Read Power + Session Freshness

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
