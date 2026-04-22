import fs from 'fs';
import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';
import { isValidTimezone } from './timezone.js';

// Read config values from .env (falls back to process.env).
// Secrets (API keys, tokens) are NOT read here — they are loaded only
// by the credential proxy (credential-proxy.ts), never exposed to containers.
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'CREDENTIAL_PROXY_PORT',
  'NANOCLAW_DATA_ROOT',
  'ONECLI_URL',
  'TELEGRAM_BOT_POOL',
  'TZ',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'sender-allowlist.json',
);
// Optional external data root (e.g. ~/containers/data/NanoClaw for BTRFS snapshots).
// When set, all persistent data lives outside the project directory.
const rawDataRoot =
  process.env.NANOCLAW_DATA_ROOT || envConfig.NANOCLAW_DATA_ROOT || '';
const DATA_ROOT = rawDataRoot
  ? path.resolve(rawDataRoot.replace(/^~/, HOME_DIR))
  : '';

export const STORE_DIR = DATA_ROOT
  ? path.resolve(DATA_ROOT, 'store')
  : path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = DATA_ROOT
  ? path.resolve(DATA_ROOT, 'groups')
  : path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = DATA_ROOT
  ? path.resolve(DATA_ROOT, 'data')
  : path.resolve(PROJECT_ROOT, 'data');
export const DOWNLOADS_DIR = DATA_ROOT
  ? path.resolve(DATA_ROOT, 'downloads')
  : path.resolve(PROJECT_ROOT, 'downloads');

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const CREDENTIAL_PROXY_PORT = parseInt(
  process.env.CREDENTIAL_PROXY_PORT ||
    envConfig.CREDENTIAL_PROXY_PORT ||
    '3001',
  10,
);
export const ONECLI_URL =
  process.env.ONECLI_URL || envConfig.ONECLI_URL || 'http://localhost:10254';
export const MAX_MESSAGES_PER_PROMPT = Math.max(
  1,
  parseInt(process.env.MAX_MESSAGES_PER_PROMPT || '10', 10) || 10,
);
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);
export const MAX_EMAIL_PREVIEW_CHARS = Math.max(
  0,
  parseInt(process.env.MAX_EMAIL_PREVIEW_CHARS || '200', 10) || 200,
);
export const SESSION_MAX_AGE_HOURS = Math.max(
  1,
  parseInt(process.env.SESSION_MAX_AGE_HOURS || '24', 10) || 24,
);
export const SESSION_MAX_MESSAGES = Math.max(
  1,
  parseInt(process.env.SESSION_MAX_MESSAGES || '50', 10) || 50,
);

// Per-group operational overrides (model, session rotation).
// Lives in the Obsidian vault so Jeff can edit on any device.
// Host-side only — not mounted into containers.
export const GROUP_OVERRIDES_PATH = path.join(
  HOME_DIR,
  'Documents',
  'Obsidian',
  'Main',
  'NanoClaw',
  '_Settings',
  'group-overrides.json',
);

export interface GroupOverride {
  model?: string;
  sessionMaxMessages?: number;
  sessionMaxAgeHours?: number;
}

function readGroupOverrides(): Record<string, GroupOverride> {
  try {
    if (!fs.existsSync(GROUP_OVERRIDES_PATH)) return {};
    const raw = fs.readFileSync(GROUP_OVERRIDES_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function getGroupOverride(folder: string): GroupOverride {
  return readGroupOverrides()[folder] ?? {};
}

export function resolveSessionMaxMessages(folder: string): number {
  const override = getGroupOverride(folder).sessionMaxMessages;
  if (typeof override === 'number' && override > 0)
    return Math.max(1, override);
  return SESSION_MAX_MESSAGES;
}

export function resolveSessionMaxAgeHours(folder: string): number {
  const override = getGroupOverride(folder).sessionMaxAgeHours;
  if (typeof override === 'number' && override > 0)
    return Math.max(1, override);
  return SESSION_MAX_AGE_HOURS;
}

export function resolveGroupModel(folder: string): string | undefined {
  const override = getGroupOverride(folder).model;
  return typeof override === 'string' && override.trim()
    ? override.trim()
    : undefined;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildTriggerPattern(trigger: string): RegExp {
  return new RegExp(`^${escapeRegex(trigger.trim())}\\b`, 'i');
}

export const DEFAULT_TRIGGER = `@${ASSISTANT_NAME}`;

export function getTriggerPattern(trigger?: string): RegExp {
  const normalizedTrigger = trigger?.trim();
  return buildTriggerPattern(normalizedTrigger || DEFAULT_TRIGGER);
}

export const TRIGGER_PATTERN = buildTriggerPattern(DEFAULT_TRIGGER);

// Timezone for scheduled tasks, message formatting, etc.
// Validates each candidate is a real IANA identifier before accepting.
function resolveConfigTimezone(): string {
  const candidates = [
    process.env.TZ,
    envConfig.TZ,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  ];
  for (const tz of candidates) {
    if (tz && isValidTimezone(tz)) return tz;
  }
  return 'UTC';
}
export const TIMEZONE = resolveConfigTimezone();

export const TELEGRAM_BOT_POOL = (
  process.env.TELEGRAM_BOT_POOL ||
  envConfig.TELEGRAM_BOT_POOL ||
  ''
)
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean);
