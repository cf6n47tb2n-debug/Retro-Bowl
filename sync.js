(function () {
  var TOKEN = "cloud_token";
  var LAST = "cloud_last";       // snapshot as of last sync
  var UPDATED = "cloud_updated"; // server timestamp as of last sync
  var BACKUP = "cloud_backup";   // safety copy before a local save is replaced
  var PREFIX = "cloud_";

  var token = localStorage.getItem(TOKEN);
  if (!token) {
    location.replace("/login.html");
    return;
  }

  function snapshotObj() {
    var o = {};
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (k.indexOf(PREFIX) !== 0) o[k] = localStorage.getItem(k);
    }
    return o;
  }
  function snapStr(o) {
    return JSON.stringify(Object.keys(o).sort().map(function (k) { return [k, o[k]]; }));
  }
  function markSynced(data, updatedAt) {
    localStorage.setItem(LAST, snapStr(data));
    localStorage.setItem(UPDATED, String(updatedAt));
  }
  function applyCloud(cloud, local) {
    try {
      if (Object.keys(local).length) localStorage.setItem(BACKUP, JSON.stringify(local));
    } catch (e) {}
    Object.keys(local).forEach(function (k) { localStorage.removeItem(k); });
    Object.keys(cloud.data).forEach(function (k) { localStorage.setItem(k, cloud.data[k]); });
    markSynced(cloud.data, cloud.updatedAt);
  }
  function api(method, body) { // synchronous, so it finishes before the game loads
    var xhr = new XMLHttpRequest();
    xhr.open(method, "/api/save", false);
    xhr.setRequestHeader("Authorization", "Bearer " + token);
    if (body) xhr.setRequestHeader("content-type", "application/json");
    xhr.send(body ? JSON.stringify(body) : null);
    return xhr;
  }
  function uploadSync(local) {
    var r = api("PUT", { data: local });
    if (r.status === 200) markSynced(local, JSON.parse(r.responseText).updatedAt);
  }

  // 1) Sync before the game loads
  try {
    var r = api("GET");
    if (r.status === 401) {
      localStorage.removeItem(TOKEN);
      location.replace("/login.html");
      return;
    }
    if (r.status === 200) {
      var cloud = JSON.parse(r.responseText);
      var local = snapshotObj();
      var hasLocal = Object.keys(local).length > 0;

      if (!cloud.data) {
        if (hasLocal) uploadSync(local);
      } else if (snapStr(cloud.data) === snapStr(local)) {
        markSynced(local, cloud.updatedAt);
      } else {
        var dirty = snapStr(local) !== localStorage.getItem(LAST);
        var cloudChanged = String(cloud.updatedAt) !== localStorage.getItem(UPDATED);
        if (!hasLocal || !dirty) {
          applyCloud(cloud, local);        // only the cloud changed
        } else if (!cloudChanged) {
          uploadSync(local);               // only this computer changed
        } else if (confirm(
          "This computer's save and the cloud save have both changed.\n\n" +
          "OK = load the CLOUD save (replaces this computer's save)\n" +
          "Cancel = KEEP THIS COMPUTER'S save and overwrite the cloud"
        )) {
          applyCloud(cloud, local);
        } else {
          uploadSync(local);
        }
      }
    }
  } catch (e) {
    console.warn("Cloud sync failed, playing with local save", e);
  }

  // 2) Upload changes while playing and when leaving
  function push(keepalive) {
    var local = snapshotObj();
    if (snapStr(local) === localStorage.getItem(LAST)) return;
    fetch("/api/save", {
      method: "PUT",
      keepalive: !!keepalive,
      headers: { "Authorization": "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify({ data: local }),
    }).then(function (res) {
      if (res.status === 401) { localStorage.removeItem(TOKEN); location.replace("/login.html"); return; }
      if (!res.ok) return;
      return res.json().then(function (j) { markSynced(local, j.updatedAt); });
    }).catch(function () {});
  }
  setInterval(function () { push(false); }, 15000);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") push(true);
  });
  window.addEventListener("pagehide", function () { push(true); });
})();
