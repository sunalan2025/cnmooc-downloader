# CNMOOC Downloader

[![lint](https://github.com/sunalan2025/cnmooc-downloader/actions/workflows/lint.yml/badge.svg)](https://github.com/sunalan2025/cnmooc-downloader/actions/workflows/lint.yml)
[![CodeQL](https://github.com/sunalan2025/cnmooc-downloader/actions/workflows/codeql.yml/badge.svg)](https://github.com/sunalan2025/cnmooc-downloader/actions/workflows/codeql.yml)
[![Release](https://img.shields.io/github/v/release/sunalan2025/cnmooc-downloader?display_name=tag)](https://github.com/sunalan2025/cnmooc-downloader/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

> 本项目基于 **MIT 许可证** 开源，详见 [LICENSE](LICENSE)。

批量下载上海交大好大学在线（cnmooc.sjtu.cn）课程视频和讲义。支持 CLI、Web GUI 和桌面应用三种使用方式。

## 安装

```bash
npm install
npx playwright install chromium
```

需要 Node.js 18+。

---

## 方式一：图形界面（推荐）

```bash
npm run gui
```

启动后会自动打开浏览器访问 `http://localhost:3456`。

界面操作：
1. 首次启动若未登录，自动弹出 Chromium 完成 Jaccount 扫码登录
2. 左侧勾选要下载的课程；点击课程名展开后还能勾选具体章节
3. 顶部工具栏调整并发数、重试次数、资源类型（全部 / 仅视频 / 仅课件）、是否增量
4. 点击「下载选中课程」开始；进度条和日志实时显示

环境变量：
- `CNMOOC_NO_OPEN=1` — 启动 server 时不自动打开系统浏览器（便于远端或自定义访问）

---

## 方式三：桌面应用（Electron）

```bash
npm install --save-dev electron
npm run desktop
```

将以独立桌面窗口运行（无浏览器、无地址栏），关闭窗口即退出。

### 打包成 .exe / .dmg / .AppImage 发布

构建配置已经放在 `electron-builder.yml`。本地直接：

```bash
npm install                       # 含 electron + electron-builder
npm run build:desktop:win         # → release/CNMOOC Downloader-0.2.0-win-x64.exe
npm run build:desktop:mac         # → release/CNMOOC Downloader-0.2.0-mac-{x64,arm64}.dmg（需 macOS）
npm run build:desktop:linux       # → release/CNMOOC Downloader-0.2.0-linux-x86_64.AppImage
```

构建脚本会先跑 `scripts/prepare-build.cjs` 把 Playwright 的 chromium 二进制下载到本地 `pw-cache/`，再由 electron-builder 作为 `extraResources` 打进安装包（约 +280 MB）。安装后用户**无需再执行 `npx playwright install chromium`**，开包即用。

跨平台构建有两种方式：
1. **GitHub Actions**（推荐）：推送 `v*.*.*` tag 后 `.github/workflows/build-desktop.yml` 会在 Ubuntu / Windows / macOS runner 上分别构建并把成品自动 attach 到对应 Release
2. **本地**：自己在对应系统上跑上面的命令

安装后运行时的数据存放位置（packaged 模式）：

| 平台 | 位置 |
|---|---|
| Windows | `~/Documents/CNMOOC Downloader/` |
| macOS | `~/Documents/CNMOOC Downloader/` |
| Linux | `~/Documents/CNMOOC Downloader/` |

里面包含 `storageState.json`、`.progress.json`、`.snapshot.json`、`config.json`（可选）和 `downloads/`。

---

## 方式二：命令行

### 1. 登录

```bash
npm run login
```

弹出 Chromium，完成 Jaccount 扫码后窗口自动关闭，cookie 保存到 `storageState.json`。后续运行可复用直至 cookie 失效。

### 2. 列出课程

```bash
npm run list
```

输出当前「正在学习」的课程及 ID：

```
  [28114] 大学物理_力学
  [28115] 大学物理实验（I）
```

### 3. 下载

```bash
# 下载全部课程
npm start

# 仅下载指定课程
node src/index.js --course-id=28114

# 仅视频 / 仅课件
node src/index.js --video-only
node src/index.js --doc-only

# 增量模式（跳过上次完整运行已记录的项）
node src/index.js --incremental

# 自定义并发与重试
node src/index.js --concurrency=5 --retry=5

# 强制重新登录
node src/index.js --relogin
```

文件保存到 `downloads/{课程名}/{章节名}/`，已下载文件按大小匹配自动跳过（断点续传）。

---

## 配置文件 `config.json`

```json
{
  "concurrency": 3,
  "retryCount": 3,
  "resourceTypes": ["video", "document"],
  "excludeChapters": [],
  "jitterMin": 300,
  "jitterMax": 800
}
```

| 字段 | 含义 |
|---|---|
| `concurrency` | 并发下载数（CLI 的 `--concurrency` 会覆盖） |
| `retryCount` | 单个文件失败重试次数 |
| `resourceTypes` | 下载类型，可选 `"video"` / `"document"` |
| `excludeChapters` | 章节名正则数组，命中则跳过该章节 |
| `jitterMin` / `jitterMax` | 请求间随机等待毫秒数，避免触发风控 |

---

## 支持的资源类型

| 类型 | 说明 |
|------|------|
| MP4  | 课程视频，直链下载 |
| PDF / PPT | 讲义、课件（含 PPTX 转 PDF） |
| 测验 | 自动跳过，不可下载 |

---

## 文件说明

| 路径 | 用途 |
|---|---|
| `storageState.json` | Playwright 登录态（含 cookie，**勿提交**） |
| `.progress.json` | 任务级断点续传记录 |
| `.snapshot.json` | 增量模式的已知 item 快照 |
| `downloads/` | 下载产物 |

---

## 注意事项

- 视频通常 50–200 MB/个，请保证磁盘空间
- cookie 有效期约数天，失效后 `npm run login` 重新登录
- `storageState.json` 含敏感信息，已在 `.gitignore` 中排除
