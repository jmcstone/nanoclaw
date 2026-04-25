# Progress — Document → Markdown Skill

## Reboot check

1. **Where am I?** Plan drafted as a committed companion to `2026-04-message-enrichment`. No code changes yet. Awaits branch + go-ahead.
2. **Where am I going?** Wave 1 — scaffold the `add-document-to-markdown` skill: SKILL.md following CONTRIBUTING.md format, container Dockerfile dep (`pip install markitdown[pdf,docx,xlsx,pptx,html]`), wrapper script that takes a `/workspace` path and emits markdown to stdout.
3. **What is the goal?** Madison can take any document attachment (PDF/DOCX/XLSX/PPTX/HTML/EPUB/CSV) fetched onto a `/workspace` path and turn it into readable markdown. Lands across Jeff's NanoClaw instances via `/update-nanoclaw`.
4. **What have I learned?** markitdown is the right default — pure Python, no GPU, multi-format, MIT, ~50 MB with per-format extras. Image and audio paths in markitdown are weaker than NanoClaw's existing `add-image-vision` and local-Whisper skills, so the new skill scopes to documents only and explicitly falls through. `marker` / `docling` give higher quality on complex PDFs but want a GPU and 5 GB of models — captured as a future opt-in heavy mode. Upstream PR before local production deploy keeps the multi-instance story clean.
5. **What have I done?** Drafted tracker.md (6 waves), findings.md (markitdown reconnaissance + alternatives + propagation strategy), progress.md.

## Sessions

### 2026-04-25 — plan authored

- Surfaced as a "would be very nice" follow-up to `2026-04-message-enrichment`; Jeff committed: "100% want this feature and the email attachments are low value without being able to easily have madison do something with them."
- Promoted from message-enrichment's Deferred section to a parallel committed plan.
- Walked through markitdown vs. marker vs. docling vs. pdftotext vs. pandoc; settled on markitdown for the lean / multi-format combination.
- Identified the image / audio fall-through pattern so the skill doesn't clobber NanoClaw's existing media skills.
- Confirmed container-only install (no host pip) matches NanoClaw's existing convention (`add-pdf-reader`, `add-image-vision`).
- Settled on upstream PR (`/update-nanoclaw` pickup pattern) as the hard prerequisite to local production deploy, so the skill reaches americanvoxpop + future instances without manual copying.
