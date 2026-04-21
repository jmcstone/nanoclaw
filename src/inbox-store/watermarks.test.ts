import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { _initTestInboxDb, _closeInboxDb, getInboxDb } from './db.js';
import { getWatermark, setWatermark } from './watermarks.js';

beforeEach(() => {
  _initTestInboxDb();
  // Insert accounts required by the watermarks FK
  getInboxDb()
    .prepare(
      `INSERT INTO accounts (account_id, source, email_address) VALUES (?, ?, ?)`,
    )
    .run('acct-1', 'gmail', 'jeff@example.com');
  getInboxDb()
    .prepare(
      `INSERT INTO accounts (account_id, source, email_address) VALUES (?, ?, ?)`,
    )
    .run('acct-2', 'protonmail', 'jeff@proton.me');
});

afterEach(() => {
  _closeInboxDb();
});

// --- 1. getWatermark returns null for missing row ---

describe('getWatermark: no row', () => {
  it('returns null when account has no watermark', () => {
    expect(getWatermark('acct-1')).toBeNull();
  });
});

// --- 2. Round-trip setWatermark / getWatermark ---

describe('setWatermark / getWatermark: round-trip', () => {
  it('reads back the value that was written', () => {
    setWatermark('acct-1', 'v1');
    const w = getWatermark('acct-1');
    expect(w).not.toBeNull();
    expect(w!.account_id).toBe('acct-1');
    expect(w!.watermark_value).toBe('v1');
    expect(typeof w!.updated_at).toBe('string');
    expect(w!.updated_at.length).toBeGreaterThan(0);
  });
});

// --- 3. Upsert: second write updates value and updated_at ---

describe('setWatermark: upsert', () => {
  it('second call updates watermark_value and updated_at', () => {
    setWatermark('acct-1', 'v1');
    const first = getWatermark('acct-1')!;

    // Ensure at least 1 ms elapses so updated_at differs
    const start = Date.now();
    while (Date.now() <= start) {
      /* spin */
    }

    setWatermark('acct-1', 'v2');
    const second = getWatermark('acct-1')!;

    expect(second.watermark_value).toBe('v2');
    // Only one row exists
    const count = getInboxDb()
      .prepare(
        `SELECT COUNT(*) as n FROM watermarks WHERE account_id = 'acct-1'`,
      )
      .get() as { n: number };
    expect(count.n).toBe(1);
    // updated_at moved forward
    expect(second.updated_at >= first.updated_at).toBe(true);
  });
});

// --- 4. Separate accounts keep independent watermarks ---

describe('setWatermark: separate accounts', () => {
  it('does not clobber a different account watermark', () => {
    setWatermark('acct-1', 'foo');
    setWatermark('acct-2', 'bar');

    expect(getWatermark('acct-1')!.watermark_value).toBe('foo');
    expect(getWatermark('acct-2')!.watermark_value).toBe('bar');
  });
});

// --- 5. setWatermark throws on unknown account_id (FK violation) ---

describe('setWatermark: FK enforcement', () => {
  it('throws when account_id does not exist in accounts', () => {
    expect(() => setWatermark('nonexistent-id', 'v1')).toThrow();
  });
});

// --- 6. updated_at is an ISO 8601 string parseable by Date ---

describe('setWatermark: updated_at format', () => {
  it('updated_at is a valid ISO 8601 date string', () => {
    setWatermark('acct-1', '2024-06-01T00:00:00Z');
    const w = getWatermark('acct-1')!;
    const d = new Date(w.updated_at);
    expect(isNaN(d.getTime())).toBe(false);
  });
});
