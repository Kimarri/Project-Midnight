/* ═══════════════════════════════════════════════════════════════════════
   NoteFlow — utils.test.ts
   Unit tests for core financial calculation and formatting functions.
   ═══════════════════════════════════════════════════════════════════════ */

import { describe, it, expect, beforeEach } from 'vitest';
import { sum, fmt, esc, computeNetIncome, rows, hasPriorData } from '../src/modules/utils';
import { state, SECTIONS, type SectionData } from '../src/modules/state';

// ─── Helper ────────────────────────────────────────────────────────────
function makeData(overrides: Partial<SectionData> = {}): SectionData {
  const data: SectionData = {};
  SECTIONS.forEach(s => { data[s] = []; });
  Object.assign(data, overrides);
  return data;
}

// ─── sum() ─────────────────────────────────────────────────────────────
describe('sum()', () => {
  it('sums numeric amounts in a section', () => {
    const data = makeData({
      revenue: [
        { label: 'Product Sales', amount: 50000 },
        { label: 'Service Revenue', amount: 25000 },
      ],
    });
    expect(sum(data, 'revenue')).toBe(75000);
  });

  it('handles string amounts (from CSV import)', () => {
    const data = makeData({
      opex: [
        { label: 'Rent', amount: '12000' },
        { label: 'Utilities', amount: '3500.50' },
      ],
    });
    expect(sum(data, 'opex')).toBe(15500.50);
  });

  it('returns 0 for empty section', () => {
    const data = makeData();
    expect(sum(data, 'revenue')).toBe(0);
  });

  it('returns 0 for nonexistent section', () => {
    const data = makeData();
    expect(sum(data, 'nonexistent')).toBe(0);
  });

  it('ignores NaN / empty / null amounts', () => {
    const data = makeData({
      cogs: [
        { label: 'Materials', amount: 10000 },
        { label: 'Bad', amount: 'abc' },
        { label: 'Empty', amount: '' },
        { label: 'Zero', amount: 0 },
      ],
    });
    expect(sum(data, 'cogs')).toBe(10000);
  });

  it('handles negative amounts correctly', () => {
    const data = makeData({
      other: [
        { label: 'Interest Income', amount: -5000 },
        { label: 'Interest Expense', amount: 2000 },
      ],
    });
    expect(sum(data, 'other')).toBe(-3000);
  });

  it('prevents floating-point drift', () => {
    // 0.1 + 0.2 === 0.30000000000000004 in JS
    const data = makeData({
      revenue: [
        { label: 'A', amount: 0.1 },
        { label: 'B', amount: 0.2 },
      ],
    });
    expect(sum(data, 'revenue')).toBe(0.3);
  });

  it('handles large financial amounts', () => {
    const data = makeData({
      revenue: [
        { label: 'Product A', amount: 1234567.89 },
        { label: 'Product B', amount: 9876543.21 },
      ],
    });
    expect(sum(data, 'revenue')).toBe(11111111.10);
  });

  it('filters null/undefined entries in array', () => {
    const data = makeData({
      revenue: [
        { label: 'Sales', amount: 1000 },
        null as any,
        undefined as any,
        { label: 'Other', amount: 500 },
      ],
    });
    expect(sum(data, 'revenue')).toBe(1500);
  });
});

// ─── computeNetIncome() ────────────────────────────────────────────────
describe('computeNetIncome()', () => {
  it('computes net income = revenue - cogs - opex + other', () => {
    const data = makeData({
      revenue: [{ label: 'Sales', amount: 100000 }],
      cogs: [{ label: 'Cost', amount: 40000 }],
      opex: [{ label: 'SGA', amount: 25000 }],
      other: [{ label: 'Interest', amount: -3000 }],
    });
    // 100000 - 40000 - 25000 + (-3000) = 32000
    expect(computeNetIncome(data)).toBe(32000);
  });

  it('returns 0 for empty data', () => {
    const data = makeData();
    expect(computeNetIncome(data)).toBe(0);
  });

  it('handles loss scenario (negative net income)', () => {
    const data = makeData({
      revenue: [{ label: 'Sales', amount: 50000 }],
      cogs: [{ label: 'Cost', amount: 35000 }],
      opex: [{ label: 'Expenses', amount: 30000 }],
      other: [{ label: 'Interest Exp', amount: 5000 }],
    });
    // 50000 - 35000 - 30000 + 5000 = -10000
    expect(computeNetIncome(data)).toBe(-10000);
  });

  it('handles revenue-only scenario', () => {
    const data = makeData({
      revenue: [{ label: 'Sales', amount: 75000 }],
    });
    expect(computeNetIncome(data)).toBe(75000);
  });
});

// ─── fmt() ─────────────────────────────────────────────────────────────
describe('fmt()', () => {
  beforeEach(() => {
    // Reset template cache to defaults
    state._cachedTemplate = null;
  });

  it('formats positive numbers with 2 decimal places', () => {
    expect(fmt(1234.5)).toBe('1,234.50');
  });

  it('formats negative numbers with parentheses (default)', () => {
    expect(fmt(-1234.5)).toBe('(1,234.50)');
  });

  it('formats negative numbers with minus sign when configured', () => {
    state._cachedTemplate = {
      fontFamily: '',
      headerSize: '',
      decimals: 2,
      negativeStyle: 'minus',
      showCurrency: false,
      currencySymbol: '$',
      thousandsSeparator: true,
    };
    expect(fmt(-1234.5)).toBe('-1,234.50');
  });

  it('formats zero correctly', () => {
    expect(fmt(0)).toBe('0.00');
  });

  it('respects 0 decimal places when configured', () => {
    state._cachedTemplate = {
      fontFamily: '',
      headerSize: '',
      decimals: 0,
      negativeStyle: 'parentheses',
      showCurrency: false,
      currencySymbol: '$',
      thousandsSeparator: true,
    };
    expect(fmt(1234.567)).toBe('1,235');
  });

  it('formats large numbers with thousands separators', () => {
    expect(fmt(1234567890.12)).toBe('1,234,567,890.12');
  });
});

// ─── esc() ─────────────────────────────────────────────────────────────
describe('esc()', () => {
  it('escapes HTML entities', () => {
    expect(esc('<script>alert("xss")</script>')).toBe(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'
    );
  });

  it('escapes ampersand', () => {
    expect(esc('AT&T')).toBe('AT&amp;T');
  });

  it('escapes single quotes', () => {
    expect(esc("O'Brien")).toBe('O&#39;Brien');
  });

  it('escapes backslashes', () => {
    expect(esc('path\\to\\file')).toBe('path&#92;to&#92;file');
  });

  it('handles non-string input', () => {
    expect(esc(42)).toBe('42');
    expect(esc(null)).toBe('null');
    expect(esc(undefined)).toBe('undefined');
  });

  it('returns empty string for empty input', () => {
    expect(esc('')).toBe('');
  });
});

// ─── rows() ────────────────────────────────────────────────────────────
describe('rows()', () => {
  it('returns items with label or amount', () => {
    const data = makeData({
      revenue: [
        { label: 'Sales', amount: 100 },
        { label: '', amount: '' },
        { label: 'Other', amount: 0 },
      ],
    });
    const result = rows(data, 'revenue');
    expect(result).toHaveLength(2);
    expect(result[0].label).toBe('Sales');
    expect(result[1].label).toBe('Other');
  });

  it('filters out null/undefined entries', () => {
    const data = makeData({
      opex: [null as any, undefined as any, { label: 'Rent', amount: 1000 }],
    });
    expect(rows(data, 'opex')).toHaveLength(1);
  });

  it('returns empty array for empty section', () => {
    const data = makeData();
    expect(rows(data, 'revenue')).toHaveLength(0);
  });
});

// ─── hasPriorData() ────────────────────────────────────────────────────
describe('hasPriorData()', () => {
  beforeEach(() => {
    state.resetData();
  });

  it('returns false when no prior data exists', () => {
    expect(hasPriorData()).toBe(false);
  });

  it('returns true when prior data has items', () => {
    state.priorData['revenue'] = [{ label: 'Sales', amount: 50000 }];
    expect(hasPriorData()).toBe(true);
  });
});
