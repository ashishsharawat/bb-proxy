import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Logger } from 'pino';
import type { Page } from 'playwright';
import type { Config } from '../config.js';
import type { ModuleStatus } from '../util/types.js';
import { HttpError, ModuleUnavailableError, UpstreamError } from '../util/errors.js';
import { fetchEndpointFor, simplifyInPageFn, wrapSimplifiedDocument } from './rewrite.js';
import { extractReadable, renderReadableDocument } from './readable.js';
import { captureSnapshot, loadClickmap, storeSnapshot } from './screenshot.js';
import { submitForm, validateFormBody } from './form.js';
import type { PagePool } from './pool.js';

export interface BrowserContext {
  config: Config;
  log: Logger;
  getStatus: () => ModuleStatus;
  setStatus: (s: ModuleStatus) => void;
  /** Returns the current page pool, or null if the Playwright subsystem is down. */
  getPool: () => PagePool | null;
  /** Screenshot viewport width (desktop-ish) used for clickmap math. */
  viewportWidth: number;
  /** Screenshot target downscale width (BB screen is ~640px; PRD §6.2 says 480). */
  screenshotWidth: number;
}

export async function registerBrowserRoutes(app: FastifyInstance, ctx: BrowserContext): Promise<void> {
  const auth = { preHandler: app.requireDeviceToken };

  // -------------------------- GET /browser/fetch --------------------------
  app.get('/browser/fetch', auth, async (req, reply) => {
    requireUp(ctx);
    const q = req.query as Record<string, string | undefined>;
    const rawUrl = q['url'];
    const mode = (q['mode'] ?? 'simplified') as 'simplified' | 'readable' | 'screenshot';

    if (!rawUrl) {
      throw new HttpError(400, 'missing required query param: url', 'bad_request');
    }
    const target = normalizeTargetUrl(rawUrl);
    if (!target) {
      throw new HttpError(400, 'url must be an absolute http(s) URL', 'bad_request');
    }
    if (mode !== 'simplified' && mode !== 'readable' && mode !== 'screenshot') {
      throw new HttpError(400, `unknown mode: ${mode}`, 'bad_request');
    }

    const pool = ctx.getPool();
    if (!pool) throw new ModuleUnavailableError('browser', 'Chromium not running');

    const page = await pool.acquire();
    try {
      await gotoOrThrow(page, target, ctx.log);

      if (mode === 'simplified') {
        return await renderSimplified(page, target, ctx, reply);
      }
      if (mode === 'readable') {
        return await renderReadable(page, target, reply);
      }
      // screenshot
      return await renderScreenshot(app, page, target, ctx, reply);
    } finally {
      await pool.release(page);
    }
  });

  // ---------------------- GET /browser/clickmap/:id -----------------------
  app.get('/browser/clickmap/:id', auth, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!id || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) {
      throw new HttpError(400, 'invalid snapshot id', 'bad_request');
    }
    const doc = loadClickmap(app.db, id);
    if (!doc) {
      throw new HttpError(404, 'clickmap not found', 'not_found');
    }
    void reply.header('Content-Type', 'application/json; charset=utf-8');
    return doc;
  });

  // -------------------------- POST /browser/form --------------------------
  app.post('/browser/form', auth, async (req, reply) => {
    requireUp(ctx);
    const sub = validateFormBody(req.body);
    if (!sub) {
      throw new HttpError(400, 'invalid form submission body', 'bad_request');
    }
    const pool = ctx.getPool();
    if (!pool) throw new ModuleUnavailableError('browser', 'Chromium not running');

    const page = await pool.acquire();
    try {
      const finalUrl = await submitForm(page, sub);
      return await renderSimplified(page, finalUrl, ctx, reply);
    } finally {
      await pool.release(page);
    }
  });

  // -------------------- TODO M2b: Google login + session ------------------
  app.post('/browser/login/google', auth, async () => {
    // TODO M2b: multi-step Google login flow. Open a dedicated persistent
    // context, drive the login page, surface intermediate forms (email, pw,
    // 2FA) back to the BB as simplified forms, and store cookies on success.
    throw new ModuleUnavailableError('browser', 'Google login not yet implemented (M2b)');
  });

  app.get('/browser/session', auth, async () => {
    // TODO M2b: dump cookies / logged-in account list from the persistent
    // context for admin visibility. Admin-only view per PRD §6.2.
    throw new ModuleUnavailableError('browser', 'session dump not yet implemented (M2b)');
  });
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function renderSimplified(
  page: Page,
  sourceUrl: string,
  ctx: BrowserContext,
  reply: FastifyReply
): Promise<string> {
  const fetchEndpoint = fetchEndpointFor(ctx.config.publicBaseUrl);
  const { title, body } = await page.evaluate(simplifyInPageFn, { fetchEndpoint });
  const html = wrapSimplifiedDocument(title, body);
  void reply.header('Content-Type', 'text/html; charset=utf-8');
  void reply.header('X-Source-Url', safeHeader(sourceUrl));
  return html;
}

async function renderReadable(
  page: Page,
  sourceUrl: string,
  reply: FastifyReply
): Promise<string> {
  const rendered = await page.content();
  const article = extractReadable(rendered, sourceUrl);
  if (!article) {
    throw new UpstreamError('could not extract a readable article from this page');
  }
  const html = renderReadableDocument(article);
  void reply.header('Content-Type', 'text/html; charset=utf-8');
  void reply.header('X-Source-Url', safeHeader(sourceUrl));
  return html;
}

async function renderScreenshot(
  app: FastifyInstance,
  page: Page,
  sourceUrl: string,
  ctx: BrowserContext,
  reply: FastifyReply
): Promise<Buffer> {
  const snap = await captureSnapshot(page, sourceUrl, ctx.screenshotWidth);
  storeSnapshot(app.db, snap, sourceUrl);
  void reply.header('Content-Type', 'image/png');
  void reply.header('X-Clickmap-Id', snap.id);
  void reply.header('X-Source-Url', safeHeader(sourceUrl));
  return snap.png;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireUp(ctx: BrowserContext): void {
  const s = ctx.getStatus();
  if (s.state === 'down' || s.state === 'disabled') {
    throw new ModuleUnavailableError('browser', s.detail ?? s.state);
  }
}

function normalizeTargetUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

async function gotoOrThrow(page: Page, url: string, log: Logger): Promise<void> {
  try {
    // `domcontentloaded` gets us a usable DOM fastest; most modern sites have
    // enough rendered by then for simplified/screenshot. If we need images
    // rendered for the screenshot we'd want `load`, but the BB tolerates
    // best-effort.
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
  } catch (err) {
    log.warn({ err, url }, 'page.goto failed');
    throw new UpstreamError(`failed to load ${url}: ${(err as Error).message}`, url);
  }
}

function safeHeader(value: string): string {
  // Headers must be ASCII; strip anything weird so Fastify doesn't throw.
  return value.replace(/[^\x20-\x7E]/g, '');
}
