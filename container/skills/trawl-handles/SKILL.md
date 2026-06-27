---
name: trawl-handles
description: Trawl MCP tools (mcp__trawl__inspect_pages, crawl_links, extract_documents, deep_inspect_pages) return a compact summary plus a handle_id pointing at a richer dataset in Trawl's data store. Use get_page_data or query_data to drill into specific categories without re-fetching. Load when you're about to inspect a page or when a prior Trawl tool result mentioned a handle.
---

# Trawl Handle-Based Return Pattern

Trawl's heavier scraping tools don't inline the full page/document content in their tool response. Instead they return:

1. A **compact summary** (metadata, heading outline, link counts, table shapes, etc.)
2. A **handle_id** (sometimes embedded as the URL key, sometimes called out explicitly)
3. Hints about what categories of data are available

This keeps your context window from getting dumped on with 200KB of HTML when you only wanted the tables. The tradeoff: you have to know how to fetch the richer data when you need it.

## Tools that return handles

- `mcp__trawl__inspect_pages` — single or multi-URL inspection. Summary returned; full content categories (`metadata`, `headings`, `links`, `tables`, `json_ld`, `network_json`, `inline_data`, `images`, `forms`, `documents`, `content`, `screenshot`) reachable via `get_page_data`.
- `mcp__trawl__deep_inspect_pages` — same pattern, deeper analysis.
- `mcp__trawl__crawl_links` — crawl summary + per-URL handles.
- `mcp__trawl__extract_documents` — document metadata + content handles.

## Tools that resolve handles

- `mcp__trawl__get_page_data(url, category)` — fetch a specific category of a previously-inspected URL. Example: after `inspect_pages(url)` returned 33 tables in its summary, call `get_page_data(url, "tables")` to get the full table data.
- `mcp__trawl__query_data(handle_id, ...)` — more general handle resolution. Use when a tool output references a handle_id explicitly rather than by URL.
- `mcp__trawl__list_data()` — list active handles in the current data store.

## When to drill in

| You need | Right tool |
|---|---|
| The full text of a page you already inspected | `get_page_data(url, "content")` |
| All 33 tables from an inspected page | `get_page_data(url, "tables")` |
| Just the headings outline | `get_page_data(url, "headings")` |
| A screenshot | `get_page_data(url, "screenshot")` |
| Something from a multi-result crawl | `query_data(handle_id, ...)` |
| "What handles do I have?" | `list_data()` |

## Anti-patterns

- **Re-fetching the whole page** with another `inspect_pages(url)` call when you just need a specific category. Use `get_page_data(url, category)` instead — it's free (cached).
- **Inlining full content into your prompt** when downstream logic only needs structured excerpts. Pull only what you'll use.
- **Ignoring the summary** and jumping straight to `get_page_data("content")` — the summary often has everything you need (link counts, table shapes, metadata). Read it first.

## Example

```
inspect_pages(urls=["https://example.com/directory"])
→ returns: { results: [ { url: "...", summary: "... TABLES: 5 ... LINKS: 230 ..." } ] }

# Summary says there are 5 tables. If you need them:
get_page_data(url="https://example.com/directory", category="tables")
→ returns the structured table data

# Or if you just want the contact section:
get_page_data(url="https://example.com/directory", category="content")
→ returns the full rendered text
```

Trawl's cache stores the page once; every `get_page_data` call reads from the cache, not the network.
