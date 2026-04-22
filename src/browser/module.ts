import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import type { Config } from '../config.js';
import { ModuleBase } from '../util/moduleBase.js';
import { registerBrowserRoutes } from './routes.js';
import { PagePool } from './pool.js';

/**
 * Browser module — delegates modern-web rendering to a headless Chromium
 * (Playwright) and returns BB-compatible output: simplified HTML, reader-mode
 * plain text, or rasterized PNG + clickmap (PRD_01 §6.2).
 *
 * Lifecycle:
 *   start() → launch Chromium, create a browser context, warm a 2-page pool,
 *             register routes. (M2b will swap to a persistent context rooted
 *             at <dataDir>/playwright so Google login cookies survive.)
 *   stop()  → close the browser.
 *
 * Supervisor: if the browser process crashes (`browser.on('disconnected')`),
 * we mark status degraded and attempt exactly one restart. If that fails we
 * go to `down`; callers will see 503s from the routes.
 */
export class BrowserModule extends ModuleBase {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private pool: PagePool | null = null;
  private stopping = false;
  private restartAttempted = false;

  /** Desktop-ish viewport for rendering/measuring. Clickmaps are computed here
   *  then scaled to the downscaled PNG width. */
  private readonly viewportWidth = 1024;
  private readonly viewportHeight = 768;

  /** PRD §6.2 — screenshot mode returns a 480px-wide PNG. */
  private readonly screenshotWidth = 480;

  /** PRD §11 — warm a pool of 2 pages. */
  private readonly poolSize = 2;

  constructor(app: FastifyInstance, config: Config, log: Logger) {
    super(app, config, log);
  }

  override async start(): Promise<void> {
    this.setStatus({ state: 'degraded', detail: 'initializing', since: Date.now() });

    // Register routes once up-front. Handlers consult getPool() which returns
    // null while we're restarting, so a crash-mid-request surfaces as 503.
    await registerBrowserRoutes(this.app, {
      config: this.config,
      log: this.log,
      getStatus: () => this.status(),
      setStatus: (s) => this.setStatus(s),
      getPool: () => this.pool,
      viewportWidth: this.viewportWidth,
      screenshotWidth: this.screenshotWidth,
    });

    try {
      await this.launch();
      this.setStatus({ state: 'up', since: Date.now() });
    } catch (err) {
      this.log.error({ err }, 'failed to launch Chromium');
      this.setStatus({
        state: 'down',
        detail: 'failed to launch',
        lastError: (err as Error).message,
        since: Date.now(),
      });
      // Don't throw — we want the process to stay up so other modules still
      // work and /health reflects reality.
    }
  }

  private async launch(): Promise<void> {
    this.log.info('launching Chromium');

    // We use a fresh browser + context (not launchPersistentContext) so we
    // can reliably `close()` on stop. Per-session cookies live only for the
    // lifetime of this process; M2b will wire in a persistent context rooted
    // under <dataDir>/playwright for the Google login flow.
    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    this.browser = browser;

    browser.on('disconnected', () => {
      if (this.stopping) return;
      this.log.error('Chromium disconnected unexpectedly');
      this.setStatus({
        state: 'degraded',
        detail: 'chromium disconnected',
        since: Date.now(),
      });
      void this.handleCrash();
    });

    const context = await browser.newContext({
      viewport: { width: this.viewportWidth, height: this.viewportHeight },
      userAgent:
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      javaScriptEnabled: true,
      bypassCSP: true,
    });
    this.context = context;

    const pool = new PagePool(context, this.poolSize, this.log);
    await pool.warm();
    this.pool = pool;
  }

  private async handleCrash(): Promise<void> {
    if (this.stopping) return;
    // Tear down references; the process is already gone.
    this.pool = null;
    this.context = null;
    this.browser = null;

    if (this.restartAttempted) {
      this.log.error('Chromium restart already attempted; giving up');
      this.setStatus({
        state: 'down',
        detail: 'chromium crashed and restart failed',
        since: Date.now(),
      });
      return;
    }
    this.restartAttempted = true;
    this.log.warn('attempting single Chromium restart');

    try {
      await this.launch();
      this.log.info('Chromium restart succeeded');
      this.setStatus({ state: 'up', since: Date.now() });
      // Reset the flag after a successful restart so a *future* crash gets
      // another chance. If it crashes again within the same process lifetime
      // we'll flip right back to 'down'.
      this.restartAttempted = false;
    } catch (err) {
      this.log.error({ err }, 'Chromium restart failed');
      this.setStatus({
        state: 'down',
        detail: 'restart failed',
        lastError: (err as Error).message,
        since: Date.now(),
      });
    }
  }

  override async stop(): Promise<void> {
    this.stopping = true;
    this.setStatus({ state: 'down', detail: 'stopping', since: Date.now() });
    const pool = this.pool;
    const context = this.context;
    const browser = this.browser;
    this.pool = null;
    this.context = null;
    this.browser = null;
    try { if (pool) await pool.close(); } catch (err) { this.log.warn({ err }, 'error closing page pool'); }
    try { if (context) await context.close(); } catch (err) { this.log.warn({ err }, 'error closing browser context'); }
    try { if (browser) await browser.close(); } catch (err) { this.log.warn({ err }, 'error closing browser'); }
    this.setStatus({ state: 'down', detail: 'stopped', since: Date.now() });
  }
}
