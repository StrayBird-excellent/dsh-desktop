# DeepSeek Harness 桌面版 —— macOS 使用说明

Windows 版封装的是 `dsh web` 官方网页界面；本目录给出 **macOS 版** 的安装包与使用说明。
macOS 版与 Windows 版共用同一份 `main.js` 与打包配置（`electron-builder.mac.yml`），
界面、功能、数据隔离策略完全一致。

## 下载哪个包？

在 Mac 上点左上角  →「关于本机」→ 查看「芯片」：

| 芯片 | 下载 |
| ---- | ---- |
| Apple M1 / M2 / M3 / M4（Apple Silicon） | `DeepSeek Harness-0.1.0-mac-arm64.zip` |
| Intel | `DeepSeek Harness-0.1.0-mac-x64.zip` |

## 安装

1. 解压 zip，得到 `DeepSeek Harness.app`；
2. 把它拖进「应用程序」（Applications）；
3. 双击运行。

> 本包未做 Apple 开发者签名（在 Windows 上无法签名），macOS Gatekeeper 会拦截。

## 首次打开（重要）

因为应用未签名，**不要**直接双击，而是：

1. 在「应用程序」里**右键** `DeepSeek Harness` → **「打开」**；
2. 弹窗再点一次「打开」即可。此操作只需做一次，之后就能正常双击运行。

如果出现「应用已损坏，无法打开」或「无法验证开发者」，在终端执行：

```bash
xattr -cr "/Applications/DeepSeek Harness.app"
```

若仍被拦截（Apple Silicon 上二进制必须带签名，可做 ad-hoc 自签名）：

```bash
codesign --force --deep --sign - "/Applications/DeepSeek Harness.app"
xattr -cr "/Applications/DeepSeek Harness.app"
```

ad-hoc 签名不需要 Apple 开发者账号，签名后即可正常启动。

## 使用

- 与 Windows 版一致：首次启动是全新配置，在 设置 → 供应商/密钥 里填一次 API Key；
- 关闭窗口 = 最小化到顶部菜单栏托盘后台运行（点鲸鱼图标可恢复窗口或彻底退出）；
- 每次启动自动挑空闲端口，与网页版（3080）互不干扰；
- 外部链接自动交给系统默认浏览器。

## 数据目录

与网页版完全隔离，macOS 上位于：

- **应用数据/日志**：`~/Library/Application Support/dsh-desktop/`
  - `logs/dsh-server.log` —— dsh 后端日志（启动失败时先看这里）
  - `home/` —— 桌面版独立的 dsh 配置目录（API Key、会话都在这里，与网页版 `~/.dsh` 互不相通）

## 已知说明

- 桌面版在 macOS 上与官方 dsh 网页版在 macOS 上的行为一致（例如目录选择插件
  `dsh-host-directory-picker-native` 是 Windows COM 实现，macOS 上走与网页版相同的回退路径）；
- 内置的 Node 运行时（v24.15.0）与 ripgrep 已按架构打包进应用，无需自行安装 Node；
- 未签名的应用每次 macOS 大版本更新后可能需重新执行一次「右键 → 打开」。

## 从源码重新构建（Windows 机器上交叉构建）

```powershell
# 0) 准备 darwin 原生物料（只需一次）
npm install --prefix mac-native --cache ..\.npm-cache --no-audit --no-fund --force `
  @koromix/koffi-darwin-arm64@3.1.4 @koromix/koffi-darwin-x64@3.1.4 `
  node-addon-require-builtin-darwin-arm64@0.1.4 node-addon-require-builtin-darwin-x64@0.1.4 `
  @vscode/ripgrep-darwin-arm64@1.18.0 @vscode/ripgrep-darwin-x64@1.18.0 `
  @img/sharp-darwin-arm64@0.35.3 @img/sharp-darwin-x64@0.35.3
# 下载 node darwin 二进制到 node-runtime/darwin-{arm64,x64}/node（见 scripts/download.mjs）
# 预解压 Electron darwin 发行包（符号链接→真实副本）：
node scripts/extract-electron-zip.cjs <electron-darwin-arm64.zip> electron-dist/darwin-arm64
node scripts/extract-electron-zip.cjs <electron-darwin-x64.zip>   electron-dist/darwin-x64

# 1) 解除 electron-builder 的 win32 拦截（重装依赖后需重跑）
#    同时打上沙箱/管道兼容补丁（npm 依赖收集与图标工具改为无宿主管道执行）
node scripts/patch-electron-builder.cjs

# 2) 分别构建两个架构的 .app 目录（afterPack 自动注入 Node 与 darwin 原生模块）
#    PowerShell 会话内先设置缓存目录（避免写 %LOCALAPPDATA%）与镜像：
$env:ELECTRON_BUILDER_CACHE = 'D:\deepseek\dsh-desktop\.builder-cache'
$env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
node node_modules/electron-builder/out/cli/cli.js --config electron-builder.mac.yml --mac dir --arm64 `
  --config.electronDist=D:/deepseek/dsh-desktop/electron-dist/darwin-arm64
node node_modules/electron-builder/out/cli/cli.js --config electron-builder.mac.yml --mac dir --x64 `
  --config.electronDist=D:/deepseek/dsh-desktop/electron-dist/darwin-x64

# 3) 打成带正确 Unix 权限位的 zip（Windows 原生 zip 不写可执行位）
powershell -File scripts/zip-mac-app.ps1 -AppDir "release/mac-arm64/DeepSeek Harness.app" `
  -OutZip "release/DeepSeek Harness-0.1.0-mac-arm64.zip"
powershell -File scripts/zip-mac-app.ps1 -AppDir "release/mac/DeepSeek Harness.app" `
  -OutZip "release/DeepSeek Harness-0.1.0-mac-x64.zip"
```

> 原理说明：electron-builder 官方禁止在 Windows 上构建 macOS 目标（框架符号链接与
> Unix 权限位无法在 NTFS 上表达）。本项目用「符号链接→真实副本」预解压 +
> `electronDist` 绕过框架解压，并用自写 zip 工具显式写入 Unix 权限位，
> 从而在 Windows 上产出可在 macOS 运行的包。
