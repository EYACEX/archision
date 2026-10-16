// Write a phone-sized copy of every lightmap: X_lightmap.webp → X_lightmap.mobile.webp (max 2048 px).
// A 4096 lightmap is ~4× the download for detail a phone screen can't show.
// Usage: node mobile_lightmaps.mjs bake-out-dir
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const MAX = 2048;
const dir = process.argv[2];
for (const f of (await readdir(dir)).filter(f => f.endsWith('_lightmap.webp'))) {
  const src = path.join(dir, f);
  const dst = path.join(dir, f.replace(/\.webp$/, '.mobile.webp'));
  const { width = MAX } = await sharp(src).metadata();
  const info = await sharp(src).resize(Math.min(width, MAX)).webp({ quality: 85 }).toFile(dst);
  console.log(`${path.basename(dst)}: ${info.width}px, ${Math.round(info.size / 1024)} KB`);
}
