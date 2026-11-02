/* 离线资源、子路径部署、缓存隔离和更新失败回归；只使用 Node 内置模块。 */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const ROOT = path.resolve(__dirname, "..");
const MOBILE = path.join(ROOT, "mobile");
let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log("✓ " + name); }

function worker(scope = "https://example.test/guandan/mobile/") {
  const events = {}, stores = new Map(), messages = [];
  let online = true, failInstall = false, fetches = 0;
  function cache(name) {
    if (!stores.has(name)) stores.set(name, new Map());
    const map = stores.get(name);
    return {
      async addAll(requests) {
        if (failInstall) throw new Error("missing resource");
        for (const request of requests) map.set(request.url, new Response(request.url));
      },
      async match(key) { return map.get(typeof key === "string" ? key : key.url)?.clone(); },
      async put(key, response) { map.set(key, response); },
    };
  }
  const self = { registration: { scope }, clients: { async claim() {} },
    addEventListener(name, fn) { events[name] = fn; } };
  const context = vm.createContext({ self, URL, Request, Response,
    caches: { open: async name => cache(name), keys: async () => [...stores.keys()],
      delete: async name => stores.delete(name) },
    async fetch(request) {
      fetches++;
      if (!online) throw new Error("offline");
      return new Response(request.url);
    },
    importScripts(file) { vm.runInContext(fs.readFileSync(path.join(MOBILE, file), "utf8"), context); },
  });
  vm.runInContext(fs.readFileSync(path.join(MOBILE, "sw.js"), "utf8"), context);
  const files = Array.from(vm.runInContext("FILES", context));
  const name = vm.runInContext("CACHE", context);
  const dispatch = async (event, extra = {}) => {
    let promise;
    events[event]({ waitUntil(p) { promise = p; }, respondWith(p) { promise = p; }, ...extra });
    return promise;
  };
  return { files, name, stores, scope, messages, dispatch, cache,
    online(value) { online = value; }, fail(value) { failInstall = value; },
    get fetches() { return fetches; },
    request(relative, mode = "cors", method = "GET") {
      return dispatch("fetch", { request: { url: new URL(relative, scope).href, mode, method } });
    },
    status() { return dispatch("message", { data: { type: "OFFLINE_STATUS" },
      source: { postMessage(data) { messages.push(data); } } }); },
  };
}

(async () => {
  const w = worker(), html = fs.readFileSync(path.join(MOBILE, "index.html"), "utf8");
  await check("电脑版和手机版有各自入口，电脑版保留原首页及牌桌", () => {
    const desktop = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
    assert(desktop.includes("四人掼蛋 · 单机畅玩 · 好友联机"));
    for (const entry of ['btnOnlineLan', 'btnOnlinePublic']) {
      assert(desktop.includes(entry)); assert(html.includes(entry));
    }
    assert(desktop.includes('href="mobile/index.html"'));
    assert(!desktop.includes("rotateOverlay"));
    assert(!desktop.includes("css/mobile.css"));
    assert(!desktop.includes('rel="manifest"'));
    assert(!desktop.includes("js/offline.js"));
    assert(html.includes('href="../index.html"'));
    assert(html.includes("rotateOverlay"));
  });
  await check("两版共用原规则和 AI，手机专用功能放在 mobile 内", () => {
    for (const file of ["rules", "ai", "game", "ui", "cards", "version"])
      assert(html.includes(`src="../js/${file}.js?v=`), file);
    assert(!fs.existsSync(path.join(MOBILE, "js/rules.js")));
    assert(fs.existsSync(path.join(MOBILE, "js/offline.js")));
    assert(fs.existsSync(path.join(MOBILE, "css/mobile.css")));
  });
  await check("离线资源覆盖 HTML 中的全部脚本、样式、图标和应用清单", () => {
    const resources = [...html.matchAll(/<(?:script|link)\b[^>]*(?:src|href)="([^"]+)"/g)].map(m => m[1]);
    for (const file of resources) assert(w.files.includes(new URL(file, w.scope).href), file);
    for (const url of w.files) {
      const rel = decodeURIComponent(new URL(url).pathname.slice("/guandan/".length));
      assert(fs.existsSync(path.join(ROOT, rel || "index.html")), rel);
    }
  });
  await check("所有带版本号资源与产品版本一致", () => {
    const version = fs.readFileSync(path.join(ROOT, "js/version.js"), "utf8").match(/GD.VERSION = "([^"]+)"/)[1];
    for (const content of [html, fs.readFileSync(path.join(ROOT, "index.html"), "utf8")])
      for (const match of content.matchAll(/\?v=([^"']+)/g)) assert.equal(match[1], version);
  });
  await check("所有已就绪报牌语音按产品版本缓存，未就绪方言不发起缺失请求", () => {
    const context = { self: {} };
    vm.runInNewContext(fs.readFileSync(path.join(ROOT, "js/version.js"), "utf8"), context);
    vm.runInNewContext(fs.readFileSync(path.join(ROOT, "js/voice-lines.js"), "utf8"), context);
    vm.runInNewContext(fs.readFileSync(path.join(ROOT, "js/voice-config.js"), "utf8"), context);
    vm.runInNewContext(fs.readFileSync(path.join(ROOT, "js/voice-packs.js"), "utf8"), context);
    for (const profile of context.self.GD.voicePreferences.installedProfiles())
      for (const id of Object.keys(context.self.GD.VOICE_LINES))
        assert(w.files.includes(new URL(`../audio/voice/${profile}/${id}.mp3?v=${context.self.GD.VERSION}`, w.scope).href));
    for(const language of context.self.GD.voicePreferences.languages.filter(v=>v.id!=='mandarin'))for(const gender of ['male','female']){
      const profile=language.id+'-'+gender;
      if(!context.self.GD.VOICE_PACKS[profile]?.ready)assert(!w.files.some(url=>new URL(url).pathname.includes('/'+profile+'/')));
    }
  });
  await check("背景音乐及播放器随同一版本完整缓存", () => {
    const version=fs.readFileSync(path.join(ROOT,"js/version.js"),"utf8").match(/GD.VERSION = "([^"]+)"/)[1];
    for(const file of ['../js/music.js','../audio/music/table-loop.mp3'])
      assert(w.files.includes(new URL(file+'?v='+version,w.scope).href));
  });
  await check("应用清单使用相对路径，支持 GitHub Pages 仓库子目录", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(MOBILE, "manifest.webmanifest")));
    assert.equal(manifest.scope, "./");
    assert.equal(manifest.display, "standalone");
    assert.equal(new URL(manifest.start_url, w.scope).pathname, "/guandan/mobile/");
    assert.equal(manifest.orientation, "landscape");
    for (const icon of manifest.icons) {
      const data = fs.readFileSync(path.join(MOBILE, icon.src));
      assert.equal(data.subarray(1, 4).toString(), "PNG");
      const size = Number(icon.sizes.split("x")[0]);
      assert.equal(data.readUInt32BE(16), size);
      assert.equal(data.readUInt32BE(20), size);
    }
  });
  await check("首次安装缓存完整资源", async () => {
    await w.dispatch("install");
    assert.equal(w.stores.get(w.name).size, w.files.length);
    await w.status();
    assert.equal(w.messages.at(-1).ready, true);
  });
  w.online(false);
  await check("断网时桌面启动链接仍返回完整首页", async () => {
    const response = await w.request("./?source=homescreen", "navigate");
    assert.equal(await response.text(), w.scope + "index.html");
    assert.equal(w.fetches, 0);
  });
  await check("断网时每个资源均从缓存读取", async () => {
    for (const url of w.files.filter(url => url !== w.scope)) {
      const response = await w.request(url);
      assert.equal(await response.text(), url);
    }
    assert.equal(w.fetches, 0);
  });
  await check("手机版不拦截电脑版入口、外部资源、其他项目、POST 和未知路径", async () => {
    for (const [url, mode, method] of [
      ["https://elsewhere.test/app.js"], ["https://example.test/another/index.html", "navigate"],
      ["./another/index.html", "navigate"],
      ["../index.html", "navigate"], ["../", "navigate"],
      ["./index.html", "cors", "POST"], ["./missing.png"],
    ]) assert.equal(await w.request(url, mode, method), undefined);
  });
  await check("浏览器清理部分缓存后，不再宣称离线就绪", async () => {
    w.stores.get(w.name).delete(w.files[4]);
    await w.status();
    assert.equal(w.messages.at(-1).ready, false);
  });
  await check("缺失资源重新联网后可以修复", async () => {
    w.online(true);
    await w.request(w.files[4]);
    await w.status();
    assert.equal(w.messages.at(-1).ready, true);
  });
  await check("新版本激活只清除本项目同一作用域的旧缓存", async () => {
    const old = w.name.replace(/:[^:]+$/, ":0.9.0");
    w.cache(old); w.cache("another-app");
    const otherScope = "guandan-offline:https://example.test/another/:1.0.0";
    w.cache(otherScope);
    await w.dispatch("activate");
    assert(!w.stores.has(old));
    assert(w.stores.has("another-app"));
    assert(w.stores.has(otherScope));
    assert(w.stores.has(w.name));
  });
  await check("资源下载失败时不替换或删除已有离线缓存", async () => {
    w.fail(true);
    await assert.rejects(w.dispatch("install"), /missing resource/);
    await w.status();
    assert.equal(w.messages.at(-1).ready, true);
  });
  await check("旧根目录离线缓存退役时，保留手机缓存和其他项目缓存", async () => {
    const events = {}, rootScope = "https://example.test/guandan/";
    const old = "guandan-offline:" + rootScope + ":1.10.0";
    const keys = new Set([old, w.name, "another-app"]);
    let unregistered = false, skipped = false;
    vm.runInNewContext(fs.readFileSync(path.join(ROOT, "sw.js"), "utf8"), {
      self: {
        registration: { scope: rootScope, async unregister() { unregistered = true; } },
        async skipWaiting() { skipped = true; },
        addEventListener(name, callback) { events[name] = callback; },
      },
      caches: { keys: async () => [...keys], delete: async name => keys.delete(name) },
    });
    for (const name of ["install", "activate"]) {
      let pending;
      events[name]({ waitUntil(promise) { pending = promise; } });
      await pending;
    }
    assert(skipped && unregistered);
    assert(!events.fetch);
    assert(!keys.has(old));
    assert(keys.has(w.name) && keys.has("another-app"));
  });
  console.log(`\n手机离线检查：${passed} 项通过。`);
})().catch(error => { console.error(error); process.exitCode = 1; });
