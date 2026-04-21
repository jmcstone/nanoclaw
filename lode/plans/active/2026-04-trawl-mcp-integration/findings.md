# Trawl MCP Integration — Findings

## Why this direction

### Madison's current bottleneck (measured)

From AVP session `2026-04-20T19:06Z` (57 min, 3.4M ms duration):

- **Main session:** 80 Edit · 37 Read · 25 Bash · 14 Write · 14 Agent spawns · 10 TodoWrite · 10 send_message · 9 a-mem writes · 6 a-mem searches · 1 WebFetch
- **14 subagents (28 total spawned):** **244 WebSearch + 91 WebFetch** · 39 Bash · 22 a-mem ops
- **Avg subagent JSONL:** 172KB

The dominant workload is **web research in subagents: 335 fetch/search calls.** Main session is orchestration + file processing on scraped CSVs/JSONs. This is the bottleneck worth attacking.

### Why Trawl is the right tool

Trawl (`~/Projects/trawl/`) is an existing Python CLI designed for LLM-driven web research. It already has:

- **40+ tools** organized as Pydantic-typed `BaseTool` subclasses
- **Tool registry** with `get_llm_schemas()` producing OpenAI function-calling format (one-line transform to MCP)
- **Async `execute()`** methods matching MCP's async model
- **Scrapling + curl-cffi + patchright + browserforge** — modern anti-detection scraping stack
- **ddgs** for search, **LanceDB + sentence-transformers** for vector memory
- **OpenRouter/Grok 4.1 as default LLM** — cheap compared to Claude, preserves Madison's budget for high-judgment work
- **Zoho CRM tools** — Madison can push AVP research straight to CRM
- **Pipeline engine** with iterate fan-out, resume — e.g. `pipelines/gop-discovery/` already exists
- **Already running in Jeff's workflow** — well-understood, maintained

### Why not other options

- **Exa (cloud):** $10-300/mo depending on AlgoTrader scale. Good quality, but self-hosted Trawl is $0 + more control.
- **Firecrawl (self-host):** 12GB RAM commitment, loses Fire-engine anti-bot layer when self-hosted. Redundant with Trawl's scraping stack.
- **SearXNG direct integration:** Redundant — Trawl has `search_web` using ddgs; can extend to call SearXNG if needed.
- **context-mode:** Valuable for session memory but doesn't solve the 335-call bottleneck. Deferred.
- **RTK:** Bash isn't the bottleneck (64 calls vs 335 web).

## Trawl tool inventory (authoritative — 38 tools)

Generated from `registry.get_all()` on 2026-04-20. Grouped by `_tool_category` (the decorator-declared category, not file-path).

### `search` (5)
`search_web`, `list_counties`, `nearby_cities`, `regional_search`, `search_facebook`

### `scraping` (8)
`crawl_links`, `deep_inspect_pages`, `extract_documents`, `extract_json`, `extract_links`, `extract_markdown`, `extract_text`, `get_page_data`, `inspect_pages`

Note: `inspect_pages` is plural — takes a list of URLs. No singular `inspect_page` tool exists.

### `conversion` (2)
`convert_to_csv`, `convert_to_json`

### `filesystem` (5)
`read_file`, `save_as_csv`, `save_file`, `save_json`, `write_output`

Note: `write_output` — not `save_to_output` (fixed from initial exploration).

### `data` (5)
`calendar`, `list_data`, `memory`, `query_data`, `stash`

Note: tool is named `memory`, not `memory_tool`. `scratchpad` is a registered alias pointing at `memory`.

### `youtube` (4)
`youtube_channel_info`, `youtube_channel_videos`, `youtube_search`, `youtube_video_info`

### `zoho` (7)
`zoho_coql`, `zoho_insert_records`, `zoho_inspect_module`, `zoho_query_records`, `zoho_setup_module`, `zoho_update_records`, `zoho_upsert_records`

### `agent` (1)
`delegate_task`

Note: this is the internal primitive Trawl's own LLM uses for sub-agent fan-out. Distinct from the `trawl_delegate` MCP tool being built in Stream A2, which is a higher-level wrapper.

### LLM-using tools — exactly 2 (verified by Stream A2)

These tools invoke Trawl's LLM provider internally. They are the ONLY tools that benefit from a per-call `model` override over MCP:

- `deep_inspect_pages` — LLM-driven inspection + analysis
- `delegate_task` — spawns LLM sub-agents

Earlier assumption that `extract_*` tools used LLMs was wrong: `extract_json`, `extract_documents`, `extract_text`, `extract_links`, `extract_markdown` are all pure HTML/JSON parsers with zero LLM calls. Stream A2 added `test_non_llm_tools_do_not_expose_model_param` as a regression test to lock this distinction in.

The MCP server uses an explicit `LLM_USING_TOOL_NAMES` allowlist (not a name regex) to decide which tools expose the `model` inputSchema parameter. New LLM-using tools must be added there deliberately.

All other tools (search/fetch/conversion/filesystem/zoho/youtube) are purely mechanical and don't accept `model`.

## BaseTool architecture (`src/trawl/tools/base.py`)

```python
class BaseTool(ABC):
    class Input(BaseModel): ...
    class Output(BaseModel): ...
    _tool_name: ClassVar[str]
    _tool_category: ClassVar[str]
    _tool_description: ClassVar[str]
    _tool_timeout: ClassVar[float] = 30
    _tool_confirm: ClassVar[bool] = False
    _tool_cache_ttl: ClassVar[float] = 0
    _tool_batch: ClassVar[bool] = False
    _tool_disk_cache: ClassVar[bool] = False

    @abstractmethod
    async def execute(self, input: Input) -> Output: ...

    @classmethod
    def get_llm_schema(cls) -> dict[str, Any]:
        # Returns OpenAI function-calling format with Pydantic JSON Schema
```

Translation to MCP is trivial: OpenAI `function.parameters` → MCP `inputSchema`, rest of metadata surfaces as tool description.

## Tailnet / DNS findings

- **Host resolv.conf** includes `search crested-gecko.ts.net` domain
- **Tested: docker containers on jarvis resolve Tailscale `.ts.net` names automatically.** Verified with busybox: `search.crested-gecko.ts.net → 100.68.185.34` from inside a fresh container. Nameserver was `100.100.100.100` (Tailscale MagicDNS) with zero extra Docker config.
- **Result:** agent containers can reach `trawl.crested-gecko.ts.net` out of the box. No `host.docker.internal` needed.
- **Dev machine reachability:** anything on the tailnet resolves the same URL. Moves between hosts if we update tsdproxy label.

## Secrets pattern — dcc + env-vault + compose passthrough

Jeff's containers stack uses `/usr/local/bin/dcc` on top of `make -f docker-compose.mk`. When `dcc up <service>` runs:

1. Reads `env.vault` from the compose directory (encrypted with `env-vault`, AES-256, header `env-vault;1.0;AES256`).
2. Invokes `env-vault env.vault -- docker-compose up` — decrypts at runtime and injects values into **the docker-compose process environment** (the shell running docker compose).
3. docker-compose passes those env vars **into the service container ONLY if the compose explicitly declares them**.

### Critical passthrough step

Decrypted env-vault values sit on the docker-compose shell. They do NOT automatically reach the container. Each variable must be named in the service's `environment:` section:

```yaml
services:
  trawl:
    environment:
      - OPENROUTER_API_KEY      # empty form = pass through from host env
      - ZOHO_CLIENT_ID
      # etc.
```

The `- VAR` form (no `=value`) means "pull VAR from the parent shell's environment." Karakeep uses the equivalent `VAR: ${VAR}` interpolation form — both work.

### Rules for new services

- **Always use `dcc up` / `dcc restart`**, not raw `docker compose`. Bypassing dcc skips env-vault decryption and leaves the container blind.
- **Add secrets to `env.vault`** via `env-vault edit env.vault` — then commit the encrypted file.
- **Declare the var in compose's `environment:`** — otherwise env-vault populates the shell but nothing reaches the container.
- **Non-secret config** can use `.env.<environment>` files (dcc's `--env` flag).

### Failure mode

If you `docker compose up` directly instead of `dcc up`, the shell has no env vars, docker-compose sees none, and the container starts with empty secrets. Trawl's `build_engine` calls `sys.exit(1)` when `OPENROUTER_API_KEY` is missing, which causes "requires a fetcher but none was injected" errors from any stateful tool. Always use `dcc`.

Trawl's secrets: `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REFRESH_TOKEN`. See `~/Projects/ConfigFiles/containers/trawl/trawl/.env.example` for the full list.

## tsdproxy network + port convention (learned during deploy)

Two requirements for a service to be reachable through tsdproxy WITHOUT publishing a host port:

1. **Attach to `tsdproxy_default` network** — services on their own bridge can't be reached across Docker bridges. Add the external `tsdproxy_default` network as a sibling to the service's own `default`.
2. **`tsdproxy.container_port` label** — tells tsdproxy which port inside the container to proxy to.

Services that publish host ports (searxng, karakeep, paperless, etc.) skip both — tsdproxy reaches them via `host.docker.internal:<published-port>`. Services like gitlab, siftly, neural-finance, and now trawl use the network + label pattern.

Trawl's compose ended up matching gitlab's shape:

```yaml
services:
  trawl:
    networks:
      - default
      - tsdproxy
    labels:
      tsdproxy.enable: true
      tsdproxy.name: "trawl"
      tsdproxy.container_port: 8088

networks:
  default:
  tsdproxy:
    external: true
    name: tsdproxy_default
```

Error pattern if missing either piece:
- No label: `WRN No ports configured  module=proxymanager  proxyname=<name>`
- No network: `INF Trying to auto detect target URL  try=N` (repeats, never succeeds)
- Both wrong: both warnings in sequence

## NanoClaw compose / persistence pattern (locked)

- **Compose source:** `~/Projects/ConfigFiles/containers/<service>/<service>/docker-compose.yml`
- **Stow symlink:** `~/containers/<service>` → managed by `~/Projects/ConfigFiles/bin/stow/stow-all.sh`
- **Data:** `../data/<service>/` (relative) resolves to `~/containers/data/<service>/` — BTRFS subvolume, `jeff:jeff 2775`, hourly snapshots, NAS-backed via iSCSI
- **Tailnet exposure:** `tsdproxy.enable: true` + `tsdproxy.name: <shortname>` labels

Confirmed against `searxng`, `karakeep`, `tsdproxy` itself. Trawl follows the identical pattern.

## MCP transport choice: Streamable HTTP

| Transport | Pros | Cons | Use here? |
|---|---|---|---|
| stdio | Simple, low overhead | Subprocess per client, local only | No |
| SSE (legacy) | Network-capable | Being deprecated | No |
| **Streamable HTTP** | Current spec, supports progress notifications, works across hosts | Slightly more plumbing | **Yes** |

FastMCP (Python SDK) supports Streamable HTTP. Confirmed supported by Claude Code (HTTP MCP server type), NanoClaw agent-runner.

## Draft MCP server skeleton

```python
# src/trawl/cli/mcp_server.py
from fastmcp import FastMCP
from trawl.tools.registry import get_registry

def build_server() -> FastMCP:
    registry = get_registry()
    registry.discover("trawl.tools.builtin")
    mcp = FastMCP("trawl")

    for name, cls in registry.get_all().items():
        _register_tool(mcp, cls)

    mcp.tool(name="trawl_delegate")(delegate_handler)
    mcp.tool(name="trawl_pipeline_run")(pipeline_handler)
    return mcp

# src/trawl/cli/app.py — new subcommand
@app.command("mcp-server")
def mcp_server(host: str = "0.0.0.0", port: int = 8088):
    build_server().run(transport="streamable-http", host=host, port=port)
```

Rough LOC estimate: ~150-200 lines total for Phase 1 (server + schema bridge + entry point).

## Open questions for Phase 1-2

1. **FastMCP version pinning** — which version supports Streamable HTTP cleanly? Check before adding to `pyproject.toml`.
2. **`delegate_task` tool vs `trawl_delegate` MCP tool** — Trawl already has an internal `delegate_task` for sub-agent delegation. Confirm naming doesn't collide when exposed via MCP.
3. **Progress notifications for pipelines** — pipelines have their own event emitter in `src/trawl/events/`. Plumb that through MCP streaming notifications?
4. **Concurrent pipeline runs** — pipelines write to `output/<name>/state.json`. Do two concurrent runs of the same pipeline collide? Check `src/trawl/pipeline/`.
5. **Playwright in container** — Docker image needs Chromium + Playwright deps. Either use `mcr.microsoft.com/playwright/python` base or install manually. Decision in Phase 4.

## File output strategy (draft)

Three cases:

| Artifact size | Strategy |
|---|---|
| Inline-safe (<1MB, textual) | Return content in MCP tool response `content` field |
| Medium (1-50MB) | Write to `/app/output/<date>/<slug>/`, return path + `resource://` URI; client fetches via `GET /artifacts/<path>` endpoint added alongside MCP |
| Large (>50MB, e.g. crawl dumps) | Same as medium but also offer mount path for clients with shared filesystem access |

For NanoClaw Madison: mount `~/containers/data/trawl/output/` into the agent container as `/workspace/extra/trawl-output/` read-only. Madison reads large artifacts directly from disk. For dev Claude Code: use the HTTP resource endpoint.

## Per-group allowlisting pattern

Existing precedent in agent-runner: a-mem is conditionally registered based on mount presence. Extend that to per-tool allowlisting:

```ts
// container/agent-runner/src/index.ts
if (groupConfig.trawl?.enabled) {
  mcpServers.trawl = {
    type: 'http',
    url: 'https://trawl.crested-gecko.ts.net/mcp',
  };
  for (const toolName of groupConfig.trawl.allowedTools) {
    allowedTools.push(`mcp__trawl__${toolName}`);
  }
}
```

Group config stored in `registered_groups.container_config` JSONB column. Matches existing per-group config pattern.

## Resources

- Trawl repo: `~/Projects/trawl/`
- Trawl lode: `~/Projects/trawl/lode/`
- FastMCP docs: https://github.com/jlowin/fastmcp
- MCP spec: https://spec.modelcontextprotocol.io/
- Existing service patterns: `~/Projects/ConfigFiles/containers/searxng/`, `~/Projects/ConfigFiles/containers/karakeep/`, `~/Projects/ConfigFiles/containers/tsdproxy/`
- Related lode: `lode/infrastructure/a-mem.md` (conditional MCP registration precedent), `lode/infrastructure/persistence.md` (BTRFS convention)
