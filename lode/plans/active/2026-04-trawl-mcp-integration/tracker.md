# Trawl MCP Integration

Branch: `main`

## Goal

Expose [Trawl's](~/Projects/trawl) 38 research/scraping/extraction/CRM tools as a network MCP service on the tailnet at `https://trawl.crested-gecko.ts.net/mcp`, reachable from Madison (NanoClaw) containers, dev Claude Code, and any future tailnet client. Build server-first — Dockerize and expose early, then wire Madison.

## Architecture at a glance

```
                trawl.crested-gecko.ts.net/mcp  (Streamable HTTP)
                         ↑
         ┌───────────────┼───────────────┬────────────────┐
         ↑               ↑               ↑                ↑
     NanoClaw        Dev Claude      NanoClaw on      Future clients
     Madison         Code on         another          (Cursor, Zed,
     (jarvis)        dev computer    computer         Claude Desktop)
```

Server runs as a Docker service on jarvis, follows the standard NanoClaw container pattern (stow-managed compose in ConfigFiles, data under `~/containers/data/trawl/`, tsdproxy label for Tailnet exposure).

## Three tiers of tool access

| Tier | MCP tool | Under the hood | Cost | Client sees raw data? |
|---|---|---|---|---|
| 1. Raw primitives | `inspect_pages`, `search_web`, `crawl_links`, `extract_markdown`, `zoho_insert_records`, ... (all 38) | Direct `ToolCls().execute(Input(...))` | No LLM except `deep_inspect_pages` and `delegate_task` (verified — extract_* tools are pure parsers) | Yes |
| 2. Delegate | `trawl_delegate(task, context)` | Trawl's internal Grok 4.1 agent loop | Grok tokens (cheap) | No — distilled result only |
| 3. Pipeline | `trawl_pipeline_run(name, params)` | Executes a `pipelines/<name>/` flow with iterate fan-out + resume | Grok tokens + pipeline modules | No — final artifact |

Clients pick per task. Ad-hoc judgment work → Tier 1. Bulk mechanical → Tier 2. Known repeating flows → Tier 3.

## Repos touched

| Repo | Path | What changes |
|---|---|---|
| Trawl | `~/Projects/trawl/` | New `trawl mcp-server` subcommand + FastMCP wrapper + Dockerfile |
| ConfigFiles | `~/Projects/ConfigFiles/containers/trawl/trawl/` | New docker-compose.yml, stow-managed |
| Data (not in git) | `~/containers/data/trawl/` | New BTRFS subvolume (cache, output, lancedb, env) |
| NanoClaw | `~/containers/nanoclaw/` | agent-runner MCP registration + per-group allowlist |

## Safety constraint

Madison is actively running AVP research. All Trawl-side and Ops-side work (Phases 1–5) is safe — none of it touches Madison's running containers. Phase 7 (NanoClaw wiring) modifies container config and requires a container rebuild; do not run it while Madison is active on AVP.

## Phases

### Phase 1 — Trawl MCP server skeleton  ✅
- [x] FastMCP added to `pyproject.toml` (95cb5af in trawl)
- [x] `src/trawl/cli/mcp_server.py` wraps `ToolRegistry` via `_TrawlBridgeTool`
- [x] `trawl mcp-server --host --port --reload` subcommand
- [x] All 38 BaseTool subclasses exposed; Pydantic Input → MCP inputSchema
- [x] Streamable HTTP transport (FastMCP 3.2.4)

### Phase 2 — Tier 2/3 handlers  ✅
- [x] `trawl_delegate(task, model, max_iterations, context)` — invokes Trawl's agent engine
- [x] `trawl_pipeline_run(name, params, model, step_overrides, resume_from)` — in-process engine call
- [x] Progress notifications via FastMCP `Context.report_progress`
- [x] Model override ContextVar (`trawl.llm.override`) consumed by all three providers

### Phase 3 — File output strategy  ✅
- [x] Inline content in MCP tool response (default)
- [x] Trawl writes larger artifacts under `jobs/{pipeline}/{stamp}/`; clients read from shared mount

### Phase 4 — Dockerize  ✅
- [x] Dockerfile + .dockerignore (python:3.12-slim + uv)
- [x] Image size 1.47 GB (from 9.5 GB after CPU-torch pin via `tool.uv.sources`)
- [x] Entrypoint `uv run --no-sync` + CMD `trawl mcp-server --host 0.0.0.0 --port 8088`

### Phase 5 — Tailnet service  ✅
- [x] `~/Projects/ConfigFiles/containers/trawl/trawl/docker-compose.yml` with tsdproxy labels + `tsdproxy_default` network + `tsdproxy.container_port: 8088` (learned: services without host-port publishing need both)
- [x] BTRFS subvolume at `~/containers/data/trawl/` (BTRFS inode 256 confirmed)
- [x] Stow-managed (`~/containers/trawl/ → ConfigFiles/...`)
- [x] Secrets via dcc + env-vault; compose declares `environment:` passthrough (OPENROUTER_API_KEY, ZOHO_*, etc.)
- [x] `dcc up trawl` brings up `trawl.crested-gecko.ts.net`
- [x] `curl /mcp` + full MCP handshake validated

### Phase 6 — Dev Claude Code integration  ✅
- [x] MCP Inspector from dev machine validates all three tiers
  - Tier 1: `mcp__trawl__inspect_pages(urls=["https://en.wikipedia.org/wiki/Austin,_Texas"])` → 185KB structured output with 33 tables, 94 images, screenshot
  - Tier 2: `mcp__trawl__trawl_delegate(task="say hello in 5 words")` → Grok 4.1-fast response, model_used correctly reported
  - Tier 3 untested end-to-end (pipeline engine validated in tests)

### Phase 7 — NanoClaw Madison wiring  ✅
- [x] agent-runner adds conditional Trawl MCP registration + three-mode allowlist engine
- [x] Host-side plumbing (`src/container-runner.ts`, `src/index.ts`, `src/task-scheduler.ts`) forwards `group.containerConfig.trawl` into container stdin
- [x] `scripts/group-config.ts` CLI + `scripts/trawl-defaults.ts` per-group defaults
- [x] Applied defaults to all four groups (AVP, main, trading, inbox)
- [x] Agent container rebuilt
- [x] `systemctl --user restart nanoclaw`
- [x] Validated end-to-end: Madison in main group successfully called `mcp__trawl__inspect_pages` on Wikipedia Austin page

### Phase 7.1 — Post-deploy fixes  ✅
- [x] Fix: `fetchTrawlTools` must do full MCP handshake (initialize → notifications/initialized → tools/list with session id); bare `tools/list` returns HTTP 400
- [x] Fix: registration is atomic — register `mcpServers.trawl` only after allowlist resolves non-empty
- [x] Fix: remove `query_data` / `list_data` from base exclusions — these are the client-facing handle-resolution path, not internal plumbing
- [x] Add `container/skills/trawl-handles/` skill documenting the handle return pattern
- [x] /simplify pass on NanoClaw changes: removed regex glob compile, stringly-typed prefix, narrative comments; collapsed three-mode branches

### Phase 8 — Complementary bundle items  🟡
Partial — some items shipped, some deferred.
- [x] `container/skills/research-dedupe/SKILL.md` (shipped)
- [x] `container/skills/subagent-output-contract/SKILL.md` (shipped)
- [x] `container/skills/trawl-handles/SKILL.md` (shipped)
- [ ] Subagent output contract referenced explicitly from system prompt (may not be needed — progressive disclosure loads it on demand)
- [ ] Context-mode MCP (FTS5 session memory) — observe first; only add if session-continuity gap remains after Trawl adoption stabilizes
- [ ] **SearXNG backend** (Task #11) — defer; DDGS is sufficient for AVP workload today

### Phase 9 — Observation  🟡 (in progress)
- [x] Pre-Trawl baseline captured: `baseline-pre-trawl.txt` — 369 web calls / session (269 WebSearch + 100 WebFetch), 14 subagents avg 200KB, 16 duplicate URL fetches
- [x] Live tool-call monitor pattern established — see "Observation harness" section below
- [ ] Collect post-Trawl baseline after 1-2 weeks of organic Madison use (run `baseline-measure.sh` on a fresh AVP session)
- [ ] Compare mcp__trawl__* call counts vs native WebSearch/WebFetch usage
- [ ] Quantify Grok spend via OpenRouter dashboard
- [ ] Qualitative: does Madison reach for Trawl organically? Evidence so far: YES for search_web + extract_markdown + get_page_data; partial for handle pattern (see progress.md day 1 observations)

### Phase 10 — Lode graduation
- [ ] Create `lode/infrastructure/trawl-mcp.md` — architecture snapshot
- [ ] Update Trawl's own lode (`~/Projects/trawl/lode/`) with the `mcp-server` subcommand design
- [ ] Update `lode/lode-map.md`, `lode/summary.md`, `lode/groups.md`
- [ ] Move plan to `lode/plans/complete/`

## Observation harness — live tool-call monitoring

Pattern developed during Phase 7 validation: tail Madison's session JSONL and filter tool_use events to a stream of tagged one-liners. Used to confirm tool-choice behavior (Trawl vs native) in real time without interrupting Madison.

### Launch

```bash
SESSDIR=/home/jeff/containers/data/NanoClaw/data/sessions/<group_folder>/.claude/projects/-workspace-group
MAIN=$(ls -t "$SESSDIR"/*.jsonl 2>/dev/null | head -1)
tail -F -n 0 "$MAIN" | while IFS= read -r line; do
  printf '%s' "$line" | jq -r --unbuffered '
    select(.type=="assistant")
    | .message.content[]?
    | select(.type=="tool_use")
    | (if (.name | startswith("mcp__trawl__")) then "✨ TRAWL"
        elif (.name | startswith("mcp__")) then "🔌 MCP"
        elif .name=="WebSearch" or .name=="WebFetch" then "🌐 NATIVE-WEB"
        else "🔧" end) + " " + .name + " " + (.input | tostring | .[0:140])
  ' 2>/dev/null
done
```

In a supervisor-style Claude Code session, wrap in the `Monitor` tool (persistent=true, timeout=3600000) so each tool call becomes a notification.

### What to look for

- **Trawl adoption rate** — count `✨ TRAWL` vs `🌐 NATIVE-WEB` over a session. If Madison is reaching for native WebSearch/WebFetch, the tool-selection skill/prompt isn't strong enough.
- **Handle-pattern usage** — `inspect_pages` → `get_page_data` sequence vs `inspect_pages` called twice on same URL. The latter means she's not leveraging the cache.
- **Duplicate fetches** — repeated URLs within a session indicate research-dedupe skill isn't firing.
- **Re-scraping across sessions** — compare URLs in today's session vs yesterday's. Should decrease as a-mem fills with prior findings.

### Caveat

The monitor only sees the MAIN session. Subagents spawn their own JSONL files under `{session-id}/subagents/*.jsonl`. For comprehensive observation, watch the subagents dir too (adds complexity; unnecessary for ad-hoc tool-choice spot checks).

## Post-deploy ops runbook

Quick references for routine operations after the initial deploy.

| Need | Command |
|---|---|
| Restart Trawl service | `cd ~/containers/trawl && dcc up trawl` (never `docker compose` directly — skips env-vault) |
| Edit Trawl secrets | `env-vault edit ~/containers/trawl/env.vault` then `dcc up trawl` |
| Update Trawl source (live-reload) | Save file in `~/Projects/trawl/src/` — container's `--reload` picks it up via the bind-mount |
| Rebuild Trawl image | `cd ~/Projects/trawl && docker build -t trawl:local .` then `dcc up trawl` |
| Change a group's Trawl config | `npx tsx scripts/group-config.ts set <folder> trawl.<key> <json-value>` |
| Reset a group to defaults | `npx tsx scripts/group-config.ts trawl-defaults <folder>` |
| Restart NanoClaw | `systemctl --user restart nanoclaw` |
| Rebuild agent container | `cd ~/containers/nanoclaw && ./container/build.sh` |
| Check Trawl health from client | `curl -sS --http1.1 -H "Accept: application/json, text/event-stream" -X POST -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}' https://trawl.crested-gecko.ts.net/mcp` |

## Allowlist design

Three-mode allowlist engine in agent-runner, picked per-group:

| Mode | Config shape | Semantics |
|---|---|---|
| `wildcard` | `{mode: "wildcard", excludedTools?: ["pattern_*"]}` | Allow all `mcp__trawl__*`, minus excluded globs |
| `category` | `{mode: "category", allowedCategories: [...]}` | Allow all tools whose `_tool_category` matches; new tools in those categories auto-included |
| `explicit` | `{mode: "explicit", allowedTools: [...]}` | Exact names only; new tools never auto-included |

### Exclusion categories

Three layered categories determine what each group excludes:

| Category | Tools | Why |
|---|---|---|
| **Base** (always excluded) | `save_*`, `write_output`, `read_file`, `memory`, `stash`, `delegate_task` | Duplicate Madison's native `Write`/`Read`/`a-mem`, or Trawl-internal state with no external use (stash, delegate_task primitive — use `trawl_delegate` Tier 2 meta-tool instead). **Note:** `query_data` / `list_data` / `get_page_data` are **kept** — they're the client-facing handle-resolution path for Trawl's large-data return pattern. |
| **Blast radius** | `zoho_*` | External mutation. Only groups whose purpose IS CRM get this. |
| **Social scraping** | `search_facebook` | Niche; excluded by default across the board, opt-in per group |

### Per-group defaults

| Group | Mode | Exclusions | Rationale |
|---|---|---|---|
| AVP (`telegram_avp`) | `wildcard` | Base + `search_facebook` | CRM ingestion is the group's purpose; full Zoho access intended |
| Jeff main (`telegram_main` / `main`) | `wildcard` | (none) | Admin-equivalent |
| AlgoTrader trading (`telegram_trading`) | `wildcard` | Base + `zoho_*` + `search_facebook` | Reading-heavy research, no CRM, no social |
| Inbox (`telegram_inbox`) | `wildcard` | Base + `zoho_*` + `search_facebook` | Lightweight reading only |
| Future new groups | `wildcard` | Base + `zoho_*` + `search_facebook` | Safe default — Zoho writes + social require explicit opt-in |

Source of truth for the exclusion lists: `scripts/trawl-defaults.ts`. Edit there; the tracker table tracks the intent.

### What Madison actually sees after exclusions

- **AVP:** 28 tools — all research + geo + YouTube + conversion + Zoho + meta
- **Trading / Inbox / future:** 21 tools — all research + geo + YouTube + conversion + meta (no Zoho, no social, no internal plumbing)
- **Jeff main:** all 40 (38 Trawl + 2 meta)

### Config shape in `registered_groups.container_config`

```json
{
  "mounts": [ ... existing ... ],
  "trawl": {
    "enabled": true,
    "mode": "wildcard",
    "excludedTools": [
      "save_*", "write_output", "read_file",
      "memory", "stash", "query_data", "list_data", "delegate_task",
      "zoho_*",
      "search_facebook"
    ]
  }
}
```

Groups without `trawl.enabled: true` don't get the MCP server registered at all — matches the existing a-mem opt-in pattern.

### Why exclude Zoho reads too

`zoho_query_records` and `zoho_inspect_module` are read-only, so excluding them is a capability-surface choice rather than a blast-radius one. We exclude the entire `zoho_*` prefix because:
- Non-AVP groups have no reason to know CRM exists
- Simpler pattern (one glob, one concept) than split read/write allowlists
- If another group ever needs CRM integration, explicit opt-in is one config edit

### Why exclude the base set (save/read/memory/etc.)

Madison has native alternatives for everything in the base exclusion set:

| Excluded Trawl tool | Madison's native alternative | Why native wins |
|---|---|---|
| `save_file`, `save_json`, `save_as_csv`, `write_output` | `Write` | Trawl's saves write to `/app/output/` inside the Trawl container — Madison's future session can't read those back. `Write` lands in her own mounted workspace where she (and future her) can find it. |
| `read_file` | `Read` | Same directory-visibility problem — `read_file` reads Trawl's isolated filesystem. |
| `memory` | `mcp__a-mem__*` (per-group ChromaDB) | a-mem has semantic search, per-group scope, and persists across Madison's sessions. Trawl's `memory` writes to a shared LanceDB Madison can't query from her own client. |
| `stash`, `query_data`, `list_data` | (no equivalent — these don't belong in her flow) | Trawl-internal plumbing. `stash` is per-invocation scratch; `query_data`/`list_data` manipulate Trawl's DataStore handle-ID indirection layer which is invisible outside Trawl's agent loop. |
| `delegate_task` | `trawl_delegate` (Tier 2 meta-tool) | `delegate_task` is the low-level primitive Trawl's own LLM uses internally. `trawl_delegate` wraps the full agent loop with explicit model override, distilled result, iteration cap, and clean return semantics. Always prefer the meta-tool from outside Trawl. |

### Future evolution

If the Trawl tool surface grows to include more write-capable external services (Stripe, Twilio, email senders), consider adding `_tool_mutating: bool = False` ClassVar to `BaseTool`. The allowlist engine could then exclude by metadata rather than naming pattern. Out of scope for v1.

## Decisions

| Decision | Rationale |
|---|---|
| MCP over Streamable HTTP (not stdio, not SSE) | Only transport that works across processes/hosts; current MCP spec; supported by all target clients |
| Server-first deployment (Docker + tsdproxy before local iteration) | User preference — faster to Madison value; accept slower MCP server iteration |
| Trawl service is stateless wrt clients (shared cache/memory/Zoho) | Simpler in v1; add per-client namespacing in LanceDB only if cross-client pollution becomes a real problem |
| Credentials live on server; never traverse MCP boundary | Contains blast radius — a compromised client container can't exfiltrate Zoho tokens |
| Tool allowlisting at client, not server | Matches existing NanoClaw pattern (a-mem); server stays role-free |
| Tailnet membership = auth; no bearer tokens in v1 | Matches existing posture for SearXNG / Karakeep / GitLab |
| Drop SearXNG integration from the Madison bundle | Redundant — Trawl's `search_web` covers it |
| Drop Firecrawl from the Madison bundle | Redundant — Trawl's scraping stack (Scrapling + patchright + browserforge) supersedes it |
| Context-mode deferred, not cancelled | Revisit if session continuity feels insufficient after Trawl lands |

## Errors

| Error | Resolution |
|---|---|

## Current status

**Phases 1–7 shipped; Phase 9 (observation) in progress.**

Trawl MCP service is live at `https://trawl.crested-gecko.ts.net/mcp` and reachable from all Madison containers plus dev Claude Code. 12 commits landed across three repos (Trawl, ConfigFiles, NanoClaw). Validated end-to-end in production:
- AVP: search_web + extract_markdown + batch queries; organic Trawl preference confirmed
- Main: inspect_pages + get_page_data handle-drilldown pattern confirmed

Remaining work is observational (Phase 9) and graduation (Phase 10). No code changes required to meet the plan goal. Deferred items (SearXNG backend, hosted admin UI, cache tools/list, fetcher/LLM decoupling, registerMcpServer helper) are follow-ups logged in the project task list (#11, #12, #14–17).
