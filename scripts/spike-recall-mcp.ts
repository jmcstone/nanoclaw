/**
 * Spike: gwbridge serve-direction HTTP MCP reachability test (D8 / D9).
 *
 * Validates that the orchestrator can bind an HTTP MCP server on
 * 0.0.0.0:18090 and have containers reach it at 172.31.0.1:18090 via the
 * docker gwbridge.  This is the inverse of the PROVEN consume-direction
 * (orchestrator consuming MCPs in containers) — it is unproven until this
 * spike says PASS.
 *
 * Also validates the per-spawn-token auth model (D9): the server maps an
 * opaque ?t=<token> to (agent_group, session_id) server-side, rejecting
 * requests with unknown tokens with HTTP 401.
 *
 * Run: npx tsx scripts/spike-recall-mcp.ts
 * Expected final line: SPIKE PASS
 */
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { URL } from 'node:url';

// Hardcoded spike constants — real server reads from madison-extensions.ts
const PORT = 18090;
const GWBRIDGE_HOST = '172.31.0.1';
const CONTAINER_IMAGE = 'nanoclaw-agent-v2-97ed9aac:latest';
const TEST_TOKEN = 'spike-test-token-x9q2r7';

// Token registry: token -> (agentGroup, sessionId) binding.
// This is the D9 design: per-spawn capability token, bound server-side.
const TOKEN_REGISTRY = new Map<string, { agentGroup: string; sessionId: string }>();
TOKEN_REGISTRY.set(TEST_TOKEN, { agentGroup: 'test-group', sessionId: 'spike-001' });

// ---------------------------------------------------------------------------
// Minimal JSON-RPC 2.0 / MCP handler
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc: string;
  id: number | string | null;
  method: string;
  params?: unknown;
}

function jsonRpcOk(id: number | string | null, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

function handleMcpBody(body: string): string {
  let req: JsonRpcRequest;
  try {
    req = JSON.parse(body) as JsonRpcRequest;
  } catch {
    return JSON.stringify({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' },
    });
  }

  const { method, id } = req;

  switch (method) {
    case 'initialize':
      return jsonRpcOk(id, {
        protocolVersion: '2024-11-05',
        serverInfo: { name: 'recall-mcp-spike', version: '0.0.1' },
        capabilities: { tools: {} },
      });

    case 'notifications/initialized':
      return ''; // notification — no response body

    case 'tools/list':
      return jsonRpcOk(id, {
        tools: [
          {
            name: 'recall_ping',
            description:
              'Spike probe tool — confirms gwbridge recall MCP reachability',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      });

    case 'tools/call':
      return jsonRpcOk(id, {
        content: [{ type: 'text', text: 'pong from recall-mcp-spike' }],
      });

    default:
      return JSON.stringify({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: 'Method not found' },
      });
  }
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

function createMcpServer(): http.Server {
  // Node.js sets SO_REUSEADDR on listening sockets via libuv (uv__tcp_bind),
  // so rebinding after server.close() works without TIME_WAIT issues.
  return http.createServer((req, res) => {
    const reqUrl = new URL(req.url ?? '/', `http://localhost:${PORT}`);

    if (req.method !== 'POST' || reqUrl.pathname !== '/mcp') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found\n');
      return;
    }

    const token = reqUrl.searchParams.get('t') ?? '';
    if (!TOKEN_REGISTRY.has(token)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      const response = handleMcpBody(body);
      if (response === '') {
        res.writeHead(204);
        res.end();
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(response);
      }
    });
  });
}

function listenServer(server: http.Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, '0.0.0.0', () => resolve());
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

// ---------------------------------------------------------------------------
// Docker probe helper
// ---------------------------------------------------------------------------

interface ProbeResult {
  stdout: string;
  stderr: string;
  status: number;
}

function dockerProbe(shellCmd: string): ProbeResult {
  const result = spawnSync(
    'docker',
    ['run', '--rm', '--entrypoint', 'sh', CONTAINER_IMAGE, '-c', shellCmd],
    { encoding: 'utf8', timeout: 30_000 }
  );
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? -1,
  };
}

// ---------------------------------------------------------------------------
// Main spike
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const failures: string[] = [];
  let goodProbeOutput = '';
  let badProbeOutput = '';
  let goodDockerCmd = '';
  let badDockerCmd = '';

  // Phase 1 — start server
  console.log(`[spike] Binding HTTP MCP server on 0.0.0.0:${PORT}...`);
  const server = createMcpServer();
  await listenServer(server);
  console.log(`[spike] Server listening on 0.0.0.0:${PORT}.`);

  try {
    // Phase 2 — good-token probe: tools/list must contain "recall_ping"
    console.log('\n[probe] GOOD TOKEN -> tools/list');
    const goodShellCmd = [
      'curl -s',
      `-X POST 'http://${GWBRIDGE_HOST}:${PORT}/mcp?t=${TEST_TOKEN}'`,
      `-H 'Content-Type: application/json'`,
      `-d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'`,
    ].join(' ');
    goodDockerCmd = `docker run --rm --entrypoint sh ${CONTAINER_IMAGE} -c "${goodShellCmd}"`;
    console.log(`  cmd: ${goodDockerCmd}`);

    const goodResult = dockerProbe(goodShellCmd);
    goodProbeOutput = goodResult.stdout.trim();
    console.log(`  docker exit: ${goodResult.status}`);
    console.log(`  stdout: ${goodProbeOutput}`);
    if (goodResult.stderr.trim()) {
      console.log(`  stderr: ${goodResult.stderr.trim()}`);
    }

    if (goodProbeOutput.includes('recall_ping')) {
      console.log('  PASS: response contains "recall_ping"');
    } else {
      failures.push(
        `good-token probe: "recall_ping" absent from response (got: ${goodProbeOutput || '(empty)'})`
      );
      console.log('  FAIL: response does not contain "recall_ping"');
    }

    // Phase 3 — bad-token probe: must return HTTP 401
    console.log('\n[probe] BAD TOKEN -> expect HTTP 401');
    const badShellCmd = [
      'curl -s -o /dev/null -w %{http_code}',
      `-X POST 'http://${GWBRIDGE_HOST}:${PORT}/mcp?t=WRONG_TOKEN'`,
      `-H 'Content-Type: application/json'`,
      `-d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'`,
    ].join(' ');
    badDockerCmd = `docker run --rm --entrypoint sh ${CONTAINER_IMAGE} -c "${badShellCmd}"`;
    console.log(`  cmd: ${badDockerCmd}`);

    const badResult = dockerProbe(badShellCmd);
    badProbeOutput = badResult.stdout.trim();
    console.log(`  docker exit: ${badResult.status}`);
    console.log(`  http_code: ${badProbeOutput}`);
    if (badResult.stderr.trim()) {
      console.log(`  stderr: ${badResult.stderr.trim()}`);
    }

    if (badProbeOutput === '401') {
      console.log('  PASS: got HTTP 401 for bad token');
    } else {
      failures.push(
        `bad-token probe: expected HTTP 401, got "${badProbeOutput}"`
      );
      console.log(`  FAIL: expected 401, got "${badProbeOutput}"`);
    }
  } finally {
    // Phase 4 — restart / rebind test
    console.log(`\n[spike] Restart test: close -> re-open on port ${PORT}...`);
    await closeServer(server);
    console.log('[spike] Server closed.');

    const server2 = createMcpServer();
    try {
      await listenServer(server2);
      console.log(`  PASS: rebound on port ${PORT} without EADDRINUSE`);
      await closeServer(server2);
    } catch (err: unknown) {
      const nodeErr = err as NodeJS.ErrnoException;
      const msg =
        nodeErr.code === 'EADDRINUSE'
          ? `EADDRINUSE on port ${PORT}`
          : `unexpected error: ${nodeErr.message}`;
      failures.push(`restart: ${msg}`);
      console.log(`  FAIL: ${msg}`);
      // Attempt cleanup even after error
      await closeServer(server2).catch(() => undefined);
    }
  }

  // Final result
  console.log('\n' + '='.repeat(60));
  if (failures.length === 0) {
    console.log('SPIKE PASS');
    console.log('  Containers reach 172.31.0.1:18090 via docker gwbridge.');
    console.log('  Per-token auth (D9): HTTP 401 on bad token confirmed.');
    console.log('  Clean rebind after server.close(): no EADDRINUSE.');
  } else {
    console.log('SPIKE FAIL:');
    for (const f of failures) {
      console.log(`  - ${f}`);
    }
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  const e = err as Error;
  console.error(`\nSPIKE FAIL: unhandled error: ${e.message ?? String(err)}`);
  process.exit(1);
});
