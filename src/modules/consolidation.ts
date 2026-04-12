/* ═══════════════════════════════════════════════════════════════════════
   NoteFlow — consolidation.ts
   Multi-entity consolidation: merges entity data, applies eliminations
   ═══════════════════════════════════════════════════════════════════════ */

import {
  state,
  SECTIONS,
  SECTION_SIGN,
  type SectionData,
  type LineItem,
  type EntityData,
  type EliminationEntry,
} from './state';
import { el, esc } from './utils';
import { saveProject } from './data';

// ─── Callback to avoid circular dependency with ui.ts ─────────────────────
let _rebuildTBEditor: (() => void) | null = null;
let _loadPriorFields: (() => void) | null = null;

export function setConsolidationUICallbacks(
  rebuildTB: () => void,
  loadPrior: () => void,
): void {
  _rebuildTBEditor = rebuildTB;
  _loadPriorFields = loadPrior;
}

function rebuildUI(): void {
  if (_rebuildTBEditor) _rebuildTBEditor();
  if (_loadPriorFields) _loadPriorFields();
}

// ─── Consolidation Logic ──────────────────────────────────────────────────

/**
 * Merges all entity SectionData by summing amounts for matching labels
 * and concatenating non-matching labels. Then applies elimination entries.
 */
export function consolidateData(): { currentData: SectionData; priorData: SectionData } {
  const merged: SectionData = {};
  const mergedPrior: SectionData = {};
  SECTIONS.forEach(s => { merged[s] = []; mergedPrior[s] = []; });

  // Merge all entities
  for (const entity of state.entities) {
    for (const section of SECTIONS) {
      mergeSection(merged[section], entity.currentData[section] || []);
      mergeSection(mergedPrior[section], entity.priorData[section] || []);
    }
  }

  // Apply elimination entries
  for (const elim of state.eliminations) {
    applyElimination(merged, elim);
  }

  return { currentData: merged, priorData: mergedPrior };
}

function mergeSection(target: LineItem[], source: LineItem[]): void {
  for (const item of source) {
    const existing = target.find(t => t.label === item.label);
    if (existing) {
      existing.amount = (Number(existing.amount) || 0) + (Number(item.amount) || 0);
    } else {
      target.push({ label: item.label, amount: Number(item.amount) || 0 });
    }
  }
}

function applyElimination(data: SectionData, entry: EliminationEntry): void {
  for (const line of entry.lines) {
    if (!data[line.section]) continue;
    const sign = SECTION_SIGN[line.section] || 1;
    // Debits increase debit-normal accounts (sign=1), decrease credit-normal (sign=-1)
    // Credits decrease debit-normal accounts (sign=1), increase credit-normal (sign=-1)
    const amount = sign * (line.debit - line.credit);
    const existing = data[line.section].find(item => item.label === line.label);
    if (existing) {
      existing.amount = (Number(existing.amount) || 0) + amount;
    } else {
      data[line.section].push({ label: line.label, amount: amount });
    }
  }
}

/**
 * Returns the effective data for statement builders.
 * When consolidation mode is on, returns merged data; otherwise returns state data directly.
 */
export function getEffectiveData(): { currentData: SectionData; priorData: SectionData } {
  if (state.consolidationMode && state.entities.length > 0) {
    return consolidateData();
  }
  return { currentData: state.currentData, priorData: state.priorData };
}

/**
 * Returns the company name, appending "(Consolidated)" when in consolidation mode.
 */
export function getConsolidatedCompanyName(baseName: string): string {
  if (state.consolidationMode && state.entities.length > 1) {
    return baseName + ' (Consolidated)';
  }
  return baseName;
}

// ─── Entity Management ────────────────────────────────────────────────────

export function toggleConsolidation(): void {
  state.consolidationMode = !state.consolidationMode;
  const panel = el('consolidation-panel');

  if (state.consolidationMode) {
    // Copy current data as first entity if no entities exist
    if (state.entities.length === 0) {
      const firstEntity: EntityData = {
        name: 'Primary Entity',
        currentData: {},
        priorData: {},
      };
      SECTIONS.forEach(s => {
        firstEntity.currentData[s] = [...(state.currentData[s] || []).map(item => ({ ...item }))];
        firstEntity.priorData[s] = [...(state.priorData[s] || []).map(item => ({ ...item }))];
      });
      state.entities.push(firstEntity);
      state.selectedEntityIndex = 0;
    }
    if (panel) panel.style.display = 'block';
  } else {
    // Use first entity's data as active data
    if (state.entities.length > 0) {
      const first = state.entities[0];
      SECTIONS.forEach(s => {
        state.currentData[s] = [...(first.currentData[s] || []).map(item => ({ ...item }))];
        state.priorData[s] = [...(first.priorData[s] || []).map(item => ({ ...item }))];
      });
    }
    if (panel) panel.style.display = 'none';
  }

  renderConsolidationUI();
  updateEntitySelector();
  saveProject();
}

export function addEntity(): void {
  const nameInput = el('new-entity-name') as HTMLInputElement | null;
  const name = nameInput?.value?.trim() || ('Entity ' + (state.entities.length + 1));
  const entity: EntityData = { name, currentData: {}, priorData: {} };
  SECTIONS.forEach(s => { entity.currentData[s] = []; entity.priorData[s] = []; });
  state.entities.push(entity);
  if (nameInput) nameInput.value = '';
  state.selectedEntityIndex = state.entities.length - 1;
  syncSelectedEntityToState();
  renderConsolidationUI();
  updateEntitySelector();
  saveProject();
}

export function removeEntity(indexStr: string): void {
  const index = parseInt(indexStr, 10);
  if (isNaN(index) || index < 0 || index >= state.entities.length) return;
  if (state.entities.length <= 1) return; // Must keep at least one entity
  state.entities.splice(index, 1);
  if (state.selectedEntityIndex >= state.entities.length) {
    state.selectedEntityIndex = state.entities.length - 1;
  }
  syncSelectedEntityToState();
  renderConsolidationUI();
  updateEntitySelector();
  saveProject();
}

export function selectEntity(indexStr: string): void {
  const index = parseInt(indexStr, 10);
  if (isNaN(index) || index < 0 || index >= state.entities.length) return;

  // Save current working data back to previous entity
  saveCurrentToSelectedEntity();

  state.selectedEntityIndex = index;
  syncSelectedEntityToState();
  rebuildUI();
}

/** Copy state.currentData/priorData into the currently selected entity */
export function saveCurrentToSelectedEntity(): void {
  if (!state.consolidationMode || state.entities.length === 0) return;
  const entity = state.entities[state.selectedEntityIndex];
  if (!entity) return;
  SECTIONS.forEach(s => {
    entity.currentData[s] = [...(state.currentData[s] || []).map(item => ({ ...item }))];
    entity.priorData[s] = [...(state.priorData[s] || []).map(item => ({ ...item }))];
  });
}

/** Load selected entity data into state.currentData/priorData for editing */
function syncSelectedEntityToState(): void {
  if (state.entities.length === 0) return;
  const entity = state.entities[state.selectedEntityIndex];
  if (!entity) return;
  SECTIONS.forEach(s => {
    state.currentData[s] = [...(entity.currentData[s] || []).map(item => ({ ...item }))];
    state.priorData[s] = [...(entity.priorData[s] || []).map(item => ({ ...item }))];
  });
  rebuildUI();
}

// ─── Elimination Management ──────────────────────────────────────────────

export function addElimination(): void {
  state.eliminations.push({
    description: '',
    lines: [
      { section: 'current-assets', label: '', debit: 0, credit: 0 },
      { section: 'current-assets', label: '', debit: 0, credit: 0 },
    ],
  });
  renderConsolidationUI();
  saveProject();
}

export function removeElimination(indexStr: string): void {
  const index = parseInt(indexStr, 10);
  if (isNaN(index) || index < 0 || index >= state.eliminations.length) return;
  state.eliminations.splice(index, 1);
  renderConsolidationUI();
  saveProject();
}

export function addEliminationLine(elimIndexStr: string): void {
  const elimIndex = parseInt(elimIndexStr, 10);
  if (isNaN(elimIndex) || elimIndex < 0 || elimIndex >= state.eliminations.length) return;
  state.eliminations[elimIndex].lines.push(
    { section: 'current-assets', label: '', debit: 0, credit: 0 }
  );
  renderConsolidationUI();
}

export function removeEliminationLine(paramStr: string): void {
  const [elimStr, lineStr] = paramStr.split(',');
  const elimIndex = parseInt(elimStr, 10);
  const lineIndex = parseInt(lineStr, 10);
  if (isNaN(elimIndex) || isNaN(lineIndex)) return;
  const elim = state.eliminations[elimIndex];
  if (!elim || lineIndex < 0 || lineIndex >= elim.lines.length) return;
  if (elim.lines.length <= 1) return; // Keep at least one line
  elim.lines.splice(lineIndex, 1);
  renderConsolidationUI();
}

// ─── Statement Data Swap ──────────────────────────────────────────────────

let _savedCurrentData: SectionData | null = null;
let _savedPriorData: SectionData | null = null;

/**
 * If consolidation mode is active with multiple entities, swaps in the
 * consolidated data onto state.currentData/priorData so that existing
 * statement builders work without modification. Call restoreStatementData()
 * when done.
 */
export function prepareStatementData(): void {
  if (!state.consolidationMode || state.entities.length <= 0) return;

  // Save current entity data back first
  saveCurrentToSelectedEntity();

  const consolidated = consolidateData();
  _savedCurrentData = state.currentData;
  _savedPriorData = state.priorData;
  state.currentData = consolidated.currentData;
  state.priorData = consolidated.priorData;
}

/**
 * Restores the original entity data after statement building.
 */
export function restoreStatementData(): void {
  if (_savedCurrentData) {
    state.currentData = _savedCurrentData;
    _savedCurrentData = null;
  }
  if (_savedPriorData) {
    state.priorData = _savedPriorData;
    _savedPriorData = null;
  }
}

// ─── Rendering ────────────────────────────────────────────────────────────

const SECTION_OPTIONS: { value: string; text: string }[] = [
  { value: 'revenue', text: 'Revenue' },
  { value: 'cogs', text: 'Cost of Goods Sold' },
  { value: 'opex', text: 'Operating Expenses' },
  { value: 'other', text: 'Other Income / Expense' },
  { value: 'current-assets', text: 'Current Assets' },
  { value: 'noncurrent-assets', text: 'Non-Current Assets' },
  { value: 'current-liab', text: 'Current Liabilities' },
  { value: 'noncurrent-liab', text: 'Non-Current Liabilities' },
  { value: 'equity', text: 'Equity' },
  { value: 'cf-operating', text: 'CF: Operating' },
  { value: 'cf-investing', text: 'CF: Investing' },
  { value: 'cf-financing', text: 'CF: Financing' },
];

function buildSectionOptions(selected: string): string {
  return SECTION_OPTIONS.map(opt =>
    '<option value="' + opt.value + '"' + (opt.value === selected ? ' selected' : '') + '>' + esc(opt.text) + '</option>'
  ).join('');
}

export function renderConsolidationUI(): void {
  const container = el('consolidation-entities');
  if (!container) return;

  // Entity list
  let html = '<div style="font-size:0.78rem;font-weight:600;color:var(--muted);margin-bottom:6px">ENTITIES</div>';
  for (let i = 0; i < state.entities.length; i++) {
    const entity = state.entities[i];
    const isSelected = i === state.selectedEntityIndex;
    const itemCount = SECTIONS.reduce((n, s) => n + (entity.currentData[s]?.length || 0), 0);
    html += '<div class="consol-entity-row" style="display:flex;align-items:center;gap:8px;margin-bottom:6px;padding:6px 8px;border-radius:6px;' +
      (isSelected ? 'background:var(--primary-bg);border:1px solid var(--primary);' : 'background:var(--bg);border:1px solid var(--border);') + '">';
    html += '<span style="cursor:pointer;flex:1;font-weight:' + (isSelected ? '600' : '400') + '" data-action="selectEntity" data-param="' + i + '">' +
      esc(entity.name) + ' <span style="color:var(--muted);font-size:0.8rem">(' + itemCount + ' accounts)</span></span>';
    if (state.entities.length > 1) {
      html += '<button class="btn btn-ghost btn-sm" data-action="removeEntity" data-param="' + i + '" style="color:var(--danger);padding:2px 6px;font-size:0.75rem">Remove</button>';
    }
    html += '</div>';
  }

  html += '<div style="display:flex;gap:8px;align-items:center;margin-top:8px">';
  html += '<input type="text" id="new-entity-name" placeholder="Entity name" style="flex:1;padding:4px 8px;font-size:0.85rem" />';
  html += '<button class="btn btn-primary btn-sm" data-action="addEntity">+ Add Entity</button>';
  html += '</div>';

  // Elimination entries
  html += '<div style="font-size:0.78rem;font-weight:600;color:var(--muted);margin-top:16px;margin-bottom:6px">ELIMINATION JOURNAL ENTRIES</div>';

  if (state.eliminations.length === 0) {
    html += '<p style="font-size:0.83rem;color:var(--muted);margin-bottom:8px">No elimination entries. Add one to eliminate intercompany balances.</p>';
  }

  for (let i = 0; i < state.eliminations.length; i++) {
    const entry = state.eliminations[i];
    html += '<div class="consol-elim-entry" style="border:1px solid var(--border);border-radius:6px;padding:10px;margin-bottom:8px;background:var(--bg)">';
    html += '<div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">';
    html += '<input type="text" value="' + esc(entry.description) + '" placeholder="Description (e.g. Eliminate intercompany receivable/payable)" ' +
      'style="flex:1;padding:4px 8px;font-size:0.85rem" data-elim-desc="' + i + '" />';
    html += '<button class="btn btn-ghost btn-sm" data-action="removeElimination" data-param="' + i + '" style="color:var(--danger);padding:2px 6px;font-size:0.75rem">Remove</button>';
    html += '</div>';

    html += '<table style="width:100%;font-size:0.83rem;border-collapse:collapse">';
    html += '<tr style="color:var(--muted)"><th style="text-align:left;padding:2px 4px">Type</th><th style="text-align:left;padding:2px 4px">Section</th><th style="text-align:left;padding:2px 4px">Account</th><th style="text-align:right;padding:2px 4px">Debit</th><th style="text-align:right;padding:2px 4px">Credit</th><th></th></tr>';

    for (let j = 0; j < entry.lines.length; j++) {
      const line = entry.lines[j];
      const typeLabel = line.debit > 0 ? 'DR' : line.credit > 0 ? 'CR' : '--';
      html += '<tr>';
      html += '<td style="padding:2px 4px;color:' + (typeLabel === 'DR' ? 'var(--success, green)' : typeLabel === 'CR' ? 'var(--danger, red)' : 'var(--muted)') + ';font-weight:600">' + typeLabel + '</td>';
      html += '<td style="padding:2px 4px"><select data-elim-section="' + i + ',' + j + '" style="font-size:0.83rem;padding:2px 4px">' + buildSectionOptions(line.section) + '</select></td>';
      html += '<td style="padding:2px 4px"><input type="text" value="' + esc(line.label) + '" placeholder="Account label" data-elim-label="' + i + ',' + j + '" style="width:100%;padding:2px 6px;font-size:0.83rem" /></td>';
      html += '<td style="padding:2px 4px"><input type="number" value="' + (line.debit || '') + '" placeholder="0" data-elim-debit="' + i + ',' + j + '" style="width:80px;padding:2px 6px;font-size:0.83rem;text-align:right" step="0.01" /></td>';
      html += '<td style="padding:2px 4px"><input type="number" value="' + (line.credit || '') + '" placeholder="0" data-elim-credit="' + i + ',' + j + '" style="width:80px;padding:2px 6px;font-size:0.83rem;text-align:right" step="0.01" /></td>';
      html += '<td style="padding:2px 4px">';
      if (entry.lines.length > 1) {
        html += '<button class="btn btn-ghost btn-sm" data-action="removeEliminationLine" data-param="' + i + ',' + j + '" style="color:var(--danger);padding:1px 4px;font-size:0.7rem">x</button>';
      }
      html += '</td>';
      html += '</tr>';
    }

    html += '</table>';
    html += '<button class="btn btn-ghost btn-sm" data-action="addEliminationLine" data-param="' + i + '" style="margin-top:4px;font-size:0.78rem">+ Add Line</button>';
    html += '</div>';
  }

  html += '<button class="btn btn-primary btn-sm" data-action="addElimination" style="margin-top:4px">+ Add Elimination Entry</button>';

  container.innerHTML = html;

  // Attach input listeners for elimination fields
  attachEliminationListeners();
}

function attachEliminationListeners(): void {
  // Description fields
  document.querySelectorAll('[data-elim-desc]').forEach((input) => {
    input.addEventListener('change', () => {
      const idx = parseInt((input as HTMLInputElement).dataset.elimDesc || '0', 10);
      if (state.eliminations[idx]) {
        state.eliminations[idx].description = (input as HTMLInputElement).value;
        saveProject();
      }
    });
  });

  // Section selects
  document.querySelectorAll('[data-elim-section]').forEach((select) => {
    select.addEventListener('change', () => {
      const param = (select as HTMLSelectElement).dataset.elimSection || '';
      const [eStr, lStr] = param.split(',');
      const line = state.eliminations[parseInt(eStr, 10)]?.lines[parseInt(lStr, 10)];
      if (line) {
        line.section = (select as HTMLSelectElement).value;
        saveProject();
      }
    });
  });

  // Label inputs
  document.querySelectorAll('[data-elim-label]').forEach((input) => {
    input.addEventListener('change', () => {
      const param = (input as HTMLInputElement).dataset.elimLabel || '';
      const [eStr, lStr] = param.split(',');
      const line = state.eliminations[parseInt(eStr, 10)]?.lines[parseInt(lStr, 10)];
      if (line) {
        line.label = (input as HTMLInputElement).value;
        saveProject();
      }
    });
  });

  // Debit inputs
  document.querySelectorAll('[data-elim-debit]').forEach((input) => {
    input.addEventListener('change', () => {
      const param = (input as HTMLInputElement).dataset.elimDebit || '';
      const [eStr, lStr] = param.split(',');
      const line = state.eliminations[parseInt(eStr, 10)]?.lines[parseInt(lStr, 10)];
      if (line) {
        line.debit = parseFloat((input as HTMLInputElement).value) || 0;
        saveProject();
        renderConsolidationUI();
      }
    });
  });

  // Credit inputs
  document.querySelectorAll('[data-elim-credit]').forEach((input) => {
    input.addEventListener('change', () => {
      const param = (input as HTMLInputElement).dataset.elimCredit || '';
      const [eStr, lStr] = param.split(',');
      const line = state.eliminations[parseInt(eStr, 10)]?.lines[parseInt(lStr, 10)];
      if (line) {
        line.credit = parseFloat((input as HTMLInputElement).value) || 0;
        saveProject();
        renderConsolidationUI();
      }
    });
  });
}

function updateEntitySelector(): void {
  const selector = el('consol-entity-select') as HTMLSelectElement | null;
  if (!selector) return;

  let html = '';
  for (let i = 0; i < state.entities.length; i++) {
    html += '<option value="' + i + '"' + (i === state.selectedEntityIndex ? ' selected' : '') + '>' + esc(state.entities[i].name) + '</option>';
  }
  selector.innerHTML = html;
}
