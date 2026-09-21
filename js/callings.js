// Bishopric tab (bishopric+): the callings flow.
//   1. Callings to Fill — names under consideration; mark the settled name
//   2. Call issued & accepted — awaiting sustaining and setting apart
//   3. Sustained & set apart — waiting to be updated in MLS (two clicks: set apart, then MLS → complete)
//   4. Complete
// Releases run a parallel flow: decided → notified → released → recorded.
// Plus a standing pool of members who need callings.
import { db } from "./firebase-init.js?v=1789967537";
import {
  collection, query, orderBy, onSnapshot, addDoc, updateDoc, deleteDoc, doc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { openModal, closeModal, toast, esc } from "./ui.js?v=1789967537";
import { addSustainingToNext, removeSustaining } from "./sacrament.js?v=1789967537";

const CALL_STAGES = [
  ["fill", "Calling to Fill"],
  ["issue", "Calls to Issue"],
  ["sustain", "Calls to Sustain"],
  ["apart", "Set Apart & MLS"],
  ["done", "Complete"],
];
const REL_STAGES = [
  ["decided", "Decided"],
  ["notified", "Notified"],
  ["released", "Released"],
  ["done", "Recorded"],
];

let items = [];
let groups = [];   // Calling-to-Fill groupings: callingGroups/{id} { label, order }
let showDone = false;
let stakeOpen = false; // the Stake pop-up is showing (re-rendered on data changes)
let dragName = "";     // a person's name being dragged (needs-calling row) — for the Stake pill drop
let dragCard = null;   // a whole calling card being dragged (board) — dropping it on the pill makes it a stake calling
let started = false;

// legacy docs from the earlier pipeline get mapped into the new flow
function norm(d) {
  if (d.kind === "member" || d.kind === "release" || d.kind === "stake") return d; // stake callings have their own flow (2026-09-20)
  if (d.stage) {
    // older stage names fold into the current flow
    let stage = d.stage;
    let setApart = !!d.setApart;
    if (stage === "accepted" || stage === "called") stage = "sustain";
    else if (stage === "sustained") stage = "apart";
    else if (stage === "clerk" || stage === "setapart") { stage = "apart"; setApart = true; }
    if (stage === "fill" && d.decided) stage = "issue"; // a decided name moves forward
    return { kind: "calling", candidates: [], decided: "", ...d, stage, setApart };
  }
  const s = d.status || "considering";
  const stage = s === "considering" ? "fill"
    : s === "approved" ? "issue"
    : ["extended", "accepted"].includes(s) ? "sustain"
    : s === "sustained" ? "apart"
    : s === "setapart" ? "apart" : "done";
  return {
    ...d, kind: "calling", stage,
    candidates: d.candidate ? [d.candidate] : [],
    decided: (s !== "considering" && d.candidate) ? d.candidate : "",
    setApart: s === "setapart",
  };
}

export function initCallings() {
  if (started) return;
  started = true;
  const panel = document.getElementById("panel-callings");
  panel.innerHTML = `
    <div class="panel-head">
      <div>
        <h2>Callings</h2>
        <p class="panel-sub">Callings and releases, from consideration to the clerk's records.</p>
      </div>
      <div style="display:flex;gap:.5rem;flex-wrap:wrap;align-items:center">
        <button class="chip stake-chip" id="chip-stake" title="Stake callings — click to open; drop a name here to recommend them">Stake Callings <span class="pill pill-inprogress" id="stake-count">0</span></button>
        <button class="btn" id="btn-new-member">+ Needs a calling</button>
        <button class="btn" id="btn-new-release">+ New release</button>
        <button class="btn btn-primary" id="btn-new-calling">+ New calling</button>
      </div>
    </div>
    <div id="bishopric-buckets"></div>
    <div class="chips" style="margin-top:.6rem">
      <button class="chip" id="chip-done">Show archived</button>
    </div>
    <div class="card hidden" id="calling-done-card" style="margin-top:.6rem">
      <h3>Completed</h3>
      <div id="calling-done"></div>
    </div>`;

  panel.querySelector("#btn-new-calling").addEventListener("click", () => editCalling(null));
  panel.querySelector("#btn-new-release").addEventListener("click", () => editRelease(null));
  panel.querySelector("#btn-new-member").addEventListener("click", () => editMember(null));
  panel.querySelector("#chip-stake").addEventListener("click", () => openStake()); // pop-up list (2026-09-20)
  // drop a name on the pill → the pop-up opens with that name ready to recommend
  const chipStake = panel.querySelector("#chip-stake");
  chipStake.addEventListener("dragover", (e) => { if (!dragName && !dragCard) return; e.preventDefault(); chipStake.classList.add("drop-over"); });
  chipStake.addEventListener("dragleave", () => chipStake.classList.remove("drop-over"));
  chipStake.addEventListener("drop", async (e) => {
    if (!dragName && !dragCard) return;
    e.preventDefault(); chipStake.classList.remove("drop-over");
    if (dragCard) { // a whole calling card → becomes a stake calling, recommended (2026-09-20)
      const c = dragCard; dragCard = null;
      if (c.kind === "release") { toast("Releases don't go to the stake"); return; }
      const name = c.decided || (c.candidates || [])[0] || "";
      try {
        await updateDoc(doc(db, "callings", c.id), { kind: "stake", name, stage: "recommend", "stamps.recommend": serverTimestamp(), fromWardStage: c.stage || "", updatedAt: serverTimestamp() });
        await wardBusinessForget(c); // if it had already reached Ward Business
        toast(`${c.calling} moved to Stake Callings${name ? " — " + name : ""}`);
        openStake(name ? "" : "");
      } catch (err) { toast("Couldn't move: " + (err.code || err.message)); }
      return;
    }
    const n = dragName; dragName = ""; openStake(n);
  });
  panel.querySelector("#chip-done").addEventListener("click", (e) => {
    showDone = !showDone;
    e.target.classList.toggle("active", showDone);
    panel.querySelector("#calling-done-card").classList.toggle("hidden", !showDone);
    render();
  });

  // Stable order (2026-09-13): a manual `order` number first (set by drag
  // and drop), then creation time — NOT most-recently-edited, which made
  // cards jump around every time a name was added.
  onSnapshot(collection(db, "callingGroups"), (qs) => {
    groups = qs.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    render();
  });
  onSnapshot(collection(db, "callings"), (qs) => {
    items = qs.docs.map((d) => norm({ id: d.id, ...d.data() }));
    items.sort((a, b) => sortKey(a) - sortKey(b));
    render();
  });
}

const tsMs = (ts) => { const d = ts?.toDate?.() || (ts ? new Date(ts) : null); return d && !isNaN(d) ? d.getTime() : 0; };
const sortKey = (c) => (typeof c.order === "number" ? c.order : 1e15 + (tsMs(c.createdAt) || tsMs(c.stamps?.fill) || tsMs(c.updatedAt) || 0));

// After a drag: renumber every card in that column 0..n so the dropped one
// lands where it was let go. Only cards whose number changes are written.
async function reorderWithin(stage, draggedId, beforeId) {
  const dragged = items.find((c) => c.id === draggedId);
  if (!dragged) return;
  const col = items.filter((c) => (c.kind || "calling") === (dragged.kind || "calling") && c.stage === stage && c.id !== draggedId
    && (stage !== "fill" || (c.group || "") === (dragged.group || "")));
  const at = beforeId ? col.findIndex((c) => c.id === beforeId) : -1;
  if (at >= 0) col.splice(at, 0, dragged); else col.push(dragged);
  const writes = [];
  col.forEach((c, i) => { if (c.order !== i) { c.order = i; writes.push(updateDoc(doc(db, "callings", c.id), { order: i })); } });
  items.sort((a, b) => sortKey(a) - sortKey(b));
  render();
  await Promise.all(writes);
}

// every stage move gets stamped so you can see when it happened
// Keep the Sacrament tab's Ward Business in step with the calling flow (2026-09-13):
//  • reaching "Calls to Sustain" adds the sustaining to the next Sunday with a ward meeting
//  • falling back to Fill / Issue (or deleting the calling) takes it off every upcoming Sunday
const BACK_STAGES = ["fill", "issue"];
const ON_BUSINESS = ["sustain", "apart"];
const isCallingRec = (x) => x && (x.kind || "calling") === "calling";
async function wardBusinessSync(prev, upd) {
  try {
    const nextStage = upd?.stage;
    if (nextStage && BACK_STAGES.includes(nextStage) && isCallingRec(prev) && ON_BUSINESS.includes(prev.stage) && prev.decided) {
      const n = await removeSustaining(prev.decided, prev.calling);
      if (n) toast(`Removed from Ward Business (${n} Sunday${n === 1 ? "" : "s"})`);
    }
    if (nextStage === "sustain" && prev?.stage !== "sustain") {
      const name = upd.decided || prev?.decided;
      const calling = upd.calling ?? prev?.calling;
      if (name && isCallingRec({ ...prev, ...upd })) {
        const d = await addSustainingToNext(name, calling);
        if (d) toast(`Added to Ward Business for ${new Date(d + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })}`);
      }
    }
  } catch (e) { console.warn("[callings] ward business sync", e); }
}
// Deleting a calling that was already on Ward Business pulls it back off.
async function wardBusinessForget(prev) {
  if (!isCallingRec(prev) || !ON_BUSINESS.includes(prev.stage) || !prev.decided) return;
  try {
    const n = await removeSustaining(prev.decided, prev.calling);
    if (n) toast(`Removed from Ward Business (${n} Sunday${n === 1 ? "" : "s"})`);
  } catch (e) { console.warn("[callings] ward business forget", e); }
}

const save = async (id, data, prevSnap) => {
  // prevSnap: the record before the caller mutated it in place (drop handler)
  const prev = prevSnap || items.find((x) => x.id === id);
  const upd = { ...data, updatedAt: serverTimestamp() };
  if (upd.stage) upd["stamps." + upd.stage] = serverTimestamp();
  if (upd.setApart === true) upd["stamps.setApartDone"] = serverTimestamp();
  if (upd.mlsDone === true) upd["stamps.mlsDone"] = serverTimestamp();
  await updateDoc(doc(db, "callings", id), upd);
  await wardBusinessSync(prev, upd);
};
const fmtStamp = (ts) => {
  const d = ts?.toDate?.() || (ts ? new Date(ts) : null);
  return d && !isNaN(d) ? d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";
};
const stampLine = (label, ts) => {
  const f = fmtStamp(ts);
  return f ? `<div class="row-sub">${label} ${f}</div>` : "";
};
// date on the left, action button on the right, one line (2026-09-20)
const stampAction = (label, ts, actionHtml) => {
  const f = fmtStamp(ts);
  return `<div class="call-card-line"><span class="row-sub">${f ? `${label} ${f}` : ""}</span>${actionHtml}</div>`;
};

// ---- rows ----
// each calling gets a consistently colored pill so it's easy to single out;
// known organizations keep fixed colors, everything else hashes to one
const ORG_COLORS = {
  "relief society": "#cf6d96", "elders quorum": "#6b96c9", "primary": "#dd9257",
  "young men": "#74a67f", "young women": "#a37fc0", "sunday school": "#b98a2f",
  "bishopric": "#5b8fa8", "ward": "#5b8fa8",
};
const PILL_COLORS = ["#cf6d96", "#6b96c9", "#dd9257", "#74a67f", "#a37fc0", "#b98a2f", "#5b8fa8", "#c96b6b"];
const callColor = (label, orgKey) => {
  const key = (orgKey || label || "").toLowerCase().trim();
  let bg = ORG_COLORS[key];
  if (!bg) {
    let h = 0;
    for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    bg = PILL_COLORS[h % PILL_COLORS.length];
  }
  return bg;
};
// the whole card is one big tinted pill in the calling's color
const cardStyle = (label, orgKey) => {
  const col = callColor(label, orgKey);
  return `style="--col:${col};background:${col}22;border:1px solid ${col}55;border-left:5px solid ${col}" data-col="${col}"`;
};

const fillRow = (c) => {
  const cands = c.candidates || [];
  const sub = cands.length
    ? cands.map((n, i) => `<div class="cand-line"><span class="cand-x" data-rm="${i}" title="Remove ${esc(n)} from consideration">✕</span><span class="cand-name-txt">${esc(n)}</span><span class="cand-pick" data-star="${i}" title="Choose ${esc(n)} — the bishopric has settled on this name (moves to Calls to Issue)">○</span></div>`).join("")
    : "";
  // Inline add box (2026-09-13): type a name + Enter to add it to the
  // consideration list without opening the editor. The card itself still
  // opens the editor for starring / everything else.
  const addBox = `<input class="cand-add" data-addcand="${c.id}" placeholder="${cands.length ? "+ Add another name" : "+ Add a name to consider"}" autocomplete="off" aria-label="Add a name to consider for ${esc(c.calling)}">`;
  return `
  <div class="list-row call-card call-card-v" data-id="${c.id}" ${cardStyle(c.calling, c.organization)}>
    <div class="call-card-title" style="color:${callColor(c.calling, c.organization)}">${esc(c.calling)}${c.organization ? ` <span class="call-card-org">· ${esc(c.organization)}</span>` : ""}${delBtn(c)}</div>
    <div class="row-sub">${sub}${addBox}</div>
  </div>`;
};

// small ✕ in the title band deletes the calling (with a confirm) — 2026-09-20
const delBtn = (c) => `<span class="call-del" data-del="${c.id}" title="Delete this calling" role="button">✕</span>`;
const issueRow = (c) => `
  <div class="list-row call-card call-card-v" data-id="${c.id}" ${cardStyle(c.calling, c.organization)}>
    <div class="call-card-title" style="color:${callColor(c.calling, c.organization)}">${esc(c.calling)}${delBtn(c)}</div>
    <div class="row-title">${esc(c.decided || "—")}</div>
    ${stampAction("Decided", c.stamps?.issue, `<button class="btn btn-sm" data-adv="sustain" type="button" title="${esc(c.decided || "")} accepted the call">Accepted</button>`)}
  </div>`;

// Stake pop-up (2026-09-20): stake callings have their own two-step flow
// here — Recommended to Stake → Called — and archive once called. They
// never appear on the ward board.
function openStake(prefillName = "") {
  const stakes = items.filter((i) => i.kind === "stake" && i.stage !== "done");
  const rec = stakes.filter((c) => c.stage === "recommend"), called = stakes.filter((c) => c.stage === "called");
  const card = (c, action) => `
    <div class="list-row call-card call-card-v" data-id="${c.id}" ${cardStyle(c.calling, c.organization)}>
      <div class="call-card-title" style="color:${callColor(c.calling, c.organization)}">${esc(c.calling)}${c.organization ? ` <span class="call-card-org">· ${esc(c.organization)}</span>` : ""}<span class="call-del" data-sdel="${c.id}" title="Delete" role="button">✕</span></div>
      <div class="row-title">${esc(c.name || "—")}</div>
      ${action}
    </div>`;
  const el = openModal(`
    <h3 style="display:flex;align-items:center;gap:.5rem">Stake Callings <span class="pill ${stakes.length ? "pill-inprogress" : "pill-role-member"}">${stakes.length}</span></h3>
    <p class="row-sub" style="margin:0 0 .8rem">Recommend a name to the stake; mark it Called once the stake extends the call; archive when done.</p>
    <div class="mtg-sec-title">Recommended to Stake <span class="pill pill-role-member">${rec.length}</span></div>
    <div class="stake-list">${rec.length ? rec.map((c) => card(c, stampAction("Recommended", c.stamps?.recommend, `<span style="display:flex;gap:.35rem"><button class="btn btn-sm btn-ghost" data-sstage="done" data-outcome="notcalled" data-sid="${c.id}" type="button" title="The stake didn't extend the call — archive it">Not called</button><button class="btn btn-sm btn-primary" data-sstage="called" data-sid="${c.id}" type="button">Called →</button></span>`))).join("") : `<div class="empty-note">Nothing recommended yet.</div>`}</div>
    <div class="mtg-sec-title" style="margin-top:.9rem">Called <span class="pill pill-role-member">${called.length}</span></div>
    <div class="stake-list">${called.length ? called.map((c) => card(c, stampAction("Called", c.stamps?.called, `<span style="display:flex;gap:.35rem"><button class="btn btn-sm btn-ghost" data-sstage="recommend" data-sid="${c.id}" type="button" title="Back to Recommended">Back</button><button class="btn btn-sm" data-sstage="done" data-outcome="called" data-sid="${c.id}" type="button" title="Done — move to the archive">Archive</button></span>`))).join("") : `<div class="empty-note">No one called yet.</div>`}</div>
    <div class="mtg-sec-title" style="margin-top:.9rem">Recommend to the stake</div>
    <div class="form-grid">
      <label class="field"><span>Calling</span><input id="st-calling" placeholder="e.g. Stake Young Women Presidency" autocomplete="off"></label>
      <label class="field"><span>Organization <span class="row-sub">(optional)</span></span><input id="st-org" placeholder="e.g. Stake" autocomplete="off"></label>
      <label class="field full"><span>Name</span><input id="st-name" placeholder="Who you're recommending" autocomplete="off" list="dl-needy-st" value="${esc(prefillName)}"></label>
    </div>
    <datalist id="dl-needy-st">${items.filter((i) => i.kind === "member").map((p) => `<option value="${esc(p.name)}"></option>`).join("")}</datalist>
    <div class="modal-actions"><button class="btn btn-primary" id="st-add" type="button">Recommend</button><button class="btn" id="st-close" type="button">Close</button></div>`);
  stakeOpen = true;
  if (prefillName) setTimeout(() => el.querySelector("#st-calling")?.focus(), 30);
  const done = () => { stakeOpen = false; closeModal(); };
  el.querySelector("#st-close").addEventListener("click", done);
  el.querySelectorAll("[data-sstage]").forEach((b) => b.addEventListener("click", () => {
    const upd = { stage: b.dataset.sstage };
    if (b.dataset.outcome) upd.outcome = b.dataset.outcome; // "called" | "notcalled" — shown in the archive
    save(b.dataset.sid, upd);
    toast(b.dataset.outcome === "notcalled" ? "Archived as not called" : b.dataset.sstage === "done" ? "Archived" : b.dataset.sstage === "called" ? "Marked called" : "Moved back");
  }));
  el.querySelectorAll("[data-sdel]").forEach((b) => b.addEventListener("click", async () => {
    const c = items.find((x) => x.id === b.dataset.sdel);
    if (!c || !confirm(`Delete “${c.calling}”${c.name ? ` (${c.name})` : ""}?`)) return;
    await deleteDoc(doc(db, "callings", c.id)); toast("Deleted");
  }));
  const add = async () => {
    const calling = el.querySelector("#st-calling").value.trim();
    const name = el.querySelector("#st-name").value.trim();
    const organization = el.querySelector("#st-org").value.trim();
    if (!calling || !name) { toast("Enter the calling and the name"); return; }
    await addDoc(collection(db, "callings"), { kind: "stake", calling, organization, name, stage: "recommend", stamps: { recommend: new Date().toISOString() }, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
    toast(`${name} recommended for ${calling}`);
    ["st-calling", "st-org", "st-name"].forEach((id) => { const i = el.querySelector("#" + id); if (i) i.value = ""; });
    openStake(); // fresh list with the new recommendation
  };
  el.querySelector("#st-add").addEventListener("click", add);
  el.querySelectorAll("#st-calling, #st-org, #st-name").forEach((i) => i.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }));
}

const sustainRow = (c) => `
  <div class="list-row call-card call-card-v" data-id="${c.id}" ${cardStyle(c.calling, c.organization)}>
    <div class="call-card-title" style="color:${callColor(c.calling, c.organization)}">${esc(c.calling)}${delBtn(c)}</div>
    <div class="row-title">${esc(c.decided || "—")}</div>
    ${stampAction("Accepted", c.stamps?.sustain, `<button class="btn btn-sm" data-adv="apart" type="button">Sustained →</button>`)}
  </div>`;

const apartRow = (c) => `
  <div class="list-row call-card call-card-v" data-id="${c.id}" ${cardStyle(c.calling, c.organization)}>
    <div class="call-card-title" style="color:${callColor(c.calling, c.organization)}">${esc(c.calling)}${delBtn(c)}</div>
    <div class="row-title">${esc(c.decided || "—")}</div>
    ${stampLine("Sustained", c.stamps?.apart)}
    <div class="step-pills">
      <button class="step-pill${c.setApart ? " on" : ""}" data-toggle="setApart" type="button" title="${c.setApart ? "Set apart" + (c.stamps?.setApartDone ? " " + fmtStamp(c.stamps.setApartDone) : "") + " — click to undo" : "Click when set apart"}">${c.setApart ? "✓" : "○"} Set apart</button>
      <button class="step-pill${c.mlsDone ? " on" : ""}" data-toggle="mlsDone" type="button" title="${c.mlsDone ? "Updated in MLS" + (c.stamps?.mlsDone ? " " + fmtStamp(c.stamps.mlsDone) : "") + " — click to undo" : "Click when updated in MLS"}">${c.mlsDone ? "✓" : "○"} MLS</button>
    </div>
  </div>`;

// Release card in the three-column flow. Drag between columns; on the last
// column the MLS tick completes and archives it.
const releaseRow = (r) => `
  <div class="list-row call-card call-card-v" data-id="${r.id}" ${cardStyle(r.calling || r.name)}>
    ${r.calling ? `<div class="call-card-title" style="color:${callColor(r.calling)}">${esc(r.calling)}</div>` : ""}
    <div class="row-title">${esc(r.name)}</div>
    ${r.notes ? `<div class="row-sub">${esc(r.notes.slice(0, 90))}</div>` : ""}
    ${stampLine(REL_STAGES.find(([k]) => k === r.stage)?.[1] || "", r.stamps?.[r.stage])}
    ${r.stage === "released" ? `<div class="step-pills"><button class="step-pill" data-adv="done" type="button" title="Recorded in MLS — completes and archives this release">○ Updated in MLS</button></div>` : ""}
  </div>`;

// gender colours the "Needs calling" pill — blue for brothers, pink for
// sisters, amber when not set; click the pill to cycle it (2026-09-20)
const GENDER_PILL = { m: "pill-male", f: "pill-female" };
const memberRow = (p) => `
  <div class="list-row member-row" data-id="${p.id}" draggable="true" data-member="${p.id}" title="Drag onto a calling in Calling to Fill to add ${esc(p.name)} as a name to consider">
    <span class="cand-x member-x" data-rmmember="${p.id}" title="Remove ${esc(p.name)} from this list">✕</span>
    <div class="row-main">
      <div class="row-title">${esc(p.name)}</div>
      ${p.notes ? `<div class="row-sub">${esc(p.notes.slice(0, 90))}</div>` : ""}
    </div>
    <span class="pill ${GENDER_PILL[p.gender] || "pill-inprogress"} pill-gender" data-gender="${p.id}" title="${p.gender === "m" ? "Brother" : p.gender === "f" ? "Sister" : "Not set"} — click to change">Needs calling</span>
  </div>`;

// Archived (complete) callings + releases, with a "move back to…" so a
// mistake — or a calling that fell through — can rejoin the flow.
const CALL_BACK = [["fill", "Calling to Fill"], ["issue", "Calls to Issue"], ["sustain", "Calls to Sustain"], ["apart", "Set Apart & MLS"]];
// Stake callings (kind "stake") live only inside the Stake pop-up (2026-09-20):
//   recommend (Recommended to Stake) → called (Called) → done (archived)
const STAKE_STAGES = [["recommend", "Recommended to Stake"], ["called", "Called"]];
const STAKE_BACK = STAKE_STAGES;
const REL_BACK = [["decided", "Decided"], ["notified", "Notified"], ["released", "Released"]];
const doneRow = (it) => `
  <div class="list-row done-row" data-id="${it.id}">
    <div class="row-main">
      <div class="row-title">${it.kind === "release" ? `${esc(it.name)} — released` : it.kind === "stake" ? `${esc(it.name || "")} — ${esc(it.calling)} <span class="row-sub">(stake · ${it.outcome === "notcalled" ? "not called" : "called"})</span>` : `${esc(it.decided || "")} — ${esc(it.calling)}`}</div>
      ${stampLine("Completed", it.stamps?.done)}
    </div>
    <select class="done-back" data-id="${it.id}" title="Move this back into the flow">
      <option value="">Move back to…</option>
      ${(it.kind === "release" ? REL_BACK : it.kind === "stake" ? STAKE_BACK : CALL_BACK).map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}
    </select>
    <span class="pill pill-done">Archived</span>
  </div>`;

function render() {
  const wrap = document.getElementById("bishopric-buckets");
  if (!wrap) return;
  const callings = items.filter((i) => (i.kind || "calling") === "calling");
  const releases = items.filter((i) => i.kind === "release");
  const members = items.filter((i) => i.kind === "member");
  const by = (st) => callings.filter((c) => c.stage === st);

  const bucket = (title, sub, rows, empty, dropStage, addKind) => `
    <div class="card${dropStage ? " bb-col" : ""}" style="margin-top:.8rem">
      <h3 style="display:flex;align-items:center;gap:.5rem">${title} <span class="pill pill-role-member">${rows.length}</span>${addKind ? `<button class="btn btn-sm" data-add="${addKind}" type="button" style="margin-left:auto" title="Add">+</button>` : ""}</h3>
      <p class="row-sub" style="margin:0 0 .3rem">${sub}</p>
      <div${dropStage ? ` class="bb-drop" data-stage="${dropStage}"` : ""}>${rows.length ? rows.join("") : `<div class="empty-note">${empty}</div>`}</div>
    </div>`;

  // the calling flow reads left → right on desktop; drag a row to the next
  // column or use its arrow button
  // Calling to Fill can be split into named groupings (Primary, RS, Urgent…).
  // Each grouping is its own drop zone; ungrouped cards sit at the bottom.
  const fillCards = by("fill");
  const groupIds = new Set(groups.map((g) => g.id));
  const fillSection = (g) => {
    const rows = fillCards.filter((c) => (g ? c.group === g.id : !groupIds.has(c.group || "")));
    if (!g && !rows.length && groups.length) return ""; // hide an empty "Other"
    return `
      <div class="cg">
        ${g ? `<div class="cg-head" data-group="${g.id}" title="Click to rename or remove this grouping"><span>${esc(g.label)}</span><span class="pill pill-role-member">${rows.length}</span></div>`
            : (groups.length ? `<div class="cg-head cg-other"><span>Other</span><span class="pill pill-role-member">${rows.length}</span></div>` : "")}
        <div class="bb-drop cg-drop" data-stage="fill" data-group="${g ? g.id : ""}">${rows.length ? rows.map(fillRow).join("") : `<div class="empty-note cg-empty">Drag callings here</div>`}</div>
      </div>`;
  };
  const fillBody = `
    <div class="card bb-col" style="margin-top:.8rem">
      <h3 style="display:flex;align-items:center;gap:.5rem">Calling to Fill <span class="pill pill-role-member">${fillCards.length}</span>
        <span style="margin-left:auto;display:flex;gap:.3rem"><button class="btn btn-sm" data-add="group" type="button" title="New grouping (Primary, RS, Urgent…)">+ Group</button><button class="btn btn-sm" data-add="calling" type="button" title="Add a calling">+</button></span></h3>
      <p class="row-sub" style="margin:0 0 .3rem">Names under consideration — star one to decide.${groups.length ? " Drag a calling into a grouping." : ""}</p>
      ${fillCards.length || groups.length ? groups.map(fillSection).join("") + fillSection(null) : `<div class="bb-drop" data-stage="fill" data-group=""><div class="empty-note">Nothing waiting to be filled.</div></div>`}
    </div>`;
  wrap.innerHTML =
    `<div class="bishopric-board">` +
    fillBody +
    bucket("Calls to Issue", "Name decided — extend the call.",
      by("issue").map(issueRow), "No calls waiting to be issued.", "issue") +
    bucket("Calls to Sustain", "Accepted — present for sustaining.",
      by("sustain").map(sustainRow), "No one waiting to be sustained.", "sustain") +
    bucket("Set Apart & MLS", "Tick Set apart and MLS as each happens — when both are ticked the calling is complete and archives.",
      by("apart").map(apartRow), "No one waiting to be set apart.", "apart") +
    `</div>` +

    `<h3 style="margin:1.4rem 0 0;display:flex;align-items:center;gap:.5rem">Releases <span class="pill pill-role-member">${releases.filter((r) => r.stage !== "done").length}</span></h3>` +
    `<div class="bishopric-board releases-board">` +
    bucket("Decided", "Release decided — let them know.",
      releases.filter((r) => r.stage === "decided").map(releaseRow), "Nothing decided yet.", "decided", "release") + // + on the card itself (2026-09-13)
    bucket("Notified", "They know — release from the pulpit.",
      releases.filter((r) => r.stage === "notified").map(releaseRow), "No one waiting to be released.", "notified") +
    bucket("Released", "Released — tick MLS once the clerk has recorded it.",
      releases.filter((r) => r.stage === "released").map(releaseRow), "No one waiting on MLS.", "released") +
    `</div>` +
    `<div class="needy-wrap">` + // 2026-09-20 — a short list doesn't need the whole page width
    bucket("Members who need callings", "The pool to draw from as positions open up.",
      members.map(memberRow), "No one on the list.", null, "member") +
    `</div>`;

  const doneItems = [...callings.filter((c) => c.stage === "done"), ...releases.filter((r) => r.stage === "done"), ...items.filter((i) => i.kind === "stake" && i.stage === "done")]
    .sort((a, b) => tsMs(b.stamps?.done) - tsMs(a.stamps?.done));
  const doneList = document.getElementById("calling-done");
  if (doneList) doneList.innerHTML = doneItems.length ? doneItems.map(doneRow).join("") : `<div class="empty-note">Nothing archived yet.</div>`;
  if (stakeOpen && document.getElementById("st-close")) {
    const typing = ["st-calling", "st-org", "st-name"].some((id) => document.getElementById(id)?.value);
    if (!typing) openStake(); // keep the pop-up current (unless a recommendation is half-typed)
  } else stakeOpen = false;
  const stakeCount = document.getElementById("stake-count");
  if (stakeCount) {
    const n = items.filter((i) => i.kind === "stake" && i.stage !== "done").length;
    stakeCount.textContent = n; stakeCount.className = "pill " + (n ? "pill-inprogress" : "pill-role-member");
    document.getElementById("chip-stake")?.classList.toggle("has-active", n > 0); // black while anyone is in the flow
  }
  const chipDone = document.getElementById("chip-done");
  if (chipDone) chipDone.textContent = (showDone ? "Hide archived" : "Show archived") + (doneItems.length ? ` (${doneItems.length})` : "");
  // "Move back to…" on an archived row: rejoin the flow at the chosen stage.
  // Coming back into Set Apart & MLS clears the MLS tick so it doesn't
  // immediately re-complete.
  document.querySelectorAll("#calling-done .done-back").forEach((sel) => sel.addEventListener("change", async (e) => {
    e.stopPropagation();
    const st = sel.value; if (!st) return;
    const it = items.find((x) => x.id === sel.dataset.id); if (!it) return;
    const upd = { stage: st };
    if (it.kind !== "release" && it.kind !== "stake") {
      upd.mlsDone = false;
      if (st !== "apart") upd.setApart = false;
    }
    await save(it.id, upd);
    toast("Moved back to " + (sel.options[sel.selectedIndex].textContent));
  }));

  document.querySelectorAll("#panel-callings .list-row").forEach((row) => {
    const it = () => items.find((x) => x.id === row.dataset.id);
    row.addEventListener("click", (e) => {
      const t = e.target;
      const item = it();
      if (!item) return;
      if (t.classList.contains("cand-add")) { e.stopPropagation(); return; } // typing a name, not opening the editor
      if (t.dataset.rmmember) { // ✕ on a needs-calling row (2026-09-20)
        e.stopPropagation();
        if (!confirm(`Remove ${item.name} from the “needs a calling” list?`)) return;
        deleteDoc(doc(db, "callings", item.id)).then(() => toast("Removed")).catch((err) => toast("Couldn't remove: " + (err.code || err.message)));
        return;
      }
      if (t.dataset.gender) { // pill on a needs-calling row: cycle brother → sister → not set
        e.stopPropagation();
        const next = item.gender === "m" ? "f" : item.gender === "f" ? "" : "m";
        updateDoc(doc(db, "callings", item.id), { gender: next }).catch((err) => toast("Couldn't save: " + (err.code || err.message)));
        return;
      }
      if (t.dataset.del) { // ✕ in the title band: delete the calling (2026-09-20)
        e.stopPropagation();
        const who = item.decided ? ` (${item.decided})` : "";
        if (!confirm(`Delete “${item.calling}”${who}? This can't be undone.`)) return;
        deleteDoc(doc(db, "callings", item.id)).then(() => wardBusinessForget(item)).then(() => toast("Deleted"))
          .catch((err) => toast("Couldn't delete: " + (err.code || err.message)));
        return;
      }
      if (t.dataset.star != null && t.classList.contains("cand-pick")) { // ☆ on the card: settle on this name → Calls to Issue
        e.stopPropagation();
        const name = (item.candidates || [])[Number(t.dataset.star)];
        if (!name) return;
        save(item.id, { decided: name, stage: "issue" });
        toast(`${name} — call to issue`);
        return;
      }
      if (t.dataset.rm != null && t.classList.contains("cand-x")) { // ✕ a considered name
        e.stopPropagation();
        const cands = [...(item.candidates || [])];
        cands.splice(Number(t.dataset.rm), 1);
        save(item.id, { candidates: cands });
        return;
      }
      if (t.dataset.undecide) { // "Decided" pill → back to considering
        e.stopPropagation();
        save(item.id, { decided: "", stage: "fill" });
        return;
      }
      if (t.dataset.toggle) { // Set apart / MLS pills — independent ticks; both on = complete
        e.stopPropagation();
        const f = t.dataset.toggle;
        const next = { setApart: !!item.setApart, mlsDone: !!item.mlsDone };
        next[f] = !next[f];
        const upd = { setApart: next.setApart, mlsDone: next.mlsDone };
        if (next.setApart && next.mlsDone) upd.stage = "done";
        save(item.id, upd);
        return;
      }
      if (t.dataset.setapart) { // set apart done; still waiting on the clerk
        e.stopPropagation();
        save(item.id, { setApart: true });
        return;
      }
      if (t.dataset.adv) { // quick advance / step back to the named stage
        e.stopPropagation();
        const upd = { stage: t.dataset.adv };
        if (t.dataset.adv !== "fill" && !item.decided) { // leaving "fill" needs a name on the card
          const first = (item.candidates || [])[0];
          if (!first) { toast("Add a name first"); return; }
          upd.decided = first;
        }
        save(item.id, upd);
        return;
      }

      if (item.kind === "member") editMember(item);
      else if (item.kind === "release") editRelease(item);
      else editCalling(item);
    });
  });

  // inline "+ Add a name" boxes on Calling-to-Fill cards
  document.querySelectorAll("#panel-callings .cand-add").forEach((inp) => {
    const commit = async () => {
      const name = inp.value.trim();
      if (!name) return;
      const item = items.find((x) => x.id === inp.dataset.addcand);
      if (!item) return;
      const cands = [...(item.candidates || [])];
      if (cands.some((n) => n.toLowerCase() === name.toLowerCase())) { toast(`${name} is already on the list`); inp.value = ""; return; }
      cands.push(name);
      inp.value = "";
      inp.disabled = true;
      try { await save(item.id, { candidates: cands }); toast(`${name} added to ${item.calling}`); }
      finally { inp.disabled = false; }
      // re-render replaces the input; put the cursor back in the same card's box
      setTimeout(() => { const again = document.querySelector(`#panel-callings .cand-add[data-addcand="${item.id}"]`); if (again) again.focus(); }, 80);
    };
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); commit(); }
      if (e.key === "Escape") { inp.value = ""; inp.blur(); }
    });
    inp.addEventListener("blur", commit);
    inp.addEventListener("mousedown", (e) => e.stopPropagation());
    inp.addEventListener("dragstart", (e) => { e.preventDefault(); e.stopPropagation(); });
  });

  wrap.querySelectorAll(".cg-head[data-group]").forEach((h) => h.addEventListener("click", () => editGroup(groups.find((g) => g.id === h.dataset.group))));
  // "+" on a bucket header opens the matching creator
  document.querySelectorAll("#panel-callings [data-add]").forEach((b) =>
    b.addEventListener("click", (e) => {
      if (b.dataset.add === "group") { e.stopPropagation(); return editGroup(null); }
      e.stopPropagation();
      if (b.dataset.add === "calling") editCalling(null);
      else if (b.dataset.add === "release") editRelease(null);
      else editMember(null);
    }));

  // drag a "needs a calling" name onto a Calling to Fill card (2026-09-20):
  // the name joins that calling's list of names to consider
  let dragMember = null;
  document.querySelectorAll("#panel-callings .member-row").forEach((row) => {
    row.addEventListener("dragstart", (e) => {
      dragMember = items.find((x) => x.id === row.dataset.member) || null;
      dragName = dragMember?.name || "";
      e.dataTransfer.effectAllowed = "copy";
      try { e.dataTransfer.setData("text/plain", dragMember?.name || ""); } catch { /* older browsers */ }
    });
    row.addEventListener("dragend", () => {
      dragMember = null; dragName = "";
      document.querySelectorAll("#panel-callings .cand-target, #chip-stake.drop-over").forEach((r) => r.classList.remove("cand-target", "drop-over"));
    });
  });
  document.querySelectorAll('#panel-callings .bb-drop[data-stage="fill"] .list-row').forEach((card) => {
    card.addEventListener("dragover", (e) => {
      if (!dragMember) return;
      e.preventDefault(); e.stopPropagation();
      e.dataTransfer.dropEffect = "copy";
      card.classList.add("cand-target");
    });
    card.addEventListener("dragleave", () => card.classList.remove("cand-target"));
    card.addEventListener("drop", async (e) => {
      if (!dragMember) return;
      e.preventDefault(); e.stopPropagation();
      card.classList.remove("cand-target");
      const c = items.find((x) => x.id === card.dataset.id);
      const name = dragMember.name; dragMember = null;
      if (!c || !name) return;
      const cands = c.candidates || [];
      if (cands.some((n) => n.toLowerCase() === name.toLowerCase())) { toast(`${name} is already on ${c.calling}`); return; }
      await save(c.id, { candidates: [...cands, name] });
      toast(`${name} added to ${c.calling}`);
    });
  });

  // drag a calling row between the three flow columns
  let dragId = null;
  document.querySelectorAll("#panel-callings .bb-drop .list-row").forEach((row) => {
    row.draggable = true;
    row.addEventListener("dragstart", (e) => {
      dragId = row.dataset.id;
      dragCard = items.find((x) => x.id === dragId) || null;
      e.dataTransfer.effectAllowed = "move";
      try { e.dataTransfer.setData("text/plain", ""); } catch { /* older browsers */ }
    });
    row.addEventListener("dragend", () => {
      dragId = null; dragCard = null;
      document.querySelectorAll(".bb-drop").forEach((z) => z.classList.remove("bb-over"));
      document.getElementById("chip-stake")?.classList.remove("drop-over");
    });
  });
  // hovering a card shows a drop line above it (reorder target)
  const clearMarks = () => document.querySelectorAll("#panel-callings .bb-before").forEach((r) => r.classList.remove("bb-before"));
  document.querySelectorAll("#panel-callings .bb-drop .list-row").forEach((row) => {
    row.addEventListener("dragover", (e) => {
      if (!dragId || row.dataset.id === dragId) return;
      e.preventDefault();
      clearMarks();
      row.classList.add("bb-before");
    });
    row.addEventListener("dragleave", () => row.classList.remove("bb-before"));
  });
  document.querySelectorAll("#panel-callings .bb-drop").forEach((zone) => {
    zone.addEventListener("dragover", (e) => {
      if (!dragId) return;
      e.preventDefault();
      zone.classList.add("bb-over");
    });
    zone.addEventListener("dragleave", () => zone.classList.remove("bb-over"));
    zone.addEventListener("drop", async (e) => {
      e.preventDefault();
      zone.classList.remove("bb-over");
      const targetRow = e.target.closest(".list-row");
      const beforeId = targetRow && targetRow.dataset.id !== dragId ? targetRow.dataset.id : null;
      clearMarks();
      const it = items.find((x) => x.id === dragId);
      dragId = null;
      if (!it || (it.kind !== "calling" && it.kind !== "release")) return;
      const st = zone.dataset.stage;
      if (!st) return;
      if (it.kind === "release") { // releases flow: decided → notified → released (MLS tick archives)
        if (!["decided", "notified", "released"].includes(st)) return;
        if (st === it.stage) { reorderWithin(st, it.id, beforeId); return; }
        it.stage = st;
        save(it.id, { stage: st }).then(() => reorderWithin(st, it.id, beforeId));
        return;
      }
      const g = zone.dataset.group ?? "";
      if (st === "fill" && (it.group || "") !== g) { it.group = g; await save(it.id, { group: g }); } // dropped into a grouping
      if (st === it.stage) { reorderWithin(st, it.id, beforeId); return; } // same column = reorder
      if (st !== "fill" && !it.decided && !(it.candidates || [])[0]) {
        toast("Add a name (and star it) before moving this forward");
        return;
      }
      const upd = { stage: st };
      if (st === "fill") upd.decided = ""; // dragged back = reconsidering
      else if (!it.decided) upd.decided = (it.candidates || [])[0];
      const before = { ...it }; // ward-business sync needs the pre-drag stage
      it.stage = st;
      save(it.id, upd, before).then(() => reorderWithin(st, it.id, beforeId));
    });
  });
}

// ---- Calling-to-Fill groupings ----
function editGroup(g) {
  const isNew = !g;
  const count = g ? items.filter((c) => c.group === g.id).length : 0;
  const el = openModal(`
    <h3>${isNew ? "New grouping" : "Grouping"}</h3>
    <p class="row-sub" style="margin:0 0 .8rem">A heading inside Calling to Fill — e.g. Primary, Relief Society, Urgent. Drag callings into it.</p>
    <div class="form-grid">
      <label class="field"><span>Title</span><input id="cg-label" value="${esc(g?.label || "")}" placeholder="e.g. Urgent" autocomplete="off"></label>
      ${!isNew && groups.length > 1 ? `<label class="field"><span>Position</span><select id="cg-pos">${groups.map((x, i) => `<option value="${i}" ${x.id === g.id ? "selected" : ""}>${i + 1}${x.id === g.id ? " (current)" : " — before " + esc(x.label)}</option>`).join("")}</select></label>` : ""}
    </div>
    <div class="modal-actions">
      ${!isNew ? `<button class="btn btn-ghost btn-danger" id="cg-del">Remove grouping</button>` : "<span></span>"}
      <div style="display:flex;gap:.5rem"><button class="btn" id="cg-cancel">Cancel</button><button class="btn btn-primary" id="cg-save">${isNew ? "Add" : "Save"}</button></div>
    </div>`);
  setTimeout(() => el.querySelector("#cg-label").select(), 30);
  el.querySelector("#cg-cancel").addEventListener("click", closeModal);
  el.querySelector("#cg-del")?.addEventListener("click", async () => {
    if (!confirm(`Remove “${g.label}”?${count ? ` Its ${count} calling${count === 1 ? "" : "s"} will move to Other.` : ""}`)) return;
    await deleteDoc(doc(db, "callingGroups", g.id));
    await Promise.all(items.filter((c) => c.group === g.id).map((c) => updateDoc(doc(db, "callings", c.id), { group: "" })));
    toast("Grouping removed"); closeModal();
  });
  const save_ = async () => {
    const label = el.querySelector("#cg-label").value.trim();
    if (!label) { toast("Give it a title"); return; }
    try {
      if (isNew) {
        await addDoc(collection(db, "callingGroups"), { label, order: groups.length, createdAt: serverTimestamp() });
      } else {
        const pos = el.querySelector("#cg-pos"); const idx = groups.findIndex((x) => x.id === g.id);
        const newPos = pos ? Number(pos.value) : idx;
        const list = groups.filter((x) => x.id !== g.id); list.splice(Math.min(newPos, list.length), 0, { ...g, label });
        await Promise.all(list.map((x, i) => updateDoc(doc(db, "callingGroups", x.id), x.id === g.id ? { label, order: i } : { order: i })));
      }
      toast("Saved"); closeModal();
    } catch (e) { toast("Couldn't save: " + (e.code || e.message)); }
  };
  el.querySelector("#cg-save").addEventListener("click", save_);
  el.querySelector("#cg-label").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); save_(); } });
}

// ---- editors ----
function editCalling(c) {
  const isNew = !c;
  const needy = items.filter((i) => i.kind === "member");
  const cands = (c?.candidates || []).length ? [...c.candidates] : [""];
  const candRow = (n) => `
    <div class="speaker-row cand-row">
      <button class="btn btn-sm cand-star${n && n === c?.decided ? " cand-decided" : ""}" type="button" title="Mark as the name the bishopric settled on">★</button>
      <input class="cand-name" list="dl-needy" autocomplete="off" placeholder="Name" value="${esc(n)}">
      <button class="btn btn-sm cand-del" type="button" title="Remove this name">✕</button>
    </div>`;
  const el = openModal(`
    <h3>${isNew ? "New calling" : "Edit calling"}</h3>
    <div class="form-grid two-col">
      <label class="field">Calling
        <input id="cl-calling" placeholder="e.g. Primary teacher" value="${esc(c?.calling || "")}">
      </label>
      <label class="field">Organization
        <input id="cl-org" placeholder="e.g. Primary" value="${esc(c?.organization || "")}">
      </label>
    </div>
    <div class="row-sub" style="margin:.8rem 0 .3rem;font-weight:700">Names being considered <span style="font-weight:400">· ★ = settled on</span></div>
    <div id="cand-rows">${cands.map(candRow).join("")}</div>
    <button class="btn btn-sm" id="cand-add" type="button">+ Add a name</button>
    <label class="field" style="margin-top:.8rem">Stage
      <select id="cl-stage">${CALL_STAGES.map(([k, l]) => `<option value="${k}" ${(c?.stage || "fill") === k ? "selected" : ""}>${l}</option>`).join("")}</select>
    </label>
    <label class="field" style="margin-top:.6rem">Notes
      <textarea id="cl-notes">${esc(c?.notes || "")}</textarea>
    </label>
    <datalist id="dl-needy">${needy.map((p) => `<option value="${esc(p.name)}"></option>`).join("")}</datalist>
    <div class="modal-actions">
      ${!isNew ? `<button class="btn btn-ghost btn-danger" id="cl-delete">Delete</button>` : ""}
      <div class="right">
        <button class="btn" id="cl-cancel">Cancel</button>
        <button class="btn btn-primary" id="cl-save">Save</button>
      </div>
    </div>`);
  el.addEventListener("click", (e) => {
    if (e.target.id === "cand-add") {
      el.querySelector("#cand-rows").insertAdjacentHTML("beforeend", candRow(""));
      el.querySelector("#cand-rows .cand-row:last-child .cand-name")?.focus();
    }
    if (e.target.classList.contains("cand-del")) e.target.closest(".cand-row").remove();
    if (e.target.classList.contains("cand-star")) {
      const was = e.target.classList.contains("cand-decided");
      el.querySelectorAll(".cand-star").forEach((s) => s.classList.remove("cand-decided"));
      if (!was) e.target.classList.add("cand-decided"); // click again to un-decide
    }
  });
  el.querySelector("#cl-cancel").addEventListener("click", closeModal);
  el.querySelector("#cl-delete")?.addEventListener("click", async () => {
    if (!confirm("Delete this calling?")) return;
    await deleteDoc(doc(db, "callings", c.id));
    await wardBusinessForget(c);
    closeModal(); toast("Deleted");
  });
  el.querySelector("#cl-save").addEventListener("click", async () => {
    const calling = el.querySelector("#cl-calling").value.trim();
    if (!calling) { toast("Calling needs a name"); return; }
    const rows = [...el.querySelectorAll(".cand-row")];
    const candidates = rows.map((r) => r.querySelector(".cand-name").value.trim()).filter(Boolean);
    const starRow = rows.find((r) => r.querySelector(".cand-star").classList.contains("cand-decided"));
    const decided = starRow ? starRow.querySelector(".cand-name").value.trim() : "";
    let stage = el.querySelector("#cl-stage").value;
    if (stage === "fill" && decided) stage = "issue";   // decided moves it forward
    if (stage === "issue" && !decided) stage = "fill";  // un-starred moves it back
    const data = {
      kind: "calling",
      calling,
      organization: el.querySelector("#cl-org").value.trim(),
      candidates,
      decided,
      stage,
      setApart: c?.setApart || false,
      notes: el.querySelector("#cl-notes").value.trim(),
      updatedAt: serverTimestamp(),
    };
    try {
      if (isNew) await addDoc(collection(db, "callings"), { ...data, stamps: { [data.stage]: new Date().toISOString() }, createdAt: serverTimestamp() });
      else {
        if (data.stage !== c.stage) data["stamps." + data.stage] = serverTimestamp();
        await updateDoc(doc(db, "callings", c.id), data);
        await wardBusinessSync(c, data);
      }
      const matched = decided && needy.find((p) => p.name.toLowerCase() === decided.toLowerCase());
      if (matched && data.stage !== "fill" && confirm(`Remove ${matched.name} from the "needs a calling" pool?`)) {
        await deleteDoc(doc(db, "callings", matched.id));
      }
      closeModal(); toast("Saved");
    } catch (err) { toast("Couldn't save: " + (err.code || err.message)); }
  });
}

function editRelease(r) {
  const isNew = !r;
  const el = openModal(`
    <h3>${isNew ? "New release" : "Edit release"}</h3>
    <div class="form-grid two-col">
      <label class="field">Member
        <input id="rl-name" value="${esc(r?.name || "")}">
      </label>
      <label class="field">Current calling
        <input id="rl-calling" placeholder="What they're being released from" value="${esc(r?.calling || "")}">
      </label>
      <label class="field">Stage
        <select id="rl-stage">${REL_STAGES.map(([k, l]) => `<option value="${k}" ${(r?.stage || "decided") === k ? "selected" : ""}>${l}</option>`).join("")}</select>
      </label>
      <label class="field full">Notes
        <textarea id="rl-notes">${esc(r?.notes || "")}</textarea>
      </label>
    </div>
    <div class="modal-actions">
      ${!isNew ? `<button class="btn btn-ghost btn-danger" id="rl-delete">Delete</button>` : ""}
      <div class="right">
        <button class="btn" id="rl-cancel">Cancel</button>
        <button class="btn btn-primary" id="rl-save">Save</button>
      </div>
    </div>`);
  el.querySelector("#rl-cancel").addEventListener("click", closeModal);
  el.querySelector("#rl-delete")?.addEventListener("click", async () => {
    if (!confirm("Delete this release?")) return;
    await deleteDoc(doc(db, "callings", r.id));
    closeModal(); toast("Deleted");
  });
  el.querySelector("#rl-save").addEventListener("click", async () => {
    const name = el.querySelector("#rl-name").value.trim();
    if (!name) { toast("Member name is required"); return; }
    const data = {
      kind: "release",
      name,
      calling: el.querySelector("#rl-calling").value.trim(),
      stage: el.querySelector("#rl-stage").value,
      notes: el.querySelector("#rl-notes").value.trim(),
      updatedAt: serverTimestamp(),
    };
    try {
      if (isNew) await addDoc(collection(db, "callings"), { ...data, stamps: { [data.stage]: new Date().toISOString() }, createdAt: serverTimestamp() });
      else {
        if (data.stage !== r.stage) data["stamps." + data.stage] = serverTimestamp();
        await updateDoc(doc(db, "callings", r.id), data);
      }
      closeModal(); toast("Saved");
    } catch (err) { toast("Couldn't save: " + (err.code || err.message)); }
  });
}

function editMember(p) {
  const isNew = !p;
  const el = openModal(`
    <h3>${isNew ? "Member needing a calling" : "Edit member"}</h3>
    <label class="field">Name
      <input id="nm-name" value="${esc(p?.name || "")}">
    </label>
    <div class="field" style="margin-top:.6rem"><span>Brother or sister <span class="row-sub">(colours the pill)</span></span>
      <div class="chips" style="margin-top:.3rem">
        <button type="button" class="chip nm-gender${(p?.gender || "") === "m" ? " active" : ""}" data-g="m">Brother</button>
        <button type="button" class="chip nm-gender${(p?.gender || "") === "f" ? " active" : ""}" data-g="f">Sister</button>
        <button type="button" class="chip nm-gender${!p?.gender ? " active" : ""}" data-g="">Not set</button>
      </div>
    </div>
    <label class="field" style="margin-top:.6rem">Notes <span style="font-weight:400">(interests, availability, ideas…)</span>
      <textarea id="nm-notes">${esc(p?.notes || "")}</textarea>
    </label>
    <div class="modal-actions">
      ${!isNew ? `<button class="btn btn-ghost btn-danger" id="nm-delete">Remove from list</button>` : ""}
      <div class="right">
        <button class="btn" id="nm-cancel">Cancel</button>
        <button class="btn btn-primary" id="nm-save">Save</button>
      </div>
    </div>`);
  el.querySelector("#nm-cancel").addEventListener("click", closeModal);
  el.querySelectorAll(".nm-gender").forEach((b) => b.addEventListener("click", () => el.querySelectorAll(".nm-gender").forEach((x) => x.classList.toggle("active", x === b))));
  el.querySelector("#nm-delete")?.addEventListener("click", async () => {
    await deleteDoc(doc(db, "callings", p.id));
    closeModal(); toast("Removed");
  });
  el.querySelector("#nm-save").addEventListener("click", async () => {
    const name = el.querySelector("#nm-name").value.trim();
    if (!name) { toast("Name is required"); return; }
    const data = {
      kind: "member",
      name,
      gender: el.querySelector(".nm-gender.active")?.dataset.g || "",
      notes: el.querySelector("#nm-notes").value.trim(),
      updatedAt: serverTimestamp(),
    };
    try {
      if (isNew) await addDoc(collection(db, "callings"), { ...data, createdAt: serverTimestamp() });
      else await updateDoc(doc(db, "callings", p.id), data);
      closeModal(); toast("Saved");
    } catch (err) { toast("Couldn't save: " + (err.code || err.message)); }
  });
}
