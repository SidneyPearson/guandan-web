const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const context = vm.createContext({ console, localStorage: {getItem(){return null;},setItem(){},removeItem(){}} });
context.window = context;
for (const name of ['util','cards','rules','game','table-tools']) {
  vm.runInContext(fs.readFileSync(path.join(root,'js',name+'.js'),'utf8'),context);
}
const GD = context.GD, tools = GD.tableTools, deck = GD.buildDeck();
const { take, referenceCards } = require('./organize-reference.cjs');
let checks = 0;
function check(name, fn) { fn(); checks++; console.log('✓ '+name); }
check('all natural ranks have eight cards and each joker has two', () => {
  const counts=tools.remainingCounts([],[]);
  for(let r=2;r<=14;r++) assert.equal(counts[r],8);
  assert.equal(counts[16],2); assert.equal(counts[17],2);
  assert.equal(Object.values(counts).reduce((a,b)=>a+b,0),108);
});
check('only public own and played cards are deducted, using unique physical ids', () => {
  const own=deck.slice(0,27), played=deck.slice(27,45);
  const counts=tools.remainingCounts(own,played);
  assert.equal(Object.values(counts).reduce((a,b)=>a+b,0),63);
  assert.equal(JSON.stringify(counts),JSON.stringify(tools.remainingCounts(own,played.concat(played))));
});
check('exhausted ordinary ranks and jokers reach zero without going negative', () => {
  const counts=tools.remainingCounts(deck.filter(c=>c.rank===8),deck.filter(c=>c.rank>=16));
  assert.equal(counts[8],0); assert.equal(counts[16],0); assert.equal(counts[17],0);
  assert(Object.values(counts).every(n=>n>=0));
});
check('own card moving to public pile does not change outside counts', () => {
  const own=deck.slice(0,27), card=own[0];
  assert.equal(JSON.stringify(tools.remainingCounts(own,[])),JSON.stringify(tools.remainingCounts(own.slice(1),[card])));
});
check('all players finishing removes every remaining card', () => {
  assert(Object.values(tools.remainingCounts([],deck)).every(n=>n===0));
});
check('display sorts high ranks first without mutating stored hand', () => {
  const hand=deck.slice(0,27), original=JSON.stringify(hand), view=tools.handView(hand,5,false);
  assert.equal(JSON.stringify(hand),original);
  assert.equal(new Set(view.cards.map(c=>c.id)).size,hand.length);
  for(let i=1;i<view.cards.length;i++) assert(GD.cardWeight(view.cards[i-1],5)>=GD.cardWeight(view.cards[i],5));
});
check('organized group ranges preserve the correct physical cards', () => {
  const hand=deck.filter(c=>c.rank===8||c.rank>=16).concat(deck.filter(c=>c.rank===14).slice(0,2));
  const view=tools.handView(hand,2,true);
  assert.equal(new Set(view.cards.map(c=>c.id)).size,hand.length);
  for(const g of view.groups) {
    const cards=view.cards.slice(g.start,g.start+g.len);
    assert.equal(cards.length,g.len);
    assert(cards.every(c=>g.type==='jokers'?c.rank>=16:c.rank===8));
  }
});
check('reference hand produces Q, 9, 7, 6 and 5 bombs with the wild at the front of the 6 column', () => {
  const hand = referenceCards(deck).filter(c => c.rank !== 10);
  const original = JSON.stringify(hand), view = tools.handView(hand,2,true);
  assert.equal(JSON.stringify(view.groups.map(g => g.rank)),JSON.stringify([12,9,7,6,5]));
  assert(view.groups.every(g => g.type === 'bomb' && g.len === 4 && g.label === '四炸'));
  const six = view.groups.find(g => g.rank === 6), cards = view.cards.slice(six.start,six.start+six.len);
  assert(cards.slice(0,3).every(c => c.rank === 6)); assert(GD.isWild(cards[3],2));
  assert.equal(view.looseStart,20); assert.equal(view.cards.length,26);
  assert.equal(JSON.stringify(hand),original);
  assert.equal(JSON.stringify(view.cards.slice(view.looseStart).map(c=>c.rank)),JSON.stringify([2,14,13,4,4,3]));
});
check('every reference bomb can actually beat a single Q through the rules engine', () => {
  const view=tools.handView(referenceCards(deck),2,true);
  const target=GD.rules.resolveSubmission(take(deck,[[12,'S']]),null,2).play;
  for(const g of view.groups) {
    const result=GD.rules.resolveSubmission(view.cards.slice(g.start,g.start+g.len),target,2);
    assert(result.ok); assert.equal(result.play.type,'bomb'); assert.equal(result.play.size,4);
  }
});
check('two spare wilds complete two triples rather than being wasted on one existing bomb', () => {
  const hand=take(deck,[[14,'S'],[14,'D'],[14,'C'],[13,'S'],[13,'D'],[13,'C'],[2,'H',2]]);
  const view=tools.handView(hand,2,true);
  assert.equal(JSON.stringify(view.groups.map(g=>g.rank)),JSON.stringify([14,13]));
  for(const g of view.groups) assert.equal(view.cards.slice(g.start,g.start+g.len).filter(c=>GD.isWild(c,2)).length,1);
});
check('two wilds can complete a pair into a legal four-card bomb', () => {
  const view=tools.handView(take(deck,[[14,'S'],[14,'D'],[2,'H',2]]),2,true);
  assert.equal(view.groups.length,1); assert.equal(view.groups[0].rank,14);
  const result=GD.rules.resolveSubmission(view.cards,null,2); assert(result.ok); assert.equal(result.play.type,'bomb');
});
check('triples receive a single wild before pairs requiring two wilds', () => {
  const view=tools.handView(take(deck,[[3,'S'],[3,'D'],[3,'C'],[14,'S'],[14,'D'],[2,'H',2]]),2,true);
  assert.equal(view.groups.length,1); assert.equal(view.groups[0].rank,3);
  assert.equal(view.cards.slice(view.looseStart).filter(c=>GD.isWild(c,2)).length,1);
});
check('a complete level-rank bomb is preserved instead of donating its wilds', () => {
  const view=tools.handView(take(deck,[[2,'H',2],[2,'S',2],[14,'S'],[14,'D'],[14,'C']]),2,true);
  assert.equal(view.groups.length,1); assert.equal(view.groups[0].rank,2); assert.equal(view.groups[0].len,4);
});
check('a hundred dealt hands keep every physical card and every displayed group is legal', () => {
  for(let seed=1;seed<=100;seed++) {
    const hand=GD.shuffle(deck.slice(),GD.mulberry32(seed)).filter((_,i)=>i%4===0);
    const before=JSON.stringify(hand), view=tools.handView(hand,2,true);
    assert.equal(JSON.stringify(hand),before);
    assert.equal(new Set(view.cards.map(c=>c.id)).size,27);
    assert.equal(JSON.stringify(Array.from(view.cards,c=>c.id).sort((a,b)=>a-b)),JSON.stringify(Array.from(hand,c=>c.id).sort((a,b)=>a-b)));
    for(const g of view.groups) {
      const result=GD.rules.resolveSubmission(view.cards.slice(g.start,g.start+g.len),null,2);
      assert(result.ok); assert.equal(result.play.type,g.type);
    }
  }
});
const options={cardWidth:90,cardHeight:132,availableWidth:1200,stepY:32,minStepX:70};
check('atomic groups preserve four through eight cards even under a three-row limit', () => {
  for(let size=4;size<=8;size++) {
    const items=Array.from({length:size},()=>({rank:8,stack:'bomb-8'}))
      .concat(Array.from({length:4},()=>({rank:11,stack:'bomb-J'})),[{rank:3,break:true}]);
    const layout=tools.stackLayout(items,{...options,maxRows:3,keepGroupsTogether:true});
    assert.equal(layout.columns,3);
    assert.equal(new Set(layout.positions.slice(0,size).map(p=>p.left)).size,1);
    assert.equal(new Set(layout.positions.slice(size,size+4).map(p=>p.left)).size,1);
    assert(layout.positions[size].left>layout.positions[0].left);
    assert.equal(layout.positions.length,items.length);
  }
});
check('eight same-rank cards split into two columns with four readable headers each', () => {
  const layout=tools.stackLayout(deck.filter(c=>c.rank===8).map(c=>({rank:c.rank})),options);
  assert.equal(layout.columns,2); assert.equal(layout.positions.length,8); assert.equal(layout.height,268);
  for(let i=1;i<4;i++) assert.equal(layout.positions[i].top-layout.positions[i-1].top,32);
  assert(layout.positions[4].left>layout.positions[0].left);
  assert.equal(layout.positions[0].top,layout.positions[4].top);
});
check('columns share a baseline and preserve every selectable card', () => {
  const items=[{rank:14},{rank:8},{rank:8},{rank:8},{rank:3},{rank:3}];
  const layout=tools.stackLayout(items,options);
  assert.equal(layout.positions[0].top,layout.positions[3].top);
  assert.equal(layout.positions[3].top,layout.positions[5].top);
  assert.equal(layout.positions.length,items.length);
  assert(layout.positions.every(p=>p.top>=32));
});
check('right columns cover left edges consistently regardless of stack depth', () => {
  const layout=tools.stackLayout([{rank:14},{rank:14},{rank:14},{rank:14},{rank:8}],options);
  assert(layout.positions[4].layer>layout.positions[3].layer);
  for(let i=1;i<4;i++) assert(layout.positions[i].layer>layout.positions[i-1].layer);
});
check('narrow layouts retain legible exposed corners and overflow horizontally', () => {
  const layout=tools.stackLayout(Array.from({length:18},(_,rank)=>({rank})),{...options,cardWidth:46,cardHeight:60,availableWidth:667,stepY:16,minStepX:38,paddingTop:26});
  assert(layout.width>667);
  for(let i=1;i<layout.positions.length;i++) assert(layout.positions[i].left-layout.positions[i-1].left>=38);
});
check('empty hand layout has no phantom cards or columns', () => {
  const layout=tools.stackLayout([],options);
  assert.equal(layout.positions.length,0); assert.equal(layout.columns,0);
});
check('wide layouts retain reference-style overlap instead of spreading columns apart', () => {
  const layout=tools.stackLayout([{rank:12},{rank:9}],{...options,maxStepX:72});
  assert.equal(layout.positions[1].left-layout.positions[0].left,72);
});
check('five-card bombs stay in one column when the available height permits', () => {
  const items=Array.from({length:5},()=>({rank:12,stack:'bomb-12'}));
  const layout=tools.stackLayout(items,{...options,maxRows:6});
  assert.equal(layout.columns,1);assert.equal(layout.positions.length,5);
  assert(layout.positions.every(p=>p.left===layout.positions[0].left));
  for(let i=1;i<5;i++) assert.equal(layout.positions[i].top-layout.positions[i-1].top,32);
});
check('five cards remain one stack even with a three or four row viewport limit', () => {
  for (const maxRows of [3,4]) {
    const items=Array.from({length:5},()=>({rank:8,stack:'bomb-8'})).concat({rank:7});
    const layout=tools.stackLayout(items,{...options,maxRows,keepFiveTogether:true});
    assert.equal(layout.columns,2);
    assert(layout.positions.slice(0,5).every(p=>p.left===layout.positions[0].left));
    assert(layout.positions[5].layer>layout.positions[4].layer);
  }
});
check('three aces and the heart-two wild stay in the same four-card column on a short viewport', () => {
  const hand=take(deck,[[14,'C'],[14,'D'],[14,'S'],[2,'H']]);
  const view=tools.handView(hand,2,true), group=view.groups[0];
  assert.equal(group.rank,14); assert.equal(group.len,4);
  const items=view.cards.map(c=>({rank:c.rank,stack:'aces-with-wild'})).concat({rank:13,stack:'loose'});
  const layout=tools.stackLayout(items,{...options,maxRows:3,keepFourTogether:true,keepFiveTogether:true});
  assert.equal(layout.columns,2);
  assert(layout.positions.slice(0,4).every(p=>p.left===layout.positions[0].left));
  assert.equal(new Set(layout.positions.slice(0,4).map(p=>p.top)).size,4);
  assert(GD.isWild(view.cards[3],2));
  assert(GD.rules.resolveSubmission(view.cards,null,2).ok);
});
check('keeping a four-card column does not merge separate bombs or change eight-card limits', () => {
  const four=Array.from({length:4},()=>({rank:14,stack:'first'}));
  const second=Array.from({length:4},()=>({rank:13,stack:'second'}));
  const layout=tools.stackLayout(four.concat(second),{...options,maxRows:3,keepFourTogether:true});
  assert.equal(layout.columns,2);assert.notEqual(layout.positions[0].left,layout.positions[4].left);
  const eight=Array.from({length:8},()=>({rank:8,stack:'eight'}));
  assert.equal(tools.stackLayout(eight,{...options,maxRows:3,keepFourTogether:true}).columns,3);
});
check('keeping five together preserves other stack limits and explicit group breaks', () => {
  const eight=Array.from({length:8},()=>({rank:8,stack:'eight'}));
  assert.equal(tools.stackLayout(eight,{...options,maxRows:3,keepFiveTogether:true}).columns,3);
  const separate=Array.from({length:5},(_,i)=>({rank:8,break:i===3}));
  assert.equal(tools.stackLayout(separate,{...options,maxRows:3,keepFiveTogether:true}).columns,2);
});
check('eight-row columns preserve layer order before the next column', () => {
  const items=Array.from({length:8},()=>({rank:8})).concat({rank:3});
  const layout=tools.stackLayout(items,{...options,maxRows:8});
  assert.equal(layout.columns,2);assert(layout.positions[8].layer>layout.positions[7].layer);
});
for (const leader of [0,1,2,3]) check('leader '+leader+': engine sequence matches counter-clockwise displayed seats', () => {
  const s=GD.game.newPractice('easy',{leader,rand:GD.mulberry32(123)});
  assert.equal(s.awaiting.seat,leader);
  assert(GD.game.act(s,leader,[s.hands[leader][0]]).ok);
  for(let i=1;i<=3;i++) {
    const next=(leader+i)%4;
    assert.equal(s.awaiting.seat,next);
    assert(GD.game.act(s,next,null).ok);
  }
  assert.equal(s.awaiting.seat,leader);
  assert.equal(tools.seats[1].side,'right'); assert.equal(tools.seats[2].side,'top'); assert.equal(tools.seats[3].side,'left');
});
console.log('\n'+checks+' table logic checks passed.');
