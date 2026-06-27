---
name: research-dedupe
description: Before any web fetch or MCP research call (WebSearch, WebFetch, mcp__trawl__search_*, mcp__trawl__inspect_pages, mcp__trawl__extract_*, mcp__trawl__crawl_links), check the group's memory notes and the local Obsidian vault first. Use for every research task — re-scraping work the group has already done wastes tokens and time.
---

# Research Dedupe — Check Before You Fetch

Research in a group accumulates. The same question often comes back weeks later and the answer already lives in the group's memory notes or the Obsidian vault. **Always check local knowledge before hitting the web.**

## When to apply

Before calling any of:

- `WebSearch`, `WebFetch`
- `mcp__trawl__search_*` (web/news/academic)
- `mcp__trawl__inspect_pages`, `mcp__trawl__extract_*`, `mcp__trawl__crawl_links`, `mcp__trawl__deep_inspect_pages`, `mcp__trawl__get_page_data`
- `mcp__trawl__trawl_delegate` or `mcp__trawl__trawl_pipeline_run` for research tasks

## The check order

1. **Memory notes** — `Grep` over `/workspace/agent/memory/` for the topic (and `Glob` the filenames — research notes are often topically named). This is the group's durable, agent-written memory.
2. **Obsidian vault** — `Grep` over `/workspace/extra/obsidian/` (or the group-specific mount like `/workspace/extra/algotrader/`) for matching notes. Check filenames via `Glob` too.
3. **Only if both come up empty** — proceed with the web fetch.

If you find a partial answer (e.g. stale data, partial coverage), tell the user what you already have and ask whether to refresh or extend, rather than silently re-scraping.

## After a web fetch happens

Write a 1-3 sentence summary into `/workspace/agent/memory/memories/` as a small markdown note: what was fetched, the URL, the date, and the artifact path (if any). Name the file topically so the next query's grep finds it.

If the fetch produced a durable artifact (CSV, list, table), write it to the Obsidian vault (see group-specific practices for path) and reference that path from the memory note — don't inline large data in the note.

## Examples

**Example 1 — Florida county GOP chairs.** Telegram message: "get me all Florida county GOP chairs". Grep `/workspace/agent/memory/` for "Florida county chairs" → finds a note pointing at `_attachments/fl-gop-chairs-2026-03.csv`. Return the existing CSV path and ask if a refresh is wanted. Do not re-scrape.

**Example 2 — Company research on "Acme Corp".** Grep `/workspace/extra/obsidian/Organizations/` for "Acme" → finds `Acme Corp.md` with funding/leadership already filled. Summarize from the note; only fetch the web for gaps (e.g. recent news) and record a new memory note for the delta.

**Example 3 — New topic, no prior work.** Memory grep returns no hits, Obsidian grep empty. Proceed with WebSearch / `mcp__trawl__search_web`, then after summarizing write a memory note and (for durable artifacts) a new Obsidian note so the next query dedupes against this one.

## Pitfalls

- Fetching first, then checking memory "just to be thorough". The point is to save the fetch.
- Using memory only for facts about the user. The `memory/` tree is also the research cache — write research findings there.
