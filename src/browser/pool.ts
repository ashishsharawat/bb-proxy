import type { BrowserContext, Page } from 'playwright';
import type { Logger } from 'pino';

/**
 * Tiny page pool for the browser module. Warms N pages on start and hands
 * them out via `acquire()`; callers must `release()` back. A new page is
 * created on-demand to replace a closed/crashed one so the pool stays at size.
 *
 * Kept intentionally dumb — no queueing, no timeouts. If the pool is empty we
 * create an extra throwaway page rather than block, because BB clients are
 * serial (one request per device at a time) and stalling is worse than a
 * fresh Chromium page.
 */
export class PagePool {
  private readonly idle: Page[] = [];
  private closed = false;
  private readonly log: Logger;
  private readonly ctx: BrowserContext;
  private readonly size: number;

  constructor(ctx: BrowserContext, size: number, log: Logger) {
    this.ctx = ctx;
    this.size = size;
    this.log = log;
  }

  async warm(): Promise<void> {
    for (let i = 0; i < this.size; i++) {
      const p = await this.ctx.newPage();
      this.idle.push(p);
    }
    this.log.info({ size: this.size }, 'browser page pool warmed');
  }

  async acquire(): Promise<Page> {
    if (this.closed) throw new Error('page pool is closed');
    const p = this.idle.pop();
    if (p && !p.isClosed()) return p;
    // Pool empty (or top page was closed out from under us). Make a fresh one.
    return this.ctx.newPage();
  }

  async release(page: Page): Promise<void> {
    if (this.closed || page.isClosed()) {
      // Ensure the pool is topped up if possible.
      await this.topUp();
      return;
    }
    // Best-effort reset: navigate to blank so the next user starts clean.
    try {
      await page.goto('about:blank', { waitUntil: 'load', timeout: 5000 });
    } catch {
      // If reset fails, drop the page and replace it.
      try { await page.close(); } catch { /* ignore */ }
      await this.topUp();
      return;
    }
    if (this.idle.length < this.size) {
      this.idle.push(page);
    } else {
      // Over capacity (happens if acquire created an extra). Close it.
      try { await page.close(); } catch { /* ignore */ }
    }
  }

  private async topUp(): Promise<void> {
    if (this.closed) return;
    while (this.idle.length < this.size) {
      try {
        const p = await this.ctx.newPage();
        this.idle.push(p);
      } catch (err) {
        this.log.warn({ err }, 'pool top-up failed');
        return;
      }
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    const pages = this.idle.splice(0, this.idle.length);
    for (const p of pages) {
      try { await p.close(); } catch { /* ignore */ }
    }
  }
}
