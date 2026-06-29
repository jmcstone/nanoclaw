/**
 * DISC-7 git audit trail — append-only journal + nightly batched commit.
 *
 * Two exports:
 *   appendJournal()          — real-time per-action line append (never throws)
 *   commitJournalAndSkills() — nightly path-scoped git commit (never throws)
 *
 * The journal lives in <PROJECT_ROOT>/self-improve-journal/JOURNAL.md so it is
 * git-tracked.  `groups/` is symlinked out of the repo (facts there are not
 * trackable); the journal carries the fact-action history instead.
 *
 * PROJECT_ROOT is not re-exported by config.ts (module-private there), so we
 * compute it the same way: process.cwd() at host startup time.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { log } from '../../log.js';

const PROJECT_ROOT = process.cwd();

export const JOURNAL_DIR = path.join(PROJECT_ROOT, 'self-improve-journal');
export const JOURNAL_PATH = path.join(JOURNAL_DIR, 'JOURNAL.md');

/** Path to the container skills directory (git-tracked; committed by the nightly cron). */
export const SKILLS_DIR = path.join(PROJECT_ROOT, 'container', 'skills');

const HEADER = '# Self-Improvement Journal\n\n';

/** Wait duration before retrying git commit after an index.lock collision. */
const LOCK_RETRY_DELAY_MS = 500;

export type JournalAction = 'fact-add' | 'fact-evict' | 'fact-correct' | 'skill-trial' | 'skill-promote';

/**
 * Append one audit line to the git-tracked journal.
 *
 * Line format (single line, terminated with \n):
 *   `- <ISO ts> · <action> · `<key>` · <content, ≤140 chars, newlines collapsed> · <scope>`
 *
 * Creates JOURNAL_DIR and the file (with a `# Self-Improvement Journal` header)
 * on first call.  Never throws — journaling must not break the distiller.
 */
export function appendJournal(action: JournalAction, key: string, content: string, scope: string): void {
  try {
    const needsHeader = !fs.existsSync(JOURNAL_PATH);
    fs.mkdirSync(JOURNAL_DIR, { recursive: true });

    const ts = new Date().toISOString();
    const singleLine = content.replace(/\n/g, ' ').slice(0, 140);
    const line = `- ${ts} · ${action} · \`${key}\` · ${singleLine} · ${scope}\n`;

    if (needsHeader) {
      fs.writeFileSync(JOURNAL_PATH, HEADER + line, 'utf8');
    } else {
      fs.appendFileSync(JOURNAL_PATH, line, 'utf8');
    }
  } catch (err) {
    log.error('journal: appendJournal failed', { err });
  }
}

/**
 * Batch git commit of the journal + promoted skills — for the nightly cron pass.
 *
 * Stages only self-improve-authored files:
 *   - `self-improve-journal/JOURNAL.md` (when it exists)
 *   - NEW (untracked) files under `container/skills/` only — never stages
 *     modifications to existing tracked skill files (those belong to the developer).
 * No-op when there is nothing to stage.
 * Path-scoped diff check and commit — unrelated staged changes are left untouched.
 * Resets staged paths on commit failure to leave the developer's index clean.
 * Retries once on `index.lock` contention (500 ms wait).
 * Never throws.
 */
export async function commitJournalAndSkills(): Promise<void> {
  const date = new Date().toISOString().slice(0, 10);
  const msg = `self-improve: ${date} journal+skills`;

  // --- Determine which files to stage ---------------------------------------
  // FIX 4: guard against absent skills directory (fresh/pruned tree).
  // FIX 2: stage only NEW (untracked) skill files via ls-files --others;
  //         existing tracked files under container/skills/ belong to the developer.
  const stagedPaths: string[] = [];

  if (fs.existsSync(SKILLS_DIR)) {
    try {
      const lsOut = execSync('git ls-files --others --exclude-standard -z -- container/skills', {
        cwd: PROJECT_ROOT,
        stdio: 'pipe',
      }).toString();
      const newSkills = lsOut.split('\0').filter(Boolean);
      stagedPaths.push(...newSkills);
    } catch (err) {
      log.error('journal: git ls-files failed', { err });
      return;
    }
  }

  if (fs.existsSync(JOURNAL_PATH)) {
    stagedPaths.push('self-improve-journal/JOURNAL.md');
  }

  if (stagedPaths.length === 0) {
    log.debug('journal: commitJournalAndSkills — nothing to stage, skipping');
    return;
  }

  // Shell-safe path args: JSON.stringify wraps each path in double-quotes.
  const pathArgs = stagedPaths.map((p) => JSON.stringify(p)).join(' ');

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      execSync(`git add -- ${pathArgs}`, { cwd: PROJECT_ROOT, stdio: 'pipe' });

      // FIX 1: path-scope the staged check to self-improve paths only.
      let hasStagedChanges = false;
      try {
        execSync(`git diff --cached --quiet -- ${pathArgs}`, { cwd: PROJECT_ROOT, stdio: 'pipe' });
      } catch {
        hasStagedChanges = true;
      }

      if (!hasStagedChanges) {
        log.debug('journal: commitJournalAndSkills — nothing staged, skipping');
        return;
      }

      // FIX 1: path-scope the commit; leaves unrelated staged changes untouched.
      execSync(`git commit -m ${JSON.stringify(msg)} -- ${pathArgs}`, {
        cwd: PROJECT_ROOT,
        stdio: 'pipe',
      });
      log.info('journal: committed journal+skills', { date });
      return;
    } catch (err) {
      const isLock = err instanceof Error && err.message.includes('index.lock');
      if (isLock && attempt === 0) {
        log.warn('journal: index.lock detected, retrying after 500 ms');
        await new Promise<void>((resolve) => setTimeout(resolve, LOCK_RETRY_DELAY_MS));
        continue;
      }
      log.error('journal: commitJournalAndSkills failed', { err, attempt });
      // FIX 3: best-effort unstage the paths this function staged; leaves the
      //         developer's index as it was before this function ran.
      try {
        execSync(`git reset HEAD -- ${pathArgs}`, { cwd: PROJECT_ROOT, stdio: 'pipe' });
      } catch {
        // Ignore reset errors — never throw.
      }
      return;
    }
  }
}
