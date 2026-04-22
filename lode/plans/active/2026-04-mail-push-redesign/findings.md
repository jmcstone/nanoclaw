# Findings — Mail Push Redesign

## Diagnostic discoveries (2026-04-22 design session)

### DocuSigns are in the store — live poller is NOT broken

Earlier I hypothesized that Proton Bridge server-side filters were moving DocuSigns out of INBOX before the live poller could see them, and proposed widening the live-poller scope to `All Mail`. **That diagnosis was wrong.**

Correct finding: DocuSigns arrive at INBOX, the live poller walks INBOX every 2 min, and they ARE ingested. Three DocuSigns arrived today at 14:42–14:43 UTC and are in the store:

```
2026-04-22T14:43:53  dse@docusign.net  Action needed by JEFFREY STONE: Please sign your 2025 tax documents
2026-04-22T14:42:08  dse@docusign.net  Action needed by JEFFREY M AND MARJORIE C STONE: Please sign your 2025
2026-04-22T14:42:07  dse@docusign.net  Action needed by JEFFREY M AND MARJORIE C STONE: Please sign your 2025
```

**Implication for the plan**: no live-poller scope change needed. Keep INBOX. The "optional per-label whitelist" remains available as a future config knob but is not a v1 requirement.

**The actual DocuSign miss is downstream of ingestion** — either subscriber dispatched-and-Madison-mis-classified, or Madison hit a tool_use_error on stale `mcp__gmail__modify_email` references and exited mid-triage (see CLAUDE.md staleness below). The urgent-rules fast-lane bypasses this classification dependency by forcing `inbox:urgent` at ingest for sender matches, regardless of Madison's judgment.

### imap_autolabel.py is ephemeral and mostly dormant

The script lives in Madison's group folder at `/workspace/group/imap_autolabel.py`. The `*/15 auto-labeler health check` task launches it as `python3 ... &` inside Madison's ephemeral container. When Madison's session ends (~30–90 seconds later), Docker tears down the PID namespace — the "daemon" dies with her.

Net effect: auto-labeler is running maybe 5–10% of the time. Most of your Proton mail has been staying unlabeled in INBOX, which means the "labeler vs live-poller race" I was worried about is barely a real race. No emergency fix needed; the redesign simply supersedes it.

Evidence:
```
$ docker exec mailroom-ingestor-1 pgrep -af imap_autolabel
(no process)

$ pgrep -af imap_autolabel        # host
(no process — only my own shell noise)
```

### Madison's CLAUDE.md references tools she lost in M5/M6.2

**M5 (2026-04-21, commit 87e658b)** removed the Gmail MCP entirely from `container/agent-runner/src/index.ts`. Madison lost `mcp__gmail__{send_email, modify_email, read_email}`. But her CLAUDE.md at lines 41 and 274 still claims she has them.

**M6.2 (2026-04-21)** bound the Proton bridge ports to `127.0.0.1` loopback. Madison's container on Docker's default bridge can no longer reach `host.docker.internal:1143` (the gateway isn't the loopback interface). So her CLAUDE.md line "ProtonMail IMAP/SMTP (via bridge) for Proton writes" also doesn't work.

**Net reality**: Madison has been silently unable to write to either Gmail or Proton for ~18 hours. When she claims "I'll update the Gmail label," she's hallucinating tool availability — the tool isn't in her toolset, calls fail.

**Likely consequence**: silent tool_use_error mid-triage, Madison exits without posting. This is a plausible cause of the "Madison didn't surface DocuSigns this morning" symptom.

**Fix planned**: Phase 1.1 patches CLAUDE.md before anything else in this plan, to stop ongoing silent failures.

### Backfill "errors" were mostly skips

Back-probe with instrumented logging on 2026-04-22 confirmed all 40 errors from the fresh Proton All-Mail walk are `Empty body` (attachment-only, calendar invites, read-receipts, inline-image-only, unhandled multipart types). Not pipeline failures — legitimate content-free mail with no searchable body text.

Reclassified as `skipped` (committed in mailroom as `ddf9882`). Future backfill runs reserve `errors` for actual failures.

### Proton Bridge gluon cache is 3.3 GB local

Earlier I thought the bridge was a thin proxy that round-trips every read to Proton's servers. Wrong. The bridge maintains `/root/.local/share/protonmail/bridge-v3/gluon/` — a 3.3 GB local SQLite mirror (one `.db` file per account). Backfill reads are genuinely local-to-local (bridge reads gluon, decrypts PGP in-memory, serves via localhost IMAP). The observed ~17 msg/sec sustained rate is dominated by per-message work (IMAP framing + MIME parse + HTML→Markdown + SQLCipher insert), not network.

Adjusted backfill tuning committed (`bcfe2f2`): default batch size 50 → 200, dropped 250 ms inter-batch sleep.

### Madison's actual spawn count is ~180/day

Mostly from the `*/15` auto-labeler health check (96/day) which is doing almost nothing useful. Plus per-arrival pushes (~40–80), `:07` hourly triage (24), and morning brief (1). Redesign target: ~10–25/day by retiring the health check + hourly triage and letting push events drive dispatches.

## Technical design decisions

### Why event-driven push beats `*/15` polling

Jeff raised the overlap concern. Polling every 15 min still wakes Madison when nothing happened. Push-driven: zero wakeups on idle days, sub-minute urgent latency, and the ingestor already emits events — we just weren't routing them with priority awareness.

Tradeoff: event path has to be reliable (mailroom restart/backfill window = no push). Mitigation: `7 AM morning brief` task remains as daily recovery sweep.

### Why unified rules.json beats per-source files

Jeff considered splitting by source. Most rules are source-agnostic (urgent senders, security alerts, QCM notifications). Per-source files would duplicate those. Unified with `source` / `account` / `account_tag` predicates gives same expressive power without duplication. When Jeff eventually adds a second work Gmail or a contractor Proton, tagged rules (`account_tag: "work"`) auto-cover the new account without edits.

### Why accumulate actions + last-writer-wins (not first-match-wins)

Jeff's canonical pattern is "broad rule + narrow override." First-match would force him to always write the narrow rule first, which is unintuitive — he wants to add new rules at the bottom (normal workflow). Accumulate-and-override matches that workflow. Downside: resolution rules for conflicts (`urgent` vs `auto_archive`) need explicit documentation.

### Why three label primitives

Single `label` field covers ~80% of cases (sender → label). But real emails carry multiple dimensions (a Prime Video receipt is both Shopping and Entertainment). `add_label` handles additive dimensions. `remove_label` handles explicit subtraction when an override rule wants to strip a broad rule's label without re-listing everything. All three interact consistently with a `Set<string>` mental model.

### Why mailroom owns writes (not direct MCP on Madison)

Two forces push this way:
1. Jeff's ask: "1 rulebook across both" — means one apply layer too. Mailroom is the natural home.
2. Security: credentials (Gmail OAuth, Proton bridge password) stay in one container. Agent container stays credential-free.

Cost: implementing send (`send_reply` / `send_message`) requires RFC 5322 assembly, SMTP clienting (Proton), Gmail API send — ~200 LOC. Not trivial but not large.

### Why soft-delete only (Trash) in v1

Proton + Gmail both give 30-day Trash retention. Soft-delete = recoverable. Hard-delete (expunge/permanent) is easy to regret on a false-positive rule match. Earn trust before offering it.

### Why rate limits on send

Madison interacts with untrusted email content. Prompt-injection risk is real. Rate limits (20/hour/account) cap blast radius if she's coerced. Plus: send-log.jsonl gives full audit trail for post-incident analysis.

## Deferred / out-of-scope for this plan

- **Live-poller folder whitelist** (walking beyond INBOX): not needed for DocuSigns; defer until a concrete need surfaces.
- **Bridge volume migration** to `~/containers/data/protonmail/`: kept as a follow-up after this plan completes. Independent of push redesign.
- **Multi-auth infrastructure**: multiple Gmail accounts (OAuth sets per-account), multi-user Proton bridge logins. Flagged but not v1. The account_tag model already supports it in schema; infrastructure work happens when the second account lands.
- **Hard-delete tool**: explicitly deferred.
- **Send confirmation-required flag**: nice-to-have for safety rails; left as a follow-up knob.

## Resources

- mailroom-extraction tracker: `lode/plans/active/2026-04-mailroom-extraction/tracker.md`
- Parent mailroom codebase: `~/Projects/ConfigFiles/containers/mailroom/mailroom/` (stow-managed)
- Existing auto-labeler rules to port: `~/containers/data/NanoClaw/groups/telegram_inbox/imap_autolabel.py` lines 48–77 (27-entry RULES list)
- Madison's current CLAUDE.md to rewrite: `~/containers/data/NanoClaw/groups/telegram_inbox/CLAUDE.md`
- Madison's current scheduled tasks: `~/containers/data/NanoClaw/data/ipc/telegram_inbox/current_tasks.json`
- Proton Bridge multi-user docs (for future multi-bridge expansion): https://proton.me/support/protonmail-bridge-configure-client

## Graduation pointers

Graduated 2026-04-22 (pre-Phase-9 verification so the permanent docs are ready when verification completes):

- Mailroom rule-engine architecture → [`lode/infrastructure/mailroom-rules.md`](../../infrastructure/mailroom-rules.md) (naming follows existing `lode/infrastructure/` convention rather than the `architecture/` the tracker originally proposed)
- Push-based Madison pipeline shape → [`lode/infrastructure/madison-pipeline.md`](../../infrastructure/madison-pipeline.md) (includes a Mermaid diagram of the end-to-end delivery path)
- Rules schema reference → [`lode/reference/rules-schema.md`](../../reference/rules-schema.md) (digest pointing at the canonical `mailroom/src/rules/schema.md`)

Lode map + summary updated to link them. The plan itself remains in `plans/active/` until Phase 9 end-to-end verification completes.
