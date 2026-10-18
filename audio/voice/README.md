中文报牌素材由项目词表 `js/voice-lines.js` 合成，未下载其他游戏的配音。

- `bright/`：明快女声，Microsoft Xiaoxiao Neural。
- `calm/`：沉稳男声，Microsoft Yunxi Neural。
- 两套各 62 句，包含点数、牌型、炸弹张数、过牌、接风与余牌提醒。
- 普通报牌放慢 14%，重牌放慢 22%，降低音调并增强低频与重音；播放时不随快速模式加速。
- MP3、单声道 32kHz，已裁掉头尾静音并统一响度；随发布包与手机离线缓存交付。实测时长记于 `manifest.json`。

开发时在临时 Python 环境安装 `edge-tts`，设置 `GUANDAN_VOICE_PYTHON` 指向该环境的 Python，再运行 `node tools/build-voices.cjs`。生成工具需联网，实际游戏使用内置文件、不调用语音服务。可用 `GUANDAN_FFMPEG` 与 `GUANDAN_FFPROBE` 指定 ffmpeg 工具路径。
