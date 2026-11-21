/*
 * GRASS — Передача смены · журнал смены (1.7.6, п. 25 плана)
 *
 * Записи журнала хранятся событиями в общей истории площадки (taskId '__journal__'), поэтому у каждой
 * площадки свой журнал, а правки и удаления не теряются: запись — это свёртка своих событий.
 *   «Запись в журнале»         — новая запись (entryId, текст, время с–по);
 *   «Запись журнала изменена»  — новый текст/время, прошлый вариант остаётся в истории записи;
 *   «Запись журнала удалена»   — запись помечается удалённой, но видна зачёркнутой.
 * Окно журнала — ui-journal.js, тесты — tests/journal.test.js.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GrassJournal = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var TASK_ID = '__journal__';
  var ADD = 'Запись в журнале', EDIT = 'Запись журнала изменена', DEL = 'Запись журнала удалена';
  var MAX_TEXT = 4000;

  function time(v) { var m = /^(\d{2}):(\d{2})$/.exec(String(v || '')); return m && Number(m[1]) < 24 && Number(m[2]) < 60 ? m[0] : ''; }
  function when(h) { var d = new Date(h.at || h.when || ''); return isNaN(d) ? null : d; }

  // События журнала (новые сверху, как в истории) → записи, новые сверху.
  function fold(events) {
    var byId = new Map(), order = [];
    var list = (events || []).filter(function (h) { return h && h.taskId === TASK_ID && h.entryId; }).slice().reverse();
    list.forEach(function (h) {
      var e = byId.get(h.entryId);
      if (h.action === ADD) {
        if (e) return;               // повтор того же события — не дублируем
        e = { id: h.entryId, text: String(h.text || ''), from: time(h.from), to: time(h.to), author: h.author || '', shift: h.shift || '',
          shiftStart: h.shiftStart || '', at: when(h), edits: [], deleted: null };
        byId.set(h.entryId, e); order.push(e);
      } else if (!e) {
        return;                      // правка записи, которой нет (например, очищена) — пропускаем
      } else if (h.action === EDIT && !e.deleted) {
        e.edits.push({ at: when(h), author: h.author || '', text: e.text, from: e.from, to: e.to });
        e.text = String(h.text || ''); e.from = time(h.from); e.to = time(h.to);
      } else if (h.action === DEL && !e.deleted) {
        e.deleted = { at: when(h), author: h.author || '' };
      }
    });
    return order.reverse();
  }

  // Записи смены: сделанные в окне смены [start, end).
  function inWindow(entries, info) {
    if (!info || !info.start) return [];
    var s = new Date(info.start).getTime(), en = new Date(info.end).getTime();
    return (entries || []).filter(function (e) { var t = e.at ? e.at.getTime() : NaN; return t >= s && t < en; });
  }

  // Свою запись можно править и удалять только в ту же смену, в которой она сделана.
  function canEdit(entry, who, curWindow) {
    if (!entry || entry.deleted || !who || entry.author !== who || !curWindow || !curWindow.start) return false;
    var s = new Date(curWindow.start).getTime(), en = new Date(curWindow.end).getTime();
    if (entry.shiftStart) return new Date(entry.shiftStart).getTime() === s;
    var t = entry.at ? entry.at.getTime() : NaN;
    return t >= s && t < en;
  }

  // Поиск: текст (включая прошлые варианты), автор, смена.
  function matches(entry, q) {
    q = String(q || '').trim().toLowerCase();
    if (!q) return true;
    var hay = [entry.text, entry.author, 'смена ' + entry.shift].concat(entry.edits.map(function (x) { return x.text; })).join('\n').toLowerCase();
    return hay.indexOf(q) >= 0;
  }

  function cleanText(v) { return String(v || '').replace(/\r\n/g, '\n').trim().slice(0, MAX_TEXT); }
  // Время «с–по» необязательно; если указано только одно — сохраняем только его.
  function checkEntry(text, from, to) {
    if (!cleanText(text)) return 'Напишите, что записать в журнал.';
    if (from && !time(from)) return 'Время «с» — в виде чч:мм.';
    if (to && !time(to)) return 'Время «по» — в виде чч:мм.';
    return '';
  }
  function range(e) { return e.from && e.to ? e.from + '–' + e.to : e.from ? 'с ' + e.from : e.to ? 'до ' + e.to : ''; }

  return { TASK_ID: TASK_ID, ADD: ADD, EDIT: EDIT, DEL: DEL, MAX_TEXT: MAX_TEXT, fold: fold, inWindow: inWindow, canEdit: canEdit,
    matches: matches, cleanText: cleanText, checkEntry: checkEntry, range: range, time: time };
});
