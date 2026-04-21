# Unified Inbox — Progress Log

## Timeline

### 2026-04-21

- **21:30 CDT** — Session handover. `/simplify` pass consumed the code-review output in three parallel subagents (reuse/quality/efficiency); aggregated and landed fixes in `5b13d3b` (prepared stmt caches + ingest consolidation + queries re-sync + misc), `acd22a4` (untrack nanoclaw.db + ternary flatten), `4c61fb8` (extracted `createGmailClient` + `openProtonInbox` helpers + shared logger in both backfill scripts). Then on top, **two modularity refactors** per Jeff's explicit ask for bolt-on source additions: `ede0ed3` (generic `ingestMessage` + `deriveProtonThreadId` helper) and `2686e34` (per-source `WatermarkStrategy` record in `getRecentMessages`). Final drift cleanup in `cd4f1bf`. Branch is now **31 commits ahead of main, 384/384 tests pass, container MCP builds clean**. Nothing deployed yet — next session builds the container, restarts the service, runs the two backfill scripts.
- **20:05 CDT** — Phase 1.5 backfill scripts complete. `3f9df7b` (Gmail) ended up containing both backfill scripts + both channel refactors because the Gmail executor swept in the Proton executor's working-tree files at commit time; `0f881de` is the Proton cleanup commit. Full suite 377/377 (+12 new unit tests across extractGmailBodyParts and extractProtonmailBody). Scripts are idempotent, checkpointable, rate-limited. Execution gated on Phase 1 deploy. Also surfaced a pending question: seed `watermarks` table with current Madison high-water values before deploy so her first sweep isn't flooded.
- **19:40 CDT** — Wave 4 complete in parallel. Three executors landed `95740df` (container-runner gating + agent-runner MCP registration + startup init + 3 gating tests), `b530363` (Dockerfile bakes inbox-mcp), `5adccfb` (Madison CLAUDE.md reads via inbox MCP; `lode/groups.md` note). Full suite 365/365. **Phase 1 code-complete.**
- **19:20 CDT** — Wave 3 complete in parallel. `42781ef` (Gmail ingestion wiring), `f72a528` (Protonmail ingestion wiring + References header parser), `7c516cd` (inbox MCP server scaffold — 10 files, MCP SDK 1.13.3, tools/list verified).
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

1. **Where am I?** Phase 0 + 1 + 1.5 code-complete on `unified-inbox` branch. No deploy yet. Next concrete action: rebuild the container, restart nanoclaw, run the two backfill scripts.
2. **Where am I going?** Seeing the new system run. Verify Madison's next hourly sweep reads via `mcp__inbox__recent`, the store fills from backfill + live ingestion, digests become consistent with `proposed_action`/`action_taken`, HTML emails no longer silently drop. Once that's stable and feels right, move to Phase 2 (unified messaging API) or Phase 3 (IMAP IDLE push) based on pain points observed.
3. **What is the goal?** Make Madison Inbox a viable alternative to Jeff opening Gmail / Proton / Slack / Google Messages individually. Unified triage across all message sources with durable state, push ingestion, consistent actions, audit + undo.
4. **What have I learned?** (a) Proton Bridge has one `stone.jeffrey` account exposing all 7 addresses with one shared password; "no such user" auth errors are transient post-sync stalls, not credential issues. (b) Prettier post-commit hook produces drift that shows up as dirty working tree after commits — have to either re-run + amend or land a follow-up. Use `git add <file>` not `git add -A` to avoid sweeping stray files like `nanoclaw.db`. (c) Parallel `lode-executor` subagents can race at commit time if they write to overlapping filesystem locations; the first to commit sweeps in the other's working-tree files. Use tightly non-overlapping file sets. (d) better-sqlite3's prepared statements MUST be cached at module scope or you defeat the whole perf model. (e) `Record<InboxSource, WatermarkStrategy>` gives TypeScript-enforced completeness for plugin-shaped architecture — adding a source without a strategy entry fails the build.
5. **What have I done?** Shipped Phase 0 (schema + HTML fallback + proton cooldown), Phase 1 (SQLite store + FTS5 + MCP server + Madison CLAUDE.md rewrite), Phase 1.5 (both backfill scripts with cursor checkpoints, newest-first walk), `/simplify` pass (prepared stmt cache + refs extraction + shared logger in scripts + ternary flatten + 15 other quality fixes), and two modularity refactors that make Outlook/Slack/SMS additions genuinely bolt-on. Build clean, 384/384 tests. Handover playbook at `lode/tmp/handover-2026-04-21.md`.

## Decisions resolved 2026-04-21

1. **0.3 Proton config scope** — keep all 7 addresses polling (Jeff receives on all 7). Robustness is now a polling-loop problem, not a pruning problem.
2. **0.4 HTML library** — `turndown` (Markdown preservation for LLM consumption).
3. **0.5 Per-email-arrival policy** — priority-gated: urgent / needs-reply / action-required → post immediately with `proposed_action`; otherwise silent, let the `:07` sweep absorb.
4. **Branch** — `unified-inbox` feature branch created.
