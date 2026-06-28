/**
 * Self-improve approval handlers — propose_skill gate.
 *
 * Side-effect module: registers handlers on import.  Import from the
 * self-improve barrel to wire in.
 *
 * Per DISC-2: only skills are gated; facts auto-apply in the distiller — no
 * `propose_fact` handler here.
 * Per DISC-1: write-only; no git commit.  The nightly `commitJournalAndSkills`
 * pass (DISC-7) makes the single batched commit.
 *
 * Handlers:
 *   propose_skill apply   — writes container/skills/<name>/instructions.md
 *                           with a trial marker, then journals + notifies.
 *   resolved handler      — on propose_skill rejection, tombstones the key
 *                           so the distiller won't re-propose it (SI-7).
 */
import fs from 'fs';
import path from 'path';

import { log } from '../../log.js';
import { selfImproveDbPath } from '../../madison-extensions.js';
import { registerApprovalHandler } from '../approvals/index.js';
import type { ApprovalHandler } from '../approvals/index.js';
import { registerApprovalResolvedHandler } from '../approvals/primitive.js';
import type { ApprovalResolvedHandler } from '../approvals/primitive.js';
import { appendJournal } from './journal.js';
import { ensureSelfImproveSchema, openSelfImproveDb } from './schema.js';
import { recordTombstone } from './tombstone.js';

// Mirror how journal.ts resolves PROJECT_ROOT (process.cwd() at host startup).
const PROJECT_ROOT = process.cwd();
const SKILLS_DIR = path.join(PROJECT_ROOT, 'container', 'skills');

/**
 * Apply handler: fires when an admin approves a `propose_skill` card.
 *
 * Writes `container/skills/<name>/instructions.md`:
 *   line 1: <!-- trial: true -->
 *   rest:   the procedure content
 *
 * Uses an atomic tmp→rename write to avoid partial reads by the container.
 * No git commit — the nightly batched pass commits container/skills/ (DISC-7).
 */
const applyProposeSkill: ApprovalHandler = async ({ payload, notify }) => {
  const key = payload.key as string | undefined;
  const name = payload.name as string | undefined;
  const procedure = payload.procedure as string | undefined;
  const scope = (payload.folder as string | undefined) ?? (payload.scope as string | undefined) ?? 'unknown';

  if (!key || !name || !procedure) {
    const msg =
      `propose_skill approved but payload missing required fields (key/name/procedure). ` +
      `Got keys: ${JSON.stringify(Object.keys(payload))}`;
    log.error('self-improve/approvals: applyProposeSkill — invalid payload', { key, name });
    notify(msg);
    return;
  }

  try {
    const skillDir = path.join(SKILLS_DIR, name);
    fs.mkdirSync(skillDir, { recursive: true });

    const dest = path.join(skillDir, 'instructions.md');
    const tmpDest = dest + '.tmp';
    // First line MUST be the trial marker (claude-md-compose conditional include
    // at :66 uses this to flag provisional skills).
    const fileContent = `<!-- trial: true -->\n${procedure}`;
    fs.writeFileSync(tmpDest, fileContent, 'utf8');
    fs.renameSync(tmpDest, dest);

    appendJournal('skill-trial', key, name, scope);
    notify(`🧪 trial skill added: ${name}`);
    log.info('self-improve: propose_skill applied', { key, name, scope, dest });
  } catch (err) {
    const msg =
      `propose_skill approved but failed to write skill file for "${name}": ` +
      `${err instanceof Error ? err.message : String(err)}`;
    log.error('self-improve/approvals: applyProposeSkill — write error', { err, key, name });
    notify(msg);
  }
};

/**
 * Resolved handler: fires on every approval resolution (any action, any outcome).
 * Only acts on propose_skill rejections — tombstones the key in self-improve.db
 * so the distiller's key-dedup check (SI-7) prevents re-proposal.
 */
const onProposeSkillResolved: ApprovalResolvedHandler = async (event) => {
  if (event.approval.action !== 'propose_skill' || event.outcome !== 'reject') return;

  let key: string | undefined;
  let scope: string;
  try {
    const payload = JSON.parse(event.approval.payload) as Record<string, unknown>;
    key = payload.key as string | undefined;
    scope = (payload.folder as string | undefined) ?? (payload.scope as string | undefined) ?? 'unknown';

    if (!key) {
      log.warn('self-improve/approvals: propose_skill rejection — payload missing key, skipping tombstone', {
        approvalId: event.approval.approval_id,
      });
      return;
    }
  } catch (err) {
    log.error('self-improve/approvals: failed to parse propose_skill payload on rejection', {
      err,
      approvalId: event.approval.approval_id,
    });
    return;
  }

  const db = openSelfImproveDb(selfImproveDbPath());
  try {
    ensureSelfImproveSchema(db);
    recordTombstone(db, key, 'rejected');
    appendJournal('skill-trial', key, 'rejected → tombstoned', scope);
    log.info('self-improve: propose_skill tombstoned on rejection', { key, scope });
  } catch (err) {
    log.error('self-improve/approvals: tombstone write failed', { err, key, scope });
  } finally {
    db.close();
  }
};

// Wire up at module load — side-effect registration.
registerApprovalHandler('propose_skill', applyProposeSkill);
registerApprovalResolvedHandler(onProposeSkillResolved);
