import { auth } from "./firebase.js";
import {
  signInWithEmailAndPassword,
  signInWithPopup,
  GoogleAuthProvider,
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

const GOOGLE_ICON = `<svg width="18" height="18" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
  <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
  <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
  <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
  <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.18 1.48-4.97 2.31-8.16 2.31-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
  <path fill="none" d="M0 0h48v48H0z"/>
</svg>`;

function friendlyError(code) {
  switch (code) {
    case "auth/invalid-credential":
    case "auth/user-not-found":
    case "auth/wrong-password":
      return "Email ou senha incorretos.";
    case "auth/too-many-requests":
      return "Muitas tentativas. Tente novamente mais tarde.";
    case "auth/network-request-failed":
      return "Erro de conexão. Verifique sua internet.";
    case "auth/popup-closed-by-user":
    case "auth/cancelled-popup-request":
      return "";
    default:
      return "Erro ao entrar. Tente novamente.";
  }
}

function renderLoginForm() {
  const screen = document.getElementById("auth-screen");
  screen.innerHTML = `
    <div class="login-card">
      <h1 class="login-title">Tasks</h1>
      <form id="login-form" class="login-form" novalidate>
        <div class="form-group">
          <input type="email" id="login-email" class="form-input" placeholder="Email" autocomplete="email" />
        </div>
        <div class="form-group">
          <input type="password" id="login-password" class="form-input" placeholder="Senha" autocomplete="current-password" />
        </div>
        <p id="login-error" class="login-error hidden"></p>
        <button type="submit" id="login-btn" class="btn-primary">Entrar</button>
      </form>
      <div class="login-divider"><span>ou</span></div>
      <button id="login-google-btn" class="btn-google">
        ${GOOGLE_ICON}
        Entrar com Google
      </button>
    </div>
  `;

  const errorEl = document.getElementById("login-error");

  function showError(msg) {
    if (!msg) return;
    errorEl.textContent = msg;
    errorEl.classList.remove("hidden");
  }

  function clearError() {
    errorEl.classList.add("hidden");
  }

  document.getElementById("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email    = document.getElementById("login-email").value.trim();
    const password = document.getElementById("login-password").value;
    const btn      = document.getElementById("login-btn");

    clearError();
    btn.disabled    = true;
    btn.textContent = "Entrando…";

    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch (err) {
      showError(friendlyError(err.code));
      btn.disabled    = false;
      btn.textContent = "Entrar";
    }
  });

  document.getElementById("login-google-btn").addEventListener("click", async () => {
    const btn = document.getElementById("login-google-btn");
    clearError();
    btn.disabled = true;

    try {
      await signInWithPopup(auth, new GoogleAuthProvider());
    } catch (err) {
      showError(friendlyError(err.code));
      btn.disabled = false;
    }
  });
}

export function initAuth(onLogin, onLogout) {
  renderLoginForm();

  onAuthStateChanged(auth, async (user) => {
    if (user) {
      // Força a renovação do ID token antes de liberar o app — logo após
      // um login novo (signInWithEmailAndPassword/signInWithPopup), a
      // conexão do Firestore pode ainda não ter sincronizado o token mais
      // recente, causando "permission-denied" na primeira escrita mesmo
      // com as regras corretas (some com um refresh da página porque aí a
      // sessão já é restaurada com o token pronto desde o início).
      await user.getIdToken(true);
      onLogin(user);
    } else {
      onLogout();
    }
  });
}

export async function logout() {
  await signOut(auth);
}
