// Tithing declaration sign-ups (2026-10-04) — the bishop's side, inside the
// Calendar page: set when you're available, share the link / QR code, and see
// who signed up. The public page is tithing.html (js/tithing-form.js).
import { db } from "./firebase-init.js?v=1791157953";
import { ctx, can } from "./app.js?v=1791157953";
import {
  collection, doc, onSnapshot, setDoc, updateDoc, writeBatch, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { openModal, closeModal, toast } from "./ui.js?v=1791157953";
import {
  GROUPS, PLACES, SLOT_LENGTHS, esc, toMin, fmtClock, fmtLongDay, fmtShortDay, slotsOf, slotMap,
  sortWindows, overlaps, newToken, parseSlotId, todayIso, addDays,
} from "./tithing-shared.js?v=1791157953";

let mount = null, season = null, signups = [], unsubSignups = null, started = false, dirty = false;
let qrCache = { url: "", data: "" }, qrLib = null;
// the "add a time period" form keeps its values between adds (handy for several Sundays in a row)
const form = { date: "", start: "14:00", end: "16:00", len: 15, place: "office", group: "", weeks: 1 };

const seasonRef = () => doc(db, "tithing", season.token);
const linkUrl = () => new URL("tithing.html?k=" + season.token, location.href).href;
const rangeText = (w) => `${fmtClock(toMin(w.start))} – ${fmtClock(toMin(w.end))}`;

export function initTithing(el) {
  mount = el;
  if (started) { render(); return; }
  started = true;
  mount.innerHTML = `<div class="empty-note">Loading…</div>`;
  mount.addEventListener("focusout", () => setTimeout(() => { if (dirty) render(); }, 60));
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
  await updateDoc(seasonRef(), { windows, slots: slotMap(windows), updatedAt: serverTimestamp() });
}

function render() {
  if (!mount) return;
  // a sign-up arriving shouldn't wipe what's being typed — redraw once the field is left
  const a = document.activeElement;
  if (a && mount.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) { dirty = true; return; }
  dirty = false;
  const editor = can("calendar", "edit");

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
  const slots = slotsOf(windows);
  const byId = Object.fromEntries(signups.map((s) => [s.id, s]));
  const slotIds = new Set(slots.map((s) => s.id));
  const upcoming = slots.filter((s) => s.date >= today);
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
      <label title="Add the same hours on the following weeks too">Repeat<select id="tdf-weeks">${[1, 2, 3, 4, 5, 6].map((n) => opt(n, n === 1 ? "Just this day" : n + " weeks in a row", form.weeks)).join("")}</select></label>
      <button class="btn btn-primary" id="tdf-add" type="button">+ Add</button>
    </div>` : "";
  const winRow = (w) => {
    const list = slots.filter((s) => s.win === w.id);
    const took = list.filter((s) => byId[s.id]).length;
    const g = GROUPS[w.group];
    return `<div class="td-winrow${w.date < today ? " td-past" : ""}">
      <b class="td-win-day">${esc(fmtShortDay(w.date))}</b>
      <span class="td-win-time">${rangeText(w)}</span>
      <span class="pill td-pill-len">${Number(w.len) || 15} min</span>
      <span class="pill td-pill-place td-place-${esc(w.place || "office")}">${PLACES[w.place]?.icon || "🏛"} ${esc(PLACES[w.place]?.label || PLACES.office.label)}</span>
      ${g ? `<span class="pill td-pill-${g.cls}">${esc(g.label)}</span>` : ""}
      <span class="row-sub td-win-count">${took} of ${list.length} taken</span>
      ${editor ? `<button class="btn btn-sm btn-ghost td-x" data-rmwin="${esc(w.id)}" title="Remove this time period">✕</button>` : ""}
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
    const took = list.filter((s) => byId[s.id]).length;
    return `<div class="td-sday">
      <div class="td-sday-head"><b>${esc(fmtLongDay(d))}</b><span class="row-sub">${took} of ${list.length} filled</span></div>
      ${list.map((s) => {
        const su = byId[s.id], g = GROUPS[s.group];
        const tags = `${s.place === "home" ? `<span class="td-tag td-tag-home" title="Home visit">🏠</span>` : ""}${g ? `<span class="td-tag td-tag-${g.cls}" title="Set aside for ${esc(g.label.toLowerCase())}">${esc(g.label)}</span>` : ""}`;
        if (!su) return `<div class="td-srow td-srow-open"><span class="td-stime">${fmtClock(s.min)}</span><span class="td-sname row-sub">open ${tags}</span>${editor ? `<button class="btn btn-sm btn-ghost" data-addname="${s.id}" type="button" title="Put someone in this time yourself">+ add name</button>` : ""}</div>`;
        const digits = String(su.phone || "").replace(/\D/g, "");
        const tel = digits.length === 10 ? "+1" + digits : digits ? "+" + digits : "";
        const msg = `Reminder: your tithing declaration with the bishop is ${fmtLongDay(s.date)} at ${fmtClock(s.min)}${s.place === "home" ? " at your home" : " at the Bishop's office"}.`;
        return `<div class="td-srow">
          <span class="td-stime">${fmtClock(s.min)}</span>
          <span class="td-sname"><b>${esc(su.name)}</b> ${tags}${s.orphan ? `<span class="td-tag td-tag-warn" title="This time is no longer in your availability">⚠ outside your times</span>` : ""}
            ${su.address ? `<span class="row-sub td-saddr">${esc(su.address)}</span>` : ""}</span>
          ${su.phone ? `<span class="td-sphone"><a href="tel:${esc(tel)}">${esc(su.phone)}</a>${tel ? ` <a class="btn btn-sm" href="sms:${esc(tel)}?&body=${encodeURIComponent(msg)}" title="Opens a text message with the reminder already written">Text reminder</a>` : ""}</span>` : `<span class="td-sphone row-sub">no phone</span>`}
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
        ${rowsAll.length ? `<button class="btn btn-sm" id="td-print" type="button" style="margin-left:auto">🖨 Print schedule</button>` : ""}
      </h3>
      ${futureD.length ? futureD.map(dayBlock).join("") : `<div class="empty-note" style="padding:.6rem">Nothing scheduled yet.</div>`}
      ${pastD.length ? `<details class="td-pastwrap"><summary>Past days (${pastD.length})</summary>${pastD.map(dayBlock).join("")}</details>` : ""}
    </div>`;

  mount.innerHTML = share + avail + schedule;

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
  if (!editor) return;

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
    form.group = mount.querySelector("#tdf-group").value; form.weeks = Number(mount.querySelector("#tdf-weeks").value) || 1;
  };
  mount.querySelectorAll(".td-add input, .td-add select").forEach((i) => i.addEventListener("change", read));
  mount.querySelector("#tdf-add").addEventListener("click", async () => {
    read();
    if (!form.date) return toast("Pick a day");
    if (!form.start || !form.end || toMin(form.end) <= toMin(form.start)) return toast("The end time needs to be after the start");
    if (toMin(form.end) - toMin(form.start) < form.len) return toast(`That's shorter than one ${form.len}-minute visit`);
    const adds = Array.from({ length: form.weeks }, (_, i) => ({ id: "w" + Math.random().toString(36).slice(2, 9), date: addDays(form.date, 7 * i), start: form.start, end: form.end, len: form.len, place: form.place, group: form.group }));
    const cur = season.windows || [];
    const clash = adds.find((n) => cur.some((w) => overlaps(n, w)));
    if (clash) { const w = cur.find((x) => overlaps(clash, x)); return toast(`${fmtShortDay(clash.date)} overlaps a block you already have (${rangeText(w)})`); }
    try {
      await saveWindows([...cur, ...adds]);
      toast(adds.length > 1 ? `Added ${adds.length} days` : "Added");
      form.date = addDays(adds[adds.length - 1].date, 7); // ready for the next week
      render();
    } catch (err) { toast("Couldn't save: " + (err.code || err.message)); }
  });

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

function printSchedule(rowsAll, byId) {
  const days = [...new Set(rowsAll.map((s) => s.date))].filter((d) => d >= todayIso());
  printWindow("Tithing Declaration schedule", `
    <div class="sch"><h1>Tithing Declaration <span>${esc(season.ward || "6th Ward")}</span></h1>
    ${days.map((d) => `<h2>${esc(fmtLongDay(d))}</h2><table>${rowsAll.filter((s) => s.date === d).map((s) => {
      const su = byId[s.id], g = GROUPS[s.group];
      return `<tr><td class="t">${fmtClock(s.min)}</td><td class="n">${su ? esc(su.name) : ""}${su && su.address ? `<div class="a">${esc(su.address)}</div>` : ""}</td><td class="p">${su ? esc(su.phone || "") : ""}</td><td class="w">${s.place === "home" ? "Home visit" : s.place ? "Office" : ""}${g ? " · " + esc(g.label) : ""}</td></tr>`;
    }).join("")}</table>`).join("")}</div>`, `
    @page { size: letter; margin: .5in; }
    .sch { padding: .1in; } .sch h1 { font-size: 18pt; margin: 0 0 .1in; } .sch h1 span { font-size: 11pt; font-weight: 400; color: #5b6675; margin-left: .5em; }
    .sch h2 { font-size: 12.5pt; margin: .22in 0 .05in; break-after: avoid; }
    table { width: 100%; border-collapse: collapse; } tr { break-inside: avoid; }
    td { border-bottom: 1px solid #cfd5dd; padding: .07in .08in; vertical-align: top; }
    td.t { width: 1in; font-weight: 700; white-space: nowrap; } td.p { width: 1.5in; white-space: nowrap; } td.w { width: 2.2in; color: #5b6675; font-size: 10pt; }
    .a { color: #5b6675; font-size: 10pt; }`);
}
