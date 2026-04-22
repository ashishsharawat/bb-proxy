/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import type { Page } from 'playwright';

// DOM lib references scoped to this file so the inline `page.evaluate(...)`
// callback that synthesizes a <form> gets DOM types without polluting the
// rest of the Node-targeted project.

/**
 * Request body for `POST /browser/form`. The BB sends us the `action` URL,
 * HTTP method, and the field name/value pairs the user typed on the device.
 *
 * The proxy then either (a) navigates to `action` and fills the form with
 * Playwright (preferred, because the site can run its own JS submit handler),
 * or (b) for pure GET forms, URL-encodes the values and navigates directly.
 */
export interface FormSubmission {
  action: string;
  method: 'GET' | 'POST' | 'get' | 'post';
  fields: Record<string, string>;
}

export function validateFormBody(body: unknown): FormSubmission | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const action = typeof b['action'] === 'string' ? b['action'] : null;
  const methodRaw = typeof b['method'] === 'string' ? b['method'].toUpperCase() : null;
  const fieldsRaw = b['fields'];
  if (!action || !methodRaw) return null;
  if (methodRaw !== 'GET' && methodRaw !== 'POST') return null;
  if (!fieldsRaw || typeof fieldsRaw !== 'object') return null;
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(fieldsRaw as Record<string, unknown>)) {
    if (typeof v !== 'string') return null;
    fields[k] = v;
  }
  try {
    // Validate URL early — we want a clear 400 rather than a Playwright crash.
    // eslint-disable-next-line no-new
    new URL(action);
  } catch {
    return null;
  }
  return { action, method: methodRaw, fields };
}

/**
 * Submit the form by driving Playwright. Returns the final URL after the
 * submission settles. The caller is responsible for then running the
 * simplification pass on the resulting page.
 */
export async function submitForm(page: Page, sub: FormSubmission): Promise<string> {
  const method = sub.method.toUpperCase() as 'GET' | 'POST';

  if (method === 'GET') {
    // Build a query string and navigate. Simpler and more reliable than
    // synthesizing a form element.
    const u = new URL(sub.action);
    for (const [k, v] of Object.entries(sub.fields)) {
      u.searchParams.set(k, v);
    }
    await page.goto(u.toString(), { waitUntil: 'domcontentloaded', timeout: 30000 });
    return page.url();
  }

  // POST: synthesize a <form> inside an about:blank page and submit it.
  // Using the browser context (not a plain fetch) preserves cookies/redirects
  // for the active Chromium session.
  await page.goto('about:blank', { waitUntil: 'load', timeout: 10000 });
  await page.evaluate(
    ({ action, fields }: { action: string; fields: Record<string, string> }) => {
      const form = document.createElement('form');
      form.method = 'POST';
      form.action = action;
      form.style.display = 'none';
      for (const [k, v] of Object.entries(fields)) {
        const input = document.createElement('input');
        input.type = 'hidden';
        input.name = k;
        input.value = v;
        form.appendChild(input);
      }
      document.body.appendChild(form);
      form.submit();
    },
    { action: sub.action, fields: sub.fields }
  );
  // Wait for the resulting navigation to settle.
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: 30000 });
  } catch {
    // If the submit didn't cause a nav (SPA handler), carry on and return
    // whatever's currently on the page.
  }
  return page.url();
}
