/* ====== 电脑玩家决策（v1.3：结构感知 / 配合 / 残局 / 信息边界） ======
 *
 * 唯一策略入口：
 *   GD.ai.recommend(obs, {tier, rng}) —— obs 由 GD.observe.build 生成，
 *       核心只读 obs，不接收 state、不读其他玩家手牌；
 *   GD.ai.decide(state, seat)         —— 旧流程/诊断兼容适配（内部转 recommend）；
 *   GD.ai.chooseGive / chooseReturn   —— 进贡/还贡的保结构选择（合法性仍由 game 判定）。
 *
 * 三档：
 *   easy   结构打分但不做局势判断，顶层候选注入随机；
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

  // 轻量残代价：只按同点分组（不调 enumerate）。供束搜索启发与出牌后估值——
  // 出牌触及的组留下的牌集中在同点，无法再凑 5 张连续型，同点拆分即精确。
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

  // 出牌后的整手代价：只重组被触及的组（轻量同点拆分），其余组代价沿用
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
    const restCost = localIds.size ? lightCost(localIds, level) : 0;
    const restSteps = localIds.size ? lightSteps(localIds, level) : 0;
    return {
      cost: D.cost - removedCost + restCost,
      steps: D.steps - touched + restSteps,
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

  // 本手是否拆了既有组（组比本手大、只取其中一部分）；本手之外是否还留着成型大组合
  function playFacts(D, play) {
    const ids = new Set(play.cards.map((c) => c.id));
    let splits = false;
    for (const g of D.groups) {
      let hit = false;
      for (const id of ids) if (g.ids.has(id)) { hit = true; break; }
      if (hit && g.ids.size > ids.size) { splits = true; break; }
    }
    const keepsComplex = D.groups.some((g) =>
      COMPLEX.indexOf(g.type) >= 0 && [...g.ids].every((id) => !ids.has(id)));
    return { splits, keepsComplex };
  }

  function leadCandidates(obs, D, tier, rng, metrics, budget) {
    const level = obs.level;
    const cands = rules.enumerate(obs.hand, level).map((p) => {
      const after = playAftermath(D, p, level);
      let s = after.cost + wildUsed(p, level) * 0.8;
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
        facts: Object.assign(playFacts(D, p), { restSteps: after.steps, exactG: null }) };
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
    const target = obs.target;
    const T = tier === "easy" ? 0 : threatLevel(obs);
    const partnerLeading = obs.targetSeat === obs.partner;
    const partnerN = obs.counts[obs.partner];
    const P = !partnerLeading ? 0 : partnerN <= 2 ? 1.6 : partnerN <= 5 ? 0.6 : 0;
    const minOppN = minOpponentCount(obs);

    const cands = [];
    for (const p of rules.findBeats(obs.hand, target, level)) {
      if (emptiesHand(obs.hand, p)) {
        cands.push({ action: "play", play: p, score: -1e9, tag: "goout",
          after: { cost: 0, steps: 0 }, facts: { restSteps: 0, exactG: null } });
        continue;
      }
      const after = playAftermath(D, p, level);
      let s = after.cost + wildUsed(p, level) * 0.8;
      if (isBomb(p)) {
        s += p.type === "jokers" ? 10 : p.type === "sflush" ? 6 : 4.5;
        if (after.steps <= 2) s -= 1.5;        // 炸后自己还能收
        else if (after.steps >= 7) s += 2.6;
        else if (after.steps >= 5) s += 1.6;
        s -= T * 0.9;
        if (partnerLeading) s += 3;            // 不炸队友
      } else {
        s += (p.value - target.value) * 0.12;
        s -= T * 0.9;
        if (partnerLeading) s += 1.0;
      }
      const bomb = isBomb(p);
      cands.push({
        action: "play", play: p, score: s, after,
        tag: bomb ? "bomb-block" : T >= 2.6 ? "block"
          : partnerLeading ? "cover-partner" : "beat",
        facts: Object.assign(playFacts(D, p), {
          restSteps: after.steps, exactG: null, minOppN, partnerN,
          canCollect: bomb && after.steps <= 2, // "炸后还能收"必须确有此事实
        }),
      });
    }
    const legalBeats = cands.length;
    // 非炸弹压法中整手代价最低者，才有资格说"代价最小"
    let cheapestAfter = Infinity;
    for (const c of cands) {
      if (!isBomb(c.play) && c.after.cost < cheapestAfter) cheapestAfter = c.after.cost;
    }
    for (const c of cands) {
      if (!isBomb(c.play)) c.facts.cheapest = c.after.cost <= cheapestAfter + 1e-9;
    }
    // 主动不要（跟牌的合法候选；领出不存在不要）
    const pass = { action: "pass", play: null, tag: "pass", score: 0, after: null,
      facts: { noLegal: legalBeats === 0, legalBeats, minOppN, partnerN } };
    if (partnerLeading) {
      pass.score = D.cost - 1.8 + T * 0.5 - P;
      pass.tag = P > 0 ? "partner-near" : "partner";
    } else {
      pass.score = D.cost + T;
      pass.tag = T >= 2.6 ? "danger-pass" : "pass";
    }
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
    const brief = playBrief(c.play, obs.level);
    switch (c.tag) {
      case "goout": return `本手可以全部出完：${brief}`;
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
    if (tier === "easy") {
      if (!obs.target) {
        const top = cands.filter((c) => c.action === "play" && c.score > -1e8).slice(0, 4);
        if (top.length > 1 && rng() < 0.4) pick = top[Math.floor(rng() * top.length)];
      } else {
        const plays = cands.filter((c) => c.action === "play");
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
