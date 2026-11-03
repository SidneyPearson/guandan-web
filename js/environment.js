/* Choose a desktop or mobile entry locally before the game loads. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }
  const doc = root.document, script = doc.currentScript;
  const entry = script?.getAttribute('data-entry');
  if (!['desktop', 'mobile'].includes(entry)) return;
  const environment = api.inspect(root);
  const destination = api.redirect(root.location.href, script.src, entry, environment);
  if (destination) { root.location.replace(destination); return; }
  const links = () => doc.querySelectorAll('[data-game-view]').forEach(link => {
    link.href = api.viewURL(root.location.href, script.src, link.getAttribute('data-game-view'));
  });
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', links, { once: true });
  else links();
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  const views = ['desktop', 'mobile'];
  const matches = (surface, query) => !!surface.matchMedia?.(query)?.matches;
  function inspect(surface) {
    const nav = surface.navigator || {}, ua = nav.userAgent || '';
    const touch = Number(nav.maxTouchPoints || 0) > 0;
    const ipadDesktop = /Macintosh|MacIntel/i.test(ua + ' ' + (nav.platform || '')) && Number(nav.maxTouchPoints || 0) > 1;
    const mobileUA = /Android|iPhone|iPad|iPod|Mobile|Tablet|Silk|Kindle/i.test(ua);
    const desktopUA = /Windows NT|Macintosh|MacIntel|X11|CrOS|Linux (?:x86_64|i686)/i.test(ua);
    const screen = surface.screen || {};
    const width = Number(screen.width || surface.innerWidth || 0), height = Number(screen.height || surface.innerHeight || 0);
    const touchScreen = !desktopUA && touch && matches(surface, '(pointer: coarse)') && matches(surface, '(hover: none)') &&
      width > 0 && height > 0 && Math.min(width, height) <= 1024;
    const device = nav.userAgentData?.mobile === true || mobileUA || ipadDesktop || touchScreen ? 'mobile' : 'desktop';
    return { device,
      installed: nav.standalone === true || matches(surface, '(display-mode: standalone)') };
  }
  function viewURL(currentURL, scriptURL, view) {
    if (!views.includes(view)) return null;
    const current = new URL(currentURL), base = new URL('../', scriptURL);
    const target = new URL(view === 'mobile' ? 'mobile/index.html' : 'index.html', base);
    target.search = current.search; target.hash = current.hash;
    target.searchParams.set('view', view);
    return target.href;
  }
  function redirect(currentURL, scriptURL, entry, environment) {
    const current = new URL(currentURL), requested = current.searchParams.get('view');
    // A direct /mobile/ link and an installed app are deliberate entry choices.
    const selected = views.includes(requested) ? requested :
      (environment.installed || entry === 'mobile' ? entry : environment.device);
    if (selected === entry) return null;
    const destination = new URL(viewURL(currentURL, scriptURL, selected));
    // Automatic routing stays automatic on the next visit; only explicit choices are pinned.
    if (!views.includes(requested)) destination.searchParams.delete('view');
    return destination.href;
  }
  return { inspect, viewURL, redirect };
});
