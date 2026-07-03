import { getAllTasks, openDrawer, closeDrawer } from "./tasks.js";
import { getWorkspaceColumns } from "./board.js";
import { getProjects } from "./projects.js";
import { initTaskDrag, destroyDrag } from "./drag.js";

function esc(str) {
  return String(str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const PRIORITY_COLORS = { low: "#22c55e", medium: "#eab308", high: "#f97316", urgent: "#ef4444" };

function _priorityFlagHtml(priority) {
  const color = PRIORITY_COLORS[priority];
  if (!color) return "";
  return `<svg class="card-priority-flag" width="11" height="12" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
    <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" fill="${color}"/>
    <line x1="4" y1="22" x2="4" y2="15" stroke="${color}" stroke-width="2.5" stroke-linecap="round"/>
  </svg>`;
}

// ── State ─────────────────────────────────────────────────────────────────────

let _uid         = null;
let _workspaceId = null;
let _unsubTasks    = null;
let _unsubCols     = null;
let _unsubProjects = null;
let _tasks    = [];
let _columns  = [];
let _projects = [];
let _filter   = { projectIds: [], subtaskStatus: "all" }; // all | pending | done
let _shellColumnKey = null; // detecta mudança real no conjunto de colunas, pra não recriar os Sortables à toa

function _lsKey() { return `tasks_globalview_filter_${_workspaceId}`; }

function _loadFilter() {
  try {
    const v = JSON.parse(localStorage.getItem(_lsKey()));
    return { projectIds: v?.projectIds || [], subtaskStatus: v?.subtaskStatus || "all" };
  } catch {
    return { projectIds: [], subtaskStatus: "all" };
  }
}

function _saveFilter() {
  localStorage.setItem(_lsKey(), JSON.stringify(_filter));
}

// ── Public ────────────────────────────────────────────────────────────────────

export function initGlobalView(uid, workspaceId) {
  destroyGlobalView();
  _uid         = uid;
  _workspaceId = workspaceId;
  _filter      = _loadFilter();
  _tasks = []; _columns = []; _projects = [];
  _shellColumnKey = null;

  const el = document.getElementById("global-view-area");
  el.innerHTML = `<div class="board-loading"><div class="board-spinner"></div></div>`;

  _unsubCols = getWorkspaceColumns(workspaceId, (cols) => {
    _columns = [...cols].sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
    _ensureShell();
    _renderCards();
  });
  _unsubTasks = getAllTasks(uid, workspaceId, (tasks) => { _tasks = tasks; _renderCards(); });
  _unsubProjects = getProjects(uid, workspaceId, (projects) => { _projects = projects; _renderFilters(); _renderCards(); });
}

export function destroyGlobalView() {
  if (_unsubTasks)    { _unsubTasks();    _unsubTasks    = null; }
  if (_unsubCols)     { _unsubCols();     _unsubCols     = null; }
  if (_unsubProjects) { _unsubProjects(); _unsubProjects = null; }
  destroyDrag();
  closeDrawer();
  _uid = null; _workspaceId = null;
  _tasks = []; _columns = []; _projects = [];
  _shellColumnKey = null;
  const el = document.getElementById("global-view-area");
  if (el) el.innerHTML = "";
}

// ── Filtro ────────────────────────────────────────────────────────────────────

function _applyFilter(tasks) {
  let result = tasks;
  if (_filter.projectIds.length > 0) {
    result = result.filter(t => _filter.projectIds.includes(t.projectId));
  }
  if (_filter.subtaskStatus === "pending") {
    result = result.filter(t => (t.subtaskCount || 0) > 0 && (t.subtaskDone || 0) < t.subtaskCount);
  } else if (_filter.subtaskStatus === "done") {
    result = result.filter(t => (t.subtaskCount || 0) > 0 && (t.subtaskDone || 0) === t.subtaskCount);
  }
  return result;
}

function _filtersHtml() {
  const subtaskOpts = [
    { key: "all", label: "Todas" },
    { key: "pending", label: "Com pendentes" },
    { key: "done", label: "Concluídas" },
  ];
  return `
    <div class="gv-filter-group">
      <span class="gv-filter-label">Projeto</span>
      <div class="gv-filter-pills">
        ${_projects.map(p => `
          <button class="gv-pill${_filter.projectIds.includes(p.id) ? " is-active" : ""}" data-project-id="${p.id}">${esc(p.name)}</button>
        `).join("")}
      </div>
    </div>
    <div class="gv-filter-group">
      <span class="gv-filter-label">Subtarefas</span>
      <div class="gv-filter-pills">
        ${subtaskOpts.map(o => `
          <button class="gv-pill${_filter.subtaskStatus === o.key ? " is-active" : ""}" data-subtask-status="${o.key}">${o.label}</button>
        `).join("")}
      </div>
    </div>
  `;
}

function _renderFilters() {
  const wrap = document.querySelector(".gv-filters");
  if (!wrap) return;
  wrap.innerHTML = _filtersHtml();

  wrap.querySelectorAll("[data-project-id]").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.projectId;
      _filter.projectIds = _filter.projectIds.includes(id)
        ? _filter.projectIds.filter(x => x !== id)
        : [..._filter.projectIds, id];
      _saveFilter();
      _renderFilters();
      _renderCards();
    });
  });

  wrap.querySelectorAll("[data-subtask-status]").forEach(btn => {
    btn.addEventListener("click", () => {
      _filter.subtaskStatus = btn.dataset.subtaskStatus;
      _saveFilter();
      _renderFilters();
      _renderCards();
    });
  });
}

// ── Shell (filtros + colunas lado a lado) ───────────────────────────────────────
// Só reconstrói quando o conjunto de colunas muda de verdade — recriar a toda
// mudança de task destruiria os Sortables ativos (e qualquer drag em curso).

function _ensureShell() {
  const key = _columns.map(c => c.id).sort().join(",");
  if (key === _shellColumnKey) return;
  _shellColumnKey = key;

  const el = document.getElementById("global-view-area");
  if (!el) return;

  destroyDrag();

  el.innerHTML = `
    <div class="gv-filters">${_filtersHtml()}</div>
    <div class="gv-board">${_columns.length === 0 ? `
      <div class="empty-board">
        <p class="empty-title">Nenhuma coluna neste workspace ainda</p>
        <p class="empty-sub">Crie colunas pelo board de algum projeto para começar.</p>
      </div>
    ` : ""}</div>
  `;
  _renderFilters();

  if (_columns.length === 0) return;

  const boardEl = el.querySelector(".gv-board");
  _columns.forEach(col => {
    const colEl = document.createElement("div");
    colEl.className = "column";
    colEl.dataset.colId = col.id;
    colEl.innerHTML = `
      <div class="col-header">
        <div class="col-header-left">
          <span class="col-name">${esc(col.name)}</span>
          <span class="col-count"></span>
        </div>
      </div>
      <ul class="task-list"></ul>
    `;
    boardEl.appendChild(colEl);
    initTaskDrag(colEl, _uid, _workspaceId);
  });
}

// ── Cards ─────────────────────────────────────────────────────────────────────

function _renderCards() {
  const boardEl = document.querySelector(".gv-board");
  if (!boardEl) return;

  const projectsById = new Map(_projects.map(p => [p.id, p]));
  const filtered = _applyFilter(_tasks);

  const grouped = new Map();
  filtered.forEach(t => {
    if (!grouped.has(t.columnId)) grouped.set(t.columnId, []);
    grouped.get(t.columnId).push(t);
  });

  boardEl.querySelectorAll(".column").forEach(colEl => {
    const tasks = (grouped.get(colEl.dataset.colId) || []).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const list    = colEl.querySelector(".task-list");
    const counter = colEl.querySelector(".col-count");
    if (counter) counter.textContent = tasks.length > 0 ? tasks.length : "";
    if (list) _renderColumnCards(list, tasks, projectsById);
  });
}

function _renderColumnCards(listEl, tasks, projectsById) {
  listEl.innerHTML = "";

  tasks.forEach(task => {
    const project = projectsById.get(task.projectId);
    const li = document.createElement("li");
    li.className        = "task-card";
    li.dataset.taskId    = task.id;
    li.dataset.priority  = task.priority || "";

    const total = task.subtaskCount || 0;
    const done  = task.subtaskDone  || 0;
    const pct   = total > 0 ? Math.round((done / total) * 100) : 0;

    li.innerHTML = `
      ${project ? `<div class="gv-card-project">${esc(project.name)}</div>` : ""}
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
    `;

    li.addEventListener("click", () => openDrawer(task, task.columnId, _uid, _workspaceId, task.projectId));
    listEl.appendChild(li);
  });
}
