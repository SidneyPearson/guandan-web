/* 退役 v1.10.0 根目录手机版缓存，恢复电脑版入口；手机缓存位于 mobile/。 */
self.addEventListener("install", event => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const prefix = "guandan-offline:" + self.registration.scope + ":";
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith(prefix)).map(name => caches.delete(name)));
    await self.registration.unregister();
  })());
});
