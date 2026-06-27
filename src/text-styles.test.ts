import { describe, expect, it } from 'vitest';

import { parseTextStyles, parseSignalStyles } from './text-styles.js';

describe('parseTextStyles — passthrough channels', () => {
  it('discord and signal pass through unchanged', () => {
    const md = '**bold** and `code`';
    expect(parseTextStyles(md, 'discord')).toBe(md);
    expect(parseTextStyles(md, 'signal')).toBe(md);
  });
  it('empty string is returned as-is', () => {
    expect(parseTextStyles('', 'telegram')).toBe('');
  });
});

describe('parseTextStyles — whatsapp/slack marker substitution', () => {
  it('whatsapp: **bold**→*bold*, *italic*→_italic_, link→text (url), heading→*text*', () => {
    expect(parseTextStyles('**hi**', 'whatsapp')).toBe('*hi*');
    expect(parseTextStyles('*hi*', 'whatsapp')).toBe('_hi_');
    expect(parseTextStyles('[Anthropic](https://x.com)', 'whatsapp')).toBe('Anthropic (https://x.com)');
    expect(parseTextStyles('## Title', 'whatsapp')).toBe('*Title*');
  });
  it('slack renders links as <url|text>', () => {
    expect(parseTextStyles('[Anthropic](https://x.com)', 'slack')).toBe('<https://x.com|Anthropic>');
  });
  it('never transforms inside code regions', () => {
    expect(parseTextStyles('`**not bold**`', 'whatsapp')).toBe('`**not bold**`');
    expect(parseTextStyles('```\n**not bold**\n```', 'whatsapp')).toBe('```\n**not bold**\n```');
  });
});

describe('parseTextStyles — telegram HTML', () => {
  it('renders bold/italic/strike/code/heading/link', () => {
    expect(parseTextStyles('**b**', 'telegram')).toBe('<b>b</b>');
    expect(parseTextStyles('*i*', 'telegram')).toBe('<i>i</i>');
    expect(parseTextStyles('~~s~~', 'telegram')).toBe('<s>s</s>');
    expect(parseTextStyles('`c`', 'telegram')).toBe('<code>c</code>');
    expect(parseTextStyles('## Title', 'telegram')).toBe('<b>Title</b>');
    expect(parseTextStyles('[A](https://x.com)', 'telegram')).toBe('<a href="https://x.com">A</a>');
  });
  it('HTML-escapes prose and code content', () => {
    expect(parseTextStyles('1 < 2 & 3 > 0', 'telegram')).toBe('1 &lt; 2 &amp; 3 &gt; 0');
    expect(parseTextStyles('`a < b`', 'telegram')).toBe('<code>a &lt; b</code>');
  });
  it('renders a fenced code block as <pre>, with language class', () => {
    expect(parseTextStyles('```\nx=1\n```', 'telegram')).toBe('<pre>x=1</pre>');
    expect(parseTextStyles('```js\nx=1\n```', 'telegram')).toBe('<pre><code class="language-js">x=1</code></pre>');
  });
  it('renders a GFM table as a padded <pre> grid', () => {
    const table = '| A | B |\n| --- | --- |\n| 1 | 22 |';
    const out = parseTextStyles(table, 'telegram');
    expect(out).toBe('<pre>A | B \n--+---\n1 | 22</pre>');
  });

  it('REGRESSION: digits in prose are NOT replaced by token markers', () => {
    // Madison's original used bare-digit markers + /(\d+)/g restore, so "Result: 3"
    // alongside a code block became "Result: undefined". The PUA-sentinel fix keeps
    // prose digits intact.
    const out = parseTextStyles('Result: 3 apples\n```\ncode\n```', 'telegram');
    expect(out).toBe('Result: 3 apples\n<pre>code</pre>');
    expect(out).not.toContain('undefined');
  });
  it('REGRESSION: multiple code spans + numbers stay correct', () => {
    const out = parseTextStyles('`a` then 7 then `b` then 42', 'telegram');
    expect(out).toBe('<code>a</code> then 7 then <code>b</code> then 42');
  });
});

describe('parseSignalStyles', () => {
  it('returns plain text with stripped markers + style ranges', () => {
    const { text, textStyle } = parseSignalStyles('a **bold** b');
    expect(text).toBe('a bold b');
    expect(textStyle).toContainEqual({ style: 'BOLD', start: 2, length: 4 });
  });
  it('handles italic, code, and links', () => {
    const r1 = parseSignalStyles('*it*');
    expect(r1.text).toBe('it');
    expect(r1.textStyle).toContainEqual({ style: 'ITALIC', start: 0, length: 2 });
    const r2 = parseSignalStyles('`mono`');
    expect(r2.text).toBe('mono');
    expect(r2.textStyle).toContainEqual({ style: 'MONOSPACE', start: 0, length: 4 });
    const r3 = parseSignalStyles('see [A](http://x)');
    expect(r3.text).toBe('see A (http://x)');
  });
});
