/* ═══════════════════════════════════════════════════════════════════════
   NoteFlow — data.test.ts
   Unit tests for project data CRUD, persistence, and export.
   ═══════════════════════════════════════════════════════════════════════ */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { state, SECTIONS } from '../src/modules/state';

// Mock config module
vi.mock('../src/modules/config', () => ({
  FIREBASE_ENABLED: false,
  ENCRYPTION_ENABLED: false,
  STRIPE_CONFIG: {},
  STRIPE_ENABLED: false,
  trackEvent: vi.fn(),
  getFirebaseUid: vi.fn(() => null),
  genId: (() => {
    let counter = 0;
    return vi.fn(() => 'gen-id-' + (++counter));
  })(),
  encryptData: vi.fn((data: string) => Promise.resolve(data)),
  decryptData: vi.fn((data: string) => Promise.resolve(data)),
}));

import {
  getProjectList,
  saveProjectList,
  createProject,
  renameProject,
  saveProject,
  loadProject,
  exportProjectJSON,
  populateProjectSelect,
} from '../src/modules/data';

// ─── DOM Setup ────────────────────────────────────────────────────────────────

function setupDataDOM(): void {
  document.body.innerHTML = `
    <input id="companyName" value="" />
    <input id="period" value="" />
    <input id="priorPeriod" value="" />
    <input id="currency" value="$" />
    <select id="project-select"></select>
    <div id="import-status"></div>
  `;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('getProjectList() / saveProjectList()', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns empty array when no projects stored', () => {
    const list = getProjectList('user@test.com');
    expect(list).toEqual([]);
  });

  it('round-trips project list through save and get', () => {
    const projects = [
      { id: 'p1', name: 'Project 1', updatedAt: '2025-01-01T00:00:00Z' },
      { id: 'p2', name: 'Project 2', updatedAt: '2025-01-02T00:00:00Z' },
    ];
    saveProjectList('user@test.com', projects);
    const result = getProjectList('user@test.com');
    expect(result).toEqual(projects);
  });

  it('stores projects per-email (isolation)', () => {
    saveProjectList('alice@test.com', [{ id: 'a1', name: 'Alice Proj' }]);
    saveProjectList('bob@test.com', [{ id: 'b1', name: 'Bob Proj' }]);
    expect(getProjectList('alice@test.com')).toHaveLength(1);
    expect(getProjectList('alice@test.com')[0].name).toBe('Alice Proj');
    expect(getProjectList('bob@test.com')).toHaveLength(1);
    expect(getProjectList('bob@test.com')[0].name).toBe('Bob Proj');
  });

  it('overwrites existing list on save', () => {
    saveProjectList('user@test.com', [{ id: 'old', name: 'Old' }]);
    saveProjectList('user@test.com', [{ id: 'new', name: 'New' }]);
    const result = getProjectList('user@test.com');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('new');
  });

  it('handles corrupted localStorage gracefully', () => {
    localStorage.setItem('fsgen-projects-user@test.com', '!!!not-json');
    const result = getProjectList('user@test.com');
    expect(result).toEqual([]);
  });

  it('stores data under correct localStorage key', () => {
    saveProjectList('test@test.com', [{ id: 'x', name: 'X' }]);
    const raw = localStorage.getItem('fsgen-projects-test@test.com');
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toEqual([{ id: 'x', name: 'X' }]);
  });
});

describe('createProject()', () => {
  beforeEach(() => {
    localStorage.clear();
    state.currentUserEmail = 'test@example.com';
    state.currentUserName = 'Test';
    state.currentProjectId = null;
    state.resetData();
    setupDataDOM();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('returns a new project ID', () => {
    const id = createProject('New Project');
    expect(id).toBeDefined();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('sets state.currentProjectId', () => {
    const id = createProject('Test Proj');
    expect(state.currentProjectId).toBe(id);
  });

  it('resets all section data to empty arrays', () => {
    state.currentData['revenue'] = [{ label: 'Old', amount: 100 }];
    createProject('Fresh');
    for (const section of SECTIONS) {
      expect(state.currentData[section]).toEqual([]);
      expect(state.priorData[section]).toEqual([]);
    }
  });

  it('adds the new project to the project list', () => {
    createProject('Alpha Project');
    const list = getProjectList('test@example.com');
    expect(list.some((p: any) => p.name === 'Alpha Project')).toBe(true);
  });

  it('resets company name input', () => {
    (document.getElementById('companyName') as HTMLInputElement).value = 'Old Co';
    createProject('New');
    expect((document.getElementById('companyName') as HTMLInputElement).value).toBe('');
  });

  it('sets currency to default $', () => {
    (document.getElementById('currency') as HTMLInputElement).value = 'EUR';
    createProject('New');
    expect((document.getElementById('currency') as HTMLInputElement).value).toBe('$');
  });

  it('sets updatedAt on the new project entry', () => {
    createProject('Timestamped');
    const list = getProjectList('test@example.com');
    const entry = list.find((p: any) => p.name === 'Timestamped');
    expect(entry).toBeDefined();
    expect(entry!.updatedAt).toBeDefined();
  });
});

describe('renameProject()', () => {
  beforeEach(() => {
    localStorage.clear();
    state.currentUserEmail = 'test@example.com';
    saveProjectList('test@example.com', [
      { id: 'p1', name: 'Old Name', updatedAt: '2025-01-01T00:00:00Z' },
      { id: 'p2', name: 'Other', updatedAt: '2025-01-02T00:00:00Z' },
    ]);
    setupDataDOM();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('updates the project name', () => {
    renameProject('p1', 'New Name');
    const list = getProjectList('test@example.com');
    const entry = list.find((p: any) => p.id === 'p1');
    expect(entry!.name).toBe('New Name');
  });

  it('does not affect other projects', () => {
    renameProject('p1', 'Renamed');
    const list = getProjectList('test@example.com');
    const other = list.find((p: any) => p.id === 'p2');
    expect(other!.name).toBe('Other');
  });

  it('does nothing if project id not found', () => {
    renameProject('nonexistent', 'Ghost');
    const list = getProjectList('test@example.com');
    expect(list).toHaveLength(2);
    expect(list[0].name).toBe('Old Name');
  });
});

describe('saveProject() / loadProject()', () => {
  beforeEach(() => {
    localStorage.clear();
    state.currentUserEmail = 'test@example.com';
    state.currentProjectId = 'proj-save-test';
    state.resetData();
    setupDataDOM();
    saveProjectList('test@example.com', [
      { id: 'proj-save-test', name: 'Save Test', updatedAt: '2025-01-01T00:00:00Z' },
    ]);
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('saves project data to localStorage', () => {
    state.currentData['revenue'] = [{ label: 'Sales', amount: 5000 }];
    (document.getElementById('companyName') as HTMLInputElement).value = 'Acme Corp';
    saveProject();
    const raw = localStorage.getItem('fsgen-project-proj-save-test');
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed.company).toBe('Acme Corp');
    expect(parsed.currentData.revenue).toEqual([{ label: 'Sales', amount: 5000 }]);
  });

  it('does nothing if no currentProjectId', () => {
    state.currentProjectId = null;
    saveProject();
    expect(localStorage.getItem('fsgen-project-null')).toBeNull();
  });

  it('does nothing if no currentUserEmail', () => {
    state.currentUserEmail = null;
    saveProject();
    // Should not throw
  });

  it('loads project data and populates state', () => {
    const projectData = {
      currentData: { revenue: [{ label: 'Income', amount: 1000 }] },
      priorData: {},
      company: 'Test Co',
      period: 'FY2025',
      priorPeriod: 'FY2024',
      currency: 'EUR',
      notes: {},
    };
    localStorage.setItem('fsgen-project-load-test', JSON.stringify(projectData));
    loadProject('load-test');
    expect(state.currentProjectId).toBe('load-test');
    expect(state.currentData['revenue']).toEqual([{ label: 'Income', amount: 1000 }]);
    expect((document.getElementById('companyName') as HTMLInputElement).value).toBe('Test Co');
    expect((document.getElementById('period') as HTMLInputElement).value).toBe('FY2025');
    expect((document.getElementById('currency') as HTMLInputElement).value).toBe('EUR');
  });

  it('updates updatedAt on the project entry when saving', () => {
    const before = new Date().toISOString();
    state.currentData['revenue'] = [{ label: 'Test', amount: 100 }];
    saveProject();
    const list = getProjectList('test@example.com');
    const entry = list.find((p: any) => p.id === 'proj-save-test');
    expect(entry!.updatedAt! >= before).toBe(true);
  });
});

describe('resetData()', () => {
  it('initializes all sections to empty arrays', () => {
    state.currentData['revenue'] = [{ label: 'Old', amount: 500 }];
    state.priorData['opex'] = [{ label: 'Old Exp', amount: 200 }];
    state.resetData();
    for (const section of SECTIONS) {
      expect(state.currentData[section]).toEqual([]);
      expect(state.priorData[section]).toEqual([]);
    }
  });

  it('handles being called multiple times', () => {
    state.resetData();
    state.resetData();
    for (const section of SECTIONS) {
      expect(state.currentData[section]).toEqual([]);
    }
  });
});

describe('exportProjectJSON()', () => {
  beforeEach(() => {
    localStorage.clear();
    state.currentUserEmail = 'test@example.com';
    state.currentProjectId = 'export-test';
    state.resetData();
    setupDataDOM();
    saveProjectList('test@example.com', [
      { id: 'export-test', name: 'Export Test', updatedAt: '2025-01-01T00:00:00Z' },
    ]);
    // Save some project data
    const projData = {
      currentData: { revenue: [{ label: 'Sales', amount: 10000 }] },
      priorData: {},
      company: 'Export Co',
      period: 'FY2025',
      priorPeriod: '',
      currency: '$',
      notes: {},
    };
    localStorage.setItem('fsgen-project-export-test', JSON.stringify(projData));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('alerts when no project is loaded', () => {
    state.currentProjectId = null;
    vi.stubGlobal('alert', vi.fn());
    exportProjectJSON();
    expect(alert).toHaveBeenCalledWith('No project loaded.');
  });

  it('alerts when no project data found', () => {
    // Remove the project data AND ensure saveProject won't recreate it
    localStorage.removeItem('fsgen-project-export-test');
    state.currentUserEmail = null; // This makes saveProject() bail early
    state.currentProjectId = 'export-test';
    vi.stubGlobal('alert', vi.fn());
    exportProjectJSON();
    expect(alert).toHaveBeenCalledWith('No project data found.');
  });

  it('creates a download link when project data exists', () => {
    // Mock URL.createObjectURL and the click/remove flow
    const mockUrl = 'blob:http://localhost/mock-blob';
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => mockUrl),
      revokeObjectURL: vi.fn(),
    });
    const appendSpy = vi.spyOn(document.body, 'appendChild');
    const removeSpy = vi.spyOn(document.body, 'removeChild');

    exportProjectJSON();

    expect(URL.createObjectURL).toHaveBeenCalled();
    expect(appendSpy).toHaveBeenCalled();
    expect(removeSpy).toHaveBeenCalled();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(mockUrl);
  });
});

describe('populateProjectSelect()', () => {
  beforeEach(() => {
    localStorage.clear();
    state.currentUserEmail = 'test@example.com';
    state.currentProjectId = 'p2';
    setupDataDOM();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('populates select element with project options', () => {
    saveProjectList('test@example.com', [
      { id: 'p1', name: 'First' },
      { id: 'p2', name: 'Second' },
    ]);
    populateProjectSelect();
    const sel = document.getElementById('project-select') as HTMLSelectElement;
    expect(sel.options).toHaveLength(2);
    expect(sel.options[0].textContent).toBe('First');
    expect(sel.options[1].textContent).toBe('Second');
  });

  it('marks the current project as selected', () => {
    saveProjectList('test@example.com', [
      { id: 'p1', name: 'First' },
      { id: 'p2', name: 'Second' },
    ]);
    populateProjectSelect();
    const sel = document.getElementById('project-select') as HTMLSelectElement;
    expect(sel.options[1].selected).toBe(true);
  });

  it('clears existing options before populating', () => {
    const sel = document.getElementById('project-select') as HTMLSelectElement;
    const opt = document.createElement('option');
    opt.textContent = 'Old';
    sel.appendChild(opt);
    saveProjectList('test@example.com', [{ id: 'p1', name: 'New' }]);
    populateProjectSelect();
    expect(sel.options).toHaveLength(1);
    expect(sel.options[0].textContent).toBe('New');
  });
});
