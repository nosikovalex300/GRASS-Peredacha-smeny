// Запуск настоящего main.js + HTTP-мост IPC для страницы в браузере.
// Использование: node run-main.js <appDir> <userDataDir> <port>
const path = require('path'), fs = require('fs'), http = require('http');
const [appDir, userData, port] = process.argv.slice(2);
process.env.GRASS_APP_DIR = path.resolve(appDir);
process.env.GRASS_USERDATA = path.resolve(userData);
fs.mkdirSync(userData, { recursive: true });
// Всегда заглушка Electron — даже если в папке приложения установлен настоящий (node_modules).
const Module = require('module');
const FAKE = path.join(__dirname, 'fake');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron' || request === 'electron-updater') return path.join(FAKE, request, 'index.js');
  return origResolve.call(this, request, ...rest);
};
const electron = require('electron');
const origErr = console.error;
const mainErrors = [];
console.error = (...a) => { mainErrors.push(a.map(String).join(' ')); origErr(...a); };
require(path.resolve(appDir, 'main.js'));

const PRELOAD = fs.readFileSync(path.resolve(appDir, 'preload.js'), 'utf8');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.css': 'text/css' };
function readBody(req) { return new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b ? JSON.parse(b) : {})); }); }
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  try {
    if (u.pathname === '/__preload.js') {
      res.writeHead(200, { 'Content-Type': types['.js'] });
      return res.end(PRELOAD);
    }
    if (u.pathname === '/__sync' || u.pathname === '/__invoke') {
      const { channel, args } = await readBody(req);
      const sync = u.pathname === '/__sync';
      const fn = (sync ? electron.__handlers.on : electron.__handlers.handle).get(channel);
      if (!fn) { res.writeHead(404); return res.end(JSON.stringify({ error: 'no handler ' + channel })); }
      const event = { returnValue: undefined, sender: {} };
      let value, error = null;
      try { value = sync ? (fn(event, ...(args || [])), event.returnValue) : await fn(event, ...(args || [])); }
      catch (e) { error = String(e && e.message || e); mainErrors.push('IPC ' + channel + ': ' + error); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ value: value === undefined ? null : value, undef: value === undefined, error }));
    }
    if (u.pathname === '/__state') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ mainErrors, quit: !!electron.__quitCalled, windows: electron.BrowserWindow.getAllWindows().length, opened: electron.__opened, revealed: electron.__revealed, errorBoxes: electron.__errorBoxes, messageBoxes: electron.__messageBoxes, notifications: electron.__notifications, overlay: electron.__overlay, flashes: electron.__flashes }));
    }
    if (u.pathname === '/__security') {   // 1.7.12: настройки окна и ответы защитных обработчиков
      const w = electron.BrowserWindow.getAllWindows().find(x => x.opts && x.opts.webPreferences && x.opts.webPreferences.preload);
      const probe = (ev, url) => { const fn = w && w.webContents.__events[ev]; if (!fn) return 'нет обработчика'; let prevented = false; fn({ preventDefault: () => { prevented = true; } }, url); return prevented ? 'запрещено' : 'разрешено'; };
      let permission = 'нет обработчика';
      if (electron.__permissionRequest) electron.__permissionRequest(null, 'media', ok => { permission = ok ? 'разрешено' : 'запрещено'; });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        webPreferences: w ? w.opts.webPreferences : null,
        navigateAway: probe('will-navigate', 'https://example.com/'),
        navigateSame: probe('will-navigate', 'file:///app/index.html'),
        redirectAway: probe('will-redirect', 'https://example.com/'),
        webview: probe('will-attach-webview', ''),
        windowOpen: w && w.windowOpenHandler ? w.windowOpenHandler({ url: 'https://example.com/' }).action : 'нет обработчика',
        permission,
        permissionCheck: electron.__permissionCheck ? electron.__permissionCheck(null, 'notifications') : 'нет обработчика',
      }));
    }
    if (u.pathname === '/__updater') {
      const up = require('electron-updater').autoUpdater;
      const ev = u.searchParams.get('emit');
      const emitted = ev ? up.__emit(ev, { version: u.searchParams.get('version') || '9.9.9' }) : false;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ emitted, quitAndInstall: up.__quitAndInstall, checks: up.__checks, autoInstallOnAppQuit: up.autoInstallOnAppQuit, autoDownload: up.autoDownload, sent: electron.__sent.filter(x => x.ch === 'grass-update-status').map(x => x.payload) }));
    }
    if (u.pathname === '/__second-instance') {
      const fn = electron.__appEvents.get('second-instance');
      const w = electron.BrowserWindow.getAllWindows()[0];
      if (w) w._min = true;
      if (fn) fn({}, [], '');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ handler: !!fn, restored: w ? w.restored : 0, focused: w ? w.focused : 0 }));
    }
    const file = path.join(path.resolve(appDir), decodeURIComponent(u.pathname === '/' ? '/index.html' : u.pathname));
    if (!file.startsWith(path.resolve(appDir)) || !fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  } catch (e) { res.writeHead(500); res.end(String(e.stack || e)); }
});
setTimeout(() => server.listen(Number(port), '127.0.0.1', () => console.log('READY ' + port)), 300);
function quit() { try { electron.__appEvents.get('before-quit')?.(); } catch (_) {} process.exit(0); }
process.on('SIGTERM', quit);
// На Windows SIGTERM не доставляется (terminate = жёсткое убийство) — стенд шлёт QUIT в stdin.
if (process.env.GRASS_STAND_STDIN_QUIT === '1') {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', c => { buf += c; if (/^QUIT$/m.test(buf)) quit(); });
}
