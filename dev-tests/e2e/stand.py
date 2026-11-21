"""
Стенд GRASS: настоящий main.js (Node + заглушка Electron) + настоящий preload.js
+ настоящий index.html в Chromium. Время в странице подменяется, перезапуск — честный
(процесс main.js останавливается и стартует заново на той же папке данных).
"""
import json
import os
import re
import socket
import subprocess
import sys
import time
import urllib.request
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
WINDOWS = os.name == 'nt'   # 1.7.10: SIGTERM на Windows не доставляется — останавливаем через stdin
FAKE = os.path.join(HERE, 'fake')
BRIDGE = open(os.path.join(HERE, 'bridge-init.js'), encoding='utf-8').read()


# Текст — уже функция: «x=>…», «(a,b)=>…», «async x=>…», «function(…)…»
FUNC_RE = re.compile(r'^\s*(async\s+)?(function\b|[A-Za-z_$][\w$]*\s*=>|\([^()]*\)\s*=>)')


def free_port():
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    p = s.getsockname()[1]
    s.close()
    return p


def T(s):
    return datetime.fromisoformat(s)


class Stand:
    def __init__(self, browser, app_dir, user_data, site='AHTUBA', viewport=(1440, 920), extra_env=None):
        self.browser = browser
        self.extra_env = dict(extra_env or {})   # 1.7.2: GRASS_CONFIG_FILE и т.п. для общей базы
        self.extras = []                         # другие копии программы в тесте (закрываются вместе с этой)
        self.app_dir = app_dir
        self.user_data = user_data
        self.site = site
        self.proc = None
        self.port = free_port()  # постоянный порт = постоянный origin = localStorage переживает перезапуск
        self.ctx = browser.new_context(viewport={'width': viewport[0], 'height': viewport[1]},
                                       locale='ru-RU', timezone_id='Europe/Volgograd')
        if site:
            self.ctx.add_init_script(f"try{{if(!localStorage.getItem('grass_selected_site'))localStorage.setItem('grass_selected_site','{site}')}}catch(e){{}}")
        self.ctx.add_init_script(BRIDGE)
        self.ctx.clock.install(time=T('2026-10-21T10:00:00'))
        self.page = None
        self.page_errors = []
        self.dialogs = []
        # 1.7.11: окно «Что нового» на стенде считается уже показанным (иначе вторая копия на общей базе
        # с чистым профилем открывала бы его поверх всего). Тест самого окна выключает это до первого open().
        self.seed_whatsnew = True
        self._whatsnew_seeded = False

    # ---- процесс main.js ----
    def start_main(self, extra_env=None):
        env = dict(os.environ, NODE_PATH=FAKE, **self.extra_env, **(extra_env or {}))
        if WINDOWS:
            env['GRASS_STAND_STDIN_QUIT'] = '1'
        self.proc = subprocess.Popen(['node', '--no-warnings', os.path.join(HERE, 'run-main.js'), self.app_dir, self.user_data, str(self.port)],
                                     stdin=subprocess.PIPE if WINDOWS else None,
                                     stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env, text=True)
        deadline = time.time() + 20
        while time.time() < deadline:
            line = self.proc.stdout.readline()
            if line.startswith('READY'):
                return
            if self.proc.poll() is not None:
                raise RuntimeError('main.js упал при запуске:\n' + line + self.proc.stdout.read())
        raise RuntimeError('main.js не запустился')

    def stop_main(self):
        if self.page:
            try:
                self.page.close()
            except Exception:
                pass
            self.page = None
        if self.proc and self.proc.poll() is None:
            if WINDOWS:
                try:   # штатно, как закрытие окна: before-quit → endSession
                    self.proc.stdin.write('QUIT\n'); self.proc.stdin.flush()
                except OSError:
                    self.proc.terminate()
            else:
                self.proc.terminate()
            try:
                self.proc.wait(5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        self.proc = None

    def state(self):
        with urllib.request.urlopen(f'http://127.0.0.1:{self.port}/__state') as r:
            return json.loads(r.read())

    def updater(self, emit=None, version=None):
        """1.7.4: состояние заглушки автообновления; emit — выпустить событие (например update-downloaded)."""
        q = ''
        if emit:
            q = f'?emit={emit}' + (f'&version={version}' if version else '')
        with urllib.request.urlopen(f'http://127.0.0.1:{self.port}/__updater{q}') as r:
            return json.loads(r.read())

    def second_instance(self):
        with urllib.request.urlopen(f'http://127.0.0.1:{self.port}/__second-instance') as r:
            return json.loads(r.read())

    # ---- страница ----
    def open(self, ts, restart=True, keep_summary=False):
        """Запуск приложения в момент ts. restart=True — полный перезапуск (новый процесс main.js).
        С 1.7.4 сводка смены может открыться сама; обычные тесты её закрывают (keep_summary=False)."""
        if restart or not self.proc:
            self.stop_main()
            self.start_main()
        self.ctx.clock.set_system_time(T(ts))
        if self.seed_whatsnew and not self._whatsnew_seeded:
            self._whatsnew_seeded = True
            try:
                ver = json.load(open(os.path.join(self.app_dir, 'package.json'), encoding='utf-8'))['version']
                self.ctx.add_init_script(f"try{{if(!localStorage.getItem('grass_whatsnew_seen'))localStorage.setItem('grass_whatsnew_seen','{ver}')}}catch(e){{}}")
            except (OSError, KeyError, ValueError):
                pass
        if self.page is None:
            self.page = self.ctx.new_page()
            self.page.on('pageerror', lambda e: self.page_errors.append(str(e)))
            # 1.7.12: нарушение защиты окна (CSP) — тоже ошибка: значит, что-то в окне перестало работать
            self.page.on('console', lambda m: self.page_errors.append('CSP: ' + m.text) if 'Content Security Policy' in m.text else None)
            # Строковое условие wait_for_function Playwright вычисляет через eval, а его CSP окна запрещает —
            # передаём его функцией (так Playwright обходится без eval)
            orig_wait = self.page.wait_for_function
            def wait_for_function(expression, *a, _orig=orig_wait, **kw):
                if not FUNC_RE.match(expression):
                    expression = '() => (' + expression + ')'
                return _orig(expression, *a, **kw)
            self.page.wait_for_function = wait_for_function
            self.page.on('dialog', self._on_dialog)
        self.page.goto(f'http://127.0.0.1:{self.port}/index.html')
        self.page.wait_for_function("typeof render==='function' && document.getElementById('tasks')")
        if not keep_summary:
            self.page.evaluate("(()=>{const d=document.getElementById('shiftSummaryDlg');if(d&&d.open)d.close();})()")
        return self.page

    def _on_dialog(self, d):
        self.dialogs.append(d.message)
        d.accept()

    def at(self, ts):
        """Перевести часы (без перезапуска и без срабатывания таймеров)."""
        self.ctx.clock.set_system_time(T(ts))

    def run_for(self, dur):
        """Прожить время с тиками таймеров приложения, например '00:20:00'."""
        self.ctx.clock.run_for(dur)

    def ev(self, js, arg=None):
        return self.page.evaluate(js, arg) if arg is not None else self.page.evaluate(js)

    # ---- типовые действия технолога ----
    def create_task(self, text, status=None, comment=None, deadline=None):
        p = self.page
        p.click('nav [data-screen="tasks"]')
        p.click('#addBtn')
        p.fill('#text', text)
        if status:
            p.select_option('#status', status)
        if comment is not None:
            p.fill('#comment', comment)
        if deadline:
            p.fill('#deadline', deadline)
        p.click('#form button.add')
        # 1.7.8: срок в прошлом программа переспрашивает — тесты, где так задумано, подтверждают
        if deadline and p.is_visible('#askDlg') and 'Срок уже прошёл' in p.inner_text('#askTitle'):
            p.click('#askOk')

    def task_id(self, text):
        return self.ev("t=>(db.tasks.find(x=>x.text===t)||{}).id", text)

    def show_task(self, tid):
        """1.7.5: выполненные задачи свёрнуты в конце списка — раскрываем, если нужная задача там."""
        p = self.page
        if not p.locator(f'#tasks .task[data-id="{tid}"]').count() and p.locator('#doneToggle[aria-expanded="false"]').count():
            p.click('#doneToggle')

    def edit_task(self, text, status=None, comment=None):
        p = self.page
        p.click('nav [data-screen="tasks"]')
        tid = self.task_id(text)
        assert tid, f'задача «{text}» не найдена в активных'
        self.show_task(tid)
        p.click(f'#tasks .task[data-id="{tid}"]')
        if status:
            p.select_option('#status', status)
        if comment is not None:
            p.fill('#comment', comment)
        p.click('#form button.add')

    def accept_all(self):
        p = self.page
        p.click('nav [data-screen="tasks"]')
        if not p.is_visible('#acceptHandover'):
            return False
        p.click('#acceptHandover')
        return True

    def summary(self):
        p = self.page
        p.click('nav [data-screen="tasks"]')
        p.click('#shiftSummaryBtn')
        p.wait_for_timeout(100)
        out = {
            'subtitle': p.inner_text('#shiftSummarySubtitle'),
            'count': p.inner_text('#shiftSummaryTaskCount'),
            'tasks': [x.inner_text().replace('\n', ' | ') for x in p.query_selector_all('#shiftSummaryTasks .shift-summary-task')],
            'stats': p.inner_text('#shiftSummaryStats').replace('\n', ' '),
            'notes': p.inner_text('#shiftSummaryNotes'),
        }
        self.ev("document.querySelectorAll('dialog[open]').forEach(d=>d.close())")
        return out

    def close(self):
        for x in self.extras:
            try:
                x.close()
            except Exception:
                pass
        self.stop_main()
        self.ctx.close()
