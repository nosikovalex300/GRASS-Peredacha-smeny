'use strict';
/*
 * Собирает mobile/www из общего index.html десктопной версии.
 * Логика приложения не копируется и не переписывается: берётся тот же index.html и те же *.js,
 * к ним подключается мост (grass-mobile-bridge.js) и стили под телефон.
 *
 * С 1.7.x index.html состоит из модулей (<script src="…">) и одного основного inline-скрипта.
 * Все они откладываются (type="text/x-grass-deferred") и запускаются мостом строго по порядку,
 * когда данные уже загружены из IndexedDB.
 *
 * Запуск: node scripts/prepare-www.js [путь к index.html]
 */
const fs = require('node:fs');
const path = require('node:path');

const MOBILE = path.resolve(__dirname, '..');
const ROOT = path.resolve(MOBILE, '..');
const SRC_HTML = path.resolve(process.argv[2] || path.join(ROOT, 'index.html'));
const SRC_DIR = path.dirname(SRC_HTML);
const WWW = path.join(MOBILE, 'www');

function fail(msg) { console.error('prepare-www: ' + msg); process.exit(1); }

const pkg = JSON.parse(fs.readFileSync(path.join(MOBILE, 'package.json'), 'utf8'));
const version = process.env.GRASS_MOBILE_VERSION || `${pkg.version}-android`;

let html = fs.readFileSync(SRC_HTML, 'utf8');

// 1. Скрипты: ровно один голый <script> (основной) и сколько угодно <script src="локальный.js"></script>.
const inline = html.match(/<script>/g) || [];
if (inline.length !== 1) fail(`ожидался ровно один тег <script> в index.html, найдено: ${inline.length}`);
const allTags = html.match(/<script\b[^>]*>/g) || [];
const srcRe = /<script src="([A-Za-z0-9_.-]+\.js)"><\/script>/g;
const modules = [...html.matchAll(srcRe)].map(m => m[1]);
if (allTags.length !== modules.length + 1) fail('в index.html есть скрипты непривычного вида — проверьте мост вручную');
for (const m of modules) if (!fs.existsSync(path.join(SRC_DIR, m))) fail(`не найден модуль ${m} рядом с index.html`);
html = html.replace(srcRe, (m, src) => `<script type="text/x-grass-deferred" data-src="${src}"></script>`);
html = html.replace('<script>', '<script type="text/x-grass-deferred" id="grass-main-script">');
const firstScript = html.search(/<script\b/);
html = html.slice(0, firstScript) + '<script src="grass-mobile-bridge.js"></script>\n' + html.slice(firstScript);

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

// 5. Модули, стили, шрифты и картинки — те же файлы, что у ПК-версии.
for (const m of modules) fs.copyFileSync(path.join(SRC_DIR, m), path.join(WWW, m));
for (const asset of ['styles.css', 'shift-summary-icon.png']) {
  const from = path.join(SRC_DIR, asset);
  if (!fs.existsSync(from)) fail(`не найден файл ${asset} рядом с index.html`);
  fs.copyFileSync(from, path.join(WWW, asset));
}
for (const dir of ['img', 'fonts']) {
  const from = path.join(SRC_DIR, dir);
  if (!fs.existsSync(from)) fail(`не найдена папка ${dir} рядом с index.html`);
  fs.cpSync(from, path.join(WWW, dir), { recursive: true });
}
// Всё, на что index.html и styles.css ссылаются как на локальные файлы, должно попасть в www.
const refs = new Set();
for (const text of [html, fs.readFileSync(path.join(WWW, 'styles.css'), 'utf8')]) {
  for (const m of text.matchAll(/(?:src|href)="([^"#:?]+)"|url\(\s*['"]?([^'")#:?]+)['"]?\s*\)/g)) {
    const ref = m[1] || m[2];
    if (ref && !ref.startsWith('data') && !ref.startsWith('/')) refs.add(ref);
  }
}
for (const ref of refs) if (!fs.existsSync(path.join(WWW, ref))) fail(`в www нет файла ${ref}, на который ссылается index.html или styles.css`);

console.log(`prepare-www: готово, версия ${version}, модулей ${modules.length}, ${(html.length / 1048576).toFixed(1)} МБ index.html -> ${WWW}`);
