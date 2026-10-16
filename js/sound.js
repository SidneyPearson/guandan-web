/* ====== 音效（v1.3） ======
 * 纯 Web Audio 振荡器合成，零素材零网络，file:// 下可用。
 * 必须在用户手势中调用 unlock()（浏览器自动播放策略）；
 * 静音/音量由设置驱动；AudioContext 创建或发声失败一律静默，绝不影响出牌。
 * 每次播放只由"新发生的对局事件"触发，恢复存档/重复渲染不重播（由 ui 保证）。
 */
(function () {
  const GD = (window.GD = window.GD || {});

  let ctx = null;
  let muted = false;
  let volume = 0.6;
  let reduceMotion = false; // 减少动效不影响音效，仅预留联动

  function ensureCtx() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { ctx = new AC(); } catch (e) { ctx = null; }
    return ctx;
  }

  // 一个带简单包络的振荡器音
  function tone(freq, start, dur, type, gain) {
    if (!ctx) return;
    try {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = type || "sine";
      osc.frequency.setValueAtTime(freq, ctx.currentTime + start);
      const peak = gain * volume;
      g.gain.setValueAtTime(0.0001, ctx.currentTime + start);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), ctx.currentTime + start + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + start + dur);
      osc.connect(g); g.connect(ctx.destination);
      osc.start(ctx.currentTime + start);
      osc.stop(ctx.currentTime + start + dur + 0.02);
    } catch (e) { /* 忽略发声错误 */ }
  }

  // 事件名 → 合成方案（简洁、区分度高；参考同类项目思路自写，不照搬波形）
  const VOICES = {
    deal:      (p) => { tone(520 + p * 18, 0, 0.07, "triangle", 0.12); },
    play:      () => { tone(660, 0, 0.09, "triangle", 0.16); },
    pass:      () => { tone(300, 0, 0.12, "sine", 0.12); },
    bomb:      () => { tone(150, 0, 0.22, "sawtooth", 0.2); tone(96, 0.02, 0.28, "sawtooth", 0.16); },
    sflush:    () => { [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.05, 0.12, "triangle", 0.14)); },
    jokers:    () => { [392, 523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, i * 0.05, 0.14, "square", 0.1)); },
    jiefeng:   () => { tone(587, 0, 0.1, "triangle", 0.14); tone(880, 0.09, 0.14, "triangle", 0.14); },
    settle:    () => { [523, 659, 784].forEach((f, i) => tone(f, i * 0.09, 0.16, "triangle", 0.15)); },
    win:       () => { [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.1, 0.22, "triangle", 0.16)); },
    lose:      () => { [440, 392, 330].forEach((f, i) => tone(f, i * 0.12, 0.22, "sine", 0.14)); },
    click:     () => { tone(720, 0, 0.05, "square", 0.08); },
  };

  const sound = {
    // 在点击/按键等手势中调用
    unlock() {
      const c = ensureCtx();
      if (c && c.state === "suspended") {
        try { c.resume(); } catch (e) {}
      }
    },
    play(name, opts) {
      if (muted || !VOICES[name]) return;
      const c = ensureCtx();
      if (!c) return;
      if (c.state === "suspended") { try { c.resume(); } catch (e) {} }
      try { VOICES[name]((opts && opts.pitch) || 0); } catch (e) {}
    },
    setMuted(m) { muted = !!m; },
    isMuted() { return muted; },
    setVolume(v) { volume = Math.max(0, Math.min(1, Number(v) || 0)); },
    getVolume() { return volume; },
    // 测试/设置页可验证事件接线而不真正发声
    voiceNames() { return Object.keys(VOICES); },
  };

  GD.sound = sound;
})();
