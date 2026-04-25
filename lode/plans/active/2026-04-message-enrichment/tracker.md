# Message Enrichment — Recipients + List Headers + Attachments

Branch: `feat/message-enrichment` (to be created when work starts; plan currently authored on `fix/morning-brief-audit` since `madison-read-power` already merged to main).

## Goal

Extend the mailroom mirror so Madison can answer questions about who else was on a message (To/CC/BCC/Reply-To), whether it's list mail (List-Id / List-Unsubscribe), and what's attached (filenames, MIME types, sizes, optional bytes). One-shot resumable backfill of all 60k existing messages, ingest-path parity for new mail, idempotent re-run, blast-guarded.

## Companion plan (committed)

[2026-04-document-to-markdown](../2026-04-document-to-markdown/tracker.md) — `add-document-to-markdown` container skill backed by `markitdown` (Microsoft, MIT). Converts PDF / DOCX / XLSX / PPTX / HTML / EPUB / CSV attachments on a `/workspace` path to markdown. Ships in lockstep with this plan's Wave 6 verification but development can run in parallel — the skill works on any `/workspace` path, not only fetched attachments. Without it, the attachment data this plan ships is largely inert; with it, `attachment_to_path` → `document-to-markdown` is the end-to-end consumption path Madison uses for every non-trivial attachment.

## Read first

- [lode/architecture/madison-pipeline.md](../../../architecture/madison-pipeline.md) — mirror data model, session-hash invalidation pattern, hydration phases. The new tables sit alongside `message_labels` / `message_folder_uids` / `label_catalog`.
- [lode/infrastructure/mailroom-mirror.md](../../../infrastructure/mailroom-mirror.md) — sync worker architecture; the Wave 5.8 shape contract for ingest/write-through/reconcile parity is the bar this plan must meet for the new fields.
- [lode/infrastructure/mailroom-rules.md](../../../infrastructure/mailroom-rules.md) — rule engine; recipient + list-header data unlocks new rule conditions later.
- [lode/plans/complete/2026-04-madison-read-power/tracker.md](../../complete/2026-04-madison-read-power/tracker.md) — direct precedent. Same shape: schema migration → ingest extension → MCP surface → backfill → verify → graduate. Read for patterns; do not copy boilerplate.
- mailroom: `src/store/db.ts` (schema + idempotent migrations), `src/store/types.ts`, `src/store/queries.ts`, `src/store/ingest.ts`, `src/mcp/tools/query.ts`, `src/gmail/poller.ts`, `src/proton/poller.ts`, `src/sync/proton-condstore.ts` (UIDNEXT poller despite filename), `scripts/migrate-mirror.ts` (the resumable + blast-guarded backfill pattern to replicate).
- nanoclaw: `src/sessions/computeGroupMcpHash` (session-toolset hash; bump when the MCP surface changes).

## Acceptance criteria (goal-backward)

### Recipients
- AC-R1 Madison can answer "emails where I was on To" vs "emails where I was only on CC" vs "emails where I was BCC'd" via `mcp__inbox__query` filters.
- AC-R2 Reply-To populated when present; queryable as `reply_to_contains`.
- AC-R3 BCC populated for sent messages (visible in Gmail full message + Proton sent-folder fetch); silently absent for received (envelope doesn't carry BCC for the recipient — documented behaviour, not a bug).
- AC-R4 Recipients are normalized: filtering by individual address is exact (no substring on a comma-joined string).
- AC-R5 Default projection on `InboxMessage` includes `recipients: { to[], cc[], bcc[], reply_to[] }` capped at 20 entries per kind with a `recipients_truncated: boolean` flag when capped. Full list available via `mcp__inbox__get_recipients(message_id)` for the rare case of huge CCs.

### Send-side tools (consumption layer)
- AC-S1 `mcp__inbox__send_reply` (extends existing): when the original message has a Reply-To, use it; otherwise fall back to From. Precedence documented in the tool description and tested.
- AC-S2 `mcp__inbox__send_reply_all` (new): `to = original_reply_to_or_from + (original_to − my_accounts)`, `cc = original_cc − my_accounts`, `bcc = []`, threading headers (`In-Reply-To`, `References`) preserved. `additional_attachment_positions?: number[]` re-attaches selected pieces from the original. BCC explicitly stripped (RFC + social).
- AC-S3 `mcp__inbox__send_forward` (new): caller provides `to[]`, `cc?[]`, `bcc?[]`, `body_markdown` (preface), `include_attachments?: boolean = true`, `attachment_positions?: number[]` (default = all). Subject `"Fwd: <original>"`. New thread (no `In-Reply-To` unless caller opts in via explicit flag). Attachments resolved via `fetch_attachment` (cache-first / source-fallback) and re-attached to the outgoing message.

### List headers
- AC-L1 `messages.list_id` and `messages.list_unsubscribe` populated when present; null when absent. New filter `is_list_mail` matches `list_id IS NOT NULL`.
- AC-L2 List-Unsubscribe URI/`mailto:` retained as-is for a future unsubscribe tool.

### Attachments
- AC-A1 `messages.attachment_count` populated for all 60k existing messages and every new ingest. `total_attachment_bytes` likewise.
- AC-A2 Per-attachment metadata in `message_attachments(message_id, position)` with filename, MIME type, size, content-id, source attachment id, disposition.
- AC-A3 Optional blob cache in `message_attachment_blobs(message_id, position)`. Row presence = "we have the bytes locally"; absence = "we know the metadata, source has the bytes."
- AC-A4 `mcp__inbox__fetch_attachment(message_id, position)` returns bytes from cache when present, falls back to upstream fetch (Gmail `users.messages.attachments.get` / Proton `BODY[partN]`) when absent. Caller cannot tell which path served the request.
- AC-A5 `mcp__inbox__attachment_to_path(message_id, position, dest_path?)` writes bytes to `/workspace/inbox-attachments/<message_id>/<filename>` (or caller-supplied path) and returns the path. Madison feeds the path into existing container skills (`add-pdf-reader`, `add-image-vision`, future format readers) for content extraction. Server-side conversion (`attachment_to_markdown` / `extract_pdf` etc.) is deliberately **out of scope** for this plan — captured as a follow-up.
- AC-A6 New filters: `has_attachments`, `attachment_name_matches`, `mime_type`. Default projection on `InboxMessage` includes `attachment_count`, `total_attachment_bytes`, and `attachments: [{ filename, mime_type, size_bytes, position, cached }]` joined from `message_attachments` LEFT JOIN `message_attachment_blobs`. `cached: boolean` exposes whether the bytes are local-fast vs network-required so Madison can plan forwards / extracts accordingly.

### Backfill
- AC-B1 `scripts/enrich-mailroom.ts --metadata-only` walks every message once (`UID FETCH ENVELOPE BODYSTRUCTURE BODY.PEEK[HEADER.FIELDS (LIST-ID LIST-UNSUBSCRIBE REPLY-TO)]`) and populates recipients, list headers, attachment metadata, `attachment_count`, `total_attachment_bytes`. Resumable per-account via `meta.last_enriched_<account_id>`.
- AC-B2 `scripts/enrich-mailroom.ts --blobs` fetches attachment bytes only for `message_attachments` rows with no matching `message_attachment_blobs` row. Idempotent on re-run; resumable.
- AC-B3 50%-delta blast guard on new-table row counts (matching the migrate-mirror pattern). Trip → log + `exit 1` before further damage.
- AC-B4 Re-run after completion is a no-op (zero adds, zero removes).
- AC-B5 Both phases log progress every 500 messages with running totals.

### Ingest-path parity (Wave 5.8 shape contract extension)
- AC-I1 New mail arriving via the Gmail history.list / Proton IDLE / UIDNEXT poll paths populates the same new fields as backfill, in the same transaction as the `messages` insert. Tested by `audit_recipients_coverage` + `audit_attachments_coverage` MCP tools (read-only, return zero-row-count of inconsistent messages in the window).
- AC-I2 The Wave 5.8 reconcile-idempotency invariant holds: a hot/warm/cold reconcile that walks a recent message produces the same row state ingest produced. No write-back churn.

### Verification
- AC-V1 (Jeff-driven) `query` with `addressed_to_me=true` returns only messages where Jeff was on To/CC, not those where he was BCC'd or merely a list recipient.
- AC-V2 (Jeff-driven) `query` with `is_list_mail=true` returns only newsletter/list mail; spot-check 5 random results.
- AC-V3 (Jeff-driven) `query` with `has_attachments=true, attachment_name_matches='\.pdf$'` returns the expected count from a known-good Gmail web search.
- AC-V4 (Jeff-driven) `mcp__inbox__fetch_attachment` against a state-3 message returns the cached bytes; against a state-2 message goes to source and returns the same bytes; both flows verified end-to-end.
- AC-V5 Test suites green: nanoclaw + mailroom both at zero `tsc --noEmit` errors and full vitest pass.
- AC-V6 (Cross-plan) End-to-end: Madison fetches a real PDF + DOCX + XLSX attachment via `attachment_to_path`, runs the `document-to-markdown` skill (companion plan) on the returned path, and replies with readable markdown content. Cache-hit and cache-miss attachment paths both verified.

## Decisions (locked)

| Decision | Rationale |
|---|---|
| DB-resident BLOBs in a separate `message_attachment_blobs` table | SQLCipher gives encryption-at-rest; btrfs compression is moot on encrypted pages anyway, and dominant attachment formats (PDF, .docx, .xlsx, images) are pre-compressed. Single backup unit, single key. Separate table so common queries don't pull blobs into memory unintentionally. |
| `attachment_count INTEGER` + `total_attachment_bytes INTEGER` columns on `messages` | Index-friendly; lets every "messages with attachments" query be a partial-index lookup. Also future-proofs lazy / disabled / tiered blob caching: metadata is enough to know the bytes need fetching from source. |
| `message_attachments` stores both `disposition='attachment'` and `disposition='inline'` rows | Madison can filter inlines out for "real" attachment queries while still having the data to find inline-image references. `attachment_count` excludes inlines so it matches user intuition. |
| Three-state design — count + metadata + optional blob — with `mcp__inbox__fetch_attachment` doing transparent cache-first / source-fallback | Lets us flip blob caching on/off, expire old blobs by date, or apply selective caching policies without any schema or tool change. State transitions are well-defined: 1↔2 by ingest, 2→3 by blob fetch, 3→2 by blob delete. |
| One-shot resumable backfill, two phases (metadata, then blobs), each with `meta.last_enriched_<account_id>` checkpoint | Same pattern as `migrate-mirror.ts`. Metadata pass is required (recipients + attachment_count); blob pass is optional and policy-gated. Both phases are independently resumable so an overnight failure picks up where it stopped. |
| BCC included for sent messages (Gmail full + Proton Sent-folder fetch); accepted absent for received | Envelope semantics — RFC 5322 strips BCC on delivery to recipients. Document the asymmetry; don't pretend we have it. |
| Reply-To included | One column, comes back free in the same envelope fetch, real triage value (newsletter sender ≠ reply target). |
| List-Id / List-Unsubscribe as columns on `messages` | Two text columns; cheap. Makes the eventual "auto-unsubscribe" tool a one-call lookup. |
| `BODY.PEEK[HEADER.FIELDS (...)]` on the metadata pass | One round-trip per message gets envelope + bodystructure + selected headers. Minimizes Bridge-API hits. |
| 50%-delta blast guard pattern from `migrate-mirror.ts` | Same blast guard, same shape. Trips on count drift in the new tables. |
| Schema bump v5 → v6 | Additive only; idempotent ALTERs match the existing pattern. No data migration required for existing rows (defaults of `0` and `NULL` are correct for the populated-by-backfill columns). |
| Session-toolset hash bump on Madison's container | New MCP filters + new send/fetch/path tools change the surface; existing sessions must invalidate. Same mechanism as Wave 2C / Codex P2 from read-power. |
| Recipients + attachment metadata included in default projection (capped at 20 per recipient-kind, with `recipients_truncated` flag) | Recipients and attachment metadata are part of "what is this message," not a power-user detail. Opt-in defaults guarantee Madison silently misses them. The cap-and-flag handles 100+ CC list mail. Cost is one `LEFT JOIN ... GROUP_CONCAT` per query, O(N) not N+1. |
| `cached: boolean` per attachment in projection (extra LEFT JOIN onto `message_attachment_blobs`) | Lets Madison know — before forwarding or extracting — whether bytes are local-fast vs network-required. Free signal, single join, immune to future caching policy changes (lazy / disabled / tiered all keep the metadata join intact; only blob-row presence flips). |
| `attachment_to_path` is the only content-handoff tool in scope; format-specific extraction lives in container skills | Smallest sufficient API. Madison's existing skills (`add-pdf-reader`, `add-image-vision`, future `add-xlsx-reader` / `add-docx-reader` / `add-pdf-to-markdown`) already operate on `/workspace` paths. Adding server-side `attachment_to_markdown` or per-format MCP extracts duplicates capability and locks in converter choice. Defer until friction is real. |
| Reply-All strips BCC; Forward starts a new thread by default | Reply-All to BCC'd recipients leaks the BCC list (RFC + social violation). Forward into a new thread matches mail-client convention; caller can opt into thread-preserving forward via explicit flag for the rare case. |
| `send_reply` uses Reply-To when present, else From | Newsletter senders, support queues, and shared mailboxes set Reply-To to the right destination; ignoring it sends replies to the wrong place. One-line precedence rule, documented in the tool description. |

## Phases / Waves

### Wave 0 — Pre-reqs (sequential)
- [ ] 0.1 Spin up branch `feat/message-enrichment` on both nanoclaw and mailroom (ConfigFiles)
- [ ] 0.2 Re-read this tracker + the four lode docs in "Read first"
- [ ] 0.3 Confirm current `tsc --noEmit` zero errors + full test pass on both repos

### Wave 1 — Size discovery (precondition; informs Wave 5 sizing)
- [ ] 1.1 Write `scripts/measure-attachments.ts` — connects to each Proton account via Bridge IMAP, walks every folder with `UID FETCH 1:* (BODYSTRUCTURE)`, counts: total messages, messages with at least one attachment-disposition part, total attachment bytes (from BODYSTRUCTURE size fields), distribution by MIME type and by size bucket. Same shape for Gmail (`format=METADATA`).
- [ ] 1.2 Run against live mailroom; capture results in `findings.md` (tables: per-account counts + bytes; aggregate totals; size histogram; MIME distribution).
- [ ] 1.3 Re-evaluate Wave 5 wall-time + storage estimates against actual numbers; update tracker if reality differs from the ~3-4h / ~3 GB ballpark.

### Wave 2 — Schema v5 → v6 migration (single agent; blocks Waves 3+)
- [ ] 2.1 `addColumnIfMissing` calls in `src/store/db.ts`: `messages.attachment_count INTEGER NOT NULL DEFAULT 0`, `messages.total_attachment_bytes INTEGER NOT NULL DEFAULT 0`, `messages.list_id TEXT`, `messages.list_unsubscribe TEXT`.
- [ ] 2.2 `CREATE TABLE IF NOT EXISTS message_recipients(message_id TEXT, kind TEXT CHECK(kind IN ('to','cc','bcc','reply_to')), address TEXT, name TEXT, position INTEGER, PRIMARY KEY (message_id, kind, position), FOREIGN KEY (message_id) REFERENCES messages(message_id))`.
- [ ] 2.3 `CREATE TABLE IF NOT EXISTS message_attachments(message_id TEXT, position INTEGER, filename TEXT, mime_type TEXT, size_bytes INTEGER NOT NULL, content_id TEXT, source_attachment_id TEXT NOT NULL, disposition TEXT NOT NULL CHECK(disposition IN ('attachment','inline')), PRIMARY KEY (message_id, position), FOREIGN KEY (message_id) REFERENCES messages(message_id))`.
- [ ] 2.4 `CREATE TABLE IF NOT EXISTS message_attachment_blobs(message_id TEXT, position INTEGER, content BLOB NOT NULL, PRIMARY KEY (message_id, position), FOREIGN KEY (message_id, position) REFERENCES message_attachments(message_id, position) ON DELETE CASCADE)`.
- [ ] 2.5 Indices: `CREATE INDEX idx_message_recipients_address ON message_recipients(address)`, `CREATE INDEX idx_messages_with_attachments ON messages(received_at) WHERE attachment_count > 0`, `CREATE INDEX idx_messages_list_id ON messages(list_id) WHERE list_id IS NOT NULL`.
- [ ] 2.6 Stamp `meta.schema_version='6'`. Forward-migration guard refuses downgrade.
- [ ] 2.7 Test: round-trip migration on a v5 fixture DB; assert all new columns + tables exist with correct schema; idempotent re-run is a no-op.
- [ ] 2.8 All existing tests still green.

### Wave 3 — Ingest path extensions
- [ ] 3.1 Extend `MessageIngestInput` with `recipients?`, `list_id?`, `list_unsubscribe?`, `attachments?` (parsed shapes; not raw IMAP/Gmail responses).
- [ ] 3.2 Extend `ingestMessage()` transaction: insert `message_recipients` rows, populate new `messages` columns, insert `message_attachments` rows, recompute `attachment_count` + `total_attachment_bytes` from the inserted attachment rows. All inside the existing `db.transaction(...)`.
- [ ] 3.3 Gmail poller: parse `payload.headers` for To/Cc/Bcc/Reply-To/List-Id/List-Unsubscribe; walk `payload.parts` for attachment metadata. Pass parsed shapes to `ingestMessage`.
- [ ] 3.4 Proton poller: envelope already has to/cc/bcc/reply-to; add `BODYSTRUCTURE` walk; fetch List-Id / List-Unsubscribe via `BODY.PEEK[HEADER.FIELDS (LIST-ID LIST-UNSUBSCRIBE)]` in the same FETCH.
- [ ] 3.5 Wave 2B push handlers (`applyProtonUidAdded`, `applyLabelsAdded`) — verify no work needed: these fire on label/folder changes for already-ingested rows; new fields are populated at ingest time only.
- [ ] 3.6 New audit tools: `mcp__messages__audit_recipients_coverage({since_hours?})`, `mcp__messages__audit_attachments_coverage({since_hours?})`. Same shape as the existing `audit_label_coverage`: read-only, return `{missing_count, sample_message_ids}` for messages in the window with `attachment_count IS NULL` or zero recipient rows where the source actually had recipients.
- [ ] 3.7 Ingest-path parity tests in `src/integration/wave-N-message-enrichment.test.ts` mirroring the wave-5.5 pattern: seed a Gmail-shaped + Proton-shaped message via the appliers; assert recipient rows, attachment rows, attachment_count, total_attachment_bytes all match the fixture.

### Wave 4 — MCP query + send / fetch / path tools
- [ ] 4.1 Extend `QueryArgs`: `to_contains`, `cc_contains`, `bcc_contains`, `reply_to_contains`, `addressed_to`, `addressed_to_me`, `has_attachments`, `attachment_name_matches`, `mime_type`, `is_list_mail`. Update `parseQueryArgs` + `buildQueryWhere`.
- [ ] 4.2 `addressed_to_me` resolution: takes the configured account email set from `accounts` table; `(to|cc) IN (account.email_address)`. No regex; exact-match against the account list.
- [ ] 4.3 Default projection on `InboxMessage`: include `attachment_count`, `total_attachment_bytes`, `list_id`, `list_unsubscribe`, `recipients: { to[], cc[], bcc[], reply_to[] }` (capped at 20 per kind, `recipients_truncated: boolean` when capped), and `attachments: [{ filename, mime_type, size_bytes, position, cached }]` from `message_attachments LEFT JOIN message_attachment_blobs USING (message_id, position)`. Use a single `GROUP_CONCAT` per query (or batch lookup `WHERE message_id IN (...)`) — O(N), not N+1. Opt-out flags `include_recipients?: boolean = true`, `include_attachments?: boolean = true` for the rare bulk-aggregate query.
- [ ] 4.4 `mcp__inbox__get_recipients({ message_id })` — tiny tool returning the full recipient list for one message, for callers who need the rows that the cap dropped.
- [ ] 4.5 New tool `mcp__inbox__fetch_attachment({ message_id, position })`: looks up `message_attachments` row, checks `message_attachment_blobs` for cached content; on cache miss, calls upstream (Gmail `users.messages.attachments.get` via the existing client; Proton `UID FETCH N BODY[partN]`) and returns bytes (base64). Optionally writes the fetched bytes back to `message_attachment_blobs` (env flag `MAILROOM_LAZY_CACHE_ON_FETCH=true` default).
- [ ] 4.6 New tool `mcp__inbox__attachment_to_path({ message_id, position, dest_path? })`: thin wrapper on `fetch_attachment` that decodes bytes and writes to `dest_path` (default `/workspace/inbox-attachments/<message_id>/<filename>`); returns `{ path, size_bytes, mime_type, cached_at_fetch_time }`. Madison hands the path to existing container skills for content extraction.
- [ ] 4.7 Extend existing `mcp__inbox__send_reply`: read `message_attachments` for the original; resolve recipient via Reply-To when present, else From; preserve `In-Reply-To` + `References`. Tool description documents the Reply-To precedence.
- [ ] 4.8 New tool `mcp__inbox__send_reply_all({ message_id, body_markdown, additional_attachment_positions? })`: compute `to`/`cc` per AC-S2; strip BCC; preserve threading; re-attach selected pieces from the original via `fetch_attachment`.
- [ ] 4.9 New tool `mcp__inbox__send_forward({ message_id, to, cc?, bcc?, body_markdown, include_attachments?: boolean = true, attachment_positions?, preserve_thread?: boolean = false })`: subject `"Fwd: ..."`; new thread by default; attachments resolved via `fetch_attachment` and re-attached.
- [ ] 4.10 Tool tests covering: query filter set; cap+truncate flag on recipients; `cached: boolean` projection; fetch_attachment cache-hit + cache-miss; attachment_to_path file-write; send_reply Reply-To precedence; send_reply_all recipient computation (incl. self-dedup) + BCC strip; send_forward with and without attachments + new-thread vs preserve-thread.
- [ ] 4.11 Bump `computeGroupMcpHash` input set to include all new tools + new query filters (mirroring the Trawl-config-in-hash pattern from read-power Codex P2). Hash test verifies the bump.

### Wave 5 — Backfill scripts
- [ ] 5.1 `scripts/enrich-mailroom.ts` skeleton: subcommands `--metadata-only` and `--blobs`. Per-account checkpointing in `meta.last_enriched_metadata_<account_id>` and `meta.last_enriched_blobs_<account_id>`. Same shape as `migrate-mirror.ts` for connection setup, blast-guard wrapping, audit phase.
- [ ] 5.2 Metadata pass: per account, paginated FETCH (envelope + bodystructure + selected headers) since last checkpoint; for each message, write recipient rows + list headers + attachment metadata + `messages` count/bytes columns inside a transaction; advance checkpoint after each batch.
- [ ] 5.3 Blob pass: `SELECT message_id, position, source_attachment_id FROM message_attachments WHERE NOT EXISTS (SELECT 1 FROM message_attachment_blobs WHERE message_id = ma.message_id AND position = ma.position) ORDER BY message_id, position`; for each row, fetch and INSERT. Naturally resumable; re-run after completion is a no-op.
- [ ] 5.4 Blast guard wraps both phases: pre/post counts on `message_recipients`, `message_attachments`, `message_attachment_blobs`; fail on >50% absolute change in either direction.
- [ ] 5.5 Self-audit at end: count parity between `messages.attachment_count` sum and `message_attachments` row count per account; recipient-row coverage on a sample.
- [ ] 5.6 Progress logging: every 500 messages emit `{event, phase, account, processed, total, eta_min}`.
- [ ] 5.7 Dry-run mode (`--dry-run`) for both phases: walk + count, no DB writes. Reports projected adds.

### Wave 6 — Deploy + Jeff-driven verification
- [ ] 6.1 Schema migration deploys cleanly: rebuild + restart mailroom-ingestor + inbox-mcp; "schema v5 → v6" log line; existing tests still green; no data loss.
- [ ] 6.2 Run `enrich-mailroom.ts --metadata-only --dry-run`. Review projected counts. Then real run. Expected wall: ~100 min (refine after Wave 1 numbers land).
- [ ] 6.3 Audit tools (`audit_recipients_coverage`, `audit_attachments_coverage`) return zero missing.
- [ ] 6.4 Run `--blobs --dry-run`, then real run. Expected wall: 1–8h (refine after Wave 1).
- [ ] 6.5 Madison container rebuild → fresh spawn; session-toolset hash log line confirms invalidation.
- [ ] 6.6 (Jeff-driven) AC-V1 — `addressed_to_me=true` Bob-late-payment-style query.
- [ ] 6.7 (Jeff-driven) AC-V2 — `is_list_mail=true` spot-check.
- [ ] 6.8 (Jeff-driven) AC-V3 — `has_attachments + attachment_name_matches='\.pdf$'`.
- [ ] 6.9 (Jeff-driven) AC-V4 — fetch_attachment cache-hit + cache-miss paths.

### Wave 7 — Lode graduation + plan close
- [ ] 7.1 Update `lode/architecture/madison-pipeline.md`: extend the data-model section + Mermaid diagram with the three new tables; add the three-state design discussion.
- [ ] 7.2 Update `lode/infrastructure/mailroom-mirror.md`: add a "Recipient + list-header + attachment layer" subsection covering ingest, query, fetch, and backfill flows. Refresh the Wave 5.8 shape contract description to include the new tables.
- [ ] 7.3 Update `lode/terminology.md`: add `recipients`, `list_id`, `list_unsubscribe`, `attachment_count`, `state-1/2/3 attachment`, `metadata pass`, `blob pass`.
- [ ] 7.4 Refresh `lode/summary.md` if the high-level mirror description needs it.
- [ ] 7.5 Add to `lode/lode-map.md`: the new plan moves from active to complete; the data-model graduation links land in the right sections.
- [ ] 7.6 Move plan dir `active/2026-04-message-enrichment/` → `complete/`.

## Deferred (explicitly out of scope)

Each is a follow-up plan or tech-debt entry, captured here so a future engineer doesn't ship it by reflex.

- **`mcp__inbox__attachment_to_markdown`** — server-side dispatch on MIME, returns markdown directly (single MCP call instead of fetch + skill). Build on top of `attachment_to_path` + the document-to-markdown skill only if Madison repeatedly does the two-step on hot paths.
- **`mcp__inbox__unsubscribe`** — uses `messages.list_unsubscribe` to fire either the `mailto:` action or HTTP POST per RFC 8058. Distinct concern; lands after we've seen real list-id coverage post-backfill.
- **Rule-engine recipient/list-id conditions** — once recipients are queryable, `mailroom/src/rules/schema.md` gains `addressed_to_me_only` / `is_list_mail` / `cc_count_gt` / etc. Schema bump on the rules file; touches the rule-engine evaluator. Separate plan.
- **Storage tiering** — `TD-MAIL-ATTACHMENT-TIERING`: auto-expire blobs older than N years to drop back to state 2. Pure SQL DELETE; tool transparently re-fetches on demand. Capture as tech-debt entry once enrichment lands.
- **Per-format MCP extracts (`extract_pdf`, `extract_xlsx`, ...)** — superseded by the document-to-markdown skill + `attachment_to_path`. Recorded as deliberately-not-built so future engineers don't ship them by reflex.
- **High-accuracy PDF mode (`marker` / `docling` opt-in)** — for academic-style PDFs with complex tables or equations, the document-to-markdown skill could grow an `--accuracy=high` flag that uses `marker` (datalab) or `docling` (IBM) instead of markitdown. Heavier (~5 GB ML models, GPU recommended). Add only if markitdown's PDF table quality bites in practice.

## Errors

| Error | Resolution |
|---|---|

*(none yet)*

## Current status

**Not started.** Plan drafted 2026-04-25 after closing `madison-read-power`. Awaits branch + go-ahead. Wave 1 (size discovery) should run first to put real numbers on the Wave 5 cost estimates before committing.
