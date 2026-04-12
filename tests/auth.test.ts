/* ═══════════════════════════════════════════════════════════════════════
   NoteFlow — auth.test.ts
   Unit tests for authentication, session handling, and user management.
   ═══════════════════════════════════════════════════════════════════════ */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { state } from '../src/modules/state';

// Mock config module to avoid import.meta.env issues
vi.mock('../src/modules/config', () => ({
  FIREBASE_ENABLED: false,
  ENCRYPTION_ENABLED: false,
  STRIPE_CONFIG: {},
  STRIPE_ENABLED: false,
  trackEvent: vi.fn(),
  getFirebaseUid: vi.fn(() => null),
  genId: vi.fn(() => 'mock-uuid-1234'),
}));

// Mock data module to isolate auth tests
vi.mock('../src/modules/data', () => ({
  cloudSaveUserData: vi.fn(() => Promise.resolve()),
  cloudLoadUserData: vi.fn(() => Promise.resolve(null)),
  migrateToCloud: vi.fn(() => Promise.resolve()),
  getProjectList: vi.fn(() => []),
  getProjectListCloud: vi.fn((cb: any) => cb([])),
  saveProjectList: vi.fn(),
  saveProject: vi.fn(),
}));

import {
  AUTH_SESSION_KEY,
  AUTH_USERS_KEY,
  SESSION_EXPIRY_MS,
  hashPassword,
  getUsers,
  saveUsers,
  showAuthView,
  isSessionExpired,
  loginSession,
  authMsg,
} from '../src/modules/auth';

// ─── DOM Setup Helper ─────────────────────────────────────────────────────────

function setupAuthDOM(): void {
  document.body.innerHTML = `
    <div id="login-screen" style="display:flex"></div>
    <div id="app-wrapper"></div>
    <div id="dashboard"></div>
    <div id="subscription-gate" style="display:none"></div>
    <div id="auth-signin" style="display:block"></div>
    <div id="auth-signup" style="display:none"></div>
    <div id="auth-forgot" style="display:none"></div>
    <div id="auth-2fa" style="display:none"></div>
    <div id="signin-msg"></div>
    <div id="signup-msg"></div>
    <div id="forgot-msg"></div>
    <div id="2fa-signin-msg"></div>
    <div id="security-badge" style="display:none"></div>
    <div id="cloud-sync-badge" style="display:none"></div>
    <div id="dash-user-display"></div>
    <div id="dash-greeting"></div>
    <div id="user-display"></div>
    <div id="project-grid"></div>
    <div id="admin-link" style="display:none"></div>
    <div id="sub-trial-banner" style="display:none"></div>
  `;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Auth Constants', () => {
  it('AUTH_SESSION_KEY is defined as a non-empty string', () => {
    expect(AUTH_SESSION_KEY).toBeDefined();
    expect(typeof AUTH_SESSION_KEY).toBe('string');
    expect(AUTH_SESSION_KEY.length).toBeGreaterThan(0);
  });

  it('AUTH_USERS_KEY is defined as a non-empty string', () => {
    expect(AUTH_USERS_KEY).toBeDefined();
    expect(typeof AUTH_USERS_KEY).toBe('string');
    expect(AUTH_USERS_KEY.length).toBeGreaterThan(0);
  });

  it('SESSION_EXPIRY_MS is a positive number', () => {
    expect(SESSION_EXPIRY_MS).toBeGreaterThan(0);
  });

  it('AUTH_SESSION_KEY and AUTH_USERS_KEY are different', () => {
    expect(AUTH_SESSION_KEY).not.toBe(AUTH_USERS_KEY);
  });
});

describe('hashPassword()', () => {
  const hasCryptoSubtle = typeof crypto !== 'undefined' && !!crypto.subtle;

  it.skipIf(!hasCryptoSubtle)('returns a hex string', async () => {
    const hash = await hashPassword('testPassword123');
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });

  it.skipIf(!hasCryptoSubtle)('returns a 64-character SHA-256 hex digest', async () => {
    const hash = await hashPassword('testPassword123');
    expect(hash).toHaveLength(64);
  });

  it.skipIf(!hasCryptoSubtle)('returns consistent hash for the same input', async () => {
    const hash1 = await hashPassword('MyPassword1');
    const hash2 = await hashPassword('MyPassword1');
    expect(hash1).toBe(hash2);
  });

  it.skipIf(!hasCryptoSubtle)('returns different hashes for different inputs', async () => {
    const hash1 = await hashPassword('password1');
    const hash2 = await hashPassword('password2');
    expect(hash1).not.toBe(hash2);
  });

  it.skipIf(!hasCryptoSubtle)('includes a pepper in the hash', async () => {
    // Same password should produce different hash than raw SHA-256
    const hash = await hashPassword('test');
    // If we hash "test" alone it would be different from "test-noteflow-auth-pepper-v1"
    const rawEncoder = new TextEncoder();
    const rawHash = await crypto.subtle.digest('SHA-256', rawEncoder.encode('test'));
    const rawArr = new Uint8Array(rawHash);
    let rawHex = '';
    for (let i = 0; i < rawArr.length; i++) rawHex += ('0' + rawArr[i].toString(16)).slice(-2);
    expect(hash).not.toBe(rawHex);
  });
});

describe('getUsers() / saveUsers()', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns empty object when no users stored', () => {
    const users = getUsers();
    expect(users).toEqual({});
  });

  it('round-trips user data through save and get', () => {
    const userData = {
      'alice@example.com': { name: 'Alice', password: 'abc123hash' },
      'bob@example.com': { name: 'Bob', password: 'def456hash' },
    };
    saveUsers(userData);
    const result = getUsers();
    expect(result).toEqual(userData);
  });

  it('overwrites existing user data on save', () => {
    saveUsers({ 'old@test.com': { name: 'Old' } });
    saveUsers({ 'new@test.com': { name: 'New' } });
    const users = getUsers();
    expect(users['old@test.com']).toBeUndefined();
    expect(users['new@test.com']).toEqual({ name: 'New' });
  });

  it('handles corrupted localStorage gracefully', () => {
    localStorage.setItem(AUTH_USERS_KEY, 'not-valid-json{{{');
    const users = getUsers();
    expect(users).toEqual({});
  });

  it('stores data under the correct localStorage key', () => {
    saveUsers({ 'test@test.com': { name: 'Test' } });
    const raw = localStorage.getItem(AUTH_USERS_KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toEqual({ 'test@test.com': { name: 'Test' } });
  });
});

describe('showAuthView()', () => {
  beforeEach(() => {
    setupAuthDOM();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('shows signin view and hides others', () => {
    showAuthView('signin');
    expect(document.getElementById('auth-signin')!.style.display).toBe('block');
    expect(document.getElementById('auth-signup')!.style.display).toBe('none');
    expect(document.getElementById('auth-forgot')!.style.display).toBe('none');
    expect(document.getElementById('auth-2fa')!.style.display).toBe('none');
  });

  it('shows signup view and hides others', () => {
    showAuthView('signup');
    expect(document.getElementById('auth-signin')!.style.display).toBe('none');
    expect(document.getElementById('auth-signup')!.style.display).toBe('block');
    expect(document.getElementById('auth-forgot')!.style.display).toBe('none');
    expect(document.getElementById('auth-2fa')!.style.display).toBe('none');
  });

  it('shows forgot view and hides others', () => {
    showAuthView('forgot');
    expect(document.getElementById('auth-signin')!.style.display).toBe('none');
    expect(document.getElementById('auth-signup')!.style.display).toBe('none');
    expect(document.getElementById('auth-forgot')!.style.display).toBe('block');
    expect(document.getElementById('auth-2fa')!.style.display).toBe('none');
  });

  it('shows 2fa view and hides others', () => {
    showAuthView('2fa');
    expect(document.getElementById('auth-signin')!.style.display).toBe('none');
    expect(document.getElementById('auth-signup')!.style.display).toBe('none');
    expect(document.getElementById('auth-forgot')!.style.display).toBe('none');
    expect(document.getElementById('auth-2fa')!.style.display).toBe('block');
  });

  it('clears all message containers', () => {
    document.getElementById('signin-msg')!.innerHTML = '<div>Error</div>';
    document.getElementById('signup-msg')!.innerHTML = '<div>Error</div>';
    document.getElementById('forgot-msg')!.innerHTML = '<div>Error</div>';
    document.getElementById('2fa-signin-msg')!.innerHTML = '<div>Error</div>';
    showAuthView('signin');
    expect(document.getElementById('signin-msg')!.innerHTML).toBe('');
    expect(document.getElementById('signup-msg')!.innerHTML).toBe('');
    expect(document.getElementById('forgot-msg')!.innerHTML).toBe('');
    expect(document.getElementById('2fa-signin-msg')!.innerHTML).toBe('');
  });
});

describe('isSessionExpired()', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns true when no session exists', () => {
    expect(isSessionExpired()).toBe(true);
  });

  it('returns true for corrupted session data', () => {
    localStorage.setItem(AUTH_SESSION_KEY, 'bad-json');
    expect(isSessionExpired()).toBe(true);
  });

  it('returns true when session has no loginAt', () => {
    localStorage.setItem(AUTH_SESSION_KEY, JSON.stringify({ email: 'test@test.com' }));
    expect(isSessionExpired()).toBe(true);
  });

  it('returns false for a fresh session', () => {
    localStorage.setItem(AUTH_SESSION_KEY, JSON.stringify({
      email: 'test@test.com',
      loginAt: Date.now(),
    }));
    expect(isSessionExpired()).toBe(false);
  });

  it('returns true for an expired session', () => {
    localStorage.setItem(AUTH_SESSION_KEY, JSON.stringify({
      email: 'test@test.com',
      loginAt: Date.now() - SESSION_EXPIRY_MS - 1000,
    }));
    expect(isSessionExpired()).toBe(true);
  });
});

describe('loginSession()', () => {
  beforeEach(() => {
    localStorage.clear();
    state.currentUserEmail = null;
    state.currentUserName = null;
    state.currentProjectId = null;
    setupAuthDOM();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('sets state.currentUserEmail', () => {
    loginSession('user@test.com', 'Test User');
    expect(state.currentUserEmail).toBe('user@test.com');
  });

  it('sets state.currentUserName', () => {
    loginSession('user@test.com', 'Test User');
    expect(state.currentUserName).toBe('Test User');
  });

  it('stores session in localStorage', () => {
    loginSession('user@test.com', 'Test User');
    const session = JSON.parse(localStorage.getItem(AUTH_SESSION_KEY)!);
    expect(session.email).toBe('user@test.com');
    expect(session.name).toBe('Test User');
    expect(session.loginAt).toBeDefined();
    expect(typeof session.loginAt).toBe('number');
  });

  it('session loginAt is approximately now', () => {
    const before = Date.now();
    loginSession('user@test.com', 'Test User');
    const after = Date.now();
    const session = JSON.parse(localStorage.getItem(AUTH_SESSION_KEY)!);
    expect(session.loginAt).toBeGreaterThanOrEqual(before);
    expect(session.loginAt).toBeLessThanOrEqual(after);
  });
});

describe('authMsg()', () => {
  beforeEach(() => {
    setupAuthDOM();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders a message in the target element', () => {
    authMsg('signin-msg', 'error', 'Invalid password');
    const el = document.getElementById('signin-msg')!;
    expect(el.innerHTML).toContain('Invalid password');
    expect(el.innerHTML).toContain('login-msg');
    expect(el.innerHTML).toContain('error');
  });

  it('renders different message types', () => {
    authMsg('signup-msg', 'success', 'Account created');
    expect(document.getElementById('signup-msg')!.innerHTML).toContain('success');
    expect(document.getElementById('signup-msg')!.innerHTML).toContain('Account created');
  });

  it('renders info messages', () => {
    authMsg('forgot-msg', 'info', 'Sending...');
    expect(document.getElementById('forgot-msg')!.innerHTML).toContain('info');
    expect(document.getElementById('forgot-msg')!.innerHTML).toContain('Sending...');
  });
});
