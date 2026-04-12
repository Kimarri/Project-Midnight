/* ═══════════════════════════════════════════════════════════════════════
   NoteFlow — import.test.ts
   Unit tests for CSV parsing, header normalization, and trial balance import.
   ═══════════════════════════════════════════════════════════════════════ */

import { describe, it, expect } from 'vitest';
import {
  parseCSV,
  normalizeHeader,
  findCol,
  parseAmount,
  parseTB,
} from '../src/modules/import';

// ─── parseCSV() ───────────────────────────────────────────────────────────

describe('parseCSV()', () => {
  it('parses a basic comma-delimited CSV', () => {
    const result = parseCSV('a,b,c\n1,2,3');
    expect(result).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('handles quoted fields', () => {
    const result = parseCSV('"hello","world"\n"foo","bar"');
    expect(result).toEqual([
      ['hello', 'world'],
      ['foo', 'bar'],
    ]);
  });

  it('handles commas inside quoted fields', () => {
    const result = parseCSV('name,amount\n"Smith, John","1,234.56"');
    expect(result).toEqual([
      ['name', 'amount'],
      ['Smith, John', '1,234.56'],
    ]);
  });

  it('handles escaped double quotes inside quoted fields', () => {
    const result = parseCSV('"say ""hello""",value\ntest,123');
    expect(result).toEqual([
      ['say "hello"', 'value'],
      ['test', '123'],
    ]);
  });

  it('skips empty lines at the end (trims)', () => {
    const result = parseCSV('a,b\n1,2\n\n');
    expect(result).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('handles Windows-style CRLF line endings', () => {
    const result = parseCSV('a,b\r\n1,2\r\n');
    expect(result).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('handles tab-delimited files', () => {
    const result = parseCSV('a\tb\tc\n1\t2\t3');
    expect(result).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('handles semicolon-delimited files', () => {
    const result = parseCSV('a;b;c\n1;2;3');
    expect(result).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('trims whitespace from fields', () => {
    const result = parseCSV('  a , b \n 1 , 2 ');
    expect(result).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('returns a single row for a single-line CSV', () => {
    const result = parseCSV('a,b,c');
    expect(result).toEqual([['a', 'b', 'c']]);
  });
});

// ─── normalizeHeader() ────────────────────────────────────────────────────

describe('normalizeHeader()', () => {
  it('lowercases and strips non-alphanumeric characters', () => {
    expect(normalizeHeader('Account Name')).toBe('accountname');
  });

  it('handles already normalized input', () => {
    expect(normalizeHeader('debit')).toBe('debit');
  });

  it('strips special characters like underscores and hyphens', () => {
    expect(normalizeHeader('Account_Number')).toBe('accountnumber');
    expect(normalizeHeader('Prior-Debit')).toBe('priordebit');
  });

  it('handles empty string', () => {
    expect(normalizeHeader('')).toBe('');
  });

  it('handles headers with numbers', () => {
    expect(normalizeHeader('Column 1')).toBe('column1');
  });
});

// ─── findCol() ────────────────────────────────────────────────────────────

describe('findCol()', () => {
  it('finds the first matching candidate', () => {
    const headers = ['accountnumber', 'accountname', 'debit', 'credit'];
    expect(findCol(headers, ['accountnumber', 'acctno', 'account'])).toBe(0);
  });

  it('returns the index of the first match in candidates list order', () => {
    const headers = ['id', 'name', 'account', 'debit'];
    // 'account' is in position 2, 'id' is in position 0 — but candidate order matters
    expect(findCol(headers, ['account', 'id'])).toBe(2);
  });

  it('returns -1 when no candidate matches', () => {
    const headers = ['foo', 'bar', 'baz'];
    expect(findCol(headers, ['debit', 'dr'])).toBe(-1);
  });

  it('returns -1 for empty headers', () => {
    expect(findCol([], ['debit'])).toBe(-1);
  });

  it('returns -1 for empty candidates', () => {
    expect(findCol(['debit'], [])).toBe(-1);
  });
});

// ─── parseAmount() ────────────────────────────────────────────────────────

describe('parseAmount()', () => {
  it('parses a plain number', () => {
    expect(parseAmount('1234.56')).toBe(1234.56);
  });

  it('parses formatted numbers with commas', () => {
    expect(parseAmount('1,234.56')).toBe(1234.56);
  });

  it('parses parenthesized amounts as negative', () => {
    expect(parseAmount('(500)')).toBe(-500);
    expect(parseAmount('(1,234.56)')).toBe(-1234.56);
  });

  it('parses amounts with currency symbols', () => {
    expect(parseAmount('$1,234.56')).toBe(1234.56);
    expect(parseAmount('£500')).toBe(500);
    expect(parseAmount('€100.50')).toBe(100.50);
  });

  it('returns 0 for empty string', () => {
    expect(parseAmount('')).toBe(0);
  });

  it('returns 0 for non-numeric strings', () => {
    expect(parseAmount('abc')).toBe(0);
  });

  it('handles numeric input (not just strings)', () => {
    expect(parseAmount(42)).toBe(42);
    expect(parseAmount(0)).toBe(0);
  });

  it('parses negative strings without parentheses', () => {
    expect(parseAmount('-500')).toBe(-500);
  });

  it('handles spaces in the value', () => {
    expect(parseAmount(' 1 234 ')).toBe(1234);
  });
});

// ─── parseTB() ────────────────────────────────────────────────────────────

describe('parseTB()', () => {
  it('throws on empty input', () => {
    expect(() => parseTB([], 'combined')).toThrow('Trial balance is empty');
  });

  it('throws when Account Number column is missing', () => {
    const data = [['Name', 'Debit', 'Credit'], ['Cash', '100', '0']];
    expect(() => parseTB(data, 'combined')).toThrow('missing "Account Number"');
  });

  it('throws when Debit column is missing', () => {
    const data = [['Account Number', 'Name', 'Credit'], ['1000', 'Cash', '0']];
    expect(() => parseTB(data, 'combined')).toThrow('missing "Debit"');
  });

  it('throws when Credit column is missing', () => {
    const data = [['Account Number', 'Name', 'Debit'], ['1000', 'Cash', '100']];
    expect(() => parseTB(data, 'combined')).toThrow('missing "Credit"');
  });

  it('parses a basic trial balance', () => {
    const data = [
      ['Account Number', 'Account Name', 'Debit', 'Credit'],
      ['1000', 'Cash', '50000', '0'],
      ['2000', 'Accounts Payable', '0', '12000'],
    ];
    const result = parseTB(data, 'combined');
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      accountNumber: '1000',
      accountName: 'Cash',
      debit: 50000,
      credit: 0,
      section: undefined,
    });
    expect(result[1]).toEqual({
      accountNumber: '2000',
      accountName: 'Accounts Payable',
      debit: 0,
      credit: 12000,
      section: undefined,
    });
  });

  it('reads section column in combined mode', () => {
    const data = [
      ['Account Number', 'Account Name', 'Debit', 'Credit', 'Section'],
      ['1000', 'Cash', '50000', '0', 'current-assets'],
    ];
    const result = parseTB(data, 'combined');
    expect(result[0].section).toBe('current-assets');
  });

  it('ignores section column when mode is not combined', () => {
    const data = [
      ['Account Number', 'Account Name', 'Debit', 'Credit', 'Section'],
      ['1000', 'Cash', '50000', '0', 'current-assets'],
    ];
    const result = parseTB(data, 'current');
    expect(result[0].section).toBeUndefined();
  });

  it('skips empty rows', () => {
    const data = [
      ['Account Number', 'Account Name', 'Debit', 'Credit'],
      ['1000', 'Cash', '50000', '0'],
      ['', '', '', ''],
      ['2000', 'AP', '0', '5000'],
    ];
    const result = parseTB(data, 'combined');
    expect(result).toHaveLength(2);
  });

  it('skips rows with no account number', () => {
    const data = [
      ['Account Number', 'Account Name', 'Debit', 'Credit'],
      ['', 'Total', '50000', '50000'],
    ];
    const result = parseTB(data, 'combined');
    expect(result).toHaveLength(0);
  });

  it('parses comparative columns when present', () => {
    const data = [
      ['Account Number', 'Account Name', 'Debit', 'Credit', 'Prior Debit', 'Prior Credit'],
      ['1000', 'Cash', '50000', '0', '40000', '0'],
    ];
    const result = parseTB(data, 'combined');
    expect(result._hasComparative).toBe(true);
    expect(result[0].priorDebit).toBe(40000);
    expect(result[0].priorCredit).toBe(0);
  });

  it('sets _hasComparative to false when no prior columns', () => {
    const data = [
      ['Account Number', 'Account Name', 'Debit', 'Credit'],
      ['1000', 'Cash', '50000', '0'],
    ];
    const result = parseTB(data, 'combined');
    expect(result._hasComparative).toBe(false);
  });

  it('uses account number as name when name column is missing', () => {
    const data = [
      ['Account Number', 'Debit', 'Credit'],
      ['1000', '50000', '0'],
    ];
    const result = parseTB(data, 'combined');
    expect(result[0].accountName).toBe('1000');
  });

  it('handles alternative header names (Acct No, Dr, Cr)', () => {
    const data = [
      ['Acct No', 'Description', 'Dr', 'Cr'],
      ['1000', 'Cash', '50000', '0'],
    ];
    const result = parseTB(data, 'combined');
    expect(result).toHaveLength(1);
    expect(result[0].accountNumber).toBe('1000');
    expect(result[0].accountName).toBe('Cash');
    expect(result[0].debit).toBe(50000);
  });
});
