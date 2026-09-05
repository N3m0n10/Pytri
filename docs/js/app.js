/* Pytri: browser-only implementation of the Flask API/model.
   The original Flask app exposes a REST wrapper around petri.py.
   This file replaces that wrapper with an in-browser model, so GitHub Pages
   can run the application without a Python server. */

const svg = document.getElementById('svg');
const arcsLayer = document.getElementById('arcs-layer');
const nodesLayer = document.getElementById('nodes-layer');
const hint = document.getElementById('hint');
const errorBox = document.getElementById('error');
const inspector = document.getElementById('inspector');
const STORAGE_KEY = 'pytri-net-v1';

let mode = 'select';
let netData = emptyNet('Untitled Net');
let arcSource = null;
let selected = null;
let dragging = null;
let draggingLabel = null;
let dragMoved = false;
let matrixView = 'incidence';
let matrixOpen = false;

const MAX_HISTORY = 80;
let history = [];
let historyIndex = -1;
let restoringHistory = false;
let svgZoom = 1;

const HINTS = {
  select: 'Click a node or arc to inspect/edit it. Drag a node body to move it, or drag its label to reposition just the text.',
  state: 'Click on the canvas to place a new State (a place that holds tokens).',
  action: 'Click on the canvas to place a new Action (a transition bar).',
  arc: 'Click a source node, then a target node, to connect them with an arc.'
};

function emptyNet(name) {
  return {
    name,
    states: [],
    actions: [],
    transitions: [],
    counters: { state: 0, action: 0, transition: 0 }
  };
}

// Name allocation is deliberately split into "suggest" and "commit".
// A failed/cancelled name dialog must NOT consume the next number.
// Removed automatic names are kept in a reuse buffer, matching petri.py's
// _removed_*_names behaviour.
const renameBuffer = { state: [], action: [], transition: [] };

function nameTaken(name) {
  return !!findNode(name) || netData.transitions.some(t => t.name === name);
}

function syncRenameBuffer() {
  // Imported/old localStorage data may not have the buffer. Keep only names
  // that are currently free and unique.
  for (const kind of Object.keys(renameBuffer)) {
    renameBuffer[kind] = [...new Set(renameBuffer[kind])].filter(n => !nameTaken(n));
  }
}

function suggestName(kind) {
  syncRenameBuffer();
  if (renameBuffer[kind].length) return renameBuffer[kind][0];

  const prefix = kind === 'state' ? 'p' : kind === 'action' ? 't' : 'a';
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

  const prefix = kind === 'state' ? 'p' : kind === 'action' ? 't' : 'a';
  const match = new RegExp(`^${prefix}(\\d+)$`).exec(name);
  if (match) netData.counters[kind] = Math.max(netData.counters[kind], Number(match[1]));
}

function rememberRemovedName(kind, name) {
  const prefix = kind === 'state' ? 'p' : kind === 'action' ? 't' : 'a';
  if (new RegExp(`^${prefix}\\d+$`).test(name) && !renameBuffer[kind].includes(name)) {
    renameBuffer[kind].push(name);
  }
}

function findNode(name) {
  return netData.states.find(s => s.name === name) ||
         netData.actions.find(a => a.name === name) || null;
}

function nodeKind(name) {
  if (netData.states.some(s => s.name === name)) return 'state';
  if (netData.actions.some(a => a.name === name)) return 'action';
  return null;
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
      action: [...renameBuffer.action],
      transition: [...renameBuffer.transition]
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
    for (const kind of Object.keys(renameBuffer)) {
      renameBuffer[kind] = Array.isArray(parsed.renameBuffer?.[kind])
        ? parsed.renameBuffer[kind].map(String) : [];
    }
  } else {
    // Backwards compatibility with snapshots from the previous static build.
    netData = normalizeNet(parsed);
    for (const kind of Object.keys(renameBuffer)) renameBuffer[kind] = [];
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
      for (const kind of Object.keys(renameBuffer)) {
        renameBuffer[kind] = Array.isArray(parsed.renameBuffer?.[kind])
          ? parsed.renameBuffer[kind].map(String) : [];
      }
    } else {
      netData = normalizeNet(parsed);
    }
    syncRenameBuffer();
  } catch (e) {
    showError('Saved net could not be loaded.');
  }
}

function normalizeNet(data) {
  const n = emptyNet(data?.name || 'Untitled Net');
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
  n.actions = Array.isArray(data?.actions) ? data.actions.map((a, i) => ({
    name: String(a.name ?? `t${i + 1}`),
    description: String(a.description ?? ''),
    enum: a.enum ?? null,
    x: Number(a.x ?? 240),
    y: Number(a.y ?? 80),
    rotation: Number(a.rotation ?? 0),
    label_dx: Number(a.label_dx ?? 0),
    label_dy: Number(a.label_dy ?? 46)
  })) : [];
  n.transitions = Array.isArray(data?.transitions) ? data.transitions.map((t, i) => ({
    name: String(t.name ?? `a${i + 1}`),
    description: String(t.description ?? ''),
    source: String(t.source),
    target: String(t.target),
    weight: Math.max(1, parseInt(t.weight ?? 1, 10) || 1),
    arc_type: ['normal', 'inhibitor', 'read'].includes(t.arc_type) ? t.arc_type : 'normal',
    label_dx: Number(t.label_dx ?? 6),
    label_dy: Number(t.label_dy ?? -6)
  })) : [];
  n.counters = {
    state: Number(data?.counters?.state ?? 0),
    action: Number(data?.counters?.action ?? 0),
    transition: Number(data?.counters?.transition ?? 0)
  };
  // Make counters at least large enough to avoid collisions after imports.
  for (const s of n.states) {
    const m = /^p(\d+)$/.exec(s.name); if (m) n.counters.state = Math.max(n.counters.state, +m[1]);
  }
  for (const a of n.actions) {
    const m = /^t(\d+)$/.exec(a.name); if (m) n.counters.action = Math.max(n.counters.action, +m[1]);
  }
  for (const t of n.transitions) {
    const m = /^a(\d+)$/.exec(t.name); if (m) n.counters.transition = Math.max(n.counters.transition, +m[1]);
  }
  return n;
}

function netPayload() {
  return {
    name: netData.name,
    states: netData.states,
    actions: netData.actions.map(a => ({...a, enabled: isEnabled(a.name)})),
    transitions: netData.transitions
  };
}

function isEnabled(actionName) {
  const action = netData.actions.find(a => a.name === actionName);
  if (!action) throw new Error(`Action '${actionName}' does not exist.`);
  const pre = netData.transitions.filter(t =>
    t.target === actionName && nodeKind(t.source) === 'state'
  );
  for (const t of pre) {
    const state = findNode(t.source);
    if (t.arc_type === 'inhibitor') {
      if (state.ficha_count >= t.weight) return false;
    } else {
      if (state.ficha_count < t.weight) return false;
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

function addAction(name, description, x, y) {
  validateUniqueNodeName(name);
  commitName('action', name);
  netData.actions.push({
    name, description, enum: netData.actions.length, x, y,
    rotation: 0, label_dx: 0, label_dy: 46
  });
  saveLocal(); render();
}

function addArc(name, description, source, target, weight, arc_type) {
  validateUniqueName(name);
  const sourceKind = nodeKind(source), targetKind = nodeKind(target);
  if (!((sourceKind === 'state' && targetKind === 'action') ||
        (sourceKind === 'action' && targetKind === 'state'))) {
    throw new Error('Petri nets are bipartite: an arc must connect a State to an Action, or an Action to a State.');
  }
  if (netData.transitions.some(t => t.source === source && t.target === target)) {
    throw new Error(`An arc from '${source}' to '${target}' already exists.`);
  }
  if (!['normal', 'inhibitor', 'read'].includes(arc_type)) arc_type = 'normal';
  if (sourceKind !== 'state') arc_type = 'normal';
  if (!Number.isInteger(weight) || weight < 1) throw new Error('Arc weight must be a positive integer.');
  // Only consume/increment the name allocator after the operation is known
  // to be valid. A failed arc creation must leave the suggestion untouched.
  commitName('transition', name);
  netData.transitions.push({
    name, description, source, target, weight, arc_type,
    label_dx: 6, label_dy: -6
  });
  saveLocal(); render();
}

function validateUniqueName(name) {
  if (!name) throw new Error('A name is required.');
  if (findNode(name) || netData.transitions.some(t => t.name === name))
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
  for (const t of netData.transitions) {
    if (t.source === oldName) t.source = newName;
    if (t.target === oldName) t.target = newName;
  }
  if (selected) selected.name = newName;
  saveLocal(); render();
}

function removeNode(name) {
  const kind = nodeKind(name);
  if (!kind) throw new Error(`No node named '${name}'.`);
  rememberRemovedName(kind, name);
  // Deleting a node also deletes its arcs. Those arc names are reusable too.
  for (const t of netData.transitions) {
    if (t.source === name || t.target === name) rememberRemovedName('transition', t.name);
  }
  netData.transitions = netData.transitions.filter(t => t.source !== name && t.target !== name);
  if (kind === 'state') netData.states = netData.states.filter(s => s.name !== name);
  else netData.actions = netData.actions.filter(a => a.name !== name);
  if (selected?.name === name) selected = null;
  saveLocal(); render();
}

function removeArc(name) {
  const before = netData.transitions.length;
  netData.transitions = netData.transitions.filter(t => t.name !== name);
  if (before === netData.transitions.length) throw new Error(`Arc '${name}' does not exist.`);
  rememberRemovedName('transition', name);
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

function fireAction(name) {
  if (!isEnabled(name)) throw new Error(`Action '${name}' is not enabled -- a precondition on one of its input places is not satisfied.`);
  const pre = netData.transitions.filter(t => t.target === name && nodeKind(t.source) === 'state');
  const post = netData.transitions.filter(t => t.source === name && nodeKind(t.target) === 'state');
  for (const t of pre) {
    if (t.arc_type === 'normal') findNode(t.source).ficha_count -= t.weight;
  }
  for (const t of post) findNode(t.target).ficha_count += t.weight;
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
      action: [...renameBuffer.action],
      transition: [...renameBuffer.transition]
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
    for (const kind of Object.keys(renameBuffer)) {
      renameBuffer[kind] = Array.isArray(parsed.renameBuffer?.[kind])
        ? parsed.renameBuffer[kind].map(String) : [];
    }
  } else {
    netData = normalizeNet(parsed);
    for (const kind of Object.keys(renameBuffer)) {
      renameBuffer[kind] = Array.isArray(parsed?._editor?.renameBuffer?.[kind])
        ? parsed._editor.renameBuffer[kind].map(String) : [];
    }
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



document.getElementById('matrix-toggle').onclick = () => {
  matrixOpen = !matrixOpen;
  document.getElementById('matrix-panel').hidden = !matrixOpen;
  if (matrixOpen) renderMatrices();
};
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

function renderMatrices() {
  const content = document.getElementById('matrix-content');
  if (!content) return;
  const states = netData.states;
  const arcs = netData.transitions;
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
  ['select', 'state', 'action', 'arc'].forEach(k =>
    document.getElementById('mode-' + k).classList.toggle('active', k === m));
  hint.textContent = HINTS[m];
  render();
}
document.getElementById('mode-select').onclick = () => setMode('select');
document.getElementById('mode-state').onclick = () => setMode('state');
document.getElementById('mode-action').onclick = () => setMode('action');
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
  const rect = svg.getBoundingClientRect();
  return {
    x: evt.clientX - rect.left + svg.parentElement.scrollLeft,
    y: evt.clientY - rect.top + svg.parentElement.scrollTop
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

svg.addEventListener('click', e => {
  if (dragging || draggingLabel || dragMoved) { dragMoved = false; return; }
  const pt = svgPoint(e);
  const hit = e.target.closest('[data-name]');

  try {
    if (mode === 'state' && !hit) {
      const name = prompt('Place name:', suggestName('state'));
      if (!name) return;
      const description = prompt('Description (optional):', '') || '';
      addState(name.trim(), description, pt.x, pt.y);
    } else if (mode === 'action' && !hit) {
      const name = prompt('Transition (action) name:', suggestName('action'));
      if (!name) return;
      const description = prompt('Description (optional):', '') || '';
      addAction(name.trim(), description, pt.x, pt.y);
    } else if (mode === 'arc' && hit) {
      const name = hit.dataset.name;
      if (!arcSource) {
        arcSource = name;
        hint.textContent = `Source: "${name}". Now click the target node.`;
        render();
      } else {
        const source = arcSource;
        const target = name;
        const arcName = prompt('Arc name:', suggestName('transition'));
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
      selected = null; render();
    }
  } catch (err) {
    showError(err.message);
    arcSource = null;
    render();
  }
});

nodesLayer.addEventListener('pointerdown', e => {
  if (mode !== 'select') return;
  const hit = e.target.closest('[data-name]');
  if (hit) hit.setPointerCapture?.(e.pointerId);
  if (!hit) return;
  dragMoved = false;
  if (e.target.dataset.role === 'label')
    draggingLabel = {kind: hit.dataset.kind, name: hit.dataset.name};
  else
    dragging = hit.dataset.name;
});

arcsLayer.addEventListener('pointerdown', e => {
  if (mode !== 'select' || e.target.dataset.role !== 'label') return;
  e.preventDefault();
  const hit = e.target.closest('[data-name]');
  if (!hit) return;
  dragMoved = false;
  draggingLabel = {kind: 'transition', name: hit.dataset.name};
});

svg.addEventListener('pointermove', e => {
  if (!dragging && !draggingLabel) return;
  e.preventDefault();
  dragMoved = true;
  const pt = svgPoint(e);
  if (dragging) {
    const node = findNode(dragging);
    if (node) { node.x = pt.x; node.y = pt.y; render(); }
  } else if (draggingLabel) {
    if (draggingLabel.kind === 'transition') {
      const t = netData.transitions.find(x => x.name === draggingLabel.name);
      if (t) {
        const s = findNode(t.source), tg = findNode(t.target);
        if (s && tg) {
          const geometry = arcGeometry(t);
          const mx = geometry ? geometry.midX : (s.x + tg.x) / 2;
          const my = geometry ? geometry.midY : (s.y + tg.y) / 2;
          t.label_dx = pt.x - mx;
          t.label_dy = pt.y - my;
          render();
        }
      }
    } else {
      const node = findNode(draggingLabel.name);
      if (node) {
        node.label_dx = pt.x - node.x;
        node.label_dy = pt.y - node.y;
        render();
      }
    }
  }
});

window.addEventListener('pointerup', () => {
  if (dragging || draggingLabel) {
    saveLocal();
    dragging = null;
    draggingLabel = null;
  }
});

function selectNode(kind, name) {
  selected = {kind, name};
  render();
}

function renderInspector() {
  if (!selected) {
    inspector.hidden = true;
    return;
  }
  inspector.hidden = false;
  inspector.innerHTML = '';

  if (selected.kind === 'transition') {
    const t = netData.transitions.find(t => t.name === selected.name);
    if (!t) { selected = null; inspector.hidden = true; return; }
    const canChooseType = nodeKind(t.source) === 'state';
    inspector.innerHTML = `
      <h2>Arc: ${escapeHtml(t.name)}</h2>
      <div class="muted">${escapeHtml(t.source)} &rarr; ${escapeHtml(t.target)}
        (${canChooseType ? 'pre' : 'post'})</div>
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
    document.getElementById('insp-weight').onchange = applyArcChange;
    if (canChooseType) document.getElementById('insp-type').onchange = applyArcChange;
    document.getElementById('insp-delete').onclick = () => removeArc(t.name);
    return;
  }

  const node = findNode(selected.name);
  if (!node) { selected = null; inspector.hidden = true; return; }
  const isState = selected.kind === 'state';
  inspector.innerHTML = `
    <h2>${isState ? 'Place' : 'Action'}: ${escapeHtml(node.name)}
      ${!isState && isEnabled(node.name) ? '<span style="color:var(--enabled)">(enabled)</span>' : ''}</h2>
    <div class="row"><label>Name</label>
      <input id="insp-name" value="${escapeAttr(node.name)}">
      <button id="insp-rename">Rename</button></div>
    <textarea id="insp-desc" rows="2" placeholder="Description">${escapeHtml(node.description || '')}</textarea>
    ${isState ? `
      <div class="row"><label>Tokens: ${node.ficha_count}</label>
        <button id="insp-minus">–1</button><button id="insp-plus">+1</button></div>` :
      `<div class="row"><button id="insp-rotate">⟳ Rotate 90°</button>
        <button id="insp-fire" ${isEnabled(node.name) ? '' : 'disabled'}>▶ Fire</button></div>`}
    <button class="danger" id="insp-delete">Delete ${isState ? 'place' : 'action'}</button>`;

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
    document.getElementById('insp-rotate').onclick = () => {
      node.rotation = ((node.rotation || 0) + 90) % 360;
      saveLocal(); render();
    };
    document.getElementById('insp-fire').onclick = () => {
      try { fireAction(node.name); } catch (err) { showError(err.message); }
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
function arcGeometry(t) {
  const source = findNode(t.source), target = findNode(t.target);
  const sourceKind = nodeKind(t.source), targetKind = nodeKind(t.target);
  if (!source || !target) return null;

  const reverse = netData.transitions.find(other =>
    other !== t && other.source === t.target && other.target === t.source
  );

  // Keep the first direction straight. If the reverse direction exists,
  // route it around the connection instead of sending both arrows through
  // the same centre line. This also makes the arrowhead approach the side
  // of the target unit rather than the same point as the first arrow.
  const isFirst = !reverse ||
    netData.transitions.indexOf(t) < netData.transitions.indexOf(reverse);

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

  for (const t of netData.transitions) {
    const s = findNode(t.source), tg = findNode(t.target);
    if (!s || !tg) continue;
    const geometry = arcGeometry(t);
    if (!geometry) continue;
    const { p1, p2, midX, midY } = geometry;

    const g = document.createElementNS(svg.namespaceURI, 'g');
    g.classList.add('arc');
    g.dataset.name = t.name; g.dataset.kind = 'transition';

    const line = document.createElementNS(svg.namespaceURI, 'path');
    line.setAttribute('d', geometry.path);
    line.setAttribute('class', 'type-' + t.arc_type +
      (selected?.kind === 'transition' && selected.name === t.name ? ' selected' : ''));
    line.dataset.name = t.name; line.dataset.kind = 'transition';
    line.addEventListener('click', e => {
      if (mode === 'select') { e.stopPropagation(); selectNode('transition', t.name); }
    });
    g.appendChild(line);

    const label = document.createElementNS(svg.namespaceURI, 'text');
    label.setAttribute('x', midX + (t.label_dx ?? 6));
    label.setAttribute('y', midY + (t.label_dy ?? -6));
    label.setAttribute('class', 'arc-label');
    label.dataset.name = t.name; label.dataset.kind = 'transition'; label.dataset.role = 'label';
    label.textContent = t.weight > 1 ? `${t.name} [${t.weight}]` : t.name;
    g.appendChild(label);
    arcsLayer.appendChild(g);
  }

  if (mode === 'arc' && arcSource) {
    const s = findNode(arcSource);
    if (s) {
      const line = document.createElementNS(svg.namespaceURI, 'line');
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
            data-role="label" x="${lx}" y="${ly}" text-anchor="middle">${escapeHtml(s.name)}</text>
      ${s.ficha_count > 0 ? `<text class="tokens" x="${s.x}" y="${s.y+5}" text-anchor="middle">${s.ficha_count}</text>` : ''}`;
    nodesLayer.appendChild(g);
  }

  for (const a of netData.actions) {
    const g = document.createElementNS(svg.namespaceURI, 'g');
    g.classList.add('action');
    g.dataset.name = a.name; g.dataset.kind = 'action';
    const isSel = selected?.kind === 'action' && selected.name === a.name;
    const rotation = a.rotation || 0;
    const classes = [isSel ? 'selected' : '', isEnabled(a.name) ? 'enabled' : ''].filter(Boolean).join(' ');
    const lx = a.x + (a.label_dx ?? 0), ly = a.y + (a.label_dy ?? 46);
    g.innerHTML = `
      <rect x="${a.x-10}" y="${a.y-30}" width="20" height="60" class="${classes}"
            transform="rotate(${rotation} ${a.x} ${a.y})"></rect>
      <text class="node-label" data-name="${escapeAttr(a.name)}" data-kind="action"
            data-role="label" x="${lx}" y="${ly}" text-anchor="middle">${escapeHtml(a.name)}</text>`;
    nodesLayer.appendChild(g);
  }

  renderInspector();
  if (matrixOpen) renderMatrices();
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

function isTypingTarget(target) {
  return target instanceof HTMLInputElement ||
         target instanceof HTMLTextAreaElement ||
         target instanceof HTMLSelectElement ||
         target.isContentEditable;
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (!helpModal.hidden) { closeHelp(); return; }
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
    if (key === '/') {
      e.preventDefault();
      openHelp('shortcuts');
      return;
    }
  }

  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (isTypingTarget(e.target)) return;
    if (selected) {
      e.preventDefault();
      try {
        if (selected.kind === 'transition') removeArc(selected.name);
        else removeNode(selected.name);
      } catch (err) { showError(err.message); }
    }
    return;
  }

  if (e.code === 'Space') {
    if (isTypingTarget(e.target)) return;
    if (selected?.kind === 'action') {
      e.preventDefault();
      try { fireAction(selected.name); }
      catch (err) { showError(err.message); }
    }
  }
});

// Canvas zoom controls
function applyZoom() {
  svg.style.transformOrigin = '0 0';
  svg.style.transform = `scale(${svgZoom})`;
}
document.getElementById('zoom-in').onclick = () => {
  svgZoom = Math.min(2, +(svgZoom + 0.1).toFixed(2));
  applyZoom();
};
document.getElementById('zoom-out').onclick = () => {
  svgZoom = Math.max(0.5, +(svgZoom - 0.1).toFixed(2));
  applyZoom();
};
document.getElementById('zoom-reset').onclick = () => {
  svgZoom = 1;
  applyZoom();
};
