import { Worker } from 'node:worker_threads';
import type { HistoryResolution } from '../../adapter-codex/src/history-index.js';

/** Small RPC bridge; SQLite, discovery and source validation stay off renderer. */
export class HistoryClient {
  private readonly worker: Worker;
  private next = 0;
  private readonly pending = new Map<number, { resolve: (result: HistoryResolution) => void; reject: (error: Error) => void }>();
  constructor(script: string, codexHome: string, cacheDirectory: string, inlineMath = false, claudeHome?: string) {
    this.worker = new Worker(script, { workerData: { codexHome, cacheDirectory, inlineMath, claudeHome },
      resourceLimits: { maxOldGenerationSizeMb: 256 } });
    this.worker.on('message', message => {
      if (message.type !== 'resolved') return;
      const request = this.pending.get(message.id);
      if (request) { this.pending.delete(message.id); request.resolve(message); }
    });
    const fail = (error: Error) => {
      for (const request of this.pending.values()) request.reject(error);
      this.pending.clear();
      // The native host already supervises this process and restarts failures.
      process.exit(1);
    };
    this.worker.on('error', fail);
    this.worker.on('exit', () => fail(new Error('History worker exited')));
  }
  resolve(text: string, leadingContext?: string): Promise<HistoryResolution> {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ type: 'resolve', id, text, leadingContext });
    });
  }
}
