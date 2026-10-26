// App shell: auth flow (Google + PIN), permission gating, tab routing.
import { auth, db, googleProvider, BISHOP_EMAIL, pinEmail, isPinEmail, PIN_LENGTH } from "./firebase-init.js?v=1792984222";
import {
  signInWithPopup, signInWithEmailAndPassword, signOut, onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  doc, getDoc, setDoc, updateDoc, deleteDoc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { openModal, closeModal, toast } from "./ui.js?v=1792984222";
import { initTasks } from "./tasks.js?v=1792984222";
import { initSacrament, openMeetingLink } from "./sacrament.js?v=1792984222";
import { initCalendar, initBishopSchedule } from "./calendar.js?v=1792984222";
import { initCallings } from "./callings.js?v=1792984222";
import { initConfidential } from "./confidential.js?v=1792984222";
import { initAdmin } from "./admin.js?v=1792984222";
import { initBoard } from "./board.js?v=1792984222";
import { initHomeSacrament } from "./home-sacrament.js?v=1792984222";
import { initCouncil, initBishopric } from "./council.js?v=1792984222";
import { initMessage } from "./message.js?v=1792984222";
import { initTithingPage } from "./tithing.js?v=1792984222";
import { initSelfReliance } from "./selfreliance.js?v=1792984222";
import { QUICK_PIN_LENGTH, validQuickPin, derive, devicePins, rememberDevice, forgetDevice, createQuickAccount, changeQuickPin, deleteQuickAccount } from "./quick-pin.js?v=1792984222";

const ROLE_RANK = { pending: 0, member: 1, bishopric: 2, bishop: 3 };

// The pages a person can be granted — one per tab (2026-09-19). Access to a
// page means read AND write on it; a page not granted is invisible. Google
// roles map onto these too (see permsForRole) so every module asks one
// question — can(area, level) — regardless of how the person signed in.
export const AREAS = [
  { key: "sacrament",    label: "Sacrament Mtg",  hint: "Sunday agendas, speakers, hymns, ward business" },
  { key: "homesac",      label: "Home Sacrament", hint: "Homebound roster and who was at church" },
  { key: "calendar",     label: "Calendar",       hint: "Ward events" },
  { key: "callings",     label: "Callings",       hint: "Callings and releases pipeline — sensitive" },
  { key: "board",        label: "Member Board",   hint: "Person cards sorted into sections you name" },
  { key: "council",      label: "Ward Council",   hint: "Weekly council agendas" },
  { key: "bishopric",    label: "Bishopric",      hint: "Bishopric meeting agendas — bishop, counselors, clerk and secretaries" },
  { key: "confidential", label: "Bishop",         hint: "Bishop's private notes — grant with care" },
  { key: "selfreliance", label: "Self-Reliance",  hint: "Self-Reliance Plans people send in, with their bank and credit statements — grant with care" },
  { key: "tithing",      label: "Tithing Declaration", hint: "Set the bishop's available times, share the sign-up link, see who signed up and who came" },
  { key: "message",      label: "Message",        hint: "Text the ward council, an organization, a saved group or anyone with a mobile number — opens in your Messages app" },
  { key: "tasks",        label: "Tasks",          hint: "Assignments and follow-ups" },
  { key: "users",        label: "Users",          hint: "Add people, set their access, revoke" },
];
// Older profiles were granted the old, coarser keys; read them as the pages they covered.
const LEGACY_KEY = { homesac: "sacrament", council: "board", users: "people" };
export function normalizePerms(p) {
  const src = p || {};
  const out = {};
  AREAS.forEach((a) => {
    let v = src[a.key];
    if (v === undefined && LEGACY_KEY[a.key]) v = src[LEGACY_KEY[a.key]];
    out[a.key] = v === "edit" || v === "view" || v === true ? "edit" : ""; // access = read + write
  });
  return out;
}

// current signed-in user's context, shared with all tab modules
export const ctx = { uid: null, name: null, email: null, role: null, perms: {}, isPin: false };

export function hasRole(minRole) {
  return (ROLE_RANK[ctx.role] ?? 0) >= (ROLE_RANK[minRole] ?? 0);
}

// What a Google role implies, area by area ('' hidden | 'view' | 'edit').
function permsForRole(role) {
  const all = (lvl) => Object.fromEntries(AREAS.map((a) => [a.key, lvl]));
  if (role === "bishop") return all("edit");
  if (role === "bishopric") return { ...all("edit"), confidential: "", selfreliance: "", tithing: "", users: "" }; // private pages are granted by name only
  if (role === "member") return { ...all(""), sacrament: "view", calendar: "view", tasks: "view" };
  return all("");
}

// can("sacrament") = may see it; can("sacrament", "edit") = may change it.
export function can(area, level = "view") {
  const have = ctx.perms[area] || "";
  if (level === "edit") return have === "edit";
  return have === "view" || have === "edit";
}

const $ = (id) => document.getElementById(id);
const show = (id) => $(id).classList.remove("hidden");
const hide = (id) => $(id).classList.add("hidden");

function loginError(msg) {
  const el = $("login-error");
  if (!msg) { el.classList.add("hidden"); return; }
  el.textContent = msg;
  el.classList.remove("hidden");
}

// ---- Sign in / out ----
$("btn-google-signin").addEventListener("click", async () => {
  loginError("");
  try {
    await signInWithPopup(auth, googleProvider);
  } catch (err) {
    // "Unable to save initial state…" = the browser blocked sessionStorage, nearly always an
    // in-app browser (a link opened inside Messages, Facebook, Instagram…) or private browsing
    if (/sessionStorage|initial state/i.test(err.message || "") || err.code === "auth/web-storage-unsupported") {
      loginError("Google sign-in can't run inside this app's built-in browser. Open the page in Safari or Chrome (tap the ⋯ or share icon → “Open in browser”) and try again.");
    } else if (err.code === "auth/popup-blocked") {
      loginError("Your browser blocked the sign-in window — allow pop-ups for this site and try again.");
    } else if (err.code !== "auth/popup-closed-by-user" && err.code !== "auth/cancelled-popup-request") {
      loginError("Sign-in failed: " + (err.code || err.message));
    }
  }
});
$("btn-signout").addEventListener("click", () => { $("user-menu").classList.add("hidden"); signOut(auth); });

// ---- Quick sign-in (2026-10-11): a 4-digit PIN for anyone who has signed in with Google on this device ----
function renderQuickLogin() {
  const recs = devicePins(), uids = Object.keys(recs);
  const box = $("quick-login"), rows = $("quick-rows");
  box.classList.toggle("hidden", !uids.length);
  rows.innerHTML = uids.map((uid) => `<div class="quick-row" data-uid="${uid}">
      <span class="quick-name">${recs[uid].name || "You"}</span>
      <input class="pin-input quick-pin" inputmode="numeric" pattern="[0-9]*" maxlength="${QUICK_PIN_LENGTH}" autocomplete="off" placeholder="••••" aria-label="4-digit PIN for ${recs[uid].name || "you"}">
      <button type="button" class="btn btn-sm btn-ghost quick-forget" title="Forget this person on this device">✕</button>
    </div>`).join("");
  rows.querySelectorAll(".quick-row").forEach((row) => {
    const uid = row.dataset.uid, inp = row.querySelector(".quick-pin");
    const go = async () => {
      if (refreshLockUi()) return;
      const pin = inp.value.trim();
      if (!validQuickPin(pin)) return;
      inp.disabled = true; loginError("");
      try {
        await signInWithEmailAndPassword(auth, recs[uid].email, await derive(pin, recs[uid].salt));
        writeLock({ misses: 0, until: 0 });
      } catch (err) {
        inp.value = "";
        if (recordMiss(err.code === "auth/too-many-requests")) return;
        const left = PIN_MAX_MISSES - (readLock().misses || 0);
        loginError(`That PIN isn't right. ${left} ${left === 1 ? "try" : "tries"} left before a 15-minute lock — or sign in with Google below.`);
      } finally { if (!lockedUntil()) { inp.disabled = false; inp.focus(); } }
    };
    inp.addEventListener("input", () => { inp.value = inp.value.replace(/\D/g, "").slice(0, QUICK_PIN_LENGTH); loginError(""); if (inp.value.length === QUICK_PIN_LENGTH) go(); });
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
    row.querySelector(".quick-forget").addEventListener("click", () => { if (confirm(`Forget ${recs[uid].name || "this person"} on this device? They can sign in with Google to set it up again.`)) { forgetDevice(uid); renderQuickLogin(); } });
  });
  if (uids.length === 1) setTimeout(() => rows.querySelector(".quick-pin")?.focus(), 50);
}
renderQuickLogin();
// the name in the top bar opens a small account menu (Sign out lives there)
$("user-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  $("tabs-menu").classList.add("hidden");
  const open = $("user-menu").classList.toggle("hidden") === false;
  e.currentTarget.setAttribute("aria-expanded", String(open));
});
const closeUserMenu = () => { $("user-menu").classList.add("hidden"); $("user-btn").setAttribute("aria-expanded", "false"); };
$("btn-quick-pin").addEventListener("click", () => { closeUserMenu(); quickPinDialog(); });

// Set / change / remove your own 4-digit PIN (Google sign-ins only)
let myQuick = null; // users/{uid}.quickPin for the signed-in Google user
function quickPinDialog() {
  const has = !!myQuick;
  const el = openModal(`
    <h3>${has ? "Your 4-digit PIN" : "Set a 4-digit PIN"}</h3>
    <p class="row-sub" style="margin-top:-.6rem">${has ? "Works on any device where you've signed in with Google once." : "Next time, on this device (or any device where you've signed in with Google once), you can sign in with just the PIN."}</p>
    <div class="form-grid">
      ${has ? `<label class="field"><span>Current PIN</span><input id="qp-old" class="pin-code-input" inputmode="numeric" maxlength="4" autocomplete="off" placeholder="••••"></label>` : ""}
      <label class="field"><span>${has ? "New PIN" : "PIN"} <span class="row-sub">(4 digits)</span></span><input id="qp-new" class="pin-code-input" inputmode="numeric" maxlength="4" autocomplete="off" placeholder="••••"></label>
      <label class="field"><span>Again</span><input id="qp-again" class="pin-code-input" inputmode="numeric" maxlength="4" autocomplete="off" placeholder="••••"></label>
    </div>
    <p class="login-error hidden" id="qp-err"></p>
    <div class="modal-actions">
      ${has ? `<button class="btn btn-ghost btn-danger" id="qp-remove" type="button">Remove PIN</button>` : "<span></span>"}
      <div class="right"><button class="btn" id="qp-cancel" type="button">Cancel</button><button class="btn btn-primary" id="qp-save" type="button">${has ? "Change PIN" : "Set PIN"}</button></div>
    </div>`);
  const err = (m) => { const e = el.querySelector("#qp-err"); e.textContent = m; e.classList.toggle("hidden", !m); };
  el.querySelectorAll("input").forEach((i) => i.addEventListener("input", () => { i.value = i.value.replace(/\D/g, "").slice(0, 4); err(""); }));
  el.querySelector("#qp-cancel").addEventListener("click", closeModal);
  setTimeout(() => el.querySelector(has ? "#qp-old" : "#qp-new").focus(), 50);
  const busy = (on) => el.querySelectorAll("button").forEach((b) => { b.disabled = on; });
  el.querySelector("#qp-save").addEventListener("click", async () => {
    const pin = el.querySelector("#qp-new").value, again = el.querySelector("#qp-again").value, old = el.querySelector("#qp-old")?.value || "";
    if (!validQuickPin(pin)) return err("The PIN needs to be 4 digits.");
    if (pin !== again) return err("The two PINs don't match.");
    if (/^(\d)\1{3}$/.test(pin) || "0123456789".includes(pin) || "9876543210".includes(pin)) return err("Pick something less guessable than that.");
    busy(true);
    try {
      if (has) {
        await changeQuickPin(myQuick, old, pin);
        toast("PIN changed");
      } else {
        const acct = await createQuickAccount(pin);
        // the hidden account's profile: a mirror of mine, marked as an alias so access stays in step
        await setDoc(doc(db, "users", acct.pinUid), {
          alias: ctx.uid, name: ctx.name || "", organization: ctx.profile?.organization || "", calling: ctx.profile?.calling || "", councilMember: !!ctx.profile?.councilMember,
          role: "pin", quick: true, perms: ctx.role === "bishop" ? permsForRole("bishop") : (ctx.profile?.perms && Object.keys(ctx.profile.perms).length ? ctx.profile.perms : permsForRole(ctx.role)),
          email: "", revoked: false, createdAt: serverTimestamp(), createdBy: ctx.name || ctx.email || "",
        });
        const rec = { email: acct.email, salt: acct.salt, pinUid: acct.pinUid };
        await updateDoc(doc(db, "users", ctx.uid), { quickPin: rec });
        myQuick = rec;
        rememberDevice(ctx.uid, { name: ctx.name || "", email: rec.email, salt: rec.salt });
        renderQuickLogin();
        toast("PIN set — use it next time you sign in here");
      }
      $("btn-quick-pin").textContent = "Change or remove your PIN…";
      closeModal();
    } catch (e) { err(e.message || String(e)); busy(false); }
  });
  el.querySelector("#qp-remove")?.addEventListener("click", async () => {
    const old = el.querySelector("#qp-old").value;
    if (!confirm("Remove your PIN? You'll sign in with Google again (and can set a new PIN any time).")) return;
    busy(true);
    try {
      if (validQuickPin(old)) await deleteQuickAccount(myQuick, old).catch(() => false);
      await deleteDoc(doc(db, "users", myQuick.pinUid)).catch(() => {});
      await updateDoc(doc(db, "users", ctx.uid), { quickPin: null });
      forgetDevice(ctx.uid); myQuick = null; renderQuickLogin();
      $("btn-quick-pin").textContent = "Set a 4-digit PIN…";
      toast("PIN removed"); closeModal();
    } catch (e) { err(e.message || String(e)); busy(false); }
  });
}
document.addEventListener("click", (e) => { if (!e.target.closest("#user-wrap")) closeUserMenu(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeUserMenu(); });
$("btn-signout-pending").addEventListener("click", () => signOut(auth));

// PIN sign-in. Five wrong PINs lock this screen for 15 minutes (kept in
// localStorage so a refresh doesn't reset it, with a live countdown).
// Firebase throttles repeated wrong passwords server-side as well, so the
// lock isn't the only guard — it's the one people can see.
const PIN_MAX_MISSES = 5;
const PIN_LOCK_MS = 15 * 60 * 1000;
const LOCK_KEY = "sw-pin-lock";
const pinInput = $("pin-input");
const pinBtn = $("btn-pin-signin");
let lockTimer = null;

function readLock() {
  try { return JSON.parse(localStorage.getItem(LOCK_KEY) || "{}"); } catch { return {}; }
}
function writeLock(v) {
  try { localStorage.setItem(LOCK_KEY, JSON.stringify(v)); } catch {}
}
function lockedUntil() {
  const l = readLock();
  return l.until && l.until > Date.now() ? l.until : 0;
}
function refreshLockUi() {
  const until = lockedUntil();
  clearInterval(lockTimer); lockTimer = null;
  if (!until) {
    pinInput.disabled = false; pinBtn.disabled = false;
    return false;
  }
  pinInput.disabled = true; pinBtn.disabled = true; pinInput.value = "";
  const tick = () => {
    const left = Math.max(0, until - Date.now());
    if (!left) { refreshLockUi(); loginError(""); pinInput.focus(); return; }
    const m = Math.floor(left / 60000), sec = String(Math.floor((left % 60000) / 1000)).padStart(2, "0");
    loginError(`Too many wrong PINs. Locked for ${m}:${sec} — ask the bishop if you've forgotten yours.`);
  };
  tick();
  lockTimer = setInterval(tick, 1000);
  return true;
}
function recordMiss(hardLock) {
  const l = readLock();
  const misses = hardLock ? PIN_MAX_MISSES : (l.misses || 0) + 1;
  if (misses >= PIN_MAX_MISSES) {
    writeLock({ misses: 0, until: Date.now() + PIN_LOCK_MS });
    refreshLockUi();
    return true;
  }
  writeLock({ misses, until: 0 });
  return false;
}

pinInput.addEventListener("input", () => {
  pinInput.value = pinInput.value.replace(/\D/g, "").slice(0, PIN_LENGTH);
  loginError("");
  if (pinInput.value.length === PIN_LENGTH) pinSignIn();
});
pinInput.addEventListener("keydown", (e) => { if (e.key === "Enter") pinSignIn(); });
pinBtn.addEventListener("click", pinSignIn);

async function pinSignIn() {
  if (refreshLockUi()) return;
  const pin = pinInput.value.trim();
  if (pin.length !== PIN_LENGTH) { loginError(`Enter your ${PIN_LENGTH}-digit PIN.`); return; }
  pinBtn.disabled = true; pinInput.disabled = true;
  loginError("");
  try {
    await signInWithEmailAndPassword(auth, pinEmail(pin), pin);
    writeLock({ misses: 0, until: 0 });
  } catch (err) {
    pinInput.value = "";
    if (err.code === "auth/operation-not-allowed") {
      loginError("PIN sign-in isn't switched on yet — ask the bishop.");
    } else if (recordMiss(err.code === "auth/too-many-requests")) {
      return; // lock message + countdown already showing
    } else {
      const left = PIN_MAX_MISSES - (readLock().misses || 0);
      loginError(`That PIN isn't right. ${left} ${left === 1 ? "try" : "tries"} left before a 15-minute lock.`);
    }
  } finally {
    if (!lockedUntil()) { pinBtn.disabled = false; pinInput.disabled = false; pinInput.focus(); }
  }
}

// ---- Auth state ----
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    hide("app"); hide("pending-screen"); show("login-screen");
    pinInput.value = "";
    if (!refreshLockUi()) setTimeout(() => (document.querySelector("#quick-rows .quick-pin") || pinInput).focus(), 50); // a remembered person's 4-digit box first
    return;
  }
  ctx.uid = user.uid;
  ctx.email = user.email;
  ctx.isPin = isPinEmail(user.email);
  ctx.name = ctx.isPin ? "" : (user.displayName || user.email);

  const uref = doc(db, "users", user.uid);
  let snap;
  try {
    snap = await getDoc(uref);
  } catch {
    snap = null;
  }
  // Invited by email from the Users tab? First Google sign-in claims the
  // invite: the profile is created with the access the bishop chose. (2026-09-19)
  if ((!snap || !snap.exists()) && !isPinEmail(user.email) && user.email) {
    try {
      const inv = await getDoc(doc(db, "invites", user.email.toLowerCase()));
      if (inv.exists()) {
        const d = inv.data();
        await setDoc(uref, {
          name: d.name || ctx.name, email: user.email, photo: user.photoURL || "",
          organization: d.organization || "", calling: d.calling || "", councilMember: !!d.councilMember,
          role: "user", perms: d.perms || {}, invitedBy: d.invitedBy || "",
          createdAt: serverTimestamp(),
        });
        try { await deleteDoc(doc(db, "invites", user.email.toLowerCase())); } catch {}
        snap = await getDoc(uref);
      }
    } catch (e) { console.warn("[auth] invite", e); }
  }
  if (snap && snap.exists() && snap.data().revoked) {
    await signOut(auth);
    loginError("Your access has been turned off — ask the bishop.");
    return;
  }

  if (ctx.isPin) {
    // PIN accounts are created by the bishop together with their profile.
    // No profile = the person was removed; the account can't do anything.
    if (!snap || !snap.exists()) {
      await signOut(auth);
      loginError("That PIN is no longer active — ask the bishop.");
      return;
    }
    const d = snap.data();
    ctx.role = "pin";
    ctx.name = d.name || "PIN user";
    ctx.perms = normalizePerms(d.perms);
    if (!AREAS.some((a) => can(a.key))) {
      await signOut(auth);
      loginError("Your PIN doesn't have access to anything yet — ask the bishop.");
      return;
    }
  } else {
    // Ensure a users/{uid} profile doc exists; new Google accounts start as "pending".
    if (!snap || !snap.exists()) {
      const initialRole = user.email === BISHOP_EMAIL ? "bishop" : "pending";
      try {
        await setDoc(uref, {
          name: ctx.name,
          email: user.email,
          photo: user.photoURL || "",
          role: initialRole,
          createdAt: serverTimestamp(),
        });
        ctx.role = initialRole;
      } catch {
        ctx.role = "pending";
      }
    } else {
      ctx.role = snap.data().role || "pending";
      // the bishop's email is always bishop, even if the doc says otherwise
      if (user.email === BISHOP_EMAIL) ctx.role = "bishop";
      if (snap.data().name) ctx.name = snap.data().name;
    }
    ctx.profile = snap && snap.exists() ? snap.data() : {};
    // a PIN they set earlier works on this device from now on (the salt rides along with their Google sign-in)
    myQuick = ctx.profile.quickPin || null;
    if (myQuick && myQuick.email && myQuick.salt) rememberDevice(user.uid, { name: ctx.profile.name || ctx.name || "", email: myQuick.email, salt: myQuick.salt });
    // explicit per-page access (Users tab) wins; legacy roles fill in for older profiles
    const explicit = snap && snap.exists() ? snap.data().perms : null;
    ctx.perms = ctx.role === "bishop" ? permsForRole("bishop")
      : (explicit && Object.keys(explicit).length ? normalizePerms(explicit) : permsForRole(ctx.role));
    if (ctx.role === "user" && !AREAS.some((a) => can(a.key))) ctx.role = "pending";

    if (ctx.role === "pending") {
      hide("login-screen"); hide("app"); show("pending-screen");
      return;
    }
  }

  // ---- Enter the app ----
  // last-usage stamp for the Users tab (own doc only; rules allow just this field)
  try { await updateDoc(uref, { lastSeen: serverTimestamp() }); } catch {}
  hide("login-screen"); hide("pending-screen"); show("app");
  // top bar shows just the first name; the full name + Sign out sit in the menu under it (2026-10-04)
  const fullName = String(ctx.name || "").trim();
  $("user-name").textContent = fullName.split(/\s+/)[0] || "Account";
  $("user-full").textContent = fullName || "Signed in";
  $("user-sub").textContent = ctx.isPin ? "Signed in with a PIN" : (user.email || "");
  const qp = $("btn-quick-pin");
  qp.classList.toggle("hidden", ctx.isPin); // PIN sessions can't manage the PIN — sign in with Google for that
  qp.textContent = myQuick ? "Change or remove your PIN…" : "Set a 4-digit PIN…";
  renderQuickLogin();
  const photo = $("user-photo"), initial = $("user-initial");
  const hasPhoto = !ctx.isPin && !!user.photoURL;
  if (hasPhoto) photo.src = user.photoURL;
  photo.classList.toggle("hidden", !hasPhoto);
  initial.textContent = (fullName[0] || "?").toUpperCase();
  initial.classList.toggle("hidden", hasPhoto);

  // show only the tabs this person may see
  document.querySelectorAll("#main-tabs .tab").forEach((t) => {
    const area = t.dataset.area;
    t.classList.toggle("hidden", !!area && !can(area));
  });
  layoutTabs();

  if (can("tasks")) initTasks();
  if (can("sacrament")) initSacrament();
  if (can("homesac")) initHomeSacrament();
  if (can("calendar")) { initCalendar(); initBishopSchedule(); }
  if (can("callings")) initCallings();
  if (can("board")) initBoard();
  if (can("council")) initCouncil();
  if (can("bishopric")) initBishopric();
  if (can("confidential")) initConfidential();
  if (can("selfreliance")) initSelfReliance();
  if (can("tithing")) initTithingPage();
  if (can("message")) initMessage();
  if (can("users")) initAdmin();

  selectTab(localStorage.getItem("sw-tab") || "sacrament");
  // shared link: #sacrament/YYYY-MM-DD opens that Sunday's readout (2026-09-19)
  const link = /^#sacrament\/(\d{4}-\d{2}-\d{2})$/.exec(location.hash || "");
  if (link && can("sacrament")) { selectTab("sacrament"); openMeetingLink(link[1]); history.replaceState(null, "", location.pathname); }
});

// ---- Tabs ----
export const goTab = (name) => selectTab(name); // other pages may jump to a tab (e.g. a Member Board card → its Self-Reliance card)
function selectTab(name) {
  let tab = document.querySelector(`.tab[data-tab="${name}"]`);
  if (!tab || tab.classList.contains("hidden")) {
    tab = document.querySelector("#main-tabs .tab:not(.hidden)");
    name = tab ? tab.dataset.tab : name;
  }
  document.querySelectorAll(".tab").forEach((t) =>
    t.classList.toggle("active", t.dataset.tab === name));
  document.querySelectorAll(".panel").forEach((p) =>
    p.classList.toggle("hidden", p.id !== "panel-" + name));
  localStorage.setItem("sw-tab", name);
  layoutTabs();
}
document.getElementById("main-tabs").addEventListener("click", (e) => {
  const tab = e.target.closest(".tab");
  if (tab) selectTab(tab.dataset.tab);
});

// Tabs that don't fit on the bar move into a "☰ More" menu (2026-10-04)
const TAB_ORDER = [...document.querySelectorAll("#main-tabs .tab")];
function closeTabsMenu() {
  document.getElementById("tabs-menu").classList.add("hidden");
  document.getElementById("tabs-more-btn").setAttribute("aria-expanded", "false");
}
// when the open page lives in the menu, the button carries its name
function labelMore() {
  const act = document.querySelector("#tabs-menu .tab.active");
  document.getElementById("tabs-more-label").textContent = act ? act.textContent.trim() : "More";
  document.getElementById("tabs-more-btn").classList.toggle("active", !!act);
}
function layoutTabs() {
  const nav = document.getElementById("main-tabs"), more = document.getElementById("tabs-more"), menu = document.getElementById("tabs-menu");
  closeTabsMenu();
  TAB_ORDER.forEach((t) => nav.insertBefore(t, more));
  more.classList.add("hidden");
  const fits = () => nav.scrollWidth <= nav.clientWidth + 1;
  if (!fits()) {
    more.classList.remove("hidden");
    const shown = TAB_ORDER.filter((t) => !t.classList.contains("hidden"));
    // re-label as we go: the button widens when it carries the open page's name
    for (let i = shown.length - 1; i >= 0; i--) { labelMore(); if (fits()) break; menu.insertBefore(shown[i], menu.firstChild); }
  }
  labelMore();
}
document.getElementById("tabs-more-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  document.getElementById("user-menu").classList.add("hidden");
  const open = document.getElementById("tabs-menu").classList.toggle("hidden") === false;
  e.currentTarget.setAttribute("aria-expanded", String(open));
});
document.addEventListener("click", (e) => { if (!e.target.closest("#tabs-more")) closeTabsMenu(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeTabsMenu(); });
{
  let lastW = -1;
  const refit = () => { const w = document.getElementById("main-tabs").clientWidth; if (w !== lastW) { lastW = w; layoutTabs(); } };
  new ResizeObserver(refit).observe(document.getElementById("main-tabs"));
  window.addEventListener("resize", refit);
  document.fonts?.ready.then(layoutTabs);
}
