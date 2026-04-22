import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply, preHandlerHookHandler } from 'fastify';
import type { Db } from '../db/index.js';

export function hashToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

export function generateDeviceToken(): { raw: string; hash: string } {
  const raw = crypto.randomBytes(24).toString('base64url');
  return { raw, hash: hashToken(raw) };
}

function extractToken(req: FastifyRequest): string | null {
  const hdr = req.headers['x-device-token'];
  if (typeof hdr === 'string' && hdr.length > 0) return hdr;
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    return auth.slice('Bearer '.length).trim() || null;
  }
  return null;
}

export function createDeviceTokenMiddleware(db: Db): preHandlerHookHandler {
  const lookup = db.prepare<[string], { id: number }>(
    `SELECT id FROM devices WHERE token_hash = ? LIMIT 1`
  );
  const touch = db.prepare<[number, number]>(
    `UPDATE devices SET last_seen_at = ? WHERE id = ?`
  );

  return async function requireDeviceToken(
    req: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    const raw = extractToken(req);
    if (!raw) {
      void reply.code(401).send({ error: 'device_token_required' });
      return;
    }
    const row = lookup.get(hashToken(raw));
    if (!row) {
      void reply.code(401).send({ error: 'device_token_invalid' });
      return;
    }
    req.deviceId = row.id;
    touch.run(Date.now(), row.id);
  };
}

export function mintDevice(db: Db, label: string | null): { id: number; rawToken: string } {
  const { raw, hash } = generateDeviceToken();
  const info = db.prepare(
    `INSERT INTO devices (token_hash, label, created_at) VALUES (?, ?, ?)`
  ).run(hash, label, Date.now());
  return { id: Number(info.lastInsertRowid), rawToken: raw };
}

export function listDevices(db: Db): Array<{ id: number; label: string | null; createdAt: number; lastSeenAt: number | null }> {
  return db
    .prepare(
      `SELECT id, label, created_at as createdAt, last_seen_at as lastSeenAt FROM devices ORDER BY created_at DESC`
    )
    .all() as Array<{ id: number; label: string | null; createdAt: number; lastSeenAt: number | null }>;
}

export function revokeDevice(db: Db, id: number): boolean {
  const info = db.prepare(`DELETE FROM devices WHERE id = ?`).run(id);
  return info.changes > 0;
}

export async function registerDeviceTokenAuth(app: FastifyInstance): Promise<void> {
  const mw = createDeviceTokenMiddleware(app.db);
  app.decorate('requireDeviceToken', mw);
}
