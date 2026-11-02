'use strict';
const { Worker } = require('node:worker_threads');
const path = require('node:path');
class AiPool {
  constructor(size = 2) { this.size = size; this.workers = []; this.queue = []; this.serial = 0; this.closed = false; }
  decide(observation, difficulty) {
    if (this.closed || this.queue.length > 200) return Promise.resolve(null);
    return new Promise(resolve => {
      this.queue.push({ id: ++this.serial, observation, difficulty, resolve });
      this.pump();
    });
  }
  pump() {
    if (this.closed || !this.queue.length) return;
    let slot = this.workers.find(w => !w.task);
    if (!slot && this.workers.length < this.size) {
      slot = { worker: new Worker(path.join(__dirname, 'ai-worker.cjs')), task: null };
      this.workers.push(slot);
      slot.worker.on('message', message => {
        if (!slot.task || message.id !== slot.task.id) return;
        clearTimeout(slot.timer);
        slot.task.resolve(message.error ? null : message.ids);
        slot.task = null;
        this.pump();
      });
      const failed = () => {
        clearTimeout(slot.timer);
        slot.task?.resolve(null);
        slot.task = null;
        this.workers = this.workers.filter(w => w !== slot);
        this.pump();
      };
      slot.worker.once('error', failed);
      slot.worker.once('exit', () => { if (this.workers.includes(slot)) failed(); });
    }
    if (!slot) return;
    slot.task = this.queue.shift();
    slot.timer = setTimeout(() => slot.worker.terminate(), 2500);
    slot.worker.postMessage({ id: slot.task.id, observation: slot.task.observation, difficulty: slot.task.difficulty });
    this.pump();
  }
  async close() {
    this.closed = true;
    this.queue.splice(0).forEach(t => t.resolve(null));
    await Promise.all(this.workers.map(w => {
      clearTimeout(w.timer); w.task?.resolve(null); return w.worker.terminate();
    }));
    this.workers = [];
  }
}
module.exports = AiPool;
