/**
 * Madison fork extensions — config + helpers that are NOT part of upstream
 * NanoClaw. Isolated here (rather than edited into upstream `config.ts`) so the
 * upstream file stays mergeable: one fewer conflict surface on the next
 * `git merge upstream`. All values are read from .env via env.ts, never loaded
 * into process.env, keeping secrets out of the process environment.
 */
import { readEnvFile, readEnvKeysWithPrefix } from './env.js';

const ext = readEnvFile(['TESLA_TRACKER_URL', 'TESLA_TRACKER_API_KEY', 'AMBIENT_WEATHER_URL', 'CONTAINER_DNS']);

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
