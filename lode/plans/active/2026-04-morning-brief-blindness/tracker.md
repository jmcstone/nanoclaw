# 2026-04 Morning Brief Overnight Blindness

Branch: **TBD** — recommend `fix/morning-brief-audit` off `main`. Mailroom-side changes (if needed) layer on top of the live mailroom main branch.

## Context

On 2026-04-25 at 7:01 AM CDT Madison's morning brief reported:

> ☀️ Morning brief — 0 overnight urgent, 0 overnight needs reply; 0 FYI (0 auto, 0 spam) — All 6 accounts completely quiet overnight — nothing to surface. Ingest pipeline healthy (label coverage: 0 missing).

Independent inspection of `~/containers/data/mailroom/store.db` shows **11 Protonmail rows** with `received_at` between 2026-04-24 18:00 CDT and 2026-04-25 07:01 CDT, including Netflix, OpenAI ChatGPT, Quora, Uber Eats, Exa, Healu Minute, Chase, Indeed, IMDb, Epoch Times, Readwise. Jeff's inbox screenshot at 9:11 AM independently confirms several of these are marked **read** in IMAP without Jeff having opened them — i.e. mailroom's poller `\Seen`-flagged them after ingest. So the data was in the store at brief time; the brief simply didn't see it.

## Goal

Make it impossible for Madison's morning brief to silently report "0 overnight" when the store contains overnight rows. Add an audit precondition that compares Madison's `mcp__messages__recent` results against an independent overnight count derived directly from `messages` table, and refuse to send a "0 overnight" brief unless the audit confirms zero rows in the overnight window. Also fix any underlying watermark or poller-cycle race that contributed to the false zero.

## Decisions

| Decision | Rationale |
|---|---|
| Root cause confirmed (Phase 1 done): watermarks are an ingest cursor, not a read cursor | `setWatermark` has zero production callers. `bumpWatermark` in `ingestMessage` is the only writer. `getRecentMessages` does not write back `new_watermark`. Therefore `received_at > stored_watermark` query is structurally always 0 for accounts where a message has been ingested since Madison's last call. See findings.md. |
| Fix is on the **read** side, not the ingest side | Removing `bumpWatermark` from `ingestMessage` is wrong — it leaves no cursor. Adding `setWatermark` calls inside `getRecentMessages` is the right fix: the watermark becomes "what Madison has consumed," advanced only on read. Push-ingest never touches it. |
| Land defense-in-depth (brief audit) before the root-cause fix | A brief that lies once already passed Jeff's eyes; another silent zero would erode trust. The audit costs one MCP call per brief, can't be defeated by watermark drift, and stays useful even after the root fix lands as a permanent integrity check. |
| Audit uses an independent overnight COUNT query, not a re-call of `recent` | The bug IS in `recent`. Cross-checking via the same tool would mask it. A new `mcp__messages__count_in_window` tool keyed on raw `received_at` (no watermark semantics) is the oracle. |
| `count_in_window` is a new mailroom MCP tool, not reuse of `recent` | Smaller surface; no `since_watermark` semantics to drift. Returns `{counts: [{account_id, source, count}], total}` for a `[from, to)` window. Read-only. |
| Brief refuses to send if audit > 0 but Madison's classified count == 0 | Loud failure: brief must include `⚠️ Brief audit failure — store shows N overnight rows, classification returned 0` and list raw message_ids instead of the cheerful "all quiet" line. |
| Brief routine in `groups/telegram_inbox/CLAUDE.md` enumerates the 6 account_ids inline | Currently steps 1–5 of "Morning routine (7am task)" rely on Madison's natural-language comprehension. Explicit list + explicit windowing is robust against future drift. |
| Retire / rewrite the TD-MAIL-PUSH-WATERMARK note in `lode/tech-debt.md` | The 2026-04-23 note is now inverted from reality. Mark as RESOLVED-INCORRECTLY-DIAGNOSED and replace with a pointer to this plan's root-cause analysis. |

## Phases

### Phase 1 — Diagnosis ✅

- [x] **1.1** Madison's CLAUDE.md morning routine (line ~366) is 5 high-level steps: resume paused tasks → "scan both inboxes" → post brief → update digest index → carry-over re-propose. No explicit per-account loop; relies on Madison's interpretation. Scheduled-task prompt body says "Process overnight unprocessed items through full triage (ProtonMail bridge + Gmail jeff@americanvoxpop.com)" — references "ProtonMail bridge" generically, not the 5 distinct Proton account_ids. Stale phrasing from pre-mailroom era.
- [x] **1.2** Wave 2B sync workers do NOT insert messages. `grep` across `src/sync/*.ts` for any `INSERT INTO messages|ingestMessage|setWatermark|bumpWatermark` returns one match: `proton-condstore.ts:58 INSERT INTO proton_folder_state` (metadata, not messages). Insertion is exclusively via `proton/poller.ts:211` and `gmail/poller.ts:269`, both routing through `ingestMessage`. So `bumpWatermark`-on-ingest is the *only* watermark writer.
- [x] **1.3** Today's `_digests/2026-04-25.md` says verbatim: "all 6 accounts returned zero new messages since last watermarks." Madison did call `recent` per account; each call returned 0. Failure mode is **(b)**: `recent` returned wrong/empty results. NOT (a) skipped accounts.
- [x] **1.4** Root cause located in `src/store/queries.ts` + `src/store/ingest.ts` + `src/store/watermarks.ts`: watermark semantics are inverted. `bumpWatermark` in `ingestMessage:306` makes the watermark always-equal-to-MAX(received_at). `getRecentMessages` queries `received_at > watermark` and does not write back. `setWatermark` has no production callers. So `recent` returns 0 by construction unless a message arrives in the read-side gap. See findings.md for full analysis.

### Phase 2 — Brief audit precondition (defense in depth) ✅

- [x] **2.1** `countMessagesInWindow` added to `src/store/queries.ts` (followed read-tool convention; impl lives in queries.ts like `getRecentMessages`/`searchMessages`). Args `{from_iso, to_iso, account_ids?, sources?, include_sent?, include_deleted?}` → returns `{counts: [{account_id, source, count}], total, window: {from, to}}`. Pure aggregate `COUNT(*) FROM messages WHERE received_at >= ? AND received_at < ?`. No watermark semantics. Defaults match `recent` (excludes sent + deleted, both opt-in-able).
- [x] **2.2** 11 tests in `src/mcp/tools/count.test.ts` — half-open window inclusivity, account_ids filter, sources filter, default sent/deleted exclusion, opt-in flags, empty window, invalid args (from >= to, empty strings), and the 2026-04-25 brief-audit reproduction scenario (11 overnight items across 2 Proton accounts). All 11 pass; full suite 414/416 (2 pre-existing skips, no regressions).
- [x] **2.3** Wired into `src/mcp/server.ts`: import + parser (`parseCountInWindowArgs`), tool descriptor with full inputSchema in `tools/list`, case `'count_in_window'` in `tools/call`. Image rebuilt; `mailroom-inbox-mcp-1` recreated and healthy. Live `tools/list` now includes `count_in_window` between `recent` and `query`.
- [x] **2.4** `groups/telegram_inbox/CLAUDE.md` Morning routine (7am task) rewritten from 5 vague steps to 8 explicit ones with hard preconditions: compute window → audit-first via `count_in_window` → per-account `recent` → cross-check `audit_total` vs `classified_overnight` → refuse to send "0 overnight" brief on disagreement (post `⚠️ Brief audit failure` line and stop instead). Added a "Why the audit step exists" footnote anchoring the 2026-04-25 incident. Also added `count_in_window` description to the `Inboxes to sweep` tool catalog so Madison knows when to reach for it ad-hoc.
- [x] **2.5** Replay verified live against current store state: `count_in_window` over the 6 active accounts in window `[2026-04-25T02:00Z, 2026-04-25T12:01Z)` returns `total: 6`. `recent` for each of the 4 active accounts (`thestonefamily.us`, `jstone.pro`, `registrations`, `gmail:americanvoxpop`) returns **0 messages** every time. With the new precondition, Madison would trip the `⚠️ Brief audit failure` path on the next 7am invocation instead of cheerfully reporting "all quiet." Failure mode is reproducible *now*, on demand, until Phase 3 lands.

### Phase 3 — Root-cause fix (mailroom): make watermark a read cursor ✅

- [x] **3.1** Removed `s.bumpWatermark.run(...)` from `ingestMessage` in `src/store/ingest.ts`. Removed the `bumpWatermark` field from `PreparedIngestStmts` and its prepared-statement assignment. Ingest no longer touches the watermark. No regression in `src/store/ingest.test.ts` (19/19 pass) — none of those tests asserted on watermark side-effects.
- [x] **3.2** `getRecentMessages` in `src/store/queries.ts` now writes back via `setWatermark(account_id, new_watermark)` after a successful read. Imported `setWatermark` from `./watermarks.js`. `shouldPersist` guard skips write when (a) caller passed an explicit `since_watermark` (caller is driving the cursor), (b) computed `new_watermark` is empty, (c) `messages.length === 0 && isColdStart` (don't pin a fresh account), or (d) `new_watermark` is not strictly greater than the stored value. No `withSqliteBusyRetry` wrap — `setWatermark` uses better-sqlite3's synchronous prepared statement and the upsert SQL is single-row + indexed; busy-retry would be over-engineering here.
- [x] **3.3** New file `src/store/queries.read-cursor.test.ts` — 7 tests:
  - Test A: ingest 5 → `recent` returns all 5 + watermark advances. Second `recent` returns 0.
  - Test B: ingest 5 → read → ingest 3 more → `recent` returns 3.
  - Test C: cold-start with 0 rows does NOT pin watermark.
  - Test C2: cold-start with rows DOES pin watermark.
  - explicit `since_watermark` does NOT advance the stored watermark.
  - smaller new_watermark does NOT regress the stored watermark.
  - reproduces the 2026-04-25 morning-brief failure (would have failed pre-fix).
  All 7 pass.
- [x] **3.4** `src/integration/wave-5.5-push-ingest-parity.test.ts` test 5.5.6 rewritten to assert read-cursor semantics: push-ingest no longer advances watermark; first `recent` surfaces all rows + advances; second returns 0. Used current-relative timestamps so the cold-start window contains them regardless of when the test runs.
- [x] **3.5** `lode/tech-debt.md` TD-MAIL-PUSH-WATERMARK entry rewritten: marked REOPENED-AND-RESOLVED 2026-04-25 with full retrospective on why the 2026-04-23 closure was inverted from correct semantics. Pointers to this plan and the read-cursor test file.
- [x] **3.6** Image rebuilt (both ingestor and inbox-mcp share `mailroom-local`). Both containers recreated. `getRecentMessages` confirmed to call `setWatermark` (`/app/dist/store/queries.js:303`). Live verification: `recent` with explicit `since_watermark="2026-04-24T15:00:00.000Z"` returns 260KB / 124KB / 107KB / 2.7KB of message data across the 4 active accounts (vs 0 across all 4 pre-fix).

### Phase 3.5 — One-time watermark reset migration ✅

- [x] **3.5.1** Implemented in `src/ingestor.ts` main() startup — gated on `MAILROOM_RESET_WATERMARKS_ONCE=1`. Sets every existing watermark whose value is greater than `(now - INBOX_COLD_START_LOOKBACK_MS)` back to that cutoff. Logs `rows_reset` count at WARN with explicit "REMOVE the env var before next restart" instruction. Single SQL UPDATE; idempotent against re-runs (rows already at-or-below the cutoff are unaffected by the `WHERE > ?` clause).
- [x] **3.5.2** Compose env pass-through entry added to `docker-compose.yml` ingestor service for `MAILROOM_RESET_WATERMARKS_ONCE`. Pass-through line stays in compose; unset env var = no-op. Documented inline.
- [x] **3.5.3** Migration ran successfully: `rows_reset: 4` for the 4 watermarks that were ahead of the cutoff. Watermarks then advanced naturally as Madison/automated callers invoked `recent`. Subsequent ingestor restart WITHOUT the env var confirmed migration is one-shot (no reset log on second boot).

### Phase 4 — Verification

- [ ] **4.1** Tomorrow's 7am brief audit lands a clean signal — either "all quiet, audit confirms 0 overnight rows in store" or honest counts. No more silent zero.
- [ ] **4.2** 7-day soak: zero `audit_failure` lines in any morning brief. If one fires, treat as a P0 regression and reopen this plan.

## Errors

| Error | Resolution |
|---|---|
| _(none yet)_ | |

## Currently in

**Phases 1, 2, 3, and 3.5 all complete as of 2026-04-25 ~14:55 CDT.** Branch `fix/morning-brief-audit` in both nanoclaw and ConfigFiles.

Code state:
- mailroom: 421/423 tests pass (414 → 421, +7 new in `queries.read-cursor.test.ts`; no regressions). New image built and deployed for ingestor + inbox-mcp.
- One-time watermark reset migration ran successfully (4 rows reset). Confirmed one-shot — second restart without env var did not re-run.
- Live verification: `recent` with explicit `since_watermark` returns 100s of KB of message data across 4 active accounts. `count_in_window` returns total=37 for the same window. They agree.

What's left:
- Phase 4 verification: tomorrow's 7am brief lands clean (audit confirms 0 overnight, OR honest counts). 7-day soak: zero `audit_failure` lines.
- After 7-day soak passes, plan moves to `lode/plans/complete/`.
