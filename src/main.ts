/* ═══════════════════════════════════════════════════════════════════════
   NoteFlow — main.ts
   Application entry point. Imports all modules and registers event
   listeners, replacing all inline onclick/onchange/oninput handlers.
   ═══════════════════════════════════════════════════════════════════════ */

// ─── Module Imports ────────────────────────────────────────────────────
import {
  initFirebase, debouncedSave, setSaveProjectFn,
} from './modules/config';
import {
  saveTemplateFromForm,
  resetTemplate, openTemplate, closeTemplate, setOnTemplateChanged,
} from './modules/templates';
import {
  saveProject,
  exportProjectJSON, importProjectJSON,
  setApplyFirmProfileToNewProjectFn, setApplySmartDefaultsFn,
  setSaveProjectWorkflowFn, setTrackProjectPatternsFn,
} from './modules/data';
import {
  handleSignIn, handleSignUp, handleForgotPassword,
  handleSignOut, showAuthView, verify2FASignIn,
  start2FASetup, disable2FA, openSecuritySettings, closeSecuritySettings,
  selectPlan, startCheckout, dismissTrialBanner,
  toggleTeamPanel, addTeamMember, removeTeamMember,
  openFirmProfile, closeFirmProfile, saveFirmProfileFromForm,
  initAuthListeners, setShowDashboardFn,
  applyFirmProfileToNewProject,
} from './modules/auth';
import {
  runImport, fileChosen, zoneDrag, zoneDragEnd, zoneDrop, downloadTemplate,
  applyMappings, applyComparativeMappings, importWizardBack,
} from './modules/import';
import {
  buildIncomeStatement, buildBalanceSheet,
  buildCashFlow, buildEquityStatement,
  applySmartDefaults, trackProjectPatterns,
  scrollToNoteField, dismissSuggestion,
} from './modules/statements';
import {
  generateNotes, runDisclosureChecklist,
  addMissingDisclosures,
} from './modules/notes';
import {
  generateAll, exportToExcel, exportPackagePDF,
} from './modules/export';
import { exportToWord } from './modules/docx-export';
import {
  dashCreateProject, goToDashboard, showDashboard, bootstrapAuth,
} from './modules/dashboard';
import {
  openWorkflowModal, closeWorkflowModal, assignReviewer,
  addComment, filterProjectGrid, saveProjectWorkflow,
} from './modules/workflow';
import {
  researchCompany, closeResearchPanel,
  applyAllResearch, applyResearchField,
} from './modules/research';
import { aiRewrite } from './modules/ai-rewrite';
import {
  switchTab, toggleDarkMode, toggleMobileMenu,
  savePriorYearBalances, clearPriorYearBalances,
  addAJEEntry, postAllAJE, unpostAJE,
  confirmClearAll, buildFinancialRatios, exportRatiosPDF,
  buildTrialBalanceEditor, loadPriorYearFields,
  tbUndo, tbRedo,
} from './modules/ui';
import {
  toggleConsolidation, addEntity, removeEntity, selectEntity,
  addElimination, removeElimination, addEliminationLine, removeEliminationLine,
  saveCurrentToSelectedEntity, setConsolidationUICallbacks,
} from './modules/consolidation';

// ─── Declare external libs on window ───────────────────────────────────
declare global {
  interface Window {
    XLSX: any;
    jspdf: any;
    Stripe: any;
    firebase: any;
  }
}

// ─── Action Registry ───────────────────────────────────────────────────
// Maps data-action attribute values to handler functions.
// This replaces all inline onclick="functionName()" handlers.
const actions: Record<string, (...args: any[]) => void> = {
  // Auth
  'handleSignIn': handleSignIn,
  'handleSignUp': handleSignUp,
  'handleForgotPassword': handleForgotPassword,
  'handleSignOut': handleSignOut,
  'showAuthView': showAuthView,
  'verify2FASignIn': verify2FASignIn,
  'start2FASetup': start2FASetup,
  'disable2FA': disable2FA,
  'openSecuritySettings': openSecuritySettings,
  'closeSecuritySettings': closeSecuritySettings,

  // Dashboard
  'dashCreateProject': dashCreateProject,
  'selectPlan': selectPlan,
  'startCheckout': startCheckout,
  'dismissTrialBanner': dismissTrialBanner,
  'toggleTeamPanel': toggleTeamPanel,
  'addTeamMember': addTeamMember,

  // Workflow
  'openWorkflowModal': openWorkflowModal,
  'closeWorkflowModal': closeWorkflowModal,
  'assignReviewer': assignReviewer,
  'addComment': addComment,

  // UI
  'toggleDarkMode': toggleDarkMode,
  'toggleMobileMenu': toggleMobileMenu,
  'goToDashboard': goToDashboard,
  'openFirmProfile': openFirmProfile,
  'closeFirmProfile': closeFirmProfile,
  'saveFirmProfileFromForm': saveFirmProfileFromForm,
  'confirmClearAll': confirmClearAll,

  // Import
  'runImport': runImport,
  'downloadTemplate': downloadTemplate,
  'importWizardBack': importWizardBack,

  // Data
  'savePriorYearBalances': savePriorYearBalances,
  'clearPriorYearBalances': clearPriorYearBalances,
  'addAJEEntry': addAJEEntry,
  'postAllAJE': postAllAJE,
  'unpostAJE': unpostAJE,
  'exportProjectJSON': exportProjectJSON,

  // Statements
  'generateAll': generateAll,
  'switchTab': switchTab,
  'buildFinancialRatios': buildFinancialRatios,
  'runDisclosureChecklist': runDisclosureChecklist,

  // Notes
  'generateNotes': generateNotes,
  'addMissingDisclosures': addMissingDisclosures,

  // Import
  'applyMappings': applyMappings,
  'applyComparativeMappings': applyComparativeMappings,

  // Statements — suggestions
  'scrollToNoteField': scrollToNoteField,
  'dismissSuggestion': dismissSuggestion,

  // Research
  'applyAllResearch': applyAllResearch,
  'applyResearchField': applyResearchField,

  // Export
  'exportToExcel': exportToExcel,
  'exportPackagePDF': exportPackagePDF,
  'exportToWord': () => exportToWord(),
  'exportRatiosPDF': exportRatiosPDF,

  // Templates
  'saveTemplateFromForm': saveTemplateFromForm,
  'resetTemplate': resetTemplate,
  'openTemplate': openTemplate,
  'closeTemplate': closeTemplate,

  // Research
  'researchCompany': researchCompany,
  'closeResearchPanel': closeResearchPanel,

  // AI Rewrite
  'aiRewrite': (targetId: string) => aiRewrite(targetId),

  // Consolidation
  'toggleConsolidation': toggleConsolidation,
  'addEntity': addEntity,
  'removeEntity': removeEntity,
  'selectEntity': selectEntity,
  'addElimination': addElimination,
  'removeElimination': removeElimination,
  'addEliminationLine': addEliminationLine,
  'removeEliminationLine': removeEliminationLine,

  // TB Editor Undo/Redo
  'tbUndo': tbUndo,
  'tbRedo': tbRedo,
};

// ─── Event Delegation ──────────────────────────────────────────────────
// Single click handler on document.body dispatches to the action registry.
// Elements use data-action="fnName" and optionally data-param="arg".
document.addEventListener('click', (e: MouseEvent) => {
  const target = (e.target as HTMLElement).closest('[data-action]') as HTMLElement | null;
  if (!target) return;

  const actionName = target.dataset.action!;
  const param = target.dataset.param;
  const fn = actions[actionName];

  if (fn) {
    e.preventDefault();
    if (param !== undefined) {
      fn(param);
    } else {
      fn();
    }
  } else {
    console.warn(`[NoteFlow] Unknown action: ${actionName}`);
  }
});

// ─── Keyboard Shortcuts ──────────────────────────────────────────────
document.addEventListener('keydown', (e: KeyboardEvent) => {
  const isMod = e.ctrlKey || e.metaKey;
  // Ctrl/Cmd+Z = Undo in TB editor (only when Input tab is active)
  if (isMod && e.key === 'z' && !e.shiftKey) {
    const inputPage = document.getElementById('page-input');
    if (inputPage && inputPage.style.display !== 'none') {
      e.preventDefault();
      tbUndo();
    }
  }
  // Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y = Redo in TB editor
  if (isMod && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
    const inputPage = document.getElementById('page-input');
    if (inputPage && inputPage.style.display !== 'none') {
      e.preventDefault();
      tbRedo();
    }
  }
});

// ─── Collapsible Cards ─────────────────────────────────────────────────
// Replaces onclick="this.parentElement.classList.toggle('collapsed')" and similar
document.addEventListener('click', (e: MouseEvent) => {
  const target = e.target as HTMLElement;

  // Card title collapse/expand
  if (target.classList.contains('card-title') && target.parentElement?.classList.contains('card-collapsible')) {
    target.parentElement.classList.toggle('collapsed');
    return;
  }

  // Ratios section title collapse
  if (target.classList.contains('ratios-section-title')) {
    target.parentElement?.classList.toggle('collapsed');
    return;
  }

  // Financial analysis card expand toggle
  if (target.classList.contains('card-title') && target.parentElement?.classList.contains('ratios-card')) {
    target.parentElement.classList.toggle('expanded');
    return;
  }
});

// ─── Radio Button Show/Hide (Notes Questionnaire) ─────────────────────
// Replaces all onchange="document.getElementById('nq-xxx').style.display='block/none'"
// Uses data-toggle-show and data-toggle-hide attributes on radio inputs.
document.addEventListener('change', (e: Event) => {
  const target = e.target as HTMLInputElement;
  if (target.type !== 'radio') return;

  const showIds = target.dataset.toggleShow;
  const hideIds = target.dataset.toggleHide;

  if (showIds) {
    showIds.split(',').forEach(id => {
      const el = document.getElementById(id.trim());
      if (el) el.style.display = 'block';
    });
  }
  if (hideIds) {
    hideIds.split(',').forEach(id => {
      const el = document.getElementById(id.trim());
      if (el) el.style.display = 'none';
    });
  }
});

// ─── Consolidation Toggle & Entity Selector ──────────────────────────
const consolToggle = document.getElementById('consol-toggle') as HTMLInputElement | null;
if (consolToggle) {
  consolToggle.addEventListener('change', () => toggleConsolidation());
}
const consolEntitySelect = document.getElementById('consol-entity-select') as HTMLSelectElement | null;
if (consolEntitySelect) {
  consolEntitySelect.addEventListener('change', () => {
    saveCurrentToSelectedEntity();
    selectEntity(consolEntitySelect.value);
  });
}

// ─── Import Zone Drag & Drop ──────────────────────────────────────────
const importZone = document.getElementById('zone-combined');
if (importZone) {
  importZone.addEventListener('dragover', (e) => zoneDrag(e as DragEvent, 'zone-combined'));
  importZone.addEventListener('dragleave', () => zoneDragEnd('zone-combined'));
  importZone.addEventListener('drop', (e) => zoneDrop(e as DragEvent, 'zone-combined', 'combined'));

  const fileInput = importZone.querySelector('input[type="file"]') as HTMLInputElement | null;
  if (fileInput) {
    fileInput.addEventListener('change', () => fileChosen(fileInput, 'zone-combined', 'combined'));
  }
}

// ─── File Import (Project JSON) ────────────────────────────────────────
const importProjectFileInput = document.getElementById('import-project-file') as HTMLInputElement | null;
if (importProjectFileInput) {
  importProjectFileInput.addEventListener('change', (e) => importProjectJSON(e));
}

// ─── Search Input ──────────────────────────────────────────────────────
const dashSearch = document.getElementById('dash-search') as HTMLInputElement | null;
if (dashSearch) {
  dashSearch.addEventListener('input', () => filterProjectGrid());
}

// ─── Debounced Save on Text Inputs ────────────────────────────────────
const debouncedSaveFields = ['companyName', 'currency', 'period', 'priorPeriod'];
debouncedSaveFields.forEach(id => {
  const el = document.getElementById(id) as HTMLInputElement | null;
  if (el) {
    el.addEventListener('input', () => debouncedSave());
  }
});

// ─── Notes Edit Answers Button ────────────────────────────────────────
// The "Edit Answers" button had an inline onclick that toggled two elements
// It's now handled by a data-action, but needs custom logic:
const editAnswersAction = () => {
  const outputWrapper = document.getElementById('notes-output-wrapper');
  const questionnaire = document.getElementById('notes-questionnaire');
  if (outputWrapper) outputWrapper.style.display = 'none';
  if (questionnaire) questionnaire.style.display = 'block';
};
actions['editNotesAnswers'] = editAnswersAction;

// ─── Import Project Button → Trigger Hidden File Input ────────────────
actions['triggerImportProject'] = () => {
  document.getElementById('import-project-file')?.click();
};

// ─── Print Action ──────────────────────────────────────────────────────
actions['printPage'] = () => window.print();

// ─── Compound Mobile Menu Actions ──────────────────────────────────────
actions['toggleDarkModeAndCloseMenu'] = () => {
  toggleDarkMode();
  toggleMobileMenu();
};
actions['openTemplateAndCloseMenu'] = () => {
  openTemplate();
  toggleMobileMenu();
};
actions['goToDashboardAndCloseMenu'] = () => {
  goToDashboard();
  toggleMobileMenu();
};

// ─── Application Init ──────────────────────────────────────────────────
async function initApp(): Promise<void> {
  try {
    // Initialize Firebase
    initFirebase();

    // Wire up cross-module callbacks (avoids circular dependencies)
    setSaveProjectFn(saveProject);
    setShowDashboardFn(showDashboard);
    setApplyFirmProfileToNewProjectFn(applyFirmProfileToNewProject);
    setApplySmartDefaultsFn(applySmartDefaults);
    setSaveProjectWorkflowFn(saveProjectWorkflow as unknown as (projectId: string, wf: Record<string, unknown>) => void);
    setTrackProjectPatternsFn(trackProjectPatterns);

    // Wire up consolidation → UI callbacks (avoids circular dep)
    setConsolidationUICallbacks(buildTrialBalanceEditor, loadPriorYearFields);

    // Wire up template → statements rebuild callback (avoids circular dep)
    setOnTemplateChanged(() => {
      buildIncomeStatement();
      buildBalanceSheet();
      buildCashFlow();
    });

    // Initialize Auth (sets up onAuthStateChanged)
    initAuthListeners();

    // Bootstrap auth state (check Firebase or localStorage session)
    bootstrapAuth();

    // Apply saved dark mode preference
    if (localStorage.getItem('nf-dark-mode') === 'true') {
      document.body.classList.add('dark');
    }

    // Wire "in thousands" checkbox to regenerate statements on change
    const thousandsCb = document.getElementById('inThousands') as HTMLInputElement | null;
    if (thousandsCb) {
      thousandsCb.addEventListener('change', () => {
        buildIncomeStatement();
        buildBalanceSheet();
        buildCashFlow();
        buildEquityStatement();
      });
    }

    console.log('[NoteFlow] App initialized');
  } catch (err) {
    console.error('[NoteFlow] Init failed:', err);
  }
}

// ─── Window Exports for Remaining Inline onclick Handlers ─────────────
// Only functions still referenced by inline onclick in files we cannot modify
// (auth.ts) need to remain on window. All other handlers use data-action
// event delegation or module-local delegation listeners.
Object.assign(window, {
  removeTeamMember,
});

// Boot the app when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}
