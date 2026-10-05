// Self-Reliance member cards (2026-10-05) — reading the self-reliance specialist's
// "Self-Reliance Plan (Responses)" spreadsheet export (CSV from Google Forms).
// Pure helpers only (no Firebase), so they can be checked on their own.

// monthly income lines / expense lines on a response: [key, label, header text it comes from]
export const INC = [
  ["income", "Household income", "income from all household members"],
  ["otherSources", "Other sources (family, others)", "other financial sources"],
  ["gov", "Government assistance", "government assistance"],
];
export const EXP = [
  ["tithes", "Tithes", "tithes"],
  ["food", "Food", "food"],
  ["housing", "Housing", "housing"],
  ["utilities", "Utilities", "utilities"],
  ["medical", "Medical", "medical"],
  ["transport", "Transportation", "transportation"],
  ["education", "Education", "education"],
  ["debt", "Debt payments", "debt payments"],
  ["clothing", "Clothing", "clothing"],
  ["other", "Everything else", "all remaining expenses"],
];
// the written answers, in the order they're shown
export const QA = [
  ["reduce", "Expenses that could be reduced or dropped", "do you have any expenses that can be reduced"],
  ["skills", "Skills and strengths", "what skills or strengths"],
  ["family", "How family can help", "how can family members help"],
  ["community", "Community resources tried", "have i reached out to any community resources"],
  ["resources", "What they need to become self-reliant", "resources and skills i need"],
  ["steps", "Steps they plan to take", "steps i plan to take"],
  ["target", "Target date", "target completion date"],
  ["ideas", "Ideas for the bishop", "ideas to share with the bishop"],
];

export function parseCsv(text) {
  const rows = []; let row = [], cur = "", q = false;
  const s = String(text || "").replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
    else if (c !== "\r") cur += c;
  }
  if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((x) => String(x).trim() !== ""));
}

// "NA", "none", "nothing", "0"… = they answered, and the answer is nothing
export const isNone = (v) => /^(n\/?a|none|nothing|no|nope|0+(\.0+)?|\$0+(\.0+)?|-|—)\.?$/i.test(String(v ?? "").trim());
export const isBlank = (v) => String(v ?? "").trim() === "" || isNone(v);

// A written money answer → our best reading of the monthly amount.
//   "$395 car payment - $70 for gas - $169 for insurance" → 634 (not exact)
//   "1,000" → 1000 (exact)      "NA" → 0 (exact)      "I have housing" → null (can't tell)
export function guessAmount(text) {
  const raw = String(text ?? "").trim();
  if (raw === "") return { amt: null, exact: true };
  if (isNone(raw)) return { amt: 0, exact: true };
  if (/^\$?\s*\d[\d,]*(\.\d+)?\s*$/.test(raw)) return { amt: Number(raw.replace(/[^\d.]/g, "")), exact: true };
  let sum = 0, found = false;
  const re = /(\$\s*)?(\d[\d,]*(?:\.\d+)?)(?![\d,]*[A-Za-z%])/g; // skips "2nd", "11pm", "10%"
  let m;
  while ((m = re.exec(raw))) {
    const v = Number(m[2].replace(/,/g, ""));
    if (!isFinite(v)) continue;
    if (!m[1] && !m[2].includes(".") && v < 10) continue; // "1 car", "2 jobs" — a count, not dollars
    sum += v; found = true;
  }
  if (found) return { amt: Math.round(sum * 100) / 100, exact: false };
  if (/^(nothing|none|n\/?a)\b/i.test(raw)) return { amt: 0, exact: false }; // "Nothing — currently looking for a job"
  return { amt: null, exact: false };
}

const tidyName = (n) => {
  const s = String(n || "").trim().replace(/\s+/g, " ");
  // "Lace walker" / "JOHN DOE" → capitalise each word; anything already mixed-case is left alone
  return s.split(" ").map((w) => (w === w.toLowerCase() || (w.length > 2 && w === w.toUpperCase()) ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w)).join(" ");
};
export const personKey = (name, email) => (String(email || "").trim().toLowerCase() || String(name || "").trim().toLowerCase().replace(/\s+/g, " "));

// "6/3/2026 22:20:24" → "2026-06-03T22:20:24" (also used as the response's id)
export function stampIso(v) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(String(v || "").trim());
  if (!m) return "";
  const y = m[3].length === 2 ? "20" + m[3] : m[3], p = (x) => String(x || 0).padStart(2, "0");
  return `${y}-${p(m[1])}-${p(m[2])}T${p(m[4])}:${p(m[5])}:${p(m[6])}`;
}

// rows of the export → one entry per response: { key, name, spouse, email, resp }
export function mapResponses(rows) {
  if (!rows.length) return { list: [], missing: ["everything"] };
  const head = rows[0].map((h) => String(h).trim().toLowerCase());
  const col = (prefix, nth = 0) => { let n = -1; for (let i = 0; i < head.length; i++) if (head[i].startsWith(prefix) && ++n === nth) return i; return -1; };
  const iStamp = col("timestamp"), iName = col("name", 0), iSign = col("name", 1), iSpouse = col("spouse"), iEmail = col("email"), iNeeds = col("describe your needs"), iDate = col("date", 0);
  const missing = [];
  if (iName < 0) missing.push("Name");
  if (iNeeds < 0) missing.push("Describe your needs");
  const list = [];
  rows.slice(1).forEach((r) => {
    const get = (i) => (i >= 0 ? String(r[i] ?? "").trim() : "");
    const name = tidyName(get(iSign) || get(iName));
    if (!name) return;
    const email = get(iEmail).toLowerCase();
    const raw = { needs: get(iNeeds) }, amounts = {}, exact = {};
    [...INC, ...EXP].forEach(([k, , h]) => {
      // government assistance is three boxes on the form — keep what was actually written
      const val = k === "gov" ? [0, 1, 2].map((n) => get(col(h, n))).filter((x) => !isBlank(x)).join("; ") : get(col(h));
      raw[k] = val;
      const g = guessAmount(val);
      // "School debt 3,130" is what they owe, not what they pay each month — leave it out of the total
      const balance = k === "debt" && !g.exact && g.amt != null && /debt|owe|balance|loan/i.test(val) && !/pay|month|\/\s*mo\b/i.test(val);
      amounts[k] = balance ? null : g.amt; exact[k] = g.exact;
      if (balance) (raw._flags ||= {})[k] = "balance";
    });
    QA.forEach(([k, , h]) => { raw[k] = get(col(h)); });
    const at = stampIso(get(iStamp)) || stampIso(get(iDate));
    const spouse = isBlank(get(iSpouse)) ? "" : tidyName(get(iSpouse));
    list.push({ key: personKey(name, email), name, spouse, email, resp: { id: at || `${name}|${raw.needs}`.slice(0, 80), at, raw, amounts, exact, edited: {} } });
  });
  return { list, missing };
}

export function respTotals(resp) {
  const a = (resp && resp.amounts) || {};
  const sum = (defs) => defs.reduce((t, [k]) => t + (Number(a[k]) || 0), 0);
  // a side with no readable dollar amounts at all is "unknown", not $0
  const income = a.income != null ? sum(INC) : null;                                   // the main income answer has to be readable
  const expenses = EXP.some(([k]) => Number(a[k]) > 0) || EXP.every(([k]) => a[k] != null) ? sum(EXP) : null;
  return { income, expenses, net: income == null || expenses == null ? null : income - expenses, unknown: [...INC, ...EXP].filter(([k]) => a[k] == null && !isBlank(resp?.raw?.[k])).map(([k]) => k) };
}

export const fmtUsd = (n) => (n == null ? "—" : (n < 0 ? "−" : "") + "$" + Math.abs(Math.round(n)).toLocaleString("en-US"));

// A pasted write-up → sections. A short line with no closing punctuation, followed by
// more text, is treated as a heading ("Current Financial Situation").
export function writeupSections(text) {
  const lines = String(text || "").replace(/\r/g, "").split("\n").map((l) => l.trim());
  const out = []; let cur = { title: "", paras: [] };
  lines.forEach((l, i) => {
    if (!l) return;
    const next = lines.slice(i + 1).find((x) => x);
    const heading = l.length <= 70 && !/[.!?:;,]$/.test(l) && l.split(/\s+/).length <= 9 && next && next.length > l.length;
    if (heading) { if (cur.title || cur.paras.length) out.push(cur); cur = { title: l, paras: [] }; }
    else cur.paras.push(l);
  });
  if (cur.title || cur.paras.length) out.push(cur);
  return out;
}
