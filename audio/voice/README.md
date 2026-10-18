中文报牌素材由项目词表 `js/voice-lines.js` 合成，未下载其他游戏的配音。

- 自己 `bright/`：清亮女声，Microsoft Xiaoxiao Neural。
- 东家 `bold/`：有力男声，Microsoft Yunjian Neural。
- 对家 `spark/`：俏皮女声，Microsoft Xiaoyi Neural。
- 西家 `calm/`：爽朗男声，Microsoft Yunxi Neural。
- 四位不同的神经网络说话者，各 62 句；过牌和余牌提醒有各自的口吻。包含点数、牌型、炸弹张数和接风。
- 普通报牌放慢 6%，重牌放慢 12%，比 v1.14.1 略快；恢复明亮音调、加强字头与存在感，去掉混响拖尾。播放时不随快速模式加速。
- 四家分别使用独立媒体元素，允许跨座位重叠；同家只接自己的余牌提醒。暂停、静音、关报牌会停止全部声道。
- MP3、单声道 32kHz，已裁掉头尾静音并统一响度；随发布包与手机离线缓存交付，音频地址含产品版本号。实测时长记于 `manifest.json`。

开发时在临时 Python 环境安装 `edge-tts`，设置 `GUANDAN_VOICE_PYTHON` 指向该环境的 Python，再运行 `node tools/build-voices.cjs`。生成工具需联网，实际游戏使用内置文件、不调用语音服务。可用 `GUANDAN_FFMPEG` 与 `GUANDAN_FFPROBE` 指定 ffmpeg 工具路径。
