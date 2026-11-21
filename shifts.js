/*
 * GRASS — Передача смены · логика смен (1.7)
 *
 * Единственное место, где описаны правила смен. Остальной код спрашивает только этот модуль.
 *   - График: 2 дня / выходной / 2 ночи / 3 выходных, 4 смены A–D, привязка к 01.09.2026.
 *   - Окна: день 08:30–20:30, ночь 20:30–08:30. В каждом окне работает ровно одна смена.
 *   - Время смены зависит от того, день она сейчас или ночь (а не от буквы).
 *   - Получатель передачи считается от смены, которая передаёт задачу сейчас.
 *   - 1.7.6 (п. 29): время начала смен, порядок бригад и дату отсчёта можно поменять в Настройках
 *     (configure). По умолчанию — как выше; ночь всегда начинается через 12 часов после дня.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GrassShifts = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LETTERS = ['A', 'B', 'C', 'D'];
  var CYCLE = ['День', 'День', 'Выходной', 'Ночь', 'Ночь', 'Выходной', 'Выходной', 'Выходной'];
  var PHASE = { A: 7, B: 3, C: 1, D: 5 };
  var DAY_START = 8 * 60 + 30;   // 08:30
  var NIGHT_START = 20 * 60 + 30; // 20:30
  var TIMES = { 'День': ['08:30', '20:30'], 'Ночь': ['20:30', '08:30'] };
  // График по умолчанию: 02.09.2026 у бригады A первый дневной день, дальше через 2 дня D, B, C.
  var DEFAULT_SCHEDULE = { dayStart: '08:30', order: ['A', 'D', 'B', 'C'], anchor: '2026-09-02' };
  var schedule = { dayStart: '08:30', order: DEFAULT_SCHEDULE.order.slice(), anchor: DEFAULT_SCHEDULE.anchor };
  // Сколько минут после начала новой смены передачу ещё считаем «поздней передачей» уходящей смены.
  var LATE_HANDOVER_MINUTES = 60;

  function dayIndex(date) {
    var base = new Date(2026, 8, 1); base.setHours(0, 0, 0, 0);
    var d = new Date(date); d.setHours(0, 0, 0, 0);
    return Math.round((d - base) / 86400000);
  }

  /** Что у смены s в календарный день date: 'День' | 'Ночь' | 'Выходной'. */
  function stateOnDate(date, s) {
    if (!(s in PHASE)) return 'Выходной';
    var i = dayIndex(date) + PHASE[s];
    return CYCLE[((i % 8) + 8) % 8];
  }

  /** Окно смены, в которое попадает момент at: {mode, start, end, shift}. */
  function windowAt(at) {
    var d = new Date(at);
    var minutes = d.getHours() * 60 + d.getMinutes();
    var start = new Date(d); start.setSeconds(0, 0);
    var mode;
    var dh = Math.floor(DAY_START / 60), dm = DAY_START % 60, nh = Math.floor(NIGHT_START / 60), nm = NIGHT_START % 60;
    if (minutes >= DAY_START && minutes < NIGHT_START) { mode = 'День'; start.setHours(dh, dm, 0, 0); }
    else if (minutes >= NIGHT_START) { mode = 'Ночь'; start.setHours(nh, nm, 0, 0); }
    else { mode = 'Ночь'; start.setDate(start.getDate() - 1); start.setHours(nh, nm, 0, 0); }
    var end = new Date(start);
    if (mode === 'День') end.setHours(nh, nm, 0, 0);
    else { end.setDate(end.getDate() + 1); end.setHours(dh, dm, 0, 0); }
    // Ночная смена «принадлежит» дню, в который она началась.
    var shift = null;
    for (var k = 0; k < LETTERS.length; k++) if (stateOnDate(start, LETTERS[k]) === mode) { shift = LETTERS[k]; break; }
    return { mode: mode, start: start, end: end, shift: shift };
  }

  function activeShift(at) { return windowAt(at || new Date()).shift; }

  /** Предыдущее окно (смена, которая работала непосредственно перед текущей). */
  function previousWindow(at) {
    var cur = windowAt(at || new Date());
    return windowAt(new Date(cur.start.getTime() - 60000));
  }

  /** Следующее окно после текущего. */
  function nextWindow(at) {
    var cur = windowAt(at || new Date());
    return windowAt(new Date(cur.end.getTime() + 60000));
  }

  /** Ближайшее окно после at, в котором работает смена s (или null). */
  function nextWindowOf(s, at) {
    var w = nextWindow(at);
    for (var i = 0; i < 40; i++) {
      if (w.shift === s) return w;
      w = windowAt(new Date(w.end.getTime() + 60000));
    }
    return null;
  }

  function times(mode) { return TIMES[mode] || ['', '']; }

  /** «Смена C · Ночь · 20:30–08:30» */
  function label(w) {
    if (!w || !w.shift) return '—';
    var t = times(w.mode);
    return 'Смена ' + w.shift + ' · ' + w.mode + ' · ' + t[0] + '–' + t[1];
  }

  /**
   * Какая смена передаёт задачу сейчас.
   *  currentShift — смена, выбранная в приложении (сама переключается на границах);
   *  holderShift  — смена, у которой задача сейчас (создала, приняла или восстановила).
   * Если смена только что закончилась (первый час новой), а задача у неё — это поздняя передача
   * уходящей смены: технолог задержался, чтобы передать дела.
   */
  function senderShift(currentShift, holderShift, at) {
    var now = at || new Date();
    var cur = windowAt(now);
    var prev = previousWindow(now);
    var minutesIntoShift = (now - cur.start) / 60000;
    if (holderShift && holderShift !== currentShift && holderShift === prev.shift && minutesIntoShift < LATE_HANDOVER_MINUTES) {
      return holderShift;
    }
    return currentShift;
  }

  /**
   * Кому уходит задача, которую передаёт смена sender в момент at.
   *  - смена sender сейчас не на работе (уже закончила) → получает та, что работает сейчас;
   *  - sender работает сейчас → следующая смена после текущей.
   */
  function recipient(sender, at) {
    var now = at || new Date();
    var cur = windowAt(now);
    if (cur.shift && cur.shift !== sender) return cur.shift;
    var w = nextWindow(now);
    for (var i = 0; i < 40; i++) {
      if (w.shift && w.shift !== sender) return w.shift;
      w = windowAt(new Date(w.end.getTime() + 60000));
    }
    return null;
  }

  // ---------- 1.7.6: свой график ----------
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function hm(min) { return pad(Math.floor(min / 60) % 24) + ':' + pad(min % 60); }
  function parseDay(v) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || ''));
    if (!m) return null;
    var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return d.getDate() === Number(m[3]) && d.getMonth() === Number(m[2]) - 1 ? d : null;
  }
  /** Что не так с графиком (пустая строка — всё верно). */
  function validate(cfg) {
    if (!cfg || typeof cfg !== 'object') return 'Нет графика.';
    var m = /^(\d{2}):(\d{2})$/.exec(String(cfg.dayStart || ''));
    if (!m || Number(m[2]) > 59) return 'Время начала дневной смены — в виде чч:мм.';
    var min = Number(m[1]) * 60 + Number(m[2]);
    if (min < 4 * 60 || min >= 12 * 60) return 'Дневная смена должна начинаться с 04:00 до 11:59 (ночная — через 12 часов).';
    var order = Array.isArray(cfg.order) ? cfg.order : [];
    if (order.length !== 4 || LETTERS.some(function (l) { return order.indexOf(l) < 0; })) return 'В порядке бригад должны быть A, B, C и D — каждая один раз.';
    if (!parseDay(cfg.anchor)) return 'Укажите дату отсчёта.';
    return '';
  }
  /** Поставить график. Неверный или пустой — график по умолчанию. Возвращает поставленный график. */
  function configure(cfg) {
    var c = cfg && !validate(cfg) ? cfg : DEFAULT_SCHEDULE;
    var m = /^(\d{2}):(\d{2})$/.exec(c.dayStart);
    DAY_START = Number(m[1]) * 60 + Number(m[2]);
    NIGHT_START = DAY_START + 12 * 60;
    TIMES['День'] = [hm(DAY_START), hm(NIGHT_START)];
    TIMES['Ночь'] = [hm(NIGHT_START), hm(DAY_START)];
    var a = dayIndex(parseDay(c.anchor));
    c.order.forEach(function (l, k) { PHASE[l] = ((-(a + 2 * k)) % 8 + 8) % 8; });
    schedule = { dayStart: c.dayStart, order: c.order.slice(), anchor: c.anchor };
    return current();
  }
  function current() { return { dayStart: schedule.dayStart, order: schedule.order.slice(), anchor: schedule.anchor }; }
  function sameSchedule(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
  /** Какие смены будут сегодня и завтра при графике cfg (текущий график не меняется). */
  function preview(cfg, at) {
    var keep = current(), out = [];
    configure(cfg);
    try {
      var base = new Date(at || new Date()); base.setHours(12, 0, 0, 0);
      for (var i = 0; i < 2; i++) {
        var d = new Date(base); d.setDate(d.getDate() + i);
        var day = windowAt(d), night = windowAt(new Date(d.getTime() + 12 * 3600000));
        out.push({ date: new Date(day.start), day: day.shift, night: night.shift, dayTimes: times('День'), nightTimes: times('Ночь') });
      }
    } finally { configure(keep); }
    return out;
  }

  return {
    DEFAULT_SCHEDULE: DEFAULT_SCHEDULE, validate: validate, configure: configure, current: current, preview: preview, sameSchedule: sameSchedule,
    LETTERS: LETTERS, CYCLE: CYCLE, PHASE: PHASE, LATE_HANDOVER_MINUTES: LATE_HANDOVER_MINUTES,
    stateOnDate: stateOnDate, windowAt: windowAt, activeShift: activeShift,
    previousWindow: previousWindow, nextWindow: nextWindow, nextWindowOf: nextWindowOf,
    times: times, label: label, senderShift: senderShift, recipient: recipient
  };
});
