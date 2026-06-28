/**
 * L1 unified-pool budget re-rank — the "L1 = budgeted cache" model.
 *
 * SI-3: L1 = hot cache, L2 = cold store. Demotion = move to L2, never delete.
 * SI-4: One scored pool re-ranked nightly against a token budget (~1–2k tokens).
 *        Above the line = resident; below = L2-recall-only.
 * SI-5: Evidence in `helpfulness_events` drives the score.
 * SI-6: `pin` marker + unkeyed preamble are always resident (correctness-critical).
 *
 * CLAUDE.local.md keyed-fact format
 * ──────────────────────────────────
 * Content above the first keyed block is "unkeyed" — preserved verbatim at the
 * top, treated as pinned, never touched by this module.
 *
 * Regular keyed block:
 *   <!-- key:my-fact-slug -->
 *   Fact text here (may span multiple lines).
 *   <!-- /key -->
 *
 * Pinned keyed block (exempt from frequency eviction):
 *   <!-- key:my-fact-slug pin -->
 *   Correctness-critical content.
 *   <!-- /key -->
 *
 * The Wave-4 approval handler that WRITES new facts must use these exact
 * delimiters so that this parser picks them up correctly.
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../../config.js';
import { log } from '../../log.js';
import { selfImproveDbPath } from '../../madison-extensions.js';
import { appendJournal } from './journal.js';
import { ensureSelfImproveSchema, openSelfImproveDb } from './schema.js';

// ---------------------------------------------------------------------------
// Tunable constants — adjust as evidence accumulates
// ---------------------------------------------------------------------------

/** A `corrected` helpfulness event penalises the fact this many score points. */
const CORRECTION_PENALTY = 3;

/**
 * Half-life in days for the recency score contribution.
 * recencyWeight = exp(−ln2 × ageDays / RECENCY_HALF_LIFE_DAYS)
 * → 1.0 at age 0, 0.5 at RECENCY_HALF_LIFE_DAYS, → 0 as age → ∞.
 */
const RECENCY_HALF_LIFE_DAYS = 30;

/**
 * Age in days (since the newest helpfulness event) above which a flat
 * staleness penalty is applied.  A key with no events is treated as
 * maximally stale.
 */
const STALENESS_THRESHOLD_DAYS = 60;

/** Flat score penalty when the newest event age exceeds STALENESS_THRESHOLD_DAYS. */
const STALENESS_PENALTY = 2;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single row from `helpfulness_events` as needed by the scorer. */
export type HelpfulnessEvent = { key: string; event: string; ts: string };

type ParsedBlock = {
  key: string;
  pinned: boolean;
  /** Raw text between the opening and closing tags (including surrounding newlines). */
  content: string;
};

type ParsedFile = {
  /** Content before the first keyed block — preserved verbatim, treated as pinned. */
  unkeyed: string;
  blocks: ParsedBlock[];
};

// ---------------------------------------------------------------------------
// scorePool
// ---------------------------------------------------------------------------

/**
 * Score every key present in `events` and return a Map<key, score>.
 *
 *   score = (recencyWeight + corroborations + recallHits)
 *           − (corrections × CORRECTION_PENALTY + stalenessPenalty)
 *
 * recencyWeight   — exponential decay on the age of the newest event (range 0..1).
 * corroborations  — count of 'corroborated' events (independently confirmed).
 * recallHits      — count of 'recall-hit' events (looked up from L2 during a session).
 * corrections     — count of 'corrected' events (user flagged as wrong).
 * stalenessPenalty — STALENESS_PENALTY when newest event age > STALENESS_THRESHOLD_DAYS.
 *
 * Keys absent from `events` are not present in the returned map (caller
 * should treat missing keys as score 0).
 */
export function scorePool(events: HelpfulnessEvent[]): Map<string, number> {
  // Group events by key.
  const byKey = new Map<string, HelpfulnessEvent[]>();
  for (const e of events) {
    let bucket = byKey.get(e.key);
    if (!bucket) {
      bucket = [];
      byKey.set(e.key, bucket);
    }
    bucket.push(e);
  }

  const scores = new Map<string, number>();
  const now = Date.now();

  for (const [key, evts] of byKey) {
    let corroborations = 0;
    let recallHits = 0;
    let corrections = 0;
    let newestTs = 0; // epoch ms; 0 = no valid timestamp found

    for (const e of evts) {
      const ts = Date.parse(e.ts);
      if (!isNaN(ts) && ts > newestTs) newestTs = ts;

      switch (e.event) {
        case 'corroborated':
          corroborations++;
          break;
        case 'recall-hit':
          recallHits++;
          break;
        case 'corrected':
          corrections++;
          break;
        // 'used' and 'stale' are recorded in the ledger but not yet scored here;
        // add weighting when there is enough data to calibrate.
      }
    }

    // Recency: exponential decay. No events → ageDays = Infinity → weight = 0.
    const ageDays = newestTs > 0 ? (now - newestTs) / (1000 * 60 * 60 * 24) : Infinity;
    const recencyWeight = ageDays === Infinity ? 0 : Math.exp((-Math.LN2 * ageDays) / RECENCY_HALF_LIFE_DAYS);

    // Staleness flat penalty for facts that have gone untouched for a long time.
    const stalenessPenalty = ageDays === Infinity || ageDays > STALENESS_THRESHOLD_DAYS ? STALENESS_PENALTY : 0;

    const score = recencyWeight + corroborations + recallHits - corrections * CORRECTION_PENALTY - stalenessPenalty;

    scores.set(key, score);
  }

  return scores;
}

// ---------------------------------------------------------------------------
// CLAUDE.local.md parser / serialiser
// ---------------------------------------------------------------------------

/**
 * Match keyed fact blocks in CLAUDE.local.md.
 *
 * Opening tag: `<!-- key:<slug> -->` or `<!-- key:<slug> pin -->`
 * Closing tag: `<!-- /key -->`
 *
 * Capture groups: 1 = slug, 2 = ' pin' (or undefined), 3 = block content.
 */
const KEY_BLOCK_RE = /<!-- key:([a-zA-Z0-9_-]+)(\s+pin)?\s*-->([\s\S]*?)<!-- \/key -->/g;

function parseClaudeLocal(text: string): ParsedFile {
  const firstKeyIdx = text.indexOf('<!-- key:');
  // Everything before the first keyed block is unkeyed — always preserved.
  const unkeyed = firstKeyIdx === -1 ? text : text.slice(0, firstKeyIdx);

  const blocks: ParsedBlock[] = [];
  KEY_BLOCK_RE.lastIndex = 0; // reset before reuse
  let m: RegExpExecArray | null;
  while ((m = KEY_BLOCK_RE.exec(text)) !== null) {
    blocks.push({
      key: m[1],
      pinned: m[2] !== undefined && m[2].trim() === 'pin',
      content: m[3],
    });
  }

  return { unkeyed, blocks };
}

function serializeBlock(block: ParsedBlock): string {
  const pinMark = block.pinned ? ' pin' : '';
  // Ensure the closing tag is on its own line even if content lacks a trailing newline.
  const content = block.content.endsWith('\n') ? block.content : block.content + '\n';
  return `<!-- key:${block.key}${pinMark} -->${content}<!-- /key -->\n`;
}

// ---------------------------------------------------------------------------
// reRankL1
// ---------------------------------------------------------------------------

/**
 * Re-rank the keyed fact pool in `groups/<folder>/CLAUDE.local.md` against
 * `tokenBudget` (token estimate = Math.ceil(text.length / 4)).
 *
 * Algorithm:
 *   1. Read CLAUDE.local.md; parse unkeyed preamble + keyed blocks.
 *   2. Query `helpfulness_events` for the keys present in the file.
 *   3. Score via `scorePool`; pinned facts are always resident.
 *   4. Sort non-pinned facts by score (desc) and greedily admit until budget.
 *   5. Rewrite CLAUDE.local.md atomically: preamble + resident blocks.
 *   6. Journal each eviction via `appendJournal('fact-evict', ...)`.
 *   7. Return `{ resident, demoted }` key lists for the caller to log.
 *
 * Demoted facts are NOT deleted from history — they remain in the recall DB
 * (L2) and in `helpfulness_events`.  A demoted fact whose score recovers is
 * re-added by the distiller on its next pass (same re-rank, no special path).
 *
 * Never throws for a missing or garbled CLAUDE.local.md — logs and returns
 * empty lists so the nightly cron continues with the next group.
 */
export function reRankL1(folder: string, tokenBudget: number): { resident: string[]; demoted: string[] } {
  const localMdPath = path.join(GROUPS_DIR, folder, 'CLAUDE.local.md');

  // Step 1: Read + parse.
  let parsed: ParsedFile;
  try {
    const raw = fs.existsSync(localMdPath) ? fs.readFileSync(localMdPath, 'utf8') : '';
    parsed = parseClaudeLocal(raw);
  } catch (err) {
    log.error('l1-lifecycle: failed to read/parse CLAUDE.local.md', { folder, err });
    return { resident: [], demoted: [] };
  }

  if (parsed.blocks.length === 0) {
    // File is empty or entirely unkeyed — nothing to rank.
    return { resident: [], demoted: [] };
  }

  // Step 2: Query helpfulness events for the keys present in this file.
  let events: HelpfulnessEvent[] = [];
  try {
    const db = openSelfImproveDb(selfImproveDbPath());
    ensureSelfImproveSchema(db);

    const keys = parsed.blocks.map((b) => b.key);
    if (keys.length > 0) {
      const placeholders = keys.map(() => '?').join(',');
      events = db
        .prepare(`SELECT key, event, ts FROM helpfulness_events WHERE key IN (${placeholders})`)
        .all(...keys) as HelpfulnessEvent[];
    }

    db.close();
  } catch (err) {
    log.error('l1-lifecycle: failed to query helpfulness_events', { folder, err });
    // Continue — facts with no events score 0 and compete on budget alone.
  }

  // Step 3: Score the pool.
  const scores = scorePool(events);

  // Step 4: Partition and rank.
  // Pinned blocks are always resident; non-pinned compete for the remaining budget.
  const pinnedBlocks = parsed.blocks.filter((b) => b.pinned);
  const scoredBlocks = parsed.blocks
    .filter((b) => !b.pinned)
    .sort((a, b) => (scores.get(b.key) ?? 0) - (scores.get(a.key) ?? 0)); // desc by score

  // Seed token usage with the unkeyed preamble + pinned blocks (always in).
  const pinnedText = parsed.unkeyed + pinnedBlocks.map(serializeBlock).join('');
  let usedTokens = Math.ceil(pinnedText.length / 4);

  const residentScored: ParsedBlock[] = [];
  const demotedBlocks: ParsedBlock[] = [];

  for (const block of scoredBlocks) {
    const blockTokens = Math.ceil(serializeBlock(block).length / 4);
    if (usedTokens + blockTokens <= tokenBudget) {
      residentScored.push(block);
      usedTokens += blockTokens;
    } else {
      demotedBlocks.push(block);
    }
  }

  // Step 5: Atomic rewrite — preamble + pinned + resident scored.
  const residentBlocks = [...pinnedBlocks, ...residentScored];
  const newContent = parsed.unkeyed + residentBlocks.map(serializeBlock).join('');

  try {
    const tmp = `${localMdPath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, newContent, 'utf8');
    fs.renameSync(tmp, localMdPath);
  } catch (err) {
    log.error('l1-lifecycle: failed to atomically rewrite CLAUDE.local.md', { folder, err });
    return { resident: [], demoted: [] };
  }

  // Step 6: Journal each eviction.
  for (const block of demotedBlocks) {
    appendJournal('fact-evict', block.key, 'below L1 budget', folder);
  }

  // Step 7: Return key lists for the caller to log.
  return {
    resident: residentBlocks.map((b) => b.key),
    demoted: demotedBlocks.map((b) => b.key),
  };
}
