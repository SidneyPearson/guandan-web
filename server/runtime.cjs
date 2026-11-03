'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

// Shared browser sources run without DOM or browser storage. Each game remains
// an explicit state object; room persistence belongs to the room service.
const context = vm.createContext({ console, performance, setTimeout, clearTimeout,
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} } });
context.window = context;
for (const name of ['version', 'util', 'cards', 'rules', 'flow', 'ai', 'ai-memory', 'ai-search', 'game']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js', name + '.js'), 'utf8'), context,
    { filename: name + '.js' });
}
const GD = context.GD;
GD.store.save = () => ({ ok: true });
GD.uid = () => crypto.randomUUID();
GD.hashSeed = () => crypto.randomBytes(4).readUInt32BE();
GD.serverRandom = () => crypto.randomBytes(6).readUIntBE(0, 6) / 2 ** 48;
// continueAfterHand also uses GD.shuffle, so protect every deal, not just the first.
const shuffle = GD.shuffle;
GD.shuffle = (cards, rand) => shuffle(cards, rand || GD.serverRandom);
module.exports = GD;
