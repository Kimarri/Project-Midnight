/* ═══════════════════════════════════════════════════════════════════════
   NoteFlow — ui.ts
   Tabs, trial balance editor, AJE, dark mode, badges, financial ratios
   ═══════════════════════════════════════════════════════════════════════ */

import {
  state,
  SECTIONS,
  SECTION_SIGN,
  type SectionData,
  type LineItem,
  type AJEEntry,
  type AJELine,
} from './state';
import { esc, fmt, sum, rows, cur, hasPriorData, el, elInput } from './utils';
import {
  saveProject,
} from './data';
import {
  buildIncomeStatement,
  buildBalanceSheet,
  buildCashFlow,
  buildEquityStatement,
  renderSuggestions,
} from './statements';
import { applyTemplateToStatements } from './templates';
import { generateAll, clearAll, exportToExcel, exportPackagePDF } from './export';
import { autoPopulateFromTB } from './notes';

// ─── Local Types ───────────────────────────────────────────────────────────

interface SectionGroupOption {
  value: string;
  text: string;
}

interface SectionGroup {
  label: string;
  options: SectionGroupOption[];
}

interface PYField {
  id: string;
  section: string;
  label: string;
}

// ─── Local AJE Section Groups (richer structure for <optgroup> rendering) ──

const AJE_SECTION_GROUPS: SectionGroup[] = [
  { label: 'Income Statement', options: [
    { value: 'revenue',    text: 'Revenue' },
    { value: 'cogs',       text: 'Cost of Goods Sold' },
    { value: 'opex',       text: 'Operating Expenses' },
    { value: 'other',      text: 'Other Income / Expense' },
  ]},
  { label: 'Balance Sheet', options: [
    { value: 'current-assets',    text: 'Current Assets' },
    { value: 'noncurrent-assets', text: 'Non-Current Assets' },
    { value: 'current-liab',      text: 'Current Liabilities' },
    { value: 'noncurrent-liab',   text: 'Non-Current Liabilities' },
    { value: 'equity',            text: "Shareholders' Equity" },
  ]},
  { label: 'Cash Flow', options: [
    { value: 'cf-operating',  text: 'Operating Activities' },
    { value: 'cf-investing',  text: 'Investing Activities' },
    { value: 'cf-financing',  text: 'Financing Activities' },
  ]},
];

// ─── Local Section Labels (ui.js uses a slightly different set) ────────────

const UI_SECTION_LABELS: Record<string, string> = {
  'revenue': 'Revenue', 'cogs': 'Cost of Goods Sold', 'opex': 'Operating Expenses',
  'other': 'Other Income / Expense', 'current-assets': 'Current Assets',
  'noncurrent-assets': 'Non-Current Assets', 'current-liab': 'Current Liabilities',
  'noncurrent-liab': 'Non-Current Liabilities', 'equity': "Shareholders' Equity",
  'cf-operating': 'Operating Activities', 'cf-investing': 'Investing Activities',
  'cf-financing': 'Financing Activities',
};

import { runDisclosureChecklist } from './notes';

// ─── TB Editor Undo/Redo ──────────────────────────────────────────────────
interface TBSnapshot { currentData: SectionData; priorData: SectionData; }
const tbUndoStack: TBSnapshot[] = [];
const tbRedoStack: TBSnapshot[] = [];
const MAX_UNDO = 30;

function cloneData(d: SectionData): SectionData {
  const c: SectionData = {};
  for (const k in d) { c[k] = d[k].map(item => ({ ...item })); }
  return c;
}

export function pushTBUndo(): void {
  tbUndoStack.push({ currentData: cloneData(state.currentData), priorData: cloneData(state.priorData) });
  if (tbUndoStack.length > MAX_UNDO) tbUndoStack.shift();
  tbRedoStack.length = 0; // clear redo on new edit
}

export function tbUndo(): void {
  if (tbUndoStack.length === 0) return;
  tbRedoStack.push({ currentData: cloneData(state.currentData), priorData: cloneData(state.priorData) });
  const snap = tbUndoStack.pop()!;
  state.currentData = snap.currentData;
  state.priorData = snap.priorData;
  saveProject();
  buildTrialBalanceEditor();
}

export function tbRedo(): void {
  if (tbRedoStack.length === 0) return;
  tbUndoStack.push({ currentData: cloneData(state.currentData), priorData: cloneData(state.priorData) });
  const snap = tbRedoStack.pop()!;
  state.currentData = snap.currentData;
  state.priorData = snap.priorData;
  saveProject();
  buildTrialBalanceEditor();
}

// ─── Tab Switching ──────────────────────────────────────────────────────────

const TAB_NAMES = ['input', 'balance', 'income', 'equity', 'cashflow', 'notes', 'checklist', 'ratios'];

export function switchTab(name: string): void {
  document.querySelectorAll('.page').forEach(function(p: Element) { p.classList.remove('active'); });
  document.querySelectorAll('.tab').forEach(function(t: Element) {
    t.classList.remove('active');
    t.setAttribute('aria-selected', 'false');
    t.setAttribute('tabindex', '-1');
  });
  el('page-' + name)?.classList.add('active');
  const tabs: Record<string, number> = { input: 0, balance: 1, income: 2, equity: 3, cashflow: 4, notes: 5, checklist: 6, ratios: 7 };
  const activeTab = document.querySelectorAll('.tab')[tabs[name]] as HTMLElement | undefined;
  if (activeTab) {
    activeTab.classList.add('active');
    activeTab.setAttribute('aria-selected', 'true');
    activeTab.setAttribute('tabindex', '0');
  }

  if (name === 'income') { buildIncomeStatement(); applyTemplateToStatements(); buildFinancialRatios(); }
  if (name === 'balance') { buildBalanceSheet(); applyTemplateToStatements(); buildFinancialRatios(); }
  if (name === 'cashflow') { buildCashFlow(); applyTemplateToStatements(); }
  if (name === 'equity') { buildEquityStatement(); applyTemplateToStatements(); }
  if (name === 'notes') { autoPopulateFromTB(); renderSuggestions(); }
  if (name === 'checklist') runDisclosureChecklist();
  if (name === 'ratios') { buildFinancialRatios(); }

  updateEmptyStates();
  updateTabBadges();

  // Focus management: move focus to the new panel's first heading or focusable element
  const panel = el('page-' + name);
  if (panel) {
    const focusTarget = panel.querySelector('h1, h2, h3, .card-title, button, input, select, textarea, [tabindex="0"]') as HTMLElement | null;
    if (focusTarget) {
      if (!focusTarget.hasAttribute('tabindex') && !['INPUT', 'BUTTON', 'SELECT', 'TEXTAREA', 'A'].includes(focusTarget.tagName)) {
        focusTarget.setAttribute('tabindex', '-1');
      }
      focusTarget.focus();
    }
  }
}

// ─── Feature 3: Trial Balance Editor ────────────────────────────────────────

export function buildTrialBalanceEditor(): void {
  const container = el('tb-editor-content');
  const card = el('tb-editor-card');
  if (!container || !card) return;
  let hasData = false;
  SECTIONS.forEach(function(s: string) { if (state.currentData[s] && state.currentData[s].length > 0) hasData = true; });
  if (!hasData) {
    container.innerHTML = '<p style="font-size:0.85rem;color:var(--muted);margin-bottom:14px">No trial balance data imported yet. Import a CSV above to populate this editor.</p>';
    if (!card.classList.contains('collapsed')) card.classList.add('collapsed');
    return;
  }
  card.classList.remove('collapsed');
  let html = '<table class="tb-editor-table" role="grid" aria-label="Trial Balance Editor"><thead><tr><th>Section</th><th>Account Name</th><th>Amount</th><th style="width:80px">Actions</th></tr></thead><tbody>';
  let grandTotal = 0;
  SECTIONS.forEach(function(sec: string) {
    const items = state.currentData[sec];
    if (!items || items.length === 0) return;
    html += '<tr class="tb-section-header"><td colspan="4">' + esc(UI_SECTION_LABELS[sec] || sec) + '</td></tr>';
    let secTotal = 0;
    items.forEach(function(item: LineItem, idx: number) {
      const amt = parseFloat(String(item.amount)) || 0;
      secTotal += amt;
      html += '<tr class="tb-item" data-section="' + sec + '" data-idx="' + idx + '" tabindex="0" role="row">';
      html += '<td style="font-size:0.78rem;color:var(--muted)">' + esc(UI_SECTION_LABELS[sec] || sec) + '</td>';
      html += '<td><span class="tb-label-display">' + esc(item.label) + '</span></td>';
      html += '<td style="text-align:right"><span class="tb-amt-display">' + fmt(amt) + '</span></td>';
      html += '<td style="text-align:center">';
      html += '<button class="btn btn-ghost btn-sm" data-tb-action="edit" data-section="' + sec + '" data-idx="' + idx + '" title="Edit" aria-label="Edit ' + esc(item.label) + '" style="padding:3px 7px;font-size:0.75rem">&#9998;</button> ';
      html += '<button class="btn btn-danger btn-sm" data-tb-action="delete" data-section="' + sec + '" data-idx="' + idx + '" title="Delete" aria-label="Delete ' + esc(item.label) + '" style="padding:3px 7px;font-size:0.75rem">&times;</button>';
      html += '</td></tr>';
    });
    html += '<tr class="tb-total"><td></td><td style="text-align:right;font-size:0.82rem">Section Total:</td><td style="text-align:right">' + fmt(secTotal) + '</td><td></td></tr>';
    grandTotal += secTotal;
  });
  html += '<tr class="tb-add-row"><td><select id="tb-add-section"><option value="">Section...</option>';
  SECTIONS.forEach(function(s: string) { html += '<option value="' + s + '">' + esc(UI_SECTION_LABELS[s] || s) + '</option>'; });
  html += '</select></td><td><input type="text" id="tb-add-label" placeholder="Account name"></td>';
  html += '<td><input type="number" id="tb-add-amount" step="0.01" placeholder="0.00"></td>';
  html += '<td style="text-align:center"><button class="btn btn-primary btn-sm" data-tb-action="add" style="padding:4px 10px;font-size:0.78rem">Add</button></td></tr>';
  html += '<tr class="tb-grand-total"><td></td><td style="text-align:right">Grand Total:</td><td style="text-align:right">' + fmt(grandTotal) + '</td><td></td></tr>';
  html += '</tbody></table>';
  let totalItems = 0;
  SECTIONS.forEach(function(s: string) { totalItems += (state.currentData[s] ? state.currentData[s].length : 0); });
  html += '<div class="tb-summary"><span><strong>' + totalItems + '</strong> line items</span><span>Grand Total: <strong>' + fmt(grandTotal) + '</strong></span></div>';
  html += '<div style="margin-top:14px;display:flex;gap:8px;align-items:center">' +
    '<button class="btn btn-primary btn-sm" data-action="generateAll">Refresh Statements</button>' +
    '<button class="btn btn-ghost btn-sm" data-action="tbUndo" title="Undo (Ctrl+Z)" aria-label="Undo">&#8630; Undo</button>' +
    '<button class="btn btn-ghost btn-sm" data-action="tbRedo" title="Redo (Ctrl+Shift+Z)" aria-label="Redo">&#8631; Redo</button>' +
    '</div>';
  container.innerHTML = html;
}

export function tbEditRow(section: string, idx: number): void {
  const items = state.currentData[section];
  if (!items || !items[idx]) return;
  const item = items[idx];
  const rowEls = document.querySelectorAll('.tb-item[data-section="' + section + '"][data-idx="' + idx + '"]');
  if (rowEls.length === 0) return;
  const row = rowEls[0] as HTMLElement;
  const cells = row.children;
  cells[1].innerHTML = '<input type="text" value="' + esc(item.label) + '" id="tb-edit-label-' + section + '-' + idx + '" style="width:100%">';
  cells[2].innerHTML = '<input type="number" value="' + (item.amount || 0) + '" id="tb-edit-amt-' + section + '-' + idx + '" step="0.01" style="width:120px">';
  cells[3].innerHTML = '<button class="btn btn-primary btn-sm" data-tb-action="save" data-section="' + section + '" data-idx="' + idx + '" style="padding:3px 7px;font-size:0.72rem">Save</button> <button class="btn btn-ghost btn-sm" data-tb-action="cancel" style="padding:3px 7px;font-size:0.72rem">Cancel</button>';
}

export function tbSaveRow(section: string, idx: number): void {
  const labelEl = elInput('tb-edit-label-' + section + '-' + idx);
  const amtEl = elInput('tb-edit-amt-' + section + '-' + idx);
  if (!labelEl || !amtEl) return;
  const label = labelEl.value.trim();
  const amt = parseFloat(amtEl.value) || 0;
  if (!label) { alert('Account name cannot be empty.'); return; }
  pushTBUndo();
  state.currentData[section][idx] = { label: label, amount: amt };
  saveProject(); buildTrialBalanceEditor();
}

export function tbDeleteRow(section: string, idx: number): void {
  if (!confirm('Remove this line item?')) return;
  pushTBUndo();
  state.currentData[section].splice(idx, 1);
  saveProject(); buildTrialBalanceEditor();
}

export function tbAddRow(): void {
  const section = elInput('tb-add-section')?.value ?? '';
  const label = elInput('tb-add-label')?.value.trim() ?? '';
  const amt = parseFloat(elInput('tb-add-amount')?.value ?? '0') || 0;
  if (!section) { alert('Please select a section.'); return; }
  if (!label) { alert('Please enter an account name.'); return; }
  pushTBUndo();
  if (!state.currentData[section]) state.currentData[section] = [];
  state.currentData[section].push({ label: label, amount: amt });
  saveProject(); buildTrialBalanceEditor();
}

// ─── Feature 1: Prior Year Balances ─────────────────────────────────────────

const PY_FIELDS: PYField[] = [
  { id: 'py-current-assets', section: 'current-assets', label: 'Prior Year Current Assets' },
  { id: 'py-noncurrent-assets', section: 'noncurrent-assets', label: 'Prior Year Non-Current Assets' },
  { id: 'py-current-liab', section: 'current-liab', label: 'Prior Year Current Liabilities' },
  { id: 'py-noncurrent-liab', section: 'noncurrent-liab', label: 'Prior Year Non-Current Liabilities' },
  { id: 'py-equity', section: 'equity', label: 'Prior Year Equity' },
  { id: 'py-revenue', section: 'revenue', label: 'Prior Year Revenue' },
  { id: 'py-cogs', section: 'cogs', label: 'Prior Year COGS' },
  { id: 'py-opex', section: 'opex', label: 'Prior Year Operating Expenses' },
  { id: 'py-other', section: 'other', label: 'Prior Year Other Income/Expense' },
  { id: 'py-cf-operating', section: 'cf-operating', label: 'Prior Year Cash from Operations' },
  { id: 'py-cf-investing', section: 'cf-investing', label: 'Prior Year Cash from Investing' },
  { id: 'py-cf-financing', section: 'cf-financing', label: 'Prior Year Cash from Financing' },
];

function checkPriorDataExists(): void {
  let hasData = false;
  SECTIONS.forEach(function(s: string) { if (state.priorData[s] && state.priorData[s].length > 0) hasData = true; });
  const warn = document.getElementById('py-overwrite-warning');
  if (warn) warn.style.display = hasData ? 'block' : 'none';
}

export function savePriorYearBalances(): void {
  PY_FIELDS.forEach(function(f: PYField) {
    const fieldEl = elInput(f.id);
    const val = parseFloat(fieldEl ? fieldEl.value : '0') || 0;
    state.priorData[f.section] = val !== 0 ? [{ label: f.label, amount: val }] : [];
  });
  saveProject();
  const statusEl = document.getElementById('py-status');
  if (statusEl) {
    statusEl.innerHTML = '<div class="import-status success">Prior year balances saved successfully.</div>';
    setTimeout(function() { statusEl.innerHTML = ''; }, 3000);
  }
  checkPriorDataExists();
}

export function clearPriorYearBalances(): void {
  if (!confirm('Clear all prior year balance data?')) return;
  SECTIONS.forEach(function(s: string) { state.priorData[s] = []; });
  PY_FIELDS.forEach(function(f: PYField) { const fieldEl = elInput(f.id); if (fieldEl) fieldEl.value = ''; });
  saveProject();
  const statusEl = document.getElementById('py-status');
  if (statusEl) {
    statusEl.innerHTML = '<div class="import-status info">Prior year balances cleared.</div>';
    setTimeout(function() { statusEl.innerHTML = ''; }, 3000);
  }
  checkPriorDataExists();
}

export function loadPriorYearFields(): void {
  PY_FIELDS.forEach(function(f: PYField) {
    const fieldEl = elInput(f.id);
    if (!fieldEl) return;
    if (state.priorData[f.section] && state.priorData[f.section].length > 0) {
      let total = 0;
      state.priorData[f.section].forEach(function(item: LineItem) { total += parseFloat(String(item.amount)) || 0; });
      fieldEl.value = String(total || '');
    } else { fieldEl.value = ''; }
  });
  checkPriorDataExists();
}

// ─── Feature 2: Adjusting Journal Entries ───────────────────────────────────

function buildSectionOptionsHTML(): string {
  let html = '<option value="">Select section...</option>';
  AJE_SECTION_GROUPS.forEach(function(g: SectionGroup) {
    html += '<optgroup label="' + esc(g.label) + '">';
    g.options.forEach(function(o: SectionGroupOption) { html += '<option value="' + o.value + '">' + esc(o.text) + '</option>'; });
    html += '</optgroup>';
  });
  return html;
}

export function addAJEEntry(): void {
  state.ajeEntries.push({ description: '', date: '', lines: [{ account: '', section: '', debit: 0, credit: 0 }] } as AJEEntry);
  renderAJEEntries(); saveProject();
}

export function removeAJEEntry(entryIdx: number): void {
  if (!confirm('Remove AJE-' + (entryIdx + 1) + '?')) return;
  state.ajeEntries.splice(entryIdx, 1);
  renderAJEEntries(); saveProject();
}

export function addAJELine(entryIdx: number): void {
  state.ajeEntries[entryIdx].lines.push({ account: '', section: '', debit: 0, credit: 0 });
  renderAJEEntries(); saveProject();
}

export function removeAJELine(entryIdx: number, lineIdx: number): void {
  if (state.ajeEntries[entryIdx].lines.length <= 1) return;
  state.ajeEntries[entryIdx].lines.splice(lineIdx, 1);
  renderAJEEntries(); saveProject();
}

export function ajeFieldChange(entryIdx: number, field: string, value: string): void {
  (state.ajeEntries[entryIdx] as any)[field] = value; saveProject();
}

export function ajeLineChange(entryIdx: number, lineIdx: number, field: string, value: string): void {
  if (field === 'debit' || field === 'credit') (state.ajeEntries[entryIdx].lines[lineIdx] as any)[field] = parseFloat(value) || 0;
  else (state.ajeEntries[entryIdx].lines[lineIdx] as any)[field] = value;
  renderAJEEntries(); saveProject();
}

export function renderAJEEntries(): void {
  const container = el('aje-entries-container');
  if (!container) return;
  const secOpts = buildSectionOptionsHTML();
  let html = '', totalDebits = 0, totalCredits = 0;
  state.ajeEntries.forEach(function(entry: AJEEntry, eIdx: number) {
    let eD = 0, eC = 0;
    entry.lines.forEach(function(ln: AJELine) { eD += parseFloat(String(ln.debit)) || 0; eC += parseFloat(String(ln.credit)) || 0; });
    totalDebits += eD; totalCredits += eC;
    const balanced = Math.abs(eD - eC) < 0.005;
    const oob = (!balanced && (eD > 0 || eC > 0)) ? ' out-of-balance' : '';
    html += '<div class="aje-entry' + oob + '"><div class="aje-header">';
    html += '<span class="aje-num">AJE-' + (eIdx + 1) + '</span>';
    html += '<input type="date" value="' + (entry.date || '') + '" data-aje-change="field" data-entry="' + eIdx + '" data-field="date">';
    html += '<input type="text" value="' + esc(entry.description || '') + '" data-aje-change="field" data-entry="' + eIdx + '" data-field="description" placeholder="Memo / Description" style="flex:1;min-width:150px">';
    if (state.ajePosted) html += '<span class="aje-posted-badge posted">Posted</span>';
    html += '<button class="btn btn-danger btn-sm" data-aje-action="removeEntry" data-entry="' + eIdx + '" style="margin-left:auto">Remove</button></div>';
    html += '<table class="aje-lines-table"><thead><tr><th>Account</th><th>Section</th><th style="width:80px"></th><th>Debit</th><th>Credit</th></tr></thead><tbody>';
    entry.lines.forEach(function(ln: AJELine, lIdx: number) {
      html += '<tr><td><input type="text" value="' + esc(ln.account || '') + '" data-aje-change="line" data-entry="' + eIdx + '" data-line="' + lIdx + '" data-field="account" placeholder="Account name"></td>';
      html += '<td><select data-aje-change="line" data-entry="' + eIdx + '" data-line="' + lIdx + '" data-field="section">' + secOpts.replace('value="' + ln.section + '"', 'value="' + ln.section + '" selected') + '</select></td>';
      html += '<td style="text-align:center">';
      if (entry.lines.length > 1) html += '<button class="btn btn-ghost btn-sm" data-aje-action="removeLine" data-entry="' + eIdx + '" data-line="' + lIdx + '" style="padding:2px 6px;font-size:0.7rem">&times;</button>';
      html += '</td><td><input type="number" value="' + (ln.debit || '') + '" data-aje-change="line" data-entry="' + eIdx + '" data-line="' + lIdx + '" data-field="debit" step="0.01" placeholder="0.00"></td>';
      html += '<td><input type="number" value="' + (ln.credit || '') + '" data-aje-change="line" data-entry="' + eIdx + '" data-line="' + lIdx + '" data-field="credit" step="0.01" placeholder="0.00"></td></tr>';
    });
    html += '</tbody></table><div class="aje-footer"><button class="btn btn-ghost btn-sm" data-aje-action="addLine" data-entry="' + eIdx + '">Add Line</button>';
    html += '<div class="aje-totals" style="margin-left:auto"><span>Debits: <strong>' + fmt(eD) + '</strong></span><span>Credits: <strong>' + fmt(eC) + '</strong></span>';
    if (eD > 0 || eC > 0) html += balanced ? '<span class="balanced">Balanced</span>' : '<span class="unbalanced">Out of Balance (' + fmt(Math.abs(eD - eC)) + ')</span>';
    html += '</div></div></div>';
  });
  container.innerHTML = html;
  const summaryEl = el('aje-summary');
  if (summaryEl) {
    if (state.ajeEntries.length > 0) {
      summaryEl.style.display = 'block';
      const cSym = elInput('currency')?.value ?? '$';
      summaryEl.innerHTML = '<strong>' + state.ajeEntries.length + '</strong> entries, <strong>' + cSym + fmt(totalDebits) + '</strong> total debits' + (state.ajePosted ? ' &mdash; <span class="aje-posted-badge posted">Posted</span>' : '');
    } else { summaryEl.style.display = 'none'; }
  }
  const unpostBtn = el('aje-unpost-btn');
  if (unpostBtn) unpostBtn.style.display = state.ajePosted ? 'inline-block' : 'none';
}

export function postAllAJE(): void {
  if (state.ajeEntries.length === 0) { alert('No journal entries to post.'); return; }
  const errors: string[] = [];
  state.ajeEntries.forEach(function(entry: AJEEntry, eIdx: number) {
    let d = 0, c = 0;
    entry.lines.forEach(function(ln: AJELine) { d += parseFloat(String(ln.debit)) || 0; c += parseFloat(String(ln.credit)) || 0; });
    if (Math.abs(d - c) >= 0.005) errors.push('AJE-' + (eIdx + 1) + ' is out of balance');
    entry.lines.forEach(function(ln: AJELine, i: number) { if (!ln.section) errors.push('AJE-' + (eIdx + 1) + ', line ' + (i + 1) + ': missing section'); });
  });
  if (errors.length > 0) { alert('Cannot post:\n\n' + errors.join('\n')); return; }
  state.ajePrePostData = {} as SectionData;
  SECTIONS.forEach(function(s: string) { state.ajePrePostData![s] = JSON.parse(JSON.stringify(state.currentData[s])); });
  let posted = 0;
  state.ajeEntries.forEach(function(entry: AJEEntry, eIdx: number) {
    entry.lines.forEach(function(ln: AJELine) {
      const sec = ln.section;
      const rawNet = (parseFloat(String(ln.debit)) || 0) - (parseFloat(String(ln.credit)) || 0);
      if (rawNet === 0) return;
      const net = (SECTION_SIGN[sec] || 1) * rawNet;
      let found = false;
      for (let i = 0; i < state.currentData[sec].length; i++) {
        if (state.currentData[sec][i].label === ln.account) {
          state.currentData[sec][i].amount = (parseFloat(String(state.currentData[sec][i].amount)) || 0) + net;
          found = true;
          break;
        }
      }
      if (!found) state.currentData[sec].push({ label: ln.account || ('AJE-' + (eIdx + 1) + ' Adjustment'), amount: net });
    });
    posted++;
  });
  state.ajePosted = true; saveProject(); renderAJEEntries(); buildTrialBalanceEditor();
  const st = el('aje-status');
  if (st) {
    st.innerHTML = '<div class="import-status success">Successfully posted ' + posted + ' adjusting entries.</div>';
    setTimeout(function() { st.innerHTML = ''; }, 4000);
  }
}

export function unpostAJE(): void {
  if (!state.ajePosted) return;
  if (!confirm('Reverse all posted adjustments?')) return;
  if (state.ajePrePostData) SECTIONS.forEach(function(s: string) { if (state.ajePrePostData![s]) state.currentData[s] = JSON.parse(JSON.stringify(state.ajePrePostData![s])); });
  state.ajePosted = false; state.ajePrePostData = null;
  saveProject(); renderAJEEntries(); buildTrialBalanceEditor();
  const st = el('aje-status');
  if (st) {
    st.innerHTML = '<div class="import-status info">Adjustments reversed.</div>';
    setTimeout(function() { st.innerHTML = ''; }, 4000);
  }
}

// ─── Mobile menu ────────────────────────────────────────────────────────────

export function toggleMobileMenu(): void {
  const menu = document.getElementById('mobile-menu');
  if (menu) menu.classList.toggle('open');
}

document.addEventListener('click', function(e: MouseEvent) {
  const menu = document.getElementById('mobile-menu');
  if (menu && menu.classList.contains('open') && !(e.target as Element).closest('.header-actions')) {
    menu.classList.remove('open');
  }
});

// ─── #5 Dark mode toggle ────────────────────────────────────────────────────

export function toggleDarkMode(): void {
  document.body.classList.toggle('dark-mode');
  localStorage.setItem('noteflow-dark-mode', document.body.classList.contains('dark-mode') ? '1' : '0');
}

(function initDarkMode(): void {
  if (localStorage.getItem('noteflow-dark-mode') === '1') {
    document.body.classList.add('dark-mode');
  }
})();

// ─── #9 Accordion note groups ─────────────────────────────────────────────

(function initAccordion(): void {
  document.querySelectorAll('.note-group').forEach(function(group: Element) {
    const title = group.querySelector('.note-group-title');
    if (!title) return;
    const body = document.createElement('div');
    body.className = 'note-group-body';
    const children = Array.from(group.children).filter(function(c: Element) { return c !== title; });
    children.forEach(function(c: Element) { body.appendChild(c); });
    group.appendChild(body);
    (body as HTMLElement).style.maxHeight = body.scrollHeight + 200 + 'px';
    title.addEventListener('click', function() {
      group.classList.toggle('collapsed');
      if (group.classList.contains('collapsed')) {
        (body as HTMLElement).style.maxHeight = '0';
      } else {
        (body as HTMLElement).style.maxHeight = body.scrollHeight + 200 + 'px';
      }
    });
  });
})();

// ─── #10 Confirm before clearing data ─────────────────────────────────────

export function confirmClearAll(): void {
  if (confirm('Are you sure you want to clear all imported data? This cannot be undone.')) {
    clearAll();
  }
}

// ─── #11 Keyboard shortcuts ───────────────────────────────────────────────

document.addEventListener('keydown', function(e: KeyboardEvent) {
  const appWrapper = document.getElementById('app-wrapper');
  const appVisible = appWrapper && appWrapper.classList.contains('visible');
  if (!appVisible) return;
  const inInput = (e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'TEXTAREA' || (e.target as HTMLElement).tagName === 'SELECT';

  if ((e.ctrlKey || e.metaKey) && e.key === 'g') {
    e.preventDefault(); generateAll();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'e' && !inInput) {
    e.preventDefault(); exportToExcel();
  }
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'E') {
    e.preventDefault(); exportPackagePDF();
  }
  if (!inInput && !e.ctrlKey && !e.metaKey && !e.altKey) {
    const tabKeys: Record<string, string> = { '1': 'input', '2': 'balance', '3': 'income', '4': 'equity', '5': 'cashflow', '6': 'notes', '7': 'checklist', '8': 'ratios' };
    if (tabKeys[e.key]) { e.preventDefault(); switchTab(tabKeys[e.key]); }
  }

  // Arrow key navigation between tabs
  if ((e.target as HTMLElement).closest('[role="tab"]')) {
    const currentIdx = TAB_NAMES.indexOf(((e.target as HTMLElement).closest('[role="tab"]') as HTMLElement).dataset.param || '');
    if (currentIdx < 0) return;
    let newIdx = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      newIdx = (currentIdx + 1) % TAB_NAMES.length;
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      newIdx = (currentIdx - 1 + TAB_NAMES.length) % TAB_NAMES.length;
    } else if (e.key === 'Home') {
      e.preventDefault();
      newIdx = 0;
    } else if (e.key === 'End') {
      e.preventDefault();
      newIdx = TAB_NAMES.length - 1;
    }
    if (newIdx >= 0) {
      switchTab(TAB_NAMES[newIdx]);
      const newTab = document.getElementById('tab-' + TAB_NAMES[newIdx]);
      if (newTab) newTab.focus();
    }
  }

  // Keyboard navigation for TB editor rows
  if ((e.target as HTMLElement).closest('.tb-item')) {
    const row = (e.target as HTMLElement).closest('.tb-item') as HTMLElement;
    if (e.key === 'Enter') {
      e.preventDefault();
      const editBtn = row.querySelector('[data-tb-action="edit"]') as HTMLElement | null;
      if (editBtn) editBtn.click();
    } else if (e.key === 'Delete') {
      e.preventDefault();
      const deleteBtn = row.querySelector('[data-tb-action="delete"]') as HTMLElement | null;
      if (deleteBtn) deleteBtn.click();
    }
  }
});

// ─── #3 Tab completion badges ─────────────────────────────────────────────

export function updateTabBadges(): void {
  const hasData = SECTIONS.some(function(s: string) { return state.currentData[s] && state.currentData[s].length > 0; });
  setBadge('badge-input', hasData ? 'complete' : 'none');
  setBadge('badge-balance', el('balance-statement')?.innerHTML.trim() ? 'complete' : 'none');
  setBadge('badge-income', el('income-statement')?.innerHTML.trim() ? 'complete' : 'none');
  setBadge('badge-equity', el('equity-statement')?.innerHTML.trim() ? 'complete' : 'none');
  setBadge('badge-cashflow', el('cashflow-statement')?.innerHTML.trim() ? 'complete' : 'none');
  const notesEl = el('notes-statement');
  const notesGenerated = notesEl && notesEl.innerHTML.trim();
  const notesWrapper = el('notes-output-wrapper');
  const notesVisible = notesWrapper && notesWrapper.style.display !== 'none';
  if (notesVisible && notesGenerated) {
    setBadge('badge-notes', 'complete');
  } else {
    const hasAnyNotes = document.querySelector('.notes-form textarea') &&
      Array.from(document.querySelectorAll('.notes-form textarea, .notes-form select, .notes-form input[type="text"]'))
        .some(function(el: Element) { return (el as HTMLInputElement).value && (el as HTMLInputElement).value.trim(); });
    setBadge('badge-notes', hasAnyNotes ? 'partial' : 'none');
  }
  const checklistEl = document.getElementById('checklist-output');
  const hasChecklist = checklistEl && checklistEl.querySelector('.checklist-item');
  setBadge('badge-checklist', hasChecklist ? 'complete' : 'none');
}

function setBadge(id: string, badgeState: string): void {
  const badge = document.getElementById(id);
  if (!badge) return;
  badge.classList.remove('active', 'partial');
  if (badgeState === 'complete') { badge.classList.add('active'); }
  else if (badgeState === 'partial') { badge.classList.add('active', 'partial'); }
}

// ─── #14 Empty state management ───────────────────────────────────────────

export function updateEmptyStates(): void {
  const stmts = ['balance', 'income', 'equity', 'cashflow'];
  stmts.forEach(function(name: string) {
    const stmtEl = el(name + '-statement');
    const emptyEl = el('empty-' + name);
    if (!stmtEl || !emptyEl) return;
    const hasContent = stmtEl.innerHTML.trim().length > 0;
    emptyEl.style.display = hasContent ? 'none' : 'block';
    stmtEl.style.display = hasContent ? 'block' : 'none';
  });
  const hasAnyData = SECTIONS.some(function(s: string) { return rows(state.currentData, s).length > 0; });
  const ratiosEmpty = el('empty-ratios');
  const ratiosDash = el('ratios-dashboard');
  if (ratiosEmpty) ratiosEmpty.style.display = hasAnyData ? 'none' : 'block';
  if (ratiosDash) ratiosDash.style.display = hasAnyData ? 'block' : 'none';
}

document.addEventListener('DOMContentLoaded', function() {
  setTimeout(updateEmptyStates, 100);
});

// ─── Financial Ratios & Analytics ─────────────────────────────────────────

export function buildFinancialRatios(): void {
  const multi = hasPriorData();

  function safeDiv(num: number, den: number): number | null {
    if (den === 0 || den === null || den === undefined) return null;
    return num / den;
  }
  function safePct(num: number, den: number): number | null {
    const r = safeDiv(num, den);
    return r === null ? null : r * 100;
  }

  function fmtRatio(val: number | null | undefined, suffix?: string): string {
    if (val === null || val === undefined || !isFinite(val)) return 'N/A';
    suffix = suffix || '';
    if (suffix === '%') return val.toFixed(1) + '%';
    if (suffix === '$') return cur() + fmt(val);
    return val.toFixed(2);
  }

  function ratioItem(name: string, curVal: number | null, priorVal: number | null | undefined, suffix: string, favorableUp: boolean): string {
    const curDisplay = fmtRatio(curVal, suffix);
    let html = '<div class="ratio-item"><div class="ratio-name">' + esc(name) + '</div>';
    html += '<div class="ratio-value">' + curDisplay + '</div>';
    if (multi && priorVal !== null && priorVal !== undefined && isFinite(priorVal)) {
      const priorDisplay = fmtRatio(priorVal, suffix);
      html += '<div class="ratio-prior">Prior: ' + priorDisplay + '</div>';
      if (curVal !== null && isFinite(curVal)) {
        const diff = curVal - priorVal;
        if (Math.abs(diff) > 0.001) {
          const isUp = diff > 0;
          const isFavorable = favorableUp ? isUp : !isUp;
          const arrow = isUp ? '\u2191' : '\u2193';
          const cls = isFavorable ? 'favorable' : 'unfavorable';
          html += '<div class="ratio-change ' + cls + '">' + arrow + ' ' + Math.abs(diff).toFixed(2) + (suffix === '%' ? '%' : '') + '</div>';
        }
      }
    }
    html += '</div>';
    return html;
  }

  // ── Balance Sheet Ratios ──
  const bsGrid = document.getElementById('balance-ratios-grid');
  const bsCard = document.getElementById('balance-ratios-card');
  let totalCA = 0, totalCL = 0, totalNCA = 0, totalNCL = 0, totalAssets = 0, totalLiab = 0, totalEquity = 0;
  let pCA = 0, pCL = 0, pNCA = 0, pNCL = 0, pAssets = 0, pLiab = 0, pEquity = 0;
  let inventoryAmt = 0, pInventoryAmt = 0;

  if (bsGrid && bsCard) {
    totalCA = sum(state.currentData, 'current-assets');
    totalCL = sum(state.currentData, 'current-liab');
    totalNCA = sum(state.currentData, 'noncurrent-assets');
    totalNCL = sum(state.currentData, 'noncurrent-liab');
    totalAssets = totalCA + totalNCA;
    totalLiab = totalCL + totalNCL;
    totalEquity = sum(state.currentData, 'equity');

    if (multi) {
      pCA = sum(state.priorData, 'current-assets');
      pCL = sum(state.priorData, 'current-liab');
      pNCA = sum(state.priorData, 'noncurrent-assets');
      pNCL = sum(state.priorData, 'noncurrent-liab');
      pAssets = pCA + pNCA;
      pLiab = pCL + pNCL;
      pEquity = sum(state.priorData, 'equity');
    }

    rows(state.currentData, 'current-assets').forEach(function(r: LineItem) {
      if (/inventor/i.test(r.label)) inventoryAmt += parseFloat(String(r.amount)) || 0;
    });
    if (multi) {
      rows(state.priorData, 'current-assets').forEach(function(r: LineItem) {
        if (/inventor/i.test(r.label)) pInventoryAmt += parseFloat(String(r.amount)) || 0;
      });
    }

    let bsHtml = '';
    bsHtml += ratioItem('Current Ratio', safeDiv(totalCA, totalCL), multi ? safeDiv(pCA, pCL) : null, '', true);
    bsHtml += ratioItem('Quick Ratio', safeDiv(totalCA - inventoryAmt, totalCL), multi ? safeDiv(pCA - pInventoryAmt, pCL) : null, '', true);
    bsHtml += ratioItem('Debt-to-Equity', safeDiv(totalLiab, totalEquity), multi ? safeDiv(pLiab, pEquity) : null, '', false);
    bsHtml += ratioItem('Working Capital', totalCA - totalCL, multi ? (pCA - pCL) : null, '$', true);
    bsHtml += ratioItem('Debt Ratio', safeDiv(totalLiab, totalAssets), multi ? safeDiv(pLiab, pAssets) : null, '', false);
    bsHtml += ratioItem('Equity Ratio', safeDiv(totalEquity, totalAssets), multi ? safeDiv(pEquity, pAssets) : null, '', true);
    bsGrid.innerHTML = bsHtml;

    bsCard.style.display = (totalAssets !== 0 || totalLiab !== 0) ? 'block' : 'none';
  }

  // ── Income Statement Ratios ──
  const isGrid = document.getElementById('income-ratios-grid');
  const isCard = document.getElementById('income-ratios-card');
  let revenue = 0, cogs = 0, grossProfit = 0, opex = 0, opIncome = 0, other = 0, netIncome = 0;
  let pRevenue = 0, pCogs = 0, pGP = 0, pOpex2 = 0, pOpInc = 0, pOther2 = 0, pNI = 0;

  if (isGrid && isCard) {
    revenue = sum(state.currentData, 'revenue');
    cogs = sum(state.currentData, 'cogs');
    grossProfit = revenue - cogs;
    opex = sum(state.currentData, 'opex');
    opIncome = grossProfit - opex;
    other = sum(state.currentData, 'other');
    netIncome = opIncome + other;

    if (multi) {
      pRevenue = sum(state.priorData, 'revenue');
      pCogs = sum(state.priorData, 'cogs');
      pGP = pRevenue - pCogs;
      pOpex2 = sum(state.priorData, 'opex');
      pOpInc = pGP - pOpex2;
      pOther2 = sum(state.priorData, 'other');
      pNI = pOpInc + pOther2;
    }

    let isHtml = '';
    isHtml += ratioItem('Gross Profit Margin', safePct(grossProfit, revenue), multi ? safePct(pGP, pRevenue) : null, '%', true);
    isHtml += ratioItem('Operating Margin', safePct(opIncome, revenue), multi ? safePct(pOpInc, pRevenue) : null, '%', true);
    isHtml += ratioItem('Net Profit Margin', safePct(netIncome, revenue), multi ? safePct(pNI, pRevenue) : null, '%', true);
    isHtml += ratioItem('Operating Expense Ratio', safePct(opex, revenue), multi ? safePct(pOpex2, pRevenue) : null, '%', false);
    isHtml += ratioItem('COGS Ratio', safePct(cogs, revenue), multi ? safePct(pCogs, pRevenue) : null, '%', false);
    isGrid.innerHTML = isHtml;

    isCard.style.display = (revenue !== 0) ? 'block' : 'none';
  }

  // ── Full Ratios Dashboard Page ──
  const dashboard = document.getElementById('ratios-dashboard');
  const emptyRatios = document.getElementById('empty-ratios');
  const hasAnyData = (totalCA || totalCL || totalNCA || totalNCL || revenue);
  if (dashboard && emptyRatios) {
    if (!hasAnyData) {
      dashboard.style.display = 'none';
      emptyRatios.style.display = 'block';
      return;
    }
    dashboard.style.display = 'block';
    emptyRatios.style.display = 'none';

    const rCompany = document.getElementById('ratios-company-name');
    const rPeriod = document.getElementById('ratios-period');
    if (rCompany) rCompany.textContent = (elInput('companyName')?.value || 'Company') + ' — Financial Ratios & Analytics';
    if (rPeriod) rPeriod.textContent = elInput('period')?.value || '';

    const scorecards = document.getElementById('ratios-scorecards');
    if (scorecards) {
      let scHtml = '';
      function scorecard(label: string, value: string): string {
        return '<div class="ratios-scorecard"><div class="ratios-scorecard-label">' + label + '</div><div class="ratios-scorecard-value">' + value + '</div></div>';
      }
      scHtml += scorecard('Current Ratio', safeDiv(totalCA, totalCL) !== null ? safeDiv(totalCA, totalCL)!.toFixed(2) : 'N/A');
      scHtml += scorecard('Net Margin', revenue ? (safePct(netIncome, revenue))!.toFixed(1) + '%' : 'N/A');
      scHtml += scorecard('Debt-to-Equity', totalEquity ? safeDiv(totalLiab, totalEquity)!.toFixed(2) : 'N/A');
      scHtml += scorecard('Working Capital', cur() + fmt(totalCA - totalCL));
      scorecards.innerHTML = scHtml;
    }

    const liqDiv = document.getElementById('ratios-liquidity');
    if (liqDiv) {
      let liqHtml = '';
      liqHtml += ratioItem('Current Ratio', safeDiv(totalCA, totalCL), multi ? safeDiv(pCA, pCL) : null, '', true);
      liqHtml += ratioItem('Quick Ratio', safeDiv(totalCA - inventoryAmt, totalCL), multi ? safeDiv(pCA - pInventoryAmt, pCL) : null, '', true);
      liqHtml += ratioItem('Working Capital', totalCA - totalCL, multi ? (pCA - pCL) : null, '$', true);
      liqDiv.innerHTML = liqHtml;
    }

    const profDiv = document.getElementById('ratios-profitability');
    if (profDiv) {
      let profHtml = '';
      profHtml += ratioItem('Gross Profit Margin', safePct(grossProfit, revenue), multi ? safePct(pGP, pRevenue) : null, '%', true);
      profHtml += ratioItem('Operating Margin', safePct(opIncome, revenue), multi ? safePct(pOpInc, pRevenue) : null, '%', true);
      profHtml += ratioItem('Net Profit Margin', safePct(netIncome, revenue), multi ? safePct(pNI, pRevenue) : null, '%', true);
      profHtml += ratioItem('Return on Assets', safePct(netIncome, totalAssets), multi ? safePct(pNI, pAssets) : null, '%', true);
      profHtml += ratioItem('Return on Equity', safePct(netIncome, totalEquity), multi ? safePct(pNI, pEquity) : null, '%', true);
      profDiv.innerHTML = profHtml;
    }

    const levDiv = document.getElementById('ratios-leverage');
    if (levDiv) {
      let levHtml = '';
      levHtml += ratioItem('Debt-to-Equity', safeDiv(totalLiab, totalEquity), multi ? safeDiv(pLiab, pEquity) : null, '', false);
      levHtml += ratioItem('Debt Ratio', safeDiv(totalLiab, totalAssets), multi ? safeDiv(pLiab, pAssets) : null, '', false);
      levHtml += ratioItem('Equity Ratio', safeDiv(totalEquity, totalAssets), multi ? safeDiv(pEquity, pAssets) : null, '', true);
      levDiv.innerHTML = levHtml;
    }

    const effDiv = document.getElementById('ratios-efficiency');
    if (effDiv) {
      let effHtml = '';
      let arAmt = 0, pArAmt = 0;
      rows(state.currentData, 'current-assets').forEach(function(r: LineItem) { if (/receiv/i.test(r.label)) arAmt += parseFloat(String(r.amount)) || 0; });
      if (multi) rows(state.priorData, 'current-assets').forEach(function(r: LineItem) { if (/receiv/i.test(r.label)) pArAmt += parseFloat(String(r.amount)) || 0; });
      let apAmt = 0, pApAmt = 0;
      rows(state.currentData, 'current-liab').forEach(function(r: LineItem) { if (/payable/i.test(r.label)) apAmt += parseFloat(String(r.amount)) || 0; });
      if (multi) rows(state.priorData, 'current-liab').forEach(function(r: LineItem) { if (/payable/i.test(r.label)) pApAmt += parseFloat(String(r.amount)) || 0; });
      effHtml += ratioItem('Asset Turnover', safeDiv(revenue, totalAssets), multi ? safeDiv(pRevenue, pAssets) : null, '', true);
      effHtml += ratioItem('AR Turnover', safeDiv(revenue, arAmt), multi ? safeDiv(pRevenue, pArAmt) : null, '', true);
      effHtml += ratioItem('Days Sales Outstanding', arAmt && revenue ? (arAmt / revenue * 365) : null, multi && pArAmt && pRevenue ? (pArAmt / pRevenue * 365) : null, '', false);
      effHtml += ratioItem('AP Turnover', safeDiv(cogs, apAmt), multi ? safeDiv(pCogs, pApAmt) : null, '', false);
      effDiv.innerHTML = effHtml;
    }

    const insightsCard = document.getElementById('ratios-insights-card');
    const insightsDiv = document.getElementById('ratios-insights');
    if (insightsCard && insightsDiv) {
      const insights: string[] = [];
      const cr = safeDiv(totalCA, totalCL);
      if (cr !== null && cr < 1) insights.push('<div style="padding:6px 0;color:var(--red)">\u26A0 Current ratio below 1.0 \u2014 potential liquidity risk.</div>');
      if (cr !== null && cr > 3) insights.push('<div style="padding:6px 0;color:var(--muted)">Current ratio above 3.0 \u2014 excess liquidity may indicate underutilized assets.</div>');
      const de = safeDiv(totalLiab, totalEquity);
      if (de !== null && de > 2) insights.push('<div style="padding:6px 0;color:var(--red)">\u26A0 Debt-to-equity above 2.0 \u2014 high leverage.</div>');
      const npm = safePct(netIncome, revenue);
      if (npm !== null && npm < 0) insights.push('<div style="padding:6px 0;color:var(--red)">\u26A0 Negative net profit margin \u2014 company is operating at a loss.</div>');
      if (npm !== null && npm > 20) insights.push('<div style="padding:6px 0;color:var(--green)">Strong net profit margin above 20%.</div>');
      if (multi) {
        const prevCR = safeDiv(pCA, pCL);
        if (cr !== null && prevCR !== null && cr < prevCR) insights.push('<div style="padding:6px 0;color:#f59e0b">Current ratio declining from prior period.</div>');
      }
      if (insights.length > 0) {
        (insightsCard as HTMLElement).style.display = 'block';
        insightsDiv.innerHTML = insights.join('');
      } else {
        (insightsCard as HTMLElement).style.display = 'none';
      }
    }
  }
}

// ─── Export Ratios PDF ──────────────────────────────────────────────────────

export function exportRatiosPDF(): void {
  if (typeof (window as any).jspdf === 'undefined' && typeof (window as any).jsPDF === 'undefined') {
    alert('PDF library not loaded yet. Please try again.');
    return;
  }
  const jsPDF = ((window as any).jspdf || {}).jsPDF || (window as any).jsPDF;
  const doc = new jsPDF();
  const company = elInput('companyName')?.value || 'Company';
  const period = elInput('period')?.value || '';
  doc.setFontSize(16);
  doc.text(company + ' - Financial Ratios', 14, 20);
  doc.setFontSize(10);
  if (period) doc.text(period, 14, 28);
  let yPos = 36;
  const sections = [
    { title: 'Liquidity Ratios', gridId: 'ratios-liquidity' },
    { title: 'Profitability Ratios', gridId: 'ratios-profitability' },
    { title: 'Leverage & Solvency Ratios', gridId: 'ratios-leverage' },
    { title: 'Efficiency & Activity Ratios', gridId: 'ratios-efficiency' },
    { title: 'Balance Sheet Ratios', gridId: 'balance-ratios-grid' },
    { title: 'Income Statement Ratios', gridId: 'income-ratios-grid' },
  ];
  sections.forEach(function(sec: { title: string; gridId: string }) {
    const grid = document.getElementById(sec.gridId);
    if (!grid || !grid.innerHTML.trim()) return;
    doc.setFontSize(12);
    doc.setFont(undefined, 'bold');
    doc.text(sec.title, 14, yPos);
    yPos += 8;
    doc.setFontSize(10);
    doc.setFont(undefined, 'normal');
    grid.querySelectorAll('.ratio-item').forEach(function(item: Element) {
      const nameEl = item.querySelector('.ratio-name');
      const valueEl = item.querySelector('.ratio-value');
      if (nameEl && valueEl) {
        doc.text(nameEl.textContent + ': ' + valueEl.textContent, 18, yPos);
        yPos += 6;
        if (yPos > 270) { doc.addPage(); yPos = 20; }
      }
    });
    yPos += 6;
  });
  doc.save(company.replace(/[^a-zA-Z0-9]/g, '_') + '_Ratios.pdf');
}

// ---------------------------------------------------------------------------
// Event Delegation — Trial Balance Editor
// ---------------------------------------------------------------------------

document.addEventListener('click', function (e: MouseEvent) {
  const target = (e.target as HTMLElement).closest('[data-tb-action]') as HTMLElement | null;
  if (!target) return;

  const action = target.dataset.tbAction;
  const section = target.dataset.section;
  const idx = target.dataset.idx !== undefined ? parseInt(target.dataset.idx, 10) : -1;

  switch (action) {
    case 'edit':
      if (section && idx >= 0) tbEditRow(section, idx);
      break;
    case 'delete':
      if (section && idx >= 0) tbDeleteRow(section, idx);
      break;
    case 'save':
      if (section && idx >= 0) tbSaveRow(section, idx);
      break;
    case 'cancel':
      buildTrialBalanceEditor();
      break;
    case 'add':
      tbAddRow();
      break;
  }
});

// ---------------------------------------------------------------------------
// Event Delegation — AJE click actions
// ---------------------------------------------------------------------------

document.addEventListener('click', function (e: MouseEvent) {
  const target = (e.target as HTMLElement).closest('[data-aje-action]') as HTMLElement | null;
  if (!target) return;

  const action = target.dataset.ajeAction;
  const entryIdx = target.dataset.entry !== undefined ? parseInt(target.dataset.entry, 10) : -1;

  switch (action) {
    case 'removeEntry':
      if (entryIdx >= 0) removeAJEEntry(entryIdx);
      break;
    case 'removeLine': {
      const lineIdx = target.dataset.line !== undefined ? parseInt(target.dataset.line, 10) : -1;
      if (entryIdx >= 0 && lineIdx >= 0) removeAJELine(entryIdx, lineIdx);
      break;
    }
    case 'addLine':
      if (entryIdx >= 0) addAJELine(entryIdx);
      break;
  }
});

// ---------------------------------------------------------------------------
// Event Delegation — AJE change handlers
// ---------------------------------------------------------------------------

document.addEventListener('change', function (e: Event) {
  const target = e.target as HTMLElement;
  if (!target.dataset || !target.hasAttribute('data-aje-change')) return;

  const changeType = target.getAttribute('data-aje-change');
  const entryIdx = parseInt(target.getAttribute('data-entry') || '-1', 10);
  const field = target.getAttribute('data-field') || '';
  const value = (target as HTMLInputElement | HTMLSelectElement).value;

  if (changeType === 'field' && entryIdx >= 0 && field) {
    ajeFieldChange(entryIdx, field, value);
  } else if (changeType === 'line' && entryIdx >= 0 && field) {
    const lineIdx = parseInt(target.getAttribute('data-line') || '-1', 10);
    if (lineIdx >= 0) ajeLineChange(entryIdx, lineIdx, field, value);
  }
});

