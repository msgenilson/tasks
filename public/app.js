import { initAuth, logout } from "./auth.js";
import { initWorkspaces, destroyWorkspaces, closeWorkspaceDropdown } from "./workspaces.js";
import { initProjects, destroyProjects, closeProjectDropdown, ALL_PROJECTS_ID } from "./projects.js";
import { initBoard, destroyBoard } from "./board.js";
import { initGlobalView, destroyGlobalView } from "./globalview.js";
import { getProfile, saveProfile } from "./profile.js";

const authScreen    = document.getElementById("auth-screen");
const appEl         = document.getElementById("app");
const userMenuWrap  = document.getElementById("user-menu-wrap");
const userMenuBtn   = document.getElementById("user-menu-btn");
const userMenuEl    = document.getElementById("user-menu");
const boardArea     = document.getElementById("board-area");
const globalViewArea = document.getElementById("global-view-area");

// ── Helpers ───────────────────────────────────────────────────────────────────

function esc(str) {
  return String(str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ── Tema ──────────────────────────────────────────────────────────────────────

function applyTheme(theme) {
  document.documentElement.classList.toggle("theme-light", theme === "light");
  localStorage.setItem("kanban_theme", theme);
}

applyTheme(localStorage.getItem("kanban_theme") || "dark");

// ── User menu ─────────────────────────────────────────────────────────────────

let _currentUser    = null;
let _currentProfile = null;

// ── View global (item "Todos" no dropdown de projetos, kanban por coluna) ──────
//
// board.js e globalview.js compartilham o mesmo drag.js (que guarda os
// Sortables ativos num estado único do módulo) — por isso as duas views
// nunca ficam montadas ao mesmo tempo: selecionar "Todos" destrói o board
// antes de montar o kanban geral, e vice-versa, em vez de só esconder com CSS.

let _currentWorkspaceId = null;
let _currentProjectId   = null;

function _setViewModeUI(mode) {
  if (mode === "global") {
    boardArea.classList.add("hidden");
    globalViewArea.classList.remove("hidden");
  } else {
    globalViewArea.classList.add("hidden");
    boardArea.classList.remove("hidden");
  }
}

// Callback de seleção do dropdown de projetos — projId pode ser um projeto
// de verdade ou ALL_PROJECTS_ID ("Todos").
function _selectProjectOrAll(projId) {
  _currentProjectId = projId;
  if (projId === ALL_PROJECTS_ID) {
    destroyBoard();
    _setViewModeUI("global");
    if (_currentUser && _currentWorkspaceId) initGlobalView(_currentUser.uid, _currentWorkspaceId);
  } else {
    destroyGlobalView();
    _setViewModeUI("board");
    if (_currentUser && _currentWorkspaceId) initBoard(_currentUser.uid, _currentWorkspaceId, projId);
  }
}

function _menuInitial() {
  const name = _currentProfile?.name || _currentUser?.email?.split("@")[0] || "?";
  return name.trim()[0].toUpperCase();
}

function _openUserMenu() {
  _renderUserMenuContent();
  userMenuEl.classList.remove("hidden");
}

function _closeUserMenu() {
  userMenuEl.classList.add("hidden");
}

function _renderUserMenuContent() {
  const name    = _currentProfile?.name || _currentUser?.email?.split("@")[0] || "Usuário";
  const email   = _currentProfile?.email || _currentUser?.email || "";
  const initial = name.trim()[0].toUpperCase();
  const isLight = document.documentElement.classList.contains("theme-light");

  const ICON_PERSON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
    <circle cx="12" cy="7" r="4"/>
  </svg>`;
  const ICON_THEME = isLight
    ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="5"/>
        <line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/>
        <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
        <line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/>
        <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
      </svg>`
    : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
      </svg>`;
  const ICON_LOGOUT = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
    <polyline points="16 17 21 12 16 7"/>
    <line x1="21" y1="12" x2="9" y2="12"/>
  </svg>`;

  userMenuEl.innerHTML = `
    <div class="user-menu-header">
      <div class="user-menu-avatar">${esc(initial)}</div>
      <div class="user-menu-info">
        <span class="user-menu-name">${esc(name)}</span>
        <span class="user-menu-email">${esc(email)}</span>
      </div>
    </div>
    <div class="user-menu-sep"></div>
    <button class="user-menu-item" id="um-edit-profile">${ICON_PERSON} Editar perfil</button>
    <button class="user-menu-item" id="um-toggle-theme">${ICON_THEME} Tema ${isLight ? "claro" : "escuro"}</button>
    <div class="user-menu-sep"></div>
    <button class="user-menu-item user-menu-item--danger" id="um-logout">${ICON_LOGOUT} Sair</button>
  `;

  document.getElementById("um-edit-profile").addEventListener("click", () => {
    _closeUserMenu();
    _showEditProfileDialog();
  });

  document.getElementById("um-toggle-theme").addEventListener("click", () => {
    const next = document.documentElement.classList.contains("theme-light") ? "dark" : "light";
    applyTheme(next);
    _closeUserMenu();
  });

  document.getElementById("um-logout").addEventListener("click", () => {
    _closeUserMenu();
    _showLogoutDialog();
  });
}

function _showLogoutDialog() {
  let dialog = document.getElementById("logout-dialog");
  if (!dialog) {
    dialog = document.createElement("dialog");
    dialog.id        = "logout-dialog";
    dialog.className = "confirm-dialog";
    dialog.innerHTML = `
      <p class="confirm-dialog-title">Sair da conta?</p>
      <p class="confirm-dialog-sub">Você precisará fazer login novamente para acessar o app.</p>
      <div class="confirm-dialog-btns">
        <button class="btn-ghost btn-sm btn-dialog-cancel">Cancelar</button>
        <button class="btn-danger btn-sm btn-dialog-confirm">Sair</button>
      </div>
    `;
    document.body.appendChild(dialog);
    dialog.querySelector(".btn-dialog-cancel").addEventListener("click", () => dialog.close());
    dialog.querySelector(".btn-dialog-confirm").addEventListener("click", () => { dialog.close(); logout(); });
    dialog.addEventListener("click", (e) => { if (e.target === dialog) dialog.close(); });
  }
  dialog.showModal();
}

function _showEditProfileDialog() {
  let dialog = document.getElementById("profile-dialog");
  if (!dialog) {
    dialog = document.createElement("dialog");
    dialog.id        = "profile-dialog";
    dialog.className = "confirm-dialog";
    document.body.appendChild(dialog);
    dialog.addEventListener("click", e => { if (e.target === dialog) dialog.close(); });
  }

  const currentName = _currentProfile?.name || "";

  dialog.innerHTML = `
    <p class="confirm-dialog-title">Editar perfil</p>
    <div style="margin-top:12px">
      <input class="form-input profile-name-input" placeholder="Seu nome" value="${esc(currentName)}" />
    </div>
    <div class="confirm-dialog-btns" style="margin-top:16px">
      <button class="btn-ghost btn-sm btn-profile-cancel">Cancelar</button>
      <button class="btn-primary btn-sm btn-profile-save">Salvar</button>
    </div>
  `;

  const input     = dialog.querySelector(".profile-name-input");
  const saveBtn   = dialog.querySelector(".btn-profile-save");
  const cancelBtn = dialog.querySelector(".btn-profile-cancel");

  const submit = async () => {
    const name = input.value.trim();
    if (!name) { input.focus(); return; }
    saveBtn.disabled = true;
    try {
      await saveProfile(_currentUser.uid, { name, email: _currentUser.email || "" });
      _currentProfile        = { ..._currentProfile, name, email: _currentUser.email || "" };
      userMenuBtn.textContent = name.trim()[0].toUpperCase();
      dialog.close();
    } catch {
      saveBtn.disabled = false;
    }
  };

  saveBtn.addEventListener("click", submit);
  cancelBtn.addEventListener("click", () => dialog.close());
  input.addEventListener("keydown", e => {
    if (e.key === "Enter")  submit();
    if (e.key === "Escape") dialog.close();
  });

  dialog.showModal();
  input.focus();
  input.select();
}

userMenuBtn.addEventListener("click", () => {
  userMenuEl.classList.contains("hidden") ? _openUserMenu() : _closeUserMenu();
});

// ── Menus globais ─────────────────────────────────────────────────────────────

document.addEventListener("click", (e) => {
  if (!e.target.closest("#workspace-selector")) closeWorkspaceDropdown();
  if (!e.target.closest("#project-dropdown"))   closeProjectDropdown();
  if (!e.target.closest("#user-menu-wrap"))      _closeUserMenu();
  if (!e.target.closest(".btn-col-menu") && !e.target.closest(".col-menu")) document.querySelectorAll(".col-menu").forEach(m => m.classList.add("hidden"));
  if (!e.target.closest(".col-filter-wrap"))     document.querySelectorAll(".col-filter-menu").forEach(m => m.classList.add("hidden"));
});

// ── Auth ──────────────────────────────────────────────────────────────────────

initAuth(
  async (user) => {
    authScreen.classList.add("hidden");
    appEl.classList.remove("hidden");
    _currentUser    = user;
    _currentProfile = await getProfile(user.uid);
    userMenuBtn.textContent = _menuInitial();

    initWorkspaces(user.uid, (wsId) => {
      _currentWorkspaceId = wsId;
      _currentProjectId   = null;
      destroyGlobalView();
      _setViewModeUI("board");
      destroyProjects();
      destroyBoard();
      if (!wsId) return;
      initProjects(user.uid, wsId, _selectProjectOrAll);
    });
  },
  () => {
    authScreen.classList.remove("hidden");
    appEl.classList.add("hidden");
    _currentUser    = null;
    _currentProfile = null;
    _currentWorkspaceId = null;
    _currentProjectId   = null;
    userMenuBtn.textContent = "?";
    _closeUserMenu();
    destroyGlobalView();
    _setViewModeUI("board");
    destroyWorkspaces();
    destroyProjects();
    destroyBoard();
  }
);
