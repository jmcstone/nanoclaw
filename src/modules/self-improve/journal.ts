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

const HEADER = '# Self-Improvement Journal\n\n';

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
 * Path-scoped: stages only `self-improve-journal/JOURNAL.md` and
 * `container/skills/` — never touches other tracked files.
 * No-op when nothing is staged (idempotent on repeated calls).
 * Retries once on `index.lock` contention (500 ms wait).
 * Never throws.
 */
export function commitJournalAndSkills(): void {
  const date = new Date().toISOString().slice(0, 10);
  const msg = `self-improve: ${date} journal+skills`;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      execSync('git add self-improve-journal/JOURNAL.md container/skills', {
        cwd: PROJECT_ROOT,
        stdio: 'pipe',
      });

      // git diff --cached --quiet: exit 0 = nothing staged, exit 1 = staged changes.
      let hasStagedChanges = false;
      try {
        execSync('git diff --cached --quiet', { cwd: PROJECT_ROOT, stdio: 'pipe' });
      } catch {
        hasStagedChanges = true;
      }

      if (!hasStagedChanges) {
        log.debug('journal: commitJournalAndSkills — nothing staged, skipping');
        return;
      }

      execSync(`git commit -m ${JSON.stringify(msg)}`, {
        cwd: PROJECT_ROOT,
        stdio: 'pipe',
      });
      log.info('journal: committed journal+skills', { date });
      return;
    } catch (err) {
      const isLock = err instanceof Error && err.message.includes('index.lock');
      if (isLock && attempt === 0) {
        log.warn('journal: index.lock detected, retrying after 500 ms');
        execSync('sleep 0.5');
        continue;
      }
      log.error('journal: commitJournalAndSkills failed', { err, attempt });
      return;
    }
  }
}
