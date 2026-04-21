import fs from 'fs';
import os from 'os';
import path from 'path';

import { google, gmail_v1 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';

import { MAX_EMAIL_PREVIEW_CHARS } from '../config.js';
import { ingestGmail } from '../inbox-store/ingest.js';
import { logger } from '../logger.js';
import { pickBody } from './email-body.js';
import { findEmailTargetJid } from './email-routing.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

const GMAIL_CRED_DIR_NAME = '.gmail-mcp';
const GMAIL_KEYS_FILE = 'gcp-oauth.keys.json';
const GMAIL_TOKENS_FILE = 'credentials.json';

export function gmailCredPaths(): {
  credDir: string;
  keysPath: string;
  tokensPath: string;
} {
  const credDir = path.join(os.homedir(), GMAIL_CRED_DIR_NAME);
  return {
    credDir,
    keysPath: path.join(credDir, GMAIL_KEYS_FILE),
    tokensPath: path.join(credDir, GMAIL_TOKENS_FILE),
  };
}

/**
 * Initialize a Gmail API client from the credentials in ~/.gmail-mcp/.
 * Throws if the credential files are missing. Callers that want a
 * graceful skip (e.g. the polling channel) must check existence first.
 *
 * The returned `oauth2Client` has a `tokens` listener attached that
 * persists refreshed tokens back to disk.
 */
export async function createGmailClient(): Promise<{
  gmail: gmail_v1.Gmail;
  oauth2Client: OAuth2Client;
  accountEmail: string;
}> {
  const { keysPath, tokensPath } = gmailCredPaths();
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

  oauth2Client.on('tokens', (newTokens) => {
    try {
      const current = JSON.parse(fs.readFileSync(tokensPath, 'utf-8'));
      Object.assign(current, newTokens);
      fs.writeFileSync(tokensPath, JSON.stringify(current, null, 2));
      logger.debug('Gmail OAuth tokens refreshed');
    } catch (err) {
      logger.warn({ err }, 'Failed to persist refreshed Gmail tokens');
    }
  });

  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
  const profile = await gmail.users.getProfile({ userId: 'me' });
  const accountEmail = profile.data.emailAddress ?? '';

  return { gmail, oauth2Client, accountEmail };
}

export function extractGmailBodyParts(
  payload: gmail_v1.Schema$MessagePart | undefined,
): {
  plain: string;
  html: string;
} {
  const acc = { plain: '', html: '' };
  if (!payload) return acc;

  const walk = (part: gmail_v1.Schema$MessagePart): void => {
    if (part.body?.data) {
      const decoded = Buffer.from(part.body.data, 'base64').toString('utf-8');
      if (part.mimeType === 'text/plain' && !acc.plain) {
        acc.plain = decoded;
      } else if (part.mimeType === 'text/html' && !acc.html) {
        acc.html = decoded;
      }
    }
    if (part.parts) {
      for (const child of part.parts) walk(child);
    }
  };

  walk(payload);
  return acc;
}

export interface GmailChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

interface ThreadMeta {
  sender: string;
  senderName: string;
  subject: string;
  messageId: string; // RFC 2822 Message-ID for In-Reply-To
}

export class GmailChannel implements Channel {
  name = 'gmail';

  private oauth2Client: OAuth2Client | null = null;
  private gmail: gmail_v1.Gmail | null = null;
  private opts: GmailChannelOpts;
  private pollIntervalMs: number;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private processedIds = new Set<string>();
  private threadMeta = new Map<string, ThreadMeta>();
  private consecutiveErrors = 0;
  private userEmail = '';

  constructor(opts: GmailChannelOpts, pollIntervalMs = 60000) {
    this.opts = opts;
    this.pollIntervalMs = pollIntervalMs;
  }

  async connect(): Promise<void> {
    const { keysPath, tokensPath } = gmailCredPaths();
    if (!fs.existsSync(keysPath) || !fs.existsSync(tokensPath)) {
      logger.warn(
        'Gmail credentials not found in ~/.gmail-mcp/. Skipping Gmail channel. Run /add-gmail to set up.',
      );
      return;
    }

    const client = await createGmailClient();
    this.oauth2Client = client.oauth2Client;
    this.gmail = client.gmail;
    this.userEmail = client.accountEmail;
    logger.info({ email: this.userEmail }, 'Gmail channel connected');

    // Start polling with error backoff
    const schedulePoll = () => {
      const backoffMs =
        this.consecutiveErrors > 0
          ? Math.min(
              this.pollIntervalMs * Math.pow(2, this.consecutiveErrors),
              30 * 60 * 1000,
            )
          : this.pollIntervalMs;
      this.pollTimer = setTimeout(() => {
        this.pollForMessages()
          .catch((err) => logger.error({ err }, 'Gmail poll error'))
          .finally(() => {
            if (this.gmail) schedulePoll();
          });
      }, backoffMs);
    };

    // Initial poll
    await this.pollForMessages();
    schedulePoll();
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.gmail) {
      logger.warn('Gmail not initialized');
      return;
    }

    const threadId = jid.replace(/^gmail:/, '');
    const meta = this.threadMeta.get(threadId);

    if (!meta) {
      logger.warn({ jid }, 'No thread metadata for reply, cannot send');
      return;
    }

    const subject = meta.subject.startsWith('Re:')
      ? meta.subject
      : `Re: ${meta.subject}`;

    const headers = [
      `To: ${meta.sender}`,
      `From: ${this.userEmail}`,
      `Subject: ${subject}`,
      `In-Reply-To: ${meta.messageId}`,
      `References: ${meta.messageId}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      text,
    ].join('\r\n');

    const encodedMessage = Buffer.from(headers)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    try {
      await this.gmail.users.messages.send({
        userId: 'me',
        requestBody: {
          raw: encodedMessage,
          threadId,
        },
      });
      logger.info({ to: meta.sender, threadId }, 'Gmail reply sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Gmail reply');
    }
  }

  isConnected(): boolean {
    return this.gmail !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('gmail:');
  }

  async disconnect(): Promise<void> {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.gmail = null;
    this.oauth2Client = null;
    logger.info('Gmail channel stopped');
  }

  // --- Private ---

  private buildQuery(): string {
    return 'is:unread category:primary';
  }

  private async pollForMessages(): Promise<void> {
    if (!this.gmail) return;

    try {
      const query = this.buildQuery();
      const res = await this.gmail.users.messages.list({
        userId: 'me',
        q: query,
        maxResults: 10,
      });

      const messages = res.data.messages || [];

      for (const stub of messages) {
        if (!stub.id || this.processedIds.has(stub.id)) continue;
        this.processedIds.add(stub.id);

        await this.processMessage(stub.id);
      }

      // Cap processed ID set to prevent unbounded growth
      if (this.processedIds.size > 5000) {
        const ids = [...this.processedIds];
        this.processedIds = new Set(ids.slice(ids.length - 2500));
      }

      this.consecutiveErrors = 0;
    } catch (err) {
      this.consecutiveErrors++;
      const backoffMs = Math.min(
        this.pollIntervalMs * Math.pow(2, this.consecutiveErrors),
        30 * 60 * 1000,
      );
      logger.error(
        {
          err,
          consecutiveErrors: this.consecutiveErrors,
          nextPollMs: backoffMs,
        },
        'Gmail poll failed',
      );
    }
  }

  private async processMessage(messageId: string): Promise<void> {
    if (!this.gmail) return;

    const msg = await this.gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full',
    });

    const headers = msg.data.payload?.headers || [];
    const getHeader = (name: string) =>
      headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())
        ?.value || '';

    const from = getHeader('From');
    const subject = getHeader('Subject');
    const rfc2822MessageId = getHeader('Message-ID');
    const threadId = msg.data.threadId || messageId;
    const timestamp = new Date(
      parseInt(msg.data.internalDate || '0', 10),
    ).toISOString();

    // Extract sender name and email
    const senderMatch = from.match(/^(.+?)\s*<(.+?)>$/);
    const senderName = senderMatch ? senderMatch[1].replace(/"/g, '') : from;
    const senderEmail = senderMatch ? senderMatch[2] : from;

    // Skip emails from self (our own replies)
    if (senderEmail === this.userEmail) return;

    const { plain, html } = extractGmailBodyParts(msg.data.payload);
    const body = pickBody(plain, html);

    if (!body) {
      logger.debug(
        { messageId, subject },
        'Skipping email with no extractable body',
      );
      return;
    }

    try {
      ingestGmail({
        account_email: this.userEmail,
        source_message_id: messageId,
        thread_id: threadId,
        sender_email: senderEmail,
        sender_name: senderName || null,
        subject: subject || null,
        body_markdown: body,
        received_at: timestamp,
      });
    } catch (err) {
      logger.warn({ messageId, err }, 'Inbox-store ingest failed (non-fatal)');
    }

    const chatJid = `gmail:${threadId}`;

    // Cache thread metadata for replies
    this.threadMeta.set(threadId, {
      sender: senderEmail,
      senderName,
      subject,
      messageId: rfc2822MessageId,
    });

    // Store chat metadata for group discovery
    this.opts.onChatMetadata(chatJid, timestamp, subject, 'gmail', false);

    const targetJid = findEmailTargetJid(this.opts.registeredGroups());

    if (!targetJid) {
      logger.debug(
        { chatJid, subject },
        'No email target group registered, skipping email',
      );
      return;
    }

    const preview =
      MAX_EMAIL_PREVIEW_CHARS > 0 && body.length > MAX_EMAIL_PREVIEW_CHARS
        ? body.slice(0, MAX_EMAIL_PREVIEW_CHARS) + '…'
        : body;
    const content = [
      `[Email from ${senderName} <${senderEmail}>]`,
      `Subject: ${subject}`,
      `Preview: ${preview}`,
      '',
      `Use mcp__gmail__search_emails or mcp__gmail__read_email to read the full email.`,
    ].join('\n');

    this.opts.onMessage(targetJid, {
      id: messageId,
      chat_jid: targetJid,
      sender: senderEmail,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
    });

    // Mark as read
    try {
      await this.gmail.users.messages.modify({
        userId: 'me',
        id: messageId,
        requestBody: { removeLabelIds: ['UNREAD'] },
      });
    } catch (err) {
      logger.warn({ messageId, err }, 'Failed to mark email as read');
    }

    logger.info(
      { targetJid, from: senderName, subject },
      'Gmail email delivered',
    );
  }
}

registerChannel('gmail', (opts: ChannelOpts) => {
  const credDir = path.join(os.homedir(), '.gmail-mcp');
  if (
    !fs.existsSync(path.join(credDir, 'gcp-oauth.keys.json')) ||
    !fs.existsSync(path.join(credDir, 'credentials.json'))
  ) {
    logger.warn('Gmail: credentials not found in ~/.gmail-mcp/');
    return null;
  }
  return new GmailChannel(opts);
});
