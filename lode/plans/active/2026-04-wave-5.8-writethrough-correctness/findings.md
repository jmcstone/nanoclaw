# Findings — Wave 2C write-through correctness

2026-04-24 session. Live test run against the DAMAGED production DB (Wave 5.7 hot-tier had just caused 99% label-coverage loss; hotfixes had just landed; ingestor was running with fixed code; Jeff proposed "test on the damaged instance since we're restoring anyway").

## Test methodology

**Harness**: `docker exec` into `mailroom-ingestor-1`, run inline node script via `--input-type=module -e "..."`. Script imports `getInboxDb` from `/app/dist/store/db.js` for DB state snapshots, and uses `fetch()` as a minimal MCP HTTP client against `http://inbox-mcp:8080/mcp`.

**MCP handshake** (boilerplate — extract to `scripts/test-writethrough.ts` in Phase 5):

```js
const url = 'http://inbox-mcp:8080/mcp';
async function call(method, params = {}, sid = null) {
  const h = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' };
  if (sid) h['Mcp-Session-Id'] = sid;
  const res = await fetch(url, { method: 'POST', headers: h, body: JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random()*1e9), method, params }) });
  const text = await res.text();
  // inbox-mcp returns SSE-formatted responses (event: message\ndata: {...})
  let parsed;
  try {
    parsed = text.startsWith('event:')
      ? JSON.parse(text.split('\n').find(l => l.startsWith('data:')).slice(5).trim())
      : JSON.parse(text);
  } catch { parsed = { raw: text }; }
  return { sid: res.headers.get('mcp-session-id'), parsed };
}

const init = await call('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'wave-5.8-test', version: '1' },
});
const sid = init.sid;
await call('notifications/initialized', {}, sid);
// Now sid is usable for tools/call:
await call('tools/call', { name: 'archive', arguments: { message_ids: [target] } }, sid);
```

**Snapshot helper** (reused per-test, compact form):

```js
function snap(tag, mid) {
  const db = getInboxDb();
  const m = db.prepare('SELECT subject, archived_at, deleted_at FROM messages WHERE message_id = ?').get(mid);
  const ls = db.prepare("SELECT label || ' (src=' || IFNULL(source_id,'null') || ')' AS r FROM message_labels WHERE message_id = ? ORDER BY label").all(mid);
  const fus = db.prepare("SELECT folder || ':' || uid AS r FROM message_folder_uids WHERE message_id = ? ORDER BY folder").all(mid);
  console.log(`[${tag}] archived=${m?.archived_at ?? 'null'} deleted=${m?.deleted_at ?? 'null'} labels=[${ls.map(x=>x.r).join(', ')}] fus=[${fus.map(x=>x.r).join(', ')}]`);
}
```

**Test target selection**: query for messages in DAMAGED DB that still have INBOX label + populated folder_uids (i.e., messages that survived the data loss because they were received within the 7-day hot-reconcile window):

```sql
SELECT m.message_id FROM messages m
WHERE m.account_id = 'protonmail:jeff@thestonefamily.us'
  AND EXISTS (SELECT 1 FROM message_labels WHERE message_id = m.message_id AND label='INBOX')
  AND EXISTS (SELECT 1 FROM message_folder_uids WHERE message_id = m.message_id AND folder='INBOX')
  AND m.deleted_inferred = 0 AND m.deleted_at IS NULL
ORDER BY m.received_at DESC LIMIT 10;
```

## Bugs — one section per affected tool

### Bug B1 — `add_label` writes malformed message_labels row

**Severity**: HIGH. Breaks `query({labels:[...]})` correctness for any label Madison applies.

**Reproducer** (test 1 + test 3a this session):

Target: any INBOX Proton message. Run `add_label({message_ids:[target], label:'Test-Hotfix-A'})`.

**Observed state after:**
```
message_labels row: label="Test-Hotfix-A", canonical="test-hotfix-a", source_id=NULL
```

**Expected state after** (matching Wave 5.5 ingest path):
```
message_labels row: label="Labels/Test-Hotfix-A", canonical="test-hotfix-a", source_id="Labels/Test-Hotfix-A"
```

**Also missing**: no `label_catalog` row. Expected:
```
label_catalog row: account_id="protonmail:jeff@thestonefamily.us", label="Labels/Test-Hotfix-A", canonical="test-hotfix-a", source_id="Labels/Test-Hotfix-A", system=0
```

**Consequence**: 
1. Madison's query `query({labels:['Labels/Test-Hotfix-A']})` doesn't match (DB has `label="Test-Hotfix-A"`).
2. Reconcile walker later sees `Labels/Test-Hotfix-A` upstream, `INSERT OR IGNORE message_labels(label='Labels/Test-Hotfix-A', ...)` — this creates a SECOND row because the PK is `(message_id, label)` and the strings differ. Duplicate labels per message.
3. label_catalog doesn't learn the new label — tools that enumerate labels via catalog don't see it.

**Fix location**: `src/mcp/tools/add_label.ts`, Proton branch. After successful IMAP COPY:
- Compute `folderPath = 'Labels/' + labelArg` (Proton convention).
- Replace the inline `INSERT INTO message_labels` with call to `writeThroughAddLabel(db, accountId, messageId, folderPath)` helper (see Phase 1 of tracker).

**Regression test assertions**:
```ts
const row = db.prepare('SELECT label, canonical, source_id FROM message_labels WHERE message_id=? AND canonical=?').get(msgId, 'test-hotfix-a');
expect(row.label).toBe('Labels/Test-Hotfix-A');
expect(row.source_id).toBe('Labels/Test-Hotfix-A');
expect(row.canonical).toBe('test-hotfix-a');
const cat = db.prepare('SELECT * FROM label_catalog WHERE account_id=? AND canonical=?').get('protonmail:test@x', 'test-hotfix-a');
expect(cat).toBeDefined();
expect(cat.label).toBe('Labels/Test-Hotfix-A');
expect(cat.source_id).toBe('Labels/Test-Hotfix-A');
```

### Bug B2 — `archive` leaves stale `INBOX` in message_labels

**Severity**: HIGH. `query({labels:['INBOX']})` returns archived messages.

**Reproducer** (test 2 this session):

Target: an INBOX Proton message with labels `[INBOX, Labels/Bulk, Promotions]` and folder_uids `[INBOX:11, Labels/Bulk:13800]`. Run `archive({message_ids:[target]})`.

**Observed state after:**
```
archived_at: SET ✓
message_folder_uids: [Labels/Bulk:13800]  (INBOX:11 removed ✓)
message_labels: [INBOX, Labels/Bulk, Promotions]  (UNCHANGED — INBOX stale ✗)
```

**Expected state after:**
```
archived_at: SET
message_folder_uids: [Labels/Bulk:13800]  (INBOX removed)
message_labels: [Labels/Bulk, Promotions]  (INBOX removed)
  — or optionally: [Labels/Bulk, Promotions, Archive]  if we decide to match ingest semantics
```

**Consequence**: Default `query({labels:['INBOX']})` filter `direction='received' AND deleted_at IS NULL` does not exclude archived messages. So Madison's inbox-like views include archived items. Manually asserting `archived=false` in every caller is a footgun.

**Fix location**: `src/mcp/tools/archive.ts`, Proton branch. After IMAP MOVE success, replace the (existing) partial local-DB update with `writeThroughArchive(db, messageId)`:
```ts
writeThroughArchive = db.transaction(() => {
  db.prepare('UPDATE messages SET archived_at=? WHERE message_id=?').run(Date.now(), messageId);
  db.prepare("DELETE FROM message_labels WHERE message_id=? AND label='INBOX'").run(messageId);
  db.prepare("DELETE FROM message_folder_uids WHERE message_id=? AND folder='INBOX'").run(messageId);
  // Optional: also insert [Archive] if matching ingest shape.
});
```

**Regression test assertions**:
```ts
const labels = db.prepare("SELECT label FROM message_labels WHERE message_id=?").all(msgId);
expect(labels.map(r => r.label)).not.toContain('INBOX');
```

### Bug B3 — `delete` leaves stale labels in message_labels

**Severity**: HIGH. Deleted messages still show old label membership.

**Reproducer** (test 5 this session):

Target: a message with labels `[INBOX, Labels/Bulk, Test-Hotfix-B]` and folder_uids `[INBOX:10, Labels/Bulk:13799]`. Run `delete({message_id:target})`.

**Observed state after:**
```
deleted_at: SET ✓
archived_at: null  ✓
message_folder_uids: [Labels/Bulk:13799]  (INBOX:10 removed ✓)
message_labels: [INBOX, Labels/Bulk, Test-Hotfix-B]  (ALL UNCHANGED ✗)
```

**Expected state after:**
```
deleted_at: SET
message_folder_uids: []  (all removed — message deleted from everywhere)
message_labels: []  (all removed — same reason)
```

**Consequence**: Deleted messages appear in any label-scoped query (`query({labels:['Labels/Bulk']})` returns them). Default filter `deleted_at IS NULL` catches it, but only because the caller didn't override — and caller-level filtering is fragile.

**Fix location**: `src/mcp/tools/delete.ts`. After IMAP MOVE-to-Trash success, use `writeThroughDelete(db, messageId)` helper that clears ALL message_labels + message_folder_uids for the message and sets deleted_at.

**Regression test assertions**:
```ts
const labels = db.prepare("SELECT COUNT(*) AS n FROM message_labels WHERE message_id=?").get(msgId);
const fus = db.prepare("SELECT COUNT(*) AS n FROM message_folder_uids WHERE message_id=?").get(msgId);
expect(labels.n).toBe(0);
expect(fus.n).toBe(0);
```

### Bug B4 — `label` (replace-set) produces cross-table divergence

**Severity**: HIGH. Creates inconsistent state where `message_labels` says X but `message_folder_uids` says Y.

**Reproducer** (test 4 this session):

Target: INBOX Proton message with labels `[INBOX]` and folder_uids `[INBOX:9]`. Run `label({message_ids:[target], labels:['Test-Hotfix-D1', 'Test-Hotfix-D2']})`.

**Observed state after:**
```
message_labels: [Test-Hotfix-D1 (src=null), Test-Hotfix-D2 (src=null)]  (INBOX REMOVED ✓ but wrong shape ✗)
message_folder_uids: [INBOX:9]  (INBOX still present ✓)
```

**Expected state after** (Proton label apply = COPY to Labels/*, doesn't un-INBOX):
```
message_labels: [INBOX, Labels/Test-Hotfix-D1, Labels/Test-Hotfix-D2]  (all three with correct shape)
message_folder_uids: [INBOX:9]  (preserved — upstream INBOX membership unchanged)
```

**Consequence**: 
1. The two "Test-Hotfix-D" entries have the same wrong shape as bug B1.
2. The message_labels says "not in INBOX" while message_folder_uids says "in INBOX". The cross-table inconsistency breaks any logic that joins or cross-references them. (Madison's query filtering by INBOX via message_labels would miss it; her queries filtering by folder_uids would include it.)
3. Upstream Proton still has the message in INBOX (label COPY doesn't EXPUNGE from INBOX) — the local state is diverged from upstream.

**Fix location**: `src/mcp/tools/label.ts`. Replace-set semantics for Proton need care:
- Upstream Proton: label apply = COPY to new label folders. Doesn't affect INBOX membership.
- Replace-set means: the set of labels user-applied (not system folders like INBOX) should equal the provided list.
- So: DELETE message_labels rows WHERE `label LIKE 'Labels/%'` (user-labels only) AND message_id=?, then INSERT the new correct-shape rows. Preserve INBOX/Archive/All Mail/Sent/etc.
- Upstream: issue EXPUNGE from any old Labels/ folder this message is no longer in, COPY to any new Labels/ folder.

This is non-trivial — `label` replace-set is the most complex of the tools. Consider scope: if Madison rarely uses replace-set, it may be safe to ship an `add_label`+`remove_label` approach and DEFER the full replace-set fix. But given Proton's `remove_label` is a v1 no-op, we can't actually synthesize replace-set from primitives. Needs thought during implementation.

**Regression test assertions**: TBD — depends on chosen replace-set semantics. At minimum, wrong-shape regression should fail; cross-table inconsistency should fail.

### Bug B5 — `add_label` label-catalog miss (subset of B1)

Already covered under B1. Listed separately for tracker AC granularity.

### Non-bug N1 — `remove_label` (Proton) is a v1 no-op

**Not a bug, documented limitation.** The Wave 5.5 tracker AC explicitly states:
> "Proton: v1 no-op — the skip is surfaced per-id in `labels_remove_skipped` on each result item; the id still counts as `succeeded`."

Reproducer returns:
```json
{"succeeded":1, "labels_removed":[], "labels_remove_skipped":["<label>..."]}
```

Keep as-is. The real impact is that stale labels applied by other bugs (or by the user via Proton web) can only be cleaned up by reconcile — which is now safe (Wave 5.7 hotfix + blast-guard).

## Additional observations

### O1 — `label_catalog` has "Promotions" with `source_id=null` on a Proton message

During testing B2, noticed the target message had a pre-existing label `Promotions (src=null)`. `Promotions` is Gmail's category affordance, shouldn't appear on a Proton message. Might be:
- Leftover from when the message was mirrored cross-provider somehow
- A Madison auto-triage rule that labeled it `Promotions` without the proper prefix
- A pre-existing instance of bug B1 (Madison called `add_label(..., 'Promotions')` at some point)

Worth investigating during Wave 5.8 implementation — might be another bug, might be stale data.

### O2 — many messages have `archived_at` set from Madison's auto-triage rules

Multiple test targets had `archived_at` already set before we did anything. Madison's rule engine auto-archives bulk/newsletter classes at ingest. This is expected behavior (per rules.json), not a bug.

### O3 — `message_labels` PK is `(message_id, label)`

Confirmed via `SELECT sql FROM sqlite_master`:
```sql
CREATE TABLE message_labels (
  message_id  TEXT NOT NULL,
  label       TEXT NOT NULL,
  canonical   TEXT NOT NULL,
  source_id   TEXT,
  PRIMARY KEY (message_id, label),
  FOREIGN KEY (message_id) REFERENCES messages(message_id)
);
```

So INSERT OR IGNORE against wrong-shape vs correct-shape labels produces DIFFERENT rows (different `label` values). That's why bug B1 would cause duplicate labels per message when reconcile runs.

## Test targets used this session

- **BeiGene director jobs** (`protonmail:<1jn08tm23kofb802@indeed.com>`, jeff@thestonefamily.us) — got `Test-Hotfix-A` applied via add_label. Cleanup: expunge from Labels/Test-Hotfix-A in Proton web.
- **Uber 40% off pickup** (`protonmail:<17fd8751-fe25-3244-bb3a-74678796170f@mail.uber.com>`, jeff@thestonefamily.us) — got archived via test. Already moved to Archive upstream.
- **Amazon SES "crediting Points"** (`protonmail:<0107019dbfa43601-f12e7f4e-3a8c-4d45-8f2b-3add3436b114-000000@eu-central-1.amazonses.com>`) — got `Test-Hotfix-B` added then delete'd (soft-deleted to Trash). Already in Trash upstream.
- **NYC Financial Innovation Forum** (`protonmail:<148aeb4f66b9999b8c962331c.12ed32def7.20260424130044.a1e2e9de6e.bd3125e6@mail34.suw131.mcsv.net>`) — got labels replaced with `[Test-Hotfix-D1, Test-Hotfix-D2]`. Cleanup: in Proton web, expunge from Labels/Test-Hotfix-D1 and Labels/Test-Hotfix-D2. Original INBOX still there.

Post-restore cleanup (optional, low priority): remove the 4 `Labels/Test-Hotfix-*` folders + messages from Proton web. Cheap to do manually.

## Key file references for next session

### Modified this session (hotfix)
- `~/Projects/ConfigFiles/containers/mailroom/mailroom/src/reconcile/apply.ts` — added `sinceDate?` param to `applyLabelDelta`, `applyFolderUidDelta`, `applyInferredDeletes`. DB-side queries conditionally filter `received_at >= sinceDate`.
- `~/Projects/ConfigFiles/containers/mailroom/mailroom/src/reconcile/hydrate.ts` — threads sinceDate to apply calls.
- `~/Projects/ConfigFiles/containers/mailroom/mailroom/src/reconcile/recency-scheduler.ts` — added `runWithBlastGuard` wrapping each tier.

### To be modified for Wave 5.8
- `~/Projects/ConfigFiles/containers/mailroom/mailroom/src/store/write-through.ts` (create or extend)
- `~/Projects/ConfigFiles/containers/mailroom/mailroom/src/mcp/tools/add_label.ts`
- `~/Projects/ConfigFiles/containers/mailroom/mailroom/src/mcp/tools/archive.ts`
- `~/Projects/ConfigFiles/containers/mailroom/mailroom/src/mcp/tools/delete.ts`
- `~/Projects/ConfigFiles/containers/mailroom/mailroom/src/mcp/tools/label.ts`
- `~/Projects/ConfigFiles/containers/mailroom/mailroom/src/mcp/tools/apply_action.ts`
- `~/Projects/ConfigFiles/containers/mailroom/mailroom/src/mcp/tools/remove_label.ts` (Gmail-path only; Proton remains v1 no-op)
- New: `~/Projects/ConfigFiles/containers/mailroom/mailroom/src/integration/wave-5.8-writethrough.test.ts`
- New: `~/Projects/ConfigFiles/containers/mailroom/mailroom/scripts/test-writethrough.ts` (MCP HTTP harness CLI)
