/* ── State ───────────────────────────────────────────────────────────────── */
const state = {
  currentStep: 1,
  sections: [],      // [{ id, label, text }]
  frames: [],        // [{ dataUrl, label }]
  assignments: {},   // sectionId (string) → frameIndex (number)
  selectedFrameIdx: null,
  projectName: '',
};

/* ── Step navigation ─────────────────────────────────────────────────────── */
function goToStep(n) {
  document.querySelectorAll('.step').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.step-pill').forEach(p => {
    p.classList.remove('active', 'done');
    const pn = parseInt(p.dataset.step);
    if (pn === n) p.classList.add('active');
    else if (pn < n) p.classList.add('done');
  });
  document.getElementById(`step-${n}`).classList.add('active');
  state.currentStep = n;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ── Tab switching (step 1) ──────────────────────────────────────────────── */
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const panel = tab.dataset.tab;
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`tab-${panel}`).classList.add('active');
  });
});

/* ── Script file label ───────────────────────────────────────────────────── */
document.getElementById('script-file').addEventListener('change', e => {
  const f = e.target.files[0];
  document.getElementById('script-file-name').textContent = f ? f.name : '';
});

/* ── Step 1: Extract script ──────────────────────────────────────────────── */
document.getElementById('btn-extract').addEventListener('click', async () => {
  const btn = document.getElementById('btn-extract');
  const status = document.getElementById('extract-status');
  const activeTab = document.querySelector('.tab.active').dataset.tab;

  state.projectName = document.getElementById('project-name').value.trim() || 'Storyboard';

  const formData = new FormData();

  if (activeTab === 'paste') {
    const text = document.getElementById('script-text').value.trim();
    if (!text) return setStatus(status, 'Paste some script text first.', 'error');
    formData.append('text', text);
  } else if (activeTab === 'url') {
    const url = document.getElementById('script-url').value.trim();
    if (!url) return setStatus(status, 'Enter a URL.', 'error');
    formData.append('url', url);
  } else {
    const file = document.getElementById('script-file').files[0];
    if (!file) return setStatus(status, 'Choose a file.', 'error');
    formData.append('file', file);
  }

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Extracting…';
  setStatus(status, 'Parsing your script…');

  // Remove old sections list if any
  const prev = document.getElementById('sections-result');
  if (prev) prev.remove();

  try {
    const res = await fetch('/api/extract-script', { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Extraction failed');

    state.sections = data.sections;
    renderSections(status);
    setStatus(status, `✓ ${data.sections.length} sections extracted.`, 'success');
  } catch (err) {
    setStatus(status, err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Extract script sections →';
  }
});

function renderSections(statusEl) {
  const wrap = document.createElement('div');
  wrap.id = 'sections-result';

  const list = document.createElement('div');
  list.className = 'sections-list';
  state.sections.forEach(s => {
    const card = document.createElement('div');
    card.className = 'section-card';
    card.innerHTML = `<div class="section-card-label">${esc(s.label)}</div>
      <div class="section-card-text">${esc(s.text)}</div>`;
    list.appendChild(card);
  });

  const nextBtn = document.createElement('button');
  nextBtn.className = 'btn-primary';
  nextBtn.style.marginTop = '28px';
  nextBtn.textContent = 'Upload frames →';
  nextBtn.onclick = () => goToStep(2);

  wrap.appendChild(list);
  wrap.appendChild(nextBtn);
  statusEl.insertAdjacentElement('afterend', wrap);
}

/* ── Step 2: Upload frames ───────────────────────────────────────────────── */
const framesInput = document.getElementById('frames-file');
const framesStatus = document.getElementById('frames-status');

// Make drop zone label work for multiple files
document.getElementById('frames-drop').addEventListener('click', () => {
  framesInput.click();
});

framesInput.addEventListener('change', async () => {
  const files = Array.from(framesInput.files);
  if (!files.length) return;

  setStatus(framesStatus, `Processing ${files.length} file(s)…`);
  document.getElementById('frames-grid').innerHTML = '';
  state.frames = [];

  for (const file of files) {
    setStatus(framesStatus, `Uploading ${file.name}…`);
    await uploadFrameFile(file);
  }

  renderFramesGrid();
  if (state.frames.length) {
    document.getElementById('btn-to-assign').style.display = 'inline-flex';
    setStatus(framesStatus, `✓ ${state.frames.length} frame(s) ready.`, 'success');
  }
  framesInput.value = '';
});

async function uploadFrameFile(file) {
  const formData = new FormData();
  formData.append('file', file);
  try {
    const res = await fetch('/api/upload-frames', { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed');
    state.frames.push(...data.frames);
  } catch (err) {
    setStatus(framesStatus, `Error: ${err.message}`, 'error');
  }
}

function renderFramesGrid() {
  const grid = document.getElementById('frames-grid');
  grid.innerHTML = '';
  state.frames.forEach((f, i) => {
    const thumb = document.createElement('div');
    thumb.className = 'frame-thumb';
    thumb.innerHTML = `<img src="${f.dataUrl}" alt="${esc(f.label)}" loading="lazy" />
      <div class="frame-thumb-label">${esc(f.label)}</div>`;
    grid.appendChild(thumb);
  });
}

document.getElementById('btn-to-assign').addEventListener('click', () => {
  if (!state.frames.length) return;
  buildAssignUI();
  goToStep(3);
});

/* ── Step 3: Assign ──────────────────────────────────────────────────────── */
function buildAssignUI() {
  buildFramesCol();
  buildSectionsCol();
}

function buildFramesCol() {
  const col = document.getElementById('assign-frames');
  col.innerHTML = '';

  state.frames.forEach((f, i) => {
    const el = document.createElement('div');
    el.className = 'assign-frame';
    el.dataset.idx = i;

    const img = document.createElement('img');
    img.src = f.dataUrl;
    img.alt = f.label;
    img.loading = 'lazy';

    const lbl = document.createElement('div');
    lbl.className = 'assign-frame-label';
    lbl.textContent = f.label;

    el.appendChild(img);
    el.appendChild(lbl);

    // Check if already assigned
    const assignedSectionId = Object.keys(state.assignments).find(sid => state.assignments[sid] === i);
    if (assignedSectionId !== undefined) {
      el.classList.add('assigned');
      const badge = document.createElement('div');
      badge.className = 'assign-frame-assigned-to';
      const sec = state.sections.find(s => String(s.id) === String(assignedSectionId));
      badge.textContent = sec ? sec.label : '✓';
      el.appendChild(badge);
    }

    el.addEventListener('click', () => selectFrame(i));
    col.appendChild(el);
  });
}

function buildSectionsCol() {
  const col = document.getElementById('assign-sections');
  col.innerHTML = '';

  state.sections.forEach(s => {
    const el = document.createElement('div');
    el.className = 'assign-section';
    el.dataset.id = s.id;

    const labelEl = document.createElement('div');
    labelEl.className = 'assign-section-label';
    labelEl.textContent = s.label;

    const textEl = document.createElement('div');
    textEl.className = 'assign-section-text';
    textEl.textContent = s.text;

    el.appendChild(labelEl);
    el.appendChild(textEl);

    const assignedIdx = state.assignments[String(s.id)];
    if (assignedIdx !== undefined && state.frames[assignedIdx]) {
      el.classList.add('has-frame');
      const preview = document.createElement('img');
      preview.className = 'assign-section-frame-preview';
      preview.src = state.frames[assignedIdx].dataUrl;
      el.appendChild(preview);
    }

    el.addEventListener('click', () => assignFrameToSection(s.id));
    col.appendChild(el);
  });
}

function selectFrame(idx) {
  state.selectedFrameIdx = idx;
  document.querySelectorAll('.assign-frame').forEach(el => {
    el.classList.toggle('selected', parseInt(el.dataset.idx) === idx);
  });
  // Visual hint: highlight sections to invite click
  document.querySelectorAll('.assign-section').forEach(el => {
    el.style.outline = '2px dashed #7C3AED44';
  });
}

function assignFrameToSection(sectionId) {
  if (state.selectedFrameIdx === null) {
    // Pulse the frames to hint user should select one first
    document.querySelectorAll('.assign-frame').forEach(el => {
      el.style.borderColor = '#EF444455';
      setTimeout(() => el.style.borderColor = '', 400);
    });
    return;
  }

  state.assignments[String(sectionId)] = state.selectedFrameIdx;
  state.selectedFrameIdx = null;

  // Clear section outlines
  document.querySelectorAll('.assign-section').forEach(el => {
    el.style.outline = '';
  });

  buildAssignUI(); // re-render both cols
}

document.getElementById('btn-to-export').addEventListener('click', () => {
  buildPreview();
  goToStep(4);
});

/* ── Step 4: Preview & Export ────────────────────────────────────────────── */
function buildPreview() {
  const grid = document.getElementById('preview-grid');
  grid.innerHTML = '';

  const assigned = state.sections.filter(s => state.assignments[String(s.id)] !== undefined);
  if (!assigned.length) {
    grid.innerHTML = '<p style="color:#888;margin-top:20px">No assignments yet. Go back to step 3.</p>';
    return;
  }

  assigned.forEach(s => {
    const fi = state.assignments[String(s.id)];
    const frame = state.frames[fi];
    if (!frame) return;

    const card = document.createElement('div');
    card.className = 'preview-card';
    card.innerHTML = `
      <div class="preview-card-img">
        <img src="${frame.dataUrl}" alt="${esc(s.label)}" />
      </div>
      <div class="preview-card-text">
        <div class="preview-card-label">${esc(s.label)}</div>
        <div class="preview-card-body">${esc(s.text)}</div>
      </div>`;
    grid.appendChild(card);
  });
}

document.getElementById('btn-export').addEventListener('click', async () => {
  const btn = document.getElementById('btn-export');
  const status = document.getElementById('export-status');

  const assigned = state.sections
    .filter(s => state.assignments[String(s.id)] !== undefined)
    .map(s => ({
      sectionLabel: s.label,
      sectionText: s.text,
      frameDataUrl: state.frames[state.assignments[String(s.id)]]?.dataUrl,
    }))
    .filter(a => a.frameDataUrl);

  if (!assigned.length) return setStatus(status, 'Assign at least one frame before exporting.', 'error');

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Generating PDF…';
  setStatus(status, 'Building your PDF — this takes ~10 seconds…');

  try {
    const res = await fetch('/api/export-pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assignments: assigned, projectName: state.projectName }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Export failed' }));
      throw new Error(err.error || 'Export failed');
    }

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${state.projectName || 'storyboard'}.pdf`;
    a.click();
    URL.revokeObjectURL(url);
    setStatus(status, '✓ PDF downloaded.', 'success');
  } catch (err) {
    setStatus(status, err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Export PDF';
  }
});

/* ── Utils ───────────────────────────────────────────────────────────────── */
function setStatus(el, msg, type = '') {
  el.textContent = msg;
  el.className = 'status-msg' + (type ? ` ${type}` : '');
}

function esc(str) {
  return (str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
