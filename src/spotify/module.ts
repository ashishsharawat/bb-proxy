import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import type { Config } from '../config.js';
import { ModuleBase } from '../util/moduleBase.js';
import { kvGet, kvSet } from '../db/index.js';
import { registerSpotifyRoutes } from './routes.js';
import { registerSpotifyOAuthRoutes, SPOTIFY_REFRESH_TOKEN_KV_KEY } from './oauth.js';
import { SpotifyTokenManager } from './tokenManager.js';
import { decryptSecret, encryptSecret } from './crypto.js';

/**
 * Spotify module — OAuth + metadata + control (M4a).
 *
 * Responsibilities:
 *   - On start: load + decrypt refresh token from kv, set up token manager.
 *   - Register /admin/spotify/{login,callback} OAuth routes (replacing the
 *     stubs in src/admin/routes.ts).
 *   - Register BB-facing /spotify/* metadata + control routes.
 *   - DEFER: `/spotify/play/:id` audio streaming (M4b — librespot + ffmpeg).
 *
 * See PRD_01 §6.3, §6.5, §9.
 *
 * TODO M4b: own and supervise a `librespot` child process, pipe its audio
 * through `ffmpeg` for MP3 transcoding on `/spotify/play/:id`. See routes.ts
 * for the detailed TODO block. That work also requires Dockerfile changes
 * (install `librespot` + `ffmpeg`), which are explicitly out of scope here.
 */
export class SpotifyModule extends ModuleBase {
  private tokens: SpotifyTokenManager | null = null;

  constructor(app: FastifyInstance, config: Config, log: Logger) {
    super(app, config, log);
  }

  override async start(): Promise<void> {
    this.setStatus({ state: 'degraded', detail: 'initializing', since: Date.now() });

    if (!this.config.spotify.clientId || !this.config.spotify.clientSecret) {
      this.setStatus({
        state: 'down',
        detail: 'SPOTIFY_CLIENT_ID/SECRET not set — configure in env',
        since: Date.now(),
      });
      // Still register routes so they return clean 503s rather than 404s.
      // But without creds we have no tokenManager — construct a dummy one
      // that will always throw "no_refresh_token".
      this.tokens = new SpotifyTokenManager('', '', this.log);
      await this.registerAllRoutes();
      return;
    }

    this.tokens = new SpotifyTokenManager(
      this.config.spotify.clientId,
      this.config.spotify.clientSecret,
      this.log,
      async (rotated) => {
        // Persist a rotated refresh token (rare — Spotify usually keeps the
        // same one indefinitely).
        const encrypted = encryptSecret(rotated, this.config.adminPassword);
        kvSet(this.app.db, SPOTIFY_REFRESH_TOKEN_KV_KEY, encrypted);
      }
    );

    await this.registerAllRoutes();

    // Attempt to load a previously-stored refresh token.
    const stored = kvGet(this.app.db, SPOTIFY_REFRESH_TOKEN_KV_KEY);
    if (!stored) {
      this.setStatus({
        state: 'down',
        detail: 'not logged in — go to /admin',
        since: Date.now(),
      });
      return;
    }

    try {
      const refreshToken = decryptSecret(stored, this.config.adminPassword);
      this.tokens.setRefreshToken(refreshToken);
      // Proactively mint the first access token so /health reflects reality.
      await this.tokens.getAccessToken();
      this.setStatus({ state: 'up', since: Date.now() });
      this.log.info('spotify module ready — refresh token loaded from kv');
    } catch (err) {
      this.log.error({ err }, 'failed to load/decrypt spotify refresh token');
      this.setStatus({
        state: 'down',
        detail: 'refresh token decrypt/refresh failed — re-login at /admin',
        lastError: (err as Error).message,
        since: Date.now(),
      });
    }
  }

  override async stop(): Promise<void> {
    this.setStatus({ state: 'down', detail: 'stopped', since: Date.now() });
    this.tokens?.clear();
    // TODO M4b: kill librespot child, close ffmpeg pipelines.
  }

  private async registerAllRoutes(): Promise<void> {
    if (!this.tokens) throw new Error('registerAllRoutes called before tokens initialized');
    const tokens = this.tokens;

    await registerSpotifyRoutes(this.app, {
      config: this.config,
      log: this.log,
      tokens,
      getStatus: () => this.status(),
      setStatus: (s) => this.setStatus(s),
    });

    await registerSpotifyOAuthRoutes(this.app, {
      config: this.config,
      log: this.log,
      onTokensObtained: async ({ accessToken, refreshToken, expiresIn }) => {
        tokens.setRefreshToken(refreshToken, { accessToken, expiresIn });
        this.setStatus({ state: 'up', since: Date.now() });
      },
    });
  }
}
