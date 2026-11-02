/* Safari / 微信工具栏、旋转及浏览器提示回归；不读取玩家存档。 */
const fs = require("node:fs");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const source = fs.readFileSync(require("node:path").join(__dirname, "../mobile/js/offline.js"), "utf8");
function surface({ visual = true, ua = "Safari" } = {}) {
  const events = () => ({ listeners: {}, addEventListener(name, fn) { this.listeners[name] = fn; },
    emit(name) { this.listeners[name]?.(); } });
  const classes = () => ({ values: new Set(["hidden"]), remove(name) { this.values.delete(name); },
    toggle(name, value) { value ? this.values.add(name) : this.values.delete(name); } });
  const properties = new Map(), root = { classList: classes(), style: { setProperty: (k, v) => properties.set(k, v) } };
  const hints = [{ classList: classes() }, { classList: classes() }];
  const viewport = Object.assign(events(), { height: 280, width: 852, scale: 1 });
  const window = Object.assign(events(), { innerHeight: 393, innerWidth: 852,
    visualViewport: visual ? viewport : undefined,
    matchMedia: () => ({ matches: false, addEventListener() {} }) });
  const document = { documentElement: root,
    querySelectorAll: selector => selector === "[data-browser-hint]" ? hints : [],
    getElementById: () => ({ addEventListener() {}, classList: classes() }) };
  vm.runInNewContext(source, { window, document, navigator: { userAgent: ua }, location: { protocol: "file:" } });
  return { window, viewport, properties, hints, has: name => root.classList.values.has(name), compact: () => root.classList.values.has("mobile-short") };
}
let passed = 0;
function check(name, fn) { fn(); passed++; console.log("✓ " + name); }
check("工具栏展开：按 280px 可视高度布局，而非 393px 布局高度", () => {
  const s = surface(); assert.equal(s.properties.get("--mobile-viewport-height"), "280px"); assert(s.compact());
});
check("工具栏收起与再次展开：即时切换常规 / 紧凑布局", () => {
  const s = surface(); s.viewport.height = 393; s.viewport.emit("resize");
  assert.equal(s.properties.get("--mobile-viewport-height"), "393px"); assert(!s.compact());
  s.viewport.height = 240; s.viewport.emit("resize"); assert(s.compact());
  assert.equal(s.properties.get("--mobile-viewport-height"), "240px");
});
check("转回竖屏：退出横屏紧凑布局", () => {
  const s = surface(); s.viewport.width = 393; s.viewport.height = 700; s.window.emit("resize");
  assert(!s.compact()); assert.equal(s.properties.get("--mobile-viewport-height"), "700px");
  assert(!s.has("mobile-landscape")); assert(!s.has("mobile-narrow"));
});
check("窄手机横屏使用侧边操作栏，加宽后恢复整行手牌", () => {
  const s=surface(); s.viewport.width=667; s.viewport.height=375; s.viewport.emit("resize");
  assert(s.has("mobile-landscape")); assert(s.has("mobile-narrow")); assert(!s.compact());
  s.viewport.width=844; s.viewport.emit("resize"); assert(!s.has("mobile-narrow"));
});
check("宽屏设备同样按可视高度进入紧凑布局，不按手机型号限制", () => {
  const s=surface(); s.viewport.width=1180; s.viewport.height=320; s.viewport.emit("resize");
  assert(s.has("mobile-landscape")); assert(s.compact()); assert(!s.has("mobile-narrow"));
});
check("没有 Visual Viewport 的浏览器仍能按窗口高度布局", () => {
  const s = surface({ visual: false }); assert(!s.compact());
  s.window.innerHeight = 280; s.window.emit("resize"); assert(s.compact());
});
check("页面缩放不被误认为工具栏展开", () => {
  const s = surface(); s.viewport.scale = 2; s.viewport.height = 140; s.viewport.emit("resize");
  assert.equal(s.properties.get("--mobile-viewport-height"), "393px"); assert(!s.compact());
});
check("微信显示外部浏览器安装说明，Safari 不显示微信提示", () => {
  const wechat = surface({ ua: "iPhone MicroMessenger/8.0" }), safari = surface();
  assert(wechat.hints.every(h => !h.classList.values.has("hidden")));
  assert(safari.hints.every(h => h.classList.values.has("hidden")));
});
console.log(`${passed} 项手机视口与浏览器提示检查通过`);
