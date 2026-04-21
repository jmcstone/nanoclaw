# Unified Inbox — Progress Log

## Timeline

### 2026-04-21

- **19:05 CDT** — Wave 2 complete in parallel. Three executors landed `bb82006` (ingest), `98870ba` (watermarks), `05cad11` (queries). 31 new tests pass; full suite 362/362.
- **18:55 CDT** — Wave 1 executed as two sequential sub-steps (types first, then schema+tests atomic). Commits `b4fe57c` and `e707a99`. 8 schema tests pass; full suite 331/331.
- **18:30 CDT** — Phase 1 planned via `/lode:plan`. Decomposed into 7 acceptance criteria + 10 tasks across 4 waves. Read First list captures the files executors must read before touching code. Wave 1 is contract-first (types + schema + tests) so Waves 2–4 can fan out in parallel. Ready for `/lode:execute`.
- **18:15 CDT** — Phase 0 committed in 3 logical commits on `unified-inbox`: `910c15f` (routing), `7c8d0d8` (plan init), `2d67da7` (Phase 0 body + cooldown).
- **18:10 CDT** — Phase 0 code changes complete on `unified-inbox` branch. 0.1 + 0.5 CLAUDE.md edits, 0.4 turndown HTML→Markdown helper + both channels wired, 0.3 per-address cooldown in Protonmail poll loop. Build clean, all 323 tests pass (+9 new email-body tests). Not yet deployed; service restart pending Jeff's approval.
- **17:40 CDT** — All Phase 0 blocking decisions resolved by Jeff. Feature branch `unified-inbox` created and checked out. Tracker's decisions table updated. Ready to start 0.1.
- **17:30 CDT** — Plan created. Three-file lode pattern initialized at `lode/plans/active/2026-04-unified-inbox/`. Branch: `main` at time of creation.
- **17:25 CDT** — Completed investigation of Protonmail bridge "no such user" cascade. Confirmed via CLI `info 0`: bridge has one `stone.jeffrey` account in split mode with all 7 addresses sharing password `uQE12OhsEdUR1aFKZZf1Qg`. Live IMAP LOGIN via curl succeeds post-stall. No repair needed.
- **17:05 CDT** — Committed `findEmailTargetJid` helper + protonmail/gmail channel switch to inbox-target routing. Madison Inbox now correctly receives emails going forward. See `src/channels/email-routing.ts`.
- **16:45 CDT** — Root-caused Gmail email misrouting: all four registered groups carry `is_main=1`, so `.find()` picked Jeff's group by insertion order. Built helper with folder-first, `isMain`-fallback resolution.

## Test results

| Test | Status | Notes |
|---|---|---|
| Email-routing helper unit tests (5 cases) | ✅ pass | 2026-04-21 12:04 — inbox-priority, isMain fallback, empty, no match, inbox without isMain |
| Full vitest suite post-routing fix | ✅ pass | 2026-04-21 12:04 — 314/314 tests |
| Live IMAP LOGIN for `jeff@jstone.pro` via curl | ✅ pass | 2026-04-21 17:20 — curl exit 0 |
| Live IMAP LOGIN for `stone.jeffrey@protonmail.com` via curl | ✅ pass | 2026-04-21 17:20 — curl exit 0 |
| Live IMAP LOGIN for `jeff@thestonefamily.us` via curl | ✅ pass | 2026-04-21 17:20 — curl exit 0 |
| email-body unit tests (9 cases) | ✅ pass | 2026-04-21 18:05 — htmlToMarkdown (5) + pickBody (4) |
| Full vitest suite post–Phase 0 | ✅ pass | 2026-04-21 18:07 — 323/323 tests, build clean |
| Bridge stall monitoring (7-day window post-deploy) | ⏳ pending | Starts when service restarted onto unified-inbox build |

## Error log

*(none yet for this plan's phases — Phase 0 has not yet started)*

## 5-question reboot check

Update before any resumption after a session break.

1. **Where am I?** Phase 0 execution, starting with task 0.1 (CLAUDE.md `proposed_action` column + carry-over re-propose rule). All four blocking decisions resolved.
2. **Where am I going?** Phase 0 completion — Madison's digests stop drifting, HTML emails convert to Markdown via turndown instead of silently dropping, Proton polling loop becomes resilient against rate-limit cascade, per-email arrivals surface urgent items immediately while non-urgent wait for the :07 sweep. Felt difference: consistent digests with clear next-step actions per item + faster response on urgent/needs-reply.
3. **What is the goal?** Make Madison Inbox a viable alternative to Jeff opening Gmail / Proton / Slack / Google Messages individually. Unified triage across all message sources with durable state, push ingestion, consistent actions, audit + undo.
4. **What have I learned?** (a) Bridge has one Proton account `stone.jeffrey` with all 7 addresses + one shared password — config.json is correct. (b) "No such user" errors were transient post-sync stalls, not credential issues. (c) Digest schema drift traces to CLAUDE.md lacking a `proposed_action` column — agent improvises. (d) Carry-over items sit without re-proposals because CLAUDE.md has no re-propose rule. (e) The `findEmailTargetJid` helper is the first unified-routing primitive; the Phase 2 unified API will generalize this pattern.
5. **What have I done?** Fixed Gmail routing to Madison Inbox (`findEmailTargetJid`). Diagnosed Proton bridge cascade as transient. Drafted this plan spanning Phases 0–7.

## Decisions resolved 2026-04-21

1. **0.3 Proton config scope** — keep all 7 addresses polling (Jeff receives on all 7). Robustness is now a polling-loop problem, not a pruning problem.
2. **0.4 HTML library** — `turndown` (Markdown preservation for LLM consumption).
3. **0.5 Per-email-arrival policy** — priority-gated: urgent / needs-reply / action-required → post immediately with `proposed_action`; otherwise silent, let the `:07` sweep absorb.
4. **Branch** — `unified-inbox` feature branch created.
