/* ====== 电脑玩家决策（v1.3：结构感知 / 配合 / 残局 / 信息边界） ======
 *
 * 唯一策略入口：
 *   GD.ai.recommend(obs, {tier, rng}) —— obs 由 GD.observe.build 生成，
 *       核心只读 obs，不接收 state、不读其他玩家手牌；
 *   GD.ai.decide(state, seat)         —— 旧流程/诊断兼容适配（内部转 recommend）；
 *   GD.ai.chooseGive / chooseReturn   —— 进贡/还贡的保结构选择（合法性仍由 game 判定）。
 *
 * 三档：
 *   easy   结构打分 + 基本残局拦截，非紧急局面的顶层候选注入随机；
 *   normal 完整结构代价 + 队友/威胁解析（确定性，平分稳定排序）；
 *   hard   在 normal 基础上增加残局精确路线搜索（仅自己手牌+官方枚举：
 *          出牌后剩 ≤10 张时，记忆化集合覆盖求“最少出牌动作数”校准候选）；
 *          不读隐藏牌、不做随机模拟，超界回退普通口径（始终给合法动作，记 metrics）。
 *
 * 时间预算（v1.3.1 修正）：deadline 一律为"绝对截止时刻"，可经 opts.now 注入
 *   单调时钟（默认 Date.now）；检查点在束搜索层间、候选生成后、精确路线查找之间，
 *   枚举等同步步骤本身不可打断（耗时计入 timeMs）。超时使用当前最佳合法候选：
 *   跟牌可降级"不要"，领出始终有合法出牌；metrics.timeoutStage 记录超时阶段。
 */
(function () {
  const GD = (window.GD = window.GD || {});
  const rules = GD.rules;

  const CARD_BY_ID = new Map(GD.buildDeck().map((c) => [c.id, c]));

  const COMPLEX = ["jokers", "sflush", "bomb", "fullhouse", "straight", "dpairs", "steel"];
  const isBomb = (p) => rules.isBombType(p);

  function nowMs() { return Date.now(); }

  // 一手"组"的基础塑形代价（越小越整；与最终得分同为"越小越好"）
  function groupCost(type, level, card0) {
    switch (type) {
      case "jokers": return 0.4;
      case "bomb": return 0.6;
      case "sflush": return 0.7;
      case "triple": return 0.7;
      case "fullhouse": return 0.8;
      case "straight":
      case "dpairs":
      case "steel": return 0.9;
      case "pair": return 1.0;
      case "wildsingle": return 1.6;
      case "single": {
        const r = card0.rank;
        return 2.0 + (r === 14 || r === level || r === 16 || r === 17 ? 0.5 : 0);
      }
      default: return 2.0;
    }
  }

  /* ---------- 单点 n 张的最优拆分（1散/2对/3三张/4炸，动态规划） ---------- */
  function rankPartition(n, rank, level) {
    const high = rank === 14 || rank === level;
    const one = 2.0 + (high ? 0.5 : 0);
    const dp = new Array(n + 1).fill(Infinity);
    const cut = new Array(n + 1).fill(0);
    dp[0] = 0;
    const parts = [
      { n: 1, c: one }, { n: 2, c: 1.0 },
      { n: 3, c: 0.7 }, { n: 4, c: 0.6 },
    ];
    for (let i = 1; i <= n; i++) {
      for (const pt of parts) {
        if (pt.n <= i && dp[i - pt.n] + pt.c < dp[i]) {
          dp[i] = dp[i - pt.n] + pt.c;
          cut[i] = pt.n;
        }
      }
    }
    const sizes = [];
    let i = n;
    while (i > 0) { const k = cut[i] || 1; sizes.push(k); i -= k; }
    return { cost: dp[n], sizes };
  }

  /* ---------- 残牌（不取任何连续/跨点成型组）分组与代价 ---------- */
  function residualGroups(idSet, level) {
    const byRank = {};
    const wilds = [];
    const groups = [];
    for (const id of idSet) {
      const c = CARD_BY_ID.get(id);
      if (GD.isWild(c, level)) wilds.push(c);
      else (byRank[c.rank] = byRank[c.rank] || []).push(c);
    }
    const naturalSingles = [];
    const pushG = (type, cs) => {
      const g = { type, cards: cs, ids: new Set(cs.map((c) => c.id)),
        cost: groupCost(type, level, cs[0]) };
      groups.push(g);
      return g;
    };
    for (let r = 2; r <= 17; r++) {
      const pool = byRank[r] || [];
      if (!pool.length) continue;
      if (r === 16 || r === 17) {
        for (let i = 0; i < pool.length; i += 2) {
          if (i + 1 < pool.length) pushG("pair", [pool[i], pool[i + 1]]);
          else naturalSingles.push(pushG("single", [pool[i]]));
        }
        continue;
      }
      const part = rankPartition(pool.length, r, level);
      let idx = 0;
      for (const k of part.sizes) {
        const cs = pool.slice(idx, idx + k);
        idx += k;
        const type = k === 1 ? "single" : k === 2 ? "pair" : k === 3 ? "triple" : "bomb";
        const g = pushG(type, cs);
        if (k === 1) naturalSingles.push(g);
      }
    }
    // 配牌先与最贵的自然散张配成对（散张 2.x + 配牌单 1.6 → 一对 1.0）
    naturalSingles.sort((a, b) => b.cost - a.cost || a.cards[0].id - b.cards[0].id);
    let w = wilds.length;
    for (const g of naturalSingles) {
      if (w <= 0) break;
      g.type = "pair";
      g.cards = g.cards.concat(wilds[--w]);
      g.ids = new Set(g.cards.map((c) => c.id));
      g.cost = groupCost("pair", level, g.cards[0]);
    }
    while (w >= 2) {
      const cs = [wilds[w - 1], wilds[w - 2]];
      w -= 2;
      pushG("pair", cs);
    }
    while (w > 0) pushG("wildsingle", [wilds[--w]]);
    return groups;
  }

  // 束搜索的轻量下层估值；跨组出牌留下的牌仍可能重新组成顺子、三带二等。
  function lightCost(idSet, level) {
    let c = 0;
    for (const g of residualGroups(idSet, level)) c += g.cost;
    return c;
  }
  function lightSteps(idSet, level) {
    return residualGroups(idSet, level).length;
  }

  /* ---------- 手牌拆解：束搜索选不重叠成型组，其余同点分组 ----------
   * 输出整手塑形代价（越小越好）与具体分组；节点/时间有界，超时返回当前最优。
   */
  function decompose(hand, level, opts) {
    opts = opts || {};
    const width = opts.width || 10;
    const nodeCap = opts.nodes || 1200;
    // deadline 为绝对截止时刻（与 now 同一时钟）；可注入时钟供受控测试
    const clock = typeof opts.now === "function" ? opts.now : nowMs;
    const deadline = opts.deadline != null ? opts.deadline : Infinity;
    const t0 = clock();

    const plays = rules.enumerate(hand, level);
    const allIds = hand.map((c) => c.id).sort((a, b) => a - b);

    const byIdCandidate = new Map();
    for (const p of plays) {
      if (COMPLEX.indexOf(p.type) < 0) continue;
      const idList = p.cards.map((c) => c.id).sort((a, b) => a - b);
      const rec = { type: p.type, ids: new Set(p.cards.map((c) => c.id)), idList,
        cards: p.cards, cost: groupCost(p.type, level, p.cards[0]) };
      for (const id of rec.ids) {
        if (!byIdCandidate.has(id)) byIdCandidate.set(id, []);
        byIdCandidate.get(id).push(rec);
      }
    }

    // g(covered)：covered 之外的牌全部按残牌计的代价（只取决于 covered 集合，记忆化）
    const gCache = new Map();
    const uncoveredCost = (ck, covered) => {
      const cached = gCache.get(ck);
      if (cached !== undefined) return cached;
      const ids = [];
      for (const id of allIds) if (!covered.has(id)) ids.push(id);
      const v = lightCost(new Set(ids), level);
      gCache.set(ck, v);
      return v;
    };
    const coveredKey = (set) => [...set].sort((a, b) => a - b).join(",");

    let nodes = 0;
    let timedOut = false;
    let bestKey = "";
    let bestF = Infinity;
    let bestChosen = [];

    const consider = (st) => {
      const ck = coveredKey(st.covered);
      const f = st.chosenCost + uncoveredCost(ck, st.covered);
      if (f < bestF - 1e-9) { bestF = f; bestKey = ck; bestChosen = st.chosen; }
    };

    const init = { covered: new Set(), reserved: new Set(), chosen: [], chosenCost: 0 };
    consider(init);
    let beam = [init];
    let depth = 0;
    let clockChecks = 0;
    const overBudget = () => (++clockChecks % 32 === 0) && clock() > deadline;
    while (beam.length && depth < hand.length) {
      nodes += beam.length;
      // 检查点：节点上限或绝对截止时刻（同一时钟，不再与 epoch 混用）
      if (nodes > nodeCap || clock() > deadline) { timedOut = true; break; }
      depth++;
      const next = [];
      for (const st of beam) {
        if (overBudget()) { timedOut = true; break; }
        const pivot = allIds.find((id) => !st.covered.has(id) && !st.reserved.has(id));
        if (pivot === undefined) { consider(st); continue; }
        // (a) 支点不进成型组（留给残牌）
        const r2 = new Set(st.reserved); r2.add(pivot);
        next.push({ covered: st.covered, reserved: r2, chosen: st.chosen, chosenCost: st.chosenCost });
        // (b) 覆盖支点的成型组（不与已覆盖/预留重叠）
        const cands = (byIdCandidate.get(pivot) || []).filter(
          (rec) => [...rec.ids].every((id) => !st.covered.has(id) && !st.reserved.has(id)));
        const dedup = new Map();
        for (const rec of cands) {
          const key = rec.type + "|" + rec.idList.join(",");
          if (!dedup.has(key)) dedup.set(key, rec);
        }
        let list = [...dedup.values()];
        // 分支有界：覆盖牌多、组代价低者优先（确定性，不用随机）
        list.sort((a, b) => b.idList.length - a.idList.length || a.cost - b.cost ||
          a.idList[0] - b.idList[0]);
        if (list.length > 8) list = list.slice(0, 8);
        for (const rec of list) {
          const cov = new Set(st.covered);
          for (const id of rec.ids) cov.add(id);
          next.push({ covered: cov, reserved: st.reserved,
            chosen: st.chosen.concat(rec), chosenCost: st.chosenCost + rec.cost });
        }
      }
      if (timedOut) break;
      // 评分 + 同局面合并 + 限宽（稳定排序，绝不在比较器里用随机）
      const scored = next.map((st) => {
        const ck = coveredKey(st.covered);
        return { st, ck, f: st.chosenCost + uncoveredCost(ck, st.covered) };
      });
      scored.sort((a, b) => (a.f - b.f) || (a.ck < b.ck ? -1 : a.ck > b.ck ? 1 : 0));
      const seen = new Set();
      const kept = [];
      for (const item of scored) {
        const rk = [...item.st.reserved].sort((x, y) => x - y).join(",");
        const k = item.ck + "/" + rk;
        if (seen.has(k)) continue;
        seen.add(k);
        kept.push(item.st);
        if (item.f < bestF - 1e-9) { bestF = item.f; bestKey = item.ck; bestChosen = item.st.chosen; }
        if (kept.length >= width) break;
      }
      beam = kept;
    }

    const groups = bestChosen.map((rec) => ({
      type: rec.type, cards: rec.cards.slice(), ids: new Set(rec.ids), cost: rec.cost,
    }));
    // 残牌 = 未被任何成型组覆盖的牌
    const residualIds = new Set();
    for (const id of allIds) {
      if (!groups.some((g) => g.ids.has(id))) residualIds.add(id);
    }
    for (const g of residualGroups(residualIds, level)) groups.push(g);
    const byType = {};
    for (const g of groups) byType[g.type] = (byType[g.type] || 0) + 1;
    return {
      groups, cost: groups.reduce((a, g) => a + g.cost, 0),
      steps: groups.length, byType, nodes, timedOut,
    };
  }

  // 重组被触及的组：跨组跟牌后，不能把剩下的连续牌一律当散张。
  // 只在这些剩牌中尝试一组成型牌，其余按同点分组；规模有界、同集合复用结果。
  function regroup(ids, level) {
    let best = { cost: lightCost(ids, level), steps: lightSteps(ids, level) };
    if (ids.size < 5) return best;
    const cards = [...ids].map((id) => CARD_BY_ID.get(id));
    for (const p of rules.enumerate(cards, level)) {
      if (COMPLEX.indexOf(p.type) < 0) continue;
      const rest = new Set(ids);
      for (const c of p.cards) rest.delete(c.id);
      const cost = groupCost(p.type, level, p.cards[0]) + lightCost(rest, level);
      const steps = 1 + lightSteps(rest, level);
      if (cost < best.cost - 1e-9 || (Math.abs(cost - best.cost) < 1e-9 && steps < best.steps)) {
        best = { cost, steps };
      }
    }
    return best;
  }

  // 出牌后的整手代价：保留未触及的组，允许受影响的组重新组合。
  function playAftermath(D, play, level) {
    const playIds = new Set(play.cards.map((c) => c.id));
    let removedCost = 0;
    const localIds = new Set();
    let touched = 0;
    for (const g of D.groups) {
      let hit = false;
      for (const id of playIds) if (g.ids.has(id)) { hit = true; break; }
      if (!hit) continue;
      touched++;
      removedCost += g.cost;
      for (const id of g.ids) if (!playIds.has(id)) localIds.add(id);
    }
    if (!touched) return { cost: D.cost, steps: D.steps };
    if (!D.regroupCache) D.regroupCache = new Map();
    const key = [...localIds].sort((a, b) => a - b).join(",");
    let rest = D.regroupCache.get(key);
    if (!rest) { rest = regroup(localIds, level); D.regroupCache.set(key, rest); }
    return {
      cost: D.cost - removedCost + rest.cost,
      steps: D.steps - touched + rest.steps,
    };
  }

  function emptiesHand(hand, play) {
    if (play.cards.length !== hand.length) return false;
    const ids = new Set(play.cards.map((c) => c.id));
    return hand.every((c) => ids.has(c.id));
  }

  /* ---------- 局势：只看得到的余牌数 ---------- */
  function threatLevel(obs) {
    let m = 99;
    for (const s of obs.opponents) {
      const n = obs.counts[s];
      if (n > 0 && n < m) m = n;
    }
    if (m <= 1) return 5;
    if (m === 2) return 4;
    if (m <= 4) return 2.6;
    if (m <= 7) return 1.2;
    if (m <= 11) return 0.5;
    return 0;
  }

  /* ---------- 残局精确路线（仅 hard）：记忆化集合覆盖求最少出牌动作数 ----------
   * 只用自己手牌与官方枚举，不涉及任何隐藏信息。n ≤ 8 时状态上界 256，
   * 单次亚毫秒~毫秒级；超界返回 null，调用方回退 decompose 近似。
   */
  const EXACT_LIMIT = 10;
  const EXACT_STATE_CAP = 4000;
  // budget（可选）：{ now:()=>毫秒, deadline:绝对时刻, timedOut:布尔槽 }。
  // 状态访问超 4000 或越过截止时刻都返回 null，调用方回退近似口径。
  function minGroups(cards, level, budget) {
    const n = cards.length;
    if (n === 0) return 0;
    if (n > EXACT_LIMIT) return null;
    const idIndex = new Map();
    cards.forEach((c, i) => idIndex.set(c.id, i));
    const masks = [];
    for (const p of rules.enumerate(cards, level)) {
      let m = 0;
      for (const c of p.cards) m |= 1 << idIndex.get(c.id);
      masks.push(m);
    }
    // 单点优先枚举（剪枝更快），去重
    masks.sort((a, b) => (b.toString(2).replace(/0/g, "").length)
      - (a.toString(2).replace(/0/g, "").length) || a - b);
    const uniq = [...new Set(masks)];
    const memo = new Int16Array(1 << n).fill(-1);
    let visits = 0, aborted = false;
    const solve = (mask) => {
      if (mask === 0) return 0;
      if (memo[mask] >= 0) return memo[mask];
      if (++visits > EXACT_STATE_CAP) { aborted = true; return n + 1; }
      // 时间检查点：每 64 次状态访问看一次注入时钟（默认无 budget 则不查）
      if (budget && (visits & 63) === 0 && budget.now() > budget.deadline) {
        aborted = true;
        budget.timedOut = true;
        return n + 1;
      }
      let best = 127;
      for (const m of uniq) {
        if ((m & mask) === m) {
          const v = solve(mask ^ m) + 1;
          if (v < best) best = v;
        }
      }
      memo[mask] = best;
      return best;
    };
    const g = solve((1 << n) - 1);
    return aborted || g >= 127 ? null : g;
  }

  // 出牌后剩余手牌的精确最少动作数；非残局或超界返回 null
  function exactStepsAfter(obs, play, budget) {
    const used = new Set(play.cards.map((c) => c.id));
    const rest = obs.hand.filter((c) => !used.has(c.id));
    if (rest.length > EXACT_LIMIT) return null;
    return minGroups(rest, obs.level, budget);
  }

  /* ---------- 候选打分 ---------- */
  const ID = (p) => p.cards.map((c) => c.id).sort((a, b) => a - b).join(",");
  const wildUsed = (p, level) => p.cards.filter((c) => GD.isWild(c, level)).length;

  // 是否只取走某组的一部分，与本次总出牌张数无关。
  function playFacts(D, play) {
    const ids = new Set(play.cards.map((c) => c.id));
    let splits = false;
    for (const g of D.groups) {
      let hits = 0;
      for (const id of ids) if (g.ids.has(id)) hits++;
      if (hits > 0 && hits < g.ids.size) { splits = true; break; }
    }
    const keepsComplex = D.groups.some((g) =>
      COMPLEX.indexOf(g.type) >= 0 && [...g.ids].every((id) => !ids.has(id)));
    return { splits, keepsComplex };
  }

  // 规则枚举为同点牌选用固定实体牌。补入“先保留已成型组合，再枚举余牌”的
  // 合法候选，避免明明有富余对子，却总拿顺子/同花顺里的那一张去配对。
  function structuredPlays(obs, D) {
    const plays = [], seen = new Set();
    const add = (p) => {
      if (obs.target && !rules.beats(p, obs.target)) return;
      const key = p.type + "|" + ID(p);
      if (!seen.has(key)) { seen.add(key); plays.push(p); }
    };
    const enumerate = (hand) => { for (const p of rules.enumerate(hand, obs.level)) add(p); };
    enumerate(obs.hand);
    const protectedIds = new Set();
    for (const g of D.groups) {
      // 分组本身也是候选；最终解释与游戏提交保持一致。
      const r = rules.resolveSubmission(g.cards, obs.target, obs.level);
      if (r.ok) add(r.play);
      if (COMPLEX.indexOf(g.type) < 0) continue;
      for (const id of g.ids) protectedIds.add(id);
      enumerate(obs.hand.filter((c) => !g.ids.has(c.id)));
    }
    if (protectedIds.size) enumerate(obs.hand.filter((c) => !protectedIds.has(c.id)));
    return plays;
  }

  // 炸弹的控牌价值独立于最少手数：不能因“5 张炸弹拆成三张后仍是一组”
  // 就把拆弹当作免费减牌。6 张起能压同花顺，张数越大越应珍惜。
  const BOMB_RESERVE = [0, 0, 0, 0, 4.5, 6, 8.5, 11, 13.5, 16, 18.5];
  function bombReserve(hand, level) {
    const counts = new Array(18).fill(0);
    let wilds = 0;
    for (const c of hand) {
      if (GD.isWild(c, level)) wilds++;
      else counts[c.rank]++;
    }
    // 配牌最多两张；动态分配，不能把同一张配牌同时算进两颗炸弹。
    let dp = new Array(wilds + 1).fill(-Infinity); dp[0] = 0;
    for (let rank = 2; rank <= 14; rank++) {
      if (counts[rank] + wilds < 4) continue;
      const next = new Array(wilds + 1).fill(-Infinity);
      for (let used = 0; used <= wilds; used++) {
        if (!Number.isFinite(dp[used])) continue;
        for (let add = 0; add <= wilds - used; add++) {
          const n = counts[rank] + add;
          if (add && n < 4) continue;
          const value = n >= 4 ? BOMB_RESERVE[n] + (GD.cardWeight({ rank }, level) - 2) * .04 : 0;
          next[used + add] = Math.max(next[used + add], dp[used] + value);
        }
      }
      dp = next;
    }
    return Math.max(...dp) + (counts[16] === 2 && counts[17] === 2 ? 20 : 0);
  }

  function bombLoss(obs, play, reserve, after) {
    // 整炸已经有使用代价；一手出完优先。这里仅计算普通牌削弱炸弹的损失。
    if (isBomb(play) || play.cards.length === obs.hand.length || !reserve) return 0;
    const used = new Set(play.cards.map(c => c.id));
    const rest = obs.hand.filter(c => !used.has(c.id));
    const loss = Math.max(0, reserve - bombReserve(rest, obs.level));
    // 剩牌确实已成一手时，兼顾收尾效率，给合理的拆牌收官留出空间。
    return loss * (after.steps === 1 ? .3 : 1);
  }

  // 只判断公开信息下“报单/报双的对手是否可能一手接走”。未知牌池并不
  // 代表某家的实际手牌；这里只排除张数不符、绝对大牌等明确安全的情况。
  function mayFinishOver(obs, play, seat) {
    const n = obs.counts[seat];
    if ((n !== 1 && n !== 2) || play.size !== n ||
        play.type !== (n === 1 ? "single" : "pair")) return false;
    const own = new Set(obs.hand.map(c => c.id));
    const unknown = obs.unknownIds || Array.from(CARD_BY_ID.keys()).filter(id => !own.has(id));
    const counts = new Array(18).fill(0);
    let wilds = 0;
    for (const id of unknown) {
      const c = CARD_BY_ID.get(id);
      if (!c) continue;
      if (n === 1 && GD.cardWeight(c, obs.level) > play.value) return true;
      if (GD.isWild(c, obs.level)) wilds++;
      else counts[c.rank]++;
    }
    if (n === 1) return false;
    for (let rank = 2; rank <= 17; rank++) {
      if (rank === 15 || GD.cardWeight({ rank }, obs.level) <= play.value) continue;
      if (counts[rank] + (rank <= 14 ? wilds : 0) >= 2) return true;
    }
    return false;
  }

  function controlPressure(obs) {
    // 出完者的末手尚未被压时，下一墩可能由其对家接风，不能只看出牌者的 0 张。
    const controller = obs.counts[obs.targetSeat] > 0 ? obs.targetSeat : obs.floorSeat;
    const enemyN = obs.opponents.indexOf(controller) >= 0 ? obs.counts[controller] : 0;
    let dangerN = enemyN > 0 && enemyN <= 2 ? enemyN : 0;
    const pending = obs.pending || [];
    const upcoming = pending.slice(pending.indexOf(obs.seat) + 1);
    for (const seat of upcoming) {
      if (obs.opponents.indexOf(seat) >= 0 && mayFinishOver(obs, obs.target, seat)) {
        dangerN = dangerN ? Math.min(dangerN, obs.counts[seat]) : obs.counts[seat];
      }
    }
    const weight = dangerN ? 1 : enemyN === 3 ? .9 : enemyN === 4 ? .8 : enemyN === 5 ? .65 : 0;
    return { weight, dangerN, critical: dangerN > 0 };
  }

  function leadCandidates(obs, D, tier, rng, metrics, budget) {
    const level = obs.level;
    const reserve = bombReserve(obs.hand, level);
    const cands = structuredPlays(obs, D).map((p) => {
      const after = playAftermath(D, p, level);
      const loss = bombLoss(obs, p, reserve, after);
      let s = after.cost + loss + wildUsed(p, level) * 0.8;
      if (p.type === "jokers") s += 22;
      else if (p.type === "sflush") s += 10;
      else if (p.type === "bomb") s += 6;
      else if (p.type === "single") {
        // 领出散张越小越好；高散张/A/王留作控权，不轻易先扔
        s += Math.max(0, GD.cardWeight(p.cards[0], level) - 2) * 0.18;
      } else {
        for (const c of p.cards) {
          if (!GD.isWild(c, level)) s += Math.max(0, GD.cardWeight(c, level) - 2) * 0.02;
        }
      }
      if (["fullhouse", "straight", "dpairs", "steel"].indexOf(p.type) >= 0) s -= 0.2;
      const restN = obs.hand.length - p.cards.length;
      // 自己接近走完时优先多张成型组（单张不享此减分，避免把整组拆成散张领出）
      if (restN > 0 && restN <= 6 && p.cards.length >= 2) s -= 0.3 * p.cards.length;
      const tag = ["straight", "dpairs", "steel", "fullhouse", "bomb", "sflush", "jokers"]
        .indexOf(p.type) >= 0 ? "lead-group" : "dump";
      return { action: "play", play: p, score: s, tag, after,
        facts: Object.assign(playFacts(D, p), { bombLoss: loss, restSteps: after.steps, exactG: null }) };
    });
    cands.filter((c) => emptiesHand(obs.hand, c.play)).forEach((c) => {
      c.score = -1e9; c.tag = "goout";
    });
    // hard 专属：残局（出牌后剩 ≤10 张）用精确集合覆盖校准剩余动作数，
    // 分解近似乐观时上调代价、悲观时下调；只在接近的候选间作小步区分
    if (tier === "hard" && !budget.timedOut) {
      for (const c of cands) {
        if (c.tag === "goout") continue;
        const restN = obs.hand.length - c.play.cards.length;
        if (restN > 0 && restN <= EXACT_LIMIT) {
          const g = exactStepsAfter(obs, c.play, budget);
          if (budget.timedOut) { metrics.timedOut = true; metrics.timeoutStage = "exact"; break; }
          if (g != null) {
            metrics.lookups++;
            c.facts.exactG = g;
            c.score += (g - c.after.steps) * 0.9;
          }
        }
      }
    }
    // “炸弹 + 最后一手”不能只按最少手数排序：先送出小单/小对，可能让
    // 报单/报双的对手直接走掉。真正剩下一手且存在此风险时，先争牌权。
    if (!cands.some(c => c.tag === "goout")) {
      const finishes = [];
      for (const c of cands) {
        if (!isBomb(c.play) || c.after.steps !== 1) continue;
        const used = new Set(c.play.cards.map(card => card.id));
        const rest = obs.hand.filter(card => !used.has(card.id));
        if (rest.length > 2) continue;
        const tail = rules.identify(rest, level);
        const danger = tail ? obs.opponents.find(seat => mayFinishOver(obs, tail, seat)) : undefined;
        if (danger !== undefined) {
          c.tag = "control-finish";
          c.facts.criticalControl = true;
          c.facts.dangerN = obs.counts[danger];
          finishes.push(c);
        }
      }
      if (finishes.length) {
        const best = finishes.reduce((a, b) => a.score <= b.score ? a : b);
        best.score = Math.min(best.score, Math.min(...cands.map(c => c.score)) - 1);
      }
    }
    return cands;
  }

  function minOpponentCount(obs) {
    let m = 99;
    for (const s of obs.opponents) {
      const n = obs.counts[s];
      if (n > 0 && n < m) m = n;
    }
    return m === 99 ? null : m;
  }

  function followCandidates(obs, D, tier, rng, metrics, budget) {
    const level = obs.level;
    const reserve = bombReserve(obs.hand, level);
    const target = obs.target;
    const T = tier === "easy" ? 0 : threatLevel(obs);
    const partnerLeading = obs.targetSeat === obs.partner;
    const partnerN = obs.counts[obs.partner];
    const P = !partnerLeading ? 0 : partnerN <= 2 ? 1.6 : partnerN <= 5 ? 0.6 : 0;
    const minOppN = minOpponentCount(obs);
    const pressure = controlPressure(obs);

    const cands = [];
    for (const p of structuredPlays(obs, D)) {
      if (emptiesHand(obs.hand, p)) {
        cands.push({ action: "play", play: p, score: -1e9, tag: "goout",
          after: { cost: 0, steps: 0 }, facts: { restSteps: 0, exactG: null, bombLoss: 0, structureCost: 0 } });
        continue;
      }
      const after = playAftermath(D, p, level);
      const facts = playFacts(D, p);
      facts.bombLoss = bombLoss(obs, p, reserve, after);
      const structureCost = after.cost + facts.bombLoss + wildUsed(p, level) * 0.8;
      let s = structureCost;
      if (isBomb(p)) {
        const useCost = p.type === "jokers" ? 10 : p.type === "sflush" ? 6 : 4.5;
        // 炸后只剩一手时，控牌正好用于收尾；不能因惜炸一直等、反而拆弹。
        // 对手已进入收尾时，炸弹的价值在于现在拦截，而不是留到自己最后。
        const spend = useCost * (after.steps === 1 ? .25 : after.steps === 2 ? .6 : 1);
        const fragmented = after.steps >= 7 ? 2.6 : after.steps >= 5 ? 1.6 : 0;
        s += spend + fragmented;
        facts.bombUrgencyBonus = (spend * .9 + fragmented) * pressure.weight;
        s -= T * 0.9;
        if (!partnerLeading && T >= 4) s -= 1.5;
        if (partnerLeading) s += 3 * (1 - pressure.weight);
      } else {
        s += (p.value - target.value) * 0.12;
        s -= T * 0.9;
        if (partnerLeading) s += 1.0;
      }
      // 队友还很长时，顺势走掉一张无须拆组的普通散牌；A、级牌、王与配牌
      // 留作控制，队友报单/报双及接风时继续让牌。不是一律接，也不是一律不要。
      const shedSingle = tier !== "easy" && partnerLeading && target.type === "single" &&
        p.type === "single" && !facts.splits && after.steps < D.steps &&
        !GD.isWild(p.cards[0], level) && GD.cardWeight(p.cards[0], level) < 14 &&
        (partnerN > 5 || (partnerN > 2 && obs.hand.length <= partnerN && after.steps <= 2));
      if (shedSingle) s -= 2.2;
      const bomb = isBomb(p);
      cands.push({
        action: "play", play: p, score: s, after,
        tag: shedSingle ? "shed-single" : bomb ? "bomb-block" : T >= 2.6 ? "block"
          : partnerLeading ? "cover-partner" : "beat",
        facts: Object.assign(facts, {
          restSteps: after.steps, exactG: null, minOppN, partnerN, structureCost,
          canCollect: bomb && after.steps <= 2, // "炸后还能收"必须确有此事实
        }),
      });
    }
    const legalBeats = cands.length;
    // 非炸弹压法中整手代价最低者，才有资格说"代价最小"
    let cheapestAfter = Infinity;
    for (const c of cands) {
      if (!isBomb(c.play) && c.facts.structureCost < cheapestAfter) cheapestAfter = c.facts.structureCost;
    }
    for (const c of cands) {
      if (!isBomb(c.play)) c.facts.cheapest = c.facts.structureCost <= cheapestAfter + 1e-9;
    }
    // 主动不要（跟牌的合法候选；领出不存在不要）
    const pass = { action: "pass", play: null, tag: "pass", score: 0, after: null,
      facts: { noLegal: legalBeats === 0, legalBeats, minOppN, partnerN } };
    const ordinaryBeats = cands.filter(c => !isBomb(c.play));
    // 有不拆组、不耗配牌的普通压法时仍优先正常控牌；不能把“及时出炸”
    // 变成“明明一张 A 能拦住也要炸”。只有缺少这种压法才减轻惜炸代价。
    const plainCover = ordinaryBeats.some(c => !c.facts.splits && !c.facts.bombLoss &&
      !wildUsed(c.play, level));
    if (!plainCover) {
      for (const c of cands) if (isBomb(c.play)) c.score -= c.facts.bombUrgencyBonus || 0;
    }
    pass.facts.protectBomb = !partnerLeading && ordinaryBeats.length > 0 &&
      ordinaryBeats.every(c => c.facts.bombLoss > 0);
    if (partnerLeading) {
      pass.score = D.cost - 1.8 + T * 0.5 - P;
      pass.tag = P > 0 ? "partner-near" : "partner";
    } else {
      pass.score = D.cost + T;
      pass.tag = T >= 2.6 ? "danger-pass" : "pass";
    }
    pass.score += pressure.weight * 2;
    cands.push(pass);

    // hard 专属残局判断
    if (tier === "hard") {
      // (1) 截喂桥：对手报单/报双，且当前出牌者正是其队友——这手牌大概率在喂牌，
      //     加权拦截、惩罚放过。只用公开余牌数与座位关系，不推断具体牌型。
      let cutFeed = 0, dangerN = 0;
      if (!partnerLeading) {
        let danger = -1;
        for (const op of obs.opponents) {
          if (obs.counts[op] > 0 && obs.counts[op] <= 2 &&
              (danger < 0 || obs.counts[op] < obs.counts[danger])) danger = op;
        }
        if (danger >= 0 && obs.targetSeat === (danger ^ 2)) {
          dangerN = obs.counts[danger];
          cutFeed = dangerN === 1 ? 2.2 : 1.2;
          if (target.size !== dangerN) cutFeed *= 0.5;
        }
      }
      if (cutFeed) {
        for (const c of cands) {
          if (c.action === "play" && c.tag !== "goout") {
            c.score -= cutFeed;
            c.facts.dangerN = dangerN;
            if (!isBomb(c.play)) c.tag = "cut-feed";
          }
        }
        pass.facts.dangerN = dangerN;
        pass.score += cutFeed;
      }
      // (2) 出牌后剩 ≤10 张：精确最少动作数修正近似分解
      if (!budget.timedOut) {
        for (const c of cands) {
          if (c.action !== "play" || c.tag === "goout") continue;
          const restN = obs.hand.length - c.play.cards.length;
          if (restN > 0 && restN <= EXACT_LIMIT) {
            const g = exactStepsAfter(obs, c.play, budget);
            if (budget.timedOut) { metrics.timedOut = true; metrics.timeoutStage = "exact"; break; }
            if (g != null) {
              metrics.lookups++;
              c.facts.exactG = g;
              c.score += (g - c.after.steps) * 0.9;
            }
          }
        }
      }
    }
    if (pressure.critical && legalBeats) {
      // 报单/报双者掌墩，或仍待跟牌且可能直接走完时，合法拦截优先于
      // 固定的惜炸/让队友分数。仍按结构代价选择压法，不强制用最大的炸。
      const plays = cands.filter(c => c.action === "play");
      pass.score = Math.max(pass.score, Math.min(...plays.map(c => c.score)) + 1);
      pass.facts.controlRisk = true;
      pass.facts.protectBomb = false;
      pass.facts.dangerN = pressure.dangerN;
      for (const c of plays) {
        c.facts.criticalControl = true;
        c.facts.dangerN = pressure.dangerN;
        if (c.tag === "goout" || c.tag === "cut-feed") continue;
        c.tag = partnerLeading ? "guard-partner" : isBomb(c.play) ? "bomb-block" : "block";
      }
    }
    return cands;
  }

  function comboName(play) { return GD.TYPE_LABEL[play.type] || play.type; }
  function rankWord(v, level) {
    if (v === 15) return GD.RANK_NAME[level] || "级牌";
    if (v === 16) return "小王";
    if (v === 17) return "大王";
    return GD.RANK_NAME[v] || String(v);
  }
  // 本手实际牌型的简短描述（来自 resolveSubmission 产出的 play，不猜牌）
  function playBrief(play, level) {
    const w = rankWord(play.value, level);
    switch (play.type) {
      case "single": return `单张 ${w}`;
      case "pair": return `对子 ${w}${w}`;
      case "triple": return `三张 ${w}${w}${w}`;
      case "bomb": return `${play.size} 张炸弹${play.value === 15 ? `（级牌 ${w}）` : ` ${w}`}`;
      case "jokers": return "四王炸";
      case "sflush": return "同花顺";
      case "fullhouse": return "三带二";
      case "straight": return `顺子（${w} 大）`;
      case "dpairs": return `三连对（${w} 大）`;
      case "steel": return `钢板（${w} 大）`;
      default: return comboName(play);
    }
  }
  // 只描述自己手牌覆盖，不宣称连续牌权或必胜
  function exactSuffix(c) {
    return c.facts && c.facts.exactG != null ? `（剩牌最少 ${c.facts.exactG} 手出完）` : "";
  }

  // 统一解释器：每句话只陈述本次候选上真实计算出的事实（牌型/合法压牌数/
  // 是否拆组/让队友/公开余牌数/剩余路线）。依据不足时给中性说明，不包装战术。
  function explain(c, obs, D) {
    const f = c.facts || {};
    if (c.action === "pass") {
      if (f.noLegal) {
        return `没有能压过${playBrief(obs.target, obs.level)}的合法牌，只能不要`;
      }
      if (f.controlRisk) return `对手仅剩 ${f.dangerN} 张，此时让过有失去拦截机会的风险`;
      if (f.protectBomb) return "普通压法都会削弱炸弹，当前跟牌代价更高，先保留炸弹";
      switch (c.tag) {
        case "partner": return "队友领牌，让路保持其牌权";
        case "partner-near": return `队友仅剩 ${f.partnerN} 张，让路助其先走`;
        case "cut-feed": // 截喂桥只改评分；若最终仍选择不要，按真实局势说明
          return `对手${f.dangerN === 1 ? "报单" : "报双"}，但压牌代价更大，本墩不要`;
        case "danger-pass":
          return `有 ${f.legalBeats} 种合法压法，但都要拆牌或代价过大，本墩不要`;
        default: return "跟牌代价过大，主动不要";
      }
    }
    const brief = playBrief(c.play, obs.level) + (f.bombLoss > 0 ? "（会削弱炸弹）" : "");
    switch (c.tag) {
      case "goout": return `本手可以全部出完：${brief}`;
      case "control-finish":
        return `对手${f.dangerN === 1 ? "报单" : "报双"}，先用${brief}争取牌权，再处理最后一手${exactSuffix(c)}`;
      case "lead-group":
        return `先出${brief}，减少手数${f.restSteps > 0 ? `，剩牌约 ${f.restSteps} 组` : ""}${exactSuffix(c)}`;
      case "dump": {
        // 说的必须是本手真实牌型：对子就是对子，不再统称"散张"
        const keep = f.keepsComplex ? "，成型大组合留着" : "";
        return `领出${brief}${keep}${exactSuffix(c)}`;
      }
      case "beat":
        return `跟${brief}${f.cheapest ? "，这手压牌代价最小" : ""}${exactSuffix(c)}`;
      case "cover-partner":
        return `队友领牌，用${brief}接管` +
          (f.restSteps < D.steps ? `，出牌后手牌更整（约 ${f.restSteps} 组）` : "") + exactSuffix(c);
      case "shed-single":
        return `顺着队友的单牌跟${brief}，走掉散张${f.keepsComplex ? "，保留成型组合" : ""}${exactSuffix(c)}`;
      case "guard-partner":
        return `对手${f.dangerN === 1 ? "报单" : "报双"}且还可跟牌，用${brief}防止其接走队友的牌${exactSuffix(c)}`;
      case "block":
        return `对手最少只剩 ${f.minOppN} 张，用${brief}拦截${exactSuffix(c)}`;
      case "cut-feed":
        return `对手${f.dangerN === 1 ? "报单" : "报双"}，截住其队友的喂桥牌：${brief}${exactSuffix(c)}`;
      case "bomb-block":
        // "炸后还能收"必须真有 after.steps<=2 的计算依据
        return `对手最少只剩 ${f.minOppN} 张，用${brief}拦截` +
          (f.canCollect ? `，炸后还能收（剩约 ${f.restSteps} 组）` : "") + exactSuffix(c);
      default:
        return `出${brief}`;
    }
  }

  /* ---------- 统一推荐 ---------- */
  let lastDecision = null;

  // 各阶段预算（毫秒，绝对时刻；真实机器上远用不完，只在受控/极端环境触发）
  const DECOMPOSE_MS = 30;
  const DECISION_MS = 50;

  function recommend(obs, opts) {
    opts = opts || {};
    const tier = opts.tier === "hard" || opts.tier === "easy" ? opts.tier : "normal";
    const rng = opts.rng || Math.random;
    // 可注入单调时钟（受控测试）；默认 Date.now
    const clock = typeof opts.now === "function" ? opts.now : nowMs;
    const t0 = clock();
    const metrics = { nodes: 0, lookups: 0, timedOut: false, fallback: false,
      timeoutStage: null, timeMs: 0, tier };
    // hard 精确路线共享的预算槽：越过截止时刻即置位并停止后续查找
    const budget = { now: clock, deadline: t0 + DECISION_MS, timedOut: false };

    let D;
    try {
      // 主分解两档同参同口径（加宽束搜索在对战评测中会改变代价尺度、净收益为负）；
      // hard 的增强放在残局精确路线校准（minGroups），不扰动中盘标定。
      // 注意：enumerate 在 decompose 内同步完成、不可中途打断，其耗时计入 timeMs。
      D = decompose(obs.hand, obs.level,
        { width: 10, nodes: 1200, deadline: t0 + DECOMPOSE_MS, now: clock });
      metrics.nodes = D.nodes;
      if (D.timedOut) { metrics.timedOut = true; metrics.timeoutStage = "decompose"; }
    } catch (e) {
      metrics.fallback = true;
      return emergency(obs, metrics, clock, t0);
    }

    let cands;
    try {
      // 候选生成（findBeats/enumerate 与评分）为同步步骤，检查点设在其完成之后
      cands = obs.target
        ? followCandidates(obs, D, tier, rng, metrics, budget)
        : leadCandidates(obs, D, tier, rng, metrics, budget);
      if (budget.timedOut && !metrics.timedOut) {
        metrics.timedOut = true; metrics.timeoutStage = "exact";
      }
      if (!metrics.timedOut && clock() > t0 + DECISION_MS) {
        metrics.timedOut = true; metrics.timeoutStage = "candidates";
      }
    } catch (e) {
      metrics.fallback = true;
      return emergency(obs, metrics, clock, t0);
    }
    if (!cands.length) {
      metrics.fallback = true;
      return emergency(obs, metrics, clock, t0);
    }

    const candKey = (c) => c.action === "pass" ? "9|pass" : "0|" + c.play.type + "|" + ID(c.play);
    cands.sort((a, b) => (a.score - b.score) || (candKey(a) < candKey(b) ? -1 : 1));

    let pick = cands[0];

    // easy：只在顶层少量候选里注入随机，绝不超出合法候选集合
    if (tier === "easy" && pick.tag !== "goout" && !pick.facts.criticalControl) {
      if (!obs.target) {
        const top = cands.filter((c) => c.action === "play" && !c.facts.bombLoss && c.score > -1e8).slice(0, 4);
        if (top.length > 1 && rng() < 0.4) pick = top[Math.floor(rng() * top.length)];
      } else {
        const plays = cands.filter((c) => c.action === "play" && !c.facts.bombLoss);
        const passC = cands.find((c) => c.action === "pass");
        if (plays.length && rng() < 0.35) {
          const top = plays.slice(0, Math.min(3, plays.length));
          pick = top[Math.floor(rng() * top.length)];
        } else if (passC && rng() < 0.15 && plays[0] && plays[0].tag !== "goout") {
          pick = passC;
        }
      }
    }

    metrics.timeMs = clock() - t0;
    const result = {
      action: pick.action,
      cards: pick.action === "play" ? pick.play.cards : null,
      play: pick.action === "play" ? pick.play : null,
      reason: pick.tag,
      // 首选与循环备选共用同一解释器，各自陈述本候选的真实事实
      text: explain(pick, obs, D),
      score: pick.score,
      candidates: cands.map((c) => ({
        action: c.action,
        cards: c.action === "play" ? c.play.cards : null,
        play: c.action === "play" ? c.play : null,
        score: c.score, tag: c.tag,
        text: explain(c, obs, D),
      })),
      metrics,
    };
    lastDecision = result;
    return result;
  }

  // 合法兜底：领出枚举第一个（最小单张方向）；跟牌不要。极端异常路径才走到。
  function emergency(obs, metrics, clock, t0) {
    const now = clock || nowMs;
    const level = obs.level;
    metrics.timeMs = now() - t0;
    if (!obs.target) {
      const p = rules.enumerate(obs.hand, level).sort(
        (a, b) => a.cards.length - b.cards.length || (ID(a) < ID(b) ? -1 : 1))[0];
      return { action: "play", cards: p.cards, play: p, reason: "fallback",
        text: "出牌", score: 0, candidates: [], metrics };
    }
    return { action: "pass", cards: null, play: null, reason: "fallback",
      text: "不要", score: 0, candidates: [], metrics };
  }

  /* ---------- 贡还保结构选择（候选合法性由 game 给出） ---------- */
  function chooseGive(hand, level, options) {
    if (options.length <= 1) return options[0];
    const D = decompose(hand, level, { width: 10, nodes: 900 });
    let best = null, bestCost = Infinity;
    for (const c of options) {
      const after = playAftermath(D, { cards: [c] }, level);
      const w = GD.cardWeight(c, level);
      if (after.cost < bestCost - 1e-9 ||
        (Math.abs(after.cost - bestCost) <= 1e-9 && best &&
          (w < GD.cardWeight(best, level) ||
            (w === GD.cardWeight(best, level) && c.id < best.id)))) {
        best = c; bestCost = after.cost;
      }
    }
    return best;
  }

  function chooseReturn(hand, level, candidates) {
    if (candidates.length <= 1) return candidates[0];
    const D = decompose(hand, level, { width: 12, nodes: 1200 });
    let best = null, bestDelta = Infinity;
    for (const c of candidates) {
      // 还出该牌的结构代价变化：越冗余（delta 越小）越优先还
      const delta = playAftermath(D, { cards: [c] }, level).cost - D.cost;
      const w = GD.cardWeight(c, level);
      if (delta < bestDelta - 1e-9 ||
        (Math.abs(delta - bestDelta) <= 1e-9 && best &&
          (w < GD.cardWeight(best, level) ||
            (w === GD.cardWeight(best, level) && c.id < best.id)))) {
        best = c; bestDelta = delta;
      }
    }
    return best;
  }

  GD.ai = {
    recommend,
    decompose,
    minGroups: (cards, level) => minGroups(cards, level),
    decide(state, seat, opts) {
      const obs = GD.observe.build(state, seat);
      const tier = (opts && opts.tier) ||
        (state.difficulty === "hard" || state.difficulty === "easy" ? state.difficulty : "normal");
      // 策略随机只来自独立种子（与洗牌/UI 等待隔离）：同 state 同决策，可重现
      const rng = GD.mulberry32(
        (((state.stratSeed || 1) ^ Math.imul(state.gen + 1, 7919) ^ Math.imul(seat + 1, 104729)) >>> 0));
      const r = recommend(obs, { tier, rng });
      return r.action === "pass"
        ? { pass: true, reason: r.reason, text: r.text, metrics: r.metrics }
        : { cards: r.cards, reason: r.reason, text: r.text, play: r.play, metrics: r.metrics };
    },
    chooseGive(state, seat) {
      return chooseGive(state.hands[seat], state.currentLevel,
        GD.game.tributeOptions(state, seat));
    },
    chooseReturn(state, pair) {
      const opts = GD.game.returnCandidates(state, pair).slice();
      const fb = GD.game.fallbackReturn(state, pair);
      if (fb && !opts.some((c) => c.id === fb.id)) opts.push(fb);
      return chooseReturn(state.hands[pair.to], state.currentLevel, opts);
    },
    getLastMetrics() { return lastDecision ? lastDecision.metrics : null; },
  };
})();
