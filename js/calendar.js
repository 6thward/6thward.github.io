// Calendar tab: month grid of ward meetings and the bishop's schedule.
import { db } from "./firebase-init.js?v=1791157953";
import { ctx, hasRole, can } from "./app.js?v=1791157953";
import {
  collection, onSnapshot, addDoc, updateDoc, deleteDoc, doc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { initTithing } from "./tithing.js?v=1791157953";
import { openModal, closeModal, toast, esc, fmtDate, fmtTime, todayISO } from "./ui.js?v=1791157953";

let events = [];
let viewYear, viewMonth; // 0-based month
let started = false;

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
        <p class="panel-sub" id="cal-sub">Meetings, interviews, and ward events. Click a day to add.</p>
      </div>
      <div class="panel-actions">
        ${can("calendar", "edit") ? `<div class="view-toggle" id="cal-view">
          <button class="chip active" data-view="calendar" type="button">Calendar</button>
          <button class="chip" data-view="tithing" type="button">Tithing declaration</button>
        </div>` : ""}
        <button class="btn btn-primary" id="btn-new-event">+ New event</button>
      </div>
    </div>
    <div id="cal-tithing" class="hidden"></div>
    <div id="cal-main">
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
    </div>
    </div>`;

  // Calendar ⇄ Tithing declaration sign-ups (2026-10-04)
  panel.querySelectorAll("#cal-view [data-view]").forEach((b) => b.addEventListener("click", () => {
    const tithing = b.dataset.view === "tithing";
    panel.querySelectorAll("#cal-view .chip").forEach((c) => c.classList.toggle("active", c === b));
    panel.querySelector("#cal-main").classList.toggle("hidden", tithing);
    panel.querySelector("#cal-tithing").classList.toggle("hidden", !tithing);
    panel.querySelector("#btn-new-event").classList.toggle("hidden", tithing);
    panel.querySelector("#cal-sub").textContent = tithing
      ? "Set when you're available, share the link or QR code, and members sign up for a time."
      : "Meetings, interviews, and ward events. Click a day to add.";
    if (tithing) initTithing(panel.querySelector("#cal-tithing"));
  }));

  panel.querySelector("#cal-prev").addEventListener("click", () => shiftMonth(-1));
  panel.querySelector("#cal-next").addEventListener("click", () => shiftMonth(1));
  panel.querySelector("#btn-new-event").addEventListener("click", () => editEvent(null, todayISO()));

  onSnapshot(collection(db, "events"), (qs) => {
    events = qs.docs.map((d) => ({ id: d.id, ...d.data() }));
    render();
  });
  render();
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
  events.forEach((e) => (byDate[e.date] = byDate[e.date] || []).push(e));
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
          <div class="cal-event ${isSunday ? "ev-sunday" : ""}" title="${esc(e.title)}">
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
  const up = events
    .filter((e) => e.date >= today && e.date <= horizonISO)
    .sort((a, b) => (a.date + (a.startTime || "")) < (b.date + (b.startTime || "")) ? -1 : 1);
  document.getElementById("upcoming-list").innerHTML = up.length
    ? up.map((e) => `
      <div class="list-row" data-id="${e.id}">
        <div class="row-main">
          <div class="row-title">${esc(e.title)}</div>
          <div class="row-sub">${fmtDate(e.date)}${e.startTime ? " · " + fmtTime(e.startTime) : ""}${e.endTime ? "–" + fmtTime(e.endTime) : ""}${e.location ? " · " + esc(e.location) : ""}</div>
        </div>
      </div>`).join("")
    : `<div class="empty-note">Nothing on the calendar for the next 30 days.</div>`;
  document.querySelectorAll("#upcoming-list .list-row").forEach((row) =>
    row.addEventListener("click", () => {
      const e = events.find((x) => x.id === row.dataset.id);
      if (e) editEvent(e);
    }));
}

function dayView(date) {
  const dayEvents = events.filter((e) => e.date === date)
    .sort((a, b) => (a.startTime || "") < (b.startTime || "") ? -1 : 1);
  const el = openModal(`
    <h3>${fmtDate(date, { year: true })}</h3>
    ${dayEvents.length ? dayEvents.map((e) => `
      <div class="list-row" data-id="${e.id}">
        <div class="row-main">
          <div class="row-title">${esc(e.title)}</div>
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
  el.querySelectorAll(".list-row").forEach((row) =>
    row.addEventListener("click", () => {
      const e = events.find((x) => x.id === row.dataset.id);
      if (e) editEvent(e);
    }));
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
    </div>
    <div class="modal-actions">
      ${!isNew && canEdit ? `<button class="btn btn-ghost btn-danger" id="ev-delete">Delete</button>` : ""}
      <div class="right">
        <button class="btn" id="ev-cancel">Close</button>
        ${canEdit ? `<button class="btn btn-primary" id="ev-save">Save</button>` : ""}
      </div>
    </div>`);
  el.querySelector("#ev-cancel").addEventListener("click", closeModal);
  el.querySelector("#ev-delete")?.addEventListener("click", async () => {
    if (!confirm("Delete this event?")) return;
    await deleteDoc(doc(db, "events", e.id));
    closeModal(); toast("Event deleted");
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
    } catch (err) {
      toast("Couldn't save: " + (err.code || err.message));
    }
  });
}
