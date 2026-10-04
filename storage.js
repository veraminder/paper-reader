// Everything durable lives in this browser's IndexedDB: saved notes,
// folders, the PDFs they belong to, and settings (name, Gemini key).

const DB_NAME = "paper-reader";
const DB_VERSION = 1;
let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore("entries", { keyPath: "id" });
        db.createObjectStore("folders", { keyPath: "id" });
        db.createObjectStore("pdfs");
        db.createObjectStore("settings");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function done(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function store(name, mode = "readonly") {
  return (await openDb()).transaction(name, mode).objectStore(name);
}

export async function getAll(name) {
  return done((await store(name)).getAll());
}

export async function get(name, key) {
  return done((await store(name)).get(key));
}

export async function put(name, value, key) {
  return done((await store(name, "readwrite")).put(value, key));
}

export async function remove(name, key) {
  return done((await store(name, "readwrite")).delete(key));
}

export async function getSetting(key) {
  return get("settings", key);
}

export async function setSetting(key, value) {
  if (value === undefined || value === null || value === "") return remove("settings", key);
  return put("settings", value, key);
}

// Ask the browser not to clear this site's data when space runs low. Only
// called on a user action (saving), since Firefox shows a prompt for it.
export async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist && !(await navigator.storage.persisted())) {
      await navigator.storage.persist();
    }
  } catch { /* best effort */ }
}

export async function storageStatus() {
  const status = { persisted: null, usageBytes: null };
  try {
    if (navigator.storage && navigator.storage.persisted) status.persisted = await navigator.storage.persisted();
    if (navigator.storage && navigator.storage.estimate) status.usageBytes = (await navigator.storage.estimate()).usage ?? null;
  } catch { /* unsupported */ }
  return status;
}
