// Session downloads stay ordinary JSON. Compression is only a browser-storage fallback.
export async function encodeAutosave(text){
  const stream=new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  const bytes=new Uint8Array(await new Response(stream).arrayBuffer());
  let binary='';for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));
  return JSON.stringify({storageFormat:'placement-lab/gzip-v1',data:btoa(binary)});
}
export async function decodeAutosave(text){
  const value=JSON.parse(text);if(value?.storageFormat==='placement-lab/indexeddb-v1'){if(typeof value.key!=='string')throw Error('Invalid browser autosave reference.');const stored=await indexedRead(value.key);if(!stored)throw Error('Browser autosave is missing.');return decodeAutosave(stored);}if(value?.storageFormat!=='placement-lab/gzip-v1')return text;
  if(typeof value.data!=='string')throw Error('Invalid compressed autosave.');
  const binary=atob(value.data),bytes=Uint8Array.from(binary,c=>c.charCodeAt(0));
  return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
}

function database(){return new Promise((resolve,reject)=>{const request=indexedDB.open('placement-lab-autosave',1);request.onupgradeneeded=()=>request.result.createObjectStore('sessions');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});}
async function indexedSave(key,value){const db=await database();try{await new Promise((resolve,reject)=>{const tx=db.transaction('sessions','readwrite');tx.objectStore('sessions').put(value,key);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||Error('Browser autosave transaction aborted.'));});}finally{db.close();}}
async function indexedRead(key){const db=await database();try{return await new Promise((resolve,reject)=>{const request=db.transaction('sessions').objectStore('sessions').get(key);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});}finally{db.close();}}
export async function saveAutosave(storage,key,text){
  try{storage.setItem(key,text);return 'plain-json';}catch{}
  const compressed=await encodeAutosave(text);
  try{storage.setItem(key,compressed);return 'gzip';}catch{}
  // Keep older session keys intact. Large state belongs in IndexedDB rather
  // than consuming the remaining localStorage quota with a duplicate board.
  await indexedSave(key,compressed);
  storage.setItem(key,JSON.stringify({storageFormat:'placement-lab/indexeddb-v1',key}));
  return 'indexeddb-gzip';
}
