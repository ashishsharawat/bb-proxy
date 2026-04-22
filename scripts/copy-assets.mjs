// Copies non-TS assets (SQL schema, HTML views) into dist/ after tsc.
// Runs via `npm run build` on any platform — pure Node, no shell copy commands.

import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, '..');

function copyFileSync(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  console.log(`  copy  ${path.relative(root, src)} -> ${path.relative(root, dest)}`);
}

function copyDirSync(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) return;
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const s = path.join(srcDir, entry.name);
    const d = path.join(destDir, entry.name);
    if (entry.isDirectory()) copyDirSync(s, d);
    else copyFileSync(s, d);
  }
}

copyFileSync(path.join(root, 'src/db/schema.sql'), path.join(root, 'dist/db/schema.sql'));
copyDirSync(path.join(root, 'src/admin/views'), path.join(root, 'dist/admin/views'));

console.log('assets copied.');
