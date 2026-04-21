import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./registry.js', () => ({
  registerChannel: vi.fn(),
}));

vi.mock('imapflow', () => ({
  ImapFlow: vi.fn(),
}));

vi.mock('nodemailer', () => ({
  default: { createTransport: vi.fn(() => ({ close: vi.fn() })) },
}));

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
}));

import {
  ProtonmailChannel,
  ProtonmailChannelOpts,
  extractProtonmailBody,
  parseReferencesHeader,
} from './protonmail.js';

function makeOpts(): ProtonmailChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({})),
  };
}

describe('ProtonmailChannel', () => {
  let channel: ProtonmailChannel;

  beforeEach(() => {
    channel = new ProtonmailChannel(makeOpts());
  });

  it('has the correct name', () => {
    expect(channel.name).toBe('protonmail');
  });

  it('ownsJid returns true for proton: JIDs', () => {
    expect(channel.ownsJid('proton:jeff@jstone.pro:123')).toBe(true);
    expect(channel.ownsJid('proton:foo:456')).toBe(true);
  });

  it('ownsJid returns false for non-proton JIDs', () => {
    expect(channel.ownsJid('gmail:abc123')).toBe(false);
    expect(channel.ownsJid('tg:12345')).toBe(false);
    expect(channel.ownsJid('protonmail:wrong')).toBe(false);
  });

  it('isConnected returns false before connect', () => {
    expect(channel.isConnected()).toBe(false);
  });

  it('disconnect sets connected to false', async () => {
    await channel.disconnect();
    expect(channel.isConnected()).toBe(false);
  });

  it('accepts custom poll interval', () => {
    const custom = new ProtonmailChannel(makeOpts(), 30000);
    expect(custom).toBeDefined();
  });

  it('registers itself with the channel registry', async () => {
    const { registerChannel } = await import('./registry.js');
    expect(registerChannel).toHaveBeenCalledWith(
      'protonmail',
      expect.any(Function),
    );
  });
});

describe('extractProtonmailBody', () => {
  it('extracts plain text from a simple text/plain email', () => {
    const raw = [
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: 7bit',
      '',
      'Hello, world!',
    ].join('\r\n');

    const { plain, html } = extractProtonmailBody(Buffer.from(raw));
    expect(plain).toBe('Hello, world!');
    expect(html).toBe('');
  });

  it('extracts both plain and html from a multipart/alternative email', () => {
    const boundary = 'test_boundary_123';
    const raw = [
      'MIME-Version: 1.0',
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      '',
      'Plain text body',
      `--${boundary}`,
      'Content-Type: text/html; charset=UTF-8',
      '',
      '<p>HTML body</p>',
      `--${boundary}--`,
    ].join('\r\n');

    const { plain, html } = extractProtonmailBody(Buffer.from(raw));
    expect(plain).toBe('Plain text body');
    expect(html).toContain('HTML body');
  });

  it('decodes quoted-printable soft line breaks', () => {
    const raw = [
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      'Hello=\r\nWorld',
    ].join('\r\n');

    const { plain } = extractProtonmailBody(Buffer.from(raw));
    // Soft line break =\r\n should be removed, joining the two words
    expect(plain).toBe('HelloWorld');
  });

  it('returns empty strings when no text parts present', () => {
    const raw = [
      'MIME-Version: 1.0',
      'Content-Type: application/octet-stream',
      '',
      'binary data',
    ].join('\r\n');

    const { plain, html } = extractProtonmailBody(Buffer.from(raw));
    expect(plain).toBe('');
    expect(html).toBe('');
  });
});

describe('parseReferencesHeader', () => {
  it('returns empty array when no References header', () => {
    const raw = Buffer.from('Subject: Test\r\n\r\nBody');
    expect(parseReferencesHeader(raw)).toEqual([]);
  });

  it('parses single message-id', () => {
    const raw = Buffer.from('References: <abc@example.com>\r\n\r\nBody');
    const refs = parseReferencesHeader(raw);
    expect(refs).toEqual(['<abc@example.com>']);
  });

  it('parses multiple message-ids', () => {
    const raw = Buffer.from(
      'References: <first@example.com> <second@example.com>\r\n\r\nBody',
    );
    const refs = parseReferencesHeader(raw);
    expect(refs).toEqual(['<first@example.com>', '<second@example.com>']);
  });
});
