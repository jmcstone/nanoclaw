import { describe, expect, test } from 'vitest';

import type { AgentMailAllowlist } from '../agentmail-allowlist.js';
import type { RegisteredGroup } from '../types.js';
import {
  buildInboundMessage,
  classifyAgentMailMessage,
  type InboundEventLike,
} from './agentmail.js';

const AVP_JID = 'telegram:avp';
const AVP_FOLDER = 'telegram_avp';
const AVP_INBOX = 'madison-avp@agentmail.to';
const ALLOWED_SENDER = 'alice@avp.com';

function groupsWithAvp(): Record<string, RegisteredGroup> {
  return {
    [AVP_JID]: {
      name: 'AVP',
      folder: AVP_FOLDER,
      trigger: 'Madison',
      added_at: '2026-05-03T00:00:00Z',
      requiresTrigger: false,
    },
  };
}

function makeInboxMap(): Map<string, string> {
  return new Map<string, string>([[AVP_INBOX.toLowerCase(), AVP_FOLDER]]);
}

function makeAllowlist(
  overrides: Partial<AgentMailAllowlist[string]> = {
    allowedSenders: [ALLOWED_SENDER],
  },
): AgentMailAllowlist {
  return { [AVP_FOLDER]: overrides };
}

function makeInboundFrame(overrides: Record<string, unknown> = {}): unknown {
  return {
    type: 'event',
    eventType: 'message.received',
    eventId: 'evt_123',
    message: {
      inboxId: AVP_INBOX,
      messageId: 'msg_1',
      threadId: 'thr_1',
      from: `Alice <${ALLOWED_SENDER}>`,
      subject: 'Hi',
      preview: 'preview text',
      timestamp: '2026-05-03T10:00:00Z',
      ...overrides,
    },
  };
}

describe('classifyAgentMailMessage', () => {
  test('subscribed frame returns subscribed kind', () => {
    const out = classifyAgentMailMessage({
      type: 'subscribed',
      inboxIds: [AVP_INBOX],
    });
    expect(out).toEqual({ kind: 'subscribed', inboxIds: [AVP_INBOX] });
  });

  test('inbound message.received frame returns inbound kind', () => {
    const out = classifyAgentMailMessage(makeInboundFrame());
    expect(out.kind).toBe('inbound');
    if (out.kind === 'inbound') {
      expect(out.event.message.inboxId).toBe(AVP_INBOX);
      expect(out.event.eventId).toBe('evt_123');
    }
  });

  test('non-inbound event types are ignored', () => {
    const out = classifyAgentMailMessage({
      type: 'event',
      eventType: 'message.delivered',
      eventId: 'evt_456',
      message: { inboxId: AVP_INBOX },
    });
    expect(out.kind).toBe('ignore');
  });

  test('malformed frame is ignored', () => {
    expect(classifyAgentMailMessage(null).kind).toBe('ignore');
    expect(classifyAgentMailMessage('hello').kind).toBe('ignore');
    expect(classifyAgentMailMessage({}).kind).toBe('ignore');
  });

  test('inbound frame without inboxId is ignored', () => {
    const out = classifyAgentMailMessage({
      type: 'event',
      eventType: 'message.received',
      eventId: 'evt_789',
      message: { messageId: 'm', threadId: 't', from: 'a@b.c' },
    });
    expect(out.kind).toBe('ignore');
  });
});

describe('buildInboundMessage', () => {
  test('routes inbound to the group whose folder owns the inbox', () => {
    const out = buildInboundMessage(
      classifyInbound(makeInboundFrame()),
      makeInboxMap(),
      groupsWithAvp(),
      makeAllowlist(),
    );
    expect(out.outcome).toBe('dispatch');
    if (out.outcome !== 'dispatch') return;
    expect(out.targetJid).toBe(AVP_JID);
    expect(out.folder).toBe(AVP_FOLDER);
    expect(out.message.thread_id).toBe('thr_1');
    expect(out.message.id).toBe('msg_1');
    expect(out.message.sender).toBe(ALLOWED_SENDER);
    expect(out.message.sender_name).toBe(`Alice <${ALLOWED_SENDER}>`);
    expect(out.message.content).toContain(`→ ${AVP_INBOX}`);
    expect(out.message.content).toContain('Subject: Hi');
    expect(out.message.content).toContain('Preview: preview text');
    expect(out.message.content).toContain('mcp__agentmail__');
  });

  test('inbox-id match is case-insensitive', () => {
    const event = classifyInbound(
      makeInboundFrame({ inboxId: AVP_INBOX.toUpperCase() }),
    );
    const out = buildInboundMessage(
      event,
      makeInboxMap(),
      groupsWithAvp(),
      makeAllowlist(),
    );
    expect(out.outcome).toBe('dispatch');
    if (out.outcome !== 'dispatch') return;
    expect(out.targetJid).toBe(AVP_JID);
  });

  test('returns unmapped-inbox when inbox not in folder map', () => {
    const event = classifyInbound(
      makeInboundFrame({ inboxId: 'unknown@agentmail.to' }),
    );
    const out = buildInboundMessage(
      event,
      makeInboxMap(),
      groupsWithAvp(),
      makeAllowlist(),
    );
    expect(out.outcome).toBe('unmapped-inbox');
  });

  test('returns unregistered-group when target group is not registered', () => {
    const event = classifyInbound(makeInboundFrame());
    const out = buildInboundMessage(event, makeInboxMap(), {}, makeAllowlist());
    expect(out.outcome).toBe('unregistered-group');
  });

  test('uses fallback subject when missing', () => {
    const event = classifyInbound(makeInboundFrame({ subject: undefined }));
    const out = buildInboundMessage(
      event,
      makeInboxMap(),
      groupsWithAvp(),
      makeAllowlist(),
    );
    expect(out.outcome).toBe('dispatch');
    if (out.outcome !== 'dispatch') return;
    expect(out.message.content).toContain('Subject: (no subject)');
  });

  test('omits Preview line when preview empty', () => {
    const event = classifyInbound(makeInboundFrame({ preview: '' }));
    const out = buildInboundMessage(
      event,
      makeInboxMap(),
      groupsWithAvp(),
      makeAllowlist(),
    );
    expect(out.outcome).toBe('dispatch');
    if (out.outcome !== 'dispatch') return;
    expect(out.message.content).not.toContain('Preview:');
  });

  test('handles bare email addresses (no display name)', () => {
    const event = classifyInbound(makeInboundFrame({ from: ALLOWED_SENDER }));
    const out = buildInboundMessage(
      event,
      makeInboxMap(),
      groupsWithAvp(),
      makeAllowlist(),
    );
    expect(out.outcome).toBe('dispatch');
    if (out.outcome !== 'dispatch') return;
    expect(out.message.sender).toBe(ALLOWED_SENDER);
    expect(out.message.sender_name).toBe(ALLOWED_SENDER);
  });

  test('denies sender when allowlist has no entry for folder', () => {
    const event = classifyInbound(makeInboundFrame());
    const out = buildInboundMessage(
      event,
      makeInboxMap(),
      groupsWithAvp(),
      {}, // empty allowlist
    );
    expect(out.outcome).toBe('denied-sender');
  });

  test('denies sender not on allowedSenders list', () => {
    const event = classifyInbound(
      makeInboundFrame({ from: 'attacker@evil.com' }),
    );
    const out = buildInboundMessage(
      event,
      makeInboxMap(),
      groupsWithAvp(),
      makeAllowlist({ allowedSenders: [ALLOWED_SENDER] }),
    );
    expect(out.outcome).toBe('denied-sender');
  });

  test('allows sender via domain match', () => {
    const event = classifyInbound(makeInboundFrame({ from: 'bob@avp.com' }));
    const out = buildInboundMessage(
      event,
      makeInboxMap(),
      groupsWithAvp(),
      makeAllowlist({ allowedDomains: ['avp.com'] }),
    );
    expect(out.outcome).toBe('dispatch');
  });

  test('allowAny: true bypasses sender matching', () => {
    const event = classifyInbound(
      makeInboundFrame({ from: 'anyone@anywhere.io' }),
    );
    const out = buildInboundMessage(
      event,
      makeInboxMap(),
      groupsWithAvp(),
      makeAllowlist({ allowAny: true }),
    );
    expect(out.outcome).toBe('dispatch');
  });
});

// Tiny helper so tests stay readable while still going through the same
// classify path the runtime uses.
function classifyInbound(frame: unknown): InboundEventLike {
  const out = classifyAgentMailMessage(frame);
  if (out.kind !== 'inbound') {
    throw new Error(`expected inbound, got ${out.kind}`);
  }
  return out.event;
}
