import fs from 'node:fs';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Logger } from 'pino';
import QRCode from 'qrcode';
import type { Config } from '../config.js';
import type { ModuleStatus } from '../util/types.js';
import type { NormalizedMessage, WhatsAppClientWrapper } from './client.js';
import type { WhatsAppMediaCache, MediaSize } from './media.js';
import type { SendIdempotencyCache } from './idempotency.js';

export interface WhatsAppContext {
  config: Config;
  log: Logger;
  client: WhatsAppClientWrapper;
  media: WhatsAppMediaCache;
  idem: SendIdempotencyCache;
  getStatus: () => ModuleStatus;
  setStatus: (s: ModuleStatus) => void;
}

const LONG_POLL_MS = 25_000;

export async function registerWhatsAppRoutes(app: FastifyInstance, ctx: WhatsAppContext): Promise<void> {
  const auth = { preHandler: app.requireDeviceToken };
  const db = app.db;

  // Prepared statements for wa_cache (see schema.sql).
  const insertCache = db.prepare<[string, string, number, string | null, string | null, string | null, string | null]>(
    `INSERT INTO wa_cache (chat_id, message_id, ts, author, body, media_id, media_mime)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(chat_id, message_id) DO UPDATE SET
       ts = excluded.ts,
       author = excluded.author,
       body = excluded.body,
       media_id = excluded.media_id,
       media_mime = excluded.media_mime`,
  );
  const cacheMessages = db.transaction((chatId: string, msgs: NormalizedMessage[]) => {
    for (const m of msgs) {
      insertCache.run(
        chatId,
        m.id,
        m.ts,
        m.author ?? null,
        m.body ?? null,
        m.mediaId ?? null,
        m.mediaMime ?? null,
      );
    }
  });

  // ---------------- /whatsapp/qr (admin only) ---------------------------

  app.get('/whatsapp/qr', { onRequest: app.basicAuth }, async (_req, reply) => {
    const state = ctx.client.getState();
    if (state.linked) {
      void reply.code(404).send({ error: 'already_linked' });
      return;
    }
    const qr = ctx.client.getQrString();
    if (!qr) {
      void reply.code(404).send({ error: 'qr_not_ready', detail: 'wwebjs has not emitted a QR yet; retry shortly' });
      return;
    }
    const png = await QRCode.toBuffer(qr, { type: 'png', width: 384, margin: 2 });
    void reply
      .header('Cache-Control', 'no-store')
      .type('image/png')
      .send(png);
  });

  // ---------------- /whatsapp/status ------------------------------------

  app.get('/whatsapp/status', auth, async () => {
    const s = ctx.client.getState();
    const out: { linked: boolean; connected: boolean; lastError?: string } = {
      linked: s.linked,
      connected: s.connected,
    };
    if (s.lastError) out.lastError = s.lastError;
    return out;
  });

  // ---------------- /whatsapp/chats -------------------------------------

  app.get('/whatsapp/chats', auth, async (req, reply) => {
    if (!ensureConnected(ctx, reply)) return;
    const q = req.query as { limit?: string } | undefined;
    const limit = clampInt(q?.limit, 1, 100, 30);
    const chats = await ctx.client.getChats(limit);
    return { chats };
  });

  // ---------------- /whatsapp/messages/:chatId --------------------------

  app.get('/whatsapp/messages/:chatId', auth, async (req, reply) => {
    if (!ensureConnected(ctx, reply)) return;
    const { chatId } = req.params as { chatId: string };
    const q = req.query as { limit?: string; before?: string } | undefined;
    const limit = clampInt(q?.limit, 1, 200, 50);
    const before = q?.before !== undefined ? Number.parseInt(q.before, 10) : NaN;
    const beforeTs = Number.isFinite(before) ? before : null;

    const messages = await ctx.client.getMessages(chatId, limit, beforeTs);
    // Persist to wa_cache so reopens are instant (per task spec).
    try {
      cacheMessages(chatId, messages);
    } catch (err) {
      ctx.log.warn({ err, chatId }, 'failed to write wa_cache (non-fatal)');
    }
    return { messages };
  });

  // ---------------- /whatsapp/send --------------------------------------

  app.post('/whatsapp/send', auth, async (req, reply) => {
    if (!ensureConnected(ctx, reply)) return;
    const body = (req.body ?? {}) as { chatId?: unknown; text?: unknown; clientMsgId?: unknown };
    const chatId = typeof body.chatId === 'string' ? body.chatId : '';
    const text = typeof body.text === 'string' ? body.text : '';
    const clientMsgId = typeof body.clientMsgId === 'string' ? body.clientMsgId : '';
    if (!chatId || !text || !clientMsgId) {
      void reply.code(400).send({ error: 'bad_request', detail: 'chatId, text, clientMsgId required' });
      return;
    }

    const prior = ctx.idem.get(clientMsgId);
    if (prior) {
      return { status: 'sent', serverMsgId: prior, idempotent: true };
    }

    try {
      const serverMsgId = await ctx.client.sendText(chatId, text);
      ctx.idem.set(clientMsgId, serverMsgId);
      return { status: 'sent', serverMsgId };
    } catch (err) {
      ctx.log.error({ err, chatId }, 'send failed');
      void reply.code(502).send({
        status: 'failed',
        error: 'upstream_send_failed',
        detail: err instanceof Error ? err.message : String(err),
      });
      return;
    }
  });

  // ---------------- /whatsapp/mark-read ---------------------------------

  app.post('/whatsapp/mark-read', auth, async (req, reply) => {
    if (!ensureConnected(ctx, reply)) return;
    const body = (req.body ?? {}) as { chatId?: unknown };
    const chatId = typeof body.chatId === 'string' ? body.chatId : '';
    if (!chatId) {
      void reply.code(400).send({ error: 'bad_request', detail: 'chatId required' });
      return;
    }
    await ctx.client.markRead(chatId);
    return { ok: true };
  });

  // ---------------- /whatsapp/poll (long-poll) --------------------------

  app.get('/whatsapp/poll', auth, async (req, reply) => {
    if (!ensureConnected(ctx, reply)) return;
    const q = req.query as { since?: string } | undefined;
    const since = q?.since !== undefined ? Number.parseInt(q.since, 10) : NaN;
    const sinceTs = Number.isFinite(since) ? since : 0;

    try {
      return await waitForMessages(ctx, reply, sinceTs);
    } catch (err) {
      if (err instanceof ClientClosedError) {
        // Socket already torn down; signal Fastify to skip its response
        // pipeline. `hijack()` is the documented way to tell Fastify we've
        // handled the lifecycle ourselves.
        reply.hijack();
        return;
      }
      throw err;
    }
  });

  // ---------------- /whatsapp/media/:mediaId ----------------------------

  app.get('/whatsapp/media/:mediaId', auth, async (req, reply) => {
    const { mediaId } = req.params as { mediaId: string };
    const q = req.query as { size?: string } | undefined;
    const size = parseSize(q?.size);

    // Avatar URLs point here too (per task spec), but real avatar fetching
    // is M3b — we stub them as 404 so the BB app can gracefully fall back.
    if (mediaId.startsWith('avatar-')) {
      // TODO M3b: fetch the chat's contact profile picture via
      // `client.getProfilePicUrl(chatId)` and proxy it through sharp.
      void reply.code(404).send({ error: 'avatars_not_implemented', detail: 'M3b' });
      return;
    }

    if (!ensureConnected(ctx, reply)) return;

    let entry: Awaited<ReturnType<typeof ctx.media.get>>;
    try {
      entry = await ctx.media.get(mediaId, size);
    } catch (err) {
      ctx.log.error({ err, mediaId }, 'media fetch failed');
      void reply.code(502).send({ error: 'media_fetch_failed' });
      return;
    }

    if (entry === null) {
      void reply.code(404).send({ error: 'media_not_found' });
      return;
    }
    if ('notImage' in entry) {
      void reply.code(415).send({ error: 'unsupported_media_type', detail: 'non-image media is not supported in M3a' });
      return;
    }

    void reply
      .header('Cache-Control', 'public, max-age=86400, immutable')
      .type(entry.mime)
      .send(fs.createReadStream(entry.path));
  });
}

// ---------------- helpers ---------------------------------------------------

/**
 * Returns true if the wwebjs client is linked + connected. If not, sends a
 * 503 on the reply and returns false — callers must `return` immediately.
 */
function ensureConnected(ctx: WhatsAppContext, reply: FastifyReply): boolean {
  const s = ctx.client.getState();
  if (!s.linked) {
    void reply.code(503).send({ error: 'wa_not_linked', detail: 'scan the QR at /whatsapp/qr (admin)' });
    return false;
  }
  if (!s.connected) {
    void reply.code(503).send({ error: 'wa_disconnected', detail: s.lastError ?? 'reconnecting' });
    return false;
  }
  return true;
}

function clampInt(raw: string | undefined, min: number, max: number, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function parseSize(raw: string | undefined): MediaSize {
  return raw === 'full' ? 'full' : 'thumb';
}

/**
 * Long-poll implementation. Attaches a one-shot 'message' listener on the
 * wwebjs wrapper; resolves with any buffered messages whose ts > since. On
 * timeout, resolves with an empty list. On client disconnect, rejects with
 * a sentinel so the route handler can short-circuit without calling send.
 *
 * All three termination paths (match, timeout, disconnect) MUST:
 *   - detach the 'message' listener on the wwebjs wrapper
 *   - detach the 'close' listener on reply.raw
 *   - clear the timeout
 * A missed cleanup here compounds per open poll and eats memory fast.
 */
class ClientClosedError extends Error {
  constructor() {
    super('client closed');
    this.name = 'ClientClosedError';
  }
}

function waitForMessages(
  ctx: WhatsAppContext,
  reply: FastifyReply,
  since: number,
): Promise<{ messages: NormalizedMessage[]; ts: number }> {
  return new Promise((resolve, reject) => {
    const buffer: NormalizedMessage[] = [];
    let timer: NodeJS.Timeout | null = null;
    let batchTimer: NodeJS.Timeout | null = null;
    let done = false;

    const cleanup = (): void => {
      ctx.client.off('message', onMessage);
      reply.raw.off('close', onClose);
      if (timer) { clearTimeout(timer); timer = null; }
      if (batchTimer) { clearTimeout(batchTimer); batchTimer = null; }
    };

    const finish = (): void => {
      if (done) return;
      done = true;
      cleanup();
      resolve({ messages: buffer, ts: Date.now() });
    };

    const onMessage = (m: NormalizedMessage): void => {
      if (done) return;
      if (m.ts <= since) return;
      buffer.push(m);
      // Tiny debounce to batch ack bursts (same-message delivered + read
      // often fire within a few ms). ~50ms is inside the BB's tolerance.
      if (batchTimer === null) {
        batchTimer = setTimeout(finish, 50);
      }
    };

    const onClose = (): void => {
      if (done) return;
      done = true;
      cleanup();
      reject(new ClientClosedError());
    };

    ctx.client.on('message', onMessage);
    reply.raw.on('close', onClose);
    timer = setTimeout(finish, LONG_POLL_MS);
  });
}

export { ClientClosedError };
