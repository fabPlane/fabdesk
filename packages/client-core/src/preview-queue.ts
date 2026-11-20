type PreviewJob = { key: string; priority: number; run: () => Promise<void> };

/** One native export per daemon. Visible views take the next available slot. */
export class PreviewQueue {
  private pending: PreviewJob[] = [];
  private observers = new Map<string, number>();
  private scheduled = false;

  prefer(key: string) {
    this.observers.set(key, (this.observers.get(key) ?? 0) + 1);
    return () => {
      const remaining = (this.observers.get(key) ?? 1) - 1;
      if (remaining) this.observers.set(key, remaining);
      else this.observers.delete(key);
    };
  }

  enqueue<T>(key: string, priority: number, signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.push({ key, priority, run: async () => {
        try { signal.throwIfAborted(); resolve(await work()); }
        catch (error) { reject(error); }
      } });
      this.pending.sort((a, b) => a.priority - b.priority);
      if (!this.scheduled) {
        this.scheduled = true;
        // Collect sibling query subscriptions before choosing the first export.
        queueMicrotask(() => void this.drain());
      }
    });
  }

  private async drain() {
    try {
      while (this.pending.length) {
        const visible = this.pending.findIndex(job => this.observers.has(job.key));
        const [next] = this.pending.splice(Math.max(0, visible), 1);
        await next!.run();
      }
    } finally { this.scheduled = false; }
  }
}

const queues = new Map<string, PreviewQueue>();
export function previewQueue(endpoint: string) {
  let queue = queues.get(endpoint);
  if (!queue) { queue = new PreviewQueue(); queues.set(endpoint, queue); }
  return queue;
}
