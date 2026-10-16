/* ====== fx.js：对战出牌特效（v1.12.1 五档炸弹与四大天王） ======
 *
 * 纯展示模块，零依赖、零外链。所有"播什么"由调用方（ui.afterAct）从
 * GD.game.act 的真实返回组装后传入；本模块不读手牌、不判牌型、不发声，
 * 也不消耗洗牌/AI 随机流（自带独立 RNG，仅用于火花方向等视觉抖动）。
 *
 * 触发：一次成功 act 只对应一次 fx.act()，去重键 matchId+":"+gen。
 * 并发：同时至多一组主爆发（炸弹/同花顺/四王炸）；新组到来时旧组立即收尾。
 *       接风流光与牌型描边是独立轻量效果，可与一组主爆发并存。
 * 输入穿透：#fxLayer 永远 pointer-events:none，不拦截鼠标/触摸/滚动/键盘。
 * 节奏：标准时长见 DUR 与 BOMB_PROFILES；快速(speedMul)整体缩短、粒子与烟尘减量。
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
  // 张数取成功出牌的真实摘要；八张以上沿用最高档，不改变牌型裁决。
  const BOMB_PROFILES = {
    4: { variant: "spark", duration: 640, reach: 110, sparks: 12, smoke: 1, rings: 1, rays: 6, speed: 130, color: "#ffbd61", hot: "#fff1ba" },
    5: { variant: "chain", duration: 740, reach: 140, sparks: 18, smoke: 2, rings: 2, rays: 8, speed: 170, color: "#ff923d", hot: "#ffe991" },
    6: { variant: "shock", duration: 840, reach: 174, sparks: 24, smoke: 3, rings: 3, rays: 10, speed: 210, color: "#63ddff", hot: "#e6fdff" },
    7: { variant: "inferno", duration: 940, reach: 208, sparks: 30, smoke: 4, rings: 3, rays: 12, speed: 250, color: "#ff6747", hot: "#ffd49b" },
    8: { variant: "nova", duration: 1080, reach: 244, sparks: 36, smoke: 5, rings: 4, rays: 16, speed: 290, color: "#c499ff", hot: "#fff2b0" },
  };
  function bombProfile(req) {
    if (req.kind !== "bomb" && req.kind !== "bomb-lg") return null;
    const size = Math.min(8, Math.max(4, Math.trunc(Number(req.size) || (req.kind === "bomb-lg" ? 6 : 4))));
    return { ...BOMB_PROFILES[size], tier: size };
  }
  const ROYAL_PROFILE = { variant: "royal", duration: 1380, reach: 286, sparks: 40, smoke: 0, rings: 5, rays: 20, speed: 330, color: "#b38bff", hot: "#ffec9c", tier: 9 };

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
    // 与牌桌内容共用层级，手牌底栏和工具可始终画在特效之上。
    const table = document.querySelector("#table .table-frame") || document.getElementById("table");
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
   *        size:真实出牌张数, title, detail, mode, speedMul, reduceMotion,
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
    const royal = req.kind === "jokers";
    const profile = royal ? ROYAL_PROFILE : bombProfile(req);
    const D = Math.round((profile ? profile.duration : DUR[req.kind]) * req.speedMul);
    const tCharge = Math.round(D * CHARGE);
    const L = ensureLayer();

    const anchor = playAnchor(req.seat);
    const cc = { x: L.clientWidth / 2, y: L.clientHeight * 0.46 };
    // 炸弹与四大天王以实际桌面牌组为爆心。
    let cx = cc.x, cy = cc.y;
    if (anchor) {
      const dx = anchor.x - cc.x, dy = anchor.y - cc.y;
      cx = cc.x + dx * 0.24; cy = cc.y + dy * 0.22;
      if (profile) { cx = anchor.x; cy = anchor.y; }
    }

    const root = document.createElement("div");
    root.className = `fx-burst fx-${req.kind} fx-${mode}`;
    root.style.left = cx + "px";
    root.style.top = cy + "px";
    root.style.setProperty("--d", D + "ms");
    if (profile) {
      const scale = Math.min(1, L.clientWidth / 1200, L.clientHeight / 740);
      if (!royal) {
        root.dataset.bombTier = profile.tier;
        root.dataset.bombSize = req.size || profile.tier;
      }
      root.dataset.variant = profile.variant;
      root.style.setProperty("--blast-reach", (profile.reach * scale).toFixed(1) + "px");
      root.style.setProperty("--blast-color", profile.color);
      root.style.setProperty("--blast-hot", profile.hot);
      root.style.setProperty("--blast-line", Math.max(2, (profile.tier - 1) * scale) + "px");
      root.style.setProperty("--blast-caption-x", ((anchor ? anchor.w / 2 : 0) + 20) + "px");
      if (royal) decorateRoyal(root, profile, mode);
      else decorateBomb(root, profile, mode);
    }

    // 进入阶段：轮廓（从出牌座位滑入蓄力）
    const shell = document.createElement("div");
    shell.className = "fx-shell";
    shell.textContent = req.kind === "jokers" ? "王"
      : req.kind === "sflush" ? "顺" : "炸";
    const source = profile ? seatAnchor(req.seat) || anchor : anchor;
    if (source) {
      shell.style.setProperty("--sx", (source.x - cx) + "px");
      shell.style.setProperty("--sy", (source.y - cy) + "px");
    }
    if (mode === "simple" || royal) shell.style.display = "none";
    root.appendChild(shell);

    // 标题（真实牌型与说明，调用方组装）
    const title = document.createElement("div");
    title.className = "fx-title";
    title.innerHTML =
      `<b>${escapeHtml(req.title)}</b>` +
      (req.detail ? `<span>${escapeHtml(req.detail)}</span>` : "");
    root.appendChild(title);

    // 炸弹按张数增加冲击层；四大天王拥有独立的五重冲击。
    const rings = document.createElement("div");
    rings.className = "fx-rings";
    const ringCount = profile ? (mode === "simple" ? Math.min(profile.rings, 2) : profile.rings) : 1;
    for (let i = 0; i < ringCount; i++) {
      const ring = document.createElement("i");
      if (i === 1) ring.className = "fx-ring2";
      ring.style.setProperty("--ring-index", i);
      ring.style.setProperty("--ring-delay", Math.round(i * D * (royal ? .025 : profile && profile.variant === "chain" ? .12 : .045)) + "ms");
      rings.appendChild(ring);
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
    root.appendChild(rings);

    L.appendChild(root);

    const b = { root, profile, particles: [], rafId: 0, frames: 0, t0: 0, D, tCharge, cx, cy,
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

  function decorateBomb(root, profile, mode) {
    const add = (cls, parent = root) => {
      const node = document.createElement("div"); node.className = cls; parent.appendChild(node); return node;
    };
    add("fx-blast-aura");
    const core = add("fx-blast-core");
    if (profile.variant === "chain") {
      add("fx-chain-orb fx-chain-left", core); add("fx-chain-orb fx-chain-right", core);
    }
    const rays = add("fx-blast-rays");
    const count = mode === "simple" ? Math.min(4, profile.rays) : profile.rays;
    for (let i = 0; i < count; i++) {
      const ray = document.createElement("i");
      ray.style.setProperty("--angle", (360 * i / count).toFixed(1) + "deg");
      ray.style.setProperty("--ray-index", i % 3);
      rays.appendChild(ray);
    }
    if (profile.tier >= 6) {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.classList.add("fx-blast-sigil");
      svg.setAttribute("viewBox", "-100 -100 200 200");
      svg.setAttribute("aria-hidden", "true");
      const paths = profile.tier === 6
        ? ["M0-80 69-40 69 40 0 80-69 40-69-40Z", "M-70-22-37-8-51 14-10 5-24 33 28 7 13 31 69-22 27-8 39-35-7-16 5-46Z"]
        : profile.tier === 7
          ? ["M0-86C82-80 100-7 51 34 84-19 38-58 0-49", "M86 0C80 82 7 100-34 51 19 84 58 38 49 0", "M0 86C-82 80-100 7-51-34-84 19-38 58 0 49", "M-86 0C-80-82-7-100 34-51-19-84-58-38-49 0"]
          : ["M0-94 13-20 66-66 20-13 94 0 20 13 66 66 13 20 0 94-13 20-66 66-20 13-94 0-20-13-66-66-13-20Z", "M0-58A58 58 0 1 1-.1-58"];
      for (const data of paths) {
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", data); svg.appendChild(path);
      }
      root.appendChild(svg);
    }
  }

  function decorateRoyal(root, profile, mode) {
    const add = (cls, parent = root) => {
      const node = document.createElement("div"); node.className = cls; parent.appendChild(node); return node;
    };
    add("fx-blast-aura");
    add("fx-royal-light");
    const gathering = add("fx-royal-gather");
    for (let i = 0; i < 4; i++) {
      const card = add("fx-royal-card" + (i < 2 ? " fx-royal-big" : ""), gathering);
      card.style.setProperty("--king-x", i % 2 ? 1 : -1);
      card.style.setProperty("--king-y", i < 2 ? -1 : 1);
      card.innerHTML = `<b>${i < 2 ? "大王" : "小王"}</b><span>♛</span><small>JOKER</small>`;
    }
    const crown = add("fx-crown fx-royal-crown");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "-100 -80 200 140");
    svg.setAttribute("aria-hidden", "true");
    const shapes = ["M-70 12-86-44-42-18 0-64 42-18 86-44 70 12Z", "M-70 20H70V38H-70Z", "M-15-2 0-20 15-2 0 16Z"];
    for (const d of shapes) {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", d); svg.appendChild(path);
    }
    for (const [cx, cy] of [[-86, -44], [0, -64], [86, -44]]) {
      const gem = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      gem.setAttribute("cx", cx); gem.setAttribute("cy", cy); gem.setAttribute("r", 7); svg.appendChild(gem);
    }
    crown.appendChild(svg);
    const rays = add("fx-blast-rays"), jewels = add("fx-royal-jewels");
    for (let i = 0; i < (mode === "simple" ? 4 : profile.rays); i++) {
      const ray = document.createElement("i");
      ray.style.setProperty("--angle", (360 * i / (mode === "simple" ? 4 : profile.rays)) + "deg");
      ray.style.setProperty("--ray-index", i % 3); rays.appendChild(ray);
    }
    if (mode === "full") for (let i = 0; i < 12; i++) {
      const jewel = document.createElement("i");
      jewel.style.setProperty("--angle", (30 * i) + "deg"); jewels.appendChild(jewel);
    }
  }

  function spawnParticles(b, req, mode) {
    const L = ensureLayer();
    const mobile = L.clientWidth <= 900 || L.clientHeight <= 480;
    const scale = mobile ? 0.6 : 1;
    const fastMul = req.speedMul < 1 ? 0.62 : 1;
    const profile = b.profile;
    const count = profile ? (mode === "simple" ? Math.ceil(profile.sparks / 4) : profile.sparks) : SPARK_CAP[mode][req.kind] || 0;
    let n = Math.round(count * scale * fastMul);
    n = Math.max(0, Math.min(n, MAX_PARTICLES_TOTAL));
    let nSmoke = mode === "full" ? Math.round((profile ? profile.smoke : SMOKE_CAP.full) * scale * fastMul) : 0;
    if (b.particles.length + n > MAX_PARTICLES_TOTAL) {
      n = Math.max(0, MAX_PARTICLES_TOTAL - b.particles.length);
      perf.capped++;
    }
    nSmoke = Math.min(nSmoke, MAX_PARTICLES_TOTAL - b.particles.length - n);
    const angleSpread = req.kind === "sflush" ? 70 : 360;
    for (let i = 0; i < n; i++) {
      const p = document.createElement("i");
      p.className = "fx-spark fx-spark-" + (rng() < 0.72 ? "a" : "b");
      p.style.opacity = "0";
      const degrees = req.kind === "sflush" ? -angleSpread / 2 + rng() * angleSpread
        : profile && profile.tier >= 6 ? i * 360 / n + (rng() - .5) * 12 : rng() * 360;
      const ang = degrees * Math.PI / 180;
      const speed = profile ? (profile.speed * (.6 + rng() * .7)) * (mobile ? .62 : 1) : 90 + rng() * 150;
      let x = b.cx, y = b.cy;
      if (profile) {
        p.style.background = i % 3 === 0 ? profile.hot : profile.color;
        p.style.boxShadow = `0 0 ${profile.tier}px ${profile.color}`;
        p.style.width = (profile.tier >= 6 ? 9 + profile.tier : 4) + "px";
        p.style.height = (profile.tier >= 6 ? 2 : 4) + "px";
        if (profile.variant === "chain") x += (i % 2 ? -1 : 1) * (mobile ? 10 : 22);
      }
      b.particles.push({
        el: p, x, y,
        vx: Math.cos(ang) * speed, vy: Math.sin(ang) * speed - 30,
        life: 0, ttl: (profile && profile.variant === "royal" ? 0.5 + rng() * 0.34 : 0.34 + rng() * 0.3) * req.speedMul, r: 1.6 + rng() * 2.2,
        angle: profile && profile.tier >= 6 ? degrees : null,
        swirl: profile && profile.variant === "inferno" ? 2.5 : 0,
        delay: profile && i % 2 ? b.D * (profile.variant === "chain" ? .12 : profile.variant === "royal" ? .11 : 0) / 1000 : 0,
      });
      L.appendChild(p);
    }
    for (let i = 0; i < nSmoke; i++) {
      const p = document.createElement("i");
      p.className = "fx-smoke";
      p.style.opacity = "0";
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
        const age = p.life - (p.delay || 0);
        if (age < 0) { alive++; continue; }
        if (age >= p.ttl) { p.el.style.opacity = "0"; continue; }
        alive++;
        if (p.swirl) {
          const vx = p.vx;
          p.vx -= p.vy * p.swirl * dt; p.vy += vx * p.swirl * dt;
        }
        if (!p.smoke) p.vy += (b.profile && b.profile.tier >= 6 ? 70 : 220) * dt;
        else p.vx *= 0.96, p.vy *= 0.96;
        p.x += p.vx * dt; p.y += p.vy * dt;
        const k = 1 - age / p.ttl;
        p.el.style.transform =
          `translate(${p.x.toFixed(1)}px,${p.y.toFixed(1)}px) translate(-50%,-50%)${p.angle === null || p.angle === undefined ? "" : ` rotate(${(p.angle + age * (p.swirl ? 150 : 0)).toFixed(1)}deg)`} scale(${(p.smoke ? 1 + age * 1.6 : 0.5 + k).toFixed(2)})`;
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
