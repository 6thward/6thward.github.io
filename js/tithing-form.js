// Public tithing-declaration sign-up (2026-10-04): tithing.html?k=TOKEN
// No sign-in. Anyone with the link sees the open times (never who took the
// others), picks one, and leaves a name — plus a phone number if they'd like
// a text reminder.
import { db } from "./firebase-init.js?v=1791165769";
import {
  doc, getDoc, collection, onSnapshot, writeBatch, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import {
  GROUPS, PLACES, esc, fmtClock, fmtLongDay, slotsOf, sortWindows, parseSlotId, todayIso, nowMin,
} from "./tithing-shared.js?v=1791165769";

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

  const slots = slotsOf(season.windows, season.blocked).filter((s) => !s.blocked); // blocked-out times simply aren't offered
  const winById = Object.fromEntries((season.windows || []).map((w) => [w.id, w]));
  let taken = new Map(); // slotId -> minutes
  let justBooked = null;

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
    const flagged = [...new Set(upcoming.map((s) => s.group).filter(Boolean))];
    const days = [...new Set(upcoming.map((s) => s.date))];
    const openCount = upcoming.filter((s) => !isTaken(s)).length;

    const dayHtml = days.map((d) => {
      const wins = sortWindows(season.windows).filter((w) => w.date === d);
      const blocks = wins.map((w) => {
        const list = upcoming.filter((s) => s.win === w.id);
        if (!list.length) return "";
        const g = GROUPS[w.group];
        return `
          <div class="td-win${g ? " td-win-" + g.cls : ""}">
            <div class="td-win-head">
              <span class="td-place">${PLACES[w.place]?.icon || "🏛"} ${esc(PLACES[w.place]?.pub || PLACES.office.pub)}</span>
              ${g ? `<span class="td-flag td-flag-${g.cls}">Set aside for ${esc(g.label.toLowerCase())}</span>` : ""}
              <span class="td-len">${Number(w.len) || 15}-minute visits</span>
            </div>
            <div class="td-slots">
              ${list.map((s) => (isTaken(s)
                ? `<span class="td-slot td-slot-taken" aria-disabled="true">${fmtClock(s.min)}</span>`
                : `<button type="button" class="td-slot" data-slot="${s.id}">${fmtClock(s.min)}</button>`)).join("")}
            </div>
          </div>`;
      }).join("");
      return blocks ? `<section class="td-card td-day"><h2>${esc(fmtLongDay(d))}</h2>${blocks}</section>` : "";
    }).join("");

    mount.innerHTML = `
      <div class="td-card td-intro">
        <h1>Tithing Declaration</h1>
        <p class="td-ward">${esc(season.ward || "6th Ward")}</p>
        ${season.note ? `<p class="td-note">${esc(season.note)}</p>` : ""}
        <p>Pick a time that works for you and your family, then add your name. That's it.</p>
        ${flagged.length ? `<p class="td-legend">Some times are set aside for ${flagged.map((k) => `<b>${esc(GROUPS[k].label.toLowerCase())}</b>`).join(" or ")}. If that's you, please use one of those — everyone is welcome at the unmarked times.</p>` : ""}
      </div>
      ${mineSlot ? `<div class="td-card td-mine"><div class="td-tick">✓</div><div><b>You're signed up${mine.name ? ", " + esc(mine.name) : ""}.</b><div>${esc(describe(mineSlot))}</div><div class="td-sub">${esc(whereLine(mineSlot))}. Need to change it? Contact the bishop or the executive secretary.</div></div></div>` : ""}
      ${dayHtml || `<div class="td-card td-msg"><h2>No open times right now</h2><p>Please check back, or contact the bishop or the executive secretary.</p></div>`}
      ${dayHtml && !openCount ? `<div class="td-card td-msg"><p>Every time is taken at the moment. Please contact the bishop or the executive secretary.</p></div>` : ""}
      <p class="td-foot">Only the bishop and the people who help him schedule can see who signed up.</p>
      <div class="td-sheet-bg" id="td-sheet-bg" hidden><div class="td-sheet" id="td-sheet" role="dialog" aria-modal="true"></div></div>`;

    mount.querySelectorAll("[data-slot]").forEach((b) => b.addEventListener("click", () => openSheet(slots.find((s) => s.id === b.dataset.slot))));
  }

  function openSheet(s) {
    if (!s) return;
    const bg = mount.querySelector("#td-sheet-bg"), sheet = mount.querySelector("#td-sheet");
    const g = GROUPS[s.group];
    const prev = readMine();
    sheet.innerHTML = `
      <h2>${esc(fmtLongDay(s.date))}</h2>
      <p class="td-when">${fmtClock(s.min)} · ${s.len} minutes<br>${PLACES[s.place]?.icon || ""} ${esc(whereLine(s))}</p>
      ${g ? `<p class="td-flag td-flag-${g.cls} td-flag-block">This time is set aside for ${esc(g.label.toLowerCase())}. If that's you, go right ahead.</p>` : ""}
      <label class="td-field"><span>Your name <i>(or family name)</i></span><input id="td-name" autocomplete="name" maxlength="80" placeholder="e.g. The Hansen family"></label>
      <label class="td-field"><span>Mobile number <i>(optional — only if you'd like a text reminder)</i></span><input id="td-phone" type="tel" inputmode="tel" autocomplete="tel" maxlength="30" placeholder="(435) 555-0123"></label>
      ${s.place === "home" ? `<label class="td-field"><span>Your address <i>(optional)</i></span><input id="td-addr" autocomplete="street-address" maxlength="160" placeholder="Street address"></label>` : ""}
      ${prev ? `<p class="td-sub">You already signed up for a time on this device. This adds another one.</p>` : ""}
      <p class="td-err" id="td-err" hidden></p>
      <div class="td-actions"><button type="button" class="td-btn td-btn-ghost" id="td-cancel">Back</button><button type="button" class="td-btn td-btn-primary" id="td-go">Sign me up</button></div>`;
    bg.hidden = false;
    const close = () => { bg.hidden = true; sheet.innerHTML = ""; render(); }; // re-draw: times may have gone while the form was open
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
        await batch.commit();
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
  onSnapshot(collection(db, "tithing", token, "taken"), (qs) => {
    taken = new Map(qs.docs.map((d) => [d.id, d.data().len]));
    // don't yank the form out from under someone who is typing their name
    if (mount.querySelector("#td-sheet-bg") && !mount.querySelector("#td-sheet-bg").hidden) return;
    render();
  }, () => {});
}
