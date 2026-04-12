/* ═══════════════════════════════════════════════════════════════════════
   NoteFlow — state.test.ts
   Unit tests for centralized state store.
   ═══════════════════════════════════════════════════════════════════════ */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  state, SECTIONS, SECTION_SIGN, SECTION_GROUPS, SECTION_LABELS, VALID_SECTIONS,
} from '../src/modules/state';

describe('State Store', () => {
  beforeEach(() => {
    state.resetData();
  });

  it('initializes all sections as empty arrays', () => {
    for (const section of SECTIONS) {
      expect(state.currentData[section]).toEqual([]);
      expect(state.priorData[section]).toEqual([]);
    }
  });

  it('resetData() clears all section data', () => {
    state.currentData['revenue'] = [{ label: 'Test', amount: 100 }];
    state.priorData['opex'] = [{ label: 'Rent', amount: 500 }];
    state.resetData();
    expect(state.currentData['revenue']).toEqual([]);
    expect(state.priorData['opex']).toEqual([]);
  });

  it('starts with null project and user', () => {
    expect(state.currentProjectId).toBeNull();
    expect(state.currentUserEmail).toBeNull();
    expect(state.currentUserName).toBeNull();
  });

  it('starts with empty AJE state', () => {
    expect(state.ajeEntries).toEqual([]);
    expect(state.ajePosted).toBe(false);
    expect(state.ajePrePostData).toBeNull();
  });
});

describe('Section Constants', () => {
  it('has 12 sections', () => {
    expect(SECTIONS).toHaveLength(12);
  });

  it('all sections have sign values', () => {
    for (const section of SECTIONS) {
      expect(SECTION_SIGN[section]).toBeDefined();
      expect([-1, 1]).toContain(SECTION_SIGN[section]);
    }
  });

  it('all sections have labels', () => {
    for (const section of SECTIONS) {
      expect(SECTION_LABELS[section]).toBeDefined();
      expect(typeof SECTION_LABELS[section]).toBe('string');
    }
  });

  it('VALID_SECTIONS matches SECTION_SIGN keys', () => {
    expect(VALID_SECTIONS.size).toBe(Object.keys(SECTION_SIGN).length);
    for (const key of Object.keys(SECTION_SIGN)) {
      expect(VALID_SECTIONS.has(key)).toBe(true);
    }
  });

  it('SECTION_GROUPS covers all sections', () => {
    const allGrouped = SECTION_GROUPS.flat();
    expect(allGrouped.sort()).toEqual([...SECTIONS].sort());
  });

  it('revenue is credit-normal (sign = -1)', () => {
    expect(SECTION_SIGN['revenue']).toBe(-1);
  });

  it('assets are debit-normal (sign = 1)', () => {
    expect(SECTION_SIGN['current-assets']).toBe(1);
    expect(SECTION_SIGN['noncurrent-assets']).toBe(1);
  });

  it('liabilities are credit-normal (sign = -1)', () => {
    expect(SECTION_SIGN['current-liab']).toBe(-1);
    expect(SECTION_SIGN['noncurrent-liab']).toBe(-1);
  });

  it('equity is credit-normal (sign = -1)', () => {
    expect(SECTION_SIGN['equity']).toBe(-1);
  });
});
