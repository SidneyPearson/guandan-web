/* This worker receives only a serialized public observation, never a live game state. */
self.window=self;
const query=new URL(self.location.href).search;
importScripts(...["util","cards","rules","flow","ai","ai-memory","ai-search","game"].map(name=>name+".js"+query));
self.onmessage=function(event){
  const {id,obs,options}=event.data;
  try{
    const start=performance.now();
    const fallback=GD.ai.recommend(obs,{...options,search:false,budgetMs:Math.min(25,options.budgetMs)});
    self.postMessage({id,kind:"fallback",result:fallback});
    const remaining=Math.max(0,options.budgetMs-(performance.now()-start));
    const result=remaining>0?GD.ai.recommend(obs,{...options,budgetMs:remaining}):fallback;
    result.metrics.workerComputeMs=performance.now()-start;
    self.postMessage({id,kind:"result",result});
  }catch(e){self.postMessage({id,kind:"error",message:String(e.message||e)});}
};
