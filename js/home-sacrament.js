// Home Sacrament — the homebound roster (name + address) and, per Sunday,
// who was at church and who needs the sacrament brought to them.
//
// Shares data with the Sacrament tab so nothing is entered twice:
//   settings/homebound.people[]  { id, name, address }      (same roster as ⚙ Settings)
//   meetings/{date}.hbSkip[]      ids marked "at church" that Sunday
//   meetings/{date}.hbOn          true once attendance is being tracked
// The 🏠 button on each Sunday's card still assigns who takes it.
import { db } from "./firebase-init.js?v=1789346871";
import { ctx, can } from "./app.js?v=1789346871";
import {
  doc, getDoc, setDoc, updateDoc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { toast, esc, openModal, closeModal, fmtDate } from "./ui.js?v=1789346871";

let people = [];
let date = "";          // selected Sunday, YYYY-MM-DD
let meeting = null;     // that Sunday's meeting doc (or null)
let started = false;

const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function upcomingSunday(from = new Date()) {
  const d = new Date(from); d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + ((7 - d.getDay()) % 7));
  return iso(d);
}
function shiftSunday(isoDate, weeks) {
  const d = new Date(isoDate + "T12:00:00"); d.setDate(d.getDate() + 7 * weeks); return iso(d);
}

export function initHomeSacrament() {
  if (started) return;
  started = true;
  date = upcomingSunday();
  const panel = document.getElementById("panel-homesac");
  panel.innerHTML = `
    <div class="panel-head">
      <div>
        <h2>Home Sacrament</h2>
        <p class="panel-sub">Who receives the sacrament at home. Mark who made it to church each Sunday — everyone else needs a visit.</p>
      </div>
      ${can("sacrament", "edit") ? `<button class="btn btn-primary" id="hs-add">+ Add person</button>` : ""}
    </div>
    <div class="hs-nav">
      <button class="btn btn-sm" id="hs-prev" title="Previous Sunday">‹</button>
      <div class="hs-date" id="hs-date"></div>
      <button class="btn btn-sm" id="hs-next" title="Next Sunday">›</button>
      <button class="btn btn-sm" id="hs-today">This Sunday</button>
    </div>
    <div id="hs-body"><div class="empty-note">Loading…</div></div>`;
  panel.querySelector("#hs-prev").addEventListener("click", () => { date = shiftSunday(date, -1); load(); });
  panel.querySelector("#hs-next").addEventListener("click", () => { date = shiftSunday(date, 1); load(); });
  panel.querySelector("#hs-today").addEventListener("click", () => { date = upcomingSunday(); load(); });
  panel.querySelector("#hs-add")?.addEventListener("click", () => editPerson(null));
  load();
}

async function load() {
  try {
    const hb = await getDoc(doc(db, "settings", "homebound"));
    people = hb.exists() && Array.isArray(hb.data().people) ? hb.data().people : [];
  } catch { people = []; }
  try {
    const m = await getDoc(doc(db, "meetings", date));
    meeting = m.exists() ? m.data() : null;
  } catch { meeting = null; }
  render();
}

function render() {
  const body = document.getElementById("hs-body");
  const dateEl = document.getElementById("hs-date");
  if (!body) return;
  const editor = can("sacrament", "edit");
  const today = upcomingSunday();
  dateEl.textContent = fmtDate(date, { year: true }) + (date === today ? " · this Sunday" : "");
  const skip = new Set(meeting?.hbSkip || []);
  const need = people.filter((p) => !skip.has(p.id));
  const atChurch = people.filter((p) => skip.has(p.id));
  const specialType = meeting && meeting.type && !["sacrament", "fast", "primary", "christmas", "easter", "other"].includes(meeting.type);

  if (!people.length) {
    body.innerHTML = `<div class="card"><div class="empty-note">No homebound members yet.${editor ? " Use “+ Add person” to start the list." : ""}</div></div>`;
    return;
  }

  body.innerHTML = `
    ${specialType ? `<div class="conf-banner" style="margin-bottom:.8rem">This Sunday is marked <b>${esc(meeting.type)}</b> on the Sacrament tab — there may be no regular sacrament meeting.</div>` : ""}
    <div class="card">
      <h3 style="margin:0 0 .2rem;display:flex;align-items:center;gap:.5rem">Take the sacrament to <span class="pill ${need.length ? "pill-overdue" : "pill-done"}">${need.length}</span>
        <span class="row-sub" style="font-weight:400;margin-left:auto">${atChurch.length} at church · ${people.length} on the list</span></h3>
      <p class="row-sub" style="margin:0 0 .6rem">Everyone needs the sacrament unless marked at church.${editor ? " Click “At church?” when someone makes it." : ""}</p>
      <div class="hs-list">
        ${people.map((p) => {
          const here = skip.has(p.id);
          return `
          <div class="hs-row${here ? " hs-here" : " hs-need"}" data-id="${p.id}">
            <div class="hs-who">
              <div class="hs-name">${esc(p.name)}</div>
              <div class="hs-addr">${p.address ? esc(p.address) : "<span class='row-sub'>no address</span>"}</div>
            </div>
            <div class="hs-status">
              ${editor
                ? `<button class="hs-here-btn${here ? " on" : ""}" type="button" title="${here ? "Marked at church — click to undo" : "Click if they made it to church this Sunday"}">${here ? "✓ At church" : "At church?"}</button>`
                : `<span class="pill ${here ? "pill-done" : "pill-overdue"}">${here ? "At church" : "Needs sacrament"}</span>`}
              ${editor ? `<button class="btn btn-sm hs-edit" title="Edit name / address">✎</button>` : ""}
            </div>
          </div>`;
        }).join("")}
      </div>
      <p class="row-sub" style="margin:.7rem 0 0">Who takes it: use the 🏠 button on this Sunday's card on the Sacrament tab.</p>
    </div>`;

  if (!editor) return;
  body.querySelectorAll(".hs-row").forEach((row) => {
    const p = people.find((x) => x.id === row.dataset.id);
    row.querySelector(".hs-here-btn").addEventListener("click", () => setStatus(p, !skip.has(p.id))); // one toggle: default = needs the sacrament
    row.querySelector(".hs-edit").addEventListener("click", () => editPerson(p));
  });
}

// Mark one person at church / needing the sacrament for the selected Sunday.
async function setStatus(p, atChurch) {
  const skip = new Set(meeting?.hbSkip || []);
  if (atChurch) skip.add(p.id); else skip.delete(p.id);
  const hbSkip = [...skip];
  try {
    const ref = doc(db, "meetings", date);
    if (meeting) {
      await updateDoc(ref, { hbSkip, hbOn: true, updatedAt: serverTimestamp() });
      meeting.hbSkip = hbSkip; meeting.hbOn = true;
    } else {
      // no plan for this Sunday yet — keep just the attendance fields; the
      // Sacrament tab fills in the agenda when someone plans the day
      await setDoc(ref, { date, hbSkip, hbOn: true, updatedAt: serverTimestamp() }, { merge: true });
      meeting = { date, hbSkip, hbOn: true };
    }
    render();
  } catch (e) { toast("Couldn't save: " + (e.code || e.message)); }
}

function editPerson(p) {
  const isNew = !p;
  const el = openModal(`
    <h3>${isNew ? "Add a homebound member" : "Edit " + esc(p.name)}</h3>
    <div class="form-grid">
      <label class="field"><span>Name</span><input id="hs-pname" value="${esc(p?.name || "")}" autocomplete="off"></label>
      <label class="field"><span>Address</span><input id="hs-paddr" value="${esc(p?.address || "")}" placeholder="619 E 400 S" autocomplete="off"></label>
    </div>
    <div class="modal-actions">
      ${isNew ? "<span></span>" : `<button class="btn btn-ghost btn-danger" id="hs-pdel">Remove from list</button>`}
      <div style="display:flex;gap:.5rem">
        <button class="btn" id="hs-pcancel">Cancel</button>
        <button class="btn btn-primary" id="hs-psave">${isNew ? "Add" : "Save"}</button>
      </div>
    </div>`);
  setTimeout(() => el.querySelector("#hs-pname").focus(), 30);
  el.querySelector("#hs-pcancel").addEventListener("click", closeModal);
  const save = async () => {
    const name = el.querySelector("#hs-pname").value.trim();
    const address = el.querySelector("#hs-paddr").value.trim();
    if (!name) { toast("Enter a name"); return; }
    const next = isNew
      ? [...people, { id: "hb" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name, address }]
      : people.map((x) => (x.id === p.id ? { ...x, name, address } : x));
    await savePeople(next); closeModal();
  };
  el.querySelector("#hs-psave").addEventListener("click", save);
  el.querySelectorAll("input").forEach((i) => i.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); save(); } }));
  el.querySelector("#hs-pdel")?.addEventListener("click", async () => {
    if (!confirm(`Remove ${p.name} from the homebound list?`)) return;
    await savePeople(people.filter((x) => x.id !== p.id)); closeModal();
  });
}

async function savePeople(next) {
  try {
    await setDoc(doc(db, "settings", "homebound"), { people: next });
    people = next;
    toast("Saved");
    render();
  } catch (e) { toast("Couldn't save: " + (e.code || e.message)); }
}
