/* ═══════════════════════════════════════════════════════════════════════
   NoteFlow — templates.ts
   Statement template system (fonts, formatting, number display)
   ═══════════════════════════════════════════════════════════════════════ */

import { state, type StatementTemplate } from './state';
import { el, elInput } from './utils';
import { cloudSaveUserData } from './data';

// ─── Statement Template System ─────────────────────────────────────────────
export const DEFAULT_TEMPLATE: StatementTemplate = {
  fontFamily: "system-ui, -apple-system, sans-serif",
  bodySize: "0.9rem",
  companyAlign: "center",
  spacing: "normal",
  negativeStyle: "parentheses",
  decimals: 2,
  totalLine: "double",
  sectionColor: "#64748b",
  headerColor: "#1e293b",
  negativeColor: "#dc2626"
};

export function loadTemplate(): StatementTemplate {
  try {
    return Object.assign(
      {},
      DEFAULT_TEMPLATE,
      JSON.parse(localStorage.getItem('noteflow-template-' + state.currentUserEmail) || '{}')
    );
  } catch (e: unknown) {
    return Object.assign({}, DEFAULT_TEMPLATE);
  }
}

export function saveTemplate(tpl: StatementTemplate): void {
  state._cachedTemplate = Object.assign({}, tpl);
  localStorage.setItem('noteflow-template-' + state.currentUserEmail, JSON.stringify(tpl));
  cloudSaveUserData('template', tpl);
}

export function getActiveTemplate(): StatementTemplate {
  if (state._cachedTemplate) return state._cachedTemplate;
  state._cachedTemplate = loadTemplate();
  return state._cachedTemplate;
}

export function applyTemplateToStatements(): void {
  const tpl: StatementTemplate = getActiveTemplate();

  document.querySelectorAll<HTMLElement>('.statement').forEach((el: HTMLElement): void => {
    el.style.fontFamily = tpl.fontFamily;
    el.style.fontSize = tpl.bodySize ?? '0.9rem';
  });

  document.querySelectorAll<HTMLElement>('.stmt-header').forEach((el: HTMLElement): void => {
    el.style.textAlign = tpl.companyAlign ?? 'center';
    el.style.color = tpl.headerColor ?? '#1e293b';
  });

  document.querySelectorAll<HTMLElement>('.section-header td').forEach((el: HTMLElement): void => {
    el.style.color = tpl.sectionColor ?? '#64748b';
  });

  document.querySelectorAll<HTMLElement>('.negative').forEach((el: HTMLElement): void => {
    el.style.color = tpl.negativeColor ?? '#dc2626';
  });

  const spacingPad: string =
    tpl.spacing === 'compact' ? '3px 8px' :
    tpl.spacing === 'spacious' ? '10px 8px' :
    '6px 8px';

  document.querySelectorAll<HTMLElement>('.stmt-table td').forEach((el: HTMLElement): void => {
    el.style.padding = spacingPad;
  });

  const totalBorder: string =
    tpl.totalLine === 'double' ? '3px double #1e293b' :
    tpl.totalLine === 'bold' ? '2px solid #1e293b' :
    '1px solid #1e293b';

  document.querySelectorAll<HTMLElement>('.grand-total td').forEach((el: HTMLElement): void => {
    el.style.borderTop = totalBorder;
  });
}

export function openTemplate(): void {
  const tpl: StatementTemplate = loadTemplate();
  const tplFields: [string, string][] = [
    ['tpl-font-family', tpl.fontFamily],
    ['tpl-body-size', tpl.bodySize ?? '0.9rem'],
    ['tpl-company-align', tpl.companyAlign ?? 'center'],
    ['tpl-spacing', tpl.spacing ?? 'normal'],
    ['tpl-negative-style', tpl.negativeStyle ?? 'parentheses'],
    ['tpl-decimals', String(tpl.decimals ?? 2)],
    ['tpl-total-line', tpl.totalLine ?? 'double'],
    ['tpl-section-color', tpl.sectionColor ?? '#64748b'],
    ['tpl-header-color', tpl.headerColor ?? '#1e293b'],
    ['tpl-negative-color', tpl.negativeColor ?? '#dc2626'],
  ];
  tplFields.forEach(function([id, val]) {
    const fieldEl = elInput(id);
    if (fieldEl) fieldEl.value = val;
  });
  el('template-modal')?.classList.add('open');
}

export function closeTemplate(): void {
  el('template-modal')?.classList.remove('open');
}

export function resetTemplate(): void {
  saveTemplate(DEFAULT_TEMPLATE);
  openTemplate();
}

// Callback for rebuilding statements after template change.
// Set by main.ts to avoid circular dependency with statements module.
let _onTemplateChanged: (() => void) | null = null;
export function setOnTemplateChanged(fn: () => void): void {
  _onTemplateChanged = fn;
}

export function saveTemplateFromForm(): void {
  const tpl: StatementTemplate = {
    fontFamily: elInput('tpl-font-family')?.value ?? '',
    bodySize: elInput('tpl-body-size')?.value ?? '0.9rem',
    companyAlign: elInput('tpl-company-align')?.value ?? 'center',
    spacing: elInput('tpl-spacing')?.value ?? 'normal',
    negativeStyle: elInput('tpl-negative-style')?.value ?? 'parentheses',
    decimals: parseInt(elInput('tpl-decimals')?.value ?? '2') || 2,
    totalLine: elInput('tpl-total-line')?.value ?? 'double',
    sectionColor: elInput('tpl-section-color')?.value ?? '#64748b',
    headerColor: elInput('tpl-header-color')?.value ?? '#1e293b',
    negativeColor: elInput('tpl-negative-color')?.value ?? '#dc2626'
  };
  saveTemplate(tpl);
  closeTemplate();
  if (_onTemplateChanged) _onTemplateChanged();
}
