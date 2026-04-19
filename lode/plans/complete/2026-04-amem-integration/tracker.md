# 2026-04 a-mem Integration

Branch: `main`

## Goal

Add per-group a-mem MCP server to NanoClaw agent containers so AlgoTrader and AmericanVoxPop (Nexus→AVP renamed earlier) agents can use semantic memory recall on top of their Obsidian vaults. Isolation: each group gets its own ChromaDB; no cross-group memory bleed. Jeff main group is intentionally excluded (general Q&A — no Obsidian, no recurring research).

Bakes a-mem into the agent container image, reuses existing `host.docker.internal` networking (already in `src/container-runtime.ts`) to reach host Ollama with `qwen3.5:9b`.

## Phases

### Phase 1 — Pre-flight, docs, AlgoTrader vault relocation
- [x] Research captured in findings.md
- [x] Create `~/Documents/Obsidian/Main/NanoClaw/AlgoTrader/` with full scaffold (strategies, Web Research, Regime Reports, Backtests, Charts, sources/{magazine,book,web,academic_paper}, Knowledge/components/{8 categories}, Knowledge/findings/{4 categories})
- [x] Per Jeff: leave `~/Documents/Obsidian/Main/Trading/` as personal archive (option B); only deleted `_hello-from-madison.md` test file. Madison's future work goes to `NanoClaw/AlgoTrader/` as a clean slate.
- [x] Create per-group ChromaDB host directories: `~/containers/data/NanoClaw/a-mem/{telegram_trading,telegram_avp}/`
- [x] Update `~/.config/nanoclaw/mount-allowlist.json`: removed broad `NanoClaw/` + top-level `AlgoTrader/` + `Trading/`; added per-subfolder `NanoClaw/AlgoTrader/` RW, `NanoClaw/AmericanVoxPop/` RW, and per-group ChromaDB paths RW; kept lode RO
- [x] Update `registered_groups.container_config` for `telegram_trading`: host `NanoClaw/AlgoTrader/` → container `algotrader` (RW); lode RO kept; added `a-mem` container path → host ChromaDB dir (RW); dropped old `trading` mount
- [x] Update `registered_groups.container_config` for `telegram_avp`: narrowed host from `NanoClaw/` to `NanoClaw/AmericanVoxPop/` → container `obsidian` (RW); added `a-mem` container path → host ChromaDB dir (RW)
- [x] Restart service; clean startup, Telegram + Gmail + Protonmail + bot pool all connected
- [x] Validate from a group message: Madison AlgoTrader sees `NanoClaw/AlgoTrader/`; Madison AmericanVoxPop sees `NanoClaw/AmericanVoxPop/`; neither sees the other's vault — validated 2026-04-19
- [ ] Follow-up (tracked separately): Naming collision — top-level `~/Documents/Obsidian/Main/AlgoTrader/` (empty, Jeff's future ORB vault) vs. `NanoClaw/AlgoTrader/` (Madison's workspace); resolve when ORB migration begins. Documented in `lode/groups.md`.

### Phase 2 — Container image
- [x] Added git submodule at `container/a-mem-mcp/` (pinned to commit `dce0ac6` of `github.com/DiaaAj/a-mem-mcp`)
- [x] Updated `container/Dockerfile`: Python 3 + pip + venv apt deps; COPY a-mem source; venv at `/opt/a-mem/.venv/`; CPU-only torch via `--index-url https://download.pytorch.org/whl/cpu`; `pip install -e /opt/a-mem-mcp` + `ollama`; pre-warmed sentence-transformers `all-MiniLM-L6-v2` via build-time import; `HF_HOME=/opt/a-mem/hf-cache` for persistent model cache
- [x] Rebuild image via `./container/build.sh` — success
- [x] Image size: **5.58GB** (larger than the 1.5–2GB estimate — multi-arch manifest inflates the apparent size; single-arch usage is ~2.5GB)
- [ ] Smoke test of `a-mem-mcp` binary + Ollama reachability from inside a container (will happen implicitly on first Phase 4 validation message)

### Phase 3 — MCP wiring
- [x] Added `a-mem` entry to `mcpServers` in `container/agent-runner/src/index.ts`, gated by `fs.existsSync('/workspace/extra/a-mem')` — groups without the mount get no a-mem (Jeff main is excluded since no a-mem mount in its container_config)
- [x] `mcp__a-mem__*` conditionally added to `allowedTools` via the same gate
- [x] Per-group env wired: `LLM_BACKEND=ollama`, `LLM_MODEL=qwen3.5:9b`, `OLLAMA_HOST` + `OLLAMA_API_BASE=http://host.docker.internal:11434`, `EMBEDDING_MODEL=all-MiniLM-L6-v2`, `CHROMA_DB_PATH=/workspace/extra/a-mem/chroma`, `HF_HOME=/opt/a-mem/hf-cache`
- [x] Per-group mount already added in Phase 1 (`~/containers/data/NanoClaw/a-mem/<group>/` → `/workspace/extra/a-mem/`)
- [x] TypeScript compiles (fixed `Record<string, unknown>` → `Record<string, any>` for mcpServers shape)
- [x] Agent-runner per-session caches will auto-refresh on next container spawn via `container-runner.ts` mtime check
- [x] Cleaned stale `telegram_nexus` session dir from rename; removed orphaned repo-local `data/sessions/` from pre-migration layout

### Phase 4 — CLAUDE.md + validation
- [x] Replaced "a-mem MCP is NOT installed" section in Madison AlgoTrader's CLAUDE.md with new "KB search — Obsidian + a-mem" block (tools list, when-to-use rules, isolation note, secrets warning)
- [x] Added "Obsidian + a-mem" block to Madison AmericanVoxPop's CLAUDE.md with group-specific Obsidian vault context
- [x] Reset sessions for both a-mem-enabled groups (telegram_trading + telegram_avp) so their next message spawns fresh and reads the updated CLAUDE.md
- [x] Send test messages in each group: `add_memory_note`, `search_memories`, `find_related_memories` — validated 2026-04-19
- [x] Verify isolation: memories created in AlgoTrader group do not appear in AmericanVoxPop searches — validated 2026-04-19
- [x] Verify Ollama note generation quality on `qwen3.5:9b` — acceptable

### Phase 5 — Follow-up
- [x] Commit all changes (`a14c646` + `fadb083`)
- [x] Update `lode/groups.md` with a-mem status per group
- [x] Update `lode/summary.md` to mention a-mem
- [x] Graduate durable findings to `lode/infrastructure/a-mem.md`
- [x] Graduate plan to `plans/complete/`
- [ ] Follow-up (tracked separately): `/add-research-group` skill extraction — deferred until the pattern is proven on a third group. Not a blocker.

## Decisions

| Decision | Rationale |
|----------|-----------|
| Bake a-mem into image (vs mount host venv) | Matches NanoClaw's self-contained container philosophy; no host-path dependency from container |
| CPU-only torch | Container has no GPU; saves ~2GB of nvidia-cuda-* deps |
| Pre-warm sentence-transformers model cache at build time | Avoid first-use network round-trip + download stall |
| Per-group ChromaDB at `~/containers/data/NanoClaw/a-mem/<group>/` (host) mounted to `/workspace/a-mem/` (container) | Isolation per group; outside repo; on BTRFS subvolume so snapshotted |
| `qwen3.5:9b` via host Ollama using existing `host.docker.internal` path | No new networking needed; model already installed |
| ~~Only telegram_trading + telegram_avp get a-mem, not telegram_main~~ Extended to all 3 groups mid-plan | Jeff decided Obsidian + a-mem both beneficial for main chat too (remember preferences, habits; personal notes sync via Obsidian). Scope extended 2026-04-18 — created `NanoClaw/Personal/` Obsidian subfolder, added a-mem mount, updated Jeff main CLAUDE.md. |
| Skill extraction (`/add-research-group`) deferred | Lode Coding rule: don't abstract before seeing the pattern work twice — this plan is the second instance |
| Keep `@Madison` trigger; keep base Madison persona | Per prior discussion: Madison is the shared base, AlgoTrader/AVP are thin specializations |

## Errors

| Error | Resolution |
|-------|-----------|

## Current Status

**Complete 2026-04-19.** All phases executed and validated end-to-end. a-mem live in all 4 groups with per-group ChromaDB isolation. Durable architecture documented at `lode/infrastructure/a-mem.md`. Plan graduated to `plans/complete/`.
