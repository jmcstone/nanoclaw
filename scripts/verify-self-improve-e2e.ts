/**
 * Self-improve E2E verification — Wave 6
 *
 * AC-10 / AC-11 — tests that CAN run without live activation:
 *   Part A — Schema idempotency: openSelfImproveDb + ensureSelfImproveSchema ×2, all 3 tables exist.
 *   Part B — Tombstone / dedup helpers: upsertProposalKey, incrementSessionCount ×2 → count=2,
 *            recordTombstone + checkTombstone===true.
 *   Part C — L1 re-rank (no LLM): CLAUDE.local.md with unkeyed + pin + scored blocks;
 *            tiny budget → low-score block evicted, pin + high-score survive;
 *            fact-evict journal line written with correct format.
 *   Part D — Journal + commit (dry): appendJournal writes a well-formed line; commitJournalAndSkills
 *            is a no-op when nothing is staged (or skipped with explanation).
 *
 * Part E — LIVE check (pending activation + LITELLM_HOST_API_KEY) — documented only, NOT run.
 *
 * Run:  npx tsx scripts/verify-self-improve-e2e.ts
 * Exit: non-zero if any of Parts A–D fail.
 *
 * Temp files used:
 *   /tmp/si-e2e-<pid>/      SELF_IMPROVE_DIR override — self-improve.db lives here for Parts A–C
 *   groups/test-si-e2e-<pid>/  Throwaway group folder for Part C (GROUPS_DIR is fixed to cwd/groups)
 *
 * Both are deleted at the end.  The journal at self-improve-journal/JOURNAL.md is written to
 * by Parts C+D (real-time journal append).  Lines added by this script are removed at cleanup.
 * If cleanup is skipped (on error): `git checkout self-improve-journal/JOURNAL.md` to reset.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ─── Paths ─────────────────────────────────────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

// Override SELF_IMPROVE_DIR BEFORE any self-improve modules are dynamically imported.
// madison-extensions.ts reads process.env.SELF_IMPROVE_DIR at module evaluation time,
// so this must be set before the first dynamic import of any self-improve module.
const pid = process.pid;
const TEMP_SI_DIR = `/tmp/si-e2e-${pid}`;
process.env.SELF_IMPROVE_DIR = TEMP_SI_DIR;

// Test group folder inside groups/ (GROUPS_DIR = PROJECT_ROOT/groups — not configurable).
const TEST_GROUP_FOLDER = `test-si-e2e-${pid}`;
const GROUPS_DIR_PATH = path.join(PROJECT_ROOT, 'groups');
const TEST_GROUP_DIR = path.join(GROUPS_DIR_PATH, TEST_GROUP_FOLDER);

// ─── Outcome tracking ─────────────────────────────────────────────────────────
let failCount = 0;
const log = (line: string): void => process.stdout.write(line + '\n');

function pass(label: string): void {
  log(`  PASS  ${label}`);
}
function fail(label: string): void {
  log(`  FAIL  ${label}`);
  failCount++;
}
function info(label: string): void {
  log(`         ${label}`);
}

// ─── Journal cleanup tracker ──────────────────────────────────────────────────
// We record the journal line count before the tests so we can remove our test
// lines at the end, leaving the journal as close to its pre-test state as possible.
let journalPathResolved = '';
let journalLinesBeforeTests = 0;

// ─── Temp cleanup ─────────────────────────────────────────────────────────────
function cleanupTempFiles(): void {
  // 1. Remove temp SI dir (DB files for Parts A–C).
  try {
    fs.rmSync(TEMP_SI_DIR, { recursive: true, force: true });
  } catch {
    // ignore
  }

  // 2. Remove temp group dir inside groups/.
  try {
    fs.rmSync(TEST_GROUP_DIR, { recursive: true, force: true });
  } catch {
    // ignore
  }

  // 3. Trim journal lines added by this script.
  if (journalPathResolved && fs.existsSync(journalPathResolved)) {
    try {
      const content = fs.readFileSync(journalPathResolved, 'utf8');
      const lines = content.split('\n');
      // Keep exactly the lines that existed before the tests, plus the header if present.
      // journalLinesBeforeTests was measured from the raw split — use that count.
      const kept = lines.slice(0, journalLinesBeforeTests);
      // If we trimmed everything and the file would be empty or header-only, remove it.
      const trimmed = kept.join('\n');
      if (trimmed.replace(/\s/g, '').length === 0) {
        // File was empty/non-existent before — remove what we created.
        const dir = path.dirname(journalPathResolved);
        fs.unlinkSync(journalPathResolved);
        // Remove dir only if we created it (it's empty now).
        try {
          fs.rmdirSync(dir);
        } catch {
          // Not empty — leave it.
        }
      } else {
        fs.writeFileSync(journalPathResolved, trimmed, 'utf8');
      }
    } catch {
      // Best-effort cleanup; leave a note.
      log('\n  NOTE  Journal cleanup failed — run: git checkout self-improve-journal/JOURNAL.md');
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Part A — Schema idempotency
// ═══════════════════════════════════════════════════════════════════════════════

async function partA(): Promise<void> {
  log('\n## Part A — Schema idempotency');

  const dbPath = path.join(TEMP_SI_DIR, 'test-schema.db');
  fs.mkdirSync(TEMP_SI_DIR, { recursive: true });

  const { openSelfImproveDb, ensureSelfImproveSchema } = await import(
    '../src/modules/self-improve/schema.js'
  );

  let db: import('better-sqlite3').Database | undefined;
  try {
    db = openSelfImproveDb(dbPath);

    // First call — should create tables.
    try {
      ensureSelfImproveSchema(db);
    } catch (err) {
      fail(`ensureSelfImproveSchema (first call) threw: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    // Second call — must be idempotent (CREATE TABLE IF NOT EXISTS).
    try {
      ensureSelfImproveSchema(db);
    } catch (err) {
      fail(
        `ensureSelfImproveSchema (second call, idempotency check) threw: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }

    pass('ensureSelfImproveSchema is idempotent (2 calls, no error)');

    // Assert all 3 tables exist.
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);

    info(`Tables found: ${tables.join(', ')}`);

    for (const expected of ['distiller_watermark', 'proposal_keys', 'helpfulness_events']) {
      if (tables.includes(expected)) {
        pass(`Table '${expected}' exists`);
      } else {
        fail(`Table '${expected}' missing (found: ${tables.join(', ')})`);
      }
    }
  } finally {
    db?.close();
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Part B — Tombstone / dedup helpers
// ═══════════════════════════════════════════════════════════════════════════════

async function partB(): Promise<void> {
  log('\n## Part B — Tombstone / dedup helpers');

  const dbPath = path.join(TEMP_SI_DIR, 'test-tombstone.db');

  const { openSelfImproveDb, ensureSelfImproveSchema } = await import(
    '../src/modules/self-improve/schema.js'
  );
  const { upsertProposalKey, incrementSessionCount, getSessionCount, recordTombstone, checkTombstone } =
    await import('../src/modules/self-improve/tombstone.js');

  let db: import('better-sqlite3').Database | undefined;
  try {
    db = openSelfImproveDb(dbPath);
    ensureSelfImproveSchema(db);

    // ── upsertProposalKey + incrementSessionCount ────────────────────────────
    const testKey = 'fact-dedup-test';
    upsertProposalKey(db, testKey, '/tmp/proposals/fact-dedup-test.json');
    incrementSessionCount(db, testKey);
    incrementSessionCount(db, testKey);

    const count = getSessionCount(db, testKey);
    if (count === 2) {
      pass(`incrementSessionCount ×2 → getSessionCount === 2`);
    } else {
      fail(`incrementSessionCount: expected 2, got ${count}`);
    }

    // session_count accumulates; upsert again should not reset it.
    upsertProposalKey(db, testKey, '/tmp/proposals/fact-dedup-test-v2.json');
    const countAfterUpsert = getSessionCount(db, testKey);
    if (countAfterUpsert === 2) {
      pass(`upsertProposalKey does not reset session_count (still 2)`);
    } else {
      fail(`upsertProposalKey reset session_count: expected 2, got ${countAfterUpsert}`);
    }

    // ── recordTombstone + checkTombstone ─────────────────────────────────────
    const tombKey = 'rejected-skill-key';
    recordTombstone(db, tombKey, 'test rejection: skill not general enough');

    const isTombstoned = checkTombstone(db, tombKey);
    if (isTombstoned) {
      pass(`checkTombstone === true for tombstoned key`);
    } else {
      fail(`checkTombstone returned false for tombstoned key`);
    }

    // Non-tombstoned key must return false.
    const notTombstoned = checkTombstone(db, testKey);
    if (!notTombstoned) {
      pass(`checkTombstone === false for non-tombstoned key`);
    } else {
      fail(`checkTombstone returned true for non-tombstoned key`);
    }

    // Absent key must return false (no row in DB at all).
    const absentTomb = checkTombstone(db, 'key-that-does-not-exist');
    if (!absentTomb) {
      pass(`checkTombstone === false for absent key`);
    } else {
      fail(`checkTombstone returned true for absent key`);
    }

    // getSessionCount for absent key must return 0.
    const absentCount = getSessionCount(db, 'key-that-does-not-exist');
    if (absentCount === 0) {
      pass(`getSessionCount === 0 for absent key`);
    } else {
      fail(`getSessionCount expected 0 for absent key, got ${absentCount}`);
    }
  } finally {
    db?.close();
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Part C — L1 re-rank (no LLM)
// ═══════════════════════════════════════════════════════════════════════════════

async function partC(): Promise<void> {
  log('\n## Part C — L1 re-rank (no LLM)');

  // ── Build CLAUDE.local.md ─────────────────────────────────────────────────
  // Layout:
  //   - Unkeyed preamble    (always preserved)
  //   - <!-- key:pinned-identity pin -->  (always resident; exempt from frequency eviction)
  //   - <!-- key:fact-about-cats -->      (high score: 2× corroborated → admitted under tiny budget)
  //   - <!-- key:fact-about-dogs -->      (low score: 1× corrected → DEMOTED at tiny budget)
  const unkeyed = '# Test group memory\n\nThis is unkeyed preamble.\n\n';
  const pinnedBlock =
    '<!-- key:pinned-identity pin -->\nMy name is Madison.\n<!-- /key -->\n';
  const catsBlock =
    '<!-- key:fact-about-cats -->\nCats are independent animals known for agility.\n<!-- /key -->\n';
  const dogsBlock =
    '<!-- key:fact-about-dogs -->\nDogs are loyal animals that make excellent companions.\n<!-- /key -->\n';

  const claudeLocalContent = unkeyed + pinnedBlock + catsBlock + dogsBlock;

  fs.mkdirSync(TEST_GROUP_DIR, { recursive: true });
  const claudeLocalPath = path.join(TEST_GROUP_DIR, 'CLAUDE.local.md');
  fs.writeFileSync(claudeLocalPath, claudeLocalContent, 'utf8');
  info(`Created test CLAUDE.local.md (${claudeLocalContent.length} chars) at ${claudeLocalPath}`);

  // ── Pre-populate helpfulness_events in the temp self-improve.db ──────────
  // (selfImproveDbPath() → TEMP_SI_DIR/self-improve.db via the env override)
  const siDbPath = path.join(TEMP_SI_DIR, 'self-improve.db');
  const { openSelfImproveDb, ensureSelfImproveSchema, SQL_HELPFULNESS_INSERT } = await import(
    '../src/modules/self-improve/schema.js'
  );

  const siDb = openSelfImproveDb(siDbPath);
  ensureSelfImproveSchema(siDb);

  // fact-about-dogs: 1× corrected → score ≈ recency − 3 ≈ −2 (very low)
  const now = new Date().toISOString();
  siDb.prepare(SQL_HELPFULNESS_INSERT).run('fact-about-dogs', 'corrected', 'sess-test-001', now);

  // fact-about-cats: 2× corroborated → score ≈ recency + 2 ≈ 3 (high)
  siDb.prepare(SQL_HELPFULNESS_INSERT).run('fact-about-cats', 'corroborated', 'sess-test-001', now);
  siDb.prepare(SQL_HELPFULNESS_INSERT).run('fact-about-cats', 'corroborated', 'sess-test-002', now);

  siDb.close();

  // ── Record pre-test journal state ─────────────────────────────────────────
  const { JOURNAL_PATH } = await import('../src/modules/self-improve/journal.js');
  journalPathResolved = JOURNAL_PATH;
  const journalExistedBefore = fs.existsSync(JOURNAL_PATH);
  journalLinesBeforeTests = journalExistedBefore
    ? fs.readFileSync(JOURNAL_PATH, 'utf8').split('\n').length
    : 0;
  info(`Journal before test: exists=${journalExistedBefore}, lines=${journalLinesBeforeTests}`);

  // ── Call reRankL1 with a tiny budget ─────────────────────────────────────
  //
  // Token budget math (Math.ceil(chars / 4)):
  //   unkeyed (57 chars) + serializeBlock(pinned) (~67 chars) = 124 chars → 31 tokens baseline
  //   serializeBlock(cats)  ≈ 92 chars → 23 tokens
  //   serializeBlock(dogs)  ≈ 98 chars → 25 tokens
  //
  // Budget = 60:
  //   Iteration 1 (cats, higher score): 31+23=54 ≤ 60 → RESIDENT ✓
  //   Iteration 2 (dogs, lower score):  54+25=79 > 60 → DEMOTED  ✓
  const TOKEN_BUDGET = 60;

  const { reRankL1 } = await import('../src/modules/self-improve/l1-lifecycle.js');

  let result: { resident: string[]; demoted: string[] };
  try {
    result = reRankL1(TEST_GROUP_FOLDER, TOKEN_BUDGET);
  } catch (err) {
    fail(`reRankL1 threw: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  info(`reRankL1 result → resident: [${result.resident.join(', ')}]  demoted: [${result.demoted.join(', ')}]`);

  // ── Read rewritten CLAUDE.local.md and assert survivors ──────────────────
  const newContent = fs.readFileSync(claudeLocalPath, 'utf8');

  if (newContent.includes('This is unkeyed preamble.')) {
    pass('Unkeyed preamble preserved in rewritten CLAUDE.local.md');
  } else {
    fail('Unkeyed preamble was lost after reRankL1');
  }

  if (newContent.includes('<!-- key:pinned-identity pin -->')) {
    pass('Pinned block (pinned-identity) survived L1 re-rank');
  } else {
    fail('Pinned block (pinned-identity) was lost after reRankL1');
  }

  if (result.resident.includes('fact-about-cats') && newContent.includes('<!-- key:fact-about-cats -->')) {
    pass('High-score block (fact-about-cats, 2× corroborated) is resident');
  } else {
    fail(`fact-about-cats should be resident — resident=[${result.resident.join(', ')}]`);
  }

  if (result.demoted.includes('fact-about-dogs') && !newContent.includes('<!-- key:fact-about-dogs -->')) {
    pass('Low-score block (fact-about-dogs, 1× corrected) was demoted + removed from L1');
  } else {
    fail(
      `fact-about-dogs should be demoted — demoted=[${result.demoted.join(', ')}]; ` +
        `still in file: ${newContent.includes('<!-- key:fact-about-dogs -->')}`,
    );
  }

  // ── Assert fact-evict journal line was written ────────────────────────────
  if (!fs.existsSync(JOURNAL_PATH)) {
    fail('Journal file does not exist after reRankL1 — appendJournal did not create it');
    return;
  }

  const journalContent = fs.readFileSync(JOURNAL_PATH, 'utf8');
  const journalLines = journalContent.split('\n');
  const newLines = journalLines.slice(journalLinesBeforeTests).filter(Boolean);
  const evictLines = newLines.filter((l) => l.includes('fact-evict'));

  if (evictLines.length > 0) {
    pass(`fact-evict journal line written (${evictLines.length} eviction(s))`);
    info(`  Sample line: ${evictLines[0].slice(0, 120)}`);

    // Validate line format:
    //   `- <ISO ts> · fact-evict · `key` · <content> · <scope>`
    const fmtRe = /^- \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z · fact-evict · `[^`]+` · .+ · .+$/;
    if (fmtRe.test(evictLines[0])) {
      pass('Journal line format matches: - <ts> · fact-evict · `key` · <content> · <scope>');
    } else {
      fail(`Journal line format mismatch: ${evictLines[0]}`);
    }
  } else {
    fail(`No fact-evict line found in journal (${newLines.length} new line(s) added, none are fact-evict)`);
    for (const l of newLines) info(`  ${l}`);
  }

}

// ═══════════════════════════════════════════════════════════════════════════════
// Part D — Journal + commit (dry)
// ═══════════════════════════════════════════════════════════════════════════════

async function partD(): Promise<void> {
  log('\n## Part D — Journal + commit (dry)');

  const { appendJournal, JOURNAL_PATH } = await import('../src/modules/self-improve/journal.js');

  // Ensure journalPathResolved is set even if Part C was skipped.
  if (!journalPathResolved) {
    journalPathResolved = JOURNAL_PATH;
    journalLinesBeforeTests = fs.existsSync(JOURNAL_PATH)
      ? fs.readFileSync(JOURNAL_PATH, 'utf8').split('\n').length
      : 0;
  }

  const testKey = 'verify-script-part-d';
  const testContent = 'E2E verify script Part D — testing appendJournal format.';
  const testScope = 'test/session-verify';

  const lineCountBefore = fs.existsSync(JOURNAL_PATH)
    ? fs.readFileSync(JOURNAL_PATH, 'utf8').split('\n').filter(Boolean).length
    : 0;

  appendJournal('fact-add', testKey, testContent, testScope);

  if (!fs.existsSync(JOURNAL_PATH)) {
    fail('Journal file does not exist after appendJournal call');
    return;
  }

  const afterContent = fs.readFileSync(JOURNAL_PATH, 'utf8');
  const afterLines = afterContent.split('\n').filter(Boolean);
  const lineCountAfter = afterLines.length;

  if (lineCountAfter > lineCountBefore) {
    pass(`appendJournal added 1 line (${lineCountBefore} → ${lineCountAfter} non-empty lines)`);
  } else {
    fail(`appendJournal did not add a line (before=${lineCountBefore}, after=${lineCountAfter})`);
    return;
  }

  // Locate the line we wrote.
  const myLine = afterLines.find((l) => l.includes(testKey));
  if (!myLine) {
    fail(`Journal line for key '${testKey}' not found`);
    return;
  }

  info(`  Written line: ${myLine.slice(0, 160)}`);

  // Validate format:
  //   `- <ISO ts> · fact-add · `verify-script-part-d` · <content ≤140 chars> · test/session-verify`
  const fmtRe =
    /^- \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z · fact-add · `verify-script-part-d` · .+ · test\/session-verify$/;
  if (fmtRe.test(myLine)) {
    pass('Journal line format correct: - <ISO ts> · fact-add · `key` · <content> · <scope>');
  } else {
    fail(`Journal line format mismatch. Line: ${myLine}`);
  }

  // commitJournalAndSkills — skip to avoid an unintended git commit during verification.
  //
  // Why: commitJournalAndSkills() would git-add self-improve-journal/JOURNAL.md and
  // container/skills/, then commit if staged. Since our verify run wrote test lines to
  // JOURNAL.md, calling it would produce a spurious nightly-style commit on the branch.
  // The no-op path (nothing staged) is only reachable if JOURNAL.md has no new lines,
  // which is not the case here. We verify the function exists and skip invocation.
  const { commitJournalAndSkills } = await import('../src/modules/self-improve/journal.js');
  if (typeof commitJournalAndSkills === 'function') {
    pass('commitJournalAndSkills exported as a function (not invoked — would commit test lines)');
  } else {
    fail('commitJournalAndSkills is not a function');
  }

  info('  commitJournalAndSkills: skipped. Would stage self-improve-journal/JOURNAL.md +');
  info('  container/skills/ and commit. Not run here to avoid a test artifact commit.');
  info('  Production path: nightly promote pass calls it once after all groups are processed.');

}

// ═══════════════════════════════════════════════════════════════════════════════
// Part E — LIVE check (NOT RUN — pending activation + LITELLM_HOST_API_KEY)
// ═══════════════════════════════════════════════════════════════════════════════

function partEDocumented(): void {
  log('\n## Part E — LIVE check (PENDING ACTIVATION — not run)');
  log('');
  log('  Status: PENDING — requires:');
  log('    1. nanoclaw-v2-worktree service restarted with all Wave 5 modules wired in');
  log('       (scheduleDistill hooked into container-runner.ts close(0), startNightlyPromote');
  log('       registered in index.ts, approvals handlers wired for fact auto-apply).');
  log('    2. LITELLM_HOST_API_KEY added to nanoclaw-v2-worktree/.env');
  log('       (issue a dedicated host key in the LiteLLM admin UI — see findings.md SI-12).');
  log('');
  log('  Procedure (manual, post-activation):');
  log('');
  log('  1. SESSION CLOSE TRIGGER');
  log('     · Open a real Madison session in telegram_inbox (or any group).');
  log('     · Exchange a few messages containing a clearly reusable fact');
  log('       (e.g. "My preferred meeting time is Tuesday mornings").');
  log('     · End the session cleanly (exit container with code 0).');
  log('     · Within ~1 s: confirm `Distill scheduled` appears in nanoclaw logs.');
  log('     · After ~5 min: confirm `distiller: pass complete` in logs.');
  log('');
  log('  2. PROPOSAL + RECALL SUMMARY');
  log('     · A fact proposal JSON should appear under:');
  log('       ~/containers/data/NanoClaw/v2/self-improve/proposals/<folder>/<session>/');
  log('     · A `role=\'summary\'` row in the group\'s recall DB:');
  log('       sqlite3 ~/containers/data/NanoClaw/v2/recall/<folder>.db \\');
  log("         \"SELECT role, content FROM session_fts WHERE role='summary' ORDER BY rowid DESC LIMIT 3;\"");
  log('');
  log('  3. FACT AUTO-APPLY + NOTIFY');
  log('     · The fact should appear as a keyed block in:');
  log('       groups/<folder>/CLAUDE.local.md  (check: grep "<!-- key:" groups/<folder>/CLAUDE.local.md)');
  log('     · A Telegram DM notification should arrive: "🧠 learned: <key> — <content>"');
  log('     · The journal should have a fact-add line:');
  log('       grep fact-add self-improve-journal/JOURNAL.md | tail -5');
  log('');
  log('  4. NIGHTLY PROMOTE (manual trigger)');
  log('     · In a Node REPL or test script:');
  log("       import { runNightlyPromote } from './src/modules/self-improve/promote.js';");
  log('       await runNightlyPromote();');
  log('     · Verify a digest DM arrives in Telegram with L1 re-rank + correction flags section.');
  log('     · Verify a path-scoped git commit appears:');
  log('       git log --oneline self-improve-journal/JOURNAL.md | head -3');
  log('       git log --oneline container/skills/ | head -3');
  log('     · Verify per-group isolation: confirm group B has no proposals/keys from group A\'s session:');
  log('       ls ~/containers/data/NanoClaw/v2/self-improve/proposals/');
  log('       (each subdirectory corresponds to one group folder)');
  log('');
  log('  All of the above must pass before AC-10 + AC-11 are marked complete in tracker.md.');
}

// ═══════════════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════════════

log('# Self-improve E2E verification\n');
log(`PROJECT_ROOT   : ${PROJECT_ROOT}`);
log(`SELF_IMPROVE_DIR (override): ${TEMP_SI_DIR}`);
log(`Test group dir : ${TEST_GROUP_DIR}`);
log(`Parts A–D run now (no LLM, no container, no live orchestrator)`);
log(`Part E    : documented only — pending activation + LITELLM_HOST_API_KEY`);

await partA().catch((err: unknown) => {
  fail(`Part A threw: ${err instanceof Error ? err.message : String(err)}`);
});

await partB().catch((err: unknown) => {
  fail(`Part B threw: ${err instanceof Error ? err.message : String(err)}`);
});

await partC().catch((err: unknown) => {
  fail(`Part C threw: ${err instanceof Error ? err.message : String(err)}`);
});

await partD().catch((err: unknown) => {
  fail(`Part D threw: ${err instanceof Error ? err.message : String(err)}`);
});

partEDocumented();

// ─── Cleanup ──────────────────────────────────────────────────────────────────
log('\n─── Cleanup ─────────────────────────────────────────────────────');
cleanupTempFiles();
log(`  Removed: ${TEMP_SI_DIR}`);
log(`  Removed: ${TEST_GROUP_DIR}`);
if (journalPathResolved && fs.existsSync(journalPathResolved)) {
  info(`Journal test lines removed: ${journalPathResolved}`);
} else if (journalPathResolved && !fs.existsSync(journalPathResolved)) {
  info('Journal removed (was empty before test)');
}

// ─── Summary ──────────────────────────────────────────────────────────────────
log('\n─────────────────────────────────────────────────────────────────');
if (failCount === 0) {
  log('ALL RUN-NOW PARTS PASSED (A–D)');
  log('Part E is documented-only — pending activation + LITELLM_HOST_API_KEY.');
  process.exit(0);
} else {
  log(`${failCount} PART(S) FAILED`);
  log('Part E is documented-only — pending activation + LITELLM_HOST_API_KEY.');
  process.exit(1);
}
