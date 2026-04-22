import type { Logger } from 'pino';

/**
 * Spotify access-token manager.
 *
 * Holds a single refresh token (plaintext, in memory — decrypted on boot or
 * after a fresh OAuth exchange) and issues short-lived access tokens on
 * demand. Refreshes ~60s before expiry so callers rarely see a stall.
 *
 * Thread model: the whole server is single-threaded (Node), but multiple
 * concurrent requests can call `getAccessToken()` during a refresh window. We
 * coalesce those on a single in-flight refresh Promise.
 */

const REFRESH_MARGIN_MS = 60_000; // refresh 60s before real expiry

interface TokenPair {
  accessToken: string;
  expiresAtMs: number;
}

interface TokenRefreshResponse {
  access_token: string;
  expires_in: number;
  scope?: string;
  token_type: string;
  /** Spotify may rotate the refresh token. Usually absent. */
  refresh_token?: string;
}

export class SpotifyTokenManager {
  private refreshToken: string | null = null;
  private current: TokenPair | null = null;
  private inflight: Promise<string> | null = null;

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly log: Logger,
    /** Called whenever Spotify rotates the refresh token so the module can re-persist. */
    private readonly onRefreshTokenRotated?: (newRefreshToken: string) => Promise<void> | void
  ) {}

  hasRefreshToken(): boolean {
    return this.refreshToken !== null;
  }

  /**
   * Set the refresh token (e.g. decrypted from kv at boot, or fresh from
   * OAuth callback). Pass accessToken+expiresIn if you already have a freshly
   * minted access token so we don't have to spend a refresh call immediately.
   */
  setRefreshToken(
    refreshToken: string,
    seed?: { accessToken: string; expiresIn: number }
  ): void {
    this.refreshToken = refreshToken;
    if (seed) {
      this.current = {
        accessToken: seed.accessToken,
        expiresAtMs: Date.now() + seed.expiresIn * 1000,
      };
    } else {
      this.current = null;
    }
  }

  clear(): void {
    this.refreshToken = null;
    this.current = null;
    this.inflight = null;
  }

  /**
   * Return a valid access token, refreshing if needed.
   * Throws if no refresh token has ever been set.
   */
  async getAccessToken(): Promise<string> {
    if (!this.refreshToken) {
      throw new Error('no_refresh_token');
    }
    const now = Date.now();
    if (this.current && this.current.expiresAtMs - REFRESH_MARGIN_MS > now) {
      return this.current.accessToken;
    }
    if (this.inflight) return this.inflight;
    this.inflight = this.doRefresh()
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  private async doRefresh(): Promise<string> {
    if (!this.refreshToken) throw new Error('no_refresh_token');
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: this.refreshToken,
    });
    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`, 'utf8').toString('base64');
    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      // 400/401 from refresh usually means the user revoked access or the
      // refresh token expired (rare for Spotify; they don't normally expire).
      // Clear our cached pair so the next call surfaces the error quickly.
      this.current = null;
      throw new Error(`spotify refresh failed ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = (await res.json()) as TokenRefreshResponse;
    this.current = {
      accessToken: data.access_token,
      expiresAtMs: Date.now() + data.expires_in * 1000,
    };
    if (data.refresh_token && data.refresh_token !== this.refreshToken) {
      this.log.info('spotify rotated refresh token — re-persisting');
      this.refreshToken = data.refresh_token;
      if (this.onRefreshTokenRotated) {
        try {
          await this.onRefreshTokenRotated(data.refresh_token);
        } catch (err) {
          this.log.error({ err }, 'failed to persist rotated refresh token');
        }
      }
    }
    this.log.debug({ expiresIn: data.expires_in }, 'spotify access token refreshed');
    return data.access_token;
  }
}
