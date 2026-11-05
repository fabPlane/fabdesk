import { createSketchRecoveryStore, type SketchRecovery } from "@fabdesk/client-core";

let opening: Promise<IDBDatabase> | null = null;
function database(): Promise<IDBDatabase> {
  if (!opening) opening = new Promise<IDBDatabase>((resolve, reject) => {
    let blocked = false;
    const request = indexedDB.open("fabplane.sketch-recovery", 1);
    request.onupgradeneeded = () => { request.result.createObjectStore("drafts"); };
    request.onerror = () => reject(request.error ?? new Error("Local draft storage unavailable"));
    request.onblocked = () => { blocked = true; reject(new Error("Local draft storage is busy")); };
    request.onsuccess = () => {
      const db = request.result;
      if (blocked) { db.close(); return; }
      db.onversionchange = () => { db.close(); opening = null; };
      resolve(db);
    };
  }).catch(error => { opening = null; throw error; });
  return opening;
}
async function transaction<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await database();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction("drafts", mode), request = run(tx.objectStore("drafts"));
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = () => reject(tx.error ?? request.error ?? new Error("Local draft storage unavailable"));
    tx.onabort = () => reject(tx.error ?? new Error("Local draft write interrupted"));
  });
}
export const sketchRecoveryStore = createSketchRecoveryStore({
  read: key => transaction("readonly", store => store.get(key)),
  write: async (key: string, value: SketchRecovery) => { await transaction("readwrite", store => store.put(value, key)); },
  remove: async key => { await transaction("readwrite", store => store.delete(key)); },
});
