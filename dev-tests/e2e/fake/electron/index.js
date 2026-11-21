// Заглушка Electron для стенда: main.js работает как в настоящем приложении,
// но IPC-обработчики попадают в реестр, откуда их вызывает HTTP-сервер стенда.
const handlers = { on: new Map(), handle: new Map() };
const appEvents = new Map();
let lockResult = process.env.GRASS_LOCK === '0' ? false : true;
const sent = [];
class BrowserWindow {
  constructor(opts) {
    this.opts = opts;
    const wcEvents = {};
    this.webContents = {
      send: (ch, payload) => sent.push({ ch, payload }),
      printToPDF: async () => Buffer.from('%PDF-1.4 стенд\n' + (this.html || ''), 'utf8'),
      // 1.7.12: защита окна — обработчики запоминаем, стенд проверит их ответ (/__security)
      on: (ev, fn) => { wcEvents[ev] = fn; },
      setWindowOpenHandler: (fn) => { this.windowOpenHandler = fn; },
      getURL: () => 'file:///app/index.html',
      __events: wcEvents,
    };
    this._events = {}; BrowserWindow._all.push(this); this.restored = 0; this.focused = 0; this._min = false; }
  on(ev, fn) { this._events[ev] = fn; }
  loadFile(f) { this.loaded = f; }
  async loadURL(u) { this.html = decodeURIComponent(String(u).replace(/^data:text\/html;charset=utf-8,/, '')); }
  destroy() { BrowserWindow._all = BrowserWindow._all.filter(w => w !== this); }
  isMinimized() { return this._min; }
  restore() { this.restored++; this._min = false; }
  focus() { this.focused++; }
  show() {}
  isFocused() { return false; }
  setOverlayIcon(img, desc) { module.exports.__overlay.push(img ? { img: img.dataUrl, desc } : null); }
  flashFrame(on) { module.exports.__flashes.push(!!on); }
  static getAllWindows() { return BrowserWindow._all; }
}
BrowserWindow._all = [];
module.exports = {
  __handlers: handlers, __appEvents: appEvents, __sent: sent,
  app: {
    getVersion: () => require(process.env.GRASS_APP_DIR + '/package.json').version,
    getPath: (name) => name === 'exe' ? require('path').join(process.env.GRASS_USERDATA, '__exe', 'GRASS.exe') : process.env.GRASS_USERDATA,
    whenReady: () => Promise.resolve(),
    on: (ev, fn) => { appEvents.set(ev, fn); },
    quit: () => { module.exports.__quitCalled = true; },
    exit: () => { module.exports.__quitCalled = true; },
    isPackaged: process.env.GRASS_TEST_PACKAGED === '1',   // 1.7.4: изображаем установленную программу
    __grassStand: true,   // 1.7.12: стенд — main.js слушает тестовые переменные и у «установленной» программы
    requestSingleInstanceLock: () => lockResult,
    setAppUserModelId: () => {},
  },
  BrowserWindow,
  // 1.7.6: уведомления и значок — запоминаем, тест проверит (/__state → notifications, overlay, flashes).
  Notification: class { constructor(o) { this.o = o; } static isSupported() { return true; } on() {} show() { module.exports.__notifications.push({ title: this.o.title, body: this.o.body }); } },
  nativeImage: { createFromDataURL: (u) => ({ dataUrl: String(u).slice(0, 40) }) },
  Menu: { setApplicationMenu() {} },
  session: { defaultSession: {
    setPermissionRequestHandler(fn) { module.exports.__permissionRequest = fn; },
    setPermissionCheckHandler(fn) { module.exports.__permissionCheck = fn; },
  } },
  ipcMain: { on: (ch, fn) => handlers.on.set(ch, fn), handle: (ch, fn) => handlers.handle.set(ch, fn) },
  shell: {
    openPath: async (f) => { module.exports.__opened.push(f); return require('fs').existsSync(f) ? '' : 'not found'; },
    showItemInFolder: (f) => { module.exports.__revealed.push(f); },
  },
  dialog: {
    // Окна ошибок не показываем, а запоминаем — тест проверит текст (/__state → errorBoxes).
    showErrorBox: (title, text) => { module.exports.__errorBoxes.push(String(text)); },
    // Первый запуск общей базы: ответ задаёт тест через GRASS_TEST_FIRSTRUN (0 — чистая, 1 — загрузить, 2 — отмена).
    showMessageBox: async (opts) => {
      module.exports.__messageBoxes.push(String(opts && opts.message || ''));
      return { response: Number(process.env.GRASS_TEST_MSGBOX || process.env.GRASS_TEST_FIRSTRUN || 0) };
    },
    // 1.7.6: «Сохранить как…» — файл ложится в <userData>/__exports под предложенным именем.
    showSaveDialog: async (_win, opts) => {
      const p = require('path'), dir = p.join(process.env.GRASS_USERDATA, '__exports');
      require('fs').mkdirSync(dir, { recursive: true });
      return { canceled: false, filePath: p.join(dir, p.basename(String(opts && opts.defaultPath || 'export'))) };
    },
    // Тест кладёт список путей в <userData>/__pick.json перед нажатием «Прикрепить»
    showOpenDialog: async () => {
      const fs = require('fs'), p = require('path').join(process.env.GRASS_USERDATA, '__pick.json');
      if (!fs.existsSync(p)) return { canceled: true, filePaths: [] };
      const list = JSON.parse(fs.readFileSync(p, 'utf8')); fs.unlinkSync(p);
      return { canceled: !list.length, filePaths: list };
    },
  },
  __opened: [], __revealed: [], __errorBoxes: [], __messageBoxes: [], __notifications: [], __overlay: [], __flashes: [],
};
