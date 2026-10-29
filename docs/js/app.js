/* Pytri: browser-only implementation of the Flask API/model.
   The original Flask app exposes a REST wrapper around petri.py.
   This file replaces that wrapper with an in-browser model, so GitHub Pages
   can run the application without a Python server. */

const svg = document.getElementById('svg');
const arcsLayer = document.getElementById('arcs-layer');
const guidesLayer = document.getElementById('guides-layer');
const nodesLayer = document.getElementById('nodes-layer');
const handlesLayer = document.getElementById('handles-layer');
const hint = document.getElementById('hint');
const errorBox = document.getElementById('error');
const inspector = document.getElementById('inspector');
const STORAGE_KEY = 'pytri-net-v1';
const SHORT_DESC_DEFAULT_DY = 64;   // just below the transition's name label (at +46)
const SETTINGS_KEY = 'pytri-settings-v1';

// Settings ------------------------------------------------------------------
// To add a setting: append an entry here. The settings dialog is built from
// this list, defaults are filled in automatically and values persist in
// localStorage. Supported types: 'choice' (options: [{value,label,description}])
// and 'boolean'.
const SETTINGS_SCHEMA = [
  {
    key: 'stateDeleteNaming',
    type: 'choice',
    label: 'When a place is deleted',
    default: 'reuse',
    options: [
      {
        value: 'reuse',
        label: 'Reuse the freed name',
        description: 'Other places keep their names. The deleted name (e.g. p2) is given to the next place you create.'
      },
      {
        value: 'renumber',
        label: 'Rename the places below it',
        description: 'Higher-numbered places shift down to close the gap, lowest first (deleting p2 turns p3 into p2, p4 into p3, ...).'
      }
    ]
  },
  {
    key: 'arcShape',
    type: 'choice',
    label: 'Arc shape',
    default: 'straight',
    options: [
      {
        value: 'straight',
        label: 'Straight lines',
        description: 'Arcs are straight. Drag a selected arc to break it into bent segments (bend points snap, so lines can be made horizontal or vertical). Two opposite arcs between the same nodes are bent apart.'
      },
      {
        value: 'spline',
        label: 'Smooth splines',
        description: 'Arcs are drawn as smooth curves that leave and enter nodes perpendicular to their edge. Drag a selected arc, or its two handles, to reshape it.'
      }
    ]
  },
  {
    key: 'hideArcNames',
    type: 'boolean',
    label: 'Arc names',
    description: 'Hide all arc names on the graph (weights above 1 stay visible)',
    default: false
  }
];

function loadSettings() {
  const out = {};
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') || {}; } catch (_) {}
  for (const def of SETTINGS_SCHEMA) {
    let value = saved[def.key];
    if (def.type === 'choice' && !def.options.some(o => o.value === value)) value = def.default;
    if (def.type === 'boolean' && typeof value !== 'boolean') value = def.default;
    out[def.key] = value;
  }
  return out;
}

function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (_) {}
}

let settings = loadSettings();

let mode = 'select';
let netData = emptyNet('Untitled Net');
let arcSource = null;
let selected = null;
let dragging = null;
let draggingLabel = null;
let draggingCurve = null;   // reshaping a spline arc: its handles or the curve body
let panning = null;
let dragMoved = false;
let matrixView = 'incidence';
let matrixOpen = false;
// Whether the options panel (inspector) is open. Despite the legacy name this
// drives both layouts: the bottom sheet on mobile and the sidebar panel on desktop.
let mobileInspectorOpen = false;
const isMobileLayout = () => window.matchMedia('(max-width: 700px)').matches;

const MAX_HISTORY = 80;
let history = [];
let historyIndex = -1;
let restoringHistory = false;

const BASE_WIDTH = 2000;
const BASE_HEIGHT = 1400;
const MIN_ZOOM = 0.3;
const MAX_ZOOM = 3.0;
const ZOOM_STEP = 0.15;
let currentZoomLevel = 1.0;

const HINTS = {
  select: 'Click a node or arc to inspect/edit it. Drag a node body to move it, or drag its label to reposition just the text.',
  state: 'Click on the canvas to place a new State (a place that holds tokens).',
  transition: 'Click on the canvas to place a firing transition.',
  arc: 'Click a source node, then a target node, to connect them with an arc.'
};

function emptyNet(name) {
  return {
    name,
    description: '',          // free text about the whole net (edited in "Net description")
    states: [],
    transitions: [],
    arcs: [],
    counters: { state: 0, transition: 0, arc: 0 }
  };
}

// Name allocation is deliberately split into "suggest" and "commit".
// A failed/cancelled name dialog must NOT consume the next number.
// Removed automatic names are kept in a reuse buffer, matching petri.py's
// _removed_*_names behaviour.
const renameBuffer = { state: [], transition: [], arc: [] };

function nameTaken(name) {
  return !!findNode(name) || netData.arcs.some(arc => arc.name === name);
}

function syncRenameBuffer() {
  // Imported/old localStorage data may not have the buffer. Keep only names
  // that are currently free and unique.
  for (const kind of Object.keys(renameBuffer)) {
    renameBuffer[kind] = [...new Set(renameBuffer[kind])].filter(n => !nameTaken(n));
  }
}

function autoNumber(kind, name) {
  const prefix = kind === 'state' ? 'p' : kind === 'transition' ? 't' : 'a';
  const match = new RegExp(`^${prefix}(\\d+)$`).exec(name);
  return match ? Number(match[1]) : null;
}

function suggestName(kind) {
  syncRenameBuffer();
  // Freed names are handed out lowest-first (p2 before p5), regardless of
  // the order in which they were deleted.
  if (renameBuffer[kind].length) {
    return [...renameBuffer[kind]].sort((a, b) =>
      (autoNumber(kind, a) ?? Infinity) - (autoNumber(kind, b) ?? Infinity))[0];
  }

  const prefix = kind === 'state' ? 'p' : kind === 'transition' ? 't' : 'a';
  let seq = Number(netData.counters[kind] || 0);
  while (nameTaken(`${prefix}${seq + 1}`)) seq++;
  return `${prefix}${seq + 1}`;
}

function commitName(kind, name) {
  // A name from the reuse buffer is consumed only after successful creation.
  const bufferIndex = renameBuffer[kind].indexOf(name);
  if (bufferIndex >= 0) {
    renameBuffer[kind].splice(bufferIndex, 1);
    return;
  }

  const prefix = kind === 'state' ? 'p' : kind === 'transition' ? 't' : 'a';
  const match = new RegExp(`^${prefix}(\\d+)$`).exec(name);
  if (match) netData.counters[kind] = Math.max(netData.counters[kind], Number(match[1]));
}

function rememberRemovedName(kind, name) {
  const prefix = kind === 'state' ? 'p' : kind === 'transition' ? 't' : 'a';
  if (new RegExp(`^${prefix}\\d+$`).test(name) && !renameBuffer[kind].includes(name)) {
    renameBuffer[kind].push(name);
  }
}

function findNode(name) {
  return netData.states.find(s => s.name === name) ||
         netData.transitions.find(transition => transition.name === name) || null;
}

function nodeKind(name) {
  if (netData.states.some(s => s.name === name)) return 'state';
  if (netData.transitions.some(transition => transition.name === name)) return 'transition';
  return null;
}

function restoreRenameBuffer(saved, legacyFormat = false) {
  renameBuffer.state = Array.isArray(saved?.state) ? saved.state.map(String) : [];
  renameBuffer.transition = Array.isArray(saved?.transition)
    ? saved.transition.map(String)
    : Array.isArray(saved?.action) ? saved.action.map(String) : [];
  renameBuffer.arc = Array.isArray(saved?.arc)
    ? saved.arc.map(String)
    : legacyFormat && Array.isArray(saved?.transition) ? saved.transition.map(String) : [];
}

function showError(msg) {
  errorBox.textContent = msg;
  errorBox.style.display = 'block';
  clearTimeout(showError._t);
  showError._t = setTimeout(() => errorBox.style.display = 'none', 3500);
}

function snapshot() {
  // The reuse buffer is part of the editor state. Without saving it here,
  // Ctrl+Z/redo and page reloads silently lose deleted automatic names.
  return JSON.stringify({
    net: netData,
    renameBuffer: {
      state: [...renameBuffer.state],
      transition: [...renameBuffer.transition],
      arc: [...renameBuffer.arc]
    }
  });
}

function saveLocal(recordHistory = true) {
  const snap = snapshot();
  localStorage.setItem(STORAGE_KEY, snap);
  if (!recordHistory || restoringHistory) return;
  if (historyIndex >= 0 && history[historyIndex] === snap) return;
  history = history.slice(0, historyIndex + 1);
  history.push(snap);
  if (history.length > MAX_HISTORY) history.shift();
  historyIndex = history.length - 1;
}

function restoreSnapshot(snap) {
  restoringHistory = true;
  const parsed = JSON.parse(snap);
  if (parsed && parsed.net && parsed.net.states) {
    netData = normalizeNet(parsed.net);
    restoreRenameBuffer(parsed.renameBuffer, !Array.isArray(parsed.net.arcs));
  } else {
    // Backwards compatibility with snapshots from the previous static build.
    netData = normalizeNet(parsed);
    restoreRenameBuffer(null);
  }
  syncRenameBuffer();
  localStorage.setItem(STORAGE_KEY, snapshot());
  selected = null;
  arcSource = null;
  restoringHistory = false;
  render();
}

function undo() {
  if (historyIndex <= 0) return;
  historyIndex--;
  restoreSnapshot(history[historyIndex]);
}

function redo() {
  if (historyIndex >= history.length - 1) return;
  historyIndex++;
  restoreSnapshot(history[historyIndex]);
}

function initHistory() {
  history = [snapshot()];
  historyIndex = 0;
}

function loadLocal() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    // Accept both the current wrapped format and older exports/localStorage.
    if (parsed && parsed.net && parsed.net.states) {
      netData = normalizeNet(parsed.net);
      restoreRenameBuffer(parsed.renameBuffer, !Array.isArray(parsed.net.arcs));
    } else {
      netData = normalizeNet(parsed);
      restoreRenameBuffer(parsed?._editor?.renameBuffer, !Array.isArray(parsed?.arcs));
    }
    syncRenameBuffer();
  } catch (e) {
    showError('Saved net could not be loaded.');
  }
}

// A hand-shaped spline arc stores how far each Bezier control point was dragged
// away from its automatic position, so the shape follows when nodes move.
function normalizeCurve(curve) {
  if (!curve) return null;
  const v = [curve.c1x, curve.c1y, curve.c2x, curve.c2y].map(Number);
  if (!v.every(Number.isFinite) || v.every(n => n === 0)) return null;
  return { c1x: v[0], c1y: v[1], c2x: v[2], c2y: v[3] };
}

// Bend points of a straight arc ("broken" line): absolute canvas positions.
function normalizePoints(points) {
  if (!Array.isArray(points)) return [];
  return points
    .map(p => ({ x: Number(p?.x), y: Number(p?.y) }))
    .filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
}

function normalizeNet(data) {
  const n = emptyNet(data?.name || 'Untitled Net');
  n.description = String(data?.description ?? '');
  const legacyFormat = !Array.isArray(data?.arcs);
  const transitionData = legacyFormat ? data?.actions : data?.transitions;
  const arcData = legacyFormat ? data?.transitions : data?.arcs;
  n.states = Array.isArray(data?.states) ? data.states.map((s, i) => ({
    name: String(s.name ?? `p${i + 1}`),
    description: String(s.description ?? ''),
    ficha_count: Math.max(0, Number(s.ficha_count ?? 0)),
    x: Number(s.x ?? 80),
    y: Number(s.y ?? 80),
    rotation: Number(s.rotation ?? 0),
    label_dx: Number(s.label_dx ?? 0),
    label_dy: Number(s.label_dy ?? 46)
  })) : [];
  n.transitions = Array.isArray(transitionData) ? transitionData.map((transition, i) => ({
    name: String(transition.name ?? `t${i + 1}`),
    description: String(transition.description ?? ''),
    enum: transition.enum ?? null,
    type: transition.type ?? 'normal',
    x: Number(transition.x ?? 240),
    y: Number(transition.y ?? 80),
    rotation: Number(transition.rotation ?? 0),
    label_dx: Number(transition.label_dx ?? 0),
    label_dy: Number(transition.label_dy ?? 46),
    // Optional one-line caption that can be drawn on the graph. It is separate
    // from `description`, which is never drawn.
    short_description: String(transition.short_description ?? ''),
    show_short_description: transition.show_short_description === true,
    short_dx: Number(transition.short_dx ?? 0),
    short_dy: Number(transition.short_dy ?? SHORT_DESC_DEFAULT_DY)
  })) : [];
  n.arcs = Array.isArray(arcData) ? arcData.map((arc, i) => ({
    name: String(arc.name ?? `a${i + 1}`),
    description: String(arc.description ?? ''),
    source: String(arc.source),
    target: String(arc.target),
    weight: Math.max(1, parseInt(arc.weight ?? 1, 10) || 1),
    arc_type: ['normal', 'inhibitor', 'read'].includes(arc.arc_type) ? arc.arc_type : 'normal',
    label_dx: Number(arc.label_dx ?? 6),
    label_dy: Number(arc.label_dy ?? -6),
    curve: normalizeCurve(arc.curve),
    points: normalizePoints(arc.points)
  })) : [];
  n.counters = {
    state: Number(data?.counters?.state ?? 0),
    transition: Number(data?.counters?.transition ?? data?.counters?.action ?? 0),
    arc: Number(data?.counters?.arc ?? (legacyFormat ? data?.counters?.transition : 0) ?? 0)
  };
  // Make counters at least large enough to avoid collisions after imports.
  for (const s of n.states) {
    const m = /^p(\d+)$/.exec(s.name); if (m) n.counters.state = Math.max(n.counters.state, +m[1]);
  }
  for (const transition of n.transitions) {
    const m = /^t(\d+)$/.exec(transition.name); if (m) n.counters.transition = Math.max(n.counters.transition, +m[1]);
  }
  for (const arc of n.arcs) {
    const m = /^a(\d+)$/.exec(arc.name); if (m) n.counters.arc = Math.max(n.counters.arc, +m[1]);
  }
  return n;
}

function netPayload() {
  return {
    name: netData.name,
    states: netData.states,
    transitions: netData.transitions.map(transition => ({...transition, enabled: isEnabled(transition.name)})),
    arcs: netData.arcs
  };
}

function isEnabled(transitionName) {
  const transition = netData.transitions.find(item => item.name === transitionName);
  if (!transition) throw new Error(`Transition '${transitionName}' does not exist.`);
  const pre = netData.arcs.filter(arc =>
    arc.target === transitionName && nodeKind(arc.source) === 'state'
  );
  for (const arc of pre) {
    const state = findNode(arc.source);
    if (arc.arc_type === 'inhibitor') {
      if (state.ficha_count >= arc.weight) return false;
    } else {
      if (state.ficha_count < arc.weight) return false;
    }
  }
  return true;
}

function validateUniqueNodeName(name, oldName = null) {
  if (!name) throw new Error('A name is required.');
  if (name !== oldName && findNode(name)) throw new Error(`'${name}' is already in use.`);
}

function addState(name, description, x, y) {
  validateUniqueNodeName(name);
  commitName('state', name);
  netData.states.push({
    name, description, ficha_count: 0, x, y,
    rotation: 0, label_dx: 0, label_dy: 46
  });
  saveLocal(); render();
}

function addTransition(name, description, x, y) {
  validateUniqueNodeName(name);
  commitName('transition', name);
  netData.transitions.push({
    name, description, enum: netData.transitions.length, type: 'normal', x, y,
    rotation: 0, label_dx: 0, label_dy: 46,
    short_description: '', show_short_description: false,
    short_dx: 0, short_dy: SHORT_DESC_DEFAULT_DY
  });
  saveLocal(); render();
}

function addArc(name, description, source, target, weight, arc_type) {
  validateUniqueName(name);
  const sourceKind = nodeKind(source), targetKind = nodeKind(target);
  if (!((sourceKind === 'state' && targetKind === 'transition') ||
        (sourceKind === 'transition' && targetKind === 'state'))) {
    throw new Error('Petri nets are bipartite: an arc must connect a State to a Transition, or a Transition to a State.');
  }
  if (netData.arcs.some(arc => arc.source === source && arc.target === target)) {
    throw new Error(`An arc from '${source}' to '${target}' already exists.`);
  }
  if (!['normal', 'inhibitor', 'read'].includes(arc_type)) arc_type = 'normal';
  if (sourceKind !== 'state') arc_type = 'normal';
  if (!Number.isInteger(weight) || weight < 1) throw new Error('Arc weight must be a positive integer.');
  // Only consume/increment the name allocator after the operation is known
  // to be valid. A failed arc creation must leave the suggestion untouched.
  commitName('arc', name);
  netData.arcs.push({
    name, description, source, target, weight, arc_type,
    label_dx: 6, label_dy: -6, curve: null, points: []
  });
  saveLocal(); render();
}

function validateUniqueName(name) {
  if (!name) throw new Error('A name is required.');
  if (findNode(name) || netData.arcs.some(arc => arc.name === name))
    throw new Error(`'${name}' is already in use.`);
}

function renameNode(oldName, newName) {
  validateUniqueNodeName(newName, oldName);
  const node = findNode(oldName);
  if (!node) throw new Error(`No node named '${oldName}'.`);
  // Renaming an automatically allocated node frees its old name for reuse,
  // just like deleting it. A failed/duplicate rename reaches none of this.
  rememberRemovedName(nodeKind(oldName), oldName);
  node.name = newName;
  for (const arc of netData.arcs) {
    if (arc.source === oldName) arc.source = newName;
    if (arc.target === oldName) arc.target = newName;
  }
  if (selected) selected.name = newName;
  saveLocal(); render();
}

// Shift every auto-named place numbered above `deletedNumber` down by one,
// lowest first, so the numbering stays contiguous (p3 -> p2, p4 -> p3, ...).
function renumberStatesAfter(deletedNumber) {
  const shifting = netData.states
    .map(state => ({ state, n: autoNumber('state', state.name) }))
    .filter(item => item.n !== null && item.n > deletedNumber)
    .sort((a, b) => a.n - b.n);
  for (const { state, n } of shifting) {
    const oldName = state.name;
    const newName = `p${n - 1}`;
    if (nameTaken(newName)) continue;
    state.name = newName;
    for (const arc of netData.arcs) {
      if (arc.source === oldName) arc.source = newName;
      if (arc.target === oldName) arc.target = newName;
    }
    if (selected?.name === oldName) selected.name = newName;
  }
  const numbers = netData.states
    .map(state => autoNumber('state', state.name))
    .filter(n => n !== null);
  netData.counters.state = numbers.length ? Math.max(...numbers) : 0;
  renameBuffer.state = renameBuffer.state.filter(n =>
    !nameTaken(n) && (autoNumber('state', n) ?? 0) <= netData.counters.state);
}

function removeNode(name) {
  const kind = nodeKind(name);
  if (!kind) throw new Error(`No node named '${name}'.`);
  const deletedNumber = kind === 'state' ? autoNumber('state', name) : null;
  const renumber = settings.stateDeleteNaming === 'renumber' && deletedNumber !== null;
  // In renumber mode the gap is closed immediately, so the name is not kept
  // for reuse.
  if (!renumber) rememberRemovedName(kind, name);
  // Deleting a node also deletes its arcs. Those arc names are reusable too.
  for (const arc of netData.arcs) {
    if (arc.source === name || arc.target === name) rememberRemovedName('arc', arc.name);
  }
  netData.arcs = netData.arcs.filter(arc => arc.source !== name && arc.target !== name);
  if (kind === 'state') netData.states = netData.states.filter(s => s.name !== name);
  else netData.transitions = netData.transitions.filter(transition => transition.name !== name);
  if (selected?.name === name) selected = null;
  if (renumber) renumberStatesAfter(deletedNumber);
  saveLocal(); render();
}

function removeArc(name) {
  const before = netData.arcs.length;
  netData.arcs = netData.arcs.filter(arc => arc.name !== name);
  if (before === netData.arcs.length) throw new Error(`Arc '${name}' does not exist.`);
  rememberRemovedName('arc', name);
  if (selected?.name === name) selected = null;
  saveLocal(); render();
}

function addFicha(name, delta) {
  const state = netData.states.find(s => s.name === name);
  if (!state) throw new Error(`State '${name}' does not exist.`);
  const next = state.ficha_count + delta;
  if (next < 0) throw new Error(`Cannot remove ${Math.abs(delta)} ficha(s) from '${name}'; only ${state.ficha_count} available.`);
  state.ficha_count = next;
  saveLocal(); render();
}

function fireTransition(name) {
  if (!isEnabled(name)) throw new Error(`Transition '${name}' is not enabled -- a precondition on one of its input places is not satisfied.`);
  const pre = netData.arcs.filter(arc => arc.target === name && nodeKind(arc.source) === 'state');
  const post = netData.arcs.filter(arc => arc.source === name && nodeKind(arc.target) === 'state');
  for (const arc of pre) {
    if (arc.arc_type === 'normal') findNode(arc.source).ficha_count -= arc.weight;
  }
  for (const arc of post) findNode(arc.target).ficha_count += arc.weight;
  saveLocal(); render();
}

function exportNet() {
  const out = JSON.parse(JSON.stringify(netData));
  // Keep the Petri model fields compatible with Python and store editor-only
  // state under a private metadata key. Python's from_dict simply ignores it.
  delete out.counters;
  out._editor = {
    renameBuffer: {
      state: [...renameBuffer.state],
      transition: [...renameBuffer.transition],
      arc: [...renameBuffer.arc]
    }
  };
  const blob = new Blob([JSON.stringify(out, null, 2)], {type: 'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const safeName = (netData.name || 'Untitled_Net').replace(/\s+/g, '_');
  a.href = url; a.download = `${safeName}.json`; a.click();
  URL.revokeObjectURL(url);
}

async function importNet(file) {
  const parsed = JSON.parse(await file.text());
  if (parsed && parsed.net && parsed.net.states) {
    netData = normalizeNet(parsed.net);
    restoreRenameBuffer(parsed.renameBuffer, !Array.isArray(parsed.net.arcs));
  } else {
    netData = normalizeNet(parsed);
    restoreRenameBuffer(parsed?._editor?.renameBuffer, !Array.isArray(parsed?.arcs));
  }
  syncRenameBuffer();
  selected = null;
  saveLocal(); render();
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  document.getElementById('theme-toggle').textContent =
    theme === 'dark' ? '☀ Light mode' : '🌙 Dark mode';
}

applyTheme(localStorage.getItem('petri-theme') || 'light');
document.getElementById('theme-toggle').onclick = () => {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  localStorage.setItem('petri-theme', next);
  applyTheme(next);
};



const matrixModal = document.getElementById('matrix-modal');
const reachabilityModal = document.getElementById('reachability-modal');
const REACHABILITY_MAX_STATES = 240;
const REACHABILITY_MAX_DEPTH = 36;
function openMatrices() {
  matrixOpen = true;
  matrixModal.hidden = false;
  renderMatrices();
  document.getElementById('matrix-close').focus();
}
function closeMatrices() {
  matrixOpen = false;
  matrixModal.hidden = true;
}
document.getElementById('matrix-toggle').onclick = openMatrices;
document.getElementById('matrix-close').onclick = closeMatrices;
document.getElementById('matrix-backdrop').onclick = closeMatrices;
document.getElementById('matrix-incidence-tab').onclick = () => {
  matrixView = 'incidence';
  document.getElementById('matrix-incidence-tab').classList.add('active');
  document.getElementById('matrix-output-tab').classList.remove('active');
  renderMatrices();
};
document.getElementById('matrix-output-tab').onclick = () => {
  matrixView = 'output';
  document.getElementById('matrix-output-tab').classList.add('active');
  document.getElementById('matrix-incidence-tab').classList.remove('active');
  renderMatrices();
};

function openReachability() {
  reachabilityModal.hidden = false;
  renderReachability();
  document.getElementById('reachability-close').focus();
}
function closeReachability() { reachabilityModal.hidden = true; }
document.getElementById('reachability-toggle').onclick = openReachability;
document.getElementById('reachability-close').onclick = closeReachability;
document.getElementById('reachability-backdrop').onclick = closeReachability;

function computeReachability() {
  const states = netData.states;
  const stateIndex = new Map(states.map((state, index) => [state.name, index]));
  const initialMarking = states.map(state => state.ficha_count);
  const omegaAccelerationDisabled = netData.arcs.some(arc => arc.arc_type === 'inhibitor');
  const root = { id: 0, parentId: null, transition: null, marking: initialMarking, depth: 0 };
  root.ancestorPath = [{ id: root.id, marking: root.marking }];
  const nodes = [root];
  let truncated = false;
  const transitionArcs = netData.transitions.map(transition => ({
    transition,
    inputArcs: netData.arcs.filter(arc =>
      arc.target === transition.name && stateIndex.has(arc.source)
    ),
    outputArcs: netData.arcs.filter(arc =>
      arc.source === transition.name && stateIndex.has(arc.target)
    )
  }));

  for (let queueIndex = 0; queueIndex < nodes.length; queueIndex++) {
    const sourceNode = nodes[queueIndex];
    if (sourceNode.terminal) continue;
    for (const { transition, inputArcs, outputArcs } of transitionArcs) {
      const enabled = inputArcs.every(arc => {
        const tokens = sourceNode.marking[stateIndex.get(arc.source)];
        return arc.arc_type === 'inhibitor'
          ? tokens < arc.weight
          : tokens >= arc.weight;
      });
      if (!enabled) continue;

      if (nodes.length >= REACHABILITY_MAX_STATES || sourceNode.depth >= REACHABILITY_MAX_DEPTH) {
        truncated = true;
        continue;
      }

      const marking = sourceNode.marking.slice();
      for (const arc of inputArcs) {
        if (arc.arc_type === 'normal') marking[stateIndex.get(arc.source)] -= arc.weight;
      }
      for (const arc of outputArcs) marking[stateIndex.get(arc.target)] += arc.weight;

      let changed = !omegaAccelerationDisabled;
      while (changed) {
        changed = false;
        for (const ancestor of sourceNode.ancestorPath) {
          const coversAncestor = marking.every((tokens, index) => tokens >= ancestor.marking[index]);
          if (!coversAncestor) continue;
          for (let index = 0; index < marking.length; index++) {
            if (Number.isFinite(marking[index]) && marking[index] > ancestor.marking[index]) {
              marking[index] = Infinity;
              changed = true;
            }
          }
        }
      }

      const repeatedAncestor = sourceNode.ancestorPath.find(ancestor =>
        marking.every((tokens, index) => tokens === ancestor.marking[index])
      );
      const node = {
        id: nodes.length,
        parentId: sourceNode.id,
        transition: transition.name,
        marking,
        depth: sourceNode.depth + 1,
        terminal: repeatedAncestor ? 'repeat' : null,
        repeatOf: repeatedAncestor?.id ?? null,
        ancestorPath: sourceNode.ancestorPath.concat([{ id: nodes.length, marking }])
      };
      nodes.push(node);
    }
  }

  const distinctMarkings = new Set(nodes.map(node =>
    node.marking.map(tokens => tokens === Infinity ? 'w' : String(tokens)).join(',')
  )).size;
  return { nodes, distinctMarkings, truncated, omegaAccelerationDisabled };
}

function renderReachability() {
  const content = document.getElementById('reachability-content');
  const status = document.getElementById('reachability-status');
  const { nodes, distinctMarkings, truncated, omegaAccelerationDisabled } = computeReachability();
  const edges = nodes.filter(node => node.parentId !== null).map(node => ({
    source: node.parentId,
    target: node.id,
    transition: node.transition
  }));
  const repeatCount = nodes.filter(node => node.terminal === 'repeat').length;
  const placeOrder = netData.states.map(state => state.name).join(', ') || 'no places';
  status.textContent = `${nodes.length} tree nodes · ${distinctMarkings} distinct markings · ${repeatCount} terminal repeats · ${edges.length} firings · Place order: ${placeOrder}${omegaAccelerationDisabled ? ' · Omega acceleration is disabled for inhibitor arcs.' : ''}${truncated ? ` · Stopped at ${REACHABILITY_MAX_STATES} nodes or depth ${REACHABILITY_MAX_DEPTH}; graph is incomplete.` : ''}`;

  const layers = [];
  for (const node of nodes) (layers[node.depth] ||= []).push(node);
  const nodeWidth = 184, nodeHeight = 78, gapX = 104, gapY = 32, margin = 32;
  const graphWidth = margin * 2 + layers.length * nodeWidth + Math.max(0, layers.length - 1) * gapX;
  const tallestLayer = Math.max(1, ...layers.map(layer => layer.length));
  const graphHeight = margin * 2 + tallestLayer * nodeHeight + (tallestLayer - 1) * gapY;
  const positions = new Map();
  for (let depth = 0; depth < layers.length; depth++) {
    layers[depth].forEach((node, row) => positions.set(node.id, {
      x: margin + depth * (nodeWidth + gapX),
      y: margin + row * (nodeHeight + gapY)
    }));
  }

  const graph = document.createElementNS(svg.namespaceURI, 'svg');
  graph.classList.add('reachability-graph');
  graph.setAttribute('viewBox', `0 0 ${graphWidth} ${graphHeight}`);
  graph.setAttribute('width', graphWidth);
  graph.setAttribute('height', graphHeight);
  graph.setAttribute('role', 'img');
  graph.setAttribute('aria-label', 'Coverability tree with markings as nodes and transitions as directed edges');

  const defs = document.createElementNS(svg.namespaceURI, 'defs');
  const arrow = document.createElementNS(svg.namespaceURI, 'marker');
  arrow.setAttribute('id', 'reachability-arrow');
  arrow.setAttribute('viewBox', '0 0 8 8');
  arrow.setAttribute('refX', '7');
  arrow.setAttribute('refY', '4');
  arrow.setAttribute('markerWidth', '7');
  arrow.setAttribute('markerHeight', '7');
  arrow.setAttribute('orient', 'auto');
  const arrowHead = document.createElementNS(svg.namespaceURI, 'path');
  arrowHead.setAttribute('d', 'M 0 0 L 8 4 L 0 8 z');
  arrowHead.classList.add('reachability-arrowhead');
  arrow.appendChild(arrowHead);
  defs.appendChild(arrow);
  graph.appendChild(defs);

  for (const edge of edges) {
    const source = positions.get(edge.source);
    const target = positions.get(edge.target);
    const sameNode = edge.source === edge.target;
    const startX = sameNode ? source.x + nodeWidth / 2 - 25 : source.x + nodeWidth;
    const endX = sameNode ? source.x + nodeWidth / 2 + 25 : target.x;
    const startY = sameNode ? source.y : source.y + nodeHeight / 2;
    const endY = sameNode ? target.y : target.y + nodeHeight / 2;
    let pathData, labelX, labelY;
    if (sameNode) {
      pathData = `M ${startX} ${startY} C ${startX - 35} ${startY - 66}, ${endX + 35} ${endY - 66}, ${endX} ${endY}`;
      labelX = source.x + nodeWidth / 2;
      labelY = source.y - 38;
    } else if (endX > startX + 20) {
      const bend = (endX - startX) * 0.45;
      pathData = `M ${startX} ${startY} C ${startX + bend} ${startY}, ${endX - bend} ${endY}, ${endX} ${endY}`;
      labelX = (startX + endX) / 2;
      labelY = (startY + endY) / 2 - 8;
    } else {
      const lift = 44 + Math.min(56, Math.abs(endY - startY) * 0.12);
      pathData = `M ${startX} ${startY} C ${startX + 54} ${startY - lift}, ${endX - 54} ${endY - lift}, ${endX} ${endY}`;
      labelX = (startX + endX) / 2;
      labelY = Math.min(startY, endY) - lift - 5;
    }
    const path = document.createElementNS(svg.namespaceURI, 'path');
    path.setAttribute('d', pathData);
    path.classList.add('reachability-edge');
    path.setAttribute('marker-end', 'url(#reachability-arrow)');
    const title = document.createElementNS(svg.namespaceURI, 'title');
    title.textContent = `M${edge.source} to M${edge.target} by ${edge.transition}`;
    path.appendChild(title);
    graph.appendChild(path);

    const edgeLabel = document.createElementNS(svg.namespaceURI, 'text');
    edgeLabel.setAttribute('x', labelX);
    edgeLabel.setAttribute('y', labelY);
    edgeLabel.classList.add('reachability-edge-label');
    edgeLabel.textContent = edge.transition;
    graph.appendChild(edgeLabel);
  }

  for (const node of nodes) {
    const position = positions.get(node.id);
    const group = document.createElementNS(svg.namespaceURI, 'g');
    group.classList.add('reachability-node');
    if (node.id === 0) group.classList.add('reachability-root');
    if (node.terminal === 'repeat') group.classList.add('reachability-repeat');
    const rect = document.createElementNS(svg.namespaceURI, 'rect');
    rect.setAttribute('x', position.x);
    rect.setAttribute('y', position.y);
    rect.setAttribute('width', nodeWidth);
    rect.setAttribute('height', nodeHeight);
    rect.setAttribute('rx', '5');
    group.appendChild(rect);

    const nodeLabel = document.createElementNS(svg.namespaceURI, 'text');
    nodeLabel.setAttribute('x', position.x + 12);
    nodeLabel.setAttribute('y', position.y + 23);
    nodeLabel.classList.add('reachability-node-id');
    nodeLabel.textContent = `M${node.id}${node.id === 0 ? ' · initial' : ''}`;
    group.appendChild(nodeLabel);

    const markingLabel = document.createElementNS(svg.namespaceURI, 'text');
    markingLabel.setAttribute('x', position.x + 12);
    markingLabel.setAttribute('y', position.y + 43);
    markingLabel.classList.add('reachability-marking');
    markingLabel.textContent = `[${node.marking.map(tokens => tokens === Infinity ? 'w' : tokens).join(', ')}]`;
    if (markingLabel.textContent.length > 22) {
      markingLabel.setAttribute('textLength', nodeWidth - 24);
      markingLabel.setAttribute('lengthAdjust', 'spacingAndGlyphs');
    }
    const fullMarking = netData.states.map((state, index) =>
      `${state.name}=${node.marking[index] === Infinity ? 'w' : node.marking[index]}`
    ).join(', ');
    const markingTitle = document.createElementNS(svg.namespaceURI, 'title');
    markingTitle.textContent = fullMarking || 'Empty marking';
    markingLabel.appendChild(markingTitle);
    group.appendChild(markingLabel);

    if (node.terminal === 'repeat') {
      const terminalLabel = document.createElementNS(svg.namespaceURI, 'text');
      terminalLabel.setAttribute('x', position.x + 12);
      terminalLabel.setAttribute('y', position.y + 64);
      terminalLabel.classList.add('reachability-terminal');
      terminalLabel.textContent = `terminal · repeat of M${node.repeatOf}`;
      group.appendChild(terminalLabel);
    }
    graph.appendChild(group);
  }

  const scroll = document.createElement('div');
  scroll.className = 'reachability-scroll';
  scroll.appendChild(graph);
  content.replaceChildren(scroll);
}

function renderMatrices() {
  const content = document.getElementById('matrix-content');
  if (!content) return;
  const states = netData.states;
  const arcs = netData.arcs;
  if (matrixView === 'output') {
    let html = '<div class="matrix-title">Output / Marking vector</div>';
    if (!states.length) {
      html += '<div class="matrix-empty">No states.</div>';
    } else {
      html += '<div class="matrix-scroll"><table class="matrix-table vector-table"><thead><tr><th>State</th><th>M</th></tr></thead><tbody>';
      for (const state of states) html += `<tr><th>${escapeHtml(state.name)}</th><td>${state.ficha_count}</td></tr>`;
      html += '</tbody></table></div>';
    }
    content.innerHTML = html;
    return;
  }

  let html = '<div class="matrix-title">Incidence matrix</div>';
  if (!states.length || !arcs.length) {
    html += '<div class="matrix-empty">Add at least one State and one Arc to display the incidence matrix.</div>';
  } else {
    html += '<div class="matrix-scroll"><table class="matrix-table"><thead><tr><th>State</th>';
    for (const t of arcs) html += `<th>${escapeHtml(t.name)}</th>`;
    html += '</tr></thead><tbody>';
    for (const state of states) {
      html += `<tr><th>${escapeHtml(state.name)}</th>`;
      for (const t of arcs) {
        let value = 0;
        if (t.source === state.name) value = t.weight;
        else if (t.target === state.name) value = -t.weight;
        html += `<td class="${value > 0 ? 'positive' : value < 0 ? 'negative' : ''}">${value}</td>`;
      }
      html += '</tr>';
    }
    html += '</tbody></table></div>';
  }
  content.innerHTML = html;
}

function setMode(m) {
  mode = m; arcSource = null;
  ['select', 'state', 'transition', 'arc'].forEach(k =>
    document.getElementById('mode-' + k).classList.toggle('active', k === m));
  hint.textContent = HINTS[m];
  render();
}
document.getElementById('mode-select').onclick = () => setMode('select');
document.getElementById('mode-state').onclick = () => setMode('state');
document.getElementById('mode-transition').onclick = () => setMode('transition');
document.getElementById('mode-arc').onclick = () => setMode('arc');

document.getElementById('netname').addEventListener('change', e => {
  netData.name = e.target.value || 'Untitled Net';
  saveLocal();
  render();
});

document.getElementById('btn-new').onclick = () => {
  const name = prompt('Name for the new net:', 'Untitled Net');
  if (name === null) return;
  netData = emptyNet(name || 'Untitled Net');
  for (const kind of Object.keys(renameBuffer)) renameBuffer[kind] = [];
  selected = null; arcSource = null;
  saveLocal(); render();
};

document.getElementById('btn-export').onclick = exportNet;
document.getElementById('btn-import').onclick = () => document.getElementById('file-input').click();
document.getElementById('file-input').onchange = async e => {
  const file = e.target.files[0];
  if (!file) return;
  try { await importNet(file); }
  catch { showError('That file could not be read as a Petri net export.'); }
  e.target.value = '';
};

function svgPoint(evt) {
  if (svg.getScreenCTM) {
    const ctm = svg.getScreenCTM();
    if (ctm) {
      const pt = svg.createSVGPoint();
      pt.x = evt.clientX;
      pt.y = evt.clientY;
      const transformed = pt.matrixTransform(ctm.inverse());
      return { x: transformed.x, y: transformed.y };
    }
  }
  const rect = svg.getBoundingClientRect();
  return {
    x: (evt.clientX - rect.left) / currentZoomLevel,
    y: (evt.clientY - rect.top) / currentZoomLevel
  };
}

function circleBoundaryPoint(cx, cy, r, tx, ty) {
  const dx = tx - cx, dy = ty - cy;
  const dist = Math.sqrt(dx*dx + dy*dy) || 1;
  return {x: cx + dx/dist*r, y: cy + dy/dist*r};
}

function rectBoundaryPoint(cx, cy, halfW, halfH, rotationDeg, tx, ty) {
  const invRad = -rotationDeg * Math.PI / 180;
  const dx = tx - cx, dy = ty - cy;
  const lx = dx*Math.cos(invRad) - dy*Math.sin(invRad);
  const ly = dx*Math.sin(invRad) + dy*Math.cos(invRad);
  const scale = Math.min(
    lx !== 0 ? halfW/Math.abs(lx) : Infinity,
    ly !== 0 ? halfH/Math.abs(ly) : Infinity
  );
  const bx = lx*scale, by = ly*scale;
  const rad = rotationDeg * Math.PI / 180;
  return {
    x: cx + bx*Math.cos(rad) - by*Math.sin(rad),
    y: cy + bx*Math.sin(rad) + by*Math.cos(rad)
  };
}

function boundaryPoint(node, kind, tx, ty) {
  return kind === 'state'
    ? circleBoundaryPoint(node.x, node.y, 30, tx, ty)
    : rectBoundaryPoint(node.x, node.y, 10, 30, node.rotation || 0, tx, ty);
}

// True from the moment a press starts on an entity until the click that ends it.
// The press captures the pointer on <svg>, so that click is dispatched to the
// <svg> itself (no [data-name] target) and would otherwise look like a click on
// empty canvas and deselect the entity.
let pressedEntity = false;
// Capture phase: runs before startDragNode, which re-arms the flag.
document.getElementById('canvas-wrap')
  .addEventListener('pointerdown', () => { pressedEntity = false; }, true);

svg.addEventListener('click', e => {
  if (pressedEntity) { pressedEntity = false; dragMoved = false; return; }
  if (dragging || draggingLabel || dragMoved) { dragMoved = false; return; }
  const pt = svgPoint(e);
  const hit = e.target.closest('[data-name]');

  try {
    if (mode === 'state' && !hit) {
      const name = prompt('Place name:', suggestName('state'));
      if (!name) return;
      const description = prompt('Description (optional):', '') || '';
      addState(name.trim(), description, pt.x, pt.y);
    } else if (mode === 'transition' && !hit) {
      const name = prompt('Transition name:', suggestName('transition'));
      if (!name) return;
      const description = prompt('Description (optional):', '') || '';
      addTransition(name.trim(), description, pt.x, pt.y);
    } else if (mode === 'arc' && hit) {
      const name = hit.dataset.name;
      if (!arcSource) {
        arcSource = name;
        hint.textContent = `Source: "${name}". Now click the target node.`;
        render();
      } else {
        const source = arcSource;
        const target = name;
        const arcName = prompt('Arc name:', suggestName('arc'));
        if (!arcName) { arcSource = null; render(); return; }
        const weight = parseInt(prompt('Weight (tokens consumed/produced):', '1') || '1', 10) || 1;
        let arcType = 'normal';
        if (nodeKind(source) === 'state') {
          const raw = prompt('Arc type: normal, inhibitor, or read', 'normal');
          if (raw && ['normal','inhibitor','read'].includes(raw.trim())) arcType = raw.trim();
        }
        addArc(arcName.trim(), '', source, target, weight, arcType);
        arcSource = null;
        hint.textContent = HINTS.arc;
        render();
      }
    } else if (mode === 'select' && hit) {
      selectNode(hit.dataset.kind, hit.dataset.name);
    } else if (mode === 'select' && !hit) {
      selected = null;
      mobileInspectorOpen = false;
      render();
    }
  } catch (err) {
    showError(err.message);
    arcSource = null;
    render();
  }
});

// Pointer interaction -------------------------------------------------------
// Touch has two different jobs in Select mode:
//   * over an entity -> move the entity
//   * over empty canvas -> pan the viewport
// The pan handler lives on #canvas-wrap rather than SVG. This is important
// because the SVG can contain empty regions and browsers/devtools differ in
// how they dispatch touch events to SVG elements.
const canvasWrap = document.getElementById('canvas-wrap');
const sidebar = document.getElementById('sidebar');

// Interação de Pan (Mover o Canvas)
canvasWrap.addEventListener('pointerdown', e => {
  // Se o clique/toque foi em um elemento interativo do SVG, não inicia o Pan
  // (nor on floating buttons, so a click on them is never turned into a pan)
  if (e.target.closest('[data-name], [data-handle], button')) return;

  panning = {
    pointerId: e.pointerId,
    startX: e.clientX,
    startY: e.clientY,
    scrollLeft: canvasWrap.scrollLeft,
    scrollTop: canvasWrap.scrollTop,
    captured: false
  };
  dragMoved = false;
});

canvasWrap.addEventListener('pointermove', e => {
  if (!panning || e.pointerId !== panning.pointerId) return;
  
  const dx = e.clientX - panning.startX;
  const dy = e.clientY - panning.startY;

  if (Math.hypot(dx, dy) > 3) {
    dragMoved = true;
    if (!panning.captured) {
      panning.captured = true;
      try { canvasWrap.setPointerCapture(e.pointerId); } catch (_) {}
    }
    e.preventDefault();
    canvasWrap.scrollLeft = panning.scrollLeft - dx;
    canvasWrap.scrollTop = panning.scrollTop - dy;
  }
});

const endPan = e => {
  if (panning && e.pointerId === panning.pointerId) {
    if (panning.captured) {
      try { canvasWrap.releasePointerCapture(e.pointerId); } catch (_) {}
    }
    panning = null;
  }
};

canvasWrap.addEventListener('pointerup', endPan);
canvasWrap.addEventListener('pointercancel', endPan);

// Interação de Drag (Mover Nós e Legendas)
function startDragNode(e) {
  if (mode !== 'select') return;
  const hit = e.target.closest('[data-name]');
  if (!hit) return;

  // Grab the pressed element before selectNode() re-renders (and detaches) it.
  const labelEl = e.target;
  const isLabel = labelEl.dataset.role === 'label';
  const pressPoint = svgPoint(e);

  // Select entity immediately so the inspector opens with rename, delete, tokens, etc.
  selectNode(hit.dataset.kind, hit.dataset.name);

  pressedEntity = true;
  dragMoved = false;

  if (isLabel) {
    // Remember where inside the text it was grabbed so it follows the pointer
    // without jumping.
    const pt = pressPoint;
    const ax = parseFloat(labelEl.getAttribute('x')), ay = parseFloat(labelEl.getAttribute('y'));
    draggingLabel = {
      kind: hit.dataset.kind,
      name: hit.dataset.name,
      part: labelEl.dataset.part || 'name',
      grabX: pt.x - ax,
      grabY: pt.y - ay
    };
  } else if (hit.dataset.kind === 'arc' && settings.arcShape === 'spline') {
    // Spline mode: dragging the arc reshapes it.
    const arc = netData.arcs.find(item => item.name === hit.dataset.name);
    if (arc) startCurveBodyDrag(arc, pressPoint);
  } else if (hit.dataset.kind === 'arc') {
    // Straight mode: dragging the line breaks it with a bend point.
    const arc = netData.arcs.find(item => item.name === hit.dataset.name);
    if (arc) startBreakDrag(arc, pressPoint);
  } else {
    dragging = hit.dataset.name;
  }

  // Bind pointer capture to static svg element (not hit, which gets recreated by render())
  try { svg.setPointerCapture(e.pointerId); } catch (_) {}
}

nodesLayer.addEventListener('pointerdown', startDragNode);
arcsLayer.addEventListener('pointerdown', startDragNode);

// Auto-alignment & distance helpers ---------------------------------------
// Snaps (targetX, targetY) to the reference points and returns the guides to draw.
//   * Nodes: called with just the node; it aligns to the other nodes' centres.
//   * Texts: called with opts.alignPoints (other texts + node centres) and
//     opts.spacingPoints (other texts), all as {x, y} visual centres.
function calculateAlignmentGuides(currentNode, targetX, targetY, opts = {}) {
  const SNAP_THRESHOLD = 7;
  let snappedX = targetX;
  let snappedY = targetY;
  const guides = [];

  const otherNodes = [...netData.states, ...netData.transitions]
    .filter(n => n.name !== currentNode?.name);
  const alignPoints = opts.alignPoints ?? otherNodes;
  const spacingPoints = opts.spacingPoints ?? alignPoints;
  if (!alignPoints.length && !spacingPoints.length) return { snappedX, snappedY, guides };

  let snapXFound = false;
  let snapYFound = false;

  // 1. Check Center Alignment (X & Y axis alignment)
  for (const other of alignPoints) {
    if (!snapXFound && Math.abs(targetX - other.x) < SNAP_THRESHOLD) {
      snappedX = other.x;
      snapXFound = true;
      guides.push({
        type: 'v-line',
        x: other.x,
        minY: Math.min(targetY, other.y) - 25,
        maxY: Math.max(targetY, other.y) + 25
      });
    }
    if (!snapYFound && Math.abs(targetY - other.y) < SNAP_THRESHOLD) {
      snappedY = other.y;
      snapYFound = true;
      guides.push({
        type: 'h-line',
        y: other.y,
        minX: Math.min(targetX, other.x) - 25,
        maxX: Math.max(targetX, other.x) + 25
      });
    }
  }

  // 2. Check Equal Spacing Alignment (horizontal & vertical distance matching)
  if (spacingPoints.length >= 2) {
    const sortedX = [...spacingPoints].sort((a, b) => a.x - b.x);
    for (let i = 0; i < sortedX.length - 1; i++) {
      const n1 = sortedX[i];
      const n2 = sortedX[i + 1];
      const dist = Math.abs(n2.x - n1.x);
      if (dist < 35) continue;

      if (!snapXFound && Math.abs(targetX - (n2.x + dist)) < SNAP_THRESHOLD) {
        snappedX = n2.x + dist;
        snapXFound = true;
        guides.push({
          type: 'h-spacing',
          x1: n1.x, x2: n2.x, x3: snappedX,
          y: (n1.y + n2.y + targetY) / 3,
          dist: Math.round(dist)
        });
      }
      if (!snapXFound && Math.abs(targetX - (n1.x - dist)) < SNAP_THRESHOLD) {
        snappedX = n1.x - dist;
        snapXFound = true;
        guides.push({
          type: 'h-spacing',
          x1: snappedX, x2: n1.x, x3: n2.x,
          y: (n1.y + n2.y + targetY) / 3,
          dist: Math.round(dist)
        });
      }
    }

    const sortedY = [...spacingPoints].sort((a, b) => a.y - b.y);
    for (let i = 0; i < sortedY.length - 1; i++) {
      const n1 = sortedY[i];
      const n2 = sortedY[i + 1];
      const dist = Math.abs(n2.y - n1.y);
      if (dist < 35) continue;

      if (!snapYFound && Math.abs(targetY - (n2.y + dist)) < SNAP_THRESHOLD) {
        snappedY = n2.y + dist;
        snapYFound = true;
        guides.push({
          type: 'v-spacing',
          y1: n1.y, y2: n2.y, y3: snappedY,
          x: (n1.x + n2.x + targetX) / 3,
          dist: Math.round(dist)
        });
      }
      if (!snapYFound && Math.abs(targetY - (n1.y - dist)) < SNAP_THRESHOLD) {
        snappedY = n1.y - dist;
        snapYFound = true;
        guides.push({
          type: 'v-spacing',
          y1: snappedY, y2: n1.y, y3: n2.y,
          x: (n1.x + n2.x + targetX) / 3,
          dist: Math.round(dist)
        });
      }
    }
  }

  return { snappedX, snappedY, guides };
}

function renderGuides(guides) {
  if (!guidesLayer) return;
  guidesLayer.innerHTML = '';
  if (!guides || !guides.length) return;

  for (const g of guides) {
    if (g.type === 'v-line') {
      const line = document.createElementNS(svg.namespaceURI, 'line');
      line.setAttribute('class', 'align-guide');
      line.setAttribute('x1', g.x); line.setAttribute('y1', g.minY);
      line.setAttribute('x2', g.x); line.setAttribute('y2', g.maxY);
      guidesLayer.appendChild(line);
    } else if (g.type === 'h-line') {
      const line = document.createElementNS(svg.namespaceURI, 'line');
      line.setAttribute('class', 'align-guide');
      line.setAttribute('x1', g.minX); line.setAttribute('y1', g.y);
      line.setAttribute('x2', g.maxX); line.setAttribute('y2', g.y);
      guidesLayer.appendChild(line);
    } else if (g.type === 'h-spacing') {
      const l1 = document.createElementNS(svg.namespaceURI, 'line');
      l1.setAttribute('class', 'spacing-guide');
      l1.setAttribute('x1', g.x1); l1.setAttribute('y1', g.y);
      l1.setAttribute('x2', g.x2); l1.setAttribute('y2', g.y);
      guidesLayer.appendChild(l1);

      const l2 = document.createElementNS(svg.namespaceURI, 'line');
      l2.setAttribute('class', 'spacing-guide');
      l2.setAttribute('x1', g.x2); l2.setAttribute('y1', g.y);
      l2.setAttribute('x2', g.x3); l2.setAttribute('y2', g.y);
      guidesLayer.appendChild(l2);

      const text = document.createElementNS(svg.namespaceURI, 'text');
      text.setAttribute('class', 'guide-text');
      text.setAttribute('x', (g.x1 + g.x3) / 2);
      text.setAttribute('y', g.y - 6);
      text.setAttribute('text-anchor', 'middle');
      text.textContent = `dx: ${g.dist}px`;
      guidesLayer.appendChild(text);
    } else if (g.type === 'v-spacing') {
      const l1 = document.createElementNS(svg.namespaceURI, 'line');
      l1.setAttribute('class', 'spacing-guide');
      l1.setAttribute('x1', g.x); l1.setAttribute('y1', g.y1);
      l1.setAttribute('x2', g.x); l1.setAttribute('y2', g.y2);
      guidesLayer.appendChild(l1);

      const l2 = document.createElementNS(svg.namespaceURI, 'line');
      l2.setAttribute('class', 'spacing-guide');
      l2.setAttribute('x1', g.x); l2.setAttribute('y1', g.y2);
      l2.setAttribute('x2', g.x); l2.setAttribute('y2', g.y3);
      guidesLayer.appendChild(l2);

      const text = document.createElementNS(svg.namespaceURI, 'text');
      text.setAttribute('class', 'guide-text');
      text.setAttribute('x', g.x + 8);
      text.setAttribute('y', (g.y1 + g.y3) / 2);
      text.setAttribute('text-anchor', 'start');
      text.textContent = `dy: ${g.dist}px`;
      guidesLayer.appendChild(text);
    }
  }
}

function clearGuides() {
  if (guidesLayer) guidesLayer.innerHTML = '';
}

svg.addEventListener('pointermove', e => {
  if (panning) return;
  const pt = svgPoint(e);

  // Update pending arc line preview if connecting nodes
  if (mode === 'arc' && arcSource) {
    const pendingLine = document.getElementById('pending-arc');
    if (pendingLine) {
      pendingLine.setAttribute('x2', pt.x);
      pendingLine.setAttribute('y2', pt.y);
    }
  }

  if (!dragging && !draggingLabel && !draggingCurve) return;

  e.preventDefault();
  dragMoved = true;

  if (draggingCurve) {
    const guides = updateCurveDrag(pt, e.altKey);
    render();
    renderGuides(guides);
    return;
  }

  if (dragging) {
    const node = findNode(dragging);
    if (node) {
      const snapResult = e.altKey
        ? { snappedX: pt.x, snappedY: pt.y, guides: [] }     // Alt: move freely
        : calculateAlignmentGuides(node, pt.x, pt.y);
      node.x = Math.max(30, Math.min(BASE_WIDTH - 30, snapResult.snappedX));
      node.y = Math.max(30, Math.min(BASE_HEIGHT - 30, snapResult.snappedY));
      render();
      renderGuides(snapResult.guides);
    }
  } else if (draggingLabel) {
    // Where the text's anchor should go, after grab offset and snapping.
    const { anchorX, anchorY, guides } = snapLabelAnchor(draggingLabel, pt, e.altKey);

    if (draggingLabel.kind === 'arc') {
      const arc = netData.arcs.find(item => item.name === draggingLabel.name);
      if (arc) {
        const s = findNode(arc.source), tg = findNode(arc.target);
        if (s && tg) {
          const geometry = arcGeometry(arc);
          const mx = geometry ? geometry.midX : (s.x + tg.x) / 2;
          const my = geometry ? geometry.midY : (s.y + tg.y) / 2;
          arc.label_dx = anchorX - mx;
          arc.label_dy = anchorY - my;
          render();
          renderGuides(guides);
        }
      }
    } else {
      const node = findNode(draggingLabel.name);
      if (node) {
        if (draggingLabel.part === 'short') {
          node.short_dx = anchorX - node.x;
          node.short_dy = anchorY - node.y;
        } else {
          node.label_dx = anchorX - node.x;
          node.label_dy = anchorY - node.y;
        }
        render();
        renderGuides(guides);
      }
    }
  }
});

// Text position helper ------------------------------------------------------
// Every draggable text (place/transition names, short descriptions, arc labels)
// snaps by its visual centre to the centres of all other texts and of all
// nodes, and to equal spacing between other texts - the same helper nodes use.
function textElements() {
  return [...nodesLayer.querySelectorAll('text[data-role="label"]'),
          ...arcsLayer.querySelectorAll('text[data-role="label"]')];
}
function elementCenter(el) {
  const b = el.getBBox();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

function snapLabelAnchor(label, pt, noSnap = false) {
  const el = textElements().find(item =>
    item.dataset.name === label.name &&
    item.dataset.kind === label.kind &&
    (item.dataset.part || 'name') === label.part);

  // Anchor following the pointer, keeping the original grab offset.
  const wantX = pt.x - label.grabX, wantY = pt.y - label.grabY;
  if (!el || noSnap) return { anchorX: wantX, anchorY: wantY, guides: [] };

  const ax = parseFloat(el.getAttribute('x')), ay = parseFloat(el.getAttribute('y'));
  const center = elementCenter(el);
  const offX = center.x - ax, offY = center.y - ay;   // anchor -> visual centre

  const textCenters = textElements().filter(item => item !== el).map(elementCenter);
  const nodeCenters = [...netData.states, ...netData.transitions].map(n => ({ x: n.x, y: n.y }));
  const snap = calculateAlignmentGuides(null, wantX + offX, wantY + offY, {
    alignPoints: [...textCenters, ...nodeCenters],
    spacingPoints: textCenters
  });
  return { anchorX: snap.snappedX - offX, anchorY: snap.snappedY - offY, guides: snap.guides };
}

const endDrag = e => {
  if (dragging || draggingLabel || draggingCurve) {
    // A press that moved a bend point is a drag, not the first half of a double press.
    if (dragMoved) lastBendPress = { arc: null, index: -1, time: 0 };
    try { svg.releasePointerCapture(e.pointerId); } catch (_) {}
    clearGuides();
    saveLocal();
    dragging = null;
    draggingLabel = null;
    draggingCurve = null;
  }
};

window.addEventListener('pointerup', endDrag);
window.addEventListener('pointercancel', endDrag);
// Some mobile browsers/devtools don't provide native overflow scrolling when
// touch-action is constrained by the editor. Give the sidebar its own touch
// scroll fallback. Buttons/inputs are excluded so they remain clickable.
let menuPan = null;
sidebar.addEventListener('pointerdown', e => {
  if (e.target.closest('button,input,textarea,select')) return;
  menuPan = { id: e.pointerId, y: e.clientY, scroll: sidebar.scrollTop };
  try { sidebar.setPointerCapture(e.pointerId); } catch (_) {}
});
sidebar.addEventListener('pointermove', e => {
  if (!menuPan || e.pointerId !== menuPan.id) return;
  const dy = e.clientY - menuPan.y;
  if (Math.abs(dy) > 2) e.preventDefault();
  sidebar.scrollTop = menuPan.scroll - dy;
});
sidebar.addEventListener('pointerup', () => { menuPan = null; });
sidebar.addEventListener('pointercancel', () => { menuPan = null; });
sidebar.addEventListener('wheel', e => {
  if (sidebar.scrollHeight > sidebar.clientHeight) {
    sidebar.scrollTop += e.deltaY;
  }
}, {passive: true});

function selectNode(kind, name) {
  const sameEntity = selected?.kind === kind && selected.name === name;
  selected = {kind, name};
  if (isMobileLayout()) {
    mobileInspectorOpen = false;          // sheet opens via the Options button
  } else if (!sameEntity) {
    mobileInspectorOpen = true;           // desktop: selecting a new entity opens its panel
  }                                        // re-pressing the same one keeps ✕ / Options state
  render();
}

function renderInspector() {
  const optionsBtn = document.getElementById('entity-options-btn') || document.getElementById('mobile-options-btn');
  const nameSpan = document.getElementById('selected-entity-name') || document.getElementById('mobile-selected-name');

  if (!selected) {
    inspector.hidden = true;
    inspector.classList.remove('open-mobile');
    if (optionsBtn) optionsBtn.hidden = true;
    return;
  }

  // Desktop: the panel is shown only while open (✕ closes it, the Options
  // button reopens it). Mobile visibility is handled by the .open-mobile CSS.
  inspector.hidden = !isMobileLayout() && !mobileInspectorOpen;

  if (optionsBtn && nameSpan) {
    nameSpan.textContent = selected.name;
    optionsBtn.hidden = false;
  }

  if (mobileInspectorOpen) {
    inspector.classList.add('open-mobile');
  } else {
    inspector.classList.remove('open-mobile');
  }

  inspector.innerHTML = '';

  if (selected.kind === 'arc') {
    const t = netData.arcs.find(arc => arc.name === selected.name);
    if (!t) { selected = null; inspector.hidden = true; if (optionsBtn) optionsBtn.hidden = true; return; }
    const canChooseType = nodeKind(t.source) === 'state';
    inspector.innerHTML = `
      <div class="inspector-header">
        <h2>Arc: ${escapeHtml(t.name)}</h2>
        <button id="insp-close" class="insp-close-btn" title="Close inspector">✕</button>
      </div>
      <div class="muted">${escapeHtml(t.source)} &rarr; ${escapeHtml(t.target)}
        (${canChooseType ? 'pre' : 'post'})</div>
      ${settings.arcShape === 'spline' ? `
        <div class="muted">Drag the curve or its handles to reshape it.</div>
        ${t.curve ? '<button id="insp-reset-curve">↺ Reset curve</button>' : ''}` : `
        <div class="muted">Drag the line to break it. Drag a point to move it; press it twice to remove it.</div>
        ${t.points?.length ? '<button id="insp-reset-points">↺ Straighten line</button>' : ''}`}
      <div class="row"><label>Weight</label>
        <input id="insp-weight" type="number" min="1" value="${t.weight}"></div>
      ${canChooseType ? `
        <div class="row"><label>Type</label>
          <select id="insp-type">
            <option value="normal" ${t.arc_type==='normal'?'selected':''}>normal</option>
            <option value="inhibitor" ${t.arc_type==='inhibitor'?'selected':''}>inhibitor</option>
            <option value="read" ${t.arc_type==='read'?'selected':''}>read (test)</option>
          </select>
        </div>` : `<div class="muted">Output arcs are always normal.</div>`}
      <button class="danger" id="insp-delete">Delete arc</button>`;

    const applyArcChange = () => {
      try {
        const weight = parseInt(document.getElementById('insp-weight').value || '1', 10);
        const type = canChooseType ? document.getElementById('insp-type').value : 'normal';
        if (!Number.isInteger(weight) || weight < 1) throw new Error('Arc weight must be a positive integer.');
        t.weight = weight; t.arc_type = type;
        saveLocal(); render();
      } catch (err) { showError(err.message); }
    };
    document.getElementById('insp-close').onclick = () => { mobileInspectorOpen = false; renderInspector(); };
    const resetCurve = document.getElementById('insp-reset-curve');
    if (resetCurve) resetCurve.onclick = () => { t.curve = null; saveLocal(); render(); };
    const resetPoints = document.getElementById('insp-reset-points');
    if (resetPoints) resetPoints.onclick = () => { t.points = []; saveLocal(); render(); };
    document.getElementById('insp-weight').onchange = applyArcChange;
    if (canChooseType) document.getElementById('insp-type').onchange = applyArcChange;
    document.getElementById('insp-delete').onclick = () => removeArc(t.name);
    return;
  }

  const node = findNode(selected.name);
  if (!node) { selected = null; inspector.hidden = true; if (optionsBtn) optionsBtn.hidden = true; return; }
  const isState = selected.kind === 'state';
  inspector.innerHTML = `
    <div class="inspector-header">
      <h2>${isState ? 'Place' : 'Transition'}: ${escapeHtml(node.name)}
        ${!isState && isEnabled(node.name) ? '<span style="color:var(--enabled)">(enabled)</span>' : ''}</h2>
      <button id="insp-close" class="insp-close-btn" title="Close inspector">✕</button>
    </div>
    <div class="row"><label>Name</label>
      <input id="insp-name" value="${escapeAttr(node.name)}">
      <button id="insp-rename">Rename</button></div>
    ${isState ? '' : `
    <div class="row"><label for="insp-short">Short</label>
      <input id="insp-short" maxlength="80" placeholder="Short description"
             value="${escapeAttr(node.short_description || '')}"></div>
    <label class="row check"><input type="checkbox" id="insp-short-show"
      ${node.show_short_description ? 'checked' : ''}> Show short description on graph</label>`}
    <textarea id="insp-desc" rows="2" placeholder="Description (not shown on graph)">${escapeHtml(node.description || '')}</textarea>
    ${isState ? `
      <div class="row"><label>Tokens: ${node.ficha_count}</label>
        <button id="insp-minus">–1</button><button id="insp-plus">+1</button></div>` :
      `<div class="row"><button id="insp-rotate">⟳ Rotate 90°</button>
        <button id="insp-fire" ${isEnabled(node.name) ? '' : 'disabled'}>▶ Fire</button></div>`}
    <button class="danger" id="insp-delete">Delete ${isState ? 'place' : 'transition'}</button>`;

  document.getElementById('insp-close').onclick = () => { mobileInspectorOpen = false; renderInspector(); };

  document.getElementById('insp-desc').onchange = e => {
    node.description = e.target.value;
    saveLocal();
  };

  document.getElementById('insp-rename').onclick = () => {
    try {
      const newName = document.getElementById('insp-name').value.trim();
      if (!newName || newName === node.name) return;
      renameNode(node.name, newName);
    } catch (err) { showError(err.message); }
  };

  if (isState) {
    document.getElementById('insp-plus').onclick = () => {
      try { addFicha(node.name, 1); } catch (err) { showError(err.message); }
    };
    document.getElementById('insp-minus').onclick = () => {
      try { addFicha(node.name, -1); } catch (err) { showError(err.message); }
    };
  } else {
    document.getElementById('insp-short').onchange = e => {
      node.short_description = e.target.value.trim();
      saveLocal(); render();
    };
    document.getElementById('insp-short-show').onchange = e => {
      node.show_short_description = e.target.checked;
      saveLocal(); render();
    };
    document.getElementById('insp-rotate').onclick = () => {
      node.rotation = ((node.rotation || 0) + 90) % 360;
      saveLocal(); render();
    };
    document.getElementById('insp-fire').onclick = () => {
      try { fireTransition(node.name); } catch (err) { showError(err.message); }
    };
  }

  document.getElementById('insp-delete').onclick = () => removeNode(node.name);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  }[c]));
}
function escapeAttr(value) { return escapeHtml(value); }

// When two opposite arcs connect the same pair of units, draw them as two
// parallel lines. The second arc therefore does not point through the same
// centre/boundary point as the first one.
// Unit vector pointing out of a node's surface at boundary point `p`: radial
// for places, the normal of the side that was hit for (rotated) transitions.
function outwardNormal(node, kind, p) {
  const dx = p.x - node.x, dy = p.y - node.y;
  if (kind === 'state') {
    const d = Math.hypot(dx, dy) || 1;
    return { x: dx / d, y: dy / d };
  }
  const rad = (node.rotation || 0) * Math.PI / 180;
  const c = Math.cos(rad), s = Math.sin(rad);
  const lx = dx * c + dy * s, ly = -dx * s + dy * c;       // world -> local
  const local = Math.abs(lx) / 10 >= Math.abs(ly) / 30
    ? { x: Math.sign(lx) || 1, y: 0 }
    : { x: 0, y: Math.sign(ly) || 1 };
  return { x: local.x * c - local.y * s, y: local.x * s + local.y * c };  // local -> world
}

// Smooth cubic Bezier ("spline") arc: it leaves the source and enters the target
// along the surface normals, so arrowheads meet the node edge head-on.
function splineArcGeometry(source, target, sourceKind, targetKind, bendOffset, curve) {
  const dx = target.x - source.x, dy = target.y - source.y;
  const dist = Math.hypot(dx, dy) || 1;
  const nx = -dy / dist, ny = dx / dist;
  const aimAtTarget = { x: target.x + nx * bendOffset, y: target.y + ny * bendOffset };
  const aimAtSource = { x: source.x + nx * bendOffset, y: source.y + ny * bendOffset };

  const p1 = boundaryPoint(source, sourceKind, aimAtTarget.x, aimAtTarget.y);
  const p2 = boundaryPoint(target, targetKind, aimAtSource.x, aimAtSource.y);
  const n1 = outwardNormal(source, sourceKind, p1);
  const n2 = outwardNormal(target, targetKind, p2);

  const k = Math.hypot(p2.x - p1.x, p2.y - p1.y) * 0.4;
  // Automatic control points, then the user's drag offsets (if any) on top.
  const auto1 = { x: p1.x + n1.x * k, y: p1.y + n1.y * k };
  const auto2 = { x: p2.x + n2.x * k, y: p2.y + n2.y * k };
  const c1 = curve ? { x: auto1.x + curve.c1x, y: auto1.y + curve.c1y } : auto1;
  const c2 = curve ? { x: auto2.x + curve.c2x, y: auto2.y + curve.c2y } : auto2;

  return {
    p1, p2, control: c1, control2: c2, auto1, auto2,
    path: `M ${p1.x} ${p1.y} C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${p2.x} ${p2.y}`,
    // Cubic Bezier point at t = 0.5, used as the label anchor.
    midX: 0.125 * p1.x + 0.375 * c1.x + 0.375 * c2.x + 0.125 * p2.x,
    midY: 0.125 * p1.y + 0.375 * c1.y + 0.375 * c2.y + 0.125 * p2.y
  };
}

// Straight arc that was broken into segments by the user: source -> bend points
// -> target. The ends leave the nodes toward the first/last bend point.
function polylineArcGeometry(source, target, sourceKind, targetKind, points) {
  const first = points[0], last = points[points.length - 1];
  const p1 = boundaryPoint(source, sourceKind, first.x, first.y);
  const p2 = boundaryPoint(target, targetKind, last.x, last.y);
  const polyline = [p1, ...points, p2];

  // Label anchor: the point halfway along the whole path.
  const lengths = [];
  let total = 0;
  for (let i = 0; i < polyline.length - 1; i++) {
    const len = Math.hypot(polyline[i + 1].x - polyline[i].x, polyline[i + 1].y - polyline[i].y);
    lengths.push(len); total += len;
  }
  let remaining = total / 2, midX = p1.x, midY = p1.y;
  for (let i = 0; i < lengths.length; i++) {
    if (remaining <= lengths[i] || i === lengths.length - 1) {
      const f = lengths[i] ? remaining / lengths[i] : 0;
      midX = polyline[i].x + (polyline[i + 1].x - polyline[i].x) * f;
      midY = polyline[i].y + (polyline[i + 1].y - polyline[i].y) * f;
      break;
    }
    remaining -= lengths[i];
  }

  return {
    p1, p2, polyline,
    path: 'M ' + polyline.map(q => `${q.x} ${q.y}`).join(' L '),
    midX, midY
  };
}

// opts.ignoreCurve: geometry without the user's drag offsets (used to compute them).
function arcGeometry(t, opts = {}) {
  const source = findNode(t.source), target = findNode(t.target);
  const sourceKind = nodeKind(t.source), targetKind = nodeKind(t.target);
  if (!source || !target) return null;

  const reverse = netData.arcs.find(other =>
    other !== t && other.source === t.target && other.target === t.source
  );

  // Spline mode: every arc is a smooth curve; a pair of opposite arcs bows
  // apart symmetrically instead of one staying straight.
  if (settings.arcShape === 'spline') {
    return splineArcGeometry(source, target, sourceKind, targetKind, reverse ? 24 : 0,
      opts.ignoreCurve ? null : t.curve);
  }

  // Straight mode, but the user broke the line with bend points.
  if (t.points?.length) {
    return polylineArcGeometry(source, target, sourceKind, targetKind, t.points);
  }

  // Keep the first direction straight. If the reverse direction exists,
  // route it around the connection instead of sending both arrows through
  // the same centre line. This also makes the arrowhead approach the side
  // of the target unit rather than the same point as the first arrow.
  const isFirst = !reverse ||
    netData.arcs.indexOf(t) < netData.arcs.indexOf(reverse);

  let dx = target.x - source.x, dy = target.y - source.y;
  const dist = Math.hypot(dx, dy) || 1;
  const nx = -dy / dist, ny = dx / dist;
  const bend = reverse && !isFirst ? 42 : 0;

  const aim1 = bend ? {
    x: target.x + nx * bend,
    y: target.y + ny * bend
  } : {x: target.x, y: target.y};
  const aim2 = bend ? {
    x: source.x + nx * bend,
    y: source.y + ny * bend
  } : {x: source.x, y: source.y};

  const p1 = boundaryPoint(source, sourceKind, aim1.x, aim1.y);
  const p2 = boundaryPoint(target, targetKind, aim2.x, aim2.y);

  if (!bend) {
    return {
      p1, p2,
      path: `M ${p1.x} ${p1.y} L ${p2.x} ${p2.y}`,
      midX: (p1.x + p2.x) / 2,
      midY: (p1.y + p2.y) / 2
    };
  }

  const control = {
    x: (source.x + target.x) / 2 + nx * bend,
    y: (source.y + target.y) / 2 + ny * bend
  };
  // Quadratic Bezier midpoint at t=0.5, used for the label anchor.
  const midX = 0.25*p1.x + 0.5*control.x + 0.25*p2.x;
  const midY = 0.25*p1.y + 0.5*control.y + 0.25*p2.y;

  return {
    p1, p2, control,
    path: `M ${p1.x} ${p1.y} Q ${control.x} ${control.y} ${p2.x} ${p2.y}`,
    midX, midY
  };
}

function render() {
  if (!netData) return;
  document.getElementById('netname').value = netData.name;
  arcsLayer.innerHTML = '';
  nodesLayer.innerHTML = '';

  for (const t of netData.arcs) {
    const s = findNode(t.source), tg = findNode(t.target);
    if (!s || !tg) continue;
    const geometry = arcGeometry(t);
    if (!geometry) continue;
    const { p1, p2, midX, midY } = geometry;

    const g = document.createElementNS(svg.namespaceURI, 'g');
    g.classList.add('arc');
    g.dataset.name = t.name; g.dataset.kind = 'arc';

    // Invisible, wider twin of the line: makes thin arcs easy to click and drag.
    const hitPath = document.createElementNS(svg.namespaceURI, 'path');
    hitPath.setAttribute('d', geometry.path);
    hitPath.setAttribute('class', 'arc-hit');
    hitPath.dataset.name = t.name; hitPath.dataset.kind = 'arc';
    g.appendChild(hitPath);

    const line = document.createElementNS(svg.namespaceURI, 'path');
    line.setAttribute('d', geometry.path);
    line.setAttribute('class', 'type-' + t.arc_type +
      (selected?.kind === 'arc' && selected.name === t.name ? ' selected' : ''));
    line.dataset.name = t.name; line.dataset.kind = 'arc';
    line.addEventListener('click', e => {
      if (mode === 'select') { e.stopPropagation(); selectNode('arc', t.name); }
    });
    g.appendChild(line);

    // "Hide arc names" removes the name but keeps the weight when it is above 1,
    // since the weight is part of the net's meaning. Nothing to draw otherwise.
    const labelText = settings.hideArcNames
      ? (t.weight > 1 ? `[${t.weight}]` : '')
      : (t.weight > 1 ? `${t.name} [${t.weight}]` : t.name);
    if (labelText) {
      const label = document.createElementNS(svg.namespaceURI, 'text');
      label.setAttribute('x', midX + (t.label_dx ?? 6));
      label.setAttribute('y', midY + (t.label_dy ?? -6));
      label.setAttribute('class', 'arc-label');
      label.dataset.name = t.name; label.dataset.kind = 'arc'; label.dataset.role = 'label';
      label.dataset.part = 'name';
      label.textContent = labelText;
      g.appendChild(label);
    }
    arcsLayer.appendChild(g);
  }

  if (mode === 'arc' && arcSource) {
    const s = findNode(arcSource);
    if (s) {
      const line = document.createElementNS(svg.namespaceURI, 'line');
      line.setAttribute('id', 'pending-arc');
      line.setAttribute('class', 'pending');
      line.setAttribute('x1', s.x); line.setAttribute('y1', s.y);
      line.setAttribute('x2', s.x); line.setAttribute('y2', s.y);
      arcsLayer.appendChild(line);
    }
  }

  for (const s of netData.states) {
    const g = document.createElementNS(svg.namespaceURI, 'g');
    g.classList.add('state');
    g.dataset.name = s.name; g.dataset.kind = 'state';
    const isSel = selected?.kind === 'state' && selected.name === s.name;
    const lx = s.x + (s.label_dx ?? 0), ly = s.y + (s.label_dy ?? 46);
    g.innerHTML = `
      <circle cx="${s.x}" cy="${s.y}" r="30" class="${isSel?'selected':''}"></circle>
      <text class="node-label" data-name="${escapeAttr(s.name)}" data-kind="state"
            data-role="label" data-part="name" x="${lx}" y="${ly}" text-anchor="middle">${escapeHtml(s.name)}</text>
      ${s.ficha_count > 0 ? `<text class="tokens" x="${s.x}" y="${s.y+5}" text-anchor="middle">${s.ficha_count}</text>` : ''}`;
    nodesLayer.appendChild(g);
  }

  for (const a of netData.transitions) {
    const g = document.createElementNS(svg.namespaceURI, 'g');
    g.classList.add('transition');
    g.dataset.name = a.name; g.dataset.kind = 'transition';
    const isSel = selected?.kind === 'transition' && selected.name === a.name;
    const rotation = a.rotation || 0;
    const classes = [isSel ? 'selected' : '', isEnabled(a.name) ? 'enabled' : ''].filter(Boolean).join(' ');
    const lx = a.x + (a.label_dx ?? 0), ly = a.y + (a.label_dy ?? 46);
    g.innerHTML = `
      <rect x="${a.x-10}" y="${a.y-30}" width="20" height="60" class="${classes}"
            transform="rotate(${rotation} ${a.x} ${a.y})"></rect>
      <text class="node-label" data-name="${escapeAttr(a.name)}" data-kind="transition"
            data-role="label" data-part="name" x="${lx}" y="${ly}" text-anchor="middle">${escapeHtml(a.name)}</text>
      ${a.show_short_description && a.short_description ? `
      <text class="node-label short-desc" data-name="${escapeAttr(a.name)}" data-kind="transition"
            data-role="label" data-part="short" x="${a.x + (a.short_dx ?? 0)}"
            y="${a.y + (a.short_dy ?? SHORT_DESC_DEFAULT_DY)}" text-anchor="middle">${escapeHtml(a.short_description)}</text>` : ''}`;
    nodesLayer.appendChild(g);
  }

  renderCurveHandles();
  renderInspector();
  if (matrixOpen) renderMatrices();
  updateNetDescButton();
}

// A dot on the button shows that the net already has a description.
function updateNetDescButton() {
  const button = document.getElementById('netdesc-toggle');
  if (button) button.textContent = netData?.description?.trim() ? 'ⓘ Net description ●' : 'ⓘ Net description';
}

// Straight mode: the selected arc shows its bend points (solid) and a ghost
// handle at the middle of every segment (drag it to break the line there).
function renderBendHandles(arc, geometry) {
  const polyline = geometry.polyline || [geometry.p1, geometry.p2];
  const add = (cls, x, y, r, handle, index) => {
    const dot = document.createElementNS(svg.namespaceURI, 'circle');
    dot.setAttribute('class', cls);
    dot.setAttribute('cx', x); dot.setAttribute('cy', y); dot.setAttribute('r', r);
    dot.dataset.handle = handle; dot.dataset.arc = arc.name; dot.dataset.index = index;
    handlesLayer.appendChild(dot);
  };
  for (let i = 0; i < polyline.length - 1; i++) {
    add('curve-ghost', (polyline[i].x + polyline[i + 1].x) / 2,
        (polyline[i].y + polyline[i + 1].y) / 2, 5, 'ghost', i);
  }
  (arc.points || []).forEach((q, i) => add('curve-handle', q.x, q.y, 7, 'v', i));
}

// Spline mode: the selected arc shows its two Bezier control points as handles.
function renderCurveHandles() {
  handlesLayer.innerHTML = '';
  svg.dataset.arcShape = settings.arcShape;
  if (mode !== 'select' || selected?.kind !== 'arc') return;
  const arc = netData.arcs.find(item => item.name === selected.name);
  const geometry = arc && arcGeometry(arc);
  if (!geometry) return;
  if (settings.arcShape !== 'spline') { renderBendHandles(arc, geometry); return; }
  if (!geometry.control2) return;

  for (const [anchor, control, which] of [
    [geometry.p1, geometry.control, 'c1'],
    [geometry.p2, geometry.control2, 'c2']
  ]) {
    const tether = document.createElementNS(svg.namespaceURI, 'line');
    tether.setAttribute('class', 'curve-tether');
    tether.setAttribute('x1', anchor.x); tether.setAttribute('y1', anchor.y);
    tether.setAttribute('x2', control.x); tether.setAttribute('y2', control.y);
    handlesLayer.appendChild(tether);

    const handle = document.createElementNS(svg.namespaceURI, 'circle');
    handle.setAttribute('class', 'curve-handle');
    handle.setAttribute('cx', control.x); handle.setAttribute('cy', control.y);
    handle.setAttribute('r', 7);
    handle.dataset.handle = which; handle.dataset.arc = arc.name;
    handlesLayer.appendChild(handle);
  }
}

// Curve reshaping ------------------------------------------------------------
function cubicPoint(g, t) {
  const u = 1 - t;
  return {
    x: u*u*u*g.p1.x + 3*u*u*t*g.control.x + 3*u*t*t*g.control2.x + t*t*t*g.p2.x,
    y: u*u*u*g.p1.y + 3*u*u*t*g.control.y + 3*u*t*t*g.control2.y + t*t*t*g.p2.y
  };
}
function nearestCurveT(g, pt) {
  let best = 0.5, bestDist = Infinity;
  for (let i = 0; i <= 60; i++) {
    const t = i / 60, p = cubicPoint(g, t);
    const d = Math.hypot(p.x - pt.x, p.y - pt.y);
    if (d < bestDist) { bestDist = d; best = t; }
  }
  return best;
}

// Press on a handle: move that one control point.
function startHandleDrag(e) {
  const handle = e.target.closest('[data-handle]');
  if (!handle || mode !== 'select') return;
  const arc = netData.arcs.find(item => item.name === handle.dataset.arc);
  if (arc && (handle.dataset.handle === 'v' || handle.dataset.handle === 'ghost')) {
    startBendHandleDrag(e, arc, handle);
    return;
  }
  const geometry = arc && arcGeometry(arc);
  if (!geometry?.control2) return;
  const pt = svgPoint(e);
  const control = handle.dataset.handle === 'c1' ? geometry.control : geometry.control2;
  draggingCurve = {
    arc: arc.name, kind: handle.dataset.handle,
    grabX: pt.x - control.x, grabY: pt.y - control.y
  };
  pressedEntity = true;       // swallow the click that ends this press
  dragMoved = false;
  try { svg.setPointerCapture(e.pointerId); } catch (_) {}
}
handlesLayer.addEventListener('pointerdown', startHandleDrag);

// Straight arcs ("break the line") ------------------------------------------
const BREAK_DRAG_THRESHOLD = 4;          // px of movement before a bend point is created
const DOUBLE_PRESS_MS = 350;
let lastBendPress = { arc: null, index: -1, time: 0 };

// Press on a bend point (move it; press twice quickly to remove it) or on a
// ghost handle (drag to create a bend point in that segment).
function startBendHandleDrag(e, arc, handle) {
  const pt = svgPoint(e);
  const index = Number(handle.dataset.index);
  pressedEntity = true;                  // swallow the click that ends this press
  dragMoved = false;

  if (handle.dataset.handle === 'ghost') {
    draggingCurve = { arc: arc.name, kind: 'break', seg: index, start: pt };
  } else {
    const now = performance.now();
    if (lastBendPress.arc === arc.name && lastBendPress.index === index &&
        now - lastBendPress.time < DOUBLE_PRESS_MS) {
      arc.points.splice(index, 1);       // double press: remove this bend point
      lastBendPress = { arc: null, index: -1, time: 0 };
      saveLocal(); render();
      return;
    }
    lastBendPress = { arc: arc.name, index, time: now };
    const q = arc.points[index];
    draggingCurve = { arc: arc.name, kind: 'v', index, grabX: pt.x - q.x, grabY: pt.y - q.y };
  }
  try { svg.setPointerCapture(e.pointerId); } catch (_) {}
}

// Press on the line itself: once it is dragged, break it at the nearest segment.
function startBreakDrag(arc, pressPoint) {
  const geometry = arcGeometry(arc);
  if (!geometry) return;
  const line = geometry.polyline || [geometry.p1, geometry.p2];
  let seg = 0, best = Infinity;
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i], b = line[i + 1];
    const abx = b.x - a.x, aby = b.y - a.y;
    const len2 = abx * abx + aby * aby || 1;
    const f = Math.max(0, Math.min(1, ((pressPoint.x - a.x) * abx + (pressPoint.y - a.y) * aby) / len2));
    const d = Math.hypot(pressPoint.x - (a.x + abx * f), pressPoint.y - (a.y + aby * f));
    if (d < best) { best = d; seg = i; }
  }
  draggingCurve = { arc: arc.name, kind: 'break', seg, start: pressPoint };
}

// Snap a bend point to node centres and to other bend points, so segments can
// be made perfectly horizontal / vertical. Alt disables it.
function snapBendPoint(arc, index, x, y, noSnap) {
  if (noSnap) return { x, y, guides: [] };
  const alignPoints = [
    ...[...netData.states, ...netData.transitions].map(n => ({ x: n.x, y: n.y })),
    ...netData.arcs.flatMap(a => (a.points || [])
      .filter((_, i) => !(a === arc && i === index)))
  ];
  const snap = calculateAlignmentGuides(null, x, y, { alignPoints, spacingPoints: [] });
  return { x: snap.snappedX, y: snap.snappedY, guides: snap.guides };
}

function updateBendDrag(arc, pt, noSnap) {
  const d = draggingCurve;
  if (d.kind === 'break') {
    if (Math.hypot(pt.x - d.start.x, pt.y - d.start.y) < BREAK_DRAG_THRESHOLD) return [];
    arc.points = arc.points || [];
    arc.points.splice(d.seg, 0, { x: pt.x, y: pt.y });   // the line breaks here
    Object.assign(d, { kind: 'v', index: d.seg, grabX: 0, grabY: 0 });
  }
  const snapped = snapBendPoint(arc, d.index, pt.x - d.grabX, pt.y - d.grabY, noSnap);
  arc.points[d.index] = { x: snapped.x, y: snapped.y };
  return snapped.guides;
}

// Press on the curve itself: bend it so the grabbed point follows the pointer.
function startCurveBodyDrag(arc, pressPoint) {
  const geometry = arcGeometry(arc);
  if (!geometry?.control2) return;
  // Clamp so grabbing very near an end doesn't need absurdly large offsets.
  const t = Math.min(0.88, Math.max(0.12, nearestCurveT(geometry, pressPoint)));
  draggingCurve = {
    arc: arc.name, kind: 'body', start: pressPoint, t,
    base: arc.curve ? { ...arc.curve } : { c1x: 0, c1y: 0, c2x: 0, c2y: 0 }
  };
}

// Returns the alignment guides to draw (only bend-point drags produce any).
function updateCurveDrag(pt, noSnap = false) {
  const d = draggingCurve;
  const arc = netData.arcs.find(item => item.name === d.arc);
  if (!arc) return [];
  if (d.kind === 'break' || d.kind === 'v') return updateBendDrag(arc, pt, noSnap);
  const auto = arcGeometry(arc, { ignoreCurve: true });
  if (!auto?.auto1) return;
  const cur = arc.curve || { c1x: 0, c1y: 0, c2x: 0, c2y: 0 };

  if (d.kind === 'c1') {
    arc.curve = { ...cur, c1x: pt.x - d.grabX - auto.auto1.x, c1y: pt.y - d.grabY - auto.auto1.y };
  } else if (d.kind === 'c2') {
    arc.curve = { ...cur, c2x: pt.x - d.grabX - auto.auto2.x, c2y: pt.y - d.grabY - auto.auto2.y };
  } else {
    // Moving both controls by D shifts the curve point at parameter t by 3t(1-t)D.
    const k = 1 / (3 * d.t * (1 - d.t));
    const dx = (pt.x - d.start.x) * k, dy = (pt.y - d.start.y) * k;
    arc.curve = {
      c1x: d.base.c1x + dx, c1y: d.base.c1y + dy,
      c2x: d.base.c2x + dx, c2y: d.base.c2y + dy
    };
  }
}

loadLocal();
render();
initHistory();


// Help dialog
const helpModal = document.getElementById('help-modal');
const helpUsageTab = document.getElementById('help-usage-tab');
const helpShortcutsTab = document.getElementById('help-shortcuts-tab');
const helpUsage = document.getElementById('help-usage');
const helpShortcuts = document.getElementById('help-shortcuts');

function setHelpPage(page) {
  const usage = page === 'usage';
  helpUsage.hidden = !usage;
  helpShortcuts.hidden = usage;
  helpUsageTab.classList.toggle('active', usage);
  helpShortcutsTab.classList.toggle('active', !usage);
}
function openHelp(page = 'usage') {
  helpModal.hidden = false;
  setHelpPage(page);
  document.getElementById('help-close').focus();
}
function closeHelp() { helpModal.hidden = true; }

document.getElementById('help-toggle').onclick = () => openHelp();
document.getElementById('help-close').onclick = closeHelp;
document.getElementById('help-backdrop').onclick = closeHelp;
helpUsageTab.onclick = () => setHelpPage('usage');
helpShortcutsTab.onclick = () => setHelpPage('shortcuts');

// Settings dialog (built from SETTINGS_SCHEMA)
const settingsModal = document.getElementById('settings-modal');
const settingsContent = document.getElementById('settings-content');

function renderSettings() {
  settingsContent.innerHTML = '';
  for (const def of SETTINGS_SCHEMA) {
    const section = document.createElement('fieldset');
    section.className = 'setting';
    const legend = document.createElement('legend');
    legend.textContent = def.label;
    section.appendChild(legend);

    if (def.type === 'choice') {
      for (const option of def.options) {
        const label = document.createElement('label');
        label.className = 'setting-option';
        const input = document.createElement('input');
        input.type = 'radio';
        input.name = `setting-${def.key}`;
        input.value = option.value;
        input.checked = settings[def.key] === option.value;
        input.onchange = () => { settings[def.key] = option.value; saveSettings(); render(); };
        const text = document.createElement('span');
        const title = document.createElement('b');
        title.textContent = option.label;
        text.appendChild(title);
        if (option.description) {
          const desc = document.createElement('small');
          desc.textContent = option.description;
          text.appendChild(desc);
        }
        label.append(input, text);
        section.appendChild(label);
      }
    } else if (def.type === 'boolean') {
      const label = document.createElement('label');
      label.className = 'setting-option';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = !!settings[def.key];
      input.onchange = () => { settings[def.key] = input.checked; saveSettings(); render(); };
      const text = document.createElement('span');
      text.textContent = def.description || def.label;
      label.append(input, text);
      section.appendChild(label);
    }
    settingsContent.appendChild(section);
  }
}
function openSettings() {
  renderSettings();
  settingsModal.hidden = false;
  document.getElementById('settings-close').focus();
}
function closeSettings() { settingsModal.hidden = true; }
document.getElementById('settings-toggle').onclick = openSettings;
document.getElementById('settings-close').onclick = closeSettings;
document.getElementById('settings-backdrop').onclick = closeSettings;

// PNG export ----------------------------------------------------------------
// The canvas is cloned off-screen, every element gets its computed style baked
// in while the *chosen* theme is applied (so the output does not depend on the
// theme currently shown), and the result is rasterised through a <canvas>.
const EXPORT_KEY = 'pytri-export-v1';
const EXPORT_PAD = 40;
const EXPORT_MAX_PIXELS = 16_000_000;
const EXPORT_BACKGROUNDS = { transparent: null, white: '#ffffff', black: '#000000' };
const EXPORT_STYLE_PROPS = ['fill', 'stroke', 'stroke-width', 'stroke-dasharray',
  'stroke-linejoin', 'stroke-linecap', 'opacity', 'font-family', 'font-size',
  'font-style', 'font-weight', 'text-anchor', 'paint-order'];

const exportModal = document.getElementById('export-modal');
const exportPreview = document.getElementById('export-preview');
const exportEmpty = document.getElementById('export-empty');
const exportInfo = document.getElementById('export-info');
const exportDownloadBtn = document.getElementById('export-download');
let exportOptions = { theme: 'light', background: 'white', scale: 2 };
let exportBlob = null;
let exportPreviewUrl = null;
let exportToken = 0;

function currentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}
function matchingBackground(theme) { return theme === 'dark' ? 'black' : 'white'; }

function buildExportSvg(theme) {
  const holder = svg.cloneNode(true);
  holder.removeAttribute('id');
  holder.setAttribute('width', BASE_WIDTH);
  holder.setAttribute('height', BASE_HEIGHT);
  holder.setAttribute('viewBox', `0 0 ${BASE_WIDTH} ${BASE_HEIGHT}`);
  holder.setAttribute('style', 'position:absolute;left:-99999px;top:0;visibility:hidden;pointer-events:none');
  holder.querySelector('#guides-layer')?.remove();
  holder.querySelector('#handles-layer')?.remove();
  holder.querySelectorAll('.arc-hit').forEach(n => n.remove());
  holder.querySelector('#pending-arc')?.remove();
  holder.querySelectorAll('.selected').forEach(n => n.classList.remove('selected'));
  document.body.appendChild(holder);

  const root = document.documentElement;
  const previousTheme = root.getAttribute('data-theme');
  try {
    // Content bounds (arcs + nodes + labels), measured on the clean clone.
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const id of ['#arcs-layer', '#nodes-layer']) {
      const layer = holder.querySelector(id);
      if (!layer || !layer.childNodes.length) continue;
      const b = layer.getBBox();
      if (!b.width && !b.height) continue;
      minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.width); maxY = Math.max(maxY, b.y + b.height);
    }
    if (!Number.isFinite(minX)) return null;

    root.setAttribute('data-theme', theme);
    for (const el of holder.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      el.setAttribute('style', EXPORT_STYLE_PROPS
        .map(p => `${p}:${cs.getPropertyValue(p)}`).join(';'));
      const marker = /#([^"')]+)/.exec(cs.getPropertyValue('marker-end'));
      if (marker) el.setAttribute('marker-end', `url(#${marker[1]})`);
    }

    const x = Math.floor(minX - EXPORT_PAD), y = Math.floor(minY - EXPORT_PAD);
    const w = Math.ceil(maxX - minX + EXPORT_PAD * 2), h = Math.ceil(maxY - minY + EXPORT_PAD * 2);
    return { holder, x, y, w, h };
  } finally {
    root.setAttribute('data-theme', previousTheme);
    holder.remove();
  }
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('The drawing could not be rasterised.'));
    img.src = src;
  });
}

async function renderExportPng() {
  const token = ++exportToken;
  const built = buildExportSvg(exportOptions.theme);
  if (!built) {
    exportBlob = null;
    exportPreview.hidden = true;
    exportEmpty.hidden = false;
    exportInfo.textContent = '';
    exportDownloadBtn.disabled = true;
    return;
  }
  const { holder, x, y, w, h } = built;
  const maxScale = Math.sqrt(EXPORT_MAX_PIXELS / (w * h));
  const scale = Math.min(exportOptions.scale, maxScale);
  const pw = Math.max(1, Math.round(w * scale)), ph = Math.max(1, Math.round(h * scale));

  holder.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  holder.setAttribute('viewBox', `${x} ${y} ${w} ${h}`);
  holder.setAttribute('width', pw);
  holder.setAttribute('height', ph);
  holder.removeAttribute('style');
  const xml = new XMLSerializer().serializeToString(holder);

  try {
    const img = await loadImage('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml));
    const canvas = document.createElement('canvas');
    canvas.width = pw; canvas.height = ph;
    const ctx = canvas.getContext('2d');
    const bg = EXPORT_BACKGROUNDS[exportOptions.background];
    if (bg) { ctx.fillStyle = bg; ctx.fillRect(0, 0, pw, ph); }
    ctx.drawImage(img, 0, 0, pw, ph);
    const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
    if (token !== exportToken) return;           // a newer render superseded this one
    if (!blob) throw new Error('The PNG could not be created.');
    exportBlob = blob;
    if (exportPreviewUrl) URL.revokeObjectURL(exportPreviewUrl);
    exportPreviewUrl = URL.createObjectURL(blob);
    exportPreview.src = exportPreviewUrl;
    exportPreview.hidden = false;
    exportEmpty.hidden = true;
    exportDownloadBtn.disabled = false;
    exportInfo.textContent = `${pw} × ${ph} px` +
      (scale < exportOptions.scale ? ' (scale reduced to fit browser limits)' : '');
  } catch (err) {
    if (token !== exportToken) return;
    exportBlob = null;
    exportDownloadBtn.disabled = true;
    exportInfo.textContent = err.message;
  }
}

function syncExportInputs() {
  for (const [name, value] of Object.entries({
    'export-theme': exportOptions.theme,
    'export-background': exportOptions.background,
    'export-scale': String(exportOptions.scale)
  })) {
    exportModal.querySelectorAll(`input[name="${name}"]`)
      .forEach(input => { input.checked = input.value === value; });
  }
}

function openExport() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(EXPORT_KEY) || '{}') || {}; } catch (_) {}
  const theme = currentTheme();
  exportOptions = {
    theme,
    background: saved.background === 'transparent' ? 'transparent' : matchingBackground(theme),
    scale: [1, 2, 3, 4].includes(saved.scale) ? saved.scale : 2
  };
  syncExportInputs();
  exportModal.hidden = false;
  document.getElementById('export-close').focus();
  renderExportPng();
}
function closeExport() {
  exportModal.hidden = true;
  exportToken++;
  if (exportPreviewUrl) { URL.revokeObjectURL(exportPreviewUrl); exportPreviewUrl = null; }
  exportPreview.removeAttribute('src');
  exportBlob = null;
}

exportModal.addEventListener('change', e => {
  const input = e.target;
  if (!(input instanceof HTMLInputElement)) return;
  if (input.name === 'export-theme') {
    exportOptions.theme = input.value;
    // A solid background follows the theme (white for light, black for dark).
    if (exportOptions.background !== 'transparent') {
      exportOptions.background = matchingBackground(input.value);
    }
  } else if (input.name === 'export-background') {
    exportOptions.background = input.value;
  } else if (input.name === 'export-scale') {
    exportOptions.scale = Number(input.value);
  } else return;
  try {
    localStorage.setItem(EXPORT_KEY, JSON.stringify({
      background: exportOptions.background, scale: exportOptions.scale
    }));
  } catch (_) {}
  syncExportInputs();
  renderExportPng();
});

exportDownloadBtn.onclick = () => {
  if (!exportBlob) return;
  const url = URL.createObjectURL(exportBlob);
  const a = document.createElement('a');
  const safeName = (netData.name || 'Untitled_Net').replace(/[\\/:*?"<>|\s]+/g, '_');
  a.href = url; a.download = `${safeName}.png`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
document.getElementById('btn-export-png').onclick = openExport;
document.getElementById('export-close').onclick = closeExport;
document.getElementById('export-backdrop').onclick = closeExport;

// Net description dialog -----------------------------------------------------
// A free-text space about the whole net. For now it is only stored (with the
// net, in exports and in undo history); nothing else on screen uses it yet.
const netDescModal = document.getElementById('netdesc-modal');
const netDescText = document.getElementById('netdesc-text');
const netDescCount = document.getElementById('netdesc-count');

function updateNetDescCount() {
  netDescCount.textContent = `${netDescText.value.length} characters`;
}
function openNetDesc() {
  netDescText.value = netData.description || '';
  updateNetDescCount();
  netDescModal.hidden = false;
  netDescText.focus();
}
function commitNetDesc() {
  if (netDescText.value === (netData.description || '')) return;
  netData.description = netDescText.value;
  saveLocal();
  updateNetDescButton();
}
function closeNetDesc() {
  commitNetDesc();
  netDescModal.hidden = true;
}
netDescText.addEventListener('input', updateNetDescCount);
netDescText.addEventListener('change', commitNetDesc);       // also fires on blur
document.getElementById('netdesc-toggle').onclick = openNetDesc;
document.getElementById('netdesc-close').onclick = closeNetDesc;
document.getElementById('netdesc-backdrop').onclick = closeNetDesc;

function anyModalOpen() {
  return !helpModal.hidden || !settingsModal.hidden || !exportModal.hidden ||
         !netDescModal.hidden || !reachabilityModal.hidden || matrixOpen;
}

function isTypingTarget(target) {
  return target instanceof HTMLInputElement ||
         target instanceof HTMLTextAreaElement ||
         target instanceof HTMLSelectElement ||
         target.isContentEditable;
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (!helpModal.hidden) { closeHelp(); return; }
    if (!settingsModal.hidden) { closeSettings(); return; }
    if (!exportModal.hidden) { closeExport(); return; }
    if (!netDescModal.hidden) { closeNetDesc(); return; }
    if (matrixOpen) { closeMatrices(); return; }
    if (!reachabilityModal.hidden) { closeReachability(); return; }
    selected = null;
    arcSource = null;
    setMode('select');
    render();
    return;
  }

  const mod = e.ctrlKey || e.metaKey;
  if (mod) {
    const key = e.key.toLowerCase();

    if (key === 'z') {
      if (isTypingTarget(e.target)) return;
      e.preventDefault();
      e.shiftKey ? redo() : undo();
      return;
    }
    if (key === 'y') {
      if (isTypingTarget(e.target)) return;
      e.preventDefault();
      redo();
      return;
    }
    if (key === 's') {
      e.preventDefault();
      exportNet();
      return;
    }
    if (key === 'o') {
      e.preventDefault();
      document.getElementById('file-input').click();
      return;
    }
    if (key === 'e') {
      e.preventDefault();
      if (exportModal.hidden) openExport(); else closeExport();
      return;
    }
    if (key === 'm') {
      if (isTypingTarget(e.target)) return;
      e.preventDefault();
      document.getElementById('matrix-toggle').click();
      return;
    }
    if (key === 'd') {
      if (isTypingTarget(e.target)) return;
      e.preventDefault();
      document.getElementById('theme-toggle').click();
      return;
    }
    if (key === '/' || e.key === '/') {
      e.preventDefault();
      openHelp('shortcuts');
      return;
    }
    if (e.key === '=' || e.key === '+' || key === '=' || key === '+') {
      e.preventDefault();
      applyZoom(currentZoomLevel + ZOOM_STEP);
      return;
    }
    if (e.key === '-' || key === '-') {
      e.preventDefault();
      applyZoom(currentZoomLevel - ZOOM_STEP);
      return;
    }
    if (e.key === '0' || key === '0') {
      e.preventDefault();
      applyZoom(1.0);
      return;
    }
  }

  if (!isTypingTarget(e.target)) {
    if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      applyZoom(currentZoomLevel + ZOOM_STEP);
      return;
    }
    if (e.key === '-') {
      e.preventDefault();
      applyZoom(currentZoomLevel - ZOOM_STEP);
      return;
    }
    if (e.key === '0') {
      e.preventDefault();
      applyZoom(1.0);
      return;
    }
  }

  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (isTypingTarget(e.target) || anyModalOpen() || mod || e.altKey) return;
    if (selected) {
      e.preventDefault();
      try {
        if (selected.kind === 'arc') removeArc(selected.name);
        else removeNode(selected.name);
      } catch (err) { showError(err.message); }
    }
    return;
  }

  if (e.code === 'Space') {
    if (isTypingTarget(e.target)) return;
    if (selected?.kind === 'transition') {
      e.preventDefault();
      try { fireTransition(selected.name); }
      catch (err) { showError(err.message); }
    }
  }
});

// Canvas zoom controls (PC & Mobile implementation) ------------------------

/**
 * Apply canvas zoom with focal point centering.
 * @param {number} newZoomLevel - Target zoom scale
 * @param {number} [centerClientX] - Client X coordinate of focal center point
 * @param {number} [centerClientY] - Client Y coordinate of focal center point
 */
function applyZoom(newZoomLevel, centerClientX, centerClientY) {
  const targetZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(newZoomLevel * 100) / 100));
  if (targetZoom === currentZoomLevel && svg.getAttribute('viewBox')) return;

  const oldZoom = currentZoomLevel;
  currentZoomLevel = targetZoom;

  const rect = canvasWrap.getBoundingClientRect();
  let focalX = centerClientX !== undefined ? (centerClientX - rect.left) : (canvasWrap.clientWidth / 2);
  let focalY = centerClientY !== undefined ? (centerClientY - rect.top) : (canvasWrap.clientHeight / 2);

  focalX = Math.max(0, Math.min(canvasWrap.clientWidth, focalX));
  focalY = Math.max(0, Math.min(canvasWrap.clientHeight, focalY));

  const ratio = currentZoomLevel / oldZoom;
  const newScrollLeft = (canvasWrap.scrollLeft + focalX) * ratio - focalX;
  const newScrollTop = (canvasWrap.scrollTop + focalY) * ratio - focalY;

  const scaledWidth = Math.round(BASE_WIDTH * currentZoomLevel);
  const scaledHeight = Math.round(BASE_HEIGHT * currentZoomLevel);

  svg.setAttribute('width', scaledWidth);
  svg.setAttribute('height', scaledHeight);
  svg.style.width = `${scaledWidth}px`;
  svg.style.height = `${scaledHeight}px`;
  svg.setAttribute('viewBox', `0 0 ${BASE_WIDTH} ${BASE_HEIGHT}`);

  canvasWrap.scrollLeft = newScrollLeft;
  canvasWrap.scrollTop = newScrollTop;

  const zoomDisplay = document.getElementById('zoom-level');
  if (zoomDisplay) {
    zoomDisplay.textContent = `${Math.round(currentZoomLevel * 100)}%`;
  }
}

// 1. Toolbar button listeners
const btnIn = document.getElementById('zoom-in');
if (btnIn) {
  btnIn.onclick = (e) => {
    e.preventDefault();
    applyZoom(currentZoomLevel + ZOOM_STEP);
  };
}

const btnOut = document.getElementById('zoom-out');
if (btnOut) {
  btnOut.onclick = (e) => {
    e.preventDefault();
    applyZoom(currentZoomLevel - ZOOM_STEP);
  };
}

const btnReset = document.getElementById('zoom-reset');
if (btnReset) {
  btnReset.onclick = (e) => {
    e.preventDefault();
    applyZoom(1.0);
  };
}

const zoomBadge = document.getElementById('zoom-level');
if (zoomBadge) {
  zoomBadge.onclick = (e) => {
    e.preventDefault();
    applyZoom(1.0);
  };
}

// 2. PC Mouse Wheel & Trackpad Pinch Zoom (centered at mouse cursor)
if (canvasWrap) {
  canvasWrap.addEventListener('wheel', (e) => {
    e.preventDefault();
    const delta = e.deltaY < 0 ? 0.12 : -0.12;
    applyZoom(currentZoomLevel + delta, e.clientX, e.clientY);
  }, { passive: false });
}

// 3. Mobile Touch 2-Finger Pinch-to-Zoom & Double-Tap
let initialPinchDist = null;
let initialPinchZoom = 1.0;
let lastTapTime = 0;

if (canvasWrap) {
  canvasWrap.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
      // Cancel single finger dragging / panning while pinching
      dragging = null;
      draggingLabel = null;
      draggingCurve = null;
      panning = null;

      const t1 = e.touches[0];
      const t2 = e.touches[1];
      initialPinchDist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
      initialPinchZoom = currentZoomLevel;
    }
  }, { passive: true });

  canvasWrap.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2 && initialPinchDist) {
      if (e.cancelable) e.preventDefault();
      const t1 = e.touches[0];
      const t2 = e.touches[1];
      const currentDist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
      if (currentDist > 0) {
        const scaleRatio = currentDist / initialPinchDist;
        const targetZoom = initialPinchZoom * scaleRatio;
        const midX = (t1.clientX + t2.clientX) / 2;
        const midY = (t1.clientY + t2.clientY) / 2;
        applyZoom(targetZoom, midX, midY);
      }
    }
  }, { passive: false });

  const endPinch = (e) => {
    if (e.touches.length < 2) {
      initialPinchDist = null;
    }
  };
  canvasWrap.addEventListener('touchend', endPinch, { passive: true });
  canvasWrap.addEventListener('touchcancel', endPinch, { passive: true });

  // Double-tap on canvas space to toggle zoom on touch devices
  canvasWrap.addEventListener('touchend', (e) => {
    if (e.touches.length === 0 && e.changedTouches.length === 1) {
      const now = Date.now();
      const touch = e.changedTouches[0];
      if (now - lastTapTime < 300 && !e.target.closest('[data-name]')) {
        const nextZoom = currentZoomLevel === 1.0 ? 1.5 : 1.0;
        applyZoom(nextZoom, touch.clientX, touch.clientY);
      }
      lastTapTime = now;
    }
  }, { passive: true });
}

// Re-evaluate the panel when crossing the mobile/desktop breakpoint.
window.matchMedia('(max-width: 700px)').addEventListener('change', () => renderInspector());

// 4. Floating Entity Options Button Trigger
const optionsBtn = document.getElementById('entity-options-btn') || document.getElementById('mobile-options-btn');
if (optionsBtn) {
  optionsBtn.onclick = (e) => {
    e.preventDefault();
    mobileInspectorOpen = true;
    renderInspector();
  };
}

// Initial zoom setup
applyZoom(currentZoomLevel);


