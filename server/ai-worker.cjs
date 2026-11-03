'use strict';
const { parentPort } = require('node:worker_threads');
const GD = require('./runtime.cjs');
parentPort.on('message', ({ id, observation, difficulty }) => {
  try {
    const options = { tier: difficulty, budgetMs: difficulty === 'hard' ? 140 : 80,
      samples: difficulty === 'hard' ? 8 : 4, maxCandidates: 5 };
    const choice = GD.ai.recommend(observation, options);
    parentPort.postMessage({ id, ids: choice.action === 'play' ? choice.cards.map(c => c.id) : null });
  } catch { parentPort.postMessage({ id, error: true }); }
});
