/* ═══════════════════════════════════════════════════════════════════════
   NoteFlow — auth.ts
   Authentication, subscription, team management, 2FA, session handling
   ═══════════════════════════════════════════════════════════════════════ */

import { state, SECTIONS } from './state';
import {
  FIREBASE_ENABLED,
  ENCRYPTION_ENABLED,
  STRIPE_CONFIG,
  STRIPE_ENABLED,
  trackEvent,
  getFirebaseUid,
  genId,
} from './config';
import { esc, el, elInput } from './utils';
import {
  cloudSaveUserData,
  cloudLoadUserData,
  migrateToCloud,
  getProjectList,
  getProjectListCloud,
  saveProjectList,
  saveProject,
} from './data';

// Firebase SDK global (loaded via script tag)
declare const firebase: any;

// ─── Callback registration (avoids circular dependency with dashboard.ts) ───
let _showDashboardFn: (() => void) | null = null;

export function setShowDashboardFn(fn: () => void): void { _showDashboardFn = fn; }

// ─── Constants ──────────────────────────────────────────────────────────────

const SIGNUPS_DISABLED: boolean = import.meta.env.VITE_SIGNUPS_DISABLED !== 'false';
export const AUTH_USERS_KEY: string = 'fsgen-users';
export const AUTH_SESSION_KEY: string = 'fsgen-session';
export const SESSION_EXPIRY_MS: number = 8 * 60 * 60 * 1000;

// ─── Module-level variables ─────────────────────────────────────────────────

let selectedPlan: string = 'individual';
let recaptchaVerifier: any = null;
let mfaVerificationId: string | null = null;
let mfaResolver: any = null;

// ─── Subscription Management ────────────────────────────────────────────────

function checkSubscription(callback: (hasAccess: boolean) => void): void {
  if (!STRIPE_ENABLED || !FIREBASE_ENABLED) { callback(true); return; }

  // Admin always gets full access
  if (state.currentUserEmail === 'getnoteflowapp@gmail.com') { callback(true); return; }

  const uid: string | null = state.firebaseAuth.currentUser ? state.firebaseAuth.currentUser.uid : null;
  if (!uid) { callback(false); return; }

  state.firebaseDb.collection('users').doc(uid).get()
    .then(function(doc: any) {
      if (!doc.exists) { callback(true); return; } // New user, allow (will create trial doc on signup)
      const data = doc.data();
      const status: string = data.subscriptionStatus || 'trial';

      // User has their own active subscription
      if (status === 'active' || status === 'trialing') {
        // Show team button if firm plan
        if (data.firm) {
          const btn = document.getElementById('team-mgmt-btn');
          if (btn) btn.style.display = 'inline-block';
        }
        callback(true);
        return;
      }

      // Check trial
      if (status === 'trial') {
        const trialEnd: Date | null = data.trialEndsAt ? new Date(data.trialEndsAt) : null;
        if (trialEnd && trialEnd > new Date()) {
          const daysLeft: number = Math.ceil((trialEnd.getTime() - new Date().getTime()) / (24 * 60 * 60 * 1000));
          showTrialBanner(daysLeft);
          callback(true);
          return;
        }
      }

      // No individual subscription — check if user is a firm member
      checkFirmMembership(state.currentUserEmail!, function(isFirmMember: boolean) {
        if (isFirmMember) {
          callback(true);
        } else {
          callback(false);
        }
      });
    })
    .catch(function(err: any) {
      console.warn('Subscription check failed:', err);
      callback(false); // fail-closed: deny access on error
    });
}

function showTrialBanner(daysLeft: number): void {
  const banner = document.getElementById('sub-trial-banner');
  if (banner) {
    const el = document.getElementById('trial-days-left');
    if (el) el.textContent = String(daysLeft);
    banner.style.display = 'block';
  }
}

export function dismissTrialBanner(): void {
  const banner = document.getElementById('sub-trial-banner');
  if (banner) banner.style.display = 'none';
}

function showSubscriptionGate(): void {
  const loginScreen = el('login-screen');
  if (loginScreen) loginScreen.style.display = 'none';
  el('dashboard')?.classList.remove('visible');
  el('app-wrapper')?.classList.remove('visible');
  const subGate = el('subscription-gate');
  if (subGate) subGate.style.display = 'flex';
}

function hideSubscriptionGate(): void {
  const subGate = el('subscription-gate');
  if (subGate) subGate.style.display = 'none';
}

export function selectPlan(plan: string): void {
  selectedPlan = plan;
  const indCard = el('plan-individual');
  const firmCard = el('plan-firm');
  const btn = el('subscribe-btn');
  if (!indCard || !firmCard || !btn) return;

  if (plan === 'firm') {
    firmCard.style.borderColor = 'var(--primary)';
    firmCard.style.boxShadow = '0 0 0 2px var(--primary)';
    indCard.style.borderColor = 'var(--border)';
    indCard.style.boxShadow = 'none';
    btn.textContent = 'Subscribe — Firm $199/mo';
  } else {
    indCard.style.borderColor = 'var(--primary)';
    indCard.style.boxShadow = '0 0 0 2px var(--primary)';
    firmCard.style.borderColor = 'var(--border)';
    firmCard.style.boxShadow = 'none';
    btn.textContent = 'Subscribe — Individual $49/mo';
  }
}

export function startCheckout(): void {
  const link: string | undefined = selectedPlan === 'firm' ? STRIPE_CONFIG.firmPaymentLink : STRIPE_CONFIG.paymentLink;
  if (!link) {
    alert('Payment link not configured yet. Please contact support.');
    return;
  }
  const uid: string | null = getFirebaseUid();
  const email: string = state.currentUserEmail || '';
  let url: string = link + '?prefilled_email=' + encodeURIComponent(email);
  if (uid) url += '&client_reference_id=' + encodeURIComponent(uid);
  window.open(url, '_blank');
}


// ─── Firm / Team Management ─────────────────────────────────────────────────

function loadFirmData(callback: (firm: any) => void): void {
  const uid: string | null = getFirebaseUid();
  if (!uid) { callback(null); return; }
  state.firebaseDb.collection('users').doc(uid).get()
    .then(function(doc: any) {
      if (!doc.exists) { callback(null); return; }
      const data = doc.data();
      callback(data.firm || null);
    })
    .catch(function() { callback(null); });
}

function saveFirmData(firmData: any): Promise<void> {
  const uid: string | null = getFirebaseUid();
  if (!uid) return Promise.resolve();
  return state.firebaseDb.collection('users').doc(uid).set({ firm: firmData }, { merge: true })
    .catch(function(err: any) { console.error('Failed to save firm data:', err); });
}

export function toggleTeamPanel(): void {
  const panel = el('team-panel');
  if (!panel) return;
  panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
  if (panel.style.display === 'block') renderTeamMembers();
}

function renderTeamMembers(): void {
  loadFirmData(function(firm: any) {
    if (!firm) return;
    const members: any[] = firm.members || [];
    const maxSeats: number = firm.maxSeats || 10;
    const seatCountEl = document.getElementById('team-seat-count');
    if (seatCountEl) seatCountEl.textContent = members.length + ' / ' + maxSeats + ' seats used';

    let html: string = '';
    if (members.length === 0) {
      html = '<p style="color:var(--muted);font-size:0.85rem">No team members added yet. Add members by email to give them access.</p>';
    } else {
      html = '<table style="width:100%;font-size:0.85rem;border-collapse:collapse">';
      html += '<tr style="border-bottom:1px solid var(--border);color:var(--muted);font-size:0.75rem"><td style="padding:6px 0">Email</td><td>Name</td><td>Added</td><td></td></tr>';
      members.forEach(function(m: any, i: number) {
        const dateStr: string = m.addedAt ? new Date(m.addedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
        html += '<tr style="border-bottom:1px solid var(--border)">';
        html += '<td style="padding:8px 0">' + esc(m.email) + '</td>';
        html += '<td>' + esc(m.name || '-') + '</td>';
        html += '<td style="color:var(--muted)">' + dateStr + '</td>';
        html += '<td style="text-align:right"><button class="btn btn-ghost btn-sm" style="color:var(--red);font-size:0.7rem" onclick="removeTeamMember(' + i + ')">Remove</button></td>';
        html += '</tr>';
      });
      html += '</table>';
    }
    const listEl = document.getElementById('team-member-list');
    if (listEl) listEl.innerHTML = html;
  });
}

export function addTeamMember(): void {
  const emailInput = elInput('team-add-email');
  const nameInput = elInput('team-add-name');
  if (!emailInput || !nameInput) return;
  const email: string = emailInput.value.trim().toLowerCase();
  const name: string = nameInput.value.trim();

  if (!email || !email.includes('@')) { alert('Please enter a valid email address.'); return; }

  loadFirmData(function(firm: any) {
    if (!firm) firm = { members: [], maxSeats: 10 };
    const members: any[] = firm.members || [];

    if (members.length >= (firm.maxSeats || 10)) {
      alert('Team is at capacity (' + (firm.maxSeats || 10) + ' seats). Contact support to add more seats.');
      return;
    }

    if (members.some(function(m: any) { return m.email === email; })) {
      alert('This email is already on the team.');
      return;
    }

    members.push({ email: email, name: name, addedAt: new Date().toISOString() });
    firm.members = members;
    firm.memberEmails = members.map(function(m: any) { return m.email; });
    saveFirmData(firm).then(function() {
      emailInput.value = '';
      nameInput.value = '';
      renderTeamMembers();
    }).catch(function() {
      alert('Failed to save team changes. Please try again.');
    });
  });
}

export function removeTeamMember(index: number): void {
  loadFirmData(function(firm: any) {
    if (!firm || !firm.members) return;
    const member = firm.members[index];
    if (!confirm('Remove ' + member.email + ' from the team?')) return;
    firm.members.splice(index, 1);
    firm.memberEmails = firm.members.map(function(m: any) { return m.email; });
    saveFirmData(firm).then(function() {
      renderTeamMembers();
    }).catch(function() {
      alert('Failed to save team changes. Please try again.');
    });
  });
}

// Check if current user is a member of any firm (for subscription access)
function checkFirmMembership(email: string, callback: (isMember: boolean) => void): void {
  if (!FIREBASE_ENABLED || !getFirebaseUid()) { callback(false); return; }

  state.firebaseDb.collection('users')
    .where('firm.memberEmails', 'array-contains', email)
    .limit(1)
    .get()
    .then(function(snapshot: any) {
      if (!snapshot.empty) {
        const firmDoc = snapshot.docs[0].data();
        const firmStatus: string = firmDoc.subscriptionStatus;
        callback(firmStatus === 'active' || firmStatus === 'trialing');
      } else {
        callback(false);
      }
    })
    .catch(function() { callback(false); });
}


// ─── Firm Profile ──────────────────────────────────────────────────────────

function loadFirmProfile(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem('noteflow-firmprofile-' + state.currentUserEmail) || '{}') || {}; }
  catch(e) { return {}; }
}

function saveFirmProfile(profile: Record<string, string>): void {
  localStorage.setItem('noteflow-firmprofile-' + state.currentUserEmail, JSON.stringify(profile));
  cloudSaveUserData('firmProfile', profile);
}

export function openFirmProfile(): void {
  const p = loadFirmProfile();
  const fpFields: [string, string][] = [
    ['fp-entity-type', p.entityType || ''],
    ['fp-state', p.state || ''],
    ['fp-basis', p.basis || ''],
    ['fp-depreciation', p.depreciation || ''],
    ['fp-tax-status', p.taxStatus || ''],
    ['fp-inventory', p.inventory || ''],
    ['fp-useful-lives', p.usefulLives || ''],
    ['fp-revenue-rec', p.revenueRec || ''],
    ['fp-cash-equiv', p.cashEquiv || ''],
  ];
  fpFields.forEach(function([id, val]) {
    const fpEl = elInput(id);
    if (fpEl) fpEl.value = val;
  });
  el('firm-profile-modal')?.classList.add('open');
}

export function closeFirmProfile(): void {
  el('firm-profile-modal')?.classList.remove('open');
}

// ─── Security Settings / 2FA ────────────────────────────────────────────────

export function openSecuritySettings(): void {
  el('security-modal')?.classList.add('open');
  const emailEl = el('security-email');
  if (emailEl) emailEl.textContent = state.currentUserEmail || '';
  const msgEl = el('2fa-msg');
  if (msgEl) msgEl.innerHTML = '';
  check2FAStatus();
}

export function closeSecuritySettings(): void {
  el('security-modal')?.classList.remove('open');
}

function check2FAStatus(): void {
  if (!FIREBASE_ENABLED || !state.firebaseAuth.currentUser) {
    const statusEl = el('2fa-status');
    if (statusEl) {
      statusEl.textContent = 'Unavailable';
      statusEl.style.background = '#f1f5f9';
      statusEl.style.color = '#64748b';
    }
    const actionBtn = el('2fa-action-btn');
    if (actionBtn) actionBtn.style.display = 'none';
    return;
  }

  const user = state.firebaseAuth.currentUser;
  const enrolled: boolean = user.multiFactor && user.multiFactor.enrolledFactors && user.multiFactor.enrolledFactors.length > 0;

  if (enrolled) {
    const statusEl = el('2fa-status');
    if (statusEl) {
      statusEl.textContent = 'Enabled';
      statusEl.style.background = '#dcfce7';
      statusEl.style.color = '#16a34a';
    }
    const actionBtn = el('2fa-action-btn');
    if (actionBtn) actionBtn.style.display = 'none';
    const disableBtn = el('2fa-disable-btn');
    if (disableBtn) disableBtn.style.display = 'inline-block';
    const setupForm = el('2fa-setup-form');
    const loginField = setupForm?.querySelector('.login-field') as HTMLElement | null;
    if (loginField) loginField.setAttribute('style', 'display:none');
  } else {
    const statusEl = el('2fa-status');
    if (statusEl) {
      statusEl.textContent = 'Disabled';
      statusEl.style.background = '#fee2e2';
      statusEl.style.color = '#dc2626';
    }
    const actionBtn = el('2fa-action-btn');
    if (actionBtn) {
      actionBtn.style.display = 'inline-block';
      actionBtn.textContent = 'Enable 2FA';
      (actionBtn as HTMLElement).onclick = start2FASetup;
    }
    const disableBtn = el('2fa-disable-btn');
    if (disableBtn) disableBtn.style.display = 'none';
    const setupForm = el('2fa-setup-form');
    const loginField = setupForm?.querySelector('.login-field') as HTMLElement | null;
    if (loginField) loginField.setAttribute('style', 'display:block');
    const verifySection = el('2fa-verify-section');
    if (verifySection) verifySection.style.display = 'none';
  }
}

export function start2FASetup(): void {
  let phone: string = elInput('2fa-phone')?.value.trim() || '';
  if (!phone) {
    const msgEl = el('2fa-msg');
    if (msgEl) msgEl.innerHTML = '<div class="login-msg error">' + esc('Please enter a phone number.') + '</div>';
    return;
  }
  // Normalize phone: add +1 if no country code
  if (!phone.startsWith('+')) {
    phone = '+1' + phone.replace(/[^0-9]/g, '');
  }

  const msgEl2fa = el('2fa-msg');
  if (msgEl2fa) msgEl2fa.innerHTML = '<div class="login-msg info">' + esc('Sending verification code...') + '</div>';

  // Initialize reCAPTCHA
  if (!recaptchaVerifier) {
    recaptchaVerifier = new firebase.auth.RecaptchaVerifier('recaptcha-container', {
      size: 'invisible'
    });
  }

  const user = state.firebaseAuth.currentUser;
  user.multiFactor.getSession().then(function(session: any) {
    const phoneOpts = {
      phoneNumber: phone,
      session: session
    };
    const phoneAuthProvider = new firebase.auth.PhoneAuthProvider();
    return phoneAuthProvider.verifyPhoneNumber(phoneOpts, recaptchaVerifier);
  }).then(function(verificationId: string) {
    mfaVerificationId = verificationId;
    const verifySection = el('2fa-verify-section');
    if (verifySection) verifySection.style.display = 'block';
    const actionBtn = el('2fa-action-btn');
    if (actionBtn) {
      actionBtn.textContent = 'Verify Code';
      (actionBtn as HTMLElement).onclick = verify2FACode;
    }
    const msgEl = el('2fa-msg');
    if (msgEl) msgEl.innerHTML = '<div class="login-msg success">' + esc('Code sent! Check your phone.') + '</div>';
  }).catch(function(err: any) {
    console.error('2FA setup error:', err);
    const msg: string = err.code === 'auth/requires-recent-login'
      ? 'Please sign out and sign back in, then try again.'
      : err.message;
    const msgEl = el('2fa-msg');
    if (msgEl) msgEl.innerHTML = '<div class="login-msg error">' + esc(msg) + '</div>';
  });
}

function verify2FACode(): void {
  const code: string = elInput('2fa-code')?.value.trim() || '';
  if (!code || code.length !== 6) {
    const msgEl = el('2fa-msg');
    if (msgEl) msgEl.innerHTML = '<div class="login-msg error">' + esc('Please enter the 6-digit code.') + '</div>';
    return;
  }

  const msgEl = el('2fa-msg');
  if (msgEl) msgEl.innerHTML = '<div class="login-msg info">' + esc('Verifying...') + '</div>';

  const cred = firebase.auth.PhoneAuthProvider.credential(mfaVerificationId, code);
  const multiFactorAssertion = firebase.auth.PhoneMultiFactorGenerator.assertion(cred);

  state.firebaseAuth.currentUser.multiFactor.enroll(multiFactorAssertion, 'Phone').then(function() {
    const msgEl = el('2fa-msg');
    if (msgEl) msgEl.innerHTML = '<div class="login-msg success">' + esc('Two-factor authentication enabled!') + '</div>';
    check2FAStatus();
  }).catch(function(err: any) {
    const msgEl = el('2fa-msg');
    if (msgEl) msgEl.innerHTML = '<div class="login-msg error">' + esc(err.message) + '</div>';
  });
}

export function disable2FA(): void {
  if (!confirm('Disable two-factor authentication? Your account will be less secure.')) return;

  const user = state.firebaseAuth.currentUser;
  if (user.multiFactor.enrolledFactors.length > 0) {
    const factor = user.multiFactor.enrolledFactors[0];
    user.multiFactor.unenroll(factor).then(function() {
      const msgEl = el('2fa-msg');
      if (msgEl) msgEl.innerHTML = '<div class="login-msg success">' + esc('Two-factor authentication disabled.') + '</div>';
      check2FAStatus();
    }).catch(function(err: any) {
      const msg: string = err.code === 'auth/requires-recent-login'
        ? 'Please sign out and sign back in, then try again.'
        : err.message;
      const msgEl = el('2fa-msg');
      if (msgEl) msgEl.innerHTML = '<div class="login-msg error">' + esc(msg) + '</div>';
    });
  }
}

function show2FASignInChallenge(): void {
  showAuthView('2fa');

  if (!recaptchaVerifier) {
    recaptchaVerifier = new firebase.auth.RecaptchaVerifier('recaptcha-container', { size: 'invisible' });
  }

  const hint = mfaResolver.hints[0];
  const phoneAuthProvider = new firebase.auth.PhoneAuthProvider();
  phoneAuthProvider.verifyPhoneNumber({
    multiFactorHint: hint,
    session: mfaResolver.session
  }, recaptchaVerifier).then(function(verificationId: string) {
    mfaVerificationId = verificationId;
    authMsg('2fa-signin-msg', 'success', 'Code sent to ' + hint.phoneNumber);
  }).catch(function(err: any) {
    authMsg('2fa-signin-msg', 'error', err.message);
  });
}

export function verify2FASignIn(): void {
  const code: string = elInput('2fa-signin-code')?.value.trim() || '';
  if (!code || code.length !== 6) {
    authMsg('2fa-signin-msg', 'error', 'Please enter the 6-digit code.');
    return;
  }

  authMsg('2fa-signin-msg', 'info', 'Verifying...');

  const cred = firebase.auth.PhoneAuthProvider.credential(mfaVerificationId, code);
  const assertion = firebase.auth.PhoneMultiFactorGenerator.assertion(cred);

  mfaResolver.resolveSignIn(assertion).then(function(userCred: any) {
    const name: string = userCred.user.displayName || userCred.user.email;
    loginSession(userCred.user.email, name);
  }).catch(function(_err: any) {
    authMsg('2fa-signin-msg', 'error', 'Invalid code. Please try again.');
  });
}

export function saveFirmProfileFromForm(): void {
  const p: Record<string, string> = {
    entityType: elInput('fp-entity-type')?.value ?? '',
    state: elInput('fp-state')?.value ?? '',
    basis: elInput('fp-basis')?.value ?? '',
    depreciation: elInput('fp-depreciation')?.value ?? '',
    taxStatus: elInput('fp-tax-status')?.value ?? '',
    inventory: elInput('fp-inventory')?.value ?? '',
    usefulLives: elInput('fp-useful-lives')?.value ?? '',
    revenueRec: elInput('fp-revenue-rec')?.value ?? '',
    cashEquiv: elInput('fp-cash-equiv')?.value ?? ''
  };
  saveFirmProfile(p);
  closeFirmProfile();
  alert('Firm profile saved. New projects will use these defaults.');
}

export function applyFirmProfileToNewProject(): void {
  const p = loadFirmProfile();
  if (!p || Object.keys(p).length === 0) return;
  if (p.entityType) { const el = document.getElementById('nq-entity-type') as HTMLSelectElement | null; if (el) el.value = p.entityType; }
  if (p.state) { const el = document.getElementById('nq-state') as HTMLSelectElement | null; if (el) el.value = p.state; }
  if (p.basis) { const el = document.getElementById('nq-basis') as HTMLSelectElement | null; if (el) el.value = p.basis; }
  if (p.depreciation) { const el = document.getElementById('nq-depreciation') as HTMLSelectElement | null; if (el) el.value = p.depreciation; }
  if (p.taxStatus) { const el = document.getElementById('nq-tax-status') as HTMLSelectElement | null; if (el) el.value = p.taxStatus; }
  if (p.inventory) { const el = document.getElementById('nq-inventory') as HTMLSelectElement | null; if (el) el.value = p.inventory; }
  if (p.usefulLives) { const el = document.getElementById('nq-useful-lives') as HTMLSelectElement | null; if (el) el.value = p.usefulLives; }
  if (p.revenueRec) { const el = document.getElementById('nq-revenue-recognition') as HTMLSelectElement | null; if (el) el.value = p.revenueRec; }
  if (p.cashEquiv) { const el = document.getElementById('nq-cash-equiv') as HTMLSelectElement | null; if (el) el.value = p.cashEquiv; }
}


// ─── Authentication ─────────────────────────────────────────────────────────

export async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(password + '-noteflow-auth-pepper-v1');
  const hash = await crypto.subtle.digest('SHA-256', data);
  const arr = new Uint8Array(hash);
  let hex: string = '';
  for (let i = 0; i < arr.length; i++) hex += ('0' + arr[i].toString(16)).slice(-2);
  return hex;
}

export function getUsers(): Record<string, any> {
  try { return JSON.parse(localStorage.getItem(AUTH_USERS_KEY) || '{}') || {}; }
  catch(e) { return {}; }
}

export function saveUsers(users: Record<string, any>): void {
  localStorage.setItem(AUTH_USERS_KEY, JSON.stringify(users));
}

export function showAuthView(view: string): void {
  const authSignin = el('auth-signin');
  if (authSignin) authSignin.style.display = view === 'signin' ? 'block' : 'none';
  const authSignup = el('auth-signup');
  if (authSignup) authSignup.style.display = view === 'signup' ? 'block' : 'none';
  const authForgot = el('auth-forgot');
  if (authForgot) authForgot.style.display = view === 'forgot' ? 'block' : 'none';
  const auth2fa = el('auth-2fa');
  if (auth2fa) auth2fa.style.display = view === '2fa' ? 'block' : 'none';
  const signinMsg = el('signin-msg');
  if (signinMsg) signinMsg.innerHTML = '';
  const signupMsg = el('signup-msg');
  if (signupMsg) signupMsg.innerHTML = '';
  const forgotMsg = el('forgot-msg');
  if (forgotMsg) forgotMsg.innerHTML = '';
  const twoFaMsg = el('2fa-signin-msg');
  if (twoFaMsg) twoFaMsg.innerHTML = '';
}

export function authMsg(elId: string, type: string, msg: string): void {
  const msgEl = el(elId);
  if (msgEl) msgEl.innerHTML = '<div class="login-msg ' + type + '">' + esc(msg) + '</div>';
}

export async function handleSignUp(): Promise<void> {
  if (SIGNUPS_DISABLED) { authMsg('signup-msg', 'error', 'Registration is currently closed. Please check back soon.'); return; }
  const name: string = elInput('signup-name')?.value.trim() ?? '';
  const email: string = (elInput('signup-email')?.value.trim() ?? '').toLowerCase();
  const pass: string = elInput('signup-password')?.value ?? '';
  const confirm_pass: string = elInput('signup-confirm')?.value ?? '';

  if (!name) { authMsg('signup-msg', 'error', 'Please enter your name.'); return; }
  if (!email || !email.includes('@')) { authMsg('signup-msg', 'error', 'Please enter a valid email.'); return; }
  if (pass.length < 8) { authMsg('signup-msg', 'error', 'Password must be at least 8 characters.'); return; }
  if (!/[A-Z]/.test(pass) || !/[0-9]/.test(pass)) { authMsg('signup-msg', 'error', 'Password must contain at least one uppercase letter and one number.'); return; }
  if (pass !== confirm_pass) { authMsg('signup-msg', 'error', 'Passwords do not match.'); return; }

  if (FIREBASE_ENABLED) {
    authMsg('signup-msg', 'info', 'Creating account...');
    state.firebaseAuth.createUserWithEmailAndPassword(email, pass)
      .then(function(cred: any) {
        return cred.user.updateProfile({ displayName: name });
      })
      .then(function() {
        // Store display name in Firestore for later retrieval
        if (state.firebaseDb) {
          state.firebaseDb.collection('users').doc(state.firebaseAuth.currentUser.uid).set({
            name: name, email: email, createdAt: new Date().toISOString(), subscriptionStatus: 'trial', trialEndsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString()
          }, { merge: true });
        }
        authMsg('signup-msg', 'success', 'Account created! Redirecting...');
        setTimeout(function() { loginSession(email, name); }, 800);
      })
      .catch(function(err: any) {
        const msg: string = err.code === 'auth/email-already-in-use' ? 'An account with this email already exists.'
          : err.code === 'auth/weak-password' ? 'Password is too weak.'
          : err.message;
        authMsg('signup-msg', 'error', msg);
      });
  } else {
    // Fallback: localStorage auth
    const users = getUsers();
    if (users[email]) { authMsg('signup-msg', 'error', 'An account with this email already exists.'); return; }
    const hashed: string = await hashPassword(pass);
    users[email] = { name: name, password: hashed };
    saveUsers(users);
    authMsg('signup-msg', 'success', 'Account created! Redirecting...');
    setTimeout(function() { loginSession(email, name); }, 800);
  }
}

export async function handleSignIn(): Promise<void> {
  const email: string = (elInput('signin-email')?.value.trim() ?? '').toLowerCase();
  const pass: string = elInput('signin-password')?.value ?? '';

  if (!email) { authMsg('signin-msg', 'error', 'Please enter your email.'); return; }
  if (!pass) { authMsg('signin-msg', 'error', 'Please enter your password.'); return; }

  if (FIREBASE_ENABLED) {
    authMsg('signin-msg', 'info', 'Signing in...');
    state.firebaseAuth.signInWithEmailAndPassword(email, pass)
      .then(function(cred: any) {
        const name: string = cred.user.displayName || email;
        loginSession(email, name);
      })
      .catch(function(err: any) {
        if (err.code === 'auth/multi-factor-auth-required') {
          // Show 2FA verification form
          mfaResolver = err.resolver;
          show2FASignInChallenge();
          return;
        }
        const msg: string = err.code === 'auth/user-not-found' ? 'No account found with this email.'
          : err.code === 'auth/wrong-password' ? 'Invalid email or password.'
          : err.code === 'auth/invalid-credential' ? 'Invalid email or password.'
          : err.message;
        authMsg('signin-msg', 'error', msg);
      });
  } else {
    const users = getUsers();
    const user = users[email];
    const hashed: string = await hashPassword(pass);
    if (!user || user.password !== hashed) {
      authMsg('signin-msg', 'error', 'Invalid email or password.');
      return;
    }
    loginSession(email, user.name);
  }
}

export async function handleForgotPassword(): Promise<void> {
  const email: string = (elInput('forgot-email')?.value.trim() ?? '').toLowerCase();

  if (FIREBASE_ENABLED) {
    if (!email || !email.includes('@')) { authMsg('forgot-msg', 'error', 'Please enter a valid email.'); return; }
    authMsg('forgot-msg', 'info', 'Sending reset email...');
    state.firebaseAuth.sendPasswordResetEmail(email)
      .then(function() {
        authMsg('forgot-msg', 'success', 'Password reset email sent! Check your inbox.');
        setTimeout(function() { showAuthView('signin'); }, 2000);
      })
      .catch(function(err: any) {
        const msg: string = err.code === 'auth/user-not-found' ? 'No account found with this email.' : err.message;
        authMsg('forgot-msg', 'error', msg);
      });
  } else {
    const pass: string = elInput('forgot-password')?.value ?? '';
    const confirm_pass: string = elInput('forgot-confirm')?.value ?? '';
    if (!email || !email.includes('@')) { authMsg('forgot-msg', 'error', 'Please enter a valid email.'); return; }
    const users = getUsers();
    if (!users[email]) { authMsg('forgot-msg', 'error', 'No account found with this email.'); return; }
    if (pass.length < 8) { authMsg('forgot-msg', 'error', 'New password must be at least 8 characters.'); return; }
    if (!/[A-Z]/.test(pass) || !/[0-9]/.test(pass)) { authMsg('forgot-msg', 'error', 'Password must contain at least one uppercase letter and one number.'); return; }
    if (pass !== confirm_pass) { authMsg('forgot-msg', 'error', 'Passwords do not match.'); return; }
    users[email].password = await hashPassword(pass);
    saveUsers(users);
    authMsg('forgot-msg', 'success', 'Password updated! Redirecting to sign in...');
    setTimeout(function() { showAuthView('signin'); }, 1200);
  }
}

/**
 * Establishes a user session after authentication, migrates legacy data, and loads the project list.
 */
export function loginSession(email: string, name: string): void {
  trackEvent('logins');
  localStorage.setItem(AUTH_SESSION_KEY, JSON.stringify({ email: email, name: name, loginAt: Date.now() }));
  state.currentUserEmail = email;
  state.currentUserName = name;

  // Migration: check for old fsgen-state key
  const oldState = localStorage.getItem('fsgen-state');
  if (oldState) {
    try {
      const parsed = JSON.parse(oldState);
      const id: string = genId();
      const proj: any = {
        currentData: {} as Record<string, any>,
        priorData: {} as Record<string, any>,
        company: parsed.company || '',
        period: parsed.period || '',
        priorPeriod: '',
        currency: parsed.currency || '$',
        notes: {},
      };
      SECTIONS.forEach(function(s: string) {
        proj.currentData[s] = (parsed.data && parsed.data[s]) ? parsed.data[s] : [];
        proj.priorData[s] = [];
      });
      localStorage.setItem('fsgen-project-' + id, JSON.stringify(proj));
      const mList: any[] = getProjectList(email);
      mList.push({ id: id, name: parsed.company || 'Migrated Project', updatedAt: new Date().toISOString() });
      saveProjectList(email, mList);
      localStorage.removeItem('fsgen-state');
    } catch(e) {
      localStorage.removeItem('fsgen-state');
    }
  }

  // Show security badge if encryption is enabled
  const badge = document.getElementById('security-badge');
  if (badge && ENCRYPTION_ENABLED) badge.style.display = 'inline';
  const cloudBadge = document.getElementById('cloud-sync-badge');
  if (cloudBadge && getFirebaseUid()) cloudBadge.style.display = 'inline';

  // Migrate localStorage data to cloud on first login
  const migrationDone: Promise<void> = getFirebaseUid() ? migrateToCloud() : Promise.resolve();
  migrationDone.then(function() {
    // Sync cloud data to localStorage cache
    if (getFirebaseUid()) {
      // Pull user-level data from cloud
      Promise.all([
        cloudLoadUserData('firmProfile'),
        cloudLoadUserData('template'),
        cloudLoadUserData('patterns'),
        cloudLoadUserData('dismissed')
      ]).then(function(results: any[]) {
        if (results[0]) localStorage.setItem('noteflow-firmprofile-' + email, JSON.stringify(results[0]));
        if (results[1]) localStorage.setItem('noteflow-template-' + email, JSON.stringify(results[1]));
        if (results[2]) localStorage.setItem('noteflow-patterns-' + email, JSON.stringify(results[2]));
        if (results[3]) localStorage.setItem('noteflow-dismissed-' + email, JSON.stringify(results[3]));
      });

      // Pull project list from cloud
      getProjectListCloud(function(mergedList: any[]) {
        saveProjectList(email, mergedList);
      });
    }

    // Check subscription before showing dashboard
    checkSubscription(function(hasAccess: boolean) {
      if (hasAccess) {
        hideSubscriptionGate();
        if (_showDashboardFn) _showDashboardFn();
      } else {
        showSubscriptionGate();
      }
    });
  });
}


export function handleSignOut(): void {
  if (state.currentProjectId) saveProject();
  if (FIREBASE_ENABLED && state.firebaseAuth) {
    state.firebaseAuth.signOut();
  }
  // Clear all user data from localStorage (privacy on shared computers)
  const keysToRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && (key.startsWith('fsgen-') || key === AUTH_SESSION_KEY || key.startsWith('noteflow-') || key.startsWith('firm-'))) {
      keysToRemove.push(key);
    }
  }
  keysToRemove.forEach(function(k: string) { localStorage.removeItem(k); });
  state.currentUserEmail = null;
  state.currentUserName = null;
  state.currentProjectId = null;
  state._cachedEncKey = null;
  state._cachedEncKeyEmail = null;
  state._cachedTemplate = null;
  el('app-wrapper')?.classList.remove('visible');
  el('dashboard')?.classList.remove('visible');
  const subGate = el('subscription-gate');
  if (subGate) subGate.style.display = 'none';
  const loginScreen = el('login-screen');
  if (loginScreen) loginScreen.style.display = 'flex';
  const badge = document.getElementById('security-badge');
  if (badge) badge.style.display = 'none';
  const cloudBadge = document.getElementById('cloud-sync-badge');
  if (cloudBadge) cloudBadge.style.display = 'none';
  showAuthView('signin');
}

export function isSessionExpired(): boolean {
  try {
    const session = JSON.parse(localStorage.getItem(AUTH_SESSION_KEY) || 'null');
    if (!session || !session.loginAt) return true;
    return (Date.now() - session.loginAt) > SESSION_EXPIRY_MS;
  } catch(e) { return true; }
}

// ─── Auth Form Enter Key Handlers ──────────────────────────────────────────

export function initAuthListeners(): void {
  document.querySelectorAll('#auth-signin input').forEach(function(el: Element) {
    el.addEventListener('keydown', function(e: Event) {
      if ((e as KeyboardEvent).key === 'Enter') handleSignIn();
    });
  });
  document.querySelectorAll('#auth-signup input').forEach(function(el: Element) {
    el.addEventListener('keydown', function(e: Event) {
      if ((e as KeyboardEvent).key === 'Enter') handleSignUp();
    });
  });
  document.querySelectorAll('#auth-forgot input').forEach(function(el: Element) {
    el.addEventListener('keydown', function(e: Event) {
      if ((e as KeyboardEvent).key === 'Enter') handleForgotPassword();
    });
  });
}
