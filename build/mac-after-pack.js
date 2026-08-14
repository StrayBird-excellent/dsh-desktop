// macOS 打包后处理钩子（electron-builder afterPack）。
//
// 背景：本项目在 Windows 上做跨平台打包，而 npm 在 Windows 上只会安装
// win32 变体的原生可选依赖。这里把预先下载好的 darwin 原生模块注入
// .app 内的 node_modules，并放入 macOS 版 Node 运行时（dsh web 子进程用）。
//
// 注入清单（按架构）：
//   node-runtime/darwin-<arch>/node          -> Contents/Resources/node/node
//   node-runtime/darwin-<arch>/LICENSE       -> Contents/Resources/node/LICENSE
//   mac-native/node_modules/@koromix/koffi-darwin-<arch>
//   mac-native/node_modules/node-addon-require-builtin-darwin-<arch>
//   mac-native/node_modules/@vscode/ripgrep-darwin-<arch>
//   mac-native/node_modules/@img/sharp-darwin-<arch>（dsh-attachment-local 运行时图像处理）
//   mac-native/node_modules/@img/sharp-libvips-darwin-<arch>（sharp 的 libvips 动态库）
'use strict';

const fs = require('node:fs');
const path = require('node:path');

// electron-builder Arch 枚举：ia32=0, x64=1, armv7l=2, arm64=3, universal=4
const ARCH_NAMES = { 1: 'x64', 3: 'arm64' };

function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirRecursive(s, d);
    else fs.copyFileSync(s, d);
  }
}

function chmod755(file) {
  try {
    fs.chmodSync(file, 0o755);
  } catch {
    // Windows 上无法设置 POSIX 执行位；真机首次启动时 main.js 会补 chmod
  }
}

module.exports = async function (context) {
  if (context.electronPlatformName !== 'darwin') return;

  const arch = ARCH_NAMES[context.arch];
  if (!arch) {
    console.log(`[mac-after-pack] 跳过：不支持的 arch 枚举值 ${context.arch}`);
    return;
  }

  const appBundle = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  if (!fs.existsSync(appBundle)) {
    throw new Error(`[mac-after-pack] 未找到应用包：${appBundle}`);
  }

  const projectDir = __dirname;
  const appNodeModules = path.join(appBundle, 'Contents', 'Resources', 'app', 'node_modules');
  const resourcesNode = path.join(appBundle, 'Contents', 'Resources', 'node');

  // 1) macOS Node 运行时 + LICENSE
  const nodeSrc = path.join(projectDir, '..', 'node-runtime', `darwin-${arch}`, 'node');
  const licenseSrc = path.join(projectDir, '..', 'node-runtime', `darwin-${arch}`, 'LICENSE');
  fs.mkdirSync(resourcesNode, { recursive: true });
  fs.copyFileSync(nodeSrc, path.join(resourcesNode, 'node'));
  fs.copyFileSync(licenseSrc, path.join(resourcesNode, 'LICENSE'));
  chmod755(path.join(resourcesNode, 'node'));
  console.log(`[mac-after-pack] 已注入 Node 运行时 (darwin-${arch})`);

  // 2) darwin 原生模块
  const nativeRoot = path.join(projectDir, '..', 'mac-native', 'node_modules');
  const packages = [
    path.join('@koromix', `koffi-darwin-${arch}`),
    `node-addon-require-builtin-darwin-${arch}`,
    path.join('@vscode', `ripgrep-darwin-${arch}`),
    path.join('@img', `sharp-darwin-${arch}`),
    path.join('@img', `sharp-libvips-darwin-${arch}`),
  ];
  for (const pkg of packages) {
    const src = path.join(nativeRoot, pkg);
    const dest = path.join(appNodeModules, pkg);
    if (!fs.existsSync(src)) throw new Error(`[mac-after-pack] 缺少 ${src}`);
    copyDirRecursive(src, dest);
    const rg = path.join(dest, 'bin', 'rg');
    if (fs.existsSync(rg)) chmod755(rg);
    console.log(`[mac-after-pack] 已注入 ${pkg}`);
  }
};
