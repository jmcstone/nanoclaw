import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock registry (registerChannel runs at import time)
vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));

import {
  GmailChannel,
  GmailChannelOpts,
  extractGmailBodyParts,
} from './gmail.js';

function makeOpts(overrides?: Partial<GmailChannelOpts>): GmailChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: () => ({}),
    ...overrides,
  };
}

describe('GmailChannel', () => {
  let channel: GmailChannel;

  beforeEach(() => {
    channel = new GmailChannel(makeOpts());
  });

  describe('ownsJid', () => {
    it('returns true for gmail: prefixed JIDs', () => {
      expect(channel.ownsJid('gmail:abc123')).toBe(true);
      expect(channel.ownsJid('gmail:thread-id-456')).toBe(true);
    });

    it('returns false for non-gmail JIDs', () => {
      expect(channel.ownsJid('12345@g.us')).toBe(false);
      expect(channel.ownsJid('tg:123')).toBe(false);
      expect(channel.ownsJid('dc:456')).toBe(false);
      expect(channel.ownsJid('user@s.whatsapp.net')).toBe(false);
    });
  });

  describe('name', () => {
    it('is gmail', () => {
      expect(channel.name).toBe('gmail');
    });
  });

  describe('isConnected', () => {
    it('returns false before connect', () => {
      expect(channel.isConnected()).toBe(false);
    });
  });

  describe('disconnect', () => {
    it('sets connected to false', async () => {
      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });
  });

  describe('constructor options', () => {
    it('accepts custom poll interval', () => {
      const ch = new GmailChannel(makeOpts(), 30000);
      expect(ch.name).toBe('gmail');
    });

    it('defaults to unread query when no filter configured', () => {
      const ch = new GmailChannel(makeOpts());
      const query = (
        ch as unknown as { buildQuery: () => string }
      ).buildQuery();
      expect(query).toBe('is:unread category:primary');
    });

    it('defaults with no options provided', () => {
      const ch = new GmailChannel(makeOpts());
      expect(ch.name).toBe('gmail');
    });
  });
});

describe('extractGmailBodyParts', () => {
  function b64(s: string): string {
    return Buffer.from(s).toString('base64');
  }

  it('returns empty strings for undefined payload', () => {
    const result = extractGmailBodyParts(undefined);
    expect(result).toEqual({ plain: '', html: '' });
  });

  it('extracts plain text from a simple text/plain part', () => {
    const payload = {
      mimeType: 'text/plain',
      body: { data: b64('Hello world') },
    };
    const { plain, html } = extractGmailBodyParts(payload);
    expect(plain).toBe('Hello world');
    expect(html).toBe('');
  });

  it('extracts html from a text/html part', () => {
    const payload = {
      mimeType: 'text/html',
      body: { data: b64('<p>Hello</p>') },
    };
    const { plain, html } = extractGmailBodyParts(payload);
    expect(plain).toBe('');
    expect(html).toBe('<p>Hello</p>');
  });

  it('extracts both plain and html from a multipart/alternative payload', () => {
    const payload = {
      mimeType: 'multipart/alternative',
      body: {},
      parts: [
        { mimeType: 'text/plain', body: { data: b64('Plain text') } },
        { mimeType: 'text/html', body: { data: b64('<p>HTML text</p>') } },
      ],
    };
    const { plain, html } = extractGmailBodyParts(payload);
    expect(plain).toBe('Plain text');
    expect(html).toBe('<p>HTML text</p>');
  });

  it('takes only the first plain part (no accumulation)', () => {
    const payload = {
      mimeType: 'multipart/mixed',
      body: {},
      parts: [
        { mimeType: 'text/plain', body: { data: b64('First') } },
        { mimeType: 'text/plain', body: { data: b64('Second') } },
      ],
    };
    const { plain } = extractGmailBodyParts(payload);
    expect(plain).toBe('First');
  });
});
