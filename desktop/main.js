const { app, BrowserWindow, ipcMain } = require('electron');
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
      const target    = new URL(req.url, CLOUDFLARE_API);
      const transport = target.protocol === 'https:' ? https : http;
      const options   = {
        hostname: target.hostname,
        port:     target.port || (target.protocol === 'https:' ? 443 : 80),
        path:     target.pathname + target.search,
        method:   req.method,
        headers:  { ...req.headers, host: target.hostname },
      };
      const proxy = transport.request(options, pres => {
        res.writeHead(pres.statusCode, pres.headers);
        pres.pipe(res);
      });
      proxy.on('error', () => {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'offline' }));
      });
      req.pipe(proxy);
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
    icon: path.join(APP_DIR, 'icons', 'inflictor-icon-256x256.png'),
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  mainWin.loadURL(`http://127.0.0.1:${staticPort}/`);
  mainWin.setMenuBarVisibility(false);
  mainWin.on('closed', () => { mainWin = null; });
}

function createActivationWindow() {
  actWin = new BrowserWindow({
    width: 520, height: 440, resizable: false,
    title: 'The Inflictor — Activation',
    icon: path.join(APP_DIR, 'icons', 'inflictor-icon-256x256.png'),
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
