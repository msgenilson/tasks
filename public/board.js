import { db } from "./firebase.js";
import {
  collection, doc, setDoc, getDoc, getDocs, updateDoc, onSnapshot,
  query, where, writeBatch, arrayUnion, arrayRemove
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { getTasks, createTask, openDrawer, closeDrawer } from "./tasks.js";
import { initColumnDrag, initTaskDrag, destroyDrag } from "./drag.js";
import { getTags } from "./tags.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function esc(str) {
  return String(str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function columnsRef(workspaceId) {
  return collection(db, "workspaces", workspaceId, "columns");
}

function columnDoc(workspaceId, columnId) {
  return doc(db, "workspaces", workspaceId, "columns", columnId);
}

function projectDoc(workspaceId, projectId) {
  return doc(db, "workspaces", workspaceId, "projects", projectId);
}

// ── CRUD — colunas são compartilhadas pelo workspace; cada projeto guarda,
// em visibleColumnIds, quais exibe e em que ordem (a posição no array É a
// ordem — sem campo "order" separado, sem tabela de junção) ───────────────────

export async function createColumn(uid, workspaceId, projectId, name) {
  const colRef = doc(columnsRef(workspaceId));
  await setDoc(colRef, { name, workspaceId });
  await updateDoc(projectDoc(workspaceId, projectId), {
    visibleColumnIds: arrayUnion(colRef.id),
  });
  return colRef;
}

// Todas as colunas do workspace (não filtradas por projeto) — usado pra
// listar "colunas existentes" ao adicionar, e na tela de gerenciamento.
export function getWorkspaceColumns(workspaceId, callback) {
  return onSnapshot(columnsRef(workspaceId), snap =>
    callback(snap.docs.map(d => ({ id: d.id, ...d.data() })))
  );
}

export function getColumns(uid, workspaceId, projectId, callback) {
  let latestVisible = null;
  let latestCols    = null;

  const emit = () => {
    if (!latestVisible || !latestCols) return;
    const byId = new Map(latestCols.map(c => [c.id, c]));
    callback(latestVisible.map(id => byId.get(id)).filter(Boolean));
  };

  const unsubProject = onSnapshot(projectDoc(workspaceId, projectId), (snap) => {
    latestVisible = snap.exists() ? (snap.data().visibleColumnIds || []) : [];
    emit();
  });
  const unsubCols = getWorkspaceColumns(workspaceId, (cols) => {
    latestCols = cols;
    emit();
  });

  return () => { unsubProject(); unsubCols(); };
}

export async function updateColumn(uid, workspaceId, projectId, columnId, data) {
  return updateDoc(columnDoc(workspaceId, columnId), data);
}

// Tira a coluna da visibilidade DESTE projeto só — a coluna e as tasks dela
// continuam existindo pros outros projetos que a exibem. Bloqueado se o
// projeto ainda tiver tasks nessa coluna, pra elas não sumirem sem querer.
export async function removeColumnFromProject(uid, workspaceId, projectId, columnId) {
  const tasksSnap = await getDocs(
    query(
      collection(db, "workspaces", workspaceId, "tasks"),
      where("columnId", "==", columnId),
      where("projectId", "==", projectId)
    )
  );
  if (!tasksSnap.empty) {
    const err = new Error(`${tasksSnap.size} task${tasksSnap.size > 1 ? "s" : ""} nessa coluna`);
    err.code = "column/has-tasks";
    throw err;
  }
  return updateDoc(projectDoc(workspaceId, projectId), {
    visibleColumnIds: arrayRemove(columnId),
  });
}

export async function addExistingColumnToProject(workspaceId, projectId, columnId) {
  return updateDoc(projectDoc(workspaceId, projectId), {
    visibleColumnIds: arrayUnion(columnId),
  });
}

// Quantos projetos exibem a coluna e quantas tasks (de qualquer projeto)
// estão nela — usado pra avisar antes de deletar de vez.
export async function getColumnUsage(workspaceId, columnId) {
  const [projectsSnap, tasksSnap] = await Promise.all([
    getDocs(query(collection(db, "workspaces", workspaceId, "projects"), where("visibleColumnIds", "array-contains", columnId))),
    getDocs(query(collection(db, "workspaces", workspaceId, "tasks"), where("columnId", "==", columnId))),
  ]);
  return { projectCount: projectsSnap.size, taskCount: tasksSnap.size, projectDocs: projectsSnap.docs };
}

// Deleta a coluna de vez: doc da coluna + todas as tasks/subtasks nela (em
// qualquer projeto) + remove de visibleColumnIds de todo mundo que a tinha.
export async function deleteColumnEntirely(workspaceId, columnId) {
  const { projectDocs } = await getColumnUsage(workspaceId, columnId);
  const batch = writeBatch(db);

  const tasksSnap = await getDocs(
    query(collection(db, "workspaces", workspaceId, "tasks"), where("columnId", "==", columnId))
  );
  for (const taskDoc of tasksSnap.docs) {
    const subsSnap = await getDocs(
      query(collection(db, "workspaces", workspaceId, "subtasks"), where("taskId", "==", taskDoc.id))
    );
    subsSnap.docs.forEach(s => batch.delete(s.ref));
    batch.delete(taskDoc.ref);
  }
  batch.delete(columnDoc(workspaceId, columnId));
  projectDocs.forEach(p => batch.update(p.ref, { visibleColumnIds: arrayRemove(columnId) }));

  return batch.commit();
}

// ── Board state ───────────────────────────────────────────────────────────────

let _unsubCols    = null;
let _unsubTags    = null;
let _loadingTimer = null;
const _taskUnsubs = new Map();
const _tags       = new Map();
const _cardCache  = new Map();   // columnId → { listEl, tasks, uid, workspaceId, projectId, columnId }
const _colFilters = new Map();
const _colLoaded  = new Set();   // columns that have already shown their first cards
let _boardUid     = null;
let _boardWsId    = null;
let _boardProjId  = null;

function _filterKey(columnId) {
  return `kanban_filter_${_boardProjId}_${columnId}`;
}

function _defaultFilter() { return { days: 0, tags: [], priorities: [] }; }

function _isFilterActive(f) {
  return f.days > 0 || f.tags.length > 0 || f.priorities.length > 0;
}

function _loadFilter(columnId) {
  const v = localStorage.getItem(_filterKey(columnId));
  if (!v) return _defaultFilter();
  try {
    const p = JSON.parse(v);
    if (typeof p === "number") return { days: p, tags: [], priorities: [] };
    return { days: p.days || 0, tags: p.tags || [], priorities: p.priorities || [] };
  } catch { return _defaultFilter(); }
}

function _saveFilter(columnId, filter) {
  _colFilters.set(columnId, filter);
  if (_isFilterActive(filter)) localStorage.setItem(_filterKey(columnId), JSON.stringify(filter));
  else                         localStorage.removeItem(_filterKey(columnId));
}

function _applyFilter(tasks, filter) {
  let result = tasks;
  if (filter.days) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - filter.days);
    const cutoffStr = cutoff.toISOString().split("T")[0];
    result = result.filter(t => !t.completedDate || t.completedDate >= cutoffStr);
  }
  if (filter.priorities.length > 0) {
    result = result.filter(t => filter.priorities.includes(t.priority || ""));
  }
  if (filter.tags.length > 0) {
    result = result.filter(t => filter.tags.some(id => (t.tagIds || []).includes(id)));
  }
  return result;
}

function _cleanupTasks() {
  _taskUnsubs.forEach(fn => fn());
  _taskUnsubs.clear();
  _cardCache.clear();
  _colLoaded.clear();
}

// ── Public ────────────────────────────────────────────────────────────────────

export function destroyBoard() {
  if (_loadingTimer) { clearTimeout(_loadingTimer); _loadingTimer = null; }
  if (_unsubCols) { _unsubCols(); _unsubCols = null; }
  if (_unsubTags) { _unsubTags(); _unsubTags = null; }
  _cleanupTasks();
  _tags.clear();
  destroyDrag();
  closeDrawer();
  _boardUid    = null;
  _boardWsId   = null;
  _boardProjId = null;
  document.getElementById("board-area").innerHTML = "";
}

export function initBoard(uid, workspaceId, projectId) {
  if (!projectId) {
    destroyBoard();
    _showNoProjects();
    return;
  }

  if (uid === _boardUid && workspaceId === _boardWsId && projectId === _boardProjId) return;

  destroyBoard();
  _boardUid    = uid;
  _boardWsId   = workspaceId;
  _boardProjId = projectId;

  const boardEl = document.getElementById("board-area");
  boardEl.innerHTML = "";
  _loadingTimer = setTimeout(() => {
    _loadingTimer = null;
    boardEl.innerHTML = `<div class="board-loading"><div class="board-spinner"></div></div>`;
  }, 280);

  // Subscrição de tags — re-renderiza cards ao mudar
  _unsubTags = getTags(uid, workspaceId, projectId, (tagsList) => {
    _tags.clear();
    tagsList.forEach(t => _tags.set(t.id, t));
    _cardCache.forEach(({ listEl, tasks, uid: u, workspaceId: w, projectId: p, columnId }) => {
      if (listEl.isConnected) _renderCards(listEl, tasks, u, w, p, columnId);
    });
  });

  _unsubCols = getColumns(uid, workspaceId, projectId, (columns) => {
    if (_loadingTimer) { clearTimeout(_loadingTimer); _loadingTimer = null; }
    _cleanupTasks();
    destroyDrag();
    boardEl.innerHTML = "";

    if (columns.length === 0) {
      boardEl.appendChild(_emptyColsEl());
    } else {
      columns.forEach((col, i) => {
        const colEl = _createColEl(col, uid, workspaceId, projectId);
        colEl.classList.add("col-appear");
        colEl.style.animationDelay = `${i * 60}ms`;
        boardEl.appendChild(colEl);

        initTaskDrag(colEl, uid, workspaceId, projectId);

        const unsub = getTasks(uid, workspaceId, projectId, col.id, (tasks) => {
          const list    = colEl.querySelector(".task-list");
          const counter = colEl.querySelector(".col-count");
          if (list)    _renderCards(list, tasks, uid, workspaceId, projectId, col.id);
          if (counter) counter.textContent = tasks.length > 0 ? tasks.length : "";
        });
        _taskUnsubs.set(col.id, unsub);
      });

      initColumnDrag(boardEl, uid, workspaceId, projectId);
    }

    boardEl.appendChild(_addColWrap(uid, workspaceId, projectId, columns.length));
  });
}

// ── Skeleton ──────────────────────────────────────────────────────────────────

function _colSkeletonCards() {
  return `
    <li class="task-card sk-card"></li>
    <li class="task-card sk-card sk-card--md"></li>
    <li class="task-card sk-card sk-card--sm"></li>
  `;
}

// ── Empty states ──────────────────────────────────────────────────────────────

function _showNoProjects() {
  document.getElementById("board-area").innerHTML = `
    <div class="empty-board">
      <p class="empty-title">Nenhum projeto ainda</p>
      <p class="empty-sub">Crie um projeto pelo menu acima para começar.</p>
    </div>
  `;
}

function _emptyColsEl() {
  const el = document.createElement("div");
  el.className = "empty-board col-appear";
  el.innerHTML = `
    <p class="empty-title">Nenhuma coluna ainda</p>
    <p class="empty-sub">Adicione uma coluna para começar a organizar suas tasks.</p>
  `;
  return el;
}

// ── Column ────────────────────────────────────────────────────────────────────

function _createColEl(col, uid, workspaceId, projectId) {
  const el = document.createElement("div");
  el.className  = "column";
  el.dataset.colId = col.id;

  const filter = _loadFilter(col.id);
  _colFilters.set(col.id, filter);

  el.innerHTML = `
    <div class="col-header">
      <div class="col-header-left">
        <span class="col-drag-handle" title="Arrastar coluna">
          <svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor">
            <circle cx="3" cy="3"  r="1.5"/><circle cx="7" cy="3"  r="1.5"/>
            <circle cx="3" cy="8"  r="1.5"/><circle cx="7" cy="8"  r="1.5"/>
            <circle cx="3" cy="13" r="1.5"/><circle cx="7" cy="13" r="1.5"/>
          </svg>
        </span>
        <span class="col-name">${esc(col.name)}</span>
        <span class="col-count"></span>
      </div>
      <div class="col-header-right">
        <div class="col-filter-wrap">
          <button class="btn-col-filter${_isFilterActive(filter) ? " is-active" : ""}" title="Filtrar tasks">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>
            </svg>
          </button>
          <div class="col-filter-menu hidden"></div>
        </div>
        <button class="btn-col-menu" title="Opções">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/>
          </svg>
        </button>
        <div class="col-menu hidden">
          <button class="col-menu-item btn-rename-col">Renomear</button>
          <button class="col-menu-item btn-delete-col">Remover deste projeto</button>
        </div>
      </div>
    </div>
    <ul class="task-list">${_colSkeletonCards()}</ul>
    <div class="col-hidden-notice hidden"></div>
    <div class="col-footer">
      <button class="btn-add-task">+ Adicionar task</button>
    </div>
  `;

  _bindColEvents(el, col, uid, workspaceId, projectId);
  return el;
}

function _bindColEvents(el, col, uid, workspaceId, projectId) {
  const menuBtn    = el.querySelector(".btn-col-menu");
  const menu       = el.querySelector(".col-menu");
  const filterBtn  = el.querySelector(".btn-col-filter");
  const filterMenu = el.querySelector(".col-filter-menu");

  filterBtn.addEventListener("click", (e) => {
    document.querySelectorAll(".col-filter-menu").forEach(m => { if (m !== filterMenu) m.classList.add("hidden"); });
    document.querySelectorAll(".col-menu").forEach(m => m.classList.add("hidden"));
    if (filterMenu.classList.contains("hidden")) {
      _renderFilterMenu(filterMenu, col);
      filterMenu.classList.remove("hidden");
    } else {
      filterMenu.classList.add("hidden");
    }
  });

  filterMenu.addEventListener("click", (e) => {
    e.stopPropagation();

    const daysBtn = e.target.closest(".filter-opt[data-days]");
    if (daysBtn) {
      const days = Number(daysBtn.dataset.days);
      const cur  = _colFilters.get(col.id) || _defaultFilter();
      _saveFilter(col.id, { ...cur, days: cur.days === days ? 0 : days });
      _syncFilterCards(col.id, uid, workspaceId, projectId, filterBtn);
      filterMenu.classList.add("hidden");
      return;
    }

    const priorityBtn = e.target.closest(".filter-pill-opt[data-priority]");
    if (priorityBtn) {
      const p        = priorityBtn.dataset.priority;
      const cur      = _colFilters.get(col.id) || _defaultFilter();
      const isActive = cur.priorities.includes(p);
      _saveFilter(col.id, { ...cur, priorities: isActive ? cur.priorities.filter(x => x !== p) : [...cur.priorities, p] });
      priorityBtn.classList.toggle("is-active", !isActive);
      _syncFilterCards(col.id, uid, workspaceId, projectId, filterBtn);
      _syncFilterClear(filterMenu, col.id);
      return;
    }

    const tagBtn = e.target.closest(".filter-pill-opt[data-tag-id]");
    if (tagBtn) {
      const tagId    = tagBtn.dataset.tagId;
      const cur      = _colFilters.get(col.id) || _defaultFilter();
      const isActive = cur.tags.includes(tagId);
      _saveFilter(col.id, { ...cur, tags: isActive ? cur.tags.filter(x => x !== tagId) : [...cur.tags, tagId] });
      tagBtn.classList.toggle("is-active", !isActive);
      _syncFilterCards(col.id, uid, workspaceId, projectId, filterBtn);
      _syncFilterClear(filterMenu, col.id);
      return;
    }

    if (e.target.closest(".filter-clear-all")) {
      _saveFilter(col.id, _defaultFilter());
      _syncFilterCards(col.id, uid, workspaceId, projectId, filterBtn);
      filterMenu.classList.add("hidden");
    }
  });

  menuBtn.addEventListener("click", (e) => {
    document.querySelectorAll(".col-filter-menu").forEach(m => m.classList.add("hidden"));
    document.querySelectorAll(".col-menu").forEach(m => { if (m !== menu) m.classList.add("hidden"); });
    menu.classList.toggle("hidden");
  });

  el.querySelector(".btn-rename-col").addEventListener("click", () => {
    menu.classList.add("hidden");
    _startRename(el, col, uid, workspaceId, projectId);
  });

  const deleteBtn = el.querySelector(".btn-delete-col");
  let _deleteArmed = false;
  let _deleteTimer = null;

  const _restoreDeleteBtn = () => {
    _deleteArmed = false;
    deleteBtn.textContent = "Remover deste projeto";
    deleteBtn.classList.remove("btn-delete-col-confirm", "btn-delete-col-error");
  };

  deleteBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!_deleteArmed) {
      _deleteArmed = true;
      deleteBtn.textContent = "Confirmar remoção?";
      deleteBtn.classList.add("btn-delete-col-confirm");
      _deleteTimer = setTimeout(_restoreDeleteBtn, 3000);
    } else {
      clearTimeout(_deleteTimer);
      try {
        await removeColumnFromProject(uid, workspaceId, projectId, col.id);
        menu.classList.add("hidden");
      } catch (err) {
        deleteBtn.textContent = err.code === "column/has-tasks" ? `Mova ${err.message} antes` : "Erro ao remover";
        deleteBtn.classList.remove("btn-delete-col-confirm");
        deleteBtn.classList.add("btn-delete-col-error");
        _deleteArmed = false;
        _deleteTimer = setTimeout(_restoreDeleteBtn, 2500);
      }
    }
  });

  el.querySelector(".btn-add-task").addEventListener("click", () => {
    _showAddTaskInput(el, uid, workspaceId, projectId, col.id);
  });
}

function _startRename(el, col, uid, workspaceId, projectId) {
  const nameSpan = el.querySelector(".col-name");
  const input    = document.createElement("input");
  input.className = "col-name-input form-input";
  input.value     = col.name;
  nameSpan.replaceWith(input);
  input.focus();
  input.select();

  let done = false;

  const restore = () => {
    const span = document.createElement("span");
    span.className   = "col-name";
    span.textContent = col.name;
    input.replaceWith(span);
  };

  const save = async () => {
    if (done) return; done = true;
    const name = input.value.trim();
    if (name && name !== col.name) await updateColumn(uid, workspaceId, projectId, col.id, { name });
    else restore();
  };

  const cancel = () => { if (done) return; done = true; restore(); };

  input.addEventListener("blur", save);
  input.addEventListener("keydown", e => {
    if (e.key === "Enter")  { e.preventDefault(); input.blur(); }
    if (e.key === "Escape") { e.preventDefault(); cancel(); }
  });
}

// ── Task cards ────────────────────────────────────────────────────────────────

function _renderCards(listEl, tasks, uid, workspaceId, projectId, columnId) {
  _cardCache.set(columnId, { listEl, tasks, uid, workspaceId, projectId, columnId });

  const filter   = _colFilters.get(columnId) || _defaultFilter();
  const filtered = _applyFilter(tasks, filter);
  const hidden   = tasks.length - filtered.length;

  const notice = listEl.closest(".column")?.querySelector(".col-hidden-notice");
  if (notice) {
    if (hidden > 0) {
      notice.textContent = `${hidden} tarefa${hidden > 1 ? "s" : ""} antiga${hidden > 1 ? "s" : ""} oculta${hidden > 1 ? "s" : ""}`;
      notice.classList.remove("hidden");
    } else {
      notice.classList.add("hidden");
    }
  }

  listEl.innerHTML = "";

  const firstLoad = !_colLoaded.has(columnId);
  if (firstLoad) _colLoaded.add(columnId);

  filtered.forEach((task, i) => {
    const li = document.createElement("li");
    li.className        = "task-card";
    li.dataset.taskId   = task.id;
    li.dataset.priority = task.priority || "";

    if (firstLoad) {
      li.classList.add("card-appear");
      li.style.animationDelay = `${Math.min(i * 50, 300)}ms`;
    }

    const total = task.subtaskCount || 0;
    const done  = task.subtaskDone  || 0;
    const pct   = total > 0 ? Math.round(done / total * 100) : 0;

    const taskTags = (task.tagIds || []).map(id => _tags.get(id)).filter(Boolean);

    li.innerHTML = `
      ${taskTags.length ? `<div class="card-tags">${taskTags.map(t =>
        `<span class="card-tag" style="background:${t.color}22;color:${t.color};border-color:${t.color}44">${esc(t.name)}</span>`
      ).join("")}</div>` : ""}
      <div class="task-title-row">
        ${_priorityFlagHtml(task.priority)}
        <span class="task-title">${esc(task.title)}</span>
      </div>
      ${total > 0 ? `
        <div class="task-progress">
          <div class="task-progress-bar">
            <div class="task-progress-fill" style="width:${pct}%"></div>
          </div>
          <span class="task-progress-text">${done}/${total}</span>
        </div>` : ""}
      ${_dueDateHtml(task.completedDate)}
    `;

    li.addEventListener("click", () => openDrawer(task, columnId, uid, workspaceId, projectId));
    listEl.appendChild(li);
  });
}

// ── Filter menu ───────────────────────────────────────────────────────────────

const _FILTER_PRIORITIES = [
  { key: "low",    label: "Baixa",   color: "#22c55e" },
  { key: "medium", label: "Média",   color: "#eab308" },
  { key: "high",   label: "Alta",    color: "#f97316" },
  { key: "urgent", label: "Urgente", color: "#ef4444" },
];

function _syncFilterCards(columnId, uid, workspaceId, projectId, filterBtn) {
  const cached = _cardCache.get(columnId);
  if (cached) _renderCards(cached.listEl, cached.tasks, uid, workspaceId, projectId, columnId);
  filterBtn.classList.toggle("is-active", _isFilterActive(_colFilters.get(columnId) || _defaultFilter()));
}

function _syncFilterClear(menuEl, columnId) {
  const active = _isFilterActive(_colFilters.get(columnId) || _defaultFilter());
  menuEl.querySelector(".filter-clear-all")?.classList.toggle("hidden", !active);
  menuEl.querySelector(".filter-sep-clear")?.classList.toggle("hidden", !active);
}

function _renderFilterMenu(menuEl, col) {
  const f    = _colFilters.get(col.id) || _defaultFilter();
  const tags = [..._tags.values()];

  menuEl.innerHTML = `
    <div class="filter-section-label">Data de conclusão</div>
    ${[7, 30, 90].map(d => `
      <button class="filter-opt${f.days === d ? " is-active" : ""}" data-days="${d}">Últimos ${d} dias</button>
    `).join("")}

    <div class="filter-sep"></div>
    <div class="filter-section-label">Prioridade</div>
    <div class="filter-pill-row">
      ${_FILTER_PRIORITIES.map(p => `
        <button class="filter-pill-opt${f.priorities.includes(p.key) ? " is-active" : ""}"
                data-priority="${p.key}" style="--pc:${p.color};--pc-bg:${p.color}22">${p.label}</button>
      `).join("")}
    </div>

    ${tags.length > 0 ? `
      <div class="filter-sep"></div>
      <div class="filter-section-label">Tag</div>
      <div class="filter-pill-row">
        ${tags.map(t => `
          <button class="filter-pill-opt${f.tags.includes(t.id) ? " is-active" : ""}"
                  data-tag-id="${t.id}" style="--pc:${t.color};--pc-bg:${t.color}22">${esc(t.name)}</button>
        `).join("")}
      </div>
    ` : ""}

    <div class="filter-sep filter-sep-clear${_isFilterActive(f) ? "" : " hidden"}"></div>
    <button class="filter-opt filter-clear-all${_isFilterActive(f) ? "" : " hidden"}">Limpar filtros</button>
  `;
}

const _PRIORITY_COLORS = { low: "#22c55e", medium: "#eab308", high: "#f97316", urgent: "#ef4444" };

function _priorityFlagHtml(priority) {
  const color = _PRIORITY_COLORS[priority];
  if (!color) return '';
  return `<svg class="card-priority-flag" width="11" height="12" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
    <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" fill="${color}"/>
    <line x1="4" y1="22" x2="4" y2="15" stroke="${color}" stroke-width="2.5" stroke-linecap="round"/>
  </svg>`;
}

function _dueDateHtml(dueDate) {
  if (!dueDate) return "";
  const d     = new Date(dueDate + "T00:00:00");
  const label = d.toLocaleDateString("pt-BR", { day: "numeric", month: "short", year: "numeric" });
  return `<span class="card-due"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> ${label}</span>`;
}

// ── Add task inline ───────────────────────────────────────────────────────────

function _showAddTaskInput(colEl, uid, workspaceId, projectId, columnId) {
  const footer = colEl.querySelector(".col-footer");
  footer.innerHTML = `
    <div class="add-task-input-wrap">
      <input class="form-input add-task-input" placeholder="Título da task" />
      <div class="add-task-btns">
        <button class="btn-primary btn-sm">Adicionar</button>
        <button class="btn-ghost btn-sm">✕</button>
      </div>
    </div>
  `;

  const input               = footer.querySelector("input");
  const [addBtn, cancelBtn] = footer.querySelectorAll("button");
  input.focus();

  const restore = () => {
    footer.innerHTML = `<button class="btn-add-task">+ Adicionar task</button>`;
    footer.querySelector(".btn-add-task").addEventListener("click", () => {
      _showAddTaskInput(colEl, uid, workspaceId, projectId, columnId);
    });
  };

  const submit = async () => {
    const title = input.value.trim();
    if (title) {
      await createTask(uid, workspaceId, projectId, columnId, title);
      input.value = "";
      input.focus();
    }
  };

  addBtn.addEventListener("click", submit);
  cancelBtn.addEventListener("click", restore);
  input.addEventListener("keydown", e => {
    if (e.key === "Enter")  { e.preventDefault(); submit(); }
    if (e.key === "Escape") restore();
  });
}

// ── Add column ────────────────────────────────────────────────────────────────

function _addColWrap(uid, workspaceId, projectId, colCount = 0) {
  const wrap = document.createElement("div");
  wrap.className = "add-col-wrap col-appear";
  wrap.style.animationDelay = `${colCount * 60 + 40}ms`;
  _showAddColBtn(wrap, uid, workspaceId, projectId);
  return wrap;
}

function _showAddColBtn(wrap, uid, workspaceId, projectId) {
  wrap.innerHTML = `
    <button class="btn-add-col">+ Adicionar coluna</button>
    <button class="btn-manage-cols" title="Gerenciar colunas do workspace">Gerenciar colunas</button>
  `;
  wrap.querySelector(".btn-add-col").addEventListener("click", () => _showAddColInput(wrap, uid, workspaceId, projectId));
  wrap.querySelector(".btn-manage-cols").addEventListener("click", () => _showManageColumnsDialog(workspaceId));
}

async function _showAddColInput(wrap, uid, workspaceId, projectId) {
  wrap.innerHTML = `<div class="add-col-input-wrap"><span class="add-col-loading">Carregando…</span></div>`;

  const [projSnap, allColsSnap] = await Promise.all([
    getDoc(projectDoc(workspaceId, projectId)),
    getDocs(columnsRef(workspaceId)),
  ]);
  const visibleIds = new Set(projSnap.exists() ? (projSnap.data().visibleColumnIds || []) : []);
  const hidden = allColsSnap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(c => !visibleIds.has(c.id));

  wrap.innerHTML = `
    <div class="add-col-input-wrap">
      ${hidden.length > 0 ? `
        <div class="add-col-existing-label">Colunas existentes no workspace</div>
        <div class="add-col-existing-list">
          ${hidden.map(c => `<button class="add-col-existing-pill" data-col-id="${c.id}">+ ${esc(c.name)}</button>`).join("")}
        </div>
        <div class="add-col-existing-sep"></div>
      ` : ""}
      <input class="form-input" placeholder="Nome da coluna nova" />
      <div class="add-col-btns">
        <button class="btn-primary btn-sm">Adicionar</button>
        <button class="btn-ghost btn-sm">✕</button>
      </div>
    </div>
  `;

  wrap.querySelectorAll(".add-col-existing-pill").forEach(pill => {
    pill.addEventListener("click", async () => {
      await addExistingColumnToProject(workspaceId, projectId, pill.dataset.colId);
      _showAddColBtn(wrap, uid, workspaceId, projectId);
    });
  });

  const input               = wrap.querySelector("input");
  const [addBtn, cancelBtn] = wrap.querySelectorAll(".add-col-btns button");
  input.focus();

  const submit = async () => {
    const name = input.value.trim();
    if (name) await createColumn(uid, workspaceId, projectId, name);
  };

  addBtn.addEventListener("click", submit);
  cancelBtn.addEventListener("click", () => _showAddColBtn(wrap, uid, workspaceId, projectId));
  input.addEventListener("keydown", e => {
    if (e.key === "Enter")  submit();
    if (e.key === "Escape") _showAddColBtn(wrap, uid, workspaceId, projectId);
  });
}

// ── Gerenciar colunas (deletar de vez) ──────────────────────────────────────────

async function _showManageColumnsDialog(workspaceId) {
  let dialog = document.getElementById("manage-cols-dialog");
  if (!dialog) {
    dialog = document.createElement("dialog");
    dialog.id        = "manage-cols-dialog";
    dialog.className = "confirm-dialog confirm-dialog--wide";
    document.body.appendChild(dialog);
    dialog.addEventListener("click", e => { if (e.target === dialog) dialog.close(); });
  }

  dialog.innerHTML = `
    <p class="confirm-dialog-title">Gerenciar colunas do workspace</p>
    <p class="confirm-dialog-sub">Deletar aqui remove a coluna e as tasks dela de todos os projetos que a usam — não só deste.</p>
    <div class="manage-cols-list"><span class="add-col-loading">Carregando…</span></div>
    <div class="confirm-dialog-btns" style="margin-top:16px">
      <button class="btn-ghost btn-sm btn-manage-cols-close">Fechar</button>
    </div>
  `;
  dialog.querySelector(".btn-manage-cols-close").addEventListener("click", () => dialog.close());
  dialog.showModal();

  const listEl = dialog.querySelector(".manage-cols-list");
  const colsSnap = await getDocs(columnsRef(workspaceId));
  const cols = colsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  if (cols.length === 0) {
    listEl.innerHTML = `<p class="confirm-dialog-sub">Nenhuma coluna neste workspace ainda.</p>`;
    return;
  }

  const usages = await Promise.all(cols.map(c => getColumnUsage(workspaceId, c.id)));

  listEl.innerHTML = cols.map((c, i) => `
    <div class="manage-cols-item" data-col-id="${c.id}">
      <span class="manage-cols-name">${esc(c.name)}</span>
      <span class="manage-cols-usage">${usages[i].projectCount} projeto${usages[i].projectCount === 1 ? "" : "s"} · ${usages[i].taskCount} task${usages[i].taskCount === 1 ? "" : "s"}</span>
      <button class="btn-manage-cols-delete">Deletar</button>
    </div>
  `).join("");

  listEl.querySelectorAll(".manage-cols-item").forEach(item => {
    const columnId = item.dataset.colId;
    const btn = item.querySelector(".btn-manage-cols-delete");
    let armed = false;
    let timer = null;

    btn.addEventListener("click", async () => {
      if (!armed) {
        armed = true;
        btn.textContent = "Confirmar?";
        btn.classList.add("btn-delete-col-confirm");
        timer = setTimeout(() => {
          armed = false;
          btn.textContent = "Deletar";
          btn.classList.remove("btn-delete-col-confirm");
        }, 3000);
      } else {
        clearTimeout(timer);
        btn.disabled = true;
        await deleteColumnEntirely(workspaceId, columnId);
        item.remove();
      }
    });
  });
}
