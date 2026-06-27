---
name: subagent-output-contract
description: Output contract for subagents spawned via the Task tool. Keep returns short and structured — summary plus artifact path, never raw HTML or verbose tool output. Use when spawning subagents and when you ARE a subagent returning results to the orchestrator.
---

# Subagent Output Contract

Subagent transcripts are expensive — a single session averaged 14 subagents × 172KB JSONL each. Most of that was raw fetch output being dragged back into the orchestrator's context. This contract fixes that.

Applies in two directions:

1. **When you are the orchestrator spawning a Task** — include the contract in the subagent prompt so it knows the expected return shape.
2. **When you are the subagent returning results** — follow the contract yourself. Your final message to the orchestrator is the return value; keep it tight.

## The return shape

Return exactly three blocks, in this order:

1. **Summary** — 2 to 5 sentences. What was done, what was found, what matters. No preamble, no "I started by…".
2. **Structured data** — if any. CSV, JSON, bullet list, or table. Only include it inline if it is genuinely small (under ~50 rows or ~2KB). Otherwise write it to a file and reference the path.
3. **Artifact paths** — absolute paths to any files produced (Obsidian notes, CSVs, screenshots, transcripts). One per line under a `Files:` header.

## What must NOT appear in the return

- Raw HTML, page source, or full `WebFetch` / `mcp__trawl__inspect_page` output.
- Full tool-call traces ("I ran X, it returned Y, then I ran Z…"). The orchestrator does not need the play-by-play.
- Long quotes from scraped pages. Quote at most one short paragraph if it is load-bearing; otherwise summarize and link.
- Apologies, hedges, meta-commentary ("as an AI…", "I hope this helps").
- Reprinting file contents you just wrote. Reference them by path.

## If a caller needs the raw data

Write it to a file (Obsidian note, CSV in the group folder, or `/tmp/` for truly transient data) and return the path. The orchestrator can `Read` or `Grep` it on demand. This keeps the orchestrator's context window clean while preserving all the data.

## Example — good return

```
Summary: Scraped the 67 Florida county GOP chair pages. 58 had email + phone; 9 had
only a contact form. Wrote the full list to the Obsidian vault.

Files:
/workspace/extra/obsidian/AmericanVoxPop/Organizations/FL GOP Chairs 2026-04.md
/workspace/group/_attachments/fl-gop-chairs-2026-04.csv
```

## Example — bad return (do not do this)

```
I started by searching for the Florida GOP site. Here is the HTML I retrieved:

<html><head><title>Florida GOP</title>...5000 lines of HTML...</html>

Then I parsed each county page. Alachua County page returned:
<div class="chair">...800 lines...</div>

(continues for 60KB of transcript)
```

The orchestrator has no need for any of this — it needs the summary and the paths.

## When spawning subagents (orchestrator side)

Append this line to the Task prompt:

> Return results per the `subagent-output-contract` skill: 2-5 sentence summary, optional small structured data, and absolute file paths for any artifacts. Do NOT paste raw page content, HTML, or verbose tool traces.

That is enough — the subagent will load this skill on its own.
