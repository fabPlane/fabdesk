import type { RouteTaskCoordinator } from "@fabdesk/tools";

type Entry = {
  id: string;
  projectId: string;
  controller: AbortController;
  task: (signal: AbortSignal) => Promise<void>;
  state: "queued" | "running";
};

/**
 * Owns route promises for the daemon lifetime and serializes them per project.  A task is never a
 * detached request promise: it remains addressable by run id until its worker has settled.
 */
export class RouteTaskQueue implements RouteTaskCoordinator {
  private readonly entries = new Map<string, Entry>();
  private readonly queues = new Map<string, Entry[]>();
  private readonly workers = new Map<string, Promise<void>>();

  enqueue(
    input: { id: string; projectId: string },
    task: (signal: AbortSignal) => Promise<void>,
  ): "queued" | "running" {
    if (this.entries.has(input.id)) throw new Error(`route task already exists: ${input.id}`);
    const queue = this.queues.get(input.projectId) ?? [];
    const state = this.workers.has(input.projectId) || queue.length ? "queued" : "running";
    const entry: Entry = { ...input, controller: new AbortController(), task, state };
    queue.push(entry);
    this.queues.set(input.projectId, queue);
    this.entries.set(input.id, entry);
    if (!this.workers.has(input.projectId)) this.startWorker(input.projectId);
    return state;
  }

  cancel(id: string): "requested" | "already_requested" | "terminal" | "not_found" {
    const entry = this.entries.get(id);
    if (!entry) return "not_found";
    if (entry.controller.signal.aborted) return "already_requested";
    entry.controller.abort(new Error(`route ${id} cancelled`));
    return "requested";
  }

  private async drain(projectId: string): Promise<void> {
    const queue = this.queues.get(projectId)!;
    while (queue.length) {
      const entry = queue[0]!;
      entry.state = "running";
      try {
        await entry.task(entry.controller.signal);
      } catch {
        // The route worker persists its own truthful terminal state. Keep the queue alive if a
        // defensive/unexpected exception escapes it.
      } finally {
        queue.shift();
        this.entries.delete(entry.id);
      }
    }
  }

  private startWorker(projectId: string): void {
    const worker = Promise.resolve()
      .then(() => this.drain(projectId))
      .finally(() => {
        this.workers.delete(projectId);
        // An enqueue can land after drain observes an empty queue but before this finally runs.
        // Hand that entry to a new tracked worker instead of stranding it.
        if (this.queues.get(projectId)?.length) this.startWorker(projectId);
        else this.queues.delete(projectId);
      });
    this.workers.set(projectId, worker);
  }
}
