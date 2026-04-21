/**
 * inbox-backfill-gmail.ts
 *
 * One-shot CLI to backfill Gmail messages into the inbox-store.
 *
 * Usage:
 *   npx tsx scripts/inbox-backfill-gmail.ts [--since YYYY-MM-DD] [--from-scratch]
 *                                            [--dry-run] [--max-messages <n>]
 */

import fs from 'fs';
import path from 'path';

import {
  createGmailClient,
  extractGmailBodyParts,
  gmailCredPaths,
} from '../src/channels/gmail.js';
import { pickBody } from '../src/channels/email-body.js';
import { DATA_DIR } from '../src/config.js';
import { ingestGmail } from '../src/inbox-store/ingest.js';
import { logger } from '../src/logger.js';

const log = logger.child({ component: 'backfill-gmail' });

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

interface CliArgs {
  since: string; // YYYY-MM-DD
  fromScratch: boolean;
  dryRun: boolean;
  maxMessages: number; // 0 = unlimited
}

function parseArgs(argv: string[]): CliArgs {
  const twoYearsAgo = new Date();
  twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
  const defaultSince = twoYearsAgo.toISOString().slice(0, 10);

  let since = defaultSince;
  let fromScratch = false;
  let dryRun = false;
  let maxMessages = 0;

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--since':
        since = argv[++i];
        break;
      case '--from-scratch':
        fromScratch = true;
        break;
      case '--dry-run':
        dryRun = true;
        break;
      case '--max-messages':
        maxMessages = parseInt(argv[++i], 10);
        break;
    }
  }

  return { since, fromScratch, dryRun, maxMessages };
}

// ---------------------------------------------------------------------------
// Cursor persistence
// ---------------------------------------------------------------------------

const CURSOR_PATH = path.join(DATA_DIR, 'inbox', 'backfill-cursor.json');

interface Cursor {
  gmail: Record<
    string,
    { next_page_token?: string; last_processed_id?: string }
  >;
}

function readCursor(): Cursor {
  try {
    if (fs.existsSync(CURSOR_PATH)) {
      return JSON.parse(fs.readFileSync(CURSOR_PATH, 'utf-8'));
    }
  } catch {
    // ignore corrupt cursor
  }
  return { gmail: {} };
}

function writeCursor(cursor: Cursor): void {
  fs.mkdirSync(path.dirname(CURSOR_PATH), { recursive: true });
  fs.writeFileSync(CURSOR_PATH, JSON.stringify(cursor, null, 2));
}

// ---------------------------------------------------------------------------
// Sleep helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const { keysPath, tokensPath } = gmailCredPaths();
  if (!fs.existsSync(keysPath) || !fs.existsSync(tokensPath)) {
    log.error(
      'Gmail credentials not found in ~/.gmail-mcp/. Run /add-gmail to set up.',
    );
    process.exit(1);
  }

  const { gmail, accountEmail } = await createGmailClient();
  log.info({ accountEmail }, 'Connected');

  const cursor = readCursor();
  if (!cursor.gmail[accountEmail]) cursor.gmail[accountEmail] = {};
  const acctCursor = cursor.gmail[accountEmail];

  let startPageToken: string | undefined;
  if (!args.fromScratch && acctCursor.next_page_token) {
    startPageToken = acctCursor.next_page_token;
    log.info({ startPageToken }, 'Resuming from cursor');
  } else {
    if (args.fromScratch) {
      acctCursor.next_page_token = undefined;
      acctCursor.last_processed_id = undefined;
      log.info('--from-scratch: ignoring cursor');
    }
    log.info({ since: args.since }, 'Backfill window');
  }

  const sinceQuery = args.since.replace(/-/g, '/');
  const q = `after:${sinceQuery}`;

  let pageIndex = 0;
  let totalMessages = 0;
  let totalInserted = 0;
  let totalSkipped = 0;
  let totalErrors = 0;
  let pageToken: string | undefined = startPageToken;

  outer: do {
    log.info({ page: pageIndex + 1 }, 'Fetching message list');

    const listRes = await gmail.users.messages.list({
      userId: 'me',
      q,
      maxResults: 100,
      ...(pageToken ? { pageToken } : {}),
    });

    const stubs = listRes.data.messages || [];
    const nextPageToken = listRes.data.nextPageToken || undefined;

    log.info({ page: pageIndex + 1, count: stubs.length }, 'Page listed');

    for (const stub of stubs) {
      if (!stub.id) continue;

      if (args.maxMessages > 0 && totalMessages >= args.maxMessages) {
        log.info({ limit: args.maxMessages }, '--max-messages reached, stopping');
        break outer;
      }

      totalMessages++;

      try {
        const msg = await gmail.users.messages.get({
          userId: 'me',
          id: stub.id,
          format: 'full',
        });

        const headers = msg.data.payload?.headers || [];
        const getHeader = (name: string): string =>
          headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())
            ?.value || '';

        const from = getHeader('From');
        const subject = getHeader('Subject');
        const threadId = msg.data.threadId || stub.id;
        const timestamp = new Date(
          parseInt(msg.data.internalDate || '0', 10),
        ).toISOString();

        const senderMatch = from.match(/^(.+?)\s*<(.+?)>$/);
        const senderName = senderMatch
          ? senderMatch[1].replace(/"/g, '')
          : from;
        const senderEmail = senderMatch ? senderMatch[2] : from;

        const { plain, html } = extractGmailBodyParts(msg.data.payload);
        const body = pickBody(plain, html);

        if (!body) {
          log.debug({ id: stub.id, subject }, 'Skipped — no extractable body');
          totalSkipped++;
        } else if (args.dryRun) {
          log.debug(
            { id: stub.id, senderEmail, subject, len: body.length },
            'Dry-run',
          );
          totalSkipped++;
        } else {
          const result = ingestGmail({
            account_email: accountEmail,
            source_message_id: stub.id,
            thread_id: threadId,
            sender_email: senderEmail,
            sender_name: senderName || null,
            subject: subject || null,
            body_markdown: body,
            received_at: timestamp,
          });
          if (result.inserted) totalInserted++;
          else totalSkipped++;
        }

        if (!args.dryRun) acctCursor.last_processed_id = stub.id;
      } catch (err) {
        totalErrors++;
        log.warn({ id: stub.id, err }, 'Message fetch/ingest failed');
      }

      await sleep(200);
    }

    if (!args.dryRun) {
      acctCursor.next_page_token = nextPageToken;
      writeCursor(cursor);
    }

    pageToken = nextPageToken;
    pageIndex++;

    if (pageToken) await sleep(1000);
  } while (pageToken);

  log.info(
    {
      pages: pageIndex,
      totalMessages,
      totalInserted,
      totalSkipped,
      totalErrors,
    },
    'Backfill complete',
  );

  if (totalErrors > 0 && totalErrors === totalMessages) process.exit(1);
  process.exit(0);
}

main().catch((err) => {
  log.fatal({ err }, 'Backfill fatal');
  process.exit(1);
});
