import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import type { Config } from '../config.js';
import type { ModuleStatus } from './types.js';

/**
 * Base class for Browser/Spotify/WhatsApp modules.
 *
 * Each module is responsible for:
 *   - owning its upstream resource (Playwright browser, librespot process, wwebjs client)
 *   - registering its own routes under a prefix
 *   - reporting status via status()
 *   - cleanly shutting down on stop()
 *
 * The supervisor pattern (restart on crash) should live inside each module's
 * implementation, not here — different modules have different failure modes.
 */
export abstract class ModuleBase {
  protected _status: ModuleStatus = { state: 'disabled', since: Date.now() };

  constructor(
    protected readonly app: FastifyInstance,
    protected readonly config: Config,
    protected readonly log: Logger
  ) {}

  status(): ModuleStatus {
    return this._status;
  }

  protected setStatus(next: ModuleStatus): void {
    this._status = next;
    this.log.info({ status: next }, 'module status change');
  }

  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;
}
