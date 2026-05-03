import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  isAgentMailSenderAllowed,
  loadAgentMailAllowlist,
} from './agentmail-allowlist.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmail-allowlist-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeConfig(content: unknown): string {
  const filePath = path.join(tmpDir, 'agentmail-allowlist.json');
  fs.writeFileSync(filePath, JSON.stringify(content));
  return filePath;
}

describe('loadAgentMailAllowlist', () => {
  test('missing file returns empty allowlist (deny-all default)', () => {
    const out = loadAgentMailAllowlist(path.join(tmpDir, 'does-not-exist.json'));
    expect(out).toEqual({});
  });

  test('valid config parses correctly', () => {
    const filePath = writeConfig({
      telegram_avp: {
        allowedSenders: ['alice@avp.com'],
        allowedDomains: ['avp.com'],
      },
      telegram_other: { allowAny: true },
    });
    const out = loadAgentMailAllowlist(filePath);
    expect(out.telegram_avp?.allowedSenders).toEqual(['alice@avp.com']);
    expect(out.telegram_avp?.allowedDomains).toEqual(['avp.com']);
    expect(out.telegram_other?.allowAny).toBe(true);
  });

  test('invalid JSON returns empty allowlist', () => {
    const filePath = path.join(tmpDir, 'agentmail-allowlist.json');
    fs.writeFileSync(filePath, '{not json');
    expect(loadAgentMailAllowlist(filePath)).toEqual({});
  });

  test('invalid folder entries are skipped, valid ones survive', () => {
    const filePath = writeConfig({
      telegram_avp: { allowedSenders: ['ok@example.com'] },
      telegram_bad: { allowedSenders: 'not an array' },
      telegram_also_bad: { allowAny: 'true' /* string not bool */ },
    });
    const out = loadAgentMailAllowlist(filePath);
    expect(out.telegram_avp?.allowedSenders).toEqual(['ok@example.com']);
    expect(out.telegram_bad).toBeUndefined();
    expect(out.telegram_also_bad).toBeUndefined();
  });

  test('non-object root returns empty', () => {
    const filePath = path.join(tmpDir, 'agentmail-allowlist.json');
    fs.writeFileSync(filePath, '[]');
    expect(loadAgentMailAllowlist(filePath)).toEqual({});
  });
});

describe('isAgentMailSenderAllowed', () => {
  test('denies when folder absent (deny-by-default)', () => {
    expect(
      isAgentMailSenderAllowed('telegram_avp', 'alice@avp.com', {}),
    ).toBe(false);
  });

  test('denies when entry has no rules and allowAny false', () => {
    expect(
      isAgentMailSenderAllowed('telegram_avp', 'alice@avp.com', {
        telegram_avp: {},
      }),
    ).toBe(false);
  });

  test('allowAny: true permits any sender', () => {
    expect(
      isAgentMailSenderAllowed('telegram_avp', 'rando@elsewhere.io', {
        telegram_avp: { allowAny: true },
      }),
    ).toBe(true);
  });

  test('exact sender match (case-insensitive)', () => {
    const cfg = {
      telegram_avp: { allowedSenders: ['Alice@AVP.com'] },
    };
    expect(
      isAgentMailSenderAllowed('telegram_avp', 'alice@avp.com', cfg),
    ).toBe(true);
    expect(
      isAgentMailSenderAllowed('telegram_avp', 'ALICE@AVP.COM', cfg),
    ).toBe(true);
  });

  test('domain match (case-insensitive)', () => {
    const cfg = {
      telegram_avp: { allowedDomains: ['AVP.com'] },
    };
    expect(
      isAgentMailSenderAllowed('telegram_avp', 'bob@avp.com', cfg),
    ).toBe(true);
    expect(
      isAgentMailSenderAllowed('telegram_avp', 'bob@AVP.COM', cfg),
    ).toBe(true);
    expect(
      isAgentMailSenderAllowed('telegram_avp', 'bob@other.com', cfg),
    ).toBe(false);
  });

  test('mixed: sender list AND domain list both consulted', () => {
    const cfg = {
      telegram_avp: {
        allowedSenders: ['external-vip@partner.io'],
        allowedDomains: ['avp.com'],
      },
    };
    expect(
      isAgentMailSenderAllowed('telegram_avp', 'team@avp.com', cfg),
    ).toBe(true);
    expect(
      isAgentMailSenderAllowed('telegram_avp', 'external-vip@partner.io', cfg),
    ).toBe(true);
    expect(
      isAgentMailSenderAllowed('telegram_avp', 'random@partner.io', cfg),
    ).toBe(false);
  });

  test('empty sender string is denied', () => {
    expect(
      isAgentMailSenderAllowed('telegram_avp', '', {
        telegram_avp: { allowedSenders: ['x@y.com'] },
      }),
    ).toBe(false);
  });

  test('malformed sender (no @) is denied even with domain rules', () => {
    expect(
      isAgentMailSenderAllowed('telegram_avp', 'no-at-sign', {
        telegram_avp: { allowedDomains: ['avp.com'] },
      }),
    ).toBe(false);
  });
});
