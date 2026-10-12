// Quick PIN (2026-10-11): a Google user sets their own 4-digit PIN and, on any device
// where they've signed in with Google once, signs in with the PIN from then on.
//
// How it stays safe with only four digits: the PIN alone is never the password.
// The hidden account's password is SHA-256(salt + PIN); the salt lives in the
// person's own profile (users/{uid}.quickPin, readable only by them) and is copied
// to a device's localStorage when they sign in with Google there. A device that
// never saw a Google sign-in has no salt, so the PIN is useless on it.
//
//   users/{googleUid}.quickPin  { email, salt, pinUid }
//   users/{pinUid}              { alias: googleUid, role: "pin", quick: true, perms… }  (mirror profile)
//   localStorage "sw-quick"     { [googleUid]: { name, email, salt } }
import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, updatePassword, deleteUser, signOut,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { firebaseConfig, PIN_DOMAIN } from "./firebase-init.js?v=1791777716";

export const QUICK_PIN_LENGTH = 4;
const KEY = "sw-quick";

export const validQuickPin = (pin) => new RegExp(`^\\d{${QUICK_PIN_LENGTH}}$`).test(String(pin || ""));
const rand = (n) => { const a = new Uint8Array(n); crypto.getRandomValues(a); return [...a].map((b) => b.toString(16).padStart(2, "0")).join(""); };
export const newSalt = () => rand(16);
export const newQuickEmail = () => `pin-q${rand(8)}@${PIN_DOMAIN}`;

// the account password: never the bare PIN
export async function derive(pin, salt) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}:${pin}`));
  return "q" + btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/[^A-Za-z0-9]/g, "").slice(0, 40);
}

// ---- what this device remembers ----
export function devicePins() { try { return JSON.parse(localStorage.getItem(KEY) || "{}"); } catch { return {}; } }
export function rememberDevice(uid, rec) { try { const all = devicePins(); all[uid] = rec; localStorage.setItem(KEY, JSON.stringify(all)); } catch {} }
export function forgetDevice(uid) { try { const all = devicePins(); delete all[uid]; localStorage.setItem(KEY, JSON.stringify(all)); } catch {} }

function sideAuth() {
  const name = "quick-pin";
  const side = getApps().some((a) => a.name === name) ? getApp(name) : initializeApp(firebaseConfig, name);
  return getAuth(side);
}

// Create the hidden account for a new PIN. Resolves { email, salt, pinUid }.
export async function createQuickAccount(pin) {
  if (!validQuickPin(pin)) throw new Error(`The PIN must be ${QUICK_PIN_LENGTH} digits.`);
  const a = sideAuth(), email = newQuickEmail(), salt = newSalt();
  try {
    const cred = await createUserWithEmailAndPassword(a, email, await derive(pin, salt));
    return { email, salt, pinUid: cred.user.uid };
  } catch (err) {
    if (err.code === "auth/operation-not-allowed") throw new Error("PIN sign-in isn't switched on for this project yet.");
    throw err;
  } finally { try { await signOut(a); } catch {} }
}

// Change the PIN on an existing hidden account (needs the current PIN to prove it's theirs).
export async function changeQuickPin(rec, oldPin, newPin) {
  if (!validQuickPin(newPin)) throw new Error(`The new PIN must be ${QUICK_PIN_LENGTH} digits.`);
  const a = sideAuth();
  try {
    const cred = await signInWithEmailAndPassword(a, rec.email, await derive(oldPin, rec.salt));
    await updatePassword(cred.user, await derive(newPin, rec.salt));
  } catch (err) {
    if (["auth/invalid-credential", "auth/invalid-login-credentials", "auth/wrong-password", "auth/user-not-found"].includes(err.code)) throw new Error("That isn't your current PIN.");
    throw err;
  } finally { try { await signOut(a); } catch {} }
}

// Delete the hidden account when the PIN is known; resolves false if it isn't (the caller still drops the profile docs).
export async function deleteQuickAccount(rec, pin) {
  if (!validQuickPin(pin)) return false;
  const a = sideAuth();
  try {
    const cred = await signInWithEmailAndPassword(a, rec.email, await derive(pin, rec.salt));
    await deleteUser(cred.user);
    return true;
  } catch (err) {
    if (["auth/invalid-credential", "auth/invalid-login-credentials", "auth/wrong-password", "auth/user-not-found"].includes(err.code)) return false;
    throw err;
  } finally { try { await signOut(a); } catch {} }
}
