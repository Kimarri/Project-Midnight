/* ═══════════════════════════════════════════════════════════════════════
   NoteFlow — state.ts
   Centralized application state store. All mutable state lives here.
   Modules import what they need instead of relying on globals.
   ═══════════════════════════════════════════════════════════════════════ */

// ─── Types ──────────────────────────────────────────────────────────────
export interface LineItem {
  label: string;
  amount: number | string;
}

export interface SectionData {
  [section: string]: LineItem[];
}

export interface ProjectNotes {
  [key: string]: string | string[] | boolean | undefined;
}

export interface AJELine {
  account: string;
  section: string;
  debit: number;
  credit: number;
}

export interface AJEEntry {
  description: string;
  date: string;
  lines: AJELine[];
}

// ─── Consolidation Types ───────────────────────────────────────────────
export interface EntityData {
  name: string;
  currentData: SectionData;
  priorData: SectionData;
}

export interface EliminationLine {
  section: string;
  label: string;
  debit: number;
  credit: number;
}

export interface EliminationEntry {
  description: string;
  lines: EliminationLine[];
}

export interface FirmProfile {
  firmName?: string;
  address?: string;
  phone?: string;
  email?: string;
  ein?: string;
  logo?: string;
}

export interface StatementTemplate {
  fontFamily: string;
  headerSize?: string;
  bodySize?: string;
  companyAlign?: string;
  spacing?: string;
  decimals?: number;
  negativeStyle?: string;
  totalLine?: string;
  sectionColor?: string;
  headerColor?: string;
  negativeColor?: string;
  showCurrency?: boolean;
  currencySymbol?: string;
  thousandsSeparator?: boolean;
}

// ─── Section Constants ──────────────────────────────────────────────────
export const SECTIONS: string[] = [
  'revenue', 'cogs', 'opex', 'other',
  'current-assets', 'noncurrent-assets',
  'current-liab', 'noncurrent-liab',
  'equity',
  'cf-operating', 'cf-investing', 'cf-financing',
];

export const SECTION_SIGN: Record<string, number> = {
  'revenue': -1,
  'cogs': 1,
  'opex': 1,
  'other': -1,
  'current-assets': 1,
  'noncurrent-assets': 1,
  'current-liab': -1,
  'noncurrent-liab': -1,
  'equity': -1,
  'cf-operating': 1,
  'cf-investing': 1,
  'cf-financing': 1,
};

export const VALID_SECTIONS = new Set(Object.keys(SECTION_SIGN));

export const SECTION_GROUPS: string[][] = [
  ['revenue', 'cogs', 'opex', 'other'],
  ['current-assets', 'noncurrent-assets', 'current-liab', 'noncurrent-liab', 'equity'],
  ['cf-operating', 'cf-investing', 'cf-financing'],
];

export const SECTION_LABELS: Record<string, string> = {
  'revenue': 'Revenue',
  'cogs': 'Cost of Goods Sold',
  'opex': 'Operating Expenses',
  'other': 'Other Income / Expense',
  'current-assets': 'Current Assets',
  'noncurrent-assets': 'Non-Current Assets',
  'current-liab': 'Current Liabilities',
  'noncurrent-liab': 'Non-Current Liabilities',
  'equity': 'Equity',
  'cf-operating': 'CF: Operating Activities',
  'cf-investing': 'CF: Investing Activities',
  'cf-financing': 'CF: Financing Activities',
};

// ─── Application State ──────────────────────────────────────────────────
class AppState {
  // Current period data
  currentData: SectionData = {};
  priorData: SectionData = {};

  // Active project
  currentProjectId: string | null = null;
  currentUserEmail: string | null = null;
  currentUserName: string | null = null;

  // Firebase references (set during init)
  firebaseApp: any = null;
  firebaseAuth: any = null;
  firebaseDb: any = null;

  // Encryption cache
  _cachedEncKey: CryptoKey | null = null;
  _cachedEncKeyEmail: string | null = null;
  _cachedTemplate: StatementTemplate | null = null;

  // AJE state
  ajeEntries: AJEEntry[] = [];
  ajePosted: boolean = false;
  ajePrePostData: SectionData | null = null;

  // Consolidation state
  entities: EntityData[] = [];
  eliminations: EliminationEntry[] = [];
  consolidationMode: boolean = false;
  selectedEntityIndex: number = 0;

  // Import state
  importFiles: { combined: File | null } = { combined: null };
  pendingUnmapped: any[] = [];
  pendingTargetData: SectionData | null = null;

  // Error buffer
  _errorBuffer: any[] = [];
  _errorFlushTimer: ReturnType<typeof setInterval> | null = null;

  // Note ordering (array of note section IDs in display order)
  noteOrder: string[] = [];

  // Payment polling
  _paymentPollInterval: ReturnType<typeof setInterval> | null = null;

  // Save debounce
  _saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  // Workflow modal state
  _currentWorkflowProjectId: string | null = null;

  constructor() {
    this.resetData();
  }

  resetData(): void {
    SECTIONS.forEach(s => {
      this.currentData[s] = [];
      this.priorData[s] = [];
    });
  }
}

// Singleton instance
export const state = new AppState();
