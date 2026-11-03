/* Viewing a finished player's partner is a UI choice; AI observations stay sealed. */
'use strict';
const assert=require('node:assert/strict'),path=require('node:path');
global.window=global;
global.localStorage={getItem:()=>null,setItem(){},removeItem(){}};
for(const f of ['util','cards','rules','flow','ai','sound','stats','game','table-view'])require(path.join(__dirname,'../js',f+'.js'));
const GD=global.GD;
let passed=0;
function check(name,fn){fn();passed++;console.log('PASS '+name);}
for(const mode of ['match','practice']){
  const pool=GD.buildDeck(),take=ranks=>ranks.map(rank=>pool.splice(pool.findIndex(c=>c.rank===rank),1)[0]);
  const s=mode==='practice'?GD.game.newPractice('normal',{leader:0}):GD.game.newMatch('normal',{leader:0});
  s.hands=[[3],[4,8],[5],[7,9]].map(take);s.pile=pool;GD.game.beginHandPlay(s,0);
  check(mode+': partner hidden while own hand remains',()=>assert.equal(GD.tableView.handSeat(s),0));
  assert(GD.game.act(s,0,s.hands[0].slice()).ok);
  check(mode+': own legal finish reveals only partner',()=>{
    assert(GD.game.validateState(s));assert.equal(GD.tableView.handSeat(s),2);
    const before=JSON.stringify(s);GD.tableView.handSeat(s);assert.equal(JSON.stringify(s),before);
  });
  check(mode+': AI cannot read partner or enemy cards during spectator view',()=>{
    for(const seat of [1,2,3]){
      const obs=GD.observe.build(s,seat);
      for(const other of [0,1,2,3].filter(n=>n!==seat))assert.throws(()=>obs.hands[other][0]);
      assert.deepEqual(obs.hand,s.hands[seat]);
    }
  });
  check(mode+': pause and save restoration preserve view choice',()=>{
    const copy=JSON.parse(JSON.stringify(s));copy.paused=true;
    assert(GD.game.validateState(copy));assert.equal(GD.tableView.handSeat(copy),2);
  });
  assert(GD.game.act(s,1,[s.hands[1][0]]).ok);assert(GD.game.act(s,2,s.hands[2].slice()).ok);
  check(mode+': partner finishing never exposes enemies',()=>{
    assert(GD.game.validateState(s));assert.equal(GD.tableView.handSeat(s),0);
  });
  check(mode+': next deal returns to own cards',()=>{
    const next=mode==='practice'?GD.game.newPractice('normal'):GD.game.newMatch('normal');
    assert.equal(GD.tableView.handSeat(next),0);
  });
}
check('zero own cards without a recorded finish does not reveal partner',()=>{
  const s=GD.game.newMatch('normal');s.hands[0]=[];assert.equal(GD.tableView.handSeat(s),0);
});
check('settlement and tribute do not show partner cards',()=>{
  const s=GD.game.newMatch('normal');s.hands[0]=[];s.finished=[0];
  for(const phase of ['handEnd','tribute','matchEnd']){s.phase=phase;assert.equal(GD.tableView.handSeat(s),0);}
});
console.log(passed+' spectator checks passed.');
