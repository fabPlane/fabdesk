import { isEditableSketchSource, MAX_EDITABLE_SKETCH_BYTES } from "@fabdesk/protocol";

export type SketchRecovery = { version: 1; scene: string; updatedAt: number; source?: { blob: Blob; name: string; lastModified: number } };
export type SketchRecoveryStorage = { read(key: string): Promise<unknown>; write(key: string, value: SketchRecovery): Promise<void>; remove(key: string): Promise<void> };
/** Connection/project/conversation ownership also distinguishes projectless drafts and literal IDs. */
export function sketchRecoveryKey(core: string, project: string | null, thread: string | null): string {
  return JSON.stringify(["fabplane.sketch.v1", core, project, thread]);
}
export function parseSketchRecovery(value: unknown): SketchRecovery | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (row.version !== 1 || typeof row.scene !== "string" || new TextEncoder().encode(row.scene).byteLength > MAX_EDITABLE_SKETCH_BYTES || !isEditableSketchSource(row.scene) || typeof row.updatedAt !== "number" || !Number.isFinite(row.updatedAt)) return null;
  const source = row.source as SketchRecovery["source"];
  if (source !== undefined && (!source || !(source.blob instanceof Blob) || source.blob.size > MAX_EDITABLE_SKETCH_BYTES || typeof source.name !== "string" || !/\.excalidraw$/i.test(source.name) || typeof source.lastModified !== "number" || !Number.isFinite(source.lastModified))) return null;
  return { version: 1, scene: row.scene, updatedAt: row.updatedAt, ...(source ? { source } : {}) };
}
/** Per-key queues span sketch mounts: reopening waits for close/save cleanup instead of resurrecting old data. */
export function createSketchRecoveryStore(storage: SketchRecoveryStorage) {
  const tails = new Map<string, Promise<unknown>>();
  function queued<T>(key: string, action: () => Promise<T>): Promise<T> {
    const task = (tails.get(key) ?? Promise.resolve()).catch(() => {}).then(action);
    tails.set(key, task);
    void task.finally(() => { if (tails.get(key) === task) tails.delete(key); }).catch(() => {});
    return task;
  }
  return {
    read: (key: string) => queued(key, async () => {
      const raw = await storage.read(key);
      if (raw === undefined || raw === null) return null;
      const parsed = parseSketchRecovery(raw);
      if (!parsed) throw new Error("The local sketch draft could not be recovered.");
      return parsed;
    }),
    write: (key: string, value: SketchRecovery) => queued(key, async () => {
      if (!parseSketchRecovery(value)) throw new Error("This draft exceeds local recovery limits.");
      await storage.write(key, value);
    }),
    remove: (key: string) => queued(key, () => storage.remove(key)),
  };
}
/** Camera/selection changes do not create new content revisions. */
export function sketchRecoverySignature(elements: ReadonlyArray<{ id: string; version: number; versionNonce: number; isDeleted: boolean }>): string {
  return JSON.stringify(elements.map(element => [element.id, element.version, element.versionNonce, element.isDeleted]));
}
