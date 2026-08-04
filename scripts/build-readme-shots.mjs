import sharp from "sharp";
import fs from "fs";
import path from "path";

const dir = "docs/screenshots";
const states = ["idle", "listening", "speaking", "working", "approval", "done"];
const labels = ["IDLE", "LISTEN", "SPEAK", "WORK", "ASK", "DONE"];
const W = 220;
const H = 120;
const PAD = 16;
const GAP = 10;
const LABEL_H = 28;

async function collage(pack, outName, title) {
  const imgs = [];
  for (const st of states) {
    const p = path.join(dir, `${pack}-${st}.jpg`);
    imgs.push(
      await sharp(p)
        .resize(W, H, { fit: "cover", position: "centre" })
        .jpeg({ quality: 88 })
        .toBuffer()
    );
  }
  const cols = 3;
  const rows = 2;
  const width = PAD * 2 + cols * W + (cols - 1) * GAP;
  const height = 56 + PAD + rows * (H + LABEL_H + GAP);
  const svg = Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="#0f1115"/>
    <text x="${PAD}" y="34" fill="#f2f4f8" font-size="22" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-weight="600">${title}</text>
    <text x="${PAD}" y="52" fill="#8b93a7" font-size="12" font-family="Segoe UI, Microsoft YaHei, sans-serif">Cursor GF Live · 六态预览</text>
  </svg>`);
  const composites = [{ input: svg, top: 0, left: 0 }];
  for (let i = 0; i < imgs.length; i++) {
    const c = i % cols;
    const r = Math.floor(i / cols);
    const x = PAD + c * (W + GAP);
    const y = 56 + PAD + r * (H + LABEL_H + GAP);
    composites.push({ input: imgs[i], top: y, left: x });
    const lab = Buffer.from(`<svg width="${W}" height="${LABEL_H}" xmlns="http://www.w3.org/2000/svg">
      <text x="0" y="18" fill="#c9d1e0" font-size="13" font-family="Consolas, Segoe UI, sans-serif">${labels[i]} · ${states[i]}</text>
    </svg>`);
    composites.push({ input: lab, top: y + H + 2, left: x });
  }
  await sharp({
    create: { width, height, channels: 3, background: "#0f1115" },
  })
    .composite(composites)
    .png()
    .toFile(path.join(dir, outName));
}

await collage("dark-cyber", "pack-dark-cyber.png", "深色赛博 Dark Cyber");
await collage("warm-white", "pack-warm-white.png", "暖白女友 Warm White");

const heroParts = [];
for (const [pack, title] of [
  ["dark-cyber", "Dark Cyber"],
  ["warm-white", "Warm White"],
]) {
  for (const st of ["idle", "speaking"]) {
    heroParts.push({
      buf: await sharp(path.join(dir, `${pack}-${st}.jpg`))
        .resize(360, 196, { fit: "cover" })
        .jpeg({ quality: 90 })
        .toBuffer(),
      title: `${title} / ${st}`,
    });
  }
}

const hw = 360;
const hh = 196;
const pad = 20;
const gap = 12;
const hW = pad * 2 + 2 * hw + gap;
const hH = 70 + 2 * (hh + 28 + gap);
const heroSvg = Buffer.from(`<svg width="${hW}" height="${hH}" xmlns="http://www.w3.org/2000/svg">
  <rect width="100%" height="100%" fill="#0b0d12"/>
  <text x="${pad}" y="36" fill="#fff" font-size="24" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-weight="700">Cursor GF Live</text>
  <text x="${pad}" y="56" fill="#9aa3b5" font-size="13" font-family="Segoe UI, Microsoft YaHei, sans-serif">角色随 Agent Hooks 切换状态 · 侧栏常驻陪伴</text>
</svg>`);
const comps = [{ input: heroSvg, top: 0, left: 0 }];
heroParts.forEach((p, i) => {
  const c = i % 2;
  const r = Math.floor(i / 2);
  const x = pad + c * (hw + gap);
  const y = 70 + r * (hh + 28 + gap);
  comps.push({ input: p.buf, top: y, left: x });
  const lab = Buffer.from(
    `<svg width="${hw}" height="24" xmlns="http://www.w3.org/2000/svg"><text x="0" y="16" fill="#d0d7e4" font-size="13" font-family="Segoe UI, sans-serif">${p.title}</text></svg>`
  );
  comps.push({ input: lab, top: y + hh + 4, left: x });
});
await sharp({
  create: { width: hW, height: hH, channels: 3, background: "#0b0d12" },
})
  .composite(comps)
  .png()
  .toFile(path.join(dir, "hero-preview.png"));

console.log(
  "done",
  fs.readdirSync(dir).filter((f) => f.endsWith(".png") || f.endsWith(".jpg"))
);
