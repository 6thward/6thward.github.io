// Light list formatting for free-text notes — shared by the Ward Council
// agenda and the Member Board meeting recaps.
//   "- item"                → bullet
//   "[ ] item" / "[x] item" → to-do with a checkbox that ticks in place
//   two spaces in front     → a sub-point (up to three levels deep)   (2026-10-04)
//   **words**               → bold;  "Lead-in: rest" → the lead-in is bold
//   {@Name}                 → that line is assigned to Name (shown as a pill)   (2026-10-04)
//   "## Name"               → a name card: the lines under it (until the next "## " or a "---" line)
//                             sit inside a card headed by that name; cards in a row form a group (2026-10-11)
// The text is stored exactly as typed, so it stays readable anywhere.
import { esc } from "./ui.js?v=1794450257";

const MAX_LEVEL = 3;
const levelOf = (indent) => Math.min(MAX_LEVEL, Math.floor(String(indent || "").replace(/\t/g, "  ").length / 2));

// Highlights and text colours (2026-10-04): {y:words} — a short code, a colon, the words.
export const HIGHLIGHTS = [["y", "Yellow", "#fff3a3"], ["g", "Green", "#c9f2d0"], ["p", "Pink", "#ffd3e4"], ["b", "Blue", "#cfe6ff"]];
export const TEXT_COLORS = [["red", "Red", "#c0392b"], ["orange", "Orange", "#c76a12"], ["green", "Green", "#2e7d4f"], ["blue", "Blue", "#1f5fbf"], ["purple", "Purple", "#7a3fb0"]];
const HL = new Set(HIGHLIGHTS.map((h) => h[0]));
const COLOR_RE = /\{(y|g|p|b|red|orange|green|blue|purple):([^{}]*)\}/g;
const stripMarks = (t) => String(t).replace(/\s*\{@[^{}]*\}/g, "").replace(/\{(?:y|g|p|b|red|orange|green|blue|purple):/g, "").replace(/[{}]/g, "").replace(/\*\*/g, "");

// marks only (no lead-in): colours/highlights, then **bold**
function marks(text) {
  let h = esc(text).replace(/\{@([^{}]+)\}/g, (_, n) => `<span class="nt-who" data-who="${n.trim()}" title="Assigned to ${n.trim()}">→ ${n.trim()}</span>`);
  for (let pass = 0; pass < 2; pass++) { // twice = one level of nesting ({y:{red:x}})
    h = h.replace(COLOR_RE, (_, code, body) => (HL.has(code) ? `<mark class="nt-hl nt-hl-${code}">${body}</mark>` : `<span class="nt-c nt-c-${code}">${body}</span>`));
  }
  h = h.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  // web addresses become links, shown shortened (2026-10-11); the text is already escaped, so & is &amp; here
  return h.replace(/https?:\/\/[^\s<]+/g, (url) => {
    const clean = url.replace(/[.,;:!?)\]]+$/, ""), tail = url.slice(clean.length);
    const href = clean.replace(/&amp;/g, "&");
    const shown = clean.replace(/^https?:\/\//, "").replace(/^www\./, "");
    const label = shown.length > 48 ? shown.slice(0, 30) + "…" + shown.slice(-14) : shown;
    return `<a class="nt-link" href="${href}" target="_blank" rel="noopener" title="${href}">${label}</a>${tail}`;
  });
}

// Inline text → HTML: marks, and a short lead-in before a colon is bold on its own
export function inlineFmt(line) {
  const raw = String(line ?? "");
  // lead-in = what comes before the first colon that's followed by a space (or ends the line),
  // or before a dash standing on its own ("Elder Schmiel - …"); hyphenated words don't count
  const m = /^(.*?)(:(?=\s|$)|\s+[-–—](?=\s|$))/.exec(raw);
  if (m && !/\*\*/.test(raw)) {
    const lead = m[1], sep = m[2], plain = stripMarks(lead).trim();
    const balanced = (lead.match(/\{/g) || []).length === (lead.match(/\}/g) || []).length;
    // a short lead-in (a name, a title, initials and all) — not a whole sentence, not "https:"
    if (plain && plain.length <= 60 && plain.split(/\s+/).length <= 8 && balanced && !/https?$/i.test(plain) && !/:/.test(stripMarks(lead))) {
      const rest = raw.slice(lead.length + sep.length);
      return sep === ":"
        ? `<b class="nt-lead">${marks(lead)}:</b>` + marks(rest)
        : `<b class="nt-lead">${marks(lead)}</b>${esc(sep)}` + marks(rest);
    }
  }
  return marks(raw);
}

// colour or highlight the selection ("" = clear any colour/highlight in it)
export function wrapColor(ta, code) {
  const a = ta.selectionStart, b = ta.selectionEnd, sel = ta.value.slice(a, b);
  const whole = /^\{(?:y|g|p|b|red|orange|green|blue|purple):([^{}]*)\}$/.exec(sel);
  if (!code) {
    if (!sel) return;
    ta.setRangeText(sel.replace(/\{(?:y|g|p|b|red|orange|green|blue|purple):/g, "").replace(/\}/g, ""), a, b, "select");
  } else if (whole) ta.setRangeText(`{${code}:${whole[1]}}`, a, b, "select");       // already marked → switch colour
  else if (sel) ta.setRangeText(`{${code}:${sel}}`, a, b, "select");
  else { ta.setRangeText(`{${code}:}`, a, b, "start"); const pos = a + code.length + 2; ta.setSelectionRange(pos, pos); }
  ta.focus(); ta.dispatchEvent(new Event("input"));
}

// who a line is assigned to ("" = nobody), set / change / clear it, and the line as plain words
export const lineWho = (line) => { const m = /\{@([^{}]+)\}/.exec(String(line ?? "")); return m ? m[1].trim() : ""; };
export function setLineWho(text, lineIdx, name) {
  const lines = String(text || "").split("\n");
  if (lines[lineIdx] == null) return text;
  const base = lines[lineIdx].replace(/\s*\{@[^{}]*\}/g, "").replace(/\s+$/, "");
  const clean = String(name || "").replace(/[{}]/g, "").trim();
  lines[lineIdx] = clean ? `${base} {@${clean}}` : base;
  return lines.join("\n");
}
export const plainLine = (line) => stripMarks(String(line ?? "").replace(/^\s*(?:##\s+|[-•*]\s+|\[( |x|X)\]\s*)/, "")).trim();

// attrFn(lineIndex) → the data attribute for a to-do checkbox (default: data-todo-line="key|idx")
// opts.assign → each line carries data-aline="key|idx" and list lines get a "+ assign" button
export function notesHtml(text, key, editable, attrFn, opts) {
  const attr = attrFn || ((i) => `data-todo-line="${esc(key)}|${i}"`);
  const canAssign = !!(opts && opts.assign && editable);
  const aline = (i) => (canAssign || (opts && opts.copy && editable) ? ` data-aline="${esc(key)}|${i}"` : "");
  const canCopy = !!(opts && opts.copy && editable);
  const addBtn = (line) => (canAssign && !lineWho(line) ? `<button type="button" class="nt-assign" title="Assign this to someone">+ assign</button>` : "") + (canCopy ? `<button type="button" class="nt-assign nt-copy" title="Put this on another meeting's agenda">⧉ copy to</button>` : "");
  const lines = String(text || "").split("\n");
  let html = "", inList = false, inCard = false, inCards = false;
  const closeList = () => { if (inList) { html += "</ul>"; inList = false; } };
  const closeCard = () => { closeList(); if (inCard) { html += "</div></div>"; inCard = false; } };
  const closeCards = () => { closeCard(); if (inCards) { html += "</div>"; inCards = false; } };
  lines.forEach((raw, i) => {
    const line = raw.replace(/\s+$/, "");
    let m;
    if ((m = /^##\s+(.*)$/.exec(line))) { // a name card; consecutive cards share one row
      closeCard();
      if (!inCards) { html += `<div class="nt-cards">`; inCards = true; }
      html += `<div class="nt-card" data-cardstart="${i}"><div class="nt-card-name"${aline(i)}>${inlineFmt(m[1])}</div><div class="nt-card-body">`;
      inCard = true;
      return;
    }
    if (line.trim() === "---") { closeCards(); return; } // ends the row of cards
    if ((m = /^(\s*)[-•*]\s+(.*)$/.exec(line)) || (m = /^(\s*)[-•*]()$/.exec(line))) {
      if (!inList) { html += `<ul class="rc-list">`; inList = true; }
      const lvl = levelOf(m[1]);
      html += `<li class="nt-l${lvl}"${aline(i)}>${inlineFmt(m[2] || "")}${m[2] ? addBtn(line) : ""}</li>`;
    } else if ((m = /^(\s*)\[( |x|X)\]\s*(.*)$/.exec(line))) {
      closeList();
      const done = m[2].toLowerCase() === "x", lvl = levelOf(m[1]);
      html += `<label class="rc-todo nt-l${lvl}${done ? " done" : ""}"${aline(i)}><input type="checkbox" ${attr(i)} ${done ? "checked" : ""} ${editable ? "" : "disabled"}> <span>${inlineFmt(m[3])}${m[3] ? addBtn(line) : ""}</span></label>`;
    } else if (line.trim() === "") {
      closeList(); html += `<div class="rc-gap"></div>`;
    } else {
      closeList(); html += `<div${aline(i)}>${inlineFmt(line)}</div>`;
    }
  });
  closeCards();
  return html;
}

// flip "[ ]" ↔ "[x]" on one line; returns the new text
export function toggleTodoLine(text, lineIdx) {
  const lines = String(text || "").split("\n");
  if (lines[lineIdx] == null) return text;
  lines[lineIdx] = lines[lineIdx].replace(/^(\s*)\[( |x|X)\]/, (_, sp, c) => `${sp}[${c === " " ? "x" : " "}]`);
  return lines.join("\n");
}

const lineStart = (ta, pos = ta.selectionStart) => ta.value.lastIndexOf("\n", pos - 1) + 1;
const LIST_RE = /^(\s*)(?:([-•*])(?:\s+|$)|\[( |x|X)\]\s*)/;

// make the current line a bullet / to-do (or plain again if it already is that) — keeps its indent
export function prefixLine(ta, prefix) {
  const st = lineStart(ta);
  const cur = ta.value.slice(st).split("\n")[0];
  const indent = /^\s*/.exec(cur)[0];
  const body = cur.slice(indent.length);
  const stripped = body.replace(/^(?:##\s+|[-•*]\s+|[-•*]$|\[( |x|X)\]\s*)/, "");
  const repl = indent + (body.startsWith(prefix) ? stripped : prefix + stripped);
  ta.setRangeText(repl, st, st + cur.length, "end");
  ta.focus(); ta.dispatchEvent(new Event("input"));
}

// indent (+1) or outdent (−1) every list line touched by the selection: sub-points
export function indentLines(ta, dir) {
  const a = lineStart(ta, ta.selectionStart);
  let b = ta.value.indexOf("\n", ta.selectionEnd); if (b < 0) b = ta.value.length;
  const block = ta.value.slice(a, b).split("\n");
  let changed = false;
  const out = block.map((ln) => {
    const indent = /^\s*/.exec(ln)[0].replace(/\t/g, "  ");
    const rest = ln.replace(/^\s*/, "");
    if (!LIST_RE.test(rest)) return ln;                       // only list lines move
    const lvl = Math.floor(indent.length / 2);
    const next = Math.max(0, Math.min(MAX_LEVEL, lvl + dir));
    if (next !== lvl) changed = true;
    return "  ".repeat(next) + rest;
  });
  if (!changed) return false;
  const caretFromEnd = ta.value.length - ta.selectionEnd;
  ta.setRangeText(out.join("\n"), a, b, "end");
  const pos = Math.max(a, ta.value.length - caretFromEnd);
  ta.setSelectionRange(pos, pos);
  ta.focus(); ta.dispatchEvent(new Event("input"));
  return true;
}

// Enter at the end of a bullet / to-do starts another at the same depth;
// Enter on an empty sub-point steps back out a level, on an empty top-level item ends the list.
export function continueList(ta, e) {
  if (e.key !== "Enter" || e.shiftKey || e.metaKey || e.ctrlKey) return false;
  const st = lineStart(ta);
  const cur = ta.value.slice(st, ta.selectionStart);
  if (/^##\s+\S/.test(cur)) { e.preventDefault(); ta.setRangeText("\n- ", ta.selectionStart, ta.selectionEnd, "end"); ta.dispatchEvent(new Event("input")); return true; } // under a name: first bullet
  const m = /^(\s*)(?:([-•*])\s*|\[( |x|X)\]\s*)(.*)$/.exec(cur);
  if (!m || (!m[2] && m[3] === undefined)) return false;
  e.preventDefault();
  const prefix = m[2] ? `${m[1]}${m[2]} ` : `${m[1]}[ ] `;
  if (!m[4].trim()) {
    if (m[1].length >= 2) indentLines(ta, -1);                                  // empty sub-point → back out one level
    else ta.setRangeText("", st, ta.selectionStart, "end");                     // empty item → leave the list
  } else ta.setRangeText("\n" + prefix, ta.selectionStart, ta.selectionEnd, "end");
  ta.dispatchEvent(new Event("input"));
  return true;
}

// one handler for a notes box: Enter continues, Tab / Shift+Tab make or undo a sub-point, ⌘B bolds
export function handleNoteKeys(ta, e) {
  if ((e.key === "b" || e.key === "B") && (e.metaKey || e.ctrlKey)) { e.preventDefault(); toggleBold(ta); return true; }
  if (e.key === "Tab" && !e.metaKey && !e.ctrlKey && !e.altKey) {
    const cur = ta.value.slice(lineStart(ta)).split("\n")[0].replace(/^\s*/, "");
    if (LIST_RE.test(cur) || ta.selectionStart !== ta.selectionEnd) { e.preventDefault(); indentLines(ta, e.shiftKey ? -1 : 1); return true; }
    return false; // not on a list line: let Tab move on as usual
  }
  return continueList(ta, e);
}

// wrap the selection in ** ** (or drop in an empty pair and put the cursor inside)
export function toggleBold(ta) {
  const a = ta.selectionStart, b = ta.selectionEnd, sel = ta.value.slice(a, b);
  if (sel && /^\*\*[\s\S]*\*\*$/.test(sel)) ta.setRangeText(sel.slice(2, -2), a, b, "select");
  else if (sel) ta.setRangeText(`**${sel}**`, a, b, "select");
  else { ta.setRangeText("****", a, b, "start"); ta.setSelectionRange(a + 2, a + 2); }
  ta.focus(); ta.dispatchEvent(new Event("input"));
}

// the buttons above a notes box (mousedown is cancelled so the box keeps focus)
export function toolbarHtml(hint) {
  return `<button type="button" class="btn btn-sm" data-nt="bullet" title="Bullet point">• Bullet</button>` +
    `<button type="button" class="btn btn-sm" data-nt="todo" title="To-do with a checkbox">☐ To-do</button>` +
    `<button type="button" class="btn btn-sm" data-nt="person" title="A name card: this line becomes the name, the lines under it go inside the card. Several in a row sit side by side.">👤 Name card</button>` +
    `<button type="button" class="btn btn-sm" data-nt="in" title="Make it a sub-point (Tab)">→ Sub-point</button>` +
    `<button type="button" class="btn btn-sm" data-nt="out" title="Move it back out (Shift+Tab)">←</button>` +
    `<button type="button" class="btn btn-sm nt-bold" data-nt="bold" title="Bold the selected words (⌘B)"><b>B</b></button>` +
    `<span class="nt-pal" title="Highlight the selected words">${HIGHLIGHTS.map(([c, l, hex]) => `<button type="button" class="nt-sw" data-color="${c}" title="Highlight ${l.toLowerCase()}" style="background:${hex}"></button>`).join("")}</span>` +
    `<span class="nt-pal" title="Colour the selected words">${TEXT_COLORS.map(([c, l, hex]) => `<button type="button" class="nt-sw nt-sw-text" data-color="${c}" title="${l} text" style="color:${hex}">A</button>`).join("")}</span>` +
    `<button type="button" class="btn btn-sm btn-ghost" data-color="" title="Remove colour and highlight from the selected words">✕ colour</button>` +
    `<span class="row-sub">${hint || "Tab makes a sub-point"}</span>`;
}
export function wireToolbar(box, ta) {
  enhance(ta); // the box becomes a live editor: bold looks bold, bullets look like bullets (2026-11-11)
  box.querySelectorAll("[data-nt]").forEach((b) => {
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", () => {
      const k = b.dataset.nt;
      if (ta._nx?.isConnected) return ta._nxCmd(k);
      if (k === "bullet") prefixLine(ta, "- ");
      else if (k === "todo") prefixLine(ta, "[ ] ");
      else if (k === "person") prefixLine(ta, "## ");
      else if (k === "in") indentLines(ta, 1);
      else if (k === "out") indentLines(ta, -1);
      else toggleBold(ta);
    });
  });
  box.querySelectorAll("[data-color]").forEach((b) => {
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", () => (ta._nx?.isConnected ? ta._nxColor(b.dataset.color) : wrapColor(ta, b.dataset.color)));
  });
}

// ---------- the live editor (2026-11-11) ----------
// The textarea stays the source of truth (hidden): the page still reads ta.value and listens to its input /
// keydown / blur. On top sits an editable box with one row per line of text, drawn the way the saved note
// will look. Every change is written back to the textarea in the same plain format as before.
const NX_TYPES = { bullet: "- ", todo: "[ ] ", card: "## " };
function nxParse(raw) {
  const line = String(raw).replace(/\s+$/, "");
  let m;
  if ((m = /^##\s+(.*)$/.exec(line))) return { type: "card", lvl: 0, text: m[1] };
  if (line.trim() === "---") return { type: "rule", lvl: 0, text: "" };
  if ((m = /^(\s*)[-•*]\s+(.*)$/.exec(line)) || (m = /^(\s*)[-•*]()$/.exec(line))) return { type: "bullet", lvl: levelOf(m[1]), text: m[2] || "" };
  if ((m = /^(\s*)\[( |x|X)\]\s*(.*)$/.exec(line))) return { type: "todo", lvl: levelOf(m[1]), done: m[2].toLowerCase() === "x", text: m[3] };
  return { type: "p", lvl: 0, text: line };
}
function nxInline(text) {
  let h = esc(text).replace(/\{@([^{}]+)\}/g, (_, n) => `<span class="nt-who nx-who" contenteditable="false" data-who="${n.trim()}">→ ${n.trim()}</span>`);
  for (let pass = 0; pass < 2; pass++) h = h.replace(COLOR_RE, (_, code, body) => (HL.has(code) ? `<mark class="nt-hl nt-hl-${code}" data-c="${code}">${body}</mark>` : `<span class="nt-c nt-c-${code}" data-c="${code}">${body}</span>`));
  return h.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
}
function nxSerInline(node) {
  let out = "";
  node.childNodes.forEach((n) => {
    if (n.nodeType === 3) { out += n.nodeValue.replace(/ /g, " ").replace(/[​﻿]/g, ""); return; }
    if (n.nodeType !== 1 || n.tagName === "BR") return;
    if (n.dataset && n.dataset.who != null) { out += `{@${n.dataset.who}}`; return; }
    let t = nxSerInline(n);
    const c = n.dataset ? n.dataset.c : "";
    if (c && t) t = `{${c}:${t}}`;
    const bold = n.tagName === "B" || n.tagName === "STRONG" || /^(bold|[6-9]00)$/.test((n.style && n.style.fontWeight) || "");
    if (bold && t.trim()) { const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(t); t = `${m[1]}**${m[2]}**${m[3]}`; }
    out += t;
  });
  return out;
}
function enhance(ta) {
  if (ta._nx || typeof document === "undefined" || !document.createRange) return;
  const desc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
  const rich = document.createElement("div");
  rich.className = "nx-rich"; rich.contentEditable = "true"; rich.spellcheck = true;
  ta._nx = rich;
  let syncing = false;
  const mkLine = (o) => {
    const d = document.createElement("div"); d.className = "nx-line"; d.dataset.type = o.type || "p"; d.dataset.lvl = String(o.lvl || 0);
    if (o.done) d.dataset.done = "1";
    if (o.type === "rule") d.contentEditable = "false"; else d.innerHTML = nxInline(o.text || "") || "<br>";
    return d;
  };
  const fixEmpty = (line) => { if (line.dataset.type !== "rule" && !line.textContent && !line.querySelector("[data-who]")) line.innerHTML = "<br>"; };
  const lines = () => [...rich.children];
  const lineOf = (node) => { let n = node; while (n && n.parentNode !== rich) n = n.parentNode; return n && n.nodeType === 1 ? n : null; };
  const lineText = (line) => nxSerInline(line);
  const serLine = (line) => { const t = line.dataset.type, ind = "  ".repeat(Number(line.dataset.lvl) || 0), x = lineText(line).replace(/\*\*\*\*/g, "");
    return t === "rule" ? "---" : t === "bullet" ? `${ind}- ${x}` : t === "todo" ? `${ind}[${line.dataset.done ? "x" : " "}] ${x}` : t === "card" ? `## ${x}` : x; };
  const serialize = () => lines().map(serLine).join("\n").replace(/\s+$/, "");
  const load = (text) => { rich.innerHTML = ""; String(text || "").split("\n").forEach((l) => rich.appendChild(mkLine(nxParse(l)))); mark(); };
  const mark = () => { const ls = lines(); rich.classList.toggle("nx-empty", ls.length <= 1 && (!ls[0] || (ls[0].dataset.type === "p" && !ls[0].textContent))); };
  const caret = (node, offset) => { const r = document.createRange(); r.setStart(node, offset); r.collapse(true); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); };
  const caretStart = (line) => caret(line, 0);
  const caretEnd = () => { const last = rich.lastElementChild; if (!last) return; const r = document.createRange(); r.selectNodeContents(last); r.collapse(false); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); };
  const range = () => { const sel = getSelection(); return sel.rangeCount && rich.contains(sel.anchorNode) ? sel.getRangeAt(0) : null; };
  const selLines = () => { const r = range(); if (!r) return []; const a = lineOf(r.startContainer), b = lineOf(r.endContainer); if (!a) return []; const ls = lines(), i = ls.indexOf(a), j = b ? ls.indexOf(b) : i; return ls.slice(Math.min(i, j), Math.max(i, j) + 1); };
  const setType = (line, type) => { line.dataset.type = type; if (type !== "todo") delete line.dataset.done; if (type === "p" || type === "card") line.dataset.lvl = "0"; };
  const sync = () => {
    // anything the browser left outside a row goes back into one
    [...rich.childNodes].forEach((n) => { if (n.nodeType === 3 || (n.nodeType === 1 && !n.classList.contains("nx-line"))) { if (n.nodeType === 3 && !n.nodeValue.trim()) { n.remove(); return; } const d = mkLine({ type: "p", text: "" }); d.innerHTML = ""; n.replaceWith(d); d.appendChild(n); if (n.nodeType === 1 && n.tagName === "DIV") { while (n.firstChild) d.insertBefore(n.firstChild, n); n.remove(); } fixEmpty(d); } });
    if (!rich.firstElementChild) rich.appendChild(mkLine({ type: "p", text: "" }));
    lines().forEach((l) => { if (!l.dataset.type) { l.className = "nx-line"; l.dataset.type = "p"; l.dataset.lvl = "0"; } });
    mark();
    syncing = true; desc.set.call(ta, serialize()); syncing = false;
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  };
  // typing "- ", "[ ] " or "## " at the start of a plain line turns it into that kind of line
  const shortcuts = () => {
    const r = range(); if (!r || !r.collapsed) return;
    const line = lineOf(r.startContainer); if (!line || line.dataset.type !== "p") return;
    const first = line.firstChild; if (!first || first.nodeType !== 3) return;
    const m = /^(?:([-*•])|(\[\s?\])|(\[[xX]\])|(##))[  ]/.exec(first.nodeValue); if (!m) return;
    const at = r.startContainer === first ? Math.max(0, r.startOffset - m[0].length) : null; // the cursor keeps its place in the words that are left
    first.nodeValue = first.nodeValue.slice(m[0].length);
    setType(line, m[1] ? "bullet" : m[4] ? "card" : "todo"); if (m[3]) line.dataset.done = "1";
    if (!first.nodeValue) { first.remove(); fixEmpty(line); caretStart(line); } else if (at != null) caret(first, Math.min(at, first.nodeValue.length));
  };
  const atLineStart = (r, line) => { if (!r.collapsed) return false; const pre = document.createRange(); pre.setStart(line, 0); pre.setEnd(r.startContainer, r.startOffset); return !pre.toString() && !pre.cloneContents().querySelector("[data-who]"); };
  const indent = (dir) => { let did = false; selLines().forEach((l) => { if (l.dataset.type !== "bullet" && l.dataset.type !== "todo") return; const n = Math.max(0, Math.min(MAX_LEVEL, (Number(l.dataset.lvl) || 0) + dir)); if (String(n) !== l.dataset.lvl) { l.dataset.lvl = String(n); did = true; } }); if (did) sync(); return did; };
  rich.addEventListener("input", () => { shortcuts(); sync(); });
  rich.addEventListener("keydown", (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === "Escape" || (e.key === "Enter" && mod)) { // the page's own Esc / ⌘Enter handlers live on the textarea
      e.preventDefault(); desc.set.call(ta, serialize());
      ta.dispatchEvent(new KeyboardEvent("keydown", { key: e.key, metaKey: e.metaKey, ctrlKey: e.ctrlKey, bubbles: true, cancelable: true })); return;
    }
    if (mod && (e.key === "b" || e.key === "B")) { e.preventDefault(); cmd("bold"); return; }
    if (mod && /^[iu]$/i.test(e.key)) { e.preventDefault(); return; } // no italics / underline in notes
    if (e.key === "Tab" && !mod && !e.altKey) { const ls = selLines(); if (ls.some((l) => l.dataset.type === "bullet" || l.dataset.type === "todo")) { e.preventDefault(); indent(e.shiftKey ? -1 : 1); } return; }
    const r = range(); if (!r) return;
    if (e.key === "Enter") {
      e.preventDefault();
      r.deleteContents();
      const line = lineOf(r.startContainer) || rich.lastElementChild; if (!line) return;
      const type = line.dataset.type, lvl = Number(line.dataset.lvl) || 0, listy = type === "bullet" || type === "todo";
      if (listy && !lineText(line).trim() && !e.shiftKey) { if (lvl > 0) line.dataset.lvl = String(lvl - 1); else setType(line, "p"); sync(); return; } // empty item: step out
      if (type === "p" && lineText(line).trim() === "---") { const rule = mkLine({ type: "rule" }), nl = mkLine({ type: "p", text: "" }); line.replaceWith(rule); rule.after(nl); caretStart(nl); sync(); return; }
      const tail = document.createRange(); tail.setStart(r.startContainer, r.startOffset); tail.setEnd(line, line.childNodes.length);
      const nl = mkLine({ type: e.shiftKey ? "p" : type === "card" ? "bullet" : type === "rule" ? "p" : type, lvl: e.shiftKey || type === "card" ? 0 : lvl, text: "" });
      nl.innerHTML = ""; nl.appendChild(tail.extractContents()); fixEmpty(nl); fixEmpty(line);
      line.after(nl); caretStart(nl); nl.scrollIntoView({ block: "nearest" }); sync(); return;
    }
    if (e.key === "Backspace" && r.collapsed) {
      const line = lineOf(r.startContainer); if (!line || !atLineStart(r, line)) return;
      const type = line.dataset.type, lvl = Number(line.dataset.lvl) || 0;
      if (type !== "p") { e.preventDefault(); if (lvl > 0) line.dataset.lvl = String(lvl - 1); else setType(line, "p"); sync(); return; } // first un-list it
      const prev = line.previousElementSibling; if (!prev) return;
      e.preventDefault();
      if (prev.dataset.type === "rule") { prev.remove(); sync(); return; }
      if (prev.lastChild && prev.lastChild.nodeName === "BR") prev.lastChild.remove();
      const at = prev.childNodes.length;
      while (line.firstChild) { if (line.firstChild.nodeName === "BR" && line.childNodes.length === 1) { line.firstChild.remove(); break; } prev.appendChild(line.firstChild); }
      line.remove(); fixEmpty(prev); caret(prev, Math.min(at, prev.childNodes.length)); sync();
    }
  });
  // paste comes in as plain text; several lines become several rows (bullets and to-dos are recognised)
  rich.addEventListener("paste", (e) => {
    e.preventDefault();
    const text = ((e.clipboardData || window.clipboardData).getData("text/plain") || "").replace(/\r\n?/g, "\n").replace(/ /g, " ");
    if (!text) return;
    const parts = text.split("\n");
    if (parts.length === 1) { document.execCommand("insertText", false, text); return; }
    const r = range(); if (!r) return; r.deleteContents();
    const line = lineOf(r.startContainer) || rich.lastElementChild;
    const tail = document.createRange(); tail.setStart(r.startContainer, r.startOffset); tail.setEnd(line, line.childNodes.length);
    const rest = tail.extractContents();
    const firstP = nxParse(parts[0]);
    if (!lineText(line).trim() && firstP.type !== "p") { setType(line, firstP.type); line.dataset.lvl = String(firstP.lvl || 0); if (firstP.done) line.dataset.done = "1"; }
    if (line.lastChild && line.lastChild.nodeName === "BR") line.lastChild.remove();
    line.insertAdjacentHTML("beforeend", nxInline(firstP.text));
    let last = line;
    parts.slice(1).forEach((pt) => { const nl = mkLine(nxParse(pt)); last.after(nl); last = nl; });
    if (last.lastChild && last.lastChild.nodeName === "BR") last.lastChild.remove();
    const at = last.childNodes.length; last.appendChild(rest); fixEmpty(last); fixEmpty(line);
    caret(last, Math.min(at, last.childNodes.length)); sync();
  });
  // a click on a to-do's box ticks it
  rich.addEventListener("mousedown", (e) => {
    const line = e.target.closest && e.target.closest('.nx-line[data-type="todo"]'); if (!line || !rich.contains(line)) return;
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16, x = e.clientX - line.getBoundingClientRect().left - (Number(line.dataset.lvl) || 0) * 1.2 * rem;
    if (x >= 0 && x < 1.25 * rem) { e.preventDefault(); if (line.dataset.done) delete line.dataset.done; else line.dataset.done = "1"; sync(); }
  });
  rich.addEventListener("blur", () => { syncing = true; desc.set.call(ta, serialize()); syncing = false; ta.dispatchEvent(new Event("blur")); });
  function cmd(k) {
    rich.focus();
    if (k === "bold") { try { document.execCommand("styleWithCSS", false, false); } catch {} document.execCommand("bold"); sync(); return; }
    if (k === "in" || k === "out") { indent(k === "in" ? 1 : -1); return; }
    const type = k === "bullet" ? "bullet" : k === "todo" ? "todo" : "card";
    const ls = selLines().filter((l) => l.dataset.type !== "rule"); if (!ls.length) return;
    const all = ls.every((l) => l.dataset.type === type);
    ls.forEach((l) => setType(l, all ? "p" : type)); // the same button again makes it plain
    sync();
  }
  function color(code) {
    rich.focus();
    const r = range(); if (!r || r.collapsed) return;
    const a = lineOf(r.startContainer), b = lineOf(r.endContainer);
    if (!a || a !== b) { // several lines: colour each line's part on its own would be a guess — keep it to one line
      const tip = rich.parentNode && rich.parentNode.querySelector(".nx-tip"); if (!tip) { const t = document.createElement("div"); t.className = "nx-tip row-sub"; t.textContent = "Select words on one line to colour them."; rich.after(t); setTimeout(() => t.remove(), 3500); } return; }
    const sameFamily = (el) => !code || HL.has(el.dataset.c) === HL.has(code);
    const frag = r.extractContents();
    frag.querySelectorAll("[data-c]").forEach((el) => { if (sameFamily(el)) el.replaceWith(...el.childNodes); });
    if (!code) { // clear: also lift the words out of a colour they sit inside
      const holder = document.createElement("span"); holder.appendChild(frag); r.insertNode(holder);
      let up = holder.parentNode; while (up && up !== a) { const next = up.parentNode; if (up.dataset && up.dataset.c) { const before = up.cloneNode(false), after = up.cloneNode(false); while (up.firstChild && up.firstChild !== holder) before.appendChild(up.firstChild); while (holder.nextSibling) after.appendChild(holder.nextSibling); up.replaceWith(...(before.textContent ? [before] : []), holder, ...(after.textContent ? [after] : [])); } up = next; }
      const sel = getSelection(), nr = document.createRange(); nr.selectNodeContents(holder); const kids = [...holder.childNodes]; holder.replaceWith(...kids);
      if (kids.length) { nr.setStartBefore(kids[0]); nr.setEndAfter(kids[kids.length - 1]); sel.removeAllRanges(); sel.addRange(nr); }
    } else {
      const w = document.createElement(HL.has(code) ? "mark" : "span"); w.className = HL.has(code) ? `nt-hl nt-hl-${code}` : `nt-c nt-c-${code}`; w.dataset.c = code;
      w.appendChild(frag); r.insertNode(w);
      const sel = getSelection(), nr = document.createRange(); nr.selectNodeContents(w); sel.removeAllRanges(); sel.addRange(nr);
    }
    fixEmpty(a); sync();
  }
  ta._nxCmd = cmd; ta._nxColor = color;
  const mount = () => {
    if (rich.isConnected) return true;
    if (!ta.isConnected) return false;
    rich.dataset.placeholder = ta.placeholder || "";
    ta.after(rich); ta.classList.add("nx-src"); load(desc.get.call(ta));
    return true;
  };
  // the page sets ta.value and calls ta.focus(): both now reach the live box
  Object.defineProperty(ta, "value", { configurable: true, get() { return desc.get.call(ta); }, set(v) { desc.set.call(ta, v); if (!syncing && rich.isConnected) load(v); } });
  ta.focus = () => { if (mount()) { rich.focus(); caretEnd(); } };
  ta.setSelectionRange = () => {}; ta.select = () => {};
  queueMicrotask(mount); setTimeout(mount, 60);
}
