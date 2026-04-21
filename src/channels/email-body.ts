import TurndownService from 'turndown';

const turndown = new TurndownService({
  headingStyle: 'atx',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  linkStyle: 'inlined',
});

turndown.remove(['script', 'style', 'meta', 'link']);

export function htmlToMarkdown(html: string): string {
  if (!html) return '';
  return turndown.turndown(html).trim();
}

/**
 * Pick the best body representation from an email's MIME parts.
 * Prefers text/plain; falls back to Markdown-converted HTML if plain is absent.
 * Returns an empty string only if neither is available.
 */
export function pickBody(plain: string, html: string): string {
  const p = plain.trim();
  if (p) return p;
  return htmlToMarkdown(html);
}
