'use strict';
// Проверка скриптов сборки без Android SDK: node --test test/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const MOBILE = path.resolve(__dirname, '..');
const REPO = path.resolve(MOBILE, '..');

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grass-mobile-'));
  for (const f of fs.readdirSync(REPO)) {
    if (/\.(html|js|css|png)$/.test(f)) fs.copyFileSync(path.join(REPO, f), path.join(root, f));
  }
  for (const d of ['img', 'fonts']) fs.cpSync(path.join(REPO, d), path.join(root, d), { recursive: true });
  const m = path.join(root, 'mobile');
  fs.mkdirSync(m);
  for (const item of ['package.json', 'capacitor.config.json', 'scripts', 'src', 'android-res']) {
    fs.cpSync(path.join(MOBILE, item), path.join(m, item), { recursive: true });
  }
  return { root, m };
}
function run(m, script, env = {}) {
  return execFileSync(process.execPath, [path.join(m, 'scripts', script)], { cwd: m, env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// Макет того, что создаёт `npx cap add android` (шаблон Capacitor).
function fakeAndroid(m, { gradleStyle = 'space' } = {}) {
  const res = path.join(m, 'android', 'app', 'src', 'main', 'res');
  for (const d of ['drawable', 'drawable-land-hdpi', 'drawable-port-xhdpi', 'mipmap-hdpi', 'mipmap-anydpi-v26', 'values']) fs.mkdirSync(path.join(res, d), { recursive: true });
  fs.writeFileSync(path.join(res, 'drawable', 'splash.png'), 'capacitor');
  fs.writeFileSync(path.join(res, 'drawable-land-hdpi', 'splash.png'), 'capacitor');
  fs.writeFileSync(path.join(res, 'drawable-port-xhdpi', 'splash.png'), 'capacitor');
  fs.writeFileSync(path.join(res, 'mipmap-hdpi', 'ic_launcher.png'), 'capacitor');
  fs.writeFileSync(path.join(res, 'mipmap-hdpi', 'ic_launcher_foreground.png'), 'capacitor');
  fs.writeFileSync(path.join(res, 'mipmap-anydpi-v26', 'ic_launcher.xml'), 'capacitor');
  fs.writeFileSync(path.join(res, 'values', 'ic_launcher_background.xml'), '<resources><color name="ic_launcher_background">#FFFFFF</color></resources>');
  fs.writeFileSync(path.join(res, 'values', 'styles.xml'), `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <style name="AppTheme" parent="Theme.AppCompat.Light.DarkActionBar"></style>
    <style name="AppTheme.NoActionBarLaunch" parent="Theme.SplashScreen">
        <item name="android:background">@drawable/splash</item>
    </style>
</resources>
`);
  fs.writeFileSync(path.join(m, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'), `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application
        android:allowBackup="true"
        android:icon="@mipmap/ic_launcher"
        android:label="@string/app_name">
    </application>
    <uses-permission android:name="android.permission.INTERNET" />
</manifest>
`);
  const eq = gradleStyle === 'equals' ? ' = ' : ' ';
  fs.writeFileSync(path.join(m, 'android', 'app', 'build.gradle'), `apply plugin: 'com.android.application'

android {
    namespace${eq}"ru.grass.shifthandover"
    compileSdk${eq}rootProject.ext.compileSdkVersion
    defaultConfig {
        applicationId "ru.grass.shifthandover"
        versionCode${eq}1
        versionName${eq}"1.0"
    }
    buildTypes {
        release {
            minifyEnabled false
        }
    }
}
`);
}

// Модули index.html (<script src>) по порядку — как в десктопной версии.
const modulesOf = html => [...html.matchAll(/<script src="([A-Za-z0-9_.-]+\.js)"><\/script>/g)].map(m => m[1]);

test('prepare-www: мост подключён первым, модули и основной скрипт отложены, логика index.html не тронута', () => {
  const { root, m } = sandbox();
  run(m, 'prepare-www.js', { GRASS_MOBILE_VERSION: '9.9.9-test' });
  const out = fs.readFileSync(path.join(m, 'www', 'index.html'), 'utf8');
  const orig = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  // Мост — единственный обычный скрипт и стоит раньше всех отложенных.
  assert.deepEqual(modulesOf(out), ['grass-mobile-bridge.js']);
  assert.ok(out.indexOf('grass-mobile-bridge.js') < out.indexOf('text/x-grass-deferred'));
  assert.ok(!/<script>/.test(out), 'исполняемых inline-скриптов не осталось');
  assert.equal((out.match(/id="grass-main-script"/g) || []).length, 1);
  // Все модули ПК-версии — отложены, в том же порядке, и основной скрипт на своём месте между ними.
  const deferred = [...out.matchAll(/<script type="text\/x-grass-deferred"(?: data-src="([^"]+)"| id="grass-main-script")>/g)].map(x => x[1] || 'MAIN');
  const origOrder = [...orig.matchAll(/<script(?: src="([^"]+)")?>/g)].map(x => x[1] || 'MAIN');
  assert.deepEqual(deferred, origOrder);
  assert.ok(modulesOf(orig).length >= 15, 'в 1.7.x не меньше 15 модулей');
  assert.ok(out.trimEnd().endsWith('<link rel="stylesheet" href="grass-mobile.css">'), 'мобильные стили подключены последними');
  assert.ok(out.includes('viewport-fit=cover'));
  // Код приложения байт-в-байт тот же
  const body = s => s.slice(s.indexOf('const $=x=>'), s.indexOf('</script>', s.indexOf('const $=x=>')));
  assert.ok(body(orig).length > 10000);
  assert.equal(body(out), body(orig));
  const bridge = fs.readFileSync(path.join(m, 'www', 'grass-mobile-bridge.js'), 'utf8');
  assert.ok(bridge.includes("'9.9.9-test'"));
  assert.ok(!bridge.includes('__GRASS_MOBILE_VERSION__'));
  // Модули, стили, картинки, шрифты — побайтно те же файлы, что у ПК-версии.
  for (const f of [...modulesOf(orig), 'styles.css', 'shift-summary-icon.png', 'img/logo.png', 'fonts/manrope-cyrillic.woff2']) {
    assert.ok(fs.readFileSync(path.join(m, 'www', f)).equals(fs.readFileSync(path.join(root, f))), f);
  }
  assert.ok(fs.existsSync(path.join(m, 'www', 'grass-mobile.css')));
});

test('prepare-www: если index.html изменили так, что мост не сработает, сборка падает', () => {
  const { root, m } = sandbox();
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  fs.writeFileSync(path.join(root, 'index.html'), html.replace('<script>', '<script>1</script><script>'));
  assert.throws(() => run(m, 'prepare-www.js'), /ровно один тег <script>/);
  fs.writeFileSync(path.join(root, 'index.html'), html.replace('<script>', '<script defer src="x.js"></script><script>'));
  assert.throws(() => run(m, 'prepare-www.js'), /непривычного вида/);
});

test('prepare-www: пропал модуль или картинка — сборка падает, а не выпускает пустое приложение', () => {
  const { root, m } = sandbox();
  fs.rmSync(path.join(root, 'ui-watch.js'));
  assert.throws(() => run(m, 'prepare-www.js'), /не найден модуль ui-watch\.js/);
  const s2 = sandbox();
  fs.rmSync(path.join(s2.root, 'img', 'logo.png'));
  assert.throws(() => run(s2.m, 'prepare-www.js'), /нет файла img\/logo\.png/);
});

test('мост даёт index.html всё API из preload.js, кроме общей базы', () => {
  const preload = fs.readFileSync(path.join(REPO, 'preload.js'), 'utf8');
  const bridge = fs.readFileSync(path.join(MOBILE, 'src', 'grass-mobile-bridge.js'), 'utf8');
  // Объекты, которые preload.js выставляет в окно
  const objects = [...preload.matchAll(/exposeInMainWorld\('(\w+)'/g)].map(x => x[1]);
  assert.ok(objects.length >= 6);
  for (const o of objects) assert.ok(bridge.includes(`window.${o} = `), `мост не выставляет window.${o}`);
  // Методы grassAdmin, которые на телефоне сознательно не делаем (index.html вызывает их через ?.)
  const skip = new Set(['patch', 'changes', 'mirrorNow', 'chooseMirror', 'purgeClearedAttachments']);
  const methods = [...preload.matchAll(/^\s+(\w+)\((?:[\w, ]*)\)\s*\{/gm)].map(x => x[1]).filter(n => !skip.has(n));
  for (const name of new Set(methods)) assert.match(bridge, new RegExp(`\\b${name}\\s*:`), `в мосте нет ${name}`);
  // index.html не должен вызывать пропущенное без проверки
  const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
  for (const name of ['mirrorNow', 'chooseMirror']) assert.ok(!new RegExp(`grassAdmin\\.${name}\\(`).test(html), name);
  assert.ok(/typeof grassStorage\.patch==='function'/.test(html), 'без patch index.html сохраняет данные целиком');
  assert.ok(/typeof grassStorage\.changes!=='function'/.test(html), 'без changes index.html не ждёт чужих изменений');
});

for (const gradleStyle of ['space', 'equals']) {
  test(`patch-android: иконки, заставка, разрешения, версия, подпись (Gradle: ${gradleStyle})`, () => {
    const { m } = sandbox();
    fakeAndroid(m, { gradleStyle });
    const ks = path.join(m, 'fake.jks'); fs.writeFileSync(ks, 'x');
    const log = run(m, 'patch-android.js', {
      GRASS_VERSION_NAME: '1.7.11-android', GRASS_VERSION_CODE: '42',
      GRASS_KEYSTORE_PATH: ks, GRASS_KEYSTORE_PASSWORD: 'p', GRASS_KEY_ALIAS: 'grass', GRASS_KEY_PASSWORD: 'p'
    });
    const res = path.join(m, 'android', 'app', 'src', 'main', 'res');
    assert.ok(!fs.existsSync(path.join(res, 'drawable', 'splash.png')));
    assert.ok(!fs.existsSync(path.join(res, 'drawable-land-hdpi', 'splash.png')));
    assert.ok(fs.existsSync(path.join(res, 'drawable', 'splash.xml')));
    assert.ok(!fs.existsSync(path.join(res, 'values', 'ic_launcher_background.xml')), 'нет дубля цвета фона иконки');
    assert.ok(fs.readFileSync(path.join(res, 'values', 'grass_colors.xml'), 'utf8').includes('ic_launcher_background'));
    assert.notEqual(fs.readFileSync(path.join(res, 'mipmap-hdpi', 'ic_launcher.png'), 'latin1'), 'capacitor');
    assert.ok(fs.readFileSync(path.join(res, 'mipmap-anydpi-v26', 'ic_launcher.xml'), 'utf8').includes('adaptive-icon'));
    const styles = fs.readFileSync(path.join(res, 'values', 'styles.xml'), 'utf8');
    assert.ok(/NoActionBarLaunch[\s\S]*windowSplashScreenBackground[\s\S]*<\/style>/.test(styles));
    const manifest = fs.readFileSync(path.join(m, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'), 'utf8');
    assert.ok(manifest.includes('android:requestLegacyExternalStorage="true"'));
    assert.ok(manifest.includes('WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="29"'));
    assert.equal((manifest.match(/POST_NOTIFICATIONS/g) || []).length, 1, 'разрешение на уведомления');
    assert.ok(manifest.trimEnd().endsWith('</manifest>'));
    const gradle = fs.readFileSync(path.join(m, 'android', 'app', 'build.gradle'), 'utf8');
    assert.match(gradle, /versionCode\s*=?\s*42\b/);
    assert.match(gradle, /versionName\s*=?\s*"1\.7\.11-android"/);
    assert.match(gradle, /signingConfigs\s*\{\s*grassRelease/);
    assert.match(gradle, /release\s*\{\s*signingConfig signingConfigs\.grassRelease/);
    assert.equal((gradle.match(/\{/g) || []).length, (gradle.match(/\}/g) || []).length, 'скобки сбалансированы');
    // Повторный запуск ничего не дублирует
    run(m, 'patch-android.js', { GRASS_VERSION_CODE: '42', GRASS_KEYSTORE_PATH: ks, GRASS_KEYSTORE_PASSWORD: 'p', GRASS_KEY_ALIAS: 'grass', GRASS_KEY_PASSWORD: 'p' });
    const again = fs.readFileSync(path.join(m, 'android', 'app', 'build.gradle'), 'utf8');
    assert.equal((again.match(/grassRelease \{/g) || []).length, 1);
    const manifest2 = fs.readFileSync(path.join(m, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'), 'utf8');
    assert.equal((manifest2.match(/requestLegacyExternalStorage/g) || []).length, 1);
    assert.equal((manifest2.match(/POST_NOTIFICATIONS/g) || []).length, 1);
    assert.ok(log.includes('подпись релизным ключом настроена'));
  });
}

test('patch-android: без ключа собирается отладочная версия, без подписи в gradle', () => {
  const { m } = sandbox();
  fakeAndroid(m);
  const env = { ...process.env }; delete env.GRASS_KEYSTORE_PATH;
  const out = execFileSync(process.execPath, [path.join(m, 'scripts', 'patch-android.js')], { cwd: m, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.ok(!fs.readFileSync(path.join(m, 'android', 'app', 'build.gradle'), 'utf8').includes('grassRelease'));
  assert.ok(!out.includes('подпись релизным ключом настроена'));
});

test('capacitor.config: адрес приложения зафиксирован (иначе после обновления пропадут данные)', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(MOBILE, 'capacitor.config.json'), 'utf8'));
  assert.equal(cfg.server.androidScheme, 'https');
  assert.equal(cfg.server.hostname, 'localhost');
  assert.equal(cfg.appId, 'ru.grass.shifthandover');
  assert.equal(cfg.webDir, 'www');
});
