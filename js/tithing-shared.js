// Tithing declaration sign-ups (2026-10-04) — pieces shared by the bishop's
// view (the Tithing Declaration page) and the public sign-up page (tithing.html).
//
// tithing/{token}                 { open, ward, note, windows[], blocked[slotId], busy{ slotId: event title }, slots{ id: minutes }, created }
//   busy = sign-up times covered by something on the bishop's calendar (events with cal: "bishop"); kept in
//   step by the app whenever his calendar or the availability changes, since the public page can't read events
//   windows[]                     { id, date, start "HH:MM", end "HH:MM", len, place, group, note }
//   priority = true marks a priority block (2026-10-18); the wording members see is tithing/{token}.priorityText (one text for all)
//   (older blocks with a note or a families/widows group count as priority too)
//   priorityText on a window = wording for that block only (changed from the calendar); else the season's text
// tithing/{token}/taken/{slotId}  { len, at }           — public: only WHICH times are gone
// tithing/{token}/signups/{slotId}{ name, phone, address, at } — private: who took them
// slotId = "2026-12-06_1415"

export const GROUPS = {
  families: { label: "Families with kids at home", cls: "fam" },
  widows: { label: "Widows", cls: "wid" },
};
export const PLACES = {
  office: { label: "Bishop's office", pub: "At the Bishop's office", icon: "🏛" },
  home: { label: "Home visit", pub: "The bishop comes to your home", icon: "🏠" },
};
export const SLOT_LENGTHS = [10, 15];

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const toMin = (hhmm) => { const [h, m] = String(hhmm || "0:0").split(":").map(Number); return h * 60 + (m || 0); };
export const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
export const slotId = (date, min) => `${date}_${hhmm(min).replace(":", "")}`;
export const parseSlotId = (id) => { const m = /^(\d{4}-\d{2}-\d{2})_(\d{2})(\d{2})$/.exec(String(id)); return m ? { date: m[1], min: Number(m[2]) * 60 + Number(m[3]) } : null; };
export const fmtClock = (min) => { const h = Math.floor(min / 60), m = min % 60; return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`; };
export const fmtLongDay = (iso) => new Date(iso + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
export const fmtShortDay = (iso) => new Date(iso + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
export const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
export const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
export const addDays = (iso, n) => { const d = new Date(iso + "T12:00:00"); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

export const isPriority = (w) => !!(w && (w.priority || w.note || w.group));
export const PRIORITY_TEXT = "Some time slots are reserved for families with children at home and individuals who could be blessed by a time right after church due to mobility issues, health, or age. Feel free to use those priority time slots based on your situation.";
export const sortWindows = (windows) => [...(windows || [])].sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
export const overlaps = (a, b) => a.date === b.date && toMin(a.start) < toMin(b.end) && toMin(b.start) < toMin(a.end);

// every sign-up time the availability produces, in order; times the bishop blocked out
// are still listed (blocked: true) so his schedule can show and unblock them
export function slotsOf(windows, blocked) {
  const out = [], seen = new Set(), off = new Set(blocked || []);
  sortWindows(windows).forEach((w) => {
    const len = Number(w.len) || 15, end = toMin(w.end);
    for (let t = toMin(w.start); t + len <= end; t += len) {
      const id = slotId(w.date, t);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ id, date: w.date, min: t, len, place: w.place || "office", group: w.group || "", priority: isPriority(w), priorityText: w.priorityText || "", win: w.id, blocked: off.has(id) });
    }
  });
  return out;
}
// { slotId: minutes } — the security rules check a sign-up against this
// (blocked times are left out, so nobody can sign up for them)
export const slotMap = (windows, blocked) => Object.fromEntries(slotsOf(windows, blocked).filter((s) => !s.blocked).map((s) => [s.id, s.len]));

// which sign-up times the bishop's calendar covers: a timed event blocks the times it overlaps
// (an event with no end is taken as an hour); an all-day event blocks that whole day
export function busyFromEvents(windows, events) {
  const out = {};
  const evs = (events || []).filter((e) => e && e.cal === "bishop" && e.date);
  if (!evs.length) return out;
  slotsOf(windows).forEach((s) => {
    const hit = evs.find((e) => e.date === s.date && (!e.startTime || (toMin(e.startTime) < s.min + s.len && s.min < (e.endTime ? toMin(e.endTime) : toMin(e.startTime) + 60))));
    if (hit) out[s.id] = hit.title || "Bishop's calendar";
  });
  return out;
}
export const sameBusy = (a, b) => JSON.stringify(Object.entries(a || {}).sort()) === JSON.stringify(Object.entries(b || {}).sort());
// everything that keeps a time off the sign-up page: blocked by hand + busy on the calendar
export const offList = (season) => [...(season?.blocked || []), ...Object.keys(season?.busy || {})];

export const newToken = () => {
  const a = new Uint8Array(15); crypto.getRandomValues(a);
  return [...a].map((b) => "abcdefghijkmnpqrstuvwxyz23456789"[b % 32]).join("");
};
