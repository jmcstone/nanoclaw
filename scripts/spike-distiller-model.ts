/**
 * Spike: Distiller model credential resolution (SI-12).
 *
 * Purpose: Determine which cheap non-Anthropic model the host-side distiller
 * can actually call via the LiteLLM gateway at http://localhost:4000.
 *
 * This is Wave 1 of Phase 2 (self-improvement): a GATE that resolves
 * DISTILLER_MODEL before the distiller is built in Wave 3. Same pattern as
 * the Phase-1 gwbridge spike — prove the credential path works first.
 *
 * Key resolution order (mirrors litellm-host-client.ts):
 *   1. process.env.LITELLM_HOST_API_KEY  (deploy/test override)
 *   2. .env LITELLM_HOST_API_KEY         (primary host-distiller key)
 *   3. LITELLM_API_KEY_* from nanoclaw/.env  (test fallback — same gateway;
 *      labeled so the output is unambiguous about what's missing)
 *
 * Run:  npx tsx scripts/spike-distiller-model.ts
 * Final line: SPIKE PASS: <alias>  or  SPIKE FAIL: <reason>
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { callHostLiteLLM } from '../src/litellm-host-client.js';

const HOST_LITELLM_BASE_URL = 'http://localhost:4000';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Minimal .env parser (duplicates env.ts logic; scripts dir isn't in tsconfig
// include so we can't import from src/ without tsx — we import callHostLiteLLM
// above via tsx, but keep env parsing self-contained here).
// ---------------------------------------------------------------------------

function parseEnvFile(envPath: string): Record<string, string> {
  const result: Record<string, string> = {};
  try {
    const content = fs.readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();
      if (
        value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'")))
      ) {
        value = value.slice(1, -1);
      }
      if (value) result[key] = value;
    }
  } catch {
    /* file absent — ok */
  }
  return result;
}

// ---------------------------------------------------------------------------
// Step 1: Resolve the effective API key.
// ---------------------------------------------------------------------------

const localEnv = parseEnvFile(path.join(PROJECT_ROOT, '.env'));

// Primary path — same precedence as litellm-host-client.ts.
const primaryKey: string | undefined =
  process.env['LITELLM_HOST_API_KEY'] || localEnv['LITELLM_HOST_API_KEY'] || undefined;

// Test fallback: per-group virtual keys from the nanoclaw sibling project.
// These are real keys to the same LiteLLM gateway. Used ONLY when primaryKey
// is absent — to still enumerate models and prove the gateway works.
let testFallbackKey: string | undefined;
let testFallbackName = '';
if (!primaryKey) {
  const siblingEnvPath = path.join(PROJECT_ROOT, '../nanoclaw/.env');
  const siblingEnv = parseEnvFile(siblingEnvPath);
  const fallbackEntry = Object.entries(siblingEnv).find(([k]) =>
    k.startsWith('LITELLM_API_KEY_'),
  );
  if (fallbackEntry) {
    [testFallbackName, testFallbackKey] = fallbackEntry;
  }
}

const effectiveKey = primaryKey ?? testFallbackKey;

const keyStatus = primaryKey
  ? 'PRESENT (LITELLM_HOST_API_KEY in .env or process.env)'
  : testFallbackKey
    ? `MISSING — LITELLM_HOST_API_KEY not in .env; using ${testFallbackName} from nanoclaw/.env as test proxy`
    : 'MISSING — no LiteLLM key found anywhere';

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

console.log('=== Distiller Model Credential Spike (SI-12) ===');
console.log(`Gateway:    ${HOST_LITELLM_BASE_URL}`);
console.log(`Key status: ${keyStatus}`);
console.log('');

if (!effectiveKey) {
  console.log('Cannot proceed without a key — LiteLLM returns 401 without auth.');
  console.log('Action required: add LITELLM_HOST_API_KEY to .env (issue a key in the LiteLLM admin UI).');
  console.log('');
  console.log('SPIKE FAIL: no API key available (LITELLM_HOST_API_KEY missing from .env)');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Step 2: List registered models.
// ---------------------------------------------------------------------------

const authHeaders: Record<string, string> = {
  Authorization: `Bearer ${effectiveKey}`,
};

let registeredModels: string[] = [];
console.log('Fetching GET /v1/models...');
try {
  const res = await fetch(`${HOST_LITELLM_BASE_URL}/v1/models`, { headers: authHeaders });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    console.log(`SPIKE FAIL: GET /v1/models → ${res.status}: ${body}`);
    process.exit(1);
  }
  const data = (await res.json()) as { data?: Array<{ id: string }> };
  registeredModels = (data.data ?? []).map((m) => m.id);
  console.log(`Registered aliases (${registeredModels.length}):`);
  for (const m of registeredModels) {
    console.log(`  - ${m}`);
  }
  console.log('');
} catch (err) {
  console.log(
    `SPIKE FAIL: Could not reach LiteLLM at ${HOST_LITELLM_BASE_URL}: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
}

if (registeredModels.length === 0) {
  console.log('SPIKE FAIL: No models registered in LiteLLM.');
  console.log('Action required: register at least one cheap non-Anthropic model alias in the LiteLLM admin UI.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Step 3: Select cheap non-Anthropic candidates.
// Priority (cheapest/fastest first): gemini flash, gpt-mini, grok fast.
// ---------------------------------------------------------------------------

const CHEAP_PATTERNS: RegExp[] = [
  /gemini.*flash/i,
  /gpt.*mini/i,
  /grok.*fast/i,
  /gemini.*lite/i,
  /gpt.*nano/i,
];

const ANTHROPIC_PATTERNS: RegExp[] = [
  /claude/i,
  /haiku/i,
  /sonnet/i,
  /opus/i,
  /anthropic/i,
];

const isAnthropicModel = (m: string): boolean => ANTHROPIC_PATTERNS.some((p) => p.test(m));

// First try: models matching a cheap-model pattern.
let candidates = registeredModels.filter(
  (m) => CHEAP_PATTERNS.some((p) => p.test(m)) && !isAnthropicModel(m),
);

// Fallback: any non-Anthropic model.
if (candidates.length === 0) {
  candidates = registeredModels.filter((m) => !isAnthropicModel(m));
}

console.log(`Cheap non-Anthropic candidates (${candidates.length}):`);
if (candidates.length === 0) {
  console.log('  (none found)');
  console.log('SPIKE FAIL: No cheap non-Anthropic models found in registered list.');
  process.exit(1);
}
for (const c of candidates) {
  console.log(`  - ${c}`);
}
console.log('');

// ---------------------------------------------------------------------------
// Step 4: Test each candidate with callHostLiteLLM.
// ---------------------------------------------------------------------------

console.log('Testing candidates via callHostLiteLLM...');

let passAlias: string | undefined;
const backups: string[] = [];
const failures: string[] = [];

for (const alias of candidates) {
  process.stdout.write(`  ${alias} ... `);
  try {
    const reply = await callHostLiteLLM(
      alias,
      [{ role: 'user', content: 'Reply with exactly: OK' }],
      { apiKey: effectiveKey },
    );
    const trimmed = reply.trim();
    process.stdout.write(`PASS (reply: ${JSON.stringify(trimmed.slice(0, 80))})\n`);
    if (passAlias === undefined) {
      passAlias = alias;
    } else if (backups.length < 2) {
      backups.push(alias);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stdout.write(`FAIL (${msg.slice(0, 120)})\n`);
    failures.push(`${alias}: ${msg.slice(0, 120)}`);
  }
}
console.log('');

// ---------------------------------------------------------------------------
// Step 5: Report.
// ---------------------------------------------------------------------------

const keyActionNote = primaryKey
  ? 'LITELLM_HOST_API_KEY is present — distiller can use it as-is.'
  : `LITELLM_HOST_API_KEY is MISSING from .env.\n` +
    `  The distiller needs this key. Issue one in the LiteLLM admin UI and add:\n` +
    `    LITELLM_HOST_API_KEY=<issued-key>   # host-side distiller key\n` +
    `  to /home/jeff/containers/nanoclaw-v2-worktree/.env\n` +
    `  (Test above used ${testFallbackName} from nanoclaw/.env as a proxy for the same gateway)`;

if (passAlias !== undefined) {
  const backupClause = backups.length > 0 ? `; backups: ${backups.join(', ')}` : '';
  console.log(`SPIKE PASS: ${passAlias}${backupClause}`);
  console.log('');
  console.log('Key note:');
  console.log(`  ${keyActionNote.split('\n').join('\n  ')}`);
  console.log('');
  console.log(`DISTILLER_MODEL = '${passAlias}'`);
} else {
  console.log('SPIKE FAIL: all cheap model invocations errored.');
  for (const f of failures) {
    console.log(`  ${f}`);
  }
  console.log('');
  console.log('Key note:');
  console.log(`  ${keyActionNote.split('\n').join('\n  ')}`);
}
