/* ═══════════════════════════════════════════════════════════════════════
   NoteFlow — statements.test.ts
   Unit tests for statement generation helpers: mergeLabels,
   findNoncashItems, computeWorkingCapitalChanges.
   ═══════════════════════════════════════════════════════════════════════ */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  mergeLabels,
  findNoncashItems,
  computeWorkingCapitalChanges,
} from '../src/modules/statements';
import { state, SECTIONS, type SectionData, type LineItem } from '../src/modules/state';

// ─── Helper ──────────────────────────────────────────────────────────────

function makeData(overrides: Partial<SectionData> = {}): SectionData {
  const data: SectionData = {};
  SECTIONS.forEach(s => { data[s] = []; });
  Object.assign(data, overrides);
  return data;
}

beforeEach(() => {
  state.resetData();
});

// ─── mergeLabels() ────────────────────────────────────────────────────────

describe('mergeLabels()', () => {
  it('returns current items with null prior when multi is false', () => {
    const cur: LineItem[] = [
      { label: 'Cash', amount: 50000 },
      { label: 'AR', amount: 30000 },
    ];
    const result = mergeLabels(cur, [], false);
    expect(result).toEqual([
      { label: 'Cash', cur: 50000, prior: null },
      { label: 'AR', cur: 30000, prior: null },
    ]);
  });

  it('merges matching labels between current and prior when multi is true', () => {
    const cur: LineItem[] = [{ label: 'Cash', amount: 50000 }];
    const prior: LineItem[] = [{ label: 'Cash', amount: 40000 }];
    const result = mergeLabels(cur, prior, true);
    expect(result).toEqual([
      { label: 'Cash', cur: 50000, prior: 40000 },
    ]);
  });

  it('includes prior-only items with cur=0 when multi is true', () => {
    const cur: LineItem[] = [{ label: 'Cash', amount: 50000 }];
    const prior: LineItem[] = [
      { label: 'Cash', amount: 40000 },
      { label: 'Investments', amount: 10000 },
    ];
    const result = mergeLabels(cur, prior, true);
    expect(result).toHaveLength(2);
    const investments = result.find(r => r.label === 'Investments');
    expect(investments).toEqual({ label: 'Investments', cur: 0, prior: 10000 });
  });

  it('includes current-only items with prior=0 when multi is true', () => {
    const cur: LineItem[] = [
      { label: 'Cash', amount: 50000 },
      { label: 'Inventory', amount: 20000 },
    ];
    const prior: LineItem[] = [{ label: 'Cash', amount: 40000 }];
    const result = mergeLabels(cur, prior, true);
    expect(result).toHaveLength(2);
    const inventory = result.find(r => r.label === 'Inventory');
    expect(inventory).toEqual({ label: 'Inventory', cur: 20000, prior: 0 });
  });

  it('handles empty current with prior items', () => {
    const result = mergeLabels([], [{ label: 'Cash', amount: 40000 }], true);
    expect(result).toEqual([
      { label: 'Cash', cur: 0, prior: 40000 },
    ]);
  });

  it('handles both empty', () => {
    expect(mergeLabels([], [], true)).toEqual([]);
    expect(mergeLabels([], [], false)).toEqual([]);
  });

  it('handles string amounts', () => {
    const cur: LineItem[] = [{ label: 'Cash', amount: '50000' }];
    const prior: LineItem[] = [{ label: 'Cash', amount: '40000' }];
    const result = mergeLabels(cur, prior, true);
    expect(result[0].cur).toBe(50000);
    expect(result[0].prior).toBe(40000);
  });

  it('treats non-numeric amounts as 0', () => {
    const cur: LineItem[] = [{ label: 'Cash', amount: 'N/A' }];
    const result = mergeLabels(cur, [], false);
    expect(result[0].cur).toBe(0);
  });
});

// ─── findNoncashItems() ──────────────────────────────────────────────────

describe('findNoncashItems()', () => {
  it('detects depreciation expense', () => {
    const data = makeData({
      opex: [{ label: 'Depreciation Expense', amount: 25000 }],
    });
    const items = findNoncashItems(data);
    expect(items).toHaveLength(1);
    expect(items[0].label).toBe('Depreciation Expense');
    expect(items[0].amount).toBe(25000);
  });

  it('detects amortization expense', () => {
    const data = makeData({
      opex: [{ label: 'Amortization of Intangibles', amount: 5000 }],
    });
    const items = findNoncashItems(data);
    expect(items).toHaveLength(1);
    expect(items[0].label).toBe('Amortization of Intangibles');
    expect(items[0].amount).toBe(5000);
  });

  it('detects bad debt expense', () => {
    const data = makeData({
      opex: [{ label: 'Bad Debt Expense', amount: 3000 }],
    });
    const items = findNoncashItems(data);
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items.find(i => i.label === 'Bad Debt Expense')).toBeTruthy();
  });

  it('negates gain on disposal (negate rule)', () => {
    const data = makeData({
      other: [{ label: 'Gain on Sale of Equipment', amount: 8000 }],
    });
    const items = findNoncashItems(data);
    const gain = items.find(i => i.label === 'Gain on Sale of Equipment');
    expect(gain).toBeTruthy();
    expect(gain!.amount).toBe(-8000);
  });

  it('detects loss on disposal as positive (add-back)', () => {
    const data = makeData({
      other: [{ label: 'Loss on Disposal of Assets', amount: 2000 }],
    });
    const items = findNoncashItems(data);
    const loss = items.find(i => i.label === 'Loss on Disposal of Assets');
    expect(loss).toBeTruthy();
    expect(loss!.amount).toBe(2000);
  });

  it('returns empty array when no noncash items exist', () => {
    const data = makeData({
      opex: [
        { label: 'Salaries', amount: 100000 },
        { label: 'Rent', amount: 24000 },
      ],
    });
    const items = findNoncashItems(data);
    expect(items).toEqual([]);
  });

  it('deduplicates items by pattern label', () => {
    const data = makeData({
      opex: [
        { label: 'Depreciation - Buildings', amount: 10000 },
        { label: 'Depreciation - Equipment', amount: 15000 },
      ],
    });
    const items = findNoncashItems(data);
    // Only the first match for "Depreciation" pattern should appear
    expect(items).toHaveLength(1);
  });

  it('skips items already in manualLabels', () => {
    const data = makeData({
      opex: [{ label: 'Depreciation Expense', amount: 25000 }],
    });
    const items = findNoncashItems(data, ['Depreciation Expense']);
    expect(items).toEqual([]);
  });

  it('detects impairment losses', () => {
    const data = makeData({
      'noncurrent-assets': [{ label: 'Impairment of Goodwill', amount: 50000 }],
    });
    const items = findNoncashItems(data);
    expect(items).toHaveLength(1);
    expect(items[0].amount).toBe(50000);
  });

  it('handles string amounts', () => {
    const data = makeData({
      opex: [{ label: 'Depreciation Expense', amount: '25000' }],
    });
    const items = findNoncashItems(data);
    expect(items[0].amount).toBe(25000);
  });
});

// ─── computeWorkingCapitalChanges() ──────────────────────────────────────

describe('computeWorkingCapitalChanges()', () => {
  it('computes decrease in current asset as positive cash flow', () => {
    const cur = makeData({
      'current-assets': [{ label: 'Accounts Receivable', amount: 30000 }],
    });
    const prior = makeData({
      'current-assets': [{ label: 'Accounts Receivable', amount: 40000 }],
    });
    const changes = computeWorkingCapitalChanges(cur, prior);
    expect(changes).toHaveLength(1);
    expect(changes[0].label).toContain('Decrease');
    expect(changes[0].label).toContain('Accounts Receivable');
    expect(changes[0].amount).toBe(10000);
  });

  it('computes increase in current asset as negative cash flow', () => {
    const cur = makeData({
      'current-assets': [{ label: 'Inventory', amount: 50000 }],
    });
    const prior = makeData({
      'current-assets': [{ label: 'Inventory', amount: 30000 }],
    });
    const changes = computeWorkingCapitalChanges(cur, prior);
    expect(changes).toHaveLength(1);
    expect(changes[0].label).toContain('Increase');
    expect(changes[0].amount).toBe(-20000);
  });

  it('computes increase in current liability as positive cash flow', () => {
    // computeWorkingCapitalChanges uses 'current-liab' as the section key
    const cur = makeData({
      'current-liab': [{ label: 'Accounts Payable', amount: -15000 }],
    });
    const prior = makeData({
      'current-liab': [{ label: 'Accounts Payable', amount: -10000 }],
    });
    const changes = computeWorkingCapitalChanges(cur, prior);
    expect(changes).toHaveLength(1);
    expect(changes[0].label).toContain('Increase');
    expect(changes[0].label).toContain('Accounts Payable');
    expect(changes[0].amount).toBe(5000);
  });

  it('computes decrease in current liability as negative cash flow', () => {
    const cur = makeData({
      'current-liab': [{ label: 'Accounts Payable', amount: -8000 }],
    });
    const prior = makeData({
      'current-liab': [{ label: 'Accounts Payable', amount: -12000 }],
    });
    const changes = computeWorkingCapitalChanges(cur, prior);
    expect(changes).toHaveLength(1);
    expect(changes[0].label).toContain('Decrease');
    expect(changes[0].amount).toBe(-4000);
  });

  it('skips cash and cash-equivalent accounts', () => {
    const cur = makeData({
      'current-assets': [
        { label: 'Cash', amount: 50000 },
        { label: 'Cash Equivalents', amount: 10000 },
        { label: 'Bank Account', amount: 20000 },
        { label: 'Checking', amount: 5000 },
        { label: 'Savings', amount: 8000 },
        { label: 'Accounts Receivable', amount: 30000 },
      ],
    });
    const prior = makeData({
      'current-assets': [
        { label: 'Cash', amount: 40000 },
        { label: 'Cash Equivalents', amount: 8000 },
        { label: 'Bank Account', amount: 15000 },
        { label: 'Checking', amount: 3000 },
        { label: 'Savings', amount: 6000 },
        { label: 'Accounts Receivable', amount: 25000 },
      ],
    });
    const changes = computeWorkingCapitalChanges(cur, prior);
    // Only AR should produce a change; cash-like accounts are skipped
    expect(changes).toHaveLength(1);
    expect(changes[0].label).toContain('Accounts Receivable');
  });

  it('skips negligible changes (less than 0.005)', () => {
    const cur = makeData({
      'current-assets': [{ label: 'Prepaid Insurance', amount: 1000.001 }],
    });
    const prior = makeData({
      'current-assets': [{ label: 'Prepaid Insurance', amount: 1000.003 }],
    });
    const changes = computeWorkingCapitalChanges(cur, prior);
    expect(changes).toHaveLength(0);
  });

  it('returns empty array when no working capital items exist', () => {
    const cur = makeData();
    const prior = makeData();
    const changes = computeWorkingCapitalChanges(cur, prior);
    expect(changes).toEqual([]);
  });

  it('handles new current asset that did not exist in prior', () => {
    const cur = makeData({
      'current-assets': [{ label: 'Prepaid Rent', amount: 6000 }],
    });
    const prior = makeData();
    const changes = computeWorkingCapitalChanges(cur, prior);
    expect(changes).toHaveLength(1);
    expect(changes[0].label).toContain('Increase');
    expect(changes[0].amount).toBe(-6000);
  });

  it('handles prior-only current asset (removed in current period)', () => {
    const cur = makeData();
    const prior = makeData({
      'current-assets': [{ label: 'Prepaid Rent', amount: 6000 }],
    });
    const changes = computeWorkingCapitalChanges(cur, prior);
    expect(changes).toHaveLength(1);
    expect(changes[0].label).toContain('Decrease');
    expect(changes[0].amount).toBe(6000);
  });
});
