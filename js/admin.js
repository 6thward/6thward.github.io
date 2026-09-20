// Users tab (2026-09-19) — everyone who can open the app, on one list.
//
//   Name · Organization · Calling · Access (the pages they can open — each
//   grant is read + write; ungranted pages don't exist for them) · Last used.
//
// Two ways in:
//   * PIN — a hidden email/password account the bishop creates here; the
//     person types only the 6-digit PIN. (users/{uid}.role = 'pin')
//   * Google — invite an email address (invites/{email}); their first Google
//     sign-in claims the invite and creates their profile. (role = 'user')
// Older Google profiles with role bishopric/member keep working; the first
// time their access is edited here they become explicit per-page grants.
import { db } from "./firebase-init.js?v=1789882284";
import { ctx, AREAS, normalizePerms } from "./app.js?v=1789882284";
import {
  collection, onSnapshot, updateDoc, setDoc, deleteDoc, doc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { toast, esc, openModal, closeModal } from "./ui.js?v=1789882284";
import { createPinAccount, deletePinAccount, randomPin, validPin } from "./pin-auth.js?v=1789882284";

let users = [];
let invites = [];
let pins = {};          // uid -> pin (bishop-only collection)
let started = false;

const APP_URL = "https://6thward.github.io/";

export function initAdmin() {
  if (started) return;
  started = true;
  const panel = document.getElementById("panel-admin");
  panel.innerHTML = `
    <div class="panel-head">
      <div>
        <h2>Users</h2>
        <p class="panel-sub">Who can open the app and which pages they see. A page they aren't given doesn't exist for them.</p>
      </div>
      <button class="btn btn-primary" id="btn-new-user">+ Add user</button>
    </div>
    <div class="card">
      <div class="us-wrap">
        <table class="simple us-table" id="users-table">
          <thead><tr><th>Name</th><th>Organization</th><th>Calling</th><th>Access</th><th>Last used</th><th></th></tr></thead>
          <tbody id="user-rows"></tbody>
        </table>
      </div>
    </div>`;
  panel.querySelector("#btn-new-user").addEventListener("click", () => editUser(null));

  onSnapshot(collection(db, "users"), (qs) => {
    users = qs.docs.map((d) => ({ uid: d.id, ...d.data() }));
    render();
  });
  onSnapshot(collection(db, "invites"), (qs) => {
    invites = qs.docs.map((d) => ({ email: d.id, ...d.data(), invite: true }));
    render();
  }, () => {});
  onSnapshot(collection(db, "pins"), (qs) => {
    pins = {};
    qs.docs.forEach((d) => { pins[d.id] = d.data().pin; });
    render();
  }, () => {});
}

// effective per-page access for display (bishop = everything; legacy roles mapped)
function permsOf(u) {
  if (u.role === "bishop" || (u.email && u.email === "jordanchri@gmail.com")) return Object.fromEntries(AREAS.map((a) => [a.key, "edit"]));
  if (u.perms && Object.keys(u.perms).length) return normalizePerms(u.perms);
  if (u.role === "bishopric") return normalizePerms(Object.fromEntries(AREAS.map((a) => [a.key, a.key === "confidential" || a.key === "users" ? "" : "edit"])));
  if (u.role === "member") return normalizePerms({ sacrament: "edit", calendar: "edit", tasks: "edit" });
  return normalizePerms({});
}
const isBishopUser = (u) => u.role === "bishop" || u.email === "jordanchri@gmail.com";
const accessPills = (perms) => {
  const on = AREAS.filter((a) => perms[a.key] === "edit");
  if (!on.length) return `<span class="pill pill-muted">no pages</span>`;
  if (on.length === AREAS.length) return `<span class="pill pill-ok">All pages</span>`;
  return on.map((a) => `<span class="pill us-pill">${esc(a.label)}</span>`).join(" ");
};
function fmtSeen(ts) {
  const d = ts?.toDate?.() || (ts ? new Date(ts) : null);
  if (!d || isNaN(d)) return `<span class="row-sub">never</span>`;
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  const when = d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: days > 300 ? "numeric" : undefined });
  return `<span title="${d.toLocaleString()}">${days === 0 ? "today" : days === 1 ? "yesterday" : when}</span>`;
}
function signInPill(u) {
  if (u.invite) return `<span class="pill pill-pending" title="Invited — hasn't signed in yet">invited</span>`;
  if (u.revoked) return `<span class="pill pill-danger">revoked</span>`;
  if (u.role === "pending") return `<span class="pill pill-pending" title="Signed in with Google but hasn't been given any pages">waiting</span>`;
  if (u.role === "pin") return `<span class="pill pill-muted" title="Signs in with a PIN">PIN ${esc(pins[u.uid] || "")}</span>`;
  return `<span class="pill pill-muted" title="${esc(u.email || "")}">Google</span>`;
}

function render() {
  const tbody = document.getElementById("user-rows");
  if (!tbody) return;
  const rows = [...users, ...invites];
  rows.sort((a, b) => {
    const rank = (u) => (u.role === "pending" ? 0 : u.invite ? 1 : u.revoked ? 3 : 2);
    return rank(a) - rank(b) || (a.name || a.email || "").localeCompare(b.name || b.email || "");
  });
  if (!rows.length) { tbody.innerHTML = `<tr><td colspan="6" class="empty-note">Nobody yet — use “+ Add user”.</td></tr>`; return; }
  tbody.innerHTML = rows.map((u) => {
    const id = u.invite ? "inv:" + u.email : u.uid;
    const me = u.uid === ctx.uid;
    return `
    <tr class="${u.revoked ? "us-revoked" : ""}${u.role === "pending" ? " us-waiting" : ""}">
      <td><b>${esc(u.name || u.email || "—")}</b>${me ? " <span class='row-sub'>(you)</span>" : ""}<div class="us-sub">${signInPill(u)}${u.email && !u.invite && u.role !== "pin" ? ` <span class="row-sub">${esc(u.email)}</span>` : ""}${u.invite ? ` <span class="row-sub">${esc(u.email)}</span>` : ""}</div></td>
      <td>${esc(u.organization || "")}</td>
      <td>${esc(u.calling || "")}</td>
      <td class="us-access"><div class="us-pills">${u.revoked ? `<span class="pill pill-muted">—</span>` : accessPills(permsOf(u))}</div></td>
      <td>${u.invite ? `<span class="row-sub">invited ${fmtSeen(u.invitedAt).replace(/<[^>]+>/g, "")}</span>` : fmtSeen(u.lastSeen)}</td>
      <td class="us-actions">
        ${isBishopUser(u) && !me ? "" : ""}
        <button class="btn btn-sm" data-edit="${esc(id)}">${u.role === "pending" ? "Give access" : "Edit"}</button>
        ${u.invite || u.role === "pin" ? `<button class="btn btn-sm" data-invite="${esc(id)}" title="Copy the invitation message">✉</button>` : ""}
        ${u.invite ? `<button class="btn btn-sm btn-ghost btn-danger" data-cancel="${esc(id)}">Cancel</button>`
          : isBishopUser(u) ? ""
          : u.revoked ? `<button class="btn btn-sm" data-restore="${esc(id)}">Restore</button><button class="btn btn-sm btn-ghost btn-danger" data-remove="${esc(id)}">Remove</button>`
          : `<button class="btn btn-sm btn-ghost btn-danger" data-revoke="${esc(id)}">Revoke</button>`}
      </td>
    </tr>`;
  }).join("");
  const find = (id) => id.startsWith("inv:") ? invites.find((i) => i.email === id.slice(4)) : users.find((u) => u.uid === id);
  tbody.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener("click", () => editUser(find(b.dataset.edit))));
  tbody.querySelectorAll("[data-invite]").forEach((b) => b.addEventListener("click", () => inviteMessage(find(b.dataset.invite))));
  tbody.querySelectorAll("[data-cancel]").forEach((b) => b.addEventListener("click", () => cancelInvite(find(b.dataset.cancel))));
  tbody.querySelectorAll("[data-revoke]").forEach((b) => b.addEventListener("click", () => setRevoked(find(b.dataset.revoke), true)));
  tbody.querySelectorAll("[data-restore]").forEach((b) => b.addEventListener("click", () => setRevoked(find(b.dataset.restore), false)));
  tbody.querySelectorAll("[data-remove]").forEach((b) => b.addEventListener("click", () => removeUser(find(b.dataset.remove))));
}

// ---- Add / edit ----
function editUser(u) {
  const isNew = !u;
  const perms = u ? permsOf(u) : normalizePerms({});
  const method = isNew ? "pin" : u.invite || u.role !== "pin" ? "google" : "pin";
  const bishop = u && isBishopUser(u);
  const pin = isNew ? randomPin() : (u.role === "pin" ? pins[u.uid] || "" : "");
  const el = openModal(`
    <h3>${isNew ? "Add a user" : "Edit " + esc(u.name || u.email || "user")}</h3>
    <div class="form-grid">
      <label class="field"><span>Name</span><input id="uu-name" value="${esc(u?.name || "")}" placeholder="First and last name" autocomplete="off"></label>
      <label class="field"><span>Organization</span><input id="uu-org" value="${esc(u?.organization || "")}" placeholder="e.g. Relief Society, Elders Quorum, Primary" autocomplete="off" list="dl-orgs"></label>
      <label class="field"><span>Calling</span><input id="uu-calling" value="${esc(u?.calling || "")}" placeholder="e.g. President, Secretary, Ward Clerk" autocomplete="off"></label>
      ${isNew ? `
      <div class="field"><span>How they sign in</span>
        <div class="us-method">
          <label><input type="radio" name="uu-method" value="pin" checked> PIN <span class="row-sub">— they type a 6-digit number, no account needed</span></label>
          <label><input type="radio" name="uu-method" value="google"> Google <span class="row-sub">— invite an email address; they sign in with Google</span></label>
        </div>
      </div>
      <label class="field" id="uu-pin-field"><span>PIN</span>
        <div style="display:flex;gap:.5rem;align-items:center"><input id="uu-pin" class="pin-code-input" value="${esc(pin)}" inputmode="numeric" maxlength="6" autocomplete="off"><button class="btn btn-sm" type="button" id="uu-shuffle" title="Pick another random PIN">🎲</button></div>
      </label>
      <label class="field hidden" id="uu-email-field"><span>Google email</span><input id="uu-email" type="email" placeholder="name@gmail.com" autocomplete="off"></label>`
      : method === "pin" ? `
      <label class="field"><span>PIN</span>
        <div style="display:flex;gap:.5rem;align-items:center"><input id="uu-pin" class="pin-code-input" value="${esc(pin)}" readonly><button class="btn btn-sm" type="button" id="uu-changepin">Change PIN…</button></div>
      </label>` : `
      <label class="field"><span>Google email</span><input value="${esc(u.email || "")}" readonly></label>`}
    </div>
    <datalist id="dl-orgs">${["Bishopric", "Ward Clerk", "Executive Secretary", "Relief Society", "Elders Quorum", "Primary", "Young Women", "Young Men", "Sunday School", "Music", "Missionary", "Temple & Family History"].map((o) => `<option value="${o}">`).join("")}</datalist>
    <h4 style="margin:1rem 0 .3rem">Pages they can open</h4>
    <p class="row-sub" style="margin:0 0 .5rem">Each page is read and write. Unticked pages don't appear for them at all.</p>
    ${bishop ? `<p class="row-sub">The bishop always has every page.</p>` : `
    <div class="us-pages">
      ${AREAS.map((a) => `<label class="us-page"><input type="checkbox" data-area="${a.key}" ${perms[a.key] === "edit" ? "checked" : ""}> <span><b>${esc(a.label)}</b><div class="row-sub">${esc(a.hint)}</div></span></label>`).join("")}
    </div>
    <div style="display:flex;gap:.4rem;margin-top:.4rem"><button class="btn btn-sm" type="button" id="uu-all">All pages</button><button class="btn btn-sm" type="button" id="uu-none">None</button></div>`}
    <p id="uu-err" class="login-error hidden"></p>
    <div class="modal-actions">
      <button class="btn" id="uu-cancel">Cancel</button>
      <button class="btn btn-primary" id="uu-save">${isNew ? "Add" : "Save"}</button>
    </div>`);
  el.querySelector("#uu-cancel").addEventListener("click", closeModal);
  el.querySelector("#uu-shuffle")?.addEventListener("click", () => { el.querySelector("#uu-pin").value = randomPin(); });
  el.querySelector("#uu-changepin")?.addEventListener("click", () => changePin(u));
  el.querySelector("#uu-all")?.addEventListener("click", () => el.querySelectorAll("[data-area]").forEach((c) => { c.checked = true; }));
  el.querySelector("#uu-none")?.addEventListener("click", () => el.querySelectorAll("[data-area]").forEach((c) => { c.checked = false; }));
  el.querySelectorAll('input[name="uu-method"]').forEach((r) => r.addEventListener("change", () => {
    const g = el.querySelector('input[name="uu-method"]:checked').value === "google";
    el.querySelector("#uu-pin-field").classList.toggle("hidden", g);
    el.querySelector("#uu-email-field").classList.toggle("hidden", !g);
  }));
  const readPerms = () => Object.fromEntries(AREAS.map((a) => [a.key, el.querySelector(`[data-area="${a.key}"]`)?.checked ? "edit" : ""]));
  const showErr = (m) => { const e = el.querySelector("#uu-err"); e.textContent = m; e.classList.remove("hidden"); };

  el.querySelector("#uu-save").addEventListener("click", async () => {
    const name = el.querySelector("#uu-name").value.trim();
    const organization = el.querySelector("#uu-org").value.trim();
    const calling = el.querySelector("#uu-calling").value.trim();
    const newPerms = bishop ? null : readPerms();
    if (!name) return showErr("Enter a name.");
    if (newPerms && !AREAS.some((a) => newPerms[a.key])) return showErr("Tick at least one page, or they'd sign in to nothing.");
    const btn = el.querySelector("#uu-save");
    btn.disabled = true; btn.textContent = isNew ? "Adding…" : "Saving…";
    try {
      if (isNew) {
        const m = el.querySelector('input[name="uu-method"]:checked').value;
        if (m === "pin") {
          const newPin = el.querySelector("#uu-pin").value.trim();
          if (!validPin(newPin)) throw new Error("PIN must be exactly 6 digits.");
          const uid = await createPinAccount(newPin);
          await setDoc(doc(db, "users", uid), {
            name, organization, calling, role: "pin", perms: newPerms, email: "",
            createdAt: serverTimestamp(), createdBy: ctx.name || ctx.email || "",
          });
          await setDoc(doc(db, "pins", uid), { pin: newPin, name, updatedAt: serverTimestamp() });
          closeModal();
          toast(`${name} added — PIN ${newPin}`);
          inviteMessage({ uid, name, role: "pin", perms: newPerms });
          return;
        }
        const email = el.querySelector("#uu-email").value.trim().toLowerCase();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("Enter their Google email address.");
        if (users.some((x) => (x.email || "").toLowerCase() === email)) throw new Error("That email already has a profile — edit it in the list.");
        await setDoc(doc(db, "invites", email), {
          name, organization, calling, perms: newPerms, email,
          invitedAt: serverTimestamp(), invitedBy: ctx.name || ctx.email || "",
        });
        closeModal();
        toast(`${name} invited`);
        inviteMessage({ email, name, invite: true, perms: newPerms });
        return;
      }
      if (u.invite) {
        await updateDoc(doc(db, "invites", u.email), { name, organization, calling, perms: newPerms });
      } else {
        const patch = { name, organization, calling };
        if (newPerms) { patch.perms = newPerms; if (u.role !== "pin") patch.role = "user"; }
        await updateDoc(doc(db, "users", u.uid), patch);
        if (pins[u.uid]) await updateDoc(doc(db, "pins", u.uid), { name }).catch(() => {});
      }
      toast("Saved"); closeModal();
    } catch (err) {
      showErr(err.message || err.code || String(err));
      btn.disabled = false; btn.textContent = isNew ? "Add" : "Save";
    }
  });
}

// The invitation text to send (copy, or open in Mail). No email server on
// this plan, so the bishop sends it himself.
function inviteMessage(u) {
  const pages = AREAS.filter((a) => (permsOf(u)[a.key] || (u.perms || {})[a.key]) === "edit").map((a) => a.label).join(", ");
  const pin = u.role === "pin" ? pins[u.uid] || u.pin || "" : "";
  const body = u.role === "pin"
    ? `Hi ${u.name || ""},\n\nYou've been given access to the 6th Ward app.\n\nOpen ${APP_URL} and enter your PIN: ${pin}\n\nYou'll see: ${pages}.\n\nPlease don't share the PIN.`
    : `Hi ${u.name || ""},\n\nYou've been given access to the 6th Ward app.\n\nOpen ${APP_URL} and choose "Sign in with Google" using ${u.email}.\n\nYou'll see: ${pages}.`;
  const el = openModal(`
    <h3>Invite ${esc(u.name || u.email || "")}</h3>
    <p class="row-sub" style="margin:0 0 .5rem">Send this however you like — copy it, or open it in Mail.</p>
    <textarea id="im-text" style="width:100%;min-height:11rem;font:inherit;padding:.6rem;border:1px solid var(--line);border-radius:8px">${esc(body)}</textarea>
    <div class="modal-actions">
      <button class="btn" id="im-close">Close</button>
      <div class="right">
        <a class="btn" id="im-mail" href="mailto:${u.email ? encodeURIComponent(u.email) : ""}?subject=${encodeURIComponent("6th Ward app access")}&body=${encodeURIComponent(body)}">Open in Mail</a>
        <button class="btn btn-primary" id="im-copy">Copy</button>
      </div>
    </div>`);
  el.querySelector("#im-close").addEventListener("click", closeModal);
  el.querySelector("#im-copy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(el.querySelector("#im-text").value); toast("Copied"); }
    catch { el.querySelector("#im-text").select(); toast("Select and copy the text"); }
  });
}

async function cancelInvite(u) {
  if (!u || !confirm(`Cancel the invitation for ${u.name || u.email}?`)) return;
  try { await deleteDoc(doc(db, "invites", u.email)); toast("Invitation cancelled"); }
  catch (err) { toast("Couldn't cancel: " + (err.code || err.message)); }
}

// Revoke keeps the row (and their history) but locks them out at sign-in;
// Restore puts them back with the same pages.
async function setRevoked(u, on) {
  if (!u) return;
  if (on && !confirm(`Revoke ${u.name || "this person"}'s access? They're signed out the next time the app checks.`)) return;
  try {
    await updateDoc(doc(db, "users", u.uid), { revoked: on, revokedAt: on ? serverTimestamp() : null });
    toast(on ? "Access revoked" : "Access restored");
  } catch (err) { toast("Couldn't update: " + (err.code || err.message)); }
}

async function removeUser(u) {
  if (!u || !confirm(`Remove ${u.name || "this person"} completely? This can't be undone.`)) return;
  try {
    await deleteDoc(doc(db, "users", u.uid));
    if (u.role === "pin") {
      await deleteDoc(doc(db, "pins", u.uid)).catch(() => {});
      if (pins[u.uid]) await deletePinAccount(pins[u.uid]).catch(() => {});
    }
    toast(`${u.name || "User"} removed`);
  } catch (err) { toast("Couldn't remove: " + (err.code || err.message)); }
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
  el.querySelector("#cp-cancel").addEventListener("click", () => editUser(u));
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
        name: u.name || "", organization: u.organization || "", calling: u.calling || "",
        role: "pin", perms: permsOf(u), email: "", lastSeen: u.lastSeen || null,
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
