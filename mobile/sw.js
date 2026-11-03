/* 同一版本的完整资源一起缓存；新版等待所有旧窗口关闭后启用。 */
importScripts("../js/version.js?v=1.25.3");
for (const file of ["voice-lines", "voice-config", "voice-packs"])
  importScripts(`../js/${file}.js?v=${self.GD.VERSION}`);
const VERSION = self.GD.VERSION;
const PREFIX = "guandan-offline:" + self.registration.scope + ":";
// Migrate existing caches whose unversioned index may contain an older CDN page.
const CACHE = PREFIX + VERSION + ":versioned-entry";
const INDEX = new URL(`./index.html?v=${VERSION}`, self.registration.scope).href;
const FILES = [
  INDEX, "./manifest.webmanifest", "./icons/icon.svg",
  "./icons/icon-192.png", "./icons/icon-512.png", "./icons/apple-touch-icon.png",
  `./css/mobile.css?v=${VERSION}`, `./js/offline.js?v=${VERSION}`,
  `../audio/music/table-loop.mp3?v=${VERSION}`,
  ...["style", "table-theme", "online"].map(name => `../css/${name}.css?v=${VERSION}`),
  ...["version", "util", "cards", "rules", "flow", "ai", "ai-memory", "ai-search", "ai-client", "ai-worker", "ai-worker-source", "fx", "voice-lines", "voice-config", "voice-packs", "music", "sound", "stats", "game",
    "table-tools", "table-view", "turn-clock", "active-play", "seat-play", "play-history", "vendor/socket.io.min", "online-view", "online", "ui"]
    .map(name => `../js/${name}.js?v=${VERSION}`),
  ...self.GD.voicePreferences.installedProfiles().flatMap(profile => Object.keys(self.GD.VOICE_LINES)
    .map(id => `../audio/voice/${profile}/${id}.mp3?v=${VERSION}`)),
].map(file => new URL(file, self.registration.scope).href);

self.addEventListener("install", event => {
  // addAll 是原子写入；缺一项就不发布新缓存，旧版本仍然可用。
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(
    FILES.map(url => new Request(url, { cache: "reload" }))
  )));
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith(PREFIX) && key !== CACHE)
      .map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener("message", event => {
  if (event.data?.type !== "OFFLINE_STATUS" || !event.source) return;
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const ready = (await Promise.all(FILES.map(url => cache.match(url)))).every(Boolean);
    event.source.postMessage({ type: "OFFLINE_STATUS", version: VERSION, ready });
  })());
});

self.addEventListener("fetch", event => {
  const request = event.request, url = new URL(request.url);
  if (request.method !== "GET") return;
  const navigation = request.mode === "navigate" &&
    (url.pathname === new URL(self.registration.scope).pathname || url.pathname === new URL(INDEX).pathname);
  if (!navigation && !FILES.includes(url.href)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const key = navigation ? INDEX : url.href;
    const cached = await cache.match(key);
    if (cached) return cached;
    const response = await fetch(navigation ? new Request(INDEX, { cache: "reload" }) : request);
    if (response.ok && response.status !== 206) await cache.put(key, response.clone());
    return response;
  })());
});
