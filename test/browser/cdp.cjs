/* ====== 零依赖 CDP 驱动（仅 Node 内置模块），供浏览器自动化验收使用 ======
 * 注意：CDP 合成的鼠标/键盘事件不是真机人工操作；人工听感/手感必须另行实测。
 */
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

function httpJson(url, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

async function waitFor(fn, timeout = 15000, step = 100) {
  const t0 = Date.now();
  let err;
  while (Date.now() - t0 < timeout) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) { err = e; }
    await new Promise((r) => setTimeout(r, step));
  }
  throw new Error("等待超时: " + (err ? err.message : ""));
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    this.exceptions = [];
    this.consoleErrors = [];
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(JSON.stringify(m.error)));
        else resolve(m.result);
      } else if (m.method) {
        this.events.push(m);
        if (m.method === "Runtime.exceptionThrown") {
          this.exceptions.push(m.params.exceptionDetails);
        }
        if (m.method === "Runtime.consoleAPICalled" &&
            (m.params.type === "error" || m.params.type === "warning")) {
          this.consoleErrors.push(m.params);
        }
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expr, awaitPromise = false) {
    const r = await this.send("Runtime.evaluate", {
      expression: expr, awaitPromise, returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error("eval 异常: " + (r.exceptionDetails.exception
        ? r.exceptionDetails.exception.description : r.exceptionDetails.text));
    }
    return r.result.value;
  }
  async rect(selector) {
    return this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height,
        cx: r.x + r.width / 2, cy: r.y + r.height / 2,
        visible: !!el.offsetWidth && !el.classList.contains('hidden') };
    })()`);
  }
  async mouse(x, y, type, button = "left") {
    await this.send("Input.dispatchMouseEvent", { type: type + "Pressed", x, y, button, clickCount: 1 });
    await this.send("Input.dispatchMouseEvent", { type: type + "Released", x, y, button, clickCount: 1 });
  }
  async click(selector) {
    const r = await this.rect(selector);
    if (!r) throw new Error("元素不存在: " + selector);
    await this.mouse(r.cx, r.cy, "mouse");
    return r;
  }
  async key(key, code, windowsVirtualKeyCode) {
    const p = { key, code, windowsVirtualKeyCode };
    await this.send("Input.dispatchKeyEvent", Object.assign({ type: "keyDown", text: key === "Enter" ? "\r" : key.length === 1 ? key : undefined }, p));
    await this.send("Input.dispatchKeyEvent", Object.assign({ type: "keyUp" }, p));
  }
  async setMetrics(width, height, deviceScaleFactor = 1, mobile = false) {
    await this.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor, mobile });
  }
  async screenshot(pathName) {
    const r = await this.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(pathName, Buffer.from(r.data, "base64"));
  }
  close() { try { this.ws.close(); } catch (e) {} }
}

async function launch(url, opts = {}) {
  const port = opts.port || (9300 + Math.floor(Math.random() * 600));
  const userDataDir = opts.userDataDir ||
    fs.mkdtempSync(path.join(os.tmpdir(), "gd-cdp-"));
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    ...(opts.autoplay === false ? [] : ["--autoplay-policy=no-user-gesture-required"]),
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    `--window-size=${opts.width || 1366},${opts.height || 768}`,
    "about:blank",
  ];
  const chrome = spawn(CHROME, args, { stdio: "ignore" });
  const base = `http://127.0.0.1:${port}`;
  await waitFor(async () => {
    try { await httpJson(base + "/json/version"); return true; } catch (e) { return false; }
  }, 15000, 100);

  // 新建标签到目标 URL，再取其调试地址
  const created = await httpJson(base + "/json/new?" + encodeURIComponent(url), "PUT");
  const target = await waitFor(async () => {
    const list = await httpJson(base + "/json/list");
    return list.find(t => t.id === created.id && t.type === "page" && t.webSocketDebuggerUrl) || null;
  });

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res);
    ws.addEventListener("error", rej);
  });
  const cdp = new CDP(ws);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");
  if (opts.width) await cdp.setMetrics(opts.width, opts.height);
  await waitFor(() => cdp.eval("document.readyState === 'complete' && (" + JSON.stringify(url === "about:blank") + " || location.href !== 'about:blank')"), 30000);
  await new Promise((r) => setTimeout(r, 200));
  cdp.chrome = chrome;
  cdp.userDataDir = userDataDir;
  cdp.shutdown = () => new Promise((resolve) => {
    try { chrome.kill("SIGTERM"); } catch (e) {}
    setTimeout(resolve, 150);
  });
  return cdp;
}

module.exports = { launch, waitFor, CDP };
