/**
 * Sessionless approval-card issuance for nightly propose_skill candidates (AC-6).
 *
 * `issueSkillApprovalCard` checks whether a card has already been issued for
 * the given key (dedup via `card_issued_at` on `proposal_keys`), then calls
 * `requestApprovalForGroup` to deliver a proper approval card to the admin DM.
 * On success, `card_issued_at` is stamped so the next nightly run won't
 * re-issue.
 *
 * Dedup lifecycle:
 *   - `card_issued_at = null`  → no card yet; eligible for issuance.
 *   - `card_issued_at = <iso>` → card outstanding; skip.
 *   - On tombstone (admin rejects via card) → `onProposeSkillResolved` clears
 *     `card_issued_at` AND sets `tombstone = 1`.  The `tombstone = 0` filter
 *     in the promote query then prevents the key from appearing at all, so
 *     clearing `card_issued_at` is purely defensive (enables re-card if the
 *     tombstone is ever reversed).
 */
import { log } from '../../log.js';
import { selfImproveDbPath } from '../../madison-extensions.js';
import { requestApprovalForGroup } from '../approvals/primitive.js';
import { ensureSelfImproveSchema, openSelfImproveDb } from './schema.js';
import type { SkillItem } from './schema.js';

const PROCEDURE_PREVIEW_CHARS = 300;

/**
 * Issue a propose_skill approval card for a skill candidate.
 *
 * @param agentGroupId  Agent group that owns this skill candidate.
 * @param folder        Group folder name, carried in the card payload for the
 *                      apply handler's journal entry.
 * @param item          Distilled skill candidate (key, name, procedure, evidence_summary).
 * @param sessionCount  How many sessions observed this key — shown as evidence.
 *
 * @returns true if a card was delivered; false if deduped, no approver, or
 *          delivery failed (caller should treat false as "retry next night").
 */
export async function issueSkillApprovalCard(
  agentGroupId: string,
  folder: string,
  item: SkillItem,
  sessionCount: number,
): Promise<boolean> {
  // Dedup check: skip if a card was already issued for this key.
  {
    let db: ReturnType<typeof openSelfImproveDb> | undefined;
    try {
      db = openSelfImproveDb(selfImproveDbPath());
      ensureSelfImproveSchema(db);
      const row = db.prepare('SELECT card_issued_at FROM proposal_keys WHERE key = ?').get(item.key) as
        | { card_issued_at: string | null }
        | undefined;
      if (row?.card_issued_at) {
        log.debug('issueSkillApprovalCard: card already issued — skipping', {
          key: item.key,
          issuedAt: row.card_issued_at,
        });
        return false;
      }
    } catch (err) {
      log.error('issueSkillApprovalCard: failed to read card_issued_at', { key: item.key, err });
      return false;
    } finally {
      try {
        db?.close();
      } catch {
        /* ignore */
      }
    }
  }

  // Build card content.
  const evidence = `Recurred in ${sessionCount} sessions`;
  const procedurePreview =
    item.procedure.length > PROCEDURE_PREVIEW_CHARS
      ? item.procedure.slice(0, PROCEDURE_PREVIEW_CHARS) + '…'
      : item.procedure;
  const title = `Propose skill: ${item.name}`;
  const question = [`Evidence: ${evidence}`, '', 'Proposed procedure:', '```', procedurePreview, '```'].join('\n');

  // Deliver the card.  payload shape matches applyProposeSkill's expectations.
  const issued = await requestApprovalForGroup({
    agentGroupId,
    action: 'propose_skill',
    payload: {
      key: item.key,
      name: item.name,
      procedure: item.procedure,
      folder,
      evidence,
    },
    title,
    question,
  });

  if (!issued) {
    log.warn('issueSkillApprovalCard: card not delivered — will retry next nightly pass', {
      key: item.key,
      agentGroupId,
    });
    return false;
  }

  // Stamp card_issued_at so subsequent nightly runs skip this key.
  {
    let db: ReturnType<typeof openSelfImproveDb> | undefined;
    try {
      db = openSelfImproveDb(selfImproveDbPath());
      ensureSelfImproveSchema(db);
      db.prepare('UPDATE proposal_keys SET card_issued_at = ? WHERE key = ?').run(new Date().toISOString(), item.key);
    } catch (err) {
      log.warn('issueSkillApprovalCard: failed to stamp card_issued_at (dedup may miss next run)', {
        key: item.key,
        err,
      });
    } finally {
      try {
        db?.close();
      } catch {
        /* ignore */
      }
    }
  }

  log.info('issueSkillApprovalCard: card issued', { key: item.key, name: item.name, folder, agentGroupId });
  return true;
}
