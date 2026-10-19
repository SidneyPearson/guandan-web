/* ====== 界面层：渲染、交互、节奏驱动（v1.3） ====== */
(function () {
  const GD = window.GD;
  const $ = (id) => document.getElementById(id);

  const NAMES = GD.tableTools.seats.map((s) => s.name);
  const RANK_WORDS = ["头游", "二游", "三游", "四游"];
  const CARD_BY_ID = new Map(GD.buildDeck().map((c) => [c.id, c]));

  // 出牌节奏（UI 等待随机，与洗牌/策略随机相互独立）
  const SPEED_WAIT = { slow: [1600, 500], std: [1000, 400], fast: [400, 200] };
  const ANTI_WAIT = { slow: 1800, std: 1400, fast: 700 };
  function aiWait() {
    const w = SPEED_WAIT[settings.speed] || SPEED_WAIT.std;
    return w[0] + Math.random() * w[1];
  }

  let state = null;
  let settings = GD.store.loadSettings();
  let selected = new Set();
  let hintCands = []; // 当前决策时刻的策略候选（含"不要"），供提示循环
  let hintIdx = 0;
  let thinkingSeat = -1;
  let kickKey = "";
  let modalPause = false; // 规则/确认/设置/战绩弹窗临时暂停
  let pendingFx = null;   // afterAct 挂起的特效请求，renderAll 后发放
  // 页面正在卸载（刷新/关闭/导航）：丢弃一切在途渲染与 AI 推进。
  // 否则 await wait() 恢复的旧回调会在濒毁文档上 getElementById(...) 取到 null 而抛错。
  let unloading = false;
  let rulesFrom = null;   // 规则打开来源：pause/home/game
  let settingsFrom = null;
  let statsFrom = null;
  let savedFocus = null;  // 打开弹窗前的焦点元素
  let activeModal = null; // 当前最上层模态窗口（焦点陷阱用）
  let activePlayView, seatPlayView, historyView, turnClock;
  const MODAL_IDS = ["confirmOverlay", "rulesOverlay", "settingsOverlay", "statsOverlay",
    "pauseOverlay", "settleOverlay", "matchEndOverlay"];

  // 音效一次性记录：只由本会话真实动作触发，恢复/重绘不重播
  const endSoundKeys = new Set();
  const matchSoundKeys = new Set();

  // 多牌选择：扫选手势 / Shift 范围锚点 / 键盘焦点序号（均以当前屏幕序为准）
  let gesture = null;
  let lastGestureIds = null; // 刚结束手势处理过的牌 id：吞掉随后的 click
  let lastGestureAt = 0;     // 手势结束时刻：只吞紧接着的 click，不影响稍后触屏点按
  let rangeAnchor = null;    // {id} 普通点击设定，新开/重开清空
  let kbIndex = -1;
  // 蓝色焦点框只属于键盘操作：pointerNav=true 表示最近一次进入手牌区的途径是
  // 鼠标/触屏（点击、拖选），此时不显示焦点牌；Tab 或方向键切入后 kbActive=true。
  let pointerNav = true;
  let kbActive = false;

  document.addEventListener("DOMContentLoaded", init);
  document.addEventListener("keydown", onKeydown);
  // 任意指针按压（鼠标/触屏/触控笔）都先记下当前是指针导航；
  // 随后的 focus 事件据此决定是否显示蓝色焦点牌（指针聚焦一律不显示）
  document.addEventListener("pointerdown", () => { pointerNav = true; }, true);
  window.addEventListener("blur", cancelGesture);

  /* ================= 启动 ================= */
  function init() {
    activePlayView = GD.createActivePlay({ root: $("tableCenter"), cards: $("activePlay"), caption: $("centerHint"),
      empty: $("trickEmpty"), renderCard: cardEl, describe: playTypeText, names: NAMES });
    seatPlayView = GD.createSeatPlay({ roots: [$("myPlay"), $("play-1"), $("play-2"), $("play-3")],
      renderCard: cardEl, cardsById: CARD_BY_ID, names: NAMES });
    historyView = GD.createPlayHistory({ toggle: $("historyToggle"), panel: $("playHistoryPanel"),
      list: $("historyList"), summary: $("historySummary"), close: $("historyClose"),
      renderCard: cardEl, cardsById: CARD_BY_ID, names: NAMES });
    turnClock = GD.createTurnClock({ roots: [0, 1, 2, 3].map((seat) => $("turn-clock-" + seat)), names: NAMES });
    bindStatic();
    applyUISettings();
    $("homeVersion").textContent = GD.VERSION;
    renderRules();
    const s = GD.store.loadSettings();
    document.querySelectorAll('input[name="homeDiff"]').forEach(
      (r) => (r.checked = r.value === s.difficulty));
    refreshContinueEntry();
    show("homeOverlay");
  }

  function homeDiff() {
    const el = document.querySelector('input[name="homeDiff"]:checked');
    return el ? el.value : "normal";
  }
  function saveDiff(diff) {
    const s = GD.store.loadSettings();
    s.difficulty = diff;
    GD.store.saveSettings(s);
    settings = s;
  }

  function refreshContinueEntry() {
    // 有存档（含损坏/旧版）就显示入口；点击后再按具体情况处理，
    // 否则坏档会把玩家困在首页无法重开
    $("btnContinue").classList.toggle("hidden", !GD.store.hasRaw());
    $("btnPracticeContinue").classList.toggle("hidden", !GD.store.hasPractice());
  }

  function resetTemp() {
    selected = new Set();
    hintCands = [];
    hintIdx = 0;
    thinkingSeat = -1;
    kickKey = "";
    gesture = null;
    rangeAnchor = null;
    kbIndex = -1;
    kbActive = false;
    clearKbFocus();
    showHint("");
  }

  function enterGame() {
    modalPause = false;
    resetTemp();
    seatPlayView.clear();
    turnClock.clear();
    historyView.close();
    if (GD.fx) GD.fx.cancel(); // 新开/恢复：清掉一切在途特效
    GD.sound.cancel();
    hideAllOverlays();
    renderAll();
    kick();
  }

  // 发牌音只在 UI 主动开出新一副时触发（存档恢复不触发）
  function dealSound() {
    if (!settings.sound) return;
    GD.sound.play("deal", { pitch: 0 });
    setTimeout(() => GD.sound.play("deal", { pitch: 2 }), 110);
    setTimeout(() => GD.sound.play("deal", { pitch: 4 }), 220);
  }

  function bindStatic() {
    // 浏览器自动播放策略：首次手势解锁音频
    const unlock = () => GD.sound.unlock();
    document.addEventListener("pointerdown", unlock);
    document.addEventListener("keydown", unlock);
    // 导航/刷新/关页：停止所有异步推进，避免旧执行上下文排空时操作已销毁的 DOM
    window.addEventListener("pagehide", () => { unloading = true; seatPlayView.clear(); turnClock.suspend(); GD.sound.cancel(); });
    document.addEventListener("visibilitychange", () => { if (document.hidden) GD.sound.cancel(); });
    // iOS Safari 回退可能从 bfcache 恢复同一上下文：恢复推进
    window.addEventListener("pageshow", (e) => {
      if (e.persisted) { unloading = false; if (state) renderSeats(); }
    });

    $("btnStart").onclick = () => {
      const diff = homeDiff();
      const go = () => {
        saveDiff(diff);
        GD.store.clearLegacy(); // 已确认覆盖：旧规则存档不再保留
        state = GD.game.newMatch(diff);
        noteSaveResult(GD.store.lastSave);
        enterGame();
        dealSound();
      };
      if (GD.store.hasRaw()) {
        askConfirm("开始新游戏", "已有整场进度，开始新游戏将覆盖当前存档，确定吗？").then((yes) => {
          if (yes) go();
        });
      } else go();
    };

    $("btnPractice").onclick = () => {
      const diff = homeDiff();
      const go = () => {
        saveDiff(diff);
        state = GD.game.newPractice(diff);
        noteSaveResult(GD.store.lastSave);
        enterGame();
        dealSound();
      };
      // 练习与整场存档相互独立：覆盖确认只针对练习存档
      if (GD.store.hasPractice()) {
        askConfirm("快速一局", "已有快速一局进度，新开将覆盖它（完整对局存档不受影响），确定吗？")
          .then((yes) => { if (yes) go(); });
      } else go();
    };

    $("btnContinue").onclick = () => {
      const res = GD.store.load();
      if (res && res.error) {
        const text = res.error === "oldversion"
          ? "检测到旧版本的存档，规则已更新无法继续，是否开始新游戏？"
          : "存档已损坏无法读取，是否开始新游戏？";
        askConfirm("无法继续", text).then((yes) => {
          if (yes) {
            const diff = homeDiff();
            saveDiff(diff);
            GD.store.clearLegacy(); // 玩家确认重开：旧档此刻才删除
            state = GD.game.newMatch(diff);
            noteSaveResult(GD.store.lastSave);
            enterGame();
            dealSound();
          }
        });
        return;
      }
      if (!res) return;
      state = res;
      state.paused = false; // 从首页回来时解除暂停
      noteSaveResult(GD.store.save(state));
      enterGame(); // 恢复对局：不触发发牌音
    };

    $("btnPracticeContinue").onclick = () => {
      const res = GD.store.loadPractice();
      if (res && res.error) {
        askConfirm("无法继续", "快速一局存档已损坏，是否重新开始？").then((yes) => {
          if (!yes) return;
          const diff = homeDiff();
          saveDiff(diff);
          GD.store.clearPractice();
          state = GD.game.newPractice(diff);
          noteSaveResult(GD.store.lastSave);
          enterGame();
          dealSound();
        });
        return;
      }
      if (!res) return;
      state = res;
      state.paused = false;
      noteSaveResult(GD.store.save(state));
      enterGame();
    };

    $("btnHomeRules").onclick = () => openRules();
    $("btnRules").onclick = () => openRules();
    $("btnRulesClose").onclick = () => closeRules();

    $("btnHomeSettings").onclick = () => openSettings();
    $("btnSettings").onclick = () => openSettings();
    $("btnSettingsClose").onclick = () => closeSettings();
    bindSettingsInputs();

    $("btnHomeStats").onclick = () => openStats();
    $("btnStats").onclick = () => openStats();
    $("btnStatsClose").onclick = () => closeStats();
    $("btnStatsReset").onclick = () => {
      askConfirm("重置战绩", "确定清空本机全部完整对局与快速一局战绩吗？此操作不可恢复。").then((yes) => {
        if (!yes) return;
        GD.stats.reset();
        fillStats();
      });
    };

    $("btnPause").onclick = () => {
      toggleRecorder(false);
      historyView.close();
      if (!state) return;
      state.paused = true;
      noteSaveResult(GD.store.save(state));
      thinkingSeat = -1;
      if (GD.fx) GD.fx.cancel(); // 暂停：立即清理在途特效/rAF/定时器
      GD.sound.cancel();
      renderAll();
      show("pauseOverlay");
      $("btnResume").focus();
    };
    $("btnResume").onclick = () => {
      state.paused = false;
      noteSaveResult(GD.store.save(state));
      hide("pauseOverlay");
      resetTemp();
      renderAll();
      kick();
      $("btnPause").focus();
    };
    $("btnPauseHome").onclick = () => {
      hide("pauseOverlay");
      state.paused = true; // 回首页期间暂停一切
      noteSaveResult(GD.store.save(state));
      if (GD.fx) GD.fx.cancel();
      GD.sound.cancel();
      show("homeOverlay");
      refreshContinueEntry();
    };

    $("btnNew").onclick = () => {
      if (!state) return;
      const practice = state.mode === "practice";
      const title = practice ? "重开快速一局" : "重开完整对局";
      const text = practice
        ? "将重新发牌并覆盖当前快速一局进度，完整对局存档不受影响。确定重开吗？"
        : "将放弃当前完整对局进度，从打 2 重新开始，快速一局存档不受影响。确定重开吗？";
      askConfirm(title, text).then((yes) => {
        if (!yes) return;
        const diff = state.difficulty;
        if (practice) state = GD.game.newPractice(diff);
        else {
          GD.store.clearLegacy();
          state = GD.game.newMatch(diff);
        }
        noteSaveResult(GD.store.lastSave);
        enterGame();
        dealSound();
      });
    };

    $("btnMatchRestart").onclick = () => {
      const diff = state ? state.difficulty : "normal";
      GD.store.clearLegacy();
      state = GD.game.newMatch(diff);
      noteSaveResult(GD.store.lastSave);
      enterGame();
      dealSound();
    };
    $("btnMatchHome").onclick = () => {
      hide("matchEndOverlay");
      state.paused = true;
      noteSaveResult(GD.store.save(state));
      if (GD.fx) GD.fx.cancel();
      GD.sound.cancel();
      show("homeOverlay");
      refreshContinueEntry();
    };

    $("btnSettleNext").onclick = () => {
      hide("settleOverlay");
      if (state.mode === "practice") {
        // 快速一局结束回首页（存档保留，可从继续入口回看结果）
        state.paused = true;
        noteSaveResult(GD.store.save(state));
        show("homeOverlay");
        refreshContinueEntry();
        return;
      }
      noteSaveResult(GD.game.continueAfterHand(state));
      if (state.phase === "matchEnd") {
        if (!matchSoundKeys.has(state.matchId)) {
          matchSoundKeys.add(state.matchId);
          GD.sound.play(state.matchWinner === 0 ? "win" : "lose");
        }
      } else {
        dealSound(); // 新一副已发（可能先进入进贡环节）
      }
      resetTemp();
      renderAll();
      kick();
    };

    $("btnPracticeAgain").onclick = () => {
      hide("settleOverlay");
      state = GD.game.newPractice(state.difficulty);
      noteSaveResult(GD.store.lastSave);
      enterGame();
      dealSound();
    };

    $("btnPlay").onclick = humanPlay;
    $("btnPass").onclick = humanPass;
    $("btnHint").onclick = humanHint;
    $("btnClear").onclick = () => { selected = new Set(); clearHint(); renderHand(); updateButtons(); };
    $("btnAuto").onclick = () => {
      state.autoPilot = !state.autoPilot;
      noteSaveResult(GD.store.save(state));
      selected = new Set();
      resetTemp();
      renderAll();
      kick(); // 取消托管靠 flow 上下文失效：旧等待回调立即作废，不会续出
    };
    $("btnOrganize").onclick = () => {
      if (!state || state.phase !== "play") return;
      state.organize = !state.organize;
      noteSaveResult(GD.store.save(state));
      renderHand();
      updateButtons();
    };

    $("btnSaveRetry").onclick = retrySave;
    $("btnRecorder").onclick = () => toggleRecorder($("recorderPanel").classList.contains("hidden"));
    $("btnRecorderClose").onclick = () => { toggleRecorder(false); $("btnRecorder").focus(); };

    const box = $("handCards");
    $("btnHandLeft").onclick = () => scrollHand(-1);
    $("btnHandRight").onclick = () => scrollHand(1);
    box.addEventListener("pointerdown", onPointerDown);
    // 点击/拖选/触屏按下：立刻撤掉键盘焦点框（focus 事件随后也不会再加回）
    box.addEventListener("pointerdown", onHandPointerNav);
    box.addEventListener("focus", onHandFocus);
    box.addEventListener("blur", onHandBlur);
    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp);
    document.addEventListener("pointercancel", cancelGesture);
    box.addEventListener("scroll", updateScrollHints, { passive: true });
    const resizeHand = () => {
      if (!state) return;
      requestAnimationFrame(() => { layoutHand(); updateScrollHints(); });
    };
    window.addEventListener("resize", resizeHand);
    if (window.ResizeObserver) new window.ResizeObserver(resizeHand).observe($("app"));
  }

  /* ================= 设置 ================= */
  function applyUISettings() {
    settings = GD.store.loadSettings();
    GD.sound.setMuted(!settings.sound);
    GD.sound.setVolume(settings.volume);
    GD.sound.setVoice(settings.voice, settings.voiceStyle);
    document.body.classList.toggle("reduce-motion", !!settings.reduceMotion);
    if (state) renderAutoTag();
  }

  function bindSettingsInputs() {
    const handler = () => {
      const cur = GD.store.loadSettings();
      cur.sound = $("setSound").checked;
      cur.voice = $("setVoice").checked;
      cur.voiceStyle = $("setVoiceStyle").value;
      cur.volume = Number($("setVolume").value);
      cur.reduceMotion = $("setMotion").checked;
      GD.store.saveSettings(cur);
      settings = cur;
      GD.sound.setMuted(!cur.sound);
      GD.sound.setVolume(cur.volume);
      GD.sound.setVoice(cur.voice, cur.voiceStyle);
      updateVoiceControls(cur);
      if (cur.sound) GD.sound.play("click");
      document.body.classList.toggle("reduce-motion", cur.reduceMotion);
      if (state) renderAutoTag();
    };
    $("setSound").onchange = handler;
    $("setVoice").onchange = handler;
    $("setVoiceStyle").onchange = handler;
    $("btnVoicePreview").onclick = () => GD.sound.preview($("setVoiceStyle").value);
    $("setMotion").onchange = handler;
    $("setVolume").oninput = handler;
  }

  function fillSettings() {
    const s = GD.store.loadSettings();
    $("setSound").checked = !!s.sound;
    $("setVoice").checked = s.voice !== false;
    $("setVoiceStyle").value = s.voiceStyle || "roles";
    $("setVolume").value = s.volume;
    $("setMotion").checked = !!s.reduceMotion;
    updateVoiceControls(s);
  }

  function updateVoiceControls(s) {
    $("setVoice").disabled = !s.sound;
    $("setVoiceStyle").disabled = !s.sound || s.voice === false;
    $("btnVoicePreview").disabled = !s.sound || s.voice === false || !s.volume;
    $("btnVoicePreview").textContent = s.voiceStyle === "roles" ? "试听四家" : "试听";
    $("voiceRoleHint").classList.toggle("hidden", s.voiceStyle !== "roles");
  }

  function openPanel(which) {
    const tag = which === "settings" ? "settings" : "stats";
    let from;
    if (!$("pauseOverlay").classList.contains("hidden")) from = "pause";
    else if (!$("homeOverlay").classList.contains("hidden")) from = "home";
    else from = "game";
    savedFocus = document.activeElement;
    if (from === "pause") hide("pauseOverlay");
    else if (from === "home") hide("homeOverlay");
    else modalPauseGame();
    if (tag === "settings") { settingsFrom = from; fillSettings(); show("settingsOverlay"); }
    else { statsFrom = from; fillStats(); show("statsOverlay"); }
    setTimeout(() => $(tag === "settings" ? "btnSettingsClose" : "btnStatsClose").focus(), 30);
  }
  const openSettings = () => openPanel("settings");
  const openStats = () => openPanel("stats");

  function restoreFocus() {
    const f = savedFocus;
    savedFocus = null;
    setTimeout(() => {
      if (f && f.focus && document.contains(f) && f.offsetParent !== null) f.focus();
    }, 30);
  }

  function closeSettings() {
    GD.sound.cancel();
    hide("settingsOverlay");
    const from = settingsFrom;
    settingsFrom = null;
    applyUISettings();
    if (from === "pause") show("pauseOverlay");
    else if (from === "home") { show("homeOverlay"); refreshContinueEntry(); }
    else modalResume();
    restoreFocus();
  }

  /* ================= 本地战绩 ================= */
  function pct(w, n) { return n ? Math.round((w / n) * 100) + "%" : "—"; }
  function statBlock(title, b, withStreak) {
    const lines = [
      `<div class="stats-title">${title}</div>`,
      `<div class="stats-grid">`,
      `<div><b>${b.played}</b><span>${withStreak ? "完成整场" : "完成副数"}</span></div>`,
      `<div><b>${b.won}</b><span>获胜</span></div>`,
      `<div><b>${pct(b.won, b.played)}</b><span>胜率</span></div>`,
      `<div><b>${b.head}</b><span>你的头游</span></div>`,
      `<div><b>${b.tail}</b><span>你的末游</span></div>`,
      `<div><b>${b.bombs}</b><span>你打出的炸弹</span></div>`,
      `</div>`,
    ];
    if (withStreak) {
      lines.push(`<div class="stats-streak">当前连胜 <b>${b.streak}</b> ｜ 最佳连胜 <b>${b.bestStreak}</b></div>`);
    }
    return lines.join("");
  }

  function fillStats() {
    const d = GD.stats.load();
    $("statsBody").innerHTML =
      statBlock("完整对局", d.match, true) + statBlock("快速一局", d.practice, false) +
      `<p class="set-note">战绩只保存在本机浏览器，按完成的真实对局计数，刷新页面不会重复统计。</p>`;
  }

  function closeStats() {
    hide("statsOverlay");
    const from = statsFrom;
    statsFrom = null;
    if (from === "pause") show("pauseOverlay");
    else if (from === "home") { show("homeOverlay"); refreshContinueEntry(); }
    else modalResume();
    restoreFocus();
  }

  /* ================= 存档失败提示 ================= */
  // 所有对局存档结果统一走这里：失败显示持续横幅，成功时清除；不弹打扰式提示
  function noteSaveResult(r) {
    if (!r) return;
    if (r.ok) hideSaveWarn();
    else showSaveWarn(r.error);
  }
  function showSaveWarn(error) {
    const text = error === "quota"
      ? "进度未能保存（存储空间可能已满），刷新页面可能丢失本局"
      : "进度未能保存（浏览器存储不可用），刷新页面可能丢失本局";
    $("saveWarnText").textContent = text;
    $("saveWarn").classList.remove("hidden");
  }
  function hideSaveWarn() { $("saveWarn").classList.add("hidden"); }
  function retrySave() {
    if (!state) return;
    noteSaveResult(GD.store.save(state));
  }
  /* ================= 弹窗暂停 ================= */
  function modalPauseGame() {
    if (state && !state.paused) {
      state.paused = true;
      modalPause = true;
      noteSaveResult(GD.store.save(state));
    }
    if (state) renderSeats();
    seatPlayView.clear();
    historyView.close();
    if (GD.fx) GD.fx.cancel(); // 暂停/开弹窗：立即清理在途特效与定时器
    GD.sound.cancel();
  }
  function modalResume() {
    if (modalPause && state) {
      state.paused = false;
      modalPause = false;
      noteSaveResult(GD.store.save(state));
      resetTemp();
      renderAll();
      kick();
    }
  }

  function openRules() {
    // 记录来源：暂停菜单 / 首页 / 对局中直接打开
    if (!$("pauseOverlay").classList.contains("hidden")) rulesFrom = "pause";
    else if (!$("homeOverlay").classList.contains("hidden")) rulesFrom = "home";
    else rulesFrom = "game";

    savedFocus = document.activeElement;
    // 规则始终是唯一可操作前景：先隐藏来源层，避免同层叠加互相模糊/截获操作
    if (rulesFrom === "pause") hide("pauseOverlay");
    else if (rulesFrom === "home") hide("homeOverlay");
    else modalPauseGame(); // 对局中打开：临时暂停
    show("rulesOverlay");
    setTimeout(() => $("btnRulesClose").focus(), 30);
  }

  function closeRules() {
    hide("rulesOverlay");
    const from = rulesFrom;
    rulesFrom = null;
    // 关闭后精确回到来源层
    if (from === "pause") show("pauseOverlay");
    else if (from === "home") { show("homeOverlay"); refreshContinueEntry(); }
    else modalResume(); // 对局中打开：恢复打开前的运行状态
    restoreFocus();
  }

  function onKeydown(e) {
    if (e.key === "Escape" && !$("recorderPanel").classList.contains("hidden")) {
      e.preventDefault(); toggleRecorder(false); $("btnRecorder").focus(); return;
    }
    // Tab 切换焦点属于键盘导航：先于随后触发的 focus 事件置位
    if (e.key === "Tab") pointerNav = false;
    // 焦点在手牌区：方向键/空格/回车（弹窗、暂停、托管、非玩家回合时自动失效）
    if (document.activeElement === $("handCards") && onHandKey(e)) return;
    if (e.key === "Escape" && activeModal) {
      const close = {
        confirmOverlay: () => $("btnConfirmNo").click(),
        rulesOverlay: closeRules,
        settingsOverlay: closeSettings,
        statsOverlay: closeStats,
        pauseOverlay: () => $("btnResume").click(),
      }[activeModal.id];
      if (close) { e.preventDefault(); close(); return; }
    }
    // 焦点陷阱：Tab/Shift+Tab 只在当前最上层模态窗口内循环
    if (e.key === "Tab" && activeModal) {
      const fs = focusables(activeModal);
      if (!fs.length) { e.preventDefault(); return; }
      const ix = fs.indexOf(document.activeElement);
      let next;
      if (e.shiftKey) next = ix <= 0 ? fs[fs.length - 1] : fs[ix - 1];
      else next = ix < 0 || ix === fs.length - 1 ? fs[0] : fs[ix + 1];
      e.preventDefault();
      next.focus();
    }
  }

  function focusables(root) {
    return Array.prototype.slice.call(
      root.querySelectorAll('button, [href], [tabindex], input, select, textarea'))
      .filter((e) => {
        if (e.disabled || e.getAttribute("tabindex") === "-1") return false;
        const s = getComputedStyle(e);
        return s.display !== "none" && s.visibility !== "hidden" && e.offsetWidth > 0;
      });
  }

  // 取最上层可见模态（按 z-index）；show/hide 后刷新
  function refreshActiveModal() {
    activeModal = null;
    let best = -1;
    for (const id of MODAL_IDS) {
      const el = $(id);
      if (el.classList.contains("hidden")) continue;
      const z = parseFloat(getComputedStyle(el).zIndex) || 0;
      if (z >= best) { best = z; activeModal = el; }
    }
  }

  /* ================= 人类操作 ================= */
  function afterAct(r) {
    noteSaveResult(r.saved);
    seatPlayView.notify(state, r);
    if (r.event && r.event.type === "jiefeng") {
      toast(`${NAMES[r.event.outSeat]}已出完，对家接风`);
    }
    playActionSound(r);
    // 特效需在本次提交渲染后（出牌区已是新牌）再取坐标，统一由 renderAll 末尾发放
    pendingFx = r;
    // 一副结束的结算音只在真实动作发生时触发（恢复到结算界面不重播）
    if (state.phase === "handEnd" && !endSoundKeys.has(state.handId)) {
      endSoundKeys.add(state.handId);
      GD.sound.play(state.mode === "practice"
        ? (state.handResult.winTeam === 0 ? "win" : "lose")
        : "settle");
    }
  }

  // 音效与动作同源：类型直接取 act 返回的 play 摘要，不靠界面猜测
  function playActionSound(r) {
    if (!settings.sound) return;
    GD.sound.announce(r, { key: state.matchId + ":" + state.gen, sequence: state.gen,
      level: state.currentLevel, remaining: state.hands[r.seat].length, speed: settings.speed });
    // 确认接风事件落在真正关墩的那次动作上（通常是最后一次“不要”，kind=pass）。
    // 必须在 pass 提前返回之前处理，并直接发声——不能用延迟回调，否则快速档
    // 局面推进或过期回调守卫会把这声接风铃吞掉。
    if (r.event && r.event.type === "jiefeng") {
      try { GD.sound.play("jiefeng"); } catch (e) {}
      return;
    }
    if (r.kind === "pass") { GD.sound.play("pass"); return; }
    const t = r.play && r.play.type;
    if (t === "jokers") GD.sound.play("jokers");
    else if (t === "sflush") GD.sound.play("sflush");
    else if (t && GD.rules.isBombType(r.play)) GD.sound.play("bomb");
    else if (t === "straight" || t === "dpairs" || t === "steel") GD.sound.play(t);
    else if (t) GD.sound.play("play", { pitch: r.seat === 0 ? 0 : 2 });
  }

  /* ================= 出牌特效（v1.4.0） =================
   * 人类/电脑/托管都只经 afterAct 一处触发；牌型与张数取自 act 的真实返回，
   * 完整牌型说明取本手裁决后桌上的 play 对象（含配牌映射），不靠界面猜测。
   */
  function fxDispatch(r) {
    if (!GD.fx || !r || !r.ok) return;
    const t = r.play && r.play.type;
    let kind = null;
    // 牌型主效/成型短标题只针对真实出牌；纯“不要”无牌型
    if (r.kind === "play") {
      if (t === "jokers") kind = "jokers";
      else if (t === "sflush") kind = "sflush";
      else if (t === "bomb") kind = r.play.size >= 6 ? "bomb-lg" : "bomb";
      else if (t === "straight" || t === "dpairs" || t === "steel") kind = "combo";
    }
    // 确认接风：事件来自真正关墩（最后一次不要），from=出完者、to=实际接风队友
    const jie = r.event && r.event.type === "jiefeng"
      ? { from: r.event.outSeat, to: r.event.seat, fromName: NAMES[r.event.outSeat], toName: NAMES[r.event.seat] } : null;
    if (!kind && !jie) { if (GD.fx.clearCombo) GD.fx.clearCombo(); return; }
    const onTable = state.table[r.seat];
    const fullPlay = onTable && onTable.play ? onTable.play : null;
    const COMBO_SHORT = { straight: "顺子", dpairs: "三连对", steel: "钢板" };
    let detail = fullPlay ? playTypeText(fullPlay) : t === "bomb" ? playTypeText(r.play) : GD.TYPE_LABEL[t] || "";
    // 配牌替代如实写在说明里（仅列真正替成别的牌的红桃级牌）
    if (fullPlay && Array.isArray(fullPlay.mapping)) {
      const wl = wildLines(fullPlay);
      if (wl.length) detail += "｜" + wl.join("，");
    }
    GD.fx.act({
      key: state.matchId + ":" + state.gen,
      kind: kind || "none",
      size: r.play && r.play.size,
      comboType: kind === "combo" ? t : null,
      ranks: kind === "combo" ? GD.rules.seqWindow(t, r.play.value).ranks : null,
      seat: r.seat,
      title: (kind === "jokers" ? "四大天王" : kind === "combo" ? COMBO_SHORT[t] : GD.TYPE_LABEL[t]) || "",
      detail: kind === "jokers" ? "四王炸 · 四张王牌" : detail,
      mode: settings.fx || "full",
      // 快速档缩短，慢速略放宽，标准 1
      speedMul: settings.speed === "fast" ? 0.62 : settings.speed === "slow" ? 1.15 : 1,
      reduceMotion: !!settings.reduceMotion,
      ending: state.phase === "handEnd",
      jiefeng: jie,
    });
  }

  function humanPlay() {
    if (!isHumanTurn()) return;
    const cards = state.hands[0].filter((c) => selected.has(c.id));
    if (!cards.length) return toast("请先选择要出的牌");
    const r = GD.game.act(state, 0, cards);
    if (!r.ok) return toast(r.reason);
    afterAct(r);
    resetTemp();
    renderAll();
    kick();
  }

  function humanPass() {
    if (!isHumanTurn() || state.awaiting.kind !== "follow") return;
    const r = GD.game.act(state, 0, null);
    if (!r.ok) return toast(r.reason);
    afterAct(r);
    resetTemp();
    renderAll();
    kick();
  }

  function showHint(text) { $("hintBar").textContent = text || ""; $("hintBar").title = text || ""; }
  function resetHint() { hintCands = []; hintIdx = 0; }
  function clearHint() { resetHint(); showHint(""); }
  const idKeyOf = (cards) => cards.map((c) => c.id).sort((a, b) => a - b).join(",");

  // 提示复用 recommend 的稳健策略，不随电脑难度降级：第一项即首选推荐，
  // 可推荐"不要"（只清选牌并说明，绝不自动出手）；继续按则循环合法备选。
  function humanHint() {
    if (!isHumanTurn()) return;
    if (!hintCands.length) {
      const obs = GD.observe.build(state, 0);
      const tier = "hard";
      // 提示用独立种子派生的确定性随机：同一局面首推稳定、可重现
      const rng = GD.mulberry32(
        ((((state.stratSeed || 1) ^ Math.imul(state.gen + 1, 7919) ^ 104729) >>> 0)));
      let rec = null;
      try { rec = GD.ai.recommend(obs, { tier, rng }); } catch (e) { console.error("提示异常:", e); }
      if (!rec) return toast("提示暂时不可用");
      let list = rec.candidates.slice();
      if (!list.length) {
        // 极端兜底路径（rec 已走 emergency）：候选仍从官方枚举入口构造
        if (obs.target) list = [{ action: "pass", text: "没有能压过的牌，建议不要" }];
        else list = GD.rules.enumerate(state.hands[0], state.currentLevel)
          .map((p) => ({ action: "play", cards: p.cards, play: p, text: "出牌" }));
      }
      const pick = {
        action: rec.action, cards: rec.cards, play: rec.play,
        score: rec.score, tag: rec.reason, text: rec.text,
      };
      const same = (c) => c.action === pick.action &&
        (c.action === "pass" || idKeyOf(c.cards) === idKeyOf(pick.cards));
      hintCands = [pick].concat(list.filter((c) => !same(c)));
      hintIdx = 0;
    }
    if (!hintCands.length) return;
    const c = hintCands[hintIdx];
    const label = hintIdx === 0 ? "首选推荐（稳健）" : `备选方案 ${hintIdx}`;
    hintIdx = (hintIdx + 1) % hintCands.length;
    if (c.action === "pass") {
      selected = new Set();
      renderHand();
      updateButtons();
      showHint(`${label} · 不要：${c.text}（再按提示换方案，需手动点「不要」）`);
      return;
    }
    selected = new Set(c.cards.map((x) => x.id));
    renderHand();
    updateButtons();
    showHint(`${label}：${c.text}（再按提示换方案）`);
    const first = $("handCards").querySelector(".selected");
    if (first && first.scrollIntoView) {
      first.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }

  function isHumanTurn() {
    return state && state.phase === "play" && state.awaiting && state.awaiting.seat === 0;
  }

  /* ================= 节奏驱动 ================= */
  function kick() {
    if (unloading || !$("table")) return; // 卸载中或牌桌节点尚/已不存在：不推进不渲染
    if (!state || state.paused) return;
    if (state.phase === "handEnd") {
      if (state.mode === "practice") {
        // 练习：一副即终局（此处完成战绩计数，刷新恢复同样幂等）
        const fr = GD.game.finishPractice(state);
        if (fr && fr.ok === false) { /* 已转入 matchEnd 时忽略 */ }
        else noteSaveResult(fr ? fr.saved : null);
        showPracticeEnd();
      } else showSettle();
      return;
    }
    if (state.phase === "matchEnd") {
      if (state.mode === "practice") showPracticeEnd();
      else showMatchEnd();
      return;
    }
    if (state.phase === "tribute") {
      const t = state.tribute;
      const key = `trib-${state.gen}-${t.anti}-${t.stage}-${t.idx}-${state.autoPilot}`;
      if (kickKey === key) return;
      kickKey = key;
      driveTribute();
      return;
    }
    if (state.phase !== "play") return;

    const aw = state.awaiting;
    // autoPilot 必须进 key：托管状态变化要立即重新驱动，旧回调靠 flow 校验失效
    const key = `play-${state.gen}-${aw.seat}-${aw.kind}-${state.autoPilot}`;
    if (kickKey === key) return;
    kickKey = key;

    if (aw.seat === 0) {
      thinkingSeat = -1;
      renderSeats();
      if (state.autoPilot) runAI(0);
      else updateButtons();
      return;
    }
    runAI(aw.seat);
  }

  function capsPlay(seat) {
    return GD.flow.capture(state, {
      kind: "play", seat, awKind: state.awaiting.kind, autoPilot: state.autoPilot,
    });
  }
  function capsTrib(seat, role) {
    return GD.flow.capture(state, {
      kind: "tribute", seat, role,
      stage: state.tribute.stage, idx: state.tribute.idx, autoPilot: state.autoPilot,
    });
  }
  function valid(caps) { return !!GD.flow.stillValid(state, caps); }

  async function runAI(seat) {
    const caps = capsPlay(seat);
    thinkingSeat = seat;
    renderSeats();
    renderRecorder();
    await GD.wait(aiWait());
    if (unloading || !valid(caps)) return;

    let decision;
    // 四家调用同一入口，托管与电脑都直接使用当前对局的 difficulty。
    try { decision = GD.ai.decide(state, seat); }
    catch (e) { console.error("AI decide 异常:", e); decision = null; }
    if (!valid(caps)) return;

    let r = decision ? GD.game.act(state, seat, decision.cards || null) : null;
    if (!r || !r.ok) {
      console.error("AI invalid:", r ? r.reason : "decision异常");
      if (valid(caps) && state.awaiting.kind === "follow") {
        r = GD.game.act(state, seat, null); // 跟牌兜底：不要
      } else if (valid(caps)) {
        // 领出兜底：枚举的第一个必然合法，杜绝卡死
        const safe = GD.rules.enumerate(state.hands[seat], state.currentLevel)[0];
        r = GD.game.act(state, seat, safe.cards);
        if (!r.ok) console.error("领出兜底仍失败:", r.reason);
      }
    }
    if (r && r.ok) afterAct(r);
    thinkingSeat = -1;
    resetTemp();
    renderAll();
    kick();
  }

  /* ================= 进贡流程 ================= */
  function driveTribute() {
    const t = state.tribute;
    updateTributeBanner();

    if (t.anti) {
      const myGen = state.gen;
      const matchId = state.matchId;
      GD.wait(ANTI_WAIT[settings.speed] || ANTI_WAIT.std).then(() => {
        if (unloading || !state || state.matchId !== matchId || state.paused || state.gen !== myGen) return;
        if (state.phase !== "tribute" || !state.tribute.anti) return;
        noteSaveResult(GD.game.finishAnti(state));
        resetTemp();
        renderAll();
        kick();
      });
      return;
    }

    const pair = t.pairs[t.idx];
    if (t.stage === "give") {
      if (pair.from === 0 && !state.autoPilot) { renderHand(); updateButtons(); return; }
      aiGive(pair.from);
    } else if (t.stage === "return") {
      if (pair.to === 0 && !state.autoPilot) { renderHand(); updateButtons(); return; }
      aiReturn(pair.to);
    }
  }

  async function aiGive(seat) {
    const caps = capsTrib(seat, "give");
    thinkingSeat = seat;
    renderSeats();
    await GD.wait(Math.round(aiWait() * 0.7 + 350));
    if (unloading || !valid(caps)) return;
    let card, rr;
    try { card = GD.game.autoGive(state, seat); } catch (e) { console.error(e); }
    if (card) rr = GD.game.giveTribute(state, card.id);
    if (rr && rr.ok) noteSaveResult(rr.saved);
    if (!rr || !rr.ok) console.error("自动进贡失败:", rr ? rr.reason : "无牌可选");
    thinkingSeat = -1;
    resetTemp();
    renderAll();
    if (!rr || !rr.ok) {
      // 再驱动一次，避免静默卡死（正常路径不会走到）
      kick();
      return;
    }
    kick();
  }

  async function aiReturn(seat) {
    const caps = capsTrib(seat, "return");
    thinkingSeat = seat;
    renderSeats();
    await GD.wait(Math.round(aiWait() * 0.7 + 350));
    if (unloading || !valid(caps)) return;
    let card, rr;
    try { card = GD.game.autoReturn(state, state.tribute.pairs[state.tribute.idx]); }
    catch (e) { console.error(e); }
    if (card) rr = GD.game.returnTribute(state, card.id);
    if (rr && rr.ok) noteSaveResult(rr.saved);
    if (!rr || !rr.ok) console.error("自动还贡失败:", rr ? rr.reason : "无牌可选");
    thinkingSeat = -1;
    resetTemp();
    renderAll();
    if (!rr || !rr.ok) { kick(); return; }
    kick();
  }

  function handClickInTribute(card) {
    const t = state.tribute;
    let rr = null;
    if (t.stage === "give") {
      const pair = t.pairs[t.idx];
      if (pair.from !== 0) return;
      if (GD.game.tributeOptions(state, 0).map((c) => c.id).indexOf(card.id) < 0) {
        return toast("进贡必须选择手中最大的牌（配牌除外）");
      }
      rr = GD.game.giveTribute(state, card.id);
    } else if (t.stage === "return") {
      const pair = t.pairs[t.idx];
      if (pair.to !== 0) return;
      let opts = GD.game.returnCandidates(state, pair).map((c) => c.id);
      const fb = GD.game.fallbackReturn(state, pair);
      if (fb) opts.push(fb.id);
      if (opts.indexOf(card.id) < 0) return toast("还贡需选择 ≤10 的小牌（含2，级牌除外）");
      rr = GD.game.returnTribute(state, card.id);
    }
    if (rr && rr.ok) noteSaveResult(rr.saved);
    resetTemp();
    renderAll();
    kick();
  }

  function updateTributeBanner() {
    const banner = $("tributeBanner");
    if (state.phase !== "tribute") { banner.textContent = ""; return; }
    const t = state.tribute;
    if (t.anti) { banner.textContent = "抗 贡！（头游先出）"; return; }
    if (state.autoPilot) { banner.textContent = ""; return; }

    const pair = t.pairs[t.idx];
    if (t.stage === "give") {
      if (pair.from !== 0) { banner.textContent = ""; return; }
      banner.textContent = t.pairs.length === 2
        ? `双贡第 ${t.idx + 1}/2 步：请进贡（大贡→头游，小贡→二游；选手中最大牌，配牌除外）`
        : `请向 ${NAMES[pair.to]} 进贡（手中最大牌，配牌除外）`;
    } else if (t.stage === "return") {
      if (pair.to !== 0) { banner.textContent = ""; return; }
      banner.textContent = `第 ${t.idx + 1}/${t.pairs.length} 步：请向 ${NAMES[pair.from]} 还贡（≤10 小牌，含2，级牌除外）`;
    } else banner.textContent = "";
  }
  /* ================= 渲染 ================= */
  function renderAll() {
    // 卸载排空（pagehide 之后）或 DOM 未就绪：整轮渲染直接放弃，杜绝在 null 节点上写入
    if (unloading || !$("table")) return;
    $("table").dataset.phase = state.phase;
    $("btnNew").textContent = state.mode === "practice" ? "重开快速一局" : "重开完整对局";
    kickKey = "";
    renderLevels();
    renderSeats();
    renderHand();
    updateButtons();
    renderCenterHint();
    renderAutoTag();
    updateTributeBanner();
    historyView.render(state);
    seatPlayView.sync(state, settings);
    if (pendingFx) {
      const r = pendingFx; pendingFx = null;
      // 必须同步发放：若本手直接打完一副，紧接的 kick()→结算面板会取走 fx 徽章
      fxDispatch(r);
    }
  }

  function renderAutoTag() {
    const el = $("autoTag");
    if (!el || !state) return;
    el.textContent = state.autoPilot
      ? "托管 · " + ({ easy: "简单", normal: "普通", hard: "困难" }[state.difficulty] || "普通")
      : "";
  }

  function renderLevels() {
    if (state.mode === "practice") {
      $("levelBoard").innerHTML =
        `<span class="lvl-chip practice-chip">快速一局</span>` +
        `<span class="lvl-chip current-level">本局打 <b>${GD.LEVEL_NAME[state.currentLevel]}</b></span>`;
      return;
    }
    const L = GD.LEVEL_NAME;
    $("levelBoard").innerHTML =
      `<span class="lvl-chip">我方 <b>${L[state.levels[0]]}</b></span>` +
      `<span class="lvl-chip current-level">本局打 <b>${L[state.currentLevel]}</b></span>` +
      `<span class="lvl-chip team1">对方 <b>${L[state.levels[1]]}</b></span>`;
  }

  function toggleRecorder(open) {
    $("recorderPanel").classList.toggle("hidden", !open);
    $("btnRecorder").setAttribute("aria-expanded", String(open));
    if (open) renderRecorder();
  }

  function renderRecorder() {
    if (!state) return;
    const played = state.pile.concat(...state.table.filter((item) => item && item !== "pass").map((item) => item.cards));
    const counts = GD.tableTools.remainingCounts(state.hands[0], played);
    const ranks = [17, 16, state.currentLevel];
    for (let rank = 14; rank >= 2; rank--) if (rank !== state.currentLevel) ranks.push(rank);
    const grid = $("recorderGrid");
    grid.innerHTML = "";
    for (const rank of ranks) {
      const cell = GD.el("div", "recorder-cell" + (counts[rank] === 0 ? " depleted" : "") +
        (rank === state.currentLevel ? " level-rank" : ""));
      cell.dataset.rank = rank;
      cell.setAttribute("aria-label", `${GD.RANK_NAME[rank]}，剩余 ${counts[rank]} 张`);
      cell.appendChild(GD.el("span", "recorder-rank", GD.RANK_NAME[rank]));
      cell.appendChild(GD.el("b", "recorder-count", String(counts[rank])));
      grid.appendChild(cell);
    }
    $("recorderTotal").textContent = Object.values(counts).reduce((sum, n) => sum + n, 0);
  }

  function renderCount(seatEl, count) {
    const low = count > 0 && count <= 2;
    seatEl.querySelector(".count").textContent = count;
    seatEl.querySelector(".count-label").textContent = low ? "仅剩" : "手牌";
    seatEl.querySelector(".seat-count").classList.toggle("low-count", low);
  }

  function activeSeat() {
    if (state.phase === "play") return state.awaiting.seat;
    if (state.phase === "tribute" && !state.tribute.anti) {
      const t = state.tribute, pair = t.pairs[t.idx];
      return t.stage === "give" ? pair.from : t.stage === "return" ? pair.to : -1;
    }
    return -1;
  }

  // 四个座位共用同一状态优先级，过牌标记只取当前墩的公开动作。
  function renderSeatState(el, seat) {
    const finished = state.finished.indexOf(seat) >= 0;
    const turn = !state.paused && activeSeat() === seat;
    const thinking = turn && thinkingSeat === seat;
    let kind = "waiting", label = "";
    if (state.paused) { kind = "paused"; }
    else if (finished) { kind = "finished"; label = "已出完"; }
    else if (turn) {
      kind = thinking ? "thinking" : "turn";
      // 活动头像的金色光圈指向座位，回合文字只在中央显示一次。
    } else if (state.phase === "play" && state.table[seat] === "pass") {
      kind = "passed"; label = "已不出";
    } else if (GD.tableView.seatAction(state, seat)?.kind === "play") {
      kind = "played"; label = "已出牌";
    }
    el.dataset.state = kind;
    el.classList.toggle("is-turn", turn);
    el.classList.toggle("is-thinking", thinking);
    if (turn) el.setAttribute("aria-current", "true");
    else el.removeAttribute("aria-current");
    el.querySelector(".seat-state").textContent = label;
  }

  function renderTurnIndicator() {
    const el = $("turnIndicator"), seat = activeSeat();
    const paused = state.paused;
    el.classList.toggle("your-turn", !paused && seat === 0);
    el.classList.toggle("is-thinking", !paused && thinkingSeat === seat && seat >= 0);
    el.classList.toggle("is-paused", !!paused);
    if (paused) el.textContent = "对局已暂停";
    else if (state.phase === "tribute") {
      el.textContent = state.tribute.anti ? "抗贡 · 等待开局"
        : `${NAMES[seat]}正在${state.tribute.stage === "give" ? "进贡" : "还贡"}`;
    } else if (state.phase !== "play") el.textContent = "本局已结束";
    else if (seat === 0) el.textContent = state.autoPilot ? "你的回合 · 托管中"
      : state.awaiting.kind === "lead" ? "轮到你领出" : "轮到你跟牌";
    else el.textContent = `等待${NAMES[seat]}${state.awaiting.kind === "lead" ? "领出" : "跟牌"}${thinkingSeat === seat ? " · 思考中…" : ""}`;
  }

  function renderSeats() {
    for (let s = 1; s <= 3; s++) {
      const seatEl = $("seat-" + s);
      seatEl.classList.toggle("finished", state.finished.indexOf(s) >= 0);
      renderSeatState(seatEl, s);
      renderCount(seatEl, state.hands[s].length);

      const fIdx = state.finished.indexOf(s);
      $("rank-" + s).textContent = fIdx >= 0 ? RANK_WORDS[fIdx] : "";
    }

    // 自己
    const selfEl = $("selfStatus");
    selfEl.classList.toggle("finished", state.finished.indexOf(0) >= 0);
    renderSeatState(selfEl, 0);
    renderCount(selfEl, state.hands[0].length);
    $("rank-0").textContent =
      state.finished.indexOf(0) >= 0 ? RANK_WORDS[state.finished.indexOf(0)] : "";
    renderTurnIndicator();
    turnClock.sync(state);
  }

  function renderCenterHint() {
    activePlayView.render(state);
    const context = $("actionContext");
    context.textContent = state.phase === "play" && state.awaiting.seat === 0 && !state.autoPilot
      ? (state.awaiting.kind === "lead" ? "选择手牌，开始这一墩" : "选择手牌或不出") : "";
  }

  // 进贡/还贡阶段：返回人类玩家当前可提交的牌 id 集合（与游戏判定完全一致）
  function tributePickIds() {
    if (state.phase !== "tribute" || state.autoPilot) return null;
    const t = state.tribute;
    const pair = t.pairs[t.idx];
    if (t.stage === "give") {
      if (pair.from !== 0) return null;
      return new Set(GD.game.tributeOptions(state, 0).map((c) => c.id));
    }
    if (t.stage === "return" && pair.to === 0) {
      const ids = GD.game.returnCandidates(state, pair).map((c) => c.id);
      const fb = GD.game.fallbackReturn(state, pair);
      if (fb && ids.indexOf(fb.id) < 0) ids.push(fb.id);
      return new Set(ids);
    }
    return null;
  }

  /* ================= 扫选 / Shift 范围 / 键盘 ================= */
  // 手牌操作可用：玩家回合出牌阶段，非托管/暂停/弹窗
  function canHandPick() {
    return !!state && state.phase === "play" && !!state.awaiting &&
      state.awaiting.seat === 0 && !state.autoPilot && !state.paused && !activeModal;
  }

  // 当前屏幕上的手牌顺序（含理牌顺序），身份一律以 id 保持
  function displayOrder() {
    if (!state) return [];
    return GD.tableTools.handView(state.hands[0], state.currentLevel,
      state.phase === "play" && state.organize).cards;
  }

  function cardAtPoint(x, y) {
    let el;
    try { el = document.elementFromPoint(x, y); } catch (e) { return null; }
    while (el && !(el.classList && el.classList.contains("card"))) el = el.parentElement;
    if (!el || !el.dataset.id) return null;
    return $("handCards").contains(el) ? el : null;
  }

  function gestureApply(el, mode) {
    const id = Number(el.dataset.id);
    if (mode === "add") { selected.add(id); el.classList.add("selected"); }
    else { selected.delete(id); el.classList.remove("selected"); }
    clearHint();
    updateButtons();
  }

  function onPointerDown(e) {
    if (e.pointerType !== "mouse" || e.button !== 0) return;
    if (!canHandPick()) return;
    const el = cardAtPoint(e.clientX, e.clientY);
    if (!el) return;
    const id = Number(el.dataset.id);
    lastGestureIds = null;

    // Shift 按下：按当前屏幕序做连续范围；范围不另起手势
    if (e.shiftKey) { applyShiftRange(id); return; }

    // 手势方向由按下牌的当前状态一次固定：选中→整段取消，未选→整段选中
    const mode = selected.has(id) ? "remove" : "add";
    gesture = { mode, processed: new Set([id]), gen: state.gen };
    gestureApply(el, mode);
    rangeAnchor = { id };
  }

  function onPointerMove(e) {
    if (!gesture || e.pointerType !== "mouse") return;
    // 局面变化（出牌/暂停等）立即结束手势，杜绝残留状态
    if (!canHandPick() || state.gen !== gesture.gen) { cancelGesture(); return; }
    const el = cardAtPoint(e.clientX, e.clientY);
    if (!el) return;
    const id = Number(el.dataset.id);
    if (gesture.processed.has(id)) return; // 同张牌一次手势只处理一次，反扫不翻回
    gesture.processed.add(id);
    gestureApply(el, gesture.mode);
  }

  function onPointerUp() {
    if (gesture) {
      lastGestureIds = gesture.processed;
      lastGestureAt = Date.now();
    }
    gesture = null;
  }
  function cancelGesture() { gesture = null; }

  // Shift 连续范围：锚点为上一次普通点选的牌，无锚点时以当前牌为锚
  function applyShiftRange(id) {
    const order = displayOrder().map((c) => c.id);
    const end = order.indexOf(id);
    let start = rangeAnchor ? order.indexOf(rangeAnchor.id) : -1;
    if (start < 0) { start = end; rangeAnchor = { id }; }
    const lo = Math.min(start, end), hi = Math.max(start, end);
    const box = $("handCards");
    for (let i = lo; i <= hi; i++) {
      selected.add(order[i]);
      const el = box.querySelector(`[data-id="${order[i]}"]`);
      if (el) el.classList.add("selected");
    }
    clearHint();
    // Shift 操作后同样吞掉这一次 click，避免点击监听重复处理
    lastGestureIds = new Set([id]);
    lastGestureAt = Date.now();
    updateButtons();
  }

  /* ----- 键盘 ----- */
  function onHandFocus() {
    if (!state) return;
    // 鼠标点击/拖选/触屏引发的聚焦只保留焦点本身，不显示蓝色焦点牌；
    // 只有键盘（Tab/方向键）进入或操作时才显示
    if (pointerNav) { kbActive = false; clearKbFocus(); return; }
    kbActive = true;
    const order = displayOrder();
    if (kbIndex < 0 || kbIndex >= order.length) kbIndex = 0;
    refreshKbFocus();
  }
  function onHandBlur() {
    // 保留 kbIndex 供重新键盘聚焦时恢复，只去掉视觉类
    kbActive = false;
    clearKbFocus();
  }
  function clearKbFocus() {
    const box = $("handCards");
    if (!box) return;
    box.querySelectorAll(".kb-focus").forEach((e) => {
      e.classList.remove("kb-focus");
      if (e.id === "kb-focus-card") e.removeAttribute("id");
    });
    box.removeAttribute("aria-activedescendant");
  }
  function refreshKbFocus() {
    const box = $("handCards");
    box.querySelectorAll(".kb-focus").forEach((e) => {
      e.classList.remove("kb-focus");
      if (e.id === "kb-focus-card") e.removeAttribute("id");
    });
    const order = displayOrder();
    if (kbIndex < 0 || kbIndex >= order.length) return;
    const el = box.querySelector(`[data-id="${order[kbIndex].id}"]`);
    if (el) {
      el.classList.add("kb-focus");
      el.id = "kb-focus-card";
      box.setAttribute("aria-activedescendant", "kb-focus-card");
    }
  }
  // 指针在了你手牌区按下：此后焦点牌不再显示（直到下次 Tab/方向键）
  function onHandPointerNav() {
    pointerNav = true;
    kbActive = false;
    clearKbFocus();
  }

  // 焦点在手牌区时的按键；返回是否已处理
  function onHandKey(e) {
    if (!canHandPick()) return false;
    const order = displayOrder();
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      // 方向键属于键盘操作：即使焦点最初由点击获得，也立即显示焦点牌
      pointerNav = false;
      kbActive = true;
      if (kbIndex < 0 || kbIndex >= order.length) kbIndex = 0;
      kbIndex += e.key === "ArrowRight" ? 1 : -1;
      kbIndex = Math.max(0, Math.min(order.length - 1, kbIndex));
      refreshKbFocus();
      const el = $("handCards").querySelector(".kb-focus");
      if (el) el.scrollIntoView({ block: "nearest", inline: "nearest" });
      return true;
    }
    if (e.key === " " || e.key === "Spacebar") {
      e.preventDefault();
      if (kbIndex < 0 || kbIndex >= order.length) kbIndex = 0;
      const card = order[kbIndex];
      if (selected.has(card.id)) { selected.delete(card.id); }
      else selected.add(card.id);
      rangeAnchor = { id: card.id };
      const el = $("handCards").querySelector(`[data-id="${card.id}"]`);
      if (el) el.classList.toggle("selected");
      clearHint();
      updateButtons();
      return true;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      humanPlay(); // 内部再校验轮次与合法性
      return true;
    }
    return false;
  }
  function renderHand() {
    const box = $("handCards");
    // 全量重建会让内容宽度瞬间变化，先记下滚动位置，layoutHand 后恢复
    const savedScroll = box.scrollLeft;
    box.innerHTML = "";
    if (!state) return;
    const clickable = state.phase === "play" || state.phase === "tribute";
    const pickIds = tributePickIds();

    const display = GD.tableTools.handView(state.hands[0], state.currentLevel,
      state.phase === "play" && state.organize);
    const view = display.cards;
    let inGroupIdx = new Set();
    const groupAt = new Map();
    for (const g of display.groups) {
      for (let k = 0; k < g.len; k++) {
        inGroupIdx.add(g.start + k); groupAt.set(g.start + k, g);
      }
    }

    for (let i = 0; i < view.length; i++) {
      const c = view[i];
      const e = cardEl(c, false, state.currentLevel);
      e.dataset.id = c.id;
      e.dataset.rank = c.rank;
      const group = groupAt.get(i);
      // 已理出的整组牌共用一列，包括点数不同的同花顺。
      e.dataset.stack = group
        ? `group-${group.start}-${group.type}`
        : `rank-${c.rank}`;
      if (selected.has(c.id)) e.classList.add("selected");
      if (inGroupIdx.has(i)) e.classList.add("in-group");
      if (group) {
        e.dataset.groupRank = group.rank;
        const previous = groupAt.get(i - 1);
        if (i && (!previous || previous.type !== group.type)) e.dataset.break = "1";
        const front = i === group.start + group.len - 1;
        if (front) e.appendChild(GD.el("div", "group-flag g-" + group.type, group.label));
      } else if (display.groups.length && i === display.looseStart) {
        e.dataset.break = "1";
      }
      if (pickIds) {
        // 候选牌金色描边；不可选牌弱化（仍可点击获取原因提示）
        e.classList.add(pickIds.has(c.id) ? "tribute-pick" : "pick-off");
      } else if (!clickable) e.classList.add("disabled");

      e.addEventListener("click", () => {
        if (state.phase === "tribute") { handClickInTribute(c); return; }
        if (state.phase !== "play" || !state.awaiting || state.awaiting.seat !== 0) return;
        // 鼠标手势（含普通点击，已在 pointerdown 处理）/ Shift 范围后的同次 click 必须吞掉，
        // 不能在 mouseup 时再翻一次；时间窗之外（如稍后的触屏点按）照常处理
        if (lastGestureIds && Date.now() - lastGestureAt < 600 &&
            lastGestureIds.has(c.id)) return;
        if (state.autoPilot || state.paused || activeModal) return;
        // 点选路径（触屏点按等）：只切换本牌 class，不触发全量重绘，
        // 滚动位置、叠放完全不动
        if (selected.has(c.id)) { selected.delete(c.id); e.classList.remove("selected"); }
        else { selected.add(c.id); e.classList.add("selected"); }
        rangeAnchor = { id: c.id };
        clearHint();
        updateButtons();
      });
      box.appendChild(e);
    }
    requestAnimationFrame(() => {
      layoutHand();
      const max = Math.max(0, box.scrollWidth - box.clientWidth);
      box.scrollLeft = Math.min(savedScroll, max);
      updateScrollHints();
      // 重建后只有“键盘焦点会话”仍在时才恢复焦点牌；指针点击获得的焦点
      // 在重绘（如 AI 出牌、提示、理牌切换）后不得重新冒出第一张牌蓝框
      if (document.activeElement === box && kbActive) refreshKbFocus();
    });
  }

  function updateScrollHints() {
    const box = $("handCards");
    const viewport = box.parentElement;
    const max = box.scrollWidth - box.clientWidth;
    const left = box.scrollLeft > 2, right = box.scrollLeft < max - 2;
    viewport.classList.toggle("can-left", left);
    viewport.classList.toggle("can-right", right);
    for (const [id, visible] of [["btnHandLeft", left], ["btnHandRight", right]]) {
      const button = $(id);
      button.disabled = !visible;
      button.classList.toggle("hidden", !visible);
      if (!visible && document.activeElement === button) box.focus({ preventScroll: true });
    }
  }

  function scrollHand(direction) {
    const box = $("handCards");
    const reduced = settings.reduceMotion || (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    box.scrollBy({ left: direction * box.clientWidth * .75, behavior: reduced ? "auto" : "smooth" });
  }

  function layoutHand() {
    const box = $("handCards");
    const els = box.children;
    const n = els.length;
    if (!n) {
      box.style.height = ""; box.style.setProperty("--hand-width", "0px");
      box.classList.remove("dense-stacks"); delete $("table").dataset.handRows;
      return;
    }
    const viewportHeight = Math.min(window.innerHeight, $("app").clientHeight || window.innerHeight);
    const short = viewportHeight <= 420, compact = viewportHeight <= 560;
    const cw = els[0].offsetWidth, ch = els[0].offsetHeight;
    const normalStep = short ? 18 : compact ? 28 : 42, paddingTop = short ? 8 : 12;
    const handBudget = viewportHeight * (short ? .37 : compact ? .39 : .35);
    const maxRows = Math.max(short ? 3 : 4, Math.min(short ? 3 : 8, Math.floor(
      (handBudget - paddingTop - ch - 8) / normalStep) + 1));
    const items = Array.from(els, (e) => ({
      rank: e.dataset.rank, stack: e.dataset.stack, break: e.dataset.break === "1",
    }));
    let rows = 0, run = 0, lastKey;
    const finishRun = () => { rows = Math.max(rows, run === 5 ? 5 : Math.min(maxRows, run)); };
    for (const item of items) {
      const key = item.stack || item.rank;
      if (key !== lastKey || item.break) { finishRun(); run = 0; }
      run++; lastKey = key;
    }
    finishRun();
    const stepY = rows >= 5 ? Math.max(short ? 12 : 20, Math.min(normalStep,
      Math.floor((handBudget - paddingTop - ch - 8) / (rows - 1)))) : normalStep;
    box.classList.toggle("dense-stacks", stepY < normalStep);
    box.style.setProperty("--stack-pitch", stepY + "px");
    box.style.setProperty("--stack-corner-size", Math.max(8, Math.floor((stepY - (short ? 4 : 6)) / 1.05)) + "px");
    $("table").dataset.handRows = rows;
    // 按真实牌角测量最小露出宽度；空间稍紧时增加重叠，保留完整点数和花色。
    const cornerWidth = Math.max(...Array.from(els, (e) => {
      const corner = e.querySelector(".corner");
      return (corner.offsetLeft || 0) + corner.offsetWidth;
    }));
    const minStepX = Math.ceil(cornerWidth + 4);
    const options = {
      cardWidth: cw, cardHeight: ch, availableWidth: box.clientWidth, stepY, maxRows, keepFiveTogether: true,
      minStepX, maxStepX: Math.max(minStepX, cw - (short ? 4 : compact ? 12 : 22)),
      gap: short ? 8 : 16, paddingTop, paddingX: 16 };
    let layout = GD.tableTools.stackLayout(items, options);
    // 真正需要滚动时，两端留出翻看按钮和选中描边的空间。
    if (layout.width > box.clientWidth + .5) layout = GD.tableTools.stackLayout(items, { ...options, paddingX: 40 });
    // 收紧排列时，选中和悬停的横移也不能遮住下一列的牌角。
    const columnLefts = [...new Set(layout.positions.map((p) => p.left))];
    const pitch = columnLefts.length > 1 ? Math.min(...columnLefts.slice(1).map((left, i) => left - columnLefts[i])) : cw;
    const shift = Math.max(0, Math.min(short ? 4 : 8, Math.floor(pitch - cornerWidth - 2)));
    box.style.setProperty("--hand-select-shift", shift + "px");
    box.style.setProperty("--hand-hover-shift", Math.min(4, shift) + "px");
    box.style.height = layout.height + "px";
    box.style.setProperty("--hand-width", Math.max(layout.width, box.clientWidth) + "px");
    for (let i = 0; i < n; i++) {
      const p = layout.positions[i];
      els[i].style.left = p.left + "px";
      els[i].style.top = p.top + "px";
      els[i].style.setProperty("--stack-layer", p.layer);
    }
  }

  function updateButtons() {
    if (!state) return;
    const humanPlayTurn = isHumanTurn() && !state.autoPilot;

    $("btnPlay").disabled = !humanPlayTurn || selected.size === 0;
    $("btnPass").disabled = !(humanPlayTurn && state.awaiting.kind === "follow");
    $("btnHint").disabled = !humanPlayTurn;
    $("btnClear").disabled = !(humanPlayTurn && selected.size);
    $("btnOrganize").disabled = state.phase !== "play";
    $("btnOrganize").classList.toggle("btn-primary", !!state.organize);
    $("btnOrganize").textContent = state.organize ? "恢复" : "理牌";
    $("btnAuto").textContent = state.autoPilot ? "取消托管" : "托管";
    $("btnAuto").classList.toggle("btn-primary", !!state.autoPilot);
    if (humanPlayTurn) {
      const cards = state.hands[0].filter((c) => selected.has(c.id));
      if (cards.length) {
        const r = GD.rules.resolveSubmission(cards, state.trick.target, state.currentLevel);
        $("btnPlay").disabled = !r.ok;
      }
    }
    renderAutoTag();
    updateSelectInfo();
  }

  /* ================= 选牌说明条 ================= */
  function infoSpan(cls, text) { return GD.el("span", cls, text); }

  // 牌型的主点数/序列描述（窗口取自规则模块，与判定同源）
  function playTypeText(play) {
    const rn = (r) => GD.RANK_NAME[r];
    switch (play.type) {
      case "single": return `单张 ${rankByValue(play.value)}`;
      case "pair": return `对子 ${rep(rankByValue(play.value), 2)}`;
      case "triple": return `三张 ${rep(rankByValue(play.value), 3)}`;
      case "fullhouse": return `三带二（${rankByValue(play.value)}）`;
      case "jokers": return GD.TYPE_LABEL.jokers;
      // 级牌炸弹 value=15（A 之上、小王之下），经 rankByValue 还原为本副级牌点名
      case "bomb": return `炸弹（${play.size} 张）${rankByValue(play.value)}`;
      case "straight":
      case "dpairs":
      case "steel":
      case "sflush": {
        const win = GD.rules.seqWindow(play.type, play.value);
        const ranks = win.ranks.map(rn);
        if (play.type === "straight") return `顺子 ${ranks.join("-")}`;
        if (play.type === "dpairs") return `三连对 ${ranks.map((r) => rep(r, 2)).join("/")}`;
        if (play.type === "steel") return `钢板 ${ranks.map((r) => rep(r, 3)).join("/")}`;
        return `${GD.SUIT_NAME[nonWildSuit(play)]}同花顺 ${ranks.join("-")}`;
      }
    }
    return GD.TYPE_LABEL[play.type] || play.type;
  }
  function rep(s, n) { let out = ""; while (n--) out += s; return out; }
  // value 为权重：15 还原为当前级牌点名，其余直接查点名
  function rankByValue(v) {
    if (v === 15) return GD.RANK_NAME[state.currentLevel];
    return GD.RANK_NAME[v] || String(v);
  }
  function nonWildSuit(play) {
    const c = play.cards.find((c) => !GD.isWild(c, state.currentLevel));
    return c ? c.suit : "S";
  }

  // 配牌代替说明：仅列真正替成别的牌的映射，按物理牌 id 区分
  function wildLines(play) {
    const L = state.currentLevel;
    return play.mapping
      .filter((m) => !m.natural)
      .map((m) => {
        const from = "红桃 " + GD.RANK_NAME[L];
        const to = (m.suit ? GD.SUIT_NAME[m.suit] + " " : "") + GD.RANK_NAME[m.rank];
        return `${from} 在这手中代替 ${to}`;
      });
  }

  function updateSelectInfo() {
    const box = $("selectInfo");
    box.innerHTML = "";
    if (!state || state.phase !== "play" || !state.awaiting || state.awaiting.seat !== 0) {
      return;
    }
    const cards = state.hands[0].filter((c) => selected.has(c.id));
    if (!cards.length || state.autoPilot) return;
    const r = GD.rules.resolveSubmission(cards, state.trick.target, state.currentLevel);

    box.appendChild(infoSpan("si-count", `已选 ${cards.length} 张`));
    if (r.ok) {
      box.appendChild(infoSpan("si-type", playTypeText(r.play)));
      box.appendChild(infoSpan("si-ok", "可以出牌"));
      for (const line of wildLines(r.play)) box.appendChild(infoSpan("si-wild", line));
    } else {
      // 失败时也展示"目前实际构成的最强解释"，但裁决结论与原因以 r 为准
      const best = GD.rules.strongest(GD.rules.analyze(cards, state.currentLevel));
      if (best) box.appendChild(infoSpan("si-type", playTypeText(best)));
      box.appendChild(infoSpan("si-bad", r.reason));
      if (best) for (const line of wildLines(best)) box.appendChild(infoSpan("si-wild", line));
    }
  }

  /* ================= 扑克牌元素 ================= */
  function cardEl(card, mini, level) {
    const e = GD.el("div", mini ? "mini-card" : "card");
    if (card.rank >= 16) {
      e.classList.add("joker");
      const big = card.rank === 17;
      e.classList.add(big ? "big-joker" : "small-joker");
      const corner = GD.el("div", "corner");
      corner.appendChild(GD.el("div", "r", big ? "大王" : "小王"));
      e.appendChild(corner);
      const mark = GD.el("div", "joker-mark");
      mark.setAttribute("aria-hidden", "true");
      const emblem = GD.el("div", "joker-emblem");
      // 本地矢量牌面：手牌、桌面小牌和离线包共用同一个渲染入口。
      emblem.innerHTML = big
        ? '<svg viewBox="0 0 64 64" focusable="false"><path d="M10 22l12 9 10-18 10 18 12-9-5 25H15z"/><path class="joker-detail" d="M17 42h30M21 49h22"/><circle cx="10" cy="20" r="3"/><circle cx="32" cy="11" r="3"/><circle cx="54" cy="20" r="3"/></svg>'
        : '<svg viewBox="0 0 64 64" focusable="false"><path d="M14 43c0-13-5-19-7-20 11-3 18 4 21 10 0-11 4-19 9-22 5 7 5 15 4 22 7-8 13-11 18-8-6 4-9 10-10 18z"/><path class="joker-detail" d="M17 46h29M21 51h21"/><circle cx="7" cy="21" r="3"/><circle cx="37" cy="9" r="3"/><circle cx="59" cy="24" r="3"/></svg>';
      mark.appendChild(emblem);
      mark.appendChild(GD.el("div", "j-word", "JOKER"));
      e.appendChild(mark);
      return e;
    }
    const red = card.suit === "H" || card.suit === "D";
    e.classList.add(red ? "red" : "black");
    const corner = GD.el("div", "corner");
    corner.appendChild(GD.el("div", "r", GD.RANK_NAME[card.rank]));
    corner.appendChild(GD.el("div", "s", GD.SUIT_CHAR[card.suit]));
    e.appendChild(corner);
    e.appendChild(GD.el("div", "center-suit", GD.SUIT_CHAR[card.suit]));
    if (GD.isWild(card, level)) e.appendChild(GD.el("div", "wild-dot", "配"));
    return e;
  }
  /* ================= 结算 ================= */
  function finishRows(r) {
    const frag = document.createDocumentFragment();
    r.order.forEach((s, i) => {
      const row = GD.el("div", "finish-row");
      row.appendChild(GD.el("span", "place", RANK_WORDS[i]));
      row.appendChild(GD.el("span", "", NAMES[s] + (s % 2 === 0 ? "（我方）" : "（对方）")));
      frag.appendChild(row);
    });
    return frag;
  }

  // 最后一手大牌直接带走一副时，结算面板顶部的短标签（每副仅取一次）
  function appendFinalFxBadge(body) {
    if (!GD.fx) return;
    const b = GD.fx.takeBadge();
    // 结算面板已在最前：取走徽章后清掉还在播的在途特效，不让环/粒子透过遮罩继续
    GD.fx.cancel();
    if (!b) return;
    const el = GD.el("div", "settle-fx-badge" +
      (b.kind === "jokers" ? " sfb-jokers" : b.kind === "sflush" ? " sfb-sflush" : ""));
    el.textContent = `最后一击：${b.title}${b.detail ? " · " + b.detail : ""}`;
    body.appendChild(el);
  }

  function showSettle() {
    const r = state.handResult;
    $("settleTitle").textContent = "本局结算";
    const body = $("settleBody");
    body.innerHTML = "";
    appendFinalFxBadge(body);
    body.appendChild(finishRows(r));
    const line = GD.el("div", "upgrade-line");
    const deltaText = ["", "升级 1 级", "升级 2 级", "升级 3 级（双下）"][r.delta];
    const who = r.winTeam === 0 ? "我方" : "对方";
    if (r.passed) line.innerHTML = `<b>${who}</b> 成功过 <b>A</b>，整场获胜！`;
    else if (r.stuck) line.innerHTML = `<b>${who}</b> 一四名未能过 A，留在 <b>A</b> 重打（下一局级牌仍为 <b>A</b>）`;
    // 区分"胜方累计升至几级"与"下一局实际级牌（头游方级数）"，
    // 两者均取自 endHand 的结算数据，不另写展示层规则
    else line.innerHTML = `<b>${who}</b> ${deltaText}，累计升至 <b>${GD.LEVEL_NAME[r.newLevel]}</b>` +
      `；下一局级牌为 <b>${GD.LEVEL_NAME[r.nextCurrentLevel]}</b>（头游方级数）`;
    body.appendChild(line);
    $("btnPracticeAgain").classList.add("hidden");
    $("btnSettleNext").textContent = "继 续";
    show("settleOverlay");
  }

  // 单副练习：一副即终局，不升级不进贡；只可再练或回首页
  function showPracticeEnd() {
    const r = state.handResult;
    $("settleTitle").textContent = "快速一局结算";
    const body = $("settleBody");
    body.innerHTML = "";
    appendFinalFxBadge(body);
    body.appendChild(finishRows(r));
    const line = GD.el("div", "upgrade-line");
    line.innerHTML = r.winTeam === 0
      ? "<b>🎉 本副你和对家获胜！</b>"
      : "<b>本副对方队伍获胜</b>，再来一副试试";
    body.appendChild(line);
    $("btnPracticeAgain").classList.remove("hidden");
    $("btnSettleNext").textContent = "回首页";
    show("settleOverlay");
  }

  function showMatchEnd() {
    $("matchEndTitle").textContent = "整场结束";
    const win = state.matchWinner;
    $("matchEndBody").innerHTML =
      `<div class="upgrade-line"><b>${win === 0 ? "🎉 你和对家获胜！" : "对方队伍获胜"}</b><br>` +
      `最终级数：我方 ${GD.LEVEL_NAME[state.levels[0]]} ｜ 对方 ${GD.LEVEL_NAME[state.levels[1]]}</div>`;
    show("matchEndOverlay");
  }

  /* ================= 规则文案 ================= */
  function renderRules() {
    $("rulesBody").innerHTML = `
      <h3>基本玩法</h3>
      <ul>
        <li>两副牌 108 张，四人围坐，对家为一队：你（下）与对家（上）一队，西家（左）与东家（右）一队。</li>
        <li>每人 27 张，轮流出牌，可「不要」；出完牌者依次记头游、二游、三游、四游。</li>
        <li>双方各自从 2 向 A 爬升；<b>每副级牌 = 上一副头游所在队伍升级后的累计级数</b>（第一副打 2），与对方级数高低无关；任一队过 A 整场结束。</li>
      </ul>
      <h3>级牌与配牌</h3>
      <ul>
        <li>普通 2 最小：普通2&lt;3&lt;…&lt;A&lt;级牌&lt;小王&lt;大王；打几，几就是级牌（打2时2为级牌、打A时A为级牌）。</li>
        <li>红桃级牌为「逢人配」（金色“配”标记，两副牌共两张），可替代任意牌，<b>包括补同花顺</b>；不能替代大小王。</li>
        <li>自然级牌可按本来点数进入顺子等连续牌型，例如打 5 时 3-4-5-6-7 是合法顺子。</li>
      </ul>
      <h3>牌型</h3>
      <ul>
        <li>单张、对子、三张、三带二。</li>
        <li>顺子固定 5 张：A2345（A当1，最小）、23456、…、10JQKA，依次增大；JQKA2 非法。</li>
        <li>连对固定 3 对：AA2233、223344、…、QQKKAA，依次增大；钢板固定 2 组三张：AAA222、222333、…、KKKAAA，依次增大。</li>
        <li>炸弹（≥4 同点）、同花顺（5 张同花色连续，A2345 同花亦可）、四王炸（2 小王 2 大王）。</li>
      </ul>
      <h3>大小比较</h3>
      <ul>
        <li>非炸弹仅同牌型同张数可比，按牌点大小。</li>
        <li>炸弹可压一切非炸弹。炸弹之间：四王炸最大；<b>4/5 张炸弹 &lt; 同花顺 &lt; 6 张及以上炸弹</b>；普通炸弹张数多者大、同张看点数。</li>
      </ul>
      <h3>进贡与还贡</h3>
      <ul>
        <li>双下：三游、四游双贡，大贡给头游、小贡给二游；其余结果：<b>末游向头游单贡</b>。</li>
        <li>双下抗贡：两张大王为输方所有（集中一家或分持两家）；单贡抗贡：进贡者持两张大王。</li>
        <li>还贡须还 ≤10 的小牌（含 2，级牌除外）；无合格小牌时还手中最小牌。</li>
        <li>进贡还贡后由进贡给头游者先出牌；抗贡由头游先出牌。</li>
        <li>双贡同点：按出牌方向，头游之后先遇到者为大贡方。</li>
      </ul>
      <h3>升级与过 A</h3>
      <ul>
        <li>头游队伍：双下 +3，一三名 +2，一四名 +1；升级在下一副生效，<b>下一副级牌即头游队伍升级后的级数</b>，不取双方高者。例如对方头游、其 2→3 时，下一副打 3、红桃 3 为配牌。</li>
        <li>过 A：打 A 须双下或一三名通过；一四名卡 A 重打。</li>
        <li>接风：某人出完牌且最后一手无人压时，由其对家接风。</li>
      </ul>
      <h3>操作说明</h3>
      <ul>
        <li>点牌选中、再点取消；「出牌」「不要」出手；「提示」始终使用稳健策略，依次显示首选推荐和备选方案（可能推荐不要并说明理由，但<b>不会替你出手</b>）；「理牌」把同花顺/炸弹/四王炸自动分组；「托管」电脑代打（含进贡还贡），难度与当前对局的电脑一致。</li>
        <li>「快速一局」只打一副、不升级不进贡，有独立存档与战绩，不影响完整对局进度。</li>
        <li>「菜单」打开时暂停对局，可查看规则、设置、战绩或按当前模式重开；按「继续游戏」返回牌桌。出牌节奏固定为标准；音效、音量、减少动效可在设置中调整。进度自动保存，刷新页面可继续。</li>
      </ul>`;
  }

  /* ================= 通用部件 ================= */
  let toastTimer = null;
  function toast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 2200);
  }

  function show(id) { $(id).classList.remove("hidden"); refreshActiveModal(); }
  function hide(id) { $(id).classList.add("hidden"); refreshActiveModal(); }

  function hideAllOverlays() {
    ["homeOverlay", "rulesOverlay", "settingsOverlay", "statsOverlay",
      "settleOverlay", "matchEndOverlay", "pauseOverlay", "confirmOverlay"]
      .forEach(hide);
  }

  function askConfirm(title, text) {
    return new Promise((resolve) => {
      const returnFocus = document.activeElement;
      const pausedHere = state && !state.paused;
      modalPauseGame();
      $("confirmTitle").textContent = title;
      $("confirmText").textContent = text;
      show("confirmOverlay");
      const yes = $("btnConfirmYes");
      const no = $("btnConfirmNo");
      const done = (v) => {
        hide("confirmOverlay");
        yes.onclick = null; no.onclick = null;
        if (!v && pausedHere) modalResume();
        if (returnFocus && document.contains(returnFocus)) returnFocus.focus();
        resolve(v);
      };
      yes.onclick = () => done(true);
      no.onclick = () => done(false);
      no.focus();
    });
  }

  // 测试钩子
  window.addEventListener("hashchange", () => location.reload());
  if (location.hash === "#autostart" || location.hash === "#demo" ||
      location.hash === "#demoa" ||
      location.hash === "#organize" || location.hash === "#practice") {
    document.addEventListener("DOMContentLoaded", () => {
      const h = location.hash;
      if (h === "#practice") {
        GD.store.clearPractice();
        $("btnPractice").click();
      } else {
        GD.store.clear(); // 钩子环境自动开新场，避免覆盖确认
        $("btnStart").click();
      }
      if (h === "#demo" || h === "#demoa") {
        // #demoa：自动化整场验收用，我方从 A 级开打（1-4 副内可终局）
        if (h === "#demoa") {
          state.levels = [14, 2];
          state.levelTeam = 0;
          state.currentLevel = 14;
          GD.sortHand(state.hands[0], 14);
          GD.store.save(state);
          renderLevels();
        }
        state.autoPilot = true;
        GD.store.save(state);
        kick();
      }
      if (h === "#organize") { state.organize = true; GD.store.save(state); renderAll(); }
    });
  }
})();
