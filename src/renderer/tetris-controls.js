'use strict';
// Tetris key bindings and movement handling, with a settings panel in the
// style of the old Facebook Tetris Battle controls screen. Saved per PC.

const Controls = (() => {
  const STORE = 'lanmsg.tetris.controls.v1';
  const ACTIONS = [
    ['left', 'Move left', '#4f8cff'],
    ['right', 'Move right', '#4f8cff'],
    ['soft', 'Soft drop', '#3fbf6a'],
    ['hard', 'Hard drop', '#ef4565'],
    ['cw', 'Rotate right', '#b552e0'],
    ['ccw', 'Rotate left', '#e05fae'],
    ['180', 'Rotate 180°', '#f5922f'],
    ['hold', 'Hold', '#f5cf3a'],
  ];
  // Classic = Facebook Tetris Battle; Modern = TETR.IO.
  const PRESETS = {
    classic: {
      keys: {
        left: ['ArrowLeft', ''], right: ['ArrowRight', ''], soft: ['ArrowDown', ''], hard: ['Space', ''],
        cw: ['ArrowUp', 'KeyX'], ccw: ['KeyZ', 'ControlLeft'], 180: ['', ''], hold: ['KeyC', 'ShiftLeft'],
      },
      handling: { das: 170, arr: 50, soft: 40, ghost: true },
    },
    modern: {
      keys: {
        left: ['ArrowLeft', ''], right: ['ArrowRight', ''], soft: ['ArrowDown', ''], hard: ['Space', ''],
        cw: ['ArrowUp', 'KeyX'], ccw: ['KeyZ', 'ControlLeft'], 180: ['KeyA', ''], hold: ['KeyC', 'ShiftLeft'],
      },
      handling: { das: 167, arr: 33, soft: 20, ghost: true },
    },
  };
  const LIMITS = { das: [50, 300], arr: [0, 100], soft: [5, 100] };

  const clone = (o) => JSON.parse(JSON.stringify(o));
  let state = clone(PRESETS.classic);
  let isOpen = false;

  try {
    const saved = JSON.parse(localStorage.getItem(STORE) || 'null');
    if (saved && saved.keys && saved.handling) {
      state = clone(PRESETS.classic);
      for (const [a] of ACTIONS) if (Array.isArray(saved.keys[a])) state.keys[a] = [saved.keys[a][0] || '', saved.keys[a][1] || ''];
      for (const k of ['das', 'arr', 'soft']) {
        const v = Number(saved.handling[k]);
        if (Number.isFinite(v)) state.handling[k] = Math.max(LIMITS[k][0], Math.min(LIMITS[k][1], v));
      }
      state.handling.ghost = saved.handling.ghost !== false;
    }
  } catch { /* storage unavailable: use defaults */ }

  function save() {
    try { localStorage.setItem(STORE, JSON.stringify(state)); } catch { /* not saved */ }
  }

  // Left and right modifier keys count as the same key.
  function normalize(code) {
    return String(code || '').replace(/Right$/, (m) => (/^(Control|Shift|Alt|Meta)/.test(code) ? 'Left' : m));
  }

  function keymap() {
    const map = {};
    for (const [a] of ACTIONS) for (const k of state.keys[a]) if (k) map[k] = a;
    return map;
  }

  function actionFor(code) {
    return keymap()[normalize(code)] || null;
  }

  const NAMES = {
    ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Space: 'Space', ControlLeft: 'Ctrl',
    ShiftLeft: 'Shift', AltLeft: 'Alt', MetaLeft: 'Win', Enter: 'Enter', Tab: 'Tab', Backquote: '`',
    Semicolon: ';', Comma: ',', Period: '.', Slash: '/', Quote: "'", BracketLeft: '[', BracketRight: ']',
  };
  function keyName(code) {
    if (!code) return '';
    if (NAMES[code]) return NAMES[code];
    if (/^Key[A-Z]$/.test(code)) return code.slice(3);
    if (/^Digit\d$/.test(code)) return code.slice(5);
    if (/^Numpad\d$/.test(code)) return `Num ${code.slice(6)}`;
    return code.replace(/Left$/, '');
  }

  // A small keyboard picture with the bound keys coloured in.
  const KEYBOARD = [
    [['KeyQ'], ['KeyW'], ['KeyE'], ['KeyR'], ['KeyT'], ['KeyY'], ['KeyU'], ['KeyI'], ['KeyO'], ['KeyP']],
    [['KeyA'], ['KeyS'], ['KeyD'], ['KeyF'], ['KeyG'], ['KeyH'], ['KeyJ'], ['KeyK'], ['KeyL']],
    [['ShiftLeft', 2], ['KeyZ'], ['KeyX'], ['KeyC'], ['KeyV'], ['KeyB'], ['KeyN'], ['KeyM']],
    [['ControlLeft', 1.5], ['AltLeft', 1.5], ['Space', 6]],
  ];

  function keyboardHtml(t) {
    const map = keymap();
    const color = Object.fromEntries(ACTIONS.map(([a, , c]) => [a, c]));
    const label = Object.fromEntries(ACTIONS.map(([a, l]) => [a, t(l)]));
    const key = ([code, w = 1]) => {
      const a = map[code];
      return `<div class="kb-key${a ? ' on' : ''}" style="flex:${w};${a ? `--c:${color[a]}` : ''}" title="${a ? label[a] : ''}"><b>${keyName(code)}</b>${a ? `<i>${label[a]}</i>` : ''}</div>`;
    };
    const rows = KEYBOARD.map((r, i) => `<div class="kb-row r${i}">${r.map(key).join('')}</div>`).join('');
    const arrows = `<div class="kb-arrows"><div class="kb-row">${key(['ArrowUp'])}</div><div class="kb-row">${key(['ArrowLeft'])}${key(['ArrowDown'])}${key(['ArrowRight'])}</div></div>`;
    return `<div class="kb"><div class="kb-main">${rows}</div>${arrows}</div>`;
  }

  function hintHtml(t) {
    return ACTIONS
      .filter(([a]) => state.keys[a].some(Boolean))
      .map(([a, l]) => `${state.keys[a].filter(Boolean).map((k) => `<kbd>${keyName(k)}</kbd>`).join('/')} ${t(l)}`)
      .join(' &nbsp; ');
  }

  // ------------------------------------------------------------------ settings panel
  function open(t, onClose) {
    if (isOpen) return;
    isOpen = true;
    let waiting = null; // [action, slot] waiting for a key
    const back = document.createElement('div');
    back.className = 'ctl-back';
    document.body.append(back);

    const slider = (k, label, unit, note) => `<label class="ctl-slider">
      <span class="ctl-sl-label">${t(label)} <small>${t(note)}</small></span>
      <input type="range" min="${LIMITS[k][0]}" max="${LIMITS[k][1]}" step="1" value="${state.handling[k]}" data-h="${k}">
      <b data-v="${k}">${state.handling[k]} ${unit}</b></label>`;

    function draw() {
      back.innerHTML = `<div class="ctl-panel">
        <div class="ctl-head"><h2>${t('Controls')}</h2><button class="ctl-x" data-close>✕</button></div>
        <div class="ctl-presets">
          <button data-preset="classic">${t('Classic (Facebook Tetris Battle)')}</button>
          <button data-preset="modern">${t('Modern (TETR.IO)')}</button>
        </div>
        ${keyboardHtml(t)}
        <div class="ctl-keys">${ACTIONS.map(([a, l, c]) => `<div class="ctl-row">
          <span class="ctl-dot" style="background:${c}"></span><span class="ctl-name">${t(l)}</span>
          ${[0, 1].map((slot) => {
            const on = waiting && waiting[0] === a && waiting[1] === slot;
            return `<button class="keycap${on ? ' wait' : ''}${state.keys[a][slot] ? '' : ' empty'}" data-bind="${a}" data-slot="${slot}">${on ? t('Press a key…') : keyName(state.keys[a][slot]) || '—'}</button>`;
          }).join('')}
        </div>`).join('')}</div>
        <p class="ctl-tip">${t('Click a key box, then press the key you want. Delete clears it, Esc cancels.')}</p>
        <h3>${t('Movement')}</h3>
        ${slider('das', 'Delay before sliding', 'ms', '(DAS – how long you hold before the piece starts sliding)')}
        ${slider('arr', 'Sliding speed', 'ms', '(ARR – time between steps, 0 = instant)')}
        ${slider('soft', 'Soft drop speed', 'ms', '(time per row while holding soft drop)')}
        <label class="ctl-check"><input type="checkbox" data-ghost ${state.handling.ghost ? 'checked' : ''}> ${t('Show ghost piece (where the piece will land)')}</label>
        <div class="ctl-foot"><button class="ctl-done" data-close>${t('Done')}</button></div>
      </div>`;
    }

    function close() {
      isOpen = false;
      document.removeEventListener('keydown', onKey, true);
      back.remove();
      save();
      if (onClose) onClose();
    }

    function onKey(e) {
      e.preventDefault();
      e.stopPropagation();
      if (!waiting) {
        if (e.key === 'Escape') close();
        return;
      }
      const [a, slot] = waiting;
      waiting = null;
      if (e.key === 'Escape') return draw();
      const code = e.key === 'Delete' || e.key === 'Backspace' ? '' : normalize(e.code);
      if (code) {
        // A key can only do one thing: take it away from any other action.
        for (const [other] of ACTIONS) state.keys[other] = state.keys[other].map((k) => (k === code ? '' : k));
      }
      state.keys[a][slot] = code;
      save();
      draw();
      return undefined;
    }

    back.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.close !== undefined) return close();
      if (b.dataset.preset) {
        state = clone(PRESETS[b.dataset.preset]);
        save();
        return draw();
      }
      if (b.dataset.bind) {
        waiting = [b.dataset.bind, Number(b.dataset.slot)];
        draw();
      }
      return undefined;
    });
    back.addEventListener('input', (e) => {
      const k = e.target.dataset.h;
      if (k) {
        state.handling[k] = Number(e.target.value);
        back.querySelector(`[data-v="${k}"]`).textContent = `${state.handling[k]} ms`;
        save();
      }
      if (e.target.dataset.ghost !== undefined) {
        state.handling.ghost = e.target.checked;
        save();
      }
    });
    document.addEventListener('keydown', onKey, true);
    draw();
  }

  return {
    ACTIONS,
    actionFor,
    keyName,
    hintHtml,
    open,
    get handling() { return state.handling; },
    get keys() { return state.keys; },
    isOpen: () => isOpen,
  };
})();
