---
name: add-brave-search
description: Add Brave Search MCP server so the container agent can run web and local searches via the Brave Search API.
---

# Add Brave Search Integration

Registers `@brave/brave-search-mcp-server` as a stdio MCP server inside the agent container. Madison (and any other group agent) gets `brave_web_search`, `brave_local_search`, `brave_image_search`, `brave_news_search`, `brave_video_search`, and `brave_summarizer` tools when `BRAVE_API_KEY` is present in the host `.env`.

The key never lands in `process.env` on the host — it is read from `.env` via `readEnvFile` and injected only into the spawned container, matching the AgentMail / LiteLLM pattern.

## Phase 1: Pre-flight

Confirm a Brave Search API key exists. Free tier (2k queries/month) is available at https://brave.com/search/api/.

If the user has no key, stop and direct them there.

## Phase 2: Apply Code Changes

The code is already on the local `main` branch. Files involved:

- `src/config.ts` — `resolveBraveApiKey()` reads `BRAVE_API_KEY` from `.env`.
- `src/container-runner.ts` — `buildContainerArgs` injects `-e BRAVE_API_KEY=…` into the container when the key is present.
- `container/agent-runner/src/index.ts` — registers `brave-search` MCP server and adds `mcp__brave-search__*` to allowed tools when `BRAVE_API_KEY` is in the container env.
- `.env.example` — documents the variable.

If applying to a fresh fork, replay these edits manually or cherry-pick from this repo.

## Phase 3: Configure

Add to `.env`:

```
BRAVE_API_KEY=<your-key>
```

Copy any agent-runner cache so existing groups pick up the new file:

```bash
for dir in data/sessions/*/agent-runner-src; do
  cp container/agent-runner/src/index.ts "$dir/"
done
```

Build and restart:

```bash
npm run build
./container/build.sh
systemctl --user restart nanoclaw   # Linux
# launchctl kickstart -k gui/$(id -u)/com.nanoclaw   # macOS
```

## Phase 4: Verify

Tell the agent something like:

> Use brave_web_search to find the current Bitcoin price.

In `logs/nanoclaw.log` you should see `brave-search MCP: enabled` early in the container run, followed by an `mcp__brave-search__brave_web_search` tool call.

## Troubleshooting

**`brave-search MCP: disabled`** — `BRAVE_API_KEY` was not injected. Check `.env` is in the repo root and the service was restarted after editing it.

**`401 Unauthorized`** — bad/expired key. Regenerate at https://api-dashboard.search.brave.com/.

**Agent doesn't use the tool** — ask explicitly: "use the `brave_web_search` tool to ..." Some prompts default to `WebSearch` (Anthropic's built-in) instead.
