import { describe, expect, it } from 'vitest';

import { isAgentMailSenderAllowed, type AgentMailAllowlist } from './agentmail-allowlist.js';

const allowlist: AgentMailAllowlist = {
  telegram_avp: {
    allowedSenders: ['Alice@AVP.com'],
    allowedDomains: ['Trusted.org'],
  },
  open_box: { allowAny: true },
  empty_box: {},
};

describe('isAgentMailSenderAllowed (deny-by-default)', () => {
  it('denies when the folder is absent from the allowlist', () => {
    expect(isAgentMailSenderAllowed('unknown', 'a@b.com', allowlist)).toBe(false);
  });

  it('denies when the folder is present but no rule matches', () => {
    expect(isAgentMailSenderAllowed('telegram_avp', 'stranger@elsewhere.com', allowlist)).toBe(false);
  });

  it('denies when the folder entry is empty (no rules)', () => {
    expect(isAgentMailSenderAllowed('empty_box', 'a@b.com', allowlist)).toBe(false);
  });

  it('allows any sender when allowAny is true', () => {
    expect(isAgentMailSenderAllowed('open_box', 'anyone@whatever.com', allowlist)).toBe(true);
  });

  it('allows an exact sender match, case-insensitively', () => {
    expect(isAgentMailSenderAllowed('telegram_avp', 'alice@avp.com', allowlist)).toBe(true);
    expect(isAgentMailSenderAllowed('telegram_avp', '  ALICE@AVP.COM ', allowlist)).toBe(true);
  });

  it('allows a domain match, case-insensitively', () => {
    expect(isAgentMailSenderAllowed('telegram_avp', 'bob@trusted.org', allowlist)).toBe(true);
    expect(isAgentMailSenderAllowed('telegram_avp', 'eve@TRUSTED.ORG', allowlist)).toBe(true);
  });

  it('denies a near-miss domain (no partial/subdomain match)', () => {
    expect(isAgentMailSenderAllowed('telegram_avp', 'bob@evil-trusted.org', allowlist)).toBe(false);
    expect(isAgentMailSenderAllowed('telegram_avp', 'bob@sub.trusted.org', allowlist)).toBe(false);
  });

  it('denies an empty sender', () => {
    expect(isAgentMailSenderAllowed('open_box', '', allowlist)).toBe(true); // allowAny short-circuits
    expect(isAgentMailSenderAllowed('telegram_avp', '   ', allowlist)).toBe(false);
  });
});
