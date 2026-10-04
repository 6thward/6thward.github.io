// Light list formatting for free-text notes (2026-10-04) — shared by the
// Ward Council agenda (and the same convention the Member Board recaps use):
//   "- item"                → bullet
//   "[ ] item" / "[x] item" → to-do with a checkbox that ticks in place
// The text is stored exactly as typed, so it stays readable anywhere.
import { esc } from "./ui.js?v=1791132118";

export function notesHtml(text, key, editable) {
  const lines = String(text || "").split("\n");
  let html = "", inList = false;
  const closeList = () => { if (inList) { html += "</ul>"; inList = false; } };
  lines.forEach((raw, i) => {
    const line = raw.replace(/\s+$/, "");
    let m;
    if ((m = /^\s*[-•*]\s+(.*)$/.exec(line)) || (m = /^\s*[-•*]$/.exec(line))) {
      if (!inList) { html += `<ul class="rc-list">`; inList = true; }
      html += `<li>${esc(m[1] || "")}</li>`;
    } else if ((m = /^\s*\[( |x|X)\]\s*(.*)$/.exec(line))) {
      closeList();
      const done = m[1].toLowerCase() === "x";
      html += `<label class="rc-todo${done ? " done" : ""}"><input type="checkbox" data-todo-line="${esc(key)}|${i}" ${done ? "checked" : ""} ${editable ? "" : "disabled"}> <span>${esc(m[2])}</span></label>`;
    } else if (line.trim() === "") {
      closeList(); html += `<div class="rc-gap"></div>`;
    } else {
      closeList(); html += `<div>${esc(line)}</div>`;
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
