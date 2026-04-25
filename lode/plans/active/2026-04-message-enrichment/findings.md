# Findings — Message Enrichment

## Pre-plan reconnaissance (2026-04-25)

### Current state of the mailroom mirror (what's missing)

`messages` table at schema v5 has only `sender_id` (FK to `senders` — From only) and `raw_headers_json TEXT` (described "for debugging", null in practice — every test fixture passes null and ingest paths don't populate it). No `to_*` / `cc_*` / `bcc_*` / `reply_to_*` columns; no recipients table; no list-header columns; no attachment table; no attachment_count.

`mcp__inbox__query` filter set (per `mcp/tools/query.ts:68`): `sender`, `account_*`, `source`, `direction`, `received_*`, `subject_contains/matches`, `body_contains/matches`, label filters. No recipient or attachment filters.

Gmail poller (`gmail/poller.ts:235-237`) extracts From / Subject / Date / Message-ID / References / In-Reply-To from `payload.headers`. To/Cc/Bcc/Reply-To/List-* are unread. `payload.parts` is unwalked.

Proton poller (`proton/poller.ts`) consumes `envelope.from` / `envelope.subject` / `envelope.date` / `envelope.messageId` / `envelope.inReplyTo`. `envelope.to` / `envelope.cc` / `envelope.bcc` / `envelope.replyTo` are unread. BODYSTRUCTURE is unfetched.

### Proton Bridge has no on-disk message cache

Inspected the `protonmail-bridge` Docker container:
- `/root/.config/protonmail/bridge-v3/` contents: `vault.enc` (6KB), `keychain.json`, `keychain_state.json`, `grpcFocusServerConfig.json`, an empty `imap-sync/sync-<hash>` directory, and an empty `insecure/` dir.
- `/root/.cache/protonmail/bridge-v3/` contents: `bridge-v3.lock` (2 bytes), `notifications/` (empty), `observability_cache/`, `unleash_cache/`, `unleash_startup_cache/`.
- Total bridge state: 32K config + 16K cache.

Bridge v3 is a thin runtime proxy: every IMAP fetch decrypts a freshly-fetched API response in memory and serves it via IMAP. No bodies, no attachments, no SQLite cache on disk. The IMAP backfill walk we'll do for enrichment **will** force the bridge to fetch every message from the Proton API.

This makes the "backup" argument for caching attachment blobs locally meaningfully stronger: store.db is the only place Jeff can have an offline copy. btrfs hourly snapshots at `~/containers/data/.snapshots/mailroom/` plus the SQLCipher key in env-vault + password manager give it a real cold-storage story.

### Disk + storage context

- `~/containers/data` subvolume: 932 GB free (1.0 TB total, 92 GB used).
- Current `~/containers/data/mailroom/store.db`: 4.3 GB.
- Subvolume has compression on, but SQLCipher encrypts pages before btrfs sees them (max-entropy bytes), so compression is effectively disabled for the store.db extents. This is fine — encryption-at-rest is more valuable than compression for this workload, and the dominant attachment formats (PDF/.docx/.xlsx/images) are pre-compressed inside their own containers anyway.

### Backfill cost ballpark (pre-measurement)

- 60,166 total messages mirrored ≈ 59,000 Proton + ~1,000 Gmail (per the read-power tracker's label-count ratio: 190,296 Proton folder memberships + 1,784 Gmail labels).
- Bridge IMAP throttle: empirically ~1–3 messages/sec/account. Five Proton accounts in parallel ≈ 10 msg/sec aggregate.
- Metadata-only pass (envelope + bodystructure + selected headers, one round-trip per message): 59k / 10 ≈ ~100 min wall.
- Blob fetch pass: depends entirely on attachment volume + size distribution. Order-of-magnitude estimate (10% of messages have attachments × ~500KB avg) is ~3 GB; wall could be 1–8h.

These numbers are best-effort. **Wave 1 (size discovery) replaces them with measured values before Wave 5 commits.** Update this section once the measurement script runs.

## Open questions (for later)

- Should the rule engine eventually condition on recipient or list-id fields? If yes, the rule schema (`mailroom/src/rules/schema.md`) needs new condition kinds; that's its own follow-up plan, not in scope here. The data must exist first.
- Should `mcp__inbox__fetch_attachment` cache fetched bytes back into `message_attachment_blobs` by default, or only on explicit opt-in? Current draft is "yes, env-flag-gated." Revisit after seeing real fetch volumes.
- Storage tiering policy (auto-expire blobs older than N years to drop back to state 2): out of scope for this plan, but the schema makes it a pure SQL DELETE — capture as `TD-MAIL-ATTACHMENT-TIERING` in `lode/tech-debt.md` once enrichment lands.

## Consumption-side design (2026-04-25 round 2)

After the storage shape settled, walked through what Madison actually needs to surface, reason about, and act on with this data.

### Default projection — recipients + attachments are not opt-in

Initial draft had `include_recipients?: boolean = false`. Re-thought: recipients and attachment metadata are part of "what is this message," not power-user detail. Opt-in defaults guarantee Madison silently misses them and produces one-sided summaries ("Bob emailed you about X" when actually you were CC'd on a thread Bob owns among 12 people).

Settled: default projection includes `recipients: { to[], cc[], bcc[], reply_to[] }` (capped at 20 per kind with `recipients_truncated: boolean`) and `attachments: [{ filename, mime_type, size_bytes, position, cached }]`. Implementation uses `LEFT JOIN ... GROUP_CONCAT` (or a single batch lookup `WHERE message_id IN (...)`) — O(N) not N+1. Opt-out (`include_recipients=false` / `include_attachments=false`) for rare bulk-aggregate queries. Full recipient list when capped via `mcp__inbox__get_recipients(message_id)`.

### `cached: boolean` per attachment in projection — free signal

The metadata projection already LEFT JOINs `message_attachments`; adding a second `LEFT JOIN message_attachment_blobs USING (message_id, position)` gives `cached: boolean` per attachment for free (PK-on-PK join, sub-millisecond). Madison sees, before deciding to forward or extract, which attachments are local-fast vs network-required. Immune to future caching policy changes — lazy / disabled / tiered all flip blob-row presence without touching the metadata join.

### Send-side tools (Wave 4 additions)

Currently Madison has `send_message` and `send_reply` but no Reply-All or Forward. Hand-composing those from scratch is error-prone: forgetting to dedup self, leaking BCC to the reply-all list, breaking threading. Three additions:

- **`send_reply` extension** — honor Reply-To when present, else From. One-line precedence rule. Newsletter senders, support queues, and shared mailboxes set Reply-To to the right destination; ignoring it sends to the wrong place.
- **`send_reply_all`** — `to = original_reply_to_or_from + (original_to − my_accounts)`, `cc = original_cc − my_accounts`, no BCC, threading preserved. BCC stripped by RFC + social convention.
- **`send_forward`** — caller-supplied recipients; subject `"Fwd: ..."`; new thread by default (`preserve_thread?: boolean = false` for the rare opt-in). `attachment_positions?: number[]` selects a subset of the original's attachments to re-attach; `include_attachments?: boolean = true` toggles all-or-none. Attachments resolved through the cache-first / source-fallback `fetch_attachment` path.

The `attachment_positions[]` integer key is exactly the position from `message_attachments` — schema fits the tools naturally.

### Content extraction — `attachment_to_path` only; conversion stays in container skills

Considered three options for letting Madison read PDF / XLSX / DOCX content:
- **A. Per-format MCP tools** (`extract_pdf`, `extract_xlsx`, `extract_docx`) — locks converter choice and options into the inbox-mcp service; duplicates capability the agent already has.
- **B. `attachment_to_path`** — fetches bytes (cache or source), writes to `/workspace/inbox-attachments/<msg>/<filename>`, returns the path. Madison feeds the path into existing container skills (`add-pdf-reader`, `add-image-vision`, future xlsx/docx readers).
- **C. `attachment_to_markdown`** — server-side dispatch on MIME, returns markdown text directly. One-shot, but full converted text bloats response payload + model context, and rebuilds capability that already lives in skills.

Settled: **B only, in this plan**. Smallest sufficient API. NanoClaw already centralizes content tools as skills operating on `/workspace` paths (PDF reader, image vision, voice transcription) — fitting the new format readers into that pattern keeps Madison's stack uniform. C and A captured in the Deferred section so a future engineer doesn't ship them by reflex.

### PDF → markdown specifically (deferred follow-up)

Called out by Jeff 2026-04-25: "PDF support conversion to markdown would be very nice." Existing `add-pdf-reader` uses `pdftotext` for plain text; markdown means preserving structure (headings, lists, tables, links). Backends to evaluate when this becomes its own plan:
- **markitdown** (Microsoft, MIT, multi-format including PDF / DOCX / XLSX / PPTX / HTML / images / audio, no GPU) — likely default; subsumes the need for separate xlsx/docx readers.
- **marker** (datalab, ML-based, higher quality but slower and GPU-friendly) — better for academic PDFs with tables.
- **docling** (IBM, research-quality table preservation).

Captured in the tracker's Deferred section as "high requested value." Lands as either an extension to `add-pdf-reader` (markdown mode) or a new `add-attachment-to-markdown` skill that uses markitdown across multiple formats.
