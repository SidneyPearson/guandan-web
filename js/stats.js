/* ====== 本地战绩（v1.3） ======
 * 只按真实完成事件计数：单副结束（endHand）计头游/末游/炸弹；
 * 整场结束（matchEnd）计胜负与连胜；练习单独统计。
 * 以 matchId / handId 去重，刷新页面、重复渲染都不会重复计数。
 * 任何存储失败都静默降级，绝不阻塞出牌流程。
 */
(function () {
  const GD = (window.GD = window.GD || {});
  const KEY = "gd-stats-v1";
  const SEEN_CAP = 800; // 去重 ID 环形上限，避免无限增长

  function fresh() {
    return {
      v: 1,
      seenHands: [],
      seenMatches: [],
      match: { played: 0, won: 0, streak: 0, bestStreak: 0, head: 0, tail: 0, bombs: 0 },
      practice: { played: 0, won: 0, head: 0, tail: 0, bombs: 0 },
    };
  }

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return fresh();
      const d = JSON.parse(raw);
      if (!d || d.v !== 1 || !d.match || !d.practice ||
          !Array.isArray(d.seenHands) || !Array.isArray(d.seenMatches)) {
        return fresh();
      }
      return d;
    } catch (e) { return fresh(); }
  }

  function save(d) {
    try { localStorage.setItem(KEY, JSON.stringify(d)); } catch (e) { /* 配额/禁用存储均不阻塞 */ }
  }

  function remember(list, id) {
    if (list.indexOf(id) >= 0) return false;
    list.push(id);
    if (list.length > SEEN_CAP) list.splice(0, list.length - SEEN_CAP);
    return true;
  }

  // 本副内玩家（座位0）打出的炸弹类牌型数（只取公开日志）
  function playerBombs(state) {
    let n = 0;
    if (Array.isArray(state.log)) {
      for (const e of state.log) {
        if (e && e.kind === "play" && e.seat === 0 && e.play &&
            (e.play.type === "bomb" || e.play.type === "sflush" || e.play.type === "jokers")) {
          n++;
        }
      }
    }
    return n;
  }

  const stats = {
    KEY,
    load,
    save,
    fresh,

    // 单副结束：头游/末游/炸弹归入整场或练习桶（按 handId 去重）
    recordHand(state) {
      try {
        const r = state && state.handResult;
        const id = state && state.handId;
        if (!r || !id) return;
        const d = load();
        if (!remember(d.seenHands, id)) return;
        const bucket = state.mode === "practice" ? d.practice : d.match;
        if (r.order[0] === 0) bucket.head++;
        if (r.order[3] === 0) bucket.tail++;
        bucket.bombs += playerBombs(state);
        save(d);
      } catch (e) { /* 永不影响对局 */ }
    },

    // 整场/单副练习结束：胜负与连胜（按 matchId 去重）
    recordMatch(state) {
      try {
        if (!state || !state.matchId || state.matchWinner === null || state.matchWinner === undefined) return;
        const d = load();
        const tag = state.mode === "practice" ? "p:" + state.matchId : "m:" + state.matchId;
        if (!remember(d.seenMatches, tag)) return;
        const win = state.matchWinner === 0;
        if (state.mode === "practice") {
          d.practice.played++;
          if (win) d.practice.won++;
        } else {
          d.match.played++;
          if (win) {
            d.match.won++;
            d.match.streak++;
            d.match.bestStreak = Math.max(d.match.bestStreak, d.match.streak);
          } else {
            d.match.streak = 0;
          }
        }
        save(d);
      } catch (e) { /* 永不影响对局 */ }
    },

    // 重置需由界面先取得玩家确认
    reset() {
      try { localStorage.removeItem(KEY); } catch (e) {}
    },
  };

  GD.stats = stats;
})();
