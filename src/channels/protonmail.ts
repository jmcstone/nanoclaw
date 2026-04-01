import fs from 'fs';
import os from 'os';
import path from 'path';

import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';

import { MAX_EMAIL_PREVIEW_CHARS } from '../config.js';
import { logger } from '../logger.js';
import { readEnvFile } from '../env.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

interface ProtonmailConfig {
  addresses: string[];
  host: string;
  imapPort: number;
  smtpPort: number;
}

interface MessageMeta {
  sender: string;
  senderName: string;
  subject: string;
  messageId: string;
  recipientAddress: string;
}

export interface ProtonmailChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class ProtonmailChannel implements Channel {
  name = 'protonmail';

  private opts: ProtonmailChannelOpts;
  private config: ProtonmailConfig | null = null;
  private password = '';
  private pollIntervalMs: number;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private processedIds = new Set<string>();
  private messageMeta = new Map<string, MessageMeta>();
  private consecutiveErrors = 0;
  private connected = false;
  private smtpTransport: nodemailer.Transporter | null = null;

  constructor(opts: ProtonmailChannelOpts, pollIntervalMs = 120000) {
    this.opts = opts;
    this.pollIntervalMs = pollIntervalMs;
  }

  async connect(): Promise<void> {
    const configPath = path.join(
      os.homedir(),
      '.protonmail-bridge',
      'config.json',
    );

    if (!fs.existsSync(configPath)) {
      logger.warn(
        'Protonmail config not found at ~/.protonmail-bridge/config.json. Skipping.',
      );
      return;
    }

    const secrets = readEnvFile(['PROTONMAIL_BRIDGE_PASSWORD']);
    if (!secrets.PROTONMAIL_BRIDGE_PASSWORD) {
      logger.warn(
        'PROTONMAIL_BRIDGE_PASSWORD not found in .env. Skipping Protonmail channel.',
      );
      return;
    }

    this.config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    this.password = secrets.PROTONMAIL_BRIDGE_PASSWORD;

    if (!this.config!.addresses.length) {
      logger.warn('Protonmail config has no addresses. Skipping.');
      return;
    }

    // Create SMTP transport for sending replies
    this.smtpTransport = nodemailer.createTransport({
      host: this.config!.host,
      port: this.config!.smtpPort,
      secure: false,
      tls: { rejectUnauthorized: false },
      auth: {
        user: this.config!.addresses[0],
        pass: this.password,
      },
    });

    this.connected = true;
    logger.info(
      { addressCount: this.config!.addresses.length },
      'Protonmail channel connected',
    );

    // Initial poll then schedule recurring
    await this.pollAllAddresses();
    this.schedulePoll();
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.smtpTransport) {
      logger.warn('Protonmail SMTP not initialized');
      return;
    }

    const meta = this.messageMeta.get(jid);
    if (!meta) {
      logger.warn({ jid }, 'No message metadata for reply, cannot send');
      return;
    }

    const subject = meta.subject.startsWith('Re:')
      ? meta.subject
      : `Re: ${meta.subject}`;

    try {
      // Re-create transport with the correct sender address for auth
      const transport = nodemailer.createTransport({
        host: this.config!.host,
        port: this.config!.smtpPort,
        secure: false,
        tls: { rejectUnauthorized: false },
        auth: {
          user: meta.recipientAddress,
          pass: this.password,
        },
      });

      await transport.sendMail({
        from: meta.recipientAddress,
        to: meta.sender,
        subject,
        inReplyTo: meta.messageId,
        references: meta.messageId,
        text,
      });

      transport.close();
      logger.info(
        { to: meta.sender, from: meta.recipientAddress },
        'Protonmail reply sent',
      );
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Protonmail reply');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('proton:');
  }

  async disconnect(): Promise<void> {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.smtpTransport) {
      this.smtpTransport.close();
      this.smtpTransport = null;
    }
    this.connected = false;
    logger.info('Protonmail channel stopped');
  }

  // --- Private ---

  private schedulePoll(): void {
    const backoffMs =
      this.consecutiveErrors > 0
        ? Math.min(
            this.pollIntervalMs * Math.pow(2, this.consecutiveErrors),
            30 * 60 * 1000,
          )
        : this.pollIntervalMs;

    this.pollTimer = setTimeout(() => {
      this.pollAllAddresses()
        .catch((err) => logger.error({ err }, 'Protonmail poll error'))
        .finally(() => {
          if (this.connected) this.schedulePoll();
        });
    }, backoffMs);
  }

  private async pollAllAddresses(): Promise<void> {
    if (!this.config) return;

    try {
      for (const address of this.config.addresses) {
        await this.pollAddress(address);
        // Stagger between addresses to avoid hammering the bridge
        if (
          this.config.addresses.indexOf(address) <
          this.config.addresses.length - 1
        ) {
          await new Promise((r) => setTimeout(r, 2000));
        }
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
        'Protonmail poll failed',
      );
    }

    // Cap processed ID set to prevent unbounded growth
    if (this.processedIds.size > 5000) {
      const ids = [...this.processedIds];
      this.processedIds = new Set(ids.slice(ids.length - 2500));
    }
  }

  private async pollAddress(address: string): Promise<void> {
    const client = new ImapFlow({
      host: this.config!.host,
      port: this.config!.imapPort,
      secure: false,
      auth: { user: address, pass: this.password },
      tls: { rejectUnauthorized: false },
      logger: false,
    });

    try {
      await client.connect();
      const lock = await client.getMailboxLock('INBOX');

      try {
        const uids = await client.search({ seen: false });
        if (!uids || !uids.length) return;

        for (const uid of uids as number[]) {
          const dedupKey = `${address}:${uid}`;
          if (this.processedIds.has(dedupKey)) continue;
          this.processedIds.add(dedupKey);

          await this.processMessage(client, uid, address);
        }
      } finally {
        lock.release();
      }
    } catch (err) {
      logger.warn({ address, err }, 'Failed to poll Protonmail address');
      throw err;
    } finally {
      try {
        await client.logout();
      } catch {
        // Ignore logout errors
      }
    }
  }

  private async processMessage(
    client: ImapFlow,
    uid: number,
    recipientAddress: string,
  ): Promise<void> {
    const msg = await client.fetchOne(uid, {
      envelope: true,
      source: true,
    });

    if (!msg || !('envelope' in msg)) return;

    const envelope = (msg as { envelope: any; source?: Buffer }).envelope;
    const from = envelope.from?.[0];
    if (!from) return;

    const senderEmail = from.address || '';
    const senderName = from.name || senderEmail;
    const subject = envelope.subject || '(no subject)';
    const messageId = envelope.messageId || '';
    const date = envelope.date
      ? new Date(envelope.date).toISOString()
      : new Date().toISOString();

    // Extract text body from raw source
    const fetchMsg = msg as { source?: Buffer };
    const body = fetchMsg.source
      ? this.extractTextFromSource(fetchMsg.source)
      : '';

    if (!body) {
      logger.debug(
        { uid, subject, address: recipientAddress },
        'Skipping email with no text body',
      );
      return;
    }

    const chatJid = `proton:${recipientAddress}:${uid}`;

    // Cache metadata for replies
    this.messageMeta.set(chatJid, {
      sender: senderEmail,
      senderName,
      subject,
      messageId,
      recipientAddress,
    });

    // Store chat metadata
    this.opts.onChatMetadata(chatJid, date, subject, 'protonmail', false);

    // Find the main group
    const groups = this.opts.registeredGroups();
    const mainEntry = Object.entries(groups).find(([, g]) => g.isMain === true);

    if (!mainEntry) {
      logger.debug(
        { chatJid, subject },
        'No main group registered, skipping email',
      );
      return;
    }

    const mainJid = mainEntry[0];
    const preview =
      MAX_EMAIL_PREVIEW_CHARS > 0 && body.length > MAX_EMAIL_PREVIEW_CHARS
        ? body.slice(0, MAX_EMAIL_PREVIEW_CHARS) + '\u2026'
        : body;
    const content = [
      `[Email from ${senderName} <${senderEmail}> \u2192 ${recipientAddress}]`,
      `Subject: ${subject}`,
      `Preview: ${preview}`,
      '',
      `To read the full email, run: node /app/src/fetch-protonmail.js ${uid} ${recipientAddress}`,
    ].join('\n');

    this.opts.onMessage(mainJid, {
      id: `proton-${recipientAddress}-${uid}`,
      chat_jid: mainJid,
      sender: senderEmail,
      sender_name: senderName,
      content,
      timestamp: date,
      is_from_me: false,
    });

    // Mark as read
    try {
      await client.messageFlagsAdd(uid, ['\\Seen']);
    } catch (err) {
      logger.warn({ uid, err }, 'Failed to mark Protonmail message as read');
    }

    logger.info(
      { mainJid, from: senderName, subject, to: recipientAddress },
      'Protonmail email delivered to main group',
    );
  }

  private extractTextFromSource(source: Buffer): string {
    return this.extractTextFromPart(source.toString('utf-8'));
  }

  /**
   * Recursively extract text/plain content from a MIME part.
   * Handles nested multipart (e.g. multipart/mixed → multipart/related → text/plain).
   */
  private extractTextFromPart(raw: string): string {
    // Find the boundary between headers and body
    const headerEnd = raw.indexOf('\r\n\r\n');
    if (headerEnd === -1) return '';

    const headers = raw.slice(0, headerEnd).toLowerCase();
    const bodyRaw = raw.slice(headerEnd + 4);

    // Multipart: split on boundary and process each part
    const boundaryMatch = headers.match(/boundary="?([^"\r\n;]+)"?/);
    if (boundaryMatch) {
      const boundary = boundaryMatch[1];
      const parts = bodyRaw.split(`--${boundary}`);

      // First pass: look for direct text/plain parts
      for (const part of parts) {
        const partHeaderEnd = part.indexOf('\r\n\r\n');
        if (partHeaderEnd === -1) continue;

        const partHeaders = part.slice(0, partHeaderEnd).toLowerCase();
        if (!partHeaders.includes('text/plain')) continue;

        let partBody = part.slice(partHeaderEnd + 4).trim();

        // Remove trailing boundary markers
        const endBoundary = partBody.indexOf(`--${boundary}`);
        if (endBoundary !== -1) {
          partBody = partBody.slice(0, endBoundary).trim();
        }

        // Handle quoted-printable encoding
        if (partHeaders.includes('quoted-printable')) {
          partBody = this.decodeQuotedPrintable(partBody);
        }

        // Handle base64 encoding
        if (partHeaders.includes('base64')) {
          partBody = Buffer.from(
            partBody.replace(/\s/g, ''),
            'base64',
          ).toString('utf-8');
        }

        return partBody;
      }

      // Second pass: recurse into nested multipart parts
      for (const part of parts) {
        const partHeaderEnd = part.indexOf('\r\n\r\n');
        if (partHeaderEnd === -1) continue;

        const partHeaders = part.slice(0, partHeaderEnd).toLowerCase();
        if (!partHeaders.includes('multipart/')) continue;

        const result = this.extractTextFromPart(part.trim());
        if (result) return result;
      }

      return '';
    }

    // Non-multipart: return body directly
    let body = bodyRaw.trim();

    if (headers.includes('quoted-printable')) {
      body = this.decodeQuotedPrintable(body);
    }
    if (
      headers.includes('content-transfer-encoding: base64') ||
      headers.includes('content-transfer-encoding:base64')
    ) {
      body = Buffer.from(body.replace(/\s/g, ''), 'base64').toString('utf-8');
    }

    return body;
  }

  private decodeQuotedPrintable(text: string): string {
    return text
      .replace(/=\r?\n/g, '') // soft line breaks
      .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) =>
        String.fromCharCode(parseInt(hex, 16)),
      );
  }
}

registerChannel('protonmail', (opts: ChannelOpts) => {
  const configPath = path.join(
    os.homedir(),
    '.protonmail-bridge',
    'config.json',
  );
  const secrets = readEnvFile(['PROTONMAIL_BRIDGE_PASSWORD']);

  if (!fs.existsSync(configPath)) {
    logger.warn(
      'Protonmail: config not found at ~/.protonmail-bridge/config.json',
    );
    return null;
  }
  if (!secrets.PROTONMAIL_BRIDGE_PASSWORD) {
    logger.warn('Protonmail: PROTONMAIL_BRIDGE_PASSWORD not found in .env');
    return null;
  }

  return new ProtonmailChannel(opts);
});
