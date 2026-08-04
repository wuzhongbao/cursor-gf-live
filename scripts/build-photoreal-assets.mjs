/**
 * Import photoreal source frames and build looping GIFs.
 * Speaking uses a mouth open/close cycle; other states use a soft breathing pulse.
 *
 * Run: node scripts/build-photoreal-assets.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import GIFEncoder from 'gif-encoder-2';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const assetsRoot =
  process.env.GF_LIVE_ASSETS_SRC ||
  path.join(root, 'media', 'characters', '_src');

const WIDTH = 420;
const packs = {
  'dark-cyber': {
    idle: 'gf-ref-idle-dark.png',
    listening: 'gf-dark-listening.png',
    working: 'gf-dark-working.png',
    approval: 'gf-dark-approval.png',
    done: 'gf-dark-done.png',
    speaking: [
      'gf-dark-speaking-closed.png',
      'gf-dark-speaking-mid.png',
      'gf-dark-speaking-open.png',
      'gf-dark-speaking-mid.png',
      'gf-dark-speaking-closed.png',
      'gf-dark-speaking-open.png',
    ],
  },
  'warm-white': {
    idle: 'gf-ref-idle-warm.png',
    listening: 'gf-warm-listening.png',
    working: 'gf-warm-working.png',
    approval: 'gf-warm-approval.png',
    done: 'gf-warm-done.png',
    speaking: [
      'gf-warm-speaking-closed.png',
      'gf-warm-speaking-mid.png',
      'gf-warm-speaking-open.png',
      'gf-warm-speaking-mid.png',
      'gf-warm-speaking-closed.png',
      'gf-warm-speaking-open.png',
    ],
  },
};

async function toRawRgba(inputPath, { brightness = 1, saturation = 1 } = {}) {
  let pipeline = sharp(inputPath).resize({ width: WIDTH, withoutEnlargement: true });
  if (brightness !== 1 || saturation !== 1) {
    pipeline = pipeline.modulate({ brightness, saturation });
  }
  return pipeline.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
}

async function writeGif(frames, delayMs, outPath) {
  const { width, height } = frames[0].info;
  const encoder = new GIFEncoder(width, height);
  encoder.setDelay(delayMs);
  encoder.setRepeat(0);
  encoder.start();
  for (const frame of frames) {
    encoder.addFrame(frame.data);
  }
  encoder.finish();
  fs.writeFileSync(outPath, encoder.out.getData());
}

async function writeWebp(inputPath, outPath) {
  await sharp(inputPath)
    .resize({ width: WIDTH, withoutEnlargement: true })
    .webp({ quality: 84 })
    .toFile(outPath);
}

async function copyPng(src, dest) {
  await sharp(src)
    .resize({ width: WIDTH, withoutEnlargement: true })
    .png({ compressionLevel: 8 })
    .toFile(dest);
}

async function buildBreathingState(srcPath, outDir, state) {
  const pngPath = path.join(outDir, `${state}.png`);
  const webpPath = path.join(outDir, `${state}.webp`);
  const gifPath = path.join(outDir, `${state}.gif`);

  await copyPng(srcPath, pngPath);
  await writeWebp(srcPath, webpPath);

  const frames = [
    await toRawRgba(srcPath),
    await toRawRgba(srcPath, { brightness: 1.03, saturation: 1.04 }),
    await toRawRgba(srcPath),
    await toRawRgba(srcPath, { brightness: 0.98, saturation: 0.98 }),
  ];
  await writeGif(frames, 420, gifPath);

  return {
    webpKb: Math.round(fs.statSync(webpPath).size / 1024),
    gifKb: Math.round(fs.statSync(gifPath).size / 1024),
  };
}

async function buildSpeakingState(framePaths, outDir) {
  const pngPath = path.join(outDir, 'speaking.png');
  const webpPath = path.join(outDir, 'speaking.webp');
  const gifPath = path.join(outDir, 'speaking.gif');

  // Canonical still = mid-open mouth
  const stillSrc = framePaths[2] || framePaths[0];
  await copyPng(stillSrc, pngPath);
  await writeWebp(stillSrc, webpPath);

  const frames = [];
  for (const framePath of framePaths) {
    frames.push(await toRawRgba(framePath));
  }
  await writeGif(frames, 130, gifPath);

  return {
    webpKb: Math.round(fs.statSync(webpPath).size / 1024),
    gifKb: Math.round(fs.statSync(gifPath).size / 1024),
  };
}

async function main() {
  if (!fs.existsSync(assetsRoot)) {
    throw new Error(`Assets folder not found: ${assetsRoot}`);
  }

  for (const [pack, map] of Object.entries(packs)) {
    const outDir = path.join(root, 'media', 'characters', pack);
    fs.mkdirSync(outDir, { recursive: true });

    for (const state of ['idle', 'listening', 'working', 'approval', 'done']) {
      const src = path.join(assetsRoot, map[state]);
      if (!fs.existsSync(src)) {
        throw new Error(`Missing source: ${src}`);
      }
      const sizes = await buildBreathingState(src, outDir, state);
      console.log(`ok ${pack}/${state} webp=${sizes.webpKb}KB gif=${sizes.gifKb}KB`);
    }

    const speakingSrcs = map.speaking.map((name) => path.join(assetsRoot, name));
    for (const src of speakingSrcs) {
      if (!fs.existsSync(src)) {
        throw new Error(`Missing speaking frame: ${src}`);
      }
    }
    const speakingSizes = await buildSpeakingState(speakingSrcs, outDir);
    console.log(
      `ok ${pack}/speaking webp=${speakingSizes.webpKb}KB gif=${speakingSizes.gifKb}KB (mouth cycle)`,
    );
  }

  console.log('photoreal character packs ready');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
