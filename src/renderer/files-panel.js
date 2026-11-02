/* global isAtBottom, S, api, t, esc, fmtSize, fmtWhen, extLabel, IMAGE_RE, convName, peerName, lightbox, jumpTo, openConv, call, el, toast */
// Slide-in panel on the right with two views:
//  - Files: everything shared in the open chat (photos as a grid, other files as a list).
//  - Downloads: every file received from anyone, like a browser's download list,
//    with "Open", "Show in folder" and a button that opens the downloads folder.
const FilesPanel = (() => {
  let mode = null; // 'files' | 'downloads' | null
  let conv = null;
  let items = [];
  let tab = 'all'; // files view: all | photos | docs
  let query = '';
  let reloadTimer = null;
  const panel = () => document.getElementById('sidePanel');

  // The chat narrows or widens when the panel opens or closes; stay at the newest message.
  function keepBottom(fn) {
    const box = document.getElementById('messages');
    const stick = box && isAtBottom(box);
    fn();
    if (stick) requestAnimationFrame(() => { box.scrollTop = box.scrollHeight; });
  }

  function open(m, c) {
    keepBottom(() => openNow(m, c));
  }

  function openNow(m, c) {
    mode = m;
    conv = c || null;
    tab = 'all';
    query = '';
    const p = panel();
    p.classList.remove('hidden');
    document.body.classList.add('panel-open');
    p.innerHTML = '';
    reload();
  }

  function close() {
    if (!mode) return;
    keepBottom(closeNow);
  }

  function closeNow() {
    mode = null;
    const p = panel();
    p.classList.add('hidden');
    p.innerHTML = '';
    document.body.classList.remove('panel-open');
  }

  function toggle(m, c) {
    if (mode === m && (m === 'downloads' || conv === c)) close();
    else open(m, c);
  }

  async function reload() {
    const m = mode;
    const c = conv;
    const list = m === 'files' ? await api.chatFiles(c) : await api.downloads();
    if (m !== mode || c !== conv) return;
    items = list;
    render();
  }

  // Reload a moment after a related change (many file events can come at once).
  function soon() {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(reload, 250);
  }

  function onEvent(type, payload) {
    if (!mode) return;
    if (type === 'message') {
      const { conv: c, msg } = payload;
      if (!msg || msg.kind !== 'file') return;
      if (mode === 'files' && c !== conv) return;
      soon();
    } else if (type === 'file-progress') {
      const row = panel().querySelector(`[data-id="${CSS.escape(payload.msgId)}"]`);
      if (row) updateProgress(row, payload);
    }
  }

  function updateProgress(row, p) {
    const bar = row.querySelector('.dl-bar i');
    const sub = row.querySelector('.dl-state');
    if (bar && p.size) bar.style.width = `${(p.done / p.size) * 100}%`;
    if (sub && p.size && !p.upload) sub.textContent = `${fmtSize(p.done)} / ${fmtSize(p.size)}${p.speed ? ` · ${fmtSize(p.speed)}/s` : ''}`;
  }

  // ------------------------------------------------------------------ render
  function dayLabel(ts) {
    const d = new Date(ts);
    const today = new Date();
    const y = new Date(Date.now() - 86400000);
    const same = (a, b) => a.toDateString() === b.toDateString();
    if (same(d, today)) return t('Today');
    if (same(d, y)) return t('Yesterday');
    return d.toLocaleDateString(undefined, { dateStyle: 'long' });
  }

  function stateHtml(x) {
    const f = x.file;
    const mine = x.from === S.me.id;
    const prog = S.progress.get(x.id);
    if (f.state === 'downloading') {
      const p = prog || { done: 0, size: f.size };
      return `<div class="dl-bar"><i style="width:${(p.done / Math.max(1, f.size)) * 100}%"></i></div><div class="dl-state">${esc(`${fmtSize(p.done)} / ${fmtSize(f.size)}`)}</div>`;
    }
    if (f.state === 'failed') return `<div class="dl-state bad">${esc(f.error || t('Download failed'))}</div>`;
    if (f.state === 'cancelled' && !mine) return `<div class="dl-state bad">${esc(t('The sender stopped sending this'))}</div>`;
    if ((f.state === 'done' || mine) && f.path && !x.exists) return `<div class="dl-state bad">${esc(t('Deleted or moved'))}</div>`;
    if (!mine && f.state === 'offered') return `<div class="dl-state">${esc(t('Not downloaded'))}</div>`;
    return '';
  }

  function buttons(x) {
    const f = x.file;
    const mine = x.from === S.me.id;
    const b = [];
    if (f.state === 'downloading') b.push(['cancel', t('Cancel')]);
    else if (!mine && (f.state === 'offered' || f.state === 'failed')) b.push(['download', f.state === 'failed' ? t('Retry') : t('Download')]);
    if (f.path && x.exists) {
      b.push(['open', f.folder ? t('Open folder') : t('Open')]);
      b.push(['folder', t('Show in folder')]);
    }
    b.push(['jump', t('Go to message')]);
    return b.map(([a, l]) => `<button class="fbtn ghost" data-a="${a}">${esc(l)}</button>`).join('');
  }

  function row(x) {
    const f = x.file;
    const icon = f.folder ? '📁' : esc(extLabel(f.name));
    const who = mode === 'downloads' ? `${esc(x.fromName || peerName(x.from))}${x.conv.startsWith('g:') || x.conv === 'broadcast' ? ` · ${esc(convName(x.conv))}` : ''}` : esc(x.from === S.me.id ? t('You') : x.fromName || peerName(x.from));
    const when = new Date(mode === 'downloads' ? x.at : x.ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    const size = f.folder ? t(f.count === 1 ? '{n} file · {size}' : '{n} files · {size}', { n: f.count, size: fmtSize(f.size) }) : fmtSize(f.size);
    const dead = f.path && !x.exists && (f.state === 'done' || x.from === S.me.id);
    return `<div class="dl-row${dead ? ' dead' : ''}" data-id="${esc(x.id)}" data-conv="${esc(x.conv)}">
      <div class="dl-icon">${icon}</div>
      <div class="dl-info">
        <button class="dl-name" data-a="${f.path && x.exists ? 'open' : 'jump'}" title="${esc(f.name)}">${esc(f.name)}</button>
        <div class="dl-sub">${who} · ${esc(size)} · ${esc(when)}</div>
        ${stateHtml(x)}
        <div class="dl-btns">${buttons(x)}</div>
      </div>
    </div>`;
  }

  function filtered() {
    const q = query.trim().toLowerCase();
    return items.filter((x) => {
      if (q && !x.file.name.toLowerCase().includes(q) && !String(x.fromName || '').toLowerCase().includes(q)) return false;
      if (mode !== 'files' || tab === 'all') return true;
      const img = !x.file.folder && IMAGE_RE.test(x.file.name);
      return tab === 'photos' ? img : !img;
    });
  }

  function render() {
    const p = panel();
    if (!mode) return;
    const files = mode === 'files';
    const head = files
      ? `<div class="sp-title"><b>${esc(t('Files'))}</b><span>${esc(convName(conv))}</span></div>`
      : `<div class="sp-title"><b>${esc(t('Downloads'))}</b><span>${esc(t('Files you received'))}</span></div>`;
    if (!p.querySelector('.sp-head')) {
      p.innerHTML = `<div class="sp-head">${head}<button class="icon-btn" data-a="close" title="${esc(t('Close'))}">✕</button></div>
        ${files ? `<div class="sp-tabs">${[['all', t('All')], ['photos', t('Photos')], ['docs', t('Files')]].map(([k, l]) => `<button data-tab="${k}">${esc(l)}</button>`).join('')}</div>` : `<div class="sp-tools"><button class="fbtn" data-a="dir">📂 ${esc(t('Open downloads folder'))}</button><button class="fbtn ghost" data-a="clear">${esc(t('Clear list'))}</button></div>`}
        <input class="sp-search" type="search" placeholder="${esc(t('Search files'))}">
        <div class="sp-body"></div>`;
      const input = p.querySelector('.sp-search');
      input.addEventListener('input', () => { query = input.value; renderBody(); });
    } else p.querySelector('.sp-title').outerHTML = head;
    for (const b of p.querySelectorAll('[data-tab]')) b.classList.toggle('on', b.dataset.tab === tab);
    renderBody();
  }

  function renderBody() {
    const body = panel().querySelector('.sp-body');
    if (!body) return;
    const list = filtered();
    if (!list.length) {
      body.innerHTML = `<div class="sp-empty">${esc(mode === 'files' ? (items.length ? t('No files match') : t('No files in this chat yet')) : (items.length ? t('No files match') : t('No downloads yet')))}</div>`;
      return;
    }
    if (mode === 'files' && tab === 'photos') {
      body.innerHTML = `<div class="sp-grid">${list.map((x) => `<button class="sp-photo" data-id="${esc(x.id)}" data-conv="${esc(x.conv)}" data-a="${x.file.path && x.exists ? 'view' : 'jump'}" title="${esc(x.file.name)}"><span>${esc(x.file.path && x.exists ? x.file.name : t('Not downloaded'))}</span></button>`).join('')}</div>`;
      for (const b of body.querySelectorAll('.sp-photo')) {
        const x = list.find((i) => i.id === b.dataset.id);
        if (x && x.file.path && x.exists) thumbInto(b, x.file.path);
      }
      return;
    }
    // Grouped by day, newest first.
    let html = '';
    let last = '';
    for (const x of list) {
      const day = dayLabel(mode === 'downloads' ? x.at : x.ts);
      if (day !== last) { html += `<div class="sp-day">${esc(day)}</div>`; last = day; }
      html += row(x);
    }
    body.innerHTML = html;
  }

  async function thumbInto(b, p) {
    let info = S.thumbs.get(p);
    if (!info) {
      info = await api.thumb(p);
      if (!info) return;
      S.thumbs.set(p, info);
    }
    b.style.backgroundImage = `url("${info.url}")`;
    b.firstChild.textContent = '';
    b.dataset.path = p;
  }

  async function act(a, x, btn) {
    const f = x && x.file;
    if (a === 'open') {
      try { await api.openFile(f.path); } catch (err) { toast(err.message, 'error'); }
    } else if (a === 'folder') api.showInFolder(f.path);
    else if (a === 'download') { await call(api.acceptFile(x.conv, x.id)); soon(); }
    else if (a === 'cancel') { await call(api.cancelFile(x.conv, x.id)); soon(); }
    else if (a === 'view') lightbox(btn.dataset.path || f.path);
    else if (a === 'jump') {
      if (S.active !== x.conv) await openConv(x.conv);
      jumpTo(x.conv, x.id);
    }
  }

  function bind() {
    const p = panel();
    p.addEventListener('click', async (e) => {
      const tb = e.target.closest('[data-tab]');
      if (tb) { tab = tb.dataset.tab; render(); return; }
      const b = e.target.closest('[data-a]');
      if (!b) return;
      const a = b.dataset.a;
      if (a === 'close') return close();
      if (a === 'dir') { try { await api.openDownloadDir(); } catch (err) { toast(err.message, 'error'); } return; }
      if (a === 'clear') {
        await call(api.setSettings({ downloadsClearedAt: Date.now() }));
        reload();
        return;
      }
      const host = b.closest('[data-id]');
      const x = host && items.find((i) => i.id === host.dataset.id && i.conv === host.dataset.conv);
      if (x) act(a, x, b);
    });
  }

  document.addEventListener('DOMContentLoaded', bind);
  if (document.readyState !== 'loading') bind();
  return { open, close, toggle, onEvent, reload, get mode() { return mode; }, get conv() { return conv; } };
})();
