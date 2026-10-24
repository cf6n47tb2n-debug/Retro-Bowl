(function () {
  var TOKEN = "cloud_token", LAST = "cloud_last", UPDATED = "cloud_updated";
  var BACKUP = "cloud_backup", PREFIX = "cloud_";

  var token = localStorage.getItem(TOKEN);
  if (!token) {
    window.cloudReady = new Promise(function () {}); // never loads the game
    location.replace("/login.html");
    return;
  }

  // ---------- helpers ----------
  function hash(s) { // cyrb53
    var h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 2654435761);
      h2 = Math.imul(h2 ^ c, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36) + "-" + s.length;
  }
  function bufToB64(buf) {
    var b = new Uint8Array(buf), s = "", n = 0x8000;
    for (var i = 0; i < b.length; i += n) s += String.fromCharCode.apply(null, b.subarray(i, i + n));
    return btoa(s);
  }
  function b64ToBuf(s) {
    var r = atob(s), b = new Uint8Array(r.length);
    for (var i = 0; i < r.length; i++) b[i] = r.charCodeAt(i);
    return b.buffer;
  }
  function reqP(r) {
    return new Promise(function (res, rej) {
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
  }

  // ---------- encode / decode IndexedDB values ----------
  async function enc(v) {
    if (v === undefined) return { __t: "u" };
    if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
    if (v instanceof ArrayBuffer) return { __t: "ab", d: bufToB64(v) };
    if (ArrayBuffer.isView(v)) {
      return { __t: "ta", c: v.constructor.name, d: bufToB64(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)) };
    }
    if (typeof Blob !== "undefined" && v instanceof Blob) return { __t: "bl", m: v.type, d: bufToB64(await v.arrayBuffer()) };
    if (v instanceof Date) return { __t: "dt", d: v.getTime() };
    if (Array.isArray(v)) {
      var a = [];
      for (var i = 0; i < v.length; i++) a.push(await enc(v[i]));
      return a;
    }
    if (typeof v === "object") {
      var o = {}, ks = Object.keys(v);
      for (var j = 0; j < ks.length; j++) o[ks[j]] = await enc(v[ks[j]]);
      return { __t: "o", d: o };
    }
    return null;
  }
  function dec(v) {
    if (Array.isArray(v)) return v.map(dec);
    if (v && typeof v === "object") {
      switch (v.__t) {
        case "u": return undefined;
        case "ab": return b64ToBuf(v.d);
        case "ta": return new (window[v.c] || Uint8Array)(b64ToBuf(v.d));
        case "bl": return new Blob([b64ToBuf(v.d)], { type: v.m });
        case "dt": return new Date(v.d);
        case "o": var o = {}; Object.keys(v.d).forEach(function (k) { o[k] = dec(v.d[k]); }); return o;
      }
    }
    return v;
  }

  // ---------- read everything ----------
  async function readDb(name) {
    var db = await new Promise(function (res, rej) {
      var r = indexedDB.open(name);
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
      r.onupgradeneeded = function (e) { e.target.transaction.abort(); };
    });
    var raw = { name: name, version: db.version, stores: [] };
    var names = Array.from(db.objectStoreNames);
    if (names.length) {
      var tx = db.transaction(names, "readonly");
      for (var i = 0; i < names.length; i++) {
        var st = tx.objectStore(names[i]);
        var indexes = Array.from(st.indexNames).map(function (n) {
          var ix = st.index(n);
          return { name: ix.name, keyPath: ix.keyPath, unique: ix.unique, multiEntry: ix.multiEntry };
        });
        var keys = await reqP(st.getAllKeys());
        var vals = await reqP(st.getAll());
        raw.stores.push({ name: names[i], keyPath: st.keyPath, autoIncrement: st.autoIncrement, indexes: indexes, keys: keys, vals: vals });
      }
    }
    db.close();
    var out = { name: raw.name, version: raw.version, stores: [] };
    for (var s = 0; s < raw.stores.length; s++) {
      var rs = raw.stores[s], recs = [];
      for (var k = 0; k < rs.keys.length; k++) recs.push([await enc(rs.keys[k]), await enc(rs.vals[k])]);
      out.stores.push({ name: rs.name, keyPath: rs.keyPath, autoIncrement: rs.autoIncrement, indexes: rs.indexes, records: recs });
    }
    return out;
  }
  async function readAllIdb() {
    if (!indexedDB.databases) return [];
    var list = (await indexedDB.databases()).filter(function (d) { return d.name; });
    list.sort(function (a, b) { return a.name < b.name ? -1 : 1; });
    var out = [];
    for (var i = 0; i < list.length; i++) {
      try { out.push(await readDb(list[i].name)); } catch (e) { console.warn("Skipped db", list[i].name, e); }
    }
    return out;
  }
  async function snapshot() {
    var ls = {}, keys = [];
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (k.indexOf(PREFIX) !== 0) keys.push(k);
    }
    keys.sort().forEach(function (k) { ls[k] = localStorage.getItem(k); });
    return { v: 2, ls: ls, idb: await readAllIdb() };
  }
  function sig(snap) { return hash(JSON.stringify(snap)); }
  function hasData(snap) {
    return Object.keys(snap.ls).length > 0 || snap.idb.some(function (d) {
      return d.stores.some(function (s) { return s.records.length > 0; });
    });
  }

  // ---------- restore ----------
  async function restoreIdb(list) {
    if (indexedDB.databases) {
      var existing = await indexedDB.databases();
      for (var i = 0; i < existing.length; i++) {
        if (!existing[i].name) continue;
        await new Promise(function (res) {
          var r = indexedDB.deleteDatabase(existing[i].name);
          r.onsuccess = r.onerror = r.onblocked = function () { res(); };
        });
      }
    }
    for (var n = 0; n < list.length; n++) {
      var d = list[n];
      await new Promise(function (res, rej) {
        var r = indexedDB.open(d.name, d.version);
        r.onupgradeneeded = function () {
          var db = r.result;
          d.stores.forEach(function (s) {
            var st = db.createObjectStore(s.name, { keyPath: s.keyPath, autoIncrement: s.autoIncrement });
            s.indexes.forEach(function (ix) {
              st.createIndex(ix.name, ix.keyPath, { unique: ix.unique, multiEntry: ix.multiEntry });
            });
          });
        };
        r.onsuccess = function () {
          var db = r.result;
          if (!d.stores.length) { db.close(); res(); return; }
          var tx = db.transaction(d.stores.map(function (s) { return s.name; }), "readwrite");
          d.stores.forEach(function (s) {
            var st = tx.objectStore(s.name);
            s.records.forEach(function (rec) {
              if (s.keyPath !== null) st.put(dec(rec[1]));
              else st.put(dec(rec[1]), dec(rec[0]));
            });
          });
          tx.oncomplete = function () { db.close(); res(); };
          tx.onerror = tx.onabort = function () { db.close(); rej(tx.error); };
        };
        r.onerror = function () { rej(r.error); };
      });
    }
  }
  async function applyCloud(cloud, local) {
    try { if (hasData(local)) localStorage.setItem(BACKUP, JSON.stringify(local.ls)); } catch (e) {}
    Object.keys(local.ls).forEach(function (k) { localStorage.removeItem(k); });
    Object.keys(cloud.data.ls || {}).forEach(function (k) { localStorage.setItem(k, cloud.data.ls[k]); });
    await restoreIdb(cloud.data.idb || []);
    localStorage.setItem(LAST, sig(await snapshot()));
    localStorage.setItem(UPDATED, String(cloud.updatedAt));
  }

  // ---------- server ----------
  function authFail() {
    localStorage.removeItem(TOKEN);
    location.replace("/login.html");
  }
  async function getCloud() {
    var r = await fetch("/api/save", { headers: { Authorization: "Bearer " + token } });
    if (r.status === 401) { authFail(); return "auth"; }
    if (!r.ok) throw new Error("GET " + r.status);
    return r.json();
  }
  async function upload(snap) {
    var r = await fetch("/api/save", {
      method: "PUT",
      headers: { Authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify({ data: snap }),
    });
    if (r.status === 401) { authFail(); return; }
    if (!r.ok) throw new Error("PUT " + r.status);
    var j = await r.json();
    localStorage.setItem(UPDATED, String(j.updatedAt));
    localStorage.setItem(LAST, sig(snap));
  }

  // ---------- startup sync (the game waits for this) ----------
  window.cloudReady = (async function () {
    try {
      var cloud = await getCloud();
      if (cloud === "auth") return new Promise(function () {});
      var local = await snapshot();
      var localHas = hasData(local);

      if (!cloud.data) {
        if (localHas) await upload(local);
      } else if (sig(cloud.data) === sig(local)) {
        localStorage.setItem(LAST, sig(local));
        localStorage.setItem(UPDATED, String(cloud.updatedAt));
      } else {
        var dirty = sig(local) !== localStorage.getItem(LAST);
        var cloudChanged = String(cloud.updatedAt) !== localStorage.getItem(UPDATED);
        if (!localHas || !dirty) {
          await applyCloud(cloud, local);   // only the cloud changed
        } else if (!cloudChanged) {
          await upload(local);              // only this computer changed
        } else if (confirm(
          "This computer's save and the cloud save are different.\n\n" +
          "OK = load the CLOUD save (replaces this computer's save)\n" +
          "Cancel = KEEP THIS COMPUTER'S save and overwrite the cloud"
        )) {
          await applyCloud(cloud, local);
        } else {
          await upload(local);
        }
      }
    } catch (e) {
      console.warn("Cloud sync failed, playing with local save", e);
    }
  })();

  // ---------- keep uploading while playing ----------
  var busy = false;
  async function push() {
    if (busy) return;
    busy = true;
    try {
      var snap = await snapshot();
      if (!hasData(snap) || sig(snap) === localStorage.getItem(LAST)) return;
      await upload(snap);
    } catch (e) {
    } finally {
      busy = false;
    }
  }
  window.cloudReady.then(function () { setInterval(push, 15000); });
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") push();
  });
})();
