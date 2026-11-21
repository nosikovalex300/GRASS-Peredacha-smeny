/*
 * GRASS — Передача смены · выгрузка в Excel (.xlsx) и PDF (1.7.6, п. 27 плана)
 *
 * Без сторонних библиотек: .xlsx — это zip-архив с XML-файлами, пишем его сами (без сжатия, CRC32,
 * имена в UTF-8). PDF печатает сама программа (main.js → printToPDF) из HTML, который собирается здесь.
 * Таблица: { name, rows: [[ячейка, …], …], header: true } — первая строка жирная. Ячейка — строка или число.
 * Тесты — tests/export.test.js.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GrassExport = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var CRC_TABLE = (function () {
    var t = new Array(256);
    for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function utf8(s) { return new TextEncoder().encode(String(s)); }

  // Zip без сжатия (store). Имена файлов — UTF-8 (флаг 0x800).
  function zip(files) {
    var parts = [], central = [], offset = 0;
    var u16 = function (a, v) { a.push(v & 0xFF, (v >>> 8) & 0xFF); };
    var u32 = function (a, v) { a.push(v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF); };
    var DOS_TIME = 0, DOS_DATE = (2026 - 1980) << 9 | 1 << 5 | 1;
    files.forEach(function (f) {
      var name = utf8(f.name), data = f.data instanceof Uint8Array ? f.data : utf8(f.data), crc = crc32(data);
      var h = [];
      u32(h, 0x04034b50); u16(h, 20); u16(h, 0x800); u16(h, 0); u16(h, DOS_TIME); u16(h, DOS_DATE);
      u32(h, crc); u32(h, data.length); u32(h, data.length); u16(h, name.length); u16(h, 0);
      parts.push(Uint8Array.from(h), name, data);
      var c = [];
      u32(c, 0x02014b50); u16(c, 20); u16(c, 20); u16(c, 0x800); u16(c, 0); u16(c, DOS_TIME); u16(c, DOS_DATE);
      u32(c, crc); u32(c, data.length); u32(c, data.length); u16(c, name.length); u16(c, 0); u16(c, 0); u16(c, 0); u16(c, 0);
      u32(c, 0); u32(c, offset);
      central.push(Uint8Array.from(c), name);
      offset += h.length + name.length + data.length;
    });
    var cdSize = central.reduce(function (a, b) { return a + b.length; }, 0), e = [];
    u32(e, 0x06054b50); u16(e, 0); u16(e, 0); u16(e, files.length); u16(e, files.length); u32(e, cdSize); u32(e, offset); u16(e, 0);
    var all = parts.concat(central, [Uint8Array.from(e)]), total = all.reduce(function (a, b) { return a + b.length; }, 0);
    var out = new Uint8Array(total), pos = 0;
    all.forEach(function (b) { out.set(b, pos); pos += b.length; });
    return out;
  }

  function xmlEsc(s) {
    return String(s == null ? '' : s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function colName(i) { var s = ''; i++; while (i > 0) { var m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }
  function sheetName(n, used) {
    var base = String(n || 'Лист').replace(/[\[\]:*?\/\\]/g, ' ').trim().slice(0, 31) || 'Лист', name = base, k = 2;
    while (used.indexOf(name.toLowerCase()) >= 0) name = base.slice(0, 28) + ' ' + (k++);
    used.push(name.toLowerCase());
    return name;
  }
  function sheetXml(t) {
    var rows = t.rows || [], widths = [];
    rows.forEach(function (r) { r.forEach(function (v, i) { widths[i] = Math.max(widths[i] || 8, Math.min(60, String(v == null ? '' : v).length + 2)); }); });
    var cols = widths.length ? '<cols>' + widths.map(function (w, i) { return '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>'; }).join('') + '</cols>' : '';
    var body = rows.map(function (r, ri) {
      var style = t.header !== false && ri === 0 ? ' s="1"' : '';
      return '<row r="' + (ri + 1) + '">' + r.map(function (v, ci) {
        var ref = colName(ci) + (ri + 1);
        if (typeof v === 'number' && isFinite(v)) return '<c r="' + ref + '"' + style + '><v>' + v + '</v></c>';
        if (v == null || v === '') return '';
        return '<c r="' + ref + '"' + style + ' t="inlineStr"><is><t xml:space="preserve">' + xmlEsc(v) + '</t></is></c>';
      }).join('') + '</row>';
    }).join('');
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      (t.header !== false && rows.length ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' : '') +
      cols + '<sheetData>' + body + '</sheetData></worksheet>';
  }
  // Книга Excel из нескольких таблиц (каждая — свой лист).
  function xlsx(tables) {
    var used = [], names = tables.map(function (t) { return sheetName(t.name, used); });
    var files = [
      { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        names.map(function (_, i) { return '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'; }).join('') + '</Types>' },
      { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
      { name: 'xl/workbook.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
        names.map(function (n, i) { return '<sheet name="' + xmlEsc(n) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>'; }).join('') + '</sheets></workbook>' },
      { name: 'xl/_rels/workbook.xml.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        names.map(function (_, i) { return '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>'; }).join('') +
        '<Relationship Id="rId' + (names.length + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>' },
      { name: 'xl/styles.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>' }
    ];
    tables.forEach(function (t, i) { files.push({ name: 'xl/worksheets/sheet' + (i + 1) + '.xml', data: sheetXml(t) }); });
    return zip(files);
  }

  function htmlEsc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  // Страница для печати в PDF: заголовок, подзаголовок и таблицы.
  function printHtml(title, subtitle, tables) {
    return '<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>' + htmlEsc(title) + '</title><style>' +
      '@page{size:A4 landscape;margin:12mm}body{font-family:"Segoe UI",Arial,sans-serif;color:#111;font-size:11px}' +
      'h1{font-size:18px;margin:0 0 2px}p.sub{margin:0 0 12px;color:#555}h2{font-size:13px;margin:16px 0 6px;color:#0a5b34}' +
      'table{width:100%;border-collapse:collapse;page-break-inside:auto}tr{page-break-inside:avoid}' +
      'th{background:#e7f4ec;text-align:left;font-weight:700}th,td{border:1px solid #b8c9bf;padding:4px 6px;vertical-align:top;white-space:pre-wrap}' +
      '.empty{color:#777;font-style:italic}</style></head><body><h1>' + htmlEsc(title) + '</h1><p class="sub">' + htmlEsc(subtitle) + '</p>' +
      tables.map(function (t) {
        var rows = t.rows || [], head = t.header !== false && rows.length ? rows[0] : null, body = head ? rows.slice(1) : rows;
        return '<h2>' + htmlEsc(t.name) + '</h2>' + (body.length ? '<table>' + (head ? '<thead><tr>' + head.map(function (v) { return '<th>' + htmlEsc(v) + '</th>'; }).join('') + '</tr></thead>' : '') +
          '<tbody>' + body.map(function (r) { return '<tr>' + r.map(function (v) { return '<td>' + htmlEsc(v) + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table>' : '<p class="empty">Нет данных</p>');
      }).join('') + '</body></html>';
  }

  // Имя файла без запрещённых в Windows символов.
  function fileName(s) { return String(s || 'GRASS').replace(/[<>:"\/\\|?*\u0000-\u001F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120); }

  return { crc32: crc32, zip: zip, xlsx: xlsx, printHtml: printHtml, fileName: fileName, colName: colName };
});
