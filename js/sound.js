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
    seat: seat < 4 ? seat : null, player: null, token: 0, current: null, unlocked: false, timer: null,
  }));
  const recentVoiceKeys = new Set();
  const PASS_LINES = ["pass-0", "pass-1", "pass-2", "pass-3", "pass-4", "pass-5"];
  const passBags = Array.from({ length: 4 }, () => ({ neutral: [], unable: [], last: null }));
  const ORDINARY_PLAYS = ["single", "pair", "triple", "fullhouse"];
  const replyTurns = Array.from({ length: 4 }, (_, seat) => ({ count: 0, line: seat }));
  // 静音 WAV 预热不依赖音量属性，避免 iOS 忽略 volume=0 时听见预热人声。
  const unlockClip = "data:audio/wav;base64,UklGRmQBAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YUABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";
  const oscillators = new Set();
  const scriptSrc = typeof document !== "undefined" && document.currentScript && document.currentScript.src;
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
    const count = channels.filter(channel => channel.current && !channel.current.pending).length;
    // 两家同时说话时略收音量，保留各自的力度与辨识度。
    const gain = volume / Math.sqrt(1 + Math.max(0, count - 1) * .35);
    channels.forEach(channel => { if (channel.player && channel.current) channel.player.volume = gain; });
    GD.music?.setDucked(count > 0);
  }
  function stopChannel(channel) {
    if (channel.timer !== null) clearTimeout(channel.timer);
    channel.timer = null;
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
    const profiles = opts.profiles || ids.map(() => profileFor(seat, opts.style || voiceStyle));
    // 接风应答与该玩家紧接着的报牌接在一起；其余座位仍可同时说话。
    if (!opts.interaction && !opts.preview && channel.current && channel.current.interaction && channel.current.index === 0) {
      channel.current.ids.push(...ids);
      channel.current.profiles.push(...profiles);
      return true;
    }
    stopChannel(channel);
    const token = channel.token;
    const current = channel.current = { ids: ids.slice(), profiles: profiles.slice(), profile: profiles[0], index: 0,
      order: ++voiceSerial, interaction: !!opts.interaction, pending: !!opts.delayMs };
    const next = index => {
      if (token !== channel.token) return;
      if (index >= current.ids.length) { stopChannel(channel); return; }
      current.index = index; current.profile = current.profiles[index]; current.pending = false;
      if (index > 0) current.interaction = false;
      audio.src = voiceUrl(current.profile, current.ids[index]);
      refreshMix();
      // 报牌使用素材本身的语调与语速。
      audio.playbackRate = 1;
      audio.onended = () => { if (current.index === index) next(index + 1); };
      audio.onerror = () => { if (token === channel.token) stopChannel(channel); };
      try {
        const started = audio.play();
        if (started && started.catch) started.catch(() => { if (token === channel.token) stopChannel(channel); });
      } catch (e) { if (token === channel.token) stopChannel(channel); }
    };
    if (opts.delayMs) channel.timer = setTimeout(() => { channel.timer = null; next(0); }, opts.delayMs);
    else next(0);
    return true;
  }
  function actionLine(r, opts) {
    if (r.kind === "pass") {
      const unable = isOpponentReply(r) && opts.canBeat === false;
      const memory = passBags[r.seat], kind = unable ? "unable" : "neutral";
      if (!memory[kind].length) {
        memory[kind] = unable
          ? ["pass-unable-0", ...PASS_LINES.slice(0, 2), "pass-unable-1", ...PASS_LINES.slice(2)]
          : PASS_LINES.slice();
        // 每位角色独立洗牌，整组说完再换顺序；只使用语音层随机，不消耗 AI 策略随机源。
        for (let i = memory[kind].length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [memory[kind][i], memory[kind][j]] = [memory[kind][j], memory[kind][i]];
        }
      }
      const bag = memory[kind];
      if (bag[0] === memory.last && bag.length > 1) [bag[0], bag[1]] = [bag[1], bag[0]];
      // 两组切换后可能只剩上一句：保留它，先从其他可用话术中选一句，避免连说。
      if (bag[0] === memory.last) {
        const alternatives = PASS_LINES.filter(id => id !== memory.last);
        return memory.last = alternatives[Math.floor(Math.random() * alternatives.length)];
      }
      return memory.last = bag.shift();
    }
    const p = r.kind === "play" && r.play;
    if (!p) return null;
    if (p.type === "bomb") return "bomb-" + Math.max(4, Math.min(10, p.size));
    if (["single", "pair", "triple"].includes(p.type)) return p.type + "-" + (p.value === 15 ? opts.level : p.value);
    return GD.VOICE_LINES && GD.VOICE_LINES[p.type] ? p.type : null;
  }
  function isOpponentReply(r) {
    const seat = r.followed && r.followed.seat;
    return !!(r.followed && r.followed.play) && Number.isInteger(seat) &&
      seat >= 0 && seat < 4 && seat % 2 !== r.seat % 2;
  }
  function replyLine(r, opts) {
    // 普通跟牌以短句代替点名，三次中留一次报牌；各家独立轮换口吻。
    if (r.kind !== "play" || !r.play || !ORDINARY_PLAYS.includes(r.play.type) ||
        !isOpponentReply(r) || !(opts.remaining > 2)) return null;
    const turn = replyTurns[r.seat];
    if (turn.count++ % 3 === 2) return null;
    return "beat-" + (turn.line++ % 3);
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
      GD.music?.unlock();
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
      if (r.event && r.event.type === "jiefeng") {
        const from = r.event.outSeat, to = r.event.seat;
        if (!Number.isInteger(from) || from < 0 || from > 3 || to !== (from ^ 2)) return false;
        const started = speak(["jiefeng-handoff"], from, { interaction: true });
        if (started) speak(["jiefeng-reply"], to, { interaction: true, delayMs: 520 });
        return started;
      }
      const id = actionLine(r, opts);
      if (!id) return false;
      const ordinary = r.kind === "play" && ORDINARY_PLAYS.includes(r.play.type);
      const low = r.kind === "play" && (opts.remaining === 1 || opts.remaining === 2);
      const reply = replyLine(r, opts);
      // 每次普通出牌只说一句，避免“压上 + 具体牌名 + 余牌提醒”连播。
      const ids = [ordinary && low ? "last" + opts.remaining : reply || id];
      if (low && !ordinary) ids.push("last" + opts.remaining);
      return speak(ids, r.seat);
    },
    preview(style = voiceStyle) {
      return style === "roles" ? speak(["pass-unable-0", "beat-0", "beat-1", "beat-2"], 0,
        { preview: true, profiles: GD.VOICE_SEATS }) : speak(["preview"], 0, { preview: true, style });
    },
    setVoice(enabled, style) { voiceEnabled = enabled !== false; voiceStyle = ["roles","bright","calm"].includes(style) ? style : "roles"; if (!voiceEnabled) cancelVoice(); },
    cancel() {
      cancelVoice();
      oscillators.forEach(osc => { try { osc.stop(); } catch (e) {} }); oscillators.clear();
    },
    setMuted(m) { muted = !!m; GD.music?.setMaster(muted, volume); if (muted) this.cancel(); },
    isMuted() { return muted; },
    setVolume(v) { volume = Math.max(0, Math.min(1, Number(v) || 0)); GD.music?.setMaster(muted, volume); if (!volume) cancelVoice(); else refreshMix(); },
    getVolume() { return volume; },
    getAudioContext() { return ensureCtx(); },
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
