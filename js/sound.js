/* ====== 音效与内置中文报牌 ======
 * Web Audio 合成音效 + 随包交付的短语音，file:// 和手机离线缓存下可用。
 * 必须在用户手势中调用 unlock()（浏览器自动播放策略）；
 * 静音/音量由设置驱动；AudioContext 创建或发声失败一律静默，绝不影响出牌。
 * 每次播放只由"新发生的对局事件"触发，恢复存档/重复渲染不重播（由 ui 保证）。
 */
(function () {
  const GD = (window.GD = window.GD || {});

  let ctx = null;
  let muted = false;
  let volume = 0.6;
  let voiceEnabled = true, voiceStyle = "roles";
  let voiceSerial = 0;
  // 四家各用自己的媒体元素；试听另占一个，互不抢占或排队。
  const channels = Array.from({ length: 5 }, (_, seat) => ({
    seat: seat < 4 ? seat : null, player: null, token: 0, current: null, unlocked: false,
  }));
  const recentVoiceKeys = new Set();
  // 静音 WAV 预热不依赖音量属性，避免 iOS 忽略 volume=0 时听见预热人声。
  const unlockClip = "data:audio/wav;base64,UklGRmQBAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YUABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";
  const oscillators = new Set();
  const scriptSrc = document.currentScript && document.currentScript.src;
  const voiceBase = scriptSrc ? new URL("../audio/voice/", scriptSrc).href : "audio/voice/";

  function voiceUrl(profile, id) {
    return voiceBase + profile + "/" + id + ".mp3?v=" + encodeURIComponent(GD.VERSION || "local");
  }
  function ensurePlayer(channel) {
    if (!channel.player && typeof window.Audio === "function") {
      try { channel.player = new window.Audio(); channel.player.preload = "auto"; } catch (e) {}
    }
    return channel.player;
  }
  function refreshMix() {
    const count = channels.filter(channel => channel.current).length;
    // 两家同时说话时略收音量，保留各自的力度与辨识度。
    const gain = volume / Math.sqrt(1 + Math.max(0, count - 1) * .35);
    channels.forEach(channel => { if (channel.player && channel.current) channel.player.volume = gain; });
  }
  function stopChannel(channel) {
    channel.token++; channel.current = null;
    const audio = channel.player;
    if (audio) {
      audio.onended = null; audio.onerror = null;
      try { audio.pause(); audio.currentTime = 0; } catch (e) {}
    }
    refreshMix();
  }
  function cancelVoice() {
    channels.forEach(stopChannel);
  }
  function profileFor(seat, style) {
    return GD.VOICE_PROFILES.includes(style) ? style : GD.VOICE_SEATS[seat];
  }
  function speak(ids, seat, opts = {}) {
    if (muted || !voiceEnabled || volume === 0) return false;
    const channel = channels[opts.preview ? 4 : seat];
    if (!channel) return false;
    const audio = ensurePlayer(channel);
    if (!audio || !GD.VOICE_LINES || ids.some(id => !GD.VOICE_LINES[id])) return false;
    stopChannel(channel);
    const token = channel.token, profiles = opts.profiles || ids.map(() => profileFor(seat, opts.style || voiceStyle));
    const current = channel.current = { ids: ids.slice(), profile: profiles[0], index: 0, order: ++voiceSerial };
    const next = index => {
      if (token !== channel.token) return;
      if (index >= ids.length) { stopChannel(channel); return; }
      current.index = index; current.profile = profiles[index];
      audio.src = voiceUrl(current.profile, ids[index]);
      refreshMix();
      // 牌局速度只影响电脑思考与动画，报牌保留原始语速和重音。
      audio.playbackRate = 1;
      audio.onended = () => { if (current.index === index) next(index + 1); };
      audio.onerror = () => { if (token === channel.token) stopChannel(channel); };
      try {
        const started = audio.play();
        if (started && started.catch) started.catch(() => { if (token === channel.token) stopChannel(channel); });
      } catch (e) { if (token === channel.token) stopChannel(channel); }
    };
    next(0);
    return true;
  }
  function actionLine(r, opts) {
    if (r.event && r.event.type === "jiefeng") return "jiefeng";
    if (r.kind === "pass") return "pass-" + ((Number(opts.sequence) || 0) % 2);
    const p = r.kind === "play" && r.play;
    if (!p) return null;
    if (p.type === "bomb") return "bomb-" + Math.max(4, Math.min(10, p.size));
    if (["single", "pair", "triple"].includes(p.type)) return p.type + "-" + (p.value === 15 ? opts.level : p.value);
    return GD.VOICE_LINES && GD.VOICE_LINES[p.type] ? p.type : null;
  }

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
      const peak = gain * volume * (channels.some(channel => channel.current) ? .42 : 1);
      g.gain.setValueAtTime(0.0001, ctx.currentTime + start);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), ctx.currentTime + start + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + start + dur);
      osc.connect(g); g.connect(ctx.destination);
      oscillators.add(osc); osc.onended = () => { oscillators.delete(osc); try { osc.disconnect(); g.disconnect(); } catch (e) {} };
      osc.start(ctx.currentTime + start);
      osc.stop(ctx.currentTime + start + dur + 0.02);
    } catch (e) { /* 忽略发声错误 */ }
  }

  // 事件名 → 合成方案（简洁、区分度高；参考同类项目思路自写，不照搬波形）
  const VOICES = {
    deal:      (p) => { tone(520 + p * 18, 0, 0.07, "triangle", 0.12); },
    play:      () => { tone(660, 0, 0.09, "triangle", 0.16); },
    pass:      () => { tone(300, 0, 0.12, "sine", 0.12); },
    straight:  () => { [523,659,784,988,1175].forEach((f,i)=>tone(f,i*.045,.1,"triangle",.13)); },
    dpairs:    () => { [440,554,659].forEach((f,i)=>{ tone(f,i*.09,.08,"triangle",.14);tone(f*1.5,i*.09+.035,.07,"sine",.1); }); },
    steel:     () => { [0,.13].forEach(t=>{ tone(196,t,.18,"triangle",.2);tone(784,t,.09,"square",.07);tone(1176,t+.015,.12,"sine",.08); }); },
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
      // 在同一个手势内预热所有座位的媒体元素，供电脑异步回合复用（含 iOS）。
      channels.forEach(channel => {
        const audio = ensurePlayer(channel);
        if (!audio || channel.unlocked || channel.current) return;
        channel.unlocked = true;
        const token = channel.token;
        audio.volume = 0;
        audio.src = unlockClip;
        try {
          const p = audio.play();
          if (p && p.then) p.then(() => { if (token === channel.token && !channel.current) audio.pause(); })
            .catch(() => { if (token === channel.token) channel.unlocked = false; });
        } catch (e) { channel.unlocked = false; }
      });
    },
    play(name, opts) {
      if (muted || !VOICES[name]) return;
      const c = ensureCtx();
      if (!c) return;
      if (c.state === "suspended") { try { c.resume(); } catch (e) {} }
      try { VOICES[name]((opts && opts.pitch) || 0); } catch (e) {}
    },
    announce(r, opts = {}) {
      if (!r || !r.ok || !opts.key || recentVoiceKeys.has(opts.key) || !Number.isInteger(r.seat) || r.seat < 0 || r.seat > 3) return false;
      recentVoiceKeys.add(opts.key);
      if (recentVoiceKeys.size > 64) recentVoiceKeys.delete(recentVoiceKeys.values().next().value);
      const id = actionLine(r, opts);
      if (!id) return false;
      const ids = [id];
      if (r.kind === "play" && (opts.remaining === 1 || opts.remaining === 2)) ids.push("last" + opts.remaining);
      return speak(ids, r.seat);
    },
    preview(style = voiceStyle) {
      return style === "roles" ? speak(["straight", "steel", "dpairs", "jokers"], 0,
        { preview: true, profiles: GD.VOICE_SEATS }) : speak(["preview"], 0, { preview: true, style });
    },
    setVoice(enabled, style) { voiceEnabled = enabled !== false; voiceStyle = ["roles","bright","calm"].includes(style) ? style : "roles"; if (!voiceEnabled) cancelVoice(); },
    cancel() {
      cancelVoice();
      oscillators.forEach(osc => { try { osc.stop(); } catch (e) {} }); oscillators.clear();
    },
    setMuted(m) { muted = !!m; if (muted) this.cancel(); },
    isMuted() { return muted; },
    setVolume(v) { volume = Math.max(0, Math.min(1, Number(v) || 0)); if (!volume) cancelVoice(); else refreshMix(); },
    getVolume() { return volume; },
    // 测试/设置页可验证事件接线而不真正发声
    voiceNames() { return Object.keys(VOICES); },
    getVoiceState() {
      const voices = channels.filter(channel => channel.current).map(channel => ({
        ...channel.current, ids: channel.current.ids.slice(), seat: channel.seat, preview: channel.seat === null,
      })).sort((a, b) => a.order - b.order);
      return { ...(voices[voices.length - 1] || {}), active: voices.length > 0, activeCount: voices.length, voices };
    },
  };

  GD.sound = sound;
})();
