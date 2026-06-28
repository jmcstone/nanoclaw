/**
 * Self-improve module — continuous skill learning from interaction patterns.
 *
 * Optional tier. Depends on the approvals default module for the request/
 * handler plumbing. On install the module registers:
 *   - An approval handler for `propose_skill` that writes a trial skill file
 *     under container/skills/<name>/instructions.md with a trial marker.
 *   - A resolved handler that tombstones rejected proposals in self-improve.db
 *     so the distiller won't re-propose the same key (SI-7).
 *
 * Without this module: the distiller still runs and journals facts, but
 * `propose_skill` approval cards are dropped — no trial skills are ever
 * written and rejections are not tombstoned.
 */
import './approvals.js';
