// Storage adapters. Both expose the same interface:
//
//   mode                          'firebase' | 'demo'
//   ready                         Promise, resolves once usable (rejects on setup failure)
//   onConfig(cb)                  cb(config | null) now-ish and on every change; returns unsubscribe
//   saveConfig(config)            Promise — replaces the whole config document
//   createConfig(config)          Promise — writes config only if none exists; rejects {code:'exists'} otherwise
//   onWeek(weekId, cb)            cb({ done: { [taskId]: { by, at } } }) on every change; returns unsubscribe
//   setDone(weekId, taskId, by)   Promise — mark done by person id
//   setUndone(weekId, taskId)     Promise
//
// Firestore layout:
//   rota/config        one document holding people, zones, rooms, tasks, settings
//   weeks/{YYYY-MM-DD} one document per week (Monday): { done: { taskId: { by, at } } }

import { firebaseConfig } from './firebase-config.js';

const FIREBASE_VERSION = '10.12.2';
const cdn = (m) => `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-${m}.js`;

export function createStore() {
  return firebaseConfig ? createFirebaseStore(firebaseConfig) : createDemoStore();
}

function createFirebaseStore(cfg) {
  let fs; // firestore module
  let db;
  const ready = (async () => {
    const [{ initializeApp }, firestore, auth] = await Promise.all([
      import(cdn('app')),
      import(cdn('firestore')),
      import(cdn('auth')),
    ]);
    fs = firestore;
    const app = initializeApp(cfg);
    db = fs.initializeFirestore(app, {
      localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() }),
    });
    const a = auth.getAuth(app);
    await auth.signInAnonymously(a);
  })();

  // trustMissing=false: a "document doesn't exist" answer that came only from
  // the local cache (e.g. a new phone that's offline) is ignored, so the app
  // keeps showing "loading" instead of concluding the database is empty.
  const subscribe = (path, cb, onError, { trustMissing = true } = {}) => {
    let unsub = () => {};
    let cancelled = false;
    ready.then(() => {
      if (cancelled) return;
      unsub = fs.onSnapshot(
        fs.doc(db, ...path),
        (snap) => {
          if (!snap.exists() && snap.metadata.fromCache && !trustMissing) return;
          cb(snap.exists() ? snap.data() : null);
        },
        (err) => onError?.(err),
      );
    }, (err) => onError?.(err));
    return () => {
      cancelled = true;
      unsub();
    };
  };

  return {
    mode: 'firebase',
    ready,
    onConfig: (cb, onError) => subscribe(['rota', 'config'], cb, onError, { trustMissing: false }),
    async saveConfig(config) {
      await ready;
      await fs.setDoc(fs.doc(db, 'rota', 'config'), JSON.parse(JSON.stringify(config)));
    },
    async createConfig(config) {
      await ready;
      const ref = fs.doc(db, 'rota', 'config');
      // Transactions need the server, so this can never overwrite a real rota
      // from a device that merely can't see it.
      await fs.runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        if (snap.exists()) throw Object.assign(new Error('Config already exists'), { code: 'exists' });
        tx.set(ref, JSON.parse(JSON.stringify(config)));
      });
    },
    onWeek: (weekId, cb, onError) => subscribe(['weeks', weekId], (d) => cb(d || { done: {} }), onError),
    async setDone(weekId, taskId, by) {
      await ready;
      await fs.setDoc(
        fs.doc(db, 'weeks', weekId),
        { done: { [taskId]: { by, at: fs.serverTimestamp() } } },
        { merge: true },
      );
    },
    async setUndone(weekId, taskId) {
      await ready;
      await fs.setDoc(fs.doc(db, 'weeks', weekId), { done: { [taskId]: fs.deleteField() } }, { merge: true });
    },
  };
}

function createDemoStore() {
  const KEY_CONFIG = 'rota-demo:v2:config';
  const keyWeek = (id) => `rota-demo:week:${id}`;
  const listeners = new Map(); // key -> Set<fn>

  const read = (key) => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  };
  const write = (key, value) => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* storage full or blocked — demo mode only */
    }
    emit(key);
  };
  const emit = (key) => (listeners.get(key) || new Set()).forEach((fn) => fn(read(key)));
  const listen = (key, fn) => {
    if (!listeners.has(key)) listeners.set(key, new Set());
    listeners.get(key).add(fn);
    queueMicrotask(() => fn(read(key)));
    return () => listeners.get(key)?.delete(fn);
  };
  // Other tabs in the same browser
  window.addEventListener('storage', (e) => e.key && listeners.has(e.key) && emit(e.key));

  return {
    mode: 'demo',
    ready: Promise.resolve(),
    onConfig: (cb) => listen(KEY_CONFIG, cb),
    async saveConfig(config) {
      write(KEY_CONFIG, JSON.parse(JSON.stringify(config)));
    },
    async createConfig(config) {
      if (read(KEY_CONFIG)) throw Object.assign(new Error('Config already exists'), { code: 'exists' });
      write(KEY_CONFIG, JSON.parse(JSON.stringify(config)));
    },
    onWeek: (weekId, cb) => listen(keyWeek(weekId), (d) => cb(d || { done: {} })),
    async setDone(weekId, taskId, by) {
      const d = read(keyWeek(weekId)) || { done: {} };
      d.done[taskId] = { by, at: Date.now() };
      write(keyWeek(weekId), d);
    },
    async setUndone(weekId, taskId) {
      const d = read(keyWeek(weekId)) || { done: {} };
      delete d.done[taskId];
      write(keyWeek(weekId), d);
    },
  };
}
