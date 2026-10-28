/* Public-information card memory and independent, count-conserving determinizations.
 * A pass is evidence of preference, never proof that a player cannot beat a play.
 */
(function () {
  const GD = (window.GD = window.GD || {});
  const deck = GD.buildDeck(), byId = new Map(deck.map(c => [c.id,c]));
  const entries = value => value instanceof Map ? [...value] : Array.isArray(value) ? value : [];

  function build(obs) {
    const mine = new Set(obs.hand.map(c => c.id));
    const seen = new Set(obs.seenIds || []);
    for (const e of obs.log || []) if (e.kind === "play") for (const id of e.ids || []) seen.add(id);
    for (const c of obs.target?.cards || []) seen.add(c.id);
    const pool = deck.filter(c => !mine.has(c.id) && !seen.has(c.id));
    const remaining = new Array(18).fill(0);
    for (const c of pool) remaining[c.rank]++;
    const known = entries(obs.tributeKnown).filter(([id, seat]) => !seen.has(id) && !mine.has(id) && seat !== obs.seat);
    const need = obs.counts.reduce((n,v,s) => n + (s === obs.seat ? 0 : v),0);
    const validKnown = new Set(known.map(([id]) => id)).size === known.length && known.every(([id,s]) =>
      byId.has(id) && Number.isInteger(s) && s >= 0 && s < 4 && obs.counts[s] > 0);
    let target = null, owner = null;
    const evidence = [];
    const log = obs.log || [];
    for (let i = 0; i < log.length; i++) {
      const e = log[i];
      if (e.kind === "play") { target = e.play; owner = e.seat; }
      else if (e.kind === "pass" && target && e.seat !== obs.seat && obs.counts[e.seat] > 0) {
        evidence.push({ seat:e.seat, target, index:i, weight:owner === (e.seat ^ 2) ? .04 : .45 });
      }
    }
    const recent = evidence.slice(-8).map(e => ({ ...e,
      // At the time of the pass this player also held cards they subsequently played.
      later:log.slice(e.index+1).filter(x => x.kind === "play" && x.seat === e.seat)
        .flatMap(x => (x.ids || []).map(id => byId.get(id)).filter(Boolean)) }));
    return { pool, remaining, known, evidence:recent, unseenWilds:pool.filter(c => GD.isWild(c,obs.level)).length,
      valid:pool.length === need && validKnown, reason:pool.length !== need ? "incomplete-public-history" : !validKnown ? "inconsistent-known-cards" : null };
  }

  function uniform(obs, model, rng) {
    const hands = [[],[],[],[]]; hands[obs.seat] = obs.hand.slice();
    const pinned = new Set();
    for (const [id, seat] of model.known) { hands[seat].push(byId.get(id)); pinned.add(id); }
    const pool = model.pool.filter(c => !pinned.has(c.id));
    GD.shuffle(pool, rng);
    let at = 0;
    for (let s = 0; s < 4; s++) if (s !== obs.seat) {
      const n = obs.counts[s] - hands[s].length;
      if (n < 0) return null;
      hands[s].push(...pool.slice(at, at+n)); at += n;
    }
    return at === pool.length ? hands : null;
  }

  function likelihood(hands, model, level) {
    let logWeight = 0;
    for (const e of model.evidence) {
      if (e.weight < .1) continue; // Team protection is almost uninformative.
      const then = hands[e.seat].concat(e.later);
      const couldBeat = GD.rules.enumerateRepresentative(then,level).some(p => GD.rules.beats(p,e.target));
      if (couldBeat) logWeight -= e.weight;
    }
    return Math.exp(logWeight);
  }

  function sample(obs, rng, model, proposals) {
    model = model || build(obs);
    if (!model.valid) return null;
    // Small importance-resampling pool. Every possible deal retains nonzero support.
    let pick = null, total = 0;
    for (let i = 0; i < (proposals || (model.evidence.length ? 3 : 1)); i++) {
      const hands = uniform(obs,model,rng);
      if (!hands) return null;
      const w = likelihood(hands,model,obs.level); total += w;
      if (rng() * total < w) pick = hands;
    }
    return pick;
  }

  GD.aiMemory = { build, sample, likelihood };
})();
