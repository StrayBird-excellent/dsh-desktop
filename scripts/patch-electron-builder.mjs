// 解除 electron-builder 对“Windows 上构建 macOS 目标”的硬性拦截。
// 官方在 packager.js doBuild 里直接 throw；本机已用
// scripts/extract-electron-zip.mjs 预解压 Electron dist（符号链接→真实副本），
// 并配合 electronDist 配置绕过解压环节，因此放行是安全的。
//
// 用法：node scripts/patch-electron-builder.mjs [--restore]
// npm install 重新安装 electron-builder 后需重跑本脚本。
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const project = path.resolve(__dirname, '..');
const packagerJs = path.join(project, 'node_modules', 'app-builder-lib', 'out', 'packager.js');
const restore = process.argv.includes('--restore');

const GATE = [
  '            if (platform === core_1.Platform.MAC && process.platform === core_1.Platform.WINDOWS.nodeName) {',
  '                throw new builder_util_1.InvalidConfigurationError("Build for macOS is supported only on macOS, please see https://electron.build/multi-platform-build");',
  '            }',
].join('\n');

const PATCHED = [
  '            // DSH-PATCH(begin): 允许在 Windows 上交叉构建 macOS（配合 electronDist 预解压）。',
  '            // 原生 electron-builder 在此硬性拦截；本机以 scripts/patch-electron-builder.mjs 放行。',
  '            if (false && platform === core_1.Platform.MAC && process.platform === core_1.Platform.WINDOWS.nodeName) {',
  '                throw new builder_util_1.InvalidConfigurationError("Build for macOS is supported only on macOS, please see https://electron.build/multi-platform-build");',
  '            }',
  '            // DSH-PATCH(end)',
].join('\n');

let src = fs.readFileSync(packagerJs, 'utf8');

if (restore) {
  if (!src.includes(PATCHED)) {
    console.log('未打补丁，无需恢复。');
    return;
  }
  src = src.replace(PATCHED, GATE);
  fs.writeFileSync(packagerJs, src);
  console.log('已恢复原始拦截逻辑。');
  return;
}

if (src.includes('DSH-PATCH(begin)')) {
  console.log('补丁已存在，跳过。');
  return;
}
if (!src.includes(GATE)) {
  throw new Error(`未找到目标代码片段，packager.js 可能已变更：${packagerJs}`);
}
src = src.replace(GATE, PATCHED);
fs.writeFileSync(packagerJs, src);
console.log('补丁已应用：允许 Windows 上构建 macOS 目标。');
