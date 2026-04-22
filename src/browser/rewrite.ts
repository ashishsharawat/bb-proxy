/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * HTML simplification for the BB BrowserField.
 *
 * Runs inside the Playwright page (via `page.evaluate`) so we can use the real
 * DOM that Chromium rendered, then returns a small plain-HTML string. We strip
 * scripts/styles/iframes/tracking pixels, keep headings / paragraphs / links /
 * small images, and rewrite all link hrefs to go back through the proxy at
 * `/browser/fetch?url=<encoded>&mode=simplified`.
 *
 * `simplifyInPageFn` is serialized by Playwright and run in Chromium — hence
 * the `dom` lib references above, scoped to this file, so we get DOM types in
 * TS without polluting the rest of the Node-targeted project.
 */

/**
 * Build the serialized HTML document the BB will see. We do *not* run this in
 * the page; we take the raw simplified body and title out of the DOM and wrap
 * them in a tiny shell here so we don't have to stringify HTML inside
 * `page.evaluate`.
 */
export function wrapSimplifiedDocument(title: string, body: string): string {
  const safeTitle = escapeHtml(title || 'Untitled');
  return [
    '<!DOCTYPE html>',
    '<html><head>',
    '<meta charset="utf-8">',
    `<title>${safeTitle}</title>`,
    '</head><body>',
    body,
    '</body></html>',
  ].join('');
}

/**
 * Function source that runs in the page context. Exported as a string because
 * Playwright's `page.evaluate` takes a function and serializes it; keeping it
 * as a plain function here lets TypeScript check its body while still letting
 * Playwright stringify it at call time.
 *
 * NOTE: This runs in the *browser*, not Node. It must not reference anything
 * from the outer module.
 */
export function simplifyInPageFn(args: { fetchEndpoint: string }): { title: string; body: string } {
  const { fetchEndpoint } = args;

  // --- Remove unwanted elements outright. ---
  const removeSelectors = [
    'script',
    'style',
    'noscript',
    'iframe',
    'object',
    'embed',
    'svg',
    'canvas',
    'video',
    'audio',
    'link[rel="stylesheet"]',
    'meta[http-equiv]',
  ];
  for (const sel of removeSelectors) {
    document.querySelectorAll(sel).forEach((el) => el.remove());
  }

  // --- Tracking pixels / tiny images ---
  document.querySelectorAll('img').forEach((img) => {
    const w = img.naturalWidth || parseInt(img.getAttribute('width') || '0', 10) || 0;
    const h = img.naturalHeight || parseInt(img.getAttribute('height') || '0', 10) || 0;
    if ((w > 0 && w < 16) || (h > 0 && h < 16)) {
      img.remove();
      return;
    }
    // Drop data-uri & absurdly large srcset stuff; keep the bare src.
    img.removeAttribute('srcset');
    img.removeAttribute('loading');
    img.removeAttribute('decoding');
    img.removeAttribute('style');
    img.removeAttribute('class');
    // Absolute-ize the src.
    const src = img.getAttribute('src');
    if (src) {
      try {
        img.setAttribute('src', new URL(src, document.baseURI).toString());
      } catch {
        img.remove();
        return;
      }
    } else {
      img.remove();
    }
  });

  // --- Rewrite links to go through the proxy. ---
  document.querySelectorAll('a[href]').forEach((a) => {
    const raw = a.getAttribute('href');
    if (!raw) return;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.toLowerCase().startsWith('javascript:')) {
      a.removeAttribute('href');
      return;
    }
    let abs: string;
    try {
      abs = new URL(trimmed, document.baseURI).toString();
    } catch {
      a.removeAttribute('href');
      return;
    }
    // Only proxy http(s) links.
    if (!/^https?:/i.test(abs)) {
      a.setAttribute('href', abs);
      return;
    }
    const rewritten = `${fetchEndpoint}?url=${encodeURIComponent(abs)}&mode=simplified`;
    a.setAttribute('href', rewritten);
    a.removeAttribute('target');
    a.removeAttribute('onclick');
  });

  // --- Strip inline JS handlers + style attributes everywhere. ---
  document.querySelectorAll('*').forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name;
      if (name.startsWith('on') || name === 'style' || name === 'class' || name.startsWith('data-')) {
        el.removeAttribute(name);
      }
    }
  });

  // --- Pick the "main" subtree if present, else use <body>. ---
  const candidate =
    document.querySelector('main') ||
    document.querySelector('article') ||
    document.querySelector('[role="main"]') ||
    document.body;

  // Whitelist of kept tags. Anything else gets unwrapped (replaced by its children).
  const keep = new Set([
    'a', 'p', 'br', 'hr',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'ul', 'ol', 'li',
    'strong', 'em', 'b', 'i', 'u',
    'img',
    'table', 'thead', 'tbody', 'tr', 'td', 'th',
    'blockquote', 'pre', 'code',
    'div', 'span',
    'form', 'input', 'textarea', 'select', 'option', 'button', 'label', 'fieldset', 'legend',
  ]);

  function unwrap(root: Element): void {
    // Collect non-whitelisted descendants first (mutating while walking is messy),
    // then unwrap each by replacing it with its children.
    const walker = document.createTreeWalker(root, 1 /* NodeFilter.SHOW_ELEMENT */);
    const toUnwrap: Element[] = [];
    let node: Node | null = walker.nextNode();
    while (node) {
      const el = node as Element;
      if (!keep.has(el.tagName.toLowerCase())) {
        toUnwrap.push(el);
      }
      node = walker.nextNode();
    }
    for (const el of toUnwrap) {
      const parent = el.parentNode;
      if (!parent) continue;
      while (el.firstChild) parent.insertBefore(el.firstChild, el);
      parent.removeChild(el);
    }
  }
  unwrap(candidate);

  // Collapse repeated whitespace in the serialized result via innerHTML roundtrip.
  const html = (candidate as HTMLElement).innerHTML
    .replace(/[\t\r\n]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();

  return { title: document.title, body: html };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Build the `/browser/fetch` URL prefix that rewritten links should use.
 * The PRD (§6.2) specifies links must route back through the proxy with the
 * resolved absolute URL percent-encoded. We use `publicBaseUrl` from config
 * so the BB device hits the same host it originally loaded.
 */
export function fetchEndpointFor(publicBaseUrl: string): string {
  // Trim any trailing slash.
  const base = publicBaseUrl.replace(/\/+$/, '');
  return `${base}/browser/fetch`;
}
