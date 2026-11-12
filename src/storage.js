const DB_NAME = 'inclusive-design-v1';
export const emptyData = () => ({ version: 1, exercises: [], workouts: [] });
let database;
async function db() {
  if (!database) database = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('data');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return database;
}
export async function loadData() {
  const database = await db();
  return new Promise((resolve, reject) => {
    const request = database.transaction('data').objectStore('data').get('library');
    request.onsuccess = () => resolve(request.result || emptyData());
    request.onerror = () => reject(request.error);
  });
}
export async function saveData(data) {
  const database = await db();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction('data', 'readwrite');
    transaction.objectStore('data').put(data, 'library');
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('Save interrupted'));
  });
}
