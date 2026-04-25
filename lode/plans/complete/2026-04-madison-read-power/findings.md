# Findings — Madison Read Power + Session Freshness

## Diagnostic record (2026-04-22 evening)

### Trigger event

Jeff: "do i have any unread emails in my inbox?"
Madison (8:30 PM): "Nothing that needs your attention" — listed 8 items as "auto-handled (all silent)"
Jeff (8:31 PM): "my inbox only shows 3 unread emails"
Madison: confabulated tool errors ("All three errored with 'not found in INBOX or Archive'") for tool calls she couldn't have made because she doesn't know what the 3 messages are.

### Three layered failures uncovered

**1. Confabulation pattern beyond Phase 10's scope.**
Phase 10 verb tools fix bulk-action *reporting* confabulation. This incident showed a different flavor: she invented tool errors for queries she didn't run. Worse, she cited her own prior fabrications as precedent ("the same v1 limitation we hit earlier today").

**2. Stale tool-list awareness from session resume.**
Madison's capabilities list omitted ALL Phase 10 batch tools (`archive`, `label`, `add_label`, `remove_label`) plus `validate_rules` and `delete`. Root cause: nanoclaw's orchestrator persists `sessionId` per group (`src/index.ts:348`) and passes it to the SDK as `resume: sessionId` (agent-runner `:761`). Resumed conversations anchor the model's self-image to the pre-Phase-10 toolset, even though new CLAUDE.md and MCP tool list are loaded fresh. Models heavily weight conversation history over fresh system prompts.

Session rotation only fires on (a) age > `resolveSessionMaxAgeHours` OR (b) `message_count >= maxMessages`. Neither triggers on MCP-toolset change.

**3. Watermark NaN bug in `recent` tool.**
`src/store/queries.ts:63-72` (pre-fix) called `parseInt(m.source_message_id, 10)` for Proton — but `source_message_id` is the RFC 5322 Message-ID (`protonmail:<...@quoramail.com>`), not a numeric IMAP UID. `parseInt` returns NaN, reducer keeps NaN, `String(NaN) = "NaN"` gets stored. Subsequent `received_at > 'NaN'` matches everything → full backlog every sweep. Fixed in ConfigFiles `58a290f` by switching Proton strategy to `received_at` (uniform with Gmail).

The watermarks table was actually empty when checked (zero NaN rows), suggesting Madison's NaN claim was a code-path inference rather than direct observation. The bug was real but had probably never persisted bad state.

### Tool inventory (verified 2026-04-22)

12 tools registered on `mailroom-inbox-mcp-1` (per `src/mcp/server.ts:204-287`):

**Read (3):** `search` (FTS5 over subject+body, limit≤100), `thread`, `recent` (newer-than-watermark)
**Write (9):** `apply_action`, `archive`, `label`, `add_label`, `remove_label`, `delete`, `send_message`, `send_reply`, `validate_rules`

The `mcp__inbox__*` wildcard in `container/agent-runner/src/index.ts:752` permits all of them. Tool registrations also include `_meta`/`description` blocks but those weren't audited for staleness.

### Gap: no structured-query tool

Jeff's example query: "How many emails from bob@builder.com mentioned 'late payment' in body, last 6 months, count by subject."

Madison can attempt this via `search("late payment bob@builder.com")` but:
- No structured sender filter — relies on Bob's email appearing as a body token, brittle
- No date range (`since` / `until`)
- No aggregation; returns flat list, she'd tally manually
- Hard cap at 100 rows — silently truncates beyond that

The store has the data (`messages.subject`, `body_markdown`, `received_at`, joined to `senders.email_address`); FTS5 indexes the body. A `mcp__inbox__query(filters, group_by, count)` tool can answer this in one call with sub-second latency.

### Other gaps surfaced (not in scope here, filed in tech-debt.md or other plans)

- `mcp__inbox__list_inbox` for live IMAP state (separate concept; needs IMAP query, not store query)
- Madison's `CLAUDE.md` Phase 10 docs are correct but the resumed-session conversation overrides them in her self-model
- `apply_action` `not found in INBOX or Archive` for messages in Labels/* (Phase 3.1 documented limitation)
- `proton-bridge:1143` IMAP timeout under some conditions (Madison's claim, not verified)

## Operational lessons captured this session

### env-vault prefix is required for mailroom deploys

`dcc` is just a Makefile wrapper (`/usr/local/bin/dcc`) — it does NOT decrypt env.vault. Bringing up mailroom containers without `env-vault env.vault --` prefix means `INBOX_DB_KEY` is unset → both containers crash-loop with `INBOX_DB_KEY is required for inbox store encryption`.

The Phase 10.8 deploy succeeded with bare `dcc up` only because the interactive shell had env vars from a prior `env-vault` invocation already exported. Fresh shells (subagents, new tmux panes, ssh sessions) won't have them.

**Correct deploy command from `~/containers/mailroom`:**
```
env-vault env.vault -- docker compose up -d ingestor inbox-mcp
```

Note the `--` separator so `-d` reaches docker-compose, not env-vault.

Documented in `lode/lessons.md` and `lode/infrastructure/mailroom-rules.md`.

### Both ingestor + inbox-mcp need rebuild when `src/store/` changes

Files in `src/store/` (queries.ts, types.ts, db.ts, ingest.ts, watermarks.ts) are imported by both the ingestor (live polling, watermarks, message persistence) and the inbox-mcp (search/recent/thread tools). Rebuilding only one and restarting only one leaves the other running stale.

For mcp-only changes (e.g. `src/mcp/server.ts`, `src/mcp/tools/*`), only inbox-mcp needs rebuild + restart.
For ingestor-only changes (e.g. `src/proton/poller.ts`, `src/gmail/poller.ts`), only ingestor needs rebuild + restart.
For shared code (`src/store/`, `src/rules/`), both need it.

### Session resume hides new MCP tools

Documented in detail in section "Three layered failures uncovered" above. Fix is the session-toolset-hash invalidation in this plan's AC-3.

## Graduated content

The following sections from this document have been extracted to permanent lode domain files (2026-04-23, Wave 4):

- **Mirror data model, session-hash pattern, Decisions table summary, hydration phases, data-flow diagram** → `lode/architecture/madison-pipeline.md`
- **Gmail history.list incremental sync, Proton IDLE+CONDSTORE, nightly reconcile, migration orchestrator, sync wiring diagram** → `lode/infrastructure/mailroom-mirror.md`

The diagnostic record above (trigger event, three layered failures, tool inventory, gap analysis) is retained here as historical context for this plan; it is not duplicated elsewhere.

## References

- ConfigFiles commit `58a290f` — watermark NaN fix
- Phase 10 commits `834aae6` through `cf0d969` (mail-push-redesign tracker)
- `lode/lessons.md` — env-vault prefix lesson
- `lode/infrastructure/mailroom-rules.md` — deploy operational notes
- `~/containers/data/NanoClaw/groups/telegram_inbox/CLAUDE.md` — Madison persona
- Conversation log: 2026-04-22 evening Telegram thread between Jeff and Madison (8:29 PM through 8:40 PM)
