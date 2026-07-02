import { db } from "./firebase.js";
import {
  collection, doc, addDoc, deleteDoc,
  onSnapshot, query, where, orderBy, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

export const TAG_COLORS = [
  "#ef4444", "#f97316", "#eab308", "#22c55e",
  "#06b6d4", "#3b82f6", "#a855f7", "#ec4899",
];

function tagsRef(workspaceId) {
  return collection(db, "workspaces", workspaceId, "tags");
}

export async function createTag(uid, workspaceId, projectId, name, color) {
  return addDoc(tagsRef(workspaceId), { name, color, projectId, workspaceId, createdAt: serverTimestamp() });
}

export function getTags(uid, workspaceId, projectId, callback) {
  const q = query(tagsRef(workspaceId), where("projectId", "==", projectId), orderBy("createdAt"));
  return onSnapshot(q, snap => callback(snap.docs.map(d => ({ id: d.id, ...d.data() }))));
}

export async function deleteTag(uid, workspaceId, projectId, tagId) {
  return deleteDoc(doc(db, "workspaces", workspaceId, "tags", tagId));
}
