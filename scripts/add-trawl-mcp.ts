/**
 * Phase B — wire the Trawl HTTP MCP server into telegram_avp (the research/
 * outreach group). Trawl is a tailnet service (no key; reachable via the
 * container's CONTAINER_DNS resolver). Dangerous external write/act tools are
 * blocked by the denylist in providers/claude.ts (SDK_DISALLOWED_TOOLS).
 *
 * Read-merges into existing mcp_servers. Picked up on next spawn. Idempotent.
 */
import { initDb } from '../src/db/connection.js';
import { getAgentGroupByFolder } from '../src/db/agent-groups.js';
import { getContainerConfig, updateContainerConfigJson } from '../src/db/container-configs.js';

const FOLDER = 'telegram_avp';
const TRAWL_URL = 'https://trawl.crested-gecko.ts.net/mcp';

function main(): void {
  initDb('data/v2.db');
  const ag = getAgentGroupByFolder(FOLDER);
  if (!ag) throw new Error(`no agent group for ${FOLDER}`);

  const cc = getContainerConfig(ag.id);
  const servers = JSON.parse(cc?.mcp_servers ?? '{}') as Record<string, unknown>;
  servers.trawl = { type: 'http', url: TRAWL_URL };
  updateContainerConfigJson(ag.id, 'mcp_servers', servers);
  console.log(`trawl → ${FOLDER} (servers: ${Object.keys(servers).join(', ')})`);
  console.log('done');
}

main();
