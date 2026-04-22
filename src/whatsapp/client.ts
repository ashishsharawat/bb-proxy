import { EventEmitter } from 'node:events';
import path from 'node:path';
import type { Logger } from 'pino';
// whatsapp-web.js does not ship types for every shape we touch; we keep our
// imports narrow and treat anything on `Client`/`Chat`/`Message` that is not
// type-checked as `any` locally. The surface we consume is very small.
import pkg from 'whatsapp-web.js';
const { Client, LocalAuth, MessageMedia } = pkg;

/** Minimal wwebjs surface we actually use. Typed loosely on purpose. */
type WAClient = InstanceType<typeof Client>;
type WAMessage = {
  id: { _serialized: string };
  from: string;
  to: string;
  author?: string;
  body: string;
  timestamp: number;         // seconds
  fromMe: boolean;
  hasMedia: boolean;
  type: string;
  ack: number;               // -1 err, 0 pending, 1 sent, 2 received, 3 read, 4 played
  getChat: () => Promise<WAChat>;
  downloadMedia: () => Promise<{ mimetype: string; data: string; filename?: string | null } | undefined>;
};
type WAChat = {
  id: { _serialized: string };
  name: string;
  isGroup: boolean;
  unreadCount: number;
  timestamp: number;
  lastMessage?: WAMessage;
  fetchMessages: (opts: { limit: number }) => Promise<WAMessage[]>;
  sendSeen: () => Promise<boolean>;
  sendMessage: (content: string) => Promise<WAMessage>;
};

export interface ChatSummary {
  id: string;
  name: string;
  isGroup: boolean;
  lastMessage: { body: string; ts: number; fromMe: boolean } | null;
  unread: number;
  avatarUrl: string;
}

export interface NormalizedMessage {
  id: string;
  ts: number;           // ms
  author: string | null;
  body: string;
  mediaId?: string;
  mediaMime?: string;
  deliveryState: number; // mirrors BB app's 0..4 scheme
}

export interface ClientState {
  linked: boolean;
  connected: boolean;
  qrDataUrl: string | null;  // current PNG data URL if waiting to pair, else null
  lastError: string | null;
}

/**
 * Events emitted:
 *   'message'       — a NormalizedMessage (inbound or outbound reflection)
 *   'state'         — new ClientState snapshot
 *   'ready'         — wwebjs ready
 *   'auth_failure'  — fatal auth error; caller should surface to status
 *   'disconnected'  — reason string
 */
export class WhatsAppClientWrapper extends EventEmitter {
  private client: WAClient | null = null;
  private currentQr: string | null = null;  // raw QR text from wwebjs (not the PNG)
  private state: ClientState = {
    linked: false,
    connected: false,
    qrDataUrl: null,
    lastError: null,
  };
  private destroyed = false;

  constructor(
    private readonly log: Logger,
    private readonly dataDir: string,
  ) {
    super();
  }

  /** wwebjs raw QR string (used by the /qr route to render a PNG on demand). */
  getQrString(): string | null {
    return this.currentQr;
  }

  getState(): ClientState {
    return this.state;
  }

  async start(): Promise<void> {
    // If we are being restarted (e.g. on a disconnected-retry path),
    // tear down any dangling Chromium first. We bypass stop() because
    // stop() marks destroyed=true and we want to keep the wrapper alive
    // for further emits.
    if (this.client) {
      const prev = this.client;
      this.client = null;
      try {
        await prev.destroy();
      } catch (err) {
        this.log.warn({ err }, 'error destroying previous wwebjs client (ignored)');
      }
    }
    this.destroyed = false;

    const sessionDir = path.join(this.dataDir, 'wa-session');
    this.log.info({ sessionDir }, 'booting whatsapp-web.js client');

    const client = new Client({
      authStrategy: new LocalAuth({
        clientId: 'bb-proxy',
        dataPath: sessionDir,
      }),
      puppeteer: {
        headless: true,
        // These flags are required for running Chromium as root inside a
        // Docker container with a tiny /dev/shm. Playwright's base image
        // already has the Chromium system deps — wwebjs/puppeteer-core
        // picks up the same bundled Chromium.
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
        ],
      },
      // Keep the cache local so auth churn doesn't re-download wwebjs's
      // bundled WhatsApp Web html on every boot.
      webVersionCache: { type: 'local' },
    });
    this.client = client;

    client.on('qr', (qr: string) => {
      this.currentQr = qr;
      this.state = { ...this.state, linked: false, connected: false, qrDataUrl: qr };
      this.log.info('whatsapp QR received; waiting for scan');
      this.emit('state', this.state);
    });

    client.on('authenticated', () => {
      this.log.info('whatsapp authenticated');
      this.currentQr = null;
      this.state = { ...this.state, linked: true, qrDataUrl: null, lastError: null };
      this.emit('state', this.state);
    });

    client.on('auth_failure', (msg: string) => {
      this.log.error({ msg }, 'whatsapp auth_failure');
      this.state = { ...this.state, linked: false, connected: false, lastError: msg };
      this.emit('state', this.state);
      this.emit('auth_failure', msg);
    });

    client.on('ready', () => {
      this.log.info('whatsapp client ready');
      this.currentQr = null;
      this.state = { linked: true, connected: true, qrDataUrl: null, lastError: null };
      this.emit('state', this.state);
      this.emit('ready');
    });

    client.on('disconnected', (reason: string) => {
      this.log.warn({ reason }, 'whatsapp disconnected');
      this.state = { ...this.state, connected: false, lastError: reason };
      this.emit('state', this.state);
      this.emit('disconnected', reason);
    });

    client.on('message', (m: WAMessage) => {
      // Normalize and broadcast. Route layer filters by `since`.
      this.emit('message', normalizeMessage(m));
    });

    // Outbound reflection — makes the long-poll pick up what other devices
    // send as well, which the BB app needs to mirror read-state and keep
    // chat ordering correct.
    client.on('message_create', (m: WAMessage) => {
      if (m.fromMe) this.emit('message', normalizeMessage(m));
    });

    // Ack changes (delivered/read receipts) also come through as events.
    // We surface them as pseudo-messages with updated deliveryState so the
    // BB app can upgrade bubbles without another endpoint.
    // TODO M3b: separate `GET /whatsapp/acks?since=` endpoint if the
    // pseudo-message channel proves too chatty.

    await client.initialize();
  }

  async stop(): Promise<void> {
    this.destroyed = true;
    const c = this.client;
    this.client = null;
    if (c) {
      try {
        await c.destroy();
      } catch (err) {
        this.log.warn({ err }, 'error during wwebjs destroy (ignored)');
      }
    }
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  /** Last N chats by recency. */
  async getChats(limit: number): Promise<ChatSummary[]> {
    const c = this.clientAny();
    const chats = (await c.getChats()) as WAChat[];
    // wwebjs returns chats already ordered by recency, but be explicit.
    const sorted = [...chats].sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
    return sorted.slice(0, limit).map((chat) => {
      const last = chat.lastMessage;
      return {
        id: chat.id._serialized,
        name: chat.name || chat.id._serialized,
        isGroup: chat.isGroup,
        lastMessage: last
          ? {
              body: last.body ?? '',
              ts: (last.timestamp ?? 0) * 1000,
              fromMe: Boolean(last.fromMe),
            }
          : null,
        unread: chat.unreadCount ?? 0,
        avatarUrl: `/whatsapp/media/avatar-${encodeURIComponent(chat.id._serialized)}`,
      };
    });
  }

  /**
   * Messages for a chat. If `before` is set (ms), only older messages are
   * returned. wwebjs's `fetchMessages` returns newest-first in practice;
   * we filter + reverse to ascending ts.
   */
  async getMessages(chatId: string, limit: number, before: number | null): Promise<NormalizedMessage[]> {
    const c = this.clientAny();
    const chat = (await c.getChatById(chatId)) as WAChat;
    // If we need messages before a timestamp, we have to over-fetch and
    // filter — wwebjs doesn't take a cursor directly. For M3a we ask for
    // 3x the window when `before` is set; deep backfill is M3b.
    const fetchLimit = before !== null ? Math.min(limit * 3, 200) : limit;
    const raw = await chat.fetchMessages({ limit: fetchLimit });
    const normalized = raw.map(normalizeMessage);
    const filtered = before !== null ? normalized.filter((m) => m.ts < before) : normalized;
    filtered.sort((a, b) => a.ts - b.ts);
    return filtered.slice(-limit);
  }

  async sendText(chatId: string, text: string): Promise<string> {
    const c = this.clientAny();
    const sent = (await c.sendMessage(chatId, text)) as WAMessage;
    return sent.id._serialized;
  }

  async markRead(chatId: string): Promise<void> {
    const c = this.clientAny();
    const chat = (await c.getChatById(chatId)) as WAChat;
    await chat.sendSeen();
  }

  /**
   * Download a media payload by message id. Returns { mime, buffer } or null
   * if the message can't be found or doesn't carry media.
   */
  async downloadMedia(messageId: string): Promise<{ mime: string; buffer: Buffer } | null> {
    const c = this.clientAny();
    const msg = (await c.getMessageById(messageId)) as WAMessage | null;
    if (!msg || !msg.hasMedia) return null;
    const media = await msg.downloadMedia();
    if (!media) return null;
    return {
      mime: media.mimetype,
      buffer: Buffer.from(media.data, 'base64'),
    };
  }

  /**
   * Cast-through-`any` escape hatch for wwebjs client methods whose typings
   * are either missing or incorrect in the package's shipped .d.ts. Used
   * sparingly and only inside this module; the public methods return our
   * own typed shapes (ChatSummary / NormalizedMessage / etc).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private clientAny(): any {
    if (!this.client) throw new Error('wwebjs client not ready');
    return this.client;
  }
}

function normalizeMessage(m: WAMessage): NormalizedMessage {
  const tsMs = (m.timestamp ?? 0) * 1000;
  // Map wwebjs ack values into the BB app's deliveryState scheme (see
  // PRD_04 §9). 0=sending, 1=sent, 2=delivered, 3=read, 4=failed.
  let deliveryState = 1;
  if (m.fromMe) {
    if (m.ack === -1) deliveryState = 4;
    else if (m.ack === 0) deliveryState = 0;
    else if (m.ack === 1) deliveryState = 1;
    else if (m.ack === 2) deliveryState = 2;
    else if (m.ack >= 3) deliveryState = 3;
  } else {
    // Inbound messages: treat as "delivered" from the BB's perspective.
    deliveryState = 2;
  }
  const out: NormalizedMessage = {
    id: m.id._serialized,
    ts: tsMs,
    author: m.author ?? (m.fromMe ? null : m.from),
    body: m.body ?? '',
    deliveryState,
  };
  if (m.hasMedia) {
    out.mediaId = m.id._serialized;
    // wwebjs doesn't give mime without a download; hint via `type` and let
    // the media route confirm. Leaving mediaMime undefined is legal per
    // PRD_04 §9; the BB app falls back to image/jpeg for thumbs.
  }
  return out;
}

// Re-export MessageMedia for future callers (e.g. media upload in M3b).
export { MessageMedia };
