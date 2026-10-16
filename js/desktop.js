/* 电脑版仅检查此前误装在根目录的离线缓存，不注册新的离线应用。 */
(function () {
  if (location.protocol === "file:" || !("serviceWorker" in navigator)) return;
  const base = new URL("./", location.href);
  navigator.serviceWorker.getRegistration(base.href).then(registration => {
    const worker = registration?.active || registration?.waiting || registration?.installing;
    if (registration?.scope === base.href && worker?.scriptURL === new URL("sw.js", base).href)
      return registration.update();
  }).catch(() => {});
})();
