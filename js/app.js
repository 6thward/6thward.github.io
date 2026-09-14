// App shell: auth flow (Google + PIN), permission gating, tab routing.
import { auth, db, googleProvider, BISHOP_EMAIL, pinEmail, isPinEmail, PIN_LENGTH } from "./firebase-init.js?v=1789345241";
import {
  signInWithPopup, signInWithEmailAndPassword, signOut, onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  doc, getDoc, setDoc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { initTasks } from "./tasks.js?v=1789345241";
import { initSacrament } from "./sacrament.js?v=1789345241";
import { initCalendar } from "./calendar.js?v=1789345241";
import { initCallings } from "./callings.js?v=1789345241";
import { initConfidential } from "./confidential.js?v=1789345241";
import { initAdmin } from "./admin.js?v=1789345241";
import { initBoard } from "./board.js?v=1789345241";
import { initHomeSacrament } from "./home-sacrament.js?v=1789345241";

const ROLE_RANK = { pending: 0, member: 1, bishopric: 2, bishop: 3 };

// The areas a person can be granted. Order = order on the People tab.
// Google roles map onto these too (see permsForRole) so every module asks
// one question — can(area, level) — regardless of how the person signed in.
export const AREAS = [
  { key: "sacrament",    label: "Sacrament Mtg", hint: "Sunday agendas, speakers, hymns, ward business" },
  { key: "calendar",     label: "Calendar",      hint: "Ward events" },
  { key: "tasks",        label: "Tasks",         hint: "Assignments and follow-ups" },
  { key: "callings",     label: "Bishopric",     hint: "Callings and releases pipeline — sensitive" },
  { key: "board",        label: "Member Board",  hint: "Person cards sorted into sections you name" },
  { key: "confidential", label: "Confidential",  hint: "Bishop's private notes — grant with care" },
  { key: "people",       label: "People",        hint: "Create PINs and set permissions (bishop only)" },
];

// current signed-in user's context, shared with all tab modules
export const ctx = { uid: null, name: null, email: null, role: null, perms: {}, isPin: false };

export function hasRole(minRole) {
  return (ROLE_RANK[ctx.role] ?? 0) >= (ROLE_RANK[minRole] ?? 0);
}

// What a Google role implies, area by area ('' hidden | 'view' | 'edit').
function permsForRole(role) {
  const all = (lvl) => Object.fromEntries(AREAS.map((a) => [a.key, lvl]));
  if (role === "bishop") return all("edit");
  if (role === "bishopric") return { ...all("edit"), confidential: "", people: "" };
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
    loginError("Sign-in failed: " + (err.code || err.message));
  }
});
$("btn-signout").addEventListener("click", () => signOut(auth));
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
    if (!refreshLockUi()) setTimeout(() => pinInput.focus(), 50);
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
    ctx.perms = { ...permsForRole(""), ...(d.perms || {}) };
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
    }
    ctx.perms = permsForRole(ctx.role);

    if (ctx.role === "pending") {
      hide("login-screen"); hide("app"); show("pending-screen");
      return;
    }
  }

  // ---- Enter the app ----
  hide("login-screen"); hide("pending-screen"); show("app");
  $("user-name").textContent = ctx.name;
  const photo = $("user-photo");
  if (!ctx.isPin && user.photoURL) { photo.src = user.photoURL; photo.classList.remove("hidden"); }
  else photo.classList.add("hidden");

  // show only the tabs this person may see
  document.querySelectorAll("#main-tabs .tab").forEach((t) => {
    const area = t.dataset.area;
    t.classList.toggle("hidden", !!area && !can(area));
  });

  if (can("tasks")) initTasks();
  if (can("sacrament")) initSacrament();
  if (can("sacrament")) initHomeSacrament();
  if (can("calendar")) initCalendar();
  if (can("callings")) initCallings();
  if (can("board")) initBoard();
  if (can("confidential")) initConfidential();
  if (can("people")) initAdmin();

  selectTab(localStorage.getItem("sw-tab") || "sacrament");
});

// ---- Tabs ----
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
}
document.getElementById("main-tabs").addEventListener("click", (e) => {
  const tab = e.target.closest(".tab");
  if (tab) selectTab(tab.dataset.tab);
});
