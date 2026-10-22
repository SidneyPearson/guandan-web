/* 中央有效牌只由当前引擎状态驱动；动画回调不能更新它。 */
(function () {
  const GD = window.GD;
  GD.createActivePlay = function ({ root, cards, caption, empty, renderCard, describe, names }) {
    let renderedKey = null;
    return {
      render(state) {
        const current = GD.tableView.target(state);
        const key = GD.tableView.handKey(state) + ":" + state.currentLevel + ":" +
          (current ? current.seat + ":" + current.play.cards.map(c => c.id).join(",") : "empty");
        root.classList.toggle("has-target", !!current);
        cards.classList.toggle("is-target", !!current);
        empty.classList.toggle("hidden", state.phase !== "play" || !!current);
        if (current) {
          cards.dataset.seat = current.seat;
          cards.style.setProperty("--play-count", current.play.cards.length);
          cards.style.setProperty("--play-columns", Math.max(1, current.play.cards.length - 1));
          cards.classList.toggle("single-card", current.play.cards.length === 1);
          caption.textContent = `当前有效：${names[current.seat]} · ${describe(current.play)}`;
        } else {
          delete cards.dataset.seat;
          caption.textContent = "";
        }
        if (key === renderedKey) return;
        renderedKey = key;
        cards.classList.remove("fx-outline");
        cards.innerHTML = "";
        if (current) for (const card of current.play.cards) {
          const el = renderCard(card, true, state.currentLevel);
          el.dataset.cardId = card.id;
          cards.appendChild(el);
        }
      },
    };
  };
})();
