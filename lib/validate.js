// Serial Activation System — Client Library
// Drop this file into every Tauri / Capacitor app.
//
// Setup (two values to replace before shipping each app):
//   PUBLIC_KEY        — paste the key printed by scripts/generate-keys.js
//   ACTIVATION_HOST   — your deployed Worker URL

const PUBLIC_KEY      = 'REPLACE_WITH_PUBLIC_KEY_FROM_GENERATE_KEYS_SCRIPT';
const ACTIVATION_HOST = 'https://serial-activation.YOUR_SUBDOMAIN.workers.dev';

const CHECKIN_INTERVAL_MS = 7  * 24 * 60 * 60 * 1000; // 7 days
const OFFLINE_GRACE_MS    = 7  * 24 * 60 * 60 * 1000; // 7 days offline before blocking

const KEY_TOKEN      = 'sa_token';
const KEY_MACHINE_ID = 'sa_machine_id';
const KEY_CHECKIN    = 'sa_last_checkin';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function getMachineId() {
  let id = localStorage.getItem(KEY_MACHINE_ID);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(KEY_MACHINE_ID, id);
  }
  return id;
}

async function getPublicKey() {
  const keyBytes = Uint8Array.from(atob(PUBLIC_KEY), c => c.charCodeAt(0));
  return crypto.subtle.importKey(
    'raw', keyBytes.buffer,
    { name: 'Ed25519' },
    false, ['verify']
  );
}

// Returns the decoded payload if the token signature is valid and not expired.
// Returns null if anything is wrong.
async function verifyToken(tokenString) {
  if (!tokenString) return null;

  const dot = tokenString.indexOf('.');
  if (dot === -1) return null;

  const payloadB64 = tokenString.slice(0, dot);
  const sigB64     = tokenString.slice(dot + 1);

  let payload;
  try { payload = JSON.parse(atob(payloadB64)); }
  catch { return null; }

  try {
    const key  = await getPublicKey();
    const data = new TextEncoder().encode(JSON.stringify(payload));
    const sig  = Uint8Array.from(atob(sigB64), c => c.charCodeAt(0));
    const ok   = await crypto.subtle.verify('Ed25519', key, sig, data);
    if (!ok) return null;
  } catch {
    return null;
  }

  if (payload.expiresAt && new Date(payload.expiresAt) < new Date()) return null;

  return payload;
}

async function fetchCheckin(serial, machineId) {
  try {
    const res = await fetch(`${ACTIVATION_HOST}/checkin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serial, machineId }),
    });
    if (!res.ok) return false;
    const { token } = await res.json();
    localStorage.setItem(KEY_TOKEN, token);
    localStorage.setItem(KEY_CHECKIN, new Date().toISOString());
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * activate(serial)
 *
 * Call this when the user submits their serial number.
 * Contacts the activation server, stores the token locally, and returns true.
 * Throws an Error with a user-facing message on failure.
 */
export async function activate(serial) {
  const machineId = getMachineId();
  const res = await fetch(`${ACTIVATION_HOST}/activate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ serial: serial.trim().toUpperCase(), machineId }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? 'Activation failed — check your serial number and try again.');
  }

  const { token } = await res.json();
  localStorage.setItem(KEY_TOKEN, token);
  localStorage.setItem(KEY_CHECKIN, new Date().toISOString());
  return true;
}

/**
 * checkLicense()
 *
 * Call this on every app launch (before showing the main UI).
 * Returns one of:
 *
 *   { status: 'active',       payload }   — licensed, all good
 *   { status: 'grace',        daysRemaining, payload }  — offline/lapsed but within grace period
 *   { status: 'unactivated' } — no license stored, show activation screen
 *   { status: 'expired' }     — subscription lapsed, grace period over, block access
 */
export async function checkLicense() {
  const tokenString = localStorage.getItem(KEY_TOKEN);
  const machineId   = getMachineId();

  if (!tokenString) return { status: 'unactivated' };

  // Verify stored token — signature + expiry
  const payload = await verifyToken(tokenString);

  if (payload) {
    // Token is locally valid. For subscriptions, background-refresh if due.
    if (payload.type === 'subscription') {
      const lastCheckin    = localStorage.getItem(KEY_CHECKIN);
      const msSinceCheckin = lastCheckin
        ? Date.now() - new Date(lastCheckin).getTime()
        : Infinity;

      if (msSinceCheckin >= CHECKIN_INTERVAL_MS) {
        // Fire and forget — don't block app launch on this
        fetchCheckin(payload.serial, machineId).catch(() => {});
      }
    }
    return { status: 'active', payload };
  }

  // Token invalid or subscription expired — try a live check-in to refresh it
  let payloadB64;
  try { payloadB64 = tokenString.split('.')[0]; } catch { payloadB64 = null; }

  let storedSerial = null;
  if (payloadB64) {
    try { storedSerial = JSON.parse(atob(payloadB64))?.serial; } catch {}
  }

  if (storedSerial) {
    const refreshed = await fetchCheckin(storedSerial, machineId);
    if (refreshed) {
      const newPayload = await verifyToken(localStorage.getItem(KEY_TOKEN));
      if (newPayload) return { status: 'active', payload: newPayload };
    }
  }

  // Check-in failed — apply offline grace period
  const lastCheckin = localStorage.getItem(KEY_CHECKIN);
  if (lastCheckin) {
    const msOffline    = Date.now() - new Date(lastCheckin).getTime();
    const daysOffline  = msOffline / (1000 * 60 * 60 * 24);
    const daysRemaining = Math.ceil((OFFLINE_GRACE_MS - msOffline) / (1000 * 60 * 60 * 24));

    if (daysOffline <= OFFLINE_GRACE_MS / (1000 * 60 * 60 * 24)) {
      let gracePaylod = null;
      if (payloadB64) {
        try { gracePaylod = JSON.parse(atob(payloadB64)); } catch {}
      }
      return { status: 'grace', daysRemaining: Math.max(daysRemaining, 1), payload: gracePaylod };
    }
  }

  return { status: 'expired' };
}

/**
 * clearLicense()
 *
 * Call this if the user wants to deactivate on this device (e.g. before
 * moving to a new machine). Clears the stored token — next launch will
 * show the activation screen.
 */
export function clearLicense() {
  localStorage.removeItem(KEY_TOKEN);
  localStorage.removeItem(KEY_CHECKIN);
}
