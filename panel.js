// GA4 Event Spy — side panel script

const listEl = document.getElementById("event-list");
const emptyEl = document.getElementById("empty-state");
const countEl = document.getElementById("event-count");
const filterEl = document.getElementById("filter");
const clearEl = document.getElementById("clear");
const rowTemplate = document.getElementById("event-row-template");

let allEvents = [];
let knownTimes = new Set(); // to mark newly arrived events while popup is open
// groupIndex → open state; persists across live re-renders
const groupOpenState = new Map();
let activeTabId = null;

function timeLabel(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour12: false }) +
    "." + String(d.getMilliseconds()).padStart(3, "0");
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

function renderEvent(ev, isNew) {
  const node = rowTemplate.content.cloneNode(true);
  const details = node.querySelector(".event");
  if (isNew) details.classList.add("is-new");

  node.querySelector(".event-name").textContent = ev.name;
  node.querySelector(".event-meta").textContent = timeLabel(ev.time);

  const body = node.querySelector(".event-body");

  const epEntries = Object.entries(ev.eventParams || {});
  if (epEntries.length) body.appendChild(section("Event params", epEntries));

  const upEntries = Object.entries(ev.userProps || {});
  if (upEntries.length) body.appendChild(section("User properties", upEntries));

  const context = [];
  if (ev.measurementId) context.push(["measurement_id", ev.measurementId]);
  if (ev.pageLocation) context.push(["page_location", ev.pageLocation]);
  if (ev.pageTitle) context.push(["page_title", ev.pageTitle]);
  if (context.length) body.appendChild(section("Context", context));

  if (!epEntries.length && !upEntries.length && !context.length) {
    body.appendChild(section("Raw params", Object.entries(ev.allParams || {})));
  }

  // dataLayer pushes that preceded this GA4 hit
  for (const push of (ev.dataLayerPushes || [])) {
    const flat = flattenObject(push);
    const entries = Object.entries(flat).filter(([k]) => k !== "event");
    if (entries.length) {
      body.appendChild(dlSection(`dataLayer · ${push.event || "push"}`, entries));
    }
  }

  return node;
}

function dlSection(label, entries) {
  const frag = document.createDocumentFragment();
  const lab = document.createElement("div");
  lab.className = "section-label section-label--dl";
  lab.textContent = label;
  frag.appendChild(lab);
  for (const [k, v] of entries) {
    const row = document.createElement("div");
    row.className = "kv";
    const kEl = document.createElement("span");
    kEl.className = "k k--dl";
    kEl.textContent = k;
    const vEl = document.createElement("span");
    vEl.className = "v";
    vEl.textContent = v;
    row.append(kEl, vEl);
    frag.appendChild(row);
  }
  return frag;
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

  const body = document.createElement("div");
  body.className = "nav-group-events";
  for (const ev of group.events) {
    body.appendChild(renderEvent(ev, !knownTimes.has(ev.time)));
  }
  wrap.appendChild(body);
  return wrap;
}

function render() {
  const query = filterEl.value.trim().toLowerCase();
  const tabEvents = activeTabId !== null
    ? allEvents.filter((ev) => ev.tabId === activeTabId)
    : allEvents;
  const visible = query
    ? tabEvents.filter((ev) => ev.name.toLowerCase().includes(query))
    : tabEvents;

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
  const { events = [] } = await chrome.storage.session.get("events");
  allEvents = events;
  if (markKnown) knownTimes = new Set(events.map((e) => e.time));
  render();
}

// Live updates while the panel is open
chrome.storage.session.onChanged.addListener((changes) => {
  if (changes.events) {
    // Newest events render at the top; stay pinned there unless the
    // user has scrolled down to inspect older events.
    const pinned = listEl.scrollTop < 40;
    allEvents = changes.events.newValue || [];
    render();
    if (pinned) listEl.scrollTop = 0;
  }
});

filterEl.addEventListener("input", render);

clearEl.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "clear-events" });
  allEvents = [];
  knownTimes = new Set();
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
  // Clear group state — different tab, different set of groups.
  groupOpenState.clear();
  render();
});

await initActiveTab();
load(true);
