/* Pure DOM integration checks; no browser, layout, audio or real-device claims.
 * Install linkedom outside the game, then run:
 * GUANDAN_DOM_MODULE=/path/to/node_modules/linkedom node test/ui-usability.cjs
 * Product scripts and actual event handlers run unchanged in an isolated VM.
 */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const { parseHTML } = require(process.env.GUANDAN_DOM_MODULE || "linkedom");
const ROOT = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, process.env.GUANDAN_UI_ENTRY || "index.html"), "utf8");
let passed = 0;
function check(name, fn) { fn(); passed++; console.log("✓ " + name); }

function app() {
  const { document, window: dom } = parseHTML(html);
  const memory = new Map(), timers = new Map(), errors = [];
  let now = 0, serial = 0, focus = document.body;
  const hidden = (e) => !!e?.closest(".hidden");
  // Minimal nonvisual DOM shims: dimensions only enable focus filtering.
  Object.defineProperty(document, "activeElement", { get: () => focus });
  dom.HTMLElement.prototype.focus = function () { focus = this; };
  dom.HTMLElement.prototype.scrollIntoView = function () {};
  for (const prop of ["offsetWidth", "clientWidth", "offsetHeight", "scrollWidth"]) {
    Object.defineProperty(dom.HTMLElement.prototype, prop, {
      configurable: true, get() { return hidden(this) ? 0 : prop.includes("Height") ? 100 : 800; },
    });
  }
  Object.defineProperty(dom.HTMLElement.prototype, "offsetParent", {
    configurable: true, get() { return hidden(this) ? null : this.parentElement; },
  });
  Object.defineProperty(dom.HTMLInputElement.prototype, "checked", {
    configurable: true, get() { return this.hasAttribute("checked"); },
    set(value) {
      if (value && this.type === "radio") {
        document.querySelectorAll(`input[name="${this.name}"]`).forEach((e) => e.removeAttribute("checked"));
      }
      this.toggleAttribute("checked", !!value);
    },
  });
  Object.defineProperty(dom.HTMLSelectElement.prototype, "value", {
    configurable: true,
    get() { return (this.querySelector("option[selected]") || this.querySelector("option"))?.value || ""; },
    set(value) { this.querySelectorAll("option").forEach(option => option.toggleAttribute("selected", option.value === value)); },
  });
  const schedule = (fn, ms = 0) => {
    const id = ++serial;
    timers.set(id, { fn, at: now + Number(ms) });
    return id;
  };
  const context = vm.createContext({
    document, console: { log() {}, warn(...v) { errors.push(v); }, error(...v) { errors.push(v); } },
    location: { hash: "", reload() {} }, navigator: {}, innerHeight: 768,
    localStorage: { getItem: (k) => memory.get(k) ?? null, setItem: (k, v) => memory.set(k, String(v)), removeItem: (k) => memory.delete(k) },
    setTimeout: schedule, clearTimeout: (id) => timers.delete(id),
    requestAnimationFrame: (fn) => schedule(() => fn(now), 16), cancelAnimationFrame: (id) => timers.delete(id),
    performance: { now: () => now },
    getComputedStyle: (el) => ({ display: hidden(el) ? "none" : "block", visibility: "visible", zIndex: el.id === "confirmOverlay" ? "70" : el.id === "rulesOverlay" ? "60" : "50" }),
    addEventListener: dom.addEventListener.bind(dom),
  });
  context.window = context;
  for (const file of ["version", "util", "cards", "rules", "flow", "ai", "ai-memory", "ai-search", "ai-client", "voice-lines", "voice-config", "voice-packs", "music", "sound", "stats", "game", "table-tools", "table-view", "turn-clock", "active-play", "seat-play", "play-history", "ui"]) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, "js", file + ".js"), "utf8"), context, { filename: file + ".js" });
  }
  document.dispatchEvent(new dom.Event("DOMContentLoaded"));
  const $ = (id) => document.getElementById(id);
  const click = (id) => {
    const el = $(id);
    assert(el && !hidden(el) && !el.disabled, "unavailable control: " + id);
    el.focus(); el.click();
  };
  const key = (value, shiftKey = false) => {
    const e = new dom.Event("keydown", { bubbles: true, cancelable: true });
    e.key = value; e.shiftKey = shiftKey; document.dispatchEvent(e);
  };
  async function advance(ms) {
    const end = now + ms;
    for (let n = 0; n < 10000; n++) {
      // The decision client adds several promises even without a real Worker.
      for (let flush = 0; flush < 10; flush++) await Promise.resolve();
      const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) { now = end; return; }
      const [id, timer] = next; timers.delete(id); now = timer.at; timer.fn();
    }
    throw new Error("timer loop did not settle");
  }
  function fixture(hands, leader = 0, mode = "practice", difficulty = "easy") {
    const GD = context.GD;
    const state = mode === "practice"
      ? GD.game.newPractice(difficulty, { leader, rand: GD.mulberry32(123) })
      : GD.game.newMatch(difficulty, { leader, rand: GD.mulberry32(123) });
    const pool = GD.buildDeck();
    state.hands = hands.map((ranks) => ranks.map((rank) => {
      const ix = pool.findIndex((card) => card.rank === rank);
      assert(ix >= 0); return pool.splice(ix, 1)[0];
    }));
    state.pile = pool;
    assert(GD.game.validateState(state));
    GD.store.save(state);
    return state;
  }
  function resume(state) {
    context.GD.store.save(state);
    $(state.mode === "practice" ? "btnPracticeContinue" : "btnContinue").classList.remove("hidden");
    click(state.mode === "practice" ? "btnPracticeContinue" : "btnContinue");
  }
  const saved = (mode = "practice") => mode === "practice" ? context.GD.store.loadPractice() : context.GD.store.load();
  return { $, click, key, advance, fixture, resume, saved, memory, errors, document, GD: context.GD };
}

(async () => {
  {
    const a = app();
    check("mode names are consistent and all DOM ids are unique", () => {
      assert.match(a.$("btnStart").textContent, /^完整对局/);
      assert.match(a.$("btnPractice").textContent, /^快速一局/);
      assert.match(a.$("btnPracticeContinue").textContent, /^继续快速一局/);
      assert(!a.document.body.textContent.includes("练习"));
      assert(!a.document.querySelector('input[name="setAuto"]'));
      const ids = [...a.document.querySelectorAll("[id]")].map((el) => el.id);
      assert.equal(new Set(ids).size, ids.length);
    });
  }
  for (const difficulty of ["easy", "normal", "hard"]) {
    const a = app(), requested = [], releases = [];
    a.GD.store.saveSettings({ ...a.GD.store.loadSettings(), difficulty: "hard", autoStrategy: "hard" });
    const state = a.fixture([[3, 9], [4, 10], [5, 11], [6, 12]], 0, "practice", difficulty);
    a.GD.wait = () => new Promise(resolve => releases.push(resolve));
    const original = a.GD.ai.decideAsync;
    a.GD.ai.decideAsync = async (s, seat, options) => {
      const result = await original(s, seat, options);
      requested.push({ seat, tier: result.metrics.tier, override: options?.tier });
      return result;
    };
    a.resume(state); a.click("btnAuto");
    releases.shift()(); await a.advance(0);
    check(difficulty + ": autopilot ignores legacy strategy and uses the current match difficulty", () => {
      assert.equal(requested[0].seat, 0); assert.equal(requested[0].tier, difficulty);
      assert.equal(requested[0].override, undefined);
      assert(!("autoStrategy" in a.GD.store.loadSettings()));
      assert.equal(a.$("autoTag").textContent, "托管 · " + ({ easy: "简单", normal: "普通", hard: "困难" }[difficulty]));
    });
    releases.shift()(); await a.advance(0);
    check(difficulty + ": the next computer uses the identical difficulty entry", () => {
      assert.equal(requested[1].seat, 1); assert.equal(requested[1].tier, requested[0].tier);
      assert.equal(requested[1].override, undefined);
    });
  }
  for (const mode of ["practice", "match"]) {
    const a = app();
    const other = mode === "practice" ? "match" : "practice";
    a.fixture([[8, 8], [3, 4], [6, 6], [7, 9]], 0, other);
    const otherKey = other === "match" ? "gd-save-v3" : "gd-practice-v1";
    const untouched = a.memory.get(otherKey);
    const state = a.fixture([[8, 8], [3, 4], [6, 6], [7, 9]], 1, mode);
    a.resume(state);
    check(mode + ": three primary actions, footer tools and top-right menu are available", () => {
      assert.equal(a.document.querySelectorAll(".action-bar button").length, 3);
      assert.equal(a.document.querySelectorAll(".secondary-actions button").length, 3);
      assert(a.document.querySelector(".table-tools").contains(a.$("btnPause")));
      for (const id of ["btnRules", "btnSettings", "btnStats", "btnNew"]) assert(a.$("pauseOverlay").contains(a.$(id)));
    });
    a.click("btnPause");
    check(mode + ": menu pauses and focuses Continue", () => {
      assert(a.saved(mode).paused); assert.equal(a.document.activeElement.id, "btnResume");
    });
    for (const panel of ["Rules", "Settings", "Stats"]) {
      a.click("btn" + panel); await a.advance(1000);
      check(mode + ": " + panel + " holds game paused", () => assert.equal(a.saved(mode).gen, state.gen));
      a.key("Escape"); await a.advance(40);
      check(mode + ": closing " + panel + " returns to paused menu and trigger", () => {
        assert(!a.$("pauseOverlay").classList.contains("hidden"));
        assert(a.saved(mode).paused); assert.equal(a.document.activeElement.id, "btn" + panel);
      });
    }
    a.click("btnNew");
    check(mode + ": restart confirmation names correct mode and initially focuses Cancel", () => {
      assert.match(a.$("confirmTitle").textContent, mode === "practice" ? /快速一局/ : /完整对局/);
      assert.equal(a.document.activeElement.id, "btnConfirmNo");
    });
    a.key("Tab");
    check(mode + ": confirmation traps keyboard focus", () => assert.equal(a.document.activeElement.id, "btnConfirmYes"));
    a.key("Escape"); await a.advance(1000);
    check(mode + ": cancel keeps menu paused, same game and other save", () => {
      assert(a.saved(mode).paused); assert.equal(a.saved(mode).matchId, state.matchId);
      assert.equal(a.saved(mode).gen, state.gen); assert.equal(a.memory.get(otherKey), untouched);
      assert.equal(a.document.activeElement.id, "btnNew");
    });
    a.click("btnNew"); a.click("btnConfirmYes"); await a.advance(0);
    check(mode + ": confirmed restart preserves mode/difficulty and the other save", () => {
      const next = a.saved(mode);
      assert.equal(next.mode, mode); assert.equal(next.difficulty, "easy");
      assert.notEqual(next.matchId, state.matchId); assert.equal(a.memory.get(otherKey), untouched);
      assert.equal(next.hands.reduce((n, h) => n + h.length, 0), 108);
      assert(!next.paused); assert(a.GD.game.validateState(next));
      assert(a.$("pauseOverlay").classList.contains("hidden"));
    });
    a.click("btnPause"); a.click("btnStats"); await a.advance(40);
    a.click("btnStatsReset"); a.key("Escape");
    check(mode + ": nested reset confirmation returns focus to Stats without dismissing it", () => {
      assert.equal(a.document.activeElement.id, "btnStatsReset");
      assert(!a.$("statsOverlay").classList.contains("hidden"));
    });
    a.key("Escape"); await a.advance(40); a.key("Escape");
    check(mode + ": Escape from menu resumes and returns focus to menu button", () => {
      assert(!a.saved(mode).paused); assert.equal(a.document.activeElement.id, "btnPause");
    });
    assert.deepEqual(a.errors, []);
  }

  for (const difficulty of ["easy", "normal", "hard"]) {
    const a = app();
    const state = a.fixture([[5, 5, 8, 8, 9, 10], [3, 4, 6], [7, 9, 11], [12, 12, 13]], 0, "practice", difficulty);
    a.resume(state);
    const original = a.GD.ai.recommend;
    let requestedTier, recommendation;
    a.GD.ai.recommend = (obs, options) => {
      requestedTier = options.tier; recommendation = original(obs, options); return recommendation;
    };
    a.click("btnHint");
    check(difficulty + ": hints always use steady tier and label first recommendation", () => {
      assert.equal(requestedTier, "hard"); assert.match(a.$("hintBar").textContent, /^首选推荐（稳健）/);
      const ids = [...a.document.querySelectorAll("#handCards .selected")].map((el) => Number(el.dataset.id)).sort((x, y) => x - y);
      assert.equal(JSON.stringify(ids), JSON.stringify(recommendation.cards.map((c) => c.id).sort((x, y) => x - y)));
      assert.equal(a.saved().gen, state.gen);
    });
    a.click("btnHint");
    check(difficulty + ": next candidate is explicitly an alternative", () => assert.match(a.$("hintBar").textContent, /^备选方案 1/));
    let wrapped = false;
    for (let i = 0; i <= recommendation.candidates.length; i++) {
      a.click("btnHint");
      if (a.$("hintBar").textContent.startsWith("首选推荐")) { wrapped = true; break; }
    }
    check(difficulty + ": cycling returns to first recommendation without submitting", () => {
      assert(wrapped); assert.equal(a.saved().gen, state.gen); assert.equal(a.saved().difficulty, difficulty);
    });
    assert.deepEqual(a.errors, []);
  }

  for (const seat of [0, 1, 2, 3]) {
    const a = app();
    const state = a.fixture([[14, 13], [4, 4, 5], seat === 2 ? [17, 6, 7] : [6, 6, 7], [8, 8, 9]], seat);
    assert(a.GD.game.act(state, seat, [state.hands[seat][0]]).ok);
    while (state.awaiting.seat !== 0 && state.trick.target) assert(a.GD.game.act(state, state.awaiting.seat, null).ok);
    a.resume(state);
    check("target seat " + seat + ": restore highlights only live target; closed trick has none", () => {
      const marked = [...a.document.querySelectorAll(".is-target")];
      assert.equal(marked.length, state.trick.target ? 1 : 0);
      if (marked.length) { assert.equal(marked[0].id, "activePlay"); assert.equal(Number(marked[0].dataset.seat), seat); }
    });
    if (seat === 3) {
      check("target and low counts are explicit", () => {
        assert.match(a.$("centerHint").textContent, /当前有效：西家 · 单张 8/);
        assert.match(a.$("seat-3").querySelector(".seat-count").textContent, /仅剩 2 张/);
        assert(a.$("selfStatus").querySelector(".seat-count").classList.contains("low-count"));
      });
      a.$("handCards").firstElementChild.click(); a.click("btnPlay");
      check("human overcall transfers outline to own play", () => {
        assert.equal(a.$("activePlay").dataset.seat, "0");
        assert(a.$("myPlay").classList.contains("has-play"));
        assert(!a.$("play-3").classList.contains("is-target"));
        assert.match(a.$("selfStatus").querySelector(".seat-count").textContent, /仅剩 1 张/);
      });
      // Opponents legally pass: exercise actual async UI -> engine -> render flow.
      a.GD.ai.decideAsync = async () => ({ cards: null });
      a.click("btnPause"); const gen = a.saved().gen;
      await a.advance(1500);
      check("pending AI cannot advance while menu is open", () => assert.equal(a.saved().gen, gen));
      // Allow all three computer turns at the slower standard pace.
      a.click("btnResume"); await a.advance(5000);
      check("resuming progresses AI and removes target on trick close", () => {
        assert(a.saved().gen > gen); assert.equal(a.document.querySelectorAll(".is-target").length, 0);
        assert.match(a.$("turnIndicator").textContent, /领出/);
      });
      a.$("handCards").firstElementChild.click(); a.click("btnPlay");
      check("zero cards clears low-card warning", () => {
        assert(!a.$("selfStatus").querySelector(".seat-count").classList.contains("low-count"));
        assert.match(a.$("selfStatus").querySelector(".seat-count").textContent, /手牌 0 张/);
      });
    }
    if (seat === 2) {
      check("shared statuses distinguish your turn, the target and a public pass", () => {
        assert.match(a.$("turnIndicator").textContent, /轮到你/);
        assert.equal(a.$("selfStatus").dataset.state, "turn");
        assert.equal(a.$("selfStatus").getAttribute("aria-current"), "true");
        assert.equal(a.$("seat-2").dataset.state, "played");
        assert.equal(a.$("seat-2").querySelector(".seat-state").textContent, "已出牌");
        assert.match(a.$("centerHint").textContent, /当前有效：对家/);
        assert(a.$("tableCenter").contains(a.$("activePlay")));
        assert(!a.$("tableCenter").contains(a.$("play-2")));
        assert(a.$("tableCenter").contains(a.$("centerHint")));
        assert.equal(a.$("seat-3").dataset.state, "passed");
        assert.equal(a.$("seat-3").querySelector(".seat-state").textContent, "已不出");
      });
      a.click("btnHint");
      check("pass recommendation stays explicit and never auto-passes", () => {
        assert.match(a.$("hintBar").textContent, /^首选推荐（稳健） · 不要/);
        assert.equal(a.document.querySelectorAll("#handCards .selected").length, 0);
        assert.equal(a.saved().gen, state.gen);
      });
    }
    assert.deepEqual(a.errors, []);
  }
  {
    const a = app();
    const state = a.fixture([[5, 9, 13], [6, 10, 13], [7, 11, 13], [8, 12, 13]], 0);
    const restore = () => {
      if (a.$("homeOverlay").classList.contains("hidden")) {
        a.click("btnPause"); a.click("btnPauseHome");
      }
      a.resume(state);
    };
    for (let seat = 0; seat < 4; seat++) assert(a.GD.game.act(state, seat, [state.hands[seat][0]]).ok);
    restore();
    check("history shows the real ordered actions while central play has exactly one target", () => {
      const rows = [...a.$("historyList").children];
      assert.deepEqual(rows.map(row => Number(row.dataset.seat)), [0, 1, 2, 3]);
      rows.forEach((row, i) => {
        assert.deepEqual([...row.querySelectorAll(".mini-card")].map(card => Number(card.dataset.cardId)), Array.from(state.log[i].ids));
      });
      assert.equal(a.$("activePlay").dataset.seat, "3");
      assert.equal(JSON.stringify(a.saved().log), JSON.stringify(state.log));
      assert.equal(JSON.stringify(a.saved().hands), JSON.stringify(state.hands));
    });
    const nextOwnId = state.hands[0][0].id;
    assert(a.GD.game.act(state, 0, [state.hands[0][0]]).ok);
    assert(a.GD.game.act(state, 1, [state.hands[1][0]]).ok);
    restore();
    check("history preserves repeated actions from the same player and latest central target", () => {
      const rows = [...a.$("historyList").children];
      assert.deepEqual(rows.map(row => Number(row.dataset.seat)), [0, 1, 2, 3, 0, 1]);
      assert.equal(Number(rows[4].querySelector(".mini-card").dataset.cardId), nextOwnId);
      assert.equal(a.$("activePlay").dataset.seat, "1");
    });
    const start = state.trick.startLogIndex;
    delete state.trick.startLogIndex;
    restore();
    check("legacy saves without a trick boundary keep the genuine log and the actual target", () => {
      assert.equal(a.$("historyList").children.length, 6);
      assert.equal(a.$("activePlay").dataset.seat, "1");
      assert.match(a.$("centerHint").textContent, /当前有效：东家/);
    });
    state.trick.startLogIndex = start;
    while (state.trick.target) assert(a.GD.game.act(state, state.awaiting.seat, null).ok);
    restore();
    check("trick close clears the active play while history retains the actual passes", () => {
      assert.equal(a.$("historyList").children.length, 9);
      assert.equal(a.$("tableCenter").querySelectorAll(".mini-card").length, 0);
      assert(!a.$("trickEmpty").classList.contains("hidden"));
      assert.match(a.$("turnIndicator").textContent, /领出/);
    });
    assert.deepEqual(a.errors, []);
  }
  {
    const a = app();
    const state = a.fixture([[5, 9, 14], [6, 10, 14], [7, 11, 14], [8, 12, 14]], 0);
    let release;
    a.GD.wait = () => new Promise(resolve => { release = resolve; });
    a.GD.ai.decideAsync = async (s, seat) => ({ cards: [s.hands[seat][0]] });
    a.resume(state);
    a.$("handCards").lastElementChild.click(); a.click("btnPlay");
    for (let seat = 0; seat < 4; seat++) {
      if (seat) { release(); await a.advance(0); }
      check("live action at seat " + seat + " updates only the corresponding preview and central target", () => {
        const preview = a.$(seat === 0 ? "myPlay" : "play-" + seat);
        assert(preview.classList.contains("has-play"));
        assert.equal(preview.querySelectorAll(".mini-card").length, 1);
        assert.equal(a.$("activePlay").dataset.seat, String(seat));
        const last = a.saved().log.at(-1);
        assert.equal(Number(preview.querySelector(".mini-card").dataset.cardId), last.ids[0]);
        assert.equal(Number(a.$("activePlay").firstElementChild.dataset.cardId), last.ids[0]);
        assert.equal(a.$("turn-clock-" + ((seat + 1) % 4)).querySelector(".clock-value").textContent, "30");
        for (let previous = 0; previous <= seat; previous++) {
          if (previous === (seat + 1) % 4) continue;
          assert.equal(a.$(previous ? "seat-" + previous : "selfStatus").querySelector(".seat-state").textContent, "已出牌");
        }
      });
    }
    await a.advance(300);
    a.$("handCards").lastElementChild.click(); a.click("btnPlay");
    const latestId = a.$("activePlay").firstElementChild.dataset.cardId;
    await a.advance(550);
    check("old preview expiry cannot remove a newer play at the same seat or overwrite the target", () => {
      assert(a.$("myPlay").classList.contains("has-play"));
      assert.equal(a.$("activePlay").firstElementChild.dataset.cardId, latestId);
    });
    await a.advance(400);
    check("preview expires independently while the central effective cards remain", () => {
      assert.equal(a.document.querySelectorAll(".seat-play.has-play").length, 0);
      assert.equal(a.$("activePlay").firstElementChild.dataset.cardId, latestId);
    });
    a.click("historyToggle");
    check("history opens without pausing and lists real repeated events", () => {
      assert(!a.$("playHistoryPanel").classList.contains("hidden"));
      assert.equal(a.$("historyList").children.length, a.saved().log.length);
      assert(!a.saved().paused);
    });
    a.key("Escape");
    check("Escape dismisses history without pausing or changing game state", () => {
      assert(a.$("playHistoryPanel").classList.contains("hidden"));
      assert(!a.saved().paused);
    });
    for (let i = 0; i < 3; i++) { release(); await a.advance(0); }
    const beforePassId = a.$("activePlay").firstElementChild.dataset.cardId;
    a.click("btnPass");
    check("passing adds a real history row and leaves the effective target unchanged", () => {
      assert.equal(a.$("activePlay").firstElementChild.dataset.cardId, beforePassId);
      assert.equal(a.$("historyList").lastElementChild.dataset.kind, "pass");
      assert.match(a.$("historySummary").textContent, /不出/);
    });
  }
  {
    const a = app();
    const state = a.fixture([[4, 5, 6, 7, 8, 9], [10, 11], [12, 13], [14, 3]], 0);
    for (let i = 0; i < 4; i++) {
      assert(a.GD.game.act(state, 0, [state.hands[0][0]]).ok);
      while (state.trick.target) assert(a.GD.game.act(state, state.awaiting.seat, null).ok);
    }
    a.resume(state);
    check("history caps at twelve actual events and keeps original sequence numbers across tricks", () => {
      const rows = [...a.$("historyList").children];
      assert.equal(rows.length, 12);
      assert.equal(rows[0].dataset.sequence, "5");
      assert.equal(rows[11].dataset.sequence, "16");
      assert.deepEqual(rows.map(e => e.dataset.kind), Array.from(state.log.slice(-12), e => e.kind));
    });
    const fallback = { ...state, log: undefined, lastTrick: { ...state.lastTrick, actions: null } };
    check("legacy result fallback uses genuine saved cards and never invents chronological actions", () => {
      const events = a.GD.tableView.recent(fallback);
      assert.equal(events.length, 4);
      assert(events.every(e => e.sequence === null));
      assert.equal(events.filter(e => e.kind === "pass").length, 3);
    });
  }
  {
    const a = app();
    const state = a.fixture([[5, 6], [8, 9], [10, 11], [12, 13]], 0);
    a.resume(state);
    check("empty or illegal selections keep the primary Play action disabled", () => {
      assert(a.$("btnPlay").disabled);
      a.$("handCards").firstElementChild.click();
      a.$("handCards").lastElementChild.click();
      assert(a.$("btnPlay").disabled);
      a.click("btnClear");
      assert(a.$("btnPlay").disabled);
    });
    check("counter-clockwise seat mapping keeps partner opposite", () => {
      assert(a.$("seat-1").classList.contains("seat-right"));
      assert(a.$("seat-3").classList.contains("seat-left"));
      assert(a.$("seat-2").classList.contains("seat-top"));
    });
    check("recorder is initially collapsed", () => {
      assert(a.$("recorderPanel").classList.contains("hidden"));
      assert.equal(a.$("btnRecorder").getAttribute("aria-expanded"), "false");
    });
    a.click("btnRecorder");
    check("recorder displays all fifteen ranks without pausing the game", () => {
      assert.equal(a.$("recorderGrid").children.length, 15);
      assert.equal(a.$("recorderTotal").textContent, "6");
      assert(!a.saved().paused);
      assert.equal(a.$("btnRecorder").getAttribute("aria-expanded"), "true");
    });
    check("touching the hand keeps the recorder open for continuous tracking", () => {
      const pointer = new a.document.defaultView.Event("pointerdown", { bubbles: true });
      pointer.pointerType = "touch";
      a.$("handCards").firstElementChild.dispatchEvent(pointer);
      assert(!a.$("recorderPanel").classList.contains("hidden"));
    });
    a.GD.ai.decideAsync = async (s, seat) => ({ cards: seat === 1 ? [s.hands[seat][0]] : null });
    a.$("handCards").firstElementChild.click(); a.click("btnPlay");
    check("own play preserves outside remaining count and advances to right seat", () => {
      assert.equal(a.$("recorderTotal").textContent, "6");
      assert.equal(a.saved().awaiting.seat, 1);
      assert(a.$("seat-1").classList.contains("is-turn"));
    });
    check("central turn status names the thinking computer without repeating it beside the avatar", () => {
      assert.match(a.$("turnIndicator").textContent, /东家.*思考中/);
      assert.equal(a.$("seat-1").dataset.state, "thinking");
      assert.equal(a.$("seat-1").getAttribute("aria-current"), "true");
      assert.equal(a.$("seat-1").querySelector(".seat-state").textContent, "");
      assert(a.$("tableCenter").contains(a.$("turnIndicator")));
      assert.equal(a.$("selfStatus").dataset.state, "played");
    });
    await a.advance(1500);
    check("recorder updates on a real opponent play while remaining open", () => {
      assert.equal(a.$("recorderTotal").textContent, "5");
      assert.equal(a.$("recorderGrid").querySelector('[data-rank="8"] .recorder-count').textContent, "0");
      assert(!a.$("recorderPanel").classList.contains("hidden"));
    });
    a.key("Escape");
    check("Escape closes only recorder and returns keyboard focus", () => {
      assert(a.$("recorderPanel").classList.contains("hidden"));
      assert.equal(a.document.activeElement.id, "btnRecorder");
      assert(!a.saved().paused);
    });
    a.click("btnRecorder"); a.click("btnPause");
    check("opening menu closes recorder and still pauses the game", () => {
      assert(a.$("recorderPanel").classList.contains("hidden"));
      assert(a.saved().paused);
    });
    check("pause clears active-turn markers and replaces all four seat statuses", () => {
      assert.match(a.$("turnIndicator").textContent, /已暂停/);
      assert.equal(a.document.querySelectorAll(".is-turn").length, 0);
      assert.equal(a.document.querySelectorAll('[aria-current="true"]').length, 0);
      for (const el of a.document.querySelectorAll(".seat-state")) assert.equal(el.textContent, "");
    });
    a.click("btnNew"); a.click("btnConfirmYes"); await a.advance(40);
    a.click("btnRecorder");
    check("new hand refreshes recorder to eighty-one outside cards", () => {
      assert.equal(a.$("recorderTotal").textContent, "81");
      assert(a.GD.game.validateState(a.saved()));
    });
    assert.deepEqual(a.errors, []);
  }
  {
    const a = app();
    a.GD.wait = () => new Promise(() => {}); // 保持电脑回合，单独验证展示时钟。
    const state = a.fixture([[3, 4, 5], [6, 7], [8, 9], [10, 11]]);
    a.resume(state);
    const clock = a.$("turn-clock-0"), seconds = () => clock.querySelector(".clock-value").textContent;
    const visibleClocks = () => [...a.document.querySelectorAll(".turn-clock:not(.hidden)")];
    check("only the current player starts with a 30-second clock", () => {
      assert.deepEqual(visibleClocks().map(el => el.id), ["turn-clock-0"]);
      assert.equal(seconds(), "30");
      assert.equal(clock.getAttribute("aria-live"), "off");
    });
    await a.advance(5400);
    a.click("btnOrganize"); a.click("btnHint"); a.click("btnClear");
    check("selection, hints and arranging cards do not restart the countdown", () => assert.equal(seconds(), "25"));
    a.click("btnPause");
    await a.advance(10000);
    check("menu pause freezes the countdown without progressing the game", () => {
      assert.equal(seconds(), "25"); assert(clock.classList.contains("is-paused"));
      assert.equal(a.saved().gen, state.gen);
    });
    a.click("btnResume"); await a.advance(600);
    check("resume preserves the partial second instead of giving a fresh 30 seconds", () => {
      assert.equal(seconds(), "24"); assert(!clock.classList.contains("is-paused"));
    });
    await a.advance(19000);
    check("last five seconds use the urgent appearance", () => {
      assert.equal(seconds(), "5"); assert(clock.classList.contains("is-urgent"));
    });
    await a.advance(8000);
    check("zero remains visible and never plays, passes or enables autopilot", () => {
      assert.equal(seconds(), "0"); assert.equal(a.saved().gen, state.gen);
      assert.equal(a.saved().autoPilot, false); assert.equal(a.saved().awaiting.seat, 0);
    });
    a.$("handCards").firstElementChild.click(); a.click("btnPlay");
    check("playing after zero is allowed and transfers a fresh clock to the east seat", () => {
      assert.deepEqual(visibleClocks().map(el => el.id), ["turn-clock-1"]);
      assert.equal(a.$("turn-clock-1").querySelector(".clock-value").textContent, "30");
      assert.equal(a.$("selfStatus").querySelector(".seat-state").textContent, "已出牌");
    });
    await a.advance(1100); a.click("btnAuto");
    check("autopilot redraw does not restart the current computer's countdown", () => {
      assert.equal(a.$("turn-clock-1").querySelector(".clock-value").textContent, "29");
    });
    assert.deepEqual(a.errors, []);
  }
  for (const seat of [1, 2, 3]) {
    const a = app(); a.GD.wait = () => new Promise(() => {});
    a.resume(a.fixture([[3, 4], [6, 7], [8, 9], [10, 11]], seat));
    await a.advance(1000);
    check("seat " + seat + ": thinking computer owns the only running countdown", () => {
      const visible = [...a.document.querySelectorAll(".turn-clock:not(.hidden)")];
      assert.equal(visible.length, 1); assert.equal(visible[0].id, "turn-clock-" + seat);
      assert.equal(visible[0].querySelector(".clock-value").textContent, "29");
      assert.equal(a.$("seat-" + seat).getAttribute("aria-current"), "true");
    });
  }
  {
    const a = app(); a.GD.wait = () => Promise.resolve(); a.GD.ai.decideAsync = async () => ({ cards: null });
    a.resume(a.fixture([[3, 4, 5], [6, 7], [8, 9], [10, 11]]));
    await a.advance(12000);
    a.$("handCards").firstElementChild.click(); a.click("btnPlay");
    for (let i = 0; i < 4; i++) await a.advance(0);
    check("three passes start a new trick with a fresh clock and clear old action labels", () => {
      assert.equal(a.saved().awaiting.kind, "lead"); assert.equal(a.saved().awaiting.seat, 0);
      assert.equal(a.$("turn-clock-0").querySelector(".clock-value").textContent, "30");
      assert.deepEqual([...a.document.querySelectorAll(".seat-state")].map(el => el.textContent), ["", "", "", ""]);
    });
  }
  {
    const a = app(); a.click("btnHomeSettings");
    check("voice controls default to enabled role voices with preview available", () => {
      assert(a.$("setVoice").checked); assert.equal(a.$("setVoiceStyle").value, "roles"); assert(!a.$("btnVoicePreview").disabled);
      assert.equal(a.$("btnVoicePreview").textContent, "试听四家");
      assert(!a.$("voiceRoleHint").classList.contains("hidden"));
      assert.equal(a.GD.VOICE_SEATS.length, 4); assert.equal(new Set(a.GD.VOICE_SEATS).size, 4);
    });
    check("sound master disables voice controls and persists mute", () => {
      a.$("setSound").checked = false; a.$("setSound").onchange();
      assert(!a.GD.store.loadSettings().sound); assert(a.$("setVoice").disabled); assert(a.$("btnVoicePreview").disabled);
    });
    check("speech can be disabled independently while effects remain audible", () => {
      a.$("setSound").checked = true; a.$("setSound").onchange();
      a.$("setVoice").checked = false; a.$("setVoice").onchange();
      const s = a.GD.store.loadSettings(); assert(s.sound); assert(!s.voice); assert(a.$("setVoiceStyle").disabled);
    });
    check("selected voice style persists through the actual settings handler", () => {
      a.$("setVoice").checked = true; a.$("setVoice").onchange();
      for (const option of a.$("setVoiceStyle").querySelectorAll("option")) option.selected = option.value === "calm";
      a.$("setVoiceStyle").onchange(); assert.equal(a.GD.store.loadSettings().voiceStyle, "calm");
      assert.equal(a.$("btnVoicePreview").textContent, "试听四家"); assert(!a.$("voiceRoleHint").classList.contains("hidden"));
      assert(a.GD.store.loadSettings().seatVoices.every(v=>v.gender==='male'));
      a.click("btnSettingsClose"); assert(!a.GD.sound.getVoiceState().active);
    });
  }
  for (const scene of [
    { name: "unbeatable opponent after the trick closes", own: [3, 4], leader: 1, canBeat: false, checks: 1 },
    { name: "strategic pass with an available response", own: [8, 4], leader: 1, canBeat: true, checks: 1 },
    { name: "strategic pass preserving a playable bomb", own: [3, 3, 3, 3, 4], leader: 1, canBeat: true, checks: 1 },
    { name: "passing on a partner's play", own: [3, 4], leader: 2, checks: 0 },
    { name: "confirmed partner handoff", own: [3, 4], leader: 1, finished: true, checks: 0 },
  ]) {
    const a = app(); a.GD.wait = () => new Promise(() => {});
    const hands = [scene.own, [5, 6], [5, 6], [5, 6]];
    hands[scene.leader] = scene.finished ? [7] : [7, 9];
    const state = a.fixture(hands, scene.leader);
    const led = a.GD.game.act(state, scene.leader, [state.hands[scene.leader].find(c => c.rank === 7)]);
    assert(led.ok); assert.equal(led.followed, null);
    while (state.awaiting.seat !== 0) assert(a.GD.game.act(state, state.awaiting.seat, null).ok);
    let received = null, beatChecks = 0;
    const findBeats = a.GD.rules.findBeats;
    a.GD.rules.findBeats = (hand, target, level) => {
      beatChecks++;
      assert.deepEqual(Array.from(hand, c => c.id), Array.from(state.hands[0], c => c.id));
      assert.equal(target.type, "single"); assert.equal(target.value, 7);
      return findBeats(hand, target, level);
    };
    a.GD.sound.announce = (result, options) => { received = { result, options }; return true; };
    a.resume(state); a.click("btnPass");
    check("actual pass audio context handles " + scene.name, () => {
      assert(received); assert.equal(received.result.followed.seat, scene.leader);
      assert.equal(received.result.followed.play.value, 7);
      assert.equal(received.options.canBeat, scene.canBeat); assert.equal(beatChecks, scene.checks);
      if (scene.leader === 1) assert.equal(a.saved().trick.target, null);
      if (scene.finished) assert.equal(received.result.event.type, "jiefeng");
      assert(!Object.hasOwn(a.saved(), "followed"));
      assert(a.GD.game.validateState(a.saved())); assert.deepEqual(a.errors, []);
    });
  }
  console.log(`\n${passed} DOM integration checks passed; layout and real browser input not assessed.`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
