'use strict';
/*
 * Настраивает Android-проект, который создаёт `npx cap add android`:
 *  - иконки и заставка GRASS;
 *  - версия (versionName / versionCode);
 *  - разрешения для резервных копий в «Документы» (Android 9–10);
 *  - подпись релизным ключом из переменных окружения (если ключ задан).
 * Каждый шаг проверяет, что нашёл то, что ожидал; иначе сборка падает с понятной причиной.
 *
 * Переменные окружения:
 *   GRASS_VERSION_NAME   например 1.6.1-android
 *   GRASS_VERSION_CODE   целое, растёт с каждой сборкой
 *   GRASS_KEYSTORE_PATH, GRASS_KEYSTORE_PASSWORD, GRASS_KEY_ALIAS, GRASS_KEY_PASSWORD — подпись
 */
const fs = require('node:fs');
const path = require('node:path');

const MOBILE = path.resolve(__dirname, '..');
const ANDROID = path.join(MOBILE, 'android');
const APP = path.join(ANDROID, 'app');
const RES = path.join(APP, 'src', 'main', 'res');
const MANIFEST = path.join(APP, 'src', 'main', 'AndroidManifest.xml');
const GRADLE = path.join(APP, 'build.gradle');
if (!fs.existsSync(GRADLE) && fs.existsSync(GRADLE + '.kts')) {
  console.error('patch-android: шаблон Capacitor перешёл на build.gradle.kts — нужно обновить этот скрипт');
  process.exit(1);
}

function fail(msg) { console.error('patch-android: ' + msg); process.exit(1); }
function must(file) { if (!fs.existsSync(file)) fail(`не найден ${path.relative(MOBILE, file)} — проект Android не создан?`); }
function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name), b = path.join(to, e.name);
    if (e.isDirectory()) copyDir(a, b); else fs.copyFileSync(a, b);
  }
}

must(RES); must(MANIFEST); must(GRADLE);
if (!fs.existsSync(path.join(MOBILE, 'android-res', 'values', 'grass_colors.xml'))) fail('нет иконок в android-res — сначала запустите python3 scripts/make-icons.py');

// 1. Иконки и заставка: убираем стандартные картинки Capacitor и кладём свои.
for (const dir of fs.readdirSync(RES)) {
  const full = path.join(RES, dir);
  if (!fs.statSync(full).isDirectory()) continue;
  for (const f of fs.readdirSync(full)) {
    if (/^drawable/.test(dir) && /^splash\.(png|9\.png|xml)$/.test(f)) fs.rmSync(path.join(full, f));
    if (/^mipmap/.test(dir) && /^ic_launcher/.test(f)) fs.rmSync(path.join(full, f));
    if (dir === 'values' && f === 'ic_launcher_background.xml') fs.rmSync(path.join(full, f));
  }
}
copyDir(path.join(MOBILE, 'android-res'), RES);
console.log('patch-android: иконки и заставка GRASS установлены');

// 2. Цвет фона заставки Android 12+ (Theme.SplashScreen) — тёмный, как у приложения.
const stylesFile = path.join(RES, 'values', 'styles.xml');
if (fs.existsSync(stylesFile)) {
  let styles = fs.readFileSync(stylesFile, 'utf8');
  const launch = /(<style name="AppTheme\.NoActionBarLaunch"[^>]*>)([\s\S]*?)(<\/style>)/;
  if (launch.test(styles) && !styles.includes('windowSplashScreenBackground')) {
    styles = styles.replace(launch, (m, open, body, close) =>
      `${open}${body.replace(/\s*$/, '')}\n        <item name="windowSplashScreenBackground">@color/grass_splash_background</item>\n    ${close}`);
    fs.writeFileSync(stylesFile, styles);
    console.log('patch-android: фон заставки задан');
  } else {
    console.warn('patch-android: стиль заставки не найден или уже настроен — пропускаю');
  }
}

// 3. Разрешения для резервных копий в «Документы» на Android 9–10 (на 11+ не нужны).
let manifest = fs.readFileSync(MANIFEST, 'utf8');
const perms = [
  '<uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="29" />',
  '<uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="29" />'
];
for (const p of perms) {
  const name = p.match(/android:name="([^"]+)"/)[1];
  if (!manifest.includes(`"${name}"`)) manifest = manifest.replace(/<\/manifest>\s*$/, `    ${p}\n</manifest>\n`);
}
if (!/<application[^>]*requestLegacyExternalStorage/.test(manifest)) {
  if (!/<application\b/.test(manifest)) fail('в AndroidManifest.xml не найден <application>');
  manifest = manifest.replace(/<application\b/, '<application\n        android:requestLegacyExternalStorage="true"');
}
fs.writeFileSync(MANIFEST, manifest);
console.log('patch-android: разрешения для резервных копий добавлены');

// 4. Версия.
let gradle = fs.readFileSync(GRADLE, 'utf8');
const versionName = process.env.GRASS_VERSION_NAME;
const versionCode = process.env.GRASS_VERSION_CODE;
if (versionName) {
  const re = /versionName(\s*=?\s*)"[^"]*"/;
  if (!re.test(gradle)) fail('в app/build.gradle не найден versionName');
  gradle = gradle.replace(re, (m, sep) => `versionName${sep}"${versionName.replace(/"/g, '')}"`);
}
if (versionCode) {
  if (!/^\d+$/.test(versionCode)) fail('GRASS_VERSION_CODE должен быть числом');
  const re = /versionCode(\s*=?\s*)\d+/;
  if (!re.test(gradle)) fail('в app/build.gradle не найден versionCode');
  gradle = gradle.replace(re, (m, sep) => `versionCode${sep}${versionCode}`);
}

// 5. Подпись релизным ключом. Один и тот же ключ = новые версии ставятся поверх старых без потери данных.
const ks = process.env.GRASS_KEYSTORE_PATH;
if (ks) {
  if (!fs.existsSync(ks)) fail('файл ключа подписи не найден: ' + ks);
  for (const v of ['GRASS_KEYSTORE_PASSWORD', 'GRASS_KEY_ALIAS', 'GRASS_KEY_PASSWORD']) if (!process.env[v]) fail(`не задан ${v}`);
  if (!gradle.includes('grassRelease')) {
    const signing = `
    signingConfigs {
        grassRelease {
            storeFile file(System.getenv("GRASS_KEYSTORE_PATH"))
            storePassword System.getenv("GRASS_KEYSTORE_PASSWORD")
            keyAlias System.getenv("GRASS_KEY_ALIAS")
            keyPassword System.getenv("GRASS_KEY_PASSWORD")
        }
    }
`;
    if (!/android\s*\{/.test(gradle)) fail('в app/build.gradle не найден блок android {');
    gradle = gradle.replace(/android\s*\{/, m => m + signing);
    if (!/buildTypes\s*\{[\s\S]*?release\s*\{/.test(gradle)) fail('в app/build.gradle не найден buildTypes.release');
    gradle = gradle.replace(/(buildTypes\s*\{[\s\S]*?release\s*\{)/, `$1\n            signingConfig signingConfigs.grassRelease`);
  }
  console.log('patch-android: подпись релизным ключом настроена');
} else {
  console.warn('patch-android: ключ подписи не задан — будет собрана только отладочная версия');
}
fs.writeFileSync(GRADLE, gradle);
console.log(`patch-android: версия ${versionName || '(по умолчанию)'} / ${versionCode || '(по умолчанию)'}`);
