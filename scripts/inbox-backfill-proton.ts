/**
 * ProtonMail historical backfill script.
 *
 * Walks UIDs newest-first (descending) so that Ctrl-C at any point leaves the
 * most recent mail already in the store — only older history remains un-ingested.
 *
 * Usage:
 *   npx tsx scripts/inbox-backfill-proton.ts [options]
 *
 * Options:
 *   --address <addr>     Limit to a single address
 *   --from-scratch       Ignore cursor; start from top of mailbox
 *   --dry-run            Fetch + parse but don't write to store or advance cursor
 *   --batch-size <n>     Override default batch size (default: 50)
 *   --floor-uid <n>      Stop backfill below this UID (default: 1)
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

import { readEnvFile } from '../src/env.js';
import { pickBody } from '../src/channels/email-body.js';
import {
  deriveProtonThreadId,
  extractProtonmailBody,
  openProtonInbox,
  parseReferencesHeader,
  type ProtonmailConfig,
} from '../src/channels/protonmail.js';
import { DATA_DIR } from '../src/config.js';
import { ingestMessage } from '../src/inbox-store/ingest.js';
import { logger } from '../src/logger.js';

const backfillLog = logger.child({ component: 'backfill-proton' });

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

interface CliArgs {
  address: string | null;
  fromScratch: boolean;
  dryRun: boolean;
  batchSize: number;
  floorUid: number;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    address: null,
    fromScratch: false,
    dryRun: false,
    batchSize: 50,
    floorUid: 1,
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
    } else if (arg === '--floor-uid' && argv[i + 1]) {
      const n = parseInt(argv[++i], 10);
      if (!isNaN(n) && n >= 1) args.floorUid = n;
    }
  }

  return args;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

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
//
// New cursor shape (per address):
//   cursor.proton[address].ceiling_uid       — max UID at backfill start (never changes)
//   cursor.proton[address].lowest_processed_uid — low-water mark as walk proceeds down
//
// Legacy flat key `proton.<address>.last_uid` is migrated in-place: the old
// value is deleted and a fresh new-style cursor is started from ceiling_uid =
// max(allUids). Previously-ingested messages will be re-fetched but the UNIQUE
// constraint in the store prevents duplicates.
// ---------------------------------------------------------------------------

const CURSOR_DIR = path.join(DATA_DIR, 'inbox');
const CURSOR_FILE = path.join(CURSOR_DIR, 'backfill-cursor.json');

interface ProtonAddressCursor {
  ceiling_uid: number;
  lowest_processed_uid: number;
}

// The on-disk cursor file can contain arbitrary keys (gmail, legacy proton.*,
// and the new nested proton object). We type the parts we care about.
interface CursorFile {
  proton?: Record<string, ProtonAddressCursor>;
  gmail?: Record<string, unknown>;
  [key: string]: unknown;
}

function readCursorFile(): CursorFile {
  try {
    return JSON.parse(fs.readFileSync(CURSOR_FILE, 'utf-8')) as CursorFile;
  } catch {
    return {};
  }
}

function writeCursorFile(data: CursorFile): void {
  fs.mkdirSync(CURSOR_DIR, { recursive: true });
  fs.writeFileSync(CURSOR_FILE, JSON.stringify(data, null, 2));
}

/**
 * Migrate legacy flat key `proton.<address>.last_uid` from the cursor file.
 * Returns true if migration happened (caller should persist the mutated file).
 */
function migrateLegacyCursor(
  cursorFile: CursorFile,
  address: string,
): boolean {
  const legacyKey = `proton.${address}.last_uid`;
  if (Object.prototype.hasOwnProperty.call(cursorFile, legacyKey)) {
    log(
      `${address}: migrating legacy cursor key "${legacyKey}" — will re-snapshot ceiling from live IMAP`,
    );
    delete (cursorFile as Record<string, unknown>)[legacyKey];
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Planning helper (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Given a descending-sorted list of all UIDs in the mailbox, a cursor (if any),
 * the batch size, and a floor UID, returns the slice of UIDs to process in this
 * run.
 *
 * Resume semantics:
 *   - If no cursor exists: start from the top (ceiling = max UID).
 *   - If cursor exists: start from lowest_processed_uid - 1 (walk down).
 *   - Stop when UID < floorUid.
 */
export function planNewestFirstBatches(
  allUidsDescending: number[],
  cursor: ProtonAddressCursor | undefined,
  batchSize: number,
  floorUid: number,
): { batches: number[][]; startUid: number; ceiling: number } {
  if (!allUidsDescending.length) {
    return { batches: [], startUid: 0, ceiling: 0 };
  }

  const ceiling = cursor?.ceiling_uid ?? allUidsDescending[0];
  const startBelow = cursor?.lowest_processed_uid ?? ceiling + 1;

  // Filter: UIDs that are within range and above floor
  const remaining = allUidsDescending.filter(
    (uid) => uid < startBelow && uid >= floorUid,
  );

  const batches: number[][] = [];
  for (let i = 0; i < remaining.length; i += batchSize) {
    batches.push(remaining.slice(i, i + batchSize));
  }

  return {
    batches,
    startUid: remaining[0] ?? 0,
    ceiling,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function die(msg: string): never {
  backfillLog.fatal(msg);
  process.exit(1);
}

function log(msg: string): void {
  backfillLog.info(msg);
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
  cursorFile: CursorFile,
): Promise<void> {
  // --- Cursor setup ---
  if (!cursorFile.proton) cursorFile.proton = {};

  // Migrate legacy flat key if present
  const migrated = migrateLegacyCursor(cursorFile, address);

  let addrCursor: ProtonAddressCursor | undefined = cursorFile.proton[address];

  // --from-scratch clears the cursor for this address
  if (args.fromScratch && addrCursor) {
    log(`${address}: --from-scratch — clearing cursor`);
    addrCursor = undefined;
    delete cursorFile.proton[address];
    if (!args.dryRun) writeCursorFile(cursorFile);
  } else if (migrated && !args.dryRun) {
    // Persist the deletion of the legacy key
    writeCursorFile(cursorFile);
  }

  log(
    `${address}: connecting to bridge${args.dryRun ? ' [dry-run]' : ''}`,
  );

  const session = await openProtonInbox(address, password, config);
  const { client } = session;

  try {
    {
      const allUids = (await client.search({ all: true })) as number[];
      if (!allUids || !allUids.length) {
        log(`${address}: mailbox empty`);
        return;
      }

      // Sort descending (newest first)
      const allUidsDesc = [...allUids].sort((a, b) => b - a);

      // If no cursor yet, snapshot the ceiling from the live mailbox
      if (!addrCursor) {
        const ceiling = allUidsDesc[0];
        addrCursor = {
          ceiling_uid: ceiling,
          lowest_processed_uid: ceiling + 1, // sentinel: nothing processed yet
        };
        log(`${address}: first run — ceiling_uid=${ceiling}`);
      }

      const { batches, startUid, ceiling } = planNewestFirstBatches(
        allUidsDesc,
        addrCursor,
        args.batchSize,
        args.floorUid,
      );

      const totalUids = batches.reduce((s, b) => s + b.length, 0);

      if (!totalUids) {
        log(
          `${address}: no messages remaining below UID ${addrCursor.lowest_processed_uid} (floor=${args.floorUid})`,
        );
        return;
      }

      log(
        `${address}: walking from UID ${startUid} down toward UID ${args.floorUid} (${totalUids} remaining, ceiling=${ceiling})`,
      );

      let batchIndex = 0;
      let totalInserted = 0;
      let totalSkipped = 0;
      let totalErrors = 0;

      for (const batch of batches) {
        batchIndex++;
        const batchHigh = batch[0];
        const batchLow = batch[batch.length - 1];

        log(
          `${address}: batch ${batchIndex} — UIDs ${batchHigh}–${batchLow} (${batch.length} msgs)`,
        );

        let batchInserted = 0;
        let batchSkipped = 0;
        let lowestInBatch = batchHigh;

        for (const uid of batch) {
          try {
            const msg = await client.fetchOne(uid, {
              envelope: true,
              source: true,
            });

            if (!msg || !('envelope' in msg)) {
              log(`${address}: UID ${uid}: no envelope, skipping`);
              totalErrors++;
              // Still account for this UID in lowest tracking
              lowestInBatch = Math.min(lowestInBatch, uid);
              continue;
            }

            const envelope = (msg as { envelope: any; source?: Buffer })
              .envelope;
            const from = envelope.from?.[0];
            if (!from) {
              log(`${address}: UID ${uid}: no from, skipping`);
              totalErrors++;
              lowestInBatch = Math.min(lowestInBatch, uid);
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
              lowestInBatch = Math.min(lowestInBatch, uid);
              continue;
            }

            const { plain, html } = extractProtonmailBody(fetchMsg.source);
            const body = pickBody(plain, html);

            if (!body) {
              log(`${address}: UID ${uid}: empty body, skipping`);
              totalErrors++;
              lowestInBatch = Math.min(lowestInBatch, uid);
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
              const result = ingestMessage({
                source: 'protonmail',
                account_email: address,
                source_message_id: messageId,
                thread_id: deriveProtonThreadId(
                  references,
                  inReplyTo,
                  messageId,
                ),
                sender_email: senderEmail,
                sender_name: senderName || null,
                subject,
                body_markdown: body,
                received_at: date,
              });

              if (result.inserted) {
                batchInserted++;
              } else {
                batchSkipped++;
              }
            } else {
              log(
                `${address}: UID ${uid} [dry-run]: from=${senderEmail} subject=${subject ?? '(no subject)'} body=${body.slice(0, 80).replace(/\n/g, ' ')}...`,
              );
              batchSkipped++;
            }

            lowestInBatch = Math.min(lowestInBatch, uid);
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

        // Update cursor: advance low-water mark downward
        addrCursor.lowest_processed_uid = Math.min(
          addrCursor.lowest_processed_uid,
          lowestInBatch,
        );
        cursorFile.proton![address] = addrCursor;

        if (!args.dryRun) {
          writeCursorFile(cursorFile);
        }

        // Stagger between batches
        if (batchIndex < batches.length) {
          await sleep(250);
        }
      }

      log(
        `${address}: complete — inserted=${totalInserted} skipped=${totalSkipped} errors=${totalErrors} lowest_uid=${addrCursor.lowest_processed_uid}`,
      );
    }
  } finally {
    await session.close();
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { config, password } = loadConfig();

  const addresses = args.address ? [args.address] : config.addresses;

  if (args.address && !config.addresses.includes(args.address)) {
    log(
      `Warning: --address ${args.address} not found in config.json addresses list`,
    );
  }

  const cursorFile = readCursorFile();

  for (let i = 0; i < addresses.length; i++) {
    const address = addresses[i];

    try {
      await backfillAddress(address, config, password, args, cursorFile);
    } catch (err) {
      log(`${address}: unrecoverable error — ${(err as Error).message}`);
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
  backfillLog.fatal({ err }, 'Backfill fatal');
  process.exit(1);
});
