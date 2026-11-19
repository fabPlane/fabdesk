/** One native export per daemon. Superseded waiting work never starts. */
export class PreviewQueue {
  private pending: Array<{ priority: number; signal: AbortSignal; run: () => Promise<void> }> = [];
  private running = false;

  enqueue<T>(priority: number, signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.push({ priority, signal, run: async () => {
        try { signal.throwIfAborted(); resolve(await work()); }
        catch (error) { reject(error); }
      } });
      this.pending.sort((a, b) => a.priority - b.priority);
      void this.drain();
    });
  }

  private async drain() {
    if (this.running) return;
    this.running = true;
    try {
      for (let next; (next = this.pending.shift());) await next.run();
    } finally { this.running = false; }
  }
}

const queues = new Map<string, PreviewQueue>();
export function previewQueue(endpoint: string) {
  let queue = queues.get(endpoint);
  if (!queue) { queue = new PreviewQueue(); queues.set(endpoint, queue); }
  return queue;
}
