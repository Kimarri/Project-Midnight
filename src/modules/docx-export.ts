/* ═══════════════════════════════════════════════════════════════════════
   NoteFlow — docx-export.ts
   Word (.docx) export for financial statement packages
   ═══════════════════════════════════════════════════════════════════════ */

import {
  Document, Packer, Paragraph, Table, TableRow, TableCell, TextRun,
  HeadingLevel, AlignmentType, WidthType, BorderStyle,
  type ITableCellBorders,
} from 'docx';
import { saveAs } from 'file-saver';
import { state } from './state';
import {
  sum, rows, meta, hasPriorData, computeNetIncome, extractYear, cur,
} from './utils';
import {
  mergeLabels, findNoncashItems, computeWorkingCapitalChanges,
  detectInvestingActivities, detectFinancingActivities,
  type CashFlowLineItem,
} from './statements';
import { trackEvent } from './config';

// ─── Formatting Helpers ──────────────────────────────────────────────────────

function fmtAmt(n: number | null | undefined): string {
  if (n === null || n === undefined) return '';
  const c = cur();
  const abs = Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return n < 0 ? '(' + c + abs + ')' : c + abs;
}

// ─── Reusable DOCX Builders ────────────────────────────────────────────────

const BORDER_NONE: ITableCellBorders = {
  top: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
  bottom: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
  left: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
  right: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
};

const BORDER_BOTTOM: ITableCellBorders = {
  top: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
  bottom: { style: BorderStyle.SINGLE, size: 1, color: '1E293B' },
  left: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
  right: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
};

const BORDER_DOUBLE_BOTTOM: ITableCellBorders = {
  top: { style: BorderStyle.SINGLE, size: 1, color: '1E293B' },
  bottom: { style: BorderStyle.DOUBLE, size: 1, color: '1E293B' },
  left: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
  right: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
};

function stmtHeaderParagraphs(
  company: string,
  title: string,
  periodText: string,
): Paragraph[] {
  return [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 40 },
      children: [new TextRun({ text: company, bold: true, size: 24, font: 'Calibri' })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 40 },
      children: [new TextRun({ text: title, bold: true, size: 22, font: 'Calibri' })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 200 },
      children: [new TextRun({ text: periodText, italics: true, size: 20, font: 'Calibri' })],
    }),
  ];
}

function isTotal(label: string): boolean {
  const lbl = label.trim();
  return lbl.startsWith('Total') || lbl.startsWith('TOTAL') ||
    lbl === 'Gross Profit' || lbl === 'Operating Income' || lbl === 'Net Income' ||
    lbl === 'Net Change in Cash';
}

function isSectionHeader(label: string): boolean {
  const lbl = label.trim();
  return (lbl === 'ASSETS' || lbl === 'LIABILITIES & EQUITY' ||
    lbl.startsWith('Cash Flows from') ||
    lbl === 'Revenue' || lbl === 'Cost of Goods Sold' ||
    lbl === 'Operating Expenses' || lbl.startsWith('Other Income') ||
    lbl === 'Current Assets' || lbl === 'Non-Current Assets' ||
    lbl === 'Current Liabilities' || lbl === 'Non-Current Liabilities' ||
    lbl === "Shareholders' Equity" ||
    lbl === 'Prior Period' || lbl === 'Current Period' ||
    lbl.indexOf('Adjustments for non-cash') >= 0 ||
    lbl.indexOf('Changes in operating') >= 0 ||
    lbl.indexOf('Other operating adjustments') >= 0);
}

function buildTableRow(
  label: string,
  amounts: string[],
  multi: boolean,
  totalRow: boolean,
  sectionRow: boolean,
): TableRow {
  const borders = totalRow ? BORDER_DOUBLE_BOTTOM
    : sectionRow ? BORDER_BOTTOM
    : BORDER_NONE;

  const labelCell = new TableCell({
    borders,
    width: { size: 50, type: WidthType.PERCENTAGE },
    children: [
      new Paragraph({
        children: [
          new TextRun({
            text: label,
            bold: totalRow || sectionRow,
            size: 20,
            font: 'Calibri',
            color: sectionRow && !totalRow ? '64748B' : '1E293B',
          }),
        ],
      }),
    ],
  });

  const amtCells = amounts.map(
    (amt) =>
      new TableCell({
        borders,
        width: { size: multi ? 25 : 50, type: WidthType.PERCENTAGE },
        children: [
          new Paragraph({
            alignment: AlignmentType.RIGHT,
            children: [
              new TextRun({
                text: amt,
                bold: totalRow,
                size: 20,
                font: 'Calibri',
              }),
            ],
          }),
        ],
      }),
  );

  return new TableRow({ children: [labelCell, ...amtCells] });
}

function headerRow(labels: string[], multi: boolean): TableRow {
  return new TableRow({
    children: labels.map(
      (lbl, idx) =>
        new TableCell({
          borders: BORDER_BOTTOM,
          width: {
            size: idx === 0 ? 50 : multi ? 25 : 50,
            type: WidthType.PERCENTAGE,
          },
          children: [
            new Paragraph({
              alignment: idx === 0 ? AlignmentType.LEFT : AlignmentType.RIGHT,
              children: [
                new TextRun({
                  text: lbl,
                  bold: true,
                  size: 18,
                  font: 'Calibri',
                  color: '64748B',
                }),
              ],
            }),
          ],
        }),
    ),
  });
}

function aoaToTable(dataRows: (string | number)[][], multi: boolean): Table {
  const colCount = multi ? 3 : 2;
  const tblRows: TableRow[] = [];

  // Column headers
  if (multi) {
    const m = meta();
    const curYear = (m.period ? extractYear(m.period) : null) || 'Current';
    const priorYear = (m.priorPeriod ? extractYear(m.priorPeriod) : null) || 'Prior';
    tblRows.push(headerRow(['', curYear, priorYear], multi));
  } else {
    tblRows.push(headerRow(['', 'Amount'], multi));
  }

  dataRows.forEach((row) => {
    const label = String(row[0] ?? '');
    const total = isTotal(label);
    const section = isSectionHeader(label);

    const amounts: string[] = [];
    for (let i = 1; i < colCount; i++) {
      const val = row[i];
      if (val === undefined || val === null || val === '') {
        amounts.push('');
      } else if (typeof val === 'number') {
        amounts.push(fmtAmt(val));
      } else {
        amounts.push(String(val));
      }
    }

    tblRows.push(buildTableRow(label, amounts, multi, total, section));
  });

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: tblRows,
  });
}

// ─── Statement Data Builders (mirror export.ts logic) ───────────────────────

function buildBSData(multi: boolean): (string | number)[][] {
  const aoa: (string | number)[][] = [];

  function addSection(sectionLabel: string, sectionKey: string): void {
    aoa.push([sectionLabel]);
    const items = mergeLabels(
      rows(state.currentData, sectionKey),
      multi ? rows(state.priorData, sectionKey) : [],
      multi,
    );
    items.forEach((item) => {
      if (multi) aoa.push(['  ' + item.label, item.cur ?? 0, item.prior ?? 0]);
      else aoa.push(['  ' + item.label, item.cur ?? 0]);
    });
  }

  function addTotal(label: string, curVal: number, prior: number): void {
    if (multi) aoa.push([label, curVal, prior]);
    else aoa.push([label, curVal]);
  }

  const totalCA = sum(state.currentData, 'current-assets');
  const totalNCA = sum(state.currentData, 'noncurrent-assets');
  const totalAssets = totalCA + totalNCA;
  const totalCL = sum(state.currentData, 'current-liab');
  const totalNCL = sum(state.currentData, 'noncurrent-liab');
  const totalLiab = totalCL + totalNCL;
  const bsNI = computeNetIncome(state.currentData);
  const totalEquity = sum(state.currentData, 'equity') + bsNI;
  const totalLE = totalLiab + totalEquity;

  let pCA = 0, pNCA = 0, pAssets = 0, pCL = 0, pNCL = 0, pLiab = 0, pEq = 0, pLE = 0, pNI = 0;
  if (multi) {
    pCA = sum(state.priorData, 'current-assets');
    pNCA = sum(state.priorData, 'noncurrent-assets');
    pAssets = pCA + pNCA;
    pCL = sum(state.priorData, 'current-liab');
    pNCL = sum(state.priorData, 'noncurrent-liab');
    pLiab = pCL + pNCL;
    pNI = computeNetIncome(state.priorData);
    pEq = sum(state.priorData, 'equity') + pNI;
    pLE = pLiab + pEq;
  }

  aoa.push(['ASSETS']);
  addSection('Current Assets', 'current-assets');
  addTotal('Total Current Assets', totalCA, pCA);
  addSection('Non-Current Assets', 'noncurrent-assets');
  addTotal('Total Non-Current Assets', totalNCA, pNCA);
  addTotal('TOTAL ASSETS', totalAssets, pAssets);
  aoa.push(['']);
  aoa.push(['LIABILITIES & EQUITY']);
  addSection('Current Liabilities', 'current-liab');
  addTotal('Total Current Liabilities', totalCL, pCL);
  addSection('Non-Current Liabilities', 'noncurrent-liab');
  addTotal('Total Non-Current Liabilities', totalNCL, pNCL);
  addTotal('Total Liabilities', totalLiab, pLiab);
  addSection("Shareholders' Equity", 'equity');
  if (multi) aoa.push(['  Net Income', bsNI, pNI]);
  else aoa.push(['  Net Income', bsNI]);
  addTotal('Total Equity', totalEquity, pEq);
  addTotal('TOTAL LIABILITIES & EQUITY', totalLE, pLE);

  return aoa;
}

function buildISData(multi: boolean): (string | number)[][] {
  const aoa: (string | number)[][] = [];

  function addSection(sectionLabel: string, sectionKey: string): void {
    aoa.push([sectionLabel]);
    const items = mergeLabels(
      rows(state.currentData, sectionKey),
      multi ? rows(state.priorData, sectionKey) : [],
      multi,
    );
    items.forEach((item) => {
      if (multi) aoa.push(['  ' + item.label, item.cur ?? 0, item.prior ?? 0]);
      else aoa.push(['  ' + item.label, item.cur ?? 0]);
    });
  }

  const totalRev = sum(state.currentData, 'revenue');
  const totalCOGS = sum(state.currentData, 'cogs');
  const grossProfit = totalRev - totalCOGS;
  const totalOpex = sum(state.currentData, 'opex');
  const opIncome = grossProfit - totalOpex;
  const totalOther = sum(state.currentData, 'other');
  const netIncome = opIncome + totalOther;

  let pRev = 0, pCOGS = 0, pGP = 0, pOpex = 0, pOpInc = 0, pOther = 0, pNI = 0;
  if (multi) {
    pRev = sum(state.priorData, 'revenue');
    pCOGS = sum(state.priorData, 'cogs');
    pGP = pRev - pCOGS;
    pOpex = sum(state.priorData, 'opex');
    pOpInc = pGP - pOpex;
    pOther = sum(state.priorData, 'other');
    pNI = pOpInc + pOther;
  }

  function pushTotal(label: string, curVal: number, prior: number): void {
    if (multi) aoa.push([label, curVal, prior]);
    else aoa.push([label, curVal]);
  }

  addSection('Revenue', 'revenue');
  pushTotal('Total Revenue', totalRev, pRev);
  addSection('Cost of Goods Sold', 'cogs');
  pushTotal('Total Cost of Goods Sold', totalCOGS, pCOGS);
  pushTotal('Gross Profit', grossProfit, pGP);
  addSection('Operating Expenses', 'opex');
  pushTotal('Total Operating Expenses', totalOpex, pOpex);
  pushTotal('Operating Income', opIncome, pOpInc);

  if (rows(state.currentData, 'other').length || (multi && rows(state.priorData, 'other').length)) {
    addSection('Other Income / (Expense)', 'other');
    pushTotal('Total Other Income / (Expense)', totalOther, pOther);
  }

  pushTotal('Net Income', netIncome, pNI);
  return aoa;
}

function buildEquityData(multi: boolean): (string | number)[][] {
  const aoa: (string | number)[][] = [];
  const netIncome = computeNetIncome(state.currentData);
  const totalEquity = sum(state.currentData, 'equity') + netIncome;
  const pTotalEquity = multi ? sum(state.priorData, 'equity') : 0;
  const pNetIncome = multi ? computeNetIncome(state.priorData) : 0;
  const pTotalEquityWithNI = pTotalEquity + pNetIncome;

  if (multi) {
    aoa.push(['Prior Period']);
    aoa.push(['  Beginning Balance', 0]);
    aoa.push(['  Net Income', pNetIncome]);
    rows(state.priorData, 'equity').forEach((item) => {
      if (item.label.toLowerCase().indexOf('retained') === -1) {
        aoa.push(['  ' + item.label, parseFloat(String(item.amount)) || 0]);
      }
    });
    aoa.push(['Ending Balance (Prior Period)', pTotalEquityWithNI]);
    aoa.push(['']);
    aoa.push(['Current Period']);
    aoa.push(['  Beginning Balance', pTotalEquityWithNI]);
    aoa.push(['  Net Income', netIncome]);
    rows(state.currentData, 'equity').forEach((item) => {
      if (item.label.toLowerCase().indexOf('retained') === -1) {
        aoa.push(['  ' + item.label, parseFloat(String(item.amount)) || 0]);
      }
    });
    aoa.push(['Ending Balance (Current Period)', totalEquity]);
  } else {
    aoa.push(['Beginning Balance', pTotalEquityWithNI]);
    aoa.push(['  Net Income', netIncome]);
    rows(state.currentData, 'equity').forEach((item) => {
      if (item.label.toLowerCase().indexOf('retained') === -1) {
        aoa.push(['  ' + item.label, parseFloat(String(item.amount)) || 0]);
      }
    });
    aoa.push(['Ending Balance', totalEquity]);
  }

  return aoa;
}

function buildCFData(multi: boolean): (string | number)[][] {
  const aoa: (string | number)[][] = [];

  function addRow(label: string, curVal: number, prior: number, indent?: boolean): void {
    const prefix = indent ? '  ' : '';
    if (multi) aoa.push([prefix + label, curVal, prior]);
    else aoa.push([prefix + label, curVal]);
  }

  function pushTotal(label: string, curVal: number, prior: number): void {
    if (multi) aoa.push([label, curVal, prior]);
    else aoa.push([label, curVal]);
  }

  const netIncome = computeNetIncome(state.currentData);
  const pNetIncome = multi ? computeNetIncome(state.priorData) : 0;
  const manualOpLabels = rows(state.currentData, 'cf-operating').map((r) => r.label);
  const pManualOpLabels = multi ? rows(state.priorData, 'cf-operating').map((r) => r.label) : [];
  const noncash = findNoncashItems(state.currentData, manualOpLabels);
  const pNoncash = multi ? findNoncashItems(state.priorData, pManualOpLabels) : [];
  const wcChanges = multi ? computeWorkingCapitalChanges(state.currentData, state.priorData) : [];
  const autoTotal = noncash.reduce((s, i) => s + i.amount, 0);
  const pAutoTotal = pNoncash.reduce((s, i) => s + i.amount, 0);
  const wcTotal = wcChanges.reduce((s, i) => s + i.amount, 0);
  const manualOpTotal = sum(state.currentData, 'cf-operating');
  const pManualOpTotal = multi ? sum(state.priorData, 'cf-operating') : 0;
  const totalOp = netIncome + autoTotal + wcTotal + manualOpTotal;
  const pTotalOp = multi ? (pNetIncome + pAutoTotal + pManualOpTotal) : 0;
  const autoInvItems: CashFlowLineItem[] = multi
    ? detectInvestingActivities(state.currentData, state.priorData) : [];
  const autoFinItems: CashFlowLineItem[] = multi
    ? detectFinancingActivities(state.currentData, state.priorData) : [];
  const autoInvTotal = autoInvItems.reduce((s, i) => s + i.amount, 0);
  const autoFinTotal = autoFinItems.reduce((s, i) => s + i.amount, 0);
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

  if (noncash.length > 0 || (multi && pNoncash.length > 0)) {
    aoa.push(['  Adjustments for non-cash items:']);
    if (multi) {
      const allNc = mergeLabels(
        noncash.map((i) => ({ label: i.label, amount: i.amount })),
        pNoncash.map((i) => ({ label: i.label, amount: i.amount })),
        true,
      );
      allNc.forEach((item) => addRow(item.label, item.cur ?? 0, item.prior ?? 0, true));
    } else {
      noncash.forEach((item) => addRow(item.label, item.amount, 0, true));
    }
  }

  if (wcChanges.length > 0) {
    aoa.push(['  Changes in operating assets and liabilities:']);
    wcChanges.forEach((item) => {
      if (multi) aoa.push(['    ' + item.label, item.amount, 0]);
      else aoa.push(['    ' + item.label, item.amount]);
    });
  }

  const manualOp = mergeLabels(
    rows(state.currentData, 'cf-operating'),
    multi ? rows(state.priorData, 'cf-operating') : [],
    multi,
  );
  if (manualOp.length > 0) {
    aoa.push(['  Other operating adjustments:']);
    manualOp.forEach((item) => {
      if (multi) aoa.push(['    ' + item.label, item.cur ?? 0, item.prior ?? 0]);
      else aoa.push(['    ' + item.label, item.cur ?? 0]);
    });
  }

  pushTotal('Net Cash from Operating Activities', totalOp, pTotalOp);

  aoa.push(['Cash Flows from Investing Activities']);
  autoInvItems.forEach((item) => {
    if (multi) aoa.push(['  ' + item.label, item.amount, item.priorAmount]);
    else aoa.push(['  ' + item.label, item.amount]);
  });
  const manualInvItems = mergeLabels(
    rows(state.currentData, 'cf-investing'),
    multi ? rows(state.priorData, 'cf-investing') : [],
    multi,
  );
  manualInvItems.forEach((item) => {
    if (multi) aoa.push(['  ' + item.label, item.cur ?? 0, item.prior ?? 0]);
    else aoa.push(['  ' + item.label, item.cur ?? 0]);
  });
  pushTotal('Net Cash from Investing Activities', totalInv, pTotalInv);

  aoa.push(['Cash Flows from Financing Activities']);
  autoFinItems.forEach((item) => {
    if (multi) aoa.push(['  ' + item.label, item.amount, item.priorAmount]);
    else aoa.push(['  ' + item.label, item.amount]);
  });
  const manualFinItems = mergeLabels(
    rows(state.currentData, 'cf-financing'),
    multi ? rows(state.priorData, 'cf-financing') : [],
    multi,
  );
  manualFinItems.forEach((item) => {
    if (multi) aoa.push(['  ' + item.label, item.cur ?? 0, item.prior ?? 0]);
    else aoa.push(['  ' + item.label, item.cur ?? 0]);
  });
  pushTotal('Net Cash from Financing Activities', totalFin, pTotalFin);
  pushTotal('Net Change in Cash', netChange, pNetChange);

  return aoa;
}

// ─── Notes Parser ──────────────────────────────────────────────────────────

function parseNotesToParagraphs(): Paragraph[] {
  const notesEl = document.getElementById('notes-statement');
  if (!notesEl || !notesEl.innerHTML.trim()) {
    return [
      new Paragraph({
        spacing: { after: 200 },
        children: [
          new TextRun({
            text: 'Notes have not been generated yet. Complete the Notes questionnaire to include notes in this package.',
            italics: true,
            size: 20,
            font: 'Calibri',
          }),
        ],
      }),
    ];
  }

  const paragraphs: Paragraph[] = [];
  const html = notesEl.innerHTML;

  // Parse the HTML into a temporary container
  const container = document.createElement('div');
  container.innerHTML = html;

  function processNode(node: Node): void {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = (node.textContent || '').trim();
      if (text) {
        paragraphs.push(
          new Paragraph({
            spacing: { after: 120 },
            children: [new TextRun({ text, size: 20, font: 'Calibri' })],
          }),
        );
      }
      return;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    const tag = el.tagName.toLowerCase();

    // Headings — Note X titles
    if (tag === 'h2' || tag === 'h3' || tag === 'h4') {
      const text = el.textContent || '';
      paragraphs.push(
        new Paragraph({
          heading: tag === 'h2' ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3,
          spacing: { before: 240, after: 120 },
          children: [
            new TextRun({
              text,
              bold: true,
              size: tag === 'h2' ? 24 : 22,
              font: 'Calibri',
              color: '1E293B',
            }),
          ],
        }),
      );
      return;
    }

    // Tables
    if (tag === 'table') {
      const tblRows: TableRow[] = [];
      const htmlRows = el.querySelectorAll('tr');
      htmlRows.forEach((tr) => {
        const cells: TableCell[] = [];
        tr.querySelectorAll('td, th').forEach((td) => {
          const isHeader = td.tagName.toLowerCase() === 'th';
          cells.push(
            new TableCell({
              borders: BORDER_BOTTOM,
              children: [
                new Paragraph({
                  children: [
                    new TextRun({
                      text: td.textContent || '',
                      bold: isHeader,
                      size: 18,
                      font: 'Calibri',
                    }),
                  ],
                }),
              ],
            }),
          );
        });
        if (cells.length > 0) {
          tblRows.push(new TableRow({ children: cells }));
        }
      });
      if (tblRows.length > 0) {
        paragraphs.push(
          new Paragraph({ spacing: { before: 120 }, children: [] }),
        );
        paragraphs.push(
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: tblRows,
          }) as unknown as Paragraph,
        );
        paragraphs.push(
          new Paragraph({ spacing: { after: 120 }, children: [] }),
        );
      }
      return;
    }

    // Paragraphs and divs
    if (tag === 'p' || tag === 'div') {
      const text = el.textContent || '';
      if (text.trim()) {
        // Check if it looks like a note heading (e.g. "Note 1 —")
        const isNoteHeading = /^Note\s+\d/.test(text.trim());
        if (isNoteHeading) {
          paragraphs.push(
            new Paragraph({
              heading: HeadingLevel.HEADING_2,
              spacing: { before: 240, after: 120 },
              children: [
                new TextRun({
                  text,
                  bold: true,
                  size: 24,
                  font: 'Calibri',
                  color: '1E293B',
                }),
              ],
            }),
          );
        } else {
          paragraphs.push(
            new Paragraph({
              spacing: { after: 120 },
              children: [new TextRun({ text, size: 20, font: 'Calibri' })],
            }),
          );
        }
      }
      return;
    }

    // Lists
    if (tag === 'ul' || tag === 'ol') {
      el.querySelectorAll('li').forEach((li) => {
        paragraphs.push(
          new Paragraph({
            spacing: { after: 60 },
            indent: { left: 360 },
            children: [
              new TextRun({ text: '\u2022  ', size: 20, font: 'Calibri' }),
              new TextRun({ text: li.textContent || '', size: 20, font: 'Calibri' }),
            ],
          }),
        );
      });
      return;
    }

    // Strong / bold
    if (tag === 'strong' || tag === 'b') {
      const text = el.textContent || '';
      if (text.trim()) {
        paragraphs.push(
          new Paragraph({
            spacing: { after: 120 },
            children: [new TextRun({ text, bold: true, size: 20, font: 'Calibri' })],
          }),
        );
      }
      return;
    }

    // Fallback: recurse into children
    el.childNodes.forEach((child) => processNode(child));
  }

  container.childNodes.forEach((child) => processNode(child));

  // If nothing was parsed, fall back to plain text
  if (paragraphs.length === 0) {
    const text = notesEl.innerText.trim();
    text.split('\n').forEach((line) => {
      if (!line.trim()) return;
      const isNoteHeading = /^Note\s+\d/.test(line.trim());
      paragraphs.push(
        new Paragraph({
          heading: isNoteHeading ? HeadingLevel.HEADING_2 : undefined,
          spacing: { after: isNoteHeading ? 120 : 100 },
          children: [
            new TextRun({
              text: line,
              bold: isNoteHeading,
              size: isNoteHeading ? 24 : 20,
              font: 'Calibri',
              color: isNoteHeading ? '1E293B' : undefined,
            }),
          ],
        }),
      );
    });
  }

  return paragraphs;
}

// ─── Main Export ────────────────────────────────────────────────────────────

export async function exportToWord(): Promise<void> {
  try {
    trackEvent('word_exports');
    const m = meta();
    const multi = hasPriorData();
    const priorYearOnly = (m.priorPeriod ? extractYear(m.priorPeriod) : null) || m.priorPeriod || '';

    function bsPeriod(): string {
      if (multi && m.priorPeriod) return m.period + ' and ' + priorYearOnly;
      return m.period;
    }
    function flowPeriod(): string {
      const base = multi && m.priorPeriod ? m.period + ' and ' + priorYearOnly : m.period;
      return base && base !== 'Period' ? 'For the Year Ended ' + base : base;
    }

    // Determine equity title based on entity type
    const entityEl = document.getElementById('nq-entity-type') as HTMLSelectElement | null;
    const entityType = entityEl ? entityEl.value : '';
    const eqTitle = (entityType && (entityType.indexOf('LLC') >= 0 || entityType.indexOf('Partnership') >= 0))
      ? "Statement of Changes in Members' Equity"
      : "Statement of Stockholders' Equity";

    // Build statement data arrays (same as Excel/PDF exports)
    const bsData = buildBSData(multi);
    const isData = buildISData(multi);
    const eqData = buildEquityData(multi);
    const cfData = buildCFData(multi);

    // Statement names for TOC
    const tocItems = [
      'Balance Sheet',
      'Income Statement',
      eqTitle,
      'Statement of Cash Flows',
      'Notes to the Financial Statements',
    ];

    // ── Build sections ──

    // Cover page section
    const coverParagraphs: Paragraph[] = [
      new Paragraph({ spacing: { before: 3000 }, children: [] }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 200 },
        children: [
          new TextRun({
            text: m.company,
            bold: true,
            size: 56,
            font: 'Calibri',
            color: '1E293B',
          }),
        ],
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 200 },
        children: [
          new TextRun({
            text: 'Financial Statements',
            size: 32,
            font: 'Calibri',
            color: '64748B',
          }),
        ],
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 200 },
        border: {
          bottom: { style: BorderStyle.SINGLE, size: 2, color: '2563EB', space: 1 },
        },
        children: [],
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 200, after: 100 },
        children: [
          new TextRun({
            text: bsPeriod(),
            size: 24,
            font: 'Calibri',
            color: '1E293B',
          }),
        ],
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 400 },
        children: [
          new TextRun({
            text: 'Prepared with NoteFlow',
            size: 20,
            font: 'Calibri',
            color: '94A3B8',
            italics: true,
          }),
        ],
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 200 },
        children: [
          new TextRun({
            text: 'Generated: ' + new Date().toLocaleDateString('en-US', {
              month: 'long',
              day: 'numeric',
              year: 'numeric',
            }),
            size: 18,
            font: 'Calibri',
            color: '94A3B8',
          }),
        ],
      }),
    ];

    // Table of Contents section
    const tocParagraphs: Paragraph[] = [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 400, after: 400 },
        children: [
          new TextRun({
            text: 'Table of Contents',
            bold: true,
            size: 36,
            font: 'Calibri',
            color: '1E293B',
          }),
        ],
      }),
    ];

    tocItems.forEach((title, idx) => {
      tocParagraphs.push(
        new Paragraph({
          spacing: { after: 200 },
          tabStops: [{ type: 'right', position: 9000, leader: 'dot' }],
          children: [
            new TextRun({
              text: title,
              size: 22,
              font: 'Calibri',
              color: '1E293B',
            }),
            new TextRun({
              text: '\t' + String(idx + 3),
              size: 22,
              font: 'Calibri',
              color: '64748B',
            }),
          ],
        }),
      );
    });

    // Balance Sheet section
    const bsParagraphs: Paragraph[] = [
      ...stmtHeaderParagraphs(m.company, 'Balance Sheet', bsPeriod()),
    ];

    // Income Statement section
    const isParagraphs: Paragraph[] = [
      ...stmtHeaderParagraphs(m.company, 'Income Statement', flowPeriod()),
    ];

    // Equity section
    const eqParagraphs: Paragraph[] = [
      ...stmtHeaderParagraphs(m.company, eqTitle, flowPeriod()),
    ];

    // Cash Flow section
    const cfParagraphs: Paragraph[] = [
      ...stmtHeaderParagraphs(m.company, 'Statement of Cash Flows', flowPeriod()),
    ];

    // Notes section
    const notesParagraphs: Paragraph[] = [
      ...stmtHeaderParagraphs(m.company, 'Notes to the Financial Statements', flowPeriod()),
      ...parseNotesToParagraphs(),
    ];

    // Build the document with sections
    const doc = new Document({
      creator: 'NoteFlow',
      title: m.company + ' - Financial Statements',
      description: 'Financial Statement Package generated by NoteFlow',
      styles: {
        default: {
          document: {
            run: { font: 'Calibri', size: 20 },
          },
        },
      },
      sections: [
        // Cover page
        {
          properties: {},
          children: coverParagraphs,
        },
        // Table of Contents
        {
          properties: {
            page: { margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } },
          },
          children: tocParagraphs,
        },
        // Balance Sheet
        {
          properties: {
            page: { margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } },
          },
          children: [
            ...bsParagraphs,
            aoaToTable(bsData, multi),
          ],
        },
        // Income Statement
        {
          properties: {
            page: { margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } },
          },
          children: [
            ...isParagraphs,
            aoaToTable(isData, multi),
          ],
        },
        // Equity
        {
          properties: {
            page: { margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } },
          },
          children: [
            ...eqParagraphs,
            aoaToTable(eqData, multi),
          ],
        },
        // Cash Flow
        {
          properties: {
            page: { margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } },
          },
          children: [
            ...cfParagraphs,
            aoaToTable(cfData, multi),
          ],
        },
        // Notes
        {
          properties: {
            page: { margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } },
          },
          children: notesParagraphs,
        },
      ],
    });

    // Generate and save
    const blob = await Packer.toBlob(doc);
    const filename = (m.company || 'Financial_Statements')
      .replace(/[^a-zA-Z0-9 ]/g, '')
      .replace(/\s+/g, '_') + '.docx';
    saveAs(blob, filename);
  } catch (err) {
    console.error('Word export failed:', err);
    alert('Word export failed. Please try again.');
  }
}
