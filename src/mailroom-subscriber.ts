/**
 * Mailroom subscriber — host-side ingest of an external mailroom service.
 *
 * The mailroom service (a separate Docker stack at ~/containers/data/mailroom)
 * does Gmail + Protonmail ingestion and rule-engine classification, then writes
 * one JSON event file per classified message into its `ipc-out/` directory:
 *   inbox-urgent-*.json  → priority dispatch (wake the container immediately)
 *   inbox-routine-*.json → normal dispatch, picked up on the next host sweep
 *   inbox-new-*.json     → legacy prefix still accepted (treated as routine)
 *
 * This is NOT a channel adapter — it has no platform connection and never sends.
 * It's a host-side polling module (like host-sweep): it injects each event into
 * the email-triage agent group's session and wakes the container on urgent.
 *
 * Override the watched dir with MAILROOM_IPC_OUT_DIR (used for isolated tests so
 * we never consume the live mailroom's files).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { getAgentGroupByFolder } from './db/agent-groups.js';
import { log } from './log.js';
import { resolveSession, writeSessionMessage } from './session-manager.js';
import { wakeContainer } from './container-runner.js';

const DEFAULT_IPC_DIR = path.join(os.homedir(), 'containers/data/mailroom/ipc-out');
const POLL_INTERVAL_MS = 1000;

// The agent group folder that owns email triage. It has the `messages` MCP
// (mailroom inbox-mcp) mounted so the agent can read/act on the store.
const EMAIL_TARGET_FOLDER = 'telegram_inbox';

const EVENT_FILE_SUFFIX = '.json';
const URGENT_PREFIX = 'inbox-urgent-';
const ROUTINE_PREFIX = 'inbox-routine-';
const LEGACY_NEW_PREFIX = 'inbox-new-';

function ipcDir(): string {
  return process.env.MAILROOM_IPC_OUT_DIR || DEFAULT_IPC_DIR;
}

// Rule-engine summary attached to each event (what matched, what got labeled/
// archived, whether qcm fired) — surfaced in the prompt so the agent has the
// context without re-running the engine.
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
  if (e.event !== 'inbox:urgent' && e.event !== 'inbox:routine' && e.event !== 'inbox:new') {
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

function mapEventKind(event: ClassifiedEvent['event']): InboxEventKind {
  if (event === 'inbox:urgent') return 'urgent';
  if (event === 'inbox:routine') return 'routine';
  return 'legacy';
}

function buildContent(event: ClassifiedEvent, kind: InboxEventKind): string {
  const sourceLabel = event.source === 'gmail' ? 'Gmail' : 'Proton';
  const senderDisplay = event.sender.name ? `${event.sender.name} <${event.sender.email}>` : event.sender.email;
  const priorityTag = kind === 'urgent' ? 'URGENT ' : '';
  const lines = [
    `[${priorityTag}${sourceLabel} email from ${senderDisplay}]`,
    `Subject: ${event.subject ?? '(no subject)'}`,
    `Preview: ${event.body_preview}`,
  ];
  if (event.applied) {
    const a = event.applied;
    const summary: string[] = [];
    if (a.labels_added.length > 0) summary.push(`labeled ${a.labels_added.join(', ')}`);
    if (a.labels_removed.length > 0) summary.push(`unlabeled ${a.labels_removed.join(', ')}`);
    if (a.archived) summary.push('archived');
    if (a.qcm_alert) summary.push('QCM alert recorded');
    if (summary.length > 0) lines.push(`Rules applied: ${summary.join('; ')}`);
  }
  lines.push('');
  lines.push(
    `Use mcp__messages__search, mcp__messages__thread, or mcp__messages__recent to read more; mcp__messages__apply_action / delete / send_reply / send_message to act.`,
  );
  return JSON.stringify({
    text: lines.join('\n'),
    sender: senderDisplay,
    senderId: event.sender.email,
  });
}

function dispatch(event: ClassifiedEvent, kind: InboxEventKind): void {
  const agentGroup = getAgentGroupByFolder(EMAIL_TARGET_FOLDER);
  if (!agentGroup) {
    log.debug('No email-target agent group — dropping mailroom event', {
      folder: EMAIL_TARGET_FOLDER,
      messageId: event.message_id,
      kind,
    });
    return;
  }

  // agent-shared: one session per agent group, regardless of messaging group,
  // so mailroom events land in the same session as the Telegram conversation.
  const { session } = resolveSession(agentGroup.id, null, null, 'agent-shared');

  writeSessionMessage(agentGroup.id, session.id, {
    id: `mailroom:${event.source_message_id}`,
    kind: 'chat',
    timestamp: event.received_at,
    content: buildContent(event, kind),
    trigger: 1,
  });

  // Urgent → wake now; routine/legacy ride the 60s host sweep (trigger=1 row).
  if (kind === 'urgent') {
    void wakeContainer(session).then((woke) => {
      if (!woke) {
        log.warn('Mailroom urgent wake failed — host sweep will retry', {
          messageId: event.message_id,
        });
      }
    });
  }

  log.info('Mailroom event dispatched', {
    source: event.source,
    subject: event.subject,
    agentGroup: agentGroup.id,
    kind,
  });
}

let stopped = false;
let timer: ReturnType<typeof setTimeout> | null = null;

async function pollOnce(): Promise<void> {
  const dir = ipcDir();
  let entries: string[];
  try {
    entries = await fs.promises.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    return; // dir not present yet — mailroom may start later
  }
  for (const file of entries) {
    if (stopped) return;
    const kind = fileKind(file);
    if (!kind) continue;
    const filePath = path.join(dir, file);
    try {
      const raw = await fs.promises.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (!isClassifiedEvent(parsed)) throw new Error('event failed schema validation');
      const payloadKind = mapEventKind(parsed.event);
      if (payloadKind !== kind) {
        log.warn('mailroom event filename prefix and payload disagree — using payload', {
          file,
          payloadKind,
          fileKind: kind,
        });
      }
      dispatch(parsed, payloadKind);
      await fs.promises.unlink(filePath);
      // eslint-disable-next-line no-catch-all/no-catch-all -- fs/JSON/schema errors all handled the same: quarantine the file
    } catch (err) {
      log.error('Mailroom subscriber: event processing failed — moving to errors', { file, err });
      const errorsDir = path.join(dir, '..', 'ipc-errors');
      try {
        await fs.promises.mkdir(errorsDir, { recursive: true });
        await fs.promises.rename(filePath, path.join(errorsDir, file));
        // eslint-disable-next-line no-catch-all/no-catch-all -- mkdir+rename can throw diverse fs errors; log and continue
      } catch (renameErr) {
        log.error('Mailroom subscriber: failed to quarantine bad event', { file, err: renameErr });
      }
    }
  }
}

function schedulePoll(): void {
  if (stopped) return;
  timer = setTimeout(() => {
    pollOnce()
      .catch((err) => log.error('Mailroom subscriber poll error', { err }))
      .finally(() => schedulePoll());
  }, POLL_INTERVAL_MS);
}

export function startMailroomSubscriber(): void {
  stopped = false;
  const dir = ipcDir();
  if (fs.existsSync(dir)) {
    log.info('Mailroom subscriber watching', { dir });
  } else {
    log.warn('Mailroom ipc-out dir not found — polling anyway, will pick up when present', { dir });
  }
  schedulePoll();
}

export function stopMailroomSubscriber(): void {
  stopped = true;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
