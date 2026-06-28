/**
 * Recall end-to-end verification — Wave 5
 *
 * Tests:
 *   Part A — AC-3  : indexer idempotency (tick adds 0 new rows when already current)
 *   Part B — AC-4  : backfill idempotency (already-done groups report 0 new inserts)
 *   Part C — AC-10 : real in-container recall via throwaway docker run + stdio MCP
 *   Part D — AC-9' : isolation by construction (single-file mount, no cross-group access)
 *
 * Run:   npx tsx scripts/verify-recall-e2e.ts
 * Exit non-zero if any of Parts A, B, or C fail.
 */

import Database from 'better-sqlite3';
import { execFileSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

// ─── Paths ─────────────────────────────────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
// Import canonical RECALL_DB_DIR from madison-extensions so .env overrides
// are respected (matches what the production indexer + container-runner use).
const { RECALL_DB_DIR } = await import('../src/madison-extensions.js');
const INBOX_DB = path.join(RECALL_DB_DIR, 'telegram_inbox.db');
const AGENT_RUNNER_SRC = path.join(PROJECT_ROOT, 'container/agent-runner/src');
const V2_DB = path.join(PROJECT_ROOT, 'data/v2.db');

// CONTAINER_IMAGE: per-checkout slug derived from sha1(projectRoot)[:8].
// This matches `getDefaultContainerImage()` in src/install-slug.ts.
const { createHash } = await import('crypto');
const INSTALL_SLUG = createHash('sha1').update(PROJECT_ROOT).digest('hex').slice(0, 8);
const CONTAINER_IMAGE = `nanoclaw-agent-v2-${INSTALL_SLUG}:latest`;

// Note: summarization auth uses HTTPS_PROXY injected by OneCLI at container spawn
// time. This verify script does a direct docker run without OneCLI, so it cannot
// inject HTTPS_PROXY and Part C validates the FTS5 data path + graceful degradation
// only — not the end-to-end Anthropic summarization path.

// ─── Outcome tracking ──────────────────────────────────────────────────────
let failCount = 0;
const log = (line: string): void => process.stdout.write(line + '\n');

function pass(label: string): void {
  log(`  PASS  ${label}`);
}
function fail(label: string): void {
  log(`  FAIL  ${label}`);
  failCount++;
}
function info(label: string): void {
  log(`         ${label}`);
}

// ─── Helper: count all session_fts rows across every recall DB ─────────────
function countAllFtsRows(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const f of fs.readdirSync(RECALL_DB_DIR).filter((n) => n.endsWith('.db'))) {
    const db = new Database(path.join(RECALL_DB_DIR, f), { readonly: true });
    const row = db.prepare('SELECT COUNT(*) as c FROM session_fts').get() as { c: number };
    db.close();
    counts[f] = row.c;
  }
  return counts;
}
function sumCounts(counts: Record<string, number>): number {
  return Object.values(counts).reduce((a, b) => a + b, 0);
}

// ═══════════════════════════════════════════════════════════════════════════
// Part A — Indexer idempotency (AC-3)
// ═══════════════════════════════════════════════════════════════════════════
async function partA(): Promise<void> {
  log('\n## Part A — Indexer idempotency (AC-3)');

  // Initialize the central v2 DB so the indexer can resolve agent group folders.
  const { initDb } = await import('../src/db/connection.js');
  initDb(V2_DB);

  const { startSessionIndexer, stopSessionIndexer } = await import('../src/session-indexer.js');

  const before = countAllFtsRows();
  const totalBefore = sumCounts(before);
  info(`Total session_fts rows before tick: ${totalBefore}`);
  for (const [f, c] of Object.entries(before)) {
    info(`  ${f}: ${c}`);
  }

  // startSessionIndexer() runs one tick synchronously then arms an interval.
  // stopSessionIndexer() cancels the interval immediately after.
  startSessionIndexer();
  stopSessionIndexer();

  const after = countAllFtsRows();
  const totalAfter = sumCounts(after);
  info(`Total session_fts rows after tick: ${totalAfter}`);

  if (totalAfter === totalBefore) {
    pass(`Indexer is idempotent: ${totalBefore} → ${totalAfter} rows (delta 0)`);
  } else {
    const delta = totalAfter - totalBefore;
    const direction = delta > 0 ? `+${delta}` : String(delta);
    fail(`Indexer is NOT idempotent: ${totalBefore} → ${totalAfter} rows (delta ${direction})`);
    for (const [f, c] of Object.entries(after)) {
      if (c !== before[f]) {
        info(`  ${f}: ${before[f] ?? 0} → ${c} (delta ${c - (before[f] ?? 0)})`);
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Part B — Backfill idempotency (AC-4)
// ═══════════════════════════════════════════════════════════════════════════
function partB(): void {
  log('\n## Part B — Backfill idempotency (AC-4)');

  let output: string;
  try {
    output = execFileSync('npx', ['tsx', 'scripts/backfill-session-fts.ts'], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
    });
  } catch (err) {
    fail(`Backfill script failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  info('Backfill output:');
  for (const line of output.trim().split('\n')) {
    info(`  ${line}`);
  }

  // On a second run, every group should report "already backfilled — skipped".
  const hasNonZeroInsert = /[1-9]\d* rows inserted/.test(output);
  const hasAlreadyDone = /already backfilled/.test(output);

  if (!hasNonZeroInsert && hasAlreadyDone) {
    pass('Backfill is idempotent: all groups already backfilled, 0 new rows inserted');
  } else if (hasNonZeroInsert) {
    fail('Backfill inserted new rows on a second run — not idempotent');
  } else {
    fail('Unexpected backfill output — could not confirm idempotency');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Part C — Real in-container recall (AC-10)
// ═══════════════════════════════════════════════════════════════════════════

/** Minimal MCP stdio client: sends requests, collects responses by id. */
async function driveMcpContainer(dockerArgs: string[], requests: string[]): Promise<{
  responses: Record<number, unknown>;
  stderr: string[];
  exitCode: number | null;
}> {
  const container = spawn('docker', dockerArgs, { stdio: ['pipe', 'pipe', 'pipe'] });

  const stderrLines: string[] = [];
  container.stderr?.on('data', (chunk: Buffer) => {
    stderrLines.push(...chunk.toString().split('\n').filter(Boolean));
  });

  // Write all requests then close stdin so the server's event loop drains.
  for (const req of requests) {
    container.stdin!.write(req);
  }
  container.stdin!.end();

  const responses: Record<number, unknown> = {};
  const rl = readline.createInterface({ input: container.stdout! });
  rl.on('line', (line: string) => {
    if (!line.trim()) return;
    try {
      const msg = JSON.parse(line) as { id?: number };
      if (typeof msg.id === 'number') responses[msg.id] = msg;
    } catch {}
  });

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      container.kill('SIGKILL');
      reject(new Error('Docker container timed out after 45 s'));
    }, 45_000);
    container.on('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    container.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

  return { responses, stderr: stderrLines, exitCode };
}

async function partC(): Promise<void> {
  log('\n## Part C — Real in-container recall (AC-10)');

  if (!fs.existsSync(INBOX_DB)) {
    fail(`Inbox recall DB not found at ${INBOX_DB}`);
    return;
  }

  // Replicate the exact mounts from container-runner.ts (buildMounts):
  //   recallDbPath → /recall/recall.db  (readonly, NOT /workspace/extra/recall/)
  //   agent-runner/src  → /app/src  (readonly)
  // Override entrypoint to bash (same pattern as production) and run the
  // recall stdio server directly instead of index.ts.
  //
  // Note: HTTPS_PROXY (OneCLI credential) is NOT injected here — this script
  // does a direct docker run without OneCLI. Summarization will degrade
  // gracefully; Part C tests FTS5 data path + citation building, not the
  // Anthropic summarization path end-to-end.
  const dockerArgs = [
    'run', '--rm', '-i',
    '--dns', '100.100.100.100',
    '--entrypoint', 'bash',
    '-v', `${INBOX_DB}:/recall/recall.db:ro`,
    '-v', `${AGENT_RUNNER_SRC}:/app/src:ro`,
    CONTAINER_IMAGE,
    '-c', 'exec bun run /app/src/recall-mcp-stdio.ts',
  ];

  info(`Image: ${CONTAINER_IMAGE}`);
  info(`Inbox DB: ${INBOX_DB}`);
  info(`Agent runner src: ${AGENT_RUNNER_SRC}`);

  // MCP stdio protocol: newline-delimited JSON-RPC 2.0
  const requests = [
    JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'verify-e2e', version: '1.0' },
      },
    }) + '\n',
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n',
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n',
    JSON.stringify({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'recall_sessions', arguments: { query: 'email' } },
    }) + '\n',
  ];

  let responses: Record<number, unknown>;
  let stderr: string[];
  try {
    ({ responses, stderr } = await driveMcpContainer(dockerArgs, requests));
  } catch (err) {
    fail(`Container failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // Server log (stderr)
  if (stderr.length > 0) {
    info('Server log:');
    for (const line of stderr) info(`  ${line}`);
  }

  // ── tools/list check ────────────────────────────────────────────────────
  const listResp = responses[2] as { result?: { tools?: Array<{ name: string }> } } | undefined;
  const hasRecallTool = listResp?.result?.tools?.some((t) => t.name === 'recall_sessions');
  if (hasRecallTool) {
    pass('tools/list: recall_sessions tool present');
  } else {
    fail('tools/list: recall_sessions tool missing');
    info(`tools/list response: ${JSON.stringify(listResp)}`);
  }

  // ── tools/call check ───────────────────────────────────────────────────
  const callResp = responses[3] as {
    result?: { content?: Array<{ type: string; text: string }>; isError?: boolean };
  } | undefined;

  if (callResp?.result?.isError) {
    fail(`tools/call returned isError=true`);
    info(`Error text: ${callResp.result.content?.[0]?.text ?? '(empty)'}`);
    return;
  }

  const rawText = callResp?.result?.content?.[0]?.text ?? '';
  let parsed: { summary?: string; citations?: Array<{ date: string; role: string; snippet: string }> } | null = null;
  try {
    parsed = JSON.parse(rawText) as typeof parsed;
  } catch {
    fail(`tools/call response is not valid JSON: ${rawText.slice(0, 200)}`);
    return;
  }

  const summary = parsed?.summary ?? '';
  const citations = parsed?.citations ?? [];
  const hasSummary = summary.length > 0;
  const hasCitations = citations.length >= 1;

  if (hasSummary && hasCitations) {
    pass(`tools/call: summary present (${summary.length} chars), ${citations.length} citation(s) ≥ 1 — data path PASS`);

    // Summarization via OneCLI proxy is not exercised by this script (no HTTPS_PROXY).
    const summarizationWorked = !summary.startsWith('[Summarization unavailable');
    info(`Anthropic summarization: ${summarizationWorked ? 'WORKING (live Haiku summary)' : 'DEGRADED — OneCLI proxy not available in test env (expected)'}`);

    info(`\n  Summary (first 400 chars):`);
    info(`  ${summary.slice(0, 400)}${summary.length > 400 ? '...' : ''}`);

    info(`\n  First 3 citations:`);
    for (const c of citations.slice(0, 3)) {
      info(`    [${c.date}] (${c.role}) ${c.snippet.slice(0, 100)}`);
    }
  } else {
    fail(`tools/call: summary=${hasSummary}, citations=${hasCitations} (need both)`);
    info(`Parsed result: ${JSON.stringify(parsed).slice(0, 500)}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Part D — Isolation by construction (AC-9')
// ═══════════════════════════════════════════════════════════════════════════
function partD(): void {
  log("\n## Part D — Isolation by construction (AC-9')");

  info('Design: container-runner.ts mounts one file per spawn:');
  info('  hostPath  : <RECALL_DB_DIR>/<folder>.db   (per-group, chosen at spawn time)');
  info('  container : /recall/recall.db  (fixed path, read-only, outside /workspace/extra/)');
  info('  No directory mount of RECALL_DB_DIR exists — containers cannot list or');
  info('  open sibling group DBs. recall-mcp-stdio.ts only reads the fixed path.');
  info('  No agent_group parameter in the recall_sessions tool API.');

  // Structural assertion: verify the mount pattern in container-runner.ts
  const runnerSrc = fs.readFileSync(path.join(PROJECT_ROOT, 'src/container-runner.ts'), 'utf8');
  const mountsRecallFile =
    runnerSrc.includes("containerPath: '/recall/recall.db'") &&
    runnerSrc.includes('recallDbPathForGroup(agentGroup.folder)');
  // Confirm the directory itself (/recall) is not mounted — only the file.
  const noRecallDirMount = !runnerSrc.match(/containerPath:\s*['"]\/recall['"]/);

  if (mountsRecallFile && noRecallDirMount) {
    pass(
      'container-runner.ts mounts per-group DB file (not the directory) at /recall/recall.db — ' +
        'isolation by construction confirmed',
    );
  } else {
    fail('container-runner.ts mount pattern check failed — review manually');
    info(`  mountsRecallFile=${mountsRecallFile}, noRecallDirMount=${noRecallDirMount}`);
  }

  // Verify recall-mcp-stdio.ts only reads from the constant RECALL_DB_PATH
  const mcpSrc = fs.readFileSync(
    path.join(PROJECT_ROOT, 'container/agent-runner/src/recall-mcp-stdio.ts'),
    'utf8',
  );
  const usesConstantPath = mcpSrc.includes("const RECALL_DB_PATH = '/recall/recall.db'");
  const noAgentGroupParam = !mcpSrc.includes('agent_group') || !mcpSrc.match(/agent_group.*param|param.*agent_group/i);

  if (usesConstantPath && noAgentGroupParam) {
    pass('recall-mcp-stdio.ts reads only the fixed RECALL_DB_PATH — no agent_group parameter');
  } else {
    fail('recall-mcp-stdio.ts isolation check failed');
    info(`  usesConstantPath=${usesConstantPath}, noAgentGroupParam=${noAgentGroupParam}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════════

log('# Recall end-to-end verification\n');
log(`PROJECT_ROOT   : ${PROJECT_ROOT}`);
log(`RECALL_DB_DIR  : ${RECALL_DB_DIR}`);
log(`CONTAINER_IMAGE: ${CONTAINER_IMAGE}`);
log(`SUMMARIZE AUTH : OneCLI HTTPS_PROXY (not injected in this test — summarization will degrade gracefully)`);

await partA().catch((err: unknown) => {
  fail(`Part A threw: ${err instanceof Error ? err.message : String(err)}`);
});

partB();

await partC().catch((err: unknown) => {
  fail(`Part C threw: ${err instanceof Error ? err.message : String(err)}`);
});

partD();

log('\n─────────────────────────────────────────────────────');
if (failCount === 0) {
  log('ALL PARTS PASSED');
  process.exit(0);
} else {
  log(`${failCount} PART(S) FAILED`);
  process.exit(1);
}
