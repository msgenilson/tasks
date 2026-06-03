import { db } from "./firebase.js";
import {
  collection,
  doc,
  addDoc,
  getDocs,
  updateDoc,
  onSnapshot,
  query,
  orderBy,
  serverTimestamp,
  writeBatch,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function projectsRef(uid, workspaceId) {
  return collection(db, "users", uid, "workspaces", workspaceId, "projects");
}

function esc(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

export async function createProject(uid, workspaceId, name) {
  return addDoc(projectsRef(uid, workspaceId), {
    name,
    order: Date.now(),
    createdAt: serverTimestamp(),
  });
}

export function getProjects(uid, workspaceId, callback) {
  const q = query(projectsRef(uid, workspaceId), orderBy("order"));
  return onSnapshot(q, (snap) =>
    callback(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
  );
}

export async function updateProject(uid, workspaceId, projectId, data) {
  return updateDoc(
    doc(db, "users", uid, "workspaces", workspaceId, "projects", projectId),
    data,
  );
}

export async function deleteProject(uid, workspaceId, projectId) {
  const batch = writeBatch(db);
  const colsSnap = await getDocs(
    collection(db, "users", uid, "workspaces", workspaceId, "projects", projectId, "columns"),
  );
  for (const colDoc of colsSnap.docs) {
    const tasksSnap = await getDocs(
      collection(db, "users", uid, "workspaces", workspaceId, "projects", projectId, "columns", colDoc.id, "tasks"),
    );
    for (const taskDoc of tasksSnap.docs) {
      const subsSnap = await getDocs(
        collection(db, "users", uid, "workspaces", workspaceId, "projects", projectId, "columns", colDoc.id, "tasks", taskDoc.id, "subtasks"),
      );
      subsSnap.docs.forEach((s) => batch.delete(s.ref));
      batch.delete(taskDoc.ref);
    }
    batch.delete(colDoc.ref);
  }
  const tagsSnap = await getDocs(
    collection(db, "users", uid, "workspaces", workspaceId, "projects", projectId, "tags"),
  );
  tagsSnap.docs.forEach((t) => batch.delete(t.ref));
  batch.delete(doc(db, "users", uid, "workspaces", workspaceId, "projects", projectId));
  return batch.commit();
}

// ── UI state ──────────────────────────────────────────────────────────────────

let _uid         = null;
let _workspaceId = null;
let _onSelect    = null;
let _unsub       = null;
let _projects    = [];
let _activeId    = null;
let _open        = false;
let _confirmId   = null;
let _prevSelected = null;

function _lsKey() { return `tasks_active_project_${_workspaceId}`; }

// ── Public ────────────────────────────────────────────────────────────────────

export function initProjects(uid, workspaceId, onSelect) {
  _uid         = uid;
  _workspaceId = workspaceId;
  _onSelect    = onSelect;
  _activeId    = localStorage.getItem(_lsKey());
  _open        = false;
  _confirmId   = null;
  _prevSelected = null;

  _renderShell();

  if (_unsub) _unsub();
  _unsub = getProjects(uid, workspaceId, (projects) => {
    _projects = projects;

    if (_activeId && !projects.find((p) => p.id === _activeId)) {
      _activeId = projects[0]?.id ?? null;
    }
    if (!_activeId && projects.length > 0) {
      _activeId = projects[0].id;
    }

    if (_activeId) localStorage.setItem(_lsKey(), _activeId);
    else           localStorage.removeItem(_lsKey());

    _renderContent();

    if (_activeId !== _prevSelected) {
      _prevSelected = _activeId;
      _onSelect(_activeId);
    }
  });
}

export function destroyProjects() {
  if (_unsub) {
    _unsub();
    _unsub = null;
  }
  _projects     = [];
  _activeId     = null;
  _open         = false;
  _confirmId    = null;
  _prevSelected = null;
  const el = document.getElementById("project-dropdown");
  if (el) el.innerHTML = "";
}

export function closeProjectDropdown() {
  if (_open) {
    _open      = false;
    _confirmId = null;
    _renderContent();
  }
}

// ── Shell ─────────────────────────────────────────────────────────────────────

function _renderShell() {
  const el = document.getElementById("project-dropdown");
  el.innerHTML = `
    <button class="project-trigger" id="proj-trigger">
      <span class="active-proj-name">Carregando…</span>
      <svg class="trigger-arrow" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <polyline points="6 9 12 15 18 9"/>
      </svg>
    </button>
    <div class="dropdown-menu hidden" id="proj-menu"></div>
  `;

  document.getElementById("proj-trigger").addEventListener("click", () => {
    _open ? _closeMenu() : _openMenu();
  });
}

function _openMenu() {
  _open      = true;
  _confirmId = null;
  _renderContent();
}
function _closeMenu() {
  _open      = false;
  _confirmId = null;
  _renderContent();
}

function _selectProject(id) {
  _activeId = id;
  if (id) localStorage.setItem(_lsKey(), id);
  else    localStorage.removeItem(_lsKey());
  _closeMenu();
  if (id !== _prevSelected) {
    _prevSelected = id;
    _onSelect(id);
  }
}

// ── Content ───────────────────────────────────────────────────────────────────

function _renderContent() {
  const nameEl = document.querySelector(".active-proj-name");
  const menu   = document.getElementById("proj-menu");
  if (!nameEl || !menu) return;

  const active = _projects.find((p) => p.id === _activeId);
  nameEl.textContent =
    active?.name ?? (_projects.length === 0 ? "Sem projetos" : "Selecionar");

  if (!_open) {
    menu.classList.add("hidden");
    return;
  }
  menu.classList.remove("hidden");
  menu.innerHTML = "";

  if (_projects.length === 0) {
    const empty = document.createElement("div");
    empty.className  = "dropdown-empty";
    empty.textContent = "Nenhum projeto ainda";
    menu.appendChild(empty);
  }

  _projects.forEach((p) => {
    const item = document.createElement("div");
    item.className = "dropdown-item" + (p.id === _activeId ? " is-active" : "");

    if (_confirmId === p.id) {
      item.innerHTML = `
        <span class="confirm-msg">Deletar "<b>${esc(p.name)}</b>"?</span>
        <button class="btn-confirm-yes">Sim</button>
        <button class="btn-confirm-no">Não</button>
      `;
      item.querySelector(".btn-confirm-yes").addEventListener("click", async (e) => {
        e.stopPropagation();
        const wasActive = _activeId === p.id;
        _confirmId = null;
        await deleteProject(_uid, _workspaceId, p.id);
        if (wasActive) {
          const remaining = _projects.filter((x) => x.id !== p.id);
          _selectProject(remaining[0]?.id ?? null);
        }
      });
      item.querySelector(".btn-confirm-no").addEventListener("click", (e) => {
        e.stopPropagation();
        _confirmId = null;
        _renderContent();
      });
    } else {
      item.innerHTML = `
        <span class="item-name">${esc(p.name)}</span>
        <button class="btn-del-proj" title="Deletar projeto">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6l-1 14H6L5 6"/>
            <path d="M10 11v6M14 11v6"/>
            <path d="M9 6V4h6v2"/>
          </svg>
        </button>
      `;
      item.querySelector(".item-name").addEventListener("click", (e) => {
        e.stopPropagation();
        _selectProject(p.id);
      });
      item.querySelector(".btn-del-proj").addEventListener("click", (e) => {
        e.stopPropagation();
        _confirmId = p.id;
        _renderContent();
      });
    }

    menu.appendChild(item);
  });

  // Footer: new project
  const footer = document.createElement("div");
  footer.className = "dropdown-footer";
  footer.innerHTML = `<button class="btn-new-proj">+ Novo projeto</button>`;
  footer.querySelector(".btn-new-proj").addEventListener("click", (e) => {
    e.stopPropagation();
    _showNewProjInput(footer);
  });
  menu.appendChild(footer);
}

function _showNewProjInput(container) {
  container.innerHTML = `
    <div class="new-proj-wrap">
      <input class="form-input new-proj-input" placeholder="Nome do projeto" />
      <div class="new-proj-btns">
        <button class="btn-primary btn-sm">Adicionar</button>
        <button class="btn-ghost btn-sm">✕</button>
      </div>
    </div>
  `;

  const input = container.querySelector(".new-proj-input");
  const [addBtn, cancelBtn] = container.querySelectorAll("button");

  input.focus();
  input.addEventListener("click", (e) => e.stopPropagation());

  const setError = (msg) => {
    let err = container.querySelector(".proj-input-error");
    if (!err) {
      err = document.createElement("p");
      err.className = "proj-input-error";
      container.querySelector(".new-proj-wrap").appendChild(err);
    }
    err.textContent = msg;
  };

  const submit = async () => {
    const name = input.value.trim();
    if (!name) return;
    addBtn.disabled = true;
    try {
      const ref = await createProject(_uid, _workspaceId, name);
      _activeId     = ref.id;
      _prevSelected = ref.id;
      if (!_projects.find((p) => p.id === ref.id)) {
        _projects = [..._projects, { id: ref.id, name, order: _projects.length }];
      }
      localStorage.setItem(_lsKey(), ref.id);
      _closeMenu();
      _onSelect(ref.id);
    } catch {
      setError("Erro ao criar projeto. Verifique as permissões do Firestore.");
      addBtn.disabled = false;
    }
  };

  addBtn.addEventListener("click", submit);
  cancelBtn.addEventListener("click", () => _renderContent());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
    if (e.key === "Escape") _renderContent();
  });
}
