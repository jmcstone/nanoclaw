/**
 * Online distiller — runs ~5 min after a clean container close, then cancellable
 * if the session wakes again before the delay expires (SI-1).
 *
 * Per-session pass:
 *   1. Opens the self-improve DB (watermark + proposal_keys + helpfulness_events).
 *   2. Reads the distiller watermark (last-processed rowids for this session).
 *   3. Fetches new rows from inbound + outbound session DBs; builds a transcript.
 *      Returns early if no new rows.
 *   4. Recall-guard: queries the group's FTS recall DB so the model can
 *      deduplicate/extend rather than re-propose what is already known (SI-11).
 *   5. Calls gemini-3-flash-preview via the host LiteLLM client with a
 *      CONSERVATIVE system prompt (DISC-3).
 *   6. Facts → AUTO-APPLY (DISC-1/2): upsert keyed block into CLAUDE.local.md
 *      (atomic temp+rename); notify Jeff via delivery adapter (best-effort);
 *      append journal entry (DISC-7); insert helpfulness_events row. No git.
 *   7. Skills → increment session_count + write candidate JSON only (DISC-2).
 *      The nightly promote pass gates at session_count ≥ 2.
 *   8. Writes a ≤120-word 'summary' row into the recall DB (AC-9, recall-quality B).
 *   9. Advances the distiller watermark to the highest processed rowids.
 *
 * Every numbered step is wrapped in an independent try/catch so a failure in
 * one step never aborts the pass. DBs are closed in a top-level finally.
 *
 * Locked decisions: SI-1, SI-2, SI-11, DISC-1, DISC-2, DISC-3, DISC-4, DISC-7.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../../config.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';
import { callHostLiteLLM } from '../../litellm-host-client.js';
import {
  isSelfImproveEnabled,
  proposalsDir,
  recallDbPathForGroup,
  selfImproveDbPath,
} from '../../madison-extensions.js';
import { pickApprovalDelivery, pickApprover } from '../approvals/primitive.js';
import { SQL_FTS_DELETE, SQL_FTS_INSERT, ensureRecallSchema, openRecallDb } from '../../recall/schema.js';
import { inboundDbPath, outboundDbPath } from '../../session-manager.js';
import { appendJournal } from './journal.js';
import { SQL_HELPFULNESS_INSERT, SQL_WATERMARK_UPSERT, ensureSelfImproveSchema, openSelfImproveDb } from './schema.js';
import { checkTombstone, incrementSessionCount, upsertProposalKey } from './tombstone.js';
import type { Session } from '../../types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** LiteLLM alias for the online distiller pass (spike a9679bd — verified PASS). */
const DISTILLER_MODEL = 'gemini-3-flash-preview';

/** Delay from container close to distiller run — allows the session to cool off
 *  and be cancelled if the user continues the conversation. */
const DISTILL_DELAY_MS = 5 * 60 * 1000;

/** Maximum rows fetched per side (inbound / outbound) in a single pass. */
const MAX_ROWS_PER_SIDE = 200;

/** Maximum characters retained per message in the transcript. */
const MAX_CHARS_PER_MSG = 1000;

/** Maximum recall-guard excerpts included in the distiller prompt. */
const RECALL_GUARD_LIMIT = 8;

// ---------------------------------------------------------------------------
// Pending distills
// ---------------------------------------------------------------------------

const pendingDistills = new Map<string, NodeJS.Timeout>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Schedule a distill pass DISTILL_DELAY_MS after the container closes.
 *
 * Replaces any existing scheduled pass for this session so a session that
 * wakes and closes again resets the delay (SI-1 cancellable-delay pattern).
 */
export function scheduleDistill(session: Session, folder: string): void {
  if (!isSelfImproveEnabled(folder)) return;
  const existing = pendingDistills.get(session.id);
  if (existing !== undefined) {
    clearTimeout(existing);
  }
  const handle = setTimeout(() => void runDistillPass(session, folder), DISTILL_DELAY_MS);
  pendingDistills.set(session.id, handle);
  log.debug('distiller: scheduled', { sessionId: session.id, folder, delayMs: DISTILL_DELAY_MS });
}

/**
 * Cancel a pending distill pass (e.g. the session woke again before the delay
 * expired). No-op if nothing is scheduled for the given session.
 */
export function cancelScheduledDistill(sessionId: string): void {
  const handle = pendingDistills.get(sessionId);
  if (handle !== undefined) {
    clearTimeout(handle);
    pendingDistills.delete(sessionId);
    log.debug('distiller: cancelled', { sessionId });
  }
}

// ---------------------------------------------------------------------------
// Core distill pass
// ---------------------------------------------------------------------------

async function runDistillPass(session: Session, folder: string): Promise<void> {
  pendingDistills.delete(session.id);
  log.info('distiller: starting pass', { sessionId: session.id, folder });

  // DB handles declared at the top so the finally block always closes them.
  let siDb: Database.Database | null = null;
  let recallDb: Database.Database | null = null;
  // Session DBs are opened/closed within step 3; handles tracked here for safety.
  let inDb: Database.Database | null = null;
  let outDb: Database.Database | null = null;

  // State produced by each step and consumed by later ones.
  let cursorIn = 0;
  let cursorOut = 0;
  let maxRowidIn = 0;
  let maxRowidOut = 0;
  let transcript = '';
  let recallContext = '';
  let modelResponse = '';

  interface FactItem {
    key: string;
    content: string;
    type: string;
    pin: boolean;
  }
  interface SkillItem {
    key: string;
    name: string;
    procedure: string;
    evidence_summary: string;
  }
  let facts: FactItem[] = [];
  let skills: SkillItem[] = [];

  try {
    // ── Step 1: open self-improve DB ─────────────────────────────────────────
    try {
      siDb = openSelfImproveDb(selfImproveDbPath());
      ensureSelfImproveSchema(siDb);
    } catch (err) {
      log.error('distiller: step 1 — open self-improve DB', { sessionId: session.id, err });
      return; // Cannot proceed without the DB.
    }

    // ── Step 2: read distiller watermark ─────────────────────────────────────
    try {
      const wmRow = siDb
        .prepare('SELECT last_rowid_in, last_rowid_out FROM distiller_watermark WHERE session_id = ?')
        .get(session.id) as { last_rowid_in: number; last_rowid_out: number } | undefined;
      if (wmRow) {
        cursorIn = wmRow.last_rowid_in;
        cursorOut = wmRow.last_rowid_out;
      }
      maxRowidIn = cursorIn;
      maxRowidOut = cursorOut;
    } catch (err) {
      log.error('distiller: step 2 — read watermark', { sessionId: session.id, err });
      // Safe defaults (0); continue.
    }

    // ── Step 3: fetch new session rows; build transcript ─────────────────────
    try {
      const inPath = inboundDbPath(session.agent_group_id, session.id);
      const outPath = outboundDbPath(session.agent_group_id, session.id);

      const lines: string[] = [];

      // Inbound (user messages) — read-only, mirrors session-indexer.ts.
      if (fs.existsSync(inPath)) {
        inDb = new Database(inPath, { readonly: true });
        inDb.pragma('busy_timeout = 3000');
        const inRows = inDb
          .prepare(
            `SELECT rowid, id, timestamp, content FROM messages_in WHERE rowid > ? ORDER BY rowid LIMIT ${MAX_ROWS_PER_SIDE}`,
          )
          .all(cursorIn) as Array<{ rowid: number; id: string; timestamp: string; content: string }>;
        for (const row of inRows) {
          const text = extractText(row.content);
          if (text) lines.push(`[user] ${text.slice(0, MAX_CHARS_PER_MSG)}`);
          if (row.rowid > maxRowidIn) maxRowidIn = row.rowid;
        }
        inDb.close();
        inDb = null;
      }

      // Outbound (assistant messages) — read-only.
      if (fs.existsSync(outPath)) {
        outDb = new Database(outPath, { readonly: true });
        outDb.pragma('busy_timeout = 3000');
        const outRows = outDb
          .prepare(
            `SELECT rowid, id, timestamp, content FROM messages_out WHERE rowid > ? ORDER BY rowid LIMIT ${MAX_ROWS_PER_SIDE}`,
          )
          .all(cursorOut) as Array<{ rowid: number; id: string; timestamp: string; content: string }>;
        for (const row of outRows) {
          const text = extractText(row.content);
          if (text) lines.push(`[assistant] ${text.slice(0, MAX_CHARS_PER_MSG)}`);
          if (row.rowid > maxRowidOut) maxRowidOut = row.rowid;
        }
        outDb.close();
        outDb = null;
      }

      if (lines.length === 0) {
        log.debug('distiller: no new rows since last watermark — skipping', { sessionId: session.id });
        return; // Advance nothing; return triggers finally (DB cleanup).
      }

      transcript = lines.join('\n');
    } catch (err) {
      log.error('distiller: step 3 — read session rows', { sessionId: session.id, err });
    }

    // Early exit if transcript could not be built (step 3 threw).
    if (!transcript) return;

    // ── Step 4: recall-guard ─────────────────────────────────────────────────
    // Coarse filter: surface what's already indexed so the model can
    // deduplicate/extend rather than re-propose existing knowledge (SI-7/SI-11).
    try {
      recallDb = openRecallDb(recallDbPathForGroup(folder));
      ensureRecallSchema(recallDb);

      const keywords = extractKeywords(transcript);
      if (keywords) {
        const rows = recallDb
          .prepare(
            `SELECT role, snippet(session_fts, 5, '', '', '…', 20) AS snip ` +
              `FROM session_fts WHERE session_fts MATCH ? ORDER BY bm25(session_fts) LIMIT ${RECALL_GUARD_LIMIT}`,
          )
          .all(keywords) as Array<{ role: string; snip: string }>;
        if (rows.length > 0) {
          recallContext = rows.map((r) => `[${r.role}] ${r.snip}`).join('\n');
        }
      }
    } catch (err) {
      log.error('distiller: step 4 — recall-guard', { sessionId: session.id, err });
      // Continue without recall context — the model just won't have the dedup hint.
    }

    // ── Step 5: call the distiller model ─────────────────────────────────────
    try {
      const systemPrompt = [
        'You are a memory distiller for an AI assistant named Madison.',
        'Extract ONLY high-confidence, clearly-reusable, durable facts and procedures from the conversation.',
        '',
        'Rules (DISC-3 — CONSERVATIVE bar):',
        '- Prefer extracting NOTHING over speculating. Omit anything uncertain or one-off.',
        '- Facts must be explicitly stated by the user or clearly confirmed, not inferred.',
        '- Procedures must have been explicitly taught or described as reusable.',
        '- Do NOT re-propose facts present in the "Already known" section.',
        '- Keys: kebab-slug format [a-zA-Z0-9_-], descriptive, stable across sessions.',
        '- type ∈ user | feedback | project | reference | episodic',
        '- pin=true ONLY for correctness-critical identity/safety facts (e.g. name, safety constraints).',
        '',
        'Return ONLY a JSON object — no markdown fences, no explanation outside the JSON:',
        '{"facts":[{"key":"<slug>","content":"<text>","type":"<type>","pin":<bool>}],' +
          '"skills":[{"key":"<slug>","name":"<name>","procedure":"<steps>","evidence_summary":"<why>"}]}',
        'Return {"facts":[],"skills":[]} if nothing qualifies.',
      ].join('\n');

      const userContent =
        (recallContext ? `Already known (do NOT re-propose):\n${recallContext}\n\n` : '') +
        `Conversation transcript:\n${transcript}`;

      modelResponse = await callHostLiteLLM(DISTILLER_MODEL, [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ]);
    } catch (err) {
      log.error('distiller: step 5 — LiteLLM call', { sessionId: session.id, err });
    }

    // Parse model response defensively — the model may wrap the JSON in markdown.
    if (modelResponse) {
      try {
        const jsonMatch = modelResponse.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]) as { facts?: unknown[]; skills?: unknown[] };
          if (Array.isArray(parsed.facts)) {
            facts = parsed.facts.filter(
              (f): f is FactItem =>
                f !== null &&
                typeof f === 'object' &&
                typeof (f as Record<string, unknown>).key === 'string' &&
                typeof (f as Record<string, unknown>).content === 'string',
            );
          }
          if (Array.isArray(parsed.skills)) {
            skills = parsed.skills.filter(
              (s): s is SkillItem =>
                s !== null && typeof s === 'object' && typeof (s as Record<string, unknown>).key === 'string',
            );
          }
        }
      } catch (err) {
        log.error('distiller: step 5 — parse model response', {
          sessionId: session.id,
          snippet: modelResponse.slice(0, 200),
          err,
        });
      }
    }

    // ── Step 6: facts — AUTO-APPLY (DISC-1/2) ────────────────────────────────
    // Each fact is processed independently so one failure doesn't block the rest.
    for (const fact of facts) {
      try {
        if (!isValidSlug(fact.key)) {
          log.warn('distiller: step 6 — invalid fact key, skipping', { key: fact.key });
          continue;
        }
        if (checkTombstone(siDb, fact.key)) {
          log.debug('distiller: step 6 — tombstoned, skipping', { key: fact.key });
          continue;
        }

        // Write proposal JSON (audit trail, readable by the nightly pass).
        const propDir = path.join(proposalsDir(folder), session.id);
        fs.mkdirSync(propDir, { recursive: true });
        const propPath = path.join(propDir, `${fact.key}.json`);
        fs.writeFileSync(
          propPath,
          JSON.stringify({ ...fact, session_id: session.id, ts: new Date().toISOString() }, null, 2),
        );

        // Record key in DB so the nightly pass and dedup logic can find it.
        upsertProposalKey(siDb, fact.key, propPath);

        // Upsert keyed block into CLAUDE.local.md (atomic write — DISC-1).
        const claudeLocalPath = path.join(GROUPS_DIR, folder, 'CLAUDE.local.md');
        upsertKeyedBlock(claudeLocalPath, fact.key, fact.content, fact.pin === true);

        // Notify Jeff — best-effort; errors are swallowed (DISC-2/DISC-4).
        try {
          const adapter = getDeliveryAdapter();
          if (adapter) {
            const approvers = pickApprover(session.agent_group_id);
            if (approvers.length > 0) {
              const target = await pickApprovalDelivery(approvers, '');
              if (target) {
                const shortContent = fact.content.replace(/\n/g, ' ').slice(0, 80);
                await adapter.deliver(
                  target.messagingGroup.channel_type,
                  target.messagingGroup.platform_id,
                  null,
                  'chat',
                  JSON.stringify({ text: `🧠 learned: ${fact.key} — ${shortContent}` }),
                );
              }
            }
          }
        } catch (notifyErr) {
          log.warn('distiller: step 6 — notify failed (best-effort, continuing)', {
            key: fact.key,
            err: notifyErr,
          });
        }

        // Append to git-tracked journal (DISC-7).
        appendJournal('fact-add', fact.key, fact.content, `${folder}/${session.id}`);

        // Helpfulness event — corroborated = first observation of this fact.
        siDb.prepare(SQL_HELPFULNESS_INSERT).run(fact.key, 'corroborated', session.id, new Date().toISOString());

        log.info('distiller: step 6 — fact applied', { key: fact.key, folder });
      } catch (err) {
        log.error('distiller: step 6 — fact failed', { key: fact.key, sessionId: session.id, err });
      }
    }

    // ── Step 7: skills — session_count + candidate JSON (DISC-2) ─────────────
    // NO approval here. The nightly promote pass gates at session_count ≥ 2.
    for (const skill of skills) {
      try {
        if (!isValidSlug(skill.key)) {
          log.warn('distiller: step 7 — invalid skill key, skipping', { key: skill.key });
          continue;
        }
        if (checkTombstone(siDb, skill.key)) {
          log.debug('distiller: step 7 — tombstoned, skipping', { key: skill.key });
          continue;
        }

        incrementSessionCount(siDb, skill.key);

        const propDir = path.join(proposalsDir(folder), session.id);
        fs.mkdirSync(propDir, { recursive: true });
        const propPath = path.join(propDir, `${skill.key}-skill.json`);
        fs.writeFileSync(
          propPath,
          JSON.stringify({ ...skill, session_id: session.id, ts: new Date().toISOString() }, null, 2),
        );

        log.debug('distiller: step 7 — skill candidate saved', { key: skill.key, folder });
      } catch (err) {
        log.error('distiller: step 7 — skill candidate failed', { key: skill.key, sessionId: session.id, err });
      }
    }

    // ── Step 8: distiller summary → recall (AC-9) ────────────────────────────
    // Insert a 'summary' row so future recall searches surface what was distilled.
    try {
      // Re-open recallDb if step 4 failed.
      if (!recallDb) {
        recallDb = openRecallDb(recallDbPathForGroup(folder));
        ensureRecallSchema(recallDb);
      }
      const localRecallDb = recallDb; // Capture for use inside transaction.

      const factKeys = facts.map((f) => f.key).join(', ');
      const skillKeys = skills.map((s) => s.key).join(', ');
      const summaryParts: string[] = [];
      if (factKeys) summaryParts.push(`Facts extracted: ${factKeys}`);
      if (skillKeys) summaryParts.push(`Skill candidates: ${skillKeys}`);
      if (summaryParts.length === 0) summaryParts.push('Distiller pass: no extractable facts or skills.');
      const summaryContent = summaryParts.join('. ').slice(0, 600); // ≤120 words approx.

      const summaryMsgId = `${session.id}:summary`;
      const now = new Date().toISOString();

      // Delete-before-insert for idempotency (same session may be re-distilled).
      localRecallDb.transaction(() => {
        localRecallDb.prepare(SQL_FTS_DELETE).run(summaryMsgId);
        localRecallDb.prepare(SQL_FTS_INSERT).run(summaryMsgId, session.id, folder, now, 'summary', summaryContent);
      })();

      log.debug('distiller: step 8 — summary written to recall DB', { sessionId: session.id });
    } catch (err) {
      log.error('distiller: step 8 — recall summary insert', { sessionId: session.id, err });
    }

    // ── Step 9: advance watermark ─────────────────────────────────────────────
    try {
      if (maxRowidIn > cursorIn || maxRowidOut > cursorOut) {
        siDb.prepare(SQL_WATERMARK_UPSERT).run(session.id, maxRowidIn, maxRowidOut);
        log.debug('distiller: step 9 — watermark advanced', { sessionId: session.id, maxRowidIn, maxRowidOut });
      }
    } catch (err) {
      log.error('distiller: step 9 — advance watermark', { sessionId: session.id, err });
    }

    log.info('distiller: pass complete', {
      sessionId: session.id,
      folder,
      facts: facts.length,
      skills: skills.length,
    });
  } finally {
    // Always close — never leak handles even if a step threw above the return.
    try {
      siDb?.close();
    } catch {
      /* ignore */
    }
    try {
      recallDb?.close();
    } catch {
      /* ignore */
    }
    try {
      inDb?.close();
    } catch {
      /* ignore */
    }
    try {
      outDb?.close();
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// CLAUDE.local.md keyed-block upsert (DISC-1 — write-only, atomic)
// ---------------------------------------------------------------------------

/**
 * Upsert a keyed fact block into CLAUDE.local.md.
 *
 * Block format (must match l1-lifecycle.ts KEY_BLOCK_RE exactly):
 *   <!-- key:<key> [pin] -->
 *   <content>
 *   <!-- /key -->
 *
 * If a block with the given key already exists, it is replaced in-place.
 * Otherwise the new block is appended. Write is atomic: temp file + rename
 * (fs.renameSync is atomic on Linux for same-filesystem moves).
 *
 * Creates the parent directory if absent (e.g. groups/<folder>/ on first use).
 */
function upsertKeyedBlock(filePath: string, key: string, content: string, pin: boolean): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  let existing = '';
  try {
    existing = fs.readFileSync(filePath, 'utf8');
  } catch {
    // File doesn't exist yet — start fresh.
  }

  const pinMark = pin ? ' pin' : '';
  // Ensure content ends with a newline so the closing tag is on its own line.
  const body = content.endsWith('\n') ? content : content + '\n';
  const newBlock = `<!-- key:${key}${pinMark} -->\n${body}<!-- /key -->\n`;

  // Match the same pattern as l1-lifecycle.ts KEY_BLOCK_RE (without the 'g' flag
  // for the test, then reset and replace).
  const keyPattern = new RegExp(`<!-- key:${escapeRegex(key)}(?:\\s+pin)?\\s*-->[\\s\\S]*?<!-- \\/key -->\\n?`, 'g');

  let updated: string;
  if (keyPattern.test(existing)) {
    keyPattern.lastIndex = 0; // reset after .test()
    updated = existing.replace(keyPattern, newBlock);
  } else {
    // Append — ensure a blank separator if the file doesn't end with a newline.
    updated = existing.length > 0 && !existing.endsWith('\n') ? existing + '\n' + newBlock : existing + newBlock;
  }

  // Atomic write: temp file in the same directory, then rename.
  const tmpPath = `${filePath}.tmp-distill-${process.pid}`;
  try {
    fs.writeFileSync(tmpPath, updated, 'utf8');
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* ignore cleanup failure */
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract indexable plain text from a session message content JSON blob.
 *
 * Mirrors session-indexer.ts extractText — same field priority so the distiller
 * and the FTS index agree on what "the text" is for a given message.
 */
function extractText(contentStr: string): string {
  try {
    const parsed = JSON.parse(contentStr) as Record<string, unknown>;
    if (typeof parsed.text === 'string' && parsed.text) return parsed.text;
    if (typeof parsed.markdown === 'string' && parsed.markdown) return parsed.markdown;
    if (typeof parsed.content === 'string' && parsed.content) return parsed.content;
  } catch {
    const trimmed = contentStr.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

/**
 * Extract a coarse keyword query from a transcript for the recall-guard FTS search.
 *
 * Returns up to 8 significant words from the first user turns joined with ' OR '
 * so FTS5 returns any matching excerpt (broad recall). Returns '' if the
 * transcript has no usable content — the caller skips the FTS query in that case.
 */
function extractKeywords(transcript: string): string {
  const STOPWORDS = new Set([
    'the',
    'a',
    'an',
    'and',
    'or',
    'but',
    'in',
    'on',
    'at',
    'to',
    'for',
    'of',
    'with',
    'by',
    'from',
    'is',
    'it',
    'was',
    'are',
    'be',
    'been',
    'have',
    'has',
    'had',
    'do',
    'does',
    'did',
    'will',
    'would',
    'could',
    'should',
    'may',
    'might',
    'can',
    'that',
    'this',
    'these',
    'those',
    'i',
    'you',
    'he',
    'she',
    'we',
    'they',
    'me',
    'him',
    'her',
    'us',
    'them',
    'my',
    'your',
    'his',
    'our',
    'their',
    'what',
    'which',
    'who',
    'how',
    'when',
    'where',
    'why',
    'user',
    'assistant',
  ]);

  const words = transcript
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOPWORDS.has(w));

  const seen = new Set<string>();
  const keywords: string[] = [];
  for (const w of words) {
    if (!seen.has(w)) {
      seen.add(w);
      keywords.push(w);
      if (keywords.length >= 8) break;
    }
  }

  return keywords.join(' OR ');
}

/** Validate that a key matches the allowed slug charset [a-zA-Z0-9_-]. */
function isValidSlug(key: string): boolean {
  return typeof key === 'string' && /^[a-zA-Z0-9_-]+$/.test(key);
}

/** Escape a string for safe use as a literal in a RegExp. */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
