# Progress — Morning Brief Overnight Blindness

## 2026-04-25 — Plan created

- 09:00–09:30 CDT — Jeff reported the 7:01 AM brief had said "0 overnight" but a Travis GOP newsletter showed up at 8:34 AM and was auto-archived; suspected emails had been missed.
- 09:30 CDT — Investigated store.db via mailroom-ingestor container. Found: Travis GOP email actually arrived at **08:30:58 CDT** (post-brief, real-time). But also found 11 overnight Protonmail rows in store with `received_at` in the brief's overnight window — which the brief should have surfaced.
- 09:40 CDT — Jeff sent inbox screenshot showing overnight messages marked `\Seen` without him touching them — confirms mailroom poller had ingested them before brief time.
- 10:00 CDT — Code inspection: `ingestMessage` already calls `bumpWatermark` at `src/store/ingest.ts:306`. Cast doubt on TD-MAIL-PUSH-WATERMARK as the root cause; reframed as Wave-2B-specific (need to verify if 2B path bypasses `ingestMessage`).
- 10:10 CDT — Drafted plan. Decision: defense-in-depth via `count_in_window` audit MCP tool first (Phase 2), then root-cause investigation (Phase 1) and fix (Phase 3) once we know exactly which failure mode the 7am brief hit.

## Test results

| Test | Status | Notes |
|---|---|---|
| `src/mcp/tools/count.test.ts` (11 cases) | ✅ pass | new in Phase 2; covers window inclusivity, account/source filters, sent/deleted defaults, opt-in flags, validation, 11-row replay |
| Full mailroom suite (vitest) | ✅ 414/416 (2 skip) | no regressions; 2 skips pre-existing |
| TS compile (`npm run build`) | ✅ clean | tsc no errors |
| Live `tools/list` includes `count_in_window` | ✅ verified | smoke test against `172.31.0.1:18080/mcp` |
| Live `count_in_window` returns expected counts | ✅ verified | overnight window total=11 (matches direct DB query) |
| Live `recent` returns 0 across active accts (bug repro) | ✅ verified | Phase 2.5 replay; audit-vs-recent disagreement = the trigger condition the new precondition catches |

## Errors

| Time | Error | Resolution |
|---|---|---|
| _(none yet)_ | | |

## 2026-04-25 — Phase 2 audit precondition shipped (~12:00 CDT)

- 11:00 CDT — Created branch `fix/morning-brief-audit` in both nanoclaw and ConfigFiles repos.
- 11:15 CDT — Added `CountInWindowArgs` + `CountInWindowResult` types to `src/store/types.ts`. Implemented `countMessagesInWindow` in `src/store/queries.ts` — pure SQL aggregate, no watermark semantics, defaults align with `recent` (excludes sent + deleted, opt-in-able).
- 11:25 CDT — Wired into `src/mcp/server.ts`: import, `parseCountInWindowArgs` parser, descriptor with full inputSchema, `case 'count_in_window'` in tools/call.
- 11:30 CDT — Wrote 11 tests in `src/mcp/tools/count.test.ts` covering window inclusivity, filters, default exclusions, opt-in flags, validation, and a full reproduction of the 2026-04-25 brief-audit scenario.
- 11:35 CDT — `npm run build` clean; `npx vitest run src/mcp/tools/count.test.ts` 11/11 pass; full suite 414/416 (2 pre-existing skips, no regressions).
- 11:40 CDT — `docker compose build inbox-mcp` produced new `mailroom-local:latest`. `docker compose up -d inbox-mcp` recreated container, healthy in 2s.
- 11:45 CDT — Verified `count_in_window` appears in live `tools/list` against `172.31.0.1:18080/mcp`. Tool callable and returns expected JSON shape.
- 11:50 CDT — Live audit against today's overnight window: `total: 11` (jstone.pro=4, thestonefamily.us=5, registrations=2). Matches the count from earlier direct DB query.
- 11:55 CDT — Updated `groups/telegram_inbox/CLAUDE.md` Morning routine: rewrote 5 vague steps as 8 explicit ones with audit-first precondition. Refuse to post "0 overnight" brief unless audit confirms 0 rows. Added `count_in_window` to the tool catalog so Madison can use it ad-hoc.
- 12:00 CDT — Replay validation: with the live store, `recent` returns 0 across all 4 active accounts but `count_in_window` returns total=6 for `[02:00Z, 12:01Z)`. The new precondition would trip the `⚠️ Brief audit failure` path. Failure mode reproducible on demand until Phase 3 lands.
- 12:00 CDT — Also captured `TD-MAIL-SEEN-FLAG-RELIABILITY` in `lode/tech-debt.md` (separate, smaller bug surfaced during today's investigation: IMAP `\Seen` SET sometimes fails after successful ingest).

## 2026-04-25 — Phase 1 diagnosis complete (~10:30 CDT)

- 10:00 CDT — Confirmed Madison's `_digests/2026-04-25.md` says "all 6 accounts returned zero new messages since last watermarks." She enumerated all 6 — failure is on the read-side, not the orchestration side.
- 10:10 CDT — Verified Wave 2B sync workers do not insert messages. Only insert path is `proton/poller.ts` and `gmail/poller.ts` via `ingestMessage`.
- 10:20 CDT — Read `getRecentMessages` body fully + traced `setWatermark` callers. **Zero production callers** for `setWatermark`. Watermark is advanced ONLY by `bumpWatermark` in `ingestMessage:306`. Read side never writes.
- 10:25 CDT — Conclusion: watermark is an ingest cursor pretending to be a read cursor. `recent` returns `received_at > stored_watermark` but `stored_watermark = MAX(received_at)`, so always 0 unless a message lands in the read-side gap. Bug is structural, not a race or transient.
- 10:30 CDT — Updated `findings.md` with Discovery 1/2/3 and the inverted-from-reality status of TD-MAIL-PUSH-WATERMARK note. Updated tracker.md decisions and Phase 3 with the concrete fix (move watermark advance to read side; reset existing watermarks on deploy).

## Reboot check (5 questions)

1. **Where am I?** — Phases 1 (diagnosis) and 2 (audit precondition) complete as of 2026-04-25 ~12:00 CDT. Branch `fix/morning-brief-audit` in both nanoclaw and ConfigFiles. Mailroom rebuilt, redeployed, healthy. Madison's CLAUDE.md morning routine rewritten with audit-first precondition. Live replay confirms the audit catches the watermark bug (recent=0 across 4 accounts; count_in_window=6 for the same window).
2. **Where am I going?** — Phase 3: mailroom watermark read-cursor fix. Remove `bumpWatermark` call from `ingestMessage`. Add `setWatermark(account_id, new_watermark, now)` write-back inside `getRecentMessages` (skip on cold-start + empty). Tests covering ingest-then-recent round-trips. One-time reset of existing watermarks on deploy via `MAILROOM_RESET_WATERMARKS_ONCE=1`. Update TD-MAIL-PUSH-WATERMARK note in `lode/tech-debt.md` with the corrected diagnosis.
3. **What is the goal?** — Make watermarks a real read cursor, not an ingest cursor. After Phase 3, `recent` and `count_in_window` will agree by construction (no more bug to catch). The audit precondition stays as a permanent integrity check.
4. **What have I learned?** —
   - The Travis GOP email itself arrived 8:30 AM (after brief); was a red herring for the timing claim.
   - The store had 11 overnight Protonmail rows the brief never surfaced.
   - `bumpWatermark` IS wired in `ingestMessage:306` — but that's the bug, not the fix.
   - `setWatermark` exists but has zero production callers.
   - `getRecentMessages` returns `new_watermark` but doesn't write it back.
   - Wave 2B sync workers don't insert messages at all — only update folder state + emit events.
   - Madison enumerated all 6 accounts at 7am correctly (per digest file). She wasn't the bug.
   - The TD-MAIL-PUSH-WATERMARK note from 2026-04-23 is inverted from current reality and needs a correction.
   - The read-tool convention in mailroom is: implementation in `src/store/queries.ts`, parser + descriptor + case all inlined in `src/mcp/server.ts`; tests file in `src/mcp/tools/<name>.test.ts` even when the impl is in queries.ts. (Confirmed by recent/search/thread; followed for count_in_window.)
   - Inbox-MCP tool registration is reachable from a peer container via `172.31.0.1:18080/mcp` (default-bridge gateway pattern from M4+ post-mortem).
   - Image rebuild uses `docker compose build inbox-mcp` (single-image, command-differentiated services). Recreate via `dcc up -d inbox-mcp` or `env-vault env.vault -- docker compose up -d inbox-mcp`.
5. **What have I done?** — Phase 1 diagnosis (read-only). Phase 2 implementation: types + query function + MCP server wiring + 11-test suite + image build + live deploy + replay verification + Madison CLAUDE.md rewrite + tech-debt entry for the unrelated `\Seen`-flag flakiness. No commits yet — branch `fix/morning-brief-audit` carries the diff in both repos.
