// Self-Reliance member cards (2026-10-05). One card per person, built from the
// self-reliance specialist's form responses (imported from the spreadsheet's CSV
// export) plus the specialist's write-up, the request, and the bishop's notes.
//   srCases/{id} { key, name, spouse, email, status, requested, writeup, writeupBy,
//                  writeupAt, decision, notes, files[], responses[{ id, at, raw{}, amounts{}, exact{}, edited{} }] }
//   srCases/{id}/chunks/…  the attached files themselves (invoices, statements) — see files.js
// Same privacy as the rest of this page: only the bishop and people given Self-Reliance.
import { db } from "./firebase-init.js?v=1791213282";
import { ctx, can } from "./app.js?v=1791213282";
import {
  collection, onSnapshot, doc, addDoc, updateDoc, deleteDoc, serverTimestamp, writeBatch,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { uploadAttachment, fetchAttachment, openAttachment, deleteAttachment, fmtBytes, fileIcon, MAX_ATTACH_BYTES, ATTACH_ACCEPT } from "./files.js?v=1791213282";
import { toast, esc, openModal, closeModal } from "./ui.js?v=1791213282";
import {
  INC, EXP, QA, parseCsv, mapResponses, personKey, respTotals, fmtUsd, isBlank, writeupSections,
} from "./sr-import.js?v=1791213282";

let mount = null, cases = [], started = false, openId = null, openRi = null;
const thumbs = new Map(); // file id -> object URL, so an attached image shows right on the card
const isImage = (f) => /^image\//.test(f.type || "") || /\.(png|jpe?g|gif|webp)$/i.test(f.name || "");
const filter = { q: "", status: "" };
const STATUS = [["new", "New"], ["reviewing", "Reviewing"], ["helping", "Helping"], ["closed", "Closed"]];
const STATUS_PILL = { new: "pill-inprogress", reviewing: "pill-pending", helping: "pill-approved", closed: "pill-muted" };

const fmtDay = (iso) => { const d = iso ? new Date(iso) : null; return d && !isNaN(d) ? d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : ""; };
const sorted = (c) => [...(c.responses || [])].sort((a, b) => String(a.at || "").localeCompare(String(b.at || "")));
const latest = (c) => sorted(c).slice(-1)[0] || null;
const editor = () => can("selfreliance", "edit");

export function initCases(el) {
  mount = el;
  if (started) { renderGrid(); return; }
  started = true;
  mount.innerHTML = `
    <div class="card src-bar">
      <input id="src-q" placeholder="Search a name…" autocomplete="off">
      <select id="src-status"><option value="">Everyone</option>${STATUS.map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}</select>
      <span class="row-sub" id="src-count"></span>
      <span class="src-bar-actions">
        ${editor() ? `<button class="btn btn-primary" id="src-import" type="button" title="Upload the CSV export of the self-reliance specialist's form responses">⬆ Import responses (CSV)</button>
        <button class="btn" id="src-new" type="button">+ New card</button>
        <input type="file" id="src-file" accept=".csv,text/csv" hidden>` : ""}
      </span>
    </div>
    <div class="src-grid" id="src-grid"><div class="empty-note">Loading…</div></div>`;
  mount.querySelector("#src-q").addEventListener("input", (e) => { filter.q = e.target.value; renderGrid(); });
  mount.querySelector("#src-status").addEventListener("change", (e) => { filter.status = e.target.value; renderGrid(); });
  mount.querySelector("#src-import")?.addEventListener("click", () => mount.querySelector("#src-file").click());
  mount.querySelector("#src-file")?.addEventListener("change", async (e) => {
    const f = e.target.files[0]; e.target.value = "";
    if (!f) return;
    try { importCsv(await f.text()); } catch (err) { toast("Couldn't read that file: " + (err.message || err)); }
  });
  mount.querySelector("#src-new")?.addEventListener("click", newCase);

  onSnapshot(collection(db, "srCases"), (qs) => {
    cases = qs.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderGrid();
    refreshOpen();
  }, (err) => { mount.querySelector("#src-grid").innerHTML = `<div class="empty-note">Couldn't load: ${esc(err.code || err.message)}</div>`; });
}

// ---------- the cards ----------
function wuExcerpt(text) {
  const secs = writeupSections(text);
  if (!secs.length) return "";
  const pick = secs.find((s) => /conclusion|summary|recommend/i.test(s.title)) || secs[0];
  return pick.paras[0] || pick.title;
}
function tiles(t, small) {
  return `<div class="src-tiles${small ? " src-tiles-sm" : ""}">
    <div><span>Income</span><b>${fmtUsd(t.income)}</b></div>
    <div><span>Expenses</span><b>${fmtUsd(t.expenses)}</b></div>
    <div class="${t.net == null ? "" : t.net < 0 ? "neg" : "pos"}"><span>Left over</span><b>${fmtUsd(t.net)}</b></div>
  </div>`;
}
function renderGrid() {
  const grid = mount?.querySelector("#src-grid"); if (!grid) return;
  const q = filter.q.trim().toLowerCase();
  const rows = cases.filter((c) => (!filter.status || (c.status || "new") === filter.status) && (!q || `${c.name || ""} ${c.spouse || ""}`.toLowerCase().includes(q)))
    .sort((a, b) => String(latest(b)?.at || b.created || "").localeCompare(String(latest(a)?.at || a.created || "")));
  mount.querySelector("#src-count").textContent = cases.length ? `${rows.length} of ${cases.length}` : "";
  if (!rows.length) {
    grid.innerHTML = `<div class="card empty-note" style="grid-column:1/-1">${cases.length ? "Nobody matches." : `No cards yet.${editor() ? " Import the specialist's form responses (the spreadsheet's <b>File → Download → CSV</b>) to build them, or add one by hand." : ""}`}</div>`;
    return;
  }
  grid.innerHTML = rows.map((c) => {
    const r = latest(c), t = r ? respTotals(r) : null, n = (c.responses || []).length, st = c.status || "new";
    const ex = wuExcerpt(c.writeup);
    return `<div class="src-card" data-id="${c.id}" tabindex="0">
      <div class="src-card-top"><b class="src-name">${esc(c.name || "—")}</b><span class="pill ${STATUS_PILL[st] || ""}">${esc(STATUS.find(([k]) => k === st)?.[1] || st)}</span></div>
      <div class="row-sub">${c.spouse ? `& ${esc(c.spouse)} · ` : ""}${r ? `plan ${esc(fmtDay(r.at))}` : "no plan on file"}${n > 1 ? ` · ${n} plans` : ""}${(c.files || []).length ? ` · 📎 ${(c.files || []).length}` : ""}</div>
      ${r && !isBlank(r.raw?.needs) ? `<div class="src-need"><span>Needs</span>${esc(r.raw.needs)}</div>` : ""}
      ${c.requested ? `<div class="src-need src-req"><span>Requested</span>${esc(c.requested)}</div>` : ""}
      ${t ? tiles(t, true) : ""}
      <div class="src-wu${ex ? "" : " src-wu-none"}">${ex ? `<span>Specialist’s write-up</span>${esc(ex)}` : "No write-up yet"}</div>
    </div>`;
  }).join("");
  grid.querySelectorAll(".src-card").forEach((el) => {
    const go = () => openCase(el.dataset.id);
    el.addEventListener("click", go);
    el.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
  });
}

// ---------- one person ----------
const amtCell = (r, k) => {
  const a = r.amounts?.[k], rawv = r.raw?.[k] || "";
  const approx = a != null && !r.exact?.[k] && !r.edited?.[k];
  return `<span class="src-amt${editor() ? " src-amt-edit" : ""}${a == null ? " src-amt-none" : ""}" data-k="${k}" title="${editor() ? "Click to correct this amount" : ""}${approx ? " — our reading of a written answer" : ""}">${approx ? "≈ " : ""}${a == null ? (isBlank(rawv) ? "—" : "?") : fmtUsd(a)}${r.edited?.[k] ? `<i title="Corrected by a leader">✎</i>` : ""}</span>`;
};
const rawNote = (r, k) => {
  const rawv = String(r.raw?.[k] || "").trim();
  if (!rawv || (r.exact?.[k] && !r.edited?.[k])) return "";
  return `<div class="src-raw">“${esc(rawv)}”${r.raw?._flags?.[k] === "balance" && r.amounts?.[k] == null ? ` <em>— looks like a total owed, not a monthly payment, so it isn't counted</em>` : ""}</div>`;
};
function planHtml(c, r) {
  const t = respTotals(r);
  const max = Math.max(1, ...EXP.map(([k]) => Number(r.amounts?.[k]) || 0));
  const line = ([k, l]) => `<div class="src-line"><div class="src-line-top"><span>${esc(l)}</span>${amtCell(r, k)}</div>${rawNote(r, k)}</div>`;
  const expLines = [...EXP].sort((a, b) => (Number(r.amounts?.[b[0]]) || 0) - (Number(r.amounts?.[a[0]]) || 0)).map(([k, l]) => {
    const a = Number(r.amounts?.[k]) || 0;
    return `<div class="src-line"><div class="src-line-top"><span>${esc(l)}</span>${amtCell(r, k)}</div><div class="src-bar-track"><div class="src-bar-fill" style="width:${Math.round((a / max) * 100)}%"></div></div>${rawNote(r, k)}</div>`;
  }).join("");
  const qa = QA.filter(([k]) => !isBlank(r.raw?.[k])).map(([k, l]) => `<div class="src-qa"><span>${esc(l)}</span><p>${esc(r.raw[k])}</p></div>`).join("");
  const skipped = QA.filter(([k]) => isBlank(r.raw?.[k])).map(([, l]) => l);
  return `
    <div class="src-sec"><h4>What they need</h4><p class="src-big">${isBlank(r.raw?.needs) ? `<span class="row-sub">— nothing entered —</span>` : esc(r.raw.needs)}</p></div>
    <div class="src-sec"><h4>Monthly picture <span class="row-sub">as they reported it</span></h4>
      ${tiles(t)}
      <div class="src-money">
        <div><h5>Income</h5>${INC.map(line).join("")}</div>
        <div><h5>Expenses</h5>${expLines}</div>
      </div>
      <p class="src-hint">≈ is our reading of a written answer; ? means it couldn't be read as a dollar amount.${editor() ? " Click any amount to correct it — the totals update." : ""}</p>
    </div>
    <div class="src-sec"><h4>In their words</h4>${qa || `<p class="row-sub">No written answers.</p>`}
      ${skipped.length ? `<p class="src-hint">Left blank: ${skipped.map(esc).join(" · ")}</p>` : ""}</div>`;
}
function writeupHtml(text) {
  return writeupSections(text).map((s) => `${s.title ? `<h5>${esc(s.title)}</h5>` : ""}${s.paras.map((p) => `<p>${esc(p)}</p>`).join("")}`).join("");
}
function detailHtml(c, ri) {
  const rs = sorted(c), r = rs[ri] || null, st = c.status || "new", ed = editor();
  return `
    <div class="src-d-head">
      <div><h3>${esc(c.name || "—")}</h3>
        <div class="row-sub">${[c.spouse ? "& " + esc(c.spouse) : "", c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : ""].filter(Boolean).join(" · ")}</div></div>
      <div class="src-d-tools">
        ${ed ? `<select id="srd-status" title="Where this stands">${STATUS.map(([k, l]) => `<option value="${k}"${k === st ? " selected" : ""}>${l}</option>`).join("")}</select>` : `<span class="pill ${STATUS_PILL[st] || ""}">${esc(STATUS.find(([k]) => k === st)?.[1] || st)}</span>`}
        <button class="btn btn-sm" id="srd-print" type="button">🖨 Print</button>
      </div>
    </div>
    <div class="src-d-cols">
      <div class="src-col">
        ${rs.length > 1 ? `<div class="src-tabs">${rs.map((x, i) => `<button type="button" class="chip${i === ri ? " active" : ""}" data-ri="${i}">Plan ${esc(fmtDay(x.at))}${i === rs.length - 1 ? " · latest" : ""}</button>`).join("")}</div>` : ""}
        ${r ? `${rs.length <= 1 ? `<p class="row-sub" style="margin:0 0 .5rem">Self-Reliance Plan sent ${esc(fmtDay(r.at))}</p>` : ""}${planHtml(c, r)}` : `<div class="empty-note">No Self-Reliance Plan on file for this person yet. Import the specialist's responses to add it.</div>`}
      </div>
      <div class="src-col src-col-leader">
        <div class="src-sec"><h4>Request</h4>
          ${ed ? `<input id="srd-requested" class="src-in" value="${esc(c.requested || "")}" placeholder="e.g. One month of rent ($1,950) + 1–2 food orders" autocomplete="off">` : `<p>${esc(c.requested || "—")}</p>`}</div>
        <div class="src-sec"><h4>Specialist’s write-up ${c.writeup && ed ? `<button class="btn btn-sm btn-ghost" id="srd-wu-edit" type="button">✎ Edit</button>` : ""}</h4>
          ${c.writeup
            ? `<div class="src-writeup" id="srd-wu-view">${writeupHtml(c.writeup)}</div>${c.writeupBy || c.writeupAt ? `<p class="src-hint">${[c.writeupBy ? "By " + esc(c.writeupBy) : "", c.writeupAt ? "added " + esc(fmtDay(c.writeupAt)) : ""].filter(Boolean).join(" · ")}</p>` : ""}`
            : ed ? "" : `<p class="row-sub">No write-up yet.</p>`}
          ${ed ? `<div id="srd-wu-box"${c.writeup ? " hidden" : ""}>
            <textarea id="srd-writeup" class="src-ta src-ta-tall" placeholder="Paste the self-reliance specialist's write-up here. Section titles on their own line (Current Financial Situation, Conclusion…) become headings.">${esc(c.writeup || "")}</textarea>
            <div class="src-wu-save"><input id="srd-wu-by" class="src-in" placeholder="Written by (specialist's name)" value="${esc(c.writeupBy || "")}" autocomplete="off"><button class="btn btn-primary btn-sm" id="srd-wu-save" type="button">Save write-up</button></div>
          </div>` : ""}</div>
        <div class="src-sec"><h4>Attachments ${ed ? `<button class="btn btn-sm btn-ghost" id="srd-attach" type="button" title="Attach an invoice, statement, PDF or image">📎 Add file</button>` : ""}</h4>
          ${(c.files || []).length ? `<div class="src-files">${(c.files || []).map((f) => `<div class="src-file" data-file="${esc(f.id)}" title="Open ${esc(f.name)}">
              ${isImage(f) ? `<img class="src-thumb" data-thumb="${esc(f.id)}" alt="${esc(f.name)}"${thumbs.get(f.id) ? ` src="${thumbs.get(f.id)}"` : ""}>` : `<span class="src-file-ic">${fileIcon(f)}</span>`}
              <span class="src-file-name">${esc(f.name)}</span><span class="row-sub">${fmtBytes(f.size)}</span>
              ${ed ? `<button type="button" class="btn btn-sm btn-ghost" data-rmfile="${esc(f.id)}" title="Remove this file">✕</button>` : ""}
            </div>`).join("")}</div>` : `<p class="row-sub" style="margin:0">None yet.</p>`}
          <div class="src-upload row-sub" id="srd-upload" hidden></div>
          ${ed ? `<input type="file" id="srd-file" accept="${ATTACH_ACCEPT}" multiple hidden>` : ""}</div>
        <div class="src-sec"><h4>Decision / help given</h4>
          ${ed ? `<textarea id="srd-decision" class="src-ta" placeholder="What was decided, what was provided and when">${esc(c.decision || "")}</textarea>` : `<p>${esc(c.decision || "—")}</p>`}</div>
        <div class="src-sec"><h4>Bishop’s notes</h4>
          ${ed ? `<textarea id="srd-notes" class="src-ta" placeholder="Private notes">${esc(c.notes || "")}</textarea>` : `<p>${esc(c.notes || "—")}</p>`}</div>
      </div>
    </div>
    <div class="modal-actions">
      ${ed ? `<button class="btn btn-ghost btn-danger" id="srd-delete" type="button">Delete card</button>` : "<span></span>"}
      <button class="btn" id="srd-close" type="button">Close</button>
    </div>`;
}

function openCase(id, ri) {
  const c = cases.find((x) => x.id === id); if (!c) return;
  openId = id;
  openRi = ri ?? Math.max(0, sorted(c).length - 1);
  const el = openModal(`<div id="srd"></div>`);
  el.classList.add("modal-wide", "src-modal");
  drawOpen();
}
// a change arriving from the database redraws the open card — unless something is being typed
function refreshOpen() {
  const box = document.getElementById("srd"); if (!box || !openId) return;
  const a = document.activeElement;
  if (a && box.contains(a) && /^(INPUT|TEXTAREA)$/.test(a.tagName)) return;
  if (!cases.some((x) => x.id === openId)) { closeModal(); openId = null; return; }
  drawOpen();
}
function drawOpen() {
  const box = document.getElementById("srd"), c = cases.find((x) => x.id === openId);
  if (!box || !c) return;
  const rs = sorted(c);
  if (openRi >= rs.length) openRi = Math.max(0, rs.length - 1);
  box.innerHTML = detailHtml(c, openRi);
  const ref = doc(db, "srCases", c.id);
  const save = async (patch, msg) => {
    try { await updateDoc(ref, { ...patch, updatedAt: serverTimestamp() }); if (msg) toast(msg); }
    catch (e) { toast("Couldn't save: " + (e.code || e.message)); }
  };
  box.querySelector("#srd-close").addEventListener("click", () => { openId = null; closeModal(); });
  box.querySelector("#srd-print").addEventListener("click", () => printCase(c, rs[openRi]));
  box.querySelectorAll("[data-ri]").forEach((b) => b.addEventListener("click", () => { openRi = Number(b.dataset.ri); drawOpen(); }));
  // attachments: click to open; images also show as a thumbnail
  box.querySelectorAll(".src-file").forEach((el) => el.addEventListener("click", async (e) => {
    if (e.target.closest("[data-rmfile]")) return;
    const meta = (c.files || []).find((f) => f.id === el.dataset.file); if (!meta) return;
    try { await openAttachment("srCases", meta); } catch (err) { toast(err.message || "Couldn't open that file"); }
  }));
  box.querySelectorAll("[data-thumb]").forEach(async (img) => {
    const meta = (c.files || []).find((f) => f.id === img.dataset.thumb); if (!meta || thumbs.get(meta.id)) return;
    try { const url = URL.createObjectURL(await fetchAttachment("srCases", meta)); thumbs.set(meta.id, url); if (img.isConnected) img.src = url; } catch {}
  });
  if (!editor()) return;

  const picker = box.querySelector("#srd-file"), upStatus = box.querySelector("#srd-upload");
  box.querySelector("#srd-attach").addEventListener("click", () => { picker.value = ""; picker.click(); });
  picker.addEventListener("change", async () => {
    const chosen = [...picker.files]; if (!chosen.length) return;
    const tooBig = chosen.filter((f) => f.size > MAX_ATTACH_BYTES);
    if (tooBig.length) toast(`${tooBig[0].name} is over 10 MB — skipped`);
    const added = [];
    upStatus.hidden = false;
    try {
      for (const f of chosen.filter((x) => x.size <= MAX_ATTACH_BYTES)) added.push(await uploadAttachment("srCases", c.id, f, (pct) => { upStatus.textContent = `Uploading ${f.name} — ${Math.round(pct * 100)}%`; }));
      if (added.length) await save({ files: [...(c.files || []), ...added] }, added.length === 1 ? "Attached" : `${added.length} files attached`);
    } catch (e) { toast("Upload failed: " + (e.code || e.message)); }
    upStatus.hidden = true;
  });
  box.querySelectorAll("[data-rmfile]").forEach((b) => b.addEventListener("click", async () => {
    const meta = (c.files || []).find((f) => f.id === b.dataset.rmfile); if (!meta) return;
    if (!confirm(`Remove “${meta.name}” from this card?`)) return;
    await save({ files: (c.files || []).filter((f) => f.id !== meta.id) }, "Removed");
    deleteAttachment("srCases", meta).catch(() => {});
  }));

  box.querySelector("#srd-status").addEventListener("change", (e) => save({ status: e.target.value }, "Saved"));
  [["#srd-requested", "requested"], ["#srd-decision", "decision"], ["#srd-notes", "notes"]].forEach(([sel, key]) => {
    const inp = box.querySelector(sel);
    inp.addEventListener("change", () => { if (inp.value.trim() !== (c[key] || "")) save({ [key]: inp.value.trim() }, "Saved"); });
  });
  box.querySelector("#srd-wu-edit")?.addEventListener("click", () => {
    box.querySelector("#srd-wu-view").hidden = true; box.querySelector("#srd-wu-box").hidden = false; box.querySelector("#srd-writeup").focus();
  });
  box.querySelector("#srd-wu-save").addEventListener("click", async () => {
    const text = box.querySelector("#srd-writeup").value.trim();
    await save({ writeup: text, writeupBy: box.querySelector("#srd-wu-by").value.trim(), writeupAt: text ? (c.writeup === text && c.writeupAt ? c.writeupAt : new Date().toISOString()) : "" }, text ? "Write-up saved" : "Write-up removed");
    document.activeElement?.blur(); refreshOpen();
  });
  box.querySelector("#srd-delete").addEventListener("click", async () => {
    if (!confirm(`Delete ${c.name}'s card, including the plan answers, write-up and notes? This can't be undone.`)) return;
    try { for (const f of c.files || []) await deleteAttachment("srCases", f); await deleteDoc(ref); openId = null; closeModal(); toast("Card deleted"); } catch (e) { toast("Couldn't delete: " + (e.code || e.message)); }
  });
  // correct an amount: click it, type the number (blank = unknown)
  const r = rs[openRi];
  box.querySelectorAll(".src-amt-edit").forEach((cell) => cell.addEventListener("click", () => {
    const k = cell.dataset.k, cur = r.amounts?.[k];
    const inp = document.createElement("input");
    inp.className = "src-amt-in"; inp.inputMode = "decimal"; inp.value = cur == null ? "" : String(cur); inp.placeholder = "$";
    cell.replaceWith(inp); inp.focus(); inp.select();
    let done = false;
    const finish = async (commit) => {
      if (done) return; done = true;
      const txt = inp.value.replace(/[$,\s]/g, ""), val = txt === "" ? null : Number(txt);
      if (commit && (val === null || isFinite(val)) && val !== (cur ?? null)) {
        const responses = (c.responses || []).map((x) => (x.id === r.id ? { ...x, amounts: { ...x.amounts, [k]: val }, edited: { ...(x.edited || {}), [k]: true } } : x));
        await save({ responses }, "Amount corrected");
      }
      inp.blur(); refreshOpen(); drawOpen();
    };
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); finish(true); } if (e.key === "Escape") { e.preventDefault(); finish(false); } });
    inp.addEventListener("blur", () => finish(true));
  }));
}

function newCase() {
  const el = openModal(`
    <h3>New card</h3>
    <div class="form-grid">
      <label class="field"><span>Name</span><input id="srn-name" autocomplete="off" placeholder="First and last name"></label>
      <label class="field"><span>Spouse <span class="row-sub">(optional)</span></span><input id="srn-spouse" autocomplete="off"></label>
      <label class="field"><span>Email <span class="row-sub">(optional — matches them to their form responses on import)</span></span><input id="srn-email" type="email" autocomplete="off"></label>
    </div>
    <div class="modal-actions"><button class="btn" id="srn-cancel">Cancel</button><button class="btn btn-primary" id="srn-save">Create</button></div>`);
  el.querySelector("#srn-cancel").addEventListener("click", closeModal);
  el.querySelector("#srn-save").addEventListener("click", async () => {
    const name = el.querySelector("#srn-name").value.trim(), email = el.querySelector("#srn-email").value.trim().toLowerCase();
    if (!name) return el.querySelector("#srn-name").focus();
    try {
      const ref = await addDoc(collection(db, "srCases"), { key: personKey(name, email), name, spouse: el.querySelector("#srn-spouse").value.trim(), email, status: "new", requested: "", writeup: "", decision: "", notes: "", responses: [], created: new Date().toISOString(), createdBy: ctx.name || "", createdAt: serverTimestamp() });
      closeModal(); setTimeout(() => openCase(ref.id), 250);
    } catch (e) { toast("Couldn't create: " + (e.code || e.message)); }
  });
  setTimeout(() => el.querySelector("#srn-name").focus(), 50);
}

// ---------- import the specialist's spreadsheet ----------
function importCsv(text) {
  const { list, missing } = mapResponses(parseCsv(text));
  if (missing.length || !list.length) {
    const bad = openModal(`<h3>That doesn't look like the responses sheet</h3><p>${list.length ? "" : "No responses were found. "}${missing.length ? `These columns are missing: <b>${missing.map(esc).join(", ")}</b>.` : ""}</p><p class="row-sub">Open the “Self-Reliance Plan (Responses)” spreadsheet and use File → Download → Comma-separated values (.csv).</p><div class="modal-actions"><span></span><button class="btn" id="sri-bad-close" type="button">Close</button></div>`);
    bad.querySelector("#sri-bad-close").addEventListener("click", closeModal);
    return;
  }
  // group by person; work out what's new
  const byKey = new Map();
  list.forEach((x) => { if (!byKey.has(x.key)) byKey.set(x.key, { ...x, resps: [] }); const g = byKey.get(x.key); g.resps.push(x.resp); if (x.spouse) g.spouse = x.spouse; });
  const plan = [...byKey.values()].map((g) => {
    const cur = cases.find((c) => c.key === g.key) || cases.find((c) => !c.email && (c.name || "").trim().toLowerCase() === g.name.toLowerCase());
    const have = new Set((cur?.responses || []).map((r) => r.id));
    return { ...g, cur, fresh: g.resps.filter((r) => !have.has(r.id)) };
  });
  const todo = plan.filter((p) => !p.cur || p.fresh.length);
  const el = openModal(`
    <h3>Import responses</h3>
    <p class="row-sub" style="margin-top:-.6rem">${list.length} response${list.length === 1 ? "" : "s"} from ${plan.length} ${plan.length === 1 ? "person" : "people"} in this file.</p>
    <table class="simple src-imp">
      <thead><tr><th>Name</th><th>In this file</th><th>What happens</th></tr></thead>
      <tbody>${plan.map((p) => `<tr><td><b>${esc(p.name)}</b>${p.spouse ? `<div class="row-sub">& ${esc(p.spouse)}</div>` : ""}</td><td>${p.resps.length} plan${p.resps.length === 1 ? "" : "s"}</td><td>${!p.cur ? `<span class="pill pill-approved">New card</span>` : p.fresh.length ? `<span class="pill pill-inprogress">Adds ${p.fresh.length} new plan${p.fresh.length === 1 ? "" : "s"}</span>` : `<span class="row-sub">Already on file</span>`}</td></tr>`).join("")}</tbody>
    </table>
    <p class="row-sub">Write-ups, requests, notes and corrected amounts already on a card are never changed by an import.</p>
    <div class="modal-actions"><button class="btn" id="sri-cancel">Cancel</button><button class="btn btn-primary" id="sri-go"${todo.length ? "" : " disabled"}>${todo.length ? `Import ${todo.length} ${todo.length === 1 ? "person" : "people"}` : "Nothing new to import"}</button></div>`);
  el.querySelector("#sri-cancel").addEventListener("click", closeModal);
  el.querySelector("#sri-go").addEventListener("click", async () => {
    try {
      const batch = writeBatch(db);
      todo.forEach((p) => {
        if (p.cur) batch.update(doc(db, "srCases", p.cur.id), { responses: [...(p.cur.responses || []), ...p.fresh], spouse: p.cur.spouse || p.spouse || "", email: p.cur.email || p.email || "", key: p.key, updatedAt: serverTimestamp() });
        else batch.set(doc(collection(db, "srCases")), { key: p.key, name: p.name, spouse: p.spouse || "", email: p.email || "", status: "new", requested: "", writeup: "", decision: "", notes: "", responses: p.resps, created: new Date().toISOString(), createdBy: ctx.name || "", createdAt: serverTimestamp() });
      });
      await batch.commit();
      closeModal(); toast(`Imported ${todo.length} ${todo.length === 1 ? "person" : "people"}`);
    } catch (e) { toast("Couldn't import: " + (e.code || e.message)); }
  });
}

// ---------- print one card ----------
function printCase(c, r) {
  const w = window.open("", "_blank");
  if (!w) return toast("Allow pop-ups to print");
  const t = r ? respTotals(r) : null;
  const moneyRows = (defs) => defs.map(([k, l]) => `<tr><td>${esc(l)}${r.raw?.[k] && !(r.exact?.[k] && !r.edited?.[k]) ? `<div class="raw">“${esc(r.raw[k])}”</div>` : ""}</td><td class="n">${r.amounts?.[k] == null ? "—" : fmtUsd(r.amounts[k])}</td></tr>`).join("");
  w.document.write(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${esc(c.name)} — Self-Reliance</title><style>
    html { color-scheme: light; } body { margin: 0; background: #fff; color: #1f2733; font: 11pt/1.45 -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; }
    @page { size: letter; margin: .6in; } .wrap { padding: .1in; }
    h1 { font-size: 20pt; margin: 0; } .sub { color: #5b6675; margin: 0 0 .15in; }
    h2 { font-size: 12pt; margin: .22in 0 .06in; padding-bottom: .03in; border-bottom: 1.5px solid #1f2733; break-after: avoid; }
    h3 { font-size: 10.5pt; margin: .14in 0 .03in; break-after: avoid; } p { margin: 0 0 .07in; }
    .tiles { display: flex; gap: .2in; margin: .05in 0 .1in; } .tiles div { flex: 1; border: 1px solid #cfd5dd; border-radius: 6px; padding: .06in .1in; } .tiles span { display: block; font-size: 8pt; text-transform: uppercase; letter-spacing: .05em; color: #5b6675; } .tiles b { font-size: 14pt; }
    .cols { display: flex; gap: .3in; } .cols > div { flex: 1; } table { width: 100%; border-collapse: collapse; } td { border-bottom: 1px solid #dfe3e8; padding: .04in 0; vertical-align: top; } td.n { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; } .raw { color: #5b6675; font-size: 8.5pt; }
    .qa span { display: block; font-size: 8pt; text-transform: uppercase; letter-spacing: .05em; color: #5b6675; margin-top: .08in; }
    .noprint { text-align: center; margin: .3in; } @media print { .noprint { display: none; } }
  </style></head><body><div class="wrap">
    <h1>${esc(c.name || "")}</h1>
    <p class="sub">${[c.spouse ? "& " + esc(c.spouse) : "", r ? "Self-Reliance Plan " + esc(fmtDay(r.at)) : "", "printed " + new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })].filter(Boolean).join(" · ")}</p>
    ${c.requested ? `<h2>Request</h2><p>${esc(c.requested)}</p>` : ""}
    ${r ? `<h2>What they need</h2><p>${esc(r.raw?.needs || "—")}</p>
      <h2>Monthly picture (as reported)</h2>
      <div class="tiles"><div><span>Income</span><b>${fmtUsd(t.income)}</b></div><div><span>Expenses</span><b>${fmtUsd(t.expenses)}</b></div><div><span>Left over each month</span><b>${fmtUsd(t.net)}</b></div></div>
      <div class="cols"><div><h3>Income</h3><table>${moneyRows(INC)}</table></div><div><h3>Expenses</h3><table>${moneyRows(EXP)}</table></div></div>
      <h2>In their words</h2><div class="qa">${QA.filter(([k]) => !isBlank(r.raw?.[k])).map(([k, l]) => `<span>${esc(l)}</span><p>${esc(r.raw[k])}</p>`).join("")}</div>` : ""}
    ${c.writeup ? `<h2>Specialist’s write-up${c.writeupBy ? ` — ${esc(c.writeupBy)}` : ""}</h2>${writeupSections(c.writeup).map((s) => `${s.title ? `<h3>${esc(s.title)}</h3>` : ""}${s.paras.map((p) => `<p>${esc(p)}</p>`).join("")}`).join("")}` : ""}
    ${c.decision ? `<h2>Decision / help given</h2><p>${esc(c.decision)}</p>` : ""}
  </div><p class="noprint"><button onclick="print()" style="font:inherit;padding:.5rem 1.2rem">Print</button></p></body></html>`);
  w.document.close();
  setTimeout(() => { try { w.focus(); w.print(); } catch {} }, 400);
}
