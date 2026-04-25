# Findings — Document → Markdown Skill

## markitdown reconnaissance (2026-04-25)

Microsoft-released Python library, late 2024. github.com/microsoft/markitdown, MIT-licensed, maintained by the AutoGen team. Pip-installable, pure Python, no GPU. CLI (`markitdown file.pdf`) and Python API (`MarkItDown().convert(path).text_content`).

### Format coverage + backend per format

| Format | Backend (under the hood) | Quality on typical content |
|---|---|---|
| PDF | pdfminer.six (text-only; no OCR by default) | Decent for text-heavy documents; weak on complex tables; loses math typography. Bounded by the fact that PDF has no semantic structure. |
| DOCX | python-docx + mammoth-style conversion | Genuinely good — DOCX has structured XML to read from. |
| XLSX | openpyxl → markdown table generator | Good; produces one markdown table per sheet. |
| PPTX | python-pptx | Decent, slide-by-slide. |
| HTML | beautifulsoup-style + cleanup | Good. |
| CSV / JSON / XML | structural | Good. |
| EPUB | ebook lib | Good. |
| ZIP | recursive over contents | Useful for multi-file bundles. |
| Images | EXIF + optional LLM caption (requires API key) | Falls behind dedicated vision tools. Skipped — NanoClaw has `add-image-vision`. |
| Audio | Whisper (requires API key) | Falls behind dedicated Whisper integrations. Skipped — NanoClaw has `use-local-whisper` running on Apple Silicon, no API call. |
| YouTube URLs | transcript fetch | Works. Out of scope here. |

### Why markitdown over alternatives

| Backend | Verdict |
|---|---|
| **`pdftotext`** (current `add-pdf-reader`) | Fast, well-tested, but plain text only — no heading detection, no table preservation. markitdown adds light structure on top. |
| **`marker`** (datalab, ML-based: Surya + Donut) | Substantially better tables, equations, multi-column reading order on academic / business docs. **But**: ~5 GB of models, GPU recommended, slower. Heavyweight for our container. Captured as a future "heavy mode" opt-in if quality bites. |
| **`docling`** (IBM, ML-based) | Similar to marker — research-grade table preservation, heavier deps. |
| **`pandoc`** PDF→md | Routes PDF→HTML→md via pdftohtml; quality is uneven and worse than markitdown for most cases. |
| **`markitdown`** | Mid-quality across the board, lightweight, pure Python, multi-format. Right default for our container. |

### Practical caveats

- **Encrypted PDFs** — markitdown fails. Skill must exit non-zero with a clear stderr message; pre-decrypt is out of scope.
- **Math / equations** — lost. PDFs that rely on TeX typography produce gibberish. marker / docling do better but are out of scope.
- **Complex multi-column PDFs** — reading order can break. Add `marker` as opt-in heavy mode later if this becomes a real problem; don't fight markitdown.
- **Memory** — loads whole document; fine to several MB, slower past that.
- **Streaming** — no, returns full text in one shot.
- **Encrypted ZIP / archives** — same fail-fast rule as encrypted PDFs.

### Integration shape for NanoClaw

Critical observation: markitdown's image and audio paths overlap with skills NanoClaw already has (`add-image-vision`, `add-voice-transcription` / `use-local-whisper`). Existing skills are better — no LLM API roundtrip for image captions, local Whisper on Apple Silicon for audio.

Clean separation: **the new skill scopes to document MIMEs only, falls through to existing skills for media**. Skill's wrapper script returns non-zero with a stderr pointer for image / audio paths so callers can route correctly. This keeps Madison's tool stack uniform — markitdown for documents, vision skill for images, Whisper skill for audio.

Image-size budget: per-format extras (`markitdown[pdf,docx,xlsx,pptx,html]`) ≈ 50 MB installed vs. `[all]` ≈ 150 MB. Lean install matches NanoClaw's pattern for other skills.

### Cross-instance propagation (Jeff's main + americanvoxpop + future)

NanoClaw skills don't auto-propagate; each instance is a separate repo clone with its own customizations. Two paths:

| Path | Effect |
|---|---|
| Apply locally only (`/add-document-to-markdown`) | Skill files land in this instance's `.claude/skills/` and `container/Dockerfile`. Other instances stay untouched. |
| **Push upstream** (chosen) | Land in the canonical NanoClaw repo as a `skill/add-document-to-markdown` branch per CONTRIBUTING.md. Each other instance runs `/update-nanoclaw` → cherry-picks the new skill addition into its customized install. One write, N instances. |

The upstream path is exactly what `/update-nanoclaw` exists for. It also gives the skill review + community visibility. AC-7 makes the upstream PR a hard prerequisite to local production deploy so we don't fork by accident.

## Open questions (for later)

- Does markitdown handle Proton-encrypted attachments, or does Bridge already decrypt at the IMAP layer? Need to verify in Wave 3 with a real Proton-sourced PDF — if Bridge decrypts inline (most likely), there's nothing to do; if it doesn't, we need a decrypt step before markitdown.
- Should the wrapper accept stdin in addition to a path, for streaming use cases? Not needed for `attachment_to_path` (always a real file), but might come up later. Defer until friction is real.
- Should the skill add a `--max-pages` truncation flag for huge PDFs? Madison would mostly want a summary; full conversion of a 200-page contract eats context. Capture as deferred — start without; add if the response payloads bite.
