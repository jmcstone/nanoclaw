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

## Reboot check (for next session)

1. **Where am I?**
   Design phase complete. Implementation not started. On branch `mail-push-redesign`, clean working tree, plan committed. Next action is Phase 1.1: patch Madison's stale CLAUDE.md.

2. **Where am I going?**
   Through phases 1–9 in `tracker.md` to land a push-driven, rules-engine-powered mail triage pipeline. Target: Madison's spawns drop from ~180/day to ~10–25/day; urgent senders (DocuSign, security, QCM) surface within 1 min; routine mail batched; `imap_autolabel.py` retired.

3. **What is the goal?**
   Replace Madison's polling-based triage with event-driven push from mailroom. Unified cross-source rules engine evaluates at ingest, emits urgent/routine/silent events, owns all email write operations behind an `mcp__inbox__*` surface.

4. **What have I learned?**
   - DocuSigns ARE in store — ingest is fine.
   - Auto-labeler is mostly dormant, not causing the race I feared.
   - Madison's CLAUDE.md still references tools she lost in M5/M6.2 (likely cause of "mcp__inbox__ unavailable" false alarm and DocuSign miss via silent tool_use_error).
   - Backfill 40 "errors" were all `Empty body` — reclassified as skips.
   - Proton Bridge has 3.3 GB local gluon cache (not a thin proxy as initially thought).

5. **What have I done?**
   - Diagnostic probes: DocuSign store query (8 matches, 3 from today); auto-labeler pgrep; Madison MCP surface vs CLAUDE.md refs; backfill error analysis; bridge storage inspection.
   - Design iterations via 8 conversation turns with Jeff.
   - Branch created; three-file plan written; no code yet.

## Next steps (to resume)

1. Start with **Phase 1.1** — patch Madison's CLAUDE.md. Small, standalone, immediately reduces live failure rate.
2. Then **Phase 2** — rule engine skeleton in mailroom. Types + loader + matcher + evaluate + CLI validate + unit tests. Biggest LOC but tight scope.
3. Then **Phase 3–9** roughly in order; Phase 3 (apply + events) and Phase 4 (MCP writes) are the next heaviest. Everything after is smaller.

Read `tracker.md` + `findings.md` fully before starting. The decisions table is the contract for the implementation — if a decision seems wrong mid-build, stop and re-plan rather than drift.
