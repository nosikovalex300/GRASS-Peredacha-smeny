'use strict';
/*
 * Собирает mobile/www из общего index.html десктопной версии.
 * Логика приложения не копируется и не переписывается: берётся тот же index.html,
 * к нему подключается мост (grass-mobile-bridge.js) и стили под телефон.
 *
 * Запуск: node scripts/prepare-www.js [путь к index.html]
 */
const fs = require('node:fs');
const path = require('node:path');

const MOBILE = path.resolve(__dirname, '..');
const ROOT = path.resolve(MOBILE, '..');
const SRC_HTML = path.resolve(process.argv[2] || path.join(ROOT, 'index.html'));
const WWW = path.join(MOBILE, 'www');

function fail(msg) { console.error('prepare-www: ' + msg); process.exit(1); }

const pkg = JSON.parse(fs.readFileSync(path.join(MOBILE, 'package.json'), 'utf8'));
const version = process.env.GRASS_MOBILE_VERSION || `${pkg.version}-android`;

let html = fs.readFileSync(SRC_HTML, 'utf8');

// 1. Основной скрипт: ровно один голый <script> — иначе структура index.html изменилась, и надо смотреть руками.
const scriptTags = html.match(/<script>/g) || [];
if (scriptTags.length !== 1) fail(`ожидался ровно один тег <script> в index.html, найдено: ${scriptTags.length}`);
if (/<script\s+src=/i.test(html)) fail('в index.html появились внешние скрипты — проверьте мост вручную');
html = html.replace('<script>',
  '<script src="grass-mobile-bridge.js"></script>\n<script type="text/x-grass-deferred" id="grass-main-script">');

// 2. Viewport: учитываем вырезы экрана и системные панели.
const vp = /<meta name="viewport" content="([^"]*)">/;
if (!vp.test(html)) fail('не найден meta viewport');
html = html.replace(vp, (m, c) => `<meta name="viewport" content="${c.includes('viewport-fit') ? c : c + ',viewport-fit=cover'}">`);

// 3. Стили под телефон — самыми последними, чтобы перекрыть десктопные.
html = html.replace(/\s*$/, '') + '\n<link rel="stylesheet" href="grass-mobile.css">\n';

// 4. Проверка, что всё, на что ссылается мост, на месте.
for (const id of ['screen-tasks', 'screen-settings', 'restoreFromBackupBtn', 'openBackupFolderBtn', 'updateStatus', 'siteGate']) {
  if (!html.includes(`id="${id}"`)) fail(`в index.html нет элемента #${id}, на который опирается мост`);
}

fs.rmSync(WWW, { recursive: true, force: true });
fs.mkdirSync(WWW, { recursive: true });
fs.writeFileSync(path.join(WWW, 'index.html'), html, 'utf8');

const bridge = fs.readFileSync(path.join(MOBILE, 'src', 'grass-mobile-bridge.js'), 'utf8').replace('__GRASS_MOBILE_VERSION__', version);
fs.writeFileSync(path.join(WWW, 'grass-mobile-bridge.js'), bridge, 'utf8');
fs.copyFileSync(path.join(MOBILE, 'src', 'grass-mobile.css'), path.join(WWW, 'grass-mobile.css'));

for (const asset of ['shift-summary-icon.png']) {
  const from = path.join(path.dirname(SRC_HTML), asset);
  if (!fs.existsSync(from)) fail(`не найден файл ${asset} рядом с index.html`);
  fs.copyFileSync(from, path.join(WWW, asset));
}

console.log(`prepare-www: готово, версия ${version}, ${(html.length / 1048576).toFixed(1)} МБ index.html -> ${WWW}`);
