/* ====== fx.js：对战出牌特效（v1.4.0） ======
 *
 * 纯展示模块，零依赖、零外链。所有"播什么"由调用方（ui.afterAct）从
 * GD.game.act 的真实返回组装后传入；本模块不读手牌、不判牌型、不发声，
 * 也不消耗洗牌/AI 随机流（自带独立 RNG，仅用于火花方向等视觉抖动）。
 *
 * 触发：一次成功 act 只对应一次 fx.act()，去重键 matchId+":"+gen。
 * 并发：同时至多一组主爆发（炸弹/同花顺/四王炸）；新组到来时旧组立即收尾。
 *       接风流光与牌型描边是独立轻量效果，可与一组主爆发并存。
 * 输入穿透：#fxLayer 永远 pointer-events:none，不拦截鼠标/触摸/滚动/键盘。
 * 节奏：标准时长见 DUR；快速(speedMul)整体缩短、粒子与烟尘减量。
 * 设置：mode = full（默认，完整）/ simple（环+扫光+短标签，少粒子）/ off（无特效）；
 *       reduceMotion 时不做飞行/粒子/rAF，只短显静态标签，JS 侧同样主动停止。
 * 清理：cancel() 移除全部特效节点、定时器与 rAF（暂停/新开/返回首页时调用）。
 */
(function () {
  const GD = (window.GD = window.GD || {});

  /* ---------- 独立随机源（仅视觉用途） ---------- */
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  let rng = mulberry32(((Date.now() ^ 0x9e3779b9) >>> 0) || 1);

  /* ---------- 标准时长（ms）与阶段比例 ---------- */
  const DUR = {
    bomb: 620, "bomb-lg": 760, sflush: 700, jokers: 920, combo: 520, flow: 640, glow: 1000,
  };
  const CHARGE = 0.26; // 进入（蓄力/聚拢）占比

  /* ---------- 粒子上限（硬顶，低端/手机再按比例缩减） ---------- */
  const SPARK_CAP = { full: { bomb: 22, "bomb-lg": 34, sflush: 18, jokers: 32 },
                      simple: { bomb: 8, "bomb-lg": 12, sflush: 6, jokers: 10 } };
  const SMOKE_CAP = { full: 5, simple: 0 };
  const MAX_PARTICLES_TOTAL = 40;

  /* ---------- 运行状态 ---------- */
  let layer = null;
  let burst = null;        // 当前主爆发 {root, particles, raf}
  let timers = [];
  let lastKey = "";
  let pendingBadge = null; // 大牌直接打完一副时，留给结算面板的短标签
  const perf = {
    plays: 0, bursts: 0, sparkFrames: 0,
    maxFrameMs: 0, totalFrameMs: 0,
    capped: 0, cancelled: 0,
  };

  function onTimeout(fn, ms) {
    const id = setTimeout(() => { timers = timers.filter((t) => t !== id); fn(); }, ms);
    timers.push(id);
    return id;
  }
  function clearTimers() {
    timers.forEach(clearTimeout);
    timers = [];
  }

  function ensureLayer() {
    if (layer && document.body.contains(layer)) return layer;
    const table = document.getElementById("table");
    layer = document.createElement("div");
    layer.id = "fxLayer";
    layer.className = "fx-layer";
    table.appendChild(layer);
    return layer;
  }

  /* 取消全部在途特效（暂停/重开/返回首页） */
  function cancel() {
    clearTimers();
    if (burst) {
      stopRaf(burst);
      if (burst.root && burst.root.parentNode) burst.root.parentNode.removeChild(burst.root);
      burst = null;
      perf.cancelled++;
    }
    if (layer) layer.innerHTML = "";
    document.querySelectorAll(".fx-outline,.fx-seat-glow").forEach((e) => e.remove());
    lastKey = "";
  }

  function stopRaf(b) {
    if (b.rafId) cancelAnimationFrame(b.rafId);
    b.rafId = 0;
    perf.sparkFrames += b.frames | 0;
  }

  /* ---------- 坐标：layer 内相对像素 ---------- */
  function relCenter(el) {
    const lr = layer.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2 - lr.left, y: r.top + r.height / 2 - lr.top,
      w: r.width, h: r.height };
  }
  function playAnchor(seat) {
    const el = document.getElementById("activePlay");
    return el ? relCenter(el) : null;
  }
  function seatAnchor(seat) {
    const el = seat === 0
      ? document.querySelector("#selfStatus .avatar")
      : document.querySelector(`#seat-${seat} .avatar`);
    return el ? relCenter(el) : null;
  }

  /* ---------- 公共入口 ----------
   * req: { key, kind: bomb|bomb-lg|sflush|jokers|combo, seat,
   *        title, detail, mode, speedMul, reduceMotion,
   *        ending:bool, jiefeng:null|{from,to} }
   */
  function act(req) {
    if (!req) return;
    if (!req.key || req.key === lastKey) return; // 同一动作绝不重播
    lastKey = req.key;
    perf.plays++;
    const mode = req.mode === "simple" || req.mode === "off" ? req.mode : "full";
    if (mode === "off" || req.reduceMotion) {
      // 减少动效：只短显静态标签（无飞行/粒子/rAF），off 完全不加视觉
      if (mode !== "off" && MAJOR.has(req.kind)) {
        staticLabel(req);
        if (req.ending) pendingBadge = badgeOf(req);
      }
      return;
    }
    ensureLayer();
    if (MAJOR.has(req.kind)) {
      startBurst(req, mode);
      if (req.ending) pendingBadge = badgeOf(req);
    } else if (req.kind === "combo") {
      comboOutline(req);
    }
    if (req.jiefeng) startFlow(req);
  }

  const MAJOR = new Set(["bomb", "bomb-lg", "sflush", "jokers"]);

  function badgeOf(req) {
    return { title: req.title, detail: req.detail || "", kind: req.kind };
  }
  // 结算面板取用；回看/恢复不经过 act，故不会重复产生
  function takeBadge() {
    const b = pendingBadge; pendingBadge = null; return b;
  }

  /* ---------- 主爆发 ---------- */
  function startBurst(req, mode) {
    if (burst) finishBurst(true); // 连续大牌：旧组立即收尾，不排队
    const D = Math.round(DUR[req.kind] * req.speedMul);
    const tCharge = Math.round(D * CHARGE);
    const L = ensureLayer();

    const anchor = playAnchor(req.seat);
    const cc = { x: L.clientWidth / 2, y: L.clientHeight * 0.46 };
    // 爆发点在"桌面中心→出牌者"方向上偏向出牌者，标明谁打的
    let cx = cc.x, cy = cc.y;
    if (anchor) {
      const dx = anchor.x - cc.x, dy = anchor.y - cc.y;
      cx = cc.x + dx * 0.24; cy = cc.y + dy * 0.22;
    }

    const root = document.createElement("div");
    root.className = `fx-burst fx-${req.kind} fx-${mode}`;
    root.style.left = cx + "px";
    root.style.top = cy + "px";
    root.style.setProperty("--d", D + "ms");

    // 进入阶段：轮廓（从出牌座位滑入蓄力）
    const shell = document.createElement("div");
    shell.className = "fx-shell";
    shell.textContent = req.kind === "jokers" ? "王"
      : req.kind === "sflush" ? "顺" : "炸";
    if (anchor) {
      shell.style.setProperty("--sx", (anchor.x - cx) + "px");
      shell.style.setProperty("--sy", (anchor.y - cy) + "px");
    }
    if (mode === "simple") shell.style.display = "none";
    root.appendChild(shell);

    // 标题（真实牌型与说明，调用方组装）
    const title = document.createElement("div");
    title.className = "fx-title";
    title.innerHTML =
      `<b>${escapeHtml(req.title)}</b>` +
      (req.detail ? `<span>${escapeHtml(req.detail)}</span>` : "");
    root.appendChild(title);

    // 爆发阶段：冲击环（六张以上/四王炸为双层）
    const rings = document.createElement("div");
    rings.className = "fx-rings";
    rings.appendChild(document.createElement("i"));
    if (req.kind === "bomb-lg" || req.kind === "jokers") {
      const r2 = document.createElement("i");
      r2.className = "fx-ring2";
      rings.appendChild(r2);
    }
    if (req.kind === "sflush") {
      // 五段顺序扫光，形成完整光带
      const band = document.createElement("div");
      band.className = "fx-band";
      for (let i = 0; i < 5; i++) {
        const seg = document.createElement("i");
        seg.style.setProperty("--i", i);
        seg.style.animationDelay = Math.round(tCharge + i * 46 * req.speedMul) + "ms";
        band.appendChild(seg);
      }
      root.appendChild(band);
    }
    if (req.kind === "jokers") {
      const crown = document.createElement("div");
      crown.className = "fx-crown";
      crown.textContent = "♛";
      crown.style.animationDelay = tCharge + "ms";
      root.appendChild(crown);
    }
    root.appendChild(rings);

    L.appendChild(root);

    const b = { root, particles: [], rafId: 0, frames: 0, t0: 0, D, tCharge, cx, cy,
      sparkAngle0: req.kind === "sflush" ? -25 : 0 };
    burst = b;
    perf.bursts++;

    // 爆发时刻：火花 + 烟尘（rAF 粒子，受总量上限约束）
    onTimeout(() => {
      if (burst !== b) return;
      spawnParticles(b, req, mode);
      runParticles(b);
    }, tCharge);
    onTimeout(() => { if (burst === b) finishBurst(false); }, D + 60);
  }

  function spawnParticles(b, req, mode) {
    const L = ensureLayer();
    const mobile = L.clientWidth <= 900 || L.clientHeight <= 480;
    const scale = mobile ? 0.6 : 1;
    const fastMul = req.speedMul < 1 ? 0.62 : 1;
    let n = Math.round((SPARK_CAP[mode][req.kind] || 0) * scale * fastMul);
    n = Math.max(0, Math.min(n, MAX_PARTICLES_TOTAL));
    let nSmoke = mode === "full" ? Math.round((SMOKE_CAP.full) * scale * fastMul) : 0;
    if (b.particles.length + n > MAX_PARTICLES_TOTAL) {
      n = Math.max(0, MAX_PARTICLES_TOTAL - b.particles.length);
      perf.capped++;
    }
    const angleSpread = req.kind === "sflush" ? 70 : 360;
    for (let i = 0; i < n; i++) {
      const p = document.createElement("i");
      p.className = "fx-spark fx-spark-" + (rng() < 0.72 ? "a" : "b");
      const ang = (req.kind === "sflush" ? (-angleSpread / 2 + rng() * angleSpread)
        : rng() * 360) * Math.PI / 180;
      const speed = 90 + rng() * 150;
      b.particles.push({
        el: p, x: b.cx, y: b.cy,
        vx: Math.cos(ang) * speed, vy: Math.sin(ang) * speed - 30,
        life: 0, ttl: (0.34 + rng() * 0.3) * req.speedMul, r: 1.6 + rng() * 2.2,
      });
      L.appendChild(p);
    }
    for (let i = 0; i < nSmoke; i++) {
      const p = document.createElement("i");
      p.className = "fx-smoke";
      const ang = rng() * Math.PI * 2, speed = 20 + rng() * 36;
      b.particles.push({
        el: p, x: b.cx + (rng() - 0.5) * 18, y: b.cy,
        vx: Math.cos(ang) * speed, vy: Math.sin(ang) * speed - 14,
        life: 0, ttl: (0.5 + rng() * 0.25) * req.speedMul, r: 10 + rng() * 12, smoke: true,
      });
      L.appendChild(p);
    }
  }

  function runParticles(b) {
    b.t0 = performance.now();
    let last = b.t0;
    const step = (now) => {
      if (burst !== b) return;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const frameMs = now - (b._lastShown || now - 16.7);
      b._lastShown = now;
      b.frames++;
      perf.totalFrameMs += frameMs;
      if (frameMs > perf.maxFrameMs) perf.maxFrameMs = frameMs;
      let alive = 0;
      for (const p of b.particles) {
        p.life += dt;
        if (p.life >= p.ttl) { p.el.style.opacity = "0"; continue; }
        alive++;
        if (!p.smoke) p.vy += 220 * dt; // 轻微重力
        else p.vx *= 0.96, p.vy *= 0.96;
        p.x += p.vx * dt; p.y += p.vy * dt;
        const k = 1 - p.life / p.ttl;
        p.el.style.transform =
          `translate(${p.x.toFixed(1)}px,${p.y.toFixed(1)}px) translate(-50%,-50%) scale(${(p.smoke ? 1 + p.life * 1.6 : 0.5 + k).toFixed(2)})`;
        p.el.style.opacity = (p.smoke ? 0.28 * k : k).toFixed(2);
      }
      if (alive > 0) b.rafId = requestAnimationFrame(step);
      else b.rafId = 0;
    };
    b.rafId = requestAnimationFrame(step);
  }

  function finishBurst(quick) {
    if (!burst) return;
    const b = burst;
    stopRaf(b);
    if (quick) {
      // 抢占：旧组立即摘除（同时至多一组主爆发，不做淡出、不排队）
      b.particles.forEach((p) => p.el.remove());
      b.root.remove();
      if (burst === b) burst = null;
    } else {
      // 正常收尾：粒子淡出、根节点收尾动画后移除；期间新手到来仍会抢占本根
      b.particles.forEach((p) => {
        p.el.classList.add("fx-done");
        onTimeout(() => p.el.remove(), 220);
      });
      b.root.classList.add("fx-end");
      onTimeout(() => { b.root.remove(); if (burst === b) burst = null; }, 260);
    }
  }

  /* ---------- 减少动效：静态短标签（无移动/无 rAF） ---------- */
  function staticLabel(req) {
    const L = ensureLayer();
    const anchor = playAnchor(req.seat) ||
      { x: L.clientWidth / 2, y: L.clientHeight * 0.46 };
    const el = document.createElement("div");
    el.className = "fx-static";
    el.style.left = anchor.x + "px";
    el.style.top = (anchor.y - 34) + "px";
    el.innerHTML = `<b>${escapeHtml(req.title)}</b>` +
      (req.detail ? `<span>${escapeHtml(req.detail)}</span>` : "");
    L.appendChild(el);
    onTimeout(() => el.remove(), 460);
  }

  /* ---------- 普通成型牌型：牌面描边 + 短标题滑入 ---------- */
  function comboOutline(req) {
    const targetEl = document.getElementById("activePlay");
    const L = ensureLayer();
    if (targetEl) {
      targetEl.classList.add("fx-outline");
      targetEl.dataset.fxAction = req.key;
      onTimeout(() => { if (targetEl.dataset.fxAction === req.key) targetEl.classList.remove("fx-outline"); },
        Math.round(520 * req.speedMul) + 40);
    }
    const anchor = playAnchor(req.seat) ||
      { x: L.clientWidth / 2, y: L.clientHeight * 0.46 };
    const tag = document.createElement("div");
    tag.className = "fx-title-mini";
    tag.style.left = anchor.x + "px";
    tag.style.top = (anchor.y - 40) + "px";
    tag.style.setProperty("--d", Math.round(420 * req.speedMul) + "ms");
    tag.textContent = req.title; // 顺子 / 三连对 / 钢板
    L.appendChild(tag);
    onTimeout(() => tag.remove(), Math.round(520 * req.speedMul) + 60);
  }

  /* ---------- 接风：金色流光从出完者传向实际接风队友 ---------- */
  function startFlow(req) {
    const L = ensureLayer();
    const from = seatAnchor(req.jiefeng.from);
    const to = seatAnchor(req.jiefeng.to);
    if (!from || !to) return;
    const D = Math.round(DUR.flow * req.speedMul);
    const wrap = document.createElement("div");
    wrap.className = "fx-flow";
    wrap.style.left = from.x + "px";
    wrap.style.top = from.y + "px";
    wrap.style.setProperty("--tx", (to.x - from.x) + "px");
    wrap.style.setProperty("--ty", (to.y - from.y) + "px");
    wrap.style.setProperty("--d", D + "ms");
    wrap.appendChild(document.createElement("i"));
    L.appendChild(wrap);
    onTimeout(() => wrap.remove(), D + 80);

    // 接收座位高亮
    const seatEl = req.jiefeng.to === 0
      ? document.querySelector("#selfStatus .avatar")
      : document.querySelector(`#seat-${req.jiefeng.to} .avatar`);
    if (seatEl) {
      seatEl.classList.add("fx-seat-glow");
      onTimeout(() => seatEl.classList.remove("fx-seat-glow"),
        Math.round(DUR.glow * req.speedMul));
    }
    // 中点短标题
    const tag = document.createElement("div");
    tag.className = "fx-flow-tag";
    tag.style.left = ((from.x + to.x) / 2) + "px";
    tag.style.top = ((from.y + to.y) / 2 - 14) + "px";
    tag.style.animationDuration = D + "ms";
    tag.textContent = "对家接风";
    L.appendChild(tag);
    onTimeout(() => tag.remove(), D + 60);
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function getPerf() {
    return Object.assign({}, perf, {
      avgFrameMs: perf.sparkFrames ? perf.totalFrameMs / perf.sparkFrames : 0,
      active: !!burst,
    });
  }

  GD.fx = { act, cancel, takeBadge, getPerf,
    // 测试钩子：确定性视觉随机
    __setRng(fn) { if (typeof fn === "function") rng = fn; } };
})();
