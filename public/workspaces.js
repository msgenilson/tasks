import { db } from "./firebase.js";
import {
  collection, doc, addDoc, getDocs, updateDoc,
  onSnapshot, query, orderBy, writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

export const WORKSPACE_COLORS = [
  "#5b6af0", "#ef4444", "#f97316", "#eab308",
  "#22c55e", "#06b6d4", "#a855f7", "#ec4899",
];

// ── CRUD ──────────────────────────────────────────────────────────────────────

function workspacesRef(uid) {
  return collection(db, "users", uid, "workspaces");
}

export function getWorkspaces(uid, callback) {
  const q = query(workspacesRef(uid), orderBy("order"));
  return onSnapshot(q, snap => callback(snap.docs.map(d => ({ id: d.id, ...d.data() }))));
}

export async function createWorkspace(uid, name, color) {
  return addDoc(workspacesRef(uid), { name, color, order: Date.now() });
}

export async function updateWorkspace(uid, workspaceId, data) {
  return updateDoc(doc(db, "users", uid, "workspaces", workspaceId), data);
}

export async function deleteWorkspace(uid, workspaceId) {
  const batch = writeBatch(db);
  const projsSnap = await getDocs(
    collection(db, "users", uid, "workspaces", workspaceId, "projects")
  );
  for (const projDoc of projsSnap.docs) {
    const colsSnap = await getDocs(
      collection(db, "users", uid, "workspaces", workspaceId, "projects", projDoc.id, "columns")
    );
    for (const colDoc of colsSnap.docs) {
      const tasksSnap = await getDocs(
        collection(db, "users", uid, "workspaces", workspaceId, "projects", projDoc.id, "columns", colDoc.id, "tasks")
      );
      for (const taskDoc of tasksSnap.docs) {
        const subsSnap = await getDocs(
          collection(db, "users", uid, "workspaces", workspaceId, "projects", projDoc.id, "columns", colDoc.id, "tasks", taskDoc.id, "subtasks")
        );
        subsSnap.docs.forEach(s => batch.delete(s.ref));
        batch.delete(taskDoc.ref);
      }
      batch.delete(colDoc.ref);
    }
    const tagsSnap = await getDocs(
      collection(db, "users", uid, "workspaces", workspaceId, "projects", projDoc.id, "tags")
    );
    tagsSnap.docs.forEach(t => batch.delete(t.ref));
    batch.delete(projDoc.ref);
  }
  batch.delete(doc(db, "users", uid, "workspaces", workspaceId));
  return batch.commit();
}

// ── State ─────────────────────────────────────────────────────────────────────

let _unsub      = null;
let _activeId   = null;
let _prevId     = null;
let _onChange   = null;
let _wsUid      = null;
let _workspaces = [];
let _open       = false;
let _confirmId  = null;
let _renameId   = null;

const LS_KEY = "tasks_active_workspace";

function esc(str) {
  return String(str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ── Public ────────────────────────────────────────────────────────────────────

export function initWorkspaces(uid, onChange) {
  _wsUid    = uid;
  _onChange = onChange;
  _activeId = localStorage.getItem(LS_KEY);
  _prevId   = null;
  _open     = false;

  _renderShell();

  if (_unsub) _unsub();
  _unsub = getWorkspaces(uid, (workspaces) => {
    _workspaces = workspaces;

    if (_activeId && !workspaces.find(w => w.id === _activeId)) _activeId = null;
    if (!_activeId && workspaces.length > 0) _activeId = workspaces[0].id;

    if (_activeId) localStorage.setItem(LS_KEY, _activeId);
    else           localStorage.removeItem(LS_KEY);

    _renderContent();

    if (_activeId !== _prevId) {
      _prevId = _activeId;
      _onChange(_activeId);
    }
  });
}

export function destroyWorkspaces() {
  if (_unsub) { _unsub(); _unsub = null; }
  _activeId   = null;
  _prevId     = null;
  _wsUid      = null;
  _onChange   = null;
  _workspaces = [];
  _open       = false;
  _confirmId  = null;
  _renameId   = null;
  const el = document.getElementById("workspace-selector");
  if (el) el.innerHTML = "";
}

export function closeWorkspaceDropdown() {
  if (_open) {
    _open      = false;
    _confirmId = null;
    _renameId  = null;
    _renderContent();
  }
}

// ── Shell ─────────────────────────────────────────────────────────────────────

function _renderShell() {
  const el = document.getElementById("workspace-selector");
  el.innerHTML = `
    <button class="ws-trigger" id="ws-trigger" title="Workspaces"></button>
    <div class="ws-menu hidden" id="ws-menu"></div>
  `;

  document.getElementById("ws-trigger").addEventListener("click", () => {
    _open ? _closeMenu() : _openMenu();
  });
}

function _openMenu() {
  _open      = true;
  _confirmId = null;
  _renameId  = null;
  _renderContent();
}

function _closeMenu() {
  _open      = false;
  _confirmId = null;
  _renameId  = null;
  _renderContent();
}

function _selectWorkspace(id) {
  if (id === _activeId) { _closeMenu(); return; }
  _activeId = id;
  if (id) localStorage.setItem(LS_KEY, id);
  else    localStorage.removeItem(LS_KEY);
  _closeMenu();
  if (id !== _prevId) {
    _prevId = id;
    _onChange(id);
  }
}

// ── Content ───────────────────────────────────────────────────────────────────

function _renderContent() {
  const trigger = document.getElementById("ws-trigger");
  const menu    = document.getElementById("ws-menu");
  if (!trigger || !menu) return;

  const active  = _workspaces.find(w => w.id === _activeId);
  const color   = active?.color ?? "#888";
  const initial = active ? active.name.trim()[0].toUpperCase() : "?";

  trigger.textContent = initial;
  trigger.title       = active?.name ?? "Workspaces";
  trigger.style.color = color;

  if (!_open) {
    menu.classList.add("hidden");
    return;
  }
  menu.classList.remove("hidden");
  menu.innerHTML = "";

  _workspaces.forEach(ws => {
    const item = document.createElement("div");
    item.className = "ws-menu-item" + (ws.id === _activeId ? " is-active" : "");

    if (_confirmId === ws.id) {
      item.innerHTML = `
        <span class="ws-confirm-msg">Deletar "<b>${esc(ws.name)}</b>"?</span>
        <button class="btn-confirm-yes">Sim</button>
        <button class="btn-confirm-no">Não</button>
      `;
      item.querySelector(".btn-confirm-yes").addEventListener("click", async (e) => {
        e.stopPropagation();
        const wasActive = _activeId === ws.id;
        _confirmId = null;
        await deleteWorkspace(_wsUid, ws.id);
        if (wasActive) {
          const remaining = _workspaces.filter(x => x.id !== ws.id);
          _selectWorkspace(remaining[0]?.id ?? null);
        }
      });
      item.querySelector(".btn-confirm-no").addEventListener("click", (e) => {
        e.stopPropagation();
        _confirmId = null;
        _renderContent();
      });

    } else if (_renameId === ws.id) {
      item.innerHTML = `
        <span class="ws-item-dot" style="background:${ws.color}"></span>
        <input class="form-input ws-rename-input" value="${esc(ws.name)}" />
      `;
      const input = item.querySelector(".ws-rename-input");
      requestAnimationFrame(() => { input.focus(); input.select(); });

      let done = false;
      const save = async () => {
        if (done) return; done = true;
        const name = input.value.trim();
        if (name && name !== ws.name) await updateWorkspace(_wsUid, ws.id, { name });
        _renameId = null;
        _renderContent();
      };
      const cancel = () => {
        if (done) return; done = true;
        _renameId = null;
        _renderContent();
      };

      input.addEventListener("click",   e => e.stopPropagation());
      input.addEventListener("blur",    save);
      input.addEventListener("keydown", e => {
        if (e.key === "Enter")  { e.preventDefault(); input.blur(); }
        if (e.key === "Escape") { e.preventDefault(); cancel(); }
      });

    } else {
      item.innerHTML = `
        <span class="ws-item-dot" style="background:${ws.color}"></span>
        <span class="ws-item-name">${esc(ws.name)}</span>
        <button class="btn-ws-action btn-ws-rename" title="Renomear">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
          </svg>
        </button>
        <button class="btn-ws-action btn-ws-delete" title="Deletar">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6l-1 14H6L5 6"/>
            <path d="M10 11v6M14 11v6"/>
            <path d="M9 6V4h6v2"/>
          </svg>
        </button>
      `;
      item.querySelector(".ws-item-dot").addEventListener("click",  e => { e.stopPropagation(); _selectWorkspace(ws.id); });
      item.querySelector(".ws-item-name").addEventListener("click", e => { e.stopPropagation(); _selectWorkspace(ws.id); });
      item.querySelector(".btn-ws-rename").addEventListener("click", e => {
        e.stopPropagation();
        _renameId  = ws.id;
        _confirmId = null;
        _renderContent();
      });
      item.querySelector(".btn-ws-delete").addEventListener("click", e => {
        e.stopPropagation();
        _confirmId = ws.id;
        _renameId  = null;
        _renderContent();
      });
    }

    menu.appendChild(item);
  });

  // Rodapé
  const footer = document.createElement("div");
  footer.className = "ws-menu-footer";
  footer.innerHTML = `<button class="btn-new-ws">+ Novo workspace</button>`;
  footer.querySelector(".btn-new-ws").addEventListener("click", (e) => {
    e.stopPropagation();
    _showCreateDialog();
  });
  menu.appendChild(footer);
}

// ── Create dialog ─────────────────────────────────────────────────────────────

function _showCreateDialog() {
  let dialog = document.getElementById("ws-create-dialog");

  if (!dialog) {
    dialog = document.createElement("dialog");
    dialog.id        = "ws-create-dialog";
    dialog.className = "confirm-dialog";
    document.body.appendChild(dialog);
    dialog.addEventListener("click", e => { if (e.target === dialog) dialog.close(); });
  }

  let selectedColor = WORKSPACE_COLORS[0];

  dialog.innerHTML = `
    <p class="confirm-dialog-title">Novo workspace</p>
    <div class="ws-form">
      <input class="form-input ws-name-input" placeholder="Nome do workspace" />
      <div class="tag-color-swatches" style="margin-top:10px">
        ${WORKSPACE_COLORS.map(c => `
          <button class="color-swatch${c === selectedColor ? " is-active" : ""}"
                  style="background:${c}" data-color="${c}"></button>
        `).join("")}
      </div>
    </div>
    <div class="confirm-dialog-btns" style="margin-top:20px">
      <button class="btn-ghost btn-sm btn-ws-cancel">Cancelar</button>
      <button class="btn-primary btn-sm btn-ws-create">Criar</button>
    </div>
  `;

  const input     = dialog.querySelector(".ws-name-input");
  const swatches  = dialog.querySelectorAll(".color-swatch");
  const createBtn = dialog.querySelector(".btn-ws-create");
  const cancelBtn = dialog.querySelector(".btn-ws-cancel");

  swatches.forEach(s => s.addEventListener("click", () => {
    swatches.forEach(x => x.classList.remove("is-active"));
    s.classList.add("is-active");
    selectedColor = s.dataset.color;
  }));

  const submit = async () => {
    const name = input.value.trim();
    if (!name) { input.focus(); return; }
    createBtn.disabled = true;
    try {
      await createWorkspace(_wsUid, name, selectedColor);
      dialog.close();
    } catch {
      createBtn.disabled = false;
    }
  };

  createBtn.addEventListener("click", submit);
  cancelBtn.addEventListener("click", () => dialog.close());
  input.addEventListener("keydown", e => {
    if (e.key === "Enter")  submit();
    if (e.key === "Escape") dialog.close();
  });

  dialog.showModal();
  input.focus();
}
