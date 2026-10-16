/* ====== 规则引擎：牌型识别、枚举、比较（纯函数，与界面/AI 无关） ======
 * 固定规则（竞技掼蛋口径）：
 *   牌型 single/pair/triple/fullhouse/straight/dpairs/steel/bomb/sflush/jokers
 *   顺子固定 5 张：A2345（A当1，最小）/ 23456 / ... / 10JQKA
 *   连对固定 3 对：AA2233 / 223344 / ... / QQKKAA
 *   钢板固定 2 组三张：AAA222 / 222333 / ... / KKKAAA
 *   自然级牌可按本来点数进入连续牌型；红桃配牌可补任意位置（含同花顺），不能替王
 *   炸弹：4/5 张 < 同花顺 < 6 张及以上炸弹；四王炸最大
 */
(function () {
  const GD = (window.GD = window.GD || {});

  /* ---------- 连续窗口定义（点序列） ---------- */
  // k=每个窗口点数
  function windows(k) {
    const out = [];
    if (k === 5) out.push({ ranks: [14, 2, 3, 4, 5], high: 5 }); // A2345
    if (k === 3) out.push({ ranks: [14, 2, 3], high: 3 });       // AA2233
    if (k === 2) out.push({ ranks: [14, 2], high: 2 });          // AAA222（A当1，最小）
    const maxStart = 14 - k + 1;
    for (let s = 2; s <= maxStart; s++) {
      const ranks = [];
      for (let r = s; r < s + k; r++) ranks.push(r);
      out.push({ ranks, high: s + k - 1 });
    }
    return out;
  }
  const W5 = windows(5);
  const W3 = windows(3);
  const W2 = windows(2);

  // 连续型适配（任意花色）。need=每点张数；返回全部合法 fit（用于歧义分析）
  function fitSeq(cards, need, wins, level) {
    const wilds = cards.filter((c) => GD.isWild(c, level));
    const non = cards.filter((c) => !GD.isWild(c, level));
    const cnt = {};
    for (const c of non) {
      if (c.rank > 14) return []; // 王只能以王炸形式出
      cnt[c.rank] = (cnt[c.rank] || 0) + 1;
    }
    const fits = [];
    for (const w of wins) {
      let wNeed = 0;
      let ok = true;
      for (const r of w.ranks) {
        const v = cnt[r] || 0;
        if (v > need) { ok = false; break; }
        wNeed += need - v;
      }
      if (!ok || wNeed !== wilds.length) continue;
      // 不得有窗口外的自然牌
      for (const r of Object.keys(cnt)) {
        if (w.ranks.indexOf(Number(r)) < 0) { ok = false; break; }
      }
      if (ok) fits.push({ high: w.high });
    }
    return fits;
  }

  // 同花顺适配（允许配牌补声明）
  function fitSflush(cards, level) {
    const wilds = cards.filter((c) => GD.isWild(c, level));
    const non = cards.filter((c) => !GD.isWild(c, level));
    if (!non.length) return [];
    const suit = non[0].suit;
    if (!suit || non.some((c) => c.suit !== suit || c.rank > 14)) return [];
    const cnt = {};
    for (const c of non) cnt[c.rank] = (cnt[c.rank] || 0) + 1;

    const fits = [];
    for (const w of W5) {
      let ok = true;
      let wNeed = 0;
      for (const r of w.ranks) {
        const v = cnt[r] || 0;
        if (v > 1) { ok = false; break; }
        wNeed += 1 - v;
      }
      if (!ok || wNeed !== wilds.length) continue;
      for (const r of Object.keys(cnt)) {
        if (w.ranks.indexOf(Number(r)) < 0) { ok = false; break; }
      }
      if (ok) fits.push({ high: w.high });
    }
    return fits;
  }

  /* ---------- 百搭映射：给出解释中每张红桃级牌的确定身份 ----------
   * 元素：{id, natural:true} 以级牌本点身份使用 | {id, rank} 代替该点 |
   *       {id, rank, suit} 同花顺中代替该花色该点
   * 仅描述实际"代替别的牌"的配牌；以本点身份参与时记 natural，不搞全量标记。
   * 配牌只有红桃两张，按 deck 序固定分配，保证同一解释映射唯一、可验证。
   */
  function seqWindow(type, high) {
    const wins = type === "straight" || type === "sflush" ? W5
      : type === "dpairs" ? W3 : type === "steel" ? W2 : null;
    return wins && wins.find((w) => w.high === high);
  }

  function buildMapping(p, level) {
    const wilds = p.cards
      .filter((c) => GD.isWild(c, level))
      .sort((a, b) => a.deck - b.deck);
    if (!wilds.length) return [];
    const non = p.cards.filter((c) => !GD.isWild(c, level));
    const cnt = {};
    for (const c of non) cnt[c.rank] = (cnt[c.rank] || 0) + 1;

    const used = new Set();
    const out = [];
    const takeWild = () => {
      for (const w of wilds) {
        if (!used.has(w.id)) { used.add(w.id); return w; }
      }
      return null;
    };
    // 配牌补入一个槽位；补的正是自身点数（同花顺时且同花）则按本点身份
    const fillSlot = (rank, suit) => {
      const w = takeWild();
      if (!w) return;
      if (rank === level && (!suit || suit === "H")) out.push({ id: w.id, natural: true });
      else {
        const m = { id: w.id, rank };
        if (suit) m.suit = suit;
        out.push(m);
      }
    };

    if (p.type === "single") {
      fillSlot(level); // 单张级牌本身
    } else if (p.type === "pair" || p.type === "triple") {
      const need = p.type === "pair" ? 2 : 3;
      const ranks = Object.keys(cnt).map(Number);
      const r = ranks.length ? ranks[0] : level; // 两张配牌自成级牌对
      for (let i = 0; i < need - (cnt[r] || 0); i++) fillSlot(r);
    } else if (p.type === "bomb") {
      const r = Number(Object.keys(cnt)[0]);
      for (let i = 0; i < p.size - (cnt[r] || 0); i++) fillSlot(r);
    } else if (p.type === "fullhouse") {
      const T = p.value === 15 ? level : p.value; // 三张主体点数
      const pairRanks = Object.keys(cnt).map(Number).filter((r) => r !== T);
      const P = pairRanks[0]; // 对子点数（王对时配牌不参与，缺口为0）
      for (let i = 0; i < 3 - (cnt[T] || 0); i++) fillSlot(T);
      if (P) for (let i = 0; i < 2 - (cnt[P] || 0); i++) fillSlot(P);
    } else {
      const win = seqWindow(p.type, p.value);
      if (!win) return [];
      if (p.type === "sflush") {
        const suit = non[0].suit;
        for (const r of win.ranks) if (!cnt[r]) fillSlot(r, suit);
      } else {
        const need = p.type === "straight" ? 1 : p.type === "dpairs" ? 2 : 3;
        for (const r of win.ranks) {
          for (let i = 0; i < need - (cnt[r] || 0); i++) fillSlot(r);
        }
      }
    }
    // 每张配牌必须有确定归属，否则该解释不挂半成品映射
    return out.length === wilds.length ? out : [];
  }

  /* ---------- 全部合法解释（歧义牌组返回多个） ---------- */
  function analyze(cards, level) {
    if (!Array.isArray(cards) || !cards.length) return [];
    const n = cards.length;
    const out = [];
    const add = (type, value) => {
      const p = { type, cards: cards.slice(), value, size: n };
      p.mapping = buildMapping(p, level);
      out.push(p);
    };

    // 四王炸：2 小 2 大
    if (n === 4 && cards.every((c) => c.rank >= 16)) {
      let s = 0, b = 0;
      for (const c of cards) (c.rank === 16 ? s++ : b++);
      if (s === 2 && b === 2) add("jokers", 1e12);
    }

    // 同花顺
    if (n === 5) {
      for (const f of fitSflush(cards, level)) add("sflush", f.high);
    }

    // 炸弹：非配牌同点（允许自然级牌点），配牌补足，≥4
    if (n >= 4) {
      const wilds = cards.filter((c) => GD.isWild(c, level));
      const non = cards.filter((c) => !GD.isWild(c, level));
      if (non.length >= 1 && non.every((c) => c.rank <= 14 && c.rank === non[0].rank)) {
        add("bomb", GD.cardWeight(non[0], level));
      }
    }

    // 三带二
    if (n === 5) {
      for (const v of fullhouseValues(cards, level)) add("fullhouse", v);
    }

    // 钢板（固定 6 张）
    if (n === 6) for (const f of fitSeq(cards, 3, W2, level)) add("steel", f.high);
    // 连对（固定 6 张）
    if (n === 6) for (const f of fitSeq(cards, 2, W3, level)) add("dpairs", f.high);
    // 顺子（固定 5 张）
    if (n === 5) for (const f of fitSeq(cards, 1, W5, level)) add("straight", f.high);

    // 三张 / 对子 / 单张
    if (n === 3) {
      const wilds = cards.filter((c) => GD.isWild(c, level));
      const non = cards.filter((c) => !GD.isWild(c, level));
      if (non.length >= 1 && non.every((c) => c.rank <= 14 && c.rank === non[0].rank)) {
        add("triple", GD.cardWeight(non[0], level));
      }
    }
    if (n === 2) {
      // 王对
      if (cards[0].rank >= 16 && cards[0].rank === cards[1].rank) add("pair", cards[0].rank);
      else {
        const wilds = cards.filter((c) => GD.isWild(c, level));
        const non = cards.filter((c) => !GD.isWild(c, level));
        if (non.length === 2 && non[0].rank === non[1].rank && non[0].rank <= 14) {
          add("pair", GD.cardWeight(non[0], level));
        } else if (non.length === 1 && non[0].rank <= 14) {
          add("pair", GD.cardWeight(non[0], level));
        } else if (!non.length && wilds.length === 2) {
          add("pair", GD.cardWeight(cards[0], level)); // 两张配牌按级牌对（15）
        }
      }
    }
    if (n === 1) add("single", GD.cardWeight(cards[0], level));

    return out;
  }

  function fullhouseValues(cards, level) {
    const wilds = cards.filter((c) => GD.isWild(c, level));
    const rest = cards.filter((c) => !GD.isWild(c, level));
    const cnt = {};
    let j16 = 0, j17 = 0;
    for (const c of rest) {
      if (c.rank === 16) j16++;
      else if (c.rank === 17) j17++;
      else cnt[c.rank] = (cnt[c.rank] || 0) + 1;
    }
    const W = wilds.length;
    const values = [];

    // 对子为大王对/小王对
    if (j16 === 2 || j17 === 2) {
      if (j16 + j17 === 2) {
        const ranks = Object.keys(cnt).map(Number);
        if (ranks.length === 1 && cnt[ranks[0]] >= 1 && cnt[ranks[0]] + W === 3) {
          values.push(GD.cardWeight({ rank: ranks[0] }, level));
        }
      }
      return values;
    }
    if (j16 || j17) return values;

    const ranks = Object.keys(cnt).map(Number);
    if (ranks.length > 2) return values;
    for (const t of ranks) {
      const wT = 3 - cnt[t];
      if (wT < 0 || wT > W) continue;
      const wLeft = W - wT;
      for (const p of ranks) {
        if (p === t) continue;
        const wP = 2 - cnt[p];
        if (wP >= 0 && wP <= wLeft) values.push(GD.cardWeight({ rank: t }, level));
      }
    }
    return values;
  }

  /* ---------- 主解释（最强） ---------- */
  const TYPE_PRIORITY = [
    "jokers", "sflush", "bomb", "fullhouse", "steel", "dpairs",
    "straight", "triple", "pair", "single",
  ];
  function strongest(interps) {
    return interps.slice().sort((a, b) => {
      const d = TYPE_PRIORITY.indexOf(a.type) - TYPE_PRIORITY.indexOf(b.type);
      if (d) return d;
      return generalScore(b) - generalScore(a);
    })[0];
  }
  function identify(cards, level) { return strongest(analyze(cards, level)) || null; }

  /* ---------- 提交解释：结合压牌目标选择 ---------- */
  function resolveSubmission(cards, target, level) {
    const interps = analyze(cards, level);
    if (!interps.length) return { ok: false, reason: "所选牌不构成任何合法牌型" };
    if (!target) return { ok: true, play: strongest(interps) };
    const valid = interps.filter((p) => beats(p, target));
    if (!valid.length) return { ok: false, reason: rejectionReason(interps, target) };
    return { ok: true, play: strongest(valid) };
  }

  // 拒绝原因：有同牌型同张数的解释即为点不够（不能因另一更强解释误称牌型不符）
  function rejectionReason(interps, target) {
    if (isBombType(target)) {
      if (interps.some(isBombType)) return "炸弹等级不够，压不过当前出牌";
      return "对方出的是炸弹，只能用炸弹/同花顺/四王炸接";
    }
    const sameType = interps.filter(
      (p) => !isBombType(p) && p.type === target.type && p.size === target.size);
    if (sameType.length) return "牌点不够大，压不过当前出牌";
    return `牌型不符：需要「${GD.TYPE_LABEL[target.type]}」${target.size} 张`;
  }

  /* ---------- 炸弹分（AI 与规则共用） ---------- */
  function bombScore(p) {
    if (p.type === "jokers") return 1e12;
    if (p.type === "sflush") return 5.5e6 + p.value * 10;
    if (p.type === "bomb") return p.size * 1e6 + p.value;
    return 0;
  }
  function generalScore(p) { return isBombType(p) ? bombScore(p) : p.value; }
  function isBombType(p) {
    return p.type === "bomb" || p.type === "sflush" || p.type === "jokers";
  }

  /* ---------- 比较 ---------- */
  function beats(p, t) {
    if (!t) return true;
    if (isBombType(p)) {
      if (isBombType(t)) return bombScore(p) > bombScore(t);
      return true;
    }
    if (isBombType(t)) return false;
    if (p.type !== t.type || p.size !== t.size) return false;
    return p.value > t.value;
  }

  /* ---------- 枚举（每个 play 为单一已验证解释） ---------- */
  const SUIT_ORDER = { S: 0, H: 1, D: 2, C: 3 };
  function cardOrder(a, b) {
    if (a.rank !== b.rank) return a.rank - b.rank;
    const sa = a.suit ? SUIT_ORDER[a.suit] : 9;
    const sb = b.suit ? SUIT_ORDER[b.suit] : 9;
    if (sa !== sb) return sa - sb;
    return a.deck - b.deck;
  }

  function enumerate(hand, level) {
    const byRank = {};
    const wilds = [];
    for (const c of hand) {
      if (GD.isWild(c, level)) wilds.push(c);
      else (byRank[c.rank] = byRank[c.rank] || []).push(c);
    }
    Object.values(byRank).forEach((a) => a.sort(cardOrder));
    wilds.sort(cardOrder);
    const W = wilds.length;
    const res = [];
    const push = (type, cs, value) => {
      const p = { type, cards: cs.slice(), value, size: cs.length };
      p.mapping = buildMapping(p, level);
      res.push(p);
    };

    // 单张
    for (const c of hand) push("single", [c], GD.cardWeight(c, level));

    // 对子/三张 r=2..14
    for (let r = 2; r <= 14; r++) {
      const pool = byRank[r] || [];
      for (let w = 0; w <= Math.min(1, W); w++) {
        if (pool.length >= 2 - w) {
          push("pair", pool.slice(0, 2 - w).concat(wilds.slice(0, w)),
            GD.cardWeight({ rank: r }, level));
        }
      }
      for (let w = 0; w <= Math.min(2, W); w++) {
        if (pool.length >= 3 - w) {
          push("triple", pool.slice(0, 3 - w).concat(wilds.slice(0, w)),
            GD.cardWeight({ rank: r }, level));
        }
      }
    }
    // 两张配牌的级牌对
    if (W >= 2) push("pair", wilds.slice(0, 2), GD.cardWeight(wilds[0], level));
    // 王对
    for (const r of [16, 17]) {
      if ((byRank[r] || []).length >= 2) push("pair", byRank[r].slice(0, 2), r);
    }

    // 炸弹 r=2..14
    for (let r = 2; r <= 14; r++) {
      const pool = byRank[r] || [];
      for (let w = 0; w <= W; w++) {
        for (let n = Math.max(1, 4 - w); n <= pool.length; n++) {
          push("bomb", pool.slice(0, n).concat(wilds.slice(0, w)),
            GD.cardWeight({ rank: r }, level));
        }
      }
    }

    // 四王炸
    if ((byRank[16] || []).length === 2 && (byRank[17] || []).length === 2) {
      push("jokers", byRank[16].concat(byRank[17]), 1e12);
    }

    // 顺子/连对/钢板
    function emitSeq(need, wins, type) {
      for (const win of wins) {
        const cs = [];
        let wUsed = 0;
        for (const r of win.ranks) {
          const pool = byRank[r] || [];
          const take = Math.min(need, pool.length);
          cs.push(...pool.slice(0, take));
          wUsed += need - take;
        }
        if (wUsed <= W) {
          push(type, cs.concat(wilds.slice(0, wUsed)), win.high);
        }
      }
    }
    emitSeq(1, W5, "straight");
    emitSeq(2, W3, "dpairs");
    emitSeq(3, W2, "steel");

    // 同花顺（含配牌补）
    for (const suit of GD.SUITS) {
      for (const win of W5) {
        const cs = [];
        let wUsed = 0;
        for (const r of win.ranks) {
          const c = (byRank[r] || []).find((x) => x.suit === suit);
          if (c) cs.push(c);
          else wUsed++;
        }
        if (wUsed <= W) {
          push("sflush", cs.concat(wilds.slice(0, wUsed)), win.high);
        }
      }
    }

    // 三带二
    const triples = res.filter((p) => p.type === "triple");
    for (const t of triples) {
      const nonT = t.cards.find((c) => !GD.isWild(c, level));
      if (!nonT) continue;
      const tRank = nonT.rank;
      const usedIds = new Set(t.cards.map((c) => c.id));
      const wLeft = wilds.filter((c) => !usedIds.has(c.id));
      for (let p = 2; p <= 14; p++) {
        if (p === tRank) continue;
        const pool = (byRank[p] || []).filter((c) => !usedIds.has(c.id));
        for (let w = 0; w <= Math.min(1, wLeft.length); w++) {
          if (pool.length >= 2 - w) {
            push("fullhouse",
              t.cards.concat(pool.slice(0, 2 - w)).concat(wLeft.slice(0, w)), t.value);
          }
        }
      }
      for (const p of [16, 17]) {
        const pool = (byRank[p] || []).filter((c) => !usedIds.has(c.id));
        if (pool.length >= 2) push("fullhouse", t.cards.concat(pool.slice(0, 2)), t.value);
      }
    }

    // 去重：同牌组+同解释只保留一个
    const seen = new Set();
    const out = [];
    for (const p of res) {
      const key = p.type + "|" + p.cards.map((c) => c.id).sort((a, b) => a - b).join(",");
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(p);
    }
    return out;
  }

  function findBeats(hand, target, level) {
    return enumerate(hand, level).filter((p) => beats(p, target));
  }

  GD.TYPE_LABEL = {
    single: "单张", pair: "对子", triple: "三张", fullhouse: "三带二",
    straight: "顺子", dpairs: "连对", steel: "钢板",
    bomb: "炸弹", sflush: "同花顺", jokers: "四王炸",
  };

  GD.rules = {
    analyze, identify, enumerate, findBeats, beats, isBombType,
    resolveSubmission, bombScore, strongest, seqWindow,
  };
})();
