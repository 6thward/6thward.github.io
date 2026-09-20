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
import { db } from "./firebase-init.js?v=1789940722";
import { ctx, can } from "./app.js?v=1789940722";
import {
  collection, onSnapshot, updateDoc, setDoc, doc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { toast, esc, fmtDate } from "./ui.js?v=1789940722";

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
    else if (t.council && !t.done && !discussedOn && isNextAgenda(d)) fromBoard.push({ kind: "board", k, t, discussed: false }); // waiting for the next one
  }));
  const extra = ((councils[d] && councils[d].extra) || []).map((x) => ({ kind: "extra", x, discussed: !!x.discussed }));
  return [...fromBoard, ...extra];
}

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

  const noteBlock = (key, text, placeholder) => `<div class="wc-cnotes${text ? "" : " wc-cnotes-empty"}${editor ? " wc-cnotes-edit" : ""}" data-cnotes="${key}" title="${editor ? "Click to add notes" : ""}">${text ? esc(text) : (editor ? placeholder : "")}</div>`;
  const row = (it, n) => {
    const title = it.kind === "board" ? it.t.title : it.x.title;
    const person = it.kind === "board" ? it.k.name : "";
    const notes = it.kind === "board" ? it.t.councilNotes : it.x.notes;
    const context = it.kind === "board" && it.t.notes ? `<div class="wc-notes">${esc(it.t.notes)}</div>` : "";
    const due = it.kind === "board" && it.t.due ? `<span class="wc-due">due ${fmtDay(it.t.due)}</span>` : "";
    const key = it.kind === "board" ? `b:${it.k.id}:${it.t.id}` : `x:${it.x.id}`;
    const when = it.discussed ? (it.kind === "board" ? it.t.councilDiscussedAt : it.x.discussedAt) : "";
    return `
      <div class="wc-row${it.discussed ? " wc-done" : ""}" data-key="${key}">
        <div class="wc-num">${n}.</div>
        <div class="wc-main">
          <div class="wc-title">${person ? `<span class="wc-person-name">${esc(person)}</span> · ` : ""}${esc(title)}${due}</div>
          ${context}
          ${(editor || notes) ? noteBlock(key, notes, "+ council notes") : ""}
          ${it.discussed ? `<div class="row-sub">Discussed${when ? " " + fmtDay(when) : ""}${it.kind === "board" && it.t.councilDiscussedBy ? " · " + esc(it.t.councilDiscussedBy) : ""}</div>` : ""}
        </div>
        ${editor ? `<div class="wc-actions">
          ${it.discussed
            ? `<button class="btn btn-sm btn-ghost" data-act="reopen" title="Put it back on the agenda">↩</button>`
            : `<button class="btn btn-sm" data-act="discussed" title="Discussed — moves to this meeting's record${it.kind === "board" ? "; the to-do stays on the card" : ""}">Discussed ✓</button>
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

  // notes (per item or per meeting) — click to type, blur / ⌘Enter saves
  body.querySelectorAll("[data-cnotes]").forEach((el) => el.addEventListener("click", () => {
    if (el.parentElement.querySelector("textarea.wc-cnotes-ta")) return;
    const key = el.dataset.cnotes;
    const current = el.classList.contains("wc-cnotes-empty") ? "" : el.textContent;
    const ta = document.createElement("textarea");
    ta.className = "wc-cnotes-ta"; ta.value = current;
    ta.placeholder = key === "m" ? "Attendance, general discussion, assignments…" : "What was discussed, decided, who follows up…";
    el.replaceWith(ta);
    const grow = () => { ta.style.height = "auto"; ta.style.height = Math.max(64, ta.scrollHeight + 2) + "px"; };
    grow(); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
    let fin = false;
    const finish = async (save) => {
      if (fin) return; fin = true;
      const val = ta.value.trim();
      try {
        if (save && val !== current) {
          if (key === "m") await saveCouncil(date, { notes: val });
          else if (key.startsWith("x:")) await saveCouncil(date, { extra: (cdoc.extra || []).map((x) => (x.id === key.slice(2) ? { ...x, notes: val } : x)) });
          else { const [, cardId, todoId] = key.split(":"); const k = cards.find((c) => c.id === cardId); if (k) await saveTodoPatch(k, todoId, (t) => { t.councilNotes = val; }); }
          toast("Saved");
        }
      } catch (e) { toast("Couldn't save: " + (e.code || e.message)); }
      render();
    };
    ta.addEventListener("input", grow);
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); finish(false); }
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); finish(true); }
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
          if (act === "discussed") { t.council = false; t.councilDiscussedAt = date + "T12:00:00.000Z"; t.councilDiscussedBy = ctx.name || ""; }
          else if (act === "remove") { t.council = false; }
          else if (act === "reopen") { t.council = true; delete t.councilDiscussedAt; delete t.councilDiscussedBy; }
        });
      }
      toast(act === "discussed" ? "Marked discussed" : act === "reopen" ? "Back on the agenda" : "Removed");
    } catch (e) { toast("Couldn't save: " + (e.code || e.message)); }
  }));
}
