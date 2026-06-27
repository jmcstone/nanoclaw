---
name: wiki
description: Read from and write to Jeff's LLM-compiled knowledge base (the "wiki"). Use when the user asks to remember, save, ingest, or "add to the wiki"; to compile/synthesize ingested sources into articles; or to answer a factual/research question that the wiki may already cover ("what do we know about X", "check the wiki", "look it up in my notes"). The wiki is a shared, Obsidian-native knowledge base also used by Jeff on the desktop — treat it as durable long-term memory distinct from per-group chat memory.
---

# LLM Wiki (container)

A knowledge base that you (the LLM) both compile and query. Sources are ingested into an immutable `raw/`, then synthesized into interconnected markdown articles under `wiki/`. No external tools — you are the compiler and the query engine.

This is the same hub Jeff works in from his desktop (Claude/Codex), and it lives inside his Obsidian vault, so every file is plain markdown with YAML frontmatter and `[[wikilinks]]`. Writes are concurrency-safe (last-write-wins; indexes rebuild from files).

## Hub location (container override)

The hub is mounted **read-write at `/workspace/extra/wiki`**. Use that path directly. Ignore any instruction in the reference docs to resolve the hub from `~/.config/llm-wiki/config.json` or `~/wiki/` — those apply on the desktop, not here. Throughout the references, **`HUB/` means `/workspace/extra/wiki/`**.

If `/workspace/extra/wiki/` does not exist, this group has no wiki mount — say so; do not invent one.

## Structure

```
/workspace/extra/wiki/        # HUB — lightweight, tracks topics only
├── wikis.json                # registry of topic wikis
├── _index.md                 # hub index
├── log.md                    # append-only activity log
└── topics/<name>/            # each topic is a full wiki
    ├── _index.md  config.md  log.md
    ├── inbox/                # drop zone
    ├── raw/{articles,papers,repos,notes,data}/   # immutable sources
    ├── wiki/{concepts,topics,references}/         # compiled articles
    └── output/               # generated artifacts
```

Content never lives at the hub root — only in `topics/<name>/`. See `references/wiki-structure.md` for the full layout and all file/frontmatter formats.

## Core principles

1. **Raw is immutable.** Once written to `raw/`, a source is never edited. It records what was ingested and when. All synthesis happens in `wiki/`.
2. **Articles are synthesized, not copied.** An article draws from multiple sources, contextualizes, and connects to other concepts. Think textbook, not clipboard. Never paste source text.
3. **Dual-link** every cross-reference for Obsidian + agent: `[[slug|Name]] ([Name](../category/slug.md))`.
4. **Frontmatter is structured data.** Every `.md` has YAML frontmatter (title, summary, tags, dates, `confidence`). It makes the wiki searchable without full-text scans.
5. **Indexes are a derived cache.** The `.md` files are the source of truth; `_index.md` files are rebuilt from frontmatter when stale. Read indexes first to navigate, but stale-check (file count vs rows) before trusting one. See `references/indexing.md`.
6. **Honest gaps.** If the wiki doesn't have the answer, say so and suggest what to ingest. Never hallucinate wiki content.
7. **Append-only log.** Every operation appends one line to the topic's `log.md` and the hub `log.md`: `## [YYYY-MM-DD] operation | description`. Never edit/delete existing entries.

## Workflows

### Query (answer from the wiki)
1. Read the hub `_index.md` and `wikis.json` to find the relevant topic.
2. Read that topic's `_index.md` → pick articles by summary/tag → read them.
3. Follow "See Also" dual-links; `grep` `raw/` and `wiki/` for extra matches.
4. Answer **with citations** (article paths) and note `confidence`. Flag gaps.

### Ingest (capture a source)
1. Classify the source → `raw/articles|papers|repos|notes|data/` (URL/blog → articles, arxiv/PDF → papers, github/gitlab → repos, freeform/tweet → notes, small csv/json → data).
2. Fetch/read it, write one immutable source file with full frontmatter.
3. Update the affected `raw/_index.md`. If 5+ sources are now uncompiled, suggest compiling.
Full rules (frontmatter fields, collection imports, large data → dataset registry): `references/ingestion.md`.

### Compile (synthesize sources → articles)
1. Survey: read `raw/_index.md` and `wiki/_index.md`; find sources newer than the last compile date.
2. Extract key concepts/facts/relationships; map each to an existing article (UPDATE) or a new one (CREATE), classified concept / topic / reference.
3. Write/update articles: abstract, synthesized body, dual-linked "See Also", a `sources:` block with exact raw paths, `aliases`, and `confidence`. If authored from conversation rather than raw files, set `compiled-from: conversation`.
4. Rebuild every touched `_index.md`.
Full loop: `references/compilation.md`.

### Create a topic (first time)
If no topic fits, create `topics/<slug>/` with the structure above (empty `_index.md` in each dir), register it in `wikis.json` as `"<slug>": { "path": "topics/<slug>", "description": "...", "status": "active" }`, then ingest into it.

## Notes

- **Wiki vs chat memory.** The wiki is durable, cross-group, Jeff-facing knowledge. Per-group a-mem / context-mode is conversational memory. Put research and reference knowledge in the wiki; leave ephemeral chat state in a-mem.
- **Check the wiki before the web.** For research questions, query the wiki (and a-mem / vault per the research-dedupe skill) before fetching — the answer may already be compiled.
- Chunk large writes: write the skeleton (frontmatter + headers) first, then append sections with edits — don't emit 200+ line files in one shot.
