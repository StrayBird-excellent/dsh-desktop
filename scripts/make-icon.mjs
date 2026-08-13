// 生成应用图标：DeepSeek 鲸鱼（小鲨鱼）logo
//
// 输入：assets/whale.svg（来自 @deepseek-ai/dsh-web-frontend 的 favicon，MIT）
// 输出：
//   build/icon.ico   —— 多尺寸（16~256）ICO，供 electron-builder / Windows 使用
//   build/icon.png   —— 512×512 PNG
//   build/icon-1024.png —— 1024×1024 PNG，供 macOS icns 自动转换（≥512 即可，1024 更清晰）
//   assets/icon.ico  —— 运行时窗口图标（随应用打包）
//   assets/icon.png  —— 加载页展示用
//
// ICO 容器按规范手工打包（PNG 压缩条目，Vista+ 支持），不依赖额外库。

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assetsDir = path.join(project, 'assets');
const buildDir = path.join(project, 'build');

// ---- 1. 从 favicon 提取鲸鱼图形路径（取最长的 d 属性，避开 id="path" 的干扰）----
const whaleSvg = readFileSync(path.join(assetsDir, 'whale.svg'), 'utf8');
const dCandidates = [...whaleSvg.matchAll(/d="([^"]+)"/g)].map((m) => m[1]);
const whaleD = dCandidates.sort((a, b) => b.length - a.length)[0];
if (!whaleD) throw new Error('whale.svg 中未找到 path 的 d 属性');

// ---- 2. 构图：品牌蓝渐变圆角底 + 白色鲸鱼，居中缩放留白 ----
// 原图 viewBox 0 0 50 50，图形近似包围盒（从路径数据量得）。
const BBOX = { x0: 0.53, y0: 7.0, x1: 49.37, y1: 48.85 };
const cx = (BBOX.x0 + BBOX.x1) / 2;
const cy = (BBOX.y0 + BBOX.y1) / 2;
const PAD = 0.19; // 四周留白比例（相对 50 画布）
const scale = (50 * (1 - 2 * PAD)) / Math.max(BBOX.x1 - BBOX.x0, BBOX.y1 - BBOX.y0);
const tx = 25 - cx * scale;
const ty = 25 - cy * scale;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#5d7cfa"/>
      <stop offset="1" stop-color="#3e57d8"/>
    </linearGradient>
  </defs>
  <rect x="10" y="10" width="492" height="492" rx="118" fill="url(#bg)"/>
  <g transform="scale(10.24) translate(${tx.toFixed(4)} ${ty.toFixed(4)}) scale(${scale.toFixed(4)})">
    <path d="${whaleD}" fill="#ffffff"/>
  </g>
</svg>`;

// ---- 3. 栅格化 PNG ----
const svgBuffer = Buffer.from(svg);
async function png(size) {
  return sharp(svgBuffer, { density: 600 }).resize(size, size).png().toBuffer();
}

mkdirSync(buildDir, { recursive: true });
const icoSizes = [256, 128, 64, 48, 32, 24, 16];
const icoPngs = [];
for (const size of icoSizes) icoPngs.push(await png(size));
const icon512 = await png(512);

// ---- 4. 手工打包 ICO ----
function packIco(entries) {
  // entries: [{size, png}]，size 均为 0~256
  const count = entries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(count, 4);
  const dirSize = 16 * count;
  let offset = 6 + dirSize;
  const dir = Buffer.alloc(dirSize);
  const blobs = [];
  entries.forEach(({ size, png }, i) => {
    const e = dir.subarray(i * 16, i * 16 + 16);
    e.writeUInt8(size >= 256 ? 0 : size, 0); // 0 表示 256
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2); // 调色板颜色数：PNG 条目为 0
    e.writeUInt8(0, 3); // reserved
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bit depth
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    blobs.push(png);
    offset += png.length;
  });
  return Buffer.concat([header, dir, ...blobs]);
}

const ico = packIco(icoPngs.map((png, i) => ({ size: icoSizes[i], png })));

// ---- 5. 写文件 ----
writeFileSync(path.join(buildDir, 'icon.ico'), ico);
writeFileSync(path.join(buildDir, 'icon.png'), icon512);
writeFileSync(path.join(buildDir, 'icon-1024.png'), await png(1024));
writeFileSync(path.join(assetsDir, 'icon.ico'), ico);
writeFileSync(path.join(assetsDir, 'icon.png'), icon512);

console.log(`icon.ico: ${ico.length} bytes (${icoSizes.join('/')})`);
console.log(`icon.png: ${icon512.length} bytes (512x512)`);
console.log(`icon-1024.png: 1024x1024`);
console.log('图标生成完成：build/icon.ico, build/icon.png, build/icon-1024.png, assets/icon.ico, assets/icon.png');
