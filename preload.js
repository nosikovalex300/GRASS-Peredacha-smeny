const { contextBridge, ipcRenderer } = require('electron');

// One-time migration of the old Electron localStorage into SQLite.
// The old storage is read before the app starts using the new storage bridge.
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
  getItem(key) {
    return ipcRenderer.sendSync('grass-db-get', String(key));
  },
  setItem(key, value) {
    ipcRenderer.sendSync('grass-db-set', String(key), String(value));
  },
  removeItem(key) {
    ipcRenderer.sendSync('grass-db-remove', String(key));
  },
  clear() {
    ipcRenderer.sendSync('grass-db-clear');
  },
  key(index) {
    return ipcRenderer.sendSync('grass-db-key', Number(index));
  },
  get length() {
    return ipcRenderer.sendSync('grass-db-length');
  }
};


const grassAdmin = {
  getDatabaseInfo() {
    return JSON.parse(ipcRenderer.sendSync('grass-db-info'));
  },
  createBackup() {
    return ipcRenderer.invoke('grass-db-create-backup');
  },
  listBackups() {
    return ipcRenderer.invoke('grass-db-list-backups');
  },
  openBackupFolder() {
    return ipcRenderer.invoke('grass-db-open-backup-folder');
  },
  restoreBackup(fileName) {
    return ipcRenderer.invoke('grass-db-restore-backup', String(fileName));
  },
  checkForUpdates() {
    return ipcRenderer.invoke('grass-update-check');
  },
  installUpdate() {
    return ipcRenderer.invoke('grass-update-install');
  },
  onUpdateStatus(callback) {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('grass-update-status', listener);
    return () => ipcRenderer.removeListener('grass-update-status', listener);
  }
};

contextBridge.exposeInMainWorld('grassStorage', grassStorage);
contextBridge.exposeInMainWorld('grassAdmin', grassAdmin);
