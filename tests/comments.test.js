'use strict';
// Юнит-тесты ленты комментариев: node --test tests/comments.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../comments.js');

const hist = (...evs) => evs.slice().reverse();     // в истории новые сверху
const ev = (comment, author, at) => ({ action: 'Изменена задача', comment, author, shift: 'A', at });

test('старая задача без ленты: нынешний комментарий — первая запись, автор из истории', () => {
  const t = { comment: 'давление 4 бар', author: 'Носиков А.Ю.', shift: 'A', date: '2026-10-20T06:00:00.000Z' };
  const h = hist(ev('', 'Носиков А.Ю.', '2026-10-20T06:00:00.000Z'), ev('давление 4 бар', 'Егоров Е.В.', '2026-10-20T07:00:00.000Z'),
    ev('давление 4 бар', 'Никулин О.В.', '2026-10-20T08:00:00.000Z'));
  assert.deepEqual(C.feedOf(t, h), [{ text: 'давление 4 бар', author: 'Егоров Е.В.', shift: 'A', at: '2026-10-20T07:00:00.000Z' }]);
  assert.deepEqual(C.feedOf({ comment: 'без истории', author: 'Носиков А.Ю.', shift: 'B', date: 'd' }, []), [{ text: 'без истории', author: 'Носиков А.Ю.', shift: 'B', at: 'd' }]);
  assert.deepEqual(C.feedOf({ comment: '' }, []), []);
  assert.deepEqual(C.feedOf(null), []);
});

test('новый комментарий добавляется, старый остаётся; пустой и повтор — без изменений', () => {
  const t = { comment: 'первый', author: 'Носиков А.Ю.', shift: 'A', date: 'd0' };
  const who = { author: 'Егоров Е.В.', shift: 'C', at: 'd1' };
  const feed = C.append(t, '  второй ', who, []);
  assert.deepEqual(feed.map(c => [c.text, c.author]), [['первый', 'Носиков А.Ю.'], ['второй', 'Егоров Е.В.']]);
  const t2 = { ...t, comment: 'второй', comments: feed };
  assert.equal(C.append(t2, '', who, []), null);
  assert.equal(C.append(t2, 'второй', who, []), null);
  assert.deepEqual(C.feedOf(t2, []).map(c => c.text), ['первый', 'второй']);
  assert.equal(C.searchText(t2), 'первый\nвторой');
});

test('правка в старой версии программы мимо ленты не теряется; лента ограничена', () => {
  const t = { comment: 'из старой версии', comments: [{ text: 'первый', author: 'x', at: 'a' }] };
  assert.deepEqual(C.feedOf(t, hist(ev('из старой версии', 'Егоров Е.В.', 'b'))).map(c => [c.text, c.author]),
    [['первый', 'x'], ['из старой версии', 'Егоров Е.В.']]);
  const many = { comment: 'c0', comments: [{ text: 'c0' }] };
  let cur = many;
  for (let i = 1; i <= C.MAX + 5; i++) { const f = C.append(cur, 'c' + i, { author: 'a' }, []); cur = { comment: 'c' + i, comments: f }; }
  assert.equal(cur.comments.length, C.MAX);
  assert.equal(cur.comments[C.MAX - 1].text, 'c' + (C.MAX + 5));
});
