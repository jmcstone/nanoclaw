/**
 * Phase B — wire the outbound `agentmail` MCP server into telegram_avp (the
 * AVP AgentMail pilot inbox). Lets the agent send/reply to email from inside
 * the container. Inbound is handled host-side by agentmail-subscriber.ts.
 *
 * Credential delivery = scoped per-server env (approach #1): AGENTMAIL_API_KEY
 * + the group's AGENTMAIL_INBOX_ID, sourced from v1 .env at runtime (no secret
 * in this file). Read-merges into existing mcp_servers. Idempotent.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { initDb } from '../src/db/connection.js';
import { getAgentGroupByFolder } from '../src/db/agent-groups.js';
import { getContainerConfig, updateContainerConfigJson } from '../src/db/container-configs.js';

const HOME = os.homedir();
const V1_ENV = path.join(HOME, 'containers/nanoclaw/.env');
const FOLDER = 'telegram_avp';

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
  const apiKey = env.AGENTMAIL_API_KEY;
  const inboxId = env.AGENTMAIL_INBOX_TELEGRAM_AVP;
  if (!apiKey || !inboxId) throw new Error('AGENTMAIL_API_KEY / AGENTMAIL_INBOX_TELEGRAM_AVP not set in v1 .env');

  const ag = getAgentGroupByFolder(FOLDER);
  if (!ag) throw new Error(`no agent group for ${FOLDER}`);

  const cc = getContainerConfig(ag.id);
  const servers = JSON.parse(cc?.mcp_servers ?? '{}') as Record<string, unknown>;
  servers.agentmail = {
    command: 'npx',
    args: ['-y', 'agentmail-mcp'],
    env: { AGENTMAIL_API_KEY: apiKey, AGENTMAIL_INBOX_ID: inboxId },
  };
  updateContainerConfigJson(ag.id, 'mcp_servers', servers);
  console.log(`agentmail → ${FOLDER} (servers: ${Object.keys(servers).join(', ')})`);
  console.log('done');
}

main();
