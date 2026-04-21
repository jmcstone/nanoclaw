# Trawl MCP Integration — Progress Log

## 2026-04-20

### Exploration phase (morning)
- **15:00** — Plan opened as context-mode integration. Compared RTK vs context-mode; chose context-mode first.
- **15:20** — User flagged Madison's live AVP research workload as the validation target; pivoted scope.
- **15:30** — Analyzed Madison's actual session data: 335 web calls across 14 subagents, main session dominated by Edit/Read cycles on scraped CSVs. Validated that web research is the bottleneck.
- **15:45** — Surveyed alternatives: Firecrawl (self-host heavy, 12GB RAM, loses Fire-engine), Exa (cloud, $10-300/mo), Tavily, Perplexity. Considered self-hosted SearXNG (already running on tailnet) + self-hosted Firecrawl.
- **16:00** — User introduced existing project Trawl — LLM-powered web research CLI at `~/Projects/trawl` with 40+ tools, already driving Zoho CRM ingestion. User runs Trawl on Grok 4.1 for cost; Madison on Claude for judgment. Complementary, not competing.
- **16:15** — Agreed Trawl is the right backbone. Read `src/trawl/tools/base.py` + `registry.py` — architecture ideal for MCP wrapping.
- **16:30** — User requested the service be usable from multiple places (dev Claude Code + multiple NanoClaw hosts). Settled on tailnet-exposed MCP service at `trawl.crested-gecko.ts.net`.
- **16:45** — Verified container DNS resolves `.ts.net` names out of the box (busybox test). No extra Docker config needed.
- **17:00** — User chose server-first approach. Rewriting plan around Trawl MCP integration.

### Key decisions locked
- Transport: Streamable HTTP (not stdio, not SSE)
- Deployment: Docker + tsdproxy following standard NanoClaw pattern
- Auth: Tailnet membership only; no bearer tokens in v1
- State: server-global (shared cache/memory/Zoho); per-client namespacing deferred
- Credentials: server-side only; never cross MCP boundary
- Tool access: server exposes all; clients allowlist per their config (matches a-mem pattern)
- Three-tier exposure: raw primitives + `trawl_delegate` + `trawl_pipeline_run`
- SearXNG integration dropped (redundant with Trawl's `search_web`)
- Firecrawl dropped (redundant with Trawl's Scrapling stack)
- context-mode deferred pending post-Trawl evaluation

### Wave 1 launched (evening)
- **17:30** — Four background agents launched in parallel:
  - Stream A → Trawl MCP server skeleton (Trawl repo)
  - Stream B → docker-compose + BTRFS subvolume + stow (ConfigFiles + data)
  - Stream C → NanoClaw agent-runner wiring draft + group-config CLI helper
  - Stream D → `/research-dedupe` skill + subagent output contract
- **17:35** — Stream E (foreground) wrote baseline measurement harness at `baseline-measure.sh`, ran against current AVP session, saved report to `baseline-pre-trawl.txt`.

### Pre-Trawl baseline (session 89e40f9b-...)
- Main: 83 Edit · 46 Read · 41 Bash · 21 Write · 14 Agent · 9 a-mem write · 6 a-mem search · 1 WebFetch
- 14 subagents, avg 200KB, total 2.8MB
- Subagent web calls: **269 WebSearch + 100 WebFetch = 369 total**
- **85 unique URLs / 101 WebFetches → 16 duplicate fetches (Trawl cache opportunity)**

## Reboot check (5 questions)

1. **Where am I?** Phase 1 — Trawl MCP server skeleton. Planning complete; ready to implement on Trawl-side.
2. **Where am I going?** Build `trawl mcp-server` subcommand with FastMCP wrapping the tool registry, Dockerize, deploy as tailnet service via tsdproxy, then wire Madison.
3. **What is the goal?** Move Madison's 335-per-session web research calls out of Claude's expensive context into Trawl's Grok-powered agent service, reachable from any tailnet client.
4. **What have I learned?** Trawl has 40+ Pydantic-typed tools in a clean registry — MCP wrapping is ~150-200 LOC with FastMCP. Container DNS already resolves `.ts.net` names. Tailnet = cleanest reusability story. Three-tier access model (primitives / delegate / pipeline) fits the existing Trawl architecture exactly.
5. **What have I done?** Scaffolded plan directory, wrote tracker.md + findings.md + progress.md for the renamed `2026-04-trawl-mcp-integration` plan. Confirmed lode-map.md points at the new plan directory. No code written yet in either repo.
