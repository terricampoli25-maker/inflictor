// ─────────────────────────────────────────────────────────────
//  Activation gate — Electron main process
//
//  ACTIVATION_ENABLED = false  → beta mode, everyone gets in
//  ACTIVATION_ENABLED = true   → enforce serial key check
//
//  The actual key validation lives in lib/validate.js (renderer-side).
//  This file only controls whether the gate is shown at all.
// ─────────────────────────────────────────────────────────────

const ACTIVATION_ENABLED = false;   // ← flip to true before commercial launch

module.exports = { ACTIVATION_ENABLED };
