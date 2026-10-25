/* 常驻牌桌音乐：独立开关、语音压低、后台暂停；不参与对局状态。 */
(function () {
  const GD = window.GD = window.GD || {};
  const script = typeof document !== "undefined" && document.currentScript?.src;
  const base = script ? new URL("../audio/music/table-loop.mp3", script).href : "audio/music/table-loop.mp3";
  const localFile = script ? new URL(script).protocol === "file:" : window.location?.protocol === "file:";
  let player = null, context = null, source = null, gain = null;
  let enabled = true, volume = .35, masterVolume = .6, muted = false, ducked = false;
  let visible = typeof document === "undefined" || !document.hidden;
  let unlocked = false, starting = false, generation = 0, lastError = null;
  const clamp = (value, fallback) => Number.isFinite(Number(value)) ? Math.max(0, Math.min(1, Number(value))) : fallback;
  const wanted = () => enabled && unlocked && visible && !muted && volume > 0 && masterVolume > 0;
  const level = () => wanted() ? volume * masterVolume * (ducked ? .28 : 1) : 0;

  function updateGain() {
    if (!player) return;
    const target = level();
    if (gain) {
      try {
        gain.gain.cancelScheduledValues(context.currentTime);
        gain.gain.setTargetAtTime(target, context.currentTime, ducked ? .06 : .25);
      } catch (_) { gain.gain.value = target; }
      player.volume = 1;
    } else player.volume = target;
  }

  function ensurePlayer() {
    if (!player && typeof window.Audio === "function") {
      try {
        player = new window.Audio();
        player.src = base + "?v=" + encodeURIComponent(GD.VERSION || "local");
        player.loop = true; player.preload = "auto";
        player.setAttribute?.("playsinline", "");
        player.onerror = () => { starting = false; lastError = "MediaError"; };
      } catch (_) { player = null; }
    }
    // iPhone 的媒体音量由 Web Audio 增益控制；本地文件保留原生文件播放能力。
    if (player && !source && !localFile) {
      try {
        const c = GD.sound?.getAudioContext();
        if (c?.createMediaElementSource && c?.createGain) {
          context = c; source = c.createMediaElementSource(player); gain = c.createGain();
          gain.gain.value = 0;
          source.connect(gain); gain.connect(c.destination);
        }
      } catch (_) { source = null; gain = null; }
    }
    return player;
  }

  function pause() {
    generation++; starting = false;
    try { player?.pause(); } catch (_) {}
    updateGain();
  }

  function sync() {
    if (!wanted()) { pause(); return false; }
    if (!ensurePlayer()) return false;
    updateGain();
    if (context && context.state !== "running") {
      try { context.resume()?.catch(() => {}); } catch (_) {}
    }
    if (!player.paused || starting) return true;
    const token = ++generation;
    starting = true; lastError = null;
    try {
      const result = player.play();
      Promise.resolve(result).then(() => {
        if (token !== generation) return;
        starting = false;
        if (!wanted()) pause();
      }).catch(error => {
        if (token !== generation) return;
        starting = false; lastError = error?.name || "PlaybackError";
      });
      return true;
    } catch (_) { starting = false; lastError = "PlaybackError"; return false; }
  }

  GD.music = {
    configure(on, amount) { enabled = on !== false; volume = clamp(amount, .35); sync(); },
    setMaster(off, amount) { muted = !!off; masterVolume = clamp(amount, .6); sync(); },
    setDucked(on) { ducked = !!on; updateGain(); },
    unlock() { unlocked = true; sync(); },
    setVisible(on) { visible = !!on; sync(); },
    getState() {
      return { enabled, volume, masterVolume, muted, ducked, visible, unlocked,
        playing: !!player && !player.paused, starting, level: level(),
        position: player?.currentTime || 0, duration: player?.duration || 0,
        loop: !!player?.loop, src: player?.src || null, viaWebAudio: !!gain, lastError };
    },
  };
  document.addEventListener?.("visibilitychange", () => GD.music.setVisible(!document.hidden));
  window.addEventListener?.("pagehide", () => GD.music.setVisible(false));
  window.addEventListener?.("pageshow", () => GD.music.setVisible(!document.hidden));
})();
