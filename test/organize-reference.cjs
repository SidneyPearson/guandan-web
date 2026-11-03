// 用户第一张参考图中的 27 张实体牌；第二张图已经打出红桃 10。
const specs = [[2,"H"],[2,"S"],[14,"S"],[13,"H"],
  [12,"D"],[12,"C"],[12,"H"],[12,"S"],[10,"H"],
  [9,"D",2],[9,"C"],[9,"H"],[7,"C",2],[7,"H"],[7,"S"],
  [6,"C",2],[6,"H"],[5,"D"],[5,"H"],[5,"S",2],[4,"C",2],[3,"C"]];
function take(deck, requests) {
  const available = deck.slice(), cards = [];
  for (const [rank, suit, count = 1] of requests) {
    for (let i = 0; i < count; i++) {
      const ix = available.findIndex(c => c.rank === rank && c.suit === suit);
      if (ix < 0) throw new Error("fixture lacks card " + rank + suit);
      cards.push(available.splice(ix, 1)[0]);
    }
  }
  return cards;
}
module.exports = { take, referenceCards: deck => take(deck, specs) };
