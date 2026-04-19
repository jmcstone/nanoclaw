# a-mem Integration

Per-group semantic memory via [a-mem-mcp](https://github.com/DiaaAj/a-mem-mcp). Every working group has its own isolated ChromaDB; no cross-group memory bleed.

## What it is

a-mem is an MCP server that provides fuzzy semantic recall on top of a group's Obsidian vault. It runs **inside the agent container** as a subprocess of the Claude Agent SDK, not as a host service. Exposed tools are prefixed `mcp__a-mem__*`.

- Embeddings: sentence-transformers, local CPU, model `all-MiniLM-L6-v2` (~80MB), pre-cached at container build time at `/opt/a-mem/hf-cache`.
- LLM controller (for note generation): litellm → Ollama on the host at `http://host.docker.internal:11434` with `qwen3.5:9b`.
- Storage: ChromaDB, per-group directory mounted from host.

## Container bake

- Source: git submodule at `container/a-mem-mcp/` pinned to `dce0ac6` of `github.com/DiaaAj/a-mem-mcp`.
- Install: `/opt/a-mem/.venv/` with CPU-only torch (saves ~2GB vs. CUDA), sentence-transformers, chromadb, litellm, ollama.
- Binary: `a-mem-mcp` on `$PATH` inside the container.
- Image size: 5.58GB (multi-arch manifest; single-arch is ~2.5GB).

## Wiring

`container/agent-runner/src/index.ts` conditionally adds the `a-mem` MCP server and `mcp__a-mem__*` to `allowedTools` when `/workspace/extra/a-mem` is mounted. Groups without the mount get no a-mem.

Env passed to the MCP server:

```
LLM_BACKEND=ollama
LLM_MODEL=qwen3.5:9b
OLLAMA_HOST=http://host.docker.internal:11434
OLLAMA_API_BASE=http://host.docker.internal:11434
EMBEDDING_MODEL=all-MiniLM-L6-v2
CHROMA_DB_PATH=/workspace/extra/a-mem/chroma
HF_HOME=/opt/a-mem/hf-cache
```

## Networking

Host Ollama reachable from containers via `host.docker.internal` — added as an `--add-host=host.docker.internal:host-gateway` arg on Linux in `src/container-runtime.ts`. No extra networking work needed.

## Per-group layout

Host path: `~/containers/data/NanoClaw/a-mem/<folder>/chroma/` (BTRFS subvolume, hourly snapshots).
Container path: `/workspace/extra/a-mem/chroma`.

Added as per-group RW mount in `registered_groups.container_config` and in `~/.config/nanoclaw/mount-allowlist.json`.

## Usage convention

a-mem is the **semantic-recall layer** on top of Obsidian:

- Dedup check before creating a new Obsidian note.
- Cross-folder pattern recall when the right tag/filename isn't obvious.
- Ephemeral observations too small or premature for a file.

Obsidian remains the **curated artifact layer** and source of truth — anything worth a named file goes there. When an observation graduates from fuzzy to definitive, write it to Obsidian. Secrets, credentials, and PII never go in a-mem.

## Cold start

First tool call in a fresh container is slow (sentence-transformers load + ChromaDB warm). Subsequent calls are fast. Pre-cached model avoids a network round-trip on first use.

## Host-side reference install

A separate a-mem install lives at `~/Tools/a-mem-mcp/` and is registered in `~/.claude.json` at user scope. That one is for the host Claude Code CLI, not the containers. The container bake is independent and does not depend on the host install.

## Related

- [persistence.md](persistence.md) — why ChromaDB lives under `~/containers/data/NanoClaw/`
- [../groups.md](../groups.md) — per-group a-mem status
- [../practices.md](../practices.md) — attachments + per-group data conventions
- `.claude/skills/add-ollama-tool/SKILL.md` — `host.docker.internal` networking pattern
