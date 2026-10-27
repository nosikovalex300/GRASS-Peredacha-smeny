/*
 * GRASS — Передача смены · логика статистики и сводки смены (1.7.7)
 *
 * Чистые функции: получают данные (db, история, «сейчас») аргументами и ничего не рисуют.
 * Окно (index.html) только вызывает их и показывает результат; тесты — tests/stats.test.js.
 *   - Статус задачи на момент времени берётся из событий истории.
 *   - «Выполнено» считается по моменту, когда задача стала «Выполненной».
 *   - Просрочка — на исполнителе, а если его нет — на авторе.
 *   - Сводка смены строится по событиям той смены, а не по нынешнему состоянию задач.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GrassStats = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T/;
  var DONE = 'Выполнена';
  var ARCHIVE_ACTIONS = new Set(['Задача перемещена в архив', 'Задача автоматически перемещена в архив']);
  var TECH_ACTIONS = { 'Создана задача': 'created', 'Передана по смене': 'passed', 'Задача принята': 'accepted', 'Задача возвращена': 'returned' };
  var TECH_FIELDS = ['created', 'completed', 'passed', 'accepted', 'returned', 'overdue'];

  function dayKey(d) { return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate(); }
  function startOfDay(d) { var x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
  function endOfDay(d) { var x = new Date(d); x.setHours(23, 59, 59, 999); return x; }
  function realPerson(n) { return !!n && n !== 'Система' && n !== 'Автоматически' && n !== 'Регламент'; }
  function responsibleOf(t) { return t.assignee || t.author || ''; }

  // Дата из поля задачи/события: ISO или старый формат «дд.мм[.гггг][, чч:мм]».
  function parseStoredDate(value, now) {
    if (!value) return null;
    if (value instanceof Date) return value;
    var raw = String(value).trim();
    if (ISO_DATE_RE.test(raw)) { var iso = new Date(raw); return isNaN(iso) ? null : iso; }
    var m = raw.match(/^(\d{2})\.(\d{2})(?:\.(\d{4}))?(?:,\s*(\d{2}):(\d{2}))?/);
    if (!m) return null;
    var year = m[3] ? Number(m[3]) : (now ? new Date(now) : new Date()).getFullYear();
    var d = new Date(year, Number(m[2]) - 1, Number(m[1]), m[4] ? Number(m[4]) : 0, m[5] ? Number(m[5]) : 0, 0, 0);
    return isNaN(d) ? null : d;
  }

  // Время события для сводки: at, иначе when (в старых событиях без года — берём fallbackYear).
  function eventDate(h, fallbackYear) {
    if (h && h.at) { var a = new Date(h.at); if (!isNaN(a)) return a; }
    if (h && h.when) {
      var raw = String(h.when).trim();
      var d = new Date(raw); if (!isNaN(d)) return d;
      var m = raw.match(/^(\d{2})\.(\d{2})(?:\.(\d{4}))?,?\s+(\d{1,2}):(\d{2})/);
      if (m) {
        var year = Number(m[3] || fallbackYear || new Date().getFullYear());
        d = new Date(year, Number(m[2]) - 1, Number(m[1]), Number(m[4]), Number(m[5]), 0, 0);
        if (!isNaN(d)) return d;
      }
    }
    return null;
  }

  // Статус задачи после события. С 1.7 он записан в самом событии; у старых событий — по действию.
  function eventStatusOf(h) {
    if (h.status) return h.status;
    if (h.action === 'Изменён статус') { var m = String(h.details || '').match(/→\s*(.+?)\s*$/); return m ? m[1] : null; }
    if (h.action === 'Передана по смене') return 'Передать по смене';
    if (h.action === 'Задача принята' || h.action === 'Задача восстановлена') return 'В работе';
    return null;
  }
  // То же для сводки: если по событию статус не понять — нынешний статус задачи.
  function summaryStatusOf(h, task) {
    var st = eventStatusOf(h);
    return st != null ? st : (task && task.status) || '';
  }

  // Все задачи для статистики без повторов: активные, архив и задачи из очищенного архива.
  function taskPool(db) {
    var map = new Map();
    [].concat(db.statsArchive || [], db.archive || [], db.tasks || []).forEach(function (t) {
      var id = String(t.id); if (!map.has(id)) map.set(id, t);
    });
    return Array.from(map.values());
  }

  // События каждой задачи по порядку времени; при равном времени — как в истории
  // (там новые сверху, значит больший индекс — раньше).
  function buildIndex(history) {
    var map = new Map();
    (history || []).forEach(function (x, i) {
      var d = parseStoredDate(x.at || x.when); if (!d) return;
      var id = String(x.taskId); if (!map.has(id)) map.set(id, []);
      map.get(id).push({ h: x, d: d, i: i });
    });
    map.forEach(function (list) { list.sort(function (a, b) { return (a.d - b.d) || (b.i - a.i); }); });
    return map;
  }
  function taskEvents(index, taskId) { return index.get(String(taskId)) || []; }

  // Моменты, когда задача становилась «Выполненной» (в том числе сразу при создании), и кто это сделал.
  function completionEvents(index, taskId) {
    var out = [], prev = null;
    taskEvents(index, taskId).forEach(function (e) {
      var st = eventStatusOf(e.h); if (st == null) return;
      if (st === DONE && prev !== DONE) out.push({ at: e.d, author: e.h.author || '' });
      prev = st;
    });
    return out;
  }
  // Когда задача последний раз стала «Выполненной». У старых баз без таких событий —
  // время остановки срока, которое ставится в момент выполнения.
  function completedAtOf(index, task) {
    var ev = completionEvents(index, task.id);
    if (ev.length) return ev[ev.length - 1].at;
    var stopped = parseStoredDate(task.deadlineStoppedAt);
    return stopped && (task.status === DONE || task.archivedFromStatus === DONE) ? stopped : null;
  }
  // Срок, если задача по нему просрочена (выполнена позже срока или не выполнена, а срок прошёл).
  function overdueDeadline(index, t, now) {
    if (!t.deadline) return null;
    var dl = new Date(t.deadline); if (isNaN(dl)) return null;
    var c = completedAtOf(index, t);
    return (c ? c.getTime() > dl.getTime() : new Date(now).getTime() > dl.getTime() && t.status !== DONE) ? dl : null;
  }

  // Начало периода «7d» / «30d» / «all» (с самой ранней задачи или события).
  function startDate(db, period, now) {
    var d = startOfDay(now);
    if (period === '7d') { d.setDate(d.getDate() - 6); return d; }
    if (period === '30d') { d.setDate(d.getDate() - 29); return d; }
    var all = taskPool(db).map(function (t) { return parseStoredDate(t.date, now); }).filter(Boolean)
      .concat((db.history || []).map(function (h) { return parseStoredDate(h.when, now); }).filter(Boolean));
    var min = all.sort(function (a, b) { return a - b; })[0];
    return min ? startOfDay(min) : d;
  }

  // 1.7.7 (п. 46): быстрые периоды. Ключи — как в data-stats-period; '7d', '30d' и 'all' — прежние.
  var PERIODS = [['shift', 'Моя смена'], ['day', 'Сутки'], ['7d', 'Неделя'], ['30d', 'Месяц'], ['prevMonth', 'Прошлый месяц'], ['all', 'Всё время']];
  var MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
  // Последнее окно смены letter, начавшееся не позже at (текущее, если смена letter работает сейчас).
  function lastWindowOf(shifts, letter, at) {
    var w = shifts.windowAt(at);
    for (var i = 0; i < 40 && w; i++) {
      if (w.shift === letter) return w;
      w = shifts.windowAt(new Date(w.start.getTime() - 60000));
    }
    return null;
  }
  // Границы периода и предыдущего периода такой же длины (для стрелок «↗ / ↘»).
  // opts: { shifts: GrassShifts, shift: 'A'..'D' } — нужны для «Моей смены».
  function periodRange(db, period, now, opts) {
    var n = new Date(now), shifts = opts && opts.shifts, letter = opts && opts.shift;
    var r = { key: period, start: null, end: endOfDay(n), prevStart: null, prevEnd: null, caption: '' };
    var back = function (days) { var d = startOfDay(n); d.setDate(d.getDate() - days); return d; };
    var sameLength = function () {
      var len = Math.round((startOfDay(r.end) - startOfDay(r.start)) / 86400000) + 1;
      r.prevEnd = endOfDay(new Date(startOfDay(r.start).getTime() - 1));
      r.prevStart = startOfDay(r.prevEnd); r.prevStart.setDate(r.prevStart.getDate() - len + 1);
    };
    if (period === 'shift' && shifts && letter) {
      var w = lastWindowOf(shifts, letter, n);
      if (w) {
        r.start = new Date(w.start); r.end = new Date(Math.min(w.end.getTime() - 1, n.getTime()));
        var pw = lastWindowOf(shifts, letter, new Date(w.start.getTime() - 60000));
        if (pw) { r.prevStart = new Date(pw.start); r.prevEnd = new Date(pw.end.getTime() - 1); }
        var dd = function (x) { return (x < 10 ? '0' : '') + x; };
        r.caption = 'за смену ' + letter + ' · ' + dd(w.start.getDate()) + '.' + dd(w.start.getMonth() + 1) + ' ' + (w.mode === 'День' ? 'день' : 'ночь');
        return r;
      }
      period = 'day';
    }
    if (period === 'day') { r.start = startOfDay(n); r.caption = 'за сутки'; }
    else if (period === '7d') { r.start = back(6); r.caption = 'за неделю'; }
    else if (period === '30d') { r.start = back(29); r.caption = 'за месяц'; }
    else if (period === 'prevMonth') {
      r.start = new Date(n.getFullYear(), n.getMonth() - 1, 1); r.end = endOfDay(new Date(n.getFullYear(), n.getMonth(), 0));
      r.prevStart = new Date(n.getFullYear(), n.getMonth() - 2, 1); r.prevEnd = endOfDay(new Date(n.getFullYear(), n.getMonth() - 1, 0));
      r.caption = 'за ' + MONTHS[r.start.getMonth()] + ' ' + r.start.getFullYear();
      return r;
    } else { r.key = 'all'; r.start = startDate(db, 'all', n); r.caption = 'за всё время'; }
    sameLength();
    return r;
  }
  // 1.7.7 (п. 47): фильтр по бригаде. Событие — «в смену бригады», если в тот момент по графику работала она.
  function brigadeWhen(shifts, letter) {
    return letter ? function (d) { return shifts.windowAt(d).shift === letter; } : null;
  }
  // Задача — «бригады X», если создана в её смену (поле shift задачи, у старых — по времени создания).
  function brigadeOfTask(t, shifts, now) {
    if (t.shift) return t.shift;
    var d = parseStoredDate(t.createdAt || t.date, now);
    return d && shifts ? shifts.windowAt(d).shift || '' : '';
  }

  function emptyDays(start, end, make) {
    var rows = [], cur = startOfDay(start), last = endOfDay(end);
    while (cur <= last) { rows.push(make(new Date(cur))); cur.setDate(cur.getDate() + 1); }
    return rows;
  }

  // 1.7.7: события считаются только внутри [start, end] (для периода «Моя смена» — с точностью до минут)
  // и только если opts.when(дата) — например, «в смену бригады B». opts.match(задача) — фильтр задач.
  function inRange(d, start, end, opts) {
    return !!d && d >= start && d <= end && (!opts || !opts.when || opts.when(d));
  }
  // По дням периода: сколько создано, выполнено и сколько сроков просрочено (и какие это задачи — row.ids).
  function dailyCounts(db, index, start, end, now, opts) {
    var from = new Date(start), to = new Date(end);
    var rows = emptyDays(start, end, function (d) { return { date: d, created: 0, completed: 0, overdue: 0, ids: { created: [], completed: [], overdue: [] } }; });
    var byDay = new Map(rows.map(function (r) { return [dayKey(r.date), r]; }));
    var bump = function (t, d, f) {
      if (!inRange(d, from, to, opts)) return;
      var r = byDay.get(dayKey(d)); if (r) { r[f]++; r.ids[f].push(String(t.id)); }
    };
    taskPool(db).forEach(function (t) {
      if (opts && opts.match && !opts.match(t)) return;
      bump(t, parseStoredDate(t.date, now), 'created');
      bump(t, completedAtOf(index, t), 'completed');
      bump(t, overdueDeadline(index, t, now), 'overdue');
    });
    return rows;
  }

  // Состояние задачи на момент cutoff: есть ли она, в архиве ли, какой статус. null — ещё не создана.
  function taskStateAt(index, task, cutoff) {
    var events = taskEvents(index, task.id).map(function (e) { var h = Object.assign({}, e.h); h._date = e.d; return h; });
    var createdEvent = events.find(function (h) { return h.action === 'Создана задача'; });
    if (createdEvent && createdEvent._date > cutoff) return null;
    var initialStatus = 'В работе';
    var firstStatus = events.find(function (h) { return h.action === 'Изменён статус' && /→/.test(h.details || ''); });
    if (createdEvent && createdEvent.status) initialStatus = createdEvent.status;
    else if (firstStatus) { var m = (firstStatus.details || '').match(/^\s*(.+?)\s*→\s*(.+?)\s*$/); if (m) initialStatus = m[1].trim(); }
    else if (task.archivedFromStatus) initialStatus = task.archivedFromStatus;
    else if (task.status) initialStatus = task.status;
    var state = { exists: !!createdEvent, active: true, status: initialStatus };
    for (var i = 0; i < events.length; i++) {
      var h = events[i];
      if (h._date > cutoff) break;
      if (h.action === 'Создана задача') { state.exists = true; state.active = true; }
      else if (ARCHIVE_ACTIONS.has(h.action)) state.active = false;
      else if (h.action === 'Задача восстановлена') state.active = true;
      var st = eventStatusOf(h);
      if (st != null) state.status = st;
    }
    return state.exists ? state : null;
  }

  // Сколько задач было всего / выполнено / в работе / в архиве на момент cutoff.
  function snapshotAt(db, index, cutoff, match) {
    var s = { total: 0, done: 0, work: 0, archived: 0 };
    taskPool(db).filter(function (t) { return !match || match(t); }).forEach(function (t) {
      var state = taskStateAt(index, t, cutoff); if (!state) return;
      s.total++;
      if (!state.active) s.archived++;
      else if (state.status === DONE) s.done++;
      else if (state.status === 'В работе') s.work++;
    });
    return s;
  }

  // По каждому технологу — строки по дням периода. Засчитываются реальные действия из истории.
  // 1.7.7: у каждой строки — какие задачи за цифрой (row.ids[поле]); opts.when — как в dailyCounts.
  function techActivity(db, index, start, end, now, opts) {
    var from = new Date(start), to = new Date(end);
    var blank = function (d) { return { date: d, created: 0, completed: 0, passed: 0, accepted: 0, returned: 0, overdue: 0,
      ids: { created: [], completed: [], passed: [], accepted: [], returned: [], overdue: [] } }; };
    var days = emptyDays(from, to, function (d) { return d; });
    var byTech = new Map();
    var bump = function (name, date, field, taskId) {
      if (!realPerson(name) || !inRange(date, from, to, opts)) return;
      if (!byTech.has(name)) byTech.set(name, new Map(days.map(function (d) { return [dayKey(d), blank(new Date(d))]; })));
      var r = byTech.get(name).get(dayKey(date)); if (r) { r[field]++; r.ids[field].push(String(taskId)); }
    };
    (db.history || []).forEach(function (h) {
      var field = TECH_ACTIONS[h.action]; if (!field) return;
      bump(h.author, parseStoredDate(h.at || h.when, now), field, h.taskId);
    });
    taskPool(db).forEach(function (t) {
      completionEvents(index, t.id).forEach(function (c) { bump(c.author, c.at, 'completed', t.id); });
      var dl = overdueDeadline(index, t, now); if (dl) bump(responsibleOf(t), dl, 'overdue', t.id);
    });
    var rowsOf = function (name) {
      return byTech.has(name) ? Array.from(byTech.get(name).values()) : days.map(function (d) { return blank(new Date(d)); });
    };
    return { days: days, byTech: byTech, rowsOf: rowsOf };
  }

  // Итог по технологам за период + «В работе как исполнитель» сейчас.
  function techTable(db, index, technologists, start, end, now, opts) {
    var act = techActivity(db, index, start, end, now, opts);
    var names = new Set((technologists || []).filter(realPerson));
    act.byTech.forEach(function (_, n) { names.add(n); });
    return Array.from(names).map(function (name) {
      var sum = { name: name, ids: {} }; TECH_FIELDS.forEach(function (k) { sum[k] = 0; sum.ids[k] = []; });
      act.rowsOf(name).forEach(function (r) { TECH_FIELDS.forEach(function (k) { sum[k] += r[k]; sum.ids[k] = sum.ids[k].concat(r.ids[k]); }); });
      var mine = (db.tasks || []).filter(function (t) { return t.assignee === name && t.status === 'В работе' && (!opts || !opts.match || opts.match(t)); });
      sum.assigned = mine.length; sum.ids.assigned = mine.map(function (t) { return String(t.id); });
      return sum;
    });
  }
  // 1.7.7: строка «Всего» под таблицей технологов: сумма по каждому столбцу.
  function techTotals(rows) {
    var tot = { name: 'Всего', ids: {} };
    TECH_FIELDS.concat(['assigned']).forEach(function (k) {
      tot[k] = 0; var set = new Set();
      (rows || []).forEach(function (r) { tot[k] += r[k] || 0; ((r.ids || {})[k] || []).forEach(function (id) { set.add(id); }); });
      tot.ids[k] = Array.from(set);
    });
    return tot;
  }

  function techOptions(db, technologists) {
    var names = new Set((technologists || []).filter(realPerson));
    taskPool(db).forEach(function (t) { [t.author, t.assignee].forEach(function (n) { if (realPerson(n)) names.add(n); }); });
    return Array.from(names);
  }

  // Сводка смены info={shift,start,end}: что смена сделала с каждой задачей (по её последнему событию за смену).
  // opts.lateMinutes — сколько после конца смены передачу ещё считаем её («смена задержалась»);
  // opts.skipTaskId — служебные события («Ознакомлен»), их в сводке нет. Служебные id вида '__…' (журнал смены)
  // тоже не задачи — пропускаются всегда.
  function shiftSummary(db, info, opts) {
    opts = opts || {};
    var empty = { info: info, tasks: [], rows: [], stats: { done: 0, pass: 0, work: 0, off: 0, overdue: 0 }, notes: [] };
    if (!info) return empty;
    var lateEnd = new Date(info.end.getTime() + (opts.lateMinutes || 0) * 60000);
    var events = (db.history || []).map(function (h) { var x = Object.assign({}, h); x.dt = eventDate(h, info.start.getFullYear()); return x; }).filter(function (h) {
      if (!h.dt || (opts.skipTaskId && h.taskId === opts.skipTaskId) || String(h.taskId).indexOf('__') === 0) return false;
      var inWindow = h.dt >= info.start && h.dt < info.end;
      if ((h.action === 'Передана по смене' || h.action === 'Задача возвращена') && h.fromShift === info.shift && h.dt >= info.start && h.dt < lateEnd) return true;
      if (!inWindow) return false;
      if (!h.v) return true; // события старых версий — только по времени
      return (h.fromShift && h.action === 'Передана по смене' ? h.fromShift : h.shift) === info.shift;
    }).sort(function (a, b) { return a.dt - b.dt; });
    var pool = [].concat(db.tasks || [], db.archive || [], db.statsArchive || []);
    var findTask = function (id) { return pool.find(function (x) { return String(x.id) === String(id); }); };
    var byTask = new Map();
    events.forEach(function (h) { var id = String(h.taskId); if (!id) return; if (!byTask.has(id)) byTask.set(id, []); byTask.get(id).push(h); });
    var hhmm = function (d) { return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }); };
    var rows = [];
    byTask.forEach(function (list, id) {
      var task = findTask(id);
      var last = list[list.length - 1];
      var statusThen = summaryStatusOf(last, task);
      var passed = list.slice().reverse().find(function (h) { return h.action === 'Передана по смене' || h.action === 'Задача возвращена'; });
      var created = list.some(function (h) { return h.action === 'Создана задача'; });
      var action = last.action;
      if (passed) action = (passed.action === 'Задача возвращена' ? 'возвращена' : 'передана') + ' смене ' + (passed.toShift || '?') + ' в ' + hhmm(passed.dt) + (passed.returnComment ? ': ' + passed.returnComment : '');
      else if (created && list.length === 1) action = 'создана';
      var commentThen = ('comment' in last) ? last.comment : ((task && task.comment) || '');
      var isArchived = !!(db.archive || []).find(function (x) { return String(x.id) === id; });
      var nowStatus = task ? (isArchived ? 'в архиве' : task.status) : '';
      rows.push({ id: id, text: last.text || (task && task.text) || 'Без названия', author: (task && task.author) || last.author || '', shift: info.shift,
        action: action, statusThen: statusThen, commentThen: commentThen, nowStatus: (nowStatus && nowStatus !== statusThen) ? nowStatus : '',
        deadline: last.deadline || (task && task.deadline) || '', lastBy: last.author || '', assignee: (task && task.assignee) || '' });
    });
    // Подстраховка для старых баз: задача создана в эту смену, а событий о ней нет.
    pool.forEach(function (t) {
      var createdAt = t.createdAt ? new Date(t.createdAt) : parseStoredDate(t.date);
      if (createdAt && createdAt >= info.start && createdAt < info.end && !byTask.has(String(t.id))) {
        rows.push({ id: String(t.id), text: t.text, author: t.author || '', shift: info.shift, action: 'создана', statusThen: t.status, commentThen: t.comment || '', nowStatus: '', deadline: t.deadline || '', lastBy: t.author || '' });
      }
    });
    var st = { done: 0, pass: 0, work: 0, off: 0, overdue: 0 };
    rows.forEach(function (r) {
      if (r.statusThen === DONE) st.done++;
      else if (r.statusThen === 'Передать по смене') st.pass++;
      else if (r.statusThen === 'В работе') st.work++;
      else if (r.statusThen === 'Не в работе') st.off++;
      var dl = r.deadline ? new Date(r.deadline) : null;
      r.overdue = !!(dl && !isNaN(dl) && dl < info.end && r.statusThen !== DONE);
      if (r.overdue) st.overdue++;
    });
    var notes = rows.filter(function (r) { return r.commentThen; }).slice(0, 5).map(function (r) { return { task: r.text, comment: r.commentThen }; });
    return { info: info, rows: rows, tasks: rows, stats: st, notes: notes };
  }

  // 1.7.6 (п. 28): сколько смен прошла задача — число окон смен от создания до выполнения (или до now).
  function shiftsSpanned(from, to, shifts) {
    if (!from || !to || !shifts || to < from) return 0;
    var w = shifts.windowAt(from), n = 0, guard = 0;
    while (w && w.start <= to && guard++ < 5000) { n++; w = shifts.windowAt(new Date(w.end.getTime() + 60000)); }
    return Math.max(1, n);
  }
  function round1(x) { return Math.round(x * 10) / 10; }
  function median(list) {
    if (!list.length) return null;
    var a = list.slice().sort(function (x, y) { return x - y; }), m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }
  // Скорость и сроки за период: по задачам, выполненным в период [start, end] (последнее выполнение).
  //   avgHours/medianHours — от создания до выполнения; avgShifts/maxShifts — сколько смен прошла задача;
  //   onTimePct — доля выполненных в срок среди выполненных со сроком; byPriority — то же по приоритетам.
  var PRIORITIES = ['Высокий', 'Обычный', 'Низкий'];
  // when — фильтр событий по времени (бригада), openMatch — какие из открытых задач считать (задачи бригады).
  function qualityStats(db, index, start, end, now, shifts, match, when, openMatch) {
    var from = new Date(start), to = new Date(end);
    var ok = function (d) { return inRange(d, from, to, when ? { when: when } : null); };
    var blank = function () { return { completed: 0, hours: [], shifts: [], withDeadline: 0, onTime: 0, created: 0, open: 0, overdueNow: 0,
      ids: { created: [], completed: [], withDeadline: [], onTime: [], open: [], overdueNow: [] } }; };
    var mark = function (x, f, t) { x.ids[f].push(String(t.id)); };
    var all = blank(), byP = {}, maxShifts = null, openLongest = null;
    PRIORITIES.forEach(function (p) { byP[p] = blank(); });
    taskPool(db).forEach(function (t) {
      if (match && !match(t)) return;
      var pr = PRIORITIES.indexOf(t.priority) >= 0 ? t.priority : 'Обычный', b = byP[pr];
      var created = parseStoredDate(t.createdAt || t.date, now);
      if (ok(created)) [all, b].forEach(function (x) { x.created++; mark(x, 'created', t); });
      var isActive = (db.tasks || []).some(function (x) { return x === t; });
      if (isActive && t.status !== DONE && (!openMatch || openMatch(t))) {
        [all, b].forEach(function (x) { x.open++; mark(x, 'open', t); });
        if (t.deadline && new Date(t.deadline) < new Date(now)) [all, b].forEach(function (x) { x.overdueNow++; mark(x, 'overdueNow', t); });
        var span = shiftsSpanned(created, new Date(now), shifts);
        if (created && (!openLongest || span > openLongest.count)) openLongest = { count: span, text: t.text || '', id: t.id };
      }
      var done = completedAtOf(index, t);
      if (!ok(done)) return;
      [all, b].forEach(function (x) { x.completed++; mark(x, 'completed', t); });
      if (created && done >= created) {
        var h = (done - created) / 3600000, sp = shiftsSpanned(created, done, shifts);
        [all, b].forEach(function (x) { x.hours.push(h); x.shifts.push(sp); });
        if (!maxShifts || sp > maxShifts.count) maxShifts = { count: sp, text: t.text || '', id: t.id };
      }
      var dl = t.deadline ? new Date(t.deadline) : null;
      if (dl && !isNaN(dl)) [all, b].forEach(function (x) { x.withDeadline++; mark(x, 'withDeadline', t); if (done <= dl) { x.onTime++; mark(x, 'onTime', t); } });
    });
    var sum = function (x) {
      var avg = function (l) { return l.length ? round1(l.reduce(function (a, v) { return a + v; }, 0) / l.length) : null; };
      return { created: x.created, completed: x.completed, open: x.open, overdueNow: x.overdueNow,
        avgHours: avg(x.hours), medianHours: x.hours.length ? round1(median(x.hours)) : null, avgShifts: avg(x.shifts),
        withDeadline: x.withDeadline, onTime: x.onTime, onTimePct: x.withDeadline ? Math.round(x.onTime / x.withDeadline * 100) : null, ids: x.ids };
    };
    var out = sum(all);
    out.maxShifts = maxShifts; out.openLongest = openLongest;
    out.byPriority = PRIORITIES.map(function (p) { var r = sum(byP[p]); r.priority = p; return r; });
    return out;
  }

  return {
    ARCHIVE_ACTIONS: ARCHIVE_ACTIONS, realPerson: realPerson, responsibleOf: responsibleOf, dayKey: dayKey,
    parseStoredDate: parseStoredDate, eventDate: eventDate, eventStatusOf: eventStatusOf, summaryStatusOf: summaryStatusOf,
    taskPool: taskPool, buildIndex: buildIndex, taskEvents: taskEvents, completionEvents: completionEvents,
    completedAtOf: completedAtOf, overdueDeadline: overdueDeadline, startDate: startDate, dailyCounts: dailyCounts,
    taskStateAt: taskStateAt, snapshotAt: snapshotAt, techActivity: techActivity, techTable: techTable,
    techOptions: techOptions, shiftSummary: shiftSummary, shiftsSpanned: shiftsSpanned, qualityStats: qualityStats,
    PERIODS: PERIODS, periodRange: periodRange, lastWindowOf: lastWindowOf, brigadeWhen: brigadeWhen, brigadeOfTask: brigadeOfTask,
    techTotals: techTotals, inRange: inRange
  };
});
