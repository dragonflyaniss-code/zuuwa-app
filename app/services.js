/* ZUUWA — data & business service layer.
   UI talks only to these services. storageService is the single persistence
   adapter (IndexedDB, falling back to localStorage); swap it for a Supabase
   adapter later without touching the UI. */
(function () {
  'use strict';
  const ZW = (window.ZW = window.ZW || {});

  // ---------- utils ----------
  const uid = (p) => (p || 'id') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const num = (v) => { const n = parseFloat(String(v == null ? '' : v).replace(/,/g, '')); return isFinite(n) ? n : 0; };
  const r2 = (n) => Math.round((num(n) + Number.EPSILON) * 100) / 100;
  // Where a customer payment landed. Stored per payment record for later reporting; separate from the payment method.
  const RECEIVED_THROUGH = ['Company Bank Account', 'CIMB Firdaus', 'Cash'];
  const EPS = 0.005;
  const pad = (n, d) => String(n).padStart(d, '0');
  const isoOf = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1, 2) + '-' + pad(d.getDate(), 2);
  const todayISO = () => isoOf(new Date());
  const validDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && !isNaN(new Date(s + 'T00:00:00').getTime());
  const addDays = (iso, n) => { if (!validDate(iso)) return ''; const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + num(n)); return isoOf(d); };
  const addPeriod = (iso, period) => {
    const m = /(\d+)\s*(month|year)/i.exec(period || ''); if (!m || !validDate(iso)) return '';
    const d = new Date(iso + 'T00:00:00'); const n = parseInt(m[1], 10);
    if (/month/i.test(m[2])) d.setMonth(d.getMonth() + n); else d.setFullYear(d.getFullYear() + n);
    d.setDate(d.getDate() - 1); return isoOf(d);
  };
  const periodOf = (iso) => (validDate(iso) ? iso.slice(0, 4) + iso.slice(5, 7) : todayISO().slice(0, 4) + todayISO().slice(5, 7));
  const isObj = (o) => o && typeof o === 'object' && !Array.isArray(o);
  function deepMerge(base, over) {
    if (!isObj(base) || !isObj(over)) return over === undefined ? base : over;
    const out = { ...base };
    for (const k of Object.keys(over)) out[k] = isObj(base[k]) && isObj(over[k]) ? deepMerge(base[k], over[k]) : over[k];
    return out;
  }
  const fill = (text, ctx) => String(text || '').replace(/\{(\w+)\}/g, (m, k) => (ctx && ctx[k] != null && ctx[k] !== '' ? ctx[k] : m));
  const byDateAsc = (a, b) => (a.date || '').localeCompare(b.date || '') || (a.createdAt || '').localeCompare(b.createdAt || '');
  const byCreated = (a, b) => (a.createdAt || '').localeCompare(b.createdAt || '');
  const same = (a, b) => String(a || '').trim().toUpperCase() === String(b || '').trim().toUpperCase();

  class AppError extends Error { constructor(m, list) { super(m); this.name = 'AppError'; this.list = list && list.length ? list : [m]; } }
  const fail = (errs) => { if (errs.length) throw new AppError(errs[0], errs); };

  // ---------- storageService ----------
  const localStore = (() => {
    const DB = 'zuuwa-waterproofing', STORE = 'kv';
    let db = null; const cache = {}; const subs = new Set(); let onErr = (m) => console.error(m);
    const openDb = () => new Promise((res, rej) => {
      if (!window.indexedDB) return rej(new Error('IndexedDB unavailable'));
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    async function init() {
      try {
        db = await openDb();
        await new Promise((res, rej) => {
          const rq = db.transaction(STORE, 'readonly').objectStore(STORE).openCursor();
          rq.onsuccess = () => { const c = rq.result; if (c) { cache[c.key] = c.value; c.continue(); } else res(); };
          rq.onerror = () => rej(rq.error);
        });
      } catch (e) {
        db = null;
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.indexOf('zuuwa:') === 0) { try { cache[k.slice(6)] = JSON.parse(localStorage.getItem(k)); } catch (_) {} }
        }
      }
    }
    function write(k, v) {
      if (db) {
        try {
          const tx = db.transaction(STORE, 'readwrite'); const st = tx.objectStore(STORE);
          if (v === undefined) st.delete(k); else st.put(v, k);
          tx.onerror = () => onErr('Could not save to device storage. ' + ((tx.error && tx.error.message) || ''));
        } catch (e) { onErr('Could not save to device storage.'); }
      } else {
        try { if (v === undefined) localStorage.removeItem('zuuwa:' + k); else localStorage.setItem('zuuwa:' + k, JSON.stringify(v)); }
        catch (e) { onErr('Device storage is full. Remove some images or documents and try again.'); }
      }
    }
    const emit = (k) => subs.forEach((f) => { try { f(k); } catch (_) {} });
    return {
      init,
      backend: () => (db ? 'IndexedDB — database "' + DB + '"' : 'localStorage (keys prefixed "zuuwa:")'),
      get: (k, d) => (k in cache ? cache[k] : d),
      set(k, v) { cache[k] = v; write(k, v); emit(k); },
      remove(k) { delete cache[k]; write(k, undefined); emit(k); },
      clearAll() { Object.keys(cache).forEach((k) => { delete cache[k]; write(k, undefined); }); emit('*'); },
      subscribe(f) { subs.add(f); return () => subs.delete(f); },
      onError(f) { onErr = f; },
    };
  })();


  // ---------- cloudStore (Supabase) ----------
  // Same synchronous get/set API as the local store: reads come from an in-memory copy of the shared data;
  // every change is diffed per record and sent to Supabase through a retry queue that survives reloads.
  const CFG = window.ZUUWA_CONFIG || {};
  const CLOUD = !!(CFG.supabaseUrl && CFG.supabaseKey);
  const cloudStore = (() => {
    const TABLES = { customers: 'zw_customers', quotations: 'zw_quotations', invoices: 'zw_invoices', payments: 'zw_payments', receipts: 'zw_receipts', warranties: 'zw_warranties' };
    const KV = ['settings', 'counters'];
    const cache = {}; const snap = {}; const onServer = {}; const subs = new Set(); let onErr = (m) => console.error(m);
    // Server version (updated_at) of every row this device last saw. Saves are only accepted if the row is still at that version.
    const ver = {};
    let sb = null; let uid = null; let queue = []; let flushing = false; let retryT = null;
    // ---- sync scheduling (Fix #1): no polling. Pull on sign-in, on return to foreground / reconnect (3-min cooldown), or on manual Refresh.
    const SYNC_COOLDOWN = 3 * 60 * 1000;
    const PULL_BACKOFF = [60e3, 120e3, 300e3, 600e3];        // failed pull: 1 → 2 → 5 → 10 min (max)
    const FLUSH_BACKOFF = [8e3, 60e3, 120e3, 300e3, 600e3];  // unsent changes: first retry 8 s, then 1 → 2 → 5 → 10 min (max)
    const RESTRICTED_MSG = 'Supabase service is temporarily restricted. Please try again later.';
    const AUTH_MSG = 'Your session has expired. Please sign in again.';
    let lastSyncAt = 0; let syncing = null; let pullFails = 0; let flushFails = 0; let backoffT = null; let lastRetryAt = 0;
    let halted = ''; // '' | 'restricted' (HTTP 402) | 'auth' (HTTP 401 and the session could not be refreshed)
    const status = { state: 'idle', pending: 0, failed: [], lastSync: null, message: '' };
    const statusSubs = new Set();
    const setStatus = (p) => { Object.assign(status, p, { pending: queue.length }); statusSubs.forEach((f) => { try { f({ ...status }); } catch (_) {} }); };
    const emit = (k) => subs.forEach((f) => { try { f(k); } catch (_) {} });
    const remember = () => localStorage.getItem('zuuwa.remember') !== '0';
    const authStorage = {
      getItem: (k) => localStorage.getItem(k) || sessionStorage.getItem(k),
      setItem: (k, v) => { (remember() ? localStorage : sessionStorage).setItem(k, v); (remember() ? sessionStorage : localStorage).removeItem(k); },
      removeItem: (k) => { localStorage.removeItem(k); sessionStorage.removeItem(k); },
    };
    const client = () => {
      if (sb) return sb;
      if (!window.supabase || !window.supabase.createClient) throw new AppError('Could not load the Supabase library. Check your internet connection and reload.');
      sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, { auth: { storage: authStorage, persistSession: true, autoRefreshToken: true },
        global: { fetch: (input, init) => fetch(input, init).then((r) => { watchHttp(String((input && input.url) || input), r.status); return r; }) } });
      return sb;
    };
    const qKey = () => 'zuuwa.cloud.queue.' + (uid || 'none');
    const saveQueue = () => { try { localStorage.setItem(qKey(), JSON.stringify(queue)); } catch (_) { if (queue.length) onErr('This device could not keep a backup copy of unsent changes (storage full). Stay online until saving finishes.'); } setStatus({}); };
    const loadQueue = () => { try { queue = JSON.parse(localStorage.getItem(qKey()) || '[]'); } catch (_) { queue = []; } };
    const rowOf = (key, r) => {
      const row = { id: r.id, data: r };
      if (key !== 'customers' && key !== 'payments') row.number = String(r.number || '').trim();
      if (key === 'quotations' || key === 'invoices') row.customer_id = r.customerId || null;
      if (key === 'invoices') { row.quotation_id = r.quotationId || null; row.parent_invoice_id = r.parentInvoiceId || null; }
      if (key === 'payments' || key === 'receipts' || key === 'warranties') row.invoice_id = r.invoiceId || null;
      if (key === 'payments' || key === 'warranties') row.quotation_id = r.quotationId || null;
      return row;
    };
    const pendingIds = (key) => new Set(queue.filter((o) => o.key === key).map((o) => o.id));
    const verOf = (key, id) => ((ver[key] || {})[id]);
    const enqueue = (op) => {
      const ix = queue.findIndex((o) => o.key === op.key && o.id === op.id && !o.inflight);
      if (ix >= 0) { op.base = queue[ix].base; op.afterOwn = queue[ix].afterOwn; queue[ix] = op; return; } // keep the version the edit started from
      const inflight = queue.some((o) => o.key === op.key && o.id === op.id && o.inflight);
      op.base = verOf(op.key, op.id) || null; if (inflight) op.afterOwn = true;
      queue.push(op);
    };
    // Every Supabase response passes through here: 402 stops all automatic requests, 401 checks the session once.
    function watchHttp(url, code) {
      if (code === 402 && /\/(rest|auth|storage)\/v1\//.test(url)) {
        if (halted !== 'restricted') { halted = 'restricted'; clearTimeout(backoffT); clearTimeout(retryT); setStatus({ state: 'restricted', message: RESTRICTED_MSG }); }
      } else if (code === 401 && /\/rest\/v1\//.test(url) && !halted) { halted = 'auth'; clearTimeout(backoffT); clearTimeout(retryT); checkAuth(); }
    }
    async function checkAuth() {
      try { const { data, error } = await client().auth.refreshSession(); if (!error && data && data.session) { if (halted === 'auth') halted = ''; return; } } catch (_) {}
      if (halted === 'auth') setStatus({ state: 'auth', message: AUTH_MSG });
    }
    // One pull at a time; automatic pulls respect the cooldown, failures back off, 402/401 stop them.
    function sync(reason) {
      if (!uid) return Promise.resolve({ skipped: 'signed-out' });
      if (syncing) return syncing;
      if (halted === 'auth') return Promise.resolve({ error: 'auth' });
      if (halted === 'restricted' && reason !== 'manual' && reason !== 'force') return Promise.resolve({ error: 'restricted' });
      const since = Date.now() - lastSyncAt;
      if (reason !== 'force' && reason !== 'backoff' && since < SYNC_COOLDOWN) return Promise.resolve({ skipped: 'cooldown', since, waitMs: SYNC_COOLDOWN - since });
      if (queue.length && reason !== 'force') { if (!halted) flush(); return Promise.resolve({ skipped: 'pending' }); }
      lastSyncAt = Date.now(); clearTimeout(backoffT);
      syncing = (async () => {
        try {
          await pullAll(); pullFails = 0; if (halted === 'restricted') halted = '';
          if (status.state !== 'saving') setStatus({ state: 'saved', lastSync: Date.now(), message: '' });
          return { ok: true };
        } catch (e) {
          if (halted === 'restricted') { setStatus({ state: 'restricted', message: RESTRICTED_MSG }); return { error: 'restricted' }; }
          if (halted === 'auth') return { error: 'auth' };
          const wait = PULL_BACKOFF[Math.min(pullFails, PULL_BACKOFF.length - 1)]; pullFails++;
          setStatus({ state: 'offline', message: 'Not connected — showing the last loaded data. Trying again in ' + Math.round(wait / 60000) + ' min.' });
          backoffT = setTimeout(() => sync('backoff'), wait);
          return { error: 'network' };
        } finally { syncing = null; }
      })();
      return syncing;
    }
    // ---- pull ----
    async function fetchTable(key) {
      const out = []; const size = 500;
      for (let from = 0; ; from += size) {
        const { data, error } = await client().from(TABLES[key]).select('id,data,updated_at').order('id').range(from, from + size - 1);
        if (error) throw error; out.push(...data); if (data.length < size) break;
      }
      return out;
    }
    // ---- incremental pull (Fix #2) ----
    // 1) download only id + updated_at for every row (tiny), 2) download full data only for rows that are new or changed,
    // 3) rows missing from the list were deleted on the server. Unchanged rows are reused from this device's cache.
    async function fetchManifest(table, cols) {
      const out = []; const size = 1000;
      for (let from = 0; ; from += size) {
        const { data, error } = await client().from(table).select(cols).order(cols.split(',')[0]).range(from, from + size - 1);
        if (error) throw error; out.push(...data); if (data.length < size) break;
      }
      return out;
    }
    async function fetchByIds(key, ids) {
      const out = [];
      for (let i = 0; i < ids.length; i += 50) {
        const { data, error } = await client().from(TABLES[key]).select('id,data,updated_at').in('id', ids.slice(i, i + 50));
        if (error) throw error; out.push(...data);
      }
      return out;
    }
    async function pullTable(key) {
      const man = await fetchManifest(TABLES[key], 'id,updated_at');
      const pend = pendingIds(key); const known = ver[key] || {}; const have = new Map((cache[key] || []).map((r) => [r.id, r]));
      const need = man.filter((m) => !pend.has(m.id) && !(known[m.id] === m.updated_at && have.has(m.id))).map((m) => m.id);
      let fresh;
      if (need.length > 25 && need.length > man.length * 0.5) fresh = await fetchTable(key); // first load on a device: one paged download is cheaper than many small ones
      else fresh = need.length ? await fetchByIds(key, need) : [];
      const byId = new Map(fresh.map((r) => [r.id, r]));
      const rows = [];
      man.forEach((m) => {
        const f = byId.get(m.id); if (f) { rows.push(f); return; }
        if (pend.has(m.id) || have.has(m.id)) rows.push({ id: m.id, updated_at: m.updated_at, data: have.get(m.id) || null });
      });
      return rows.filter((r) => r.data || pend.has(r.id));
    }
    async function pullKv() {
      const man = await fetchManifest('zw_kv', 'key,updated_at');
      const pend = pendingIds('kv'); const known = ver.kv || {};
      const need = man.filter((m) => KV.indexOf(m.key) >= 0 && !pend.has(m.key) && !(known[m.key] === m.updated_at && m.key in cache)).map((m) => m.key);
      let fresh = [];
      if (need.length) { const { data, error } = await client().from('zw_kv').select('key,value,updated_at').in('key', need); if (error) throw error; fresh = data; }
      return { man, fresh };
    }
    // ---- device cache: server-confirmed rows kept in IndexedDB per user, so reopening the app does not re-download everything ----
    const LDB = 'zuuwa-cloud-cache'; let persistT = null;
    const ldb = () => new Promise((res) => { if (!window.indexedDB) return res(null); let r; try { r = indexedDB.open(LDB, 1); } catch (_) { return res(null); } r.onupgradeneeded = () => { try { r.result.createObjectStore('c'); } catch (_) {} }; r.onsuccess = () => res(r.result); r.onerror = () => res(null); r.onblocked = () => res(null); });
    async function loadDevice(u) {
      const db = await ldb(); if (!db) return null;
      return new Promise((res) => { try { const q = db.transaction('c', 'readonly').objectStore('c').get(u); q.onsuccess = () => { db.close(); res(q.result || null); }; q.onerror = () => { db.close(); res(null); }; } catch (_) { db.close(); res(null); } });
    }
    function persistSoon() { clearTimeout(persistT); persistT = setTimeout(persistNow, 1500); }
    async function persistNow() {
      const u = uid; if (!u) return;
      const pk = (k) => pendingIds(k); const out = { v: 1, savedAt: Date.now(), tables: {}, kv: {} };
      Object.keys(TABLES).forEach((k) => { const p = pk(k); const vv = ver[k] || {}; out.tables[k] = (cache[k] || []).filter((r) => r && !p.has(r.id) && vv[r.id]).map((r) => ({ id: r.id, updated_at: vv[r.id], data: r })); });
      const pkv = pk('kv'); KV.forEach((k) => { if (k in cache && !pkv.has(k) && ver.kv && ver.kv[k]) out.kv[k] = { value: cache[k], updated_at: ver.kv[k] }; });
      const db = await ldb(); if (!db || uid !== u) { if (db) db.close(); return; }
      try { const t = db.transaction('c', 'readwrite'); t.objectStore('c').put(out, u); t.oncomplete = () => db.close(); t.onerror = () => db.close(); } catch (_) { db.close(); }
    }
    async function forgetDevice(u) { clearTimeout(persistT); const db = await ldb(); if (!db) return; try { const t = db.transaction('c', 'readwrite'); t.objectStore('c').delete(u); t.oncomplete = () => db.close(); t.onerror = () => db.close(); } catch (_) { db.close(); } }
    function mergeTable(key, rows) {
      const pend = pendingIds(key); const local = cache[key] || []; const byId = new Map(local.map((r) => [r.id, r]));
      const next = []; const seen = new Set();
      onServer[key] = new Set(rows.map((r) => r.id)); ver[key] = {}; rows.forEach((r) => { ver[key][r.id] = r.updated_at; });
      rows.forEach((row) => { seen.add(row.id); if (pend.has(row.id)) { if (byId.has(row.id)) next.push(byId.get(row.id)); return; } next.push(row.data); snap[key][row.id] = JSON.stringify(row.data); });
      local.forEach((r) => { if (!seen.has(r.id) && pend.has(r.id)) next.push(r); });
      Object.keys(snap[key]).forEach((id) => { if (!seen.has(id) && !pend.has(id)) delete snap[key][id]; });
      cache[key] = next;
    }
    async function pullAll() {
      const keys = Object.keys(TABLES);
      const [res, kv] = await Promise.all([Promise.all(keys.map((k) => pullTable(k))), pullKv()]);
      keys.forEach((k, n) => { snap[k] = snap[k] || {}; mergeTable(k, res[n]); });
      const fresh = new Map(kv.fresh.map((d) => [d.key, d])); const listed = new Set(kv.man.map((m) => m.key));
      ver.kv = {}; kv.man.forEach((d) => { ver.kv[d.key] = d.updated_at; });
      const pendKv = pendingIds('kv');
      KV.forEach((k) => { if (pendKv.has(k)) return; const f = fresh.get(k); if (f) { cache[k] = f.value; snap.kv[k] = JSON.stringify(f.value); } else if (!listed.has(k)) { delete cache[k]; delete snap.kv[k]; } });
      try { const st = cache.settings; localStorage.setItem('zuuwa.loginImages', JSON.stringify((st && st.loginImages) || {})); } catch (_) {}
      setStatus({ lastSync: Date.now() }); emit('*'); persistSoon();
    }
    // ---- push ----
    const isNetwork = (e) => !e || !e.code || /fetch|network|Failed to fetch|Load failed/i.test(String(e.message || e));
    function friendly(e) {
      const m = String((e && (e.message || e.details)) || e || '');
      if (e && e.code === '23505') return 'That document number is already used. Please use a different number.';
      if (e && e.code === '23503') return 'This record is still linked to other documents and cannot be changed or deleted.';
      if (e && (e.code === '42501' || /row-level security/i.test(m))) return m && !/row-level/i.test(m) ? m : 'You do not have permission to make this change.';
      return m || 'Could not save to the cloud.';
    }
    async function revert(op) {
      try {
        if (op.key === 'kv') { const { data } = await client().from('zw_kv').select('value,updated_at').eq('key', op.id).maybeSingle(); ver.kv = ver.kv || {}; if (data) { cache[op.id] = data.value; snap.kv[op.id] = JSON.stringify(data.value); ver.kv[op.id] = data.updated_at; } else { delete cache[op.id]; delete snap.kv[op.id]; delete ver.kv[op.id]; } }
        else {
          const { data } = await client().from(TABLES[op.key]).select('id,data,updated_at').eq('id', op.id).maybeSingle(); ver[op.key] = ver[op.key] || {};
          const list = (cache[op.key] || []).filter((r) => r.id !== op.id); if (data) { list.push(data.data); snap[op.key][op.id] = JSON.stringify(data.data); ver[op.key][op.id] = data.updated_at; (onServer[op.key] = onServer[op.key] || new Set()).add(op.id); } else { delete snap[op.key][op.id]; delete ver[op.key][op.id]; }
          cache[op.key] = list;
        }
        emit(op.key === 'kv' ? op.id : op.key); persistSoon();
      } catch (_) {}
    }
    // A new document whose number was taken on another device gets the next free number automatically.
    async function renumber(op) {
      const kind = { quotations: 'quotation', invoices: 'invoice', receipts: 'receipt' }[op.key]; if (!kind || op.type !== 'upsert') return false;
      if (onServer[op.key] && onServer[op.key].has(op.id)) return false;
      mergeTable(op.key, await pullTable(op.key));
      const rec = (cache[op.key] || []).find((r) => r.id === op.id); if (!rec) return false;
      const others = { ...rec, id: rec.id }; let num;
      if (kind === 'invoice') num = rec.parentInvoiceId ? numberingService.suggestLinkedInvoice(rec.parentInvoiceId, rec.id).number : numberingService.suggestInvoice({ date: rec.date || todayISO(), quotationId: rec.quotationId, excludeId: rec.id });
      else num = numberingService.suggestSeq(kind, rec.date || todayISO());
      if (!num || num === rec.number) return false;
      const old = rec.number; const upd = { ...others, number: num };
      cache[op.key] = cache[op.key].map((r) => (r.id === rec.id ? upd : r)); op.row = rowOf(op.key, upd);
      emit(op.key); onErr('Number ' + old + ' was already used on another device. Saved as ' + num + ' instead.');
      return true;
    }
    const LABEL = { customers: 'This customer', quotations: 'This quotation', invoices: 'This invoice', payments: 'This payment', receipts: 'This receipt', warranties: 'This warranty letter', kv: 'Settings' };
    async function rowExists(key, id) { const { data } = await client().from(TABLES[key]).select('id').eq('id', id).maybeSingle(); return !!data; }
    async function whoChanged(key, id) {
      let by = '', gone = false;
      try {
        if (key === 'kv') { const { data } = await client().from('zw_kv').select('updated_by').eq('key', id).maybeSingle(); gone = !data; if (data && data.updated_by) by = ((authService.users ? authService.users() : []).find((p) => p.userId === data.updated_by) || {}).name || ''; }
        else { const { data } = await client().from(TABLES[key]).select('data').eq('id', id).maybeSingle(); gone = !data; by = (data && data.data && data.data.lastModifiedBy) || ''; }
      } catch (_) {}
      const what = key === 'kv' && id === 'settings' ? 'Settings were' : (LABEL[key] || 'This record') + ' was';
      return { message: gone ? what.replace(/ (was|were)$/, '') + ' has been deleted on another device.' : what + ' updated ' + (by ? 'by ' + by + ' ' : '') + 'on another device since you opened it.' };
    }
    // The shared numbering counters are merged (highest wins) instead of rejected, so numbering never blocks.
    async function mergeCounters(op) {
      for (let tries = 0; tries < 3; tries++) {
        const { data } = await client().from('zw_kv').select('value,updated_at').eq('key', 'counters').maybeSingle();
        const cur = (data && data.value) || {}; const mine = op.value || {}; const out = { ...cur };
        Object.keys(mine).forEach((kind) => { const a = { ...(cur[kind] || {}) }; Object.entries(mine[kind] || {}).forEach(([p, v]) => { const x = a[p]; a[p] = x == null ? v : (typeof v === 'number' || typeof x === 'number' ? Math.max(Number(x) || 0, Number(v) || 0) : String(v) > String(x) ? v : x); }); out[kind] = a; });
        const T = client().from('zw_kv'); const r = data ? await T.update({ value: out }).eq('key', 'counters').eq('updated_at', data.updated_at).select('updated_at') : await T.insert({ key: 'counters', value: out }).select('updated_at');
        if (!r.error && r.data && r.data.length) { cache.counters = out; snap.kv.counters = JSON.stringify(out); (ver.kv = ver.kv || {}).counters = r.data[0].updated_at; emit('counters'); return; }
      }
      throw new Error('Could not update the numbering counters.');
    }
    // A rejected (conflicting) change is kept on this device for recovery — the last 10 only.
    function keepRejected(op) { try { const k = 'zuuwa.conflicts'; const list = JSON.parse(localStorage.getItem(k) || '[]'); list.unshift({ at: new Date().toISOString(), key: op.key, id: op.id, type: op.type, data: op.row ? op.row.data : op.value }); localStorage.setItem(k, JSON.stringify(list.slice(0, 10))); } catch (_) {} }
    async function flush() {
      if (flushing || !uid || halted) return; flushing = true; clearTimeout(retryT);
      try {
        while (queue.length) {
          const op = queue[0]; op.inflight = true; setStatus({ state: 'saving' });
          let error = null;
          let conflict = null;
          try {
            const base = op.base || (op.afterOwn ? verOf(op.key, op.id) : null) || null;
            if (op.key === 'kv') {
              const T = client().from('zw_kv');
              if (op.type === 'delete') { const r = await (base ? T.delete().eq('key', op.id).eq('updated_at', base) : T.delete().eq('key', op.id)).select('key,updated_at'); error = r.error; if (!error && base && !r.data.length) conflict = await whoChanged('kv', op.id); }
              else if (base) { const r = await T.update({ value: op.value }).eq('key', op.id).eq('updated_at', base).select('key,updated_at'); error = r.error; if (!error && !r.data.length) conflict = await whoChanged('kv', op.id); else if (!error) (ver.kv = ver.kv || {})[op.id] = r.data[0].updated_at; }
              else { const r = await T.insert({ key: op.id, value: op.value }).select('key,updated_at'); error = r.error; if (error && error.code === '23505') { error = null; conflict = await whoChanged('kv', op.id); } else if (!error) (ver.kv = ver.kv || {})[op.id] = r.data[0].updated_at; }
              if (conflict && op.id === 'counters') { await mergeCounters(op); conflict = null; }
            }
            else if (op.type === 'delete') {
              const T = client().from(TABLES[op.key]); const r = await (base ? T.delete().eq('id', op.id).eq('updated_at', base) : T.delete().eq('id', op.id)).select('id'); error = r.error;
              if (!error && base && !r.data.length) conflict = await whoChanged(op.key, op.id);
            }
            else {
              const T = client().from(TABLES[op.key]); let r;
              if (base) { r = await T.update(op.row).eq('id', op.id).eq('updated_at', base).select('id,data,updated_at'); error = r.error; if (!error && !r.data.length) conflict = await whoChanged(op.key, op.id); }
              else { r = await T.insert(op.row).select('id,data,updated_at'); error = r.error; if (error && error.code === '23505' && (await rowExists(op.key, op.id))) { error = null; conflict = await whoChanged(op.key, op.id); } }
              const got = !error && !conflict && r && r.data && r.data[0];
              if (got) { (onServer[op.key] = onServer[op.key] || new Set()).add(op.id); (ver[op.key] = ver[op.key] || {})[op.id] = got.updated_at; snap[op.key][op.id] = JSON.stringify(got.data); const pendLater = queue.slice(1).some((o) => o.key === op.key && o.id === op.id); if (!pendLater) { cache[op.key] = (cache[op.key] || []).map((x) => (x.id === op.id ? got.data : x)); emit(op.key); } }
            }
          } catch (e) { error = e; }
          op.inflight = false;
          if (!error && conflict) {
            queue.shift(); queue = queue.filter((o) => !(o.key === op.key && o.id === op.id)); saveQueue(); keepRejected(op);
            onErr(conflict.message + ' Your change was not saved, so nothing was overwritten. The latest version is now shown — please check it and make your change again.');
            await revert(op); continue;
          }
          if (error && halted) { saveQueue(); setStatus(halted === 'restricted' ? { state: 'restricted', message: RESTRICTED_MSG + ' Your changes are kept on this device.' } : { state: 'auth', message: AUTH_MSG }); return; }
          if (error && isNetwork(error)) { saveQueue(); const wait = FLUSH_BACKOFF[Math.min(flushFails, FLUSH_BACKOFF.length - 1)]; flushFails++; setStatus({ state: 'offline', message: 'Not connected — changes are kept on this device and will be sent automatically.' }); retryT = setTimeout(flush, wait); return; }
          if (error && error.code === '23505' && (await renumber(op).catch(() => false))) { saveQueue(); continue; }
          queue.shift(); saveQueue();
          if (error) { const msg = friendly(error); status.failed.push({ at: Date.now(), message: msg }); onErr(msg + ' The change was not saved.'); await revert(op); }
        }
        flushFails = 0; setStatus({ state: 'saved', lastSync: Date.now(), message: '' }); persistSoon();
      } finally { flushing = false; }
    }
    function write(k, v) {
      if (!uid) return;
      if (TABLES[k]) {
        const s = (snap[k] = snap[k] || {}); const ids = new Set();
        (v || []).forEach((r) => { ids.add(r.id); const js = JSON.stringify(r); if (s[r.id] !== js) { enqueue({ key: k, id: r.id, type: 'upsert', row: rowOf(k, r) }); s[r.id] = js; } });
        Object.keys(s).forEach((id) => { if (!ids.has(id)) { enqueue({ key: k, id, type: 'delete' }); delete s[id]; } });
      } else if (KV.indexOf(k) >= 0) {
        const js = v === undefined ? undefined : JSON.stringify(v);
        if (snap.kv[k] !== js) { enqueue({ key: 'kv', id: k, type: v === undefined ? 'delete' : 'upsert', value: v }); if (js === undefined) delete snap.kv[k]; else snap.kv[k] = js; }
      } else return;
      saveQueue(); flush();
    }
    function resetMemory() { Object.keys(cache).forEach((k) => delete cache[k]); Object.keys(onServer).forEach((k) => delete onServer[k]); Object.keys(ver).forEach((k) => delete ver[k]); Object.keys(TABLES).forEach((k) => (snap[k] = {})); snap.kv = {}; }
    resetMemory();
    async function start(userId) {
      uid = userId; loadQueue(); resetMemory();
      halted = ''; pullFails = 0; flushFails = 0; clearTimeout(backoffT); lastSyncAt = Date.now();
      // Device cache first: unchanged rows are not downloaded again.
      try {
        const dev = await loadDevice(userId);
        if (dev && dev.v === 1 && uid === userId) {
          Object.keys(TABLES).forEach((k) => { const rows = (dev.tables && dev.tables[k]) || []; cache[k] = rows.map((r) => r.data); ver[k] = {}; rows.forEach((r) => { ver[k][r.id] = r.updated_at; }); });
          ver.kv = {}; Object.entries(dev.kv || {}).forEach(([k, o]) => { if (KV.indexOf(k) >= 0) { cache[k] = o.value; ver.kv[k] = o.updated_at; } });
        }
      } catch (_) {}
      // Re-apply unsent changes from a previous session on this device on top of the server copy.
      await pullAll();
      queue.forEach((op) => { if (op.key === 'kv') { if (op.type === 'upsert') cache[op.id] = op.value; else delete cache[op.id]; return; } const list = (cache[op.key] || []).filter((r) => r.id !== op.id); if (op.type === 'upsert') list.push(op.row.data); cache[op.key] = list; });
      emit('*'); flush();
    }
    // Only a hidden → visible change counts; the pull itself is rate-limited by sync().
    let wasHidden = document.visibilityState === 'hidden';
    const onVisible = () => {
      if (document.visibilityState === 'hidden') { wasHidden = true; return; }
      if (!wasHidden) return; wasHidden = false;
      if (uid) sync('visible');
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', () => { if (!uid) return; if (queue.length) { flushFails = 0; flush(); } else sync('online'); });
    return {
      init: async () => {},
      backend: () => 'Supabase (' + CFG.supabaseUrl + ')',
      get: (k, d) => (k in cache ? cache[k] : d),
      set(k, v) { cache[k] = v; write(k, v); emit(k); },
      remove(k) { delete cache[k]; write(k, undefined); emit(k); },
      clearAll() {
        // Children before parents so the database's link protection accepts the deletes.
        ['warranties', 'receipts', 'payments'].forEach((k) => { cache[k] = []; write(k, []); });
        const roots = (cache.invoices || []).filter((i) => !i.parentInvoiceId); cache.invoices = roots; write('invoices', roots); cache.invoices = []; write('invoices', []);
        ['quotations', 'customers'].forEach((k) => { cache[k] = []; write(k, []); }); emit('*');
      },
      subscribe(f) { subs.add(f); return () => subs.delete(f); },
      onError(f) { onErr = f; },
      onStatus(f) { statusSubs.add(f); f({ ...status }); return () => statusSubs.delete(f); },
      status: () => ({ ...status, pending: queue.length }),
      // "Retry now": at most once per 30 s; sends unsent changes, otherwise a manual pull (3-min cooldown).
      retry() {
        const now = Date.now(); if (now - lastRetryAt < 30000) return Promise.resolve({ skipped: 'cooldown' }); lastRetryAt = now;
        if (halted === 'auth') return Promise.resolve({ error: 'auth' });
        if (queue.length) { if (halted === 'restricted') halted = ''; flushFails = 0; return flush(); }
        return sync('manual');
      },
      syncNow: () => sync('manual'),
      refresh: () => sync('force'),
      client, start,
      forgetDevice: () => (uid ? forgetDevice(uid) : Promise.resolve()),
      stop() { clearTimeout(persistT); uid = null; clearTimeout(retryT); clearTimeout(backoffT); halted = ''; lastSyncAt = 0; pullFails = 0; flushFails = 0; queue = []; resetMemory(); emit('*'); },
      hasUnsent: () => queue.length > 0,
    };
  })();
  const storageService = CLOUD ? cloudStore : localStore;

  // ---------- repositories ----------
  function createRepo(key, prefix) {
    const all = () => storageService.get(key, []);
    return {
      key,
      list: () => all(),
      get: (id) => (id ? all().find((r) => r.id === id) || null : null),
      find: (fn) => all().filter(fn),
      insert(rec) {
        const now = new Date().toISOString();
        const r = { ...rec, id: rec.id || uid(prefix), createdAt: rec.createdAt || now, updatedAt: now };
        if (TRACKED.indexOf(key) >= 0) { const u = rec.demo ? null : currentUser(); r.createdBy = u ? u.name : ''; r.createdById = u ? u.userId : ''; delete r.lastModifiedBy; delete r.lastModifiedById; }
        storageService.set(key, [...all(), r]); return r;
      },
      update(id, patch) {
        let out = null;
        if (TRACKED.indexOf(key) >= 0) { patch = { ...patch }; delete patch.createdBy; delete patch.createdById; const u = currentUser(); if (u) { patch.lastModifiedBy = u.name; patch.lastModifiedById = u.userId; } }
        const next = all().map((r) => (r.id === id ? (out = { ...r, ...patch, id, updatedAt: new Date().toISOString() }) : r));
        if (!out) throw new AppError('This document no longer exists.');
        storageService.set(key, next); return out;
      },
      remove(id) { storageService.set(key, all().filter((r) => r.id !== id)); },
      removeWhere(fn) { storageService.set(key, all().filter((r) => !fn(r))); },
    };
  }
  // Created By / Recorded By tracking. Set once on insert from the signed-in user and never overwritten on edit.
  const TRACKED = ['quotations', 'invoices', 'payments', 'receipts', 'warranties'];
  const currentUser = () => { try { return authService.current(); } catch (_) { return null; } };
  const requireAdmin = () => { if (!authService.isAdmin()) throw new AppError('Only an admin can do this.'); };
  const creatorOf = (d) => (d && d.createdBy) || 'Not Available';
  const repos = {
    customers: createRepo('customers', 'cus'), quotations: createRepo('quotations', 'qt'), invoices: createRepo('invoices', 'inv'),
    payments: createRepo('payments', 'pay'), receipts: createRepo('receipts', 'rct'), warranties: createRepo('warranties', 'war'),
  };

  // ---------- default settings ----------
  const PERIODS = ['1 month', '3 months', '1 year', '5 years', '10 years'];
  const CATS = [
    ['cat_coating', 'Coating', 'the waterproofing coating system applied to the treated surfaces'],
    ['cat_puinj', 'PU Injection', 'the polyurethane (PU) injection works carried out at the treated cracks, joints and leakage points'],
    ['cat_torch_in', 'Indoor Torch-On Membrane', 'the indoor torch-on membrane system installed at the treated wet areas (bathroom, kitchen, balcony or planter box)'],
    ['cat_torch_out', 'Outdoor Torch-On Membrane', 'the outdoor torch-on membrane system installed at the treated roof and exposed areas'],
    ['cat_cement', 'Cementitious Waterproofing', 'the cementitious waterproofing system applied to the treated area'],
    ['cat_polyurea', 'Polyurea', 'the polyurea waterproofing membrane applied to the treated area'],
    ['cat_pufoam', 'PU Foam', 'the spray polyurethane (PU) foam system applied to the treated roof area'],
    ['cat_sealant', 'Sealant', 'the PU sealant applied to the treated joints and gaps'],
    ['cat_roof', 'Roof Waterproofing', 'the roof waterproofing system installed at the treated roof area'],
    ['cat_other', 'Other', 'the waterproofing works carried out at the treated area'],
  ];
  const catWording = (desc, p) =>
    'We warrant ' + desc + ' against water leakage caused by defective materials and/or workmanship for a period of ' + p +
    ' from the date of completion of works. Should leakage occur within the treated area during this period, we shall inspect and carry out the necessary rectification at no additional cost, subject to the warranty terms and conditions.';
  const SCOPES = [
    ['js_torch', 'Torch-On Membrane Waterproofing', 'cat_torch_out', 'Supply and install 4mm polyester-reinforced APP torch-on membrane with 100mm overlaps, including bitumen primer coat and sealing at upturns and edges.', 120, 'm²', '5 years'],
    ['js_cement', 'Cementitious Waterproofing', 'cat_cement', 'Supply and apply two coats of polymer-modified cementitious waterproofing with reinforcement mesh at corners and joints.', 45, 'm²', '1 year'],
    ['js_puinj', 'PU Injection', 'cat_puinj', 'Drill injection ports along leaking cracks and inject hydrophobic polyurethane grout under pressure until refusal. Remove packers and patch holes.', 65, 'point', '1 year'],
    ['js_sealant', 'PU Sealant', 'cat_sealant', 'Rake out existing joint, install backer rod and apply single-component polyurethane sealant.', 18, 'm', '1 year'],
    ['js_bitu', 'Bituminous Coating', 'cat_coating', 'Apply two coats of rubberised bituminous waterproofing coating on prepared surface.', 35, 'm²', '1 year'],
    ['js_polyurea', 'Polyurea Waterproofing', 'cat_polyurea', 'Spray-applied pure polyurea membrane, 2mm nominal thickness, with primer. Suitable for exposed and trafficable roof areas.', 180, 'm²', '10 years'],
    ['js_pufoam', 'Spray PU Foam', 'cat_pufoam', 'Spray-applied closed-cell polyurethane foam, 25mm thick, with UV-resistant top coat for roof insulation and waterproofing.', 150, 'm²', '5 years'],
    ['js_fibre', 'Fibre Roof Waterproofing', 'cat_roof', 'Clean existing roof, apply fibre-reinforced acrylic waterproofing coating in two coats with fibre mesh at joints and bolt heads.', 55, 'm²', '5 years'],
    ['js_prep', 'Surface Preparation', 'cat_other', 'Hack loose screed, grind and clean surface, remove dust and debris, and patch uneven areas before waterproofing.', 12, 'm²', ''],
  ];
  const defaults = () => ({
    company: {
      name: 'ZUUWA WATERPROOFING VENTURES', regNo: '', address: 'No. 12, Jalan Perusahaan 3,\nTaman Industri Bukit Belimbing, 43000 Kajang, Selangor',
      phone: '+60 12-345 6789', email: 'admin@zuuwa.com.my', website: '', bankName: 'Maybank', bankAccountName: 'ZUUWA WATERPROOFING VENTURES',
      bankAccount: '5000 0000 0000', paymentDetails: 'Please use the document number as payment reference and send proof of payment via WhatsApp.',
      authorizedPerson: '', authorizedTitle: 'Director', logo: '', signature: '', stamp: '', stampX: 0, stampY: 0, stampSize: 100,
    },
    quotation: {
      validityDays: 30,
      footer: 'Thank you for considering ZUUWA Waterproofing Ventures. We look forward to working with you.',
      notes: 'Quantities are based on site inspection and measurement. Final billing will follow actual measurement upon completion.',
      terms: [
        { title: 'Work Scope', body: 'Works shall be carried out according to the job scope stated in this quotation. Any item not specifically stated is excluded.' },
        { title: 'Site Conditions', body: 'The client shall provide clear access to the work area, water and electricity supply, and ensure the area is free from furniture and obstructions before works begin. Treated areas must be left to cure as advised before use.' },
        { title: 'Additional Work', body: 'Any additional or variation works requested beyond this quotation will be quoted separately and must be confirmed in writing before execution.' },
        { title: 'Exclusions', body: 'This quotation excludes structural repair, plumbing and electrical works, removal or reinstatement of tiles and finishes (unless stated), repainting, scaffolding above two storeys, and authority permits.' },
        { title: 'Confirmation & Payment', body: 'Works will be scheduled upon receipt of the signed quotation and deposit payment. This quotation is valid until the date stated above; prices are subject to revision thereafter.' },
      ],
    },
    paymentTerms: [
      { id: 'pt_5050', name: '50/50', schedule: '50,50', wording: 'Payment Terms: 50% deposit upon confirmation of quotation and 50% balance upon completion of works.' },
      { id: 'pt_3070', name: '30/70', schedule: '30,70', wording: 'Payment Terms: 30% deposit upon confirmation of quotation and 70% balance upon completion of works.' },
      { id: 'pt_503020', name: '50/30/20', schedule: '50,30,20', wording: 'Payment Terms: 50% deposit upon confirmation, 30% during progress of works and 20% upon completion.' },
    ],
    categories: CATS.map(([id, name, desc]) => ({ id, name, wording: Object.fromEntries(PERIODS.map((p) => [p, catWording(desc, p)])) })),
    jobScopes: SCOPES.map(([id, name, category, description, rate, unit, warrantyPeriod]) => ({ id, name, category, description, rate, unit, warrantyPeriod, brand: '', warrantyWording: '', active: true })),
    units: ['m²', 'm', 'point', 'lot', 'nos', 'm³', 'day'],
    paymentMethods: ['Bank Transfer', 'DuitNow / QR', 'Online Banking', 'Cash', 'Cheque', 'Credit / Debit Card'],
    warranty: {
      periods: PERIODS.slice(),
      intro: 'We, {company}, hereby confirm that the waterproofing works described below have been completed at the above premises, and we provide the following warranty.',
      closing: 'Should leakage occur within the treated area during the warranty period, please notify us in writing quoting the warranty number above. Thank you for choosing {company}.',
      terms: [
        'This warranty is valid only upon full payment of the contract sum.',
        'The warranty covers water leakage within the treated area caused by defective materials and/or workmanship only.',
        'This warranty does not cover leakage or damage caused by structural movement, settlement or new cracks in the building structure, natural disasters, fire, vandalism or acts of third parties.',
        'This warranty shall be void if the treated area is altered, hacked, drilled, renovated or repaired by any other party without our written consent.',
        'Blocked drains, ponding due to inadequate falls, and damage from heavy loads or sharp objects are excluded.',
        'Claims must be notified in writing within 7 days of the leakage being discovered. Rectification is limited to the treated area and excludes consequential damage to finishes, furniture or belongings.',
        'This warranty is not transferable unless agreed in writing by the company.',
      ],
    },
    invoice: {
      dueDays: 14, notes: '',
      terms: [
        { title: 'Payment Due', body: 'Payment is due within {dueDays} days from the invoice date unless otherwise agreed in writing.' },
        { title: 'Payment Method', body: 'Payment shall be made by bank transfer or cheque payable to {company}. Please send proof of payment via WhatsApp or email with the invoice number as reference.' },
        { title: 'Warranty', body: 'The warranty letter will be issued upon full settlement of the contract sum. Coverage is subject to the terms stated in the warranty letter.' },
        { title: 'Additional Work', body: 'Additional or variation works not stated in the quotation will be billed separately.' },
        { title: 'Discrepancies', body: 'Any discrepancy in this invoice must be reported within 7 days from the invoice date, failing which the invoice shall be deemed correct.' },
      ],
    },
    receipt: { wording: 'Being payment received for waterproofing works.', footer: 'This receipt is valid subject to clearance of payment. Thank you for your payment.' },
    document: { currency: 'RM', dateFormat: 'DD/MM/YYYY', footer: 'ZUUWA WATERPROOFING VENTURES  ·  Waterproofing Specialist', showLogo: true },
    numbering: {
      quotation: { prefix: 'QT-', digits: 3, includePeriod: true },
      invoice: { prefix: 'ZWV-', digits: 2, mode: 'project' },
      receipt: { prefix: 'RC-', digits: 3, includePeriod: true },
      warranty: { prefix: '' },
    },
    loginImages: { main: '', img2: '', img3: '' },
  });

  // ---------- settingsService ----------
  const settingsService = {
    defaults,
    get() {
      const out = deepMerge(defaults(), storageService.get('settings', {}));
      out.jobScopes = (out.jobScopes || []).map((sc) => {
        const list = Array.isArray(sc.descriptions) ? sc.descriptions.map((x) => String(x || '').trim()).filter(Boolean) : String(sc.description || '').split('\n').map((x) => x.trim()).filter(Boolean);
        return { ...sc, descriptions: list, description: list.join('\n') };
      });
      return out;
    },
    save(next) {
      // Permission check at the data layer (also enforced in Supabase): settings are read-only for non-admins.
      if (!authService.isAdmin()) throw new AppError('Settings are read-only for your account. Only the admin can change settings.');
      next = { ...next }; delete next.auth; // passwords live in Supabase Auth only
      storageService.set('settings', next); return next;
    },
    category(id) { return this.get().categories.find((c) => c.id === id) || null; },
    scope(id) { return this.get().jobScopes.find((s) => s.id === id) || null; },
    periods() { return this.get().warranty.periods; },
  };

  // ---------- brandService (optional material brand per job scope) ----------
  const brandService = {
    parse: (v) => String(v || '').split(',').map((x) => x.trim()).filter((x, i, arr) => x && arr.indexOf(x) === i),
    forScope(scopeId) { const sc = settingsService.scope(scopeId); return sc ? this.parse(sc.brand) : []; },
    descriptionFor(scopeId, brand) {
      const sc = settingsService.scope(scopeId); const general = sc ? String(sc.description || '').trim() : ''; const b = String(brand || '').trim();
      if (!b) return general;
      return (general ? general + '\n' : '') + 'Material brand: ' + b;
    },
  };

  // ---------- formatting ----------
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const hundreds = (x) => { let s = ''; if (x >= 100) { s += ONES[Math.floor(x / 100)] + ' Hundred'; x %= 100; if (x) s += ' '; } if (x >= 20) { s += TENS[Math.floor(x / 10)]; if (x % 10) s += '-' + ONES[x % 10]; } else if (x) s += ONES[x]; return s; };
  const inWords = (x) => { if (!x) return 'Zero'; const parts = []; [[1e9, 'Billion'], [1e6, 'Million'], [1e3, 'Thousand'], [1, '']].forEach(([d, l]) => { const q = Math.floor(x / d); if (q) { parts.push(hundreds(q) + (l ? ' ' + l : '')); x %= d; } }); return parts.join(' '); };
  const fmt = {
    number: (n) => (num(n)).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    money(n) { return (settingsService.get().document.currency || 'RM') + ' ' + fmt.number(n); },
    qty: (n) => { const v = num(n); return Number.isInteger(v) ? String(v) : v.toLocaleString('en-MY', { maximumFractionDigits: 3 }); },
    date(iso) {
      if (!validDate(iso)) return '-';
      const [y, m, d] = iso.split('-'); const f = settingsService.get().document.dateFormat;
      if (f === 'D MMM YYYY') return parseInt(d, 10) + ' ' + MONTHS[parseInt(m, 10) - 1] + ' ' + y;
      if (f === 'YYYY-MM-DD') return iso;
      return d + '/' + m + '/' + y;
    },
    words(n) { const v = r2(n); const rm = Math.floor(v); const sen = Math.round((v - rm) * 100); return 'Ringgit Malaysia ' + inWords(rm) + (sen ? ' and Cents ' + inWords(sen) : '') + ' Only'; },
  };

  // ---------- calculations ----------
  const isLump = (it) => !!it && it.pricing === 'lump';
  const itemPoints = (it) => (Array.isArray(it && it.points) ? it.points.map((x) => String(x == null ? '' : x)) : String((it && it.description) || '').split('\n').map((x) => x.trim().replace(/^[•\-*·]\s*/, '')).filter(Boolean));
  const lineAmount = (it) => (isLump(it) ? r2(num(it.lumpSum)) : r2(num(it.qty) * num(it.rate)));
  const custName = (cu) => { cu = cu || {}; const n = String(cu.name || '').trim(), c = String(cu.company || '').trim(); return cu.type === 'company' ? (c || n) : (n || c); };
  function calcTotals(doc) {
    const lines = ((doc && doc.items) || []).map((it) => ({ ...it, amount: lineAmount(it) }));
    const subtotal = r2(lines.reduce((s, l) => s + l.amount, 0));
    const d = (doc && doc.discount) || {};
    const discount = d.enabled ? r2(d.type === 'amount' ? Math.min(Math.max(num(d.value), 0), subtotal) : (subtotal * Math.min(Math.max(num(d.value), 0), 100)) / 100) : 0;
    const afterDiscount = r2(subtotal - discount);
    const t = (doc && doc.tax) || {};
    const tax = t.enabled ? r2((afterDiscount * Math.max(num(t.rate), 0)) / 100) : 0;
    return { lines, subtotal, discount, afterDiscount, tax, total: r2(afterDiscount + tax) };
  }
  function validateItems(items, errs) {
    if (!items || !items.length) { errs.push('Please add at least one job scope / line item.'); return; }
    items.forEach((it, i) => {
      if (!String(it.name || '').trim()) errs.push('Line ' + (i + 1) + ': please select a job scope or enter a description.');
      if (isLump(it)) {
        if (!(num(it.lumpSum) > 0)) errs.push('Line ' + (i + 1) + ': please enter the lump sum amount.');
        if (String(it.qty == null ? '' : it.qty).trim() !== '' && num(it.qty) < 0) errs.push('Line ' + (i + 1) + ': quantity cannot be negative.');
        return;
      }
      if (!(num(it.qty) > 0)) errs.push('Line ' + (i + 1) + ': quantity must be greater than zero.');
      if (num(it.rate) < 0 || String(it.rate).trim() === '') errs.push('Line ' + (i + 1) + ': please enter a valid rate.');
    });
  }
  const cleanItem = (it) => ({ id: it.id || uid('li'), scopeId: it.scopeId || '', custom: !!it.custom, ...(it.additional ? { additional: true } : {}), name: String(it.name || '').trim(), ...(() => { const pts = itemPoints(it).map((x) => x.replace(/[ \t]+$/gm, '').trim()).filter(Boolean); return { points: pts, description: pts.map((x) => x.replace(/\s*\n\s*/g, ' ')).join('\n') }; })(), pricing: isLump(it) ? 'lump' : 'rate', lumpSum: isLump(it) ? String(r2(it.lumpSum)) : '', qty: String(it.qty == null ? '' : it.qty), unit: it.unit || '', rate: isLump(it) && String(it.rate == null ? '' : it.rate).trim() === '' ? '' : String(r2(it.rate)), categoryId: it.categoryId || '', warrantyPeriod: it.warrantyPeriod || '', ...(it.warrantyOverridden && !it.custom ? { warrantyOverridden: true } : {}), brand: it.custom ? '' : String(it.brand || '').trim() });

  // ---------- numberingService ----------
  const numberingService = {
    counters() { return storageService.get('counters', { quotation: {}, invoice: {}, receipt: {} }); },
    setCounters(c) { storageService.set('counters', c); },
    cfg(kind) { return settingsService.get().numbering[kind]; },
    repoFor(kind) { return { quotation: repos.quotations, invoice: repos.invoices, receipt: repos.receipts, warranty: repos.warranties }[kind]; },
    exists(kind, number, excludeId) { return !!number && this.repoFor(kind).list().some((r) => same(r.number, number) && r.id !== excludeId); },
    // Sequential numbers (quotation / receipt): PREFIX + YYYYMM- + NNN
    seqParts(kind, number) {
      const c = this.cfg(kind); const esc = (c.prefix || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const m = new RegExp('^' + esc + (c.includePeriod ? '(\\d{6})-' : '()') + '(\\d+)$', 'i').exec(String(number || '').trim());
      return m ? { period: m[1] || 'all', n: parseInt(m[2], 10) } : null;
    },
    suggestSeq(kind, date) {
      const c = this.cfg(kind); const period = c.includePeriod ? periodOf(date) : 'all';
      const counter = this.counters()[kind] || {};
      let n = Math.max(counter[period] || 0, ...this.repoFor(kind).list().map((r) => { const p = this.seqParts(kind, r.number); return p && p.period === period ? p.n : 0; }), 0) + 1;
      return (c.prefix || '') + (c.includePeriod ? period + '-' : '') + pad(n, c.digits || 3);
    },
    commitSeq(kind, number) {
      const p = this.seqParts(kind, number); if (!p) return;
      const all = this.counters(); const k = { ...(all[kind] || {}) }; k[p.period] = Math.max(k[p.period] || 0, p.n);
      this.setCounters({ ...all, [kind]: k });
    },
    // Invoice: PREFIX + YYYYMM + [A-Z] + NN
    parseInvoice(number) {
      const c = this.cfg('invoice'); const esc = (c.prefix || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const m = new RegExp('^' + esc + '(\\d{6})([A-Z])(\\d+)$', 'i').exec(String(number || '').trim());
      return m ? { period: m[1], letter: m[2].toUpperCase(), n: parseInt(m[3], 10) } : null;
    },
    formatInvoice(period, letter, n) { const c = this.cfg('invoice'); return (c.prefix || '') + period + letter + pad(n, c.digits || 2); },
    invoiceStatus(date) {
      const period = periodOf(date || todayISO());
      const used = {};
      repos.invoices.list().forEach((i) => { const p = this.parseInvoice(i.number); if (p && p.period === period) (used[p.letter] = used[p.letter] || []).push(p.n); });
      const last = (this.counters().invoice || {})[period] || '';
      const next = last ? String.fromCharCode(last.charCodeAt(0) + 1) : 'A';
      return { period, lastLetter: last, nextLetter: next > 'Z' ? '—' : next, letters: Object.keys(used).sort().map((l) => ({ letter: l, numbers: used[l].sort((a, b) => a - b).map((n) => this.formatInvoice(period, l, n)) })) };
    },
    suggestInvoice({ date, quotationId, excludeId, bump }) {
      const c = this.cfg('invoice'); const period = periodOf(date); bump = bump || 0;
      if (c.mode === 'project' && quotationId) {
        const mine = repos.invoices.list().filter((i) => i.quotationId === quotationId && i.id !== excludeId).map((i) => this.parseInvoice(i.number)).filter((p) => p && p.period === period);
        if (mine.length) {
          const letter = mine.map((p) => p.letter).sort().pop();
          const n = Math.max(...mine.filter((p) => p.letter === letter).map((p) => p.n)) + 1 + bump;
          return this.formatInvoice(period, letter, n);
        }
      }
      const last = (this.counters().invoice || {})[period] || '';
      const code = (last ? last.charCodeAt(0) + 1 : 65) + bump;
      if (code > 90) throw new AppError('All invoice letters (A–Z) for ' + period + ' have been used. Please adjust numbering in Settings.');
      return this.formatInvoice(period, String.fromCharCode(code), 1);
    },
    // Linked invoices: PARENT-2, PARENT-3 … (parent keeps its own number; never duplicates)
    rootInvoice(id) { let inv = repos.invoices.get(id); const seen = new Set(); while (inv && inv.parentInvoiceId && !seen.has(inv.id)) { seen.add(inv.id); const p = repos.invoices.get(inv.parentInvoiceId); if (!p) break; inv = p; } return inv || null; },
    // Non-admin users can never choose a document number: new documents get the system number, existing ones keep theirs.
    lockNumber(kind, doc) {
      if (authService.isAdmin()) return doc;
      const repo = this.repoFor(kind); const prev = doc.id ? repo.get(doc.id) : null;
      if (prev) return { ...doc, number: prev.number };
      let number;
      if (kind === 'quotation' || kind === 'receipt') number = this.suggestSeq(kind, doc.date || todayISO());
      else if (kind === 'invoice') number = doc.parentInvoiceId ? this.suggestLinkedInvoice(doc.parentInvoiceId, null).number : this.suggestInvoice({ date: doc.date || todayISO(), quotationId: doc.quotationId });
      else if (kind === 'warranty') { const inv = doc.invoiceId ? repos.invoices.get(doc.invoiceId) : null; if (!inv) throw new AppError('Please link an invoice so the warranty number can be assigned automatically.'); number = this.warrantyFromInvoice(inv.number); }
      else number = doc.number;
      return { ...doc, number };
    },
    suggestLinkedInvoice(parentId, excludeId) {
      const root = this.rootInvoice(parentId); if (!root) throw new AppError('The selected invoice no longer exists.');
      const base = String(root.number || '').trim().toUpperCase(); const esc = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); const re = new RegExp('^' + esc + '-(\\d+)$', 'i');
      let max = 1; repos.invoices.list().forEach((i) => { if (i.id === excludeId) return; const m = String(i.number || '').trim().match(re); if (m) max = Math.max(max, parseInt(m[1], 10)); });
      let n = max + 1; while (this.exists('invoice', base + '-' + n, excludeId)) n++;
      return { number: base + '-' + n, rootId: root.id };
    },
    commitInvoice(number) {
      const p = this.parseInvoice(number); if (!p) return;
      const all = this.counters(); const k = { ...(all.invoice || {}) };
      if (!k[p.period] || p.letter > k[p.period]) k[p.period] = p.letter;
      this.setCounters({ ...all, invoice: k });
    },
    resetInvoice(period) { requireAdmin(); const all = this.counters(); const k = { ...(all.invoice || {}) }; delete k[period]; this.setCounters({ ...all, invoice: k }); },
    warrantyFromInvoice(invNumber) {
      const c = this.cfg('invoice'); const w = this.cfg('warranty');
      let s = String(invNumber || '').trim(); if (c.prefix && s.toUpperCase().indexOf(c.prefix.toUpperCase()) === 0) s = s.slice(c.prefix.length);
      return s ? (w.prefix || '') + s : '';
    },
    rebuild() {
      const out = { quotation: {}, invoice: {}, receipt: {} };
      ['quotation', 'receipt'].forEach((k) => this.repoFor(k).list().forEach((r) => { const p = this.seqParts(k, r.number); if (p) out[k][p.period] = Math.max(out[k][p.period] || 0, p.n); }));
      repos.invoices.list().forEach((r) => { const p = this.parseInvoice(r.number); if (p && (!out.invoice[p.period] || p.letter > out.invoice[p.period])) out.invoice[p.period] = p.letter; });
      this.setCounters(out);
    },
  };

  // ---------- customerService ----------
  const customerService = {
    list: () => repos.customers.list().slice().sort((a, b) => a.name.localeCompare(b.name)),
    get: (id) => repos.customers.get(id),
    // Called when a document is saved. The saved master record is only changed when the user explicitly asks (opts.update).
    upsert(c, demo, opts) {
      opts = opts || {};
      const name = String((c && c.name) || '').trim() || String((c && c.company) || '').trim(); if (!name) return '';
      const rec = { name, company: c.company || '', type: c.type || '', address: c.address || '', phone: c.phone || '', email: c.email || '' };
      if (opts.id && repos.customers.get(opts.id)) { if (opts.update) repos.customers.update(opts.id, rec); return opts.id; }
      const hit = repos.customers.list().find((x) => same(x.name, name) && String(x.phone || '').replace(/\D/g, '') === String(rec.phone).replace(/\D/g, ''));
      if (hit) { if (opts.update) repos.customers.update(hit.id, rec); return hit.id; }
      return repos.customers.insert({ ...rec, demo: !!demo }).id;
    },
    blank: () => ({ id: null, type: 'company', name: '', company: '', address: '', phone: '', email: '' }),
    validate(c) {
      const errs = []; const t = (v) => String(v || '').trim();
      if (c.type === 'company' && !t(c.company)) errs.push('Company name is required.');
      if (c.type !== 'company' && !t(c.name)) errs.push('Customer name is required.');
      if (t(c.email) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t(c.email))) errs.push('Please enter a valid email address.');
      return errs;
    },
    // Master-data save from Customer Data. Existing documents keep their own snapshot and are never touched.
    save(c) {
      fail(this.validate(c)); const t = (v) => String(v || '').trim();
      const rec = { type: c.type || '', name: t(c.name) || t(c.company), company: t(c.company), address: String(c.address || '').trim(), phone: t(c.phone), email: t(c.email) };
      if (c.id && repos.customers.get(c.id)) return repos.customers.update(c.id, rec);
      return repos.customers.insert(rec);
    },
    remove(id) { repos.customers.remove(id); },
    usage(id) { const n = (r) => r.list().filter((d) => d.customerId === id).length; return n(repos.quotations) + n(repos.invoices); },
    // Read-only lookup of documents belonging to a saved customer. Uses the stored customerId first; documents saved
    // before Customer Data existed are matched by name/company + phone. Nothing is written back to any document.
    linkedDocuments(id) {
      const c = repos.customers.get(id); if (!c) return { quotations: [], invoices: [], receipts: [], warranties: [] };
      const norm = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      const digits = (v) => String(v || '').replace(/\D/g, '');
      const names = new Set([c.name, c.company].map(norm).filter(Boolean)); const ph = digits(c.phone);
      const byInfo = (nm, phone) => { const ns = (Array.isArray(nm) ? nm : [nm]).map(norm).filter(Boolean); if (!ns.some((n) => names.has(n))) return false; const p = digits(phone); return !(ph && p && ph !== p); };
      const owns = (d) => { if (d.customerId === id) return true; if (d.customerId && repos.customers.get(d.customerId)) return false; const cu = d.customer || {}; return byInfo([cu.name, cu.company], cu.phone); };
      const quotations = repos.quotations.list().filter(owns); const qIds = new Set(quotations.map((q) => q.id));
      const invoices = repos.invoices.list().filter((i) => owns(i) || (!i.customerId && i.quotationId && qIds.has(i.quotationId))); const iIds = new Set(invoices.map((i) => i.id));
      const receipts = repos.receipts.list().filter((r) => (r.invoiceId ? iIds.has(r.invoiceId) : byInfo((r.customer || {}).name, (r.customer || {}).phone)));
      const warranties = repos.warranties.list().filter((w) => (w.invoiceId && iIds.has(w.invoiceId)) || (w.quotationId && qIds.has(w.quotationId)) || (!w.invoiceId && !w.quotationId && byInfo(w.customerName, w.contactNo)));
      const byDate = (a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || '').localeCompare(a.createdAt || '');
      return { quotations: quotations.sort(byDate), invoices: invoices.sort(byDate), receipts: receipts.sort(byDate), warranties: warranties.sort(byDate) };
    },
    search(q) {
      const k = String(q || '').trim().toLowerCase(); const dk = k.replace(/\D/g, '');
      return this.list().filter((c) => !k || [c.name, c.company].some((v) => String(v || '').toLowerCase().includes(k)) || (dk.length >= 3 && String(c.phone || '').replace(/\D/g, '').includes(dk)) || String(c.phone || '').toLowerCase().includes(k));
    },
  };

  // ---------- quotationService ----------
  const quotationService = {
    WAITING: 'Approved — Waiting Payment', RECEIVED: 'Payment Received',
    statuses: ['Draft', 'Sent', 'Approved — Waiting Payment', 'Payment Received', 'Rejected', 'Expired'],
    list: () => repos.quotations.list(),
    get: (id) => repos.quotations.get(id),
    blankItem(scope) {
      if (!scope) return { id: uid('li'), scopeId: '', brand: '', custom: false, name: '', description: '', qty: '1', unit: 'm²', rate: '', categoryId: '', warrantyPeriod: '' };
      return { id: uid('li'), scopeId: scope.id, brand: '', custom: false, name: scope.name, description: scope.description, qty: '1', unit: scope.unit, rate: String(scope.rate), categoryId: scope.category, warrantyPeriod: scope.warrantyPeriod || '' };
    },
    customItem() { return { id: uid('li'), scopeId: '', custom: true, name: '', description: '', qty: '1', unit: 'lot', rate: '', categoryId: 'cat_other', warrantyPeriod: '' }; },
    blank() {
      const s = settingsService.get(); const date = todayISO();
      return {
        id: null, number: numberingService.suggestSeq('quotation', date), date, validUntil: addDays(date, s.quotation.validityDays), status: 'Draft',
        customerId: '', customer: { type: 'company', name: '', company: '', address: '', phone: '', email: '' }, project: { name: '', siteAddress: '' },
        items: [], discount: { enabled: false, type: 'percent', value: '' }, tax: { enabled: false, label: 'SST', rate: '8' },
        paymentTermId: (s.paymentTerms[0] || {}).id || '', notes: s.quotation.notes, attachments: [],
      };
    },
    totals: calcTotals,
    payments: (id) => repos.payments.find((p) => p.quotationId === id).sort(byDateAsc),
    received(id) { return r2(this.payments(id).reduce((s, p) => s + num(p.amount), 0)); },
    status(q) {
      if (!q) return '';
      if (q.id && this.received(q.id) > 0) return this.RECEIVED;
      if (q.status === 'Approved') return this.WAITING;
      const base = q.status || 'Draft';
      if ((base === 'Draft' || base === 'Sent') && validDate(q.validUntil) && q.validUntil < todayISO()) return 'Expired';
      return base;
    },
    remark(q) {
      if (this.status(q) !== 'Expired') return '';
      const d = new Date(); d.setMonth(d.getMonth() - 6);
      const six = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      return validDate(q.date) && q.date < six ? 'This quotation has expired and is more than 6 months old.' : 'Quotation has expired.';
    },
    summary(q) {
      const total = calcTotals(q).total; const received = q.id ? this.received(q.id) : 0; const billed = q.id ? invoiceService.billedForQuotation(q.id) : 0;
      return { total, received, remaining: r2(Math.max(0, total - received)), billed, unbilled: r2(Math.max(0, total - billed)) };
    },
    paymentTerm(q) { return settingsService.get().paymentTerms.find((t) => t.id === q.paymentTermId) || null; },
    warrantyEntries(q) {
      const s = settingsService.get(); const groups = new Map();
      (q.items || []).forEach((it) => {
        const p = it.warrantyPeriod; if (!p || !String(it.name || '').trim()) return;
        const scope = s.jobScopes.find((x) => x.id === it.scopeId);
        const catId = it.categoryId || (scope && scope.category) || 'cat_other';
        const override = scope && String(scope.warrantyWording || '').trim();
        const key = override ? 'scope:' + scope.id + ':' + p : catId + ':' + p;
        if (!groups.has(key)) groups.set(key, { names: [], period: p, categoryId: catId, wording: override ? fill(override, { period: p, company: s.company.name }) : warrantyService.wordingFor(catId, p) });
        groups.get(key).names.push(it.name.trim());
      });
      return [...groups.values()].map((g) => { const c = s.categories.find((x) => x.id === g.categoryId); return { title: [...new Set(g.names)].join(', '), period: g.period, category: c ? c.name : 'Other', wording: g.wording }; });
    },
    termsSections(q) {
      // Payment Terms and Warranty sit directly under the "Confirmation & Payment" term (or at the end if there is no such term).
      const s = settingsService.get(); const out = []; const pt = this.paymentTerm(q);
      // A term's lines that start with "-", "•" or "*" print as bullet points; any plain text before them stays as an intro paragraph.
      const withBullets = (body) => {
        const lines = String(body || '').split('\n'); const isB = (l) => /^\s*[-•*]\s+/.test(l);
        if (!lines.some(isB)) return { body };
        const intro = []; const bullets = [];
        lines.forEach((l) => { if (isB(l)) bullets.push(l.replace(/^\s*[-•*]\s+/, '').trim()); else if (!l.trim()) return; else if (bullets.length) bullets[bullets.length - 1] += ' ' + l.trim(); else intro.push(l.trim()); });
        return { body, intro: intro.join('\n'), bullets };
      };
      s.quotation.terms.forEach((t) => { if (String(t.title || '').trim() || String(t.body || '').trim()) out.push({ title: t.title, ...withBullets(fill(t.body, { company: s.company.name })) }); });
      const extra = [];
      if (pt) {
        // Two bullets: the payment term itself, then where/how to pay (bank details + payment instructions from Settings → Company).
        const term = String(pt.wording || '').replace(/^\s*payment\s+terms?\s*[:\-–]\s*/i, '').trim();
        const c = s.company || {}; const bank = [c.bankName, c.bankAccountName, c.bankAccount ? 'Acc. No. ' + c.bankAccount : ''].filter((x) => String(x || '').trim()).join(' · ');
        const det = [bank ? 'Payment to: ' + bank + '.' : '', String(c.paymentDetails || '').trim()].filter(Boolean).join(' ');
        extra.push({ title: 'Payment Terms', body: pt.wording, bullets: det ? [term, det] : [term] });
      }
      const w = this.warrantyEntries(q);
      extra.push({ title: 'Warranty', body: w.length ? w.map((e) => e.title + ' — ' + e.period + ' (' + e.category + '): ' + e.wording).join('\n') : 'No warranty is provided for the works stated in this quotation.' });
      const norm = (x) => String(x || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z]/g, '');
      let at = out.findIndex((t) => norm(t.title) === 'confirmationandpayment');
      if (at < 0) at = out.findIndex((t) => /confirm/.test(norm(t.title)) && /payment/.test(norm(t.title)));
      out.splice(at < 0 ? out.length : at + 1, 0, ...extra);
      return out;
    },
    validate(q) {
      const errs = [];
      if (!String(q.number || '').trim()) errs.push('Quotation number is required.');
      if (!custName(q.customer)) errs.push((q.customer || {}).type === 'company' ? 'Company name is required.' : 'Customer name is required.');
      if (!validDate(q.date)) errs.push('Please enter a valid quotation date.');
      if (!validDate(q.validUntil)) errs.push('Please enter a valid "valid until" date.');
      else if (validDate(q.date) && q.validUntil < q.date) errs.push('"Valid until" cannot be earlier than the quotation date.');
      validateItems(q.items, errs);
      if (q.discount && q.discount.enabled && num(q.discount.value) < 0) errs.push('Discount cannot be negative.');
      (q.attachments || []).forEach((a, i) => { if (!a.image) errs.push('Attachment ' + (i + 1) + ' has no image.'); });
      return errs;
    },
    save(q) {
      q = numberingService.lockNumber('quotation', q);
      fail(this.validate(q));
      if (numberingService.exists('quotation', q.number, q.id)) throw new AppError('Quotation number already exists. Please generate another number.');
      const customerId = customerService.upsert(q.customer, q.demo, { id: q.customerId, update: !!q.updateCustomerRecord });
      const { updateCustomerRecord: _ucr, ...qq } = q;
      const rec = { ...qq, customerId, number: q.number.trim(), items: q.items.map(cleanItem), attachments: (q.attachments || []).map((a) => ({ id: a.id || uid('att'), title: String(a.title || '').trim(), image: a.image })), pdfAttachments: (q.pdfAttachments || []).filter((x) => x && x.data).map((x) => ({ id: x.id || uid('pdf'), title: String(x.title || '').trim(), name: x.name || '', size: x.size || 0, data: x.data })) };
      if (q.id && repos.quotations.get(q.id)) return repos.quotations.update(q.id, rec);
      delete rec.id; const out = repos.quotations.insert(rec); numberingService.commitSeq('quotation', out.number); return out;
    },
    setStatus(id, status) { return repos.quotations.update(id, { status }); },
    duplicate(id) {
      const q = this.get(id); if (!q) throw new AppError('Quotation not found.');
      const s = settingsService.get(); const date = todayISO();
      const { createdAt, updatedAt, demo, approvedAt, ...rest } = q;
      return this.save({ ...rest, id: null, number: numberingService.suggestSeq('quotation', date), date, validUntil: addDays(date, s.quotation.validityDays), status: 'Draft', items: q.items.map((i) => ({ ...i, id: uid('li') })) });
    },
    remove(id) { repos.payments.removeWhere((p) => p.quotationId === id && !p.invoiceId); repos.quotations.remove(id); },
  };

  // ---------- invoiceService ----------
  const invoiceService = {
    types: ['Full', 'Deposit', 'Progress', 'Balance'],
    list: () => repos.invoices.list(),
    get: (id) => repos.invoices.get(id),
    forQuotation: (qid) => repos.invoices.find((i) => i.quotationId === qid).sort(byCreated),
    billedForQuotation(qid, before) {
      return r2(this.forQuotation(qid).filter((i) => !before || (i.id !== before.id && (i.createdAt || '') < (before.createdAt || '\uffff'))).reduce((s, i) => s + num(i.amount), 0));
    },
    linkedQuotation(inv) { return inv && inv.quotationId ? repos.quotations.get(inv.quotationId) : null; },
    // Actual payments received on the quotation before this invoice (never this invoice's own payments, never counted twice).
    paidBefore(inv) {
      const qid = inv.quotationId; if (!qid) return 0; const skip = new Set(inv.applyPaymentIds || []); const own = inv.id || null; const cut = inv.createdAt || '';
      const invIds = new Set(this.forQuotation(qid).map((i) => i.id));
      const seen = new Set(); let s = 0;
      repos.payments.list().forEach((p) => {
        if (seen.has(p.id)) return; if (p.quotationId !== qid && !(p.invoiceId && invIds.has(p.invoiceId))) return;
        if (own && p.invoiceId === own) return; if (skip.has(p.id)) return; if (cut && (p.createdAt || '') >= cut) return;
        seen.add(p.id); s += num(p.amount);
      });
      return r2(s);
    },
    billing(inv) {
      const projectTotal = calcTotals(inv).total; const byPayments = !!this.linkedQuotation(inv);
      const previous = byPayments ? this.paidBefore(inv) : r2(Math.max(0, num(inv.previousBilled)));
      const available = r2(Math.max(0, projectTotal - previous));
      const amount = inv.type === 'Full' ? available : r2(inv.amount);
      const totalBilled = r2(previous + amount);
      return { projectTotal, previous, available, amount, totalBilled, byPayments, remaining: r2(Math.max(0, projectTotal - totalBilled)) };
    },
    payments: (inv) => (inv && inv.id ? repos.payments.find((p) => p.invoiceId === inv.id).sort(byDateAsc) : []),
    paid(inv) { return r2(this.payments(inv).reduce((s, p) => s + num(p.amount), 0)); },
    settledByQuotation(inv) { const q = this.linkedQuotation(inv); return !!q && this.paid(inv) > 0 && quotationService.summary(q).remaining <= EPS; },
    balanceDue(inv) { if (this.settledByQuotation(inv)) return 0; return r2(Math.max(0, num(inv.amount) - this.paid(inv))); },
    payStatus(inv) { const paid = this.paid(inv); const amt = num(inv.amount); if (amt > 0 && paid >= amt - EPS) return 'Paid'; if (this.settledByQuotation(inv)) return 'Paid'; if (paid > 0) return 'Partially Paid'; return 'Unpaid'; },
    unallocated: (qid) => repos.payments.find((p) => p.quotationId === qid && !p.invoiceId).sort(byDateAsc),
    schedule(q) { return String((quotationService.paymentTerm(q) || {}).schedule || '').split(/[,\/\s]+/).map(num).filter((n) => n > 0); },
    defaultAmount(inv) {
      const b = this.billing({ ...inv, type: 'Full' }); const q = this.linkedQuotation(inv); const t = b.projectTotal;
      const sched = q ? this.schedule(q) : [];
      let a;
      if (inv.type === 'Full' || inv.type === 'Balance') a = b.available;
      else if (inv.type === 'Deposit') { const un = q && !inv.id ? this.unallocated(q.id).reduce((s, p) => s + num(p.amount), 0) : 0; a = un > 0 ? un : (t * (sched[0] || 50)) / 100; }
      else a = sched.length >= 3 ? (t * sched[1]) / 100 : b.available / 2;
      return r2(Math.min(a, b.available));
    },
    fromQuotation(qid, type) {
      const q = quotationService.get(qid); if (!q) throw new AppError('Please select a quotation.');
      if (quotationService.status(q) === 'Rejected') throw new AppError('This quotation is marked Rejected. Change its status before invoicing.');
      const s = settingsService.get(); const date = todayISO();
      const avail = r2(calcTotals(q).total - quotationService.received(qid));
      if (avail <= EPS) throw new AppError('This quotation has already been fully paid.');
      const pt = quotationService.paymentTerm(q);
      const draft = {
        id: null, number: '', type: type || 'Deposit', date, dueDate: addDays(date, s.invoice.dueDays), quotationId: qid, quotationNumber: q.number,
        customerId: q.customerId, customer: { ...q.customer }, project: { ...q.project }, items: q.items.map((i) => ({ ...i })),
        discount: { ...q.discount }, tax: { ...q.tax }, previousBilled: '0', paymentTermText: pt ? pt.wording : '', notes: s.invoice.notes || '',
        applyPaymentIds: [], recordNow: false, recordMethod: s.paymentMethods[0] || 'Bank Transfer',
      };
      draft.number = numberingService.suggestInvoice({ date, quotationId: qid });
      draft.amount = String(this.defaultAmount(draft));
      draft.description = this.defaultDescription(draft);
      let room = num(draft.amount);
      this.unallocated(qid).forEach((p) => { if (num(p.amount) <= room + EPS) { draft.applyPaymentIds.push(p.id); room -= num(p.amount); } });
      return draft;
    },
    defaultDescription() {
      return '';
    },
    custom() {
      const s = settingsService.get(); const date = todayISO();
      return {
        id: null, number: numberingService.suggestInvoice({ date }), type: 'Full', date, dueDate: addDays(date, s.invoice.dueDays), quotationId: null, quotationNumber: '',
        customerId: '', customer: { name: '', company: '', address: '', phone: '', email: '' }, project: { name: '', siteAddress: '' },
        items: [quotationService.blankItem()], discount: { enabled: false, type: 'percent', value: '' }, tax: { enabled: false, label: 'SST', rate: '8' },
        amount: '', previousBilled: '0', paymentTermText: '', description: '', notes: s.invoice.notes || '', applyPaymentIds: [], recordNow: false, recordMethod: s.paymentMethods[0] || 'Bank Transfer',
      };
    },
    validate(inv) {
      const errs = [];
      if (!String(inv.number || '').trim()) errs.push('Invoice number is required.');
      else if (inv.parentInvoiceId) { const root = repos.invoices.get(inv.parentInvoiceId); if (!root) errs.push('The linked invoice no longer exists. Choose another invoice to link, or unlink it.'); else if (!new RegExp('^' + String(root.number).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-\\d+$', 'i').test(String(inv.number).trim())) errs.push('A linked invoice number must be ' + root.number + '-2, -3, … Tap Generate to fill it in.'); }
      else if (!numberingService.parseInvoice(inv.number)) errs.push('Invoice number must follow the format ' + numberingService.cfg('invoice').prefix + 'YYYYMM + letter + number (e.g. ' + numberingService.formatInvoice('202608', 'A', 1) + ').');
      if (!custName(inv.customer)) errs.push((inv.customer || {}).type === 'company' ? 'Company name is required.' : 'Customer name is required.');
      if (!validDate(inv.date)) errs.push('Please enter a valid invoice date.');
      if (!validDate(inv.dueDate)) errs.push('Please enter a valid due date.');
      else if (validDate(inv.date) && inv.dueDate < inv.date) errs.push('Due date cannot be earlier than the invoice date.');
      if (this.types.indexOf(inv.type) < 0) errs.push('Please select an invoice type.');
      validateItems(inv.items, errs);
      if (num(inv.previousBilled) < 0) errs.push('Previously billed amount cannot be negative.');
      const b = this.billing(inv);
      if (!(b.amount > 0)) errs.push('Invoice amount must be greater than zero.');
      else if (b.amount > b.available + EPS) errs.push('Invoice amount cannot be greater than the remaining contract balance (' + fmt.money(b.available) + ').');
      if (inv.id && b.amount < this.paid(inv) - EPS) errs.push('Invoice amount cannot be lower than payments already received (' + fmt.money(this.paid(inv)) + ').');
      return errs;
    },
    save(inv) {
      inv = numberingService.lockNumber('invoice', inv);
      fail(this.validate(inv));
      if (inv.recordNow && RECEIVED_THROUGH.indexOf(inv.recordThrough) < 0) throw new AppError('Please select where the payment was received (Payment Received Through).');
      if (numberingService.exists('invoice', inv.number, inv.id)) throw new AppError('Invoice number already exists. Please generate another number.');
      const b = this.billing(inv);
      const { applyPaymentIds, recordNow, recordMethod, recordThrough, updateCustomerRecord, ...rest } = inv;
      const rec = { ...rest, number: inv.number.trim().toUpperCase(), amount: String(b.amount), previousBilled: String(b.previous), items: inv.items.map(cleanItem), customerId: customerService.upsert(inv.customer, inv.demo, { id: inv.customerId, update: !!updateCustomerRecord }) };
      let out;
      if (inv.id && repos.invoices.get(inv.id)) out = repos.invoices.update(inv.id, rec);
      else {
        delete rec.id; out = repos.invoices.insert(rec); numberingService.commitInvoice(out.number);
        let room = b.amount;
        (applyPaymentIds || []).forEach((pid) => { const p = repos.payments.get(pid); if (p && !p.invoiceId && num(p.amount) <= room + EPS) { repos.payments.update(pid, { invoiceId: out.id }); room -= num(p.amount); } });
        if (recordNow) { const due = this.balanceDue(out); if (due > 0) paymentService.record({ invoiceId: out.id, amount: due, date: out.date, method: recordMethod, receivedThrough: recordThrough, reference: 'Recorded with invoice', demo: inv.demo }); }
      }
      return out;
    },
    remove(id) {
      repos.payments.list().filter((p) => p.invoiceId === id).forEach((p) => { if (p.quotationId && repos.quotations.get(p.quotationId)) repos.payments.update(p.id, { invoiceId: null }); else repos.payments.remove(p.id); });
      repos.invoices.remove(id);
    },
  };

  // ---------- paymentService ----------
  const paymentService = {
    list: () => repos.payments.list(),
    outstandingFor({ quotationId, invoiceId }) {
      if (invoiceId) { const inv = invoiceService.get(invoiceId); if (!inv) throw new AppError('Invoice not found.'); let o = invoiceService.balanceDue(inv); const q = invoiceService.linkedQuotation(inv); if (q) o = Math.min(o, quotationService.summary(q).remaining); return r2(o); }
      if (quotationId) { const q = quotationService.get(quotationId); if (!q) throw new AppError('Quotation not found.'); return quotationService.summary(q).remaining; }
      throw new AppError('Payment must be linked to a quotation or invoice.');
    },
    record(input) {
      const errs = []; const raw = String(input.amount == null ? '' : input.amount).trim();
      if (!raw || isNaN(Number(raw.replace(/,/g, '')))) errs.push('Please enter a valid payment amount.');
      else if (num(raw) < 0) errs.push('Payment amount cannot be negative.');
      else if (!(num(raw) > 0)) errs.push('Payment amount must be greater than zero.');
      if (!validDate(input.date)) errs.push('Please enter a valid payment date.');
      if (!input.method) errs.push('Please select a payment method.');
      if (!input.demo && RECEIVED_THROUGH.indexOf(input.receivedThrough) < 0) errs.push('Please select where the payment was received (Payment Received Through).');
      fail(errs);
      const amount = r2(raw); const outstanding = this.outstandingFor(input);
      if (outstanding <= EPS) throw new AppError('This document is already fully paid.');
      if (amount > outstanding + EPS) throw new AppError('Payment amount cannot be greater than the outstanding balance.');
      if (input.quotationId && input.invoiceId && (invoiceService.get(input.invoiceId) || {}).quotationId !== input.quotationId) throw new AppError('The selected invoice does not belong to the selected quotation.');
      let quotationId = input.quotationId || null;
      if (input.invoiceId) quotationId = (invoiceService.get(input.invoiceId) || {}).quotationId || null;
      const p = repos.payments.insert({ quotationId, invoiceId: input.invoiceId || null, amount: String(amount), date: input.date, method: input.method, receivedThrough: input.receivedThrough || '', reference: String(input.reference || '').trim(), paymentType: input.paymentType || '', image: input.image || '', demo: !!input.demo });
      if (quotationId) { const q = repos.quotations.get(quotationId); if (q && q.status !== 'Approved') repos.quotations.update(quotationId, { status: 'Approved', approvedAt: input.date }); }
      return p;
    },
    get: (id) => repos.payments.get(id),
    all() { return repos.payments.list().slice().sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || '').localeCompare(a.createdAt || '')); },
    update(id, input) {
      const p = repos.payments.get(id); if (!p) throw new AppError('This payment record no longer exists.');
      const errs = []; const raw = String(input.amount == null ? '' : input.amount).trim();
      if (!raw || isNaN(Number(raw.replace(/,/g, '')))) errs.push('Please enter a valid payment amount.');
      else if (num(raw) < 0) errs.push('Payment amount cannot be negative.');
      else if (!(num(raw) > 0)) errs.push('Payment amount must be greater than zero.');
      if (!validDate(input.date)) errs.push('Please enter a valid payment date.');
      if (!input.method) errs.push('Please select a payment method.');
      if (RECEIVED_THROUGH.indexOf(input.receivedThrough) < 0) errs.push('Please select where the payment was received (Payment Received Through).');
      fail(errs);
      const amount = r2(raw); const old = num(p.amount); let cap = Infinity;
      const inv = p.invoiceId ? invoiceService.get(p.invoiceId) : null;
      if (inv) cap = Math.min(cap, num(inv.amount) - (invoiceService.paid(inv) - old));
      const q = p.quotationId ? repos.quotations.get(p.quotationId) : null;
      if (q) cap = Math.min(cap, calcTotals(q).total - (quotationService.received(q.id) - old));
      if (amount > r2(cap) + EPS) throw new AppError('Payment amount cannot be greater than the outstanding balance (' + fmt.money(Math.max(0, cap)) + ').');
      return repos.payments.update(id, { amount: String(amount), date: input.date, method: input.method, receivedThrough: input.receivedThrough, reference: String(input.reference || '').trim(), paymentType: input.paymentType || p.paymentType || '', image: input.image == null ? p.image || '' : input.image });
    },
    remove(id) {
      const p = repos.payments.get(id); repos.payments.remove(id);
      return p;
    },
  };

  // ---------- receiptService ----------
  const receiptService = {
    list: () => repos.receipts.list(),
    get: (id) => repos.receipts.get(id),
    eligibleInvoices: () => repos.invoices.list().filter((i) => invoiceService.payStatus(i) === 'Paid'),
    forInvoice: (invId) => repos.receipts.find((r) => r.invoiceId === invId),
    fromInvoice(invId) {
      const inv = invoiceService.get(invId); if (!inv) throw new AppError('Please select an invoice.');
      if (invoiceService.payStatus(inv) !== 'Paid') throw new AppError('A receipt can only be generated from a fully paid invoice.');
      const pays = invoiceService.payments(inv); const last = pays[pays.length - 1]; const s = settingsService.get();
      const date = last ? last.date : todayISO();
      return {
        id: null, number: numberingService.suggestSeq('receipt', date), date, invoiceId: inv.id, invoiceNumber: inv.number, quotationId: inv.quotationId || null,
        customer: { name: custName(inv.customer), address: inv.customer.address || '', phone: inv.customer.phone || '' }, amount: String(inv.amount),
        method: last ? last.method : s.paymentMethods[0], reference: pays.map((p) => p.reference).filter(Boolean).join(', '),
        description: (inv.type === 'Full' ? 'Full' : inv.type) + ' payment for waterproofing works' + (inv.project && inv.project.name ? ' — ' + inv.project.name : '') + ' (Invoice ' + inv.number + ').',
        status: 'Fully Paid',
      };
    },
    custom() {
      const s = settingsService.get(); const date = todayISO();
      return { id: null, number: numberingService.suggestSeq('receipt', date), date, invoiceId: '', invoiceNumber: '', quotationId: null, customer: { name: '', address: '', phone: '' }, amount: '', method: s.paymentMethods[0], reference: '', description: s.receipt.wording, status: 'Fully Paid' };
    },
    validate(r) {
      const errs = [];
      if (!String(r.number || '').trim()) errs.push('Receipt number is required.');
      if (!validDate(r.date)) errs.push('Please enter a valid receipt date.');
      if (!String((r.customer || {}).name || '').trim()) errs.push('Customer name is required.');
      if (!(num(r.amount) > 0)) errs.push(num(r.amount) < 0 ? 'Amount cannot be negative.' : 'Amount received must be greater than zero.');
      if (!r.method) errs.push('Please select a payment method.');
      if (r.invoiceId) { const inv = invoiceService.get(r.invoiceId); if (inv && num(r.amount) > invoiceService.paid(inv) + EPS) errs.push('Receipt amount cannot be greater than the amount paid on invoice ' + inv.number + ' (' + fmt.money(invoiceService.paid(inv)) + ').'); }
      return errs;
    },
    save(r) {
      r = numberingService.lockNumber('receipt', r);
      fail(this.validate(r));
      if (numberingService.exists('receipt', r.number, r.id)) throw new AppError('Receipt number already exists. Please generate another number.');
      const rec = { ...r, number: r.number.trim(), amount: String(r2(r.amount)) };
      if (r.id && repos.receipts.get(r.id)) return repos.receipts.update(r.id, rec);
      delete rec.id; const out = repos.receipts.insert(rec); numberingService.commitSeq('receipt', out.number); return out;
    },
    remove: (id) => repos.receipts.remove(id),
  };

  // ---------- warrantyService ----------
  const warrantyService = {
    list: () => repos.warranties.list(),
    get: (id) => repos.warranties.get(id),
    wordingFor(catId, period) {
      const s = settingsService.get(); const c = s.categories.find((x) => x.id === catId); const w = c && c.wording && c.wording[period];
      return w && String(w).trim() ? fill(w, { period, company: s.company.name }) : 'We warrant the waterproofing works carried out at the treated area against water leakage caused by defective materials and/or workmanship for a period of ' + period + ' from the date of completion.';
    },
    expiry: (w) => (validDate(w.startDate) && w.period ? addPeriod(w.startDate, w.period) : ''),
    types: [{ value: 'direct', label: 'Direct Warranty' }, { value: 'subcontractor', label: 'Subcontractor Warranty' }],
    party: () => ({ name: '', address: '', phone: '' }),
    // Single job scope for a warranty: choices are the lines stored on the linked quotation / invoice (by ID only).
    scopeKey: (it) => (it && it.scopeId ? it.scopeId : 'n:' + String((it && it.name) || '').trim().toLowerCase()),
    linkedScopes(w) {
      const out = []; const seen = new Set();
      const q = w && w.quotationId ? quotationService.get(w.quotationId) : null; const inv = w && w.invoiceId ? invoiceService.get(w.invoiceId) : null;
      [q, inv].forEach((doc) => (doc ? doc.items || [] : []).forEach((it) => {
        const name = String(it.name || '').trim() || ((it.scopeId && settingsService.scope(it.scopeId)) || {}).name || ''; if (!name) return;
        const key = this.scopeKey({ scopeId: it.scopeId, name }); if (seen.has(key)) return; seen.add(key);
        out.push({ key, scopeId: it.scopeId || '', name, categoryId: it.categoryId || '', warrantyPeriod: it.warrantyPeriod || '' });
      }));
      return { linked: !!(q || inv), list: out };
    },
    fromQuotation(qid) {
      const q = quotationService.get(qid); if (!q) throw new AppError('Please select a quotation.');
      const s = settingsService.get(); const invs = invoiceService.forQuotation(qid); const inv = invs[invs.length - 1];
      const item = q.items.find((i) => i.warrantyPeriod) || q.items[0] || {};
      const scope = s.jobScopes.find((x) => x.id === item.scopeId);
      const categoryId = item.categoryId || (scope && scope.category) || 'cat_other';
      const period = item.warrantyPeriod || (s.warranty.periods.indexOf('1 year') >= 0 ? '1 year' : s.warranty.periods[0]);
      const date = todayISO();
      return {
        id: null, number: inv ? numberingService.warrantyFromInvoice(inv.number) : '', invoiceId: inv ? inv.id : '', invoiceNumber: inv ? inv.number : '',
        quotationId: qid, quotationNumber: q.number, customerName: custName(q.customer), siteName: q.project.name || '', siteAddress: q.project.siteAddress || '',
        projectAddress: q.customer.address || '', contactNo: q.customer.phone || '', area: q.project.area || '', areaUnit: (inv && inv.project && inv.project.areaUnit) || q.project.areaUnit || '', scopeMode: scope ? 'predefined' : 'custom', scopeId: scope ? scope.id : '', scopeTitle: item.name || '',
        categoryId, period, date, startDate: '', wording: this.wordingFor(categoryId, period), wordingEdited: false,
        warrantyType: '', mainContractor: this.party(), applicator: this.party(),
      };
    },
    custom() {
      const s = settingsService.get(); const date = todayISO(); const categoryId = (s.categories[0] || {}).id || ''; const period = s.warranty.periods.indexOf('1 year') >= 0 ? '1 year' : s.warranty.periods[0];
      return { id: null, number: '', invoiceId: '', invoiceNumber: '', quotationId: '', quotationNumber: '', customerName: '', siteName: '', siteAddress: '', projectAddress: '', contactNo: '', area: '', scopeMode: 'predefined', scopeId: '', scopeTitle: '', categoryId, period, date, startDate: '', wording: this.wordingFor(categoryId, period), wordingEdited: false, warrantyType: '', mainContractor: this.party(), applicator: this.party() };
    },
    validate(w) {
      const errs = [];
      if (!String(w.number || '').trim()) errs.push('Warranty number is required. Link an invoice to use its serial, or enter it manually.');
      if (!String(w.customerName || '').trim()) errs.push('Customer name is required.');
      if (!String(w.siteAddress || '').trim() && !String(w.siteName || '').trim()) errs.push('Please enter the site / location.');
      if (!String(w.scopeTitle || '').trim()) errs.push('Please select or enter the work scope title.');
      if (w.scopeMode !== 'custom') { const L = this.linkedScopes(w); if (L.linked && !L.list.some((x) => x.key === this.scopeKey({ scopeId: w.scopeId, name: w.scopeTitle }))) errs.push('Please select a job scope that exists in the linked quotation / invoice.'); }
      if (!w.categoryId) errs.push('Please select a warranty category.');
      if (!w.period) errs.push('Please select a warranty period.');
      if (!validDate(w.date)) errs.push('Please enter a valid letter date.');
      if (!validDate(w.startDate)) errs.push('Please enter the warranty start date (actual work completion date).');
      if (w.warrantyType !== 'direct' && w.warrantyType !== 'subcontractor') errs.push('Please select the warranty type.');
      if (!String(w.wording || '').trim()) errs.push('Warranty wording cannot be empty.');
      return errs;
    },
    save(w) {
      w = numberingService.lockNumber('warranty', w);
      fail(this.validate(w));
      // Company stamp comes from Settings and is snapshotted when the letter is first created; later edits keep it.
      const prevW = w.id ? repos.warranties.get(w.id) : null; const co = settingsService.get().company;
      w = prevW ? { ...w, stamp: prevW.stamp || '', stampX: prevW.stampX, stampY: prevW.stampY, stampSize: prevW.stampSize } : { ...w, stamp: co.stamp || '', stampX: Number(co.stampX) || 0, stampY: Number(co.stampY) || 0, stampSize: Number(co.stampSize) || 100 };
      if (numberingService.exists('warranty', w.number, w.id)) throw new AppError('Warranty number already exists. Each warranty must use a unique invoice serial.');
      const rec = { ...w, number: w.number.trim().toUpperCase() };
      if (w.id && repos.warranties.get(w.id)) return repos.warranties.update(w.id, rec);
      delete rec.id; return repos.warranties.insert(rec);
    },
    remove: (id) => repos.warranties.remove(id),
  };

  // ---------- authService (Supabase Auth) ----------
  // Supabase Auth: roles come from the zw_profiles table (Anis = admin, Firdaus = user). The same role rules are
  // enforced again by the database (RLS policies and triggers), so the browser is not the only line of defence.
  const cloudAuth = (() => {
    let me = null; let people = []; const lostSubs = new Set(); let watching = false;
    // If Supabase ends the session (expired / failed refresh / signed out elsewhere), drop the user and tell the UI.
    const watch = () => {
      if (watching) return; watching = true;
      try { cloudStore.client().auth.onAuthStateChange((ev) => {
        // Only a real sign-out ends the session. INITIAL_SESSION / TOKEN_REFRESHED / USER_UPDATED never do.
        if (ev !== 'SIGNED_OUT' || !me) return;
        setTimeout(async () => {
          try { const { data } = await cloudStore.client().auth.getSession(); if (data && data.session) return; } catch (_) { return; } // still signed in (or offline) → keep the user
          if (!me) return; me = null; people = []; cloudStore.stop(); lostSubs.forEach((f) => { try { f(ev); } catch (_) {} });
        }, 0);
      }); } catch (_) {}
    };
    const loadProfiles = async (user) => {
      const sb = cloudStore.client();
      const { data, error } = await sb.from('zw_profiles').select('user_id,email,name,role'); if (error) throw error;
      people = data || []; const p = people.find((x) => x.user_id === user.id);
      if (!p) { await sb.auth.signOut(); throw new AppError('This account is not set up as a ZUUWA user. Ask the admin to run the setup step for this email.'); }
      me = { userId: p.user_id, role: p.role, name: p.name, email: p.email, username: p.email };
      return me;
    };
    return {
      cloud: true,
      users: () => people.map((p) => ({ userId: p.user_id, name: p.name, role: p.role, username: p.email })),
      isAdmin: () => !!me && me.role === 'admin',
      current: () => me,
      async restore() {
        const sb = cloudStore.client(); const { data } = await sb.auth.getSession(); const user = data && data.session && data.session.user;
        watch(); if (!user) return null;
        try { await loadProfiles(user); await cloudStore.start(me.userId); return me; } catch (e) { me = null; cloudStore.stop(); if (e instanceof AppError) throw e; return null; }
      },
      async login(email, password, remember) {
        if (!String(email || '').trim() || !password) throw new AppError('Please enter your email and password.');
        localStorage.setItem('zuuwa.remember', remember ? '1' : '0');
        const sb = cloudStore.client(); let res; watch();
        try { res = await sb.auth.signInWithPassword({ email: String(email).trim().toLowerCase(), password }); } catch (e) { throw new AppError('Could not reach the server. Check your internet connection and try again.'); }
        if (res.error) throw new AppError(/invalid/i.test(res.error.message) ? 'Incorrect email or password.' : res.error.message);
        await loadProfiles(res.data.user); await cloudStore.start(me.userId); return me;
      },
      onSessionLost(f) { lostSubs.add(f); return () => lostSubs.delete(f); },
      async logout() { try { await cloudStore.forgetDevice(); } catch (_) {} me = null; people = []; cloudStore.stop(); try { await cloudStore.client().auth.signOut(); } catch (_) {} },
    };
  })();
  // Authentication is Supabase Auth only. Without a Supabase configuration nobody can sign in.
  const noAuth = {
    cloud: false, users: () => [], isAdmin: () => false, current: () => null,
    restore: () => Promise.resolve(null),
    login() { return Promise.reject(new AppError('Sign-in is not available: Supabase is not configured (app/config.js).')); },
    logout: () => Promise.resolve(),
  };
  const authService = CLOUD ? cloudAuth : noAuth;

  // ---------- dashboardService ----------
  // ---------- financeService: contract tracking (read-only, from existing quotation → invoice → payment links) ----------
  // Contract balance = quotation total − all payments on the quotation. Invoice balance = invoice amount − payments on that invoice.
  const financeService = {
    S: { PAID: 'Fully Paid', DEP: 'Deposit Paid – Balance Invoice Required', BAL: 'Balance Due', UNPAID: 'Unpaid Invoice', NONE: 'No Invoice' },
    isContract(q) { const st = quotationService.status(q); return st === quotationService.WAITING || st === quotationService.RECEIVED || invoiceService.forQuotation(q.id).length > 0 || quotationService.received(q.id) > EPS; },
    contract(q) {
      const S = this.S; const sm = quotationService.summary(q); const invs = invoiceService.forQuotation(q.id);
      const rows = invs.map((i) => ({ inv: i, type: i.type || 'Full', amount: r2(num(i.amount)), paid: invoiceService.paid(i), balance: invoiceService.balanceDue(i), status: invoiceService.payStatus(i) }));
      const unpaid = rows.filter((r) => r.status !== 'Paid'); const balInvs = rows.filter((r) => r.type === 'Balance');
      let status;
      if (sm.total > EPS && sm.remaining <= EPS) status = S.PAID;
      else if (!invs.length) status = S.NONE;
      else if (unpaid.length) status = S.UNPAID;
      else if (rows.some((r) => r.type === 'Deposit') && !balInvs.length) status = S.DEP;
      else status = S.BAL;
      const balanceInvoice = (balInvs.find((r) => r.status !== 'Paid') || balInvs[balInvs.length - 1] || {}).inv || null;
      return { q, total: sm.total, invoiced: sm.billed, paid: sm.received, balance: sm.remaining, status, invoices: rows, unpaidInvoice: (unpaid[0] || {}).inv || null,
        balanceInvoice, canGenerateBalance: sm.remaining > EPS && !balInvs.length && !unpaid.length && !!invs.length && quotationService.status(q) !== 'Rejected' };
    },
    overview() {
      const S = this.S; const list = repos.quotations.list().filter((q) => this.isContract(q)).map((q) => this.contract(q));
      const order = [S.DEP, S.BAL, S.UNPAID, S.NONE, S.PAID];
      list.sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || (b.q.date || '').localeCompare(a.q.date || ''));
      const openInv = repos.invoices.list().filter((i) => invoiceService.payStatus(i) !== 'Paid');
      const count = (st) => list.filter((c) => c.status === st).length;
      return {
        list, outstanding: r2(list.filter((c) => c.status !== S.PAID).reduce((t, c) => t + c.balance, 0)), openContracts: list.filter((c) => c.status !== S.PAID).length,
        depositPaid: count(S.DEP), balanceDue: count(S.BAL), unpaid: count(S.UNPAID), fullyPaid: count(S.PAID), noInvoice: count(S.NONE),
        unpaidInvoices: openInv.length, unpaidInvoiceAmount: r2(openInv.reduce((t, i) => t + invoiceService.balanceDue(i), 0)),
      };
    },
  };
  const dashboardService = {
    summary() {
      const invs = repos.invoices.list(); const period = periodOf(todayISO());
      const open = invs.filter((i) => invoiceService.payStatus(i) !== 'Paid');
      const qs = repos.quotations.list().map((q) => [q, quotationService.status(q)]);
      const approved = qs.filter(([, st]) => st === quotationService.WAITING || st === quotationService.RECEIVED).map(([q]) => q);
      const sentCount = qs.filter(([q, st]) => (q.status && q.status !== 'Draft') || st === quotationService.RECEIVED).length;
      const waitingCount = qs.filter(([, st]) => st === quotationService.WAITING).length;
      const month = invs.filter((i) => periodOf(i.date) === period);
      return {
        outstandingCount: open.length, outstandingAmount: r2(open.reduce((s, i) => s + invoiceService.balanceDue(i), 0)),
        salesTotal: r2(invs.reduce((s, i) => s + num(i.amount), 0)), salesCount: invs.length,
        salesMonth: r2(month.reduce((s, i) => s + num(i.amount), 0)), salesMonthCount: month.length,
        approvedCount: approved.length, waitingCount, sentCount, approvedValue: r2(approved.reduce((s, q) => s + calcTotals(q).total, 0)),
        receivedTotal: r2(repos.payments.list().reduce((s, p) => s + num(p.amount), 0)),
      };
    },
  };

  // ---------- imageService ----------
  const imageService = {
    compress(file, opts) {
      opts = opts || {}; const max = opts.max || 1400; const type = opts.type || 'image/jpeg'; const q = opts.quality || 0.8;
      return new Promise((res, rej) => {
        if (!file) return rej(new AppError('No image selected.'));
        if (!/^image\//.test(file.type || '')) return rej(new AppError('Failed to upload "' + (file.name || 'file') + '". Please choose an image file (JPG or PNG).'));
        if (file.size > 25 * 1024 * 1024) return rej(new AppError('Image is too large (max 25MB).'));
        const fr = new FileReader();
        fr.onerror = () => rej(new AppError('Failed to read the image. Please try again.'));
        fr.onload = () => {
          const img = new Image();
          img.onerror = () => rej(new AppError('Failed to upload image. This photo format may not be supported — try JPG or PNG.'));
          img.onload = () => {
            const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
            const c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
            const ctx = c.getContext('2d'); if (type === 'image/jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); }
            ctx.drawImage(img, 0, 0, c.width, c.height);
            try { res(c.toDataURL(type, q)); } catch (e) { rej(new AppError('Failed to process the image.')); }
          };
          img.src = fr.result;
        };
        fr.readAsDataURL(file);
      });
    },
  };

  // ---------- demoService ----------
  const demoService = {
    loaded: () => repos.quotations.list().some((q) => q.demo) || repos.invoices.list().some((i) => i.demo),
    load() {
      if (this.loaded()) throw new AppError('Demo data is already loaded.');
      const s = settingsService.get(); const sc = (id) => s.jobScopes.find((x) => x.id === id);
      const item = (id, qty, rate) => { const base = sc(id) ? quotationService.blankItem(sc(id)) : quotationService.customItem(); return { ...base, qty: String(qty), ...(rate != null ? { rate: String(rate) } : {}) }; };
      const d = (n) => addDays(todayISO(), -n);
      const mkQ = (o) => { const b = quotationService.blank(); return quotationService.save({ ...b, ...o, demo: true, number: numberingService.suggestSeq('quotation', o.date), validUntil: addDays(o.date, s.quotation.validityDays) }); };
      const mkInv = (qid, type, date, amount) => { const dr = invoiceService.fromQuotation(qid, type); dr.date = date; dr.dueDate = addDays(date, s.invoice.dueDays); dr.number = numberingService.suggestInvoice({ date, quotationId: qid }); if (amount != null) dr.amount = String(amount); dr.description = invoiceService.defaultDescription(dr); dr.demo = true; return invoiceService.save(dr); };

      mkQ({ date: d(3), status: 'Sent', paymentTermId: 'pt_5050',
        customer: { name: 'Mr. Tan Wei Ming', company: '', address: 'No. 8, Jalan SS 2/24, 47300 Petaling Jaya, Selangor', phone: '012-338 4412', email: 'tanweiming@example.com' },
        project: { name: 'Bathroom & Balcony Leakage Repair', siteAddress: 'No. 8, Jalan SS 2/24, 47300 Petaling Jaya, Selangor' },
        items: [{ ...item('js_cement', 18), categoryId: 'cat_torch_in' }, item('js_puinj', 12)] });

      const q2 = mkQ({ date: d(24), status: 'Sent', paymentTermId: 'pt_3070',
        customer: { name: 'Nurul Aina binti Hassan', company: 'Seri Mutiara Property Management Sdn. Bhd.', address: 'Level 3, Menara Seri Mutiara, Jalan Tun Razak, 50400 Kuala Lumpur', phone: '013-772 9081', email: 'aina@serimutiara.example.my' },
        project: { name: 'Rooftop Waterproofing — Block B', siteAddress: 'Block B, Residensi Seri Mutiara, Jalan Kuching, 51200 Kuala Lumpur' },
        items: [item('js_torch', 70), item('js_puinj', 20), item('js_prep', 25)] });
      paymentService.record({ quotationId: q2.id, amount: 3000, date: d(20), method: 'Bank Transfer', reference: 'IBG 778120 — deposit', demo: true });
      mkInv(q2.id, 'Deposit', d(20), 3000);
      const i2 = mkInv(q2.id, 'Progress', d(10), 2000);
      paymentService.record({ invoiceId: i2.id, amount: 2000, date: d(8), method: 'Online Banking', reference: 'FPX 55120931', demo: true });
      const i3 = mkInv(q2.id, 'Balance', d(3));
      paymentService.record({ invoiceId: i3.id, amount: i3.amount, date: d(1), method: 'Bank Transfer', reference: 'IBG 781554 — balance', demo: true });
      receiptService.save({ ...receiptService.fromInvoice(i3.id), demo: true });
      const w = warrantyService.fromQuotation(q2.id); w.startDate = d(3); w.warrantyType = 'direct'; warrantyService.save({ ...w, demo: true });

      const q3 = mkQ({ date: d(15), status: 'Sent', paymentTermId: 'pt_503020',
        customer: { name: 'Encik Hafiz Rahman', company: 'Kilang Perabot Jaya Sdn. Bhd.', address: 'Lot 22, Jalan Industri 5, Kawasan Perindustrian Nilai, 71800 Nilai, Negeri Sembilan', phone: '019-221 6634', email: 'hafiz@perabotjaya.example.my' },
        project: { name: 'Factory Metal Deck Roof', siteAddress: 'Lot 22, Jalan Industri 5, 71800 Nilai, Negeri Sembilan' },
        items: [item('js_fibre', 400), item('js_sealant', 120)], discount: { enabled: true, type: 'amount', value: '160' } });
      const i4 = mkInv(q3.id, 'Deposit', d(12));
      paymentService.record({ invoiceId: i4.id, amount: 5000, date: d(9), method: 'Cheque', reference: 'PBB cheque 004512', demo: true });

      const c = invoiceService.custom();
      invoiceService.save({ ...c, demo: true, date: d(5), dueDate: addDays(d(5), s.invoice.dueDays), number: numberingService.suggestInvoice({ date: d(5) }),
        customer: { name: 'Puan Rohana Ismail', company: '', address: 'No. 3, Jalan Mawar 2, Taman Bukit Mewah, 43000 Kajang, Selangor', phone: '017-650 1180', email: '' },
        project: { name: 'Window Frame Sealant', siteAddress: 'No. 3, Jalan Mawar 2, Taman Bukit Mewah, 43000 Kajang' },
        items: [item('js_sealant', 30), { ...item('js_cement', 10) }] });
    },
    remove() {
      Object.values(repos).forEach((r) => r.removeWhere((x) => x.demo));
      numberingService.rebuild();
    },
  };

  const resetAll = () => { requireAdmin(); storageService.clearAll(); };

  // Suggested photo caption from the document itself: the job scope(s) and project. Used when a photo has no title; always editable.
  const autoCaption = (d) => {
    const names = []; ((d && d.items) || []).forEach((it) => { const n = String((it && it.name) || '').trim(); if (n && names.indexOf(n) < 0) names.push(n); });
    const proj = String(((d && d.project) || {}).name || '').trim();
    const what = names.length === 1 ? names[0] : names.length > 1 ? names[0] + ' & ' + (names.length === 2 ? names[1] : 'Other Works') : '';
    return (what ? what + ' — ' : '') + 'Existing Site Condition' + (proj && !what ? ' — ' + proj : '');
  };
  ZW.util = { uid, num, r2, todayISO, addDays, addPeriod, validDate, periodOf, fill };
  Object.assign(ZW, {
    AppError, storageService, repos, settingsService, brandService, numberingService, customerService, quotationService, invoiceService, paymentService,
    receiptService, warrantyService, authService, creatorOf, dashboardService, financeService, imageService, demoService, fmt, calcTotals, resetAll, itemPoints, custName, autoCaption,
  });
  // ---------- one-time settings import (old device IndexedDB → Supabase zw_kv 'settings') ----------
  // Reads the pre-Supabase IndexedDB copy read-only; never modifies or deletes it. Admin only.
  // Order-independent comparison (Postgres jsonb does not keep object key order).
  const canonJson = (x) => JSON.stringify((function c(v) { return Array.isArray(v) ? v.map(c) : v && typeof v === 'object' ? Object.keys(v).sort().reduce((o, k) => (o[k] = c(v[k]), o), {}) : v; })(x));
  const IMPORT_FLAG = 'zuuwa.settingsImportedAt';
  const settingsImport = {
    sameContent: (a, b) => canonJson(a === undefined ? null : a) === canonJson(b === undefined ? null : b),
    importedAt() { try { return localStorage.getItem(IMPORT_FLAG) || ''; } catch (_) { return ''; } },
    // True when Supabase already holds exactly the old device settings (import already done).
    async alreadyImported(local) {
      if (!local) return false; const cur = await this.readServer(); if (!cur) return false;
      const w = JSON.parse(JSON.stringify(local)); delete w.auth; const done = this.sameContent(w, cur.value);
      if (done && !this.importedAt()) { try { localStorage.setItem(IMPORT_FLAG, cur.updatedAt || new Date().toISOString()); } catch (_) {} }
      return done;
    },
    readLocal() {
      return new Promise((res) => {
        if (!window.indexedDB) return res(null);
        let r; try { r = indexedDB.open('zuuwa-waterproofing'); } catch (_) { return res(null); }
        r.onupgradeneeded = () => { try { r.transaction.abort(); } catch (_) {} res(null); };
        r.onerror = () => res(null);
        r.onsuccess = () => {
          const db = r.result;
          if (!db.objectStoreNames.contains('kv')) { db.close(); return res(null); }
          const q = db.transaction('kv', 'readonly').objectStore('kv').get('settings');
          q.onsuccess = () => { db.close(); res(q.result && typeof q.result === 'object' ? q.result : null); };
          q.onerror = () => { db.close(); res(null); };
        };
      });
    },
    async readServer() {
      if (!CLOUD) throw new AppError('Supabase is not connected.');
      const { data, error } = await cloudStore.client().from('zw_kv').select('value,updated_at').eq('key', 'settings').maybeSingle();
      if (error) throw new AppError('Could not read the current Supabase settings: ' + error.message);
      return data ? { value: data.value, updatedAt: data.updated_at } : null;
    },
    summary(st) {
      if (!st) return null; const c = st.company || {}; const n = st.numbering || {}; const js = Array.isArray(st.jobScopes) ? st.jobScopes : [];
      const names = js.map((j) => String(j.name || '').trim().toLowerCase()); const dup = names.filter((x, i) => x && names.indexOf(x) !== i);
      return {
        company: c.name || '—', jobScopes: js.length, jobScopeNames: js.map((j) => j.name || '(no name)'), duplicateScopes: [...new Set(dup)],
        prefixes: ['quotation', 'invoice', 'receipt', 'warranty'].map((k) => ({ k, v: (n[k] && n[k].prefix) || '—' })),
        logo: !!c.logo, stamp: !!c.stamp, signature: !!c.signature,
        bank: !!(c.bankName || c.bankAccount || c.bankAccountName), bankText: [c.bankName, c.bankAccountName, c.bankAccount].filter(Boolean).join(' · '),
        categories: (st.categories || []).length, paymentTerms: !!(st.quotation && (st.quotation.paymentTerms || st.quotation.terms)) || !!st.paymentTerms,
        warranty: !!st.warranty, loginImages: Object.values(st.loginImages || {}).filter(Boolean).length,
        sections: Object.keys(st).filter((k) => k !== 'auth').sort(), sizeKB: Math.round(JSON.stringify(st).length / 1024),
      };
    },
    backup(local, server) {
      const blob = new Blob([JSON.stringify({ kind: 'zuuwa-settings-backup', createdAt: new Date().toISOString(), oldDeviceSettings: local || null, currentSupabaseSettings: server ? server.value : null, currentSupabaseUpdatedAt: server ? server.updatedAt : null }, null, 2)], { type: 'application/json' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'zuuwa-settings-backup-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.json';
      document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
    },
    // Writes the old settings exactly (only the old local sign-in passwords are left out — sign-in is Supabase Auth now).
    async run(local, expectServerUpdatedAt) {
      requireAdmin();
      if (!CLOUD) throw new AppError('Supabase is not connected.');
      if (!local) throw new AppError('No old settings were found on this device.');
      const cur = await this.readServer();
      if ((cur ? cur.updatedAt : null) !== (expectServerUpdatedAt || null)) throw new AppError('The Supabase settings changed since the preview was made. Nothing was written — please open the import again.');
      const value = JSON.parse(JSON.stringify(local)); delete value.auth;
      const tech = (e) => [e.code, e.message, e.details, e.hint].filter(Boolean).join(' — ');
      let wr; try { wr = await cloudStore.client().from('zw_kv').upsert({ key: 'settings', value }, { onConflict: 'key' }); } catch (e) { throw new AppError('Import failed while sending — nothing confirmed in Supabase. Technical detail: ' + (e.message || String(e))); }
      if (wr.error) throw new AppError('Import rejected by Supabase — nothing was changed. Technical detail: ' + tech(wr.error));
      let back; try { back = await this.readServer(); } catch (e) { throw new AppError('Settings were sent, but reading them back failed. Do not import again — reload and check Settings. Technical detail: ' + (e.message || String(e))); }
      if (!back) throw new AppError('Settings were sent, but Supabase returned no settings record when read back.');
      if (!this.sameContent(back.value, value)) {
        const diffs = []; (function walk(a, b, p) { if (diffs.length >= 5) return; if (a && b && typeof a === 'object' && typeof b === 'object') new Set([...Object.keys(a), ...Object.keys(b)]).forEach((k) => walk(a[k], b[k], p + '.' + k)); else if (canonJson(a) !== canonJson(b)) diffs.push(p); })(value, back.value, 'settings');
        throw new AppError('Settings were written but differ from the old copy at: ' + diffs.join(', ') + '. Do not import again — send this message to support.');
      }
      try { localStorage.setItem(IMPORT_FLAG, back.updatedAt || new Date().toISOString()); } catch (_) {}
      await cloudStore.refresh();
      return { summary: this.summary(back.value), value: back.value };
    },
  };
  ZW.settingsImport = settingsImport;
  ZW.cloud = CLOUD;
  ZW.ready = storageService.init();
})();
