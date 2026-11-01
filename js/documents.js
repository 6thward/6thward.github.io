// Documents page (2026-11-01): letters written in the app and printed on ward letterhead, plus
// uploaded PDFs / Word files to print at the church.
//   documents/{id}            { kind: "letter", title, date, to, html, closing, signer, signerTitle, by, updatedMs }
//                             { kind: "file", title, note, link, file: {id,name,size,type,chunks,at}, by, updatedMs }
//   documents/_letterhead     { kind: "letterhead", wardName, stake, address, contact, logoData }
//   documents/{id}/chunks/…   the uploaded file itself (see files.js)
import { db } from "./firebase-init.js?v=1793557757";
import { ctx, can } from "./app.js?v=1793557757";
import { collection, onSnapshot, setDoc, deleteDoc, doc } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { openModal, closeModal, toast, esc, fmtDate, todayISO } from "./ui.js?v=1793557757";
import { uploadAttachment, fetchAttachment, deleteAttachment, openAttachment, fmtBytes, fileIcon, newFileId, MAX_ATTACH_BYTES, ATTACH_ACCEPT } from "./files.js?v=1793557757";

const COLL = "documents", LH_ID = "_letterhead";
let docs = [], letterhead = null, started = false, view = "list", draft = null, filter = "";
const $ = (sel, root = document) => root.querySelector(sel);
const letterDate = (iso) => (iso ? new Date(iso + "T12:00:00").toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) : ""); // "November 1, 2026" on the letter itself

export function initDocuments() {
  if (started) return;
  started = true;
  onSnapshot(collection(db, COLL), (qs) => {
    const all = qs.docs.map((d) => ({ id: d.id, ...d.data() }));
    letterhead = all.find((d) => d.id === LH_ID) || null;
    docs = all.filter((d) => d.id !== LH_ID).sort((a, b) => (b.updatedMs || 0) - (a.updatedMs || 0));
    render();
  }, () => {});
  render();
}

function render() {
  const panel = document.getElementById("panel-documents"); if (!panel) return;
  if (view === "letter") return renderEditor(panel);
  const ed = can("documents", "edit");
  const q = filter.trim().toLowerCase();
  const shown = docs.filter((d) => !q || `${d.title || ""} ${d.file?.name || ""} ${d.note || ""}`.toLowerCase().includes(q));
  panel.innerHTML = `
    <div class="panel-head">
      <div><h2>Documents</h2><p class="panel-sub">Letters on ward letterhead, and PDFs or Word files to print at the church.</p></div>
      <div class="panel-actions">${ed ? `<button type="button" class="btn" id="doc-lh" title="Ward name, address and logo for printed letters">Letterhead</button><button type="button" class="btn" id="doc-upload">⬆ Upload a file</button><button type="button" class="btn btn-primary" id="doc-new">+ New letter</button>` : ""}</div>
    </div>
    <div class="card">
      <input class="src-in doc-filter" id="doc-filter" placeholder="Find a document…" value="${esc(filter)}" autocomplete="off">
      ${shown.length ? `<div class="doc-list">${shown.map(rowHtml).join("")}</div>` : `<p class="row-sub doc-empty">${docs.length ? "Nothing matches." : ed ? "Nothing here yet. Write a letter, or upload a PDF or Word file." : "Nothing here yet."}</p>`}
    </div>
    <input type="file" id="doc-file" accept="${ATTACH_ACCEPT}" multiple hidden>`;
  $("#doc-filter", panel).addEventListener("input", (e) => { filter = e.target.value; render(); const f = $("#doc-filter", panel); f.focus(); f.setSelectionRange(f.value.length, f.value.length); });
  $("#doc-new", panel)?.addEventListener("click", () => { draft = newLetter(); view = "letter"; render(); });
  $("#doc-lh", panel)?.addEventListener("click", letterheadModal);
  $("#doc-upload", panel)?.addEventListener("click", () => $("#doc-file", panel).click());
  $("#doc-file", panel)?.addEventListener("change", async (e) => { for (const f of [...e.target.files]) await uploadFile(f); e.target.value = ""; });
  panel.querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", () => openDoc(b.dataset.open)));
  panel.querySelectorAll("[data-print]").forEach((b) => b.addEventListener("click", () => { const d = docs.find((x) => x.id === b.dataset.print); if (d) printLetter(d); }));
  panel.querySelectorAll("[data-download]").forEach((b) => b.addEventListener("click", () => downloadFile(b.dataset.download)));
  panel.querySelectorAll("[data-editfile]").forEach((b) => b.addEventListener("click", () => editFileModal(b.dataset.editfile)));
  panel.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => removeDoc(b.dataset.del)));
}

function rowHtml(d) {
  const ed = can("documents", "edit");
  const isLetter = d.kind === "letter";
  const icon = isLetter ? "✉️" : fileIcon(d.file || { type: "", name: "" });
  const kind = isLetter ? "Letter" : /pdf/i.test((d.file?.type || "") + (d.file?.name || "")) ? "PDF" : /\.docx?$/i.test(d.file?.name || "") ? "Word" : /^image\//.test(d.file?.type || "") ? "Image" : "File";
  const when = d.date && isLetter ? fmtDate(d.date) : d.updatedMs ? fmtDate(new Date(d.updatedMs).toISOString().slice(0, 10)) : "";
  return `<div class="doc-row">
    <span class="doc-ico">${icon}</span>
    <div class="doc-main">
      <div class="doc-title"><button type="button" class="doc-link" data-open="${esc(d.id)}">${esc(d.title || d.file?.name || "Untitled")}</button><span class="pill doc-kind doc-kind-${kind.toLowerCase()}">${kind}</span></div>
      <div class="row-sub doc-sub">${[when, d.file ? fmtBytes(d.file.size) : "", d.by ? `by ${esc(d.by)}` : "", d.note ? esc(d.note) : ""].filter(Boolean).join(" · ")}${d.link ? ` · <a href="${esc(d.link)}" target="_blank" rel="noopener">Google Doc ↗</a>` : ""}</div>
    </div>
    <div class="doc-acts">
      ${isLetter ? `<button type="button" class="btn btn-sm" data-print="${esc(d.id)}" title="Print on letterhead">🖨 Print</button>` : `<button type="button" class="btn btn-sm" data-open="${esc(d.id)}" title="Open — then print from your browser">Open</button><button type="button" class="btn btn-sm btn-ghost" data-download="${esc(d.id)}">Download</button>`}
      ${ed && !isLetter ? `<button type="button" class="btn btn-sm btn-ghost" data-editfile="${esc(d.id)}" title="Rename, add a note or a Google Docs link">Edit</button>` : ""}
      ${ed ? `<button type="button" class="btn btn-sm btn-ghost btn-danger" data-del="${esc(d.id)}" title="Delete">✕</button>` : ""}
    </div>
  </div>`;
}

// ---- files ----
async function uploadFile(file) {
  if (!can("documents", "edit")) return;
  if (file.size > MAX_ATTACH_BYTES) return toast(`${file.name} is over ${fmtBytes(MAX_ATTACH_BYTES)}`);
  const id = newFileId();
  toast(`Uploading ${file.name}…`);
  try {
    const meta = await uploadAttachment(COLL, id, file, (p) => { if (p < 1) toast(`Uploading ${file.name}… ${Math.round(p * 100)}%`); });
    await setDoc(doc(db, COLL, id), { kind: "file", title: file.name.replace(/\.[a-z0-9]+$/i, ""), note: "", link: "", file: meta, by: ctx.name || "", updatedMs: Date.now() });
    toast(`${file.name} uploaded`);
  } catch (e) { toast("Couldn't upload: " + (e.code || e.message)); }
}
async function openDoc(id) {
  const d = docs.find((x) => x.id === id); if (!d) return;
  if (d.kind === "letter") { draft = { ...d }; view = "letter"; render(); return; }
  try { await openAttachment(COLL, d.file); } catch (e) { toast("Couldn't open: " + (e.message || e)); }
}
async function downloadFile(id) {
  const d = docs.find((x) => x.id === id); if (!d?.file) return;
  try {
    const blob = await fetchAttachment(COLL, d.file), url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = d.file.name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) { toast("Couldn't download: " + (e.message || e)); }
}
function editFileModal(id) {
  const d = docs.find((x) => x.id === id); if (!d) return;
  const m = openModal(`<h3>Edit</h3>
    <label class="field">Title<input id="df-title" value="${esc(d.title || "")}" maxlength="140"></label>
    <label class="field">Note <span class="row-sub">(optional)</span><input id="df-note" value="${esc(d.note || "")}" maxlength="200"></label>
    <label class="field">Google Docs link <span class="row-sub">(optional — for a file you edit in Google Docs)</span><input id="df-link" value="${esc(d.link || "")}" placeholder="https://docs.google.com/…"></label>
    <div class="modal-actions"><div class="right"><button type="button" class="btn" id="df-cancel">Cancel</button><button type="button" class="btn btn-primary" id="df-save">Save</button></div></div>`);
  $("#df-cancel", m).addEventListener("click", closeModal);
  $("#df-save", m).addEventListener("click", async () => {
    const link = $("#df-link", m).value.trim();
    if (link && !/^https?:\/\//i.test(link)) return toast("The link should start with https://");
    try { await setDoc(doc(db, COLL, id), { ...d, title: $("#df-title", m).value.trim() || d.file?.name || "Untitled", note: $("#df-note", m).value.trim(), link, updatedMs: Date.now() }); closeModal(); toast("Saved"); }
    catch (e) { toast("Couldn't save: " + (e.code || e.message)); }
  });
}
async function removeDoc(id) {
  const d = docs.find((x) => x.id === id); if (!d) return;
  if (!confirm(`Delete "${d.title || d.file?.name || "this"}"?`)) return;
  try {
    if (d.file) await deleteAttachment(COLL, d.file);
    await deleteDoc(doc(db, COLL, id));
    if (view === "letter" && draft?.id === id) { view = "list"; draft = null; }
    toast("Deleted");
  } catch (e) { toast("Couldn't delete: " + (e.code || e.message)); }
}

// ---- letters ----
const newLetter = () => ({ id: "l" + newFileId().slice(1), kind: "letter", title: "", date: todayISO(), to: "", html: "<p></p>", closing: "Sincerely,", signer: ctx.name || "", signerTitle: ctx.role === "bishop" ? "Bishop" : "", by: ctx.name || "", updatedMs: 0, _new: true });

function renderEditor(panel) {
  const d = draft, ed = can("documents", "edit");
  panel.innerHTML = `
    <div class="panel-head">
      <div><h2>${d._new ? "New letter" : "Letter"}</h2><p class="panel-sub">Prints on the ward letterhead. Save keeps it on the Documents page.</p></div>
      <div class="panel-actions"><button type="button" class="btn" id="ltr-back">‹ Documents</button>${!d._new && ed ? `<button type="button" class="btn btn-ghost btn-danger" id="ltr-del">Delete</button>` : ""}<button type="button" class="btn" id="ltr-print">🖨 Print</button>${ed ? `<button type="button" class="btn btn-primary" id="ltr-save">Save</button>` : ""}</div>
    </div>
    <div class="card ltr-card">
      <div class="ltr-meta">
        <label class="field ltr-f-title">Title <span class="row-sub">(for the list — not printed)</span><input id="ltr-title" value="${esc(d.title)}" maxlength="140" ${ed ? "" : "disabled"}></label>
        <label class="field">Date<input type="date" id="ltr-date" value="${esc(d.date || "")}" ${ed ? "" : "disabled"}></label>
      </div>
      <div class="ltr-page">
        ${letterheadHtml()}
        <div class="ltr-dateline">${esc(d.date ? letterDate(d.date) : "")}</div>
        <textarea class="ltr-to" id="ltr-to" rows="3" placeholder="To (one line each): Brother and Sister Hansen, 123 Main St…" ${ed ? "" : "disabled"}>${esc(d.to || "")}</textarea>
        ${ed ? `<div class="ltr-tools">
          <button type="button" data-cmd="bold" title="Bold"><b>B</b></button><button type="button" data-cmd="italic" title="Italic"><i>I</i></button><button type="button" data-cmd="underline" title="Underline"><u>U</u></button>
          <span class="ltr-sep"></span><button type="button" data-cmd="formatBlock" data-val="h3" title="Heading">H</button><button type="button" data-cmd="formatBlock" data-val="p" title="Normal text">¶</button>
          <span class="ltr-sep"></span><button type="button" data-cmd="insertUnorderedList" title="Bullets">•</button><button type="button" data-cmd="insertOrderedList" title="Numbered">1.</button>
          <span class="ltr-sep"></span><button type="button" data-cmd="justifyLeft" title="Align left">⇤</button><button type="button" data-cmd="justifyCenter" title="Center">↔</button>
          <span class="ltr-sep"></span><button type="button" data-cmd="undo" title="Undo">↶</button><button type="button" data-cmd="redo" title="Redo">↷</button>
        </div>` : ""}
        <div class="ltr-body" id="ltr-body" ${ed ? 'contenteditable="true"' : ""} data-placeholder="Dear Brother and Sister Hansen,">${sanitize(d.html || "")}</div>
        <div class="ltr-close">
          <input id="ltr-closing" value="${esc(d.closing || "")}" placeholder="Sincerely," ${ed ? "" : "disabled"}>
          <div class="ltr-sig"><input id="ltr-signer" value="${esc(d.signer || "")}" placeholder="Name" ${ed ? "" : "disabled"}><input id="ltr-stitle" value="${esc(d.signerTitle || "")}" placeholder="Bishop" ${ed ? "" : "disabled"}></div>
        </div>
      </div>
    </div>`;
  const body = $("#ltr-body", panel);
  const collect = () => { draft = { ...draft, title: $("#ltr-title", panel).value.trim(), date: $("#ltr-date", panel).value, to: $("#ltr-to", panel).value, html: sanitize(body.innerHTML), closing: $("#ltr-closing", panel).value, signer: $("#ltr-signer", panel).value, signerTitle: $("#ltr-stitle", panel).value }; return draft; };
  $("#ltr-back", panel).addEventListener("click", () => { collect(); if (ed && dirty()) { if (!confirm("Leave without saving?")) return; } view = "list"; draft = null; render(); });
  $("#ltr-date", panel).addEventListener("change", () => { $(".ltr-dateline", panel).textContent = $("#ltr-date", panel).value ? letterDate($("#ltr-date", panel).value) : ""; });
  $("#ltr-print", panel).addEventListener("click", () => printLetter(collect()));
  $("#ltr-save", panel)?.addEventListener("click", saveLetter);
  $("#ltr-del", panel)?.addEventListener("click", () => removeDoc(d.id));
  panel.querySelectorAll(".ltr-tools [data-cmd]").forEach((b) => b.addEventListener("mousedown", (e) => { e.preventDefault(); body.focus(); document.execCommand(b.dataset.cmd, false, b.dataset.val || null); }));
  body?.addEventListener("paste", (e) => { e.preventDefault(); document.execCommand("insertText", false, (e.clipboardData || window.clipboardData).getData("text/plain")); }); // paste as plain text — keeps Word junk out
  body?.addEventListener("keydown", (e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); saveLetter(); } });
  function dirty() { const o = docs.find((x) => x.id === draft.id); if (!o) return !!(draft.title || draft.to || stripHtml(draft.html)); return ["title", "date", "to", "html", "closing", "signer", "signerTitle"].some((k) => (o[k] || "") !== (draft[k] || "")); }
  async function saveLetter() {
    const l = collect();
    if (!l.title) { const first = stripHtml(l.html).split("\n").find(Boolean) || ""; l.title = (l.to.split("\n").find(Boolean) || first || "Letter").slice(0, 80); }
    const { _new, ...data } = l;
    try { await setDoc(doc(db, COLL, l.id), { ...data, by: data.by || ctx.name || "", updatedMs: Date.now() }); draft = { ...l, _new: false }; toast("Saved"); $("#ltr-title", panel).value = l.title; $("h2", panel).textContent = "Letter"; }
    catch (e) { toast("Couldn't save: " + (e.code || e.message)); }
  }
}

// only the tags a letter needs; everything else is unwrapped
const OK_TAGS = new Set(["P", "BR", "B", "STRONG", "I", "EM", "U", "UL", "OL", "LI", "H2", "H3", "DIV"]);
function sanitize(html) {
  const root = new DOMParser().parseFromString(`<div>${html || ""}</div>`, "text/html").body.firstChild;
  const walk = (el) => {
    [...el.childNodes].forEach((n) => {
      if (n.nodeType === 3) return;
      if (n.nodeType !== 1 || !OK_TAGS.has(n.tagName)) { walk(n); n.replaceWith(...n.childNodes); return; }
      const align = /^(left|center|right)$/.test(n.style?.textAlign || "") ? n.style.textAlign : (n.getAttribute("align") || "");
      [...n.attributes].forEach((a) => n.removeAttribute(a.name));
      if (/^(left|center|right)$/.test(align) && align !== "left") n.style.textAlign = align;
      walk(n);
    });
  };
  walk(root);
  return root.innerHTML;
}
const stripHtml = (h) => new DOMParser().parseFromString(h || "", "text/html").body.textContent.trim();

// ---- letterhead ----
function letterheadHtml() {
  const lh = letterhead || {};
  return `<div class="ltr-head">${lh.logoData ? `<img class="ltr-logo" src="${lh.logoData}" alt="">` : ""}<div class="ltr-head-txt"><div class="ltr-ward">${esc(lh.wardName || "6th Ward")}</div>${lh.stake ? `<div class="ltr-stake">${esc(lh.stake)}</div>` : ""}${lh.address ? `<div class="ltr-addr">${esc(lh.address)}</div>` : ""}${lh.contact ? `<div class="ltr-addr">${esc(lh.contact)}</div>` : ""}</div></div>`;
}
function letterheadModal() {
  const lh = letterhead || {};
  let logoData = lh.logoData || "";
  const m = openModal(`<h3>Letterhead</h3><p class="row-sub">Prints at the top of every letter.</p>
    <label class="field">Ward<input id="lh-ward" value="${esc(lh.wardName || "6th Ward")}" maxlength="80"></label>
    <label class="field">Stake <span class="row-sub">(optional)</span><input id="lh-stake" value="${esc(lh.stake || "")}" maxlength="80" placeholder="St. George Utah East Stake"></label>
    <label class="field">Address <span class="row-sub">(optional)</span><input id="lh-addr" value="${esc(lh.address || "")}" maxlength="120"></label>
    <label class="field">Phone or email <span class="row-sub">(optional)</span><input id="lh-contact" value="${esc(lh.contact || "")}" maxlength="120"></label>
    <div class="field"><span>Logo <span class="row-sub">(PNG or JPG; use the Church's official letterhead logo)</span></span>
      <div class="lh-logo-row"><div id="lh-preview" class="lh-preview">${logoData ? `<img src="${logoData}" alt="">` : `<span class="row-sub">No logo yet</span>`}</div>
      <div class="lh-logo-btns"><button type="button" class="btn btn-sm" id="lh-pick">Choose image</button>${logoData ? `<button type="button" class="btn btn-sm btn-ghost" id="lh-clear">Remove</button>` : ""}</div></div>
      <input type="file" id="lh-file" accept="image/png,image/jpeg,image/webp" hidden></div>
    <div class="modal-actions"><div class="right"><button type="button" class="btn" id="lh-cancel">Cancel</button><button type="button" class="btn btn-primary" id="lh-save">Save</button></div></div>`);
  $("#lh-cancel", m).addEventListener("click", closeModal);
  $("#lh-pick", m).addEventListener("click", () => $("#lh-file", m).click());
  $("#lh-clear", m)?.addEventListener("click", () => { logoData = ""; $("#lh-preview", m).innerHTML = `<span class="row-sub">No logo yet</span>`; });
  $("#lh-file", m).addEventListener("change", async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try { logoData = await shrinkImage(f); $("#lh-preview", m).innerHTML = `<img src="${logoData}" alt="">`; }
    catch { toast("Couldn't read that image"); }
  });
  $("#lh-save", m).addEventListener("click", async () => {
    try { await setDoc(doc(db, COLL, LH_ID), { kind: "letterhead", wardName: $("#lh-ward", m).value.trim() || "6th Ward", stake: $("#lh-stake", m).value.trim(), address: $("#lh-addr", m).value.trim(), contact: $("#lh-contact", m).value.trim(), logoData, updatedMs: Date.now() }); closeModal(); toast("Letterhead saved"); }
    catch (e) { toast("Couldn't save: " + (e.code || e.message)); }
  });
}
// the logo is kept inside the letterhead document as a data URL, so it's scaled to stay small (≤ 900px wide, ~≤ 300 KB)
function shrinkImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 900 / img.width, 400 / img.height);
      const c = document.createElement("canvas"); c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      let out = c.toDataURL("image/png");
      if (out.length > 300000) out = c.toDataURL("image/jpeg", 0.85);
      if (out.length > 400000) return reject(new Error("too big"));
      resolve(out);
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

// ---- print ----
function printLetter(l) {
  const w = window.open("", "_blank");
  if (!w) return toast("Allow pop-ups to print");
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(l.title || "Letter")}</title><style>
    @page { size: letter; margin: 1in; }
    body { font-family: Georgia, "Times New Roman", serif; font-size: 12pt; line-height: 1.45; color: #000; margin: 0; }
    .lh { display: flex; align-items: center; gap: .35in; border-bottom: 1.5px solid #000; padding-bottom: .14in; margin-bottom: .4in; }
    .lh img { height: .85in; max-width: 2.6in; object-fit: contain; }
    .ward { font-size: 16pt; font-weight: 700; letter-spacing: .01em; }
    .stake, .addr { font-size: 10.5pt; color: #222; }
    .date { margin: 0 0 .3in; }
    .to { white-space: pre-line; margin: 0 0 .3in; }
    .body p, .body div { margin: 0 0 .17in; } .body h3 { font-size: 13pt; margin: .2in 0 .1in; } .body ul, .body ol { margin: 0 0 .17in; }
    .close { margin-top: .3in; } .sig { margin-top: .55in; } .sig .t { color: #222; }
    @media screen { body { padding: 1in; max-width: 8.5in; box-sizing: border-box; } }
  </style></head><body>
    ${letterheadHtml().replace('class="ltr-head"', 'class="lh"').replace('class="ltr-logo"', "").replace('class="ltr-head-txt"', "").replace('class="ltr-ward"', 'class="ward"').replace('class="ltr-stake"', 'class="stake"').replace(/class="ltr-addr"/g, 'class="addr"')}
    ${l.date ? `<div class="date">${esc(letterDate(l.date))}</div>` : ""}
    ${l.to?.trim() ? `<div class="to">${esc(l.to.trim())}</div>` : ""}
    <div class="body">${sanitize(l.html || "")}</div>
    ${l.closing?.trim() ? `<div class="close">${esc(l.closing.trim())}</div>` : ""}
    ${l.signer?.trim() || l.signerTitle?.trim() ? `<div class="sig">${l.signer?.trim() ? `<div>${esc(l.signer.trim())}</div>` : ""}${l.signerTitle?.trim() ? `<div class="t">${esc(l.signerTitle.trim())}</div>` : ""}</div>` : ""}
    <script>window.addEventListener("load", () => setTimeout(() => window.print(), 150));</script>
  </body></html>`;
  w.document.open(); w.document.write(html); w.document.close();
}
