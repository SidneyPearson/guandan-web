/* 单一记录入口：最近摘要与展开的真实动作共用同一日志切片。 */
(function () {
  const GD = window.GD;
  GD.createPlayHistory = function ({ toggle, panel, list, summary, close, renderCard, cardsById, names }) {
    let hand = "", renderedKey = "";
    function setOpen(open, focus = false) {
      panel.classList.toggle("hidden", !open);
      toggle.setAttribute("aria-expanded", String(open));
      if (focus) toggle.focus();
    }
    toggle.onclick = () => setOpen(panel.classList.contains("hidden"));
    close.onclick = () => setOpen(false, true);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !panel.classList.contains("hidden")) {
        event.preventDefault(); event.stopImmediatePropagation(); setOpen(false, true);
      }
    }, true);
    document.addEventListener("pointerdown", (event) => {
      if (!panel.contains(event.target) && !toggle.contains(event.target)) setOpen(false);
    });
    return {
      close: () => setOpen(false),
      render(state) {
        const nextHand = GD.tableView.handKey(state);
        if (nextHand !== hand) { hand = nextHand; renderedKey = ""; setOpen(false); }
        const events = GD.tableView.recent(state), last = events[events.length - 1];
        summary.textContent = last ? (last.sequence === null ? "上一墩结果" :
          `最近：${names[last.seat]} · ${last.kind === "pass" ? "不出" : GD.TYPE_LABEL[last.play.type]}`) : "出牌记录";
        toggle.title = summary.textContent + "，展开最近12次动作";
        const key = hand + ":" + state.currentLevel + ":" + JSON.stringify(events);
        if (key === renderedKey) return;
        renderedKey = key; list.innerHTML = "";
        if (!events.length) { list.appendChild(GD.el("p", "history-empty", "本副尚无出牌记录")); return; }
        for (const event of events) {
          const row = GD.el("div", "history-row");
          row.dataset.seat = event.seat; row.dataset.kind = event.kind;
          if (event.sequence !== null) row.dataset.sequence = event.sequence;
          row.appendChild(GD.el("span", "history-step", event.sequence === null ? "·" : String(event.sequence).padStart(2, "0")));
          row.appendChild(GD.el("span", "history-name", names[event.seat]));
          row.appendChild(GD.el("span", "history-type", event.kind === "pass" ? "不出" : GD.TYPE_LABEL[event.play.type]));
          if (event.kind === "play") {
            const cards = GD.el("div", "history-cards");
            for (const id of event.ids) {
              const card = cardsById.get(id);
              if (card) {
                const el = renderCard(card, true, state.currentLevel);
                el.dataset.cardId = id; cards.appendChild(el);
              }
            }
            row.appendChild(cards);
          }
          list.appendChild(row);
        }
      },
    };
  };
})();
