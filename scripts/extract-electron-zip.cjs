// 解压 Electron darwin 发行包（供 Windows 上交叉构建 macOS 用）。
// 用法：node scripts/extract-electron-zip.cjs <zip> <outDir>
//
// Windows 非管理员无法创建符号链接，而 Electron darwin zip 内含 14 个
// 框架符号链接（Versions/Current 等）。本脚本把链接目标拷贝为真实
// 文件/目录 —— macOS 加载 framework 并不要求这些必须是符号链接，
// 真实副本同样可用（体积略增，换来可构建）。
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const unzipper = require('unzipper');

const [zipFile, outDir] = process.argv.slice(2);
if (!zipFile || !outDir) {
  console.error('用法: node scripts/extract-electron-zip.cjs <zip> <outDir>');
  process.exit(2);
}

function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirRecursive(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}

async function main() {
  const dir = await unzipper.Open.file(zipFile);
  const root = path.resolve(outDir);
  const symlinks = [];

  // 第一遍：普通文件与目录
  for (const entry of dir.files) {
    const destPath = path.join(root, entry.path);
    const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
    if ((mode & 0o170000) === 0o120000) {
      symlinks.push(entry);
      continue;
    }
    if (entry.type === 'Directory') {
      fs.mkdirSync(destPath, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    await new Promise((resolve, reject) => {
      entry.stream()
        .pipe(fs.createWriteStream(destPath))
        .on('finish', resolve)
        .on('error', reject);
    });
  }

  // 第二遍：符号链接 → 真实副本。
  // 链接目标本身可能又是另一个待处理的链接（如 Electron Framework →
  // Versions/Current/...，而 Versions/Current 本身也是链接），
  // 因此反复扫描直到全部落地或卡死。
  let pending = [];
  for (const entry of symlinks) {
    const destPath = path.join(root, entry.path);
    const target = (await entry.buffer()).toString();
    if (path.isAbsolute(target)) throw new Error(`绝对链接目标被拦截: ${entry.path} -> ${target}`);
    const resolved = path.resolve(path.dirname(destPath), target);
    if (!resolved.startsWith(root + path.sep) && resolved !== root) {
      throw new Error(`链接目标逃逸解压目录: ${entry.path} -> ${target}`);
    }
    pending.push({ entry, destPath, target, resolved });
  }

  for (let round = 1; pending.length > 0 && round <= symlinks.length + 1; round += 1) {
    const next = [];
    for (const item of pending) {
      if (!fs.existsSync(item.resolved)) {
        next.push(item);
        continue;
      }
      const { destPath, target, resolved } = item;
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      const st = fs.lstatSync(resolved);
      if (st.isDirectory()) copyDirRecursive(resolved, destPath);
      else fs.copyFileSync(resolved, destPath);
      console.log(`[symlink→copy] ${item.entry.path} -> ${target} (${st.isDirectory() ? 'dir' : 'file'})`);
    }
    if (next.length === pending.length) {
      throw new Error(`链接目标缺失且无法继续: ${next.map((n) => `${n.entry.path} -> ${n.target}`).join('; ')}`);
    }
    pending = next;
  }
  if (pending.length > 0) {
    throw new Error(`仍有链接未落地: ${pending.map((n) => n.entry.path).join('; ')}`);
  }

  console.log(`完成: ${outDir}（${symlinks.length} 个链接已转副本）`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
