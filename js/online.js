/* Same-Wi-Fi and public lobbies share a protocol, with independent room/session
 * namespaces. Offline play never depends on a successful server connection. */
(function () {
  'use strict';
  const GD = window.GD, $ = id => document.getElementById(id);
  const LABEL = { lan: '同一 Wi-Fi', public: '公网联机' };
  const PREFS = 'gd-online-preferences-v1', SESSIONS = 'gd-online-sessions-v1';
  let hooks, socket = null, mode = 'lan', server = '', current = null, session = null;
  let cancelConnection = null;
  let busy = false, connecting = false, connected = false, config = null, appliedRevision = -1, generation = 0;
  const read = key => { try { return JSON.parse(localStorage.getItem(key)) || {}; } catch { return {}; } };
  const write = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; } };
  const sessionKey = () => mode + ':' + server;
  const id = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
  function status(text, error = false) {
    $('onlineStatus').textContent = text;
    $('onlineStatus').classList.toggle('is-error', error);
  }
  function normalizeServer(value) {
    let url;
    try { url = new URL(value.trim()); } catch { throw new Error('请输入完整的服务地址，例如 http://192.168.1.8:8897'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('服务地址需要使用 http:// 或 https://');
    if (location.protocol === 'https:' && url.protocol === 'http:') throw new Error('当前页面使用 HTTPS，请直接打开局域网电脑提供的 HTTP 链接，或连接 HTTPS 服务');
    if (mode === 'public' && url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      throw new Error('公网服务请使用 HTTPS 地址；本机测试可以使用 localhost');
    return url.origin;
  }
  async function detectConfig() {
    if (config) return config;
    if (!/^https?:$/.test(location.protocol)) return null;
    try {
      const response = await fetch('/api/online/config', { signal: AbortSignal.timeout(2000) });
      if (response.ok) config = await response.json();
    } catch { /* A static/offline frontend can connect to a separately hosted service. */ }
    return config;
  }
  function updateResume() {
    const prefs = read(PREFS), saved = read(SESSIONS);
    let origin;
    try { origin = new URL($('onlineServer').value).origin; } catch {}
    $('btnOnlineResume').classList.toggle('hidden', !saved[mode + ':' + origin]);
    if (!$('onlineNickname').value) $('onlineNickname').value = prefs.nickname || '';
  }
  function rememberSession(received) {
    session = received;
    const sessions = read(SESSIONS); sessions[sessionKey()] = session;
    if (!write(SESSIONS, sessions)) status('浏览器无法保存重连凭据，请保持当前页面打开', true);
    try {
      const url = new URL(location.href);
      url.searchParams.set('online', mode); url.searchParams.set('room', session.code);
      if (server !== location.origin) url.searchParams.set('server', server); else url.searchParams.delete('server');
      history.replaceState(null, '', url);
    } catch { /* file:// can still use the explicit resume button. */ }
  }
  async function open(nextMode) {
    if (current && nextMode !== mode) { hooks.toast('请先退出当前房间，再切换在线模式'); return; }
    mode = nextMode;
    $('onlineOverlay').classList.remove('hidden');
    $('onlineTitle').textContent = LABEL[mode];
    $('onlineDescription').textContent = mode === 'lan'
      ? '连接同一 Wi-Fi 下的电脑，输入房间号一起玩。'
      : '连接公网服务，与不同网络下的朋友一起玩。';
    $('onlineSetupHint').textContent = mode === 'lan'
      ? '建房前，在一台电脑双击「局域网联机.command」，把显示的 Wi-Fi 地址发给朋友。'
      : '填写已上线联机服务的 HTTPS 地址；从联机网站打开时会自动选择本站服务。';
    document.querySelectorAll('[data-online-mode]').forEach(b => {
      b.classList.toggle('is-selected', b.dataset.onlineMode === mode); b.disabled = !!current && b.dataset.onlineMode !== mode;
    });
    if (!current) {
      const prefs = read(PREFS), info = await detectConfig();
      const query = new URLSearchParams(location.search);
      const queryServer = query.get('online') === mode ? query.get('server') : '';
      $('onlineServer').value = queryServer || prefs[mode + 'Server'] ||
        (info?.modes?.includes(mode) ? (mode === 'public' && info.publicUrl ? info.publicUrl : location.origin) : '');
      $('onlineServer').placeholder = mode === 'lan' ? 'http://192.168.1.8:8897' : 'https://你的联机服务域名';
      if (query.get('online') === mode) $('onlineRoomCode').value = query.get('room') || '';
      status('填写昵称与服务地址，然后创建或加入房间。');
    }
    renderLobby(); updateResume();
    (current ? $('btnOnlineBack') : $('onlineNickname')).focus();
  }
  function apply(snapshot) {
    if (!snapshot || snapshot.protocol !== GD.onlineView.PROTOCOL || snapshot.version !== GD.VERSION) {
      status('游戏版本不一致，请关闭旧页面后重新打开', true); return;
    }
    if (snapshot.room.mode !== mode || (current && snapshot.room.code !== current.room.code)) return;
    if (snapshot.room.revision < appliedRevision) return;
    const firstGame = !!snapshot.game && !current?.game;
    if (!current) $('onlineInviteLink').classList.add('hidden');
    const fresh = snapshot.room.revision > appliedRevision;
    current = snapshot; appliedRevision = snapshot.room.revision;
    if (snapshot.game && fresh) hooks.receive(snapshot);
    if (firstGame) $('onlineOverlay').classList.add('hidden');
    renderLobby(); renderHud();
    if (snapshot.room.persistenceError) status('当前服务无法保存进度，请联系房主；本桌仍可继续', true);
  }
  function renderHud() {
    const hud = $('onlineHud');
    hud.classList.toggle('hidden', !current?.game);
    const changed = document.body.classList.contains('online-game') !== !!current?.game;
    document.body.classList.toggle('online-game', !!current?.game);
    if (changed) window.dispatchEvent(new Event('gd:online-mode'));
    if (!current?.game) return;
    hud.textContent = `${LABEL[mode]} · ${current.room.code} · ${connected ? '房间' : '重连中'}`;
    hud.classList.toggle('is-offline', !connected);
    hud.title = connected ? '查看房间、复制邀请或退出' : '正在恢复连接，暂时不能提交操作';
    updateNextButtons(); hooks.refresh();
  }
  function updateNextButtons() {
    if (!current?.game) return;
    const room = current.room, mine = room.seats[room.ownSeat];
    const waiting = room.seats.filter(p => p.id && p.connected && !p.autoPilot && !p.nextReady).length;
    const text = mine.nextReady ? `已准备 · 等待 ${waiting} 人` : '准备下一局';
    for (const name of ['btnSettleNext', 'btnPracticeAgain', 'btnMatchRestart']) {
      const button = $(name); if (!button) continue;
      button.textContent = text; button.disabled = mine.nextReady || busy || !connected;
    }
    if (current.game.mode === 'practice') $('btnPracticeAgain').classList.add('hidden');
  }
  function renderLobby() {
    if (!hooks) return;
    const room = current?.room, mine = room?.seats[room.ownSeat], host = mine?.isHost;
    $('onlineConnectForm').classList.toggle('hidden', !!room);
    $('onlineRoom').classList.toggle('hidden', !room);
    $('onlineTabs').classList.toggle('hidden', !!room);
    $('onlineDescription').classList.toggle('hidden', !!room);
    $('btnOnlineBack').textContent = current?.game ? '回牌桌' : '返回首页';
    document.querySelectorAll('[data-online-request]').forEach(button => { button.disabled = busy || connecting; });
    if (!room) return;
    $('onlineCode').textContent = room.code;
    $('onlineRoomMode').textContent = LABEL[room.mode];
    const seats = $('onlineSeats'); seats.replaceChildren();
    const directions = ['南', '东', '北', '西'];
    room.seats.forEach(p => {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'online-seat seat-position-' + p.seat;
      button.dataset.seat = p.seat;
      button.classList.toggle('is-mine', p.seat === room.ownSeat);
      button.classList.toggle('is-ready', p.ready);
      const removable = host && p.id && !p.connected && !room.started;
      button.disabled = (!removable && !!p.id) || !!room.started || busy;
      const title = document.createElement('strong');
      title.textContent = `${directions[p.seat]} · ${p.nickname}${p.seat === room.ownSeat ? '（你）' : ''}`;
      button.title = title.textContent;
      const detail = document.createElement('span');
      detail.textContent = p.id ? `${p.isHost ? '房主 · ' : ''}${!p.connected ? (removable ? '已掉线 · 点击移除' : '已掉线') : room.started ? (p.autoPilot ? '托管中' : '对局中') : p.ready ? '已准备' : '未准备'}` :
        room.started ? '自动出牌' : '点击入座 · 开局时电脑补位';
      button.append(title, detail); button.onclick = () => request(removable ? 'room:remove' : 'room:seat', { seat: p.seat }); seats.append(button);
    });
    $('onlineOptions').classList.toggle('hidden', room.started);
    for (const [name, value] of [['onlineGameMode', room.options.gameMode], ['onlineDifficulty', room.options.difficulty], ['onlineTurnSeconds', String(room.options.turnSeconds)]]) {
      $(name).value = value; $(name).disabled = !host || busy;
    }
    $('onlinePartnerView').checked = room.options.partnerView;
    $('onlinePartnerView').disabled = !host || busy;
    $('btnOnlineReady').classList.toggle('hidden', room.started);
    $('btnOnlineReady').textContent = mine.ready ? '取消准备' : '我准备好了';
    $('btnOnlineReady').disabled = busy || !connected;
    $('btnOnlineStart').classList.toggle('hidden', !host || room.started);
    $('btnOnlineStart').disabled = busy || !connected || !room.seats.filter(p => p.id).every(p => p.ready && p.connected);
    $('btnOnlineTable').classList.toggle('hidden', !room.started);
    $('onlineRoomHint').textContent = room.started
      ? '牌局正在进行。打开房间或设置不会暂停其他玩家；退出后该座位由电脑补位。'
      : '南北一队、东西一队；点击空位换座。真人全部准备后由房主开局，空位由电脑补齐。';
    if (room.storage === 'ephemeral') $('onlineRoomHint').textContent += ' 当前服务重启后需要重新开桌，刷新页面仍可恢复座位。';
  }
  async function request(kind, data = {}) {
    if (busy) return null;
    if (!socket?.connected) { status('尚未连接服务，请检查地址或等待重连', true); hooks.toast('连接尚未恢复'); return null; }
    const message = { protocol: GD.onlineView.PROTOCOL, version: GD.VERSION, requestId: id(), kind,
      matchId: current?.game?.matchId, handId: current?.game?.handId,
      expectedRevision: current?.room?.revision, ...data };
    const requestSocket = socket, ticket = generation;
    busy = true; renderLobby(); renderHud();
    try {
      let response;
      try { response = await requestSocket.timeout(6000).emitWithAck('request', message); }
      catch (error) {
        // Only repeat game commands with the SAME id. The server persists their
        // result, so a lost acknowledgement cannot produce a second move.
        if (!kind.startsWith('game:') || !requestSocket.connected || ticket !== generation) throw error;
        response = await requestSocket.timeout(6000).emitWithAck('request', message);
      }
      if (ticket !== generation) return null;
      if (response.session) rememberSession(response.session);
      if (response.snapshot) apply(response.snapshot);
      if (!response.ok) { status(response.reason, true); hooks.toast(response.reason); }
      else if (current) status(current.game ? '已同步当前牌桌' : '已加入房间，邀请朋友后准备开局。');
      return response;
    } catch {
      status('服务没有响应，请检查网络；已提交的操作会在同步后确认', true);
      hooks.toast('连接中断或服务没有响应'); return null;
    } finally { if (ticket === generation) { busy = false; renderLobby(); renderHud(); } }
  }
  async function connect(origin, resume = null) {
    cancelConnection?.();
    const ticket = ++generation;
    socket?.removeAllListeners(); socket?.disconnect();
    server = origin; session = resume; current = null; appliedRevision = -1; connected = false;
    status('正在连接…');
    socket = window.io(server, { reconnection: true, reconnectionDelay: 700, reconnectionDelayMax: 5000,
      timeout: 6000, forceNew: true, transports: ['websocket', 'polling'] });
    const thisSocket = socket;
    thisSocket.on('session', received => { if (ticket === generation) rememberSession(received); });
    thisSocket.on('view', snapshot => { if (ticket === generation) apply(snapshot); });
    thisSocket.on('session:replaced', () => {
      connected = false; session = null; thisSocket.disconnect(); renderHud();
      status('该座位已在另一个页面打开，请关闭重复页面', true); hooks.toast('座位已由另一个页面接管');
    });
    thisSocket.on('disconnect', () => {
      if (ticket !== generation) return;
      connected = false; hooks.connection(false); renderHud(); renderLobby();
      status('连接已断开，正在重连，座位会为你保留…', true);
    });
    thisSocket.on('connect', async () => {
      if (ticket !== generation) return;
      connected = !session;
      if (session) {
        while (busy && ticket === generation) await new Promise(resolve => setTimeout(resolve, 50));
        if (ticket !== generation || !thisSocket.connected) return;
        const response = await request('session:resume', session);
        if (response && !response.ok) {
          const sessions = read(SESSIONS); delete sessions[sessionKey()]; write(SESSIONS, sessions);
          session = null; current = null; hooks.leave(); renderLobby();
        }
        connected = !!response?.ok;
      }
      hooks.connection(true); renderHud();
    });
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = error => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        cancelConnection = null;
        thisSocket.off('connect_error', initialError);
        thisSocket.off('disconnect', cancelled);
        error ? reject(error) : resolve();
      };
      const initialError = () => {
        if (ticket !== generation) { finish(new Error('已取消连接')); return; }
        status(mode === 'public' ? '正在等待公网服务启动，首次连接可能需要约一分钟；可以返回取消。' : '正在重试连接，请确认电脑上的局域网服务已启动。');
      };
      const cancelled = reason => { if (reason === 'io client disconnect') finish(new Error('已取消连接')); };
      const timer = setTimeout(() => {
        finish(new Error('无法连接服务。请确认服务已启动，并检查网络与地址。'));
        thisSocket.disconnect();
      }, mode === 'public' ? 90000 : 10000);
      cancelConnection = () => finish(new Error('已取消连接'));
      thisSocket.once('connect', () => finish());
      thisSocket.on('connect_error', initialError);
      thisSocket.on('disconnect', cancelled);
    });
  }
  async function enter(kind) {
    if (busy || connecting) return;
    connecting = true; renderLobby();
    try {
      const origin = normalizeServer($('onlineServer').value), name = $('onlineNickname').value.trim();
      if (!name) { status('先输入你的昵称', true); $('onlineNickname').focus(); return; }
      const code = $('onlineRoomCode').value.trim();
      if (kind === 'room:join' && !/^\d{6}$/.test(code)) throw new Error('请输入六位房间号');
      const prefs = read(PREFS); prefs.nickname = name; prefs[mode + 'Server'] = origin; write(PREFS, prefs);
      const resume = kind === 'session:resume' ? read(SESSIONS)[mode + ':' + origin] : null;
      if (kind === 'session:resume' && !resume) throw new Error('没有找到可恢复的房间');
      await connect(origin, resume);
      if (!resume) await request(kind, { mode, code, nickname: name,
        options: { difficulty: document.querySelector('input[name="homeDiff"]:checked')?.value || 'normal' } });
    } catch (error) { if (error.message !== '已取消连接') status(error.message, true); }
    finally { connecting = false; renderLobby(); renderHud(); }
  }
  async function leave() {
    if (current && socket?.connected) {
      const result = await request('room:leave');
      if (!result?.ok) return;
    }
    const sessions = read(SESSIONS); delete sessions[sessionKey()]; write(SESSIONS, sessions);
    generation++; cancelConnection?.(); socket?.removeAllListeners(); socket?.disconnect(); socket = null;
    session = null; current = null; connected = false; busy = false; connecting = false; appliedRevision = -1;
    try {
      const url = new URL(location.href);
      for (const key of ['online', 'room', 'server']) url.searchParams.delete(key);
      history.replaceState(null, '', url);
    } catch {}
    $('onlineOverlay').classList.add('hidden'); hooks.leave(); renderHud();
  }
  function inviteURL() {
    if (!current) return '';
    let origin = server;
    if (mode === 'lan' && ['localhost', '127.0.0.1'].includes(new URL(origin).hostname) && config?.lanUrls?.length) origin = config.lanUrls[0];
    const url = new URL('/join', origin); // The service routes phone invitations to /mobile/.
    url.searchParams.set('online', mode); url.searchParams.set('room', current.room.code);
    return url.href;
  }
  async function copyInvite() {
    const link = inviteURL();
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(link);
      else {
        const field = $('onlineInviteLink'); field.value = link; field.classList.remove('hidden'); field.select();
        if (!document.execCommand('copy')) throw new Error('copy');
      }
      status('邀请链接已复制，发给朋友即可。');
    } catch {
      const field = $('onlineInviteLink'); field.value = link; field.classList.remove('hidden'); field.select();
      status('长按或选中下方邀请链接复制。');
    }
  }
  function mount(callbacks) {
    hooks = callbacks;
    const overlay = document.createElement('div'); overlay.id = 'onlineOverlay'; overlay.className = 'overlay online-overlay hidden';
    overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'true'); overlay.setAttribute('aria-labelledby', 'onlineTitle');
    overlay.innerHTML = `<div class="panel online-panel">
      <header class="online-heading"><div><p class="online-eyebrow">好友牌桌</p><h2 id="onlineTitle">同一 Wi-Fi</h2></div><button class="btn btn-ghost" id="btnOnlineBack">返回首页</button></header>
      <nav id="onlineTabs" class="online-tabs" aria-label="在线模式"><button class="btn" data-online-mode="lan">同一 Wi-Fi</button><button class="btn" data-online-mode="public">公网联机</button></nav>
      <p id="onlineDescription" class="online-description"></p>
      <div id="onlineConnectForm" class="online-connect-form">
        <label>你的昵称<input id="onlineNickname" maxlength="20" autocomplete="nickname" placeholder="朋友怎么称呼你" /></label>
        <label>服务地址<input id="onlineServer" type="url" inputmode="url" spellcheck="false" autocomplete="url" /></label>
        <p id="onlineSetupHint" class="online-help"></p>
        <button class="btn btn-primary" id="btnOnlineCreate" data-online-request>创建房间</button>
        <div class="online-join-row"><label>房间号<input id="onlineRoomCode" inputmode="numeric" maxlength="6" pattern="[0-9]{6}" placeholder="六位数字" /></label><button class="btn" id="btnOnlineJoin" data-online-request>加入房间</button></div>
        <button class="btn hidden" id="btnOnlineResume" data-online-request>恢复上次房间</button>
      </div>
      <section id="onlineRoom" class="hidden" aria-label="好友房间">
        <div class="online-code-row"><div><span id="onlineRoomMode"></span><strong id="onlineCode"></strong></div><button class="btn" id="btnOnlineInvite">复制邀请链接</button></div>
        <input id="onlineInviteLink" class="online-invite-link hidden" readonly aria-label="邀请链接" />
        <div id="onlineSeats" class="online-seats" aria-label="选择座位"></div>
        <fieldset id="onlineOptions" class="online-options"><legend>房间规则 · 房主设置</legend>
          <label>玩法<select id="onlineGameMode"><option value="match">完整升级对局</option><option value="practice">快速一局</option></select></label>
          <label>电脑难度<select id="onlineDifficulty"><option value="easy">简单</option><option value="normal">普通</option><option value="hard">困难</option></select></label>
          <label>每回合<select id="onlineTurnSeconds"><option value="15">15 秒</option><option value="30">30 秒</option><option value="60">60 秒</option><option value="90">90 秒</option></select></label>
          <label class="online-checkbox"><input type="checkbox" id="onlinePartnerView" checked />出完后可看对家手牌</label>
        </fieldset>
        <p id="onlineRoomHint" class="online-help"></p>
        <div class="online-actions"><button class="btn btn-primary" id="btnOnlineReady">我准备好了</button><button class="btn" id="btnOnlineStart">开始对局</button><button class="btn" id="btnOnlineTable">回牌桌</button><button class="btn btn-ghost" id="btnOnlineLeave">退出房间</button></div>
      </section>
      <p id="onlineStatus" role="status" aria-live="polite"></p>
    </div>`;
    $('app').append(overlay);
    const hud = document.createElement('button'); hud.id = 'onlineHud'; hud.type = 'button'; hud.className = 'btn online-hud hidden';
    document.querySelector('.toolbar-right').prepend(hud);
    $('btnOnlineLan').onclick = () => open('lan'); $('btnOnlinePublic').onclick = () => open('public');
    document.querySelectorAll('[data-online-mode]').forEach(b => { b.onclick = () => open(b.dataset.onlineMode); });
    $('btnOnlineCreate').onclick = () => enter('room:create'); $('btnOnlineJoin').onclick = () => enter('room:join');
    $('btnOnlineResume').onclick = () => enter('session:resume'); $('onlineServer').oninput = updateResume;
    $('onlineRoomCode').addEventListener('keydown', event => { if (event.key === 'Enter') enter('room:join'); });
    $('btnOnlineReady').onclick = () => request('room:ready'); $('btnOnlineStart').onclick = () => request('room:start');
    $('btnOnlineInvite').onclick = copyInvite; $('btnOnlineLeave').onclick = leave;
    $('btnOnlineBack').onclick = () => current?.game ? $('onlineOverlay').classList.add('hidden') : leave();
    $('btnOnlineTable').onclick = () => $('onlineOverlay').classList.add('hidden'); hud.onclick = () => open(mode);
    for (const name of ['onlineGameMode', 'onlineDifficulty', 'onlineTurnSeconds', 'onlinePartnerView']) $(name).onchange = () => request('room:options', {
      options: { gameMode: $('onlineGameMode').value, difficulty: $('onlineDifficulty').value,
        turnSeconds: Number($('onlineTurnSeconds').value), partnerView: $('onlinePartnerView').checked } });
    overlay.addEventListener('keydown', event => {
      if (event.key === 'Escape' && current?.game) { event.preventDefault(); event.stopPropagation(); overlay.classList.add('hidden'); }
      if (event.key === 'Tab') {
        const focusable = [...overlay.querySelectorAll('button, input, select')].filter(el => !el.disabled && el.getClientRects().length);
        const first = focusable[0], last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first) { last.focus(); event.preventDefault(); }
        else if (!event.shiftKey && document.activeElement === last) { first.focus(); event.preventDefault(); }
      }
    });
    const query = new URLSearchParams(location.search);
    if (LABEL[query.get('online')]) open(query.get('online')).then(() => {
      let origin;
      try { origin = new URL($('onlineServer').value).origin; } catch {}
      const previous = read(SESSIONS)[mode + ':' + origin];
      if (previous && previous.code === query.get('room')) enter('session:resume');
    });
    else updateResume();
  }
  GD.online = { mount, open, leave, request, updateNextButtons,
    action: (kind, data) => request('game:' + kind, data),
    get busy() { return busy || connecting; }, get connected() { return connected; }, get inGame() { return !!current?.game; },
    get dialogOpen() { return !!$('onlineOverlay') && !$('onlineOverlay').classList.contains('hidden'); },
    get room() { return current?.room || null; }, get snapshot() { return current; } };
})();
