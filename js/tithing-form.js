// Public tithing-declaration sign-up (2026-10-04): tithing.html?k=TOKEN
// No sign-in. Anyone with the link sees the open times (never who took the
// others), picks one, and leaves a name — plus a phone number if they'd like
// a text reminder.
import { db } from "./firebase-init.js?v=1792903041";
import {
  doc, getDoc, collection, onSnapshot, writeBatch, serverTimestamp, setDoc, deleteDoc,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import {
  GROUPS, PLACES, esc, fmtClock, fmtLongDay, slotsOf, sortWindows, parseSlotId, todayIso, nowMin, offList, isPriority, PRIORITY_TEXT, toMin,
} from "./tithing-shared.js?v=1792903041";

export async function initTithingForm(mount, token) {
  const fail = (title, msg) => { mount.innerHTML = `<div class="td-card td-msg"><h2>${esc(title)}</h2><p>${esc(msg)}</p></div>`; };
  if (!token) return fail("This link is incomplete", "Ask the person who sent it for the full link.");
  let snap;
  try { snap = await getDoc(doc(db, "tithing", token)); }
  catch { return fail("Couldn't open the sign-up", "Check your connection and try again."); }
  if (!snap.exists()) return fail("This link isn't active", "Ask the bishop or the executive secretary for the current link.");
  const season = snap.data();
  if (season.open !== true) return fail("Sign-ups are closed", "Please contact the bishop or the executive secretary to set up a time.");

  const mineKey = "td-mine-" + token;
  const readMine = () => { try { return JSON.parse(localStorage.getItem(mineKey) || "null"); } catch { return null; } };
  const saveMine = (v) => { try { localStorage.setItem(mineKey, JSON.stringify(v)); } catch {} };

  const slots = slotsOf(season.windows, offList(season)).filter((s) => !s.blocked); // blocked-out or calendar-busy times simply aren't offered
  const winById = Object.fromEntries((season.windows || []).map((w) => [w.id, w]));
  let taken = new Map(); // slotId -> minutes
  let justBooked = null;
  // a time someone has tapped and is filling the form for is "held" for a few minutes so two people can't pick it at once (10/24)
  const HOLD_MS = 3 * 60 * 1000, myKey = "k" + Math.random().toString(36).slice(2, 12);
  let holds = new Map(); // slotId -> { at: ms, k }
  const isHeld = (s) => { const h = holds.get(s.id); return !!h && h.k !== myKey && Date.now() - h.at < HOLD_MS; };
  // only the next few open times each day are offered, so nobody picks 4 PM while 1:10 sits empty (Jordan 10/24)
  const OPEN_AHEAD = Number(season.openAhead ?? 4);

  const isTaken = (s) => {
    if (taken.has(s.id)) return true;
    // a time booked under an earlier slot length still blocks whatever overlaps it
    for (const [id, len] of taken) {
      const p = parseSlotId(id);
      if (p && p.date === s.date && p.min < s.min + s.len && s.min < p.min + (Number(len) || 15)) return true;
    }
    return false;
  };
  const isPast = (s) => s.date < todayIso() || (s.date === todayIso() && s.min <= nowMin());
  const describe = (s) => `${fmtLongDay(s.date)} at ${fmtClock(s.min)}`;
  const whereLine = (s) => (s.place === "home" ? "The bishop will come to your home" : "At the Bishop's office");

  function render() {
    const upcoming = slots.filter((s) => !isPast(s));
    const mine = justBooked || readMine();
    const mineSlot = mine && slots.find((s) => s.id === mine.id);
    const anyPriority = upcoming.some((s) => s.priority);
    const days = [...new Set(upcoming.map((s) => s.date))];
    const openCount = upcoming.filter((s) => !isTaken(s)).length;

    const dayHtml = days.map((d) => {
      const wins = sortWindows(season.windows).filter((w) => w.date === d);
      // the day's open times in order; only the first few are offered, the rest open up as those fill
      // priority times are always offered; the "next few" rule applies to the regular times only (Jordan 10/24)
      const openToday = upcoming.filter((s) => s.date === d && !isTaken(s)).sort((a, b) => a.min - b.min);
      const regular = openToday.filter((s) => !s.priority);
      const offered = new Set([...openToday.filter((s) => s.priority), ...(OPEN_AHEAD > 0 ? regular.slice(0, OPEN_AHEAD) : regular)].map((s) => s.id));
      const hidden = OPEN_AHEAD > 0 ? Math.max(0, regular.length - OPEN_AHEAD) : 0;
      const blocks = wins.map((w) => {
        const all = upcoming.filter((s) => s.win === w.id); if (!all.length) return ""; // every window of the day shows, even before its times open up
        const list = all.filter((s) => isTaken(s) || offered.has(s.id));
        const span = `${fmtClock(toMin(w.start))} – ${fmtClock(toMin(w.end))}`;
        // a priority block is an amber panel with its own heading (wireframe A, 2026-10-18); the wording is in the intro
        // "At the Bishop's office" is left unsaid — only a home visit says where
        const pri = isPriority(w);
        return `
          <div class="td-win${pri ? " td-win-res" : ""}">
            ${pri ? `<div class="td-res-h">🔒 Priority time slots</div>${w.priorityText && w.priorityText !== (season.priorityText || PRIORITY_TEXT) ? `<p class="td-res-txt">${esc(w.priorityText)}</p>` : ""}` : ""}
            <div class="td-win-head">
              <span class="td-span">${span}</span>
              ${w.place === "home" ? `<span class="td-place">🏠 ${esc(PLACES.home.pub)}</span>` : ""}
              <span class="td-len">${Number(w.len) || 15}-minute visits</span>
            </div>
            ${list.length ? "" : `<p class="td-later">These times open up as the earlier ones fill.</p>`}
            <div class="td-slots">
              ${list.map((s) => (isTaken(s)
                ? `<span class="td-slot td-slot-taken" aria-disabled="true">${fmtClock(s.min)}</span>`
                : isHeld(s) ? `<span class="td-slot td-slot-held" aria-disabled="true" title="Someone is signing up for this time right now">${fmtClock(s.min)}<small>being taken</small></span>`
                : `<button type="button" class="td-slot" data-slot="${s.id}">${fmtClock(s.min)}</button>`)).join("")}
            </div>
          </div>`;
      }).join("");
      return blocks ? `<section class="td-card td-day"><h2>${esc(fmtLongDay(d))}</h2>${blocks}${hidden ? `<p class="td-more">${hidden} more time${hidden === 1 ? "" : "s"} open${hidden === 1 ? "s" : ""} up as these fill.</p>` : ""}</section>` : "";
    }).join("");

    mount.innerHTML = `
      <div class="td-card td-intro">
        <h1>Tithing Declaration</h1>
        <p class="td-ward">${esc(season.ward || "6th Ward")}</p>
        ${season.note ? `<p class="td-note">${esc(season.note)}</p>` : ""}
        <p>Pick a time that works for you and your family, then add your name. That's it.</p>
        ${anyPriority ? `<p class="td-legend">${esc(season.priorityText || PRIORITY_TEXT)}</p>` : ""}
      </div>
      ${mineSlot ? `<div class="td-card td-mine"><div class="td-tick">✓</div><div><b>You're signed up${mine.name ? ", " + esc(mine.name) : ""}.</b><div>${esc(describe(mineSlot))}</div><div class="td-sub">${mineSlot.place === "home" ? esc(whereLine(mineSlot)) + ". " : ""}Need to change it? Contact the bishop or the executive secretary.</div></div></div>` : ""}
      ${dayHtml || `<div class="td-card td-msg"><h2>No open times right now</h2><p>Please check back, or contact the bishop or the executive secretary.</p></div>`}
      ${dayHtml && !openCount ? `<div class="td-card td-msg"><p>Every time is taken at the moment. Please contact the bishop or the executive secretary.</p></div>` : ""}
      <p class="td-foot">Only the bishop and the people who help him schedule can see who signed up.</p>
      <div class="td-sheet-bg" id="td-sheet-bg" hidden><div class="td-sheet" id="td-sheet" role="dialog" aria-modal="true"></div></div>`;

    mount.querySelectorAll("[data-slot]").forEach((b) => b.addEventListener("click", () => holdThenOpen(slots.find((s) => s.id === b.dataset.slot), b)));
  }

  // tap a time → hold it (fails if someone else holds it) → open the form
  async function holdThenOpen(s, btn) {
    if (!s) return;
    if (isHeld(s)) { render(); return; }
    btn.disabled = true;
    try { await setDoc(doc(db, "tithing", token, "holds", s.id), { at: serverTimestamp(), k: myKey }); holds.set(s.id, { at: Date.now(), k: myKey }); }
    catch (e) { btn.disabled = false; holds.set(s.id, { at: Date.now(), k: "other" }); render(); return; } // someone else just took hold of it
    openSheet(s);
  }
  const releaseHold = (s) => { holds.delete(s.id); deleteDoc(doc(db, "tithing", token, "holds", s.id)).catch(() => {}); };

  function openSheet(s) {
    if (!s) return;
    const bg = mount.querySelector("#td-sheet-bg"), sheet = mount.querySelector("#td-sheet");
    const prev = readMine();
    sheet.innerHTML = `
      <h2>${esc(fmtLongDay(s.date))}</h2>
      <p class="td-when">${fmtClock(s.min)} · ${s.len} minutes${s.place === "home" ? `<br>🏠 ${esc(whereLine(s))}` : ""}</p>
      ${s.priority ? `<p class="td-flag td-flag-note td-flag-block">🔒 This is a priority time slot. ${esc(s.priorityText || season.priorityText || PRIORITY_TEXT)}</p>` : ""}
      <label class="td-field"><span>Your name <i>(or family name)</i></span><input id="td-name" autocomplete="name" maxlength="80" placeholder="e.g. The Hansen family"></label>
      <label class="td-field"><span>Mobile number <i>(optional — only if you'd like a text reminder)</i></span><input id="td-phone" type="tel" inputmode="tel" autocomplete="tel" maxlength="30" placeholder="(435) 555-0123"></label>
      ${s.place === "home" ? `<label class="td-field"><span>Your address <i>(optional)</i></span><input id="td-addr" autocomplete="street-address" maxlength="160" placeholder="Street address"></label>` : ""}
      ${prev ? `<p class="td-sub">You already signed up for a time on this device. This adds another one.</p>` : ""}
      <p class="td-err" id="td-err" hidden></p>
      <div class="td-actions"><button type="button" class="td-btn td-btn-ghost" id="td-cancel">Back</button><button type="button" class="td-btn td-btn-primary" id="td-go">Sign me up</button></div>`;
    bg.hidden = false;
    let booked = false;
    const close = () => { bg.hidden = true; sheet.innerHTML = ""; if (!booked) releaseHold(s); render(); }; // re-draw: times may have gone while the form was open
    const err = (m) => { const e = sheet.querySelector("#td-err"); e.textContent = m; e.hidden = false; };
    sheet.querySelector("#td-cancel").addEventListener("click", close);
    bg.addEventListener("click", (e) => { if (e.target === bg) close(); }, { once: true });
    const nameEl = sheet.querySelector("#td-name");
    setTimeout(() => nameEl.focus(), 50);
    const go = sheet.querySelector("#td-go");
    const submit = async () => {
      const name = nameEl.value.trim();
      const phone = sheet.querySelector("#td-phone").value.trim();
      const address = sheet.querySelector("#td-addr")?.value.trim() || "";
      if (!name) { nameEl.focus(); return err("Please enter your name."); }
      if (isTaken(s)) return err("Someone just took that time. Go back and pick another.");
      go.disabled = true; go.textContent = "Saving…";
      try {
        // both docs go in together: the public marker that the time is gone, and the private name
        const batch = writeBatch(db);
        batch.set(doc(db, "tithing", token, "taken", s.id), { len: s.len, at: serverTimestamp() });
        batch.set(doc(db, "tithing", token, "signups", s.id), { name, phone, address, at: serverTimestamp() });
        batch.delete(doc(db, "tithing", token, "holds", s.id)); // the hold has done its job
        await batch.commit();
        booked = true; holds.delete(s.id);
        justBooked = { id: s.id, name };
        saveMine(justBooked);
        taken.set(s.id, s.len);
        close();
        window.scrollTo({ top: 0, behavior: "smooth" });
      } catch (e) {
        go.disabled = false; go.textContent = "Sign me up";
        err(e && e.code === "permission-denied"
          ? "That time was just taken, or sign-ups have closed. Go back and pick another."
          : "Couldn't save — check your connection and try again.");
      }
    };
    go.addEventListener("click", submit);
    sheet.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.tagName === "INPUT") { e.preventDefault(); submit(); } if (e.key === "Escape") close(); });
  }

  render();
  const sheetOpen = () => mount.querySelector("#td-sheet-bg") && !mount.querySelector("#td-sheet-bg").hidden;
  onSnapshot(collection(db, "tithing", token, "holds"), (qs) => {
    holds = new Map(qs.docs.map((d) => { const x = d.data(); return [d.id, { at: x.at?.toMillis ? x.at.toMillis() : Date.now(), k: x.k || "" }]; }));
    if (!sheetOpen()) render();
  }, () => {});
  setInterval(() => { if (!sheetOpen() && [...holds.values()].some((h) => Date.now() - h.at >= HOLD_MS)) render(); }, 20000); // held times come back once a hold expires
  onSnapshot(collection(db, "tithing", token, "taken"), (qs) => {
    taken = new Map(qs.docs.map((d) => [d.id, d.data().len]));
    // don't yank the form out from under someone who is typing their name
    if (mount.querySelector("#td-sheet-bg") && !mount.querySelector("#td-sheet-bg").hidden) return;
    render();
  }, () => {});
}
