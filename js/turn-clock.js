/* 回合倒计时只负责展示；归零不提交动作，不改变规则或存档。 */
(function () {
  const GD = window.GD;
  GD.createTurnClock = function ({ roots, names }) {
    const duration = 30000;
    let key = "", seat = -1, remaining = duration, deadline = null, timer = null;
    let generation = 0;
    const values = roots.map((root) => {
      root.appendChild(GD.el("span", "clock-icon"));
      const value = GD.el("b", "clock-value", "30");
      root.appendChild(value);
      root.appendChild(GD.el("span", "clock-unit", "s"));
      root.setAttribute("aria-live", "off");
      root.title = "30 秒回合提示，归零后仍可出牌";
      return value;
    });

    function stop() {
      clearTimeout(timer); timer = null; generation++;
    }
    function suspend() {
      stop();
      if (deadline !== null) remaining = Math.max(0, deadline - performance.now());
      deadline = null;
    }
    function clear() {
      suspend(); key = ""; seat = -1;
      roots.forEach((root) => root.classList.add("hidden"));
    }
    function paint(paused) {
      const seconds = Math.ceil(remaining / 1000), root = roots[seat];
      values[seat].textContent = String(seconds);
      root.classList.toggle("is-paused", paused);
      root.classList.toggle("is-urgent", !paused && seconds <= 5);
      root.setAttribute("aria-label", `${names[seat]}${paused ? "已暂停" : "出牌中"}，剩余 ${seconds} 秒`);
    }
    function tick() {
      remaining = Math.max(0, deadline - performance.now());
      paint(false);
      if (remaining > 0) {
        const current = generation;
        timer = setTimeout(() => { if (current === generation) tick(); }, remaining % 1000 || 1000);
      }
    }
    return {
      clear, suspend,
      sync(state) {
        if (state.phase !== "play" || !state.awaiting || state.finished.includes(state.awaiting.seat)) {
          clear(); return;
        }
        const next = `${GD.tableView.handKey(state)}:${state.gen}:${state.awaiting.seat}:${state.awaiting.kind}`;
        suspend();
        if (next !== key) { key = next; remaining = duration; }
        seat = state.awaiting.seat;
        roots.forEach((root, index) => root.classList.toggle("hidden", index !== seat));
        if (state.paused) paint(true);
        else { deadline = performance.now() + remaining; tick(); }
      },
    };
  };
})();
