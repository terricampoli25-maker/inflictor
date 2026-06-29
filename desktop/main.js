const { app, BrowserWindow, ipcMain, net, Tray, Menu, nativeImage } = require('electron');
const path    = require('path');
const http    = require('http');
const https   = require('https');
const fs      = require('fs');
const { ACTIVATION_ENABLED } = require('./activation');

const CLOUDFLARE_API = 'https://inflictor.pages.dev';
const APP_DIR        = path.join(__dirname, 'app');

// Safety net: a stray error in the main process should never throw Electron's raw
// "A JavaScript error occurred in the main process" dialog at a user. Log it (visible
// when run from a console) and keep going. Renderer errors still surface in DevTools.
process.on('uncaughtException',  (err)    => console.error('[uncaughtException]', err));
process.on('unhandledRejection', (reason) => console.error('[unhandledRejection]', reason));

const MIME = {
  '.html':'text/html', '.js':'application/javascript', '.css':'text/css',
  '.png':'image/png',  '.jpg':'image/jpeg',  '.ico':'image/x-icon',
  '.mp3':'audio/mpeg', '.json':'application/json', '.woff2':'font/woff2',
  '.svg':'image/svg+xml', '.webp':'image/webp',
};

let staticPort = null;
let mainWin    = null;
let actWin     = null;
let tray       = null;
let trayReady  = false;   // only hide-to-tray on window close once a tray actually exists
let isQuitting = false;   // set true by the tray's Quit so the window is allowed to close

// ── Local server: serves app files + proxies /api/ to Cloudflare ─
function startServer(callback) {
  const srv = http.createServer((req, res) => {

    if (req.url.startsWith('/api/')) {
      const target = new URL(req.url, CLOUDFLARE_API);

      // Proxy via Electron's net module (Chromium network stack) rather than
      // Node's https. Chromium trusts the OS certificate store — the same one
      // the browser uses — so connections still work when a VPN/antivirus
      // intercepts HTTPS with its own certificate. Node's bundled CA list does
      // not include those, which caused UNABLE_TO_VERIFY_LEAF_SIGNATURE.
      // Forward only the headers the API needs. Forwarding raw browser
      // headers (sec-fetch-*, origin, content-length, etc.) makes Electron's
      // net reject the request with ERR_INVALID_ARGUMENT. net computes
      // Host/Content-Length itself from the URL and the body we write.
      const FORWARD = ['content-type', 'authorization', 'cookie', 'accept'];
      const proxy = net.request({ method: req.method, url: target.href });
      for (const name of FORWARD) {
        const v = req.headers[name];
        if (v !== undefined) proxy.setHeader(name, v);
      }
      // Respond exactly once, and never let a single upstream call wedge the local server: if it
      // stalls past the timeout, or the page gives up on it first, abort the upstream and answer.
      let settled = false;
      const finish = (code, payload) => {
        if (settled) return; settled = true; clearTimeout(killer);
        try { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); } catch {}
      };
      const killer = setTimeout(() => { finish(504, { error: 'offline' }); try { proxy.abort(); } catch {} }, 15000);
      proxy.on('response', pres => {
        if (settled) { try { pres.destroy(); } catch {} return; }
        settled = true; clearTimeout(killer);
        // Electron's net already decompressed the body, so drop the upstream
        // content-encoding/length (and transfer-encoding) — otherwise the page
        // tries to decompress plain JSON again and ends up with an empty body.
        const h = { ...pres.headers };
        delete h['content-encoding']; delete h['content-length']; delete h['transfer-encoding'];
        res.writeHead(pres.statusCode, h);
        pres.on('data', chunk => res.write(chunk));
        pres.on('end',  ()    => res.end());
        pres.on('error', ()   => { try { res.end(); } catch {} });
      });
      proxy.on('error', (err) => {
        console.error('[PROXY ERROR]', req.method, req.url, '->', target.href, '|', err.code || err.message);
        finish(503, { error: 'offline' });
      });
      proxy.on('abort', () => finish(503, { error: 'offline' }));
      req.on('data', chunk => { try { proxy.write(chunk); } catch {} });
      req.on('end',  ()    => { try { proxy.end(); } catch {} });
      // The page aborted (its own timeout) or navigated away before we answered → drop the upstream call too.
      req.on('close', () => { if (!settled) { try { proxy.abort(); } catch {} } });
      return;
    }

    let urlPath = req.url.split('?')[0];
    if (!urlPath || urlPath === '/') urlPath = '/index.html';
    const file = path.join(APP_DIR, urlPath);
    if (!file.startsWith(APP_DIR)) { res.writeHead(403); res.end(); return; }

    fs.readFile(file, (err, data) => {
      if (err) {
        fs.readFile(path.join(APP_DIR, 'index.html'), (e2, html) => {
          if (e2) { res.writeHead(404); res.end('Not found'); return; }
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(html);
        });
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  });
  // Bind the fixed port; if it's momentarily taken (an old copy lingering during an upgrade, or a
  // sandbox like Norton Cyber Capture), fall back to any free port instead of throwing an uncaught
  // "A JavaScript error occurred" dialog at the user. The window uses whatever port we report back.
  let triedFallback = false;
  srv.on('error', (err) => {
    if (!triedFallback && err && err.code === 'EADDRINUSE') {
      triedFallback = true;
      srv.listen(0, '127.0.0.1', () => callback(srv.address().port));   // 0 = any free port
    } else {
      console.error('[STATIC SERVER ERROR]', (err && (err.code || err.message)) || err);
    }
  });
  srv.listen(37842, '127.0.0.1', () => callback(srv.address().port));
}

// ── Windows ───────────────────────────────────────────────────
function createMainWindow(startHidden) {
  mainWin = new BrowserWindow({
    width: 1280, height: 820, minWidth: 900, minHeight: 600,
    title: 'The Inflictor',
    show: !startHidden,
    icon: path.join(__dirname, '../icons/inflictor.ico'),
    webPreferences: { nodeIntegration: false, contextIsolation: true, backgroundThrottling: false },
  });
  mainWin.loadURL(`http://127.0.0.1:${staticPort}/`);
  mainWin.setMenuBarVisibility(false);
  mainWin.on('closed', () => { mainWin = null; });
  // MINIMIZE goes to the taskbar normally — the app keeps running there (so reminders still fire) and
  // it's one click to grab back. CLOSING (X) tucks it into the tray instead of quitting, so it keeps
  // running in the background for reminders. Actually quitting is the tray's "Quit" (sets isQuitting).
  mainWin.on('close', (e) => { if (!isQuitting && trayReady) { e.preventDefault(); mainWin.hide(); } });
}

// Bring the (possibly hidden) main window back, or recreate it.
function showMain() {
  if (mainWin) { if (mainWin.isMinimized()) mainWin.restore(); mainWin.show(); mainWin.focus(); }
  else if (staticPort) createMainWindow();
}

// System-tray presence so the app can run in the background and fire reminders with no window open.
function createTray() {
  if (tray) return;
  let img = null;
  for (const p of [path.join(__dirname, 'app', 'icons', 'inflictor.ico'),
                   path.join(__dirname, '..', 'icons', 'inflictor.ico'),
                   path.join(__dirname, 'app', 'icons', 'inflictor-icon-192x192.png')]) {
    try { if (fs.existsSync(p)) { const i = nativeImage.createFromPath(p); if (!i.isEmpty()) { img = i; break; } } } catch {}
  }
  try {
    tray = new Tray(img || nativeImage.createEmpty());
    trayReady = true;
    tray.setToolTip('The Inflictor');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open The Inflictor', click: showMain },
      { type: 'checkbox', label: 'Start with Windows',
        checked: app.getLoginItemSettings().openAtLogin,
        click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, openAsHidden: true }) },
      { type: 'separator' },
      { label: 'Quit The Inflictor', click: () => { isQuitting = true; app.quit(); } },
    ]));
    tray.on('click', showMain);
  } catch (e) { console.error('[TRAY] could not create tray:', e.message); trayReady = false; }
}

function createActivationWindow() {
  actWin = new BrowserWindow({
    width: 520, height: 440, resizable: false,
    title: 'The Inflictor — Activation',
    icon: path.join(__dirname, '../icons/inflictor.ico'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      // Pass the local server port so activate.html can reach the activation worker
    },
  });
  actWin.loadFile(path.join(__dirname, 'activate.html'));
  actWin.setMenuBarVisibility(false);
  actWin.on('closed', () => { actWin = null; });
}

// ── Single instance ───────────────────────────────────────────
// The app serves on a fixed port (37842); two copies would fight over it and
// hang. Allow only one instance — a second launch focuses the existing window.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => { if (actWin) { actWin.show(); actWin.focus(); } else showMain(); });

  // ── Boot ──────────────────────────────────────────────────────
  app.whenReady().then(() => {
    // Windows app identity — lets the installed app group & pin correctly on the taskbar
    if (process.platform === 'win32') app.setAppUserModelId('com.inflictor.app');
    createTray();
    // If Windows launched us at login (openAsHidden), stay tucked in the tray so reminders fire silently.
    const startedHidden = process.platform === 'win32' && app.getLoginItemSettings().wasOpenedAtLogin;
    startServer(port => {
      staticPort = port;
      if (ACTIVATION_ENABLED) { createActivationWindow(); return; }   // production gate first
      createMainWindow(startedHidden);                                // beta — straight to app
    });
  });
}

// ── Activation IPC (renderer → main) ─────────────────────────
ipcMain.on('activation-success', () => {
  if (actWin) actWin.close();
  createMainWindow();
});

ipcMain.on('activation-failed-permanently', () => {
  // Subscription lapsed beyond grace — quit or show expired screen
  app.quit();
});

// X now hides to the tray (see the window's 'close' handler), so the app keeps running for reminders.
// This only fires on a REAL quit — the tray's "Quit" sets isQuitting and lets the window actually close.
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { isQuitting = true; });
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    if (!ACTIVATION_ENABLED) createMainWindow();
    else createActivationWindow();
  }
});
