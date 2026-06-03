import { db } from "./firebase.js";
import {
  collection, doc, addDoc, getDocs, updateDoc, deleteDoc,
  onSnapshot, query, orderBy, writeBatch, increment
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { getTags, createTag, deleteTag, TAG_COLORS } from "./tags.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function esc(str) {
  return String(str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function tasksRef(uid, workspaceId, projectId, columnId) {
  return collection(db, "users", uid, "workspaces", workspaceId, "projects", projectId, "columns", columnId, "tasks");
}

function subtasksRef(uid, workspaceId, projectId, columnId, taskId) {
  return collection(db, "users", uid, "workspaces", workspaceId, "projects", projectId, "columns", columnId, "tasks", taskId, "subtasks");
}

function taskDoc(uid, workspaceId, projectId, columnId, taskId) {
  return doc(db, "users", uid, "workspaces", workspaceId, "projects", projectId, "columns", columnId, "tasks", taskId);
}

function subtaskDoc(uid, workspaceId, projectId, columnId, taskId, subtaskId) {
  return doc(db, "users", uid, "workspaces", workspaceId, "projects", projectId, "columns", columnId, "tasks", taskId, "subtasks", subtaskId);
}

// ── CRUD tasks ────────────────────────────────────────────────────────────────

export async function createTask(uid, workspaceId, projectId, columnId, title) {
  return addDoc(tasksRef(uid, workspaceId, projectId, columnId), {
    title, description: "", order: Date.now(),
    subtaskCount: 0, subtaskDone: 0
  });
}

export function getTasks(uid, workspaceId, projectId, columnId, callback) {
  const q = query(tasksRef(uid, workspaceId, projectId, columnId), orderBy("order"));
  return onSnapshot(q, snap => callback(snap.docs.map(d => ({ id: d.id, ...d.data() }))));
}

export async function updateTask(uid, workspaceId, projectId, columnId, taskId, data) {
  return updateDoc(taskDoc(uid, workspaceId, projectId, columnId, taskId), data);
}

export async function deleteTask(uid, workspaceId, projectId, columnId, taskId) {
  const batch = writeBatch(db);
  const subsSnap = await getDocs(subtasksRef(uid, workspaceId, projectId, columnId, taskId));
  subsSnap.docs.forEach(s => batch.delete(s.ref));
  batch.delete(taskDoc(uid, workspaceId, projectId, columnId, taskId));
  return batch.commit();
}

// ── CRUD subtasks ─────────────────────────────────────────────────────────────

export function getSubtasks(uid, workspaceId, projectId, columnId, taskId, callback) {
  const q = query(subtasksRef(uid, workspaceId, projectId, columnId, taskId), orderBy("order"));
  return onSnapshot(q, snap => callback(snap.docs.map(d => ({ id: d.id, ...d.data() }))));
}

export async function createSubtask(uid, workspaceId, projectId, columnId, taskId, title) {
  await addDoc(subtasksRef(uid, workspaceId, projectId, columnId, taskId), { title, done: false, order: Date.now() });
  await updateDoc(taskDoc(uid, workspaceId, projectId, columnId, taskId), { subtaskCount: increment(1) });
}

export async function updateSubtask(uid, workspaceId, projectId, columnId, taskId, subtaskId, data) {
  await updateDoc(subtaskDoc(uid, workspaceId, projectId, columnId, taskId, subtaskId), data);
  if (data.done !== undefined) {
    await updateDoc(taskDoc(uid, workspaceId, projectId, columnId, taskId), {
      subtaskDone: increment(data.done ? 1 : -1)
    });
  }
}

export async function deleteSubtask(uid, workspaceId, projectId, columnId, taskId, subtaskId, wasDone) {
  await deleteDoc(subtaskDoc(uid, workspaceId, projectId, columnId, taskId, subtaskId));
  await updateDoc(taskDoc(uid, workspaceId, projectId, columnId, taskId), {
    subtaskCount: increment(-1),
    ...(wasDone ? { subtaskDone: increment(-1) } : {})
  });
}

// ── Drawer state ──────────────────────────────────────────────────────────────

let _subUnsub  = null;
let _tagsUnsub = null;

// ── Public ────────────────────────────────────────────────────────────────────

export function openDrawer(task, columnId, uid, workspaceId, projectId) {
  _ensureDrawerDOM();
  const drawer  = document.getElementById("task-drawer");
  const overlay = document.getElementById("drawer-overlay");

  if (_subUnsub) { _subUnsub(); _subUnsub = null; }

  _renderDrawer(drawer, task, columnId, uid, workspaceId, projectId);

  requestAnimationFrame(() => {
    overlay.classList.add("visible");
    drawer.classList.add("open");
  });

  _subUnsub = getSubtasks(uid, workspaceId, projectId, columnId, task.id, (subtasks) => {
    const list = drawer.querySelector(".subtask-list");
    if (list) _renderSubtaskItems(list, subtasks, columnId, uid, workspaceId, projectId, task.id);
  });

  _tagsUnsub = getTags(uid, workspaceId, projectId, (allTags) => {
    const sec = drawer.querySelector(".drawer-tags-section");
    if (sec) _renderTagSection(sec, allTags, task, uid, workspaceId, projectId, columnId);
  });
}

export function closeDrawer() {
  const drawer  = document.getElementById("task-drawer");
  const overlay = document.getElementById("drawer-overlay");
  if (!drawer) return;
  drawer.classList.remove("open");
  overlay.classList.remove("visible");
  if (_subUnsub)  { _subUnsub();  _subUnsub  = null; }
  if (_tagsUnsub) { _tagsUnsub(); _tagsUnsub = null; }
}

// ── DOM setup ─────────────────────────────────────────────────────────────────

function _ensureDrawerDOM() {
  if (document.getElementById("task-drawer")) return;

  const overlay = document.createElement("div");
  overlay.id        = "drawer-overlay";
  overlay.className = "drawer-overlay";
  overlay.addEventListener("click", closeDrawer);

  const drawer = document.createElement("div");
  drawer.id        = "task-drawer";
  drawer.className = "task-drawer";

  document.body.appendChild(overlay);
  document.body.appendChild(drawer);
}

// ── Drawer rendering ──────────────────────────────────────────────────────────

function _renderDrawer(drawer, task, columnId, uid, workspaceId, projectId) {
  drawer.innerHTML = `
    <div class="drawer-header">
      <span class="drawer-title-wrap">
        <span class="drawer-title" tabindex="0">${esc(task.title)}</span>
      </span>
      <button class="btn-close-drawer" title="Fechar">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    </div>
    <div class="drawer-body">
      <div>
        <label class="drawer-label">Descrição</label>
        <textarea class="drawer-desc" placeholder="Adicionar descrição…" rows="4">${esc(task.description || "")}</textarea>
      </div>
      <div>
        <label class="drawer-label">Prioridade</label>
        <div class="priority-picker">
          <button class="priority-opt${task.priority==='low'?' is-active':''}"    data-priority="low">Baixa</button>
          <button class="priority-opt${task.priority==='medium'?' is-active':''}" data-priority="medium">Média</button>
          <button class="priority-opt${task.priority==='high'?' is-active':''}"   data-priority="high">Alta</button>
          <button class="priority-opt${task.priority==='urgent'?' is-active':''}" data-priority="urgent">Urgente</button>
        </div>
      </div>
      <div>
        <label class="drawer-label">Data de conclusão</label>
        <div class="due-date-row">
          <input type="date" class="form-input due-date-input" value="${task.completedDate || ""}" />
          <button class="btn-due-today" title="Marcar como hoje">Hoje</button>
          <button class="btn-clear-due" title="Remover data">✕</button>
        </div>
      </div>

      <div class="drawer-section drawer-tags-section">
        <label class="drawer-label">Tags</label>
      </div>

      <div class="drawer-section">
        <label class="drawer-label">Subtarefas</label>
        <ul class="subtask-list"></ul>
        <input class="form-input subtask-new-input" placeholder="+ Adicionar subtarefa…" />
      </div>
    </div>
    <div class="drawer-footer">
      <button class="btn-delete-task">Deletar task</button>
    </div>
  `;

  drawer.querySelector(".btn-close-drawer").addEventListener("click", closeDrawer);

  // Título editável
  const titleEl = drawer.querySelector(".drawer-title");
  titleEl.addEventListener("click", () => _editTitle(drawer, task, columnId, uid, workspaceId, projectId));

  // Descrição — auto-save no blur
  const descEl = drawer.querySelector(".drawer-desc");
  descEl.addEventListener("blur", async () => {
    const desc = descEl.value;
    if (desc !== (task.description || "")) {
      await updateTask(uid, workspaceId, projectId, columnId, task.id, { description: desc });
      task.description = desc;
    }
  });

  // Data de conclusão
  const dateInput = drawer.querySelector(".due-date-input");
  const todayBtn  = drawer.querySelector(".btn-due-today");
  const clearDue  = drawer.querySelector(".btn-clear-due");

  const saveDate = async (value) => {
    dateInput.value = value || "";
    await updateTask(uid, workspaceId, projectId, columnId, task.id, { completedDate: value || null });
    task.completedDate = value || null;
  };

  dateInput.addEventListener("change", () => saveDate(dateInput.value));
  todayBtn.addEventListener("click", () => {
    saveDate(new Date().toISOString().split("T")[0]);
  });
  clearDue.addEventListener("click", () => saveDate(null));

  // Prioridade
  drawer.querySelectorAll(".priority-opt").forEach(btn => {
    btn.addEventListener("click", async () => {
      const p = btn.dataset.priority;
      const newPriority = task.priority === p ? null : p;
      await updateTask(uid, workspaceId, projectId, columnId, task.id, { priority: newPriority });
      task.priority = newPriority;
      drawer.querySelectorAll(".priority-opt").forEach(b => b.classList.remove("is-active"));
      if (newPriority) btn.classList.add("is-active");
    });
  });

  // Nova subtarefa
  const newInput = drawer.querySelector(".subtask-new-input");
  newInput.addEventListener("keydown", async e => {
    if (e.key !== "Enter") return;
    const title = newInput.value.trim();
    if (title) {
      newInput.value = "";
      await createSubtask(uid, workspaceId, projectId, columnId, task.id, title);
    }
  });

  // Deletar task
  _bindDeleteTask(drawer.querySelector(".btn-delete-task"), task, columnId, uid, workspaceId, projectId);
}

function _editTitle(drawer, task, columnId, uid, workspaceId, projectId) {
  const wrap    = drawer.querySelector(".drawer-title-wrap");
  const current = wrap.querySelector(".drawer-title");
  if (!current) return;

  const input = document.createElement("input");
  input.className = "drawer-title-input form-input";
  input.value     = task.title;
  current.replaceWith(input);
  input.focus();
  input.select();

  let done = false;

  const restore = (newTitle) => {
    const span = document.createElement("span");
    span.className   = "drawer-title";
    span.tabIndex    = 0;
    span.textContent = newTitle || task.title;
    input.replaceWith(span);
    span.addEventListener("click", () => _editTitle(drawer, task, columnId, uid, workspaceId, projectId));
  };

  const save = async () => {
    if (done) return; done = true;
    const title = input.value.trim();
    if (title && title !== task.title) {
      await updateTask(uid, workspaceId, projectId, columnId, task.id, { title });
      task.title = title;
    }
    restore(task.title);
  };

  input.addEventListener("blur", save);
  input.addEventListener("keydown", e => {
    if (e.key === "Enter")  { e.preventDefault(); input.blur(); }
    if (e.key === "Escape") { e.preventDefault(); if (!done) { done = true; restore(task.title); } }
  });
}

function _bindDeleteTask(btn, task, columnId, uid, workspaceId, projectId) {
  let armed = false;
  let timer  = null;

  btn.addEventListener("click", async () => {
    if (!armed) {
      armed = true;
      btn.textContent = "Confirmar exclusão?";
      btn.classList.add("btn-delete-confirm");
      timer = setTimeout(() => {
        armed = false;
        btn.textContent = "Deletar task";
        btn.classList.remove("btn-delete-confirm");
      }, 3000);
    } else {
      clearTimeout(timer);
      closeDrawer();
      await deleteTask(uid, workspaceId, projectId, columnId, task.id);
    }
  });
}

// ── Subtask list ──────────────────────────────────────────────────────────────

function _renderSubtaskItems(listEl, subtasks, columnId, uid, workspaceId, projectId, taskId) {
  listEl.innerHTML = "";

  subtasks.forEach(sub => {
    const li = document.createElement("li");
    li.className = "subtask-item" + (sub.done ? " is-done" : "");
    li.innerHTML = `
      <input type="checkbox" class="subtask-check" ${sub.done ? "checked" : ""} />
      <span class="subtask-text">${esc(sub.title)}</span>
      <button class="btn-del-subtask" title="Remover">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="3 6 5 6 21 6"/>
          <path d="M19 6l-1 14H6L5 6"/>
          <path d="M10 11v6M14 11v6"/>
          <path d="M9 6V4h6v2"/>
        </svg>
      </button>
    `;

    li.querySelector(".subtask-check").addEventListener("change", async (e) => {
      await updateSubtask(uid, workspaceId, projectId, columnId, taskId, sub.id, { done: e.target.checked });
    });

    li.querySelector(".subtask-text").addEventListener("click", () => {
      _editSubtaskText(li, sub, columnId, uid, workspaceId, projectId, taskId);
    });

    li.querySelector(".btn-del-subtask").addEventListener("click", async () => {
      await deleteSubtask(uid, workspaceId, projectId, columnId, taskId, sub.id, sub.done);
    });

    listEl.appendChild(li);
  });
}

// ── Tags no drawer ────────────────────────────────────────────────────────────

function _renderTagSection(sec, allTags, task, uid, workspaceId, projectId, columnId) {
  const selected = new Set(task.tags || []);

  sec.innerHTML = `<label class="drawer-label">Tags</label>`;

  if (allTags.length > 0) {
    const pills = document.createElement("div");
    pills.className = "tag-pills";

    allTags.forEach(tag => {
      const btn = document.createElement("button");
      btn.className = "tag-pill-toggle" + (selected.has(tag.id) ? " is-selected" : "");
      btn.style.setProperty("--tag-color", tag.color);
      btn.innerHTML = `<span class="tag-dot"></span>${esc(tag.name)}`;

      btn.addEventListener("click", async () => {
        const next = new Set(task.tags || []);
        if (next.has(tag.id)) next.delete(tag.id);
        else next.add(tag.id);
        task.tags = [...next];
        btn.classList.toggle("is-selected", next.has(tag.id));
        await updateTask(uid, workspaceId, projectId, columnId, task.id, { tags: task.tags });
      });

      const del = document.createElement("button");
      del.className   = "tag-pill-del";
      del.title       = "Deletar tag";
      del.textContent = "×";
      del.addEventListener("click", async (e) => {
        e.stopPropagation();
        await deleteTag(uid, workspaceId, projectId, tag.id);
        if (selected.has(tag.id)) {
          const next = (task.tags || []).filter(id => id !== tag.id);
          task.tags = next;
          await updateTask(uid, workspaceId, projectId, columnId, task.id, { tags: next });
        }
      });
      btn.appendChild(del);
      pills.appendChild(btn);
    });

    sec.appendChild(pills);
  }

  // Criar nova tag
  const newWrap = document.createElement("div");
  newWrap.className = "tag-new-wrap";
  newWrap.innerHTML = `<button class="btn-new-tag">+ Nova tag</button>`;

  newWrap.querySelector(".btn-new-tag").addEventListener("click", () => {
    _showNewTagForm(newWrap, uid, workspaceId, projectId);
  });

  sec.appendChild(newWrap);
}

function _showNewTagForm(container, uid, workspaceId, projectId) {
  let selectedColor = TAG_COLORS[5];

  container.innerHTML = `
    <div class="tag-form">
      <input class="form-input tag-name-input" placeholder="Nome da tag" />
      <div class="tag-color-swatches">
        ${TAG_COLORS.map(c => `
          <button class="color-swatch${c === selectedColor ? " is-active" : ""}"
                  style="background:${c}" data-color="${c}" title="${c}"></button>
        `).join("")}
      </div>
      <div class="tag-form-btns">
        <button class="btn-primary btn-sm btn-save-tag">Criar</button>
        <button class="btn-ghost btn-sm btn-cancel-tag">✕</button>
      </div>
    </div>
  `;

  const nameInput = container.querySelector(".tag-name-input");
  const swatches  = container.querySelectorAll(".color-swatch");
  const saveBtn   = container.querySelector(".btn-save-tag");
  const cancelBtn = container.querySelector(".btn-cancel-tag");

  swatches.forEach(s => {
    s.addEventListener("click", () => {
      swatches.forEach(x => x.classList.remove("is-active"));
      s.classList.add("is-active");
      selectedColor = s.dataset.color;
    });
  });

  nameInput.focus();

  const restore = () => {
    container.innerHTML = `<button class="btn-new-tag">+ Nova tag</button>`;
    container.querySelector(".btn-new-tag").addEventListener("click", () => {
      _showNewTagForm(container, uid, workspaceId, projectId);
    });
  };

  const save = async () => {
    const name = nameInput.value.trim();
    if (!name) return;
    await createTag(uid, workspaceId, projectId, name, selectedColor);
    restore();
  };

  saveBtn.addEventListener("click", save);
  cancelBtn.addEventListener("click", restore);
  nameInput.addEventListener("keydown", e => {
    if (e.key === "Enter") save();
    if (e.key === "Escape") cancelBtn.click();
  });
}

function _editSubtaskText(li, sub, columnId, uid, workspaceId, projectId, taskId) {
  const textEl = li.querySelector(".subtask-text");
  if (!textEl) return;

  const input = document.createElement("input");
  input.className = "subtask-text-input form-input";
  input.value     = sub.title;
  textEl.replaceWith(input);
  input.focus();

  let done = false;

  const save = async () => {
    if (done) return; done = true;
    const title = input.value.trim();
    if (title && title !== sub.title) {
      await updateSubtask(uid, workspaceId, projectId, columnId, taskId, sub.id, { title });
      sub.title = title;
    }
    const span = document.createElement("span");
    span.className   = "subtask-text";
    span.textContent = sub.title;
    input.replaceWith(span);
    span.addEventListener("click", () => _editSubtaskText(li, sub, columnId, uid, workspaceId, projectId, taskId));
  };

  input.addEventListener("blur", save);
  input.addEventListener("keydown", e => {
    if (e.key === "Enter")  { e.preventDefault(); input.blur(); }
    if (e.key === "Escape") { e.preventDefault(); save(); }
  });
}
