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
  setItem(key, value) { ipcRenderer.sendSync('grass-db-set', String(key), String(value)); },
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
  onUpdateStatus(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('grass-update-status', listener);
    return () => ipcRenderer.removeListener('grass-update-status', listener);
  }
});
