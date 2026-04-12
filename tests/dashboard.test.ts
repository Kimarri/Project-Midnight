/* ═══════════════════════════════════════════════════════════════════════
   NoteFlow — dashboard.test.ts
   Unit tests for dashboard, project grid, and project management.
   ═══════════════════════════════════════════════════════════════════════ */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { state } from '../src/modules/state';

// Mock config module
vi.mock('../src/modules/config', () => ({
  FIREBASE_ENABLED: false,
  ENCRYPTION_ENABLED: false,
  STRIPE_CONFIG: {},
  STRIPE_ENABLED: false,
  trackEvent: vi.fn(),
  getFirebaseUid: vi.fn(() => null),
  genId: vi.fn(() => 'mock-proj-id-' + Math.random().toString(36).slice(2, 8)),
}));

// We need to partially mock data so that getProjectList/saveProjectList use real localStorage,
// but cloud functions are no-ops.
vi.mock('../src/modules/data', async () => {
  return {
    getProjectList: (email: string) => {
      try {
        return JSON.parse(localStorage.getItem('fsgen-projects-' + email) || '[]');
      } catch { return []; }
    },
    saveProjectList: (email: string, list: any[]) => {
      localStorage.setItem('fsgen-projects-' + email, JSON.stringify(list));
    },
    loadProject: vi.fn((id: string) => {
      state.currentProjectId = id;
    }),
    saveProject: vi.fn(),
    createProject: vi.fn((name: string) => {
      const id = 'new-proj-' + Math.random().toString(36).slice(2, 8);
      state.currentProjectId = id;
      const email = state.currentUserEmail!;
      const list = JSON.parse(localStorage.getItem('fsgen-projects-' + email) || '[]');
      list.push({ id, name, updatedAt: new Date().toISOString() });
      localStorage.setItem('fsgen-projects-' + email, JSON.stringify(list));
      return id;
    }),
    renameProject: vi.fn((id: string, newName: string) => {
      const email = state.currentUserEmail!;
      const list = JSON.parse(localStorage.getItem('fsgen-projects-' + email) || '[]');
      const entry = list.find((p: any) => p.id === id);
      if (entry) {
        entry.name = newName;
        localStorage.setItem('fsgen-projects-' + email, JSON.stringify(list));
      }
    }),
    populateProjectSelect: vi.fn(),
    cloudDeleteProject: vi.fn(() => Promise.resolve()),
    cloudSaveUserData: vi.fn(() => Promise.resolve()),
    cloudLoadUserData: vi.fn(() => Promise.resolve(null)),
  };
});

// Mock auth module
vi.mock('../src/modules/auth', () => ({
  loginSession: vi.fn(),
  isSessionExpired: vi.fn(() => false),
  AUTH_SESSION_KEY: 'fsgen-session',
}));

import {
  showDashboard,
  renderProjectGrid,
  openProject,
  dashCreateProject,
  dashRenameProject,
  dashDeleteProject,
} from '../src/modules/dashboard';
import { getProjectList, loadProject, createProject, renameProject } from '../src/modules/data';

// ─── DOM Setup ────────────────────────────────────────────────────────────────

function setupDashboardDOM(): void {
  document.body.innerHTML = `
    <div id="login-screen" style="display:flex"></div>
    <div id="app-wrapper" class=""></div>
    <div id="dashboard" class=""></div>
    <div id="project-grid"></div>
    <div id="dash-user-display"></div>
    <div id="dash-greeting"></div>
    <div id="user-display"></div>
    <div id="app-project-name"></div>
    <div id="admin-link" style="display:none"></div>
    <div id="sub-trial-banner" style="display:none"></div>
    <select id="project-select"></select>
  `;
}

function seedProjects(email: string, projects: any[]): void {
  localStorage.setItem('fsgen-projects-' + email, JSON.stringify(projects));
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('showDashboard()', () => {
  beforeEach(() => {
    localStorage.clear();
    state.currentUserEmail = 'test@example.com';
    state.currentUserName = 'Test User';
    state.currentProjectId = null;
    setupDashboardDOM();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('hides login screen', () => {
    showDashboard();
    expect(document.getElementById('login-screen')!.style.display).toBe('none');
  });

  it('removes visible class from app-wrapper', () => {
    document.getElementById('app-wrapper')!.classList.add('visible');
    showDashboard();
    expect(document.getElementById('app-wrapper')!.classList.contains('visible')).toBe(false);
  });

  it('adds visible class to dashboard', () => {
    showDashboard();
    expect(document.getElementById('dashboard')!.classList.contains('visible')).toBe(true);
  });

  it('displays user name in dash-user-display', () => {
    showDashboard();
    expect(document.getElementById('dash-user-display')!.textContent).toBe('Test User');
  });

  it('displays greeting with user name', () => {
    showDashboard();
    expect(document.getElementById('dash-greeting')!.textContent).toBe('Welcome, Test User');
  });

  it('falls back to email when no name set', () => {
    state.currentUserName = null;
    showDashboard();
    expect(document.getElementById('dash-user-display')!.textContent).toBe('test@example.com');
    expect(document.getElementById('dash-greeting')!.textContent).toBe('Welcome, User');
  });

  it('hides admin link for non-admin users', () => {
    showDashboard();
    expect(document.getElementById('admin-link')!.style.display).toBe('none');
  });

  it('shows admin link for admin email', () => {
    state.currentUserEmail = 'getnoteflowapp@gmail.com';
    state.currentUserName = 'Admin';
    showDashboard();
    expect(document.getElementById('admin-link')!.style.display).toBe('inline-block');
  });
});

describe('renderProjectGrid()', () => {
  beforeEach(() => {
    localStorage.clear();
    state.currentUserEmail = 'test@example.com';
    state.currentUserName = 'Test User';
    setupDashboardDOM();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('shows empty state when no projects exist', () => {
    renderProjectGrid();
    const grid = document.getElementById('project-grid')!;
    expect(grid.innerHTML).toContain('empty-state');
    expect(grid.innerHTML).toContain('No projects yet');
  });

  it('renders project cards for existing projects', () => {
    seedProjects('test@example.com', [
      { id: 'p1', name: 'Project Alpha', updatedAt: '2025-01-15T00:00:00Z' },
      { id: 'p2', name: 'Project Beta', updatedAt: '2025-01-16T00:00:00Z' },
    ]);
    renderProjectGrid();
    const grid = document.getElementById('project-grid')!;
    expect(grid.innerHTML).toContain('Project Alpha');
    expect(grid.innerHTML).toContain('Project Beta');
    expect(grid.innerHTML).toContain('project-card');
  });

  it('renders project cards with data-id attributes', () => {
    seedProjects('test@example.com', [
      { id: 'proj-123', name: 'Test', updatedAt: '2025-01-15T00:00:00Z' },
    ]);
    renderProjectGrid();
    const grid = document.getElementById('project-grid')!;
    expect(grid.innerHTML).toContain('proj-123');
  });

  it('includes rename and delete buttons in card menus', () => {
    seedProjects('test@example.com', [
      { id: 'p1', name: 'My Project', updatedAt: '2025-01-15T00:00:00Z' },
    ]);
    renderProjectGrid();
    const grid = document.getElementById('project-grid')!;
    expect(grid.innerHTML).toContain('Rename');
    expect(grid.innerHTML).toContain('Delete');
  });

  it('sorts projects by updatedAt descending (most recent first)', () => {
    seedProjects('test@example.com', [
      { id: 'p1', name: 'Older', updatedAt: '2025-01-01T00:00:00Z' },
      { id: 'p2', name: 'Newer', updatedAt: '2025-06-01T00:00:00Z' },
    ]);
    renderProjectGrid();
    const grid = document.getElementById('project-grid')!;
    const newerIdx = grid.innerHTML.indexOf('Newer');
    const olderIdx = grid.innerHTML.indexOf('Older');
    expect(newerIdx).toBeLessThan(olderIdx);
  });
});

describe('openProject()', () => {
  beforeEach(() => {
    localStorage.clear();
    state.currentUserEmail = 'test@example.com';
    state.currentUserName = 'Test User';
    state.currentProjectId = null;
    setupDashboardDOM();
    seedProjects('test@example.com', [
      { id: 'p1', name: 'My Project', updatedAt: '2025-01-15T00:00:00Z' },
    ]);
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('calls loadProject with the given id', () => {
    openProject('p1');
    expect(loadProject).toHaveBeenCalledWith('p1');
  });

  it('removes visible class from dashboard', () => {
    document.getElementById('dashboard')!.classList.add('visible');
    openProject('p1');
    expect(document.getElementById('dashboard')!.classList.contains('visible')).toBe(false);
  });

  it('adds visible class to app-wrapper', () => {
    openProject('p1');
    expect(document.getElementById('app-wrapper')!.classList.contains('visible')).toBe(true);
  });

  it('sets user-display text', () => {
    openProject('p1');
    expect(document.getElementById('user-display')!.textContent).toBe('Test User');
  });

  it('sets app-project-name from project list', () => {
    openProject('p1');
    expect(document.getElementById('app-project-name')!.textContent).toBe('My Project');
  });

  it('falls back to NoteFlow if project not found', () => {
    openProject('nonexistent');
    expect(document.getElementById('app-project-name')!.textContent).toBe('NoteFlow');
  });
});

describe('dashCreateProject()', () => {
  beforeEach(() => {
    localStorage.clear();
    state.currentUserEmail = 'test@example.com';
    state.currentUserName = 'Test User';
    state.currentProjectId = null;
    setupDashboardDOM();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('prompts user for a project name', () => {
    vi.stubGlobal('prompt', vi.fn(() => null));
    dashCreateProject();
    expect(prompt).toHaveBeenCalled();
  });

  it('does nothing when prompt is cancelled', () => {
    vi.stubGlobal('prompt', vi.fn(() => null));
    vi.mocked(createProject).mockClear();
    dashCreateProject();
    expect(createProject).not.toHaveBeenCalled();
  });

  it('does nothing when prompt returns empty string', () => {
    vi.stubGlobal('prompt', vi.fn(() => '   '));
    dashCreateProject();
    // No project should be created for whitespace-only input
  });
});

describe('dashRenameProject()', () => {
  beforeEach(() => {
    localStorage.clear();
    state.currentUserEmail = 'test@example.com';
    state.currentUserName = 'Test User';
    setupDashboardDOM();
    seedProjects('test@example.com', [
      { id: 'p1', name: 'Old Name', updatedAt: '2025-01-15T00:00:00Z' },
    ]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('prompts with old name as default', () => {
    vi.stubGlobal('prompt', vi.fn(() => null));
    dashRenameProject('p1', 'Old Name');
    expect(prompt).toHaveBeenCalledWith('Rename project:', 'Old Name');
  });

  it('renames when user provides a new name', () => {
    vi.stubGlobal('prompt', vi.fn(() => 'New Name'));
    vi.mocked(renameProject).mockClear();
    dashRenameProject('p1', 'Old Name');
    expect(renameProject).toHaveBeenCalledWith('p1', 'New Name');
  });

  it('does nothing when prompt is cancelled', () => {
    vi.stubGlobal('prompt', vi.fn(() => null));
    dashRenameProject('p1', 'Old Name');
    // Verify project list unchanged
    const list = getProjectList('test@example.com');
    expect(list[0].name).toBe('Old Name');
  });
});

describe('dashDeleteProject()', () => {
  beforeEach(() => {
    localStorage.clear();
    state.currentUserEmail = 'test@example.com';
    state.currentUserName = 'Test User';
    state.currentProjectId = null;
    setupDashboardDOM();
    seedProjects('test@example.com', [
      { id: 'p1', name: 'Doomed Project', updatedAt: '2025-01-15T00:00:00Z' },
      { id: 'p2', name: 'Safe Project', updatedAt: '2025-01-16T00:00:00Z' },
    ]);
    localStorage.setItem('fsgen-project-p1', '{"data":"test"}');
    localStorage.setItem('noteflow-wf-p1', '{"status":"draft"}');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('shows a confirmation dialog', () => {
    vi.stubGlobal('confirm', vi.fn(() => false));
    dashDeleteProject('p1', 'Doomed Project');
    expect(confirm).toHaveBeenCalled();
  });

  it('does nothing when user cancels', () => {
    vi.stubGlobal('confirm', vi.fn(() => false));
    dashDeleteProject('p1', 'Doomed Project');
    const list = getProjectList('test@example.com');
    expect(list).toHaveLength(2);
  });

  it('removes project from list when confirmed', () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    dashDeleteProject('p1', 'Doomed Project');
    const list = getProjectList('test@example.com');
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('p2');
  });

  it('removes project data from localStorage', () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    dashDeleteProject('p1', 'Doomed Project');
    expect(localStorage.getItem('fsgen-project-p1')).toBeNull();
  });

  it('removes workflow data from localStorage', () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    dashDeleteProject('p1', 'Doomed Project');
    expect(localStorage.getItem('noteflow-wf-p1')).toBeNull();
  });

  it('clears currentProjectId if deleting current project', () => {
    state.currentProjectId = 'p1';
    vi.stubGlobal('confirm', vi.fn(() => true));
    dashDeleteProject('p1', 'Doomed Project');
    expect(state.currentProjectId).toBeNull();
  });

  it('preserves currentProjectId if deleting a different project', () => {
    state.currentProjectId = 'p2';
    vi.stubGlobal('confirm', vi.fn(() => true));
    dashDeleteProject('p1', 'Doomed Project');
    expect(state.currentProjectId).toBe('p2');
  });
});
