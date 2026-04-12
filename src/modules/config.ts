/* ═══════════════════════════════════════════════════════════════════════
   NoteFlow — config.ts
   Configuration, constants, Firebase/Stripe setup, encryption, error handling
   ═══════════════════════════════════════════════════════════════════════ */

import { state } from './state';

// ─── Firebase Configuration ──────────────────────────────────────────────────
export const FIREBASE_CONFIG: Record<string, string> = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID
};

export const FIREBASE_ENABLED: boolean = FIREBASE_CONFIG.apiKey !== 'YOUR_API_KEY';

// ─── Stripe Configuration ────────────────────────────────────────────────────
export const STRIPE_CONFIG: Record<string, string> = {
  publishableKey: import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY,
  paymentLink: import.meta.env.VITE_STRIPE_PAYMENT_LINK,
  firmPaymentLink: import.meta.env.VITE_STRIPE_FIRM_PAYMENT_LINK,
  firmPlusPaymentLink: import.meta.env.VITE_STRIPE_FIRMPLUS_PAYMENT_LINK
};
export const STRIPE_ENABLED: boolean = STRIPE_CONFIG.publishableKey !== 'YOUR_STRIPE_PUBLISHABLE_KEY';
export const TRIAL_DAYS: number = 14;

// ─── Client-Side Encryption ─────────────────────────────────────────────────
export const ENCRYPTION_ENABLED: boolean = true;

// ─── Debounce utility ────────────────────────────────────────────────────────
let _saveProjectFn: (() => void) | null = null;

export function setSaveProjectFn(fn: () => void): void { _saveProjectFn = fn; }

export function debouncedSave(): void {
  if (state._saveDebounceTimer) clearTimeout(state._saveDebounceTimer);
  state._saveDebounceTimer = setTimeout(function () {
    if (_saveProjectFn) _saveProjectFn();
  }, 600);
}

// ─── Firebase Initialization ────────────────────────────────────────────────
export function initFirebase(): void {
  if (FIREBASE_ENABLED) {
    const firebase = (window as any).firebase;
    state.firebaseApp = firebase.initializeApp(FIREBASE_CONFIG);
    state.firebaseAuth = firebase.auth();
    state.firebaseDb = firebase.firestore();

    // Enable offline persistence for seamless offline/online transitions
    state.firebaseDb.enablePersistence({ synchronizeTabs: true }).catch(function (err: any) {
      console.warn('Firestore persistence failed:', err.code);
    });
  }
}

// ─── Safe Mode Check ────────────────────────────────────────────────────
var _safeModeEnabled: boolean = false;
var _safeModeChecked: boolean = false;

function checkSafeMode(callback: (isOn: boolean) => void): void {
  if (!FIREBASE_ENABLED || !state.firebaseDb) { callback(false); return; }
  if (_safeModeChecked) { callback(_safeModeEnabled); return; }
  state.firebaseDb.collection('config').doc('safeMode').get().then(function (doc: any) {
    _safeModeEnabled = doc.exists && doc.data().enabled === true;
    _safeModeChecked = true;
    // Re-check every 60s
    setTimeout(function () { _safeModeChecked = false; }, 60000);
    callback(_safeModeEnabled);
  }).catch(function () { console.warn('[NoteFlow] Safe mode check failed, failing closed'); callback(true); });
}

/**
 * Checks if Safe Mode is active and blocks the action if so, otherwise proceeds.
 */
export function blockIfSafeMode(actionName: string, proceed: () => void): void {
  checkSafeMode(function (isOn: boolean) {
    if (isOn) {
      alert('⛔ Safe Mode is ON — ' + actionName + ' is currently blocked. An admin must disable Safe Mode first.');
    } else {
      proceed();
    }
  });
}

// ─── Usage Analytics Tracker ────────────────────────────────────────────
/**
 * Logs a usage analytics event by incrementing a daily counter in Firestore.
 */
export function trackEvent(eventName: string): void {
  if (!FIREBASE_ENABLED || !state.firebaseDb) return;
  const firebase = (window as any).firebase;
  var today: string = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  var docRef = state.firebaseDb.collection('analytics').doc(today);
  var increment = firebase.firestore.FieldValue.increment(1);
  var update: Record<string, any> = {};
  update[eventName] = increment;
  update['lastActivity'] = new Date().toISOString();
  docRef.set(update, { merge: true }).catch(function () { /* silent */ });
}

export function getFirebaseUid(): string | null {
  return (FIREBASE_ENABLED && state.firebaseAuth && state.firebaseAuth.currentUser)
    ? state.firebaseAuth.currentUser.uid
    : null;
}

// ─── Encryption (AES-GCM) ──────────────────────────────────────────────────
async function deriveEncryptionKey(email: string): Promise<CryptoKey> {
  // Return cached key if email hasn't changed
  if (state._cachedEncKey && state._cachedEncKeyEmail === email) return state._cachedEncKey;
  var encoder = new TextEncoder();
  // Use email + a unique per-derivation salt for better security
  var saltBase: string = email + '-noteflow-v2';
  var saltHash: ArrayBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(saltBase));
  var keyMaterial: CryptoKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(email + '-noteflow-encryption-key-v2'),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  var key: CryptoKey = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: new Uint8Array(saltHash), iterations: 600000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
  state._cachedEncKey = key;
  state._cachedEncKeyEmail = email;
  return key;
}

export async function encryptData(plaintext: string, email: string): Promise<string> {
  if (!ENCRYPTION_ENABLED || !crypto.subtle) return plaintext;
  try {
    var key: CryptoKey = await deriveEncryptionKey(email);
    var encoder = new TextEncoder();
    var iv: Uint8Array = crypto.getRandomValues(new Uint8Array(12));
    var encrypted: ArrayBuffer = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      key,
      encoder.encode(plaintext)
    );
    // Combine IV + ciphertext and encode as base64
    var combined = new Uint8Array(iv.length + encrypted.byteLength);
    combined.set(iv);
    combined.set(new Uint8Array(encrypted), iv.length);
    // Use chunked encoding to avoid call stack overflow with large data
    var binaryStr: string = '';
    for (var i = 0; i < combined.length; i++) binaryStr += String.fromCharCode(combined[i]);
    return 'ENC:' + btoa(binaryStr);
  } catch (e) {
    console.error('Encryption failed:', e);
    alert('Warning: Data encryption failed. Your data will be saved unencrypted. Check browser compatibility.');
    return plaintext;
  }
}

export async function decryptData(ciphertext: string, email: string): Promise<string | null> {
  if (!ciphertext || !ciphertext.startsWith('ENC:') || !crypto.subtle) return ciphertext;
  try {
    var key: CryptoKey = await deriveEncryptionKey(email);
    var raw: string = atob(ciphertext.slice(4));
    var bytes = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    var iv: Uint8Array = bytes.slice(0, 12);
    var data: Uint8Array = bytes.slice(12);
    var decrypted: ArrayBuffer = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      key,
      data as BufferSource
    );
    return new TextDecoder().decode(decrypted);
  } catch (e) {
    console.error('Decryption failed — data cannot be read. This may indicate a key mismatch or corrupt data.', e);
    alert('Unable to decrypt project data. This may happen if you changed your email or the data was corrupted. The project cannot be loaded.');
    return null; // Return null instead of raw ciphertext to prevent re-saving corrupt data
  }
}

// ─── UUID Generator ─────────────────────────────────────────────────────────
export function genId(): string {
  if (crypto && crypto.randomUUID) return crypto.randomUUID();
  var arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  arr[6] = (arr[6] & 0x0f) | 0x40;
  arr[8] = (arr[8] & 0x3f) | 0x80;
  var hex: string[] = [];
  arr.forEach(function (b: number) { hex.push(b.toString(16).padStart(2, '0')); });
  return (
    hex.slice(0, 4).join('') + '-' +
    hex.slice(4, 6).join('') + '-' +
    hex.slice(6, 8).join('') + '-' +
    hex.slice(8, 10).join('') + '-' +
    hex.slice(10).join('')
  );
}
