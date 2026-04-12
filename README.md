# NoteFlow

**Professional Financial Statement Generation Platform**

NoteFlow is a cloud-based SaaS application that automates GAAP-compliant financial statement generation for accountants and small firms. Users import trial balance data, and the platform auto-generates income statements, balance sheets, cash flow statements, disclosure notes, and financial ratio analysis — exportable as Excel workbooks or PDF packages.

---

## Table of Contents

- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Architecture](#architecture)
- [Getting Started](#getting-started)
- [Environment Variables](#environment-variables)
- [Scripts](#scripts)
- [Module Guide](#module-guide)
- [Key Architectural Patterns](#key-architectural-patterns)
- [Data Flow](#data-flow)
- [Firebase Services](#firebase-services)
- [Security](#security)
- [Testing](#testing)
- [Deployment](#deployment)
- [Subscription & Payments](#subscription--payments)
- [Admin Access](#admin-access)

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Language | TypeScript (strict mode) |
| Build | Vite |
| Testing | Vitest + jsdom |
| Hosting | Firebase Hosting |
| Auth | Firebase Authentication (email/password + 2FA) |
| Database | Cloud Firestore |
| Functions | Firebase Cloud Functions (Node.js 22) |
| Payments | Stripe (payment links + webhooks) |
| Excel I/O | SheetJS (XLSX) via CDN |
| PDF Export | jsPDF + AutoTable via CDN |
| Encryption | AES-256-GCM with PBKDF2 key derivation (Web Crypto API) |

No frontend framework — vanilla TypeScript with direct DOM manipulation and a custom event delegation system.

---

## Project Structure

```
noteflow/
├── index.html              # SPA entry point (all HTML structure)
├── src/
│   ├── main.ts             # App entry point, event delegation, action registry
│   ├── env.d.ts            # Vite environment type declarations
│   ├── css/
│   │   └── app.css         # All styles (~1,200 lines, includes dark mode)
│   └── modules/
│       ├── state.ts        # Centralized app state singleton + constants
│       ├── utils.ts        # Shared helpers (sum, fmt, esc, rows, etc.)
│       ├── config.ts       # Firebase init, encryption, error logging
│       ├── auth.ts         # Auth, subscriptions, 2FA, team management
│       ├── dashboard.ts    # Project grid, create/rename/delete projects
│       ├── data.ts         # Project CRUD, Firestore sync, import/export JSON
│       ├── import.ts       # Trial balance file import + account mapping
│       ├── statements.ts   # Income statement, balance sheet, cash flow builders
│       ├── notes.ts        # Disclosure notes generator + questionnaire
│       ├── export.ts       # Excel and PDF export
│       ├── templates.ts    # Statement formatting templates
│       ├── ui.ts           # Tab switching, trial balance editor, AJE entries
│       ├── workflow.ts     # Review workflow, comments, assignments
│       └── research.ts     # Company research (Wikipedia, SEC EDGAR)
├── tests/
│   ├── config.test.ts      # Encryption, ID generation
│   ├── import.test.ts      # CSV parsing, header normalization, TB parsing
│   ├── statements.test.ts  # Label merging, non-cash detection, working capital
│   ├── state.test.ts       # State initialization, section constants
│   └── utils.test.ts       # sum, fmt, esc, computeNetIncome, rows
├── functions/
│   ├── index.js            # Cloud Functions (Stripe webhooks, health, metrics)
│   └── package.json
├── firestore.rules          # Firestore security rules
├── firebase.json            # Firebase hosting + functions config
├── vite.config.ts
├── tsconfig.json
├── vitest.config.ts
├── .env.example             # Environment variable template
└── .env                     # Actual env vars (gitignored)
```

---

## Architecture

NoteFlow is a **single-page application** with 14 TypeScript modules (~7,500 lines total) organized by feature. The entry point (`main.ts`) imports all modules, wires cross-module callbacks, and sets up a centralized event delegation system.

### High-Level Flow

```
index.html
  └── src/main.ts (entry point)
        ├── Registers action handlers (data-action event delegation)
        ├── Wires cross-module callbacks (breaks circular deps)
        ├── Initializes Firebase
        ├── Bootstraps auth state
        └── Exposes dynamic-HTML functions on window
```

### Module Dependency Graph

```
main.ts ──→ all modules (imports + wiring)
  │
  ├── config.ts ──→ state.ts
  ├── auth.ts ──→ state.ts, data.ts, config.ts
  ├── dashboard.ts ──→ state.ts, data.ts, auth.ts
  ├── data.ts ──→ state.ts, config.ts, utils.ts
  ├── import.ts ──→ state.ts, utils.ts, data.ts
  ├── statements.ts ──→ state.ts, utils.ts, data.ts
  ├── notes.ts ──→ state.ts, utils.ts, data.ts, statements.ts
  ├── export.ts ──→ state.ts, utils.ts, data.ts, statements.ts
  ├── templates.ts ──→ state.ts, data.ts
  ├── ui.ts ──→ state.ts, utils.ts, data.ts, statements.ts, export.ts
  ├── workflow.ts ──→ state.ts, utils.ts, data.ts, dashboard.ts
  └── research.ts ──→ state.ts, utils.ts
```

---

## Getting Started

### Prerequisites

- Node.js >= 18
- npm
- Firebase CLI (`npm install -g firebase-tools`)

### Setup

```bash
# Clone the repository
git clone <repo-url>
cd noteflow

# Install dependencies
npm install
cd functions && npm install && cd ..

# Copy environment template and fill in values
cp .env.example .env
# Edit .env with your Firebase and Stripe credentials

# Start dev server
npm run dev
# Opens at http://localhost:3000
```

### First Run Checklist

1. Create a Firebase project at [console.firebase.google.com](https://console.firebase.google.com)
2. Enable **Email/Password** authentication
3. Create a **Firestore** database
4. Deploy Firestore rules: `npm run deploy:rules`
5. Deploy Cloud Functions: `npm run deploy:functions`
6. Add your domain to Firebase Auth > Settings > Authorized domains
7. Set up Stripe payment links and webhook endpoint
8. Fill in all `.env` values
9. Set `VITE_SIGNUPS_DISABLED=false` to allow new registrations

---

## Environment Variables

Create a `.env` file from `.env.example`:

| Variable | Description |
|----------|-------------|
| `VITE_FIREBASE_API_KEY` | Firebase Web API key |
| `VITE_FIREBASE_AUTH_DOMAIN` | Firebase auth domain (e.g., `your-app.firebaseapp.com`) |
| `VITE_FIREBASE_PROJECT_ID` | Firebase project ID |
| `VITE_FIREBASE_STORAGE_BUCKET` | Firebase storage bucket |
| `VITE_FIREBASE_MESSAGING_SENDER_ID` | Firebase messaging sender ID |
| `VITE_FIREBASE_APP_ID` | Firebase app ID |
| `VITE_STRIPE_PUBLISHABLE_KEY` | Stripe publishable key |
| `VITE_STRIPE_PAYMENT_LINK` | Stripe payment link (Individual plan) |
| `VITE_STRIPE_FIRM_PAYMENT_LINK` | Stripe payment link (Firm plan) |
| `VITE_SIGNUPS_DISABLED` | Set to `false` to allow new user registration |

All variables are prefixed with `VITE_` and accessed via `import.meta.env.VITE_*` at build time.

Cloud Functions use separate environment variables in `functions/.env`:

| Variable | Description |
|----------|-------------|
| `STRIPE_SECRET_KEY` | Stripe API secret key |
| `STRIPE_WEBHOOK_SECRET` | Webhook signature verification |
| `RESEND_API_KEY` | Resend email API key |

---

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start Vite dev server on port 3000 |
| `npm run build` | Production build to `dist/` |
| `npm run preview` | Preview production build locally |
| `npm run test` | Run all tests once |
| `npm run test:watch` | Run tests in watch mode |
| `npm run test:coverage` | Run tests with coverage report |
| `npm run typecheck` | TypeScript type checking (no emit) |
| `npm run deploy` | Build + deploy to Firebase Hosting |
| `npm run deploy:functions` | Deploy Cloud Functions only |
| `npm run deploy:rules` | Deploy Firestore security rules only |

---

## Module Guide

### `state.ts` — Centralized State (164 lines)

Singleton `AppState` class holding all application state. Modules import `{ state }` and access properties directly.

Key properties:
- `currentUserEmail`, `currentUserName` — Logged-in user
- `currentProjectId`, `currentData`, `priorData` — Active project data
- `firebaseApp`, `firebaseAuth`, `firebaseDb` — Firebase references
- `ajeEntries` — Adjusting journal entries

Exports section constants: `SECTIONS`, `SECTION_SIGN`, `VALID_SECTIONS`, `SECTION_GROUPS`, `SECTION_LABELS`.

### `main.ts` — Entry Point (~370 lines)

- **Action Registry**: Maps `data-action` attribute values to handler functions. A single `click` listener on `document` dispatches events.
- **Callback Wiring**: Calls setter functions (e.g., `setSaveProjectFn`, `setShowDashboardFn`) in `initApp()` to connect modules without circular imports.
- **Window Exports**: Exposes functions on `window` for dynamically generated inline `onclick` handlers.
- **Event Listeners**: Drag-and-drop import zone, file inputs, search, debounced saves.

### `config.ts` — Configuration (~225 lines)

Firebase initialization, AES-256-GCM encryption (PBKDF2 key derivation with 600k iterations), client-side error buffering to Firestore, safe mode kill-switch, analytics event tracking.

### `auth.ts` — Authentication (~900 lines)

Firebase email/password auth, sign-in/sign-up/forgot-password flows, TOTP-based 2FA, session management with expiry, subscription checking (Individual/Firm plans), Stripe checkout integration, team member management, firm profile settings.

### `data.ts` — Data Layer (~650 lines)

Project CRUD operations, localStorage persistence with Firestore cloud sync, encrypted storage support, project list management, trial balance data reset/load/save, JSON import/export.

### `import.ts` — File Import (~520 lines)

CSV/Excel file parsing, automatic header detection and column mapping, section classification with smart defaults, drag-and-drop upload zone, comparative (prior year) data import.

### `statements.ts` — Financial Statements (~1,070 lines)

Builds income statement, balance sheet, and cash flow statement HTML from trial balance data. Includes: indirect method cash flow (auto-detects non-cash items like depreciation), working capital change calculations, multi-period comparison, smart note suggestions based on line items.

### `notes.ts` — Disclosure Notes (~725 lines)

Interactive questionnaire for GAAP disclosure notes, auto-generates formatted notes from answers + trial balance data, disclosure completeness checklist, auto-detection of required disclosures (revenue recognition, PP&E, debt, leases, etc.).

### `export.ts` — Export (~835 lines)

Excel export via SheetJS (multi-sheet workbook with all statements), PDF export via jsPDF (formatted package with headers, footers, page numbers), `generateAll()` orchestrator that builds all statements.

### `ui.ts` — UI Interactions (~865 lines)

Tab switching, dark mode toggle, mobile menu, trial balance editor (inline add/edit/delete rows), prior year balance entry, AJE (adjusting journal entry) editor, financial ratio calculator, statement refresh.

### `workflow.ts` — Review Workflow (~635 lines)

Multi-stage review pipeline (Draft > In Review > Manager Approved > Partner Approved), reviewer assignment, comment threads, workflow history timeline, email notifications via Firestore queue, project filtering by status.

### `templates.ts` — Formatting Templates (~135 lines)

Statement formatting options (font sizes, decimal places, negative number display, header styles), template save/load/reset, caching for performance.

### `research.ts` — Company Research (~380 lines)

Fetches company info from Wikipedia and SEC EDGAR, extracts financial data points, presents findings with "Apply to Notes" actions for auto-populating disclosure fields.

### `utils.ts` — Shared Utilities (~185 lines)

`sum()` — totals a section's amounts, `fmt()` — currency formatting, `esc()` — HTML escaping, `rows()` — gets line items, `computeNetIncome()` — IS calculation, `hasPriorData()` — checks for comparative data.

---

## Key Architectural Patterns

### 1. Event Delegation

Static HTML elements use `data-action` and `data-param` attributes instead of inline `onclick` handlers:

```html
<button data-action="handleSignIn">Sign In</button>
<button data-action="switchTab" data-param="income">Income Statement</button>
```

A single listener in `main.ts` dispatches to the action registry:

```typescript
const actions: Record<string, (...args: any[]) => void> = {
  'handleSignIn': handleSignIn,
  'switchTab': switchTab,
  // ...
};
```

### 2. Callback Registration (Circular Dependency Avoidance)

Modules that need to call functions from other modules (creating circular imports) use a setter pattern:

```typescript
// In data.ts — declares a callback slot
let _applySmartDefaultsFn: (() => void) | null = null;
export function setApplySmartDefaultsFn(fn: () => void) {
  _applySmartDefaultsFn = fn;
}

// In main.ts — wires it up at init time
setApplySmartDefaultsFn(applySmartDefaults); // from statements.ts
```

Cross-module callbacks wired in `initApp()`:

| Setter | Source Module | Target Function |
|--------|-------------|-----------------|
| `setSaveProjectFn` | config.ts | `saveProject` from data.ts |
| `setShowDashboardFn` | auth.ts | `showDashboard` from dashboard.ts |
| `setApplyFirmProfileToNewProjectFn` | data.ts | `applyFirmProfileToNewProject` from auth.ts |
| `setApplySmartDefaultsFn` | data.ts | `applySmartDefaults` from statements.ts |
| `setSaveProjectWorkflowFn` | data.ts | `saveProjectWorkflow` from workflow.ts |
| `setTrackProjectPatternsFn` | data.ts | `trackProjectPatterns` from statements.ts |
| `setOnTemplateChanged` | templates.ts | Rebuilds all statements |

### 3. Window Exports for Dynamic HTML

Functions called from dynamically generated `innerHTML` (project cards, trial balance editor, AJE entries) are exposed on `window` via `Object.assign(window, {...})` in `main.ts`.

### 4. State Singleton

All modules share a single `state` object imported from `state.ts`. No state management library — direct property access with Firestore sync on save.

---

## Data Flow

```
1. IMPORT
   Excel/CSV file -> parseCSV() -> parseTB() -> account mapping UI
   -> applyImport() -> state.currentData[section] -> saveProject()

2. GENERATE
   state.currentData -> buildIncomeStatement() + buildBalanceSheet()
   + buildCashFlow() -> HTML rendered to #page-* divs

3. EXPORT
   state.currentData -> buildISData/buildBSData/buildCFData (arrays)
   -> SheetJS workbook -> .xlsx download
   OR -> jsPDF document -> .pdf download

4. PERSIST
   state -> JSON -> localStorage (encrypted if enabled)
                 -> Firestore (cloud sync)
```

### Account Sections

Trial balance rows are classified into sections:

| Section Key | Description | Normal Balance |
|------------|-------------|----------------|
| `revenue` | Revenue / Income | Credit (-1) |
| `cogs` | Cost of Goods Sold | Debit (+1) |
| `opex` | Operating Expenses | Debit (+1) |
| `other` | Other Income/Expense | Credit (-1) |
| `current-assets` | Current Assets | Debit (+1) |
| `noncurrent-assets` | Non-Current Assets | Debit (+1) |
| `current-liab` | Current Liabilities | Credit (-1) |
| `noncurrent-liab` | Non-Current Liabilities | Credit (-1) |
| `equity` | Shareholders' Equity | Credit (-1) |

---

## Firebase Services

### Authentication
- Email/password sign-in
- TOTP-based two-factor authentication
- Session expiry (configurable, default 30 days)

### Firestore Collections

| Collection | Purpose | Access |
|-----------|---------|--------|
| `users/{userId}` | User profile, subscription, Stripe refs | Owner only |
| `users/{userId}/projects/{projectId}` | Project data + workflow state | Owner only |
| `emailQueue/{emailId}` | Workflow notification emails | Authenticated create |
| `errorLogs/{logId}` | Client-side error reports | Authenticated create |
| `analytics/{dateId}` | Usage counters | Authenticated update |
| `config/safeMode` | Admin kill-switch | Admin read only |
| `dailyMetrics/{dateId}` | Backend metrics snapshots | Backend only |

### Cloud Functions

| Function | Trigger | Purpose |
|----------|---------|---------|
| `healthCheck` | HTTP | Tests Firestore + Stripe connectivity |
| `dailyMetricsSnapshot` | PubSub (daily) | Captures user/project counts |
| `cleanupErrorLogs` | PubSub (weekly) | Purges logs older than 7 days |
| `stripeWebhookHandler` | HTTP | Processes Stripe payment events |

---

## Security

- **Data Encryption**: Client-side AES-256-GCM encryption using PBKDF2-derived keys (600,000 iterations). Data encrypted before localStorage write. Key derived from user email + app secret.
- **CSP**: Content Security Policy headers block unauthorized script sources. No `unsafe-inline` or `unsafe-eval`.
- **Firestore Rules**: Row-level security — users can only access their own data. Subscription/plan fields are backend-write-only.
- **Safe Mode**: Admin kill-switch in Firestore (`config/safeMode`) that blocks destructive actions when enabled. Fails closed — if the check itself errors, the action is blocked.
- **Session Management**: Auth sessions expire after configurable duration. Checked on every page load.
- **Input Sanitization**: All user-generated content is HTML-escaped via `esc()` before DOM insertion.
- **Webhook Security**: Stripe webhook signature verification on every request.
- **Rate Limiting**: In-memory rate limiter on webhook endpoint (30 req/min per IP).

---

## Testing

```bash
npm run test          # Run all 121 tests
npm run test:watch    # Watch mode
npm run test:coverage # With coverage report
```

Test files cover core logic:

| Test File | Coverage |
|-----------|----------|
| `utils.test.ts` | `sum`, `fmt`, `esc`, `computeNetIncome`, `rows`, `hasPriorData` |
| `state.test.ts` | State initialization, section constants |
| `import.test.ts` | CSV parsing, header normalization, column detection, amount parsing |
| `statements.test.ts` | Label merging, non-cash item detection, working capital changes |
| `config.test.ts` | ID generation, AES encryption round-trip |

---

## Deployment

### Firebase Hosting (Frontend)

```bash
npm run deploy    # Builds + deploys to Firebase Hosting
```

This runs `vite build` then `firebase deploy --only hosting`. The built files in `dist/` are served as a single-page app with all routes rewriting to `index.html`.

### Cloud Functions

```bash
npm run deploy:functions
```

### Firestore Rules

```bash
npm run deploy:rules
```

### Pre-Deployment Checklist

1. Set `VITE_SIGNUPS_DISABLED=false` in `.env` (if allowing registrations)
2. Swap Stripe test keys for live keys in `.env`
3. Add your production domain to Firebase Auth > Authorized Domains
4. Verify Firestore rules are deployed
5. Verify Cloud Functions are deployed (Stripe webhook URL must match)
6. Run `npm run test` and `npm run typecheck` before deploying

---

## Subscription & Payments

Two plans managed via Stripe:

| Plan | Price | Features |
|------|-------|----------|
| Individual | $49/month | Single user, all features |
| Firm | $199/month | Team management, multi-user, firm profile |

- 14-day free trial for new accounts
- Payment via Stripe payment links (configured in `.env`)
- Stripe webhooks update subscription status in Firestore
- Subscription checked on login; gate UI shown if expired

---

## Admin Access

The admin account is identified by email (hardcoded in `dashboard.ts`). Admin features:

- Access to admin panel link on dashboard
- Trial banner hidden
- Access to safe mode configuration
- Access to health logs and daily metrics in Firestore

To change the admin email, update the check in `dashboard.ts` > `showDashboard()`.

---

## Workflow System

Multi-tier approval workflow for accounting firms:

```
Draft -> In Review -> Manager Approved -> Partner Approved
                  \-> Returned -> Draft (re-enter cycle)
```

- **Assignees**: Staff, Manager, Partner roles per project
- **Timeline**: Every status change logged with timestamp and user
- **Comments**: Threaded per-project, visible to all assignees
- **Email Alerts**: Automatic notifications at each workflow transition via Firestore emailQueue > Cloud Function > Resend

---

## Monitoring

- **Health Check**: `/healthCheck` endpoint tests Firestore and Stripe connectivity
- **Error Tracking**: Global `window.onerror` and `unhandledrejection` handlers buffer errors to Firestore
- **Usage Analytics**: Key events (logins, statement generation, exports) tracked as daily counters
- **Daily Metrics**: Scheduled function captures subscriber counts nightly
