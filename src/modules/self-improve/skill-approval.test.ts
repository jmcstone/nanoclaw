/**
 * Unit tests for issueSkillApprovalCard (AC-6).
 *
 * Verifies:
 *   1. A card is issued for a qualifying key — requestApprovalForGroup called
 *      with the correct sessionless payload (action='propose_skill', agentGroupId,
 *      payload.key, payload.evidence, etc.).
 *   2. card_issued_at is stamped in proposal_keys on success.
 *   3. A second call for the same key is deduped — requestApprovalForGroup is
 *      NOT called again.
 *   4. When delivery returns false, card_issued_at remains null.
 *
 * Delivery is fully stubbed: requestApprovalForGroup is mocked so no real
 * Telegram messages are sent.  The self-improve DB is redirected to a temp
 * directory isolated per process.
 */
// vi.mock factories are hoisted before any variable declarations. Use vi.fn()
// directly inside the factory; reference the spy via vi.mocked() after imports.
import { vi } from 'vitest';
vi.mock('../approvals/primitive.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../approvals/primitive.js')>();
  return {
    ...actual,
    requestApprovalForGroup: vi.fn().mockResolvedValue(true),
  };
});

// Redirect the self-improve DB to a temp directory before any module loads.
vi.mock('../../madison-extensions.js', async (importOriginal) => {
  const osModule = await import('node:os');
  const pathModule = await import('node:path');
  const siDir = pathModule.join(osModule.tmpdir(), `si-skill-test-${process.pid}`);
  const actual = await importOriginal<typeof import('../../madison-extensions.js')>();
  return {
    ...actual,
    selfImproveDbPath: () => pathModule.join(siDir, 'self-improve.db'),
  };
});

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { requestApprovalForGroup } from '../approvals/primitive.js';
import { issueSkillApprovalCard } from './skill-approval.js';
import { ensureSelfImproveSchema, openSelfImproveDb } from './schema.js';
import type { SkillItem } from './schema.js';

const TEST_SI_DIR = path.join(os.tmpdir(), `si-skill-test-${process.pid}`);
const TEST_DB_PATH = path.join(TEST_SI_DIR, 'self-improve.db');

const TEST_AGENT_GROUP_ID = 'ag-test-skill';
const TEST_FOLDER = 'test-skill-folder';

const TEST_ITEM: SkillItem = {
  key: 'test-skill-key',
  name: 'test-skill',
  procedure: 'When the user asks for X, do Y.',
  evidence_summary: 'Observed in multiple sessions.',
};

// Typed reference to the hoisted mock.
const mockIssue = vi.mocked(requestApprovalForGroup);

beforeAll(() => {
  fs.mkdirSync(TEST_SI_DIR, { recursive: true });
  const db = openSelfImproveDb(TEST_DB_PATH);
  ensureSelfImproveSchema(db);
  // Seed a qualifying proposal_keys row (session_count=2, not tombstoned).
  db.prepare(
    `INSERT INTO proposal_keys (key, tombstone, session_count, created_at, updated_at)
     VALUES (?, 0, 2, ?, ?)`,
  ).run(TEST_ITEM.key, new Date().toISOString(), new Date().toISOString());
  db.close();
});

afterAll(() => {
  fs.rmSync(TEST_SI_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  mockIssue.mockResolvedValue(true);
  // Reset card_issued_at so each test starts from a clean slate.
  const db = openSelfImproveDb(TEST_DB_PATH);
  db.prepare('UPDATE proposal_keys SET card_issued_at = NULL WHERE key = ?').run(TEST_ITEM.key);
  db.close();
});

describe('issueSkillApprovalCard', () => {
  it('issues a card and stamps card_issued_at; second call is deduped', async () => {
    // ── First call: card issued ────────────────────────────────────────────
    const first = await issueSkillApprovalCard(TEST_AGENT_GROUP_ID, TEST_FOLDER, TEST_ITEM, 2);

    expect(first).toBe(true);
    expect(mockIssue).toHaveBeenCalledOnce();

    // Verify the sessionless payload shape delivered to the approval primitive.
    const opts = mockIssue.mock.calls[0][0];
    expect(opts.action).toBe('propose_skill');
    expect(opts.agentGroupId).toBe(TEST_AGENT_GROUP_ID);
    expect(opts.payload.key).toBe(TEST_ITEM.key);
    expect(opts.payload.name).toBe(TEST_ITEM.name);
    expect(opts.payload.procedure).toBe(TEST_ITEM.procedure);
    expect(opts.payload.folder).toBe(TEST_FOLDER);
    expect(opts.payload.evidence).toBe('Recurred in 2 sessions');
    expect(opts.title).toBe(`Propose skill: ${TEST_ITEM.name}`);

    // card_issued_at must be stamped in the self-improve DB.
    {
      const db = openSelfImproveDb(TEST_DB_PATH);
      const row = db.prepare('SELECT card_issued_at FROM proposal_keys WHERE key = ?').get(TEST_ITEM.key) as
        | { card_issued_at: string | null }
        | undefined;
      db.close();
      expect(row?.card_issued_at).toBeTruthy();
    }

    // ── Second call: dedup — no new card ──────────────────────────────────
    const second = await issueSkillApprovalCard(TEST_AGENT_GROUP_ID, TEST_FOLDER, TEST_ITEM, 2);

    expect(second).toBe(false);
    // requestApprovalForGroup must NOT have been called a second time.
    expect(mockIssue).toHaveBeenCalledOnce();
  });

  it('returns false and leaves card_issued_at null when delivery fails', async () => {
    mockIssue.mockResolvedValue(false);

    const issued = await issueSkillApprovalCard(TEST_AGENT_GROUP_ID, TEST_FOLDER, TEST_ITEM, 2);

    expect(issued).toBe(false);
    expect(mockIssue).toHaveBeenCalledOnce();

    // card_issued_at must remain null so the next nightly run retries.
    const db = openSelfImproveDb(TEST_DB_PATH);
    const row = db.prepare('SELECT card_issued_at FROM proposal_keys WHERE key = ?').get(TEST_ITEM.key) as
      | { card_issued_at: string | null }
      | undefined;
    db.close();
    expect(row?.card_issued_at).toBeNull();
  });
});
