// Ward Council — the agenda for the next council meeting. Anything on a
// Member Board card's to-do marked "Ward council" shows here, grouped by
// person, until it's ticked as discussed (it stays a to-do on the card) or
// completed. Reads/writes the same `board` documents.
import { db } from "./firebase-init.js?v=1789348771";
import { ctx, can } from "./app.js?v=1789348771";
import {
  collection, onSnapshot, updateDoc, doc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { toast, esc, fmtDate } from "./ui.js?v=1789348771";

let cards = [];
let started = false;
let showHistory = false;

export function initCouncil() {
  if (started) return;
  started = true;
  const panel = document.getElementById("panel-council");
  panel.innerHTML = `
    <div class="panel-head">
      <div>
        <h2>Ward Council</h2>
        <p class="panel-sub">Items flagged “Ward council” on the Member Board, ready for the next meeting.</p>
      </div>
      <button class="btn" id="wc-history">Show discussed</button>
    </div>
    <div id="wc-body"><div class="empty-note">Loading…</div></div>`;
  panel.querySelector("#wc-history").addEventListener("click", (e) => { showHistory = !showHistory; e.target.textContent = showHistory ? "Hide discussed" : "Show discussed"; render(); });
  onSnapshot(collection(db, "board"), (qs) => {
    cards = qs.docs.map((d) => ({ id: d.id, ...d.data() }));
    cards.sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
    render();
  });
}

const fmtDay = (iso) => (iso ? fmtDate(String(iso).slice(0, 10), { year: true }) : "");

function render() {
  const body = document.getElementById("wc-body");
  if (!body) return;
  const editor = can("board", "edit");
  const agenda = [];
  const history = [];
  cards.forEach((k) => (k.todos || []).forEach((t) => {
    if (t.council && !t.done) agenda.push({ k, t });
    else if (t.councilDiscussedAt) history.push({ k, t });
  }));
  history.sort((a, b) => String(b.t.councilDiscussedAt).localeCompare(String(a.t.councilDiscussedAt)));

  const row = ({ k, t }, done) => `
    <div class="wc-row${done ? " wc-done" : ""}" data-card="${k.id}" data-todo="${t.id}">
      <div class="wc-main">
        <div class="wc-title">${esc(t.title)}${t.due ? `<span class="wc-due">${done ? "" : "due "}${fmtDay(t.due)}</span>` : ""}</div>
        ${t.notes ? `<div class="wc-notes">${esc(t.notes)}</div>` : ""}
        ${editor || t.councilNotes ? `<div class="wc-cnotes${t.councilNotes ? "" : " wc-cnotes-empty"}${editor ? " wc-cnotes-edit" : ""}" data-cnotes="1" title="${editor ? "Click to add council notes" : ""}">${t.councilNotes ? esc(t.councilNotes) : "+ council notes"}</div>` : ""}
        ${done ? `<div class="row-sub">Discussed ${fmtDay(t.councilDiscussedAt)}${t.councilDiscussedBy ? " · " + esc(t.councilDiscussedBy) : ""}</div>` : (t.councilAddedAt ? `<div class="row-sub">Added ${fmtDay(t.councilAddedAt)}</div>` : "")}
      </div>
      ${editor && !done ? `<div class="wc-actions"><button class="btn btn-sm" data-act="discussed" title="Discussed at council — keeps the to-do on the card">Discussed ✓</button><button class="btn btn-sm btn-ghost" data-act="remove" title="Take off the agenda without discussing">Remove</button></div>` : ""}
      ${editor && done ? `<div class="wc-actions"><button class="btn btn-sm btn-ghost" data-act="again" title="Put it back on the next agenda">↩ Again</button></div>` : ""}
    </div>`;

  const groups = (list) => {
    const by = new Map();
    list.forEach((x) => { if (!by.has(x.k.id)) by.set(x.k.id, { k: x.k, items: [] }); by.get(x.k.id).items.push(x); });
    return [...by.values()];
  };

  body.innerHTML = `
    <div class="card">
      <h3 style="margin:0 0 .2rem;display:flex;align-items:center;gap:.5rem">Next council <span class="pill ${agenda.length ? "pill-approved" : "pill-done"}">${agenda.length}</span>
        <span class="row-sub" style="font-weight:400;margin-left:auto">${new Date().toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })}</span></h3>
      ${agenda.length ? groups(agenda).map((g) => `
        <div class="wc-person">
          <div class="wc-name">${esc(g.k.name || "—")}</div>
          ${g.items.map((x) => row(x, false)).join("")}
        </div>`).join("") : `<div class="empty-note">Nothing flagged yet. On the Member Board, open a to-do and press “Ward council”.</div>`}
    </div>
    ${showHistory ? `<div class="card" style="margin-top:.8rem">
      <h3 style="margin:0 0 .4rem">Discussed <span class="pill pill-role-member">${history.length}</span></h3>
      ${history.length ? history.map((x) => `<div class="wc-person"><div class="wc-name">${esc(x.k.name || "—")}</div>${row(x, true)}</div>`).join("") : `<div class="empty-note">Nothing discussed yet.</div>`}
    </div>` : ""}`;

  if (!editor) return;
  // council notes: click to type, blur / ⌘Enter saves, Esc cancels
  body.querySelectorAll(".wc-row [data-cnotes]").forEach((el) => el.addEventListener("click", () => {
    const rowEl = el.closest(".wc-row");
    if (rowEl.querySelector("textarea")) return;
    const k = cards.find((x) => x.id === rowEl.dataset.card); if (!k) return;
    const t0 = (k.todos || []).find((x) => x.id === rowEl.dataset.todo); if (!t0) return;
    const ta = document.createElement("textarea");
    ta.className = "wc-cnotes-ta";
    ta.value = t0.councilNotes || "";
    ta.placeholder = "Notes from the discussion, decisions, who's following up…";
    el.replaceWith(ta);
    const grow = () => { ta.style.height = "auto"; ta.style.height = Math.max(56, ta.scrollHeight + 2) + "px"; };
    grow(); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
    let done = false;
    const finish = async (save) => {
      if (done) return; done = true;
      const val = ta.value.trim();
      if (save && val !== (t0.councilNotes || "")) {
        const todos = (k.todos || []).map((t) => (t.id === t0.id ? { ...t, councilNotes: val } : t));
        try { await updateDoc(doc(db, "board", k.id), { todos, updatedAt: serverTimestamp() }); toast("Saved"); }
        catch (e) { toast("Couldn't save: " + (e.code || e.message)); }
      }
      render();
    };
    ta.addEventListener("input", grow);
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); finish(false); }
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); finish(true); }
    });
    ta.addEventListener("blur", () => setTimeout(() => finish(true), 80));
  }));
  body.querySelectorAll(".wc-row [data-act]").forEach((b) => b.addEventListener("click", async () => {
    const rowEl = b.closest(".wc-row");
    const k = cards.find((x) => x.id === rowEl.dataset.card); if (!k) return;
    const todos = (k.todos || []).map((t) => ({ ...t }));
    const t = todos.find((x) => x.id === rowEl.dataset.todo); if (!t) return;
    const act = b.dataset.act;
    if (act === "discussed") { t.council = false; t.councilDiscussedAt = new Date().toISOString(); t.councilDiscussedBy = ctx.name || ""; }
    else if (act === "remove") { t.council = false; }
    else if (act === "again") { t.council = true; t.councilAddedAt = new Date().toISOString(); }
    try { await updateDoc(doc(db, "board", k.id), { todos, updatedAt: serverTimestamp() }); toast(act === "discussed" ? "Marked discussed" : act === "again" ? "Back on the agenda" : "Removed from agenda"); }
    catch (e) { toast("Couldn't save: " + (e.code || e.message)); }
  }));
}
