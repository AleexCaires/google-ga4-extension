// GA4 Event Spy — isolated content script
// Relays dataLayer push messages from the MAIN world hook to the background worker.
window.addEventListener("message", (e) => {
  if (!e.data || !e.data.__ga4spy) return;
  chrome.runtime.sendMessage({
    type: "datalayer-push",
    payload: e.data.payload,
    time: e.data.time,
    pageLocation: window.location.href
  });
});
