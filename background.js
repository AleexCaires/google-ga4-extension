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

// ---- A/B tool detection -----------------------------------------------

const AB_TOOLS = [
  { name: "AB Tasty",                  pattern: "*://*.abtasty.com/*" },
  { name: "Dynamic Yield",             pattern: "*://*.dynamicyield.com/*" },
  { name: "Optimizely",                pattern: "*://*.optimizely.com/*" },
  { name: "VWO",                       pattern: "*://*.vwo.com/*" },
  { name: "VWO",                       pattern: "*://*.wingify.com/*" },
  { name: "Kameleoon",                 pattern: "*://*.kameleoon.com/*" },
  { name: "Kameleoon",                 pattern: "*://*.kameleoon.eu/*" },
  { name: "Adobe Target",              pattern: "*://*.tt.omtrdc.net/*" },
  { name: "Convert",                   pattern: "*://*.convert.com/*" },
  { name: "Qubit",                     pattern: "*://*.qubit.com/*" },
  { name: "Monetate",                  pattern: "*://*.monetate.com/*" },
  { name: "Salesforce Personalization",pattern: "*://*.evergage.com/*" },
  { name: "Split.io",                  pattern: "*://*.split.io/*" },
  { name: "LaunchDarkly",              pattern: "*://*.launchdarkly.com/*" },
  { name: "Statsig",                   pattern: "*://*.statsig.com/*" },
  { name: "Eppo",                      pattern: "*://*.geteppo.com/*" },
  { name: "Unbounce",                  pattern: "*://*.unbounce.com/*" },
];

// Map from URL pattern → tool name for fast lookup in the listener
const AB_PATTERN_MAP = {};
const AB_URL_PATTERNS = [];
for (const tool of AB_TOOLS) {
  if (!AB_URL_PATTERNS.includes(tool.pattern)) AB_URL_PATTERNS.push(tool.pattern);
  AB_PATTERN_MAP[tool.pattern] = tool.name;
}

function detectToolFromUrl(url) {
  try {
    const host = new URL(url).hostname;
    for (const tool of AB_TOOLS) {
      const domain = tool.pattern.replace("*://", "").replace("/*", "").replace("*.", "");
      if (host === domain || host.endsWith("." + domain)) return tool.name;
    }
  } catch (e) {}
  return null;
}

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    const tool = detectToolFromUrl(details.url);
    if (!tool || !details.tabId || details.tabId < 0) return;
    chrome.storage.session.get("detectedTools").then(({ detectedTools = {} }) => {
      const tabTools = new Set(detectedTools[details.tabId] || []);
      if (tabTools.has(tool)) return;
      tabTools.add(tool);
      detectedTools[details.tabId] = [...tabTools];
      chrome.storage.session.set({ detectedTools });
    });
  },
  { urls: AB_URL_PATTERNS }
);

// Clear detected tools for a tab when it navigates
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== "loading") return;
  chrome.storage.session.get("detectedTools").then(({ detectedTools = {} }) => {
    if (!detectedTools[tabId]) return;
    delete detectedTools[tabId];
    chrome.storage.session.set({ detectedTools });
  });
});

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

function logEvent(ev) {
  if (ev.name === "conversio_cro") {
    console.log(
      "%c conversio_cro %c " + (ev.eventParams?.conversio_segment || "") + " ",
      "background:#ff69b4;color:#fff;font-weight:700;border-radius:3px 0 0 3px;padding:1px 4px",
      "background:#ffb6c1;color:#7d0038;font-weight:600;border-radius:0 3px 3px 0;padding:1px 4px",
      ev.eventParams
    );
  } else {
    console.log(
      "%c " + ev.name + " ",
      "background:#1d2026;color:#56c98d;font-weight:600;border-radius:3px;padding:1px 4px",
      ev.eventParams
    );
  }
}

// Dedup: track recently recorded event signatures to avoid double-counting
// hits captured by both webRequest and the page fetch hook.
const recentEventSigs = new Map();

// Incremented on every Clear so in-flight recordEvents calls can detect a
// clear that happened while they were awaiting storage and bail out.
let clearGeneration = 0;
// The signature covers the full parameter set — GA4's _s hit counter
// differs on every real hit, so two distinct events with the same name
// never collide; only the exact same hit captured twice is dropped.
function isDuplicate(ev) {
  const sig = `${ev.tabId}|${ev.name}|${JSON.stringify(ev.allParams)}`;
  const last = recentEventSigs.get(sig);
  const now = Date.now();
  if (last && now - last < 2000) return true;
  recentEventSigs.set(sig, now);
  if (recentEventSigs.size > 200) {
    const oldest = recentEventSigs.keys().next().value;
    recentEventSigs.delete(oldest);
  }
  return false;
}

// All storage read-modify-writes are serialized through this queue.
// Without it, two events arriving close together both read the same
// stored list and the second write clobbers the first — events would
// appear in the panel and then vanish.
let writeChain = Promise.resolve();
function queueWrite(fn) {
  writeChain = writeChain.then(fn).catch((e) => console.warn("DataSpy write error:", e));
  return writeChain;
}

async function recordEvents(newEvents) {
  if (!newEvents.length) return;
  newEvents = newEvents.filter(ev => !isDuplicate(ev));
  if (!newEvents.length) return;
  const capturedGen = clearGeneration;
  newEvents.forEach(logEvent);

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

  return queueWrite(async () => {
    // If a Clear happened while these events were in flight, discard them.
    if (capturedGen !== clearGeneration) return;
    const { events = [], unseen = 0 } = await chrome.storage.session.get(["events", "unseen"]);
    if (capturedGen !== clearGeneration) return;
    const updated = [...newEvents.reverse(), ...events].slice(0, MAX_EVENTS);
    // While the panel is open the user is watching live — no unseen counter
    const unseenCount = panelOpen ? 0 : unseen + newEvents.length;
    await chrome.storage.session.set({ events: updated, unseen: unseenCount });
    await chrome.action.setBadgeText({
      text: unseenCount === 0 ? "" : unseenCount > 99 ? "99+" : String(unseenCount)
    });
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
    clearGeneration++;
    recentDLPushes.length = 0;
    recentEventSigs.clear();
    queueWrite(() => chrome.storage.session.set({ events: [], dlEvents: [], unseen: 0 }));
    chrome.action.setBadgeText({ text: "" });
  }
  if (msg.type === "ga4-hit" && msg.url) {
    try {
      const tabId = sender && sender.tab ? sender.tab.id : -1;
      const fakeDetails = {
        url: msg.url,
        tabId,
        initiator: "",
        method: "POST",
        requestBody: { raw: [{ bytes: new TextEncoder().encode(msg.body || "").buffer }] }
      };
      const events = extractEvents(fakeDetails);
      if (events.length) {
        // Stamp the correct time from the page
        const ts = msg.time || Date.now();
        events.forEach(ev => { ev.time = ts; ev.fromPage = true; });
        recordEvents(events);
      }
    } catch (e) {
      console.warn("GA4 Event Spy page-hit parse error:", e);
    }
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
    const capturedGenDL = clearGeneration;
    queueWrite(async () => {
      if (capturedGenDL !== clearGeneration) return;
      const { dlEvents = [] } = await chrome.storage.session.get("dlEvents");
      if (capturedGenDL !== clearGeneration) return;
      const updated = [dlEvent, ...dlEvents].slice(0, MAX_DL_EVENTS);
      await chrome.storage.session.set({ dlEvents: updated });
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
