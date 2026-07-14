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

  function sendHit(url, body) {
    try {
      document.dispatchEvent(new CustomEvent("__ga4spy_hit__", {
        detail: { url, body: body || "", time: Date.now() }
      }));
    } catch (e) {}
  }

  // Turn any body shape into a string, then send exactly one hit.
  // Blob is what GA4 most often passes to sendBeacon — read it async.
  function sendHitWithBody(url, body) {
    if (body == null) { sendHit(url, ""); return; }
    if (typeof body === "string") { sendHit(url, body); return; }
    if (body instanceof URLSearchParams) { sendHit(url, body.toString()); return; }
    if (body instanceof Blob) {
      body.text().then((t) => sendHit(url, t)).catch(() => sendHit(url, ""));
      return;
    }
    if (body instanceof FormData) {
      try {
        const p = new URLSearchParams();
        body.forEach((v, k) => p.append(k, v));
        sendHit(url, p.toString());
      } catch (e) { sendHit(url, ""); }
      return;
    }
    if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
      try {
        sendHit(url, new TextDecoder().decode(body));
      } catch (e) { sendHit(url, ""); }
      return;
    }
    sendHit(url, "");
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
          // Body may live on the Request object — clone and read async
          input.clone().text().then((t) => sendHit(url, t)).catch(() => sendHit(url, ""));
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
