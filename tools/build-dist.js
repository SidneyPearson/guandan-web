#!/usr/bin/env node
/* ============================================================
 * 本地发布打包脚本
 * 产物：
 *   dist/单机掼蛋/          电脑版 + mobile/ 手机离线版的完整发布目录
 *   dist/guandan-v<ver>.zip 同时包含两版的完整压缩包
 * 用户解压后双击「启动.bat」即可用默认浏览器离线游玩。
 * 用法：node tools/build-dist.js [版本号，默认取 js/version.js 的 GD.VERSION]
 * ============================================================ */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
// Keep the file:// worker synchronized with the exact same AI and rule sources.
fs.writeFileSync(path.join(ROOT,"js/ai-worker-source.js"),require("./build-ai-worker.cjs")());

// 版本单一来源：js/version.js 的 GD.VERSION；命令行参数仅作显式覆盖
const versionSrc = fs.readFileSync(path.join(ROOT, "js", "version.js"), "utf8");
const sourceVer = (versionSrc.match(/GD\.VERSION\s*=\s*["']([^"']+)["']/) || [])[1];
const VER = process.argv[2] || sourceVer;
if (!VER) {
  console.error("无法从 js/version.js 读取版本号");
  process.exit(1);
}
const DIST = path.join(ROOT, "dist");
const COPY_OPTIONS = { recursive: true, filter: source => path.basename(source) !== ".DS_Store" };
const APP = path.join(DIST, "单机掼蛋");
// 压缩包名用交付名（1.3.0 → v1.3）；版本号本身仍以 GD.VERSION 单一来源
const zipVer = VER.replace(/\.0$/, "");
const ZIP = `guandan-v${zipVer}.zip`;
const MANIFEST = `manifest-v${zipVer}.json`;

function rmrf(p) { fs.rmSync(p, { recursive: true, force: true }); }

/* ---------- 准备目录 ---------- */
rmrf(APP);
fs.mkdirSync(APP, { recursive: true });

/* ---------- 复制运行所需文件 ---------- */
fs.copyFileSync(path.join(ROOT, "index.html"), path.join(APP, "index.html"));
fs.cpSync(path.join(ROOT, "css"), path.join(APP, "css"), COPY_OPTIONS);
fs.cpSync(path.join(ROOT, "js"), path.join(APP, "js"), COPY_OPTIONS);
fs.cpSync(path.join(ROOT, "audio"), path.join(APP, "audio"), COPY_OPTIONS);
fs.cpSync(path.join(ROOT, "mobile"), path.join(APP, "mobile"), COPY_OPTIONS);
fs.copyFileSync(path.join(ROOT, "sw.js"), path.join(APP, "sw.js"));
fs.copyFileSync(path.join(ROOT, "README.md"), path.join(APP, "README.md"));
fs.cpSync(path.join(ROOT,"docs"),path.join(APP,"docs"),COPY_OPTIONS);
// 联机服务随完整发布包交付；node_modules 由首次启动时的 npm ci 安装。
fs.cpSync(path.join(ROOT, "server"), path.join(APP, "server"), COPY_OPTIONS);
fs.cpSync(path.join(ROOT, "deploy"), path.join(APP, "deploy"), COPY_OPTIONS);
fs.mkdirSync(path.join(APP, "tools"), { recursive: true });
fs.copyFileSync(path.join(ROOT, "tools/start-online.cjs"), path.join(APP, "tools/start-online.cjs"));
for (const file of ["package.json", "package-lock.json", "Dockerfile", "compose.yaml", "render.yaml", ".node-version", ".dockerignore", ".env.example", "局域网联机.command", "局域网联机.bat"])
  fs.copyFileSync(path.join(ROOT, file), path.join(APP, file));
fs.chmodSync(path.join(APP, "局域网联机.command"), 0o755);

/* ---------- Windows：启动.bat ----------
 * 用 UTF-8 保存并 chcp 65001，保证中文提示不乱码
 */
const bat = [
  "@echo off",
  "chcp 65001 >nul",
  "cd /d \"%~dp0\"",
  "echo 正在启动【单机掼蛋】...",
  "start \"\" \"index.html\"",
  "exit",
  "",
].join("\r\n");
fs.writeFileSync(path.join(APP, "启动.bat"), "﻿" + bat, "utf8");

/* ---------- macOS：启动.command（附带，方便在 Mac 上玩） ---------- */
const commandSh = [
  "#!/bin/sh",
  "cd \"$(dirname \"$0\")\"",
  "open index.html",
  "",
].join("\n");
fs.writeFileSync(path.join(APP, "启动.command"), commandSh);
fs.chmodSync(path.join(APP, "启动.command"), 0o755);

/* ---------- 快速开始.txt（UTF-8 BOM，记事本可正确识别） ---------- */
const txt = [
  "单机掼蛋 · 电脑版 + 手机离线版 · 快速开始",
  "",
  "1. 双击「启动.bat」，系统会用默认浏览器打开游戏（无需联网、无需安装）。",
  "2. 如果浏览器询问，选择 Chrome / Edge 等现代浏览器。",
  "3. 也可以直接双击 index.html 打开。",
  "",
  "说明：",
  "- 单机进度保存在本机浏览器；联机进度由房间服务保存，刷新当前房间页可尝试恢复原座位。",
  "- 游戏规则见 README.md 或游戏内「规则」按钮。",
  "- 适用 Windows 10/11；macOS 可双击「启动.command」。",
  "- 手机：将整个发布目录部署为 HTTPS 站点，用 Safari / Chrome 打开 mobile/，等待「离线已就绪」，再添加到主屏幕。",
  "- 手机横屏游玩，安装步骤见游戏首页「安装到手机 / 离线说明」。",
  "- index.html 是电脑版；mobile/index.html 是独立手机入口，两版均在此完整压缩包中。",
  "- 同一 Wi-Fi 联机：先安装 Node.js 22+，双击「局域网联机.bat」（Windows）或「局域网联机.command」（Mac）。首次安装依赖需联网。",
  "- 公网联机：按 docs/online-play.md 部署随包提供的服务；单纯打开静态网页不会创建公网房间。",
  "",
].join("\r\n");
fs.writeFileSync(path.join(APP, "快速开始.txt"), "﻿" + txt, "utf8");

/* ---------- 打包 zip（必须带 UTF-8 文件名标志） ----------
 * Mac 自带 zip 不写 UTF-8 标志，Windows 资源管理器会按 GBK 解读而乱码；
 * Python zipfile 对非 ASCII 名称自动设置 bit 11（EFS），Win10/11 正常解压
 */
rmrf(path.join(DIST, ZIP));
const py = [
  "import sys, os, zipfile",
  "zip_path, app_dir, top = sys.argv[1], sys.argv[2], sys.argv[3]",
  "with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as z:",
  "    for root, dirs, files in os.walk(app_dir):",
  "        for f in sorted(files):",
  "            full = os.path.join(root, f)",
  "            arc = os.path.join(top, os.path.relpath(full, app_dir))",
  "            z.write(full, arc)",
].join("\n");
execFileSync("python3", ["-I", "-c", py, path.join(DIST, ZIP), APP, "单机掼蛋"],
  { stdio: "inherit" });

/* ---------- 哈希清单：源 / dist / zip 三方对应 ---------- */
function sha256(p) {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}
function relFiles(dir, base) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (name === ".DS_Store") continue;
    const p = path.join(dir, name);
    const rel = base ? base + "/" + name : name;
    if (fs.statSync(p).isDirectory()) out.push(...relFiles(p, rel));
    else out.push(rel);
  }
  return out;
}
const SOURCE_ROOTS = ["index.html", "README.md", "docs", "css", "js", "audio", "mobile", "sw.js", "server", "deploy",
  "package.json", "package-lock.json", "Dockerfile", "compose.yaml", "render.yaml", ".node-version", ".dockerignore", ".env.example", "局域网联机.command", "局域网联机.bat", "tools/start-online.cjs"];
function sourceHashes() {
  const map = {};
  for (const root of SOURCE_ROOTS) {
    const full = path.join(ROOT, root);
    if (fs.statSync(full).isDirectory()) {
      for (const rel of relFiles(full, root)) map[rel] = sha256(path.join(ROOT, rel));
    } else {
      map[root] = sha256(full);
    }
  }
  return map;
}
const distHashes = Object.fromEntries(
  relFiles(APP, "单机掼蛋").map((rel) => [rel, sha256(path.join(DIST, rel))]));
const srcHashes = sourceHashes();
const copiedMatch = Object.entries(srcHashes)
  .every(([rel, h]) => distHashes["单机掼蛋/" + rel] === h);
const manifest = {
  version: VER,
  builtAt: new Date().toISOString(),
  copiedMatch,
  zip: { name: ZIP, sha256: sha256(path.join(DIST, ZIP)),
         bytes: fs.statSync(path.join(DIST, ZIP)).size },
  source: srcHashes,
  dist: distHashes,
};
if (!copiedMatch) {
  console.error("源/dist 哈希不一致，终止");
  process.exit(2);
}
fs.writeFileSync(path.join(DIST, MANIFEST), JSON.stringify(manifest, null, 2) + "\n");

/* ---------- 输出信息 ---------- */
function listFiles(dir, base) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const rel = base ? base + "/" + name : name;
    if (fs.statSync(p).isDirectory()) out.push(...listFiles(p, rel));
    else out.push(rel);
  }
  return out;
}
const sizeMB = (fs.statSync(path.join(DIST, ZIP)).size / 1024 / 1024).toFixed(2);
console.log("发布目录：" + APP);
console.log("压缩包：  " + path.join(DIST, ZIP) + `（${sizeMB} MB）`);
console.log("清单：    " + path.join(DIST, MANIFEST));
console.log("zip sha256: " + manifest.zip.sha256);
console.log("文件清单：");
for (const f of listFiles(APP)) console.log("  " + f);
