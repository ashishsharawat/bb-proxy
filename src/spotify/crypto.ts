import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

/**
 * AES-256-GCM encryption for Spotify refresh tokens at rest.
 *
 * Key is derived from ADMIN_PASSWORD via scryptSync(pw, 'bb-proxy-spotify', 32).
 * The salt is a fixed module-scoped string ('bb-proxy-spotify') rather than a
 * per-record salt because:
 *   1. There is exactly one refresh token kept in kv at `spotify.refresh_token`.
 *   2. Callers already know the plaintext key material (ADMIN_PASSWORD) — a
 *      random salt buys nothing against an attacker who also holds the DB.
 *   3. It keeps bootstrap trivial: no extra rows to remember.
 *
 * Format of the stored ciphertext blob (all base64url):
 *   `${iv}.${authTag}.${ciphertext}`
 *
 * 12-byte IV is GCM-standard and generated per-encrypt.
 */

const ALGO = 'aes-256-gcm';
const KEY_SALT = 'bb-proxy-spotify';
const KEY_LEN = 32;
const IV_LEN = 12;

function deriveKey(password: string): Buffer {
  return scryptSync(password, KEY_SALT, KEY_LEN);
}

export function encryptSecret(plaintext: string, password: string): string {
  const key = deriveKey(password);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, ct].map((b) => b.toString('base64url')).join('.');
}

export function decryptSecret(blob: string, password: string): string {
  const parts = blob.split('.');
  if (parts.length !== 3) {
    throw new Error('decryptSecret: malformed blob (expected 3 dot-separated parts)');
  }
  const [ivStr, tagStr, ctStr] = parts as [string, string, string];
  const iv = Buffer.from(ivStr, 'base64url');
  const tag = Buffer.from(tagStr, 'base64url');
  const ct = Buffer.from(ctStr, 'base64url');
  if (iv.length !== IV_LEN) {
    throw new Error(`decryptSecret: bad iv length ${iv.length}`);
  }
  const key = deriveKey(password);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
