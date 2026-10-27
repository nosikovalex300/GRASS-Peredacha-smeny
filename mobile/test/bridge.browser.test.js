'use strict';
// Проверка Android-версии в настоящем браузере (Chromium через Playwright), без телефона:
// мост работает в «браузерном» режиме (вместо файлов телефона — память страницы), остальное как в APK.
// Если Playwright не установлен (сборка в GitHub Actions) — тесты пропускаются.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (_) {}
const skip = chromium ? false : 'нет Playwright (npm i -g playwright) — проверка в браузере пропущена';

const MOBILE = path.resolve(__dirname, '..');
const REPO = path.resolve(MOBILE, '..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2' };

function buildWww() {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'grass-www-'));
  const m = path.join(out, 'mobile');
  fs.mkdirSync(m);
  for (const item of ['package.json', 'scripts', 'src']) fs.cpSync(path.join(MOBILE, item), path.join(m, item), { recursive: true });
  execFileSync(process.execPath, [path.join(m, 'scripts', 'prepare-www.js'), path.join(REPO, 'index.html')], { env: { ...process.env, GRASS_MOBILE_VERSION: '1.7.11-test' }, stdio: 'pipe' });
  return path.join(m, 'www');
}
// Один адрес (одно «происхождение» = одна IndexedDB), а папку можно подменить — так проверяется обновление поверх старой версии.
function server() {
  const s = { root: null };
  s.http = http.createServer((q, r) => {
    const u = decodeURIComponent(q.url.split('?')[0]);
    const f = path.join(s.root, u === '/' ? 'index.html' : u);
    if (!f.startsWith(s.root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end(); }
    r.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(r);
  });
  return new Promise(res => s.http.listen(0, '127.0.0.1', () => { s.url = `http://127.0.0.1:${s.http.address().port}/`; res(s); }));
}

async function phone(browser) {
  const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, locale: 'ru-RU', timezoneId: 'Europe/Volgograd' });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', e => page.errors.push(e.message));
  page.on('console', msg => { if (msg.type() === 'error') page.errors.push(msg.text()); });
  return { ctx, page };
}
const click = (page, sel) => page.evaluate(s => document.querySelector(s).click(), sel);
async function ready(page) {
  await page.waitForFunction(() => typeof window.db === 'object' || typeof db === 'object', null, { timeout: 15000 });
  await page.waitForTimeout(300);
}
async function chooseSite(page, site) {
  await page.evaluate(s => document.querySelector(`[data-site-choice="${s}"]`).click(), site);
  await page.waitForLoadState('load'); await ready(page);
}
async function addTask(page, text) {
  await click(page, '#addBtn'); await page.waitForTimeout(150);
  await page.fill('#text', text);
  await page.evaluate(() => document.getElementById('form').requestSubmit());
  await page.waitForTimeout(250);
}
const cardTexts = page => page.$$eval('#screen-tasks .task h3', els => els.map(e => e.textContent.trim()));

let browser, srv, www;
test.before(async () => {
  if (skip) return;
  www = buildWww();
  srv = await server();
  srv.root = www;
  browser = await chromium.launch();
});
test.after(async () => { if (browser) await browser.close(); if (srv) srv.http.close(); });

test('A01 запуск: выбор площадки, задача сохраняется в телефоне и переживает перезапуск', { skip }, async () => {
  const { ctx, page } = await phone(browser);
  await page.goto(srv.url); await ready(page);
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('siteGate')).display !== 'none' && !document.getElementById('siteGate').classList.contains('hidden')), true);
  await chooseSite(page, 'AHTUBA');
  await addTask(page, 'Проверить насос линии 3');
  assert.deepEqual(await cardTexts(page), ['Проверить насос линии 3']);
  await page.waitForFunction(() => window.grassMobile.pendingWrites() === 0);
  await page.reload(); await ready(page);
  assert.deepEqual(await cardTexts(page), ['Проверить насос линии 3'], 'после перезапуска задача на месте (IndexedDB)');
  assert.equal(await page.evaluate(() => grassStorage.mode().shared), false);
  assert.deepEqual(page.errors, []);
  await ctx.close();
});

test('A02 площадки разделены, список технологов общий', { skip }, async () => {
  const { ctx, page } = await phone(browser);
  await page.goto(srv.url); await ready(page);
  await chooseSite(page, 'AHTUBA');
  await addTask(page, 'Задача Ахтубы');
  await page.evaluate(() => { technologists.push('Тестов Т.Т.'); saveTechnologists(); });
  await page.waitForFunction(() => window.grassMobile.pendingWrites() === 0);
  await click(page, '#changeSiteBtn'); await chooseSite(page, 'VOLZHSKY');
  assert.deepEqual(await cardTexts(page), [], 'в Волжском задач Ахтубы нет');
  assert.ok((await page.evaluate(() => technologists)).includes('Тестов Т.Т.'), 'технологи общие');
  await ctx.close();
});

test('A03 резервная копия: создать, проверить, восстановить; перед восстановлением — страховочная копия', { skip }, async () => {
  const { ctx, page } = await phone(browser);
  await page.goto(srv.url); await ready(page);
  await chooseSite(page, 'AHTUBA');
  await addTask(page, 'До копии');
  await page.waitForFunction(() => window.grassMobile.pendingWrites() === 0);
  const r = await page.evaluate(async () => {
    const made = await grassAdmin.createBackup();
    const check = await grassAdmin.verifyBackup();
    const info = await grassAdmin.getDatabaseInfo();
    return { made, check, info };
  });
  assert.equal(r.made.ok, true);
  assert.equal(r.check.ok, true); assert.equal(r.check.file, r.made.name);
  assert.equal(r.info.backupCheck.file, r.made.name);
  assert.equal(r.info.shared, false);
  await addTask(page, 'После копии');
  await page.waitForFunction(() => window.grassMobile.pendingWrites() === 0);
  const back = await page.evaluate(n => grassAdmin.restoreBackup(n), r.made.name);
  assert.equal(back.ok, true); assert.ok(back.safetyBackup, 'страховочная копия сделана');
  // В браузерном режиме копии живут в памяти страницы, поэтому проверяем данные без перезагрузки.
  const data = await page.evaluate(() => JSON.parse(grassStorage.getItem('grass_v02')).tasks.map(t => t.text));
  assert.ok(data.includes('До копии')); assert.ok(!data.includes('После копии'));
  await ctx.close();
});

test('A04 вложения: прикрепить файл из окна задачи, он сохраняется и находится', { skip }, async () => {
  const { ctx, page } = await phone(browser);
  await page.goto(srv.url); await ready(page);
  await chooseSite(page, 'AHTUBA');
  await click(page, '#addBtn'); await page.waitForTimeout(150);
  await page.fill('#text', 'С вложением');
  assert.equal(await page.evaluate(() => document.getElementById('attachAdd').hidden), false, 'кнопка «Прикрепить» видна');
  const chooser = page.waitForEvent('filechooser');
  await page.locator('#attachAdd').click({ force: true });
  await (await chooser).setFiles({ name: 'акт осмотра.txt', mimeType: 'text/plain', buffer: Buffer.from('проверка') });
  await page.waitForSelector('#attachList .attach-item');
  await page.evaluate(() => document.getElementById('form').requestSubmit()); await page.waitForTimeout(250);
  const att = await page.evaluate(() => db.tasks.find(t => t.text === 'С вложением').attachments);
  assert.equal(att.length, 1); assert.equal(att[0].name, 'акт осмотра.txt'); assert.equal(att[0].size, Buffer.byteLength('проверка'));
  assert.match(att[0].stored, /^AHTUBA\/[A-Za-z0-9_-]+\/[0-9a-f]{8}__акт осмотра\.txt$/);
  const ex = await page.evaluate(s => grassAttachments.exists([s, 'AHTUBA/x/нет.txt', '../../etc/passwd']), att[0].stored);
  assert.deepEqual(Object.values(ex), [true, false, false]);
  const info = await page.evaluate(() => grassAdmin.attachmentsInfo());
  assert.equal(info.files, 1);
  await ctx.close();
});

test('A05 выгрузка: Excel и страница для печати сохраняются в Документы/GRASS/Выгрузки', { skip }, async () => {
  const { ctx, page } = await phone(browser);
  await page.goto(srv.url); await ready(page);
  await chooseSite(page, 'AHTUBA');
  await addTask(page, 'Для выгрузки');
  await page.evaluate(() => document.querySelector('nav [data-screen="stats"]').click());
  await click(page, '#statsXlsx');
  await page.waitForFunction(() => /Сохранено/.test(document.getElementById('grass-toast')?.textContent || ''));
  assert.match(await page.textContent('#grass-toast'), /Документы\/GRASS\/Выгрузки\/Статистика .*\.xlsx/);
  assert.equal(await page.textContent('#statsPdf'), '⬇ Печать');
  await click(page, '#statsPdf');
  await page.waitForFunction(() => /\.html/.test(document.getElementById('grass-toast')?.textContent || ''));
  assert.deepEqual(page.errors, []);
  await ctx.close();
});

test('A06 все экраны на ширине телефона: без ошибок, без горизонтальной прокрутки, лишнего для ПК нет', { skip }, async () => {
  const { ctx, page } = await phone(browser);
  await page.goto(srv.url); await ready(page);
  await chooseSite(page, 'AHTUBA');
  await addTask(page, 'Очень длинное название задачи, чтобы проверить перенос строк на узком экране телефона без прокрутки вбок');
  const screens = await page.$$eval('nav [data-screen]', b => b.map(x => x.dataset.screen));
  assert.deepEqual(screens, ['tasks', 'journal', 'history', 'stats', 'archive', 'settings']);
  for (const sc of screens) {
    await page.evaluate(s => document.querySelector(`nav [data-screen="${s}"]`).click(), sc);
    await page.waitForTimeout(250);
    const w = await page.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(w <= 393, `экран ${sc}: ширина ${w} > 393`);
    const nav = await page.evaluate(() => { const r = document.querySelector('.sidebar nav').getBoundingClientRect(); return { bottom: Math.round(r.bottom), h: innerHeight }; });
    assert.equal(nav.bottom, nav.h, `экран ${sc}: панель разделов прижата к низу`);
  }
  const hidden = await page.evaluate(() => ['mirrorChoose', 'checkUpdateBtn', 'purgeAttachBtn', 'dbInfoSessions'].map(id => document.getElementById(id).offsetParent === null));
  assert.deepEqual(hidden, [true, true, true, true]);
  assert.ok(!(await page.textContent('#screen-settings')).includes('Уведомление Windows'));
  assert.equal(await page.textContent('#dbInfoMode'), 'Своя база на этом телефоне');
  assert.deepEqual(page.errors, []);
  await ctx.close();
});

// Обновление поверх Android 1.6.1: та же IndexedDB, данные должны открыться в 1.7.11.
const OLD = process.env.GRASS_ANDROID161_WWW;
test('A07 обновление с Android 1.6.1: задачи и технологи старой версии видны в 1.7.11', { skip: skip || (!OLD && 'нет GRASS_ANDROID161_WWW (папка www, собранная из ветки android)') }, async () => {
  const { ctx, page } = await phone(browser);
  srv.root = OLD;
  try {
    await page.goto(srv.url); await page.waitForTimeout(1200);
    await page.evaluate(() => document.querySelector('[data-site-choice="VOLZHSKY"]').click());
    await page.waitForLoadState('load'); await page.waitForTimeout(1200);
    await page.evaluate(() => { document.getElementById('addBtn').click(); });
    await page.waitForTimeout(200);
    await page.fill('#text', 'Задача из 1.6.1');
    await page.evaluate(() => document.getElementById('form').requestSubmit());
    await page.waitForTimeout(300);
    await page.waitForFunction(() => window.grassMobile.pendingWrites() === 0);
    assert.equal(await page.evaluate(() => window.grassMobile.version), '1.6.1-android');
  } finally { srv.root = www; }
  await page.goto(srv.url); await ready(page);
  assert.equal(await page.evaluate(() => grassSite.get()), 'VOLZHSKY', 'площадка запомнилась');
  assert.deepEqual(await cardTexts(page), ['Задача из 1.6.1']);
  assert.equal(await page.evaluate(() => window.grassMobile.version), '1.7.11-test');
  // Изменение в 1.7.11 сохраняется
  await addTask(page, 'Новая в 1.7.11');
  await page.waitForFunction(() => window.grassMobile.pendingWrites() === 0);
  await page.reload(); await ready(page);
  assert.deepEqual((await cardTexts(page)).sort(), ['Задача из 1.6.1', 'Новая в 1.7.11'].sort());
  assert.deepEqual(page.errors, []);
  await ctx.close();
});

// Косяки со скринов Сани (27.10): списки вверх и оба открыты, «+» на плитке, повтор даты, полоса под меню.
test('A08 шапка и меню на телефоне: списки вниз и по одному, «+» не закрывает плитки, срок без повтора даты', { skip }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 760 }, isMobile: true, hasTouch: true, locale: 'ru-RU', timezoneId: 'Europe/Volgograd' });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(srv.url); await ready(page);
  await chooseSite(page, 'AHTUBA');
  // Capacitor на телефоне передаёт высоту системной панели — отступ не должен добавляться второй раз.
  await page.evaluate(() => { document.documentElement.style.setProperty('--safe-area-inset-bottom', '48px'); document.documentElement.style.setProperty('--safe-area-inset-top', '24px'); });
  await click(page, '#addBtn'); await page.waitForTimeout(150);
  await page.fill('#text', 'Тест');
  await page.evaluate(() => { const d = new Date(Date.now() + 600e3), z = n => String(n).padStart(2, '0'); document.getElementById('deadline').value = `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}T${z(d.getHours())}:${z(d.getMinutes())}`; document.getElementById('form').requestSubmit(); });
  await page.waitForTimeout(300);

  // 1. Списки открываются вниз, целиком на экране, открыт только один.
  const rect = sel => page.evaluate(s => { const r = document.querySelector(s).getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, h: innerHeight }; }, sel);
  await click(page, '#techBtn');
  const tm = await rect('#techMenu'), tb = await rect('#techBtn');
  assert.ok(tm.top >= tb.bottom, `список технологов под кнопкой (${tm.top} >= ${tb.bottom})`);
  assert.ok(tm.top >= 0 && tm.bottom <= tm.h, 'список технологов целиком на экране');
  await click(page, '#shiftBtn');
  const openMenus = await page.$$eval('.side-person .menu.open', els => els.map(e => e.id));
  assert.deepEqual(openMenus, ['shiftMenu'], 'открыт только список смен');
  const sm = await rect('#shiftMenu'), sb = await rect('#shiftBtn');
  assert.ok(sm.top >= sb.bottom && sm.bottom <= sm.h, 'список смен вниз и на экране');
  await page.evaluate(() => document.querySelector('#shiftMenu button').click());
  await page.evaluate(() => document.querySelector('.page-head').click());

  // 2. «Добавить задачу» не лежит ни на одной плитке и карточке — ни сверху страницы, ни при прокрутке.
  const overlaps = () => page.evaluate(() => {
    const a = document.getElementById('addBtn').getBoundingClientRect();
    return [...document.querySelectorAll('.dash-card,.task,.tile')].filter(e => {
      const r = e.getBoundingClientRect();
      if (!r.width) return false;
      // при прокрутке плитки уходят ПОД закреплённую строку — это нормально, если строка непрозрачная и плитка ниже неё
      const bar = document.body.classList.contains('m-bar') ? document.querySelector('.sidebar .brand').getBoundingClientRect().bottom : -1;
      if (r.top < bar) return false;
      return r.left < a.right && r.right > a.left && r.top < a.bottom && r.bottom > a.top;
    }).map(e => e.className);
  });
  assert.deepEqual(await overlaps(), [], 'вверху страницы');
  for (const y of [300, 700, 1200]) {
    await page.evaluate(v => window.scrollTo(0, v), y); await page.waitForTimeout(100);
    assert.deepEqual(await overlaps(), [], `прокрутка ${y}`);
    const a = await rect('#addBtn');
    assert.ok(a.top >= 0 && a.bottom <= 80, `при прокрутке ${y} кнопка видна вверху (${a.top})`);
  }
  await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => document.body.classList.contains('m-bar')), false);

  // 3. Ближайшая задача: дата один раз, строка не обрезается многоточием.
  const meta = await page.textContent('#nearestTaskMeta');
  assert.match(meta, /^Срок: \d\d\.\d\d\.\d{4} \d\d:\d\d · через \d+ минут/);
  assert.equal((meta.match(/\d\d\.\d\d\.\d{4}/g) || []).length, 1, meta);
  assert.equal(await page.evaluate(() => { const e = document.getElementById('nearestTaskMeta'); return e.scrollWidth <= e.clientWidth + 1; }), true);

  // 4. Нижнее меню прижато к низу, без лишней полосы от системной панели; последний ряд плиток можно докрутить над меню.
  const nav = await page.evaluate(() => { const r = document.querySelector('.sidebar nav').getBoundingClientRect(); return { top: r.top, bottom: r.bottom, h: innerHeight }; });
  assert.equal(Math.round(nav.bottom), nav.h);
  assert.ok(nav.bottom - nav.top <= 72, `высота меню ${nav.bottom - nav.top}`);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight)); await page.waitForTimeout(100);
  const lastBottom = await page.evaluate(() => Math.max(...[...document.querySelectorAll('#screen-tasks .dash-card,#screen-tasks .task')].map(e => e.getBoundingClientRect().bottom)));
  assert.ok(lastBottom <= nav.top, `в самом низу всё видно над меню (${lastBottom} <= ${nav.top})`);
  assert.deepEqual(errors, []);
  await ctx.close();
});
