// Response cache: memory first, IndexedDB behind it so a restart doesn't re-spend
// quota. Every failure path falls through to a network fetch.

interface Entry {
  key: string;
  at: number;
  value: unknown;
}

const mem = new Map<string, Entry>();
let dbp: Promise<IDBDatabase | null> | null = null;

function db(): Promise<IDBDatabase | null> {
  dbp ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open("panorama-cache", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("r", { keyPath: "key" });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbp;
}

/** The cached value and its age, however old. */
export async function cacheEntry<T>(key: string): Promise<{ value: T; age: number } | undefined> {
  let e = mem.get(key);
  if (!e) {
    const d = await db();
    if (d) {
      e = await new Promise<Entry | undefined>((resolve) => {
        const req = d.transaction("r").objectStore("r").get(key);
        req.onsuccess = () => resolve(req.result as Entry | undefined);
        req.onerror = () => resolve(undefined);
      });
      if (e) mem.set(key, e);
    }
  }
  return e ? { value: e.value as T, age: Date.now() - e.at } : undefined;
}

export async function cacheGet<T>(key: string, ttlMs: number): Promise<T | undefined> {
  let e = mem.get(key);
  if (!e) {
    const d = await db();
    if (d) {
      e = await new Promise<Entry | undefined>((resolve) => {
        const req = d.transaction("r").objectStore("r").get(key);
        req.onsuccess = () => resolve(req.result as Entry | undefined);
        req.onerror = () => resolve(undefined);
      });
      if (e) mem.set(key, e);
    }
  }
  return e && Date.now() - e.at < ttlMs ? (e.value as T) : undefined;
}

export async function cachePut(key: string, value: unknown): Promise<void> {
  const e = { key, at: Date.now(), value };
  mem.set(key, e);
  const d = await db();
  if (!d) return;
  try {
    d.transaction("r", "readwrite").objectStore("r").put(e);
  } catch {
    /* quota exceeded or closed: memory cache still serves this session */
  }
}

export async function cacheDelete(key: string): Promise<void> {
  mem.delete(key);
  const d = await db();
  try {
    d?.transaction("r", "readwrite").objectStore("r").delete(key);
  } catch {
    /* closed: the entry just ages out */
  }
}

export async function cacheClear(): Promise<void> {
  mem.clear();
  const d = await db();
  d?.transaction("r", "readwrite").objectStore("r").clear();
}
