# Context-Mode Integration

Branch: `main`

## Goal

Integrate the `context-mode` MCP plugin (mksglu/context-mode) into the NanoClaw agent container so Madison's sessions benefit from:

1. **~98% context-window reduction** on large tool outputs (Bash, Read, Grep, WebFetch, MCP) via PreToolUse interception + sandboxed subprocess execution
2. **Session continuity** across `/compact` and `--continue` via FTS5/BM25 state restoration
3. **"Think in code" enforcement** — `ctx_execute`/`ctx_execute_file`/`ctx_fetch_and_index` replace raw data-into-context patterns

Pattern mirrors existing a-mem and Trawl integration in `container/agent-runner/src/index.ts`.

## Why now (supersedes earlier defer decision)

The original Trawl plan deferred context-mode pending Phase 9 observation of Trawl alone. Reassessed 2026-04-20 after realizing context-mode is a **context-compression layer**, not just session memory. The value is orthogonal to Trawl's — Trawl reduces web-call duplication; context-mode reduces the context cost of every tool call. Combined, they attack Madison's AVP context-burn from two angles.

## Phases

### Phase 0 — Discussion & decision lock
- [ ] Run `/lode:discuss` to resolve open design questions (see below)
- [ ] Update decisions table with locked choices

### Phase 1 — Container base install
- [ ] Add `context-mode` npm package to `container/Dockerfile` (global install or vendored bundle)
- [ ] Verify runtime deps for sandbox (Bun, Python, Node) are present or add them
- [ ] Rebuild agent container image

### Phase 2 — MCP server registration
- [ ] Add `context-mode` entry to `mcpServers` map in `container/agent-runner/src/index.ts`, mirroring a-mem opt-in sentinel pattern
- [ ] Ensure MCP server starts cleanly in container; `ctx_stats` reports live

### Phase 3 — Hook wiring
- [ ] Add `PreToolUse` hooks for Bash / Read / Grep / WebFetch / Agent / `mcp__*` matchers
- [ ] Add `PostToolUse` hook (broad matcher)
- [ ] Merge new `PreCompact` hook with existing `createPreCompactHook(assistantName)` — decide order
- [ ] Add `SessionStart` + `UserPromptSubmit` hooks
- [ ] Resolve `CLAUDE_PLUGIN_ROOT` env var for Agent SDK context (Claude Code sets this automatically; SDK may not)

### Phase 4 — Per-group opt-in + data isolation
- [ ] Define per-group FTS5 DB location (likely `/workspace/extra/context-mode/<group>/`)
- [ ] Extend `containerConfig` type with `contextMode?: { enabled: boolean }` or rely on mount sentinel
- [ ] Update `scripts/group-config.ts` or defaults helper with enable toggle

### Phase 5 — Validation
- [ ] Run a canned AVP research session with + without context-mode; capture `ctx_stats` deltas
- [ ] Check that existing Trawl/a-mem flows still work (no hook conflicts)
- [ ] Measure main-session token consumption (proxy: Anthropic API usage per session) before/after

### Phase 6 — Rollout
- [ ] Flip on for AVP group first (heaviest context consumer)
- [ ] Observe 2-3 days; adjust
- [ ] Flip on for Main + Trading groups
- [ ] Document post-install quirks in findings.md

### Phase 7 — Lode graduation
- [ ] Create `lode/infrastructure/context-mode.md` (architecture snapshot)
- [ ] Update `lode/lode-map.md`, `lode/summary.md`
- [ ] Update tech-debt.md — remove context-mode defer note
- [ ] Move plan to `lode/plans/complete/`

## Open design questions (Phase 0)

1. **CLAUDE_PLUGIN_ROOT env handling.** Context-mode's hooks reference `${CLAUDE_PLUGIN_ROOT}`. Claude Code populates this; the Agent SDK inside Madison's container doesn't. Options: install context-mode at a fixed path and hardcode; set `CLAUDE_PLUGIN_ROOT` in container env; or patch the hook wrapper. Need to confirm the SDK's hook env semantics.

2. **Per-group data isolation mechanism.** Mirror a-mem's mount-sentinel pattern (`/workspace/extra/context-mode/` exists → enabled) or use explicit `containerConfig.contextMode.enabled` flag? Leaning mount-sentinel for consistency with a-mem.

3. **PreCompact hook chaining.** NanoClaw already has `createPreCompactHook(assistantName)` — it presumably writes a snapshot to the group's memory. Context-mode's PreCompact indexes state to FTS5. Do they conflict? Need to inspect and decide ordering.

4. **Which sandbox languages to support in-container.** Bun is a 90MB+ install; Python already present; Node already present. Include Bun or not? Affects image size + capability.

5. **Rollout sequencing.** All-at-once vs. per-group staged? AVP is the highest-value + highest-risk (active research). Trading group is less active and would be a safer first-flip.

6. **Relationship to Trawl's handle pattern.** Trawl already solves inline-vs-handle for its own tools. Does context-mode's PreToolUse hook add value on top of that or duplicate? Expected: complementary (Trawl's handles keep pages out of context; context-mode's PreToolUse reroutes any remaining raw-output tools like Bash/Read/WebFetch).

## Decisions

| Decision | Rationale |
|----------|-----------|
| Install via `npm install -g context-mode` in container Dockerfile | Matches a-mem's absolute-path install pattern (`/opt/a-mem/.venv/bin/...`). Clean version pinning through npm; upgrade path is a Dockerfile version bump. |
| Resolve context-mode's install path at runtime via Node's `createRequire` + `require.resolve('context-mode/package.json')` — no env var, no hardcoded path | The Agent SDK's `hooks:` option takes `HookCallback` functions (not shell-command strings like Claude Code does), so path resolution happens in JavaScript. `require.resolve` asks Node's module resolver — it adapts automatically to whatever npm prefix the base image uses. No Dockerfile `ENV`, no string sync between Dockerfile and `index.ts`. Immune to base-image changes. |
| Per-group opt-in via mount sentinel at `/workspace/extra/context-mode/<group>/` | Mirrors a-mem's opt-in pattern (`fs.existsSync('/workspace/extra/a-mem')`). Appropriate because context-mode is data-bearing (per-group FTS5 DB) like a-mem, unlike Trawl which is a network service. |
| PreCompact runs both existing `createPreCompactHook` + context-mode's `precompact.mjs` as separate entries in the same array | Both are transcript observers; neither depends on the other's output. SDK hook array supports this natively. Order probably doesn't matter — if we see interference, revisit. |
| Sandbox runtimes: Node + Python + shell only | All three already present in the container (Node 22, python3, bash). Bun would give 3-5× JS sandbox speedup per `ctx_doctor` but adds ~90 MB and isn't required. Defer until `ctx_stats` shows a perf problem. |
| Rollout to all four groups (AVP + Main + Trading + Inbox) at once, after plumbing validation | Consistent with how a-mem and Trawl rolled out. Trading is low-activity so it's low-risk; Inbox is a natural fit since email threads are high-context-cost reads. Per-group opt-in is via mount, so rollout is just creating the four subvolumes. |

## Acceptance Criteria
- [ ] AC-1: `container/Dockerfile` installs `context-mode` via `npm install -g context-mode` (no `CLAUDE_PLUGIN_ROOT` env directive needed — path is resolved at runtime)
- [ ] AC-2: `container/agent-runner/src/index.ts` registers a `context-mode` MCP server entry in `mcpServers` when `/workspace/extra/context-mode` sentinel exists, using the stdio transport with the `context-mode` binary
- [ ] AC-3: `container/agent-runner/src/index.ts` wires all 5 hook types (PreToolUse with 8 matchers, PostToolUse, PreCompact with 2 entries, SessionStart, UserPromptSubmit) in the `hooks:` option block via a `createContextModeHook(scriptName)` factory that uses `createRequire(import.meta.url)` + `require.resolve('context-mode/package.json')` to locate hook scripts — no hardcoded paths
- [ ] AC-4: `mcp__context-mode__*` tools appear in `allowedTools` when the sentinel exists, and are absent when it does not
- [ ] AC-5: 4 regular directories exist at `~/containers/data/NanoClaw/context-mode/{telegram_avp,telegram_main,telegram_trading,telegram_inbox}/` with `jeff:jeff` ownership and `2775` mode (regular dirs, not subvolumes — inherits snapshot rotation from parent NanoClaw/ subvolume; mirrors a-mem host layout exactly)
- [ ] AC-6: 4 per-group mount entries in `container_config.mounts[]` bind-mount each host dir to `/workspace/extra/context-mode/` inside the respective group's container
- [ ] AC-7: After a container run with the sentinel present, `ctx_stats` returns a non-empty response (confirming the MCP server connected and the FTS5 DB initialized)
- [ ] AC-8: After adding hooks, a session with a-mem and Trawl still successfully calls `mcp__a-mem__*` and trawl tools without hook interference

## Read First
- `/home/jeff/containers/nanoclaw/container/Dockerfile` — a-mem install pattern to mirror; where to add npm global install and ENV
- `/home/jeff/containers/nanoclaw/container/agent-runner/src/index.ts` (lines 560-665) — mcpServers map, a-mem opt-in sentinel check, existing hooks block, allowedTools array
- `/home/jeff/.claude/plugins/cache/context-mode/context-mode/1.0.89/hooks/hooks.json` — exact hook matchers and command templates to replicate
- `/home/jeff/containers/nanoclaw/lode/infrastructure/persistence.md` — BTRFS subvolume creation convention (ownership, mode, command)
- `/home/jeff/containers/nanoclaw/lode/plans/active/2026-04-context-mode-integration/findings.md` — all locked decisions and the open engineering question on `CLAUDE_PLUGIN_ROOT`

## Phase 1: Container Install — IN PROGRESS
### Wave 1 (parallel)
- [x] Add `RUN npm install -g context-mode` after the existing a-mem block (no `ENV` directive — path is resolved at runtime via `require.resolve`) — `/home/jeff/containers/nanoclaw/container/Dockerfile` (`96e241d`)

## Phase 2: Agent-Runner Wiring — PLANNED
### Wave 1 (parallel — all edits to same file, but logically independent; executor may batch)
- [ ] Add `hasContextMode` sentinel check (`fs.existsSync('/workspace/extra/context-mode')`) below the `hasAmem` check, and add the `context-mode` MCP server entry to `mcpServers` when true — `/home/jeff/containers/nanoclaw/container/agent-runner/src/index.ts`
- [ ] Add `mcp__context-mode__*` to `allowedTools` array (conditional on `hasContextMode`) — `/home/jeff/containers/nanoclaw/container/agent-runner/src/index.ts`
- [ ] Add a `createContextModeHook(scriptName)` factory near the existing `createPreCompactHook`: uses `createRequire(import.meta.url)` + `require.resolve('context-mode/package.json')` to locate the install dir, then returns a `HookCallback` that spawns `node <ctxModeRoot>/hooks/<scriptName>.mjs`, pipes the JSON input on stdin, and parses the JSON decision from stdout — `/home/jeff/containers/nanoclaw/container/agent-runner/src/index.ts`
- [ ] Replace the `hooks:` block in the `query()` options to add PreToolUse (8 matchers from hooks.json), PostToolUse (broad matcher), SessionStart, UserPromptSubmit, and the second PreCompact entry (context-mode's `precompact.mjs`) alongside the existing `createPreCompactHook`, using `createContextModeHook(...)` for all context-mode entries — `/home/jeff/containers/nanoclaw/container/agent-runner/src/index.ts`

## Phase 3: Container Rebuild — PLANNED
### Wave 1
- [ ] Run `./container/build.sh` to produce the updated image with context-mode installed (single expensive step; must complete before validation) — `container/build.sh` (no file change; execution only)

## Phase 4: Per-Group Data Isolation — IN PROGRESS
### Wave 1 (create all 4 host dirs in one pass — they're regular directories, not subvolumes)
- [x] Create `~/containers/data/NanoClaw/context-mode/` and 4 per-group subdirectories (`telegram_avp`, `telegram_main`, `telegram_trading`, `telegram_inbox`) as regular directories with `jeff:jeff` ownership and `2775` mode (setgid). Mirrors a-mem's exact host layout (`~/containers/data/NanoClaw/a-mem/telegram_*/`). Not subvolumes — they inherit snapshot rotation from the parent NanoClaw/ BTRFS subvolume — host filesystem operation (no commit — untracked by git)
### Wave 2 (depends on Wave 1 dirs existing)
- [ ] Add a `context-mode` mount entry to each of the 4 groups' `container_config.mounts[]` via `npx tsx scripts/group-config.ts set <folder> mounts +{hostPath:"~/containers/data/NanoClaw/context-mode/<folder>",containerPath:"context-mode"}` (mirroring Trawl defaults; mount lands at `/workspace/extra/context-mode/` per `src/types.ts:3`) — DB edit via `scripts/group-config.ts`; no source file change
- [ ] *Optional convenience:* create `scripts/context-mode-defaults.ts` mirroring `scripts/trawl-defaults.ts` so future groups can be set up with a single command — `/home/jeff/containers/nanoclaw/scripts/context-mode-defaults.ts`

## Phase 5: Validation — PLANNED
### Wave 1 (depends on Phase 3 rebuild + Phase 4 mounts)
- [ ] Restart nanoclaw service (`systemctl --user restart nanoclaw`), then run a test AVP session: confirm `ctx_stats` returns data, a-mem `memory-store` still works, and Trawl tools still resolve — operational step, no code change

## Phase 6: Per-Group Rollout Confirmation — PLANNED
### Wave 1 (depends on Phase 5 green signal)
- [ ] Send a test message from each of the 4 groups (AVP, Main, Trading, Inbox), confirm Madison's container for that group can call `ctx_stats` without error and that `/workspace/extra/context-mode/` is populated — operational; one round-trip per group

## Phase 7: Lode Graduation — PLANNED
### Wave 1 (parallel)
- [ ] Create `lode/infrastructure/context-mode.md` documenting the installed architecture, hook wiring, BTRFS layout, and upgrade path — `/home/jeff/containers/nanoclaw/lode/infrastructure/context-mode.md`
- [ ] Update `lode/lode-map.md` and `lode/summary.md` to reference context-mode — `/home/jeff/containers/nanoclaw/lode/lode-map.md`, `/home/jeff/containers/nanoclaw/lode/summary.md`
- [ ] Clean up stale defer references: remove the context-mode entry implications from `lode/tech-debt.md` (already absent by design, but confirm) and strike through "Context-mode deferred, not cancelled" in the trawl tracker's Decisions table — `/home/jeff/containers/nanoclaw/lode/plans/active/2026-04-trawl-mcp-integration/tracker.md`
### Wave 2 (depends on Wave 1)
- [ ] Move plan to `lode/plans/complete/2026-04-context-mode-integration/` — plan directory (file move)

## Errors

| Error | Resolution |
|-------|------------|

## Current Status

**Phase 0 complete** — 5 design decisions locked via `/lode:discuss` on 2026-04-20. Plan decomposed via `/lode:plan` on 2026-04-20. Ready for execution starting Phase 1.
