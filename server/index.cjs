'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Server } = require('socket.io');
const { Rooms } = require('./rooms.cjs');
const GD = require('./runtime.cjs');
const { PROTOCOL } = require('../js/online-view.js');
const ROOT = path.resolve(__dirname, '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon' };
function lanAddresses(port) {
  return Object.values(os.networkInterfaces()).flat().filter(n => n && n.family === 'IPv4' && !n.internal)
    .sort((a, b) => (a.address.startsWith('192.168.') ? 0 : a.address.startsWith('10.') ? 1 : 2) -
      (b.address.startsWith('192.168.') ? 0 : b.address.startsWith('10.') ? 1 : 2))
    .map(n => `http://${n.address}:${port}`);
}
function createApp(config = {}) {
  const modes = config.modes || (process.env.ONLINE_MODES || 'lan,public').split(',').filter(m => ['lan', 'public'].includes(m));
  if (!modes.length) throw new Error('ONLINE_MODES 必须包含 lan 或 public');
  const roomStorage = config.roomStorage || process.env.ROOM_STORAGE || 'persistent';
  if (!['ephemeral', 'persistent'].includes(roomStorage)) throw new Error('ROOM_STORAGE 必须是 ephemeral 或 persistent');
  const aiWorkers = config.aiWorkers ?? Number(process.env.AI_WORKERS || 2);
  if (!Number.isInteger(aiWorkers) || aiWorkers < 1 || aiWorkers > 4) throw new Error('AI_WORKERS 必须是 1 到 4 的整数');
  const rooms = new Rooms({ ...config, modes, roomStorage, aiWorkers, dataDir: config.dataDir || process.env.DATA_DIR });
  const publicUrl = config.publicUrl || process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '';
  const allowedOrigins = (config.allowedOrigins || process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const json = (res, status, data) => { res.writeHead(status, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
    catch { res.writeHead(400); res.end(); return; }
    if (pathname === '/healthz') return json(res, 200, { ok: true, version: GD.VERSION, protocol: PROTOCOL, modes, roomStorage, rooms: rooms.rooms.size });
    if (pathname === '/join') {
      const query = new URL(req.url, 'http://localhost').searchParams;
      const mode = query.get('online'), code = query.get('room');
      if (!modes.includes(mode) || !/^\d{6}$/.test(code || '')) { res.writeHead(400); res.end('Invalid room invitation'); return; }
      const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(req.headers['user-agent'] || '');
      res.writeHead(302, { Location: `${mobile ? '/mobile/' : '/'}?online=${mode}&room=${code}`, 'Cache-Control': 'no-store' });
      res.end(); return;
    }
    if (pathname === '/api/online/config') return json(res, 200, { version: GD.VERSION, protocol: PROTOCOL, modes,
      publicUrl, roomStorage,
      lanUrls: modes.includes('lan') ? lanAddresses(server.address()?.port || 8897) : [] });
    if (pathname.endsWith('/')) pathname += 'index.html';
    const allowed = /^\/(?:index\.html|sw\.js|(?:js|css|audio)\/[\w./-]+|mobile\/(?:index\.html|sw\.js|manifest\.webmanifest|(?:js|css|icons)\/[\w./-]+))$/.test(pathname);
    if (!allowed || pathname.includes('..') || pathname.includes('/.')) { res.writeHead(404); res.end(); return; }
    const file = path.resolve(ROOT, '.' + pathname);
    if (!file.startsWith(ROOT + path.sep)) { res.writeHead(404); res.end(); return; }
    fs.stat(file, (error, stat) => {
      if (error || !stat.isFile()) { res.writeHead(404); res.end(); return; }
      const headers = { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff', 'Accept-Ranges': 'bytes',
        'Cache-Control': /\.(html|js|webmanifest)$/.test(file) ? 'no-cache' : 'public, max-age=3600' };
      let start = 0, end = stat.size - 1, status = 200;
      if (req.headers.range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
        if (!match || (!match[1] && !match[2])) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); res.end(); return; }
        if (match[1]) { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
        else start = Math.max(0, stat.size - Number(match[2]));
        if (start > end || start >= stat.size) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); res.end(); return; }
        status = 206; headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
      }
      headers['Content-Length'] = Math.max(0, end - start + 1);
      res.writeHead(status, headers);
      if (req.method === 'HEAD' || stat.size === 0) return res.end();
      const stream = fs.createReadStream(file, { start, end });
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    });
  });
  const io = new Server(server, { serveClient: false, maxHttpBufferSize: 16 * 1024,
    cors: { origin: allowedOrigins.length ? allowedOrigins : true, credentials: false },
    allowRequest: (req, callback) => callback(null, !allowedOrigins.length || !req.headers.origin || allowedOrigins.includes(req.headers.origin)) });
  io.on('connection', socket => {
    rooms.addSocket(socket);
    let count = 0, since = Date.now();
    socket.on('request', async (message, ack) => {
      if (typeof ack !== 'function') return;
      if (Date.now() - since > 60000) { since = Date.now(); count = 0; }
      if (++count > 180) { ack({ ok: false, reason: '操作太频繁，请稍后重试' }); return; }
      ack(await rooms.handle(socket, message));
    });
    socket.on('disconnect', () => rooms.disconnect(socket.id));
  });
  return { server, io, rooms,
    listen: (port = 8897, host = '0.0.0.0') => new Promise((resolve, reject) => {
      server.once('error', reject); server.listen(port, host, () => { server.removeListener('error', reject); resolve(server.address()); });
    }),
    close: async () => { await rooms.close(); await new Promise(resolve => io.close(resolve)); },
  };
}
if (require.main === module) {
  const mode = process.argv.find(arg => arg.startsWith('--mode='))?.split('=')[1];
  if (mode && !['lan', 'public'].includes(mode)) throw new Error('模式只能是 lan 或 public');
  const app = createApp({ modes: mode ? [mode] : undefined });
  const port = Number(process.env.PORT || (mode === 'public' ? 8898 : 8897));
  app.listen(port, process.env.HOST || '0.0.0.0').then(() => {
    console.log(`掼蛋在线服务 v${GD.VERSION} · ${app.rooms.modes.join(' / ')}`);
    console.log(`本机：http://127.0.0.1:${port}/?online=${mode || 'lan'}`);
    if (app.rooms.modes.includes('lan')) for (const url of lanAddresses(port)) console.log(`同一 Wi-Fi：${url}/?online=lan`);
    if (app.rooms.modes.includes('public')) console.log('公网模式：将本服务部署到服务器，设置 HTTPS 域名后分享网页地址。');
  }).catch(error => { console.error(error.message); process.exit(1); });
  const shutdown = async () => { await app.close(); process.exit(0); };
  process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
}
module.exports = { createApp, lanAddresses };
