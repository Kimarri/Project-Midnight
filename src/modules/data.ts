/* ═══════════════════════════════════════════════════════════════════════
   NoteFlow — data.ts
   Cloud data layer, project CRUD, notes persistence
   ═══════════════════════════════════════════════════════════════════════ */

import { state, SECTIONS, type SectionData, type ProjectNotes } from './state';
import { ENCRYPTION_ENABLED, genId } from './config';
import { encryptData, decryptData } from './config';
import { getFirebaseUid, trackEvent } from './config';
import { el, elInput } from './utils';

// ─── Callback registration (avoids circular dependencies) ──────────────
let _applyFirmProfileToNewProjectFn: (() => void) | null = null;
let _applySmartDefaultsFn: (() => void) | null = null;
let _saveProjectWorkflowFn: ((projectId: string, wf: Record<string, unknown>) => void) | null = null;
let _trackProjectPatternsFn: (() => void) | null = null;

export function setApplyFirmProfileToNewProjectFn(fn: () => void): void { _applyFirmProfileToNewProjectFn = fn; }
export function setApplySmartDefaultsFn(fn: () => void): void { _applySmartDefaultsFn = fn; }
export function setSaveProjectWorkflowFn(fn: (projectId: string, wf: Record<string, unknown>) => void): void { _saveProjectWorkflowFn = fn; }
export function setTrackProjectPatternsFn(fn: () => void): void { _trackProjectPatternsFn = fn; }

// ─── Types ─────────────────────────────────────────────────────────────

interface ProjectListEntry {
  id: string;
  name: string;
  createdAt?: string;
  updatedAt?: string;
}

interface ProjectPayload {
  currentData: SectionData;
  priorData: SectionData;
  company: string;
  period: string;
  priorPeriod: string;
  currency: string;
  notes: ProjectNotes;
  engagementDate?: string;
  reportDate?: string;
  inThousands?: boolean;
  noteOrder?: string[];
}

interface CloudProjectDoc {
  name: string;
  createdAt?: string;
  updatedAt?: string;
  data?: ProjectPayload;
  encryptedData?: string;
  aje?: unknown;
}

interface ExportData {
  _noteflow: boolean;
  _version: number;
  _exportedAt: string;
  projectName: string;
  project: ProjectPayload;
  adjustingEntries?: unknown;
}

// ─── Cloud Data Layer (Firestore + localStorage) ───────────────────────
// All data operations go through these helpers. When Firebase is configured and
// the user is authenticated, data syncs to Firestore with localStorage as cache.
// When Firebase is not configured, localStorage is used exclusively.

export function cloudSaveUserData(field: string, data: unknown): Promise<void> {
  const uid = getFirebaseUid();
  if (!uid) return Promise.resolve();
  return state.firebaseDb.collection('users').doc(uid).set(
    { [field]: data },
    { merge: true }
  ).catch((err: Error) => { console.warn('Cloud save failed (' + field + '):', err); });
}

export function cloudLoadUserData(field: string): Promise<unknown | null> {
  const uid = getFirebaseUid();
  if (!uid) return Promise.resolve(null);
  return state.firebaseDb.collection('users').doc(uid).get()
    .then((doc: any) => {
      if (!doc.exists) return null;
      return doc.data()[field] || null;
    })
    .catch((err: Error) => { console.warn('Cloud load failed (' + field + '):', err); return null; });
}

export function cloudSaveProject(projectId: string, projectData: CloudProjectDoc): Promise<void> {
  const uid = getFirebaseUid();
  if (!uid) return Promise.resolve();
  return state.firebaseDb.collection('users').doc(uid).collection('projects').doc(projectId).set(projectData, { merge: true })
    .catch((err: Error) => {
      console.warn('Cloud project save failed:', err);
      const syncStatusEl = el('import-status');
      if (syncStatusEl) syncStatusEl.innerHTML = '<span style="color:var(--danger,#e74c3c);font-size:0.82rem">⚠ Cloud sync failed — your data is saved locally but not backed up. Check your connection.</span>';
    });
}

export function cloudLoadProject(projectId: string): Promise<CloudProjectDoc | null> {
  const uid = getFirebaseUid();
  if (!uid) return Promise.resolve(null);
  return state.firebaseDb.collection('users').doc(uid).collection('projects').doc(projectId).get()
    .then((doc: any) => doc.exists ? doc.data() as CloudProjectDoc : null)
    .catch((err: Error) => { console.warn('Cloud project load failed:', err); return null; });
}

export function cloudDeleteProject(projectId: string): Promise<void> {
  const uid = getFirebaseUid();
  if (!uid) return Promise.resolve();
  return state.firebaseDb.collection('users').doc(uid).collection('projects').doc(projectId).delete()
    .catch((err: Error) => { console.warn('Cloud project delete failed:', err); });
}

function cloudLoadAllProjects(): Promise<ProjectListEntry[]> {
  const uid = getFirebaseUid();
  if (!uid) return Promise.resolve([]);
  return state.firebaseDb.collection('users').doc(uid).collection('projects').get()
    .then((snapshot: any) => {
      const list: ProjectListEntry[] = [];
      snapshot.forEach((doc: any) => {
        const d = doc.data();
        list.push({ id: doc.id, name: d.name || 'Unnamed', createdAt: d.createdAt || '', updatedAt: d.updatedAt || '' });
      });
      return list;
    })
    .catch((err: Error) => { console.warn('Cloud project list failed:', err); return [] as ProjectListEntry[]; });
}

// Migrate localStorage data to Firestore on first cloud login
export function migrateToCloud(): Promise<void> {
  const uid = getFirebaseUid();
  if (!uid || !state.currentUserEmail) return Promise.resolve();

  // Check if migration already happened
  const migKey = 'noteflow-cloud-migrated-' + state.currentUserEmail;
  if (localStorage.getItem(migKey)) return Promise.resolve();

  const promises: Promise<void>[] = [];

  // Migrate projects
  const list = getProjectList(state.currentUserEmail);
  list.forEach((entry: ProjectListEntry) => {
    const raw = localStorage.getItem('fsgen-project-' + entry.id);
    if (!raw) return;
    const projData: CloudProjectDoc = {
      name: entry.name,
      createdAt: entry.createdAt || new Date().toISOString(),
      updatedAt: entry.updatedAt || new Date().toISOString(),
    };
    try {
      // Handle encrypted data — store the raw string in a 'encryptedData' field for migration
      if (raw.startsWith('ENC:')) {
        projData.encryptedData = raw;
      } else {
        projData.data = JSON.parse(raw);
      }
    } catch (e) { return; }

    // Migrate AJE data
    const ajeRaw = localStorage.getItem('fsgen-aje-' + entry.id);
    if (ajeRaw) {
      try { projData.aje = JSON.parse(ajeRaw); } catch (e) { /* ignore */ }
    }

    promises.push(cloudSaveProject(entry.id, projData));
  });

  // Migrate user-level data
  const firmRaw = localStorage.getItem('noteflow-firmprofile-' + state.currentUserEmail);
  if (firmRaw) {
    try { promises.push(cloudSaveUserData('firmProfile', JSON.parse(firmRaw))); } catch (e) { /* ignore */ }
  }

  const tplRaw = localStorage.getItem('noteflow-template-' + state.currentUserEmail);
  if (tplRaw) {
    try { promises.push(cloudSaveUserData('template', JSON.parse(tplRaw))); } catch (e) { /* ignore */ }
  }

  const patRaw = localStorage.getItem('noteflow-patterns-' + state.currentUserEmail);
  if (patRaw) {
    try { promises.push(cloudSaveUserData('patterns', JSON.parse(patRaw))); } catch (e) { /* ignore */ }
  }

  const disRaw = localStorage.getItem('noteflow-dismissed-' + state.currentUserEmail);
  if (disRaw) {
    try { promises.push(cloudSaveUserData('dismissed', JSON.parse(disRaw))); } catch (e) { /* ignore */ }
  }

  return Promise.all(promises).then(() => {
    localStorage.setItem(migKey, '1');
    console.log('NoteFlow: Data migrated to cloud successfully');
  }).catch((err: Error) => {
    console.warn('NoteFlow: Cloud migration had errors:', err);
  });
}

// ─── Project Management ─────────────────────────────────────────────────────

export function getProjectList(email: string): ProjectListEntry[] {
  try {
    return JSON.parse(localStorage.getItem('fsgen-projects-' + email) || '[]') as ProjectListEntry[];
  } catch (e) { return []; }
}

// Async version that syncs with cloud
export function getProjectListCloud(callback: (list: ProjectListEntry[]) => void): void {
  const local = getProjectList(state.currentUserEmail!);
  if (!getFirebaseUid()) { callback(local); return; }

  cloudLoadAllProjects().then((cloudList: ProjectListEntry[]) => {
    if (cloudList.length === 0 && local.length > 0) {
      // Cloud is empty but local has data — use local (migration pending)
      callback(local);
      return;
    }
    if (cloudList.length > 0) {
      // Merge: cloud is source of truth, but keep any local-only projects
      const cloudIds: Record<string, boolean> = {};
      cloudList.forEach((p: ProjectListEntry) => { cloudIds[p.id] = true; });
      const merged = cloudList.slice();
      local.forEach((p: ProjectListEntry) => {
        if (!cloudIds[p.id]) merged.push(p);
      });
      // Update localStorage cache
      saveProjectList(state.currentUserEmail!, merged);
      callback(merged);
      return;
    }
    callback(local);
  });
}

export function saveProjectList(email: string, list: ProjectListEntry[]): void {
  localStorage.setItem('fsgen-projects-' + email, JSON.stringify(list));
  // Cloud sync happens at project level, not list level — the list is derived from project docs
}

/**
 * Loads a project by ID from localStorage or cloud, decrypts if needed, and populates the UI.
 */
export function loadProject(id: string): void {
  const raw = localStorage.getItem('fsgen-project-' + id);

  function applyProject(projJson: string): void {
    try {
      const proj: ProjectPayload = JSON.parse(projJson);
      state.currentProjectId = id;
      SECTIONS.forEach((s: string) => {
        state.currentData[s] = (proj.currentData && proj.currentData[s]) ? proj.currentData[s] : [];
        state.priorData[s] = (proj.priorData && proj.priorData[s]) ? proj.priorData[s] : [];
      });
      const companyEl = elInput('companyName');
      const periodEl = elInput('period');
      const priorPeriodEl = elInput('priorPeriod');
      const currencyEl = elInput('currency');
      if (companyEl) companyEl.value = proj.company || '';
      if (periodEl) periodEl.value = proj.period || '';
      if (priorPeriodEl) priorPeriodEl.value = proj.priorPeriod || '';
      if (currencyEl) currencyEl.value = proj.currency || '$';
      const engDateEl = elInput('engagementDate');
      const repDateEl = elInput('reportDate');
      const thousandsEl = document.getElementById('inThousands') as HTMLInputElement | null;
      if (engDateEl) engDateEl.value = proj.engagementDate || '';
      if (repDateEl) repDateEl.value = proj.reportDate || '';
      if (thousandsEl) thousandsEl.checked = proj.inThousands || false;
      if (proj.noteOrder && Array.isArray(proj.noteOrder)) {
        state.noteOrder = proj.noteOrder;
      } else {
        state.noteOrder = [];
      }
      if (proj.notes) {
        loadNotesFromProject(proj.notes);
      }
    } catch (e) {
      console.error('Failed to load project data:', e);
      alert('This project\'s data appears to be corrupted and could not be loaded.');
    }
  }

  function applyFromRaw(rawData: string): void {
    if (!rawData) return;
    if (rawData.startsWith('ENC:') && state.currentUserEmail) {
      decryptData(rawData, state.currentUserEmail).then((decrypted: string | null) => {
        if (decrypted !== null) applyProject(decrypted);
      }).catch((err: Error) => {
        console.error('Project decryption error:', err);
        alert('Failed to decrypt project data. Please try reloading the page.');
      });
    } else {
      applyProject(rawData);
    }
  }

  if (raw) {
    applyFromRaw(raw);
  } else if (getFirebaseUid()) {
    // Try loading from cloud
    cloudLoadProject(id).then((cloudDoc: CloudProjectDoc | null) => {
      if (cloudDoc && cloudDoc.data) {
        const projJson = JSON.stringify(cloudDoc.data);
        // Cache locally
        localStorage.setItem('fsgen-project-' + id, projJson);
        state.currentProjectId = id;
        applyProject(projJson);
      }
    });
  }
}

/**
 * Saves the current project state to localStorage (optionally encrypted) and syncs to Firestore cloud.
 */
export function saveProject(): void {
  if (!state.currentProjectId || !state.currentUserEmail) return;

  const proj: ProjectPayload = {
    currentData: {} as SectionData,
    priorData: {} as SectionData,
    company: elInput('companyName')?.value ?? '',
    period: elInput('period')?.value ?? '',
    priorPeriod: elInput('priorPeriod')?.value ?? '',
    currency: elInput('currency')?.value ?? '$',
    notes: collectNotesData(),
    engagementDate: elInput('engagementDate')?.value ?? '',
    reportDate: elInput('reportDate')?.value ?? '',
    inThousands: (document.getElementById('inThousands') as HTMLInputElement | null)?.checked ?? false,
    noteOrder: state.noteOrder.length > 0 ? state.noteOrder : undefined,
  };
  SECTIONS.forEach((s: string) => {
    proj.currentData[s] = state.currentData[s];
    proj.priorData[s] = state.priorData[s];
  });
  const projJson = JSON.stringify(proj);
  if (ENCRYPTION_ENABLED && state.currentUserEmail) {
    encryptData(projJson, state.currentUserEmail).then((encrypted: string) => {
      try {
        localStorage.setItem('fsgen-project-' + state.currentProjectId, encrypted);
      } catch (storageErr) {
        console.error('localStorage save failed (quota?):', storageErr);
        alert('Unable to save project locally — your browser storage may be full. Try deleting old projects.');
      }
    });
  } else {
    try {
      localStorage.setItem('fsgen-project-' + state.currentProjectId!, projJson);
    } catch (storageErr) {
      console.error('localStorage save failed (quota?):', storageErr);
      alert('Unable to save project locally — your browser storage may be full. Try deleting old projects.');
    }
  }

  // Track patterns for learning intelligence
  if (_trackProjectPatternsFn) {
    try { _trackProjectPatternsFn(); } catch (e) { /* ignore */ }
  }

  // Update project index updatedAt
  const list = getProjectList(state.currentUserEmail);
  const entry = list.find((p: ProjectListEntry) => p.id === state.currentProjectId);
  const nowISO = new Date().toISOString();
  if (entry) {
    entry.updatedAt = nowISO;
    saveProjectList(state.currentUserEmail, list);
  }

  // Cloud sync (reuse same list, no duplicate call)
  if (getFirebaseUid()) {
    const cloudDoc: CloudProjectDoc = {
      name: entry ? entry.name : 'Unnamed',
      updatedAt: nowISO,
      data: proj,
    };
    cloudSaveProject(state.currentProjectId, cloudDoc);
  }
}

/**
 * Creates a new blank project, resets all working data and UI fields, and adds it to the project list.
 */
export function createProject(name: string): string {
  trackEvent('projects_created');
  const id = genId();
  state.currentProjectId = id;

  // Reset working state
  SECTIONS.forEach((s: string) => { state.currentData[s] = []; state.priorData[s] = []; });
  const companyEl = elInput('companyName');
  const periodEl = elInput('period');
  const priorPeriodEl = elInput('priorPeriod');
  const currencyEl = elInput('currency');
  if (companyEl) companyEl.value = '';
  if (periodEl) periodEl.value = '';
  if (priorPeriodEl) priorPeriodEl.value = '';
  if (currencyEl) currencyEl.value = '$';

  // Apply firm defaults and smart defaults to new project
  if (_applyFirmProfileToNewProjectFn) _applyFirmProfileToNewProjectFn();
  if (_applySmartDefaultsFn) _applySmartDefaultsFn();

  // Save blank project
  saveProject();

  // Add to index
  const list = getProjectList(state.currentUserEmail!);
  list.push({ id, name, updatedAt: new Date().toISOString() });
  saveProjectList(state.currentUserEmail!, list);

  // Initialize workflow
  if (_saveProjectWorkflowFn) _saveProjectWorkflowFn(id, {
    status: 'draft',
    assignees: [],
    comments: [],
    history: [{ action: 'Project created', by: state.currentUserEmail, at: new Date().toISOString() }],
    createdBy: state.currentUserEmail,
  });

  populateProjectSelect();
  return id;
}

export function renameProject(id: string, newName: string): void {
  const list = getProjectList(state.currentUserEmail!);
  const entry = list.find((p: ProjectListEntry) => p.id === id);
  if (entry) {
    entry.name = newName;
    saveProjectList(state.currentUserEmail!, list);
    populateProjectSelect();
  }
}

export function populateProjectSelect(): void {
  const sel = el('project-select') as HTMLSelectElement | null;
  if (!sel) return;
  const list = getProjectList(state.currentUserEmail!);
  sel.innerHTML = '';
  list.forEach((p: ProjectListEntry) => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    if (p.id === state.currentProjectId) opt.selected = true;
    sel.appendChild(opt);
  });
}

// ─── Project Export / Import (JSON Backup) ─────────────────────────────────

export function exportProjectJSON(): void {
  if (!state.currentProjectId) { alert('No project loaded.'); return; }
  saveProject(); // ensure latest state is saved

  function performExport(projJson: string): void {
    const proj: ProjectPayload = JSON.parse(projJson);
    const list = getProjectList(state.currentUserEmail!);
    const entry = list.find((p: ProjectListEntry) => p.id === state.currentProjectId);
    const exportData: ExportData = {
      _noteflow: true,
      _version: 1,
      _exportedAt: new Date().toISOString(),
      projectName: entry ? entry.name : 'Unnamed',
      project: proj,
    };

    // Include AJE data if present
    const ajeKey = 'fsgen-aje-' + state.currentProjectId;
    const ajeRaw = localStorage.getItem(ajeKey);
    if (ajeRaw) {
      try { exportData.adjustingEntries = JSON.parse(ajeRaw); } catch (e) { /* ignore */ }
    }

    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const safeName = (exportData.projectName || 'project').replace(/[^a-zA-Z0-9_-]/g, '_');
    a.download = 'NoteFlow_' + safeName + '_' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  const raw = localStorage.getItem('fsgen-project-' + state.currentProjectId);
  if (!raw) { alert('No project data found.'); return; }

  if (raw.startsWith('ENC:') && state.currentUserEmail) {
    decryptData(raw, state.currentUserEmail).then((decrypted: string | null) => {
      if (decrypted !== null) performExport(decrypted);
    }).catch((err: Error) => {
      console.error('Export decryption error:', err);
      alert('Failed to decrypt project data for export.');
    });
  } else {
    performExport(raw);
  }
}

export function importProjectJSON(event: Event): void {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) { alert('File too large. Maximum size is 5MB.'); return; }
  input.value = ''; // reset so same file can be re-imported

  const reader = new FileReader();
  reader.onerror = function() { alert('Failed to read the file.'); };
  reader.onload = (e: ProgressEvent<FileReader>) => {
    try {
      const data = JSON.parse(e.target!.result as string) as ExportData;
      if (!data._noteflow || !data.project) {
        alert('Invalid NoteFlow project file. Please select a file exported from NoteFlow.');
        return;
      }

      const importName = data.projectName || 'Imported Project';
      if (!confirm('Import project "' + importName + '"?\n\nThis will create a new project with the imported data.')) return;

      // Create new project entry
      const newId = genId();
      const list = getProjectList(state.currentUserEmail!);
      list.push({ id: newId, name: importName, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      saveProjectList(state.currentUserEmail!, list);

      // Save project data
      localStorage.setItem('fsgen-project-' + newId, JSON.stringify(data.project));

      // Restore AJE data if present
      if (data.adjustingEntries) {
        localStorage.setItem('fsgen-aje-' + newId, JSON.stringify(data.adjustingEntries));
      }

      // Switch to imported project
      if (state.currentProjectId) saveProject();
      loadProject(newId);
      populateProjectSelect();
      alert('Project "' + importName + '" imported successfully.');

    } catch (err) {
      alert('Error reading file: ' + (err as Error).message);
    }
  };
  reader.readAsText(file);
}

// ─── Notes Persistence ──────────────────────────────────────────────────────

export function collectNotesData(): ProjectNotes {
  const data: ProjectNotes = {};
  const textIds: string[] = [
    'nq-business-desc', 'nq-state', 'nq-formed', 'nq-entity-type', 'nq-basis',
    'nq-revenue-recognition', 'nq-cash-equiv', 'nq-allowance-text', 'nq-inventory',
    'nq-depreciation', 'nq-useful-lives', 'nq-intangibles-text', 'nq-advertising',
    'nq-tax-status', 'nq-tax-uncertain-text',
    'nq-debt-text', 'nq-loc-text', 'nq-leases-text',
    'nq-equity-text', 'nq-distributions-text',
    'nq-related-text', 'nq-cust-conc-text', 'nq-vendor-conc-text',
    'nq-litigation-text', 'nq-other-commit-text',
    'nq-subseq-date', 'nq-subseq-text', 'nq-gc-text',
  ];
  textIds.forEach((id: string) => {
    const fieldEl = document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | null;
    if (fieldEl) data[id] = fieldEl.value;
  });
  const radioNames: string[] = [
    'nq-allowance', 'nq-intangibles', 'nq-tax-uncertain',
    'nq-debt', 'nq-leases', 'nq-lease-shortterm',
    'nq-distributions', 'nq-related', 'nq-fdic',
    'nq-cust-conc', 'nq-vendor-conc', 'nq-litigation', 'nq-other-commit',
    'nq-subseq', 'nq-going-concern',
  ];
  radioNames.forEach((name: string) => {
    const checked = document.querySelector('input[name="' + name + '"]:checked') as HTMLInputElement | null;
    data[name] = checked ? checked.value : 'no';
  });
  return data;
}

function loadNotesFromProject(notes: ProjectNotes): void {
  if (!notes) return;
  const textIds: string[] = [
    'nq-business-desc', 'nq-state', 'nq-formed', 'nq-entity-type', 'nq-basis',
    'nq-revenue-recognition', 'nq-cash-equiv', 'nq-allowance-text', 'nq-inventory',
    'nq-depreciation', 'nq-useful-lives', 'nq-intangibles-text', 'nq-advertising',
    'nq-tax-status', 'nq-tax-uncertain-text',
    'nq-debt-text', 'nq-loc-text', 'nq-leases-text',
    'nq-equity-text', 'nq-distributions-text',
    'nq-related-text', 'nq-cust-conc-text', 'nq-vendor-conc-text',
    'nq-litigation-text', 'nq-other-commit-text',
    'nq-subseq-date', 'nq-subseq-text', 'nq-gc-text',
  ];
  textIds.forEach((id: string) => {
    const fieldEl = document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | null;
    if (fieldEl && notes[id] !== undefined) fieldEl.value = notes[id] as string;
  });
  const radioDetailMap: Record<string, string> = {
    'nq-allowance': 'nq-allowance-detail',
    'nq-intangibles': 'nq-intangibles-detail',
    'nq-tax-uncertain': 'nq-tax-uncertain-detail',
    'nq-debt': 'nq-debt-detail',
    'nq-leases': 'nq-leases-detail',
    'nq-distributions': 'nq-distributions-detail',
    'nq-related': 'nq-related-detail',
    'nq-cust-conc': 'nq-cust-conc-detail',
    'nq-vendor-conc': 'nq-vendor-conc-detail',
    'nq-litigation': 'nq-litigation-detail',
    'nq-other-commit': 'nq-other-commit-detail',
    'nq-subseq': 'nq-subseq-detail',
    'nq-going-concern': 'nq-gc-detail',
  };
  const radioNoDetail: string[] = ['nq-fdic', 'nq-lease-shortterm'];
  Object.keys(radioDetailMap).forEach((name: string) => {
    const val = (notes[name] as string) || 'no';
    const radios = document.querySelectorAll<HTMLInputElement>('input[name="' + name + '"]');
    radios.forEach((r: HTMLInputElement) => { r.checked = (r.value === val); });
    const detailDiv = document.getElementById(radioDetailMap[name]);
    if (detailDiv) detailDiv.style.display = val === 'yes' ? 'block' : 'none';
  });
  radioNoDetail.forEach((name: string) => {
    const val = (notes[name] as string) || 'no';
    const radios = document.querySelectorAll<HTMLInputElement>('input[name="' + name + '"]');
    radios.forEach((r: HTMLInputElement) => { r.checked = (r.value === val); });
  });
}

export function saveNotesToProject(): void {
  saveProject();
}
