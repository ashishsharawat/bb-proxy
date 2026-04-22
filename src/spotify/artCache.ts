/**
 * Minimal in-memory LRU cache for album/playlist/track art.
 *
 * Keys are Spotify object IDs ("album:<id>", "track:<id>", etc.) and values
 * are Buffers holding the raw JPEG bytes fetched from Spotify's CDN.
 *
 * 200 entries × ~40KB/JPEG ≈ 8 MB worst case. Fits comfortably in the
 * container RAM envelope (PRD §11 targets <400MB idle, <700MB streaming).
 */

interface Entry {
  buf: Buffer;
  contentType: string;
}

export class ArtLRU {
  private readonly max: number;
  private readonly map = new Map<string, Entry>();

  constructor(max = 200) {
    this.max = max;
  }

  get(key: string): Entry | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    // Touch: move to the end (most-recently-used).
    this.map.delete(key);
    this.map.set(key, entry);
    return entry;
  }

  set(key: string, buf: Buffer, contentType = 'image/jpeg'): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { buf, contentType });
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  size(): number {
    return this.map.size;
  }
}
