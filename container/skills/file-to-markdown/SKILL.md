# File To Markdown

Use this when a user asks to read, summarize, extract, or analyze a local document or attachment that is not already plain text.

## What it does

Converts a local file inside the container to Markdown using the shared document conversion stack:
- `markitdown`
- `docling`

The wrapper normalizes output to JSON so you can read the Markdown directly.

## Command

    python /opt/doc-tools/file_to_markdown.py /path/to/file --pretty

Optional converter override:

    python /opt/doc-tools/file_to_markdown.py /path/to/file --converter markitdown --pretty
    python /opt/doc-tools/file_to_markdown.py /path/to/file --converter docling --pretty

## Guidance

- Prefer `auto` first.
- Use `docling` for PDFs and layout-heavy documents when `markitdown` looks weak.
- Use `markitdown` first for Office docs and spreadsheets unless you have a reason to force `docling`.
- After conversion, quote or summarize from the returned `markdown` field.
- If conversion fails, inspect the `warnings` and `last_error` fields before retrying with the other converter.
