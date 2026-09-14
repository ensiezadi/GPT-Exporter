// This database belongs to chrome-extension://<id>, not the ChatGPT page origin.
// Content scripts' IndexedDB belongs to their host page and cannot open this vault.
let opening;
function database() {
  if (!opening)
    opening = new Promise((resolve, reject) => {
      const request = indexedDB.open("gpt-exporter-private", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("state");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        opening = null;
        reject(new Error("无法打开扩展本地数据库"));
      };
    });
  return opening;
}
export async function read(key) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const request = db
      .transaction("state", "readonly")
      .objectStore("state")
      .get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("无法读取同步检查点"));
  });
}
export async function write(key, value) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("state", "readwrite");
    tx.objectStore("state").put(value, key);
    tx.oncomplete = resolve;
    tx.onerror = tx.onabort = () => reject(new Error("无法保存同步检查点"));
  });
}
export async function remove(key) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("state", "readwrite");
    tx.objectStore("state").delete(key);
    tx.oncomplete = resolve;
    tx.onerror = tx.onabort = () => reject(new Error("无法更新同步状态"));
  });
}
