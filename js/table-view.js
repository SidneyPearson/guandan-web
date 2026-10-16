/* 只读展示选择器：不复制有效牌状态，不改日志或规则。 */
(function () {
  const GD = window.GD;
  const handKey = (s) => s.matchId + ":" + s.handId;
  function target(s) {
    return s.phase === "play" && s.trick && s.trick.target
      ? { seat: s.trick.targetSeat, play: s.trick.target } : null;
  }
  function recent(s, limit = 12) {
    const log = Array.isArray(s.log) ? s.log : [];
    if (log.length) return log.slice(-limit).map((e, i) => ({
      ...e, sequence: log.length - Math.min(log.length, limit) + i + 1,
    }));
    const last = s.lastTrick;
    if (last && Array.isArray(last.actions)) return last.actions.slice(-limit).map((e, i) => ({
      ...e, sequence: last.actions.length - Math.min(last.actions.length, limit) + i + 1,
    }));
    // 缺动作顺序的旧档只显示已有结果，不能伪造连续出牌事件。
    return last && Array.isArray(last.entries) ? last.entries.filter(Boolean).map((e) => ({
      ...e, kind: e.pass ? "pass" : "play", sequence: null,
    })) : [];
  }
  GD.tableView = { handKey, target, recent };
})();
