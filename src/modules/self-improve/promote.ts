/**
 * Nightly promote pass — offline half of the two-tier cadence (SI-2).
 *
 * Runs once per 24 h (setInterval); skipped when < 20 h have elapsed since the
 * last completed run; starts after a 60 s startup delay so it doesn't race with
 * delivery-adapter and DB initialisation at host boot.
 *
 * Per group:
 *   1. Query proposal_keys WHERE tombstone=0 AND session_count >= 2.
 *   2. For each qualifying key not yet processed this run and not already a
 *      trial skill, locate the skill candidate JSON under proposalsDir(folder).
 *   3. Re-rank L1 via reRankL1(folder, 1500).
 *
 * After all groups: emit ONE batched digest to Jeff via the delivery adapter
 * (skills surfaced + L1 resident/demoted counts + recent correction flags).
 * Per DISC-4, `getDeliveryAdapter().deliver()` is the correct reach path.
 *
 * Finally: call commitJournalAndSkills() for the single nightly git commit of
 * self-improve-journal/JOURNAL.md + container/skills/ (DISC-7).
 *
 * NOTE — requestApproval is NOT called here: it requires a live Session object
 * (session_id for the pending_approvals row; notifyAgent write-back path) that
 * does not exist in a host cron pass. The digest IS the gate for this cadence;
 * formal approval-card delivery for nightly-surfaced skills requires a future
 * session-bridge enhancement (see report).
 *
 * Locked decisions: SI-2, SI-4, SI-8, DISC-2, DISC-4, DISC-7.
 */
import type Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { getAllAgentGroups } from '../../db/agent-groups.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';
import { isSelfImproveEnabled, proposalsDir, selfImproveDbPath } from '../../madison-extensions.js';
import { pickApprovalDelivery, pickApprover } from '../approvals/primitive.js';
import { appendJournal, commitJournalAndSkills } from './journal.js';
import { reRankL1 } from './l1-lifecycle.js';
import { ensureSelfImproveSchema, openSelfImproveDb } from './schema.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROJECT_ROOT = process.cwd();
const SKILLS_DIR = path.join(PROJECT_ROOT, 'container', 'skills');

const STARTUP_DELAY_MS = 60_000; // 60 s before the very first run
const INTERVAL_MS = 24 * 60 * 60_000; // 24 h between runs
const MIN_INTERVAL_MS = 20 * 60 * 60_000; // 20 h guard — skip if run too recently
const CORRECTION_LOOKBACK_DAYS = 7;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SkillCandidate {
  key: string;
  name: string;
  procedure: string;
  evidence_summary: string;
}

interface GroupResult {
  folder: string;
  candidates: Array<{ key: string; name: string; evidence_summary: string }>;
  resident: string[];
  demoted: string[];
}

// ---------------------------------------------------------------------------
// Module-private state
// ---------------------------------------------------------------------------

/** Epoch ms of the last completed promote pass. 0 = never run. */
let lastRun = 0;

/** Handle for the 60 s startup timer (cleared once it fires). */
let startupTimer: NodeJS.Timeout | undefined;

/** Handle for the 24 h recurring interval. */
let intervalHandle: NodeJS.Timeout | undefined;

// ---------------------------------------------------------------------------
// Public API — start / stop
// ---------------------------------------------------------------------------

/**
 * Start the nightly promote cron.
 *
 * Waits STARTUP_DELAY_MS before the first run so the delivery adapter and DB
 * connections are fully initialised. After the first run, re-runs every 24 h.
 * Idempotent — returns immediately if already started.
 */
export function startNightlyPromote(): void {
  if (startupTimer !== undefined || intervalHandle !== undefined) return;
  log.info('promote: scheduling nightly promote pass', {
    startupDelayMs: STARTUP_DELAY_MS,
    intervalMs: INTERVAL_MS,
  });
  startupTimer = setTimeout(() => {
    startupTimer = undefined;
    void runNightlyPromote();
    intervalHandle = setInterval(() => void runNightlyPromote(), INTERVAL_MS);
  }, STARTUP_DELAY_MS);
}

/**
 * Stop the nightly promote cron. Clears both the startup timer (if still
 * pending) and the recurring interval. Any in-progress run completes normally.
 */
export function stopNightlyPromote(): void {
  if (startupTimer !== undefined) {
    clearTimeout(startupTimer);
    startupTimer = undefined;
  }
  if (intervalHandle !== undefined) {
    clearInterval(intervalHandle);
    intervalHandle = undefined;
  }
  log.info('promote: nightly promote stopped');
}

// ---------------------------------------------------------------------------
// Core promote pass
// ---------------------------------------------------------------------------

/**
 * Run the nightly promote pass.
 *
 * Skips if < 20 h since the last completed run. Never throws — all errors are
 * logged and the pass continues with the next group or step.
 */
export async function runNightlyPromote(): Promise<void> {
  const now = Date.now();
  if (lastRun > 0 && now - lastRun < MIN_INTERVAL_MS) {
    log.debug('promote: skipping — < 20 h since last run', { elapsedMs: now - lastRun });
    return;
  }

  log.info('promote: starting nightly promote pass');

  const groups = getAllAgentGroups();

  // ── Open the shared self-improve DB ────────────────────────────────────────
  // Closed before the per-group loop so reRankL1 (which opens its own handle)
  // doesn't contend for the write lock.
  let db: Database.Database | null = null;
  let qualifyingKeys: string[] = [];
  const correctionKeys: string[] = [];

  try {
    db = openSelfImproveDb(selfImproveDbPath());
    ensureSelfImproveSchema(db);

    // Query keys that have recurred across ≥ 2 sessions and are not tombstoned.
    try {
      qualifyingKeys = (
        db.prepare('SELECT key FROM proposal_keys WHERE tombstone = 0 AND session_count >= 2').all() as Array<{
          key: string;
        }>
      ).map((r) => r.key);
      log.debug('promote: qualifying skill keys', { count: qualifyingKeys.length });
    } catch (err) {
      log.error('promote: failed to query proposal_keys', { err });
    }

    // Collect recently corrected keys for the digest (last 7 days).
    try {
      const since = new Date(now - CORRECTION_LOOKBACK_DAYS * 24 * 60 * 60_000).toISOString();
      const corrRows = db
        .prepare(
          "SELECT DISTINCT key FROM helpfulness_events WHERE event = 'corrected' AND ts >= ? ORDER BY ts DESC LIMIT 20",
        )
        .all(since) as Array<{ key: string }>;
      for (const r of corrRows) correctionKeys.push(r.key);
    } catch (err) {
      log.warn('promote: failed to query corrections', { err });
    }
  } catch (err) {
    log.error('promote: failed to open self-improve DB — aborting pass', { err });
    return;
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }

  // ── Per-group pass ──────────────────────────────────────────────────────────
  const results: GroupResult[] = [];
  // Track keys processed this run so the same key is not surfaced twice across
  // groups (best-effort dedup — the first group that owns a key wins).
  const processedInRun = new Set<string>();

  for (const group of groups) {
    const { folder } = group;
    if (!isSelfImproveEnabled(folder)) continue;
    try {
      const candidates: GroupResult['candidates'] = [];

      // ── Step 1+2: surface skill candidates ───────────────────────────────
      for (const key of qualifyingKeys) {
        if (processedInRun.has(key)) continue;

        const candidate = findSkillCandidate(folder, key);
        if (!candidate) continue; // Not a skill from this group.

        // Skip if the trial skill already exists (already approved in a prior pass).
        if (fs.existsSync(path.join(SKILLS_DIR, candidate.name, 'instructions.md'))) {
          log.debug('promote: skill already trialing — skipping', {
            key,
            name: candidate.name,
            folder,
          });
          continue;
        }

        processedInRun.add(key);
        candidates.push({
          key: candidate.key,
          name: candidate.name,
          evidence_summary: candidate.evidence_summary,
        });

        appendJournal('skill-promote', key, candidate.name, folder);
        log.info('promote: skill candidate surfaced', { key, name: candidate.name, folder });
      }

      // ── Step 3: re-rank L1 ───────────────────────────────────────────────
      let resident: string[] = [];
      let demoted: string[] = [];
      try {
        const rankResult = reRankL1(folder, 1500);
        resident = rankResult.resident;
        demoted = rankResult.demoted;
        log.info('promote: L1 re-rank complete', {
          folder,
          resident: resident.length,
          demoted: demoted.length,
        });
      } catch (err) {
        log.error('promote: L1 re-rank failed', { folder, err });
      }

      results.push({ folder, candidates, resident, demoted });
    } catch (err) {
      log.error('promote: per-group error (continuing)', { folder, err });
    }
  }

  // ── Emit batched digest ────────────────────────────────────────────────────
  await deliverDigest(results, correctionKeys);

  // ── Nightly git commit: journal + container/skills/ (DISC-7) ──────────────
  // Single call, after all groups — one batched path-scoped commit per night.
  commitJournalAndSkills();

  lastRun = Date.now();
  log.info('promote: nightly promote pass complete', {
    groups: results.length,
    skillCandidates: results.reduce((s, r) => s + r.candidates.length, 0),
    lastRun,
  });
}

// ---------------------------------------------------------------------------
// Digest delivery (DISC-4)
// ---------------------------------------------------------------------------

async function deliverDigest(results: GroupResult[], correctionKeys: string[]): Promise<void> {
  const adapter = getDeliveryAdapter();
  if (!adapter) {
    log.warn('promote: delivery adapter not set — skipping digest');
    return;
  }

  // Pick the first reachable admin/owner DM (no group context — global admins only).
  const approvers = pickApprover(null);
  if (approvers.length === 0) {
    log.warn('promote: no approvers configured — skipping digest');
    return;
  }
  const target = await pickApprovalDelivery(approvers, '');
  if (!target) {
    log.warn('promote: no reachable DM for any approver — skipping digest');
    return;
  }

  const lines: string[] = ['**Madison self-improvement digest** (nightly promote pass)', ''];

  // Skills section.
  const allCandidates = results.flatMap((r) => r.candidates.map((c) => ({ ...c, folder: r.folder })));
  if (allCandidates.length > 0) {
    lines.push(`**Skills awaiting approval** (${allCandidates.length}):`);
    for (const c of allCandidates) {
      const evidence = (c.evidence_summary ?? '').replace(/\n/g, ' ').slice(0, 100);
      lines.push(`· \`${c.key}\` — ${c.name} | ${evidence} (group: ${c.folder})`);
    }
    lines.push('');
    lines.push(
      '_Approval: trigger a session and confirm via the propose_skill card. ' +
        'Session-bridge for host-cron approval is a pending enhancement._',
    );
  } else {
    lines.push('**Skills**: none ready for approval this cycle.');
  }
  lines.push('');

  // L1 re-rank section.
  const totalResident = results.reduce((s, r) => s + r.resident.length, 0);
  const totalDemoted = results.reduce((s, r) => s + r.demoted.length, 0);
  lines.push(`**L1 re-rank**: ${totalResident} resident, ${totalDemoted} demoted across ${results.length} group(s).`);
  for (const r of results) {
    if (r.demoted.length > 0) {
      lines.push(`· ${r.folder}: demoted [${r.demoted.join(', ')}]`);
    }
  }

  // Correction flags section.
  if (correctionKeys.length > 0) {
    lines.push('');
    lines.push(
      `**Correction flags** (last ${CORRECTION_LOOKBACK_DAYS} days — review for retirement): ` +
        correctionKeys.join(', '),
    );
  }

  const text = lines.join('\n');

  try {
    await adapter.deliver(
      target.messagingGroup.channel_type,
      target.messagingGroup.platform_id,
      null,
      'chat',
      JSON.stringify({ text }),
    );
    log.info('promote: digest delivered', {
      channelType: target.messagingGroup.channel_type,
      skillCandidates: allCandidates.length,
      totalResident,
      totalDemoted,
      corrections: correctionKeys.length,
    });
  } catch (err) {
    log.error('promote: digest delivery failed', { err });
  }
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/**
 * Find the most-recent skill candidate JSON for `key` in the given group's
 * proposals directory.
 *
 * Files are written by the online distiller at:
 *   <proposalsDir(folder)>/<session_id>/<key>-skill.json
 *
 * Scans one level of session subdirectories and returns the newest file by
 * mtime.  Returns null if no matching file exists or all candidates are
 * malformed.  Never throws.
 */
function findSkillCandidate(folder: string, key: string): SkillCandidate | null {
  const baseDir = proposalsDir(folder);
  if (!fs.existsSync(baseDir)) return null;

  const targetFile = `${key}-skill.json`;
  let latestCandidate: SkillCandidate | null = null;
  let latestMtime = 0;

  let sessionDirs: string[];
  try {
    sessionDirs = fs.readdirSync(baseDir);
  } catch {
    return null;
  }

  for (const sessionDir of sessionDirs) {
    const filePath = path.join(baseDir, sessionDir, targetFile);
    try {
      if (!fs.existsSync(filePath)) continue;
      const mtime = fs.statSync(filePath).mtimeMs;
      if (mtime <= latestMtime) continue;
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<SkillCandidate>;
      if (typeof raw.key === 'string' && typeof raw.name === 'string' && typeof raw.procedure === 'string') {
        latestCandidate = {
          key: raw.key,
          name: raw.name,
          procedure: raw.procedure,
          evidence_summary: raw.evidence_summary ?? '',
        };
        latestMtime = mtime;
      }
    } catch {
      // Skip malformed or unreadable files — never throw out of the scan.
    }
  }

  return latestCandidate;
}
