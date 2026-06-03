import { db } from "./firebase.js";
import {
  doc, getDoc, writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

let _colSortable     = null;
const _taskSortables = [];

export function destroyDrag() {
  if (_colSortable) { _colSortable.destroy(); _colSortable = null; }
  _taskSortables.forEach(s => s.destroy());
  _taskSortables.length = 0;
}

// ── Colunas ───────────────────────────────────────────────────────────────────

export function initColumnDrag(boardEl, uid, workspaceId, projectId) {
  _colSortable = Sortable.create(boardEl, {
    animation:   150,
    handle:      ".col-drag-handle",
    draggable:   ".column",
    ghostClass:  "col-ghost",
    onEnd: async (evt) => {
      if (evt.oldIndex === evt.newIndex) return;
      const batch = writeBatch(db);
      [...boardEl.querySelectorAll(".column")].forEach((el, i) => {
        batch.update(
          doc(db, "users", uid, "workspaces", workspaceId, "projects", projectId, "columns", el.dataset.colId),
          { order: i * 1000 }
        );
      });
      await batch.commit();
    }
  });
}

// ── Tasks ─────────────────────────────────────────────────────────────────────

export function initTaskDrag(colEl, uid, workspaceId, projectId) {
  const list = colEl.querySelector(".task-list");
  if (!list) return;

  const s = Sortable.create(list, {
    group:       "tasks",
    animation:   150,
    ghostClass:  "task-ghost",
    dragClass:   "task-dragging",
    onEnd: async (evt) => {
      const taskId    = evt.item.dataset.taskId;
      const fromColId = evt.from.closest(".column").dataset.colId;
      const toColId   = evt.to.closest(".column").dataset.colId;

      if (fromColId === toColId && evt.oldIndex === evt.newIndex) return;

      const batch = writeBatch(db);

      if (fromColId === toColId) {
        [...evt.to.querySelectorAll(".task-card")].forEach((el, i) => {
          batch.update(
            doc(db, "users", uid, "workspaces", workspaceId, "projects", projectId, "columns", toColId, "tasks", el.dataset.taskId),
            { order: i * 1000 }
          );
        });
      } else {
        const srcRef = doc(db, "users", uid, "workspaces", workspaceId, "projects", projectId, "columns", fromColId, "tasks", taskId);
        const snap   = await getDoc(srcRef);
        if (!snap.exists()) return;

        const toEls    = [...evt.to.querySelectorAll(".task-card")];
        const newOrder = toEls.findIndex(el => el.dataset.taskId === taskId) * 1000;

        batch.set(
          doc(db, "users", uid, "workspaces", workspaceId, "projects", projectId, "columns", toColId, "tasks", taskId),
          { ...snap.data(), order: newOrder }
        );
        batch.delete(srcRef);

        [...evt.from.querySelectorAll(".task-card")].forEach((el, i) => {
          batch.update(
            doc(db, "users", uid, "workspaces", workspaceId, "projects", projectId, "columns", fromColId, "tasks", el.dataset.taskId),
            { order: i * 1000 }
          );
        });

        toEls.forEach((el, i) => {
          if (el.dataset.taskId === taskId) return;
          batch.update(
            doc(db, "users", uid, "workspaces", workspaceId, "projects", projectId, "columns", toColId, "tasks", el.dataset.taskId),
            { order: i * 1000 }
          );
        });
      }

      await batch.commit();
    }
  });

  _taskSortables.push(s);
}
