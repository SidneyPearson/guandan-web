# AI 决策系统（1.23.1）

电脑和玩家托管使用同一套 `GD.ai.decideAsync(state, seat, options)`，难度直接取当前对局。现有四人布局、纵向堆叠、出牌动画、进贡/还贡流程和存档格式保持兼容。

## 决策流程

1. `game.observe.build` 只导出自己手牌、公开牌史、四家余牌数、墩面、名次和公开贡还；其他手牌为只允许读张数的密封代理。`observe.serialize` 使用白名单，Worker 消息中没有 `state` 或其他玩家的 `hands`。
2. `rules.enumerate` 完整生成实体牌组合及其不同解释。包括所有实体对子/三张/炸弹、每种炸弹张数、连续窗口、全部自然牌子集、两张逢人配的分配、已有自然牌时主动使用配牌的拆法。去重键包含牌型、解释值和实体 ID。
3. 根据 `resolveSubmission` 的最强可用解释规范化动作。跟牌始终包括 `pass`；领出禁止 `pass`。完全相同点数与花色的两副牌才按对称性合并，花色不同的拆法继续保留。
4. 复用结构束搜索，评估剩余手数、散张、对子、三张、三带二、连续型、炸弹及配牌损失。昂贵的局部重组只处理结构预筛前 64 个动作，加上每种牌型的重要极值；完整枚举发生在裁剪之前。困难模式对剩余不超过 10 张的自身路线计算精确最少手数。
5. 规则策略保留报单/报双阻断、炸弹控权收尾、队友牌权保护与接风。开局更珍惜炸弹；残局增加送队友、公开大牌与团队名次的权重。安全且只剩一两张的队友掌墩时，保留规则让牌决定，避免少量模拟噪声抢其牌权。
6. `ai-memory` 从 108 张物理牌减去自身与公开已出牌，重建未知牌池。硬约束是各家张数和已公开贡还归属。最近的过牌仅对候选世界做软似然加权；队友掌墩时的过牌几乎不提供“没有大牌”的证据。解释历史时把其之后打出的牌补回，避免用当前残手误判当时行为。
7. `ai-search` 在独立采样的世界中比较候选。所有候选共享同一批世界，跟牌保留 pass、重要炸弹和规则首选。仅完整完成一轮候选比较后累计样本；截止时未完成的轮次丢弃。模拟演员只拿本座采样手牌、公开余牌数和墩面，不能查看模拟对手手牌来作弊选招。
8. 模拟复用 `game.js` 的实际出牌、过牌、接风和结算状态推进，关闭存档与战绩副作用。结果按头游与团队升级收益评价，双方包揽前两名直接给双下价值；到步数上限时采用团队剩余结构和牌权估值。rollout 使用有界的代表动作策略，不在每个模拟节点运行完整高成本搜索。
9. 最终实体牌再次经规则解析，并在主线程检查归属、重复 ID 与牌型后交给 `game.act`。Worker 失败、非法返回或超时使用规则备选；UI 再检查回合上下文，暂停、换局或取消托管后的旧结果不能出手。

## 1.23.1：五张收尾与多炸弹散单

`GD.ai.guardActions` 是规则推荐和 rollout 共用的战术检查，先在完整合法动作生成后执行，再允许模拟选择。短预算规则备选、提示、简单模式以及困难模式都遵守它，模拟不能重新选回被排除的危险动作。

- 自己的下家是仅剩五张的对手时，检查公开未知牌池是否还存在能反压这手五张牌的合法解释；同一组配牌的高低顺解释也会恢复检查。有安全替代动作时，不给该对手直接接走三带二等五张牌的机会。自己本手可以全部出完时仍立即出完；公开信息已证明无法反压时仍允许三带二。
- 多炸弹资产使用互不重叠的牌组计算，包括自然炸弹、配牌补炸、四王炸和同花顺。比较先保同点炸与先保同花顺两条路线，避免把同一批牌重复计成多颗炸弹，也避免为一颗四张炸拆掉三副同花顺。缓存最多 1024 个自身手牌组合。
- 有两颗以上炸弹时，普通出牌不能在有保留方案时削弱这些资产。常规局面下，少量散单优先清理，再用完整炸弹争取牌权；对手已经进入五张以内的残局时保留主动抢牌权选择，报单且低单会被接走时可以先出整炸。跟牌已有普通 A 可拦截时，不因模糊的反压可能性强行浪费炸弹。
- rollout 只从自身采样手牌和公开已出牌计算上述检查。模拟携带本次搜索开始时的公开已出牌集合，避免忘记此前已打出的高牌而重复推测。

`metrics.exitLanesRejected` 记录因直接收尾风险被排除的候选，`bombBreaksRejected` 记录拆弹候选数，`bombPlan: "clear-loose-first"` 表示本次启用先清散单的计划。专项验证命令为 `node test/ai-tactical-safety.cjs` 与 `node test/browser/ai-tactical-safety.cjs`。

## 预算与运行方式

| 难度 | 搜索预算 | 每候选最大采样世界数 | 模拟候选上限 |
| --- | ---: | ---: | ---: |
| 简单 | 35 ms | 0 | 4 |
| 普通 | 80 ms | 4 | 4 |
| 困难 | 140 ms | 8 | 5 |

领出无法不要，所以超时仍返回合法领牌；跟牌可使用经过规则评分的备选。Worker 先发送规则结果，再做模拟；主线程在预算加 100 ms 的启动/消息余量后终止超时 Worker。单次同步枚举不可中途抢占，`budgetMs` 是协作式搜索预算；浏览器 Worker 的外部计时器负责隔离极端耗时。

HTTP/HTTPS 使用 `ai-worker.js`。双击 `index.html` 时使用 Blob Worker，载荷由 `tools/build-ai-worker.cjs` 将同一份规则、AI 和游戏源码打包到 `js/ai-worker-source.js`，没有第二套策略。无 Worker 或浏览器拒绝 Blob 时自动使用有界规则策略。手机离线缓存包含完整脚本集。

配置不改 UI，也不改变已保存的游戏设置：

```js
GD.ai.configure({ budgetMs: 100, samples: 6, maxCandidates: 5 });
// 单次覆盖，也可以传 AbortSignal：
const decision = await GD.ai.decideAsync(state, seat, {
  budgetMs: 160, samples: 10, maxPlies: 48, seed: 12345
});
console.log(decision.metrics);
```

`maxPlies` 默认开局/中局 16 步、残局 48 步；不是无限模拟。`metrics` 包含阶段、完整枚举数、结构候选数、采样数、rollout 数、步数、终局数、耗时和超时/回退原因。`samples` 是完成的共同世界数，不能解释成胜率。

修改被打包的 JS 后执行 `node tools/build-ai-worker.cjs`。`node tools/build-dist.js` 也会自动重建载荷；测试会拒绝过期的生成文件。提示按钮复用同一规则推荐，使用 12 ms 预算并关闭模拟，避免主线程执行复杂搜索。

## 验证命令

```bash
node test/ai-upgrade.cjs
node test/ai-worker.cjs
node test/run-tests.js
node test/ai-cooperation.cjs
node test/ai-bomb-reserve.cjs
node test/ai-bomb-timing.cjs
node test/ai-endgame-control.cjs
node test/offline.cjs
node test/eval-ai-upgrade.cjs --pairs 500 --segment holdout --threads 3
node test/browser/ai-upgrade.cjs http://127.0.0.1:8898/
node test/browser/ai-upgrade.cjs file:///absolute/project/index.html
node tools/build-dist.js
```

对抗使用固定发牌、相同级牌/首发、交换双方座位的 500 种子对，共 1000 副单局。旧版困难 AI 及其枚举器固定在 `test/fixtures/ai-v1`，双方由同一实际规则引擎提交与结算。调参种子始于 7100001；留出种子始于 8100001。结果文件包括源码哈希、每副发牌/动作/名次和配对置信区间。完整升级赛及贡还另由现有回归覆盖。

## 参考和限制

- [guandan-assistant / montecarlo.ts](https://github.com/ckfhwph4pw-art/guandan-assistant/blob/c12eec85e05a7e2f2e94c8efaeb67f866bd5adff/src/engine/montecarlo.ts) 与 [moves.ts](https://github.com/ckfhwph4pw-art/guandan-assistant/blob/c12eec85e05a7e2f2e94c8efaeb67f866bd5adff/src/engine/moves.ts)：[MIT](https://github.com/ckfhwph4pw-art/guandan-assistant/blob/c12eec85e05a7e2f2e94c8efaeb67f866bd5adff/LICENSE)。参考共同采样场景与保留过牌思路；其连续长度规则不同，且过牌硬排除容易误判，本项目均未照搬。
- [Guandan-Poker-Platform / rollout.ts](https://github.com/mimaima699-ux/Guandan-Poker-Platform/blob/03dfbb684d3403bb045ba470005283b012ff12b4/packages/core/src/ai/rollout.ts)：[MIT](https://github.com/mimaima699-ux/Guandan-Poker-Platform/blob/03dfbb684d3403bb045ba470005283b012ff12b4/LICENSE)。参考观察→未知发牌→模拟→团队收益的边界。
- [DanLM](https://github.com/dashidhy/DanLM/tree/16ace5ada4db39086bb4c8ebb372ed16cb82fab1)：[许可证](https://github.com/dashidhy/DanLM/blob/16ace5ada4db39086bb4c8ebb372ed16cb82fab1/LICENSE) 在 Apache 2.0 基础上增加非商业限制。只研究公开历史表征与动作估值的思路，没有引入其代码、模型、权重或二进制。

这是有预算限制的蒙特卡洛策略改进，没有引入训练神经网络，也不宣称求得最优博弈解。手牌分解、行为似然和截断残局价值均有近似；不同设备的截止时间会影响完成样本数。测试中的相同种子、完整样本和注入时钟用于验证决策与真实暗牌分配无关。强弱结论以留出对抗结果为准。
