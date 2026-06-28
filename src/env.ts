import fs from 'fs';
import path from 'path';
import { log } from './log.js';

/**
 * Parse every KEY=value entry from the .env file (skipping blanks/comments,
 * stripping matched surrounding quotes). Does NOT touch process.env — keeping
 * secrets out of the process environment so they don't leak to child processes.
 * Internal: callers filter the result by exact key or prefix.
 */
function parseAllEnvEntries(): Record<string, string> {
  const envFile = path.join(process.cwd(), '.env');
  let content: string;
  try {
    content = fs.readFileSync(envFile, 'utf-8');
  } catch (err) {
    log.debug('.env file not found, using defaults', { err });
    return {};
  }

  const result: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (value) result[key] = value;
  }
  return result;
}

/** Parse the .env file and return values for the requested keys. */
export function readEnvFile(keys: string[]): Record<string, string> {
  const all = parseAllEnvEntries();
  const wanted = new Set(keys);
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(all)) {
    if (wanted.has(key)) result[key] = value;
  }
  return result;
}

/**
 * Parse the .env file and return every key/value whose key starts with the
 * given prefix (e.g. discovering all AGENTMAIL_INBOX_<FOLDER> entries).
 */
export function readEnvKeysWithPrefix(prefix: string): Record<string, string> {
  const all = parseAllEnvEntries();
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith(prefix)) result[key] = value;
  }
  return result;
}
