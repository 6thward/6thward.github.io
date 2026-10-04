// Ward Council — one agenda per meeting (weekly, on Sunday by default).
//
// Where items come from:
//   * Member Board to-dos flagged "Ward council" appear on the NEXT open
//     agenda automatically (source of truth stays on the board card:
//     todo.council / todo.councilDiscussedAt / todo.councilNotes).
//   * Free-form agenda items typed straight into a meeting.
// Per-meeting state lives in councils/{date}:
//   { date, extra: [{ id, title, notes, discussed, discussedAt }], notes }
// Marking a board item "Discussed" stamps the to-do with the agenda's date,
// so it shows on that meeting's page afterwards and drops off future ones.
import { db } from "./firebase-init.js?v=1791134746";
import { ctx, can } from "./app.js?v=1791134746";
import { notesHtml, toggleTodoLine, handleNoteKeys, toolbarHtml, wireToolbar } from "./notes.js?v=1791134746";
import {
  collection, onSnapshot, updateDoc, setDoc, doc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { toast, esc, fmtDate } from "./ui.js?v=1791134746";

let cards = [];
let councils = {};    // date -> doc
let date = "";        // selected meeting date (YYYY-MM-DD)
let started = false;

const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayIso = () => iso(new Date());
function upcomingSunday(from = new Date()) {
  const d = new Date(from); d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + ((7 - d.getDay()) % 7));
  return iso(d);
}
const shiftWeek = (isoDate, w) => { const d = new Date(isoDate + "T12:00:00"); d.setDate(d.getDate() + 7 * w); return iso(d); };
const fmtDay = (v) => (v ? fmtDate(String(v).slice(0, 10), { year: true }) : "");

export function initCouncil() {
  if (started) return;
  started = true;
  date = upcomingSunday();
  const panel = document.getElementById("panel-council");
  panel.innerHTML = `
    <div class="panel-head">
      <div>
        <h2>Ward Council</h2>
        <p class="panel-sub">An agenda for each meeting. Items flagged “Ward council” on the Member Board join the next agenda automatically.</p>
      </div>
    </div>
    <div class="hs-nav">
      <button class="btn btn-sm" id="wc-prev" title="Previous meeting">‹</button>
      <div class="hs-date" id="wc-date"></div>
      <button class="btn btn-sm" id="wc-next" title="Next meeting">›</button>
      <button class="btn btn-sm" id="wc-upcoming">Next council</button>
    </div>
    <div id="wc-body"><div class="empty-note">Loading…</div></div>`;
  panel.querySelector("#wc-prev").addEventListener("click", () => { date = shiftWeek(date, -1); render(); });
  panel.querySelector("#wc-next").addEventListener("click", () => { date = shiftWeek(date, 1); render(); });
  panel.querySelector("#wc-upcoming").addEventListener("click", () => { date = upcomingSunday(); render(); });
  onSnapshot(collection(db, "board"), (qs) => {
    cards = qs.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
    render();
  });
  onSnapshot(collection(db, "councils"), (qs) => {
    councils = {};
    qs.docs.forEach((d) => { councils[d.id] = d.data(); });
    render();
  });
}

// The next open agenda = the upcoming Sunday (or the selected date when it is
// today or later). Board items belong to it until they're discussed.
function isNextAgenda(d) { return d >= todayIso() && d === upcomingSunday(); }
function isFuture(d) { return d > upcomingSunday(); }

function itemsFor(d) {
  const fromBoard = [];
  cards.forEach((k) => (k.todos || []).forEach((t) => {
    if (t.done && !t.councilDiscussedAt) return;
    const discussedOn = t.councilDiscussedAt ? String(t.councilDiscussedAt).slice(0, 10) : "";
    if (discussedOn === d) fromBoard.push({ kind: "board", k, t, discussed: true });          // discussed at this meeting
    else if (t.council && !t.done && !discussedOn) {
      // waiting for the next council — unless it was moved to a later meeting (councilNotBefore, 2026-10-04)
      const nb = t.councilNotBefore || "";
      if (nb ? (d === nb || (isNextAgenda(d) && d >= nb)) : isNextAgenda(d)) fromBoard.push({ kind: "board", k, t, discussed: false });
    }
  }));
  const extra = ((councils[d] && councils[d].extra) || []).map((x) => ({ kind: "extra", x, discussed: !!x.discussed }));
  // drag-to-reorder (2026-10-04): the meeting's doc keeps the agenda order as a list of item keys
  const order = (councils[d] && councils[d].order) || [];
  const pos = (it) => { const i = order.indexOf(itemKey(it)); return i < 0 ? 1e6 : i; };
  return [...fromBoard, ...extra].map((it, i) => ({ it, i })).sort((a, b) => pos(a.it) - pos(b.it) || a.i - b.i).map((x) => x.it);
}
const itemKey = (it) => (it.kind === "board" ? `b:${it.k.id}:${it.t.id}` : `x:${it.x.id}`);

async function saveCouncil(d, patch) {
  const ref = doc(db, "councils", d);
  if (councils[d]) await updateDoc(ref, { ...patch, updatedAt: serverTimestamp() });
  else await setDoc(ref, { date: d, extra: [], notes: "", ...patch, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
}
async function saveTodoPatch(k, todoId, mut) {
  const todos = (k.todos || []).map((t) => ({ ...t }));
  const t = todos.find((x) => x.id === todoId); if (!t) return;
  mut(t);
  await updateDoc(doc(db, "board", k.id), { todos, updatedAt: serverTimestamp() });
}

function render() {
  const body = document.getElementById("wc-body");
  const dateEl = document.getElementById("wc-date");
  if (!body) return;
  const editor = can("council", "edit");
  const items = itemsFor(date);
  const open = items.filter((i) => !i.discussed);
  const done = items.filter((i) => i.discussed);
  const cdoc = councils[date] || {};
  const next = isNextAgenda(date);
  dateEl.textContent = fmtDay(date) + (next ? " · next council" : isFuture(date) ? " · upcoming" : "");

  // notes render with bullets ("- ") and to-do boxes ("[ ] "); the raw text is kept for the editor (2026-10-04)
  const rawNotes = new Map();
  const noteBlock = (key, text, placeholder) => {
    rawNotes.set(key, text || "");
    return `<div class="wc-cnotes${text ? "" : " wc-cnotes-empty"}${editor ? " wc-cnotes-edit" : ""}" data-cnotes="${key}" title="${editor ? "Click to add notes" : ""}">${text ? notesHtml(text, key, editor) : (editor ? placeholder : "")}</div>`;
  };
  const row = (it, n) => {
    const title = it.kind === "board" ? it.t.title : it.x.title;
    const person = it.kind === "board" ? it.k.name : "";
    const notes = it.kind === "board" ? it.t.councilNotes : it.x.notes;
    const context = it.kind === "board" && it.t.notes ? `<div class="wc-notes">${esc(it.t.notes)}</div>` : "";
    const due = it.kind === "board" && it.t.due ? `<span class="wc-due">due ${fmtDay(it.t.due)}</span>` : "";
    const key = itemKey(it);
    const when = it.discussed ? (it.kind === "board" ? it.t.councilDiscussedAt : it.x.discussedAt) : "";
    return `
      <div class="wc-row${it.discussed ? " wc-done" : ""}${editor && !it.discussed ? " wc-drag" : ""}" data-key="${key}">
        <div class="wc-num${editor && !it.discussed ? " wc-grip" : ""}"${editor && !it.discussed ? ` draggable="true" title="Drag to reorder"` : ""}>${editor && !it.discussed ? `<span class="wc-grip-dots" aria-hidden="true">⋮⋮</span>` : ""}${n}.</div>
        <div class="wc-main">
          <div class="wc-title">${person ? `<span class="wc-person-name">${esc(person)}</span> · ` : ""}${esc(title)}${due}</div>
          ${context}
          ${(editor || notes) ? noteBlock(key, notes, "+ council notes") : ""}
          ${it.discussed ? `<div class="row-sub">Discussed${when ? " " + fmtDay(when) : ""}${it.kind === "board" && it.t.councilDiscussedBy ? " · " + esc(it.t.councilDiscussedBy) : ""}</div>` : ""}
        </div>
        ${editor ? `<div class="wc-actions">
          ${it.discussed
            ? `<button class="btn btn-sm btn-ghost" data-act="reopen" title="Put it back on the agenda">↩</button>`
            : `<button class="btn btn-sm btn-ghost wc-nextwk" data-next="1" title="Carry this item to next week's agenda (${fmtDay(shiftWeek(date, 1))})">→ Next week</button>
               <button class="btn btn-sm" data-act="discussed" title="Discussed — moves to this meeting's record${it.kind === "board" ? "; the to-do stays on the card" : ""}">Discussed ✓</button>
               <button class="btn btn-sm btn-ghost" data-act="remove" title="${it.kind === "board" ? "Take off the agenda (unflags the to-do)" : "Delete this agenda item"}">✕</button>`}
        </div>` : ""}
      </div>`;
  };

  body.innerHTML = `
    <div class="card">
      <h3 style="margin:0 0 .2rem;display:flex;align-items:center;gap:.5rem">Agenda <span class="pill ${open.length ? "pill-approved" : "pill-role-member"}">${open.length}</span>
        ${done.length ? `<span class="row-sub" style="font-weight:400">· ${done.length} discussed</span>` : ""}
        ${!next && !isFuture(date) ? `<span class="row-sub" style="margin-left:auto;font-weight:400">Past meeting — record only</span>` : ""}
        ${isFuture(date) ? `<span class="row-sub" style="margin-left:auto;font-weight:400">Board items join once this becomes the next council</span>` : ""}
      </h3>
      <div class="wc-list">
        ${open.length ? open.map((it, i) => row(it, i + 1)).join("") : `<div class="empty-note" style="padding:.7rem">${next ? "Nothing on the agenda yet." : "No open items."}</div>`}
      </div>
      ${editor ? `<div class="wc-add"><input class="wc-new" placeholder="+ Add an agenda item and press Enter" autocomplete="off"></div>` : ""}
      ${done.length ? `<details class="wc-hist" open><summary>Discussed at this meeting (${done.length})</summary>${done.map((it, i) => row(it, open.length + i + 1)).join("")}</details>` : ""}
    </div>
    <div class="card" style="margin-top:.8rem">
      <h3 style="margin:0 0 .3rem">Meeting notes</h3>
      ${noteBlock("m", cdoc.notes || "", "+ general notes for this meeting")}
    </div>`;

  if (!editor) return;

  // drag an open agenda item onto another to move it there
  let dragKey = null;
  const openRows = [...body.querySelectorAll(".wc-list > .wc-row.wc-drag")];
  const clearMarks = () => body.querySelectorAll(".wc-before, .wc-after").forEach((r) => r.classList.remove("wc-before", "wc-after"));
  openRows.forEach((rowEl) => {
    // only the numbered grip on the left starts a drag, so the text in the row
    // can still be selected, copied and pasted normally (2026-10-04)
    const grip = rowEl.querySelector(".wc-grip");
    grip?.addEventListener("dragstart", (e) => {
      dragKey = rowEl.dataset.key; rowEl.classList.add("wc-dragging");
      e.dataTransfer.effectAllowed = "move";
      try { e.dataTransfer.setData("text/plain", ""); e.dataTransfer.setDragImage(rowEl, 16, 16); } catch { /* older browsers */ }
    });
    grip?.addEventListener("dragend", () => { dragKey = null; rowEl.classList.remove("wc-dragging"); clearMarks(); });
    rowEl.addEventListener("dragover", (e) => {
      if (!dragKey || rowEl.dataset.key === dragKey) return;
      e.preventDefault();
      const r = rowEl.getBoundingClientRect();
      clearMarks(); rowEl.classList.add(e.clientY > r.top + r.height / 2 ? "wc-after" : "wc-before");
    });
    rowEl.addEventListener("drop", async (e) => {
      if (!dragKey || rowEl.dataset.key === dragKey) return;
      e.preventDefault();
      const r = rowEl.getBoundingClientRect();
      const after = e.clientY > r.top + r.height / 2;
      const keys = openRows.map((x) => x.dataset.key).filter((k) => k !== dragKey);
      keys.splice(keys.indexOf(rowEl.dataset.key) + (after ? 1 : 0), 0, dragKey);
      dragKey = null; clearMarks();
      try { await saveCouncil(date, { order: keys }); } catch (err) { toast("Couldn't save the order: " + (err.code || err.message)); }
    });
  });

  const saveNote = async (key, val) => {
    if (key === "m") await saveCouncil(date, { notes: val });
    else if (key.startsWith("x:")) await saveCouncil(date, { extra: (cdoc.extra || []).map((x) => (x.id === key.slice(2) ? { ...x, notes: val } : x)) });
    else { const [, cardId, todoId] = key.split(":"); const k = cards.find((c) => c.id === cardId); if (k) await saveTodoPatch(k, todoId, (t) => { t.councilNotes = val; }); }
  };
  // to-do boxes tick in place — no need to open the editor
  body.querySelectorAll("[data-todo-line]").forEach((cb) => {
    cb.addEventListener("click", (e) => e.stopPropagation());
    cb.closest("label")?.addEventListener("click", (e) => e.stopPropagation());
    cb.addEventListener("change", async () => {
      const cut = cb.dataset.todoLine.lastIndexOf("|");
      const key = cb.dataset.todoLine.slice(0, cut), idx = Number(cb.dataset.todoLine.slice(cut + 1));
      try { await saveNote(key, toggleTodoLine(rawNotes.get(key) || "", idx)); } catch (e) { toast("Couldn't save: " + (e.code || e.message)); }
      render();
    });
  });

  // notes (per item or per meeting) — click to type, blur / ⌘Enter saves
  body.querySelectorAll("[data-cnotes]").forEach((el) => el.addEventListener("click", () => {
    if (el.parentElement.querySelector("textarea.wc-cnotes-ta")) return;
    const key = el.dataset.cnotes;
    const current = rawNotes.get(key) || "";
    const ta = document.createElement("textarea");
    ta.className = "wc-cnotes-ta"; ta.value = current;
    ta.placeholder = key === "m" ? "Attendance, general discussion, assignments…" : "What was discussed, decided, who follows up…";
    // • Bullet / ☐ To-do buttons above the box; mousedown is cancelled so the box keeps focus
    const tools = document.createElement("div");
    tools.className = "wc-tools";
    tools.innerHTML = toolbarHtml("Tab makes a sub-point · click away to save");
    wireToolbar(tools, ta);
    el.replaceWith(ta);
    ta.before(tools);
    const grow = () => { ta.style.height = "auto"; ta.style.height = Math.max(64, ta.scrollHeight + 2) + "px"; };
    grow(); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
    let fin = false;
    const finish = async (save) => {
      if (fin) return; fin = true;
      const val = ta.value.trim();
      try {
        if (save && val !== current.trim()) { await saveNote(key, val); toast("Saved"); }
      } catch (e) { toast("Couldn't save: " + (e.code || e.message)); }
      render();
    };
    ta.addEventListener("input", grow);
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); finish(false); }
      else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); finish(true); }
      else handleNoteKeys(ta, e);
    });
    ta.addEventListener("blur", () => setTimeout(() => finish(true), 80));
  }));

  // add a free-form item
  const inp = body.querySelector(".wc-new");
  if (inp) {
    const add = async () => {
      const title = inp.value.trim(); if (!title) return;
      inp.value = "";
      const extra = [...(cdoc.extra || []), { id: "a" + Math.random().toString(36).slice(2, 9), title, notes: "", discussed: false, createdAt: new Date().toISOString(), by: ctx.name || "" }];
      try { await saveCouncil(date, { extra }); } catch (e) { toast("Couldn't save: " + (e.code || e.message)); }
      setTimeout(() => body.querySelector(".wc-new")?.focus(), 60);
    };
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); add(); } });
    inp.addEventListener("blur", () => { if (inp.value.trim()) add(); });
  }

  // "→ Next week": move the item to next week's agenda, or put a copy there (2026-10-04)
  body.querySelectorAll(".wc-row [data-next]").forEach((b) => b.addEventListener("click", () => {
    const rowEl = b.closest(".wc-row"), key = rowEl.dataset.key;
    const nextDate = shiftWeek(date, 1);
    const isBoard = key.startsWith("b:");
    const box = document.createElement("span");
    box.className = "wc-nextwk-box";
    box.innerHTML = `<span class="row-sub">To ${fmtDay(nextDate)}:</span><button class="btn btn-sm btn-primary" data-go="move" type="button" title="Take it off this agenda and put it on next week's">Move</button>${isBoard ? "" : `<button class="btn btn-sm" data-go="copy" type="button" title="Leave it here and add a copy to next week's agenda">Copy</button>`}<button class="btn btn-sm btn-ghost" data-go="cancel" type="button">Cancel</button>`;
    b.replaceWith(box);
    box.querySelector('[data-go="cancel"]').addEventListener("click", () => render());
    const go = async (mode) => {
      try {
        if (isBoard) {
          // a Member Board item just waits for a later meeting
          const [, cardId, todoId] = key.split(":");
          const k = cards.find((c) => c.id === cardId); if (!k) return;
          await saveTodoPatch(k, todoId, (t) => { t.council = true; t.councilNotBefore = nextDate; });
        } else {
          const id = key.slice(2);
          const item = (cdoc.extra || []).find((x) => x.id === id); if (!item) return;
          const copy = { ...item, id: "a" + Math.random().toString(36).slice(2, 9), discussed: false, discussedAt: "", carriedFrom: date, createdAt: new Date().toISOString(), by: ctx.name || "" };
          const nextDoc = councils[nextDate] || {};
          await saveCouncil(nextDate, { extra: [...(nextDoc.extra || []), copy] });
          if (mode === "move") await saveCouncil(date, { extra: (cdoc.extra || []).filter((x) => x.id !== id), order: (cdoc.order || []).filter((o) => o !== key) });
        }
        toast(mode === "move" ? `Moved to ${fmtDay(nextDate)}` : `Copied to ${fmtDay(nextDate)}`);
      } catch (e) { toast("Couldn't save: " + (e.code || e.message)); render(); }
    };
    box.querySelector('[data-go="move"]').addEventListener("click", () => go("move"));
    box.querySelector('[data-go="copy"]')?.addEventListener("click", () => go("copy"));
  }));

  // row actions
  body.querySelectorAll(".wc-row [data-act]").forEach((b) => b.addEventListener("click", async () => {
    const key = b.closest(".wc-row").dataset.key;
    const act = b.dataset.act;
    try {
      if (key.startsWith("x:")) {
        const id = key.slice(2);
        let extra = cdoc.extra || [];
        if (act === "remove") { if (!confirm("Delete this agenda item?")) return; extra = extra.filter((x) => x.id !== id); }
        else extra = extra.map((x) => (x.id === id ? { ...x, discussed: act === "discussed", discussedAt: act === "discussed" ? new Date().toISOString() : "" } : x));
        await saveCouncil(date, { extra });
      } else {
        const [, cardId, todoId] = key.split(":");
        const k = cards.find((c) => c.id === cardId); if (!k) return;
        await saveTodoPatch(k, todoId, (t) => {
          if (act === "discussed") { t.council = false; t.councilDiscussedAt = date + "T12:00:00.000Z"; t.councilDiscussedBy = ctx.name || ""; delete t.councilNotBefore; }
          else if (act === "remove") { t.council = false; delete t.councilNotBefore; }
          else if (act === "reopen") { t.council = true; delete t.councilDiscussedAt; delete t.councilDiscussedBy; }
        });
      }
      toast(act === "discussed" ? "Marked discussed" : act === "reopen" ? "Back on the agenda" : "Removed");
    } catch (e) { toast("Couldn't save: " + (e.code || e.message)); }
  }));
}
