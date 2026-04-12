/* ═══════════════════════════════════════════════════════════════════════
   NoteFlow — import.ts
   Trial balance import, CSV/Excel parsing, account mapping
   ═══════════════════════════════════════════════════════════════════════ */

import {
  state,
  SECTIONS,
  SECTION_SIGN,
  VALID_SECTIONS,
  type SectionData,
} from './state';
import { esc, fmt, el } from './utils';
import { saveProject } from './data';
import { buildTrialBalanceEditor, loadPriorYearFields } from './ui';
import { saveCurrentToSelectedEntity } from './consolidation';

declare const XLSX: any;

// ─── Types ─────────────────────────────────────────────────────────────────

interface TBRow {
  accountNumber: string;
  accountName: string;
  debit: number;
  credit: number;
  section?: string;
  priorDebit?: number;
  priorCredit?: number;
}

interface TBResult extends Array<TBRow> {
  _hasComparative?: boolean;
}

interface SectionGroupOption {
  value: string;
  text: string;
}

interface SectionGroup {
  label: string;
  options: SectionGroupOption[];
}

const SECTION_GROUPS: SectionGroup[] = [
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

// ─── Wizard column mapping fields ─────────────────────────────────────────

interface WizardField {
  key: string;
  label: string;
  required: boolean;
  autoCandidates: string[];
}

const WIZARD_FIELDS: WizardField[] = [
  { key: 'accountNumber', label: 'Account Number', required: false, autoCandidates: ['accountnumber','acctno','account','acct','code','id','accountno','number'] },
  { key: 'accountName',   label: 'Account Name',   required: true,  autoCandidates: ['accountname','name','description','desc','accountdescription'] },
  { key: 'debit',         label: 'Current Debit',   required: false, autoCandidates: ['debit','dr','debitamount'] },
  { key: 'credit',        label: 'Current Credit',  required: false, autoCandidates: ['credit','cr','creditamount'] },
  { key: 'balance',       label: 'Current Balance',   required: false, autoCandidates: ['balance','amount','currentbalance','endingbalance','currentamount','net'] },
  { key: 'priorDebit',    label: 'Prior Year Debit',  required: false, autoCandidates: ['priordebit','priordr','prioryeardebit','pydebit','beginningdebit'] },
  { key: 'priorCredit',   label: 'Prior Year Credit', required: false, autoCandidates: ['priorcredit','priorcr','prioryearcredit','pycredit','beginningcredit'] },
  { key: 'priorBalance',  label: 'Prior Year Balance',  required: false, autoCandidates: ['priorbalance','prioramount','prioryearbalance','beginningbalance','pybalance','pyamount'] },
  { key: 'section',       label: 'Section',         required: false, autoCandidates: ['section','category','classification','type','class'] },
];

// ─── Module-level state ────────────────────────────────────────────────────
let pendingComparativeUnmapped: TBRow[] = [];
let wizardRawRows: string[][] = [];
let wizardHeaders: string[] = [];

// ─── Import System ─────────────────────────────────────────────────────────

export function zoneDrag(e: DragEvent, zoneId: string): void {
  e.preventDefault();
  el(zoneId)?.classList.add('drag-over');
}

export function zoneDragEnd(zoneId: string): void {
  el(zoneId)?.classList.remove('drag-over');
}

export function zoneDrop(e: DragEvent, zoneId: string, key: string): void {
  e.preventDefault();
  zoneDragEnd(zoneId);
  const file = e.dataTransfer?.files[0];
  if (file) setImportFile(zoneId, key, file);
}

export function fileChosen(input: HTMLInputElement, zoneId: string, key: string): void {
  if (input.files?.[0]) setImportFile(zoneId, key, input.files[0]);
}

function setImportFile(zoneId: string, key: string, file: File): void {
  (state.importFiles as Record<string, File | null>)[key] = file;
  const zone = el(zoneId);
  if (zone) zone.classList.add('has-file');
  const nameEl = el(zoneId + '-name');
  const hintEl = el(zoneId + '-hint');
  if (nameEl) nameEl.textContent = file.name;
  if (hintEl) hintEl.textContent = '';

  // Trigger wizard — read the file and show column mapping
  showWizard(file);
}

async function showWizard(file: File): Promise<void> {
  try {
    const text = await readFileText(file);
    wizardRawRows = parseCSV(text);
    if (wizardRawRows.length < 2) { showStatus('error', 'File appears to be empty.'); return; }
    wizardHeaders = wizardRawRows[0];

    const stepUpload = el('import-step-upload');
    const stepMap = el('import-step-map');
    if (stepUpload) stepUpload.style.display = 'none';
    if (stepMap) stepMap.style.display = 'block';

    renderWizardMappings();
    renderWizardPreview();

    // Clear any previous import status
    const importStatus = el('import-status');
    if (importStatus) importStatus.innerHTML = '';
  } catch (err: any) {
    showStatus('error', 'Could not read file: ' + err.message);
  }
}

export function importWizardBack(): void {
  const stepUpload = el('import-step-upload');
  const stepMap = el('import-step-map');
  if (stepUpload) stepUpload.style.display = 'block';
  if (stepMap) stepMap.style.display = 'none';
  wizardRawRows = [];
  wizardHeaders = [];

  // Reset the file input so they can pick a new file
  const zone = el('zone-combined');
  if (zone) zone.classList.remove('has-file');
  const nameEl = el('zone-combined-name');
  const hintEl = el('zone-combined-hint');
  if (nameEl) nameEl.textContent = '';
  if (hintEl) hintEl.textContent = 'Drop file here or click to browse';
  (state.importFiles as Record<string, File | null>)['combined'] = null;
  const fileInput = zone?.querySelector('input[type="file"]') as HTMLInputElement | null;
  if (fileInput) fileInput.value = '';
}

function renderWizardMappings(): void {
  const container = el('wizard-mappings');
  if (!container) return;
  const normalizedHeaders = wizardHeaders.map(normalizeHeader);

  let html = '';
  for (const field of WIZARD_FIELDS) {
    // Auto-detect best match
    let bestIdx = -1;
    for (const candidate of field.autoCandidates) {
      const idx = normalizedHeaders.indexOf(candidate);
      if (idx !== -1) { bestIdx = idx; break; }
    }

    const optionalTag = field.required ? '' : ' <span class="wiz-optional">(optional)</span>';
    html += '<div class="wiz-field">';
    html += '<label>' + esc(field.label) + optionalTag + '</label>';
    html += '<select id="wiz-' + field.key + '" data-wiz-change="true"' + (bestIdx >= 0 ? ' class="mapped"' : '') + '>';
    html += '<option value="">-- Skip --</option>';
    for (let i = 0; i < wizardHeaders.length; i++) {
      const sel = i === bestIdx ? ' selected' : '';
      html += '<option value="' + i + '"' + sel + '>' + esc(wizardHeaders[i]) + '</option>';
    }
    html += '</select>';
    html += '</div>';
  }
  container.innerHTML = html;
}

function renderWizardPreview(): void {
  const container = el('wizard-preview');
  if (!container) return;

  // Show up to 8 data rows
  const previewCount = Math.min(wizardRawRows.length - 1, 8);
  let html = '<table><thead><tr>';
  for (const h of wizardHeaders) {
    html += '<th>' + esc(h) + '</th>';
  }
  html += '</tr></thead><tbody>';
  for (let i = 1; i <= previewCount; i++) {
    html += '<tr>';
    for (let j = 0; j < wizardHeaders.length; j++) {
      const val = wizardRawRows[i]?.[j] || '';
      html += '<td>' + esc(val) + '</td>';
    }
    html += '</tr>';
  }
  if (wizardRawRows.length - 1 > previewCount) {
    html += '<tr><td colspan="' + wizardHeaders.length + '" style="color:var(--muted);font-style:italic">... and ' + (wizardRawRows.length - 1 - previewCount) + ' more rows</td></tr>';
  }
  html += '</tbody></table>';
  container.innerHTML = html;
}

function getWizardMapping(): Record<string, number> {
  const mapping: Record<string, number> = {};
  for (const field of WIZARD_FIELDS) {
    const sel = document.getElementById('wiz-' + field.key) as HTMLSelectElement | null;
    if (sel && sel.value !== '') {
      mapping[field.key] = parseInt(sel.value, 10);
    }
  }
  return mapping;
}

function wizardRowsToTB(rawRows: string[][], mapping: Record<string, number>): TBResult {
  const hasDebitCredit = mapping.debit !== undefined && mapping.credit !== undefined;
  const hasBalance = mapping.balance !== undefined;
  const hasPriorDC = mapping.priorDebit !== undefined && mapping.priorCredit !== undefined;
  const hasPriorBal = mapping.priorBalance !== undefined;

  if (!hasDebitCredit && !hasBalance) {
    throw new Error('Please map either Debit & Credit columns or a Balance column for the current year.');
  }
  if (mapping.accountName === undefined) {
    throw new Error('Please map the Account Name column.');
  }

  const result: TBResult = [] as unknown as TBResult;
  for (let i = 1; i < rawRows.length; i++) {
    const r = rawRows[i];
    if (!r || r.every(c => !c)) continue;

    const acctNum = mapping.accountNumber !== undefined ? (r[mapping.accountNumber] || '').trim() : String(i);
    const name = (r[mapping.accountName] || '').trim();
    if (!name && !acctNum) continue;

    let debit = 0;
    let credit = 0;
    if (hasDebitCredit) {
      debit = parseAmount(r[mapping.debit] || '0');
      credit = parseAmount(r[mapping.credit] || '0');
    } else if (hasBalance) {
      const bal = parseAmount(r[mapping.balance] || '0');
      if (bal >= 0) { debit = bal; credit = 0; }
      else { debit = 0; credit = Math.abs(bal); }
    }

    const sect = mapping.section !== undefined ? (r[mapping.section] || '').trim().toLowerCase().replace(/\s+/g, '-') : undefined;
    const row: TBRow = { accountNumber: acctNum, accountName: name || acctNum, debit, credit, section: sect };

    if (hasPriorDC) {
      row.priorDebit = parseAmount(r[mapping.priorDebit] || '0');
      row.priorCredit = parseAmount(r[mapping.priorCredit] || '0');
    } else if (hasPriorBal) {
      const pBal = parseAmount(r[mapping.priorBalance] || '0');
      if (pBal >= 0) { row.priorDebit = pBal; row.priorCredit = 0; }
      else { row.priorDebit = 0; row.priorCredit = Math.abs(pBal); }
    }

    result.push(row);
  }

  result._hasComparative = hasPriorDC || hasPriorBal;
  return result;
}

// ── CSV parser ─────────────────────────────────────────────────────────────

export function parseCSV(text: string): string[][] {
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  const firstLine = text.split('\n')[0];
  const delim = firstLine.includes('\t') ? '\t' : firstLine.includes(';') ? ';' : ',';

  const rowsArr: string[][] = [];
  let curStr = '';
  let inQ = false;
  let fields: string[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (inQ && text[i + 1] === '"') { curStr += '"'; i++; }
      else inQ = !inQ;
    } else if (ch === delim && !inQ) {
      fields.push(curStr.trim()); curStr = '';
    } else if (ch === '\n' && !inQ) {
      fields.push(curStr.trim()); rowsArr.push(fields); fields = []; curStr = '';
    } else {
      curStr += ch;
    }
  }
  if (curStr.trim() || fields.length) { fields.push(curStr.trim()); rowsArr.push(fields); }
  return rowsArr;
}

export function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = (e: ProgressEvent<FileReader>) => resolve(e.target!.result as string);
    r.onerror = reject;
    r.readAsText(file);
  });
}

export function findCol(headers: string[], candidates: string[]): number {
  for (const c of candidates) {
    const idx = headers.indexOf(c);
    if (idx !== -1) return idx;
  }
  return -1;
}

export function parseAmount(s: string | number): number {
  let str = String(s).replace(/[$\u00a3\u20ac,\s]/g, '');
  const neg = str.startsWith('(') && str.endsWith(')');
  str = str.replace(/[()]/g, '');
  const n = parseFloat(str) || 0;
  return neg ? -n : n;
}

export function parseTB(rowsArr: string[][], mode: string): TBResult {
  if (rowsArr.length < 1) throw new Error('Trial balance is empty.');
  const headers = rowsArr[0].map(normalizeHeader);
  const acctIdx  = findCol(headers, ['accountnumber','acctno','account','acct','code','id']);
  const nameIdx  = findCol(headers, ['accountname','name','description','desc']);
  const debitIdx = findCol(headers, ['debit','dr','debitamount']);
  const creditIdx= findCol(headers, ['credit','cr','creditamount']);
  const sectIdx  = mode === 'combined'
    ? findCol(headers, ['section','category','classification'])
    : -1;

  // Comparative columns (Prior Debit / Prior Credit)
  const priorDebitIdx = findCol(headers, ['priordebit','priordr','prioryeardebit','pydebit','beginningdebit']);
  const priorCreditIdx = findCol(headers, ['priorcredit','priorcr','prioryearcredit','pycredit','beginningcredit']);
  const hasComparative = priorDebitIdx !== -1 && priorCreditIdx !== -1;

  if (acctIdx  === -1) throw new Error('Trial balance missing "Account Number" column.');
  if (debitIdx === -1) throw new Error('Trial balance missing "Debit" column.');
  if (creditIdx=== -1) throw new Error('Trial balance missing "Credit" column.');

  const result: TBResult = [] as unknown as TBResult;
  for (let i = 1; i < rowsArr.length; i++) {
    const r = rowsArr[i];
    if (!r || r.every(c => !c)) continue;
    const acct   = (r[acctIdx]  || '').trim();
    const name   = nameIdx !== -1 ? (r[nameIdx] || '').trim() : acct;
    const debit  = parseAmount(r[debitIdx]  || '0');
    const credit = parseAmount(r[creditIdx] || '0');
    const sect   = sectIdx !== -1 ? (r[sectIdx] || '').trim().toLowerCase().replace(/\s+/g, '-') : undefined;
    const row: TBRow = { accountNumber: acct, accountName: name || acct, debit, credit, section: sect };
    if (hasComparative) {
      row.priorDebit = parseAmount(r[priorDebitIdx] || '0');
      row.priorCredit = parseAmount(r[priorCreditIdx] || '0');
    }
    if (acct) result.push(row);
  }
  result._hasComparative = hasComparative;
  return result;
}

// ─── Import Workflow ───────────────────────────────────────────────────────

export async function runImport(): Promise<void> {
  try {
    if (wizardRawRows.length < 2) {
      showStatus('error', 'Please select a file to import.');
      return;
    }

    const mapping = getWizardMapping();
    const tbRows = wizardRowsToTB(wizardRawRows, mapping);

    // ── TB Balance Validation ──
    let totalDebits = 0, totalCredits = 0;
    let pTotalDebits = 0, pTotalCredits = 0;
    const hasPrior = tbRows._hasComparative;
    for (const row of tbRows) {
      totalDebits += row.debit;
      totalCredits += row.credit;
      if (hasPrior && row.priorDebit !== undefined && row.priorCredit !== undefined) {
        pTotalDebits += row.priorDebit;
        pTotalCredits += row.priorCredit;
      }
    }
    const curDiff = Math.abs(totalDebits - totalCredits);
    const priorDiff = hasPrior ? Math.abs(pTotalDebits - pTotalCredits) : 0;
    if (curDiff > 0.01 || priorDiff > 0.01) {
      let warnMsg = '<div class="import-status warning" style="margin-bottom:12px"><strong>&#9888; Trial Balance Warning:</strong> ';
      if (curDiff > 0.01) {
        warnMsg += 'Current period debits (' + fmt(totalDebits) + ') ≠ credits (' + fmt(totalCredits) + '), difference of ' + fmt(curDiff) + '. ';
      }
      if (priorDiff > 0.01) {
        warnMsg += 'Prior period debits (' + fmt(pTotalDebits) + ') ≠ credits (' + fmt(pTotalCredits) + '), difference of ' + fmt(priorDiff) + '. ';
      }
      warnMsg += 'Your balance sheet may not balance. Check your trial balance for errors.</div>';
      const statusEl = el('import-status');
      if (statusEl) statusEl.innerHTML = warnMsg;
    }

    if (tbRows._hasComparative) {
      // File has prior year columns — import both periods
      SECTIONS.forEach(s => { state.currentData[s] = []; state.priorData[s] = []; });
      applyComparativeImport(tbRows, null);
    } else {
      // Current period only
      SECTIONS.forEach(s => { state.currentData[s] = []; });
      applyImport(tbRows, null, state.currentData);
    }

    // If in consolidation mode, sync imported data back to the selected entity
    if (state.consolidationMode) {
      saveCurrentToSelectedEntity();
    }
  } catch (err: any) {
    showStatus('error', err.message);
  }
}

function applyImport(
  tbRows: TBResult,
  accountMap: Map<string, string> | null,
  targetData: SectionData
): void {
  const unmapped: TBRow[] = [];
  let imported = 0;

  for (const row of tbRows) {
    const section = row.section !== undefined
      ? row.section
      : (accountMap ? accountMap.get(row.accountNumber) : undefined);
    if (!section || !VALID_SECTIONS.has(section)) {
      unmapped.push({ ...row, section: section || '' });
      continue;
    }
    const sign   = SECTION_SIGN[section];
    const amount = sign * (row.debit - row.credit);
    targetData[section].push({ label: row.accountName, amount: parseFloat(amount.toFixed(2)) });
    imported++;
  }

  saveProject();
  buildTrialBalanceEditor();
  loadPriorYearFields();
  state.pendingUnmapped = unmapped;
  state.pendingTargetData = targetData;

  let html = '';

  if (imported > 0) {
    html += '<div class="import-status success" style="margin-bottom:' + (unmapped.length ? '12px' : '0') + '">';
    html += '<strong>' + imported + ' account' + (imported !== 1 ? 's' : '') + ' imported successfully.</strong>';
    html += '</div>';
  }

  if (unmapped.length) {
    html += '<div class="import-status info">';
    html += '<strong>' + unmapped.length + ' account' + (unmapped.length !== 1 ? 's' : '') + ' need' + (unmapped.length === 1 ? 's' : '') + ' a section assignment.</strong>';
    html += ' Use the dropdowns to assign each account to the correct financial statement section.';
    html += '<div class="unmapped-list"><table>';
    html += '<tr><th>Account #</th><th>Name</th><th>Debit</th><th>Credit</th><th style="min-width:180px">Assign Section</th></tr>';
    for (let i = 0; i < unmapped.length; i++) {
      const u = unmapped[i];
      html += '<tr>' +
        '<td>' + esc(u.accountNumber) + '</td>' +
        '<td>' + esc(u.accountName) + '</td>' +
        '<td>' + fmt(u.debit) + '</td>' +
        '<td>' + fmt(u.credit) + '</td>' +
        '<td>' + buildSectionSelect('map-' + i, '') + '</td>' +
      '</tr>';
    }
    html += '</table></div>';
    html += '<div class="map-actions">' +
      '<button class="btn btn-primary btn-sm" data-action="applyMappings">Map & Import</button>' +
      '<span class="map-count" id="map-count">0 of ' + unmapped.length + ' assigned</span>' +
    '</div>';
    html += '</div>';
  }

  if (!imported && !unmapped.length) {
    html = '<div class="import-status error">No accounts found in file.</div>';
  }

  const importStatus = el('import-status');
  if (importStatus) importStatus.innerHTML = html;
}

// ─── Comparative Import (both periods from one file) ───────────────────────

function applyComparativeImport(
  tbRows: TBResult,
  accountMap: Map<string, string> | null
): void {
  const unmapped: TBRow[] = [];
  let importedCur = 0;
  let importedPrior = 0;

  for (const row of tbRows) {
    const section = row.section !== undefined
      ? row.section
      : (accountMap ? accountMap.get(row.accountNumber) : undefined);
    if (!section || !VALID_SECTIONS.has(section)) {
      unmapped.push({ ...row, section: section || '' });
      continue;
    }
    const sign = SECTION_SIGN[section];

    // Current period
    const curAmount = sign * (row.debit - row.credit);
    if (Math.abs(curAmount) > 0.005 || (row.debit === 0 && row.credit === 0)) {
      state.currentData[section].push({ label: row.accountName, amount: parseFloat(curAmount.toFixed(2)) });
      importedCur++;
    }

    // Prior period
    if (row.priorDebit !== undefined && row.priorCredit !== undefined) {
      const priorAmount = sign * (row.priorDebit - row.priorCredit);
      if (Math.abs(priorAmount) > 0.005 || (row.priorDebit === 0 && row.priorCredit === 0)) {
        state.priorData[section].push({ label: row.accountName, amount: parseFloat(priorAmount.toFixed(2)) });
        importedPrior++;
      }
    }
  }

  saveProject();
  pendingComparativeUnmapped = unmapped;

  let html = '';

  if (importedCur > 0 || importedPrior > 0) {
    html += '<div class="import-status success" style="margin-bottom:' + (unmapped.length ? '12px' : '0') + '">';
    html += '<strong>Comparative import: ' + importedCur + ' current + ' + importedPrior + ' prior period accounts imported.</strong>';
    html += '</div>';
  }

  if (unmapped.length) {
    html += '<div class="import-status info">';
    html += '<strong>' + unmapped.length + ' account' + (unmapped.length !== 1 ? 's' : '') + ' need' + (unmapped.length === 1 ? 's' : '') + ' a section assignment.</strong>';
    html += ' Use the dropdowns to assign each account to the correct financial statement section.';
    html += '<div class="unmapped-list"><table>';
    html += '<tr><th>Account #</th><th>Name</th><th>Debit</th><th>Credit</th><th>Prior Dr</th><th>Prior Cr</th><th style="min-width:180px">Assign Section</th></tr>';
    for (let i = 0; i < unmapped.length; i++) {
      const u = unmapped[i];
      html += '<tr>' +
        '<td>' + esc(u.accountNumber) + '</td>' +
        '<td>' + esc(u.accountName) + '</td>' +
        '<td>' + fmt(u.debit) + '</td>' +
        '<td>' + fmt(u.credit) + '</td>' +
        '<td>' + fmt(u.priorDebit || 0) + '</td>' +
        '<td>' + fmt(u.priorCredit || 0) + '</td>' +
        '<td>' + buildSectionSelect('map-' + i, '') + '</td>' +
      '</tr>';
    }
    html += '</table></div>';
    html += '<div class="map-actions">' +
      '<button class="btn btn-primary btn-sm" data-action="applyComparativeMappings">Map & Import</button>' +
      '<span class="map-count" id="map-count">0 of ' + unmapped.length + ' assigned</span>' +
    '</div>';
    html += '</div>';
  }

  if (!importedCur && !importedPrior && !unmapped.length) {
    html = '<div class="import-status error">No accounts found in file.</div>';
  }

  const importStatus = el('import-status');
  if (importStatus) importStatus.innerHTML = html;
}

export function applyComparativeMappings(): void {
  let added = 0;
  for (let i = 0; i < pendingComparativeUnmapped.length; i++) {
    const sel = document.getElementById('map-' + i) as HTMLSelectElement | null;
    const section = sel ? sel.value : '';
    if (!section || !VALID_SECTIONS.has(section)) continue;
    const row = pendingComparativeUnmapped[i];
    const sign = SECTION_SIGN[section];

    // Current
    const curAmount = sign * (row.debit - row.credit);
    state.currentData[section].push({ label: row.accountName, amount: parseFloat(curAmount.toFixed(2)) });

    // Prior
    if (row.priorDebit !== undefined && row.priorCredit !== undefined) {
      const priorAmount = sign * (row.priorDebit - row.priorCredit);
      state.priorData[section].push({ label: row.accountName, amount: parseFloat(priorAmount.toFixed(2)) });
    }
    added++;
  }
  if (added === 0) { showStatus('error', 'No sections assigned. Use the dropdowns to map accounts first.'); return; }
  pendingComparativeUnmapped = [];
  saveProject();
  buildTrialBalanceEditor();
  loadPriorYearFields();
  const total = SECTIONS.reduce((n: number, s: string) => n + state.currentData[s].length + state.priorData[s].length, 0);
  showStatus('success', '<strong>' + added + ' account' + (added !== 1 ? 's' : '') + ' mapped (both periods).</strong> ' + total + ' total accounts loaded.', true);
}

function buildSectionSelect(id: string, preselect: string): string {
  let html = '<select id="' + id + '" data-mapping-change="true">';
  html += '<option value="">-- Select section --</option>';
  for (const group of SECTION_GROUPS) {
    html += '<optgroup label="' + group.label + '">';
    for (const opt of group.options) {
      const sel = opt.value === preselect ? ' selected' : '';
      html += '<option value="' + opt.value + '"' + sel + '>' + opt.text + '</option>';
    }
    html += '</optgroup>';
  }
  html += '</select>';
  return html;
}

export function onMappingChange(sel: HTMLSelectElement): void {
  sel.classList.toggle('mapped', sel.value !== '');
  updateMapCount();
}

function updateMapCount(): void {
  const countEl = el('map-count');
  if (!countEl) return;
  const total = state.pendingUnmapped.length;
  const mapped = state.pendingUnmapped.filter((_: any, i: number) => {
    const s = document.getElementById('map-' + i) as HTMLSelectElement | null;
    return s && s.value;
  }).length;
  countEl.textContent = mapped + ' of ' + total + ' assigned';
}

export function applyMappings(): void {
  const targetData: SectionData = state.pendingTargetData || state.currentData;
  let added = 0;
  for (let i = 0; i < state.pendingUnmapped.length; i++) {
    const sel = document.getElementById('map-' + i) as HTMLSelectElement | null;
    const section = sel ? sel.value : '';
    if (!section || !VALID_SECTIONS.has(section)) continue;
    const row = state.pendingUnmapped[i];
    const sign = SECTION_SIGN[section];
    const amount = sign * (row.debit - row.credit);
    targetData[section].push({ label: row.accountName, amount: parseFloat(amount.toFixed(2)) });
    added++;
  }
  if (added === 0) { showStatus('error', 'No sections assigned. Use the dropdowns to map accounts first.'); return; }
  state.pendingUnmapped = [];
  state.pendingTargetData = null;
  saveProject();
  buildTrialBalanceEditor();
  const total = SECTIONS.reduce((n: number, s: string) => n + state.currentData[s].length + state.priorData[s].length, 0);
  showStatus('success', '<strong>' + added + ' account' + (added !== 1 ? 's' : '') + ' mapped and imported.</strong> ' + total + ' total accounts loaded.', true);
}

function showStatus(type: string, msg: string, trusted?: boolean): void {
  const importStatus = el('import-status');
  if (importStatus) importStatus.innerHTML =
    '<div class="import-status ' + type + '">' + (trusted ? msg : esc(msg)) + '</div>';
}

// ─── Template Download ─────────────────────────────────────────────────────

export function downloadTemplate(): void {
  const csv: string = 'Account Number,Account Name,Debit,Credit,Prior Debit,Prior Credit,Section\n' +
    '1000,Cash,124000,0,98000,0,current-assets\n' +
    '1100,Accounts Receivable,88000,0,72000,0,current-assets\n' +
    '1200,Inventory,210000,0,195000,0,current-assets\n' +
    '1500,Equipment,350000,0,320000,0,noncurrent-assets\n' +
    '1510,Accumulated Depreciation,0,85000,0,60000,noncurrent-assets\n' +
    '2000,Accounts Payable,0,64000,0,52000,current-liab\n' +
    '2500,Long-Term Debt,0,245000,0,280000,noncurrent-liab\n' +
    '3000,Common Stock,0,100000,0,100000,equity\n' +
    '3100,Retained Earnings,0,120000,0,75000,equity\n' +
    '4000,Product Sales,0,850000,0,720000,revenue\n' +
    '5000,Cost of Goods Sold,310000,0,265000,0,cogs\n' +
    '6000,Salaries & Wages,148000,0,132000,0,opex\n' +
    '6100,Depreciation Expense,25000,0,20000,0,opex\n' +
    '6200,Rent Expense,36000,0,36000,0,opex\n' +
    '7100,Interest Expense,14200,0,16500,0,other\n';
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(blob), download: 'import_template.csv'
  });
  a.click(); URL.revokeObjectURL(a.href);
}

// ---------------------------------------------------------------------------
// Event Delegation — mapping select change handlers
// ---------------------------------------------------------------------------

document.addEventListener('change', function (e: Event) {
  const target = e.target as HTMLElement;
  if (target.hasAttribute('data-mapping-change')) {
    onMappingChange(target as HTMLSelectElement);
  }
  if (target.hasAttribute('data-wiz-change')) {
    (target as HTMLSelectElement).classList.toggle('mapped', (target as HTMLSelectElement).value !== '');
  }
});
