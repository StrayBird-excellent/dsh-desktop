// 断点续传下载工具（供跨平台构建物料下载使用）。
// 用法：node scripts/download.mjs <url> <output>
// Node 的 https 栈与 npm 一致（不受系统 schannel 影响），大文件中断后
// 依据已写入字节数用 Range 头续传。
import fs from 'node:fs';
import https from 'node:https';

const [url, outPath] = process.argv.slice(2);
if (!url || !outPath) {
  console.error('用法: node scripts/download.mjs <url> <output>');
  process.exit(2);
}

const MAX_ATTEMPTS = 8;
const RETRY_DELAY_MS = 3000;

function download(attempt, urlToFetch = url, redirectsLeft = 8) {
  return new Promise((resolve, reject) => {
    let done = 0;
    try {
      done = fs.statSync(outPath).size;
    } catch {
      done = 0;
    }
    const headers = { 'User-Agent': 'dsh-desktop-build' };
    if (done > 0) headers.Range = `bytes=${done}-`;

    const req = https.get(urlToFetch, { headers }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) return reject(new Error('重定向次数过多'));
        return resolve(download(attempt, new URL(res.headers.location, urlToFetch).toString(), redirectsLeft - 1));
      }
      const canResume = res.statusCode === 206;
      if (res.statusCode !== 200 && !canResume) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const ws = fs.createWriteStream(outPath, canResume ? { flags: 'a' } : { flags: 'w' });
      res.pipe(ws);
      ws.on('finish', () => ws.close(() => resolve()));
      ws.on('error', reject);
      res.on('error', reject);
    });
    req.on('error', (err) => {
      if (attempt > 0) {
        console.error(`[下载中断] ${err.message}，${RETRY_DELAY_MS / 1000}s 后重试（剩余 ${attempt} 次）…`);
        setTimeout(() => download(attempt - 1).then(resolve, reject), RETRY_DELAY_MS);
      } else {
        reject(err);
      }
    });
  });
}

try {
  await download(MAX_ATTEMPTS);
  console.log(`完成: ${outPath} (${fs.statSync(outPath).size} bytes)`);
} catch (err) {
  console.error(`下载失败: ${err.message}`);
  process.exit(1);
}
