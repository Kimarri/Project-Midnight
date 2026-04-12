/* ═══════════════════════════════════════════════════════════════════════
   NoteFlow — statements.ts
   Financial statement builders (IS, BS, CF, Equity), smart defaults
   ═══════════════════════════════════════════════════════════════════════ */

import { state, type SectionData, type LineItem, type ProjectNotes } from './state';
import {
  prepareStatementData,
  restoreStatementData,
} from './consolidation';
import {
  sum,
  rows,
  hasPriorData,
  computeNetIncome,
  tr,
  sectionHeader,
  columnHeaders,
  stmtHeader,
  esc,
  cur,
  fmt,
  meta,
  el,
} from './utils';
import { collectNotesData, cloudSaveUserData } from './data';

// ─── Types ─────────────────────────────────────────────────────────────────

interface PatternData {
  fieldCounts: Record<string, Record<string, number>>;
  projectCount: number;
  lastTracked?: string;
}

interface SmartDefaults {
  [field: string]: string;
}

interface LineItemRule {
  pattern: RegExp;
  sections: string[];
  field: string;
  title: string;
  msg: string;
}

interface NoteTableRow {
  label: string;
  current: number;
  prior: number;
  isTotal?: boolean;
}

interface MergedItem {
  label: string;
  cur: number;
  prior: number | null;
}

interface NoncashPattern {
  pattern: RegExp;
  label: string;
  negate?: boolean;
}

interface NoncashItem {
  label: string;
  amount: number;
}

interface WorkingCapitalChange {
  label: string;
  amount: number;
}

interface EquityChange {
  label: string;
  amount: number;
}

export interface CashFlowLineItem {
  label: string;
  amount: number;
  priorAmount: number;
}

// ─── Cash Flow Detection Patterns ─────────────────────────────────────────
const ACCUM_DEP_PATTERN: RegExp =
  /accum|accumulated|accum\.?\s*dep|a\/d/i;

const DEBT_PATTERN: RegExp =
  /loan|note.?payable|mortgage|line.?of.?credit|debt|borrowing|bond/i;

const LEASE_LIABILITY_PATTERN: RegExp =
  /lease\s*liab|lease\s*obligation|right.of.use\s*liab|rou\s*liab|finance\s*lease|operating\s*lease\s*liab/i;

const RETAINED_EARNINGS_PATTERN: RegExp =
  /retained\s*earnings|accumulated\s*(deficit|surplus)/i;

// ─── Learning / Pattern Intelligence ───────────────────────────────────────

function loadPatterns(): PatternData {
  try {
    return JSON.parse(
      localStorage.getItem('noteflow-patterns-' + state.currentUserEmail) || 'null'
    ) || { fieldCounts: {}, projectCount: 0 };
  } catch (e) {
    return { fieldCounts: {}, projectCount: 0 };
  }
}

function savePatterns(p: PatternData): void {
  localStorage.setItem(
    'noteflow-patterns-' + state.currentUserEmail,
    JSON.stringify(p)
  );
  cloudSaveUserData('patterns', p);
}

export function trackProjectPatterns(): void {
  const patterns: PatternData = loadPatterns();
  const notes: ProjectNotes = collectNotesData();
  patterns.projectCount = (patterns.projectCount || 0) + 1;
  if (!patterns.fieldCounts) patterns.fieldCounts = {};
  Object.keys(notes).forEach((key: string) => {
    const val = String(notes[key] ?? '');
    if (!val) return;
    if (!patterns.fieldCounts[key]) patterns.fieldCounts[key] = {};
    patterns.fieldCounts[key][val] = (patterns.fieldCounts[key][val] || 0) + 1;
  });
  patterns.lastTracked = new Date().toISOString();
  savePatterns(patterns);
}

function getSmartDefaults(): SmartDefaults {
  const patterns: PatternData = loadPatterns();
  const defaults: SmartDefaults = {};
  if ((patterns.projectCount || 0) < 2) return defaults;
  const fc: Record<string, Record<string, number>> = patterns.fieldCounts || {};
  Object.keys(fc).forEach((field: string) => {
    const counts: Record<string, number> = fc[field];
    const total: number = Object.values(counts).reduce((a: number, b: number) => a + b, 0);
    const entries: [string, number][] = Object.entries(counts).sort(
      (a: [string, number], b: [string, number]) => b[1] - a[1]
    );
    if (entries.length > 0 && entries[0][1] / total >= 0.6) {
      defaults[field] = entries[0][0];
    }
  });
  return defaults;
}

export function applySmartDefaults(): void {
  const defaults: SmartDefaults = getSmartDefaults();
  Object.keys(defaults).forEach((id: string) => {
    const fieldEl = document.getElementById(id) as HTMLInputElement | null;
    if (fieldEl && !fieldEl.value) fieldEl.value = defaults[id];
    const radio = document.querySelector(
      'input[name="' + id + '"]'
    ) as HTMLInputElement | null;
    if (radio) {
      const target = document.querySelector(
        'input[name="' + id + '"][value="' + defaults[id] + '"]'
      ) as HTMLInputElement | null;
      if (target) target.checked = true;
    }
  });
}

// ─── Smart Suggestions ─────────────────────────────────────────────────────

const LINE_ITEM_RULES: LineItemRule[] = [
  {
    pattern: /depreciation/i,
    sections: ['opex', 'noncurrent-assets'],
    field: 'nq-depreciation',
    title: 'Depreciation Policy',
    msg: 'Depreciation expense detected on your statements. Ensure the depreciation method and useful lives are disclosed.',
  },
  {
    pattern: /amortization/i,
    sections: ['opex', 'noncurrent-assets'],
    field: 'nq-intangibles',
    title: 'Intangible Assets',
    msg: 'Amortization detected. Consider disclosing intangible asset details and amortization policy.',
  },
  {
    pattern: /lease|right.of.use|rou/i,
    sections: ['current-liab', 'noncurrent-liab', 'noncurrent-assets'],
    field: 'nq-leases',
    title: 'Lease Disclosures (ASC 842)',
    msg: 'Lease-related items detected on your balance sheet. ASC 842 disclosures are likely required.',
  },
  {
    pattern: /loan|note.?payable|mortgage|line.?of.?credit|debt|borrowing/i,
    sections: ['current-liab', 'noncurrent-liab'],
    field: 'nq-debt',
    title: 'Debt Disclosures',
    msg: 'Debt instruments detected in liabilities. Disclose terms, rates, maturity, and any covenants.',
  },
  {
    pattern: /inventor/i,
    sections: ['current-assets'],
    field: 'nq-inventory',
    title: 'Inventory Valuation',
    msg: 'Inventory detected on balance sheet. Disclose the valuation method (FIFO, weighted average, etc.).',
  },
  {
    pattern: /goodwill|intangible|patent|trademark|copyright|franchise|customer.?list/i,
    sections: ['noncurrent-assets'],
    field: 'nq-intangibles',
    title: 'Intangible Assets / Goodwill',
    msg: 'Intangible assets detected. Disclose amortization policy and impairment testing approach.',
  },
  {
    pattern: /receivable/i,
    sections: ['current-assets'],
    field: 'nq-allowance',
    title: 'Accounts Receivable',
    msg: 'Accounts receivable on balance sheet. Consider disclosing allowance for doubtful accounts methodology.',
  },
];

function generateSuggestions(): LineItemRule[] {
  const suggestions: LineItemRule[] = [];
  const dismissed: string[] = JSON.parse(
    localStorage.getItem('noteflow-dismissed-' + state.currentUserEmail) || '[]'
  );

  LINE_ITEM_RULES.forEach((rule: LineItemRule) => {
    if (dismissed.indexOf(rule.field) >= 0) return;
    let found = false;
    rule.sections.forEach((section: string) => {
      if (
        rows(state.currentData, section).some((r: LineItem) =>
          rule.pattern.test(r.label)
        )
      ) {
        found = true;
      }
    });
    if (!found) return;

    // Check if the user has already addressed this field (select, input/textarea, or radio)
    const ruleEl = document.getElementById(rule.field);
    let addressed = false;
    if (ruleEl) {
      if (ruleEl.tagName === 'SELECT' && (ruleEl as HTMLSelectElement).value) addressed = true;
      if ((ruleEl.tagName === 'TEXTAREA' || ruleEl.tagName === 'INPUT') && (ruleEl as HTMLInputElement).value.trim()) addressed = true;
    }
    const radio = document.querySelector(
      'input[name="' + rule.field + '"]:checked'
    ) as HTMLInputElement | null;
    if (radio && radio.value === 'yes') addressed = true;

    if (!addressed) {
      suggestions.push(rule);
    }
  });

  return suggestions;
}

export function renderSuggestions(): void {
  const suggestions: LineItemRule[] = generateSuggestions();
  const container = document.getElementById('note-suggestions');
  if (!container) return;
  if (suggestions.length === 0) {
    container.style.display = 'none';
    return;
  }
  container.style.display = 'block';
  let html = '';
  suggestions.forEach((s: LineItemRule) => {
    html += '<div class="suggestion-card">';
    html += '<div class="sg-title">' + esc(s.title) + '</div>';
    html += '<div class="sg-text">' + esc(s.msg) + '</div>';
    html += '<div class="sg-actions">';
    html +=
      '<button class="sg-btn" data-action="scrollToNoteField" data-param="' +
      s.field +
      '">Address Now</button>';
    html +=
      '<button class="sg-btn" data-action="dismissSuggestion" data-param="' +
      s.field +
      '">Dismiss</button>';
    html += '</div></div>';
  });
  container.innerHTML = html;
}

export function scrollToNoteField(field: string): void {
  let fieldEl: HTMLElement | null = el(field);
  if (!fieldEl) {
    fieldEl = document.querySelector('input[name="' + field + '"]');
  }
  if (fieldEl) {
    fieldEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    fieldEl.focus();
  }
}

export function dismissSuggestion(field: string): void {
  const dismissed: string[] = JSON.parse(
    localStorage.getItem('noteflow-dismissed-' + state.currentUserEmail) || '[]'
  );
  if (dismissed.indexOf(field) === -1) dismissed.push(field);
  localStorage.setItem(
    'noteflow-dismissed-' + state.currentUserEmail,
    JSON.stringify(dismissed)
  );
  cloudSaveUserData('dismissed', dismissed);
  renderSuggestions();
}

// ─── Comparative Note Table Builder ────────────────────────────────────────

function buildNoteTable(tableRows: NoteTableRow[]): string {
  const m = meta();
  const c: string = cur();
  const multi: boolean = hasPriorData();
  let html = '<table class="note-table">';
  html +=
    '<thead><tr><th></th><th>' + esc(m.period || 'Current') + '</th>';
  if (multi) html += '<th>' + esc(m.priorPeriod || 'Prior') + '</th>';
  html += '</tr></thead><tbody>';
  tableRows.forEach((r: NoteTableRow) => {
    const cls: string = r.isTotal ? 'nt-total' : '';
    html += '<tr class="' + cls + '">';
    html += '<td>' + esc(r.label) + '</td>';
    html += '<td>' + c + fmt(r.current) + '</td>';
    if (multi) html += '<td>' + c + fmt(r.prior) + '</td>';
    html += '</tr>';
  });
  html += '</tbody></table>';
  return html;
}

export function buildComparativeSection(
  sectionKey: string,
  labelFilter?: RegExp
): string {
  const multi: boolean = hasPriorData();
  let curItems: LineItem[] = rows(state.currentData, sectionKey);
  if (labelFilter)
    curItems = curItems.filter((r: LineItem) => labelFilter.test(r.label));
  if (curItems.length === 0) return '';

  const tableRows: NoteTableRow[] = [];
  let curTotal = 0;
  let priorTotal = 0;
  curItems.forEach((r: LineItem) => {
    const amt: number = parseFloat(String(r.amount)) || 0;
    curTotal += amt;
    let priorAmt = 0;
    if (multi) {
      let priorItems: LineItem[] = rows(state.priorData, sectionKey);
      if (labelFilter)
        priorItems = priorItems.filter((p: LineItem) =>
          labelFilter.test(p.label)
        );
      const match: LineItem | undefined = priorItems.find(
        (p: LineItem) => p.label === r.label
      );
      if (match) priorAmt = parseFloat(String(match.amount)) || 0;
    }
    priorTotal += priorAmt;
    tableRows.push({ label: r.label, current: amt, prior: priorAmt });
  });

  if (multi) {
    let priorItems: LineItem[] = rows(state.priorData, sectionKey);
    if (labelFilter)
      priorItems = priorItems.filter((p: LineItem) =>
        labelFilter.test(p.label)
      );
    priorItems.forEach((p: LineItem) => {
      if (!curItems.find((c: LineItem) => c.label === p.label)) {
        const amt: number = parseFloat(String(p.amount)) || 0;
        priorTotal += amt;
        tableRows.push({ label: p.label, current: 0, prior: amt });
      }
    });
  }

  tableRows.push({
    label: 'Total',
    current: curTotal,
    prior: priorTotal,
    isTotal: true,
  });
  return buildNoteTable(tableRows);
}

// ─── Income Statement ───────────────────────────────────────────────────────

/**
 * Builds the income statement HTML table from current/prior period data
 * and renders it to the DOM.
 */
export function buildIncomeStatement(): void {
  prepareStatementData();
  try {
  const multi: boolean = hasPriorData();
  const totalRevenue: number = sum(state.currentData, 'revenue');
  const totalCOGS: number = sum(state.currentData, 'cogs');
  const grossProfit: number = totalRevenue - totalCOGS;
  const totalOpex: number = sum(state.currentData, 'opex');
  const operatingIncome: number = grossProfit - totalOpex;
  const totalOther: number = sum(state.currentData, 'other');
  const netIncome: number = operatingIncome + totalOther;

  let pTotalRevenue = 0;
  let pTotalCOGS = 0;
  let pGrossProfit = 0;
  let pTotalOpex = 0;
  let pOperatingIncome = 0;
  let pTotalOther = 0;
  let pNetIncome = 0;
  if (multi) {
    pTotalRevenue = sum(state.priorData, 'revenue');
    pTotalCOGS = sum(state.priorData, 'cogs');
    pGrossProfit = pTotalRevenue - pTotalCOGS;
    pTotalOpex = sum(state.priorData, 'opex');
    pOperatingIncome = pGrossProfit - pTotalOpex;
    pTotalOther = sum(state.priorData, 'other');
    pNetIncome = pOperatingIncome + pTotalOther;
  }

  let html: string = stmtHeader('Income Statement');
  const tableClass: string = multi ? 'stmt-table multi-period' : 'stmt-table';
  if (multi) {
    html +=
      '<table class="' +
      tableClass +
      '"><colgroup><col class="col-label"><col class="col-current"><col class="col-prior"></colgroup><tbody>';
  } else {
    html +=
      '<table class="' +
      tableClass +
      '"><colgroup><col class="col-label"><col class="col-amount"><col class="col-total"></colgroup><tbody>';
  }
  html += columnHeaders(multi);

  // Revenue
  html += sectionHeader('Revenue', multi);
  const revRows: LineItem[] = rows(state.currentData, 'revenue');
  const pRevRows: LineItem[] = multi ? rows(state.priorData, 'revenue') : [];
  const allRevLabels: MergedItem[] = mergeLabels(revRows, pRevRows, multi);
  allRevLabels.forEach((item: MergedItem) => {
    html += tr({ label: item.label, indent: true, currentAmt: item.cur, priorAmt: item.prior, isTotal: false, cls: '', multi });
  });
  html += tr({ label: 'Total Revenue', indent: false, currentAmt: totalRevenue, priorAmt: multi ? pTotalRevenue : null, isTotal: false, cls: '', multi });

  // COGS
  html += sectionHeader('Cost of Goods Sold', multi);
  const cogsRows: LineItem[] = rows(state.currentData, 'cogs');
  const pCogsRows: LineItem[] = multi ? rows(state.priorData, 'cogs') : [];
  const allCogsLabels: MergedItem[] = mergeLabels(cogsRows, pCogsRows, multi);
  allCogsLabels.forEach((item: MergedItem) => {
    html += tr({ label: item.label, indent: true, currentAmt: item.cur, priorAmt: item.prior, isTotal: false, cls: '', multi });
  });
  html += tr({ label: 'Total Cost of Goods Sold', indent: false, currentAmt: totalCOGS, priorAmt: multi ? pTotalCOGS : null, isTotal: false, cls: '', multi });

  html += tr({ label: 'Gross Profit', indent: false, currentAmt: grossProfit, priorAmt: multi ? pGrossProfit : null, isTotal: true, cls: '', multi });

  // OpEx
  html += sectionHeader('Operating Expenses', multi);
  const opexRows: LineItem[] = rows(state.currentData, 'opex');
  const pOpexRows: LineItem[] = multi ? rows(state.priorData, 'opex') : [];
  const allOpexLabels: MergedItem[] = mergeLabels(opexRows, pOpexRows, multi);
  allOpexLabels.forEach((item: MergedItem) => {
    html += tr({ label: item.label, indent: true, currentAmt: item.cur, priorAmt: item.prior, isTotal: false, cls: '', multi });
  });
  html += tr({ label: 'Total Operating Expenses', indent: false, currentAmt: totalOpex, priorAmt: multi ? pTotalOpex : null, isTotal: false, cls: '', multi });

  html += tr({ label: 'Operating Income', indent: false, currentAmt: operatingIncome, priorAmt: multi ? pOperatingIncome : null, isTotal: true, cls: '', multi });

  // Other
  if (
    rows(state.currentData, 'other').length ||
    (multi && rows(state.priorData, 'other').length)
  ) {
    html += sectionHeader('Other Income / (Expense)', multi);
    const otherRows: LineItem[] = rows(state.currentData, 'other');
    const pOtherRows: LineItem[] = multi ? rows(state.priorData, 'other') : [];
    const allOtherLabels: MergedItem[] = mergeLabels(otherRows, pOtherRows, multi);
    allOtherLabels.forEach((item: MergedItem) => {
      html += tr({ label: item.label, indent: true, currentAmt: item.cur, priorAmt: item.prior, isTotal: false, cls: '', multi });
    });
    html += tr({ label: 'Total Other Income / (Expense)', indent: false, currentAmt: totalOther, priorAmt: multi ? pTotalOther : null, isTotal: false, cls: '', multi });
  }

  html += tr({ label: 'Net Income', indent: false, currentAmt: netIncome, priorAmt: multi ? pNetIncome : null, isTotal: true, cls: '', multi });

  html += '</tbody></table>';
  const incomeEl = el('income-statement');
  if (incomeEl) incomeEl.innerHTML = html;
  } finally { restoreStatementData(); }
}

// Helper to merge current and prior row labels for multi-period display
export function mergeLabels(
  curRows: LineItem[],
  priorRows: LineItem[],
  multi: boolean
): MergedItem[] {
  if (!multi) {
    return curRows.map((r: LineItem) => ({
      label: r.label,
      cur: parseFloat(String(r.amount)) || 0,
      prior: null,
    }));
  }
  const map = new Map<string, MergedItem>();
  curRows.forEach((r: LineItem) => {
    map.set(r.label, {
      label: r.label,
      cur: parseFloat(String(r.amount)) || 0,
      prior: 0,
    });
  });
  priorRows.forEach((r: LineItem) => {
    if (map.has(r.label)) {
      map.get(r.label)!.prior = parseFloat(String(r.amount)) || 0;
    } else {
      map.set(r.label, {
        label: r.label,
        cur: 0,
        prior: parseFloat(String(r.amount)) || 0,
      });
    }
  });
  return Array.from(map.values());
}

// ─── Balance Sheet ──────────────────────────────────────────────────────────

/**
 * Builds the balance sheet HTML table with assets, liabilities, and equity sections.
 */
export function buildBalanceSheet(): void {
  prepareStatementData();
  try {
  const multi: boolean = hasPriorData();

  const totalCA: number = sum(state.currentData, 'current-assets');
  const totalNCA: number = sum(state.currentData, 'noncurrent-assets');
  const totalAssets: number = totalCA + totalNCA;
  const totalCL: number = sum(state.currentData, 'current-liab');
  const totalNCL: number = sum(state.currentData, 'noncurrent-liab');
  const totalLiab: number = totalCL + totalNCL;
  const netIncomeCur: number = computeNetIncome(state.currentData);
  const totalEquity: number = sum(state.currentData, 'equity') + netIncomeCur;
  const totalLiabEquity: number = totalLiab + totalEquity;

  let pTotalCA = 0;
  let pTotalNCA = 0;
  let pTotalAssets = 0;
  let pTotalCL = 0;
  let pTotalNCL = 0;
  let pTotalLiab = 0;
  let pTotalEquity = 0;
  let pTotalLiabEquity = 0;
  let pNetIncomeCur = 0;
  if (multi) {
    pTotalCA = sum(state.priorData, 'current-assets');
    pTotalNCA = sum(state.priorData, 'noncurrent-assets');
    pTotalAssets = pTotalCA + pTotalNCA;
    pTotalCL = sum(state.priorData, 'current-liab');
    pTotalNCL = sum(state.priorData, 'noncurrent-liab');
    pTotalLiab = pTotalCL + pTotalNCL;
    pNetIncomeCur = computeNetIncome(state.priorData);
    pTotalEquity = sum(state.priorData, 'equity') + pNetIncomeCur;
    pTotalLiabEquity = pTotalLiab + pTotalEquity;
  }

  let html: string = stmtHeader('Balance Sheet');
  const tableClass: string = multi ? 'stmt-table multi-period' : 'stmt-table';
  if (multi) {
    html +=
      '<table class="' +
      tableClass +
      '"><colgroup><col class="col-label"><col class="col-current"><col class="col-prior"></colgroup><tbody>';
  } else {
    html +=
      '<table class="' +
      tableClass +
      '"><colgroup><col class="col-label"><col class="col-amount"><col class="col-total"></colgroup><tbody>';
  }
  html += columnHeaders(multi);

  html += sectionHeader('ASSETS', multi);
  html += sectionHeader('Current Assets', multi);
  const caItems: MergedItem[] = mergeLabels(
    rows(state.currentData, 'current-assets'),
    multi ? rows(state.priorData, 'current-assets') : [],
    multi
  );
  caItems.forEach((item: MergedItem) => {
    html += tr({ label: item.label, indent: true, currentAmt: item.cur, priorAmt: item.prior, isTotal: false, cls: '', multi });
  });
  html += tr({ label: 'Total Current Assets', indent: false, currentAmt: totalCA, priorAmt: multi ? pTotalCA : null, isTotal: false, cls: '', multi });

  html += sectionHeader('Non-Current Assets', multi);
  const ncaItems: MergedItem[] = mergeLabels(
    rows(state.currentData, 'noncurrent-assets'),
    multi ? rows(state.priorData, 'noncurrent-assets') : [],
    multi
  );
  ncaItems.forEach((item: MergedItem) => {
    html += tr({ label: item.label, indent: true, currentAmt: item.cur, priorAmt: item.prior, isTotal: false, cls: '', multi });
  });
  html += tr({ label: 'Total Non-Current Assets', indent: false, currentAmt: totalNCA, priorAmt: multi ? pTotalNCA : null, isTotal: false, cls: '', multi });
  html += tr({ label: 'TOTAL ASSETS', indent: false, currentAmt: totalAssets, priorAmt: multi ? pTotalAssets : null, isTotal: true, cls: '', multi });

  html += sectionHeader('LIABILITIES & EQUITY', multi);
  html += sectionHeader('Current Liabilities', multi);
  const clItems: MergedItem[] = mergeLabels(
    rows(state.currentData, 'current-liab'),
    multi ? rows(state.priorData, 'current-liab') : [],
    multi
  );
  clItems.forEach((item: MergedItem) => {
    html += tr({ label: item.label, indent: true, currentAmt: item.cur, priorAmt: item.prior, isTotal: false, cls: '', multi });
  });
  html += tr({ label: 'Total Current Liabilities', indent: false, currentAmt: totalCL, priorAmt: multi ? pTotalCL : null, isTotal: false, cls: '', multi });

  html += sectionHeader('Non-Current Liabilities', multi);
  const nclItems: MergedItem[] = mergeLabels(
    rows(state.currentData, 'noncurrent-liab'),
    multi ? rows(state.priorData, 'noncurrent-liab') : [],
    multi
  );
  nclItems.forEach((item: MergedItem) => {
    html += tr({ label: item.label, indent: true, currentAmt: item.cur, priorAmt: item.prior, isTotal: false, cls: '', multi });
  });
  html += tr({ label: 'Total Non-Current Liabilities', indent: false, currentAmt: totalNCL, priorAmt: multi ? pTotalNCL : null, isTotal: false, cls: '', multi });
  html += tr({ label: 'Total Liabilities', indent: false, currentAmt: totalLiab, priorAmt: multi ? pTotalLiab : null, isTotal: false, cls: '', multi });

  html += sectionHeader("Shareholders' Equity", multi);
  const eqItems: MergedItem[] = mergeLabels(
    rows(state.currentData, 'equity'),
    multi ? rows(state.priorData, 'equity') : [],
    multi
  );
  eqItems.forEach((item: MergedItem) => {
    html += tr({ label: item.label, indent: true, currentAmt: item.cur, priorAmt: item.prior, isTotal: false, cls: '', multi });
  });
  html += tr({ label: 'Net Income', indent: true, currentAmt: netIncomeCur, priorAmt: multi ? pNetIncomeCur : null, isTotal: false, cls: '', multi });
  html += tr({ label: 'Total Equity', indent: false, currentAmt: totalEquity, priorAmt: multi ? pTotalEquity : null, isTotal: false, cls: '', multi });

  html += tr({ label: 'TOTAL LIABILITIES & EQUITY', indent: false, currentAmt: totalLiabEquity, priorAmt: multi ? pTotalLiabEquity : null, isTotal: true, cls: '', multi });

  const diff: number = totalAssets - totalLiabEquity;
  const cols: number = multi ? 5 : 3;
  if (Math.abs(diff) > 0.01) {
    html +=
      '<tr><td colspan="' +
      cols +
      '" style="padding:12px 8px;font-size:0.8rem;color:var(--red)">' +
      'Warning: Balance sheet does not balance by ' +
      cur() +
      fmt(Math.abs(diff)) +
      '. Check your entries.' +
      '</td></tr>';
  } else {
    html +=
      '<tr><td colspan="' +
      cols +
      '" style="padding:12px 8px;font-size:0.8rem;color:var(--green)">' +
      'Balance sheet balances.' +
      '</td></tr>';
  }

  html += '</tbody></table>';
  const balanceEl = el('balance-statement');
  if (balanceEl) balanceEl.innerHTML = html;
  } finally { restoreStatementData(); }
}

// ─── Cash Flow Intelligence ────────────────────────────────────────────────

const NONCASH_PATTERNS: NoncashPattern[] = [
  { pattern: /depreciation/i, label: 'Depreciation' },
  { pattern: /amortization/i, label: 'Amortization' },
  {
    pattern: /bad\s*debt|doubtful|allowance\s*expense|provision\s*for/i,
    label: 'Bad Debt Expense',
  },
  {
    pattern: /loss\s*on\s*(disposal|sale|write.?off|abandon)/i,
    label: 'Loss on Disposal of Assets',
  },
  {
    pattern: /gain\s*on\s*(disposal|sale)/i,
    label: 'Gain on Disposal of Assets',
    negate: true,
  },
  {
    pattern: /stock.based\s*comp|share.based\s*comp/i,
    label: 'Stock-Based Compensation',
  },
  {
    pattern: /deferred\s*(tax|income\s*tax)/i,
    label: 'Deferred Income Tax',
  },
  { pattern: /impairment/i, label: 'Impairment Loss' },
  { pattern: /unrealized\s*(gain|loss)/i, label: 'Unrealized Gain/Loss' },
  {
    pattern: /accretion|discount\s*amort/i,
    label: 'Accretion / Discount Amortization',
  },
];

const CASH_SKIP_PATTERN: RegExp =
  /^cash$|^cash\s|^bank|^checking|^savings|cash\s*equiv|money\s*market|petty\s*cash/i;

export function findNoncashItems(
  dataObj: SectionData,
  manualLabels?: string[]
): NoncashItem[] {
  const items: NoncashItem[] = [];
  const seen = new Set<string>();
  (['opex', 'noncurrent-assets', 'other'] as const).forEach((section: string) => {
    rows(dataObj, section).forEach((row: LineItem) => {
      NONCASH_PATTERNS.forEach((rule: NoncashPattern) => {
        if (rule.pattern.test(row.label) && !seen.has(rule.label)) {
          // Skip if already manually mapped to cf-operating
          const isDuplicate: boolean =
            !!manualLabels &&
            manualLabels.some((ml: string) => rule.pattern.test(ml));
          if (isDuplicate) return;
          seen.add(rule.label);
          const amt: number = parseFloat(String(row.amount)) || 0;
          // Non-cash expenses are added back (positive); gains are subtracted (negative)
          if (rule.negate) {
            items.push({ label: row.label, amount: -Math.abs(amt) });
          } else {
            items.push({ label: row.label, amount: Math.abs(amt) });
          }
        }
      });
    });
  });
  return items;
}

export function computeWorkingCapitalChanges(
  curData: SectionData,
  priorDataObj: SectionData
): WorkingCapitalChange[] {
  const changes: WorkingCapitalChange[] = [];

  // Current assets: decrease = cash inflow (+), increase = cash outflow (-)
  const curCA: LineItem[] = rows(curData, 'current-assets');
  const priorCA: LineItem[] = rows(priorDataObj, 'current-assets');
  const caItems: MergedItem[] = mergeLabels(curCA, priorCA, true);
  caItems.forEach((item: MergedItem) => {
    if (CASH_SKIP_PATTERN.test(item.label)) return;
    const curAmt: number = item.cur || 0;
    const priorAmt: number = (item.prior as number) || 0;
    const change: number = priorAmt - curAmt; // decrease in asset = positive CF
    if (Math.abs(change) > 0.005) {
      const direction: string = change > 0 ? 'Decrease' : 'Increase';
      changes.push({
        label: direction + ' in ' + item.label,
        amount: parseFloat(change.toFixed(2)),
      });
    }
  });

  // Current liabilities: increase = cash inflow (+), decrease = cash outflow (-)
  // Liabilities stored as negative (credit-normal via SECTION_SIGN = -1)
  const curCL: LineItem[] = rows(curData, 'current-liab');
  const priorCL: LineItem[] = rows(priorDataObj, 'current-liab');
  const clItems: MergedItem[] = mergeLabels(curCL, priorCL, true);
  clItems.forEach((item: MergedItem) => {
    // Skip debt-related current liabilities — handled in financing activities
    if (DEBT_PATTERN.test(item.label)) return;
    const curAmt: number = Math.abs(item.cur || 0);
    const priorAmt: number = Math.abs((item.prior as number) || 0);
    const change: number = curAmt - priorAmt; // increase in absolute liability = positive CF
    if (Math.abs(change) > 0.005) {
      const direction: string = change > 0 ? 'Increase' : 'Decrease';
      changes.push({
        label: direction + ' in ' + item.label,
        amount: parseFloat(change.toFixed(2)),
      });
    }
  });

  return changes;
}

// ─── Cash Flow Auto-Detection (Investing & Financing) ────────────────────

/**
 * Detects investing activities by comparing noncurrent-asset accounts
 * between current and prior periods. Excludes accumulated depreciation
 * accounts (handled as non-cash in operating).
 */
export function detectInvestingActivities(
  curData: SectionData,
  priorDataObj: SectionData
): CashFlowLineItem[] {
  const items: CashFlowLineItem[] = [];
  const curRows_: LineItem[] = rows(curData, 'noncurrent-assets');
  const priorRows_: LineItem[] = rows(priorDataObj, 'noncurrent-assets');
  const merged: MergedItem[] = mergeLabels(curRows_, priorRows_, true);

  merged.forEach((item: MergedItem) => {
    // Skip accumulated depreciation/amortization — handled in operating
    if (ACCUM_DEP_PATTERN.test(item.label)) return;

    const curAmt: number = item.cur || 0;
    const priorAmt: number = (item.prior as number) || 0;
    const delta: number = curAmt - priorAmt;

    if (Math.abs(delta) < 0.005) return;

    if (delta > 0) {
      // Asset increased → purchase (cash outflow = negative)
      items.push({
        label: 'Purchase of ' + item.label,
        amount: -delta,
        priorAmount: 0,
      });
    } else {
      // Asset decreased → disposal (cash inflow = positive)
      items.push({
        label: 'Proceeds from sale of ' + item.label,
        amount: -delta, // delta is negative, so -delta is positive
        priorAmount: 0,
      });
    }
  });

  // Check for gain/loss on sale in 'other' section for context
  // (The gain/loss itself is already handled as a non-cash adjustment in operating;
  //  the investing section shows the gross proceeds)

  return items;
}

/**
 * Detects financing activities by comparing noncurrent-liab and equity accounts
 * between current and prior periods.
 */
export function detectFinancingActivities(
  curData: SectionData,
  priorDataObj: SectionData
): CashFlowLineItem[] {
  const items: CashFlowLineItem[] = [];

  // ── Noncurrent liabilities: debt proceeds/repayments and lease payments ──
  const curNCL: LineItem[] = rows(curData, 'noncurrent-liab');
  const priorNCL: LineItem[] = rows(priorDataObj, 'noncurrent-liab');
  const nclMerged: MergedItem[] = mergeLabels(curNCL, priorNCL, true);

  nclMerged.forEach((item: MergedItem) => {
    const curAmt: number = Math.abs(item.cur || 0);
    const priorAmt: number = Math.abs((item.prior as number) || 0);
    const delta: number = curAmt - priorAmt;

    if (Math.abs(delta) < 0.005) return;

    if (DEBT_PATTERN.test(item.label)) {
      if (delta > 0) {
        items.push({ label: 'Proceeds from ' + item.label, amount: delta, priorAmount: 0 });
      } else {
        items.push({ label: 'Repayment of ' + item.label, amount: delta, priorAmount: 0 });
      }
    } else if (LEASE_LIABILITY_PATTERN.test(item.label)) {
      // Lease liability decrease = lease payment (outflow)
      if (delta < 0) {
        items.push({ label: 'Lease payments on ' + item.label, amount: delta, priorAmount: 0 });
      } else {
        items.push({ label: 'Increase in ' + item.label, amount: delta, priorAmount: 0 });
      }
    }
  });

  // ── Current portion of long-term debt ──
  const curCL: LineItem[] = rows(curData, 'current-liab');
  const priorCL: LineItem[] = rows(priorDataObj, 'current-liab');
  const clMerged: MergedItem[] = mergeLabels(curCL, priorCL, true);

  clMerged.forEach((item: MergedItem) => {
    if (!DEBT_PATTERN.test(item.label)) return;

    const curAmt: number = Math.abs(item.cur || 0);
    const priorAmt: number = Math.abs((item.prior as number) || 0);
    const delta: number = curAmt - priorAmt;

    if (Math.abs(delta) < 0.005) return;

    if (delta > 0) {
      items.push({ label: 'Proceeds from ' + item.label, amount: delta, priorAmount: 0 });
    } else {
      items.push({ label: 'Repayment of ' + item.label, amount: delta, priorAmount: 0 });
    }
  });

  // ── Equity changes (exclude Retained Earnings) ──
  const curEq: LineItem[] = rows(curData, 'equity');
  const priorEq: LineItem[] = rows(priorDataObj, 'equity');
  const eqMerged: MergedItem[] = mergeLabels(curEq, priorEq, true);

  eqMerged.forEach((item: MergedItem) => {
    if (RETAINED_EARNINGS_PATTERN.test(item.label)) return;

    const curAmt: number = item.cur || 0;
    const priorAmt: number = (item.prior as number) || 0;
    const delta: number = curAmt - priorAmt;

    if (Math.abs(delta) < 0.005) return;

    if (delta > 0) {
      items.push({ label: 'Issuance of ' + item.label, amount: delta, priorAmount: 0 });
    } else {
      items.push({ label: 'Repurchase of ' + item.label, amount: delta, priorAmount: 0 });
    }
  });

  return items;
}

// ─── Cash Flow (Indirect Method) ───────────────────────────────────────────

/**
 * Builds the statement of cash flows using the indirect method,
 * starting from net income.
 */
export function buildCashFlow(): void {
  prepareStatementData();
  try {
  const multi: boolean = hasPriorData();
  const netIncome: number = computeNetIncome(state.currentData);
  const pNetIncome: number = multi ? computeNetIncome(state.priorData) : 0;

  // Get manual cf-operating labels for deduplication
  const manualOpLabels: string[] = rows(state.currentData, 'cf-operating').map(
    (r: LineItem) => r.label
  );
  const pManualOpLabels: string[] = multi
    ? rows(state.priorData, 'cf-operating').map((r: LineItem) => r.label)
    : [];

  // Auto-detect non-cash items
  const noncashItems: NoncashItem[] = findNoncashItems(
    state.currentData,
    manualOpLabels
  );
  const pNoncashItems: NoncashItem[] = multi
    ? findNoncashItems(state.priorData, pManualOpLabels)
    : [];

  // Working capital changes (only when prior data exists)
  const wcChanges: WorkingCapitalChange[] = multi
    ? computeWorkingCapitalChanges(state.currentData, state.priorData)
    : [];

  // Manual operating items
  const manualOpItems: MergedItem[] = mergeLabels(
    rows(state.currentData, 'cf-operating'),
    multi ? rows(state.priorData, 'cf-operating') : [],
    multi
  );

  // Calculate totals
  const autoNoncashTotal: number = noncashItems.reduce(
    (s: number, i: NoncashItem) => s + i.amount,
    0
  );
  const pAutoNoncashTotal: number = pNoncashItems.reduce(
    (s: number, i: NoncashItem) => s + i.amount,
    0
  );
  const wcTotal: number = wcChanges.reduce(
    (s: number, i: WorkingCapitalChange) => s + i.amount,
    0
  );
  const manualOpTotal: number = sum(state.currentData, 'cf-operating');
  const pManualOpTotal: number = multi
    ? sum(state.priorData, 'cf-operating')
    : 0;

  const totalOp: number =
    netIncome + autoNoncashTotal + wcTotal + manualOpTotal;
  const pTotalOp: number = multi
    ? pNetIncome + pAutoNoncashTotal + pManualOpTotal
    : 0;

  // Auto-detect investing/financing activities (only with prior data)
  const autoInvItems: CashFlowLineItem[] = multi
    ? detectInvestingActivities(state.currentData, state.priorData)
    : [];
  const autoFinItems: CashFlowLineItem[] = multi
    ? detectFinancingActivities(state.currentData, state.priorData)
    : [];

  // Manual investing/financing items
  const manualInvItems: MergedItem[] = mergeLabels(
    rows(state.currentData, 'cf-investing'),
    multi ? rows(state.priorData, 'cf-investing') : [],
    multi
  );
  const manualFinItems: MergedItem[] = mergeLabels(
    rows(state.currentData, 'cf-financing'),
    multi ? rows(state.priorData, 'cf-financing') : [],
    multi
  );

  const autoInvTotal: number = autoInvItems.reduce(
    (s: number, i: CashFlowLineItem) => s + i.amount, 0
  );
  const autoFinTotal: number = autoFinItems.reduce(
    (s: number, i: CashFlowLineItem) => s + i.amount, 0
  );
  const manualInvTotal: number = sum(state.currentData, 'cf-investing');
  const manualFinTotal: number = sum(state.currentData, 'cf-financing');
  const pManualInvTotal: number = multi ? sum(state.priorData, 'cf-investing') : 0;
  const pManualFinTotal: number = multi ? sum(state.priorData, 'cf-financing') : 0;

  const totalInv: number = autoInvTotal + manualInvTotal;
  const totalFin: number = autoFinTotal + manualFinTotal;
  const pTotalInv: number = pManualInvTotal;
  const pTotalFin: number = pManualFinTotal;

  const netChange: number = totalOp + totalInv + totalFin;
  const pNetChange: number = multi ? pTotalOp + pTotalInv + pTotalFin : 0;

  let html: string = stmtHeader('Statement of Cash Flows');
  const tableClass: string = multi ? 'stmt-table multi-period' : 'stmt-table';
  if (multi) {
    html +=
      '<table class="' +
      tableClass +
      '"><colgroup><col class="col-label"><col class="col-current"><col class="col-prior"></colgroup><tbody>';
  } else {
    html +=
      '<table class="' +
      tableClass +
      '"><colgroup><col class="col-label"><col class="col-amount"><col class="col-total"></colgroup><tbody>';
  }
  html += columnHeaders(multi);

  // -- OPERATING ACTIVITIES (Indirect Method) --
  html += sectionHeader('Cash Flows from Operating Activities', multi);
  html += tr({ label: 'Net Income', indent: true, currentAmt: netIncome, priorAmt: multi ? pNetIncome : null, isTotal: false, cls: '', multi });

  // Non-cash adjustments
  if (noncashItems.length > 0 || (multi && pNoncashItems.length > 0)) {
    html +=
      '<tr class="section-header" style="padding-top:6px"><td colspan="3" style="font-size:0.78rem;font-style:italic;color:var(--muted)">Adjustments for non-cash items:</td></tr>';
    // Merge current and prior non-cash items for multi-period alignment
    if (multi) {
      const allNoncash: MergedItem[] = mergeLabels(
        noncashItems.map((i: NoncashItem) => ({
          label: i.label,
          amount: i.amount,
        })),
        pNoncashItems.map((i: NoncashItem) => ({
          label: i.label,
          amount: i.amount,
        })),
        true
      );
      allNoncash.forEach((item: MergedItem) => {
        html += tr({ label: item.label, indent: true, currentAmt: item.cur, priorAmt: item.prior, isTotal: false, cls: '', multi });
      });
    } else {
      noncashItems.forEach((item: NoncashItem) => {
        html += tr({ label: item.label, indent: true, currentAmt: item.amount, priorAmt: null, isTotal: false, cls: '', multi });
      });
    }
  }

  // Working capital changes
  if (wcChanges.length > 0) {
    html +=
      '<tr class="section-header" style="padding-top:6px"><td colspan="3" style="font-size:0.78rem;font-style:italic;color:var(--muted)">Changes in operating assets and liabilities:</td></tr>';
    wcChanges.forEach((item: WorkingCapitalChange) => {
      html += tr({ label: item.label, indent: true, currentAmt: item.amount, priorAmt: null, isTotal: false, cls: '', multi });
    });
  }

  // Manual operating items (if any)
  if (manualOpItems.length > 0) {
    html +=
      '<tr class="section-header" style="padding-top:6px"><td colspan="3" style="font-size:0.78rem;font-style:italic;color:var(--muted)">Other operating adjustments:</td></tr>';
    manualOpItems.forEach((item: MergedItem) => {
      html += tr({ label: item.label, indent: true, currentAmt: item.cur, priorAmt: item.prior, isTotal: false, cls: '', multi });
    });
  }

  html += tr({ label: 'Net Cash from Operating Activities', indent: false, currentAmt: totalOp, priorAmt: multi ? pTotalOp : null, isTotal: false, cls: '', multi });

  // -- INVESTING ACTIVITIES --
  html += sectionHeader('Cash Flows from Investing Activities', multi);
  const hasInvItems: boolean = autoInvItems.length > 0 || manualInvItems.length > 0;
  if (hasInvItems) {
    autoInvItems.forEach((item: CashFlowLineItem) => {
      html += tr({ label: item.label, indent: true, currentAmt: item.amount, priorAmt: multi ? item.priorAmount : null, isTotal: false, cls: '', multi });
    });
    manualInvItems.forEach((item: MergedItem) => {
      html += tr({ label: item.label, indent: true, currentAmt: item.cur, priorAmt: item.prior, isTotal: false, cls: '', multi });
    });
  } else {
    html +=
      '<tr class="item"><td class="col-label" style="padding-left:20px;font-style:italic;color:var(--muted)">None</td><td></td>' +
      (multi ? '' : '<td></td>') +
      '</tr>';
  }
  html += tr({ label: 'Net Cash from Investing Activities', indent: false, currentAmt: totalInv, priorAmt: multi ? pTotalInv : null, isTotal: false, cls: '', multi });

  // -- FINANCING ACTIVITIES --
  html += sectionHeader('Cash Flows from Financing Activities', multi);
  const hasFinItems: boolean = autoFinItems.length > 0 || manualFinItems.length > 0;
  if (hasFinItems) {
    autoFinItems.forEach((item: CashFlowLineItem) => {
      html += tr({ label: item.label, indent: true, currentAmt: item.amount, priorAmt: multi ? item.priorAmount : null, isTotal: false, cls: '', multi });
    });
    manualFinItems.forEach((item: MergedItem) => {
      html += tr({ label: item.label, indent: true, currentAmt: item.cur, priorAmt: item.prior, isTotal: false, cls: '', multi });
    });
  } else {
    html +=
      '<tr class="item"><td class="col-label" style="padding-left:20px;font-style:italic;color:var(--muted)">None</td><td></td>' +
      (multi ? '' : '<td></td>') +
      '</tr>';
  }
  html += tr({ label: 'Net Cash from Financing Activities', indent: false, currentAmt: totalFin, priorAmt: multi ? pTotalFin : null, isTotal: false, cls: '', multi });

  html += tr({ label: 'Net Change in Cash', indent: false, currentAmt: netChange, priorAmt: multi ? pNetChange : null, isTotal: true, cls: '', multi });

  html += '</tbody></table>';
  const cashflowEl = el('cashflow-statement');
  if (cashflowEl) cashflowEl.innerHTML = html;
  } finally { restoreStatementData(); }
}

// ─── Statement of Stockholders' Equity ─────────────────────────────────────

/**
 * Builds the statement of stockholders' equity showing changes
 * in equity components.
 */
export function buildEquityStatement(): void {
  prepareStatementData();
  try {
  const multi: boolean = hasPriorData();
  const netIncome: number = computeNetIncome(state.currentData);
  const totalEquity: number = sum(state.currentData, 'equity') + netIncome;
  const pTotalEquity: number = multi ? sum(state.priorData, 'equity') : 0;
  const pNetIncome: number = multi ? computeNetIncome(state.priorData) : 0;
  const pTotalEquityWithNI: number = pTotalEquity + pNetIncome;

  // Beginning balance for current period = prior period ending equity (including NI)
  const beginBal: number = pTotalEquityWithNI;
  // Beginning balance for prior period = 0 (unknown)
  const pBeginBal: number = 0;

  // Determine title based on entity type
  const entityEl = document.getElementById('nq-entity-type') as HTMLSelectElement | null;
  const entityType: string = entityEl ? entityEl.value : '';
  const eqTitle: string =
    entityType &&
    (entityType.indexOf('LLC') >= 0 ||
      entityType.indexOf('Partnership') >= 0)
      ? "Statement of Changes in Members' Equity"
      : "Statement of Stockholders' Equity";

  let html: string = stmtHeader(eqTitle);
  const tableClass: string = multi ? 'stmt-table multi-period' : 'stmt-table';
  if (multi) {
    html +=
      '<table class="' +
      tableClass +
      '"><colgroup><col class="col-label"><col class="col-current"><col class="col-prior"></colgroup><tbody>';
  } else {
    html +=
      '<table class="' +
      tableClass +
      '"><colgroup><col class="col-label"><col class="col-amount"><col class="col-total"></colgroup><tbody>';
  }
  html += columnHeaders(multi);

  // Helper: compute equity changes (exclude retained earnings, show only items that changed)
  function equityChanges(
    curEqRows: LineItem[],
    priorEqRows: LineItem[]
  ): EquityChange[] {
    const changes: EquityChange[] = [];
    curEqRows.forEach((item: LineItem) => {
      if (item.label.toLowerCase().indexOf('retained') >= 0) return;
      let priorAmt = 0;
      if (priorEqRows) {
        priorEqRows.forEach((p: LineItem) => {
          if (p.label === item.label)
            priorAmt = parseFloat(String(p.amount)) || 0;
        });
      }
      const change: number =
        (parseFloat(String(item.amount)) || 0) - priorAmt;
      if (Math.abs(change) >= 0.005) {
        changes.push({ label: item.label, amount: change });
      }
    });
    // Check for items in prior but not in current (removed equity items)
    if (priorEqRows) {
      priorEqRows.forEach((p: LineItem) => {
        if (p.label.toLowerCase().indexOf('retained') >= 0) return;
        let found = false;
        curEqRows.forEach((c: LineItem) => {
          if (c.label === p.label) found = true;
        });
        if (!found) {
          const change: number = -(parseFloat(String(p.amount)) || 0);
          if (Math.abs(change) >= 0.005)
            changes.push({ label: p.label, amount: change });
        }
      });
    }
    return changes;
  }

  if (multi) {
    // -- Prior Period Rollforward --
    html += sectionHeader('Prior Period', multi);
    html += tr({ label: 'Beginning Balance', indent: false, currentAmt: pBeginBal, priorAmt: null, isTotal: true, cls: '', multi: false });
    html += tr({ label: 'Net Income', indent: true, currentAmt: pNetIncome, priorAmt: null, isTotal: false, cls: '', multi: false });

    // Prior period equity changes (vs beginning balance of 0)
    const priorEqItems: LineItem[] = rows(state.priorData, 'equity');
    const pChanges: EquityChange[] = equityChanges(priorEqItems, []);
    pChanges.forEach((item: EquityChange) => {
      html += tr({ label: item.label, indent: true, currentAmt: item.amount, priorAmt: null, isTotal: false, cls: '', multi: false });
    });
    html += tr({ label: 'Ending Balance (Prior Period)', indent: false, currentAmt: pTotalEquityWithNI, priorAmt: null, isTotal: true, cls: '', multi: false });

    // Blank separator
    html += '<tr><td colspan="3" style="height:12px"></td></tr>';

    // -- Current Period Rollforward --
    html += sectionHeader('Current Period', multi);
    html += tr({ label: 'Beginning Balance', indent: false, currentAmt: pTotalEquityWithNI, priorAmt: null, isTotal: true, cls: '', multi: false });
    html += tr({ label: 'Net Income', indent: true, currentAmt: netIncome, priorAmt: null, isTotal: false, cls: '', multi: false });

    const curEqItems: LineItem[] = rows(state.currentData, 'equity');
    const priorEqForCompare: LineItem[] = rows(state.priorData, 'equity');
    const cChanges: EquityChange[] = equityChanges(
      curEqItems,
      priorEqForCompare
    );
    cChanges.forEach((item: EquityChange) => {
      html += tr({ label: item.label, indent: true, currentAmt: item.amount, priorAmt: null, isTotal: false, cls: '', multi: false });
    });
    html += tr({ label: 'Ending Balance (Current Period)', indent: false, currentAmt: totalEquity, priorAmt: null, isTotal: true, cls: '', multi: false });
  } else {
    // -- Single Period Rollforward --
    html += tr({ label: 'Beginning Balance', indent: false, currentAmt: beginBal, priorAmt: null, isTotal: true, cls: '', multi });
    html += tr({ label: 'Net Income', indent: true, currentAmt: netIncome, priorAmt: null, isTotal: false, cls: '', multi });

    const eqItems: LineItem[] = rows(state.currentData, 'equity');
    const sChanges: EquityChange[] = equityChanges(eqItems, []);
    sChanges.forEach((item: EquityChange) => {
      html += tr({ label: item.label, indent: true, currentAmt: item.amount, priorAmt: null, isTotal: false, cls: '', multi });
    });
    html += tr({ label: 'Ending Balance', indent: false, currentAmt: totalEquity, priorAmt: null, isTotal: true, cls: '', multi });
  }

  html += '</tbody></table>';
  const equityEl = el('equity-statement');
  if (equityEl) equityEl.innerHTML = html;
  } finally { restoreStatementData(); }
}
