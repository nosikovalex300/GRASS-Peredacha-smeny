'use strict';
// Юнит-тесты расписаний регламента: node --test tests/reglament.test.js
// Часовой пояс задаётся снаружи (TZ=Europe/Volgograd), как на рабочих ПК.
// Смены в октябре 2026: днём 20.10 и 21.10 — A, 22–23 — D, 24–25 — B, 26–27 — C; ночью 21–22 — C, 23–24 — A, 25–26 — D.
const test = require('node:test');
const assert = require('node:assert/strict');
const Sh = require('../shifts.js');
const R = require('../reglament.js');

const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi);
const tpl = rule => ({ id: 'abc123', title: 'Отбор проб', rule });
const due = (rule, when) => R.dueOccurrence(tpl(rule), when, Sh);
// Где за период правило создаёт задачи: проходим каждые 30 минут и собираем разные метки.
function keys(rule, from, to) {
  const out = [];
  for (let t = from.getTime(); t < to.getTime(); t += 30 * 60000) {
    const o = due(rule, new Date(t)); if (o && !out.includes(o.key)) out.push(o.key);
  }
  return out;
}

test('каждую смену: одна задача на смену, метка — начало смены', () => {
  const o = due({ kind: 'shift' }, at(2026, 10, 21, 15));
  assert.equal(o.key, '202610210830');
  assert.equal(o.taskId, 'reg-abc123-202610210830');
  assert.equal(due({ kind: 'shift' }, at(2026, 10, 22, 3)).key, '202610212030');
  assert.equal(keys({ kind: 'shift' }, at(2026, 10, 21, 8, 30), at(2026, 10, 23, 8, 30)).length, 4);
});

test('только дневные / только ночные / нужная бригада', () => {
  assert.equal(due({ kind: 'shift', mode: 'day' }, at(2026, 10, 22, 3)), null);
  assert.ok(due({ kind: 'shift', mode: 'night' }, at(2026, 10, 22, 3)));
  assert.deepEqual(keys({ kind: 'shift', brigades: ['A'] }, at(2026, 10, 20, 8, 30), at(2026, 10, 25, 8, 30)),
    ['202610200830', '202610210830', '202610232030', '202610242030']);
  assert.deepEqual(keys({ kind: 'shift', brigades: ['A'], mode: 'night' }, at(2026, 10, 20, 8, 30), at(2026, 10, 25, 8, 30)),
    ['202610232030', '202610242030']);
});

test('каждые N часов внутри смены: метки по сетке от начала смены, в прошлое не уходит', () => {
  assert.deepEqual(keys({ kind: 'hours', n: 4, mode: 'day' }, at(2026, 10, 21, 8, 30), at(2026, 10, 21, 20, 30)),
    ['202610210830', '202610211230', '202610211630']);
  // программу открыли в 15:00 — создаётся только повтор 12:30, а не пропущенный 08:30
  assert.equal(due({ kind: 'hours', n: 4 }, at(2026, 10, 21, 15)).key, '202610211230');
});

test('каждая N-я смена от даты отсчёта (всех или одной бригады)', () => {
  assert.deepEqual(keys({ kind: 'nthShift', n: 3, anchor: '2026-10-20' }, at(2026, 10, 20, 8, 30), at(2026, 10, 23, 8, 30)),
    ['202610200830', '202610212030']);
  assert.deepEqual(keys({ kind: 'nthShift', n: 2, brigades: ['A'], anchor: '2026-10-19' }, at(2026, 10, 19, 8, 30), at(2026, 10, 30, 8, 30)),
    ['202610200830', '202610232030', '202610280830']);
  assert.equal(due({ kind: 'nthShift', n: 2, anchor: '2026-11-01' }, at(2026, 10, 21, 10)), null, 'до даты отсчёта не создаётся');
});

test('по дням недели, раз в N дней, раз в N недель, по числам месяца', () => {
  // 21.10.2026 — среда
  assert.ok(due({ kind: 'weekdays', days: [3] }, at(2026, 10, 21, 10)));
  assert.equal(due({ kind: 'weekdays', days: [3] }, at(2026, 10, 21, 22)), null, 'по умолчанию — дневная смена');
  assert.ok(due({ kind: 'weekdays', days: [3], mode: 'night' }, at(2026, 10, 21, 22)));
  assert.deepEqual(keys({ kind: 'everyNDays', n: 3, anchor: '2026-10-20' }, at(2026, 10, 19), at(2026, 10, 27)),
    ['202610200830', '202610230830', '202610260830']);
  assert.deepEqual(keys({ kind: 'everyNWeeks', n: 2, days: [1, 5], anchor: '2026-10-19' }, at(2026, 10, 19), at(2026, 11, 7)),
    ['202610190830', '202610230830', '202611020830', '202611060830']);
  assert.deepEqual(keys({ kind: 'monthDays', monthDays: [1, 32] }, at(2026, 10, 30), at(2026, 11, 3)),
    ['202610310830', '202611010830']);
  assert.ok(due({ kind: 'monthDays', monthDays: [32] }, at(2026, 2, 28, 10)), 'последнее число февраля');
});

test('на паузе, без названия и «только шаблон» — задачи не создаются', () => {
  assert.equal(R.dueOccurrence({ ...tpl({ kind: 'shift' }), paused: true }, at(2026, 10, 21, 10), Sh), null);
  assert.equal(R.dueOccurrence({ id: 'abc123', title: ' ', rule: { kind: 'shift' } }, at(2026, 10, 21, 10), Sh), null);
  assert.equal(due({ kind: 'none' }, at(2026, 10, 21, 10)), null);
});

test('срок: через N часов от момента повтора', () => {
  const o = R.dueOccurrence({ ...tpl({ kind: 'shift' }), deadlineHours: 3 }, at(2026, 10, 21, 10), Sh);
  assert.deepEqual(o.deadline, at(2026, 10, 21, 11, 30));
  assert.equal(due({ kind: 'shift' }, at(2026, 10, 21, 10)).deadline, null);
});

test('шаблон приводится в порядок: неверные значения — к умолчаниям', () => {
  const t = R.normalize({ id: 'BAD ID', title: 'x', priority: 'Срочно', deadlineHours: -5, rule: { kind: 'что-то', n: 0, brigades: ['A', 'Z'], days: [9, 2, 2], monthDays: [0, 15] } });
  assert.equal(t.id, '');
  assert.equal(t.priority, 'Обычный');
  assert.equal(t.deadlineHours, 0);
  assert.deepEqual(t.rule, { kind: 'none', n: 1, mode: 'any', brigades: ['A'], days: [2], monthDays: [15], anchor: '' });
});

test('описание расписания словами и ближайшие повторы', () => {
  assert.equal(R.describe(tpl({ kind: 'shift', mode: 'day', brigades: ['A'] })), 'каждую дневную смену бригады A');
  assert.equal(R.describe(tpl({ kind: 'weekdays', days: [1, 4] })), 'по Пн, Чт (дневная смена)');
  assert.equal(R.describe(tpl({ kind: 'hours', n: 2 })), 'каждые 2 ч в смену');
  const next = R.upcoming(tpl({ kind: 'shift', brigades: ['D'] }), at(2026, 10, 21, 10), Sh, 2);
  assert.deepEqual(next.map(x => [x.at.getDate(), x.at.getHours(), x.shift]), [[22, 8, 'D'], [23, 8, 'D']]);
});
