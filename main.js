const { app, BrowserWindow, Menu, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { DatabaseSync, backup } = require('node:sqlite');

const APP_SCHEMA_VERSION = 2;
const STORAGE_KEY = 'grass_v02';
const BACKUP_RETENTION = 14;

let database = null;
let databasePath = '';
let backupDir = '';

function initDatabase() {
  const dataDir = path.join(app.getPath('userData'), 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  databasePath = path.join(dataDir, 'grass.db');
  backupDir = path.join(dataDir, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });

  database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS kv_store (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
  database.prepare(`
    INSERT INTO app_meta(key, value) VALUES('schema_version', '1')
    ON CONFLICT(key) DO NOTHING
  `).run();
}

function getSchemaVersion() {
  const row = database.prepare('SELECT value FROM app_meta WHERE key = ?').get('schema_version');
  return row ? Number(row.value) || 1 : 1;
}

function setMeta(key, value) {
  database.prepare(`
    INSERT INTO app_meta(key, value) VALUES(?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value));
}

function dbGetLegacy(key) {
  const row = database.prepare('SELECT value FROM kv_store WHERE key = ?').get(key);
  return row ? row.value : null;
}

function dbSetLegacy(key, value) {
  database.prepare(`
    INSERT INTO kv_store(key, value) VALUES(?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

function dbRemoveLegacy(key) {
  database.prepare('DELETE FROM kv_store WHERE key = ?').run(key);
}

function ensureNormalizedSchema() {
  database.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS technologists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      state TEXT NOT NULL CHECK(state IN ('active', 'archive')),
      text TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT '',
      priority TEXT NOT NULL DEFAULT 'Обычный',
      comment TEXT NOT NULL DEFAULT '',
      deadline TEXT NOT NULL DEFAULT '',
      deadline_stopped_at TEXT NOT NULL DEFAULT '',
      author TEXT NOT NULL DEFAULT '',
      shift TEXT NOT NULL DEFAULT '',
      date TEXT NOT NULL DEFAULT '',
      to_shift TEXT,
      last_action_by TEXT NOT NULL DEFAULT '',
      last_action_shift TEXT NOT NULL DEFAULT '',
      last_action_at TEXT NOT NULL DEFAULT '',
      archived_at TEXT NOT NULL DEFAULT '',
      archived_by TEXT NOT NULL DEFAULT '',
      archived_shift TEXT NOT NULL DEFAULT '',
      archived_from_status TEXT NOT NULL DEFAULT '',
      extra_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_state ON tasks(state);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_deadline ON tasks(deadline);

    CREATE TABLE IF NOT EXISTS task_history (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      text TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL DEFAULT '',
      details TEXT NOT NULL DEFAULT '',
      when_text TEXT NOT NULL DEFAULT '',
      author TEXT NOT NULL DEFAULT '',
      shift TEXT NOT NULL DEFAULT '',
      deadline TEXT NOT NULL DEFAULT ''
    );

    CREATE INDEX IF NOT EXISTS idx_task_history_task_id ON task_history(task_id);
    CREATE INDEX IF NOT EXISTS idx_task_history_when ON task_history(when_text);

    CREATE TABLE IF NOT EXISTS stats_archive (
      task_id TEXT PRIMARY KEY,
      task_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cleared_archive_ids (
      task_id TEXT PRIMARY KEY
    );
  `);
}

function taskColumns(task, state) {
  const known = new Set([
    'id','text','status','priority','comment','deadline','deadlineStoppedAt','author','shift','date','toShift',
    'lastActionBy','lastActionShift','lastActionAt','archivedAt','archivedBy','archivedShift','archivedFromStatus'
  ]);
  const extra = {};
  for (const [key, value] of Object.entries(task || {})) {
    if (!known.has(key)) extra[key] = value;
  }
  return {
    id: String(task?.id ?? ''),
    state,
    text: String(task?.text ?? ''),
    status: String(task?.status ?? ''),
    priority: String(task?.priority ?? 'Обычный'),
    comment: String(task?.comment ?? ''),
    deadline: String(task?.deadline ?? ''),
    deadline_stopped_at: String(task?.deadlineStoppedAt ?? ''),
    author: String(task?.author ?? ''),
    shift: String(task?.shift ?? ''),
    date: String(task?.date ?? ''),
    to_shift: task?.toShift == null ? null : String(task.toShift),
    last_action_by: String(task?.lastActionBy ?? ''),
    last_action_shift: String(task?.lastActionShift ?? ''),
    last_action_at: String(task?.lastActionAt ?? ''),
    archived_at: String(task?.archivedAt ?? ''),
    archived_by: String(task?.archivedBy ?? ''),
    archived_shift: String(task?.archivedShift ?? ''),
    archived_from_status: String(task?.archivedFromStatus ?? ''),
    extra_json: JSON.stringify(extra)
  };
}

function taskFromRow(row) {
  let extra = {};
  try { extra = JSON.parse(row.extra_json || '{}'); } catch (_) {}
  return {
    ...extra,
    id: row.id,
    text: row.text,
    status: row.status,
    priority: row.priority,
    comment: row.comment,
    deadline: row.deadline,
    deadlineStoppedAt: row.deadline_stopped_at,
    author: row.author,
    shift: row.shift,
    date: row.date,
    toShift: row.to_shift == null ? null : row.to_shift,
    lastActionBy: row.last_action_by,
    lastActionShift: row.last_action_shift,
    lastActionAt: row.last_action_at,
    ...(row.archived_at ? { archivedAt: row.archived_at } : {}),
    ...(row.archived_by ? { archivedBy: row.archived_by } : {}),
    ...(row.archived_shift ? { archivedShift: row.archived_shift } : {}),
    ...(row.archived_from_status ? { archivedFromStatus: row.archived_from_status } : {})
  };
}

function replaceNormalizedData(data) {
  ensureNormalizedSchema();
  const parsed = data && typeof data === 'object' ? data : {};
  const tasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
  const archive = Array.isArray(parsed.archive) ? parsed.archive : [];
  const history = Array.isArray(parsed.history) ? parsed.history : [];
  const statsArchive = Array.isArray(parsed.statsArchive) ? parsed.statsArchive : [];
  const clearedIds = Array.isArray(parsed.clearedArchiveIds) ? parsed.clearedArchiveIds : [];

  database.exec('BEGIN IMMEDIATE');
  try {
    database.exec('DELETE FROM tasks; DELETE FROM task_history; DELETE FROM stats_archive; DELETE FROM cleared_archive_ids;');

    const taskInsert = database.prepare(`
      INSERT INTO tasks(
        id,state,text,status,priority,comment,deadline,deadline_stopped_at,author,shift,date,to_shift,
        last_action_by,last_action_shift,last_action_at,archived_at,archived_by,archived_shift,archived_from_status,extra_json
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    for (const task of tasks) {
      const c = taskColumns(task, 'active');
      if (c.id) taskInsert.run(c.id,c.state,c.text,c.status,c.priority,c.comment,c.deadline,c.deadline_stopped_at,c.author,c.shift,c.date,c.to_shift,c.last_action_by,c.last_action_shift,c.last_action_at,c.archived_at,c.archived_by,c.archived_shift,c.archived_from_status,c.extra_json);
    }
    for (const task of archive) {
      const c = taskColumns(task, 'archive');
      if (c.id) taskInsert.run(c.id,c.state,c.text,c.status,c.priority,c.comment,c.deadline,c.deadline_stopped_at,c.author,c.shift,c.date,c.to_shift,c.last_action_by,c.last_action_shift,c.last_action_at,c.archived_at,c.archived_by,c.archived_shift,c.archived_from_status,c.extra_json);
    }

    const historyInsert = database.prepare(`
      INSERT INTO task_history(id,task_id,text,action,details,when_text,author,shift,deadline)
      VALUES(?,?,?,?,?,?,?,?,?)
    `);
    for (const item of history) {
      if (!item?.id) continue;
      historyInsert.run(String(item.id),String(item.taskId ?? ''),String(item.text ?? ''),String(item.action ?? ''),String(item.details ?? ''),String(item.when ?? ''),String(item.author ?? ''),String(item.shift ?? ''),String(item.deadline ?? ''));
    }

    const statsInsert = database.prepare('INSERT OR REPLACE INTO stats_archive(task_id,task_json) VALUES(?,?)');
    for (const task of statsArchive) {
      if (!task?.id) continue;
      statsInsert.run(String(task.id), JSON.stringify(task));
    }

    const clearedInsert = database.prepare('INSERT OR IGNORE INTO cleared_archive_ids(task_id) VALUES(?)');
    for (const id of clearedIds) clearedInsert.run(String(id));

    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function readNormalizedData() {
  ensureNormalizedSchema();
  const tasks = database.prepare("SELECT * FROM tasks WHERE state='active' ORDER BY rowid DESC").all().map(taskFromRow);
  const archive = database.prepare("SELECT * FROM tasks WHERE state='archive' ORDER BY rowid DESC").all().map(taskFromRow);
  const history = database.prepare('SELECT id,task_id,text,action,details,when_text,author,shift,deadline FROM task_history ORDER BY rowid DESC').all().map(row => ({
    id: row.id, taskId: row.task_id, text: row.text, action: row.action, details: row.details, when: row.when_text, author: row.author, shift: row.shift, deadline: row.deadline
  }));
  const statsArchive = database.prepare('SELECT task_json FROM stats_archive ORDER BY rowid ASC').all().map(row => {
    try { return JSON.parse(row.task_json); } catch (_) { return null; }
  }).filter(Boolean);
  const clearedArchiveIds = database.prepare('SELECT task_id FROM cleared_archive_ids ORDER BY rowid ASC').all().map(row => row.task_id);
  return { tasks, history, archive, statsArchive, clearedArchiveIds };
}

function syncNormalizedFromLegacyKeyValue() {
  ensureNormalizedSchema();
  const raw = dbGetLegacy(STORAGE_KEY);
  if (!raw) return false;
  let parsed;
  try { parsed = JSON.parse(raw); } catch (_) { return false; }
  replaceNormalizedData(parsed);
  return true;
}

function getSetting(key) {
  const row = database.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (row) return row.value;
  const legacy = dbGetLegacy(key);
  if (legacy !== null) {
    database.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key, legacy);
    return legacy;
  }
  return null;
}

function setSetting(key, value) {
  database.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
  dbSetLegacy(key, value);
}

function removeSetting(key) {
  database.prepare('DELETE FROM settings WHERE key = ?').run(key);
  dbRemoveLegacy(key);
}

function isLegacyMigrationDone() {
  const row = database.prepare('SELECT value FROM app_meta WHERE key = ?').get('legacy_migration_done');
  return row?.value === '1';
}

function migrateLegacyKeyValueToNormalized() {
  ensureNormalizedSchema();
  const currentVersion = getSchemaVersion();
  if (currentVersion >= APP_SCHEMA_VERSION) return false;
  const migrated = syncNormalizedFromLegacyKeyValue();
  const knownSettings = ['technologist','technologists','autoArchiveEnabled','autoArchiveDays','grass_tech_add_collapsed','shift'];
  for (const key of knownSettings) {
    const value = dbGetLegacy(key);
    if (value !== null) database.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key, value);
  }
  if (getSchemaVersion() < APP_SCHEMA_VERSION) setMeta('schema_version', APP_SCHEMA_VERSION);
  if (dbGetLegacy(STORAGE_KEY) !== null) setMeta('legacy_migration_done', '1');
  setMeta('last_normalized_migration', new Date().toISOString());
  return migrated;
}

async function createDatabaseBackup(label = 'daily') {
  if (!database || !backupDir) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(backupDir, `grass-${label}-${stamp}.db`);
  try {
    await backup(database, target, { rate: 200 });
    return target;
  } catch (error) {
    console.error('GRASS SQLite backup failed:', error);
    try { if (fs.existsSync(target)) fs.unlinkSync(target); } catch (_) {}
    return null;
  }
}

function pruneBackups() {
  if (!backupDir || !fs.existsSync(backupDir)) return;
  const files = fs.readdirSync(backupDir)
    .filter(name => /^grass-.*\.db$/i.test(name))
    .map(name => ({name, full:path.join(backupDir,name), mtime:fs.statSync(path.join(backupDir,name)).mtimeMs}))
    .sort((a,b) => b.mtime-a.mtime);
  for (const item of files.slice(BACKUP_RETENTION)) {
    try { fs.unlinkSync(item.full); } catch (_) {}
  }
}

async function createDailyBackupIfNeeded() {
  if (!backupDir) return;
  const today = new Date().toISOString().slice(0,10);
  const exists = fs.existsSync(backupDir) && fs.readdirSync(backupDir).some(name => name.includes(`daily-${today}`));
  if (!exists) await createDatabaseBackup('daily');
  pruneBackups();
}

function dbGet(key) {
  if (key === STORAGE_KEY) return JSON.stringify(readNormalizedData());
  return getSetting(key);
}

function dbSet(key, value) {
  if (key === STORAGE_KEY) {
    let parsed;
    try { parsed = JSON.parse(value); } catch (_) { throw new Error('Некорректные данные приложения'); }
    replaceNormalizedData(parsed);
    return;
  }
  setSetting(key, value);
}

function dbRemove(key) {
  if (key === STORAGE_KEY) {
    replaceNormalizedData({tasks:[],history:[],archive:[],statsArchive:[],clearedArchiveIds:[]});
    return;
  }
  removeSetting(key);
}

function registerDatabaseIpc() {
  ipcMain.on('grass-db-get', (event, key) => {
    event.returnValue = dbGet(String(key));
  });

  ipcMain.on('grass-db-set', (event, key, value) => {
    dbSet(String(key), String(value));
    event.returnValue = true;
  });

  ipcMain.on('grass-db-remove', (event, key) => {
    dbRemove(String(key));
    event.returnValue = true;
  });

  ipcMain.on('grass-db-clear', (event) => {
    database.exec('DELETE FROM settings; DELETE FROM tasks; DELETE FROM task_history; DELETE FROM stats_archive; DELETE FROM cleared_archive_ids; DELETE FROM kv_store;');
    event.returnValue = true;
  });

  ipcMain.on('grass-db-key', (event, index) => {
    const keys = [STORAGE_KEY, ...database.prepare('SELECT key FROM settings ORDER BY key').all().map(row => row.key)];
    event.returnValue = keys[Number(index)] ?? null;
  });

  ipcMain.on('grass-db-length', (event) => {
    const count = database.prepare('SELECT COUNT(*) AS count FROM settings').get();
    event.returnValue = Number(count.count) + 1;
  });

  ipcMain.on('grass-db-migrate', (event, legacyData) => {
    let migrated = 0;
    try {
      ensureNormalizedSchema();
      if (!isLegacyMigrationDone() && legacyData && typeof legacyData === 'object') {
        for (const [key, value] of Object.entries(legacyData)) {
          if (dbGetLegacy(key) === null) {
            dbSetLegacy(key, value);
            migrated++;
          }
        }
        if (dbGetLegacy(STORAGE_KEY) !== null) {
          syncNormalizedFromLegacyKeyValue();
          const knownSettings = ['technologist','technologists','autoArchiveEnabled','autoArchiveDays','grass_tech_add_collapsed','shift'];
          for (const key of knownSettings) {
            const value = dbGetLegacy(key);
            if (value !== null) database.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key, value);
          }
          database.exec('DELETE FROM kv_store');
          setMeta('legacy_migration_done', '1');
          setMeta('last_migration', new Date().toISOString());
        }
      }
    } catch (error) {
      console.error('GRASS normalized migration failed:', error);
    }
    event.returnValue = migrated;
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 700,
    title: 'GRASS — Передача смены',
    icon: path.join(__dirname, 'GRASS_icon.ico'),
    backgroundColor: '#02150f',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(async () => {
  initDatabase();

  // Before changing the schema for the first time, preserve the existing DB exactly as-is.
  if (getSchemaVersion() < APP_SCHEMA_VERSION) {
    await createDatabaseBackup('pre-stage3');
    migrateLegacyKeyValueToNormalized();
  }

  registerDatabaseIpc();
  createWindow();
  createDailyBackupIfNeeded().catch(error => console.error('GRASS daily backup failed:', error));

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  if (database) {
    try { database.close(); } catch (_) {}
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
