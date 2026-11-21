"""
1.7.11 (дополнено в 1.7.12): живая проверка СОБРАННОЙ программы (dist\\win-unpacked\\GRASS-Peredacha-smeny.exe) — только Windows.

Запуск из папки версии:
    python dev-tests/live/live_check.py [путь к exe] [папка для скриншотов]
По умолчанию exe — dist\\win-unpacked\\GRASS-Peredacha-smeny.exe, скриншоты — ..\\проверка_<версия>\\ рядом с папкой версии.

Программа запускается с отдельным временным профилем (--user-data-dir), поэтому установленная программа,
её профиль %APPDATA%\\grass-shift-handover и рабочая база не затрагиваются; профиль сверяется до и после.
GRASS_CONFIG_FILE специально не используется: он записал бы в профиль пользователя пометку «общая база».

Сценарии: 1) запуск на пустой базе; 2) задача «Передать по смене» → штатное закрытие → перезапуск;
3) копия → задача после копии → файл базы испорчен → «Восстановить копию» в системном окне;
4) восстановление копии из Настроек; 5) все экраны, версия в Настройках, ошибок JS нет;
6) новое в 1.7.11: подпункты, объявление площадки, «Слежу», проверка копии в «Состоянии», «Что нового»;
7) 1.7.12 «Безопасность»: учётка Windows в истории, песочница и CSP окна, опасные вложения, предохранители exe
   (не запускается как Node.js, подменённый app.asar не стартует), тестовые переменные установленная программа не слушает.
Во время проверки на экране появляются окна GRASS — за компьютером лучше не работать.
"""
import ctypes
import getpass
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from ctypes import wintypes

from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.dirname(os.path.dirname(HERE))
VERSION = json.load(open(os.path.join(APP, 'package.json'), encoding='utf-8'))['version']
EXE = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.join(APP, 'dist', 'win-unpacked', 'GRASS-Peredacha-smeny.exe')
SHOTS = os.path.abspath(sys.argv[2]) if len(sys.argv) > 2 else os.path.join(os.path.dirname(APP), f'проверка_{VERSION}')
REAL_PROFILE = os.path.join(os.environ.get('APPDATA', ''), 'grass-shift-handover')

user32 = ctypes.WinDLL('user32', use_last_error=True)
user32.SetProcessDPIAware()
WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
WM_CLOSE = 0x0010


def windows_of(pid):
    out = []

    def cb(h, _):
        p = wintypes.DWORD()
        user32.GetWindowThreadProcessId(h, ctypes.byref(p))
        if p.value == pid and user32.IsWindowVisible(h):
            n = user32.GetWindowTextLengthW(h)
            b = ctypes.create_unicode_buffer(n + 1)
            user32.GetWindowTextW(h, b, n + 1)
            out.append((h, b.value))
        return True
    user32.EnumWindows(WNDENUMPROC(cb), 0)
    return out


def window_rect(h):
    r = wintypes.RECT()
    user32.GetWindowRect(h, ctypes.byref(r))
    return r.left, r.top, r.right - r.left, r.bottom - r.top


def profile_snapshot():
    snap = {}
    for root, _, files in os.walk(REAL_PROFILE):
        for f in files:
            p = os.path.join(root, f)
            try:
                st = os.stat(p)
                snap[os.path.relpath(p, REAL_PROFILE)] = (st.st_size, st.st_mtime_ns)
            except OSError:
                pass
    return snap


def free_port():
    s = socket.socket(); s.bind(('127.0.0.1', 0)); p = s.getsockname()[1]; s.close()
    return p


# 1.7.12: строковое условие wait_for_function Playwright вычисляет через eval — его запрещает CSP окна; передаём функцией
FUNC_RE = re.compile(r'^\s*(async\s+)?(function\b|[A-Za-z_$][\w$]*\s*=>|\([^()]*\)\s*=>)')


def csp_safe_waits(page):
    orig = page.wait_for_function

    def wait_for_function(expression, *a, **kw):
        if not FUNC_RE.match(expression):
            expression = '() => (' + expression + ')'
        return orig(expression, *a, **kw)
    page.wait_for_function = wait_for_function


class Live:
    def __init__(self, pw, profile, exe=None):
        self.pw, self.profile, self.proc, self.browser, self.page = pw, profile, None, None, None
        self.exe = exe or EXE
        self.errors = []

    def launch(self, connect=True, extra_env=None):
        self.port = free_port()
        env = {k: v for k, v in os.environ.items() if k != 'GRASS_CONFIG_FILE'}
        env.update(extra_env or {})
        self.proc = subprocess.Popen([self.exe, f'--user-data-dir={self.profile}', f'--remote-debugging-port={self.port}'], env=env)
        if connect:
            self.connect()

    def connect(self):
        deadline = time.time() + 30
        while True:
            try:
                urllib.request.urlopen(f'http://127.0.0.1:{self.port}/json/version', timeout=2)
                break
            except Exception:
                if time.time() > deadline:
                    raise RuntimeError('программа не открыла окно за 30 секунд')
                time.sleep(0.3)
        self.browser = self.pw.chromium.connect_over_cdp(f'http://127.0.0.1:{self.port}')
        deadline = time.time() + 20
        while not self.page:
            pages = [p for c in self.browser.contexts for p in c.pages if 'index.html' in p.url]
            if pages:
                self.page = pages[0]
            elif time.time() > deadline:
                raise RuntimeError('нет окна index.html')
            else:
                time.sleep(0.3)
        self.page.on('pageerror', lambda e: self.errors.append(str(e)))
        self.page.on('console', lambda m: self.errors.append('CSP: ' + m.text) if 'Content Security Policy' in m.text else None)
        csp_safe_waits(self.page)
        self.page.wait_for_function("typeof render==='function' && document.getElementById('tasks')", timeout=20000)
        self.page.evaluate("(()=>{const d=document.getElementById('shiftSummaryDlg');if(d&&d.open)d.close();})()")

    def ev(self, js, arg=None):
        return self.page.evaluate(js, arg) if arg is not None else self.page.evaluate(js)

    def shot(self, name):
        self.page.wait_for_timeout(300)
        self.page.screenshot(path=os.path.join(SHOTS, name + '.png'))

    def close(self):
        """Штатно, как крестик окна: WM_CLOSE главному окну, программа сама снимает сессию и закрывает базу."""
        if self.browser:
            try:
                self.browser.close()
            except Exception:
                pass
        self.browser = self.page = None
        if self.proc and self.proc.poll() is None:
            for h, _ in windows_of(self.proc.pid):
                user32.PostMessageW(h, WM_CLOSE, 0, 0)
            try:
                self.proc.wait(15)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                raise RuntimeError('программа не закрылась за 15 секунд')

    def tasks(self):
        return sorted(self.ev("db.tasks.map(t=>t.text)"))

    def create_task(self, text, status=None):
        p = self.page
        p.click('nav [data-screen="tasks"]'); p.click('#addBtn'); p.fill('#text', text)
        if status:
            p.select_option('#status', status)
        p.click('#form button.add')
        p.wait_for_timeout(500)


def native_dialog(pid, title, timeout=20):
    deadline = time.time() + timeout
    while time.time() < deadline:
        for h, t in windows_of(pid):
            if t == title:
                return h
        time.sleep(0.3)
    raise RuntimeError(f'нет окна «{title}»')


def press_default_and_shot(h, title, png):
    """Системное окно Windows: вывести на передний план, снять снимок окна, нажать Enter (кнопка по умолчанию)."""
    x, y, w, hgt = window_rect(h)
    ps = f"""
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type 'using System.Runtime.InteropServices; public static class D {{ [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }}'
[void][D]::SetProcessDPIAware()
$w = New-Object -ComObject WScript.Shell
if (-not $w.AppActivate('{title}')) {{ exit 2 }}
Start-Sleep -Milliseconds 500
$bmp = New-Object System.Drawing.Bitmap {w}, {hgt}
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen({x}, {y}, 0, 0, $bmp.Size)
$bmp.Save('{png}', [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
$w.SendKeys('{{ENTER}}')
"""
    script = os.path.join(tempfile.gettempdir(), 'grass_live_press.ps1')
    open(script, 'w', encoding='utf-8-sig').write(ps)
    r = subprocess.run(['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], capture_output=True, text=True)
    if r.returncode:
        raise RuntimeError('не удалось нажать кнопку в системном окне: ' + (r.stderr or r.stdout))


def main():
    if os.name != 'nt':
        sys.exit('живая проверка — только на Windows')
    if not os.path.exists(EXE):
        sys.exit(f'нет собранной программы: {EXE}\nСначала npm run dist:win')
    os.makedirs(SHOTS, exist_ok=True)
    profile = tempfile.mkdtemp(prefix='grass-live-')
    before = profile_snapshot()
    results = []

    def step(name, fn):
        t0 = time.time()
        try:
            fn()
            results.append((name, True, ''))
        except Exception as e:
            results.append((name, False, str(e)[:600]))
        print(f"{'✅' if results[-1][1] else '❌'} {name} ({time.time() - t0:.1f}s){'' if results[-1][1] else ' — ' + results[-1][2]}", flush=True)
        return results[-1][1]

    with sync_playwright() as pw:
        L = Live(pw, profile)
        data = os.path.join(profile, 'data')
        st = {}

        def s1():
            L.launch()
            if L.page.is_visible('#siteGate'):
                L.page.get_by_text('АХТУБА', exact=True).first.click()
                L.page.wait_for_timeout(800)
                L.ev("(()=>{const d=document.getElementById('shiftSummaryDlg');if(d&&d.open)d.close();})()")
            L.shot('01_главный_экран')
            assert L.ev("db.tasks.length") == 0, L.tasks()
            assert os.path.exists(os.path.join(data, 'grass.db')), 'база не во временном профиле'

        def s2():
            L.create_task('Живая проверка: передать насос', 'Передать по смене')
            assert L.ev("db.tasks[0].status") == 'Передать по смене'
            L.shot('02_задача_передать')
            L.close(); L.launch()
            assert L.tasks() == ['Живая проверка: передать насос'], L.tasks()
            L.shot('03_после_перезапуска')

        def s3():
            L.page.click('nav [data-screen="settings"]')
            L.page.click('#createBackupBtn')
            L.page.wait_for_function("document.getElementById('backupStatus').textContent.includes('Создано')", timeout=15000)
            st['backup'] = L.page.inner_text('#backupStatus').replace('Создано:', '').strip()
            L.create_task('Создана после копии')
            L.close()
            with open(os.path.join(data, 'grass.db'), 'wb') as f:
                f.write(b'not a database at all' * 500)
            for ext in ('-wal', '-shm'):
                if os.path.exists(os.path.join(data, 'grass.db' + ext)):
                    os.remove(os.path.join(data, 'grass.db' + ext))
            L.launch(connect=False)
            title = 'GRASS — база данных не открывается'
            h = native_dialog(L.proc.pid, title)
            press_default_and_shot(h, title, os.path.join(SHOTS, '04_окно_база_не_открывается.png'))
            L.connect()
            assert L.tasks() == ['Живая проверка: передать насос'], L.tasks()
            assert [n for n in os.listdir(data) if n.startswith('grass-broken-')], 'нет grass-broken-….db'
            assert not L.ev("!!document.getElementById('grass-load-error')"), 'плашка ошибки загрузки'
            L.shot('05_после_восстановления_из_копии')

        def s4():
            L.create_task('Пропадёт после восстановления')
            L.page.click('nav [data-screen="settings"]')
            L.page.click('#restoreFromBackupBtn')
            L.page.wait_for_selector('#restoreDbDlg[open]')
            L.page.select_option('#restoreDbSelect', st['backup'])
            L.shot('06_восстановление_в_Настройках')
            L.page.click('#restoreDbConfirm')
            L.page.wait_for_timeout(3000)
            L.ev("(()=>{const d=document.getElementById('shiftSummaryDlg');if(d&&d.open)d.close();})()")
            assert L.tasks() == ['Живая проверка: передать насос'], L.tasks()
            assert [n for n in os.listdir(os.path.join(data, 'backups')) if 'pre-restore' in n], 'нет страховочной копии'
            L.shot('07_после_восстановления_из_Настроек')

        def s5():
            screens = L.ev("[...document.querySelectorAll('#sidebar nav [data-screen]')].map(b=>[b.dataset.screen,b.textContent.trim()])")
            for i, (scr, label) in enumerate(screens):
                L.page.click(f'nav [data-screen="{scr}"]')
                L.shot(f'08_{i + 1}_{label}')
            L.page.click('nav [data-screen="settings"]')
            assert L.page.inner_text('#dbInfoVersion').strip() == VERSION, L.page.inner_text('#dbInfoVersion')
            assert not L.errors, L.errors[:3]

        def s6():
            """1.7.11: подпункты, объявление, «Слежу», проверка копии в «Состоянии», «Что нового»."""
            p = L.page
            if not L.ev("typeof GrassSubtasks!=='undefined'"):
                print('   (в этой версии нет функций 1.7.11 — сценарий пропущен)')
                return
            p.click('nav [data-screen="tasks"]')
            p.click(f'#tasks .task[data-id="{L.ev("db.tasks[0].id")}"]'); p.wait_for_selector('#dlg[open]')
            for t in ('Снять насос', 'Заказать уплотнение'):
                p.fill('#subtaskText', t); p.click('#subtaskAdd')
            p.locator('#subtasksList .subtask', has_text='Снять насос').locator('input[type=checkbox]').check()
            p.click('#watchToggle')
            assert p.inner_text('#subtasksProgress') == '1 из 2' and p.inner_text('#watchToggle') == '👁 Слежу'
            L.shot('09_подпункты_и_Слежу')
            p.click('#cancel')
            p.click('#announceAddBtn'); p.fill('#announceText', 'Живая проверка: линия 3 на ремонте')
            p.click('#announceSave')
            assert 'линия 3 на ремонте' in p.inner_text('#announceBar')
            card = p.locator('#tasks .task').first.inner_text()
            assert '☑ 1/2' in card and '👁' in card, card
            L.shot('10_объявление_и_значки')
            p.click('nav [data-screen="settings"]'); p.click('#checkBackupBtn')
            p.wait_for_function("document.getElementById('dbInfoBackupCheck').textContent.startsWith('✓')", timeout=15000)
            p.locator('.stage4-data-card').screenshot(path=os.path.join(SHOTS, '11_состояние_проверка_копии.png'))
            L.close(); L.launch()                                     # после перезапуска всё на месте
            assert L.ev("db.tasks[0].subtasks.length") == 2 and L.page.is_visible('#announceBar')
            L.ev("localStorage.removeItem('grass_whatsnew_seen')")    # как после обновления с прошлой версии
            L.close(); L.launch()
            L.page.wait_for_selector('#whatsNewDlg[open]', timeout=5000)
            L.page.locator('#whatsNewDlg').screenshot(path=os.path.join(SHOTS, '12_что_нового.png'))
            L.page.click('#whatsNewOk')
            assert not L.errors, L.errors[:3]

        def s7():
            """1.7.12 «Безопасность»."""
            p = L.page
            # учётка Windows в истории — настоящая, её пишет main.js
            p.click('nav [data-screen="history"]')
            p.locator('.history-task-card summary').first.click()
            p.wait_for_selector('.history-mini .hist-osuser')
            me = getpass.getuser()
            titles = L.ev("[...document.querySelectorAll('.history-mini .hist-osuser')].map(e=>e.title)")
            assert titles and all(t == f'Учётка Windows: {me}' for t in titles), (me, titles)
            L.shot('13_учётка_в_истории')
            # песочница: в окне нет Node.js, а preload в песочнице работает (синхронный запрос в main.js)
            assert L.ev("typeof require==='undefined' && typeof process==='undefined' && typeof module==='undefined'")
            assert 'exe' in L.ev("grassAttachments.blockedExt()") and L.ev("GRASS_MODE.version") == VERSION
            # CSP: встроенный скрипт и обработчик не выполняются
            got = L.ev("""(()=>{window.__x=0;const sc=document.createElement('script');sc.textContent='window.__x=1';document.body.appendChild(sc);
                const b=document.createElement('button');b.setAttribute('onclick','window.__x=2');document.body.appendChild(b);b.click();b.remove();return window.__x;})()""")
            assert got == 0, got
            p.wait_for_timeout(300)
            csp = [e for e in L.errors if e.startswith('CSP:')]
            assert csp, 'CSP не сработала'
            L.errors[:] = [e for e in L.errors if not e.startswith('CSP:')]
            assert not L.errors, L.errors[:3]
            # предохранители exe
            tool = os.path.join(APP, 'node_modules', '.bin', 'electron-fuses.cmd')
            out = subprocess.run([tool, 'read', '--app', EXE], capture_output=True, text=True, shell=False).stdout
            want = {'RunAsNode': 'Disabled', 'EnableNodeOptionsEnvironmentVariable': 'Disabled', 'EnableNodeCliInspectArguments': 'Disabled',
                    'EnableEmbeddedAsarIntegrityValidation': 'Enabled', 'OnlyLoadAppFromAsar': 'Enabled'}
            for fuse, state in want.items():
                assert re.search(rf'{fuse}\W+is\W+{state}', out), (fuse, out)
            L.close()
            # тестовые переменные (свой файл настройки, своя учётка) установленная программа не слушает
            planted = tempfile.mkdtemp(prefix='grass-live-planted-')
            cfg = os.path.join(planted, 'grass-config.json')
            json.dump({'dataDir': os.path.join(planted, 'data'), 'admins': ['hacker']}, open(cfg, 'w'))
            L.launch(extra_env={'GRASS_CONFIG_FILE': cfg, 'GRASS_TEST_OS_USER': 'hacker'})
            assert not L.ev("GRASS_MODE.shared") and L.ev("GRASS_MODE.osUser") == me, L.ev("GRASS_MODE")
            assert not os.path.exists(os.path.join(planted, 'data')), 'установленная программа взяла GRASS_CONFIG_FILE'
            L.close()
            prof = json.load(open(os.path.join(profile, 'grass-user.json'), encoding='utf-8')) if os.path.exists(os.path.join(profile, 'grass-user.json')) else {}
            assert not prof.get('sharedDataDir'), prof
            # ELECTRON_RUN_AS_NODE: exe не выполняет переданный ему скрипт
            marker = os.path.join(planted, 'node-ran.txt')
            code = f"require('fs').writeFileSync({json.dumps(marker)},'x')"
            pr = subprocess.Popen([EXE, '-e', code, f'--user-data-dir={tempfile.mkdtemp(prefix="grass-live-node-")}'],
                                  env=dict(os.environ, ELECTRON_RUN_AS_NODE='1'))
            time.sleep(6)
            for h, _ in windows_of(pr.pid):
                user32.PostMessageW(h, WM_CLOSE, 0, 0)
            try:
                pr.wait(15)
            except subprocess.TimeoutExpired:
                pr.kill()
            assert not os.path.exists(marker), 'exe выполнил скрипт как Node.js'
            # подменённый app.asar: программа не запускается
            unpacked = os.path.dirname(EXE)
            copy = os.path.join(tempfile.mkdtemp(prefix='grass-live-asar-'), 'app')
            shutil.copytree(unpacked, copy)
            asar = os.path.join(copy, 'resources', 'app.asar')
            data_ = bytearray(open(asar, 'rb').read())
            i = data_.find(b'GRASS', len(data_) // 2)
            assert i > 0
            data_[i:i + 5] = b'HACKS'
            open(asar, 'wb').write(bytes(data_))
            bad = Live(pw, tempfile.mkdtemp(prefix='grass-live-badasar-'), exe=os.path.join(copy, os.path.basename(EXE)))
            bad.launch(connect=False)
            try:
                bad.proc.wait(20)
                started = False
            except subprocess.TimeoutExpired:
                started = any('index.html' in t or 'GRASS' in t for _, t in windows_of(bad.proc.pid))
                bad.proc.kill()
            assert not started, 'программа с подменённым app.asar открыла окно'
            shutil.rmtree(os.path.dirname(copy), ignore_errors=True)
            L.launch()
            assert L.tasks(), 'после проверок программа не открылась'

        plan = [('1. Запуск на пустой временной базе', s1),
                ('2. Задача «Передать по смене» → закрытие → перезапуск', s2),
                ('3. Битая база → «Восстановить копию» в системном окне', s3),
                ('4. Восстановление копии из Настроек', s4),
                ('5. Все экраны, версия в Настройках, ошибок JS нет', s5),
                ('6. Новое в 1.7.11: подпункты, объявление, «Слежу», проверка копии, «Что нового»', s6),
                ('7. 1.7.12: учётка в истории, песочница и CSP, предохранители exe, подмена app.asar, тестовые переменные', s7)]
        ok = True
        for name, fn in plan:                      # следующий сценарий опирается на предыдущий — после сбоя дальше не идём
            if not step(name, fn):
                ok = False
                break
        try:
            L.close()
        except Exception as e:
            print('закрытие:', e)
    shutil.rmtree(profile, ignore_errors=True)
    after = profile_snapshot()
    changed = sorted(k for k in set(before) | set(after) if before.get(k) != after.get(k))
    if changed:
        print(f'⚠ профиль установленной программы изменился ({len(changed)} файлов) — если она сейчас открыта, это она сама: ' + ', '.join(changed[:5]))
    else:
        print('✅ профиль установленной программы не изменился')
    print(f'ИТОГ: прошло {sum(r[1] for r in results)}, упало {sum(not r[1] for r in results)} · скриншоты: {SHOTS}')
    sys.exit(0 if ok and len(results) == len(plan) else 1)


if __name__ == '__main__':
    main()
