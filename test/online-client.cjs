'use strict';
// Exercise the real client controller without a browser or a network service.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { webcrypto } = require('node:crypto');
const { parseHTML } = require('linkedom');
const ROOT = path.resolve(__dirname, '..');
const PUBLIC = 'https://guandan-online-x50v.onrender.com';

function frontend({ entry = 'mobile/index.html', url = 'https://example.test/guandan/mobile/', config = null, prefs = {} } = {}) {
  const { document, window } = parseHTML(fs.readFileSync(path.join(ROOT, entry), 'utf8'));
  const memory = new Map([['gd-online-preferences-v1', JSON.stringify(prefs)]]);
  const connections = [], requests = [];
  window.HTMLElement.prototype.focus = function () {};
  const context = vm.createContext({ document, URL, URLSearchParams, AbortSignal,
    crypto: webcrypto, location: new URL(url), navigator: {}, setTimeout, clearTimeout,
    history: { replaceState() {} },
    localStorage: { getItem: key => memory.get(key) || null, setItem: (key, value) => memory.set(key, value) },
    fetch: async () => ({ ok: !!config, json: async () => config }),
    io(origin) {
      connections.push(origin);
      const socket = new EventEmitter();
      socket.connected = true;
      socket.timeout = () => socket;
      socket.emitWithAck = async (event, message) => { requests.push({ event, message }); return { ok: true }; };
      socket.disconnect = () => { socket.connected = false; socket.emit('disconnect', 'io client disconnect'); };
      queueMicrotask(() => socket.emit('connect'));
      return socket;
    },
  });
  context.window = context;
  for (const file of ['version.js', 'online-view.js', 'online.js'])
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', file), 'utf8'), context, { filename: file });
  context.GD.online.mount({ toast() {}, refresh() {}, connection() {}, leave() {}, receive() {} });
  const input = id => document.getElementById(id);
  return { online: context.GD.online, input, connections, requests };
}

for (const entry of ['index.html', 'mobile/index.html']) {
  test(`${entry}: static or installed frontend joins the default public service with a room number`, async () => {
    const app = frontend({ entry });
    await app.online.open('public');
    assert.equal(app.input('onlineServer').value, PUBLIC);
    app.input('onlineNickname').value = '已安装用户';
    app.input('onlineRoomCode').value = '123456';
    await app.input('btnOnlineJoin').onclick();
    assert.deepEqual(app.connections, [PUBLIC]);
    assert.equal(app.requests.length, 1);
    assert.equal(app.requests[0].message.kind, 'room:join');
    assert.equal(app.requests[0].message.mode, 'public');
    assert.equal(app.requests[0].message.code, '123456');
    await app.online.leave();
  });
}

test('a separately deployed game uses its own configured public service', async () => {
  const app = frontend({ url: 'https://other-game.test/mobile/',
    config: { modes: ['public'], publicUrl: 'https://other-game.test' } });
  await app.online.open('public');
  assert.equal(app.input('onlineServer').value, 'https://other-game.test');
});

test('explicit invitation and saved service choices remain available', async () => {
  const invited = frontend({ url: 'https://example.test/mobile/?online=public&server=https%3A%2F%2Finvite.test&room=654321',
    prefs: { publicServer: 'https://saved.test' } });
  await invited.online.open('public');
  assert.equal(invited.input('onlineServer').value, 'https://invite.test');
  assert.equal(invited.input('onlineRoomCode').value, '654321');
  const saved = frontend({ prefs: { publicServer: 'https://saved.test' } });
  await saved.online.open('public');
  assert.equal(saved.input('onlineServer').value, 'https://saved.test');
});

test('LAN mode stays separate from the default public service', async () => {
  const staticApp = frontend();
  await staticApp.online.open('lan');
  assert.equal(staticApp.input('onlineServer').value, '');
  const local = frontend({ url: 'http://192.168.1.8:8897/mobile/', config: { modes: ['lan'] } });
  await local.online.open('lan');
  assert.equal(local.input('onlineServer').value, 'http://192.168.1.8:8897');
});
