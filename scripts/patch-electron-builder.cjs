// 解除 electron-builder 对“Windows 上构建 macOS 目标”的硬性拦截。
// 官方在 packager.js doBuild 里直接 throw；本机已用
// scripts/extract-electron-zip.mjs 预解压 Electron dist（符号链接→真实副本），
// 并配合 electronDist 配置绕过解压环节，因此放行是安全的。
//
// 用法：node scripts/patch-electron-builder.cjs [--restore]
// npm install 重新安装 electron-builder 后需重跑本脚本。
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const project = path.resolve(__dirname, '..');
const packagerJs = path.join(project, 'node_modules', 'app-builder-lib', 'out', 'packager.js');
const collectorJs = path.join(project, 'node_modules', 'app-builder-lib', 'out', 'node-module-collector', 'nodeModulesCollector.js');
const restore = process.argv.includes('--restore');

const GATE = [
  '            if (platform === core_1.Platform.MAC && process.platform === core_1.Platform.WINDOWS.nodeName) {',
  '                throw new builder_util_1.InvalidConfigurationError("Build for macOS is supported only on macOS, please see https://electron.build/multi-platform-build");',
  '            }',
].join('\n');

const PATCHED = [
  '            // DSH-PATCH(begin): 允许在 Windows 上交叉构建 macOS（配合 electronDist 预解压）。',
  '            // 原生 electron-builder 在此硬性拦截；本机以 scripts/patch-electron-builder.cjs 放行。',
  '            if (false && platform === core_1.Platform.MAC && process.platform === core_1.Platform.WINDOWS.nodeName) {',
  '                throw new builder_util_1.InvalidConfigurationError("Build for macOS is supported only on macOS, please see https://electron.build/multi-platform-build");',
  '            }',
  '            // DSH-PATCH(end)',
].join('\n');

function main() {
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
}

// ---------------------------------------------------------------------------
// 补丁二：NodeModulesCollector 的宿主侧管道 stdio 规避（沙箱 EPERM）。
// 原实现 spawn powershell.exe 后用 child.stdout.pipe 收集输出 —— 宿主侧命名
// 管道在受限环境下被禁止。改为把 `| Out-File` 重定向编入 PowerShell 载荷
// （进程内重定向，不经宿主管道），宿主侧 stdio 全部 ignore。
// ---------------------------------------------------------------------------
const COLLECTOR_GATE = [
  '        const [spawnCommand, spawnArgs] = process.platform === "win32" ? ["powershell.exe", buildPowerShellEncodedArgs(command, args)] : [command, args];',
].join('\n');

const COLLECTOR_PATCHED = [
  '        // DSH-PATCH(begin): 受限沙箱禁止宿主侧命名管道（spawn 默认 pipe 会 EPERM）。',
  '        // 输出重定向编入 PowerShell 载荷内部（进程内 Out-File），宿主侧 stdio 全忽略。',
  '        const redirected = process.platform === "win32";',
  '        const [spawnCommand, spawnArgs] = redirected ? ["powershell.exe", buildPowerShellEncodedArgs(command, args, tempOutputFile)] : [command, args];',
].join('\n');

const COLLECTOR_SPAWN_GATE = [
  '            const child = childProcess.spawn(spawnCommand, spawnArgs, {',
  '                cwd,',
  '                // Package manager invocations do not need signing/publishing credentials.',
  '                env: { COREPACK_ENABLE_STRICT: "0", ...(0, builder_util_1.stripSensitiveEnvVars)(process.env) },',
  '            });',
].join('\n');

const COLLECTOR_SPAWN_PATCHED = [
  '            const child = childProcess.spawn(spawnCommand, spawnArgs, {',
  '                cwd,',
  '                stdio: redirected ? "ignore" : undefined,',
  '                // Package manager invocations do not need signing/publishing credentials.',
  '                env: { COREPACK_ENABLE_STRICT: "0", ...(0, builder_util_1.stripSensitiveEnvVars)(process.env) },',
  '            });',
  '            if (redirected) {',
  '                // 载荷内部已把 stdout 写入 tempOutputFile；结束本地写流以触发 finish。',
  '                outStream.end();',
  '            }',
].join('\n');

const COLLECTOR_PIPE_GATE = [
  '            // `pipe` ends `outStream` when stdout EOFs, which triggers its "finish" once flushed.',
  '            child.stdout.pipe(outStream);',
  '            child.stderr.on("data", chunk => {',
  '                stderr += chunk.toString();',
  '            });',
].join('\n');

const COLLECTOR_PIPE_PATCHED = [
  '            // `pipe` ends `outStream` when stdout EOFs, which triggers its "finish" once flushed.',
  '            if (!redirected) {',
  '                child.stdout.pipe(outStream);',
  '            }',
  '            if (child.stderr) {',
  '                child.stderr.on("data", chunk => {',
  '                    stderr += chunk.toString();',
  '                });',
  '            }',
].join('\n');

const ENCODED_GATE = [
  'function buildPowerShellEncodedArgs(command, args) {',
  '    const psQuote = (value) => `\'${value.replace(/\'/g, "\'\'")}\'`;',
  '    const invocation = ["&", psQuote(command), ...args.map(psQuote)].join(" ");',
  '    const script = `[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); ${invocation}; exit $LASTEXITCODE`;',
  '    const encoded = Buffer.from(script, "utf16le").toString("base64");',
  '    return ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded];',
  '}',
].join('\n');

const ENCODED_PATCHED = [
  'function buildPowerShellEncodedArgs(command, args, stdoutFile) {',
  '    const psQuote = (value) => `\'${value.replace(/\'/g, "\'\'")}\'`;',
  '    const invocation = ["&", psQuote(command), ...args.map(psQuote)].join(" ");',
  '    // DSH-PATCH: stdoutFile 提供时，用进程内 Out-File 重定向（UTF-8，带 BOM；',
  '    // 调用方读取后 trim() 会去掉 BOM，不影响 JSON.parse）。',
  '    const redirect = stdoutFile != null ? ` | Out-File -Encoding utf8 ${psQuote(stdoutFile)}` : "";',
  '    const script = `[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); ${invocation}${redirect}; exit $LASTEXITCODE`;',
  '    const encoded = Buffer.from(script, "utf16le").toString("base64");',
  '    return ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded];',
  '}',
].join('\n');

function applyCollectorPatches() {
  let src = fs.readFileSync(collectorJs, 'utf8');
  if (src.includes('DSH-PATCH(begin): 受限沙箱')) {
    console.log('collector 补丁已存在，跳过。');
    return;
  }
  const checks = [
    ['redirect 载荷', COLLECTOR_GATE],
    ['spawn 调用', COLLECTOR_SPAWN_GATE],
    ['stdout 管道', COLLECTOR_PIPE_GATE],
    ['buildPowerShellEncodedArgs', ENCODED_GATE],
  ];
  for (const [label, gate] of checks) {
    if (!src.includes(gate)) {
      throw new Error(`collector 补丁失败：未找到「${label}」代码片段，nodeModulesCollector.js 可能已变更。`);
    }
  }
  src = src.replace(COLLECTOR_GATE, COLLECTOR_PATCHED);
  src = src.replace(COLLECTOR_SPAWN_GATE, COLLECTOR_SPAWN_PATCHED);
  src = src.replace(COLLECTOR_PIPE_GATE, COLLECTOR_PIPE_PATCHED);
  src = src.replace(ENCODED_GATE, ENCODED_PATCHED);
  fs.writeFileSync(collectorJs, src);
  console.log('collector 补丁已应用：输出重定向改为进程内 Out-File，宿主侧不建管道。');
}

// ---------------------------------------------------------------------------
// 补丁三：图标转换工具（icon-tool.js）用 execFile 调用（宿主侧管道 EPERM）。
// 改为直接 spawn 且 stdio 继承控制台 —— 工具把产物写到 outDir 文件，
// 调用方只读文件，不依赖 stdout 捕获。
// ---------------------------------------------------------------------------
const ICONS_JS = path.join(project, 'node_modules', 'app-builder-lib', 'out', 'toolsets', 'icons.js');

const ICONS_GATE = [
  '    await (0, builder_util_1.exec)(process.execPath, [scriptPath, `--input=${safeInput}`, `--format=${outputFormat}`, `--out=${safeOutDir}`], { shell: false });',
].join('\n');

const ICONS_PATCHED = [
  '    // DSH-PATCH: execFile 会建宿主侧管道（受限沙箱 EPERM），改为 spawn + 继承控制台。',
  '    await new Promise((resolve, reject) => {',
  '        const child = childProcess.spawn(process.execPath, [scriptPath, `--input=${safeInput}`, `--format=${outputFormat}`, `--out=${safeOutDir}`], { shell: false, stdio: ["ignore", "inherit", "inherit"], windowsHide: true });',
  '        child.on("error", reject);',
  '        child.on("close", code => (code === 0 ? resolve() : reject(new Error(`icon-tool exited with code ${code}`))));',
  '    });',
].join('\n');

const ICONS_REQUIRE_GATE = [
  'const electronGet_1 = require("../util/electronGet");',
].join('\n');

const ICONS_REQUIRE_PATCHED = [
  'const electronGet_1 = require("../util/electronGet");',
  'const childProcess = require("child_process");',
].join('\n');

function applyIconsPatch() {
  let src = fs.readFileSync(ICONS_JS, 'utf8');
  if (src.includes('DSH-PATCH: execFile')) {
    console.log('icons 补丁已存在，跳过。');
    return;
  }
  if (!src.includes(ICONS_GATE)) {
    throw new Error(`icons 补丁失败：未找到 exec 调用片段，icons.js 可能已变更。`);
  }
  src = src.replace(ICONS_GATE, ICONS_PATCHED);
  if (!src.includes('const childProcess = require("child_process");')) {
    src = src.replace(ICONS_REQUIRE_GATE, ICONS_REQUIRE_PATCHED);
  }
  fs.writeFileSync(ICONS_JS, src);
  console.log('icons 补丁已应用：图标转换工具改为无管道 spawn。');
}

main();
applyCollectorPatches();
applyIconsPatch();
