/**
 * Advisory cooperative lock for per-group CLAUDE.local.md writes.
 *
 * Prevents a race between the distiller's synchronous fact-write batch and the
 * nightly reRankL1 pass, both of which rewrite CLAUDE.local.md for the same group.
 *
 * Strategy: lockfile at groups/<folder>/.l1.lock opened with O_EXCL (wx flag).
 * On contention, spin-retry up to ~2 s, then proceed with a warning so a
 * crashed holder never permanently stalls the caller.
 *
 * NOTE: the in-container agent does NOT take this lock — agent-vs-host races
 * remain a documented follow-up item out of scope here.
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../../config.js';
import { log } from '../../log.js';

const LOCK_RETRY_INTERVAL_MS = 200;
const LOCK_MAX_RETRIES = 10; // 10 × 200 ms = ~2 s max wait

/**
 * Run `fn` while holding an advisory lock for the given group folder.
 *
 * The lock is a `.l1.lock` file opened with O_EXCL (create-exclusive). On
 * contention (EEXIST), retries up to ~2 s with a synchronous busy-wait between
 * attempts, then proceeds with a warning — a stale lock from a crashed process
 * should never block the caller indefinitely. Always unlinks the lockfile in
 * `finally`.
 *
 * Since Node.js is single-threaded, true concurrent contention is impossible;
 * the spin-wait addresses stale locks from crashed processes only. Both the
 * distiller fact-write batch and reRankL1 must hold this lock while touching
 * CLAUDE.local.md so that a future introduction of async gaps cannot reintroduce
 * interleaving.
 */
export function withGroupLock<T>(folder: string, fn: () => T): T {
  const lockPath = path.join(GROUPS_DIR, folder, '.l1.lock');
  // Ensure the group directory exists (may be a first-run for this group).
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  let fd: number | null = null;

  for (let attempt = 0; attempt <= LOCK_MAX_RETRIES; attempt++) {
    try {
      fd = fs.openSync(lockPath, 'wx');
      break; // acquired
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      if (attempt === LOCK_MAX_RETRIES) {
        log.warn('group-lock: lock still held after max retries — proceeding anyway', { folder, lockPath });
        break;
      }
      // Synchronous busy-wait: keeps the batch synchronous without yielding the
      // event loop.  Stale locks are the only contention case in single-threaded
      // Node.js; the retry window is bounded at 2 s.
      const deadline = Date.now() + LOCK_RETRY_INTERVAL_MS;
      while (Date.now() < deadline) {
        /* busy-wait */
      }
    }
  }

  try {
    return fn();
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    try {
      fs.unlinkSync(lockPath);
    } catch {
      /* ignore */
    }
  }
}
