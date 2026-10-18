/* 同一版本的完整资源一起缓存；新版等待所有旧窗口关闭后启用。 */
importScripts("../js/version.js");
importScripts("../js/voice-lines.js");
const VERSION = self.GD.VERSION;
const PREFIX = "guandan-offline:" + self.registration.scope + ":";
const CACHE = PREFIX + VERSION;
const FILES = [
  "./", "./index.html", "./manifest.webmanifest", "./icons/icon.svg",
  "./icons/icon-192.png", "./icons/icon-512.png", "./icons/apple-touch-icon.png",
  `./css/mobile.css?v=${VERSION}`, `./js/offline.js?v=${VERSION}`,
  ...["style", "table-theme"].map(name => `../css/${name}.css?v=${VERSION}`),
  ...["version", "util", "cards", "rules", "flow", "ai", "fx", "voice-lines", "sound", "stats", "game",
    "table-tools", "table-view", "turn-clock", "active-play", "seat-play", "play-history", "ui"]
    .map(name => `../js/${name}.js?v=${VERSION}`),
  ...self.GD.VOICE_PROFILES.flatMap(profile => Object.keys(self.GD.VOICE_LINES)
    .map(id => `../audio/voice/${profile}/${id}.mp3?v=${VERSION}`)),
].map(file => new URL(file, self.registration.scope).href);
const INDEX = new URL("./index.html", self.registration.scope).href;

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
    const response = await fetch(request);
    if (response.ok && response.status !== 206) await cache.put(key, response.clone());
    return response;
  })());
});
