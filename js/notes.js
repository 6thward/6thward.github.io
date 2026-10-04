// Light list formatting for free-text notes — shared by the Ward Council
// agenda and the Member Board meeting recaps.
//   "- item"                → bullet
//   "[ ] item" / "[x] item" → to-do with a checkbox that ticks in place
//   two spaces in front     → a sub-point (up to three levels deep)   (2026-10-04)
//   **words**               → bold;  "Lead-in: rest" → the lead-in is bold
//   {@Name}                 → that line is assigned to Name (shown as a pill)   (2026-10-04)
// The text is stored exactly as typed, so it stays readable anywhere.
import { esc } from "./ui.js?v=1791157953";

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
  return h.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
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
export const plainLine = (line) => stripMarks(String(line ?? "").replace(/^\s*(?:[-•*]\s+|\[( |x|X)\]\s*)/, "")).trim();

// attrFn(lineIndex) → the data attribute for a to-do checkbox (default: data-todo-line="key|idx")
// opts.assign → each line carries data-aline="key|idx" and list lines get a "+ assign" button
export function notesHtml(text, key, editable, attrFn, opts) {
  const attr = attrFn || ((i) => `data-todo-line="${esc(key)}|${i}"`);
  const canAssign = !!(opts && opts.assign && editable);
  const aline = (i) => (canAssign ? ` data-aline="${esc(key)}|${i}"` : "");
  const addBtn = (line) => (canAssign && !lineWho(line) ? `<button type="button" class="nt-assign" title="Assign this to someone">+ assign</button>` : "");
  const lines = String(text || "").split("\n");
  let html = "", inList = false;
  const closeList = () => { if (inList) { html += "</ul>"; inList = false; } };
  lines.forEach((raw, i) => {
    const line = raw.replace(/\s+$/, "");
    let m;
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
  closeList();
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
  const stripped = body.replace(/^(?:[-•*]\s+|[-•*]$|\[( |x|X)\]\s*)/, "");
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
    `<button type="button" class="btn btn-sm" data-nt="in" title="Make it a sub-point (Tab)">→ Sub-point</button>` +
    `<button type="button" class="btn btn-sm" data-nt="out" title="Move it back out (Shift+Tab)">←</button>` +
    `<button type="button" class="btn btn-sm nt-bold" data-nt="bold" title="Bold the selected words (⌘B)"><b>B</b></button>` +
    `<span class="nt-pal" title="Highlight the selected words">${HIGHLIGHTS.map(([c, l, hex]) => `<button type="button" class="nt-sw" data-color="${c}" title="Highlight ${l.toLowerCase()}" style="background:${hex}"></button>`).join("")}</span>` +
    `<span class="nt-pal" title="Colour the selected words">${TEXT_COLORS.map(([c, l, hex]) => `<button type="button" class="nt-sw nt-sw-text" data-color="${c}" title="${l} text" style="color:${hex}">A</button>`).join("")}</span>` +
    `<button type="button" class="btn btn-sm btn-ghost" data-color="" title="Remove colour and highlight from the selected words">✕ colour</button>` +
    `<span class="row-sub">${hint || "Tab makes a sub-point"}</span>`;
}
export function wireToolbar(box, ta) {
  box.querySelectorAll("[data-nt]").forEach((b) => {
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", () => {
      const k = b.dataset.nt;
      if (k === "bullet") prefixLine(ta, "- ");
      else if (k === "todo") prefixLine(ta, "[ ] ");
      else if (k === "in") indentLines(ta, 1);
      else if (k === "out") indentLines(ta, -1);
      else toggleBold(ta);
    });
  });
  box.querySelectorAll("[data-color]").forEach((b) => {
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", () => wrapColor(ta, b.dataset.color));
  });
}
