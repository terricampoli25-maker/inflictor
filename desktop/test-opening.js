// Throwaway diagnostic: launch the REAL built app, force theme=standard, and report whether the
// Standard opening page actually renders. Run: electron test-opening.js   (from desktop/)
const { app, BrowserWindow } = require('electron');
const path = require('path');

const sleep = ms => new Promise(r => setTimeout(r, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1200, height: 800, webPreferences: { nodeIntegration: false, contextIsolation: true } });
  const idx = path.join(__dirname, 'app', 'index.html');
  await win.loadFile(idx);
  // Seed the theme, then reload so boot runs the standard path from the start.
  await win.webContents.executeJavaScript(`localStorage.setItem('inflictor_theme','standard'); true`);
  win.webContents.reload();
  await new Promise(r => win.webContents.once('did-finish-load', r));
  await sleep(1200); // let init() run and the opening fade in
  const res = await win.webContents.executeJavaScript(`(() => {
    const os = document.getElementById('opening-screen');
    const std = document.querySelector('.os-standard');
    const osCS = os ? getComputedStyle(os) : null;
    const stdCS = std ? getComputedStyle(std) : null;
    return JSON.stringify({
      theme: localStorage.getItem('inflictor_theme'),
      bodyClass: document.body.className,
      osExists: !!os, osDisplay: osCS && osCS.display, osOpacity: osCS && osCS.opacity,
      osVisibleClass: os && os.classList.contains('visible'),
      osBgColor: osCS && osCS.backgroundColor,
      stdExists: !!std, stdDisplay: stdCS && stdCS.display,
      stdText: std ? std.textContent.replace(/\\s+/g,' ').trim().slice(0,80) : null
    }, null, 1);
  })()`);
  console.log('OPENING-TEST-RESULT');
  console.log(res);
  const img = await win.webContents.capturePage();
  require('fs').writeFileSync(path.join(require('os').tmpdir(), 'infl-standard-opening.png'), img.toPNG());
  console.log('screenshot saved');
  app.quit();
}).catch(e => { console.error('TEST FAILED:', e); app.quit(); });
