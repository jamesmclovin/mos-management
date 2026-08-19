/* ============================================================
   Mo's Management — offline client notes tracker
   Vanilla JS, no dependencies. Memory-first, IndexedDB-backed.
   v2: Keep-style — each client holds dated notes. No folders.
   ============================================================ */
(function () {
'use strict';

var APP_VERSION = '2.0';
var DB_NAME = 'mos-management';
var DB_VERSION = 1;
var STORE_CLIENTS = 'clients';
var STORE_FOLDERS = 'folders';   // legacy store, emptied on migration

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

var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
              'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtDate(ts) {
  var d = new Date(ts || Date.now());
  if (isNaN(d.getTime())) d = new Date();
  return MONTHS[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
}

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
    clear: function (store) {
      return tx(store, 'readwrite', function (s) { s.clear(); });
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
  clients: [],          // kept sorted by nameKey; each has notes: [{id,date,text}]
  query: '',
  editingClientId: null,
  editingNoteId: null,  // null while composing a brand-new note
  viewingClientId: null
};

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

function sortNotes(c) {
  c.notes.sort(function (a, b) { return (b.date || 0) - (a.date || 0); });
}

function decorate(c) {
  c._k = nameKey(c.name);
  return c;
}

function clientById(id) {
  for (var i = 0; i < state.clients.length; i++) if (state.clients[i].id === id) return state.clients[i];
  return null;
}

function noteById(c, id) {
  if (!c) return null;
  for (var i = 0; i < c.notes.length; i++) if (c.notes[i].id === id) return c.notes[i];
  return null;
}

function stripClient(c) {
  return {
    id: c.id, name: c.name,
    notes: c.notes.map(function (n) {
      return { id: n.id, date: n.date, text: n.text };
    }),
    createdAt: c.createdAt || Date.now(),
    updatedAt: c.updatedAt || Date.now()
  };
}

/* ------------------------------------------------------------
   Migration — old clients had formula fields and a notes string.
   Fold everything they wrote into one dated note; lose nothing.
   ------------------------------------------------------------ */
var LEGACY_FIELDS = [
  ['roots', 'Roots'],
  ['gloss', 'Gloss / Toner'],
  ['developer', 'Developer'],
  ['time', 'Processing Time'],
  ['other', 'Other']
];

function normalizeNote(n) {
  if (!n || typeof n !== 'object') return null;
  var text = n.text == null ? '' : String(n.text);
  var date = typeof n.date === 'number' && isFinite(n.date) ? n.date : Date.now();
  return { id: n.id ? String(n.id) : uid(), date: date, text: text };
}

function migrateClient(raw) {
  var c = {
    id: String(raw.id),
    name: trim(raw.name),
    notes: [],
    createdAt: raw.createdAt || Date.now(),
    updatedAt: raw.updatedAt || Date.now()
  };

  if (Array.isArray(raw.notes)) {
    // already the new shape
    for (var i = 0; i < raw.notes.length; i++) {
      var n = normalizeNote(raw.notes[i]);
      if (n) c.notes.push(n);
    }
    sortNotes(c);
    return { client: c, migrated: false };
  }

  var parts = [];
  for (var j = 0; j < LEGACY_FIELDS.length; j++) {
    var v = trim(raw[LEGACY_FIELDS[j][0]]);
    if (v) parts.push(LEGACY_FIELDS[j][1] + ': ' + v);
  }
  var freeText = trim(raw.notes);
  if (freeText) parts.push(freeText);

  if (parts.length) {
    c.notes.push({ id: uid(), date: c.updatedAt, text: parts.join('\n') });
  }
  return { client: c, migrated: true };
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
   Client list rendering — chunked, grows on scroll, so a
   keystroke costs the same at 5 clients or 5,000.
   ------------------------------------------------------------ */
function summaryOf(c) {
  if (!c.notes.length) return '';
  var n = c.notes[0]; // newest first
  var line = trim(n.text).split('\n')[0];
  return fmtDate(n.date) + (line ? '  ·  ' + line : '');
}

function letterOf(c) {
  var ch = c._k.charAt(0).toUpperCase();
  return ch >= 'A' && ch <= 'Z' ? ch : '#';
}

var CHEV = '<svg viewBox="0 0 24 24" class="row-chev"><path d="m9 5 7 7-7 7"/></svg>';

function visibleClients() {
  var q = state.query;
  var src = state.clients;
  if (!q) return src.slice();
  var out = [];
  for (var i = 0; i < src.length; i++) {
    if (src[i]._k.indexOf(q) !== -1) out.push(src[i]);
  }
  return out;
}

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
    } else {
      emptyEl.innerHTML = '<b>💕</b>No clients yet — tap + to add your first.';
    }
    return;
  }

  emptyEl.hidden = true;
  appendChunk();
  fillViewport();
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
   Client detail — the client's stack of dated notes
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
  $('detail-name').textContent = c.name || 'Untitled';

  var html = '';
  for (var i = 0; i < c.notes.length; i++) {
    var n = c.notes[i];
    html += '<button type="button" class="note-card" data-note="' + esc(n.id) + '">' +
              '<span class="note-date">' + esc(fmtDate(n.date)) + '</span>' +
              (trim(n.text)
                ? '<span class="note-text">' + esc(n.text) + '</span>'
                : '<span class="note-text note-blank">No text</span>') +
            '</button>';
  }
  if (!c.notes.length) {
    html = '<p class="hint" style="margin-top:6px">No notes yet — tap + to write the first one.</p>';
  }
  $('notes-list').innerHTML = html;
}

$('btn-detail-back').addEventListener('click', back);
$('btn-detail-edit').addEventListener('click', function () {
  openClientEditor(state.viewingClientId);
});
$('btn-add-note').addEventListener('click', function () {
  openNoteEditor(null);
});
$('notes-list').addEventListener('click', function (e) {
  var card = e.target.closest('[data-note]');
  if (card) openNoteEditor(card.getAttribute('data-note'));
});

/* ------------------------------------------------------------
   Note editor — date is the header, set automatically
   ------------------------------------------------------------ */
var noteDraftDate = 0;

function openNoteEditor(noteId) {
  var c = clientById(state.viewingClientId);
  if (!c) return;
  var n = noteId ? noteById(c, noteId) : null;

  state.editingNoteId = n ? n.id : null;
  noteDraftDate = n ? n.date : Date.now();

  $('note-title').textContent = c.name || 'Note';
  $('note-date').textContent = fmtDate(noteDraftDate);
  $('f-note').value = n ? n.text : '';
  $('note-delete-wrap').hidden = !n;

  go('screen-note');
  if (!n) setTimeout(function () { try { $('f-note').focus(); } catch (e) {} }, 260);
}

function saveNote() {
  var c = clientById(state.viewingClientId);
  if (!c) { back(); return; }

  var text = $('f-note').value.replace(/\s+$/, '');
  var existing = state.editingNoteId ? noteById(c, state.editingNoteId) : null;

  if (!existing && !trim(text)) {
    // Nothing written — quietly drop the empty note.
    state.editingNoteId = null;
    back();
    return;
  }

  if (existing) {
    existing.text = text;
  } else {
    c.notes.push({ id: uid(), date: noteDraftDate, text: text });
  }
  sortNotes(c);
  c.updatedAt = Date.now();
  DB.put(STORE_CLIENTS, stripClient(c));

  state.editingNoteId = null;
  renderDetail();
  renderList();
  back();
  toast(existing ? 'Saved' : 'Note added');
}

$('btn-note-save').addEventListener('click', saveNote);
$('btn-note-cancel').addEventListener('click', function () {
  state.editingNoteId = null;
  back();
});

$('btn-note-delete').addEventListener('click', function () {
  var c = clientById(state.viewingClientId);
  var n = c && state.editingNoteId ? noteById(c, state.editingNoteId) : null;
  if (!n) return;
  confirmDialog('Delete this note?', 'The ' + fmtDate(n.date) + ' note will be gone for good.', 'Delete')
    .then(function (ok) {
      if (!ok) return;
      c.notes.splice(c.notes.indexOf(n), 1);
      c.updatedAt = Date.now();
      DB.put(STORE_CLIENTS, stripClient(c));
      state.editingNoteId = null;
      renderDetail();
      renderList();
      back();
      toast('Note deleted');
    });
});

/* ------------------------------------------------------------
   Client editor — just the name
   ------------------------------------------------------------ */
function openClientEditor(id) {
  var c = id ? clientById(id) : null;
  state.editingClientId = c ? c.id : null;

  $('edit-title').textContent = c ? 'Edit Client' : 'New Client';
  $('f-name').value = c ? (c.name || '') : '';
  $('edit-delete-wrap').hidden = !c;

  go('screen-edit');
  if (!c) setTimeout(function () { try { $('f-name').focus(); } catch (e) {} }, 260);
}

function saveClient() {
  var name = trim($('f-name').value);
  if (!name) { toast('Add a name first.'); try { $('f-name').focus(); } catch (e) {} return; }

  var existing = state.editingClientId ? clientById(state.editingClientId) : null;
  var c = existing || { id: uid(), notes: [], createdAt: Date.now() };
  c.name = name;
  c.updatedAt = Date.now();
  decorate(c);

  if (!existing) state.clients.push(c);
  sortByName(state.clients);
  DB.put(STORE_CLIENTS, stripClient(c));

  state.editingClientId = null;
  renderList();

  if (existing) {
    // Renamed from the detail view — go back to it.
    state.viewingClientId = c.id;
    renderDetail();
    back();
    toast('Saved');
  } else {
    // Brand-new client: swap the editor for their page so the
    // first note is one tap away. Back from there = the list.
    stack.pop();
    stack.push('screen-client');
    state.viewingClientId = c.id;
    renderDetail();
    showScreen('screen-client');
    toast('Client added');
  }
}

$('btn-plus').addEventListener('click', function () { openClientEditor(null); });
$('btn-edit-save').addEventListener('click', saveClient);
$('btn-edit-cancel').addEventListener('click', function () {
  state.editingClientId = null;
  back();
});
$('client-form').addEventListener('submit', function (e) { e.preventDefault(); saveClient(); });
$('f-name').addEventListener('keydown', function (e) {
  if (e.key === 'Enter') { e.preventDefault(); saveClient(); }
});
$('btn-edit-delete').addEventListener('click', function () {
  askDeleteClient(state.editingClientId);
});

function askDeleteClient(id) {
  var c = clientById(id);
  if (!c) return;
  var n = c.notes.length;
  confirmDialog('Delete ' + (c.name || 'this client') + '?',
                (n ? 'Their ' + (n === 1 ? 'note' : n + ' notes') + ' will be deleted too. ' : '') +
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
   Settings, backup & import
   ------------------------------------------------------------ */
function noteCount() {
  var n = 0;
  for (var i = 0; i < state.clients.length; i++) n += state.clients[i].notes.length;
  return n;
}

$('btn-settings').addEventListener('click', function () {
  $('stat-clients').textContent = state.clients.length;
  $('stat-notes').textContent = noteCount();
  $('stat-version').textContent = APP_VERSION;
  go('screen-settings');
});
$('btn-settings-back').addEventListener('click', back);

function backupPayload() {
  return {
    app: 'mos-management',
    schema: 2,
    exportedAt: new Date().toISOString(),
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

    // Both backup generations import cleanly: old formula-style
    // clients are folded into dated notes on the way in.
    var clients = [];
    var count = 0;
    for (var i = 0; i < data.clients.length; i++) {
      var raw = data.clients[i];
      if (!raw || (!trim(raw.name) && !raw.id)) continue;
      if (!raw.id) raw.id = uid();
      var m = migrateClient(raw);
      clients.push(decorate(m.client));
      count += m.client.notes.length;
    }

    confirmDialog('Import backup?',
      'This replaces everything on this device with ' + clients.length + ' client' +
      (clients.length === 1 ? '' : 's') + ' and ' + count + ' note' +
      (count === 1 ? '' : 's') + '.',
      'Import').then(function (ok) {
      if (!ok) return;
      state.clients = clients;
      sortByName(state.clients);
      state.query = '';
      $('search').value = '';
      $('search-clear').hidden = true;

      DB.replaceAll(STORE_CLIENTS, state.clients.map(stripClient)).then(function () {
        $('stat-clients').textContent = state.clients.length;
        $('stat-notes').textContent = noteCount();
        renderList();
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

  DB.getAll(STORE_CLIENTS).then(function (rows) {
    var migratedAny = false;
    state.clients = [];
    for (var i = 0; i < rows.length; i++) {
      if (!rows[i] || !rows[i].id) continue;
      var m = migrateClient(rows[i]);
      state.clients.push(decorate(m.client));
      if (m.migrated) {
        migratedAny = true;
        DB.put(STORE_CLIENTS, stripClient(m.client));
      }
    }
    sortByName(state.clients);
    if (migratedAny) DB.clear(STORE_FOLDERS);   // folders are gone in v2

    renderList();
  }).catch(function () {
    renderList();
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
