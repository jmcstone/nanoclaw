# Tech Debt Registry

Deferred work that we've consciously chosen not to do yet. One entry per item.

Each item carries:
- **Repo** — which codebase to edit
- **Scope** — rough effort estimate (S: < 2h, M: 2–8h, L: multi-session)
- **Trigger** — what evidence or event would make us un-defer this
- **Why deferred** — the explicit decision to wait

When starting work on an item, move it to an active plan (`lode/plans/active/...`) and remove from here. When the trigger fires and the item becomes urgent, update **Trigger** to `FIRED — ...` and prioritize.

---

## Trawl ecosystem

### TD-TRAWL-ADMIN-UI — Hosted admin UI
- **Repo**: `~/Projects/trawl/` (+ ConfigFiles compose for exposure)
- **Scope**: M
- **Trigger**: Enough Trawl runtime complexity (pipeline executions, cache inspection, job artifact browsing) that CLI/log-digging becomes painful. Not close today.
- **Why deferred**: CLI + `jobs/{pipeline}/{stamp}/` on disk is sufficient for one user. UI is pure ergonomics.
- **Done looks like**: tsdproxy-exposed admin at `trawl-admin.crested-gecko.ts.net` showing recent pipeline runs, cache contents, Zoho op log.

### TD-TRAWL-CACHE-TOOLSLIST — Cache `tools/list` across MCP sessions
- **Repo**: `~/Projects/trawl/`
- **Scope**: S
- **Trigger**: Noticeable container-startup latency from Madison's end, or enough container restarts per day that the handshake cost adds up.
- **Why deferred**: Per-container handshake adds ~100ms, invisible in practice.
- **Done looks like**: Trawl server caches its registered tool list at startup; MCP `tools/list` returns from cache. Invalidate on tool-registration change (rare — requires server restart anyway).
- **Open question**: Is this a server-side concern (faster `tools/list` response) or client-side (NanoClaw caches the remote tool list and reuses across container spawns)? Decide before implementing.

### TD-TRAWL-FETCHER-LLM-DECOUPLE — Fetcher/LLM decoupling
- **Repo**: `~/Projects/trawl/`
- **Scope**: L (refactor)
- **Trigger**: Another project wants Trawl's fetcher (Scrapling + patchright + browserforge stack) without the LLM dependency, or Trawl wants pluggable LLM backends without touching fetcher code.
- **Why deferred**: Current tight coupling is not blocking. No second consumer of the fetcher alone. Refactor-for-future is not worth it today.
- **Done looks like**: Fetcher usable as a standalone module (import + use, no LLM env required). LLM layer consumes fetcher output through a clean interface. Tests cover both independently.

### TD-TRAWL-REGISTER-MCP-HELPER — `registerMcpServer` helper in agent-runner
- **Repo**: `~/containers/nanoclaw/` (`container/agent-runner/`)
- **Scope**: S
- **Trigger**: Second or third MCP server registration in the agent container (beyond a-mem and Trawl) duplicates the register-if-enabled + allowlist-resolve logic.
- **Why deferred**: Only two MCP servers today (a-mem, Trawl). Two occurrences is not a pattern — extracting a helper now would be speculative.
- **Done looks like**: `registerMcpServer(name, config, allowlistResolver)` helper used by both a-mem and Trawl registration. Three-mode allowlist engine lives in one place.

---

## Historical reference — ghost task numbers

The trawl MCP tracker closes with "follow-ups logged in the project task list (#11, #12, #14–17)." No such file exists — the task list lived in planning-session context and was never persisted. The entries above replace those ghost references. Rough mapping for anyone searching:

| Ghost ID | Semantic ID | Status |
|---|---|---|
| #11 | TD-TRAWL-SEARXNG | Shipped 2026-04-20 (trawl `ce6378e`, ConfigFiles `1e09aa3`, searxng JSON-format `83d3987`) |
| #12 | TD-TRAWL-ADMIN-UI | Deferred |
| #13 | *(skipped in original)* | — |
| #14 | TD-TRAWL-CACHE-TOOLSLIST | Deferred |
| #15 | TD-TRAWL-FETCHER-LLM-DECOUPLE | Deferred |
| #16 | TD-TRAWL-REGISTER-MCP-HELPER | Deferred |
| #17 | *(prose named 5 items for 6 numbers — one item lost in planning)* | — |

If the #17 item resurfaces from memory or transcript, add it here.

---

## Mailroom / Madison ecosystem

### TD-MAILROOM-PREVIEW-RULE — `mcp__inbox__preview_rule` dry-run tool
- **Repo**: `~/Projects/ConfigFiles/containers/mailroom/mailroom/`
- **Scope**: S
- **Trigger**: Madison or Jeff draft a rule with non-trivial matcher logic (regex, combinators, account_tag scopes) and can't easily predict what it would catch. Or a rule ships that over-matches / under-matches in production.
- **Why deferred**: Schema validation (`mcp__inbox__validate_rules`) covers syntactic correctness. Semantic preview is pure bonus; the simple rules we've seeded so far (sender_contains) are intuitive enough to skip the dry-run.
- **Done looks like**: `mcp__inbox__preview_rule({rule, against?: {since?, limit?, account_id?, source?}, mode?: 'this_rule_only' | 'as_appended'})` → `{messages_evaluated, matches: [{message_id, sender, subject, applied: {...}}], summary: {matched, urgent, auto_archive, top_labels}}`. Reuses `evaluateWithProvenance`; scans recent messages from the store. `labels_at_ingest` left as `[]` in v1 (we don't preserve historical ingest-time labels).

### TD-MAILROOM-SEND-LOG-TOOL — `mcp__inbox__send_log` read tool
- **Repo**: `~/Projects/ConfigFiles/containers/mailroom/mailroom/`
- **Scope**: S
- **Trigger**: Jeff asks Madison "what have you been sending from me lately?" and she has to say "I can't see that from my sandbox." Or any incident review where the audit trail needs to flow through Madison's conversational surface.
- **Why deferred**: The file is append-only, Jeff can `tail ~/containers/data/mailroom/send-log.jsonl` himself; no urgency.
- **Done looks like**: `mcp__inbox__send_log({limit?: N, since?: ISO, from_account?})` → `{entries: [...]}` reading from `/var/mailroom/data/send-log.jsonl` with optional filters.

### TD-MAILROOM-BACKFILL-RULES — Apply rules over historical store
- **Repo**: `~/Projects/ConfigFiles/containers/mailroom/mailroom/`
- **Scope**: M
- **Trigger**: A rule lands that would have mattered retroactively (Jeff wants all historical Flex rent emails labeled), or a one-shot audit needs historical classification.
- **Why deferred**: Forward-only classification is sufficient for the redesign's goal (spawn-rate reduction). Retro-labeling is nice-to-have.
- **Done looks like**: CLI in the mailroom container that walks `store.db`, runs each message through evaluate, and applies actions via the same apply layer. Dry-run flag that just reports matches.

### TD-MAILROOM-CHANGELOG-ENFORCEMENT — Decide: mandatory vs best-effort
- **Repo**: Madison's CLAUDE.md at `~/containers/data/NanoClaw/groups/telegram_inbox/CLAUDE.md`
- **Scope**: S
- **Trigger**: Madison skipped a changelog append for her first real rule (Flex). Observe a few more edits — if she keeps skipping, audit trail degrades.
- **Why deferred**: Observe real usage a few days before tightening the prompt or relaxing the workflow.
- **Done looks like**: Either the CLAUDE.md "Mail rules maintenance" section says "changelog append is mandatory, never commit a rule edit without it" OR the section is softened with explicit guidance on what "non-trivial" means.

## Related

- [plans/active/2026-04-trawl-mcp-integration/tracker.md](plans/active/2026-04-trawl-mcp-integration/tracker.md) — the plan that produced the Trawl deferrals
- [plans/active/2026-04-mail-push-redesign/tracker.md](plans/active/2026-04-mail-push-redesign/tracker.md) — the plan that produced the Mailroom/Madison deferrals
