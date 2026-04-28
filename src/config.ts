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
  'OLLAMA_ADMIN_TOOLS',
  'ONECLI_URL',
  'TELEGRAM_BOT_POOL',
  'TZ',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const OLLAMA_ADMIN_TOOLS =
  (process.env.OLLAMA_ADMIN_TOOLS || envConfig.OLLAMA_ADMIN_TOOLS) === 'true';
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
export const IPC_POLL_INTERVAL = 1000;
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);
export const MAX_EMAIL_PREVIEW_CHARS = Math.max(
  0,
  parseInt(process.env.MAX_EMAIL_PREVIEW_CHARS || '200', 10) || 200,
);

// Obsidian-resident settings (visible + editable on any device via sync).
// Host-side only — never mounted into containers.
export const OBSIDIAN_SETTINGS_DIR = path.join(
  HOME_DIR,
  'Documents',
  'Obsidian',
  'Main',
  'NanoClaw',
  '_Settings',
);
export const DEFAULTS_PATH = path.join(OBSIDIAN_SETTINGS_DIR, 'defaults.json');
export const GROUP_OVERRIDES_PATH = path.join(
  OBSIDIAN_SETTINGS_DIR,
  'group-overrides.json',
);
export const OBSIDIAN_TASKS_DIR = path.join(OBSIDIAN_SETTINGS_DIR, 'tasks');

// Cross-group dropbox: a shared directory mounted RW into every working-group
// container at /workspace/extra/shared/. Used by `forward_to_group` for file
// handoff between Madisons (Phase 1 of cross-lead-workflows). Trust model is
// "registered Madisons only" — discipline beats per-file ACLs at this scale.
export const OBSIDIAN_SHARED_DIR = path.join(
  HOME_DIR,
  'Documents',
  'Obsidian',
  'Main',
  'NanoClaw',
  '_Shared',
);

interface GlobalDefaults {
  maxMessagesPerPrompt?: number;
  idleTimeoutMs?: number;
  sessionMaxMessages?: number;
  sessionMaxAgeHours?: number;
}

function readDefaults(): GlobalDefaults {
  try {
    if (!fs.existsSync(DEFAULTS_PATH)) return {};
    const parsed = JSON.parse(fs.readFileSync(DEFAULTS_PATH, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

// Precedence for each setting: Obsidian defaults.json → .env → built-in.
// Per-group overrides (group-overrides.json) layer on top of this via the
// resolve* functions below.
function resolveInt(
  obsidianValue: number | undefined,
  envValue: string | undefined,
  fallback: number,
): number {
  if (typeof obsidianValue === 'number' && obsidianValue > 0)
    return Math.max(1, obsidianValue);
  const envInt = envValue ? parseInt(envValue, 10) : NaN;
  if (Number.isFinite(envInt) && envInt > 0) return Math.max(1, envInt);
  return fallback;
}

const defaults = readDefaults();

export const MAX_MESSAGES_PER_PROMPT = resolveInt(
  defaults.maxMessagesPerPrompt,
  process.env.MAX_MESSAGES_PER_PROMPT,
  10,
);
export const IDLE_TIMEOUT = resolveInt(
  defaults.idleTimeoutMs,
  process.env.IDLE_TIMEOUT,
  1800000, // 30 min
);
export const SESSION_MAX_AGE_HOURS = resolveInt(
  defaults.sessionMaxAgeHours,
  process.env.SESSION_MAX_AGE_HOURS,
  24,
);
export const SESSION_MAX_MESSAGES = resolveInt(
  defaults.sessionMaxMessages,
  process.env.SESSION_MAX_MESSAGES,
  50,
);

export interface GroupOverride {
  model?: string;
  sessionMaxMessages?: number;
  sessionMaxAgeHours?: number;
  litellmApiKey?: string;
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

export function resolveGroupLitellmKey(folder: string): string | undefined {
  // Precedence: per-group .env var (host-only, never synced) → group-overrides.json
  // (Obsidian-synced). .env is preferred for keys to keep secrets out of any
  // device that syncs the Obsidian vault. Reads from .env on demand rather than
  // process.env (readEnvFile design — secrets never enter the host process env).
  const envName = `LITELLM_API_KEY_${folder.replace(/-/g, '_').toUpperCase()}`;
  const envValue = readEnvFile([envName])[envName];
  if (typeof envValue === 'string' && envValue.trim()) {
    return envValue.trim();
  }
  const override = getGroupOverride(folder).litellmApiKey;
  return typeof override === 'string' && override.trim()
    ? override.trim()
    : undefined;
}

export const LITELLM_BASE_URL =
  process.env.LITELLM_BASE_URL || 'http://host.docker.internal:4000';

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
