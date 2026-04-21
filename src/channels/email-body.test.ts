import { describe, it, expect } from 'vitest';

import { htmlToMarkdown, pickBody } from './email-body.js';

describe('htmlToMarkdown', () => {
  it('returns empty string for empty input', () => {
    expect(htmlToMarkdown('')).toBe('');
  });

  it('converts basic paragraphs and headings', () => {
    const out = htmlToMarkdown('<h1>Hello</h1><p>World</p>');
    expect(out).toContain('# Hello');
    expect(out).toContain('World');
  });

  it('converts lists to dashed markdown bullets', () => {
    const out = htmlToMarkdown('<ul><li>one</li><li>two</li></ul>');
    expect(out).toMatch(/-\s+one/);
    expect(out).toMatch(/-\s+two/);
  });

  it('preserves links as inline markdown', () => {
    const out = htmlToMarkdown(
      '<p>See <a href="https://example.com">example</a></p>',
    );
    expect(out).toContain('[example](https://example.com)');
  });

  it('strips script and style tags', () => {
    const out = htmlToMarkdown(
      '<p>Hi</p><script>alert(1)</script><style>p{}</style>',
    );
    expect(out).not.toContain('alert');
    expect(out).not.toContain('p{}');
    expect(out).toContain('Hi');
  });
});

describe('pickBody', () => {
  it('returns plain when present', () => {
    expect(pickBody('hello plain', '<p>hello html</p>')).toBe('hello plain');
  });

  it('falls back to html when plain is empty', () => {
    const out = pickBody('', '<p>hello html</p>');
    expect(out).toContain('hello html');
  });

  it('falls back to html when plain is whitespace-only', () => {
    const out = pickBody('   \n\n   ', '<p>hello html</p>');
    expect(out).toContain('hello html');
  });

  it('returns empty when both are empty', () => {
    expect(pickBody('', '')).toBe('');
  });
});
