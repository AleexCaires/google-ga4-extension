// GA4 Event Spy — dataLayer hook (runs in MAIN world, page JS context)
// Wraps window.dataLayer.push to forward every event-bearing push to the
// isolated content script via postMessage.
(function () {
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

  // Hook whatever is already on the window, or seed an empty array.
  let _dl = wrap(window.dataLayer || []);

  // Intercept any later assignment (e.g. GTM replacing the array).
  Object.defineProperty(window, "dataLayer", {
    get() { return _dl; },
    set(v) { _dl = wrap(v || []); },
    configurable: true
  });

  window.dataLayer = _dl;
})();
