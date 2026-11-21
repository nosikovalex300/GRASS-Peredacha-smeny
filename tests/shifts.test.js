'use strict';
// Юнит-тесты логики смен: node --test tests/shifts.test.js
// Важно: часовой пояс задаётся снаружи (TZ=Europe/Volgograd), как на рабочих ПК.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const S = require('../shifts.js');

const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi);

test('в каждом окне (день/ночь) работает ровно одна смена — 2 года вперёд', () => {
  for (let i = 0; i < 730; i++) {
    const d = at(2026, 9, 1); d.setDate(d.getDate() + i);
    const day = S.LETTERS.filter(s => S.stateOnDate(d, s) === 'День');
    const night = S.LETTERS.filter(s => S.stateOnDate(d, s) === 'Ночь');
    assert.equal(day.length, 1, `${d.toDateString()} день: ${day}`);
    assert.equal(night.length, 1, `${d.toDateString()} ночь: ${night}`);
  }
});

test('график тот же, что в 1.6.1: сверка каждые 30 минут на год вперёд', (t) => {
  // Берём функции графика прямо из index.html версии 1.6.1 (путь — в GRASS_BASE161_INDEX)
  const base = process.env.GRASS_BASE161_INDEX;
  if (!base || !fs.existsSync(base)) { t.skip('нет index.html 1.6.1 для сверки'); return; }
  const html = fs.readFileSync(base, 'utf8');
  const from = html.indexOf('const SHIFT_CYCLE=');
  const to = html.indexOf('function nextShift(');
  const old = new Function(html.slice(from, to) + '; return {shiftStateOnDate, activeShiftAt};')();
  let checked = 0;
  for (let m = 0; m < 365 * 48; m++) {
    const t = new Date(at(2026, 9, 1).getTime() + m * 30 * 60000 + 7 * 60000);
    assert.equal(S.activeShift(t), old.activeShiftAt(t), t.toString());
    checked++;
  }
  assert.ok(checked > 17000);
});

test('границы смен 08:30 и 20:30, ночь через полночь принадлежит дню начала', () => {
  // 21.10: день A, ночь C; 22.10: день D
  assert.equal(S.activeShift(at(2026, 10, 21, 8, 29)), S.windowAt(at(2026, 10, 20, 22)).shift);
  assert.equal(S.activeShift(at(2026, 10, 21, 8, 30)), 'A');
  assert.equal(S.activeShift(at(2026, 10, 21, 20, 29)), 'A');
  assert.equal(S.activeShift(at(2026, 10, 21, 20, 30)), 'C');
  assert.equal(S.activeShift(at(2026, 10, 22, 0, 10)), 'C');
  assert.equal(S.activeShift(at(2026, 10, 22, 8, 29)), 'C');
  assert.equal(S.activeShift(at(2026, 10, 22, 8, 30)), 'D');
  const w = S.windowAt(at(2026, 10, 22, 3, 0));
  assert.equal(w.mode, 'Ночь');
  assert.equal(w.start.getTime(), at(2026, 10, 21, 20, 30).getTime());
  assert.equal(w.end.getTime(), at(2026, 10, 22, 8, 30).getTime());
});

test('время смены — по режиму, а не по букве', () => {
  assert.equal(S.label(S.windowAt(at(2026, 10, 21, 22))), 'Смена C · Ночь · 20:30–08:30');
  assert.equal(S.label(S.windowAt(at(2026, 10, 22, 10))), 'Смена D · День · 08:30–20:30');
  assert.equal(S.label(S.windowAt(at(2026, 10, 23, 22))), 'Смена A · Ночь · 20:30–08:30');
  assert.equal(S.label(S.windowAt(at(2026, 10, 21, 10))), 'Смена A · День · 08:30–20:30');
});

test('предыдущая смена — ровно одна, вплотную к текущей', () => {
  for (let m = 0; m < 30 * 24 * 2; m++) {
    const t = new Date(at(2026, 10, 1).getTime() + m * 30 * 60000 + 60000);
    const cur = S.windowAt(t), prev = S.previousWindow(t), next = S.nextWindow(t);
    assert.equal(prev.end.getTime(), cur.start.getTime());
    assert.equal(next.start.getTime(), cur.end.getTime());
    assert.notEqual(prev.mode, cur.mode);
  }
  const p = S.previousWindow(at(2026, 10, 22, 9));
  assert.equal(p.shift, 'C'); assert.equal(p.mode, 'Ночь');
});

test('получатель: цепочка день → ночь → день → ночь', () => {
  assert.equal(S.recipient('A', at(2026, 10, 21, 10)), 'C');   // день A → ночь C
  assert.equal(S.recipient('C', at(2026, 10, 22, 7)), 'D');    // ночь C → день D
  assert.equal(S.recipient('D', at(2026, 10, 22, 19)), 'C');   // день D → ночь C
  assert.equal(S.recipient('C', at(2026, 10, 23, 7)), 'D');    // ночь C → день D (23.10)
});

test('получатель: передаёт смена, которая уже закончила → получает текущая', () => {
  assert.equal(S.recipient('A', at(2026, 10, 21, 20, 40)), 'C');
});

test('кто передаёт: поздняя передача уходящей смены в первый час', () => {
  // задача у A, 20:40, приложение уже переключилось на C
  assert.equal(S.senderShift('C', 'A', at(2026, 10, 21, 20, 40)), 'A');
  // спустя 2 часа — это уже действие ночной смены
  assert.equal(S.senderShift('C', 'A', at(2026, 10, 21, 22, 40)), 'C');
  // задача у самой текущей смены
  assert.equal(S.senderShift('C', 'C', at(2026, 10, 21, 20, 40)), 'C');
  // задача у давно ушедшей смены (не предыдущей) — передаёт текущая
  assert.equal(S.senderShift('C', 'B', at(2026, 10, 21, 20, 40)), 'C');
});

test('цепочка никогда не уходит самой себе — 60 дней, каждые 30 минут', () => {
  for (let m = 0; m < 60 * 48; m++) {
    const t = new Date(at(2026, 10, 1).getTime() + m * 30 * 60000 + 5 * 60000);
    const cur = S.activeShift(t);
    const r = S.recipient(cur, t);
    assert.ok(r && r !== cur, `${t}: ${cur} → ${r}`);
    assert.equal(r, S.nextWindow(t).shift, `${t}: получатель не следующая смена`);
  }
});

// ---------- 1.7.6 (п. 29): свой график ----------
test('график по умолчанию совпадает с прежним (A с 02.09.2026, порядок A D B C, 08:30)', () => {
  const before = { ...S.PHASE };
  assert.deepEqual(S.configure(null), S.DEFAULT_SCHEDULE);
  assert.deepEqual({ ...S.PHASE }, before);
  assert.deepEqual(S.configure(S.DEFAULT_SCHEDULE), S.DEFAULT_SCHEDULE);
  assert.deepEqual({ ...S.PHASE }, before);
});

test('свой график: время начала, порядок бригад и дата отсчёта', (t) => {
  t.after(() => S.configure(null));
  S.configure({ dayStart: '08:00', order: ['B', 'C', 'A', 'D'], anchor: '2026-10-21' });
  assert.deepEqual(S.times('День'), ['08:00', '20:00']);
  assert.deepEqual(S.times('Ночь'), ['20:00', '08:00']);
  const w = S.windowAt(new Date(2026, 9, 21, 9));
  assert.equal(w.shift, 'B'); assert.equal(w.start.getHours(), 8); assert.equal(w.start.getMinutes(), 0);
  assert.equal(S.windowAt(new Date(2026, 9, 21, 7, 59)).mode, 'Ночь');
  assert.equal(S.windowAt(new Date(2026, 9, 23, 9)).shift, 'C');
  assert.equal(S.windowAt(new Date(2026, 9, 25, 9)).shift, 'A');
  assert.equal(S.windowAt(new Date(2026, 9, 27, 9)).shift, 'D');
  assert.equal(S.label(w), 'Смена B · День · 08:00–20:00');
  // каждое окно — ровно одна смена, год вперёд
  for (let h = 0; h < 365 * 24; h += 6) {
    const at = new Date(2026, 9, 1, 3 + h);
    const x = S.windowAt(at);
    assert.equal(S.LETTERS.filter(l => S.stateOnDate(x.start, l) === x.mode).length, 1, at.toString());
  }
});

test('неверный график не ставится; превью не меняет текущий', () => {
  assert.match(S.validate({ dayStart: '13:00', order: ['A', 'B', 'C', 'D'], anchor: '2026-10-01' }), /04:00/);
  assert.match(S.validate({ dayStart: '08:30', order: ['A', 'A', 'C', 'D'], anchor: '2026-10-01' }), /каждая один раз/);
  assert.match(S.validate({ dayStart: '08:30', order: ['A', 'B', 'C', 'D'], anchor: '2026-02-30' }), /дату отсчёта/);
  assert.equal(S.validate(S.DEFAULT_SCHEDULE), '');
  assert.deepEqual(S.configure({ dayStart: 'утро' }), S.DEFAULT_SCHEDULE);
  const p = S.preview({ dayStart: '07:00', order: ['D', 'A', 'B', 'C'], anchor: '2026-10-21' }, new Date(2026, 9, 21, 15));
  assert.deepEqual(p.map(x => [x.date.getDate(), x.day, x.night]), [[21, 'D', 'B'], [22, 'D', 'C']]);
  assert.deepEqual(p[0].dayTimes, ['07:00', '19:00']);
  assert.deepEqual(S.current(), S.DEFAULT_SCHEDULE);
  assert.equal(S.windowAt(new Date(2026, 9, 21, 9)).shift, 'A');
});
