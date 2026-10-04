// Self-Reliance Plan — shared by the public form (selfreliance.html) and the
// in-app review page (2026-09-27).
//
// The plan follows the five steps of the Church's Self-Reliance Plan for
// members (needs → income & expenses → other resources → my plan → work or
// service), with two additions the ward asked for: recent bank statements
// and recent credit statements.
//
// Storage (this project has no Storage bucket): each uploaded file is cut
// into chunks and kept in Firestore —
//   selfReliance/{sid}                 the answers + a list of files
//   selfReliance/{sid}/chunks/{f}_{i}  { f: fileId, i: index, d: Bytes }
//   srLinks/{token}                    a form link that is allowed to submit
import { db } from "./firebase-init.js?v=1791134746";
import {
  doc, collection, getDocs, setDoc, Bytes,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

export const INCOME = [
  ["household", "Income from all household members"],
  ["other", "Other financial sources (family, others)"],
  ["government", "Government assistance (financial, food, housing…)"],
];
export const EXPENSES = [
  ["tithes", "Tithes, offerings"],
  ["food", "Food"],
  ["housing", "Housing"],
  ["water", "Water"],
  ["medical", "Medical"],
  ["transportation", "Transportation"],
  ["education", "Education"],
  ["debt", "Debt payments"],
  ["clothing", "Clothing"],
  ["power", "Electricity, fuel"],
];
export const OTHER_EXPENSE_ROWS = 4;  // "Other (specify)" lines
export const REDUCE_ROWS = 3;         // expenses that can be reduced or eliminated
export const PLAN_ROWS = 6;           // resources/skills · steps · by when

export const FILE_KINDS = [
  ["bank", "Bank statements", "Your 2 or 3 most recent bank statements"],
  ["credit", "Credit card statements", "Your 2 or 3 most recent credit card statements"],
];
export const MAX_FILES_PER_KIND = 3;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;   // 10 MB each
export const CHUNK_BYTES = 900 * 1024;            // under Firestore's 1 MiB document limit
export const ACCEPT = "application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png";

export const money = (v) => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? "").replace(/[^0-9.\-]/g, ""));
  return isFinite(n) ? Math.round(n * 100) / 100 : 0;
};
export const fmtMoney = (n) => (n || n === 0 ? (n < 0 ? "−$" : "$") + Math.abs(Number(n)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "");
export const fmtBytes = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1024)) + " KB");

export function totals(p) {
  const inc = INCOME.reduce((a, [k]) => a + money(p.income?.[k]), 0);
  const exp = EXPENSES.reduce((a, [k]) => a + money(p.expenses?.[k]), 0)
    + (p.otherExpenses || []).reduce((a, r) => a + money(r.amount), 0);
  const reduce = (p.reduce || []).reduce((a, r) => a + money(r.amount), 0);
  return { income: inc, expenses: exp, net: Math.round((inc - exp) * 100) / 100, reduce };
}

export const newId = (n = 20) => {
  const a = new Uint8Array(n); crypto.getRandomValues(a);
  return [...a].map((b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
};
export const formLink = (token) => `${location.origin}${location.pathname.replace(/[^/]*$/, "")}selfreliance.html?k=${token}`;

// ---- files ⇄ chunks ----
export async function uploadFile(sid, meta, file, onProgress) {
  const buf = new Uint8Array(await file.arrayBuffer());
  const n = Math.max(1, Math.ceil(buf.length / CHUNK_BYTES));
  for (let i = 0; i < n; i++) {
    const part = buf.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES);
    await setDoc(doc(db, "selfReliance", sid, "chunks", `${meta.id}_${i}`), { f: meta.id, i, d: Bytes.fromUint8Array(part) });
    onProgress?.(part.length);
  }
  return n;
}
export const chunkCount = (size) => Math.max(1, Math.ceil(size / CHUNK_BYTES));

// Reassemble one file for viewing (review page only — rules keep the public out).
export async function fetchFile(sid, meta) {
  const snap = await getDocs(collection(db, "selfReliance", sid, "chunks"));
  const parts = snap.docs.map((d) => d.data()).filter((c) => c.f === meta.id).sort((a, b) => a.i - b.i);
  if (parts.length < (meta.chunks || 1)) throw new Error("This file didn't finish uploading.");
  const arrays = parts.map((c) => (c.d?.toUint8Array ? c.d.toUint8Array() : new Uint8Array(c.d)));
  return new Blob(arrays, { type: meta.type || "application/pdf" });
}
