const { app, BrowserWindow, Menu, ipcMain, shell, dialog, Notification, nativeImage } = require('electron');
const crypto = require('crypto');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { DatabaseSync, backup } = require('node:sqlite');

const APP_SCHEMA_VERSION = 6;
const SITES = { AHTUBA: 'Ахтуба', VOLZHSKY: 'Волжский' };
const GLOBAL_SETTINGS = new Set(['technologists', 'backupMirrorDir', 'shiftSchedule']);   // 1.7.6: график смен общий для площадок
let activeSite = 'AHTUBA';
const APP_VERSION = app.getVersion();
const STORAGE_KEY = 'grass_v02';
const BACKUP_RETENTION = 14;
// 1.7.3: сколько копий каждого вида хранить. Копии перед обновлением структуры базы не удаляются.
const BACKUP_KEEP = { daily: 14, manual: 10 };
const BACKUP_KIND_GROUP = { daily: 'daily', manual: 'manual', 'pre-restore': 'manual', mirror: 'manual' };
const DAILY_CHECK_MS = Number(process.env.GRASS_DAILY_CHECK_MS) || 60 * 60 * 1000;
const MIN_FREE_MB = Number(process.env.GRASS_MIN_FREE_MB) || 500;
let mainWindow = null;

let database = null;
let databasePath = '';
let backupDir = '';
let attachmentsDir = '';
const ATTACHMENT_MAX_BYTES = 100 * 1024 * 1024;

// ---------- 1.7.2: общая база для терминала ----------
// Если есть grass-config.json с папкой данных — работаем с общей базой: одна папка на всех,
// одновременно несколько копий программы (каждый пользователь терминала запускает свою).
// Без файла — как раньше: база в профиле пользователя.
let sharedMode = false;
let sharedConfigPath = '';
const SESSION_ID = crypto.randomUUID();
const SESSION_STARTED_AT = new Date().toISOString();
const SESSION_ACTIVE_MS = 90 * 1000;
let sessionTechnologist = '';
function osUserName() { try { return os.userInfo().username || ''; } catch (_) { return process.env.USERNAME || ''; } }

function sharedConfigCandidates() {
  if (process.env.GRASS_CONFIG_FILE) return [process.env.GRASS_CONFIG_FILE];
  const list = [];
  const programData = process.env.ProgramData || process.env.PROGRAMDATA;
  if (programData) list.push(path.join(programData, 'GRASS-Peredacha-smeny', 'grass-config.json'));
  try { list.push(path.join(path.dirname(app.getPath('exe')), 'grass-config.json')); } catch (_) {}
  return list;
}
function readSharedConfig() {
  for (const file of sharedConfigCandidates()) {
    if (!fs.existsSync(file)) continue;
    let cfg;
    try { cfg = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); }
    catch (error) { return { error: `Файл настройки общей базы повреждён:\n${file}\n\n${error.message}` }; }
    if (!cfg || typeof cfg.dataDir !== 'string' || !cfg.dataDir.trim()) return { error: `В файле настройки не указана папка общей базы (dataDir):\n${file}` };
    return { path: file, dataDir: path.resolve(cfg.dataDir.trim()) };
  }
  return null;
}
function checkWritableDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const probe = path.join(dir, `.grass-write-test-${process.pid}-${Date.now()}`);
  fs.writeFileSync(probe, 'ok');
  fs.unlinkSync(probe);
}

// Личные настройки пользователя (кто я, выбранная смена) — в его профиле, а не в общей базе:
// иначе в терминале выбор одного технолога стал бы выбором для всех.
const USER_SETTINGS = new Set(['technologist', 'shift', 'grass_tech_add_collapsed']);
let userSettingsPath = '';
let userSettings = { values: {} };
function loadUserSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(userSettingsPath, 'utf8'));
    userSettings = parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) { userSettings = {}; }
  if (!userSettings.values || typeof userSettings.values !== 'object') userSettings.values = {};
}
function saveUserSettings() {
  if (!userSettingsPath) return;
  fs.mkdirSync(path.dirname(userSettingsPath), { recursive: true });
  const tmp = `${userSettingsPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(userSettings, null, 1));
  fs.renameSync(tmp, userSettingsPath);
}
function userSettingKey(key) { return `${normalizeSite(activeSite)}:${key}`; }

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

function openDatabaseFile(file) {
  const db = new DatabaseSync(file);
  try {
    // Сначала ожидание занятой базы: в терминале с ней одновременно работают несколько копий программы.
    db.exec('PRAGMA busy_timeout = 10000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  } catch (error) {
    // 1.7.10: файл не база — закрываем, иначе Windows не даст переименовать его при восстановлении копии.
    try { db.close(); } catch (_) {}
    throw error;
  }
  return db;
}

function initDatabase(dataDir = path.join(app.getPath('userData'), 'data')) {
  fs.mkdirSync(dataDir, { recursive: true });
  databasePath = path.join(dataDir, 'grass.db');
  backupDir = path.join(dataDir, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  attachmentsDir = path.join(dataDir, 'attachments');
  fs.mkdirSync(attachmentsDir, { recursive: true });

  database = openDatabaseFile(databasePath);
  database.exec(`
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

function getMeta(key) {
  const row = database.prepare('SELECT value FROM app_meta WHERE key = ?').get(key);
  return row ? row.value : null;
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
  ensureHistoryColumnsV5();
}

// v5: точное время события, статус на момент события и прочие поля истории.
// До v5 этих колонок не было, и после перезапуска время/статус событий терялись.
function ensureHistoryColumnsV5() {
  const columns = database.prepare('PRAGMA table_info(task_history)').all().map(row => row.name);
  if (!columns.includes('at')) database.exec("ALTER TABLE task_history ADD COLUMN at TEXT NOT NULL DEFAULT ''");
  if (!columns.includes('status')) database.exec("ALTER TABLE task_history ADD COLUMN status TEXT NOT NULL DEFAULT ''");
  if (!columns.includes('extra_json')) database.exec("ALTER TABLE task_history ADD COLUMN extra_json TEXT NOT NULL DEFAULT '{}'");
  database.exec('CREATE INDEX IF NOT EXISTS idx_task_history_at ON task_history(at)');
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

// v6 (1.7.2): общая база. У задачи номер версии (rev) — запись проходит, только если с момента,
// когда окно её прочитало, задачу никто не менял. Номер изменения (seq) у каждой строки и журнал
// удалённых — по ним другие окна подтягивают только новое. sessions — кто сейчас в программе.
function addColumnIfMissing(table, column, definition) {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some(row => row.name === column)) database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
function ensureV6Schema() {
  addColumnIfMissing('tasks', 'rev', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing('tasks', 'seq', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing('task_history', 'seq', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing('stats_archive', 'seq', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing('cleared_archive_ids', 'seq', 'INTEGER NOT NULL DEFAULT 0');
  database.exec(`
    CREATE TABLE IF NOT EXISTS deleted_rows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      row_id TEXT NOT NULL,
      site_id TEXT NOT NULL,
      seq INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      os_user TEXT NOT NULL DEFAULT '',
      technologist TEXT NOT NULL DEFAULT '',
      site_id TEXT NOT NULL DEFAULT '',
      app_version TEXT NOT NULL DEFAULT '',
      started_at TEXT NOT NULL DEFAULT '',
      last_seen TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_seq ON tasks(seq);
    CREATE INDEX IF NOT EXISTS idx_history_seq ON task_history(seq);
    CREATE INDEX IF NOT EXISTS idx_stats_seq ON stats_archive(seq);
    CREATE INDEX IF NOT EXISTS idx_cleared_seq ON cleared_archive_ids(seq);
    CREATE INDEX IF NOT EXISTS idx_deleted_seq ON deleted_rows(seq);
  `);
}
function sessionsTableExists() {
  return !!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sessions'").get();
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
  invalidateRowCache();
  const current = getSchemaVersion();
  if (current > APP_SCHEMA_VERSION) {
    const error = new Error('База данных создана более новой версией программы.');
    error.code = 'GRASS_DB_NEWER';
    throw error;
  }
  if (current >= APP_SCHEMA_VERSION) {
    ensureStage4Schema();
    ensureSiteSchema();
    ensureHistoryColumnsV5();
    ensureV6Schema();
    migrateSiteSettings();
    return;
  }

  const preMigrationBackup = await createDatabaseBackup(`pre-migration-v${APP_SCHEMA_VERSION}`);
  if (!preMigrationBackup) {
    throw new Error('Не удалось создать резервную копию перед обновлением структуры базы данных.');
  }

  try {
    database.exec('BEGIN IMMEDIATE');
    // Пока ждали блокировку, структуру могла обновить другая копия программы (общая база).
    if (getSchemaVersion() >= APP_SCHEMA_VERSION) {
      database.exec('COMMIT');
      ensureV6Schema();
      return;
    }
    ensureStage4Schema();
    if (current < 3) {
      recordSchemaMigration(3, 'Добавлены журнал резервных копий и журнал миграций схемы.');
    }
    if (current < 4) {
      ensureSiteSchema();
      migrateSiteSettings();
      recordSchemaMigration(4, 'Добавлено разделение данных по площадкам: Ахтуба и Волжский. Список технологов общий.');
    }
    if (current < 5) {
      ensureSiteSchema();
      ensureHistoryColumnsV5();
      const filled = migrateDatesToIsoV5(new Date());
      recordSchemaMigration(5, `Точное время и статус событий истории, даты с годом (ISO). Дозаполнено записей: ${filled}.`);
    }
    if (current < 6) {
      ensureV6Schema();
      recordSchemaMigration(6, 'Общая база: версии задач, журнал изменений и удалений, кто сейчас в программе.');
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

// ---------- v5: даты с годом ----------
// До 1.7 даты хранились как «21.10, 22:40» — без года. Восстанавливаем год:
// самый поздний год, при котором дата не позже «сейчас + 1 день» и не раньше создания задачи.
const LEGACY_SHORT_DATE = /^(\d{2})\.(\d{2})(?:\.(\d{4}))?,?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/;
function legacyToDate(value, now, notBefore) {
  const m = LEGACY_SHORT_DATE.exec(String(value || '').trim());
  if (!m) return null;
  const make = y => new Date(y, Number(m[2]) - 1, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6] || 0), 0);
  if (m[3]) return make(Number(m[3]));
  const limit = now.getTime() + 86400000;
  let fallback = null;
  for (let y = now.getFullYear(); y >= now.getFullYear() - 5; y--) {
    const d = make(y);
    if (d.getTime() > limit) continue;            // не может быть в будущем
    if (!fallback) fallback = d;
    if (!notBefore || d.getTime() >= notBefore.getTime() - 86400000) return d;
  }
  return fallback || make(now.getFullYear());
}
function toIsoOrKeep(value, now, notBefore) {
  if (!value) return value;
  if (/^\d{4}-\d{2}-\d{2}T/.test(String(value))) return value;
  const d = legacyToDate(value, now, notBefore);
  return d ? d.toISOString() : value;
}
const HISTORY_ACTION_ORDER = ['Создана задача', 'Передана по смене', 'Задача принята', 'Изменён статус', 'Изменена задача'];
function migrateDatesToIsoV5(now) {
  let filled = 0;
  const taskRows = database.prepare('SELECT * FROM tasks').all();
  const createdById = new Map();
  const updTask = database.prepare('UPDATE tasks SET date=?, last_action_at=?, archived_at=?, extra_json=? WHERE id=?');
  for (const row of taskRows) {
    let extra = {};
    try { extra = JSON.parse(row.extra_json || '{}'); } catch (_) {}
    const created = extra.createdAt && !isNaN(new Date(extra.createdAt)) ? new Date(extra.createdAt) : null;
    const date = toIsoOrKeep(row.date, now, null);
    const createdAt = created || (date && /^\d{4}-/.test(date) ? new Date(date) : null);
    if (createdAt) createdById.set(row.id, createdAt);
    const lastActionAt = extra.lastActionAtIso || toIsoOrKeep(row.last_action_at, now, createdAt);
    const archivedAt = toIsoOrKeep(row.archived_at, now, createdAt);
    for (const key of ['restoredAt', 'acceptedAt']) if (extra[key]) extra[key] = toIsoOrKeep(extra[key], now, createdAt);
    const extraJson = JSON.stringify(extra);
    if (date !== row.date || lastActionAt !== row.last_action_at || archivedAt !== row.archived_at || extraJson !== row.extra_json) {
      updTask.run(date || '', lastActionAt || '', archivedAt || '', extraJson, row.id);
      filled++;
    }
  }
  // История: точное время из «21.10, 22:40». Внутри одной минуты сохраняем логичный порядок действий.
  const rank = a => { const i = HISTORY_ACTION_ORDER.indexOf(a); return i < 0 ? HISTORY_ACTION_ORDER.length : i; };
  const hist = database.prepare("SELECT rowid AS rid, * FROM task_history WHERE at = '' OR when_text NOT LIKE '____-__-__T%'").all();
  const byTask = new Map();
  for (const h of hist) { if (!byTask.has(h.task_id)) byTask.set(h.task_id, []); byTask.get(h.task_id).push(h); }
  const updHist = database.prepare('UPDATE task_history SET at=?, when_text=? WHERE rowid=?');
  for (const [taskId, list] of byTask) {
    const created = createdById.get(taskId) || null;
    const items = list.map(h => {
      const d = h.at && !isNaN(new Date(h.at)) ? new Date(h.at) : legacyToDate(h.when_text, now, created);
      return { h, d };
    }).sort((a, b) => ((a.d ? a.d.getTime() : 0) - (b.d ? b.d.getTime() : 0)) || (rank(a.h.action) - rank(b.h.action)) || (a.h.rid - b.h.rid));
    let last = 0;
    for (const { h, d } of items) {
      let ms = d ? d.getTime() : (last ? last + 1000 : now.getTime());
      if (ms <= last) ms = last + 1000;   // уникальное время = стабильный порядок
      last = ms;
      const iso = new Date(ms).toISOString();
      updHist.run(h.at && !isNaN(new Date(h.at)) ? h.at : iso, toIsoOrKeep(h.when_text, now, created) || iso, h.rid);
      filled++;
    }
  }
  return filled;
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

const MIRROR_PREFIX = 'mirror:';
function backupFilesIn(dir, prefix = '') {
  if (!dir || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(name => /^grass-.*\.db$/i.test(name))
    .map(name => {
      const full = path.join(dir, name);
      try {
        const stat = fs.statSync(full);
        return { name: prefix + name, path: full, size: stat.size, createdAt: stat.mtime.toISOString(), mirror: !!prefix };
      } catch (error) {
        console.warn('GRASS backup file skipped:', name, error?.message || error);
        return null;
      }
    })
    .filter(Boolean);
}
// Копии в папке данных и (1.7.3) во второй папке — их имена начинаются с «mirror:».
function listDatabaseBackups() {
  let mirror = [];
  try { const root = mirrorRoot(); if (root) mirror = backupFilesIn(path.join(root, 'db'), MIRROR_PREFIX); } catch (_) {}
  return [...backupFilesIn(backupDir), ...mirror].sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));
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
    backupCheck: backupCheckState(),
    tasks: Number(tasks.count),
    archive: Number(archive.count),
    history: Number(history.count),
    settings: Number(settings.count),
    backups: backupsList.length,
    shared: sharedMode,
    dataDir: path.dirname(databasePath),
    sessions: sharedMode ? activeSessions() : [],
    mirrorDir: String(getSetting('backupMirrorDir') || ''),
    mirror: mirrorStatus(),
    health: healthState
  };
}

function safeBackupPath(fileName) {
  let dir = backupDir;
  if (typeof fileName === 'string' && fileName.startsWith(MIRROR_PREFIX)) {
    let root = '';
    try { root = mirrorRoot(); } catch (_) {}
    if (!root) return null;
    dir = path.join(root, 'db');
    fileName = fileName.slice(MIRROR_PREFIX.length);
  }
  if (!fileName || path.basename(fileName) !== fileName || !/^grass-.*\.db$/i.test(fileName)) return null;
  const candidate = path.resolve(dir, fileName);
  const base = path.resolve(dir) + path.sep;
  if (!candidate.startsWith(base)) return null;
  return candidate;
}

async function restoreDatabaseBackup(fileName) {
  const source = safeBackupPath(fileName);
  if (!source || !fs.existsSync(source)) return { ok:false, error:'Резервная копия не найдена.' };
  if (path.resolve(source) === path.resolve(databasePath)) return { ok:false, error:'Нельзя восстановить текущую базу поверх самой себя.' };
  if (sharedMode) {
    let others = [];
    try { others = activeSessions(); } catch (_) {}
    if (others.length) return { ok:false, error:`Восстановить базу можно, только когда с ней больше никто не работает. Сейчас открыто:\n${sessionsText(others)}` };
  }
  const fromMirror = String(fileName).startsWith(MIRROR_PREFIX);
  const mirrorAttach = fromMirror ? path.join(path.dirname(path.dirname(source)), 'attachments') : '';

  // Страховочная копия. Если база повреждена и SQLite не может её скопировать — копируем файл как есть.
  let safety = await createDatabaseBackup('pre-restore');
  if (!safety) safety = rawDatabaseCopy('pre-restore');
  if (!safety) return { ok:false, error:'Не удалось создать страховочную копию перед восстановлением.' };

  try {
    invalidateRowCache();
    if (database) { database.close(); database = null; }
    const wal = `${databasePath}-wal`, shm = `${databasePath}-shm`;
    try { if (fs.existsSync(wal)) fs.unlinkSync(wal); } catch (_) {}
    try { if (fs.existsSync(shm)) fs.unlinkSync(shm); } catch (_) {}
    fs.copyFileSync(source, databasePath);
    database = openDatabaseFile(databasePath);
    ensureNormalizedSchema();
    ensureStage4Schema();
    ensureSiteSchema();
    if (getSchemaVersion() < APP_SCHEMA_VERSION) {
      await migrateSchemaSafely();
    }
    let restoredFiles = 0;
    if (mirrorAttach) { try { restoredFiles = copyMissingFiles(mirrorAttach, attachmentsDir); } catch (error) { console.warn('GRASS mirror attachments restore failed:', error?.message || error); } }
    checkDatabaseHealth();
    return { ok:true, name:path.basename(source), safetyBackup:path.basename(safety), restoredFiles };
  } catch (error) {
    console.error('GRASS restore failed:', error);
    return { ok:false, error:`Не удалось восстановить базу: ${error.message}` };
  }
}

function rawDatabaseCopy(label) {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = path.join(backupDir, `grass-${label}-${stamp}-raw.db`);
    fs.copyFileSync(databasePath, target);
    const wal = `${databasePath}-wal`;
    if (fs.existsSync(wal)) fs.copyFileSync(wal, `${target}-wal`);
    return target;
  } catch (error) {
    console.error('GRASS raw copy failed:', error);
    return null;
  }
}

let downloadedUpdate = null;
function configureAutoUpdater() {
  autoUpdater.autoDownload = true;
  // 1.7.4: обновление скачивается само, а ставится только по кнопке «Установить» (перед этим — копия базы).
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowDowngrade = false;
  autoUpdater.on('checking-for-update', () => mainWindow?.webContents.send('grass-update-status', { state:'checking' }));
  autoUpdater.on('update-available', info => mainWindow?.webContents.send('grass-update-status', { state:'available', version:info.version }));
  autoUpdater.on('update-not-available', info => mainWindow?.webContents.send('grass-update-status', { state:'latest', version:info.version }));
  autoUpdater.on('download-progress', p => mainWindow?.webContents.send('grass-update-status', { state:'downloading', percent:Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', info => { downloadedUpdate = info?.version || '?'; mainWindow?.webContents.send('grass-update-status', { state:'downloaded', version:info?.version }); });
  autoUpdater.on('error', error => mainWindow?.webContents.send('grass-update-status', { state:'error', error:error?.message || 'Ошибка обновления' }));
}

function taskColumns(task, state) {
  const known = new Set([
    'id','text','status','priority','comment','deadline','deadlineStoppedAt','author','shift','date','toShift',
    'lastActionBy','lastActionShift','lastActionAt','archivedAt','siteId','archivedBy','archivedShift','archivedFromStatus','_rev'
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
    ...(row.archived_from_status ? { archivedFromStatus: row.archived_from_status } : {}),
    _rev: Number(row.rev) || 0
  };
}

const HISTORY_KNOWN = new Set(['id','taskId','text','action','details','when','author','shift','deadline','at','status']);
function historyColumns(item) {
  const extra = {};
  for (const [key, value] of Object.entries(item || {})) {
    if (!HISTORY_KNOWN.has(key)) extra[key] = value;
  }
  return {
    id: String(item.id),
    task_id: String(item.taskId ?? ''),
    text: String(item.text ?? ''),
    action: String(item.action ?? ''),
    details: String(item.details ?? ''),
    when_text: String(item.when ?? ''),
    author: String(item.author ?? ''),
    shift: String(item.shift ?? ''),
    deadline: String(item.deadline ?? ''),
    at: String(item.at ?? ''),
    status: String(item.status ?? ''),
    extra_json: JSON.stringify(extra)
  };
}
function historyFromRow(row) {
  let extra = {};
  try { extra = JSON.parse(row.extra_json || '{}'); } catch (_) {}
  const item = {
    ...extra,
    id: row.id, taskId: row.task_id, text: row.text, action: row.action, details: row.details,
    when: row.when_text, author: row.author, shift: row.shift, deadline: row.deadline
  };
  if (row.at) item.at = row.at;
  if (row.status) item.status = row.status;
  return item;
}

// ---------- 1.7: запись только изменённого ----------
// Раньше каждое действие удаляло и заново вставляло ВСЕ задачи и ВСЮ историю площадки.
// Теперь сравниваем с тем, что уже записано, и пишем только отличия. Кэш «что записано» живёт
// в памяти main.js — это безопасно, потому что приложение открыто в одном окне (1.1).
const rowCache = new Map(); // site -> { tasks: Map(id->sig), history: Map(id->1), stats: Map(id->json), cleared: Set }
function invalidateRowCache() { rowCache.clear(); }
const TASK_COLS = ['id','site_id','state','text','status','priority','comment','deadline','deadline_stopped_at','author','shift','date','to_shift','last_action_by','last_action_shift','last_action_at','archived_at','archived_by','archived_shift','archived_from_status','extra_json'];
const HIST_COLS = ['id','site_id','task_id','text','action','details','when_text','author','shift','deadline','at','status','extra_json'];
const sigOf = (row, cols) => JSON.stringify(cols.map(c => row[c] ?? null));
function loadRowCache(site) {
  if (rowCache.has(site)) return rowCache.get(site);
  const c = { tasks: new Map(), history: new Map(), stats: new Map(), cleared: new Set() };
  for (const r of database.prepare('SELECT * FROM tasks WHERE site_id = ?').all(site)) c.tasks.set(r.id, sigOf(r, TASK_COLS));
  for (const r of database.prepare('SELECT id FROM task_history WHERE site_id = ?').all(site)) c.history.set(r.id, 1);
  for (const r of database.prepare('SELECT task_id, task_json FROM stats_archive WHERE site_id = ?').all(site)) c.stats.set(r.task_id, r.task_json);
  for (const r of database.prepare('SELECT task_id FROM cleared_archive_ids WHERE site_id = ?').all(site)) c.cleared.add(r.task_id);
  rowCache.set(site, c);
  return c;
}
function applyNormalizedData(data, site = activeSite) {
  site = normalizeSite(site);
  ensureNormalizedSchema();
  const parsed = data && typeof data === 'object' ? data : {};
  const want = { tasks: new Map(), history: new Map(), stats: new Map(), cleared: new Set() };
  for (const [list, state] of [[parsed.tasks, 'active'], [parsed.archive, 'archive']]) {
    for (const task of Array.isArray(list) ? list : []) {
      const c = taskColumns(task, state);
      if (!c.id) continue;
      c.site_id = site;
      want.tasks.set(c.id, c);
    }
  }
  // История только дополняется: записанное событие приложение не меняет. Поэтому старые события
  // не сравниваем (на большой базе это десятки тысяч строк), а только находим новые и удалённые.
  const histIds = new Set();
  const histNew = [];
  const cacheNow = loadRowCache(site);
  for (const item of Array.isArray(parsed.history) ? parsed.history : []) {
    if (!item?.id) continue;
    const id = String(item.id);
    histIds.add(id);
    if (!cacheNow.history.has(id)) { const h = historyColumns(item); h.site_id = site; histNew.push(h); }
  }
  for (const t of Array.isArray(parsed.statsArchive) ? parsed.statsArchive : []) {
    if (t?.id) want.stats.set(String(t.id), JSON.stringify(t));
  }
  for (const id of Array.isArray(parsed.clearedArchiveIds) ? parsed.clearedArchiveIds : []) want.cleared.add(String(id));

  const cache = loadRowCache(site);
  return writeRowChanges(site, cache, {
    taskUpserts: want.tasks,
    taskDeletes: [...cache.tasks.keys()].filter(id => !want.tasks.has(id)),
    histAdd: histNew.reverse(),
    histDeletes: [...cache.history.keys()].filter(id => !histIds.has(id)),
    statsUpserts: want.stats,
    statsDeletes: [...cache.stats.keys()].filter(id => !want.stats.has(id)),
    clearedAdd: [...want.cleared],
    clearedDeletes: [...cache.cleared].filter(id => !want.cleared.has(id))
  });
}

// Запись отличий одной транзакцией. Задачу и статистику пишем, только если строка правда изменилась
// (сверка с кэшем), событие истории — только новое, удаляем — только то, что есть в базе.
function writeRowChanges(site, cache, ch) {
  const next = { tasks: new Map(cache.tasks), history: new Map(cache.history), stats: new Map(cache.stats), cleared: new Set(cache.cleared) };
  let writes = 0;
  database.exec('BEGIN IMMEDIATE');
  try {
    const upTask = database.prepare(`INSERT INTO tasks(${TASK_COLS.join(',')}) VALUES(${TASK_COLS.map(() => '?').join(',')})
      ON CONFLICT(id) DO UPDATE SET ${TASK_COLS.slice(1).map(c => `${c}=excluded.${c}`).join(',')}`);
    const delTask = database.prepare('DELETE FROM tasks WHERE id = ? AND site_id = ?');
    for (const [id, c] of ch.taskUpserts) {
      const sig = sigOf(c, TASK_COLS);
      if (next.tasks.get(id) === sig) continue;
      upTask.run(...TASK_COLS.map(k => c[k] ?? null)); next.tasks.set(id, sig); writes++;
    }
    for (const id of ch.taskDeletes) if (next.tasks.has(id)) { delTask.run(id, site); next.tasks.delete(id); writes++; }

    const upHist = database.prepare(`INSERT INTO task_history(${HIST_COLS.join(',')}) VALUES(${HIST_COLS.map(() => '?').join(',')})
      ON CONFLICT(id) DO UPDATE SET ${HIST_COLS.slice(1).map(c => `${c}=excluded.${c}`).join(',')}`);
    const delHist = database.prepare('DELETE FROM task_history WHERE id = ? AND site_id = ?');
    // Новые события вставляем от старых к новым — так rowid тоже идёт по времени.
    for (const h of ch.histAdd) { if (next.history.has(h.id)) continue; upHist.run(...HIST_COLS.map(k => h[k] ?? null)); next.history.set(h.id, 1); writes++; }
    for (const id of ch.histDeletes) if (next.history.has(id)) { delHist.run(id, site); next.history.delete(id); writes++; }

    const upStats = database.prepare(`INSERT INTO stats_archive(site_id,task_id,task_json) VALUES(?,?,?)
      ON CONFLICT(task_id) DO UPDATE SET site_id=excluded.site_id, task_json=excluded.task_json`);
    const delStats = database.prepare('DELETE FROM stats_archive WHERE task_id = ? AND site_id = ?');
    for (const [id, json] of ch.statsUpserts) if (next.stats.get(id) !== json) { upStats.run(site, id, json); next.stats.set(id, json); writes++; }
    for (const id of ch.statsDeletes) if (next.stats.has(id)) { delStats.run(id, site); next.stats.delete(id); writes++; }

    const insCleared = database.prepare('INSERT OR IGNORE INTO cleared_archive_ids(site_id,task_id) VALUES(?,?)');
    const delCleared = database.prepare('DELETE FROM cleared_archive_ids WHERE task_id = ? AND site_id = ?');
    for (const id of ch.clearedAdd) if (!next.cleared.has(id)) { insCleared.run(site, id); next.cleared.add(id); writes++; }
    for (const id of ch.clearedDeletes) if (next.cleared.has(id)) { delCleared.run(id, site); next.cleared.delete(id); writes++; }

    database.exec('COMMIT');
    rowCache.set(site, next);
    return writes;
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch (_) {}
    invalidateRowCache();   // после сбоя не доверяем кэшу — прочитаем из базы заново
    throw error;
  }
}

// ---------- 1.7.1: окно присылает только изменённое ----------
// patch: { tasks:[{state,task,baseRev?}], taskDeletes:[id | {id,baseRev}], historyAdd:[событие, от старых к новым],
//          historyDeletes:[id], stats:[задача], statsDeletes:[id], clearedAdd:[id], clearedDeletes:[id] }
// 1.7.2: всё пишется одной транзакцией прямо по базе (без кэша — в общей базе пишут несколько копий программы).
// baseRev — номер версии задачи, который видело окно (null — задача новая). Если в базе версия другая,
// задачу успел изменить кто-то другой: ничего из этого сохранения не пишем и возвращаем свежие версии
// (conflicts), окно покажет их технологу. Без baseRev — запись без проверки, как раньше.
const TASK_WRITE_COLS = [...TASK_COLS, 'rev', 'seq'];
function nextChangeSeq() {
  const seq = (Number(getMeta('change_seq')) || 0) + 1;
  setMeta('change_seq', seq);
  return seq;
}
function currentChangeSeq() { return Number(getMeta('change_seq')) || 0; }
function taskStateOf(row) { return row.state === 'archive' ? 'archive' : 'active'; }
function conflictInfo(id, site) {
  const row = database.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!row || normalizeSite(row.site_id) !== site) return { id, deleted: true };
  return { id, state: taskStateOf(row), task: taskFromRow(row) };
}
function applyNormalizedPatch(patch, site = activeSite) {
  site = normalizeSite(site);
  ensureNormalizedSchema();
  invalidateRowCache();
  const p = patch && typeof patch === 'object' ? patch : {};
  const list = v => Array.isArray(v) ? v : [];
  const has = (o, k) => !!o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
  database.exec('BEGIN IMMEDIATE');
  try {
    if (getSchemaVersion() > APP_SCHEMA_VERSION) {
      database.exec('ROLLBACK');
      return { ok: false, outdated: true, error: 'Программу обновили: структура базы новее этой версии.' };
    }
    const newer = newerVersionAtWork();
    if (newer) {
      database.exec('ROLLBACK');
      return { ok: false, outdated: true, newer, error: `Вышла новая версия программы ${newer}.` };
    }
    const seq = (Number(getMeta('change_seq')) || 0) + 1;
    let writes = 0;
    const conflicts = [];
    const revs = {};
    const getTask = database.prepare('SELECT * FROM tasks WHERE id = ?');
    const upTask = database.prepare(`INSERT INTO tasks(${TASK_WRITE_COLS.join(',')}) VALUES(${TASK_WRITE_COLS.map(() => '?').join(',')})
      ON CONFLICT(id) DO UPDATE SET ${TASK_WRITE_COLS.slice(1).map(c => `${c}=excluded.${c}`).join(',')}`);
    const delTask = database.prepare('DELETE FROM tasks WHERE id = ?');
    const tomb = database.prepare('INSERT INTO deleted_rows(kind,row_id,site_id,seq) VALUES(?,?,?,?)');

    for (const item of list(p.tasks)) {
      const state = item?.state === 'archive' ? 'archive' : 'active';
      const c = taskColumns(item?.task, state);
      if (!c.id) continue;
      c.site_id = site;
      const cur = getTask.get(c.id);
      if (cur && normalizeSite(cur.site_id) !== site) { conflicts.push(c.id); continue; }
      if (has(item, 'baseRev')) {
        const base = item.baseRev;
        const ok = base == null ? !cur : (!!cur && Number(cur.rev) === Number(base));
        if (!ok) { conflicts.push(c.id); continue; }
      }
      if (cur && sigOf(cur, TASK_COLS) === sigOf(c, TASK_COLS)) { revs[c.id] = Number(cur.rev) || 0; continue; }
      c.rev = (cur ? Number(cur.rev) || 0 : 0) + 1;
      c.seq = seq;
      upTask.run(...TASK_WRITE_COLS.map(k => c[k] ?? null));
      revs[c.id] = c.rev;
      writes++;
    }
    for (const d of list(p.taskDeletes)) {
      const id = String(d && typeof d === 'object' ? d.id : d);
      const cur = getTask.get(id);
      if (!cur || normalizeSite(cur.site_id) !== site) continue;
      if (has(d, 'baseRev') && d.baseRev != null && Number(cur.rev) !== Number(d.baseRev)) { conflicts.push(id); continue; }
      delTask.run(id);
      tomb.run('task', id, site, seq);
      writes++;
    }
    if (conflicts.length) {
      database.exec('ROLLBACK');
      return { ok: false, conflicts: conflicts.map(id => conflictInfo(id, site)) };
    }

    // История только дополняется: уже записанное событие не трогаем, даже если его прислали ещё раз.
    const insHist = database.prepare(`INSERT INTO task_history(${HIST_COLS.join(',')},seq) VALUES(${HIST_COLS.map(() => '?').join(',')},?)
      ON CONFLICT(id) DO NOTHING`);
    for (const item of list(p.historyAdd)) {
      if (!item?.id) continue;
      const h = historyColumns(item); h.site_id = site;
      if (insHist.run(...HIST_COLS.map(k => h[k] ?? null), seq).changes) writes++;
    }
    const delHist = database.prepare('DELETE FROM task_history WHERE id = ? AND site_id = ?');
    for (const id of list(p.historyDeletes).map(String)) {
      if (delHist.run(id, site).changes) { tomb.run('history', id, site, seq); writes++; }
    }

    const getStats = database.prepare('SELECT task_json, site_id FROM stats_archive WHERE task_id = ?');
    const upStats = database.prepare(`INSERT INTO stats_archive(site_id,task_id,task_json,seq) VALUES(?,?,?,?)
      ON CONFLICT(task_id) DO UPDATE SET site_id=excluded.site_id, task_json=excluded.task_json, seq=excluded.seq`);
    for (const t of list(p.stats)) {
      if (!t?.id) continue;
      const id = String(t.id), json = JSON.stringify(t);
      const cur = getStats.get(id);
      if (cur && cur.task_json === json && normalizeSite(cur.site_id) === site) continue;
      upStats.run(site, id, json, seq); writes++;
    }
    const delStats = database.prepare('DELETE FROM stats_archive WHERE task_id = ? AND site_id = ?');
    for (const id of list(p.statsDeletes).map(String)) {
      if (delStats.run(id, site).changes) { tomb.run('stats', id, site, seq); writes++; }
    }
    const insCleared = database.prepare('INSERT OR IGNORE INTO cleared_archive_ids(site_id,task_id,seq) VALUES(?,?,?)');
    for (const id of list(p.clearedAdd).map(String)) if (insCleared.run(site, id, seq).changes) writes++;
    const delCleared = database.prepare('DELETE FROM cleared_archive_ids WHERE task_id = ? AND site_id = ?');
    for (const id of list(p.clearedDeletes).map(String)) {
      if (delCleared.run(id, site).changes) { tomb.run('cleared', id, site, seq); writes++; }
    }

    if (!writes) { database.exec('ROLLBACK'); return { ok: true, writes: 0, revs }; }
    setMeta('change_seq', seq);
    database.exec('COMMIT');
    return { ok: true, writes, revs, seq };
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch (_) {}
    throw error;
  }
}

// Что изменилось в базе после номера изменения since (для подтягивания чужих правок раз в несколько секунд).
function readChanges(since, site = activeSite) {
  site = normalizeSite(site);
  since = Number(since) || 0;
  database.exec('BEGIN');
  try {
    const seq = currentChangeSeq();
    if (seq <= since) { database.exec('COMMIT'); return { seq }; }
    const tasks = database.prepare('SELECT * FROM tasks WHERE site_id = ? AND seq > ?').all(site, since)
      .map(row => ({ state: taskStateOf(row), task: taskFromRow(row) }));
    const history = database.prepare('SELECT * FROM task_history WHERE site_id = ? AND seq > ? ORDER BY at ASC, rowid ASC').all(site, since).map(historyFromRow);
    const stats = database.prepare('SELECT task_json FROM stats_archive WHERE site_id = ? AND seq > ?').all(site, since)
      .map(row => { try { return JSON.parse(row.task_json); } catch (_) { return null; } }).filter(Boolean);
    const cleared = database.prepare('SELECT task_id FROM cleared_archive_ids WHERE site_id = ? AND seq > ?').all(site, since).map(row => row.task_id);
    const deleted = database.prepare('SELECT kind, row_id FROM deleted_rows WHERE site_id = ? AND seq > ? ORDER BY id ASC').all(site, since)
      .map(row => ({ kind: row.kind, id: row.row_id }));
    const settingsChanged = (Number(getMeta('settings_seq')) || 0) > since;
    database.exec('COMMIT');
    return { seq, tasks, history, stats, cleared, deleted, settingsChanged };
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch (_) {}
    throw error;
  }
}

function replaceNormalizedData(data, site = activeSite) {
  invalidateRowCache();
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
      INSERT INTO task_history(id,site_id,task_id,text,action,details,when_text,author,shift,deadline,at,status,extra_json)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    for (const item of history) {
      if (!item?.id) continue;
      const h = historyColumns(item);
      historyInsert.run(h.id,site,h.task_id,h.text,h.action,h.details,h.when_text,h.author,h.shift,h.deadline,h.at,h.status,h.extra_json);
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
  // Одним снимком базы: в общей базе другие копии программы могут писать прямо во время чтения.
  database.exec('BEGIN');
  try {
    const data = readNormalizedRows(site);
    database.exec('COMMIT');
    return data;
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch (_) {}
    throw error;
  }
}
function readNormalizedRows(site) {
  const changeSeq = currentChangeSeq();
  const tasks = database.prepare("SELECT * FROM tasks WHERE site_id = ? AND state='active' ORDER BY json_extract(extra_json, '$.createdAt') DESC, rowid DESC").all(site).map(taskFromRow);
  const archive = database.prepare("SELECT * FROM tasks WHERE site_id = ? AND state='archive' ORDER BY json_extract(extra_json, '$.createdAt') DESC, rowid DESC").all(site).map(taskFromRow);
  const history = database.prepare("SELECT * FROM task_history WHERE site_id = ? ORDER BY at DESC, rowid DESC").all(site).map(historyFromRow);
  const statsArchive = database.prepare('SELECT task_json FROM stats_archive WHERE site_id = ? ORDER BY rowid ASC').all(site).map(row => {
    try { return JSON.parse(row.task_json); } catch (_) { return null; }
  }).filter(Boolean);
  const clearedArchiveIds = database.prepare('SELECT task_id FROM cleared_archive_ids WHERE site_id = ? ORDER BY rowid ASC').all(site).map(row => row.task_id);
  return { tasks, history, archive, statsArchive, clearedArchiveIds, changeSeq };
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

// Личные настройки (кто я, смена) в общей базе хранятся в профиле пользователя: у каждого свои.
// В домашнем режиме — в базе, как раньше.
function getSetting(key) {
  if (sharedMode && USER_SETTINGS.has(key)) {
    const v = userSettings.values[userSettingKey(key)];
    return v === undefined ? null : String(v);
  }
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

// Общая настройка меняется вместе с номером изменения: другие копии программы увидят, что её надо перечитать.
function writeSharedSetting(fn) {
  database.exec('BEGIN IMMEDIATE');
  try {
    fn();
    const seq = nextChangeSeq();
    setMeta('settings_seq', seq);
    database.exec('COMMIT');
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch (_) {}
    throw error;
  }
}
function setSetting(key, value) {
  if (sharedMode && USER_SETTINGS.has(key)) {
    userSettings.values[userSettingKey(key)] = String(value);
    saveUserSettings();
    return;
  }
  const dbKey = siteSettingKey(key);
  const cur = database.prepare('SELECT value FROM settings WHERE key = ?').get(dbKey);
  if (cur && cur.value === value) return;
  writeSharedSetting(() => {
    database.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(dbKey, value);
    dbSetLegacy(dbKey, value);
  });
}

function removeSetting(key) {
  if (sharedMode && USER_SETTINGS.has(key)) {
    delete userSettings.values[userSettingKey(key)];
    saveUserSettings();
    return;
  }
  const dbKey = siteSettingKey(key);
  writeSharedSetting(() => {
    database.prepare('DELETE FROM settings WHERE key = ?').run(dbKey);
    dbRemoveLegacy(dbKey);
  });
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
  let target = path.join(backupDir, `grass-${label}-${stamp}.db`);
  for (let i = 2; fs.existsSync(target); i++) target = path.join(backupDir, `grass-${label}-${stamp}-${i}.db`);
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

// Вид копии по имени файла: grass-<вид>-<дата>.db
function backupKind(name) {
  const m = /^grass-(.+?)-\d{4}-\d{2}-\d{2}T/i.exec(name);
  return m ? m[1] : 'other';
}
// Ручные копии больше не вытесняют ежедневные: у каждого вида свой лимит.
function pruneBackups() {
  if (!backupDir || !fs.existsSync(backupDir)) return;
  const groups = new Map();
  for (const name of fs.readdirSync(backupDir).filter(n => /^grass-.*\.db$/i.test(n))) {
    const kind = backupKind(name);
    if (/^pre-(migration|stage|update)/i.test(kind)) continue;   // копии перед обновлением программы и структуры — навсегда
    const group = BACKUP_KIND_GROUP[kind] || 'manual';
    let mtime = 0;
    try { mtime = fs.statSync(path.join(backupDir, name)).mtimeMs; } catch (_) { continue; }
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push({ name, mtime });
  }
  for (const [group, files] of groups) {
    files.sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name));
    for (const item of files.slice(BACKUP_KEEP[group] || BACKUP_RETENTION)) {
      try { fs.unlinkSync(path.join(backupDir, item.name)); } catch (_) {}
    }
  }
}

// ---------- 1.7.3: вторая папка для копий (базы и вложений) ----------
function mirrorRoot() {
  const dir = String(getSetting('backupMirrorDir') || '').trim();
  return dir ? path.join(dir, 'GRASS-backup') : '';
}
function copyMissingFiles(src, dst) {
  let copied = 0;
  if (!fs.existsSync(src)) return copied;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const a = path.join(src, entry.name), b = path.join(dst, entry.name);
    if (entry.isDirectory()) { copied += copyMissingFiles(a, b); continue; }
    if (!entry.isFile()) continue;
    try { if (fs.statSync(b).size === fs.statSync(a).size) continue; } catch (_) {}
    fs.mkdirSync(dst, { recursive: true });
    fs.copyFileSync(a, b);
    copied++;
  }
  return copied;
}
function mirrorStatus() {
  try { return JSON.parse(getMeta('mirror_status') || 'null'); } catch (_) { return null; }
}
async function mirrorBackups() {
  const root = mirrorRoot();
  if (!root) return { ok: true, skipped: true };
  const status = { at: new Date().toISOString(), dir: path.dirname(root) };
  try {
    const dbDir = path.join(root, 'db');
    fs.mkdirSync(dbDir, { recursive: true });
    const fresh = await createDatabaseBackup('mirror');
    if (!fresh) throw new Error('не удалось сделать копию базы');
    fs.copyFileSync(fresh, path.join(dbDir, path.basename(fresh)));
    try { fs.unlinkSync(fresh); } catch (_) {}
    const old = fs.readdirSync(dbDir).filter(n => /^grass-.*\.db$/i.test(n)).sort().reverse();
    for (const name of old.slice(BACKUP_KEEP.daily)) { try { fs.unlinkSync(path.join(dbDir, name)); } catch (_) {} }
    status.files = copyMissingFiles(attachmentsDir, path.join(root, 'attachments'));
    status.ok = true;
    status.db = path.basename(fresh);
  } catch (error) {
    status.ok = false;
    status.error = error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.code === 'EEXIST' ? `папка недоступна (${error.code})` : String(error.message || error);
    console.warn('GRASS mirror backup failed:', status.error);
    mainWindow?.webContents.send('grass-update-status', { state: 'mirror-failed', error: status.error, dir: status.dir });
  }
  try { setMeta('mirror_status', JSON.stringify(status)); } catch (_) {}
  return status;
}

// ---------- 1.7.3: проверка базы и места на диске ----------
let healthState = { ok: true, problems: [] };
function checkDatabaseHealth() {
  const problems = [];
  try {
    const rows = database.prepare('PRAGMA quick_check').all().map(r => String(Object.values(r)[0]));
    if (!(rows.length === 1 && rows[0] === 'ok')) problems.push(`Проверка нашла повреждения в файле базы (${rows.filter(r => !/^\*\*\*/.test(r)).length || rows.length} ош.). Восстановите базу из резервной копии.`);
  } catch (error) {
    problems.push(`Проверка базы не прошла: ${error.message}`);
  }
  try {
    const st = fs.statfsSync(path.dirname(databasePath));
    const freeMb = Math.floor(Number(st.bavail) * Number(st.bsize) / 1048576);
    if (freeMb < MIN_FREE_MB) problems.push(`Мало места на диске с базой: свободно ${freeMb} МБ`);
  } catch (_) {}
  const bc = backupCheckState();
  if (bc && bc.ok === false) problems.push(`Последняя резервная копия ${bc.file} не годится для восстановления (${bc.error}). Сделайте новую: Настройки → Создать копию.`);
  healthState = { ok: !problems.length, problems, at: new Date().toISOString() };
  if (problems.length) console.warn('GRASS health:', problems.join(' | '));
  return healthState;
}

// 1.7.11: раз в сутки проверяем, что из последней копии можно восстановиться: открываем её и смотрим целостность.
// Проверяется временная копия файла: SQLite при открытии кладёт рядом служебные -wal/-shm, в папке копий им не место.
function latestBackupFile() {
  return backupFilesIn(backupDir).filter(b => !/-raw\.db$/i.test(b.name)).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null;
}
function verifyLatestBackup() {
  const latest = latestBackupFile();
  const result = { at: new Date().toISOString(), file: latest ? latest.name : '', ok: true, error: '' };
  if (latest) {
    const tmp = path.join(os.tmpdir(), `grass-backup-check-${process.pid}-${Date.now()}.db`);
    let db = null;
    try {
      fs.copyFileSync(latest.path, tmp);
      db = new DatabaseSync(tmp, { readOnly: true });
      const rows = db.prepare('PRAGMA integrity_check').all().map(r => String(Object.values(r)[0]));
      if (!(rows.length === 1 && rows[0] === 'ok')) throw new Error(`найдены повреждения: ${rows.length} ош.`);
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tasks'").get()) throw new Error('в копии нет таблицы задач');
    } catch (error) {
      result.ok = false;
      result.error = String(error?.message || error);
    } finally {
      try { db?.close(); } catch (_) {}
      for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`]) { try { fs.unlinkSync(f); } catch (_) {} }
    }
  }
  try { setMeta('backup_check', JSON.stringify(result)); } catch (_) {}
  if (!result.ok) console.warn('GRASS backup check failed:', result.file, result.error);
  return result;
}
function backupCheckState() {
  try { return JSON.parse(getMeta('backup_check') || 'null'); } catch (_) { return null; }
}
function verifyBackupAndReport() {
  const result = verifyLatestBackup();
  checkDatabaseHealth();
  mainWindow?.webContents.send('grass-update-status', { state: 'health', health: healthState });
  return result;
}

function localDate(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
// Общая база: дневную работу (копия, уборка) делает одна копия программы — та, что первой «застолбила» день.
function claimDaily(key, date = localDate()) {
  database.exec('BEGIN IMMEDIATE');
  try {
    if (getMeta(key) === date) { database.exec('ROLLBACK'); return false; }
    setMeta(key, date);
    database.exec('COMMIT');
    return true;
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch (_) {}
    throw error;
  }
}
// Дневная работа: копия базы (по местной дате, раз в час проверяем — программа может работать сутками),
// копия во вторую папку, проверка базы. В общей базе её делает одна копия программы на всех.
async function runDailyJobs() {
  if (!database) return;
  const date = localDate();
  if (claimDaily('daily_backup_date', date)) {
    const made = await createDatabaseBackup('daily');
    if (!made) setMeta('daily_backup_date', '');                  // не вышло — попробуем через час
    else verifyBackupAndReport();
    pruneBackups();
    try { pruneRemovedAttachments(); } catch (_) {}
    await mirrorBackups();
  }
  if (sharedMode && claimDaily('attach_cleanup_date', date)) {
    try { cleanupOrphanAttachments(); } catch (error) { console.error('GRASS attachment cleanup failed:', error); }
  }
}

function dbGet(key) {
  if (key === STORAGE_KEY) return JSON.stringify(readNormalizedData(activeSite));
  return getSetting(key);
}

function sharedBlocked(message) { const error = new Error(message); error.code = 'GRASS_SHARED_BLOCKED'; return error; }
const logStorageError = (what, error) => (error?.code === 'GRASS_SHARED_BLOCKED' ? console.warn : console.error)(what, error?.message || error);

function dbSet(key, value) {
  if (key === STORAGE_KEY) {
    // Полная запись удаляет задачи, которых нет в окне — в общей базе это стёрло бы чужие задачи.
    if (sharedMode) throw sharedBlocked('В общей базе сохранение целиком отключено.');
    let parsed;
    try { parsed = JSON.parse(value); } catch (_) { throw new Error('Некорректные данные приложения'); }
    applyNormalizedData(parsed, activeSite);
    return;
  }
  const newer = USER_SETTINGS.has(key) ? '' : newerVersionAtWork();   // личные настройки лежат в профиле, базу не трогают
  if (newer) throw sharedBlocked(`Вышла новая версия программы ${newer} — настройки не сохраняются до перезапуска.`);
  setSetting(key, value);
}

function dbRemove(key) {
  if (key === STORAGE_KEY) {
    if (sharedMode) throw sharedBlocked('В общей базе удаление всех данных отключено.');
    replaceNormalizedData({tasks:[],history:[],archive:[],statsArchive:[],clearedArchiveIds:[]}, activeSite);
    return;
  }
  removeSetting(key);
}

// ---------- Кто сейчас работает с общей базой ----------
function sessionHeartbeat() {
  if (!database || !sharedMode || !sessionsTableExists()) return;
  try {
    const now = new Date().toISOString();
    database.prepare(`INSERT INTO sessions(session_id,os_user,technologist,site_id,app_version,started_at,last_seen) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(session_id) DO UPDATE SET technologist=excluded.technologist, site_id=excluded.site_id, last_seen=excluded.last_seen`)
      .run(SESSION_ID, osUserName(), sessionTechnologist, activeSite, APP_VERSION, SESSION_STARTED_AT, now);
    database.prepare('DELETE FROM sessions WHERE last_seen < ?').run(new Date(Date.now() - 24 * 3600 * 1000).toISOString());
  } catch (error) {
    console.warn('GRASS session heartbeat failed:', error?.message || error);
  }
}
function activeSessions() {
  if (!database || !sessionsTableExists()) return [];
  const since = new Date(Date.now() - SESSION_ACTIVE_MS).toISOString();
  return database.prepare('SELECT * FROM sessions WHERE session_id <> ? AND last_seen >= ? ORDER BY started_at').all(SESSION_ID, since)
    .map(r => ({ osUser: r.os_user, technologist: r.technologist, site: r.site_id, version: r.app_version, lastSeen: r.last_seen }));
}
// 1.7.11: мягкое обновление в терминале. Администратор поставил новую версию, а у кого-то открыта старая:
// пока с базой работает копия новее этой, старая не пишет (окно просит перезайти). Структура базы при этом та же,
// поэтому на одном компьютере откат на прежнюю версию по-прежнему возможен — других копий там нет.
function compareVersions(a, b) {
  const pa = String(a || '').split('.').map(n => parseInt(n, 10) || 0), pb = String(b || '').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}
function newerVersionAtWork() {
  if (!sharedMode) return '';
  let newest = '';
  try {
    for (const s of activeSessions()) if (s.version && compareVersions(s.version, newest || APP_VERSION) > 0) newest = s.version;
  } catch (_) {}
  return newest;
}
function sessionsText(list) {
  return list.map(s => `• ${s.technologist || 'не выбран'} (${s.osUser || 'учётка неизвестна'}${s.version ? `, версия ${s.version}` : ''})`).join('\n');
}
function endSession() {
  if (!database || !sharedMode || !sessionsTableExists()) return;
  try { database.prepare('DELETE FROM sessions WHERE session_id = ?').run(SESSION_ID); } catch (_) {}
}

function registerDatabaseIpc() {
  // На каждый запрос окна — ответ, даже при ошибке базы: иначе окно зависнет или молча потеряет данные.
  ipcMain.on('grass-db-get', (event, key) => {
    try {
      event.returnValue = dbGet(String(key));
    } catch (error) {
      console.error('GRASS read failed:', error);
      if (String(key) === STORAGE_KEY) checkDatabaseHealth();
      event.returnValue = String(key) === STORAGE_KEY ? JSON.stringify({ __loadError: String(error?.message || error) }) : null;
    }
  });

  ipcMain.on('grass-db-set', (event, key, value) => {
    try {
      dbSet(String(key), String(value));
      event.returnValue = { ok: true };
    } catch (error) {
      logStorageError('GRASS save failed:', error);
      event.returnValue = { ok: false, error: String(error?.message || error) };
    }
  });

  // Ответ всегда есть: при ошибке окно получает ok:false (дома сохраняет целиком, как раньше; в общей базе повторяет).
  ipcMain.on('grass-db-patch', (event, key, value) => {
    try {
      if (String(key) !== STORAGE_KEY) throw new Error('Частичное сохранение только для данных задач');
      event.returnValue = applyNormalizedPatch(JSON.parse(String(value)), activeSite);
    } catch (error) {
      console.warn('GRASS patch save failed:', error?.message || error);
      event.returnValue = { ok: false, error: String(error?.message || error), busy: /locked|busy/i.test(String(error?.message || '')) };
    }
  });

  ipcMain.on('grass-db-changes', (event, since) => {
    try {
      event.returnValue = { ok: true, ...readChanges(since, activeSite), newer: newerVersionAtWork() };
    } catch (error) {
      event.returnValue = { ok: false, error: String(error?.message || error) };
    }
  });

  ipcMain.on('grass-health', (event) => { event.returnValue = healthState; });

  ipcMain.on('grass-mode', (event) => {
    event.returnValue = { shared: sharedMode, dataDir: sharedMode ? path.dirname(databasePath) : '', osUser: osUserName(), version: APP_VERSION };
  });

  ipcMain.on('grass-session-set', (event, name) => {
    sessionTechnologist = String(name || '').slice(0, 120);
    sessionHeartbeat();
    event.returnValue = true;
  });

  ipcMain.on('grass-db-remove', (event, key) => {
    try {
      dbRemove(String(key));
      event.returnValue = true;
    } catch (error) {
      logStorageError('GRASS remove failed:', error);
      event.returnValue = false;
    }
  });

  ipcMain.on('grass-db-clear', (event) => {
    if (sharedMode) { event.returnValue = false; return; }
    invalidateRowCache();
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
    // Перенос старого localStorage касается только домашней базы: в общую он мог бы вписать чужой профиль.
    if (sharedMode) { event.returnValue = 0; return; }
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

// ---------- Вложения (1.7) ----------
// Файл КОПИРУЕТСЯ в папку данных приложения: data/attachments/<площадка>/<задача>/<id>__<имя>.
// Поэтому вложение не зависит от того, где лежал оригинал, и переживает передачу между сменами.
// Файлы вложений приложение само не удаляет (кроме «черновиков» несохранённых задач старше суток).
function safeFileName(name) {
  const base = path.basename(String(name || 'файл'));
  let clean = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim();
  if (!clean || clean === '.' || clean === '..') clean = 'файл';
  if (clean.length > 120) {
    const ext = path.extname(clean).slice(0, 12);
    clean = clean.slice(0, 120 - ext.length) + ext;
  }
  return clean;
}
function validTaskId(id) { return typeof id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(id); }
function attachmentFullPath(stored) {
  if (typeof stored !== 'string' || !stored) return null;
  const full = path.resolve(attachmentsDir, stored);
  const base = path.resolve(attachmentsDir) + path.sep;
  return full.startsWith(base) ? full : null;
}
function copyAttachments(taskId, filePaths) {
  const items = [], skipped = [];
  const rel = path.join(normalizeSite(activeSite), taskId);
  const dir = path.join(attachmentsDir, rel);
  for (const src of filePaths || []) {
    const name = safeFileName(src);
    try {
      const st = fs.statSync(src);
      if (!st.isFile()) { skipped.push({ name, reason: 'это не файл' }); continue; }
      if (st.size > ATTACHMENT_MAX_BYTES) { skipped.push({ name, reason: 'больше 100 МБ' }); continue; }
      fs.mkdirSync(dir, { recursive: true });
      const id = crypto.randomUUID();
      const storedName = `${id.slice(0, 8)}__${name}`;
      fs.copyFileSync(src, path.join(dir, storedName));
      items.push({ id, name, size: st.size, stored: path.join(rel, storedName).split(path.sep).join('/'), addedAt: new Date().toISOString() });
    } catch (error) {
      skipped.push({ name, reason: error.code === 'ENOENT' ? 'файл не найден' : 'не удалось скопировать' });
    }
  }
  return { ok: true, items, skipped };
}
// Уборка: папки задач, которых нет ни в одной таблице (задачу начали создавать, прикрепили файл и отменили).
function cleanupOrphanAttachments(maxAgeMs = 24 * 3600 * 1000) {
  let removed = 0;
  if (!attachmentsDir || !fs.existsSync(attachmentsDir)) return removed;
  const known = new Set([
    ...database.prepare('SELECT id FROM tasks').all().map(r => r.id),
    ...database.prepare('SELECT task_id FROM stats_archive').all().map(r => r.task_id),
    ...database.prepare('SELECT DISTINCT task_id FROM task_history').all().map(r => r.task_id)
  ]);
  for (const site of fs.readdirSync(attachmentsDir)) {
    const siteDir = path.join(attachmentsDir, site);
    if (!fs.statSync(siteDir).isDirectory()) continue;
    for (const taskId of fs.readdirSync(siteDir)) {
      const dir = path.join(siteDir, taskId);
      try {
        if (known.has(taskId) || !fs.statSync(dir).isDirectory()) continue;
        if (Date.now() - fs.statSync(dir).mtimeMs < maxAgeMs) continue;
        fs.rmSync(dir, { recursive: true, force: true });
        removed++;
      } catch (error) {
        console.warn('GRASS attachment cleanup skipped:', dir, error?.message || error);
      }
    }
  }
  return removed;
}
// ---------- 1.7.4: размер вложений и файлы очищенного архива ----------
// Задачи, очищенные из архива: их id в cleared_archive_ids, а самих задач уже нет.
function clearedTaskIds(site) {
  const live = new Set(database.prepare('SELECT id FROM tasks WHERE site_id = ?').all(site).map(r => r.id));
  return database.prepare('SELECT task_id FROM cleared_archive_ids WHERE site_id = ?').all(site).map(r => r.task_id).filter(id => !live.has(id) && validTaskId(id));
}
function folderSize(dir) {
  let bytes = 0, files = 0;
  if (!fs.existsSync(dir)) return { bytes, files };
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) { const sub = folderSize(full); bytes += sub.bytes; files += sub.files; }
      else if (entry.isFile()) { bytes += fs.statSync(full).size; files++; }
    } catch (_) {}
  }
  return { bytes, files };
}
function attachmentsUsage() {
  const all = folderSize(attachmentsDir);
  let cleared = { bytes: 0, files: 0, tasks: 0 };
  try {
    const siteDir = path.join(attachmentsDir, normalizeSite(activeSite));
    for (const id of clearedTaskIds(activeSite)) {
      const size = folderSize(path.join(siteDir, id));
      if (!size.files) continue;
      cleared.bytes += size.bytes; cleared.files += size.files; cleared.tasks++;
    }
  } catch (error) { console.warn('GRASS attachments usage failed:', error?.message || error); }
  return { ok: true, bytes: all.bytes, files: all.files, cleared };
}
const REMOVED_KEEP_DAYS = 30;
// Файлы очищенных задач активной площадки. Перед удалением: копия базы, вторая папка (если задана)
// и перенос файлов в backups/removed-attachments/<дата> — там они лежат 30 дней.
async function purgeClearedAttachments() {
  const siteDir = path.join(attachmentsDir, normalizeSite(activeSite));
  const ids = clearedTaskIds(activeSite).filter(id => fs.existsSync(path.join(siteDir, id)));
  if (!ids.length) return { ok: true, removed: 0, bytes: 0 };
  const dbCopy = await createDatabaseBackup('manual');
  if (!dbCopy) return { ok: false, error: 'Не удалось сделать копию базы. Файлы не удалены.' };
  if (mirrorRoot()) {
    const m = await mirrorBackups();
    if (!m.ok) return { ok: false, error: `Вторая папка недоступна (${m.error}). Файлы не удалены.` };
  }
  const stash = path.join(backupDir, 'removed-attachments', new Date().toISOString().replace(/[:.]/g, '-'), normalizeSite(activeSite));
  let removed = 0, bytes = 0;
  for (const id of ids) {
    const src = path.join(siteDir, id);
    try {
      const size = folderSize(src);
      fs.mkdirSync(stash, { recursive: true });
      try { fs.renameSync(src, path.join(stash, id)); }
      catch (_) { copyMissingFiles(src, path.join(stash, id)); fs.rmSync(src, { recursive: true, force: true }); }
      removed++; bytes += size.bytes;
    } catch (error) {
      console.warn('GRASS purge attachments skipped:', id, error?.message || error);
    }
  }
  return { ok: true, removed, bytes, backup: path.basename(dbCopy) };
}
function pruneRemovedAttachments(keepDays = REMOVED_KEEP_DAYS) {
  const root = path.join(backupDir, 'removed-attachments');
  if (!fs.existsSync(root)) return 0;
  let n = 0;
  for (const name of fs.readdirSync(root)) {
    const dir = path.join(root, name);
    try {
      if (Date.now() - fs.statSync(dir).mtimeMs < keepDays * 86400000) continue;
      fs.rmSync(dir, { recursive: true, force: true }); n++;
    } catch (_) {}
  }
  return n;
}
function registerAttachmentIpc() {
  ipcMain.handle('grass-attach-add', async (_event, taskId) => {
    if (!validTaskId(taskId)) return { ok: false, error: 'Некорректная задача.' };
    const result = await dialog.showOpenDialog(mainWindow, { title: 'Прикрепить файлы к задаче', properties: ['openFile', 'multiSelections'] });
    if (result.canceled || !result.filePaths?.length) return { ok: true, items: [], skipped: [] };
    return copyAttachments(taskId, result.filePaths);
  });
  ipcMain.handle('grass-attach-open', async (_event, stored) => {
    const full = attachmentFullPath(stored);
    if (!full) return { ok: false, error: 'Некорректный путь вложения.' };
    if (!fs.existsSync(full)) return { ok: false, error: 'Файл вложения не найден в папке данных.' };
    const error = await shell.openPath(full);
    return { ok: !error, error: error || null };
  });
  ipcMain.handle('grass-attach-reveal', (_event, stored) => {
    const full = attachmentFullPath(stored);
    if (!full || !fs.existsSync(full)) return { ok: false, error: 'Файл вложения не найден.' };
    shell.showItemInFolder(full);
    return { ok: true };
  });
  ipcMain.handle('grass-attach-exists', (_event, list) => {
    const out = {};
    for (const stored of Array.isArray(list) ? list.slice(0, 500) : []) {
      const full = attachmentFullPath(stored);
      out[stored] = !!(full && fs.existsSync(full));
    }
    return out;
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
  ipcMain.handle('grass-admin-mirror-now', async () => mirrorBackups());
  ipcMain.handle('grass-admin-verify-backup', () => verifyBackupAndReport());
  ipcMain.handle('grass-admin-choose-mirror', async () => {
    const r = await dialog.showOpenDialog(mainWindow, { title: 'Вторая папка для резервных копий', properties: ['openDirectory', 'createDirectory'] });
    return r.canceled || !r.filePaths?.length ? { ok: false, canceled: true } : { ok: true, path: r.filePaths[0] };
  });
  ipcMain.handle('grass-admin-restore-backup', async (_event, fileName) => {
    const result = await restoreDatabaseBackup(String(fileName || ''));
    if (result.ok) {
      mainWindow?.webContents.send('grass-update-status', { state:'database-restored', name:result.name });
    }
    return result;
  });
  ipcMain.handle('grass-admin-check-updates', async () => {
    if (sharedMode) return { ok:false, error:'В терминале программу обновляет администратор сервера.' };
    if (!app.isPackaged) return { ok:false, error:'Проверка обновлений доступна в установленной версии приложения.' };
    try {
      const result = await autoUpdater.checkForUpdates();
      return { ok:true, updateInfo:result?.updateInfo || null };
    } catch (error) {
      return { ok:false, error:error?.message || 'Не удалось проверить обновления.' };
    }
  });
  ipcMain.handle('grass-admin-install-update', async () => {
    if (sharedMode) return { ok:false, error:'В терминале программу обновляет администратор сервера.' };
    if (!app.isPackaged) return { ok:false, error:'Установка обновления доступна в установленной версии приложения.' };
    if (!downloadedUpdate) return { ok:false, error:'Обновление ещё не загружено.' };
    const safeVersion = String(downloadedUpdate).replace(/[^0-9A-Za-z.-]/g, '');
    const backupFile = await createDatabaseBackup(`pre-update-${app.getVersion()}-to-${safeVersion}`);
    if (!backupFile) return { ok:false, error:'Не удалось сделать копию базы перед обновлением. Обновление не установлено.' };
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
    return { ok:true, backup:path.basename(backupFile) };
  });
  ipcMain.handle('grass-admin-attachments-info', () => attachmentsUsage());
  ipcMain.handle('grass-admin-purge-cleared-attachments', () => purgeClearedAttachments());
  // 1.7.6 (п. 23): уведомления Windows, число просроченных на значке в панели задач, мигание кнопки.
  ipcMain.handle('grass-notify', (_event, title, body) => {
    try {
      if (!Notification || !Notification.isSupported()) return false;
      const n = new Notification({ title: String(title || 'GRASS — Передача смены').slice(0, 120), body: String(body || '').slice(0, 400), icon: path.join(__dirname, 'GRASS_icon.png') });
      n.on('click', () => { if (!mainWindow) return; if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); });
      n.show();
      return true;
    } catch (e) { console.warn('GRASS: уведомление не показано', e && e.message); return false; }
  });
  // 1.7.6 (п. 27): выгрузка в Excel и PDF. Файл собирает окно программы; здесь — выбор места и запись.
  const exportDefaultPath = (name) => {
    let dir = '';
    try { dir = app.getPath('documents'); } catch (_) { dir = app.getPath('userData'); }
    return path.join(dir, String(name || 'GRASS').replace(/[<>:"\/\\|?*\u0000-\u001F]/g, ' ').trim() || 'GRASS');
  };
  const askExportPath = async (name, ext, label) => {
    const r = await dialog.showSaveDialog(mainWindow || undefined, { title: 'Сохранить ' + label, defaultPath: exportDefaultPath(name + '.' + ext), filters: [{ name: label, extensions: [ext] }] });
    if (!r || r.canceled || !r.filePath) return null;
    return r.filePath.toLowerCase().endsWith('.' + ext) ? r.filePath : r.filePath + '.' + ext;
  };
  ipcMain.handle('grass-export-xlsx', async (_event, name, base64) => {
    try {
      const file = await askExportPath(name, 'xlsx', 'книгу Excel');
      if (!file) return { ok: false, canceled: true };
      fs.writeFileSync(file, Buffer.from(String(base64 || ''), 'base64'));
      return { ok: true, path: file };
    } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  });
  ipcMain.handle('grass-export-pdf', async (_event, name, html) => {
    let win = null;
    try {
      const file = await askExportPath(name, 'pdf', 'PDF');
      if (!file) return { ok: false, canceled: true };
      win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, javascript: false } });
      await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(String(html || '')));
      const pdf = await win.webContents.printToPDF({ landscape: true, pageSize: 'A4', printBackground: true });
      fs.writeFileSync(file, pdf);
      return { ok: true, path: file };
    } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
    finally { try { if (win) win.destroy(); } catch (_) {} }
  });
  ipcMain.handle('grass-export-open', async (_event, file) => {
    if (!file || !fs.existsSync(String(file))) return false;
    return (await shell.openPath(String(file))) === '';
  });
  ipcMain.handle('grass-taskbar', (_event, count, badgeDataUrl, flash) => {
    if (!mainWindow) return false;
    try {
      const n = Math.max(0, Number(count) || 0);
      const img = n > 0 && typeof badgeDataUrl === 'string' && badgeDataUrl.startsWith('data:image/png') ? nativeImage.createFromDataURL(badgeDataUrl) : null;
      if (typeof mainWindow.setOverlayIcon === 'function') mainWindow.setOverlayIcon(img, n > 0 ? `Просрочено задач: ${n}` : '');
      if (flash && typeof mainWindow.flashFrame === 'function' && !mainWindow.isFocused?.()) mainWindow.flashFrame(true);
      return true;
    } catch (e) { console.warn('GRASS: значок в панели задач не обновлён', e && e.message); return false; }
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
  win.on('focus', () => { try { win.flashFrame(false); } catch (_) {} });   // 1.7.6: мигание до первого взгляда на окно
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'index.html'));
}

// Только одно окно приложения: второе окно держало бы свою копию данных
// и при сохранении затирало бы изменения первого.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  if (process.platform === 'win32') app.setAppUserModelId?.('ru.grass.shift-handover');   // 1.7.6: без этого Windows не показывает уведомления
  app.whenReady().then(startApplication);
}

function fatal(message) {
  console.error('GRASS fatal:', message);
  try { dialog.showErrorBox('GRASS — Передача смены', message); } catch (_) {}
  app.quit();
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const INIT_LOCK_STALE_MS = 10 * 60 * 1000;
const INIT_LOCK_WAIT_MS = 3 * 60 * 1000;

// Первый запуск общей базы: базы ещё нет. Спрашиваем один раз (кто первый — тот и решает,
// остальные ждут его выбора): начать с чистой базы или загрузить существующую.
async function prepareSharedFirstRun(dataDir) {
  const dbFile = path.join(dataDir, 'grass.db');
  const lockFile = `${dbFile}.init-lock`;
  const started = Date.now();
  let fd = null;
  while (fd === null) {
    if (fs.existsSync(dbFile)) return true;
    try {
      fd = fs.openSync(lockFile, 'wx');
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - fs.statSync(lockFile).mtimeMs > INIT_LOCK_STALE_MS) { fs.unlinkSync(lockFile); continue; }
      } catch (_) { continue; }
      if (Date.now() - started > INIT_LOCK_WAIT_MS) {
        fatal('Общую базу сейчас создаёт другой пользователь. Подождите пару минут и запустите программу снова.');
        return false;
      }
      await sleep(500);
    }
  }
  try {
    fs.writeSync(fd, `${osUserName()} ${new Date().toISOString()}`);
    if (fs.existsSync(dbFile)) return true;
    const choice = await dialog.showMessageBox({
        type: 'question',
        title: 'GRASS — первый запуск общей базы',
        message: 'В папке общей базы ещё нет данных.',
        detail: `Папка: ${dataDir}\n\nНачните с чистой базы или загрузите существующий файл базы (grass.db или резервную копию).`,
        buttons: ['Начать с чистой базы', 'Загрузить существующую базу…', 'Отмена'],
        defaultId: 0,
        cancelId: 2,
        noLink: true
      });
    if (choice.response === 0) return true;
    if (choice.response !== 1) { app.quit(); return false; }
    const source = (await dialog.showOpenDialog({
      title: 'Выберите файл базы GRASS',
      properties: ['openFile'],
      filters: [{ name: 'База GRASS', extensions: ['db'] }]
    })).filePaths?.[0];
    if (!source) { app.quit(); return false; }
    const imported = await importDatabaseFile(source, dbFile);
    if (!imported.ok) { fatal(imported.error); return false; }
    return true;
  } finally {
    try { fs.closeSync(fd); } catch (_) {}
    try { fs.unlinkSync(lockFile); } catch (_) {}
  }
}

async function importDatabaseFile(source, dbFile) {
  let src = null;
  const tmp = `${dbFile}.import-tmp`;
  try {
    src = new DatabaseSync(source, { readOnly: true });
    const hasTasks = src.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tasks'").get();
    if (!hasTasks) return { ok: false, error: `Файл не похож на базу GRASS (нет таблицы задач):\n${source}` };
    const ver = src.prepare("SELECT value FROM app_meta WHERE key='schema_version'").get();
    if (ver && Number(ver.value) > APP_SCHEMA_VERSION) return { ok: false, error: 'Эту базу создала более новая версия программы.' };
    try { fs.unlinkSync(tmp); } catch (_) {}
    await backup(src, tmp);
    src.close(); src = null;
    fs.renameSync(tmp, dbFile);
    // Вложения лежат рядом с базой — переносим, если они есть.
    const srcAttach = path.join(path.dirname(source), 'attachments');
    const dstAttach = path.join(path.dirname(dbFile), 'attachments');
    if (fs.existsSync(srcAttach) && path.resolve(srcAttach) !== path.resolve(dstAttach)) {
      fs.cpSync(srcAttach, dstAttach, { recursive: true, force: false, errorOnExist: false });
    }
    return { ok: true };
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    return { ok: false, error: `Не удалось загрузить базу:\n${source}\n\n${error.message}` };
  } finally {
    try { src?.close(); } catch (_) {}
  }
}

// Файл базы не открывается: показываем, что случилось, и предлагаем последнюю резервную копию.
// Испорченный файл не удаляем, а переименовываем (grass-broken-<дата>.db) — его можно отдать на разбор.
async function offerRestoreLatestBackup(dataDir, error) {
  const dir = path.join(dataDir, 'backups');
  const latest = backupFilesIn(dir).filter(b => !/-raw\.db$/i.test(b.name)).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
  if (!latest) return false;
  const when = new Date(latest.createdAt).toLocaleString('ru-RU');
  const choice = await dialog.showMessageBox({
    type: 'error',
    title: 'GRASS — база данных не открывается',
    message: 'Базу данных не удалось открыть — похоже, файл повреждён.',
    detail: `${error.message}\n\nМожно восстановить последнюю резервную копию от ${when}. Изменения после неё пропадут.${sharedMode ? '\n\nЭто общая база: убедитесь, что больше никто не работает с программой.' : ''}`,
    buttons: [`Восстановить копию от ${when}`, 'Закрыть программу'],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  });
  if (choice.response !== 0) return false;
  try {
    if (database) { try { database.close(); } catch (_) {} database = null; }
    const file = path.join(dataDir, 'grass.db');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    if (fs.existsSync(file)) fs.renameSync(file, path.join(dataDir, `grass-broken-${stamp}.db`));
    for (const ext of ['-wal', '-shm']) { try { fs.unlinkSync(file + ext); } catch (_) {} }
    fs.copyFileSync(latest.path, file);
    return true;
  } catch (restoreError) {
    console.error('GRASS restore after open failure failed:', restoreError);
    return false;
  }
}

async function startApplication() {
  userSettingsPath = path.join(app.getPath('userData'), 'grass-user.json');
  loadUserSettings();
  const cfg = readSharedConfig();
  if (cfg?.error) return fatal(cfg.error);
  let dataDir;
  if (cfg) {
    sharedMode = true;
    sharedConfigPath = cfg.path;
    dataDir = cfg.dataDir;
    try { checkWritableDir(dataDir); }
    catch (error) { return fatal(`Нет доступа на запись к папке общей базы:\n${dataDir}\n\n${error.message}\n\nОбратитесь к администратору сервера.`); }
    if (userSettings.sharedDataDir !== dataDir) {
      userSettings.sharedDataDir = dataDir;
      try { saveUserSettings(); } catch (error) { console.warn('GRASS user settings save failed:', error?.message || error); }
    }
    if (!fs.existsSync(path.join(dataDir, 'grass.db'))) {
      try { if (!(await prepareSharedFirstRun(dataDir))) return; }
      catch (error) { return fatal(`Не удалось подготовить общую базу:\n${error.message}`); }
    }
  } else if (userSettings.sharedDataDir) {
    // Раньше этот пользователь работал с общей базой, а файла настройки нет (например, после переустановки).
    // Тихо открыть пустую личную базу нельзя: технолог решит, что задачи пропали.
    return fatal(`Не найден файл настройки общей базы (grass-config.json).\nРаньше программа работала с общей базой:\n${userSettings.sharedDataDir}\n\nОбратитесь к администратору сервера.`);
  }

  const NEWER_MSG = 'База данных обновлена более новой версией программы. Эта версия устарела — обратитесь к администратору, чтобы обновить программу.';
  for (let attempt = 0; ; attempt++) {
    try {
      initDatabase(dataDir);
      if (getSchemaVersion() > APP_SCHEMA_VERSION) return fatal(NEWER_MSG);
      if (sharedMode && getSchemaVersion() < APP_SCHEMA_VERSION) {
        const others = activeSessions();
        if (others.length) return fatal(`Нужно обновить структуру общей базы, но с ней сейчас работают:\n${sessionsText(others)}\n\nПопросите их закрыть программу и запустите снова.`);
      }
      // First finish any legacy v1/v2 normalization, then migrate the schema safely.
      if (getSchemaVersion() < 2) {
        await createDatabaseBackup('pre-stage2');
        migrateLegacyKeyValueToNormalized();
      }
      await migrateSchemaSafely();
      break;
    } catch (error) {
      if (error?.code === 'GRASS_DB_NEWER') return fatal(NEWER_MSG);
      console.warn('GRASS database open failed:', error?.message || error);
      // 1.7.3: база не открывается (например, файл повреждён) — предлагаем восстановить последнюю копию.
      if (attempt === 0 && await offerRestoreLatestBackup(dataDir || path.join(app.getPath('userData'), 'data'), error)) continue;
      return fatal(`Не удалось открыть базу данных:\n${error.message}`);
    }
  }

  try { if (claimDaily('db_check_date')) checkDatabaseHealth(); } catch (error) { checkDatabaseHealth(); }

  registerDatabaseIpc();
  registerAdminIpc();
  registerAttachmentIpc();
  configureAutoUpdater();
  if (sharedMode) {
    sessionHeartbeat();
    setInterval(sessionHeartbeat, 30 * 1000).unref?.();
    createWindow();
  } else {
    try { cleanupOrphanAttachments(); } catch (error) { console.error('GRASS attachment cleanup failed:', error); }
    createWindow();
    if (app.isPackaged) {
      setTimeout(() => autoUpdater.checkForUpdates().catch(error => console.error('GRASS update check failed:', error)), 8000);
    }
  }

  const daily = () => runDailyJobs().catch(error => console.error('GRASS daily jobs failed:', error));
  daily();
  setInterval(daily, DAILY_CHECK_MS).unref?.();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

app.on('before-quit', () => {
  if (database) {
    endSession();
    try { database.close(); } catch (_) {}
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
