// GA4 Event Spy — dataLayer hook (runs in MAIN world, page JS context)
// Wraps window.dataLayer.push to forward every event-bearing push to the
// isolated content script via postMessage.
// Also intercepts fetch/sendBeacon/XHR so GA4 hits are captured even when
// the service worker is suspended.
(function () {
  // ---- dataLayer hook -------------------------------------------------------
  function wrap(dl) {
    if (dl.__ga4spyWrapped) return dl;
    const orig = dl.push.bind(dl);
    dl.push = function (...args) {
      for (const item of args) {
        if (item && typeof item === "object" && item.event) {
          try {
            window.postMessage(
              { __ga4spy: true, payload: JSON.parse(JSON.stringify(item)), time: Date.now() },
              "*"
            );
          } catch (e) {}
        }
      }
      return orig(...args);
    };
    dl.__ga4spyWrapped = true;
    return dl;
  }

  let _dl = wrap(window.dataLayer || []);
  Object.defineProperty(window, "dataLayer", {
    get() { return _dl; },
    set(v) { _dl = wrap(v || []); },
    configurable: true
  });
  window.dataLayer = _dl;

  // ---- GA4 network interception ---------------------------------------------
  const GA4_RE = /google-analytics\.com\/(g|mp)\/collect|analytics\.google\.com\/g\/collect|googletagmanager\.com\/g\/collect/;

  function getUrl(input) {
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.href;
    if (input && input.url) return input.url;
    return String(input);
  }

  // Conversio writes its segment codes into sessionStorage the moment an
  // experience or interaction fires. Reading those keys HERE — synchronously,
  // in the page context, at the instant the hit leaves — is the only way to
  // know what storage looked like when the hit was sent. The panel's polling
  // can't answer that; by the time it reads, later events have moved it on.
  const SNAPSHOT_KEYS = [
    "conversioExperienceList",
    "conversioEventList",
    "conversioExperienceFired",
    "conversio_experiences",
    "conversio_events"
  ];

  function readSnapshot() {
    const out = {};
    for (const k of SNAPSHOT_KEYS) {
      try {
        const v = sessionStorage.getItem(k) ?? localStorage.getItem(k);
        if (v === null) { out[k] = null; continue; }
        try { out[k] = JSON.parse(v); } catch (e) { out[k] = v; }
      } catch (e) { out[k] = null; }
    }
    return out;
  }

  function sendHit(url, body, snapshot) {
    try {
      document.dispatchEvent(new CustomEvent("__ga4spy_hit__", {
        detail: {
          url,
          body: body || "",
          time: Date.now(),
          // Captured at call time by the caller, not here — for Blob bodies
          // sendHit runs after an await, by which point storage may have moved.
          storage: snapshot || readSnapshot()
        }
      }));
    } catch (e) {}
  }

  // Turn any body shape into a string, then send exactly one hit.
  // Blob is what GA4 most often passes to sendBeacon — read it async.
  function sendHitWithBody(url, body) {
    // Snapshot NOW, before any async body read, so it reflects the moment the
    // hit was sent rather than whenever the read resolves.
    const snap = readSnapshot();
    if (body == null) { sendHit(url, "", snap); return; }
    if (typeof body === "string") { sendHit(url, body, snap); return; }
    if (body instanceof URLSearchParams) { sendHit(url, body.toString(), snap); return; }
    if (body instanceof Blob) {
      body.text().then((t) => sendHit(url, t, snap)).catch(() => sendHit(url, "", snap));
      return;
    }
    if (body instanceof FormData) {
      try {
        const p = new URLSearchParams();
        body.forEach((v, k) => p.append(k, v));
        sendHit(url, p.toString(), snap);
      } catch (e) { sendHit(url, "", snap); }
      return;
    }
    if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
      try {
        sendHit(url, new TextDecoder().decode(body), snap);
      } catch (e) { sendHit(url, "", snap); }
      return;
    }
    sendHit(url, "", snap);
  }

  // fetch
  const _fetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url = getUrl(input);
      if (GA4_RE.test(url)) {
        if (init && init.body != null) {
          sendHitWithBody(url, init.body);
        } else if (input instanceof Request) {
          // Body may live on the Request object — clone and read async, but
          // snapshot storage now, not when the read resolves.
          const snap = readSnapshot();
          input.clone().text().then((t) => sendHit(url, t, snap)).catch(() => sendHit(url, "", snap));
        } else {
          sendHit(url, "");
        }
      }
    } catch (e) {}
    return _fetch.apply(this, arguments);
  };

  // sendBeacon
  const _beacon = navigator.sendBeacon.bind(navigator);
  navigator.sendBeacon = function (url, data) {
    try {
      if (GA4_RE.test(url)) sendHitWithBody(url, data);
    } catch (e) {}
    return _beacon(url, data);
  };

  // XHR
  const _xhrOpen = XMLHttpRequest.prototype.open;
  const _xhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__ga4spy_url__ = url;
    return _xhrOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    try {
      if (this.__ga4spy_url__ && GA4_RE.test(this.__ga4spy_url__)) {
        sendHitWithBody(this.__ga4spy_url__, body);
      }
    } catch (e) {}
    return _xhrSend.apply(this, arguments);
  };
})();
