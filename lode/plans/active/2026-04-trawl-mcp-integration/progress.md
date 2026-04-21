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

### Wave 1 completion + Wave 2 (late evening 2026-04-20)
- **Streams A/B/C/D completed in parallel.** Stream A produced working MCP server exposing 38 tools. Stream B scaffolded compose + env.example (sudo steps deferred to user). Stream C wrote agent-runner + group-config CLI. Stream D shipped the two container skills.
- Tool-name cleanup (foreground): fixed findings doc drift (`inspect_pages` plural, `write_output` not `save_to_output`, `memory` not `memory_tool`); swept 4 pipeline prompts in gop-discovery.
- **Wave 2 (A2/A3/A4)** launched: model-override contextvar, `trawl_delegate`, `trawl_pipeline_run`, Dockerfile. All landed with 2308 tests passing. Dockerfile initially 9.48GB due to CUDA torch; fixed via `[tool.uv.sources]` → CPU wheels → 1.47GB.
- Sibling Claude's `/simplify` pass on Trawl: 981 → 622 lines in mcp_server.py, hoisted `_effective_model`, `_strip_schema`, `_tool_result` helpers.

### Phase 5–7 deploy (2026-04-20 into 2026-04-21)
- **tsdproxy integration fight**: WRN "No ports configured" when compose lacked `tsdproxy.container_port: 8088` + `tsdproxy_default` external network. Fixed both; verified handshake from dev machine via MCP Inspector.
- **dcc + env-vault finding**: docker-compose `env_file:` was a red herring. User's `dcc` wrapper runs `env-vault env.vault -- docker-compose ...` which puts secrets in the docker-compose process env; compose must declare `environment: [- OPENROUTER_API_KEY, ...]` passthrough. Documented in findings.md.
- **Test mock drift**: `container-runner.test.ts`'s `vi.mock('./container-runtime.js')` missed `CONTAINER_HOST_GATEWAY`. 309/309 after fix.
- **Host-side plumbing (Task #8)**: 5 lines across `src/container-runner.ts`, `src/index.ts`, `src/task-scheduler.ts` forwarding `group.containerConfig.trawl` into container stdin. Without this, agent-runner's Trawl block was inert.
- **MCP handshake fix**: `fetchTrawlTools` was sending `tools/list` directly — FastMCP returns HTTP 400 "Missing session ID". Fixed to do full `initialize → notifications/initialized → tools/list` handshake with `mcp-session-id` header.
- **First successful end-to-end call**: Madison in main group called `mcp__trawl__inspect_pages` on Austin, Texas Wikipedia. Returned 185KB structured output with 33 tables, 94 images, screenshot. ✨
- **Handle-pattern exclusion bug**: I'd incorrectly excluded `query_data` and `list_data` as "internal plumbing". They're the CLIENT-FACING return channel for Trawl's handle-based data store. Removed from BASE_EXCLUSIONS; shipped `container/skills/trawl-handles/SKILL.md`; re-applied defaults.

### Observation day 1 (2026-04-21 evening)
- **Live monitor pattern established**: tail session JSONL + jq filter for tool_use events → one tagged line per tool call (see tracker "Observation harness").
- **AVP test: "give me all Republican organizations in Austin Texas"** — Madison used a-mem (dedupe skill working) then called 6+ `mcp__trawl__search_web` batches (Trawl-preferred organically) + `extract_markdown`. One fallback to `curl` + regex when extract_markdown didn't preserve the club-list structure. No native WebSearch/WebFetch used.
- **Main test: inspect Travis GOP clubs + return CSV** — Madison skipped `inspect_pages` entirely and went straight to `get_page_data(url, "links")` because the URL was already cached from the AVP run. Handle-pattern working end-to-end; returned 32 clubs as CSV.

### Final commits (timeline top→bottom = newest first)
```
117402f Fix Trawl handle-resolution exclusions + add trawl-handles skill
8648063 lode: document MCP Streamable HTTP handshake requirement
8ed479f Fix Trawl tools/list: do full MCP Streamable HTTP handshake
fc84a77 Forward Trawl config from group config into container stdin
a12798e lode: Trawl MCP integration plan
2df2b73 Add research-dedupe + subagent-output-contract container skills
81319d6 Add group-config CLI + Trawl per-group defaults
32821dd Wire Trawl MCP into containers (conditional per-group registration)
fbfaeb3 Fix container-runner test mock drift for CONTAINER_HOST_GATEWAY
(plus 2 commits in ~/Projects/trawl and 1 in ~/Projects/ConfigFiles)
```

## Reboot check (5 questions) — current as of 2026-04-21

1. **Where am I?** Phase 7 complete + Phase 9 (observation) in progress. Trawl MCP service live at `https://trawl.crested-gecko.ts.net/mcp`; Madison using it in production in AVP and main groups. Plan effectively at graduation stage.
2. **Where am I going?** Collect 1–2 weeks of real-world AVP/main sessions. Run `baseline-measure.sh` against a post-Trawl session and compare with `baseline-pre-trawl.txt` (369 calls, 16 dup URLs). Then graduate to Phase 10: move to `lode/plans/complete/` + create `lode/infrastructure/trawl-mcp.md`.
3. **What is the goal?** Reduce Madison's context-burning web calls by routing them through Trawl's Grok-powered service. Confirmed working on first day: Madison organically preferred `mcp__trawl__*` tools over native `WebSearch`/`WebFetch`; handle-drilldown pattern validated.
4. **What have I learned?** See findings.md "dcc + env-vault passthrough", "tsdproxy network + container_port convention", "MCP Streamable HTTP handshake required for tools/list". Biggest architecture surprises: (a) MCP Streamable HTTP is stateful even for read-only calls; (b) env-vault decrypts to the COMPOSE process env, not the container env — explicit `environment:` passthrough required; (c) `query_data`/`list_data` are client-facing, not internal (lesson: read the pipeline prompts that mention them before classifying as plumbing).
5. **What have I done?** 12 commits across 3 repos (2 Trawl, 1 ConfigFiles, 9 NanoClaw). Built the MCP server with three-tier access, deployed as tailnet service, wired Madison, deployed to production, shipped 3 container skills, ran /simplify pass, validated end-to-end via both automated tests and live Madison sessions in two groups.

## Handover notes for next session

If picking up this plan in a new session:

1. Start here: `lode/plans/active/2026-04-trawl-mcp-integration/tracker.md` — reflects complete Phase 7 state and has Observation harness + Post-deploy ops runbook inline.
2. `lode/plans/active/2026-04-trawl-mcp-integration/findings.md` has the hard-won deploy-time rules (dcc/env-vault, tsdproxy network, MCP handshake) that aren't obvious from reading the code.
3. Pending tasks in the project task list: #11 (SearXNG backend), #12 (hosted admin UI), #14–17 (architectural debt + polish). None are blocking.
4. A live monitor (`b459bdvxy`) may still be running on `telegram_main` session; stop via TaskStop if no longer needed.
5. Next natural action: in 1–2 weeks, run `./baseline-measure.sh <telegram_avp session dir>` on a fresh post-Trawl AVP session and diff against `baseline-pre-trawl.txt`. Then graduate the plan.
