// GA4 Event Spy — isolated content script
// Relays dataLayer push messages and GA4 network hits from the MAIN world hook
// to the background worker.
window.addEventListener("message", (e) => {
  if (!e.data) return;
  if (e.data.__ga4spy) {
    chrome.runtime.sendMessage({
      type: "datalayer-push",
      payload: e.data.payload,
      time: e.data.time,
      pageLocation: window.location.href
    });
  }
  // ga4spy_hit is relayed via CustomEvent on document (see listener below)
});

document.addEventListener("__ga4spy_hit__", (e) => {
  const { url, body, time, storage } = e.detail || {};
  if (!url) return;
  // `storage` is the Conversio sessionStorage state at the instant the hit was
  // sent — what experience/event validation compares against.
  chrome.runtime.sendMessage({ type: "ga4-hit", url, body: body || "", time, storage });
});
