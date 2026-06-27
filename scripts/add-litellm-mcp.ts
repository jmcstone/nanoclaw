/**
 * Phase B — wire the litellm MCP server into the Madison groups that had a
 * LiteLLM virtual key in v1 (main, avp, trading, inbox; NOT avp_outreach).
 *
 * Read-merges a `litellm` stdio server into each group's existing mcp_servers.
 * Credential delivery = approach #1 (scoped per-server env): the per-group
 * virtual key is sourced from v1 .env at runtime (no secret in this file) and
 * placed in the litellm server's own env, scoped to that subprocess.
 *
 * Picked up on the next container spawn — no service restart needed. Idempotent.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { initDb } from '../src/db/connection.js';
import { getAgentGroupByFolder } from '../src/db/agent-groups.js';
import { getContainerConfig, updateContainerConfigJson } from '../src/db/container-configs.js';

const HOME = os.homedir();
const LITELLM_BASE_URL = 'http://172.31.0.1:4000'; // gwbridge host IP; gateway is 0.0.0.0:4000
const V1_ENV = path.join(HOME, 'containers/nanoclaw/.env');

// folder → v1 env var holding that group's virtual key
const GROUPS: Array<[string, string]> = [
  ['telegram_main', 'LITELLM_API_KEY_TELEGRAM_MAIN'],
  ['telegram_avp', 'LITELLM_API_KEY_TELEGRAM_AVP'],
  ['telegram_trading', 'LITELLM_API_KEY_TELEGRAM_TRADING'],
  ['telegram_inbox', 'LITELLM_API_KEY_TELEGRAM_INBOX'],
];

function loadEnv(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

function main(): void {
  initDb('data/v2.db');
  const env = loadEnv(V1_ENV);

  for (const [folder, keyVar] of GROUPS) {
    const ag = getAgentGroupByFolder(folder);
    if (!ag) {
      console.log(`SKIP ${folder}: no agent group`);
      continue;
    }
    const key = env[keyVar];
    if (!key) {
      console.log(`SKIP ${folder}: ${keyVar} not set in v1 .env`);
      continue;
    }
    const cc = getContainerConfig(ag.id);
    const servers = JSON.parse(cc?.mcp_servers ?? '{}') as Record<string, unknown>;
    servers.litellm = {
      command: 'bun',
      args: ['run', '/app/src/litellm-route-mcp-stdio.ts'],
      env: { LITELLM_BASE_URL, LITELLM_API_KEY: key },
    };
    updateContainerConfigJson(ag.id, 'mcp_servers', servers);
    console.log(`wired litellm → ${folder} (servers: ${Object.keys(servers).join(', ')})`);
  }
  console.log('done');
}

main();
