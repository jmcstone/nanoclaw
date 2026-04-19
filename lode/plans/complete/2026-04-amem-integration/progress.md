# Progress — a-mem Integration

## 2026-04-18 — Plan opened

Follow-on to the 2026-04-nanoclaw-migration plan. With persistence now on the convention and the AVP rename done, we can safely add per-group a-mem on top.

Key enabling facts established during research:
- Host Ollama networking already solved — `src/container-runtime.ts:44` adds `host.docker.internal` gateway on Linux.
- ChromaDB will live under the new `~/containers/data/NanoClaw/` subvolume so it gets hourly snapshots automatically.
- a-mem bakes into the image cleanly via Python venv; CPU-only torch keeps delta near 1.5GB instead of 3GB.
- Sentence-transformers `all-MiniLM-L6-v2` can be pre-cached at build time.

## Session actions

| Time | Action | Result |
|------|--------|--------|
| 18:10 | Research: Dockerfile, container-runtime host-gateway, a-mem internals | captured in findings.md |
| 18:10 | Plan tracker + findings + progress written | ✓ |
| 18:20 | Phase 1 executed: created AlgoTrader scaffold + a-mem host dirs + updated mount-allowlist + updated both container_configs + deleted test file | ✓ |
| 18:21 | Service restarted with new mount config; clean startup (3 channels + bot pool connected) | ✓ |
| 18:26 | Madison AlgoTrader reported `trading/` missing in her first test; diagnosed session-resume holding old context + stale CLAUDE.md references | ✓ |
| 18:30 | Updated CLAUDE.md: fixed mount table (dropped `trading/`, updated `algotrader/` host path, added `a-mem/` row, added removal note); cleared stale `telegram_trading` and `telegram_nexus` session rows | ✓ |
| 18:40 | Phase 2: added `container/a-mem-mcp` git submodule (pinned `dce0ac6`); updated Dockerfile (Python + venv + CPU torch + a-mem + ollama + pre-cached sentence-transformers); rebuilt image (5.58GB) | ✓ |
| 18:50 | Phase 3: added conditional `a-mem` entry to `mcpServers` in agent-runner; `mcp__a-mem__*` in allowedTools guard; fixed TS typing for mcpServers shape; host-side TS compiles cleanly | ✓ |
| 18:55 | Phase 4 docs: rewrote AlgoTrader CLAUDE.md "KB search" section; added full "Obsidian + a-mem" block to AVP CLAUDE.md; cleaned stale session dirs (`telegram_nexus/`, orphaned `~/containers/nanoclaw/data/sessions/`); reset both a-mem-enabled group sessions | ✓ |
| — | Phase 4 validation (round-trip a-mem tool test per group + isolation check) pending — need Jeff to send test messages | pending |

## Tests / validation (to fill in per phase)

| Test | Status | Notes |
|------|--------|-------|
| AlgoTrader vault relocation: both mounts resolve after restart | pending | Phase 1 |
| AVP mount narrowed: group can access AmericanVoxPop subfolder, not siblings | pending | Phase 1 |
| Container image rebuild succeeds | pending | Phase 2 |
| Image size within ~1.5–2GB delta | pending | Phase 2 |
| `a-mem-mcp` binary present + executable in container | pending | Phase 2 |
| Ollama reachable from container at `http://host.docker.internal:11434` | pending | Phase 2 |
| a-mem MCP handshake succeeds (`tools/list` returns 7 tools) | pending | Phase 3 |
| Per-group isolation: memories created in AlgoTrader invisible in AVP | pending | Phase 4 |
| Ollama-based note generation produces sensible JSON | pending | Phase 4 |

## Error log

_(none yet)_

## Reboot check (for fresh session)

1. **Where am I?** Plan opened; research done; no implementation yet.
2. **Where am I going?** Execute Phase 1 (AlgoTrader vault move + mount-allowlist + per-group mounts) after Jeff confirms. Then Phase 2 (container rebuild) after Phase 1 validates.
3. **What is the goal?** Per-group a-mem live for AlgoTrader and AVP, isolated ChromaDB each, using host Ollama `qwen3.5:9b`. Jeff main group deliberately excluded.
4. **What have I learned?** Host networking already provides `host.docker.internal` on Linux — one less thing to build. CPU-only torch is critical for keeping image size reasonable. `a-mem-mcp` is the actual binary name (not `agentic-memory-mcp`) per the pyproject scripts.
5. **What have I done?** Plan files written. No code or config modified yet.

## Next

Awaiting Jeff's green-light on:
- Whether to use git submodule for a-mem source (recommended) or host copy
- Whether the test file in `~/Documents/Obsidian/Main/Trading/` can be deleted or should be migrated
- Final confirmation on `qwen3.5:9b` before rebuild (vs. pulling a smaller/faster model)
