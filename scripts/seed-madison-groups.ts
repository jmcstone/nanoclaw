/**
 * Seed the 5 real Madison groups into v2 for the cutover (BASELINE).
 * Idempotent-ish: run against a FRESH data/v2.db (wipe first). Baseline defers
 * Trawl / litellm / brave / agentmail / tesla-weather / .ssh / google-data to Phase B
 * (see .nanoclaw-migrations/CUTOVER-GROUPS.md). Personas copied from v1 data dir.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { initDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { createAgentGroup, getAgentGroupByFolder } from '../src/db/agent-groups.js';
import { updateContainerConfigScalars, updateContainerConfigJson } from '../src/db/container-configs.js';
import {
  createMessagingGroup,
  getMessagingGroupByPlatform,
  createMessagingGroupAgent,
  getMessagingGroupAgentByPair,
} from '../src/db/messaging-groups.js';
import { upsertUser } from '../src/modules/permissions/db/users.js';
import { grantRole, hasAnyOwner } from '../src/modules/permissions/db/user-roles.js';
import { initGroupFilesystem } from '../src/group-init.js';
import { GROUPS_DIR } from '../src/config.js';

const HOME = os.homedir();
const OWNER = 'telegram:6847601234'; // Jeff's Telegram DM = owner
const V1_PERSONAS = path.join(HOME, 'containers/data/NanoClaw/groups');
const OBS = path.join(HOME, 'Documents/Obsidian/Main');
const CODE = path.join(HOME, 'containers/data/NanoClaw/code');

const now = () => new Date().toISOString();
const gen = (p: string) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const ollama = { command: 'bun', args: ['run', '/app/src/ollama-mcp-stdio.ts'] };
const tasks = { type: 'http' as const, url: 'http://172.31.0.1:18088/mcp' };
const messages = { type: 'http' as const, url: 'http://172.31.0.1:18080/mcp' };
const wikiMount = { hostPath: path.join(OBS, 'LLM'), containerPath: 'wiki', readonly: false };
const sharedMount = { hostPath: path.join(OBS, 'NanoClaw/_Shared'), containerPath: 'shared', readonly: false };
const devApt = ['ripgrep', 'fd-find', 'jq', 'fzf', 'build-essential'];

interface Spec {
  folder: string;
  name: string;
  chatId: string;
  isGroup: boolean;
  model: string | null;
  assistantName: string;
  mcp: Record<string, unknown>;
  mounts: Array<{ hostPath: string; containerPath: string; readonly: boolean }>;
  apt: string[];
}

const SPECS: Spec[] = [
  {
    folder: 'telegram_main',
    name: 'Madison',
    chatId: '6847601234',
    isGroup: false,
    model: null,
    assistantName: 'Madison',
    mcp: { ollama, tasks },
    mounts: [
      { hostPath: path.join(OBS, 'NanoClaw/Personal'), containerPath: 'obsidian', readonly: false },
      wikiMount,
      sharedMount,
    ],
    apt: [],
  },
  {
    folder: 'telegram_inbox',
    name: 'Madison Inbox',
    chatId: '-5273779685',
    isGroup: true,
    model: 'claude-sonnet-4-6',
    assistantName: 'Madison',
    mcp: { ollama, messages, tasks },
    mounts: [
      { hostPath: path.join(OBS, 'NanoClaw/Inbox'), containerPath: 'obsidian', readonly: false },
      { hostPath: path.join(CODE, 'inbox'), containerPath: 'code', readonly: false },
      wikiMount,
      sharedMount,
    ],
    apt: [],
  },
  {
    folder: 'telegram_avp',
    name: 'Madison AVP',
    chatId: '-1003800188692',
    isGroup: true,
    model: 'claude-opus-4-7',
    assistantName: 'Madison',
    mcp: { ollama },
    mounts: [
      { hostPath: path.join(OBS, 'NanoClaw/AmericanVoxPop'), containerPath: 'obsidian', readonly: false },
      { hostPath: path.join(CODE, 'avp-research'), containerPath: 'code', readonly: false },
      wikiMount,
      sharedMount,
    ],
    apt: devApt,
  },
  {
    folder: 'telegram_avp_outreach',
    name: 'Madison AVP-Outreach',
    chatId: '-5152405016',
    isGroup: true,
    model: null,
    assistantName: 'Madison AVP-Outreach',
    mcp: { ollama },
    mounts: [
      { hostPath: path.join(OBS, 'NanoClaw/AmericanVoxPop'), containerPath: 'obsidian', readonly: false },
      { hostPath: path.join(CODE, 'avp-outreach'), containerPath: 'code', readonly: false },
      wikiMount,
      sharedMount,
    ],
    apt: devApt,
  },
  {
    folder: 'telegram_trading',
    name: 'Madison Trading',
    chatId: '-5211322204',
    isGroup: true,
    model: 'claude-opus-4-7',
    assistantName: 'Madison',
    mcp: { ollama },
    mounts: [
      { hostPath: path.join(OBS, 'NanoClaw/AlgoTrader'), containerPath: 'algotrader', readonly: false },
      wikiMount,
      sharedMount,
    ],
    apt: [],
  },
];

function main() {
  const db = initDb('data/v2.db');
  runMigrations(db);

  // Owner = Jeff (Telegram DM), global owner role.
  upsertUser({ id: OWNER, kind: 'telegram', display_name: 'Jeff', created_at: now() });
  if (!hasAnyOwner()) {
    grantRole({ user_id: OWNER, role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });
    console.log('granted owner:', OWNER);
  }

  for (const s of SPECS) {
    let ag = getAgentGroupByFolder(s.folder);
    if (!ag) {
      const id = gen('ag');
      createAgentGroup({ id, name: s.name, folder: s.folder, agent_provider: null, created_at: now() });
      ag = getAgentGroupByFolder(s.folder)!;
    }
    // persona from v1
    const persona = fs.readFileSync(path.join(V1_PERSONAS, s.folder, 'CLAUDE.md'), 'utf8');
    initGroupFilesystem(ag, { instructions: persona });
    fs.writeFileSync(path.join(GROUPS_DIR, s.folder, 'CLAUDE.local.md'), persona); // ensure v1 persona

    updateContainerConfigScalars(ag.id, {
      model: s.model ?? undefined,
      assistant_name: s.assistantName,
      max_messages_per_prompt: 5,
    });
    updateContainerConfigJson(ag.id, 'mcp_servers', s.mcp);
    updateContainerConfigJson(ag.id, 'skills', 'all');
    updateContainerConfigJson(ag.id, 'additional_mounts', s.mounts);
    updateContainerConfigJson(ag.id, 'packages_apt', s.apt);

    // messaging group + wiring
    let mg = getMessagingGroupByPlatform('telegram', `telegram:${s.chatId}`);
    if (!mg) {
      mg = {
        id: gen('mg'),
        channel_type: 'telegram',
        platform_id: `telegram:${s.chatId}`,
        instance: 'telegram',
        name: s.name,
        is_group: s.isGroup ? 1 : 0,
        unknown_sender_policy: 'strict',
        created_at: now(),
      };
      createMessagingGroup(mg);
    }
    if (!getMessagingGroupAgentByPair(mg.id, ag.id)) {
      createMessagingGroupAgent({
        id: gen('mga'),
        messaging_group_id: mg.id,
        agent_group_id: ag.id,
        engage_mode: 'pattern',
        engage_pattern: '.',
        sender_scope: 'all',
        ignored_message_policy: 'drop',
        session_mode: 'shared',
        priority: 0,
        created_at: now(),
      });
    }
    console.log(
      `seeded ${s.folder} → ${ag.id} (${mg.platform_id}, model=${s.model ?? 'default'}, mounts=${s.mounts.length})`,
    );
  }
  console.log('\nDone. 5 groups seeded.');
}

main();
