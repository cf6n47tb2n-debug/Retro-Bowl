// Cloud save sync. Add as the FIRST script in <head> of the game's index.html:
//   <script src="/sync.js"></script>
(function () {
  var TOKEN = "cloud_token";
  var LAST = "cloud_last"; // snapshot string from the last successful sync
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
  function snapshot() {
    var o = snapshotObj();
    var keys = Object.keys(o).sort();
    return JSON.stringify(keys.map(function (k) { return [k, o[k]]; }));
  }
  function applyCloud(data) {
    var existing = Object.keys(snapshotObj());
    existing.forEach(function (k) { localStorage.removeItem(k); });
    Object.keys(data).forEach(function (k) { localStorage.setItem(k, data[k]); });
    localStorage.setItem(LAST, snapshot());
  }

  // 1) Pull before the game loads (synchronous so the game sees the cloud save)
  try {
    var xhr = new XMLHttpRequest();
    xhr.open("GET", "/api/save", false);
    xhr.setRequestHeader("Authorization", "Bearer " + token);
    xhr.send();
    if (xhr.status === 401) {
      localStorage.removeItem(TOKEN);
      location.replace("/login.html");
      return;
    }
    if (xhr.status === 200) {
      var cloud = JSON.parse(xhr.responseText);
      if (cloud.data) {
        var localSnap = snapshot();
        var cloudSnapKeys = Object.keys(cloud.data).sort();
        var cloudSnap = JSON.stringify(cloudSnapKeys.map(function (k) { return [k, cloud.data[k]]; }));
        if (localSnap !== cloudSnap) {
          var dirty = localSnap !== localStorage.getItem(LAST);
          if (!dirty || confirm(
            "This computer has changes that aren't in the cloud, and the cloud save is different.\n\n" +
            "OK = use the CLOUD save\nCancel = keep THIS computer's save and upload it"
          )) {
            applyCloud(cloud.data);
          }
        }
      }
    }
  } catch (e) {
    console.warn("Cloud pull failed, playing with local save", e);
  }

  // 2) Push changes periodically and when leaving the page
  function push(keepalive) {
    var snap = snapshot();
    if (snap === localStorage.getItem(LAST)) return;
    fetch("/api/save", {
      method: "PUT",
      keepalive: !!keepalive,
      headers: { "Authorization": "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify({ data: snapshotObj() }),
    }).then(function (r) {
      if (r.ok) localStorage.setItem(LAST, snap);
      else if (r.status === 401) { localStorage.removeItem(TOKEN); location.replace("/login.html"); }
    }).catch(function () {});
  }
  setInterval(function () { push(false); }, 30000);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") push(true);
  });
  window.addEventListener("pagehide", function () { push(true); });
})();
