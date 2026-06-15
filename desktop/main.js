const { app, BrowserWindow, ipcMain, net } = require('electron');
const path    = require('path');
const http    = require('http');
const https   = require('https');
const fs      = require('fs');
const { ACTIVATION_ENABLED } = require('./activation');

const CLOUDFLARE_API = 'https://inflictor.pages.dev';
const APP_DIR        = path.join(__dirname, 'app');

const MIME = {
  '.html':'text/html', '.js':'application/javascript', '.css':'text/css',
  '.png':'image/png',  '.jpg':'image/jpeg',  '.ico':'image/x-icon',
  '.mp3':'audio/mpeg', '.json':'application/json', '.woff2':'font/woff2',
  '.svg':'image/svg+xml', '.webp':'image/webp',
};

let staticPort = null;
let mainWin    = null;
let actWin     = null;

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
      proxy.on('response', pres => {
        // Electron's net already decompressed the body, so drop the upstream
        // content-encoding/length (and transfer-encoding) — otherwise the page
        // tries to decompress plain JSON again and ends up with an empty body.
        const h = { ...pres.headers };
        delete h['content-encoding']; delete h['content-length']; delete h['transfer-encoding'];
        res.writeHead(pres.statusCode, h);
        pres.on('data', chunk => res.write(chunk));
        pres.on('end',  ()    => res.end());
      });
      proxy.on('error', (err) => {
        console.error('[PROXY ERROR]', req.method, req.url, '->', target.href, '|', err.code || err.message, err);
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'offline' }));
      });
      req.on('data', chunk => proxy.write(chunk));
      req.on('end',  ()    => proxy.end());
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
  srv.listen(37842, '127.0.0.1', () => callback(srv.address().port));
}

// ── Windows ───────────────────────────────────────────────────
function createMainWindow() {
  mainWin = new BrowserWindow({
    width: 1280, height: 820, minWidth: 900, minHeight: 600,
    title: 'The Inflictor',
    icon: path.join(__dirname, '../icons/inflictor.ico'),
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  mainWin.loadURL(`http://127.0.0.1:${staticPort}/`);
  mainWin.setMenuBarVisibility(false);
  // TEMP DIAGNOSTIC: forward the renderer's console (logs + errors) to stdout
  mainWin.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    console.log(`[renderer:${level}] ${message}` + (sourceId ? `  (${sourceId}:${line})` : ''));
  });
  mainWin.on('closed', () => { mainWin = null; });
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

// ── Boot ──────────────────────────────────────────────────────
app.whenReady().then(() => {
  // Windows app identity — lets the installed app group & pin correctly on the taskbar
  if (process.platform === 'win32') app.setAppUserModelId('com.inflictor.app');
  startServer(port => {
    staticPort = port;
    if (!ACTIVATION_ENABLED) {
      // Beta mode — go straight to app
      createMainWindow();
    } else {
      // Production mode — show activation gate first
      createActivationWindow();
    }
  });
});

// ── Activation IPC (renderer → main) ─────────────────────────
ipcMain.on('activation-success', () => {
  if (actWin) actWin.close();
  createMainWindow();
});

ipcMain.on('activation-failed-permanently', () => {
  // Subscription lapsed beyond grace — quit or show expired screen
  app.quit();
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    if (!ACTIVATION_ENABLED) createMainWindow();
    else createActivationWindow();
  }
});
