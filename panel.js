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
const storageRefreshEl = document.getElementById("storage-refresh");
const storageClearEl = document.getElementById("storage-clear");
const toolsBodyEl = document.getElementById("tools-body");
const rowTemplate = document.getElementById("event-row-template");

let allEvents = [];
let allDLEvents = [];
let knownTimes = new Set();
const groupOpenState = new Map();
let activeTabId = null;
let showDL = true;

function timeLabel(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour12: false }) +
    "." + String(d.getMilliseconds()).padStart(3, "0");
}

// ---- Conversio localStorage panel ------------------------------------

const CONVERSIO_STORAGE_KEYS = ["conversio_experiences", "conversio_events"];
const CONVERSIO_ALL_STORAGE_KEYS = ["conversio_events", "conversio_experiences"];

async function readConversioStorage() {
  if (!activeTabId) return null;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: activeTabId },
      func: (keys) => {
        const out = {};
        for (const k of keys) {
          try { out[k] = JSON.parse(sessionStorage.getItem(k)); } catch (e) { out[k] = null; }
        }
        return out;
      },
      args: [CONVERSIO_STORAGE_KEYS]
    });
    return results[0]?.result || null;
  } catch (e) {
    return null;
  }
}

async function clearConversioStorage() {
  if (!activeTabId) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: activeTabId },
      func: (keys) => { keys.forEach((k) => sessionStorage.removeItem(k)); },
      args: [CONVERSIO_ALL_STORAGE_KEYS]
    });
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

  for (const key of CONVERSIO_STORAGE_KEYS) {
    const arr = data[key];
    const collapsible = key === "conversio_events";
    const showAsChips = key === "conversio_experiences";

    if (collapsible) {
      const details = document.createElement("details");
      details.className = "storage-collapsible";
      const summary = document.createElement("summary");
      summary.className = "storage-row storage-row--summary";
      const label = document.createElement("span");
      label.className = "storage-key";
      label.textContent = key + ":";
      const count = document.createElement("span");
      count.className = "storage-empty-val";
      count.textContent = Array.isArray(arr) && arr.length ? `${arr.length} events` : "(not set)";
      summary.append(label, count);
      details.appendChild(summary);
      if (Array.isArray(arr) && arr.length) {
        const chips = document.createElement("div");
        chips.className = "storage-chips storage-chips--indented";
        for (const val of arr) {
          const chip = document.createElement("span");
          chip.className = "storage-chip";
          chip.textContent = val;
          chips.appendChild(chip);
        }
        details.appendChild(chips);
      }
      storageBodyEl.appendChild(details);
    } else {
      const row = document.createElement("div");
      row.className = "storage-row";
      const label = document.createElement("span");
      label.className = "storage-key";
      label.textContent = key + ":";
      row.appendChild(label);
      if (Array.isArray(arr) && arr.length) {
        const chips = document.createElement("div");
        chips.className = "storage-chips";
        for (const val of arr) {
          const chip = document.createElement("span");
          chip.className = "storage-chip";
          chip.textContent = val;
          chips.appendChild(chip);
        }
        row.appendChild(chips);
      } else {
        const empty = document.createElement("span");
        empty.className = "storage-empty-val";
        empty.textContent = arr === null ? "(not set)" : "(empty)";
        row.appendChild(empty);
      }
      storageBodyEl.appendChild(row);
    }
  }
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
  const { detectedTools = {} } = await chrome.storage.session.get("detectedTools");
  const tools = activeTabId !== null ? (detectedTools[activeTabId] || []) : [];
  toolsBodyEl.innerHTML = "";
  if (!tools.length) return;

  const label = document.createElement("span");
  label.className = "storage-key";
  label.textContent = "detected tools:";
  toolsBodyEl.appendChild(label);

  const chips = document.createElement("div");
  chips.className = "storage-chips";
  for (const name of tools) {
    const chip = document.createElement("span");
    chip.className = "storage-chip storage-chip--tool";
    chip.textContent = name;
    chips.appendChild(chip);
  }
  toolsBodyEl.appendChild(chips);
}

storageRefreshEl.addEventListener("click", () => { refreshStoragePanel(); refreshToolsPanel(); });

storageClearEl.addEventListener("click", async () => {
  await clearConversioStorage();
  if (activeTabId) chrome.tabs.reload(activeTabId);
  await refreshStoragePanel();
});

// ---- Conversio event health check ------------------------------------

const CONVERSIO_REQUIRED_PARAMS = [
  "conversio_segment", "conversio_label", "conversio_category",
  "conversio_action", "conversio_events"
];

function checkEventHealth(ev) {
  if (!ev.name || !ev.name.startsWith("conversio_")) return null;
  const params = ev.eventParams || {};
  const missing = CONVERSIO_REQUIRED_PARAMS.filter((p) => !params[p]);
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

function section(label, entries) {
  const frag = document.createDocumentFragment();
  const lab = document.createElement("div");
  lab.className = "section-label";
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

  // Parameters (event params + user properties merged into one flat list)
  const epEntries = Object.entries(ev.eventParams || {}).filter(([k]) => k !== "conversio_events");
  const upEntries = Object.entries(ev.userProps || {});
  const allParamEntries = [...epEntries, ...upEntries];

  if (allParamEntries.length) {
    body.appendChild(section("Parameters", allParamEntries));
  } else {
    body.appendChild(section("Raw params", Object.entries(ev.allParams || {})));
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

// Split events into navigation groups. A new group starts on every
// page_view event (real page load / SPA navigation / refresh). Walking
// oldest-first keeps same-page events together; we reverse at the end
// for newest-group-first display.
function groupByNavigation(events) {
  const groups = [];
  let current = null;
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (!current || ev.name === "page_view") {
      current = { location: ev.pageLocation || "", events: [] };
      groups.push(current);
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

  // Find timestamps where 2+ conversio_* events fired — marks double-fires.
  const conversioTimes = group.events
    .filter(ev => ev.type !== "datalayer" && ev.name && ev.name.startsWith("conversio_"))
    .map(ev => ev.time);
  const warnTimes = new Set(
    conversioTimes.filter((t, i) => conversioTimes.indexOf(t) !== i)
  );

  const body = document.createElement("div");
  body.className = "nav-group-events";
  for (const ev of group.events) {
    try {
      const isNew = !knownTimes.has(ev.time);
      const warn = warnTimes.has(ev.time) && ev.name && ev.name.startsWith("conversio_");
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
  if (changes.detectedTools) refreshToolsPanel();
});

// Fallback poll — catches events missed when the service worker was suspended
setInterval(async () => {
  const { events = [], dlEvents = [] } = await chrome.storage.session.get(["events", "dlEvents"]);
  const changed = events.length !== allEvents.length || dlEvents.length !== allDLEvents.length;
  if (changed) {
    allEvents = events;
    allDLEvents = dlEvents;
    render();
  }
}, 750);

filterEl.addEventListener("input", render);
filterParamEl.addEventListener("input", render);

clearEl.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "clear-events" });
  allEvents = [];
  allDLEvents = [];
  knownTimes = new Set();
  render();
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
  render();
  refreshStoragePanel();
  refreshToolsPanel();
  refreshExperiencesBar();
});

toggleDLEl.classList.add("active");
initActiveTab().then(() => { load(true); refreshStoragePanel(); refreshToolsPanel(); refreshExperiencesBar(); });
