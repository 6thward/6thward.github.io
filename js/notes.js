// Light list formatting for free-text notes (2026-10-04) — shared by the
// Ward Council agenda (and the same convention the Member Board recaps use):
//   "- item"                → bullet
//   "[ ] item" / "[x] item" → to-do with a checkbox that ticks in place
// The text is stored exactly as typed, so it stays readable anywhere.
import { esc } from "./ui.js?v=1791132968";

// Inline text → HTML (2026-10-04):
//   **words**            → bold
//   "Lead-in: the rest"  → the lead-in (up to the first colon) is bold on its own,
//                          so "Elder Fantone: Service is…" gets a bold name
export function inlineFmt(line) {
  let h = esc(line);
  const hadBold = /\*\*[^*]+\*\*/.test(h);
  h = h.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  if (!hadBold) {
    const m = /^([^:]{1,60}):(\s|$)/.exec(h);
    // a short lead-in (a name, a title, initials and all) — not a whole sentence, not "https:"
    if (m && m[1].trim().split(/\s+/).length <= 8 && !/https?$/i.test(m[1].trim())) h = `<b class="nt-lead">${m[1]}:</b>` + h.slice(m[1].length + 1);
  }
  return h;
}

// wrap the selection in ** ** (or drop in an empty pair and put the cursor inside)
export function toggleBold(ta) {
  const a = ta.selectionStart, b = ta.selectionEnd, sel = ta.value.slice(a, b);
  if (sel && /^\*\*[\s\S]*\*\*$/.test(sel)) ta.setRangeText(sel.slice(2, -2), a, b, "select");
  else if (sel) ta.setRangeText(`**${sel}**`, a, b, "select");
  else { ta.setRangeText("****", a, b, "start"); ta.setSelectionRange(a + 2, a + 2); }
  ta.focus(); ta.dispatchEvent(new Event("input"));
}

export function notesHtml(text, key, editable) {
  const lines = String(text || "").split("\n");
  let html = "", inList = false;
  const closeList = () => { if (inList) { html += "</ul>"; inList = false; } };
  lines.forEach((raw, i) => {
    const line = raw.replace(/\s+$/, "");
    let m;
    if ((m = /^\s*[-•*]\s+(.*)$/.exec(line)) || (m = /^\s*[-•*]$/.exec(line))) {
      if (!inList) { html += `<ul class="rc-list">`; inList = true; }
      html += `<li>${inlineFmt(m[1] || "")}</li>`;
    } else if ((m = /^\s*\[( |x|X)\]\s*(.*)$/.exec(line))) {
      closeList();
      const done = m[1].toLowerCase() === "x";
      html += `<label class="rc-todo${done ? " done" : ""}"><input type="checkbox" data-todo-line="${esc(key)}|${i}" ${done ? "checked" : ""} ${editable ? "" : "disabled"}> <span>${inlineFmt(m[2])}</span></label>`;
    } else if (line.trim() === "") {
      closeList(); html += `<div class="rc-gap"></div>`;
    } else {
      closeList(); html += `<div>${inlineFmt(line)}</div>`;
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

const lineStart = (ta) => ta.value.lastIndexOf("\n", ta.selectionStart - 1) + 1;

// make the current line a bullet / to-do (or plain again if it already is one)
export function prefixLine(ta, prefix) {
  const st = lineStart(ta);
  const cur = ta.value.slice(st).split("\n")[0];
  const stripped = cur.replace(/^\s*(?:[-•*]\s+|[-•*]$|\[( |x|X)\]\s*)/, "");
  const repl = cur.startsWith(prefix) ? stripped : prefix + stripped;
  ta.setRangeText(repl, st, st + cur.length, "end");
  ta.focus(); ta.dispatchEvent(new Event("input"));
}

// Enter at the end of a bullet / to-do starts another; Enter on an empty one ends the list
export function continueList(ta, e) {
  if (e.key !== "Enter" || e.shiftKey || e.metaKey || e.ctrlKey) return false;
  const st = lineStart(ta);
  const cur = ta.value.slice(st, ta.selectionStart);
  const m = /^(\s*)(?:([-•*])\s*|\[( |x|X)\]\s*)(.*)$/.exec(cur);
  if (!m || (!m[2] && m[3] === undefined)) return false;
  e.preventDefault();
  const prefix = m[2] ? `${m[1]}${m[2]} ` : `${m[1]}[ ] `;
  if (!m[4].trim()) ta.setRangeText("", st, ta.selectionStart, "end"); // empty item → leave the list
  else ta.setRangeText("\n" + prefix, ta.selectionStart, ta.selectionEnd, "end");
  ta.dispatchEvent(new Event("input"));
  return true;
}
