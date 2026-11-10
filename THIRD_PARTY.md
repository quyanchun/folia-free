# 第三方软件与许可

- **Folia-major v0.7.27**：AGPL-3.0，chthollyphile 及贡献者；完整许可证见根目录 `LICENSE`，对应修改源码随 Git Tag 提供。
- **music-dl**：MIT，见 `backend/core/vendor/LICENSE`。
- **Electron / Node.js / Chromium / 原生依赖**：复用固定 Folia 官方运行包，保留其 `LICENSE`、`LICENSES.chromium.html` 和原生组件文件；各自许可不变。原生基包的固定版本及摘要见 `packaging/free/upstream.json`。
- **Python**：PSF License；由 PyInstaller 收集的运行时及包信息保留在后台目录。Python 包版本见 `backend/core/requirements.txt`。
- **FFmpeg / ffprobe**：GPL 构建，不属于音乐版权授权。macOS 来自 Homebrew FFmpeg，PyInstaller 收集其所需动态库；Windows 使用 FFmpeg-Builds 的 n8.1 GPL 构建，下载摘要固定，随包保留 LICENSE/README。参考 [FFmpeg 法律说明](https://ffmpeg.org/legal.html)、[FFmpeg 源码](https://git.ffmpeg.org/ffmpeg.git)、[Homebrew 构建配方](https://github.com/Homebrew/homebrew-core/blob/master/Formula/f/ffmpeg.rb)、[FFmpeg-Builds 构建源码](https://github.com/FFmpeg-Builds/FFmpeg-Builds)。分发者须继续遵守所用构建及依赖的源码提供义务。
- **其他 JavaScript 依赖**：锁定依赖树见 `package-lock.json`；平台 API SDK 保留原有固定版本及各自许可。

应用截图展示的是各音乐平台返回的封面与公开歌单界面，不表示本项目拥有相关音乐或封面的版权。
