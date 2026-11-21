'use strict';
// Юнит-тесты журнала смены: node --test tests/journal.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const J = require('../journal.js');

const at = (d, h, mi = 0) => new Date(2026, 9, d, h, mi).toISOString();
// История как в базе: новые сверху.
const hist = (...evs) => evs.slice().reverse();
const add = (id, text, when, extra = {}) => ({ taskId: J.TASK_ID, action: J.ADD, entryId: id, text, at: when, author: 'Носиков А.Ю.', shift: 'A', shiftStart: at(21, 8, 30), ...extra });
const edit = (id, text, when, extra = {}) => ({ taskId: J.TASK_ID, action: J.EDIT, entryId: id, text, at: when, author: 'Носиков А.Ю.', ...extra });
const del = (id, when) => ({ taskId: J.TASK_ID, action: J.DEL, entryId: id, at: when, author: 'Носиков А.Ю.' });
const day = { start: new Date(2026, 9, 21, 8, 30), end: new Date(2026, 9, 21, 20, 30) };
const night = { start: new Date(2026, 9, 21, 20, 30), end: new Date(2026, 9, 22, 8, 30) };

test('свёртка: новые сверху, правка хранит прошлый вариант, удалённая остаётся с пометкой', () => {
  const e = J.fold(hist(
    add('a', 'Остановка линии 2', at(21, 9), { from: '09:00', to: '09:40' }),
    add('b', 'Пришла цистерна', at(21, 10)),
    edit('a', 'Остановка линии 2 — замена ножа', at(21, 11), { from: '09:00', to: '09:50' }),
    del('b', at(21, 12)),
    { taskId: '1', action: 'Создана задача', at: at(21, 9) },
  ));
  assert.deepEqual(e.map(x => x.id), ['b', 'a']);
  const a = e[1];
  assert.equal(a.text, 'Остановка линии 2 — замена ножа');
  assert.equal(J.range(a), '09:00–09:50');
  assert.deepEqual(a.edits.map(x => [x.text, x.to]), [['Остановка линии 2', '09:40']]);
  assert.ok(e[0].deleted && e[0].text === 'Пришла цистерна');
});

test('повторные и чужие события не ломают журнал', () => {
  const e = J.fold(hist(
    add('a', 'Раз', at(21, 9)), add('a', 'Дубль', at(21, 9, 1)),
    edit('zz', 'нет такой записи', at(21, 10)),
    del('a', at(21, 11)), edit('a', 'после удаления', at(21, 12)), del('a', at(21, 13)),
  ));
  assert.equal(e.length, 1);
  assert.equal(e[0].text, 'Раз');
  assert.equal(e[0].deleted.at.toISOString(), at(21, 11));
  assert.deepEqual(J.fold(null), []);
});

test('записи смены — по времени записи в окне смены', () => {
  const e = J.fold(hist(add('a', 'днём', at(21, 9)), add('b', 'ночью', at(21, 22)), add('c', 'ровно 20:30', at(21, 20, 30))));
  assert.deepEqual(J.inWindow(e, day).map(x => x.id), ['a']);
  assert.deepEqual(J.inWindow(e, night).map(x => x.id).sort(), ['b', 'c']);
  assert.deepEqual(J.inWindow(e, null), []);
});

test('править можно только своё и только в свою смену', () => {
  const [mine] = J.fold(hist(add('a', 'моё', at(21, 9))));
  assert.equal(J.canEdit(mine, 'Носиков А.Ю.', day), true);
  assert.equal(J.canEdit(mine, 'Егоров Е.В.', day), false);
  assert.equal(J.canEdit(mine, 'Носиков А.Ю.', night), false);
  const [old] = J.fold(hist(add('b', 'без отметки смены', at(21, 9), { shiftStart: '' })));
  assert.equal(J.canEdit(old, 'Носиков А.Ю.', day), true);
  assert.equal(J.canEdit(old, 'Носиков А.Ю.', night), false);
  const [gone] = J.fold(hist(add('c', 'x', at(21, 9)), del('c', at(21, 10))));
  assert.equal(J.canEdit(gone, 'Носиков А.Ю.', day), false);
});

test('поиск по тексту, прошлым вариантам, автору; проверка ввода', () => {
  const [a] = J.fold(hist(add('a', 'Ремонт насоса', at(21, 9)), edit('a', 'Насос заменён', at(21, 10))));
  assert.ok(J.matches(a, 'РЕМОНТ'));
  assert.ok(J.matches(a, 'носиков'));
  assert.ok(J.matches(a, 'смена a'));
  assert.ok(!J.matches(a, 'цистерна'));
  assert.equal(J.checkEntry('  ', '', ''), 'Напишите, что записать в журнал.');
  assert.match(J.checkEntry('x', '25:00', ''), /«с»/);
  assert.equal(J.checkEntry('x', '08:00', ''), '');
  assert.equal(J.range({ from: '08:00', to: '' }), 'с 08:00');
});
