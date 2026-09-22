const { app, BrowserWindow, Menu, ipcMain, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const { DatabaseSync, backup } = require('node:sqlite');

const APP_SCHEMA_VERSION = 4;
const SITES = { AHTUBA: 'Ахтуба', VOLZHSKY: 'Волжский' };
const GLOBAL_SETTINGS = new Set(['technologists']);
let activeSite = 'AHTUBA';
const APP_VERSION = app.getVersion();
const STORAGE_KEY = 'grass_v02';
const BACKUP_RETENTION = 14;
let mainWindow = null;

let database = null;
let databasePath = '';
let backupDir = '';

function normalizeSite(value) {
  return value === 'VOLZHSKY' ? 'VOLZHSKY' : 'AHTUBA';
}
function siteSettingKey(key, site = activeSite) {
  return GLOBAL_SETTINGS.has(key) ? key : `site:${normalizeSite(site)}:${key}`;
}
function setActiveSite(value) {
  activeSite = normalizeSite(value);
  return activeSite;
}

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


function ensureSiteSchema() {
  const addColumn = (table, column, definition) => {
    const columns = database.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some(row => row.name === column)) {
      database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  };
  addColumn('tasks', 'site_id', "TEXT NOT NULL DEFAULT 'AHTUBA'");
  addColumn('task_history', 'site_id', "TEXT NOT NULL DEFAULT 'AHTUBA'");
  addColumn('stats_archive', 'site_id', "TEXT NOT NULL DEFAULT 'AHTUBA'");
  addColumn('cleared_archive_ids', 'site_id', "TEXT NOT NULL DEFAULT 'AHTUBA'");
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_tasks_site ON tasks(site_id);
    CREATE INDEX IF NOT EXISTS idx_history_site ON task_history(site_id);
    CREATE INDEX IF NOT EXISTS idx_stats_site ON stats_archive(site_id);
    CREATE INDEX IF NOT EXISTS idx_cleared_site ON cleared_archive_ids(site_id);
  `);
}

function migrateSiteSettings() {
  const siteKeys = ['technologist','autoArchiveEnabled','autoArchiveDays','grass_tech_add_collapsed','shift'];
  for (const key of siteKeys) {
    const old = database.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    const target = siteSettingKey(key, 'AHTUBA');
    const existing = database.prepare('SELECT value FROM settings WHERE key = ?').get(target);
    if (old && !existing) {
      database.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run(target, old.value);
    }
    if (old) database.prepare('DELETE FROM settings WHERE key = ?').run(key);
  }
}


function ensureStage4Schema() {
  database.exec(`
    CREATE TABLE IF NOT EXISTS backup_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      kind TEXT NOT NULL,
      file_name TEXT NOT NULL,
      file_path TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL,
      description TEXT NOT NULL
    );
  `);
}

function recordSchemaMigration(version, description) {
  database.prepare(`
    INSERT OR IGNORE INTO schema_migrations(version, applied_at, description)
    VALUES(?,?,?)
  `).run(version, new Date().toISOString(), description);
}

async function migrateSchemaSafely() {
  const current = getSchemaVersion();
  if (current >= APP_SCHEMA_VERSION) {
    ensureStage4Schema();
    ensureSiteSchema();
    migrateSiteSettings();
    return;
  }

  const preMigrationBackup = await createDatabaseBackup(`pre-migration-v${APP_SCHEMA_VERSION}`);
  if (!preMigrationBackup) {
    throw new Error('Не удалось создать резервную копию перед обновлением структуры базы данных.');
  }

  try {
    database.exec('BEGIN IMMEDIATE');
    ensureStage4Schema();
    if (current < 3) {
      recordSchemaMigration(3, 'Добавлены журнал резервных копий и журнал миграций схемы.');
    }
    if (current < 4) {
      ensureSiteSchema();
      migrateSiteSettings();
      recordSchemaMigration(4, 'Добавлено разделение данных по площадкам: Ахтуба и Волжский. Список технологов общий.');
    }
    setMeta('schema_version', APP_SCHEMA_VERSION);
    setMeta('last_schema_migration', new Date().toISOString());
    database.exec('COMMIT');
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch (_) {}
    throw error;
  }
  console.log(`GRASS schema migration ${current} -> ${APP_SCHEMA_VERSION} completed. Backup: ${preMigrationBackup}`);
}

function logBackup(kind, target) {
  try {
    ensureStage4Schema();
    database.prepare('INSERT INTO backup_log(created_at,kind,file_name,file_path) VALUES(?,?,?,?)')
      .run(new Date().toISOString(), kind, path.basename(target), target);
  } catch (error) {
    console.error('GRASS backup log failed:', error);
  }
}

function listDatabaseBackups() {
  if (!backupDir || !fs.existsSync(backupDir)) return [];
  return fs.readdirSync(backupDir)
    .filter(name => /^grass-.*\.db$/i.test(name))
    .map(name => {
      const full = path.join(backupDir, name);
      try {
        const stat = fs.statSync(full);
        return { name, path: full, size: stat.size, createdAt: stat.mtime.toISOString() };
      } catch (error) {
        console.warn('GRASS backup file skipped:', name, error?.message || error);
        return null;
      }
    })
    .filter(Boolean)
    .sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function databaseInfo() {
  ensureStage4Schema();
  const stat = fs.existsSync(databasePath) ? fs.statSync(databasePath) : null;
  const tasks = database.prepare("SELECT COUNT(*) AS count FROM tasks WHERE site_id = ? AND state='active'").get(activeSite);
  const archive = database.prepare("SELECT COUNT(*) AS count FROM tasks WHERE site_id = ? AND state='archive'").get(activeSite);
  const history = database.prepare('SELECT COUNT(*) AS count FROM task_history WHERE site_id = ?').get(activeSite);
  const settings = database.prepare('SELECT COUNT(*) AS count FROM settings').get();
  const backupsList = listDatabaseBackups();
  const lastBackup = database.prepare('SELECT created_at FROM backup_log ORDER BY created_at DESC LIMIT 1').get();
  const latestFileBackup = backupsList[0]?.createdAt || null;
  const logBackupAt = lastBackup?.created_at || null;
  const lastBackupAt = logBackupAt && latestFileBackup
    ? (new Date(logBackupAt) >= new Date(latestFileBackup) ? logBackupAt : latestFileBackup)
    : (logBackupAt || latestFileBackup || null);
  return {
    ok: true,
    version: APP_VERSION,
    schemaVersion: getSchemaVersion(),
    path: databasePath,
    size: stat ? stat.size : 0,
    modifiedAt: stat ? stat.mtime.toISOString() : null,
    lastBackup: lastBackupAt,
    tasks: Number(tasks.count),
    archive: Number(archive.count),
    history: Number(history.count),
    settings: Number(settings.count),
    backups: backupsList.length
  };
}

function safeBackupPath(fileName) {
  if (!fileName || path.basename(fileName) !== fileName || !/^grass-.*\.db$/i.test(fileName)) return null;
  const candidate = path.resolve(backupDir, fileName);
  const base = path.resolve(backupDir) + path.sep;
  if (!candidate.startsWith(base)) return null;
  return candidate;
}

async function restoreDatabaseBackup(fileName) {
  const source = safeBackupPath(fileName);
  if (!source || !fs.existsSync(source)) return { ok:false, error:'Резервная копия не найдена.' };
  if (path.resolve(source) === path.resolve(databasePath)) return { ok:false, error:'Нельзя восстановить текущую базу поверх самой себя.' };

  const safety = await createDatabaseBackup('pre-restore');
  if (!safety) return { ok:false, error:'Не удалось создать страховочную копию перед восстановлением.' };

  try {
    if (database) { database.close(); database = null; }
    const wal = `${databasePath}-wal`, shm = `${databasePath}-shm`;
    try { if (fs.existsSync(wal)) fs.unlinkSync(wal); } catch (_) {}
    try { if (fs.existsSync(shm)) fs.unlinkSync(shm); } catch (_) {}
    fs.copyFileSync(source, databasePath);
    database = new DatabaseSync(databasePath);
    database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    ensureNormalizedSchema();
    ensureStage4Schema();
    ensureSiteSchema();
    if (getSchemaVersion() < APP_SCHEMA_VERSION) {
      await migrateSchemaSafely();
    }
    return { ok:true, name:path.basename(source), safetyBackup:path.basename(safety) };
  } catch (error) {
    console.error('GRASS restore failed:', error);
    return { ok:false, error:`Не удалось восстановить базу: ${error.message}` };
  }
}

function configureAutoUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = false;
  autoUpdater.on('checking-for-update', () => mainWindow?.webContents.send('grass-update-status', { state:'checking' }));
  autoUpdater.on('update-available', info => mainWindow?.webContents.send('grass-update-status', { state:'available', version:info.version }));
  autoUpdater.on('update-not-available', info => mainWindow?.webContents.send('grass-update-status', { state:'latest', version:info.version }));
  autoUpdater.on('download-progress', p => mainWindow?.webContents.send('grass-update-status', { state:'downloading', percent:Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', info => mainWindow?.webContents.send('grass-update-status', { state:'downloaded', version:info.version }));
  autoUpdater.on('error', error => mainWindow?.webContents.send('grass-update-status', { state:'error', error:error?.message || 'Ошибка обновления' }));
}

function taskColumns(task, state) {
  const known = new Set([
    'id','text','status','priority','comment','deadline','deadlineStoppedAt','author','shift','date','toShift',
    'lastActionBy','lastActionShift','lastActionAt','archivedAt','siteId','archivedBy','archivedShift','archivedFromStatus'
  ]);
  const extra = {};
  for (const [key, value] of Object.entries(task || {})) {
    if (!known.has(key)) extra[key] = value;
  }
  return {
    id: String(task?.id ?? ''),
    site_id: normalizeSite(task?.siteId || activeSite),
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
    siteId: row.site_id || 'AHTUBA',
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

function replaceNormalizedData(data, site = activeSite) {
  site = normalizeSite(site);
  ensureNormalizedSchema();
  const parsed = data && typeof data === 'object' ? data : {};
  const tasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
  const archive = Array.isArray(parsed.archive) ? parsed.archive : [];
  const history = Array.isArray(parsed.history) ? parsed.history : [];
  const statsArchive = Array.isArray(parsed.statsArchive) ? parsed.statsArchive : [];
  const clearedIds = Array.isArray(parsed.clearedArchiveIds) ? parsed.clearedArchiveIds : [];

  database.exec('BEGIN IMMEDIATE');
  try {
    database.prepare('DELETE FROM tasks WHERE site_id = ?').run(site);
    database.prepare('DELETE FROM task_history WHERE site_id = ?').run(site);
    database.prepare('DELETE FROM stats_archive WHERE site_id = ?').run(site);
    database.prepare('DELETE FROM cleared_archive_ids WHERE site_id = ?').run(site);

    const taskInsert = database.prepare(`
      INSERT INTO tasks(
        id,site_id,state,text,status,priority,comment,deadline,deadline_stopped_at,author,shift,date,to_shift,
        last_action_by,last_action_shift,last_action_at,archived_at,archived_by,archived_shift,archived_from_status,extra_json
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    for (const task of tasks) {
      const c = taskColumns(task, 'active');
      if (c.id) taskInsert.run(c.id,site,c.state,c.text,c.status,c.priority,c.comment,c.deadline,c.deadline_stopped_at,c.author,c.shift,c.date,c.to_shift,c.last_action_by,c.last_action_shift,c.last_action_at,c.archived_at,c.archived_by,c.archived_shift,c.archived_from_status,c.extra_json);
    }
    for (const task of archive) {
      const c = taskColumns(task, 'archive');
      if (c.id) taskInsert.run(c.id,site,c.state,c.text,c.status,c.priority,c.comment,c.deadline,c.deadline_stopped_at,c.author,c.shift,c.date,c.to_shift,c.last_action_by,c.last_action_shift,c.last_action_at,c.archived_at,c.archived_by,c.archived_shift,c.archived_from_status,c.extra_json);
    }

    const historyInsert = database.prepare(`
      INSERT INTO task_history(id,site_id,task_id,text,action,details,when_text,author,shift,deadline)
      VALUES(?,?,?,?,?,?,?,?,?,?)
    `);
    for (const item of history) {
      if (!item?.id) continue;
      historyInsert.run(String(item.id),site,String(item.taskId ?? ''),String(item.text ?? ''),String(item.action ?? ''),String(item.details ?? ''),String(item.when ?? ''),String(item.author ?? ''),String(item.shift ?? ''),String(item.deadline ?? ''));
    }

    const statsInsert = database.prepare('INSERT OR REPLACE INTO stats_archive(site_id,task_id,task_json) VALUES(?,?,?)');
    for (const task of statsArchive) {
      if (!task?.id) continue;
      statsInsert.run(site, String(task.id), JSON.stringify(task));
    }

    const clearedInsert = database.prepare('INSERT OR IGNORE INTO cleared_archive_ids(site_id,task_id) VALUES(?,?)');
    for (const id of clearedIds) clearedInsert.run(site, String(id));

    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function readNormalizedData(site = activeSite) {
  site = normalizeSite(site);
  ensureNormalizedSchema();
  const tasks = database.prepare("SELECT * FROM tasks WHERE site_id = ? AND state='active' ORDER BY json_extract(extra_json, '$.createdAt') DESC, rowid DESC").all(site).map(taskFromRow);
  const archive = database.prepare("SELECT * FROM tasks WHERE site_id = ? AND state='archive' ORDER BY json_extract(extra_json, '$.createdAt') DESC, rowid DESC").all(site).map(taskFromRow);
  const history = database.prepare('SELECT id,task_id,text,action,details,when_text,author,shift,deadline FROM task_history WHERE site_id = ? ORDER BY rowid DESC').all(site).map(row => ({
    id: row.id, taskId: row.task_id, text: row.text, action: row.action, details: row.details, when: row.when_text, author: row.author, shift: row.shift, deadline: row.deadline
  }));
  const statsArchive = database.prepare('SELECT task_json FROM stats_archive WHERE site_id = ? ORDER BY rowid ASC').all(site).map(row => {
    try { return JSON.parse(row.task_json); } catch (_) { return null; }
  }).filter(Boolean);
  const clearedArchiveIds = database.prepare('SELECT task_id FROM cleared_archive_ids WHERE site_id = ? ORDER BY rowid ASC').all(site).map(row => row.task_id);
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
  const dbKey = siteSettingKey(key);
  const row = database.prepare('SELECT value FROM settings WHERE key = ?').get(dbKey);
  if (row) return row.value;
  const legacy = dbGetLegacy(key);
  if (legacy !== null) {
    database.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(dbKey, legacy);
    return legacy;
  }
  return null;
}

function setSetting(key, value) {
  const dbKey = siteSettingKey(key);
  database.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(dbKey, value);
  dbSetLegacy(dbKey, value);
}

function removeSetting(key) {
  const dbKey = siteSettingKey(key);
  database.prepare('DELETE FROM settings WHERE key = ?').run(dbKey);
  dbRemoveLegacy(dbKey);
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
  if (getSchemaVersion() < 2) setMeta('schema_version', 2);
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
    logBackup(label, target);
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
  if (key === STORAGE_KEY) return JSON.stringify(readNormalizedData(activeSite));
  return getSetting(key);
}

function dbSet(key, value) {
  if (key === STORAGE_KEY) {
    let parsed;
    try { parsed = JSON.parse(value); } catch (_) { throw new Error('Некорректные данные приложения'); }
    replaceNormalizedData(parsed, activeSite);
    return;
  }
  setSetting(key, value);
}

function dbRemove(key) {
  if (key === STORAGE_KEY) {
    replaceNormalizedData({tasks:[],history:[],archive:[],statsArchive:[],clearedArchiveIds:[]}, activeSite);
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
    database.prepare('DELETE FROM tasks WHERE site_id = ?').run(activeSite);
    database.prepare('DELETE FROM task_history WHERE site_id = ?').run(activeSite);
    database.prepare('DELETE FROM stats_archive WHERE site_id = ?').run(activeSite);
    database.prepare('DELETE FROM cleared_archive_ids WHERE site_id = ?').run(activeSite);
    database.prepare('DELETE FROM settings WHERE key LIKE ?').run(`site:${activeSite}:%`);
    event.returnValue = true;
  });

  ipcMain.on('grass-db-key', (event, index) => {
    const keys = [STORAGE_KEY, ...database.prepare('SELECT key FROM settings WHERE key = ? OR key LIKE ? ORDER BY key').all('technologists', `site:${activeSite}:%`).map(row => row.key.replace(`site:${activeSite}:`, ''))];
    event.returnValue = keys[Number(index)] ?? null;
  });

  ipcMain.on('grass-db-length', (event) => {
    const count = database.prepare('SELECT COUNT(*) AS count FROM settings WHERE key = ? OR key LIKE ?').get('technologists', `site:${activeSite}:%`);
    event.returnValue = Number(count.count) + 1;
  });

  ipcMain.on('grass-site-set', (event, site) => {
    event.returnValue = setActiveSite(site);
  });

  ipcMain.on('grass-site-get', (event) => {
    event.returnValue = activeSite;
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

function registerAdminIpc() {
  ipcMain.handle('grass-admin-create-backup', async () => {
    const target = await createDatabaseBackup('manual');
    if (!target) return { ok: false, error: 'Не удалось создать резервную копию базы данных.' };
    pruneBackups();
    return { ok: true, path: target, name: path.basename(target) };
  });

  ipcMain.handle('grass-admin-list-backups', () => ({ ok:true, items:listDatabaseBackups() }));
  ipcMain.handle('grass-admin-get-backup-data', () => ({ ok:true, info:databaseInfo(), items:listDatabaseBackups() }));
  ipcMain.handle('grass-admin-open-backup-folder', async () => {
    const error = await shell.openPath(backupDir);
    return { ok: !error, error: error || null, path: backupDir };
  });
  ipcMain.handle('grass-admin-database-info', () => databaseInfo());
  ipcMain.handle('grass-admin-restore-backup', async (_event, fileName) => {
    const result = await restoreDatabaseBackup(String(fileName || ''));
    if (result.ok) {
      mainWindow?.webContents.send('grass-update-status', { state:'database-restored', name:result.name });
    }
    return result;
  });
  ipcMain.handle('grass-admin-check-updates', async () => {
    if (!app.isPackaged) return { ok:false, error:'Проверка обновлений доступна в установленной версии приложения.' };
    try {
      const result = await autoUpdater.checkForUpdates();
      return { ok:true, updateInfo:result?.updateInfo || null };
    } catch (error) {
      return { ok:false, error:error?.message || 'Не удалось проверить обновления.' };
    }
  });
  ipcMain.handle('grass-admin-install-update', () => {
    if (!app.isPackaged) return { ok:false, error:'Установка обновления доступна в установленной версии приложения.' };
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
    return { ok:true };
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

  mainWindow = win;
  win.on('closed', () => { if (mainWindow === win) mainWindow = null; });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(async () => {
  initDatabase();

  // First finish any legacy v1/v2 normalization, then migrate the schema safely.
  if (getSchemaVersion() < 2) {
    await createDatabaseBackup('pre-stage2');
    migrateLegacyKeyValueToNormalized();
  }
  await migrateSchemaSafely();

  registerDatabaseIpc();
  registerAdminIpc();
  configureAutoUpdater();
  createWindow();
  createDailyBackupIfNeeded().catch(error => console.error('GRASS daily backup failed:', error));
  if (app.isPackaged) {
    setTimeout(() => autoUpdater.checkForUpdates().catch(error => console.error('GRASS update check failed:', error)), 8000);
  }

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
