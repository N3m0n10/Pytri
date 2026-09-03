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

function nextName(kind) {
  const prefix = kind === 'state' ? 'p' : kind === 'action' ? 't' : 'a';
  while (true) {
    netData.counters[kind]++;
    const name = prefix + netData.counters[kind];
    if (!findNode(name) && !netData.transitions.some(t => t.name === name)) return name;
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

function saveLocal() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(netData));
}

function loadLocal() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    netData = normalizeNet(parsed);
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
  netData.states.push({
    name, description, ficha_count: 0, x, y,
    rotation: 0, label_dx: 0, label_dy: 46
  });
  saveLocal(); render();
}

function addAction(name, description, x, y) {
  validateUniqueNodeName(name);
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
  // Keep the JSON compatible with the Python model: counters are harmless extra metadata.
  delete out.counters;
  const blob = new Blob([JSON.stringify(out, null, 2)], {type: 'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const safeName = (netData.name || 'Untitled_Net').replace(/\s+/g, '_');
  a.href = url; a.download = `${safeName}.json`; a.click();
  URL.revokeObjectURL(url);
}

async function importNet(file) {
  const parsed = JSON.parse(await file.text());
  netData = normalizeNet(parsed);
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
      const name = prompt('Place name:', nextName('state'));
      if (!name) return;
      const description = prompt('Description (optional):', '') || '';
      addState(name.trim(), description, pt.x, pt.y);
    } else if (mode === 'action' && !hit) {
      const name = prompt('Transition (action) name:', nextName('action'));
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
        const arcName = prompt('Arc name:', nextName('transition'));
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

nodesLayer.addEventListener('mousedown', e => {
  if (mode !== 'select') return;
  const hit = e.target.closest('[data-name]');
  if (!hit) return;
  dragMoved = false;
  if (e.target.dataset.role === 'label')
    draggingLabel = {kind: hit.dataset.kind, name: hit.dataset.name};
  else
    dragging = hit.dataset.name;
});

arcsLayer.addEventListener('mousedown', e => {
  if (mode !== 'select' || e.target.dataset.role !== 'label') return;
  const hit = e.target.closest('[data-name]');
  if (!hit) return;
  dragMoved = false;
  draggingLabel = {kind: 'transition', name: hit.dataset.name};
});

svg.addEventListener('mousemove', e => {
  if (!dragging && !draggingLabel) return;
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
          t.label_dx = pt.x - (s.x + tg.x)/2;
          t.label_dy = pt.y - (s.y + tg.y)/2;
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

window.addEventListener('mouseup', () => {
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

function render() {
  if (!netData) return;
  document.getElementById('netname').value = netData.name;
  arcsLayer.innerHTML = '';
  nodesLayer.innerHTML = '';

  for (const t of netData.transitions) {
    const s = findNode(t.source), tg = findNode(t.target);
    if (!s || !tg) continue;
    const sKind = nodeKind(t.source), tKind = nodeKind(t.target);
    const p1 = boundaryPoint(s, sKind, tg.x, tg.y);
    const p2 = boundaryPoint(tg, tKind, s.x, s.y);

    const g = document.createElementNS(svg.namespaceURI, 'g');
    g.classList.add('arc');
    g.dataset.name = t.name; g.dataset.kind = 'transition';

    const line = document.createElementNS(svg.namespaceURI, 'line');
    line.setAttribute('x1', p1.x); line.setAttribute('y1', p1.y);
    line.setAttribute('x2', p2.x); line.setAttribute('y2', p2.y);
    line.setAttribute('class', 'type-' + t.arc_type +
      (selected?.kind === 'transition' && selected.name === t.name ? ' selected' : ''));
    line.dataset.name = t.name; line.dataset.kind = 'transition';
    line.addEventListener('click', e => {
      if (mode === 'select') { e.stopPropagation(); selectNode('transition', t.name); }
    });
    g.appendChild(line);

    const label = document.createElementNS(svg.namespaceURI, 'text');
    label.setAttribute('x', (s.x+tg.x)/2 + (t.label_dx ?? 6));
    label.setAttribute('y', (s.y+tg.y)/2 + (t.label_dy ?? -6));
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
}

loadLocal();
render();
