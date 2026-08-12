// GA4 Event Spy — side panel script

const listEl = document.getElementById("event-list");
const emptyEl = document.getElementById("empty-state");
const countEl = document.getElementById("event-count");
const filterEl = document.getElementById("filter");
const clearEl = document.getElementById("clear");
const toggleDLEl = document.getElementById("toggle-dl");
const filterParamEl = document.getElementById("filter-param");
const experiencesBarEl = document.getElementById("experiences-bar");
const storagePanelEl = document.getElementById("storage-panel");
const storageBodyEl = document.getElementById("storage-body");
const storageClearEl = document.getElementById("storage-clear");
const toolsBodyEl = document.getElementById("tools-body");
const rowTemplate = document.getElementById("event-row-template");

let allEvents = [];
let allDLEvents = [];
let knownTimes = new Set();
const groupOpenState = new Map();
// Which individual events the user has expanded. render() rebuilds the whole
// list, so without this an incoming event would collapse whatever you were
// reading. Keyed on identity that survives a re-render.
const eventOpenState = new Set();

function eventKey(ev) {
  const kind = ev.type === "datalayer" ? "dl" : "ga4";
  const seg = ev.eventParams?.conversio_segment || "";
  return `${kind}|${ev.time}|${ev.name}|${seg}`;
}

// Wire an event row so expanding/collapsing it is remembered across renders.
function trackOpenState(details, ev) {
  const key = eventKey(ev);
  if (eventOpenState.has(key)) details.open = true;
  details.addEventListener("toggle", () => {
    if (!details.open) { eventOpenState.delete(key); return; }
    eventOpenState.add(key);
    // Keys outlive the events they point at (the feed caps at 300), so drop
    // the oldest entries rather than growing forever.
    while (eventOpenState.size > 400) {
      eventOpenState.delete(eventOpenState.values().next().value);
    }
  });
}
let activeTabId = null;
let showDL = true;

function timeLabel(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour12: false }) +
    "." + String(d.getMilliseconds()).padStart(3, "0");
}

// ---- Conversio localStorage panel ------------------------------------

// Keys the current Conversio script writes.
const CONVERSIO_STORAGE_KEYS = [
  "conversioExperienceList",
  "conversioEventList",
  "conversioExperienceFired",
  "conversioExperienceMap",
  "conversio_vitals",
  "conversioVitalsPending",
  "conversioEmissionEnabled",
];

// Earlier key names. Still read so older sites keep working, but only shown
// when actually present — otherwise they'd sit there as permanent "(not set)".
const CONVERSIO_LEGACY_KEYS = ["conversio_experiences", "conversio_events"];

// Rows worth collapsing. conversioExperienceFired just restates
// conversioExperienceList directly above it, and the experience map is verbose.
const CONVERSIO_COLLAPSIBLE_KEYS = new Set([
  "conversioExperienceFired",
  "conversioExperienceMap",
  "conversio_events",
]);

// Kept expanded regardless of length — the fired events are the main thing
// you're watching, and the panel scrolls now if the list gets long.
const CONVERSIO_ALWAYS_EXPANDED_KEYS = new Set(["conversioEventList"]);

const CONVERSIO_ALL_STORAGE_KEYS = [...CONVERSIO_STORAGE_KEYS, ...CONVERSIO_LEGACY_KEYS];

async function readConversioStorage() {
  if (!activeTabId) return null;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: activeTabId },
      func: (keys) => {
        const out = {};
        for (const k of keys) {
          try {
            const val = sessionStorage.getItem(k) ?? localStorage.getItem(k);
            if (val === null) { out[k] = null; continue; }
            // Not everything stored is JSON (e.g. bare "true") — keep raw string
            try { out[k] = JSON.parse(val); } catch (e) { out[k] = val; }
          } catch (e) { out[k] = null; }
        }
        return out;
      },
      args: [CONVERSIO_ALL_STORAGE_KEYS]
    });
    return results[0]?.result || null;
  } catch (e) {
    return null;
  }
}

async function clearConversioStorage() {
  if (!activeTabId) return;

  // Clear sessionStorage + localStorage via injected script
  try {
    await chrome.scripting.executeScript({
      target: { tabId: activeTabId },
      func: (keys) => { keys.forEach((k) => { sessionStorage.removeItem(k); localStorage.removeItem(k); }); },
      args: [CONVERSIO_ALL_STORAGE_KEYS]
    });
  } catch (e) {}

  // Clear ALL cookies on the tab's domain using the cookies API
  try {
    const tab = await chrome.tabs.get(activeTabId);
    const url = new URL(tab.url);
    const allCookies = await chrome.cookies.getAll({ domain: url.hostname });
    for (const cookie of allCookies) {
      const cookieUrl = (cookie.secure ? "https" : "http") + "://" + cookie.domain.replace(/^\./, "") + cookie.path;
      await chrome.cookies.remove({ url: cookieUrl, name: cookie.name });
    }
  } catch (e) {}
}

async function refreshStoragePanel() {
  const data = await readConversioStorage();
  storageBodyEl.innerHTML = "";

  if (!data) {
    const msg = document.createElement("div");
    msg.className = "storage-empty";
    msg.textContent = "Could not read storage on this tab.";
    storageBodyEl.appendChild(msg);
    return;
  }

  // Legacy keys only earn a row when the page actually still writes them.
  const keys = [
    ...CONVERSIO_STORAGE_KEYS,
    ...CONVERSIO_LEGACY_KEYS.filter((k) => data[k] !== null && data[k] !== undefined),
  ];

  for (const key of keys) {
    const val = data[key];
    const count = valueCount(val);
    const collapsible = !CONVERSIO_ALWAYS_EXPANDED_KEYS.has(key)
      && (CONVERSIO_COLLAPSIBLE_KEYS.has(key) || count > 6);

    if (collapsible) {
      const details = document.createElement("details");
      details.className = "storage-collapsible";
      const summary = document.createElement("summary");
      summary.className = "storage-row storage-row--summary";
      const label = document.createElement("span");
      label.className = "storage-key";
      label.textContent = key + ":";
      const meta = document.createElement("span");
      meta.className = "storage-empty-val";
      meta.textContent = count === null ? "(not set)"
        : count === 0 ? "(empty)"
        : `${count} ${count === 1 ? "item" : "items"}`;
      summary.append(label, meta);
      details.appendChild(summary);
      if (count) {
        const inner = document.createElement("div");
        inner.className = "storage-chips--indented";
        // Nested objects (e.g. conversioExperienceMap) read far better as a
        // tree than as one long stringified chip.
        inner.appendChild(isNested(val) ? renderDLTree(val) : storageValueNode(val));
        details.appendChild(inner);
      }
      storageBodyEl.appendChild(details);
    } else {
      const row = document.createElement("div");
      row.className = "storage-row";
      const label = document.createElement("span");
      label.className = "storage-key";
      label.textContent = key + ":";
      row.appendChild(label);
      row.appendChild(storageValueNode(val));
      storageBodyEl.appendChild(row);
    }
  }
}

// Number of entries in a stored value, or null when it isn't set.
function valueCount(val) {
  if (val === null || val === undefined) return null;
  if (Array.isArray(val)) return val.length;
  if (typeof val === "object") return Object.keys(val).length;
  return 1;
}

// True when an object holds at least one object/array value.
function isNested(val) {
  if (!val || typeof val !== "object" || Array.isArray(val)) return false;
  return Object.values(val).some((v) => v !== null && typeof v === "object");
}

// Render any storage value: arrays become one chip per item, objects one
// "key: value" chip per entry (keys are dynamic — whatever is stored),
// booleans a colour-coded chip, other scalars a plain chip.
function storageValueNode(val) {
  const emptyNode = (text) => {
    const s = document.createElement("span");
    s.className = "storage-empty-val";
    s.textContent = text;
    return s;
  };
  if (val === null || val === undefined) return emptyNode("(not set)");

  const chips = document.createElement("div");
  chips.className = "storage-chips";
  const addChip = (text) => {
    const chip = document.createElement("span");
    chip.className = "storage-chip";
    chip.textContent = text;
    chips.appendChild(chip);
    return chip;
  };

  if (Array.isArray(val)) {
    if (!val.length) return emptyNode("(empty)");
    val.forEach((v) => addChip(typeof v === "object" && v !== null ? JSON.stringify(v) : String(v)));
  } else if (typeof val === "object") {
    const entries = Object.entries(val);
    if (!entries.length) return emptyNode("(empty)");
    entries.forEach(([k, v]) =>
      addChip(`${k}: ${typeof v === "object" && v !== null ? JSON.stringify(v) : v}`)
    );
  } else if (typeof val === "boolean" || val === "true" || val === "false") {
    const isOn = val === true || val === "true";
    addChip(String(val)).classList.add(isOn ? "storage-chip--true" : "storage-chip--false");
  } else {
    addChip(String(val));
  }
  return chips;
}

function refreshExperiencesBar() {
  const tabGA4 = activeTabId !== null
    ? allEvents.filter((ev) => ev.tabId === activeTabId)
    : allEvents;
  const tabDL = activeTabId !== null
    ? allDLEvents.filter((ev) => ev.tabId === activeTabId || ev.tabId === -1)
    : allDLEvents;

  // Conversio: collect all unique experience IDs from conversio_experiences param
  const conversioExps = new Set();
  for (const ev of tabGA4) {
    const raw = ev.eventParams?.conversio_experiences || ev.allParams?.["ep.conversio_experiences"];
    if (!raw) continue;
    try {
      const arr = typeof raw === "string" && raw.startsWith("[") ? JSON.parse(raw) : raw.split(",");
      arr.forEach((e) => { const v = String(e).trim(); if (v) conversioExps.add(v); });
    } catch (e) {}
  }

  // AB Tasty: collect campaign info from abtasty DL events
  const abTastyTests = new Map();
  for (const ev of tabDL) {
    if (ev.name !== "abtasty") continue;
    const p = ev.payload || {};
    const id = p.campaignId || p.testId || p.id;
    const name = p.campaignName || p.testName || p.name;
    const variation = p.variationName || p.variationId || p.variationType;
    if (id) abTastyTests.set(String(id), { name: name || String(id), variation });
  }

  experiencesBarEl.innerHTML = "";
  const hasConversio = conversioExps.size > 0;
  const hasABTasty = abTastyTests.size > 0;

  if (!hasConversio && !hasABTasty) {
    experiencesBarEl.style.display = "none";
    return;
  }

  experiencesBarEl.style.display = "block";

  if (hasConversio) {
    const block = document.createElement("div");
    block.className = "exp-block";
    const label = document.createElement("span");
    label.className = "exp-label";
    label.textContent = "Conversio";
    block.appendChild(label);
    const chips = document.createElement("div");
    chips.className = "exp-chips";
    for (const id of conversioExps) {
      const chip = document.createElement("span");
      chip.className = "exp-chip exp-chip--conversio";
      chip.textContent = id;
      chips.appendChild(chip);
    }
    block.appendChild(chips);
    experiencesBarEl.appendChild(block);
  }

  if (hasABTasty) {
    const block = document.createElement("div");
    block.className = "exp-block";
    const label = document.createElement("span");
    label.className = "exp-label";
    label.textContent = "AB Tasty";
    block.appendChild(label);
    const chips = document.createElement("div");
    chips.className = "exp-chips";
    for (const [, test] of abTastyTests) {
      const chip = document.createElement("span");
      chip.className = "exp-chip exp-chip--abtasty";
      chip.title = test.variation ? `Variation: ${test.variation}` : "";
      chip.textContent = test.name;
      chips.appendChild(chip);
    }
    block.appendChild(chips);
    experiencesBarEl.appendChild(block);
  }
}

async function refreshToolsPanel() {
  const { detectedTools = {}, blockedTools = {} } =
    await chrome.storage.session.get(["detectedTools", "blockedTools"]);
  const tools = activeTabId !== null ? (detectedTools[activeTabId] || []) : [];
  const blocked = new Set(activeTabId !== null ? (blockedTools[activeTabId] || []) : []);
  toolsBodyEl.innerHTML = "";

  // A tool can stay blocked after its requests stop appearing (that's the
  // point), so show blocked tools even once they're no longer detected.
  const names = [...new Set([...tools, ...blocked])];
  if (!names.length) return;

  const label = document.createElement("span");
  label.className = "storage-key";
  label.textContent = "detected tools:";
  toolsBodyEl.appendChild(label);

  const chips = document.createElement("div");
  chips.className = "storage-chips";
  for (const name of names) {
    const isBlocked = blocked.has(name);

    // Chip holds only the tool name; the block toggle sits beside it.
    const item = document.createElement("span");
    item.className = "tool-item";

    const chip = document.createElement("span");
    chip.className = "storage-chip storage-chip--tool" + (isBlocked ? " is-blocked" : "");
    chip.textContent = name;
    item.appendChild(chip);

    const btn = document.createElement("button");
    btn.className = "tool-block" + (isBlocked ? " is-blocked" : "");
    // The glyph shows the CURRENT state, not the pending action: a filled dot
    // means the tool is live, the crossed circle means it's blocked.
    btn.textContent = isBlocked ? "⊘" : "●";
    btn.title = isBlocked
      ? `${name} is blocked in this tab — click to allow it again`
      : `${name} is running — click to block its requests in this tab`;
    btn.setAttribute("aria-label", btn.title);
    btn.setAttribute("aria-pressed", String(isBlocked));
    btn.addEventListener("click", () => toggleToolBlock(name, !isBlocked));
    item.appendChild(btn);

    chips.appendChild(item);
  }
  toolsBodyEl.appendChild(chips);
}

// Blocking only bites on the next page load, since a testing tool's script
// is fetched early — so reload once the rules are confirmed in place.
async function toggleToolBlock(tool, blocked) {
  if (activeTabId === null) return;
  try {
    const res = await chrome.runtime.sendMessage({
      type: "set-tool-block", tool, tabId: activeTabId, blocked
    });
    await refreshToolsPanel();
    if (res && res.ok) {
      chrome.tabs.reload(activeTabId);
    } else {
      // Silent failure here is worse than useless — the icon would just sit
      // there doing nothing. Surface the reason in the panel.
      showToolBlockError((res && res.error) || "no response from the extension worker");
    }
  } catch (e) {
    showToolBlockError(String(e && e.message ? e.message : e));
  }
}

function showToolBlockError(message) {
  console.warn("DataSpy: block toggle failed —", message);
  const note = document.createElement("div");
  note.className = "tool-block-error";
  note.textContent = /reload the extension|Receiving end|no response/i.test(message)
    ? "Blocking needs an extension reload: chrome://extensions → reload DataSpy, then reopen this panel."
    : "Could not block: " + message;
  toolsBodyEl.appendChild(note);
}

storageClearEl.addEventListener("click", async () => {
  chrome.runtime.sendMessage({ type: "clear-events" });
  await chrome.storage.session.set({ events: [], dlEvents: [], unseen: 0 });
  allEvents = [];
  allDLEvents = [];
  _lastStorageSnapshot = "";
  knownTimes = new Set();
  groupOpenState.clear();
  eventOpenState.clear();
  render();
  refreshExperiencesBar();
  await clearConversioStorage();
  if (activeTabId) {
    chrome.scripting.executeScript({
      target: { tabId: activeTabId },
      func: () => console.clear()
    }).catch(() => {});
    chrome.tabs.reload(activeTabId);
  }
  await refreshStoragePanel();
});

// ---- Conversio event health check ------------------------------------

const CONVERSIO_REQUIRED_PARAMS = [
  "conversio_segment", "conversio_label", "conversio_category",
  "conversio_action"
];

function checkEventHealth(ev) {
  if (!ev.name || !ev.name.startsWith("conversio_")) return null;
  const params = ev.eventParams || {};
  const missing = CONVERSIO_REQUIRED_PARAMS.filter((p) => !params[p]);
  // An event carrying NONE of the interaction params is a different
  // emission type (e.g. web vitals, experience reach) — those params
  // don't apply to it, so no health check at all.
  if (missing.length === CONVERSIO_REQUIRED_PARAMS.length) return null;
  return { healthy: missing.length === 0, missing };
}

// Tracking params we strip from the group label — noise, not page state.
const TRACKING_PARAMS = [
  /^utm_/, /^gclid$/, /^gbraid$/, /^wbraid$/, /^fbclid$/, /^msclkid$/,
  /^_ga/, /^_gl$/, /^dclid$/, /^yclid$/, /^mc_/, /^igshid$/, /^ttclid$/,
  /^twclid$/, /^cx$/, /^gtm$/
];

function isTracking(key) {
  return TRACKING_PARAMS.some((re) => re.test(key));
}

// Build a clean, readable label for a page URL: path + meaningful query.
function pageLabel(rawUrl) {
  if (!rawUrl) return "(unknown page)";
  try {
    const u = new URL(rawUrl);
    const kept = [];
    for (const [k, v] of u.searchParams.entries()) {
      if (!isTracking(k)) kept.push(`${k}=${v}`);
    }
    const path = u.pathname || "/";
    const query = kept.length ? "?" + kept.join("&") : "";
    return path + query;
  } catch (e) {
    return rawUrl;
  }
}

function pageHost(rawUrl) {
  try {
    return new URL(rawUrl).hostname;
  } catch (e) {
    return "";
  }
}

function kvRow(key, value) {
  const row = document.createElement("div");
  row.className = "kv";
  const k = document.createElement("span");
  k.className = "k";
  k.textContent = key;
  const v = document.createElement("span");
  v.className = "v";
  v.textContent = value;
  row.append(k, v);
  return row;
}

function section(label, entries, extraClass) {
  const frag = document.createDocumentFragment();
  const lab = document.createElement("div");
  lab.className = "section-label" + (extraClass ? " " + extraClass : "");
  lab.textContent = label;
  frag.appendChild(lab);
  for (const [k, v] of entries) frag.appendChild(kvRow(k, v));
  return frag;
}

// Flatten nested objects into dot-notation pairs for display.
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

function renderEvent(ev, isNew, warn) {
  const node = rowTemplate.content.cloneNode(true);
  const details = node.querySelector(".event");
  if (isNew) details.classList.add("is-new");
  trackOpenState(details, ev);

  node.querySelector(".event-name").textContent = ev.name;
  node.querySelector(".event-meta").textContent = timeLabel(ev.time);

  if (warn) {
    const icon = document.createElement("span");
    icon.className = "event-warn";
    icon.title = "Multiple Conversio events fired at the same time";
    icon.textContent = "⚠";
    node.querySelector("summary").insertBefore(icon, node.querySelector(".event-meta"));
  }

  const segment = ev.eventParams?.conversio_segment || "";
  if (segment.endsWith("Q")) {
    const badge = document.createElement("span");
    badge.className = "trigger-badge";
    badge.textContent = "TRIGGER";
    node.querySelector("summary").insertBefore(badge, node.querySelector(".event-meta"));
  } else if (/\.X(CO|V\d)/i.test(segment)) {
    const badge = document.createElement("span");
    badge.className = "exp-badge";
    badge.textContent = "EXPERIENCE";
    node.querySelector("summary").insertBefore(badge, node.querySelector(".event-meta"));
  }

  const health = checkEventHealth(ev);
  if (health) {
    const badge = document.createElement("span");
    badge.className = health.healthy ? "health-ok" : "health-fail";
    badge.title = health.healthy
      ? "All required Conversio parameters present"
      : "Missing: " + health.missing.join(", ");
    badge.textContent = health.healthy ? "✓" : "✗";
    node.querySelector("summary").insertBefore(badge, node.querySelector(".event-meta"));
  }

  const body = node.querySelector(".event-body");

  // Parameters (event params + user properties merged into one flat list).
  // conversio_events / conversio_experiences are session-level context the
  // tag appends to every hit — the experiences bar surfaces them already,
  // so they'd be noise here.
  const epEntries = Object.entries(ev.eventParams || {})
    .filter(([k]) => k !== "conversio_events" && k !== "conversio_experiences");
  const upEntries = Object.entries(ev.userProps || {});

  // conversio_id / conversio_vitals are emission metadata rather than
  // interaction detail — split them out below a divider so the params that
  // describe the event itself stay together.
  const isMeta = ([k]) => k === "conversio_id" || k === "conversio_vitals";
  const metaEntries = epEntries.filter(isMeta);
  const allParamEntries = [...epEntries.filter((e) => !isMeta(e)), ...upEntries];

  if (allParamEntries.length) {
    body.appendChild(section("Parameters", allParamEntries));
  } else if (!metaEntries.length) {
    body.appendChild(section("Raw params", Object.entries(ev.allParams || {})));
  }

  if (metaEntries.length) {
    body.appendChild(section("Emission", metaEntries, "section-label--meta"));
  }

  // dataLayer pushes that preceded this GA4 hit
  for (const push of (ev.dataLayerPushes || [])) {
    const hasProps = Object.keys(push).filter(k => k !== "event").length > 0;
    if (hasProps) body.appendChild(dlSection(`dataLayer · ${push.event || "push"}`, push, ["event"]));
  }

  // Missing param warning
  if (health && !health.healthy) {
    const frag = document.createDocumentFragment();
    const lab = document.createElement("div");
    lab.className = "section-label section-label--missing";
    lab.textContent = "Missing parameters";
    frag.appendChild(lab);
    for (const p of health.missing) {
      const row = document.createElement("div");
      row.className = "kv kv--missing";
      const k = document.createElement("span");
      k.className = "k";
      k.textContent = p;
      const v = document.createElement("span");
      v.className = "v";
      v.textContent = "not found";
      row.append(k, v);
      frag.appendChild(row);
    }
    body.appendChild(frag);
  }

  // Document info footer
  const docFields = [];
  if (ev.pageLocation) docFields.push(["Document Location", ev.pageLocation]);
  if (ev.pageReferrer) docFields.push(["Document Referrer", ev.pageReferrer]);
  if (ev.pageTitle)    docFields.push(["Document Title", ev.pageTitle]);
  if (ev.measurementId) docFields.push(["Measurement ID", ev.measurementId]);
  if (docFields.length) body.appendChild(docInfo(docFields));

  return node;
}

function docInfo(fields) {
  const frag = document.createDocumentFragment();
  const wrap = document.createElement("div");
  wrap.className = "doc-info";
  for (const [label, value] of fields) {
    const row = document.createElement("div");
    row.className = "doc-info-row";
    const l = document.createElement("span");
    l.className = "doc-info-label";
    l.textContent = label + ":";
    const v = document.createElement("span");
    v.className = "doc-info-value";
    v.textContent = value;
    row.append(l, v);
    wrap.appendChild(row);
  }
  frag.appendChild(wrap);
  return frag;
}

// Render an object as a collapsible tree — nested objects collapse to
// "{ N props }" by default, scalar values are always visible.
function renderDLTree(obj, skipKeys = []) {
  const wrap = document.createElement("div");
  wrap.className = "dl-tree";
  if (!obj || typeof obj !== "object") return wrap;
  for (const [k, v] of Object.entries(obj)) {
    if (skipKeys.includes(k)) continue;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      const count = Object.keys(v).length;
      const node = document.createElement("details");
      node.className = "dl-tree-node";
      node.open = true;
      const summary = document.createElement("summary");
      summary.className = "dl-tree-summary";
      const keyEl = document.createElement("span");
      keyEl.className = "dl-tree-key";
      keyEl.textContent = k + ":";
      const badge = document.createElement("span");
      badge.className = "dl-tree-badge";
      badge.textContent = `{ ${count} props }`;
      summary.append(keyEl, badge);
      node.appendChild(summary);
      node.appendChild(renderDLTree(v));
      wrap.appendChild(node);
    } else {
      const row = document.createElement("div");
      row.className = "dl-tree-row";
      const keyEl = document.createElement("span");
      keyEl.className = "dl-tree-key";
      keyEl.textContent = k + ":";
      const valEl = document.createElement("span");
      valEl.className = "dl-tree-val";
      valEl.textContent = v === null ? "null" : String(v);
      row.append(keyEl, valEl);
      wrap.appendChild(row);
    }
  }
  return wrap;
}

function dlSection(label, payload, skipKeys = []) {
  const frag = document.createDocumentFragment();
  const lab = document.createElement("div");
  lab.className = "section-label section-label--dl";
  lab.textContent = label;
  frag.appendChild(lab);
  frag.appendChild(renderDLTree(payload, skipKeys));
  return frag;
}

function renderDLEvent(ev, isNew) {
  const node = rowTemplate.content.cloneNode(true);
  const details = node.querySelector(".event");
  details.classList.add("event--dl");
  if (isNew) details.classList.add("is-new");
  trackOpenState(details, ev);

  const nameEl = node.querySelector(".event-name");
  nameEl.textContent = ev.name;
  nameEl.classList.add("event-name--dl");
  node.querySelector(".event-meta").textContent = timeLabel(ev.time);

  const body = node.querySelector(".event-body");
  const payload = ev.payload || {};
  const hasProps = Object.keys(payload).filter(k => k !== "event").length > 0;
  if (hasProps) body.appendChild(dlSection("dataLayer push", payload, ["event"]));

  return node;
}

// Split events into navigation groups. A new group starts when the page
// URL (host + path) changes, or on a repeat page_view for the same URL
// (reload). Comparing URLs matters because dataLayer pushes on a new page
// fire before the GA4 page_view hit — waiting for page_view would leak
// those early events into the previous page's group. Query-only changes
// (e.g. Shopify ?variant=) don't split. Walking oldest-first keeps
// same-page events together; we reverse at the end for newest-first display.
function pageKey(loc) {
  if (!loc) return "";
  try {
    const u = new URL(loc);
    return u.host + u.pathname;
  } catch (e) {
    return loc;
  }
}

function groupByNavigation(events) {
  const groups = [];
  let current = null;
  let currentKey = "";
  let currentHasPV = false;
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    const key = pageKey(ev.pageLocation);
    const navigated = key && currentKey && key !== currentKey;
    const reloaded = ev.name === "page_view" && currentHasPV;
    if (!current || navigated || reloaded) {
      current = { location: ev.pageLocation || "", events: [] };
      groups.push(current);
      currentKey = key;
      currentHasPV = ev.name === "page_view";
    } else {
      // Backfill location/key if the group started from an event
      // that had no page URL of its own.
      if (!currentKey && key) {
        currentKey = key;
        if (!current.location) current.location = ev.pageLocation || "";
      }
      if (ev.name === "page_view") currentHasPV = true;
    }
    current.events.push(ev);
  }
  groups.reverse();
  groups.forEach((g) => g.events.reverse());
  return groups;
}

function renderGroup(group, groupIndex, isNewest) {
  const wrap = document.createElement("details");
  wrap.className = "nav-group";

  // Newest group open by default; older groups collapsed.
  // Manual toggle overrides the default once the user has interacted.
  const savedOpen = groupOpenState.get(groupIndex);
  wrap.open = savedOpen !== undefined ? savedOpen : isNewest;

  wrap.addEventListener("toggle", () => {
    groupOpenState.set(groupIndex, wrap.open);
  });

  const header = document.createElement("summary");
  header.className = "nav-group-header";

  const caret = document.createElement("span");
  caret.className = "nav-group-caret";
  caret.textContent = "▸";

  const label = document.createElement("span");
  label.className = "nav-group-label";
  label.textContent = pageLabel(group.location);
  label.title = group.location;

  const host = document.createElement("span");
  host.className = "nav-group-host";
  host.textContent = pageHost(group.location);

  const count = document.createElement("span");
  count.className = "nav-group-count";
  count.textContent = group.events.length;

  header.append(caret, label, host, count);
  wrap.appendChild(header);

  // Flag true double-fires: the SAME conversio segment sent 2+ times at
  // the same timestamp. Different segments sharing a timestamp are fine —
  // that's one interaction matching several tracking conditions, batched
  // by GA4 into one request.
  const isConversio = (ev) => ev.type !== "datalayer" && ev.name && ev.name.startsWith("conversio_");
  const dupSig = (ev) => `${ev.time}|${ev.eventParams?.conversio_segment || ""}|${ev.eventParams?.conversio_label || ""}`;
  const conversioSigs = group.events.filter(isConversio).map(dupSig);
  const warnSigs = new Set(
    conversioSigs.filter((s, i) => conversioSigs.indexOf(s) !== i)
  );

  const body = document.createElement("div");
  body.className = "nav-group-events";
  for (const ev of group.events) {
    try {
      const isNew = !knownTimes.has(ev.time);
      const warn = isConversio(ev) && warnSigs.has(dupSig(ev));
      const node = ev.type === "datalayer"
        ? renderDLEvent(ev, isNew)
        : renderEvent(ev, isNew, warn);
      body.appendChild(node);
    } catch (e) {
      console.warn("DataSpy: render error for event", ev.name, e);
    }
  }
  wrap.appendChild(body);
  return wrap;
}

function getMergedEvents() {
  const ga4 = activeTabId !== null
    ? allEvents.filter((ev) => ev.tabId === activeTabId)
    : allEvents;
  if (!showDL) return ga4;
  const dl = activeTabId !== null
    ? allDLEvents.filter((ev) => ev.tabId === activeTabId || ev.tabId === -1)
    : allDLEvents;
  return [...ga4, ...dl].sort((a, b) => b.time - a.time);
}

function eventMatchesParamFilter(ev, query) {
  if (!query) return true;
  const search = (obj) => obj && Object.values(obj).some((v) => String(v).toLowerCase().includes(query));
  if (ev.type === "datalayer") {
    return search(ev.payload);
  }
  return search(ev.eventParams) || search(ev.userProps) || search(ev.allParams);
}

function render() {
  const query = filterEl.value.trim().toLowerCase();
  const paramQuery = filterParamEl.value.trim().toLowerCase();
  const tabEvents = getMergedEvents();
  const visible = tabEvents
    .filter((ev) => !query || ev.name.toLowerCase().includes(query))
    .filter((ev) => eventMatchesParamFilter(ev, paramQuery));

  // Rebuilding the list resets scroll, which would yank you away from an
  // event you're reading. Restore it unless you're parked at the top.
  const prevScroll = listEl.scrollTop;

  countEl.textContent = String(tabEvents.length);
  listEl.querySelectorAll(".nav-group").forEach((n) => n.remove());
  emptyEl.style.display = visible.length ? "none" : "";

  if (query && !visible.length && tabEvents.length) {
    emptyEl.querySelector("p").textContent = "No events match that filter.";
  } else {
    emptyEl.querySelector("p").textContent = "No events captured yet.";
  }

  const frag = document.createDocumentFragment();
  const groups = groupByNavigation(visible);
  groups.forEach((group, i) => {
    frag.appendChild(renderGroup(group, i, i === 0));
  });
  listEl.appendChild(frag);

  if (prevScroll > 0) listEl.scrollTop = prevScroll;
}

async function load(markKnown) {
  const { events = [], dlEvents = [] } = await chrome.storage.session.get(["events", "dlEvents"]);
  allEvents = events;
  allDLEvents = dlEvents;
  if (markKnown) {
    knownTimes = new Set([...events.map((e) => e.time), ...dlEvents.map((e) => e.time)]);
  }
  render();
}

// Live updates while the panel is open
chrome.storage.session.onChanged.addListener((changes) => {
  const pinned = listEl.scrollTop < 40;
  let changed = false;
  if (changes.events) { allEvents = changes.events.newValue || []; changed = true; }
  if (changes.dlEvents) { allDLEvents = changes.dlEvents.newValue || []; changed = true; }
  if (changed) {
    render();
    refreshExperiencesBar();
    if (pinned) listEl.scrollTop = 0;
  }
  if (changes.detectedTools || changes.blockedTools) refreshToolsPanel();
});

// Fallback poll — catches events missed when the service worker was suspended
let _lastStorageSnapshot = "";
setInterval(async () => {
  const { events = [], dlEvents = [] } = await chrome.storage.session.get(["events", "dlEvents"]);
  const changed =
    events.length !== allEvents.length ||
    dlEvents.length !== allDLEvents.length ||
    (events[0] && allEvents[0] && events[0].time !== allEvents[0].time) ||
    (dlEvents[0] && allDLEvents[0] && dlEvents[0].time !== allDLEvents[0].time);
  if (changed) {
    allEvents = events;
    allDLEvents = dlEvents;
    render();
    refreshExperiencesBar();
  }
  // Read sessionStorage on every tick and only re-render if values changed
  const storageData = await readConversioStorage();
  const snapshot = JSON.stringify(storageData);
  if (snapshot !== _lastStorageSnapshot) {
    _lastStorageSnapshot = snapshot;
    refreshStoragePanel();
    refreshExperiencesBar();
  }
}, 750);

filterEl.addEventListener("input", render);
filterParamEl.addEventListener("input", render);

clearEl.addEventListener("click", async () => {
  chrome.runtime.sendMessage({ type: "clear-events" });
  await chrome.storage.session.set({ events: [], dlEvents: [], unseen: 0 });
  allEvents = [];
  allDLEvents = [];
  _lastStorageSnapshot = "";
  knownTimes = new Set();
  groupOpenState.clear();
  eventOpenState.clear();
  render();
  refreshExperiencesBar();
  if (activeTabId) {
    chrome.scripting.executeScript({
      target: { tabId: activeTabId },
      func: () => console.clear()
    }).catch(() => {});
  }
});

toggleDLEl.addEventListener("click", () => {
  showDL = !showDL;
  toggleDLEl.classList.toggle("active", showDL);
  groupOpenState.clear();
  render();
});

// Keep a long-lived connection so background knows the panel is open.
// MV3 service workers can be suspended (which drops the port), so reconnect.
function connectToBackground() {
  const port = chrome.runtime.connect({ name: "ga4-spy-panel" });
  port.onDisconnect.addListener(() => {
    setTimeout(connectToBackground, 500);
  });
}
connectToBackground();

// Track which tab is active so the panel only shows that tab's events.
async function initActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) activeTabId = tab.id;
}

chrome.tabs.onActivated.addListener(({ tabId }) => {
  activeTabId = tabId;
  groupOpenState.clear();
  eventOpenState.clear();
  render();
  refreshStoragePanel();
  refreshToolsPanel();
  refreshExperiencesBar();
});

// Re-read storage after the page finishes loading so we catch values
// written by page scripts during page load (e.g. Conversio sessionStorage).
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId !== activeTabId || changeInfo.status !== "complete") return;
  refreshStoragePanel();
  refreshExperiencesBar();
});

toggleDLEl.classList.add("active");
initActiveTab().then(() => { load(true); refreshStoragePanel(); refreshToolsPanel(); refreshExperiencesBar(); });
