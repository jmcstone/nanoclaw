/**
 * Madison fork extensions — config + helpers that are NOT part of upstream
 * NanoClaw. Isolated here (rather than edited into upstream `config.ts`) so the
 * upstream file stays mergeable: one fewer conflict surface on the next
 * `git merge upstream`. All values are read from .env via env.ts, never loaded
 * into process.env, keeping secrets out of the process environment.
 */
import os from 'os';
import path from 'path';
import { readEnvFile, readEnvKeysWithPrefix } from './env.js';

const ext = readEnvFile([
  'TESLA_TRACKER_URL',
  'TESLA_TRACKER_API_KEY',
  'AMBIENT_WEATHER_URL',
  'CONTAINER_DNS',
  'RECALL_DB_DIR',
  'LITELLM_HOST_API_KEY',
]);

// Tailnet DNS resolver (MagicDNS) for agent containers; opt-in via CONTAINER_DNS.
// process.env first (deploy override), then .env — same precedence as config.ts.
export const CONTAINER_DNS = process.env.CONTAINER_DNS || ext.CONTAINER_DNS;

// Skill-facing service env forwarded into agent containers (tailnet REST APIs
// used by container skills, e.g. teslamate / ambient-weather). Only present keys.
export const CONTAINER_SKILL_ENV: Record<string, string> = {};
for (const k of ['TESLA_TRACKER_URL', 'TESLA_TRACKER_API_KEY', 'AMBIENT_WEATHER_URL']) {
  const v = process.env[k] || ext[k];
  if (v) CONTAINER_SKILL_ENV[k] = v;
}

// AgentMail — inbound email for the AVP pilot. API key shared across inboxes;
// each group declares its inbox via AGENTMAIL_INBOX_<FOLDER>. Inbound is handled
// host-side by agentmail-subscriber.ts; outbound by the in-container agentmail MCP.
export function resolveAgentMailApiKey(): string | undefined {
  const value = readEnvFile(['AGENTMAIL_API_KEY']).AGENTMAIL_API_KEY;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** Discover every group folder with an AgentMail inbox configured: folder→inboxId. */
export function discoverAgentMailInboxes(): Record<string, string> {
  const prefix = 'AGENTMAIL_INBOX_';
  const all = readEnvKeysWithPrefix(prefix);
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(all)) {
    if (key === 'AGENTMAIL_INBOX_API_KEY') continue;
    const folderUpper = key.slice(prefix.length);
    if (!folderUpper) continue;
    result[folderUpper.toLowerCase()] = value;
  }
  return result;
}

// Session-recall FTS5 index directory — per-group DBs sharded by agent folder,
// snapshotted on btrfs alongside all v2 durable state.
// process.env first (deploy override), then .env, then default.
const _recallDbDirRaw =
  process.env.RECALL_DB_DIR || ext.RECALL_DB_DIR || path.join(os.homedir(), 'containers/data/NanoClaw/v2/recall/');
export const RECALL_DB_DIR = path.resolve(
  _recallDbDirRaw.startsWith('~/') ? path.join(os.homedir(), _recallDbDirRaw.slice(2)) : _recallDbDirRaw,
);

/** Return the recall DB path for a specific agent group folder. */
export function recallDbPathForGroup(folder: string): string {
  return path.join(RECALL_DB_DIR, folder + '.db');
}

// LiteLLM host API key — used by the Phase 2 host-side distiller.
// May be undefined until provisioned; consumed by litellm-host-client.ts.
export const LITELLM_HOST_API_KEY: string | undefined = process.env.LITELLM_HOST_API_KEY || ext.LITELLM_HOST_API_KEY;
