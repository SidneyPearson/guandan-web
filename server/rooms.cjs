'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const GD = require('./runtime.cjs');
const views = require('../js/online-view.js');
const AiPool = require('./ai-pool.cjs');

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const fail = message => { throw new Error(message); };
const clone = value => JSON.parse(JSON.stringify(value));
function nickname(value) {
  const name = typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f<>&"']/g, '').trim().slice(0, 20) : '';
  return name || '牌友';
}
function options(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('房间设置格式不正确');
  return { gameMode: value.gameMode === 'practice' ? 'practice' : 'match',
    difficulty: ['easy', 'normal', 'hard'].includes(value.difficulty) ? value.difficulty : 'normal',
    turnSeconds: [15, 30, 60, 90].includes(Number(value.turnSeconds)) ? Number(value.turnSeconds) : 30,
    partnerView: value.partnerView !== false };
}

class Rooms {
  constructor(config = {}) {
    this.modes = config.modes || ['lan', 'public'];
    this.roomStorage = config.roomStorage || 'persistent';
    this.dataDir = config.dataDir || path.join(__dirname, '../.online-data');
    this.maxRooms = config.maxRooms || 100;
    this.turnMs = config.turnMs;
    this.aiDelayMs = config.aiDelayMs ?? 900;
    this.disconnectGraceMs = config.disconnectGraceMs ?? 15000;
    this.rooms = new Map(); this.sockets = new Map(); this.bindings = new Map();
    this.ai = new AiPool(config.aiWorkers || 2);
    this.closed = false;
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    this.restore();
    this.cleanup = setInterval(() => this.expire(), 60000);
    this.cleanup.unref();
  }
  key(mode, code) {
    if (!this.modes.includes(mode)) fail('该服务未开启此在线模式，请检查服务器地址');
    if (typeof code !== 'string' || !/^\d{6}$/.test(code)) fail('请输入六位房间号');
    return mode + '-' + code;
  }
  addSocket(socket) { this.sockets.set(socket.id, socket); }
  player(room, id) { return room.seats.find(p => p?.id === id); }
  seat(room, player) { return room.seats.indexOf(player); }
  bound(socket) {
    const binding = this.bindings.get(socket.id), room = binding && this.rooms.get(binding.key);
    const player = room && this.player(room, binding.playerId);
    if (!room || !player || player.socketId !== socket.id) fail('请先加入房间');
    return { room, player, seat: this.seat(room, player) };
  }
  roomView(room, seat) {
    return { code: room.code, mode: room.mode, revision: room.revision,
      ownSeat: seat, hostId: room.hostId, options: { ...room.options }, started: !!room.state,
      storage: this.roomStorage,
      persistenceError: !!room.persistenceError,
      seats: room.seats.map((p, seat) => p ? { seat, id: p.id, nickname: p.nickname,
        connected: !!p.socketId, ready: p.ready, nextReady: p.nextReady,
        autoPilot: p.autoPilot, isHost: p.id === room.hostId, bot: false } :
        { seat, id: null, nickname: room.state ? '电脑' : '空位', bot: !!room.state,
          connected: false, ready: false, nextReady: true, autoPilot: true, isHost: false }) };
  }
  snapshot(room, seat, action = null) {
    return { protocol: views.PROTOCOL, version: GD.VERSION, serverTime: Date.now(),
      room: this.roomView(room, seat), game: views.project(room, seat),
      action: views.projectAction(action, seat) };
  }
  save(room) {
    const persisted = { schema: 1, protocol: views.PROTOCOL, version: GD.VERSION,
      room: { code: room.code, mode: room.mode, hostId: room.hostId,
        options: room.options, state: room.state, revision: room.revision, updatedAt: room.updatedAt,
        seats: room.seats.map(p => p && { id: p.id, tokenHash: p.tokenHash, nickname: p.nickname,
          ready: p.ready, nextReady: p.nextReady, autoPilot: p.autoPilot, autoReason: p.autoReason,
          requests: p.requests }) } };
    const file = path.join(this.dataDir, room.key + '.json'), temp = file + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(persisted), { mode: 0o600 });
    fs.renameSync(temp, file);
  }
  restore() {
    for (const file of fs.readdirSync(this.dataDir).filter(f => /^(lan|public)-\d{6}\.json$/.test(f))) {
      try {
        const saved = JSON.parse(fs.readFileSync(path.join(this.dataDir, file), 'utf8'));
        const r = saved.room;
        if (saved.schema !== 1 || saved.protocol !== views.PROTOCOL || saved.version !== GD.VERSION ||
            !this.modes.includes(r.mode) || Date.now() - r.updatedAt > 24 * 60 * 60 * 1000 ||
            (r.state && !GD.game.validateState(r.state)) || !Array.isArray(r.seats) || r.seats.length !== 4) continue;
        const key = this.key(r.mode, r.code);
        const room = { ...r, key, timer: null, work: 0, deadline: null, turnKey: '', persistenceError: false,
          seats: r.seats.map(p => p && ({ ...p, socketId: null, disconnectedAt: Date.now(), requests: p.requests || [] })) };
        this.rooms.set(key, room);
      } catch { console.warn('跳过无法恢复的房间文件：' + file); }
    }
  }
  commit(room, action = null) {
    room.revision++; room.updatedAt = Date.now();
    this.schedule(room);
    try { this.save(room); room.persistenceError = false; }
    catch (error) { room.persistenceError = true; console.error('房间进度保存失败：' + error.code); }
    for (let seat = 0; seat < 4; seat++) {
      const socket = this.sockets.get(room.seats[seat]?.socketId);
      if (socket) socket.emit('view', this.snapshot(room, seat, action));
    }
  }
  makePlayer(name) {
    const token = crypto.randomBytes(32).toString('base64url');
    return { token, player: { id: crypto.randomUUID(), tokenHash: hash(token), nickname: nickname(name),
      ready: false, nextReady: false, autoPilot: false, autoReason: null, requests: [], socketId: null } };
  }
  attach(socket, room, player) {
    const oldId = player.socketId;
    player.socketId = socket.id;
    if (player.autoReason === 'disconnect') { player.autoPilot = false; player.autoReason = null; }
    this.bindings.set(socket.id, { key: room.key, playerId: player.id });
    if (oldId && oldId !== socket.id) {
      this.bindings.delete(oldId);
      this.sockets.get(oldId)?.emit('session:replaced');
      this.sockets.get(oldId)?.disconnect(true);
    }
  }
  join(socket, message, create) {
    if (this.bindings.has(socket.id)) fail('请先离开当前房间');
    let room;
    if (create) {
      if (this.rooms.size >= this.maxRooms) fail('当前房间已满，请稍后重试');
      if (!this.modes.includes(message.mode)) fail('该服务未开启此在线模式，请检查服务器地址');
      let code;
      do { code = String(crypto.randomInt(100000, 1000000)); } while (this.rooms.has(message.mode + '-' + code));
      room = { key: this.key(message.mode, code), code, mode: message.mode, seats: [null, null, null, null],
        options: options(message.options), state: null, revision: 0, updatedAt: Date.now(),
        timer: null, work: 0, turnKey: '', deadline: null };
      this.rooms.set(room.key, room);
    } else {
      room = this.rooms.get(this.key(message.mode, message.code));
      if (!room) fail('房间不存在或已过期，请核对模式和房间号');
      if (room.state) fail('牌局已经开始，仅原玩家可以重连');
    }
    const seat = room.seats.indexOf(null);
    if (seat < 0) fail('房间已经坐满');
    const { token, player } = this.makePlayer(message.nickname);
    room.seats[seat] = player;
    if (create) room.hostId = player.id;
    this.attach(socket, room, player);
    const session = { mode: room.mode, code: room.code, token, playerId: player.id };
    // Deliver credentials BEFORE a room view. If the acknowledgement is lost
    // after the view arrives, the browser can still authenticate its reconnect.
    socket.emit('session', session);
    this.commit(room);
    return { ok: true, session,
      snapshot: this.snapshot(room, seat) };
  }
  async handle(socket, message) {
    let context;
    try {
      if (!message || typeof message !== 'object' || Array.isArray(message)) fail('请求格式不正确');
      if (message.protocol !== views.PROTOCOL || message.version !== GD.VERSION) fail('游戏版本不一致，请关闭旧页面后重新打开');
      if (message.kind === 'room:create') return this.join(socket, message, true);
      if (message.kind === 'room:join') return this.join(socket, message, false);
      if (message.kind === 'session:resume') {
        if (this.bindings.has(socket.id)) fail('当前连接已在房间中');
        const room = this.rooms.get(this.key(message.mode, message.code));
        const player = room && typeof message.token === 'string' && message.token.length <= 128 &&
          room.seats.find(p => p?.tokenHash === hash(message.token));
        if (!player) fail('座位恢复凭据无效或房间已过期');
        this.attach(socket, room, player); this.commit(room);
        return { ok: true, snapshot: this.snapshot(room, this.seat(room, player)) };
      }
      context = this.bound(socket);
      const { room, player, seat } = context;
      if (message.kind === 'room:sync') return { ok: true, snapshot: this.snapshot(room, seat) };
      if (message.kind === 'room:leave') {
        this.bindings.delete(socket.id); room.seats[seat] = null;
        if (player.id === room.hostId) room.hostId = room.seats.find(Boolean)?.id || null;
        if (!room.hostId) this.remove(room);
        else this.commit(room);
        return { ok: true };
      }
      if (typeof message.requestId !== 'string' || !/^[\w-]{8,80}$/.test(message.requestId)) fail('操作编号不正确');
      const previous = player.requests.find(r => r.id === message.requestId);
      if (previous) return { ...previous.result, snapshot: this.snapshot(room, seat) };
      let action = null;
      const host = () => { if (player.id !== room.hostId) fail('仅房主可以执行此操作'); };
      const lobby = () => { if (room.state) fail('对局开始后不能修改房间设置'); };
      switch (message.kind) {
        case 'room:seat': {
          lobby();
          const target = message.seat;
          if (!Number.isInteger(target) || target < 0 || target > 3 || room.seats[target]) fail('该座位不可用');
          room.seats[target] = player; room.seats[seat] = null; player.ready = false;
          break;
        }
        case 'room:options':
          host(); lobby(); room.options = options(message.options);
          room.seats.filter(Boolean).forEach(p => { p.ready = false; }); break;
        case 'room:remove': {
          host(); lobby();
          const target = message.seat;
          if (!Number.isInteger(target) || target < 0 || target > 3 || !room.seats[target] || room.seats[target].socketId)
            fail('仅可移除尚未开局的掉线玩家');
          room.seats[target] = null;
          break;
        }
        case 'room:ready': lobby(); player.ready = !player.ready; break;
        case 'room:start':
          host(); lobby();
          if (!room.seats.filter(Boolean).every(p => p.ready && p.socketId)) fail('请等待所有真人玩家连接并准备');
          room.state = this.newGame(room); room.seats.filter(Boolean).forEach(p => { p.nextReady = false; }); break;
        case 'game:next': {
          const s = room.state;
          if (!s || !['handEnd', 'matchEnd'].includes(s.phase) || message.matchId !== s.matchId || message.handId !== s.handId)
            fail('当前还不能进入下一局');
          player.nextReady = true;
          if (this.allNext(room)) this.next(room);
          break;
        }
        case 'game:autopilot':
          if (!room.state) fail('对局尚未开始');
          player.autoPilot = !player.autoPilot; player.autoReason = player.autoPilot ? 'manual' : null; break;
        case 'game:play': case 'game:pass': case 'game:give': case 'game:return': {
          const s = room.state;
          if (!s || message.matchId !== s.matchId || message.handId !== s.handId || message.expectedRevision !== room.revision)
            fail('牌桌已更新，请按最新局面操作');
          if (player.autoPilot) fail('请先取消托管');
          action = this.apply(room, seat, message.kind, message.ids);
          break;
        }
        default: fail('不支持的操作');
      }
      const result = { ok: true, revision: room.revision + 1 };
      player.requests.push({ id: message.requestId, result });
      if (player.requests.length > 64) player.requests.shift();
      this.commit(room, action);
      return { ...result, snapshot: this.snapshot(room, this.seat(room, player)) };
    } catch (error) {
      return { ok: false, reason: error.message,
        ...(context ? { snapshot: this.snapshot(context.room, this.seat(context.room, context.player)) } : {}) };
    }
  }
  newGame(room) {
    return room.options.gameMode === 'practice' ? GD.game.newPractice(room.options.difficulty) : GD.game.newMatch(room.options.difficulty);
  }
  allNext(room) { return room.seats.filter(Boolean).every(p => p.nextReady || p.autoPilot || !p.socketId); }
  next(room) {
    if (room.state.phase === 'matchEnd') room.state = this.newGame(room);
    else GD.game.continueAfterHand(room.state);
    room.seats.filter(Boolean).forEach(p => { p.nextReady = false; });
  }
  apply(room, seat, kind, ids) {
    const s = room.state;
    let result;
    if (kind === 'game:play' || kind === 'game:pass') {
      if (s.phase !== 'play' || s.awaiting?.seat !== seat) fail('还没轮到你');
      let cards = null;
      if (kind === 'game:play') {
        if (!Array.isArray(ids) || !ids.length || ids.length > 27 || ids.some(id => !Number.isInteger(id)) ||
            new Set(ids).size !== ids.length) fail('出牌数据不正确');
        cards = ids.map(id => s.hands[seat].find(c => c.id === id));
        if (cards.some(c => !c)) fail('存在不在你手牌中的牌');
      }
      result = GD.game.act(s, seat, cards);
    } else {
      const t = s.tribute, pair = t?.pairs[t.idx];
      if (s.phase !== 'tribute' || t.anti || !pair || !Array.isArray(ids) || ids.length !== 1 || !Number.isInteger(ids[0]))
        fail('当前不是可选牌的进贡环节');
      if (kind === 'game:give') {
        if (t.stage !== 'give' || pair.from !== seat) fail('还没轮到你进贡');
        result = GD.game.giveTribute(s, ids[0]);
      } else {
        if (t.stage !== 'return' || pair.to !== seat) fail('还没轮到你还贡');
        result = GD.game.returnTribute(s, ids[0]);
      }
    }
    if (!result?.ok) fail(result?.reason || '操作失败');
    if (s.phase === 'handEnd') {
      room.seats.filter(Boolean).forEach(p => { p.nextReady = false; });
      if (s.mode === 'practice') GD.game.finishPractice(s);
    }
    return result.kind ? result : null;
  }
  actor(room) {
    const s = room.state;
    if (s?.phase === 'play') return s.awaiting?.seat;
    if (s?.phase === 'tribute' && !s.tribute.anti) {
      const t = s.tribute, pair = t.pairs[t.idx];
      return t.stage === 'give' ? pair?.from : pair?.to;
    }
    return null;
  }
  schedule(room) {
    clearTimeout(room.timer); room.timer = null;
    const ticket = ++room.work, s = room.state;
    if (this.closed || !s || !room.seats.some(p => p?.socketId)) return;
    const key = `${s.matchId}:${s.handId}:${s.phase}:${s.gen}:${s.tribute?.stage}:${s.tribute?.idx}`;
    if (key !== room.turnKey) {
      room.turnKey = key;
      room.deadline = Date.now() + (this.turnMs || room.options.turnSeconds * 1000);
    }
    const doLater = (callback, delay) => {
      room.timer = setTimeout(() => {
        if (!this.closed && this.rooms.has(room.key) && ticket === room.work) callback();
      }, Math.max(0, delay));
      room.timer.unref?.();
    };
    if (s.phase === 'handEnd' && this.allNext(room)) {
      doLater(() => { this.next(room); this.commit(room); }, this.aiDelayMs); return;
    }
    if (s.phase === 'tribute' && s.tribute.anti) {
      doLater(() => { GD.game.finishAnti(s); this.commit(room); }, this.aiDelayMs); return;
    }
    const seat = this.actor(room);
    if (seat == null) { room.deadline = null; return; }
    const p = room.seats[seat];
    const automated = !p || p.autoPilot;
    let delay = automated ? this.aiDelayMs : room.deadline - Date.now();
    if (p && !p.socketId && !p.autoPilot)
      delay = Math.min(delay, (p.disconnectedAt || Date.now()) + this.disconnectGraceMs - Date.now());
    doLater(async () => {
      if (p && !p.autoPilot) {
        p.autoPilot = true; p.autoReason = p.socketId ? 'timeout' : 'disconnect';
      }
      let ids;
      if (s.phase === 'play') {
        ids = await this.ai.decide(GD.observe.serialize(GD.observe.build(s, seat)), s.difficulty);
      } else {
        const t = s.tribute;
        const c = t.stage === 'give' ? GD.game.autoGive(s, seat) : GD.game.autoReturn(s, t.pairs[t.idx]);
        ids = c ? [c.id] : null;
      }
      if (this.closed || ticket !== room.work || this.actor(room) !== seat || (p && !p.autoPilot)) return;
      try {
        if (s.phase === 'play' && (!ids || !ids.length) && s.awaiting.kind === 'lead')
          ids = GD.rules.enumerate(s.hands[seat], s.currentLevel)[0].cards.map(c => c.id);
        let kind = s.phase === 'play' ? (ids?.length ? 'game:play' : 'game:pass') :
          (s.tribute.stage === 'give' ? 'game:give' : 'game:return');
        let action;
        try { action = this.apply(room, seat, kind, ids); }
        catch (error) {
          if (s.phase !== 'play') throw error;
          const safe = s.awaiting.kind === 'follow' ? null : [s.hands[seat][0].id];
          action = this.apply(room, seat, safe ? 'game:play' : 'game:pass', safe);
        }
        this.commit(room, action);
      } catch (error) { console.error('电脑推进失败：' + error.message); this.schedule(room); }
    }, delay);
  }
  disconnect(socketId) {
    const binding = this.bindings.get(socketId), room = binding && this.rooms.get(binding.key);
    const p = room && this.player(room, binding.playerId);
    this.sockets.delete(socketId); this.bindings.delete(socketId);
    if (!p || p.socketId !== socketId) return;
    p.socketId = null; p.disconnectedAt = Date.now();
    if (room.hostId === p.id) room.hostId = room.seats.find(next => next?.socketId)?.id || room.hostId;
    if (!room.state) p.ready = false;
    this.commit(room);
  }
  remove(room) {
    clearTimeout(room.timer); room.work++;
    this.rooms.delete(room.key);
    try { fs.unlinkSync(path.join(this.dataDir, room.key + '.json')); } catch {}
  }
  expire() {
    for (const room of this.rooms.values()) if (!room.seats.some(p => p?.socketId) && Date.now() - room.updatedAt > 24 * 60 * 60 * 1000)
      this.remove(room);
  }
  async close() {
    this.closed = true; clearInterval(this.cleanup);
    for (const room of this.rooms.values()) { clearTimeout(room.timer); room.work++; }
    await this.ai.close();
  }
}
module.exports = { Rooms, options };
