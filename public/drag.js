import { db } from "./firebase.js";
import {
  doc, writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

let _colSortable     = null;
const _taskSortables = [];
let _dragCurrentList = null;

function _animateGhostEnter(toList, prevList) {
  requestAnimationFrame(() => {
    const ghost = toList.querySelector(".task-ghost");
    if (!ghost) return;

    const fromRect = prevList?.closest(".column")?.getBoundingClientRect();
    const toRect   = toList.closest(".column")?.getBoundingClientRect();
    const movingRight = !fromRect || !toRect || toRect.left > fromRect.left;

    ghost.classList.remove("ghost-entering-l", "ghost-entering-r");
    void ghost.offsetWidth; // força reflow para reiniciar a animação
    ghost.classList.add(movingRight ? "ghost-entering-l" : "ghost-entering-r");
  });
}

export function destroyDrag() {
  if (_colSortable) { _colSortable.destroy(); _colSortable = null; }
  _taskSortables.forEach(s => s.destroy());
  _taskSortables.length = 0;
  _dragCurrentList = null;
  document.body.style.cursor = "";
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
          doc(db, "workspaces", workspaceId, "columns", el.dataset.colId),
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
    group:            "tasks",
    animation:        150,
    delay:            150,
    delayOnTouchOnly: true,
    forceFallback:    true,
    ghostClass:       "task-ghost",
    dragClass:        "task-dragging",
    onStart: (evt) => {
      _dragCurrentList = evt.from;
      document.body.style.cursor = "grabbing";
    },
    onMove: (evt) => {
      if (evt.to !== _dragCurrentList) {
        const prev = _dragCurrentList;
        _dragCurrentList = evt.to;
        _animateGhostEnter(evt.to, prev);
      }
    },
    onEnd: async (evt) => {
      _dragCurrentList = null;
      document.body.style.cursor = "";

      const taskId    = evt.item.dataset.taskId;
      const fromColId = evt.from.closest(".column").dataset.colId;
      const toColId   = evt.to.closest(".column").dataset.colId;

      if (fromColId === toColId && evt.oldIndex === evt.newIndex) return;

      // No schema flat, uma task não muda de path ao trocar de coluna — só
      // os campos columnId/order do mesmo doc em workspaces/{workspaceId}/tasks
      // são atualizados. Não precisa mais de delete+recreate.
      const batch = writeBatch(db);

      if (fromColId === toColId) {
        [...evt.to.querySelectorAll(".task-card")].forEach((el, i) => {
          batch.update(
            doc(db, "workspaces", workspaceId, "tasks", el.dataset.taskId),
            { order: i * 1000 }
          );
        });
      } else {
        const toEls    = [...evt.to.querySelectorAll(".task-card")];
        const newOrder = toEls.findIndex(el => el.dataset.taskId === taskId) * 1000;

        batch.update(
          doc(db, "workspaces", workspaceId, "tasks", taskId),
          { columnId: toColId, order: newOrder }
        );

        [...evt.from.querySelectorAll(".task-card")].forEach((el, i) => {
          batch.update(
            doc(db, "workspaces", workspaceId, "tasks", el.dataset.taskId),
            { order: i * 1000 }
          );
        });

        toEls.forEach((el, i) => {
          if (el.dataset.taskId === taskId) return;
          batch.update(
            doc(db, "workspaces", workspaceId, "tasks", el.dataset.taskId),
            { order: i * 1000 }
          );
        });
      }

      await batch.commit();
    }
  });

  _taskSortables.push(s);
}
