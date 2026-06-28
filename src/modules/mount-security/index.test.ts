import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect, beforeAll, vi } from 'vitest';

// The exact-root bypass: a path matching a default-blocked pattern (e.g. `.ssh`)
// is allowed ONLY if it is listed verbatim (exact realpath match) in
// allowlist.allowedRoots — used to mount ~/.ssh/gitlab read-only for git push.
// These tests build a throwaway HOME with a fixture allowlist and import the
// module fresh so config.ts resolves MOUNT_ALLOWLIST_PATH under it.

let validateMount: typeof import('./index.js').validateMount;
let home: string;

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'mount-sec-'));
  fs.mkdirSync(path.join(home, '.config', 'nanoclaw'), { recursive: true });
  fs.mkdirSync(path.join(home, '.ssh'), { recursive: true });
  fs.mkdirSync(path.join(home, 'work'), { recursive: true });
  fs.writeFileSync(path.join(home, '.ssh', 'gitlab'), 'KEY');
  fs.writeFileSync(path.join(home, '.ssh', 'id_rsa'), 'KEY');
  fs.writeFileSync(path.join(home, 'work', 'file.txt'), 'x');
  fs.writeFileSync(
    path.join(home, '.config', 'nanoclaw', 'mount-allowlist.json'),
    JSON.stringify({
      allowedRoots: [
        { path: '~/work', allowReadWrite: true },
        { path: '~/.ssh/gitlab', allowReadWrite: false }, // EXACT entry → bypasses the .ssh block
      ],
      blockedPatterns: [], // `.ssh` comes from DEFAULT_BLOCKED_PATTERNS, merged at load
    }),
  );
  vi.stubEnv('HOME', home);
  vi.resetModules();
  ({ validateMount } = await import('./index.js'));
});

describe('mount-security exact-root bypass', () => {
  it('ALLOWS the exact-allowlisted blocked path (~/.ssh/gitlab)', () => {
    const r = validateMount({ hostPath: '~/.ssh/gitlab', containerPath: '.ssh/gitlab', readonly: true });
    expect(r.allowed).toBe(true);
  });

  it('BLOCKS another .ssh path that is NOT exactly allowlisted (~/.ssh/id_rsa)', () => {
    const r = validateMount({ hostPath: '~/.ssh/id_rsa', containerPath: '.ssh/id_rsa', readonly: true });
    expect(r.allowed).toBe(false);
  });

  it('ALLOWS a normal path under an allowed root', () => {
    const r = validateMount({ hostPath: '~/work/file.txt', containerPath: 'work/file.txt', readonly: true });
    expect(r.allowed).toBe(true);
  });

  it('forces the read-only key mount to read-only even if RW requested', () => {
    const r = validateMount({ hostPath: '~/.ssh/gitlab', containerPath: '.ssh/gitlab', readonly: false });
    expect(r.allowed).toBe(true);
    if (r.allowed) expect(r.effectiveReadonly).toBe(true); // allowReadWrite:false on the exact root
  });

  it('rejects a container path that escapes via ".."', () => {
    const r = validateMount({ hostPath: '~/work/file.txt', containerPath: '../escape', readonly: true });
    expect(r.allowed).toBe(false);
  });
});
