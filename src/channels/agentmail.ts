import { AgentMailClient } from 'agentmail';

import {
  AgentMailAllowlist,
  isAgentMailSenderAllowed,
  loadAgentMailAllowlist,
} from '../agentmail-allowlist.js';
import {
  discoverAgentMailInboxes,
  resolveAgentMailApiKey,
} from '../config.js';
import { logger } from '../logger.js';
import { Channel, NewMessage, RegisteredGroup } from '../types.js';
import { ChannelOpts, registerChannel } from './registry.js';

// Inbound-only channel. AgentMail messages arrive over a single WebSocket
// (no public URL needed) and are dispatched to the group whose folder owns
// the inbox. Sending email is handled inside the agent container via the
// `agentmail-mcp` MCP server — never through this channel — so ownsJid()
// always returns false and sendMessage() throws (mirrors mailroom-subscriber).
//
// Multi-inbox-per-group is intentionally NOT supported here yet (YAGNI for
// the AVP pilot). When the 100-inbox marketing campaign use case lands, the
// folder→inbox map becomes folder→inbox[] and dispatch picks the matching
// entry. See lode/v2-migration-notes/agentmail.md for the v2 redesign.

type Socket = Awaited<
  ReturnType<InstanceType<typeof AgentMailClient>['websockets']['connect']>
>;
type SocketResponse = Parameters<Parameters<Socket['on']>[1] & object>[0];

class AgentMailChannel implements Channel {
  name = 'agentmail';
  private opts: ChannelOpts;
  private client: AgentMailClient | null = null;
  private socket: Socket | null = null;
  private connected = false;
  private stopped = false;
  // Map of inbox id (lowercased) → group folder. Populated at connect()
  // by reading AGENTMAIL_INBOX_<FOLDER> .env keys.
  private inboxToFolder = new Map<string, string>();
  // Per-folder sender allowlist. Loaded once at connect; restart the host
  // process to pick up edits to ~/.config/nanoclaw/agentmail-allowlist.json.
  private allowlist: AgentMailAllowlist = {};

  constructor(opts: ChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    const apiKey = resolveAgentMailApiKey();
    if (!apiKey) {
      logger.info('AgentMail channel: no AGENTMAIL_API_KEY set — disabled');
      return;
    }

    const folderToInbox = discoverAgentMailInboxes();
    const folders = Object.keys(folderToInbox);
    if (folders.length === 0) {
      logger.info(
        'AgentMail channel: no AGENTMAIL_INBOX_<FOLDER> entries in .env — disabled',
      );
      return;
    }

    this.inboxToFolder.clear();
    for (const [folder, inboxId] of Object.entries(folderToInbox)) {
      this.inboxToFolder.set(inboxId.toLowerCase(), folder);
    }
    const inboxIds = Object.values(folderToInbox);

    // Load allowlist and warn loudly when a configured inbox has no entry —
    // deny-by-default means a missing entry silently drops every email,
    // which is correct but easy to miss in production.
    this.allowlist = loadAgentMailAllowlist();
    for (const folder of folders) {
      const entry = this.allowlist[folder];
      if (!entry) {
        logger.warn(
          { folder, allowlistPath: '~/.config/nanoclaw/agentmail-allowlist.json' },
          'AgentMail: folder configured but missing from allowlist — ALL inbound mail will be dropped',
        );
      } else if (
        entry.allowAny !== true &&
        (entry.allowedSenders?.length ?? 0) === 0 &&
        (entry.allowedDomains?.length ?? 0) === 0
      ) {
        logger.warn(
          { folder },
          'AgentMail: allowlist entry is empty — no senders permitted',
        );
      }
    }

    this.client = new AgentMailClient({ apiKey });

    try {
      this.socket = await this.client.websockets.connect();
    } catch (err) {
      logger.error({ err }, 'AgentMail: WebSocket connect failed');
      return;
    }

    // Attach handlers BEFORE waitForOpen. Note: AgentMail's `socket.on()`
    // only assigns to a single eventHandlers slot per event; the underlying
    // listener is already attached by the SDK constructor. We follow the
    // SDK's docs pattern (https://docs.agentmail.to/websockets) — explicit
    // sendSubscribe AFTER waitForOpen, NOT inside an on('open') handler,
    // because on('open') doesn't fire reliably for the initial connect.
    this.socket.on('message', (msg: SocketResponse) => {
      this.handleSocketMessage(msg);
    });

    this.socket.on('close', (event) => {
      this.connected = false;
      logger.warn(
        { code: event?.code, reason: event?.reason },
        'AgentMail: WebSocket closed (SDK auto-reconnects)',
      );
    });

    this.socket.on('error', (err) => {
      logger.error({ err }, 'AgentMail: WebSocket error');
    });

    await this.socket.waitForOpen();
    // Initial subscribe (synchronous after open).
    this.socket.sendSubscribe({ type: 'subscribe', inboxIds });
    this.connected = true;
    logger.info(
      { inboxes: inboxIds, folders },
      'AgentMail channel connected and subscribed',
    );

    // Reconnect handler: SDK auto-reconnects on disconnect, but won't
    // re-subscribe — we have to. Install AFTER the initial subscribe so
    // the first connect doesn't double-send.
    this.socket.on('open', () => {
      logger.info(
        { inboxCount: inboxIds.length },
        'AgentMail: WebSocket reopened — re-subscribing',
      );
      try {
        this.socket?.sendSubscribe({ type: 'subscribe', inboxIds });
      } catch (err) {
        logger.error({ err }, 'AgentMail: re-subscribe failed');
      }
    });
  }

  async sendMessage(): Promise<void> {
    // Unreachable: ownsJid() returns false. Outbound email goes through the
    // in-container agentmail-mcp server, not this channel.
    throw new Error('agentmail channel does not send via host router');
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(): boolean {
    return false;
  }

  async disconnect(): Promise<void> {
    this.stopped = true;
    this.connected = false;
    try {
      this.socket?.close();
    } catch (err) {
      logger.debug({ err }, 'AgentMail: socket close error (ignored)');
    }
    this.socket = null;
    this.client = null;
  }

  private handleSocketMessage(msg: SocketResponse): void {
    if (this.stopped) return;
    const decision = classifyAgentMailMessage(msg);
    if (decision.kind === 'subscribed') {
      logger.info(
        { inboxIds: decision.inboxIds },
        'AgentMail: subscription confirmed',
      );
      return;
    }
    if (decision.kind === 'ignore') {
      logger.debug({ reason: decision.reason }, 'AgentMail: ignoring frame');
      return;
    }
    // decision.kind === 'inbound'
    const dispatched = buildInboundMessage(
      decision.event,
      this.inboxToFolder,
      this.opts.registeredGroups(),
      this.allowlist,
    );
    if (dispatched.outcome !== 'dispatch') {
      // Each non-dispatch outcome gets its own log so audit signals stay
      // distinguishable: drops from unauthorized senders are the security-
      // relevant ones; unmapped/unregistered are config bugs.
      const meta = {
        eventId: decision.event.eventId,
        inboxId: decision.event.message.inboxId,
        from: decision.event.message.from,
      };
      if (dispatched.outcome === 'denied-sender') {
        logger.info(
          { ...meta, folder: dispatched.folder },
          'AgentMail: dropping inbound — sender not on allowlist',
        );
      } else if (dispatched.outcome === 'unmapped-inbox') {
        logger.warn(meta, 'AgentMail: inbound for unmapped inbox — drop');
      } else {
        logger.debug(
          { ...meta, folder: dispatched.folder },
          'AgentMail: target group not registered — drop',
        );
      }
      return;
    }
    this.opts.onMessage(dispatched.targetJid, dispatched.message);
    if (this.opts.requestImmediateProcessing) {
      this.opts.requestImmediateProcessing(dispatched.targetJid);
    }
    logger.info(
      {
        eventId: decision.event.eventId,
        inboxId: decision.event.message.inboxId,
        folder: dispatched.folder,
        targetJid: dispatched.targetJid,
      },
      'AgentMail event dispatched',
    );
  }
}

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

/**
 * Decide what to do with a raw socket frame. Pure function — no side effects
 * — so the dispatch path is unit-testable without a live WebSocket.
 */
export function classifyAgentMailMessage(msg: unknown): ClassifyDecision {
  if (!msg || typeof msg !== 'object' || !('type' in msg)) {
    return { kind: 'ignore', reason: 'malformed frame' };
  }
  const m = msg as Record<string, unknown>;
  if (m.type === 'subscribed') {
    const ids = Array.isArray(m.inboxIds)
      ? (m.inboxIds as string[])
      : undefined;
    return { kind: 'subscribed', inboxIds: ids };
  }
  if (m.type !== 'event') {
    return { kind: 'ignore', reason: `non-event type: ${String(m.type)}` };
  }
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
        subject:
          typeof message.subject === 'string' ? message.subject : undefined,
        preview:
          typeof message.preview === 'string' ? message.preview : undefined,
        timestamp: String(message.timestamp ?? new Date().toISOString()),
      },
    },
  };
}

export type DispatchResult =
  | {
      outcome: 'dispatch';
      targetJid: string;
      folder: string;
      message: NewMessage;
    }
  | { outcome: 'unmapped-inbox' }
  | { outcome: 'unregistered-group'; folder: string }
  | { outcome: 'denied-sender'; folder: string };

/**
 * Translate a validated AgentMail inbound event into a routed NewMessage,
 * or a categorised drop outcome. Pure function — caller does the logging
 * and side effects.
 */
export function buildInboundMessage(
  event: InboundEventLike,
  inboxToFolder: Map<string, string>,
  groups: Record<string, RegisteredGroup>,
  allowlist: AgentMailAllowlist,
): DispatchResult {
  const folder = inboxToFolder.get(event.message.inboxId.toLowerCase());
  if (!folder) return { outcome: 'unmapped-inbox' };
  const target = findGroupByFolder(groups, folder);
  if (!target) return { outcome: 'unregistered-group', folder };

  const senderEmail = parseEmailAddress(event.message.from);
  if (!isAgentMailSenderAllowed(folder, senderEmail, allowlist)) {
    return { outcome: 'denied-sender', folder };
  }

  const senderDisplay = event.message.from;
  const subject = event.message.subject ?? '(no subject)';
  const preview = event.message.preview ?? '';

  const lines = [
    `[AgentMail email from ${senderDisplay} → ${event.message.inboxId}]`,
    `Subject: ${subject}`,
  ];
  if (preview) lines.push(`Preview: ${preview}`);
  lines.push(
    '',
    'Use mcp__agentmail__get_message / mcp__agentmail__list_messages to read more,',
    'mcp__agentmail__reply_to_message or mcp__agentmail__send_message to act.',
  );

  const message: NewMessage = {
    id: event.message.messageId,
    chat_jid: target.jid,
    sender: senderEmail,
    sender_name: senderDisplay,
    content: lines.join('\n'),
    timestamp: event.message.timestamp,
    is_from_me: false,
    thread_id: event.message.threadId,
  };
  return { outcome: 'dispatch', targetJid: target.jid, folder, message };
}

function findGroupByFolder(
  groups: Record<string, RegisteredGroup>,
  folder: string,
): { jid: string; folder: string } | null {
  for (const [jid, group] of Object.entries(groups)) {
    if (group.folder === folder) return { jid, folder };
  }
  return null;
}

// Strip an RFC 5322 display-name wrapper so downstream stores see a bare email.
// Falls back to the original string if no angle-bracket form is found.
function parseEmailAddress(raw: string): string {
  const match = raw.match(/<([^>]+)>/);
  if (match) return match[1].trim();
  return raw.trim();
}

registerChannel(
  'agentmail',
  (opts: ChannelOpts) => new AgentMailChannel(opts),
);

export { AgentMailChannel };
