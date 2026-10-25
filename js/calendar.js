// Calendar tab: month grid of ward meetings and the bishop's schedule.
// 2026-10-11 — events belong to the Ward calendar or the Bishop's calendar (cal: "ward" | "bishop").
// Bishop's events block tithing-declaration sign-up times they overlap (tithing/{token}.busy), and
// tithing availability + booked appointments show here as calendar items of their own.
import { db } from "./firebase-init.js?v=1792904286";
import { ctx, hasRole, can, goTab } from "./app.js?v=1792904286";
import {
  collection, onSnapshot, addDoc, updateDoc, deleteDoc, doc, setDoc, serverTimestamp, writeBatch,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { slotsOf, slotMap, busyFromEvents, sameBusy, fmtClock, parseSlotId, offList, isPriority, PRIORITY_TEXT, slotId } from "./tithing-shared.js?v=1792904286";
import { watchBishopCal, bishopCalConfig, standingEvents, WEEKDAYS } from "./bishop-cal.js?v=1792904286";
import { openCouncilDate } from "./council.js?v=1792904286";
import { openModal, closeModal, toast, esc, fmtDate, fmtTime, todayISO } from "./ui.js?v=1792904286";

let events = [];
let users = []; // app users, for the People picker on an event (2026-10-19)
let viewStart; // ISO date of the Sunday the grid starts on — the current week by default, so past weeks aren't shown (2026-10-18)
let started = false;
let calView = "all";          // all | ward | bishop
// Whose schedule a Bishop-calendar item is on (10/24): the bishop's, or a counselor's. Ward items and standing meetings show on all three.
const OWNERS = [["bishop", "Bishop"], ["c1", "1st Counselor"], ["c2", "2nd Counselor"]];
const ownerOf = (e) => (e && OWNERS.some(([k]) => k === e.owner) ? e.owner : "bishop");
const ownerLabel = (k) => OWNERS.find(([x]) => x === k)?.[1] || "Bishop";
const ownerSel = (id, cur, canEdit) => `<select id="${id}" ${canEdit ? "" : "disabled"}>${OWNERS.map(([k, l]) => `<option value="${k}"${(cur || "bishop") === k ? " selected" : ""}>${l}</option>`).join("")}</select>`;
// the three schedule tabs: each shows its own four Sundays
const SCHEDULES = [["bishopsched", "bishop", "Bishop's Schedule"], ["c1sched", "c1", "1st Counselor's Schedule"], ["c2sched", "c2", "2nd Counselor's Schedule"]];
const bsStart = {};             // first of the four Sundays shown, per schedule tab
let season = null, signups = {}, unsubSignups = null; // tithing declaration (only loads for people who can see it)
const calOf = (e) => (e.cal === "bishop" ? "bishop" : "ward");

export function initCalendar() {
  if (started) return;
  started = true;
  viewStart = weekStartOf(todayISO());

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
        <button class="btn btn-sm" id="cal-prev" title="Back 4 weeks">‹</button>
        <h3 id="cal-title"></h3>
        <button class="btn btn-sm" id="cal-next" title="Ahead 4 weeks">›</button>
        <button class="btn btn-sm" id="cal-today" title="Back to this week">Today</button>
      </div>
      <div class="cal-grid" id="cal-grid"></div>
    </div>
    <div class="card">
      <h3>Coming up</h3>
      <div id="upcoming-list"></div>
    </div>`;

  panel.querySelector("#cal-prev").addEventListener("click", () => shiftMonth(-1));
  panel.querySelector("#cal-next").addEventListener("click", () => shiftMonth(1));
  panel.querySelector("#cal-today").addEventListener("click", () => { viewStart = weekStartOf(todayISO()); render(); });
  let lastWeeks = gridWeeks(); window.addEventListener("resize", () => { if (gridWeeks() !== lastWeeks) { lastWeeks = gridWeeks(); render(); } });
  panel.querySelector("#btn-new-event").addEventListener("click", () => editEvent(null, todayISO()));
  panel.querySelector("#btn-standing")?.addEventListener("click", editStanding);
  onSnapshot(collection(db, "users"), (qs) => {
    users = qs.docs.map((d) => ({ uid: d.id, name: d.data().name || "", phone: d.data().phone || "" })).filter((u) => u.name && !qs.docs.find((d) => d.id === u.uid).data().alias && !qs.docs.find((d) => d.id === u.uid).data().revoked && qs.docs.find((d) => d.id === u.uid).data().role !== "pending").sort((a, b) => a.name.localeCompare(b.name));
  }, () => {});
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
      title: `Tithing declaration${isPriority(w) ? " — Priority" : ""}`, sub: `${booked.length} of ${mine.filter((s) => !s.blocked || signups[s.id]).length} booked${w.place === "home" ? " · home visits" : ""}`,
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

// the grid is a rolling six weeks starting on a Sunday; ‹ › page it four weeks at a time
function shiftMonth(delta) {
  viewStart = addDaysIso(viewStart, 28 * delta);
  render();
}

const iso = (y, m, d) =>
  `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
// how many weeks the grid shows: this week + the next three on a desktop (Jordan 10/18); six on a phone, where cells are small
const gridWeeks = () => (window.innerWidth >= 800 ? 4 : 6);
const weekStartOf = (isoDate) => { const d = new Date(isoDate + "T12:00:00"); return addDaysIso(isoDate, -d.getDay()); };
const monthLabel = (isoDate, withYear) => new Date(isoDate + "T12:00:00").toLocaleDateString("en-US", withYear ? { month: "long", year: "numeric" } : { month: "long" });

function render() {
  if (openDay && document.getElementById("dv-grid")) drawDay(); // the open day view follows live changes (2026-10-18)
  const grid = document.getElementById("cal-grid");
  if (!grid) return;
  drawSundays();
  const cells = gridWeeks() * 7;
  const gridDates = Array.from({ length: cells }, (_, i) => addDaysIso(viewStart, i));
  const lastDate = gridDates[cells - 1];
  // "October 2026" when the six weeks sit in one month, else "October – November 2026" (or "December 2026 – January 2027")
  document.getElementById("cal-title").textContent =
    viewStart.slice(0, 7) === lastDate.slice(0, 7) ? monthLabel(viewStart, true)
    : viewStart.slice(0, 4) === lastDate.slice(0, 4) ? `${monthLabel(viewStart)} – ${monthLabel(lastDate, true)}`
    : `${monthLabel(viewStart, true)} – ${monthLabel(lastDate, true)}`;

  const today = todayISO();
  const byDate = {};
  [...events, ...standingEvents(gridDates)].filter(showIt).forEach((e) => (byDate[e.date] = byDate[e.date] || []).push(e));
  if (calView !== "ward" && season) (season.windows || []).forEach((w) => { if (!byDate[w.date] || !byDate[w.date].some((x) => x.tithing)) tithingItems(w.date).forEach((t) => (byDate[w.date] = byDate[w.date] || []).push(t)); });
  Object.values(byDate).forEach((l) => l.sort((a, b) => (a.startTime || "") < (b.startTime || "") ? -1 : 1));

  let html = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
    .map((d) => `<div class="cal-dow">${d}</div>`).join("");

  for (let i = 0; i < cells; i++) {
    const cellDate = gridDates[i];
    const dayNum = Number(cellDate.slice(8));
    // the 1st of a month (and the very first cell) carries its month name so the rolling weeks still read as dates
    const displayNum = dayNum === 1 || i === 0 ? `${new Date(cellDate + "T12:00:00").toLocaleDateString("en-US", { month: "short" })} ${dayNum}` : dayNum;
    const evs = byDate[cellDate] || [];
    const isSunday = i % 7 === 0;
    html += `
      <div class="cal-cell ${cellDate < today ? "other-month" : ""} ${cellDate === today ? "today" : ""}" data-date="${cellDate}">
        <span class="cal-daynum">${displayNum}</span>
        ${evs.slice(0, 7).map((e) => `
          <div class="cal-event ${isSunday ? "ev-sunday" : ""}${e.tithing ? " ev-tithing" : calOf(e) === "bishop" ? " ev-bishop" : ""}${e.standing ? " ev-standing" : ""}${e.kind === "blocked" ? " ev-blocked" : ""}${e.color ? " ev-colored" : ""}"${evStyle(e)} title="${esc(e.title)}${e.sub ? " · " + esc(e.sub) : ""}">
            ${e.startTime ? fmtTime(e.startTime) + " " : ""}${esc(e.title)}
          </div>`).join("")}
        ${evs.length > 7 ? `<div class="cal-event">+${evs.length - 7} more</div>` : ""}
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
  // grouped by day (2026-10-18): a date heading, then that day's items in a compact column
  const byDay = [];
  up.forEach((e) => { const g = byDay[byDay.length - 1]; if (g && g.date === e.date) g.items.push(e); else byDay.push({ date: e.date, items: [e] }); });
  const dayLabel = (d) => d === today ? "Today" : d === addDaysIso(today, 1) ? "Tomorrow" : fmtDate(d);
  document.getElementById("upcoming-list").innerHTML = up.length
    ? byDay.map((g) => `
      <div class="up-day">
        <div class="up-day-h"><b>${esc(dayLabel(g.date))}</b><span class="row-sub">${esc(new Date(g.date + "T12:00:00").toLocaleDateString("en-US", { weekday: "long" }))}</span></div>
        ${g.items.map((e) => `
        <div class="list-row up-row${e.tithing ? " list-row-tithing" : ""}${e.color ? " list-row-colored" : ""}" data-id="${e.id}"${evStyle(e)}>
          <div class="row-main">
            <div class="row-title">${e.tithing ? "🗓 " : calOf(e) === "bishop" ? `<span class="cal-tag cal-tag-bishop"${evStyle(e)}>Bishop</span> ` : ""}${esc(e.title)}</div>
            <div class="row-sub">${e.startTime ? fmtTime(e.startTime) : "All day"}${e.endTime ? "–" + fmtTime(e.endTime) : ""}${e.location ? " · " + esc(e.location) : ""}${e.sub ? " · " + esc(e.sub) : ""}${peopleNames(e.people) ? " · with " + esc(peopleNames(e.people)) : ""}</div>
          </div>
        </div>`).join("")}
      </div>`).join("")
    : `<div class="empty-note">Nothing on the calendar for the next 30 days.</div>`;
  document.querySelectorAll("#upcoming-list .list-row").forEach((row) =>
    row.addEventListener("click", () => {
      if (row.dataset.id.startsWith("t:")) return dayView(up.find((x) => x.id === row.dataset.id)?.date);
      if (/^s[cb]:/.test(row.dataset.id)) return standingDialog(row.dataset.id);
      const e = events.find((x) => x.id === row.dataset.id);
      if (e) editEvent(e);
    }));
}

// ---- the day view: a timeline you drag on (2026-10-18) ----
// Drag out a stretch of the day, then say what it is: tithing declaration (10 / 15 / 20 / 30-minute
// visits — members sign up for them), ward council, bishopric meeting, interviews (slots you put a
// name on), or anything else. Existing events, standing meetings and tithing blocks sit on the same
// timeline so you can see the whole day at once.
const DAY_START = 6 * 60, DAY_END = 22 * 60, PX_MIN = 1.6, SNAP = 5; // 1.6 px a minute: a 10-minute sign-up slot is tall enough for a name (2026-10-18)
// a ward council meeting on the calendar opens that day's agenda on the Ward Council page (2026-10-18)
const isCouncilThing = (x) => x && (x.standing === "council" || /^sc:/.test(x.id || "") || /^ward council$/i.test(x.title || ""));
function openAgenda(date) {
  if (!can("council")) return false;
  closeModal(); openDay = null;
  openCouncilDate(date); goTab("council");
  return true;
}
// what a stretch of the day can be (2026-10-18): a dropdown — tithing and interviews are special (slots),
// the rest are plain Bishop-calendar meetings with a preset title and colour; "Something else" takes any title
const KINDS = [
  ["tithing", "Tithing declaration", "Members sign up for these times through the link / QR"],
  ["interviews", "Interviews", "Slots you fill with names yourself"],
  ["sacrament", "Sacrament meeting", "", "#1f4e79"],
  ["council", "Ward council", "", "#7a4fb5"],
  ["bishopric", "Bishopric meeting", "", "#7a4fb5"],
  ["youthcouncil", "Ward youth council", "", "#2e7d4f"],
  ["stake", "Stake training", "", "#b98a2f"],
  ["bishoptrain", "Bishop training", "", "#b98a2f"],
  ["ymlead", "Young Men leadership", "", "#2e7d4f"],
  ["ywlead", "Young Women leadership", "", "#cf6d96"],
  ["quorum", "Quorum presidency", "", "#1f8a83"],
  ["rspres", "Relief Society presidency", "", "#cf6d96"],
  ["primarypres", "Primary presidency", "", "#dd9257"],
  ["welfare", "Welfare / self-reliance", "", "#1f8a83"],
  ["blocked", "Blocked out", "Not available — nothing gets scheduled here, and tithing times under it are hidden from the sign-up page", "#4b5563"],
  ["other", "Something else…", "Any other appointment on the Bishop calendar"],
];
const kindOf = (k) => KINDS.find((x) => x[0] === k);
// a title that is just "Tithing declaration" (any spelling of declaration) is a sign-up block by default; a longer title
// like "Hansen family — tithing and recommend" is an ordinary appointment (10/22)
const isTithingTitle = (t) => /^\s*tithing(\s+dec\w*)?\s*$/i.test(t || "");
const TITHING_LENS = [10, 15, 20, 30], INTERVIEW_LENS = [10, 15, 20, 30, 60];
// colours a meeting can wear on the calendar (2026-10-18); the same colour shows in the month grid, the day timeline and Coming up
const EV_COLORS = [["#7a4fb5", "Purple"], ["#1f4e79", "Blue"], ["#1f8a83", "Teal"], ["#2e7d4f", "Green"], ["#b98a2f", "Gold"], ["#dd9257", "Orange"], ["#c0392b", "Red"], ["#cf6d96", "Pink"], ["#4b5563", "Grey"]];
const swatches = (id, cur) => `<div class="ev-swatches" id="${id}">${EV_COLORS.map(([c, n]) => `<button type="button" class="ev-swatch${(cur || "") === c ? " on" : ""}" data-color="${c}" style="--c:${c}" title="${n}"></button>`).join("")}</div>`;
const wireSwatches = (box) => box?.querySelectorAll(".ev-swatch").forEach((b) => b.addEventListener("click", () => { const on = b.classList.contains("on"); box.querySelectorAll(".ev-swatch").forEach((x) => x.classList.remove("on")); if (!on) b.classList.add("on"); }));
const swatchValue = (box) => box?.querySelector(".ev-swatch.on")?.dataset.color || "";
const evStyle = (e) => (e && e.color ? ` style="--evc:${esc(e.color)}"` : "");
let openDay = null, dvSel = null, dvFocus = null; // the day that's open, the dragged selection, the block being looked at
let dvRetime = null;
let dvNew = null;     // a new event being written in the side panel: its preset times (from "+ Add event", 10/22)  // an event id waiting for new times: the next drag on the timeline sets them (2026-10-18)
let dragJustHappened = false; // a block was just moved / resized — swallow the click that follows
const hhmmOf = (min) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
const snap = (min) => Math.round(min / SNAP) * SNAP;
const clampDay = (min) => Math.max(DAY_START, Math.min(DAY_END, min));

function dayView(date) {
  if (!date) return;
  openDay = date; dvSel = null; dvFocus = null;
  const el = openModal(`
    <div class="dv-head"><h3>${fmtDate(date, { year: true })}</h3><span class="row-sub" id="dv-hint">${dvRetime ? `<b>Drag the new time for “${esc(events.find((x) => x.id === dvRetime)?.title || "")}”</b> · <a href="#" id="dv-retime-cancel">never mind</a>` : can("calendar", "edit") ? "Drag across the timeline to add something. Drag a block to move it, its bottom edge to stretch it." : ""}</span></div>
    <div class="dv-wrap">
      <div class="dv-grid-wrap"><div class="dv-grid" id="dv-grid"></div></div>
      <div class="dv-side" id="dv-side"></div>
    </div>
    <div class="modal-actions"><div class="right"><button class="btn" id="dv-close">Close</button><button class="btn btn-primary" id="dv-add">+ Add event</button></div></div>`);
  el.classList.add("modal-wide", "cal-dayview");
  el.querySelector("#dv-close").addEventListener("click", () => { openDay = null; dvRetime = null; closeModal(); });
  el.querySelector("#dv-retime-cancel")?.addEventListener("click", (e) => { e.preventDefault(); dvRetime = null; drawDay(); el.querySelector("#dv-hint").textContent = "Drag across the timeline to add something."; });
  el.querySelector("#dv-add").addEventListener("click", () => { dvNew = { startTime: dvSel ? hhmmOf(dvSel.a) : "", endTime: dvSel ? hhmmOf(dvSel.b) : "" }; dvSel = null; dvFocus = "new:"; drawDay(); });
  drawDay();
  wireDrag(el.querySelector("#dv-grid"));
}
// everything on this day as timeline blocks
function dayBlocks(date, who) { // who: a schedule tab's owner — ward items + that person's own + standing; tithing only for the bishop
  const out = [];
  events.filter((e) => e.date === date && showIt(e) && (!who || calOf(e) !== "bishop" || ownerOf(e) === who)).forEach((e) => out.push({ kind: e.kind === "interviews" ? "interviews" : "event", id: e.id, title: e.title, start: e.startTime ? toMinutes(e.startTime) : null, end: e.endTime ? toMinutes(e.endTime) : (e.startTime ? toMinutes(e.startTime) + 60 : null), cal: calOf(e), ev: e }));
  standingEvents([date]).filter(showIt).forEach((e) => out.push({ kind: "standing", id: e.id, title: e.title, start: toMinutes(e.startTime), end: toMinutes(e.endTime), cal: "bishop", ev: { color: e.color || "" }, standing: e.standing }));
  if (season && calView !== "ward" && (!who || who === "bishop")) {
    const slots = slotsOf(season.windows, offList(season)).filter((s) => s.date === date);
    (season.windows || []).filter((w) => w.date === date).forEach((w) => {
      const mine = slots.filter((s) => s.win === w.id);
      out.push({ kind: "tithing", id: w.id, title: "Tithing declaration", start: toMinutes(w.start), end: toMinutes(w.end), cal: "bishop", win: w, slots: mine });
    });
  }
  return out;
}
// one block on a timeline (day view, and the Sundays view) — `style` places it (2026-10-24)
const layoutCols = (timed) => { timed.sort((a, b) => a.start - b.start); const cols = []; timed.forEach((b) => { let c = cols.findIndex((lastEnd) => lastEnd <= b.start); if (c < 0) { c = cols.length; cols.push(0); } cols[c] = b.end; b.col = c; }); return Math.max(1, cols.length); };
function blockMarkup(b, style) {
if (b.kind === "tithing") {
    // every sign-up time is its own row: "11:05 (10 min) The Smiths" as people book, "open" until they do (Jordan 10/18)
    const ticks = b.slots.map((s) => { const su = signups[s.id]; const st = su?.status === "attended" ? " came" : su?.status === "noshow" ? " noshow" : ""; return `<div class="dv-slot${su ? " booked" + st : s.blocked ? " off" : ""}" style="top:${(s.min - b.start) * PX_MIN}px;height:${s.len * PX_MIN}px" title="${fmtClock(s.min)}${su ? " · " + esc(su.name) + (su.phone ? " · " + esc(su.phone) : "") + (st === " came" ? " · came" : st === " noshow" ? " · no-show" : "") : s.blocked ? " · blocked" : " · open"}"><b>${fmtClock(s.min).replace(/ [AP]M$/, "")}</b> <i>(${s.len} min)</i> <span>${st === " came" ? "✓ " : st === " noshow" ? "✗ " : ""}${su ? esc(su.name) : s.blocked ? "blocked" : "open"}</span></div>`; }).join("");
    const booked = b.slots.filter((s) => signups[s.id]).length;
    return `<div class="dv-block dv-tithing dv-slotted${dvFocus === "t:" + b.id ? " dv-focus" : ""}" data-block="t:${esc(b.id)}" style="${style}"><div class="dv-block-tag">Tithing declaration · ${booked}/${b.slots.filter((s) => !s.blocked || signups[s.id]).length} booked</div>${isPriority(b.win) ? `<div class="dv-block-tag dv-block-note">🔒 Priority</div>` : ""}<div class="dv-slots">${ticks}</div></div>`;
  }
  if (b.kind === "interviews") {
    const len = Number(b.ev.len) || 15, names = b.ev.slots || {}; const ticks = [];
    for (let m = b.start; m + len <= b.end; m += len) { const k = hhmmOf(m); ticks.push(`<div class="dv-slot${names[k] ? " booked" : ""}" data-islot="${k}" style="top:${(m - b.start) * PX_MIN}px;height:${len * PX_MIN}px" title="${fmtClock(m)}${names[k] ? " · " + esc(names[k]) : " · open — click to add a name"}"><b>${fmtClock(m).replace(/ [AP]M$/, "")}</b> <i>(${len} min)</i> <span>${names[k] ? esc(names[k]) : "open"}</span></div>`); }
    return `<div class="dv-block dv-interviews dv-slotted${dvFocus === "e:" + b.id ? " dv-focus" : ""}${b.ev.color ? " dv-colored" : ""}" data-block="e:${esc(b.id)}" style="${style}${b.ev.color ? `;--evc:${b.ev.color}` : ""}"><div class="dv-block-tag">${esc(b.title)} · ${Object.keys(names).length}/${ticks.length} filled</div><div class="dv-slots">${ticks.join("")}</div></div>`;
  }
  const cls = b.kind === "standing" ? "dv-standing" : b.ev?.kind === "blocked" ? "dv-blocked" : b.cal === "bishop" ? "dv-bishop" : "dv-ward";
  const colored = b.ev?.color ? `;--evc:${b.ev.color}` : "";
  const who = peopleNames(b.ev?.people), own = b.kind === "event" && b.cal === "bishop" && ownerOf(b.ev) !== "bishop" ? ownerLabel(ownerOf(b.ev)) : "";
  return `<div class="dv-block ${cls}${colored ? " dv-colored" : ""}" data-block="${b.kind === "standing" ? "s:" : "e:"}${esc(b.id)}" style="${style}${colored}" title="${esc(b.title)}${own ? " · " + own : ""}${who ? " · with " + esc(who) : ""}"><div class="dv-block-title">${esc(b.title)} <span>${fmtClock(b.start)}–${fmtClock(b.end)}</span>${own ? `<span class="dv-block-who">· ${own}</span>` : ""}${who ? `<span class="dv-block-who">· ${esc(who)}</span>` : ""}</div></div>`;
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
  const nCols = layoutCols(timed);
  const blockHtml = (b) => blockMarkup(b, `top:${top(Math.max(b.start, DAY_START))}px;height:${h(Math.max(b.start, DAY_START), Math.min(b.end, DAY_END))}px;left:calc(${(b.col / nCols) * 100}% + 2px);width:calc(${100 / nCols}% - 4px)`);
  const selHtml = dvSel ? `<div class="dv-sel" style="top:${top(dvSel.a)}px;height:${h(dvSel.a, dvSel.b)}px"><span>${fmtClock(dvSel.a)} – ${fmtClock(dvSel.b)}</span></div>` : "";
  grid.style.height = `${(DAY_END - DAY_START) * PX_MIN + 20}px`;
  grid.innerHTML = `${hours.join("")}<div class="dv-blocks">${timed.map(blockHtml).join("")}${selHtml}</div>`;
  wireBlockDrag(grid, timed);
  grid.querySelectorAll("[data-block]").forEach((n) => n.addEventListener("click", (e) => {
    e.stopPropagation();
    if (dragJustHappened) { dragJustHappened = false; return; }
    const [t, id] = [n.dataset.block.slice(0, 1), n.dataset.block.slice(2)];
    if (t === "s") return standingDialog(id);
    if (t === "t") { dvFocus = "t:" + id; dvSel = null; drawDay(); return; }
    const ev = events.find((x) => x.id === id);
    if (ev && ev.kind === "interviews") { const k = e.target.closest("[data-islot]")?.dataset.islot; dvFocus = "e:" + id; dvSel = null; drawDay(); if (k) document.getElementById("dv-side")?.querySelector(`[data-iname="${k}"]`)?.focus(); return; }
    if (ev) editEvent(ev);
  }));
  // the side panel: the designate form while something is selected, a block's details when one is clicked, else the day's list.
  // An inline event editor stays put across live redraws so nothing typed is lost; only its time boxes follow a drag.
  const inlineForm = dvFocus && (dvFocus.startsWith("edit:") || dvFocus === "new:");
  if (inlineForm && side.querySelector("#ev-title")) { wireSide(date, blocks, true); return; }
  side.innerHTML = dvSel && !inlineForm ? designateHtml(date) : dvFocus ? focusHtml(date, blocks) : listHtml(date, blocks, allDay);
  wireSide(date, blocks);
}
function listHtml(date, blocks, allDay) {
  const all = [...allDay, ...blocks.filter((b) => b.start != null)].sort((a, b) => (a.start ?? -1) - (b.start ?? -1));
  if (!all.length) return `<div class="empty-note">Nothing on this day yet.${can("calendar", "edit") ? "<br>Drag across the timeline to add something." : ""}</div>`;
  return `<h4 class="dv-side-h">This day</h4>${all.map((b) => `<div class="dv-item dv-item-click dv-item-${b.kind === "tithing" ? "tithing" : b.kind === "standing" ? "standing" : b.cal}" data-open="${b.kind === "tithing" ? "t:" : b.kind === "standing" ? "s:" : "e:"}${esc(b.id)}" title="Click to open"${b.ev?.color ? ` style="border-left-color:${esc(b.ev.color)}"` : ""}><b>${esc(b.title)}</b>${b.kind === "tithing" && isPriority(b.win) ? `<span class="td-tag td-tag-note">🔒 Priority</span>` : ""}<span class="row-sub">${b.start == null ? "All day" : `${fmtClock(b.start)}–${fmtClock(b.end)}`}${b.kind === "tithing" ? ` · ${b.slots.filter((s) => signups[s.id]).length} booked` : ""}${peopleNames(b.ev?.people) ? ` · with ${esc(peopleNames(b.ev.people))}` : ""}</span></div>`).join("")}`;
}
function designateHtml(date) {
  const kinds = KINDS.filter(([k]) => k !== "tithing" || can("tithing", "edit"));
  return `<h4 class="dv-side-h">What is this?</h4>
    <div class="dv-time"><label>From<input type="time" id="dv-start" step="300" value="${hhmmOf(dvSel.a)}"></label><label>To<input type="time" id="dv-end" step="300" value="${hhmmOf(dvSel.b)}"></label></div>
    <div class="dv-opts dv-kindsel"><label>What is it<select id="dv-kind" name="dv-kind"><option value="">Choose…</option>${kinds.map(([k, l]) => `<option value="${k}"${dvSel.kind === k ? " selected" : ""}>${esc(l)}</option>`).join("")}</select></label><div class="row-sub" id="dv-kind-hint"></div></div>
    <div class="dv-opts" id="dv-opts"></div>
    <div class="dv-opts dv-opts-row dv-repeat"><label>Repeat<select id="dv-rep">${repeatChoices(date).map(([v, l]) => `<option value="${v}"${String(dvSel.rep || "0") === v ? " selected" : ""}>${esc(l)}</option>`).join("")}</select></label><label id="dv-until-wrap"${dvSel.rep ? "" : " hidden"}>Until<input type="date" id="dv-until" value="${esc(dvSel.until || addDaysIso(date, 56))}"></label></div>
    ${pickDaysHtml(date, "dv-pick")}
    <div class="dv-err hidden" id="dv-err"></div>
    <div class="dv-form-actions"><button type="button" class="btn" id="dv-cancel">Cancel</button><button type="button" class="btn btn-primary" id="dv-save">Add</button></div>`;
}
// a failed save stays on screen with the reason, instead of a toast that's gone in a blink (2026-10-18)
function showDvError(side, err) {
  console.error("[calendar] save failed", err);
  const box = side.querySelector("#dv-err"); if (!box) return toast("Couldn't save: " + (err.code || err.message || err));
  box.classList.remove("hidden");
  box.textContent = `Couldn't save: ${err.code || ""} ${err.message || err}`.trim();
  const b = side.querySelector("#dv-save"); if (b) { b.disabled = false; b.textContent = "Add"; }
}
function optsHtml(kind) {
  const opt = (v, l, cur) => `<option value="${v}"${String(cur) === String(v) ? " selected" : ""}>${l}</option>`;
  if (kind === "tithing") return `<label>Each visit<select id="dv-len">${TITHING_LENS.map((n) => opt(n, n + " minutes", dvSel.len || 15)).join("")}</select></label>
    <label>Where<select id="dv-place"><option value="office">🏛 Bishop's office</option><option value="home">🏠 Home visits</option></select></label>
    <label class="dv-check"><input type="checkbox" id="dv-pri"> Priority <small>(marked on the sign-up page — the wording is in Tithing Declaration settings)</small></label>`;
  // every appointment gets a Title, prefilled with the kind's name so it can be made specific ("Interviews — youth", "Stake training — Bishops") (Jordan 10/22)
  const title = (ph) => `<label>Title<input id="dv-title" value="${esc(kind === "other" ? "" : kindOf(kind)?.[1] || "")}" placeholder="${esc(ph)}" autocomplete="off"></label><label>Whose schedule${ownerSel("dv-owner", dvSel.owner, true)}</label>`;
  if (kind === "interviews") return `${title("e.g. Interviews — youth")}<label>Each interview<select id="dv-len">${INTERVIEW_LENS.map((n) => opt(n, n + " minutes", dvSel.len || 15)).join("")}</select></label><label>Colour <small>(optional)</small>${swatches("dv-color", dvSel.color)}</label>`;
  const preset = kindOf(kind)?.[3] || "";
  const color = `<label>Colour <small>(optional)</small>${swatches("dv-color", dvSel.color || preset)}</label>`;
  const loc = `<label>Location <small>(optional)</small><input id="dv-loc" placeholder="e.g. Chapel — leave blank if it doesn't matter" autocomplete="off"></label>
    <label>People <small>(optional — who's in this meeting)</small>${peopleHtml("dv-people", [], true)}</label>`;
  return title(kind === "other" ? "e.g. Temple recommend — Hansen" : "") + loc + color;
}
function focusHtml(date, blocks) {
  if (dvFocus === "new:") return `<div class="ev-inline-wrap">${eventFormHtml(null, date, can("calendar", "edit"), true, dvNew)}</div>`;
  if (dvFocus.startsWith("edit:")) {
    const ev = events.find((x) => x.id === dvFocus.slice(5));
    if (!ev) { dvFocus = null; return listHtml(date, blocks, []); }
    return `<div class="ev-inline-wrap">${eventFormHtml(ev, date, can("calendar", "edit") || ev.createdBy === ctx.uid, true)}</div>`;
  }
  const [t, id] = [dvFocus.slice(0, 1), dvFocus.slice(2)];
  const b = blocks.find((x) => (t === "t" ? x.kind === "tithing" : x.kind !== "tithing") && x.id === id);
  if (!b) { dvFocus = null; return listHtml(date, blocks, []); }
  if (t === "t") {
    const w = b.win, booked = b.slots.filter((s) => signups[s.id]);
    const ed = can("tithing", "edit");
    return `<h4 class="dv-side-h">Tithing declaration</h4>
      <div class="row-sub">${fmtClock(b.start)}–${fmtClock(b.end)}${w.place === "home" ? " · 🏠 home visits" : ""}${isPriority(w) ? " · 🔒 priority" : ""}</div>
      ${ed ? `<div class="dv-opts dv-opts-row"><label>Each visit<select id="dv-f-len">${TITHING_LENS.map((n) => `<option value="${n}"${Number(w.len) === n ? " selected" : ""}>${n} min</option>`).join("")}</select></label>
        <label>Where<select id="dv-f-place"><option value="office"${w.place !== "home" ? " selected" : ""}>Bishop's office</option><option value="home"${w.place === "home" ? " selected" : ""}>Home visits</option></select></label></div>
        <div class="dv-opts"><label class="dv-check"><input type="checkbox" id="dv-f-pri" ${isPriority(w) ? "checked" : ""}> Priority <small>(marked on the sign-up page)</small></label>
          <div class="dv-pri-wrap" id="dv-f-priwrap"${isPriority(w) ? "" : " hidden"}>
            <div class="dv-pri-preview" id="dv-f-pripreview" title="Click to change the wording">${esc(w.priorityText || season?.priorityText || PRIORITY_TEXT)}${w.priorityText ? ` <span class="td-tag td-tag-note">changed for this block</span>` : ""}<span class="dv-pri-edit">✎ edit</span></div>
            <div id="dv-f-priedit" hidden>
              <textarea id="dv-f-pritext" rows="3">${esc(w.priorityText || season?.priorityText || PRIORITY_TEXT)}</textarea>
              <label class="dv-check dv-pri-def"><input type="checkbox" id="dv-f-pridef"> Make this the wording for all future weeks too <small>(saves it in Tithing Declaration settings)</small></label>
              ${w.priorityText ? `<button type="button" class="btn btn-sm btn-ghost" id="dv-f-prireset">Use the default wording</button>` : ""}
            </div>
          </div></div>
        <div class="dv-opts dv-opts-row dv-f-repeat"><label>Repeat this block<select id="dv-f-rep">${repeatChoices(date).map(([v, l]) => `<option value="${v}">${esc(v === "0" ? "Doesn't repeat" : l)}</option>`).join("")}</select></label><label id="dv-f-until-wrap" hidden>Until<input type="date" id="dv-f-until" value="${esc(addDaysIso(date, 56))}"></label></div>
        ${pickDaysHtml(date, "dv-f-pick")}` : ""}
      <h4 class="dv-side-h">Times <span class="pill pill-role-member">${booked.length} of ${b.slots.filter((s) => !s.blocked || signups[s.id]).length} booked</span></h4>
      ${ed ? `<div class="row-sub" style="margin:-.2rem 0 .3rem">Type a name on a time to sign someone up yourself (Enter saves); clear it to open the time again. ⊘ blocks a time out so nobody can take it.</div>` : ""}
      <div class="dv-irows">${b.slots.map((s) => { const su = signups[s.id]; const busyT = !su && s.blocked && season.busy?.[s.id];
        return `<div class="dv-irow dv-trow${su ? " booked" : s.blocked ? " off" : ""}"><b>${fmtClock(s.min)}</b>${
          busyT ? `<span class="row-sub" title="On the bishop's calendar">📅 ${esc(busyT)}</span>`
          : !su && s.blocked ? `<span class="row-sub">blocked out</span>${ed ? `<button type="button" class="btn btn-sm btn-ghost" data-tblock="${s.id}" data-on="0" title="Open this time back up">unblock</button>` : ""}`
          : `<input data-tname="${s.id}" value="${esc(su?.name || "")}" placeholder="open" autocomplete="off" ${ed ? "" : "disabled"} title="${su?.phone ? esc(su.phone) : ""}">${ed && !su ? `<button type="button" class="btn btn-sm btn-ghost" data-tblock="${s.id}" data-on="1" title="Block out this time so nobody can sign up for it">⊘</button>` : su && ed ? `<span class="dv-tst" data-tst-for="${s.id}"><button type="button" class="dv-st-btn dv-st-yes${su.status === "attended" ? " on" : ""}" data-tstatus="attended" title="They came">✓</button><button type="button" class="dv-st-btn dv-st-no${su.status === "noshow" ? " on" : ""}" data-tstatus="noshow" title="They didn't come">✗</button></span>` : su?.phone ? `<span class="row-sub dv-tphone">${esc(su.phone)}</span>` : ""}`}</div>`; }).join("")}</div>
      <div class="dv-form-actions">${ed ? `<button type="button" class="btn btn-ghost btn-danger" id="dv-f-remove">Remove block</button>` : ""}<button type="button" class="btn" id="dv-back">Back</button>${ed ? `<button type="button" class="btn btn-primary" id="dv-f-save">Save</button>` : ""}</div>`;
  }
  const ev = b.ev, len = Number(ev.len) || 15, names = ev.slots || {}, ed = can("calendar", "edit") || ev.createdBy === ctx.uid;
  const rows = []; for (let m = b.start; m + len <= b.end; m += len) { const k = hhmmOf(m); rows.push(`<label class="dv-irow"><b>${fmtClock(m)}</b><input data-iname="${k}" value="${esc(names[k] || "")}" placeholder="—" autocomplete="off" ${ed ? "" : "disabled"}></label>`); }
  return `<h4 class="dv-side-h">${esc(ev.title)}</h4><div class="row-sub">${fmtClock(b.start)}–${fmtClock(b.end)} · ${len}-minute slots · type a name on a slot, Enter saves</div>
    <div class="dv-irows">${rows.join("")}</div>
    <div class="dv-form-actions">${ed ? `<button type="button" class="btn" id="dv-f-edit">Edit…</button>` : ""}<button type="button" class="btn" id="dv-back">Back</button></div>`;
}
function wireSide(date, blocks, keep) {
  const side = document.getElementById("dv-side"); if (!side) return;
  if (keep) return; // the inline editor is already wired
  if (dvFocus === "new:" && side.querySelector("#ev-title")) { wireEventForm(side, null, can("calendar", "edit"), () => { dvFocus = null; dvNew = null; drawDay(); }); side.querySelector("#ev-title").focus(); return; }
  if (dvFocus && dvFocus.startsWith("edit:") && side.querySelector("#ev-title")) {
    const ev = events.find((x) => x.id === dvFocus.slice(5));
    if (ev) { wireEventForm(side, ev, can("calendar", "edit") || ev.createdBy === ctx.uid, () => { dvFocus = null; drawDay(); }); return; }
  }
  side.querySelector("#dv-back")?.addEventListener("click", () => { dvFocus = null; drawDay(); });
  // the day's list opens things too — the only handle for an all-day event, which has no block on the timeline (2026-10-18)
  side.querySelectorAll("[data-open]").forEach((row) => row.addEventListener("click", () => {
    const [t, id] = [row.dataset.open.slice(0, 1), row.dataset.open.slice(2)];
    if (t === "s") return standingDialog(id);
    if (t === "t") { dvFocus = "t:" + id; dvSel = null; drawDay(); return; }
    const ev = events.find((x) => x.id === id);
    if (ev && ev.kind === "interviews") { dvFocus = "e:" + id; dvSel = null; drawDay(); return; }
    if (ev) editEvent(ev);
  }));
  side.querySelector("#dv-cancel")?.addEventListener("click", () => { dvSel = null; drawDay(); });
  // designate form
  if (dvSel) {
    const opts = side.querySelector("#dv-opts");
    const kindNow = () => side.querySelector("#dv-kind")?.value || "";
    // nothing is picked to start with: the extra fields (visit length, where, who for) only appear for the kind that needs them
    const redrawOpts = () => { dvSel.kind = kindNow(); opts.innerHTML = dvSel.kind ? optsHtml(dvSel.kind) : ""; wireSwatches(opts.querySelector("#dv-color")); wirePeople(opts.querySelector("#dv-people")); const h = side.querySelector("#dv-kind-hint"); if (h) h.textContent = kindOf(dvSel.kind)?.[2] || ""; const sv = side.querySelector("#dv-save"); if (sv) sv.disabled = !dvSel.kind; side.querySelector(".dv-repeat")?.classList.toggle("hidden", !dvSel.kind); };
    side.querySelector("#dv-kind").addEventListener("change", redrawOpts);
    redrawOpts();
    const syncTimes = () => { const a = toMinutes(side.querySelector("#dv-start").value), b = toMinutes(side.querySelector("#dv-end").value); if (b > a) { dvSel.a = a; dvSel.b = b; const g = document.getElementById("dv-grid"); const selEl = g?.querySelector(".dv-sel"); if (selEl) { selEl.style.top = `${(a - DAY_START) * PX_MIN}px`; selEl.style.height = `${(b - a) * PX_MIN}px`; selEl.querySelector("span").textContent = `${fmtClock(a)} – ${fmtClock(b)}`; } } };
    side.querySelector("#dv-start").addEventListener("change", syncTimes); side.querySelector("#dv-end").addEventListener("change", syncTimes);
    side.querySelector("#dv-rep").addEventListener("change", (e) => { dvSel.rep = e.target.value === "0" ? 0 : e.target.value; });
    wireRepeatSel(side.querySelector("#dv-rep"), side.querySelector("#dv-until-wrap"), side.querySelector("#dv-pick")); wirePickDays(side.querySelector("#dv-pick"));
    side.querySelector("#dv-until").addEventListener("change", (e) => { dvSel.until = e.target.value; });
    side.querySelector("#dv-save").addEventListener("click", () => saveDesignation(date, kindNow(), side));
  }
  // tithing block details
  side.querySelector("#dv-f-pri")?.addEventListener("change", (e) => { const wrap = side.querySelector("#dv-f-priwrap"); if (wrap) wrap.hidden = !e.target.checked; });
  side.querySelector("#dv-f-pripreview")?.addEventListener("click", () => { side.querySelector("#dv-f-pripreview").hidden = true; side.querySelector("#dv-f-priedit").hidden = false; side.querySelector("#dv-f-pritext").focus(); });
  side.querySelector("#dv-f-prireset")?.addEventListener("click", () => { side.querySelector("#dv-f-pritext").value = season?.priorityText || PRIORITY_TEXT; toast("Default wording — press Save"); });
  // Save writes the block's settings and, if a repeat is chosen, adds the block on those days too (Jordan 10/18: "we need a save button")
  side.querySelector("#dv-f-save")?.addEventListener("click", async () => {
    const id = dvFocus.slice(2), priority = !!side.querySelector("#dv-f-pri")?.checked;
    const w0 = (season.windows || []).find((x) => x.id === id); if (!w0) return;
    const { note: _n, group: _g, ...rest } = w0; // the old reserved-for note / group are folded into the checkbox
    const edited = { ...rest, group: "", len: Number(side.querySelector("#dv-f-len").value), place: side.querySelector("#dv-f-place").value, ...(priority ? { priority: true } : {}) };
    // priority wording: the default from settings, or this block's own; "all future weeks" makes it the new default
    delete edited.priorityText;
    const txt = (side.querySelector("#dv-f-pritext")?.value || "").trim(), makeDefault = !!side.querySelector("#dv-f-pridef")?.checked;
    const seasonDefault = season.priorityText || PRIORITY_TEXT;
    if (priority && txt && makeDefault && txt !== seasonDefault) { try { await updateDoc(doc(db, "tithing", season.token), { priorityText: txt }); season = { ...season, priorityText: txt }; } catch (e) { return toast("Couldn't save the wording: " + (e.code || e.message)); } }
    else if (priority && txt && txt !== seasonDefault) edited.priorityText = txt;
    const cur = (season.windows || []).map((w) => (w.id === id ? edited : w));
    const rule = side.querySelector("#dv-f-rep")?.value || "0", until = side.querySelector("#dv-f-until")?.value || "";
    const dates = rule === "0" ? [] : repeatDates(edited.date, rule, until, pickedDays(side.querySelector("#dv-f-pick"))).slice(1)
      .filter((d) => !cur.some((x) => x.date === d && toMinutes(x.start) < toMinutes(edited.end) && toMinutes(edited.start) < toMinutes(x.end)));
    const adds = dates.map((d) => ({ ...edited, id: "w" + Math.random().toString(36).slice(2, 9), date: d }));
    const b = side.querySelector("#dv-f-save"); b.disabled = true; b.textContent = "Saving…";
    try { await saveTithingWindows([...cur, ...adds], adds.length ? `Saved — and added on ${adds.length} more day${adds.length === 1 ? "" : "s"}` : "Saved"); }
    catch (e) { toast("Couldn't save: " + (e.code || e.message)); b.disabled = false; b.textContent = "Save"; }
  });
  // sign someone up (or clear them) straight from the block — for members who don't use the link (Jordan 10/18)
  side.querySelectorAll("[data-tname]").forEach((inp) => {
    const commit = async () => {
      const id = inp.dataset.tname, name = inp.value.trim(), su = signups[id];
      if ((su?.name || "") === name) return;
      const batch = writeBatch(db), at = (c) => doc(db, "tithing", season.token, c, id);
      try {
        if (!name) { if (!confirm(`Remove ${su.name}'s sign-up and open ${fmtClock(parseSlotId(id).min)} back up?`)) { inp.value = su.name; return; } batch.delete(at("signups")); batch.delete(at("taken")); }
        else { const len = season.slots?.[id] || slotsOf(season.windows, []).find((x) => x.id === id)?.len || 15; batch.set(at("taken"), { len, at: serverTimestamp() }); batch.set(at("signups"), { ...(su || {}), name, phone: su?.phone || "", address: su?.address || "", at: su?.at || serverTimestamp(), addedBy: ctx.name || "" }); }
        await batch.commit(); toast(name ? "Signed up" : "Opened up");
      } catch (e) { toast("Couldn't save: " + (e.code || e.message)); }
    };
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); inp.blur(); } });
    inp.addEventListener("blur", commit);
  });
  // came / didn't come — the same field the Tithing Declaration page marks, so both stay in step (Jordan 10/24)
  side.querySelectorAll("[data-tstatus]").forEach((b) => b.addEventListener("click", async () => {
    const id = b.closest("[data-tst-for]").dataset.tstFor, su = signups[id]; if (!su) return;
    const status = su.status === b.dataset.tstatus ? "" : b.dataset.tstatus;
    try { await updateDoc(doc(db, "tithing", season.token, "signups", id), { status, statusAt: serverTimestamp(), statusBy: ctx.name || "" }); toast(status === "attended" ? `${su.name} — came` : status === "noshow" ? `${su.name} — no-show` : "Cleared"); }
    catch (e) { toast("Couldn't save: " + (e.code || e.message)); }
  }));
  side.querySelectorAll("[data-tblock]").forEach((b) => b.addEventListener("click", async () => {
    const id = b.dataset.tblock, on = b.dataset.on === "1";
    const blocked = on ? [...new Set([...(season.blocked || []), id])] : (season.blocked || []).filter((x) => x !== id);
    try {
      await updateDoc(doc(db, "tithing", season.token), { blocked, slots: slotMap(season.windows, [...blocked, ...Object.keys(season.busy || {})]), updatedAt: serverTimestamp() });
      season = { ...season, blocked }; toast(on ? "Blocked out" : "Open again"); drawDay();
    } catch (e) { toast("Couldn't save: " + (e.code || e.message)); }
  }));
  // repeat an existing tithing block onto later dates (2026-10-18)
  wireRepeatSel(side.querySelector("#dv-f-rep"), side.querySelector("#dv-f-until-wrap"), side.querySelector("#dv-f-pick")); wirePickDays(side.querySelector("#dv-f-pick"));
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
// Bishop's Schedule tab (10/24): the next four Sundays as columns, times as rows; every block is drawn like the day view.
// Click a block to open that Sunday with it selected; click empty space to open the Sunday ready to add.
const SUNDAYS_SHOWN = 4;
const nextSunday = () => { const t = todayISO(), s = weekStartOf(t); return s < t ? addDaysIso(s, 7) : s; };
export function initBishopSchedule() { SCHEDULES.forEach(([pid, who, title]) => initSchedule(pid, who, title)); }
function initSchedule(pid, who, title) {
  const panel = document.getElementById("panel-" + pid); if (!panel || panel.dataset.ready) return;
  panel.dataset.ready = "1"; bsStart[pid] = nextSunday();
  panel.innerHTML = `
    <div class="panel-head"><div><h2>${esc(title)}</h2><p class="panel-sub">The next four Sundays side by side${who === "bishop" ? "" : " — ward meetings, standing meetings, and anything put on the " + esc(ownerLabel(who)) + "'s schedule"}. Click anything to change it; click an empty time to add.</p></div>
      <div class="panel-actions">${can("calendar", "edit") ? `<button class="btn" data-standing type="button" title="Ward council and bishopric meeting times">⚙ Standing meetings</button>` : ""}</div></div>
    <div class="card">
      <div class="cal-head"><button class="btn btn-sm" data-prev title="Back 4 Sundays">‹</button><h3 data-title></h3><button class="btn btn-sm" data-next title="Ahead 4 Sundays">›</button><button class="btn btn-sm" data-today title="Back to the coming Sunday">Today</button></div>
      <div class="cal-grid cal-grid-sundays" data-grid></div>
    </div>`;
  panel.querySelector("[data-prev]").addEventListener("click", () => { bsStart[pid] = addDaysIso(bsStart[pid], -7 * SUNDAYS_SHOWN); drawSundays(); });
  panel.querySelector("[data-next]").addEventListener("click", () => { bsStart[pid] = addDaysIso(bsStart[pid], 7 * SUNDAYS_SHOWN); drawSundays(); });
  panel.querySelector("[data-today]").addEventListener("click", () => { bsStart[pid] = nextSunday(); drawSundays(); });
  panel.querySelector("[data-standing]")?.addEventListener("click", editStanding);
  drawSundays();
}
function drawSundays() { SCHEDULES.forEach(([pid, who]) => drawSchedule(pid, who)); }
function drawSchedule(pid, who) {
  const panel = document.getElementById("panel-" + pid), grid = panel?.querySelector("[data-grid]"); if (!grid || !bsStart[pid]) return;
  const dates = Array.from({ length: SUNDAYS_SHOWN }, (_, i) => addDaysIso(bsStart[pid], 7 * i));
  panel.querySelector("[data-title]").textContent = `${fmtDate(dates[0])} – ${fmtDate(dates[dates.length - 1], { year: true })}`;
  const days = dates.map((d) => { const blocks = dayBlocks(d, who); const timed = blocks.filter((b) => b.start != null); const nCols = layoutCols(timed); return { date: d, timed, allDay: blocks.filter((b) => b.start == null), nCols }; });
  // the whole day, 6 AM – 10 PM, in a scrolling panel (Jordan 10/24: "scroll and see the later hours")
  const lo = DAY_START, hi = DAY_END;
  const keepScroll = grid.querySelector(".sv-scroll")?.scrollTop;
  const top = (m) => (m - lo) * PX_MIN, h = (a, b) => Math.max(14, (b - a) * PX_MIN), height = (hi - lo) * PX_MIN;
  const today = todayISO();
  const hours = []; for (let m = lo; m <= hi; m += 60) hours.push(`<div class="dv-hour" style="top:${top(m)}px"><span>${fmtClock(m).replace(":00", "")}</span></div>`);
  grid.innerHTML = `<div class="sv-scroll"><div class="sv-wrap" style="--sv-h:${height}px">
    <div class="sv-gutter"><div class="sv-head"></div><div class="sv-body">${hours.join("")}</div></div>
    ${days.map((d) => `<div class="sv-col${d.date === today ? " sv-today" : ""}${d.date < today ? " sv-past" : ""}" data-sv-date="${d.date}">
      <div class="sv-head" title="Open this Sunday"><div class="sv-date"><b>${esc(fmtDate(d.date))}</b><span class="sv-nth">${ORD[nthOf(d.date)]} Sunday</span></div>${d.allDay.length ? `<div class="sv-allday">${d.allDay.map((b) => `<span class="cal-event${b.cal === "bishop" ? " ev-bishop" : ""}" data-sv-open="${b.kind === "standing" ? "s:" : "e:"}${esc(b.id)}">${esc(b.title)}</span>`).join("")}</div>` : ""}</div>
      <div class="sv-body dv-grid" data-sv-body="${d.date}">${hours.map((x) => x.replace(/<span>.*?<\/span>/, "")).join("")}<div class="dv-blocks">${d.timed.map((b) => blockMarkup(b, `top:${top(Math.max(b.start, lo))}px;height:${h(Math.max(b.start, lo), Math.min(b.end, hi))}px;left:calc(${(b.col / d.nCols) * 100}% + 2px);width:calc(${100 / d.nCols}% - 4px)`)).join("")}</div></div>
    </div>`).join("")}
  </div></div>`;
  const sc = grid.querySelector(".sv-scroll"); sc.scrollTop = keepScroll ?? (6.5 * 60 - lo) * PX_MIN; // first draw opens at 6:30 AM; redraws keep the place
  // open a Sunday with the clicked block selected, or ready to add at the clicked time
  const openAt = (date, focus) => { dayView(date); if (focus) { dvFocus = focus; drawDay(); } };
  grid.querySelectorAll("[data-block]").forEach((n) => n.addEventListener("click", (e) => {
    e.stopPropagation();
    const date = n.closest("[data-sv-date]").dataset.svDate, [t, id] = [n.dataset.block.slice(0, 1), n.dataset.block.slice(2)];
    if (t === "s") return standingDialog(id);
    if (t === "t") return openAt(date, "t:" + id);
    const ev = events.find((x) => x.id === id);
    if (ev && ev.kind === "interviews") return openAt(date, "e:" + id);
    if (ev) return openAt(date, "edit:" + id);
  }));
  grid.querySelectorAll("[data-sv-open]").forEach((n) => n.addEventListener("click", (e) => { e.stopPropagation(); const [t, id] = [n.dataset.svOpen.slice(0, 1), n.dataset.svOpen.slice(2)]; if (t === "s") return standingDialog(id); const ev = events.find((x) => x.id === id); if (ev) { dayView(n.closest("[data-sv-date]").dataset.svDate); dvFocus = "edit:" + id; drawDay(); } }));
  grid.querySelectorAll(".sv-head").forEach((n) => n.addEventListener("click", () => { const d = n.closest("[data-sv-date]")?.dataset.svDate; if (d) dayView(d); }));
  grid.querySelectorAll("[data-sv-body]").forEach((n) => n.addEventListener("click", (e) => {
    const date = n.dataset.svBody; if (!can("calendar", "edit")) return dayView(date);
    const r = n.getBoundingClientRect(), m = clampDay(snap(lo + (e.clientY - r.top) / PX_MIN)); // open the Sunday with that hour picked, ready to add
    dayView(date); dvSel = { a: m, b: Math.min(DAY_END, m + 60), kind: "", len: 15, owner: who }; drawDay();
    document.getElementById("dv-grid")?.parentElement?.scrollTo({ top: Math.max(0, (m - DAY_START) * PX_MIN - 120) });
  }));
}
// drag on the empty timeline → a selection; release → the designate form
function wireDrag(grid) {
  if (!can("calendar", "edit")) return;
  let startMin = null, moved = false;
  const minAt = (e) => { const r = grid.getBoundingClientRect(); return clampDay(snap(DAY_START + (e.clientY - r.top + grid.parentElement.scrollTop * 0) / PX_MIN)); };
  grid.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.target.closest("[data-block], .dv-sel")) return;
    startMin = minAt(e); moved = false;
    if (!(dvFocus && (dvFocus.startsWith("edit:") || dvFocus === "new:"))) dvFocus = null; // an inline editor stays open: the drag is its new time
    dvSel = { a: startMin, b: startMin + SNAP, kind: "", len: dvSel?.len };
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
  const finish = async () => {
    if (startMin == null) return;
    startMin = null;
    if (!moved || dvSel.b - dvSel.a < 10) dvSel = { ...dvSel, b: Math.min(DAY_END, dvSel.a + 60) }; // a tap gives an hour to start from
    if (dvFocus === "new:") { // writing a new event in the side panel: the drag fills its times, nothing is saved until Save
      const { a, b } = dvSel; dvSel = null;
      const side = document.getElementById("dv-side"); if (side?.querySelector("#ev-start")) { side.querySelector("#ev-start").value = hhmmOf(a); side.querySelector("#ev-end").value = hhmmOf(b); }
      drawDay(); return;
    }
    if (!dvRetime && dvFocus && dvFocus.startsWith("edit:")) dvRetime = dvFocus.slice(5); // editing in the side panel: a drag on empty time is this event's new time
    if (dvRetime) { // the editor asked for new times: apply them to that event and stop
      const id = dvRetime, { a, b } = dvSel; dvRetime = null; dvSel = null;
      const side = document.getElementById("dv-side"); if (dvFocus === "edit:" + id && side?.querySelector("#ev-start")) { side.querySelector("#ev-start").value = hhmmOf(a); side.querySelector("#ev-end").value = hhmmOf(b); }
      try { await updateDoc(doc(db, "events", id), { startTime: hhmmOf(a), endTime: hhmmOf(b), updatedAt: serverTimestamp() }); toast(`Set to ${fmtClock(a)} – ${fmtClock(b)}`); syncBusy(events.map((x) => x.id === id ? { ...x, startTime: hhmmOf(a), endTime: hhmmOf(b) } : x)); }
      catch (err) { toast("Couldn't save: " + (err.code || err.message)); }
      drawDay(); const h = document.getElementById("dv-hint"); if (h) h.textContent = "Drag across the timeline to add something.";
      return;
    }
    drawDay();
    document.getElementById("dv-side")?.querySelector("#dv-start")?.scrollIntoView({ block: "nearest" });
  };
  grid.addEventListener("pointerup", finish);
  grid.addEventListener("pointercancel", finish);
}
// the days a repeat covers: this one, then every `step` days up to and including `until`
const addDaysIso = (iso, n) => { const d = new Date(iso + "T12:00:00"); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
// the choices offered for this day: weekly ones plus monthly ones worded for the day picked ("every 4th Sunday")
const WD = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const nthOf = (iso) => Math.ceil(new Date(iso + "T12:00:00").getDate() / 7);
const isLastOfMonth = (iso) => { const d = new Date(iso + "T12:00:00"); return d.getDate() + 7 > new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate(); };
const ORD = ["", "1st", "2nd", "3rd", "4th", "5th"];
function repeatChoices(date) {
  const d = new Date(date + "T12:00:00"), wd = WD[d.getDay()], n = nthOf(date);
  const out = [["0", "Just this day"], ["7", "Every week"], ["14", "Every 2 weeks"], ["m-nth", `Every month — ${ORD[n]} ${wd}`]];
  if (isLastOfMonth(date)) out.push(["m-last", `Every month — last ${wd}`]);
  out.push(["m-date", `Every month — the ${d.getDate()}${[1, 21, 31].includes(d.getDate()) ? "st" : [2, 22].includes(d.getDate()) ? "nd" : [3, 23].includes(d.getDate()) ? "rd" : "th"}`]);
  out.push(["pick", `Pick the ${wd}s…`]); // click the exact days, like the ward council dates (Jordan 10/18)
  return out;
}
// "Pick the days": the next 26 same-weekday dates as day chips grouped by month; click to toggle (same look as the council dates)
function pickDaysHtml(date, id) {
  const days = Array.from({ length: 26 }, (_, i) => addDaysIso(date, 7 * (i + 1)));
  const months = [...new Set(days.map((d) => d.slice(0, 7)))];
  return `<div class="dv-pick" id="${id}">
    <div class="dv-pick-head"><b>Also on these ${WD[new Date(date + "T12:00:00").getDay()]}s</b><span><button type="button" class="btn btn-sm btn-ghost" data-pickall="1">All</button><button type="button" class="btn btn-sm btn-ghost" data-pickall="0">None</button></span></div>
    ${months.map((mk) => `<div class="dv-pick-month"><div class="dv-pick-mname">${new Date(mk + "-15T12:00:00").toLocaleDateString("en-US", { month: "long", year: "numeric" })}</div><div class="dv-pick-days">${days.filter((d) => d.slice(0, 7) === mk).map((d) => `<button type="button" class="wcd-day" data-d="${d}" title="${esc(fmtDate(d))}">${Number(d.slice(8))}</button>`).join("")}</div></div>`).join("")}
  </div>`;
}
function wirePickDays(box) {
  if (!box) return;
  box.querySelectorAll(".wcd-day").forEach((b) => b.addEventListener("click", () => b.classList.toggle("on")));
  box.querySelectorAll("[data-pickall]").forEach((b) => b.addEventListener("click", () => box.querySelectorAll(".wcd-day").forEach((d) => d.classList.toggle("on", b.dataset.pickall === "1"))));
}
const pickedDays = (box) => (box ? [...box.querySelectorAll(".wcd-day.on")].map((b) => b.dataset.d).sort() : []);
// a repeat select drives one Until box and one day picker: Until for the rules, the picker for "pick"
function wireRepeatSel(sel, untilWrap, pickBox) {
  if (!sel) return;
  const sync = () => { const v = sel.value; if (untilWrap) untilWrap.hidden = v === "0" || v === "pick"; if (pickBox) pickBox.hidden = v !== "pick"; };
  sel.addEventListener("change", sync); sync();
}
const isoOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
function repeatDates(date, rule, until, picked) {
  const out = [date];
  if (!rule || rule === "0") return out;
  if (rule === "pick") return [...out, ...(picked || []).filter((d) => d !== date)];
  const stop = until && /^\d{4}-\d{2}-\d{2}$/.test(until) ? until : addDaysIso(date, 56);
  const step = Number(rule);
  if (step) { for (let d = addDaysIso(date, step), i = 0; d <= stop && i < 60; d = addDaysIso(d, step), i++) out.push(d); return out; }
  const first = new Date(date + "T12:00:00"), wd = first.getDay(), n = nthOf(date), dom = first.getDate();
  for (let k = 1; k <= 36; k++) {
    const y = first.getFullYear(), m = first.getMonth() + k;
    let d;
    if (rule === "m-date") { d = new Date(y, m, Math.min(dom, new Date(y, m + 1, 0).getDate())); }
    else if (rule === "m-last") { d = new Date(y, m + 1, 0); while (d.getDay() !== wd) d.setDate(d.getDate() - 1); }
    else { d = new Date(y, m, 1); while (d.getDay() !== wd) d.setDate(d.getDate() + 1); d.setDate(d.getDate() + 7 * (n - 1)); if (d.getMonth() !== ((m % 12) + 12) % 12) continue; } // a 5th Sunday some months don't have
    const iso = isoOf(d);
    if (iso > stop) break;
    out.push(iso);
  }
  return out;
}
// drag a timed event block to move it; drag its bottom edge to stretch it (2026-10-18)
function wireBlockDrag(grid, timed) {
  timed.forEach((b) => {
    const isTithing = b.kind === "tithing"; // tithing blocks move too (Jordan 10/24); sign-ups move with them
    if (isTithing ? !can("tithing", "edit") : (b.kind !== "event" && b.kind !== "interviews")) return;
    const ev = b.ev; if (!isTithing && (!ev || !(can("calendar", "edit") || ev.createdBy === ctx.uid))) return;
    const n = grid.querySelector(`[data-block="${isTithing ? "t" : "e"}:${CSS.escape(b.id)}"]`); if (!n) return;
    n.classList.add("dv-movable");
    n.insertAdjacentHTML("beforeend", `<div class="dv-resize" title="Drag to change the end time"></div>`);
    let mode = null, startY = 0, moved = false, ns = b.start, ne = b.end;
    n.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || e.target.closest("[data-islot]")) return;
      mode = e.target.classList.contains("dv-resize") ? "resize" : "move"; startY = e.clientY; moved = false; ns = b.start; ne = b.end;
      if (isTithing && mode === "resize" && b.slots.some((x) => signups[x.id])) { mode = null; return toast("People are signed up in this block — move the whole block instead, or change its length on the Tithing Declaration page"); }
      n.setPointerCapture(e.pointerId); e.stopPropagation();
    });
    n.addEventListener("pointermove", (e) => {
      if (!mode) return;
      const dy = snap((e.clientY - startY) / PX_MIN);
      if (Math.abs(dy) >= SNAP) moved = true;
      if (!moved) return;
      if (mode === "move") { const len = b.end - b.start; ns = Math.max(DAY_START, Math.min(DAY_END - len, b.start + dy)); ne = ns + len; }
      else { ne = Math.max(b.start + SNAP, Math.min(DAY_END, b.end + dy)); ns = b.start; }
      n.style.top = `${(ns - DAY_START) * PX_MIN}px`; n.style.height = `${Math.max(14, (ne - ns) * PX_MIN)}px`;
      const t = n.querySelector(".dv-block-title span"); if (t) t.textContent = `${fmtClock(ns)}–${fmtClock(ne)}`;
      if (isTithing) n.querySelectorAll(".dv-slot b").forEach((el, i) => { const m = ns + i * b.win.len; if (m + b.win.len <= ne) el.textContent = fmtClock(m).replace(/ [AP]M$/, ""); });
    });
    const done = async (e) => {
      if (!mode) return;
      const m = mode; mode = null;
      if (!moved) return; // a plain click — the click handler opens it
      e.stopPropagation(); dragJustHappened = true; setTimeout(() => { dragJustHappened = false; }, 300);
      if (isTithing) return moveTithingBlock(b, ns, ne);
      const side = document.getElementById("dv-side");
      if (dvFocus === "edit:" + b.id && side?.querySelector("#ev-start")) { side.querySelector("#ev-start").value = hhmmOf(ns); side.querySelector("#ev-end").value = hhmmOf(ne); }
      try {
        await updateDoc(doc(db, "events", b.id), { startTime: hhmmOf(ns), endTime: hhmmOf(ne), updatedAt: serverTimestamp() });
        toast(m === "move" ? `Moved to ${fmtClock(ns)} – ${fmtClock(ne)}` : `Now ends at ${fmtClock(ne)}`);
        syncBusy(events.map((x) => x.id === b.id ? { ...x, startTime: hhmmOf(ns), endTime: hhmmOf(ne) } : x));
      } catch (err) { toast("Couldn't save: " + (err.code || err.message)); drawDay(); }
    };
    n.addEventListener("pointerup", done); n.addEventListener("pointercancel", done);
  });
}
// a tithing block dragged to a new time: the window moves, and every sign-up in it moves to the same place in the new block (10/24)
async function moveTithingBlock(b, ns, ne) {
  const w = b.win, delta = ns - b.start;
  const booked = b.slots.filter((x) => signups[x.id]);
  if (booked.length && delta && !confirm(`${booked.length} ${booked.length === 1 ? "person is" : "people are"} signed up in this block. Move ${booked.length === 1 ? "their time" : "their times"} by ${Math.abs(delta)} minutes ${delta > 0 ? "later" : "earlier"} too?`)) { drawDay(); return; }
  try {
    if (booked.length && delta) {
      const batch = writeBatch(db), at = (c, id) => doc(db, "tithing", season.token, c, id);
      booked.forEach((x) => { const nid = slotId(w.date, x.min + delta); batch.set(at("signups", nid), signups[x.id]); batch.set(at("taken", nid), { len: x.len, at: serverTimestamp() }); batch.delete(at("signups", x.id)); batch.delete(at("taken", x.id)); });
      await batch.commit();
    }
    const windows = (season.windows || []).map((x) => (x.id === w.id ? { ...x, start: hhmmOf(ns), end: hhmmOf(ne) } : x));
    await saveTithingWindows(windows, `Moved to ${fmtClock(ns)} – ${fmtClock(ne)}${booked.length && delta ? " — sign-ups moved too; let them know" : ""}`);
  } catch (err) { toast("Couldn't move: " + (err.code || err.message)); drawDay(); }
}
async function saveDesignation(date, kind, side) {
  const saveBtn = side.querySelector("#dv-save");
  if (!kind) return toast("Pick what this is first");
  if (saveBtn?.disabled) return; // already saving
  const a = toMinutes(side.querySelector("#dv-start").value), b = toMinutes(side.querySelector("#dv-end").value);
  if (!(b > a)) return toast("The end has to be after the start");
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = "Saving…"; }
  const rule = side.querySelector("#dv-rep")?.value || "0", until = side.querySelector("#dv-until")?.value || "";
  if (rule !== "0" && until && until < date) return toast("The end date is before the first day");
  const dates = repeatDates(date, rule, until, pickedDays(side.querySelector("#dv-pick"))), many = dates.length > 1;
  try {
    if (kind === "tithing") {
      if (!can("tithing", "edit")) return toast("You can't change tithing declaration times");
      await ensureSeason();
      const len = Number(side.querySelector("#dv-len").value), place = side.querySelector("#dv-place").value, group = "", priority = !!side.querySelector("#dv-pri")?.checked;
      const adds = dates.map((d) => ({ id: "w" + Math.random().toString(36).slice(2, 9), date: d, start: hhmmOf(a), end: hhmmOf(b), len, place, group, ...(priority ? { priority: true } : {}) }));
      await saveTithingWindows([...(season.windows || []), ...adds], many ? `Tithing declaration times added on ${dates.length} days — they're on the sign-up page now` : "Tithing declaration times added — they're on the sign-up page now");
      dvSel = null; drawDay();
      return;
    }
    const title = side.querySelector("#dv-title")?.value.trim() || (kind === "other" ? "" : kindOf(kind)?.[1] || "");
    if (kind === "other" && isTithingTitle(title) && can("tithing", "edit")) { // typed "Tithing declaration" under Something else: it's a sign-up block by default
      await ensureSeason();
      const adds = dates.map((d) => ({ id: "w" + Math.random().toString(36).slice(2, 9), date: d, start: hhmmOf(a), end: hhmmOf(b), len: 15, place: "office", group: "" }));
      await saveTithingWindows([...(season.windows || []), ...adds], "Added as tithing declaration sign-up times (15-minute visits — change that on the block)");
      dvSel = null; drawDay(); return;
    }
    if (!title) { if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = "Add"; } return toast("Give it a title"); }
    const series = many ? "r" + Math.random().toString(36).slice(2, 9) : null; // the repeats know they belong together
    const color = swatchValue(side.querySelector("#dv-color"));
    const base = { title, startTime: hhmmOf(a), endTime: hhmmOf(b), location: side.querySelector("#dv-loc")?.value.trim() || "", people: peopleValue(side.querySelector("#dv-people")), notes: "", ...(color ? { color } : {}), cal: "bishop", owner: side.querySelector("#dv-owner")?.value || "bishop", createdBy: ctx.uid, createdAt: serverTimestamp(), updatedAt: serverTimestamp(), ...(series ? { series } : {}) };
    if (kind === "interviews") { base.kind = "interviews"; base.len = Number(side.querySelector("#dv-len").value); }
    if (kind === "blocked") base.kind = "blocked"; // drawn hatched, reads as unavailable (Jordan 10/24)
    const made = [];
    for (const d of dates) { const data = { ...base, date: d, ...(kind === "interviews" ? { slots: {} } : {}) }; const ref = await addDoc(collection(db, "events"), data); made.push({ ...data, id: ref.id }); }
    dvSel = null;
    toast(many ? `${title} added on ${dates.length} days` : kind === "interviews" ? "Interview block added — click a slot to put a name on it" : "Added to the Bishop calendar");
    if (kind === "interviews") dvFocus = "e:" + made[0].id;
    drawDay();
    syncBusy([...events, ...made]);
  } catch (err) { showDvError(side, err); }
}
// tithing windows live on the season doc; busy + slots are recomputed so the sign-up page stays right
async function ensureSeason() {
  if (season) return;
  const token = Array.from(crypto.getRandomValues(new Uint8Array(12))).map((b) => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31]).join("");
  await setDoc(doc(db, "tithing", token), { open: true, ward: "6th Ward", note: "", windows: [], slots: {}, created: new Date().toISOString(), createdBy: ctx.name || "", createdAt: serverTimestamp() });
  season = { token, open: true, windows: [], slots: {}, blocked: [], busy: {} };
}
async function saveTithingWindows(windows, msg, dropIds = []) { // dropIds: events being removed at the same time, so they don't count as busy
  const busy = busyFromEvents(windows, [...events.filter((x) => !dropIds.includes(x.id)), ...standingEvents(windows.map((w) => w.date))]);
  await updateDoc(doc(db, "tithing", season.token), { windows, busy, slots: slotMap(windows, [...(season.blocked || []), ...Object.keys(busy)]), updatedAt: serverTimestamp() });
  season = { ...season, windows, busy };
  toast(msg);
  drawDay();
}

// a standing meeting on the calendar (2026-10-18): see its time, pick a colour, change the time, or jump to the agenda
function standingDialog(id) {
  const kind = id.startsWith("sc:") ? "council" : "bishopric", date = id.slice(3);
  const cfg = bishopCalConfig()[kind] || {}, label = kind === "council" ? "Ward council" : "Bishopric meeting";
  const editable = can("calendar", "edit") || (kind === "council" && can("council", "edit"));
  const el = openModal(`
    <h3>${label}</h3>
    <p class="row-sub" style="margin-top:-.6rem">${esc(fmtDate(date, { year: true }))} · ${fmtTime(cfg.start)}${cfg.end ? "–" + fmtTime(cfg.end) : ""} · ${kind === "council" ? "on every council Sunday" : "every " + WEEKDAYS[Number(cfg.weekday ?? 0)]}</p>
    ${editable ? `<div class="field"><span>Colour <span class="row-sub">(optional)</span></span>${swatches("st-color", cfg.color)}</div>` : ""}
    <div class="ev-agenda" style="display:flex;gap:.4rem;flex-wrap:wrap">
      ${kind === "council" && can("council") ? `<button type="button" class="btn btn-sm" id="st-agenda">📋 Open this day's agenda</button>` : ""}
      ${editable ? `<button type="button" class="btn btn-sm" id="st-time">🕒 Change the time…</button>` : ""}
    </div>
    <div class="modal-actions"><div class="right"><button class="btn" id="st-close" type="button">Close</button>${editable ? `<button class="btn btn-primary" id="st-save" type="button">Save</button>` : ""}</div></div>`);
  el.querySelector("#st-close").addEventListener("click", closeModal);
  el.querySelector("#st-agenda")?.addEventListener("click", () => openAgenda(date));
  el.querySelector("#st-time")?.addEventListener("click", () => { closeModal(); editStanding(); });
  wireSwatches(el.querySelector("#st-color"));
  el.querySelector("#st-save")?.addEventListener("click", async () => {
    const color = swatchValue(el.querySelector("#st-color"));
    try { await setDoc(doc(db, "settings", "bishopCal"), { [kind]: { ...cfg, color }, updatedAt: serverTimestamp() }, { merge: true }); closeModal(); toast("Saved"); }
    catch (err) { toast("Couldn't save: " + (err.code || err.message)); }
  });
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

// People on an event (2026-10-19): pick an app user from the list or type any name; Enter / comma adds, ✕ removes
const peopleNames = (list) => (list || []).map((p) => p.name).filter(Boolean).join(", ");
function peopleHtml(id, list, canEdit) {
  return `<div class="ev-people" id="${id}">
    <div class="ev-chips">${(list || []).map((p) => `<span class="ev-chip${p.uid ? " ev-chip-user" : ""}" data-uid="${esc(p.uid || "")}" data-name="${esc(p.name)}">${esc(p.name)}${canEdit ? `<button type="button" class="ev-chip-x" title="Remove">✕</button>` : ""}</span>`).join("")}</div>
    ${canEdit ? `<input class="ev-people-in" list="ev-people-dl" placeholder="Add a person — pick a user or type a name, Enter adds" autocomplete="off">
    <datalist id="ev-people-dl">${users.map((u) => `<option value="${esc(u.name)}"></option>`).join("")}</datalist>` : ""}
  </div>`;
}
function wirePeople(box) {
  if (!box) return;
  const chips = box.querySelector(".ev-chips"), inp = box.querySelector(".ev-people-in");
  const add = (name) => {
    name = name.trim().replace(/,$/, "").trim(); if (!name) return;
    if ([...chips.querySelectorAll(".ev-chip")].some((c) => c.dataset.name.toLowerCase() === name.toLowerCase())) return;
    const u = users.find((x) => x.name.toLowerCase() === name.toLowerCase());
    const chip = document.createElement("span"); chip.className = "ev-chip" + (u ? " ev-chip-user" : ""); chip.dataset.uid = u?.uid || ""; chip.dataset.name = u?.name || name;
    chip.innerHTML = `${esc(u?.name || name)}<button type="button" class="ev-chip-x" title="Remove">✕</button>`;
    chips.appendChild(chip);
  };
  chips.addEventListener("click", (e) => { const x = e.target.closest(".ev-chip-x"); if (x) x.closest(".ev-chip").remove(); });
  if (!inp) return;
  inp.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(inp.value); inp.value = ""; } });
  inp.addEventListener("change", () => { if (users.some((u) => u.name === inp.value.trim())) { add(inp.value); inp.value = ""; } }); // picked from the list
  inp.addEventListener("blur", () => { add(inp.value); inp.value = ""; });
}
const peopleValue = (box) => (box ? [...box.querySelectorAll(".ev-chip")].map((c) => ({ name: c.dataset.name, ...(c.dataset.uid ? { uid: c.dataset.uid } : {}) })) : []);
// The event form: the same fields whether it opens as its own window or inside the day view's side
// panel (2026-10-18 — Jordan: see the timeline and the settings at the same time). `root` is wherever
// it was drawn; `done()` closes it.
function eventFormHtml(e, defaultDate, canEdit, inline, preset) {
  const isNew = !e;
  const st = e?.startTime || preset?.startTime || "", en = e?.endTime || preset?.endTime || "";
  return `
    <h3>${isNew ? "New event" : canEdit ? "Edit event" : "Event"}</h3>
    <div class="form-grid two-col${inline ? " ev-inline" : ""}">
      <label class="field full">Title
        <input id="ev-title" value="${esc(e?.title || "")}" ${canEdit ? "" : "disabled"}>
      </label>
      ${e && !e.tithing && isTithingTitle(e.title) && can("tithing", "edit") ? `<div class="full ev-tithing-hint">This is a plain appointment — members can't sign up for it. Save turns it into a sign-up block (15-minute visits; change that on the block afterwards). <button type="button" class="btn btn-sm" id="ev-make-tithing">Make it a sign-up block now</button></div>
      <label class="field full ev-series"><input type="checkbox" id="ev-pri"> <span>Priority time slots <span class="row-sub">(marked on the sign-up page — the wording is in Tithing Declaration settings)</span></span></label>` : ""}
      <label class="field">Date
        <input type="date" id="ev-date" value="${e?.date || defaultDate || todayISO()}" ${canEdit ? "" : "disabled"}>
      </label>
      <label class="field">Calendar
        <select id="ev-cal" ${canEdit ? "" : "disabled"}><option value="ward"${calOf(e || {}) === "ward" && !(isNew && calView === "bishop") ? " selected" : ""}>Ward</option><option value="bishop"${calOf(e || {}) === "bishop" || (isNew && calView === "bishop") ? " selected" : ""}>Bishop</option></select>
      </label>
      <label class="field" id="ev-owner-wrap"${(e ? calOf(e) : (calView === "bishop" ? "bishop" : "ward")) === "bishop" ? "" : " hidden"}>Whose schedule
        ${ownerSel("ev-owner", e?.owner || preset?.owner, canEdit)}
      </label>
      <label class="field">Start time
        <input type="time" id="ev-start" value="${st}" ${canEdit ? "" : "disabled"}>
      </label>
      <label class="field">End time
        <input type="time" id="ev-end" value="${en}" ${canEdit ? "" : "disabled"}>
      </label>
      ${inline && canEdit ? `<div class="full row-sub ev-inline-hint">Drag the block on the timeline to move it, its bottom edge to stretch it, or drag across empty time to set it — the times fill in here.</div>` : ""}
      <label class="field full">Location <span class="row-sub">(optional)</span>
        <input id="ev-location" value="${esc(e?.location || "")}" ${canEdit ? "" : "disabled"}>
      </label>
      <div class="field full"><span>People <span class="row-sub">(optional — who's in this meeting)</span></span>${peopleHtml("ev-people", e?.people, canEdit)}</div>
      <label class="field full">Notes
        <textarea id="ev-notes" ${canEdit ? "" : "disabled"}>${esc(e?.notes || "")}</textarea>
      </label>
      <div class="field full"><span>Colour <span class="row-sub">(optional)</span></span>${swatches("ev-color", e?.color)}</div>
      ${e?.series ? `<label class="field full ev-series"><input type="checkbox" id="ev-series"> <span>Also change the other repeats of this meeting (title, times, location, colour)</span></label>` : canEdit ? `
      <label class="field">Repeat<select id="ev-rep">${repeatChoices(e?.date || defaultDate || todayISO()).map(([v, l]) => `<option value="${v}">${esc(v === "0" ? "Doesn't repeat" : l)}</option>`).join("")}</select></label>
      <label class="field" id="ev-until-wrap" hidden>Until<input type="date" id="ev-until" value="${esc(addDaysIso(e?.date || defaultDate || todayISO(), 56))}"></label>
      <div class="full" id="ev-pick-wrap" hidden>${pickDaysHtml(e?.date || defaultDate || todayISO(), "ev-pick")}</div>` : ""}
      <div class="full cal-clash hidden" id="ev-clash"></div>
    </div>
    ${!isNew && canEdit && !inline ? `<div class="ev-agenda"><button type="button" class="btn btn-sm" id="ev-retime" title="Open the day's timeline with this event ready to drag">⏱ Edit on the timeline</button></div>` : ""}
    ${!isNew && isCouncilThing(e) && can("council") ? `<div class="ev-agenda"><button type="button" class="btn btn-sm" id="ev-agenda">📋 Open this day's ward council agenda</button></div>` : ""}
    <div class="modal-actions">
      ${!isNew && canEdit ? `<button class="btn btn-ghost btn-danger" id="ev-delete">Delete</button>` : ""}
      <div class="right">
        <button class="btn" id="ev-cancel">${inline ? "Back" : "Close"}</button>
        ${canEdit ? `<button class="btn btn-primary" id="ev-save">Save</button>` : ""}
      </div>
    </div>`;
}
function wireEventForm(root, e, canEdit, done) {
  const isNew = !e;
  root.querySelector("#ev-cancel").addEventListener("click", done);
  root.querySelector("#ev-agenda")?.addEventListener("click", () => openAgenda(e.date));
  root.querySelector("#ev-retime")?.addEventListener("click", () => { closeModal(); dvFocus = "edit:" + e.id; dayView(e.date); });
  wireSwatches(root.querySelector("#ev-color"));
  wirePeople(root.querySelector("#ev-people"));
  root.querySelector("#ev-cal").addEventListener("change", (ev) => { const w = root.querySelector("#ev-owner-wrap"); if (w) w.hidden = ev.target.value !== "bishop"; });
  // a bishop's event on top of tithing-declaration times: say so, and show who is already booked there
  const clashNote = () => {
    const box = root.querySelector("#ev-clash");
    if (root.querySelector("#ev-cal").value !== "bishop" || !season) return box.classList.add("hidden");
    const date = root.querySelector("#ev-date").value, start = root.querySelector("#ev-start").value, end = root.querySelector("#ev-end").value;
    const open = slotsOf(season.windows, offList(season)).filter((s) => s.date === date && !s.blocked && !signups[s.id] && (!start || (toMinutes(start) < s.min + s.len && s.min < (end ? toMinutes(end) : toMinutes(start) + 60)))).length;
    const hits = clashes(date, start, end);
    if (!open && !hits.length) return box.classList.add("hidden");
    box.classList.remove("hidden");
    box.innerHTML = `${open ? `<div>📅 Blocks <b>${open}</b> open tithing declaration time${open === 1 ? "" : "s"} that day${start ? "" : " (all day)"}.</div>` : ""}${hits.length ? `<div class="cal-clash-hit">⚠ Already booked in this time: ${hits.map(esc).join(" · ")}. They stay on the schedule — move them from the Tithing Declaration page if needed.</div>` : ""}`;
  };
  ["#ev-cal", "#ev-date", "#ev-start", "#ev-end"].forEach((sel) => root.querySelector(sel).addEventListener("change", clashNote));
  clashNote();
  wireRepeatSel(root.querySelector("#ev-rep"), root.querySelector("#ev-until-wrap"), root.querySelector("#ev-pick-wrap")); wirePickDays(root.querySelector("#ev-pick"));
  // a plain event someone typed as "Tithing declaration" becomes a real sign-up block (same day and times; 15-minute office visits)
  root.querySelector("#ev-make-tithing")?.addEventListener("click", async () => {
    if (!e.startTime || !e.endTime) return toast("Give it a start and end time first");
    const mine = e.series ? events.filter((x) => x.series === e.series && x.startTime && x.endTime) : [e];
    if (!confirm(`Turn ${mine.length === 1 ? "this appointment" : `these ${mine.length} appointments`} into tithing declaration sign-up times (15-minute visits at the Bishop's office)?`)) return;
    try {
      await ensureSeason();
      const cur = season.windows || [];
      const pri = !!root.querySelector("#ev-pri")?.checked;
      const adds = mine.filter((x) => !cur.some((w) => w.date === x.date && toMinutes(w.start) < toMinutes(x.endTime) && toMinutes(x.startTime) < toMinutes(w.end)))
        .map((x) => ({ id: "w" + Math.random().toString(36).slice(2, 9), date: x.date, start: x.startTime, end: x.endTime, len: 15, place: "office", group: "", ...(pri ? { priority: true } : {}) }));
      await Promise.all(mine.map((x) => deleteDoc(doc(db, "events", x.id))));
      await saveTithingWindows([...cur, ...adds], `${adds.length} sign-up block${adds.length === 1 ? "" : "s"} added — on the sign-up page now`, mine.map((x) => x.id));
      done();
    } catch (err) { toast("Couldn't convert: " + (err.code || err.message)); }
  });
  // Delete: a repeating meeting asks which ones — just this date, this and the later ones, or the whole series
  root.querySelector("#ev-delete")?.addEventListener("click", async () => {
    const del = async (ids, msg) => {
      try {
        await Promise.all(ids.map((id) => deleteDoc(doc(db, "events", id))));
        done(); toast(msg);
        if (calOf(e) === "bishop") syncBusy(events.filter((x) => !ids.includes(x.id)));
      } catch (err) { toast("Couldn't delete: " + (err.code || err.message)); }
    };
    if (!e.series) { if (confirm("Delete this event?")) del([e.id], "Event deleted"); return; }
    const mine = events.filter((x) => x.series === e.series);
    const later = mine.filter((x) => x.date >= e.date);
    const box = root.querySelector("#ev-delwrap") || (() => { const d = document.createElement("div"); d.id = "ev-delwrap"; d.className = "ev-delwrap"; root.querySelector(".modal-actions").before(d); return d; })();
    box.innerHTML = `<b>This meeting repeats (${mine.length} dates). Delete…</b>
      <div class="ev-delopts">
        <button type="button" class="btn btn-sm" data-del="one">Just this one (${esc(fmtDate(e.date))})</button>
        <button type="button" class="btn btn-sm" data-del="later">This and the later ones (${later.length})</button>
        <button type="button" class="btn btn-sm btn-ghost btn-danger" data-del="all">All ${mine.length}</button>
        <button type="button" class="btn btn-sm btn-ghost" data-del="cancel">Keep it</button>
      </div>`;
    box.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => {
      const w = b.dataset.del;
      if (w === "cancel") { box.remove(); return; }
      if (w === "one") del([e.id], "Removed this date only — the other repeats stay");
      else if (w === "later") del(later.map((x) => x.id), `Removed ${later.length} dates from ${fmtDate(e.date)} on`);
      else del(mine.map((x) => x.id), `Removed all ${mine.length} dates`);
    }));
  });
  root.querySelector("#ev-save")?.addEventListener("click", async () => {
    const title = root.querySelector("#ev-title").value.trim();
    if (!title) { toast("Event needs a title"); return; }
    const data = {
      title,
      date: root.querySelector("#ev-date").value,
      startTime: root.querySelector("#ev-start").value || null,
      endTime: root.querySelector("#ev-end").value || null,
      location: root.querySelector("#ev-location").value.trim(),
      people: peopleValue(root.querySelector("#ev-people")),
      color: swatchValue(root.querySelector("#ev-color")) || null,
      notes: root.querySelector("#ev-notes").value.trim(),
      cal: root.querySelector("#ev-cal").value === "bishop" ? "bishop" : "ward",
      owner: root.querySelector("#ev-cal").value === "bishop" ? (root.querySelector("#ev-owner")?.value || "bishop") : "bishop",
      updatedAt: serverTimestamp(),
    };
    const rule = root.querySelector("#ev-rep")?.value || "0", until = root.querySelector("#ev-until")?.value || "";
    const repeats = rule !== "0" ? repeatDates(data.date, rule, until, pickedDays(root.querySelector("#ev-pick"))).slice(1) : [];
    // "Tithing declaration" is a sign-up block by default (Jordan 10/18): save it as sign-up times, not a plain appointment
    if (isTithingTitle(title) && can("tithing", "edit")) {
      if (!data.startTime || !data.endTime) return toast("Give it a start and end time — sign-up times need both");
      try {
        await ensureSeason();
        const cur = season.windows || [];
        const pri = !!root.querySelector("#ev-pri")?.checked;
        const adds = [data.date, ...repeats].filter((d) => !cur.some((w) => w.date === d && toMinutes(w.start) < toMinutes(data.endTime) && toMinutes(data.startTime) < toMinutes(w.end)))
          .map((d) => ({ id: "w" + Math.random().toString(36).slice(2, 9), date: d, start: data.startTime, end: data.endTime, len: 15, place: "office", group: "", ...(pri ? { priority: true } : {}) }));
        const olds = e ? (e.series ? events.filter((x) => x.series === e.series) : [e]) : [];
        await Promise.all(olds.map((x) => deleteDoc(doc(db, "events", x.id))));
        await saveTithingWindows([...cur, ...adds], `${adds.length} sign-up block${adds.length === 1 ? "" : "s"} added — on the sign-up page now`, olds.map((x) => x.id));
        done();
      } catch (err) { toast("Couldn't save: " + (err.code || err.message)); }
      return;
    }
    if (repeats.length) data.series = "r" + Math.random().toString(36).slice(2, 9); // this one and its copies belong together
    try {
      if (isNew) {
        await addDoc(collection(db, "events"), { ...data, createdBy: ctx.uid, createdAt: serverTimestamp() });
      } else {
        await updateDoc(doc(db, "events", e.id), data);
        if (e.series && root.querySelector("#ev-series")?.checked) { // the other repeats take everything but the date
          const { date: _d, ...shared } = data;
          await Promise.all(events.filter((x) => x.series === e.series && x.id !== e.id).map((x) => updateDoc(doc(db, "events", x.id), shared)));
        }
      }
      for (const d of repeats) await addDoc(collection(db, "events"), { ...data, date: d, createdBy: ctx.uid, createdAt: serverTimestamp() });
      done(); toast(repeats.length ? `Saved — and added on ${repeats.length} more day${repeats.length === 1 ? "" : "s"}` : "Saved");
      // the bishop's calendar decides which tithing times are open, so bring the sign-up page up to date
      if (data.cal === "bishop" || (e && calOf(e) === "bishop")) syncBusy([...events.filter((x) => !e || x.id !== e.id), { ...data, id: e?.id || "new" }]);
    } catch (err) {
      toast("Couldn't save: " + (err.code || err.message));
    }
  });
}
// from the day view, an existing event edits in the side panel beside the timeline; elsewhere it's a window
function editEvent(e, defaultDate) {
  const canEdit = !e || can("calendar", "edit") || e.createdBy === ctx.uid;
  if (e && openDay === e.date && document.getElementById("dv-grid")) { dvFocus = "edit:" + e.id; dvSel = null; drawDay(); return; }
  const el = openModal(eventFormHtml(e, defaultDate, canEdit, false));
  wireEventForm(el, e, canEdit, closeModal);
}
