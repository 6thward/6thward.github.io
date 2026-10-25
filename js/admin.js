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
//
// A Google user can ALSO have a PIN (2026-09-19): a second hidden account
// whose profile doc carries `alias: <googleUid>` plus a mirror of the name /
// organization / calling / pages, so the rules see the same access either
// way. The table shows one row; the mirror is kept in step on every save.
import { db } from "./firebase-init.js?v=1792902951";
import { ctx, AREAS, normalizePerms } from "./app.js?v=1792902951";
import {
  collection, onSnapshot, updateDoc, setDoc, deleteDoc, doc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { fmtPhone, normPhone, smsLink } from "./phone.js?v=1792902951";
import { orgColor } from "./org-colors.js?v=1792902951";
import { toast, esc, openModal, closeModal } from "./ui.js?v=1792902951";
import { createPinAccount, deletePinAccount, randomPin, validPin } from "./pin-auth.js?v=1792902951";

let sort = { key: "created", dir: 1 }; // default: oldest at the top; click a header for A→Z / Z→A (2026-09-19)
let showPastUsers = (() => { try { return localStorage.getItem("sw-users-past") === "1"; } catch { return false; } })(); // Past users folded unless they chose to see them (2026-10-18)
let users = [];   // profiles (alias PIN docs are folded into their Google row)
let aliasPins = {}; // googleUid -> the PIN profile doc that aliases it
let invites = [];
let pins = {};          // uid -> pin (bishop-only collection)
let textGroups = [];    // saved recipient sets for the Text tool (2026-10-18): { id, name, uids[] }
let started = false;

const APP_URL = "https://6thward.github.io/";
// "Last used" is the bishop's eyes only (2026-09-19) — helpers with the Users page don't see it
const BISHOP_EMAIL = "jordanchri@gmail.com";
const showLastUsed = () => false; // column retired 2026-10-18 (Jordan: no need to show it); was bishop-only via BISHOP_EMAIL

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
      <div style="display:flex;gap:.5rem;align-items:center"><button class="btn" id="btn-text" title="Write a text to the council, an organization, a saved group or individuals — opens in your Messages app">💬 Text</button><button class="btn btn-primary" id="btn-new-user">+ Add user</button></div>
    </div>
    <div class="card">
      <div class="us-wrap">
        <table class="simple us-table" id="users-table">
          <thead><tr>${[["name", "Name"], ["council", "Council"], ["signin", "Sign-in"], ["email", "Email"], ["phone", "Mobile"], ["organization", "Organization"], ["calling", "Calling"], ["access", "Access"]].concat(showLastUsed() ? [["lastUsed", "Last used"]] : []).map(([k, l]) => `<th class="us-sort us-col-${k}" data-sort="${k}" title="Sort by ${l}">${l}<span class="us-sort-ic"></span></th>`).join("")}<th class="us-col-menu"></th></tr></thead>
          <tbody id="user-rows"></tbody>
        </table>
      </div>
    </div>`;
  panel.querySelector("#btn-new-user").addEventListener("click", () => editUser(null));
  panel.querySelector("#btn-text").addEventListener("click", () => textTool());
  panel.querySelectorAll("[data-sort]").forEach((th) => th.addEventListener("click", () => {
    sort = sort.key === th.dataset.sort ? { key: sort.key, dir: -sort.dir } : { key: th.dataset.sort, dir: 1 };
    render();
  }));

  onSnapshot(collection(db, "users"), (qs) => {
    const all = qs.docs.map((d) => ({ uid: d.id, ...d.data() }));
    aliasPins = {};
    all.filter((u) => u.alias).forEach((u) => { aliasPins[u.alias] = u; });
    users = all.filter((u) => !u.alias);
    render();
  });
  onSnapshot(collection(db, "invites"), (qs) => {
    invites = qs.docs.map((d) => ({ email: d.id, ...d.data(), invite: true }));
    render();
  }, () => {});
  onSnapshot(collection(db, "textGroups"), (qs) => { textGroups = qs.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (a.name || "").localeCompare(b.name || "")); }, () => {});
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
  if (u.role === "bishopric") return normalizePerms(Object.fromEntries(AREAS.map((a) => [a.key, a.key === "confidential" || a.key === "selfreliance" || a.key === "tithing" || a.key === "users" ? "" : "edit"])));
  if (u.role === "member") return normalizePerms({ sacrament: "edit", calendar: "edit", tasks: "edit" });
  return normalizePerms({});
}
const isBishopUser = (u) => u.role === "bishop" || u.email === "jordanchri@gmail.com";
// one count pill by default ("6 pages"); click it to unfold the list, click again to fold (2026-10-18)
const accOpen = new Set();
const accessPills = (perms, uid) => {
  const on = AREAS.filter((a) => perms[a.key] === "edit");
  if (!on.length) return `<span class="pill pill-muted">no pages</span>`;
  if (on.length === AREAS.length) return `<span class="pill pill-ok">All pages</span>`;
  if (on.length === 1) return `<span class="pill us-pill" title="${esc(on[0].label)}">${esc(on[0].label.length > 8 ? on[0].label.slice(0, 8).trimEnd() + "…" : on[0].label)}</span>`; // one page: just name it (2026-10-18)
  const open = uid && accOpen.has(uid);
  const toggle = uid ? `<button type="button" class="pill us-pill us-acc-n" data-acc="${esc(uid)}" title="${open ? "Fold the list" : esc(on.map((a) => a.label).join(", "))}">${open ? "▾ " : ""}${on.length} page${on.length === 1 ? "" : "s"}</button>` : "";
  return toggle + (open ? on.map((a) => `<span class="pill us-pill">${esc(a.label)}</span>`).join(" ") : "");
};
// a Google user with a PIN has two sign-in docs — show whichever was used last
function latestSeen(u) {
  const a = u.lastSeen, b = aliasPins[u.uid]?.lastSeen;
  const t = (x) => (x?.toDate?.() || (x ? new Date(x) : null))?.getTime() || 0;
  return t(b) > t(a) ? b : a;
}
function fmtSeen(ts) {
  const d = ts?.toDate?.() || (ts ? new Date(ts) : null);
  if (!d || isNaN(d)) return `<span class="row-sub">Never</span>`;
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  const when = d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: days > 300 ? "numeric" : undefined });
  return `<span title="${d.toLocaleString()}">${days === 0 ? "Today" : days === 1 ? "Yesterday" : when}</span>`;
}
function signInPill(u) {
  if (u.invite) return `<span class="pill pill-pending" title="Invited — hasn't signed in yet">invited</span>`;
  if (u.revoked) return `<span class="pill pill-danger">revoked</span>`;
  if (u.role === "pending") return `<span class="pill pill-pending" title="Signed in with Google but hasn't been given any pages">waiting</span>`;
  if (u.role === "pin") return `<span class="pill pill-muted" title="Signs in with a PIN">PIN ${esc(pins[u.uid] || "")}</span>`;
  const ap = aliasPins[u.uid];
  if (ap) return `<span class="pill pill-muted" title="Google${ap.quick ? " + a 4-digit PIN they set themselves" : " + PIN " + esc(pins[ap.uid] || "")}">multiple</span>`; // one pill, the detail on hover (2026-10-18)
  return `<span class="pill pill-muted" title="${esc(u.email || "")}">Google</span>`;
}

function render() {
  const tbody = document.getElementById("user-rows");
  if (!tbody) return;
  const rows = [...users, ...invites];
  const ms = (x) => (x?.toDate?.() || (x ? new Date(x) : null))?.getTime() || 0;
  const created = (u) => ms(u.invite ? u.invitedAt : u.createdAt);
  const accessKey = (u) => AREAS.filter((a) => permsOf(u)[a.key] === "edit").map((a) => a.label).join(", ");
  const keyOf = (u) => sort.key === "name" ? (u.name || u.email || "").toLowerCase()
    : sort.key === "council" ? (u.councilMember ? "a" : "b")
    : sort.key === "signin" ? (u.invite ? "invited" : u.revoked ? "revoked" : u.role === "pending" ? "waiting" : u.role === "pin" ? "pin" : aliasPins[u.uid] ? "multiple" : "google")
    : sort.key === "email" ? (u.email || "").toLowerCase()
    : sort.key === "phone" ? normPhone(u.phone)
    : sort.key === "organization" ? (u.organization || "").toLowerCase()
    : sort.key === "calling" ? (u.calling || "").toLowerCase()
    : sort.key === "access" ? accessKey(u).toLowerCase()
    : sort.key === "lastUsed" ? ms(u.invite ? null : latestSeen(u))
    : created(u);
  rows.sort((a, b) => {
    const ka = keyOf(a), kb = keyOf(b);
    if (typeof ka === "number" || typeof kb === "number") {
      // oldest first by default; people with no date (never used / no stamp) sink to the bottom
      if (!ka && kb) return 1; if (ka && !kb) return -1;
      if (ka !== kb) return (ka - kb) * sort.dir;
    } else {
      if (ka && !kb) return -1; if (!ka && kb) return 1; // blanks last either way
      const c = ka.localeCompare(kb);
      if (c) return c * sort.dir;
    }
    return (a.name || a.email || "").localeCompare(b.name || b.email || "");
  });
  document.querySelectorAll("#users-table [data-sort]").forEach((th) => {
    th.classList.toggle("on", th.dataset.sort === sort.key);
    th.querySelector(".us-sort-ic").textContent = th.dataset.sort === sort.key ? (sort.dir === 1 ? " ▲" : " ▼") : "";
  });
  if (!rows.length) { tbody.innerHTML = `<tr><td colspan="${showLastUsed() ? 10 : 9}" class="empty-note">Nobody yet — use “+ Add user”.</td></tr>`; return; }
  // grouped by organization (2026-10-04): Bishopric first, then A→Z, people with none last;
  // the column sort still orders people inside each group
  const cols = showLastUsed() ? 10 : 9;
  const orgOf = (u) => (u.organization || "").trim() || (isBishopUser(u) ? "Bishopric" : "");
  // revoked people leave the main table and sit under "Past users" at the bottom, folded by default (2026-10-18)
  const past = rows.filter((u) => u.revoked && !u.invite);
  const active = rows.filter((u) => !(u.revoked && !u.invite));
  const groups = new Map(); // lowercased org -> { label, list }
  active.forEach((u) => {
    const label = orgOf(u), k = label.toLowerCase();
    if (!groups.has(k)) groups.set(k, { label, list: [] });
    groups.get(k).list.push(u);
  });
  const rank = (k) => (k === "bishopric" ? 0 : k === "" ? 2 : 1);
  const orgDir = sort.key === "organization" ? sort.dir : 1;
  const ordered = [...groups.entries()].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b) * orgDir).map(([, g]) => g);
  let orgCls = "", orgStyle = ""; // each organization section carries its colour — the same one Callings uses (2026-10-18)
  const rowHtml = (u) => {
    const id = u.invite ? "inv:" + u.email : u.uid;
    const me = u.uid === ctx.uid;
    const email = u.email && (u.invite || u.role !== "pin") ? u.email : "";
    // the ⋯ menu holds everything that used to be a row of buttons (2026-10-18)
    const items = [
      `<button type="button" data-edit="${esc(id)}">${u.role === "pending" ? "Give access" : "Edit…"}</button>`,
      u.invite || u.role === "pin" || aliasPins[u.uid] ? `<button type="button" data-invite="${esc(id)}">Copy invitation message</button>` : "",
      u.invite ? `<button type="button" class="danger" data-cancel="${esc(id)}">Cancel invitation</button>`
        : isBishopUser(u) ? ""
        : u.revoked ? `<button type="button" data-restore="${esc(id)}">Restore access</button><button type="button" class="danger" data-remove="${esc(id)}">Remove completely</button>`
        : `<button type="button" class="danger" data-revoke="${esc(id)}">Revoke access</button>`,
    ].filter(Boolean);
    return `
    <tr class="${orgCls}${u.revoked ? " us-revoked" : ""}${u.role === "pending" ? " us-waiting" : ""}"${orgStyle}>
      <td class="us-col-name"><b title="${esc(u.name || u.email || "")}">${esc(u.name || u.email || "—")}</b>${me ? " <span class='row-sub'>(you)</span>" : ""}</td>
      <td class="us-col-council">${u.councilMember ? `<span class="pill us-council-pill" title="Ward council member">Council</span>` : ""}</td>
      <td class="us-col-signin">${signInPill(u)}</td>
      <td class="us-col-email">${email ? `<span class="row-sub us-email" title="${esc(email)}">${esc(email)}</span>` : ""}</td>
      <td class="us-col-phone">${u.phone ? `<button type="button" class="us-phone us-phone-ed" data-phone="${esc(id)}" title="Click to change">${esc(fmtPhone(u.phone))}</button>` : `<button type="button" class="us-phone-add" data-phone="${esc(id)}" title="Add a mobile number">+</button>`}</td>
      <td class="us-col-organization"><span class="us-trunc" title="${esc(u.organization || "")}">${esc(u.organization || "")}</span></td>
      <td class="us-col-calling"><span class="us-trunc" title="${esc(u.calling || "")}">${esc(u.calling || "")}</span></td>
      <td class="us-access"><div class="us-pills">${u.revoked ? `<span class="pill pill-muted">—</span>` : accessPills(permsOf(u), id)}</div></td>
      ${showLastUsed() ? `<td class="us-col-lastUsed">${u.invite ? `<span class="row-sub">invited ${fmtSeen(u.invitedAt).replace(/<[^>]+>/g, "")}</span>` : fmtSeen(latestSeen(u))}</td>` : ""}
      <td class="us-actions us-col-menu"><button type="button" class="btn btn-sm us-menu-btn" data-usmenu title="Actions">⋯</button><div class="us-menu" hidden>${items.join("")}</div></td>
    </tr>`;
  };
  const pastSorted = [...past].sort((a, b) => ms(b.revokedAt) - ms(a.revokedAt) || (a.name || "").localeCompare(b.name || ""));
  const pastHtml = past.length ? `
    <tr class="us-group us-group-past"><td colspan="${cols}"><span class="us-group-name">Past users</span><span class="us-group-n">${past.length}</span>
      <button type="button" class="btn btn-sm btn-ghost us-past-toggle" data-pasttoggle>${showPastUsers ? "Hide" : "Show"}</button>
      ${showPastUsers ? "" : `<span class="row-sub us-past-names">${esc(pastSorted.map((u) => u.name || u.email || "—").join(" · "))}</span>`}</td></tr>
    ${showPastUsers ? pastSorted.map(rowHtml).join("") : ""}` : "";
  tbody.innerHTML = (ordered.length ? ordered.map((g) => { const col = orgColor(g.label); orgCls = "us-org"; orgStyle = ` style="--org:${col};--org-soft:color-mix(in srgb, ${col} 9%, #fff)"`; return `
    <tr class="us-group ${orgCls}"${orgStyle}><td colspan="${cols}"><span class="us-group-name">${esc(g.label || "No organization")}</span><span class="us-group-n">${g.list.length}</span></td></tr>
    ${g.list.map(rowHtml).join("")}`; }).join("") : `<tr><td colspan="${cols}" class="empty-note">Nobody active — everyone is under Past users.</td></tr>`) + (orgCls = "", orgStyle = "", pastHtml);
  // mobile number edits right in the cell (2026-10-18): + or the number → input; Enter / blur saves, Esc cancels
  tbody.querySelectorAll("[data-phone]").forEach((b) => b.addEventListener("click", (e) => {
    e.stopPropagation();
    const u = find(b.dataset.phone); if (!u) return;
    const td = b.closest("td"), initial = u.phone || "";
    td.innerHTML = `<input class="us-phone-in" type="tel" inputmode="tel" placeholder="(435) 555-0123" autocomplete="off">`;
    const inp = td.querySelector("input"); inp.value = initial; inp.focus(); inp.select();
    let done = false;
    const finish = async (commit) => {
      if (done) return; done = true;
      const v = fmtPhone(inp.value);
      if (commit && v !== initial) {
        try {
          await updateDoc(doc(db, u.invite ? "invites" : "users", u.invite ? u.email : u.uid), { phone: v });
          toast(v ? "Number saved" : "Number removed");
        } catch (err) { toast("Couldn't save: " + (err.code || err.message)); }
      }
      render();
    };
    inp.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); finish(true); } if (ev.key === "Escape") { ev.preventDefault(); finish(false); } });
    inp.addEventListener("blur", () => setTimeout(() => finish(true), 80));
  }));
  tbody.querySelectorAll("[data-acc]").forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); const id = b.dataset.acc; accOpen.has(id) ? accOpen.delete(id) : accOpen.add(id); render(); }));
  // ⋯ opens one small menu at a time; any click elsewhere closes it
  const closeMenus = () => tbody.querySelectorAll(".us-menu:not([hidden])").forEach((m) => { m.hidden = true; m.closest("tr").classList.remove("us-menu-open"); });
  tbody.querySelectorAll("[data-usmenu]").forEach((b) => b.addEventListener("click", (e) => {
    e.stopPropagation();
    const menu = b.nextElementSibling, open = menu.hidden;
    closeMenus();
    if (open) { menu.hidden = false; b.closest("tr").classList.add("us-menu-open"); }
  }));
  tbody.querySelectorAll(".us-menu button").forEach((b) => b.addEventListener("click", () => closeMenus()));
  if (!tbody.dataset.menuWired) { tbody.dataset.menuWired = "1"; document.addEventListener("click", closeMenus); document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenus(); }); }
  tbody.querySelector("[data-pasttoggle]")?.addEventListener("click", () => { showPastUsers = !showPastUsers; try { localStorage.setItem("sw-users-past", showPastUsers ? "1" : ""); } catch {} render(); });
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
  const ap = !isNew && !u.invite && u.role !== "pin" ? aliasPins[u.uid] : null; // Google user's PIN doc, if any
  const pin = isNew ? randomPin() : (u.role === "pin" ? pins[u.uid] || "" : ap ? pins[ap.uid] || "" : "");
  const el = openModal(`
    <h3>${isNew ? "Add a user" : "Edit " + esc(u.name || u.email || "user")}</h3>
    <div class="form-grid">
      <label class="field"><span>Name</span><input id="uu-name" value="${esc(u?.name || "")}" placeholder="First and last name" autocomplete="off"></label>
      <label class="field"><span>Organization</span><input id="uu-org" value="${esc(u?.organization || "")}" placeholder="e.g. Relief Society, Elders Quorum, Primary" autocomplete="off" list="dl-orgs"></label>
      <label class="field"><span>Calling</span><input id="uu-calling" value="${esc(u?.calling || "")}" placeholder="e.g. President, Secretary, Ward Clerk" autocomplete="off"></label>
      <label class="field"><span>Mobile number <span class="row-sub">(for the Text tool)</span></span><input id="uu-phone" type="tel" inputmode="tel" value="${esc(u?.phone || "")}" placeholder="(435) 555-0123" autocomplete="off"></label>
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
      <label class="field"><span>Google email</span><input value="${esc(u.email || "")}" readonly></label>
      ${u.invite ? "" : `<div class="field"><span>PIN <span class="row-sub">(optional — a second way in, same pages)</span></span>
        ${ap && ap.quick
          ? `<div style="display:flex;gap:.5rem;align-items:center;flex-wrap:wrap"><span class="row-sub">They set their own 4-digit PIN (only they know it).</span><button class="btn btn-sm btn-ghost btn-danger" type="button" id="uu-droppin">Remove it</button></div>`
          : ap
          ? `<div style="display:flex;gap:.5rem;align-items:center;flex-wrap:wrap"><input id="uu-pin" class="pin-code-input" value="${esc(pin)}" readonly><button class="btn btn-sm" type="button" id="uu-changepin">Change PIN…</button><button class="btn btn-sm btn-ghost btn-danger" type="button" id="uu-droppin">Remove PIN</button></div>`
          : `<div id="uu-pin-wrap"><button class="btn btn-sm" type="button" id="uu-setpin">Set a PIN…</button></div>`}
      </div>`}`}
    </div>
    <datalist id="dl-orgs">${["Bishopric", "Ward Clerk", "Executive Secretary", "Relief Society", "Elders Quorum", "Primary", "Young Women", "Young Men", "Sunday School", "Music", "Missionary", "Temple & Family History"].map((o) => `<option value="${o}">`).join("")}</datalist>
    <label class="us-council"><input type="checkbox" id="uu-council" ${u?.councilMember ? "checked" : ""}> <span><b>Ward council member</b><div class="row-sub">Gets the Ward Council page, can add agenda items (and is shown as their owner), and can be given council assignments.</div></span></label>
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
  el.querySelector("#uu-changepin")?.addEventListener("click", () => changePin(ap || u));
  let newAliasPin = null; // Google user: PIN to create on save
  el.querySelector("#uu-setpin")?.addEventListener("click", () => {
    newAliasPin = randomPin();
    el.querySelector("#uu-pin-wrap").innerHTML = `<div style="display:flex;gap:.5rem;align-items:center"><input id="uu-pin" class="pin-code-input" value="${esc(newAliasPin)}" inputmode="numeric" maxlength="6" autocomplete="off"><button class="btn btn-sm" type="button" id="uu-shuffle2" title="Pick another random PIN">🎲</button><span class="row-sub">saves with this form</span></div>`;
    el.querySelector("#uu-shuffle2").addEventListener("click", () => { el.querySelector("#uu-pin").value = randomPin(); });
    el.querySelector("#uu-pin").addEventListener("input", () => { newAliasPin = el.querySelector("#uu-pin").value.trim(); });
  });
  el.querySelector("#uu-droppin")?.addEventListener("click", async () => {
    if (!confirm(`Remove ${u.name || "their"} PIN? Google sign-in keeps working.`)) return;
    try { await removeAliasPin(ap); toast("PIN removed"); closeModal(); editUser(users.find((x) => x.uid === u.uid) || u); }
    catch (err) { showErr(err.message || err.code || String(err)); }
  });
  el.querySelector("#uu-all")?.addEventListener("click", () => el.querySelectorAll("[data-area]").forEach((c) => { c.checked = true; }));
  el.querySelector("#uu-none")?.addEventListener("click", () => el.querySelectorAll("[data-area]").forEach((c) => { c.checked = false; }));
  el.querySelectorAll('input[name="uu-method"]').forEach((r) => r.addEventListener("change", () => {
    const g = el.querySelector('input[name="uu-method"]:checked').value === "google";
    el.querySelector("#uu-pin-field").classList.toggle("hidden", g);
    el.querySelector("#uu-email-field").classList.toggle("hidden", !g);
  }));
  const readPerms = () => Object.fromEntries(AREAS.map((a) => [a.key, el.querySelector(`[data-area="${a.key}"]`)?.checked ? "edit" : ""]));
  const showErr = (m) => { const e = el.querySelector("#uu-err"); e.textContent = m; e.classList.remove("hidden"); };
  // a council member always has the Ward Council page (2026-10-04)
  el.querySelector("#uu-council").addEventListener("change", (e) => { const c = el.querySelector('[data-area="council"]'); if (c && e.target.checked) c.checked = true; });

  el.querySelector("#uu-save").addEventListener("click", async () => {
    const name = el.querySelector("#uu-name").value.trim();
    const organization = el.querySelector("#uu-org").value.trim();
    const calling = el.querySelector("#uu-calling").value.trim();
    const phone = fmtPhone(el.querySelector("#uu-phone").value);
    const newPerms = bishop ? null : readPerms();
    const councilMember = el.querySelector("#uu-council").checked;
    if (councilMember && newPerms) newPerms.council = "edit";
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
            name, organization, calling, councilMember, phone, role: "pin", perms: newPerms, email: "",
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
          name, organization, calling, councilMember, phone, perms: newPerms, email,
          invitedAt: serverTimestamp(), invitedBy: ctx.name || ctx.email || "",
        });
        closeModal();
        toast(`${name} invited`);
        inviteMessage({ email, name, invite: true, perms: newPerms });
        return;
      }
      if (u.invite) {
        await updateDoc(doc(db, "invites", u.email), { name, organization, calling, councilMember, phone, perms: newPerms });
      } else {
        const patch = { name, organization, calling, councilMember, phone };
        if (newPerms) { patch.perms = newPerms; if (u.role !== "pin") patch.role = "user"; }
        await updateDoc(doc(db, "users", u.uid), patch);
        if (pins[u.uid]) await updateDoc(doc(db, "pins", u.uid), { name }).catch(() => {});
        // keep the Google user's PIN mirror in step (name / org / calling / pages)
        if (ap) {
          await updateDoc(doc(db, "users", ap.uid), { name, organization, calling, councilMember, perms: newPerms || permsOf(u) });
          await updateDoc(doc(db, "pins", ap.uid), { name }).catch(() => {});
        }
        if (newAliasPin) {
          if (!validPin(newAliasPin)) throw new Error("PIN must be exactly 6 digits.");
          await createAliasPin({ ...u, name, organization, calling, councilMember }, newAliasPin, newPerms || permsOf(u));
          toast(`Saved — ${name} can also sign in with PIN ${newAliasPin}`); closeModal(); return;
        }
      }
      toast("Saved"); closeModal();
    } catch (err) {
      showErr(err.message || err.code || String(err));
      btn.disabled = false; btn.textContent = isNew ? "Add" : "Save";
    }
  });
}

// A PIN for a Google user: hidden account + mirror profile aliasing theirs.
async function createAliasPin(u, pin, perms) {
  const pinUid = await createPinAccount(pin);
  await setDoc(doc(db, "users", pinUid), {
    alias: u.uid, name: u.name || "", organization: u.organization || "", calling: u.calling || "", councilMember: !!u.councilMember,
    role: "pin", perms, email: "", revoked: !!u.revoked,
    createdAt: serverTimestamp(), createdBy: ctx.name || ctx.email || "",
  });
  await setDoc(doc(db, "pins", pinUid), { pin, name: u.name || "", alias: u.uid, updatedAt: serverTimestamp() });
  return pinUid;
}
async function removeAliasPin(ap) {
  if (!ap) return;
  if (ap.quick) await updateDoc(doc(db, "users", ap.alias), { quickPin: null }).catch(() => {}); // their Google profile forgets the PIN too
  await deleteDoc(doc(db, "users", ap.uid));
  await deleteDoc(doc(db, "pins", ap.uid)).catch(() => {});
  if (pins[ap.uid]) await deletePinAccount(pins[ap.uid]).catch(() => {});
}

// The invitation text to send (copy, or open in Mail). No email server on
// this plan, so the bishop sends it himself.
function inviteMessage(u) {
  const pages = AREAS.filter((a) => (permsOf(u)[a.key] || (u.perms || {})[a.key]) === "edit").map((a) => a.label).join(", ");
  const ap = u.uid ? aliasPins[u.uid] : null;
  const pin = u.role === "pin" ? pins[u.uid] || u.pin || "" : ap ? pins[ap.uid] || "" : "";
  const body = u.role === "pin"
    ? `Hi ${u.name || ""},\n\nYou've been given access to the 6th Ward app.\n\nOpen ${APP_URL} and enter your PIN: ${pin}\n\nYou'll see: ${pages}.\n\nPlease don't share the PIN.`
    : pin
    ? `Hi ${u.name || ""},\n\nYou've been given access to the 6th Ward app.\n\nOpen ${APP_URL} and either enter your PIN: ${pin}, or choose "Sign in with Google" using ${u.email}.\n\nYou'll see: ${pages}.\n\nPlease don't share the PIN.`
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
    const ap = aliasPins[u.uid];
    if (ap) await updateDoc(doc(db, "users", ap.uid), { revoked: on }).catch(() => {});
    toast(on ? "Access revoked" : "Access restored");
  } catch (err) { toast("Couldn't update: " + (err.code || err.message)); }
}

async function removeUser(u) {
  if (!u || !confirm(`Remove ${u.name || "this person"} completely? This can't be undone.`)) return;
  try {
    await deleteDoc(doc(db, "users", u.uid));
    await removeAliasPin(aliasPins[u.uid]);
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
  el.querySelector("#cp-cancel").addEventListener("click", () => editUser(u.alias ? users.find((x) => x.uid === u.alias) || u : u));
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
        role: "pin", perms: u.alias ? normalizePerms(u.perms) : permsOf(u), email: "", lastSeen: u.lastSeen || null,
        ...(u.alias ? { alias: u.alias, revoked: !!u.revoked } : {}),
        createdAt: serverTimestamp(), createdBy: ctx.name || ctx.email || "", replaces: u.uid,
      });
      await setDoc(doc(db, "pins", newUid), { pin: newPin, name: u.name || "", ...(u.alias ? { alias: u.alias } : {}), updatedAt: serverTimestamp() });
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


// ===== Text tool (2026-10-18) =====
// Pick who (ward council, an organization, a saved group, or people one by one), write the message,
// and "Open in Messages" hands it to the phone's own texting app through an sms: link. Nothing is
// sent by the app itself — it just fills in the numbers and the words.
// phone helpers live in ./phone.js (shared with the Message page)
function textTool() {
  const people = users.filter((u) => !u.revoked && u.role !== "pending").sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  const orgs = [...new Set(people.map((u) => (u.organization || "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const chosen = new Set();
  let draft = "";
  const el = openModal(`
    <h3>Send a text</h3>
    <p class="row-sub" style="margin:0 0 .6rem">Pick who, write the message, then <b>Open in Messages</b> fills it into your phone's texting app. People without a mobile number on their profile are greyed out.</p>
    <div class="tx-quick">
      <span class="row-sub" style="font-weight:700">Add:</span>
      <button type="button" class="chip" data-q="council">Ward council</button>
      ${orgs.map((o) => `<button type="button" class="chip" data-q="org" data-org="${esc(o)}" style="--col:${orgColor(o)}">${esc(o)}</button>`).join("")}
      ${textGroups.map((g) => `<button type="button" class="chip tx-group" data-q="group" data-gid="${esc(g.id)}" title="Saved group">★ ${esc(g.name)}</button>`).join("")}
      <button type="button" class="chip" data-q="all">Everyone</button>
      <button type="button" class="chip tx-clear" data-q="none">Clear</button>
    </div>
    <input id="tx-filter" class="src-in" placeholder="Find a name…" autocomplete="off" style="margin:.5rem 0 .3rem">
    <div class="tx-list" id="tx-list"></div>
    <div class="tx-summary" id="tx-summary"></div>
    <label class="field" style="margin-top:.7rem">Message
      <textarea id="tx-body" rows="4" placeholder="Reminder: ward council Sunday at 7:30 in the RS room."></textarea>
    </label>
    <div class="tx-actions">
      <div class="tx-save"><input id="tx-gname" class="src-in" placeholder="Save these people as a group…" autocomplete="off"><button type="button" class="btn btn-sm" id="tx-gsave">Save group</button></div>
      <div class="right"><button type="button" class="btn" id="tx-copy" title="Copy the numbers and the message — for a computer without Messages">Copy</button><a class="btn btn-primary" id="tx-open" href="#" target="_blank" rel="noopener">Open in Messages</a><button type="button" class="btn" id="tx-close">Close</button></div>
    </div>`);
  const list = el.querySelector("#tx-list"), summary = el.querySelector("#tx-summary"), body = el.querySelector("#tx-body"), open = el.querySelector("#tx-open"), filter = el.querySelector("#tx-filter");
  const withPhone = (u) => !!normPhone(u.phone);
  const drawList = () => {
    const q = filter.value.trim().toLowerCase();
    list.innerHTML = people.filter((u) => !q || (u.name || "").toLowerCase().includes(q)).map((u) => `
      <label class="tx-row${chosen.has(u.uid) ? " on" : ""}${withPhone(u) ? "" : " tx-nophone"}">
        <input type="checkbox" data-uid="${esc(u.uid)}" ${chosen.has(u.uid) ? "checked" : ""} ${withPhone(u) ? "" : "disabled"}>
        <span class="tx-name">${esc(u.name || u.email || "—")}</span>
        <span class="tx-meta">${esc([u.organization, u.calling].filter(Boolean).join(" · "))}</span>
        <span class="tx-phone">${withPhone(u) ? esc(fmtPhone(u.phone)) : "no number"}</span>
      </label>`).join("") || `<div class="empty-note">Nobody matches.</div>`;
    list.querySelectorAll("input[data-uid]").forEach((cb) => cb.addEventListener("change", () => { cb.checked ? chosen.add(cb.dataset.uid) : chosen.delete(cb.dataset.uid); draw(); }));
  };
  const draw = () => {
    drawList();
    const sel = people.filter((u) => chosen.has(u.uid));
    const nums = sel.map((u) => normPhone(u.phone)).filter(Boolean);
    summary.innerHTML = sel.length
      ? `<b>${nums.length}</b> ${nums.length === 1 ? "person" : "people"} selected${sel.length > nums.length ? ` <span class="row-sub">(${sel.length - nums.length} without a number, skipped)</span>` : ""}: <span class="row-sub">${esc(sel.map((u) => (u.name || "").split(" ")[0]).join(", "))}</span>`
      : `<span class="row-sub">No one selected yet.</span>`;
    draft = body.value;
    open.href = nums.length ? smsLink(nums, draft) : "#";
    open.classList.toggle("btn-disabled", !nums.length);
    open.title = nums.length ? `Opens Messages with ${nums.length} recipient${nums.length === 1 ? "" : "s"}` : "Pick someone first";
    if (nums.length > 32) summary.innerHTML += ` <span class="row-sub">Phones cap group texts around 30 — expect Messages to ask you to split this.</span>`;
  };
  el.querySelectorAll("[data-q]").forEach((b) => b.addEventListener("click", () => {
    const q = b.dataset.q;
    if (q === "none") chosen.clear();
    else if (q === "all") people.filter(withPhone).forEach((u) => chosen.add(u.uid));
    else if (q === "council") people.filter((u) => u.councilMember && withPhone(u)).forEach((u) => chosen.add(u.uid));
    else if (q === "org") people.filter((u) => (u.organization || "").trim().toLowerCase() === b.dataset.org.toLowerCase() && withPhone(u)).forEach((u) => chosen.add(u.uid));
    else if (q === "group") { const g = textGroups.find((x) => x.id === b.dataset.gid); (g?.uids || []).forEach((uid) => { if (people.some((u) => u.uid === uid && withPhone(u))) chosen.add(uid); }); }
    draw();
  }));
  filter.addEventListener("input", drawList);
  body.addEventListener("input", draw);
  el.querySelector("#tx-close").addEventListener("click", closeModal);
  el.querySelector("#tx-copy").addEventListener("click", async () => {
    const sel = people.filter((u) => chosen.has(u.uid)); const nums = sel.map((u) => normPhone(u.phone)).filter(Boolean);
    try { await navigator.clipboard.writeText(`${nums.join(", ")}\n\n${body.value}`); toast("Numbers and message copied"); } catch { toast("Couldn't copy"); }
  });
  el.querySelector("#tx-gsave").addEventListener("click", async () => {
    const name = el.querySelector("#tx-gname").value.trim(); const uids = [...chosen];
    if (!name) return toast("Give the group a name");
    if (!uids.length) return toast("Pick some people first");
    try {
      const existing = textGroups.find((g) => (g.name || "").toLowerCase() === name.toLowerCase());
      await setDoc(doc(db, "textGroups", existing ? existing.id : name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "group"), { name, uids, updatedAt: serverTimestamp(), by: ctx.name || "" });
      toast(existing ? `Group “${name}” updated` : `Group “${name}” saved`);
      closeModal(); setTimeout(textTool, 50); // redraw with the new chip
    } catch (e) { toast("Couldn't save: " + (e.code || e.message)); }
  });
  open.addEventListener("click", (e) => { if (open.classList.contains("btn-disabled")) { e.preventDefault(); toast("Pick someone first"); } });
  draw();
}
