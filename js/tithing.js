// Tithing declaration sign-ups (2026-10-04) — the bishop's side, its own page
// ("Tithing Declaration" tab, area key "tithing"): set when you're available, share the link / QR code, and see
// who signed up. The public page is tithing.html (js/tithing-form.js).
import { db } from "./firebase-init.js?v=1791171944";
import { ctx, can } from "./app.js?v=1791171944";
import {
  collection, doc, onSnapshot, setDoc, updateDoc, writeBatch, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { openModal, closeModal, toast } from "./ui.js?v=1791171944";
import {
  GROUPS, PLACES, SLOT_LENGTHS, esc, toMin, fmtClock, fmtLongDay, fmtShortDay, slotsOf, slotMap,
  sortWindows, overlaps, newToken, parseSlotId, todayIso, addDays, hhmm,
} from "./tithing-shared.js?v=1791171944";

let mount = null, season = null, signups = [], unsubSignups = null, started = false, dirty = false;
let qrCache = { url: "", data: "" }, qrLib = null;
let schedView = "cols"; // schedule: every day side by side in columns, or one long list with phone numbers
let listFilter = "all"; // the year list: all | attended | pending | noshow
const STATUS = { attended: "Attended", noshow: "Didn't come" };
// the "add a time period" form keeps its values between adds (handy for several Sundays in a row)
const form = { date: "", start: "14:00", end: "16:00", len: 15, place: "office", group: "", repeat: [], repOpen: false };
const REPEAT_WEEKS = 12; // how many following weeks the "Repeat on" list offers
const mdDay = (iso) => { const d = new Date(iso + "T12:00:00"); return `${d.toLocaleDateString("en-US", { weekday: "short" })} ${d.getMonth() + 1}/${d.getDate()}`; };

const seasonRef = () => doc(db, "tithing", season.token);
const linkUrl = () => new URL("tithing.html?k=" + season.token, location.href).href;
const rangeText = (w) => `${fmtClock(toMin(w.start))} – ${fmtClock(toMin(w.end))}`;

// the page shell: a heading, then everything else is drawn by initTithing
export function initTithingPage() {
  const panel = document.getElementById("panel-tithing");
  if (!panel || panel.dataset.ready) return;
  panel.dataset.ready = "1";
  panel.innerHTML = `
    <div class="panel-head">
      <div>
        <h2>Tithing Declaration</h2>
        <p class="panel-sub">Set when you're available, share the link or QR code, and members sign up for a time.</p>
      </div>
    </div>
    <div id="td-root"></div>`;
  initTithing(panel.querySelector("#td-root"));
}

export function initTithing(el) {
  mount = el;
  if (started) { render(); return; }
  started = true;
  mount.innerHTML = `<div class="empty-note">Loading…</div>`;
  mount.addEventListener("focusout", () => setTimeout(() => { if (dirty) render(); }, 60));
  document.addEventListener("click", (e) => { const d = mount.querySelector("#tdf-rep[open]"); if (d && !d.contains(e.target)) { d.open = false; form.repOpen = false; } });
  onSnapshot(collection(db, "tithing"), (qs) => {
    const all = qs.docs.map((d) => ({ token: d.id, ...d.data() })).sort((a, b) => String(b.created || "").localeCompare(String(a.created || "")));
    const next = all[0] || null;
    if ((next && next.token) !== (season && season.token)) {
      if (unsubSignups) unsubSignups();
      signups = [];
      unsubSignups = next ? onSnapshot(collection(db, "tithing", next.token, "signups"), (s) => {
        signups = s.docs.map((d) => ({ id: d.id, ...d.data() }));
        render();
      }, () => {}) : null;
    }
    season = next;
    render();
  }, (e) => { mount.innerHTML = `<div class="empty-note">Couldn't load tithing declaration sign-ups (${esc(e.code || e.message)}).</div>`; });
}

// ---- QR code (qrcodejs from cdnjs, loaded the first time it's needed) ----
const loadQr = () => (qrLib ||= new Promise((res, rej) => {
  if (window.QRCode) return res();
  const s = document.createElement("script");
  s.src = "https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js";
  s.onload = () => res();
  s.onerror = () => { qrLib = null; rej(new Error("QR library didn't load")); };
  document.head.appendChild(s);
}));
async function qrDataUrl(url) {
  if (qrCache.url === url && qrCache.data) return qrCache.data;
  await loadQr();
  const tmp = document.createElement("div");
  new window.QRCode(tmp, { text: url, width: 640, height: 640, correctLevel: window.QRCode.CorrectLevel.M });
  const data = tmp.querySelector("canvas").toDataURL("image/png");
  qrCache = { url, data };
  return data;
}

async function saveWindows(windows) {
  await updateDoc(seasonRef(), { windows, slots: slotMap(windows, season.blocked), updatedAt: serverTimestamp() });
}

function render() {
  if (!mount) return;
  // a sign-up arriving shouldn't wipe what's being typed — redraw once the field is left
  const a = document.activeElement;
  if (a && mount.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) { dirty = true; return; }
  dirty = false;
  const editor = can("tithing", "edit");

  if (!season) {
    mount.innerHTML = `
      <div class="card td-setup">
        <h3>Tithing declaration sign-ups</h3>
        <p class="row-sub">Set the days and times you're available, then share one link (or a QR code) and ward members pick a time themselves.</p>
        ${editor ? `<button class="btn btn-primary" id="td-start">Set it up</button>` : ""}
      </div>`;
    mount.querySelector("#td-start")?.addEventListener("click", async () => {
      try {
        await setDoc(doc(db, "tithing", newToken()), { open: true, ward: "6th Ward", note: "", windows: [], slots: {}, created: new Date().toISOString(), createdBy: ctx.name || "", createdAt: serverTimestamp() });
      } catch (e) { toast("Couldn't set it up: " + (e.code || e.message)); }
    });
    return;
  }

  const today = todayIso();
  const windows = sortWindows(season.windows);
  const slots = slotsOf(windows, season.blocked);
  const byId = Object.fromEntries(signups.map((s) => [s.id, s]));
  const slotIds = new Set(slots.map((s) => s.id));
  const upcoming = slots.filter((s) => s.date >= today && !s.blocked);
  const filled = upcoming.filter((s) => byId[s.id]).length;
  const url = linkUrl();
  if (!form.date) form.date = today;

  // ---------- share ----------
  const share = `
    <div class="card td-share">
      <div class="td-share-main">
        <h3 style="margin:0 0 .15rem">Sign-up link</h3>
        <p class="row-sub" style="margin:0 0 .5rem">Anyone with this link can pick a time — no sign-in. They never see who else signed up.</p>
        <div class="td-link-row">
          <input class="td-link" id="td-url" readonly value="${esc(url)}">
          <button class="btn btn-primary btn-sm" id="td-copy" type="button">Copy link</button>
          <a class="btn btn-sm" href="${esc(url)}" target="_blank" rel="noopener">Open</a>
        </div>
        <div class="td-share-actions">
          <button class="btn btn-sm" id="td-flyer" type="button">🖨 Print sign-up flyer (QR)</button>
          <button class="btn btn-sm" id="td-qr-save" type="button">⬇ Save QR image</button>
          ${editor ? `<label class="td-open"><input type="checkbox" id="td-open" ${season.open ? "checked" : ""}> Sign-ups open</label>` : ""}
        </div>
        ${editor ? `<label class="td-note-lbl">Note shown at the top of the sign-up page <span class="row-sub">(optional)</span>
          <textarea id="td-note" rows="2" placeholder="e.g. Please bring your whole family. Text Brother Coburn at 435-555-0123 if none of these times work.">${esc(season.note || "")}</textarea></label>` : ""}
      </div>
      <div class="td-qr" id="td-qr" title="Scan to open the sign-up page"><span class="row-sub">QR code…</span></div>
    </div>`;

  // ---------- availability ----------
  const opt = (v, l, cur) => `<option value="${esc(v)}"${String(cur) === String(v) ? " selected" : ""}>${esc(l)}</option>`;
  const addForm = editor ? `
    <div class="td-add">
      <label>Day<input type="date" id="tdf-date" value="${esc(form.date)}"></label>
      <label>From<input type="time" id="tdf-start" step="300" value="${esc(form.start)}"></label>
      <label>To<input type="time" id="tdf-end" step="300" value="${esc(form.end)}"></label>
      <label>Each visit<select id="tdf-len">${SLOT_LENGTHS.map((n) => opt(n, n + " minutes", form.len)).join("")}</select></label>
      <label>Where<select id="tdf-place">${Object.entries(PLACES).map(([k, p]) => opt(k, p.icon + " " + p.label, form.place)).join("")}</select></label>
      <label>Set aside for<select id="tdf-group">${opt("", "Anyone", form.group)}${Object.entries(GROUPS).map(([k, g]) => opt(k, g.label, form.group)).join("")}</select></label>
      <div class="td-rep-wrap" title="Add the same hours on other weeks too"><span class="td-rep-lbl">Repeat on</span><details class="td-rep" id="tdf-rep"${form.repOpen ? " open" : ""}></details></div>
      <button class="btn btn-primary" id="tdf-add" type="button">+ Add</button>
    </div>` : "";
  const winRow = (w) => {
    const all = slots.filter((s) => s.win === w.id), list = all.filter((s) => !s.blocked || byId[s.id]);
    const took = list.filter((s) => byId[s.id]).length, nOff = all.length - list.length;
    const g = GROUPS[w.group];
    return `<div class="td-winrow${w.date < today ? " td-past" : ""}">
      <b class="td-win-day">${esc(fmtShortDay(w.date))}</b>
      <span class="td-win-time">${rangeText(w)}</span>
      <span class="pill td-pill-len">${Number(w.len) || 15} min</span>
      <span class="pill td-pill-place td-place-${esc(w.place || "office")}">${PLACES[w.place]?.icon || "🏛"} ${esc(PLACES[w.place]?.label || PLACES.office.label)}</span>
      ${g ? `<span class="pill td-pill-${g.cls}">${esc(g.label)}</span>` : ""}
      <span class="row-sub td-win-count">${took} of ${list.length} taken${nOff ? ` · ${nOff} blocked out` : ""}</span>
      ${editor ? `<button class="btn btn-sm" data-divide="${esc(w.id)}" type="button" title="Split this block into periods with different visit lengths (15 / 10 minutes), or set part of it aside for a group">✂ Divide</button>
      <button class="btn btn-sm btn-ghost td-x" data-rmwin="${esc(w.id)}" title="Remove this time period">✕</button>` : ""}
    </div>`;
  };
  const futureW = windows.filter((w) => w.date >= today), pastW = windows.filter((w) => w.date < today);
  const avail = `
    <div class="card">
      <h3 style="margin:0 0 .15rem">When I'm available</h3>
      <p class="row-sub" style="margin:0 0 .6rem">Add each block of time. It's split into 10- or 15-minute visits people can sign up for. Add a separate block for any stretch you want to set aside for families with kids at home or for widows.</p>
      ${addForm}
      <div class="td-winlist">
        ${futureW.length ? futureW.map(winRow).join("") : `<div class="empty-note" style="padding:.6rem">No times yet${editor ? " — add your first block above." : "."}</div>`}
      </div>
      ${pastW.length ? `<details class="td-pastwrap"><summary>Past days (${pastW.length})</summary>${pastW.map(winRow).join("")}</details>` : ""}
    </div>`;

  // ---------- schedule ----------
  const orphan = signups.filter((s) => !slotIds.has(s.id)).map((s) => { const p = parseSlotId(s.id); return p ? { id: s.id, date: p.date, min: p.min, len: 0, place: "", group: "", orphan: true } : null; }).filter(Boolean);
  const rowsAll = [...slots, ...orphan].sort((x, y) => (x.date + String(x.min).padStart(4, "0")).localeCompare(y.date + String(y.min).padStart(4, "0")));
  const dayBlock = (d) => {
    const list = rowsAll.filter((s) => s.date === d);
    const took = list.filter((s) => byId[s.id]).length, live = list.filter((s) => !s.blocked || byId[s.id]).length;
    return `<div class="td-sday">
      <div class="td-sday-head"><b>${esc(fmtLongDay(d))}</b><span class="row-sub">${took} of ${live} filled</span></div>
      ${list.map((s) => {
        const su = byId[s.id], g = GROUPS[s.group];
        const tags = `${s.place === "home" ? `<span class="td-tag td-tag-home" title="Home visit">🏠</span>` : ""}${g ? `<span class="td-tag td-tag-${g.cls}" title="Set aside for ${esc(g.label.toLowerCase())}">${esc(g.label)}</span>` : ""}`;
        if (!su && s.blocked) return `<div class="td-srow td-srow-blocked" data-slot="${s.id}"><span class="td-grip td-grip-none"></span><span class="td-stime">${fmtClock(s.min)}</span><span class="td-sname row-sub">blocked out</span>${editor ? `<button class="btn btn-sm btn-ghost" data-block="${s.id}" data-on="0" type="button" title="Open this time back up for sign-ups">unblock</button>` : ""}</div>`;
        if (!su) return `<div class="td-srow td-srow-open" data-slot="${s.id}"><span class="td-grip td-grip-none"></span><span class="td-stime">${fmtClock(s.min)}</span><span class="td-sname row-sub">open ${tags}</span>${editor ? `<button class="btn btn-sm btn-ghost" data-addname="${s.id}" type="button" title="Put someone in this time yourself">+ add name</button><button class="btn btn-sm btn-ghost td-blk" data-block="${s.id}" data-on="1" type="button" title="Block out this time so nobody can sign up for it">⊘<span class="td-st-lbl"> block</span></button>` : ""}</div>`;
        const digits = String(su.phone || "").replace(/\D/g, "");
        const tel = digits.length === 10 ? "+1" + digits : digits ? "+" + digits : "";
        const msg = `Reminder: your tithing declaration with the bishop is ${fmtLongDay(s.date)} at ${fmtClock(s.min)}${s.place === "home" ? " at your home" : " at the Bishop's office"}.`;
        return `<div class="td-srow${su.status ? " td-st-" + esc(su.status) : ""}" data-slot="${s.id}">
          ${editor ? `<span class="td-grip" draggable="true" data-grip="${s.id}" title="Drag onto another time to move it (or onto someone to swap). Click for a list of open times.">⋮⋮</span>` : `<span class="td-grip td-grip-none"></span>`}
          <span class="td-stime">${fmtClock(s.min)}</span>
          <span class="td-sname"${su.phone ? ` title="${esc(su.phone)}"` : ""}><b>${esc(su.name)}</b> ${tags}${s.orphan ? `<span class="td-tag td-tag-warn" title="This time is no longer in your availability">⚠ outside your times</span>` : ""}
            ${su.address ? `<span class="row-sub td-saddr">${esc(su.address)}</span>` : ""}</span>
          ${su.phone ? `<span class="td-sphone"><a href="tel:${esc(tel)}">${esc(su.phone)}</a>${tel ? ` <a class="btn btn-sm" href="sms:${esc(tel)}?&body=${encodeURIComponent(msg)}" title="Opens a text message with the reminder already written">Text reminder</a>` : ""}</span>` : `<span class="td-sphone row-sub">no phone</span>`}
          ${editor ? `<span class="td-status" data-for="${s.id}">
            <button type="button" class="td-st-btn td-st-yes${su.status === "attended" ? " on" : ""}" data-status="attended" title="They came">✓<span class="td-st-lbl"> Came</span></button>
            <button type="button" class="td-st-btn td-st-no${su.status === "noshow" ? " on" : ""}" data-status="noshow" title="They didn't come">✗<span class="td-st-lbl"> No-show</span></button>
          </span>` : (su.status ? `<span class="row-sub">${esc(STATUS[su.status] || "")}</span>` : "")}
          ${editor ? `<button class="btn btn-sm btn-ghost td-x" data-rmsign="${s.id}" title="Remove this sign-up and open the time back up">✕</button>` : ""}
        </div>`;
      }).join("")}
    </div>`;
  };
  const days = [...new Set(rowsAll.map((s) => s.date))];
  const futureD = days.filter((d) => d >= today), pastD = days.filter((d) => d < today);
  const schedule = `
    <div class="card">
      <h3 style="margin:0 0 .5rem;display:flex;align-items:center;gap:.6rem;flex-wrap:wrap">Schedule
        <span class="pill ${filled ? "pill-approved" : "pill-role-member"}">${filled} of ${upcoming.length} filled</span>
        <span class="view-toggle" id="td-sview" style="margin-left:auto">
          <button class="chip${schedView === "cols" ? " active" : ""}" data-sview="cols" type="button" title="Every day side by side">By day</button>
          <button class="chip${schedView === "list" ? " active" : ""}" data-sview="list" type="button" title="One list, with phone numbers and text reminders">List</button>
        </span>
        ${rowsAll.length ? `<button class="btn btn-sm" id="td-print" type="button">🖨 Print schedule</button>` : ""}
      </h3>
      ${futureD.length ? `<div class="td-sched td-sched-${schedView}">${futureD.map(dayBlock).join("")}</div>` : `<div class="empty-note" style="padding:.6rem">Nothing scheduled yet.</div>`}
      ${pastD.length ? `<details class="td-pastwrap"><summary>Past days (${pastD.length})</summary>${pastD.map(dayBlock).join("")}</details>` : ""}
    </div>`;

  // ---------- everyone who signed up / attended this year ----------
  const people = signups.map((su) => { const p = parseSlotId(su.id); return p ? { ...su, date: p.date, min: p.min } : null; }).filter(Boolean)
    .sort((x, y) => String(x.name || "").localeCompare(String(y.name || "")) || x.date.localeCompare(y.date));
  const years = [...new Set(people.map((r) => r.date.slice(0, 4)))].sort();
  const nAtt = people.filter((r) => r.status === "attended").length, nNo = people.filter((r) => r.status === "noshow").length;
  const stText = (r) => STATUS[r.status] || (r.date < today ? "Not marked" : "Signed up");
  const shown = people.filter((r) => listFilter === "all" || (listFilter === "pending" ? !r.status : r.status === listFilter));
  const fchip = (k, l, n) => `<button type="button" class="chip${listFilter === k ? " active" : ""}" data-lfilter="${k}">${l} <b>${n}</b></button>`;
  const yearList = people.length ? `
    <div class="card">
      <h3 style="margin:0 0 .5rem;display:flex;align-items:center;gap:.6rem;flex-wrap:wrap">${esc(years.join(" / ") || "This year")} list
        <span class="row-sub" style="font-weight:400">everyone who signed up, and who came</span>
        <button class="btn btn-sm" id="td-print-list" type="button" style="margin-left:auto">🖨 Print list</button>
      </h3>
      <div class="td-lfilters">
        ${fchip("all", "Signed up", people.length)}${fchip("attended", "Attended", nAtt)}${fchip("pending", "Not marked yet", people.length - nAtt - nNo)}${fchip("noshow", "Didn't come", nNo)}
      </div>
      <table class="td-list">
        <thead><tr><th>Name</th><th>Appointment</th><th>Phone</th><th>Status</th></tr></thead>
        <tbody>${shown.length ? shown.map((r) => `<tr class="${r.status ? "td-st-" + esc(r.status) : ""}"><td><b>${esc(r.name)}</b></td><td>${esc(fmtShortDay(r.date))} · ${fmtClock(r.min)}</td><td>${esc(r.phone || "")}</td><td>${esc(stText(r))}</td></tr>`).join("") : `<tr><td colspan="4" class="row-sub">Nobody in this group.</td></tr>`}</tbody>
      </table>
    </div>` : "";

  mount.innerHTML = share + avail + schedule + yearList;

  // ---------- wiring ----------
  const qrBox = mount.querySelector("#td-qr");
  qrDataUrl(url).then((data) => { if (qrBox.isConnected) qrBox.innerHTML = `<img src="${data}" alt="QR code for the sign-up page">`; })
    .catch(() => { if (qrBox.isConnected) qrBox.innerHTML = `<span class="row-sub">QR code needs an internet connection.</span>`; });

  mount.querySelector("#td-copy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(url); toast("Link copied"); }
    catch { mount.querySelector("#td-url").select(); toast("Select and copy the link"); }
  });
  mount.querySelector("#td-url").addEventListener("focus", (e) => e.target.select());
  mount.querySelector("#td-flyer").addEventListener("click", () => printFlyer(url));
  mount.querySelector("#td-qr-save").addEventListener("click", async () => {
    try { const a = document.createElement("a"); a.href = await qrDataUrl(url); a.download = "tithing-declaration-signup-qr.png"; a.click(); }
    catch { toast("Couldn't make the QR code — check your connection"); }
  });
  mount.querySelector("#td-print")?.addEventListener("click", () => printSchedule(rowsAll, byId));
  mount.querySelectorAll("[data-sview]").forEach((b) => b.addEventListener("click", () => { schedView = b.dataset.sview; render(); }));
  mount.querySelectorAll("[data-lfilter]").forEach((b) => b.addEventListener("click", () => { listFilter = b.dataset.lfilter; render(); }));
  mount.querySelector("#td-print-list")?.addEventListener("click", () => printList(people, years, stText));
  if (!editor) return;

  // came / didn't come (click the lit one again to clear it)
  mount.querySelectorAll(".td-status [data-status]").forEach((b) => b.addEventListener("click", async () => {
    const id = b.closest(".td-status").dataset.for, su = byId[id]; if (!su) return;
    const status = su.status === b.dataset.status ? "" : b.dataset.status;
    try { await updateDoc(doc(db, "tithing", season.token, "signups", id), { status, statusAt: serverTimestamp(), statusBy: ctx.name || "" }); }
    catch (err) { toast("Couldn't save: " + (err.code || err.message)); }
  }));

  // move an appointment: drag its grip onto an open time (move) or onto another person (swap)
  const moveSignup = async (fromId, to) => {
    const a = byId[fromId], b = byId[to.id];
    if (!a || fromId === to.id) return;
    const strip = ({ id, ...rest }) => rest;
    try {
      const batch = writeBatch(db), at = (sub, id) => doc(db, "tithing", season.token, sub, id);
      if (b) { batch.set(at("signups", to.id), strip(a)); batch.set(at("signups", fromId), strip(b)); } // swap — both times stay taken
      else {
        batch.set(at("signups", to.id), strip(a));
        batch.set(at("taken", to.id), { len: to.len, at: serverTimestamp() });
        batch.delete(at("signups", fromId)); batch.delete(at("taken", fromId));
      }
      await batch.commit();
      toast(b ? `Swapped ${a.name} and ${b.name}` : `Moved ${a.name} to ${fmtShortDay(to.date)} ${fmtClock(to.min)}`);
    } catch (err) { toast("Couldn't move: " + (err.code || err.message)); }
  };
  let dragId = null;
  const clearDrop = () => mount.querySelectorAll(".td-drop").forEach((r) => r.classList.remove("td-drop"));
  mount.querySelectorAll("[data-grip]").forEach((g) => {
    g.addEventListener("dragstart", (e) => { dragId = g.dataset.grip; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", dragId); g.closest(".td-srow").classList.add("td-dragging"); });
    g.addEventListener("dragend", () => { dragId = null; clearDrop(); mount.querySelectorAll(".td-dragging").forEach((r) => r.classList.remove("td-dragging")); });
    // no drag on a touch screen? click the grip for a list of open times instead
    g.addEventListener("click", () => {
      const su = byId[g.dataset.grip]; if (!su) return;
      const openSlots = slots.filter((x) => x.date >= today && !byId[x.id] && !x.blocked);
      if (!openSlots.length) return toast("No open times to move to");
      const el = openModal(`
        <h3>Move ${esc(su.name)}</h3>
        <div class="form-grid"><label>New time<select id="tdm-to">${openSlots.map((x) => `<option value="${x.id}">${esc(fmtShortDay(x.date))} · ${fmtClock(x.min)}${x.place === "home" ? " · home visit" : ""}${GROUPS[x.group] ? " · " + esc(GROUPS[x.group].label) : ""}</option>`).join("")}</select></label></div>
        <div class="modal-actions"><button class="btn" id="tdm-cancel">Cancel</button><button class="btn btn-primary" id="tdm-save">Move</button></div>`);
      el.querySelector("#tdm-cancel").addEventListener("click", closeModal);
      el.querySelector("#tdm-save").addEventListener("click", async () => { const to = slots.find((x) => x.id === el.querySelector("#tdm-to").value); closeModal(); if (to) await moveSignup(su.id, to); });
    });
  });
  mount.querySelectorAll(".td-srow[data-slot]").forEach((rowEl) => {
    const to = slots.find((x) => x.id === rowEl.dataset.slot); if (!to || (to.blocked && !byId[to.id])) return; // times outside the availability, or blocked out, can't receive
    rowEl.addEventListener("dragover", (e) => { if (!dragId || dragId === to.id) return; e.preventDefault(); e.dataTransfer.dropEffect = "move"; clearDrop(); rowEl.classList.add("td-drop"); });
    rowEl.addEventListener("dragleave", (e) => { if (!rowEl.contains(e.relatedTarget)) rowEl.classList.remove("td-drop"); });
    rowEl.addEventListener("drop", async (e) => { if (!dragId || dragId === to.id) return; e.preventDefault(); const from = dragId; dragId = null; clearDrop(); await moveSignup(from, to); });
  });

  mount.querySelector("#td-open").addEventListener("change", async (e) => {
    try { await updateDoc(seasonRef(), { open: e.target.checked }); toast(e.target.checked ? "Sign-ups are open" : "Sign-ups are closed"); }
    catch (err) { toast("Couldn't save: " + (err.code || err.message)); }
  });
  mount.querySelector("#td-note").addEventListener("change", async (e) => {
    try { await updateDoc(seasonRef(), { note: e.target.value.trim() }); toast("Note saved"); }
    catch (err) { toast("Couldn't save: " + (err.code || err.message)); }
  });

  const read = () => {
    form.date = mount.querySelector("#tdf-date").value; form.start = mount.querySelector("#tdf-start").value; form.end = mount.querySelector("#tdf-end").value;
    form.len = Number(mount.querySelector("#tdf-len").value); form.place = mount.querySelector("#tdf-place").value;
    form.group = mount.querySelector("#tdf-group").value;
  };
  mount.querySelectorAll(".td-add > label input, .td-add > label select").forEach((i) => i.addEventListener("change", read));

  // "Repeat on": tick the following weeks (same weekday) that get the same hours
  const repBox = mount.querySelector("#tdf-rep");
  const drawRep = () => {
    const base = form.date || today;
    const dates = Array.from({ length: REPEAT_WEEKS }, (_, i) => addDays(base, 7 * (i + 1)));
    form.repeat = form.repeat.filter((d) => dates.includes(d));
    const n = form.repeat.length;
    repBox.innerHTML = `<summary>${n ? form.repeat.slice(0, 3).map((d) => mdDay(d).split(" ")[1]).join(", ") + (n > 3 ? ` +${n - 3}` : "") : "Just this day"}</summary>
      <div class="td-rep-pop">
        <div class="td-rep-head"><b>Same hours also on</b><button type="button" data-repall="1">All</button><button type="button" data-repall="0">None</button></div>
        ${dates.map((d) => `<label class="td-rep-opt"><input type="checkbox" data-rep="${d}"${form.repeat.includes(d) ? " checked" : ""}> ${esc(mdDay(d))}</label>`).join("")}
      </div>`;
    repBox.querySelectorAll("[data-rep]").forEach((cb) => cb.addEventListener("change", () => {
      form.repeat = cb.checked ? [...new Set([...form.repeat, cb.dataset.rep])].sort() : form.repeat.filter((d) => d !== cb.dataset.rep);
      drawRep();
    }));
    repBox.querySelectorAll("[data-repall]").forEach((b) => b.addEventListener("click", () => { form.repeat = b.dataset.repall === "1" ? dates : []; drawRep(); }));
  };
  drawRep();
  repBox.addEventListener("toggle", () => { form.repOpen = repBox.open; });
  mount.querySelector("#tdf-date").addEventListener("change", () => { form.repeat = []; drawRep(); }); // a new day means a new list of weeks
  mount.querySelector("#tdf-add").addEventListener("click", async () => {
    read();
    if (!form.date) return toast("Pick a day");
    if (!form.start || !form.end || toMin(form.end) <= toMin(form.start)) return toast("The end time needs to be after the start");
    if (toMin(form.end) - toMin(form.start) < form.len) return toast(`That's shorter than one ${form.len}-minute visit`);
    const adds = [form.date, ...form.repeat].sort().map((date) => ({ id: "w" + Math.random().toString(36).slice(2, 9), date, start: form.start, end: form.end, len: form.len, place: form.place, group: form.group }));
    const cur = season.windows || [];
    const clash = adds.find((n) => cur.some((w) => overlaps(n, w)));
    if (clash) { const w = cur.find((x) => overlaps(clash, x)); return toast(`${fmtShortDay(clash.date)} overlaps a block you already have (${rangeText(w)})`); }
    try {
      await saveWindows([...cur, ...adds]);
      toast(adds.length > 1 ? `Added ${adds.length} days` : "Added");
      form.date = addDays(adds[adds.length - 1].date, 7); // ready for the next week
      form.repeat = []; form.repOpen = false;
      render();
    } catch (err) { toast("Couldn't save: " + (err.code || err.message)); }
  });

  // block out one time (or open it back up): it disappears from the sign-up page
  mount.querySelectorAll("[data-block]").forEach((b) => b.addEventListener("click", async () => {
    const id = b.dataset.block, on = b.dataset.on === "1";
    const blocked = on ? [...new Set([...(season.blocked || []), id])] : (season.blocked || []).filter((x) => x !== id);
    try { await updateDoc(seasonRef(), { blocked, slots: slotMap(season.windows, blocked), updatedAt: serverTimestamp() }); toast(on ? "Blocked out" : "Open again"); }
    catch (err) { toast("Couldn't save: " + (err.code || err.message)); }
  }));

  mount.querySelectorAll("[data-divide]").forEach((b) => b.addEventListener("click", () => {
    const w = (season.windows || []).find((x) => x.id === b.dataset.divide);
    if (w) divideWindow(w, slots.filter((x) => x.win === w.id && byId[x.id]).length);
  }));

  mount.querySelectorAll("[data-rmwin]").forEach((b) => b.addEventListener("click", async () => {
    const w = (season.windows || []).find((x) => x.id === b.dataset.rmwin); if (!w) return;
    const took = slots.filter((s) => s.win === w.id && byId[s.id]).length;
    if (took && !confirm(`${took} ${took === 1 ? "person has" : "people have"} signed up in this block.\n\nRemove it anyway? Their sign-ups stay on your schedule (marked "outside your times") until you remove them.`)) return;
    try { await saveWindows((season.windows || []).filter((x) => x.id !== w.id)); toast("Removed"); }
    catch (err) { toast("Couldn't save: " + (err.code || err.message)); }
  }));

  mount.querySelectorAll("[data-rmsign]").forEach((b) => b.addEventListener("click", async () => {
    const su = byId[b.dataset.rmsign]; if (!su) return;
    if (!confirm(`Remove ${su.name}'s sign-up and open this time back up?`)) return;
    try {
      const batch = writeBatch(db);
      batch.delete(doc(db, "tithing", season.token, "signups", su.id));
      batch.delete(doc(db, "tithing", season.token, "taken", su.id));
      await batch.commit();
      toast("Removed");
    } catch (err) { toast("Couldn't remove: " + (err.code || err.message)); }
  }));

  mount.querySelectorAll("[data-addname]").forEach((b) => b.addEventListener("click", () => {
    const s = slots.find((x) => x.id === b.dataset.addname); if (!s) return;
    const el = openModal(`
      <h3>${esc(fmtLongDay(s.date))} · ${fmtClock(s.min)}</h3>
      <div class="form-grid">
        <label>Name<input id="tda-name" maxlength="80" placeholder="e.g. The Hansen family"></label>
        <label>Mobile number <span class="row-sub">(optional)</span><input id="tda-phone" type="tel" maxlength="30"></label>
        ${s.place === "home" ? `<label>Address <span class="row-sub">(optional)</span><input id="tda-addr" maxlength="160"></label>` : ""}
      </div>
      <div class="modal-actions"><button class="btn" id="tda-cancel">Cancel</button><button class="btn btn-primary" id="tda-save">Save</button></div>`);
    el.querySelector("#tda-cancel").addEventListener("click", closeModal);
    const save = async () => {
      const name = el.querySelector("#tda-name").value.trim();
      if (!name) return el.querySelector("#tda-name").focus();
      try {
        const batch = writeBatch(db);
        batch.set(doc(db, "tithing", season.token, "taken", s.id), { len: s.len, at: serverTimestamp() });
        batch.set(doc(db, "tithing", season.token, "signups", s.id), { name, phone: el.querySelector("#tda-phone").value.trim(), address: el.querySelector("#tda-addr")?.value.trim() || "", at: serverTimestamp(), addedBy: ctx.name || "" });
        await batch.commit();
        closeModal(); toast("Added");
      } catch (err) { toast("Couldn't save: " + (err.code || err.message)); }
    };
    el.querySelector("#tda-save").addEventListener("click", save);
    el.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.tagName === "INPUT") { e.preventDefault(); save(); } });
    setTimeout(() => el.querySelector("#tda-name").focus(), 50);
  }));
}

// ---- divide one block into periods (2026-10-04) ----
// e.g. 11:00–4:00 → 11:00–1:00 in 15-minute visits, then 1:00–4:00 in 10-minute visits.
// Each period is saved as its own block, so it can also be set aside for a group.
function divideWindow(w, took) {
  let parts = [{ end: w.end, len: Number(w.len) || 15, group: w.group || "" }]; // each period runs from the one before it to its own end
  const opt = (v, l, cur) => `<option value="${esc(v)}"${String(cur) === String(v) ? " selected" : ""}>${esc(l)}</option>`;
  const el = openModal(`
    <h3 style="margin-bottom:.3rem">${esc(fmtLongDay(w.date))}</h3>
    <p class="row-sub" style="margin:0 0 .8rem">${rangeText(w)} · ${PLACES[w.place]?.icon || ""} ${esc(PLACES[w.place]?.label || PLACES.office.label)}. Split it into periods — each can have its own visit length and be set aside for a group.</p>
    <div class="tdd-head"><span>From</span><span>Until</span><span>Each visit</span><span>Set aside for</span><span></span></div>
    <div id="tdd-parts"></div>
    <button class="btn btn-sm" id="tdd-add" type="button" style="margin-top:.6rem">✂ Split the last period</button>
    ${took ? `<p class="row-sub" style="margin:.7rem 0 0">⚠ ${took} ${took === 1 ? "person has" : "people have"} already signed up in this block. Their times are kept; any that no longer line up are marked “outside your times” on the schedule.</p>` : ""}
    <p class="tdd-err hidden" id="tdd-err"></p>
    <div class="modal-actions"><button class="btn" id="tdd-cancel" type="button">Cancel</button><button class="btn btn-primary" id="tdd-save" type="button">Save</button></div>`);
  el.classList.add("td-divide");
  const box = el.querySelector("#tdd-parts"), errEl = el.querySelector("#tdd-err");
  const showErr = (m) => { errEl.textContent = m; errEl.classList.toggle("hidden", !m); };
  const startOf = (i) => (i === 0 ? w.start : parts[i - 1].end);
  const draw = () => {
    box.innerHTML = parts.map((p, i) => {
      const last = i === parts.length - 1, mins = toMin(p.end) - toMin(startOf(i)), n = mins > 0 ? Math.floor(mins / p.len) : 0;
      return `<div class="tdd-row">
        <span class="tdd-from">${fmtClock(toMin(startOf(i)))}</span>
        ${last ? `<span class="tdd-end">${fmtClock(toMin(p.end))}</span>` : `<input type="time" step="300" data-end="${i}" value="${esc(p.end)}">`}
        <select data-len="${i}">${SLOT_LENGTHS.map((x) => opt(x, x + " minutes", p.len)).join("")}</select>
        <select data-group="${i}">${opt("", "Anyone", p.group)}${Object.entries(GROUPS).map(([k, g]) => opt(k, g.label, p.group)).join("")}${opt("off", "⊘ Blocked out — no sign-ups", p.group)}</select>
        <span class="tdd-n">${p.group === "off" ? "break" : `${n} ${n === 1 ? "visit" : "visits"}`}${i > 0 ? ` <button type="button" class="btn btn-sm btn-ghost" data-merge="${i}" title="Remove this split (joins it to the period above)">✕</button>` : ""}</span>
      </div>`;
    }).join("");
    box.querySelectorAll("[data-end]").forEach((x) => x.addEventListener("change", () => { parts[+x.dataset.end].end = x.value; showErr(""); draw(); }));
    box.querySelectorAll("[data-len]").forEach((x) => x.addEventListener("change", () => { parts[+x.dataset.len].len = Number(x.value); draw(); }));
    box.querySelectorAll("[data-group]").forEach((x) => x.addEventListener("change", () => { parts[+x.dataset.group].group = x.value; draw(); }));
    box.querySelectorAll("[data-merge]").forEach((x) => x.addEventListener("click", () => { const i = +x.dataset.merge; parts[i - 1].end = parts[i].end; parts.splice(i, 1); showErr(""); draw(); }));
  };
  el.querySelector("#tdd-add").addEventListener("click", () => {
    const i = parts.length - 1, p = parts[i], from = toMin(startOf(i)), to = toMin(p.end);
    const half = Math.floor((to - from) / 2 / p.len) * p.len; // split on a visit boundary near the middle
    if (half < p.len || to - (from + half) < 10) return showErr("That period is too short to split again.");
    parts.splice(i, 0, { end: hhmm(from + half), len: p.len, group: p.group });
    showErr(""); draw();
  });
  el.querySelector("#tdd-cancel").addEventListener("click", closeModal);
  el.querySelector("#tdd-save").addEventListener("click", async () => {
    for (let i = 0; i < parts.length; i++) {
      const mins = toMin(parts[i].end) - toMin(startOf(i));
      if (!parts[i].end || mins <= 0) return showErr(`Period ${i + 1} needs to end after it starts (${fmtClock(toMin(startOf(i)))}) and before the block ends.`);
      if (parts[i].group !== "off" && mins < parts[i].len) return showErr(`Period ${i + 1} is shorter than one ${parts[i].len}-minute visit.`);
    }
    if (parts.every((p) => p.group === "off")) return showErr("Everything is blocked out — to drop the whole block, cancel and use ✕ on its row instead.");
    // a blocked-out period just isn't saved: it becomes a gap between the periods around it
    const made = parts.map((p, i) => ({ id: "w" + Math.random().toString(36).slice(2, 9), date: w.date, start: startOf(i), end: p.end, len: p.len, place: w.place || "office", group: p.group })).filter((x) => x.group !== "off");
    made[0].id = w.id;
    try {
      await saveWindows([...(season.windows || []).filter((x) => x.id !== w.id), ...made]);
      closeModal(); toast(made.length > 1 ? `Saved as ${made.length} periods` : "Saved");
    } catch (err) { showErr("Couldn't save: " + (err.code || err.message)); }
  });
  draw();
}

// ---- printing ----
function printWindow(title, bodyHtml, css) {
  const w = window.open("", "_blank");
  if (!w) return toast("Allow pop-ups to print");
  w.document.write(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${esc(title)}</title><style>
    html { color-scheme: light; } body { margin: 0; background: #fff; color: #1f2733; font: 14px/1.45 -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; }
    ${css}
    @media print { .noprint { display: none; } }
  </style></head><body>${bodyHtml}<p class="noprint" style="text-align:center;margin:1rem"><button onclick="print()" style="font:inherit;padding:.5rem 1.2rem">Print</button></p></body></html>`);
  w.document.close();
  setTimeout(() => { try { w.focus(); w.print(); } catch {} }, 400);
}

async function printFlyer(url) {
  let qr = "";
  try { qr = await qrDataUrl(url); } catch { return toast("Couldn't make the QR code — check your connection"); }
  const days = [...new Set(slotsOf(season.windows).filter((s) => s.date >= todayIso()).map((s) => s.date))];
  printWindow("Tithing Declaration sign-up", `
    <div class="fly">
      <div class="fly-ward">${esc(season.ward || "6th Ward")}</div>
      <h1>Tithing Declaration</h1>
      <p class="fly-lead">Scan to pick a time with the bishop</p>
      <img src="${qr}" alt="QR code">
      <p class="fly-how">Point your phone's camera at the code, choose a time, and add your name.</p>
      ${season.note ? `<p class="fly-note">${esc(season.note)}</p>` : ""}
      ${days.length ? `<p class="fly-days"><b>Days available:</b> ${days.map((d) => esc(fmtShortDay(d))).join(" · ")}</p>` : ""}
      <p class="fly-url">${esc(url)}</p>
    </div>`, `
    @page { size: letter; margin: .6in; }
    .fly { text-align: center; padding: .4in .3in; }
    .fly-ward { font-size: 15pt; letter-spacing: .12em; text-transform: uppercase; color: #5b6675; }
    .fly h1 { font-size: 44pt; margin: .1in 0 0; letter-spacing: -.01em; }
    .fly-lead { font-size: 20pt; margin: .1in 0 .3in; }
    .fly img { width: 4.2in; height: 4.2in; }
    .fly-how { font-size: 14pt; margin: .3in 0 0; }
    .fly-note { font-size: 13pt; margin: .2in auto 0; max-width: 6in; white-space: pre-wrap; }
    .fly-days { font-size: 12pt; margin: .25in auto 0; max-width: 6.4in; }
    .fly-url { font-size: 10pt; color: #5b6675; margin-top: .3in; word-break: break-all; }`);
}

function printList(people, years, stText) {
  const n = (k) => people.filter((r) => r.status === k).length;
  printWindow("Tithing Declaration list", `
    <div class="sch"><h1>Tithing Declaration ${esc(years.join(" / "))} <span>${esc(season.ward || "6th Ward")}</span></h1>
    <p>${people.length} signed up · ${n("attended")} attended · ${n("noshow")} didn't come</p>
    <table><tr><th>Name</th><th>Appointment</th><th>Phone</th><th>Status</th></tr>
    ${people.map((r) => `<tr><td><b>${esc(r.name)}</b></td><td>${esc(fmtShortDay(r.date))} · ${fmtClock(r.min)}</td><td>${esc(r.phone || "")}</td><td>${esc(stText(r))}</td></tr>`).join("")}</table></div>`, `
    @page { size: letter; margin: .5in; }
    .sch { padding: .1in; } .sch h1 { font-size: 18pt; margin: 0 0 .05in; } .sch h1 span { font-size: 11pt; font-weight: 400; color: #5b6675; margin-left: .5em; }
    .sch p { margin: 0 0 .15in; color: #5b6675; }
    table { width: 100%; border-collapse: collapse; } tr { break-inside: avoid; }
    th { text-align: left; font-size: 9pt; text-transform: uppercase; letter-spacing: .05em; color: #5b6675; border-bottom: 1.5px solid #1f2733; padding: .05in .08in; }
    td { border-bottom: 1px solid #cfd5dd; padding: .06in .08in; }`);
}

function printSchedule(rowsAll, byId) {
  const days = [...new Set(rowsAll.map((s) => s.date))].filter((d) => d >= todayIso());
  printWindow("Tithing Declaration schedule", `
    <div class="sch"><h1>Tithing Declaration <span>${esc(season.ward || "6th Ward")}</span></h1>
    ${days.map((d) => `<h2>${esc(fmtLongDay(d))}</h2><table>${rowsAll.filter((s) => s.date === d).map((s) => {
      const su = byId[s.id], g = GROUPS[s.group];
      return `<tr><td class="t">${fmtClock(s.min)}</td><td class="n">${su ? esc(su.name) : s.blocked ? "— blocked out —" : ""}${su && su.address ? `<div class="a">${esc(su.address)}</div>` : ""}</td><td class="p">${su ? esc(su.phone || "") : ""}</td><td class="w">${s.place === "home" ? "Home visit" : s.place ? "Office" : ""}${g ? " · " + esc(g.label) : ""}</td></tr>`;
    }).join("")}</table>`).join("")}</div>`, `
    @page { size: letter; margin: .5in; }
    .sch { padding: .1in; } .sch h1 { font-size: 18pt; margin: 0 0 .1in; } .sch h1 span { font-size: 11pt; font-weight: 400; color: #5b6675; margin-left: .5em; }
    .sch h2 { font-size: 12.5pt; margin: .22in 0 .05in; break-after: avoid; }
    table { width: 100%; border-collapse: collapse; } tr { break-inside: avoid; }
    td { border-bottom: 1px solid #cfd5dd; padding: .07in .08in; vertical-align: top; }
    td.t { width: 1in; font-weight: 700; white-space: nowrap; } td.p { width: 1.5in; white-space: nowrap; } td.w { width: 2.2in; color: #5b6675; font-size: 10pt; }
    .a { color: #5b6675; font-size: 10pt; }`);
}
