# 方言素材来源核查

核查日期：2026-10-27。此文记录实际采用、试听及排除的来源；找到录音不等于完整报牌包已经就绪。游戏只播放本地 MP3，不在运行时调用语音服务。

2026-10-28 收尾：用户表示剩余音源过于复杂则不继续，评估后结束本轮搜集。按 10 月 26～27 日的清理要求删除失败音频、未采用参考录音、临时模型和重复产物；保留已采用母带、已通过小样、原西家参考录音以及本页来源、许可和拒绝指纹记录。下文描述的历史临时归档不再全部留存，当前完整包的来源校验信息仍在运行清单中。

## 已安装的来源

| 语音包 | 来源及方式 |
| --- | --- |
| 普通话男声修正 | 你和西家原来误用四川 Eric，现改为 [Qwen3-TTS CustomVoice](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice) 的中文男声 Uncle_Fu，以标准普通话指令重新生成全部 72 条报牌及试听。原西家 Eric 音频完整归档，四川男声继续明确使用 Eric。 |
| 粤语女、粤语男 | 微软区域声线 HiuGaai、WanLung；开发时使用 edge-tts 获取，逐段验证。 |
| 四川男 | 新试音使用 [Qwen3-TTS 1.7B CustomVoice](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice) 的 Eric，官方将其标为成都男声／四川话。沿用原西家说话人，以独立成都话指令重新生成 72 条，原西家文件保持不变。公开模型 Apache-2.0，使用 MLX 4bit 转换并核对官方 LFS 文件哈希。 |
| 沪语女/男 | 微软专用沪语声线晓彤 `wuu-CN-XiaotongNeural`、云哲 `wuu-CN-YunzheNeural`。2026-10-27 用户通过五句来源小样后，通过 [fuym.cn](https://fuym.cn/) 的正常公开网页生成两段完整母带，按显式停顿拆分 72 条并拼接各自试听；原母带哈希、片段范围、来源小样通过记录均保留。 |
| 新河南女声 | 用户通过 [AITTS 多角色配音](https://aitts.cc/multi-voice-tts)「晓晓 方言 / 中文（河南话，简体）」五句小样后，使用同一声线及模式生成两段各 36 条母带，检查 35 个内部静音边界后拆分。来源目录将其标为 `zh-CN-XiaoxiaoDialectsNeural` 的 `zh-CN-henan` 模式。实际声音以此次用户验收为准，未仅凭目录宣称原生河南说话人。 |

各包的实际引擎、来源 URL、合成指令/种子或原始长音频哈希均记录在 `audio/voice/dialect-manifest.json`；`js/voice-packs.js` 只登记校验完毕的包。模型权重、Python 环境和生成缓存不随游戏发布。

2026-10-27 用户确认河南、东北男女声均不太对，四套 292 段录音已归档撤下，拒绝指纹及旧来源信息保留。河南男女声、东北男声原为 [VoxCPM2-4bit](https://huggingface.co/mlx-community/VoxCPM2-4bit) 原创生成角色，模型 [OpenBMB VoxCPM](https://github.com/OpenBMB/VoxCPM) 为 Apache-2.0、[MLX Audio](https://github.com/Blaizzy/mlx-audio) 为 MIT；东北女声原为微软 `zh-CN-liaoning-XiaobeiNeural`，同样未通过。原生目录标签不能替代用户的口音判断。旧配置均禁用，新来源先做少量报牌试听。

河南女声换源小样已获用户通过并制作完整包。新晓晓东北模式导出与旧沪语备选的解码波形几乎一致（24kHz 单声道，零位移相关系数约 0.9994），已暂停该来源试听，不将不同页面标签或 MP3 哈希当成区域切换成功。原始导出、检测依据及实际采样状态记录于 `test/fixtures/voice-auditions/henan-dongbei-2026-10-27/`。专用河南男声云登、东北男声云彪在微软目录中存在，但前一公开导出渠道达到当日额度后已停止；另一站点的目录链接未使实际合成界面切换到目标男声，未使用其结果冒充。

微软 Azure 目录与免费 Edge 声线目录并不相同：公开 Edge 入口实际只验证通过上述三套，不能通过填写未公开的 Azure 声线 ID 获得其余声音。2026-10-26 的 fuym.cn 沪语生成遇到每日额度后即停止；次日通过正常网页操作取得下述小样，没有绕过额度。

旧四川男声使用 `zh-CN-sichuan-YunxiNeural`，由 [fuym.cn](https://fuym.cn/) 的公开网页生成；网站说明核心功能免费且生成配音可商用，导出后按 71 个显式停顿分割 72 条。用户认为可用但更喜欢原西家 Eric，因此本轮更换，旧版本压缩包保留。

沪语 VoxCPM2 男女声已经用户否定（声调、腔调均不对），已撤下并禁用生成配置。[微软目录](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support?tabs=tts)明确提供原生 `wuu-CN-XiaotongNeural` 女声和 `wuu-CN-YunzheNeural` 男声。2026-10-27 在 [fuym.cn](https://fuym.cn/) 正常选择「中文（上海话）」及对应声线，分别导出五句报牌，女声 12.852 秒、男声 12.672 秒（均含四处 700ms 句间停顿）。用户随后确认晓彤女声 A 可用，云哲男声可继续制作完整包。完整母带女声 265.140 秒、男声 262.008 秒，均包含 72 条报牌和 71 个两秒显式停顿；导入器完整拆分、逐条验证后安装，登记为来源小样通过。网站的[常见问题](https://fuym.cn/faq.html)允许生成音频商用。另有服务的公开 API 返回 401 后即停止，没有搜寻密钥或绕过授权。

另在 [AITTS 多角色配音](https://aitts.cc/multi-voice-tts) 明确设置「晓晓 方言 / 中文（上海话，简体）」后导出 6.192 秒女声报牌小样，使用 `zh-CN-XiaoxiaoDialectsNeural` 的 `wuu-CN` 模式，语速与音调均为默认。该平台的[说明](https://aitts.cc/blog/free-tts-guide)允许免费商用生成音频。小样只进入独立对比页，未安装完整包、未声称口音通过；此前未能确认生效声线的另一段导出未用于对比页。

四川女声的两版 VoxCPM2 试音均被用户否定。第二版改动了表演语气和尾音时长，仍「不对味」，已归档并禁用配置。此次换用「晓晓 方言 / 中文（四川话，简体）」的 `zh-CN-sichuan` 模式，导出 3.852 秒小样，仅含「三带二、四张炸弹、我还剩两张」；2026-10-27 用户仍未通过，已记录拒绝及哈希，对比页停止播放该版本，没有制作整包。

已通过的沪语两段小样保存在 `test/fixtures/voice-auditions/2026-10-27/`，`samples.json` 保留全部来源、区域、台词、参数、时长、SHA-256 及验收结果；拒绝的四川女声和无法核验的沪语备选音频已按清理要求删除。小样不进入离线游戏发行包，已通过来源另行制作的完整沪语包随游戏发行。运行 `node tools/build-voice-review.cjs` 可生成当前试听页，直接使用完整包录音，缺失失败小样不会阻止生成。

## 河南女声语速调整

2026-10-27 用户要求河南女声放慢。v1.24.6 使用 `tools/slow-henan-female.cjs` 对已通过的同一来源执行 `atempo=0.85`，保持音调，添加 40ms 开头与 60ms 结尾余量；72 条报牌分别处理后重建试听。每条保留处理前 SHA-256、原母带范围和处理参数，整包通过统一校验后替换。脚本拒绝重复处理同一个已放慢包，避免运行两次导致越来越慢。

## 河南男声、东北男女声后续来源

2026-10-27 继续换源核查，三项仍未接入游戏：

- **河南男声“小坤”**、**东北女声“晓倩”**：[讯飞官方在线合成](https://www.xfyun.cn/services/online_tts)分别选择对应发音人，使用默认参数合成「不要、三带二、四张炸弹、我还剩两张、队友交给你」。两页均由「正在合成」变为「重新播放」，可在官网现场试听；公开界面未提供音频下载，未取得本地文件，尚未核实完整游戏素材的使用授权。
- **东北男声“大林”**：[TTSMaker 公开目录](https://ttsmaker.cn/developer-api-docs)将其标为 `Dlin 大林-东北口音男声`、ID `1204`。目录提供的公开示例已验证可解码，长 6.912 秒；试听页仅引用供应方 URL，明确标为「供应方演示，非报牌」，不随游戏发布。多角色网页转换需要登录；一次文档允许的 API 测试因共享演示额度耗尽未生成音频，演示 API 也不授权用于游戏素材生产，未继续尝试其他凭据或绕过额度。

候选来源、实际可播放状态与阻碍记录于 `test/fixtures/voice-auditions/henan-dongbei-2026-10-27/samples.json` 的 `sourceCandidates`，与已下载小样、已安装语音包分别记录。找到新声线或官网可重播均不代表用户已认可口音。

## 阜宁真人素材与试音

最新偏好为优先盐城阜宁话。实际找到：

- 老干部（2014），[《阜宁县的一個故事》](https://phonemica.net/x/5437483c2bd553180882ab7a/0)，男声，约 26 秒；地点标明江苏盐城阜宁县，带汉字/音标转写。
- 尤特（2013），[《阜宁的一个故事》](https://phonemica.net/x/543746312bd553930782ab29/0)，男声，地点标明江苏盐城阜宁县。

乡音苑的[使用条款](https://phonemica.net/terms)明确为 [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/)。本地研究录音保留作者、题名、日期、出处、许可和 SHA-256；只用于非商业报牌试音。当前试音是基于原录音的 AI 合成，不能称作本人录制的报牌。若后续采用完整包，应为该包继续保留署名、非商业与相同方式共享要求。

原录音、试音及其来源清单留在忽略发布的 `test/voice-settings-evidence/`。2026-10-26 用户确认阜宁试音的声调、腔调均不对，原独立试音游戏中该完整男声包已退役，旧打包器拒绝重新发布相同文件。当前参考合成没有达到阜宁话要求；继续寻找合适的原生来源，不把普通话、四川话或扬州话重命名为阜宁话，也不将男声移调标成女声。

2026-10-27 继续核查公开服务：[讯飞在线合成](https://www.xfyun.cn/services/online_tts)公开列出的常用方言、[蝉镜方言示例](https://doc.chanjing.cc/experience-center/accent-synthesis)均未给出可核验的阜宁声线。此次没有新增合格阜宁报牌素材，仍保持不可用；服务泛称支持方言或音色克隆，不作为其已支持阜宁发音的依据。

## 扬州与其他排除来源

- 最初通过 VoiceDesign 指令试做的扬州男女声已被用户试听否定。配置已移除，试听文件只留测试证据，不进入发布包。
- [WikiAccents](https://www.wikiaccents.org/wiki/Chinese-Dialects) 的目录列出扬州真人女声，但音频页目前连接失败，未能核实逐文件授权，未采用。
- 乡音苑高桥（2013）的[《江都的一个故事》](https://phonemica.net/x/543746312bd553930782ab95/0)明确来自江都嘶马；站内也有关于通泰口音和扬州市区差异的讨论。只作地区对照，不标为扬州市区口音，不用于游戏。
- [乡音计划《江苏扬州话入门100句》](https://www.bilibili.com/video/BV18o4y1n7DV/)和[扬州话口语教程](https://www.bilibili.com/video/BV1v44y1A7JR/)均标注未经授权禁止转载，未下载使用。
- [KeSpeech 原始数据许可](https://github.com/tzyll/KeSpeech/blob/main/dataset_license.md)限制商业使用、改编和再分发，未采用；没有依据镜像站更宽松的标签使用它。
- [MagicData-Dialect-Wu-Chinese-TTS-Lite](https://magichub.com/cn/datasets/magicdata-dialect-wu-chinese-tts-lite/)为苏州话，并采用 CC BY-NC-ND；不能当成沪语或用于改编报牌，未采用。

口音判断与文件完整性是两个验收维度。自动测试能证明路径、哈希、可解码性、播放和缓存正确，不能证明合成发音地道；小型 ASR 对方言和短句也存在误识别，不用其结果充当母语者验收。
