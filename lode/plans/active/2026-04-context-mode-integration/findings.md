# Findings — Context-Mode Integration

## How context-mode saves on tool calls

Context-mode is a **context-compression layer** that sits between the LLM and its tool calls. It works via three coordinated mechanisms:

### 1. PreToolUse hook — gatekeeper with rewrite authority

Registered matchers from `hooks/hooks.json`: `Bash`, `Read`, `Grep`, `WebFetch`, `Agent`, and `mcp__plugin_context-mode_context-mode__ctx_*`.

Before any matched tool executes, `pretooluse.mjs` runs. It inspects the tool + args and emits a decision:
- **Allow unchanged** — for commands on the safe whitelist (mkdir, mv, cp, rm, git writes, cd, pwd, kill, npm install, echo). These are guaranteed to produce tiny output.
- **Block with redirect message** — for everything else. The LLM gets back a system message of the form: *"This Bash command may produce large output. Use `ctx_execute` / `ctx_batch_execute` / `ctx_fetch_and_index` instead."*

The LLM then re-calls with the context-mode equivalent. This is what produces the `<context_guidance>` blocks visible throughout a session with context-mode active.

### 2. Sandboxed subprocess execution (`ctx_execute` / `ctx_execute_file`)

The core context-saving primitive. The model writes code that runs in an isolated subprocess. **Only explicit `console.log()` / `print()` output reaches the LLM context.** Raw command output, file contents, JSON bodies — all stay in the sandbox.

```
// BEFORE context-mode
Bash("aws s3 ls s3://bucket/")         // → 50 MB into context

// AFTER context-mode
ctx_execute(language: "shell", code: `
  count=$(aws s3 ls s3://bucket/ | grep error | wc -l)
  echo "error count: $count"
`)                                      // → "error count: 42" into context
```

`ctx_execute_file` loads file content into a `FILE_CONTENT` variable accessible to the sandboxed script — file never enters LLM context; script extracts and prints findings.

### 3. FTS5/BM25 knowledge base (`ctx_index` / `ctx_search` / `ctx_fetch_and_index`)

For content that needs multi-query access (web docs, large logs, repeated lookups): content is indexed server-side into a local SQLite FTS5 store. The LLM queries via `ctx_search(queries: [...], source: "...")` and receives only BM25-ranked relevant chunks.

```
// BEFORE
WebFetch("https://nextjs.org/docs/app/api-reference")  // 300 KB HTML

// AFTER
ctx_fetch_and_index("https://nextjs.org/docs/app/api-reference", source: "nextjs")
ctx_search(queries: ["server components streaming", "suspense boundary"], source: "nextjs")
// → 2-5 KB of relevant chunks
```

### 4. MCP output guidance

The PreToolUse matcher includes `mcp__` — it fires before any MCP tool call. Context-mode can't intercept the MCP tool's *return* (architectural limit of the hook system — PreToolUse runs before execution, not after), but it nudges the LLM to:
- Use the tool's `filename` parameter if one exists (e.g. Playwright `browser_snapshot(filename)`)
- Or save the output to a file via `ctx_execute` and then index it

This is why the session-start guidance emphasizes "DO NOT use WebFetch (use `ctx_fetch_and_index` instead)" and "ALWAYS use `filename` parameter on Playwright tools."

### 5. Session continuity — PostToolUse + PreCompact + SessionStart

PostToolUse (broad matcher covering Bash/Read/Write/Edit/Grep/TodoWrite/TaskCreate/TaskUpdate/Skill/Agent/AskUserQuestion/EnterWorktree/`mcp__`): each event is logged to SQLite.

PreCompact: before compaction runs, context-mode snapshots session state (edits, git ops, tasks, decisions) into the FTS5 index.

SessionStart: on next session open (especially `--continue`), the hook does NOT dump past state into the prompt. Instead, the LLM retrieves relevant past events via BM25 query as needed. This means a compacted session doesn't pay the full-state-restoration cost in every subsequent message.

## Quantitative claim

From the plugin README:
- **315 KB raw output → 5.4 KB** after routing through context-mode (98% reduction)
- Playwright snapshot: **56 KB → ~0 KB** (saved to file, queried on demand)

Madison's Phase 9 baseline: 369 web calls/session, 14 subagents avg 200 KB each ⇒ ~2.8 MB of raw output per session in just subagent traffic. At 98% reduction, that drops to ~55 KB. Combined with Trawl's inline/handle savings, the effective session length could extend 10-50×.

## Integration architecture snapshot

```
Madison container
├── Claude Agent SDK (configured in container/agent-runner/src/index.ts)
│   ├── mcpServers: { a-mem, trawl, context-mode }  ← NEW
│   └── hooks: {
│         PreToolUse:  [context-mode/hooks/pretooluse.mjs]   ← NEW
│         PostToolUse: [context-mode/hooks/posttooluse.mjs]  ← NEW
│         PreCompact:  [
│           createPreCompactHook(assistantName),  // existing NanoClaw hook
│           context-mode/hooks/precompact.mjs     // NEW
│         ]
│         SessionStart:[context-mode/hooks/sessionstart.mjs] ← NEW
│         UserPromptSubmit:[...userpromptsubmit.mjs]         ← NEW
│       }
├── /workspace/extra/a-mem/           ← ChromaDB, per-group (host: ~/containers/data/NanoClaw/a-mem/<folder>/)
├── /workspace/extra/context-mode/    ← FTS5 DB, per-group  ← NEW (host: ~/containers/data/NanoClaw/context-mode/<folder>/)
└── /workspace/group/                 ← Madison's home
```

## Locked Decisions

| Decision | Context | Locked By |
|----------|---------|-----------|
| **Install**: `npm install -g context-mode` in `container/Dockerfile` | Matches existing pattern (a-mem pip-installs to `/opt/a-mem/.venv/bin`). Upgrades = Dockerfile version bump. | user |
| **Path resolution**: use `createRequire(import.meta.url)` + `require.resolve('context-mode/package.json')` at runtime — no hardcoded path, no `CLAUDE_PLUGIN_ROOT` env var | The Agent SDK's `hooks:` option takes `HookCallback` functions (not shell-command strings), so we wrap `spawn(...)` in JS anyway. Asking Node's module resolver for the path is robust to npm prefix changes (base image, user scope, custom `npm config prefix`). Single source of truth lives in a `createContextModeHook` factory. | user |
| **Per-group opt-in**: mount sentinel at `/workspace/extra/context-mode/<group>/` | Mirrors a-mem. Data-bearing per-group resource, not a network service — mount-sentinel is the right pattern. | user |
| **PreCompact**: keep existing `createPreCompactHook` + add context-mode's `precompact.mjs` as a second entry in the same hook array | Both are independent transcript observers; SDK supports multiple hook entries natively. | user |
| **Sandbox runtimes**: Node + Python + shell only (no Bun) | All already present in container. Bun adds 90 MB for 3-5× JS speedup — defer until `ctx_stats` shows need. | user |
| **Rollout**: all four groups (AVP + Main + Trading + Inbox) at once, after plumbing validation | Consistent with a-mem and Trawl rollout cadence. Mount-sentinel makes per-group enable a one-line mount-allowlist addition. Inbox specifically benefits from FTS5 over email threads. | user |

## Deferred Ideas

- **Bun runtime for JS sandbox.** 3-5× perf improvement per `ctx_doctor` output. Revisit if `ctx_stats` shows JS-heavy workload where the latency matters.
- **Go / Rust / Perl sandbox support.** `ctx_doctor` shows these available on the host but the container wouldn't ship them. Low-probability need; add if Madison writes code-analysis scripts in those languages.
- **Cross-group FTS5 search.** Each group gets its own isolated DB (mirroring a-mem). A "search across all my groups' contexts" feature would be useful but requires a separate plumbing layer. Out of scope for v1.
- **Context-mode skill in `container/skills/`.** A companion skill explaining context-mode's routing rules specifically for Madison's AVP/trading/inbox contexts. Add if Madison needs help choosing the right ctx_* tool after rollout.

## Gray Areas Explored

### Area 1 — Hook plumbing
- **Options considered**: npm + env var (A); vendored plugin copy (B); inline HookCallback wrappers (C); build-time-computed path (D); **runtime Node resolution (E)**; direct function import (F)
- **Decision**: E — npm install + `createRequire` / `require.resolve` at runtime, wrapped in a `createContextModeHook` factory that returns `HookCallback` functions
- **Rationale**: Initial pick was A (env var). On second look, realized the Agent SDK takes `HookCallback` functions rather than shell-command strings — so we're wrapping `spawn` in JS either way. Given that, `require.resolve` lets Node's module resolver find the install location with zero hardcoding, zero env plumbing, and automatic immunity to base-image changes. F (direct import) was rejected because context-mode's hook scripts have CLI-style top-level code (stdin read, self-heal logic) that doesn't survive being imported as a library. This is a supersede of the original decision documented in the same session.

### Area 2 — Per-group opt-in
- **Options considered**: mount sentinel (mirror a-mem); explicit `containerConfig.contextMode.enabled` flag (mirror Trawl)
- **Decision**: mount sentinel
- **Rationale**: Context-mode is data-bearing per-group, same shape as a-mem (per-group ChromaDB). Trawl's flag pattern fits network services; mount fits stateful data.

### Area 3 — PreCompact coexistence
- **Options considered**: two hook entries in the array (A); wrap into single hook (B)
- **Decision**: A
- **Rationale**: Both hooks are independent observers. No shared state, no ordering dependency. SDK array supports multiple natively.

### Area 4 — Sandbox runtime scope
- **Options considered**: Node+Python+shell only (A); add Bun (B); kitchen sink (C)
- **Decision**: A
- **Rationale**: All three already present (zero MB added). `ctx_doctor` on host shows 6 runtimes working; container will have 3 of those. Add Bun only if `ctx_stats` shows JS perf as a bottleneck.

### Area 5 — Rollout sequencing
- **Options considered**: AVP first (A); Main first (B); Trading first (C); all-at-once (D)
- **Decision**: D (all four: AVP + Main + Trading + Inbox)
- **Rationale**: Previous rollouts (a-mem, Trawl) were all-at-once after validation. Trading group is low-activity (low-risk); Inbox specifically benefits because email threads are high-context-cost reads. Mount-sentinel makes rollout a small set of subvolume creations — minimal blast radius.

## Open engineering questions

### `CLAUDE_PLUGIN_ROOT` env handling
Context-mode's hook commands use `${CLAUDE_PLUGIN_ROOT}/hooks/pretooluse.mjs`. Claude Code sets this automatically when loading a plugin. **The Agent SDK inside the container doesn't.** Options:
- Install context-mode at a fixed absolute path in the container (e.g. `/opt/context-mode/`) and hardcode that in the hook commands
- Set `CLAUDE_PLUGIN_ROOT=/opt/context-mode` in the container's env
- Use inline hook implementations (`hooks: [createContextModeHook()]`) instead of shell-command hooks, mirroring how `createPreCompactHook` already works

Leaning toward option 2 (env var) for simplicity — matches the plugin's expectations with minimal divergence.

### Sandbox runtime deps
`ctx_execute` can target 11 languages. Container currently has Node + likely Python. Bun is ~90 MB. Unclear which subset is essential for Madison's work. Need to measure actual language usage in context-mode SKILL.md guidance:
- `javascript` → API calls, JSON
- `python` → data analysis, stats
- `shell` → pipes, grep/awk/jq
- Everything else: low priority

Verdict: install **JavaScript (Node, already present) + Python (already present) + shell (already present)**. Skip Bun/Deno initially; add only if `ctx_stats` says we're missing capability.

### Interaction with existing PreCompact hook
NanoClaw has `createPreCompactHook(assistantName)` writing a snapshot somewhere. Presumed to append to group's CLAUDE.md or memory.json. Context-mode's PreCompact indexes state into FTS5. They're compatible in principle — two observers of the same compaction event — but need to verify order and confirm neither corrupts the other's work.

## Relevant code paths

| File | Why |
|---|---|
| `container/agent-runner/src/index.ts:582-661` | Where `mcpServers` + `hooks` are configured on the Claude Agent SDK query |
| `container/agent-runner/src/index.ts:575-598` | a-mem opt-in pattern to mirror for context-mode |
| `container/Dockerfile` | Where to add npm global install of context-mode |
| `scripts/group-config.ts` | Per-group config management (if we go explicit-flag route) |
| `container/skills/` | Where a context-mode companion skill could live |

## Resources

- [Context-mode plugin v1.0.89](~/.claude/plugins/cache/context-mode/context-mode/1.0.89/)
- [llms.txt reference](~/.claude/plugins/cache/context-mode/context-mode/1.0.89/llms.txt)
- [Primary SKILL.md (routing decisions)](~/.claude/plugins/cache/context-mode/context-mode/1.0.89/skills/context-mode/SKILL.md)
- [Hooks registration](~/.claude/plugins/cache/context-mode/context-mode/1.0.89/hooks/hooks.json)
- [Hacker News #1 (570+ points)](https://news.ycombinator.com/item?id=47193064) — context about project traction
- [lode/plans/active/2026-04-trawl-mcp-integration/tracker.md](../2026-04-trawl-mcp-integration/tracker.md) — the observation plan this partially supersedes
