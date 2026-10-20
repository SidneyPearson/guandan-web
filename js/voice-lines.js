/* 内置报牌词表；播放器、离线缓存和素材生成共用，同一版本完整交付。 */
(function () {
  const root = typeof window !== "undefined" ? window : self;
  const GD = (root.GD = root.GD || {});
  const lines = {
    straight: "顺子！", dpairs: "三连对！", steel: "钢板！", fullhouse: "三带二！",
    sflush: "同花顺！", jokers: "四大天王！", jiefeng: "对家接风！",
    "jiefeng-handoff": "队友，交给你！", "jiefeng-reply": "接风，看我的！",
    "pass-0": "不要。", "pass-1": "过。", "pass-2": "这手先过！", "pass-3": "你们先出！",
    "pass-4": "这轮先过！", "pass-5": "先歇一手！",
    "pass-unable-0": "要不起！", "pass-unable-1": "这牌要不起！",
    "beat-0": "大你！", "beat-1": "压上！", "beat-2": "管上！",
    last1: "我还剩一张！", last2: "我还剩两张！",
    preview: "要不起！大你！顺子！四大天王！",
  };
  const ranks = { 2:"二",3:"三",4:"四",5:"五",6:"六",7:"七",8:"八",9:"九",10:"十",11:"勾",12:"圈",13:"凯",14:"尖",16:"小王",17:"大王" };
  for (const [rank, name] of Object.entries(ranks)) {
    lines["single-" + rank] = name + "。";
    lines["pair-" + rank] = "一对" + name + "。";
    if (Number(rank) <= 14) lines["triple-" + rank] = "三个" + name + "。";
  }
  const counts = {4:"四",5:"五",6:"六",7:"七",8:"八",9:"九",10:"十"};
  for (const [size, name] of Object.entries(counts)) lines["bomb-" + size] = name + "张炸弹！";
  GD.VOICE_LINES = Object.freeze(lines);
  GD.VOICE_PROFILES = Object.freeze(["bright", "bold", "spark", "calm"]);
  // 自己、东家、对家、西家固定使用四位不同说话者，换回合不换声线。
  GD.VOICE_SEATS = Object.freeze(["bright", "bold", "spark", "calm"]);
})();
