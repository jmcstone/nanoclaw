import fs from 'fs';
import os from 'os';
import path from 'path';

import { log } from './log.js';

// Per-folder allowlist for AgentMail inbound senders. Email is external and
// untrusted, so the default-when-unconfigured is **deny all** — the opposite of
// trusted chat channels which default allow.
//
// File schema (~/.config/nanoclaw/agentmail-allowlist.json), keyed by the
// agent group folder that owns the inbox:
//   {
//     "telegram_avp": {
//       "allowedSenders": ["alice@avp.com", "bob@avp.com"],
//       "allowedDomains": ["avp.com"],
//       "allowAny": false
//     },
//     "telegram_other": { "allowAny": true }
//   }
//
// allowedSenders match exact email (case-insensitive). allowedDomains match
// the right-hand side of the @ (case-insensitive). allowAny is an explicit
// escape hatch for testing — set true to bypass matching entirely.

export const AGENTMAIL_ALLOWLIST_PATH = path.join(os.homedir(), '.config', 'nanoclaw', 'agentmail-allowlist.json');

export interface AgentMailFolderEntry {
  allowedSenders?: string[];
  allowedDomains?: string[];
  allowAny?: boolean;
}

export type AgentMailAllowlist = Record<string, AgentMailFolderEntry>;

const EMPTY_ALLOWLIST: AgentMailAllowlist = {};

function isValidEntry(entry: unknown): entry is AgentMailFolderEntry {
  if (!entry || typeof entry !== 'object') return false;
  const e = entry as Record<string, unknown>;
  if (
    e.allowedSenders !== undefined &&
    !(Array.isArray(e.allowedSenders) && e.allowedSenders.every((v) => typeof v === 'string'))
  ) {
    return false;
  }
  if (
    e.allowedDomains !== undefined &&
    !(Array.isArray(e.allowedDomains) && e.allowedDomains.every((v) => typeof v === 'string'))
  ) {
    return false;
  }
  if (e.allowAny !== undefined && typeof e.allowAny !== 'boolean') {
    return false;
  }
  return true;
}

export function loadAgentMailAllowlist(pathOverride?: string): AgentMailAllowlist {
  const filePath = pathOverride ?? AGENTMAIL_ALLOWLIST_PATH;

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
    // eslint-disable-next-line no-catch-all/no-catch-all -- fs read can fail for various reasons; all gracefully degrade to empty allowlist
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return EMPTY_ALLOWLIST;
    }
    log.warn('agentmail-allowlist: cannot read config', { err, path: filePath });
    return EMPTY_ALLOWLIST;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    log.warn('agentmail-allowlist: invalid JSON', { path: filePath });
    return EMPTY_ALLOWLIST;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    log.warn('agentmail-allowlist: root must be object', { path: filePath });
    return EMPTY_ALLOWLIST;
  }

  const out: AgentMailAllowlist = {};
  for (const [folder, entry] of Object.entries(parsed as Record<string, unknown>)) {
    if (isValidEntry(entry)) {
      out[folder] = entry;
    } else {
      log.warn('agentmail-allowlist: skipping invalid folder entry', { folder, path: filePath });
    }
  }
  return out;
}

/**
 * Decide whether `senderEmail` is permitted to deliver mail to the AgentMail
 * inbox owned by `folder`. Pure function — no I/O. Default policy is deny:
 *   - folder absent from allowlist → false
 *   - folder present but no rule matches → false
 *   - folder.allowAny === true → true (escape hatch)
 *   - exact match in allowedSenders (case-insensitive) → true
 *   - domain match in allowedDomains (case-insensitive) → true
 */
export function isAgentMailSenderAllowed(folder: string, senderEmail: string, allowlist: AgentMailAllowlist): boolean {
  const entry = allowlist[folder];
  if (!entry) return false;
  if (entry.allowAny === true) return true;

  const sender = senderEmail.trim().toLowerCase();
  if (!sender) return false;

  if (entry.allowedSenders && entry.allowedSenders.length > 0) {
    for (const allowed of entry.allowedSenders) {
      if (allowed.trim().toLowerCase() === sender) return true;
    }
  }

  if (entry.allowedDomains && entry.allowedDomains.length > 0) {
    const atIdx = sender.indexOf('@');
    if (atIdx > 0) {
      const senderDomain = sender.slice(atIdx + 1);
      for (const domain of entry.allowedDomains) {
        if (domain.trim().toLowerCase() === senderDomain) return true;
      }
    }
  }

  return false;
}
