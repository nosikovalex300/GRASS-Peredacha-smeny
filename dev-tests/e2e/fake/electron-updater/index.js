// Заглушка electron-updater. 1.7.4: запоминает вызовы и умеет «выпустить» событие (тест обновления по кнопке).
const handlers = new Map();
const autoUpdater = {
  autoDownload: undefined, autoInstallOnAppQuit: undefined, allowDowngrade: undefined,
  __quitAndInstall: 0, __checks: 0,
  on(ev, fn) { handlers.set(ev, fn); return this; },
  checkForUpdates: async () => { autoUpdater.__checks++; return {}; },
  quitAndInstall() { autoUpdater.__quitAndInstall++; },
  __emit(ev, payload) { const fn = handlers.get(ev); if (fn) fn(payload); return !!fn; },
};
module.exports = { autoUpdater };
