/* ═══════════════════════════════════════════════════════════════════════
   NoteFlow — notes.ts
   Notes to financial statements, disclosure generation, checklist
   ═══════════════════════════════════════════════════════════════════════ */

import { state, type AJEEntry, type AJELine } from './state';
import { meta, esc, rows, sum, computeNetIncome, el, hasPriorData, fmt, cur, extractYear } from './utils';
import { buildComparativeSection } from './statements';
import { saveNotesToProject } from './data';

// Track whether auto-populate has already run this session to avoid overwriting user edits
let autoPopulateRan = false;

// ─── Types ─────────────────────────────────────────────────────────────────

interface DataContext {
  ppeTable: string;
  debtTable: string;
  equityTable: string;
}

interface CheckItem {
  id: string;
  detected: boolean;
  required: boolean;
  disclosed: boolean;
}

interface Detection {
  id: string;
  label: string;
  detected: boolean;
  required: boolean;
  reason: string;
  disclosed: boolean;
  asc: string;
  guidance: string;
  url: string;
}

// ─── Notes Generator ────────────────────────────────────────────────────────

function nqVal(id: string): string {
  const fieldEl = el(id) as HTMLInputElement | null;
  return (fieldEl ? fieldEl.value : '').trim();
}

function nqRadio(name: string): string {
  const el = document.querySelector('input[name="' + name + '"]:checked') as HTMLInputElement | null;
  return el ? el.value : 'no';
}

// ─── TB Auto-Populate ─────────────────────────────────────────────────────
// Scans trial balance data and pre-fills questionnaire fields that are empty.

function hasItemPattern(section: string, pattern: RegExp): boolean {
  return rows(state.currentData, section).some(r => pattern.test(r.label));
}

function setIfEmpty(id: string, value: string): void {
  const field = el(id) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
  if (field && !field.value.trim()) field.value = value;
}

function setRadioIfDefault(name: string, value: string): void {
  const current = document.querySelector('input[name="' + name + '"]:checked') as HTMLInputElement | null;
  // Only set if currently on 'no' (default)
  if (!current || current.value === 'no') {
    const target = document.querySelector('input[name="' + name + '"][value="' + value + '"]') as HTMLInputElement | null;
    if (target) {
      target.checked = true;
      target.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }
}

/**
 * Scans trial balance data to auto-populate empty questionnaire fields.
 * Only fills fields that are currently blank — never overwrites user input.
 */
export function autoPopulateFromTB(): void {
  if (autoPopulateRan) return; // Only auto-fill once per session

  // Only mark as ran if there's actual TB data to scan
  const hasAnyData = rows(state.currentData, 'current-assets').length > 0 ||
    rows(state.currentData, 'noncurrent-assets').length > 0 ||
    rows(state.currentData, 'revenue').length > 0;
  if (!hasAnyData) return; // No data yet — try again next time

  autoPopulateRan = true;

  const c = cur();

  // ── Inventory detection ──
  const invItems = rows(state.currentData, 'current-assets').filter(r => /inventor/i.test(r.label));
  if (invItems.length > 0) {
    // Auto-detect inventory method based on common patterns
    setIfEmpty('nq-inventory', 'FIFO');
  }

  // ── Depreciation detection ──
  const hasDepreciation = hasItemPattern('noncurrent-assets', /accumulated\s*depreciation|accum.*dep/i);
  if (hasDepreciation) {
    setIfEmpty('nq-depreciation', 'straight-line');
    // Build useful lives suggestion from asset types
    const assetTypes: string[] = [];
    rows(state.currentData, 'noncurrent-assets').forEach(r => {
      if (/building/i.test(r.label)) assetTypes.push('Buildings: 39 years');
      else if (/machinery|equipment/i.test(r.label) && !/computer/i.test(r.label)) assetTypes.push('Machinery & Equipment: 5-10 years');
      else if (/vehicle/i.test(r.label)) assetTypes.push('Vehicles: 5 years');
      else if (/furniture|fixture/i.test(r.label)) assetTypes.push('Furniture & Fixtures: 7 years');
      else if (/computer/i.test(r.label)) assetTypes.push('Computer Equipment: 3-5 years');
      else if (/leasehold/i.test(r.label)) assetTypes.push('Leasehold Improvements: lesser of useful life or lease term');
    });
    const unique = [...new Set(assetTypes)];
    if (unique.length > 0) setIfEmpty('nq-useful-lives', unique.join('; '));
  }

  // ── Intangible assets detection ──
  const hasIntangibles = hasItemPattern('noncurrent-assets', /goodwill|patent|trademark|copyright|customer\s*(list|relationship)|franchise|software|intangible/i);
  if (hasIntangibles) {
    setRadioIfDefault('nq-intangibles', 'yes');
    const intTypes: string[] = [];
    rows(state.currentData, 'noncurrent-assets').forEach(r => {
      if (/goodwill/i.test(r.label)) intTypes.push('Goodwill is tested for impairment annually, or more frequently if triggering events occur, in accordance with ASC 350.');
      if (/patent/i.test(r.label)) intTypes.push('Patents are amortized on a straight-line basis over their estimated useful lives.');
      if (/trademark/i.test(r.label)) intTypes.push('Trademarks with indefinite useful lives are not amortized but are tested for impairment annually.');
      if (/customer/i.test(r.label)) intTypes.push('Customer relationships are amortized on a straight-line basis over their estimated useful lives.');
    });
    const uniqueInt = [...new Set(intTypes)];
    if (uniqueInt.length > 0) setIfEmpty('nq-intangibles-text', uniqueInt.join(' '));
  }

  // ── Allowance for doubtful accounts detection ──
  const hasAllowance = hasItemPattern('current-assets', /allowance|doubtful|bad\s*debt/i);
  if (hasAllowance) {
    setRadioIfDefault('nq-allowance', 'yes');
    setIfEmpty('nq-allowance-text', 'The Company maintains an allowance for doubtful accounts based on management\'s assessment of the collectability of specific customer accounts and the aging of accounts receivable. Accounts receivable are written off when deemed uncollectible.');
  }

  // ── Debt detection ──
  const hasDebt = hasItemPattern('current-liab', /loan|note.?payable|mortgage|line.?of.?credit|debt|borrowing/i) ||
                  hasItemPattern('noncurrent-liab', /loan|note.?payable|mortgage|line.?of.?credit|debt|borrowing/i);
  if (hasDebt) {
    setRadioIfDefault('nq-debt', 'yes');
    // Build debt summary from account labels and amounts
    const debtLines: string[] = [];
    const allDebt = [
      ...rows(state.currentData, 'current-liab').filter(r => /loan|note.?payable|mortgage|line.?of.?credit|debt|borrowing|bond/i.test(r.label)),
      ...rows(state.currentData, 'noncurrent-liab').filter(r => /loan|note.?payable|mortgage|line.?of.?credit|debt|borrowing|bond/i.test(r.label)),
    ];
    allDebt.forEach(r => {
      const amt = Math.abs(parseFloat(String(r.amount)) || 0);
      debtLines.push(r.label + ': ' + c + fmt(amt));
    });
    if (debtLines.length > 0) {
      setIfEmpty('nq-debt-text', 'The Company has the following outstanding debt obligations: ' + debtLines.join('; ') + '.');
    }
  }

  // ── Lease detection ──
  const hasLeases = hasItemPattern('current-liab', /lease/i) ||
                    hasItemPattern('noncurrent-liab', /lease/i) ||
                    hasItemPattern('noncurrent-assets', /right.?of.?use|rou|lease/i);
  if (hasLeases) {
    setRadioIfDefault('nq-leases', 'yes');
    setIfEmpty('nq-leases-text', 'The Company has operating lease agreements for office space and equipment. Right-of-use assets and lease liabilities are recognized at the commencement date based on the present value of remaining lease payments, discounted using the Company\'s incremental borrowing rate.');
  }

  // ── Equity auto-populate ──
  const eqItems = rows(state.currentData, 'equity');
  if (eqItems.length > 0) {
    const eqLines: string[] = [];
    eqItems.forEach(r => {
      if (/common\s*stock/i.test(r.label)) {
        eqLines.push(r.label + '.');
      } else if (/treasury/i.test(r.label)) {
        const amt = Math.abs(parseFloat(String(r.amount)) || 0);
        eqLines.push('Treasury stock of ' + c + fmt(amt) + ' represents shares repurchased by the Company.');
      }
    });
    if (eqLines.length > 0) setIfEmpty('nq-equity-text', eqLines.join(' '));
  }

  // ── FDIC detection (cash > 250k) ──
  const cashItems = rows(state.currentData, 'current-assets').filter(r => /cash|bank|checking|savings|money\s*market/i.test(r.label));
  const totalCash = cashItems.reduce((t, r) => t + Math.abs(parseFloat(String(r.amount)) || 0), 0);
  if (totalCash > 250000) {
    setRadioIfDefault('nq-fdic', 'yes');
  }

  // ── Income tax status guess ──
  if (hasItemPattern('other', /income\s*tax\s*expense/i)) {
    setIfEmpty('nq-tax-status', 'c-corp');
  }

  // ── Entity type inference ──
  const eqItemsForEntity = rows(state.currentData, 'equity');
  const hasCommonStock = eqItemsForEntity.some(r => /common\s*stock|preferred\s*stock|share/i.test(r.label));
  const hasMembersEquity = eqItemsForEntity.some(r => /member|partner|capital\s*account/i.test(r.label));
  const entityField = document.getElementById('nq-entity-type') as HTMLSelectElement | null;
  if (entityField && !entityField.value) {
    if (hasCommonStock) entityField.value = 'Corporation';
    else if (hasMembersEquity) entityField.value = 'LLC';
  }

  // ── Advertising policy ──
  if (hasItemPattern('opex', /advertising|marketing/i)) {
    const adField = document.getElementById('nq-advertising') as HTMLSelectElement | null;
    if (adField && !adField.value) adField.value = 'expensed';
  }

  // ── Revenue recognition auto-fill ──
  const revItems = rows(state.currentData, 'revenue');
  if (revItems.length > 0) {
    const revTypes = revItems.map(r => r.label).join(', ');
    setIfEmpty('nq-revenue-recognition', 'The Company recognizes revenue from ' + revTypes + ' when control of goods or services is transferred to the customer, in an amount that reflects the consideration expected in exchange, in accordance with ASC 606.');
  }

  // ── Subsequent events date pre-fill ──
  const m = meta();
  if (m.reportDate) {
    setIfEmpty('nq-subseq-date', m.reportDate);
  }

  console.log('[NoteFlow] Auto-populated notes questionnaire from trial balance data');
}

// ─── Rich Schedule Builders ────────────────────────────────────────────────

function buildPPESchedule(): string {
  const multi = hasPriorData();
  const c = cur();
  const m = meta();
  const curYear = (m.period ? extractYear(m.period) : null) || 'Current';
  const priorYear = (m.priorPeriod ? extractYear(m.priorPeriod) : null) || 'Prior';

  // Gather gross assets and their accumulated depreciation
  const grossAssets = rows(state.currentData, 'noncurrent-assets').filter(r =>
    /property|equipment|furniture|vehicle|building|land|leasehold|computer|machinery/i.test(r.label) &&
    !/accumulated|depreciation|amortization/i.test(r.label)
  );
  const accumDep = rows(state.currentData, 'noncurrent-assets').filter(r =>
    /accumulated.*depreciation|accum.*dep/i.test(r.label)
  );

  if (grossAssets.length === 0) return '';

  let html = '<table class="note-table"><thead><tr><th></th><th>' + esc(curYear) + '</th>';
  if (multi) html += '<th>' + esc(priorYear) + '</th>';
  html += '</tr></thead><tbody>';

  let totalGross = 0, pTotalGross = 0;
  grossAssets.forEach(r => {
    const amt = parseFloat(String(r.amount)) || 0;
    totalGross += amt;
    let pAmt = 0;
    if (multi) {
      const match = rows(state.priorData, 'noncurrent-assets').find(p => p.label === r.label);
      if (match) pAmt = parseFloat(String(match.amount)) || 0;
      pTotalGross += pAmt;
    }
    html += '<tr><td>' + esc(r.label) + '</td><td>' + c + fmt(amt) + '</td>';
    if (multi) html += '<td>' + c + fmt(pAmt) + '</td>';
    html += '</tr>';
  });

  html += '<tr class="nt-subtotal"><td>Total cost</td><td>' + c + fmt(totalGross) + '</td>';
  if (multi) html += '<td>' + c + fmt(pTotalGross) + '</td>';
  html += '</tr>';

  let totalAccum = 0, pTotalAccum = 0;
  accumDep.forEach(r => {
    const amt = parseFloat(String(r.amount)) || 0;
    totalAccum += amt;
    let pAmt = 0;
    if (multi) {
      const match = rows(state.priorData, 'noncurrent-assets').find(p => p.label === r.label);
      if (match) pAmt = parseFloat(String(match.amount)) || 0;
      pTotalAccum += pAmt;
    }
    html += '<tr><td>' + esc(r.label) + '</td><td>' + c + fmt(amt) + '</td>';
    if (multi) html += '<td>' + c + fmt(pAmt) + '</td>';
    html += '</tr>';
  });

  if (accumDep.length > 1) {
    html += '<tr class="nt-subtotal"><td>Total accumulated depreciation</td><td>' + c + fmt(totalAccum) + '</td>';
    if (multi) html += '<td>' + c + fmt(pTotalAccum) + '</td>';
    html += '</tr>';
  }

  const net = totalGross + totalAccum; // accumDep is negative
  const pNet = pTotalGross + pTotalAccum;
  html += '<tr class="nt-total"><td>Property and equipment, net</td><td>' + c + fmt(net) + '</td>';
  if (multi) html += '<td>' + c + fmt(pNet) + '</td>';
  html += '</tr>';

  html += '</tbody></table>';
  return html;
}

function buildInventorySchedule(): string {
  const multi = hasPriorData();
  const c = cur();
  const m = meta();
  const curYear = (m.period ? extractYear(m.period) : null) || 'Current';
  const priorYear = (m.priorPeriod ? extractYear(m.priorPeriod) : null) || 'Prior';

  const invItems = rows(state.currentData, 'current-assets').filter(r => /inventor/i.test(r.label));
  if (invItems.length < 2) return ''; // Only show schedule if multiple inventory types

  let html = '<table class="note-table"><thead><tr><th></th><th>' + esc(curYear) + '</th>';
  if (multi) html += '<th>' + esc(priorYear) + '</th>';
  html += '</tr></thead><tbody>';

  let total = 0, pTotal = 0;
  invItems.forEach(r => {
    const amt = parseFloat(String(r.amount)) || 0;
    total += amt;
    let pAmt = 0;
    if (multi) {
      const match = rows(state.priorData, 'current-assets').find(p => p.label === r.label);
      if (match) pAmt = parseFloat(String(match.amount)) || 0;
      pTotal += pAmt;
    }
    html += '<tr><td>' + esc(r.label) + '</td><td>' + c + fmt(amt) + '</td>';
    if (multi) html += '<td>' + c + fmt(pAmt) + '</td>';
    html += '</tr>';
  });

  html += '<tr class="nt-total"><td>Total inventory</td><td>' + c + fmt(total) + '</td>';
  if (multi) html += '<td>' + c + fmt(pTotal) + '</td>';
  html += '</tr></tbody></table>';
  return html;
}

function buildDebtSchedule(): string {
  const multi = hasPriorData();
  const c = cur();
  const m = meta();
  const curYear = (m.period ? extractYear(m.period) : null) || 'Current';
  const priorYear = (m.priorPeriod ? extractYear(m.priorPeriod) : null) || 'Prior';
  const debtPattern = /loan|note.?payable|mortgage|line.?of.?credit|debt|borrowing|bond/i;

  const curDebt = rows(state.currentData, 'current-liab').filter(r => debtPattern.test(r.label));
  const ltDebt = rows(state.currentData, 'noncurrent-liab').filter(r => debtPattern.test(r.label));
  if (curDebt.length === 0 && ltDebt.length === 0) return '';

  let html = '<table class="note-table"><thead><tr><th></th><th>' + esc(curYear) + '</th>';
  if (multi) html += '<th>' + esc(priorYear) + '</th>';
  html += '</tr></thead><tbody>';

  let total = 0, pTotal = 0;

  function addRows(items: any[], section: string): void {
    items.forEach((r: any) => {
      const amt = Math.abs(parseFloat(String(r.amount)) || 0);
      total += amt;
      let pAmt = 0;
      if (multi) {
        const match = rows(state.priorData, section).find((p: any) => p.label === r.label);
        if (match) pAmt = Math.abs(parseFloat(String(match.amount)) || 0);
        pTotal += pAmt;
      }
      html += '<tr><td>' + esc(r.label) + '</td><td>' + c + fmt(amt) + '</td>';
      if (multi) html += '<td>' + c + fmt(pAmt) + '</td>';
      html += '</tr>';
    });
  }

  if (ltDebt.length > 0) addRows(ltDebt, 'noncurrent-liab');
  if (curDebt.length > 0) {
    html += '<tr><td colspan="' + (multi ? 3 : 2) + '" style="font-weight:600;padding-top:8px">Less: current portion</td></tr>';
    addRows(curDebt, 'current-liab');
  }

  html += '<tr class="nt-total"><td>Total debt obligations</td><td>' + c + fmt(total) + '</td>';
  if (multi) html += '<td>' + c + fmt(pTotal) + '</td>';
  html += '</tr></tbody></table>';
  return html;
}

// ─── Default note section order ────────────────────────────────────────────
export const DEFAULT_NOTE_ORDER: string[] = [
  'operations',
  'accounting',
  'taxes',
  'debt',
  'leases',
  'equity',
  'related',
  'concentrations',
  'commitments',
  'aje',
  'subsequent',
  'going-concern',
  'revenue-detail',
  'opex-detail',
  'depreciation-schedule',
];

// ─── Note Section Builder ──────────────────────────────────────────────────
// Each builder returns the inner HTML for its section, or null if skipped.

interface NoteSectionResult {
  id: string;
  title: string;
  html: string;
}

type NoteSectionBuilder = (company: string, period: string, priorPeriod: string) => NoteSectionResult | null;

function buildNoteOperations(company: string, _period: string): NoteSectionResult | null {
  const bizDesc: string = nqVal('nq-business-desc');
  const stateVal: string = nqVal('nq-state');
  const formed: string = nqVal('nq-formed');
  const entityType: string = nqVal('nq-entity-type');
  if (!bizDesc && !stateVal && !entityType) return null;
  let h: string = '';
  let p: string = '';
  const an: string = /^([aeiou]|S\b|S )/i.test(entityType) ? 'an' : 'a';
  if (entityType && stateVal && formed) {
    p += esc(company) + ' (the "Company") is ' + an + ' ' + esc(entityType) + ' organized under the laws of the State of ' + esc(stateVal) + ', formed on ' + esc(formed) + '. ';
  } else if (entityType && stateVal) {
    p += esc(company) + ' (the "Company") is ' + an + ' ' + esc(entityType) + ' organized under the laws of the State of ' + esc(stateVal) + '. ';
  } else if (entityType) {
    p += esc(company) + ' (the "Company") is ' + an + ' ' + esc(entityType) + '. ';
  } else {
    p += esc(company) + ' (the "Company") ';
  }
  if (bizDesc) p += esc(bizDesc);
  h += '<p>' + p + '</p>';
  return { id: 'operations', title: 'Nature of Operations', html: h };
}

function buildNoteAccounting(_company: string, _period: string): NoteSectionResult | null {
  const basis: string = nqVal('nq-basis');
  const revRec: string = nqVal('nq-revenue-recognition');
  const cashEquiv: string = nqVal('nq-cash-equiv');
  const hasAllowance: boolean = nqRadio('nq-allowance') === 'yes';
  const allowanceText: string = nqVal('nq-allowance-text');
  const inventory: string = nqVal('nq-inventory');
  const depreciation: string = nqVal('nq-depreciation');
  const usefulLives: string = nqVal('nq-useful-lives');
  const hasIntangibles: boolean = nqRadio('nq-intangibles') === 'yes';
  const intangiblesText: string = nqVal('nq-intangibles-text');
  const advertising: string = nqVal('nq-advertising');

  let h: string = '';

  if (basis) {
    const basisLabels: Record<string, string> = {
      'accrual': 'accrual basis of accounting in accordance with accounting principles generally accepted in the United States of America (U.S. GAAP)',
      'cash': 'cash basis of accounting, which is a comprehensive basis of accounting other than U.S. GAAP. Under this basis, revenue is recognized when received and expenses are recognized when paid',
      'modified-cash': 'modified cash basis of accounting, which is a comprehensive basis of accounting other than U.S. GAAP. This basis modifies the cash basis to record certain items on the accrual basis, such as depreciation and accounts payable',
      'tax': 'income tax basis of accounting, which is a comprehensive basis of accounting other than U.S. GAAP. Under this basis, revenues and expenses are recognized in accordance with applicable income tax regulations',
    };
    h += '<p><strong>Basis of Accounting</strong> — The accompanying financial statements have been prepared on the ' + (basisLabels[basis] || esc(basis)) + '.</p>';
  }

  h += '<p><strong>Use of Estimates</strong> — The preparation of financial statements in conformity with ' + (basis === 'accrual' ? 'U.S. GAAP' : 'the basis of accounting described above') + ' requires management to make estimates and assumptions that affect the reported amounts of assets and liabilities and disclosure of contingent assets and liabilities at the date of the financial statements and the reported amounts of revenues and expenses during the reporting period. Significant estimates include, but are not limited to, the allowance for doubtful accounts, useful lives of property and equipment, and the assessment of contingencies. Actual results could differ from those estimates.</p>';

  if (cashEquiv) {
    h += '<p><strong>Cash and Cash Equivalents</strong> — ' + esc(cashEquiv) + '</p>';
  } else {
    h += '<p><strong>Cash and Cash Equivalents</strong> — The Company considers all highly liquid investments with an original maturity of three months or less when purchased to be cash equivalents.</p>';
  }

  if (revRec) {
    h += '<p><strong>Revenue Recognition</strong> — ' + esc(revRec) + '</p>';
  }

  if (hasAllowance && allowanceText) {
    h += '<p><strong>Accounts Receivable</strong> — Accounts receivable are stated at the amount the Company expects to collect. ' + esc(allowanceText) + ' Receivables are written off when deemed uncollectible.</p>';
  } else {
    const hasAR: boolean = rows(state.currentData, 'current-assets').some(function(r) { return /receivable/i.test(r.label); });
    if (hasAR) {
      h += '<p><strong>Accounts Receivable</strong> — Accounts receivable are stated at the amount the Company expects to collect. The Company evaluates the collectability of receivables on a regular basis and writes off amounts deemed uncollectible. Management has determined that an allowance for doubtful accounts is not necessary at the balance sheet date.</p>';
    }
  }

  if (inventory) {
    h += '<p><strong>Inventory</strong> — Inventory is stated at the lower of cost or net realizable value. Cost is determined using the ' + esc(inventory) + ' method. The Company periodically reviews inventory for obsolescence and adjusts carrying values as necessary.</p>';
    const invTable: string = buildInventorySchedule();
    if (invTable) {
      h += '<p>Inventory consisted of the following:</p>' + invTable;
    }
  }

  if (depreciation) {
    const depLabels: Record<string, string> = {
      'straight-line': 'straight-line method',
      'declining balance': 'declining balance method',
      'MACRS': 'Modified Accelerated Cost Recovery System (MACRS) for tax purposes',
    };
    let depText: string = 'Property and equipment are recorded at cost less accumulated depreciation. Depreciation is computed using the ' + (depLabels[depreciation] || esc(depreciation)) + ' over the estimated useful lives of the respective assets.';
    if (usefulLives) depText += ' Estimated useful lives are as follows: ' + esc(usefulLives) + '.';
    depText += ' Expenditures for major improvements and additions are capitalized, while expenditures for maintenance and repairs are charged to expense as incurred. Upon retirement or disposal, the cost and accumulated depreciation are removed from the accounts, and any resulting gain or loss is reflected in the statements of operations.';
    h += '<p><strong>Property and Equipment</strong> — ' + depText + '</p>';
    const ppeTable: string = buildPPESchedule();
    if (ppeTable) {
      h += '<p>Property and equipment consisted of the following:</p>' + ppeTable;
    }
  }

  if (hasIntangibles && intangiblesText) {
    h += '<p><strong>Intangible Assets</strong> — ' + esc(intangiblesText) + ' The Company reviews intangible assets for impairment whenever events or changes in circumstances indicate that the carrying amount may not be recoverable.</p>';
  }

  if (advertising === 'expensed') {
    h += '<p><strong>Advertising Costs</strong> — Advertising costs are expensed as incurred.</p>';
  } else if (advertising === 'capitalized') {
    h += '<p><strong>Advertising Costs</strong> — Certain direct-response advertising costs are capitalized and amortized over the estimated period of benefit. All other advertising costs are expensed as incurred.</p>';
  }

  return { id: 'accounting', title: 'Summary of Significant Accounting Policies', html: h };
}

function buildNoteTaxes(_company: string, _period: string): NoteSectionResult | null {
  const taxStatus: string = nqVal('nq-tax-status');
  const hasTaxUncertain: boolean = nqRadio('nq-tax-uncertain') === 'yes';
  const taxUncertainText: string = nqVal('nq-tax-uncertain-text');
  if (!taxStatus) return null;

  let h: string = '';
  const taxLanguage: Record<string, string> = {
    's-corp': 'The Company has elected to be taxed as an S Corporation under the Internal Revenue Code. Under this election, the Company\'s taxable income or loss is passed through to and reported on the individual income tax returns of the shareholders. Accordingly, no provision for federal income taxes has been recorded in the accompanying financial statements. The Company may be subject to certain state income taxes.',
    'c-corp': 'The Company is subject to federal and state income taxes as a C Corporation. The Company accounts for income taxes under the asset and liability method, whereby deferred tax assets and liabilities are recognized for the future tax consequences attributable to temporary differences between the financial statement carrying amounts of existing assets and liabilities and their respective tax bases. Deferred tax assets and liabilities are measured using enacted tax rates expected to apply to taxable income in the years in which those temporary differences are expected to be recovered or settled.',
    'llc-partner': 'The Company is organized as a limited liability company treated as a partnership for federal income tax purposes. As such, the Company\'s taxable income or loss is passed through to and reported on the individual income tax returns of its members. Accordingly, no provision for federal or state income taxes has been recorded in the accompanying financial statements.',
    'llc-scorp': 'The Company is organized as a limited liability company that has elected to be taxed as an S Corporation under the Internal Revenue Code. Under this election, the Company\'s taxable income or loss is passed through to and reported on the individual income tax returns of its members. Accordingly, no provision for federal income taxes has been recorded in the accompanying financial statements.',
    'sole-prop': 'The Company is a sole proprietorship, and all income and expenses are reported on the owner\'s individual income tax return. Accordingly, no provision for federal or state income taxes has been recorded in the accompanying financial statements.',
    'nonprofit': 'The Company is a nonprofit organization exempt from federal income tax under Section 501(c)(3) of the Internal Revenue Code and applicable state statutes. Accordingly, no provision for income taxes has been recorded in the accompanying financial statements.',
  };
  h += '<p>' + (taxLanguage[taxStatus] || '') + '</p>';

  if (hasTaxUncertain && taxUncertainText) {
    h += '<p>' + esc(taxUncertainText) + '</p>';
  } else {
    h += '<p>The Company evaluates uncertain tax positions, if any, by applying a more-likely-than-not threshold for financial statement recognition. Management has evaluated the Company\'s tax positions and concluded that there are no uncertain tax positions requiring recognition as of the balance sheet date.</p>';
  }
  return { id: 'taxes', title: 'Income Taxes', html: h };
}

function buildNoteDebt(_company: string, _period: string): NoteSectionResult | null {
  const hasDebt: boolean = nqRadio('nq-debt') === 'yes';
  const debtText: string = nqVal('nq-debt-text');
  const locText: string = nqVal('nq-loc-text');
  if (!(hasDebt && (debtText || locText))) return null;

  let h: string = '';
  if (debtText) h += '<p>' + esc(debtText) + '</p>';
  if (locText) h += '<p><strong>Lines of Credit</strong> — ' + esc(locText) + '</p>';
  const debtSchedule: string = buildDebtSchedule();
  if (debtSchedule) {
    h += '<p>Outstanding debt obligations consisted of the following:</p>' + debtSchedule;
  }
  return { id: 'debt', title: 'Debt and Notes Payable', html: h };
}

function buildNoteLeases(_company: string, _period: string): NoteSectionResult | null {
  const hasLeases: boolean = nqRadio('nq-leases') === 'yes';
  const leasesText: string = nqVal('nq-leases-text');
  const leaseShortTerm: boolean = nqRadio('nq-lease-shortterm') === 'yes';
  if (!(hasLeases && leasesText)) return null;

  let h: string = '';
  h += '<p>The Company determines if an arrangement is a lease at inception. ' + esc(leasesText) + '</p>';
  if (leaseShortTerm) {
    h += '<p>The Company has elected the practical expedient to not recognize right-of-use assets and lease liabilities for short-term leases with a term of 12 months or less. Short-term lease expense is recognized on a straight-line basis over the lease term.</p>';
  }
  return { id: 'leases', title: 'Leases', html: h };
}

function buildNoteEquity(_company: string, _period: string): NoteSectionResult | null {
  const entityType: string = nqVal('nq-entity-type');
  const equityText: string = nqVal('nq-equity-text');
  const hasDist: boolean = nqRadio('nq-distributions') === 'yes';
  const distText: string = nqVal('nq-distributions-text');
  if (!(equityText || (hasDist && distText))) return null;

  const eqTitle: string = (entityType && (entityType.indexOf('LLC') >= 0 || entityType.indexOf('Partnership') >= 0)) ? 'Members\' Equity' : 'Stockholders\' Equity';
  let h: string = '';
  if (equityText) h += '<p>' + esc(equityText) + '</p>';
  if (hasDist && distText) h += '<p><strong>Distributions</strong> — ' + esc(distText) + '</p>';
  const eqTable: string = buildComparativeSection('equity');
  if (eqTable) {
    h += '<p>Components of ' + eqTitle.toLowerCase() + ' consisted of the following:</p>' + eqTable;
  }
  return { id: 'equity', title: eqTitle, html: h };
}

function buildNoteRelated(_company: string, _period: string): NoteSectionResult | null {
  const hasRelated: boolean = nqRadio('nq-related') === 'yes';
  const relatedText: string = nqVal('nq-related-text');
  if (!(hasRelated && relatedText)) return null;
  return { id: 'related', title: 'Related Party Transactions', html: '<p>' + esc(relatedText) + '</p>' };
}

function buildNoteConcentrations(_company: string, _period: string): NoteSectionResult | null {
  const hasFDIC: boolean = nqRadio('nq-fdic') === 'yes';
  const hasCustConc: boolean = nqRadio('nq-cust-conc') === 'yes';
  const hasVendorConc: boolean = nqRadio('nq-vendor-conc') === 'yes';
  const custConcText: string = nqVal('nq-cust-conc-text');
  const vendorConcText: string = nqVal('nq-vendor-conc-text');
  if (!(hasFDIC || hasCustConc || hasVendorConc)) return null;

  let h: string = '';
  if (hasFDIC) {
    h += '<p><strong>Cash Deposits</strong> — The Company maintains its cash balances in financial institutions, which at times may exceed federally insured limits of $250,000 per depositor per institution. The Company has not experienced any losses on such accounts and management believes the Company is not exposed to any significant credit risk on its cash balances.</p>';
  }
  if (hasCustConc && custConcText) {
    h += '<p><strong>Revenue Concentration</strong> — ' + esc(custConcText) + '</p>';
  }
  if (hasVendorConc && vendorConcText) {
    h += '<p><strong>Vendor Concentration</strong> — ' + esc(vendorConcText) + '</p>';
  }
  return { id: 'concentrations', title: 'Concentrations of Credit Risk', html: h };
}

function buildNoteCommitments(_company: string, _period: string): NoteSectionResult | null {
  const hasLitigation: boolean = nqRadio('nq-litigation') === 'yes';
  const litigationText: string = nqVal('nq-litigation-text');
  const hasOtherCommit: boolean = nqRadio('nq-other-commit') === 'yes';
  const otherCommitText: string = nqVal('nq-other-commit-text');

  let h: string = '';
  if (hasLitigation && litigationText) {
    h += '<p><strong>Litigation</strong> — ' + esc(litigationText) + '</p>';
  } else {
    h += '<p><strong>Litigation</strong> — In the normal course of business, the Company may be subject to various claims and legal proceedings. Management is not aware of any pending or threatened litigation that would have a material adverse effect on the Company\'s financial position, results of operations, or cash flows as of the date of these financial statements.</p>';
  }
  if (hasOtherCommit && otherCommitText) {
    h += '<p><strong>Other Commitments</strong> — ' + esc(otherCommitText) + '</p>';
  }
  return { id: 'commitments', title: 'Commitments and Contingencies', html: h };
}

function buildNoteAJE(_company: string, _period: string): NoteSectionResult | null {
  if (!(state.ajePosted && state.ajeEntries.length > 0)) return null;

  let h: string = '';
  h += '<p>The following adjusting entries have been recorded to the financial statements:</p>';
  h += '<table class="nt-table" style="margin:8px 0 16px"><thead><tr><th style="text-align:left">Entry</th><th style="text-align:left">Description</th><th style="text-align:left">Account</th><th style="text-align:right">Debit</th><th style="text-align:right">Credit</th></tr></thead><tbody>';
  const c: string = cur();
  state.ajeEntries.forEach((entry: AJEEntry, eIdx: number) => {
    const hasMultiLines: boolean = entry.lines.length > 1;
    entry.lines.forEach((ln: AJELine, lIdx: number) => {
      const d: number = parseFloat(String(ln.debit)) || 0;
      const cr: number = parseFloat(String(ln.credit)) || 0;
      if (d === 0 && cr === 0) return;
      h += '<tr>';
      if (lIdx === 0) {
        h += '<td' + (hasMultiLines ? ' rowspan="' + entry.lines.length + '"' : '') + '>AJE-' + (eIdx + 1) + '</td>';
        h += '<td' + (hasMultiLines ? ' rowspan="' + entry.lines.length + '"' : '') + '>' + esc(entry.description || '\u2014') + '</td>';
      }
      h += '<td' + (cr > 0 && d === 0 ? ' style="padding-left:20px"' : '') + '>' + esc(ln.account || '\u2014') + '</td>';
      h += '<td style="text-align:right">' + (d > 0 ? c + fmt(d) : '') + '</td>';
      h += '<td style="text-align:right">' + (cr > 0 ? c + fmt(cr) : '') + '</td>';
      h += '</tr>';
    });
  });
  h += '</tbody></table>';
  return { id: 'aje', title: 'Adjusting Journal Entries', html: h };
}

function buildNoteSubsequent(_company: string, _period: string): NoteSectionResult | null {
  const subseqDate: string = nqVal('nq-subseq-date');
  const hasSubseq: boolean = nqRadio('nq-subseq') === 'yes';
  const subseqText: string = nqVal('nq-subseq-text');

  let h: string = '';
  const evalDate: string = subseqDate || 'the date these financial statements were available to be issued';
  h += '<p>The Company has evaluated subsequent events through ' + esc(evalDate) + ', the date the financial statements were available to be issued.';
  if (hasSubseq && subseqText) {
    h += ' ' + esc(subseqText);
  } else {
    h += ' No material subsequent events have occurred since the balance sheet date that require recognition or disclosure in the financial statements.';
  }
  h += '</p>';
  return { id: 'subsequent', title: 'Subsequent Events', html: h };
}

function buildNoteGoingConcern(_company: string, _period: string): NoteSectionResult | null {
  const hasGC: boolean = nqRadio('nq-going-concern') === 'yes';
  const gcText: string = nqVal('nq-gc-text');
  if (!(hasGC && gcText)) return null;

  let h: string = '';
  h += '<p>The accompanying financial statements have been prepared assuming that the Company will continue as a going concern. ' + esc(gcText) + '</p>';
  h += '<p>The financial statements do not include any adjustments relating to the recoverability and classification of recorded asset amounts or the amounts and classification of liabilities that might be necessary should the Company be unable to continue as a going concern.</p>';
  return { id: 'going-concern', title: 'Going Concern', html: h };
}

function buildNoteRevenueDetail(_company: string, period: string, priorPeriod: string): NoteSectionResult | null {
  const revItems = rows(state.currentData, 'revenue');
  const priorRevItems = rows(state.priorData, 'revenue');
  if (revItems.length <= 1) return null;

  const multi: boolean = hasPriorData();
  let h: string = '';
  h += '<p>Revenue consisted of the following for the periods presented:</p>';
  h += '<table class="nt-table" style="margin:8px 0 16px"><thead><tr><th style="text-align:left">Revenue Source</th>';
  const c: string = cur();
  if (multi) {
    const curYear: string = extractYear(period) || 'Current';
    const priorYear: string = extractYear(priorPeriod) || 'Prior';
    h += '<th style="text-align:right">' + esc(curYear) + '</th><th style="text-align:right">' + esc(priorYear) + '</th>';
  } else {
    h += '<th style="text-align:right">Amount</th>';
  }
  h += '</tr></thead><tbody>';
  revItems.forEach((item) => {
    const amt = parseFloat(String(item.amount)) || 0;
    const priorItem = priorRevItems.find(p => p.label === item.label);
    const pAmt = priorItem ? (parseFloat(String(priorItem.amount)) || 0) : 0;
    h += '<tr><td>' + esc(item.label) + '</td><td style="text-align:right">' + c + fmt(amt) + '</td>';
    if (multi) h += '<td style="text-align:right">' + (priorItem ? c + fmt(pAmt) : '\u2014') + '</td>';
    h += '</tr>';
  });
  const revTotal = sum(state.currentData, 'revenue');
  const pRevTotal = multi ? sum(state.priorData, 'revenue') : 0;
  h += '<tr class="nt-total"><td>Total Revenue</td><td style="text-align:right">' + c + fmt(revTotal) + '</td>';
  if (multi) h += '<td style="text-align:right">' + c + fmt(pRevTotal) + '</td>';
  h += '</tr></tbody></table>';
  return { id: 'revenue-detail', title: 'Revenue Detail', html: h };
}

function buildNoteOpexDetail(_company: string, period: string, priorPeriod: string): NoteSectionResult | null {
  const opexItems = rows(state.currentData, 'opex');
  const priorOpexItems = rows(state.priorData, 'opex');
  if (opexItems.length <= 1) return null;

  const multi: boolean = hasPriorData();
  let h: string = '';
  h += '<p>Operating expenses consisted of the following:</p>';
  h += '<table class="nt-table" style="margin:8px 0 16px"><thead><tr><th style="text-align:left">Expense</th>';
  const c: string = cur();
  if (multi) {
    const curYear: string = extractYear(period) || 'Current';
    const priorYear: string = extractYear(priorPeriod) || 'Prior';
    h += '<th style="text-align:right">' + esc(curYear) + '</th><th style="text-align:right">' + esc(priorYear) + '</th>';
  } else {
    h += '<th style="text-align:right">Amount</th>';
  }
  h += '</tr></thead><tbody>';
  opexItems.forEach((item) => {
    const amt = parseFloat(String(item.amount)) || 0;
    const priorItem = priorOpexItems.find(p => p.label === item.label);
    const pAmt = priorItem ? (parseFloat(String(priorItem.amount)) || 0) : 0;
    h += '<tr><td>' + esc(item.label) + '</td><td style="text-align:right">' + c + fmt(amt) + '</td>';
    if (multi) h += '<td style="text-align:right">' + (priorItem ? c + fmt(pAmt) : '\u2014') + '</td>';
    h += '</tr>';
  });
  const opexTotal = sum(state.currentData, 'opex');
  const pOpexTotal = multi ? sum(state.priorData, 'opex') : 0;
  h += '<tr class="nt-total"><td>Total Operating Expenses</td><td style="text-align:right">' + c + fmt(opexTotal) + '</td>';
  if (multi) h += '<td style="text-align:right">' + c + fmt(pOpexTotal) + '</td>';
  h += '</tr></tbody></table>';
  return { id: 'opex-detail', title: 'Operating Expenses Detail', html: h };
}

function buildNoteDepreciationSchedule(_company: string, _period: string): NoteSectionResult | null {
  const ncaItems = rows(state.currentData, 'noncurrent-assets');
  const priorNcaItems = rows(state.priorData, 'noncurrent-assets');
  const depPattern = /depreciation|accum/i;
  const curDepItems = ncaItems.filter(i => depPattern.test(i.label));
  const priorDepItems = priorNcaItems.filter(i => depPattern.test(i.label));
  if (!(curDepItems.length > 0 && priorDepItems.length > 0)) return null;

  let h: string = '';
  h += '<p>Changes in accumulated depreciation during the period:</p>';
  h += '<table class="nt-table" style="margin:8px 0 16px"><thead><tr><th style="text-align:left">Account</th><th style="text-align:right">Beginning</th><th style="text-align:right">Expense</th><th style="text-align:right">Ending</th></tr></thead><tbody>';
  const c: string = cur();
  curDepItems.forEach((item) => {
    const endBal = Math.abs(parseFloat(String(item.amount)) || 0);
    const priorMatch = priorDepItems.find(p => p.label === item.label);
    const begBal = priorMatch ? Math.abs(parseFloat(String(priorMatch.amount)) || 0) : 0;
    const expense = endBal - begBal;
    h += '<tr><td>' + esc(item.label) + '</td>';
    h += '<td style="text-align:right">' + c + fmt(begBal) + '</td>';
    h += '<td style="text-align:right">' + c + fmt(expense) + '</td>';
    h += '<td style="text-align:right">' + c + fmt(endBal) + '</td></tr>';
  });
  h += '</tbody></table>';
  return { id: 'depreciation-schedule', title: 'Depreciation Schedule', html: h };
}

const NOTE_BUILDERS: Record<string, NoteSectionBuilder> = {
  'operations': buildNoteOperations,
  'accounting': buildNoteAccounting,
  'taxes': buildNoteTaxes,
  'debt': buildNoteDebt,
  'leases': buildNoteLeases,
  'equity': buildNoteEquity,
  'related': buildNoteRelated,
  'concentrations': buildNoteConcentrations,
  'commitments': buildNoteCommitments,
  'aje': buildNoteAJE,
  'subsequent': buildNoteSubsequent,
  'going-concern': buildNoteGoingConcern,
  'revenue-detail': buildNoteRevenueDetail,
  'opex-detail': buildNoteOpexDetail,
  'depreciation-schedule': buildNoteDepreciationSchedule,
};

// ─── Drag-and-Drop Helpers ─────────────────────────────────────────────────

let _draggedNoteId: string | null = null;

function initNoteDragAndDrop(): void {
  const container = el('notes-output-sections');
  if (!container) return;

  const sections = container.querySelectorAll<HTMLElement>('.note-section-draggable');
  sections.forEach((section: HTMLElement) => {
    section.addEventListener('dragstart', (e: DragEvent) => {
      _draggedNoteId = section.dataset.noteId || null;
      section.classList.add('note-dragging');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', _draggedNoteId || '');
      }
    });

    section.addEventListener('dragend', () => {
      section.classList.remove('note-dragging');
      _draggedNoteId = null;
      container.querySelectorAll('.note-drop-target').forEach((dropEl: Element) => {
        dropEl.classList.remove('note-drop-target');
      });
    });

    section.addEventListener('dragover', (e: DragEvent) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      container.querySelectorAll('.note-drop-target').forEach((dropEl: Element) => {
        dropEl.classList.remove('note-drop-target');
      });
      if (_draggedNoteId && section.dataset.noteId !== _draggedNoteId) {
        section.classList.add('note-drop-target');
      }
    });

    section.addEventListener('dragleave', () => {
      section.classList.remove('note-drop-target');
    });

    section.addEventListener('drop', (e: DragEvent) => {
      e.preventDefault();
      section.classList.remove('note-drop-target');
      if (!_draggedNoteId || _draggedNoteId === section.dataset.noteId) return;

      const draggedEl = container.querySelector('[data-note-id="' + _draggedNoteId + '"]') as HTMLElement | null;
      if (!draggedEl) return;

      // Determine drop position based on mouse Y relative to target center
      const rect = section.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      const mouseY = e.clientY;

      if (mouseY < midY) {
        container.insertBefore(draggedEl, section);
      } else {
        container.insertBefore(draggedEl, section.nextSibling);
      }

      // Update state.noteOrder from current DOM order
      const updatedOrder: string[] = [];
      container.querySelectorAll<HTMLElement>('.note-section-draggable').forEach((s: HTMLElement) => {
        if (s.dataset.noteId) updatedOrder.push(s.dataset.noteId);
      });
      state.noteOrder = updatedOrder;

      // Re-number notes after reorder
      renumberNotes();

      saveNotesToProject();
    });
  });
}

function renumberNotes(): void {
  const container = el('notes-output-sections');
  if (!container) return;
  let num: number = 0;
  container.querySelectorAll<HTMLElement>('.note-section-draggable').forEach((section: HTMLElement) => {
    num++;
    const h3 = section.querySelector('.note-section-title');
    if (h3) {
      const titleText = h3.getAttribute('data-base-title') || '';
      h3.textContent = 'Note ' + num + ' \u2014 ' + titleText;
    }
  });
}

function resetNoteOrder(): void {
  state.noteOrder = [];
  generateNotes();
}

// ─── Drag-and-Drop Styles ──────────────────────────────────────────────────

function injectNoteReorderStyles(): void {
  if (document.getElementById('note-reorder-styles')) return;
  const style: HTMLStyleElement = document.createElement('style');
  style.id = 'note-reorder-styles';
  style.textContent = `
    .note-section-draggable {
      position: relative;
      transition: box-shadow 0.15s, border-color 0.15s;
      border: 2px solid transparent;
      border-radius: 6px;
      margin-bottom: 4px;
      padding: 2px 0 2px 0;
    }
    .note-section-draggable:hover {
      border-color: #e0e0e0;
    }
    .note-section-draggable.note-dragging {
      opacity: 0.4;
      border-color: #2196f3;
    }
    .note-section-draggable.note-drop-target {
      border-color: #2196f3;
      box-shadow: 0 0 0 2px rgba(33,150,243,0.2);
      background: rgba(33,150,243,0.04);
    }
    .note-drag-handle {
      display: inline-block;
      cursor: grab;
      color: #999;
      font-size: 1.1em;
      margin-right: 6px;
      vertical-align: middle;
      user-select: none;
    }
    .note-drag-handle:hover {
      color: #555;
    }
    .note-section-draggable .note-section-header {
      display: flex;
      align-items: center;
    }
    .note-section-title {
      flex: 1;
    }
    .note-reorder-toolbar {
      display: flex;
      justify-content: flex-end;
      margin-bottom: 8px;
      gap: 8px;
    }
    .note-reorder-toolbar button {
      font-size: 0.82rem;
      padding: 4px 12px;
      border: 1px solid #ccc;
      border-radius: 4px;
      background: #f5f5f5;
      cursor: pointer;
      color: #555;
    }
    .note-reorder-toolbar button:hover {
      background: #e8e8e8;
      border-color: #999;
    }
    @media print {
      .note-drag-handle,
      .note-reorder-toolbar {
        display: none !important;
      }
      .note-section-draggable {
        border: none !important;
        margin-bottom: 0 !important;
        padding: 0 !important;
      }
    }
  `;
  document.head.appendChild(style);
}

/**
 * Generates notes to the financial statements from questionnaire inputs and renders them to the DOM.
 * Notes are rendered in the order specified by state.noteOrder (or DEFAULT_NOTE_ORDER if empty).
 * Each section is wrapped in a draggable container for reordering.
 */
export function generateNotes(): void {
  // Ensure questionnaire is pre-filled from TB data before generating
  autoPopulateFromTB();

  const m = meta();
  const company: string = m.company;
  const period: string = m.period;
  const priorPeriod: string = m.priorPeriod;

  // Determine section order
  const order: string[] = (state.noteOrder && state.noteOrder.length > 0)
    ? state.noteOrder
    : DEFAULT_NOTE_ORDER;

  // Build all sections that have content, in requested order
  const builtSections: NoteSectionResult[] = [];
  const builtIds = new Set<string>();
  for (const sectionId of order) {
    const builder = NOTE_BUILDERS[sectionId];
    if (!builder) continue;
    const result = builder(company, period, priorPeriod);
    if (result) {
      builtSections.push(result);
      builtIds.add(sectionId);
    }
  }
  // Also build any sections not in the order list (new sections or corrupted order)
  for (const sectionId of DEFAULT_NOTE_ORDER) {
    if (builtIds.has(sectionId)) continue;
    const builder = NOTE_BUILDERS[sectionId];
    if (!builder) continue;
    const result = builder(company, period, priorPeriod);
    if (result) {
      builtSections.push(result);
    }
  }

  // Build the HTML
  let html: string = '<div class="stmt-header">' +
    '<div class="company">' + esc(company) + '</div>' +
    '<div class="title">Notes to the Financial Statements</div>' +
    '<div class="period">' + esc(period) + '</div>' +
  '</div>';

  // Reorder toolbar
  html += '<div class="note-reorder-toolbar">' +
    '<button type="button" id="btn-reset-note-order" title="Restore default note ordering">Reset Order</button>' +
  '</div>';

  html += '<div class="notes-output" id="notes-output-sections">';

  let noteNum: number = 0;
  for (const section of builtSections) {
    noteNum++;
    html += '<div class="note-section-draggable" draggable="true" data-note-id="' + section.id + '">';
    html += '<h3 class="note-section-header">' +
      '<span class="note-drag-handle" title="Drag to reorder">\u2630</span>' +
      '<span class="note-section-title" data-base-title="' + esc(section.title) + '">' +
      'Note ' + noteNum + ' \u2014 ' + esc(section.title) +
      '</span></h3>';
    html += section.html;
    html += '</div>';
  }

  html += '</div>';

  const notesStmt = el('notes-statement');
  if (notesStmt) notesStmt.innerHTML = html;
  const notesQ = el('notes-questionnaire');
  if (notesQ) notesQ.style.display = 'none';
  const notesOut = el('notes-output-wrapper');
  if (notesOut) notesOut.style.display = 'block';

  // Inject styles and initialize drag-and-drop
  injectNoteReorderStyles();
  initNoteDragAndDrop();

  // Wire up reset button
  const resetBtn = document.getElementById('btn-reset-note-order');
  if (resetBtn) {
    resetBtn.addEventListener('click', resetNoteOrder);
  }

  saveNotesToProject();
}

// ─── Disclosure Checklist ──────────────────────────────────────────────────
// ─── Default Disclosure Language for Missing Items ─────────────────────────

function getDefaultDisclosureText(id: string, m: { company: string; period: string; priorPeriod: string }, dataContext: DataContext): string {
  const company: string = esc(m.company || 'The Company');
  const period: string = esc(m.period || 'the reporting period');
  const defaults: Record<string, string> = {
    'basis': '<h3>Note — Basis of Accounting</h3>' +
      '<p>The accompanying financial statements of ' + company + ' have been prepared on the accrual basis of accounting in accordance with accounting principles generally accepted in the United States of America (U.S. GAAP).</p>',

    'estimates': '<h3>Note — Use of Estimates</h3>' +
      '<p>The preparation of financial statements in conformity with U.S. GAAP requires management to make estimates and assumptions that affect the reported amounts of assets and liabilities and disclosure of contingent assets and liabilities at the date of the financial statements and the reported amounts of revenues and expenses during the reporting period. Actual results could differ from those estimates.</p>',

    'cash': '<h3>Note — Cash and Cash Equivalents</h3>' +
      '<p>The Company considers all highly liquid investments with an original maturity of three months or less when purchased to be cash equivalents. Cash balances are maintained in financial institutions, which at times may exceed federally insured limits.</p>',

    'revenue': '<h3>Note — Revenue Recognition</h3>' +
      '<p>The Company recognizes revenue in accordance with ASC 606. Revenue is recognized when control of promised goods or services is transferred to customers, in an amount that reflects the consideration the Company expects to be entitled to in exchange for those goods or services.</p>',

    'receivables': '<h3>Note — Accounts Receivable</h3>' +
      '<p>Accounts receivable are stated at the amount the Company expects to collect. The Company evaluates the collectability of receivables on a regular basis and establishes an allowance for doubtful accounts when deemed necessary based on historical experience and current economic conditions. Receivables are written off when deemed uncollectible.</p>',

    'inventory': '<h3>Note — Inventory</h3>' +
      '<p>Inventory is stated at the lower of cost or net realizable value. The Company periodically reviews inventory for obsolescence and writes down inventory to its net realizable value when the carrying amount exceeds the estimated selling price less costs to complete and sell.</p>',

    'ppe': '<h3>Note — Property and Equipment</h3>' +
      '<p>Property and equipment are recorded at cost less accumulated depreciation. Depreciation is computed using the straight-line method over the estimated useful lives of the respective assets. Expenditures for major improvements and additions are capitalized, while expenditures for maintenance and repairs are charged to expense as incurred. Upon retirement or disposal, the cost and accumulated depreciation are removed from the accounts, and any resulting gain or loss is reflected in the statements of operations.</p>' +
      (dataContext.ppeTable || ''),

    'intangibles': '<h3>Note — Intangible Assets</h3>' +
      '<p>Intangible assets with finite useful lives are amortized over their estimated useful lives on a straight-line basis. The Company reviews intangible assets for impairment whenever events or changes in circumstances indicate that the carrying amount may not be recoverable. Goodwill and indefinite-lived intangible assets are tested for impairment annually or more frequently if indicators of impairment exist.</p>',

    'debt': '<h3>Note — Debt and Notes Payable</h3>' +
      '<p>The Company\'s outstanding debt obligations are recorded at their principal amount. Interest expense is recognized as incurred. The Company was in compliance with all applicable debt covenants as of the balance sheet date.</p>' +
      (dataContext.debtTable || ''),

    'leases': '<h3>Note — Leases</h3>' +
      '<p>The Company determines if an arrangement is a lease at inception. Operating lease right-of-use assets and liabilities are recognized at the lease commencement date based on the present value of lease payments over the lease term. The Company has elected the practical expedient to not recognize right-of-use assets and lease liabilities for short-term leases with a term of 12 months or less.</p>',

    'taxes': '<h3>Note — Income Taxes</h3>' +
      '<p>The Company evaluates uncertain tax positions using a more-likely-than-not threshold for financial statement recognition. Management has evaluated the Company\'s tax positions and concluded that there are no uncertain tax positions requiring recognition as of the balance sheet date. The Company\'s tax returns remain subject to examination by taxing authorities for the standard statute of limitations period.</p>',

    'equity': '<h3>Note — Equity</h3>' +
      '<p>The following table summarizes the components of equity:</p>' +
      (dataContext.equityTable || ''),

    'related': '<h3>Note — Related Party Transactions</h3>' +
      '<p>The Company has evaluated its relationships with related parties. There were no material related party transactions during ' + period + ' that require disclosure.</p>',

    'concentrations': '<h3>Note — Concentrations of Credit Risk</h3>' +
      '<p>Financial instruments that potentially subject the Company to concentrations of credit risk consist principally of cash deposits and accounts receivable. The Company maintains its cash balances in financial institutions, which at times may exceed federally insured limits of $250,000 per depositor per institution. The Company has not experienced any losses on such accounts and management believes the Company is not exposed to any significant credit risk on its cash balances.</p>',

    'contingencies': '<h3>Note — Commitments and Contingencies</h3>' +
      '<p>In the normal course of business, the Company may be subject to various claims and legal proceedings. Management is not aware of any pending or threatened litigation that would have a material adverse effect on the Company\'s financial position, results of operations, or cash flows as of the date of these financial statements.</p>',

    'subsequent': '<h3>Note — Subsequent Events</h3>' +
      '<p>The Company has evaluated subsequent events through the date the financial statements were available to be issued. No material subsequent events have occurred since the balance sheet date that require recognition or disclosure in the financial statements.</p>',

    'goingconcern': '<h3>Note — Going Concern</h3>' +
      '<p>The accompanying financial statements have been prepared assuming that the Company will continue as a going concern. Management has evaluated the Company\'s ability to continue as a going concern and believes that the Company\'s existing resources and ongoing operations are sufficient to fund its operations for at least twelve months from the date these financial statements are issued.</p>',
  };
  return defaults[id] || '';
}

export function addMissingDisclosures(): void {
  const notesEl = el('notes-statement');
  if (!notesEl) return;

  const m = meta();
  // Build rich schedule tables for context
  const dataContext: DataContext = {
    ppeTable: buildPPESchedule(),
    debtTable: buildDebtSchedule(),
    equityTable: buildComparativeSection('equity'),
  };

  let notesHTML: string = notesEl.innerHTML.toLowerCase();
  const hasNotes: boolean = notesHTML.length > 50;
  if (!hasNotes) {
    // Generate notes first if none exist
    generateNotes();
    notesHTML = notesEl.innerHTML.toLowerCase();
  }

  // Re-run detections to find what's still missing
  function notesMention(keyword: string): boolean { return notesHTML.indexOf(keyword.toLowerCase()) >= 0; }
  function hasItem(section: string, pattern: RegExp): boolean {
    return rows(state.currentData, section).some(function(r) { return pattern.test(r.label); });
  }
  function hasAnyItems(section: string): boolean { return rows(state.currentData, section).length > 0; }

  const checks: CheckItem[] = [
    { id: 'basis', detected: true, required: true, disclosed: notesMention('basis of accounting') },
    { id: 'estimates', detected: true, required: true, disclosed: notesMention('use of estimates') },
    { id: 'cash', detected: hasItem('current-assets', /cash/i), required: false, disclosed: notesMention('cash equivalent') || notesMention('cash and cash') },
    { id: 'revenue', detected: hasAnyItems('revenue'), required: false, disclosed: notesMention('revenue recognition') || notesMention('revenue is recognized') },
    { id: 'receivables', detected: hasItem('current-assets', /receivable/i), required: false, disclosed: notesMention('accounts receivable') || notesMention('allowance') },
    { id: 'inventory', detected: hasItem('current-assets', /inventor/i), required: false, disclosed: notesMention('inventory') },
    { id: 'ppe', detected: hasItem('noncurrent-assets', /property|equipment|vehicle|building|furniture|machinery|computer|leasehold/i), required: false, disclosed: notesMention('property and equipment') || notesMention('depreciation') },
    { id: 'intangibles', detected: hasItem('noncurrent-assets', /intangible|goodwill|patent|trademark|copyright|customer list|franchise|software/i), required: false, disclosed: notesMention('intangible') || notesMention('goodwill') || notesMention('amortiz') },
    { id: 'debt', detected: hasItem('current-liab', /loan|note.?payable|line.?of.?credit|mortgage|debt|borrowing/i) || hasItem('noncurrent-liab', /loan|note.?payable|line.?of.?credit|mortgage|debt|borrowing/i), required: false, disclosed: notesMention('debt') || notesMention('notes payable') || notesMention('loan') || notesMention('line of credit') },
    { id: 'leases', detected: hasItem('current-liab', /lease/i) || hasItem('noncurrent-liab', /lease/i) || hasItem('noncurrent-assets', /right.?of.?use|rou|lease/i), required: false, disclosed: notesMention('lease') },
    { id: 'taxes', detected: true, required: true, disclosed: notesMention('income tax') || notesMention('tax') },
    { id: 'equity', detected: hasAnyItems('equity'), required: false, disclosed: notesMention('equity') || notesMention('stockholder') || notesMention('member') },
    { id: 'related', detected: true, required: true, disclosed: notesMention('related party') },
    { id: 'concentrations', detected: true, required: true, disclosed: notesMention('concentration') || notesMention('credit risk') || notesMention('fdic') },
    { id: 'contingencies', detected: true, required: true, disclosed: notesMention('commitment') || notesMention('contingenc') || notesMention('litigation') },
    { id: 'subsequent', detected: true, required: true, disclosed: notesMention('subsequent event') },
  ];

  // Check going concern
  const totalCA: number = sum(state.currentData, 'current-assets');
  const totalCL: number = sum(state.currentData, 'current-liab');
  const ni: number = computeNetIncome(state.currentData);
  if (Math.abs(totalCL) > totalCA || ni < 0) {
    checks.push({ id: 'goingconcern', detected: true, required: true, disclosed: notesMention('going concern') });
  }

  // Find missing items
  const missingIds: string[] = [];
  checks.forEach(function(c) {
    if ((c.detected || c.required) && !c.disclosed) {
      missingIds.push(c.id);
    }
  });

  if (missingIds.length === 0) {
    alert('All disclosures are complete — no missing items to add.');
    return;
  }

  // Append missing disclosures to notes
  const existingHTML: string = notesEl.innerHTML;
  // Remove closing </div> of notes-output if present, so we append inside
  const closingDiv: number = existingHTML.lastIndexOf('</div>');
  const beforeClose: string = closingDiv >= 0 ? existingHTML.substring(0, closingDiv) : existingHTML;
  const afterClose: string = closingDiv >= 0 ? existingHTML.substring(closingDiv) : '';

  let addedHTML: string = '<div class="auto-disclosures" style="margin-top:24px;border-top:2px solid #3b82f6;padding-top:20px">';
  addedHTML += '<p style="font-size:0.85rem;font-weight:600;color:#3b82f6;margin-bottom:16px">The following disclosures were auto-generated to address gaps identified by the Disclosure Checklist. Review and customize as needed.</p>';

  let noteNum: number = (existingHTML.match(/Note\s+\d+/gi) || []).length;
  missingIds.forEach(function(id) {
    const text: string = getDefaultDisclosureText(id, m, dataContext);
    if (text) {
      noteNum++;
      // Replace "Note —" with numbered note
      const numberedText: string = text.replace(/<h3>Note —/, '<h3>Note ' + noteNum + ' —');
      addedHTML += numberedText;
    }
  });
  addedHTML += '</div>';

  notesEl.innerHTML = beforeClose + addedHTML + afterClose;

  // Show notes output if hidden
  const outputWrapper = el('notes-output-wrapper');
  if (outputWrapper) outputWrapper.style.display = 'block';
  const questionnaire = el('notes-questionnaire');
  if (questionnaire) questionnaire.style.display = 'none';

  // Re-run checklist to show updated status
  runDisclosureChecklist();

  // Scroll to top of checklist
  el('checklist-output')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

export function runDisclosureChecklist(): void {
  const m = meta();
  const notesEl = el('notes-statement');
  const notesHTML: string = notesEl ? notesEl.innerHTML.toLowerCase() : '';
  const hasNotes: boolean = notesHTML.length > 50;

  // Helper: check if any line item label in a section matches a pattern
  function hasItem(section: string, pattern: RegExp): boolean {
    return rows(state.currentData, section).some(function(r) { return pattern.test(r.label); });
  }
  function hasAnyItems(section: string): boolean { return rows(state.currentData, section).length > 0; }

  // Helper: check if notes mention a keyword
  function notesMention(keyword: string): boolean {
    if (!hasNotes) return false;
    return notesHTML.indexOf(keyword.toLowerCase()) >= 0;
  }

  // ── Detect what's on the statements ──
  const detections: Detection[] = [
    { id: 'basis', label: 'Basis of Accounting', detected: true, required: true,
      reason: 'Required for all financial statements',
      disclosed: notesMention('basis of accounting'),
      asc: 'ASC 235-10-50',
      guidance: 'Requires disclosure of the basis of accounting used (accrual, cash, tax, etc.). If a special-purpose framework is used, the nature of the framework must be described.',
      url: 'https://asc.fasb.org/235' },
    { id: 'estimates', label: 'Use of Estimates', detected: true, required: true,
      reason: 'Required for all GAAP financial statements',
      disclosed: notesMention('use of estimates'),
      asc: 'ASC 275-10-50',
      guidance: 'Requires disclosure that the preparation of financial statements in conformity with GAAP requires management to make estimates and assumptions that affect reported amounts. Must state that actual results could differ.',
      url: 'https://asc.fasb.org/275' },
    { id: 'cash', label: 'Cash and Cash Equivalents', detected: hasItem('current-assets', /cash/i), required: false,
      reason: 'Cash detected in current assets',
      disclosed: notesMention('cash equivalent') || notesMention('cash and cash'),
      asc: 'ASC 230-10-50',
      guidance: 'Requires disclosure of the policy for determining which items are treated as cash equivalents (generally instruments with original maturities of three months or less). Must disclose any restrictions on cash balances.',
      url: 'https://asc.fasb.org/230' },
    { id: 'revenue', label: 'Revenue Recognition (ASC 606)', detected: hasAnyItems('revenue'), required: false,
      reason: 'Revenue items detected',
      disclosed: notesMention('revenue recognition') || notesMention('revenue is recognized'),
      asc: 'ASC 606-10-50',
      guidance: 'Requires disclosure of the nature, amount, timing, and uncertainty of revenue and cash flows from contracts with customers. Must describe performance obligations, significant judgments, and contract balances.',
      url: 'https://asc.fasb.org/606' },
    { id: 'receivables', label: 'Accounts Receivable / Allowance', detected: hasItem('current-assets', /receivable/i), required: false,
      reason: 'Receivables detected in current assets',
      disclosed: notesMention('accounts receivable') || notesMention('allowance'),
      asc: 'ASC 310-10-50 / ASC 326-20',
      guidance: 'Requires disclosure of the methodology used to estimate the allowance for credit losses (CECL model under ASC 326). Must describe major categories of receivables, significant concentrations, and credit quality information.',
      url: 'https://asc.fasb.org/326' },
    { id: 'inventory', label: 'Inventory', detected: hasItem('current-assets', /inventor/i), required: false,
      reason: 'Inventory detected in current assets',
      disclosed: notesMention('inventory'),
      asc: 'ASC 330-10-50',
      guidance: 'Requires disclosure of the basis of stating inventories (FIFO, weighted average, etc.) and whether stated at cost or lower of cost and net realizable value. Must disclose significant write-downs or reversals.',
      url: 'https://asc.fasb.org/330' },
    { id: 'ppe', label: 'Property and Equipment', detected: hasItem('noncurrent-assets', /property|equipment|vehicle|building|furniture|machinery|computer|leasehold/i), required: false,
      reason: 'Fixed assets detected in non-current assets',
      disclosed: notesMention('property and equipment') || notesMention('depreciation'),
      asc: 'ASC 360-10-50',
      guidance: 'Requires disclosure of depreciation method, useful lives or rates, balances of major classes of depreciable assets, accumulated depreciation, and depreciation expense for the period. Must disclose impairments if applicable.',
      url: 'https://asc.fasb.org/360' },
    { id: 'intangibles', label: 'Intangible Assets / Goodwill', detected: hasItem('noncurrent-assets', /intangible|goodwill|patent|trademark|copyright|customer list|franchise|software/i), required: false,
      reason: 'Intangible assets detected in non-current assets',
      disclosed: notesMention('intangible') || notesMention('goodwill') || notesMention('amortiz'),
      asc: 'ASC 350-20-50 / ASC 350-30-50',
      guidance: 'Goodwill: disclose carrying amount, impairment testing approach, and any impairment losses (ASC 350-20). Finite-lived intangibles: disclose amortization method, useful lives, gross carrying amounts, accumulated amortization, and estimated future amortization expense (ASC 350-30).',
      url: 'https://asc.fasb.org/350' },
    { id: 'debt', label: 'Debt / Notes Payable', detected: hasItem('current-liab', /loan|note.?payable|line.?of.?credit|mortgage|debt|borrowing/i) || hasItem('noncurrent-liab', /loan|note.?payable|line.?of.?credit|mortgage|debt|borrowing/i), required: false,
      reason: 'Debt instruments detected in liabilities',
      disclosed: notesMention('debt') || notesMention('notes payable') || notesMention('loan') || notesMention('line of credit'),
      asc: 'ASC 470-10-50',
      guidance: 'Requires disclosure of terms, interest rates, maturity dates, collateral, and covenants for all significant debt instruments. Must present aggregate maturities for the five years following the balance sheet date. Disclose any defaults or covenant violations.',
      url: 'https://asc.fasb.org/470' },
    { id: 'leases', label: 'Leases (ASC 842)', detected: hasItem('current-liab', /lease/i) || hasItem('noncurrent-liab', /lease/i) || hasItem('noncurrent-assets', /right.?of.?use|rou|lease/i), required: false,
      reason: 'Lease-related items detected on balance sheet',
      disclosed: notesMention('lease'),
      asc: 'ASC 842-20-50 / ASC 842-30-50',
      guidance: 'Lessees must disclose ROU assets and lease liabilities, lease cost components, weighted-average remaining lease term, discount rate, and a maturity analysis of lease liabilities. Must distinguish operating from finance leases. Practical expedient elections must be disclosed.',
      url: 'https://asc.fasb.org/842' },
    { id: 'taxes', label: 'Income Taxes', detected: true, required: true,
      reason: 'Required — entity tax status must be disclosed',
      disclosed: notesMention('income tax') || notesMention('tax'),
      asc: 'ASC 740-10-50',
      guidance: 'Requires disclosure of the nature of income tax expense, deferred tax assets/liabilities, uncertain tax positions (UTPs), and open tax years. Pass-through entities must disclose their tax status and that income taxes are the responsibility of individual owners/members.',
      url: 'https://asc.fasb.org/740' },
    { id: 'equity', label: 'Equity / Stockholders\' Equity', detected: hasAnyItems('equity'), required: false,
      reason: 'Equity items on balance sheet',
      disclosed: notesMention('equity') || notesMention('stockholder') || notesMention('member'),
      asc: 'ASC 505-10-50',
      guidance: 'Requires disclosure of authorized, issued, and outstanding shares for each class of stock, par or stated value, dividend rates, and any preferences or restrictions. Must disclose changes in equity accounts during the period.',
      url: 'https://asc.fasb.org/505' },
    { id: 'related', label: 'Related Party Transactions', detected: true, required: true,
      reason: 'Required disclosure — must confirm presence or absence',
      disclosed: notesMention('related party'),
      asc: 'ASC 850-10-50',
      guidance: 'Requires disclosure of the nature of the relationship, a description of transactions, dollar amounts, and any amounts due to/from related parties. Must disclose even if transactions are at arm\'s length terms. Common relationships: owners, officers, family members, affiliated entities.',
      url: 'https://asc.fasb.org/850' },
    { id: 'concentrations', label: 'Concentrations of Credit Risk', detected: true, required: true,
      reason: 'Required for entities with financial instruments',
      disclosed: notesMention('concentration') || notesMention('credit risk') || notesMention('fdic'),
      asc: 'ASC 825-10-50 / ASC 275-10-50',
      guidance: 'Requires disclosure of all significant concentrations of credit risk from financial instruments (including cash deposits exceeding FDIC limits). Must disclose concentrations in revenue sources, customer base, suppliers, geographic areas, or labor markets that make the entity vulnerable to near-term severe impact.',
      url: 'https://asc.fasb.org/825' },
    { id: 'contingencies', label: 'Commitments and Contingencies', detected: true, required: true,
      reason: 'Required — must confirm presence or absence',
      disclosed: notesMention('commitment') || notesMention('contingenc') || notesMention('litigation'),
      asc: 'ASC 450-20-50 / ASC 440-10-50',
      guidance: 'Loss contingencies (ASC 450): must disclose the nature of the contingency and either an accrual or an estimate of the possible loss (or range). Commitments (ASC 440): must disclose material purchase commitments, guarantees, and other contractual obligations not recognized on the balance sheet.',
      url: 'https://asc.fasb.org/450' },
    { id: 'subsequent', label: 'Subsequent Events', detected: true, required: true,
      reason: 'Required — evaluation date must be disclosed',
      disclosed: notesMention('subsequent event'),
      asc: 'ASC 855-10-50',
      guidance: 'Requires disclosure of the date through which subsequent events have been evaluated. Recognized events (Type I): adjust the financial statements. Non-recognized events (Type II): disclose the nature and financial impact. Must distinguish between recognized and non-recognized events.',
      url: 'https://asc.fasb.org/855' },
    { id: 'goingconcern', label: 'Going Concern', detected: false, required: false,
      reason: 'Required only if substantial doubt exists',
      disclosed: notesMention('going concern'),
      asc: 'ASC 205-40',
      guidance: 'Management must evaluate whether there is substantial doubt about the entity\'s ability to continue as a going concern for one year from the financial statement issuance date. If substantial doubt exists, must disclose the conditions, management\'s plans, and whether those plans alleviate the doubt.',
      url: 'https://asc.fasb.org/205' },
  ];

  // Check going concern indicators
  const totalCA: number = sum(state.currentData, 'current-assets');
  const totalCL: number = sum(state.currentData, 'current-liab');
  const netIncome: number = computeNetIncome(state.currentData);
  if (totalCL > totalCA || netIncome < 0) {
    const gc = detections.find(function(d) { return d.id === 'goingconcern'; });
    if (gc) {
      gc.detected = true;
      gc.required = true;
      gc.reason = (totalCL > totalCA ? 'Negative working capital detected. ' : '') + (netIncome < 0 ? 'Net loss detected. ' : '') + 'Evaluate whether going concern disclosure is needed.';
    }
  }

  // ── Render checklist ──
  let html: string = '<div class="stmt-header">' +
    '<div class="company">' + esc(m.company) + '</div>' +
    '<div class="title">U.S. GAAP Disclosure Checklist</div>' +
    '<div class="period">' + esc(m.period) + '</div>' +
  '</div>';

  if (!hasNotes) {
    html += '<p style="color:var(--danger);font-weight:600;margin:16px 0">Notes have not been generated yet. Generate notes first, then run this checklist to compare against GAAP requirements.</p>';
  }

  let disclosed: number = 0, missing: number = 0, na: number = 0, warnings: number = 0;

  html += '<table class="stmt-table" style="width:100%"><colgroup><col style="width:30%"><col style="width:15%"><col style="width:55%"></colgroup><tbody>';
  html += '<tr style="font-size:0.78rem;font-weight:600;color:#64748b;border-bottom:2px solid #e1e5eb"><td>GAAP Disclosure Requirement</td><td style="text-align:center">Status</td><td>Details</td></tr>';

  detections.forEach(function(d) {
    let status: string = '';
    let statusClass: string = '';
    let detail: string = '';

    if (!d.detected && !d.required) {
      status = '— N/A';
      statusClass = 'color:#94a3b8';
      detail = 'Not applicable — item not detected on financial statements.';
      na++;
    } else if (d.disclosed) {
      status = '&#10003; Disclosed';
      statusClass = 'color:#16a34a;font-weight:600';
      detail = d.reason;
      disclosed++;
    } else if (d.detected || d.required) {
      if (hasNotes) {
        status = '&#10007; Missing';
        statusClass = 'color:#dc2626;font-weight:600';
        detail = d.reason + ' — disclosure not found in generated notes. Update the Notes questionnaire to address this item.';
        missing++;
      } else {
        status = '&#9888; Pending';
        statusClass = 'color:#d97706;font-weight:600';
        detail = d.reason + ' — generate notes to satisfy this requirement.';
        warnings++;
      }
    }

    html += '<tr class="checklist-item" style="border-bottom:1px solid #f1f5f9">';
    html += '<td style="padding:10px 8px;font-weight:500">';
    html += '<span class="checklist-label">' + d.label + '</span>';
    if (d.asc) {
      html += '<a href="' + d.url + '" target="_blank" rel="noopener" class="asc-ref" title="' + esc(d.guidance) + '">' + esc(d.asc) + '</a>';
    }
    html += '</td>';
    html += '<td style="padding:10px 8px;text-align:center;' + statusClass + '">' + status + '</td>';
    html += '<td style="padding:10px 8px;font-size:0.83rem;color:#475569">' + detail + '</td>';
    html += '</tr>';
  });

  html += '</tbody></table>';

  // Summary bar
  const total: number = detections.filter(function(d) { return d.detected || d.required; }).length;
  html += '<div style="margin-top:24px;padding:16px 20px;background:#f8fafc;border-radius:8px;border:1px solid #e2e8f0;display:flex;gap:24px;flex-wrap:wrap">';
  html += '<div style="font-weight:600;font-size:0.95rem">Summary</div>';
  html += '<div style="color:#16a34a"><strong>' + disclosed + '</strong> Disclosed</div>';
  if (missing > 0) html += '<div style="color:#dc2626"><strong>' + missing + '</strong> Missing</div>';
  if (warnings > 0) html += '<div style="color:#d97706"><strong>' + warnings + '</strong> Pending</div>';
  html += '<div style="color:#94a3b8"><strong>' + na + '</strong> N/A</div>';
  if (total > 0) {
    const pct: number = Math.round((disclosed / total) * 100);
    html += '<div style="margin-left:auto;font-weight:600;font-size:1.1rem;color:' + (pct === 100 ? '#16a34a' : pct >= 70 ? '#d97706' : '#dc2626') + '">' + pct + '% Complete</div>';
  }
  html += '</div>';

  // Add "Fix Missing" button when there are gaps
  if (missing > 0) {
    html += '<div style="margin-top:16px;padding:16px 20px;background:#fef2f2;border:1px solid #fecaca;border-radius:8px">';
    html += '<div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap">';
    html += '<div style="flex:1;min-width:200px">';
    html += '<div style="font-weight:600;color:#991b1b;margin-bottom:4px">' + missing + ' Missing Disclosure' + (missing !== 1 ? 's' : '') + '</div>';
    html += '<div style="font-size:0.83rem;color:#7f1d1d">Auto-generate standard GAAP disclosure language for all missing items and append to your notes. You can review and customize the text afterward.</div>';
    html += '</div>';
    html += '<button class="btn btn-primary" data-action="addMissingDisclosures" style="white-space:nowrap">Add Missing Disclosures to Notes</button>';
    html += '</div></div>';
  }

  const checklistOut = el('checklist-output');
  if (checklistOut) checklistOut.innerHTML = html;
}
