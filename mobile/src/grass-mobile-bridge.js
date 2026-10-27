/*
 * GRASS — Передача смены · Android-версия
 * Мост вместо Electron (preload.js + main.js): даёт index.html те же
 * window.grassStorage / window.grassSite / window.grassAdmin, но хранит всё на телефоне.
 *
 *  - Данные: IndexedDB (место с запасом), в памяти — синхронная копия, чтобы
 *    index.html работал как раньше (getItem/setItem без await).
 *  - Ключи разделены по площадкам так же, как в main.js: список технологов общий,
 *    всё остальное — отдельно для Ахтубы и Волжского.
 *  - Резервные копии: JSON-файлы в «Документы/GRASS» (переживают удаление приложения),
 *    восстановление из списка или из любого файла, отправка копии через «Поделиться».
 *  - 1.7.x: вложения (во внутренней памяти приложения), выгрузка в Excel и «PDF» (страница для печати)
 *    в «Документы/GRASS/Выгрузки», уведомления Android. Общей базы (терминальный сервер) на телефоне нет:
 *    index.html работает в «домашнем» режиме и сохраняет данные целиком, как ПК-версия без общей базы.
 */
(function () {
  'use strict';

  var APP_VERSION = '__GRASS_MOBILE_VERSION__';
  var DB_NAME = 'grass-mobile';
  var STORE = 'kv';
  var BACKUP_DIR = 'GRASS';
  var BACKUP_KEEP = 30;
  var BACKUP_FORMAT = 'grass-mobile-backup';
  var GLOBAL_KEYS = { technologists: true };
  var DATA_KEY = 'grass_v02';

  var mem = new Map();
  var idb = null;
  var site = normalizeSite(safeLocalGet('grass_selected_site'));
  var updateListeners = [];

  function normalizeSite(v) { return v === 'VOLZHSKY' ? 'VOLZHSKY' : 'AHTUBA'; }
  function safeLocalGet(k) { try { return window.localStorage.getItem(k); } catch (_) { return null; } }
  function storeKey(key) { return GLOBAL_KEYS[key] ? key : 'site:' + site + ':' + key; }

  // ---------- сообщения пользователю ----------
  function banner(text, kind) {
    var el = document.getElementById('grass-mobile-banner');
    if (!el) {
      el = document.createElement('div');
      el.id = 'grass-mobile-banner';
      document.body.appendChild(el);
    }
    el.className = kind || 'error';
    el.textContent = text;
    el.hidden = false;
    clearTimeout(banner._t);
    if (kind === 'info') banner._t = setTimeout(function () { el.hidden = true; }, 3500);
  }
  function fatal(text) {
    document.body.innerHTML = '';
    var box = document.createElement('div');
    box.id = 'grass-mobile-fatal';
    box.innerHTML = '<b>GRASS — Передача смены</b><p></p><button type="button">Перезапустить</button>';
    box.querySelector('p').textContent = text;
    box.querySelector('button').onclick = function () { location.reload(); };
    document.body.appendChild(box);
  }

  // ---------- IndexedDB ----------
  function openIdb() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () { req.result.createObjectStore(STORE); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
      req.onblocked = function () { reject(new Error('База занята другим окном')); };
    });
  }
  function idbLoadAll(db) {
    return new Promise(function (resolve, reject) {
      var out = new Map();
      var tx = db.transaction(STORE, 'readonly');
      var req = tx.objectStore(STORE).openCursor();
      req.onsuccess = function () {
        var c = req.result;
        if (c) { out.set(String(c.key), String(c.value)); c.continue(); }
      };
      tx.oncomplete = function () { resolve(out); };
      tx.onerror = function () { reject(tx.error); };
    });
  }
  // Каждая запись — своя транзакция; IndexedDB выполняет их строго в порядке создания.
  var pendingWrites = 0;
  function idbWrite(fn) {
    pendingWrites++;
    return new Promise(function (resolve, reject) {
      var tx;
      try { tx = idb.transaction(STORE, 'readwrite'); fn(tx.objectStore(STORE)); }
      catch (e) { pendingWrites--; onWriteError(e); reject(e); return; }
      tx.oncomplete = function () { pendingWrites--; resolve(); };
      tx.onerror = tx.onabort = function () { pendingWrites--; onWriteError(tx.error); reject(tx.error); };
    });
  }
  var lastWriteError = '';
  function onWriteError(e) {
    lastWriteError = String(e && e.message || e || 'ошибка записи');
    console.error('GRASS mobile: ошибка записи', e);
    banner('Не удалось сохранить данные на телефоне! Сделайте резервную копию в Настройках и сообщите разработчику.', 'error');
  }

  // ---------- window.grassStorage (как в preload.js) ----------
  var grassStorage = {
    getItem: function (key) {
      var v = mem.get(storeKey(String(key)));
      return v === undefined ? null : v;
    },
    setItem: function (key, value) {
      var k = storeKey(String(key)), v = String(value);
      if (mem.get(k) === v) return { ok: true };
      mem.set(k, v);
      idbWrite(function (s) { s.put(v, k); }).catch(function () {});
      return { ok: true };
    },
    // 1.7.2+: на телефоне всегда своя база — общего режима нет; patch/changes не даём,
    // поэтому index.html сохраняет данные целиком (как ПК-версия с домашней базой).
    mode: function () { return { shared: false, dataDir: '', osUser: '', version: APP_VERSION, mobile: true }; },
    sessionSet: function () { return true; },
    health: function () { return lastWriteError ? { ok: false, problems: ['Не удалось сохранить данные на телефоне: ' + lastWriteError] } : { ok: true, problems: [] }; },
    removeItem: function (key) {
      var k = storeKey(String(key));
      mem.delete(k);
      idbWrite(function (s) { s.delete(k); }).catch(function () {});
    },
    clear: function () {
      var prefix = 'site:' + site + ':';
      var keys = Array.from(mem.keys()).filter(function (k) { return k.indexOf(prefix) === 0; });
      keys.forEach(function (k) { mem.delete(k); });
      idbWrite(function (s) { keys.forEach(function (k) { s.delete(k); }); }).catch(function () {});
    },
    key: function (index) { return visibleKeys()[Number(index)] || null; },
    get length() { return visibleKeys().length; }
  };
  function visibleKeys() {
    var prefix = 'site:' + site + ':';
    var out = [];
    mem.forEach(function (_, k) {
      if (GLOBAL_KEYS[k]) out.push(k);
      else if (k.indexOf(prefix) === 0) out.push(k.slice(prefix.length));
    });
    return out.sort();
  }

  // ---------- window.grassSite ----------
  var grassSite = {
    get: function () { return site; },
    set: function (s) {
      site = normalizeSite(s);
      try { window.localStorage.setItem('grass_selected_site', site); } catch (_) {}
      return site;
    },
    label: function (s) { return s === 'VOLZHSKY' ? 'Волжский' : 'Ахтуба'; }
  };

  // ---------- нативные плагины (есть только внутри APK) ----------
  function plugin(name) {
    var C = window.Capacitor;
    if (!C || !C.isNativePlatform || !C.isNativePlatform()) return null;
    return (C.Plugins && C.Plugins[name]) || (C.registerPlugin ? C.registerPlugin(name) : null);
  }
  var FS_DIR = 'DOCUMENTS';

  // В браузере (проверка без телефона) копии хранятся в памяти страницы.
  var devBackups = new Map();

  async function fsList() {
    var Fs = plugin('Filesystem');
    if (!Fs) {
      return Array.from(devBackups.entries()).map(function (e) { return { name: e[0], size: e[1].length, createdAt: JSON.parse(e[1]).createdAt }; });
    }
    try {
      var r = await Fs.readdir({ path: BACKUP_DIR, directory: FS_DIR });
      return (r.files || []).map(function (f) {
        var name = typeof f === 'string' ? f : f.name;
        var mtime = typeof f === 'object' && f.mtime ? new Date(Number(f.mtime)).toISOString() : null;
        return { name: name, size: (f && f.size) || 0, createdAt: mtime };
      });
    } catch (e) {
      return []; // папки ещё нет
    }
  }
  async function fsWrite(name, text) {
    var Fs = plugin('Filesystem');
    if (!Fs) { devBackups.set(name, text); return; }
    await Fs.writeFile({ path: BACKUP_DIR + '/' + name, data: text, directory: FS_DIR, encoding: 'utf8', recursive: true });
  }
  async function fsRead(name) {
    var Fs = plugin('Filesystem');
    if (!Fs) { if (!devBackups.has(name)) throw new Error('Копия не найдена'); return devBackups.get(name); }
    var r = await Fs.readFile({ path: BACKUP_DIR + '/' + name, directory: FS_DIR, encoding: 'utf8' });
    return String(r.data);
  }
  async function fsDelete(name) {
    var Fs = plugin('Filesystem');
    if (!Fs) { devBackups.delete(name); return; }
    await Fs.deleteFile({ path: BACKUP_DIR + '/' + name, directory: FS_DIR });
  }
  async function ensureFsPermission() {
    var Fs = plugin('Filesystem');
    if (!Fs || !Fs.checkPermissions) return true;
    try {
      var p = await Fs.checkPermissions();
      if (p.publicStorage === 'granted') return true;
      p = await Fs.requestPermissions();
      return p.publicStorage === 'granted';
    } catch (_) { return true; }
  }

  function stamp() { return new Date().toISOString().replace(/[:.]/g, '-'); }
  function backupTime(item) {
    if (item.createdAt) return Date.parse(item.createdAt) || 0;
    var m = /(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})/.exec(item.name || '');
    return m ? Date.parse(m[1].replace(/T(\d{2})-(\d{2})-(\d{2})/, 'T$1:$2:$3') + 'Z') || 0 : 0;
  }

  function snapshot() {
    var data = {};
    mem.forEach(function (v, k) { data[k] = v; });
    return { format: BACKUP_FORMAT, version: 1, app: APP_VERSION, createdAt: new Date().toISOString(), data: data };
  }
  function validateBackup(obj) {
    if (!obj || obj.format !== BACKUP_FORMAT || !obj.data || typeof obj.data !== 'object') {
      throw new Error('Это не резервная копия GRASS для телефона.');
    }
    for (var k in obj.data) {
      if (typeof obj.data[k] !== 'string') throw new Error('Резервная копия повреждена.');
      if (/(^|:)grass_v02$/.test(k)) JSON.parse(obj.data[k]); // данные задач должны читаться
    }
    return obj;
  }

  async function listBackupsSorted() {
    var items = (await fsList()).filter(function (i) { return /^grass-.*\.json$/i.test(i.name); });
    items.forEach(function (i) { if (!i.createdAt) { var t = backupTime(i); i.createdAt = t ? new Date(t).toISOString() : null; } });
    return items.sort(function (a, b) { return backupTime(b) - backupTime(a); });
  }

  async function createBackup(label) {
    label = label || 'manual';
    if (!mem.size) return { ok: false, error: 'Пока нечего сохранять — данных нет.' };
    if (!(await ensureFsPermission())) return { ok: false, error: 'Нет разрешения на запись в «Документы».' };
    var name = 'grass-' + label + '-' + stamp() + '.json';
    await fsWrite(name, JSON.stringify(snapshot()));
    try { saveLastBackup(new Date().toISOString()); } catch (_) {}
    var items = await listBackupsSorted();
    for (var i = BACKUP_KEEP; i < items.length; i++) { try { await fsDelete(items[i].name); } catch (_) {} }
    return { ok: true, name: name, path: 'Документы/' + BACKUP_DIR + '/' + name };
  }
  function backupCheckState() { try { return JSON.parse(safeLocalGet('grass_mobile_backup_check') || 'null'); } catch (_) { return null; } }
  function saveLastBackup(iso) { try { window.localStorage.setItem('grass_mobile_last_backup', iso); } catch (_) {} }
  function lastBackup() { return safeLocalGet('grass_mobile_last_backup'); }

  async function replaceAllData(obj) {
    await idbWrite(function (s) {
      s.clear();
      Object.keys(obj.data).forEach(function (k) { s.put(obj.data[k], k); });
    });
    mem = new Map(Object.keys(obj.data).map(function (k) { return [k, obj.data[k]]; }));
  }

  async function restoreFromText(text, displayName) {
    var obj;
    try { obj = validateBackup(JSON.parse(text)); }
    catch (e) { return { ok: false, error: e && e.message && e.message.indexOf('GRASS') >= 0 ? e.message : 'Файл не читается как резервная копия GRASS.' }; }
    var safety = await createBackup('pre-restore').catch(function () { return { ok: false }; });
    if (mem.size && !safety.ok) return { ok: false, error: 'Не удалось сделать страховочную копию перед восстановлением — восстановление отменено.' };
    await replaceAllData(obj);
    return { ok: true, name: displayName, safetyBackup: safety.name || null };
  }

  function counts() {
    var tasks = 0, archive = 0, history = 0;
    try {
      var d = JSON.parse(mem.get(storeKey(DATA_KEY)) || '{}');
      tasks = (d.tasks || []).length; archive = (d.archive || []).length; history = (d.history || []).length;
    } catch (_) {}
    return { tasks: tasks, archive: archive, history: history };
  }
  function dataSize() {
    var n = 0;
    mem.forEach(function (v, k) { n += (v.length + k.length) * 2; });
    return n;
  }

  // ---------- window.grassAdmin ----------
  var grassAdmin = {
    createBackup: function () { return createBackup('manual').catch(function (e) { return { ok: false, error: 'Не удалось создать копию: ' + (e && e.message || e) }; }); },
    listBackups: async function () { return { ok: true, items: await listBackupsSorted() }; },
    getDatabaseInfo: async function () {
      var c = counts(), items = await listBackupsSorted();
      return {
        ok: true, version: APP_VERSION, schemaVersion: 'Android', path: 'Документы/' + BACKUP_DIR + ' (резервные копии)',
        size: dataSize(), modifiedAt: null, lastBackup: lastBackup() || (items[0] && items[0].createdAt) || null,
        tasks: c.tasks, archive: c.archive, history: c.history, settings: mem.size, backups: items.length,
        backupCheck: backupCheckState(), shared: false, dataDir: '', sessions: [], mirrorDir: '', mirror: null,
        health: grassStorage.health()
      };
    },
    // 1.7.11: проверка свежей копии — читается ли и годится ли для восстановления.
    verifyBackup: async function () {
      var items = await listBackupsSorted(), at = new Date().toISOString(), r;
      if (!items.length) r = { ok: true, file: null, at: at };
      else {
        try { validateBackup(JSON.parse(await fsRead(items[0].name))); r = { ok: true, file: items[0].name, at: at }; }
        catch (e) { r = { ok: false, file: items[0].name, at: at, error: e && e.message || String(e) }; }
      }
      try { window.localStorage.setItem('grass_mobile_backup_check', JSON.stringify(r)); } catch (_) {}
      return r;
    },
    attachmentsInfo: async function () {
      var u = await attachUsage();
      return { ok: true, bytes: u.bytes, files: u.files, cleared: { bytes: 0, files: 0, tasks: 0 } };
    },
    getBackupData: async function () {
      return { ok: true, info: await grassAdmin.getDatabaseInfo(), items: await listBackupsSorted() };
    },
    restoreBackup: async function (name) {
      try { return await restoreFromText(await fsRead(String(name || '')), String(name || '')); }
      catch (e) { return { ok: false, error: 'Не удалось прочитать копию: ' + (e && e.message || e) }; }
    },
    restoreFromFile: async function (file) {
      if (!file) return { ok: false, error: 'Файл не выбран.' };
      try { return await restoreFromText(await file.text(), file.name); }
      catch (e) { return { ok: false, error: 'Не удалось прочитать файл: ' + (e && e.message || e) }; }
    },
    // На телефоне «Открыть папку» = отправить последнюю копию (в Telegram, почту, на ПК).
    openBackupFolder: async function () {
      var items = await listBackupsSorted();
      if (!items.length) return { ok: false, error: 'Сначала создайте резервную копию.' };
      var Fs = plugin('Filesystem'), Share = plugin('Share');
      if (!Fs || !Share) return { ok: false, error: 'Отправка доступна только в приложении на телефоне.' };
      try {
        var uri = await Fs.getUri({ path: BACKUP_DIR + '/' + items[0].name, directory: FS_DIR });
        await Share.share({ title: 'Резервная копия GRASS', text: items[0].name, files: [uri.uri], dialogTitle: 'Отправить резервную копию' });
        return { ok: true };
      } catch (e) {
        if (/cancel/i.test(String(e && e.message))) return { ok: true };
        return { ok: false, error: 'Не удалось отправить: ' + (e && e.message || e) };
      }
    },
    checkForUpdates: async function () {
      notifyUpdate({ state: 'mobile' });
      return { ok: true };
    },
    installUpdate: async function () { return { ok: false, error: 'На телефоне обновление ставится новым APK-файлом.' }; },
    onUpdateStatus: function (cb) {
      if (typeof cb !== 'function') return function () {};
      updateListeners.push(cb);
      return function () { updateListeners = updateListeners.filter(function (x) { return x !== cb; }); };
    }
  };
  function notifyUpdate(payload) { updateListeners.forEach(function (cb) { try { cb(payload); } catch (_) {} }); }

  // ---------- вложения (1.7.x): файлы во внутренней памяти приложения ----------
  // stored — как в ПК-версии: «<площадка>/<id задачи>/<8 символов>__<имя>».
  var ATTACH_DIR = 'attachments';
  var ATTACH_MAX_BYTES = 25 * 1024 * 1024;   // на телефоне файл целиком проходит через память — держим ниже, чем 100 МБ на ПК
  var devAttach = new Map();                  // проверка в браузере без телефона
  function validTaskId(id) { return typeof id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(id); }
  function validStored(stored) {
    return typeof stored === 'string' && /^(AHTUBA|VOLZHSKY)\/[A-Za-z0-9_-]{1,80}\/[^\/\\]+$/.test(stored) && stored.indexOf('..') < 0;
  }
  function safeFileName(name) {
    var clean = String(name || 'файл').split(/[\\\/]/).pop().replace(/[\\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim();
    if (!clean || clean === '.' || clean === '..') clean = 'файл';
    if (clean.length > 120) { var dot = clean.lastIndexOf('.'), ext = dot > 0 ? clean.slice(dot).slice(0, 12) : ''; clean = clean.slice(0, 120 - ext.length) + ext; }
    return clean;
  }
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) { var r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); });
  }
  function fileToBase64(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { var s = String(r.result || ''); resolve(s.slice(s.indexOf(',') + 1)); };
      r.onerror = function () { reject(r.error || new Error('не удалось прочитать файл')); };
      r.readAsDataURL(file);
    });
  }
  // Окно выбора файлов должно открыться прямо из нажатия кнопки, поэтому input.click() — без await перед ним.
  function pickFiles(accept) {
    return new Promise(function (resolve) {
      var input = document.createElement('input');
      input.type = 'file'; input.multiple = true; input.hidden = true;
      if (accept) input.accept = accept;
      var done = false;
      function finish(list) { if (done) return; done = true; input.remove(); resolve(list); }
      input.onchange = function () { finish(Array.from(input.files || [])); };
      input.addEventListener('cancel', function () { finish([]); });
      document.body.appendChild(input);
      input.click();
    });
  }
  async function attachWrite(stored, base64) {
    var Fs = plugin('Filesystem');
    if (!Fs) { devAttach.set(stored, base64); return; }
    await Fs.writeFile({ path: ATTACH_DIR + '/' + stored, data: base64, directory: 'DATA', recursive: true });
  }
  async function attachExists(stored) {
    var Fs = plugin('Filesystem');
    if (!Fs) return devAttach.has(stored);
    try { await Fs.stat({ path: ATTACH_DIR + '/' + stored, directory: 'DATA' }); return true; } catch (_) { return false; }
  }
  async function attachUsage() {
    var Fs = plugin('Filesystem');
    if (!Fs) { var b = 0; devAttach.forEach(function (v) { b += Math.floor(v.length * 3 / 4); }); return { bytes: b, files: devAttach.size }; }
    var out = { bytes: 0, files: 0 };
    async function walk(p) {
      var r;
      try { r = await Fs.readdir({ path: p, directory: 'DATA' }); } catch (_) { return; }
      for (var i = 0; i < (r.files || []).length; i++) {
        var f = r.files[i];
        if (f.type === 'directory') await walk(p + '/' + f.name);
        else { out.files++; out.bytes += Number(f.size) || 0; }
      }
    }
    await walk(ATTACH_DIR);
    return out;
  }
  var MIME = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic',
    txt: 'text/plain', csv: 'text/csv', html: 'text/html', htm: 'text/html', mp4: 'video/mp4',
    doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', zip: 'application/zip' };
  function mimeOf(name) { var m = /\.([A-Za-z0-9]+)$/.exec(name || ''); return (m && MIME[m[1].toLowerCase()]) || '*/*'; }
  // Открыть файл в подходящей программе телефона; если такой нет — предложить «Поделиться».
  async function openNativeFile(path, directory, name) {
    var Fs = plugin('Filesystem'), Opener = plugin('FileOpener'), Share = plugin('Share');
    if (!Fs) return { ok: false, error: 'Открыть файл можно только в приложении на телефоне.' };
    var uri = (await Fs.getUri({ path: path, directory: directory })).uri;
    if (Opener) {
      try { await Opener.open({ filePath: uri, contentType: mimeOf(name), openWithDefault: false }); return { ok: true }; }
      catch (e) { console.warn('GRASS mobile: нет программы для файла, предлагаю «Поделиться»', e && e.message); }
    }
    if (!Share) return { ok: false, error: 'На телефоне нет программы, чтобы открыть этот файл.' };
    try { await Share.share({ title: name, files: [uri], dialogTitle: name }); return { ok: true }; }
    catch (e) { return /cancel/i.test(String(e && e.message)) ? { ok: true } : { ok: false, error: 'Не удалось открыть файл: ' + (e && e.message || e) }; }
  }
  var grassAttachments = {
    add: function (taskId) {
      if (!validTaskId(String(taskId || ''))) return Promise.resolve({ ok: false, error: 'Некорректная задача.' });
      var picked = pickFiles();
      return picked.then(async function (files) {
        var items = [], skipped = [];
        for (var i = 0; i < files.length; i++) {
          var f = files[i], name = safeFileName(f.name);
          if (f.size > ATTACH_MAX_BYTES) { skipped.push({ name: name, reason: 'больше 25 МБ (ограничение телефона)' }); continue; }
          try {
            var id = uuid(), stored = site + '/' + taskId + '/' + id.slice(0, 8) + '__' + name;
            await attachWrite(stored, await fileToBase64(f));
            items.push({ id: id, name: name, size: f.size, stored: stored, addedAt: new Date().toISOString() });
          } catch (e) { skipped.push({ name: name, reason: 'не удалось сохранить' }); }
        }
        return { ok: true, items: items, skipped: skipped };
      });
    },
    open: async function (stored) {
      stored = String(stored || '');
      if (!validStored(stored)) return { ok: false, error: 'Некорректный путь вложения.' };
      if (!(await attachExists(stored))) return { ok: false, error: 'Файла нет на этом телефоне (вложение добавили на другом устройстве или после восстановления копии).' };
      try { return await openNativeFile(ATTACH_DIR + '/' + stored, 'DATA', stored.split('__').slice(1).join('__')); }
      catch (e) { return { ok: false, error: 'Не удалось открыть файл: ' + (e && e.message || e) }; }
    },
    reveal: function (stored) { return grassAttachments.open(stored); },
    exists: async function (list) {
      var out = {};
      list = Array.isArray(list) ? list.slice(0, 500) : [];
      for (var i = 0; i < list.length; i++) { var st = String(list[i]); out[st] = validStored(st) && await attachExists(st); }
      return out;
    }
  };

  // ---------- выгрузка в Excel и «PDF» (1.7.6) ----------
  // Файлы — в «Документы/GRASS/Выгрузки», сразу после сохранения предлагаем отправить.
  // PDF на телефоне без отдельного движка печати не собрать, поэтому сохраняется страница для печати (.html):
  // она открывается в браузере, а оттуда «Печать → Сохранить как PDF».
  var EXPORT_DIR = BACKUP_DIR + '/Выгрузки';
  function utf8ToBase64(text) {
    var bytes = new TextEncoder().encode(text), s = '';
    for (var i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  async function saveExport(name, ext, base64) {
    var Fs = plugin('Filesystem');
    var file = safeFileName(String(name || 'GRASS')) + '.' + ext;
    if (!Fs) { devBackups.set('export:' + file, base64); return { ok: true, path: 'Документы/' + EXPORT_DIR + '/' + file }; }
    if (!(await ensureFsPermission())) return { ok: false, error: 'Нет разрешения на запись в «Документы».' };
    await Fs.writeFile({ path: EXPORT_DIR + '/' + file, data: base64, directory: FS_DIR, recursive: true });
    var shown = 'Документы/' + EXPORT_DIR + '/' + file;
    lastExport = { path: EXPORT_DIR + '/' + file, name: file };
    setTimeout(function () { openNativeFile(EXPORT_DIR + '/' + file, FS_DIR, file).catch(function () {}); }, 300);
    return { ok: true, path: shown };
  }
  var lastExport = null;
  var grassExport = {
    xlsx: function (name, base64) {
      return saveExport(name, 'xlsx', String(base64 || '')).catch(function (e) { return { ok: false, error: String(e && e.message || e) }; });
    },
    pdf: function (name, html) {
      var page = String(html || '').replace(/<\/head>/i, '<meta name="viewport" content="width=device-width,initial-scale=1"></head>');
      return saveExport(String(name || 'GRASS') + ' (для печати)', 'html', utf8ToBase64(page)).catch(function (e) { return { ok: false, error: String(e && e.message || e) }; });
    },
    open: async function () {
      if (!lastExport) return false;
      var r = await openNativeFile(lastExport.path, FS_DIR, lastExport.name).catch(function () { return { ok: false }; });
      return !!r.ok;
    }
  };

  // ---------- уведомления Android (1.7.6) ----------
  // Срабатывают, пока приложение открыто или свёрнуто недавно: Android усыпляет фоновые приложения,
  // поэтому напоминание о сроке на телефоне может прийти с опозданием или после открытия приложения.
  var notifyId = 1, notifyAllowed = null;
  async function ensureNotifyPermission(N) {
    if (notifyAllowed !== null) return notifyAllowed;
    try {
      var p = await N.checkPermissions();
      if (p.display !== 'granted') p = await N.requestPermissions();
      notifyAllowed = p.display === 'granted';
    } catch (_) { notifyAllowed = false; }
    return notifyAllowed;
  }
  var grassNotify = {
    show: async function (title, body) {
      var N = plugin('LocalNotifications');
      if (!N) return false;
      if (!(await ensureNotifyPermission(N))) return false;
      try {
        await N.schedule({ notifications: [{ id: (notifyId = notifyId % 100000 + 1), title: String(title || ''), body: String(body || ''), largeBody: String(body || '') }] });
        return true;
      } catch (e) { console.warn('GRASS mobile: уведомление не показано', e && e.message); return false; }
    },
    taskbar: function () { return Promise.resolve(false); }   // панели задач на телефоне нет
  };

  window.grassStorage = grassStorage;
  window.grassSite = grassSite;
  window.grassAdmin = grassAdmin;
  window.grassAttachments = grassAttachments;
  window.grassExport = grassExport;
  window.grassNotify = grassNotify;
  window.grassMobile = { version: APP_VERSION, pendingWrites: function () { return pendingWrites; } };

  // ---------- то, чего на ПК нет, а на телефоне нужно ----------
  function adaptUi() {
    var setText = function (id, text) { var el = document.getElementById(id); if (el) el.textContent = text; };
    // Обновления: на телефоне через новый APK
    setText('updateStatus', 'Версия ' + APP_VERSION + '. Обновление ставится новым APK-файлом.');
    var openBtn = document.getElementById('openBackupFolderBtn');
    if (openBtn) openBtn.textContent = 'Отправить копию';
    var hide = function (el) { if (el) el.classList.add('grass-mobile-hidden'); };
    var byId = function (id) { return document.getElementById(id); };
    var closest = function (id, sel) { var el = byId(id); return el && el.closest(sel); };
    // 1.7.x: на телефоне нет второй папки для копий, обновления через сервер, общей базы и чистки файлов очищенных задач.
    hide(closest('mirrorChoose', '.mirror-row'));
    hide(byId('checkUpdateBtn')); hide(byId('installUpdateBtn'));
    hide(closest('purgeAttachBtn', '.settings-row'));
    hide(closest('dbInfoSessions', 'div'));
    // Надписи про Windows и компьютер — по-телефонному.
    document.querySelectorAll('#screen-settings b, #screen-settings span').forEach(function (el) {
      if (el.children.length) return;
      var t = el.textContent;
      var n = t.replace('Уведомление Windows', 'Уведомление').replace('уведомления Windows', 'уведомления');
      if (n !== t) el.textContent = n;
    });
    // PDF на телефоне — страница для печати (см. grassExport.pdf).
    ['summaryPdf', 'statsPdf'].forEach(function (id) {
      var b = byId(id);
      if (b) { b.textContent = '⬇ Печать'; b.title = 'Страница для печати: откройте в браузере → Печать → Сохранить как PDF'; }
    });
    var mode = byId('dbInfoMode');
    if (mode && window.MutationObserver) {
      var fixMode = function () { if (/компьютере/.test(mode.textContent)) mode.textContent = 'Своя база на этом телефоне'; };
      fixMode();
      new MutationObserver(fixMode).observe(mode, { childList: true, characterData: true, subtree: true });
    }

    // Восстановление из любого файла (например, копию прислали с другого телефона)
    var restoreBtn = document.getElementById('restoreFromBackupBtn');
    if (restoreBtn && !document.getElementById('restoreFromFileBtn')) {
      var input = document.createElement('input');
      input.type = 'file';
      input.accept = 'application/json,.json';
      input.hidden = true;
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.id = 'restoreFromFileBtn';
      btn.className = restoreBtn.className;
      btn.textContent = 'Из файла…';
      btn.onclick = function () { input.value = ''; input.click(); };
      input.onchange = async function () {
        var f = input.files && input.files[0];
        if (!f) return;
        if (!confirm('Восстановить данные из файла «' + f.name + '»?\nТекущие данные будут заменены. Перед этим автоматически сохранится страховочная копия.')) return;
        var r = await grassAdmin.restoreFromFile(f);
        if (r.ok) { banner('Данные восстановлены из ' + f.name + '. Перезапуск…', 'info'); setTimeout(function () { location.reload(); }, 700); }
        else banner(r.error || 'Восстановление не выполнено.', 'error');
      };
      restoreBtn.insertAdjacentElement('afterend', btn);
      btn.insertAdjacentElement('afterend', input);
    }
  }

  // Кнопка «Назад» на Android: закрывает окно/меню, а не приложение.
  function setupBackButton() {
    var App = plugin('App');
    if (!App || !App.addListener) return;
    App.addListener('backButton', function () {
      var dialogs = Array.from(document.querySelectorAll('dialog[open]'));
      if (dialogs.length) { var d = dialogs[dialogs.length - 1]; try { d.close(); } catch (_) { d.removeAttribute('open'); } return; }
      var menu = document.querySelector('.menu.open');
      if (menu) { menu.classList.remove('open'); return; }
      var gate = document.getElementById('siteGate');
      if (gate && !gate.classList.contains('hidden') && safeLocalGet('grass_selected_site')) { gate.classList.add('hidden'); return; }
      var tasksBtn = document.querySelector('nav [data-screen="tasks"]');
      if (tasksBtn && !tasksBtn.classList.contains('active')) { tasksBtn.click(); return; }
      if (App.minimizeApp) App.minimizeApp(); else if (App.exitApp) App.exitApp();
    });
  }

  async function dailyBackupIfNeeded() {
    if (!mem.size || !plugin('Filesystem')) return;
    var today = new Date().toISOString().slice(0, 10);
    var items = await listBackupsSorted();
    if (items.some(function (i) { return i.name.indexOf('-daily-' + today) >= 0; })) return;
    var r = await createBackup('daily');
    if (!r.ok) console.warn('GRASS mobile: ежедневная копия не создана', r.error);
  }

  // Модули и основной скрипт index.html — строго в том порядке, в каком они стоят в файле.
  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('не загрузился ' + src)); };
      document.body.appendChild(s);
    });
  }
  async function runDeferredScripts() {
    var list = Array.from(document.querySelectorAll('script[type="text/x-grass-deferred"]'));
    if (!document.getElementById('grass-main-script')) { fatal('Не найден основной скрипт приложения.'); return false; }
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      if (el.dataset.src) {
        try { await loadScript(el.dataset.src); }
        catch (e) { fatal('Не удалось запустить приложение: ' + e.message + '.'); return false; }
      } else {
        var s = document.createElement('script');
        s.text = el.textContent;
        document.body.appendChild(s);
      }
    }
    return true;
  }

  window.addEventListener('error', function (e) {
    console.error('GRASS mobile error:', e.message, e.filename, e.lineno);
  });

  async function start() {
    if (!window.indexedDB) { fatal('На этом телефоне недоступно хранилище данных (IndexedDB). Обновите Android System WebView.'); return; }
    try {
      idb = await openIdb();
      mem = await idbLoadAll(idb);
    } catch (e) {
      // Не запускаем приложение «с пустой базой» — иначе пользователь решит, что данные пропали.
      fatal('Не удалось открыть данные приложения: ' + (e && e.message || e) + '. Данные не тронуты. Перезапустите приложение.');
      return;
    }
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (_) {}
    if (!(await runDeferredScripts())) return;
    adaptUi();
    setupBackButton();
    dailyBackupIfNeeded().catch(function (e) { console.warn('GRASS mobile: daily backup', e); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
