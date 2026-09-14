// Bishopric tab (bishopric+): the callings flow.
//   1. Callings to Fill — names under consideration; mark the settled name
//   2. Call issued & accepted — awaiting sustaining and setting apart
//   3. Sustained & set apart — waiting to be updated in MLS (two clicks: set apart, then MLS → complete)
//   4. Complete
// Releases run a parallel flow: decided → notified → released → recorded.
// Plus a standing pool of members who need callings.
import { db } from "./firebase-init.js?v=1789346419";
import {
  collection, query, orderBy, onSnapshot, addDoc, updateDoc, deleteDoc, doc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { openModal, closeModal, toast, esc } from "./ui.js?v=1789346419";

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
let started = false;

// legacy docs from the earlier pipeline get mapped into the new flow
function norm(d) {
  if (d.kind === "member" || d.kind === "release") return d;
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
        <h2>Bishopric</h2>
        <p class="panel-sub">Callings and releases, from consideration to the clerk's records.</p>
      </div>
      <div style="display:flex;gap:.5rem;flex-wrap:wrap">
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
const save = (id, data) => {
  const upd = { ...data, updatedAt: serverTimestamp() };
  if (upd.stage) upd["stamps." + upd.stage] = serverTimestamp();
  if (upd.setApart === true) upd["stamps.setApartDone"] = serverTimestamp();
  if (upd.mlsDone === true) upd["stamps.mlsDone"] = serverTimestamp();
  return updateDoc(doc(db, "callings", id), upd);
};
const fmtStamp = (ts) => {
  const d = ts?.toDate?.() || (ts ? new Date(ts) : null);
  return d && !isNaN(d) ? d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";
};
const stampLine = (label, ts) => {
  const f = fmtStamp(ts);
  return f ? `<div class="row-sub">${label} ${f}</div>` : "";
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
  return `style="background:${col}22;border:1px solid ${col}55;border-left:5px solid ${col}" data-col="${col}"`;
};

const fillRow = (c) => {
  const cands = c.candidates || [];
  const sub = cands.length
    ? cands.map((n, i) => `<div class="cand-line"><span class="cand-star-i" data-star="${i}" title="Star ${esc(n)} — the bishopric has settled on this name (moves to Calls to Issue)">☆</span>${esc(n)} <span class="cand-x" data-rm="${i}" title="Remove ${esc(n)} from consideration">✕</span></div>`).join("")
    : "";
  // Inline add box (2026-09-13): type a name + Enter to add it to the
  // consideration list without opening the editor. The card itself still
  // opens the editor for starring / everything else.
  const addBox = `<input class="cand-add" data-addcand="${c.id}" placeholder="${cands.length ? "+ Add another name" : "+ Add a name to consider"}" autocomplete="off" aria-label="Add a name to consider for ${esc(c.calling)}">`;
  return `
  <div class="list-row call-card call-card-v" data-id="${c.id}" ${cardStyle(c.calling, c.organization)}>
    <div class="call-card-title" style="color:${callColor(c.calling, c.organization)}">${esc(c.calling)}${c.organization ? ` <span class="call-card-org">· ${esc(c.organization)}</span>` : ""}</div>
    <div class="row-sub">${sub}${addBox}</div>
  </div>`;
};

const issueRow = (c) => `
  <div class="list-row call-card call-card-v" data-id="${c.id}" ${cardStyle(c.calling, c.organization)}>
    <div class="call-card-title" style="color:${callColor(c.calling, c.organization)}">${esc(c.calling)}</div>
    <div class="row-title">${esc(c.decided || "—")}</div>
    ${stampLine("Decided", c.stamps?.issue)}
    <div class="call-card-actions"><button class="btn btn-sm" data-adv="sustain" type="button" title="${esc(c.decided || "")} accepted the call">Accepted</button></div>
  </div>`;

const sustainRow = (c) => `
  <div class="list-row call-card call-card-v" data-id="${c.id}" ${cardStyle(c.calling, c.organization)}>
    <div class="call-card-title" style="color:${callColor(c.calling, c.organization)}">${esc(c.calling)}</div>
    <div class="row-title">${esc(c.decided || "—")}</div>
    ${stampLine("Accepted", c.stamps?.sustain)}
    <div class="call-card-actions"><button class="btn btn-sm" data-adv="apart" type="button">Sustained →</button></div>
  </div>`;

const apartRow = (c) => `
  <div class="list-row call-card call-card-v" data-id="${c.id}" ${cardStyle(c.calling, c.organization)}>
    <div class="call-card-title" style="color:${callColor(c.calling, c.organization)}">${esc(c.calling)}</div>
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

const memberRow = (p) => `
  <div class="list-row" data-id="${p.id}">
    <div class="row-main">
      <div class="row-title">${esc(p.name)}</div>
      ${p.notes ? `<div class="row-sub">${esc(p.notes.slice(0, 90))}</div>` : ""}
    </div>
    <span class="pill pill-inprogress">Needs calling</span>
  </div>`;

// Archived (complete) callings + releases, with a "move back to…" so a
// mistake — or a calling that fell through — can rejoin the flow.
const CALL_BACK = [["fill", "Calling to Fill"], ["issue", "Calls to Issue"], ["sustain", "Calls to Sustain"], ["apart", "Set Apart & MLS"]];
const REL_BACK = [["decided", "Decided"], ["notified", "Notified"], ["released", "Released"]];
const doneRow = (it) => `
  <div class="list-row done-row" data-id="${it.id}">
    <div class="row-main">
      <div class="row-title">${it.kind === "release" ? `${esc(it.name)} — released` : `${esc(it.decided || "")} — ${esc(it.calling)}`}</div>
      ${stampLine("Completed", it.stamps?.done)}
    </div>
    <select class="done-back" data-id="${it.id}" title="Move this back into the flow">
      <option value="">Move back to…</option>
      ${(it.kind === "release" ? REL_BACK : CALL_BACK).map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}
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
    `<h3 style="margin:1.4rem 0 0;display:flex;align-items:center;gap:.5rem">Releases <span class="pill pill-role-member">${releases.filter((r) => r.stage !== "done").length}</span><button class="btn btn-sm" data-add="release" type="button" style="margin-left:auto" title="New release">+</button></h3>` +
    `<div class="bishopric-board releases-board">` +
    bucket("Decided", "Release decided — let them know.",
      releases.filter((r) => r.stage === "decided").map(releaseRow), "Nothing decided yet.", "decided") +
    bucket("Notified", "They know — release from the pulpit.",
      releases.filter((r) => r.stage === "notified").map(releaseRow), "No one waiting to be released.", "notified") +
    bucket("Released", "Released — tick MLS once the clerk has recorded it.",
      releases.filter((r) => r.stage === "released").map(releaseRow), "No one waiting on MLS.", "released") +
    `</div>` +
    bucket("Members who need callings", "The pool to draw from as positions open up.",
      members.map(memberRow), "No one on the list.", null, "member");

  const doneItems = [...callings.filter((c) => c.stage === "done"), ...releases.filter((r) => r.stage === "done")]
    .sort((a, b) => tsMs(b.stamps?.done) - tsMs(a.stamps?.done));
  const doneList = document.getElementById("calling-done");
  if (doneList) doneList.innerHTML = doneItems.length ? doneItems.map(doneRow).join("") : `<div class="empty-note">Nothing archived yet.</div>`;
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
    if (it.kind !== "release") {
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
      if (t.dataset.star != null && t.classList.contains("cand-star-i")) { // ☆ on the card: settle on this name → Calls to Issue
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

  // drag a calling row between the three flow columns
  let dragId = null;
  document.querySelectorAll("#panel-callings .bb-drop .list-row").forEach((row) => {
    row.draggable = true;
    row.addEventListener("dragstart", (e) => {
      dragId = row.dataset.id;
      e.dataTransfer.effectAllowed = "move";
      try { e.dataTransfer.setData("text/plain", ""); } catch { /* older browsers */ }
    });
    row.addEventListener("dragend", () => {
      dragId = null;
      document.querySelectorAll(".bb-drop").forEach((z) => z.classList.remove("bb-over"));
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
      it.stage = st;
      save(it.id, upd).then(() => reorderWithin(st, it.id, beforeId));
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
