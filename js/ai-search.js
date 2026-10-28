/* Time-bounded Monte Carlo policy improvement, using shared independent worlds.
 * Rollout actors receive only their own sampled hand and public counts/trick.
 * Exhaustive physical action generation happens in ai.js before prescreening.
 */
(function () {
  const GD = (window.GD = window.GD || {}), rules = GD.rules;
  const bomb = p => rules.isBombType(p);
  const key = cards => cards.map(c => c.id).sort((a,b) => a-b).join(",");

  function rankCost(hand, level) {
    const counts = new Array(18).fill(0); let wilds = 0;
    for (const c of hand) if (GD.isWild(c,level)) wilds++; else counts[c.rank]++;
    let cost = 0, turns = 0, pairs = 0, triples = 0, singles = 0;
    for (let r = 2; r <= 17; r++) {
      let n = counts[r]; if (!n) continue;
      if (n >= 4 && r <= 14) { cost += .65; turns++; continue; }
      if (n === 3) { triples++; cost += .85; turns++; }
      if (n === 2) { pairs++; cost += 1; turns++; }
      if (n === 1) {
        if (wilds && r <= 14) { wilds--; pairs++; cost += 1; turns++; }
        else { singles++; cost += GD.cardWeight({rank:r},level) >= 14 ? 1.05 : 1.9; turns++; }
      }
    }
    const fullhouses = Math.min(pairs,triples);
    cost -= fullhouses * .8; turns -= fullhouses;
    if (wilds) { cost += 1.3; turns++; }
    return { cost, turns, singles };
  }

  function features(hand, level, cache) {
    const k = key(hand);
    if (cache.has(k)) return cache.get(k);
    const plays = rules.enumerateRepresentative(hand,level);
    let best = rankCost(hand,level);
    for (const p of plays) {
      if (!["straight","sflush","dpairs","steel","jokers"].includes(p.type)) continue;
      const ids = new Set(p.cards.map(c => c.id));
      const tail = rankCost(hand.filter(c => !ids.has(c.id)),level);
      const cost = tail.cost + (bomb(p) ? .65 : .9);
      if (cost < best.cost) best = { cost, turns:tail.turns+1, singles:tail.singles };
    }
    const value = { ...best, plays };
    cache.set(k,value);
    return value;
  }

  function view(state, seat) {
    return { seat, hand:state.hands[seat], level:state.currentLevel,
      counts:state.hands.map(h => h.length), partner:seat^2, opponents:[seat^1,seat^3],
      target:state.trick.target, targetSeat:state.trick.targetSeat,
      floorSeat:state.trick.floorSeat, pending:state.trick.pending, finished:state.finished,
      seenIds:state.aiPublicSeen, log:state.log };
  }

  function policy(obs, cache) {
    const f = features(obs.hand,obs.level,cache);
    let plays = f.plays.filter(p => !obs.target || rules.beats(p,obs.target));
    if (!plays.length) return null;
    const finish = plays.find(p => p.cards.length === obs.hand.length);
    if (finish) return finish.cards;
    const actions=plays.map(play=>({action:'play',play}));
    if(obs.target)actions.push({action:'pass',play:null});
    const guarded=GD.ai.guardActions(obs,actions);
    plays=guarded.filter(c=>c.action==='play').map(c=>c.play);
    const mayPass=guarded.some(c=>c.action==='pass');
    const partnerLead = obs.target && obs.targetSeat === obs.partner;
    const danger = Math.min(...obs.opponents.map(s => obs.counts[s] || 99));
    const controller = obs.counts[obs.targetSeat] ? obs.targetSeat : obs.floorSeat;
    const stop = obs.target && obs.opponents.includes(controller) && obs.counts[controller] <= 3;
    const future = obs.pending.slice(obs.pending.indexOf(obs.seat)+1);
    const feedRisk = obs.target && future.some(s => obs.opponents.includes(s) && obs.counts[s] === obs.target.size && obs.counts[s] <= 2);
    let best = null, bestScore = obs.target && mayPass ? f.cost + (partnerLead ? -1.5 : .5) : Infinity;
    if (stop || feedRisk) bestScore += 9;
    for (const p of plays) {
      const ids = new Set(p.cards.map(c => c.id));
      const tail = obs.hand.filter(c => !ids.has(c.id));
      // Cheap policy for rollouts; each action is still verified by simulation.act.
      const after = rankCost(tail,obs.level);
      let score = after.cost + (bomb(p) ? (after.turns <= 1 ? .3 : 4) : p.value * .035);
      if (p.cards.some(c => GD.isWild(c,obs.level))) score += .6;
      const rankCounts = new Array(18).fill(0);
      for (const c of obs.hand) rankCounts[c.rank]++;
      if (!bomb(p)) for (const c of p.cards) if (rankCounts[c.rank] >= 4 && tail.some(x => x.rank === c.rank)) score += .9;
      if (partnerLead) score += 1.2;
      if (stop || feedRisk) score -= 2;
      if (!obs.target && obs.counts[obs.partner] === p.size && p.size <= 2 && p.value < 12) score -= 1.5;
      if (!obs.target && danger === 1 && p.type === "single") score += (17-p.value) * .24;
      if (score < bestScore) { bestScore=score; best=p; }
    }
    return best ? best.cards : null;
  }

  function value(state, team, cache) {
    if (state.phase === "handEnd") {
      const r = state.handResult;
      return (r.winTeam === team ? 1 : -1) * (4 + r.delta);
    }
    if (state.finished.length >= 2 && state.finished[0]%2 === state.finished[1]%2) {
      return state.finished[0]%2 === team ? 7 : -7;
    }
    let own = [], enemy = [];
    for (let s=0;s<4;s++) {
      if (state.finished.includes(s)) continue;
      const f = features(state.hands[s],state.currentLevel,cache);
      (s%2 === team ? own : enemy).push(f.turns + f.cost*.15);
    }
    const first = state.finished.length ? (state.finished[0]%2 === team ? 4 : -4) : 0;
    const mine = Math.min(...own,12), theirs = Math.min(...enemy,12);
    const control = state.trick.floorSeat%2 === team ? .35 : -.35;
    return first + Math.tanh((theirs-mine)*.4)*1.8 +
      (enemy.reduce((a,b)=>a+b,0)-own.reduce((a,b)=>a+b,0))*.12 + control;
  }

  function rollout(obs,hands,candidate,opts,cache) {
    const state = GD.simulation.create(obs,hands);
    state.aiPublicSeen=new Set(obs.seenIds||[]);
    let result = GD.simulation.act(state,obs.seat,candidate.action === "pass" ? null : candidate.play.cards);
    if (!result.ok) throw new Error("invalid-simulation-root");
    let plies=0;
    while (state.phase === "play" && plies < opts.maxPlies) {
      if (opts.budget.now() >= opts.budget.deadline) return null;
      const seat = state.awaiting.seat;
      const cards = policy(view(state,seat),cache);
      result = GD.simulation.act(state,seat,cards);
      if (!result.ok) throw new Error("invalid-rollout-action");
      plies++;
    }
    opts.metrics.rolloutPlies += plies;
    if (state.phase === "handEnd") opts.metrics.terminalRollouts++;
    return value(state,obs.team,cache);
  }

  function select(obs,candidates,opts) {
    const m=opts.metrics;
    Object.assign(m,{ samples:0,rollouts:0,rolloutPlies:0,terminalRollouts:0,searchCandidates:0,searchFallback:null });
    const model=GD.aiMemory.build(obs);
    m.memory={ valid:model.valid, unseen:model.pool.length, unseenWilds:model.unseenWilds, evidence:model.evidence.length };
    const stage=opts.phase, base=candidates[0];
    const enemyN=Math.min(...obs.opponents.map(s=>obs.counts[s]||99));
    // Public-card control and phase-aware cooperation adjust the existing structure prior.
    for (const c of candidates) {
      c.ruleScore=c.score;
      if (c.action === "pass" || c.tag === "goout" || c.facts.criticalControl) continue;
      const p=c.play;
      if (!obs.target && !bomb(p) && obs.counts[obs.partner] > 0 && obs.counts[obs.partner] <= 2 &&
          p.size === obs.counts[obs.partner] && p.value < 12 && enemyN > 2) {
        c.score -= stage === "endgame" ? 1.8 : 1;
        c.facts.feedPartner=true;
      }
      if (stage === "opening" && bomb(p)) c.score += .8;
      if (model.valid && p.type === "single" && model.pool.every(x => GD.cardWeight(x,obs.level) <= p.value)) {
        c.facts.publicTop=true;
        if (stage === "endgame") c.score -= .6;
      }
    }
    candidates.sort((a,b)=>a.score-b.score);
    const prior=candidates[0];
    // A safe short partner already owns the trick. Sparse rollout noise must
    // not steal their lead merely to improve our own hand's progress.
    if (obs.targetSeat === obs.partner && obs.counts[obs.partner] <= 2 && enemyN > 2 && prior.action === "pass") {
      m.searchFallback="protect-partner-control";return prior;
    }
    if (!model.valid || !GD.simulation || !opts.samples) { m.searchFallback=model.reason || "rule-only"; return prior; }
    const pool=[], signatures=new Set();
    const add=c=>{
      if (!c || (base.facts.criticalControl && c.action === "pass")) return;
      const k=c.action === "pass" ? "pass" : c.play.type+"|"+c.play.value+"|"+c.play.cards.map(x=>x.rank+x.suit).sort().join(",");
      if (!signatures.has(k)) { signatures.add(k); pool.push(c); }
    };
    add(prior);
    add(candidates.find(c=>c.action === "pass"));
    add(candidates.find(c=>c.action === "play" && bomb(c.play)));
    for (const c of candidates) { if (pool.length >= (opts.maxCandidates || 5)) break; add(c); }
    if (pool.length < 2) return prior;
    m.searchCandidates=pool.length;
    const seed = opts.seed == null ? ((obs.stratSeed||1)^Math.imul(obs.gen+1,7919)^Math.imul(obs.seat+1,104729))>>>0 : opts.seed>>>0;
    const rng=GD.mulberry32(seed), cache=new Map(), sums=new Array(pool.length).fill(0), squares=sums.slice();
    const searchOpts={...opts,maxPlies:opts.maxPlies || (stage === "endgame" ? 48 : 16)};
    try {
      for(let n=0;n<opts.samples;n++) {
        if(opts.budget.now() >= opts.budget.deadline) { m.timedOut=true; m.timeoutStage="simulation"; break; }
        const hands=GD.aiMemory.sample(obs,rng,model);
        if (!hands) { m.searchFallback="sampling-inconsistent"; break; }
        const values=[];
        for (const c of pool) {
          const v=rollout(obs,hands,c,searchOpts,cache);
          if (v === null) break;
          values.push(v);
        }
        // Partial rounds are discarded, so early candidates get no budget advantage.
        if(values.length !== pool.length) { m.timedOut=true; m.timeoutStage="simulation"; break; }
        values.forEach((v,i)=>{sums[i]+=v;squares[i]+=v*v;});
        m.samples++;m.rollouts+=pool.length;
        if(cache.size>2500)cache.clear();
      }
    } catch(e) { m.searchFallback=e.message; }
    if (!m.samples) { m.searchFallback=m.searchFallback||"insufficient-budget"; return prior; }
    let pick=prior,best=Infinity;
    pool.forEach((c,i)=>{
      const mean=sums[i]/m.samples;
      c.simulation={ samples:m.samples,mean,variance:Math.max(0,squares[i]/m.samples-mean*mean) };
      // Conservative policy improvement: the structure prior anchors sparse rollouts.
      const score=(c.score-prior.score)*.65 - mean*.8;
      c.searchScore=score;
      if(score<best){best=score;pick=c;}
    });
    m.expectedTeamUtility=pick.simulation?.mean;
    m.searchChanged=pick!==prior;
    return pick;
  }

  GD.aiSearch={select,features,policy};
})();
