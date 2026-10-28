/* One configurable asynchronous decision service for all four seats. */
(function () {
  const GD=(window.GD=window.GD||{}), ai=GD.ai;
  const defaults={
    easy:{budgetMs:35,samples:0,maxCandidates:4},
    normal:{budgetMs:80,samples:4,maxCandidates:4},
    hard:{budgetMs:140,samples:8,maxCandidates:5},
  };
  let config={},serial=0;
  const script=typeof document!=="undefined" ? document.currentScript?.src : null;
  const workerURL=script ? new URL("ai-worker.js"+new URL(script).search,script).href : null;
  ai.configure=function(options){config={...config,...options};return {...config};};
  ai.getConfig=function(tier){return {...defaults[tier||"normal"],...config};};

  function validate(obs,result) {
    if (!result || typeof result !== "object") return null;
    if(result.action==="pass") return obs.target ? {...result,cards:null,play:null} : null;
    if(result.action!=="play" || !Array.isArray(result.cards) || !result.cards.length) return null;
    if(result.cards.some(c=>!c || !Number.isInteger(c.id))) return null;
    const owned=new Map(obs.hand.map(c=>[c.id,c]));
    const cards=result.cards.map(c=>owned.get(c.id));
    if(cards.some(c=>!c)||new Set(cards.map(c=>c.id)).size!==cards.length)return null;
    const legal=GD.rules.resolveSubmission(cards,obs.target,obs.level);
    return legal.ok ? {...result,cards,play:legal.play} : null;
  }

  ai.recommendAsync=function(obs,options){
    const tier=options?.tier||"normal",opts={...ai.getConfig(tier),...options,tier};
    const clock=()=>typeof performance!=="undefined"?performance.now():Date.now(),start=clock();
    const fallback=reason=>{
      const r=ai.recommend(obs,{...opts,search:false,budgetMs:12});
      r.metrics={...r.metrics,fallback:true,worker:false,workerFallback:reason,timeMs:clock()-start};
      return r;
    };
    const localFile=typeof location!=="undefined"&&location.protocol==="file:";
    if(opts.worker===false||typeof Worker==="undefined"||!workerURL||
        (localFile&&(!GD.AI_WORKER_SOURCE||typeof Blob==="undefined"||!URL.createObjectURL)))return Promise.resolve(fallback("worker-unavailable"));
    return new Promise(resolve=>{
      let worker,done=false,backup=null,timer,objectURL=null;
      const finish=(result,reason)=>{
        if(done)return;done=true;clearTimeout(timer);worker?.terminate();
        if(objectURL)URL.revokeObjectURL(objectURL);
        opts.signal?.removeEventListener("abort",abort);
        const valid=validate(obs,result);
        const r=valid||fallback(reason||"invalid-worker-action");
        r.metrics={...r.metrics,fallback:!!reason||!!r.metrics?.fallback,worker:!!valid,workerFallback:reason||r.metrics?.workerFallback||null,
          timedOut:reason==="worker-timeout"||!!r.metrics?.timedOut,timeMs:clock()-start};
        resolve(r);
      };
      const abort=()=>finish(backup,"cancelled");
      if(opts.signal?.aborted){finish(null,"cancelled");return;}
      opts.signal?.addEventListener("abort",abort,{once:true});
      try{
        if(localFile)objectURL=URL.createObjectURL(new Blob([GD.AI_WORKER_SOURCE],{type:"text/javascript"}));
        worker=new Worker(objectURL||workerURL);
        const id=++serial;
        worker.onmessage=event=>{
          const data=event.data;
          if(!data||data.id!==id)return;
          if(data.kind==="fallback"){backup=validate(obs,data.result);return;}
          finish(data.kind==="result"?data.result:backup,data.kind==="error"?"worker-error":null);
        };
        worker.onerror=event=>{event.preventDefault?.();finish(backup,"worker-error");};
        timer=setTimeout(()=>finish(backup,"worker-timeout"),opts.budgetMs+100);
        // Explicit serializable options; never send state, sealed proxies or functions.
        worker.postMessage({id,obs:GD.observe.serialize(obs),options:{tier,budgetMs:opts.budgetMs,
          samples:opts.samples,maxCandidates:opts.maxCandidates,maxPlies:opts.maxPlies,seed:opts.seed}});
      }catch(e){finish(backup,"worker-unavailable");}
    });
  };
  ai.decideAsync=async function(state,seat,options){
    const tier=options?.tier||state.difficulty||"normal";
    const r=await ai.recommendAsync(GD.observe.build(state,seat),{...options,tier});
    return r.action==="pass"?{pass:true,text:r.text,reason:r.reason,metrics:r.metrics}
      :{cards:r.cards,play:r.play,text:r.text,reason:r.reason,metrics:r.metrics};
  };
  ai.validateDecision=validate;
})();
