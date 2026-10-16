/* ====== 异步操作上下文校验（纯函数） ======
 * 延迟回调执行前用它确认：仍是同一场/同一副/同一操作版本、未暂停、
 * 阶段/座位/进贡索引仍匹配；玩家座位还须仍在托管。
 */
(function () {
  const GD = (window.GD = window.GD || {});

  function capture(state, extra) {
    return Object.assign({
      matchId: state.matchId,
      gen: state.gen,
      phase: state.phase,
      paused: state.paused,
    }, extra || {});
  }

  function stillValid(state, caps) {
    if (!state || state.matchId !== caps.matchId) return false;
    if (state.paused) return false;
    if (state.gen !== caps.gen || state.phase !== caps.phase) return false;

    if (caps.kind === "play") {
      const aw = state.awaiting;
      if (!aw || aw.seat !== caps.seat || aw.kind !== caps.awKind) return false;
    } else if (caps.kind === "tribute") {
      const t = state.tribute;
      if (!t || t.stage !== caps.stage || t.idx !== caps.idx) return false;
      const pair = t.pairs[t.idx];
      if (!pair) return false;
      const wantSeat = caps.role === "give" ? pair.from : pair.to;
      if (wantSeat !== caps.seat) return false;
    }

    // 玩家座位只有在仍托管时，旧回调才可代其出手
    if (caps.seat === 0 && state.autoPilot !== caps.autoPilot) return false;
    return true;
  }

  GD.flow = { capture, stillValid };
})();
