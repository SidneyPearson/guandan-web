/* 工具函数 */
(function () {
  const GD = (window.GD = window.GD || {});

  // rand 可注入（测试/评测用确定性随机源）；默认 Math.random。
  // 洗牌随机与策略随机、UI 等待随机各自独立，互不污染。
  GD.shuffle = function (arr, rand) {
    const r = rand || Math.random;
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  };

  // 确定性 PRNG（mulberry32）：同一 seed 的发牌/采样可重现
  GD.mulberry32 = function (seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  GD.hashSeed = function () {
    return (Math.random() * 0xffffffff) >>> 0;
  };

  GD.uid = function () {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  };

  // 延迟（毫秒）
  GD.wait = function (ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  };

  GD.el = function (tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
})();
