/**
 * 项目从 Focus Session 改名 Lectern 时，IndexedDB 的库名跟着换了。库不能原地改名，
 * 所以每个库第一次用新名字打开时，把旧名字那个库的内容整个搬过来，再删掉旧库。
 *
 * 搬的那一步放在新库的 versionchange 事务里：建表和写入同生共死，新库只要存在就一定是搬完了的。
 * 这一点要紧——同步那个库打开后发现没有 root 会当成全新安装、重新播种并换一个设备号，
 * 所以绝不能让「新库已建、数据没到」这个中间状态被别人看见。
 *
 * 弹出面板、后台、离屏页可能同时来开库，整个过程用一把锁串起来。
 * 安卓 App 换了包名，是全新安装，那边没有旧库，走的是最上面那条直接打开的路。
 */
type Rows = Map<string, { keys: IDBValidKey[]; values: unknown[] }>;

const done = <T>(r: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

async function exists(name: string): Promise<boolean> {
  if (typeof indexedDB.databases !== "function") return false;
  return (await indexedDB.databases()).some((d) => d.name === name);
}

async function readAll(name: string): Promise<Rows> {
  const db = await done(indexedDB.open(name));
  try {
    const rows: Rows = new Map();
    const stores = [...db.objectStoreNames];
    if (!stores.length) return rows;
    const tx = db.transaction(stores, "readonly");
    await Promise.all(stores.map(async (s) => {
      const store = tx.objectStore(s);
      const [keys, values] = await Promise.all([done(store.getAllKeys()), done(store.getAll())]);
      rows.set(s, { keys, values });
    }));
    return rows;
  } finally { db.close(); }
}

/** 删不掉（别的页面还开着旧库）也不算错：新库已经是全的，下次打开再删。 */
function drop(name: string): Promise<void> {
  return new Promise((resolve) => {
    const r = indexedDB.deleteDatabase(name);
    r.onsuccess = r.onerror = r.onblocked = () => resolve();
  });
}

function openWith(name: string, version: number, upgrade: (db: IDBDatabase) => void, rows?: Rows): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(name, version);
    r.onupgradeneeded = () => {
      upgrade(r.result);
      if (!rows) return;
      const tx = r.transaction!;
      for (const [s, { keys, values }] of rows) {
        if (!r.result.objectStoreNames.contains(s)) continue;
        const store = tx.objectStore(s);
        // 这几个库都是外置键（建表时没给 keyPath）
        keys.forEach((key, i) => store.put(values[i], key));
      }
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error("indexedDB.open 失败"));
  });
}

/**
 * 打开 `name`；它还不存在而 `legacy` 存在时，先把 `legacy` 的内容搬进来。
 * `upgrade` 只管建表，和直接写 onupgradeneeded 时一样。
 */
export async function openRenamedDb(name: string, legacy: string, version: number, upgrade: (db: IDBDatabase) => void): Promise<IDBDatabase> {
  const work = async (): Promise<IDBDatabase> => {
    if (!await exists(legacy)) return openWith(name, version, upgrade);
    if (await exists(name)) { const db = await openWith(name, version, upgrade); await drop(legacy); return db; }
    const db = await openWith(name, version, upgrade, await readAll(legacy));
    await drop(legacy);
    return db;
  };
  if (typeof navigator !== "undefined" && navigator.locks) return await navigator.locks.request(`lectern-db-rename:${name}`, work);
  return work();
}
