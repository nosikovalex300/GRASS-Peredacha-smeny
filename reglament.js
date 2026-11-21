/*
 * GRASS — Передача смены · регламент: повторяющиеся задачи (1.7.6, п. 24 плана)
 *
 * Только расписание: когда шаблону пора создать задачу. Окно (ui-reglament.js) создаёт задачи и рисует
 * настройки, тесты — tests/reglament.test.js. Смены берутся из shifts.js (передаются аргументом).
 *   - Повтор считается только в текущей смене: если программы были закрыты, задним числом не создаём.
 *   - У каждого повтора своя метка (шаблон + время), по ней id задачи — две копии программы
 *     не создадут одну задачу дважды: база не примет вторую задачу с тем же id.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GrassReglament = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var KINDS = ['none', 'shift', 'nthShift', 'hours', 'weekdays', 'everyNDays', 'everyNWeeks', 'monthDays'];
  var WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
  var LAST_DAY = 32;     // «последнее число месяца» в списке чисел
  var AUTHOR = 'Регламент';

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function dateOnly(d) { var x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
  function parseDay(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
  }
  function dayStr(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function daysBetween(a, b) { return Math.round((dateOnly(b) - dateOnly(a)) / 86400000); }
  function weekday(d) { return ((d.getDay() + 6) % 7) + 1; }      // Пн = 1 … Вс = 7
  function mondayOf(d) { var x = dateOnly(d); x.setDate(x.getDate() - (weekday(x) - 1)); return x; }
  function intIn(v, lo, hi, def) { var n = Math.round(Number(v)); return isFinite(n) && n >= lo && n <= hi ? n : def; }
  function uniqInts(list, lo, hi) {
    var out = [];
    (Array.isArray(list) ? list : []).forEach(function (v) { var n = Math.round(Number(v)); if (n >= lo && n <= hi && out.indexOf(n) < 0) out.push(n); });
    return out.sort(function (a, b) { return a - b; });
  }

  // Приводим шаблон к понятному виду: всё лишнее и неверное — к значениям по умолчанию.
  function normalize(t) {
    t = t || {};
    var r = t.rule || {};
    var kind = KINDS.indexOf(r.kind) >= 0 ? r.kind : 'none';
    var dayBased = kind === 'weekdays' || kind === 'everyNDays' || kind === 'everyNWeeks' || kind === 'monthDays';
    return {
      id: /^[a-z0-9]{4,12}$/.test(String(t.id || '')) ? String(t.id) : '',
      title: String(t.title || '').trim().slice(0, 300),
      comment: String(t.comment || '').slice(0, 2000),
      priority: ['Низкий', 'Обычный', 'Высокий'].indexOf(t.priority) >= 0 ? t.priority : 'Обычный',
      assignee: String(t.assignee || ''),
      deadlineHours: intIn(t.deadlineHours, 0, 720, 0),
      paused: !!t.paused,
      rule: {
        kind: kind,
        n: intIn(r.n, 1, 365, 1),
        mode: ['any', 'day', 'night'].indexOf(r.mode) >= 0 ? r.mode : (dayBased ? 'day' : 'any'),
        brigades: (Array.isArray(r.brigades) ? r.brigades : []).filter(function (b) { return /^[A-D]$/.test(b); }),
        days: uniqInts(r.days, 1, 7),
        monthDays: uniqInts(r.monthDays, 1, LAST_DAY),
        anchor: parseDay(r.anchor) ? r.anchor : ''
      }
    };
  }

  // Подходит ли смена-окно w под правило (без учёта «каждые N часов» внутри смены).
  function matchesWindow(rule, w, shifts) {
    if (!w || !w.shift) return false;
    if (rule.mode === 'day' && w.mode !== 'День') return false;
    if (rule.mode === 'night' && w.mode !== 'Ночь') return false;
    if (rule.brigades.length && rule.brigades.indexOf(w.shift) < 0) return false;
    var anchor = parseDay(rule.anchor);
    switch (rule.kind) {
      case 'shift': case 'hours': return true;
      case 'weekdays': return rule.days.indexOf(weekday(w.start)) >= 0;
      case 'monthDays': {
        var d = w.start.getDate();
        var last = new Date(w.start.getFullYear(), w.start.getMonth() + 1, 0).getDate();
        return rule.monthDays.indexOf(d) >= 0 || (d === last && rule.monthDays.indexOf(LAST_DAY) >= 0);
      }
      case 'everyNDays': {
        if (!anchor) return false;
        var nd = daysBetween(anchor, w.start); return nd >= 0 && nd % rule.n === 0;
      }
      case 'everyNWeeks': {
        if (!anchor || rule.days.indexOf(weekday(w.start)) < 0) return false;
        var nw = Math.round(daysBetween(mondayOf(anchor), mondayOf(w.start)) / 7); return nw >= 0 && nw % rule.n === 0;
      }
      case 'nthShift': {
        // Считаем подходящие смены начиная с даты отсчёта: 1-я, (N+1)-я, (2N+1)-я …
        if (!anchor || w.start < anchor) return false;
        var x = shifts.windowAt(new Date(anchor.getTime() + 60000)), i = 0, guard = 0;
        if (x.start < anchor) x = shifts.windowAt(new Date(x.end.getTime() + 60000));
        while (x.start < w.start && guard++ < 20000) {
          if (matchesFilters(rule, x)) i++;
          x = shifts.windowAt(new Date(x.end.getTime() + 60000));
        }
        return i % rule.n === 0;
      }
      default: return false;
    }
  }
  function matchesFilters(rule, w) {
    if (!w.shift) return false;
    if (rule.mode === 'day' && w.mode !== 'День') return false;
    if (rule.mode === 'night' && w.mode !== 'Ночь') return false;
    return !rule.brigades.length || rule.brigades.indexOf(w.shift) >= 0;
  }

  // Повтор, которому пора быть в текущей смене: самый поздний момент не позже now. null — сейчас не нужен.
  function dueOccurrence(tpl, now, shifts) {
    var t = normalize(tpl);
    if (!t.id || t.paused || t.rule.kind === 'none' || !t.title) return null;
    var w = shifts.windowAt(now);
    if (!matchesWindow(t.rule, w, shifts)) return null;
    var at = new Date(w.start);
    if (t.rule.kind === 'hours') {
      var step = t.rule.n * 3600000;
      at = new Date(w.start.getTime() + Math.floor((new Date(now) - w.start) / step) * step);
    }
    var key = at.getFullYear() + pad(at.getMonth() + 1) + pad(at.getDate()) + pad(at.getHours()) + pad(at.getMinutes());
    return { key: key, at: at, window: w, taskId: 'reg-' + t.id + '-' + key,
      deadline: t.deadlineHours ? new Date(at.getTime() + t.deadlineHours * 3600000) : null };
  }

  // Ближайшие повторы — для подсказки в окне шаблона «следующие: …».
  function upcoming(tpl, from, shifts, count) {
    var t = normalize(tpl), out = [];
    if (t.rule.kind === 'none') return out;
    var w = shifts.windowAt(from), guard = 0;
    while (out.length < (count || 3) && guard++ < 1500) {
      if (matchesWindow(t.rule, w, shifts)) {
        if (t.rule.kind === 'hours') {
          for (var s = w.start.getTime(); s < w.end.getTime() && out.length < (count || 3); s += t.rule.n * 3600000) if (s >= new Date(from).getTime() - 1) out.push({ at: new Date(s), shift: w.shift });
        } else if (w.start.getTime() >= new Date(from).getTime() - 12 * 3600000) out.push({ at: new Date(w.start), shift: w.shift });
      }
      w = shifts.windowAt(new Date(w.end.getTime() + 60000));
    }
    return out;
  }

  // Расписание словами: «каждую дневную смену бригады A», «по Пн, Чт (дневные смены)» и т. п.
  function describe(tpl) {
    var r = normalize(tpl).rule;
    var who = (r.mode === 'day' ? 'дневную' : r.mode === 'night' ? 'ночную' : '') ;
    var br = r.brigades.length ? ' бригады ' + r.brigades.join(', ') : '';
    var modeTail = r.mode === 'day' ? ' (дневная смена)' : r.mode === 'night' ? ' (ночная смена)' : '';
    var from = r.anchor ? ', отсчёт с ' + r.anchor.split('-').reverse().join('.') : '';
    switch (r.kind) {
      case 'none': return 'только шаблон, сама не создаётся';
      case 'shift': return 'каждую ' + (who ? who + ' ' : '') + 'смену' + br;
      case 'nthShift': return 'каждую ' + r.n + '-ю ' + (who ? who + ' ' : '') + 'смену' + br + from;
      case 'hours': return 'каждые ' + r.n + ' ч в ' + (who ? who + ' ' : '') + 'смену' + br;
      case 'weekdays': return 'по ' + (r.days.map(function (d) { return WEEKDAYS[d - 1]; }).join(', ') || '—') + modeTail + br;
      case 'everyNDays': return 'раз в ' + r.n + ' дн.' + modeTail + br + from;
      case 'everyNWeeks': return 'раз в ' + r.n + ' нед. по ' + (r.days.map(function (d) { return WEEKDAYS[d - 1]; }).join(', ') || '—') + modeTail + br + from;
      case 'monthDays': return (r.monthDays.map(function (d) { return d === LAST_DAY ? 'последнего' : String(d); }).join(', ') || '—') + ' числа' + modeTail + br;
      default: return '';
    }
  }

  return { KINDS: KINDS, WEEKDAYS: WEEKDAYS, LAST_DAY: LAST_DAY, AUTHOR: AUTHOR, normalize: normalize, matchesWindow: matchesWindow,
    dueOccurrence: dueOccurrence, upcoming: upcoming, describe: describe, dayStr: dayStr };
});
