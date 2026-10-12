// Self-Reliance member cards (2026-10-05). One card per person, built from the
// self-reliance specialist's form responses (imported from the spreadsheet's CSV
// export) plus the specialist's write-up, the request, and the bishop's notes.
//   srCases/{id} { key, name, spouse, email, status, requested, decision, notes, files[],
//                  writeups[{ id, at, by, text }]   — the specialist's reports, any number, newest first;
//                     (older cards carry one as writeup / writeupBy / writeupAt and are folded in on first save)
//                  responses[{ id, raw{}, amounts{}, exact{}, edited{} }] }
//   srCases/{id}/chunks/…  the attached files themselves (invoices, statements) — see files.js
//   budgets[] — the specialist's budget sheet(s): { title, income[{label, amount, note}], expenses[…], note };
//               the first is the current budget, the rest are "what if" versions compared against it
//   summary  — the leader's own few lines, shown first on the card (bullets / to-dos / bold like council notes)
//   log[]    — dated notes { id, at, by, text, editedAt }; the old single `notes` text shows as an undated note
// Same privacy as the rest of this page: only the bishop and people given Self-Reliance.
import { db } from "./firebase-init.js?v=1791779688";
import { ctx, can, goTab } from "./app.js?v=1791779688";
import {
  collection, onSnapshot, doc, addDoc, updateDoc, deleteDoc, serverTimestamp, writeBatch,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { uploadAttachment, fetchAttachment, openAttachment, deleteAttachment, fmtBytes, fileIcon, MAX_ATTACH_BYTES, ATTACH_ACCEPT } from "./files.js?v=1791779688";
import { notesHtml, toggleTodoLine, handleNoteKeys, toolbarHtml, wireToolbar, plainLine, inlineFmt } from "./notes.js?v=1791779688";
import { toast, esc, openModal, closeModal } from "./ui.js?v=1791779688";
import {
  INC, EXP, QA, parseCsv, mapResponses, personKey, respTotals, fmtUsd, isBlank, writeupSections,
  parseBudgetCsv, parseMoney, budgetTotals, fmtUsdC,
} from "./sr-import.js?v=1791779688";

let mount = null, cases = [], started = false, openId = null, openRi = null;
let loaded = null, markLoaded = null; // resolves once the cards have arrived (for opening one from another page)
let boardCards = []; // Member Board cards that point at a Self-Reliance card (2026-10-11)
let openBi = 0, budgetEditing = false;
let wuOpen = new Set(), wuEditing = null; // which write-ups are unfolded on the open card; the one being edited ("new" for a fresh one) // which budget is showing on the open card, and whether it's being edited
const thumbs = new Map(); // file id -> object URL, so an attached image shows right on the card
const isImage = (f) => /^image\//.test(f.type || "") || /\.(png|jpe?g|gif|webp)$/i.test(f.name || "");
const filter = { q: "" }; // open cards first; closed ones sit in their own section underneath (2026-10-11)
// Open or Closed (2026-10-05). Anything saved under the earlier New / Reviewing / Helping counts as Open.
const STATUS = [["open", "Open"], ["closed", "Closed"]];
const STATUS_PILL = { open: "src-st-open", closed: "src-st-closed" };
const statusOf = (c) => (c.status === "closed" ? "closed" : "open");

const fmtDay = (iso) => { const d = iso ? new Date(iso) : null; return d && !isNaN(d) ? d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : ""; };
const sorted = (c) => [...(c.responses || [])].sort((a, b) => String(a.at || "").localeCompare(String(b.at || "")));
const latest = (c) => sorted(c).slice(-1)[0] || null;
const editor = () => can("selfreliance", "edit");

// Open one card from another page (the Member Board): switch tabs, then open it once the list is here
export async function openCaseById(id) {
  goTab("selfreliance");
  if (!started) { const host = document.getElementById("sr-cards-view"); if (host) initCases(host); }
  try { await loaded; } catch {}
  if (cases.some((c) => c.id === id)) openCase(id); else toast("That Self-Reliance card isn't there any more");
}
export function initCases(el) {
  mount = el;
  if (started) { renderGrid(); return; }
  started = true;
  loaded = new Promise((res) => { markLoaded = res; });
  if (can("board")) onSnapshot(collection(db, "board"), (qs) => { boardCards = qs.docs.map((d) => ({ id: d.id, ...d.data() })).filter((k) => k.srCase); renderGrid(); refreshOpen(); }, () => {});
  mount.innerHTML = `
    <div class="card src-bar">
      <input id="src-q" placeholder="Search a name…" autocomplete="off">
      <span class="row-sub" id="src-count"></span>
      <span class="src-bar-actions">
        ${editor() ? `<button class="btn btn-primary" id="src-import" type="button" title="Upload the CSV export of the self-reliance specialist's form responses">⬆ Import responses (CSV)</button>
        <button class="btn" id="src-new" type="button">+ New card</button>
        <input type="file" id="src-file" accept=".csv,text/csv" hidden>` : ""}
      </span>
    </div>
    <div class="src-grid" id="src-grid"><div class="empty-note">Loading…</div></div>`;
  mount.querySelector("#src-q").addEventListener("input", (e) => { filter.q = e.target.value; renderGrid(); });
  mount.querySelector("#src-import")?.addEventListener("click", () => mount.querySelector("#src-file").click());
  mount.querySelector("#src-file")?.addEventListener("change", async (e) => {
    const f = e.target.files[0]; e.target.value = "";
    if (!f) return;
    try { importCsv(await f.text()); } catch (err) { toast("Couldn't read that file: " + (err.message || err)); }
  });
  mount.querySelector("#src-new")?.addEventListener("click", newCase);

  onSnapshot(collection(db, "srCases"), (qs) => {
    cases = qs.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (markLoaded) { markLoaded(); markLoaded = null; }
    renderGrid();
    refreshOpen();
  }, (err) => { mount.querySelector("#src-grid").innerHTML = `<div class="empty-note">Couldn't load: ${esc(err.code || err.message)}</div>`; });
}

// dated notes, newest first; a card from before the log existed may still carry one undated `notes` text
const logOf = (c) => [...(c.log || []), ...((c.notes || "").trim() ? [{ id: "legacy", at: "", by: "", text: c.notes }] : [])]
  .sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
const plainText = (t) => String(t || "").split("\n").map(plainLine).filter(Boolean).join(" · ");
const isoDate = (v) => { const d = v ? new Date(v) : new Date(); return isNaN(d) ? "" : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

// ---------- the cards ----------
function wuExcerpt(text) {
  const secs = writeupSections(text);
  if (!secs.length) return "";
  // the card front quotes the bottom line: Conclusion, else an "Overall…" or Recommendation section, else the opening
  const pick = [/conclusion|summary/i, /overall/i, /recommend/i].map((re) => secs.find((x) => re.test(x.title) && x.paras.length)).find(Boolean) || secs.find((x) => x.paras.length) || secs[0];
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
  const match = (c) => !q || `${c.name || ""} ${c.spouse || ""}`.toLowerCase().includes(q);
  const byDate = (a, b) => String(latest(b)?.at || b.created || "").localeCompare(String(latest(a)?.at || a.created || ""));
  const openRows = cases.filter((c) => statusOf(c) === "open" && match(c)).sort(byDate);
  const closedRows = cases.filter((c) => statusOf(c) === "closed" && match(c)).sort((a, b) => String(b.closedAt || "").localeCompare(String(a.closedAt || "")) || byDate(a, b));
  mount.querySelector("#src-count").textContent = cases.length ? `${openRows.length} open · ${closedRows.length} closed` : "";
  if (!openRows.length && !closedRows.length) {
    grid.innerHTML = `<div class="card empty-note">${cases.length ? "Nobody matches." : `No cards yet.${editor() ? " Import the specialist's form responses (the spreadsheet's <b>File → Download → CSV</b>) to build them, or add one by hand." : ""}`}</div>`;
    return;
  }
  const rows = [...openRows, ...closedRows];
  const cardHtml = (c) => {

    const r = latest(c), bud = (c.budgets || [])[0], n = (c.responses || []).length, st = statusOf(c);
    const t = bud ? budgetTotals(bud) : r ? respTotals(r) : null; // the specialist's worked-out budget beats what the form said
    const ex = wuExcerpt((writeupsOf(c)[0] || {}).text);
    return `<div class="src-card${st === "closed" ? " src-card-closed" : ""}" data-id="${c.id}" tabindex="0">
      <div class="src-card-top"><b class="src-name">${esc(c.name || "—")}</b>${editor()
        ? `<button type="button" class="pill src-st ${STATUS_PILL[st]}" data-toggle="${c.id}" title="${st === "closed" ? `Closed${c.closedAt ? " " + fmtDay(c.closedAt) : ""} — click to reopen` : "Open — click to close"}">${st === "closed" ? "Closed" : "Open"}</button>`
        : `<span class="pill src-st ${STATUS_PILL[st]}">${st === "closed" ? "Closed" : "Open"}</span>`}</div>
      <div class="row-sub">${c.spouse ? `& ${esc(c.spouse)} · ` : ""}${r ? `plan ${esc(fmtDay(r.at))}` : "no plan on file"}${n > 1 ? ` · ${n} plans` : ""}${(c.files || []).length ? ` · 📎 ${(c.files || []).length}` : ""}</div>
      ${r && !isBlank(r.raw?.needs) ? `<div class="src-need"><span>Needs</span>${esc(r.raw.needs)}</div>` : ""}
      ${c.requested ? `<div class="src-need src-req"><span>Requested</span>${esc(c.requested)}</div>` : ""}
      ${t ? tiles(t, true) : ""}
      ${bud ? `<div class="src-tiles-cap">specialist’s budget${(c.budgets || []).length > 1 ? ` · ${(c.budgets || []).length - 1} what-if${(c.budgets || []).length > 2 ? "s" : ""}` : ""}</div>` : ""}
      ${(c.summary || "").trim()
        ? `<div class="src-wu src-wu-sum"><span>Summary</span>${esc(plainText(c.summary))}</div>`
        : `<div class="src-wu${ex ? "" : " src-wu-none"}">${ex ? `<span>Specialist’s write-up</span>${esc(ex)}` : "No write-up yet"}</div>`}
    </div>`;
  };
  // open cards on top; closed ones keep their place in a section underneath
  grid.innerHTML = `<div class="src-grid-inner">${openRows.length ? openRows.map(cardHtml).join("") : `<div class="card empty-note" style="grid-column:1/-1">No open cards${q ? " match" : ""}.</div>`}</div>`
    + (closedRows.length ? `<h3 class="src-closed-head">Closed <span class="pill src-st src-st-closed">${closedRows.length}</span></h3><div class="src-grid-inner src-grid-closed">${closedRows.map(cardHtml).join("")}</div>` : "");
  // Open ⇄ Closed right on the card
  grid.querySelectorAll("[data-toggle]").forEach((b) => b.addEventListener("click", async (e) => {
    e.stopPropagation();
    const c = cases.find((x) => x.id === b.dataset.toggle); if (!c) return;
    const closing = statusOf(c) === "open";
    try {
      await updateDoc(doc(db, "srCases", c.id), { status: closing ? "closed" : "open", closedAt: closing ? new Date().toISOString() : "", updatedAt: serverTimestamp() });
      toast(closing ? `${c.name} — closed` : `${c.name} — reopened`);
    } catch (err) { toast("Couldn't save: " + (err.code || err.message)); }
  }));
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
// ---------- the specialist's budget(s) ----------
const lineKeys = (lines) => { const seen = {}; return (lines || []).map((l) => { const k = String(l.label || "").trim().toLowerCase(); seen[k] = (seen[k] || 0) + 1; return [k + "#" + seen[k], l]; }); };
function budgetHtml(c) {
  const bs = c.budgets || [], ed = editor();
  const actions = ed ? `<span class="src-h-actions"><button class="btn btn-sm btn-ghost" id="srb-import" type="button" title="Upload the specialist's budget sheet for this person (the tab's CSV download)">⬆ Import</button><button class="btn btn-sm btn-ghost" id="srb-add" type="button" title="${bs.length ? "Start a what-if from the budget that's showing" : "Type a budget in by hand"}">+ ${bs.length ? "What-if" : "Add"}</button></span><input type="file" id="srb-file" accept=".csv,text/csv" hidden>` : "";
  if (!bs.length) return ed ? `<div class="src-sec src-budget"><h4>Budget <span class="row-sub">from the specialist</span>${actions}</h4><p class="row-sub" style="margin:0">No budget on file. Import the specialist's budget sheet for this person, or add one by hand.</p></div>` : "";
  const bi = Math.min(openBi, bs.length - 1), b = bs[bi], base = bs[0];
  if (budgetEditing && ed) return budgetEditHtml(b);
  const t = budgetTotals(b);
  const chips = bs.length > 1 ? `<div class="src-scens">${bs.map((x, i) => { const n = budgetTotals(x).net; return `<button type="button" class="src-scen${i === bi ? " on" : ""}" data-bi="${i}"><span>${esc(x.title || "Budget " + (i + 1))}</span><b class="${n < 0 ? "neg" : "pos"}">${fmtUsdC(n)}</b></button>`; }).join("")}</div>` : "";
  const lines = (kind) => {
    const baseMap = new Map(lineKeys(base[kind])), mine = lineKeys(b[kind]);
    const max = Math.max(1, ...(b[kind] || []).map((l) => Number(l.amount) || 0));
    const rows = mine.map(([k, l]) => {
      let tag = "";
      if (bi > 0) {
        if (!baseMap.has(k)) tag = `<i class="src-chg src-chg-new">new</i>`;
        else if ((baseMap.get(k).amount ?? null) !== (l.amount ?? null)) tag = `<i class="src-chg">was ${fmtUsdC(baseMap.get(k).amount)}</i>`;
      }
      return `<div class="src-line${l.amount == null ? " src-line-cut" : ""}"><div class="src-line-top"><span>${esc(l.label)}${l.note ? ` <em class="src-lnote">${esc(l.note)}</em>` : ""}</span><span class="src-amt">${tag}${l.amount == null ? "cut" : fmtUsdC(l.amount)}</span></div>${kind === "expenses" ? `<div class="src-bar-track"><div class="src-bar-fill" style="width:${Math.round(((Number(l.amount) || 0) / max) * 100)}%"></div></div>` : ""}</div>`;
    }).join("");
    const have = new Set(mine.map(([k]) => k));
    const gone = bi > 0 ? lineKeys(base[kind]).filter(([k]) => !have.has(k)).map(([, l]) => `${esc(l.label)} (${fmtUsdC(l.amount)})`) : [];
    return (rows || `<p class="row-sub" style="margin:0">—</p>`) + (gone.length ? `<p class="src-hint">Not in this version: ${gone.join(" · ")}</p>` : "");
  };
  return `<div class="src-sec src-budget">
    <h4>Budget <span class="row-sub">from the specialist</span>${actions}</h4>
    ${chips}
    <div class="src-budget-title"><b>${esc(b.title || "Budget")}</b>${bi > 0 ? `<span class="row-sub">changes shown against “${esc(base.title || "Current")}”</span>` : ""}${ed ? `<button class="btn btn-sm btn-ghost" id="srb-edit" type="button">✎ Edit</button>` : ""}</div>
    ${tiles(t)}
    <div class="src-money"><div><h5>Income</h5>${lines("income")}</div><div><h5>Expenses</h5>${lines("expenses")}</div></div>
    ${b.note ? `<p class="src-hint">${esc(b.note)}</p>` : ""}
  </div>`;
}
function budgetEditHtml(b) {
  const row = (l) => `<div class="srb-row"><input class="srb-l" value="${esc(l.label || "")}" placeholder="Item" autocomplete="off"><input class="srb-a" inputmode="decimal" value="${l.amount == null ? "" : esc(l.amount)}" placeholder="$" autocomplete="off"><input class="srb-n" value="${esc(l.note || "")}" placeholder="note" autocomplete="off"><button type="button" class="btn btn-sm btn-ghost srb-x" title="Remove this line">✕</button></div>`;
  return `<div class="src-sec src-budget src-budget-editing">
    <h4>Edit budget</h4>
    <label class="srb-field">Name<input id="srb-title" value="${esc(b.title || "")}" placeholder="e.g. Current, What if the kids pay rent" autocomplete="off"></label>
    <h5>Income</h5><div id="srb-income">${(b.income || []).map(row).join("")}</div><button class="btn btn-sm btn-ghost" data-addline="income" type="button">+ income line</button>
    <h5>Expenses</h5><div id="srb-expenses">${(b.expenses || []).map(row).join("")}</div><button class="btn btn-sm btn-ghost" data-addline="expenses" type="button">+ expense line</button>
    <label class="srb-field">Note<input id="srb-note" value="${esc(b.note || "")}" placeholder="optional" autocomplete="off"></label>
    <p class="src-hint">Leave an amount blank to show the line as “cut”. Totals are added up for you.</p>
    <div class="srb-actions"><button class="btn btn-sm btn-ghost btn-danger" id="srb-del" type="button">Delete this budget</button><span></span><button class="btn btn-sm" id="srb-cancel" type="button">Cancel</button><button class="btn btn-primary btn-sm" id="srb-save" type="button">Save budget</button></div>
  </div>`;
}

// headings from the text's own section titles; inside them bold / highlights / bullets like any notes
function writeupHtml(text) {
  return writeupSections(text).map((s) => `${s.title ? `<h5>${inlineFmt(s.title)}</h5>` : ""}${notesHtml(s.paras.join("\n"), "wu", false)}`).join("");
}
// every write-up on the card, newest first (an older single write-up counts as one)
const writeupsOf = (c) => [...(c.writeups || []), ...((c.writeup || "").trim() ? [{ id: "legacy", at: c.writeupAt || "", by: c.writeupBy || "", text: c.writeup }] : [])]
  .sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
const wuSummary = (w) => { const secs = writeupSections(w.text); const first = secs[0] || { title: "", paras: [] }; const line = first.title || plainLine(first.paras[0] || ""); return line.length > 110 ? line.slice(0, 108) + "…" : line; };
function detailHtml(c, ri) {
  const rs = sorted(c), r = rs[ri] || null, st = statusOf(c), ed = editor();
  return `
    <div class="src-d-head">
      <div><h3>${esc(c.name || "—")}</h3>
        <div class="row-sub">${[c.spouse ? "& " + esc(c.spouse) : "", boardCards.some((k) => k.srCase === c.id) ? `<a href="#" class="src-board-link" data-board="${esc(boardCards.find((k) => k.srCase === c.id).id)}" title="Open their Member Board card">📋 Member Board</a>` : "", c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : ""].filter(Boolean).join(" · ")}</div></div>
      <div class="src-d-tools">
        ${ed ? `<select id="srd-status" class="src-st-sel ${STATUS_PILL[st]}" title="${st === "closed" && c.closedAt ? "Closed " + esc(fmtDay(c.closedAt)) : "Open or closed"}">${STATUS.map(([k, l]) => `<option value="${k}"${k === st ? " selected" : ""}>${l}</option>`).join("")}</select>` : `<span class="pill src-st ${STATUS_PILL[st]}">${esc(STATUS.find(([k]) => k === st)?.[1] || st)}</span>`}
        <button class="btn btn-sm" id="srd-print" type="button">🖨 Print</button>
      </div>
    </div>
    <div class="src-summary">
      <h4>Summary ${ed && (c.summary || "").trim() ? `<button class="btn btn-sm btn-ghost" data-richedit="summary" type="button">✎ Edit</button>` : ""}</h4>
      ${(c.summary || "").trim()
        ? `<div class="src-rich${ed ? " src-rich-edit-ok" : ""}" data-rich="summary">${notesHtml(c.summary, "summary", ed, (i) => `data-rtodo="summary|${i}"`)}</div>`
        : ed ? `<div class="src-rich src-rich-empty src-rich-edit-ok" data-rich="summary">+ Add your summary — the few lines you want to see first when you open this card</div>` : `<p class="row-sub" style="margin:0">No summary yet.</p>`}
    </div>
    <div class="src-d-cols">
      <div class="src-col">
        ${budgetHtml(c)}
        ${rs.length > 1 ? `<div class="src-tabs">${rs.map((x, i) => `<button type="button" class="chip${i === ri ? " active" : ""}" data-ri="${i}">Plan ${esc(fmtDay(x.at))}${i === rs.length - 1 ? " · latest" : ""}</button>`).join("")}</div>` : ""}
        ${r ? `${rs.length <= 1 ? `<p class="row-sub" style="margin:0 0 .5rem">Self-Reliance Plan sent ${esc(fmtDay(r.at))}</p>` : ""}${planHtml(c, r)}` : `<div class="empty-note">No Self-Reliance Plan on file for this person yet. Import the specialist's responses to add it.</div>`}
      </div>
      <div class="src-col src-col-leader">
        <div class="src-sec"><h4>Request</h4>
          ${ed ? `<input id="srd-requested" class="src-in" value="${esc(c.requested || "")}" placeholder="e.g. One month of rent ($1,950) + 1–2 food orders" autocomplete="off">` : `<p>${esc(c.requested || "—")}</p>`}</div>
        <div class="src-sec" id="srd-wus"><h4>Specialist’s write-ups ${ed ? `<button class="btn btn-sm btn-ghost" id="srd-wu-add" type="button">+ Add write-up</button>` : ""}</h4>
          <div id="srd-wu-new"></div>
          ${(() => { const list = writeupsOf(c); if (!list.length) return `<p class="row-sub" style="margin:0">No write-up yet${ed ? " — paste the specialist's report with “+ Add write-up”." : "."}</p>`;
            return list.map((w, i) => {
              const open = wuOpen.has(w.id) || (i === 0 && !wuOpen.has("~" + w.id) && ![...wuOpen].some((k) => !k.startsWith("~"))); // the newest unfolds by itself
              const head = `<span class="src-wu-date">${esc(fmtDay(w.at) || "undated")}</span>${w.by ? `<span class="src-wu-by">· ${esc(w.by)}</span>` : ""}`;
              return open
                ? `<div class="src-wu-card" data-wuid="${esc(w.id)}">
                    <div class="src-wu-head" data-wufold="${esc(w.id)}" title="Click to fold this write-up up">${head}<span class="src-wu-tools">${ed ? `<button type="button" class="btn btn-sm btn-ghost" data-wuedit="${esc(w.id)}">✎ Edit</button>` : ""}<span class="src-wu-caret">▴</span></span></div>
                    <div class="src-writeup">${writeupHtml(w.text)}</div>
                  </div>`
                : `<button type="button" class="src-wu-pill" data-wuopen="${esc(w.id)}" title="Click to read">${head}<span class="src-wu-sum">${esc(wuSummary(w))}</span><span class="src-wu-caret">▾</span></button>`;
            }).join(""); })()}</div>
        <div class="src-sec"><h4>Notes ${ed ? `<button class="btn btn-sm btn-ghost" id="srd-note-add" type="button">+ Add note</button>` : ""}</h4>
          <div id="srd-note-new"></div>
          ${logOf(c).length ? logOf(c).map((n) => `<div class="src-note" data-note="${esc(n.id)}">
              <div class="src-note-head"><b>${esc(fmtDay(n.at) || "Earlier note")}</b>${n.by ? `<span> · ${esc(n.by)}</span>` : ""}${n.editedAt ? `<span class="row-sub"> · edited</span>` : ""}
                ${ed ? `<span class="src-note-tools"><button type="button" class="btn btn-sm btn-ghost" data-richedit="note:${esc(n.id)}" title="Edit this note">✎</button><button type="button" class="btn btn-sm btn-ghost" data-ndel="${esc(n.id)}" title="Delete this note">✕</button></span>` : ""}</div>
              <div class="src-rich${ed ? " src-rich-edit-ok" : ""}" data-rich="note:${esc(n.id)}">${notesHtml(n.text, "note:" + n.id, ed, (i) => `data-rtodo="note:${esc(n.id)}|${i}"`)}</div>
            </div>`).join("") : `<p class="row-sub" style="margin:0">No notes yet${ed ? " — add one after a visit, a phone call, or a new report from the specialist." : "."}</p>`}</div>
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
  openBi = 0; budgetEditing = false; wuOpen = new Set(); wuEditing = null;
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
  if (box.querySelector(".src-rich-editor") || box.querySelector(".src-budget-editing")) return; // a summary / note / budget is being written
  if (box.querySelector(".src-wu-editor")) return;                                       // a write-up is being edited
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
  box.querySelector(".src-board-link")?.addEventListener("click", (e) => { e.preventDefault(); openId = null; closeModal(); goTab("board"); document.dispatchEvent(new CustomEvent("board:show", { detail: { id: e.currentTarget.dataset.board } })); });
  box.querySelector("#srd-print").addEventListener("click", () => printCase(c, rs[openRi]));
  box.querySelectorAll("[data-ri]").forEach((b) => b.addEventListener("click", () => { openRi = Number(b.dataset.ri); drawOpen(); }));
  box.querySelectorAll("[data-bi]").forEach((b) => b.addEventListener("click", () => { openBi = Number(b.dataset.bi); drawOpen(); }));
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

  box.querySelector("#srd-status").addEventListener("change", (e) => save({ status: e.target.value, closedAt: e.target.value === "closed" ? new Date().toISOString() : "" }, e.target.value === "closed" ? "Closed" : "Reopened"));
  // --- budgets: import the specialist's sheet, add a what-if, edit lines ---
  const budgets = c.budgets || [];
  box.querySelector("#srb-edit")?.addEventListener("click", () => { budgetEditing = true; drawOpen(); });
  box.querySelector("#srb-add")?.addEventListener("click", async () => {
    const cur = budgets[Math.min(openBi, budgets.length - 1)];
    const fresh = cur ? { title: "What if?", income: (cur.income || []).map((l) => ({ ...l })), expenses: (cur.expenses || []).map((l) => ({ ...l })), note: "" }
      : { title: "Current", income: [{ label: "", amount: null, note: "" }], expenses: ["Tithing", "Food", "Housing", "Utilities", "Medical", "Transportation"].map((label) => ({ label, amount: null, note: "" })), note: "" };
    await save({ budgets: [...budgets, fresh] });
    openBi = budgets.length; budgetEditing = true; drawOpen();
  });
  const bFile = box.querySelector("#srb-file");
  box.querySelector("#srb-import")?.addEventListener("click", () => { bFile.value = ""; bFile.click(); });
  bFile?.addEventListener("change", async () => {
    const f = bFile.files[0]; if (!f) return;
    let found = [];
    try { found = parseBudgetCsv(await f.text()); } catch (e) { return toast("Couldn't read that file: " + (e.message || e)); }
    if (!found.length) return toast("No budget found in that file — it should have an “Income” section and an “Expenses” section");
    const off = found.filter((b) => { const t = budgetTotals(b); return ["income", "expenses", "net"].some((k) => b.sheet[k] != null && Math.abs(b.sheet[k] - t[k]) > 0.005); });
    const list = found.map((b) => `• ${b.title}: left over ${fmtUsdC(budgetTotals(b).net)}`).join("\n");
    if (!confirm(`Found ${found.length} budget${found.length === 1 ? "" : "s"} in ${f.name}:\n\n${list}\n\n${budgets.length ? `This REPLACES the ${budgets.length} budget${budgets.length === 1 ? "" : "s"} now on ${c.name}'s card.` : `Add ${found.length === 1 ? "it" : "them"} to ${c.name}'s card?`}${off.length ? `\n\nNote: my totals for “${off.map((b) => b.title).join("”, “")}” don't match the sheet's own totals — worth a look after importing.` : ""}`)) return;
    openBi = 0; budgetEditing = false;
    await save({ budgets: found.map(({ sheet, ...b }) => b), budgetAt: new Date().toISOString() }, found.length === 1 ? "Budget imported" : `${found.length} budgets imported`);
  });
  if (box.querySelector(".src-budget-editing")) {
    const bi = Math.min(openBi, budgets.length - 1);
    const blank = () => { const d = document.createElement("div"); d.innerHTML = `<div class="srb-row"><input class="srb-l" placeholder="Item" autocomplete="off"><input class="srb-a" inputmode="decimal" placeholder="$" autocomplete="off"><input class="srb-n" placeholder="note" autocomplete="off"><button type="button" class="btn btn-sm btn-ghost srb-x" title="Remove this line">✕</button></div>`; return d.firstChild; };
    const wireX = (root) => root.querySelectorAll(".srb-x").forEach((x) => { x.onclick = () => x.closest(".srb-row").remove(); });
    wireX(box);
    box.querySelectorAll("[data-addline]").forEach((b) => b.addEventListener("click", () => { const r = blank(); box.querySelector("#srb-" + b.dataset.addline).appendChild(r); wireX(r.parentElement); r.querySelector(".srb-l").focus(); }));
    const read = (id) => [...box.querySelectorAll(`#${id} .srb-row`)].map((r) => ({ label: r.querySelector(".srb-l").value.trim(), amount: parseMoney(r.querySelector(".srb-a").value), note: r.querySelector(".srb-n").value.trim() })).filter((l) => l.label || l.amount != null);
    box.querySelector("#srb-cancel").addEventListener("click", () => { budgetEditing = false; drawOpen(); });
    box.querySelector("#srb-save").addEventListener("click", async () => {
      const next = budgets.map((b, i) => (i === bi ? { title: box.querySelector("#srb-title").value.trim() || (i === 0 ? "Current" : "What if?"), income: read("srb-income"), expenses: read("srb-expenses"), note: box.querySelector("#srb-note").value.trim() } : b));
      budgetEditing = false;
      await save({ budgets: next }, "Budget saved");
      drawOpen();
    });
    box.querySelector("#srb-del").addEventListener("click", async () => {
      if (!confirm(`Delete the “${budgets[bi]?.title || "budget"}” budget from this card?`)) return;
      budgetEditing = false; openBi = 0;
      await save({ budgets: budgets.filter((_, i) => i !== bi) }, "Budget deleted");
      drawOpen();
    });
  }

  // --- summary and notes: formatted text that edits in place (bullets, to-dos, bold, highlights) ---
  const noteById = (id) => logOf(c).find((n) => n.id === id);
  // an old undated note is kept: it becomes a regular entry in the log the first time anything is saved
  const saveLog = (next, msg) => save({ log: next.map((n) => (n.id === "legacy" ? { ...n, id: "n" + Date.now().toString(36) + "old" } : n)), notes: "" }, msg);
  const editRich = (target, opts) => {
    box.querySelector(".src-rich-editor")?.remove();
    const wrap = document.createElement("div");
    wrap.className = "src-rich-editor";
    wrap.innerHTML = `${opts.meta ? `<div class="src-note-meta"><label>Date <input type="date" data-nd value="${esc(isoDate(opts.meta.at))}"></label><label>Written by <input data-nb value="${esc(opts.meta.by || "")}" placeholder="Name" autocomplete="off"></label></div>` : ""}
      <div class="wc-tools">${toolbarHtml("Tab makes a sub-point · ⌘Enter saves")}</div>
      <textarea class="src-ta" placeholder="${esc(opts.placeholder)}"></textarea>
      <div class="src-rich-actions"><button class="btn btn-sm" data-x="cancel" type="button">Cancel</button><button class="btn btn-primary btn-sm" data-x="save" type="button">Save</button></div>`;
    const ta = wrap.querySelector("textarea");
    ta.value = opts.text || "";
    wireToolbar(wrap, ta);
    if (opts.replace) target.replaceWith(wrap); else target.appendChild(wrap);
    const grow = () => { ta.style.height = "auto"; ta.style.height = Math.max(90, ta.scrollHeight + 2) + "px"; };
    ta.addEventListener("input", grow); grow(); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
    const done = async (commit) => {
      const val = ta.value.trim(), meta = opts.meta ? { date: wrap.querySelector("[data-nd]").value, by: wrap.querySelector("[data-nb]").value.trim() } : null;
      wrap.remove();
      if (commit) await opts.onSave(val, meta);
      drawOpen();
    };
    wrap.querySelector('[data-x="save"]').addEventListener("click", () => done(true));
    wrap.querySelector('[data-x="cancel"]').addEventListener("click", () => done(false));
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); done(false); }
      else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); done(true); }
      else handleNoteKeys(ta, e);
    });
  };
  const openRich = (key) => {
    const target = box.querySelector(`[data-rich="${key}"]`); if (!target) return;
    if (key === "summary") return editRich(target, { replace: true, text: c.summary || "", placeholder: "The few lines you want to see first — where things stand, what was decided, what's next", onSave: (val) => save({ summary: val }, val ? "Summary saved" : "Summary removed") });
    const n = noteById(key.slice(5)); if (!n) return;
    editRich(target, { replace: true, text: n.text, meta: { at: n.at, by: n.by }, placeholder: "Note", onSave: (val, meta) => {
      const at = meta.date ? (isoDate(n.at) === meta.date && n.at ? n.at : meta.date + "T12:00:00") : n.at || new Date().toISOString();
      const next = val ? logOf(c).map((x) => (x.id === n.id ? { ...x, id: x.id === "legacy" ? "n" + Date.now().toString(36) : x.id, text: val, at, by: meta.by, editedAt: new Date().toISOString() } : x)) : logOf(c).filter((x) => x.id !== n.id);
      return saveLog(next, val ? "Note saved" : "Note removed");
    } });
  };
  box.querySelectorAll("[data-richedit]").forEach((b) => b.addEventListener("click", () => openRich(b.dataset.richedit)));
  box.querySelectorAll(".src-rich-edit-ok[data-rich]").forEach((el) => el.addEventListener("click", (e) => {
    if (e.target.closest("input, a, label")) return; // ticking a to-do isn't a request to edit
    if (window.getSelection && String(window.getSelection())) return; // selecting text to copy isn't either
    openRich(el.dataset.rich);
  }));
  box.querySelector("#srd-note-add").addEventListener("click", () => {
    const slot = box.querySelector("#srd-note-new");
    editRich(slot, { text: "", meta: { at: new Date().toISOString(), by: ctx.name || "" }, placeholder: "What happened, what was said, what's next…", onSave: (val, meta) => {
      if (!val) return;
      const today = isoDate();
      const at = !meta.date || meta.date === today ? new Date().toISOString() : meta.date + "T12:00:00";
      return saveLog([...logOf(c), { id: "n" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), at, by: meta.by, text: val }], "Note added");
    } });
  });
  box.querySelectorAll("[data-ndel]").forEach((b) => b.addEventListener("click", async () => {
    const n = noteById(b.dataset.ndel); if (!n) return;
    if (!confirm(`Delete this note${n.at ? " from " + fmtDay(n.at) : ""}?`)) return;
    await saveLog(logOf(c).filter((x) => x.id !== n.id), "Note deleted");
  }));
  // to-do boxes in the summary / a note tick in place
  box.querySelectorAll("[data-rtodo]").forEach((cb) => cb.addEventListener("change", async () => {
    const cut = cb.dataset.rtodo.lastIndexOf("|"), key = cb.dataset.rtodo.slice(0, cut), idx = Number(cb.dataset.rtodo.slice(cut + 1));
    if (key === "summary") return save({ summary: toggleTodoLine(c.summary || "", idx) });
    const n = noteById(key.slice(5)); if (!n) return;
    await saveLog(logOf(c).map((x) => (x.id === n.id ? { ...x, id: x.id === "legacy" ? "n" + Date.now().toString(36) : x.id, text: toggleTodoLine(x.text, idx) } : x)));
  }));

  [["#srd-requested", "requested"], ["#srd-decision", "decision"]].forEach(([sel, key]) => {
    const inp = box.querySelector(sel);
    inp.addEventListener("change", () => { if (inp.value.trim() !== (c[key] || "")) save({ [key]: inp.value.trim() }, "Saved"); });
  });
  // --- the specialist's write-ups: fold / unfold, add, edit (with the notes toolbar), delete ---
  box.querySelectorAll("[data-wuopen]").forEach((b) => b.addEventListener("click", () => { wuOpen.add(b.dataset.wuopen); drawOpen(); }));
  box.querySelectorAll("[data-wufold]").forEach((h) => h.addEventListener("click", (e) => {
    if (e.target.closest("[data-wuedit]")) return;
    const id = h.dataset.wufold; wuOpen.delete(id); wuOpen.add("~" + id); drawOpen(); // "~id" = folded on purpose, so the newest doesn't spring back open
  }));
  const saveWriteups = (next, msg) => save({ writeups: next.map((w) => (w.id === "legacy" ? { ...w, id: "w" + Date.now().toString(36) + "old" } : w)), writeup: "", writeupBy: "", writeupAt: "" }, msg);
  const editWu = (anchor, w) => { // w = null for a new one
    box.querySelector(".src-wu-editor")?.remove();
    const form = document.createElement("div");
    form.className = "src-wu-editor src-wu-card";
    // the entry keeps one id from the first keystroke, so auto-saves update it rather than add copies
    const wid = w ? w.id : "w" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    const actions = (where) => `<div class="src-rich-actions src-wu-actions-${where}">${w && where === "bottom" ? `<button class="btn btn-sm btn-ghost btn-danger" data-x="delete" type="button">Delete</button>` : ""}<span class="src-wu-status" data-status></span><span style="flex:1"></span><button class="btn btn-sm" data-x="cancel" type="button">Close</button><button class="btn btn-primary btn-sm" data-x="save" type="button">Save</button></div>`;
    form.innerHTML = `${actions("top")}<div class="src-note-meta"><label>Date <input type="date" data-wd value="${esc(isoDate(w?.at || new Date().toISOString()))}"></label><label>Written by <input data-wb value="${esc(w?.by || (writeupsOf(c)[0] || {}).by || "")}" placeholder="Specialist's name" autocomplete="off"></label></div>
      <div class="wc-tools">${toolbarHtml("Section titles on their own line become headings · saves as you go")}</div>
      <textarea class="src-ta src-ta-tall" placeholder="Paste the self-reliance specialist's write-up here."></textarea>
      ${actions("bottom")}`;
    const ta = form.querySelector("textarea"); ta.value = w?.text || "";
    wireToolbar(form, ta);
    if (w) anchor.replaceWith(form); else anchor.appendChild(form);
    const grow = () => { ta.style.height = "auto"; ta.style.height = Math.max(160, ta.scrollHeight + 2) + "px"; };
    grow(); (w ? ta : form.querySelector("[data-wb]")).focus();
    const status = (t) => form.querySelectorAll("[data-status]").forEach((el) => { el.textContent = t; });
    let lastSaved = JSON.stringify({ text: w?.text || "", by: w?.by || "", date: isoDate(w?.at || "") }), timer = null, saving = null;
    // write what's in the box to the card; the editor stays open (the card won't redraw under it)
    const persist = async () => {
      const text = ta.value.trim(), date = form.querySelector("[data-wd]").value, by = form.querySelector("[data-wb]").value.trim();
      const key = JSON.stringify({ text, by, date });
      if (!text || key === lastSaved) return false;
      if (saving) await saving;
      const cur = cases.find((x) => x.id === openId) || c, list = writeupsOf(cur), have = list.find((x) => x.id === wid);
      const at = date ? (have && isoDate(have.at) === date ? have.at : date + "T12:00:00") : (have?.at || new Date().toISOString());
      const next = have ? list.map((x) => (x.id === wid ? { ...x, text, by, at, editedAt: new Date().toISOString() } : x)) : [...list, { id: wid, at, by, text }];
      if (!have) wuOpen = new Set([wid]);
      status("Saving…");
      saving = saveWriteups(next).then(() => { lastSaved = key; status("Saved ✓"); }).catch(() => status("Couldn't save")).finally(() => { saving = null; });
      await saving;
      return true;
    };
    const queue = () => { clearTimeout(timer); status("…"); timer = setTimeout(persist, 1200); }; // auto-save shortly after typing stops
    ta.addEventListener("input", () => { grow(); queue(); });
    form.querySelectorAll("[data-wd], [data-wb]").forEach((inp) => inp.addEventListener("change", queue));
    const done = async (mode) => {
      clearTimeout(timer);
      if (mode === "delete" && !confirm("Delete this write-up? This can't be undone.")) return;
      if (mode === "save" || mode === "cancel") { if (!ta.value.trim() && mode === "save") { ta.focus(); return toast("Nothing to save yet"); } await persist(); }
      form.remove(); wuEditing = null;
      if (mode === "save") toast("Write-up saved");
      else if (mode === "delete") await saveWriteups(writeupsOf(cases.find((x) => x.id === openId) || c).filter((x) => x.id !== wid), "Write-up deleted");
      drawOpen();
    };
    form.querySelectorAll("[data-x]").forEach((b) => b.addEventListener("click", () => done(b.dataset.x)));
    ta.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); done("cancel"); } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); done("save"); } else handleNoteKeys(ta, e); });
  };
  box.querySelector("#srd-wu-add")?.addEventListener("click", () => { wuEditing = "new"; editWu(box.querySelector("#srd-wu-new"), null); });
  box.querySelectorAll("[data-wuedit]").forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); const w = writeupsOf(c).find((x) => x.id === b.dataset.wuedit); if (w) { wuEditing = w.id; editWu(b.closest(".src-wu-card"), w); } }));
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
      const ref = await addDoc(collection(db, "srCases"), { key: personKey(name, email), name, spouse: el.querySelector("#srn-spouse").value.trim(), email, status: "open", requested: "", writeup: "", decision: "", notes: "", responses: [], created: new Date().toISOString(), createdBy: ctx.name || "", createdAt: serverTimestamp() });
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
        else batch.set(doc(collection(db, "srCases")), { key: p.key, name: p.name, spouse: p.spouse || "", email: p.email || "", status: "open", requested: "", writeup: "", decision: "", notes: "", responses: p.resps, created: new Date().toISOString(), createdBy: ctx.name || "", createdAt: serverTimestamp() });
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
    ${(c.summary || "").trim() ? `<h2>Summary</h2>${String(c.summary).split("\n").map((l) => l.trim()).filter(Boolean).map((l) => `<p>${/^(\s*)([-•*]|\[( |x|X)\])/.test(l) ? "• " : ""}${esc(plainLine(l))}</p>`).join("")}` : ""}
    ${c.requested ? `<h2>Request</h2><p>${esc(c.requested)}</p>` : ""}
    ${(c.budgets || []).map((b, i) => { const bt = budgetTotals(b); const rowsOf = (ls) => (ls || []).map((l) => `<tr><td>${esc(l.label)}${l.note ? `<div class="raw">${esc(l.note)}</div>` : ""}</td><td class="n">${l.amount == null ? "cut" : fmtUsdC(l.amount)}</td></tr>`).join("");
      return `<h2>${i === 0 ? "Budget from the specialist" : "What-if"}: ${esc(b.title || "")}</h2>
        <div class="tiles"><div><span>Income</span><b>${fmtUsdC(bt.income)}</b></div><div><span>Expenses</span><b>${fmtUsdC(bt.expenses)}</b></div><div><span>Left over each month</span><b>${fmtUsdC(bt.net)}</b></div></div>
        ${i === 0 || (c.budgets || []).length <= 2 ? `<div class="cols"><div><h3>Income</h3><table>${rowsOf(b.income)}</table></div><div><h3>Expenses</h3><table>${rowsOf(b.expenses)}</table></div></div>` : ""}`; }).join("")}
    ${r ? `<h2>What they need</h2><p>${esc(r.raw?.needs || "—")}</p>
      <h2>Monthly picture (as reported)</h2>
      <div class="tiles"><div><span>Income</span><b>${fmtUsd(t.income)}</b></div><div><span>Expenses</span><b>${fmtUsd(t.expenses)}</b></div><div><span>Left over each month</span><b>${fmtUsd(t.net)}</b></div></div>
      <div class="cols"><div><h3>Income</h3><table>${moneyRows(INC)}</table></div><div><h3>Expenses</h3><table>${moneyRows(EXP)}</table></div></div>
      <h2>In their words</h2><div class="qa">${QA.filter(([k]) => !isBlank(r.raw?.[k])).map(([k, l]) => `<span>${esc(l)}</span><p>${esc(r.raw[k])}</p>`).join("")}</div>` : ""}
    ${writeupsOf(c).map((w) => `<h2>Specialist’s write-up — ${esc(fmtDay(w.at) || "undated")}${w.by ? `, ${esc(w.by)}` : ""}</h2>${writeupSections(w.text).map((s) => `${s.title ? `<h3>${esc(s.title)}</h3>` : ""}${s.paras.map((p) => `<p>${esc(plainLine(p))}</p>`).join("")}`).join("")}`).join("")}
    ${c.decision ? `<h2>Decision / help given</h2><p>${esc(c.decision)}</p>` : ""}
  </div><p class="noprint"><button onclick="print()" style="font:inherit;padding:.5rem 1.2rem">Print</button></p></body></html>`);
  w.document.close();
  setTimeout(() => { try { w.focus(); w.print(); } catch {} }, 400);
}
