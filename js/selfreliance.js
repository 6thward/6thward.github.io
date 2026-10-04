// Self-Reliance page (2026-09-27) — who has sent in a Self-Reliance Plan, and
// what they answered. Only the bishop and people given this page can open
// it; the rules enforce that, not just the menu.
import { db } from "./firebase-init.js?v=1791136955";
import { ctx, can } from "./app.js?v=1791136955";
import {
  collection, onSnapshot, doc, getDocs, setDoc, updateDoc, deleteDoc, serverTimestamp, writeBatch,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { toast, esc, openModal, closeModal } from "./ui.js?v=1791136955";
import {
  INCOME, EXPENSES, FILE_KINDS, fmtMoney, fmtBytes, money, totals, newId, formLink, fetchFile,
} from "./sr-shared.js?v=1791136955";

let plans = [];
let links = [];
let started = false;
const filter = { status: "", q: "" };

const tsDate = (ts) => ts?.toDate?.() || (ts ? new Date(ts) : null);
const fmtWhen = (ts) => { const d = tsDate(ts); return d && !isNaN(d) ? d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : ""; };
const fmtDay = (iso) => (iso ? new Date(iso + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "");

export function initSelfReliance() {
  if (started) return;
  started = true;
  const panel = document.getElementById("panel-selfreliance");
  panel.innerHTML = `
    <div class="panel-head">
      <div>
        <h2>Self-Reliance</h2>
        <p class="panel-sub">Plans people have sent in. Send the form link to anyone — they don't need to sign in.</p>
      </div>
      <div style="display:flex;gap:.5rem;flex-wrap:wrap">
        <button class="btn btn-primary" id="sr-link-btn">🔗 Form link</button>
      </div>
    </div>
    <div class="card sr-filters">
      <select id="sr-f-status"><option value="">All</option><option value="new">New</option><option value="reviewed">Reviewed</option><option value="incomplete">Upload didn't finish</option></select>
      <input id="sr-f-q" placeholder="Search a name…" autocomplete="off">
      <span class="row-sub" id="sr-count"></span>
    </div>
    <div class="card" style="margin-top:.8rem">
      <div class="us-wrap">
        <table class="simple sr-table">
          <thead><tr><th>Name</th><th>Sent</th><th>Household</th><th class="num">Income</th><th class="num">Expenses</th><th class="num">Left over</th><th>Files</th><th>Status</th></tr></thead>
          <tbody id="sr-rows"></tbody>
        </table>
      </div>
    </div>`;
  panel.querySelector("#sr-link-btn").addEventListener("click", openLinks);
  panel.querySelector("#sr-f-status").addEventListener("change", (e) => { filter.status = e.target.value; render(); });
  panel.querySelector("#sr-f-q").addEventListener("input", (e) => { filter.q = e.target.value; render(); });

  onSnapshot(collection(db, "selfReliance"), (qs) => {
    plans = qs.docs.map((d) => ({ id: d.id, ...d.data() }));
    plans.sort((a, b) => (tsDate(b.submittedAt)?.getTime() || 0) - (tsDate(a.submittedAt)?.getTime() || 0));
    render();
  }, (err) => { document.getElementById("sr-rows").innerHTML = `<tr><td colspan="8" class="empty-note">Couldn't load: ${esc(err.code || err.message)}</td></tr>`; });
  onSnapshot(collection(db, "srLinks"), (qs) => { links = qs.docs.map((d) => ({ token: d.id, ...d.data() })); }, () => {});
}

const statusOf = (p) => (p.complete === false ? "incomplete" : p.status === "reviewed" ? "reviewed" : "new");
const statusPill = (p) => {
  const s = statusOf(p);
  return s === "incomplete" ? `<span class="pill pill-danger" title="The form was sent but a file upload was interrupted">Upload didn't finish</span>`
    : s === "reviewed" ? `<span class="pill pill-done">Reviewed</span>` : `<span class="pill pill-inprogress">New</span>`;
};

function render() {
  const tbody = document.getElementById("sr-rows");
  if (!tbody) return;
  const q = filter.q.trim().toLowerCase();
  const rows = plans.filter((p) => (!filter.status || statusOf(p) === filter.status) && (!q || (p.name || "").toLowerCase().includes(q) || (p.spouse || "").toLowerCase().includes(q)));
  document.getElementById("sr-count").textContent = `${rows.length} of ${plans.length}`;
  if (!rows.length) { tbody.innerHTML = `<tr><td colspan="8" class="empty-note">${plans.length ? "Nothing matches." : "No plans yet — send someone the form link."}</td></tr>`; return; }
  tbody.innerHTML = rows.map((p) => {
    const t = p.totals || totals(p);
    const house = [p.adults ? `${esc(p.adults)} adult${p.adults === "1" ? "" : "s"}` : "", p.children ? `${esc(p.children)} child${p.children === "1" ? "" : "ren"}` : ""].filter(Boolean).join(", ");
    return `<tr class="sr-row${statusOf(p) === "new" ? " sr-new" : ""}" data-id="${p.id}">
      <td><b>${esc(p.name || "—")}</b>${p.spouse ? `<div class="row-sub">& ${esc(p.spouse)}</div>` : ""}</td>
      <td>${fmtWhen(p.submittedAt)}</td>
      <td>${house || `<span class="row-sub">—</span>`}</td>
      <td class="num">${fmtMoney(t.income)}</td>
      <td class="num">${fmtMoney(t.expenses)}</td>
      <td class="num ${t.net < 0 ? "sr-neg" : "sr-pos"}">${fmtMoney(t.net)}</td>
      <td>${(p.files || []).length ? `📎 ${(p.files || []).length}` : `<span class="row-sub">—</span>`}</td>
      <td>${statusPill(p)}</td>
    </tr>`;
  }).join("");
  tbody.querySelectorAll(".sr-row").forEach((tr) => tr.addEventListener("click", () => openPlan(plans.find((p) => p.id === tr.dataset.id))));
}

// ---- one plan ----
function planHtml(p) {
  const t = p.totals || totals(p);
  const para = (s) => (s ? esc(s).replace(/\n/g, "<br>") : `<span class="row-sub">— nothing entered —</span>`);
  const moneyRows = (defs, vals) => defs.map(([k, l]) => `<tr><td>${esc(l)}</td><td class="num">${money(vals?.[k]) ? fmtMoney(money(vals[k])) : `<span class="row-sub">—</span>`}</td></tr>`).join("");
  const listRows = (rows) => (rows || []).map((r) => `<tr><td>${esc(r.label || "Other")}</td><td class="num">${fmtMoney(money(r.amount))}</td></tr>`).join("");
  return `
    <div class="sr-view">
      <div class="sr-sec"><h4>About</h4>
        <div class="sr-kv">
          <div><span>Name</span><b>${esc(p.name || "—")}</b></div>
          ${p.spouse ? `<div><span>Spouse</span><b>${esc(p.spouse)}</b></div>` : ""}
          ${p.phone ? `<div><span>Phone</span><b><a href="tel:${esc(p.phone)}">${esc(p.phone)}</a></b></div>` : ""}
          ${p.email ? `<div><span>Email</span><b><a href="mailto:${esc(p.email)}">${esc(p.email)}</a></b></div>` : ""}
          ${p.address ? `<div><span>Address</span><b>${esc(p.address)}</b></div>` : ""}
          ${p.adults || p.children ? `<div><span>Household</span><b>${esc(p.adults || "0")} adults · ${esc(p.children || "0")} children</b></div>` : ""}
          <div><span>Sent</span><b>${fmtWhen(p.submittedAt)}</b></div>
        </div>
      </div>
      <div class="sr-sec"><h4><span class="sr-step-tag">Step 1</span> Needs</h4>
        <div class="sr-q">Right now</div><div class="sr-a">${para(p.needsNow)}</div>
        <div class="sr-q">Longer term</div><div class="sr-a">${para(p.needsLater)}</div>
      </div>
      <div class="sr-sec"><h4><span class="sr-step-tag">Step 2</span> Income and expenses <span class="row-sub">(monthly)</span></h4>
        <div class="sr-money-cols">
          <table class="sr-mt"><thead><tr><th>Income</th><th class="num"></th></tr></thead><tbody>${moneyRows(INCOME, p.income)}</tbody>
            <tfoot><tr><td>Total income</td><td class="num">${fmtMoney(t.income)}</td></tr></tfoot></table>
          <table class="sr-mt"><thead><tr><th>Expenses</th><th class="num"></th></tr></thead><tbody>${moneyRows(EXPENSES, p.expenses)}${listRows(p.otherExpenses)}</tbody>
            <tfoot><tr><td>Total expenses</td><td class="num">${fmtMoney(t.expenses)}</td></tr></tfoot></table>
        </div>
        <div class="sr-net-line ${t.net < 0 ? "neg" : ""}"><span>Income minus expenses</span><b>${fmtMoney(t.net)}</b></div>
        ${(p.reduce || []).length ? `<table class="sr-mt" style="margin-top:.6rem"><thead><tr><th>Could reduce or drop</th><th class="num"></th></tr></thead><tbody>${listRows(p.reduce)}</tbody><tfoot><tr><td>Total</td><td class="num">${fmtMoney(t.reduce)}</td></tr></tfoot></table>` : ""}
      </div>
      <div class="sr-sec"><h4><span class="sr-step-tag">Step 3</span> Other resources</h4>
        <div class="sr-q">Own resources and skills</div><div class="sr-a">${para(p.resSelf)}</div>
        <div class="sr-q">Family</div><div class="sr-a">${para(p.resFamily)}</div>
        <div class="sr-q">Community</div><div class="sr-a">${para(p.resCommunity)}</div>
      </div>
      <div class="sr-sec"><h4><span class="sr-step-tag">Step 4</span> Plan</h4>
        ${(p.plan || []).length ? `<table class="sr-mt sr-plan-t"><thead><tr><th>Resource or skill needed</th><th>Steps</th><th>By when</th></tr></thead><tbody>${p.plan.map((r) => `<tr><td>${esc(r.need || "")}</td><td>${esc(r.steps || "")}</td><td>${fmtDay(r.when)}</td></tr>`).join("")}</tbody></table>` : `<div class="sr-a"><span class="row-sub">— nothing entered —</span></div>`}
      </div>
      <div class="sr-sec"><h4><span class="sr-step-tag">Step 5</span> Work or service</h4>
        <div class="sr-q">Their ideas</div><div class="sr-a">${para(p.serviceIdeas)}</div>
      </div>
      <div class="sr-sec"><h4>Commitment</h4>
        <div class="sr-kv">
          <div><span>Signed</span><b class="sr-sig">${esc(p.signature || "—")}</b> <span>${fmtDay(p.signedOn)}</span></div>
          ${p.spouseSignature ? `<div><span>Spouse</span><b class="sr-sig">${esc(p.spouseSignature)}</b> <span>${fmtDay(p.spouseSignedOn)}</span></div>` : ""}
        </div>
      </div>
    </div>`;
}

function openPlan(p) {
  if (!p) return;
  const editor = can("selfreliance", "edit");
  const filesOf = (kind) => (p.files || []).filter((f) => f.kind === kind);
  const el = openModal(`
    <div class="sr-modal-head">
      <div><h3 style="margin:0">${esc(p.name || "Plan")}</h3><div class="row-sub">Self-Reliance Plan · sent ${fmtWhen(p.submittedAt)}</div></div>
      ${statusPill(p)}
    </div>
    ${p.complete === false ? `<p class="login-error" style="margin:.5rem 0">A file upload was interrupted, so some attachments may be missing. The answers below are complete.</p>` : ""}
    ${planHtml(p)}
    <div class="sr-sec sr-noprint"><h4>Statements</h4>
      ${FILE_KINDS.map(([k, l]) => `
        <div class="sr-q">${esc(l)}</div>
        <div class="sr-attach">${filesOf(k).length ? filesOf(k).map((f) => `<button class="btn btn-sm sr-open" type="button" data-file="${esc(f.id)}" title="Open ${esc(f.name)}">📄 ${esc(f.name)} <span class="row-sub">${fmtBytes(f.size || 0)}</span></button>`).join("") : `<span class="row-sub">none sent</span>`}</div>`).join("")}
    </div>
    <div class="sr-sec sr-noprint"><h4>Leader notes</h4>
      <label class="field"><span>Work or service assignment agreed with the bishop</span><textarea id="sr-assign" ${editor ? "" : "disabled"} rows="2">${esc(p.serviceAssignment || "")}</textarea></label>
      <label class="field" style="margin-top:.5rem"><span>Notes <span class="row-sub">(only people with this page see them)</span></span><textarea id="sr-notes" ${editor ? "" : "disabled"} rows="3">${esc(p.leaderNotes || "")}</textarea></label>
    </div>
    <div class="modal-actions sr-noprint">
      <div style="display:flex;gap:.4rem;flex-wrap:wrap">
        ${editor ? `<button class="btn btn-ghost btn-danger" id="sr-del">Delete</button>` : ""}
        <button class="btn" id="sr-print">🖨 Print</button>
      </div>
      <div class="right">
        <button class="btn" id="sr-close">Close</button>
        ${editor ? `<button class="btn" id="sr-toggle">${p.status === "reviewed" ? "Mark as new" : "Mark reviewed"}</button><button class="btn btn-primary" id="sr-save">Save notes</button>` : ""}
      </div>
    </div>`);
  el.classList.add("modal-wide");
  el.querySelector("#sr-close").addEventListener("click", closeModal);
  el.querySelectorAll(".sr-open").forEach((b) => b.addEventListener("click", async () => {
    const meta = (p.files || []).find((f) => f.id === b.dataset.file);
    // open the tab first (inside the click) so pop-up blockers allow it, then fill it
    const w = window.open("", "_blank");
    const label = b.innerHTML; b.disabled = true; b.textContent = "Opening…";
    try {
      const blob = await fetchFile(p.id, meta);
      const url = URL.createObjectURL(blob);
      if (w) w.location.href = url; else { const a = document.createElement("a"); a.href = url; a.download = meta.name; a.click(); }
      setTimeout(() => URL.revokeObjectURL(url), 5 * 60 * 1000);
    } catch (err) { w?.close(); toast(err.message || "Couldn't open that file"); }
    b.disabled = false; b.innerHTML = label;
  }));
  el.querySelector("#sr-print").addEventListener("click", () => printPlan(p));
  if (!editor) return;
  const notes = () => ({ serviceAssignment: el.querySelector("#sr-assign").value.trim(), leaderNotes: el.querySelector("#sr-notes").value.trim() });
  el.querySelector("#sr-save").addEventListener("click", async () => {
    try { await updateDoc(doc(db, "selfReliance", p.id), { ...notes(), updatedAt: serverTimestamp(), updatedBy: ctx.name || "" }); toast("Saved"); closeModal(); }
    catch (err) { toast("Couldn't save: " + (err.code || err.message)); }
  });
  el.querySelector("#sr-toggle").addEventListener("click", async () => {
    const next = p.status === "reviewed" ? "new" : "reviewed";
    try { await updateDoc(doc(db, "selfReliance", p.id), { ...notes(), status: next, reviewedBy: next === "reviewed" ? ctx.name || "" : "", updatedAt: serverTimestamp() }); toast(next === "reviewed" ? "Marked reviewed" : "Marked new"); closeModal(); }
    catch (err) { toast("Couldn't save: " + (err.code || err.message)); }
  });
  el.querySelector("#sr-del").addEventListener("click", async () => {
    if (!confirm(`Delete ${p.name || "this"} plan and its ${(p.files || []).length} file(s)? This can't be undone.`)) return;
    try {
      // files live as chunk documents under the plan — remove them first
      const chunks = await getDocs(collection(db, "selfReliance", p.id, "chunks"));
      for (let i = 0; i < chunks.docs.length; i += 20) {
        const batch = writeBatch(db);
        chunks.docs.slice(i, i + 20).forEach((d) => batch.delete(doc(db, "selfReliance", p.id, "chunks", d.id)));
        await batch.commit();
      }
      await deleteDoc(doc(db, "selfReliance", p.id));
      toast("Deleted"); closeModal();
    } catch (err) { toast("Couldn't delete: " + (err.code || err.message)); }
  });
}

function printPlan(p) {
  const w = window.open("", "_blank");
  if (!w) { toast("Pop-up blocked — allow pop-ups to print"); return; }
  w.document.open();
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Self-Reliance Plan · ${esc(p.name || "")}</title><style>
    html { color-scheme: light; } @page { size: letter; margin: .6in; }
    body { font: 12.5px/1.45 -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color: #111; background: #fff; margin: 0; }
    .bar { position: sticky; top: 0; padding: .55rem .9rem; background: #1f2733; color: #fff; font-weight: 600; display: flex; gap: .6rem; align-items: center; }
    .bar button { font: inherit; padding: .4rem .9rem; border: 0; border-radius: 6px; background: #fff; cursor: pointer; }
    .page { max-width: 7.3in; margin: 1.2rem auto; padding: 0 1rem; } h1 { font-size: 19px; margin: 0; } .sub { color: #555; margin: 0 0 .2in; }
    h4 { font-size: 13px; margin: .22in 0 .06in; padding-bottom: .03in; border-bottom: 2px solid #1f4e79; color: #1f4e79; }
    .sr-step-tag { font-size: 10px; text-transform: uppercase; letter-spacing: .05em; background: #1f4e79; color: #fff; border-radius: 4px; padding: .02in .06in; margin-right: .05in; }
    .sr-q { font-weight: 700; margin-top: .08in; } .sr-a { margin-bottom: .04in; } .row-sub { color: #777; font-weight: 400; }
    .sr-kv { display: grid; grid-template-columns: 1fr 1fr; gap: .04in .3in; } .sr-kv span { color: #666; margin-right: .08in; }
    .sr-money-cols { display: grid; grid-template-columns: 1fr 1fr; gap: .3in; align-items: start; }
    table { width: 100%; border-collapse: collapse; } th { text-align: left; font-size: 10.5px; text-transform: uppercase; color: #555; border-bottom: 1px solid #999; padding: .03in 0; }
    td { padding: .03in 0; border-bottom: 1px solid #e5e5e5; vertical-align: top; } .num { text-align: right; font-variant-numeric: tabular-nums; } tfoot td { font-weight: 700; border-bottom: 0; border-top: 1.5px solid #333; }
    .sr-plan-t td { padding-right: .1in; } .sr-net-line { display: flex; justify-content: space-between; font-weight: 700; margin-top: .08in; padding: .05in .08in; background: #eef3f8; } .sr-net-line.neg b { color: #b3402f; }
    .sr-sig { font-family: "Snell Roundhand", "Brush Script MT", cursive; font-size: 17px; font-weight: 400; }
    @media print { .bar { display: none; } .page { margin: 0; padding: 0; max-width: none; } }
  </style></head><body><div class="bar"><button onclick="window.print()">🖨 Print</button><span>Self-Reliance Plan</span></div>
  <div class="page"><h1>Self-Reliance Plan</h1><p class="sub">${esc(p.name || "")} · sent ${fmtWhen(p.submittedAt)}${(p.files || []).length ? ` · ${(p.files || []).length} statement file(s) on file` : ""}</p>
  ${planHtml(p)}
  ${p.serviceAssignment ? `<h4>Work or service assignment</h4><div class="sr-a">${esc(p.serviceAssignment).replace(/\n/g, "<br>")}</div>` : ""}
  </div></body></html>`);
  w.document.close();
}

// ---- the form link ----
function openLinks() {
  const editor = can("selfreliance", "edit");
  const active = links.filter((l) => l.active).sort((a, b) => (tsDate(b.createdAt)?.getTime() || 0) - (tsDate(a.createdAt)?.getTime() || 0))[0];
  const url = active ? formLink(active.token) : "";
  const msg = `Here's the Self-Reliance Plan form. Fill in what you can and press Send — it goes straight to the bishop.\n${url}`;
  const el = openModal(`
    <h3>Self-Reliance form link</h3>
    <p class="row-sub" style="margin:0 0 .7rem">Anyone with this link can fill in the form — no PIN or sign-in. They can't see anything anyone has sent, including their own, once it's submitted.</p>
    ${active ? `
    <label class="field"><span>Link</span>
      <div style="display:flex;gap:.4rem"><input id="srl-url" value="${esc(url)}" readonly style="flex:1"><button class="btn" id="srl-copy">Copy</button></div></label>
    <div class="modal-actions" style="flex-wrap:wrap;gap:.4rem">
      <div style="display:flex;gap:.4rem;flex-wrap:wrap">
        <a class="btn btn-primary" href="sms:?&body=${encodeURIComponent(msg)}">💬 Text it</a>
        ${typeof navigator.share === "function" ? `<button class="btn" id="srl-share">📤 Share…</button>` : ""}
        <a class="btn" href="${esc(url)}" target="_blank" rel="noopener">Open</a>
        ${editor ? `<button class="btn btn-ghost btn-danger" id="srl-new" title="The current link stops working; a new one is made">Replace link</button>` : ""}
      </div>
      <div class="right"><button class="btn" id="srl-close">Close</button></div>
    </div>` : `
    <p>${editor ? "There's no active link yet." : "There's no active link — ask the bishop to create one."}</p>
    <div class="modal-actions"><span></span><div class="right"><button class="btn" id="srl-close">Close</button>${editor ? `<button class="btn btn-primary" id="srl-new">Create the link</button>` : ""}</div></div>`}`);
  el.querySelector("#srl-close").addEventListener("click", closeModal);
  el.querySelector("#srl-copy")?.addEventListener("click", async () => { try { await navigator.clipboard.writeText(url); toast("Link copied"); } catch { el.querySelector("#srl-url").select(); toast("Select and copy the link"); } });
  el.querySelector("#srl-share")?.addEventListener("click", async () => { try { await navigator.share({ title: "Self-Reliance Plan", text: "Self-Reliance Plan form", url }); } catch { /* cancelled */ } });
  el.querySelector("#srl-new")?.addEventListener("click", async () => {
    if (active && !confirm("Replace the link? The current one stops working for anyone who hasn't sent their form yet.")) return;
    try {
      for (const l of links.filter((x) => x.active)) await updateDoc(doc(db, "srLinks", l.token), { active: false, retiredAt: serverTimestamp() });
      const token = newId(22);
      await setDoc(doc(db, "srLinks", token), { active: true, ward: "St. George East Stake · 6th Ward", createdAt: serverTimestamp(), createdBy: ctx.name || "" });
      links = [...links.map((x) => ({ ...x, active: false })), { token, active: true, createdAt: new Date() }];
      closeModal(); openLinks();
    } catch (err) { toast("Couldn't create the link: " + (err.code || err.message)); }
  });
}
