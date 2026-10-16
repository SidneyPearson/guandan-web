/* 安装和离线提示独立于游戏状态，不刷新对局、不修改玩家存档。 */
(function () {
  const statuses = document.querySelectorAll("[data-offline-status]");
  const button = document.getElementById("btnInstall");
  let installPrompt = null, ready = false, waiting = false, registration = null;
  const installed = () => window.matchMedia?.("(display-mode: standalone)").matches || navigator.standalone;
  // Safari/微信工具栏展开时，实际可视高度可能小于布局视口。
  function fitViewport() {
    const viewport = window.visualViewport;
    const height = Math.round(viewport && viewport.scale === 1 ? viewport.height : window.innerHeight);
    const width = Math.round(viewport && viewport.scale === 1 ? viewport.width : window.innerWidth);
    document.documentElement.style.setProperty("--mobile-viewport-height", height + "px");
    document.documentElement.classList.toggle("mobile-short", width <= 1000 && width > height && height <= 340);
  }
  fitViewport();
  window.addEventListener("resize", fitViewport, { passive: true });
  window.visualViewport?.addEventListener("resize", fitViewport, { passive: true });
  if (/MicroMessenger/i.test(navigator.userAgent || ""))
    document.querySelectorAll("[data-browser-hint]").forEach(node => node.classList.remove("hidden"));

  // 手机上中途转回竖屏时，通过现有菜单暂停并保存，横回来后手动继续。
  const portrait = window.matchMedia?.("(max-width: 600px) and (orientation: portrait)");
  portrait?.addEventListener("change", () => {
    const home = document.getElementById("homeOverlay");
    const modal = document.querySelector(".overlay:not(.hidden)");
    if (portrait.matches && home.classList.contains("hidden") && !modal)
      document.getElementById("btnPause").click();
  });
  const fullscreen = document.getElementById("btnFullscreen");
  if (document.documentElement.requestFullscreen && !installed()) {
    fullscreen.classList.remove("hidden");
    fullscreen.addEventListener("click", async () => {
      try {
        await document.documentElement.requestFullscreen();
        await screen.orientation?.lock?.("landscape");
      } catch (_) { /* iPhone 等设备通过添加到桌面及手动旋转进入横屏 */ }
    });
  }

  function status(text, state) {
    statuses.forEach(node => { node.textContent = text; node.dataset.state = state; });
  }
  function refresh() {
    if (waiting) status("新版已下载，关闭所有游戏窗口后重新打开即可更新", "ready");
    else if (ready) status(navigator.onLine === false
      ? "当前已离线 · 可以正常对局和保存进度" : "离线已就绪 · 断网也能玩", "ready");
    else if (navigator.onLine === false) status("尚未完成离线准备，请联网后重试", "error");
    else status("正在准备离线资源…", "pending");
  }
  function requestStatus() {
    const worker = navigator.serviceWorker.controller || registration?.active;
    if (worker) worker.postMessage({ type: "OFFLINE_STATUS" });
  }
  window.addEventListener("beforeinstallprompt", event => {
    event.preventDefault();
    installPrompt = event;
    if (!installed()) button.classList.remove("hidden");
  });
  window.addEventListener("appinstalled", () => {
    installPrompt = null;
    button.classList.add("hidden");
  });
  button.addEventListener("click", async () => {
    if (!installPrompt) return;
    const prompt = installPrompt;
    installPrompt = null;
    button.classList.add("hidden");
    try { await prompt.prompt(); await prompt.userChoice; } catch (_) { /* 仍可从浏览器菜单安装 */ }
  });

  if (location.protocol === "file:") {
    status("本地文件版 · 无需联网即可游玩", "ready");
    return;
  }
  if (!window.isSecureContext || !("serviceWorker" in navigator)) {
    status("离线安装需要支持此功能的浏览器和 HTTPS 地址", "error");
    return;
  }
  navigator.serviceWorker.addEventListener("message", event => {
    if (event.data?.type !== "OFFLINE_STATUS") return;
    ready = event.data.ready === true;
    refresh();
    if (!ready && navigator.onLine !== false)
      status("离线资源不完整，请联网关闭游戏后重新打开", "error");
  });
  navigator.serviceWorker.addEventListener("controllerchange", requestStatus);
  window.addEventListener("online", () => { refresh(); requestStatus(); });
  window.addEventListener("offline", refresh);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) { requestStatus(); registration?.update().catch(() => {}); }
  });

  navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" }).then(reg => {
    registration = reg;
    const inspect = () => {
      waiting = !!reg.waiting;
      refresh();
      requestStatus();
    };
    const watch = worker => {
      if (!worker) return;
      worker.addEventListener("statechange", () => {
        if (worker.state === "redundant" && !ready)
          status("离线准备失败，请检查网络后重新打开", "error");
        else inspect();
      });
    };
    watch(reg.installing);
    reg.addEventListener("updatefound", () => watch(reg.installing));
    inspect();
    navigator.serviceWorker.ready.then(requestStatus);
  }).catch(() => status("离线准备失败，请联网重新打开；本次仍可正常游玩", "error"));
})();
