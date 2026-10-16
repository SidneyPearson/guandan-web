/* 四向短预览：只接收真实成功动作，生命周期与中央有效牌完全独立。 */
(function () {
  const GD = window.GD;
  GD.createSeatPlay = function ({ roots, renderCard, cardsById, names }) {
    const timers = new Map();
    let boundary = "", pending = null, lastKey = "";
    function clearSeat(seat) {
      clearTimeout(timers.get(seat)); timers.delete(seat);
      const root = roots[seat];
      root.innerHTML = ""; root.classList.remove("has-play");
      root.removeAttribute("aria-label"); delete root.dataset.actionKey;
    }
    function clear() { roots.forEach((_, seat) => clearSeat(seat)); pending = null; }
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
