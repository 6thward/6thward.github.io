// Tithing declaration sign-ups (2026-10-04) — the bishop's side, its own page
// ("Tithing Declaration" tab, area key "tithing"): set when you're available, share the link / QR code, and see
// who signed up. The public page is tithing.html (js/tithing-form.js).
import { db } from "./firebase-init.js?v=1792984253";
import { ctx, can } from "./app.js?v=1792984253";
import {
  collection, doc, onSnapshot, setDoc, updateDoc, deleteDoc, writeBatch, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { watchBishopCal, standingEvents } from "./bishop-cal.js?v=1792984253";
import { openModal, closeModal, toast } from "./ui.js?v=1792984253";
import {
  GROUPS, PLACES, SLOT_LENGTHS, esc, toMin, fmtClock, fmtLongDay, fmtShortDay, slotsOf, slotMap, isPriority, PRIORITY_TEXT,
  sortWindows, overlaps, newToken, parseSlotId, todayIso, addDays, hhmm, busyFromEvents, sameBusy, offList,
} from "./tithing-shared.js?v=1792984253";

let mount = null, season = null, signups = [], unsubSignups = null, started = false, dirty = false;
let events = null; // the ward calendar (events with cal: "bishop" block sign-up times); null until it loads
let qrCache = { url: "", data: "" }, qrLib = null;
let dayPick = "";       // which day's roster is showing (an ISO date, "came", or "past") — option C dashboard (2026-10-24)
let shareOpen = true;   // the share / wording card, folded or not
let invites = [], unsubInvites = null; // tithing/{token}/invites — people for the executive secretary to reach out to
const STATUS = { attended: "Attended", noshow: "Didn't come" };
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
        <p class="panel-sub">Who's coming, who came, who to invite — and the link to share. Times are set on the calendar.</p>
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
  onSnapshot(collection(db, "tithing"), (qs) => {
    const all = qs.docs.map((d) => ({ token: d.id, ...d.data() })).sort((a, b) => String(b.created || "").localeCompare(String(a.created || "")));
    const next = all[0] || null;
    if ((next && next.token) !== (season && season.token)) {
      if (unsubSignups) unsubSignups();
      if (unsubInvites) unsubInvites();
      signups = []; invites = [];
      unsubSignups = next ? onSnapshot(collection(db, "tithing", next.token, "signups"), (s) => {
        signups = s.docs.map((d) => ({ id: d.id, ...d.data() }));
        render();
      }, () => {}) : null;
      unsubInvites = next ? onSnapshot(collection(db, "tithing", next.token, "invites"), (s) => {
        invites = s.docs.map((d) => ({ id: d.id, ...d.data() }));
        render();
      }, () => {}) : null;
    }
    season = next;
    render();
    reconcileBusy();
  }, (e) => { mount.innerHTML = `<div class="empty-note">Couldn't load tithing declaration sign-ups (${esc(e.code || e.message)}).</div>`; });
  // the bishop's calendar: someone without the Calendar page just keeps whatever busy times were last saved
  onSnapshot(collection(db, "events"), (qs) => { events = qs.docs.map((d) => ({ id: d.id, ...d.data() })); render(); reconcileBusy(); }, () => {});
  watchBishopCal(() => { render(); reconcileBusy(); });
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

// the public doc's slot map leaves out hand-blocked times and anything on the bishop's calendar
const withStanding = (windows, evs) => [...evs, ...standingEvents((windows || []).map((w) => w.date))]; // ward council + bishopric meeting too
const busyFor = (windows) => (events ? busyFromEvents(windows, withStanding(windows, events)) : season.busy || {});
async function saveWindows(windows) {
  const busy = busyFor(windows);
  await updateDoc(seasonRef(), { windows, busy, slots: slotMap(windows, [...(season.blocked || []), ...Object.keys(busy)]), updatedAt: serverTimestamp() });
}
// the bishop's calendar changed (or we just loaded): keep busy times in step
async function reconcileBusy() {
  if (!season || !events || !can("tithing", "edit")) return;
  const busy = busyFromEvents(season.windows, withStanding(season.windows, events));
  if (sameBusy(busy, season.busy)) return;
  try { await updateDoc(seasonRef(), { busy, slots: slotMap(season.windows, [...(season.blocked || []), ...Object.keys(busy)]), updatedAt: serverTimestamp() }); }
  catch (e) { console.warn("[tithing] busy sync", e); }
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
        <p class="row-sub">Set your times on the calendar, then share one link (or a QR code) and ward members pick a time themselves.</p>
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
  const slots = slotsOf(windows, offList(season));
  const busyOf = (id) => (season.busy || {})[id] || "";
  const byId = Object.fromEntries(signups.map((s) => [s.id, s]));
  const slotIds = new Set(slots.map((s) => s.id));
  const url = linkUrl();
  const orphan = signups.filter((s) => !slotIds.has(s.id)).map((s) => { const p = parseSlotId(s.id); return p ? { id: s.id, date: p.date, min: p.min, len: 0, place: "", group: "", orphan: true } : null; }).filter(Boolean);
  const rowsAll = [...slots, ...orphan].sort((x, y) => (x.date + String(x.min).padStart(4, "0")).localeCompare(y.date + String(y.min).padStart(4, "0")));
  const days = [...new Set(rowsAll.map((s) => s.date))];
  const futureD = days.filter((d) => d >= today), pastD = days.filter((d) => d < today);
  // which day is showing: the one picked, else today if it has times, else the next day that does
  if (!futureD.includes(dayPick) && dayPick !== "past" && dayPick !== "came") dayPick = futureD[0] || "came";
  const people = signups.map((su) => { const p = parseSlotId(su.id); return p ? { ...su, date: p.date, min: p.min } : null; }).filter(Boolean)
    .sort((x, y) => x.date.localeCompare(y.date) || x.min - y.min);
  const dayRows = (d) => rowsAll.filter((s) => s.date === d);
  const dayOf = (d) => { const list = dayRows(d); const live = list.filter((s) => !s.blocked || byId[s.id]); return { list, booked: live.filter((s) => byId[s.id]).length, open: live.filter((s) => !byId[s.id]).length, came: live.filter((s) => byId[s.id]?.status === "attended").length }; };
  const sel = futureD.includes(dayPick) ? dayOf(dayPick) : null;
  const cameSeason = people.filter((r) => r.status === "attended").length;
  const nameKey = (n) => String(n || "").trim().toLowerCase().replace(/^the\s+/, "").replace(/\s+family$/, "").replace(/['’]s$/, "").replace(/\s+/g, " ");
  const signedKeys = new Map(people.map((r) => [nameKey(r.name), r]));

  // ---------- 1. the day: counts + the big buttons ----------
  const dayLabel = (d) => (d === today ? "Today" : fmtShortDay(d));
  const withPhone = sel ? sel.list.filter((s) => byId[s.id]?.phone) : [];
  const stats = `
    <div class="td-stats">
      <div class="td-stat"><b>${sel ? sel.booked : 0}</b><span>booked ${sel && dayPick === today ? "today" : "that day"}</span></div>
      <div class="td-stat"><b>${sel ? sel.open : 0}</b><span>open times</span></div>
      <div class="td-stat"><b>${sel ? sel.came : 0}</b><span>came so far</span></div>
      <div class="td-stat"><b>${cameSeason}</b><span>came this season</span></div>
      <div class="td-stat-actions">
        ${sel && editor ? `<button class="btn btn-primary" id="td-remind" type="button" ${withPhone.length ? "" : "disabled"} title="${withPhone.length ? "One text at a time — each opens in Messages with the reminder written" : "Nobody on this day gave a mobile number"}">💬 Text reminders${withPhone.length ? ` (${withPhone.length})` : ""}</button>` : ""}
        ${sel ? `<button class="btn" id="td-print" type="button">🖨 Print ${esc(dayLabel(dayPick).toLowerCase())}</button>` : ""}
        ${futureD.length ? `<button class="btn" id="td-sheet" type="button" title="A paper sign-up sheet to pass around — open times only, with blanks to write in">📋 Sign-up sheet</button>` : ""}
      </div>
    </div>`;
  const tabs = `
    <div class="td-tabs">
      ${futureD.map((d) => { const o = dayOf(d); return `<button type="button" class="chip${dayPick === d ? " active" : ""}" data-day="${d}">${esc(dayLabel(d))}${o.booked ? ` <b>${o.booked}</b>` : ""}</button>`; }).join("")}
      ${futureD.length ? "" : `<span class="row-sub">No upcoming times — add some on the Calendar or Bishop's Schedule.</span>`}
      <button type="button" class="chip${dayPick === "came" ? " active" : ""}" data-day="came" style="margin-left:auto">Everyone who came <b>${cameSeason}</b></button>
      ${pastD.length ? `<button type="button" class="chip${dayPick === "past" ? " active" : ""}" data-day="past">Past days <b>${pastD.length}</b></button>` : ""}
    </div>`;

  // ---------- the roster for one day: time · name · number · came ----------
  const rowHtml = (s) => {
    const su = byId[s.id];
    const tags = `${s.place === "home" ? `<span class="td-tag td-tag-home" title="Home visit">🏠</span>` : ""}${s.priority ? `<span class="td-tag td-tag-note">Priority</span>` : ""}`;
    if (!su && s.blocked && busyOf(s.id)) return `<div class="td-srow td-srow-blocked td-srow-busy" data-slot="${s.id}"><span class="td-grip td-grip-none"></span><span class="td-stime">${fmtClock(s.min)}</span><span class="td-sname row-sub" title="On the bishop's calendar — change or move that event on the Calendar page to free this time">📅 ${esc(busyOf(s.id))}</span></div>`;
    if (!su && s.blocked) return `<div class="td-srow td-srow-blocked" data-slot="${s.id}"><span class="td-grip td-grip-none"></span><span class="td-stime">${fmtClock(s.min)}</span><span class="td-sname row-sub">blocked out</span>${editor ? `<button class="btn btn-sm btn-ghost" data-block="${s.id}" data-on="0" type="button" title="Open this time back up for sign-ups">unblock</button>` : ""}</div>`;
    if (!su) return `<div class="td-srow td-srow-open" data-slot="${s.id}"><span class="td-grip td-grip-none"></span><span class="td-stime">${fmtClock(s.min)}</span><span class="td-sname row-sub">open ${tags}</span>${editor ? `<button class="btn btn-sm btn-ghost" data-addname="${s.id}" type="button" title="Put someone in this time yourself">+ add name</button><button class="btn btn-sm btn-ghost td-blk" data-block="${s.id}" data-on="1" type="button" title="Block out this time so nobody can sign up for it">⊘<span class="td-st-lbl"> block</span></button>` : ""}</div>`;
    const digits = String(su.phone || "").replace(/\D/g, "");
    const tel = digits.length === 10 ? "+1" + digits : digits ? "+" + digits : "";
    return `<div class="td-srow${su.status ? " td-st-" + esc(su.status) : ""}" data-slot="${s.id}">
      ${editor ? `<span class="td-grip" draggable="true" data-grip="${s.id}" title="Drag onto another time to move it (or onto someone to swap). Click for a list of open times.">⋮⋮</span>` : `<span class="td-grip td-grip-none"></span>`}
      <span class="td-stime">${fmtClock(s.min)}</span>
      <span class="td-sname"><b>${esc(su.name)}</b> ${tags}${s.orphan ? `<span class="td-tag td-tag-warn" title="This time is no longer in your availability">⚠ outside your times</span>` : ""}${busyOf(s.id) ? `<span class="td-tag td-tag-warn" title="Something on the bishop's calendar overlaps this appointment">⚠ ${esc(busyOf(s.id))}</span>` : ""}
        ${su.address ? `<span class="row-sub td-saddr">${esc(su.address)}</span>` : ""}</span>
      ${su.phone ? `<span class="td-sphone"><a href="tel:${esc(tel)}">${esc(su.phone)}</a>${tel && editor ? ` <a class="btn btn-sm" href="sms:${esc(tel)}?&body=${encodeURIComponent(reminderText(s))}" title="Opens a text message with the reminder already written">💬</a>` : ""}</span>` : `<span class="td-sphone row-sub">no number</span>`}
      ${editor ? `<span class="td-status" data-for="${s.id}">
        <button type="button" class="td-st-btn td-st-yes${su.status === "attended" ? " on" : ""}" data-status="attended" title="They came">✓<span class="td-st-lbl"> Came</span></button>
        <button type="button" class="td-st-btn td-st-no${su.status === "noshow" ? " on" : ""}" data-status="noshow" title="They didn't come">✗<span class="td-st-lbl"> No-show</span></button>
      </span>` : (su.status ? `<span class="row-sub">${esc(STATUS[su.status] || "")}</span>` : "")}
      ${editor ? `<button class="btn btn-sm btn-ghost td-x" data-rmsign="${s.id}" title="Remove this sign-up and open the time back up">✕</button>` : ""}
    </div>`;
  };
  const dayBlock = (d) => { const o = dayOf(d); return `<div class="td-sday"><div class="td-sday-head"><b>${esc(fmtLongDay(d))}</b><span class="row-sub">${o.booked} booked · ${o.came} came</span></div>${o.list.map(rowHtml).join("")}</div>`; };
  let main = "";
  if (dayPick === "came") {
    const came = people.filter((r) => r.status === "attended");
    main = `<div class="card"><h3 class="td-h">Everyone who came <span class="pill pill-approved">${came.length}</span><span class="row-sub" style="font-weight:400">— marked by the bishop, here or on the calendar</span><button class="btn btn-sm" id="td-print-came" type="button" style="margin-left:auto">🖨 Print</button></h3>
      ${came.length ? `<table class="td-list"><thead><tr><th>Name</th><th>Appointment</th><th>Phone</th></tr></thead><tbody>${came.map((r) => `<tr><td><b>${esc(r.name)}</b></td><td>${esc(fmtShortDay(r.date))} · ${fmtClock(r.min)}</td><td>${esc(r.phone || "")}</td></tr>`).join("")}</tbody></table>` : `<div class="empty-note" style="padding:.6rem">Nobody marked yet. Tick ✓ Came on a person's row as they arrive.</div>`}</div>`;
  } else if (dayPick === "past") {
    main = `<div class="card"><h3 class="td-h">Past days</h3>${pastD.map(dayBlock).join("")}</div>`;
  } else if (sel) {
    main = `<div class="card"><h3 class="td-h">${esc(fmtLongDay(dayPick))} <span class="row-sub" style="font-weight:400">tick ✓ Came as people arrive · ⋮⋮ moves someone · 💬 texts a reminder</span></h3>${sel.list.map(rowHtml).join("")}</div>`;
  } else {
    main = `<div class="card"><div class="empty-note" style="padding:.6rem">Nothing scheduled yet. Set your times on the Calendar or Bishop's Schedule — drag out a block and pick “Tithing declaration”.</div></div>`;
  }

  // ---------- 6. invite list: who the executive secretary should reach out to ----------
  const invRows = invites.map((v) => ({ ...v, signed: signedKeys.get(nameKey(v.name)) || null })).sort((x, y) => (x.signed ? 2 : x.status === "invited" ? 1 : 0) - (y.signed ? 2 : y.status === "invited" ? 1 : 0) || String(x.name).localeCompare(String(y.name)));
  const nTo = invRows.filter((v) => !v.signed && v.status !== "invited").length, nInv = invRows.filter((v) => !v.signed && v.status === "invited").length, nSigned = invRows.filter((v) => v.signed).length;
  const invRow = (v) => {
    const digits = String(v.phone || "").replace(/\D/g, ""), tel = digits.length === 10 ? "+1" + digits : digits ? "+" + digits : "";
    const st = v.signed ? `<span class="pill pill-approved">signed up · ${esc(fmtShortDay(v.signed.date))} ${fmtClock(v.signed.min)}</span>` : v.status === "invited" ? `<span class="pill pill-role-member" title="${esc(v.invitedBy || "")}">invited${v.invitedAt ? " " + esc(mdDay(String(v.invitedAt).slice(0, 10))) : ""}</span>` : `<span class="pill">to invite</span>`;
    return `<div class="td-inv${v.signed ? " td-inv-signed" : ""}" data-inv="${esc(v.id)}">
      <span class="td-inv-name">${esc(v.name)}</span>
      <span class="td-inv-phone">${v.phone ? `<a href="tel:${esc(tel)}">${esc(v.phone)}</a>` : `<span class="row-sub">—</span>`}</span>
      <span class="td-inv-st">${st}</span>
      <span class="td-inv-acts">${editor && !v.signed ? `${tel ? `<a class="btn btn-sm" href="sms:${esc(tel)}?&body=${encodeURIComponent(inviteText())}" title="Opens a text with the invitation written">💬</a>` : ""}<button type="button" class="btn btn-sm${v.status === "invited" ? " btn-ghost" : ""}" data-invited="${esc(v.id)}">${v.status === "invited" ? "Not yet" : "Invited"}</button>` : ""}${editor ? `<button type="button" class="btn btn-sm btn-ghost td-x" data-rminv="${esc(v.id)}" title="Remove from the list">✕</button>` : ""}</span>
    </div>`;
  };
  const invite = `
    <div class="card">
      <h3 class="td-h">Invite list <span class="row-sub" style="font-weight:400">— for the executive secretary to reach out</span>
        <span class="td-inv-pills"><span class="pill">${nTo} to invite</span><span class="pill pill-role-member">${nInv} invited</span><span class="pill pill-approved">${nSigned} signed up</span></span>
        ${invRows.length ? `<button class="btn btn-sm" id="td-print-inv" type="button">🖨 Print</button>` : ""}
      </h3>
      <p class="row-sub" style="margin:0 0 .5rem">A row turns green by itself once that name signs up. 💬 opens a text with the invitation written; mark <b>Invited</b> once they've been reached.</p>
      ${invRows.length ? `<div class="td-inv td-inv-head"><span>Name</span><span>Mobile</span><span>Status</span><span></span></div>${invRows.map(invRow).join("")}` : `<div class="empty-note" style="padding:.5rem">Nobody on the list yet.</div>`}
      ${editor ? `<div class="td-inv td-inv-add">
        <textarea id="tdi-name" rows="1" placeholder="Add a name — or paste a whole list, one per line (name, mobile)" autocomplete="off"></textarea>
        <input id="tdi-phone" placeholder="Mobile (optional)" autocomplete="off" inputmode="tel">
        <span></span><button class="btn btn-primary btn-sm" id="tdi-add" type="button">Add</button></div>` : ""}
    </div>`;

  // ---------- 2 + 3. share link, QR, and the wording ----------
  const share = `
    <div class="card"><details class="td-share-fold" ${shareOpen ? "open" : ""}>
      <summary>Sign-up link, QR code &amp; priority message <span class="pill ${season.open ? "pill-approved" : "pill-role-member"}">${season.open ? "sign-ups open" : "sign-ups closed"}</span></summary>
      <div class="td-share">
        <div class="td-share-main">
          <div class="td-link-row">
            <input class="td-link" id="td-url" readonly value="${esc(url)}">
            <button class="btn btn-primary btn-sm" id="td-copy" type="button">Copy link</button>
            <a class="btn btn-sm" href="${esc(url)}" target="_blank" rel="noopener">Open</a>
            <button class="btn btn-sm" id="td-flyer" type="button">🖨 Print flyer (QR)</button>
            <button class="btn btn-sm" id="td-qr-save" type="button">⬇ Save QR image</button>
          </div>
          <p class="row-sub" style="margin:.4rem 0 0">Anyone with the link picks a time and types their name — no sign-in, and they never see who else signed up. They can add a mobile number to get a text reminder.</p>
          ${editor ? `<div class="td-share-actions">
            <label class="td-open"><input type="checkbox" id="td-open" ${season.open ? "checked" : ""}> Sign-ups open</label>
            <label class="td-open" title="Members only see the next few open times each day, so the earliest times fill first"><select id="td-ahead">${[[2, "Offer the next 2 open times a day"], [3, "Offer the next 3 open times a day"], [4, "Offer the next 4 open times a day"], [5, "Offer the next 5 open times a day"], [0, "Offer every open time"]].map(([v, l]) => `<option value="${v}"${Number(season.openAhead ?? 4) === v ? " selected" : ""}>${l}</option>`).join("")}</select></label>
          </div>
          <label class="td-note-lbl">Priority time slots — what the sign-up page says about them <span class="row-sub">(shows when any block is marked Priority)</span>
            <textarea id="td-pritext" rows="3">${esc(season.priorityText || PRIORITY_TEXT)}</textarea></label>
          <label class="td-note-lbl">Note shown at the top of the sign-up page <span class="row-sub">(optional)</span>
            <textarea id="td-note" rows="2" placeholder="e.g. Please bring your whole family. Text Brother Coburn at 435-555-0123 if none of these times work.">${esc(season.note || "")}</textarea></label>` : ""}
        </div>
        <div class="td-qr" id="td-qr" title="Scan to open the sign-up page"><span class="row-sub">QR code…</span></div>
      </div>
    </details></div>`;

  mount.innerHTML = stats + tabs + main + invite + share;

  // ---------- wiring ----------
  mount.querySelectorAll("[data-day]").forEach((b) => b.addEventListener("click", () => { dayPick = b.dataset.day; render(); }));
  mount.querySelector(".td-share-fold")?.addEventListener("toggle", (e) => { shareOpen = e.target.open; });
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
  mount.querySelector("#td-print")?.addEventListener("click", () => printSchedule(rowsAll, byId, dayPick));
  mount.querySelector("#td-print-came")?.addEventListener("click", () => printList(people.filter((r) => r.status === "attended"), "Everyone who came"));
  // a paper sign-up sheet (10/25): pick the days, then print the open times with blanks to write in
  mount.querySelector("#td-sheet")?.addEventListener("click", () => {
    const timesByDay = (d) => slots.filter((s) => s.date === d && (!s.blocked || byId[s.id])).map((s) => ({ ...s, name: byId[s.id]?.name || "" }));
    const el = openModal(`<h3>Print a sign-up sheet</h3>
      <p class="row-sub" style="margin:0 0 .6rem">Which Sundays go on the sheet? Times already taken print with the name on them.</p>
      <div class="td-sheet-days">${futureD.map((d) => { const list = timesByDay(d), n = list.filter((s) => !s.name).length; return `<label class="td-sheet-day"><input type="checkbox" data-sheetday="${d}" ${list.length ? "checked" : "disabled"}> <b>${esc(fmtLongDay(d))}</b> <span class="row-sub">${list.length ? `${n} open · ${list.length - n} taken` : "no times"}</span></label>`; }).join("")}</div>
      <div class="modal-actions"><button class="btn" id="tds-cancel" type="button">Cancel</button><button class="btn btn-primary" id="tds-go" type="button">🖨 Print</button></div>`);
    el.querySelector("#tds-cancel").addEventListener("click", closeModal);
    el.querySelector("#tds-go").addEventListener("click", () => {
      const days = [...el.querySelectorAll("[data-sheetday]:checked")].map((x) => x.dataset.sheetday);
      if (!days.length) return toast("Pick at least one Sunday");
      closeModal(); printSignupSheet(days, timesByDay);
    });
  });
  mount.querySelector("#td-print-inv")?.addEventListener("click", () => printInvites(invRows));
  if (!editor) return;

  // text reminders, one person at a time: a list to work down, each line opens Messages with the text written
  mount.querySelector("#td-remind")?.addEventListener("click", () => {
    const el = openModal(`<h3>Text reminders · ${esc(fmtLongDay(dayPick))}</h3>
      <p class="row-sub" style="margin:0 0 .6rem">Each one opens Messages with the reminder written — press Send there, then come back for the next. Only people who gave a number are listed.</p>
      <div class="td-remlist">${withPhone.map((s) => { const su = byId[s.id], digits = String(su.phone).replace(/\D/g, ""), tel = digits.length === 10 ? "+1" + digits : "+" + digits; return `<div class="td-rem"><span class="td-stime">${fmtClock(s.min)}</span><span><b>${esc(su.name)}</b> <span class="row-sub">${esc(su.phone)}</span></span><a class="btn btn-sm btn-primary" data-rem href="sms:${esc(tel)}?&body=${encodeURIComponent(reminderText(s))}">💬 Text</a></div>`; }).join("")}</div>
      <div class="modal-actions"><span></span><button class="btn" id="td-rem-close" type="button">Done</button></div>`);
    el.querySelectorAll("[data-rem]").forEach((a) => a.addEventListener("click", () => { a.textContent = "✓ Sent"; a.classList.remove("btn-primary"); }));
    el.querySelector("#td-rem-close").addEventListener("click", closeModal);
  });

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
    g.addEventListener("click", () => {
      const su = byId[g.dataset.grip]; if (!su) return;
      const openSlots = slots.filter((x) => x.date >= today && !byId[x.id] && !x.blocked);
      if (!openSlots.length) return toast("No open times to move to");
      const el = openModal(`
        <h3>Move ${esc(su.name)}</h3>
        <div class="form-grid"><label>New time<select id="tdm-to">${openSlots.map((x) => `<option value="${x.id}">${esc(fmtShortDay(x.date))} · ${fmtClock(x.min)}${x.place === "home" ? " · home visit" : ""}${x.priority ? " · priority" : ""}</option>`).join("")}</select></label></div>
        <div class="modal-actions"><button class="btn" id="tdm-cancel">Cancel</button><button class="btn btn-primary" id="tdm-save">Move</button></div>`);
      el.querySelector("#tdm-cancel").addEventListener("click", closeModal);
      el.querySelector("#tdm-save").addEventListener("click", async () => { const to = slots.find((x) => x.id === el.querySelector("#tdm-to").value); closeModal(); if (to) await moveSignup(su.id, to); });
    });
  });
  mount.querySelectorAll(".td-srow[data-slot]").forEach((rowEl) => {
    const to = slots.find((x) => x.id === rowEl.dataset.slot); if (!to || (to.blocked && !byId[to.id])) return;
    rowEl.addEventListener("dragover", (e) => { if (!dragId || dragId === to.id) return; e.preventDefault(); e.dataTransfer.dropEffect = "move"; clearDrop(); rowEl.classList.add("td-drop"); });
    rowEl.addEventListener("dragleave", (e) => { if (!rowEl.contains(e.relatedTarget)) rowEl.classList.remove("td-drop"); });
    rowEl.addEventListener("drop", async (e) => { if (!dragId || dragId === to.id) return; e.preventDefault(); const from = dragId; dragId = null; clearDrop(); await moveSignup(from, to); });
  });

  mount.querySelector("#td-open")?.addEventListener("change", async (e) => {
    try { await updateDoc(seasonRef(), { open: e.target.checked }); toast(e.target.checked ? "Sign-ups are open" : "Sign-ups are closed"); }
    catch (err) { toast("Couldn't save: " + (err.code || err.message)); }
  });
  mount.querySelector("#td-ahead")?.addEventListener("change", async (e) => {
    try { await updateDoc(seasonRef(), { openAhead: Number(e.target.value) }); toast("Saved"); }
    catch (err) { toast("Couldn't save: " + (err.code || err.message)); }
  });
  mount.querySelector("#td-pritext")?.addEventListener("change", async (e) => {
    try { await updateDoc(seasonRef(), { priorityText: e.target.value.trim() }); toast("Priority text saved"); }
    catch (err) { toast("Couldn't save: " + (err.code || err.message)); }
  });
  mount.querySelector("#td-note")?.addEventListener("change", async (e) => {
    try { await updateDoc(seasonRef(), { note: e.target.value.trim() }); toast("Note saved"); }
    catch (err) { toast("Couldn't save: " + (err.code || err.message)); }
  });

  // block out one time (or open it back up): it disappears from the sign-up page
  mount.querySelectorAll("[data-block]").forEach((b) => b.addEventListener("click", async () => {
    const id = b.dataset.block, on = b.dataset.on === "1";
    const blocked = on ? [...new Set([...(season.blocked || []), id])] : (season.blocked || []).filter((x) => x !== id);
    try { await updateDoc(seasonRef(), { blocked, slots: slotMap(season.windows, [...blocked, ...Object.keys(season.busy || {})]), updatedAt: serverTimestamp() }); toast(on ? "Blocked out" : "Open again"); }
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

  // ---------- invite list ----------
  const addInvites = async () => {
    const raw = mount.querySelector("#tdi-name").value, phone1 = mount.querySelector("#tdi-phone").value.trim();
    const lines = raw.split(/\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return;
    const batch = writeBatch(db); let n = 0;
    lines.forEach((l, i) => {
      let name = l, phone = i === 0 && lines.length === 1 ? phone1 : "";
      const m = /^(.*?)[,\t]\s*([\d\s().+-]{7,})\s*$/.exec(l); if (m) { name = m[1].trim(); phone = m[2].trim(); }
      if (!name) return;
      batch.set(doc(db, "tithing", season.token, "invites", "i" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)), { name, phone, status: "", at: serverTimestamp(), by: ctx.name || "" }); n++;
    });
    try { await batch.commit(); toast(n === 1 ? "Added" : `Added ${n}`); mount.querySelector("#tdi-name").value = ""; mount.querySelector("#tdi-phone").value = ""; }
    catch (err) { toast("Couldn't save: " + (err.code || err.message)); }
  };
  mount.querySelector("#tdi-add")?.addEventListener("click", addInvites);
  mount.querySelector("#tdi-name")?.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); addInvites(); } });
  mount.querySelector("#tdi-name")?.addEventListener("input", (e) => { const t = e.target; t.rows = Math.min(8, Math.max(1, t.value.split("\n").length)); }); // grows for a pasted list
  mount.querySelectorAll("[data-invited]").forEach((b) => b.addEventListener("click", async () => {
    const v = invites.find((x) => x.id === b.dataset.invited); if (!v) return;
    const on = v.status !== "invited";
    try { await updateDoc(doc(db, "tithing", season.token, "invites", v.id), { status: on ? "invited" : "", invitedAt: on ? new Date().toISOString() : "", invitedBy: on ? ctx.name || "" : "" }); }
    catch (err) { toast("Couldn't save: " + (err.code || err.message)); }
  }));
  mount.querySelectorAll("[data-rminv]").forEach((b) => b.addEventListener("click", async () => {
    const v = invites.find((x) => x.id === b.dataset.rminv); if (!v) return;
    if (!confirm(`Remove ${v.name} from the invite list?`)) return;
    try { await deleteDoc(doc(db, "tithing", season.token, "invites", v.id)); } catch (err) { toast("Couldn't remove: " + (err.code || err.message)); }
  }));
}
const reminderText = (s) => `Reminder: your tithing declaration with the bishop is ${fmtLongDay(s.date)} at ${fmtClock(s.min)}${s.place === "home" ? " at your home" : " at the Bishop's office"}.`;
const inviteText = () => `Hi! The bishop would love to meet with you for tithing declaration. You can pick a time that works here: ${linkUrl()}`;

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
    .fly-ward { font-size: 34pt; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; color: #1f2733; } /* big ward name, small QR (Jordan 10/25) */
    .fly h1 { font-size: 40pt; margin: .05in 0 0; letter-spacing: -.01em; }
    .fly-lead { font-size: 18pt; margin: .1in 0 .25in; }
    .fly img { width: 2.2in; height: 2.2in; }
    .fly-how { font-size: 14pt; margin: .3in 0 0; }
    .fly-note { font-size: 13pt; margin: .2in auto 0; max-width: 6in; white-space: pre-wrap; }
    .fly-days { font-size: 12pt; margin: .25in auto 0; max-width: 6.4in; }
    .fly-url { font-size: 10pt; color: #5b6675; margin-top: .3in; word-break: break-all; }`);
}

const LIST_CSS = `
    @page { size: letter; margin: .5in; }
    .sch { padding: .1in; } .sch h1 { font-size: 18pt; margin: 0 0 .05in; } .sch h1 span { font-size: 11pt; font-weight: 400; color: #5b6675; margin-left: .5em; }
    .sch p { margin: 0 0 .15in; color: #5b6675; }
    table { width: 100%; border-collapse: collapse; } tr { break-inside: avoid; }
    th { text-align: left; font-size: 9pt; text-transform: uppercase; letter-spacing: .05em; color: #5b6675; border-bottom: 1.5px solid #1f2733; padding: .05in .08in; }
    td { border-bottom: 1px solid #cfd5dd; padding: .06in .08in; }`;
function printInvites(rows) {
  const st = (v) => (v.signed ? `signed up · ${fmtShortDay(v.signed.date)} ${fmtClock(v.signed.min)}` : v.status === "invited" ? "invited" : "to invite");
  printWindow("Tithing Declaration — invite list", `
    <div class="sch"><h1>Tithing Declaration — invite list <span>${esc(season.ward || "6th Ward")}</span></h1>
    <p>${rows.length} on the list · ${rows.filter((v) => !v.signed && v.status !== "invited").length} still to invite · sign-up link: ${esc(linkUrl())}</p>
    <table><tr><th>Name</th><th>Mobile</th><th>Status</th><th>Reached</th></tr>
    ${rows.map((v) => `<tr><td><b>${esc(v.name)}</b></td><td>${esc(v.phone || "")}</td><td>${esc(st(v))}</td><td style="width:1in">☐</td></tr>`).join("")}</table></div>`, LIST_CSS);
}
function printList(people, title) {
  printWindow("Tithing Declaration list", `
    <div class="sch"><h1>${esc(title)} <span>${esc(season.ward || "6th Ward")}</span></h1>
    <p>${people.length} ${people.length === 1 ? "person" : "people"}</p>
    <table><tr><th>Name</th><th>Appointment</th><th>Phone</th></tr>
    ${people.map((r) => `<tr><td><b>${esc(r.name)}</b></td><td>${esc(fmtShortDay(r.date))} · ${fmtClock(r.min)}</td><td>${esc(r.phone || "")}</td></tr>`).join("")}</table></div>`, `
    @page { size: letter; margin: .5in; }
    .sch { padding: .1in; } .sch h1 { font-size: 18pt; margin: 0 0 .05in; } .sch h1 span { font-size: 11pt; font-weight: 400; color: #5b6675; margin-left: .5em; }
    .sch p { margin: 0 0 .15in; color: #5b6675; }
    table { width: 100%; border-collapse: collapse; } tr { break-inside: avoid; }
    th { text-align: left; font-size: 9pt; text-transform: uppercase; letter-spacing: .05em; color: #5b6675; border-bottom: 1.5px solid #1f2733; padding: .05in .08in; }
    td { border-bottom: 1px solid #cfd5dd; padding: .06in .08in; }`);
}

// the paper sign-up sheet: open times only, a blank for the name and mobile, priority times marked (10/25)
function printSignupSheet(days, timesByDay) {
  const openByDay = timesByDay;
  printWindow(`${season.ward || "6th Ward"} Tithing Declaration Sign-up`, `
    <div class="sheet">
      <h1>${esc(season.ward || "6th Ward")} Tithing Declaration Sign-up</h1>
      <p class="lead">Write your name next to a time, and a mobile number if you'd like a text reminder.</p>
      <p class="first"><b>Please fill the first available time slots first.</b></p>
      ${days.some((d) => openByDay(d).some((s) => s.priority)) ? `<p class="pri">🔒 <b>Priority</b> times: ${esc(season.priorityText || PRIORITY_TEXT)}</p>` : ""}
      ${season.note ? `<p class="note">${esc(season.note)}</p>` : ""}
      ${days.map((d) => { const list = openByDay(d); return `
        <h2>${esc(fmtLongDay(d))}</h2>
        <table><tr><th class="t">Time</th><th class="n">Name</th><th class="p">Mobile (optional)</th></tr>
        ${list.map((s) => `<tr${s.name ? ` class="taken"` : ""}><td class="t">${fmtClock(s.min)}${s.priority ? ` <span class="tag">🔒 Priority</span>` : ""}${s.place === "home" ? ` <span class="tag">home visit</span>` : ""}</td><td class="n">${esc(s.name)}</td><td class="p"></td></tr>`).join("")}</table>`; }).join("")}
      <p class="foot">Or sign up online: ${esc(linkUrl())}</p>
    </div>`, `
    @page { size: letter; margin: .55in; }
    .sheet { padding: .05in; }
    .sheet h1 { font-size: 22pt; margin: 0; }
    tr.taken td { color: #5b6675; background: #f3f5f8; } tr.taken td.n { font-style: italic; }
    .lead { margin: .08in 0 0; } .first { margin: .06in 0 0; font-size: 12.5pt; }
    .pri { margin: .1in 0 0; padding: .08in .12in; background: #fdf1d6; border-radius: 6px; font-size: 10.5pt; }
    .note { margin: .1in 0 0; color: #5b6675; white-space: pre-wrap; }
    .sheet h2 { font-size: 14pt; margin: .28in 0 .06in; break-after: avoid; }
    table { width: 100%; border-collapse: collapse; } tr { break-inside: avoid; }
    th { text-align: left; font-size: 9pt; text-transform: uppercase; letter-spacing: .05em; color: #5b6675; border-bottom: 1.5px solid #1f2733; padding: .04in .08in; }
    td { border-bottom: 1px solid #9aa4b1; padding: .12in .08in; height: .22in; vertical-align: middle; }
    td.t { width: 1.6in; font-weight: 700; white-space: nowrap; } td.p { width: 1.9in; }
    .tag { font-weight: 600; font-size: 9pt; color: #8a5a00; background: #fdf1d6; border-radius: 99px; padding: .02in .1in; margin-left: .06in; }
    .foot { margin-top: .3in; font-size: 9.5pt; color: #5b6675; word-break: break-all; }`);
}
function printSchedule(rowsAll, byId, onlyDay) { // one day: time · name · mobile, with a Came box to tick by hand
  const busyOf = (id) => ((season && season.busy) || {})[id] || "";
  const days = [...new Set(rowsAll.map((s) => s.date))].filter((d) => (onlyDay ? d === onlyDay : d >= todayIso()));
  printWindow("Tithing Declaration schedule", `
    <div class="sch"><h1>Tithing Declaration <span>${esc(season.ward || "6th Ward")}</span></h1>
    ${days.map((d) => `<h2>${esc(fmtLongDay(d))}</h2><table>${rowsAll.filter((s) => s.date === d).map((s) => {
      const su = byId[s.id], g = GROUPS[s.group];
      return `<tr><td class="t">${fmtClock(s.min)}</td><td class="n">${su ? esc(su.name) : s.blocked ? (busyOf(s.id) ? "— " + esc(busyOf(s.id)) + " —" : "— blocked out —") : ""}${su && su.address ? `<div class="a">${esc(su.address)}</div>` : ""}</td><td class="p">${su ? esc(su.phone || "") : ""}</td><td class="w">${s.place === "home" ? "Home visit" : ""}${s.priority ? " Priority" : ""}${g ? " · " + esc(g.label) : ""}</td><td class="c">${su ? (su.status === "attended" ? "☑ came" : su.status === "noshow" ? "☒ no-show" : "☐ came") : ""}</td></tr>`;
    }).join("")}</table>`).join("")}</div>`, `
    @page { size: letter; margin: .5in; }
    .sch { padding: .1in; } .sch h1 { font-size: 18pt; margin: 0 0 .1in; } .sch h1 span { font-size: 11pt; font-weight: 400; color: #5b6675; margin-left: .5em; }
    .sch h2 { font-size: 12.5pt; margin: .22in 0 .05in; break-after: avoid; }
    table { width: 100%; border-collapse: collapse; } tr { break-inside: avoid; }
    td { border-bottom: 1px solid #cfd5dd; padding: .07in .08in; vertical-align: top; }
    td.t { width: 1in; font-weight: 700; white-space: nowrap; } td.p { width: 1.5in; white-space: nowrap; } td.w { width: 1.4in; color: #5b6675; font-size: 10pt; } td.c { width: 1in; white-space: nowrap; }
    .a { color: #5b6675; font-size: 10pt; }`);
}
