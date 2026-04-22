# Progress — Mail Push Redesign

## 2026-04-22 — Design session

Full design agreed in conversation between Jeff and Claude on the `unified-inbox` branch. Plan captured; `mail-push-redesign` branch created; no code yet.

### Actions

- Investigated "DocuSigns missed this morning" — found 3 DocuSigns ingested into store at 14:42–14:43 UTC. Live poller is fine. Bug is downstream of ingestion (see `findings.md`).
- Diagnosed auto-labeler dormancy (ephemeral in Madison's container, dying with each session).
- Diagnosed CLAUDE.md / tool staleness from M5 + M6.2.
- Iterated design across 8 conversation turns refining: rules schema (unified vs split, predicates, combinators, action semantics, label primitives), push vs polling, write MCP surface for Madison, account tags for multi-account future, mailroom-owns-writes pattern.
- Locked all decisions in `tracker.md` decisions table.
- Created branch `mail-push-redesign` off `unified-inbox` HEAD.

### Key conversation outcomes

1. **No live-poller scope change** — ingest isn't broken; the "All Mail" direction earlier was wrong.
2. **Push-only wakeups** — retire `:07` hourly and `*/15` labeler check; keep `7 AM` brief.
3. **Three-way event outcome**: urgent / routine / silent.
4. **Unified rules.json**, accumulate-and-override action semantics, array order = priority.
5. **Three label primitives**: `label`, `add_label`, `remove_label`.
6. **Separate `accounts.json`** with per-account tags (`work`, `personal`, `contractor:x`).
7. **Canonical label names** (no `Labels/` prefix); mailroom translates per source.
8. **Mailroom owns all email writes**; Madison's surface is `mcp__inbox__*` only (with 4 new tools: `apply_action`, `delete`, `send_reply`, `send_message`).
9. **Send rate-limit 20/hour/account** + send-log for audit.
10. **Soft-delete only** in v1 (no hard expunge).

### Test results

*(none yet — design-only session)*

## 2026-04-22 — Phase 1.1: Madison CLAUDE.md patched

### Actions

- Read tracker, findings, and progress to ground in the agreed design before touching any file.
- Confirmed `~/containers/data/NanoClaw/groups/telegram_inbox/CLAUDE.md` is in the data volume (no git ancestor) — patch is live on next Madison spawn; no commit needed for that file.
- Inserted new `## Current limitation (2026-04-22 — pending mail-push-redesign Phase 4)` section between the intro paragraph and `## Triage workflow`. Spells out the M5 (Gmail MCP removed, commit 87e658b) and M6.2 (Proton bridge loopback bind) causes, lists the four future `mcp__inbox__*` write tools, and tells Madison three concrete behaviors: (a) reads still work, (b) for any write surface the recommendation and tell Jeff explicitly she can't execute it, (c) capture Jeff's action commands in `_digests/<date>.md` for batch application post-Phase-4.
- Replaced the stale "Actions" subsection under *Inboxes to sweep* — the one that previously listed `mcp__gmail__send_email`, `mcp__gmail__modify_email`, `mcp__gmail__read_email`, and direct ProtonMail IMAP/SMTP via bridge.
- Replaced the stale "Email actions" line in the Tools list near the bottom with the same Phase-4 pointer.
- Grep swept for residual `mcp__gmail|imap|smtp|bridge|protonmail-bridge` matches: only my new explanatory text and the auto-labeler scheduled-task roster row remain. The roster row is correctly scoped to Phase 8.

### Test results

| Test | Status | Notes |
|---|---|---|
| Verify no residual stale write-tool references | pass | Only the new `## Current limitation` section, the neutralized Actions/Tools entries, and the Phase-8-owned auto-labeler roster row remain. |

### Reboot check (for next session)

1. **Where am I?**
   Phase 1 complete. Madison's CLAUDE.md no longer claims Gmail write tools or direct Proton bridge access. Ready to start Phase 2.

2. **Where am I going?**
   Phase 2 — rule engine in mailroom (types, loader, matcher, evaluate, CLI validate, unit tests, schema doc). All code under `~/Projects/ConfigFiles/containers/mailroom/mailroom/src/rules/` (stow-managed; not in this nanoclaw repo). Then Phase 3 (apply + events), Phase 4 (MCP writes), Phase 5 (subscriber branch), Phase 6 (initial rules.json + accounts.json), Phase 7 (Madison rewrite), Phase 8 (retire legacy), Phase 9 (verify + graduate).

3. **What is the goal?**
   Replace Madison's polling-based triage with event-driven push from mailroom. Unified cross-source rules engine evaluates at ingest, emits urgent/routine/silent events, owns all email write operations behind an `mcp__inbox__*` surface.

4. **What have I learned?**
   - The Madison CLAUDE.md file is in `~/containers/data/NanoClaw/groups/telegram_inbox/` — a data volume, not under git. Edits land live on next spawn; commit-on-this-branch language in tracker.md only applies to lode bookkeeping for that phase.
   - Beyond the two lines the plan called out (41, 274), the stale references were paragraph-shaped (the whole "Actions" subsection plus its "Why the split" paragraph that justified backend-tool writes). Worth reading the full file before assuming line targets are exhaustive.
   - The auto-labeler scheduled-task roster row at line 296 is owned by Phase 8 (retire legacy), not Phase 1.1. Leaving it intact preserved scope.

5. **What have I done?**
   - Three Edit operations on Madison's CLAUDE.md.
   - Tracker checkbox for 1.1 flipped; "Current status" rewritten to point at Phase 2.1 as the next action.
   - This progress entry.

## Next steps (to resume)

1. **Phase 2.1** — `src/rules/types.ts` in the mailroom repo. Define `Rule`, `Predicate`, `Actions`, `AccountEntry`, `AccountsFile`, `RulesFile`. Refer to `tracker.md` AC-1 and AC-2 for the schema contract.
2. Phases 2.2–2.7 in order — loader, matcher, evaluate, CLI validate, unit tests, schema.md.
3. Then 3 → 9 in order; 3 (apply + events) and 4 (MCP writes) are the next heaviest.

The decisions table in `tracker.md` is the implementation contract. If a decision seems wrong mid-build, stop and re-plan rather than drift.
