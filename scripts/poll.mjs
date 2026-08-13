// 轮询 HTTP 直到响应 200 或超时。用法：node scripts/poll.mjs <port> [timeoutSec]
import http from 'node:http';

const port = Number(process.argv[2]);
const timeoutSec = Number(process.argv[3] || 90);
const deadline = Date.now() + timeoutSec * 1000;

function attempt() {
  if (Date.now() > deadline) {
    console.error(`POLL FAIL: ${timeoutSec}s 内未就绪`);
    process.exit(1);
  }
  const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 3000 }, (res) => {
    console.log(`POLL OK: HTTP ${res.statusCode}`);
    res.resume();
    process.exit(0);
  });
  req.on('error', () => setTimeout(attempt, 500));
  req.setTimeout(3000, () => {
    req.destroy();
    setTimeout(attempt, 500);
  });
}
attempt();
