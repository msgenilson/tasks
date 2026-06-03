import { db } from "./firebase.js";
import {
  doc, getDoc, setDoc
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

function profileRef(uid) {
  return doc(db, "users", uid, "profile", "data");
}

export async function getProfile(uid) {
  const snap = await getDoc(profileRef(uid));
  return snap.exists() ? snap.data() : { name: "", email: "" };
}

export async function saveProfile(uid, data) {
  return setDoc(profileRef(uid), data, { merge: true });
}
