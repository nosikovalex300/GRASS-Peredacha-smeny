const { contextBridge, ipcRenderer } = require('electron');

let selectedSite = 'AHTUBA';
try {
  const storedSite = window.localStorage.getItem('grass_selected_site');
  selectedSite = storedSite === 'VOLZHSKY' ? 'VOLZHSKY' : (storedSite === 'AHTUBA' ? 'AHTUBA' : 'AHTUBA');
  ipcRenderer.sendSync('grass-site-set', selectedSite);
} catch (error) {
  console.error('GRASS site initialization failed:', error);
}

// One-time migration of the old Electron localStorage into SQLite.
const legacy = window.localStorage;
const legacyData = {};
try {
  for (let i = 0; i < legacy.length; i++) {
    const key = legacy.key(i);
    if (key !== null) legacyData[key] = legacy.getItem(key);
  }
  ipcRenderer.sendSync('grass-db-migrate', legacyData);
} catch (error) {
  console.error('GRASS SQLite migration failed:', error);
}

const grassStorage = {
  getItem(key) { return ipcRenderer.sendSync('grass-db-get', String(key)); },
  setItem(key, value) { return ipcRenderer.sendSync('grass-db-set', String(key), String(value)); },
  patch(key, value) { return ipcRenderer.sendSync('grass-db-patch', String(key), String(value)); },
  // 1.7.2: общая база — что изменили другие после номера изменения since, режим работы, кто я.
  changes(since) { return ipcRenderer.sendSync('grass-db-changes', Number(since) || 0); },
  mode() { return ipcRenderer.sendSync('grass-mode'); },
  sessionSet(name) { return ipcRenderer.sendSync('grass-session-set', String(name || '')); },
  // 1.7.3: результат проверки базы и места на диске.
  health() { return ipcRenderer.sendSync('grass-health'); },
  removeItem(key) { ipcRenderer.sendSync('grass-db-remove', String(key)); },
  clear() { ipcRenderer.sendSync('grass-db-clear'); },
  key(index) { return ipcRenderer.sendSync('grass-db-key', Number(index)); },
  get length() { return ipcRenderer.sendSync('grass-db-length'); }
};

contextBridge.exposeInMainWorld('grassStorage', grassStorage);
contextBridge.exposeInMainWorld('grassSite', {
  get() { return ipcRenderer.sendSync('grass-site-get'); },
  set(site) {
    const normalized = site === 'VOLZHSKY' ? 'VOLZHSKY' : 'AHTUBA';
    try { window.localStorage.setItem('grass_selected_site', normalized); } catch (_) {}
    return ipcRenderer.sendSync('grass-site-set', normalized);
  },
  label(site) { return site === 'VOLZHSKY' ? 'Волжский' : 'Ахтуба'; }
});
contextBridge.exposeInMainWorld('grassAdmin', {
  createBackup() { return ipcRenderer.invoke('grass-admin-create-backup'); },
  listBackups() { return ipcRenderer.invoke('grass-admin-list-backups'); },
  getBackupData() { return ipcRenderer.invoke('grass-admin-get-backup-data'); },
  openBackupFolder() { return ipcRenderer.invoke('grass-admin-open-backup-folder'); },
  getDatabaseInfo() { return ipcRenderer.invoke('grass-admin-database-info'); },
  restoreBackup(fileName) { return ipcRenderer.invoke('grass-admin-restore-backup', String(fileName || '')); },
  checkForUpdates() { return ipcRenderer.invoke('grass-admin-check-updates'); },
  installUpdate() { return ipcRenderer.invoke('grass-admin-install-update'); },
  mirrorNow() { return ipcRenderer.invoke('grass-admin-mirror-now'); },
  verifyBackup() { return ipcRenderer.invoke('grass-admin-verify-backup'); },
  chooseMirror() { return ipcRenderer.invoke('grass-admin-choose-mirror'); },
  attachmentsInfo() { return ipcRenderer.invoke('grass-admin-attachments-info'); },
  purgeClearedAttachments() { return ipcRenderer.invoke('grass-admin-purge-cleared-attachments'); },
  onUpdateStatus(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('grass-update-status', listener);
    return () => ipcRenderer.removeListener('grass-update-status', listener);
  }
});
// 1.7.6: выгрузка в Excel и PDF (файл выбирает технолог в окне «Сохранить»).
contextBridge.exposeInMainWorld('grassExport', {
  xlsx(name, base64) { return ipcRenderer.invoke('grass-export-xlsx', String(name || ''), String(base64 || '')); },
  pdf(name, html) { return ipcRenderer.invoke('grass-export-pdf', String(name || ''), String(html || '')); },
  open(file) { return ipcRenderer.invoke('grass-export-open', String(file || '')); }
});
// 1.7.6: уведомления Windows и значок в панели задач.
contextBridge.exposeInMainWorld('grassNotify', {
  show(title, body) { return ipcRenderer.invoke('grass-notify', String(title || ''), String(body || '')); },
  taskbar(count, badgeDataUrl, flash) { return ipcRenderer.invoke('grass-taskbar', Number(count) || 0, String(badgeDataUrl || ''), !!flash); }
});
contextBridge.exposeInMainWorld('grassAttachments', {
  add(taskId) { return ipcRenderer.invoke('grass-attach-add', String(taskId || '')); },
  open(stored) { return ipcRenderer.invoke('grass-attach-open', String(stored || '')); },
  reveal(stored) { return ipcRenderer.invoke('grass-attach-reveal', String(stored || '')); },
  exists(list) { return ipcRenderer.invoke('grass-attach-exists', Array.isArray(list) ? list.map(String) : []); }
});
