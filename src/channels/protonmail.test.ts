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

import { ProtonmailChannel, ProtonmailChannelOpts } from './protonmail.js';

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
