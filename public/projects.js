import { db } from "./firebase.js";
import {
  collection,
  doc,
  addDoc,
  getDocs,
  updateDoc,
  onSnapshot,
  query,
  where,
  orderBy,
  serverTimestamp,
  writeBatch,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function projectsRef(workspaceId) {
  return collection(db, "workspaces", workspaceId, "projects");
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
  return addDoc(projectsRef(workspaceId), {
    name,
    order: Date.now(),
    workspaceId,
    createdAt: serverTimestamp(),
  });
}

export function getProjects(uid, workspaceId, callback) {
  const q = query(projectsRef(workspaceId), orderBy("order"));
  return onSnapshot(q, (snap) =>
    callback(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
  );
}

export async function updateProject(uid, workspaceId, projectId, data) {
  return updateDoc(doc(db, "workspaces", workspaceId, "projects", projectId), data);
}

export async function deleteProject(uid, workspaceId, projectId) {
  const batch = writeBatch(db);

  const colsSnap = await getDocs(
    query(collection(db, "workspaces", workspaceId, "columns"), where("projectId", "==", projectId)),
  );
  for (const colDoc of colsSnap.docs) {
    const tasksSnap = await getDocs(
      query(collection(db, "workspaces", workspaceId, "tasks"), where("columnId", "==", colDoc.id)),
    );
    for (const taskDoc of tasksSnap.docs) {
      const subsSnap = await getDocs(
        query(collection(db, "workspaces", workspaceId, "subtasks"), where("taskId", "==", taskDoc.id)),
      );
      subsSnap.docs.forEach((s) => batch.delete(s.ref));
      batch.delete(taskDoc.ref);
    }
    batch.delete(colDoc.ref);
  }

  const tagsSnap = await getDocs(
    query(collection(db, "workspaces", workspaceId, "tags"), where("projectId", "==", projectId)),
  );
  tagsSnap.docs.forEach((t) => batch.delete(t.ref));

  batch.delete(doc(db, "workspaces", workspaceId, "projects", projectId));
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
let _editId      = null;
let _prevSelected = null;
let _loaded       = false;

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
  _editId       = null;
  _prevSelected = null;
  _loaded       = false;
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
  _editId    = null;
  _renderContent();
}
function _closeMenu() {
  _open      = false;
  _confirmId = null;
  _editId    = null;
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

  if (!_loaded) {
    _loaded = true;
    const drop = document.getElementById("project-dropdown");
    const sep  = document.querySelector(".navbar-sep");
    if (drop) drop.classList.add("navbar-item-loaded", "navbar-item-loaded--delay");
    if (sep)  sep.classList.add("navbar-item-loaded", "navbar-item-loaded--delay");
  }

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
    } else if (_editId === p.id) {
      item.innerHTML = `
        <input class="form-input item-edit-input" value="${esc(p.name)}" />
        <button class="btn-confirm-yes">✓</button>
        <button class="btn-confirm-no">✕</button>
      `;
      const input = item.querySelector(".item-edit-input");
      input.addEventListener("click", (e) => e.stopPropagation());
      input.focus();
      input.select();

      const save = async () => {
        const name = input.value.trim();
        if (!name || name === p.name) { _editId = null; _renderContent(); return; }
        await updateProject(_uid, _workspaceId, p.id, { name });
        _editId = null;
      };

      item.querySelector(".btn-confirm-yes").addEventListener("click", (e) => { e.stopPropagation(); save(); });
      item.querySelector(".btn-confirm-no").addEventListener("click", (e) => { e.stopPropagation(); _editId = null; _renderContent(); });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") save();
        if (e.key === "Escape") { _editId = null; _renderContent(); }
      });
      input.addEventListener("blur", () => { setTimeout(save, 150); });
    } else {
      item.innerHTML = `
        <span class="item-name">${esc(p.name)}</span>
        <div class="item-actions">
          <button class="btn-edit-proj" title="Renomear projeto">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
            </svg>
          </button>
          <button class="btn-del-proj" title="Deletar projeto">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6l-1 14H6L5 6"/>
              <path d="M10 11v6M14 11v6"/>
              <path d="M9 6V4h6v2"/>
            </svg>
          </button>
        </div>
      `;
      item.querySelector(".item-name").addEventListener("click", (e) => {
        e.stopPropagation();
        _selectProject(p.id);
      });
      item.querySelector(".btn-edit-proj").addEventListener("click", (e) => {
        e.stopPropagation();
        _confirmId = null;
        _editId    = p.id;
        _renderContent();
      });
      item.querySelector(".btn-del-proj").addEventListener("click", (e) => {
        e.stopPropagation();
        _editId    = null;
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
