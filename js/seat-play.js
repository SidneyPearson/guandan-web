/* 公开出牌：手机保留本墩动作，桌面显示短预览；均与中央有效牌独立。 */
(function () {
  const GD = window.GD;
  GD.createSeatPlay = function ({ roots, renderCard, cardsById, names, persistent = false, describe }) {
    const timers = new Map();
    let boundary = "", pending = null, lastKey = "";
    function clearSeat(seat) {
      clearTimeout(timers.get(seat)); timers.delete(seat);
      const root = roots[seat];
      root.innerHTML = ""; root.classList.remove("has-play");
      root.removeAttribute("aria-label"); delete root.dataset.actionKey;
    }
    function clear() { roots.forEach((_, seat) => clearSeat(seat)); pending = null; }
    function renderRound(state) {
      roots.forEach((root, seat) => {
        const entry = GD.tableView.seatAction(state, seat);
        const ids = entry?.ids || state.table[seat]?.cards?.map(c => c.id) || [];
        const key = GD.tableView.handKey(state) + ":" + state.trick.startLogIndex + ":" +
          (entry ? entry.kind + ":" + ids.join(",") : "empty");
        root.classList.toggle("current-play", !!entry && state.trick.targetSeat === seat);
        if (root.dataset.actionKey === key) return;
        clearSeat(seat);
        if (!entry) return;
        if (entry.kind === "play" && ids.length) {
          const row = GD.el("div", "preview-cards" + (ids.length === 1 ? " single-card" : ""));
          row.style.setProperty("--play-count", ids.length);
          row.style.setProperty("--play-columns", Math.max(1, ids.length - 1));
          for (const id of ids) {
            const card = cardsById.get(id);
            if (!card) continue;
            const el = renderCard(card, true, state.currentLevel);
            el.dataset.cardId = id; row.appendChild(el);
          }
          root.appendChild(row);
        }
        const text = entry.kind === "pass" ? "不出" : entry.play && describe
          ? describe(entry.play, ids.map(id => cardsById.get(id)).filter(Boolean)) : "已出牌";
        root.appendChild(GD.el("span", "preview-label", text));
        root.dataset.actionKey = key;
        root.setAttribute("aria-label", `${names[seat]}本墩：${text}`);
        root.classList.add("has-play");
      });
    }
    return {
      clear,
      notify(state, result) {
        if (!result.ok || result.kind !== "play" || state.phase !== "play") return;
        const log = state.log || [], entry = log[log.length - 1];
        if (!entry || entry.kind !== "play" || entry.seat !== result.seat) return;
        const key = GD.tableView.handKey(state) + ":" + log.length;
        if (key === lastKey) return;
        lastKey = key;
        pending = { ...entry, key, index: log.length - 1 };
      },
      sync(state, settings) {
        const next = GD.tableView.handKey(state) + ":" + (state.trick?.startLogIndex ?? "legacy");
        if (boundary !== next) {
          roots.forEach((_, seat) => clearSeat(seat)); boundary = next;
        }
        if (state.paused || state.phase !== "play" || !state.trick.target) { clear(); return; }
        if (persistent) { pending = null; renderRound(state); return; }
        const event = pending; pending = null;
        if (!event || event.index < (state.trick.startLogIndex || 0)) return;
        clearSeat(event.seat);
        const root = roots[event.seat], row = GD.el("div", "preview-cards");
        for (const id of event.ids) {
          const card = cardsById.get(id);
          if (!card) continue;
          const el = renderCard(card, true, state.currentLevel);
          el.dataset.cardId = id; row.appendChild(el);
        }
        root.appendChild(row);
        root.appendChild(GD.el("span", "preview-label", "刚刚出牌"));
        root.dataset.actionKey = event.key;
        root.setAttribute("aria-label", `${names[event.seat]}刚出${event.ids.length}张${GD.TYPE_LABEL[event.play.type]}`);
        root.classList.add("has-play");
        const duration = settings.speed === "fast" ? 440 : settings.speed === "slow" ? 1000 : 800;
        timers.set(event.seat, setTimeout(() => {
          if (root.dataset.actionKey === event.key) clearSeat(event.seat);
        }, duration));
      },
    };
  };
})();
