/**
 * AgentMail subscriber — host-side ingest of inbound email from AgentMail.
 *
 * Mirrors the mailroom-subscriber: it is NOT a channel adapter. It opens a
 * single AgentMail WebSocket (no public URL needed), subscribes to the inboxes
 * declared via AGENTMAIL_INBOX_<FOLDER> in .env, and on each `message.received`
 * injects a summary into the owning agent group's session (agent-shared, so the
 * email lands in the same session as that group's Telegram conversation) and
 * wakes the container. Outbound email is handled inside the container by the
 * `agentmail` MCP server — never here.
 *
 * Sender filtering is deny-by-default via agentmail-allowlist.json. The
 * AGENTMAIL_API_KEY is read from .env (host-side, trusted); the in-container
 * MCP gets it via scoped per-server env.
 */
import { AgentMailClient } from 'agentmail';

import {
  AgentMailAllowlist,
  isAgentMailSenderAllowed,
  loadAgentMailAllowlist,
} from './agentmail-allowlist.js';
import { discoverAgentMailInboxes, resolveAgentMailApiKey } from './config.js';
import { getAgentGroupByFolder } from './db/agent-groups.js';
import { wakeContainer } from './container-runner.js';
import { log } from './log.js';
import { resolveSession, writeSessionMessage } from './session-manager.js';

type Socket = Awaited<ReturnType<InstanceType<typeof AgentMailClient>['websockets']['connect']>>;

let client: AgentMailClient | null = null;
let socket: Socket | null = null;
let stopped = false;
// inbox id (lowercased) → group folder
const inboxToFolder = new Map<string, string>();
let allowlist: AgentMailAllowlist = {};

// --- Pure helpers (exported for testing) ---

export interface InboundEventLike {
  eventId: string;
  message: {
    inboxId: string;
    messageId: string;
    threadId: string;
    from: string;
    subject?: string;
    preview?: string;
    timestamp: string;
  };
}

export type ClassifyDecision =
  | { kind: 'subscribed'; inboxIds: string[] | undefined }
  | { kind: 'ignore'; reason: string }
  | { kind: 'inbound'; event: InboundEventLike };

/** Decide what to do with a raw socket frame. Pure — no side effects. */
export function classifyAgentMailMessage(msg: unknown): ClassifyDecision {
  if (!msg || typeof msg !== 'object' || !('type' in msg)) {
    return { kind: 'ignore', reason: 'malformed frame' };
  }
  const m = msg as Record<string, unknown>;
  if (m.type === 'subscribed') {
    const ids = Array.isArray(m.inboxIds) ? (m.inboxIds as string[]) : undefined;
    return { kind: 'subscribed', inboxIds: ids };
  }
  if (m.type !== 'event') return { kind: 'ignore', reason: `non-event type: ${String(m.type)}` };
  if (m.eventType !== 'message.received') {
    return { kind: 'ignore', reason: `event type ${String(m.eventType)}` };
  }
  const message = m.message as Record<string, unknown> | undefined;
  if (!message || typeof message.inboxId !== 'string') {
    return { kind: 'ignore', reason: 'missing message.inboxId' };
  }
  return {
    kind: 'inbound',
    event: {
      eventId: String(m.eventId ?? ''),
      message: {
        inboxId: String(message.inboxId),
        messageId: String(message.messageId ?? ''),
        threadId: String(message.threadId ?? ''),
        from: String(message.from ?? ''),
        subject: typeof message.subject === 'string' ? message.subject : undefined,
        preview: typeof message.preview === 'string' ? message.preview : undefined,
        timestamp: String(message.timestamp ?? new Date().toISOString()),
      },
    },
  };
}

// Strip an RFC 5322 display-name wrapper so the store sees a bare email.
export function parseEmailAddress(raw: string): string {
  const match = raw.match(/<([^>]+)>/);
  return match ? match[1].trim() : raw.trim();
}

function buildContent(event: InboundEventLike): string {
  const senderDisplay = event.message.from;
  const senderEmail = parseEmailAddress(senderDisplay);
  const subject = event.message.subject ?? '(no subject)';
  const lines = [
    `[AgentMail email from ${senderDisplay} → ${event.message.inboxId}]`,
    `Subject: ${subject}`,
  ];
  if (event.message.preview) lines.push(`Preview: ${event.message.preview}`);
  lines.push(
    '',
    'Use mcp__agentmail__get_message / mcp__agentmail__list_messages to read more,',
    'mcp__agentmail__reply_to_message or mcp__agentmail__send_message to act.',
  );
  return JSON.stringify({ text: lines.join('\n'), sender: senderDisplay, senderId: senderEmail });
}

function dispatchInbound(event: InboundEventLike): void {
  const folder = inboxToFolder.get(event.message.inboxId.toLowerCase());
  if (!folder) {
    log.warn('AgentMail: inbound for unmapped inbox — drop', { inboxId: event.message.inboxId });
    return;
  }
  const agentGroup = getAgentGroupByFolder(folder);
  if (!agentGroup) {
    log.debug('AgentMail: target agent group not found — drop', { folder });
    return;
  }
  const senderEmail = parseEmailAddress(event.message.from);
  if (!isAgentMailSenderAllowed(folder, senderEmail, allowlist)) {
    log.info('AgentMail: dropping inbound — sender not on allowlist', { folder, from: senderEmail });
    return;
  }

  // agent-shared: one session per agent group, so AgentMail email lands in the
  // same session as the group's Telegram conversation (matches mailroom).
  const { session } = resolveSession(agentGroup.id, null, null, 'agent-shared');
  writeSessionMessage(agentGroup.id, session.id, {
    id: `agentmail:${event.message.messageId || event.eventId}`,
    kind: 'chat',
    timestamp: event.message.timestamp,
    threadId: event.message.threadId || null,
    content: buildContent(event),
    trigger: 1,
  });
  void wakeContainer(session).then((woke) => {
    if (!woke) log.warn('AgentMail wake failed — host sweep will retry', { folder });
  });
  log.info('AgentMail event dispatched', { folder, inboxId: event.message.inboxId, from: senderEmail });
}

function handleFrame(msg: unknown): void {
  if (stopped) return;
  const decision = classifyAgentMailMessage(msg);
  if (decision.kind === 'subscribed') {
    log.info('AgentMail: subscription confirmed', { inboxIds: decision.inboxIds });
    return;
  }
  if (decision.kind === 'ignore') {
    log.debug('AgentMail: ignoring frame', { reason: decision.reason });
    return;
  }
  dispatchInbound(decision.event);
}

export async function startAgentMailSubscriber(): Promise<void> {
  stopped = false;
  const apiKey = resolveAgentMailApiKey();
  if (!apiKey) {
    log.info('AgentMail subscriber: no AGENTMAIL_API_KEY — disabled');
    return;
  }
  const folderToInbox = discoverAgentMailInboxes();
  const folders = Object.keys(folderToInbox);
  if (folders.length === 0) {
    log.info('AgentMail subscriber: no AGENTMAIL_INBOX_<FOLDER> entries — disabled');
    return;
  }

  inboxToFolder.clear();
  for (const [folder, inboxId] of Object.entries(folderToInbox)) {
    inboxToFolder.set(inboxId.toLowerCase(), folder);
  }
  const inboxIds = Object.values(folderToInbox);

  // Deny-by-default: warn loudly when a configured inbox has no allowlist entry.
  allowlist = loadAgentMailAllowlist();
  for (const folder of folders) {
    if (!allowlist[folder]) {
      log.warn('AgentMail: folder configured but missing from allowlist — ALL inbound mail dropped', {
        folder,
      });
    }
  }

  client = new AgentMailClient({ apiKey });
  try {
    socket = await client.websockets.connect();
    // eslint-disable-next-line no-catch-all/no-catch-all -- AgentMail SDK throws diverse network/auth errors on connect
  } catch (err) {
    log.error('AgentMail: WebSocket connect failed — disabled (host restart to retry)', { err });
    return;
  }

  socket.on('message', (m: unknown) => handleFrame(m));
  socket.on('close', (event: { code?: number; reason?: string } | undefined) => {
    log.warn('AgentMail: WebSocket closed (SDK auto-reconnects)', { code: event?.code });
  });
  socket.on('error', (err: unknown) => log.error('AgentMail: WebSocket error', { err }));

  await socket.waitForOpen();
  socket.sendSubscribe({ type: 'subscribe', inboxIds });
  log.info('AgentMail subscriber connected and subscribed', { inboxes: inboxIds, folders });

  // SDK auto-reconnects but won't re-subscribe — install AFTER the first
  // subscribe so the initial connect doesn't double-send.
  socket.on('open', () => {
    log.info('AgentMail: WebSocket reopened — re-subscribing', { inboxCount: inboxIds.length });
    try {
      socket?.sendSubscribe({ type: 'subscribe', inboxIds });
      // eslint-disable-next-line no-catch-all/no-catch-all -- SDK throws diverse errors on sendSubscribe
    } catch (err) {
      log.error('AgentMail: re-subscribe failed', { err });
    }
  });
}

export function stopAgentMailSubscriber(): void {
  stopped = true;
  try {
    socket?.close();
    // eslint-disable-next-line no-catch-all/no-catch-all -- socket close can throw diverse errors; ignorable on shutdown
  } catch (err) {
    log.debug('AgentMail: socket close error (ignored)', { err });
  }
  socket = null;
  client = null;
}
