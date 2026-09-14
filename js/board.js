// Member Board — a card per person, sorted into sections you name yourself.
// Drag a card between sections (or up/down inside one). Sections can be
// added, renamed, reordered and removed. Data:
//   boardColumns/{id}  { label, order }
//   board/{id}         { name, notes, column, order, createdAt, updatedAt }
import { db } from "./firebase-init.js?v=1789346990";
import { ctx, can } from "./app.js?v=1789346990";
import {
  collection, onSnapshot, addDoc, updateDoc, deleteDoc, doc, serverTimestamp, writeBatch,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { toast, esc, openModal, closeModal } from "./ui.js?v=1789346990";

const PALETTE = ["#1f4e79", "#5b4b9e", "#2e7d4f", "#a8720d", "#b3402f", "#0e7490", "#7a5a14", "#5b6675"];
const DEFAULT_COLUMNS = ["Ideas", "Talking to", "Settled"];

let cols = [];
let cards = [];
let started = false;
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
    <div class="list-row call-card call-card-v board-card" data-id="${k.id}" style="background:#fff;border:1px solid var(--line);border-left:5px solid ${colColor(cols.findIndex((c) => c.id === k.column))}">
      <div class="row-title">${esc(k.name || "—")}</div>
      ${k.notes ? `<div class="row-sub board-note">${esc(k.notes)}</div>` : ""}
      ${open.length ? `<div class="todo-pills">${open.map((t) => todoPill(k, t)).join("")}</div>` : ""}
    </div>`;
  };
  wrap.innerHTML = `<div class="bishopric-board member-board" style="grid-template-columns:repeat(${Math.min(cols.length, 4)}, minmax(0,1fr))">` +
    cols.map((c, i) => {
      const rows = cards.filter((k) => k.column === c.id);
      return `
      <div class="card bb-col" style="margin-top:.8rem;border-top:4px solid ${colColor(i)}">
        <h3 style="display:flex;align-items:center;gap:.5rem;min-width:0">
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
    row.addEventListener("click", (e) => {
      const k = cards.find((x) => x.id === row.dataset.id);
      if (!k) return;
      const pill = e.target.closest(".todo-pill");
      if (pill) { e.stopPropagation(); const t = (k.todos || []).find((x) => x.id === pill.dataset.todo); if (t) editTodo(k, t); return; }
      editCard(k);
    });
  });
  if (!editor) return;
  wrap.querySelectorAll("[data-addto]").forEach((b) => b.addEventListener("click", () => editCard(null, b.dataset.addto)));
  wrap.querySelectorAll(".board-col-label").forEach((l) => l.addEventListener("click", () => editSection(cols.find((c) => c.id === l.dataset.col))));

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
    zone.addEventListener("dragover", (e) => { if (!dragId) return; e.preventDefault(); zone.classList.add("bb-over"); });
    zone.addEventListener("dragleave", () => zone.classList.remove("bb-over"));
    zone.addEventListener("drop", async (e) => {
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
  return `<span class="todo-pill${st ? " todo-" + st : ""}" data-todo="${t.id}" title="${esc(t.notes ? t.notes : "Click for notes")}">${esc(t.title)}${t.due ? `<span class="todo-due">${st === "overdue" ? "⚠ " : ""}${fmtDue(t.due)}</span>` : ""}</span>`;
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
      <div style="display:flex;gap:.4rem">
        ${editor ? `<button class="btn btn-ghost btn-danger" id="td-delete">Delete</button>` : ""}
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
      <label class="field full"><span>Notes</span><textarea id="bc-notes" ${editor ? "" : "disabled"} placeholder="Anything worth remembering — optional">${esc(k?.notes || "")}</textarea></label>
    </div>
    ${!isNew ? `<h4 style="margin:1rem 0 .3rem">To-dos <span class="row-sub" style="font-weight:400">· top = highest priority · ✓ archives</span></h4><div id="bc-todos">${todoListHtml(k)}</div>` : ""}
    <div class="modal-actions">
      ${!isNew && editor ? `<button class="btn btn-ghost btn-danger" id="bc-delete">Remove</button>` : "<span></span>"}
      <div style="display:flex;gap:.5rem">
        <button class="btn" id="bc-cancel">${editor ? "Cancel" : "Close"}</button>
        ${editor ? `<button class="btn btn-primary" id="bc-save">${isNew ? "Add" : "Save"}</button>` : ""}
      </div>
    </div>`);
  el.querySelector("#bc-cancel").addEventListener("click", closeModal);
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
    if (!name) { toast("Enter a name"); return; }
    try {
      if (isNew) {
        const order = cards.filter((x) => x.column === column).length;
        await addDoc(collection(db, "board"), { name, notes, column, order, createdAt: serverTimestamp(), updatedAt: serverTimestamp(), createdBy: ctx.name || "" });
        toast(`${name} added`);
      } else {
        const patch = { name, notes, updatedAt: serverTimestamp() };
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
