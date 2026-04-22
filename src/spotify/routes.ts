import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import SpotifyWebApi from 'spotify-web-api-node';
import type { Config } from '../config.js';
import type { ModuleStatus } from '../util/types.js';
import { ModuleUnavailableError, UpstreamError, HttpError } from '../util/errors.js';
import type { SpotifyTokenManager } from './tokenManager.js';
import { ArtLRU } from './artCache.js';

export interface SpotifyContext {
  config: Config;
  log: Logger;
  tokens: SpotifyTokenManager;
  getStatus: () => ModuleStatus;
  setStatus: (s: ModuleStatus) => void;
}

/** 5-minute TTL cache for user's playlist list. */
interface PlaylistCacheEntry {
  data: unknown;
  expiresAtMs: number;
}

const PLAYLIST_CACHE_TTL_MS = 5 * 60 * 1000;

function buildClient(ctx: SpotifyContext): SpotifyWebApi {
  if (!ctx.config.spotify.clientId || !ctx.config.spotify.clientSecret) {
    // Shouldn't happen — module.ts would have set status to 'down'.
    throw new ModuleUnavailableError('spotify', 'client creds missing');
  }
  return new SpotifyWebApi({
    clientId: ctx.config.spotify.clientId,
    clientSecret: ctx.config.spotify.clientSecret,
    redirectUri: ctx.config.spotify.redirectUri,
  });
}

async function authedClient(ctx: SpotifyContext): Promise<SpotifyWebApi> {
  if (!ctx.tokens.hasRefreshToken()) {
    throw new ModuleUnavailableError('spotify', 'not logged in — go to /admin');
  }
  const api = buildClient(ctx);
  const token = await ctx.tokens.getAccessToken();
  api.setAccessToken(token);
  return api;
}

/**
 * Small wrapper: spotify-web-api-node throws objects with `.statusCode` and
 * `.body` rather than real Errors. Normalize into our HttpError hierarchy.
 */
function wrapSpotifyError(err: unknown, fallbackMsg: string): HttpError {
  const e = err as { statusCode?: number; body?: unknown; message?: string };
  if (e && typeof e === 'object' && typeof e.statusCode === 'number') {
    if (e.statusCode === 401 || e.statusCode === 403) {
      return new ModuleUnavailableError('spotify', `auth failed (${e.statusCode}) — re-login at /admin`);
    }
    if (e.statusCode === 404) {
      return new HttpError(404, e.message ?? 'not_found', 'not_found');
    }
    if (e.statusCode === 429) {
      return new HttpError(429, 'spotify rate limit', 'rate_limited');
    }
    return new UpstreamError(`spotify ${e.statusCode}: ${e.message ?? fallbackMsg}`, 'spotify');
  }
  return new UpstreamError(`${fallbackMsg}: ${(err as Error).message ?? String(err)}`, 'spotify');
}

export async function registerSpotifyRoutes(
  app: FastifyInstance,
  ctx: SpotifyContext
): Promise<void> {
  const auth = { preHandler: app.requireDeviceToken };

  // In-memory caches scoped to this module instance.
  let playlistCache: PlaylistCacheEntry | null = null;
  const artCache = new ArtLRU(200);

  // -------------------------------------------------------------------------
  // GET /spotify/search
  // -------------------------------------------------------------------------
  app.get('/spotify/search', auth, async (req) => {
    const q = req.query as { q?: string; type?: string; limit?: string } | undefined;
    const query = q?.q?.trim();
    if (!query) {
      throw new HttpError(400, 'missing ?q=', 'bad_request');
    }
    const typeParam = q?.type ?? 'track';
    const allowed = new Set(['track', 'album', 'playlist', 'artist']);
    const types = typeParam.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
    for (const t of types) {
      if (!allowed.has(t)) {
        throw new HttpError(400, `bad type: ${t}`, 'bad_request');
      }
    }
    const limit = Math.min(50, Math.max(1, Number.parseInt(q?.limit ?? '20', 10) || 20));
    const api = await authedClient(ctx);
    try {
      const res = await api.search(query, types as Array<'track' | 'album' | 'playlist' | 'artist'>, { limit });
      return res.body;
    } catch (err) {
      throw wrapSpotifyError(err, 'search failed');
    }
  });

  // -------------------------------------------------------------------------
  // GET /spotify/playlists — 5-min in-memory cache of the user's playlists
  // -------------------------------------------------------------------------
  app.get('/spotify/playlists', auth, async () => {
    const now = Date.now();
    if (playlistCache && playlistCache.expiresAtMs > now) {
      return playlistCache.data;
    }
    const api = await authedClient(ctx);
    try {
      // Spotify caps at 50/page; we fetch up to 100 to cover most users.
      // The single-arg overload targets the current user (derived from the
      // access token's scope) — using it instead of `(undefined, opts)` so
      // the type checker picks the right overload.
      const [page1, page2] = await Promise.all([
        api.getUserPlaylists({ limit: 50, offset: 0 }),
        api.getUserPlaylists({ limit: 50, offset: 50 }),
      ]);
      const items = [...page1.body.items, ...page2.body.items];
      const data = {
        total: page1.body.total,
        items,
      };
      playlistCache = { data, expiresAtMs: now + PLAYLIST_CACHE_TTL_MS };
      return data;
    } catch (err) {
      throw wrapSpotifyError(err, 'getUserPlaylists failed');
    }
  });

  // -------------------------------------------------------------------------
  // GET /spotify/playlist/:id — track list
  // -------------------------------------------------------------------------
  app.get('/spotify/playlist/:id', auth, async (req) => {
    const { id } = req.params as { id: string };
    if (!id) throw new HttpError(400, 'missing id', 'bad_request');
    const api = await authedClient(ctx);
    try {
      const [meta, tracks] = await Promise.all([
        api.getPlaylist(id, { fields: 'id,name,description,owner,images,tracks(total)' }),
        api.getPlaylistTracks(id, {
          limit: 100,
          fields: 'items(track(id,name,duration_ms,artists(id,name),album(id,name,images))),next,total',
        }),
      ]);
      return {
        playlist: meta.body,
        tracks: tracks.body,
      };
    } catch (err) {
      throw wrapSpotifyError(err, 'getPlaylist failed');
    }
  });

  // -------------------------------------------------------------------------
  // GET /spotify/now-playing — passthrough of /me/player/currently-playing
  // -------------------------------------------------------------------------
  app.get('/spotify/now-playing', auth, async (_req, reply) => {
    const api = await authedClient(ctx);
    try {
      const res = await api.getMyCurrentPlayingTrack();
      // Spotify returns 204 No Content when nothing is playing. The client
      // library collapses that into an empty body; we surface a consistent
      // shape for the BB client.
      if (!res.body || Object.keys(res.body).length === 0) {
        void reply.code(200);
        return { isPlaying: false };
      }
      return res.body;
    } catch (err) {
      throw wrapSpotifyError(err, 'now-playing failed');
    }
  });

  // -------------------------------------------------------------------------
  // GET /spotify/art/:id — proxy Spotify's image CDN via in-memory LRU
  //
  // `id` is the Spotify object ID (album / playlist / track). We try each
  // object type until we find one with an image. The BB client can pass the
  // album ID directly if it knows it.
  //
  // Query: ?type=album|playlist|track|artist (defaults to album)
  //        ?size=large|medium|small (affects which of Spotify's 3 URLs we pick)
  // -------------------------------------------------------------------------
  app.get('/spotify/art/:id', auth, async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { type?: string; size?: string } | undefined;
    const type = q?.type ?? 'album';
    const sizePref = q?.size ?? 'medium';
    const cacheKey = `${type}:${id}:${sizePref}`;

    const cached = artCache.get(cacheKey);
    if (cached) {
      void reply.type(cached.contentType).header('cache-control', 'public, max-age=86400');
      return reply.send(cached.buf);
    }

    const api = await authedClient(ctx);
    let images: Array<{ url: string; width?: number | null; height?: number | null }> | null = null;
    try {
      switch (type) {
        case 'album': {
          const r = await api.getAlbum(id);
          images = r.body.images;
          break;
        }
        case 'playlist': {
          const r = await api.getPlaylist(id, { fields: 'images' });
          // `fields: 'images'` narrows the runtime payload but the static type
          // is still SinglePlaylistResponse; route through `unknown` before
          // re-casting to the narrow shape we actually receive.
          images = (r.body as unknown as { images?: typeof images }).images ?? null;
          break;
        }
        case 'track': {
          const r = await api.getTrack(id);
          images = r.body.album.images;
          break;
        }
        case 'artist': {
          const r = await api.getArtist(id);
          images = r.body.images;
          break;
        }
        default:
          throw new HttpError(400, `bad type: ${type}`, 'bad_request');
      }
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw wrapSpotifyError(err, 'getImage failed');
    }

    if (!images || images.length === 0) {
      throw new HttpError(404, 'no art for this object', 'not_found');
    }

    const picked = pickImage(images, sizePref);
    const imgRes = await fetch(picked.url);
    if (!imgRes.ok) {
      throw new UpstreamError(`spotify image CDN ${imgRes.status}`, 'spotify-cdn');
    }
    const ab = await imgRes.arrayBuffer();
    const buf = Buffer.from(ab);
    const contentType = imgRes.headers.get('content-type') ?? 'image/jpeg';
    artCache.set(cacheKey, buf, contentType);

    void reply.type(contentType).header('cache-control', 'public, max-age=86400');
    return reply.send(buf);
  });

  // -------------------------------------------------------------------------
  // POST /spotify/control
  // Body: { action, position?, deviceId?, uri? }
  // -------------------------------------------------------------------------
  app.post('/spotify/control', auth, async (req, reply) => {
    const body = (req.body ?? {}) as {
      action?: string;
      position?: number;
      deviceId?: string;
      uri?: string;
    };
    const action = body.action;
    if (!action) {
      throw new HttpError(400, 'missing action', 'bad_request');
    }
    const api = await authedClient(ctx);

    try {
      switch (action) {
        case 'play': {
          // If a uri is provided we queue/play it; otherwise resume.
          const opts: { device_id?: string; uris?: string[]; context_uri?: string } = {};
          if (body.deviceId) opts.device_id = body.deviceId;
          if (body.uri) {
            // Accept either a track uri or a context uri (playlist/album).
            if (body.uri.startsWith('spotify:track:')) {
              opts.uris = [body.uri];
            } else {
              opts.context_uri = body.uri;
            }
          }
          await api.play(opts);
          break;
        }
        case 'pause': {
          await api.pause(body.deviceId ? { device_id: body.deviceId } : {});
          break;
        }
        case 'next': {
          await api.skipToNext(body.deviceId ? { device_id: body.deviceId } : {});
          break;
        }
        case 'prev': {
          await api.skipToPrevious(body.deviceId ? { device_id: body.deviceId } : {});
          break;
        }
        case 'seek': {
          if (typeof body.position !== 'number' || !Number.isFinite(body.position)) {
            throw new HttpError(400, 'seek requires numeric position (ms)', 'bad_request');
          }
          await api.seek(Math.floor(body.position), body.deviceId ? { device_id: body.deviceId } : {});
          break;
        }
        case 'transfer': {
          if (!body.deviceId) {
            throw new HttpError(400, 'transfer requires deviceId', 'bad_request');
          }
          await api.transferMyPlayback([body.deviceId], { play: true });
          break;
        }
        default:
          throw new HttpError(400, `unknown action: ${action}`, 'bad_request');
      }
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw wrapSpotifyError(err, `control ${action} failed`);
    }

    void reply.code(204);
    return null;
  });

  // -------------------------------------------------------------------------
  // GET /spotify/play/:trackId — DEFERRED to M4b
  //
  // TODO M4b: audio pipeline.
  //   - Spawn a managed `librespot` child process in module.ts (one instance,
  //     long-lived), authed with the same refresh token via `--credentials`
  //     (librespot supports passing a Spotify access/refresh token).
  //   - librespot's `--backend pipe --device -` writes raw S16LE PCM to stdout.
  //   - Pipe that through `ffmpeg -f s16le -ar 44100 -ac 2 -i - -c:a libmp3lame
  //     -b:a 96k -f mp3 -` and write the MP3 bytes into the Fastify reply
  //     stream as `audio/mpeg`.
  //   - On request, call `api.play({ uris:['spotify:track:'+trackId] })` to
  //     direct librespot (which has registered itself as a Connect device) to
  //     start playback, then hold the HTTP response open until the track ends.
  //   - Range/seek: restart librespot with a seek offset via the Connect API
  //     (`api.seek(ms)`) and re-open a fresh ffmpeg for the tail.
  //   - See PRD_01 §6.3 and PRD_03 §5, §7, §8.
  //
  // For now we 503 with a helpful message pointing at POST /spotify/control.
  // -------------------------------------------------------------------------
  app.get('/spotify/play/:trackId', auth, async () => {
    throw new ModuleUnavailableError(
      'spotify',
      'audio pipeline pending M4b — use POST /spotify/control {action:"play", uri:"spotify:track:<id>"} with a Spotify Connect device in the meantime'
    );
  });
}

function pickImage(
  images: Array<{ url: string; width?: number | null; height?: number | null }>,
  sizePref: string
): { url: string } {
  // Spotify typically returns 3 images: ~640, ~300, ~64.
  // The BB screen is 640x480 so "medium" (~300) is the sweet spot.
  const sorted = [...images].sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
  if (sorted.length === 0) return { url: '' };
  const smallest = sorted[0]!;
  const middle = sorted[Math.floor(sorted.length / 2)]!;
  const largest = sorted[sorted.length - 1]!;
  switch (sizePref) {
    case 'small': return { url: smallest.url };
    case 'large': return { url: largest.url };
    case 'medium':
    default: return { url: middle.url };
  }
}
