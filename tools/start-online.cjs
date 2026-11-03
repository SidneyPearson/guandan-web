#!/usr/bin/env node
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { lanAddresses } = require('../server/index.cjs');
const ROOT = path.join(__dirname, '..'), port = Number(process.env.PORT || 8897);
const base = `http://127.0.0.1:${port}`;
async function health() {
  try {
    const response = await fetch(base + '/healthz', { signal: AbortSignal.timeout(1000) });
    if (!response.ok) return null;
    const info = await response.json();
    if (!info.ok || !Array.isArray(info.modes)) return null;
    if (!info.modes.includes('lan')) throw new Error('该端口的服务未开启 Wi-Fi 模式，请改用其他 PORT');
    return info;
  } catch (error) { if (error.message.includes('Wi-Fi')) throw error; return null; }
}
(async () => {
  if (!await health()) {
    const dir = path.join(ROOT, '.online-data'); fs.mkdirSync(dir, { recursive: true });
    const logPath = path.join(dir, 'lan-server.log'), fd = fs.openSync(logPath, 'a', 0o600);
    const child = spawn(process.execPath, [path.join(ROOT, 'server/index.cjs'), '--mode=lan'], {
      cwd: ROOT, detached: true, stdio: ['ignore', fd, fd], env: { ...process.env, PORT: String(port) } });
    child.on('error', error => { console.error(error.message); });
    child.unref(); fs.closeSync(fd);
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      if (await health()) { ready = true; break; }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (!ready) throw new Error(`启动失败，请检查端口。日志：${logPath}`);
  }
  console.log('同一 Wi-Fi 联机已就绪。把下面的地址发给同一网络的朋友：');
  for (const url of lanAddresses(port)) console.log(url + '/?online=lan');
  console.log('手机可将地址中的 /?online=lan 换成 /mobile/?online=lan。');
  console.log('服务在后台运行，电脑需保持开机。停止服务可关闭该 Node 进程，或重启电脑。');
  if (!process.argv.includes('--no-open')) spawn('open', [base + '/?online=lan'], { stdio: 'ignore' }).unref();
})().catch(error => { console.error(error.message); process.exitCode = 1; });
