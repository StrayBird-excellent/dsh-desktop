// DeepSeek Harness 桌面版 —— Electron 主进程
//
// 职责：以内嵌的 @deepseek-ai/dsh 启动 `dsh web` 服务器子进程（绑定
// 127.0.0.1 + 自动挑选的空闲端口），就绪后把浏览器界面加载进应用窗口。
// 桌面版使用独立配置目录（%APPDATA%\dsh-desktop\home），与网页版完全隔离；
// 关闭窗口最小化到系统托盘后台运行，托盘菜单可恢复或彻底退出。

'use strict';

const { app, BrowserWindow, dialog, Menu, shell, Tray, nativeImage } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

const HOST = '127.0.0.1';
const SERVER_READY_TIMEOUT_MS = 120_000; // dsh 首次启动需要加载插件树，给足时间
const MAX_BOOT_ATTEMPTS = 3;

// 固定应用数据目录（日志等）：
//   Windows: %APPDATA%\dsh-desktop；macOS: ~/Library/Application Support/dsh-desktop。
// DSH_DESKTOP_USERDATA 可覆盖（测试/多实例用，覆盖后单实例锁也随之隔离）。
app.setPath('userData', process.env.DSH_DESKTOP_USERDATA || path.join(app.getPath('appData'), 'dsh-desktop'));

let serverProc = null;
let mainWindow = null;
let quitting = false;
let bootAttempt = 0;
let currentPort = null;
let logStream = null;

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 探测一个空闲端口（随后立刻释放，交给 dsh 绑定；有极小概率被抢，靠重试兜底）。 */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', reject);
    probe.listen(0, HOST, () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

/** 轮询 HTTP 直到服务器响应，或超时。 */
function waitForServer(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      if (Date.now() > deadline) {
        reject(new Error(`dsh 服务器启动超时（${Math.round(timeoutMs / 1000)} 秒未响应）`));
        return;
      }
      const req = http.get({ host: HOST, port, path: '/', timeout: 2000 }, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => setTimeout(attempt, 400));
      req.setTimeout(2000, () => {
        req.destroy();
        setTimeout(attempt, 400);
      });
    };
    attempt();
  });
}

/** 定位打包后（或开发模式）的 dsh bin.js。 */
function dshBinPath() {
  try {
    return require.resolve('@deepseek-ai/dsh/lib/bin.js');
  } catch {
    return path.join(__dirname, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  }
}

/**
 * dsh 服务所用的 Node 运行时：打包后优先用应用自带的 node（resources/node，
 * Windows 下为 node.exe，macOS/Linux 下为 node），这样 dsh 及其插件（如 koffi
 * 目录选择器）跑在真正的 Node 上，与网页版环境完全一致 —— Electron 的 node
 * 模式跑原生 FFI 会崩溃。开发模式退回系统 node。
 */
function nodeRuntimePath() {
  if (app.isPackaged) {
    const name = process.platform === 'win32' ? 'node.exe' : 'node';
    const bundled = path.join(process.resourcesPath, 'node', name);
    if (fs.existsSync(bundled)) return bundled;
  }
  return process.env.DSH_DESKTOP_NODE || 'node';
}

/**
 * macOS 打包修复：跨平台（Windows/Linux）构建出的 .app 里，后注入的文件
 * （node 运行时、ripgrep 二进制）在 zip/dmg 中可能丢失可执行位。首次启动时
 * 就地补一次 chmod —— 运行在真机上时文件系统权限真实生效，无需重新打包。
 */
function fixupMacExecBits() {
  if (process.platform !== 'darwin') return;
  try {
    const nodeExe = nodeRuntimePath();
    if (path.isAbsolute(nodeExe)) fs.chmodSync(nodeExe, 0o755);
    const rg = path.join(
      __dirname, 'node_modules', '@vscode',
      `ripgrep-darwin-${process.arch}`, 'bin', 'rg'
    );
    if (fs.existsSync(rg)) fs.chmodSync(rg, 0o755);
  } catch (err) {
    logLine(`chmod 修复失败（可忽略）：${err.message}`);
  }
}

function openLogFile() {
  try {
    const dir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    logStream = fs.createWriteStream(path.join(dir, 'dsh-server.log'), { flags: 'a' });
  } catch {
    logStream = null;
  }
}

function logLine(line) {
  const text = `[${new Date().toISOString()}] ${line}\n`;
  if (logStream) logStream.write(text);
  if (!app.isPackaged) console.log(text.trimEnd());
}

function logFilePath() {
  return path.join(app.getPath('userData'), 'logs', 'dsh-server.log');
}

// ---------------------------------------------------------------------------
// dsh web 子进程
// ---------------------------------------------------------------------------

/**
 * 子进程环境：桌面版使用完全隔离的 dsh 配置目录（默认
 * %APPDATA%\dsh-desktop\home），与网页版的 ~\.dsh 互不相通 —— API Key、
 * 会话、设置各自独立，两个版本同时运行也不会互相写坏会话日志。
 * DSH_DESKTOP_HOME 是调试用的显式覆盖项。
 */
function resolveDshEnv() {
  const env = { ...process.env };
  env.DSH_HOME = process.env.DSH_DESKTOP_HOME || path.join(app.getPath('userData'), 'home');
  return env;
}

/** 终止 dsh 进程树（Windows 上连子孙进程一起清理）。 */
function stopServerTree() {
  if (!serverProc || serverProc.pid == null) return;
  const pid = serverProc.pid;
  serverProc = null;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } else {
      spawnSync('kill', ['-TERM', String(pid)], { stdio: 'ignore' });
    }
  } catch {
    // 进程可能已退出
  }
}

/**
 * 启动一次 dsh web 并等待就绪。启动失败（端口被抢、依赖异常等）会重试
 * MAX_BOOT_ATTEMPTS 次，每次换一个端口。
 */
async function startServerWithRetry() {
  for (let attempt = 1; attempt <= MAX_BOOT_ATTEMPTS; attempt += 1) {
    bootAttempt = attempt;
    const port = process.env.DSH_DESKTOP_PORT
      ? Number(process.env.DSH_DESKTOP_PORT)
      : await findFreePort();
    const bin = dshBinPath();
    const nodeExe = nodeRuntimePath();
    logLine(`第 ${attempt} 次尝试：${nodeExe} ${bin} web --host ${HOST} --port ${port}`);

    if (serverProc) stopServerTree();
    // --expose-internals：cordis 的 HMR 服务需要 Node 内部 loader。
    // 原生 node 下也可由 node-addon-require-builtin 兜底，显式传 flag 最稳。
    serverProc = spawn(
      nodeExe,
      ['--expose-internals', bin, 'web', '--host', HOST, '--port', String(port)],
      { env: resolveDshEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
    );

    serverProc.stdout.on('data', (chunk) => logStream && logStream.write(chunk));
    serverProc.stderr.on('data', (chunk) => logStream && logStream.write(chunk));

    const proc = serverProc;
    proc.on('exit', (code, signal) => {
      if (serverProc === proc) serverProc = null;
      logLine(`dsh web 进程退出 code=${code} signal=${signal}`);
      if (!quitting) {
        const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
        if (win) showServerCrashedDialog(code, signal).catch(() => {});
      }
    });

    try {
      await waitForServer(port, SERVER_READY_TIMEOUT_MS);
      currentPort = port;
      logLine(`dsh web 已就绪：http://${HOST}:${port}/`);
      return port;
    } catch (err) {
      logLine(`启动失败：${err.message}`);
      if (serverProc) stopServerTree();
      if (attempt === MAX_BOOT_ATTEMPTS) throw err;
    }
  }
  throw new Error('dsh 服务器启动失败');
}

// ---------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------

function isTrusted(url) {
  return currentPort != null && url.startsWith(`http://${HOST}:${currentPort}/`);
}

function createWindow() {
  const iconPath = path.join(__dirname, 'assets', 'icon.ico');
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 600,
    title: 'DeepSeek Harness',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    backgroundColor: '#0d1117',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // macOS 必须有应用菜单，否则 Cmd+C/V/Q 等快捷键全部失效；
  // Windows/Linux 则去掉菜单栏，界面更干净。
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      { role: 'windowMenu' },
    ]));
  } else {
    Menu.setApplicationMenu(null);
  }
  win.once('ready-to-show', () => win.show());

  // 关闭窗口 = 隐藏到系统托盘后台运行；真正退出走托盘菜单的「退出」。
  win.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      win.hide();
    }
  });

  // 外部链接交给系统默认浏览器；dsh 自身的地址留在窗口内。
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isTrusted(url)) return { action: 'allow' };
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (isTrusted(url)) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });

  return win;
}

// ---------------------------------------------------------------------------
// 系统托盘（后台运行）
// ---------------------------------------------------------------------------

let tray = null;

/** 显示（必要时重建）主窗口。 */
function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createWindow();
    mainWindow.on('closed', () => {
      mainWindow = null;
    });
    mainWindow.loadFile(path.join(__dirname, 'assets', 'loading.html')).then(() =>
      reloadAppUrl()
    );
  } else {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
}

function createTray() {
  try {
    let image = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png'));
    if (process.platform === 'darwin') {
      // macOS 菜单栏图标须小尺寸；用模板图适配深/浅色菜单栏。
      image = image.resize({ width: 18, height: 18 });
      image.setTemplateImage(true);
    }
    tray = new Tray(image);
    tray.setToolTip('DeepSeek Harness —— 正在后台运行');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开 DeepSeek Harness', click: () => showMainWindow() },
      { type: 'separator' },
      { label: '退出', click: () => { quitting = true; app.quit(); } },
    ]));
    tray.on('double-click', () => showMainWindow());
  } catch (err) {
    logLine(`托盘创建失败：${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// 对话框
// ---------------------------------------------------------------------------

async function showServerCrashedDialog(code, signal) {
  if (process.env.DSH_DESKTOP_NO_DIALOG) {
    logLine('DSH_DESKTOP_NO_DIALOG=1，静默退出');
    app.quit();
    return;
  }
  const { response } = await dialog.showMessageBox({
    type: 'error',
    title: 'DeepSeek Harness',
    message: 'dsh 服务意外退出',
    detail:
      `后端服务进程已退出（code=${code ?? 'null'}，signal=${signal ?? 'null'}）。\n` +
      `日志文件：${logFilePath()}`,
    buttons: ['重新启动', '退出应用'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) {
    reloadAppUrl();
  } else {
    app.quit();
  }
}

async function showBootFailedDialog(err) {
  if (process.env.DSH_DESKTOP_NO_DIALOG) {
    logLine(`DSH_DESKTOP_NO_DIALOG=1，静默退出：${err.message}`);
    app.quit();
    return;
  }
  const { response } = await dialog.showMessageBox({
    type: 'error',
    title: 'DeepSeek Harness',
    message: 'dsh 服务启动失败',
    detail: `${err.message}\n日志文件：${logFilePath()}`,
    buttons: ['重试', '退出应用'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) reloadAppUrl();
  else app.quit();
}

/** 启动服务器并把窗口导航到界面；失败时弹窗。 */
async function reloadAppUrl() {
  try {
    const port = await startServerWithRetry();
    const win = mainWindow;
    if (!win || win.isDestroyed()) return;
    await win.loadURL(`http://${HOST}:${port}/`);
  } catch (err) {
    logLine(`引导失败：${err.message}`);
    if (mainWindow && !mainWindow.isDestroyed()) showBootFailedDialog(err).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// 应用生命周期
// ---------------------------------------------------------------------------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showMainWindow();
  });

  app.whenReady().then(async () => {
    openLogFile();
    logLine('==== DeepSeek Harness 桌面版启动 ====');
    fixupMacExecBits();
    mainWindow = createWindow();
    mainWindow.on('closed', () => {
      mainWindow = null;
    });
    createTray();
    await mainWindow.loadFile(path.join(__dirname, 'assets', 'loading.html'));
    await reloadAppUrl();
  });

  app.on('before-quit', () => {
    quitting = true;
    stopServerTree();
  });

  // 关闭窗口只是隐藏到托盘，应用保持在后台运行，不退出。
  app.on('window-all-closed', () => {
    /* 保持后台运行 */
  });

  app.on('activate', () => {
    showMainWindow();
  });
}
