import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';

/**
 * Apply Mozilla's Readability algorithm to fully-rendered page HTML.
 *
 * We pass the Playwright-rendered HTML (post-JS) into JSDOM purely as a DOM
 * host for Readability — we do NOT ask JSDOM to execute any scripts. That
 * keeps us safe from eval'd malicious content while still giving Readability
 * a real DOM tree to work with.
 */
export interface ReadableResult {
  title: string;
  html: string;
  textContent: string;
  byline: string | null;
  length: number;
}

export function extractReadable(renderedHtml: string, documentUrl: string): ReadableResult | null {
  const dom = new JSDOM(renderedHtml, { url: documentUrl });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();
  if (!article) return null;
  return {
    title: article.title ?? 'Untitled',
    html: article.content ?? '',
    textContent: article.textContent ?? '',
    byline: article.byline ?? null,
    length: article.length ?? 0,
  };
}

export function renderReadableDocument(r: ReadableResult): string {
  const safeTitle = escapeHtml(r.title || 'Untitled');
  const byline = r.byline ? `<p><em>${escapeHtml(r.byline)}</em></p>` : '';
  return [
    '<!DOCTYPE html>',
    '<html><head>',
    '<meta charset="utf-8">',
    `<title>${safeTitle}</title>`,
    '</head><body>',
    `<h1>${safeTitle}</h1>`,
    byline,
    r.html,
    '</body></html>',
  ].join('');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
