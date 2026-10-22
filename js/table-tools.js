/* 牌桌展示与公开记牌：不读取其他玩家的手牌，不改动游戏状态。 */
(function () {
  const GD = window.GD;
  const seats = [
    { name: "你", side: "bottom" }, { name: "东家", side: "right" },
    { name: "对家", side: "top" }, { name: "西家", side: "left" },
  ];
  const deck = GD.buildDeck();

  function handView(hand, level, organized) {
    if (!organized) return { cards: GD.sortHand(hand.slice(), level).reverse(), groups: [] };
    const used = new Set(), bundles = [];
    const numbers = { 4: "四", 5: "五", 6: "六", 7: "七", 8: "八" };
    const descending = (cards) => GD.sortHand(cards.slice(), level).reverse();
    const add = (type, cards, rank, label) => {
      cards.forEach((c) => used.add(c.id));
      bundles.push({ type, cards, rank, label });
    };
    // 先保留现成炸弹，避免为补其他组而拆掉已经完整的牌型。
    for (let rank = 2; rank <= 14; rank++) {
      const cards = hand.filter((c) => c.rank === rank);
      if (cards.length >= 4) add("bomb", descending(cards), rank,
        (numbers[cards.length] || cards.length) + "炸");
    }
    const kings = hand.filter((c) => c.rank >= 16);
    if (kings.length === 4) add("jokers", descending(kings), 18, "四王炸");

    // 参考图中的「三个 6 + 红心配牌」：优先用一张配牌补三张，再用两张补对子。
    // 配牌保留真实牌面并放在该列最前方，不伪装成被代替的点数。
    const wilds = descending(hand.filter((c) => !used.has(c.id) && GD.isWild(c, level)));
    const candidates = [];
    for (let rank = 2; rank <= 14; rank++) {
      const cards = hand.filter((c) => !used.has(c.id) && c.rank === rank && !GD.isWild(c, level));
      if (cards.length === 2 || cards.length === 3) candidates.push({ rank, cards, need: 4 - cards.length });
    }
    candidates.sort((a, b) => a.need - b.need ||
      GD.cardWeight(b.cards[0], level) - GD.cardWeight(a.cards[0], level));
    for (const candidate of candidates) {
      if (wilds.length < candidate.need) continue;
      add("bomb", descending(candidate.cards).concat(wilds.splice(0, candidate.need)), candidate.rank, "四炸");
    }

    // 其余同花顺仍使用原来的纯函数识别；此处只改变展示，不改变 AI 或游戏状态。
    const rest = GD.organizeGroups(hand.filter((c) => !used.has(c.id)), level);
    for (const group of rest.groups) {
      if (group.type !== "sflush") continue;
      const cards = descending(rest.order.slice(group.start, group.start + group.len));
      add("sflush", cards, cards[0].rank, group.label);
    }
    const priority = { jokers: 3, bomb: 2, sflush: 1 };
    bundles.sort((a, b) => priority[b.type] - priority[a.type] || b.cards.length - a.cards.length ||
      (b.rank === level ? 15 : b.rank) - (a.rank === level ? 15 : a.rank));
    const cards = [], groups = [];
    for (const bundle of bundles) {
      groups.push({ start: cards.length, len: bundle.cards.length, type: bundle.type,
        label: bundle.label, rank: bundle.rank });
      cards.push(...bundle.cards);
    }
    const looseStart = cards.length;
    cards.push(...descending(hand.filter((c) => !used.has(c.id))));
    return { cards, groups, looseStart };
  }

  // 同点数/同一炸弹竖向叠放，列高由牌桌可用高度决定；分组与散牌保持独立。
  function stackLayout(items, options) {
    const { cardWidth: cw, cardHeight: ch, availableWidth, stepY,
      minStepX, maxStepX = cw + 6, maxRows = 4, keepFourTogether = false, keepFiveTogether = false,
      keepGroupsTogether = false,
      paddingTop = 32, paddingX = 10, gap = 12 } = options;
    if (!items.length) return { positions: [], width: 0, height: 0, columns: 0 };
    const columns = [];
    const limits = new Array(items.length).fill(maxRows);
    if (keepGroupsTogether || keepFourTogether || keepFiveTogether) {
      let start = 0;
      for (let end = 1; end <= items.length; end++) {
        const next = items[end], current = items[start];
        if (next && !next.break && (next.stack || String(next.rank)) === (current.stack || String(current.rank))) continue;
        const size = end - start;
        if (keepGroupsTogether || (size === 4 && keepFourTogether) || (size === 5 && keepFiveTogether))
          limits.fill(Math.max(size, maxRows), start, end);
        start = end;
      }
    }
    items.forEach((item, index) => {
      let col = columns[columns.length - 1];
      const key = item.stack || String(item.rank);
      if (!col || col.key !== key || col.items.length === limits[index] || item.break) {
        col = { key, items: [], gap: columns.length && item.break ? gap : 0 };
        columns.push(col);
      }
      col.items.push(index);
    });
    const rows = Math.max(...columns.map((c) => c.items.length));
    const layerStride = Math.max(maxRows, rows) + 1;
    const gaps = columns.reduce((sum, c) => sum + c.gap, 0);
    const avail = Math.max(cw, availableWidth - paddingX * 2);
    const stepX = columns.length === 1 ? cw : Math.max(minStepX,
      Math.min(maxStepX, (avail - cw - gaps) / (columns.length - 1)));
    const width = cw + (columns.length - 1) * stepX + gaps;
    let left = paddingX + Math.max(0, (avail - width) / 2);
    const positions = [];
    columns.forEach((col, columnIndex) => {
      left += col.gap;
      col.items.forEach((index, row) => {
        positions[index] = { left, top: paddingTop + (rows - col.items.length + row) * stepY,
          layer: columnIndex * layerStride + row + 1 };
      });
      left += stepX;
    });
    return { positions, columns: columns.length, width: width + paddingX * 2,
      height: paddingTop + ch + (rows - 1) * stepY + 8 };
  }

  // 只从完整双副牌中扣除自己的手牌和公开已出牌，按物理 id 去重。
  function remainingCounts(ownHand, playedCards) {
    const known = new Set(ownHand.concat(playedCards).map((c) => c.id));
    const counts = {};
    for (const card of deck) {
      if (!known.has(card.id)) counts[card.rank] = (counts[card.rank] || 0) + 1;
    }
    for (const card of deck) if (!(card.rank in counts)) counts[card.rank] = 0;
    return counts;
  }
  GD.tableTools = { seats, handView, stackLayout, remainingCounts };
})();
