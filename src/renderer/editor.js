'use strict';
/* global el, esc, t, toast */
// Picture editor: crop, then draw arrows, boxes, pen strokes, highlights and
// text on a screenshot or picture before sending it.

function openEditor(src, { title, crop = false, onSend }) {
  const COLORS = ['#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#ffffff', '#111827'];
  const TOOLS = [
    ['crop', t('Crop'), '<path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/>'],
    ['arrow', t('Arrow'), '<path d="M5 19 19 5M10 5h9v9"/>'],
    ['rect', t('Box'), '<rect x="4" y="5" width="16" height="14" rx="1.5"/>'],
    ['pen', t('Pen'), '<path d="M4 20c4-1 6-3 8-6s4-6 8-10"/>'],
    ['hl', t('Highlighter'), '<path d="m9 11-5 5v4h4l5-5M14 6l4 4M9 11l4-4 4 4-4 4z"/>'],
    ['text', t('Text'), '<path d="M5 6V4h14v2M12 4v16M9 20h6"/>'],
  ];
  let tool = crop ? 'crop' : 'arrow';
  let color = COLORS[0];
  const ops = [];
  let current = null;
  let cropRect = null;

  const back = el('div', 'editor-back');
  back.innerHTML = `
    <div class="editor-top">
      <div class="ed-title">${esc(title)}</div>
      <div class="ed-tools">
        ${TOOLS.map(([k, label, d]) => `<button class="ed-tool" data-tool="${k}" title="${esc(label)}"><svg class="ico" viewBox="0 0 24 24">${d}</svg><span>${esc(label)}</span></button>`).join('')}
        <span class="ed-sep"></span>
        ${COLORS.map((c) => `<button class="ed-color" data-color="${c}" style="background:${c}"></button>`).join('')}
        <span class="ed-sep"></span>
        <button class="ed-tool" data-undo title="${esc(t('Undo'))} (Ctrl+Z)"><svg class="ico" viewBox="0 0 24 24"><path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/></svg><span>${esc(t('Undo'))}</span></button>
      </div>
      <div class="ed-actions">
        <button class="btn" data-cancel>${esc(t('Cancel'))}</button>
        <button class="btn primary" data-send>${esc(t('Send'))}</button>
      </div>
    </div>
    <div class="editor-stage"><canvas></canvas><input class="ed-text hidden" maxlength="200"></div>
    <div class="editor-hint"></div>`;
  document.body.append(back);

  const canvas = back.querySelector('canvas');
  const ctx = canvas.getContext('2d');
  const stage = back.querySelector('.editor-stage');
  const textInput = back.querySelector('.ed-text');
  const hint = back.querySelector('.editor-hint');
  const img = new Image();
  let base = 4;

  const hints = {
    crop: t('Drag to select the part of the picture to keep'),
    arrow: t('Drag to draw an arrow'),
    rect: t('Drag to draw a box'),
    pen: t('Draw freely with the mouse'),
    hl: t('Drag over text to highlight it'),
    text: t('Click where the text should go, type, then press Enter'),
  };

  function syncToolbar() {
    back.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === tool));
    back.querySelectorAll('[data-color]').forEach((b) => b.classList.toggle('on', b.dataset.color === color));
    hint.textContent = hints[tool];
    canvas.style.cursor = tool === 'text' ? 'text' : 'crosshair';
  }

  function fit() {
    const r = stage.getBoundingClientRect();
    const scale = Math.min((r.width - 32) / canvas.width, (r.height - 32) / canvas.height, 1);
    canvas.style.width = `${canvas.width * scale}px`;
    canvas.style.height = `${canvas.height * scale}px`;
  }

  function pos(e) {
    const r = canvas.getBoundingClientRect();
    return [(e.clientX - r.left) * (canvas.width / r.width), (e.clientY - r.top) * (canvas.height / r.height)];
  }

  function drawArrow(g, op) {
    const { x0, y0, x1, y1, w } = op;
    const ang = Math.atan2(y1 - y0, x1 - x0);
    const head = w * 4.5;
    g.beginPath();
    g.moveTo(x0, y0);
    g.lineTo(x1 - Math.cos(ang) * head * 0.6, y1 - Math.sin(ang) * head * 0.6);
    g.stroke();
    g.beginPath();
    g.moveTo(x1, y1);
    g.lineTo(x1 - head * Math.cos(ang - 0.45), y1 - head * Math.sin(ang - 0.45));
    g.lineTo(x1 - head * Math.cos(ang + 0.45), y1 - head * Math.sin(ang + 0.45));
    g.closePath();
    g.fill();
  }

  function drawOp(g, op) {
    g.save();
    g.strokeStyle = op.color;
    g.fillStyle = op.color;
    g.lineWidth = op.w;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    if (op.type === 'pen' || op.type === 'hl') {
      if (op.type === 'hl') {
        g.globalAlpha = 0.35;
        g.lineCap = 'square';
      }
      g.beginPath();
      op.points.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
      g.stroke();
    } else if (op.type === 'arrow') {
      drawArrow(g, op);
    } else if (op.type === 'rect') {
      g.strokeRect(Math.min(op.x0, op.x1), Math.min(op.y0, op.y1), Math.abs(op.x1 - op.x0), Math.abs(op.y1 - op.y0));
    } else if (op.type === 'text') {
      g.font = `700 ${op.size}px "Segoe UI", system-ui, sans-serif`;
      g.textBaseline = 'top';
      g.lineWidth = Math.max(2, op.size / 7);
      g.strokeStyle = op.color === '#111827' ? '#ffffff' : '#111827';
      g.strokeText(op.text, op.x, op.y);
      g.fillText(op.text, op.x, op.y);
    }
    g.restore();
  }

  function render(g, withOverlay) {
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.drawImage(img, 0, 0);
    for (const op of ops) drawOp(g, op);
    if (current && current.type !== 'crop') drawOp(g, current);
    const c = current && current.type === 'crop' ? norm(current) : cropRect;
    if (withOverlay && c) {
      g.save();
      g.fillStyle = 'rgba(0,0,0,.55)';
      g.fillRect(0, 0, canvas.width, c.y);
      g.fillRect(0, c.y + c.h, canvas.width, canvas.height - c.y - c.h);
      g.fillRect(0, c.y, c.x, c.h);
      g.fillRect(c.x + c.w, c.y, canvas.width - c.x - c.w, c.h);
      g.strokeStyle = '#fff';
      g.setLineDash([base * 2, base * 2]);
      g.lineWidth = Math.max(1, base / 2);
      g.strokeRect(c.x, c.y, c.w, c.h);
      g.restore();
    }
  }

  function norm(r) {
    return { x: Math.min(r.x0, r.x1), y: Math.min(r.y0, r.y1), w: Math.abs(r.x1 - r.x0), h: Math.abs(r.y1 - r.y0) };
  }

  const redraw = () => render(ctx, true);

  function close() {
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', fit);
    back.remove();
  }

  function commitText() {
    const v = textInput.value.trim();
    if (v && textInput.dataset.x) {
      ops.push({ type: 'text', text: v, x: Number(textInput.dataset.x), y: Number(textInput.dataset.y), color, size: base * 7 });
    }
    textInput.value = '';
    textInput.classList.add('hidden');
    delete textInput.dataset.x;
    redraw();
  }

  async function send() {
    commitText();
    const c = cropRect && cropRect.w > 4 && cropRect.h > 4 ? cropRect : { x: 0, y: 0, w: canvas.width, h: canvas.height };
    const full = document.createElement('canvas');
    full.width = canvas.width;
    full.height = canvas.height;
    render(full.getContext('2d'), false);
    const out = document.createElement('canvas');
    out.width = Math.round(c.w);
    out.height = Math.round(c.h);
    out.getContext('2d').drawImage(full, c.x, c.y, c.w, c.h, 0, 0, c.w, c.h);
    const blob = await new Promise((r) => out.toBlob(r, 'image/png'));
    if (!blob) return toast(t('Could not create the picture'), 'error');
    close();
    onSend(new Uint8Array(await blob.arrayBuffer()));
  }

  function onKey(e) {
    if (!textInput.classList.contains('hidden')) {
      if (e.key === 'Enter') { e.preventDefault(); commitText(); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); textInput.classList.add('hidden'); textInput.value = ''; }
      return;
    }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); send(); }
  }

  function undo() {
    if (ops.length) ops.pop();
    else cropRect = null;
    redraw();
  }

  canvas.addEventListener('pointerdown', (e) => {
    const [x, y] = pos(e);
    if (tool === 'text') {
      commitText();
      const r = canvas.getBoundingClientRect();
      const sr = stage.getBoundingClientRect();
      textInput.style.left = `${e.clientX - sr.left}px`;
      textInput.style.top = `${e.clientY - sr.top}px`;
      textInput.style.color = color;
      textInput.style.fontSize = `${Math.max(14, base * 7 * (r.width / canvas.width))}px`;
      textInput.dataset.x = x;
      textInput.dataset.y = y;
      textInput.classList.remove('hidden');
      setTimeout(() => textInput.focus(), 0);
      return;
    }
    canvas.setPointerCapture(e.pointerId);
    if (tool === 'pen' || tool === 'hl') {
      current = { type: tool, color: tool === 'hl' && color === COLORS[0] ? '#facc15' : color, w: tool === 'hl' ? base * 5 : base, points: [[x, y]] };
    } else {
      current = { type: tool, color, w: base, x0: x, y0: y, x1: x, y1: y };
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!current) return;
    const [x, y] = pos(e);
    if (current.points) current.points.push([x, y]);
    else { current.x1 = x; current.y1 = y; }
    redraw();
  });
  canvas.addEventListener('pointerup', () => {
    if (!current) return;
    if (current.type === 'crop') {
      const r = norm(current);
      cropRect = r.w > 10 && r.h > 10 ? r : null;
      if (cropRect) tool = 'arrow';
      syncToolbar();
    } else if (current.points ? current.points.length > 1 : Math.hypot(current.x1 - current.x0, current.y1 - current.y0) > 4) {
      ops.push(current);
    }
    current = null;
    redraw();
  });

  back.querySelector('.ed-tools').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.tool) tool = b.dataset.tool;
    if (b.dataset.color) color = b.dataset.color;
    if (b.dataset.undo !== undefined) undo();
    commitText();
    syncToolbar();
  });
  back.querySelector('[data-cancel]').addEventListener('click', close);
  back.querySelector('[data-send]').addEventListener('click', send);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', fit);

  img.onload = () => {
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    base = Math.max(3, Math.round(Math.max(canvas.width, canvas.height) / 360));
    fit();
    syncToolbar();
    redraw();
  };
  img.onerror = () => {
    close();
    toast(t('This picture could not be opened'), 'error');
  };
  img.src = src;
}
