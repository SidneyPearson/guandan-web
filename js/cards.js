/* 扑克牌模型：两副牌共 108 张
 * 自然点数：2=2, 3..10 同面, J=11, Q=12, K=13, A=14
 * 小王 rank=16，大王 rank=17；王 suit=null
 * suit：'S' 黑桃 'H' 红桃 'D' 方块 'C' 梅花
 */
(function () {
  const GD = (window.GD = window.GD || {});
  GD.SUITS = ["S", "H", "D", "C"];
  GD.SUIT_CHAR = { S: "♠", H: "♥", D: "♦", C: "♣" };
  GD.SUIT_NAME = { S: "黑桃", H: "红桃", D: "方块", C: "梅花" };
  GD.RANK_NAME = {
    2: "2", 3: "3", 4: "4", 5: "5", 6: "6", 7: "7", 8: "8", 9: "9", 10: "10",
    11: "J", 12: "Q", 13: "K", 14: "A", 16: "小王", 17: "大王",
  };
  GD.LEVEL_NAME = GD.RANK_NAME;

  GD.buildDeck = function () {
    const cards = [];
    let id = 0;
    for (let d = 0; d < 2; d++) {
      for (const s of GD.SUITS) {
        for (let r = 2; r <= 14; r++) {
          cards.push({ id: id++, deck: d, suit: s, rank: r });
        }
      }
      cards.push({ id: id++, deck: d, suit: null, rank: 16 });
      cards.push({ id: id++, deck: d, suit: null, rank: 17 });
    }
    return cards;
  };

  // 是否为红桃配牌（逢人配）：红桃 + 当前副唯一级牌
  GD.isWild = function (card, level) {
    return card.suit === "H" && card.rank === level;
  };

  // 比较权重：普通牌按自然点数（普通2最小=2），级牌=15（介于A=14与小王=16），小王16，大王17
  // 即 普通2 < 3 < … < A < 级牌 < 小王 < 大王；打2时2即级牌，打A时A即级牌
  GD.cardWeight = function (card, level) {
    if (card.rank === 16 || card.rank === 17) return card.rank;
    if (card.rank === level) return 15; // 级牌（打几几就是级牌）
    return card.rank;
  };
  GD.cardValue = GD.cardWeight;

  const SUIT_ORDER = { S: 0, H: 1, D: 2, C: 3 };

  // 手牌排序：按比较权重升序，同权按花色/副数
  GD.sortHand = function (hand, level) {
    hand.sort((a, b) => {
      const wa = GD.cardWeight(a, level);
      const wb = GD.cardWeight(b, level);
      if (wa !== wb) return wa - wb;
      const sa = a.suit ? SUIT_ORDER[a.suit] : 9;
      const sb = b.suit ? SUIT_ORDER[b.suit] : 9;
      if (sa !== sb) return sa - sb;
      return a.deck - b.deck;
    });
    return hand;
  };

  /* 一键理牌：抽出炸弹/同花顺/四王炸分组，其余为散牌。纯函数。
   * 返回 { order: 展示用牌序, groups: [{start,len,type,label}] }
   */
  GD.organizeGroups = function (hand, level) {
    const used = new Set();
    const raw = [];

    // 1) 物理同点炸弹（含级牌本身、红桃配牌作为该点物理成员）
    for (let r = 2; r <= 14; r++) {
      const cs = hand.filter((c) => c.rank === r);
      if (cs.length >= 4) {
        cs.sort((a, b) => {
          const sa = a.suit ? SUIT_ORDER[a.suit] : 9;
          const sb = b.suit ? SUIT_ORDER[b.suit] : 9;
          return sa - sb || a.deck - b.deck;
        });
        raw.push({ type: "bomb", label: "炸弹", cards: cs, rank: r });
        cs.forEach((c) => used.add(c.id));
      }
    }

    // 2) 四王炸
    const j16 = hand.filter((c) => c.rank === 16);
    const j17 = hand.filter((c) => c.rank === 17);
    if (j16.length === 2 && j17.length === 2) {
      raw.push({ type: "jokers", label: "四王炸", cards: j16.concat(j17), rank: 18 });
      j16.concat(j17).forEach((c) => used.add(c.id));
    }

    // 3) 同花顺：剩余牌按花色，允许 A2345 小顺，反复取最高可用 5 连（不使用配牌声明）
    const at = {};
    for (const c of hand) {
      if (used.has(c.id) || !c.suit || c.rank > 14) continue;
      (at[c.suit] = at[c.suit] || new Map()).set(c.rank, c);
    }
    for (;;) {
      let best = null;
      for (const suit of GD.SUITS) {
        const m = at[suit];
        if (!m) continue;
        // 普通窗口 2-3-4-5-6 ... 10-J-Q-K-A（高点越大越好）
        for (let s = 10; s >= 2; s--) {
          let ok = true;
          for (let r = s; r < s + 5; r++) if (!m.has(r)) { ok = false; break; }
          if (ok && (!best || s + 4 > best.high)) best = { suit, s, high: s + 4 };
        }
      }
      if (!best) break;
      const m = at[best.suit];
      const cs = [];
      for (let r = best.s; r < best.s + 5; r++) {
        cs.push(m.get(r));
        m.delete(r);
      }
      raw.push({ type: "sflush", label: "同花顺", cards: cs, rank: best.high });
      cs.forEach((c) => used.add(c.id));
    }

    // 4) 散牌 + 分组排列：同花顺 → 炸弹（张数/点数）→ 四王炸
    const loose = hand.filter((c) => !used.has(c.id));
    GD.sortHand(loose, level);

    const sflush = raw.filter((g) => g.type === "sflush").sort((a, b) => a.rank - b.rank);
    const bombs = raw
      .filter((g) => g.type === "bomb")
      .sort((a, b) =>
        a.cards.length - b.cards.length ||
        GD.cardWeight(a.cards[0], level) - GD.cardWeight(b.cards[0], level));
    const jokers = raw.filter((g) => g.type === "jokers");

    const orderedGroups = sflush.concat(bombs).concat(jokers);
    const order = loose.slice();
    const groups = [];
    for (const g of orderedGroups) {
      groups.push({ start: order.length, len: g.cards.length, type: g.type, label: g.label });
      order.push(...g.cards);
    }
    return { order, groups };
  };
})();
