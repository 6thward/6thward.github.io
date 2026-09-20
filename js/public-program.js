// Public program page (2026-09-20): program.html?p=TOKEN — reads the
// published snapshot (no sign-in) and renders one program column, phone-sized.
import { db } from "./firebase-init.js?v=1789910588";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { buildProgramHtml } from "./program.js?v=1789910588";

const fmtDate = (d) => new Date(d + "T12:00:00").toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

export async function renderPublicProgram(token, mount) {
  const fail = (msg) => { mount.innerHTML = `<div class="pp-msg">${msg}</div>`; };
  if (!token) return fail("This link is missing its program code.");
  let snap;
  try { snap = await getDoc(doc(db, "public", token)); } catch (e) { return fail("Couldn't load the program. Check your connection and try again."); }
  if (!snap.exists()) return fail("This program link is no longer active.");
  const d = snap.data();
  const ctx = { m: d, date: d.date, labels: d.labels || {}, settings: d.settings, presidingDefault: d.presiding, fmtDate };
  const html = buildProgramHtml(ctx, { footer: d.settings?.opts?.footer || "" });
  // lift the print page's <style> and ONE program column into this page
  const style = (html.match(/<style>([\s\S]*?)<\/style>/) || [])[1] || "";
  // the sheet holds the program twice, back to back — take the first copy
  const a = html.indexOf('<div class="prog">'); const b = html.indexOf('<div class="prog">', a + 1);
  const prog = a < 0 ? "" : html.slice(a, b > a ? b : html.indexOf("</div>\n<script>", a));
  mount.innerHTML = `<style>${style}</style><div class="sheet pp-sheet">${prog}</div>`;
  document.title = `Program · ${fmtDate(d.date)}`;
  return d;
}
