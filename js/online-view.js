/* The server projects only authorized data. The browser then builds a table view
 * compatible with the single-player renderer. No opponent cards cross the wire. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else (root.GD = root.GD || {}).onlineView = factory();
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  const PROTOCOL = 1;
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const relative = (seat, own) => seat == null ? null : (seat - own + 4) % 4;
  function project(room, own) {
    const s = room.state;
    if (!s) return null;
    const seat = n => relative(n, own), team = n => n == null ? null : n ^ (own % 2);
    const rotate = list => [0, 1, 2, 3].map(i => clone(list[(i + own) % 4]));
    const event = e => e ? { ...clone(e), seat: seat(e.seat) } : e;
    const result = r => r ? { ...clone(r), order: r.order.map(seat), winTeam: team(r.winTeam),
      levelsNext: own % 2 ? r.levelsNext.slice().reverse() : r.levelsNext.slice(),
      nextLevelTeam: team(r.nextLevelTeam) } : null;
    const played = new Set((s.log || []).flatMap(e => e.ids || []));
    const canWatchPartner = room.options.partnerView && s.phase === 'play' &&
      s.finished.includes(own) && !s.finished.includes(own ^ 2);
    return {
      matchId: s.matchId, handId: s.handId, phase: s.phase, mode: s.mode,
      difficulty: s.difficulty, currentLevel: s.currentLevel,
      levels: own % 2 ? s.levels.slice().reverse() : s.levels.slice(), levelTeam: team(s.levelTeam),
      hand: clone(s.hands[own]), counts: rotate(s.hands.map(h => h.length)),
      partnerHand: canWatchPartner ? clone(s.hands[own ^ 2]) : null,
      table: rotate(s.table), pile: clone(s.pile.filter(c => played.has(c.id))),
      finished: s.finished.map(seat), awaiting: s.awaiting ? { ...s.awaiting, seat: seat(s.awaiting.seat) } : null,
      trick: s.trick ? { ...clone(s.trick), floorSeat: seat(s.trick.floorSeat),
        targetSeat: seat(s.trick.targetSeat), pending: s.trick.pending.map(seat) } : null,
      log: (s.log || []).map(event),
      lastTrick: s.lastTrick ? { ...clone(s.lastTrick), winner: seat(s.lastTrick.winner),
        outSeat: seat(s.lastTrick.outSeat), entries: rotate(s.lastTrick.entries).map(event),
        actions: s.lastTrick.actions?.map(event) || null } : null,
      tribute: s.tribute ? { ...clone(s.tribute), pairs: s.tribute.pairs.map(p =>
        ({ ...clone(p), from: seat(p.from), to: seat(p.to) })) } : null,
      handResult: result(s.handResult), matchWinner: team(s.matchWinner),
      autoPilot: !!room.seats[own]?.autoPilot,
      deadline: room.deadline, revision: room.revision,
    };
  }
  function hydrate(view, room) {
    const hands = view.counts.map(count => Array.from({ length: count }, () => ({ hidden: true })));
    hands[0] = view.hand;
    if (view.partnerHand) hands[2] = view.partnerHand;
    return { ...view, hands, online: true, paused: false, organize: false,
      gen: view.revision, stratSeed: 1, version: 3,
      roomCode: room.code, onlineMode: room.mode, partnerVisible: !!view.partnerHand };
  }
  function projectAction(action, own) {
    if (!action) return null;
    const out = clone(action), seat = n => relative(n, own);
    out.seat = seat(out.seat);
    if (out.followed) out.followed.seat = seat(out.followed.seat);
    if (out.event) {
      if (out.event.seat != null) out.event.seat = seat(out.event.seat);
      if (out.event.outSeat != null) out.event.outSeat = seat(out.event.outSeat);
    }
    delete out.saved;
    return out;
  }
  return { PROTOCOL, project, hydrate, projectAction };
});
