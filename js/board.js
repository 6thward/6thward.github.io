// Member Board — a card per person, sorted into sections you name yourself.
// Drag a card between sections (or up/down inside one). Sections can be
// added, renamed, reordered and removed. Data:
//   boardColumns/{id}  { label, order }
//   board/{id}         { name, notes, column, order, createdAt, updatedAt }
import { db } from "./firebase-init.js?v=1789311039";
import { ctx, can } from "./app.js?v=1789311039";
import {
  collection, onSnapshot, addDoc, updateDoc, deleteDoc, doc, serverTimestamp, writeBatch,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { toast, esc, openModal, closeModal } from "./ui.js?v=1789311039";

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
    if (!cols.length && editor && !seeding && !qs.metadata.fromCache) seedColumns();
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
  const cardHtml = (k) => `
    <div class="list-row call-card call-card-v board-card" data-id="${k.id}" style="background:#fff;border:1px solid var(--line);border-left:5px solid ${colColor(cols.findIndex((c) => c.id === k.column))}">
      <div class="row-title">${esc(k.name || "—")}</div>
      ${k.notes ? `<div class="row-sub board-note">${esc(k.notes)}</div>` : ""}
    </div>`;
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
    row.addEventListener("click", () => { const k = cards.find((x) => x.id === row.dataset.id); if (k) editCard(k); });
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
    <div class="modal-actions">
      ${!isNew && editor ? `<button class="btn btn-ghost btn-danger" id="bc-delete">Remove</button>` : "<span></span>"}
      <div style="display:flex;gap:.5rem">
        <button class="btn" id="bc-cancel">${editor ? "Cancel" : "Close"}</button>
        ${editor ? `<button class="btn btn-primary" id="bc-save">${isNew ? "Add" : "Save"}</button>` : ""}
      </div>
    </div>`);
  el.querySelector("#bc-cancel").addEventListener("click", closeModal);
  if (!editor) return;
  setTimeout(() => el.querySelector("#bc-name").focus(), 30);
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
