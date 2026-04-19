# Findings — a-mem Integration

→ **Graduated to [lode/infrastructure/a-mem.md](../../../infrastructure/a-mem.md).** The durable architecture, wiring, and usage conventions now live there. The content below is kept as a historical record of what was learned during planning; refer to the infrastructure doc for current state.

## Host a-mem install state

a-mem-mcp installed on host at `/home/jeff/Tools/a-mem-mcp/`:
- Source tree + `.venv/` with all deps installed (CUDA torch, sentence-transformers, chromadb, litellm, ollama, etc.)
- `.venv/bin/a-mem-mcp` launches the stdio MCP server
- `.env` configured for Ollama backend with `qwen3.5:9b`
- Registered with Claude Code CLI at user scope (`~/.claude.json`): tool prefix `mcp__a-mem__*`

This is the host-side reference install and is what informed the container bake.

## a-mem architecture

- **LLM controller** (`agentic_memory/llm_controller.py`): Ollama backend uses litellm with `model="ollama_chat/{model_name}"`; respects `OLLAMA_HOST` / `OLLAMA_API_BASE` env vars. Falls back to localhost.
- **Embeddings**: sentence-transformers, local CPU. Default model `all-MiniLM-L6-v2` (~80MB). Downloaded on first use from HuggingFace if not cached.
- **Storage**: ChromaDB. Default path `./chroma_db`; overridable via `CHROMA_DB_PATH` env var.
- **Server entry**: `agentic-memory-mcp` console script (actual binary name: `a-mem-mcp`).

## Ollama networking from containers

Already solved in `src/container-runtime.ts:44-50`:

```typescript
export function hostGatewayArgs(): string[] {
  if (os.platform() === 'linux') {
    return ['--add-host=host.docker.internal:host-gateway'];
  }
  return [];
}
```

This is applied to every container spawn, so `http://host.docker.internal:11434` resolves to the host from inside containers. No additional networking work needed for Phase B.

Host Ollama is reachable at `http://localhost:11434` on the host. From a container it becomes `http://host.docker.internal:11434`.

## Current Dockerfile shape

`container/Dockerfile`:
- Base: `node:22-slim`
- Installs Chromium + fonts + poppler + curl + git (chromium for `agent-browser`)
- `npm install -g agent-browser @anthropic-ai/claude-code`
- No Python currently installed — needs to be added for a-mem.
- Entrypoint transpiles TS at runtime, runs as `node` user.

## Proposed Dockerfile additions

```dockerfile
# Python for a-mem
RUN apt-get update && apt-get install -y python3 python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/*

# a-mem: venv + CPU-only torch to keep image slim
COPY a-mem-mcp/ /opt/a-mem/
RUN python3 -m venv /opt/a-mem/.venv \
    && /opt/a-mem/.venv/bin/pip install --no-cache-dir \
         --extra-index-url https://download.pytorch.org/whl/cpu \
         torch \
    && /opt/a-mem/.venv/bin/pip install --no-cache-dir -e /opt/a-mem \
    && /opt/a-mem/.venv/bin/pip install --no-cache-dir ollama \
    && /opt/a-mem/.venv/bin/python -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('all-MiniLM-L6-v2')"

ENV PATH="/opt/a-mem/.venv/bin:${PATH}"
```

Requires `a-mem-mcp/` source to be present in the build context. Options:
- **(A) git submodule** — `git submodule add https://github.com/agiresearch/A-mem container/a-mem-mcp`. Clean, reproducible, versioned. Requires submodule init on fresh clones.
- **(B) copy from host at build time** — `container/build.sh` copies `~/Tools/a-mem-mcp/` into the build context before running docker build. Simple but host-path-dependent.
- **(C) pip install from GitHub URL** — no COPY needed, but requires network at build time and may not be a properly packaged project.

Recommended: **A (submodule)** — keeps builds reproducible and decoupled from host state.

## Expected image size delta

- Python 3 + pip + venv: ~100MB
- torch CPU + transformers + chromadb + litellm + ollama + other deps: ~1.3GB
- sentence-transformers `all-MiniLM-L6-v2` cache: ~80MB
- a-mem source (small): <10MB

Total: ~1.5GB. Current nanoclaw-agent image size should be checked with `docker image ls nanoclaw-agent:latest`.

## MCP server registration

In `container/agent-runner/src/index.ts` around line 419, add an entry alongside `nanoclaw` and `gmail`:

```typescript
mcpServers: {
  nanoclaw: { /* existing */ },
  gmail: { /* existing */ },
  'a-mem': {
    command: 'a-mem-mcp',
    env: {
      LLM_BACKEND: 'ollama',
      LLM_MODEL: 'qwen3.5:9b',
      OLLAMA_HOST: 'http://host.docker.internal:11434',
      EMBEDDING_MODEL: 'all-MiniLM-L6-v2',
      CHROMA_DB_PATH: '/workspace/a-mem/chroma',
    },
  },
}
```

Plus `'mcp__a-mem__*'` in `allowedTools`.

Gating to specific groups: either always-present in the image but only wired for specific groups via `containerInput`, or control via env. Simplest: always wire it, then the agent only uses it in groups whose CLAUDE.md instructs it to. But that's wasteful — running sentence-transformers on startup in Jeff's main group adds cold-start cost. Better gate it: pass `ENABLE_AMEM=1` env from `container-runner.ts` only for groups opted in, and conditionally include the mcpServers entry.

## Per-group ChromaDB mount

Host path: `~/containers/data/NanoClaw/a-mem/<folder>/chroma/`
Container path: `/workspace/a-mem/chroma`

Needs added as per-group RW mount in `registered_groups.container_config`:

```json
{"additionalMounts": [
  /* existing mounts */,
  {"hostPath": "~/containers/data/NanoClaw/a-mem/telegram_trading", "containerPath": "a-mem", "readonly": false}
]}
```

## Mount allowlist changes

Current (`~/.config/nanoclaw/mount-allowlist.json`):
- `~/Documents/Obsidian/Main/NanoClaw` RW — too broad; remove
- `~/Documents/Obsidian/Main/AlgoTrader` RW — to be replaced
- `~/Documents/Obsidian/Main/Trading` RW — to be removed (content migrates under NanoClaw/)
- `~/containers/nanoclaw/lode` RO — keep

Target:
- `~/Documents/Obsidian/Main/NanoClaw/AlgoTrader` RW (replaces Trading + AlgoTrader top-level)
- `~/Documents/Obsidian/Main/NanoClaw/AmericanVoxPop` RW (narrows from broad NanoClaw)
- `~/containers/data/NanoClaw/a-mem/telegram_trading` RW
- `~/containers/data/NanoClaw/a-mem/telegram_avp` RW
- `~/containers/nanoclaw/lode` RO — keep

## CLAUDE.md "when a-mem vs Obsidian" draft

Candidate snippet to add to both group CLAUDE.md files (refine during Phase 4):

```markdown
## When to use a-mem vs. Obsidian

Your Obsidian subfolder is the **curated artifact layer** — anything
worth a named file goes there (strategies, findings, named people/
orgs/events, dated entries). Obsidian is authoritative.

a-mem is the **semantic-recall layer** on top. Use it for:

- **Dedup check before creating a new Obsidian note** — search a-mem
  fuzzy-first to find out if you've already captured a similar thing.
- **Cross-folder pattern recall** — "have I seen this regime/topic
  before?" when you don't know the right tag or filename.
- **Ephemeral observations** too small or premature for a file.

Do not store secrets, credentials, or PII in a-mem. When an observation
graduates from fuzzy to definitive, write it to Obsidian.
```

## Related

- [tracker.md](tracker.md)
- [progress.md](progress.md)
- [../../../infrastructure/persistence.md](../../../infrastructure/persistence.md)
- `~/Tools/a-mem-mcp/` — host install reference
- `.claude/skills/add-ollama-tool/SKILL.md` — networking pattern (reused, not duplicated)
