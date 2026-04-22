import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const thisDir = path.dirname(fileURLToPath(import.meta.url));

function findViewsDir(): string {
  const candidates = [
    path.resolve(thisDir, 'views'),
    path.resolve(thisDir, '../../src/admin/views'),
    path.resolve(thisDir, '../../../src/admin/views'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(`Could not locate admin views dir (searched: ${candidates.join(', ')})`);
}

const viewsDir = findViewsDir();
const viewCache = new Map<string, string>();

function loadView(name: string): string {
  const cached = viewCache.get(name);
  if (cached !== undefined) return cached;
  const content = fs.readFileSync(path.join(viewsDir, name), 'utf8');
  if (process.env['NODE_ENV'] === 'production') viewCache.set(name, content);
  return content;
}

function escape(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function render(template: string, vars: Record<string, string>): string {
  let out = template;
  for (const [k, v] of Object.entries(vars)) {
    out = out.replaceAll(`{{${k}}}`, v);
  }
  return out;
}

export function renderPage(title: string, viewName: string, vars: Record<string, string>): string {
  const layout = loadView('layout.html');
  const view = loadView(viewName);
  const content = render(view, vars);
  return render(layout, { TITLE: escape(title), CONTENT: content });
}

export { escape };
