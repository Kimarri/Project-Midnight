/* ===================================================================
   NoteFlow — dashboard.ts
   Project dashboard, grid view, stats, navigation
   =================================================================== */

import { state } from './state';
import { esc, el } from './utils';
import {
  getProjectList,
  saveProjectList,
  loadProject,
  saveProject,
  createProject,
  renameProject,
  populateProjectSelect,
} from './data';
import {
  cloudDeleteProject,
} from './data';
import {
  loginSession,
  isSessionExpired,
  AUTH_SESSION_KEY,
} from './auth';

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export function showDashboard(): void {
  const loginScreen = el('login-screen');
  if (loginScreen) loginScreen.style.display = 'none';
  el('app-wrapper')?.classList.remove('visible');
  el('dashboard')?.classList.add('visible');
  const dashUser = el('dash-user-display');
  if (dashUser) dashUser.textContent = state.currentUserName || state.currentUserEmail;
  const dashGreeting = el('dash-greeting');
  if (dashGreeting) dashGreeting.textContent = 'Welcome, ' + (state.currentUserName || 'User');

  // Show admin button only for admin email
  const isAdmin: boolean = state.currentUserEmail === 'getnoteflowapp@gmail.com';
  const adminLink = document.getElementById('admin-link');
  if (adminLink) adminLink.style.display = isAdmin ? 'inline-block' : 'none';

  // Hide trial banner for admin
  if (isAdmin) {
    const tb = document.getElementById('sub-trial-banner');
    if (tb) tb.style.display = 'none';
  }

  renderProjectGrid();
}

export function renderProjectGrid(): void {
  const list = getProjectList(state.currentUserEmail!);
  list.sort(function (a, b) {
    return (b.updatedAt || '').localeCompare(a.updatedAt || '');
  });
  const grid = el('project-grid');
  if (!grid) return;

  if (list.length === 0) {
    grid.innerHTML =
      '<div class="empty-state"><p>No projects yet. Create your first project to get started.</p></div>';
    return;
  }

  let html = '';
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    const dateStr: string = p.updatedAt
      ? new Date(p.updatedAt).toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        })
      : '';
    html += '<div class="project-card" data-card-action="open" data-id="' + esc(p.id) + '">';
    html += '<div class="pc-menu-wrap">';
    html +=
      '<button class="pc-dots" data-card-action="toggleMenu" aria-label="Menu">&#8943;</button>';
    html += '<div class="pc-dropdown">';
    html +=
      '<button data-card-action="rename" data-id="' + esc(p.id) +
      '" data-name="' + esc(p.name) + '">Rename</button>';
    html +=
      '<button class="danger" data-card-action="delete" data-id="' + esc(p.id) +
      '" data-name="' + esc(p.name) + '">Delete</button>';
    html += '</div></div>';
    html += '<div class="pc-name">' + esc(p.name) + '</div>';
    html += '<div class="pc-meta">Last updated: ' + esc(dateStr) + '</div>';
    html += '</div>';
  }
  grid.innerHTML = html;
}

export function openProject(id: string): void {
  loadProject(id);
  populateProjectSelect();
  el('dashboard')?.classList.remove('visible');
  el('app-wrapper')?.classList.add('visible');
  const userDisplay = el('user-display');
  if (userDisplay) userDisplay.textContent = state.currentUserName || state.currentUserEmail;

  // Set project name in header
  const list = getProjectList(state.currentUserEmail!);
  const entry = list.find(function (p) {
    return p.id === id;
  });
  const projectName = el('app-project-name');
  if (projectName) projectName.textContent = entry ? entry.name : 'NoteFlow';
}

export function goToDashboard(): void {
  if (state.currentProjectId) saveProject();
  el('app-wrapper')?.classList.remove('visible');
  showDashboard();
}

export function toggleCardMenu(btn: HTMLElement): void {
  const dd = btn.nextElementSibling as HTMLElement;
  const wasOpen = dd.classList.contains('open');
  // close all open menus first
  document.querySelectorAll('.pc-dropdown.open').forEach(function (el) {
    el.classList.remove('open');
  });
  if (!wasOpen) dd.classList.add('open');
}

// Event delegation for project grid cards
const projectGrid = document.getElementById('project-grid');
if (projectGrid) {
  projectGrid.addEventListener('click', function (e: MouseEvent) {
    const target = e.target as HTMLElement;
    const actionEl = target.closest('[data-card-action]') as HTMLElement | null;
    if (!actionEl) return;

    const action = actionEl.dataset.cardAction;
    const id = actionEl.dataset.id;
    const name = actionEl.dataset.name;

    switch (action) {
      case 'open':
        if (id) openProject(id);
        break;
      case 'toggleMenu':
        e.stopPropagation();
        toggleCardMenu(actionEl);
        break;
      case 'rename':
        e.stopPropagation();
        if (id && name !== undefined) dashRenameProject(id, name);
        break;
      case 'delete':
        e.stopPropagation();
        if (id && name !== undefined) dashDeleteProject(id, name);
        break;
    }
  });
}

// Close card menus when clicking outside
document.addEventListener('click', function () {
  document.querySelectorAll('.pc-dropdown.open').forEach(function (el) {
    el.classList.remove('open');
  });
});

export function dashCreateProject(): void {
  const name = prompt('New project name:', 'Untitled Project');
  if (name && name.trim()) {
    if (state.currentProjectId) saveProject();
    createProject(name.trim());
    openProject(state.currentProjectId!);
  }
}

export function dashRenameProject(id: string, oldName: string): void {
  const newName = prompt('Rename project:', oldName);
  if (newName && newName.trim()) {
    renameProject(id, newName.trim());
    renderProjectGrid();
  }
}

export function dashDeleteProject(id: string, name: string): void {
  if (confirm('Delete "' + name + '"? This cannot be undone.')) {
    localStorage.removeItem('fsgen-project-' + id);
    localStorage.removeItem('noteflow-wf-' + id);
    cloudDeleteProject(id);
    let list = getProjectList(state.currentUserEmail!).filter(function (p) {
      return p.id !== id;
    });
    saveProjectList(state.currentUserEmail!, list);
    if (state.currentProjectId === id) {
      state.currentProjectId = null;
    }
    renderProjectGrid();
  }
}

// ---------------------------------------------------------------------------
// Auth bootstrap — called from main.ts initApp() AFTER Firebase is initialized
// ---------------------------------------------------------------------------

export function bootstrapAuth(): void {
  const firebase = (window as any).firebase;
  if (typeof firebase !== 'undefined' && firebase.auth) {
    firebase.auth().onAuthStateChanged(function (user: any) {
      if (user) {
        if (isSessionExpired()) {
          localStorage.removeItem(AUTH_SESSION_KEY);
          const loginScreen = el('login-screen');
          if (loginScreen) loginScreen.style.display = 'flex';
          return;
        }
        loginSession(user.email, user.displayName || user.email);
      } else {
        localStorage.removeItem(AUTH_SESSION_KEY);
        const loginScreen = el('login-screen');
        if (loginScreen) loginScreen.style.display = 'flex';
      }
    });
  } else {
    if (isSessionExpired()) {
      localStorage.removeItem(AUTH_SESSION_KEY);
      const loginScreen = el('login-screen');
      if (loginScreen) loginScreen.style.display = 'flex';
      return;
    }
    const session = localStorage.getItem(AUTH_SESSION_KEY);
    if (session) {
      try {
        const parsed = JSON.parse(session);
        if (parsed.email) {
          loginSession(parsed.email, parsed.name || parsed.email);
          return;
        }
      } catch (_e) {
        /* ignore */
      }
    }
    const loginScreen = el('login-screen');
    if (loginScreen) loginScreen.style.display = 'flex';
  }
}
