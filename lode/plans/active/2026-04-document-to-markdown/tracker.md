# Document → Markdown Skill (markitdown)

Branch: `feat/document-to-markdown` (to be created when work starts; plan currently authored on `fix/morning-brief-audit`).

Companion plan to [2026-04-message-enrichment](../2026-04-message-enrichment/tracker.md). Ships in lockstep at that plan's Wave 6 verification, but development can start in parallel — the skill works on any `/workspace` path (attachments, manually-dropped files, future Drive sync).

## Goal

Ship a NanoClaw container skill `add-document-to-markdown` that converts document attachments on a `/workspace` path to LLM-friendly markdown via `markitdown` (Microsoft, MIT-licensed). Covers PDF / DOCX / XLSX / PPTX / HTML / EPUB / CSV. Image and audio attachments fall through to existing skills (`add-image-vision`, `add-voice-transcription` / `use-local-whisper`). Land upstream so all NanoClaw instances (Jeff main, americanvoxpop, future) can pick it up via `/update-nanoclaw`.

## Read first

- [CONTRIBUTING.md](../../../../CONTRIBUTING.md) — feature-skill PR flow (skill-branch + SKILL.md + container changes + pre-submission checklist).
- `.claude/skills/add-pdf-reader/` — shape reference: SKILL.md format, container Dockerfile additions, wrapper-script pattern. The new skill follows this template.
- `.claude/skills/add-image-vision/`, `.claude/skills/add-voice-transcription/` — fall-through targets for image / audio MIME types (the new skill must NOT clobber these).
- [container/build.sh](../../../../container/build.sh) — image build entrypoint; the build-cache gotcha noted in the project CLAUDE.md applies (prune builder volume on stale COPY).
- [2026-04-message-enrichment](../2026-04-message-enrichment/tracker.md) — companion plan; the `attachment_to_path` MCP tool from its Wave 4 is the primary upstream caller of this skill.

## Acceptance criteria

- AC-1 `add-document-to-markdown` skill exists in `.claude/skills/` with a SKILL.md that follows CONTRIBUTING.md's format rules.
- AC-2 Skill installs `markitdown[pdf,docx,xlsx,pptx,html]` (per-format extras, not `[all]`) into the container image. Per-format selection keeps the image lean (~50 MB vs ~150 MB).
- AC-3 Wrapper script (`/usr/local/bin/document-to-markdown` or similar) takes a single argument — a path under `/workspace` — and emits markdown to stdout. Non-zero exit + stderr message on encrypted PDF, unsupported format, or read failure.
- AC-4 The skill dispatches by MIME (or extension fallback): document MIMEs go to markitdown; image / audio MIMEs return a non-zero exit + stderr pointing at the existing skill ("use add-image-vision for image/jpeg paths"). Caller is expected to route by MIME before invoking.
- AC-5 Sample-fixture tests in `tests/skills/add-document-to-markdown/`: one PDF (text-heavy), one DOCX, one XLSX (multi-sheet), one PPTX, one encrypted PDF. Asserts stdout contains expected substrings + correct exit codes.
- AC-6 Container rebuild via `./container/build.sh` picks up the new dependency cleanly; image size delta documented in findings.md.
- AC-7 Upstream PR opened per CONTRIBUTING.md (skill-branch `skill/add-document-to-markdown`); merged before the message-enrichment plan's Wave 6 deploy.
- AC-8 (Cross-plan) Madison successfully runs `attachment_to_path` → `document-to-markdown <path>` end-to-end against a real fetched PDF + DOCX + XLSX from her inbox during message-enrichment Wave 6 verification.

## Decisions (locked)

| Decision | Rationale |
|---|---|
| `markitdown` as default backend | MIT-licensed, pure Python, no GPU, ~50 MB install with per-format extras. Multi-format (PDF/DOCX/XLSX/PPTX/HTML/EPUB/CSV) — one skill replaces what would otherwise be three (`add-pdf-to-markdown` + `add-xlsx-reader` + `add-docx-reader`). Office formats convert genuinely well; PDFs are bounded by pdfminer's structure-blindness, but acceptable for text-heavy docs. |
| `marker` / `docling` deliberately not used | Both add ~5 GB of ML models and want a GPU for reasonable throughput. Heavyweight for our container. Captured as a future "heavy mode" opt-in (`--accuracy=high`) if PDF table quality bites in practice. |
| Per-format extras (`[pdf,docx,xlsx,pptx,html]`), not `[all]` | Image (PIL+EXIF+LLM-caption) and audio (Whisper API) extras would duplicate existing skills' capability and pull a heavier dep set. Lean install. |
| One combined skill, not three (`add-pdf-to-markdown` + `add-xlsx-reader` + `add-docx-reader`) | Single backend, single dispatch, single SKILL.md, single test fixture set. Madison's tool stack stays uniform; users learn one entry point. |
| Skill scope is documents only; images / audio explicitly fall through to existing skills | `markitdown`'s image and audio paths are weaker than NanoClaw's existing `add-image-vision` and local-Whisper integrations (and require external API keys). Documenting the fall-through in the skill's stderr message keeps callers from accidentally leaning on the worse path. |
| Container-only install (no host pip) | NanoClaw convention — every dependency lives inside the container image so the host stays clean across rebuilds. Matches `add-pdf-reader`, `add-image-vision`, etc. |
| Upstream PR before local production use | One write reaches all NanoClaw instances via `/update-nanoclaw`. Avoids drift between Jeff main, americanvoxpop, and any future install. |

## Phases / Waves

### Wave 0 — Pre-reqs
- [ ] 0.1 Spin up branch `feat/document-to-markdown` on this NanoClaw instance.
- [ ] 0.2 Read `.claude/skills/add-pdf-reader/SKILL.md` + supporting files for the template.
- [ ] 0.3 Confirm `./container/build.sh` builds clean against current `main` before any changes.

### Wave 1 — Skill scaffold + container deps
- [ ] 1.1 `skill/add-document-to-markdown/SKILL.md` — name, description, when-to-use triggers (matches the operational-skill format used by other `/add-*` skills in this repo).
- [ ] 1.2 Update `container/Dockerfile` (or `container/setup.sh` — wherever container deps live in this install): `pip install --no-cache-dir 'markitdown[pdf,docx,xlsx,pptx,html]'`.
- [ ] 1.3 Wrapper script `container/skills/document-to-markdown` (Python or sh): takes `$1` = path, runs `from markitdown import MarkItDown; print(MarkItDown().convert(path).text_content)`, exits non-zero on exception with stderr message.
- [ ] 1.4 Document the MIME dispatch in SKILL.md so callers route image / audio elsewhere.

### Wave 2 — Tests
- [ ] 2.1 Sample fixtures in `tests/skills/add-document-to-markdown/`: `sample.pdf` (text-heavy, 5-10 pages), `sample.docx`, `sample.xlsx` (2 sheets, mixed types), `sample.pptx`, `encrypted.pdf` (password-protected).
- [ ] 2.2 Test runner — shell or vitest harness — invokes the wrapper against each fixture, asserts stdout substring + exit code. Encrypted PDF asserts exit != 0 + stderr mentions "encrypted" or "password".
- [ ] 2.3 Image size delta measurement: `./container/build.sh` before vs. after; record in findings.md.
- [ ] 2.4 `tsc --noEmit` zero errors; existing test suite unaffected.

### Wave 3 — Local validation
- [ ] 3.1 Rebuild container, restart Madison, manually drop a known-good PDF in `/workspace`, confirm `document-to-markdown /workspace/sample.pdf` returns sane markdown.
- [ ] 3.2 Same for DOCX, XLSX, PPTX, HTML.
- [ ] 3.3 Manually drop an image in `/workspace` and confirm the skill exits with the documented "use add-image-vision" stderr message — does NOT silently produce garbage.

### Wave 4 — Upstream PR
- [ ] 4.1 Push `skill/add-document-to-markdown` branch to upstream NanoClaw repo.
- [ ] 4.2 Open PR per CONTRIBUTING.md: title, summary, test-plan checklist, sample-output snippets per format.
- [ ] 4.3 Address review feedback.
- [ ] 4.4 Merge.

### Wave 5 — Cross-plan integration (timed with message-enrichment Wave 6)
- [ ] 5.1 With message-enrichment Wave 4 deployed: Madison fetches a real PDF attachment via `attachment_to_path`, runs `document-to-markdown` on the returned path, returns the markdown content in a chat reply. End-to-end verified.
- [ ] 5.2 Same for a real DOCX and a real XLSX from Jeff's actual inbox.
- [ ] 5.3 Confirm AC-V4 of the message-enrichment plan: cache-hit (state-3) and cache-miss (state-2) attachment fetches both feed the skill correctly.
- [ ] 5.4 (Other instances) `/update-nanoclaw` on americanvoxpop + any other Jeff instance to pick up the upstream skill addition. Verify each rebuilds cleanly.

### Wave 6 — Lode graduation + plan close
- [ ] 6.1 Add a brief mention to `lode/summary.md` ("agent containers can convert PDF/Office attachments to markdown via the document-to-markdown skill").
- [ ] 6.2 Update `lode/practices.md` if any new gotchas surfaced (e.g., container build cache, encrypted-PDF handling).
- [ ] 6.3 Move plan dir `active/2026-04-document-to-markdown/` → `complete/`.

## Errors

| Error | Resolution |
|---|---|

*(none yet)*

## Current status

**Not started.** Plan drafted 2026-04-25 in lockstep with `2026-04-message-enrichment`. Awaits branch + go-ahead. Can start in parallel with the enrichment plan — skill operates on any `/workspace` path and has standalone value (manually-dropped docs, future Drive sync) even before enrichment ships.
