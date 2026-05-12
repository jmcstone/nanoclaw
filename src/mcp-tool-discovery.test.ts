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
  probeMcpVersions,
  _resetVersionProbeStateForTest,
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

  it('includes tasks server for tasks-eligible folders only', () => {
    const inbox: GroupMcpOptions = {
      groupFolder: 'telegram_inbox',
      hasAmem: false,
      hasContextMode: false,
    };
    const main: GroupMcpOptions = { ...inbox, groupFolder: 'telegram_main' };
    const other: GroupMcpOptions = { ...inbox, groupFolder: 'telegram_avp' };
    expect(computeGroupMcpHash(inbox).serverNames).toContain('tasks');
    expect(computeGroupMcpHash(main).serverNames).toContain('tasks');
    expect(computeGroupMcpHash(other).serverNames).not.toContain('tasks');
  });

  it('tasks version folds into the hash for tasks-eligible groups', () => {
    const main: GroupMcpOptions = {
      groupFolder: 'telegram_main',
      hasAmem: false,
      hasContextMode: false,
    };
    const noVer = computeGroupMcpHash(main);
    const withV1 = computeGroupMcpHash({
      ...main,
      serverVersions: { tasks: 'v1' },
    });
    const withV2 = computeGroupMcpHash({
      ...main,
      serverVersions: { tasks: 'v2' },
    });
    expect(noVer.hash).not.toBe(withV1.hash);
    expect(withV1.hash).not.toBe(withV2.hash);
  });

  it('tasks version on a non-eligible group does NOT affect the hash (inactive-key isolation)', () => {
    const other: GroupMcpOptions = {
      groupFolder: 'telegram_avp',
      hasAmem: false,
      hasContextMode: false,
    };
    const noVer = computeGroupMcpHash(other);
    const stray = computeGroupMcpHash({
      ...other,
      serverVersions: { tasks: 'should-be-ignored' },
    });
    expect(noVer.hash).toBe(stray.hash);
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

// --------------------------------------------------------------------------
// Per-server version folding into hash (boot-nonce restart detection)
// --------------------------------------------------------------------------

describe('serverVersions hash folding', () => {
  it('same versions → same hash', () => {
    const base: GroupMcpOptions = {
      groupFolder: 'g',
      hasAmem: false,
      hasContextMode: false,
      trawl: { enabled: true, url: 'https://t.example/mcp' },
      serverVersions: { trawl: 'nonce-A' },
    };
    expect(computeGroupMcpHash(base).hash).toBe(computeGroupMcpHash(base).hash);
  });

  it('changing trawl version bumps the hash (simulates trawl restart)', () => {
    const before: GroupMcpOptions = {
      groupFolder: 'g',
      hasAmem: false,
      hasContextMode: false,
      trawl: { enabled: true, url: 'https://t.example/mcp' },
      serverVersions: { trawl: 'nonce-A' },
    };
    const after: GroupMcpOptions = {
      ...before,
      serverVersions: { trawl: 'nonce-B' },
    };
    expect(computeGroupMcpHash(before).hash).not.toBe(
      computeGroupMcpHash(after).hash,
    );
  });

  it('changing messages version bumps the hash for telegram_inbox', () => {
    const before: GroupMcpOptions = {
      groupFolder: 'telegram_inbox',
      hasAmem: false,
      hasContextMode: false,
      serverVersions: { messages: 'nonce-A' },
    };
    const after: GroupMcpOptions = {
      ...before,
      serverVersions: { messages: 'nonce-B' },
    };
    expect(computeGroupMcpHash(before).hash).not.toBe(
      computeGroupMcpHash(after).hash,
    );
  });

  it('version for an inactive server is ignored (no spurious mismatch)', () => {
    // 'messages' is only active for telegram_inbox. Folding a stale messages
    // version into a non-inbox group must not change the hash.
    const noVersions: GroupMcpOptions = {
      groupFolder: 'g',
      hasAmem: false,
      hasContextMode: false,
    };
    const withInactive: GroupMcpOptions = {
      ...noVersions,
      serverVersions: { messages: 'nonce-X' },
    };
    expect(computeGroupMcpHash(noVersions).hash).toBe(
      computeGroupMcpHash(withInactive).hash,
    );
  });

  it('absent serverVersions matches legacy (no-version) hash', () => {
    const legacy: GroupMcpOptions = {
      groupFolder: 'telegram_inbox',
      hasAmem: false,
      hasContextMode: false,
      trawl: { enabled: true, url: 'https://t.example/mcp' },
    };
    const explicitlyEmpty: GroupMcpOptions = {
      ...legacy,
      serverVersions: {},
    };
    expect(computeGroupMcpHash(legacy).hash).toBe(
      computeGroupMcpHash(explicitlyEmpty).hash,
    );
  });
});

// --------------------------------------------------------------------------
// probeMcpVersions — caching + last-good fallback on probe failure
// --------------------------------------------------------------------------

describe('probeMcpVersions', () => {
  beforeEach(() => {
    _resetVersionProbeStateForTest();
  });

  it('returns versions for enabled MCPs (trawl + messages + tasks on telegram_inbox)', async () => {
    const calls: string[] = [];
    const versions = await probeMcpVersions(
      {
        groupFolder: 'telegram_inbox',
        hasAmem: false,
        hasContextMode: false,
        trawl: { enabled: true, url: 'https://t.example/mcp' },
      },
      async (url) => {
        calls.push(url);
        if (url.includes('t.example')) return 'trawl-v1';
        if (url.includes(':18080')) return 'inbox-v1';
        if (url.includes(':18088')) return 'tasks-v1';
        return null;
      },
    );
    expect(versions).toEqual({
      trawl: 'trawl-v1',
      messages: 'inbox-v1',
      tasks: 'tasks-v1',
    });
    expect(calls).toHaveLength(3);
  });

  it('includes tasks server for telegram_main (eligible) without inbox', async () => {
    const calls: string[] = [];
    const versions = await probeMcpVersions(
      {
        groupFolder: 'telegram_main',
        hasAmem: false,
        hasContextMode: false,
      },
      async (url) => {
        calls.push(url);
        return url.includes(':18088') ? 'tasks-v1' : null;
      },
    );
    expect(versions).toEqual({ tasks: 'tasks-v1' });
    expect(calls).toHaveLength(1);
  });

  it('omits tasks server for groups not in the tasks-eligible set', async () => {
    const calls: string[] = [];
    const versions = await probeMcpVersions(
      {
        groupFolder: 'telegram_avp',
        hasAmem: false,
        hasContextMode: false,
      },
      async (url) => {
        calls.push(url);
        return 'whatever';
      },
    );
    expect(versions).toEqual({});
    expect(calls).toHaveLength(0);
  });

  it('omits trawl when disabled', async () => {
    const versions = await probeMcpVersions(
      {
        groupFolder: 'g',
        hasAmem: false,
        hasContextMode: false,
        trawl: { enabled: false },
      },
      async () => 'should-not-be-called',
    );
    expect(versions).toEqual({});
  });

  it('falls back to last-good on probe failure (no session churn)', async () => {
    // Use URL variation to dodge the per-URL cache while keeping the same
    // group + server name (which is what last-good is keyed on).
    const probe = async (url: string) =>
      url === 'https://up.example/mcp' ? 'nonce-A' : null;

    // 1. Probe URL_A succeeds → primes last-good[g][trawl] = 'nonce-A'.
    const v1 = await probeMcpVersions(
      {
        groupFolder: 'g',
        hasAmem: false,
        hasContextMode: false,
        trawl: { enabled: true, url: 'https://up.example/mcp' },
      },
      probe,
    );
    expect(v1).toEqual({ trawl: 'nonce-A' });

    // 2. Same group, different URL (so URL cache misses) that probe fails.
    //    Without last-good fallback, key would be absent → hash would change
    //    → spurious session churn. With fallback, we reuse 'nonce-A'.
    const v2 = await probeMcpVersions(
      {
        groupFolder: 'g',
        hasAmem: false,
        hasContextMode: false,
        trawl: { enabled: true, url: 'https://down.example/mcp' },
      },
      probe,
    );
    expect(v2).toEqual({ trawl: 'nonce-A' });
  });

  it('omits the key entirely when probe fails AND no last-good exists', async () => {
    const versions = await probeMcpVersions(
      {
        groupFolder: 'fresh_group',
        hasAmem: false,
        hasContextMode: false,
        trawl: { enabled: true, url: 'https://down.example/mcp' },
      },
      async () => null,
    );
    // No last-good → key absent. computeGroupMcpHash treats this as no
    // version contribution, so the hash falls back to the legacy name-only
    // shape — matching pre-rollout behavior, no false-positive churn.
    expect(versions).toEqual({});
  });

  it('caches per-URL within the TTL window (no re-probe)', async () => {
    let calls = 0;
    const probe = async () => {
      calls += 1;
      return `nonce-${calls}`;
    };
    const opts: GroupMcpOptions = {
      groupFolder: 'g',
      hasAmem: false,
      hasContextMode: false,
      trawl: { enabled: true, url: 'https://t.example/mcp' },
    };
    const v1 = await probeMcpVersions(opts, probe);
    const v2 = await probeMcpVersions(opts, probe);
    expect(v1).toEqual({ trawl: 'nonce-1' });
    expect(v2).toEqual({ trawl: 'nonce-1' }); // cache hit
    expect(calls).toBe(1);
  });
});
