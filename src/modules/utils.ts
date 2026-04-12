/* ═══════════════════════════════════════════════════════════════════════
   NoteFlow — utils.ts
   Shared formatting, helpers, and statement row builders
   ═══════════════════════════════════════════════════════════════════════ */

import { state, SECTIONS, type LineItem, type SectionData } from './state';

// ─── Types ─────────────────────────────────────────────────────────────────

interface MetaInfo {
  company: string;
  period: string;
  priorPeriod: string;
  engagementDate: string;
  reportDate: string;
  inThousands: boolean;
}

interface TrParams {
  label: string;
  indent: boolean;
  currentAmt: number | null;
  priorAmt: number | null;
  isTotal: boolean;
  cls: string;
  multi: boolean;
}

// ─── Safe DOM Helpers ─────────────────────────────────────────────────────

/** Safe getElementById — returns element or null, logs warning if missing */
export function el(id: string): HTMLElement | null {
  const elem = document.getElementById(id);
  if (!elem) console.warn('[NoteFlow] Missing element:', id);
  return elem;
}

/** Safe getElementById with type cast — returns typed element or null */
export function elInput(id: string): HTMLInputElement | null {
  return el(id) as HTMLInputElement | null;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

export function cur(): string {
  return elInput('currency')?.value || '$';
}

/**
 * Formats a number using the active template's decimal/negative settings.
 * Reads from state._cachedTemplate to avoid circular dependency with templates module.
 */
/** Check if "in thousands" presentation is enabled */
export function inThousands(): boolean {
  const cb = document.getElementById('inThousands') as HTMLInputElement | null;
  return cb ? cb.checked : false;
}

export function fmt(n: number): string {
  const tpl = state._cachedTemplate ?? { decimals: 2, negativeStyle: 'parentheses' };
  let dec: number = tpl.decimals ?? 2;
  let val = n;
  if (inThousands()) { val = Math.round(n / 1000); dec = 0; }
  const abs: string = Math.abs(val).toLocaleString('en-US', {
    minimumFractionDigits: dec,
    maximumFractionDigits: dec,
  });
  if (val < 0) {
    if (tpl.negativeStyle === 'minus') return '-' + abs;
    return '(' + abs + ')';
  }
  return abs;
}

/**
 * Sums all numeric amounts in a given data section (core accounting helper).
 * @param dataObj - Data object containing section arrays (e.g. currentData or priorData)
 * @param section - Section key to sum (e.g. 'revenue', 'cogs', 'opex')
 * @returns Total of all parsed amounts in the section
 */
export function sum(dataObj: SectionData, section: string): number {
  const total = (dataObj[section] || [])
    .filter(Boolean)
    .reduce((acc: number, r: LineItem) => acc + (parseFloat(String(r.amount)) || 0), 0);
  return Math.round(total * 100) / 100; // Prevent floating-point drift in financial calculations
}

export function rows(dataObj: SectionData, section: string): LineItem[] {
  return (dataObj[section] || []).filter(Boolean).filter((r: LineItem) => r.label || r.amount);
}

export function meta(): MetaInfo {
  return {
    company: (() => {
      const name = elInput('companyName')?.value || 'Your Company';
      return (state.consolidationMode && state.entities.length > 1) ? name + ' (Consolidated)' : name;
    })(),
    period: elInput('period')?.value || 'Period',
    priorPeriod: elInput('priorPeriod')?.value || '',
    engagementDate: elInput('engagementDate')?.value || '',
    reportDate: elInput('reportDate')?.value || '',
    inThousands: inThousands(),
  };
}

/**
 * Computes net income as revenue minus COGS minus operating expenses plus other income/expense.
 * @param dataObj - Data object containing revenue, cogs, opex, and other sections
 * @returns Calculated net income
 */
export function computeNetIncome(dataObj: SectionData): number {
  return sum(dataObj, 'revenue') - sum(dataObj, 'cogs') - sum(dataObj, 'opex') + sum(dataObj, 'other');
}

export function hasPriorData(): boolean {
  for (const s of SECTIONS) {
    if (rows(state.priorData, s).length > 0) return true;
  }
  return false;
}

export function stmtHeader(title: string): string {
  const m = meta();
  const multi = hasPriorData();
  const isBalanceSheet: boolean = title === 'Balance Sheet';

  let periodText: string;
  if (multi && m.priorPeriod) {
    // Extract prior year for the "and" portion (e.g. "December 31, 2025 and 2024")
    const priorYear: string | null = extractYear(m.priorPeriod);
    const andPart: string = priorYear || m.priorPeriod;
    periodText = m.period + ' and ' + andPart;
  } else {
    periodText = m.period;
  }

  // Balance Sheet: show date as-is (e.g. "December 31, 2025 and 2024")
  // All others: prefix with "For the Year Ended" (e.g. "For the Year Ended December 31, 2025 and 2024")
  if (!isBalanceSheet && periodText && periodText !== 'Period') {
    periodText = 'For the Year Ended ' + periodText;
  }

  const thousandsLabel: string = inThousands() ? '<div class="period" style="font-style:italic;font-size:0.8rem">(in thousands)</div>' : '';

  return '<div class="stmt-header">' +
    '<div class="company">' + esc(m.company) + '</div>' +
    '<div class="title">' + title + '</div>' +
    '<div class="period">' + esc(periodText) + '</div>' +
    thousandsLabel +
  '</div>';
}

export function esc(s: any): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\\/g, '&#92;');
}

// ─── Statement Row Builders ─────────────────────────────────────────────────

export function tr({
  label,
  indent,
  currentAmt,
  priorAmt,
  isTotal,
  cls,
  multi,
}: TrParams): string {
  label = esc(label); // XSS: escape account names from CSV imports
  const c: string = cur();

  if (multi) {
    const curStr: string = currentAmt !== null ? c + fmt(currentAmt) : '';
    const priorStr: string = priorAmt !== null ? c + fmt(priorAmt) : '';
    const curColor: string = currentAmt !== null && currentAmt < 0 ? 'negative' : '';
    const priorColor: string = priorAmt !== null && priorAmt < 0 ? 'negative' : '';

    if (isTotal) {
      return '<tr class="grand-total ' + (cls || '') + '">' +
        '<td class="col-label">' + label + '</td>' +
        '<td class="col-current ' + curColor + '">' + curStr + '</td>' +
        '<td class="col-prior ' + priorColor + '">' + priorStr + '</td>' +
      '</tr>';
    }
    if (indent) {
      return '<tr class="item ' + (cls || '') + '">' +
        '<td class="col-label" style="padding-left:20px">' + label + '</td>' +
        '<td class="col-current ' + curColor + '">' + curStr + '</td>' +
        '<td class="col-prior ' + priorColor + '">' + priorStr + '</td>' +
      '</tr>';
    }
    return '<tr class="subtotal ' + (cls || '') + '">' +
      '<td class="col-label">' + label + '</td>' +
      '<td class="col-current ' + curColor + '">' + curStr + '</td>' +
      '<td class="col-prior ' + priorColor + '">' + priorStr + '</td>' +
    '</tr>';
  } else {
    // Two columns: amount + total (original layout)
    const amtStr: string = currentAmt !== null ? c + fmt(currentAmt) : '';
    const colorCls: string = currentAmt !== null && currentAmt < 0 ? 'negative' : '';

    if (isTotal) {
      return '<tr class="grand-total ' + (cls || '') + '"><td class="col-label">' + label + '</td><td></td>' +
        '<td class="col-total ' + colorCls + '">' + amtStr + '</td></tr>';
    }
    if (indent) {
      return '<tr class="item ' + (cls || '') + '"><td class="col-label" style="padding-left:20px">' + label + '</td>' +
        '<td class="col-amount ' + colorCls + '">' + amtStr + '</td><td></td></tr>';
    }
    return '<tr class="subtotal ' + (cls || '') + '"><td class="col-label">' + label + '</td><td></td>' +
      '<td class="col-total ' + colorCls + '">' + amtStr + '</td></tr>';
  }
}

export function sectionHeader(label: string, _multi: boolean): string {
  return '<tr class="section-header"><td colspan="3">' + esc(label) + '</td></tr>';
}

/**
 * Extracts a 4-digit year from a period string like "December 31, 2025".
 * Returns the year string or null if none found.
 */
export function extractYear(period: string): string | null {
  const match = period.match(/\b(19|20)\d{2}\b/);
  return match ? match[0] : null;
}

export function columnHeaders(multi: boolean): string {
  if (multi) {
    const m = meta();
    const curYear: string = (m.period ? extractYear(m.period) : null) || 'Current';
    const priorYear: string = (m.priorPeriod ? extractYear(m.priorPeriod) : null) || 'Prior';
    return '<tr style="font-size:0.78rem;font-weight:600;color:#64748b;border-bottom:1px solid #e1e5eb">' +
      '<td class="col-label"></td>' +
      '<td class="col-current" style="text-align:right">' + esc(curYear) + '</td>' +
      '<td class="col-prior" style="text-align:right">' + esc(priorYear) + '</td>' +
    '</tr>';
  }
  return '';
}
