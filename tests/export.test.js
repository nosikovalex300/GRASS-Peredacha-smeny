'use strict';
// Юнит-тесты выгрузки: node --test tests/export.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const E = require('../export.js');

// Разбор zip без сторонних библиотек: по центральному каталогу.
function unzip(buf) {
  buf = Buffer.from(buf);
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(eocd + 10), cdOff = buf.readUInt32LE(eocd + 16);
  const out = {};
  let p = cdOff;
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const flags = buf.readUInt16LE(p + 8), crc = buf.readUInt32LE(p + 16), size = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), off = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString('utf8');
    assert.equal(flags & 0x800, 0x800, 'имя в UTF-8');
    const lnlen = buf.readUInt16LE(off + 26);
    const data = buf.slice(off + 30 + lnlen, off + 30 + lnlen + size);
    assert.equal(zlib.crc32(data), crc, 'CRC ' + name);
    out[name] = data.toString('utf8');
    p += 46 + nlen;
  }
  return out;
}

test('CRC32 совпадает с эталоном', () => {
  assert.equal(E.crc32(new TextEncoder().encode('123456789')), 0xCBF43926);
  assert.equal(E.crc32(new Uint8Array(0)), 0);
});

test('zip: файлы, русские имена, правильные CRC', () => {
  const z = unzip(E.zip([{ name: 'а.txt', data: 'привет' }, { name: 'b/c.xml', data: '<x/>' }]));
  assert.deepEqual(z, { 'а.txt': 'привет', 'b/c.xml': '<x/>' });
});

test('xlsx: листы, жирная шапка, числа числами, спецсимволы экранированы', () => {
  const z = unzip(E.xlsx([
    { name: 'Сводка: смена A', rows: [['Задача', 'Кол-во'], ['Насос <Н-3> & "линия"', 3], ['', null]] },
    { name: 'Сводка: смена A', rows: [['x']] },
  ]));
  assert.ok(z['[Content_Types].xml'].includes('/xl/worksheets/sheet2.xml'));
  assert.match(z['xl/workbook.xml'], /name="Сводка  смена A"/);
  assert.match(z['xl/workbook.xml'], /name="Сводка  смена A 2"/);
  const s1 = z['xl/worksheets/sheet1.xml'];
  assert.match(s1, /<c r="A1" s="1" t="inlineStr"><is><t xml:space="preserve">Задача<\/t>/);
  assert.match(s1, /<c r="B2"><v>3<\/v><\/c>/);
  assert.match(s1, /Насос &lt;Н-3&gt; &amp; &quot;линия&quot;/);
  assert.ok(z['xl/styles.xml'].includes('<b/>'));
  assert.equal(E.colName(0), 'A'); assert.equal(E.colName(25), 'Z'); assert.equal(E.colName(26), 'AA');
});

test('страница для PDF и имя файла', () => {
  const h = E.printHtml('Сводка <смены>', 'Ахтуба', [{ name: 'Задачи', rows: [['Задача', 'Статус'], ['a<b', 'В работе']] }, { name: 'Журнал', rows: [['Время']] }]);
  assert.match(h, /<h1>Сводка &lt;смены&gt;<\/h1>/);
  assert.match(h, /<th>Задача<\/th><th>Статус<\/th>/);
  assert.match(h, /<td>a&lt;b<\/td>/);
  assert.match(h, /<h2>Журнал<\/h2><p class="empty">Нет данных<\/p>/);
  assert.equal(E.fileName('Сводка: смена A / 21.10?'), 'Сводка смена A 21.10');
});
