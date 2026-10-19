// Calendar tab: month grid of ward meetings and the bishop's schedule.
// 2026-10-11 — events belong to the Ward calendar or the Bishop's calendar (cal: "ward" | "bishop").
// Bishop's events block tithing-declaration sign-up times they overlap (tithing/{token}.busy), and
// tithing availability + booked appointments show here as calendar items of their own.
import { db } from "./firebase-init.js?v=1792372178";
import { ctx, hasRole, can } from "./app.js?v=1792372178";
import {
  collection, onSnapshot, addDoc, updateDoc, deleteDoc, doc, setDoc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { slotsOf, slotMap, busyFromEvents, sameBusy, fmtClock, parseSlotId, offList } from "./tithing-shared.js?v=1792372178";
import { watchBishopCal, bishopCalConfig, standingEvents, WEEKDAYS } from "./bishop-cal.js?v=1792372178";
import { openModal, closeModal, toast, esc, fmtDate, fmtTime, todayISO } from "./ui.js?v=1792372178";

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

function dayView(date) {
  if (!date) return;
  const dayEvents = [...events.filter((e) => e.date === date && showIt(e)), ...standingEvents([date]).filter(showIt), ...(calView !== "ward" ? tithingItems(date) : [])]
    .sort((a, b) => (a.startTime || "") < (b.startTime || "") ? -1 : 1);
  const el = openModal(`
    <h3>${fmtDate(date, { year: true })}</h3>
    ${dayEvents.length ? dayEvents.map((e) => e.tithing ? `
      <div class="list-row list-row-tithing">
        <div class="row-main">
          <div class="row-title">🗓 ${esc(e.title)} <span class="row-sub">${fmtTime(e.startTime)}–${fmtTime(e.endTime)} · ${esc(e.sub)}</span></div>
          ${e.booked.length ? `<div class="cal-booked">${e.booked.map((b) => `<span><b>${fmtClock(b.min)}</b> ${esc(b.name)}</span>`).join("")}</div>` : `<div class="row-sub">Nobody signed up yet.</div>`}
        </div>
      </div>` : `
      <div class="list-row" data-id="${e.id}">
        <div class="row-main">
          <div class="row-title">${calOf(e) === "bishop" ? `<span class="cal-tag cal-tag-bishop">Bishop</span> ` : ""}${esc(e.title)}</div>
          <div class="row-sub">${e.startTime ? fmtTime(e.startTime) : "All day"}${e.endTime ? "–" + fmtTime(e.endTime) : ""}${e.location ? " · " + esc(e.location) : ""}${e.notes ? " · " + esc(e.notes) : ""}</div>
        </div>
      </div>`).join("") : `<div class="empty-note">No events.</div>`}
    <div class="modal-actions">
      <div class="right">
        <button class="btn" id="dv-close">Close</button>
        <button class="btn btn-primary" id="dv-add">+ Add event</button>
      </div>
    </div>`);
  el.querySelector("#dv-close").addEventListener("click", closeModal);
  el.querySelector("#dv-add").addEventListener("click", () => editEvent(null, date));
  el.querySelectorAll(".list-row[data-id]").forEach((row) =>
    row.addEventListener("click", () => {
      if (/^s[cb]:/.test(row.dataset.id)) return can("calendar", "edit") ? editStanding() : undefined;
      const e = events.find((x) => x.id === row.dataset.id);
      if (e) editEvent(e);
    }));
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
