# Folia Free

**内置网易云、QQ 音乐、酷狗、酷我、咪咕 5 个免费音源。下载发布包，解压或安装后即可搜索、听歌，无需配置音源或登录平台账号。**

**仅支持平台允许免费收听的歌曲，会员及付费歌曲不支持。本项目不是破解版，不解锁或绕过会员权限。** 歌曲版权属于各平台与权利人，歌曲能否播放、下载仍取决于平台的公开权限、地区和接口状态。

[下载最新版本](https://github.com/quyanchun/folia-free/releases/latest) · [所有版本](https://github.com/quyanchun/folia-free/releases) · [构建说明](docs/BUILD.md)

![Folia Free：五源歌单与推荐](docs/screenshots/home.png)

## 下载与使用

| 系统 | 发布文件 | 使用方法 |
| --- | --- | --- |
| macOS · Apple Silicon（M 系列） | `Folia-Free-版本-macOS-arm64.zip` | 解压，将 `Folia Free.app` 拖入应用程序 |
| macOS · Intel | `Folia-Free-版本-macOS-x64.zip` | 解压，将 `Folia Free.app` 拖入应用程序 |
| Windows 10/11 · 64 位 | `Folia-Free-版本-Windows-x64-Setup.exe` | 运行安装程序 |
| Windows · 便携版 | `Folia-Free-版本-Windows-x64.zip` | 完整解压后运行 `Folia Free.exe` |

运行时已包含本地音源服务、Python、FFmpeg / ffprobe，无需另装 Node.js、Python，也不依赖 NAS。首次使用选择「内置音源」即可；没有登录云账号时会默认使用内置音源。

首版 macOS 包以 macOS 15 为构建及自动启动测试环境，较旧系统尚未验收。发布包未做 Apple 公证或 Windows 商业代码签名，系统可能提示来源未验证。请从本仓库 Releases 下载，并使用 `SHA256SUMS.txt` 核对文件。

## 已有功能

- **五源搜索**：同时查询网易云、QQ 音乐、酷狗、酷我、咪咕，保留每首歌的音源身份。
- **歌单与推荐**：未登录即可浏览五源公开歌单和精选推荐。某个音源临时不可用时，其余来源仍可显示。
- **专辑**：展示 QQ、酷狗公开新碟，以及酷我的公开专辑选集；酷我当前选集来自周杰伦的公开专辑搜索。
- **榜单**：五源热歌、新歌、飙升/趋势榜，共 15 个入口。
- **播放器**：保留 Folia 的歌词、播放队列、本地音乐、Navidrome / Subsonic、原有云账号登录等功能。原有平台服务是否可用仍取决于其各自要求。

网易云公开歌单可能只返回部分曲目，界面会提示。公开推荐是平台精选内容，不等同于登录账号的个性化推荐。这里的「内置音源」指随应用提供的接入代码，不包含音乐文件、用户账号或会员凭据；会员及付费歌曲不支持播放，不是破解版。

## 源码来源

本项目基于 [chthollyphile/folia-major](https://github.com/chthollyphile/folia-major) 的 **`main` 分支历史中的 `v0.7.27`** 修改，准确基点为 [`4a545c96229664c0e07d4fb04971264e8d75fdd2`](https://github.com/chthollyphile/folia-major/commit/4a545c96229664c0e07d4fb04971264e8d75fdd2)。不是对上游最新分支的持续同步，也不是 Folia 官方发行版。

在此基础上增加了免登录五源聚合、公开歌单/推荐/专辑适配、独立数据目录及 Mac / Windows 自包含打包。音源服务部分基于 [0xHJK/music-dl](https://github.com/0xHJK/music-dl) 的 MIT 许可代码及本项目适配。

Folia Free 的 `main` 分支包含当前完整修改源码，包括 `backend/` 和构建脚本。原作者、贡献者、版权声明和许可证均予保留，见 [NOTICE.md](NOTICE.md)、[THIRD_PARTY.md](THIRD_PARTY.md) 和 [LICENSE](LICENSE)。

## 数据与开发

应用数据默认保存在系统「音乐」目录下的 `Folia Free/`，包括设置、封面、歌词、音频缓存、下载和后台数据；代码仓库不包含这些个人文件。使用独立测试 profile 时，数据写入该测试目录。

技术栈沿用上游 Electron + React / TypeScript，内置源服务使用 Python。开发和打包步骤见 [docs/BUILD.md](docs/BUILD.md)。欢迎通过 Issue 反馈问题，请勿附带账号 Cookie、Token、密码或私人音乐库。

## 许可

播放器及本项目修改遵循 **AGPL-3.0**。随应用分发的对应修改源码在本仓库提供。`backend/core/vendor/` 中原始 music-dl 保留 MIT 许可证；Python、FFmpeg 及其他依赖遵循各自许可证。本项目不提供任何音乐版权授权。
