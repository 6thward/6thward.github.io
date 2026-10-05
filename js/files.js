// Small-file attachments kept in Firestore (2026-10-04). This project has no
// Storage bucket, so a file is cut into chunks under a parent document:
//   <parent path>/chunks/{fileId}_{i}   { f: fileId, i, d: Bytes }
// and the item that owns it keeps the metadata:
//   { id, name, size, type, chunks, at }   (at = the parent doc id holding the chunks)
import { db } from "./firebase-init.js?v=1791212856";
import {
  doc, collection, getDocs, setDoc, deleteDoc, Bytes,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

export const CHUNK_BYTES = 900 * 1024;            // under Firestore's 1 MiB document limit
export const MAX_ATTACH_BYTES = 10 * 1024 * 1024; // 10 MB per file
export const ATTACH_ACCEPT = ".pdf,.jpg,.jpeg,.png,.gif,.webp,.heic,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,application/pdf,image/*";
export const fmtBytes = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round((b || 0) / 1024)) + " KB");
export const newFileId = () => { const a = new Uint8Array(8); crypto.getRandomValues(a); return "f" + [...a].map((b) => b.toString(36)).join("").slice(0, 12); };
export const fileIcon = (m) => (/pdf/i.test(m.type + m.name) ? "📄" : /^image\//.test(m.type) || /\.(png|jpe?g|gif|webp|heic)$/i.test(m.name) ? "🖼" : /sheet|excel|\.xlsx?$|\.csv$/i.test(m.type + m.name) ? "📊" : "📎");

// upload one File under [collection, parentId]; returns its metadata
export async function uploadAttachment(coll, parentId, file, onProgress) {
  const id = newFileId();
  const buf = new Uint8Array(await file.arrayBuffer());
  const n = Math.max(1, Math.ceil(buf.length / CHUNK_BYTES));
  for (let i = 0; i < n; i++) {
    await setDoc(doc(db, coll, parentId, "chunks", `${id}_${i}`), { f: id, i, d: Bytes.fromUint8Array(buf.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES)) });
    onProgress?.((i + 1) / n);
  }
  return { id, name: file.name.slice(0, 140), size: file.size, type: file.type || "", chunks: n, at: parentId };
}

export async function fetchAttachment(coll, meta) {
  const snap = await getDocs(collection(db, coll, meta.at, "chunks"));
  const parts = snap.docs.map((d) => d.data()).filter((c) => c.f === meta.id).sort((a, b) => a.i - b.i);
  if (parts.length < (meta.chunks || 1)) throw new Error("This file didn't finish uploading.");
  return new Blob(parts.map((c) => (c.d?.toUint8Array ? c.d.toUint8Array() : new Uint8Array(c.d))), { type: meta.type || "application/octet-stream" });
}

export async function deleteAttachment(coll, meta) {
  for (let i = 0; i < (meta.chunks || 1); i++) await deleteDoc(doc(db, coll, meta.at, "chunks", `${meta.id}_${i}`)).catch(() => {});
}

// open in a new tab when the browser can show it (PDF, images, text); otherwise download
export async function openAttachment(coll, meta) {
  const viewable = /pdf|^image\/|^text\//i.test(meta.type) || /\.(pdf|png|jpe?g|gif|webp|txt)$/i.test(meta.name);
  const w = viewable ? window.open("", "_blank") : null; // opened inside the click so pop-up blockers allow it
  try {
    const blob = await fetchAttachment(coll, meta);
    const url = URL.createObjectURL(blob);
    if (w) w.location.href = url;
    else { const a = document.createElement("a"); a.href = url; a.download = meta.name; document.body.appendChild(a); a.click(); a.remove(); }
    setTimeout(() => URL.revokeObjectURL(url), 5 * 60 * 1000);
  } catch (e) { w?.close(); throw e; }
}
