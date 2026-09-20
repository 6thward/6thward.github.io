// Member Board — a card per person, sorted into sections you name yourself.
// Drag a card between sections (or up/down inside one). Sections can be
// added, renamed, reordered and removed. Data:
//   boardColumns/{id}  { label, order }
//   board/{id}         { name, notes, column, order, createdAt, updatedAt }
import { db } from "./firebase-init.js?v=1789882678";
import { ctx, can } from "./app.js?v=1789882678";
import {
  collection, onSnapshot, addDoc, updateDoc, deleteDoc, doc, serverTimestamp, writeBatch,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { toast, esc, openModal, closeModal, fmtDate } from "./ui.js?v=1789882678";

// Next ordinance a person is working toward — shown as a pill beside the name.
const ORDINANCES = ["Sacrament", "Aaronic Priesthood", "Melchizedek Priesthood", "Endowment", "Sealing"];
const PALETTE = ["#1f4e79", "#5b4b9e", "#2e7d4f", "#a8720d", "#b3402f", "#0e7490", "#7a5a14", "#5b6675"];
const DEFAULT_COLUMNS = ["Ideas", "Talking to", "Settled"];

let cols = [];
let cards = [];
let started = false;
const expandedNotes = new Set(); // card ids whose long notes are shown in full
let seeding = false;

export function initBoard() {
  if (started) return;
  started = true;
  const panel = document.getElementById("panel-board");
  const editor = can("board", "edit");
  panel.innerHTML = `
    <div class="panel-head">
      <div>
        <h2>Member Board</h2>
        <p class="panel-sub">A card per person, in sections you name. Drag cards between sections.</p>
      </div>
      ${editor ? `<div style="display:flex;gap:.5rem;flex-wrap:wrap">
        <button class="btn" id="btn-new-section">+ New section</button>
        <button class="btn btn-primary" id="btn-new-card">+ Add person</button>
      </div>` : ""}
    </div>
    <div id="board-wrap"></div>`;
  if (editor) {
    panel.querySelector("#btn-new-section").addEventListener("click", () => editSection(null));
    panel.querySelector("#btn-new-card").addEventListener("click", () => editCard(null));
  }

  onSnapshot(collection(db, "boardColumns"), (qs) => {
    cols = qs.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    if (!cols.length && editor && !seeding && !(qs.metadata && qs.metadata.fromCache)) seedColumns();
    render();
  });
  onSnapshot(collection(db, "board"), (qs) => {
    cards = qs.docs.map((d) => ({ id: d.id, ...d.data() }));
    cards.sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9) || tsMs(a.createdAt) - tsMs(b.createdAt));
    render();
  });
}

const tsMs = (ts) => { const d = ts?.toDate?.() || (ts ? new Date(ts) : null); return d && !isNaN(d) ? d.getTime() : 0; };

async function seedColumns() {
  seeding = true;
  try {
    const batch = writeBatch(db);
    DEFAULT_COLUMNS.forEach((label, i) => batch.set(doc(collection(db, "boardColumns")), { label, order: i, createdAt: serverTimestamp() }));
    await batch.commit();
  } catch (e) { console.warn("[board] seed", e); }
  finally { seeding = false; }
}

const colColor = (i) => PALETTE[i % PALETTE.length];

function render() {
  const wrap = document.getElementById("board-wrap");
  if (!wrap) return;
  const editor = can("board", "edit");
  if (!cols.length) {
    wrap.innerHTML = `<div class="card"><div class="empty-note">${editor ? "Setting up your first sections…" : "No sections yet."}</div></div>`;
    return;
  }
  const colIds = new Set(cols.map((c) => c.id));
  const cardHtml = (k) => {
    const open = activeTodos(k);
    return `
    <div class="list-row call-card call-card-v board-card" data-id="${k.id}" style="--cc:${colColor(cols.findIndex((c) => c.id === k.column))};background:#fff;border:1px solid var(--line);border-left:5px solid var(--cc)">
      <div class="board-head"><div class="row-title">${esc(k.name || "—")}</div>${k.nextOrdinance || editor ? `<span class="ord-pill${k.nextOrdinance ? "" : " ord-empty"}${editor ? " ord-edit" : ""}" data-ord="1" title="${editor ? "Click to change" : ""}">${k.nextOrdinance ? "Next: " + esc(k.nextOrdinance) : "+ next ordinance"}</span>` : ""}</div>
      ${k.notes || editor ? `<div class="row-sub board-note${k.notes ? "" : " board-note-empty"}${editor ? " board-note-edit" : ""}${k.notes && !expandedNotes.has(k.id) ? " board-note-clamp" : ""}" data-notes="1" title="${editor ? "Click to edit" : ""}">${k.notes ? esc(k.notes) : "+ notes"}</div><div class="board-note-more" data-more="${k.id}" hidden>${expandedNotes.has(k.id) ? "less ▴" : "more ▾"}</div>` : ""}
      <div class="todo-pills">${open.map((t) => todoPill(k, t)).join("")}${editor ? `<span class="todo-pill todo-add-pill" data-addtodo="1" title="Add a to-do — type and press Enter">+</span>` : ""}</div>
      <div class="mtg-row">${meetingsPill(k, editor)}</div>
    </div>`;
  };
  wrap.innerHTML = `<div class="bishopric-board member-board">` + /* 4 columns on desktop (CSS); extra sections wrap to a second row */
    cols.map((c, i) => {
      const rows = cards.filter((k) => k.column === c.id);
      return `
      <div class="card bb-col board-col" data-colid="${c.id}" style="margin-top:.8rem;border-top:4px solid ${colColor(i)}">
        <h3 class="board-col-head" ${editor ? `draggable="true" title="Drag to reorder sections"` : ""} style="display:flex;align-items:center;gap:.5rem;min-width:0">
          <span class="board-col-label${editor ? " st-click" : ""}" data-col="${c.id}" title="${editor ? "Click to rename or remove this section" : ""}" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.label)}</span>
          <span class="pill pill-role-member">${rows.length}</span>
          ${editor ? `<button class="btn btn-sm" data-addto="${c.id}" type="button" style="margin-left:auto" title="Add a person to ${esc(c.label)}">+</button>` : ""}
        </h3>
        <div class="bb-drop" data-col="${c.id}">${rows.length ? rows.map(cardHtml).join("") : `<div class="empty-note">Nobody here yet.</div>`}</div>
      </div>`;
    }).join("") + `</div>` +
    (cards.some((k) => !colIds.has(k.column)) ? `
      <div class="card" style="margin-top:.8rem"><h3>Unsorted <span class="pill pill-role-member">${cards.filter((k) => !colIds.has(k.column)).length}</span></h3>
        <p class="row-sub">Their section was removed — drag them into one above.</p>
        <div class="bb-drop" data-col="">${cards.filter((k) => !colIds.has(k.column)).map(cardHtml).join("")}</div></div>` : "");

  wrap.querySelectorAll(".board-card").forEach((row) => {
    const note = row.querySelector(".board-note"), more = row.querySelector(".board-note-more");
    if (note && more && !note.classList.contains("board-note-empty")) {
      const id = row.dataset.id;
      more.hidden = !(expandedNotes.has(id) || note.scrollHeight > note.clientHeight + 2);
    }
    row.addEventListener("click", (e) => {
      const k = cards.find((x) => x.id === row.dataset.id);
      if (!k) return;
      const tick = e.target.closest(".todo-tick");
      if (tick && editor) { e.stopPropagation(); archiveTodoFromCard(k, tick.dataset.tick); return; }
      const pill = e.target.closest(".todo-pill");
      if (pill && pill.dataset.addtodo) { e.stopPropagation(); inlineNewTodo(row, k, pill); return; }
      if (pill) { e.stopPropagation(); const t = (k.todos || []).find((x) => x.id === pill.dataset.todo); if (t) editTodo(k, t); return; }
      const mp = e.target.closest(".mtg-pill");
      if (mp) { e.stopPropagation(); openMeetings(k); return; }
      const more = e.target.closest(".board-note-more");
      if (more) { e.stopPropagation(); if (expandedNotes.has(k.id)) expandedNotes.delete(k.id); else expandedNotes.add(k.id); render(); return; }
      const note = e.target.closest(".board-note");
      if (note && editor) { e.stopPropagation(); inlineNotes(row, k, note); return; }
      const ord = e.target.closest(".ord-pill");
      if (ord && editor) { e.stopPropagation(); inlineOrdinance(row, k, ord); return; }
      editCard(k);
    });
  });
  if (!editor) return;
  wrap.querySelectorAll("[data-addto]").forEach((b) => b.addEventListener("click", () => editCard(null, b.dataset.addto)));
  wrap.querySelectorAll(".board-col-label").forEach((l) => l.addEventListener("click", () => editSection(cols.find((c) => c.id === l.dataset.col))));

  // ---- drag a section header to reorder the sections ----
  let dragCol = null;
  wrap.querySelectorAll(".board-col-head[draggable]").forEach((h) => {
    const col = h.closest(".board-col");
    h.addEventListener("dragstart", (e) => { dragCol = col.dataset.colid; e.dataTransfer.effectAllowed = "move"; try { e.dataTransfer.setData("text/plain", ""); } catch {} col.classList.add("col-dragging"); e.stopPropagation(); });
    h.addEventListener("dragend", () => { dragCol = null; wrap.querySelectorAll(".col-dragging, .col-before").forEach((x) => x.classList.remove("col-dragging", "col-before")); });
  });
  wrap.querySelectorAll(".board-col").forEach((col) => {
    col.addEventListener("dragover", (e) => {
      if (!dragCol || col.dataset.colid === dragCol) return;
      e.preventDefault();
      wrap.querySelectorAll(".col-before").forEach((x) => x.classList.remove("col-before"));
      col.classList.add("col-before");
    });
    col.addEventListener("drop", async (e) => {
      if (!dragCol) return;
      e.preventDefault(); e.stopPropagation();
      const from = dragCol; dragCol = null;
      wrap.querySelectorAll(".col-dragging, .col-before").forEach((x) => x.classList.remove("col-dragging", "col-before"));
      const target = col.dataset.colid;
      if (from === target) return;
      const list = cols.filter((c) => c.id !== from);
      const moving = cols.find((c) => c.id === from);
      const at = list.findIndex((c) => c.id === target);
      list.splice(at < 0 ? list.length : at, 0, moving);
      const batch = writeBatch(db);
      list.forEach((c, i) => { if (c.order !== i) { c.order = i; batch.update(doc(db, "boardColumns", c.id), { order: i }); } });
      cols = list;
      render();
      await batch.commit();
    });
  });

  // ---- drag & drop: between sections and up/down within one ----
  let dragId = null;
  const clearMarks = () => wrap.querySelectorAll(".bb-before").forEach((r) => r.classList.remove("bb-before"));
  wrap.querySelectorAll(".board-card").forEach((row) => {
    row.draggable = true;
    row.addEventListener("dragstart", (e) => { dragId = row.dataset.id; e.dataTransfer.effectAllowed = "move"; try { e.dataTransfer.setData("text/plain", ""); } catch {} });
    row.addEventListener("dragend", () => { dragId = null; clearMarks(); wrap.querySelectorAll(".bb-drop").forEach((z) => z.classList.remove("bb-over")); });
    row.addEventListener("dragover", (e) => { if (!dragId || row.dataset.id === dragId) return; e.preventDefault(); clearMarks(); row.classList.add("bb-before"); });
    row.addEventListener("dragleave", () => row.classList.remove("bb-before"));
  });
  wrap.querySelectorAll(".bb-drop").forEach((zone) => {
    zone.addEventListener("dragover", (e) => { if (!dragId || dragCol) return; e.preventDefault(); zone.classList.add("bb-over"); });
    zone.addEventListener("dragleave", () => zone.classList.remove("bb-over"));
    zone.addEventListener("drop", async (e) => {
      if (dragCol) return; // a section is being dragged, handled above
      e.preventDefault();
      zone.classList.remove("bb-over");
      const targetRow = e.target.closest(".board-card");
      const beforeId = targetRow && targetRow.dataset.id !== dragId ? targetRow.dataset.id : null;
      clearMarks();
      const k = cards.find((x) => x.id === dragId);
      dragId = null;
      if (!k) return;
      const colId = zone.dataset.col;
      if (!colId) return; // can't drop into "Unsorted"
      await placeCard(k, colId, beforeId);
    });
  });
}

// Put a card into a section at a position, renumbering that section 0..n.
async function placeCard(k, colId, beforeId) {
  const list = cards.filter((x) => x.column === colId && x.id !== k.id);
  const at = beforeId ? list.findIndex((x) => x.id === beforeId) : -1;
  if (at >= 0) list.splice(at, 0, k); else list.push(k);
  const batch = writeBatch(db);
  let writes = 0;
  list.forEach((x, i) => {
    const patch = {};
    if (x.order !== i) patch.order = i;
    if (x.id === k.id && x.column !== colId) patch.column = colId;
    if (Object.keys(patch).length) { patch.updatedAt = serverTimestamp(); batch.update(doc(db, "board", x.id), patch); writes++; Object.assign(x, patch); }
  });
  k.column = colId;
  render();
  if (writes) await batch.commit();
}

// ---- to-dos on a card ----
// Stored on the card: todos: [{ id, title, notes, due (YYYY-MM-DD|""), order, done, doneAt, createdAt }]
const activeTodos = (k) => (k.todos || []).filter((t) => !t.done).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
const archivedTodos = (k) => (k.todos || []).filter((t) => t.done).sort((a, b) => (b.doneAt || "").localeCompare(a.doneAt || ""));
const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
function dueState(t) {
  if (!t.due) return "";
  const today = todayIso();
  if (t.due < today) return "overdue";
  const soon = new Date(Date.now() + 3 * 86400000); const soonIso = `${soon.getFullYear()}-${String(soon.getMonth() + 1).padStart(2, "0")}-${String(soon.getDate()).padStart(2, "0")}`;
  return t.due <= soonIso ? "soon" : "";
}
const fmtDue = (iso) => { if (!iso) return ""; const d = new Date(iso + "T12:00:00"); return d.toLocaleDateString("en-US", { month: "short", day: "numeric" }); };
function todoPill(k, t) {
  const st = dueState(t);
  // ○ on the right: one click marks it done and archives it off the board (2026-09-13);
  // archived to-dos stay in the person's profile under "Archived"
  const tick = can("board", "edit") ? `<span class="todo-tick" data-tick="${t.id}" title="Done — archive" role="button">✓</span>` : "";
  return `<span class="todo-pill${st ? " todo-" + st : ""}${t.council ? " todo-council" : ""}" data-todo="${t.id}" title="${esc((t.council ? "On the ward council agenda · " : "") + (t.notes ? t.notes : "Click for notes"))}">${t.council ? "📋 " : ""}<span class="todo-pill-text">${esc(t.title)}</span>${t.due ? `<span class="todo-due">${st === "overdue" ? "⚠ " : ""}${fmtDue(t.due)}</span>` : ""}${tick}</span>`;
}
// Mark a to-do done from the board pill; the archived copy lives in the profile.
async function archiveTodoFromCard(k, id) {
  const todos = (k.todos || []).map((x) => (x.id === id ? { ...x, done: true, doneAt: new Date().toISOString() } : x));
  await saveTodos(k, todos);
  toast("Done — archived (see their profile)");
}
async function saveTodos(k, todos) {
  k.todos = todos;
  await updateDoc(doc(db, "board", k.id), { todos, updatedAt: serverTimestamp() });
}
function newTodoId() { return "t" + Math.random().toString(36).slice(2, 9); }

function todoListHtml(k) {
  const open = activeTodos(k);
  const arch = archivedTodos(k);
  return `
    <div class="todo-list">
      ${open.length ? open.map((t, i) => `
        <div class="todo-row" data-todo="${t.id}">
          <span class="todo-prio">
            <button type="button" class="todo-mv" data-mv="up" data-todo="${t.id}" ${i === 0 ? "disabled" : ""} title="Higher priority">▲</button>
            <button type="button" class="todo-mv" data-mv="down" data-todo="${t.id}" ${i === open.length - 1 ? "disabled" : ""} title="Lower priority">▼</button>
          </span>
          <span class="todo-title todo-open" data-todo="${t.id}" title="Open notes">${i + 1}. ${esc(t.title)}${t.notes ? " <span class='todo-hasnotes' title='Has notes'>📝</span>" : ""}</span>
          <span class="todo-due-cell ${dueState(t)}">${t.due ? fmtDue(t.due) : ""}</span>
          <button type="button" class="btn btn-sm todo-done" data-todo="${t.id}" title="Mark done and archive">✓</button>
        </div>`).join("") : `<div class="row-sub" style="padding:.3rem 0">No to-dos yet.</div>`}
    </div>
    <div class="todo-add"><input class="todo-new" placeholder="+ Add a to-do and press Enter" autocomplete="off"><input type="date" class="todo-new-due" title="Deadline (optional)"></div>
    ${arch.length ? `<details class="todo-archive"><summary>Archived (${arch.length})</summary>
      ${arch.map((t) => `<div class="todo-row todo-archived" data-todo="${t.id}"><span class="todo-title todo-open" data-todo="${t.id}">${esc(t.title)}</span><span class="row-sub">${fmtDue(t.doneAt ? t.doneAt.slice(0, 10) : "")}</span><button type="button" class="btn btn-sm todo-restore" data-todo="${t.id}" title="Put back on the list">↩</button></div>`).join("")}
    </details>` : ""}`;
}

function wireTodoList(el, k) {
  const box = el.querySelector("#bc-todos");
  if (!box) return;
  const repaint = () => { box.innerHTML = todoListHtml(k); wireTodoList(el, k); };
  const byId = (id) => (k.todos || []).find((t) => t.id === id);
  box.querySelectorAll(".todo-mv").forEach((b) => b.addEventListener("click", async () => {
    const open = activeTodos(k); const i = open.findIndex((t) => t.id === b.dataset.todo);
    const j = b.dataset.mv === "up" ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= open.length) return;
    [open[i], open[j]] = [open[j], open[i]];
    open.forEach((t, n) => { t.order = n; });
    await saveTodos(k, [...open, ...archivedTodos(k)]); repaint();
  }));
  box.querySelectorAll(".todo-done").forEach((b) => b.addEventListener("click", async () => {
    const t = byId(b.dataset.todo); if (!t) return;
    t.done = true; t.doneAt = new Date().toISOString();
    await saveTodos(k, [...(k.todos || [])]); toast("Archived"); repaint();
  }));
  box.querySelectorAll(".todo-restore").forEach((b) => b.addEventListener("click", async () => {
    const t = byId(b.dataset.todo); if (!t) return;
    t.done = false; delete t.doneAt; t.order = activeTodos(k).length;
    await saveTodos(k, [...(k.todos || [])]); repaint();
  }));
  box.querySelectorAll(".todo-open").forEach((sp) => sp.addEventListener("click", () => { const t = byId(sp.dataset.todo); if (t) editTodo(k, t, true); }));
  const inp = box.querySelector(".todo-new"), dueEl = box.querySelector(".todo-new-due");
  const add = async () => {
    const title = inp.value.trim(); if (!title) return;
    const t = { id: newTodoId(), title, notes: "", due: dueEl.value || "", order: activeTodos(k).length, done: false, createdAt: new Date().toISOString() };
    inp.value = ""; dueEl.value = "";
    await saveTodos(k, [...(k.todos || []), t]); repaint();
    setTimeout(() => box.querySelector(".todo-new")?.focus(), 30);
  };
  inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); add(); } });
  inp.addEventListener("blur", () => { if (inp.value.trim()) add(); });
}

// Next-ordinance pill → a dropdown in its place; change saves, blur restores.
function inlineOrdinance(row, k, pillEl) {
  if (row.querySelector("select.ord-sel")) return;
  const sel = document.createElement("select");
  sel.className = "ord-sel";
  sel.innerHTML = `<option value="">— none —</option>` + ORDINANCES.map((o) => `<option value="${esc(o)}"${k.nextOrdinance === o ? " selected" : ""}>${esc(o)}</option>`).join("");
  pillEl.replaceWith(sel);
  sel.focus();
  row.draggable = false;
  let done = false;
  const finish = async (save) => {
    if (done) return; done = true;
    row.draggable = true;
    if (save && sel.value !== (k.nextOrdinance || "")) {
      try { await updateDoc(doc(db, "board", k.id), { nextOrdinance: sel.value, updatedAt: serverTimestamp() }); k.nextOrdinance = sel.value; toast("Saved"); }
      catch (e) { toast("Couldn't save: " + (e.code || e.message)); }
    }
    render();
  };
  sel.addEventListener("click", (e) => e.stopPropagation());
  sel.addEventListener("mousedown", (e) => e.stopPropagation());
  sel.addEventListener("change", () => finish(true));
  sel.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); finish(false); } });
  sel.addEventListener("blur", () => setTimeout(() => finish(false), 120));
}

// Click the notes on a card → edit them right there. Blur or ⌘/Ctrl+Enter
// saves, Esc cancels. The textarea grows with the text.
function inlineNotes(row, k, noteEl) {
  if (row.querySelector("textarea.board-note-ta")) return;
  const ta = document.createElement("textarea");
  ta.className = "board-note-ta";
  ta.value = k.notes || "";
  ta.placeholder = "Notes about this person…";
  noteEl.replaceWith(ta);
  const grow = () => { ta.style.height = "auto"; ta.style.height = Math.max(48, ta.scrollHeight + 2) + "px"; };
  grow();
  ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
  row.draggable = false; // don't start a card drag while typing
  let done = false;
  const finish = async (save) => {
    if (done) return; done = true;
    row.draggable = true;
    const val = ta.value.trim();
    if (save && val !== (k.notes || "")) {
      try { await updateDoc(doc(db, "board", k.id), { notes: val, updatedAt: serverTimestamp() }); k.notes = val; toast("Saved"); }
      catch (e) { toast("Couldn't save: " + (e.code || e.message)); }
    }
    render();
  };
  ta.addEventListener("input", grow);
  ta.addEventListener("click", (e) => e.stopPropagation());
  ta.addEventListener("mousedown", (e) => e.stopPropagation());
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); finish(false); }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); finish(true); }
  });
  ta.addEventListener("blur", () => setTimeout(() => finish(true), 80));
}

// "+" on the card → type right there; Enter saves (no date), Esc / empty cancels.
function inlineNewTodo(row, k, pillEl) {
  if (row.querySelector("input.todo-inline")) return;
  const inp = document.createElement("input");
  inp.className = "todo-inline";
  inp.placeholder = "To-do… (Enter)";
  inp.autocomplete = "off";
  pillEl.replaceWith(inp);
  inp.focus();
  row.draggable = false;
  let done = false;
  const finish = async (save) => {
    if (done) return; done = true;
    row.draggable = true;
    const title = inp.value.trim();
    if (save && title) {
      const t = { id: newTodoId(), title, notes: "", due: "", order: activeTodos(k).length, done: false, createdAt: new Date().toISOString() };
      await saveTodos(k, [...(k.todos || []), t]);
    }
    render();
  };
  inp.addEventListener("click", (e) => e.stopPropagation());
  inp.addEventListener("mousedown", (e) => e.stopPropagation());
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    if (e.key === "Escape") { e.preventDefault(); finish(false); }
  });
  inp.addEventListener("blur", () => setTimeout(() => finish(true), 80));
}

// Quick add straight from the card: title + deadline (+ optional notes).
function newTodo(k) {
  const el = openModal(`
    <h3 style="margin-bottom:.2rem">New to-do</h3>
    <p class="row-sub" style="margin:0 0 .9rem">${esc(k.name || "")}</p>
    <div class="form-grid">
      <label class="field"><span>To-do</span><input id="nt-title" placeholder="e.g. Call about temple recommend" autocomplete="off"></label>
      <label class="field"><span>Deadline (optional)</span><input type="date" id="nt-due"></label>
      <label class="field full"><span>Notes (optional)</span><textarea id="nt-notes" style="min-height:4rem"></textarea></label>
    </div>
    <div class="modal-actions"><span></span><div style="display:flex;gap:.5rem"><button class="btn" id="nt-cancel">Cancel</button><button class="btn btn-primary" id="nt-save">Add</button></div></div>`);
  setTimeout(() => el.querySelector("#nt-title").focus(), 30);
  el.querySelector("#nt-cancel").addEventListener("click", closeModal);
  const save = async () => {
    const title = el.querySelector("#nt-title").value.trim();
    if (!title) { toast("Give it a title"); return; }
    const t = { id: newTodoId(), title, notes: el.querySelector("#nt-notes").value.trim(), due: el.querySelector("#nt-due").value || "", order: activeTodos(k).length, done: false, createdAt: new Date().toISOString() };
    await saveTodos(k, [...(k.todos || []), t]); toast("Added"); closeModal();
  };
  el.querySelector("#nt-save").addEventListener("click", save);
  el.querySelector("#nt-title").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); save(); } });
}

// ---- meeting recaps: dated notes from each time you met with the person ----
// Stored on the card: meetings: [{ id, date (YYYY-MM-DD), notes, createdAt }]
const meetingsOf = (k) => [...(k.meetings || [])].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
function meetingsPill(k, editor) {
  const ms = meetingsOf(k);
  if (!ms.length) return editor ? `<span class="mtg-pill mtg-empty" title="Add notes from a meeting">🗓 + meeting recap</span>` : "";
  return `<span class="mtg-pill" title="Click to read the recaps">🗓 ${ms.length} meeting${ms.length === 1 ? "" : "s"} · last ${fmtDue(ms[0].date)}</span>`;
}
async function saveMeetings(k, meetings) {
  k.meetings = meetings;
  await updateDoc(doc(db, "board", k.id), { meetings, updatedAt: serverTimestamp() });
}
function openMeetings(k, editingId) {
  const editor = can("board", "edit");
  const ms = meetingsOf(k);
  const editing = editingId ? ms.find((m) => m.id === editingId) : null;
  const el = openModal(`
    <h3 style="margin-bottom:.2rem">Meeting recaps</h3>
    <p class="row-sub" style="margin:0 0 .9rem">${esc(k.name || "")} · notes from each time you've met</p>
    ${editor ? `
      <div class="mtg-form">
        <div style="display:flex;gap:.5rem;align-items:center;margin-bottom:.4rem">
          <input type="date" id="mr-date" value="${esc(editing ? editing.date : todayIso())}">
          <span class="row-sub">${editing ? "Editing this recap" : "New recap"}</span>
          ${editing ? `<button class="btn btn-sm btn-ghost btn-danger" id="mr-del" type="button" style="margin-left:auto">Delete</button>` : ""}
        </div>
        <textarea id="mr-notes" placeholder="What was discussed, what was decided, what's next…" style="width:100%;box-sizing:border-box;min-height:6rem;padding:.55rem .65rem;border:1.5px solid var(--line);border-radius:8px;font:inherit;font-size:.92rem">${esc(editing ? editing.notes : "")}</textarea>
        <div style="display:flex;gap:.5rem;justify-content:flex-end;margin-top:.5rem">
          ${editing ? `<button class="btn" id="mr-cancel-edit" type="button">Cancel edit</button>` : ""}
          <button class="btn btn-primary" id="mr-save" type="button">${editing ? "Save changes" : "Save recap"}</button>
        </div>
      </div>` : ""}
    <div class="mtg-list">
      ${ms.length ? ms.map((m) => `
        <div class="mtg-entry${editing && editing.id === m.id ? " editing" : ""}" data-mtg="${m.id}">
          <div class="mtg-date">${fmtDate(m.date, { year: true })}</div>
          <div class="mtg-notes">${esc(m.notes || "")}</div>
          ${editor ? `<button class="btn btn-sm mtg-edit" type="button" title="Edit this recap">✎</button>` : ""}
        </div>`).join("") : `<div class="empty-note" style="padding:.8rem">No recaps yet.</div>`}
    </div>
    <div class="modal-actions"><span></span><button class="btn" id="mr-close">Close</button></div>`);
  el.querySelector("#mr-close").addEventListener("click", closeModal);
  el.querySelectorAll(".mtg-edit").forEach((b) => b.addEventListener("click", () => openMeetings(k, b.closest(".mtg-entry").dataset.mtg)));
  if (!editor) return;
  el.querySelector("#mr-cancel-edit")?.addEventListener("click", () => openMeetings(k));
  el.querySelector("#mr-del")?.addEventListener("click", async () => {
    if (!confirm("Delete this recap?")) return;
    await saveMeetings(k, (k.meetings || []).filter((m) => m.id !== editing.id)); toast("Deleted"); openMeetings(k);
  });
  el.querySelector("#mr-save").addEventListener("click", async () => {
    const date = el.querySelector("#mr-date").value || todayIso();
    const notes = el.querySelector("#mr-notes").value.trim();
    if (!notes) { toast("Write a line or two first"); return; }
    let next;
    if (editing) next = (k.meetings || []).map((m) => (m.id === editing.id ? { ...m, date, notes } : m));
    else next = [...(k.meetings || []), { id: "m" + Math.random().toString(36).slice(2, 9), date, notes, createdAt: new Date().toISOString(), by: ctx.name || "" }];
    await saveMeetings(k, next); toast("Saved"); openMeetings(k);
  });
}

// One to-do: title, deadline, notes; archive / delete. `fromCard` = came from
// the card editor, so Back returns there.
function editTodo(k, t, fromCard) {
  const editor = can("board", "edit");
  const el = openModal(`
    <h3 style="margin-bottom:.2rem">${esc(t.title)}</h3>
    <p class="row-sub" style="margin:0 0 .9rem">${esc(k.name || "")}${t.done ? " · archived " + fmtDue((t.doneAt || "").slice(0, 10)) : ""}</p>
    <div class="form-grid">
      <label class="field"><span>To-do</span><input id="td-title" value="${esc(t.title)}" ${editor ? "" : "disabled"}></label>
      <label class="field"><span>Deadline</span><input type="date" id="td-due" value="${esc(t.due || "")}" ${editor ? "" : "disabled"}></label>
      <label class="field full"><span>Notes</span><textarea id="td-notes" ${editor ? "" : "disabled"} placeholder="What's the situation, what's been said, next step…" style="min-height:7rem">${esc(t.notes || "")}</textarea></label>
    </div>
    <div class="modal-actions">
      <div style="display:flex;gap:.4rem;flex-wrap:wrap">
        ${editor ? `<button class="btn btn-ghost btn-danger" id="td-delete">Delete</button>` : ""}
        ${editor && !t.done ? `<button class="btn${t.council ? " council-on" : ""}" id="td-council" title="${t.council ? "Remove from the ward council agenda" : "Bring this up at the next ward council"}">📋 ${t.council ? "On ward council agenda ✓" : "Ward council"}</button>` : ""}
        ${editor && !t.done ? `<button class="btn" id="td-archive">✓ Done — archive</button>` : ""}
        ${editor && t.done ? `<button class="btn" id="td-restore">↩ Restore</button>` : ""}
      </div>
      <div style="display:flex;gap:.5rem">
        <button class="btn" id="td-back">${fromCard ? "Back" : (editor ? "Cancel" : "Close")}</button>
        ${editor ? `<button class="btn btn-primary" id="td-save">Save</button>` : ""}
      </div>
    </div>`);
  const back = () => { if (fromCard) editCard(k); else closeModal(); };
  el.querySelector("#td-back").addEventListener("click", back);
  if (!editor) return;
  const persist = async (mut) => {
    const todos = [...(k.todos || [])];
    const cur = todos.find((x) => x.id === t.id);
    if (cur) mut(cur, todos);
    await saveTodos(k, todos.filter(Boolean));
  };
  el.querySelector("#td-save").addEventListener("click", async () => {
    const title = el.querySelector("#td-title").value.trim();
    if (!title) { toast("Give it a title"); return; }
    await persist((cur) => { cur.title = title; cur.due = el.querySelector("#td-due").value || ""; cur.notes = el.querySelector("#td-notes").value.trim(); });
    toast("Saved"); back();
  });
  el.querySelector("#td-council")?.addEventListener("click", async () => {
    await persist((cur) => { cur.notes = el.querySelector("#td-notes").value.trim(); cur.council = !cur.council; if (cur.council) cur.councilAddedAt = new Date().toISOString(); });
    toast(t.council ? "Taken off the ward council agenda" : "Added to the ward council agenda");
    editTodo(k, (k.todos || []).find((x) => x.id === t.id) || t, fromCard);
  });
  el.querySelector("#td-archive")?.addEventListener("click", async () => {
    await persist((cur) => { cur.notes = el.querySelector("#td-notes").value.trim(); cur.done = true; cur.doneAt = new Date().toISOString(); });
    toast("Archived"); back();
  });
  el.querySelector("#td-restore")?.addEventListener("click", async () => {
    await persist((cur) => { cur.done = false; delete cur.doneAt; cur.order = activeTodos(k).length; });
    back();
  });
  el.querySelector("#td-delete").addEventListener("click", async () => {
    if (!confirm(`Delete “${t.title}”?`)) return;
    await saveTodos(k, (k.todos || []).filter((x) => x.id !== t.id));
    toast("Deleted"); back();
  });
}

// ---- person card editor ----
function editCard(k, presetCol) {
  const isNew = !k;
  const editor = can("board", "edit");
  const colId = k?.column || presetCol || (cols[0] && cols[0].id) || "";
  const el = openModal(`
    <h3>${isNew ? "Add a person" : (editor ? "Edit" : "") + " " + esc(k.name || "")}</h3>
    <div class="form-grid">
      <label class="field"><span>Name</span><input id="bc-name" value="${esc(k?.name || "")}" ${editor ? "" : "disabled"} autocomplete="off"></label>
      <label class="field"><span>Section</span>
        <select id="bc-col" ${editor ? "" : "disabled"}>${cols.map((c) => `<option value="${c.id}" ${c.id === colId ? "selected" : ""}>${esc(c.label)}</option>`).join("")}</select>
      </label>
      <label class="field"><span>Next ordinance</span><select id="bc-ord" ${editor ? "" : "disabled"}><option value="">— none —</option>${ORDINANCES.map((o) => `<option value="${esc(o)}"${(k?.nextOrdinance || "") === o ? " selected" : ""}>${esc(o)}</option>`).join("")}</select></label>
      <label class="field full"><span>Notes</span><textarea id="bc-notes" ${editor ? "" : "disabled"} placeholder="Anything worth remembering — optional">${esc(k?.notes || "")}</textarea></label>
    </div>
    ${!isNew ? `<h4 style="margin:1rem 0 .3rem">To-dos <span class="row-sub" style="font-weight:400">· top = highest priority · ✓ archives</span></h4><div id="bc-todos">${todoListHtml(k)}</div>
    <div style="margin-top:.9rem"><button class="btn btn-sm" type="button" id="bc-meetings">🗓 Meeting recaps (${(k.meetings || []).length})</button></div>` : ""}
    <div class="modal-actions">
      ${!isNew && editor ? `<button class="btn btn-ghost btn-danger" id="bc-delete">Remove</button>` : "<span></span>"}
      <div style="display:flex;gap:.5rem">
        <button class="btn" id="bc-cancel">${editor ? "Cancel" : "Close"}</button>
        ${editor ? `<button class="btn btn-primary" id="bc-save">${isNew ? "Add" : "Save"}</button>` : ""}
      </div>
    </div>`);
  el.querySelector("#bc-cancel").addEventListener("click", closeModal);
  el.querySelector("#bc-meetings")?.addEventListener("click", () => openMeetings(k));
  if (!editor) { el.querySelectorAll(".todo-open").forEach((sp) => sp.addEventListener("click", () => { const t = (k.todos || []).find((x) => x.id === sp.dataset.todo); if (t) editTodo(k, t, true); })); return; }
  if (!isNew) wireTodoList(el, k);
  if (isNew) setTimeout(() => el.querySelector("#bc-name").focus(), 30);
  el.querySelector("#bc-delete")?.addEventListener("click", async () => {
    if (!confirm(`Remove ${k.name || "this card"} from the board?`)) return;
    await deleteDoc(doc(db, "board", k.id)); toast("Removed"); closeModal();
  });
  const save = async () => {
    const name = el.querySelector("#bc-name").value.trim();
    const column = el.querySelector("#bc-col").value;
    const notes = el.querySelector("#bc-notes").value.trim();
    const nextOrdinance = el.querySelector("#bc-ord").value;
    if (!name) { toast("Enter a name"); return; }
    try {
      if (isNew) {
        const order = cards.filter((x) => x.column === column).length;
        await addDoc(collection(db, "board"), { name, notes, nextOrdinance, column, order, createdAt: serverTimestamp(), updatedAt: serverTimestamp(), createdBy: ctx.name || "" });
        toast(`${name} added`);
      } else {
        const patch = { name, notes, nextOrdinance, updatedAt: serverTimestamp() };
        if (column !== k.column) { patch.column = column; patch.order = cards.filter((x) => x.column === column).length; }
        await updateDoc(doc(db, "board", k.id), patch);
        toast("Saved");
      }
      closeModal();
    } catch (e) { toast("Couldn't save: " + (e.code || e.message)); }
  };
  el.querySelector("#bc-save").addEventListener("click", save);
  el.querySelector("#bc-name").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); save(); } });
}

// ---- section editor (rename / reorder / remove) ----
function editSection(c) {
  const isNew = !c;
  const count = c ? cards.filter((k) => k.column === c.id).length : 0;
  const idx = c ? cols.findIndex((x) => x.id === c.id) : -1;
  const el = openModal(`
    <h3>${isNew ? "New section" : "Section"}</h3>
    <div class="form-grid">
      <label class="field"><span>Label</span><input id="bs-label" value="${esc(c?.label || "")}" placeholder="e.g. Talking to" autocomplete="off"></label>
      ${!isNew && cols.length > 1 ? `<label class="field"><span>Position</span>
        <select id="bs-pos">${cols.map((x, i) => `<option value="${i}" ${i === idx ? "selected" : ""}>${i + 1}${x.id === c.id ? " (current)" : " — before " + esc(x.label)}</option>`).join("")}</select>
      </label>` : ""}
    </div>
    <div class="modal-actions">
      ${!isNew ? `<button class="btn btn-ghost btn-danger" id="bs-delete">Remove section</button>` : "<span></span>"}
      <div style="display:flex;gap:.5rem">
        <button class="btn" id="bs-cancel">Cancel</button>
        <button class="btn btn-primary" id="bs-save">${isNew ? "Add" : "Save"}</button>
      </div>
    </div>`);
  setTimeout(() => el.querySelector("#bs-label").select(), 30);
  el.querySelector("#bs-cancel").addEventListener("click", closeModal);
  el.querySelector("#bs-delete")?.addEventListener("click", async () => {
    const msg = count
      ? `Remove “${c.label}”? Its ${count} card${count === 1 ? "" : "s"} will show under “Unsorted” until you drag them into another section.`
      : `Remove “${c.label}”?`;
    if (!confirm(msg)) return;
    await deleteDoc(doc(db, "boardColumns", c.id)); toast("Section removed"); closeModal();
  });
  const save = async () => {
    const label = el.querySelector("#bs-label").value.trim();
    if (!label) { toast("Give the section a label"); return; }
    try {
      if (isNew) {
        await addDoc(collection(db, "boardColumns"), { label, order: cols.length, createdAt: serverTimestamp() });
      } else {
        const posEl = el.querySelector("#bs-pos");
        const newPos = posEl ? Number(posEl.value) : idx;
        const list = cols.filter((x) => x.id !== c.id);
        list.splice(Math.min(newPos, list.length), 0, { ...c, label });
        const batch = writeBatch(db);
        list.forEach((x, i) => batch.update(doc(db, "boardColumns", x.id), x.id === c.id ? { label, order: i } : { order: i }));
        await batch.commit();
      }
      toast("Saved"); closeModal();
    } catch (e) { toast("Couldn't save: " + (e.code || e.message)); }
  };
  el.querySelector("#bs-save").addEventListener("click", save);
  el.querySelector("#bs-label").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); save(); } });
}
