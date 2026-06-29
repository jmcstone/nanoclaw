/**
 * Phase B batch — wire Brave search (all groups) + the GitLab SSH key mount
 * (avp / inbox / avp_outreach, for `git push`).
 *
 * - Brave: `@brave/brave-search-mcp-server` stdio MCP, BRAVE_API_KEY (single
 *   key, all groups) in scoped per-server env (approach #1). Key from v1 .env.
 * - GitLab key: read-only mount of ~/.ssh/gitlab → /workspace/extra/.ssh/gitlab.
 *   Allowed by the exact-root bypass in mount-security (the key path is listed
 *   verbatim in ~/.config/nanoclaw/mount-allowlist.json). Personas already tell
 *   Madison the key lives there.
 *
 * Read-merges into existing config. Picked up on next spawn. Idempotent.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { initDb } from '../src/db/connection.js';
import { getAgentGroupByFolder } from '../src/db/agent-groups.js';
import { getContainerConfig, updateContainerConfigJson } from '../src/db/container-configs.js';

const HOME = os.homedir();
const V1_ENV = path.join(HOME, 'containers/nanoclaw/.env');

const BRAVE_GROUPS = ['telegram_main', 'telegram_inbox', 'telegram_avp', 'telegram_avp_outreach', 'telegram_trading'];
const GITLAB_GROUPS = ['telegram_avp', 'telegram_inbox', 'telegram_avp_outreach'];

const gitlabMount = {
  hostPath: path.join(HOME, '.ssh/gitlab'),
  containerPath: '.ssh/gitlab',
  readonly: true,
};

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
  const braveKey = env.BRAVE_API_KEY;
  if (!braveKey) throw new Error('BRAVE_API_KEY not set in v1 .env');

  // Brave — all groups
  for (const folder of BRAVE_GROUPS) {
    const ag = getAgentGroupByFolder(folder);
    if (!ag) {
      console.log(`SKIP brave ${folder}: no agent group`);
      continue;
    }
    const cc = getContainerConfig(ag.id);
    const servers = JSON.parse(cc?.mcp_servers ?? '{}') as Record<string, unknown>;
    servers['brave-search'] = {
      command: 'npx',
      args: ['-y', '@brave/brave-search-mcp-server'],
      env: { BRAVE_API_KEY: braveKey },
    };
    updateContainerConfigJson(ag.id, 'mcp_servers', servers);
    console.log(`brave → ${folder} (servers: ${Object.keys(servers).join(', ')})`);
  }

  // GitLab key mount — dev groups only
  for (const folder of GITLAB_GROUPS) {
    const ag = getAgentGroupByFolder(folder);
    if (!ag) {
      console.log(`SKIP gitlab ${folder}: no agent group`);
      continue;
    }
    const cc = getContainerConfig(ag.id);
    const mounts = JSON.parse(cc?.additional_mounts ?? '[]') as Array<{ containerPath: string }>;
    if (!mounts.some((m) => m.containerPath === gitlabMount.containerPath)) {
      mounts.push(gitlabMount);
      updateContainerConfigJson(ag.id, 'additional_mounts', mounts);
    }
    console.log(`gitlab key → ${folder} (mounts: ${mounts.map((m) => m.containerPath).join(', ')})`);
  }

  console.log('done');
}

main();
