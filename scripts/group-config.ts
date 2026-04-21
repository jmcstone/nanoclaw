#!/usr/bin/env tsx
/**
 * group-config — CLI helper for editing registered_groups.container_config.
 *
 * Subcommands:
 *   get <folder>
 *     Dump the group's full container_config JSON (or {} if unset).
 *
 *   set <folder> <dotted.key> <value>
 *     Set a field. Value is parsed as JSON when possible (true, false, 123,
 *     "string", [1,2,3]) and falls back to a raw string otherwise. Nested
 *     keys are auto-created as objects. Example:
 *         group-config set telegram_avp trawl.enabled true
 *         group-config set telegram_avp trawl.excludedTools '["zoho_*"]'
 *
 *   trawl-defaults <folder>
 *     Apply the Trawl per-group default from the defaults table
 *     (see scripts/trawl-defaults.ts). Known folders:
 *       telegram_avp, main, telegram_main  -> wildcard, no exclusions
 *       telegram_trading, telegram_inbox, * -> wildcard, excludedTools ["zoho_*"]
 *
 * Flags:
 *   --dry-run   Print what would change without writing.
 *   --db <path> Override DB path (default: ~/containers/data/NanoClaw/store/messages.db,
 *               falls back to ./store/messages.db if NANOCLAW_DATA_ROOT is unset).
 *
 * Read-only commands (`get`) never mutate the DB. Write commands open the DB
 * in read/write mode only when --dry-run is absent.
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { STORE_DIR } from '../src/config.ts';
import {
  applyTrawlDefault,
  getTrawlDefault,
} from './trawl-defaults.js';
import { applyContextModeMount, getContextModeMount } from './context-mode-defaults.js';

type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [k: string]: Json };

interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[a.slice(2)] = next;
          i++;
        } else {
          flags[a.slice(2)] = true;
        }
      }
    } else {
      positional.push(a);
    }
  }
  return {
    command: positional[0] ?? '',
    positional: positional.slice(1),
    flags,
  };
}

function resolveDbPath(override?: string): string {
  if (override) {
    return path.resolve(override.replace(/^~/, os.homedir()));
  }
  // STORE_DIR from src/config.ts already resolves NANOCLAW_DATA_ROOT vs
  // project-local fallback. Prefer the jarvis install path when it exists
  // even from a dev checkout so this CLI works against the live DB.
  const defaultPath = path.join(
    os.homedir(),
    'containers',
    'data',
    'NanoClaw',
    'store',
    'messages.db',
  );
  if (fs.existsSync(defaultPath)) return defaultPath;
  return path.join(STORE_DIR, 'messages.db');
}

function parseJsonValue(raw: string): Json {
  // Try strict JSON parse first so booleans/numbers/arrays/objects DTRT.
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function setDotted(obj: Record<string, Json>, dotted: string, value: Json): void {
  const keys = dotted.split('.');
  let cur: Record<string, Json> = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    const existing = cur[k];
    if (typeof existing !== 'object' || existing === null || Array.isArray(existing)) {
      cur[k] = {};
    }
    cur = cur[k] as Record<string, Json>;
  }
  cur[keys[keys.length - 1]] = value;
}

interface GroupRow {
  jid: string;
  folder: string;
  container_config: string | null;
}

function findGroupByFolder(db: Database.Database, folder: string): GroupRow | null {
  const row = db
    .prepare(
      'SELECT jid, folder, container_config FROM registered_groups WHERE folder = ?',
    )
    .get(folder) as GroupRow | undefined;
  return row ?? null;
}

function readConfig(row: GroupRow): Record<string, Json> {
  if (!row.container_config) return {};
  try {
    const parsed = JSON.parse(row.container_config);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, Json>;
    }
    return {};
  } catch {
    return {};
  }
}

function writeConfig(
  db: Database.Database,
  jid: string,
  config: Record<string, Json>,
): void {
  db.prepare(
    'UPDATE registered_groups SET container_config = ? WHERE jid = ?',
  ).run(JSON.stringify(config), jid);
}

function printUsage(): void {
  process.stderr.write(
    [
      'Usage:',
      '  group-config get <folder>',
      '  group-config set <folder> <dotted.key> <value> [--dry-run]',
      '  group-config trawl-defaults <folder> [--dry-run]',
      '  group-config context-mode-defaults <folder> [--dry-run]',
      '',
      'Flags:',
      '  --dry-run       Show diff without writing',
      '  --db <path>     Override SQLite database path',
      '',
    ].join('\n'),
  );
}

function main(): void {
  const { command, positional, flags } = parseArgs(process.argv.slice(2));
  if (!command) {
    printUsage();
    process.exit(1);
  }
  const dryRun = flags['dry-run'] === true || flags['dry-run'] === 'true';
  const dbPath = resolveDbPath(typeof flags.db === 'string' ? flags.db : undefined);

  if (!fs.existsSync(dbPath)) {
    process.stderr.write(`DB not found at ${dbPath}\n`);
    process.exit(2);
  }

  const readonly = command === 'get' || dryRun;
  const db = new Database(dbPath, { readonly });

  try {
    switch (command) {
      case 'get': {
        const folder = positional[0];
        if (!folder) {
          process.stderr.write('get: missing <folder>\n');
          process.exit(1);
        }
        const row = findGroupByFolder(db, folder);
        if (!row) {
          process.stderr.write(`No registered group with folder=${folder}\n`);
          process.exit(3);
        }
        process.stdout.write(JSON.stringify(readConfig(row), null, 2) + '\n');
        return;
      }

      case 'set': {
        const [folder, key, ...rest] = positional;
        if (!folder || !key || rest.length === 0) {
          process.stderr.write('set: expected <folder> <dotted.key> <value>\n');
          process.exit(1);
        }
        const value = parseJsonValue(rest.join(' '));
        const row = findGroupByFolder(db, folder);
        if (!row) {
          process.stderr.write(`No registered group with folder=${folder}\n`);
          process.exit(3);
        }
        const before = readConfig(row);
        const after = JSON.parse(JSON.stringify(before)) as Record<string, Json>;
        setDotted(after, key, value);
        const diff = {
          folder,
          key,
          value,
          before,
          after,
        };
        if (dryRun) {
          process.stdout.write(
            '[dry-run] would update container_config:\n' +
              JSON.stringify(diff, null, 2) +
              '\n',
          );
          return;
        }
        writeConfig(db, row.jid, after);
        process.stdout.write(
          `Updated ${folder}: ${key} = ${JSON.stringify(value)}\n`,
        );
        return;
      }

      case 'trawl-defaults': {
        const folder = positional[0];
        if (!folder) {
          process.stderr.write('trawl-defaults: missing <folder>\n');
          process.exit(1);
        }
        const row = findGroupByFolder(db, folder);
        if (!row) {
          process.stderr.write(`No registered group with folder=${folder}\n`);
          process.exit(3);
        }
        const before = readConfig(row);
        const trawlDefault = getTrawlDefault(folder);
        const after = applyTrawlDefault(before, trawlDefault) as Record<string, Json>;
        const diff = { folder, trawlDefault, before, after };
        if (dryRun) {
          process.stdout.write(
            '[dry-run] would apply Trawl default:\n' +
              JSON.stringify(diff, null, 2) +
              '\n',
          );
          return;
        }
        writeConfig(db, row.jid, after);
        process.stdout.write(
          `Applied Trawl default to ${folder}: ${JSON.stringify(trawlDefault)}\n`,
        );
        return;
      }

      case 'context-mode-defaults': {
        const folder = positional[0];
        if (!folder) {
          process.stderr.write('context-mode-defaults: missing <folder>\n');
          process.exit(1);
        }
        const row = findGroupByFolder(db, folder);
        if (!row) {
          process.stderr.write(`No registered group with folder=${folder}\n`);
          process.exit(3);
        }
        const before = readConfig(row);
        const mount = getContextModeMount(folder);
        const after = applyContextModeMount(before, folder) as Record<string, Json>;
        const diff = { folder, mount, before, after };
        if (dryRun) {
          process.stdout.write(
            '[dry-run] would apply context-mode mount:\n' +
              JSON.stringify(diff, null, 2) +
              '\n',
          );
          return;
        }
        writeConfig(db, row.jid, after);
        process.stdout.write(
          `Applied context-mode mount to ${folder}: ${JSON.stringify(mount)}\n`,
        );
        return;
      }

      default:
        process.stderr.write(`Unknown command: ${command}\n`);
        printUsage();
        process.exit(1);
    }
  } finally {
    db.close();
  }
}

main();
