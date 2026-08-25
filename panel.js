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

// Keys shown in the storage panel.
// conversioExperienceFired and conversioExperienceMap are deliberately absent:
// Fired just restates conversioExperienceList, and the Map is verbose detail.
// Both are still READ (see CONVERSIO_READ_KEYS) because QA validation needs
// them — they're only hidden from the panel.
const CONVERSIO_STORAGE_KEYS = [
  "conversioExperienceList",
  "conversioEventList",
  "conversio_vitals",
  "conversioVitalsPending",
  "conversioEmissionEnabled",
];

// Read but not displayed.
const CONVERSIO_HIDDEN_KEYS = [
  "conversioExperienceFired",
  "conversioExperienceMap",
];

// Earlier key names. Still read so older sites keep working, but only shown
// when actually present — otherwise they'd sit there as permanent "(not set)".
const CONVERSIO_LEGACY_KEYS = ["conversio_experiences", "conversio_events"];

// Rows worth collapsing when they are shown at all.
const CONVERSIO_COLLAPSIBLE_KEYS = new Set(["conversio_events"]);

// Kept expanded regardless of length — the fired events are the main thing
// you're watching, and the panel scrolls now if the list gets long.
const CONVERSIO_ALWAYS_EXPANDED_KEYS = new Set(["conversioEventList"]);

// "(not set)" is technically true but tells you nothing. For these keys the
// absence itself is the finding, so say what it means.
const CONVERSIO_EMPTY_LABELS = {
  conversioEmissionEnabled: "(session not started — no tag trigger yet)",
};

// Everything read from the page: displayed keys, hidden-but-needed keys, and
// the legacy names. Also the set that Clear wipes.
const CONVERSIO_ALL_STORAGE_KEYS = [
  ...CONVERSIO_STORAGE_KEYS,
  ...CONVERSIO_HIDDEN_KEYS,
  ...CONVERSIO_LEGACY_KEYS,
];

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

// Latest storage read, kept so the interaction counter can compare the codes
// Conversio has recorded against the hits actually sent to GA4.
let currentStorageData = null;

async function refreshStoragePanel() {
  const data = await readConversioStorage();
  currentStorageData = data;
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
      meta.textContent = count === null ? (CONVERSIO_EMPTY_LABELS[key] || "(not set)")
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
      row.appendChild(storageValueNode(val, CONVERSIO_EMPTY_LABELS[key]));
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
function storageValueNode(val, emptyLabel) {
  const emptyNode = (text) => {
    const s = document.createElement("span");
    s.className = "storage-empty-val";
    s.textContent = text;
    return s;
  };
  if (val === null || val === undefined) return emptyNode(emptyLabel || "(not set)");

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

  // Current consent state, taken from the most recent hit that carried gcs.
  // Consent can be granted mid-session, so the latest hit is what counts.
  let consent = null;
  for (const ev of tabGA4) {
    const c = parseConsent(ev);
    if (c && c.known) { consent = c; break; }
  }

  const stats = interactionStats(tabGA4);

  experiencesBarEl.innerHTML = "";
  const hasConversio = conversioExps.size > 0;
  const hasABTasty = abTastyTests.size > 0;
  const hasCounts = stats.perCode.size > 0 || stats.missing.length > 0;

  if (!hasConversio && !hasABTasty && !consent && !hasCounts) {
    experiencesBarEl.style.display = "none";
    return;
  }

  experiencesBarEl.style.display = "block";

  if (consent) {
    const block = document.createElement("div");
    block.className = "exp-block";
    const label = document.createElement("span");
    label.className = "exp-label";
    label.textContent = "Consent";
    block.appendChild(label);
    const chips = document.createElement("div");
    chips.className = "exp-chips";
    const chip = document.createElement("span");
    chip.className = "exp-chip exp-chip--consent-"
      + (consent.analyticsStorage ? "granted" : "denied");
    chip.textContent = consent.analyticsStorage
      ? `analytics granted · ${consent.raw}`
      : `analytics DENIED · ${consent.raw}`;
    chip.title = consent.analyticsStorage
      ? "analytics_storage granted — hits are processed by Analytics"
      : "analytics_storage denied — hits are still sent but Analytics won't process them";
    chips.appendChild(chip);
    block.appendChild(chips);
    experiencesBarEl.appendChild(block);
  }

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

  if (hasCounts) {
    const block = document.createElement("div");
    block.className = "exp-block";
    const label = document.createElement("span");
    label.className = "exp-label";
    label.textContent = "Interactions";
    block.appendChild(label);
    const chips = document.createElement("div");
    chips.className = "exp-chips";

    // One chip per event code with its hit count — the code is what you're
    // actually tracking, and a repeat firing shows as a higher count.
    for (const [, entry] of [...stats.perCode].sort((a, b) => a[0].localeCompare(b[0]))) {
      const chip = document.createElement("span");
      chip.className = "exp-chip exp-chip--count";
      chip.textContent = `${entry.display} · ${entry.hits}`;
      chip.title = `${entry.display} sent to GA4 ${entry.hits} time(s)`;
      chips.appendChild(chip);
    }

    // Recorded by Conversio but never sent to GA4 — the tag didn't fire.
    if (stats.missing.length) {
      const chip = document.createElement("span");
      chip.className = "exp-chip exp-chip--missing";
      chip.textContent = `${stats.missing.length} not sent to GA4`;
      chip.title = "In conversioEventList but no matching GA4 hit was seen:\n"
        + stats.missing.join(", ")
        + "\n\nThe interaction was recorded but the GA4 tag never fired.";
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

// The client's own tracking, as opposed to Conversio's. Prefix-based so
// client_cro and any future client_* event are both covered.
function isClientEvent(ev) {
  return ev.type !== "datalayer" && !!ev.name && ev.name.startsWith("client_");
}

// ---- experience QA ---------------------------------------------------
//
// Conversio segments come in two shapes:
//   experience   PREFIX.XCO / PREFIX.XV1   e.g. WN003.XCO, FN088.XV1
//   interaction  PREFIX + event code       e.g. WN003EV1G, FN089ECOC
// PREFIX is the client code plus experience number (WN003, FN088), which is
// what links an interaction back to the experience it belongs to.
// Everything after ".X" is the variant. Deliberately permissive: real variants
// include XCO, XV1, XV2 and suffixed forms like XV1R / XV2R, and a stricter
// pattern silently drops the ones it doesn't know — which reads as "no
// experience was ever recorded" and produces bogus ORDER failures.
const SEG_EXPERIENCE_RE = /^([A-Za-z]{2}\d{3})\.X([A-Za-z0-9_-]+)$/;
const SEG_INTERACTION_RE = /^([A-Za-z]{2}\d{3})([A-Za-z0-9_-]+)$/;

function segmentInfo(segment) {
  if (!segment) return null;
  const s = String(segment).trim();
  const exp = SEG_EXPERIENCE_RE.exec(s);
  if (exp) return { kind: "experience", prefix: exp[1].toUpperCase(), raw: s };
  const int = SEG_INTERACTION_RE.exec(s);
  if (int) return { kind: "interaction", prefix: int[1].toUpperCase(), raw: s };
  return { kind: "unknown", prefix: null, raw: s };
}

// Storage values arrive as arrays, JSON strings or comma-joined strings.
function toList(val) {
  if (val === null || val === undefined) return [];
  if (Array.isArray(val)) return val.map((v) => String(v).trim()).filter(Boolean);
  const s = String(val).trim();
  if (!s) return [];
  if (s.startsWith("[")) {
    try { return toList(JSON.parse(s)); } catch (e) { /* fall through */ }
  }
  return s.split(",").map((v) => v.trim()).filter(Boolean);
}

function experiencesFromParam(ev) {
  const raw = ev.eventParams?.conversio_experiences;
  return toList(raw);
}

// Validate a Conversio/client event against the storage state captured at the
// instant the hit was sent. Conversio writes the segment code into
// sessionStorage before the GA4 hit follows, so anything missing from that
// snapshot is a genuine ordering or wiring problem — not a timing artifact.
// prefix -> earliest time an experience hit for it was seen in the feed.
// Rebuilt each render; ordering is fundamentally about event sequence, so an
// experience we watched fire counts even if storage disagrees.
let experienceFirstSeen = new Map();

function buildExperienceTimeline(tabEvents) {
  const firstSeen = new Map();
  for (const ev of tabEvents) {
    if (!ev.name || !/^(conversio|client)_/.test(ev.name)) continue;
    const info = segmentInfo(ev.eventParams?.conversio_segment);
    if (!info || info.kind !== "experience") continue;
    const prev = firstSeen.get(info.prefix);
    if (prev === undefined || ev.time < prev) firstSeen.set(info.prefix, ev.time);
  }
  return firstSeen;
}

function checkExperienceQA(ev) {
  if (ev.type === "datalayer") return null;
  if (!ev.name || !/^(conversio|client)_/.test(ev.name)) return null;

  const info = segmentInfo(ev.eventParams?.conversio_segment);
  if (!info || info.kind === "unknown") return null;

  // No snapshot means the page hook missed this hit (webRequest caught it
  // instead). Unknown is not the same as broken — never flag it as a failure.
  if (!ev.storageAtHit) {
    return { status: "unverified", info, issues: [] };
  }

  const snap = ev.storageAtHit;
  const expList = toList(snap.conversioExperienceList ?? snap.conversio_experiences);
  const evtList = toList(snap.conversioEventList ?? snap.conversio_events);
  const firedMap = snap.conversioExperienceFired;
  const fired = firedMap && typeof firedMap === "object" && !Array.isArray(firedMap)
    ? Object.keys(firedMap) : [];
  const knownExps = [...expList, ...fired].map((s) => String(s).toUpperCase());

  const issues = [];

  if (info.kind === "interaction") {
    // The headline check: an interaction must never precede its experience.
    // Satisfied either by storage knowing the experience, or by us having
    // watched an experience hit for the same prefix fire earlier.
    const inStorage = knownExps.some((id) => id.startsWith(info.prefix));
    const firstSeen = experienceFirstSeen.get(info.prefix);
    const observedEarlier = firstSeen !== undefined && firstSeen <= ev.time;
    if (!inStorage && !observedEarlier) {
      issues.push({
        code: "ORDER",
        text: `${info.raw} fired before any ${info.prefix} experience was recorded`
          + " (experiences at hit time: "
          + (knownExps.length ? knownExps.join(", ") : "none") + ")",
      });
    }
    // Its own code should already be in the stored event list.
    if (!evtList.some((e) => String(e).toUpperCase() === info.raw.toUpperCase())) {
      issues.push({
        code: "MISMATCH",
        text: `${info.raw} is not in conversioEventList (`
          + (evtList.length ? evtList.join(", ") : "empty") + ")",
      });
    }
  }

  if (info.kind === "experience") {
    if (!knownExps.some((id) => id === info.raw.toUpperCase())) {
      issues.push({
        code: "MISMATCH",
        text: `${info.raw} is not in conversioExperienceList (`
          + (expList.length ? expList.join(", ") : "empty") + ")",
      });
    }
  }

  // The experiences the hit claims vs the ones storage knows about.
  for (const id of experiencesFromParam(ev)) {
    if (!knownExps.includes(id.toUpperCase())) {
      issues.push({
        code: "MISMATCH",
        text: `conversio_experiences lists ${id}, absent from storage at hit time`,
      });
    }
  }

  return { status: issues.length ? "fail" : "ok", info, issues };
}

// ---- interaction counter --------------------------------------------
//
// Counts interaction hits actually sent to GA4 and reconciles them against the
// codes Conversio recorded in sessionStorage. A code sitting in storage with no
// matching GA4 hit means the interaction happened but the tag never fired.
//
// The baseline matters: codes already in storage before DataSpy saw its first
// hit were recorded before we were watching, so they can't be counted as
// missing. Without this, pressing Clear (or opening the panel mid-session)
// would report every earlier code as lost.
function interactionStats(tabGA4) {
  // Keyed by uppercased code for matching, but the display form keeps the
  // casing as actually sent.
  const perCode = new Map();            // CODE -> { display, hits }
  const seenCodes = new Set();

  for (const ev of tabGA4) {
    if (!ev.name || !/^(conversio|client)_/.test(ev.name)) continue;
    const info = segmentInfo(ev.eventParams?.conversio_segment);
    if (!info || info.kind !== "interaction") continue;
    const key = info.raw.toUpperCase();
    const entry = perCode.get(key) || { display: info.raw, hits: 0 };
    entry.hits++;
    perCode.set(key, entry);
    seenCodes.add(key);
  }

  // Oldest hit carrying a snapshot defines what was already recorded.
  let baseline = [];
  for (let i = tabGA4.length - 1; i >= 0; i--) {
    const s = tabGA4[i].storageAtHit;
    if (s) {
      baseline = toList(s.conversioEventList ?? s.conversio_events)
        .map((c) => c.toUpperCase());
      break;
    }
  }

  const stored = currentStorageData
    ? toList(currentStorageData.conversioEventList ?? currentStorageData.conversio_events)
        .map((c) => c.toUpperCase())
    : [];

  const missing = stored.filter((c) => !seenCodes.has(c) && !baseline.includes(c));

  return { perCode, missing, storedCount: stored.length, seenCount: seenCodes.size };
}

// ---- consent state ---------------------------------------------------
//
// GA4 encodes consent in gcs=G1<ad_storage><analytics_storage>, 1 granted /
// 0 denied. Hits are still SENT when consent is denied, so the event showing
// up in the feed says nothing about whether Analytics will process it — gcs
// is the only way to tell. Already captured in allParams on every hit.
function parseConsent(ev) {
  const raw = ev.allParams?.gcs || "";
  if (!raw) return null;
  const m = /^G1(\d)(\d)$/.exec(raw);
  if (!m) return { raw, known: false };
  return { raw, known: true, adStorage: m[1] === "1", analyticsStorage: m[2] === "1" };
}

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

  const nameEl = node.querySelector(".event-name");
  nameEl.textContent = ev.name;
  node.querySelector(".event-meta").textContent = timeLabel(ev.time);

  // The client's own CRO events (client_cro) sit alongside Conversio's and are
  // easy to confuse at a glance, so give them their own colour.
  if (isClientEvent(ev)) {
    details.classList.add("event--client");
    nameEl.classList.add("event-name--client");
  }

  if (warn) {
    const icon = document.createElement("span");
    icon.className = "event-warn";
    icon.title = "Multiple Conversio events fired at the same time";
    icon.textContent = "⚠";
    node.querySelector("summary").insertBefore(icon, node.querySelector(".event-meta"));
  }

  const segment = ev.eventParams?.conversio_segment || "";
  // Uses segmentInfo so the badge and the QA validator can never disagree
  // about what counts as an experience segment.
  if (segment.endsWith("Q")) {
    const badge = document.createElement("span");
    badge.className = "trigger-badge";
    badge.textContent = "TRIGGER";
    node.querySelector("summary").insertBefore(badge, node.querySelector(".event-meta"));
  } else if (segmentInfo(segment)?.kind === "experience") {
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

  // Experience QA: one badge per distinct issue type, so ORDER and MISMATCH
  // are visible without expanding the row.
  const qa = checkExperienceQA(ev);
  if (qa && qa.status === "fail") {
    for (const code of [...new Set(qa.issues.map((i) => i.code))]) {
      const badge = document.createElement("span");
      badge.className = "qa-badge";
      badge.textContent = code;
      badge.title = qa.issues.filter((i) => i.code === code).map((i) => i.text).join("\n");
      node.querySelector("summary").insertBefore(badge, node.querySelector(".event-meta"));
    }
  }

  // Flag only DENIED analytics consent. Granted is the normal case and a
  // badge on every row would just be noise — the decoded state is always
  // available in the body.
  const consent = parseConsent(ev);
  if (consent && consent.known && !consent.analyticsStorage) {
    const badge = document.createElement("span");
    badge.className = "consent-badge";
    badge.textContent = "NO CONSENT";
    badge.title = `analytics_storage denied (gcs=${consent.raw}) — the hit was sent but Analytics won't process it`;
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

  // Conversio storage as it stood when this hit was sent. Only Conversio
  // events care, and only when the page hook captured it.
  if (ev.storageAtHit && ev.name && /^(conversio|client)_/.test(ev.name)) {
    const snap = ev.storageAtHit;
    const fmt = (v) => {
      if (v === null || v === undefined) return "(not set)";
      if (Array.isArray(v)) return v.length ? v.join(", ") : "(empty)";
      if (typeof v === "object") {
        const ks = Object.keys(v);
        return ks.length ? ks.join(", ") : "(empty)";
      }
      return String(v);
    };
    const rows = [
      ["experiences", fmt(snap.conversioExperienceList ?? snap.conversio_experiences)],
      ["events", fmt(snap.conversioEventList ?? snap.conversio_events)],
    ];
    body.appendChild(section("Storage at hit", rows, "section-label--meta"));
  }

  // QA detail: why the badges fired, or why we couldn't judge.
  if (qa && qa.status === "fail") {
    const frag = document.createDocumentFragment();
    const lab = document.createElement("div");
    lab.className = "section-label section-label--qa";
    lab.textContent = "QA issues";
    frag.appendChild(lab);
    for (const issue of qa.issues) {
      const row = document.createElement("div");
      row.className = "kv kv--qa";
      const k = document.createElement("span");
      k.className = "k";
      k.textContent = issue.code;
      const v = document.createElement("span");
      v.className = "v";
      v.textContent = issue.text;
      row.append(k, v);
      frag.appendChild(row);
    }
    body.appendChild(frag);
  } else if (qa && qa.status === "unverified") {
    const note = document.createElement("div");
    note.className = "qa-unverified";
    note.textContent = "QA not verified — no storage snapshot for this hit";
    note.title = "The hit was captured by webRequest rather than the page hook, "
      + "so the sessionStorage state at send time is unknown.";
    body.appendChild(note);
  }

  // Decoded consent state, shown for every GA4 hit that carries gcs.
  if (consent) {
    const rows = consent.known
      ? [
          ["analytics_storage", consent.analyticsStorage ? "granted" : "denied"],
          ["ad_storage", consent.adStorage ? "granted" : "denied"],
          ["gcs", consent.raw],
        ]
      : [["gcs", consent.raw + " (unrecognised format)"]];
    const frag = section("Consent", rows, "section-label--meta");
    // Colour the analytics_storage value by state — it's the one that decides
    // whether the hit counts.
    if (consent.known) {
      const first = frag.querySelector(".kv .v");
      if (first) first.classList.add(consent.analyticsStorage ? "v--granted" : "v--denied");
    }
    body.appendChild(frag);
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

  // Must be built before any row renders — the ORDER check reads it.
  experienceFirstSeen = buildExperienceTimeline(tabEvents);

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
