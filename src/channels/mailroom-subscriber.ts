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

// Mailroom emits two file kinds:
//   inbox-urgent-*.json  → priority dispatch (immediate spawn)
//   inbox-routine-*.json → normal dispatch, picked up on the next poll
// inbox-new-*.json is a pre-split prefix still accepted so stragglers
// aren't quarantined; mailroom no longer emits that name.
const EVENT_FILE_SUFFIX = '.json';
const URGENT_PREFIX = 'inbox-urgent-';
const ROUTINE_PREFIX = 'inbox-routine-';
const LEGACY_NEW_PREFIX = 'inbox-new-';

function ipcDir(): string {
  return process.env.MAILROOM_IPC_OUT_DIR || DEFAULT_IPC_DIR;
}

// Common payload across the typed events. `applied` carries the
// rule-engine summary (which rules matched, what got labeled/archived,
// whether qcm fired) — useful for logs and the future explainer tool.
interface AppliedSummary {
  labels_added: string[];
  labels_removed: string[];
  archived: boolean;
  qcm_alert: boolean;
  matched_rule_indices: number[];
}

interface InboxClassifiedBase {
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
  applied?: AppliedSummary; // optional for legacy inbox:new compat
}

type InboxEventKind = 'urgent' | 'routine' | 'legacy';

interface ClassifiedEvent extends InboxClassifiedBase {
  event: 'inbox:urgent' | 'inbox:routine' | 'inbox:new';
}

function isClassifiedEvent(x: unknown): x is ClassifiedEvent {
  if (!x || typeof x !== 'object') return false;
  const e = x as Record<string, unknown>;
  if (
    e.event !== 'inbox:urgent' &&
    e.event !== 'inbox:routine' &&
    e.event !== 'inbox:new'
  ) {
    return false;
  }
  return (
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

function fileKind(name: string): InboxEventKind | null {
  if (!name.endsWith(EVENT_FILE_SUFFIX)) return null;
  if (name.startsWith(URGENT_PREFIX)) return 'urgent';
  if (name.startsWith(ROUTINE_PREFIX)) return 'routine';
  if (name.startsWith(LEGACY_NEW_PREFIX)) return 'legacy';
  return null;
}

class MailroomSubscriber implements Channel {
  name = 'mailroom-subscriber';
  private opts: ChannelOpts;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: ChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    const dir = ipcDir();
    if (!fs.existsSync(dir)) {
      // Don't return — mailroom may start later. pollOnce() tolerates a
      // missing dir and will pick up events as soon as it appears.
      logger.warn(
        { dir },
        'Mailroom ipc-out directory not found — polling anyway, will pick up when present',
      );
    } else {
      logger.info({ dir }, 'Mailroom subscriber watching');
    }
    this.schedulePoll();
  }

  async sendMessage(): Promise<void> {
    // Unreachable: ownsJid() returns false, so the router never picks this channel for outbound.
    throw new Error('mailroom-subscriber does not send messages');
  }

  isConnected(): boolean {
    return this.timer !== null && !this.stopped;
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
    for (const file of entries) {
      if (this.stopped) return;
      const kind = fileKind(file);
      if (!kind) continue;
      const filePath = path.join(dir, file);
      try {
        const raw = await fs.promises.readFile(filePath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (!isClassifiedEvent(parsed)) {
          throw new Error('event failed schema validation');
        }
        // Payload event field is the single source of truth; warn if the
        // filename prefix disagrees so we can notice producer bugs.
        const payloadKind = mapEventKind(parsed.event);
        if (payloadKind !== kind) {
          logger.warn(
            { file, payloadKind, fileKind: kind },
            'mailroom event filename prefix and payload event field disagree — using payload',
          );
        }
        this.dispatch(parsed, payloadKind);
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

  private dispatch(event: ClassifiedEvent, kind: InboxEventKind): void {
    const targetJid = findEmailTargetJid(this.opts.registeredGroups());
    if (!targetJid) {
      logger.debug(
        { messageId: event.message_id, kind },
        'No email target group registered — dropping mailroom event',
      );
      return;
    }

    const sourceLabel = event.source === 'gmail' ? 'Gmail' : 'Proton';
    const senderDisplay = event.sender.name
      ? `${event.sender.name} <${event.sender.email}>`
      : event.sender.email;
    const priorityTag = kind === 'urgent' ? 'URGENT ' : '';
    const headerLine = `[${priorityTag}${sourceLabel} email from ${senderDisplay}]`;
    const lines = [
      headerLine,
      `Subject: ${event.subject ?? '(no subject)'}`,
      `Preview: ${event.body_preview}`,
    ];
    // Surface what the rule engine did so Madison's prompt has the
    // context without re-running the engine on her side.
    if (event.applied) {
      const a = event.applied;
      const summary: string[] = [];
      if (a.labels_added.length > 0)
        summary.push(`labeled ${a.labels_added.join(', ')}`);
      if (a.labels_removed.length > 0)
        summary.push(`unlabeled ${a.labels_removed.join(', ')}`);
      if (a.archived) summary.push('archived');
      if (a.qcm_alert) summary.push('QCM alert recorded');
      if (summary.length > 0)
        lines.push(`Rules applied: ${summary.join('; ')}`);
    }
    lines.push('');
    lines.push(
      `Use mcp__inbox__search, mcp__inbox__thread, or mcp__inbox__recent to read more; mcp__inbox__apply_action / delete / send_reply / send_message to act.`,
    );
    const content = lines.join('\n');

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

    // Urgent events request an immediate container spawn; routine/legacy
    // rely on the main loop's polling cadence as an implicit batch window.
    if (kind === 'urgent' && this.opts.requestImmediateProcessing) {
      this.opts.requestImmediateProcessing(targetJid);
    }

    logger.info(
      {
        source: event.source,
        subject: event.subject,
        targetJid,
        kind,
      },
      'Mailroom event dispatched',
    );
  }
}

function mapEventKind(
  event: 'inbox:urgent' | 'inbox:routine' | 'inbox:new',
): InboxEventKind {
  if (event === 'inbox:urgent') return 'urgent';
  if (event === 'inbox:routine') return 'routine';
  return 'legacy';
}

registerChannel(
  'mailroom-subscriber',
  (opts: ChannelOpts) => new MailroomSubscriber(opts),
);
