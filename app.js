/* ============================================================
   Mo's Management — offline client formula tracker
   Vanilla JS, no dependencies. Memory-first, IndexedDB-backed.
   ============================================================ */
(function () {
'use strict';

var APP_VERSION = '1.0';
var DB_NAME = 'mos-management';
var DB_VERSION = 1;
var STORE_CLIENTS = 'clients';
var STORE_FOLDERS = 'folders';

/* ------------------------------------------------------------
   Tiny helpers
   ------------------------------------------------------------ */
function $(id) { return document.getElementById(id); }

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function uid() {
  try {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    if (window.crypto && crypto.getRandomValues) {
      var a = new Uint8Array(16); crypto.getRandomValues(a);
      return Array.prototype.map.call(a, function (b) {
        return ('0' + b.toString(16)).slice(-2);
      }).join('');
    }
  } catch (e) { /* fall through */ }
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

var toastTimer = null;
function toast(msg) {
  var el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { el.hidden = true; }, 2200);
}

function trim(v) { return (v == null ? '' : String(v)).trim(); }

/* ------------------------------------------------------------
   IndexedDB wrapper — every call resolves, never throws.
   A failed write degrades to memory-only; the app keeps running.
   ------------------------------------------------------------ */
var DB = (function () {
  var dbp = null;
  var broken = false;
  var warned = false;

  function warnOnce() {
    if (warned) return;
    warned = true;
    toast('Saving to this device is unavailable — changes may not persist.');
  }

  function open() {
    if (broken) return Promise.resolve(null);
    if (dbp) return dbp;
    dbp = new Promise(function (resolve) {
      var req;
      try {
        req = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (e) { broken = true; warnOnce(); return resolve(null); }

      req.onupgradeneeded = function (ev) {
        try {
          var db = ev.target.result;
          if (!db.objectStoreNames.contains(STORE_CLIENTS)) db.createObjectStore(STORE_CLIENTS, { keyPath: 'id' });
          if (!db.objectStoreNames.contains(STORE_FOLDERS)) db.createObjectStore(STORE_FOLDERS, { keyPath: 'id' });
        } catch (e) { /* handled by onerror */ }
      };
      req.onsuccess = function () {
        var db = req.result;
        db.onversionchange = function () { try { db.close(); } catch (e) {} dbp = null; };
        resolve(db);
      };
      req.onerror = function () { broken = true; warnOnce(); resolve(null); };
      req.onblocked = function () { resolve(null); };
    });
    return dbp;
  }

  function tx(store, mode, fn) {
    return open().then(function (db) {
      if (!db) return null;
      return new Promise(function (resolve) {
        var t, s, out = null;
        try {
          t = db.transaction(store, mode);
          s = t.objectStore(store);
        } catch (e) { warnOnce(); return resolve(null); }
        try { out = fn(s); } catch (e) { warnOnce(); }
        t.oncomplete = function () { resolve(out && out.result !== undefined ? out.result : out); };
        t.onerror = function () { warnOnce(); resolve(null); };
        t.onabort = function () { warnOnce(); resolve(null); };
      });
    }).catch(function () { warnOnce(); return null; });
  }

  return {
    getAll: function (store) {
      return tx(store, 'readonly', function (s) { return s.getAll(); })
        .then(function (r) { return Array.isArray(r) ? r : []; })
        .catch(function () { return []; });
    },
    put: function (store, obj) {
      return tx(store, 'readwrite', function (s) { s.put(obj); });
    },
    del: function (store, key) {
      return tx(store, 'readwrite', function (s) { s.delete(key); });
    },
    replaceAll: function (store, list) {
      return tx(store, 'readwrite', function (s) {
        s.clear();
        for (var i = 0; i < list.length; i++) s.put(list[i]);
      });
    }
  };
})();

/* ------------------------------------------------------------
   State
   ------------------------------------------------------------ */
var state = {
  clients: [],          // kept sorted by nameKey
  folders: [],          // kept sorted by nameKey
  folderById: Object.create(null),
  filter: 'all',        // 'all' | folder id
  query: '',
  editingClientId: null,
  editingFolderId: null,
  viewingClientId: null
};

var FORMULA_FIELDS = [
  ['roots', 'Roots'],
  ['gloss', 'Gloss / Toner'],
  ['developer', 'Developer'],
  ['time', 'Processing Time'],
  ['other', 'Other']
];

/* Fold to a plain lowercase key so "Émile" sorts, groups under E, and is
   found by typing "emile". Computed once per client, never per keystroke. */
function nameKey(n) {
  var s = trim(n).toLowerCase();
  try { s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch (e) { /* older engines */ }
  return s;
}

function sortByName(list) {
  list.sort(function (a, b) {
    if (a._k < b._k) return -1;
    if (a._k > b._k) return 1;
    return 0;
  });
  return list;
}

function decorate(c) {
  c._k = nameKey(c.name);
  return c;
}

function reindexFolders() {
  state.folderById = Object.create(null);
  for (var i = 0; i < state.folders.length; i++) {
    state.folderById[state.folders[i].id] = state.folders[i];
  }
}

function clientById(id) {
  for (var i = 0; i < state.clients.length; i++) if (state.clients[i].id === id) return state.clients[i];
  return null;
}

/* ------------------------------------------------------------
   Navigation
   ------------------------------------------------------------ */
var stack = ['screen-list'];

function showScreen(id) {
  var screens = document.querySelectorAll('.screen');
  for (var i = 0; i < screens.length; i++) screens[i].classList.toggle('is-active', screens[i].id === id);
  var active = $(id);
  var sc = active && active.querySelector('.scroller');
  if (sc && id !== 'screen-list') sc.scrollTop = 0;
}

function go(id) {
  closeOpenRow();
  stack.push(id);
  showScreen(id);
  try { history.pushState({ depth: stack.length }, ''); } catch (e) {}
}

function back() {
  if (stack.length <= 1) return;
  try { history.back(); } catch (e) { popTo(); }
}

function popTo() {
  if (stack.length <= 1) return;
  stack.pop();
  showScreen(stack[stack.length - 1]);
}

window.addEventListener('popstate', function () {
  closeOpenRow();
  if (stack.length > 1) popTo();
});

/* ------------------------------------------------------------
   Confirm dialog (promise based)
   ------------------------------------------------------------ */
var confirmResolver = null;
function confirmDialog(title, msg, okLabel) {
  $('confirm-title').textContent = title;
  $('confirm-msg').textContent = msg || '';
  $('confirm-yes').textContent = okLabel || 'Delete';
  $('confirm-backdrop').hidden = false;
  return new Promise(function (resolve) { confirmResolver = resolve; });
}
function closeConfirm(val) {
  $('confirm-backdrop').hidden = true;
  var r = confirmResolver; confirmResolver = null;
  if (r) r(val);
}
$('confirm-yes').addEventListener('click', function () { closeConfirm(true); });
$('confirm-no').addEventListener('click', function () { closeConfirm(false); });
$('confirm-backdrop').addEventListener('click', function (e) {
  if (e.target === $('confirm-backdrop')) closeConfirm(false);
});

/* ------------------------------------------------------------
   Action sheet
   ------------------------------------------------------------ */
function openSheet() { $('sheet-backdrop').hidden = false; }
function closeSheet() { $('sheet-backdrop').hidden = true; }
$('sheet-backdrop').addEventListener('click', function (e) {
  if (e.target === $('sheet-backdrop')) closeSheet();
});
$('sheet-cancel').addEventListener('click', closeSheet);
$('btn-plus').addEventListener('click', openSheet);
$('sheet-new-client').addEventListener('click', function () { closeSheet(); openClientEditor(null); });
$('sheet-new-folder').addEventListener('click', function () { closeSheet(); openFolderEditor(null); });

/* ------------------------------------------------------------
   List rendering
   ------------------------------------------------------------ */
function summaryOf(c) {
  var bits = [];
  var f = state.folderById[c.folderId];
  if (state.filter === 'all' && f) bits.push(f.name);
  for (var i = 0; i < FORMULA_FIELDS.length; i++) {
    var v = trim(c[FORMULA_FIELDS[i][0]]);
    if (v) { bits.push(v); break; }
  }
  if (bits.length < 2) {
    var n = trim(c.notes);
    if (n) bits.push(n.split('\n')[0]);
  }
  return bits.join('  ·  ');
}

function letterOf(c) {
  var ch = c._k.charAt(0).toUpperCase();
  return ch >= 'A' && ch <= 'Z' ? ch : '#';
}

var CHEV = '<svg viewBox="0 0 24 24" class="row-chev"><path d="m9 5 7 7-7 7"/></svg>';

function visibleClients() {
  var q = state.query;
  var f = state.filter;
  var src = state.clients;
  var out = [];
  for (var i = 0; i < src.length; i++) {
    var c = src[i];
    if (f !== 'all' && c.folderId !== f) continue;
    if (q && c._k.indexOf(q) === -1) continue;
    out.push(c);
  }
  return out;
}

function renderChips() {
  var html = '<button type="button" class="chip' + (state.filter === 'all' ? ' on' : '') +
             '" data-folder="all">All Clients</button>';
  for (var i = 0; i < state.folders.length; i++) {
    var f = state.folders[i];
    var on = state.filter === f.id;
    html += '<button type="button" class="chip' + (on ? ' on' : '') + '" data-folder="' + esc(f.id) + '">' +
            esc(f.name) +
            (on ? '<span class="chip-edit" data-edit="' + esc(f.id) + '">Edit</span>' : '') +
            '</button>';
  }
  $('folder-chips').innerHTML = html;
}

/* The list renders in chunks and grows as she scrolls, so a keystroke costs
   the same whether she has 5 clients or 5,000. */
var CHUNK = 60;
var render = { list: [], cursor: 0, letter: null, grp: null };

function rowHtml(c) {
  var meta = summaryOf(c);
  return '<div class="row-wrap" data-id="' + esc(c.id) + '">' +
           '<button type="button" class="row-del" data-del="' + esc(c.id) + '">Delete</button>' +
           '<div class="row" role="button" tabindex="0">' +
             '<span class="row-main">' +
               '<span class="row-name">' + esc(c.name || 'Untitled') + '</span>' +
               (meta ? '<span class="row-meta">' + esc(meta) + '</span>' : '') +
             '</span>' + CHEV +
           '</div>' +
         '</div>';
}

function appendChunk() {
  var host = $('client-list');
  var end = Math.min(render.cursor + CHUNK, render.list.length);
  var buf = '';

  while (render.cursor < end) {
    var c = render.list[render.cursor];
    var L = letterOf(c);
    if (L !== render.letter) {
      if (buf && render.grp) { render.grp.insertAdjacentHTML('beforeend', buf); buf = ''; }
      host.insertAdjacentHTML('beforeend',
        '<div class="grp-head">' + esc(L) + '</div><div class="grp"></div>');
      render.grp = host.lastElementChild;
      render.letter = L;
    }
    buf += rowHtml(c);
    render.cursor++;
  }
  if (buf && render.grp) render.grp.insertAdjacentHTML('beforeend', buf);
  return render.cursor < render.list.length;
}

function fillViewport() {
  var sc = $('list-scroll');
  var guard = 0;
  while (render.cursor < render.list.length &&
         sc.scrollHeight < sc.clientHeight + sc.scrollTop + 800 && guard++ < 40) {
    appendChunk();
  }
}

$('list-scroll').addEventListener('scroll', function () {
  if (render.cursor >= render.list.length) return;
  var sc = this;
  if (sc.scrollTop + sc.clientHeight > sc.scrollHeight - 800) fillViewport();
}, { passive: true });

function renderList() {
  closeOpenRow();
  var list = visibleClients();
  var host = $('client-list');
  var emptyEl = $('list-empty');

  render.list = list;
  render.cursor = 0;
  render.letter = null;
  render.grp = null;
  host.textContent = '';

  if (!list.length) {
    emptyEl.hidden = false;
    if (state.query) {
      emptyEl.innerHTML = '<b>🔍</b>No clients match “' + esc(state.query) + '”.';
    } else if (state.filter !== 'all') {
      var f = state.folderById[state.filter];
      emptyEl.innerHTML = '<b>🗂️</b>No clients in ' + esc(f ? f.name : 'this folder') +
                          ' yet — tap + to add one.';
    } else if (!state.clients.length) {
      emptyEl.innerHTML = '<b>💕</b>No clients yet — tap + to add your first.';
    } else {
      emptyEl.innerHTML = '<b>💕</b>Nothing here yet.';
    }
    return;
  }

  emptyEl.hidden = true;
  appendChunk();
  fillViewport();
}

function renderAll() {
  renderChips();
  renderList();
}

/* ------------------------------------------------------------
   Search
   ------------------------------------------------------------ */
$('search').addEventListener('input', function () {
  $('search-clear').hidden = !this.value;
  var q = nameKey(this.value);
  if (q === state.query) return;
  state.query = q;
  $('list-scroll').scrollTop = 0;
  renderList();
});
$('search-clear').addEventListener('click', function () {
  var s = $('search');
  s.value = ''; this.hidden = true;
  state.query = '';
  renderList();
  s.blur();
});
$('search').addEventListener('keydown', function (e) {
  if (e.key === 'Enter') { e.preventDefault(); this.blur(); }
});

/* ------------------------------------------------------------
   Folder chips interaction
   ------------------------------------------------------------ */
$('folder-chips').addEventListener('click', function (e) {
  var editEl = e.target.closest('[data-edit]');
  if (editEl) {
    e.stopPropagation();
    openFolderEditor(editEl.getAttribute('data-edit'));
    return;
  }
  var chip = e.target.closest('[data-folder]');
  if (!chip) return;
  var id = chip.getAttribute('data-folder');
  if (id === state.filter) return;
  state.filter = id;
  renderAll();
  $('list-scroll').scrollTop = 0;
});

/* ------------------------------------------------------------
   Row interaction: tap / swipe-to-delete / long-press
   ------------------------------------------------------------ */
var openRow = null;
var sw = { row: null, id: null, x: 0, y: 0, dx: 0, axis: null, active: false, moved: false, lp: 0 };

function disarmLater(row) {
  setTimeout(function () {
    if (row.parentNode && openRow !== row && !row.style.transform) {
      row.parentNode.classList.remove('armed');
    }
  }, 280);
}

function closeOpenRow() {
  if (openRow) {
    var row = openRow;
    row.classList.add('settle');
    row.style.transform = '';
    openRow = null;
    disarmLater(row);
  }
}

function cancelLongPress() {
  if (sw.lp) { clearTimeout(sw.lp); sw.lp = 0; }
}

function resetSwipe() {
  cancelLongPress();
  sw.row = null; sw.id = null; sw.axis = null; sw.active = false; sw.dx = 0;
}

var listHost = $('client-list');

listHost.addEventListener('touchstart', function (e) {
  if (e.touches.length !== 1) { resetSwipe(); return; }
  var row = e.target.closest('.row');
  sw.moved = false;

  if (!row) { closeOpenRow(); resetSwipe(); return; }
  if (openRow && openRow !== row) { closeOpenRow(); }

  var wrap = row.parentNode;
  sw.row = row;
  sw.id = wrap.getAttribute('data-id');
  sw.x = e.touches[0].clientX;
  sw.y = e.touches[0].clientY;
  sw.dx = 0;
  sw.axis = null;
  sw.active = true;

  cancelLongPress();
  var id = sw.id;
  sw.lp = setTimeout(function () {
    sw.lp = 0;
    if (!sw.active || sw.axis === 'v' || sw.moved) return;
    sw.active = false;
    sw.moved = true;
    closeOpenRow();
    if (sw.row) { sw.row.classList.add('settle'); sw.row.style.transform = ''; }
    if (navigator.vibrate) { try { navigator.vibrate(8); } catch (err) {} }
    askDeleteClient(id);
  }, 550);
}, { passive: true });

listHost.addEventListener('touchmove', function (e) {
  if (!sw.active || !sw.row) return;
  var t = e.touches[0];
  var dx = t.clientX - sw.x;
  var dy = t.clientY - sw.y;

  if (Math.abs(dx) > 6 || Math.abs(dy) > 6) { sw.moved = true; cancelLongPress(); }

  if (sw.axis === null) {
    if (Math.abs(dy) > 8 && Math.abs(dy) > Math.abs(dx)) { sw.axis = 'v'; sw.active = false; return; }
    if (Math.abs(dx) > 10) sw.axis = 'h';
    else return;
  }
  if (sw.axis !== 'h') return;

  e.preventDefault();
  var base = openRow === sw.row ? -96 : 0;
  var x = base + dx;
  if (x > 0) x = x * 0.25;
  if (x < -140) x = -140 + (x + 140) * 0.2;
  sw.dx = x;
  sw.row.parentNode.classList.add('armed');
  sw.row.classList.remove('settle');
  sw.row.classList.add('swiping');
  sw.row.style.transform = 'translate3d(' + x + 'px,0,0)';
}, { passive: false });

function endSwipe() {
  cancelLongPress();
  if (!sw.row || sw.axis !== 'h') { sw.active = false; return; }
  var row = sw.row;
  row.classList.remove('swiping');
  row.classList.add('settle');
  if (sw.dx < -48) {
    row.style.transform = 'translate3d(-96px,0,0)';
    openRow = row;
  } else {
    row.style.transform = '';
    if (openRow === row) openRow = null;
    disarmLater(row);
  }
  sw.active = false;
}

listHost.addEventListener('touchend', endSwipe, { passive: true });
listHost.addEventListener('touchcancel', function () {
  cancelLongPress();
  if (sw.row && sw.axis === 'h') {
    sw.row.classList.remove('swiping');
    sw.row.classList.add('settle');
    sw.row.style.transform = openRow === sw.row ? 'translate3d(-96px,0,0)' : '';
    disarmLater(sw.row);
  }
  sw.active = false;
}, { passive: true });

listHost.addEventListener('click', function (e) {
  var delBtn = e.target.closest('[data-del]');
  if (delBtn) { askDeleteClient(delBtn.getAttribute('data-del')); return; }

  var row = e.target.closest('.row');
  if (!row) return;
  if (sw.moved) { sw.moved = false; return; }
  if (openRow) { closeOpenRow(); return; }
  var wrap = row.parentNode;
  openClientDetail(wrap.getAttribute('data-id'));
});

/* Desktop / non-touch: right-click as the long-press equivalent */
listHost.addEventListener('contextmenu', function (e) {
  var wrap = e.target.closest('.row-wrap');
  if (!wrap) return;
  e.preventDefault();
  askDeleteClient(wrap.getAttribute('data-id'));
});

/* ------------------------------------------------------------
   Client detail
   ------------------------------------------------------------ */
function openClientDetail(id) {
  var c = clientById(id);
  if (!c) { toast('That client is gone.'); renderList(); return; }
  state.viewingClientId = id;
  renderDetail();
  go('screen-client');
}

function renderDetail() {
  var c = clientById(state.viewingClientId);
  if (!c) return;
  $('detail-title').textContent = c.name || 'Client';

  var html = '<h2 class="detail-name">' + esc(c.name || 'Untitled') + '</h2>';
  var f = state.folderById[c.folderId];
  if (f) html += '<div class="detail-folder">' + esc(f.name) + '</div>';

  var formula = '';
  for (var i = 0; i < FORMULA_FIELDS.length; i++) {
    var key = FORMULA_FIELDS[i][0], label = FORMULA_FIELDS[i][1];
    var v = trim(c[key]);
    if (!v) continue;
    formula += '<div class="dt"><div class="dt-lbl">' + esc(label) + '</div>' +
               '<div class="dt-val">' + esc(v) + '</div></div>';
  }
  if (formula) {
    html += '<p class="section-label">Formula</p><div class="card">' + formula + '</div>';
  }

  var notes = trim(c.notes);
  if (notes) {
    html += '<p class="section-label">Notes</p><div class="card">' +
            '<div class="dt"><div class="dt-val">' + esc(notes) + '</div></div></div>';
  }

  if (!formula && !notes) {
    html += '<p class="hint" style="margin-top:22px">No formula or notes yet — tap Edit to add them.</p>';
  }

  $('detail-body').innerHTML = html;
}

$('btn-detail-back').addEventListener('click', back);
$('btn-detail-edit').addEventListener('click', function () {
  openClientEditor(state.viewingClientId);
});

/* ------------------------------------------------------------
   Client editor
   ------------------------------------------------------------ */
function fillFolderSelect(selectedId) {
  var html = '<option value="">No folder</option>';
  for (var i = 0; i < state.folders.length; i++) {
    var f = state.folders[i];
    html += '<option value="' + esc(f.id) + '">' + esc(f.name) + '</option>';
  }
  var sel = $('f-folder');
  sel.innerHTML = html;
  sel.value = selectedId && state.folderById[selectedId] ? selectedId : '';
}

function openClientEditor(id) {
  var c = id ? clientById(id) : null;
  state.editingClientId = c ? c.id : null;

  $('edit-title').textContent = c ? 'Edit Client' : 'New Client';
  $('f-name').value = c ? (c.name || '') : '';
  fillFolderSelect(c ? c.folderId : (state.filter !== 'all' ? state.filter : ''));
  for (var i = 0; i < FORMULA_FIELDS.length; i++) {
    var key = FORMULA_FIELDS[i][0];
    $('f-' + key).value = c ? (c[key] || '') : '';
  }
  $('f-notes').value = c ? (c.notes || '') : '';
  $('edit-delete-wrap').hidden = !c;

  go('screen-edit');
  if (!c) setTimeout(function () { try { $('f-name').focus(); } catch (e) {} }, 260);
}

function saveClient() {
  var name = trim($('f-name').value);
  if (!name) { toast('Add a name first.'); try { $('f-name').focus(); } catch (e) {} return; }

  var existing = state.editingClientId ? clientById(state.editingClientId) : null;
  var c = existing || { id: uid(), createdAt: Date.now() };
  c.name = name;
  var folderVal = $('f-folder').value;
  c.folderId = folderVal && state.folderById[folderVal] ? folderVal : '';
  for (var i = 0; i < FORMULA_FIELDS.length; i++) {
    var key = FORMULA_FIELDS[i][0];
    c[key] = trim($('f-' + key).value);
  }
  c.notes = $('f-notes').value.replace(/\s+$/, '');
  c.updatedAt = Date.now();
  decorate(c);

  if (!existing) state.clients.push(c);
  sortByName(state.clients);

  var persisted = { id: c.id, name: c.name, folderId: c.folderId, notes: c.notes,
                    createdAt: c.createdAt, updatedAt: c.updatedAt };
  for (var j = 0; j < FORMULA_FIELDS.length; j++) persisted[FORMULA_FIELDS[j][0]] = c[FORMULA_FIELDS[j][0]];
  DB.put(STORE_CLIENTS, persisted);

  state.editingClientId = null;
  renderAll();

  // The editor is always opened from the list (new) or the detail view (edit),
  // so one step back lands exactly where she came from.
  if (stack[stack.length - 2] === 'screen-client') {
    state.viewingClientId = c.id;
    renderDetail();
  }
  back();
  toast(existing ? 'Saved' : 'Client added');
}

$('btn-edit-save').addEventListener('click', saveClient);
$('btn-edit-cancel').addEventListener('click', function () {
  state.editingClientId = null;
  back();
});
$('client-form').addEventListener('submit', function (e) { e.preventDefault(); saveClient(); });
$('btn-edit-delete').addEventListener('click', function () {
  askDeleteClient(state.editingClientId);
});

function askDeleteClient(id) {
  var c = clientById(id);
  if (!c) return;
  confirmDialog('Delete ' + (c.name || 'this client') + '?',
                'This can\'t be undone.', 'Delete').then(function (ok) {
    if (!ok) { closeOpenRow(); return; }
    deleteClient(id);
  });
}

function deleteClient(id) {
  var idx = -1;
  for (var i = 0; i < state.clients.length; i++) if (state.clients[i].id === id) { idx = i; break; }
  if (idx === -1) return;
  state.clients.splice(idx, 1);
  DB.del(STORE_CLIENTS, id);
  openRow = null;
  renderList();

  // If we were looking at (or editing) that client, get back to the list.
  if (state.viewingClientId === id || state.editingClientId === id) {
    state.viewingClientId = null;
    state.editingClientId = null;
    var steps = stack.length - 1;
    stack = ['screen-list'];
    showScreen('screen-list');
    if (steps > 0) { try { history.go(-steps); } catch (e) {} }
  }
  toast('Deleted');
}

/* ------------------------------------------------------------
   Folder editor
   ------------------------------------------------------------ */
function openFolderEditor(id) {
  var f = id ? state.folderById[id] : null;
  state.editingFolderId = f ? f.id : null;
  $('folder-title').textContent = f ? 'Edit Folder' : 'New Folder';
  $('f-folder-name').value = f ? f.name : '';
  $('folder-delete-wrap').hidden = !f;
  go('screen-folder');
  if (!f) setTimeout(function () { try { $('f-folder-name').focus(); } catch (e) {} }, 260);
}

function saveFolder() {
  var name = trim($('f-folder-name').value);
  if (!name) { toast('Give the folder a name.'); return; }

  var f = state.editingFolderId ? state.folderById[state.editingFolderId] : null;
  if (!f) {
    f = { id: uid(), name: name, createdAt: Date.now() };
    state.folders.push(f);
  } else {
    f.name = name;
  }
  f._k = nameKey(name);
  sortByName(state.folders);
  reindexFolders();
  DB.put(STORE_FOLDERS, { id: f.id, name: f.name, createdAt: f.createdAt });

  if (!state.editingFolderId) state.filter = f.id;
  state.editingFolderId = null;
  renderAll();
  back();
  toast('Saved');
}

$('btn-folder-save').addEventListener('click', saveFolder);
$('btn-folder-cancel').addEventListener('click', function () {
  state.editingFolderId = null;
  back();
});
$('f-folder-name').addEventListener('keydown', function (e) {
  if (e.key === 'Enter') { e.preventDefault(); saveFolder(); }
});

$('btn-folder-delete').addEventListener('click', function () {
  var id = state.editingFolderId;
  var f = state.folderById[id];
  if (!f) return;
  var count = 0;
  for (var i = 0; i < state.clients.length; i++) if (state.clients[i].folderId === id) count++;
  confirmDialog('Delete “' + f.name + '”?',
    count ? count + (count === 1 ? ' client stays' : ' clients stay') + ' in All Clients.'
          : 'This folder is empty.',
    'Delete Folder').then(function (ok) {
    if (!ok) return;
    for (var i = 0; i < state.clients.length; i++) {
      var c = state.clients[i];
      if (c.folderId === id) {
        c.folderId = '';
        c.updatedAt = Date.now();
        DB.put(STORE_CLIENTS, stripClient(c));
      }
    }
    var idx = state.folders.indexOf(f);
    if (idx > -1) state.folders.splice(idx, 1);
    reindexFolders();
    DB.del(STORE_FOLDERS, id);
    if (state.filter === id) state.filter = 'all';
    state.editingFolderId = null;
    renderAll();
    back();
    toast('Folder deleted');
  });
});

function stripClient(c) {
  var o = { id: c.id, name: c.name, folderId: c.folderId || '', notes: c.notes || '',
            createdAt: c.createdAt || Date.now(), updatedAt: c.updatedAt || Date.now() };
  for (var i = 0; i < FORMULA_FIELDS.length; i++) o[FORMULA_FIELDS[i][0]] = c[FORMULA_FIELDS[i][0]] || '';
  return o;
}

/* ------------------------------------------------------------
   Settings, backup & import
   ------------------------------------------------------------ */
$('btn-settings').addEventListener('click', function () {
  $('stat-clients').textContent = state.clients.length;
  $('stat-folders').textContent = state.folders.length;
  $('stat-version').textContent = APP_VERSION;
  go('screen-settings');
});
$('btn-settings-back').addEventListener('click', back);

function backupPayload() {
  return {
    app: 'mos-management',
    schema: 1,
    exportedAt: new Date().toISOString(),
    folders: state.folders.map(function (f) { return { id: f.id, name: f.name, createdAt: f.createdAt }; }),
    clients: state.clients.map(stripClient)
  };
}

function backupFilename() {
  var d = new Date();
  function p(n) { return (n < 10 ? '0' : '') + n; }
  return 'mos-management-' + d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + '.json';
}

$('btn-export').addEventListener('click', function () {
  var json, blob, name = backupFilename();
  try {
    json = JSON.stringify(backupPayload(), null, 2);
    blob = new Blob([json], { type: 'application/json' });
  } catch (e) { toast('Could not build the backup.'); return; }

  // iOS standalone: the share sheet is the reliable way to keep a file.
  try {
    if (navigator.canShare && navigator.share) {
      var file = new File([blob], name, { type: 'application/json' });
      if (navigator.canShare({ files: [file] })) {
        navigator.share({ files: [file], title: "Mo's Management backup" })
          .then(function () { toast('Backup saved'); })
          .catch(function () { /* user cancelled — nothing to report */ });
        return;
      }
    }
  } catch (e) { /* fall through to download */ }

  try {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name; a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      try { document.body.removeChild(a); URL.revokeObjectURL(url); } catch (e) {}
    }, 1500);
    toast('Backup saved');
  } catch (e) { toast('Could not save the backup.'); }
});

$('btn-import').addEventListener('click', function () { $('import-file').click(); });

$('import-file').addEventListener('change', function () {
  var file = this.files && this.files[0];
  this.value = '';
  if (!file) return;

  var reader = new FileReader();
  reader.onerror = function () { toast('Could not read that file.'); };
  reader.onload = function () {
    var data;
    try { data = JSON.parse(reader.result); }
    catch (e) { toast('That file isn\'t a valid backup.'); return; }

    if (!data || !Array.isArray(data.clients)) { toast('That file isn\'t a Mo\'s Management backup.'); return; }

    var folders = (Array.isArray(data.folders) ? data.folders : [])
      .filter(function (f) { return f && f.id && trim(f.name); })
      .map(function (f) { return { id: String(f.id), name: trim(f.name), createdAt: f.createdAt || Date.now() }; });

    var seen = Object.create(null);
    for (var i = 0; i < folders.length; i++) seen[folders[i].id] = true;

    var clients = data.clients
      .filter(function (c) { return c && (trim(c.name) || c.id); })
      .map(function (c) {
        var o = { id: c.id ? String(c.id) : uid(), name: trim(c.name), folderId: '',
                  notes: c.notes == null ? '' : String(c.notes),
                  createdAt: c.createdAt || Date.now(), updatedAt: c.updatedAt || Date.now() };
        if (c.folderId && seen[c.folderId]) o.folderId = String(c.folderId);
        for (var k = 0; k < FORMULA_FIELDS.length; k++) {
          var key = FORMULA_FIELDS[k][0];
          o[key] = c[key] == null ? '' : String(c[key]);
        }
        return o;
      });

    confirmDialog('Import backup?',
      'This replaces everything on this device with ' + clients.length + ' client' +
      (clients.length === 1 ? '' : 's') + ' and ' + folders.length + ' folder' +
      (folders.length === 1 ? '' : 's') + '.',
      'Import').then(function (ok) {
      if (!ok) return;
      state.folders = folders.map(function (f) { f._k = nameKey(f.name); return f; });
      state.clients = clients.map(decorate);
      sortByName(state.folders);
      sortByName(state.clients);
      reindexFolders();
      state.filter = 'all';
      state.query = '';
      $('search').value = '';
      $('search-clear').hidden = true;

      Promise.all([
        DB.replaceAll(STORE_FOLDERS, state.folders.map(function (f) {
          return { id: f.id, name: f.name, createdAt: f.createdAt };
        })),
        DB.replaceAll(STORE_CLIENTS, state.clients.map(stripClient))
      ]).then(function () {
        $('stat-clients').textContent = state.clients.length;
        $('stat-folders').textContent = state.folders.length;
        renderAll();
        toast('Imported ' + state.clients.length + ' client' + (state.clients.length === 1 ? '' : 's'));
      });
    });
  };
  try { reader.readAsText(file); } catch (e) { toast('Could not read that file.'); }
});

/* ------------------------------------------------------------
   Boot
   ------------------------------------------------------------ */
function boot() {
  try { history.replaceState({ depth: 1 }, ''); } catch (e) {}

  Promise.all([DB.getAll(STORE_CLIENTS), DB.getAll(STORE_FOLDERS)]).then(function (res) {
    var clients = res[0] || [], folders = res[1] || [];
    state.folders = folders.filter(function (f) { return f && f.id; })
      .map(function (f) { f._k = nameKey(f.name); return f; });
    sortByName(state.folders);
    reindexFolders();

    state.clients = clients.filter(function (c) { return c && c.id; }).map(decorate);
    sortByName(state.clients);

    renderAll();
  }).catch(function () {
    renderAll();
    toast('Could not load saved data.');
  });
}

/* Never let a stray error take the app down. */
window.addEventListener('error', function (e) {
  console.error('[app]', e && e.message);
});
window.addEventListener('unhandledrejection', function (e) {
  console.error('[app] promise', e && e.reason);
});

/* Kill iOS double-tap zoom / pinch weirdness in standalone mode. */
document.addEventListener('gesturestart', function (e) { e.preventDefault(); });
var lastTouchEnd = 0;
document.addEventListener('touchend', function (e) {
  var now = Date.now();
  if (now - lastTouchEnd < 320) e.preventDefault();
  lastTouchEnd = now;
}, false);

boot();

/* Service worker */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('sw.js').catch(function (err) {
      console.warn('[sw] registration failed', err);
    });
  });
}

})();
