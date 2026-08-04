/**
 * Build optimized looping GIF (+ WebP still) character assets.
 * Run: node scripts/build-assets.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import GIFEncoder from 'gif-encoder-2';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const packs = ['dark-cyber', 'warm-white'];
const states = ['idle', 'listening', 'speaking', 'working', 'approval', 'done'];
const WIDTH = 420;

async function buildState(pngPath, outDir, state) {
  const webpPath = path.join(outDir, `${state}.webp`);
  const gifPath = path.join(outDir, `${state}.gif`);

  await sharp(pngPath)
    .resize({ width: WIDTH, withoutEnlargement: true })
    .webp({ quality: 82 })
    .toFile(webpPath);

  const frame1 = await sharp(pngPath)
    .resize({ width: WIDTH, withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const frame2 = await sharp(pngPath)
    .resize({ width: WIDTH, withoutEnlargement: true })
    .modulate({ brightness: 1.05, saturation: 1.08 })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height } = frame1.info;
  const encoder = new GIFEncoder(width, height);
  encoder.setDelay(500);
  encoder.setRepeat(0);
  encoder.start();
  encoder.addFrame(frame1.data);
  encoder.addFrame(frame2.data);
  encoder.finish();
  fs.writeFileSync(gifPath, encoder.out.getData());

  return {
    webpKb: Math.round(fs.statSync(webpPath).size / 1024),
    gifKb: Math.round(fs.statSync(gifPath).size / 1024),
  };
}

async function main() {
  for (const pack of packs) {
    const dir = path.join(root, 'media', 'characters', pack);
    for (const state of states) {
      const png = path.join(dir, `${state}.png`);
      if (!fs.existsSync(png)) {
        console.warn('missing', png);
        continue;
      }
      const sizes = await buildState(png, dir, state);
      console.log(`ok ${pack}/${state} webp=${sizes.webpKb}KB gif=${sizes.gifKb}KB`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
