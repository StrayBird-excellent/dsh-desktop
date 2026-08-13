// 冒烟测试：复刻 main.js 的启动方式，验证「Electron 二进制以 Node 模式运行 dsh web」
// 用法：node scripts/smoke-dsh.mjs <port>
// 说明：这与打包后应用内部的 spawn 逻辑一致（ELECTRON_RUN_AS_NODE=1 + dsh bin.js）。

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import http from 'node:http';

const require = createRequire(import.meta.url);
const bin = require.resolve('@deepseek-ai/dsh/lib/bin.js');
const port = Number(process.argv[2] || 43921);
const host = '127.0.0.1';

console.log(`spawn: ${process.execPath} ${bin} web --host ${host} --port ${port}`);

const child = spawn(
  process.execPath,
  ['--expose-internals', bin, 'web', '--host', host, '--port', String(port)],
  {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'inherit', 'inherit'],
    windowsHide: true,
  }
);

child.on('exit', (code, signal) => {
  console.log(`dsh child exited code=${code} signal=${signal}`);
  process.exit(ok ? 0 : (code ?? 1));
});

let ok = false;

function check() {
  const req = http.get({ host, port, path: '/', timeout: 3000 }, (res) => {
    console.log(`HTTP ${res.statusCode} —— 服务器已就绪`);
    res.resume();
    setTimeout(() => {
      console.log('冒烟测试通过，清理子进程…');
      ok = true;
      child.kill();
    }, 1000);
  });
  req.on('error', () => setTimeout(check, 500));
  req.setTimeout(3000, () => {
    req.destroy();
    setTimeout(check, 500);
  });
}

setTimeout(check, 2000);

// 兜底：90 秒仍未就绪则失败退出
setTimeout(() => {
  console.error('冒烟测试超时');
  child.kill();
  process.exit(2);
}, 90_000);
