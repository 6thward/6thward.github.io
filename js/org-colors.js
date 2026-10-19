// One colour per organization, shared by the Callings board and the Users page (2026-10-18).
// Known organizations keep a fixed colour; anything else hashes to one of the pill colours,
// so the same name always lands on the same colour everywhere.
export const ORG_COLORS = {
  "relief society": "#cf6d96", "elders quorum": "#6b96c9", "primary": "#dd9257",
  "young men": "#74a67f", "young women": "#a37fc0", "sunday school": "#b98a2f",
  "bishopric": "#5b8fa8", "ward": "#5b8fa8",
  "music": "#a34a6e", "ward mission": "#0f6b63", "activities": "#5b8fa8", "activities committee": "#5b8fa8",
  "temple & family history": "#8a6500", "ward clerk": "#4b5563", "executive secretary": "#4b5563",
};
export const PILL_COLORS = ["#cf6d96", "#6b96c9", "#dd9257", "#74a67f", "#a37fc0", "#b98a2f", "#5b8fa8", "#c96b6b"];
export function orgColor(name, fallbackLabel) {
  const key = (name || fallbackLabel || "").toLowerCase().trim();
  if (ORG_COLORS[key]) return ORG_COLORS[key];
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PILL_COLORS[h % PILL_COLORS.length];
}
