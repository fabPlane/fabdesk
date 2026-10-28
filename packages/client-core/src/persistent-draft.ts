/** A draft owns its IO closures: navigation cannot redirect a queued write to another project.
 * Cache updates synchronously, writes serialize, and failed saves remain retryable. */
export class PersistentDraft<T> {
  private value: T | null = null;
  private loaded = false;
  private loading: Promise<T | null> | null = null;
  private tail: Promise<void> = Promise.resolve();
  private revision = 0;
  constructor(private io: { read(): Promise<T | null>; write(value: T): Promise<void> }) {}
  load(): Promise<T | null> {
    if (this.loaded) return Promise.resolve(this.value);
    if (!this.loading)
      this.loading = this.io
        .read()
        .then((value) => {
          if (!this.loaded) {
            this.value = value;
            this.loaded = true;
          }
          return this.value;
        })
        .finally(() => {
          this.loading = null;
        });
    return this.loading;
  }
  stage(value: T): void {
    this.value = value;
    this.loaded = true;
    this.revision++;
  }
  save(): Promise<void> {
    const value = this.value;
    const revision = this.revision;
    if (value === null) return Promise.resolve();
    const task = this.tail
      .catch(() => {})
      .then(async () => {
        // A newer staged revision will be saved by its own scheduled flush.
        if (revision !== this.revision) return;
        await this.io.write(value);
      });
    this.tail = task;
    return task;
  }
}

/** IndexedDB supports image-sized unassigned drafts without localStorage's small quota. */
export async function localDraft<T>(key: string, value?: T): Promise<T | null> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("fabdesk-board-art", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("drafts");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise<T | null>((resolve, reject) => {
      const tx = db.transaction("drafts", value === undefined ? "readonly" : "readwrite");
      const request =
        value === undefined
          ? tx.objectStore("drafts").get(key)
          : tx.objectStore("drafts").put(value, key);
      tx.oncomplete = () =>
        resolve(value === undefined ? ((request.result as T | undefined) ?? null) : value);
      tx.onabort = () => reject(tx.error ?? new Error("Could not save the unassigned draft."));
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
