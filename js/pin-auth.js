// PIN accounts — bishop-side helpers.
//
// A PIN person is a Firebase Auth email/password account the bishop creates
// (email pin-XXXXXX@sixthward.pin, password = the PIN). Firebase stores the
// PIN hashed and throttles guessing; Firestore rules read the person's
// users/{uid}.perms map to decide what they can see and change.
//
// Creating another account while the bishop is signed in would sign the
// bishop OUT (Auth is one-user-per-app), so all account work happens on a
// second, throw-away Firebase app instance that is signed out afterwards.
import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  deleteUser, signOut,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { firebaseConfig, pinEmail, PIN_LENGTH } from "./firebase-init.js?v=1789967537";

function sideAuth() {
  const name = "pin-admin";
  const side = getApps().some((a) => a.name === name) ? getApp(name) : initializeApp(firebaseConfig, name);
  return getAuth(side);
}

export function validPin(pin) {
  return new RegExp(`^\\d{${PIN_LENGTH}}$`).test(String(pin || ""));
}

// A random PIN that avoids the obvious ones (all same digit, straight runs).
export function randomPin() {
  for (let i = 0; i < 50; i++) {
    const p = String(Math.floor(Math.random() * 10 ** PIN_LENGTH)).padStart(PIN_LENGTH, "0");
    if (/^(\d)\1+$/.test(p)) continue;
    if ("0123456789012".includes(p) || "9876543210987".includes(p)) continue;
    return p;
  }
  return String(Math.floor(Math.random() * 10 ** PIN_LENGTH)).padStart(PIN_LENGTH, "0");
}

// Create the hidden account. Resolves the new uid. Throws with a friendly
// message when the PIN is already taken.
export async function createPinAccount(pin) {
  if (!validPin(pin)) throw new Error(`PIN must be ${PIN_LENGTH} digits.`);
  const a = sideAuth();
  try {
    const cred = await createUserWithEmailAndPassword(a, pinEmail(pin), pin);
    return cred.user.uid;
  } catch (err) {
    if (err.code === "auth/email-already-in-use") throw new Error("That PIN is already taken — pick another.");
    if (err.code === "auth/operation-not-allowed") throw new Error("Email/password sign-in isn't enabled on the Firebase project yet (Authentication → Sign-in method).");
    throw err;
  } finally {
    try { await signOut(a); } catch {}
  }
}

// Remove the hidden account. Needs the current PIN to prove control of it
// (the browser has no admin powers). Resolves true when deleted, false when
// the PIN didn't match an account (already gone) — the caller still cleans
// up the Firestore docs either way.
export async function deletePinAccount(pin) {
  if (!validPin(pin)) return false;
  const a = sideAuth();
  try {
    const cred = await signInWithEmailAndPassword(a, pinEmail(pin), pin);
    await deleteUser(cred.user);
    return true;
  } catch (err) {
    if (["auth/user-not-found", "auth/invalid-credential", "auth/invalid-login-credentials", "auth/wrong-password"].includes(err.code)) return false;
    throw err;
  } finally {
    try { await signOut(a); } catch {}
  }
}
