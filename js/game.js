/* ====== 对局状态机：发牌、出牌流转、结算、升级、进贡、存档、观察对象 ======
 * 座位：0 你(南) / 1 西 / 2 北(队友) / 3 东；队伍 = seat % 2
 * 每副级牌 currentLevel = 上一副头游所在队伍升级后的累计级数（levelTeam 记录该队；第一副打2）
 */
(function () {
  const GD = (window.GD = window.GD || {});
  const SAVE_KEY = "gd-save-v3";
  const LEGACY_KEY = "gd-save-v2";
  const SET_KEY = "gd-settings-v1";
  const PRACTICE_KEY = "gd-practice-v1";

  const DEFAULT_SETTINGS = {
    difficulty: "normal",   // 电脑对手难度：easy/normal/hard
    autoStrategy: "hard",   // 托管策略：hard=稳健（默认）/ "follow"=跟随电脑难度
    sound: true,
    volume: 0.6,
    speed: "std",           // slow / std / fast
    fx: "full",             // 对战特效：full / simple / off
    reduceMotion: false,
  };

  /* ---------- 存档 ---------- */
  function classifyWriteError(e) {
    if (e && (e.name === "QuotaExceededError" || e.code === 22 || e.code === 1014)) {
      return "quota";
    }
    return "unavailable";
  }

  function writeKey(key, value) {
    try {
      localStorage.setItem(key, value);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: classifyWriteError(e) };
    }
  }

  const store = {
    lastSave: null,
    // 按模式分别存档：整场与练习互不覆盖
    save(state) {
      const result = writeKey(state.mode === "practice" ? PRACTICE_KEY : SAVE_KEY, JSON.stringify(state));
      store.lastSave = result;
      return result;
    },
    load() {
      let raw;
      try { raw = localStorage.getItem(SAVE_KEY); } catch (e) { return { error: "corrupt" }; }
      if (!raw) {
        try { if (localStorage.getItem(LEGACY_KEY)) return { error: "oldversion" }; }
        catch (e) {}
        return null;
      }
      return parseState(raw);
    },
    loadPractice() {
      let raw;
      try { raw = localStorage.getItem(PRACTICE_KEY); } catch (e) { return null; }
      if (!raw) return null;
      return parseState(raw);
    },
    hasRaw() {
      try {
        return !!localStorage.getItem(SAVE_KEY) || !!localStorage.getItem(LEGACY_KEY);
      } catch (e) { return false; }
    },
    hasPractice() {
      try { return !!localStorage.getItem(PRACTICE_KEY); } catch (e) { return false; }
    },
    clear() { try { localStorage.removeItem(SAVE_KEY); } catch (e) {} },
    clearPractice() { try { localStorage.removeItem(PRACTICE_KEY); } catch (e) {} },
    clearLegacy() { try { localStorage.removeItem(LEGACY_KEY); } catch (e) {} },
    loadSettings() {
      try {
        const saved = JSON.parse(localStorage.getItem(SET_KEY)) || {};
        return Object.assign({}, DEFAULT_SETTINGS, saved);
      } catch (e) { return Object.assign({}, DEFAULT_SETTINGS); }
    },
    saveSettings(s) { writeKey(SET_KEY, JSON.stringify(s || {})); },
  };
  GD.store = store;

  function parseState(raw) {
    let state;
    try { state = JSON.parse(raw); } catch (e) { return { error: "corrupt" }; }
    if (state && state.version < 3) return { error: "oldversion" };
    let valid = false;
    try { valid = validateState(state); } catch (e) { valid = false; }
    if (!valid) return { error: "corrupt" };
    return state;
  }

  /* ---------- 存档结构校验 ---------- */
  const PHASES = ["play", "handEnd", "tribute", "matchEnd"];
  const DECK_TEMPLATE = new Map(GD.buildDeck().map((c) => [c.id, c]));

  function isInt(v) { return typeof v === "number" && Number.isInteger(v); }
  function isSeat(v) { return isInt(v) && v >= 0 && v <= 3; }
  function isLevel(v) { return isInt(v) && v >= 2 && v <= 14; }

  function validCard(c) {
    if (!c || typeof c !== "object") return false;
    if (!isInt(c.id) || c.id < 0 || c.id > 107) return false;
    const t = DECK_TEMPLATE.get(c.id);
    if (!t) return false;
    return c.rank === t.rank && c.suit === t.suit && c.deck === t.deck;
  }
  function isPlayObject(p) {
    if (!p || typeof p !== "object" || typeof p.type !== "string") return false;
    if (!Array.isArray(p.cards) || !p.cards.length) return false;
    if (!isInt(p.size) || p.size !== p.cards.length) return false;
    if (!isInt(p.value)) return false;
    return p.cards.every(validCard);
  }
  // 日志中的牌型摘要（只有 type/value/size，不带牌引用）
  function isPlaySummary(p) {
    return !!p && typeof p === "object" && typeof p.type === "string" &&
      isInt(p.value) && isInt(p.size) && p.size > 0;
  }
  function samePlay(a, b) {
    return !!a && !!b && a.type === b.type && a.size === b.size && a.value === b.value;
  }
  function sameIdSet(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    const ids = new Set(a.map((c) => c.id));
    return ids.size === a.length && b.every((c) => ids.has(c.id));
  }

  function validateState(s) {
    if (!s || typeof s !== "object" || s.version !== 3) return false;
    if (typeof s.matchId !== "string" || !s.matchId) return false;
    if (typeof s.difficulty !== "string") return false;
    if (typeof s.paused !== "boolean" || typeof s.autoPilot !== "boolean" ||
        typeof s.organize !== "boolean") return false;
    if (!isInt(s.gen) || s.gen < 0) return false;
    if (s.mode !== undefined && s.mode !== "match" && s.mode !== "practice") return false;
    if (s.stratSeed !== undefined && (!isInt(s.stratSeed) || s.stratSeed < 0)) return false;
    if (s.handId !== undefined && (typeof s.handId !== "string" || !s.handId)) return false;

    if (!Array.isArray(s.levels) || s.levels.length !== 2) return false;
    for (const l of s.levels) if (!isLevel(l)) return false;
    if (s.levelTeam !== 0 && s.levelTeam !== 1) return false;
    if (s.currentLevel !== s.levels[s.levelTeam]) return false;

    if (PHASES.indexOf(s.phase) < 0) return false;
    if (!Array.isArray(s.hands) || s.hands.length !== 4) return false;
    if (!Array.isArray(s.table) || s.table.length !== 4) return false;
    if (!Array.isArray(s.pile)) return false;
    if (!Array.isArray(s.finished)) return false;

    const finSeen = new Set();
    for (const seat of s.finished) {
      if (!isSeat(seat) || finSeen.has(seat)) return false;
      finSeen.add(seat);
    }

    for (const h of s.hands) {
      if (!Array.isArray(h)) return false;
      for (const c of h) if (!validCard(c)) return false;
    }
    for (const c of s.pile) if (!validCard(c)) return false;

    for (const item of s.table) {
      if (item === null || item === "pass") continue;
      if (typeof item !== "object" || !Array.isArray(item.cards) || !item.cards.length) return false;
      for (const c of item.cards) if (!validCard(c)) return false;
      if (!isPlayObject(item.play)) return false;
      if (!sameIdSet(item.play.cards, item.cards)) return false;
      for (const c of item.play.cards) if (!validCard(c)) return false;
    }

    // 公开动作日志（v1.3 新增，旧档/测试 fixture 可缺省）：结构合法，
    // 且日志中出现过的牌集合必须恰好等于 弃牌堆+桌面 的全部牌（防编造/漏记）
    if (s.log !== undefined) {
      if (!Array.isArray(s.log)) return false;
      const logIds = new Set();
      for (const e of s.log) {
        if (!e || (e.kind !== "play" && e.kind !== "pass")) return false;
        if (!isSeat(e.seat)) return false;
        if (e.kind === "play") {
          if (!Array.isArray(e.ids) || !e.ids.length) return false;
          if (!isPlaySummary(e.play)) return false;
          if (e.play.size !== e.ids.length) return false;
          for (const id of e.ids) {
            if (!isInt(id) || id < 0 || id > 107 || logIds.has(id)) return false;
            logIds.add(id);
          }
        }
      }
      const onBoard = new Set();
      for (const c of s.pile) {
        if (onBoard.has(c.id)) return false;
        onBoard.add(c.id);
      }
      for (const item of s.table) {
        if (item && item !== "pass") {
          for (const c of item.cards) {
            if (onBoard.has(c.id)) return false;
            onBoard.add(c.id);
          }
        }
      }
      // 真实流程中日志打出的牌必在弃牌堆或桌面（子集；测试 fixture 可能把未用牌也放进 pile）
      for (const id of logIds) if (!onBoard.has(id)) return false;
    }

    // 最近一墩（可缺省）：结构 + 动作序列校验
    if (s.lastTrick !== undefined && s.lastTrick !== null) {
      if (!validateLastTrick(s.lastTrick, s)) return false;
    }

    if (s.phase === "play") {
      if (!validatePlayPhase(s)) return false;
    } else if (s.phase === "handEnd") {
      if (s.awaiting !== null || !validateHandResultData(s.handResult)) return false;
      const r = s.handResult;
      if (s.finished.length !== 4) return false;
      for (let i = 0; i < 4; i++) if (s.finished[i] !== r.order[i]) return false;
      if (r.level !== s.currentLevel) return false;
      if (!handResultMatchesLevels(r, s.levels)) return false;
    } else if (s.phase === "tribute") {
      if (s.awaiting !== null || !validateTribute(s)) return false;
    } else {
      if (s.awaiting !== null) return false;
      if (s.matchWinner !== 0 && s.matchWinner !== 1) return false;
      if (!validateHandResultData(s.handResult)) return false;
      if (s.mode === "practice") {
        // 练习模式：一副即终局，不升级不进贡，胜队为本副胜队
        if (s.matchWinner !== s.handResult.winTeam) return false;
        if (s.tribute !== null) return false;
        if (!handResultMatchesLevels(s.handResult, s.levels)) return false;
      } else {
        if (!s.handResult.passed) return false;
        if (s.matchWinner !== s.handResult.winTeam) return false;
        if (!handResultMatchesLevels(s.handResult, s.levels)) return false;
      }
    }

    // 实体牌守恒：手里 + 桌上 + 弃牌堆 + 进贡暂存牌 = 108 个唯一 id。
    const ids = new Set();
    const eat = (arr) => {
      for (const c of arr) {
        if (ids.has(c.id)) return false;
        ids.add(c.id);
      }
      return true;
    };
    for (const h of s.hands) if (!eat(h)) return false;
    for (const item of s.table) {
      if (item && item !== "pass") { if (!eat(item.cards)) return false; }
    }
    if (!eat(s.pile)) return false;
    const staged = stagedTributeCards(s);
    if (staged === null || !eat(staged)) return false;
    if (ids.size !== 108) return false;
    return true;
  }

  const trickActionKey = (e) => JSON.stringify({
    kind: e.kind, seat: e.seat,
    ids: e.kind === "play" ? e.ids.slice().sort((a, b) => a - b) : undefined,
    play: e.kind === "play"
      ? { type: e.play.type, value: e.play.value, size: e.play.size } : undefined,
  });
  function validateLastTrick(t, s) {
    if (typeof t !== "object" || !isSeat(t.winner)) return false;
    if (typeof t.jiefeng !== "boolean") return false;
    if (!Array.isArray(t.entries) || t.entries.length !== 4) return false;
    for (const e of t.entries) {
      if (e === null) continue;
      if (!isSeat(e.seat)) return false;
      if (e.pass === true) continue;
      if (!Array.isArray(e.ids) || !e.ids.length) return false;
      if (!isPlaySummary(e.play)) return false;
      for (const id of e.ids) if (!isInt(id) || id < 0 || id > 107) return false;
    }
    // actions 可缺省（旧档/测试 fixture）：缺省时以 entries 快照显示，UI 标注"仅保存结果"
    if (t.actions === undefined || t.actions === null) return true;
    if (!Array.isArray(t.actions) || !t.actions.length) return false;
    const seen = new Set();
    let lastPlaySeat = null;
    for (const a of t.actions) {
      if (!a || (a.kind !== "play" && a.kind !== "pass") || !isSeat(a.seat)) return false;
      if (a.kind === "play") {
        if (!Array.isArray(a.ids) || !a.ids.length) return false;
        if (!isPlaySummary(a.play) || a.play.size !== a.ids.length) return false;
        for (const id of a.ids) {
          if (!isInt(id) || id < 0 || id > 107 || seen.has(id)) return false;
          seen.add(id);
        }
        lastPlaySeat = a.seat;
      } else if (a.ids !== undefined) {
        return false;
      }
    }
    // 墩由最后一手出牌者赢下；t.winner 是下一墩领出者：赢墩者本手出完后，
    // 接风由对家领（jiefeng），对家也已走完时按顺位由下家领。
    if (lastPlaySeat !== t.winner) {
      if (!s || !Array.isArray(s.finished) || s.finished.indexOf(lastPlaySeat) < 0) return false;
      const isPartnerLead = t.winner === (lastPlaySeat ^ 2);
      if (t.jiefeng !== isPartnerLead) return false;
    } else if (t.jiefeng) {
      return false; // 领出者即赢墩者时不可能是接风
    }
    // 结果快照中的出牌必须都能在有序动作中找到（快照是动作的子集，允许同座位多次动作）
    for (const e of t.entries) {
      if (!e || e.pass === true) continue;
      for (const id of e.ids) if (!seen.has(id)) return false;
    }
    // 防跨墩混入：动作序列必须是 state.log 中一段连续子序列（同一步序、同一实体牌）
    if (s && Array.isArray(s.log)) {
      const needle = t.actions.map(trickActionKey);
      const hay = s.log.map(trickActionKey);
      let found = false;
      outer: for (let i = 0; i + needle.length <= hay.length; i++) {
        for (let j = 0; j < needle.length; j++) {
          if (hay[i + j] !== needle[j]) continue outer;
        }
        found = true; break;
      }
      if (!found) return false;
    }
    return true;
  }

  function validatePlayPhase(s) {
    const t = s.trick;
    if (!t || typeof t !== "object") return false;
    if (!isSeat(t.floorSeat)) return false;
    // 本墩动作在 state.log 中的起点（v1.3.1 新增；旧档可缺省，缺省时该墩只存结果快照）
    if (t.startLogIndex !== undefined && t.startLogIndex !== null) {
      if (!isInt(t.startLogIndex) || t.startLogIndex < 0) return false;
      if (Array.isArray(s.log) && t.startLogIndex > s.log.length) return false;
    }
    if (!Array.isArray(t.pending)) return false;
    const pendSeen = new Set();
    for (const seat of t.pending) {
      if (!isSeat(seat) || pendSeen.has(seat)) return false;
      pendSeen.add(seat);
    }
    if (pendSeen.has(t.floorSeat)) return false;

    if (t.target === null) {
      if (t.targetSeat !== null) return false;
    } else {
      if (!isSeat(t.targetSeat)) return false;
      if (!isPlayObject(t.target)) return false;
      const item = s.table[t.targetSeat];
      if (!item || item === "pass" || !samePlay(item.play, t.target)) return false;
      if (!sameIdSet(item.cards, t.target.cards)) return false;
    }

    const aw = s.awaiting;
    if (!aw || typeof aw !== "object" || !isSeat(aw.seat)) return false;
    if (aw.kind === "lead") {
      if (t.target !== null || t.pending.length !== 0 || aw.seat !== t.floorSeat) return false;
    } else if (aw.kind === "follow") {
      if (t.target === null || !t.pending.length || aw.seat !== t.pending[0]) return false;
    } else return false;

    return s.hands[aw.seat].length > 0;
  }

  function validateHandResultData(r) {
    if (!r || typeof r !== "object") return false;
    if (!Array.isArray(r.order) || r.order.length !== 4) return false;
    const seen = new Set();
    for (const seat of r.order) {
      if (!isSeat(seat) || seen.has(seat)) return false;
      seen.add(seat);
    }
    if (r.winTeam !== 0 && r.winTeam !== 1) return false;
    if (!isInt(r.delta) || r.delta < 1 || r.delta > 3) return false;
    if (!isLevel(r.level)) return false;
    if (typeof r.passed !== "boolean" || typeof r.stuck !== "boolean") return false;
    if (r.passed && r.stuck) return false;
    if (!isLevel(r.oldLevel) || !isLevel(r.newLevel)) return false;
    if (!Array.isArray(r.levelsNext) || r.levelsNext.length !== 2) return false;
    for (const l of r.levelsNext) if (!isLevel(l)) return false;

    const winTeam = r.order[0] % 2;
    const oldLevels = [0, 0];
    oldLevels[winTeam] = r.oldLevel;
    oldLevels[1 - winTeam] = r.levelsNext[1 - winTeam];
    const c = settleHand(r.order, oldLevels);
    if (r.winTeam !== c.winTeam || r.delta !== c.delta) return false;
    if (r.passed !== c.passed || r.stuck !== c.stuck) return false;
    if (r.newLevel !== c.newLevel) return false;
    if (r.levelsNext[winTeam] !== c.levelsNext[winTeam]) return false;
    if (r.nextCurrentLevel !== c.nextCurrentLevel) return false;
    if (r.nextLevelTeam !== c.nextLevelTeam) return false;
    return true;
  }

  function handResultMatchesLevels(r, levels) {
    const c = settleHand(r.order, levels);
    return r.winTeam === c.winTeam && r.delta === c.delta &&
      r.oldLevel === c.oldLevel &&
      r.passed === c.passed && r.stuck === c.stuck &&
      r.newLevel === c.newLevel &&
      Array.isArray(r.levelsNext) &&
      r.levelsNext[0] === c.levelsNext[0] &&
      r.levelsNext[1] === c.levelsNext[1] &&
      r.nextCurrentLevel === c.nextCurrentLevel &&
      r.nextLevelTeam === c.nextLevelTeam;
  }

  function validateTribute(s) {
    const t = s.tribute;
    if (!t || typeof t !== "object") return false;
    if (typeof t.anti !== "boolean") return false;
    if (t.stage !== "give" && t.stage !== "return" && t.stage !== "done") return false;
    if (!Array.isArray(t.pairs) || t.pairs.length < 1 || t.pairs.length > 2) return false;
    if (!isInt(t.idx) || t.idx < 0 || t.idx > t.pairs.length) return false;

    const r = s.handResult;
    if (!validateHandResultData(r)) return false;
    if (s.levels[0] !== r.levelsNext[0] || s.levels[1] !== r.levelsNext[1]) return false;
    if (s.levelTeam !== r.winTeam) return false;
    if (t.anti) {
      if (t.stage !== "give" || t.idx !== 0) return false;
    } else if (t.stage === "return" && r.passed) {
      return false;
    }

    const double = t.pairs.length === 2;
    if (double !== (r.delta === 3)) return false;
    const order = r.order;

    for (let i = 0; i < t.pairs.length; i++) {
      const p = t.pairs[i];
      if (!p || typeof p !== "object") return false;
      if (p.from !== (double ? order[2 + i] : order[3])) return false;

      const given = t.stage === "give" ? i < t.idx : true;
      if (given) {
        if (!validCard(p.card)) return false;
      } else if (p.card !== null) return false;

      if (p.returnCard !== null && !validCard(p.returnCard)) return false;

      if (t.stage === "give") {
        if (p.returnCard !== null) return false;
        if (double ? p.to !== null : p.to !== order[0]) return false;
        if (t.anti && p.card !== null) return false;
      } else if (t.stage === "return") {
        if (double) {
          if (p.to !== order[0] && p.to !== order[1]) return false;
        } else if (p.to !== order[0]) return false;
        const returned = i < t.idx;
        if (returned) {
          if (!validCard(p.returnCard)) return false;
        } else if (p.returnCard !== null) return false;
      } else {
        // done：全部交换完成，记录保留到本副结束（供公开位置推断）
        if (double) {
          if (p.to !== order[0] && p.to !== order[1]) return false;
        } else if (p.to !== order[0]) return false;
        if (!validCard(p.returnCard)) return false;
      }
    }
    if (t.stage === "return" && double) {
      const tos = t.pairs.map((p) => p.to).sort();
      const expect = [order[0], order[1]].sort();
      for (let i = 0; i < 2; i++) if (tos[i] !== expect[i]) return false;
    }
    return true;
  }

  function stagedTributeCards(s) {
    if (s.phase !== "tribute") return [];
    const t = s.tribute;
    const out = [];
    if (t.stage === "give") {
      for (let i = 0; i < t.idx; i++) out.push(t.pairs[i].card);
    } else if (t.stage === "return") {
      for (let i = t.idx; i < t.pairs.length; i++) out.push(t.pairs[i].card);
    }
    for (const c of out) if (!validCard(c)) return null;
    return out;
  }

  /* ---------- 观察对象（AI 唯一信息边界；状态层产出密封视图） ---------- */
  // 其他座位手牌的密封代理：只能读 length；读元素/遍历方法直接抛错。
  function sealedHand(length, seat) {
    const target = [];
    return new Proxy(target, {
      get(t, prop) {
        if (prop === "length") return length;
        if (prop === "isSealed") return true;
        if (prop === "seat") return seat;
        throw new Error("隐藏手牌不可读（座位 " + seat + " 的 " + String(prop) + "）");
      },
      set() { throw new Error("隐藏手牌不可写"); },
      has() { return false; },
      ownKeys() { return ["length"]; },
      getOwnPropertyDescriptor(t, prop) {
        if (prop === "length") {
          return { configurable: true, enumerable: false, value: length, writable: false };
        }
        return undefined;
      },
    });
  }

  function seenIdsFromLog(log) {
    const ids = new Set();
    if (!Array.isArray(log)) return ids;
    for (const e of log) {
      if (e && e.kind === "play" && Array.isArray(e.ids)) {
        for (const id of e.ids) ids.add(id);
      }
    }
    return ids;
  }

  function tributeKnownIds(state) {
    const known = new Map(); // id -> seat
    if (!state || !state.tribute) return known;
    const t = state.tribute;
    if (!Array.isArray(t.pairs)) return known;
    t.pairs.forEach((p, i) => {
      if (!p) return;
      const exchanged = t.stage === "done" || (t.stage === "return" && i < t.idx);
      if (exchanged && p.card && typeof p.card.id === "number" &&
          p.to !== null && p.to !== undefined) {
        known.set(p.card.id, p.to);
      }
      if (exchanged && p.returnCard && typeof p.returnCard.id === "number" &&
          p.from !== null && p.from !== undefined) {
        known.set(p.returnCard.id, p.from);
      }
    });
    return known;
  }

  function buildObservation(state, seat) {
    const trick = state.trick || { target: null, targetSeat: null, floorSeat: null, pending: [] };
    const levels = Array.isArray(state.levels) ? state.levels : [2, 2];
    const counts = [0, 1, 2, 3].map((s) => (state.hands[s] || []).length);
    const hands = [null, null, null, null];
    for (let s = 0; s < 4; s++) {
      hands[s] = s === seat ? state.hands[s] : sealedHand(counts[s], s);
    }

    const log = Array.isArray(state.log) ? state.log : [];
    const seenIds = seenIdsFromLog(log);
    const tributeKnown = tributeKnownIds(state);

    const myIds = new Set((state.hands[seat] || []).map((c) => c.id));
    const unknownIds = [];
    for (const c of GD.buildDeck()) {
      if (myIds.has(c.id) || seenIds.has(c.id)) continue;
      unknownIds.push(c.id);
    }

    return Object.freeze({
      seat,
      team: seat % 2,
      mode: state.mode || "match",
      level: state.currentLevel,
      levels: Object.freeze([levels[0], levels[1]]),
      levelTeam: state.levelTeam || 0,
      hand: state.hands[seat],
      counts: Object.freeze(counts),
      hands: Object.freeze(hands),
      partner: seat ^ 2,
      opponents: [seat ^ 1, seat ^ 3],
      target: trick.target || null,
      targetSeat: trick.targetSeat === null || trick.targetSeat === undefined ? null : trick.targetSeat,
      floorSeat: trick.floorSeat,
      pending: Object.freeze((trick.pending || []).slice()),
      awaitingKind: state.awaiting ? state.awaiting.kind : null,
      finished: Object.freeze(Array.isArray(state.finished) ? state.finished.slice() : []),
      log: log.map((e) => Object.freeze(Object.assign({}, e))),
      lastTrick: state.lastTrick || null,
      seenIds: Object.freeze(seenIds),
      tributeKnown: Object.freeze(tributeKnown),
      unknownIds: Object.freeze(unknownIds),
      stratSeed: state.stratSeed || 0,
      gen: state.gen || 0,
    });
  }

  /* ---------- 开局 ---------- */
  function baseState(difficulty, mode) {
    return {
      version: 3,
      matchId: GD.uid(),
      handId: GD.uid(),
      difficulty: difficulty || "normal",
      mode: mode || "match",
      stratSeed: GD.hashSeed(),
      phase: "play",
      paused: false,
      autoPilot: false,
      organize: false,
      levels: [2, 2],
      levelTeam: 0,
      currentLevel: 2,
      hands: [[], [], [], []],
      table: [null, null, null, null],
      pile: [],
      finished: [],
      trick: null,
      awaiting: null,
      handResult: null,
      tribute: null,
      matchWinner: null,
      gen: 0,
      log: [],
      lastTrick: null,
    };
  }

  function newMatch(difficulty, opts) {
    opts = opts || {};
    const state = baseState(difficulty, "match");
    if (opts.stratSeed != null) state.stratSeed = opts.stratSeed >>> 0;
    // 仅供自动化验收（#demoa 钩子/评测脚本）：我方从指定级开打、对方保持 2 级
    if (opts.startLevel != null) {
      const lv = Math.max(2, Math.min(14, opts.startLevel >>> 0));
      state.levels = [lv, 2];
      state.levelTeam = 0;
      state.currentLevel = lv;
    }
    dealNextHand(state, opts.rand);
    const leader = opts.leader != null
      ? opts.leader
      : Math.floor((opts.leaderRand || Math.random)() * 4);
    beginHandPlay(state, leader);
    store.save(state);
    return state;
  }

  // 单副练习：同一副发牌规则，一副结束即终局，不升级不进贡；独立存档
  function newPractice(difficulty, opts) {
    opts = opts || {};
    const state = baseState(difficulty, "practice");
    if (opts.stratSeed != null) state.stratSeed = opts.stratSeed >>> 0;
    dealNextHand(state, opts.rand);
    const leader = opts.leader != null
      ? opts.leader
      : Math.floor((opts.leaderRand || Math.random)() * 4);
    beginHandPlay(state, leader);
    store.save(state);
    return state;
  }

  function dealNextHand(state, rand) {
    const deck = GD.shuffle(GD.buildDeck(), rand || Math.random);
    state.hands = [[], [], [], []];
    for (let i = 0; i < deck.length; i++) state.hands[i % 4].push(deck[i]);
    for (let s = 0; s < 4; s++) GD.sortHand(state.hands[s], state.currentLevel);
    state.table = [null, null, null, null];
    state.pile = [];
    state.finished = [];
    state.trick = null;
    state.awaiting = null;
    state.log = [];
    state.lastTrick = null;
    state.handId = GD.uid();
    state.tribute = null;
  }

  function beginHandPlay(state, leader) {
    state.phase = "play";
    if (!Array.isArray(state.pile)) state.pile = [];

    // 关墩前把桌上内容记成"最近一墩"（只用公开动作），并据旧墩判定接风
    let jiefeng = false, outSeat = null, hasContent = false;
    const entries = [null, null, null, null];
    for (let s = 0; s < 4; s++) {
      const item = state.table[s];
      if (item === "pass") { entries[s] = { seat: s, pass: true }; hasContent = true; }
      else if (item) {
        hasContent = true;
        entries[s] = {
          seat: s,
          ids: item.cards.map((c) => c.id),
          play: { type: item.play.type, value: item.play.value, size: item.play.size },
        };
      }
    }
    const oldTrick = state.trick;
    const oldTargetSeat = oldTrick ? oldTrick.targetSeat : null;
    if (oldTargetSeat !== null && hasContent) {
      outSeat = oldTargetSeat;
      jiefeng = state.finished.indexOf(oldTargetSeat) >= 0 && leader === (oldTargetSeat ^ 2);
    }

    // 本墩完整有序公开动作（v1.3.1）：从本墩起点切 state.log，
    // 同一座位多次出牌/不要都会保留；牌型摘要来自当次 resolveSubmission。
    // 旧档缺起点标记时 actions=null，UI 只显示 entries 快照并注明"仅保存结果"。
    let actions = null;
    if (oldTrick && Number.isInteger(oldTrick.startLogIndex) && Array.isArray(state.log)) {
      actions = state.log.slice(oldTrick.startLogIndex).map((e) =>
        e.kind === "play"
          ? { kind: "play", seat: e.seat, ids: e.ids.slice(),
              play: { type: e.play.type, value: e.play.value, size: e.play.size } }
          : { kind: "pass", seat: e.seat });
    }

    for (const item of state.table) {
      if (item && item !== "pass") state.pile.push.apply(state.pile, item.cards);
    }
    state.table = [null, null, null, null];
    if (hasContent) state.lastTrick = { winner: leader, jiefeng, outSeat, entries, actions };
    state.trick = { target: null, targetSeat: null, floorSeat: leader,
      pending: [], startLogIndex: Array.isArray(state.log) ? state.log.length : 0 };
    state.awaiting = { kind: "lead", seat: leader };
  }

  /* ---------- 出牌 / 不要 ---------- */
  function act(state, seat, cards) {
    if (state.paused) return { ok: false, reason: "游戏已暂停" };
    if (state.phase !== "play") return { ok: false, reason: "当前不是出牌阶段" };
    const aw = state.awaiting;
    if (!aw || aw.seat !== seat) return { ok: false, reason: "还没轮到你" };

    let play;
    if (cards && cards.length) {
      const checked = checkCardsArg(cards, state.hands[seat]);
      if (!checked.ok) return checked;
      const r = GD.rules.resolveSubmission(checked.cards, state.trick.target, state.currentLevel);
      if (!r.ok) return r;
      play = r.play;
    } else {
      if (aw.kind !== "follow") return { ok: false, reason: "首家出牌不能不要" };
    }

    if (!Array.isArray(state.log)) state.log = []; // 兼容无日志的旧档/fixture
    let event = null;
    if (play) {
      const ids = new Set(play.cards.map((c) => c.id));
      state.hands[seat] = state.hands[seat].filter((c) => !ids.has(c.id));
      sweepSuperseded(state);
      state.table[seat] = { cards: play.cards, play };
      state.log.push({
        kind: "play", seat,
        ids: play.cards.map((c) => c.id),
        play: { type: play.type, value: play.value, size: play.size },
      });
      event = applyPlay(state, seat, play);
    } else {
      state.table[seat] = "pass";
      state.log.push({ kind: "pass", seat });
      const idx = state.trick.pending.indexOf(seat);
      if (idx >= 0) state.trick.pending.splice(idx, 1);
      if (state.trick.pending.length === 0) {
        const outSeat0 = state.trick.targetSeat;
        const floor = state.trick.floorSeat;
        const jie = state.finished.indexOf(outSeat0) >= 0 && floor === (outSeat0 ^ 2);
        beginHandPlay(state, floor);
        if (jie) event = { type: "jiefeng", outSeat: outSeat0, seat: floor };
      } else {
        state.awaiting = { kind: "follow", seat: state.trick.pending[0] };
      }
    }
    state.gen++;
    const saved = store.save(state);
    // 动作摘要与提交同源：界面音效/评测日志直接读这里，不重新猜动作类型
    return {
      ok: true, saved, event,
      kind: play ? "play" : "pass",
      play: play ? { type: play.type, value: play.value, size: play.size } : null,
      seat,
    };
  }

  function checkCardsArg(cards, hand) {
    if (!Array.isArray(cards)) return { ok: false, reason: "出牌数据不合法" };
    const idSet = new Set();
    for (const c of cards) {
      if (!c || typeof c.id !== "number") return { ok: false, reason: "出牌数据不合法" };
      if (idSet.has(c.id)) return { ok: false, reason: "每张牌只能使用一次" };
      idSet.add(c.id);
    }
    const byId = new Map(hand.map((c) => [c.id, c]));
    const real = [];
    for (const c of cards) {
      const actual = byId.get(c.id);
      if (!actual) return { ok: false, reason: "存在不在你手牌中的牌" };
      real.push(actual);
    }
    return { ok: true, cards: real };
  }

  function sweepSuperseded(state) {
    if (!state.trick.target) return;
    for (const item of state.table) {
      if (item && item !== "pass") state.pile.push.apply(state.pile, item.cards);
    }
    state.table = [null, null, null, null];
  }

  function applyPlay(state, seat, play) {
    const trick = state.trick;
    trick.target = play;
    trick.targetSeat = seat;

    if (state.hands[seat].length === 0) state.finished.push(seat);

    const active = [0, 1, 2, 3].filter((s) => state.hands[s].length > 0);
    if (active.length === 1) {
      state.finished.push(active[0]);
      endHand(state);
      return;
    }

    let floor;
    if (active.indexOf(seat) >= 0) floor = seat;
    else if (active.indexOf(seat ^ 2) >= 0) floor = seat ^ 2;
    else floor = nextActive(active, seat);

    const pending = [];
    for (let i = 1; i <= 3; i++) {
      const s = (seat + i) % 4;
      if (active.indexOf(s) >= 0 && s !== floor) pending.push(s);
    }
    trick.floorSeat = floor;
    trick.pending = pending;
    if (pending.length === 0) beginHandPlay(state, floor);
    else state.awaiting = { kind: "follow", seat: pending[0] };

    // 此处不派发接风事件：floorSeat 只是“暂无人压”时的暂定领出者，尚待跟牌者
    // 可能压过（出完者仍可能被对手 J/大王等压住，先前据此宣告的接风不会发生）。
    // 确认接风只在本墩真正关墩（最后一次不要清空 pending）时派发一次，见 act()。
    return null;
  }

  function nextActive(active, seat) {
    for (let i = 1; i <= 4; i++) {
      const s = (seat + i) % 4;
      if (active.indexOf(s) >= 0) return s;
    }
    return active[0];
  }

  /* ---------- 结算口径纯计算 ---------- */
  function settleHand(order, oldLevels) {
    const winTeam = order[0] % 2;
    let delta;
    if (order[1] % 2 === winTeam) delta = 3;
    else if (order[2] % 2 === winTeam) delta = 2;
    else delta = 1;

    const oldLevel = oldLevels[winTeam];
    let passed = false, stuck = false, newLevel = oldLevel;
    if (oldLevel === 14) {
      if (delta >= 2) passed = true;
      else stuck = true;
    } else {
      newLevel = Math.min(14, oldLevel + delta);
    }

    const levelsNext = [oldLevels[0], oldLevels[1]];
    if (!passed && !stuck) levelsNext[winTeam] = newLevel;
    const nextCurrentLevel = passed ? null : levelsNext[winTeam];
    return {
      winTeam, delta, oldLevel, passed, stuck, newLevel,
      levelsNext, nextCurrentLevel,
      nextLevelTeam: passed ? null : winTeam,
    };
  }

  /* ---------- 单局结算 ---------- */
  function endHand(state) {
    const c = settleHand(state.finished, state.levels);
    state.handResult = {
      order: state.finished.slice(),
      winTeam: c.winTeam,
      delta: c.delta,
      level: state.currentLevel,
      passed: c.passed,
      stuck: c.stuck,
      oldLevel: c.oldLevel,
      newLevel: c.newLevel,
      levelsNext: c.levelsNext,
      nextCurrentLevel: c.nextCurrentLevel,
      nextLevelTeam: c.nextLevelTeam,
    };
    state.awaiting = null;
    state.phase = "handEnd";
    state.gen++;
    store.save(state);
    if (GD.stats) { try { GD.stats.recordHand(state); } catch (e) {} }
  }

  function continueAfterHand(state) {
    if (state.paused) return { ok: false, reason: "游戏已暂停" };
    const r = state.handResult;
    if (r.passed) {
      state.matchWinner = r.winTeam;
      state.phase = "matchEnd";
      const saved = store.save(state);
      if (GD.stats) { try { GD.stats.recordMatch(state); } catch (e) {} }
      return saved;
    }
    if (!r.stuck) state.levels[r.winTeam] = r.newLevel;
    state.levelTeam = r.nextLevelTeam;
    state.currentLevel = r.nextCurrentLevel;
    dealNextHand(state);
    setupTribute(state);
    return store.save(state);
  }

  // 练习模式一副结束：直接终局（不升级、不进贡）
  function finishPractice(state) {
    if (state.mode !== "practice" || state.phase !== "handEnd") {
      return { ok: false, reason: "当前不是练习结算阶段" };
    }
    state.matchWinner = state.handResult.winTeam;
    state.phase = "matchEnd";
    state.gen++;
    const saved = store.save(state);
    if (GD.stats) { try { GD.stats.recordMatch(state); } catch (e) {} }
    return { ok: true, saved };
  }

  /* ---------- 进贡 ---------- */
  function buildTributePairs(state) {
    const o = state.handResult.order;
    if (state.handResult.delta === 3) {
      return [
        { from: o[2], to: null, card: null, returnCard: null },
        { from: o[3], to: null, card: null, returnCard: null },
      ];
    }
    return [{ from: o[3], to: o[0], card: null, returnCard: null }];
  }

  function setupTribute(state) {
    const pairs = buildTributePairs(state);
    const anti = checkAnti(state, pairs);
    state.tribute = { anti, pairs, stage: "give", idx: 0 };
    state.phase = "tribute";
    state.awaiting = null;
  }

  function checkAnti(state, pairs) {
    const bigKings = (seat) => state.hands[seat].filter((c) => c.rank === 17).length;
    if (pairs.length === 2) {
      return bigKings(pairs[0].from) + bigKings(pairs[1].from) >= 2;
    }
    return bigKings(pairs[0].from) >= 2;
  }

  // 进贡必须选手中最大的非配牌
  function tributeOptions(state, seat) {
    const cards = state.hands[seat].filter((c) => !GD.isWild(c, state.currentLevel));
    const pool = cards.length ? cards : state.hands[seat].slice();
    let max = -1;
    for (const c of pool) max = Math.max(max, GD.cardWeight(c, state.currentLevel));
    return pool.filter((c) => GD.cardWeight(c, state.currentLevel) === max);
  }

  function giveTribute(state, cardId) {
    if (state.paused) return { ok: false, reason: "游戏已暂停" };
    const t = state.tribute;
    if (!t || state.phase !== "tribute" || t.stage !== "give") {
      return { ok: false, reason: "当前不是进贡环节" };
    }
    const pair = t.pairs[t.idx];
    const options = tributeOptions(state, pair.from);
    const card = options.find((c) => c.id === cardId);
    if (!card) return { ok: false, reason: "进贡必须选择手中最大的牌（配牌除外）" };

    state.hands[pair.from] = state.hands[pair.from].filter((c) => c.id !== cardId);
    pair.card = card;
    t.idx++;
    if (t.idx === t.pairs.length) {
      if (t.pairs.length === 2) assignDoubleTribute(state);
      t.stage = "return";
      t.idx = 0;
    }
    state.gen++;
    return { ok: true, saved: store.save(state) };
  }

  function assignDoubleTribute(state) {
    const head = state.handResult.order[0];
    const second = state.handResult.order[1];
    const [p0, p1] = state.tribute.pairs;
    const v0 = GD.cardWeight(p0.card, state.currentLevel);
    const v1 = GD.cardWeight(p1.card, state.currentLevel);

    let bigPair, smallPair;
    if (v0 === v1) {
      let firstAfter = -1;
      for (let i = 1; i <= 3; i++) {
        const s = (head + i) % 4;
        if (s === p0.from || s === p1.from) { firstAfter = s; break; }
      }
      bigPair = firstAfter === p0.from ? p0 : p1;
    } else {
      bigPair = v1 > v0 ? p1 : p0;
    }
    smallPair = bigPair === p0 ? p1 : p0;
    bigPair.to = head;
    smallPair.to = second;
  }

  // 还贡：≤10 的小牌（含 2；级牌、王、配牌除外）
  function returnCandidates(state, pair) {
    const L = state.currentLevel;
    return state.hands[pair.to].filter(
      (c) => c.rank <= 10 && c.rank !== L && !GD.isWild(c, L));
  }
  function fallbackReturn(state, pair) {
    const rest = state.hands[pair.to].filter((c) => c.id !== pair.card.id);
    if (!rest.length) return null;
    rest.sort((a, b) =>
      GD.cardWeight(a, state.currentLevel) - GD.cardWeight(b, state.currentLevel));
    return rest[0];
  }

  function returnTribute(state, cardId) {
    if (state.paused) return { ok: false, reason: "游戏已暂停" };
    const t = state.tribute;
    if (!t || state.phase !== "tribute" || t.stage !== "return") {
      return { ok: false, reason: "当前不是还贡环节" };
    }
    const pair = t.pairs[t.idx];
    let options = returnCandidates(state, pair);
    let card = options.find((c) => c.id === cardId);
    if (!card) {
      const fb = fallbackReturn(state, pair);
      if (fb && fb.id === cardId) card = fb;
    }
    if (!card) return { ok: false, reason: "这张牌不能用于还贡" };

    state.hands[pair.to] = state.hands[pair.to].filter((c) => c.id !== card.id);
    state.hands[pair.to].push(pair.card);
    state.hands[pair.from].push(card);
    GD.sortHand(state.hands[pair.from], state.currentLevel);
    GD.sortHand(state.hands[pair.to], state.currentLevel);
    pair.returnCard = card;
    t.idx++;
    if (t.idx === t.pairs.length) {
      t.stage = "done";
      beginHandPlay(state, leaderSeat(state));
    }
    state.gen++;
    return { ok: true, saved: store.save(state) };
  }

  function leaderSeat(state) {
    const head = state.handResult.order[0];
    const pair = state.tribute.pairs.find((p) => p.to === head);
    return pair ? pair.from : head;
  }

  function finishAnti(state) {
    if (state.tribute && state.tribute.anti) {
      const head = state.handResult.order[0];
      state.tribute.stage = "done";
      beginHandPlay(state, head);
      return store.save(state);
    }
    return null;
  }

  // 电脑贡/还：在合法候选中按保结构挑牌（ai 缺失或异常时回退原口径）
  function autoGive(state, seat) {
    try {
      if (GD.ai && GD.ai.chooseGive) return GD.ai.chooseGive(state, seat);
    } catch (e) {}
    return tributeOptions(state, seat)[0];
  }
  function autoReturn(state, pair) {
    try {
      if (GD.ai && GD.ai.chooseReturn) return GD.ai.chooseReturn(state, pair);
    } catch (e) {}
    const opts = returnCandidates(state, pair);
    if (opts.length) {
      opts.sort((a, b) =>
        GD.cardWeight(a, state.currentLevel) - GD.cardWeight(b, state.currentLevel));
      return opts[0];
    }
    return fallbackReturn(state, pair);
  }

  GD.game = {
    newMatch, newPractice, act, continueAfterHand, finishPractice,
    giveTribute, returnTribute, finishAnti,
    tributeOptions, returnCandidates, fallbackReturn,
    autoGive, autoReturn, validateState,
    dealNextHand, beginHandPlay, setupTribute, endHand,
  };

  // 观察边界由状态层统一产出（ai/提示/评测共用，禁止策略自造其他玩家手牌视图）
  GD.observe = {
    build: buildObservation,
    sealedHand,
    seenIdsFromLog,
    tributeKnownIds,
  };
})();
