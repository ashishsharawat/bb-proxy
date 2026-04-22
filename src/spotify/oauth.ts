import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Logger } from 'pino';
import type { Config } from '../config.js';
import { kvSet } from '../db/index.js';
import { encryptSecret } from './crypto.js';

/**
 * Spotify OAuth Authorization Code flow (admin-facing).
 *
 * Flow:
 *   1. Admin hits /admin/spotify/login (basic-auth).
 *   2. We generate a random `state` param, set it as a short-lived httpOnly
 *      cookie, and 302 to Spotify's /authorize endpoint.
 *   3. Spotify calls back to /admin/spotify/callback?code=...&state=...
 *   4. We verify `state` matches the cookie, exchange the code for
 *      access+refresh tokens, encrypt the refresh token, persist via kvSet,
 *      and notify the caller (the SpotifyModule) so it can start using the
 *      token without requiring a process restart.
 *
 * The client_id/client_secret live in env. The refresh token lives in kv,
 * AES-256-GCM encrypted with a key derived from ADMIN_PASSWORD via scrypt.
 *
 * See PRD_01 §6.5 / §9.
 */

export const SPOTIFY_SCOPES = [
  'user-read-private',
  'user-read-email',
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'playlist-read-private',
  'playlist-read-collaborative',
  'user-library-read',
  // `streaming` is only consumed by the Web Playback SDK (browser). It's
  // harmless for a server-side client but we request it so that, if/when M4b
  // adds a Web Playback SDK path for a future web-based control surface, the
  // refresh token already authorizes it.
  'streaming',
].join(' ');

const STATE_COOKIE = 'bb_spotify_oauth_state';
const STATE_MAX_AGE_SEC = 600; // 10 minutes

export const SPOTIFY_REFRESH_TOKEN_KV_KEY = 'spotify.refresh_token';

export interface OAuthHandlerDeps {
  config: Config;
  log: Logger;
  /** Called after a successful token exchange so the module can rehydrate. */
  onTokensObtained: (tokens: { accessToken: string; refreshToken: string; expiresIn: number }) => Promise<void> | void;
}

interface SpotifyTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  token_type: string;
}

/**
 * Register /admin/spotify/login and /admin/spotify/callback on the app.
 * Both routes are protected by basic auth (onRequest: app.basicAuth).
 *
 * This function REPLACES the stubs in `src/admin/routes.ts`. The admin routes
 * module imports from here.
 */
export async function registerSpotifyOAuthRoutes(
  app: FastifyInstance,
  deps: OAuthHandlerDeps
): Promise<void> {
  const basicAuth = { onRequest: app.basicAuth };

  app.get('/admin/spotify/login', basicAuth, async (req, reply) => {
    await handleLogin(req, reply, deps);
  });

  app.get('/admin/spotify/callback', basicAuth, async (req, reply) => {
    await handleCallback(app, req, reply, deps);
  });
}

async function handleLogin(
  _req: FastifyRequest,
  reply: FastifyReply,
  deps: OAuthHandlerDeps
): Promise<void> {
  const { config } = deps;
  if (!config.spotify.clientId || !config.spotify.clientSecret) {
    void reply
      .code(500)
      .type('text/html')
      .send('<p>SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET not set in env.</p><p><a href="/admin">Back</a></p>');
    return;
  }

  const state = crypto.randomBytes(24).toString('base64url');
  void reply.setCookie(STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/admin/spotify',
    maxAge: STATE_MAX_AGE_SEC,
    secure: config.publicBaseUrl.startsWith('https://'),
  });

  const params = new URLSearchParams({
    client_id: config.spotify.clientId,
    response_type: 'code',
    redirect_uri: config.spotify.redirectUri,
    scope: SPOTIFY_SCOPES,
    state,
    show_dialog: 'true',
  });
  const url = `https://accounts.spotify.com/authorize?${params.toString()}`;
  void reply.redirect(url);
}

async function handleCallback(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
  deps: OAuthHandlerDeps
): Promise<void> {
  const { config, log } = deps;
  const q = req.query as { code?: string; state?: string; error?: string } | undefined;

  if (q?.error) {
    log.warn({ err: q.error }, 'spotify oauth callback error');
    void reply
      .code(400)
      .type('text/html')
      .send(`<p>Spotify OAuth error: ${escapeHtml(q.error)}</p><p><a href="/admin">Back</a></p>`);
    return;
  }

  const cookieState = req.cookies[STATE_COOKIE];
  if (!cookieState || !q?.state || cookieState !== q.state) {
    log.warn({ cookieState: !!cookieState, queryState: q?.state }, 'spotify oauth state mismatch');
    void reply
      .code(400)
      .type('text/html')
      .send('<p>OAuth state mismatch — please retry login. (CSRF check failed.)</p><p><a href="/admin">Back</a></p>');
    return;
  }

  // Clear state cookie (single-use)
  void reply.clearCookie(STATE_COOKIE, { path: '/admin/spotify' });

  if (!q.code) {
    void reply.code(400).type('text/html').send('<p>Missing ?code=</p>');
    return;
  }

  if (!config.spotify.clientId || !config.spotify.clientSecret) {
    void reply.code(500).type('text/html').send('<p>Server misconfigured (no Spotify client creds).</p>');
    return;
  }

  let tokens: SpotifyTokenResponse;
  try {
    tokens = await exchangeCodeForTokens(
      q.code,
      config.spotify.clientId,
      config.spotify.clientSecret,
      config.spotify.redirectUri
    );
  } catch (err) {
    log.error({ err }, 'spotify token exchange failed');
    void reply
      .code(502)
      .type('text/html')
      .send(`<p>Token exchange failed: ${escapeHtml(String((err as Error).message))}</p>`);
    return;
  }

  if (!tokens.refresh_token) {
    // Spotify only returns a refresh_token on the initial grant (or if the
    // user was forced to re-consent via show_dialog=true). If it's missing,
    // we can't persist anything useful.
    void reply
      .code(502)
      .type('text/html')
      .send('<p>Spotify did not return a refresh_token. Try again (we request show_dialog=true to force consent).</p>');
    return;
  }

  try {
    const encrypted = encryptSecret(tokens.refresh_token, config.adminPassword);
    kvSet(app.db, SPOTIFY_REFRESH_TOKEN_KV_KEY, encrypted);
    await deps.onTokensObtained({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresIn: tokens.expires_in,
    });
  } catch (err) {
    log.error({ err }, 'failed to persist spotify refresh token');
    void reply
      .code(500)
      .type('text/html')
      .send(`<p>Failed to persist token: ${escapeHtml(String((err as Error).message))}</p>`);
    return;
  }

  log.info('spotify oauth success — refresh token stored (encrypted)');
  void reply.redirect('/admin');
}

async function exchangeCodeForTokens(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string
): Promise<SpotifyTokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
  });
  const basic = Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64');
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
    throw new Error(`spotify /api/token ${res.status}: ${text.slice(0, 300)}`);
  }
  return (await res.json()) as SpotifyTokenResponse;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
