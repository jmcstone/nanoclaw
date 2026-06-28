import { describe, it, expect } from 'vitest';

import { classifyAgentMailMessage, parseEmailAddress } from './agentmail-subscriber.js';

describe('classifyAgentMailMessage', () => {
  it('classifies a subscribed frame', () => {
    expect(classifyAgentMailMessage({ type: 'subscribed', inboxIds: ['a@x'] })).toEqual({
      kind: 'subscribed',
      inboxIds: ['a@x'],
    });
  });

  it('ignores malformed / non-event frames', () => {
    expect(classifyAgentMailMessage(null).kind).toBe('ignore');
    expect(classifyAgentMailMessage({}).kind).toBe('ignore');
    expect(classifyAgentMailMessage({ type: 'event', eventType: 'message.opened' }).kind).toBe('ignore');
  });

  it('ignores message.received without message.inboxId', () => {
    expect(classifyAgentMailMessage({ type: 'event', eventType: 'message.received', message: {} }).kind).toBe('ignore');
  });

  it('classifies an inbound message.received', () => {
    const d = classifyAgentMailMessage({
      type: 'event',
      eventType: 'message.received',
      eventId: 'e1',
      message: { inboxId: 'I@x', messageId: 'm1', from: 'A <a@x>', subject: 'hi', preview: 'p' },
    });
    expect(d.kind).toBe('inbound');
    if (d.kind === 'inbound') {
      expect(d.event.message.inboxId).toBe('I@x');
      expect(d.event.message.from).toBe('A <a@x>');
    }
  });

  it('does NOT drop eventId=0 (uses ?? not ||)', () => {
    const d = classifyAgentMailMessage({
      type: 'event',
      eventType: 'message.received',
      eventId: 0,
      message: { inboxId: 'i' },
    });
    expect(d.kind).toBe('inbound');
    if (d.kind === 'inbound') expect(d.event.eventId).toBe('0');
  });
});

describe('parseEmailAddress', () => {
  it('extracts the bare email from a display-name wrapper', () => {
    expect(parseEmailAddress('Alice <alice@example.com>')).toBe('alice@example.com');
  });

  it('returns the LAST angle-bracket group when several are present', () => {
    expect(parseEmailAddress('<a@x> <b@y>')).toBe('b@y');
  });

  it('falls back to the trimmed raw when there are no brackets', () => {
    expect(parseEmailAddress('  bob@example.com  ')).toBe('bob@example.com');
  });
});
