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
import os from 'os';
import path from 'path';

import { google, gmail_v1 } from 'googleapis';

import { extractGmailBodyParts } from '../src/channels/gmail.js';
import { pickBody } from '../src/channels/email-body.js';
import { ingestGmail } from '../src/inbox-store/ingest.js';

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

const CURSOR_PATH = path.join(
  os.homedir(),
  'containers/data/NanoClaw/inbox/backfill-cursor.json',
);

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

  // --- OAuth init (mirrors GmailChannel.connect()) ---
  const credDir = path.join(os.homedir(), '.gmail-mcp');
  const keysPath = path.join(credDir, 'gcp-oauth.keys.json');
  const tokensPath = path.join(credDir, 'credentials.json');

  if (!fs.existsSync(keysPath) || !fs.existsSync(tokensPath)) {
    process.stderr.write(
      'ERROR: Gmail credentials not found in ~/.gmail-mcp/. Run /add-gmail to set up.\n',
    );
    process.exit(1);
  }

  const keys = JSON.parse(fs.readFileSync(keysPath, 'utf-8'));
  const tokens = JSON.parse(fs.readFileSync(tokensPath, 'utf-8'));

  const clientConfig = keys.installed || keys.web || keys;
  const { client_id, client_secret, redirect_uris } = clientConfig;
  const oauth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    redirect_uris?.[0],
  );
  oauth2Client.setCredentials(tokens);

  // Persist refreshed tokens
  oauth2Client.on('tokens', (newTokens) => {
    try {
      const current = JSON.parse(fs.readFileSync(tokensPath, 'utf-8'));
      Object.assign(current, newTokens);
      fs.writeFileSync(tokensPath, JSON.stringify(current, null, 2));
      process.stderr.write('Gmail OAuth tokens refreshed\n');
    } catch (err) {
      process.stderr.write(`WARN: Failed to persist refreshed tokens: ${err}\n`);
    }
  });

  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

  // Verify connection + get account email
  const profile = await gmail.users.getProfile({ userId: 'me' });
  const accountEmail = profile.data.emailAddress || '';
  process.stderr.write(`Connected as: ${accountEmail}\n`);

  // --- Cursor setup ---
  const cursor = readCursor();
  if (!cursor.gmail[accountEmail]) {
    cursor.gmail[accountEmail] = {};
  }
  const acctCursor = cursor.gmail[accountEmail];

  let startPageToken: string | undefined;
  if (!args.fromScratch && acctCursor.next_page_token) {
    startPageToken = acctCursor.next_page_token;
    process.stderr.write(`Resuming from cursor page token: ${startPageToken}\n`);
  } else {
    if (args.fromScratch) {
      acctCursor.next_page_token = undefined;
      acctCursor.last_processed_id = undefined;
      process.stderr.write('--from-scratch: ignoring cursor\n');
    }
    process.stderr.write(`Backfill since: ${args.since}\n`);
  }

  // Convert YYYY-MM-DD → YYYY/MM/DD for Gmail query
  const sinceQuery = args.since.replace(/-/g, '/');
  const q = `after:${sinceQuery}`;

  // --- Pagination loop ---
  let pageIndex = 0;
  let totalMessages = 0;
  let totalInserted = 0;
  let totalSkipped = 0;
  let totalErrors = 0;
  let pageToken: string | undefined = startPageToken;

  outer: do {
    process.stderr.write(`\n[Page ${pageIndex + 1}] Fetching message list...\n`);

    const listRes = await gmail.users.messages.list({
      userId: 'me',
      q,
      maxResults: 100,
      ...(pageToken ? { pageToken } : {}),
    });

    const stubs = listRes.data.messages || [];
    const nextPageToken = listRes.data.nextPageToken || undefined;

    process.stderr.write(`  Found ${stubs.length} messages on this page\n`);

    for (const stub of stubs) {
      if (!stub.id) continue;

      // Check max-messages limit
      if (args.maxMessages > 0 && totalMessages >= args.maxMessages) {
        process.stderr.write(`  --max-messages ${args.maxMessages} reached, stopping\n`);
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
          process.stderr.write(
            `  SKIP [${stub.id}] no extractable body (subject: ${subject || '(none)'})\n`,
          );
          totalSkipped++;
        } else if (args.dryRun) {
          process.stderr.write(
            `  DRY-RUN [${stub.id}] from=${senderEmail} subject=${subject || '(none)'} len=${body.length}\n`,
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

          if (result.inserted) {
            totalInserted++;
          } else {
            totalSkipped++;
          }
        }

        // Update last_processed_id after each message
        if (!args.dryRun) {
          acctCursor.last_processed_id = stub.id;
          writeCursor(cursor);
        }
      } catch (err) {
        totalErrors++;
        process.stderr.write(`  ERROR [${stub.id}]: ${err}\n`);
        // log-and-skip, continue
      }

      // Rate limit: 200ms between messages
      await sleep(200);
    }

    // Advance page token after full page is processed
    if (!args.dryRun) {
      acctCursor.next_page_token = nextPageToken;
      writeCursor(cursor);
    }

    pageToken = nextPageToken;
    pageIndex++;

    if (pageToken) {
      process.stderr.write(`  Page complete. Sleeping 1s before next page...\n`);
      await sleep(1000);
    }
  } while (pageToken);

  process.stderr.write(`\n=== Backfill complete ===\n`);
  process.stderr.write(`  Pages processed : ${pageIndex}\n`);
  process.stderr.write(`  Messages fetched: ${totalMessages}\n`);
  process.stderr.write(`  Inserted        : ${totalInserted}\n`);
  process.stderr.write(`  Skipped/dup     : ${totalSkipped}\n`);
  process.stderr.write(`  Errors          : ${totalErrors}\n`);

  if (totalErrors > 0 && totalErrors === totalMessages) {
    // All messages errored — treat as unrecoverable
    process.exit(1);
  }

  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`FATAL: ${err}\n`);
  process.exit(1);
});
