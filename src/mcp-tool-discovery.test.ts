import { describe, it, expect, beforeEach } from 'vitest';

import {
  _initTestDatabase,
  clearSession,
  getSessionInfo,
  setSession,
  setSessionToolHash,
} from './db.js';
import {
  computeGroupMcpHash,
  groupMcpOptionsFromConfig,
  type GroupMcpOptions,
} from './mcp-tool-discovery.js';

// --------------------------------------------------------------------------
// Hash stability and change-detection tests (AC-T1, AC-T2)
// --------------------------------------------------------------------------

describe('computeGroupMcpHash', () => {
  it('returns a non-empty hex SHA-256 string', () => {
    const opts: GroupMcpOptions = {
      groupFolder: 'test_group',
      hasAmem: false,
      hasContextMode: false,
    };
    const { hash } = computeGroupMcpHash(opts);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable across repeated calls with the same options', () => {
    const opts: GroupMcpOptions = {
      groupFolder: 'test_group',
      hasAmem: true,
      hasContextMode: false,
      trawl: {
        enabled: true,
        url: 'https://example.com/mcp',
        mode: 'wildcard',
      },
    };
    const { hash: h1 } = computeGroupMcpHash(opts);
    const { hash: h2 } = computeGroupMcpHash(opts);
    expect(h1).toBe(h2);
  });

  it('differs when a-mem is added', () => {
    const base: GroupMcpOptions = {
      groupFolder: 'g',
      hasAmem: false,
      hasContextMode: false,
    };
    const withAmem: GroupMcpOptions = { ...base, hasAmem: true };
    expect(computeGroupMcpHash(base).hash).not.toBe(
      computeGroupMcpHash(withAmem).hash,
    );
  });

  it('differs when context-mode is added', () => {
    const base: GroupMcpOptions = {
      groupFolder: 'g',
      hasAmem: false,
      hasContextMode: false,
    };
    const withCtx: GroupMcpOptions = { ...base, hasContextMode: true };
    expect(computeGroupMcpHash(base).hash).not.toBe(
      computeGroupMcpHash(withCtx).hash,
    );
  });

  it('differs when trawl is enabled vs disabled', () => {
    const base: GroupMcpOptions = {
      groupFolder: 'g',
      hasAmem: false,
      hasContextMode: false,
    };
    const withTrawl: GroupMcpOptions = { ...base, trawl: { enabled: true } };
    expect(computeGroupMcpHash(base).hash).not.toBe(
      computeGroupMcpHash(withTrawl).hash,
    );
  });

  it('includes inbox server only for telegram_inbox folder', () => {
    const inbox: GroupMcpOptions = {
      groupFolder: 'telegram_inbox',
      hasAmem: false,
      hasContextMode: false,
    };
    const other: GroupMcpOptions = { ...inbox, groupFolder: 'telegram_main' };
    expect(computeGroupMcpHash(inbox).serverNames).toContain('messages');
    expect(computeGroupMcpHash(other).serverNames).not.toContain('messages');
    expect(computeGroupMcpHash(inbox).hash).not.toBe(
      computeGroupMcpHash(other).hash,
    );
  });

  it('always includes nanoclaw in server names', () => {
    const opts: GroupMcpOptions = {
      groupFolder: 'g',
      hasAmem: false,
      hasContextMode: false,
    };
    expect(computeGroupMcpHash(opts).serverNames).toContain('nanoclaw');
  });

  it('server names are sorted', () => {
    const opts: GroupMcpOptions = {
      groupFolder: 'telegram_inbox',
      hasAmem: true,
      hasContextMode: true,
      trawl: { enabled: true },
    };
    const { serverNames } = computeGroupMcpHash(opts);
    expect(serverNames).toEqual([...serverNames].sort());
  });

  // Trawl config change-detection tests
  it('differs when Trawl URL changes (same enabled=true)', () => {
    const base: GroupMcpOptions = {
      groupFolder: 'g',
      hasAmem: false,
      hasContextMode: false,
      trawl: { enabled: true, url: 'https://old.example.com/mcp' },
    };
    const updated: GroupMcpOptions = {
      ...base,
      trawl: { enabled: true, url: 'https://new.example.com/mcp' },
    };
    expect(computeGroupMcpHash(base).hash).not.toBe(
      computeGroupMcpHash(updated).hash,
    );
  });

  it('differs when Trawl mode changes', () => {
    const base: GroupMcpOptions = {
      groupFolder: 'g',
      hasAmem: false,
      hasContextMode: false,
      trawl: { enabled: true, mode: 'wildcard' },
    };
    const updated: GroupMcpOptions = {
      ...base,
      trawl: { enabled: true, mode: 'explicit' },
    };
    expect(computeGroupMcpHash(base).hash).not.toBe(
      computeGroupMcpHash(updated).hash,
    );
  });

  it('differs when Trawl allowedTools list changes', () => {
    const base: GroupMcpOptions = {
      groupFolder: 'g',
      hasAmem: false,
      hasContextMode: false,
      trawl: { enabled: true, mode: 'explicit', allowedTools: ['tool_a'] },
    };
    const updated: GroupMcpOptions = {
      ...base,
      trawl: {
        enabled: true,
        mode: 'explicit',
        allowedTools: ['tool_a', 'tool_b'],
      },
    };
    expect(computeGroupMcpHash(base).hash).not.toBe(
      computeGroupMcpHash(updated).hash,
    );
  });

  it('differs when Trawl excludedTools list changes', () => {
    const base: GroupMcpOptions = {
      groupFolder: 'g',
      hasAmem: false,
      hasContextMode: false,
      trawl: { enabled: true, mode: 'wildcard', excludedTools: [] },
    };
    const updated: GroupMcpOptions = {
      ...base,
      trawl: {
        enabled: true,
        mode: 'wildcard',
        excludedTools: ['save_result'],
      },
    };
    expect(computeGroupMcpHash(base).hash).not.toBe(
      computeGroupMcpHash(updated).hash,
    );
  });

  it('is stable when allowedTools order changes (sorted canonically)', () => {
    const a: GroupMcpOptions = {
      groupFolder: 'g',
      hasAmem: false,
      hasContextMode: false,
      trawl: {
        enabled: true,
        mode: 'explicit',
        allowedTools: ['tool_b', 'tool_a'],
      },
    };
    const b: GroupMcpOptions = {
      ...a,
      trawl: {
        enabled: true,
        mode: 'explicit',
        allowedTools: ['tool_a', 'tool_b'],
      },
    };
    expect(computeGroupMcpHash(a).hash).toBe(computeGroupMcpHash(b).hash);
  });

  it('Trawl config fields do not affect hash when trawl is disabled', () => {
    const disabled: GroupMcpOptions = {
      groupFolder: 'g',
      hasAmem: false,
      hasContextMode: false,
      trawl: {
        enabled: false,
        url: 'https://example.com/mcp',
        mode: 'wildcard',
      },
    };
    const noTrawl: GroupMcpOptions = {
      groupFolder: 'g',
      hasAmem: false,
      hasContextMode: false,
    };
    // disabled trawl should hash identically to no trawl
    expect(computeGroupMcpHash(disabled).hash).toBe(
      computeGroupMcpHash(noTrawl).hash,
    );
  });
});

// --------------------------------------------------------------------------
// groupMcpOptionsFromConfig tests
// --------------------------------------------------------------------------

describe('groupMcpOptionsFromConfig', () => {
  it('returns hasAmem=false and hasContextMode=false when no additionalMounts', () => {
    const opts = groupMcpOptionsFromConfig('g', {});
    expect(opts.hasAmem).toBe(false);
    expect(opts.hasContextMode).toBe(false);
  });

  it('detects a-mem from additionalMounts containerPath', () => {
    const opts = groupMcpOptionsFromConfig('g', {
      additionalMounts: [{ containerPath: '/workspace/extra/a-mem' }],
    });
    expect(opts.hasAmem).toBe(true);
  });

  it('detects context-mode from additionalMounts containerPath', () => {
    const opts = groupMcpOptionsFromConfig('g', {
      additionalMounts: [{ containerPath: '/workspace/extra/context-mode' }],
    });
    expect(opts.hasContextMode).toBe(true);
  });

  it('passes trawl config through', () => {
    const trawl = { enabled: true, url: 'https://example.com/mcp' };
    const opts = groupMcpOptionsFromConfig('g', { trawl });
    expect(opts.trawl).toEqual(trawl);
  });

  it('returns stable GroupMcpOptions for undefined containerConfig', () => {
    const opts = groupMcpOptionsFromConfig('some_group', undefined);
    expect(opts.hasAmem).toBe(false);
    expect(opts.hasContextMode).toBe(false);
    expect(opts.trawl).toBeUndefined();
  });
});

// --------------------------------------------------------------------------
// Session hash mismatch → clear (AC-T3)
// Simulate the index.ts runAgent() hash check logic using real DB helpers.
// --------------------------------------------------------------------------

describe('hash mismatch → session cleared', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('clears an existing session whose hash is null (pre-migration row)', () => {
    // Simulate a pre-migration session: has session_id but tool_list_hash is NULL.
    setSession('test_group', 'session-111');
    // Do NOT stamp a hash — row has null hash, as if it predates the migration.
    const { hash: currentHash } = computeGroupMcpHash({
      groupFolder: 'test_group',
      hasAmem: false,
      hasContextMode: false,
    });
    const storedHash = getSessionInfo('test_group')?.tool_list_hash ?? null;
    // New semantics: null on an existing session_id row → clear (pre-migration).
    let cleared = false;
    if (storedHash === null) {
      clearSession('test_group');
      cleared = true;
    } else if (storedHash !== currentHash) {
      clearSession('test_group');
      cleared = true;
    }
    expect(cleared).toBe(true);
    expect(getSessionInfo('test_group')).toBeUndefined();
  });

  it('clears session when stored hash differs from current hash', () => {
    setSession('test_group', 'session-222');
    // Stamp old hash (no a-mem)
    const { hash: oldHash } = computeGroupMcpHash({
      groupFolder: 'test_group',
      hasAmem: false,
      hasContextMode: false,
    });
    setSessionToolHash('test_group', oldHash);

    // New spawn has a-mem added
    const { hash: newHash } = computeGroupMcpHash({
      groupFolder: 'test_group',
      hasAmem: true,
      hasContextMode: false,
    });
    expect(oldHash).not.toBe(newHash);

    const storedHash = getSessionInfo('test_group')?.tool_list_hash ?? null;
    let cleared = false;
    if (storedHash !== null && storedHash !== newHash) {
      clearSession('test_group');
      cleared = true;
    }
    expect(cleared).toBe(true);
    expect(getSessionInfo('test_group')).toBeUndefined();
  });

  it('does NOT clear when stored hash matches current hash', () => {
    setSession('test_group', 'session-333');
    const opts: GroupMcpOptions = {
      groupFolder: 'test_group',
      hasAmem: false,
      hasContextMode: false,
    };
    const { hash } = computeGroupMcpHash(opts);
    setSessionToolHash('test_group', hash);

    const storedHash = getSessionInfo('test_group')?.tool_list_hash ?? null;
    let cleared = false;
    if (storedHash !== null && storedHash !== hash) {
      clearSession('test_group');
      cleared = true;
    }
    expect(cleared).toBe(false);
    expect(getSessionInfo('test_group')).toBeDefined();
  });
});
