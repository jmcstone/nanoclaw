# Subsystem 9 — FTS5 Session Recall + Hermes Self-Improvement

**Status: SHIPPED (Phase 1 — recall, Option B).** Live as of 2026-06-28 on branch `madison-v2`.

**Risk: MEDIUM.** Net-new files only (schema, indexer, in-container stdio MCP, LiteLLM host client).
Upstream-file hooks are exactly three short additions (D2/§5 pattern). Isolation is by construction:
each container gets only its own group's DB read-only; no token auth required.

**Design authority:** `.nanoclaw-migrations/MEMORY-RECALL-DESIGN.md` (Phase 1 = recall, steps 0–5;
Phase 2 = self-improvement, steps 6–10).

**Locked decisions:** `lode/plans/active/2026-06-session-recall/findings.md` (D1–D13; D2′/D8′/D9′/D10′
supersede/amend several originals after the gwbridge spike chose Option B).

---

## Intent

Give Madison L2 episodic memory: the agent can search past conversations for context. Session messages
are indexed into per-group FTS5 SQLite databases on the host by a periodic tick (the "session indexer").
Each container gets its own group's DB bind-mounted read-only; an in-container stdio MCP tool
(`recall_sessions`) performs an FTS5 keyword search and returns a Haiku-summarized digest
(`{summary, citations}`).

---

## Architecture (Option B — in-container stdio + per-group DBs)

The gwbridge spike (`41c7b11`) proved the host-process HTTP MCP model (D8) is unreachable from
containers — Docker's iptables rules only allow container→host traffic for docker-published ports.
Option B was chosen: deliver recall as an **in-container stdio MCP** instead of an HTTP endpoint.

Key properties of Option B:

- **No new host port.** `recall-mcp-stdio.ts` runs inside the agent container as a stdio MCP process.
  No `docker publish`, no iptables rule, no sidecar container.
- **Isolation by construction (D9′).** The recall DB is sharded one-file-per-group. Each container
  receives only its own group's `<folder>.db` bind-mounted **read-only** at
  `/workspace/extra/recall/recall.db`. A container physically cannot read another group's data.
  The forgeable-token concern from D9 is dissolved.
- **Summarize in-container.** The MCP handler calls LiteLLM at `172.31.0.1:4000` (a docker-published
  port — works). The host-side LiteLLM client (`src/litellm-host-client.ts`, D10′) is retained for
  the Phase-2 distiller but is **not on the recall path**.
- **No image rebuild.** `container/agent-runner/src/recall-mcp-stdio.ts` lives in the host-mounted
  agent-runner source tree; no container image rebuild is needed.
- **Opt-in via sentinel.** The agent-runner registers the recall MCP only when the mount is present
  (`existsSync('/workspace/extra/recall/recall.db')`), following the a-mem/context-mode sentinel
  pattern. Groups without a recall DB get no tool.

---

## Spike outcome

### D8 — gwbridge serve-direction HTTP MCP

**Date:** 2026-06-28
**Script:** `scripts/spike-recall-mcp.ts`

#### SPIKE FAIL

The orchestrator CANNOT directly serve an HTTP MCP endpoint (as a host process bound to
`0.0.0.0:<port>` or `172.31.0.1:<port>`) reachable by containers via `172.31.0.1:<port>`. TCP
connections from inside containers to host-process ports time out (curl exit 28, confirmed at both
`0.0.0.0:18090` and `172.31.0.1:18091`). Root cause: Docker's iptables rules only allow
container→host traffic for docker-published ports (docker-proxy / PREROUTING DNAT); there is no
INPUT ACCEPT rule for arbitrary host-process ports from the bridge subnet.

#### Good-token probe

```
docker run --rm --entrypoint sh nanoclaw-agent-v2-97ed9aac:latest -c \
  "curl -s -X POST 'http://172.31.0.1:18090/mcp?t=spike-test-token-x9q2r7' \
   -H 'Content-Type: application/json' \
   -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\",\"params\":{}}'"
docker exit: 28 (CURLE_OPERATION_TIMEDOUT)
stdout: (empty)
```

RESULT: FAIL — "recall_ping" absent from response (TCP connection never established).

#### Bad-token probe

```
docker run --rm --entrypoint sh nanoclaw-agent-v2-97ed9aac:latest -c \
  "curl -s -o /dev/null -w %{http_code} -X POST 'http://172.31.0.1:18090/mcp?t=WRONG_TOKEN' \
   -H 'Content-Type: application/json' \
   -d '{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\",\"params\":{}}'"
docker exit: -1 (process kill / timeout)
http_code: (empty)
```

RESULT: FAIL — could not reach the server to get 401 (same TCP timeout).

#### Restart / rebind behavior

PASS. `server.close()` + re-listen on port 18090 succeeds with no EADDRINUSE. Node.js sets
SO_REUSEADDR on listening sockets via libuv; the listening socket is not in TIME_WAIT after close.

#### What does work: published-port pattern

Docker-published ports (e.g. `mailroom-inbox-mcp-1: 172.31.0.1:18080->8080/tcp`,
`tasks-mcp: 172.31.0.1:18088->8088/tcp`) ARE reachable from inside containers at
`172.31.0.1:<port>`. The container from the default bridge subnet (`172.31.0.6`) successfully
reaches `172.31.0.1:18080` (confirmed via HTTP MCP response). These work because Docker's
docker-proxy creates a host socket AND adds iptables DNAT/ACCEPT rules for each published port.
Plain host-process sockets without docker publish have no such rules.

#### Additional probe: binding to 172.31.0.1 directly

Also tested binding to `172.31.0.1:18091` specifically (same as docker-proxy does). Result:
exit 28 (timeout). Binding address makes no difference — the iptables INPUT rules block by
source/destination pair, not by binding address.

---

### Required change for the real Wave 3 server (src/recall/mcp.ts)

The in-process model (orchestrator hosts HTTP MCP server directly) does NOT work for the
container→host direction. The recall MCP server must be delivered as a **published docker port**,
following the same pattern as `inbox-mcp` and `tasks-mcp`.

**Viable approaches (choose one):**

1. **Sidecar recall-mcp container (preferred — matches existing pattern):**
   - A dedicated container runs `src/recall/mcp.ts` (as a minimal Bun/Node HTTP server).
   - Published as `172.31.0.1:<RECALL_MCP_PORT>-><RECALL_MCP_PORT>/tcp` (same as inbox-mcp style).
   - Volume-mount the recall DB at `RECALL_DB_PATH` (read-only for search; the indexer on the host
     writes it — or mount read-write if the summarize step must also write state).
   - Lifecycle: started by the orchestrator at startup alongside the indexer; stopped on shutdown.
   - Token auth (D9) applies unchanged: the MCP server reads tokens from a shared file or its own
     in-container token store, updated by the orchestrator at each agent spawn.

2. **iptables INPUT rule at startup (fragile, not recommended):**
   - `iptables -I DOCKER-USER -s 172.31.0.0/16 -p tcp --dport <RECALL_MCP_PORT> -j ACCEPT`
   - Requires the orchestrator to run as root or with `CAP_NET_ADMIN` — incompatible with the
     current non-root model.
   - Doesn't survive reboots without additional setup (systemd pre-start unit or iptables-restore).
   - Not pursued.

**D9 token auth** (per-spawn token baked into the container's `mcp_servers` URL) applies to
approach 1 without change. The token→(agent_group, session_id) map lives in a file or ephemeral
in-container store written by the orchestrator at spawn time.

**Revised upstream-file hooks (container-runner.ts):**
- At spawn: mint recall token → write to shared token file → bake `?t=<token>` into mcp_servers URL.
- The sidecar container picks up the token file via volume mount (no code change needed in the sidecar).

---

## Files (shipped)

### New files (never conflict on upgrade)

| File | Purpose |
|------|---------|
| `src/recall/schema.ts` | `session_fts` FTS5 table + `session_fts_state` watermark; opened per-group at a caller-supplied path (`ef97f5a`). |
| `src/session-indexer.ts` | Host periodic tick (~60 s); walks `v2-sessions/<group>/<session>/`; writes per-group DBs; rowid-cursor watermark; delete-before-insert idempotency (`a6b415f` → refactored `8baf440`). |
| `src/litellm-host-client.ts` | Host-side LiteLLM client (`:4000`). **Retained for Phase-2 distiller; NOT on the recall path** (D10′, `35302e9`). |
| `scripts/backfill-session-fts.ts` | One-shot backfill of v1 archive (`store/messages.db`) into per-group DBs (`d4daf40` → `8baf440`). V1 is inbound-only — no `assistant` rows produced. |
| `container/agent-runner/src/recall-mcp-stdio.ts` | In-container Bun stdio MCP. Opens `/workspace/extra/recall/recall.db` RO. FTS5 MATCH → top-k → Haiku summary via `172.31.0.1:4000`. Returns `{summary, citations}` (`2b0d4d6`). |

### Upstream-file hooks (3 hooks, each 1–5 lines)

| Upstream file | Hook | Commit |
|---------------|------|--------|
| `src/index.ts` | Start/stop the host session indexer alongside `startHostSweep()` | `57a6762` |
| `src/container-runner.ts` | Mount per-group recall DB read-only at `/workspace/extra/recall/recall.db`; `existsSync`-gated (groups without a DB get no mount) | `3f0b3cb` |
| `container/agent-runner/src/index.ts` | Sentinel-gated recall stdio MCP registration (skipped when mount absent) | `97ea70f` |

---

## Storage model

- **`RECALL_DB_DIR`** (default `~/containers/data/NanoClaw/v2/recall/`): exported from
  `madison-extensions.ts` alongside `recallDbPathForGroup(folder)` = `<dir>/<folder>.db`.
  Supersedes the original single-file `RECALL_DB_PATH` (D2′, `747ada4` → `3df39d5`).
- **Per-group DB** (`<folder>.db`): written by the host session indexer; mounted read-only into
  the matching container at `/workspace/extra/recall/recall.db`.
- **mount-allowlist entry**: `~/containers/data/NanoClaw/v2/recall` (read-only). No new host port;
  no image rebuild required.
- **Schema**: `session_fts(msg_id UNINDEXED, session_id UNINDEXED, agent_group, ts UNINDEXED, role,
  content, tokenize='porter unicode61')` + `session_fts_state(source PK, last_indexed_ts)`.

---

## Risk / quirks

| Item | Detail |
|------|--------|
| V1 archive is inbound-only | `store/messages.db` has only `messages` rows (user direction). The backfill produces no `assistant` rows for v1 sessions — recall coverage for pre-v2 conversations is keyword-limited to user-side content. |
| Folder resolution fallback | Agent groups whose folder cannot be resolved via `getAgentGroup()` get a DB named `ag-<id>.db` rather than `<folder>.db`. The container mount will not match unless the same fallback is applied consistently in both the indexer and `container-runner.ts`. |
| LiteLLM model alias | The in-container summarizer calls LiteLLM with the alias `haiku`. This alias must exist in the LiteLLM gateway config; if absent the summarize step errors and the tool falls back to raw citations. |
| Recall quality: keyword-only | Search uses porter unicode61 FTS5 — good for exact terms, poor for synonyms. Query expansion (D13) and recency blending are deferred. Add `sqlite-vec` only after verifying it loads under the `better-sqlite3-multiple-ciphers` fork. |

---

## Phase 2 deferred (self-improvement)

The following were explicitly deferred from Phase 1 (details in `MEMORY-RECALL-DESIGN.md` §3):

- **Distiller** — host-side process that compresses session transcripts into durable summaries and
  writes back into `session_fts`. `src/litellm-host-client.ts` (D10′) is already in place for this.
- **`helpfulness_events` ledger + L1 lifecycle re-rank** — tracks per-session quality signals for
  skill promotion.
- **Stable keys + rejection tombstone** — prevents re-promoting a skill that was explicitly rejected.
- **`skill_manage` + `trial` flag** in `claude-md-compose` — wires the promote/demote lifecycle into
  Claude.md fragment includes.
- **Nightly promote pass** — scheduled job that reviews L1 signals and promotes trial skills to
  permanent.
- **PR gate** — blocks skill promotion until a GitHub PR exists.
- **Recall quality B** — index distiller summaries into `session_fts` (depends on distiller existing).
- **`scope='all'` union query** — cross-group recall (dropped for Phase 1 per D9′).
