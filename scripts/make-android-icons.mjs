// 生成 Android 应用图标套件（dsh-android）
// 用法：node scripts/make-android-icons.mjs（在 dsh-desktop 下运行，复用其 sharp）
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const androidRes = path.join(root, '..', 'dsh-android', 'android', 'app', 'src', 'main', 'res');

// 鲸鱼路径（与桌面图标同源）
const whaleSvg = readFileSync(path.join(root, 'assets', 'whale.svg'), 'utf8');
const whaleD = [...whaleSvg.matchAll(/d="([^"]+)"/g)].map((m) => m[1]).sort((a, b) => b.length - a.length)[0];

const BBOX = { x0: 0.53, y0: 7.0, x1: 49.37, y1: 48.85 };
const cx = (BBOX.x0 + BBOX.x1) / 2;
const cy = (BBOX.y0 + BBOX.y1) / 2;

function whaleG(svgW, scale, tx, ty) {
  // 在 50 单位坐标系里定位鲸鱼
  return `<g transform="scale(${svgW / 50}) translate(${tx} ${ty}) scale(${scale})"><path d="${whaleD}" fill="#ffffff"/></g>`;
}

function svgIcon(kind, size) {
  const PAD = 0.19;
  const scale = (50 * (1 - 2 * PAD)) / Math.max(BBOX.x1 - BBOX.x0, BBOX.y1 - BBOX.y0);
  const tx = 25 - cx * scale;
  const ty = 25 - cy * scale;
  if (kind === 'fg') {
    // 自适应前景：白色鲸鱼居中，约占画布 42%
    const s2 = (50 * 0.42) / Math.max(BBOX.x1 - BBOX.x0, BBOX.y1 - BBOX.y0);
    const tx2 = 25 - cx * s2;
    const ty2 = 25 - cy * s2;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 50 50">${whaleG(50, s2, tx2, ty2)}</svg>`;
  }
  if (kind === 'round') {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 50 50">
      <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5d7cfa"/><stop offset="1" stop-color="#3e57d8"/></linearGradient></defs>
      <circle cx="25" cy="25" r="25" fill="url(#g)"/>
      ${whaleG(50, scale, tx, ty)}
    </svg>`;
  }
  // 方形（带圆角，占满）
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 50 50">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5d7cfa"/><stop offset="1" stop-color="#3e57d8"/></linearGradient></defs>
    <rect x="0.98" y="0.98" width="48.04" height="48.04" rx="11.5" fill="url(#g)"/>
    ${whaleG(50, scale, tx, ty)}
  </svg>`;
}

async function png(svg, size) {
  return sharp(Buffer.from(svg), { density: 600 }).resize(size, size).png().toBuffer();
}

// ---- 1. 传统图标 + 圆形图标 ----
const dpi = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
for (const [name, size] of Object.entries(dpi)) {
  const dir = path.join(androidRes, `mipmap-${name}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'ic_launcher.png'), await png(svgIcon('square', size), size));
  writeFileSync(path.join(dir, 'ic_launcher_round.png'), await png(svgIcon('round', size), size));
  console.log(`ic_launcher ${name}: ${size}px`);
}

// ---- 2. 自适应前景（108dp 按 dpi 换算）----
const fgDpi = { mdpi: 108, hdpi: 162, xhdpi: 216, xxhdpi: 324, xxxhdpi: 432 };
for (const [name, size] of Object.entries(fgDpi)) {
  const dir = path.join(androidRes, `mipmap-${name}`);
  writeFileSync(path.join(dir, 'ic_launcher_foreground.png'), await png(svgIcon('fg', size), size));
  console.log(`ic_launcher_foreground ${name}: ${size}px`);
}

// ---- 3. 自适应背景色 ----
writeFileSync(
  path.join(androidRes, 'values', 'ic_launcher_background.xml'),
  `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#3E57D8</color>\n</resources>\n`
);

// ---- 4. 启动屏：深色底 + 居中鲸鱼（按现有文件尺寸）----
const splashSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 50 50">
  <rect width="50" height="50" fill="#0d1117"/>
  ${whaleG(50, 0.5, 12.5, 7.18)}
</svg>`;
// 用与桌面 icon 相同的构图参数画鲸鱼：
const splashScale = (50 * 0.5) / Math.max(BBOX.x1 - BBOX.x0, BBOX.y1 - BBOX.y0);
const splashTx = 25 - cx * splashScale;
const splashTy = 25 - cy * splashScale;
const splashSvg2 = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 50 50">
  <rect width="50" height="50" fill="#0d1117"/>
  <g transform="scale(10.24) translate(${splashTx.toFixed(4)} ${splashTy.toFixed(4)}) scale(${splashScale.toFixed(4)})">
    <path d="${whaleD}" fill="#5d7cfa"/>
  </g>
</svg>`;

const { globSync } = await import('node:fs');
const splashFiles = [];
for (const entry of ['drawable', 'drawable-land-hdpi', 'drawable-land-mdpi', 'drawable-land-xhdpi', 'drawable-land-xxhdpi', 'drawable-land-xxxhdpi', 'drawable-port-hdpi', 'drawable-port-mdpi', 'drawable-port-xhdpi', 'drawable-port-xxhdpi', 'drawable-port-xxxhdpi']) {
  const f = path.join(androidRes, entry, 'splash.png');
  splashFiles.push(f);
}
for (const f of splashFiles) {
  let w = 2732, h = 2732;
  try {
    const meta = await sharp(f).metadata();
    if (meta.width) { w = meta.width; h = meta.height; }
  } catch {}
  const buf = await sharp(Buffer.from(splashSvg2), { density: 600 }).resize(w, h).png().toBuffer();
  writeFileSync(f, buf);
  console.log(`splash: ${path.relative(androidRes, f)} ${w}x${h}`);
}

console.log('Android 图标套件生成完成');
