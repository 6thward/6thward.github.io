// Standing meetings on the bishop's calendar (2026-10-11): ward council on each council
// Sunday (the dates chosen on the Ward Council page) and the weekly bishopric meeting.
//   settings/bishopCal { council: { on, start, end, byYear: { "2026": { start, end } } }, bishopric: { on, weekday, start, end } }
//   council.byYear (2026-10-25): a year's own meeting time; a year without one uses start/end
// They show on the Calendar like any bishop's event and block tithing-declaration times.
import { db } from "./firebase-init.js?v=1792976318";
import { doc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

let cfg = null, councilDates = [], listeners = [], started = false;
const fire = () => listeners.forEach((cb) => { try { cb(); } catch (e) { console.warn("[bishop-cal]", e); } });

export function watchBishopCal(cb) {
  listeners.push(cb);
  if (started) { cb(); return; }
  started = true;
  onSnapshot(doc(db, "settings", "bishopCal"), (s) => { cfg = s.exists() ? s.data() : {}; fire(); }, () => { cfg = {}; fire(); });
  onSnapshot(doc(db, "councils", "_dates"), (s) => { councilDates = s.exists() ? (s.data().dates || []) : []; fire(); }, () => fire());
}
export const bishopCalConfig = () => cfg || {};
// ward council's time on a given date: that year's own time if one is set, else the general one
export const councilTimeFor = (date) => { const c = (cfg || {}).council || {}; const y = String(date || "").slice(0, 4); const t = (c.byYear || {})[y]; return { on: !!c.on, start: (t && t.start) || c.start || "", end: t ? (t.end || "") : (c.end || "") }; };
export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// the standing meetings that fall on the given days (ISO dates), shaped like calendar events
export function standingEvents(dates) {
  const c = cfg || {}, out = [];
  [...new Set(dates || [])].forEach((d) => {
    const ct = councilTimeFor(d);
    if (ct.on && ct.start && (councilDates.length ? councilDates.includes(d) : new Date(d + "T12:00:00").getDay() === 0)) out.push({ id: "sc:" + d, standing: "council", cal: "bishop", date: d, startTime: ct.start, endTime: ct.end || "", title: "Ward council", color: c.council.color || "" });
    if (c.bishopric?.on && c.bishopric.start && new Date(d + "T12:00:00").getDay() === Number(c.bishopric.weekday)) out.push({ id: "sb:" + d, standing: "bishopric", cal: "bishop", date: d, startTime: c.bishopric.start, endTime: c.bishopric.end || "", title: "Bishopric meeting", color: c.bishopric.color || "" });
  });
  return out;
}
