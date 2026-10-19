// Phone helpers shared by the Users page and the Message page (2026-10-18)
// "(435) 201-2105" for any US number however it was typed; anything else stays as typed
export const fmtPhone = (p) => { const d = String(p || "").replace(/\D/g, ""); const n = d.length === 11 && d[0] === "1" ? d.slice(1) : d; return n.length === 10 ? `(${n.slice(0, 3)}) ${n.slice(3, 6)}-${n.slice(6)}` : String(p || "").trim(); };
// +14352012105 — what the sms: link needs
export const normPhone = (p) => { const d = String(p || "").replace(/\D/g, ""); return d.length === 10 ? "+1" + d : d.length === 11 && d[0] === "1" ? "+" + d : d ? "+" + d : ""; };
export const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
// one sms: link that opens the phone's Messages app with everyone addressed and the words filled in
export function smsLink(numbers, body) {
  const q = body ? (isIOS() ? "&" : "?") + "body=" + encodeURIComponent(body) : "";
  return `sms:${numbers.join(",")}${q}`;
}
