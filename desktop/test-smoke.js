// Pre-ship smoke test: drives the REAL built app (desktop/app/index.html) through the core UI flows
// and prints PASS/FAIL per check. Run: electron test-smoke.js   (from desktop/)
// Covers the regressions that have actually bitten: boot crash, theme picker, legacy-theme migration,
// opening pages, setup-box duration defaults (0h 0m, no auto-20), rename persistence, Settings pills.
const { app, BrowserWindow } = require('electron');
const path = require('path');

const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`);
  ok ? pass++ : fail++;
};

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1280, height: 820, webPreferences: { nodeIntegration: false, contextIsolation: true } });
  const load = () => new Promise(r => { win.webContents.once('did-finish-load', r); });
  const js = code => win.webContents.executeJavaScript(code);

  await win.loadFile(path.join(__dirname, 'app', 'index.html'));

  // ── A. Fresh boot: theme picker, no fatal error ─────────────────
  await js(`localStorage.clear(); true`);
  win.webContents.reload(); await load(); await sleep(900);
  const a = JSON.parse(await js(`JSON.stringify({
    fatal: !!document.getElementById('fatal-err'),
    pickerShown: !document.getElementById('theme-selector').classList.contains('hidden'),
    cards: document.querySelectorAll('.ts-card').length
  })`));
  check('fresh boot: no fatal error', !a.fatal);
  check('fresh boot: theme picker shown', a.pickerShown);
  check('fresh boot: 3 theme cards', a.cards === 3, `got ${a.cards}`);

  // ── B. Legacy 'standard' migrates to plain-light + opening renders ──
  await js(`localStorage.setItem('inflictor_theme','standard'); true`);
  win.webContents.reload(); await load(); await sleep(1200);
  const b = JSON.parse(await js(`JSON.stringify({
    stored: localStorage.getItem('inflictor_theme'),
    body: document.body.className,
    opening: (document.querySelector('.os-standard') && getComputedStyle(document.querySelector('.os-standard')).display) || 'missing'
  })`));
  check('legacy standard → plain-light (storage)', b.stored === 'plain-light', b.stored);
  check('legacy standard → plain-light (body class)', b.body.includes('theme-plain-light'), b.body);
  check('plain-light opening page renders', b.opening === 'flex', b.opening);

  // ── C. plain-dark opening renders ────────────────────────────────
  await js(`localStorage.setItem('inflictor_theme','plain-dark'); true`);
  win.webContents.reload(); await load(); await sleep(1200);
  const c = JSON.parse(await js(`JSON.stringify({
    body: document.body.className,
    opening: (document.querySelector('.os-standard') && getComputedStyle(document.querySelector('.os-standard')).display) || 'missing',
    bg: getComputedStyle(document.getElementById('opening-screen')).backgroundColor
  })`));
  check('plain-dark opening page renders', c.opening === 'flex', c.opening);
  check('plain-dark opening is dark', c.bg === 'rgb(17, 20, 27)', c.bg);

  // ── D. Setup-box flows: defaults, no auto-20, rename, pills ─────
  const d = JSON.parse(await js(`(async () => {
    await Planner.init();                                     // offline-safe: api calls fail gracefully
    Planner.openSetup();
    const row = document.querySelector('#setup-acts-list .act-row');
    const id = row && row.dataset.id;
    const durs = () => [...document.querySelectorAll('#setup-acts-list .dur-num')].map(i => i.value).join(',');
    const out = { rowExists: !!row };
    // A flexible row shows start/end times; the h/m boxes appear on Anytime/Sustenance — check both.
    Planner.setTiming(id, 'anytime');
    out.defaults = durs();
    Planner.setTiming(id, 'sustenance');
    out.afterSustenance = durs();
    out.medBtn = !![...document.querySelectorAll('#setup-acts-list .timing-opt')].find(b => b.textContent.trim() === 'Medication');
    // Rename exactly as a user does: the text goes into the FIELD, then the change handler fires.
    const nameInput = document.querySelector('#setup-acts-list .act-name-input');
    nameInput.value = 'SmokeTest';
    Planner.onActName(id, nameInput.value);
    Planner.setTiming(id, 'flexible');                        // forces a re-render; name must survive
    out.nameAfter = (document.querySelector('#setup-acts-list .act-name-input') || {}).value;
    out.spStandard = !!document.getElementById('sp-standard');
    out.spPlainLight = !!document.getElementById('sp-plain-light');
    out.spPlainDark = !!document.getElementById('sp-plain-dark');
    out.fatal = !!document.getElementById('fatal-err');
    return JSON.stringify(out);
  })()`));
  check('setup box opens with a blank row', d.rowExists);
  check('new activity defaults 0h 0m', d.defaults === '0,0', d.defaults);
  check('sustenance does NOT auto-fill 20', d.afterSustenance === '0,0', d.afterSustenance);
  check('Medication timing button present', d.medBtn);
  check('rename survives a re-render', d.nameAfter === 'SmokeTest', String(d.nameAfter));
  check('Settings: no Standard pill', !d.spStandard);
  check('Settings: plain Light/Dark pills present', d.spPlainLight && d.spPlainDark);
  check('no fatal error after UI flows', !d.fatal);

  console.log(`\nSMOKE RESULT: ${pass} passed, ${fail} failed`);
  app.exit(fail ? 1 : 0);
}).catch(e => { console.error('SMOKE CRASHED:', e); app.exit(2); });
