// Message page (2026-10-18): pick the ward council, an organization, a saved group, or people one
// by one; write the text; "Text them" opens the phone's own Messages app with everyone addressed.
// The app never sends anything itself — it only fills in the numbers and the words.
import { db } from "./firebase-init.js?v=1792968684";
import { ctx, can } from "./app.js?v=1792968684";
import { collection, onSnapshot, setDoc, deleteDoc, doc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { toast, esc } from "./ui.js?v=1792968684";
import { orgColor } from "./org-colors.js?v=1792968684";
import { fmtPhone, normPhone, smsLink } from "./phone.js?v=1792968684";

let users = [], groups = [], started = false;
const chosen = new Set();
let filter = "";

export function initMessage() {
  if (started) return;
  started = true;
  const panel = document.getElementById("panel-message");
  panel.innerHTML = `
    <div class="panel-head">
      <div><h2>Message</h2><p class="panel-sub">Pick who, write the text, tap <b>Text them</b>. It opens in your phone's Messages app with everyone addressed — you press send.</p></div>
    </div>
    <div class="msg-wrap">
      <div class="card msg-who">
        <h3>Who</h3>
        <div class="msg-quick" id="msg-quick"></div>
        <input id="msg-filter" class="src-in msg-filter" placeholder="Find a name…" autocomplete="off">
        <div class="msg-list" id="msg-list"></div>
      </div>
      <div class="card msg-compose">
        <h3>Message</h3>
        <div class="msg-to" id="msg-to"></div>
        <textarea id="msg-body" class="msg-body" rows="6" placeholder="Reminder: ward council Sunday at 7:30 in the RS room."></textarea>
        <div class="msg-send">
          <a class="btn btn-primary msg-go btn-disabled" id="msg-go" href="#" target="_blank" rel="noopener">💬 Text them</a>
          <button type="button" class="btn" id="msg-copy" title="Copy the numbers and the message — for a computer without Messages">Copy</button>
        </div>
        <div class="msg-savegroup${can("message", "edit") ? "" : " hidden"}">
          <input id="msg-gname" class="src-in" placeholder="Save these people as a group…" autocomplete="off"><button type="button" class="btn btn-sm" id="msg-gsave">Save group</button>
        </div>
        <p class="row-sub msg-note">People without a mobile number on the Users page are greyed out. Phones cap a group text around 30 people — for more, send in a couple of batches.</p>
      </div>
    </div>`;
  panel.querySelector("#msg-filter").addEventListener("input", (e) => { filter = e.target.value; drawList(); });
  panel.querySelector("#msg-body").addEventListener("input", drawTo);
  panel.querySelector("#msg-copy").addEventListener("click", async () => {
    const nums = selected().map((u) => normPhone(u.phone)).filter(Boolean);
    if (!nums.length) return toast("Pick someone first");
    try { await navigator.clipboard.writeText(`${nums.join(", ")}\n\n${panel.querySelector("#msg-body").value}`); toast("Numbers and message copied"); } catch { toast("Couldn't copy"); }
  });
  panel.querySelector("#msg-go").addEventListener("click", (e) => { if (e.currentTarget.classList.contains("btn-disabled")) { e.preventDefault(); toast("Pick someone first"); } });
  panel.querySelector("#msg-gsave").addEventListener("click", saveGroup);
  onSnapshot(collection(db, "users"), (qs) => {
    users = qs.docs.map((d) => ({ uid: d.id, ...d.data() })).filter((u) => !u.alias && !u.revoked && u.role !== "pending").sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    draw();
  }, () => {});
  onSnapshot(collection(db, "textGroups"), (qs) => {
    groups = qs.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    draw();
  }, () => {});
}

const hasPhone = (u) => !!normPhone(u.phone);
const selected = () => users.filter((u) => chosen.has(u.uid));
const orgsOf = () => [...new Set(users.map((u) => (u.organization || "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));

function draw() { drawQuick(); drawList(); drawTo(); }

function drawQuick() {
  const box = document.getElementById("msg-quick"); if (!box) return;
  const councilN = users.filter((u) => u.councilMember && hasPhone(u)).length;
  const chip = (label, attrs, n, cls = "", title = "") => `<button type="button" class="msg-chip ${cls}" ${attrs} title="${esc(title)}">${esc(label)}${n != null ? `<span class="msg-chip-n">${n}</span>` : ""}</button>`;
  box.innerHTML = [
    chip("Ward council", `data-q="council"`, councilN, "msg-chip-council", "Everyone marked as a ward council member"),
    ...orgsOf().map((o) => chip(o, `data-q="org" data-org="${esc(o)}" style="--col:${orgColor(o)}"`, users.filter((u) => (u.organization || "").trim().toLowerCase() === o.toLowerCase() && hasPhone(u)).length, "msg-chip-org", `Everyone in ${o}`)),
    ...groups.map((g) => chip(`★ ${g.name}`, `data-q="group" data-gid="${esc(g.id)}"`, (g.uids || []).filter((id) => users.some((u) => u.uid === id && hasPhone(u))).length, "msg-chip-group", "Saved group — right-click or long-press to delete")),
    chip("Everyone", `data-q="all"`, users.filter(hasPhone).length, "", "Everyone with a mobile number"),
    chip("Clear", `data-q="none"`, null, "msg-chip-clear", "Start over"),
  ].join("");
  box.querySelectorAll("[data-q]").forEach((b) => {
    b.addEventListener("click", () => {
      const q = b.dataset.q;
      if (q === "none") chosen.clear();
      else if (q === "all") users.filter(hasPhone).forEach((u) => chosen.add(u.uid));
      else if (q === "council") users.filter((u) => u.councilMember && hasPhone(u)).forEach((u) => chosen.add(u.uid));
      else if (q === "org") users.filter((u) => (u.organization || "").trim().toLowerCase() === b.dataset.org.toLowerCase() && hasPhone(u)).forEach((u) => chosen.add(u.uid));
      else if (q === "group") { const g = groups.find((x) => x.id === b.dataset.gid); (g?.uids || []).forEach((id) => { if (users.some((u) => u.uid === id && hasPhone(u))) chosen.add(id); }); }
      drawList(); drawTo();
    });
    if (b.dataset.q === "group" && can("message", "edit")) b.addEventListener("contextmenu", async (e) => {
      e.preventDefault();
      const g = groups.find((x) => x.id === b.dataset.gid); if (!g) return;
      if (!confirm(`Delete the saved group “${g.name}”?`)) return;
      try { await deleteDoc(doc(db, "textGroups", g.id)); toast("Group deleted"); } catch (err) { toast("Couldn't delete: " + (err.code || err.message)); }
    });
  });
}

function drawList() {
  const list = document.getElementById("msg-list"); if (!list) return;
  const q = filter.trim().toLowerCase();
  const rows = users.filter((u) => !q || (u.name || "").toLowerCase().includes(q) || (u.organization || "").toLowerCase().includes(q) || (u.calling || "").toLowerCase().includes(q));
  list.innerHTML = rows.length ? rows.map((u) => `
    <label class="msg-row${chosen.has(u.uid) ? " on" : ""}${hasPhone(u) ? "" : " msg-nophone"}" style="--col:${orgColor(u.organization || "")}">
      <input type="checkbox" data-uid="${esc(u.uid)}" ${chosen.has(u.uid) ? "checked" : ""} ${hasPhone(u) ? "" : "disabled"}>
      <span class="msg-avatar">${esc((u.name || "?").split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase())}</span>
      <span class="msg-name">${esc(u.name || u.email || "—")}${u.councilMember ? ` <span class="msg-tag">council</span>` : ""}</span>
      <span class="msg-meta">${esc([u.organization, u.calling].filter(Boolean).join(" · "))}</span>
      <span class="msg-phone">${hasPhone(u) ? esc(fmtPhone(u.phone)) : "no number"}</span>
    </label>`).join("") : `<div class="empty-note">${users.length ? "Nobody matches." : "No one yet."}</div>`;
  list.querySelectorAll("input[data-uid]").forEach((cb) => cb.addEventListener("change", () => { cb.checked ? chosen.add(cb.dataset.uid) : chosen.delete(cb.dataset.uid); drawList(); drawTo(); }));
}

function drawTo() {
  const to = document.getElementById("msg-to"), go = document.getElementById("msg-go"), body = document.getElementById("msg-body"); if (!to) return;
  const sel = selected(), nums = sel.map((u) => normPhone(u.phone)).filter(Boolean);
  to.innerHTML = sel.length
    ? `<span class="msg-to-lbl">To</span>${sel.map((u) => `<span class="msg-to-pill" title="${esc(fmtPhone(u.phone))}">${esc(u.name || "")}<button type="button" data-rm="${esc(u.uid)}" title="Remove">✕</button></span>`).join("")}${nums.length > 30 ? `<span class="row-sub msg-warn">${nums.length} people — Messages may ask you to split this.</span>` : ""}`
    : `<span class="row-sub">No one picked yet — use a chip on the left or tick names.</span>`;
  to.querySelectorAll("[data-rm]").forEach((b) => b.addEventListener("click", () => { chosen.delete(b.dataset.rm); drawList(); drawTo(); }));
  go.href = nums.length ? smsLink(nums, body.value) : "#";
  go.classList.toggle("btn-disabled", !nums.length);
  go.textContent = nums.length ? `💬 Text ${nums.length === 1 ? sel[0].name.split(" ")[0] : nums.length + " people"}` : "💬 Text them";
}

async function saveGroup() {
  const nameEl = document.getElementById("msg-gname"), name = nameEl.value.trim(), uids = [...chosen];
  if (!name) return toast("Give the group a name");
  if (!uids.length) return toast("Pick some people first");
  const existing = groups.find((g) => (g.name || "").toLowerCase() === name.toLowerCase());
  const id = existing ? existing.id : (name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "group");
  try {
    await setDoc(doc(db, "textGroups", id), { name, uids, updatedAt: serverTimestamp(), by: ctx.name || "" });
    nameEl.value = "";
    toast(existing ? `Group “${name}” updated` : `Group “${name}” saved`);
  } catch (e) { toast("Couldn't save: " + (e.code || e.message)); }
}
