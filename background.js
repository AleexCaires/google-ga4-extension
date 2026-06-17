// GA4 Event Spy — background service worker (Manifest V3)
//
// Listens for outgoing GA4 hits (/g/collect and /mp/collect), extracts the
// event(s) from the URL query string and/or the batched POST body, stores
// them in chrome.storage.session, and keeps a badge counter on the icon.

const MAX_EVENTS = 300;
const MAX_DL_EVENTS = 300;

// GA4 collect endpoints. Add your own server-side GTM domain here if needed,
// and also add it to host_permissions in manifest.json.
const URL_FILTERS = [
  "*://*.google-analytics.com/g/collect*",
  "*://*.google-analytics.com/mp/collect*",
  "*://*.analytics.google.com/g/collect*",
  "*://*.googletagmanager.com/g/collect*"
];

// ---- helpers ----------------------------------------------------------

function paramsToObject(searchParams) {
  const obj = {};
  for (const [key, value] of searchParams.entries()) obj[key] = value;
  return obj;
}

// Pull the interesting bits out of one hit's parameter set
function buildEvent(params, meta) {
  const eventParams = {};
  const userProps = {};
  for (const [k, v] of Object.entries(params)) {
    if (k.startsWith("ep.") || k.startsWith("epn.")) eventParams[k.replace(/^epn?\./, "")] = v;
    if (k.startsWith("up.") || k.startsWith("upn.")) userProps[k.replace(/^upn?\./, "")] = v;
  }
  return {
    name: params.en || "(no event name)",
    eventParams,
    userProps,
    measurementId: params.tid || "",
    pageLocation: params.dl || "",
    pageReferrer: params.dr || "",
    pageTitle: params.dt || "",
    allParams: params,
    time: Date.now(),
    tabId: meta.tabId,
    initiator: meta.initiator || ""
  };
}

// Decode a POST body from webRequest's raw bytes (or formData shape)
function decodeRequestBody(requestBody) {
  if (!requestBody) return "";
  if (requestBody.raw && requestBody.raw.length) {
    try {
      const decoder = new TextDecoder("utf-8");
      return requestBody.raw
        .map((part) => (part.bytes ? decoder.decode(part.bytes) : ""))
        .join("");
    } catch (e) {
      return "";
    }
  }
  // Chrome parses some bodies into formData instead of raw bytes
  if (requestBody.formData) {
    return Object.entries(requestBody.formData)
      .map(([k, vals]) => vals.map((v) => `${k}=${encodeURIComponent(v)}`).join("\n"))
      .join("\n");
  }
  return "";
}

// One network request can carry one event (in the URL) or several
// (newline-separated lines in the POST body, sharing the URL's base params).
function extractEvents(details) {
  const events = [];
  const url = new URL(details.url);
  const baseParams = paramsToObject(url.searchParams);
  const meta = { tabId: details.tabId, initiator: details.initiator };

  const body = decodeRequestBody(details.requestBody);
  const bodyLines = body.split("\n").map((l) => l.trim()).filter(Boolean);

  // Lines that look like query strings are batched events
  const batched = bodyLines.filter((line) => /(^|&)en=/.test(line));

  if (batched.length) {
    // For batched hits the URL carries session-level params only.
    // Strip any ep.*/epn.*/up.*/upn.* from the base so they don't
    // bleed into every event — each event's own body line has its params.
    const sessionBase = Object.fromEntries(
      Object.entries(baseParams).filter(([k]) =>
        !k.startsWith("ep.") && !k.startsWith("epn.") &&
        !k.startsWith("up.") && !k.startsWith("upn.")
      )
    );
    for (const line of batched) {
      const lineParams = paramsToObject(new URLSearchParams(line));
      events.push(buildEvent({ ...sessionBase, ...lineParams }, meta));
    }
    // The URL itself may *also* carry an event alongside a batch
    if (baseParams.en) events.unshift(buildEvent(baseParams, meta));
  } else if (baseParams.en) {
    events.push(buildEvent(baseParams, meta));
  } else {
    // CATCH-ALL: a /collect hit we matched but couldn't parse an event
    // name from. Never drop it silently — surface it so the feed proves
    // whether webRequest is seeing traffic at all.
    console.debug("GA4 Event Spy: hit with no parsable en=", {
      url: details.url,
      method: details.method,
      hasBody: !!details.requestBody,
      bodyPreview: body.slice(0, 300)
    });
    const fallback = buildEvent(baseParams, meta);
    fallback.name = "(hit captured — no event name parsed)";
    events.push(fallback);
  }

  console.debug(`GA4 Event Spy: ${events.length} event(s) from`, url.hostname, details.method);
  return events;
}

// ---- dataLayer buffer --------------------------------------------------

const MAX_DL_BUFFER = 200;
// { payload, time, tabId, claimed }
const recentDLPushes = [];

// Flatten a nested dataLayer object into dot-notation key/value pairs.
// e.g. { conversio: { segment: "X" } } → { "conversio.segment": "X" }
function flattenObject(obj, prefix) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      Object.assign(out, flattenObject(v, key));
    } else {
      out[key] = v === null ? "null" : String(v);
    }
  }
  return out;
}

// ---- storage + badge ---------------------------------------------------

let panelOpen = false; // tracked via a long-lived port from the side panel

async function recordEvents(newEvents) {
  if (!newEvents.length) return;

  // Attach any matching dataLayer pushes to each GA4 event.
  // A push matches if it fired within 1 second before the GA4 hit
  // and hasn't already been claimed by another event.
  const now = Date.now();
  for (const ev of newEvents) {
    const matches = recentDLPushes.filter(
      (dl) => !dl.claimed && dl.time <= ev.time && ev.time - dl.time <= 1000
    );
    if (matches.length) {
      ev.dataLayerPushes = matches.map((m) => m.payload);
      matches.forEach((m) => (m.claimed = true));
    }
  }

  const { events = [], unseen = 0 } = await chrome.storage.session.get(["events", "unseen"]);
  const updated = [...newEvents.reverse(), ...events].slice(0, MAX_EVENTS);
  // While the panel is open the user is watching live — no unseen counter
  const unseenCount = panelOpen ? 0 : unseen + newEvents.length;
  await chrome.storage.session.set({ events: updated, unseen: unseenCount });
  await chrome.action.setBadgeText({
    text: unseenCount === 0 ? "" : unseenCount > 99 ? "99+" : String(unseenCount)
  });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setBadgeBackgroundColor({ color: "#1a73e8" });
  chrome.action.setBadgeText({ text: "" });
});

// Clicking the toolbar icon opens the side panel
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((e) => console.warn("sidePanel behavior:", e));

// The panel connects on load; the port closing means the panel was closed
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "ga4-spy-panel") return;
  panelOpen = true;
  chrome.storage.session.set({ unseen: 0 });
  chrome.action.setBadgeText({ text: "" });
  port.onDisconnect.addListener(() => {
    panelOpen = false;
  });
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg) return;
  if (msg.type === "clear-events") {
    chrome.storage.session.set({ events: [], dlEvents: [], unseen: 0 });
    chrome.action.setBadgeText({ text: "" });
    recentDLPushes.length = 0;
  }
  if (msg.type === "datalayer-push" && msg.payload) {
    const eventName = msg.payload.event || "";
    // Drop high-frequency GTM internal timer events — they're noise.
    if (eventName === "gtm.timer") return;

    const tabId = sender && sender.tab ? sender.tab.id : -1;
    const ts = msg.time || Date.now();
    recentDLPushes.push({ payload: msg.payload, time: ts, tabId, claimed: false });
    if (recentDLPushes.length > MAX_DL_BUFFER) recentDLPushes.shift();

    // Also store as a standalone event for the DL toggle feed.
    const dlEvent = {
      type: "datalayer",
      name: msg.payload.event || "(unknown)",
      payload: msg.payload,
      pageLocation: msg.pageLocation || "",
      time: ts,
      tabId
    };
    chrome.storage.session.get("dlEvents").then(({ dlEvents = [] }) => {
      const updated = [dlEvent, ...dlEvents].slice(0, MAX_DL_EVENTS);
      chrome.storage.session.set({ dlEvents: updated });
    });
  }
});

// ---- the listener ------------------------------------------------------

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    try {
      const events = extractEvents(details);
      if (events.length) recordEvents(events);
    } catch (e) {
      console.warn("GA4 Event Spy parse error:", e);
    }
  },
  { urls: URL_FILTERS },
  ["requestBody"]
);
