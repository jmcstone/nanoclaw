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
  resolveGroupLitellmKey,
  selfImproveDbPath,
} from '../../madison-extensions.js';
import { extractText } from '../../message-utils.js';
import { pickApprovalDelivery, pickApprover } from '../approvals/primitive.js';
import { SQL_FTS_DELETE, SQL_FTS_INSERT, ensureRecallSchema, openRecallDb } from '../../recall/schema.js';
import { inboundDbPath, outboundDbPath } from '../../session-manager.js';
import { appendJournal } from './journal.js';
import { SQL_HELPFULNESS_INSERT, SQL_WATERMARK_UPSERT, ensureSelfImproveSchema, openSelfImproveDb } from './schema.js';
import type { FactItem, SkillItem } from './schema.js';
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

/** Busy-timeout for inbound/outbound session DBs (read-only; shorter than self-improve DB). */
const SESSION_DB_BUSY_TIMEOUT_MS = 3000;

/** Maximum characters in a fact-notify preview sent to the user. */
const NOTIFY_PREVIEW_CHARS = 80;

/** Maximum characters in the distiller summary written to the recall DB (≈120 words). */
const DISTILL_SUMMARY_MAX_CHARS = 600;

/** Minimum word length to include in the recall-guard keyword query. */
const MIN_KEYWORD_LENGTH = 3;

/** Maximum number of keyword terms in the recall-guard FTS query. */
const MAX_KEYWORD_TERMS = 8;

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
  // Remove the map entry immediately (not on completion) so we don't hold a reference
  // to a completed timer. Note: if cancelScheduledDistill is called after this point,
  // the cancel is a no-op — this pass runs to completion regardless. This is the
  // accepted in-flight gap for the SI-1 cancellable-delay pattern.
  pendingDistills.delete(session.id);
  log.info('distiller: starting pass', { sessionId: session.id, folder });

  // Only siDb needs a top-level declaration; recallDb is managed inside the
  // helper functions (buildRecallContext, writeRecallSummary) that own it.
  let siDb: Database.Database | null = null;

  // State produced by each step and consumed by later ones.
  let cursorIn = 0;
  let cursorOut = 0;
  let maxRowidIn = 0;
  let maxRowidOut = 0;
  let transcript = '';

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
      const transcriptResult = buildTranscript(session, cursorIn, cursorOut);
      if (transcriptResult === null) {
        log.debug('distiller: no new rows since last watermark — skipping', { sessionId: session.id });
        return;
      }
      transcript = transcriptResult.transcript;
      maxRowidIn = transcriptResult.maxRowidIn;
      maxRowidOut = transcriptResult.maxRowidOut;
    } catch (err) {
      log.error('distiller: step 3 — read session rows', { sessionId: session.id, err });
    }
    if (!transcript) return;

    // ── Step 4: recall-guard ─────────────────────────────────────────────────
    // Coarse filter: surface what's already indexed so the model can
    // deduplicate/extend rather than re-propose existing knowledge (SI-7/SI-11).
    const recallContext = buildRecallContext(folder, transcript);

    // ── Step 5: call the distiller model ─────────────────────────────────────
    let modelResponse = '';
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

      // Per-group key for spend attribution; undefined → callHostLiteLLM falls back to LITELLM_HOST_API_KEY.
      modelResponse = await callHostLiteLLM(
        DISTILLER_MODEL,
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
        { apiKey: resolveGroupLitellmKey(folder) },
      );
    } catch (err) {
      log.error('distiller: step 5 — LiteLLM call', { sessionId: session.id, err });
    }
    const { facts, skills } = parseDistillerResponse(modelResponse, session.id);

    // ── Step 6: facts — AUTO-APPLY (DISC-1/2) ────────────────────────────────
    // Each fact is processed independently so one failure doesn't block the rest.
    for (const fact of facts) {
      try {
        await applyFact(siDb!, fact, folder, session);
      } catch (err) {
        log.error('distiller: step 6 — fact failed', { key: fact.key, sessionId: session.id, err });
      }
    }

    // ── Step 7: skills — session_count + candidate JSON (DISC-2) ─────────────
    // NO approval here. The nightly promote pass gates at session_count ≥ 2.
    for (const skill of skills) {
      try {
        saveSkillCandidate(siDb!, skill, folder, session.id);
      } catch (err) {
        log.error('distiller: step 7 — skill candidate failed', { key: skill.key, sessionId: session.id, err });
      }
    }

    // ── Step 8: distiller summary → recall (AC-9) ────────────────────────────
    // Insert a 'summary' row so future recall searches surface what was distilled.
    writeRecallSummary(folder, session, facts, skills);

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
    // recallDb is managed inside buildRecallContext / writeRecallSummary — only
    // siDb needs cleanup here.
    try {
      siDb?.close();
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
  // Strip any embedded closing delimiter — prevents a hostile LLM response from
  // injecting extra blocks (including pinned ones) into CLAUDE.local.md.
  const safeContent = content.replace(/<!--\s*\/key\s*-->/gi, '');
  // Ensure content ends with a newline so the closing tag is on its own line.
  const body = safeContent.endsWith('\n') ? safeContent : safeContent + '\n';
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
 * Best-effort notification that a fact was auto-applied to CLAUDE.local.md.
 * Uses the delivery adapter (DISC-4) so no channel API is imported here.
 * Never throws — delivery failures are logged and suppressed so they cannot
 * interrupt the distiller's fact-apply loop.
 */
async function notifyFactLearned(agentGroupId: string, key: string, content: string): Promise<void> {
  try {
    const adapter = getDeliveryAdapter();
    if (!adapter) return;
    const approvers = pickApprover(agentGroupId);
    if (approvers.length === 0) return;
    const target = await pickApprovalDelivery(approvers, '');
    if (!target) return;
    const shortContent = content.replace(/\n/g, ' ').slice(0, NOTIFY_PREVIEW_CHARS);
    await adapter.deliver(
      target.messagingGroup.channel_type,
      target.messagingGroup.platform_id,
      null,
      'chat',
      JSON.stringify({ text: `🧠 learned: ${key} — ${shortContent}` }),
    );
  } catch (err) {
    log.warn('distiller: notifyFactLearned failed (best-effort, continuing)', { key, err });
  }
}

// ---------------------------------------------------------------------------
// Extracted helpers for runDistillPass
// ---------------------------------------------------------------------------

/**
 * Build the conversation transcript for a distiller pass.
 *
 * Opens the inbound and outbound session DBs (read-only), fetches rows since
 * the given cursors, and extracts text from each message.  Closes both handles
 * before returning.
 *
 * Returns null if no new rows exist since the watermark.  Never throws — the
 * caller's try/catch at step 3 handles errors.
 */
function buildTranscript(
  session: Session,
  cursorIn: number,
  cursorOut: number,
): { transcript: string; maxRowidIn: number; maxRowidOut: number } | null {
  const inPath = inboundDbPath(session.agent_group_id, session.id);
  const outPath = outboundDbPath(session.agent_group_id, session.id);
  const lines: string[] = [];
  let maxRowidIn = cursorIn;
  let maxRowidOut = cursorOut;

  let inDb: Database.Database | null = null;
  let outDb: Database.Database | null = null;
  try {
    if (fs.existsSync(inPath)) {
      inDb = new Database(inPath, { readonly: true });
      inDb.pragma(`busy_timeout = ${SESSION_DB_BUSY_TIMEOUT_MS}`);
      const inRows = inDb
        .prepare(`SELECT rowid, content FROM messages_in WHERE rowid > ? ORDER BY rowid LIMIT ${MAX_ROWS_PER_SIDE}`)
        .all(cursorIn) as Array<{ rowid: number; content: string }>;
      for (const row of inRows) {
        const text = extractText(row.content);
        if (text) lines.push(`[user] ${text.slice(0, MAX_CHARS_PER_MSG)}`);
        if (row.rowid > maxRowidIn) maxRowidIn = row.rowid;
      }
      inDb.close();
      inDb = null;
    }

    if (fs.existsSync(outPath)) {
      outDb = new Database(outPath, { readonly: true });
      outDb.pragma(`busy_timeout = ${SESSION_DB_BUSY_TIMEOUT_MS}`);
      const outRows = outDb
        .prepare(`SELECT rowid, content FROM messages_out WHERE rowid > ? ORDER BY rowid LIMIT ${MAX_ROWS_PER_SIDE}`)
        .all(cursorOut) as Array<{ rowid: number; content: string }>;
      for (const row of outRows) {
        const text = extractText(row.content);
        if (text) lines.push(`[assistant] ${text.slice(0, MAX_CHARS_PER_MSG)}`);
        if (row.rowid > maxRowidOut) maxRowidOut = row.rowid;
      }
      outDb.close();
      outDb = null;
    }
  } finally {
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

  if (lines.length === 0) return null;
  return { transcript: lines.join('\n'), maxRowidIn, maxRowidOut };
}

/**
 * Apply a single distilled fact: write the proposal JSON, upsert the keyed
 * block into CLAUDE.local.md, notify, journal, and record a helpfulness event.
 *
 * Operates independently — each call is wrapped in a try/catch in the caller
 * so a failure in one fact does not block the rest.  Never throws.
 */
async function applyFact(siDb: Database.Database, fact: FactItem, folder: string, session: Session): Promise<void> {
  if (!isValidSlug(fact.key)) {
    log.warn('distiller: step 6 — invalid fact key, skipping', { key: fact.key });
    return;
  }
  if (checkTombstone(siDb, fact.key)) {
    log.debug('distiller: step 6 — tombstoned, skipping', { key: fact.key });
    return;
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

  // Notify Jeff — best-effort (DISC-2/DISC-4).
  await notifyFactLearned(session.agent_group_id, fact.key, fact.content);

  // Append to git-tracked journal (DISC-7).
  appendJournal('fact-add', fact.key, fact.content, `${folder}/${session.id}`);

  // Helpfulness event — corroborated = first observation of this fact.
  siDb.prepare(SQL_HELPFULNESS_INSERT).run(fact.key, 'corroborated', session.id, new Date().toISOString());

  log.info('distiller: step 6 — fact applied', { key: fact.key, folder });
}

/**
 * Record a single distilled skill candidate: increment the session_count
 * in the proposal_keys table and write the candidate JSON for the nightly pass.
 *
 * Skills are NOT applied immediately — the nightly promote pass gates at
 * session_count ≥ 2 (DISC-2).  Never throws.
 */
function saveSkillCandidate(siDb: Database.Database, skill: SkillItem, folder: string, sessionId: string): void {
  if (!isValidSlug(skill.key)) {
    log.warn('distiller: step 7 — invalid skill key, skipping', { key: skill.key });
    return;
  }
  if (checkTombstone(siDb, skill.key)) {
    log.debug('distiller: step 7 — tombstoned, skipping', { key: skill.key });
    return;
  }

  incrementSessionCount(siDb, skill.key);

  const propDir = path.join(proposalsDir(folder), sessionId);
  fs.mkdirSync(propDir, { recursive: true });
  const propPath = path.join(propDir, `${skill.key}-skill.json`);
  fs.writeFileSync(
    propPath,
    JSON.stringify({ ...skill, session_id: sessionId, ts: new Date().toISOString() }, null, 2),
  );

  log.debug('distiller: step 7 — skill candidate saved', { key: skill.key, folder });
}

/**
 * Query the recall DB for coarse FTS keyword matches against the transcript.
 *
 * Returns recall-guard excerpts for inclusion in the distiller prompt so the
 * model can de-duplicate/extend rather than re-propose already-known facts
 * (SI-7/SI-11).  Returns an empty string when the DB is absent, unreadable, or
 * the query produces no results.
 *
 * Manages its own DB handle.  Never throws.
 */
function buildRecallContext(folder: string, transcript: string): string {
  let recallDb: Database.Database | null = null;
  try {
    recallDb = openRecallDb(recallDbPathForGroup(folder));
    ensureRecallSchema(recallDb);

    const keywords = extractKeywords(transcript);
    if (!keywords) return '';

    const rows = recallDb
      .prepare(
        `SELECT role, snippet(session_fts, 5, '', '', '…', 20) AS snip ` +
          `FROM session_fts WHERE session_fts MATCH ? ORDER BY bm25(session_fts) LIMIT ${RECALL_GUARD_LIMIT}`,
      )
      .all(keywords) as Array<{ role: string; snip: string }>;

    return rows.length > 0 ? rows.map((r) => `[${r.role}] ${r.snip}`).join('\n') : '';
  } catch (err) {
    log.error('distiller: step 4 — recall-guard', { err });
    // Return '' — the model just won't have the dedup hint.
    return '';
  } finally {
    try {
      recallDb?.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Parse and validate the distiller model's JSON response.
 *
 * Extracts the outermost JSON object (model may wrap in markdown fences),
 * validates field types, and returns typed arrays.  Returns empty arrays if the
 * response is absent, malformed, or produces no valid items.
 * Never throws — parse errors are logged and empty arrays returned.
 */
function parseDistillerResponse(raw: string, sessionId: string): { facts: FactItem[]; skills: SkillItem[] } {
  if (!raw) return { facts: [], skills: [] };

  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { facts: [], skills: [] };

    const parsed = JSON.parse(jsonMatch[0]) as { facts?: unknown[]; skills?: unknown[] };

    const facts = Array.isArray(parsed.facts)
      ? parsed.facts.filter(
          (f): f is FactItem =>
            f !== null &&
            typeof f === 'object' &&
            typeof (f as Record<string, unknown>).key === 'string' &&
            typeof (f as Record<string, unknown>).content === 'string',
        )
      : [];

    const skills = Array.isArray(parsed.skills)
      ? parsed.skills.filter(
          (s): s is SkillItem =>
            s !== null &&
            typeof s === 'object' &&
            typeof (s as Record<string, unknown>).key === 'string' &&
            isValidSlug((s as Record<string, unknown>).key as string) &&
            typeof (s as Record<string, unknown>).name === 'string' &&
            // name becomes a filesystem directory — must be a safe slug
            isValidSlug((s as Record<string, unknown>).name as string),
        )
      : [];

    return { facts, skills };
  } catch (err) {
    log.error('distiller: step 5 — parse model response', {
      sessionId,
      snippet: raw.slice(0, 200),
      err,
    });
    return { facts: [], skills: [] };
  }
}

/**
 * Write a distiller summary row to the group's recall DB (AC-9).
 *
 * Inserts a 'summary' role row so future recall searches surface what was
 * distilled in this session.  Delete-before-insert ensures idempotency if the
 * same session is re-distilled.
 *
 * Manages its own DB handle.  Never throws.
 */
function writeRecallSummary(folder: string, session: Session, facts: FactItem[], skills: SkillItem[]): void {
  let recallDb: Database.Database | null = null;
  try {
    recallDb = openRecallDb(recallDbPathForGroup(folder));
    ensureRecallSchema(recallDb);

    const factKeys = facts.map((f) => f.key).join(', ');
    const skillKeys = skills.map((s) => s.key).join(', ');
    const summaryParts: string[] = [];
    if (factKeys) summaryParts.push(`Facts extracted: ${factKeys}`);
    if (skillKeys) summaryParts.push(`Skill candidates: ${skillKeys}`);
    if (summaryParts.length === 0) summaryParts.push('Distiller pass: no extractable facts or skills.');
    const summaryContent = summaryParts.join('. ').slice(0, DISTILL_SUMMARY_MAX_CHARS); // ≤120 words approx.

    const summaryMsgId = `${session.id}:summary`;
    const now = new Date().toISOString();
    const localRecallDb = recallDb; // Capture for use inside the transaction closure.

    // Delete-before-insert for idempotency (same session may be re-distilled).
    localRecallDb.transaction(() => {
      localRecallDb.prepare(SQL_FTS_DELETE).run(summaryMsgId);
      localRecallDb.prepare(SQL_FTS_INSERT).run(summaryMsgId, session.id, folder, now, 'summary', summaryContent);
    })();

    log.debug('distiller: step 8 — summary written to recall DB', { sessionId: session.id });
  } catch (err) {
    log.error('distiller: step 8 — recall summary insert', { sessionId: session.id, err });
  } finally {
    try {
      recallDb?.close();
    } catch {
      /* ignore */
    }
  }
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
    .filter((w) => w.length > MIN_KEYWORD_LENGTH && !STOPWORDS.has(w));

  const seen = new Set<string>();
  const keywords: string[] = [];
  for (const w of words) {
    if (!seen.has(w)) {
      seen.add(w);
      keywords.push(w);
      if (keywords.length >= MAX_KEYWORD_TERMS) break;
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
