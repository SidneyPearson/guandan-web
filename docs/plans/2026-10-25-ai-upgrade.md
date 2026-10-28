# Guandan AI Upgrade Implementation Plan

**Goal:** 为电脑与托管提供遵守信息边界、支持完整合法动作与团队战术的可配置决策系统，并以至少 100 个场景和 1000 副配对对抗验证。

**Approach:** 复用原生 JavaScript 规则引擎、观察接口、结构分解和战术评分。完整动作生成先于候选裁剪；在独立采样世界中比较候选，使用相同采样降低方差。策略不接收真实其他手牌。Worker 隔离搜索，规则兜底与提交校验保持一致。

**Affected areas:** `js/rules.js`, `js/ai.js`, 新增 `js/ai-memory.js`, `js/ai-search.js`, `js/ai-worker.js`, `js/ai-client.js`; `js/game.js`, `js/ui.js` 的接入；双入口、移动离线缓存；测试与文档。

**Verification:** `node test/ai-upgrade.cjs`; `node test/ai-worker.cjs`; `node test/run-tests.js` 与现有 AI 回归；`node test/eval-ai-upgrade.cjs --pairs 500 --segment holdout`; 浏览器桌面/移动布局、托管、Worker、离线与打包回归。

## 现状与边界

- `rules.analyze/resolveSubmission/beats` 是规则真源，固定 5 张顺子、3 连对、2 连三张及现有炸弹等级不变。
- `rules.enumerate` 只取各点固定实体牌，连续型只补最少配牌，存在关键拆法遗漏；去重也遗漏解释值。
- `ai.recommend` 已只读观察对象，有结构束搜索、炸弹保留、报单报双拦截；hard 仅对自身剩牌做最少手数搜索。
- `game.observe` 只暴露本座手牌、公开牌史、余牌数和贡还信息；其他手牌为密封代理。代理不能 structuredClone，Worker 必须显式序列化白名单。
- `ui.runAI` 和托管共用 decide，但同步执行。保留现有 flow 过期回调校验，在异步搜索返回后再次校验。
- 不修改 CSS、四人布局、牌堆与动画实现；现有存档格式不迁移。
- `test/fixtures/ai-v1/{ai,rules}.js` 保存本次修改前基线。对抗共用升级后的提交规则，旧策略在独立 vm 使用旧枚举器，规则定义一致。

## Task 1 — 完整动作与校验

**Files:** `js/rules.js`, `test/ai-upgrade.cjs`。
**Interface:** `enumerate(hand,level)` 返回全部实体牌组与合法解释；`legalActions(hand,target,level)` 返回实际可提交的动作（跟牌含 pass）。

- [x] 用组合与窗口笛卡尔积枚举实体牌，包括主动用配牌替代已有自然牌、所有炸弹张数、双配牌和三带二。
- [x] 同牌组多解释按 type/value 去重；提交动作统一 resolveSubmission 规范化，避免声明与实际解释不同。
- [x] 用小手牌全子集 analyze 穷举作为独立完备性判据，包含所有级牌和连续边界。

## Task 2 — 记牌、推断与信息隔离

**Files:** `js/ai-memory.js`, `js/game.js`, `test/ai-upgrade.cjs`。
**Interface:** `aiMemory.build(obs)`、`sample(obs,rng,model)`；`observe.serialize(obs)` 只输出白名单数据。

- [x] 由自身手牌、已打出的真实 ID 与公开贡还重建未知牌池和各点剩余量。
- [x] 出牌历史的过牌只构成软证据；保留能压但主动不要的可能性。贡还归属和余牌数为硬约束。
- [x] 采样守恒、无重复、无已出牌；不读取其他真实手牌，资料不足明确跳过模拟。

## Task 3 — 结构、团队策略与模拟

**Files:** `js/ai.js`, `js/ai-search.js`, `test/ai-upgrade.cjs`。
**Interface:** `ai.recommend(obs,options)`；options 含 tier、budgetMs、seed、samples、maxCandidates、maxPlies；metrics 记录阶段、样本、耗时、回退。

- [x] 复用结构评分与残局精确手数，完整生成后再筛选候选，保留 pass、阻断与关键炸弹。
- [x] 按开/中/残局调节惜炸、送牌、牌权和团队名次；利用公开信息概率评估控制牌。
- [x] 所有候选共享未知世界，rollout 策略每步只看本座手牌与公开局面，禁止策略读取模拟对手手牌。
- [x] 模拟状态推进复用实际游戏纯动作核心，禁用存档和表现层副作用；步数与时间双上限，完整样本轮次后才更新统计。

## Task 4 — Worker 与 UI 接入

**Files:** `js/ai-worker.js`, `js/ai-client.js`, `js/ui.js`, `index.html`, `mobile/index.html`, `mobile/sw.js`。
**Interface:** `ai.decideAsync(state,seat,options)` Promise；`ai.configure(options)`；同步 recommend/decide 保持兼容。

- [x] Worker 只接收序列化公开观察；可取消、超时终止，故障自动规则回退，最后重新校验动作。
- [x] 托管与三名电脑完全共用入口和难度；保留暂停、换局、取消托管时的 flow 校验。
- [x] file:// 使用同源代码生成的 Blob Worker；无 Worker 环境使用有界规则策略；双入口与移动离线缓存包括所有新脚本。

## Task 5 — 场景和回归

**Files:** `test/ai-upgrade.cjs`, `test/ai-worker.cjs`, `test/browser/ai-upgrade.cjs`，现有 AI 与布局测试。

- [x] 至少 100 个具名场景，覆盖队友 1/2 张、敌方将走、接风、炸弹取舍、拆配牌、守恒、信息边界、超时与非法动作恢复。
- [x] Worker 成功/超时/损坏/过期响应与公开信息白名单测试。
- [x] 桌面与手机浏览器验证真实托管、四人布局、纵向堆叠及动画触发。

## Task 6 — 配对对抗与交付

**Files:** `test/eval-ai-upgrade.cjs`, `test/ai-upgrade-results.md`, `test/ai-upgrade-results.json`, `docs/ai-system.md`, `README.md`。

- [x] 调参段与留出段固定、分离；最终至少 500 种子对即 1000 副，相同发牌/级牌/首发，双方交换座位。
- [x] 报告头游胜率、配对置信区间、团队名次分布、升级收益、平均/P95 决策耗时、非法数、超时/回退与完整采样数。
- [x] 冻结源码哈希与基线哈希，保存逐副种子、动作摘要、名次；不筛掉失败局。
- [x] 核查开源引用、记录局限、更新配置说明并运行打包检查。

## 参考核查（2026-10-25）

- [guandan-assistant](https://github.com/ckfhwph4pw-art/guandan-assistant/tree/c12eec85e05a7e2f2e94c8efaeb67f866bd5adff)：MIT。参考公开牌池、共同随机场景、候选预筛与 pass 保留思路。其 moves.ts 的连续长度及规则与本项目不同，不移植；其中“过牌即不能压”的硬约束不采用。
- [Guandan-Poker-Platform](https://github.com/mimaima699-ux/Guandan-Poker-Platform/tree/03dfbb684d3403bb045ba470005283b012ff12b4)：MIT。参考 view→独立发牌→动作推进→团队收益的接口；其廉价 rollout 仅支持单/对/三，不能满足本项目。
- [DanLM](https://github.com/dashidhy/DanLM/tree/16ace5ada4db39086bb4c8ebb372ed16cb82fab1)：Apache 2.0 **附带非商业限制**（LICENSE 第 10 条），不是纯 Apache-2.0。仅研究公开历史与动作估值分离的思路，不引入代码、权重、二进制或依赖。离线无训练模型条件下，采用可验证的规则+采样模拟方案。

所有新增实现自行编写，不复制以上项目的规则实现。

## 执行完成

2026-10-25：181 个新增场景、13 项 Worker 检查、原有回归及 1000 副留出对抗完成。团队头游率 63.6%，零非法动作。详见 `test/ai-upgrade-results.md`；小尺寸桌面及旧关闭特效断言的基线相同问题已单列记录。
