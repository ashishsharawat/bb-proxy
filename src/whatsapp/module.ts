import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import type { Config } from '../config.js';
import { ModuleBase } from '../util/moduleBase.js';
import { registerWhatsAppRoutes } from './routes.js';
import { WhatsAppClientWrapper } from './client.js';
import { WhatsAppMediaCache } from './media.js';
import { SendIdempotencyCache } from './idempotency.js';

/**
 * WhatsApp module — wraps `whatsapp-web.js` (Puppeteer + headless Chromium)
 * and exposes a polling-friendly HTTP API for the BB client.
 *
 * Lifecycle (PRD_01 §12):
 *   - start(): register routes immediately, boot wwebjs in the background.
 *     Status starts as 'degraded, waiting for QR scan'; flips to 'up' on
 *     the wwebjs `ready` event, back to 'degraded' on `disconnected`, and
 *     'down' on `auth_failure`.
 *   - stop(): destroy the wwebjs client; swallow errors (it's noisy).
 *
 * We deliberately do NOT await wwebjs initialize() inside start() — the
 * first boot without a cached auth blob can block for tens of seconds
 * while Chromium loads web.whatsapp.com. Keeping start() fast lets
 * `/whatsapp/status` and `/whatsapp/qr` respond during that window.
 */
export class WhatsAppModule extends ModuleBase {
  private client: WhatsAppClientWrapper | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopping = false;

  constructor(app: FastifyInstance, config: Config, log: Logger) {
    super(app, config, log);
  }

  override async start(): Promise<void> {
    this.setStatus({ state: 'degraded', detail: 'waiting for QR scan', since: Date.now() });

    const client = new WhatsAppClientWrapper(this.log, this.config.dataDir);
    this.client = client;

    client.on('ready', () => {
      this.setStatus({ state: 'up', since: Date.now() });
    });
    client.on('disconnected', (reason: string) => {
      this.setStatus({ state: 'degraded', detail: `disconnected: ${reason}`, since: Date.now() });
      // Auto-reconnect with a single debounced retry so we don't stampede if
      // Chromium fires disconnected repeatedly during teardown. PRD_01 §12
      // specifies supervisor-style retry; M3a ships the minimum viable version.
      if (this.stopping || this.reconnectTimer !== null) return;
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        if (this.stopping || !this.client || this.client.isDestroyed()) return;
        this.log.info('attempting wwebjs reconnect');
        this.client.start().catch((err: unknown) => {
          this.log.error({ err }, 'wwebjs reconnect failed');
        });
      }, 5000);
    });
    client.on('auth_failure', (msg: string) => {
      this.setStatus({ state: 'down', detail: `auth_failure: ${msg}`, lastError: msg, since: Date.now() });
    });

    const media = new WhatsAppMediaCache(this.config.dataDir, client, this.log);
    const idem = new SendIdempotencyCache(500);

    await registerWhatsAppRoutes(this.app, {
      config: this.config,
      log: this.log,
      client,
      media,
      idem,
      getStatus: () => this.status(),
      setStatus: (s) => this.setStatus(s),
    });

    // Fire-and-forget boot. Errors flip module status via the event handlers
    // above; we don't want them to prevent the server from starting.
    client.start().catch((err: unknown) => {
      this.log.error({ err }, 'wwebjs initial start failed');
      this.setStatus({
        state: 'down',
        detail: 'wwebjs start failed',
        lastError: err instanceof Error ? err.message : String(err),
        since: Date.now(),
      });
    });
  }

  override async stop(): Promise<void> {
    this.stopping = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.setStatus({ state: 'down', detail: 'stopped', since: Date.now() });
    if (this.client) {
      await this.client.stop();
      this.client = null;
    }
  }
}
