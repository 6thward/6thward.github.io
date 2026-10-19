// Calendar tab: month grid of ward meetings and the bishop's schedule.
// 2026-10-11 — events belong to the Ward calendar or the Bishop's calendar (cal: "ward" | "bishop").
// Bishop's events block tithing-declaration sign-up times they overlap (tithing/{token}.busy), and
// tithing availability + booked appointments show here as calendar items of their own.
import { db } from "./firebase-init.js?v=1792384604";
import { ctx, hasRole, can } from "./app.js?v=1792384604";
import {
  collection, onSnapshot, addDoc, updateDoc, deleteDoc, doc, setDoc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { slotsOf, slotMap, busyFromEvents, sameBusy, fmtClock, parseSlotId, offList } from "./tithing-shared.js?v=1792384604";
import { watchBishopCal, bishopCalConfig, standingEvents, WEEKDAYS } from "./bishop-cal.js?v=1792384604";
import { openModal, closeModal, toast, esc, fmtDate, fmtTime, todayISO } from "./ui.js?v=1792384604";

let events = [];
let viewYear, viewMonth; // 0-based month
let started = false;
let calView = "all";          // all | ward | bishop
let season = null, signups = {}, unsubSignups = null; // tithing declaration (only loads for people who can see it)
const calOf = (e) => (e.cal === "bishop" ? "bishop" : "ward");

export function initCalendar() {
  if (started) return;
  started = true;
  const now = new Date();
  viewYear = now.getFullYear();
  viewMonth = now.getMonth();

  const panel = document.getElementById("panel-calendar");
  panel.innerHTML = `
    <div class="panel-head">
      <div>
        <h2>Calendar</h2>
        <p class="panel-sub">Meetings, interviews, and ward events. Click a day to add.</p>
      </div>
      <div class="panel-actions">
        <div class="view-toggle" id="cal-filter">
          <button class="chip active" data-cal="all" type="button">All</button>
          <button class="chip" data-cal="ward" type="button">Ward</button>
          <button class="chip chip-bishop" data-cal="bishop" type="button" title="The bishop's own calendar — its events block tithing declaration times">Bishop</button>
        </div>
        ${can("calendar", "edit") ? `<button class="btn" id="btn-standing" type="button" title="Ward council and bishopric meeting times — they go on the Bishop calendar every week">⚙ Standing meetings</button>` : ""}
        <button class="btn btn-primary" id="btn-new-event">+ New event</button>
      </div>
    </div>
    <div class="card">
      <div class="cal-head">
        <button class="btn btn-sm" id="cal-prev">‹</button>
        <h3 id="cal-title"></h3>
        <button class="btn btn-sm" id="cal-next">›</button>
      </div>
      <div class="cal-grid" id="cal-grid"></div>
    </div>
    <div class="card">
      <h3>Coming up</h3>
      <div id="upcoming-list"></div>
    </div>`;

  panel.querySelector("#cal-prev").addEventListener("click", () => shiftMonth(-1));
  panel.querySelector("#cal-next").addEventListener("click", () => shiftMonth(1));
  panel.querySelector("#btn-new-event").addEventListener("click", () => editEvent(null, todayISO()));
  panel.querySelector("#btn-standing")?.addEventListener("click", editStanding);
  watchBishopCal(() => { render(); if (season) syncBusy(events); });
  panel.querySelectorAll("#cal-filter [data-cal]").forEach((b) => b.addEventListener("click", () => {
    calView = b.dataset.cal;
    panel.querySelectorAll("#cal-filter .chip").forEach((c) => c.classList.toggle("active", c === b));
    render();
  }));

  onSnapshot(collection(db, "events"), (qs) => {
    events = qs.docs.map((d) => ({ id: d.id, ...d.data() }));
    render();
  });
  // tithing declaration sign-ups, for people allowed to see them (the rules say who)
  onSnapshot(collection(db, "tithing"), (qs) => {
    const all = qs.docs.map((d) => ({ token: d.id, ...d.data() })).sort((a, b) => String(b.created || "").localeCompare(String(a.created || "")));
    const next = all[0] || null;
    if ((next && next.token) !== (season && season.token)) {
      if (unsubSignups) unsubSignups();
      signups = {};
      unsubSignups = next ? onSnapshot(collection(db, "tithing", next.token, "signups"), (s) => { signups = Object.fromEntries(s.docs.map((d) => [d.id, d.data()])); render(); }, () => {}) : null;
    }
    season = next;
    render();
  }, () => {});
  render();
}

// ---- tithing declaration on the calendar ----
// one item per availability block: "Tithing declaration 2:00–4:00 PM · 3 of 8 booked"
function tithingItems(date) {
  if (!season) return [];
  const slots = slotsOf(season.windows, offList(season)).filter((s) => s.date === date);
  return (season.windows || []).filter((w) => w.date === date).map((w) => {
    const mine = slots.filter((s) => s.win === w.id), booked = mine.filter((s) => signups[s.id]);
    return { tithing: true, id: "t:" + w.id, date, startTime: w.start, endTime: w.end, cal: "bishop",
      title: "Tithing declaration", sub: `${booked.length} of ${mine.filter((s) => !s.blocked || signups[s.id]).length} booked${w.place === "home" ? " · home visits" : ""}`,
      booked: booked.map((s) => ({ min: s.min, name: signups[s.id].name })) };
  });
}
const showIt = (e) => calView === "all" || calOf(e) === calView;
// which booked appointments a bishop's event would sit on top of
function clashes(date, start, end) {
  if (!season) return [];
  const a = start ? toMinutes(start) : 0, b = end ? toMinutes(end) : start ? a + 60 : 24 * 60;
  return slotsOf(season.windows).filter((s) => s.date === date && signups[s.id] && s.min < b && a < s.min + s.len).map((s) => `${fmtClock(s.min)} ${signups[s.id].name}`);
}
const toMinutes = (hhmm) => { const [h, m] = String(hhmm).split(":").map(Number); return h * 60 + (m || 0); };
// after the bishop's calendar changes, keep the sign-up page's busy times in step
async function syncBusy(nextEvents) {
  if (!season) return;
  const busy = busyFromEvents(season.windows, [...nextEvents, ...standingEvents((season.windows || []).map((w) => w.date))]);
  if (sameBusy(busy, season.busy)) return;
  try { await updateDoc(doc(db, "tithing", season.token), { busy, slots: slotMap(season.windows, [...(season.blocked || []), ...Object.keys(busy)]), updatedAt: serverTimestamp() }); }
  catch (e) { console.warn("[calendar] tithing busy sync", e); }
}

function shiftMonth(delta) {
  viewMonth += delta;
  if (viewMonth < 0) { viewMonth = 11; viewYear--; }
  if (viewMonth > 11) { viewMonth = 0; viewYear++; }
  render();
}

const iso = (y, m, d) =>
  `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

function render() {
  if (openDay && document.getElementById("dv-grid")) drawDay(); // the open day view follows live changes (2026-10-18)
  const grid = document.getElementById("cal-grid");
  if (!grid) return;
  document.getElementById("cal-title").textContent =
    new Date(viewYear, viewMonth, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });

  const firstDow = new Date(viewYear, viewMonth, 1).getDay();
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const daysInPrev = new Date(viewYear, viewMonth, 0).getDate();
  const today = todayISO();
  const byDate = {};
  const gridDates = []; { const first = new Date(viewYear, viewMonth, 1); first.setDate(1 - first.getDay()); for (let i = 0; i < 42; i++) { const d = new Date(first); d.setDate(first.getDate() + i); gridDates.push(iso(d.getFullYear(), d.getMonth(), d.getDate())); } }
  [...events, ...standingEvents(gridDates)].filter(showIt).forEach((e) => (byDate[e.date] = byDate[e.date] || []).push(e));
  if (calView !== "ward" && season) (season.windows || []).forEach((w) => { if (!byDate[w.date] || !byDate[w.date].some((x) => x.tithing)) tithingItems(w.date).forEach((t) => (byDate[w.date] = byDate[w.date] || []).push(t)); });
  Object.values(byDate).forEach((l) => l.sort((a, b) => (a.startTime || "") < (b.startTime || "") ? -1 : 1));

  let html = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
    .map((d) => `<div class="cal-dow">${d}</div>`).join("");

  const cells = 42;
  for (let i = 0; i < cells; i++) {
    const dayNum = i - firstDow + 1;
    let cellDate, otherMonth = false, displayNum;
    if (dayNum < 1) {
      otherMonth = true; displayNum = daysInPrev + dayNum;
      const m = viewMonth === 0 ? 11 : viewMonth - 1;
      cellDate = iso(viewMonth === 0 ? viewYear - 1 : viewYear, m, displayNum);
    } else if (dayNum > daysInMonth) {
      otherMonth = true; displayNum = dayNum - daysInMonth;
      const m = viewMonth === 11 ? 0 : viewMonth + 1;
      cellDate = iso(viewMonth === 11 ? viewYear + 1 : viewYear, m, displayNum);
    } else {
      displayNum = dayNum;
      cellDate = iso(viewYear, viewMonth, dayNum);
    }
    const evs = byDate[cellDate] || [];
    const isSunday = i % 7 === 0;
    html += `
      <div class="cal-cell ${otherMonth ? "other-month" : ""} ${cellDate === today ? "today" : ""}" data-date="${cellDate}">
        <span class="cal-daynum">${displayNum}</span>
        ${evs.slice(0, 3).map((e) => `
          <div class="cal-event ${isSunday ? "ev-sunday" : ""}${e.tithing ? " ev-tithing" : calOf(e) === "bishop" ? " ev-bishop" : ""}${e.standing ? " ev-standing" : ""}" title="${esc(e.title)}${e.sub ? " · " + esc(e.sub) : ""}">
            ${e.startTime ? fmtTime(e.startTime) + " " : ""}${esc(e.title)}
          </div>`).join("")}
        ${evs.length > 3 ? `<div class="cal-event">+${evs.length - 3} more</div>` : ""}
      </div>`;
  }
  grid.innerHTML = html;

  grid.querySelectorAll(".cal-cell").forEach((cell) =>
    cell.addEventListener("click", () => dayView(cell.dataset.date)));

  // Upcoming list (next 30 days)
  const horizon = new Date(); horizon.setDate(horizon.getDate() + 30);
  const horizonISO = iso(horizon.getFullYear(), horizon.getMonth(), horizon.getDate());
  const soon = []; { const d = new Date(); for (let i = 0; i <= 30; i++) { soon.push(iso(d.getFullYear(), d.getMonth(), d.getDate())); d.setDate(d.getDate() + 1); } }
  const up = [...events.filter(showIt), ...standingEvents(soon).filter(showIt), ...(calView !== "ward" && season ? (season.windows || []).filter((w) => w.date >= today && w.date <= horizonISO).flatMap((w) => tithingItems(w.date).filter((t) => t.id === "t:" + w.id)) : [])]
    .filter((e) => e.date >= today && e.date <= horizonISO)
    .sort((a, b) => (a.date + (a.startTime || "")) < (b.date + (b.startTime || "")) ? -1 : 1);
  document.getElementById("upcoming-list").innerHTML = up.length
    ? up.map((e) => `
      <div class="list-row${e.tithing ? " list-row-tithing" : ""}" data-id="${e.id}">
        <div class="row-main">
          <div class="row-title">${e.tithing ? "🗓 " : calOf(e) === "bishop" ? `<span class="cal-tag cal-tag-bishop">Bishop</span> ` : ""}${esc(e.title)}</div>
          <div class="row-sub">${fmtDate(e.date)}${e.startTime ? " · " + fmtTime(e.startTime) : ""}${e.endTime ? "–" + fmtTime(e.endTime) : ""}${e.location ? " · " + esc(e.location) : ""}${e.sub ? " · " + esc(e.sub) : ""}</div>
        </div>
      </div>`).join("")
    : `<div class="empty-note">Nothing on the calendar for the next 30 days.</div>`;
  document.querySelectorAll("#upcoming-list .list-row").forEach((row) =>
    row.addEventListener("click", () => {
      if (row.dataset.id.startsWith("t:")) return dayView(up.find((x) => x.id === row.dataset.id)?.date);
      if (/^s[cb]:/.test(row.dataset.id)) return can("calendar", "edit") ? editStanding() : undefined;
      const e = events.find((x) => x.id === row.dataset.id);
      if (e) editEvent(e);
    }));
}

// ---- the day view: a timeline you drag on (2026-10-18) ----
// Drag out a stretch of the day, then say what it is: tithing declaration (10 / 15 / 20 / 30-minute
// visits — members sign up for them), ward council, bishopric meeting, interviews (slots you put a
// name on), or anything else. Existing events, standing meetings and tithing blocks sit on the same
// timeline so you can see the whole day at once.
const DAY_START = 7 * 60, DAY_END = 21 * 60, PX_MIN = 1.15, SNAP = 5;
const KINDS = [
  ["tithing", "Tithing declaration", "Members sign up for these times through the link / QR"],
  ["council", "Ward council", "Goes on the Bishop calendar"],
  ["bishopric", "Bishopric meeting", "Goes on the Bishop calendar"],
  ["interviews", "Interviews", "Slots you fill with names yourself"],
  ["other", "Something else", "Any other appointment on the Bishop calendar"],
];
const TITHING_LENS = [10, 15, 20, 30], INTERVIEW_LENS = [10, 15, 20, 30, 60];
let openDay = null, dvSel = null, dvFocus = null; // the day that's open, the dragged selection, the block being looked at
const hhmmOf = (min) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
const snap = (min) => Math.round(min / SNAP) * SNAP;
const clampDay = (min) => Math.max(DAY_START, Math.min(DAY_END, min));

function dayView(date) {
  if (!date) return;
  openDay = date; dvSel = null; dvFocus = null;
  const el = openModal(`
    <div class="dv-head"><h3>${fmtDate(date, { year: true })}</h3><span class="row-sub" id="dv-hint">${can("calendar", "edit") ? "Drag across the timeline to add something." : ""}</span></div>
    <div class="dv-wrap">
      <div class="dv-grid-wrap"><div class="dv-grid" id="dv-grid"></div></div>
      <div class="dv-side" id="dv-side"></div>
    </div>
    <div class="modal-actions"><div class="right"><button class="btn" id="dv-close">Close</button><button class="btn btn-primary" id="dv-add">+ Add event</button></div></div>`);
  el.classList.add("modal-wide", "cal-dayview");
  el.querySelector("#dv-close").addEventListener("click", () => { openDay = null; closeModal(); });
  el.querySelector("#dv-add").addEventListener("click", () => editEvent(null, date));
  drawDay();
  wireDrag(el.querySelector("#dv-grid"));
}
// everything on this day as timeline blocks
function dayBlocks(date) {
  const out = [];
  events.filter((e) => e.date === date && showIt(e)).forEach((e) => out.push({ kind: e.kind === "interviews" ? "interviews" : "event", id: e.id, title: e.title, start: e.startTime ? toMinutes(e.startTime) : null, end: e.endTime ? toMinutes(e.endTime) : (e.startTime ? toMinutes(e.startTime) + 60 : null), cal: calOf(e), ev: e }));
  standingEvents([date]).filter(showIt).forEach((e) => out.push({ kind: "standing", id: e.id, title: e.title, start: toMinutes(e.startTime), end: toMinutes(e.endTime), cal: "bishop" }));
  if (season && calView !== "ward") {
    const slots = slotsOf(season.windows, offList(season)).filter((s) => s.date === date);
    (season.windows || []).filter((w) => w.date === date).forEach((w) => {
      const mine = slots.filter((s) => s.win === w.id);
      out.push({ kind: "tithing", id: w.id, title: "Tithing declaration", start: toMinutes(w.start), end: toMinutes(w.end), cal: "bishop", win: w, slots: mine });
    });
  }
  return out;
}
function drawDay() {
  const grid = document.getElementById("dv-grid"), side = document.getElementById("dv-side");
  if (!grid || !openDay) return;
  const date = openDay, blocks = dayBlocks(date);
  const top = (min) => (min - DAY_START) * PX_MIN, h = (a, b) => Math.max(14, (b - a) * PX_MIN);
  const hours = [];
  for (let m = DAY_START; m <= DAY_END; m += 60) hours.push(`<div class="dv-hour" style="top:${top(m)}px"><span>${fmtClock(m).replace(":00", "")}</span></div>`);
  const timed = blocks.filter((b) => b.start != null);
  const allDay = blocks.filter((b) => b.start == null);
  // overlapping blocks share the width side by side
  timed.sort((a, b) => a.start - b.start);
  const cols = []; timed.forEach((b) => { let c = cols.findIndex((lastEnd) => lastEnd <= b.start); if (c < 0) { c = cols.length; cols.push(0); } cols[c] = b.end; b.col = c; });
  const nCols = Math.max(1, cols.length);
  const blockHtml = (b) => {
    const style = `top:${top(Math.max(b.start, DAY_START))}px;height:${h(Math.max(b.start, DAY_START), Math.min(b.end, DAY_END))}px;left:calc(${(b.col / nCols) * 100}% + 2px);width:calc(${100 / nCols}% - 4px)`;
    if (b.kind === "tithing") {
      const ticks = b.slots.map((s) => { const su = signups[s.id]; return `<div class="dv-slot${su ? " booked" : s.blocked ? " off" : ""}" style="top:${(s.min - b.start) * PX_MIN}px;height:${s.len * PX_MIN}px" title="${fmtClock(s.min)}${su ? " · " + esc(su.name) : s.blocked ? " · blocked" : " · open"}">${su ? `<span>${esc(su.name)}</span>` : ""}</div>`; }).join("");
      const booked = b.slots.filter((s) => signups[s.id]).length;
      return `<div class="dv-block dv-tithing${dvFocus === "t:" + b.id ? " dv-focus" : ""}" data-block="t:${esc(b.id)}" style="${style}"><div class="dv-block-title">Tithing declaration <span>${fmtClock(b.start)}–${fmtClock(b.end)} · ${b.win.len} min · ${booked}/${b.slots.filter((s) => !s.blocked || signups[s.id]).length} booked</span></div><div class="dv-slots">${ticks}</div></div>`;
    }
    if (b.kind === "interviews") {
      const len = Number(b.ev.len) || 15, names = b.ev.slots || {}; const ticks = [];
      for (let m = b.start; m + len <= b.end; m += len) { const k = hhmmOf(m); ticks.push(`<div class="dv-slot${names[k] ? " booked" : ""}" data-islot="${k}" style="top:${(m - b.start) * PX_MIN}px;height:${len * PX_MIN}px" title="${fmtClock(m)}${names[k] ? " · " + esc(names[k]) : " · open — click to add a name"}">${names[k] ? `<span>${esc(names[k])}</span>` : ""}</div>`); }
      return `<div class="dv-block dv-interviews${dvFocus === "e:" + b.id ? " dv-focus" : ""}" data-block="e:${esc(b.id)}" style="${style}"><div class="dv-block-title">${esc(b.title)} <span>${fmtClock(b.start)}–${fmtClock(b.end)} · ${len} min</span></div><div class="dv-slots">${ticks.join("")}</div></div>`;
    }
    const cls = b.kind === "standing" ? "dv-standing" : b.cal === "bishop" ? "dv-bishop" : "dv-ward";
    return `<div class="dv-block ${cls}" data-block="${b.kind === "standing" ? "s:" : "e:"}${esc(b.id)}" style="${style}" title="${esc(b.title)}"><div class="dv-block-title">${esc(b.title)} <span>${fmtClock(b.start)}–${fmtClock(b.end)}</span></div></div>`;
  };
  const selHtml = dvSel ? `<div class="dv-sel" style="top:${top(dvSel.a)}px;height:${h(dvSel.a, dvSel.b)}px"><span>${fmtClock(dvSel.a)} – ${fmtClock(dvSel.b)}</span></div>` : "";
  grid.style.height = `${(DAY_END - DAY_START) * PX_MIN + 20}px`;
  grid.innerHTML = `${hours.join("")}<div class="dv-blocks">${timed.map(blockHtml).join("")}${selHtml}</div>`;
  grid.querySelectorAll("[data-block]").forEach((n) => n.addEventListener("click", (e) => {
    e.stopPropagation();
    const [t, id] = [n.dataset.block.slice(0, 1), n.dataset.block.slice(2)];
    if (t === "s") return can("calendar", "edit") ? editStanding() : undefined;
    if (t === "t") { dvFocus = "t:" + id; dvSel = null; drawDay(); return; }
    const ev = events.find((x) => x.id === id);
    if (ev && ev.kind === "interviews") { const k = e.target.closest("[data-islot]")?.dataset.islot; dvFocus = "e:" + id; dvSel = null; drawDay(); if (k) document.getElementById("dv-side")?.querySelector(`[data-iname="${k}"]`)?.focus(); return; }
    if (ev) editEvent(ev);
  }));
  // the side panel: the designate form while something is selected, a block's details when one is clicked, else the day's list
  side.innerHTML = dvSel ? designateHtml(date) : dvFocus ? focusHtml(date, blocks) : listHtml(date, blocks, allDay);
  wireSide(date, blocks);
}
function listHtml(date, blocks, allDay) {
  const all = [...allDay, ...blocks.filter((b) => b.start != null)].sort((a, b) => (a.start ?? -1) - (b.start ?? -1));
  if (!all.length) return `<div class="empty-note">Nothing on this day yet.${can("calendar", "edit") ? "<br>Drag across the timeline to add something." : ""}</div>`;
  return `<h4 class="dv-side-h">This day</h4>${all.map((b) => `<div class="dv-item dv-item-${b.kind === "tithing" ? "tithing" : b.kind === "standing" ? "standing" : b.cal}"><b>${esc(b.title)}</b><span class="row-sub">${b.start == null ? "All day" : `${fmtClock(b.start)}–${fmtClock(b.end)}`}${b.kind === "tithing" ? ` · ${b.slots.filter((s) => signups[s.id]).length} booked` : ""}</span></div>`).join("")}`;
}
function designateHtml(date) {
  const kinds = KINDS.filter(([k]) => k !== "tithing" || can("tithing", "edit"));
  return `<h4 class="dv-side-h">What is this?</h4>
    <div class="dv-time"><label>From<input type="time" id="dv-start" step="300" value="${hhmmOf(dvSel.a)}"></label><label>To<input type="time" id="dv-end" step="300" value="${hhmmOf(dvSel.b)}"></label></div>
    <div class="dv-kinds">${kinds.map(([k, l, hint], i) => `<label class="dv-kind${(dvSel.kind || kinds[0][0]) === k ? " on" : ""}"><input type="radio" name="dv-kind" value="${k}"${(dvSel.kind || kinds[0][0]) === k ? " checked" : ""}><span><b>${l}</b><small>${hint}</small></span></label>`).join("")}</div>
    <div class="dv-opts" id="dv-opts"></div>
    <div class="dv-opts dv-opts-row dv-repeat"><label>Repeat<select id="dv-rep"><option value="0"${!dvSel.rep ? " selected" : ""}>Just this day</option><option value="7"${dvSel.rep === 7 ? " selected" : ""}>Every week</option><option value="14"${dvSel.rep === 14 ? " selected" : ""}>Every 2 weeks</option></select></label><label id="dv-until-wrap"${dvSel.rep ? "" : " hidden"}>Until<input type="date" id="dv-until" value="${esc(dvSel.until || addDaysIso(date, 56))}"></label></div>
    <div class="dv-form-actions"><button type="button" class="btn" id="dv-cancel">Cancel</button><button type="button" class="btn btn-primary" id="dv-save">Add</button></div>`;
}
function optsHtml(kind) {
  const opt = (v, l, cur) => `<option value="${v}"${String(cur) === String(v) ? " selected" : ""}>${l}</option>`;
  if (kind === "tithing") return `<label>Each visit<select id="dv-len">${TITHING_LENS.map((n) => opt(n, n + " minutes", dvSel.len || 15)).join("")}</select></label>
    <label>Where<select id="dv-place"><option value="office">🏛 Bishop's office</option><option value="home">🏠 Home visits</option></select></label>
    <label>Set aside for<select id="dv-group"><option value="">Anyone</option><option value="families">Families with kids at home</option><option value="widows">Widows</option></select></label>`;
  if (kind === "interviews") return `<label>Each interview<select id="dv-len">${INTERVIEW_LENS.map((n) => opt(n, n + " minutes", dvSel.len || 15)).join("")}</select></label><label>Label<input id="dv-title" value="Interviews" autocomplete="off"></label>`;
  if (kind === "other") return `<label>Title<input id="dv-title" placeholder="e.g. Temple recommend — Hansen" autocomplete="off"></label>`;
  return "";
}
function focusHtml(date, blocks) {
  const [t, id] = [dvFocus.slice(0, 1), dvFocus.slice(2)];
  const b = blocks.find((x) => (t === "t" ? x.kind === "tithing" : x.kind !== "tithing") && x.id === id);
  if (!b) { dvFocus = null; return listHtml(date, blocks, []); }
  if (t === "t") {
    const w = b.win, booked = b.slots.filter((s) => signups[s.id]);
    const ed = can("tithing", "edit");
    return `<h4 class="dv-side-h">Tithing declaration</h4>
      <div class="row-sub">${fmtClock(b.start)}–${fmtClock(b.end)} · ${w.place === "home" ? "home visits" : "Bishop's office"}${w.group ? " · " + (w.group === "families" ? "families with kids at home" : "widows") : ""}</div>
      ${ed ? `<div class="dv-opts dv-opts-row"><label>Each visit<select id="dv-f-len">${TITHING_LENS.map((n) => `<option value="${n}"${Number(w.len) === n ? " selected" : ""}>${n} min</option>`).join("")}</select></label>
        <label>Where<select id="dv-f-place"><option value="office"${w.place !== "home" ? " selected" : ""}>Bishop's office</option><option value="home"${w.place === "home" ? " selected" : ""}>Home visits</option></select></label>
        <label>For<select id="dv-f-group"><option value=""${!w.group ? " selected" : ""}>Anyone</option><option value="families"${w.group === "families" ? " selected" : ""}>Families</option><option value="widows"${w.group === "widows" ? " selected" : ""}>Widows</option></select></label></div>` : ""}
      <h4 class="dv-side-h">Signed up <span class="pill pill-role-member">${booked.length}</span></h4>
      ${booked.length ? booked.map((s) => `<div class="dv-item dv-item-tithing"><b>${fmtClock(s.min)}</b><span>${esc(signups[s.id].name)}${signups[s.id].phone ? ` <span class="row-sub">· ${esc(signups[s.id].phone)}</span>` : ""}</span></div>`).join("") : `<div class="row-sub">Nobody yet.</div>`}
      <div class="dv-form-actions">${ed ? `<button type="button" class="btn btn-ghost btn-danger" id="dv-f-remove">Remove block</button>` : ""}<button type="button" class="btn" id="dv-back">Back</button></div>`;
  }
  const ev = b.ev, len = Number(ev.len) || 15, names = ev.slots || {}, ed = can("calendar", "edit") || ev.createdBy === ctx.uid;
  const rows = []; for (let m = b.start; m + len <= b.end; m += len) { const k = hhmmOf(m); rows.push(`<label class="dv-irow"><b>${fmtClock(m)}</b><input data-iname="${k}" value="${esc(names[k] || "")}" placeholder="—" autocomplete="off" ${ed ? "" : "disabled"}></label>`); }
  return `<h4 class="dv-side-h">${esc(ev.title)}</h4><div class="row-sub">${fmtClock(b.start)}–${fmtClock(b.end)} · ${len}-minute slots · type a name on a slot, Enter saves</div>
    <div class="dv-irows">${rows.join("")}</div>
    <div class="dv-form-actions">${ed ? `<button type="button" class="btn" id="dv-f-edit">Edit…</button>` : ""}<button type="button" class="btn" id="dv-back">Back</button></div>`;
}
function wireSide(date, blocks) {
  const side = document.getElementById("dv-side"); if (!side) return;
  side.querySelector("#dv-back")?.addEventListener("click", () => { dvFocus = null; drawDay(); });
  side.querySelector("#dv-cancel")?.addEventListener("click", () => { dvSel = null; drawDay(); });
  // designate form
  if (dvSel) {
    const opts = side.querySelector("#dv-opts");
    const kindNow = () => side.querySelector("input[name=dv-kind]:checked")?.value || KINDS[0][0];
    const redrawOpts = () => { dvSel.kind = kindNow(); opts.innerHTML = optsHtml(dvSel.kind); side.querySelectorAll(".dv-kind").forEach((l) => l.classList.toggle("on", l.querySelector("input").checked)); };
    side.querySelectorAll("input[name=dv-kind]").forEach((r) => r.addEventListener("change", redrawOpts));
    redrawOpts();
    const syncTimes = () => { const a = toMinutes(side.querySelector("#dv-start").value), b = toMinutes(side.querySelector("#dv-end").value); if (b > a) { dvSel.a = a; dvSel.b = b; const g = document.getElementById("dv-grid"); const selEl = g?.querySelector(".dv-sel"); if (selEl) { selEl.style.top = `${(a - DAY_START) * PX_MIN}px`; selEl.style.height = `${(b - a) * PX_MIN}px`; selEl.querySelector("span").textContent = `${fmtClock(a)} – ${fmtClock(b)}`; } } };
    side.querySelector("#dv-start").addEventListener("change", syncTimes); side.querySelector("#dv-end").addEventListener("change", syncTimes);
    side.querySelector("#dv-rep").addEventListener("change", (e) => { dvSel.rep = Number(e.target.value) || 0; side.querySelector("#dv-until-wrap").hidden = !dvSel.rep; });
    side.querySelector("#dv-until").addEventListener("change", (e) => { dvSel.until = e.target.value; });
    side.querySelector("#dv-save").addEventListener("click", () => saveDesignation(date, kindNow(), side));
  }
  // tithing block details
  ["#dv-f-len", "#dv-f-place", "#dv-f-group"].forEach((sel) => side.querySelector(sel)?.addEventListener("change", async () => {
    const id = dvFocus.slice(2);
    const windows = (season.windows || []).map((w) => w.id === id ? { ...w, len: Number(side.querySelector("#dv-f-len").value), place: side.querySelector("#dv-f-place").value, group: side.querySelector("#dv-f-group").value } : w);
    await saveTithingWindows(windows, "Updated");
  }));
  side.querySelector("#dv-f-remove")?.addEventListener("click", async () => {
    const id = dvFocus.slice(2), b = blocks.find((x) => x.kind === "tithing" && x.id === id);
    if (b && b.slots.some((s) => signups[s.id])) return toast("People are signed up in this block — move or cancel them on the Tithing Declaration page first");
    if (!confirm("Remove this tithing declaration block?")) return;
    dvFocus = null;
    await saveTithingWindows((season.windows || []).filter((w) => w.id !== id), "Block removed");
  });
  // interview slot names
  side.querySelectorAll("[data-iname]").forEach((inp) => {
    const commit = async () => {
      const id = dvFocus.slice(2), ev = events.find((x) => x.id === id); if (!ev) return;
      const next = { ...(ev.slots || {}) }; const v = inp.value.trim();
      if ((next[inp.dataset.iname] || "") === v) return;
      if (v) next[inp.dataset.iname] = v; else delete next[inp.dataset.iname];
      try { await updateDoc(doc(db, "events", id), { slots: next, updatedAt: serverTimestamp() }); toast(v ? "Saved" : "Cleared"); } catch (e) { toast("Couldn't save: " + (e.code || e.message)); }
    };
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); commit(); inp.blur(); } });
    inp.addEventListener("blur", commit);
  });
  side.querySelector("#dv-f-edit")?.addEventListener("click", () => { const ev = events.find((x) => x.id === dvFocus.slice(2)); if (ev) editEvent(ev); });
}
// drag on the empty timeline → a selection; release → the designate form
function wireDrag(grid) {
  if (!can("calendar", "edit")) return;
  let startMin = null, moved = false;
  const minAt = (e) => { const r = grid.getBoundingClientRect(); return clampDay(snap(DAY_START + (e.clientY - r.top + grid.parentElement.scrollTop * 0) / PX_MIN)); };
  grid.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.target.closest("[data-block], .dv-sel")) return;
    startMin = minAt(e); moved = false; dvFocus = null;
    dvSel = { a: startMin, b: startMin + SNAP, kind: dvSel?.kind, len: dvSel?.len };
    grid.setPointerCapture(e.pointerId);
    drawDay();
  });
  grid.addEventListener("pointermove", (e) => {
    if (startMin == null) return;
    const m = minAt(e); moved = true;
    dvSel.a = Math.min(startMin, m); dvSel.b = Math.max(startMin, m);
    if (dvSel.b - dvSel.a < SNAP) dvSel.b = dvSel.a + SNAP;
    const selEl = grid.querySelector(".dv-sel");
    if (selEl) { selEl.style.top = `${(dvSel.a - DAY_START) * PX_MIN}px`; selEl.style.height = `${(dvSel.b - dvSel.a) * PX_MIN}px`; selEl.querySelector("span").textContent = `${fmtClock(dvSel.a)} – ${fmtClock(dvSel.b)}`; }
  });
  const finish = () => {
    if (startMin == null) return;
    startMin = null;
    if (!moved || dvSel.b - dvSel.a < 10) dvSel = { ...dvSel, b: Math.min(DAY_END, dvSel.a + 60) }; // a tap gives an hour to start from
    drawDay();
    document.getElementById("dv-side")?.querySelector("#dv-start")?.scrollIntoView({ block: "nearest" });
  };
  grid.addEventListener("pointerup", finish);
  grid.addEventListener("pointercancel", finish);
}
// the days a repeat covers: this one, then every `step` days up to and including `until`
const addDaysIso = (iso, n) => { const d = new Date(iso + "T12:00:00"); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
function repeatDates(date, step, until) {
  const out = [date];
  if (!step) return out;
  const stop = until && /^\d{4}-\d{2}-\d{2}$/.test(until) ? until : addDaysIso(date, 56);
  for (let d = addDaysIso(date, step), i = 0; d <= stop && i < 60; d = addDaysIso(d, step), i++) out.push(d);
  return out;
}
async function saveDesignation(date, kind, side) {
  const a = toMinutes(side.querySelector("#dv-start").value), b = toMinutes(side.querySelector("#dv-end").value);
  if (!(b > a)) return toast("The end has to be after the start");
  const step = Number(side.querySelector("#dv-rep")?.value) || 0, until = side.querySelector("#dv-until")?.value || "";
  if (step && until && until < date) return toast("The end date is before the first day");
  const dates = repeatDates(date, step, until), many = dates.length > 1;
  try {
    if (kind === "tithing") {
      if (!can("tithing", "edit")) return toast("You can't change tithing declaration times");
      await ensureSeason();
      const len = Number(side.querySelector("#dv-len").value), place = side.querySelector("#dv-place").value, group = side.querySelector("#dv-group").value;
      const adds = dates.map((d) => ({ id: "w" + Math.random().toString(36).slice(2, 9), date: d, start: hhmmOf(a), end: hhmmOf(b), len, place, group }));
      dvSel = null;
      await saveTithingWindows([...(season.windows || []), ...adds], many ? `Tithing declaration times added on ${dates.length} days — they're on the sign-up page now` : "Tithing declaration times added — they're on the sign-up page now");
      return;
    }
    const title = kind === "council" ? "Ward council" : kind === "bishopric" ? "Bishopric meeting" : (side.querySelector("#dv-title")?.value.trim() || (kind === "interviews" ? "Interviews" : ""));
    if (!title) return toast("Give it a title");
    const series = many ? "r" + Math.random().toString(36).slice(2, 9) : null; // the repeats know they belong together
    const base = { title, startTime: hhmmOf(a), endTime: hhmmOf(b), location: "", notes: "", cal: "bishop", createdBy: ctx.uid, createdAt: serverTimestamp(), updatedAt: serverTimestamp(), ...(series ? { series } : {}) };
    if (kind === "interviews") { base.kind = "interviews"; base.len = Number(side.querySelector("#dv-len").value); }
    dvSel = null;
    const made = [];
    for (const d of dates) { const data = { ...base, date: d, ...(kind === "interviews" ? { slots: {} } : {}) }; const ref = await addDoc(collection(db, "events"), data); made.push({ ...data, id: ref.id }); }
    toast(many ? `${title} added on ${dates.length} days` : kind === "interviews" ? "Interview block added — click a slot to put a name on it" : "Added to the Bishop calendar");
    if (kind === "interviews") { dvFocus = "e:" + made[0].id; drawDay(); }
    syncBusy([...events, ...made]);
  } catch (err) { toast("Couldn't save: " + (err.code || err.message)); }
}
// tithing windows live on the season doc; busy + slots are recomputed so the sign-up page stays right
async function ensureSeason() {
  if (season) return;
  const token = Array.from(crypto.getRandomValues(new Uint8Array(12))).map((b) => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31]).join("");
  await setDoc(doc(db, "tithing", token), { open: true, ward: "6th Ward", note: "", windows: [], slots: {}, created: new Date().toISOString(), createdBy: ctx.name || "", createdAt: serverTimestamp() });
  season = { token, open: true, windows: [], slots: {}, blocked: [], busy: {} };
}
async function saveTithingWindows(windows, msg) {
  const busy = busyFromEvents(windows, [...events, ...standingEvents(windows.map((w) => w.date))]);
  await updateDoc(doc(db, "tithing", season.token), { windows, busy, slots: slotMap(windows, [...(season.blocked || []), ...Object.keys(busy)]), updatedAt: serverTimestamp() });
  season = { ...season, windows, busy };
  toast(msg);
  drawDay();
}

// ward council + bishopric meeting times (settings/bishopCal)
function editStanding() {
  const c = bishopCalConfig(), co = c.council || {}, bp = c.bishopric || {};
  const el = openModal(`
    <h3>Standing meetings</h3>
    <p class="row-sub" style="margin-top:-.6rem">These go on the Bishop calendar every week and block tithing declaration sign-up times they overlap.</p>
    <div class="cal-standing">
      <label class="cal-standing-on"><input type="checkbox" id="st-co-on" ${co.on ? "checked" : ""}> <b>Ward council</b> <span class="row-sub">— on each council Sunday chosen on the Ward Council page</span></label>
      <div class="cal-standing-times"><label>From<input type="time" id="st-co-start" step="300" value="${esc(co.start || "")}"></label><label>To<input type="time" id="st-co-end" step="300" value="${esc(co.end || "")}"></label></div>
      <label class="cal-standing-on"><input type="checkbox" id="st-bp-on" ${bp.on ? "checked" : ""}> <b>Bishopric meeting</b> <span class="row-sub">— every week</span></label>
      <div class="cal-standing-times"><label>Day<select id="st-bp-day">${WEEKDAYS.map((w, i) => `<option value="${i}"${Number(bp.weekday ?? 0) === i ? " selected" : ""}>${w}</option>`).join("")}</select></label><label>From<input type="time" id="st-bp-start" step="300" value="${esc(bp.start || "")}"></label><label>To<input type="time" id="st-bp-end" step="300" value="${esc(bp.end || "")}"></label></div>
    </div>
    <div class="modal-actions"><button class="btn" id="st-cancel" type="button">Cancel</button><button class="btn btn-primary" id="st-save" type="button">Save</button></div>`);
  el.querySelector("#st-cancel").addEventListener("click", closeModal);
  el.querySelector("#st-save").addEventListener("click", async () => {
    const v = (id) => el.querySelector(id).value;
    const next = {
      council: { on: el.querySelector("#st-co-on").checked, start: v("#st-co-start"), end: v("#st-co-end") },
      bishopric: { on: el.querySelector("#st-bp-on").checked, weekday: Number(v("#st-bp-day")), start: v("#st-bp-start"), end: v("#st-bp-end") },
      updatedAt: serverTimestamp(),
    };
    if (next.council.on && !next.council.start) return toast("Give ward council a start time");
    if (next.bishopric.on && !next.bishopric.start) return toast("Give the bishopric meeting a start time");
    try { await setDoc(doc(db, "settings", "bishopCal"), next, { merge: true }); closeModal(); toast("Saved"); }
    catch (err) { toast("Couldn't save: " + (err.code || err.message)); }
  });
}

function editEvent(e, defaultDate) {
  const isNew = !e;
  const canEdit = isNew || can("calendar", "edit") || e.createdBy === ctx.uid;
  const el = openModal(`
    <h3>${isNew ? "New event" : canEdit ? "Edit event" : "Event"}</h3>
    <div class="form-grid two-col">
      <label class="field full">Title
        <input id="ev-title" value="${esc(e?.title || "")}" ${canEdit ? "" : "disabled"}>
      </label>
      <label class="field">Date
        <input type="date" id="ev-date" value="${e?.date || defaultDate || todayISO()}" ${canEdit ? "" : "disabled"}>
      </label>
      <label class="field">Calendar
        <select id="ev-cal" ${canEdit ? "" : "disabled"}><option value="ward"${calOf(e || {}) === "ward" && !(isNew && calView === "bishop") ? " selected" : ""}>Ward</option><option value="bishop"${calOf(e || {}) === "bishop" || (isNew && calView === "bishop") ? " selected" : ""}>Bishop</option></select>
      </label>
      <label class="field">Location
        <input id="ev-location" value="${esc(e?.location || "")}" ${canEdit ? "" : "disabled"}>
      </label>
      <label class="field">Start time
        <input type="time" id="ev-start" value="${e?.startTime || ""}" ${canEdit ? "" : "disabled"}>
      </label>
      <label class="field">End time
        <input type="time" id="ev-end" value="${e?.endTime || ""}" ${canEdit ? "" : "disabled"}>
      </label>
      <label class="field full">Notes
        <textarea id="ev-notes" ${canEdit ? "" : "disabled"}>${esc(e?.notes || "")}</textarea>
      </label>
      <div class="full cal-clash hidden" id="ev-clash"></div>
    </div>
    <div class="modal-actions">
      ${!isNew && canEdit ? `<button class="btn btn-ghost btn-danger" id="ev-delete">Delete</button>` : ""}
      <div class="right">
        <button class="btn" id="ev-cancel">Close</button>
        ${canEdit ? `<button class="btn btn-primary" id="ev-save">Save</button>` : ""}
      </div>
    </div>`);
  el.querySelector("#ev-cancel").addEventListener("click", closeModal);
  // a bishop's event on top of tithing-declaration times: say so, and show who is already booked there
  const clashNote = () => {
    const box = el.querySelector("#ev-clash");
    if (el.querySelector("#ev-cal").value !== "bishop" || !season) return box.classList.add("hidden");
    const date = el.querySelector("#ev-date").value, start = el.querySelector("#ev-start").value, end = el.querySelector("#ev-end").value;
    const open = slotsOf(season.windows, offList(season)).filter((s) => s.date === date && !s.blocked && !signups[s.id] && (!start || (toMinutes(start) < s.min + s.len && s.min < (end ? toMinutes(end) : toMinutes(start) + 60)))).length;
    const hits = clashes(date, start, end);
    if (!open && !hits.length) return box.classList.add("hidden");
    box.classList.remove("hidden");
    box.innerHTML = `${open ? `<div>📅 Blocks <b>${open}</b> open tithing declaration time${open === 1 ? "" : "s"} that day${start ? "" : " (all day)"}.</div>` : ""}${hits.length ? `<div class="cal-clash-hit">⚠ Already booked in this time: ${hits.map(esc).join(" · ")}. They stay on the schedule — move them from the Tithing Declaration page if needed.</div>` : ""}`;
  };
  ["#ev-cal", "#ev-date", "#ev-start", "#ev-end"].forEach((sel) => el.querySelector(sel).addEventListener("change", clashNote));
  clashNote();
  el.querySelector("#ev-delete")?.addEventListener("click", async () => {
    if (!confirm("Delete this event?")) return;
    await deleteDoc(doc(db, "events", e.id));
    closeModal(); toast("Event deleted");
    if (calOf(e) === "bishop") syncBusy(events.filter((x) => x.id !== e.id));
  });
  el.querySelector("#ev-save")?.addEventListener("click", async () => {
    const title = el.querySelector("#ev-title").value.trim();
    if (!title) { toast("Event needs a title"); return; }
    const data = {
      title,
      date: el.querySelector("#ev-date").value,
      startTime: el.querySelector("#ev-start").value || null,
      endTime: el.querySelector("#ev-end").value || null,
      location: el.querySelector("#ev-location").value.trim(),
      notes: el.querySelector("#ev-notes").value.trim(),
      cal: el.querySelector("#ev-cal").value === "bishop" ? "bishop" : "ward",
      updatedAt: serverTimestamp(),
    };
    try {
      if (isNew) {
        await addDoc(collection(db, "events"), {
          ...data, createdBy: ctx.uid, createdAt: serverTimestamp(),
        });
      } else {
        await updateDoc(doc(db, "events", e.id), data);
      }
      closeModal(); toast("Saved");
      // the bishop's calendar decides which tithing times are open, so bring the sign-up page up to date
      if (data.cal === "bishop" || (e && calOf(e) === "bishop")) syncBusy([...events.filter((x) => !e || x.id !== e.id), { ...data, id: e?.id || "new" }]);
    } catch (err) {
      toast("Couldn't save: " + (err.code || err.message));
    }
  });
}
