import fs from 'fs';
import os from 'os';
import path from 'path';

import { logger } from '../logger.js';
import { Channel, NewMessage } from '../types.js';
import { findEmailTargetJid } from '../inbox-routing.js';
import { ChannelOpts, registerChannel } from './registry.js';

const DEFAULT_IPC_DIR = path.join(
  os.homedir(),
  'containers/data/mailroom/ipc-out',
);
const POLL_INTERVAL_MS = 1000;
const EVENT_FILE_PREFIX = 'inbox-new-';
const EVENT_FILE_SUFFIX = '.json';

function ipcDir(): string {
  return process.env.MAILROOM_IPC_OUT_DIR || DEFAULT_IPC_DIR;
}

// Shape emitted by mailroom/src/events/emit.ts — keep in sync.
interface InboxNewEvent {
  event: 'inbox:new';
  version: 1;
  source: 'gmail' | 'protonmail';
  account_id: string;
  message_id: string;
  source_message_id: string;
  thread_id: string;
  subject: string | null;
  sender: { email: string; name: string | null };
  received_at: string;
  body_preview: string;
}

function isInboxNewEvent(x: unknown): x is InboxNewEvent {
  if (!x || typeof x !== 'object') return false;
  const e = x as Record<string, unknown>;
  return (
    e.event === 'inbox:new' &&
    (e.source === 'gmail' || e.source === 'protonmail') &&
    typeof e.message_id === 'string' &&
    typeof e.source_message_id === 'string' &&
    typeof e.thread_id === 'string' &&
    typeof e.received_at === 'string' &&
    typeof e.body_preview === 'string' &&
    e.sender != null &&
    typeof (e.sender as { email?: unknown }).email === 'string'
  );
}

class MailroomSubscriber implements Channel {
  name = 'mailroom-subscriber';
  private opts: ChannelOpts;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;

  constructor(opts: ChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    const dir = ipcDir();
    if (!fs.existsSync(dir)) {
      logger.warn(
        { dir },
        'Mailroom ipc-out directory not found — subscriber inactive',
      );
      return;
    }
    this.started = true;
    logger.info({ dir }, 'Mailroom subscriber watching');
    this.schedulePoll();
  }

  async sendMessage(): Promise<void> {
    // Subscriber is read-only — routing happens via onMessage into another
    // channel's JID space. Router uses ownsJid() to pick the outbound
    // channel, so this should never be called.
    throw new Error('mailroom-subscriber does not send messages');
  }

  isConnected(): boolean {
    return this.started && !this.stopped;
  }

  ownsJid(): boolean {
    return false;
  }

  async disconnect(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedulePoll(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.pollOnce()
        .catch((err) => logger.error({ err }, 'Mailroom subscriber poll error'))
        .finally(() => this.schedulePoll());
    }, POLL_INTERVAL_MS);
  }

  private async pollOnce(): Promise<void> {
    const dir = ipcDir();
    let entries: string[];
    try {
      entries = await fs.promises.readdir(dir);
    } catch {
      return;
    }
    const files = entries.filter(
      (f) => f.startsWith(EVENT_FILE_PREFIX) && f.endsWith(EVENT_FILE_SUFFIX),
    );
    for (const file of files) {
      if (this.stopped) return;
      const filePath = path.join(dir, file);
      try {
        const raw = await fs.promises.readFile(filePath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (!isInboxNewEvent(parsed)) {
          throw new Error('event failed schema validation');
        }
        this.dispatch(parsed);
        await fs.promises.unlink(filePath);
      } catch (err) {
        logger.error(
          { file, err },
          'Mailroom subscriber: event processing failed — moving to errors',
        );
        const errorsDir = path.join(dir, '..', 'ipc-errors');
        try {
          await fs.promises.mkdir(errorsDir, { recursive: true });
          await fs.promises.rename(filePath, path.join(errorsDir, file));
        } catch (renameErr) {
          logger.error(
            { file, err: renameErr },
            'Mailroom subscriber: failed to quarantine bad event',
          );
        }
      }
    }
  }

  private dispatch(event: InboxNewEvent): void {
    const targetJid = findEmailTargetJid(this.opts.registeredGroups());
    if (!targetJid) {
      logger.debug(
        { messageId: event.message_id },
        'No email target group registered — dropping mailroom event',
      );
      return;
    }

    const sourceLabel = event.source === 'gmail' ? 'Gmail' : 'Proton';
    const senderDisplay = event.sender.name
      ? `${event.sender.name} <${event.sender.email}>`
      : event.sender.email;
    const content = [
      `[${sourceLabel} email from ${senderDisplay}]`,
      `Subject: ${event.subject ?? '(no subject)'}`,
      `Preview: ${event.body_preview}`,
      '',
      `Use mcp__inbox__search, mcp__inbox__thread, or mcp__inbox__recent to read more.`,
    ].join('\n');

    const message: NewMessage = {
      id: event.source_message_id,
      chat_jid: targetJid,
      sender: event.sender.email,
      sender_name: event.sender.name ?? event.sender.email,
      content,
      timestamp: event.received_at,
      is_from_me: false,
      thread_id: event.thread_id,
    };
    this.opts.onMessage(targetJid, message);
    logger.info(
      {
        source: event.source,
        subject: event.subject,
        targetJid,
      },
      'Mailroom event dispatched',
    );
  }
}

registerChannel(
  'mailroom-subscriber',
  (opts: ChannelOpts) => new MailroomSubscriber(opts),
);
