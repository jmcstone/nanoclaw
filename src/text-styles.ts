/**
 * parseTextStyles — convert Claude's Markdown output to channel-native formatting.
 *
 * Claude outputs standard Markdown. Each channel has its own text style syntax:
 *   - Signal:    passthrough (SignalChannel handles rich text styles natively
 *                via the signal-cli JSON-RPC textStyle param — see parseSignalStyles)
 *   - WhatsApp:  *bold*, _italic_, no headings, plain links
 *   - Slack:     *bold*, _italic_, <url|text> links
 *   - Telegram:  HTML — <b>, <i>, <s>, <code>, <pre>, <a>; GFM tables → <pre>;
 *                paired with parse_mode: 'HTML' in src/channels/telegram.ts.
 *   - Discord:   passthrough (already Markdown)
 *
 * Code blocks (fenced and inline) are NEVER transformed by marker substitution.
 */

export type ChannelType =
  | 'signal'
  | 'whatsapp'
  | 'telegram'
  | 'slack'
  | 'discord';

/** Transform Markdown text for the target channel's native format. */
export function parseTextStyles(text: string, channel: ChannelType): string {
  if (!text) return text;

  // Discord and Signal are passthrough — no marker substitution.
  // Discord is already Markdown; Signal uses parseSignalStyles() for rich text.
  if (channel === 'discord' || channel === 'signal') return text;

  // Telegram uses HTML parse_mode — needs its own pipeline because every
  // segment (code, tables, body text) gets HTML-escaped and wrapped in tags.
  if (channel === 'telegram') return transformTelegramHtml(text);

  // Split into protected (code) and unprotected regions, transform only the latter.
  const segments = splitProtectedRegions(text);
  return segments
    .map(({ content, protected: isProtected }) =>
      isProtected ? content : transformSegment(content, channel),
    )
    .join('');
}

// ---------------------------------------------------------------------------
// Signal rich-text formatting
// ---------------------------------------------------------------------------

export interface SignalTextStyle {
  /** One of Signal's supported text styles. */
  style: 'BOLD' | 'ITALIC' | 'STRIKETHROUGH' | 'MONOSPACE' | 'SPOILER';
  /** Start position in the final message string, in UTF-16 code units. */
  start: number;
  /** Length of the styled range, in UTF-16 code units. */
  length: number;
}

/**
 * Parse Claude's Markdown into a plain string + Signal textStyle ranges.
 *
 * The returned `text` has all markdown markers stripped.  The `textStyle`
 * array uses UTF-16 code-unit offsets (JavaScript's native string indexing),
 * matching what signal-cli's JSON-RPC `send.textStyle` param expects.
 *
 * Supported patterns:
 *   **bold**          → BOLD
 *   *italic*          → ITALIC
 *   _italic_          → ITALIC
 *   ~~strike~~        → STRIKETHROUGH
 *   `inline code`     → MONOSPACE
 *   ```code block```  → MONOSPACE
 *   ## Heading        → BOLD (markers stripped)
 *   [text](url)       → "text (url)"  (no style)
 *   ---               → removed
 */
export function parseSignalStyles(rawText: string): {
  text: string;
  textStyle: SignalTextStyle[];
} {
  const textStyle: SignalTextStyle[] = [];
  let out = '';
  let i = 0;
  const s = rawText;
  const n = s.length;

  function addStyle(
    style: SignalTextStyle['style'],
    startOut: number,
    endOut: number,
  ): void {
    const length = endOut - startOut;
    if (length > 0) textStyle.push({ style, start: startOut, length });
  }

  while (i < n) {
    // ── Fenced code block  ```[lang]\n...\n``` ──────────────────────────
    if (s[i] === '`' && s[i + 1] === '`' && s[i + 2] === '`') {
      const langNl = s.indexOf('\n', i + 3);
      if (langNl !== -1) {
        // Find closing ``` on its own line
        const closeAt = s.indexOf('\n```', langNl);
        if (closeAt !== -1) {
          const content = s.slice(langNl + 1, closeAt);
          const startOut = out.length;
          out += content;
          addStyle('MONOSPACE', startOut, out.length);
          // Advance past \n``` + optional trailing newline
          const afterClose = s.indexOf('\n', closeAt + 4);
          i = afterClose !== -1 ? afterClose + 1 : n;
          continue;
        }
      }
      // Malformed fence — copy literally
      out += s[i];
      i++;
      continue;
    }

    // ── Inline code  `text` ────────────────────────────────────────────
    if (s[i] === '`') {
      const end = s.indexOf('`', i + 1);
      const nl = s.indexOf('\n', i + 1);
      if (end !== -1 && (nl === -1 || end < nl)) {
        const content = s.slice(i + 1, end);
        const startOut = out.length;
        out += content;
        addStyle('MONOSPACE', startOut, out.length);
        i = end + 1;
        continue;
      }
    }

    // ── Bold  **text** ─────────────────────────────────────────────────
    if (s[i] === '*' && s[i + 1] === '*' && s[i + 2] && s[i + 2] !== ' ') {
      const end = s.indexOf('**', i + 2);
      if (end !== -1 && s[end - 1] !== ' ') {
        const content = s.slice(i + 2, end);
        const startOut = out.length;
        out += content;
        addStyle('BOLD', startOut, out.length);
        i = end + 2;
        continue;
      }
    }

    // ── Strikethrough  ~~text~~ ────────────────────────────────────────
    if (s[i] === '~' && s[i + 1] === '~' && s[i + 2] && s[i + 2] !== ' ') {
      const end = s.indexOf('~~', i + 2);
      if (end !== -1) {
        const content = s.slice(i + 2, end);
        const startOut = out.length;
        out += content;
        addStyle('STRIKETHROUGH', startOut, out.length);
        i = end + 2;
        continue;
      }
    }

    // ── Italic  *text*  (single star, not part of **) ─────────────────
    if (
      s[i] === '*' &&
      s[i + 1] !== '*' &&
      s[i + 1] !== ' ' &&
      s[i + 1] !== undefined
    ) {
      const end = findClosingStar(s, i + 1);
      if (end !== -1) {
        const content = s.slice(i + 1, end);
        const startOut = out.length;
        out += content;
        addStyle('ITALIC', startOut, out.length);
        i = end + 1;
        continue;
      }
    }

    // ── Italic  _text_  (only at word boundaries) ──────────────────────
    if (s[i] === '_' && s[i + 1] !== '_' && s[i + 1] !== ' ' && s[i + 1]) {
      // Guard against snake_case: only treat as italic when preceded by a
      // non-word character (or start of string).
      const prevChar = i > 0 ? s[i - 1] : '';
      if (!/\w/.test(prevChar)) {
        const end = findClosingUnderscore(s, i + 1);
        if (end !== -1) {
          const content = s.slice(i + 1, end);
          const startOut = out.length;
          out += content;
          addStyle('ITALIC', startOut, out.length);
          i = end + 1;
          continue;
        }
      }
    }

    // ── ATX Heading  ## text → text (as BOLD) ─────────────────────────
    if ((i === 0 || s[i - 1] === '\n') && s[i] === '#') {
      let j = i;
      while (j < n && s[j] === '#') j++;
      if (j < n && s[j] === ' ') {
        const lineEnd = s.indexOf('\n', j + 1);
        const headingText =
          lineEnd !== -1 ? s.slice(j + 1, lineEnd) : s.slice(j + 1);
        const startOut = out.length;
        out += headingText;
        addStyle('BOLD', startOut, out.length);
        if (lineEnd !== -1) {
          out += '\n';
          i = lineEnd + 1;
        } else i = n;
        continue;
      }
    }

    // ── Links  [text](url) → text (url) ───────────────────────────────
    if (s[i] === '[') {
      const closeBracket = s.indexOf(']', i + 1);
      if (closeBracket !== -1 && s[closeBracket + 1] === '(') {
        const closeParen = s.indexOf(')', closeBracket + 2);
        if (closeParen !== -1) {
          const linkText = s.slice(i + 1, closeBracket);
          const url = s.slice(closeBracket + 2, closeParen);
          out += `${linkText} (${url})`;
          i = closeParen + 1;
          continue;
        }
      }
    }

    // ── Horizontal rule  --- / *** / ___ ──────────────────────────────
    if (i === 0 || s[i - 1] === '\n') {
      const hrMatch = /^(-{3,}|\*{3,}|_{3,}) *(\n|$)/.exec(s.slice(i));
      if (hrMatch) {
        i += hrMatch[0].length;
        continue;
      }
    }

    // ── Default: copy character, preserving surrogate pairs ───────────
    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < n) {
      out += s[i] + s[i + 1];
      i += 2;
    } else {
      out += s[i];
      i++;
    }
  }

  return { text: out, textStyle };
}

// ---------------------------------------------------------------------------
// Helpers for parseSignalStyles
// ---------------------------------------------------------------------------

/** Find the position of a closing single `*` that isn't part of `**`. */
function findClosingStar(s: string, from: number): number {
  for (let i = from; i < s.length; i++) {
    if (s[i] === '\n') return -1; // italics don't span lines
    if (s[i] === '*' && s[i + 1] !== '*' && s[i - 1] !== ' ') return i;
  }
  return -1;
}

/** Find the closing `_` that isn't part of `__` and is at a word boundary. */
function findClosingUnderscore(s: string, from: number): number {
  for (let i = from; i < s.length; i++) {
    if (s[i] === '\n') return -1;
    if (s[i] === '_' && s[i + 1] !== '_' && !/\w/.test(s[i + 1] ?? '')) {
      return i;
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Marker-substitution helpers (WhatsApp / Telegram / Slack)
// ---------------------------------------------------------------------------

interface Segment {
  content: string;
  protected: boolean;
}

/**
 * Split text into alternating unprotected/protected segments.
 * Protected = fenced code blocks (```...```) and inline code (`...`).
 */
function splitProtectedRegions(text: string): Segment[] {
  const segments: Segment[] = [];
  const CODE_PATTERN = /```[\s\S]*?```|`[^`\n]+`/g;

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = CODE_PATTERN.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({
        content: text.slice(lastIndex, match.index),
        protected: false,
      });
    }
    segments.push({ content: match[0], protected: true });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    segments.push({ content: text.slice(lastIndex), protected: false });
  }

  return segments.length > 0 ? segments : [{ content: text, protected: false }];
}

/** Apply marker-substitution transformations to a non-code segment. */
function transformSegment(text: string, channel: ChannelType): string {
  let t = text;

  // Order matters: italic before bold.
  // The italic regex won't match **bold** (it requires the char after the opening *
  // to be a non-* non-space), so running italic first is safe.  If we ran bold
  // first (**bold** → *bold*), the italic step would immediately re-convert *bold*
  // to _bold_, producing wrong output.

  // 1. Italic: *text* → _text_ (whatsapp/telegram/slack use _)
  t = t.replace(/(?<!\*)\*(?=[^\s*])([^*\n]+?)(?<=[^\s*])\*(?!\*)/g, '_$1_');

  // 2. Bold: **text** → *text* (whatsapp/telegram/slack use single *)
  t = t.replace(/\*\*(?=[^\s*])([^*]+?)(?<=[^\s*])\*\*/g, '*$1*');

  // 3. Headings: ## Title → *Title* (any level, line-start only)
  t = t.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');

  // 4. Links
  if (channel === 'slack') {
    t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>');
  } else {
    t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');
  }

  // 5. Horizontal rules: strip them
  t = t.replace(/^(-{3,}|\*{3,}|_{3,})$/gm, '');

  return t;
}

// ---------------------------------------------------------------------------
// Telegram HTML pipeline
// ---------------------------------------------------------------------------

/**
 * Tokenize-then-transform pipeline for Telegram's HTML parse_mode.
 *
 * Phases (order matters — each protects the next from regex collisions):
 *   1. Extract fenced code  ```lang\n...\n```  →  <pre>[<code class="language-x">]...</code></pre>
 *   2. Extract inline code  `x`                →  <code>x</code>
 *   3. Extract GFM tables   | a | b |\n|---|...|  →  <pre>padded ASCII grid</pre>
 *   4. HTML-escape what remains (plain prose + token markers — markers survive escaping)
 *   5. Apply markdown → HTML transforms: italic, bold, strike, headings, links, HR
 *   6. Restore tokens (already-rendered HTML) in place
 *
 * Token markers use Unicode private-use codepoint U+E000 — guaranteed absent
 * from real input and not disturbed by any phase-5 regex.
 */
function transformTelegramHtml(text: string): string {
  const tokens: string[] = [];
  const mint = (html: string): string => {
    const id = tokens.length;
    tokens.push(html);
    return `${id}`;
  };

  let s = text;

  // Phase 1: fenced code blocks (greedy, multi-line).
  s = s.replace(
    /```([A-Za-z0-9_+-]*)\n?([\s\S]*?)```/g,
    (_, lang: string, body: string) => {
      const cleaned = body.replace(/\n$/, '');
      const inner = htmlEscape(cleaned);
      const html = lang
        ? `<pre><code class="language-${lang}">${inner}</code></pre>`
        : `<pre>${inner}</pre>`;
      return mint(html);
    },
  );

  // Phase 2: inline code.
  s = s.replace(/`([^`\n]+)`/g, (_, body: string) =>
    mint(`<code>${htmlEscape(body)}</code>`),
  );

  // Phase 3: GFM pipe-tables. A table is: a row | a | b |, a separator
  // | --- | --- | with hyphens (optionally colon-aligned), then ≥1 body rows.
  s = renderGfmTables(s, mint);

  // Phase 4: HTML-escape everything that remains (token markers survive — U+E000
  // and digits aren't HTML-special).
  s = htmlEscape(s);

  // Phase 5: markdown → HTML transforms on the now-escaped prose.
  // Italic before bold (single * inside ** would be mis-matched otherwise).
  s = s.replace(
    /(?<!\*)\*(?=[^\s*])([^*\n]+?)(?<=[^\s*])\*(?!\*)/g,
    '<i>$1</i>',
  );
  s = s.replace(/\*\*(?=[^\s*])([^*]+?)(?<=[^\s*])\*\*/g, '<b>$1</b>');
  // Underscore italic: only at word boundaries to avoid eating snake_case.
  s = s.replace(/(^|[^\w])_(?=\S)([^_\n]+?)(?<=\S)_(?!\w)/g, '$1<i>$2</i>');
  s = s.replace(/~~(?=\S)([^~\n]+?)(?<=\S)~~/g, '<s>$1</s>');
  // ATX headings → bold (Telegram has no heading tag).
  s = s.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');
  // Links: [text](url) → <a href="url">text</a>. url is already HTML-escaped
  // from phase 4; that's correct (& becomes &amp; in the href, which renders
  // back to & when the user taps the link).
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
  // Horizontal rules.
  s = s.replace(/^(-{3,}|\*{3,}|_{3,})$/gm, '');

  // Phase 6: restore tokens.
  s = s.replace(/(\d+)/g, (_, id: string) => tokens[Number(id)]);

  return s;
}

/** Escape the three HTML special chars Telegram requires inside any tag. */
function htmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const TABLE_ROW_RE = /^\s*\|.+\|\s*$/;
const TABLE_SEP_RE = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/;

/**
 * Scan line-by-line for GFM tables. Each table block (header + separator +
 * ≥1 body rows) is replaced by a single token whose stored value is an
 * already-rendered <pre>...</pre> with space-padded columns.
 *
 * Cell contents have their markdown stripped (Telegram's <pre> parser
 * doesn't permit nested inline tags except <code>, so we render cells as
 * plain text) and are HTML-escaped before insertion.
 */
function renderGfmTables(text: string, mint: (html: string) => string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (
      TABLE_ROW_RE.test(lines[i]) &&
      i + 1 < lines.length &&
      TABLE_SEP_RE.test(lines[i + 1])
    ) {
      const block: string[] = [lines[i], lines[i + 1]];
      let j = i + 2;
      while (j < lines.length && TABLE_ROW_RE.test(lines[j])) {
        block.push(lines[j]);
        j++;
      }
      out.push(mint(renderTableAsPre(block)));
      i = j;
    } else {
      out.push(lines[i]);
      i++;
    }
  }
  return out.join('\n');
}

/** Parse a GFM table block into a padded ASCII grid wrapped in <pre>. */
function renderTableAsPre(blockLines: string[]): string {
  const parseRow = (line: string): string[] =>
    line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => stripInlineMarkdown(c.trim()));

  const header = parseRow(blockLines[0]);
  const body = blockLines.slice(2).map(parseRow);
  const allRows = [header, ...body];

  // Normalize column count to widest row (some rows may have trailing empties).
  const cols = Math.max(...allRows.map((r) => r.length));
  for (const row of allRows) {
    while (row.length < cols) row.push('');
  }

  const widths: number[] = new Array(cols).fill(0);
  for (const row of allRows) {
    for (let c = 0; c < cols; c++) {
      if (row[c].length > widths[c]) widths[c] = row[c].length;
    }
  }

  const pad = (s: string, w: number): string =>
    s + ' '.repeat(Math.max(0, w - s.length));
  const renderRow = (row: string[]): string =>
    row.map((c, idx) => pad(c, widths[idx])).join(' | ');
  const separator = widths.map((w) => '-'.repeat(w)).join('-+-');

  const rows = [renderRow(header), separator, ...body.map(renderRow)];
  return `<pre>${rows.map(htmlEscape).join('\n')}</pre>`;
}

/** Strip inline markdown markers so cell contents render as plain text. */
function stripInlineMarkdown(s: string): string {
  return s
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '$1')
    .replace(/(^|[^\w])_([^_\n]+)_(?!\w)/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
}
