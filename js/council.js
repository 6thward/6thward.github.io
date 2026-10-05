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
import { db } from "./firebase-init.js?v=1791220462";
import { ctx, can } from "./app.js?v=1791220462";
import { notesHtml, toggleTodoLine, handleNoteKeys, toolbarHtml, wireToolbar, lineWho, setLineWho, plainLine } from "./notes.js?v=1791220462";
import { uploadAttachment, openAttachment, deleteAttachment, fmtBytes, fileIcon, MAX_ATTACH_BYTES, ATTACH_ACCEPT } from "./files.js?v=1791220462";
import {
  collection, onSnapshot, updateDoc, setDoc, doc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { toast, esc, fmtDate, openModal, closeModal } from "./ui.js?v=1791220462";

let cards = [];
let councils = {};    // date -> doc
let members = [];     // names of ward council members (Users tab → "Ward council member")
// what a council member can be asked to do at a meeting (2026-10-04)
const ASSIGN = [["openPrayer", "Opening prayer"], ["thought", "Scripture & thought"], ["training", "Handbook training"], ["closePrayer", "Closing prayer"]];
let schedule = [];    // council dates (Sundays) set by the bishopric — councils/_dates.dates; empty = every Sunday
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
  let positioned = false; // jump to the next scheduled council once the dates have loaded
  const panel = document.getElementById("panel-council");
  panel.innerHTML = `
    <div class="panel-head">
      <div>
        <h2>Ward Council <button type="button" class="wc-info" aria-label="About this page" data-tip="An agenda for each meeting. Items flagged “Ward council” on the Member Board join the next agenda automatically.">*</button></h2>
      </div>
    </div>
    <div class="hs-nav">
      <button class="btn btn-sm" id="wc-prev" title="Previous meeting">‹</button>
      <div class="hs-date wc-date" id="wc-date"></div>
      <button class="btn btn-sm" id="wc-next" title="Next meeting">›</button>
      ${can("council", "edit") ? `<button class="btn btn-sm" id="wc-dates" title="Choose which Sundays have ward council">📅 Council dates</button>` : ""}
    </div>
    <div id="wc-body"><div class="empty-note">Loading…</div></div>`;
  panel.querySelector("#wc-prev").addEventListener("click", () => { date = stepDate(date, -1); render(); });
  panel.querySelector("#wc-next").addEventListener("click", () => { date = stepDate(date, 1); render(); });
  panel.querySelector("#wc-dates")?.addEventListener("click", editDates);
  onSnapshot(collection(db, "users"), (qs) => {
    const names = qs.docs.map((d) => d.data()).filter((u) => u.councilMember && !u.revoked && !u.alias && u.name).map((u) => u.name.trim());
    members = [...new Set(names)].sort((a, b) => a.localeCompare(b));
    render();
  }, () => {});
  onSnapshot(collection(db, "board"), (qs) => {
    cards = qs.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
    render();
    }, () => {}); // council members without the Member Board page just don't get its items
  onSnapshot(collection(db, "councils"), (qs) => {
    councils = {};
    schedule = [];
    qs.docs.forEach((d) => {
      if (d.id === "_dates") schedule = [...new Set((d.data().dates || []).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)))].sort();
      else councils[d.id] = d.data();
    });
    if (!positioned) { positioned = true; date = nextCouncil(); }
    render();
  });
}

// ---- choose the council Sundays ----
function editDates() {
  const start = upcomingSunday();
  const sundays = Array.from({ length: 40 }, (_, i) => shiftWeek(start, i)); // ~9 months ahead
  const chosen = new Set(schedule.filter((d) => d >= start));
  const past = schedule.filter((d) => d < start);
  const nth = (d) => Math.ceil(new Date(d + "T12:00:00").getDate() / 7);
  const monthKey = (d) => d.slice(0, 7);
  const months = [...new Set(sundays.map(monthKey))];
  const el = openModal(`
    <h3>Ward council dates</h3>
    <p class="row-sub" style="margin:0 0 .6rem">Tick the Sundays that have ward council. Agendas exist only for those weeks, and flagged Member Board items wait for the next one.${hasSchedule() ? "" : " Nothing is chosen yet, so every Sunday currently counts."}</p>
    <div class="wcd-quick">
      <span class="row-sub">Quick pick:</span>
      <button class="btn btn-sm" type="button" data-pat="1,3">1st &amp; 3rd</button>
      <button class="btn btn-sm" type="button" data-pat="2,4">2nd &amp; 4th</button>
      <button class="btn btn-sm" type="button" data-pat="1">1st only</button>
      <button class="btn btn-sm" type="button" data-pat="1,2,3,4,5">Every Sunday</button>
      <button class="btn btn-sm btn-ghost" type="button" data-pat="">Clear</button>
    </div>
    <div class="wcd-months">
      ${months.map((mk) => `
        <div class="wcd-month">
          <div class="wcd-month-name">${new Date(mk + "-15T12:00:00").toLocaleDateString("en-US", { month: "long", year: "numeric" })}</div>
          <div class="wcd-days">${sundays.filter((d) => monthKey(d) === mk).map((d) => `<button type="button" class="wcd-day${chosen.has(d) ? " on" : ""}" data-d="${d}" data-nth="${nth(d)}" title="${fmtDay(d)}">${Number(d.slice(8))}<span>${["", "1st", "2nd", "3rd", "4th", "5th"][nth(d)]}</span></button>`).join("")}</div>
        </div>`).join("")}
    </div>
    <div class="modal-actions">
      <span class="row-sub" id="wcd-count"></span>
      <div class="right"><button class="btn" id="wcd-cancel">Cancel</button><button class="btn btn-primary" id="wcd-save">Save dates</button></div>
    </div>`);
  const count = () => { el.querySelector("#wcd-count").textContent = `${el.querySelectorAll(".wcd-day.on").length} council Sundays chosen`; };
  count();
  el.querySelectorAll(".wcd-day").forEach((b) => b.addEventListener("click", () => { b.classList.toggle("on"); count(); }));
  el.querySelectorAll("[data-pat]").forEach((b) => b.addEventListener("click", () => {
    const want = new Set(b.dataset.pat.split(",").filter(Boolean));
    el.querySelectorAll(".wcd-day").forEach((d) => d.classList.toggle("on", want.has(d.dataset.nth)));
    count();
  }));
  el.querySelector("#wcd-cancel").addEventListener("click", closeModal);
  el.querySelector("#wcd-save").addEventListener("click", async () => {
    const dates = [...past, ...[...el.querySelectorAll(".wcd-day.on")].map((b) => b.dataset.d)].sort();
    try {
      await setDoc(doc(db, "councils", "_dates"), { dates, updatedAt: serverTimestamp(), updatedBy: ctx.name || "" });
      schedule = dates; date = nextCouncil();
      toast(dates.length ? "Council dates saved" : "Cleared — every Sunday counts again"); closeModal(); render();
    } catch (e) { toast("Couldn't save: " + (e.code || e.message)); }
  });
}

// Council dates (2026-10-04). The ward chooses which Sundays have ward
// council (councils/_dates.dates); agendas exist only for those. With no
// dates chosen yet, every Sunday counts, as before.
const hasSchedule = () => schedule.length > 0;
// the next council on or after a day (today by default)
function nextCouncil(from = todayIso()) {
  if (!hasSchedule()) return upcomingSunday(new Date(from + "T12:00:00"));
  return schedule.find((d) => d >= from) || upcomingSunday(new Date(from + "T12:00:00"));
}
// every date the ‹ › arrows can land on: scheduled councils + any meeting that already has a record
function navDates() {
  const set = new Set(schedule);
  Object.keys(councils).forEach((d) => { if (/^\d{4}-\d{2}-\d{2}$/.test(d)) set.add(d); });
  return [...set].sort();
}
function stepDate(d, dir) {
  if (!hasSchedule()) return shiftWeek(d, dir);
  const all = navDates();
  const later = all.filter((x) => x > d), earlier = all.filter((x) => x < d);
  return dir > 0 ? (later[0] || d) : (earlier[earlier.length - 1] || d);
}
// councils after a given one — targets for "copy / move to…"
function councilsAfter(d, n = 12) {
  if (hasSchedule()) return schedule.filter((x) => x > d).slice(0, n);
  return Array.from({ length: 8 }, (_, i) => shiftWeek(d, i + 1));
}

// The next open agenda = the next council on or after today. Board items
// belong to it until they're discussed.
function isNextAgenda(d) { return d >= todayIso() && d === nextCouncil(); }
function isFuture(d) { return d > nextCouncil(); }

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

// A small "who?" pop-up under a chip: council members to pick from, or type any name.
// onPick(name) — "" clears. Clicking away keeps what was typed; Escape cancels.
function pickName(anchor, current, onPick) {
  document.querySelector(".wc-who-pop")?.remove();
  const r = anchor.getBoundingClientRect();
  const pop = document.createElement("div");
  pop.className = "wc-who-pop";
  pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 268)) + window.scrollX + "px";
  pop.style.top = r.bottom + 4 + window.scrollY + "px";
  pop.innerHTML = `<input class="wc-who-in" placeholder="Pick or type any name" value="${esc(current)}" autocomplete="off">
    <div class="wc-who-list"></div>
    ${current ? `<button type="button" class="wc-who-clear">✕ Remove assignment</button>` : ""}`;
  document.body.appendChild(pop);
  const inp = pop.querySelector("input"), list = pop.querySelector(".wc-who-list");
  let sel = -1, typed = false, closed = false;
  const draw = () => {
    const q = typed ? inp.value.trim().toLowerCase() : "";
    const rows = members.filter((n) => !q || n.toLowerCase().includes(q));
    list.innerHTML = rows.map((n) => `<div class="wc-asg-opt${n.toLowerCase() === current.toLowerCase() ? " cur" : ""}" data-name="${esc(n)}"><span>${esc(n)}</span></div>`).join("")
      || `<div class="row-sub" style="padding:.35rem .6rem">${members.length ? "Press Enter to use this name" : "Type a name and press Enter"}</div>`;
    sel = -1;
  };
  const finish = (name) => {
    if (closed) return; closed = true;
    document.removeEventListener("mousedown", away, true);
    pop.remove();
    if (name !== null && name.trim() !== current) onPick(name.trim());
  };
  const away = (e) => { if (!pop.contains(e.target)) finish(typed ? inp.value : null); };
  const mark = () => list.querySelectorAll(".wc-asg-opt").forEach((o, i) => o.classList.toggle("sel", i === sel));
  inp.addEventListener("input", () => { typed = true; draw(); });
  inp.addEventListener("keydown", (e) => {
    const opts = [...list.querySelectorAll(".wc-asg-opt")];
    if (e.key === "ArrowDown" && opts.length) { e.preventDefault(); sel = (sel + 1) % opts.length; mark(); opts[sel].scrollIntoView({ block: "nearest" }); }
    else if (e.key === "ArrowUp" && opts.length) { e.preventDefault(); sel = (sel - 1 + opts.length) % opts.length; mark(); opts[sel].scrollIntoView({ block: "nearest" }); }
    else if (e.key === "Enter") { e.preventDefault(); finish(sel >= 0 && opts[sel] ? opts[sel].dataset.name : inp.value); }
    else if (e.key === "Escape") { e.preventDefault(); finish(null); }
  });
  list.addEventListener("mousedown", (e) => { const o = e.target.closest(".wc-asg-opt"); if (o) { e.preventDefault(); finish(o.dataset.name); } });
  pop.querySelector(".wc-who-clear")?.addEventListener("click", () => finish(""));
  setTimeout(() => document.addEventListener("mousedown", away, true), 0);
  draw(); inp.focus(); inp.select();
}

// who last had an assignment before a given meeting: lowercased name -> { name, date }
function lastAssigned(k, before) {
  const out = new Map();
  Object.keys(councils).filter((d) => d < before).sort().forEach((d) => {
    const n = String(councils[d].assign?.[k] || "").trim();
    if (n) out.set(n.toLowerCase(), { name: n, date: d });
  });
  return out;
}
const shortDay = (d) => new Date(d + "T12:00:00").toLocaleDateString("en-US", d.slice(0, 4) === String(new Date().getFullYear()) ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });

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
  dateEl.textContent = fmtDay(date) + (hasSchedule() && !schedule.includes(date) ? " · not a council week" : "");

  // notes render with bullets ("- ") and to-do boxes ("[ ] "); the raw text is kept for the editor (2026-10-04)
  const rawNotes = new Map();
  const noteBlock = (key, text, placeholder) => {
    rawNotes.set(key, text || "");
    return `<div class="wc-cnotes${text ? "" : " wc-cnotes-empty"}${editor ? " wc-cnotes-edit" : ""}" data-cnotes="${key}" title="${editor ? "Click to add notes" : ""}">${text ? notesHtml(text, key, editor, null, { assign: true }) : (editor ? placeholder : "")}</div>`;
  };
  const row = (it, n) => {
    const title = it.kind === "board" ? it.t.title : it.x.title;
    const person = it.kind === "board" ? it.k.name : "";
    const notes = it.kind === "board" ? it.t.councilNotes : it.x.notes;
    const context = it.kind === "board" && it.t.notes ? `<div class="wc-notes">${esc(it.t.notes)}</div>` : "";
    // due date on any item (2026-10-04): a Member Board item uses its to-do's deadline
    const dueVal = (it.kind === "board" ? it.t.due : it.x.due) || "";
    const overdue = dueVal && !it.discussed && dueVal < todayIso();
    const due = dueVal
      ? `<span class="wc-due${overdue ? " wc-overdue" : ""}${editor ? " wc-due-edit" : ""}"${editor ? ` data-due="${dueVal}" title="Click to change the due date"` : ""}>${overdue ? "⚠ " : ""}due ${fmtDay(dueVal)}</span>`
      : (editor && !it.discussed ? `<span class="wc-due wc-due-add wc-due-edit" data-due="" title="Add a due date">+ due date</span>` : "");
    const key = itemKey(it);
    const when = it.discussed ? (it.kind === "board" ? it.t.councilDiscussedAt : it.x.discussedAt) : "";
    const files = (it.kind === "board" ? it.t.councilFiles : it.x.files) || [];
    // who brought the item (2026-10-04): the council member who added it, or whoever it's reassigned to
    const ownerName = it.kind === "board" ? (it.t.councilOwner || "") : (it.x.owner || it.x.by || "");
    const owner = ownerName
      ? `<span class="wc-owner${editor ? " wc-owner-edit" : ""}"${editor ? ` data-owner="${esc(ownerName)}" title="Owner — click to change"` : ' title="Owner"'}>👤 ${esc(ownerName)}</span>`
      : (editor && !it.discussed ? `<span class="wc-owner wc-owner-add wc-owner-edit" data-owner="" title="Give this item an owner">+ owner</span>` : "");
    // who the item is assigned to (2026-10-04): a council member or anyone else
    const asgName = (it.kind === "board" ? it.t.councilAssignee : it.x.assignee) || "";
    const assignee = asgName
      ? `<span class="wc-assignee${editor ? " wc-assignee-edit" : ""}"${editor ? ` data-assignee="${esc(asgName)}" title="Assigned to — click to change"` : ' title="Assigned to"'}>→ ${esc(asgName)}</span>`
      : (editor && !it.discussed ? `<span class="wc-assignee wc-assignee-add wc-assignee-edit" data-assignee="" title="Assign this item to someone">+ assign</span>` : "");
    const actions = editor ? `<div class="wc-actions">
          ${it.discussed
            ? `<button class="btn btn-sm btn-ghost" data-act="reopen" title="Put it back on the agenda">↩</button>`
            : `<button class="btn btn-sm btn-ghost" data-attach="1" type="button" title="Attach a document, PDF or image">📎 Attach</button>
               <span class="wc-act-wrap"><button class="btn btn-sm btn-ghost wc-act-btn" data-actions="1" type="button" title="Copy or move this item to another council">Actions ▾</button></span>
               <button class="btn btn-sm" data-act="discussed" title="Discussed — moves to this meeting's record${it.kind === "board" ? "; the to-do stays on the card" : ""}">Discussed ✓</button>
               <button class="btn btn-sm btn-ghost" data-act="remove" title="${it.kind === "board" ? "Take off the agenda (unflags the to-do)" : "Delete this agenda item"}">✕</button>`}
        </div>` : "";
    return `
      <div class="wc-row${it.discussed ? " wc-done" : ""}${editor && !it.discussed ? " wc-drag" : ""}" data-key="${key}">
        <div class="wc-num${editor && !it.discussed ? " wc-grip" : ""}"${editor && !it.discussed ? ` draggable="true" title="Drag to reorder"` : ""}>${editor && !it.discussed ? `<span class="wc-grip-dots" aria-hidden="true">⋮⋮</span>` : ""}${n}.</div>
        <div class="wc-main">
          <div class="wc-head"><div class="wc-title">${person ? `<span class="wc-person-name">${esc(person)}</span> · ` : ""}${esc(title)}${owner}${assignee}${due}</div>${actions}</div>
          ${context}
          ${(editor || notes) ? noteBlock(key, notes, "+ council notes") : ""}
          ${files.length ? `<div class="wc-files">${files.map((f) => `<span class="wc-file" data-file="${esc(f.id)}" title="Open ${esc(f.name)}"><span class="wc-file-ic">${fileIcon(f)}</span><span class="wc-file-name">${esc(f.name)}</span><span class="wc-file-size">${fmtBytes(f.size)}</span>${editor ? `<button type="button" class="wc-file-x" data-rmfile="${esc(f.id)}" title="Remove this attachment">✕</button>` : ""}</span>`).join("")}</div>` : ""}
          <div class="wc-upload" hidden></div>
          ${it.discussed ? `<div class="row-sub">Discussed${when ? " " + fmtDay(when) : ""}${it.kind === "board" && it.t.councilDiscussedBy ? " · " + esc(it.t.councilDiscussedBy) : ""}</div>` : ""}
        </div>
      </div>`;
  };

  const asg = cdoc.assign || {};
  const assignCard = `
    <div class="card wc-assign-card">
      <h3 style="margin:0 0 .4rem">Assignments</h3>
      <div class="wc-assign">
        ${ASSIGN.map(([k, l]) => `<label class="wc-asg"><span>${esc(l)}</span>${editor
          ? `<input class="wc-asg-in" data-asg="${k}" value="${esc(asg[k] || "")}" placeholder=" " title="Pick a council member or type any name" autocomplete="off">`
          : `<b class="wc-asg-ro${asg[k] ? "" : " wc-asg-open"}">${asg[k] ? esc(asg[k]) : "&nbsp;"}</b>`}</label>`).join("")}
      </div>
      <datalist id="dl-council-members">${members.map((n) => `<option value="${esc(n)}"></option>`).join("")}</datalist>
      ${editor && !members.length ? `<p class="row-sub" style="margin:.5rem 0 0">Tip: tick “Ward council member” for people on the Users tab and their names appear here as suggestions.</p>` : ""}
    </div>`;

  // Follow-ups (2026-10-04): everything assigned at this meeting, grouped by person
  const follow = new Map(); // lowercased name -> { name, rows: [{ text, done }] }
  const addFollow = (name, text, done) => {
    const k = name.toLowerCase();
    if (!follow.has(k)) follow.set(k, { name, rows: [] });
    follow.get(k).rows.push({ text, done });
  };
  const noteFollow = (title, text) => String(text || "").split("\n").forEach((ln) => {
    const who = lineWho(ln); if (!who) return;
    const words = plainLine(ln);
    addFollow(who, title ? (words ? `${title} — ${words}` : title) : words, /^\s*\[(x|X)\]/.test(ln));
  });
  items.forEach((it) => {
    const title = (it.kind === "board" ? `${it.k.name} · ${it.t.title}` : it.x.title) || "";
    const who = (it.kind === "board" ? it.t.councilAssignee : it.x.assignee) || "";
    if (who) addFollow(who, title, false);
    noteFollow(title, it.kind === "board" ? it.t.councilNotes : it.x.notes);
  });
  noteFollow("", cdoc.notes);
  const followCard = follow.size ? `
    <div class="card wc-follow-card" style="margin-top:.8rem">
      <h3 style="margin:0 0 .4rem">Follow-ups <span class="row-sub" style="font-weight:400">· who has what</span></h3>
      <div class="wc-follow">
        ${[...follow.values()].sort((a, b) => a.name.localeCompare(b.name)).map((f) => `<div class="wc-follow-person"><b>${esc(f.name)}</b><ul>${f.rows.map((r) => `<li class="${r.done ? "done" : ""}">${esc(r.text)}</li>`).join("")}</ul></div>`).join("")}
      </div>
    </div>` : "";

  body.innerHTML = `
    ${assignCard}
    <div class="card" style="margin-top:.8rem">
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
    ${followCard}
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

  // assign one line of the notes (a bullet, a to-do…) to someone: "+ assign" or click the name pill
  body.querySelectorAll(".wc-cnotes-edit .nt-assign, .wc-cnotes-edit .nt-who").forEach((el) => el.addEventListener("click", (e) => {
    e.preventDefault(); e.stopPropagation();
    const holder = el.closest("[data-aline]"); if (!holder) return;
    const cut = holder.dataset.aline.lastIndexOf("|");
    const key = holder.dataset.aline.slice(0, cut), idx = Number(holder.dataset.aline.slice(cut + 1));
    pickName(el, el.dataset.who || "", async (name) => {
      try { await saveNote(key, setLineWho(rawNotes.get(key) || "", idx, name)); toast(name ? "Assigned to " + name : "Assignment removed"); }
      catch (err) { toast("Couldn't save: " + (err.code || err.message)); }
      render();
    });
  }));
  // assign the whole agenda item
  body.querySelectorAll(".wc-row [data-assignee]").forEach((chip) => chip.addEventListener("click", (e) => {
    e.stopPropagation();
    const key = chip.closest(".wc-row").dataset.key;
    pickName(chip, chip.dataset.assignee || "", async (val) => {
      try {
        if (key.startsWith("x:")) await saveCouncil(date, { extra: (cdoc.extra || []).map((x) => (x.id === key.slice(2) ? { ...x, assignee: val } : x)) });
        else { const [, cardId, todoId] = key.split(":"); const k = cards.find((c) => c.id === cardId); if (k) await saveTodoPatch(k, todoId, (t) => { t.councilAssignee = val; }); }
        toast(val ? "Assigned to " + val : "Assignment removed");
      } catch (err) { toast("Couldn't save: " + (err.code || err.message)); }
      render();
    });
  }));

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
      const extra = [...(cdoc.extra || []), { id: "a" + Math.random().toString(36).slice(2, 9), title, notes: "", discussed: false, createdAt: new Date().toISOString(), by: ctx.name || "", owner: ctx.name || "" }];
      try { await saveCouncil(date, { extra }); } catch (e) { toast("Couldn't save: " + (e.code || e.message)); }
      setTimeout(() => body.querySelector(".wc-new")?.focus(), 60);
    };
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); add(); } });
    inp.addEventListener("blur", () => { if (inp.value.trim()) add(); });
  }

  // assignments: type or pick a council member; saves when the box changes
  body.querySelectorAll("[data-asg]").forEach((inp) => {
    const save = async () => {
      const val = inp.value.trim();
      if (val === ((cdoc.assign || {})[inp.dataset.asg] || "")) return;
      try { await saveCouncil(date, { assign: { ...(cdoc.assign || {}), [inp.dataset.asg]: val } }); toast("Saved"); }
      catch (e) { toast("Couldn't save: " + (e.code || e.message)); }
    };
    inp.addEventListener("change", save);
    // suggestions: council members (plus anyone who has had this assignment), each with the last
    // time they had THIS assignment — longest-ago / never first, so it's easy to rotate (2026-10-04)
    const k = inp.dataset.asg, wrap = inp.closest(".wc-asg");
    let pop = null, sel = -1;
    const close = () => { pop?.remove(); pop = null; sel = -1; };
    const pick = (name) => { inp.value = name; close(); inp.blur(); save(); };
    const mark = () => pop?.querySelectorAll(".wc-asg-opt").forEach((o, i) => o.classList.toggle("sel", i === sel));
    const open = () => {
      const last = lastAssigned(k, date);
      const q = inp.value.trim().toLowerCase();
      const byKey = new Map(); // one row per person, however the name was capitalised
      [...members, ...[...last.values()].map((v) => v.name)].forEach((n) => { if (!byKey.has(n.toLowerCase())) byKey.set(n.toLowerCase(), n); });
      const names = [...byKey.values()];
      const rows = names.map((n) => ({ n, d: last.get(n.toLowerCase())?.date || "" }))
        .filter((r) => !q || r.n.toLowerCase().includes(q))
        .sort((a, b) => a.d.localeCompare(b.d) || a.n.localeCompare(b.n));
      close();
      if (!rows.length) return;
      pop = document.createElement("div");
      pop.className = "wc-asg-pop";
      pop.innerHTML = rows.map((r) => `<div class="wc-asg-opt" data-name="${esc(r.n)}"><span>${esc(r.n)}</span><i class="${r.d ? "" : "never"}">${r.d ? "last " + shortDay(r.d) : "never"}</i></div>`).join("");
      pop.addEventListener("mousedown", (e) => { e.preventDefault(); const o = e.target.closest(".wc-asg-opt"); if (o) pick(o.dataset.name); });
      wrap.appendChild(pop);
    };
    inp.addEventListener("focus", open);
    inp.addEventListener("click", () => { if (!pop) open(); });
    inp.addEventListener("input", open);
    inp.addEventListener("blur", close);
    inp.addEventListener("keydown", (e) => {
      const opts = pop ? [...pop.querySelectorAll(".wc-asg-opt")] : [];
      if (e.key === "ArrowDown" && opts.length) { e.preventDefault(); sel = (sel + 1) % opts.length; mark(); opts[sel].scrollIntoView({ block: "nearest" }); }
      else if (e.key === "ArrowUp" && opts.length) { e.preventDefault(); sel = (sel - 1 + opts.length) % opts.length; mark(); opts[sel].scrollIntoView({ block: "nearest" }); }
      else if (e.key === "Enter") { e.preventDefault(); if (sel >= 0 && opts[sel]) pick(opts[sel].dataset.name); else inp.blur(); }
      else if (e.key === "Escape") close();
    });
  });
  // owner chip → a box in place (council members suggested, any name allowed)
  body.querySelectorAll(".wc-row [data-owner]").forEach((chip) => chip.addEventListener("click", (e) => {
    e.stopPropagation();
    const key = chip.closest(".wc-row").dataset.key;
    const inp = document.createElement("input");
    inp.className = "wc-owner-inp"; inp.value = chip.dataset.owner || ""; inp.placeholder = "Owner"; inp.setAttribute("list", "dl-council-members"); inp.autocomplete = "off";
    chip.replaceWith(inp); inp.focus(); inp.select();
    let done = false;
    const finish = async (save) => {
      if (done) return; done = true;
      const val = inp.value.trim();
      try {
        if (save && val !== (chip.dataset.owner || "")) {
          if (key.startsWith("x:")) await saveCouncil(date, { extra: (cdoc.extra || []).map((x) => (x.id === key.slice(2) ? { ...x, owner: val } : x)) });
          else { const [, cardId, todoId] = key.split(":"); const k = cards.find((c) => c.id === cardId); if (k) await saveTodoPatch(k, todoId, (t) => { t.councilOwner = val; }); }
          toast(val ? "Owner saved" : "Owner removed");
        }
      } catch (err) { toast("Couldn't save: " + (err.code || err.message)); }
      render();
    };
    inp.addEventListener("change", () => finish(true));
    inp.addEventListener("keydown", (ev) => { if (ev.key === "Escape") { ev.preventDefault(); finish(false); } if (ev.key === "Enter") { ev.preventDefault(); finish(true); } });
    inp.addEventListener("blur", () => setTimeout(() => finish(true), 150));
  }));

  // due date pill → a date box in place; picking a date saves, clearing it removes the due date
  body.querySelectorAll(".wc-row [data-due]").forEach((pill) => pill.addEventListener("click", (e) => {
    e.stopPropagation();
    const key = pill.closest(".wc-row").dataset.key;
    const inp = document.createElement("input");
    inp.type = "date"; inp.className = "wc-due-inp"; inp.value = pill.dataset.due || "";
    pill.replaceWith(inp); inp.focus();
    try { inp.showPicker?.(); } catch { /* not allowed without a direct gesture in some browsers */ }
    let done = false;
    const finish = async (save) => {
      if (done) return; done = true;
      const val = inp.value || "";
      try {
        if (save && val !== (pill.dataset.due || "")) {
          if (key.startsWith("x:")) await saveCouncil(date, { extra: (cdoc.extra || []).map((x) => (x.id === key.slice(2) ? { ...x, due: val } : x)) });
          else { const [, cardId, todoId] = key.split(":"); const k = cards.find((c) => c.id === cardId); if (k) await saveTodoPatch(k, todoId, (t) => { t.due = val; }); }
          toast(val ? "Due date saved" : "Due date removed");
        }
      } catch (err) { toast("Couldn't save: " + (err.code || err.message)); }
      render();
    };
    inp.addEventListener("change", () => finish(true));
    inp.addEventListener("keydown", (ev) => { if (ev.key === "Escape") { ev.preventDefault(); finish(false); } if (ev.key === "Enter") { ev.preventDefault(); finish(true); } });
    inp.addEventListener("blur", () => setTimeout(() => finish(true), 120));
  }));

  // ---- attachments on an agenda item (2026-10-04) ----
  const filesOf = (key) => {
    if (key.startsWith("x:")) return ((cdoc.extra || []).find((x) => x.id === key.slice(2)) || {}).files || [];
    const [, cardId, todoId] = key.split(":");
    return (((cards.find((c) => c.id === cardId) || {}).todos || []).find((t) => t.id === todoId) || {}).councilFiles || [];
  };
  const saveFiles = async (key, files) => {
    if (key.startsWith("x:")) await saveCouncil(date, { extra: (cdoc.extra || []).map((x) => (x.id === key.slice(2) ? { ...x, files } : x)) });
    else { const [, cardId, todoId] = key.split(":"); const k = cards.find((c) => c.id === cardId); if (k) await saveTodoPatch(k, todoId, (t) => { t.councilFiles = files; }); }
  };
  // a copied item points at the same stored file — only delete the bytes when nothing else uses them
  const fileInUse = (id, exceptKey) =>
    Object.entries(councils).some(([d, c]) => (c.extra || []).some((x) => `x:${x.id}` !== exceptKey || d !== date ? (x.files || []).some((f) => f.id === id) : false)) ||
    cards.some((k) => (k.todos || []).some((t) => `b:${k.id}:${t.id}` !== exceptKey && (t.councilFiles || []).some((f) => f.id === id)));
  const picker = document.createElement("input");
  picker.type = "file"; picker.multiple = true; picker.accept = ATTACH_ACCEPT; picker.hidden = true;
  body.appendChild(picker);
  let attachKey = null;
  body.querySelectorAll(".wc-row [data-attach]").forEach((b) => b.addEventListener("click", () => { attachKey = b.closest(".wc-row").dataset.key; picker.value = ""; picker.click(); }));
  picker.addEventListener("change", async () => {
    const key = attachKey, chosen = [...picker.files];
    if (!key || !chosen.length) return;
    const rowEl = [...body.querySelectorAll(".wc-row")].find((r) => r.dataset.key === key);
    const status = rowEl?.querySelector(".wc-upload");
    const say = (t) => { if (status) { status.hidden = !t; status.textContent = t; } };
    const added = [];
    try {
      for (const [i, f] of chosen.entries()) {
        if (f.size > MAX_ATTACH_BYTES) { toast(`“${f.name}” is ${fmtBytes(f.size)} — the limit is ${fmtBytes(MAX_ATTACH_BYTES)}`); continue; }
        say(`Uploading ${f.name}${chosen.length > 1 ? ` (${i + 1} of ${chosen.length})` : ""}…`);
        added.push(await uploadAttachment("councils", date, f, (p) => say(`Uploading ${f.name} — ${Math.round(p * 100)}%`)));
      }
      if (added.length) { await saveFiles(key, [...filesOf(key), ...added]); toast(added.length === 1 ? "Attached" : `${added.length} files attached`); }
    } catch (e) { toast("Couldn't attach: " + (e.code || e.message)); }
    say("");
  });
  body.querySelectorAll(".wc-file").forEach((chip) => chip.addEventListener("click", async (e) => {
    const key = chip.closest(".wc-row").dataset.key;
    const meta = filesOf(key).find((f) => f.id === chip.dataset.file); if (!meta) return;
    if (e.target.closest("[data-rmfile]")) {
      if (!confirm(`Remove “${meta.name}” from this item?`)) return;
      try {
        await saveFiles(key, filesOf(key).filter((f) => f.id !== meta.id));
        if (!fileInUse(meta.id, key)) await deleteAttachment("councils", meta);
        toast("Removed");
      } catch (err) { toast("Couldn't remove: " + (err.code || err.message)); }
      return;
    }
    chip.classList.add("busy");
    try { await openAttachment("councils", meta); } catch (err) { toast(err.message || "Couldn't open that file"); }
    chip.classList.remove("busy");
  }));

  // Actions ▾ on an item (2026-10-04): copy / move it to the next council, or to a future one you pick
  const carry = async (key, mode, target) => {
    try {
      if (key.startsWith("b:")) { // a Member Board item just waits for that meeting
        const [, cardId, todoId] = key.split(":");
        const k = cards.find((c) => c.id === cardId); if (!k) return;
        await saveTodoPatch(k, todoId, (t) => { t.council = true; t.councilNotBefore = target; });
      } else {
        const id = key.slice(2);
        const item = (cdoc.extra || []).find((x) => x.id === id); if (!item) return;
        const copy = { ...item, id: "a" + Math.random().toString(36).slice(2, 9), discussed: false, discussedAt: "", carriedFrom: date, createdAt: new Date().toISOString(), by: ctx.name || "", owner: item.owner || item.by || "" };
        await saveCouncil(target, { extra: [...((councils[target] || {}).extra || []), copy] });
        if (mode === "move") await saveCouncil(date, { extra: (cdoc.extra || []).filter((x) => x.id !== id), order: (cdoc.order || []).filter((o) => o !== key) });
      }
      toast(`${mode === "move" ? "Moved" : "Copied"} to ${fmtDay(target)}`);
    } catch (e) { toast("Couldn't save: " + (e.code || e.message)); render(); }
  };
  const closeMenus = () => body.querySelectorAll(".wc-menu").forEach((x) => x.remove());
  body.querySelectorAll(".wc-row [data-actions]").forEach((b) => b.addEventListener("click", (e) => {
    e.stopPropagation();
    const wrap = b.closest(".wc-act-wrap");
    if (wrap.querySelector(".wc-menu")) { closeMenus(); return; }
    closeMenus();
    const key = b.closest(".wc-row").dataset.key, isBoard = key.startsWith("b:");
    const targets = councilsAfter(date);
    const nextD = targets[0];
    const menu = document.createElement("div");
    menu.className = "wc-menu";
    const mainMenu = () => {
      menu.innerHTML = nextD ? `
        ${isBoard ? "" : `<button type="button" data-m="copy-next">Copy to next council <span>${fmtDay(nextD)}</span></button>`}
        <button type="button" data-m="move-next">Move to next council <span>${fmtDay(nextD)}</span></button>
        ${targets.length > 1 ? `<div class="wc-menu-sep"></div>
        ${isBoard ? "" : `<button type="button" data-m="copy-future">Copy to a future council…</button>`}
        <button type="button" data-m="move-future">Move to a future council…</button>` : ""}`
        : `<div class="wc-menu-empty">No later council dates are set. Add some under 📅 Council dates.</div>`;
      menu.querySelectorAll("[data-m]").forEach((mi) => mi.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const [mode, when] = mi.dataset.m.split("-");
        if (when === "next") { closeMenus(); carry(key, mode, nextD); }
        else pickDate(mode);
      }));
    };
    const pickDate = (mode) => {
      menu.innerHTML = `<div class="wc-menu-title">${mode === "move" ? "Move" : "Copy"} to…</div>
        ${targets.map((d, i) => `<button type="button" data-d="${d}">${fmtDay(d)}${i === 0 ? " <span>next</span>" : ""}</button>`).join("")}
        <div class="wc-menu-sep"></div><button type="button" data-back="1">‹ Back</button>`;
      menu.querySelectorAll("[data-d]").forEach((di) => di.addEventListener("click", (ev) => { ev.stopPropagation(); closeMenus(); carry(key, mode, di.dataset.d); }));
      menu.querySelector("[data-back]").addEventListener("click", (ev) => { ev.stopPropagation(); mainMenu(); });
    };
    mainMenu();
    wrap.appendChild(menu);
    setTimeout(() => document.addEventListener("click", closeMenus, { once: true }), 0);
  }));

  // row actions
  body.querySelectorAll(".wc-row [data-act]").forEach((b) => b.addEventListener("click", async () => {
    const key = b.closest(".wc-row").dataset.key;
    const act = b.dataset.act;
    try {
      if (key.startsWith("x:")) {
        const id = key.slice(2);
        let extra = cdoc.extra || [];
        if (act === "remove") {
          if (!confirm("Delete this agenda item?")) return;
          const gone = (extra.find((x) => x.id === id) || {}).files || [];
          extra = extra.filter((x) => x.id !== id);
          for (const f of gone) if (!fileInUse(f.id, key)) deleteAttachment("councils", f).catch(() => {});
        }
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
