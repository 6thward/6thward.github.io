// People tab (bishop only).
//  * PIN people — created here: a name, a 6-digit PIN, and a permission per
//    area (Hidden / View / Edit). They sign in with just the PIN.
//  * Google sign-ins — approve and assign a role, as before.
import { db } from "./firebase-init.js?v=1789345645";
import { ctx, AREAS } from "./app.js?v=1789345645";
import {
  collection, onSnapshot, updateDoc, setDoc, deleteDoc, doc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { toast, esc, openModal, closeModal } from "./ui.js?v=1789345645";
import { createPinAccount, deletePinAccount, randomPin, validPin } from "./pin-auth.js?v=1789345645";

const ROLES = [
  ["pending", "Pending (no access)"],
  ["member", "Member"],
  ["bishopric", "Bishopric / Clerk"],
  ["bishop", "Bishop"],
];
const LEVELS = [["", "Hidden"], ["view", "View"], ["edit", "Edit"]];

let users = [];
let pins = {};          // uid -> pin (bishop-only collection)
let started = false;

export function initAdmin() {
  if (started) return;
  started = true;
  const panel = document.getElementById("panel-admin");
  panel.innerHTML = `
    <div class="panel-head">
      <div>
        <h2>People</h2>
        <p class="panel-sub">Who can open the app, and what each person can see and change.</p>
      </div>
      <button class="btn btn-primary" id="btn-new-pin">+ Add person with a PIN</button>
    </div>

    <div class="card">
      <h3 class="card-title">PIN people</h3>
      <p class="row-sub" style="margin:0 0 .6rem">They open the site and type their PIN — no Google account needed. Give each person only the areas they need.</p>
      <table class="simple" id="pin-table">
        <thead><tr><th>Name</th><th>PIN</th>${AREAS.map((a) => `<th>${esc(a.label)}</th>`).join("")}<th></th></tr></thead>
        <tbody id="pin-rows"></tbody>
      </table>
    </div>

    <div class="card" style="margin-top:1rem">
      <h3 class="card-title">Google sign-ins</h3>
      <table class="simple">
        <thead><tr><th>Name</th><th>Email</th><th>Role</th></tr></thead>
        <tbody id="user-rows"></tbody>
      </table>
      <div class="row-sub" style="margin-top:.8rem">
        <b>Member</b> — sees tasks, sacrament plans, and the calendar; can update their own tasks.<br>
        <b>Bishopric / Clerk</b> — everything above, plus create/edit anything and see the Bishopric tab.<br>
        <b>Bishop</b> — everything, including Confidential and this page.
      </div>
    </div>`;

  panel.querySelector("#btn-new-pin").addEventListener("click", () => editPinPerson(null));

  onSnapshot(collection(db, "users"), (qs) => {
    users = qs.docs.map((d) => ({ uid: d.id, ...d.data() }));
    users.sort((a, b) => {
      const rank = (u) => (u.role === "pending" ? 0 : 1);
      return rank(a) - rank(b) || (a.name || "").localeCompare(b.name || "");
    });
    render();
  });
  onSnapshot(collection(db, "pins"), (qs) => {
    pins = {};
    qs.docs.forEach((d) => { pins[d.id] = d.data().pin; });
    render();
  });
}

function levelPill(level) {
  if (level === "edit") return `<span class="pill pill-ok">Edit</span>`;
  if (level === "view") return `<span class="pill">View</span>`;
  return `<span class="pill pill-muted">—</span>`;
}

function render() {
  const pinBody = document.getElementById("pin-rows");
  const tbody = document.getElementById("user-rows");
  if (!pinBody || !tbody) return;

  const pinPeople = users.filter((u) => u.role === "pin");
  pinBody.innerHTML = pinPeople.length ? pinPeople.map((u) => `
    <tr>
      <td><b>${esc(u.name || "—")}</b></td>
      <td><code class="pin-code">${esc(pins[u.uid] || "••••••")}</code></td>
      ${AREAS.map((a) => `<td>${levelPill((u.perms || {})[a.key])}</td>`).join("")}
      <td style="text-align:right;white-space:nowrap">
        <button class="btn btn-sm" data-editpin="${u.uid}">Edit</button>
        <button class="btn btn-sm btn-ghost btn-danger" data-delpin="${u.uid}">Remove</button>
      </td>
    </tr>`).join("")
    : `<tr><td colspan="${AREAS.length + 3}" class="empty-note">No PIN people yet — use “+ Add person with a PIN”.</td></tr>`;
  pinBody.querySelectorAll("[data-editpin]").forEach((b) => b.addEventListener("click", () => editPinPerson(users.find((u) => u.uid === b.dataset.editpin))));
  pinBody.querySelectorAll("[data-delpin]").forEach((b) => b.addEventListener("click", () => removePinPerson(users.find((u) => u.uid === b.dataset.delpin))));

  const googlePeople = users.filter((u) => u.role !== "pin");
  if (!googlePeople.length) {
    tbody.innerHTML = `<tr><td colspan="3" class="empty-note">No one has signed in with Google yet.</td></tr>`;
  } else {
    tbody.innerHTML = googlePeople.map((u) => `
      <tr>
        <td>${esc(u.name || "—")}${u.uid === ctx.uid ? " <span class='row-sub'>(you)</span>" : ""}</td>
        <td>${esc(u.email || "")}</td>
        <td>
          ${u.uid === ctx.uid
            ? `<span class="pill pill-role-bishop">Bishop</span>`
            : `<select data-uid="${u.uid}">
                ${ROLES.map(([k, l]) => `<option value="${k}" ${u.role === k ? "selected" : ""}>${l}</option>`).join("")}
              </select>`}
        </td>
      </tr>`).join("");
    tbody.querySelectorAll("select").forEach((sel) =>
      sel.addEventListener("change", async () => {
        try {
          await updateDoc(doc(db, "users", sel.dataset.uid), { role: sel.value });
          toast("Role updated");
        } catch (err) {
          toast("Couldn't update: " + (err.code || err.message));
        }
      }));
  }
}

// ---- Add / edit a PIN person ----
function editPinPerson(u) {
  const isNew = !u;
  const perms = (u && u.perms) || {};
  const pin = isNew ? randomPin() : (pins[u.uid] || "");
  const el = openModal(`
    <h3>${isNew ? "Add a person with a PIN" : "Edit " + esc(u.name || "person")}</h3>
    <div class="form-grid">
      <label class="field">
        <span>Name</span>
        <input id="pp-name" value="${esc(u?.name || "")}" placeholder="First and last name" autocomplete="off">
      </label>
      <label class="field">
        <span>PIN <span class="row-sub">(6 digits — they type only this to sign in)</span></span>
        <div style="display:flex;gap:.5rem;align-items:center">
          <input id="pp-pin" class="pin-code-input" value="${esc(pin)}" inputmode="numeric" maxlength="6" autocomplete="off" ${isNew ? "" : "readonly"}>
          ${isNew
            ? `<button class="btn btn-sm" type="button" id="pp-shuffle" title="Pick another random PIN">🎲</button>`
            : `<button class="btn btn-sm" type="button" id="pp-changepin">Change PIN…</button>`}
        </div>
      </label>
    </div>
    <h4 style="margin:1rem 0 .4rem">What can they see and change?</h4>
    <table class="simple perm-grid">
      <thead><tr><th>Area</th>${LEVELS.map(([, l]) => `<th>${l}</th>`).join("")}</tr></thead>
      <tbody>
        ${AREAS.map((a) => `
          <tr>
            <td><b>${esc(a.label)}</b><div class="row-sub">${esc(a.hint)}</div></td>
            ${LEVELS.map(([k]) => `<td class="perm-cell"><input type="radio" name="perm-${a.key}" value="${k}" ${((perms[a.key] || "") === k) ? "checked" : ""} aria-label="${esc(a.label)} ${k || "hidden"}"></td>`).join("")}
          </tr>`).join("")}
      </tbody>
    </table>
    <p class="row-sub" style="margin:.6rem 0 0">“Hidden” areas don't appear for them at all. These permissions are enforced by the database, not just the menu.</p>
    <p id="pp-err" class="login-error hidden"></p>
    <div class="modal-actions">
      <button class="btn" id="pp-cancel">Cancel</button>
      <button class="btn btn-primary" id="pp-save">${isNew ? "Create" : "Save"}</button>
    </div>`);

  el.querySelector("#pp-cancel").addEventListener("click", closeModal);
  el.querySelector("#pp-shuffle")?.addEventListener("click", () => { el.querySelector("#pp-pin").value = randomPin(); });
  el.querySelector("#pp-changepin")?.addEventListener("click", () => changePin(u));

  const readPerms = () => {
    const out = {};
    AREAS.forEach((a) => { out[a.key] = (el.querySelector(`input[name="perm-${a.key}"]:checked`) || {}).value || ""; });
    return out;
  };
  const showErr = (m) => { const e = el.querySelector("#pp-err"); e.textContent = m; e.classList.remove("hidden"); };

  el.querySelector("#pp-save").addEventListener("click", async () => {
    const name = el.querySelector("#pp-name").value.trim();
    const newPin = el.querySelector("#pp-pin").value.trim();
    const newPerms = readPerms();
    if (!name) return showErr("Enter a name.");
    if (isNew && !validPin(newPin)) return showErr("PIN must be exactly 6 digits.");
    if (!AREAS.some((a) => newPerms[a.key])) return showErr("Give them at least one area, or they'd sign in to nothing.");
    const btn = el.querySelector("#pp-save");
    btn.disabled = true; btn.textContent = isNew ? "Creating…" : "Saving…";
    try {
      if (isNew) {
        const uid = await createPinAccount(newPin);
        await setDoc(doc(db, "users", uid), {
          name, role: "pin", perms: newPerms, email: "",
          createdAt: serverTimestamp(), createdBy: ctx.name || ctx.email || "",
        });
        await setDoc(doc(db, "pins", uid), { pin: newPin, name, updatedAt: serverTimestamp() });
        toast(`${name} added — their PIN is ${newPin}`);
      } else {
        await updateDoc(doc(db, "users", u.uid), { name, perms: newPerms });
        if (pins[u.uid]) await updateDoc(doc(db, "pins", u.uid), { name });
        toast("Saved");
      }
      closeModal();
    } catch (err) {
      showErr(err.message || err.code || String(err));
      btn.disabled = false; btn.textContent = isNew ? "Create" : "Save";
    }
  });
}

// Changing a PIN = a new hidden account with the new number (the browser
// can't rename an account it doesn't own). The profile and permissions are
// copied to the new account and the old one is removed.
function changePin(u) {
  const oldPin = pins[u.uid] || "";
  const el = openModal(`
    <h3>Change PIN for ${esc(u.name || "person")}</h3>
    <p class="row-sub">They'll sign in with the new PIN from now on. Anywhere they're already signed in keeps working until they sign out.</p>
    <label class="field">
      <span>New PIN</span>
      <div style="display:flex;gap:.5rem;align-items:center">
        <input id="cp-pin" class="pin-code-input" value="${esc(randomPin())}" inputmode="numeric" maxlength="6" autocomplete="off">
        <button class="btn btn-sm" type="button" id="cp-shuffle">🎲</button>
      </div>
    </label>
    ${oldPin ? "" : `<p class="login-error">The old PIN isn't on file, so the old account can't be removed automatically — it will simply stop being linked to a profile and can't open anything.</p>`}
    <p id="cp-err" class="login-error hidden"></p>
    <div class="modal-actions">
      <button class="btn" id="cp-cancel">Cancel</button>
      <button class="btn btn-primary" id="cp-save">Change PIN</button>
    </div>`);
  el.querySelector("#cp-cancel").addEventListener("click", () => editPinPerson(u));
  el.querySelector("#cp-shuffle").addEventListener("click", () => { el.querySelector("#cp-pin").value = randomPin(); });
  el.querySelector("#cp-save").addEventListener("click", async () => {
    const newPin = el.querySelector("#cp-pin").value.trim();
    const err = el.querySelector("#cp-err");
    if (!validPin(newPin)) { err.textContent = "PIN must be exactly 6 digits."; err.classList.remove("hidden"); return; }
    const btn = el.querySelector("#cp-save");
    btn.disabled = true; btn.textContent = "Changing…";
    try {
      const newUid = await createPinAccount(newPin);
      await setDoc(doc(db, "users", newUid), {
        name: u.name || "", role: "pin", perms: u.perms || {}, email: "",
        createdAt: serverTimestamp(), createdBy: ctx.name || ctx.email || "", replaces: u.uid,
      });
      await setDoc(doc(db, "pins", newUid), { pin: newPin, name: u.name || "", updatedAt: serverTimestamp() });
      await deleteDoc(doc(db, "users", u.uid));
      await deleteDoc(doc(db, "pins", u.uid)).catch(() => {});
      if (oldPin) await deletePinAccount(oldPin).catch(() => {});
      toast(`PIN changed — ${u.name || "they"} now use ${newPin}`);
      closeModal();
    } catch (e) {
      err.textContent = e.message || e.code || String(e); err.classList.remove("hidden");
      btn.disabled = false; btn.textContent = "Change PIN";
    }
  });
}

async function removePinPerson(u) {
  if (!u) return;
  if (!confirm(`Remove ${u.name || "this person"}? Their PIN stops working immediately.`)) return;
  try {
    await deleteDoc(doc(db, "users", u.uid));
    await deleteDoc(doc(db, "pins", u.uid)).catch(() => {});
    if (pins[u.uid]) await deletePinAccount(pins[u.uid]).catch(() => {});
    toast(`${u.name || "Person"} removed`);
  } catch (err) {
    toast("Couldn't remove: " + (err.code || err.message));
  }
}
