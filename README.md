# DeepSeek Harness 桌面版（dsh-desktop）

把 [@deepseek-ai/dsh](https://www.npmjs.com/package/@deepseek-ai/dsh) 的 `dsh web` 浏览器界面封装成 Windows / macOS 桌面应用，图标使用 DeepSeek 小鲨鱼（鲸鱼）logo。

## 工作原理

```
┌─────────────────────────────────────────────┐
│  Electron 主进程 (main.js)                    │
│                                              │
│  1. 探测空闲端口（127.0.0.1）                  │
│  2. 用应用内置的 node.exe 启动 dsh web         │
│     （resources/node/node.exe，与网页版同环境）  │
│  3. 轮询 HTTP 直到服务器就绪                    │
│  4. 窗口加载 http://127.0.0.1:X/              │
│  5. 退出时 taskkill /T 清理 dsh 进程树         │
└─────────────────────────────────────────────┘
```

> 为什么内置 node.exe：dsh 的目录选择器等插件用 koffi（原生 FFI）调 Windows
> COM，必须跑在真正的 Node 运行时里；Electron 的 node 模式加载 koffi 会原生
> 崩溃（表现为 "win32 folder dialog worker exited"）。内置 node（MIT 协议，
> 附 LICENSE）后，桌面版与网页版的运行环境完全一致。

- 界面就是官方 `dsh web` 界面本身，功能与浏览器版完全一致；
- **与网页版完全隔离**：桌面版使用独立的配置目录 `%APPDATA%\dsh-desktop\home`，
  不读取也不写入网页版的 `~\.dsh` —— API Key、会话、设置各自独立，两个版本
  同时运行互不干扰（早期版本共享目录曾导致会话日志交叉写入损坏）；
- **首次启动**：因为是全新配置，界面里会让你配置 API Key（设置 → 供应商/密钥），
  只需配置一次，之后保存在桌面版自己的目录里；
- 每次启动自动挑空闲端口，不占用 3080；
- **关闭窗口 = 最小化到系统托盘后台运行**（托盘图标可恢复窗口或彻底退出）；
- 外部链接自动交给系统默认浏览器打开。

> 为什么关闭 asar 打包（`asar: false`）：dsh 每次启动会在
> `~/.dsh/profiles/node_modules` 里为依赖包创建 junction（目录链接）作为模块解析
> 回退；junction 只能指向真实目录，无法指向 asar 虚拟路径。保持 node_modules
> 为真实目录后，桌面应用与命令行版 dsh 可以交替使用同一份配置，各自启动时会
> 自动把链接修正回自己的安装位置。

## 目录结构

```
dsh-desktop/
├── main.js                 # Electron 主进程
├── package.json            # 依赖与 electron-builder 配置
├── assets/
│   ├── whale.svg           # DeepSeek 鲸鱼原始矢量（来自 dsh-web-frontend）
│   ├── loading.html        # 启动加载页
│   ├── icon.ico / icon.png # 应用图标（由 scripts/make-icon.mjs 生成）
├── scripts/make-icon.mjs   # 图标生成脚本
├── build/                  # 构建资源（icon.ico / icon.png）
└── release/                # 打包产物输出目录
```

## 开发与构建

```powershell
# 开发调试（需要先 npm install）
npm start

# 重新生成应用图标（改 assets/whale.svg 后）
npm run icons

# 只打包目录（快速验证）
npm run pack

# 打包安装程序：NSIS 安装包 + 免安装 portable
npm run dist
```

> 构建前需准备内置 Node 运行时（体积较大，已加入 `.gitignore`，不随源码分发）：
> Windows 版需 `node-runtime/node.exe`；macOS 版需 `node-runtime/darwin-{arm64,x64}/node`
> 与 darwin 原生模块，下载与交叉构建步骤见 [README-mac.md](./README-mac.md)，
> 可用 `node scripts/download.mjs <nodejs.org 下载地址> <目标路径>` 断点续传下载。

产物在 `release/`：

- `DeepSeek Harness-Setup-0.1.0.exe` —— 安装版（可选安装目录、创建桌面/开始菜单快捷方式）
- `DeepSeek Harness-Portable-0.1.0.exe` —— 免安装版（双击即用）

### macOS 版

macOS 版安装包（`release/DeepSeek Harness-0.1.0-mac-{arm64,x64}.zip`，Apple Silicon 选 arm64、Intel 选 x64）
的安装与首次打开（未签名，需右键打开 / ad-hoc 签名）说明见 [README-mac.md](./README-mac.md)。
macOS 版在 Windows 上交叉构建（electron-builder 官方禁止，本项目以预解压 + 补丁 + 自写 zip 方式实现），
步骤见 README-mac.md「从源码重新构建」。

## 运行时信息

- **应用数据目录**：`%APPDATA%\dsh-desktop\`
  - **日志**：`%APPDATA%\dsh-desktop\logs\dsh-server.log`（dsh 启动失败时看这里）
  - **独立 dsh 配置目录**：`%APPDATA%\dsh-desktop\home`（API Key、会话都在这里，与网页版 `~\.dsh` 互不相通）
- **调试用环境变量**：
  - `DSH_DESKTOP_PORT=12345` —— 固定端口（默认自动选空闲端口）
  - `DSH_DESKTOP_HOME=D:\tmp\dsh-home` —— 临时覆盖独立配置目录（测试用）
  - `DSH_DESKTOP_NO_DIALOG=1` —— 启动失败时静默退出，不弹窗（测试用）

## 协议与版权说明

- 本项目 MIT 协议；`@deepseek-ai/dsh` 为 MIT 协议（© DeepSeek）。
- 鲸鱼 logo 矢量取自 `@deepseek-ai/dsh-web-frontend` 的 favicon（MIT）。
- DeepSeek 名称与鲸鱼标志为 DeepSeek 商标，本应用为非官方封装，仅供学习使用。
