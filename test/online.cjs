'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { io } = require('socket.io-client');
const { createApp } = require('../server/index.cjs');
const GD = require('../server/runtime.cjs');
const projection = require('../js/online-view.js');
const wait = async (fn, timeout = 8000) => {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (fn()) return; await new Promise(r => setTimeout(r, 20)); }
  throw new Error('等待在线状态超时');
};
async function harness(t, config = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-online-test-'));
  let app = createApp({ dataDir, turnMs: 120000, aiDelayMs: 100000, ...config });
  await app.listen(0, '127.0.0.1');
  const clients = [];
  async function connect() {
    const socket = io(`http://127.0.0.1:${app.server.address().port}`, { transports: ['websocket'], forceNew: true, reconnection: false });
    const client = { socket, view: null, session: null };
    socket.on('session', session => { client.sessionEvent = session; });
    socket.on('view', view => { client.view = view; });
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
    client.send = async data => {
      const response = await socket.timeout(5000).emitWithAck('request', { protocol: projection.PROTOCOL,
        version: GD.VERSION, requestId: crypto.randomUUID(), ...data });
      if (response.snapshot) client.view = response.snapshot;
      if (response.session) client.session = response.session;
      return response;
    };
    client.game = (kind, data = {}) => client.send({ kind, matchId: client.view.game?.matchId,
      handId: client.view.game?.handId, expectedRevision: client.view.room.revision, ...data });
    clients.push(client); return client;
  }
  t.after(async () => { clients.forEach(c => c.socket.disconnect()); await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { connect, get app() { return app; }, dataDir,
    restart: async () => {
      clients.forEach(c => c.socket.disconnect()); await app.close();
      app = createApp({ dataDir, turnMs: 120000, aiDelayMs: 100000, ...config }); await app.listen(0, '127.0.0.1');
    } };
}
async function table(h, mode = 'lan', players = 4, opts = {}) {
  const clients = [];
  const host = await h.connect(); clients.push(host);
  assert.equal((await host.send({ kind: 'room:create', mode, nickname: '房主', options: opts })).ok, true);
  for (let i = 1; i < players; i++) {
    const c = await h.connect(); clients.push(c);
    assert.equal((await c.send({ kind: 'room:join', mode, code: host.session.code, nickname: '玩家' + i })).ok, true);
  }
  for (const c of clients) assert.equal((await c.send({ kind: 'room:ready' })).ok, true);
  assert.equal((await host.send({ kind: 'room:start' })).ok, true);
  await wait(() => clients.every(c => c.view?.game));
  const room = h.app.rooms.rooms.get(mode + '-' + host.session.code);
  return { clients, room };
}

for (const mode of ['lan', 'public']) test(mode + ': 四真人共享牌局、私有手牌、座位视角、请求去重与旧版本拒绝', async t => {
  const h = await harness(t), { clients, room } = await table(h, mode);
  const hands = clients.flatMap(c => c.view.game.hand.map(card => card.id));
  assert.equal(new Set(hands).size, 108);
  for (let seat = 0; seat < 4; seat++) {
    const dto = clients[seat].view.game, view = projection.hydrate(dto, clients[seat].view.room);
    assert.equal(dto.hand.length, 27); assert.equal(dto.hands, undefined); assert.equal(dto.partnerHand, null);
    assert.equal(dto.stratSeed, undefined); assert.equal(view.hands[1][0].hidden, true);
    assert.equal(dto.awaiting.seat, (room.state.awaiting.seat - seat + 4) % 4);
    assert.equal(JSON.stringify(clients[seat].view).includes('tokenHash'), false);
  }
  const active = room.state.awaiting.seat, c = clients[active], wrong = clients[(active + 1) % 4];
  const previous = JSON.stringify(room.state);
  assert.equal((await wrong.game('game:play', { ids: [wrong.view.game.hand[0].id] })).ok, false);
  assert.equal(JSON.stringify(room.state), previous);
  assert.equal((await c.game('game:play', { ids: [wrong.view.game.hand[0].id] })).ok, false);
  const message = { kind: 'game:play', ids: [c.view.game.hand[0].id], requestId: crypto.randomUUID(),
    matchId: room.state.matchId, handId: room.state.handId, expectedRevision: room.revision };
  assert.equal((await c.send(message)).ok, true);
  const revision = room.revision, after = JSON.stringify(room.state);
  assert.equal((await c.send(message)).ok, true);
  assert.equal(room.revision, revision); assert.equal(JSON.stringify(room.state), after);
  const next = clients[room.state.awaiting.seat];
  assert.equal((await next.game('game:pass', { expectedRevision: revision - 1 })).ok, false);
  assert.equal(GD.game.validateState(room.state), true);
  assert.equal((await c.send({ kind: 'room:sync', version: 'old-version' })).ok, false);
});

test('模式隔离、服务模式限制、座位选择与房主权限', async t => {
  const h = await harness(t, { modes: ['lan'] }), host = await h.connect(), other = await h.connect();
  assert.equal((await host.send({ kind: 'room:create', mode: 'public' })).ok, false);
  await host.send({ kind: 'room:create', mode: 'lan', nickname: '甲' });
  assert.equal((await other.send({ kind: 'room:join', mode: 'public', code: host.session.code })).ok, false);
  await other.send({ kind: 'room:join', mode: 'lan', code: host.session.code, nickname: '<script>乙' });
  assert.equal((await other.send({ kind: 'room:start' })).ok, false);
  assert.equal((await other.send({ kind: 'room:options', options: {} })).ok, false);
  assert.equal((await other.send({ kind: 'room:seat', seat: 2 })).ok, true);
  assert.equal(other.view.room.ownSeat, 2);
  assert.equal(other.view.room.seats[2].nickname.includes('<'), false);
  assert.equal((await host.send({ kind: 'room:start' })).ok, false);
  await host.send({ kind: 'room:ready' }); await other.send({ kind: 'room:ready' });
  assert.equal((await host.send({ kind: 'room:start' })).ok, true);
  const outsider = await h.connect();
  assert.equal((await outsider.send({ kind: 'room:join', mode: 'lan', code: host.session.code })).ok, false);
  assert.equal((await outsider.send({ kind: 'session:resume', mode: 'lan', code: host.session.code, token: 'fake' })).ok, false);
});

test('刷新重连、重复连接接管与服务重启后恢复同一手牌', async t => {
  const h = await harness(t), { clients, room } = await table(h);
  const c = clients[2], session = { ...c.session }, hand = c.view.game.hand.map(c => c.id), handId = room.state.handId;
  c.socket.disconnect();
  const resumed = await h.connect();
  assert.equal((await resumed.send({ kind: 'session:resume', ...session })).ok, true);
  assert.equal(resumed.view.room.ownSeat, 2);
  assert.deepEqual(resumed.view.game.hand.map(c => c.id), hand);
  const takeover = await h.connect();
  assert.equal((await takeover.send({ kind: 'session:resume', ...session })).ok, true);
  await wait(() => !resumed.socket.connected);
  await h.restart();
  const restored = await h.connect();
  assert.equal((await restored.send({ kind: 'session:resume', ...session })).ok, true);
  assert.equal(restored.view.game.handId, handId);
  assert.deepEqual(restored.view.game.hand.map(c => c.id), hand);
  assert.equal(restored.view.room.ownSeat, 2);
});

test('房主掉线后交接管理，开局前可移除掉线占位', async t => {
  const h = await harness(t), host = await h.connect(), next = await h.connect();
  await host.send({ kind: 'room:create', mode: 'lan' });
  await next.send({ kind: 'room:join', mode: 'lan', code: host.session.code });
  host.socket.disconnect();
  await wait(() => next.view.room.seats[1].isHost);
  assert.equal((await next.send({ kind: 'room:remove', seat: 0 })).ok, true);
  assert.equal(next.view.room.seats[0].id, null);
  await next.send({ kind: 'room:ready' });
  assert.equal((await next.send({ kind: 'room:start' })).ok, true);
});

test('建房确认丢失时，先行收到的私有重连凭据仍可恢复座位', async t => {
  const h = await harness(t), c = await h.connect();
  c.socket.emit('request', { kind: 'room:create', mode: 'public', nickname: '弱网建房',
    protocol: projection.PROTOCOL, version: GD.VERSION, requestId: crypto.randomUUID() }, () => {});
  await wait(() => c.sessionEvent && c.view);
  assert.equal(c.view.room.code, c.sessionEvent.code);
  assert.equal(JSON.stringify(c.view).includes(c.sessionEvent.token), false);
  c.socket.disconnect();
  const recovered = await h.connect();
  assert.equal((await recovered.send({ kind: 'session:resume', ...c.sessionEvent })).ok, true);
  assert.equal(recovered.view.room.ownSeat, 0);
});

test('结算多人准备、换副、进贡权限与出完看对家的受控手牌', async t => {
  const h = await harness(t), { clients, room } = await table(h);
  let guard = 0;
  while (room.state.phase === 'play' && guard++ < 1000) {
    const s = room.state, seat = s.awaiting.seat;
    const result = GD.game.act(s, seat, s.awaiting.kind === 'lead' ? [s.hands[seat][0]] : null);
    assert.equal(result.ok, true);
    if (s.phase === 'play' && s.finished.length) {
      const done = s.finished[0], partner = done ^ 2;
      const authorized = projection.project(room, done), unauthorized = projection.project(room, partner ^ 1);
      if (!s.finished.includes(partner)) assert.equal(authorized.partnerHand.length, s.hands[partner].length);
      assert.equal(unauthorized.partnerHand, null);
    }
  }
  assert.equal(room.state.phase, 'handEnd');
  const oldHand = room.state.handId;
  h.app.rooms.commit(room);
  await wait(() => clients.every(c => c.view.game.phase === 'handEnd'));
  for (let i = 0; i < 3; i++) { assert.equal((await clients[i].game('game:next')).ok, true); assert.equal(room.state.handId, oldHand); }
  assert.equal((await clients[3].game('game:next')).ok, true);
  assert.notEqual(room.state.handId, oldHand); assert.equal(GD.game.validateState(room.state), true);
  const s = room.state;
  if (s.phase === 'tribute' && !s.tribute.anti) {
    const giver = s.tribute.pairs[s.tribute.idx].from, wrong = (giver + 1) % 4;
    const id = GD.game.tributeOptions(s, giver)[0].id;
    assert.equal((await clients[wrong].game('game:give', { ids: [id] })).ok, false);
    assert.equal((await clients[giver].game('game:give', { ids: [id] })).ok, true);
    assert.equal(GD.game.validateState(s), true);
  }
});

test('电脑补位、服务端托管和超时推进保持牌局合法', async t => {
  const h = await harness(t, { aiDelayMs: 5, turnMs: 50 }), { clients, room } = await table(h, 'public', 1, { difficulty: 'easy' });
  const startGen = room.state.gen;
  await wait(() => room.state.gen >= startGen + 5);
  assert.equal(GD.game.validateState(room.state), true);
  assert.equal(clients[0].view.room.seats.filter(s => s.bot).length, 3);
  assert.equal(room.seats[0].autoPilot, true);
});

test('取消托管后，仍在计算的旧电脑结果不能代打', async t => {
  const h = await harness(t, { aiDelayMs: 5 }), { clients, room } = await table(h);
  GD.game.beginHandPlay(room.state, 0); room.state.gen++; h.app.rooms.commit(room);
  await wait(() => clients[0].view.room.revision === room.revision);
  let finish;
  h.app.rooms.ai.decide = () => new Promise(resolve => { finish = resolve; });
  await clients[0].game('game:autopilot');
  await wait(() => !!finish);
  assert.equal((await clients[0].game('game:autopilot')).ok, true);
  const before = JSON.stringify(room.state);
  finish([room.state.hands[0][0].id]);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(JSON.stringify(room.state), before);
  assert.equal(room.seats[0].autoPilot, false);
});

test('队伍级数和观战权限随本人座位正确映射', async t => {
  const h = await harness(t), { room } = await table(h);
  room.state.levels = [5, 9]; room.state.levelTeam = 1; room.state.currentLevel = 9;
  room.state.finished = [1]; room.options.partnerView = false;
  const privateView = projection.project(room, 1);
  assert.deepEqual(privateView.levels, [9, 5]);
  assert.equal(privateView.levelTeam, 0); assert.equal(privateView.partnerHand, null);
  room.options.partnerView = true;
  const allowed = projection.project(room, 1);
  assert.deepEqual(allowed.partnerHand.map(c => c.id), Array.from(room.state.hands[3], c => c.id));
  assert.equal(projection.project(room, 0).partnerHand, null);
});

test('HTTP 只公开游戏资源，支持手机入口和音频 Range', async t => {
  const h = await harness(t), base = `http://127.0.0.1:${h.app.server.address().port}`;
  for (const url of ['/.git/config', '/server/rooms.cjs', '/.online-data/lan-123456.json', '/package.json', '/js/../../server/index.cjs'])
    assert.equal((await fetch(base + url)).status, 404, url);
  for (const url of ['/', '/mobile/', '/js/online-view.js', '/healthz', '/api/online/config']) assert.equal((await fetch(base + url)).status, 200, url);
  const invite = await fetch(base + '/join?online=lan&room=123456', { redirect: 'manual', headers: { 'User-Agent': 'iPhone Mobile' } });
  assert.equal(invite.status, 302);
  assert.equal(invite.headers.get('location'), '/mobile/?online=lan&room=123456');
  const range = await fetch(base + '/audio/music/table-loop.mp3', { headers: { Range: 'bytes=0-15' } });
  assert.equal(range.status, 206); assert.equal((await range.arrayBuffer()).byteLength, 16);
});

test('Render 公开网址和临时存储能力在客户端可见', async t => {
  const previous = process.env.RENDER_EXTERNAL_URL;
  process.env.RENDER_EXTERNAL_URL = 'https://guandan-test.onrender.com';
  t.after(() => { if (previous === undefined) delete process.env.RENDER_EXTERNAL_URL; else process.env.RENDER_EXTERNAL_URL = previous; });
  const h = await harness(t, { roomStorage: 'ephemeral', aiWorkers: 1 });
  const base = `http://127.0.0.1:${h.app.server.address().port}`;
  const configuration = await (await fetch(base + '/api/online/config')).json();
  assert.equal(configuration.publicUrl, 'https://guandan-test.onrender.com');
  assert.equal(configuration.roomStorage, 'ephemeral');
  const client = await h.connect();
  await client.send({ kind: 'room:create', mode: 'public' });
  assert.equal(client.view.room.storage, 'ephemeral');
  const healthy = await (await fetch(base + '/healthz')).json();
  assert.equal(healthy.roomStorage, 'ephemeral');
});
