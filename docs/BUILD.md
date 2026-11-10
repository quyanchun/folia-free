# 开发与构建

发布包运行不需要系统 Python / Node。以下依赖仅供从源码开发与打包使用。

## 环境

- Node.js 24、npm。
- Python 3.13（本机 Python 3.14 也已验证）、PyInstaller 6.22.3。
- 原生目标系统：macOS arm64 / x64，或 Windows x64。Python 后台必须在目标系统、目标架构原生构建。
- macOS：Xcode Command Line Tools、Homebrew FFmpeg（`brew install ffmpeg`）。
- Windows：7-Zip（默认路径 `C:\Program Files\7-Zip\7z.exe`）；FFmpeg/ffprobe 由固定摘要脚本准备。

## 安装依赖和检查

```sh
npm ci
python -m pip install -r backend/core/requirements.txt pyinstaller==6.22.3
npm run typecheck
npm run test:unit -- test/unit/onlineMusic/stationProvider.test.ts test/unit/electron/musicStationBridge.test.ts test/unit/electron/publicCatalog.test.ts test/unit/library/core/homeSources.test.ts test/unit/onlineMusic/omniArchitecture.test.ts
python -m unittest discover -s test/backend -v
```

Windows 先执行 `python packaging/free/prepare_windows_tools.py`；GitHub Actions 会自动把准备好的 `bin` 加入 PATH，本地执行则需要手动将 `.release-cache/windows-tools/bin` 加入 PATH。

## 打包与验证

```sh
npm run build:backend
npm run package:free
npm run verify:free
```

输出在 `release/`；临时构建在 `.release-build/`，下载缓存位于 `.release-cache/`，均不提交。`verify:free` 使用临时 profile 启动最终应用，确认版本、原生窗口、自包含后台和音频工具，退出后移除测试 profile，不读真实用户账号。

打包复用上游 v0.7.27 同架构官方运行包中的 Electron、原生组件与模型；完整替换 dist、electron、shared 代码并加入当前构建的后台。固定 SHA256 见 `packaging/free/upstream.json`，不匹配即失败。macOS 重新写入 ASAR 完整性哈希并 ad-hoc 签名；Windows 更新 PE 版本与 ASAR 完整性资源，再生成 NSIS 安装包和 ZIP。

Windows 音频工具上游下载地址是滚动资源，但只接受清单中的确切 SHA256。若上游替换该资源导致构建失败，应审阅新构建源码、许可和摘要后更新清单，不得跳过校验。

本地开发先构建后台，然后运行 `npm run dev:electron`。默认真实用户数据在系统音乐目录下的 `Folia Free/`；自动测试使用独立 `--user-data-dir`。

## 发布

`.github/workflows/release.yml` 在推送 `v版本` Tag 后，在 GitHub 托管的两种 Mac 架构和 Windows x64 上分别构建和验证。三路全部成功后才生成 SHA256SUMS.txt 并发布 Release；未通过的构建不会产生正式发行版。手动运行工作流只构建测试，除非所选 ref 本身是版本 Tag。

公开前检查新增文件与提交历史，不提交 `.env`、凭据、账号数据、缓存、运行日志或个人验收记录。保留 LICENSE、NOTICE 和依赖许可。首版不启用自动更新，后续版本从本仓库 Releases 下载。
