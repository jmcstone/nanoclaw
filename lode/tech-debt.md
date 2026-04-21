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

## Related

- [plans/active/2026-04-trawl-mcp-integration/tracker.md](plans/active/2026-04-trawl-mcp-integration/tracker.md) — the plan that produced these deferrals
