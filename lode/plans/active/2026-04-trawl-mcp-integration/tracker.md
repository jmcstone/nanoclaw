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

### Phase 1 — Trawl MCP server skeleton
- [ ] Add FastMCP dependency to `pyproject.toml`
- [ ] Create `src/trawl/cli/mcp_server.py` — build FastMCP server from `ToolRegistry`
- [ ] Add `trawl mcp-server --host --port` Typer subcommand in `src/trawl/cli/app.py`
- [ ] Map every `BaseTool` subclass → MCP tool (Pydantic Input schema → MCP `inputSchema`)
- [ ] Use Streamable HTTP transport
- [ ] Smoke test: `trawl mcp-server` on host, list tools from dev Claude Code via direct URL

### Phase 2 — Tier 2/3 handlers
- [ ] Implement `trawl_delegate(task, context)` — invoke internal agent loop, return distilled result
- [ ] Implement `trawl_pipeline_run(name, params)` — load pipeline from `pipelines/<name>/`, execute with iterate fan-out, return artifact path + summary
- [ ] Progress notifications for long-running tools (`crawl_links`, `deep_inspect_pages`, pipelines) via MCP streaming events
- [ ] Respect `_tool_timeout`, `_tool_confirm`, `_tool_cache_ttl` metadata

### Phase 3 — File output strategy
- [ ] Small artifacts (<1MB): return content inline in MCP tool response
- [ ] Large artifacts: write to `/app/output/<date>/<slug>/`, return path + `resource://` URI
- [ ] Document the output dir convention in Trawl's lode

### Phase 4 — Dockerize
- [ ] Add `Dockerfile` in Trawl repo — builds from `python:3.12-slim`, installs via `uv sync`, installs Playwright browsers
- [ ] Verify image size stays reasonable (<2GB ideally)
- [ ] Entrypoint: `trawl mcp-server --host 0.0.0.0 --port 8088`

### Phase 5 — Tailnet service
- [ ] Create `~/Projects/ConfigFiles/containers/trawl/trawl/docker-compose.yml`
  - tsdproxy labels (`tsdproxy.enable: true`, `tsdproxy.name: trawl`)
  - Volume mounts: `../data/trawl/cache`, `../data/trawl/output`, `../data/trawl/lancedb`
  - `env_file: ../data/trawl/env` for creds (OpenRouter, Zoho OAuth)
- [ ] Create BTRFS subvolume: `sudo btrfs subvolume create ~/containers/data/trawl` (jeff:jeff 2775)
- [ ] Run `~/Projects/ConfigFiles/bin/stow/stow-all.sh` — symlink `~/containers/trawl`
- [ ] Populate `~/containers/data/trawl/env` with OpenRouter + Zoho creds (outside git)
- [ ] `docker compose up -d` — verify tsdproxy provisions `trawl.crested-gecko.ts.net`
- [ ] Smoke test: `curl https://trawl.crested-gecko.ts.net/mcp` responds

### Phase 6 — Dev Claude Code integration
- [ ] Add `trawl` MCP server to `~/.claude.json` (type: http, url: trawl.crested-gecko.ts.net/mcp)
- [ ] Test all three tiers from dev Claude Code
  - Tier 1: `mcp__trawl__inspect_pages(urls=["https://example.com"])`
  - Tier 2: `mcp__trawl__trawl_delegate(task="find 5 academic papers on X")`
  - Tier 3: `mcp__trawl__trawl_pipeline_run(name="gop-discovery", params={"state": "florida"})`
- [ ] Validate Zoho tools work when called from dev Claude Code

### Phase 7 — NanoClaw Madison wiring (requires Madison idle on AVP)
- [ ] User confirms Madison idle on AVP
- [ ] Edit `container/agent-runner/src/index.ts` — conditionally register Trawl MCP when `trawl.enabled` is true in group config
- [ ] Implement three-mode allowlist engine (`wildcard` / `category` / `explicit`) with glob support in `excludedTools`
- [ ] At container start: fetch Trawl's `tools/list` once, expand wildcard/category rules into concrete tool names for `allowedTools`
- [ ] Add `nanoclaw group-config set <folder> trawl.<key> <value>` CLI helper for ergonomic edits
- [ ] Apply per-group defaults (see Allowlist design section) to existing groups via CLI helper
- [ ] Rebuild agent container: `./container/build.sh`
- [ ] Test from AVP: send a message asking Madison to inspect a page via `mcp__trawl__inspect_pages`

### Phase 8 — Complementary bundle items (follow-on, separate work)
Deferred from the original context-mode exploration — revisit after Trawl MCP is stable.
- [ ] Subagent output contract in container CLAUDE.md (Stream D shipped the skill; may want explicit system-prompt reference)
- [ ] `/research-dedupe` skill — shipped by Stream D in `container/skills/research-dedupe/`
- [ ] Context-mode MCP (FTS5 session memory) — only if session continuity still feels insufficient after Trawl lands
- [ ] **SearXNG backend for Trawl's `search_web`** — add `searxng` + `searxng:<category>` backend options alongside DDGS. Big win for AlgoTrader Web Researcher (academic category unlocks arxiv/semantic-scholar/crossref/pubmed). Requires: (a) JSON format enabled in SearXNG instance's `settings.yml`, (b) new `src/trawl/scraping/searxng.py` client, (c) backend dispatch in `search_web.py`, (d) `SEARXNG_URL` env var. Defaults stay on DDGS; opt-in per call or per group.

### Phase 9 — Observe and expand
- [ ] Measure AVP session: tool-call count, token usage, Trawl Grok spend, Madison context pressure
- [ ] Compare against pre-Trawl baseline (session 2026-04-20-1503: 244 WebSearch + 91 WebFetch + 172KB avg subagent)
- [ ] Expand to trading group; add AlgoTrader-specific tool allowlist
- [ ] Add Trawl MCP config to any additional dev machines / other NanoClaw instances

### Phase 10 — Lode graduation
- [ ] Create `lode/infrastructure/trawl-mcp.md` — architecture snapshot for NanoClaw's lode
- [ ] Update Trawl's own lode with the `mcp-server` subcommand design
- [ ] Update `lode/lode-map.md`, `lode/summary.md`, `lode/groups.md`
- [ ] Move plan to `lode/plans/complete/`

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

Currently in **Phase 1 — Trawl MCP server skeleton**. Planning locked in; ready to begin the FastMCP wrapper on Trawl-side. Phases 1–5 (Trawl + Ops) can run without touching Madison. Phase 7 (NanoClaw wiring) requires Madison idle on AVP.
