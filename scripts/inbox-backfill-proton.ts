/**
 * ProtonMail historical backfill script.
 *
 * Usage:
 *   npx tsx scripts/inbox-backfill-proton.ts [options]
 *
 * Options:
 *   --address <addr>     Limit to a single address
 *   --from-scratch       Ignore cursor; start from UID 1
 *   --dry-run            Fetch + parse but don't write to store or advance cursor
 *   --batch-size <n>     Override default batch size (default: 50)
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

import { ImapFlow } from 'imapflow';

import { readEnvFile } from '../src/env.js';
import { pickBody } from '../src/channels/email-body.js';
import {
  parseReferencesHeader,
  extractProtonmailBody,
} from '../src/channels/protonmail.js';
import { ingestProtonmail } from '../src/inbox-store/ingest.js';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

interface CliArgs {
  address: string | null;
  fromScratch: boolean;
  dryRun: boolean;
  batchSize: number;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    address: null,
    fromScratch: false,
    dryRun: false,
    batchSize: 50,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--address' && argv[i + 1]) {
      args.address = argv[++i];
    } else if (arg === '--from-scratch') {
      args.fromScratch = true;
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg === '--batch-size' && argv[i + 1]) {
      const n = parseInt(argv[++i], 10);
      if (!isNaN(n) && n > 0) args.batchSize = n;
    }
  }

  return args;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface ProtonmailConfig {
  addresses: string[];
  host: string;
  imapPort: number;
}

function loadConfig(): { config: ProtonmailConfig; password: string } {
  const configPath = path.join(
    os.homedir(),
    '.protonmail-bridge',
    'config.json',
  );

  if (!fs.existsSync(configPath)) {
    die('Protonmail config not found at ~/.protonmail-bridge/config.json');
  }

  const config: ProtonmailConfig = JSON.parse(
    fs.readFileSync(configPath, 'utf-8'),
  );

  const secrets = readEnvFile(['PROTONMAIL_BRIDGE_PASSWORD']);
  if (!secrets.PROTONMAIL_BRIDGE_PASSWORD) {
    die('PROTONMAIL_BRIDGE_PASSWORD not found in .env');
  }

  return { config, password: secrets.PROTONMAIL_BRIDGE_PASSWORD };
}

// ---------------------------------------------------------------------------
// Cursor persistence
// ---------------------------------------------------------------------------

const CURSOR_DIR = path.join(
  os.homedir(),
  'containers',
  'data',
  'NanoClaw',
  'inbox',
);
const CURSOR_FILE = path.join(CURSOR_DIR, 'backfill-cursor.json');

type CursorData = Record<string, number>;

function readCursor(): CursorData {
  try {
    return JSON.parse(fs.readFileSync(CURSOR_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function writeCursor(data: CursorData): void {
  fs.mkdirSync(CURSOR_DIR, { recursive: true });
  fs.writeFileSync(CURSOR_FILE, JSON.stringify(data, null, 2));
}

function getCursorKey(address: string): string {
  return `proton.${address}.last_uid`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function die(msg: string): never {
  process.stderr.write(`FATAL: ${msg}\n`);
  process.exit(1);
}

function log(msg: string): void {
  process.stderr.write(`[backfill-proton] ${msg}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Per-address backfill
// ---------------------------------------------------------------------------

async function backfillAddress(
  address: string,
  config: ProtonmailConfig,
  password: string,
  args: CliArgs,
  cursorData: CursorData,
): Promise<void> {
  const cursorKey = getCursorKey(address);
  const fromUid = args.fromScratch ? 0 : (cursorData[cursorKey] ?? 0);

  log(
    `${address}: starting from UID ${fromUid + 1}${args.dryRun ? ' [dry-run]' : ''}`,
  );

  const client = new ImapFlow({
    host: config.host,
    port: config.imapPort,
    secure: false,
    auth: { user: address, pass: password },
    tls: { rejectUnauthorized: false },
    logger: false,
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');

    try {
      // SEARCH ALL returns all UIDs in INBOX
      const allUids = (await client.search({ all: true })) as number[];
      if (!allUids || !allUids.length) {
        log(`${address}: mailbox empty`);
        return;
      }

      // Filter to UIDs we haven't processed yet
      const uids = allUids
        .filter((uid) => uid > fromUid)
        .sort((a, b) => a - b);

      if (!uids.length) {
        log(`${address}: no new messages beyond cursor UID ${fromUid}`);
        return;
      }

      log(`${address}: ${uids.length} messages to process`);

      let batchIndex = 0;
      let totalInserted = 0;
      let totalSkipped = 0;
      let totalErrors = 0;
      let highestIngested = fromUid;

      for (let i = 0; i < uids.length; i += args.batchSize) {
        const batch = uids.slice(i, i + args.batchSize);
        batchIndex++;

        log(
          `${address}: batch ${batchIndex} — UIDs ${batch[0]}–${batch[batch.length - 1]} (${batch.length} msgs)`,
        );

        let batchInserted = 0;
        let batchSkipped = 0;

        for (const uid of batch) {
          try {
            const msg = await client.fetchOne(uid, {
              envelope: true,
              source: true,
            });

            if (!msg || !('envelope' in msg)) {
              log(`${address}: UID ${uid}: no envelope, skipping`);
              totalErrors++;
              continue;
            }

            const envelope = (msg as { envelope: any; source?: Buffer })
              .envelope;
            const from = envelope.from?.[0];
            if (!from) {
              log(`${address}: UID ${uid}: no from, skipping`);
              totalErrors++;
              continue;
            }

            const senderEmail: string = from.address || '';
            const senderName: string = from.name || senderEmail;
            const rawSubject: string = envelope.subject || '';
            const subject: string | null =
              rawSubject && rawSubject !== '(no subject)' ? rawSubject : null;
            const messageId: string = envelope.messageId || `uid-${uid}`;
            const date: string = envelope.date
              ? new Date(envelope.date).toISOString()
              : new Date().toISOString();

            const fetchMsg = msg as { source?: Buffer };
            if (!fetchMsg.source) {
              log(`${address}: UID ${uid}: no source body, skipping`);
              totalErrors++;
              continue;
            }

            const { plain, html } = extractProtonmailBody(fetchMsg.source);
            const body = pickBody(plain, html);

            if (!body) {
              log(`${address}: UID ${uid}: empty body, skipping`);
              totalErrors++;
              continue;
            }

            const references = parseReferencesHeader(fetchMsg.source);

            // Extract In-Reply-To from raw source headers
            const sourceStr = fetchMsg.source.toString('utf-8');
            const headerEnd = sourceStr.search(/\r?\n\r?\n/);
            const headerSection =
              headerEnd === -1 ? sourceStr : sourceStr.slice(0, headerEnd);
            const inReplyToMatch = headerSection.match(
              /^in-reply-to\s*:\s*(<[^>]+>)/im,
            );
            const inReplyTo: string | null = inReplyToMatch
              ? inReplyToMatch[1]
              : null;

            if (!args.dryRun) {
              const result = ingestProtonmail({
                account_email: address,
                source_message_id: messageId,
                sender_email: senderEmail,
                sender_name: senderName || null,
                subject,
                body_markdown: body,
                received_at: date,
                in_reply_to: inReplyTo,
                references,
              });

              if (result.inserted) {
                batchInserted++;
                highestIngested = Math.max(highestIngested, uid);
              } else {
                batchSkipped++;
                // Still advance cursor for already-ingested messages
                highestIngested = Math.max(highestIngested, uid);
              }
            } else {
              log(
                `${address}: UID ${uid} [dry-run]: from=${senderEmail} subject=${subject ?? '(no subject)'} body=${body.slice(0, 80).replace(/\n/g, ' ')}...`,
              );
              highestIngested = Math.max(highestIngested, uid);
            }
          } catch (err) {
            log(`${address}: UID ${uid}: error — ${(err as Error).message}`);
            totalErrors++;
            // Recoverable: skip this message and continue
          }
        }

        totalInserted += batchInserted;
        totalSkipped += batchSkipped;

        log(
          `${address}: batch ${batchIndex} done — inserted=${batchInserted} skipped=${batchSkipped}`,
        );

        // Persist cursor after each successful batch (only if not dry-run)
        if (!args.dryRun && highestIngested > fromUid) {
          cursorData[cursorKey] = highestIngested;
          writeCursor(cursorData);
        }

        // Stagger between batches
        if (i + args.batchSize < uids.length) {
          await sleep(250);
        }
      }

      log(
        `${address}: complete — inserted=${totalInserted} skipped=${totalSkipped} errors=${totalErrors} highest_uid=${highestIngested}`,
      );
    } finally {
      lock.release();
    }
  } finally {
    try {
      await client.logout();
    } catch {
      // Ignore logout errors
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { config, password } = loadConfig();

  const addresses = args.address
    ? [args.address]
    : config.addresses;

  if (args.address && !config.addresses.includes(args.address)) {
    log(
      `Warning: --address ${args.address} not found in config.json addresses list`,
    );
  }

  const cursorData = readCursor();

  for (let i = 0; i < addresses.length; i++) {
    const address = addresses[i];

    try {
      await backfillAddress(address, config, password, args, cursorData);
    } catch (err) {
      log(
        `${address}: unrecoverable error — ${(err as Error).message}`,
      );
      // Continue to next address rather than aborting entirely
    }

    // Stagger between addresses
    if (i < addresses.length - 1) {
      log(`Staggering 2s before next address...`);
      await sleep(2000);
    }
  }

  log('Backfill complete.');
}

main().catch((err) => {
  process.stderr.write(`FATAL: ${err.message}\n`);
  process.exit(1);
});
