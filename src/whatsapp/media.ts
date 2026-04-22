import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type { Logger } from 'pino';
import type { WhatsAppClientWrapper } from './client.js';

export type MediaSize = 'thumb' | 'full';

const SIZE_PX: Record<MediaSize, number> = { thumb: 160, full: 640 };

/**
 * On-disk media cache. Resized JPEGs live under `<dataDir>/wa-media/`. Names
 * are `<sanitizedMediaId>-<size>.jpg`. We intentionally do not track a DB
 * index — wwebjs can always refetch if the file is missing, and the
 * filesystem is our source of truth.
 */
export class WhatsAppMediaCache {
  private readonly dir: string;

  constructor(
    dataDir: string,
    private readonly client: WhatsAppClientWrapper,
    private readonly log: Logger,
  ) {
    this.dir = path.join(dataDir, 'wa-media');
  }

  async ensureDir(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
  }

  /**
   * Returns the cached/fresh path for a resized media, or null if:
   *   - the underlying message is unknown to wwebjs
   *   - the media is non-image (caller maps to 415)
   * Throws on unexpected failures.
   */
  async get(mediaId: string, size: MediaSize): Promise<{ path: string; mime: string } | { notImage: true } | null> {
    await this.ensureDir();
    const safeId = sanitize(mediaId);
    const cachePath = path.join(this.dir, `${safeId}-${size}.jpg`);

    try {
      await fs.access(cachePath);
      return { path: cachePath, mime: 'image/jpeg' };
    } catch {
      // miss → fetch + resize below
    }

    const dl = await this.client.downloadMedia(mediaId);
    if (!dl) return null;
    if (!dl.mime.startsWith('image/')) {
      return { notImage: true };
    }

    const px = SIZE_PX[size];
    try {
      await sharp(dl.buffer)
        .rotate()                       // respect EXIF orientation
        .resize({ width: px, height: px, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: size === 'thumb' ? 70 : 82, mozjpeg: true })
        .toFile(cachePath);
    } catch (err) {
      this.log.error({ err, mediaId, size }, 'sharp resize failed');
      throw err;
    }

    return { path: cachePath, mime: 'image/jpeg' };
  }
}

function sanitize(id: string): string {
  // mediaId can be an arbitrary wwebjs serialized id (contains `@`, `:`, `_`).
  // Collapse anything not safe for a filename.
  return id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 180);
}
