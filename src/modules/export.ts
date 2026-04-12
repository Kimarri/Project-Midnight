/* ═══════════════════════════════════════════════════════════════════════
   NoteFlow — export.ts
   Statement generation, Excel/PDF export
   ═══════════════════════════════════════════════════════════════════════ */

import { state, SECTIONS, type FirmProfile } from './state';
import { sum, rows, cur, meta, esc, hasPriorData, computeNetIncome, extractYear, el } from './utils';
import { trackEvent, blockIfSafeMode } from './config';
import { saveProject } from './data';
import { applyTemplateToStatements } from './templates';
import {
  buildBalanceSheet,
  buildIncomeStatement,
  buildEquityStatement,
  buildCashFlow,
  mergeLabels,
  findNoncashItems,
  computeWorkingCapitalChanges,
  detectInvestingActivities,
  detectFinancingActivities,
  type CashFlowLineItem,
} from './statements';

// ─── External library declarations ────────────────────────────────────────
declare const XLSX: any;

import {
  switchTab,
  buildTrialBalanceEditor,
  loadPriorYearFields,
  renderAJEEntries,
  updateEmptyStates,
  updateTabBadges,
} from './ui';

// ─── Print Cover Page ──────────────────────────────────────────────────────

/** Loads the firm profile from localStorage (matches auth.ts pattern). */
function loadFirmProfile(): FirmProfile {
  try {
    return JSON.parse(localStorage.getItem('noteflow-firmprofile-' + state.currentUserEmail) || '{}') || {};
  } catch { return {}; }
}

/**
 * Builds a professional cover page for print/PDF output.
 * Populates #print-cover-page with company name, title, period, dates, and firm name.
 */
export function buildCoverPage(): void {
  const container = el('print-cover-page');
  if (!container) return;

  const m = meta();
  const multi = hasPriorData();
  const priorYearOnly = m.priorPeriod ? (extractYear(m.priorPeriod) || m.priorPeriod) : '';
  const periodDisplay = multi && m.priorPeriod ? m.period + ' and ' + priorYearOnly : m.period;
  const firm = loadFirmProfile();

  let html = '';
  html += '<div class="cover-company">' + esc(m.company) + '</div>';
  html += '<div class="cover-title">Financial Statements</div>';
  html += '<div class="cover-divider"></div>';
  html += '<div class="cover-period">' + esc(periodDisplay) + '</div>';

  if (m.engagementDate) {
    html += '<div class="cover-date">Engagement Date: ' + esc(m.engagementDate) + '</div>';
  }

  const reportDate = m.reportDate || new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  html += '<div class="cover-date">Report Date: ' + esc(reportDate) + '</div>';

  if (firm.firmName) {
    html += '<div class="cover-firm">' + esc(firm.firmName) + '</div>';
  }

  container.innerHTML = html;
}

// ─── Print Table of Contents ───────────────────────────────────────────────

/**
 * Builds a table of contents listing all generated statements for print output.
 * Populates #print-toc with a styled list of statements.
 */
export function buildTableOfContents(): void {
  const container = el('print-toc');
  if (!container) return;

  const entries: { label: string; page: number }[] = [
    { label: 'Balance Sheet', page: 3 },
    { label: 'Income Statement', page: 4 },
    { label: 'Statement of Changes in Equity', page: 5 },
    { label: 'Statement of Cash Flows', page: 6 },
    { label: 'Notes to Financial Statements', page: 7 },
  ];

  let html = '<div class="toc-title">Table of Contents</div>';
  html += '<ul class="toc-list">';
  for (const entry of entries) {
    html += '<li><span class="toc-label">' + esc(entry.label) + '</span><span class="toc-page">' + entry.page + '</span></li>';
  }
  html += '</ul>';

  container.innerHTML = html;
}

// ─── Generate All ──────────────────────────────────────────────────────────

export function generateAll(): void {
  trackEvent('statements_generated');
  try { buildBalanceSheet(); } catch (e) { console.error('Balance Sheet build failed:', e); }
  try { buildIncomeStatement(); } catch (e) { console.error('Income Statement build failed:', e); }
  try { buildEquityStatement(); } catch (e) { console.error('Equity Statement build failed:', e); }
  try { buildCashFlow(); } catch (e) { console.error('Cash Flow build failed:', e); }
  applyTemplateToStatements();
  try { buildCoverPage(); } catch (e) { console.error('Cover page build failed:', e); }
  try { buildTableOfContents(); } catch (e) { console.error('TOC build failed:', e); }
  updateEmptyStates();
  updateTabBadges();
  buildTrialBalanceEditor();
  switchTab('balance');
}

// ─── Clear ──────────────────────────────────────────────────────────────────

export function clearAll(): void {
  blockIfSafeMode('Clearing all data', function () { _clearAllInner(); });
}

function _clearAllInner(): void {
  SECTIONS.forEach(function (s: string) { state.currentData[s] = []; state.priorData[s] = []; });
  const statusEl = document.getElementById('import-status');
  if (statusEl) statusEl.innerHTML = '';
  // Reset file zone
  state.importFiles.combined = null;
  const z = document.getElementById('zone-combined');
  if (z) z.classList.remove('has-file');
  const hint = document.getElementById('zone-combined-hint');
  const name = document.getElementById('zone-combined-name');
  if (hint) hint.textContent = 'Drop CSV here or click to browse';
  if (name) name.textContent = '';
  // Reset new features
  state.ajeEntries = []; state.ajePosted = false; state.ajePrePostData = null;
  renderAJEEntries();
  loadPriorYearFields();
  buildTrialBalanceEditor();
  saveProject();
}

// ─── Excel Export ───────────────────────────────────────────────────────────
/**
 * Exports all financial statements to a multi-sheet Excel workbook (.xlsx) and triggers download.
 */
export function exportToExcel(): void {
  try {
  trackEvent('excel_exports');
  const m = meta();
  const multi = hasPriorData();
  const wb = XLSX.utils.book_new();

  // Period formatting helpers
  const curYear: string = (m.period ? extractYear(m.period) : null) || 'Current';
  const priorYear: string = (m.priorPeriod ? extractYear(m.priorPeriod) : null) || 'Prior';
  const priorYearOnly: string = (m.priorPeriod ? extractYear(m.priorPeriod) : null) || m.priorPeriod || '';
  function bsPeriod(): string {
    if (multi && m.priorPeriod) return m.period + ' and ' + priorYearOnly;
    return m.period;
  }
  function flowPeriod(): string {
    const base = multi && m.priorPeriod ? m.period + ' and ' + priorYearOnly : m.period;
    return base && base !== 'Period' ? 'For the Year Ended ' + base : base;
  }

  function buildISData(): any[][] {
    const aoa: any[][] = [];
    aoa.push([m.company]);
    aoa.push(['Income Statement']);
    aoa.push([flowPeriod()]);
    aoa.push([]);

    if (multi) {
      aoa.push(['', curYear, priorYear]);
    } else {
      aoa.push(['', 'Amount']);
    }

    const totalRevenue = sum(state.currentData, 'revenue');
    const totalCOGS = sum(state.currentData, 'cogs');
    const grossProfit = totalRevenue - totalCOGS;
    const totalOpex = sum(state.currentData, 'opex');
    const operatingIncome = grossProfit - totalOpex;
    const totalOther = sum(state.currentData, 'other');
    const netIncome = operatingIncome + totalOther;

    let pTotalRevenue = 0, pTotalCOGS = 0, pGrossProfit = 0, pTotalOpex = 0, pOperatingIncome = 0, pTotalOther = 0, pNetIncome = 0;
    if (multi) {
      pTotalRevenue = sum(state.priorData, 'revenue');
      pTotalCOGS = sum(state.priorData, 'cogs');
      pGrossProfit = pTotalRevenue - pTotalCOGS;
      pTotalOpex = sum(state.priorData, 'opex');
      pOperatingIncome = pGrossProfit - pTotalOpex;
      pTotalOther = sum(state.priorData, 'other');
      pNetIncome = pOperatingIncome + pTotalOther;
    }

    function addSection(sectionLabel: string, sectionKey: string): void {
      aoa.push([sectionLabel]);
      const items = mergeLabels(rows(state.currentData, sectionKey), multi ? rows(state.priorData, sectionKey) : [], multi);
      items.forEach(function (item) {
        if (multi) {
          aoa.push(['  ' + item.label, item.cur, item.prior]);
        } else {
          aoa.push(['  ' + item.label, item.cur]);
        }
      });
    }

    addSection('Revenue', 'revenue');
    if (multi) { aoa.push(['Total Revenue', totalRevenue, pTotalRevenue]); }
    else { aoa.push(['Total Revenue', totalRevenue]); }

    addSection('Cost of Goods Sold', 'cogs');
    if (multi) { aoa.push(['Total Cost of Goods Sold', totalCOGS, pTotalCOGS]); }
    else { aoa.push(['Total Cost of Goods Sold', totalCOGS]); }

    if (multi) { aoa.push(['Gross Profit', grossProfit, pGrossProfit]); }
    else { aoa.push(['Gross Profit', grossProfit]); }

    addSection('Operating Expenses', 'opex');
    if (multi) { aoa.push(['Total Operating Expenses', totalOpex, pTotalOpex]); }
    else { aoa.push(['Total Operating Expenses', totalOpex]); }

    if (multi) { aoa.push(['Operating Income', operatingIncome, pOperatingIncome]); }
    else { aoa.push(['Operating Income', operatingIncome]); }

    if (rows(state.currentData, 'other').length || (multi && rows(state.priorData, 'other').length)) {
      addSection('Other Income / (Expense)', 'other');
      if (multi) { aoa.push(['Total Other Income / (Expense)', totalOther, pTotalOther]); }
      else { aoa.push(['Total Other Income / (Expense)', totalOther]); }
    }

    if (multi) { aoa.push(['Net Income', netIncome, pNetIncome]); }
    else { aoa.push(['Net Income', netIncome]); }

    return aoa;
  }

  function buildBSData(): any[][] {
    const aoa: any[][] = [];
    aoa.push([m.company]);
    aoa.push(['Balance Sheet']);
    aoa.push([bsPeriod()]);
    aoa.push([]);

    if (multi) {
      aoa.push(['', curYear, priorYear]);
    } else {
      aoa.push(['', 'Amount']);
    }

    const totalCA = sum(state.currentData, 'current-assets');
    const totalNCA = sum(state.currentData, 'noncurrent-assets');
    const totalAssets = totalCA + totalNCA;
    const totalCL = sum(state.currentData, 'current-liab');
    const totalNCL = sum(state.currentData, 'noncurrent-liab');
    const totalLiab = totalCL + totalNCL;
    const bsNetIncome = computeNetIncome(state.currentData);
    const totalEquity = sum(state.currentData, 'equity') + bsNetIncome;
    const totalLiabEquity = totalLiab + totalEquity;

    let pTotalCA = 0, pTotalNCA = 0, pTotalAssets = 0, pTotalCL = 0, pTotalNCL = 0, pTotalLiab = 0, pTotalEquity = 0, pTotalLiabEquity = 0;
    let pBsNetIncome = 0;
    if (multi) {
      pTotalCA = sum(state.priorData, 'current-assets');
      pTotalNCA = sum(state.priorData, 'noncurrent-assets');
      pTotalAssets = pTotalCA + pTotalNCA;
      pTotalCL = sum(state.priorData, 'current-liab');
      pTotalNCL = sum(state.priorData, 'noncurrent-liab');
      pTotalLiab = pTotalCL + pTotalNCL;
      pBsNetIncome = computeNetIncome(state.priorData);
      pTotalEquity = sum(state.priorData, 'equity') + pBsNetIncome;
      pTotalLiabEquity = pTotalLiab + pTotalEquity;
    }

    function addSection(sectionLabel: string, sectionKey: string): void {
      aoa.push([sectionLabel]);
      const items = mergeLabels(rows(state.currentData, sectionKey), multi ? rows(state.priorData, sectionKey) : [], multi);
      items.forEach(function (item) {
        if (multi) { aoa.push(['  ' + item.label, item.cur, item.prior]); }
        else { aoa.push(['  ' + item.label, item.cur]); }
      });
    }

    function addTotal(label: string, curVal: number, prior: number): void {
      if (multi) { aoa.push([label, curVal, prior]); }
      else { aoa.push([label, curVal]); }
    }

    aoa.push(['ASSETS']);
    addSection('Current Assets', 'current-assets');
    addTotal('Total Current Assets', totalCA, pTotalCA);

    addSection('Non-Current Assets', 'noncurrent-assets');
    addTotal('Total Non-Current Assets', totalNCA, pTotalNCA);
    addTotal('TOTAL ASSETS', totalAssets, pTotalAssets);

    aoa.push(['LIABILITIES & EQUITY']);
    addSection('Current Liabilities', 'current-liab');
    addTotal('Total Current Liabilities', totalCL, pTotalCL);

    addSection('Non-Current Liabilities', 'noncurrent-liab');
    addTotal('Total Non-Current Liabilities', totalNCL, pTotalNCL);
    addTotal('Total Liabilities', totalLiab, pTotalLiab);

    addSection("Shareholders' Equity", 'equity');
    if (multi) { aoa.push(['  Net Income', bsNetIncome, pBsNetIncome]); }
    else { aoa.push(['  Net Income', bsNetIncome]); }
    addTotal('Total Equity', totalEquity, pTotalEquity);
    addTotal('TOTAL LIABILITIES & EQUITY', totalLiabEquity, pTotalLiabEquity);

    return aoa;
  }

  function buildCFData(): any[][] {
    const aoa: any[][] = [];
    aoa.push([m.company]);
    aoa.push(['Statement of Cash Flows']);
    aoa.push([flowPeriod()]);
    aoa.push([]);

    if (multi) {
      aoa.push(['', curYear, priorYear]);
    } else {
      aoa.push(['', 'Amount']);
    }

    function addRow(label: string, curVal: number, prior: number, indent?: boolean): void {
      const prefix = indent ? '  ' : '';
      if (multi) { aoa.push([prefix + label, curVal, prior]); }
      else { aoa.push([prefix + label, curVal]); }
    }

    const netIncome = computeNetIncome(state.currentData);
    const pNetIncome = multi ? computeNetIncome(state.priorData) : 0;
    const manualOpLabels = rows(state.currentData, 'cf-operating').map(function (r) { return r.label; });
    const pManualOpLabels = multi ? rows(state.priorData, 'cf-operating').map(function (r) { return r.label; }) : [];
    const noncashItems = findNoncashItems(state.currentData, manualOpLabels);
    const pNoncashItems = multi ? findNoncashItems(state.priorData, pManualOpLabels) : [];
    const wcChanges = multi ? computeWorkingCapitalChanges(state.currentData, state.priorData) : [];
    const autoNoncashTotal = noncashItems.reduce(function (s, i) { return s + i.amount; }, 0);
    const pAutoNoncashTotal = pNoncashItems.reduce(function (s, i) { return s + i.amount; }, 0);
    const wcTotal = wcChanges.reduce(function (s, i) { return s + i.amount; }, 0);
    const manualOpTotal = sum(state.currentData, 'cf-operating');
    const pManualOpTotal = multi ? sum(state.priorData, 'cf-operating') : 0;
    const totalOp = netIncome + autoNoncashTotal + wcTotal + manualOpTotal;
    const pTotalOp = multi ? (pNetIncome + pAutoNoncashTotal + pManualOpTotal) : 0;
    // Auto-detect investing/financing activities
    const autoInvItems: CashFlowLineItem[] = multi
      ? detectInvestingActivities(state.currentData, state.priorData) : [];
    const autoFinItems: CashFlowLineItem[] = multi
      ? detectFinancingActivities(state.currentData, state.priorData) : [];
    const manualInvItems = mergeLabels(rows(state.currentData, 'cf-investing'), multi ? rows(state.priorData, 'cf-investing') : [], multi);
    const manualFinItems = mergeLabels(rows(state.currentData, 'cf-financing'), multi ? rows(state.priorData, 'cf-financing') : [], multi);
    const autoInvTotal = autoInvItems.reduce(function (s, i) { return s + i.amount; }, 0);
    const autoFinTotal = autoFinItems.reduce(function (s, i) { return s + i.amount; }, 0);
    const manualInvTotal = sum(state.currentData, 'cf-investing');
    const manualFinTotal = sum(state.currentData, 'cf-financing');
    const pManualInvTotal = multi ? sum(state.priorData, 'cf-investing') : 0;
    const pManualFinTotal = multi ? sum(state.priorData, 'cf-financing') : 0;
    const totalInv = autoInvTotal + manualInvTotal;
    const totalFin = autoFinTotal + manualFinTotal;
    const pTotalInv = pManualInvTotal;
    const pTotalFin = pManualFinTotal;
    const netChange = totalOp + totalInv + totalFin;
    const pNetChange = multi ? (pTotalOp + pTotalInv + pTotalFin) : 0;

    aoa.push(['Cash Flows from Operating Activities']);
    addRow('Net Income', netIncome, pNetIncome, true);
    if (noncashItems.length > 0 || (multi && pNoncashItems.length > 0)) {
      aoa.push(['  Adjustments for non-cash items:']);
      if (multi) {
        const allNc = mergeLabels(
          noncashItems.map(function (i) { return { label: i.label, amount: i.amount }; }),
          pNoncashItems.map(function (i) { return { label: i.label, amount: i.amount }; }), true);
        allNc.forEach(function (item) { addRow(item.label, item.cur ?? 0, item.prior ?? 0, true); });
      } else {
        noncashItems.forEach(function (item) { addRow(item.label, item.amount, 0, true); });
      }
    }
    if (wcChanges.length > 0) {
      aoa.push(['  Changes in operating assets and liabilities:']);
      wcChanges.forEach(function (item) { addRow(item.label, item.amount, 0, true); });
    }
    const manualOpItems = mergeLabels(rows(state.currentData, 'cf-operating'), multi ? rows(state.priorData, 'cf-operating') : [], multi);
    if (manualOpItems.length > 0) {
      aoa.push(['  Other operating adjustments:']);
      manualOpItems.forEach(function (item) { addRow(item.label, item.cur ?? 0, item.prior ?? 0, true); });
    }
    addRow('Net Cash from Operating Activities', totalOp, pTotalOp, false);

    aoa.push(['Cash Flows from Investing Activities']);
    autoInvItems.forEach(function (item) { addRow(item.label, item.amount, item.priorAmount, true); });
    manualInvItems.forEach(function (item) { addRow(item.label, item.cur ?? 0, item.prior ?? 0, true); });
    addRow('Net Cash from Investing Activities', totalInv, pTotalInv, false);

    aoa.push(['Cash Flows from Financing Activities']);
    autoFinItems.forEach(function (item) { addRow(item.label, item.amount, item.priorAmount, true); });
    manualFinItems.forEach(function (item) { addRow(item.label, item.cur ?? 0, item.prior ?? 0, true); });
    addRow('Net Cash from Financing Activities', totalFin, pTotalFin, false);

    addRow('Net Change in Cash', netChange, pNetChange, false);

    return aoa;
  }

  function buildEquityData(): any[][] {
    const aoa: any[][] = [];
    const entityEl = document.getElementById('nq-entity-type') as HTMLSelectElement | null;
    const entityType = entityEl ? entityEl.value : '';
    const eqTitle = (entityType && (entityType.indexOf('LLC') >= 0 || entityType.indexOf('Partnership') >= 0))
      ? "Statement of Changes in Members' Equity" : "Statement of Stockholders' Equity";

    aoa.push([m.company]);
    aoa.push([eqTitle]);
    aoa.push([flowPeriod()]);
    aoa.push([]);
    aoa.push(['', 'Amount']);

    const netIncome = computeNetIncome(state.currentData);
    const totalEquity = sum(state.currentData, 'equity') + netIncome;
    const pTotalEquity = multi ? sum(state.priorData, 'equity') : 0;
    const pNetIncome = multi ? computeNetIncome(state.priorData) : 0;
    const pTotalEquityWithNI = pTotalEquity + pNetIncome;

    if (multi) {
      aoa.push(['Prior Period']);
      aoa.push(['  Beginning Balance', 0]);
      aoa.push(['  Net Income', pNetIncome]);
      rows(state.priorData, 'equity').forEach(function (item) {
        if (item.label.toLowerCase().indexOf('retained') === -1) {
          aoa.push(['  ' + item.label, parseFloat(String(item.amount)) || 0]);
        }
      });
      aoa.push(['Ending Balance (Prior Period)', pTotalEquityWithNI]);
      aoa.push([]);
      aoa.push(['Current Period']);
      aoa.push(['  Beginning Balance', pTotalEquityWithNI]);
      aoa.push(['  Net Income', netIncome]);
      rows(state.currentData, 'equity').forEach(function (item) {
        if (item.label.toLowerCase().indexOf('retained') === -1) {
          aoa.push(['  ' + item.label, parseFloat(String(item.amount)) || 0]);
        }
      });
      aoa.push(['Ending Balance (Current Period)', totalEquity]);
    } else {
      aoa.push(['Beginning Balance', pTotalEquityWithNI]);
      aoa.push(['  Net Income', netIncome]);
      rows(state.currentData, 'equity').forEach(function (item) {
        if (item.label.toLowerCase().indexOf('retained') === -1) {
          aoa.push(['  ' + item.label, parseFloat(String(item.amount)) || 0]);
        }
      });
      aoa.push(['Ending Balance', totalEquity]);
    }

    return aoa;
  }

  function buildNotesData(): any[][] {
    const aoa: any[][] = [];
    aoa.push([m.company]);
    aoa.push(['Notes to the Financial Statements']);
    aoa.push([flowPeriod()]);
    aoa.push([]);

    const notesEl = document.getElementById('notes-statement');
    if (notesEl && notesEl.innerText.trim()) {
      const lines = notesEl.innerText.split('\n');
      lines.forEach(function (line: string) {
        aoa.push([line]);
      });
    } else {
      aoa.push(['Notes have not been generated yet.']);
    }
    return aoa;
  }

  // Build sheets (standard financial statement order)
  const bsData = buildBSData();
  const wsBS = XLSX.utils.aoa_to_sheet(bsData);
  wsBS['!cols'] = [{ wch: 40 }, { wch: 18 }, { wch: 18 }];
  XLSX.utils.book_append_sheet(wb, wsBS, 'Balance Sheet');

  const isData = buildISData();
  const wsIS = XLSX.utils.aoa_to_sheet(isData);
  wsIS['!cols'] = [{ wch: 40 }, { wch: 18 }, { wch: 18 }];
  XLSX.utils.book_append_sheet(wb, wsIS, 'Income Statement');

  const eqData = buildEquityData();
  const wsEq = XLSX.utils.aoa_to_sheet(eqData);
  wsEq['!cols'] = [{ wch: 40 }, { wch: 18 }, { wch: 18 }];
  XLSX.utils.book_append_sheet(wb, wsEq, 'Equity');

  const cfData = buildCFData();
  const wsCF = XLSX.utils.aoa_to_sheet(cfData);
  wsCF['!cols'] = [{ wch: 40 }, { wch: 18 }, { wch: 18 }];
  XLSX.utils.book_append_sheet(wb, wsCF, 'Cash Flows');

  const notesData = buildNotesData();
  const wsNotes = XLSX.utils.aoa_to_sheet(notesData);
  wsNotes['!cols'] = [{ wch: 80 }];
  XLSX.utils.book_append_sheet(wb, wsNotes, 'Notes');

  const filename = (m.company || 'Financial_Statements').replace(/[^a-zA-Z0-9 ]/g, '').replace(/\s+/g, '_') + '.xlsx';
  XLSX.writeFile(wb, filename);
  } catch (err) {
    console.error('Excel export failed:', err);
    alert('Export failed. Please try again.');
  }
}

// ─── PDF Package Export ─────────────────────────────────────────────────────
/**
 * Exports the full financial statement package as a multi-page PDF using jsPDF.
 */
export function exportPackagePDF(): void {
  try {
  trackEvent('pdf_exports');
  const jsPDFConstructor = (window as any).jspdf?.jsPDF || (window as any).jsPDF;
  const doc = new jsPDFConstructor({ unit: 'pt', format: 'letter' });
  const m = meta();
  const c = cur();
  const multi = hasPriorData();
  const pageW: number = doc.internal.pageSize.getWidth();
  const pageH: number = doc.internal.pageSize.getHeight();
  const margin = 54;
  const contentW = pageW - margin * 2;
  let pageNum = 0;
  const tocEntries: { title: string; page: number }[] = [];

  function fmtAmt(n: number | null | undefined): string {
    if (n === null || n === undefined) return '';
    const abs = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return n < 0 ? '(' + c + abs + ')' : c + abs;
  }

  function addFooter(d: any, pg: number): void {
    d.setFontSize(8);
    d.setTextColor(150);
    d.text(m.company + ' \u2014 Financial Statement Package', margin, pageH - 30);
    d.text('Page ' + pg, pageW - margin, pageH - 30, { align: 'right' });
    d.setTextColor(0);
  }

  function startPage(d: any, title: string): number {
    if (pageNum > 0) d.addPage();
    pageNum++;
    tocEntries.push({ title: title, page: pageNum });
    addFooter(d, pageNum);
    return pageNum;
  }

  // ── 1. COVER PAGE ──
  pageNum++;
  doc.setFillColor(30, 41, 59);
  doc.rect(0, 0, pageW, 200, 'F');
  doc.setFillColor(37, 99, 235);
  doc.rect(0, 200, pageW, 6, 'F');

  doc.setTextColor(255);
  doc.setFontSize(32);
  doc.setFont('helvetica', 'bold');
  doc.text(m.company, pageW / 2, 120, { align: 'center' });

  doc.setFontSize(14);
  doc.setFont('helvetica', 'normal');
  doc.text('Financial Statement Package', pageW / 2, 155, { align: 'center' });

  doc.setTextColor(30, 41, 59);
  doc.setFontSize(14);
  const pdfPriorYearOnly: string = (m.priorPeriod ? extractYear(m.priorPeriod) : null) || m.priorPeriod || '';
  const pdfCurYear: string = (m.period ? extractYear(m.period) : null) || 'Current';
  const pdfPriorYear: string = (m.priorPeriod ? extractYear(m.priorPeriod) : null) || 'Prior';
  const coverPeriod = multi && m.priorPeriod ? m.period + ' and ' + pdfPriorYearOnly : m.period;
  doc.text(coverPeriod, pageW / 2, 260, { align: 'center' });

  const pdfFirm = loadFirmProfile();
  let coverY = 290;

  if (m.engagementDate) {
    doc.setFontSize(11);
    doc.setTextColor(100);
    doc.text('Engagement Date: ' + m.engagementDate, pageW / 2, coverY, { align: 'center' });
    coverY += 20;
  }

  doc.setFontSize(11);
  doc.setTextColor(100);
  const reportDateStr = m.reportDate || new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  doc.text('Report Date: ' + reportDateStr, pageW / 2, coverY, { align: 'center' });
  coverY += 20;

  doc.text('Prepared with NoteFlow', pageW / 2, coverY, { align: 'center' });
  coverY += 30;

  if (pdfFirm.firmName) {
    doc.setFontSize(13);
    doc.setTextColor(30, 41, 59);
    doc.setFont('helvetica', 'bold');
    doc.text(pdfFirm.firmName, pageW / 2, coverY, { align: 'center' });
    doc.setFont('helvetica', 'normal');
  }

  addFooter(doc, pageNum);

  // ── 2. TABLE OF CONTENTS ──
  doc.addPage();
  pageNum++;
  const tocPageNum = pageNum;

  // ── Helper: draw a financial statement table ──
  function drawStatementTable(title: string, dataRows: any[][], isTotalFn: (row: any[]) => boolean): void {
    startPage(doc, title);

    const isBS: boolean = title === 'Balance Sheet';
    const stmtPeriod: string = isBS
      ? (multi && m.priorPeriod ? m.period + ' and ' + pdfPriorYearOnly : m.period)
      : (multi && m.priorPeriod ? 'For the Year Ended ' + m.period + ' and ' + pdfPriorYearOnly : (m.period && m.period !== 'Period' ? 'For the Year Ended ' + m.period : m.period));

    doc.setFontSize(12);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(30, 41, 59);
    doc.text(m.company, pageW / 2, margin + 10, { align: 'center' });
    doc.setFontSize(11);
    doc.text(title, pageW / 2, margin + 28, { align: 'center' });
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(100);
    doc.text(stmtPeriod, pageW / 2, margin + 44, { align: 'center' });
    doc.setTextColor(0);

    let head: string[][];
    let colStyles: Record<number, any>;
    if (multi) {
      head = [['', pdfCurYear, pdfPriorYear]];
      colStyles = {
        0: { cellWidth: contentW * 0.50, halign: 'left' },
        1: { cellWidth: contentW * 0.25, halign: 'right' },
        2: { cellWidth: contentW * 0.25, halign: 'right' }
      };
    } else {
      head = [['', 'Amount']];
      colStyles = {
        0: { cellWidth: contentW * 0.65, halign: 'left' },
        1: { cellWidth: contentW * 0.35, halign: 'right' }
      };
    }

    const body: any[][] = [];
    dataRows.forEach(function (row: any[]) {
      const labelStyle = isTotalFn(row) ? { fontStyle: 'bold' } : (String(row[0]).startsWith('  ') ? {} : { fontStyle: 'bold', textColor: [100, 116, 139] });
      const amtStyle = isTotalFn(row) ? { fontStyle: 'bold' } : {};
      const rowArr: any[] = [
        { content: row[0], styles: labelStyle },
        { content: row[1] !== undefined && row[1] !== '' ? fmtAmt(row[1]) : '', styles: amtStyle }
      ];
      if (multi) {
        rowArr.push({ content: row[2] !== undefined && row[2] !== '' ? fmtAmt(row[2]) : '', styles: amtStyle });
      }
      body.push(rowArr);
    });

    doc.autoTable({
      startY: margin + 60,
      head: head,
      body: body,
      theme: 'plain',
      margin: { left: margin, right: margin },
      styles: { fontSize: 9, cellPadding: { top: 3, bottom: 3, left: 4, right: 4 }, lineColor: [226, 232, 240], overflow: 'linebreak' },
      headStyles: { fontStyle: 'bold', fillColor: [241, 245, 249], textColor: [30, 41, 59], lineWidth: { bottom: 0.5 } },
      columnStyles: colStyles,
      didDrawPage: function () {
        addFooter(doc, pageNum);
      },
      willDrawCell: function (data: any) {
        if (data.section === 'body') {
          const rowData = dataRows[data.row.index];
          if (rowData && isTotalFn(rowData)) {
            doc.setDrawColor(30, 41, 59);
            doc.setLineWidth(0.5);
            doc.line(data.cell.x, data.cell.y, data.cell.x + data.cell.width, data.cell.y);
          }
        }
      }
    });
  }

  function isTotal(row: any[]): boolean {
    const lbl = (String(row[0]) || '').trim();
    return lbl.indexOf('Total') === 0 || lbl.indexOf('TOTAL') === 0 ||
           lbl === 'Gross Profit' || lbl === 'Operating Income' || lbl === 'Net Income' ||
           lbl === 'Net Change in Cash';
  }

  // ── Helper functions for PDF sections ──
  function pushSection(arr: any[][], label: string, sectionKey: string): void {
    arr.push([label]);
    const items = mergeLabels(rows(state.currentData, sectionKey), multi ? rows(state.priorData, sectionKey) : [], multi);
    items.forEach(function (item) {
      if (multi) arr.push(['  ' + item.label, item.cur, item.prior]);
      else arr.push(['  ' + item.label, item.cur]);
    });
  }
  function pushTotal(arr: any[][], label: string, curVal: number, prior: number): void {
    if (multi) arr.push([label, curVal, prior]);
    else arr.push([label, curVal]);
  }

  // ── 3. BALANCE SHEET ──
  const bsAoa: any[][] = [];
  const totalCA = sum(state.currentData, 'current-assets'), totalNCA = sum(state.currentData, 'noncurrent-assets');
  const totalAssets = totalCA + totalNCA;
  const totalCL = sum(state.currentData, 'current-liab'), totalNCL = sum(state.currentData, 'noncurrent-liab');
  const pdfBsNI = computeNetIncome(state.currentData);
  const totalLiab = totalCL + totalNCL, totalEquity = sum(state.currentData, 'equity') + pdfBsNI;
  const totalLiabEquity = totalLiab + totalEquity;
  let pCA = 0, pNCA = 0, pAssets = 0, pCL = 0, pNCL = 0, pLiab = 0, pEq = 0, pLE = 0, pPdfBsNI = 0;
  if (multi) {
    pCA = sum(state.priorData, 'current-assets'); pNCA = sum(state.priorData, 'noncurrent-assets'); pAssets = pCA + pNCA;
    pCL = sum(state.priorData, 'current-liab'); pNCL = sum(state.priorData, 'noncurrent-liab'); pLiab = pCL + pNCL;
    pPdfBsNI = computeNetIncome(state.priorData);
    pEq = sum(state.priorData, 'equity') + pPdfBsNI; pLE = pLiab + pEq;
  }

  bsAoa.push(['ASSETS']);
  pushSection(bsAoa, 'Current Assets', 'current-assets');
  pushTotal(bsAoa, 'Total Current Assets', totalCA, pCA);
  pushSection(bsAoa, 'Non-Current Assets', 'noncurrent-assets');
  pushTotal(bsAoa, 'Total Non-Current Assets', totalNCA, pNCA);
  pushTotal(bsAoa, 'TOTAL ASSETS', totalAssets, pAssets);
  bsAoa.push(['']);
  bsAoa.push(['LIABILITIES & EQUITY']);
  pushSection(bsAoa, 'Current Liabilities', 'current-liab');
  pushTotal(bsAoa, 'Total Current Liabilities', totalCL, pCL);
  pushSection(bsAoa, 'Non-Current Liabilities', 'noncurrent-liab');
  pushTotal(bsAoa, 'Total Non-Current Liabilities', totalNCL, pNCL);
  pushTotal(bsAoa, 'Total Liabilities', totalLiab, pLiab);
  pushSection(bsAoa, "Shareholders' Equity", 'equity');
  if (multi) bsAoa.push(['  Net Income', pdfBsNI, pPdfBsNI]);
  else bsAoa.push(['  Net Income', pdfBsNI]);
  pushTotal(bsAoa, 'Total Equity', totalEquity, pEq);
  pushTotal(bsAoa, 'TOTAL LIABILITIES & EQUITY', totalLiabEquity, pLE);

  drawStatementTable('Balance Sheet', bsAoa, isTotal);

  // ── 5. INCOME STATEMENT ──
  const isAoa: any[][] = [];
  const totalRev = sum(state.currentData, 'revenue'), totalCOGS = sum(state.currentData, 'cogs');
  const grossProfit = totalRev - totalCOGS;
  const totalOpex = sum(state.currentData, 'opex'), opIncome = grossProfit - totalOpex;
  const totalOther = sum(state.currentData, 'other'), netIncome = opIncome + totalOther;
  let pRev = 0, pCOGS2 = 0, pGP = 0, pOpex = 0, pOpInc = 0, pOther = 0, pNI = 0;
  if (multi) {
    pRev = sum(state.priorData, 'revenue'); pCOGS2 = sum(state.priorData, 'cogs'); pGP = pRev - pCOGS2;
    pOpex = sum(state.priorData, 'opex'); pOpInc = pGP - pOpex;
    pOther = sum(state.priorData, 'other'); pNI = pOpInc + pOther;
  }

  pushSection(isAoa, 'Revenue', 'revenue');
  pushTotal(isAoa, 'Total Revenue', totalRev, pRev);
  pushSection(isAoa, 'Cost of Goods Sold', 'cogs');
  pushTotal(isAoa, 'Total Cost of Goods Sold', totalCOGS, pCOGS2);
  pushTotal(isAoa, 'Gross Profit', grossProfit, pGP);
  pushSection(isAoa, 'Operating Expenses', 'opex');
  pushTotal(isAoa, 'Total Operating Expenses', totalOpex, pOpex);
  pushTotal(isAoa, 'Operating Income', opIncome, pOpInc);
  if (rows(state.currentData, 'other').length || (multi && rows(state.priorData, 'other').length)) {
    pushSection(isAoa, 'Other Income / (Expense)', 'other');
    pushTotal(isAoa, 'Total Other Income / (Expense)', totalOther, pOther);
  }
  pushTotal(isAoa, 'Net Income', netIncome, pNI);

  drawStatementTable('Income Statement', isAoa, isTotal);

  // ── 6. STATEMENT OF CHANGES IN EQUITY ──
  startPage(doc, 'Statement of Changes in Equity');
  doc.setFontSize(12);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(30, 41, 59);
  doc.text(m.company, pageW / 2, margin + 10, { align: 'center' });
  doc.setFontSize(11);
  doc.text('Statement of Changes in Equity', pageW / 2, margin + 28, { align: 'center' });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(100);
  const eqPeriodLabel = multi && m.priorPeriod ? 'For the Year Ended ' + m.period + ' and ' + pdfPriorYearOnly : (m.period && m.period !== 'Period' ? 'For the Year Ended ' + m.period : m.period);
  doc.text(eqPeriodLabel, pageW / 2, margin + 44, { align: 'center' });
  doc.setTextColor(0);

  const eqBody: any[][] = [];
  if (multi) {
    eqBody.push([{ content: 'Beginning Balance (Prior Period)', styles: { fontStyle: 'bold' } }, fmtAmt(pEq)]);
    eqBody.push(['Net Income \u2014 Prior Period', fmtAmt(pNI)]);
    eqBody.push([{ content: 'Ending Balance (Prior Period)', styles: { fontStyle: 'bold' } }, fmtAmt(pEq)]);
    eqBody.push(['', '']);
    eqBody.push([{ content: 'Beginning Balance (Current Period)', styles: { fontStyle: 'bold' } }, fmtAmt(pEq)]);
    eqBody.push(['Net Income \u2014 Current Period', fmtAmt(netIncome)]);
    const eqItems = mergeLabels(rows(state.currentData, 'equity'), rows(state.priorData, 'equity'), multi);
    eqItems.forEach(function (item) {
      if (item.label.toLowerCase().indexOf('retained') === -1) {
        eqBody.push(['  ' + item.label, fmtAmt(item.cur)]);
      }
    });
    eqBody.push([{ content: 'Ending Balance (Current Period)', styles: { fontStyle: 'bold' } }, fmtAmt(totalEquity)]);
  } else {
    eqBody.push([{ content: 'Beginning Balance', styles: { fontStyle: 'bold' } }, fmtAmt(0)]);
    eqBody.push(['Net Income', fmtAmt(netIncome)]);
    const eqItems2 = rows(state.currentData, 'equity');
    eqItems2.forEach(function (item) {
      if (item.label.toLowerCase().indexOf('retained') === -1) {
        eqBody.push(['  ' + item.label, fmtAmt(parseFloat(String(item.amount)) || 0)]);
      }
    });
    eqBody.push([{ content: 'Ending Balance', styles: { fontStyle: 'bold' } }, fmtAmt(totalEquity)]);
  }

  doc.autoTable({
    startY: margin + 60,
    head: [['', 'Amount']],
    body: eqBody,
    theme: 'plain',
    margin: { left: margin, right: margin },
    styles: { fontSize: 9, cellPadding: { top: 3, bottom: 3, left: 4, right: 4 }, lineColor: [226, 232, 240] },
    headStyles: { fontStyle: 'bold', fillColor: [241, 245, 249], textColor: [30, 41, 59], lineWidth: { bottom: 0.5 } },
    columnStyles: { 0: { cellWidth: contentW * 0.65, halign: 'left' }, 1: { cellWidth: contentW * 0.35, halign: 'right' } },
    didDrawPage: function () { addFooter(doc, pageNum); }
  });

  // ── 7. CASH FLOW STATEMENT ──
  const cfAoa: any[][] = [];
  const cfNetIncome = computeNetIncome(state.currentData);
  const cfPNetIncome = multi ? computeNetIncome(state.priorData) : 0;
  const cfManualOpLabels = rows(state.currentData, 'cf-operating').map(function (r) { return r.label; });
  const cfPManualOpLabels = multi ? rows(state.priorData, 'cf-operating').map(function (r) { return r.label; }) : [];
  const cfNoncash = findNoncashItems(state.currentData, cfManualOpLabels);
  const cfPNoncash = multi ? findNoncashItems(state.priorData, cfPManualOpLabels) : [];
  const cfWC = multi ? computeWorkingCapitalChanges(state.currentData, state.priorData) : [];
  const cfAutoTotal = cfNoncash.reduce(function (s, i) { return s + i.amount; }, 0);
  const cfPAutoTotal = cfPNoncash.reduce(function (s, i) { return s + i.amount; }, 0);
  const cfWCTotal = cfWC.reduce(function (s, i) { return s + i.amount; }, 0);
  const cfManualOpTotal = sum(state.currentData, 'cf-operating');
  const cfPManualOpTotal = multi ? sum(state.priorData, 'cf-operating') : 0;
  const cfTotalOp = cfNetIncome + cfAutoTotal + cfWCTotal + cfManualOpTotal;
  const cfPOp = multi ? (cfPNetIncome + cfPAutoTotal + cfPManualOpTotal) : 0;
  const cfAutoInv: CashFlowLineItem[] = multi
    ? detectInvestingActivities(state.currentData, state.priorData) : [];
  const cfAutoFin: CashFlowLineItem[] = multi
    ? detectFinancingActivities(state.currentData, state.priorData) : [];
  const cfManualInv = mergeLabels(rows(state.currentData, 'cf-investing'), multi ? rows(state.priorData, 'cf-investing') : [], multi);
  const cfManualFin = mergeLabels(rows(state.currentData, 'cf-financing'), multi ? rows(state.priorData, 'cf-financing') : [], multi);
  const cfAutoInvTotal = cfAutoInv.reduce(function (s, i) { return s + i.amount; }, 0);
  const cfAutoFinTotal = cfAutoFin.reduce(function (s, i) { return s + i.amount; }, 0);
  const cfManualInvTotal = sum(state.currentData, 'cf-investing');
  const cfManualFinTotal = sum(state.currentData, 'cf-financing');
  const cfPManualInv = multi ? sum(state.priorData, 'cf-investing') : 0;
  const cfPManualFin = multi ? sum(state.priorData, 'cf-financing') : 0;
  const cfTotalInv = cfAutoInvTotal + cfManualInvTotal;
  const cfTotalFin = cfAutoFinTotal + cfManualFinTotal;
  const cfPInv = cfPManualInv;
  const cfPFin = cfPManualFin;
  const cfNetChange = cfTotalOp + cfTotalInv + cfTotalFin;
  const cfPNet = multi ? (cfPOp + cfPInv + cfPFin) : 0;

  cfAoa.push([{ content: 'Cash Flows from Operating Activities', styles: { fontStyle: 'bold' } }, '']);
  if (multi) { cfAoa.push(['  Net Income', fmtAmt(cfNetIncome), fmtAmt(cfPNetIncome)]); }
  else { cfAoa.push(['  Net Income', fmtAmt(cfNetIncome)]); }

  if (cfNoncash.length > 0 || (multi && cfPNoncash.length > 0)) {
    cfAoa.push([{ content: '  Adjustments for non-cash items:', styles: { fontStyle: 'italic' } }, '']);
    if (multi) {
      const allNc = mergeLabels(
        cfNoncash.map(function (i) { return { label: i.label, amount: i.amount }; }),
        cfPNoncash.map(function (i) { return { label: i.label, amount: i.amount }; }), true);
      allNc.forEach(function (item) { cfAoa.push(['    ' + item.label, fmtAmt(item.cur), fmtAmt(item.prior)]); });
    } else {
      cfNoncash.forEach(function (item) { cfAoa.push(['    ' + item.label, fmtAmt(item.amount)]); });
    }
  }
  if (cfWC.length > 0) {
    cfAoa.push([{ content: '  Changes in operating assets and liabilities:', styles: { fontStyle: 'italic' } }, '']);
    cfWC.forEach(function (item) {
      if (multi) { cfAoa.push(['    ' + item.label, fmtAmt(item.amount), '']); }
      else { cfAoa.push(['    ' + item.label, fmtAmt(item.amount)]); }
    });
  }
  const cfManualOp = mergeLabels(rows(state.currentData, 'cf-operating'), multi ? rows(state.priorData, 'cf-operating') : [], multi);
  if (cfManualOp.length > 0) {
    cfAoa.push([{ content: '  Other operating adjustments:', styles: { fontStyle: 'italic' } }, '']);
    cfManualOp.forEach(function (item) {
      if (multi) { cfAoa.push(['    ' + item.label, fmtAmt(item.cur), fmtAmt(item.prior)]); }
      else { cfAoa.push(['    ' + item.label, fmtAmt(item.cur)]); }
    });
  }
  pushTotal(cfAoa, 'Net Cash from Operating Activities', cfTotalOp, cfPOp);

  cfAoa.push(['Cash Flows from Investing Activities']);
  cfAutoInv.forEach(function (item) {
    if (multi) { cfAoa.push(['  ' + item.label, fmtAmt(item.amount), fmtAmt(item.priorAmount)]); }
    else { cfAoa.push(['  ' + item.label, fmtAmt(item.amount)]); }
  });
  cfManualInv.forEach(function (item) {
    if (multi) { cfAoa.push(['  ' + item.label, fmtAmt(item.cur), fmtAmt(item.prior)]); }
    else { cfAoa.push(['  ' + item.label, fmtAmt(item.cur)]); }
  });
  pushTotal(cfAoa, 'Net Cash from Investing Activities', cfTotalInv, cfPInv);
  cfAoa.push(['Cash Flows from Financing Activities']);
  cfAutoFin.forEach(function (item) {
    if (multi) { cfAoa.push(['  ' + item.label, fmtAmt(item.amount), fmtAmt(item.priorAmount)]); }
    else { cfAoa.push(['  ' + item.label, fmtAmt(item.amount)]); }
  });
  cfManualFin.forEach(function (item) {
    if (multi) { cfAoa.push(['  ' + item.label, fmtAmt(item.cur), fmtAmt(item.prior)]); }
    else { cfAoa.push(['  ' + item.label, fmtAmt(item.cur)]); }
  });
  pushTotal(cfAoa, 'Net Cash from Financing Activities', cfTotalFin, cfPFin);
  pushTotal(cfAoa, 'Net Change in Cash', cfNetChange, cfPNet);

  drawStatementTable('Statement of Cash Flows', cfAoa, isTotal);

  // ── 8. NOTES TO FINANCIAL STATEMENTS ──
  startPage(doc, 'Notes to the Financial Statements');
  doc.setFontSize(12);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(30, 41, 59);
  doc.text(m.company, pageW / 2, margin + 10, { align: 'center' });
  doc.setFontSize(11);
  doc.text('Notes to the Financial Statements', pageW / 2, margin + 28, { align: 'center' });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(100);
  const notesPeriodLabel = multi && m.priorPeriod ? 'For the Year Ended ' + m.period + ' and ' + pdfPriorYearOnly : (m.period && m.period !== 'Period' ? 'For the Year Ended ' + m.period : m.period);
  doc.text(notesPeriodLabel, pageW / 2, margin + 44, { align: 'center' });
  doc.setTextColor(0);

  const notesEl = document.getElementById('notes-statement');
  let notesText = '';
  if (notesEl && notesEl.innerText.trim()) {
    notesText = notesEl.innerText.trim();
  } else {
    notesText = 'Notes have not been generated yet. Complete the Notes questionnaire to include notes in this package.';
  }

  doc.setFontSize(9.5);
  doc.setFont('helvetica', 'normal');
  const noteLines: string[] = doc.splitTextToSize(notesText, contentW);
  let noteY = margin + 68;
  noteLines.forEach(function (line: string) {
    if (noteY > pageH - 50) {
      doc.addPage();
      pageNum++;
      addFooter(doc, pageNum);
      noteY = margin + 20;
    }
    if (/^Note \d/.test(line.trim())) {
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(30, 41, 59);
      noteY += 6;
    } else {
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(60);
    }
    doc.text(line, margin, noteY);
    noteY += 14;
  });

  // ── NOW DRAW TABLE OF CONTENTS on page 2 ──
  doc.setPage(2);
  doc.setFontSize(18);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(30, 41, 59);
  doc.text('Table of Contents', pageW / 2, margin + 30, { align: 'center' });

  doc.setFontSize(11);
  doc.setFont('helvetica', 'normal');
  let tocY = margin + 70;
  tocEntries.forEach(function (entry) {
    doc.setTextColor(30, 41, 59);
    doc.text(entry.title, margin + 10, tocY);
    doc.setTextColor(150);
    const titleW = doc.getStringUnitWidth(entry.title) * 11 / doc.internal.scaleFactor;
    const pageStr = String(entry.page);
    const pageStrW = doc.getStringUnitWidth(pageStr) * 11 / doc.internal.scaleFactor;
    const dotsStartX = margin + 10 + titleW + 8;
    const dotsEndX = pageW - margin - 10 - pageStrW - 4;
    const dotChar = '.';
    const dotW = doc.getStringUnitWidth(dotChar) * 11 / doc.internal.scaleFactor;
    const numDots = Math.floor((dotsEndX - dotsStartX) / (dotW + 1));
    if (numDots > 0) {
      doc.setTextColor(200);
      for (let d = 0; d < numDots; d++) {
        doc.text('.', dotsStartX + d * (dotW + 1), tocY);
      }
    }
    doc.setTextColor(30, 41, 59);
    doc.text(pageStr, pageW - margin - 10, tocY, { align: 'right' });
    tocY += 28;
  });

  addFooter(doc, tocPageNum);

  // ── Save ──
  const filename = (m.company || 'Financial_Statements').replace(/[^a-zA-Z0-9 ]/g, '').replace(/\s+/g, '_') + '_Package.pdf';
  doc.save(filename);
  } catch (err) {
    console.error('PDF export failed:', err);
    alert('Export failed. Please try again.');
  }
}

