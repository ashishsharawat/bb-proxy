/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import type { Page } from 'playwright';
import sharp from 'sharp';
import { ulid } from 'ulid';
import type { Db } from '../db/index.js';

// The `/// <reference lib="dom" />` lines above are scoped to this file so the
// inline `page.evaluate(...)` callback gets DOM types. They don't affect other
// files in the project (which remain Node-only per tsconfig.json).

export interface ClickmapEntry {
  id: string;
  rect: { x: number; y: number; w: number; h: number };
  href: string;
}

export interface ClickmapDocument {
  sourceUrl: string;
  viewport: { w: number; h: number };
  rendered: { w: number; h: number };
  /** Scale factor applied when downscaling the screenshot. rects are already in rendered coords. */
  scale: number;
  entries: ClickmapEntry[];
}

export interface Snapshot {
  id: string;
  png: Buffer;
  clickmap: ClickmapDocument;
}

/**
 * Capture a screenshot of the current page, downscale to `targetWidth` px wide
 * PNG via sharp, and build a clickmap of all visible `<a href>` elements with
 * bounding rects translated into the downscaled image's coordinate space.
 */
export async function captureSnapshot(
  page: Page,
  sourceUrl: string,
  targetWidth: number
): Promise<Snapshot> {
  // Gather all <a> rects in viewport coordinates *before* taking the shot so
  // the DOM hasn't been taken over by a pending navigation.
  const raw = await page.evaluate(() => {
    const out: Array<{ href: string; rect: { x: number; y: number; w: number; h: number } }> = [];
    const viewportW = document.documentElement.clientWidth;
    const viewportH = document.documentElement.clientHeight;
    document.querySelectorAll('a[href]').forEach((el) => {
      const a = el as HTMLAnchorElement;
      const href = a.href; // resolved absolute
      if (!href || !/^https?:/i.test(href)) return;
      const r = a.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) return;
      // Skip off-screen anchors; the BB only sees what's rendered.
      if (r.bottom < 0 || r.top > viewportH) return;
      if (r.right < 0 || r.left > viewportW) return;
      out.push({
        href,
        rect: {
          x: Math.max(0, Math.round(r.left)),
          y: Math.max(0, Math.round(r.top)),
          w: Math.round(r.width),
          h: Math.round(r.height),
        },
      });
    });
    return {
      viewport: { w: viewportW, h: viewportH },
      anchors: out,
    };
  });

  // Full-viewport PNG (not full page — the BB only shows one screen at a time).
  const originalPng = await page.screenshot({ type: 'png', fullPage: false });

  // Resize via sharp to `targetWidth` wide, preserving aspect ratio.
  const resized = sharp(originalPng).resize({ width: targetWidth, withoutEnlargement: false });
  const { data: pngBuf, info } = await resized.png().toBuffer({ resolveWithObject: true });

  const scale = info.width / Math.max(1, raw.viewport.w);

  const entries: ClickmapEntry[] = raw.anchors.map((a) => ({
    id: ulid(),
    href: a.href,
    rect: {
      x: Math.round(a.rect.x * scale),
      y: Math.round(a.rect.y * scale),
      w: Math.round(a.rect.w * scale),
      h: Math.round(a.rect.h * scale),
    },
  }));

  const clickmap: ClickmapDocument = {
    sourceUrl,
    viewport: raw.viewport,
    rendered: { w: info.width, h: info.height },
    scale,
    entries,
  };

  return {
    id: ulid(),
    png: pngBuf,
    clickmap,
  };
}

/**
 * Persist a snapshot to the `browser_snapshots` table.
 */
export function storeSnapshot(db: Db, snap: Snapshot, sourceUrl: string): void {
  db.prepare(
    `INSERT INTO browser_snapshots (id, url, mode, content_type, payload, clickmap_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    snap.id,
    sourceUrl,
    'screenshot',
    'image/png',
    snap.png,
    JSON.stringify(snap.clickmap),
    Date.now()
  );
}

export function loadClickmap(db: Db, id: string): ClickmapDocument | null {
  const row = db
    .prepare(`SELECT clickmap_json FROM browser_snapshots WHERE id = ? LIMIT 1`)
    .get(id) as { clickmap_json: string | null } | undefined;
  if (!row || !row.clickmap_json) return null;
  try {
    return JSON.parse(row.clickmap_json) as ClickmapDocument;
  } catch {
    return null;
  }
}
