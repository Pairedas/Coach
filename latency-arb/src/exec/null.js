import { EventEmitter } from 'node:events';

/** Courtier inerte : le mode diagnostic observe le marche sans jamais engager d'ordre. */
export class NullBroker extends EventEmitter {
  constructor() {
    super();
    this.mode = 'diagnostic';
    this.submitted = 0;
  }

  submit() { this.submitted += 1; return null; }
  tick() {}
  get pendingCount() { return 0; }
  stop() {}
}
