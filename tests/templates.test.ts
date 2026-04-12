/* ═══════════════════════════════════════════════════════════════════════
   NoteFlow — templates.test.ts
   Unit tests for the statement template system.
   ═══════════════════════════════════════════════════════════════════════ */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { state } from '../src/modules/state';

// Mock config module
vi.mock('../src/modules/config', () => ({
  FIREBASE_ENABLED: false,
  ENCRYPTION_ENABLED: false,
  trackEvent: vi.fn(),
  getFirebaseUid: vi.fn(() => null),
}));

// Mock data module
vi.mock('../src/modules/data', () => ({
  cloudSaveUserData: vi.fn(() => Promise.resolve()),
}));

import {
  DEFAULT_TEMPLATE,
  loadTemplate,
  saveTemplate,
  getActiveTemplate,
  applyTemplateToStatements,
  openTemplate,
  closeTemplate,
  resetTemplate,
  setOnTemplateChanged,
  saveTemplateFromForm,
} from '../src/modules/templates';

// ─── DOM Setup ────────────────────────────────────────────────────────────────

function setupTemplateDOM(): void {
  document.body.innerHTML = `
    <div id="template-modal" class=""></div>
    <select id="tpl-font-family"><option value="Arial">Arial</option><option value="Georgia">Georgia</option></select>
    <select id="tpl-body-size"><option value="0.9rem">0.9rem</option><option value="1rem">1rem</option></select>
    <select id="tpl-company-align"><option value="center">Center</option><option value="left">Left</option></select>
    <select id="tpl-spacing"><option value="normal">Normal</option><option value="compact">Compact</option><option value="spacious">Spacious</option></select>
    <select id="tpl-negative-style"><option value="parentheses">Parentheses</option><option value="minus">Minus</option></select>
    <input id="tpl-decimals" type="number" value="2" />
    <select id="tpl-total-line"><option value="double">Double</option><option value="bold">Bold</option><option value="single">Single</option></select>
    <input id="tpl-section-color" type="color" value="#64748b" />
    <input id="tpl-header-color" type="color" value="#1e293b" />
    <input id="tpl-negative-color" type="color" value="#dc2626" />

    <div class="statement" style=""></div>
    <div class="statement" style=""></div>
    <div class="stmt-header" style=""></div>
    <table><tr class="section-header"><td></td></tr></table>
    <span class="negative" style=""></span>
    <table class="stmt-table"><tr><td></td></tr></table>
    <table><tr class="grand-total"><td></td></tr></table>
  `;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('DEFAULT_TEMPLATE', () => {
  it('has required font family', () => {
    expect(DEFAULT_TEMPLATE.fontFamily).toBeDefined();
    expect(typeof DEFAULT_TEMPLATE.fontFamily).toBe('string');
  });

  it('has default decimal places of 2', () => {
    expect(DEFAULT_TEMPLATE.decimals).toBe(2);
  });

  it('has default negative style of parentheses', () => {
    expect(DEFAULT_TEMPLATE.negativeStyle).toBe('parentheses');
  });

  it('has a section color', () => {
    expect(DEFAULT_TEMPLATE.sectionColor).toBeDefined();
  });

  it('has a header color', () => {
    expect(DEFAULT_TEMPLATE.headerColor).toBeDefined();
  });

  it('has a negative color', () => {
    expect(DEFAULT_TEMPLATE.negativeColor).toBeDefined();
  });

  it('has a body size', () => {
    expect(DEFAULT_TEMPLATE.bodySize).toBeDefined();
  });

  it('has a total line style', () => {
    expect(DEFAULT_TEMPLATE.totalLine).toBeDefined();
  });
});

describe('loadTemplate()', () => {
  beforeEach(() => {
    localStorage.clear();
    state.currentUserEmail = 'test@example.com';
    state._cachedTemplate = null;
  });

  it('returns DEFAULT_TEMPLATE when nothing stored', () => {
    const tpl = loadTemplate();
    expect(tpl.fontFamily).toBe(DEFAULT_TEMPLATE.fontFamily);
    expect(tpl.decimals).toBe(DEFAULT_TEMPLATE.decimals);
    expect(tpl.negativeStyle).toBe(DEFAULT_TEMPLATE.negativeStyle);
  });

  it('merges stored values with defaults', () => {
    localStorage.setItem('noteflow-template-test@example.com', JSON.stringify({
      fontFamily: 'Georgia',
      decimals: 0,
    }));
    const tpl = loadTemplate();
    expect(tpl.fontFamily).toBe('Georgia');
    expect(tpl.decimals).toBe(0);
    // Defaults should still be present for unset fields
    expect(tpl.negativeStyle).toBe(DEFAULT_TEMPLATE.negativeStyle);
    expect(tpl.sectionColor).toBe(DEFAULT_TEMPLATE.sectionColor);
  });

  it('handles corrupted localStorage gracefully', () => {
    localStorage.setItem('noteflow-template-test@example.com', 'invalid-json');
    const tpl = loadTemplate();
    expect(tpl.fontFamily).toBe(DEFAULT_TEMPLATE.fontFamily);
  });
});

describe('saveTemplate()', () => {
  beforeEach(() => {
    localStorage.clear();
    state.currentUserEmail = 'test@example.com';
    state._cachedTemplate = null;
  });

  it('saves template to localStorage', () => {
    const tpl = { ...DEFAULT_TEMPLATE, fontFamily: 'Courier New' };
    saveTemplate(tpl);
    const raw = localStorage.getItem('noteflow-template-test@example.com');
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!).fontFamily).toBe('Courier New');
  });

  it('updates the cached template', () => {
    const tpl = { ...DEFAULT_TEMPLATE, decimals: 0 };
    saveTemplate(tpl);
    expect(state._cachedTemplate).not.toBeNull();
    expect(state._cachedTemplate!.decimals).toBe(0);
  });

  it('saves a copy, not a reference', () => {
    const tpl = { ...DEFAULT_TEMPLATE };
    saveTemplate(tpl);
    tpl.fontFamily = 'Changed';
    expect(state._cachedTemplate!.fontFamily).not.toBe('Changed');
  });
});

describe('getActiveTemplate()', () => {
  beforeEach(() => {
    localStorage.clear();
    state.currentUserEmail = 'test@example.com';
    state._cachedTemplate = null;
  });

  it('returns cached template if available', () => {
    const cached = { ...DEFAULT_TEMPLATE, fontFamily: 'Cached Font' };
    state._cachedTemplate = cached;
    const tpl = getActiveTemplate();
    expect(tpl.fontFamily).toBe('Cached Font');
  });

  it('loads from localStorage when cache is empty', () => {
    localStorage.setItem('noteflow-template-test@example.com', JSON.stringify({
      fontFamily: 'Stored Font',
    }));
    const tpl = getActiveTemplate();
    expect(tpl.fontFamily).toBe('Stored Font');
  });

  it('populates cache after loading', () => {
    localStorage.setItem('noteflow-template-test@example.com', JSON.stringify({
      fontFamily: 'Loaded Font',
    }));
    expect(state._cachedTemplate).toBeNull();
    getActiveTemplate();
    expect(state._cachedTemplate).not.toBeNull();
    expect(state._cachedTemplate!.fontFamily).toBe('Loaded Font');
  });

  it('returns defaults when nothing stored and no cache', () => {
    const tpl = getActiveTemplate();
    expect(tpl.fontFamily).toBe(DEFAULT_TEMPLATE.fontFamily);
  });
});

describe('applyTemplateToStatements()', () => {
  beforeEach(() => {
    localStorage.clear();
    state.currentUserEmail = 'test@example.com';
    state._cachedTemplate = { ...DEFAULT_TEMPLATE };
    setupTemplateDOM();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('applies font family to .statement elements', () => {
    state._cachedTemplate = { ...DEFAULT_TEMPLATE, fontFamily: 'monospace' };
    applyTemplateToStatements();
    document.querySelectorAll<HTMLElement>('.statement').forEach((el) => {
      expect(el.style.fontFamily).toBe('monospace');
    });
  });

  it('applies header color to .stmt-header elements', () => {
    state._cachedTemplate = { ...DEFAULT_TEMPLATE, headerColor: '#ff0000' };
    applyTemplateToStatements();
    document.querySelectorAll<HTMLElement>('.stmt-header').forEach((el) => {
      expect(el.style.color).toBe('rgb(255, 0, 0)');
    });
  });

  it('applies section color to .section-header td elements', () => {
    state._cachedTemplate = { ...DEFAULT_TEMPLATE, sectionColor: '#00ff00' };
    applyTemplateToStatements();
    document.querySelectorAll<HTMLElement>('.section-header td').forEach((el) => {
      expect(el.style.color).toBe('rgb(0, 255, 0)');
    });
  });

  it('applies negative color to .negative elements', () => {
    state._cachedTemplate = { ...DEFAULT_TEMPLATE, negativeColor: '#0000ff' };
    applyTemplateToStatements();
    document.querySelectorAll<HTMLElement>('.negative').forEach((el) => {
      expect(el.style.color).toBe('rgb(0, 0, 255)');
    });
  });

  it('applies compact spacing', () => {
    state._cachedTemplate = { ...DEFAULT_TEMPLATE, spacing: 'compact' };
    applyTemplateToStatements();
    document.querySelectorAll<HTMLElement>('.stmt-table td').forEach((el) => {
      expect(el.style.padding).toBe('3px 8px');
    });
  });

  it('applies spacious spacing', () => {
    state._cachedTemplate = { ...DEFAULT_TEMPLATE, spacing: 'spacious' };
    applyTemplateToStatements();
    document.querySelectorAll<HTMLElement>('.stmt-table td').forEach((el) => {
      expect(el.style.padding).toBe('10px 8px');
    });
  });

  it('applies double total line border', () => {
    state._cachedTemplate = { ...DEFAULT_TEMPLATE, totalLine: 'double' };
    applyTemplateToStatements();
    document.querySelectorAll<HTMLElement>('.grand-total td').forEach((el) => {
      expect(el.style.borderTop).toContain('3px double');
    });
  });

  it('applies bold total line border', () => {
    state._cachedTemplate = { ...DEFAULT_TEMPLATE, totalLine: 'bold' };
    applyTemplateToStatements();
    document.querySelectorAll<HTMLElement>('.grand-total td').forEach((el) => {
      expect(el.style.borderTop).toContain('2px solid');
    });
  });
});

describe('openTemplate() / closeTemplate()', () => {
  beforeEach(() => {
    localStorage.clear();
    state.currentUserEmail = 'test@example.com';
    state._cachedTemplate = null;
    setupTemplateDOM();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('opens the template modal', () => {
    openTemplate();
    expect(document.getElementById('template-modal')!.classList.contains('open')).toBe(true);
  });

  it('populates form fields from template', () => {
    localStorage.setItem('noteflow-template-test@example.com', JSON.stringify({
      fontFamily: 'Georgia',
      decimals: 0,
    }));
    openTemplate();
    expect((document.getElementById('tpl-font-family') as HTMLSelectElement).value).toBe('Georgia');
    expect((document.getElementById('tpl-decimals') as HTMLInputElement).value).toBe('0');
  });

  it('closes the template modal', () => {
    document.getElementById('template-modal')!.classList.add('open');
    closeTemplate();
    expect(document.getElementById('template-modal')!.classList.contains('open')).toBe(false);
  });
});

describe('resetTemplate()', () => {
  beforeEach(() => {
    localStorage.clear();
    state.currentUserEmail = 'test@example.com';
    state._cachedTemplate = null;
    setupTemplateDOM();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('saves DEFAULT_TEMPLATE to storage', () => {
    // Store a custom template first
    localStorage.setItem('noteflow-template-test@example.com', JSON.stringify({
      fontFamily: 'Custom',
      decimals: 5,
    }));
    resetTemplate();
    const raw = localStorage.getItem('noteflow-template-test@example.com');
    const stored = JSON.parse(raw!);
    expect(stored.fontFamily).toBe(DEFAULT_TEMPLATE.fontFamily);
    expect(stored.decimals).toBe(DEFAULT_TEMPLATE.decimals);
  });

  it('updates the cached template to defaults', () => {
    state._cachedTemplate = { ...DEFAULT_TEMPLATE, fontFamily: 'Custom' };
    resetTemplate();
    expect(state._cachedTemplate!.fontFamily).toBe(DEFAULT_TEMPLATE.fontFamily);
  });
});

describe('setOnTemplateChanged()', () => {
  beforeEach(() => {
    localStorage.clear();
    state.currentUserEmail = 'test@example.com';
    state._cachedTemplate = null;
    setupTemplateDOM();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('registers a callback that is invoked on saveTemplateFromForm', () => {
    const callback = vi.fn();
    setOnTemplateChanged(callback);
    saveTemplateFromForm();
    expect(callback).toHaveBeenCalledOnce();
  });

  it('allows overwriting the callback', () => {
    const first = vi.fn();
    const second = vi.fn();
    setOnTemplateChanged(first);
    setOnTemplateChanged(second);
    saveTemplateFromForm();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });
});

describe('saveTemplateFromForm()', () => {
  beforeEach(() => {
    localStorage.clear();
    state.currentUserEmail = 'test@example.com';
    state._cachedTemplate = null;
    setupTemplateDOM();
    // Set form values
    (document.getElementById('tpl-font-family') as HTMLSelectElement).value = 'Georgia';
    (document.getElementById('tpl-body-size') as HTMLSelectElement).value = '1rem';
    (document.getElementById('tpl-company-align') as HTMLSelectElement).value = 'left';
    (document.getElementById('tpl-spacing') as HTMLSelectElement).value = 'compact';
    (document.getElementById('tpl-negative-style') as HTMLSelectElement).value = 'minus';
    (document.getElementById('tpl-decimals') as HTMLInputElement).value = '0';
    (document.getElementById('tpl-total-line') as HTMLSelectElement).value = 'bold';
    (document.getElementById('tpl-section-color') as HTMLInputElement).value = '#aabbcc';
    (document.getElementById('tpl-header-color') as HTMLInputElement).value = '#112233';
    (document.getElementById('tpl-negative-color') as HTMLInputElement).value = '#ff0000';
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('reads font family from form', () => {
    saveTemplateFromForm();
    const raw = JSON.parse(localStorage.getItem('noteflow-template-test@example.com')!);
    expect(raw.fontFamily).toBe('Georgia');
  });

  it('reads decimals from form as integer', () => {
    saveTemplateFromForm();
    const raw = JSON.parse(localStorage.getItem('noteflow-template-test@example.com')!);
    expect(typeof raw.decimals).toBe('number');
  });

  it('reads negative style from form', () => {
    saveTemplateFromForm();
    const raw = JSON.parse(localStorage.getItem('noteflow-template-test@example.com')!);
    expect(raw.negativeStyle).toBe('minus');
  });

  it('closes the modal after saving', () => {
    document.getElementById('template-modal')!.classList.add('open');
    saveTemplateFromForm();
    expect(document.getElementById('template-modal')!.classList.contains('open')).toBe(false);
  });

  it('reads all color values from form', () => {
    saveTemplateFromForm();
    const raw = JSON.parse(localStorage.getItem('noteflow-template-test@example.com')!);
    expect(raw.sectionColor).toBe('#aabbcc');
    expect(raw.headerColor).toBe('#112233');
    expect(raw.negativeColor).toBe('#ff0000');
  });
});
