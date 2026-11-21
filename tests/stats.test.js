'use strict';
// Юнит-тесты логики статистики и сводки смены: node --test tests/stats.test.js
// Часовой пояс задаётся снаружи (TZ=Europe/Volgograd), как на рабочих ПК.
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../stats.js');

const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi);
const iso = d => d.toISOString();
let seq = 0;
// Событие истории как в базе: новые сверху, поэтому db.history собираем через unshift.
const ev = (taskId, action, when, extra = {}) => ({ id: 'e' + (++seq), taskId, action, at: iso(when), when: iso(when), v: 17, ...extra });
const task = (id, extra = {}) => ({ id, text: 'Задача ' + id, status: 'В работе', priority: 'Обычный', author: 'Носиков А.Ю.', shift: 'A', date: iso(at(2026, 10, 20, 9)), ...extra });
const dbOf = (tasks, events, more = {}) => ({ tasks, history: events.slice().reverse(), archive: [], statsArchive: [], ...more });

test('дата из базы: ISO и старый формат «дд.мм, чч:мм»', () => {
  assert.equal(S.parseStoredDate('2026-10-21T05:30:00.000Z').getTime(), Date.parse('2026-10-21T05:30:00.000Z'));
  assert.deepEqual(S.parseStoredDate('21.10.2026, 08:40'), at(2026, 10, 21, 8, 40));
  assert.deepEqual(S.parseStoredDate('21.10, 08:40', at(2025, 3, 1)), at(2025, 10, 21, 8, 40));
  assert.equal(S.parseStoredDate(''), null);
  assert.equal(S.parseStoredDate('вчера'), null);
});

test('статус по событию: записанный, по стрелке, передача, приёмка', () => {
  assert.equal(S.eventStatusOf({ status: 'Выполнена' }), 'Выполнена');
  assert.equal(S.eventStatusOf({ action: 'Изменён статус', details: 'В работе → Не в работе' }), 'Не в работе');
  assert.equal(S.eventStatusOf({ action: 'Передана по смене' }), 'Передать по смене');
  assert.equal(S.eventStatusOf({ action: 'Задача принята' }), 'В работе');
  assert.equal(S.eventStatusOf({ action: 'Изменена задача' }), null);
  assert.equal(S.summaryStatusOf({ action: 'Изменена задача' }, { status: 'Выполнена' }), 'Выполнена');
});

test('выполнение: считается последний переход в «Выполнена», повтор без смены статуса не считается', () => {
  const ix = S.buildIndex(dbOf([], [
    ev('1', 'Создана задача', at(2026, 10, 20, 9), { status: 'В работе' }),
    ev('1', 'Изменён статус', at(2026, 10, 20, 10), { status: 'Выполнена', author: 'Егоров Е.В.' }),
    ev('1', 'Изменена задача', at(2026, 10, 20, 11), { status: 'Выполнена' }),
    ev('1', 'Изменён статус', at(2026, 10, 21, 9), { status: 'В работе' }),
    ev('1', 'Изменён статус', at(2026, 10, 21, 12), { status: 'Выполнена', author: 'Никулин О.В.' }),
  ]).history);
  const c = S.completionEvents(ix, '1');
  assert.deepEqual(c.map(x => x.author), ['Егоров Е.В.', 'Никулин О.В.']);
  assert.deepEqual(S.completedAtOf(ix, task('1')), at(2026, 10, 21, 12));
  // старая база без событий — по времени остановки срока
  assert.deepEqual(S.completedAtOf(new Map(), task('2', { status: 'Выполнена', deadlineStoppedAt: '21.10.2026, 07:00' })), at(2026, 10, 21, 7));
  assert.equal(S.completedAtOf(new Map(), task('3', { deadlineStoppedAt: '21.10.2026, 07:00' })), null);
});

test('события с одинаковым временем идут как в истории (новые сверху)', () => {
  const t = at(2026, 10, 20, 9);
  const db = dbOf([], [ev('1', 'Создана задача', t, { status: 'В работе' }), ev('1', 'Изменён статус', t, { status: 'Выполнена' })]);
  assert.deepEqual(S.buildIndex(db.history).get('1').map(e => e.h.action), ['Создана задача', 'Изменён статус']);
});

test('по дням: создано, выполнено и просрочено (выполнена позже срока или срок прошёл)', () => {
  const now = at(2026, 10, 22, 12);
  const db = dbOf([
    task('1', { date: iso(at(2026, 10, 20, 9)), deadline: '2026-10-20T15:00' }),
    task('2', { date: iso(at(2026, 10, 21, 9)), deadline: '2026-10-21T15:00', status: 'Выполнена' }),
    task('3', { date: iso(at(2026, 10, 21, 9)), deadline: '2026-10-23T15:00' }),
  ], [
    ev('2', 'Изменён статус', at(2026, 10, 21, 14), { status: 'Выполнена' }),
  ]);
  const rows = S.dailyCounts(db, S.buildIndex(db.history), at(2026, 10, 20), at(2026, 10, 22), now);
  assert.deepEqual(rows.map(r => [r.date.getDate(), r.created, r.completed, r.overdue]), [[20, 1, 0, 1], [21, 2, 1, 0], [22, 0, 0, 0]]);
});

test('состояние на момент: создана, выполнена, в архиве, восстановлена', () => {
  const db = dbOf([task('1')], [
    ev('1', 'Создана задача', at(2026, 10, 20, 9), { status: 'В работе' }),
    ev('1', 'Изменён статус', at(2026, 10, 20, 12), { status: 'Выполнена' }),
    ev('1', 'Задача автоматически перемещена в архив', at(2026, 10, 21, 9)),
    ev('1', 'Задача восстановлена', at(2026, 10, 22, 9)),
  ]);
  const ix = S.buildIndex(db.history), t = db.tasks[0];
  assert.equal(S.taskStateAt(ix, t, at(2026, 10, 20, 8)), null);
  assert.deepEqual(S.taskStateAt(ix, t, at(2026, 10, 20, 10)), { exists: true, active: true, status: 'В работе' });
  assert.deepEqual(S.taskStateAt(ix, t, at(2026, 10, 20, 13)), { exists: true, active: true, status: 'Выполнена' });
  assert.equal(S.taskStateAt(ix, t, at(2026, 10, 21, 10)).active, false);
  assert.deepEqual(S.taskStateAt(ix, t, at(2026, 10, 22, 10)), { exists: true, active: true, status: 'В работе' });
  assert.deepEqual(S.snapshotAt(db, ix, at(2026, 10, 21, 10)), { total: 1, done: 0, work: 0, archived: 1 });
});

test('задача без повторов: активная, архив и очищенный архив считаются один раз', () => {
  const db = dbOf([task('1')], [], { archive: [task('2'), task('1')], statsArchive: [task('3'), task('2')] });
  assert.deepEqual(S.taskPool(db).map(t => t.id).sort(), ['1', '2', '3']);
});

test('по технологам: действия из истории, просрочка на исполнителе, системные имена не считаются', () => {
  const now = at(2026, 10, 22, 12);
  const db = dbOf([
    task('1', { assignee: 'Егоров Е.В.', deadline: '2026-10-21T10:00' }),
    task('2', { status: 'Выполнена' }),
  ], [
    ev('1', 'Создана задача', at(2026, 10, 21, 9), { author: 'Носиков А.Ю.', status: 'В работе' }),
    ev('1', 'Передана по смене', at(2026, 10, 21, 20), { author: 'Носиков А.Ю.' }),
    ev('1', 'Задача принята', at(2026, 10, 21, 21), { author: 'Егоров Е.В.' }),
    ev('2', 'Создана задача', at(2026, 10, 21, 9), { author: 'Система', status: 'В работе' }),
    ev('2', 'Изменён статус', at(2026, 10, 21, 11), { author: 'Егоров Е.В.', status: 'Выполнена' }),
  ]);
  const rows = S.techTable(db, S.buildIndex(db.history), ['Носиков А.Ю.', 'Егоров Е.В.', 'Никулин О.В.'], at(2026, 10, 20), at(2026, 10, 22), now);
  const by = Object.fromEntries(rows.map(r => [r.name, r]));
  assert.deepEqual([by['Носиков А.Ю.'].created, by['Носиков А.Ю.'].passed, by['Носиков А.Ю.'].overdue], [1, 1, 0]);
  assert.deepEqual([by['Егоров Е.В.'].accepted, by['Егоров Е.В.'].completed, by['Егоров Е.В.'].overdue, by['Егоров Е.В.'].assigned], [1, 1, 1, 1]);
  assert.equal(by['Никулин О.В.'].created, 0);
  assert.ok(!by['Система']);
  assert.deepEqual(S.techOptions(db, ['Никулин О.В.', 'Автоматически']).sort(), ['Егоров Е.В.', 'Никулин О.В.', 'Носиков А.Ю.']);
});

test('сводка смены: последнее событие за смену, поздняя передача, чужие смены не попадают', () => {
  const info = { shift: 'A', start: at(2026, 10, 21, 8, 30), end: at(2026, 10, 21, 20, 30) };
  const db = dbOf([
    task('1', { status: 'В работе' }),
    task('2', { status: 'Передать по смене', toShift: 'C' }),
    task('3', { deadline: '2026-10-21T12:00' }),
    task('4'),
  ], [
    ev('1', 'Создана задача', at(2026, 10, 21, 9), { shift: 'A', status: 'В работе', text: 'Задача 1' }),
    ev('1', 'Изменён статус', at(2026, 10, 21, 10), { shift: 'A', status: 'Выполнена', comment: 'готово' }),
    ev('2', 'Передана по смене', at(2026, 10, 21, 20, 50), { shift: 'C', fromShift: 'A', toShift: 'C', status: 'Передать по смене' }),
    ev('3', 'Изменена задача', at(2026, 10, 21, 11), { shift: 'A', status: 'В работе' }),
    ev('4', 'Изменена задача', at(2026, 10, 21, 11), { shift: 'B', status: 'В работе' }),
    ev('__summary__', 'Ознакомлен', at(2026, 10, 21, 9), { shift: 'A' }),
    ev('__journal__', 'Запись в журнале', at(2026, 10, 21, 9, 30), { shift: 'A', entryId: 'j1', text: 'Остановка линии' }),
  ]);
  const r = S.shiftSummary(db, info, { lateMinutes: 60, skipTaskId: '__summary__' });
  const by = Object.fromEntries(r.rows.map(x => [x.id, x]));
  assert.deepEqual(Object.keys(by).sort(), ['1', '2', '3']);
  assert.equal(by['1'].statusThen, 'Выполнена');
  assert.equal(by['1'].nowStatus, 'В работе');
  assert.match(by['2'].action, /^передана смене C в 20:50/);
  assert.equal(by['3'].overdue, true);
  assert.deepEqual(r.stats, { done: 1, pass: 1, work: 1, off: 0, overdue: 1 });
  assert.deepEqual(r.notes, [{ task: 'Задача 1', comment: 'готово' }]);
  assert.deepEqual(S.shiftSummary(db, null).rows, []);
});

const Sh = require('../shifts.js');
test('сколько смен прошла задача: окна смен от создания до выполнения', () => {
  assert.equal(S.shiftsSpanned(at(2026, 10, 21, 9), at(2026, 10, 21, 12), Sh), 1);
  assert.equal(S.shiftsSpanned(at(2026, 10, 21, 9), at(2026, 10, 21, 21), Sh), 2);
  assert.equal(S.shiftsSpanned(at(2026, 10, 21, 9), at(2026, 10, 23, 9), Sh), 5);
  assert.equal(S.shiftsSpanned(null, at(2026, 10, 21, 9), Sh), 0);
});

test('скорость и сроки: среднее время, смены, доля в срок, по приоритетам', () => {
  const now = at(2026, 10, 23, 12);
  const db = dbOf([
    task('1', { createdAt: iso(at(2026, 10, 21, 9)), priority: 'Высокий', status: 'Выполнена', deadline: '2026-10-21T12:00' }),
    task('2', { createdAt: iso(at(2026, 10, 21, 9)), status: 'Выполнена', deadline: '2026-10-21T12:00' }),
    task('3', { createdAt: iso(at(2026, 10, 21, 9)), status: 'Выполнена' }),
    task('4', { createdAt: iso(at(2026, 10, 20, 9)), text: 'Висит', deadline: '2026-10-22T12:00' }),
    task('5', { createdAt: iso(at(2026, 10, 1, 9)), status: 'Выполнена' }),
  ], [
    ev('1', 'Изменён статус', at(2026, 10, 21, 11), { status: 'Выполнена' }),     // 2 ч, в срок
    ev('2', 'Изменён статус', at(2026, 10, 22, 9), { status: 'Выполнена' }),      // 24 ч, 3 смены, не в срок
    ev('3', 'Изменён статус', at(2026, 10, 21, 13), { status: 'Выполнена' }),     // 4 ч
    ev('5', 'Изменён статус', at(2026, 10, 2, 9), { status: 'Выполнена' }),       // вне периода
  ]);
  const q = S.qualityStats(db, S.buildIndex(db.history), at(2026, 10, 20), at(2026, 10, 23), now, Sh);
  assert.equal(q.completed, 3);
  assert.equal(q.avgHours, 10);
  assert.equal(q.medianHours, 4);
  assert.equal(q.avgShifts, round(5 / 3));
  assert.deepEqual([q.maxShifts.id, q.maxShifts.count], ['2', 3]);
  assert.deepEqual([q.withDeadline, q.onTime, q.onTimePct], [2, 1, 50]);
  assert.deepEqual([q.open, q.overdueNow, q.openLongest.text], [1, 1, 'Висит']);
  const hi = q.byPriority.find(r => r.priority === 'Высокий'), mid = q.byPriority.find(r => r.priority === 'Обычный');
  assert.deepEqual([hi.completed, hi.avgHours, hi.onTimePct], [1, 2, 100]);
  assert.deepEqual([mid.completed, mid.created, mid.onTimePct, mid.open], [2, 3, 0, 1]);
  assert.equal(q.byPriority.find(r => r.priority === 'Низкий').avgHours, null);
  // фильтр по технологу
  assert.equal(S.qualityStats(db, S.buildIndex(db.history), at(2026, 10, 20), at(2026, 10, 23), now, Sh, t => t.id === '1').completed, 1);
});
function round(x) { return Math.round(x * 10) / 10; }

// ---------- 1.7.7: периоды, бригада, списки задач за цифрами, строка «Всего» ----------

test('периоды: моя смена, сутки, неделя, месяц, прошлый месяц, всё время', () => {
  const now = at(2026, 10, 21, 22, 30);            // 21.10 ночь — смена C, днём работала A
  const db = dbOf([task('1', { date: iso(at(2026, 9, 3, 10)) })], []);
  const sh = S.periodRange(db, 'shift', now, { shifts: Sh, shift: 'C' });
  assert.deepEqual([sh.start, sh.end], [at(2026, 10, 21, 20, 30), now]);
  assert.match(sh.caption, /смену C · 21\.10 ночь/);
  assert.ok(sh.prevEnd < sh.start && Sh.windowAt(sh.prevStart).shift === 'C', 'предыдущая смена той же бригады');
  const a = S.periodRange(db, 'shift', now, { shifts: Sh, shift: 'A' });
  assert.deepEqual([a.start, a.end], [at(2026, 10, 21, 8, 30), new Date(at(2026, 10, 21, 20, 30).getTime() - 1)], 'смена уже закончилась — берём её целиком');
  const day = S.periodRange(db, 'day', now);
  assert.deepEqual([day.start, day.prevStart], [at(2026, 10, 21), at(2026, 10, 20)]);
  assert.deepEqual(S.periodRange(db, '7d', now).start, at(2026, 10, 15));
  const m = S.periodRange(db, '30d', now);
  assert.deepEqual([m.start, m.prevStart, m.prevEnd], [at(2026, 9, 22), at(2026, 8, 23), new Date(at(2026, 9, 22).getTime() - 1)]);
  const pm = S.periodRange(db, 'prevMonth', now);
  assert.deepEqual([pm.start, pm.end, pm.prevStart], [at(2026, 9, 1), new Date(at(2026, 10, 1).getTime() - 1), at(2026, 8, 1)]);
  assert.equal(pm.caption, 'за сентябрь 2026');
  assert.deepEqual(S.periodRange(db, 'all', now).start, at(2026, 9, 3));
  assert.deepEqual(S.periodRange(db, 'непонятно', now).key, 'all');
  assert.deepEqual(S.PERIODS.map(p => p[1]), ['Моя смена', 'Сутки', 'Неделя', 'Месяц', 'Прошлый месяц', 'Всё время']);
});

test('период считается до минуты: событие до начала смены в «Мою смену» не попадает', () => {
  const db = dbOf([
    task('1', { date: iso(at(2026, 10, 21, 19, 59)) }),
    task('2', { date: iso(at(2026, 10, 21, 20, 1)) }),
  ], []);
  const ix = S.buildIndex(db.history);
  const rows = S.dailyCounts(db, ix, at(2026, 10, 21, 20), at(2026, 10, 21, 23), at(2026, 10, 21, 23));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].created, 1);
  assert.deepEqual(rows[0].ids.created, ['2']);
});

test('бригада: события считаются только в её смены, задачи — по смене создания', () => {
  const N = 'Носиков А.Ю.', E = 'Егоров Е.В.';
  const t1 = task('1', { date: iso(at(2026, 10, 21, 10)), shift: 'A', deadline: iso(at(2026, 10, 21, 21)) });
  const t2 = task('2', { date: iso(at(2026, 10, 21, 21)), shift: 'C', author: E });
  const db = dbOf([t1, t2], [
    ev('1', 'Создана задача', at(2026, 10, 21, 10), { author: N, status: 'В работе' }),
    ev('2', 'Создана задача', at(2026, 10, 21, 21), { author: E, status: 'В работе' }),
    ev('1', 'Изменён статус', at(2026, 10, 21, 22), { author: E, status: 'Выполнена' }),
  ]);
  const ix = S.buildIndex(db.history), now = at(2026, 10, 22, 7);
  const whenA = S.brigadeWhen(Sh, 'A'), whenC = S.brigadeWhen(Sh, 'C');
  const day = (when) => S.dailyCounts(db, ix, at(2026, 10, 21), now, now, when && { when })[0];
  assert.deepEqual([day(null).created, day(null).completed, day(null).overdue], [2, 1, 1]);
  assert.deepEqual([day(whenA).created, day(whenA).completed, day(whenA).overdue], [1, 0, 0]);
  assert.deepEqual([day(whenC).created, day(whenC).completed, day(whenC).overdue], [1, 1, 1], 'выполнена и просрочена ночью — это смена C');
  assert.deepEqual(day(whenC).ids, { created: ['2'], completed: ['1'], overdue: ['1'] });
  const tbl = (when) => Object.fromEntries(S.techTable(db, ix, [N, E], at(2026, 10, 21), now, now, when && { when }).map(r => [r.name, r]));
  assert.deepEqual([tbl(whenA)[N].created, tbl(whenA)[E].created, tbl(whenA)[E].completed], [1, 0, 0]);
  assert.deepEqual([tbl(whenC)[N].created, tbl(whenC)[E].created, tbl(whenC)[E].completed], [0, 1, 1]);
  assert.deepEqual(tbl(whenC)[E].ids.completed, ['1']);
  assert.equal(S.brigadeOfTask(t2, Sh), 'C');
  assert.equal(S.brigadeOfTask({ date: iso(at(2026, 10, 21, 21)) }, Sh), 'C', 'старая задача без поля shift — по времени создания');
  const qA = S.qualityStats(db, ix, at(2026, 10, 21), now, now, Sh, null, whenA);
  const qC = S.qualityStats(db, ix, at(2026, 10, 21), now, now, Sh, null, whenC);
  assert.deepEqual([qA.created, qA.completed, qC.created, qC.completed], [1, 0, 1, 1]);
  assert.deepEqual(qC.ids.completed, ['1']);
  assert.deepEqual(qC.byPriority.find(r => r.priority === 'Обычный').ids.created, ['2']);
});

test('строка «Всего»: сумма по каждому столбцу, задачи без повторов', () => {
  const rows = [
    { name: 'А', created: 2, completed: 1, passed: 0, accepted: 0, returned: 0, overdue: 1, assigned: 1,
      ids: { created: ['1', '2'], completed: ['1'], passed: [], accepted: [], returned: [], overdue: ['2'], assigned: ['3'] } },
    { name: 'Б', created: 1, completed: 1, passed: 1, accepted: 0, returned: 0, overdue: 0, assigned: 0,
      ids: { created: ['4'], completed: ['1'], passed: ['4'], accepted: [], returned: [], overdue: [], assigned: [] } },
  ];
  const t = S.techTotals(rows);
  assert.deepEqual([t.name, t.created, t.completed, t.passed, t.overdue, t.assigned], ['Всего', 3, 2, 1, 1, 1]);
  assert.deepEqual(t.ids.created, ['1', '2', '4']);
  assert.deepEqual(t.ids.completed, ['1'], 'одна задача, выполненная дважды разными людьми, в списке один раз');
  assert.deepEqual(S.techTotals([]).created, 0);
});

test('скорость и сроки по бригаде: «открыто сейчас» — только задачи бригады', () => {
  const db = dbOf([task('1', { shift: 'A' }), task('2', { shift: 'C' })], []);
  const ix = S.buildIndex(db.history), now = at(2026, 10, 22, 7);
  const q = S.qualityStats(db, ix, at(2026, 10, 15), now, now, Sh, null, S.brigadeWhen(Sh, 'C'), t => S.brigadeOfTask(t, Sh) === 'C');
  assert.deepEqual([q.open, q.ids.open], [1, ['2']]);
});
