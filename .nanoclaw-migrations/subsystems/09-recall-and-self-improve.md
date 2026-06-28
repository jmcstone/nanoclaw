# Subsystem 9 — FTS5 Session Recall + Hermes Self-Improvement

**Risk: MEDIUM.** Net-new files only (schema, indexer, MCP server, LiteLLM host client, distiller,
proposals). Upstream-file hooks are exactly three short additions (D2/§5 pattern). The recall MCP
delivery mechanism requires a container-published port (see Spike outcome below) rather than
in-process serving — confirmed by the gwbridge spike before any code was committed.

**Design authority:** `.nanoclaw-migrations/MEMORY-RECALL-DESIGN.md` (Phase 1 = recall, steps 0–5;
Phase 2 = self-improvement, steps 6–10).

**Locked decisions:** `lode/plans/active/2026-06-session-recall/findings.md` (D1–D13).

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

## Net-new files (to be created — Phase 1)

| File | Piece |
|------|-------|
| `src/recall/schema.ts` | `session_fts` + watermark on dedicated DB at `RECALL_DB_PATH` |
| `src/session-indexer.ts` | Periodic host-side indexer (idempotent on msg_id, ~30–60s tick) |
| `src/recall/mcp.ts` | HTTP MCP server — runs INSIDE the sidecar container (see spike outcome) |
| `src/litellm-host-client.ts` | Host-side LiteLLM `:4000` client (net-new per D10) |
| `scripts/backfill-session-fts.ts` | One-shot v1 backfill from `store/messages.db` |
| `scripts/add-recall-mcp.ts` | Idempotent per-group recall MCP wiring |

## Upstream-file hooks (minimal, 1–3 lines each)

| Upstream file | Hook |
|---------------|------|
| `src/index.ts` | Start indexer + launch recall-mcp sidecar next to startHostSweep() |
| `src/container-runner.ts` | At spawn: mint recall token → bake into mcp_servers URL |
| `src/claude-md-compose.ts` | Honor skill `trial` flag at fragment-include site (Phase 2) |

---

*Phase 2 (self-improvement: distiller, helpfulness_events, skill_manage, nightly promote, PR gate)
is not in scope here — details in MEMORY-RECALL-DESIGN.md §3.*
