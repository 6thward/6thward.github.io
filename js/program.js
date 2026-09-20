// Printed sacrament-meeting program (2026-09-19).
//
// Two identical programs on one 8.5×11 sheet, side by side — cut down the
// middle for two 4.25×11 hand-outs. Logo + ward/stake names live in
// settings/program (edited from the Sacrament tab's ⚙ Settings); the
// meeting content comes straight from that Sunday's plan.
//
//   settings/program  { wardName, stakeName, logo (data URL | "" = built-in), opts: {...} }
import { db } from "./firebase-init.js?v=1789882924";
import { doc, getDoc, setDoc } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { openModal, closeModal, toast, esc } from "./ui.js?v=1789882924";

export const DEFAULT_LOGO = "assets/program-logo.jpg"; // Christus arch, built in
// Fixed by Jordan (2026-09-19): Presiding + Conducting always shown, speaker
// topics and ward-business names never, announcements always at the bottom.
// The only choice left is the optional line at the very bottom.
const DEFAULT_OPTS = { footer: "" };

export let programSettings = { wardName: "6th Ward", stakeName: "St. George East Stake", logo: "", opts: { ...DEFAULT_OPTS } };

export async function loadProgramSettings() {
  try {
    const snap = await getDoc(doc(db, "settings", "program"));
    if (snap.exists()) {
      const d = snap.data();
      programSettings = {
        wardName: typeof d.wardName === "string" ? d.wardName : programSettings.wardName,
        stakeName: typeof d.stakeName === "string" ? d.stakeName : programSettings.stakeName,
        logo: typeof d.logo === "string" ? d.logo : "",
        opts: { ...DEFAULT_OPTS, ...(d.opts || {}) },
      };
    }
  } catch { /* keep defaults */ }
  return programSettings;
}

async function persist(patch) {
  programSettings = { ...programSettings, ...patch };
  await setDoc(doc(db, "settings", "program"), programSettings, { merge: true });
}

// ---- ⚙ Settings section (markup + save) ----
export function programSettingsSection() {
  const s = programSettings;
  return `
    <div class="mtg-sec-title" style="margin-top:1.1rem">Printed program</div>
    <p class="row-sub" style="margin:0 0 .5rem">Logo and names at the top of every printed program. “Program” on a Sunday's card builds it.</p>
    <div class="speaker-row"><input id="pg-ward" placeholder="Ward name" value="${esc(s.wardName)}"><input id="pg-stake" placeholder="Stake name" value="${esc(s.stakeName)}" style="flex:1.4"></div>
    <div class="pg-logo-row">
      <img id="pg-logo-img" class="pg-logo-thumb" src="${esc(s.logo || DEFAULT_LOGO)}" alt="Program logo">
      <div style="display:flex;flex-direction:column;gap:.35rem">
        <span class="row-sub" id="pg-logo-note">${s.logo ? "Custom logo" : "Built-in logo (Christus)"}</span>
        <div style="display:flex;gap:.4rem;flex-wrap:wrap">
          <label class="btn btn-sm" style="cursor:pointer">Upload logo…<input type="file" id="pg-logo-file" accept="image/*" hidden></label>
          ${s.logo ? `<button class="btn btn-sm" id="pg-logo-reset" type="button">Use built-in</button>` : ""}
        </div>
      </div>
    </div>`;
}

// Wire the file picker: the image is shrunk in the browser and kept in the
// settings doc as a data URL (no Storage bucket needed on this plan).
export function wireProgramSettings(el) {
  const file = el.querySelector("#pg-logo-file");
  const img = el.querySelector("#pg-logo-img");
  const note = el.querySelector("#pg-logo-note");
  let pending = null; // data URL chosen but not yet saved; "" = reset to built-in
  file?.addEventListener("change", async () => {
    const f = file.files?.[0];
    if (!f) return;
    try {
      pending = await shrinkImage(f, 900);
      img.src = pending; note.textContent = "New logo (saves with Settings)";
    } catch (e) { toast("Couldn't read that image"); }
  });
  el.querySelector("#pg-logo-reset")?.addEventListener("click", () => {
    pending = ""; img.src = DEFAULT_LOGO; note.textContent = "Built-in logo (saves with Settings)";
  });
  return async () => {
    const patch = {
      wardName: el.querySelector("#pg-ward").value.trim(),
      stakeName: el.querySelector("#pg-stake").value.trim(),
    };
    if (pending !== null) patch.logo = pending;
    await persist(patch);
  };
}

function shrinkImage(file, maxSide) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const im = new Image();
    im.onload = () => {
      const sc = Math.min(1, maxSide / Math.max(im.width, im.height));
      const c = document.createElement("canvas");
      c.width = Math.round(im.width * sc); c.height = Math.round(im.height * sc);
      const g = c.getContext("2d");
      g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); // flatten transparency for print
      g.drawImage(im, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      const out = c.toDataURL("image/jpeg", 0.88);
      if (out.length > 700000) return reject(new Error("too big"));
      resolve(out);
    };
    im.onerror = () => { URL.revokeObjectURL(url); reject(new Error("bad image")); };
    im.src = url;
  });
}

// ---- Generate dialog ----
// ctx: { m (meeting doc), date, labels: {kind: label}, fmtDate(date) → "September 20, 2026", typeLabel }
export function openProgramDialog(ctx) {
  const o = { ...DEFAULT_OPTS, ...programSettings.opts };
  const el = openModal(`
    <h3 style="margin-bottom:.2rem">Program · ${esc(ctx.fmtDate(ctx.date))}</h3>
    <p class="row-sub" style="margin:0 0 .8rem">Two programs per letter sheet, side by side — cut down the middle. Uses the logo and names from ⚙ Settings.</p>
    <div class="pg-opts">
      <label class="field"><span>Line at the bottom (optional)</span><input id="pg-o-footer" value="${esc(o.footer || "")}" placeholder="e.g. Please silence phones · Nursery is in room 12"></label>
    </div>
    <div class="modal-actions">
      <span class="row-sub">Choices are remembered for next time.</span>
      <div class="right">
        <button class="btn" id="pg-cancel">Close</button>
        <button class="btn btn-primary" id="pg-go">🖨 Preview & print</button>
      </div>
    </div>`);
  el.querySelector("#pg-cancel").addEventListener("click", closeModal);
  el.querySelector("#pg-go").addEventListener("click", async () => {
    const opts = { footer: el.querySelector("#pg-o-footer").value.trim() };
    try { await persist({ opts }); } catch { /* still print */ }
    openProgramWindow(buildProgramHtml(ctx, opts));
  });
}

export function openProgramWindow(html) {
  const w = window.open("", "_blank");
  if (!w) { toast("Pop-up blocked — allow pop-ups for this site to print the program"); return null; }
  w.document.open(); w.document.write(html); w.document.close();
  return w;
}

// ---- HTML builder (pure: no DOM, no Firestore) ----
const HYMN_KINDS = ["openingHymn", "sacramentHymn", "intermediateHymn", "closingHymn"];
const SPEAKER_KINDS = ["primarySpeaker", "youthSpeaker", "speaker"];
const PRAYER_KINDS = ["invocation", "benediction"];

export function buildProgramHtml(ctx, opts = {}) {
  const o = { ...DEFAULT_OPTS, ...opts };
  const s = programSettings;
  const m = ctx.m || {};
  const L = (k) => ctx.labels?.[k] || k;
  const logoSrc = s.logo || new URL(DEFAULT_LOGO, ctx.baseHref || document.baseURI).href;
  const hymn = (it) => [it.num ? "#" + it.num : "", it.title].filter(Boolean).join("  ");

  const rows = [];
  // baby blessings print right before the sacrament, whatever their slot in the plan
  const babies = (m.items || []).filter((it) => it.kind === "babyBlessing" && (it.name || it.by));
  const babyLines = () => babies.map((b) => `<div class="baby">Blessing of ${esc(b.name || "—")}${b.by ? ` <span class="by">by ${esc(b.by)}</span>` : ""}</div>`).join("");
  const row = (label, val, sub) => rows.push(`<div class="r"><span class="l">${esc(label)}</span><span class="v">${val}</span></div>${sub ? `<div class="sub">${sub}</div>` : ""}`);
  const band = (text, sub) => rows.push(`<div class="band">${esc(text)}${sub ? `<div class="band-sub">${esc(sub)}</div>` : ""}</div>`);
  let announcements = "";

  (m.items || []).forEach((it) => {
    const k = it.kind;
    if (k === "announcements") {
      const lines = (it.text || "").split("\n").map((x) => x.trim()).filter(Boolean);
      if (lines.length) announcements = lines.map((l) => `<div>• ${esc(l)}</div>`).join("");
      return;
    }
    if (k === "sacrament" || k === "blessing") { if (babies.length) rows.push(babyLines()); band("Administration of the Sacrament"); return; }
    if (k === "testimonies") { band(L("testimonies")); return; }
    if (HYMN_KINDS.includes(k)) { row(L(k), hymn(it) ? esc(hymn(it)) : "—"); return; }
    if (SPEAKER_KINDS.includes(k)) {
      if (it.none || !it.name) return;
      row(L(k), esc(it.name)); // topics never printed
      return;
    }
    if (PRAYER_KINDS.includes(k)) { row(L(k), esc(it.name || "—")); return; }
    if (k === "musical") { row(L(k), esc(it.who || "—"), [it.hymn, it.accompanist ? "Accompanist: " + it.accompanist : ""].filter(Boolean).map(esc).join(" · ")); return; }
    if (k === "choir") { row(it.youth ? "Youth Choir" : L(k), esc(it.hymn || "—"), it.accompanist ? "Accompanist: " + esc(it.accompanist) : ""); return; }
    if (k === "babyBlessing") return; // printed just before the sacrament (above)
    if (k === "wardBusiness") return; // never printed
    if (k === "custom") { row(it.label || "Item", esc(it.text || "")); return; }
  });

  const officers = [
    ["Presiding", m.presiding || ctx.presidingDefault || "—"],   // always; blank = the bishop
    ["Conducting", m.conducting || "—"], // always
    m.chorister ? ["Music Conductor", m.chorister] : null,
    m.organist ? ["Organist", m.organist] : null,
  ].filter(Boolean).map(([l, v]) => `<div class="r"><span class="l">${esc(l)}</span><span class="v">${esc(v)}</span></div>`).join("");

  const program = `
    <div class="prog"><div class="inner">
      <div class="top">
        <img class="logo" src="${esc(logoSrc)}" alt="">
        <div class="ward">${esc(s.wardName || "")}</div>
        <div class="stake">${esc(s.stakeName || "")}</div>
      </div>
      <div class="title">Sacrament Meeting</div>
      <div class="date">${esc(ctx.fmtDate(ctx.date))}</div>
      ${m.theme ? `<div class="theme">“${esc(m.theme)}”</div>` : ""}
      <div class="rule"></div><div class="officers">${officers}</div>
      <div class="rule"></div>
      <div class="rows">${rows.join("")}</div>
      ${announcements ? `<div class="ann"><div class="ann-h">Announcements</div>${announcements}</div>` : ""}
      ${o.footer ? `<div class="foot">${esc(o.footer)}</div>` : ""}
    </div></div>`;

  return `<!doctype html><html><head><meta charset="utf-8"><title>Program · ${esc(ctx.fmtDate(ctx.date))}</title>
<style>
  @page { size: 8.5in 11in; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #e9ecef; }
  body { font-family: Georgia, "Times New Roman", serif; color: #111; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .bar { position: sticky; top: 0; display: flex; gap: .6rem; align-items: center; padding: .55rem .9rem; background: #1f2733; color: #fff; font: 600 14px/1.2 -apple-system, "Segoe UI", sans-serif; }
  .bar button { font: inherit; padding: .4rem .9rem; border: 0; border-radius: 6px; background: #fff; color: #1f2733; cursor: pointer; }
  .bar span { opacity: .8; font-weight: 400; }
  .sheet { width: 8.5in; height: 11in; margin: .5in auto; background: #fff; display: grid; grid-template-columns: 4.25in 4.25in; box-shadow: 0 6px 24px rgba(0,0,0,.18); overflow: hidden; }
  .prog { height: 11in; padding: .45in .38in .4in; text-align: center; overflow: hidden; }
  .inner { height: 100%; display: flex; flex-direction: column; }
  .prog:first-child { border-right: 1px dashed #b8bec7; }
  .top { display: flex; flex-direction: column; align-items: center; }
  .logo { max-height: 2in; max-width: 2in; object-fit: contain; margin-bottom: .12in; }
  .ward { font-size: 15pt; font-weight: 700; letter-spacing: .04em; }
  .stake { font-size: 10.5pt; letter-spacing: .06em; text-transform: uppercase; color: #333; margin-top: .03in; }
  .title { font-size: 17pt; font-variant: small-caps; letter-spacing: .06em; margin-top: .2in; }
  .date { font-size: 10.5pt; color: #333; margin-top: .04in; }
  .theme { font-style: italic; font-size: 10.5pt; margin-top: .06in; }
  .rule { height: 1px; background: #222; margin: .1in .2in; }
  .officers .r, .rows .r { display: flex; justify-content: space-between; align-items: baseline; gap: .15in; font-size: 10pt; line-height: 1.3; padding: .018in 0; }
  .officers .r .l, .rows .r .l { text-align: left; font-style: italic; color: #333; flex: 0 0 auto; }
  .officers .r .v, .rows .r .v { text-align: right; font-weight: 600; }
  .rows .sub { text-align: right; font-size: 8.5pt; color: #444; margin: -.02in 0 .035in; line-height: 1.3; }
  .rows .sub div { text-align: right; }
  .band { font-variant: small-caps; letter-spacing: .05em; font-size: 11pt; padding: .07in 0; margin: .04in 0; border-top: 1px solid #ccc; border-bottom: 1px solid #ccc; }
  .band-sub { font-variant: normal; letter-spacing: 0; font-size: 9pt; color: #444; }
  .baby { text-align: center; font-size: 10.5pt; font-weight: 600; padding: .05in 0 .06in; }
  .baby .by { font-weight: 400; font-style: italic; color: #333; }
  .ann { margin-top: auto; padding-top: .12in; text-align: left; font-size: 9pt; line-height: 1.35; }
  .ann-h { font-variant: small-caps; letter-spacing: .05em; font-size: 10pt; border-bottom: 1px solid #222; margin-bottom: .05in; }
  .ann div { padding-left: .05in; }
  .foot { font-size: 8.5pt; color: #444; font-style: italic; padding-top: .1in; }
  .ann + .foot { padding-top: .08in; }
  .inner:not(:has(.ann)) .foot { margin-top: auto; }
  @media print { .bar { display: none; } html, body { background: #fff; } .sheet { margin: 0; box-shadow: none; } }
</style></head><body>
<div class="bar"><button onclick="window.print()">🖨 Print</button><span>Letter, portrait, 100% scale — no margins. Cut along the dashed line.</span></div>
<div class="sheet">${program}${program}</div>
<script>
  // long Sundays: shrink the whole program a step at a time until it fits the 11in column
  function fit() {
    document.querySelectorAll(".inner").forEach((el) => {
      let k = 1;
      el.style.zoom = "";
      while (k > 0.62 && el.scrollHeight > el.clientHeight + 1) { k -= 0.03; el.style.zoom = k.toFixed(2); }
    });
  }
  window.addEventListener("load", fit);
  const im = document.querySelector(".logo"); if (im && !im.complete) im.addEventListener("load", fit);
  fit();
</script>
</body></html>`;
}
