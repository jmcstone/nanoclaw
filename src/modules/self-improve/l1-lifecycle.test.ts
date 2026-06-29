/**
 * Unit + integration tests for l1-lifecycle.ts.
 *
 * scorePool — pure function, no I/O, fully testable in isolation.
 * reRankL1  — integration test using a temp group directory in groups/.
 *             The self-improve DB path is overridden via a vi.mock factory so
 *             the module under test uses an isolated temp directory.
 */
import { vi } from 'vitest';

// vi.mock factories are hoisted before module evaluation, so top-level const
// bindings are not yet initialised when the factory runs.  We re-derive the
// temp path inside the factory using the same formula (process.pid is stable).
vi.mock('../../madison-extensions.js', async (importOriginal) => {
  const osModule = await import('node:os');
  const pathModule = await import('node:path');
  const siDir = pathModule.join(osModule.tmpdir(), `si-l1-test-${process.pid}`);
  const actual = await importOriginal<typeof import('../../madison-extensions.js')>();
  return {
    ...actual,
    selfImproveDbPath: () => pathModule.join(siDir, 'self-improve.db'),
    SELF_IMPROVE_DIR: siDir,
  };
});

// Prevent reRankL1's appendJournal calls from writing to the real journal file
// during tests.  Journal correctness is covered by the E2E script (Part C).
vi.mock('./journal.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./journal.js')>();
  return {
    ...actual,
    appendJournal: vi.fn(), // no-op in tests
  };
});

import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { scorePool, reRankL1 } from './l1-lifecycle.js';
import type { HelpfulnessEvent } from './l1-lifecycle.js';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const GROUPS_DIR = path.join(PROJECT_ROOT, 'groups');
const TEST_GROUP = `l1-test-${process.pid}`;
const TEST_GROUP_DIR = path.join(GROUPS_DIR, TEST_GROUP);
const CLAUDE_LOCAL = path.join(TEST_GROUP_DIR, 'CLAUDE.local.md');

// Must match the formula used in the vi.mock factory above.
const TEST_SI_DIR = path.join(os.tmpdir(), `si-l1-test-${process.pid}`);

// ---------------------------------------------------------------------------
// scorePool — pure function tests
// ---------------------------------------------------------------------------

describe('scorePool', () => {
  it('returns an empty map for no events', () => {
    const result = scorePool([]);
    expect(result.size).toBe(0);
  });

  it('scores corroborated events positively', () => {
    const ts = new Date().toISOString();
    const events: HelpfulnessEvent[] = [
      { key: 'fact-a', event: 'corroborated', ts },
      { key: 'fact-a', event: 'corroborated', ts },
    ];
    const scores = scorePool(events);
    expect(scores.get('fact-a')).toBeGreaterThan(0);
  });

  it('penalises corrected events via CORRECTION_PENALTY', () => {
    const ts = new Date().toISOString();
    const mixed: HelpfulnessEvent[] = [
      { key: 'good', event: 'corroborated', ts },
      { key: 'bad', event: 'corrected', ts },
    ];
    const scores = scorePool(mixed);
    expect(scores.get('good')!).toBeGreaterThan(scores.get('bad')!);
  });

  it('applies a staleness penalty for events older than threshold', () => {
    const recentTs = new Date().toISOString();
    // 70 days ago — past the 60-day staleness threshold
    const staleTs = new Date(Date.now() - 70 * 24 * 60 * 60 * 1000).toISOString();
    const events: HelpfulnessEvent[] = [
      { key: 'recent', event: 'corroborated', ts: recentTs },
      { key: 'stale', event: 'corroborated', ts: staleTs },
    ];
    const scores = scorePool(events);
    expect(scores.get('recent')!).toBeGreaterThan(scores.get('stale')!);
  });

  it('counts recall-hit events as positive', () => {
    const ts = new Date().toISOString();
    const events: HelpfulnessEvent[] = [{ key: 'hit', event: 'recall-hit', ts }];
    const scores = scorePool(events);
    expect(scores.get('hit')!).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// reRankL1 — integration tests using a temp group folder
// ---------------------------------------------------------------------------

describe('reRankL1', () => {
  beforeAll(() => {
    fs.mkdirSync(TEST_GROUP_DIR, { recursive: true });
    fs.mkdirSync(TEST_SI_DIR, { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(TEST_GROUP_DIR, { recursive: true, force: true });
    fs.rmSync(TEST_SI_DIR, { recursive: true, force: true });
  });

  it('returns empty lists when the file has no keyed blocks', () => {
    fs.writeFileSync(CLAUDE_LOCAL, '# Preamble\n\nNo blocks here.\n');
    const result = reRankL1(TEST_GROUP, 5000);
    expect(result.resident).toEqual([]);
    expect(result.demoted).toEqual([]);
  });

  it('preserves the unkeyed preamble after re-rank', () => {
    const content = '# Header\n\nPreamble.\n\n<!-- key:f1 -->\nFact.\n<!-- /key -->\n';
    fs.writeFileSync(CLAUDE_LOCAL, content);
    reRankL1(TEST_GROUP, 5000);
    expect(fs.readFileSync(CLAUDE_LOCAL, 'utf8')).toContain('Preamble.');
  });

  it('pinned block survives even at zero budget', () => {
    const content =
      '<!-- key:pinned-x pin -->\nCritical.\n<!-- /key -->\n' + '<!-- key:regular-x -->\nRegular.\n<!-- /key -->\n';
    fs.writeFileSync(CLAUDE_LOCAL, content);
    // Budget of 1 token — only the always-resident pinned block fits
    const result = reRankL1(TEST_GROUP, 1);
    expect(result.resident).toContain('pinned-x');
    expect(fs.readFileSync(CLAUDE_LOCAL, 'utf8')).toContain('<!-- key:pinned-x pin -->');
  });

  it('demotes a block when the budget is exhausted', () => {
    // Two equally-scored blocks (no helpfulness events → both score 0);
    // a very tight budget admits only one.
    const content =
      '<!-- key:block-a -->\nFact A content here.\n<!-- /key -->\n' +
      '<!-- key:block-b -->\nFact B content here.\n<!-- /key -->\n';
    fs.writeFileSync(CLAUDE_LOCAL, content);
    // Each block ≈ 45 chars → ~12 tokens; budget 15 admits only the first
    const result = reRankL1(TEST_GROUP, 15);
    expect(result.resident.length + result.demoted.length).toBe(2);
    expect(result.demoted.length).toBeGreaterThan(0);
  });

  it('block format round-trip: upsertKeyedBlock format parses correctly', () => {
    // Simulate exactly what upsertKeyedBlock writes and verify KEY_BLOCK_RE parses it.
    const key = 'round-trip';
    // Format: <!-- key:<slug> -->\n<content ending with \n><!-- /key -->\n
    const block = `<!-- key:${key} -->\nSome fact content.\n<!-- /key -->\n`;
    fs.writeFileSync(CLAUDE_LOCAL, block);
    const result = reRankL1(TEST_GROUP, 5000);
    expect(result.resident).toContain(key);
  });

  it('pinned block format round-trip', () => {
    const block = `<!-- key:pinned-rt pin -->\nPinned content.\n<!-- /key -->\n`;
    fs.writeFileSync(CLAUDE_LOCAL, block);
    const result = reRankL1(TEST_GROUP, 5000);
    // Pinned blocks must be recognised as pinned (always resident, never in demoted)
    expect(result.resident).toContain('pinned-rt');
    expect(result.demoted).not.toContain('pinned-rt');
  });
});
