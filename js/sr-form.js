// Public Self-Reliance Plan form (2026-09-27): selfreliance.html?k=TOKEN
// No sign-in. The link's token must be an active srLinks doc; the answers
// are written once and can't be read back by the public.
import { db } from "./firebase-init.js?v=1791136522";
import {
  doc, getDoc, setDoc, updateDoc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import {
  INCOME, EXPENSES, OTHER_EXPENSE_ROWS, REDUCE_ROWS, PLAN_ROWS, FILE_KINDS,
  MAX_FILES_PER_KIND, MAX_FILE_BYTES, ACCEPT, money, fmtMoney, fmtBytes, totals, newId, uploadFile, chunkCount,
} from "./sr-shared.js?v=1791136522";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const DRAFT_KEY = "sr-draft";
const picked = { bank: [], credit: [] }; // File objects chosen so far

export async function initForm(mount, token) {
  const fail = (title, msg) => { mount.innerHTML = `<div class="sr-card sr-msg"><h2>${esc(title)}</h2><p>${esc(msg)}</p></div>`; };
  if (!token) return fail("This link is incomplete", "Ask the person who sent it for the full link.");
  let link;
  try { link = await getDoc(doc(db, "srLinks", token)); }
  catch { return fail("Couldn't open the form", "Check your connection and try again."); }
  if (!link.exists() || link.data().active !== true) return fail("This link is no longer active", "Ask your bishop or the person who sent it for a new link.");
  const ward = link.data().ward || "6th Ward";

  const moneyRow = (group, key, label) => `
    <label class="sr-money"><span>${esc(label)}</span>
      <span class="sr-dollar"><input inputmode="decimal" data-money="${group}.${key}" placeholder="0.00" autocomplete="off"></span></label>`;
  const today = new Date(); const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

  mount.innerHTML = `
    <form class="sr-form" id="sr-form" novalidate>
      <div class="sr-card sr-intro">
        <h1>Self-Reliance Plan</h1>
        <p class="sr-ward">${esc(ward)}</p>
        <p>This plan helps you and your leaders see your needs, what you have to work with, and the steps you'll take. Fill in what you can — your bishop, Relief Society president or elders quorum president can help with the rest.</p>
        <p class="sr-private">🔒 What you enter goes only to your bishop and the leaders he assigns to help you. It isn't visible to anyone else, and this page can't show it again after you send it.</p>
      </div>

      <div class="sr-card">
        <h2>About you</h2>
        <div class="sr-grid">
          <label class="sr-field"><span>Name <b class="sr-req">*</b></span><input name="name" required autocomplete="name"></label>
          <label class="sr-field"><span>Spouse's name <i>(if married)</i></span><input name="spouse" autocomplete="off"></label>
          <label class="sr-field"><span>Phone</span><input name="phone" type="tel" inputmode="tel" autocomplete="tel"></label>
          <label class="sr-field"><span>Email</span><input name="email" type="email" autocomplete="email"></label>
          <label class="sr-field sr-wide"><span>Address</span><input name="address" autocomplete="street-address"></label>
          <label class="sr-field"><span>Adults in the home</span><input name="adults" inputmode="numeric" autocomplete="off"></label>
          <label class="sr-field"><span>Children in the home</span><input name="children" inputmode="numeric" autocomplete="off"></label>
        </div>
      </div>

      <div class="sr-card">
        <h2><span class="sr-step">Step 1</span> What are my needs?</h2>
        <p class="sr-help">Right-now needs might be food, clothing, housing, or medical or emotional care. Longer-term needs might be education or better work.</p>
        <label class="sr-field"><span>Needs right now</span><textarea name="needsNow" rows="4"></textarea></label>
        <label class="sr-field"><span>Longer-term needs</span><textarea name="needsLater" rows="3"></textarea></label>
      </div>

      <div class="sr-card">
        <h2><span class="sr-step">Step 2</span> What are my income and expenses?</h2>
        <p class="sr-help">Monthly amounts. Best estimates are fine.</p>
        <h3>Monthly income</h3>
        ${INCOME.map(([k, l]) => moneyRow("income", k, l)).join("")}
        <div class="sr-total"><span>Total income</span><b id="sr-t-income">$0.00</b></div>

        <h3>Monthly expenses</h3>
        <div class="sr-two">${EXPENSES.map(([k, l]) => moneyRow("expenses", k, l)).join("")}</div>
        <div class="sr-others">
          ${Array.from({ length: OTHER_EXPENSE_ROWS }, (_, i) => `
          <div class="sr-other"><input data-other-label="${i}" placeholder="Other expense (what is it?)" autocomplete="off"><span class="sr-dollar"><input inputmode="decimal" data-other-amount="${i}" placeholder="0.00" autocomplete="off"></span></div>`).join("")}
        </div>
        <div class="sr-total"><span>Total expenses</span><b id="sr-t-expenses">$0.00</b></div>
        <div class="sr-total sr-net"><span>Income minus expenses</span><b id="sr-t-net">$0.00</b></div>

        <h3>Expenses I could reduce or drop</h3>
        ${Array.from({ length: REDUCE_ROWS }, (_, i) => `
          <div class="sr-other"><input data-reduce-label="${i}" placeholder="Which expense?" autocomplete="off"><span class="sr-dollar"><input inputmode="decimal" data-reduce-amount="${i}" placeholder="0.00" autocomplete="off"></span></div>`).join("")}
        <div class="sr-total"><span>Total I could save</span><b id="sr-t-reduce">$0.00</b></div>
      </div>

      <div class="sr-card">
        <h2><span class="sr-step">Step 3</span> What other resources are available?</h2>
        <label class="sr-field"><span>My own resources and skills</span><textarea name="resSelf" rows="3"></textarea></label>
        <label class="sr-field"><span>Help available from family (parents, children, siblings, others)</span><textarea name="resFamily" rows="3"></textarea></label>
        <label class="sr-field"><span>Community resources that could help</span><textarea name="resCommunity" rows="3"></textarea></label>
      </div>

      <div class="sr-card">
        <h2><span class="sr-step">Step 4</span> What is my plan to become more self-reliant?</h2>
        <p class="sr-help">One line per goal. Joining a self-reliance group can be part of your plan.</p>
        <div class="sr-plan">
          <div class="sr-plan-head"><span>Resource or skill I need</span><span>Steps I'll take</span><span>By when</span></div>
          ${Array.from({ length: PLAN_ROWS }, (_, i) => `
          <div class="sr-plan-row"><input data-plan-need="${i}" placeholder="Need" autocomplete="off"><input data-plan-steps="${i}" placeholder="Steps" autocomplete="off"><input data-plan-when="${i}" type="date"></div>`).join("")}
        </div>
      </div>

      <div class="sr-card">
        <h2><span class="sr-step">Step 5</span> What work or service will I give in return?</h2>
        <label class="sr-field"><span>Ideas to share with the bishop</span><textarea name="serviceIdeas" rows="3"></textarea></label>
      </div>

      <div class="sr-card">
        <h2>Statements</h2>
        <p class="sr-help">PDF is best; a clear photo (JPG or PNG) also works. Up to ${MAX_FILES_PER_KIND} files each, ${fmtBytes(MAX_FILE_BYTES)} per file.</p>
        ${FILE_KINDS.map(([k, l, h]) => `
        <div class="sr-files" data-kind="${k}">
          <h3>${esc(l)}</h3>
          <p class="sr-help">${esc(h)}.</p>
          <div class="sr-file-list" id="sr-files-${k}"></div>
          <label class="sr-btn sr-btn-ghost sr-add-file">+ Add a file<input type="file" accept="${ACCEPT}" multiple hidden data-file="${k}"></label>
        </div>`).join("")}
      </div>

      <div class="sr-card">
        <h2>Commitment</h2>
        <div class="sr-grid">
          <label class="sr-field"><span>Your signature <i>(type your full name)</i> <b class="sr-req">*</b></span><input name="signature" required autocomplete="off"></label>
          <label class="sr-field"><span>Date</span><input name="signedOn" type="date" value="${iso}"></label>
          <label class="sr-field"><span>Spouse's signature <i>(type full name)</i></span><input name="spouseSignature" autocomplete="off"></label>
          <label class="sr-field"><span>Date</span><input name="spouseSignedOn" type="date"></label>
        </div>
        <label class="sr-check"><input type="checkbox" name="agree" required> <span>This is accurate to the best of my knowledge, and I'm sharing it with my bishop and the leaders he assigns.</span></label>
      </div>

      <p id="sr-err" class="sr-err" hidden></p>
      <div class="sr-actions"><button class="sr-btn sr-btn-primary" id="sr-send" type="submit">Send to my bishop</button></div>
      <div class="sr-progress" id="sr-progress" hidden><div class="sr-bar"><span id="sr-bar-fill"></span></div><p id="sr-progress-text">Sending…</p></div>
    </form>`;

  const form = mount.querySelector("#sr-form");
  restoreDraft(form);
  const recalc = () => {
    const t = totals(read(form));
    mount.querySelector("#sr-t-income").textContent = fmtMoney(t.income);
    mount.querySelector("#sr-t-expenses").textContent = fmtMoney(t.expenses);
    const net = mount.querySelector("#sr-t-net"); net.textContent = fmtMoney(t.net); net.classList.toggle("neg", t.net < 0);
    mount.querySelector("#sr-t-reduce").textContent = fmtMoney(t.reduce);
  };
  form.addEventListener("input", () => { recalc(); saveDraft(form); });
  recalc();

  // tidy money on blur: "1,200" → 1200.00
  form.querySelectorAll("[data-money],[data-other-amount],[data-reduce-amount]").forEach((i) => i.addEventListener("blur", () => {
    if (i.value.trim()) i.value = money(i.value).toFixed(2); recalc();
  }));

  form.querySelectorAll("[data-file]").forEach((inp) => inp.addEventListener("change", () => {
    const kind = inp.dataset.file;
    for (const f of inp.files) {
      if (picked[kind].length >= MAX_FILES_PER_KIND) { showErr(mount, `Up to ${MAX_FILES_PER_KIND} files for each — remove one to add another.`); break; }
      if (f.size > MAX_FILE_BYTES) { showErr(mount, `“${f.name}” is ${fmtBytes(f.size)} — the limit is ${fmtBytes(MAX_FILE_BYTES)}. Try a smaller PDF.`); continue; }
      if (!/pdf|jpe?g|png/i.test(f.type + f.name)) { showErr(mount, `“${f.name}” isn't a PDF, JPG or PNG.`); continue; }
      picked[kind].push(f);
    }
    inp.value = "";
    drawFiles(mount, kind);
  }));
  FILE_KINDS.forEach(([k]) => drawFiles(mount, k));

  form.addEventListener("submit", (e) => { e.preventDefault(); submit(mount, form, token); });
}

function drawFiles(mount, kind) {
  const box = mount.querySelector(`#sr-files-${kind}`);
  box.innerHTML = picked[kind].length
    ? picked[kind].map((f, i) => `<div class="sr-file"><span class="sr-file-name">📄 ${esc(f.name)}</span><span class="sr-file-size">${fmtBytes(f.size)}</span><button type="button" class="sr-file-x" data-rm="${kind}:${i}" aria-label="Remove ${esc(f.name)}">✕</button></div>`).join("")
    : `<div class="sr-file sr-file-none">No files added yet.</div>`;
  box.querySelectorAll("[data-rm]").forEach((b) => b.addEventListener("click", () => {
    const [k, i] = b.dataset.rm.split(":"); picked[k].splice(Number(i), 1); drawFiles(mount, k);
  }));
  mount.querySelector(`.sr-files[data-kind="${kind}"] .sr-add-file`).hidden = picked[kind].length >= MAX_FILES_PER_KIND;
}

function showErr(mount, msg) {
  const e = mount.querySelector("#sr-err");
  e.textContent = msg; e.hidden = !msg;
  if (msg) e.scrollIntoView({ block: "center", behavior: "smooth" });
}

// everything typed, as the plan object that gets saved
function read(form) {
  const v = (n) => (form.elements[n]?.value || "").trim();
  const q = (sel) => (form.querySelector(sel)?.value || "").trim();
  const p = {
    name: v("name"), spouse: v("spouse"), phone: v("phone"), email: v("email"), address: v("address"),
    adults: v("adults"), children: v("children"),
    needsNow: v("needsNow"), needsLater: v("needsLater"),
    income: {}, expenses: {}, otherExpenses: [], reduce: [],
    resSelf: v("resSelf"), resFamily: v("resFamily"), resCommunity: v("resCommunity"),
    plan: [], serviceIdeas: v("serviceIdeas"),
    signature: v("signature"), signedOn: v("signedOn"), spouseSignature: v("spouseSignature"), spouseSignedOn: v("spouseSignedOn"),
  };
  INCOME.forEach(([k]) => { p.income[k] = money(q(`[data-money="income.${k}"]`)); });
  EXPENSES.forEach(([k]) => { p.expenses[k] = money(q(`[data-money="expenses.${k}"]`)); });
  for (let i = 0; i < OTHER_EXPENSE_ROWS; i++) { const label = q(`[data-other-label="${i}"]`), amount = money(q(`[data-other-amount="${i}"]`)); if (label || amount) p.otherExpenses.push({ label, amount }); }
  for (let i = 0; i < REDUCE_ROWS; i++) { const label = q(`[data-reduce-label="${i}"]`), amount = money(q(`[data-reduce-amount="${i}"]`)); if (label || amount) p.reduce.push({ label, amount }); }
  for (let i = 0; i < PLAN_ROWS; i++) { const need = q(`[data-plan-need="${i}"]`), steps = q(`[data-plan-steps="${i}"]`), when = q(`[data-plan-when="${i}"]`); if (need || steps || when) p.plan.push({ need, steps, when }); }
  return p;
}

// A refresh or a dropped connection shouldn't lose a long form. Kept in
// sessionStorage, so it's gone when the tab closes. Files aren't kept.
function saveDraft(form) {
  try {
    const d = {};
    form.querySelectorAll("input:not([type=file]):not([type=checkbox]), textarea").forEach((el, i) => { if (el.value) d[i] = el.value; });
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify(d));
  } catch { /* private mode */ }
}
function restoreDraft(form) {
  try {
    const d = JSON.parse(sessionStorage.getItem(DRAFT_KEY) || "{}");
    form.querySelectorAll("input:not([type=file]):not([type=checkbox]), textarea").forEach((el, i) => { if (d[i] && !el.value) el.value = d[i]; else if (d[i] && el.type === "date") el.value = d[i]; });
  } catch { /* nothing to restore */ }
}

async function submit(mount, form, token) {
  showErr(mount, "");
  const p = read(form);
  if (!p.name) { form.elements.name.focus(); return showErr(mount, "Please enter your name."); }
  if (!p.signature) { form.elements.signature.focus(); return showErr(mount, "Please type your full name as your signature."); }
  if (!form.elements.agree.checked) return showErr(mount, "Please tick the box above the Send button.");

  const files = [];
  FILE_KINDS.forEach(([kind]) => picked[kind].forEach((f) => files.push({ file: f, meta: { id: newId(10), kind, name: f.name.slice(0, 140), size: f.size, type: f.type || "application/pdf", chunks: chunkCount(f.size) } })));
  const totalBytes = files.reduce((a, f) => a + f.file.size, 0) || 1;

  const btn = mount.querySelector("#sr-send");
  const prog = mount.querySelector("#sr-progress"), fill = mount.querySelector("#sr-bar-fill"), text = mount.querySelector("#sr-progress-text");
  btn.disabled = true; btn.textContent = "Sending…"; prog.hidden = false;
  form.querySelectorAll("input, textarea, button").forEach((el) => { if (el !== btn) el.disabled = true; });

  const sid = newId(20);
  const t = totals(p);
  try {
    text.textContent = "Sending your answers…";
    await setDoc(doc(db, "selfReliance", sid), {
      ...p, totals: t, link: token, files: files.map((f) => f.meta),
      status: "new", complete: false, submittedAt: serverTimestamp(),
    });
    let sent = 0;
    for (const [i, f] of files.entries()) {
      text.textContent = `Uploading ${f.meta.name} (${i + 1} of ${files.length})…`;
      await uploadFile(sid, f.meta, f.file, (n) => { sent += n; fill.style.width = Math.min(100, Math.round((sent / totalBytes) * 100)) + "%"; });
    }
    fill.style.width = "100%";
    await updateDoc(doc(db, "selfReliance", sid), { complete: true });
    try { sessionStorage.removeItem(DRAFT_KEY); } catch { /* fine */ }
    mount.innerHTML = `<div class="sr-card sr-msg sr-done"><div class="sr-tick">✓</div><h2>Sent — thank you, ${esc(p.name.split(" ")[0])}</h2>
      <p>Your plan${files.length ? ` and ${files.length} file${files.length === 1 ? "" : "s"}` : ""} went to your bishop. He or a leader he assigns will be in touch.</p>
      <p class="sr-help">You can close this page.</p></div>`;
    window.scrollTo({ top: 0 });
  } catch (err) {
    console.warn("[self-reliance] submit", err);
    form.querySelectorAll("input, textarea, button").forEach((el) => { el.disabled = false; });
    btn.textContent = "Send to my bishop"; prog.hidden = true;
    showErr(mount, err?.code === "permission-denied"
      ? "This link isn't accepting forms any more. Ask your bishop for a new link — what you typed is still here."
      : "Something interrupted the upload. Check your connection and press Send again — what you typed is still here.");
  }
}
