"""
Сквозные тесты GRASS «Передача смены» на стенде (настоящие main.js + preload.js + index.html + SQLite).

  R-тесты — текущее поведение, которое должно сохраниться (регрессии).
  M-тесты — общая база в терминале (1.7.2): несколько копий программы на одной базе.
  H-тесты — «Надёжность» (1.7.3): приёмка по одной и возврат, непринятые передачи, история правок, копии, проверка базы.
  B-тесты — подтверждённые баги 1.6.1: на 1.6.1 падают, на 1.7 должны проходить.
  U-тесты — обновление базы с 1.6.1 (только для новой версии).
  G-тесты — регламент: задачи по расписанию (1.7.6).
  J-тесты — журнал смены (1.7.6).
  K-тесты — лента комментариев (1.7.6).
  Q-тесты — статистика «Скорость и сроки» (1.7.6).
  P-тесты — график смен в Настройках (1.7.6).
  W-тесты — уведомления Windows и значок в панели задач (1.7.6).
  X-тесты — выгрузка в Excel и PDF (1.7.6).
  Z-тесты — 1.7.11: вёрстка, ничего не пропало, 10 копий, проверка копий, мягкое обновление, подпункты, объявления, «Слежу», «Что нового».
  L-тесты — 1.7.11: база прошлой версии и откат на неё (только с --prev <папка прошлой версии>).

Запуск: python3 -I tests_e2e.py <папка приложения> [фильтр по имени] [--base161 <папка 1.6.1>] [--prev <папка прошлой версии>]
"""
import json
import os
import re
import sqlite3
import subprocess
import sys
import tempfile
import time
import traceback
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from stand import Stand  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

TESTS = []


def test(kind):
    def deco(fn):
        TESTS.append((kind, fn))
        return fn
    return deco


def stats_of(summary):
    """'0 ВЫПОЛНЕНО 1 ПЕРЕДАНО 0 В РАБОТЕ 0 ПРОСРОЧЕНО' -> dict"""
    out = {}
    for num, name in re.findall(r'(\d+)\s+([А-ЯЁ ]+?)(?=\s+\d|\s*$)', summary['stats'].upper()):
        out[name.strip()] = int(num)
    return out


def db_file(s):
    return os.path.join(s.user_data, 'data', 'grass.db')


def sql(s, q, *args):
    con = sqlite3.connect(f'file:{db_file(s)}?mode=ro', uri=True)
    try:
        return con.execute(q, args).fetchall()
    finally:
        con.close()


# ======================= R: текущее поведение =======================

@test('R')
def r01_task_persists_after_restart(s):
    s.open('2026-10-21T10:00:00')
    s.create_task('Проверить pH партии 1245', comment='после перемешивания', deadline='2026-10-22T12:00')
    s.open('2026-10-21T11:00:00')
    t = s.ev("db.tasks[0]")
    assert t['text'] == 'Проверить pH партии 1245', t
    assert t['comment'] == 'после перемешивания'
    assert t['status'] == 'В работе'
    assert t['deadline'] == '2026-10-22T12:00'
    assert t['author'] and t['shift'] == 'A', t
    assert s.page.is_visible(f'#tasks .task[data-id="{t["id"]}"]')


@test('R')
def r02_status_change_logged(s):
    s.open('2026-10-21T10:00:00')
    s.create_task('Задача статуса', deadline='2026-10-25T12:00')
    s.edit_task('Задача статуса', status='Выполнена')
    t = s.ev("db.tasks[0]")
    assert t['status'] == 'Выполнена' and t['deadlineStoppedAt'], t
    acts = s.ev("db.history.filter(h=>h.taskId===db.tasks[0].id).map(h=>h.action+'|'+h.details)")
    assert any(a.startswith('Изменён статус|В работе → Выполнена') for a in acts), acts


@test('R')
def r03_single_handover_and_accept(s):
    s.open('2026-10-21T10:00:00')  # день A
    s.create_task('Передача один раз', status='Передать по смене')
    t = s.ev("db.tasks[0]")
    assert t['toShift'] == 'C', t  # ночь 21.10 — смена C
    s.open('2026-10-21T21:00:00')  # ночь C
    assert s.ev("shift") == 'C'
    assert s.accept_all(), 'ночная смена не видит «Вам передали»'
    t = s.ev("db.tasks[0]")
    assert t['status'] == 'В работе' and t['toShift'] is None and t['acceptedShift'] == 'C', t
    assert s.ev("db.history[0].action") == 'Задача принята'
    s.open('2026-10-21T21:30:00')
    assert not s.page.is_visible('#acceptHandover'), 'после принятия плашка не должна возвращаться'


@test('R')
def r04_archive_and_restore(s):
    s.open('2026-10-21T10:00:00')
    s.create_task('В архив и обратно', deadline='2026-10-22T10:00')
    tid = s.task_id('В архив и обратно')
    s.page.click(f'#tasks .task[data-id="{tid}"] .task-delete')
    s.page.click('#deleteConfirm')
    assert s.ev("db.tasks.length") == 0 and s.ev("db.archive.length") == 1
    s.open('2026-10-21T11:00:00')
    assert s.ev("db.archive[0].text") == 'В архив и обратно'
    s.page.click('nav [data-screen="archive"]')
    s.page.click(f'[data-restore="{tid}"]')
    s.page.fill('#restoreDeadline', '2026-10-30T10:00')
    s.page.click('#restoreForm button.add')
    s.open('2026-10-21T12:00:00')
    t = s.ev("db.tasks[0]")
    assert t['text'] == 'В архив и обратно' and t['deadline'] == '2026-10-30T10:00' and t['status'] == 'В работе', t
    acts = s.ev("db.history.map(h=>h.action)")
    assert 'Задача перемещена в архив' in acts and 'Задача восстановлена' in acts, acts


@test('R')
def r05_clear_archive_keeps_history_and_stats(s):
    s.open('2026-10-21T10:00:00')
    s.create_task('Очистка архива')
    tid = s.task_id('Очистка архива')
    s.page.click(f'#tasks .task[data-id="{tid}"] .task-delete')
    s.page.click('#deleteConfirm')
    s.open('2026-10-21T10:30:00')  # в 1.6.1 кнопка оживает только после перезапуска (отдельный тест b12)
    s.page.click('nav [data-screen="settings"]')
    s.page.click('#clearArchiveBtn')
    s.page.click('#clearArchiveConfirm')
    s.open('2026-10-21T11:00:00')
    assert s.ev("db.archive.length") == 0
    assert tid in s.ev("db.clearedArchiveIds")
    assert any(t['id'] == tid for t in s.ev("db.statsArchive"))
    assert any(h['taskId'] == tid for h in s.ev("db.history"))


@test('R')
def r06_sites_isolated_technologists_shared(s):
    s.open('2026-10-21T10:00:00')
    s.create_task('Только Ахтуба')
    s.page.click('nav [data-screen="settings"]')
    s.page.fill('#newTechnologist', 'Общий Т.Т.')
    s.page.click('#addTechnologist')
    s.ev("localStorage.setItem('grass_selected_site','VOLZHSKY'); grassSite.set('VOLZHSKY')")
    s.open('2026-10-21T10:05:00')
    assert s.ev("grassSite.get()") == 'VOLZHSKY'
    assert s.ev("db.tasks.length") == 0, 'задача Ахтубы видна в Волжском'
    assert 'Общий Т.Т.' in s.ev("technologists"), 'список технологов не общий'
    s.create_task('Только Волжский')
    s.ev("localStorage.setItem('grass_selected_site','AHTUBA'); grassSite.set('AHTUBA')")
    s.open('2026-10-21T10:10:00')
    assert s.ev("db.tasks.map(t=>t.text)") == ['Только Ахтуба']


@test('R')
def r07_technologists_add_remove(s):
    s.open('2026-10-21T10:00:00')
    s.page.click('nav [data-screen="settings"]')
    s.page.fill('#newTechnologist', 'Новиков П.П.')
    s.page.click('#addTechnologist')
    s.open('2026-10-21T10:01:00')
    assert 'Новиков П.П.' in s.ev("technologists")
    s.page.click('nav [data-screen="settings"]')
    row = s.page.locator('.technologist-item', has_text='Новиков П.П.')
    row.locator('.technologist-delete').click()
    s.page.click('#askOk')                              # 1.7.4: своё окно вместо confirm
    s.open('2026-10-21T10:02:00')
    assert 'Новиков П.П.' not in s.ev("technologists")


@test('R')
def r08_backup_and_restore(s):
    s.open('2026-10-21T10:00:00')
    s.create_task('До бэкапа')
    s.page.click('nav [data-screen="settings"]')
    s.page.click('#createBackupBtn')
    s.page.wait_for_function("document.getElementById('backupStatus').textContent.includes('Создано')")
    name = s.page.inner_text('#backupStatus').replace('Создано:', '').strip()
    s.create_task('После бэкапа')
    s.page.click('nav [data-screen="settings"]')
    s.page.click('#restoreFromBackupBtn')
    s.page.wait_for_selector('#restoreDbDlg[open]')
    s.page.select_option('#restoreDbSelect', name)
    s.page.click('#restoreDbConfirm')
    s.page.wait_for_timeout(1500)
    s.open('2026-10-21T10:10:00')
    texts = s.ev("db.tasks.map(t=>t.text)")
    assert texts == ['До бэкапа'], texts


@test('R')
def r09_auto_archive_after_days(s):
    s.open('2026-10-21T10:00:00')
    s.page.click('nav [data-screen="settings"]')
    if not s.ev("document.getElementById('autoArchiveToggle').checked"):
        s.page.click('.settings-switch')
    assert s.ev("document.getElementById('autoArchiveToggle').checked")
    s.create_task('Выполню и забуду')
    s.edit_task('Выполню и забуду', status='Выполнена')
    s.open('2026-10-29T10:00:00')  # 8 дней спустя
    s.run_for('00:01:05')
    assert s.ev("db.archive.map(t=>t.text)") == ['Выполню и забуду'], s.ev("({t:db.tasks.map(t=>t.text),a:db.archive.map(t=>t.text)})")


@test('R')
def r10_all_screens_render(s):
    s.open('2026-10-21T10:00:00')
    s.create_task('Для экранов', deadline='2026-10-21T15:00')
    for scr in ['history', 'stats', 'archive', 'settings', 'tasks']:
        s.page.click(f'nav [data-screen="{scr}"]')
        assert s.page.is_visible(f'#screen-{scr}'), scr
    s.page.click('nav [data-screen="stats"]')
    for key in ['30d', 'all', '7d']:  # 1.7.7: кнопки переименованы («Месяц», «Неделя») — ищем по ключу периода
        s.page.click(f'[data-stats-period="{key}"]')
    sm = s.summary()
    assert sm['subtitle']
    assert 'Для экранов' in s.page.inner_text('#nearestTaskTitle')
    assert not s.page_errors, s.page_errors


@test('R')
def r11_filters_and_dashboard(s):
    s.open('2026-10-21T10:00:00')
    s.create_task('Альфа обычная')
    s.create_task('Бета выполненная')
    s.edit_task('Бета выполненная', status='Выполнена')
    s.page.fill('#search', 'альфа')
    vis = s.ev("[...document.querySelectorAll('#tasks .task h3')].map(x=>x.textContent)")
    assert vis == ['Альфа обычная'], vis
    s.page.fill('#search', '')
    s.page.click('.dash-card[data-dash-filter="done"]')
    vis = s.ev("[...document.querySelectorAll('#tasks .task h3')].map(x=>x.textContent)")
    assert vis == ['Бета выполненная'], vis
    assert s.page.inner_text('#dashAll') == '2' and s.page.inner_text('#dashDone') == '1'


@test('R')
def r12_late_handover_goes_to_current_night(s):
    s.open('2026-10-21T10:00:00')
    s.create_task('Поздняя передача')
    s.open('2026-10-21T20:20:00')
    s.run_for('00:20:00')  # 20:40 — день задержался
    s.edit_task('Поздняя передача', status='Передать по смене')
    assert s.ev("db.tasks[0].toShift") == 'C', s.ev("db.tasks[0]")
    s.open('2026-10-21T21:00:00')
    assert s.accept_all(), 'ночная смена C не видит задачу'


@test('R')
def r13_edit_comment_keeps_recipient(s):
    s.open('2026-10-21T10:00:00')
    s.create_task('Комментарий не меняет получателя', status='Передать по смене')
    before = s.ev("db.tasks[0].toShift")
    s.open('2026-10-21T19:00:00')
    s.edit_task('Комментарий не меняет получателя', comment='уточнение')
    assert s.ev("db.tasks[0].toShift") == before == 'C'


@test('R')
def r14_statistics_numbers(s):
    s.open('2026-10-19T10:00:00')
    s.create_task('Позавчера создана')
    s.open('2026-10-21T10:00:00')
    s.create_task('Сегодня 1')
    s.create_task('Сегодня 2')
    s.edit_task('Сегодня 2', status='Выполнена')
    s.open('2026-10-21T12:00:00')
    rows = s.ev("statsData('7d').map(r=>({d:r.date.getDate(),c:r.created,k:r.completed}))")
    by = {r['d']: r for r in rows}
    assert by[19]['c'] == 1 and by[21]['c'] == 2 and by[21]['k'] == 1, rows
    assert sum(r['c'] for r in rows) == 3
    snap = s.ev("statsSnapshotAt(new Date())")
    assert snap['total'] == 3 and snap['done'] == 1, snap


# ======================= B: баги 1.6.1 =======================

@test('B')
def b01_history_order_stable(s):
    s.open('2026-10-21T10:00:00')
    s.create_task('Порядок истории')
    s.open('2026-10-21T11:00:00')
    s.edit_task('Порядок истории', comment='первая правка')
    s.open('2026-10-21T12:00:00')
    s.edit_task('Порядок истории', status='Выполнена')
    for ts in ['2026-10-21T13:00:00', '2026-10-21T14:00:00', '2026-10-21T15:00:00']:
        s.open(ts)
        acts = s.ev("db.history.filter(h=>h.taskId===db.tasks[0].id).map(h=>h.action)")
        assert acts == ['Изменён статус', 'Изменена задача', 'Создана задача'], f'{ts}: {acts}'
        s.page.click('nav [data-screen="history"]')
        assert 'Изменён статус' in s.page.inner_text('#history .history-task-card p'), s.page.inner_text('#history .history-task-card')


@test('B')
def b02_history_keeps_exact_time_and_status(s):
    s.open('2026-10-21T10:00:00')
    s.create_task('Время события', status='Передать по смене')
    s.open('2026-10-21T11:00:00')
    h = s.ev("db.history.find(x=>x.action==='Передана по смене')")
    assert h.get('at'), f'нет точного времени после перезапуска: {h}'
    assert h['at'].startswith('2026-10-21T07:00'), h['at']  # 10:00 Волгоград = 07:00Z
    assert h.get('status') == 'Передать по смене', h


@test('B')
def b03_single_instance(s):
    s.stop_main()
    s.start_main({'GRASS_LOCK': '0'})
    st = s.state()
    assert st['quit'] and st['windows'] == 0, f'второй экземпляр не закрылся: {st}'
    s.stop_main()
    s.start_main()
    r = s.second_instance()
    assert r['handler'] and r['restored'] >= 1 and r['focused'] >= 1, f'окно не развернулось при повторном запуске: {r}'


@test('B')
def b04_dates_keep_year(s):
    s.open('2025-12-30T10:00:00')
    s.create_task('Декабрьская задача')
    s.open('2026-01-03T10:00:00')
    assert s.ev("parseStoredDate(db.tasks[0].date).getFullYear()") == 2025, s.ev("db.tasks[0].date")
    card = s.page.inner_text('#tasks .task')
    assert '30.12, 10:00' in card, card  # на экране привычный формат
    hist_year = s.ev("parseStoredDate(db.history[0].when).getFullYear()")
    assert hist_year == 2025, s.ev("db.history[0]")


@test('B')
def b05_shift_label_times(s):
    s.open('2026-10-21T22:00:00')
    lbl = s.page.inner_text('#currentShiftInfo')
    assert 'Ночь' in lbl and '20:30–08:30' in lbl, lbl
    s.at('2026-10-22T10:00:00')
    s.ev("renderShiftInfo()")
    lbl = s.page.inner_text('#currentShiftInfo')
    assert 'День' in lbl and '08:30–20:30' in lbl, lbl


@test('B')
def b06_auto_switch_at_2030(s):
    s.open('2026-10-21T10:00:00')
    s.create_task('Ночи', status='Передать по смене')  # получатель C
    s.open('2026-10-21T20:20:00')
    assert s.ev("shift") == 'A'
    assert not s.page.is_visible('#acceptHandover')
    s.run_for('00:20:00')  # 20:40, без перезапуска
    assert s.ev("shift") == 'C', f'смена не переключилась сама: {s.ev("shift")}'
    assert 'C' in s.page.inner_text('#shiftLabel')
    assert s.page.is_visible('#acceptHandover'), 'входящая задача для C не появилась без перезапуска'
    tech = s.ev("technologist")
    assert tech, 'технолог сбросился'


@test('B')
def b07_handover_chain(s):
    s.open('2026-10-21T10:00:00')   # день A
    s.create_task('Цепочка', status='Передать по смене')
    s.open('2026-10-21T21:00:00')   # ночь C
    assert s.accept_all(), 'C не видит'
    s.open('2026-10-22T07:00:00')
    s.edit_task('Цепочка', status='Передать по смене')
    assert s.ev("db.tasks[0].toShift") == 'D', f'C передала → {s.ev("db.tasks[0].toShift")}'
    s.open('2026-10-22T09:00:00')   # день D
    assert s.accept_all(), 'D не видит задачу после повторной передачи'
    s.open('2026-10-22T19:00:00')
    s.edit_task('Цепочка', status='Передать по смене')
    assert s.ev("db.tasks[0].toShift") == 'C'
    s.open('2026-10-22T21:00:00')   # ночь C
    assert s.accept_all(), 'C не видит после третьей передачи'
    det = s.ev("db.history.filter(h=>h.action==='Передана по смене').map(h=>h.details).reverse()")
    assert det == ['Смена A → смена C', 'Смена C → смена D', 'Смена D → смена C'], det


@test('B')
def b08_summary_status_at_shift_time(s):
    s.open('2026-10-21T22:00:00')   # ночь C создала и передала
    s.create_task('Перезапустить насос Н-3', status='Передать по смене', comment='давление 4 бар')
    s.open('2026-10-22T09:00:00')   # день D принял и выполнил
    assert s.accept_all()
    s.edit_task('Перезапустить насос Н-3', status='Выполнена')
    s.at('2026-10-22T11:00:00')
    sm = s.summary()
    st = stats_of(sm)
    assert len(sm['tasks']) == 1, sm
    assert 'Передать по смене' in sm['tasks'][0], sm['tasks']
    assert st.get('ПЕРЕДАНО') == 1 and st.get('ВЫПОЛНЕНО') == 0, st
    assert 'Выполнена' in sm['tasks'][0], 'не видно текущего статуса рядом'
    assert 'давление 4 бар' in sm['notes'], sm['notes']


@test('R')
def b09_summary_each_handover_in_its_shift(s):
    s.open('2026-10-21T10:00:00')   # день A
    s.create_task('Сводка цепочки', status='Передать по смене')
    checks = []
    s.open('2026-10-21T21:00:00')   # ночь C: сводка дня A
    checks.append(('ночь C про день A', s.summary()))
    s.accept_all()
    s.open('2026-10-22T07:00:00')
    s.edit_task('Сводка цепочки', status='Передать по смене')
    s.open('2026-10-22T09:00:00')   # день D: сводка ночи C
    checks.append(('день D про ночь C', s.summary()))
    s.accept_all()
    s.open('2026-10-22T19:00:00')
    s.edit_task('Сводка цепочки', status='Передать по смене')
    s.open('2026-10-22T21:00:00')   # ночь C: сводка дня D
    checks.append(('ночь C про день D', s.summary()))
    for name, sm in checks:
        assert len(sm['tasks']) == 1, f'{name}: {sm["tasks"]}'
        assert 'Сводка цепочки' in sm['tasks'][0] and 'Передать по смене' in sm['tasks'][0], f'{name}: {sm["tasks"]}'
        assert stats_of(sm).get('ПЕРЕДАНО') == 1, f'{name}: {sm["stats"]}'


@test('B')
def b10_summary_subtitle_time(s):
    s.open('2026-10-22T09:00:00')   # предыдущая — ночь C 21.10
    sub = s.summary()['subtitle']
    assert 'Смена C' in sub and '20:30–08:30' in sub, sub


@test('B')
def b11_save_does_not_rewrite_untouched_rows(s):
    s.open('2026-10-21T10:00:00')
    for i in range(5):
        s.create_task(f'Не трогаю {i}')
    s.create_task('Правлю')
    s.page.wait_for_timeout(200)
    con = sqlite3.connect(db_file(s), timeout=10)
    con.executescript("""
      CREATE TABLE IF NOT EXISTS _audit(tbl TEXT, op TEXT);
      CREATE TRIGGER IF NOT EXISTS _a1 AFTER DELETE ON tasks BEGIN INSERT INTO _audit VALUES('tasks','del'); END;
      CREATE TRIGGER IF NOT EXISTS _a2 AFTER INSERT ON tasks BEGIN INSERT INTO _audit VALUES('tasks','ins'); END;
      CREATE TRIGGER IF NOT EXISTS _a3 AFTER UPDATE ON tasks BEGIN INSERT INTO _audit VALUES('tasks','upd'); END;
      CREATE TRIGGER IF NOT EXISTS _a4 AFTER DELETE ON task_history BEGIN INSERT INTO _audit VALUES('hist','del'); END;
      CREATE TRIGGER IF NOT EXISTS _a5 AFTER INSERT ON task_history BEGIN INSERT INTO _audit VALUES('hist','ins'); END;
    """)
    con.commit(); con.close()
    s.edit_task('Правлю', comment='новое')
    s.page.wait_for_timeout(200)
    ops = sql(s, "SELECT tbl||':'||op, COUNT(*) FROM _audit GROUP BY 1")
    ops = dict(ops)
    # одна задача изменилась + одна запись истории добавилась
    assert ops.get('tasks:del', 0) == 0 and ops.get('hist:del', 0) == 0, f'база переписана целиком: {ops}'
    assert ops.get('tasks:upd', 0) + ops.get('tasks:ins', 0) == 1 and ops.get('hist:ins', 0) == 1, ops


@test('B')
def b12_clear_archive_button_updates(s):
    s.open('2026-10-21T10:00:00')
    s.create_task('Сразу в архив')
    tid = s.task_id('Сразу в архив')
    s.page.click(f'#tasks .task[data-id="{tid}"] .task-delete')
    s.page.click('#deleteConfirm')
    s.page.click('nav [data-screen="settings"]')
    assert not s.ev("document.getElementById('clearArchiveBtn').disabled"), s.page.inner_text('#archiveClearCount')


@test('B')
def b13_edit_keeps_accept_fields(s):
    s.open('2026-10-21T10:00:00')
    s.create_task('Поля приёма', status='Передать по смене')
    s.open('2026-10-21T21:00:00')
    s.accept_all()
    s.edit_task('Поля приёма', comment='правка после приёма')
    s.open('2026-10-21T21:30:00')
    t = s.ev("db.tasks[0]")
    assert t.get('acceptedBy') and t.get('acceptedShift') == 'C' and t.get('acceptedAt'), f'поля приёма потерялись: {t}'


@test('B')
def b14_summary_long_chain_two_days(s):
    """5 передач подряд: каждая — в сводке своей смены, ровно один раз, с верным получателем."""
    s.open('2026-10-21T10:00:00')                      # день A → C
    s.create_task('Длинная цепочка', status='Передать по смене')
    plan = [('2026-10-21T21:00:00', '2026-10-22T07:00:00', 'A', 'C', 'D'),   # ночь C → D
            ('2026-10-22T09:00:00', '2026-10-22T19:00:00', 'C', 'D', 'C'),   # день D → C
            ('2026-10-22T21:00:00', '2026-10-23T07:00:00', 'D', 'C', 'D'),   # ночь C → D
            ('2026-10-23T09:00:00', '2026-10-23T19:00:00', 'C', 'D', 'A')]   # день D → A (ночь 23.10 — A)
    for open_ts, pass_ts, prev, me, nxt in plan:
        s.open(open_ts)
        assert s.ev("shift") == me, (open_ts, s.ev("shift"))
        sm = s.summary()
        assert f'Смена {prev}' in sm['subtitle'], sm['subtitle']
        assert len(sm['tasks']) == 1 and 'Передать по смене' in sm['tasks'][0], (open_ts, sm['tasks'])
        assert f'передана смене {me}' in sm['tasks'][0], (open_ts, sm['tasks'])
        assert s.accept_all(), f'{me} не видит задачу'
        s.open(pass_ts)
        s.edit_task('Длинная цепочка', status='Передать по смене')
        assert s.ev("db.tasks[0].toShift") == nxt, (pass_ts, s.ev("db.tasks[0].toShift"))
    s.open('2026-10-23T21:00:00')                      # ночь A
    sm = s.summary()
    assert len(sm['tasks']) == 1 and 'передана смене A' in sm['tasks'][0], sm['tasks']
    assert s.accept_all()


@test('R')
def b15_summary_only_previous_shift(s):
    s.open('2026-10-21T10:00:00')                      # день A
    s.create_task('Позавчерашняя')
    s.open('2026-10-21T22:00:00')                      # ночь C
    s.create_task('Ночная')
    s.open('2026-10-22T10:00:00')                      # день D: предыдущая — ночь C
    sm = s.summary()
    names = ' '.join(sm['tasks'])
    assert 'Ночная' in names and 'Позавчерашняя' not in names, sm['tasks']


@test('R')
def b16_summary_sites_isolated(s):
    s.open('2026-10-21T22:00:00')
    s.create_task('Ахтубинская ночная', status='Передать по смене')
    s.ev("localStorage.setItem('grass_selected_site','VOLZHSKY'); grassSite.set('VOLZHSKY')")
    s.open('2026-10-21T23:00:00')
    s.create_task('Волжская ночная', status='Передать по смене')
    s.open('2026-10-22T09:00:00')
    sm = s.summary()
    assert [t.split(' | ')[0] for t in sm['tasks']] == ['Волжская ночная'], sm['tasks']
    assert s.accept_all() and s.ev("db.tasks.map(t=>t.text)") == ['Волжская ночная']
    s.ev("localStorage.setItem('grass_selected_site','AHTUBA'); grassSite.set('AHTUBA')")
    s.open('2026-10-22T09:05:00')
    sm = s.summary()
    assert [t.split(' | ')[0] for t in sm['tasks']] == ['Ахтубинская ночная'], sm['tasks']


@test('B')
def b17_summary_late_handover_in_own_shift(s):
    s.open('2026-10-21T10:00:00')
    s.create_task('Передам с опозданием')
    s.open('2026-10-21T20:20:00')
    s.run_for('00:20:00')                               # 20:40, день A задержался
    s.edit_task('Передам с опозданием', status='Передать по смене')
    s.open('2026-10-21T21:00:00')                      # ночь C смотрит сводку дня A
    sm = s.summary()
    assert len(sm['tasks']) == 1 and 'передана смене C' in sm['tasks'][0], sm['tasks']
    assert stats_of(sm).get('ПЕРЕДАНО') == 1, sm['stats']


@test('R')
def b18_summary_no_duplicates_final_state(s):
    s.open('2026-10-21T22:00:00')                      # ночь C: несколько действий с одной задачей
    s.create_task('Много действий', comment='начали')
    s.edit_task('Много действий', comment='продолжили')
    s.edit_task('Много действий', status='Выполнена', comment='готово, pH 7.2')
    s.open('2026-10-22T08:31:00')                      # 08:31 — уже день D, предыдущая — ночь C
    sm = s.summary()
    assert len(sm['tasks']) == 1, sm['tasks']
    assert 'Выполнена' in sm['tasks'][0], sm['tasks']
    st = stats_of(sm)
    assert st.get('ВЫПОЛНЕНО') == 1 and st.get('ПЕРЕДАНО') == 0, st
    assert 'готово, pH 7.2' in sm['notes'] and 'начали' not in sm['notes'], sm['notes']


# ======================= F: новые функции 1.7 =======================

def make_files(s, names_sizes):
    d = os.path.join(s.user_data, '..', os.path.basename(s.user_data) + '-src')
    os.makedirs(d, exist_ok=True)
    paths = []
    for name, content in names_sizes:
        pth = os.path.join(d, name)
        with open(pth, 'wb') as f:
            f.write(content if isinstance(content, bytes) else content.encode('utf-8'))
        paths.append(os.path.abspath(pth))
    return paths


def pick(s, paths):
    with open(os.path.join(s.user_data, '__pick.json'), 'w', encoding='utf-8') as f:
        json.dump(paths, f, ensure_ascii=False)


@test('F')
def f01_assignee_create_edit(s):
    s.open('2026-10-21T10:00:00')
    p = s.page
    p.click('#addBtn'); p.fill('#text', 'С исполнителем'); p.select_option('#assignee', 'Никулин О.В.'); p.click('#form button.add')
    s.open('2026-10-21T10:05:00')
    p = s.page
    t = s.ev("db.tasks[0]")
    assert t['assignee'] == 'Никулин О.В.' and t['author'] == 'Носиков А.Ю.', t
    assert 'Исполнитель: Никулин О.В.' in p.inner_text('#tasks .task'), p.inner_text('#tasks .task')
    assert 'исполнитель Никулин О.В.' in s.ev("db.history[0].details")
    p.click('#tasks .task'); assert p.input_value('#assignee') == 'Никулин О.В.'
    p.select_option('#assignee', 'Егоров Е.В.'); p.click('#form button.add')
    h = s.ev("db.history[0]")
    assert h['action'] == 'Назначен исполнитель' and h['details'] == 'Никулин О.В. → Егоров Е.В.', h
    assert s.ev("db.history.filter(x=>x.action==='Изменена задача').length") == 0, 'лишнее событие «Изменена задача»'


@test('F')
def f02_assignee_list_follows_technologists(s):
    s.open('2026-10-21T10:00:00')
    p = s.page
    p.click('nav [data-screen="settings"]'); p.fill('#newTechnologist', 'Новиков П.П.'); p.click('#addTechnologist')
    p.click('nav [data-screen="tasks"]'); p.click('#addBtn')
    opts = s.ev("[...document.querySelectorAll('#assignee option')].map(o=>o.value)")
    assert 'Новиков П.П.' in opts, opts
    p.fill('#text', 'Исполнитель уволится'); p.select_option('#assignee', 'Новиков П.П.'); p.click('#form button.add')
    p.click('nav [data-screen="settings"]')
    p.locator('.technologist-item', has_text='Новиков П.П.').locator('.technologist-delete').click()
    p.click('#askOk')
    s.open('2026-10-21T10:10:00')
    p = s.page
    p.click('#addBtn')
    opts = s.ev("[...document.querySelectorAll('#assignee option')].filter(o=>!o.disabled).map(o=>o.value)")
    assert 'Новиков П.П.' not in opts, 'удалённого технолога можно выбрать'
    s.ev("document.getElementById('dlg').close()")
    assert 'Исполнитель: Новиков П.П.' in p.inner_text('#tasks .task'), 'на старой задаче исполнитель пропал'
    p.click('#tasks .task')
    assert p.input_value('#assignee') == 'Новиков П.П.'
    assert s.ev("[...document.querySelectorAll('#assignee option')].find(o=>o.value==='Новиков П.П.').disabled")
    p.fill('#comment', 'правка'); p.click('#form button.add')
    assert s.ev("db.tasks[0].assignee") == 'Новиков П.П.', 'исполнитель сбросился при сохранении'


@test('F')
def f03_tech_filter_dynamic(s):
    s.open('2026-10-21T10:00:00')
    p = s.page
    p.click('nav [data-screen="settings"]'); p.fill('#newTechnologist', 'Свежий С.С.'); p.click('#addTechnologist')
    p.click('nav [data-screen="tasks"]')
    assert 'Свежий С.С.' in s.ev("[...document.querySelectorAll('#techFilter option')].map(o=>o.value)")
    p.click('#addBtn'); p.fill('#text', 'Для Свежего'); p.select_option('#assignee', 'Свежий С.С.'); p.click('#form button.add')
    s.create_task('Чужая')
    p.select_option('#techFilter', 'Свежий С.С.')
    vis = s.ev("[...document.querySelectorAll('#tasks .task h3')].map(x=>x.textContent)")
    assert vis == ['Для Свежего'], vis


@test('F')
def f04_attachments_copy_open_persist(s):
    s.open('2026-10-21T10:00:00')
    files = make_files(s, [('Протокол испытаний №5.xlsx', b'PK\x03\x04 excel'), ('фото реактора.jpg', b'\xff\xd8\xff jpeg')])
    p = s.page
    p.click('#addBtn'); p.fill('#text', 'С вложениями')
    pick(s, files); p.click('#attachAdd')
    p.wait_for_function("document.querySelectorAll('#attachList .attach-item').length===2")
    p.click('#form button.add')
    t = s.ev("db.tasks[0]")
    assert len(t['attachments']) == 2 and t['attachments'][0]['name'] == 'Протокол испытаний №5.xlsx', t['attachments']
    assert '📎 2' in p.inner_text('#tasks .task')
    assert any(h['action'] == 'Добавлено вложение' for h in s.ev("db.history"))
    for f in files: os.remove(f)                      # оригиналы удалены — вложения должны жить
    s.open('2026-10-21T11:00:00')
    p = s.page
    a = s.ev("db.tasks[0].attachments")
    full = os.path.join(s.user_data, 'data', 'attachments', a[0]['stored'])
    assert a[0]['stored'].startswith('AHTUBA/'), a[0]['stored']
    assert open(full, 'rb').read() == b'PK\x03\x04 excel'
    p.click('#tasks .task')
    p.wait_for_function("document.querySelectorAll('#attachList .attach-item').length===2")
    p.click('#attachList [data-attach-open] >> nth=0')
    p.wait_for_timeout(300)
    opened = s.state()['opened']
    assert opened and os.path.abspath(opened[-1]) == os.path.abspath(full), opened


@test('F')
def f05_attachments_travel_with_handover(s):
    s.open('2026-10-21T10:00:00')
    files = make_files(s, [('Акт.pdf', b'%PDF-1.4 akt')])
    p = s.page
    p.click('#addBtn'); p.fill('#text', 'Передам с файлом'); p.select_option('#status', 'Передать по смене')
    pick(s, files); p.click('#attachAdd'); p.wait_for_function("document.querySelectorAll('#attachList .attach-item').length===1")
    p.click('#form button.add')
    s.open('2026-10-21T21:00:00')
    assert s.accept_all()
    assert '📎 1' in s.page.inner_text('#tasks .task')
    s.page.click('#tasks .task')
    s.page.click('#attachList [data-attach-open]')
    s.page.wait_for_timeout(300)
    assert s.state()['opened'], 'ночная смена не смогла открыть вложение'


@test('F')
def f06_remove_attachment_keeps_file(s):
    s.open('2026-10-21T10:00:00')
    files = make_files(s, [('a.txt', 'один'), ('b.txt', 'два')])
    p = s.page
    p.click('#addBtn'); p.fill('#text', 'Уберу вложение'); pick(s, files); p.click('#attachAdd')
    p.wait_for_function("document.querySelectorAll('#attachList .attach-item').length===2")
    p.click('#form button.add')
    stored = s.ev("db.tasks[0].attachments[0].stored")
    p.click('#tasks .task'); p.click('#attachList [data-attach-remove="0"]'); p.click('#form button.add')
    assert s.ev("db.tasks[0].attachments.length") == 1 and '📎 1' in p.inner_text('#tasks .task')
    h = s.ev("db.history[0]")
    assert h['action'] == 'Удалено вложение' and h['details'] == 'a.txt', h
    assert os.path.exists(os.path.join(s.user_data, 'data', 'attachments', stored)), 'файл удалён с диска'


@test('F')
def f07_orphan_cleanup_only_unsaved(s):
    s.open('2026-10-21T10:00:00')
    files = make_files(s, [('черновик.txt', 'x'), ('сохранён.txt', 'y')])
    p = s.page
    p.click('#addBtn'); p.fill('#text', 'Отменю'); pick(s, [files[0]]); p.click('#attachAdd')
    p.wait_for_function("document.querySelectorAll('#attachList .attach-item').length===1")
    draft_dir = os.path.dirname(os.path.join(s.user_data, 'data', 'attachments', s.ev("dlgAttachments[0].stored")))
    p.click('#cancel')
    p.click('#addBtn'); p.fill('#text', 'Сохраню'); pick(s, [files[1]]); p.click('#attachAdd')
    p.wait_for_function("document.querySelectorAll('#attachList .attach-item').length===1")
    p.click('#form button.add')
    saved_dir = os.path.dirname(os.path.join(s.user_data, 'data', 'attachments', s.ev("db.tasks[0].attachments[0].stored")))
    old = time.time() - 3 * 86400
    for d in (draft_dir, saved_dir): os.utime(d, (old, old))
    s.open('2026-10-21T11:00:00')
    assert not os.path.exists(draft_dir), 'черновик не убран'
    assert os.path.exists(saved_dir), 'удалена папка сохранённой задачи!'


@test('F')
def f08_attachment_limits_and_safety(s):
    s.open('2026-10-21T10:00:00')
    d = os.path.join(s.user_data, '..', os.path.basename(s.user_data) + '-big'); os.makedirs(d, exist_ok=True)
    big = os.path.join(d, 'огромное видео.mp4')
    with open(big, 'wb') as f: f.truncate(101 * 1024 * 1024)
    ok = make_files(s, [('норм.txt', 'ok')])
    p = s.page
    p.click('#addBtn'); p.fill('#text', 'Лимит'); pick(s, [big] + ok); p.click('#attachAdd')
    p.wait_for_function("document.querySelectorAll('#attachList .attach-item').length===1")
    assert 'больше 100 МБ' in p.inner_text('#attachMsg'), p.inner_text('#attachMsg')
    r = s.ev("grassAttachments.open('../grass.db')")
    assert not r['ok'], r
    r = s.ev("grassAttachments.open('../../../../etc/passwd')")
    assert not r['ok'], r
    r = s.ev("grassAttachments.add('../evil')")
    assert not r['ok'], r


@test('F')
def f09_attachments_in_archive(s):
    s.open('2026-10-21T10:00:00')
    files = make_files(s, [('паспорт партии.pdf', b'%PDF')])
    p = s.page
    p.click('#addBtn'); p.fill('#text', 'В архив с файлом'); pick(s, files); p.click('#attachAdd')
    p.wait_for_function("document.querySelectorAll('#attachList .attach-item').length===1")
    p.click('#form button.add')
    tid = s.task_id('В архив с файлом')
    p.click(f'#tasks .task[data-id="{tid}"] .task-delete'); p.click('#deleteConfirm')
    p.click('nav [data-screen="archive"]')
    assert 'паспорт партии.pdf' in p.inner_text('#archive')
    p.click('#archive [data-attach-open]'); p.wait_for_timeout(300)
    assert s.state()['opened']


@test('F')
def f10_compact_dialog_button_visible(s):
    s.ctx.close()
    from stand import Stand as _S
    s2 = _S(s.browser, s.app_dir, s.user_data, viewport=(1100, 700))
    s.ctx = s2.ctx
    s.open('2026-10-21T10:00:00')
    p = s.page
    p.click('#addBtn')
    h0 = s.ev("document.getElementById('text').getBoundingClientRect().height")
    assert h0 <= 72, f'пустое поле описания слишком высокое: {h0}'
    p.fill('#text', '\n'.join(f'строка {i}' for i in range(40)))
    p.fill('#comment', '\n'.join(f'коммент {i}' for i in range(30)))
    h1 = s.ev("document.getElementById('text').getBoundingClientRect().height")
    assert 100 < h1 <= 205, f'поле не выросло или выросло без предела: {h1}'
    box = s.ev("(()=>{const b=document.getElementById('dlgSubmit').getBoundingClientRect();return {top:b.top,bottom:b.bottom,vh:innerHeight}})()")
    assert box['bottom'] <= box['vh'] and box['top'] >= 0, f'кнопка не видна: {box}'
    p.click('#dlgSubmit')
    assert s.ev("db.tasks.length") == 1
    p.click('#tasks .task')
    assert 'Сохранить изменения' in p.inner_text('#dlgSubmit')


@test('F')
def f11_noop_save_no_event(s):
    s.open('2026-10-21T10:00:00')
    s.create_task('Без изменений')
    n = s.ev("db.history.length")
    s.page.click('#tasks .task'); s.page.click('#form button.add')
    assert s.ev("db.history.length") == n, s.ev("db.history.map(h=>h.action)")


# ======================= N: изменения 1.7.1 =======================

def enable_auto_archive(s):
    s.page.click('nav [data-screen="settings"]')
    if not s.ev("document.getElementById('autoArchiveToggle').checked"):
        s.page.click('.settings-switch')
    assert s.ev("document.getElementById('autoArchiveToggle').checked")
    s.page.click('nav [data-screen="tasks"]')


def texts(s, where):
    return sorted(s.ev(f"db.{where}.map(t=>t.text)"))


@test('N')
def n01_auto_archive_created_done(s):
    """Задача, созданная сразу «Выполненной», уходит в архив через срок от создания."""
    s.open('2026-10-21T10:00:00')
    enable_auto_archive(s)
    s.create_task('Сразу выполнена', status='Выполнена')
    s.create_task('Ещё в работе')
    s.open('2026-10-27T10:00:00')                      # 6 дней — рано
    s.run_for('00:01:05')
    assert texts(s, 'archive') == [], texts(s, 'archive')
    s.open('2026-10-29T10:00:00')                      # 8 дней — пора
    s.run_for('00:01:05')
    assert texts(s, 'archive') == ['Сразу выполнена'], (texts(s, 'tasks'), texts(s, 'archive'))
    assert texts(s, 'tasks') == ['Ещё в работе']
    h = s.ev("db.history.find(h=>h.action==='Задача автоматически перемещена в архив')")
    assert h and h['author'] == 'Система', h


@test('N')
def n02_auto_archive_counts_from_last_completion(s):
    """Выполнена → снова в работу → выполнена: срок от последнего выполнения, а не от первого."""
    s.open('2026-10-10T10:00:00')
    enable_auto_archive(s)
    s.create_task('Переоткрытая', status='Выполнена')
    s.open('2026-10-11T10:00:00')
    s.edit_task('Переоткрытая', status='В работе')
    s.open('2026-10-20T10:00:00')
    s.edit_task('Переоткрытая', status='Выполнена')
    s.open('2026-10-25T10:00:00')                      # 15 дней от создания, но 5 от выполнения
    s.run_for('00:01:05')
    assert texts(s, 'archive') == [], 'ушла в архив по первому выполнению'
    s.open('2026-10-28T10:00:00')                      # 8 дней от последнего выполнения
    s.run_for('00:01:05')
    assert texts(s, 'archive') == ['Переоткрытая']


@test('N')
def n03_auto_archive_old_task_without_events(s):
    """Старая задача «Выполнена» без событий истории: срок от остановки срока (момент выполнения)."""
    s.open('2026-10-21T10:00:00')
    enable_auto_archive(s)
    s.ev("""(()=>{db.tasks.unshift({id:'old-done-1',text:'Старая без событий',status:'Выполнена',priority:'Обычный',
      comment:'',deadline:'',deadlineStoppedAt:'2026-10-01T07:00:00.000Z',author:'Носиков А.Ю.',shift:'A',
      date:'2026-10-01T07:00:00.000Z',toShift:null,lastActionBy:'Носиков А.Ю.',lastActionShift:'A',
      lastActionAt:'2026-10-01T07:00:00.000Z'});save();})()""")
    s.open('2026-10-21T10:05:00')
    s.run_for('00:01:05')
    assert texts(s, 'archive') == ['Старая без событий'], (texts(s, 'tasks'), texts(s, 'archive'))


def snap(s, ts):
    return s.ev(f"statsSnapshotAt(new Date('{ts}'))")


@test('N')
def n04_stats_snapshot_handover_accept(s):
    """Снимок статистики знает о передаче и приёмке: статус — из события, а не из текущего состояния."""
    s.open('2026-10-21T10:00:00')                      # день A создал и передал
    s.create_task('Цепочка для статистики', status='Передать по смене')
    s.open('2026-10-21T21:00:00')                      # ночь C приняла
    assert s.accept_all()
    s.open('2026-10-22T07:00:00')                      # ночь C передала дню D
    s.edit_task('Цепочка для статистики', status='Передать по смене')
    s.open('2026-10-22T09:00:00')                      # день D принял
    assert s.accept_all()
    s.open('2026-10-22T12:00:00')
    for ts, work in [('2026-10-21T12:00:00', 0),       # передана, ещё не принята
                     ('2026-10-21T22:00:00', 1),       # принята ночью
                     ('2026-10-22T08:00:00', 0),       # снова передана
                     ('2026-10-22T10:00:00', 1)]:      # принята днём
        st = snap(s, ts)
        assert st['total'] == 1 and st['work'] == work and st['done'] == 0, (ts, st)


@test('N')
def n05_stats_auto_archived_is_archive(s):
    """Автоархивированная задача в снимке — «в архиве», а не «выполнена»; созданная выполненной — в графике выполненных."""
    s.open('2026-10-21T10:00:00')
    enable_auto_archive(s)
    s.create_task('Выполнена сразу', status='Выполнена')
    s.open('2026-10-29T10:00:00')
    s.run_for('00:01:05')
    assert texts(s, 'archive') == ['Выполнена сразу']
    before = snap(s, '2026-10-22T10:00:00')
    after = snap(s, '2026-10-29T11:00:00')
    assert before['done'] == 1 and before['archived'] == 0, before
    assert after['archived'] == 1 and after['done'] == 0, after
    rows = s.ev("statsData('30d').map(r=>({d:r.date.getDate(),m:r.date.getMonth()+1,c:r.created,k:r.completed}))")
    day = [r for r in rows if r['d'] == 21 and r['m'] == 10][0]
    assert day['c'] == 1 and day['k'] == 1, day


def be(s, name):
    s.page.click('#techBtn')
    s.page.locator('#techMenu button', has_text=name).click()
    assert s.ev("technologist") == name


def tech_table(s):
    return s.ev("""[...document.querySelectorAll('#techTable tbody tr')].map(tr=>Object.fromEntries(
        [...tr.children].map(td=>[td.dataset.col, td.dataset.col==='name'?td.textContent:Number(td.textContent)])))""")


def period_totals(s):
    v = s.ev("[...document.querySelectorAll('.stats-dynamics:not(.stats-techs) .stats-summary-row strong')].map(x=>Number(x.textContent))")
    return {'created': v[0], 'completed': v[1], 'overdue': v[2]}


@test('N')
def n06_stats_by_technologist(s):
    """Таблица «По технологам» и фильтр «Технолог»: цифры сходятся с историей и между собой, сортировка по столбцам."""
    N, E = 'Носиков А.Ю.', 'Егоров Е.В.'
    s.open('2026-10-21T10:00:00')                      # день A, Носиков
    be(s, N)
    p = s.page
    p.click('#addBtn'); p.fill('#text', 'Т1 с исполнителем'); p.fill('#deadline', '2026-10-21T12:00')
    p.select_option('#assignee', E); p.click('#form button.add')
    s.create_task('Т2 передам', status='Передать по смене')
    s.create_task('Т3 сразу выполнена', status='Выполнена')
    s.open('2026-10-21T21:00:00')                      # ночь C, Егоров
    be(s, E)
    assert s.accept_all()
    s.edit_task('Т1 с исполнителем', status='Выполнена')   # после срока → просрочена на исполнителе
    p = s.page
    p.click('#addBtn'); p.fill('#text', 'Т4 Егорова'); p.select_option('#assignee', E); p.click('#form button.add')
    s.open('2026-10-22T07:00:00')
    s.edit_task('Т2 передам', status='Передать по смене')
    s.open('2026-10-22T12:00:00')
    s.page.click('nav [data-screen="stats"]')
    rows = {r['name']: r for r in tech_table(s)}
    exp = {N: dict(created=3, completed=1, passed=1, accepted=0, assigned=0, overdue=0),
           E: dict(created=1, completed=1, passed=1, accepted=1, assigned=1, overdue=1)}
    for name, want in exp.items():
        got = {k: rows[name][k] for k in want}
        assert got == want, (name, got, want)
    assert rows['Покусаев Е.С.']['created'] == 0, 'технолог без действий должен быть в таблице с нулями'
    # те же цифры — прямо из истории
    hist = s.ev("db.history.map(h=>[h.action,h.author])")
    assert sum(1 for a, au in hist if a == 'Создана задача' and au == N) == 3
    assert sum(1 for a, au in hist if a == 'Задача принята' and au == E) == 1
    # фильтр «Технолог»: итоги за период = строка таблицы
    for name in (N, E):
        s.page.select_option('#statsTechFilter', name)
        tot = period_totals(s)
        assert tot == {k: exp[name][k] for k in ('created', 'completed', 'overdue')}, (name, tot)
        assert s.page.input_value('#statsTechFilter') == name
    s.page.select_option('#statsTechFilter', '')
    assert period_totals(s)['created'] == 4, period_totals(s)
    # сортировка по каждому столбцу, в обе стороны
    for col in ['name', 'created', 'completed', 'passed', 'accepted', 'assigned', 'overdue']:
        for _ in range(2):
            s.page.click(f'[data-tech-sort="{col}"]')
            vals = [r[col] for r in tech_table(s)]
            up = s.ev("statsTechSort.dir") > 0
            key = (lambda v: v.lower()) if col == 'name' else (lambda v: v)
            assert vals == sorted(vals, key=key, reverse=not up), (col, up, vals)
    # периоды и площадки
    s.page.locator('.stats-period button', has_text='Всё время').click()
    assert {r['name']: r['created'] for r in tech_table(s)}[N] == 3
    s.ev("localStorage.setItem('grass_selected_site','VOLZHSKY'); grassSite.set('VOLZHSKY')")
    s.open('2026-10-22T12:05:00')
    s.page.click('nav [data-screen="stats"]')
    assert all(r['created'] == 0 and r['completed'] == 0 for r in tech_table(s)), tech_table(s)
    assert not s.page_errors, s.page_errors


@test('N')
def n07_stats_tech_filter_period_window(s):
    """Действие вне выбранного периода в таблицу не попадает, во «Всё время» — попадает."""
    s.open('2026-09-01T10:00:00')
    s.create_task('Давняя')
    s.open('2026-10-21T10:00:00')
    s.create_task('Свежая')
    s.page.click('nav [data-screen="stats"]')
    get = lambda: {r['name']: r['created'] for r in tech_table(s)}['Носиков А.Ю.']
    assert get() == 1, tech_table(s)
    s.page.click('[data-stats-period="30d"]')  # 1.7.7: «30 дней» теперь «Месяц»
    assert get() == 1
    s.page.locator('.stats-period button', has_text='Всё время').click()
    assert get() == 2


SPY = """(()=>{window.__sent=[];
  window.__orig=window.__orig||{patch:grassStorage.patch,setItem:grassStorage.setItem};
  const p=window.__orig.patch, s=window.__orig.setItem;
  grassStorage.patch=(k,v)=>{window.__sent.push({kind:'patch',data:JSON.parse(v)});return p.call(grassStorage,k,v)};
  grassStorage.setItem=(k,v)=>{if(k==='grass_v02')window.__sent.push({kind:'full',size:v.length});return s.call(grassStorage,k,v)};
})()"""


def db_state(s):
    """Всё, что окно держит в памяти, — для сверки с тем, что прочитается из базы после перезапуска."""
    d = s.ev("JSON.parse(JSON.stringify({tasks:db.tasks,archive:db.archive,history:db.history,statsArchive:db.statsArchive,cleared:db.clearedArchiveIds}))")
    # siteId main.js проставляет при чтении из базы — в окне у новой задачи его может не быть;
    # 1.7.12: так же учётку Windows в событии истории (osUser) пишет main.js, а не окно
    by_id = lambda lst: {str(x['id']): {k: v for k, v in x.items() if k not in ('siteId', 'osUser')} for x in lst}
    return {'tasks': by_id(d['tasks']), 'archive': by_id(d['archive']), 'history': by_id(d['history']),
            'statsArchive': by_id(d['statsArchive']), 'cleared': sorted(map(str, d['cleared']))}


def diff(a, b):
    if not isinstance(a, dict):
        return a, b
    out = {'только в памяти': sorted(set(a) - set(b)), 'только в базе': sorted(set(b) - set(a))}
    for i in set(a) & set(b):
        if a[i] != b[i]:
            x, y = a[i], b[i]
            out[i] = {f: (x.get(f), y.get(f)) for f in set(x) | set(y) if x.get(f) != y.get(f)}
    return out


@test('N')
def n08_save_sends_only_changes(s):
    """Правка одной задачи отправляет в main.js одну задачу и одно событие, а не всю базу."""
    s.open('2026-10-21T10:00:00')
    for i in range(20):
        s.create_task(f'Фоновая {i}')
    s.create_task('Правлю одну')
    s.ev(SPY)
    s.edit_task('Правлю одну', comment='новый комментарий')
    sent = s.ev("window.__sent")
    assert [x['kind'] for x in sent] == ['patch'], sent
    d = sent[0]['data']
    assert [t['task']['text'] for t in d['tasks']] == ['Правлю одну'], d['tasks']
    assert [h['action'] for h in d['historyAdd']] == ['Изменена задача'], d['historyAdd']
    assert not any(d[k] for k in ('taskDeletes', 'historyDeletes', 'stats', 'statsDeletes', 'clearedAdd', 'clearedDeletes')), d
    s.ev(SPY)
    s.page.click('#tasks .task >> nth=0'); s.page.click('#form button.add')   # сохранить без изменений
    sent = s.ev("window.__sent")
    # окно обновляет у задачи «последнее действие» — уходит только она, без событий истории
    assert len(sent) <= 1 and all(x['kind'] == 'patch' and len(x['data']['tasks']) <= 1 and not x['data']['historyAdd'] for x in sent), sent
    s.open('2026-10-21T10:30:00')
    t = s.ev("db.tasks.find(t=>t.text==='Правлю одну')")
    assert t['comment'] == 'новый комментарий' and s.ev("db.tasks.length") == 21


@test('N')
def n09_save_falls_back_to_full(s):
    """Если частичное сохранение не прошло, данные сохраняются целиком и ничего не теряется."""
    s.open('2026-10-21T10:00:00')
    s.create_task('До сбоя')
    s.ev("""(()=>{window.__sent=[];const p=grassStorage.patch,st=grassStorage.setItem;
      grassStorage.patch=(k,v)=>{window.__sent.push('patch');return {ok:false,error:'имитация сбоя'}};
      grassStorage.setItem=(k,v)=>{if(k==='grass_v02')window.__sent.push('full');return st.call(grassStorage,k,v)};
      window.__restore=()=>{grassStorage.patch=p;grassStorage.setItem=st;};})()""")
    s.create_task('Во время сбоя')
    assert s.ev("window.__sent")[:2] == ['patch', 'full'], s.ev("window.__sent")
    # частичное сохранение, которое бросает исключение, — тоже не беда
    s.ev("void (grassStorage.patch=()=>{throw new Error('обрыв')})")
    s.edit_task('Во время сбоя', comment='после исключения')
    s.ev("window.__restore()")
    s.ev(SPY)
    s.create_task('После сбоя')
    assert [x['kind'] for x in s.ev("window.__sent")] == ['patch'], 'после сбоя не вернулось частичное сохранение'
    s.open('2026-10-21T10:30:00')
    assert sorted(texts(s, 'tasks')) == sorted(['До сбоя', 'Во время сбоя', 'После сбоя']), texts(s, 'tasks')
    assert s.ev("db.tasks.find(t=>t.text==='Во время сбоя').comment") == 'после исключения'


@test('N')
def n10_saved_equals_memory_after_mixed_work(s):
    """Смена работы целиком: после перезапуска из базы читается ровно то, что было в окне."""
    s.open('2026-10-21T10:00:00')
    enable_auto_archive(s)
    for i in range(6):
        s.create_task(f'Задача {i}', status='Передать по смене' if i % 2 else None, deadline='2026-10-22T12:00' if i == 3 else None)
    s.edit_task('Задача 0', status='Выполнена')
    s.edit_task('Задача 2', comment='проверено')
    for name in ('Задача 4', 'Задача 0'):
        tid = s.task_id(name); s.show_task(tid)
        s.page.click(f'#tasks .task[data-id="{tid}"] .task-delete'); s.page.click('#deleteConfirm')
    s.page.click('nav [data-screen="archive"]')
    s.page.click(f'[data-restore="{s.ev("db.archive.find(t=>t.text===\'Задача 4\').id")}"]')
    s.page.click('#restoreForm button.add')
    s.page.click('nav [data-screen="settings"]')
    s.page.click('#clearArchiveBtn'); s.page.click('#clearArchiveConfirm')
    s.open('2026-10-21T21:00:00')
    assert s.accept_all()
    s.create_task('Ночная выполненная', status='Выполнена')
    before = db_state(s)
    s.open('2026-10-21T21:30:00')
    after = db_state(s)
    for k in before:
        assert before[k] == after[k], (k, diff(before[k], after[k]))
    s.open('2026-10-30T10:00:00')                      # автоархив тоже через частичное сохранение
    s.run_for('00:01:05')
    before = db_state(s)
    assert 'Ночная выполненная' in [t['text'] for t in before['archive'].values()]
    s.open('2026-10-30T10:05:00')
    assert db_state(s) == before


# ======================= M: общая база в терминале (1.7.2) =======================
# Несколько копий программы (у каждой свой процесс main.js, своя папка профиля и свой браузер)
# работают с одной папкой данных из grass-config.json — как пользователи терминального сервера.

def shared_env(extra=None):
    root = tempfile.mkdtemp(prefix='grass-shared-')
    data = os.path.join(root, 'data')
    cfg = os.path.join(root, 'grass-config.json')
    with open(cfg, 'w', encoding='utf-8') as f:
        json.dump({'dataDir': data}, f)
    env = {'GRASS_CONFIG_FILE': cfg, 'GRASS_TEST_FIRSTRUN': '0'}
    env.update(extra or {})
    return env, data


def team(s, n, sites=None, env=None):
    """s и ещё n-1 копий программы на одной общей базе."""
    if env is None:
        env, data = shared_env()
    else:
        data = json.load(open(env['GRASS_CONFIG_FILE'], encoding='utf-8'))['dataDir']
    s.extra_env.update(env)
    s.shared_data = data
    out = [s]
    for i in range(1, n):
        site = (sites or {}).get(i, 'AHTUBA')
        x = Stand(s.browser, s.app_dir, tempfile.mkdtemp(prefix='grass-ud-'), site=site, extra_env=env)
        x.shared_data = data
        s.extras.append(x)
        out.append(x)
    return out


def shared_db(s):
    return os.path.join(s.shared_data, 'grass.db')


def ssql(s, q, *args):
    con = sqlite3.connect(f'file:{shared_db(s)}?mode=ro', uri=True)
    try:
        return con.execute(q, args).fetchall()
    finally:
        con.close()


def swrite(s, q, *args):
    con = sqlite3.connect(shared_db(s), timeout=15)
    try:
        con.execute(q, args)
        con.commit()
    finally:
        con.close()


def pull(x):
    return x.ev("pullRemoteChanges()")


def toast_text(x):
    return x.ev("(document.getElementById('grass-toast')||{}).textContent||''")


def bar_text(x):
    return x.ev("(()=>{const el=document.getElementById('grass-save-error');return el&&!el.hidden?el.textContent:''})()")


def open_task(x, text):
    x.page.click('nav [data-screen="tasks"]')
    x.page.click(f'#tasks .task[data-id="{x.task_id(text)}"]')
    x.page.wait_for_selector('#dlg[open]')


@test('M')
def m01_everyone_sees_tasks_sites_apart(s):
    """Задачи одного технолога видят все на той же площадке (раз в 3 с и после перезапуска); площадки не смешиваются."""
    a, b, v = team(s, 3, sites={2: 'VOLZHSKY'})
    for x in (a, b, v):
        x.open('2026-10-21T10:00:00')
    be(a, 'Носиков А.Ю.'); be(b, 'Егоров Е.В.')
    a.create_task('От Носикова')
    b.create_task('От Егорова')
    v.create_task('Волжская')
    pull(a); pull(b); pull(v)
    assert texts(a, 'tasks') == texts(b, 'tasks') == ['От Егорова', 'От Носикова'], (texts(a, 'tasks'), texts(b, 'tasks'))
    assert texts(v, 'tasks') == ['Волжская'], texts(v, 'tasks')
    a.create_task('Через таймер', status='Передать по смене')
    b.run_for('00:00:04')
    assert 'Через таймер' in texts(b, 'tasks')
    assert b.page.is_visible(f'#tasks .task[data-id="{b.task_id("Через таймер")}"]')
    assert b.ev("db.history.filter(h=>h.text==='От Носикова').map(h=>h.author)") == ['Носиков А.Ю.']
    assert b.ev("db.history.filter(h=>h.text==='Через таймер').length") == 2   # создана + передана
    b.open('2026-10-21T10:10:00')
    assert texts(b, 'tasks') == ['От Егорова', 'От Носикова', 'Через таймер']
    assert ssql(a, "SELECT COUNT(*) FROM tasks WHERE site_id='AHTUBA'")[0][0] == 3
    assert ssql(a, "SELECT COUNT(*) FROM tasks WHERE site_id='VOLZHSKY'")[0][0] == 1


@test('M')
def m02_conflict_keeps_other_change(s):
    """Двое меняют одну задачу: второй не затирает первого, а получает свежую версию и сообщение."""
    a, b = team(s, 2)
    a.open('2026-10-21T10:00:00'); b.open('2026-10-21T10:00:00')
    be(a, 'Носиков А.Ю.'); be(b, 'Егоров Е.В.')
    a.create_task('Общая задача')
    pull(b)
    a.edit_task('Общая задача', comment='от Носикова')
    # b не успел подтянуть изменения и правит свою старую копию
    b.ev("(()=>{const t=db.tasks.find(x=>x.text==='Общая задача');t.comment='от Егорова';logEvent(t,'Изменена задача','тест конфликта');})()")
    assert b.ev("db.tasks.find(x=>x.text==='Общая задача').comment") == 'от Носикова'
    assert 'Носиков А.Ю.' in toast_text(b), toast_text(b)
    assert not b.ev("db.history.some(h=>h.details==='тест конфликта')")
    assert ssql(a, "SELECT comment FROM tasks WHERE text='Общая задача'")[0][0] == 'от Носикова'
    assert ssql(a, "SELECT COUNT(*) FROM task_history WHERE details='тест конфликта'")[0][0] == 0
    # теперь b правит свежую версию — сохраняется
    b.edit_task('Общая задача', comment='от Егорова')
    assert ssql(a, "SELECT comment, rev FROM tasks WHERE text='Общая задача'")[0] == ('от Егорова', 3)
    pull(a)
    assert a.ev("db.tasks.find(x=>x.text==='Общая задача').comment") == 'от Егорова'
    a.open('2026-10-21T10:20:00')
    assert a.ev("db.history.filter(h=>h.text==='Общая задача').length") == 3


@test('M')
def m03_dialog_open_while_other_saves(s):
    """Диалог открыт, а задачу сохранил другой: введённое остаётся, остальные поля — свежие, второе нажатие сохраняет."""
    a, b = team(s, 2)
    a.open('2026-10-21T10:00:00'); b.open('2026-10-21T10:00:00')
    be(a, 'Носиков А.Ю.'); be(b, 'Егоров Е.В.')
    a.create_task('Диалоговая')
    pull(b)
    open_task(a, 'Диалоговая')
    a.page.fill('#comment', 'коммент Носикова')
    b.edit_task('Диалоговая', status='Выполнена')
    a.page.click('#form button.add')
    assert a.ev("document.getElementById('dlg').open"), ('диалог должен остаться открытым', toast_text(a), a.ev("db.tasks"))
    note = a.ev("document.getElementById('dlgNotice').textContent")
    assert 'Егоров Е.В.' in note and 'Выполнена' in note, note
    assert a.ev("document.getElementById('comment').value") == 'коммент Носикова'
    assert a.ev("document.getElementById('status').value") == 'Выполнена'
    assert ssql(a, "SELECT status, comment FROM tasks WHERE text='Диалоговая'")[0] == ('Выполнена', '')
    a.page.click('#form button.add')
    assert not a.ev("document.getElementById('dlg').open")
    assert ssql(a, "SELECT status, comment FROM tasks WHERE text='Диалоговая'")[0] == ('Выполнена', 'коммент Носикова')
    acts = [r[0] for r in ssql(a, "SELECT action FROM task_history WHERE text='Диалоговая' ORDER BY at")]
    assert acts == ['Создана задача', 'Изменён статус', 'Изменена задача'], acts
    # плашка появляется и сама, когда задачу меняют при открытом диалоге
    open_task(a, 'Диалоговая')
    pull(b)
    b.edit_task('Диалоговая', comment='ещё раз')
    a.run_for('00:00:04')
    assert 'Егоров Е.В.' in a.ev("document.getElementById('dlgNotice').textContent")
    a.ev("document.getElementById('dlg').close()")


@test('M')
def m04_dialog_task_archived_by_other(s):
    """Пока диалог открыт, задачу удалили в архив: правка не воскрешает задачу."""
    a, b = team(s, 2)
    a.open('2026-10-21T10:00:00'); b.open('2026-10-21T10:00:00')
    a.create_task('Удалят')
    pull(b)
    open_task(a, 'Удалят')
    a.page.fill('#comment', 'не успел')
    tid = b.task_id('Удалят')
    b.page.click(f'#tasks .task[data-id="{tid}"] .task-delete'); b.page.click('#deleteConfirm')
    a.page.click('#form button.add')
    assert not a.ev("document.getElementById('dlg').open")
    assert 'архив' in toast_text(a), toast_text(a)
    assert texts(a, 'tasks') == [] and texts(a, 'archive') == ['Удалят']
    assert ssql(a, "SELECT state, comment FROM tasks WHERE text='Удалят'")[0] == ('archive', '')


@test('M')
def m05_accept_all_once(s):
    """«Принять все» нажали двое: задача принята один раз, второй видит, кто уже принял."""
    a, b = team(s, 2)
    a.open('2026-10-21T10:00:00')
    a.create_task('Передача 1', status='Передать по смене')
    a.create_task('Передача 2', status='Передать по смене')
    a.open('2026-10-21T21:00:00'); b.open('2026-10-21T21:00:00')
    be(a, 'Носиков А.Ю.'); be(b, 'Егоров Е.В.')
    assert b.accept_all()
    assert a.accept_all()                       # у a кнопка ещё на экране
    assert 'Уже принято другими' in toast_text(a) and 'Егоров Е.В.' in toast_text(a), toast_text(a)
    assert ssql(a, "SELECT COUNT(*) FROM task_history WHERE action='Задача принята'")[0][0] == 2
    assert ssql(a, "SELECT DISTINCT author FROM task_history WHERE action='Задача принята'") == [('Егоров Е.В.',)]
    assert a.ev("db.tasks.every(t=>t.status==='В работе'&&t.acceptedBy==='Егоров Е.В.')")


@test('M')
def m06_no_full_save_in_shared_and_retry(s):
    """В общей базе нельзя сохранить или стереть всё целиком; при сбое — красная плашка и повтор, а не полная запись."""
    a, b = team(s, 2)
    a.open('2026-10-21T10:00:00'); b.open('2026-10-21T10:00:00')
    a.create_task('Задача A'); b.create_task('Задача B')
    empty = json.dumps({'tasks': [], 'history': [], 'archive': [], 'statsArchive': [], 'clearedArchiveIds': []})
    r = a.ev("v=>grassStorage.setItem('grass_v02',v)", empty)
    assert r['ok'] is False, r
    a.ev("grassStorage.removeItem('grass_v02')"); a.ev("grassStorage.clear()")
    assert ssql(a, "SELECT COUNT(*) FROM tasks")[0][0] == 2
    a.ev(SPY)
    a.ev("""(()=>{const p=window.__orig.patch;grassStorage.patch=(k,v)=>{window.__sent.push({kind:'patch-fail'});return {ok:false,error:'имитация сбоя'}};
      window.__restore=()=>{grassStorage.patch=p;};})()""")
    a.create_task('Во время сбоя')
    assert 'имитация сбоя' in bar_text(a), bar_text(a)
    assert all(x['kind'] != 'full' for x in a.ev("window.__sent")), a.ev("window.__sent")
    assert ssql(a, "SELECT COUNT(*) FROM tasks WHERE text='Во время сбоя'")[0][0] == 0
    a.ev("window.__restore()")
    a.run_for('00:00:06')
    assert ssql(a, "SELECT COUNT(*) FROM tasks WHERE text='Во время сбоя'")[0][0] == 1
    assert 'не сохранены' not in bar_text(a)
    pull(b)
    assert texts(b, 'tasks') == ['Во время сбоя', 'Задача A', 'Задача B']


@test('M')
def m07_personal_settings_per_user(s):
    """«Кто я» и смена у каждого пользователя свои и переживают перезапуск; в общей базе их нет."""
    a, b = team(s, 2)
    a.open('2026-10-21T10:00:00'); b.open('2026-10-21T10:00:00')
    be(a, 'Рычков С.С.'); be(b, 'Степуро О.В.')
    a.open('2026-10-21T10:10:00'); b.open('2026-10-21T10:10:00')
    assert a.ev("technologist") == 'Рычков С.С.' and b.ev("technologist") == 'Степуро О.В.'
    keys = [r[0] for r in ssql(a, "SELECT key FROM settings")]
    assert not [k for k in keys if k.endswith(':technologist') or k.endswith(':shift')], keys
    prof = json.load(open(os.path.join(a.user_data, 'grass-user.json'), encoding='utf-8'))
    assert prof['values'].get('AHTUBA:technologist') == 'Рычков С.С.', prof
    assert prof.get('sharedDataDir') == s.shared_data


@test('M')
def m08_shared_settings_reach_everyone(s):
    """Список технологов и автоархив общие: правка одного доходит до других и не затирает чужую правку."""
    a, b = team(s, 2)
    a.open('2026-10-21T10:00:00'); b.open('2026-10-21T10:00:00')
    a.page.click('nav [data-screen="settings"]'); b.page.click('nav [data-screen="settings"]')
    a.page.fill('#newTechnologist', 'Новиков Н.Н.'); a.page.click('#addTechnologist')
    b.page.fill('#newTechnologist', 'Петров П.П.'); b.page.click('#addTechnologist')   # b ещё не подтянул Новикова
    stored = json.loads(ssql(a, "SELECT value FROM settings WHERE key='technologists'")[0][0])
    assert 'Новиков Н.Н.' in stored and 'Петров П.П.' in stored, stored
    a.page.click('.settings-switch')
    pull(b)
    assert b.ev("technologists.includes('Новиков Н.Н.') && autoArchiveEnabled") is True
    assert b.ev("document.getElementById('autoArchiveToggle').checked") is True


@test('M')
def m09_first_run_clean_or_import(s):
    """Первый запуск общей базы: «начать с чистой» или «загрузить существующую» (задачи и вложения переезжают)."""
    home = Stand(s.browser, s.app_dir, tempfile.mkdtemp(prefix='grass-ud-'))
    s.extras.append(home)
    home.open('2026-10-21T10:00:00')
    home.create_task('Домашняя задача')
    os.makedirs(os.path.join(home.user_data, 'data', 'attachments', 'AHTUBA', 'x1'), exist_ok=True)
    open(os.path.join(home.user_data, 'data', 'attachments', 'AHTUBA', 'x1', 'f.txt'), 'w').write('файл')
    home.stop_main()
    src = os.path.join(home.user_data, 'data', 'grass.db')
    # отмена — программа закрывается, база не создаётся
    env, data = shared_env({'GRASS_TEST_FIRSTRUN': '2'})
    c = Stand(s.browser, s.app_dir, tempfile.mkdtemp(prefix='grass-ud-'), extra_env=env)
    s.extras.append(c)
    c.start_main()
    assert c.state()['quit'] and not os.path.exists(os.path.join(data, 'grass.db'))
    c.stop_main()
    # загрузка существующей
    env, data = shared_env({'GRASS_TEST_FIRSTRUN': '1'})
    s.extra_env.update(env); s.shared_data = data
    os.makedirs(s.user_data, exist_ok=True)
    json.dump([src], open(os.path.join(s.user_data, '__pick.json'), 'w'))
    s.open('2026-10-21T11:00:00')
    assert texts(s, 'tasks') == ['Домашняя задача'], texts(s, 'tasks')
    assert s.state()['messageBoxes'] == ['В папке общей базы ещё нет данных.']
    assert os.path.exists(os.path.join(data, 'attachments', 'AHTUBA', 'x1', 'f.txt'))
    s.create_task('Уже в общей')
    assert ssql(s, "SELECT COUNT(*) FROM tasks")[0][0] == 2
    # второй запуск — вопроса больше нет; устаревшая блокировка первого запуска не мешает
    lock = os.path.join(data, 'grass.db.init-lock')
    open(lock, 'w').write('old'); old = time.time() - 3600; os.utime(lock, (old, old))
    s.open('2026-10-21T11:10:00')
    assert s.state()['messageBoxes'] == [] and texts(s, 'tasks') == ['Домашняя задача', 'Уже в общей']


def start_expect_fatal(s, user_data=None, env=None):
    x = Stand(s.browser, s.app_dir, user_data or tempfile.mkdtemp(prefix='grass-ud-'), extra_env=env or {})
    x.expect_fatal = True
    s.extras.append(x)
    x.start_main()
    st = x.state()
    x.stop_main()
    assert st['quit'], st
    return ' '.join(st['errorBoxes'])


@test('M')
def m10_clear_errors_instead_of_empty_base(s):
    """Сломанная настройка, нет доступа к папке, пропал файл настройки, база новее программы — понятная ошибка, а не пустая база."""
    root = tempfile.mkdtemp(prefix='grass-cfg-')
    bad = os.path.join(root, 'bad.json'); open(bad, 'w').write('{"dataDir": ')
    assert 'повреждён' in start_expect_fatal(s, env={'GRASS_CONFIG_FILE': bad})
    afile = os.path.join(root, 'file'); open(afile, 'w').write('x')
    cfg = os.path.join(root, 'cfg.json'); json.dump({'dataDir': afile}, open(cfg, 'w'))
    assert 'Нет доступа на запись' in start_expect_fatal(s, env={'GRASS_CONFIG_FILE': cfg})
    # пользователь уже работал с общей базой, а файл настройки пропал
    ud = tempfile.mkdtemp(prefix='grass-ud-')
    json.dump({'values': {}, 'sharedDataDir': '/srv/grass'}, open(os.path.join(ud, 'grass-user.json'), 'w'))
    msg = start_expect_fatal(s, user_data=ud)
    assert 'Не найден файл настройки' in msg and '/srv/grass' in msg, msg
    assert not os.path.exists(os.path.join(ud, 'data', 'grass.db'))
    # база новее программы
    a, = team(s, 1)
    a.open('2026-10-21T10:00:00'); a.create_task('Есть'); a.stop_main()
    swrite(a, "UPDATE app_meta SET value='99' WHERE key='schema_version'")
    assert 'более новой версией' in start_expect_fatal(s, env=a.extra_env)
    assert ssql(a, "SELECT COUNT(*) FROM tasks")[0][0] == 1


@test('M')
def m11_newer_program_makes_old_read_only(s):
    """Пока программа открыта, базу обновила новая версия: старая перестаёт писать и просит перезапуск."""
    a, = team(s, 1)
    a.open('2026-10-21T10:00:00')
    a.create_task('До обновления')
    swrite(a, "UPDATE app_meta SET value='7' WHERE key='schema_version'")
    a.create_task('После обновления')
    assert 'Программу обновили' in bar_text(a), bar_text(a)
    assert ssql(a, "SELECT text FROM tasks") == [('До обновления',)]


@test('M')
def m12_backup_once_restore_only_alone(s):
    """Дневная копия делается один раз на всех; восстановить базу можно, только когда больше никто не работает."""
    a, b = team(s, 2)
    a.open('2026-10-21T10:00:00'); b.open('2026-10-21T10:00:00')
    be(b, 'Егоров Е.В.')
    b.run_for('00:00:04')                                  # пульс с именем технолога
    a.page.wait_for_timeout(500)
    daily = [f for f in os.listdir(os.path.join(s.shared_data, 'backups')) if 'daily' in f]
    assert len(daily) == 1, daily
    a.create_task('Есть в копии')
    made = a.page.evaluate("async()=>await grassAdmin.createBackup()")
    assert made['ok'], made
    r = a.page.evaluate("async n=>await grassAdmin.restoreBackup(n)", made['name'])
    assert not r['ok'] and 'Егоров Е.В.' in r['error'], r
    info = a.page.evaluate("async()=>await grassAdmin.getDatabaseInfo()")
    assert info['shared'] and [x['technologist'] for x in info['sessions']] == ['Егоров Е.В.'], info
    b.stop_main()                                          # Егоров закрыл программу
    a.create_task('После копии')
    r = a.page.evaluate("async n=>await grassAdmin.restoreBackup(n)", made['name'])
    assert r['ok'], r
    a.open('2026-10-21T10:30:00')
    assert texts(a, 'tasks') == ['Есть в копии']
    a.open('2026-10-21T10:40:00')
    assert len([f for f in os.listdir(os.path.join(s.shared_data, 'backups')) if 'daily' in f]) == 1
    upd = a.page.evaluate("async()=>await grassAdmin.checkForUpdates()")
    assert not upd['ok'] and 'администратор' in upd['error'], upd


def bridge_sync(x, channel, *args):
    req = urllib.request.Request(f'http://127.0.0.1:{x.port}/__sync', data=json.dumps({'channel': channel, 'args': list(args)}).encode(),
                                 headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())['value']


@test('M')
def m13_ten_copies_at_once(s):
    """10 копий программы одновременно пишут в базу: ничего не теряется, одну задачу выигрывает ровно один на каждую версию."""
    team_ = team(s, 10)
    for x in team_:
        x.open('2026-10-21T10:00:00')
    team_[0].create_task('Спорная')
    common = team_[0].task_id('Спорная')
    for x in team_:
        pull(x)
    errors = []

    def worker(i, x):
        try:
            for j in range(15):
                tid = f'w{i}-{j}'
                t = {'id': tid, 'text': f'Копия {i} задача {j}', 'status': 'В работе', 'createdAt': f'2026-10-21T10:{j:02d}:{i:02d}.000Z'}
                h = {'id': f'h-{tid}', 'taskId': tid, 'text': t['text'], 'action': 'Создана задача', 'at': '2026-10-21T10:00:00.000Z'}
                r = bridge_sync(x, 'grass-db-patch', 'grass_v02', json.dumps({'tasks': [{'state': 'active', 'task': t, 'baseRev': None}], 'historyAdd': [h]}))
                if not r or not r.get('ok'):
                    errors.append((i, j, r))
            # все одновременно правят одну задачу от версии 1: должен выиграть ровно один
            t = {'id': common, 'text': 'Спорная', 'status': 'В работе', 'comment': f'от {i}'}
            r = bridge_sync(x, 'grass-db-patch', 'grass_v02', json.dumps({'tasks': [{'state': 'active', 'task': t, 'baseRev': 1}]}))
            results.append(r)
        except Exception as e:
            errors.append((i, repr(e)))

    import threading
    results = []
    th = [threading.Thread(target=worker, args=(i, x)) for i, x in enumerate(team_)]
    for t in th:
        t.start()
    for t in th:
        t.join(120)
    assert not errors, errors[:3]
    wins = [r for r in results if r.get('ok')]
    assert len(wins) == 1 and all(r.get('conflicts') for r in results if not r.get('ok')), results
    assert ssql(s, "SELECT COUNT(*) FROM tasks")[0][0] == 151
    assert ssql(s, "SELECT rev FROM tasks WHERE id=?", common)[0][0] == 2
    seqs = [r[0] for r in ssql(s, "SELECT seq FROM tasks")]
    assert len(seqs) == 151 and max(seqs) == int(ssql(s, "SELECT value FROM app_meta WHERE key='change_seq'")[0][0])
    for x in team_:
        pull(x)
        assert x.ev("db.tasks.length") == 151
    # и обычные действия через окно у всех десяти
    for i, x in enumerate(team_):
        x.create_task(f'Через окно {i}')
    for x in team_:
        pull(x)
        assert x.ev("db.tasks.filter(t=>t.text.startsWith('Через окно')).length") == 10


@test('M')
def m14_locked_base_waits_then_retries(s):
    """База надолго занята (например, копированием): изменения не теряются, а сохраняются, как только база освободится."""
    a, = team(s, 1)
    a.open('2026-10-21T10:00:00')
    a.create_task('Первая')
    con = sqlite3.connect(shared_db(a), timeout=1, isolation_level=None)
    con.execute('BEGIN EXCLUSIVE')
    try:
        a.create_task('Пока занято')                       # ждёт 10 с и не может записать
        assert 'не сохранены' in bar_text(a), bar_text(a)
    finally:
        con.execute('ROLLBACK'); con.close()
    a.run_for('00:00:06')
    assert ssql(a, "SELECT COUNT(*) FROM tasks WHERE text='Пока занято'")[0][0] == 1
    assert 'не сохранены' not in bar_text(a)
    a.open('2026-10-21T10:10:00')
    assert texts(a, 'tasks') == ['Первая', 'Пока занято']


# ======================= H: «Надёжность» (1.7.3) =======================

def incoming_texts(s):
    return sorted(s.ev("[...document.querySelectorAll('#handoverBox .handover-item b')].map(x=>x.textContent)"))


@test('H')
def h01_accept_one_return_accept_all(s):
    """Приёмка по одной, возврат с комментарием отправителю, «Принять все» — как раньше; всё видно в сводке и статистике."""
    s.open('2026-10-21T10:00:00')                      # день A передаёт три задачи ночи C
    for i in (1, 2, 3):
        s.create_task(f'Передача {i}', status='Передать по смене')
    s.open('2026-10-21T21:00:00')
    be(s, 'Егоров Е.В.')
    assert incoming_texts(s) == ['Передача 1', 'Передача 2', 'Передача 3']
    s.page.click(f'[data-accept-one="{s.task_id("Передача 1")}"]')
    assert incoming_texts(s) == ['Передача 2', 'Передача 3']
    t1 = s.ev("db.tasks.find(t=>t.text==='Передача 1')")
    assert t1['status'] == 'В работе' and t1['acceptedBy'] == 'Егоров Е.В.' and t1['acceptedShift'] == 'C', t1
    s.page.click(f'[data-return="{s.task_id("Передача 2")}"]')
    s.page.fill('#returnComment', 'нет сырья, верните утром')
    s.page.click('#returnForm button.add')
    t2 = s.ev("db.tasks.find(t=>t.text==='Передача 2')")
    assert t2['status'] == 'Передать по смене' and t2['toShift'] == 'A' and t2['fromShift'] == 'C', t2
    assert t2['returnComment'] == 'нет сырья, верните утром' and t2['returnedBy'] == 'Егоров Е.В.'
    h = s.ev("db.history[0]")
    assert h['action'] == 'Задача возвращена' and 'нет сырья' in h['details'] and h['toShift'] == 'A', h
    assert incoming_texts(s) == ['Передача 3']
    assert s.accept_all()
    assert incoming_texts(s) == []
    row = [r for r in tech_table_of(s) if r['name'] == 'Егоров Е.В.'][0]
    assert row['accepted'] == 2 and row['returned'] == 1, row
    # утром день D видит сводку ночи C: возврат с причиной
    s.open('2026-10-22T09:00:00')
    sm = s.summary()
    assert any('возвращена смене A' in x and 'нет сырья' in x for x in sm['tasks']), sm['tasks']
    # смена A получает возвращённую задачу с комментарием и принимает её
    when = s.ev("(d=>new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,19))(new Date(GrassShifts.nextWindowOf('A',new Date()).start.getTime()+3600000))")
    s.open(when)
    assert s.ev("shift") == 'A', (when, s.ev("shift"))
    assert incoming_texts(s) == ['Передача 2'], incoming_texts(s)
    assert 'нет сырья' in s.page.inner_text('#handoverBox')
    assert s.accept_all()
    t2 = s.ev("db.tasks.find(t=>t.text==='Передача 2')")
    assert t2['status'] == 'В работе' and 'returnComment' not in t2, t2
    s.open('2026-10-25T10:00:00')
    assert s.ev("db.history.filter(h=>h.action==='Задача принята').length") == 3


def tech_table_of(s):
    s.page.click('nav [data-screen="stats"]')
    out = tech_table(s)
    s.page.click('nav [data-screen="tasks"]')
    return out


@test('H')
def h02_unaccepted_handover_visible_to_all(s):
    """Смена C не приняла передачу — смена D видит её жёлтой плашкой и может принять за себя."""
    s.open('2026-10-21T10:00:00')
    s.create_task('Никто не принял', status='Передать по смене')
    assert not s.page.is_visible('#pendingBox'), 'отправитель не должен видеть плашку о своей передаче'
    s.open('2026-10-22T09:00:00')                      # день D; ночь C так и не приняла
    be(s, 'Рычков С.С.')
    assert not s.page.is_visible('#handoverBox')
    txt = s.page.inner_text('#pendingBox')
    assert 'Никто не принял' in txt and 'не принято сменой C с 20:30' in txt, txt
    s.page.click(f'[data-accept-instead="{s.task_id("Никто не принял")}"]')
    assert not s.page.is_visible('#pendingBox')
    t = s.ev("db.tasks[0]")
    assert t['status'] == 'В работе' and t['acceptedShift'] == 'D' and t['acceptedBy'] == 'Рычков С.С.', t
    h = s.ev("db.history[0]")
    assert h['action'] == 'Задача принята' and 'вместо смены C' in h['details'] and h['insteadOf'] == 'C', h
    assert s.ev("statsSnapshotAt(new Date())")['work'] == 1
    row = [r for r in tech_table_of(s) if r['name'] == 'Рычков С.С.'][0]
    assert row['accepted'] == 1, row
    s.open('2026-10-22T10:00:00')
    assert s.ev("db.tasks[0].acceptedShift") == 'D' and not s.page.is_visible('#pendingBox')


@test('H')
def h03_history_has_every_changed_field(s):
    """Правка статуса, срока и приоритета разом — в истории все три; сводка и статистика не меняются."""
    s.open('2026-10-21T10:00:00')
    s.create_task('Много правок', deadline='2026-10-22T12:00', comment='старый')
    snap_before = s.ev("statsSnapshotAt(new Date())")
    p = s.page
    p.click(f'#tasks .task[data-id="{s.task_id("Много правок")}"]')
    p.select_option('#status', 'Выполнена')
    p.fill('#deadline', '2026-10-23T15:00')
    p.click('.priorities button[data-p="Высокий"]')
    p.fill('#comment', 'новый')
    p.click('#form button.add')
    ev = s.ev("db.history.filter(h=>h.text==='Много правок').map(h=>({a:h.action,d:h.details,c:h.changes,st:h.status}))")
    assert [e['a'] for e in ev] == ['Изменена задача', 'Изменён статус', 'Создана задача'], ev
    d = ev[0]['d']
    for part in ('Срок: 22.10.2026 12:00 → 23.10.2026 15:00', 'Приоритет: Обычный → Высокий', 'Комментарий: «старый» → «новый»'):
        assert part in d, d
    assert [c['field'] for c in ev[0]['c']] == ['priority', 'deadline', 'comment'], ev[0]['c']
    assert ev[0]['st'] == 'Выполнена' and ev[1]['d'] == 'В работе → Выполнена'
    snap = s.ev("statsSnapshotAt(new Date())")
    assert snap['total'] == snap_before['total'] == 1 and snap['done'] == 1 and snap['work'] == 0, snap
    s.open('2026-10-21T21:00:00')
    sm = s.summary()
    assert stats_of(sm).get('ВЫПОЛНЕНО') == 1 and len(sm['tasks']) == 1, sm
    # только текст — одно событие с текстом «было → стало»
    s.page.click(f'#tasks .task[data-id="{s.task_id("Много правок")}"]')
    s.page.fill('#text', 'Меньше правок')
    s.page.click('#form button.add')
    assert s.ev("db.history[0].details") == 'Текст: «Много правок» → «Меньше правок»'


def backups_of(s, kind=None):
    d = os.path.join(s.user_data, 'data', 'backups')
    names = sorted(os.listdir(d)) if os.path.isdir(d) else []
    return [n for n in names if kind is None or re.match(rf'^grass-{re.escape(kind)}-\d{{4}}-', n)]


def meta(s, key):
    r = sql(s, "SELECT value FROM app_meta WHERE key=?", key)
    return r[0][0] if r else None


def wait_until(fn, timeout=8.0, step=0.2):
    end = time.time() + timeout
    while time.time() < end:
        v = fn()
        if v:
            return v
        time.sleep(step)
    return fn()


@test('H')
def h04_daily_backup_by_local_date_and_timer(s):
    """Дневная копия — по местной дате и по таймеру: программа, открытая через полночь, делает новую копию."""
    import datetime as dt
    utc = dt.datetime.now(dt.timezone.utc)
    # пояс подбираем так, чтобы местная дата точно отличалась от даты по UTC
    tz, shift_h = ('Etc/GMT-12', 12) if utc.hour >= 12 else ('Etc/GMT+12', -12)
    local = (utc + dt.timedelta(hours=shift_h)).date().isoformat()
    s.extra_env.update({'TZ': tz, 'GRASS_DAILY_CHECK_MS': '1500'})
    s.open('2026-10-21T10:00:00')
    assert wait_until(lambda: len(backups_of(s, 'daily')) == 1), backups_of(s)
    assert meta(s, 'daily_backup_date') == local, (meta(s, 'daily_backup_date'), local, utc.date())
    time.sleep(2)
    assert len(backups_of(s, 'daily')) == 1, 'в тот же день вторую копию делать не нужно'
    # «наступила полночь»: дата последней копии — вчерашняя, таймер сам делает новую
    con = sqlite3.connect(db_file(s)); con.execute("UPDATE app_meta SET value='2000-01-01' WHERE key='daily_backup_date'"); con.commit(); con.close()
    assert wait_until(lambda: len(backups_of(s, 'daily')) == 2), backups_of(s)
    assert meta(s, 'daily_backup_date') == local


@test('H')
def h05_backup_rotation_by_kind(s):
    """20 ручных копий не вытесняют ежедневную и копии перед обновлением структуры."""
    s.open('2026-10-21T10:00:00')
    assert wait_until(lambda: backups_of(s, 'daily'))
    pre = [n for n in backups_of(s) if n.startswith('grass-pre-')]
    assert pre, backups_of(s)                            # новая база проходит обновление структуры
    for _ in range(20):
        r = s.page.evaluate("async()=>await grassAdmin.createBackup()")
        assert r['ok'], r
    assert len(backups_of(s, 'manual')) == 10, backups_of(s, 'manual')
    assert len(backups_of(s, 'daily')) == 1
    assert [n for n in backups_of(s) if n.startswith('grass-pre-')] == pre
    # 16 ежедневных → остаются 14 самых новых
    d = os.path.join(s.user_data, 'data', 'backups')
    src = os.path.join(d, backups_of(s, 'daily')[0])
    for i in range(15):
        name = os.path.join(d, f'grass-daily-2026-09-{i + 1:02d}T00-00-00-000Z.db')
        open(name, 'wb').write(open(src, 'rb').read())
        os.utime(name, (time.time() - 86400 * (30 - i),) * 2)
    s.page.evaluate("async()=>await grassAdmin.createBackup()")
    daily = backups_of(s, 'daily')
    assert len(daily) == 14 and os.path.basename(src) in daily, daily
    assert 'grass-daily-2026-09-01T00-00-00-000Z.db' not in daily


@test('H')
def h06_mirror_folder_db_and_attachments(s):
    """Вторая папка: туда копия базы и вложений; из неё восстанавливаются задачи с вложениями; недоступна — предупреждение."""
    s.open('2026-10-21T10:00:00')
    src = os.path.join(s.user_data, 'отчёт.txt'); open(src, 'w', encoding='utf-8').write('данные')
    json.dump([src], open(os.path.join(s.user_data, '__pick.json'), 'w'))
    p = s.page
    p.click('#addBtn'); p.fill('#text', 'С вложением'); p.click('#attachAdd'); p.wait_for_timeout(300); p.click('#form button.add')
    stored = s.ev("db.tasks[0].attachments[0].stored")
    mirror = tempfile.mkdtemp(prefix='grass-mirror-')
    json.dump([mirror], open(os.path.join(s.user_data, '__pick.json'), 'w'))
    p.click('nav [data-screen="settings"]')
    p.click('#mirrorChoose')
    assert wait_until(lambda: 'Последняя копия' in p.inner_text('#mirrorStatus')), p.inner_text('#mirrorStatus')
    root = os.path.join(mirror, 'GRASS-backup')
    assert len(os.listdir(os.path.join(root, 'db'))) == 1
    assert os.path.exists(os.path.join(root, 'attachments', *stored.split('/')))
    assert sql(s, "SELECT value FROM settings WHERE key='backupMirrorDir'") == [(mirror,)]
    # беда: база и вложения пропали; восстанавливаем из второй папки
    s.stop_main()
    import shutil
    shutil.rmtree(os.path.join(s.user_data, 'data'))
    s.open('2026-10-21T11:00:00')
    assert texts(s, 'tasks') == []
    s.ev("v=>grassStorage.setItem('backupMirrorDir',v)", mirror)
    items = s.page.evaluate("async()=>(await grassAdmin.listBackups()).items.filter(i=>i.mirror).map(i=>i.name)")
    assert len(items) == 1 and items[0].startswith('mirror:'), items
    r = s.page.evaluate("async n=>await grassAdmin.restoreBackup(n)", items[0])
    assert r['ok'] and r['restoredFiles'] == 1, r
    s.open('2026-10-21T11:10:00')
    assert texts(s, 'tasks') == ['С вложением']
    assert os.path.exists(os.path.join(s.user_data, 'data', 'attachments', *stored.split('/')))
    # вторая папка недоступна (вместо папки — файл): предупреждение, работа продолжается
    bad = os.path.join(s.user_data, 'не-папка'); open(bad, 'w').write('x')
    s.ev("v=>grassStorage.setItem('backupMirrorDir',v)", bad)
    s.page.click('nav [data-screen="settings"]'); s.page.click('#mirrorNow')
    assert wait_until(lambda: 'Не удалось скопировать' in s.page.inner_text('#mirrorStatus')), s.page.inner_text('#mirrorStatus')
    s.create_task('Работаю дальше')
    assert sql(s, "SELECT COUNT(*) FROM tasks")[0][0] == 2
    s.open('2026-10-21T11:20:00')
    assert 'недоступна' in toast_text(s), toast_text(s)


def corrupt_db(path, table='task_history'):
    """Портим только страницы одной таблицы (схема и служебные таблицы целы — файл открывается)."""
    # 1.7.10: dbstat через node:sqlite — в Python sqlite3 на Windows его нет
    out = subprocess.check_output(['node', '--no-warnings', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'db-leaf-pages.js'), path, table], text=True)
    pages = json.loads(out)
    assert pages, 'нет страниц таблицы'
    with open(path, 'r+b') as f:
        for no in pages:
            f.seek((no - 1) * 4096 + 8); f.write(b'\xA5' * 4000)


@test('H')
def h07_corrupted_base_warns_and_restores(s):
    """Испорченный файл базы: предупреждение с кнопкой восстановления; после неё задачи на месте."""
    s.open('2026-10-21T10:00:00')
    for i in range(40):
        s.create_task(f'Задача {i} ' + 'x' * 200)
    r = s.page.evaluate("async()=>await grassAdmin.createBackup()")
    assert r['ok']
    s.create_task('После копии')
    s.stop_main()
    con = sqlite3.connect(db_file(s)); con.execute("UPDATE app_meta SET value='2000-01-01' WHERE key='db_check_date'"); con.commit(); con.close()
    for ext in ('-wal', '-shm'):
        try:
            os.remove(db_file(s) + ext)
        except FileNotFoundError:
            pass
    corrupt_db(db_file(s))
    s.extra_env['GRASS_TEST_MSGBOX'] = '1'               # если база вообще не откроется — не восстанавливать молча
    s.open('2026-10-22T10:00:00')                        # новый день — проверка базы
    shown = s.ev("!!document.getElementById('grass-load-error')||!!(document.getElementById('grass-health')&&!document.getElementById('grass-health').hidden)")
    assert shown, 'нет предупреждения о повреждённой базе'
    s.page.locator('[data-open-restore]:visible').first.click()
    s.page.wait_for_selector('#restoreDbDlg[open]')
    s.page.click('#restoreDbConfirm')
    s.page.wait_for_timeout(1500)
    s.open('2026-10-22T10:10:00')
    assert len(s.ev("db.tasks")) == 40, len(s.ev("db.tasks"))
    assert not s.page.query_selector('#grass-health:not([hidden])') and not s.page.query_selector('#grass-load-error')
    assert any(n.startswith('grass-pre-restore-') for n in backups_of(s)), 'страховочная копия повреждённой базы'


@test('H')
def h08_unopenable_base_offers_restore(s):
    """Файл базы совсем не открывается: программа предлагает восстановить последнюю копию, испорченный файл сохраняет."""
    s.open('2026-10-21T10:00:00')
    s.create_task('Была в копии')
    r = s.page.evaluate("async()=>await grassAdmin.createBackup()")
    assert r['ok']
    s.stop_main()
    for ext in ('-wal', '-shm'):
        try:
            os.remove(db_file(s) + ext)
        except FileNotFoundError:
            pass
    open(db_file(s), 'wb').write(b'not a database at all' * 500)
    s.extra_env['GRASS_TEST_MSGBOX'] = '0'
    s.open('2026-10-21T11:00:00')
    assert texts(s, 'tasks') == ['Была в копии']
    assert any('не удалось открыть' in m.lower() for m in s.state()['messageBoxes']), s.state()['messageBoxes']
    assert [n for n in os.listdir(os.path.join(s.user_data, 'data')) if n.startswith('grass-broken-')]


@test('H')
def h09_low_disk_space_warning(s):
    """Мало места на диске с базой — жёлтая плашка при запуске."""
    s.extra_env['GRASS_MIN_FREE_MB'] = str(10 ** 9)
    s.open('2026-10-21T10:00:00')
    assert 'Мало места' in s.page.inner_text('#grass-health'), s.page.inner_text('#grass-health')
    s.create_task('Работа не остановилась')
    assert sql(s, "SELECT COUNT(*) FROM tasks")[0][0] == 1


@test('H')
def h10_home_save_error_bar_and_retry(s):
    """Дома: и частичное, и полное сохранение не прошли — красная плашка и повтор, данные дописываются."""
    s.open('2026-10-21T10:00:00')
    s.ev(SPY)
    s.ev("""(()=>{const p=window.__orig.patch,st=window.__orig.setItem;
      grassStorage.patch=()=>({ok:false,error:'сбой'});
      grassStorage.setItem=(k,v)=>k==='grass_v02'?{ok:false,error:'диск недоступен'}:st.call(grassStorage,k,v);
      window.__restore=()=>{grassStorage.patch=p;grassStorage.setItem=st;};})()""")
    s.create_task('Не сохранилась сразу')
    assert 'диск недоступен' in bar_text(s), bar_text(s)
    assert sql(s, "SELECT COUNT(*) FROM tasks")[0][0] == 0
    s.ev("window.__restore()")
    s.run_for('00:00:06')
    assert sql(s, "SELECT COUNT(*) FROM tasks")[0][0] == 1
    assert 'не сохранены' not in bar_text(s)


# ======================= U: обновление с 1.6.1 =======================

# ---------------- 1.7.4: скорость и мелочи ----------------
def add_tasks_fast(s, n, prefix='Задача', archive=0):
    """n задач через тот же код, что и при создании (logEvent + save), без кликов по форме."""
    s.ev("""([n,prefix,archive])=>inBatch(()=>{
      for(let i=0;i<n;i++){
        const at=new Date().toISOString();
        const t={id:crypto.randomUUID(),text:`${prefix} ${i+1}`,status:'В работе',priority:'Обычный',comment:'',deadline:'',
          date:at,createdAt:at,author:technologist,shift,holderShift:shift,attachments:[]};
        db.tasks.unshift(t);logEvent(t,'Создана задача','Создана технологом');
        logEvent(t,'Изменена задача',`Комментарий: «» → «шаг ${i+1}»`);
      }
      for(let i=0;i<archive;i++)archiveTask(db.tasks[db.tasks.length-1].id);
    })""", [n, prefix, archive])


@test('S')
def s01_archive_history_pages_and_lazy_history(s):
    """Архив и История: по 50 карточек, кнопка «Ещё», полная история задачи строится только при раскрытии."""
    s.open('2026-10-21T10:00:00')
    add_tasks_fast(s, 130, archive=60)
    s.open('2026-10-21T10:05:00')
    assert s.ev("db.tasks.length") == 70 and s.ev("db.archive.length") == 60
    p = s.page
    p.click('nav [data-screen="archive"]')
    assert p.locator('#archive .archive-card').count() == 50
    assert p.locator('#archive .history-mini').count() == 0, 'история архива должна строиться при раскрытии'
    assert p.inner_text('#archive [data-more="archive"]') == 'Ещё 10 из 10'
    p.click('#archive [data-more="archive"]')
    assert p.locator('#archive .archive-card').count() == 60
    assert p.locator('#archive [data-more]').count() == 0
    card = p.locator('#archive .archive-card').first
    n = int(re.search(r'\((\d+)\)', card.locator('summary').inner_text()).group(1))
    assert n >= 3, n                                         # создана, изменена, в архив
    card.locator('summary').click()
    p.wait_for_function("n=>document.querySelector('#archive .archive-card').querySelectorAll('.history-mini').length===n", arg=n)
    assert 'Задача перемещена в архив' in card.inner_text()
    # История: только активные задачи (70) — 50 + «Ещё»
    p.click('nav [data-screen="history"]')
    assert p.locator('#history .history-task-card').count() == 50
    assert p.locator('#history .history-mini').count() == 0
    assert p.inner_text('#history [data-more="history"]') == 'Ещё 20 из 20'
    p.click('#history [data-more="history"]')
    assert p.locator('#history .history-task-card').count() == 70
    first = p.locator('#history .history-task-card').first
    first.locator('summary').click()
    p.wait_for_function("()=>document.querySelector('#history .history-task-card .history-mini')")
    assert first.locator('.history-mini').count() == 2 and 'шаг' in first.inner_text()
    # поиск начинает показ заново и находит задачу за пределами первой страницы
    p.fill('#historySearch', 'Задача 61')
    assert p.locator('#history .history-task-card').count() == 1
    p.fill('#historySearch', '')
    assert p.locator('#history .history-task-card').count() == 50


@test('S')
def s02_update_installs_only_by_button_with_backup(s):
    """Обновление скачивается само, ставится только по кнопке; перед установкой — копия базы с номерами версий."""
    s.extra_env['GRASS_TEST_PACKAGED'] = '1'
    s.open('2026-10-21T10:00:00')
    s.create_task('Перед обновлением')
    u = s.updater()
    assert u['autoInstallOnAppQuit'] is False and u['autoDownload'] is True, u
    r = s.page.evaluate("async()=>await grassAdmin.installUpdate()")
    assert not r['ok'] and 'не загружено' in r['error'], r
    assert s.updater()['quitAndInstall'] == 0
    u = s.updater(emit='update-downloaded', version='1.7.5')
    assert u['emitted'] and {'state': 'downloaded', 'version': '1.7.5'} in u['sent'], u
    assert s.updater()['quitAndInstall'] == 0, 'само ставиться не должно'
    version = json.load(open(os.path.join(s.app_dir, 'package.json'), encoding='utf-8'))['version']
    r = s.page.evaluate("async()=>await grassAdmin.installUpdate()")
    assert r['ok'] and r['backup'].startswith(f'grass-pre-update-{version}-to-1.7.5-'), r
    assert wait_until(lambda: s.updater()['quitAndInstall'] == 1)
    con = sqlite3.connect(os.path.join(s.user_data, 'data', 'backups', r['backup']))
    assert con.execute("SELECT COUNT(*) FROM tasks").fetchone()[0] == 1
    con.close()
    for _ in range(12):                                  # ручные копии не вытесняют копию перед обновлением
        s.page.evaluate("async()=>await grassAdmin.createBackup()")
    assert r['backup'] in backups_of(s)


@test('S')
def s03_restore_keeps_created_date(s):
    """Восстановление из архива не меняет дату создания, а показывает отдельную строку «Восстановлена»."""
    s.open('2026-10-21T10:00:00')
    s.create_task('Старая задача')
    tid = s.task_id('Старая задача')
    created = s.ev("db.tasks[0].date")
    s.page.click(f'#tasks .task[data-id="{tid}"] .task-delete'); s.page.click('#deleteConfirm')
    s.open('2026-10-23T21:15:00')
    s.page.click('nav [data-screen="archive"]')
    s.page.click(f'[data-restore="{tid}"]')
    s.page.click('#restoreForm button.add')
    s.open('2026-10-23T21:20:00')
    t = s.ev("db.tasks[0]")
    assert t['date'] == created, (t['date'], created)
    assert t['restoredAt'] and t['restoredBy'] == s.ev("technologist") and t['restoredShift'] == s.ev("shift"), t
    txt = s.page.inner_text(f'#tasks .task[data-id="{tid}"]')
    assert '21.10' in txt and 'Восстановлена: 23.10' in txt, txt
    assert s.ev("db.history.filter(h=>h.action==='Задача восстановлена').length") == 1


@test('S')
def s04_manual_shift_off_schedule_warning(s):
    """Смена выбрана вручную не по графику — предупреждение «Сейчас работает …» и кнопка «Вернуть»."""
    s.open('2026-10-21T10:00:00')
    active = s.ev("shift")
    assert s.page.is_hidden('#shiftOffWarn')
    other = 'B' if active != 'B' else 'D'
    s.page.click('#shiftBtn')
    s.page.locator('#shiftMenu button', has_text=f'Смена {other}').click()
    assert s.ev("shift") == other
    assert s.page.is_visible('#shiftOffWarn')
    assert f'Сейчас работает смена {active}' in s.page.inner_text('#shiftOffWarn')
    assert 'off-schedule' in s.page.get_attribute('#shiftBtn', 'class')
    s.page.click('#shiftBackBtn')
    assert s.ev("shift") == active and s.page.is_hidden('#shiftOffWarn')
    assert 'off-schedule' not in s.page.get_attribute('#shiftBtn', 'class')


@test('S')
def s05_own_dialogs_instead_of_confirm_alert(s):
    """Удаление технолога и дубль — свои окна; системных confirm/alert в программе нет."""
    html = open(os.path.join(s.app_dir, 'index.html'), encoding='utf-8').read()
    assert not re.search(r'(?<![\w.])(confirm|alert|prompt)\(', html), re.findall(r'.{30}(?<![\w.])(?:confirm|alert|prompt)\(.{30}', html)
    s.open('2026-10-21T10:00:00')
    p = s.page
    p.click('nav [data-screen="settings"]')
    p.fill('#newTechnologist', 'Новиков П.П.'); p.click('#addTechnologist')
    p.fill('#newTechnologist', 'новиков п.п.'); p.click('#addTechnologist')
    assert p.is_visible('#askDlg') and 'уже есть' in p.inner_text('#askDlg') and p.is_hidden('#askCancel')
    p.click('#askOk')
    assert p.is_hidden('#askDlg') and s.ev("technologists.filter(x=>x.toLowerCase()==='новиков п.п.').length") == 1
    row = p.locator('.technologist-item', has_text='Новиков П.П.')
    row.locator('.technologist-delete').click()
    assert 'Удалить технолога «Новиков П.П.»' in p.inner_text('#askDlg')
    p.click('#askCancel')
    assert 'Новиков П.П.' in s.ev("technologists")
    row.locator('.technologist-delete').click()
    p.keyboard.press('Escape')                                 # Esc = отмена
    assert p.is_hidden('#askDlg') and 'Новиков П.П.' in s.ev("technologists")
    row.locator('.technologist-delete').click()
    p.click('#askOk')
    s.open('2026-10-21T10:05:00')
    assert 'Новиков П.П.' not in s.ev("technologists")
    assert s.dialogs == [], s.dialogs


@test('S')
def s06_summary_opens_itself_and_acknowledged(s):
    """Сводка открывается сама при первом открытии после начала смены (раз за смену на технолога); «Ознакомлен» — в историю, но не действие по задаче."""
    s.open('2026-10-21T21:00:00', keep_summary=True)        # прошлая смена пустая — сводку не показываем
    assert not s.ev("$('shiftSummaryDlg').open")
    s.open('2026-10-20T21:00:00')
    s.create_task('Ночью начато')
    s.open('2026-10-21T10:00:00', keep_summary=True)        # утро: сводка ночи открылась сама
    assert s.ev("$('shiftSummaryDlg').open")
    s.ev("$('shiftSummaryDlg').close()")
    s.create_task('Днём сделано', status='Выполнена')
    s.open('2026-10-21T10:30:00', keep_summary=True)        # закрыл крестиком — в ту же смену больше не выскакивает
    assert not s.ev("$('shiftSummaryDlg').open")
    s.open('2026-10-21T20:45:00', keep_summary=True)
    assert s.ev("$('shiftSummaryDlg').open"), 'сводка должна открыться сама'
    assert 'Днём сделано' in s.page.inner_text('#shiftSummaryTasks')
    s.page.click('#shiftSummaryOk')
    assert not s.ev("$('shiftSummaryDlg').open")
    ack = s.ev("db.history.filter(h=>h.taskId==='__summary__')")
    assert len(ack) == 1 and ack[0]['action'] == 'Ознакомлен со сводкой' and ack[0]['author'] == s.ev("technologist"), ack
    s.open('2026-10-21T21:00:00', keep_summary=True)        # второй раз за смену — не открывается
    assert not s.ev("$('shiftSummaryDlg').open")
    be(s, 'Егоров Е.В.')
    s.open('2026-10-21T21:05:00', keep_summary=True)        # другой технолог — открывается для него
    assert s.ev("$('shiftSummaryDlg').open")
    s.page.click('#shiftSummaryOk')
    s.page.click('#shiftSummaryBtn'); s.page.click('#shiftSummaryOk')   # повторное «Ознакомлен» не дублирует
    assert s.ev("db.history.filter(h=>h.taskId==='__summary__').length") == 2
    s.open('2026-10-21T21:10:00')
    # не задача: нет в Истории, в сводке, в статистике технологов
    s.page.click('nav [data-screen="history"]')
    assert 'Сводка смены' not in s.page.inner_text('#history')
    assert s.ev("shiftSummaryData().rows.every(r=>r.id!=='__summary__')")
    rows = [r for r in tech_table_of(s) if r['name'] == 'Егоров Е.В.']
    assert not rows or all(v in (0, 'Егоров Е.В.') for v in rows[0].values()), rows
    s.open('2026-10-22T09:00:00', keep_summary=True)        # новая смена — сводка ночи (пустая) не показывается
    assert not s.ev("$('shiftSummaryDlg').open")


def set_priority(s, text, prio, deadline=None):
    s.ev("""([text,prio,dl])=>{const t=db.tasks.find(x=>x.text===text);t.priority=prio;if(dl)t.deadline=dl;save();render();}""", [text, prio, deadline])


@test('S')
def s07_escalation_banner_everywhere(s):
    """Высокий приоритет просрочен дольше порога — красный баннер на всех экранах; порог — общая настройка."""
    s.open('2026-10-21T08:40:00')
    s.create_task('Насос')
    s.create_task('Обычная просрочка')
    set_priority(s, 'Насос', 'Высокий', '2026-10-21T09:00')
    set_priority(s, 'Обычная просрочка', 'Обычный', '2026-10-21T06:00')
    s.open('2026-10-21T10:30:00')                            # 1,5 ч — порог 2 ч ещё не прошёл
    assert s.page.is_hidden('#escalationBar')
    s.open('2026-10-21T11:30:00')
    assert s.page.is_visible('#escalationBar')
    txt = s.page.inner_text('#escalationBar')
    assert 'Насос' in txt and 'Обычная просрочка' not in txt and 'больше 2 ч' in txt, txt
    s.page.click('nav [data-screen="stats"]')
    assert s.page.is_visible('#escalationBar')               # на всех экранах
    s.page.click('#escalationBar')
    assert s.ev("dashboardFilter") == 'overdue' and s.page.is_visible('#screen-tasks')
    s.page.click('nav [data-screen="settings"]')
    s.page.select_option('#escalationHours', '4')
    assert s.page.is_hidden('#escalationBar')
    s.open('2026-10-21T11:35:00')
    assert s.ev("escalationHours") == 4 and s.page.is_hidden('#escalationBar')
    assert sql(s, "SELECT value FROM settings WHERE key LIKE '%escalationHours'")[0][0] == '4'
    s.edit_task('Насос', status='Выполнена')
    s.open('2026-10-21T19:00:00')
    assert s.page.is_hidden('#escalationBar')


@test('S')
def s08_nomad_task_badge(s):
    """Задачу передали больше 3 раз подряд без изменений — метка «кочует»; взяли в работу (правка) — метка снята."""
    s.open('2026-10-21T10:00:00')
    s.create_task('Кочевник')
    badge = lambda: s.page.locator(f'#tasks .task[data-id="{s.task_id("Кочевник")}"] .nomad-badge').count()
    steps = ['2026-10-21T21:00:00', '2026-10-22T09:00:00', '2026-10-22T21:00:00']
    s.edit_task('Кочевник', status='Передать по смене')          # 1
    for i, ts in enumerate(steps):
        s.open(ts)
        assert s.accept_all(), ts
        assert badge() == 0, (ts, s.ev("handoversInRow(db.tasks[0])"))
        s.edit_task('Кочевник', status='Передать по смене')      # 2, 3, 4
    assert s.ev("handoversInRow(db.tasks.find(t=>t.text==='Кочевник'))") == 4
    s.open('2026-10-23T09:00:00')
    assert badge() == 1 and 'кочует' in s.page.inner_text('#tasks')
    assert s.accept_all()
    assert badge() == 1, 'одно принятие без работы метку не снимает'
    s.edit_task('Кочевник', comment='начал ремонт')
    assert badge() == 0


@test('S')
def s09_mine_card_and_search_comment_history(s):
    """Карточка «Мои» — задачи, где исполнитель текущий технолог; поиск по названию, комментарию и истории."""
    s.open('2026-10-21T10:00:00')
    me = s.ev("technologist")
    p = s.page
    for text, who in (('Моя задача', me), ('Чужая задача', 'Егоров Е.В.'), ('Без исполнителя', '')):
        p.click('#addBtn'); p.fill('#text', text)
        if who:
            p.select_option('#assignee', who)
        p.click('#form button.add')
    s.edit_task('Чужая задача', comment='заменить подшипник на линии 3')
    s.ev("(()=>{const t=db.tasks.find(x=>x.text==='Без исполнителя');t.text='Новое имя';logEvent(t,'Изменена задача','Текст: «Старое имя» → «Новое имя»');render();})()")
    assert p.inner_text('#dashMine') == '1', s.ev("db.tasks.map(t=>[t.text,t.assignee,t.status])")
    p.click('.dash-card[data-dash-filter="mine"]')
    assert [x.inner_text() for x in p.query_selector_all('#tasks .task h3')] == ['Моя задача']
    p.click('.dash-card[data-dash-filter="all"]')
    p.fill('#search', 'подшипник')
    assert [x.inner_text() for x in p.query_selector_all('#tasks .task h3')] == ['Чужая задача']
    p.fill('#search', 'старое имя')
    assert [x.inner_text() for x in p.query_selector_all('#tasks .task h3')] == ['Новое имя']
    p.fill('#search', '')
    s.edit_task('Моя задача', status='Выполнена')
    assert p.inner_text('#dashMine') == '0'
    be(s, 'Егоров Е.В.')
    assert p.inner_text('#dashMine') == '1'


@test('S')
def s10_purge_files_of_cleared_archive(s):
    """Размер вложений в настройках; файлы задач, очищенных из архива, удаляются по кнопке — после копии базы, с запасом на 30 дней."""
    s.open('2026-10-21T10:00:00')
    p = s.page
    att = os.path.join(s.user_data, 'data', 'attachments')
    for name in ('Очищу', 'Оставлю'):
        src = os.path.join(s.user_data, f'{name}.txt'); open(src, 'w', encoding='utf-8').write('x' * 5000)
        json.dump([src], open(os.path.join(s.user_data, '__pick.json'), 'w'))
        p.click('#addBtn'); p.fill('#text', name); p.click('#attachAdd'); p.wait_for_timeout(300); p.click('#form button.add')
    gone = s.ev("db.tasks.find(t=>t.text==='Очищу').attachments[0].stored")
    keep = s.ev("db.tasks.find(t=>t.text==='Оставлю').attachments[0].stored")
    for name in ('Очищу', 'Оставлю'):
        tid = s.task_id(name); p.click(f'#tasks .task[data-id="{tid}"] .task-delete'); p.click('#deleteConfirm')
    p.click('nav [data-screen="settings"]')
    assert wait_until(lambda: 'КБ' in p.inner_text('#dbInfoAttach')), p.inner_text('#dbInfoAttach')
    assert p.inner_text('#purgeAttachCount') == 'нет' and p.is_disabled('#purgeAttachBtn')
    # восстановим «Оставлю», очистим архив — останется одна очищенная задача с файлом
    p.click('nav [data-screen="archive"]')
    p.click(f'[data-restore="{s.ev("db.archive.find(t=>t.text===\'Оставлю\').id")}"]'); p.click('#restoreForm button.add')
    p.click('nav [data-screen="settings"]')
    p.click('#clearArchiveBtn'); p.click('#clearArchiveConfirm')
    assert wait_until(lambda: p.inner_text('#purgeAttachCount').startswith('1 файл')), p.inner_text('#purgeAttachCount')
    manual_before = len(backups_of(s, 'manual'))
    p.click('#purgeAttachBtn')
    p.wait_for_selector('#askDlg[open]')
    assert 'Удалить файлы очищенных задач' in p.inner_text('#askDlg')
    p.click('#askOk')
    assert wait_until(lambda: not os.path.exists(os.path.join(att, *gone.split('/'))))
    assert os.path.exists(os.path.join(att, *keep.split('/'))), 'файлы живой задачи трогать нельзя'
    assert len(backups_of(s, 'manual')) == manual_before + 1
    stash = os.path.join(s.user_data, 'data', 'backups', 'removed-attachments')
    found = [os.path.join(r, f) for r, _, fs in os.walk(stash) for f in fs]
    assert len(found) == 1 and found[0].endswith('Очищу.txt'), found
    assert wait_until(lambda: p.inner_text('#purgeAttachCount') == 'нет')
    s.open('2026-10-21T10:10:00')
    p = s.page
    p.click(f'#tasks .task[data-id="{s.task_id("Оставлю")}"]')
    assert 'Оставлю.txt' in p.inner_text('#attachList')


@test('U')
def u01_upgrade_from_161(s, base161=None):
    assert base161, 'нужен --base161'
    new_app = s.app_dir
    s.app_dir = base161
    s.open('2025-12-30T10:00:00')
    s.create_task('Старая декабрьская', deadline='2026-01-05T10:00')
    s.open('2026-01-02T22:00:00')
    s.create_task('Старая переданная', status='Передать по смене', comment='из 1.6.1')
    s.page.click('nav [data-screen="settings"]')
    s.page.fill('#newTechnologist', 'Ветеран В.В.')
    s.page.click('#addTechnologist')
    tid = s.task_id('Старая декабрьская')
    s.page.click('nav [data-screen="tasks"]')
    s.page.click(f'#tasks .task[data-id="{tid}"] .task-delete')
    s.page.click('#deleteConfirm')
    old = {'tasks': s.ev("db.tasks.map(t=>t.text)"), 'archive': s.ev("db.archive.map(t=>t.text)"), 'hist': s.ev("db.history.length")}
    s.stop_main()
    # ставим 1.7 поверх
    s.app_dir = new_app
    s.open('2026-01-03T09:00:00')
    assert s.ev("db.tasks.map(t=>t.text)") == old['tasks'], (s.ev("db.tasks.map(t=>t.text)"), old)
    assert s.ev("db.archive.map(t=>t.text)") == old['archive']
    assert s.ev("db.history.length") == old['hist']
    assert 'Ветеран В.В.' in s.ev("technologists")
    assert s.ev("parseStoredDate(db.archive[0].date).getFullYear()") == 2025, s.ev("db.archive[0].date")
    hs = s.ev("db.history")
    assert all(h.get('at') for h in hs), [h for h in hs if not h.get('at')]
    assert [h['action'] for h in hs if h['taskId'] == s.task_id('Старая переданная')][-1] == 'Создана задача'
    backups = os.listdir(os.path.join(s.user_data, 'data', 'backups'))
    assert any('pre-migration-v5' in b for b in backups), backups
    assert s.accept_all() is not None
    sm = s.summary()
    assert any('Старая переданная' in t for t in sm['tasks']), sm
    assert not s.page_errors, s.page_errors


@test('U')
def u02_restore_old_backup_inside_17(s, base161=None):
    assert base161
    new_app = s.app_dir
    s.app_dir = base161
    s.open('2026-10-20T10:00:00')
    s.create_task('Была в бэкапе 1.6.1')
    s.page.click('nav [data-screen="settings"]')
    s.page.click('#createBackupBtn')
    s.page.wait_for_function("document.getElementById('backupStatus').textContent.includes('Создано')")
    name = s.page.inner_text('#backupStatus').replace('Создано:', '').strip()
    s.stop_main()
    s.app_dir = new_app
    s.open('2026-10-21T10:00:00')
    s.create_task('Сделана в 1.7')
    s.page.click('nav [data-screen="settings"]')
    s.page.click('#restoreFromBackupBtn')
    s.page.wait_for_selector('#restoreDbDlg[open]')
    s.page.select_option('#restoreDbSelect', name)
    s.page.click('#restoreDbConfirm')
    s.page.wait_for_timeout(1500)
    s.open('2026-10-21T10:10:00')
    assert s.ev("db.tasks.map(t=>t.text)") == ['Была в бэкапе 1.6.1'], s.ev("db.tasks.map(t=>t.text)")
    assert s.ev("parseStoredDate(db.tasks[0].date).getFullYear()") == 2026
    assert all(h.get('at') for h in s.ev("db.history"))
    s.create_task('После восстановления')
    s.open('2026-10-21T10:20:00')
    assert s.ev("db.tasks.length") == 2


# ---------------- 1.7.5: новый дизайн ----------------

def heads(s):
    return s.ev("[...document.querySelectorAll('#tasks .task-group-head span')].map(x=>x.textContent)")


def titles(s):
    return s.ev("[...document.querySelectorAll('#tasks .task h3')].map(x=>x.textContent)")


@test('D')
def d01_groups_overdue_soon_rest_done_collapsed(s):
    """П. 39: «Просрочено», «Скоро срок», остальные; выполненные свёрнуты в конце."""
    s.open('2026-10-21T10:00:00')
    s.create_task('Обычная')
    s.create_task('Горит', deadline='2026-10-21T09:00')
    s.create_task('Скоро', deadline='2026-10-21T11:00')
    s.create_task('Сделана'); s.edit_task('Сделана', status='Выполнена')
    assert heads(s) == ['Просрочено', 'Скоро срок', 'Остальные'], heads(s)
    assert titles(s) == ['Горит', 'Скоро', 'Обычная'], titles(s)
    tg = s.page.inner_text('#doneToggle')
    assert 'Выполненные · 1' in tg and 'показать' in tg, tg
    s.page.click('#doneToggle')
    assert titles(s)[-1] == 'Сделана' and 'свернуть' in s.page.inner_text('#doneToggle')
    s.page.click('#doneToggle')
    assert 'Сделана' not in titles(s)
    # фильтр «Выполнено» и поиск показывают выполненные без раскрытия
    s.page.click('[data-dash-filter="done"]')
    assert titles(s) == ['Сделана'], titles(s)
    s.page.click('[data-dash-filter="all"]')
    s.page.fill('#search', 'Сдел')
    assert titles(s) == ['Сделана'], titles(s)
    s.page.fill('#search', '')
    # одна группа — без заголовков
    for n in ('Горит', 'Скоро'):
        s.edit_task(n, status='Выполнена')
    assert heads(s) == [] and titles(s) == ['Обычная'], (heads(s), titles(s))


@test('D')
def d02_quick_actions_same_as_dialog(s):
    """П. 40: «Выполнено», «Передать по смене», «Взять себе» при наведении пишут то же, что окно задачи."""
    s.open('2026-10-21T10:00:00')
    for n in ('Через окно', 'Быстро', 'Передам', 'Возьму'):
        s.create_task(n)
    p = s.page
    card = lambda n: f'#tasks .task[data-id="{s.task_id(n)}"]'
    assert not p.is_visible(card('Быстро') + ' [data-quick="done"]')   # без наведения кнопок не видно
    p.hover(card('Быстро'))
    p.click(card('Быстро') + ' [data-quick="done"]')
    assert not p.is_visible('#dlg'), 'быстрое действие не должно открывать окно'
    s.edit_task('Через окно', status='Выполнена')
    hist = lambda n: s.ev("id=>db.history.filter(h=>h.taskId===id).map(h=>h.action+'|'+h.details)", s.task_id(n))
    a, b = hist('Быстро'), hist('Через окно')
    assert len(a) == len(b) == 2 and a[0].split('|')[0] == b[0].split('|')[0], (a, b)
    assert s.ev("db.tasks.find(t=>t.text==='Быстро').status") == 'Выполнена'
    p.hover(card('Передам')); p.click(card('Передам') + ' [data-quick="pass"]')
    assert s.ev("db.tasks.find(t=>t.text==='Передам').status") == 'Передать по смене'
    be(s, 'Егоров Е.В.')
    p.hover(card('Возьму')); p.click(card('Возьму') + ' [data-quick="take"]')
    t = s.ev("db.tasks.find(t=>t.text==='Возьму')")
    assert t['assignee'] == 'Егоров Е.В.' and t['status'] == 'В работе', t
    assert any('исполнитель' in h.lower() for h in hist('Возьму')), hist('Возьму')
    s.open('2026-10-21T10:05:00')
    assert s.ev("db.tasks.find(t=>t.text==='Возьму').assignee") == 'Егоров Е.В.'


@test('D')
def d03_counters_zero_dim_overdue_pulse(s):
    """П. 41: нули тусклые, «Просрочены» пульсирует, если не ноль; без анимации при reduced-motion."""
    s.open('2026-10-21T10:00:00')
    cls = lambda f: s.ev("f=>document.querySelector(`[data-dash-filter=\"${f}\"]`).className", f)
    assert 'zero' in cls('overdue') and 'pulse' not in cls('overdue')
    s.create_task('Горит', deadline='2026-10-21T09:00')
    assert 'pulse' in cls('overdue') and 'zero' not in cls('overdue'), cls('overdue')
    assert 'zero' in cls('done') and 'zero' not in cls('all')
    anim = lambda: s.ev("getComputedStyle(document.querySelector('[data-dash-filter=\"overdue\"]')).animationName")
    assert anim() == 'gpulse', anim()
    s.page.emulate_media(reduced_motion='reduce')
    assert anim() == 'none', anim()


@test('D')
def d04_handover_warning_tile_and_setting(s):
    """П. 42: за N минут до передачи плашка смены жёлтая; N личная настройка, можно выключить."""
    s.open('2026-10-21T19:20:00')
    p = s.page
    soon = lambda: s.ev("document.getElementById('shiftTile').classList.contains('handover-soon')")
    assert not soon() and p.is_hidden('#handoverSoon')       # по умолчанию 1 час, до 20:30 ещё 70 мин
    s.at('2026-10-21T19:40:00'); s.run_for('00:00:02')
    assert soon() and 'Через 50 мин передача' in p.inner_text('#handoverSoon'), p.inner_text('#handoverSoon')
    p.click('nav [data-screen="settings"]'); p.select_option('#handoverWarn', '30')
    p.click('nav [data-screen="tasks"]')
    assert not soon()
    p.click('nav [data-screen="settings"]'); p.select_option('#handoverWarn', '120')
    s.open('2026-10-21T19:40:00'); p = s.page
    assert soon() and s.ev("document.getElementById('handoverWarn').value") == '120'
    be(s, 'Егоров Е.В.')
    assert s.ev("document.getElementById('handoverWarn').value") == '60', 'настройка личная'
    p.click('nav [data-screen="settings"]'); p.select_option('#handoverWarn', '0')
    p.click('nav [data-screen="tasks"]')
    assert not soon()
    s.at('2026-10-21T20:35:00'); s.run_for('00:00:02')
    assert not soon()


@test('D')
def d05_density_personal_and_remembered(s):
    """П. 43: «Обычно / Компактно» над списком и в Настройках, личная, переживает перезапуск."""
    s.open('2026-10-21T10:00:00')
    s.create_task('Первая', comment='подробности')
    p = s.page
    compact = lambda: s.ev("document.getElementById('tasks').classList.contains('compact')")
    assert not compact()
    p.click('#taskPanel [data-density="compact"]')
    assert compact() and not p.is_visible('#tasks .task .task-comment')
    assert s.ev("document.querySelector('.view-card [data-density=\"compact\"]').classList.contains('on')")
    h = s.ev("document.querySelector('#tasks .task').getBoundingClientRect().height")
    assert h < 50, h
    p.hover('#tasks .task'); assert p.is_visible('#tasks .task .task-details')
    s.open('2026-10-21T10:05:00'); p = s.page
    assert compact(), 'плотность не запомнилась'
    be(s, 'Егоров Е.В.')
    assert not compact(), 'плотность должна быть своя у каждого технолога'
    p.click('nav [data-screen="settings"]'); p.click('.view-card [data-density="compact"]')
    p.click('nav [data-screen="tasks"]'); assert compact()
    p.click('#taskPanel [data-density="normal"]'); assert not compact()


@test('D')
def d06_empty_screen_with_buttons(s):
    """П. 44: пустой экран — заглушка с кнопкой «Добавить первую задачу»."""
    s.open('2026-10-21T10:00:00')
    p = s.page
    assert p.is_visible('#emptyState') and p.is_hidden('#taskPanel')
    p.click('#emptyAdd'); assert p.is_visible('#dlg')
    p.fill('#text', 'Первая'); p.click('#form button.add')
    assert p.is_hidden('#emptyState') and p.is_visible('#taskPanel') and titles(s) == ['Первая']
    p.fill('#search', 'нет такой')
    assert p.is_hidden('#emptyState') and p.is_visible('#empty'), 'при поиске — обычное «Ничего не найдено»'
    p.fill('#search', '')
    tid = s.task_id('Первая'); p.click(f'#tasks .task[data-id="{tid}"] .task-delete'); p.click('#deleteConfirm')
    assert p.is_visible('#emptyState')
    p.click('#emptySummary'); p.wait_for_selector('#shiftSummaryDlg[open]')


@test('D')
def d07_nothing_lost_from_174(s):
    """Правило Сани: ни одна кнопка и поле 1.7.4 не пропали; разделы в левом меню, фильтры в основной части."""
    s.open('2026-10-21T10:00:00')
    ids = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'ids_1.7.4.txt'), encoding='utf-8').read().split()
    missing = s.ev("ids=>ids.filter(i=>!document.getElementById(i))", ids)
    assert not missing, 'пропали: ' + ', '.join(missing)
    # 1.7.6: добавлен раздел «Журнал» (после «Задачи»), прежние разделы на месте и в том же порядке
    screens = s.ev("[...document.querySelectorAll('#sidebar nav [data-screen]')].map(b=>b.dataset.screen)")
    assert [x for x in screens if x != 'journal'] == ['tasks', 'history', 'stats', 'archive', 'settings'], screens
    for i in ('addBtn', 'techBtn', 'shiftBtn', 'changeSiteBtn', 'siteBadge'):
        assert s.ev("i=>!!document.getElementById(i).closest('#sidebar')", i), i
    for i in ('search', 'priorityFilter', 'shiftFilter', 'techFilter', 'handoverBox', 'pendingBox'):
        assert s.ev("i=>!!document.getElementById(i).closest('#screen-tasks')", i), i
    assert s.ev("document.querySelectorAll('.mini-dashboard [data-dash-filter]').length") == 9
    assert s.ev("getComputedStyle(document.getElementById('sidebar')).position") == 'sticky'
    # кнопки статуса и список статусов всегда согласованы
    p = s.page
    s.create_task('Статус')
    p.click(f'#tasks .task[data-id="{s.task_id("Статус")}"]')
    sel = lambda: s.ev("[...document.querySelectorAll('#statusButtons [data-status].selected')].map(b=>b.dataset.status)")
    assert sel() == ['В работе'], sel()
    p.click('#statusButtons [data-status="Передать по смене"]')
    assert p.input_value('#status') == 'Передать по смене' and sel() == ['Передать по смене']
    p.select_option('#status', 'Не в работе'); assert sel() == ['Не в работе']
    p.click('#form button.add')
    assert s.ev("db.tasks[0].status") == 'Не в работе'
    # шрифты свои, из папки программы
    fams = s.ev("document.fonts.check('16px \"Exo 2\"') && document.fonts.check('16px Manrope')")
    assert fams
    assert s.ev("getComputedStyle(document.querySelector('#screen-tasks h1')).fontFamily").startswith('"Exo 2"')


# ======================= G: регламент (1.7.6, п. 24) =======================

def add_template(s, title, kind='shift', deadline=None, mode=None, days=(), comment=None, n=None, anchor=None):
    """Шаблон через окно в Настройках, как это делает технолог."""
    p = s.page
    p.click('nav [data-screen="settings"]')
    p.click('#regAdd')
    p.fill('#regTitle', title)
    p.select_option('#regKind', kind)
    if mode:
        p.select_option('#regMode', mode)
    for d in days:
        p.check(f'[data-reg-day="{d}"]')
    if n is not None:
        p.fill('#regN', str(n))
    if anchor:
        p.fill('#regAnchor', anchor)
    if deadline is not None:
        p.fill('#regDeadline', str(deadline))
    if comment is not None:
        p.fill('#regComment', comment)
    p.click('#regSave')
    assert p.is_hidden('#regDlg'), p.inner_text('#regPreview')
    return s.ev("t=>(GrassRegUi.templates().find(x=>x.title===t)||{}).id", title)


def reg_tasks(s):
    return s.ev("db.tasks.filter(t=>t.regId).map(t=>[t.id.split('-').pop(),t.status,t.author,t.shift]).sort()")


@test('G')
def g01_task_by_schedule_once_with_deadline(s):
    """Шаблон «каждую смену»: задача появляется сразу, автор «Регламент», срок от начала смены; перезапуск дубля не делает."""
    s.open('2026-10-21T09:00:00')
    rid = add_template(s, 'Отбор проб на линии 2', deadline=3, comment='Пробы в лабораторию')
    assert reg_tasks(s) == [['202610210830', 'В работе', 'Регламент', 'A']], reg_tasks(s)
    t = s.ev("id=>db.tasks.find(x=>x.id===id)", f'reg-{rid}-202610210830')
    assert t['deadline'] == '2026-10-21T11:30' and t['comment'] == 'Пробы в лабораторию', t
    h = s.ev("id=>db.history.filter(h=>h.taskId===id).map(h=>[h.action,h.author,h.details])", t['id'])
    assert len(h) == 1 and h[0][:2] == ['Создана задача', 'Регламент'] and 'по регламенту (каждую смену)' in h[0][2], h
    s.page.click('nav [data-screen="tasks"]')
    assert '⟳ регламент' in s.page.inner_text(f'#tasks .task[data-id="{t["id"]}"]')
    s.open('2026-10-21T15:00:00')
    s.run_for('00:01:00')
    assert len(reg_tasks(s)) == 1, reg_tasks(s)
    assert sql(s, "SELECT COUNT(*) FROM tasks WHERE id LIKE 'reg-%'")[0][0] == 1
    assert sql(s, "SELECT COUNT(*) FROM task_history WHERE task_id LIKE 'reg-%'")[0][0] == 1


@test('G')
def g02_missed_repeat_marked_not_duplicated(s):
    """Прошлый повтор не выполнен — новую задачу не создаём, у старой пометка «пропущен повтор»; выполнили — следующая создаётся."""
    s.open('2026-10-21T09:00:00')
    add_template(s, 'Обход склада')
    s.open('2026-10-21T20:40:00')
    assert [r[0] for r in reg_tasks(s)] == ['202610210830'], reg_tasks(s)
    tid = s.ev("db.tasks.find(t=>t.regId).id")
    assert s.ev("id=>db.tasks.find(t=>t.id===id).regMissed", tid) == ['202610212030']
    assert s.ev("id=>db.history.filter(h=>h.taskId===id&&h.action==='Пропущен повтор регламента').length", tid) == 1
    s.page.click('nav [data-screen="tasks"]')
    assert 'Пропущено повторов регламента: 1' in s.page.inner_text(f'#tasks .task[data-id="{tid}"]')
    s.open('2026-10-21T21:00:00')     # перезапуск в той же смене — вторая пометка не ставится
    assert s.ev("id=>db.history.filter(h=>h.taskId===id&&h.action==='Пропущен повтор регламента').length", tid) == 1
    s.edit_task('Обход склада', status='Выполнена')
    s.open('2026-10-22T08:35:00')
    assert [r[:2] for r in reg_tasks(s)] == [['202610210830', 'Выполнена'], ['202610220830', 'В работе']], reg_tasks(s)


@test('G')
def g03_no_backfill_after_computers_were_off(s):
    """Программы были закрыты несколько смен: при запуске создаётся только задача текущей смены, задним числом — нет."""
    s.open('2026-10-21T09:00:00')
    add_template(s, 'Проверка весов', kind='hours', mode='day', n=4)
    s.edit_task('Проверка весов', status='Выполнена')
    s.open('2026-10-23T15:10:00')
    assert [r[0] for r in reg_tasks(s)] == ['202610210830', '202610231230'], reg_tasks(s)
    s.at('2026-10-23T16:31:00'); s.ev("GrassRegUi.regTick()")   # следующий повтор внутри смены (прошлый не выполнен — пометка)
    assert s.ev("db.tasks.find(t=>t.id.endsWith('202610231230')).regMissed") == ['202610231630']


@test('G')
def g04_ten_copies_one_task(s):
    """Несколько копий программы на общей базе одновременно доходят до повтора: в базе одна задача и одно событие, ошибок нет."""
    xs = team(s, 4)
    xs[0].open('2026-10-21T08:00:00')
    add_template(xs[0], 'Отбор проб', mode='day')
    assert reg_tasks(xs[0]) == []                       # ночная смена — не создаётся
    for x in xs[1:]:
        x.open('2026-10-21T08:00:00')
    for x in xs:
        assert x.ev("GrassRegUi.templates().length") == 1
        x.at('2026-10-21T08:31:00')
        x.ev("window.__pull=pullRemoteChanges;pullRemoteChanges=()=>{}")   # как будто все копии проверяют базу в одно мгновение
    for x in xs:
        x.ev("GrassRegUi.regTick()")
    for x in xs:
        x.ev("pullRemoteChanges=window.__pull"); pull(x)    # обычная подкачка раз в 3 с
    assert ssql(s, "SELECT COUNT(*) FROM tasks WHERE id LIKE 'reg-%'")[0][0] == 1
    assert ssql(s, "SELECT COUNT(*) FROM task_history WHERE task_id LIKE 'reg-%'")[0][0] == 1
    for x in xs:
        assert [r[0] for r in reg_tasks(x)] == ['202610210830'], reg_tasks(x)
        assert x.ev("db.history.filter(h=>h.taskId.startsWith('reg-')).length") == 1, x.ev("db.history.filter(h=>h.taskId.startsWith('reg-')).map(h=>[h.id,h.action,h.author])")
        assert toast_text(x) == '' and bar_text(x) == '', (toast_text(x), bar_text(x))


@test('G')
def g05_pause_delete_edit(s):
    """Пауза — задачи не создаются; правка расписания; удаление шаблона спрашивает и не трогает созданные задачи."""
    s.open('2026-10-21T09:00:00')
    rid = add_template(s, 'Еженедельная уборка', kind='weekdays', days=[4])     # четверг, днём
    assert reg_tasks(s) == []
    assert 'по Чт (дневная смена)' in s.page.inner_text('#regList')
    s.page.click(f'[data-reg-pause="{rid}"]')
    assert 'на паузе' in s.page.inner_text('#regList')
    s.open('2026-10-22T09:00:00')
    assert reg_tasks(s) == []
    s.page.click('nav [data-screen="settings"]')
    s.page.click(f'[data-reg-pause="{rid}"]')
    assert [r[0] for r in reg_tasks(s)] == ['202610220830']
    s.page.click(f'[data-reg-edit="{rid}"]')
    assert s.page.input_value('#regTitle') == 'Еженедельная уборка'
    s.page.uncheck('[data-reg-day="4"]')
    s.page.click('#regSave')
    assert s.page.is_visible('#regDlg') and 'день недели' in s.page.inner_text('#regPreview')
    s.page.check('[data-reg-day="5"]'); s.page.click('#regSave')
    assert 'по Пт' in s.page.inner_text('#regList')
    s.page.click(f'[data-reg-del="{rid}"]')
    assert 'Удалить шаблон «Еженедельная уборка»' in s.page.inner_text('#askDlg')
    s.page.click('#askCancel')
    assert s.ev("GrassRegUi.templates().length") == 1
    s.page.click(f'[data-reg-del="{rid}"]'); s.page.click('#askOk')
    s.open('2026-10-23T09:00:00')
    assert s.ev("GrassRegUi.templates().length") == 0 and len(reg_tasks(s)) == 1


@test('G')
def g06_new_task_from_template(s):
    """Кнопка «Из шаблона» в окне новой задачи заполняет поля; при правке задачи её нет; шаблон «без расписания» сам не создаётся."""
    s.open('2026-10-21T09:00:00')
    p = s.page
    p.click('nav [data-screen="tasks"]'); p.click('#addBtn')
    assert p.is_hidden('#fromTemplateRow')                # шаблонов нет — кнопки нет
    p.click('#close')
    add_template(s, 'Замена фильтра', kind='none', deadline=2, comment='Фильтр на линии 1')
    assert reg_tasks(s) == []
    p.click('nav [data-screen="tasks"]'); p.click('#addBtn')
    assert p.is_visible('#fromTemplateRow')
    p.select_option('#fromTemplate', label='Замена фильтра')
    assert p.input_value('#text') == 'Замена фильтра' and p.input_value('#comment') == 'Фильтр на линии 1'
    assert p.input_value('#deadline') == '2026-10-21T11:00'
    p.click('#form button.add')
    t = s.ev("db.tasks.find(x=>x.text==='Замена фильтра')")
    assert t and not t.get('regId') and t['author'] != 'Регламент', t
    p.click(f'#tasks .task[data-id="{t["id"]}"]')
    assert p.is_hidden('#fromTemplateRow')


# ======================= J: журнал смены (1.7.6, п. 25) =======================

def jwrite(s, text, frm='', to=''):
    p = s.page
    p.click('nav [data-screen="journal"]')
    p.fill('#journalText', text)
    p.fill('#journalFrom', frm); p.fill('#journalTo', to)
    p.click('#journalAdd')


def jentries(s):
    return s.ev("GrassJournalUi.entries().map(e=>({id:e.id,text:e.text,from:e.from,to:e.to,author:e.author,shift:e.shift,deleted:!!e.deleted,edits:e.edits.map(x=>x.text)}))")


def jrow(s, text):
    return s.page.locator('.journal-entry', has_text=text)


@test('J')
def j01_write_edit_delete_kept_after_restart(s):
    """Запись с временем и без; технолог, смена и площадка подставляются сами; правка и удаление видны и сохраняются в базе."""
    s.open('2026-10-21T09:00:00')
    jwrite(s, 'Остановка линии 2, замена ножа', '09:00', '09:40')
    jwrite(s, 'Пришла цистерна')
    p = s.page
    assert 'Носиков А.Ю. · смена A · Ахтуба' in p.inner_text('#journalWho')
    p.click('#journalAdd')                                    # пустая запись не уходит
    assert 'Напишите' in p.inner_text('#journalProblem') and len(jentries(s)) == 2
    jrow(s, 'Остановка линии 2').locator('[data-journal-edit]').click()
    assert p.input_value('#journalText') == 'Остановка линии 2, замена ножа' and p.input_value('#journalTo') == '09:40'
    p.fill('#journalText', 'Остановка линии 2, замена ножа и насоса'); p.fill('#journalTo', '09:50'); p.click('#journalAdd')
    jrow(s, 'Пришла цистерна').locator('[data-journal-del]').click()
    assert 'Удалить запись журнала?' in p.inner_text('#askDlg')
    p.click('#askOk')
    s.open('2026-10-21T10:00:00')
    e = {x['text']: x for x in jentries(s)}
    assert e['Остановка линии 2, замена ножа и насоса']['edits'] == ['Остановка линии 2, замена ножа'] and e['Остановка линии 2, замена ножа и насоса']['to'] == '09:50'
    assert e['Пришла цистерна']['deleted'] and e['Пришла цистерна']['author'] == 'Носиков А.Ю.' and e['Пришла цистерна']['shift'] == 'A'
    s.page.click('nav [data-screen="journal"]')
    assert '09:00–09:50' in jrow(s, 'насоса').inner_text() and 'изменено 1 раз' in jrow(s, 'насоса').inner_text()
    assert 'Удалено: Носиков А.Ю.' in jrow(s, 'Пришла цистерна').inner_text()
    assert jrow(s, 'Пришла цистерна').locator('[data-journal-edit]').count() == 0
    assert sql(s, "SELECT COUNT(*) FROM task_history WHERE task_id='__journal__'")[0][0] == 4
    # журнал — не задача: нет в Истории, в списке задач и в статистике
    s.page.click('nav [data-screen="history"]')
    assert 'цистерна' not in s.page.inner_text('#history')
    assert s.ev("db.tasks.length") == 0
    assert s.ev("shiftSummaryData().rows.length") == 0


@test('J')
def j02_only_own_entry_only_own_shift(s):
    """Чужую запись править нельзя; свою — только в ту же смену, в следующую уже нельзя."""
    s.open('2026-10-21T19:00:00')
    jwrite(s, 'Запись Носикова')
    be(s, 'Егоров Е.В.')
    s.page.click('nav [data-screen="journal"]')
    assert jrow(s, 'Запись Носикова').locator('[data-journal-edit]').count() == 0
    be(s, 'Носиков А.Ю.')
    s.page.click('nav [data-screen="journal"]')
    assert jrow(s, 'Запись Носикова').locator('[data-journal-edit]').count() == 1
    jrow(s, 'Запись Носикова').locator('[data-journal-edit]').click()
    s.at('2026-10-21T20:31:00')                               # смена кончилась, пока окно правки было открыто
    s.page.fill('#journalText', 'Поправил после смены'); s.page.click('#journalAdd')
    assert 'нельзя изменить' in s.page.inner_text('#journalProblem')
    s.open('2026-10-21T20:40:00')
    s.page.click('nav [data-screen="journal"]')
    assert jrow(s, 'Запись Носикова').locator('[data-journal-edit], [data-journal-del]').count() == 0
    assert [x['text'] for x in jentries(s)] == ['Запись Носикова']


@test('J')
def j03_sites_apart_shared_everyone_sees(s):
    """Свой журнал у каждой площадки; на общей базе запись видят все на той же площадке."""
    a, b, v = team(s, 3, sites={2: 'VOLZHSKY'})
    for x in (a, b, v):
        x.open('2026-10-21T10:00:00')
    be(a, 'Носиков А.Ю.'); be(b, 'Егоров Е.В.')
    jwrite(a, 'Ахтуба: остановка')
    jwrite(v, 'Волжский: приход сырья')
    pull(b); pull(v)
    assert [x['text'] for x in jentries(b)] == ['Ахтуба: остановка']
    assert [x['text'] for x in jentries(v)] == ['Волжский: приход сырья']
    b.page.click('nav [data-screen="journal"]')
    b.run_for('00:00:04')
    assert 'Ахтуба: остановка' in b.page.inner_text('#journalList')
    assert jrow(b, 'Ахтуба: остановка').locator('[data-journal-edit]').count() == 0
    jwrite(b, 'Егоров: принял смену')
    a.page.click('nav [data-screen="journal"]'); a.run_for('00:00:04')
    assert 'Егоров: принял смену' in a.page.inner_text('#journalList')
    assert toast_text(a) == '' and bar_text(a) == ''


@test('J')
def j04_journal_in_shift_summary(s):
    """Записи журнала прошлой смены есть в сводке (удалённые — нет); сводка открывается сама, даже если по задачам ничего не было."""
    s.open('2026-10-21T10:00:00')
    jwrite(s, 'Линия 1 стояла', '10:00', '11:00')
    jwrite(s, 'Ошибочная запись')
    jrow(s, 'Ошибочная запись').locator('[data-journal-del]').click(); s.page.click('#askOk')
    s.open('2026-10-21T21:00:00', keep_summary=True)
    assert s.ev("$('shiftSummaryDlg').open"), 'сводка должна открыться сама'
    txt = s.page.inner_text('#shiftSummaryJournal')
    assert 'Линия 1 стояла' in txt and '10:00–11:00' in txt and 'Ошибочная' not in txt, txt
    assert s.page.is_visible('#shiftSummaryJournalBox')
    s.page.click('#shiftSummaryOk')
    s.open('2026-10-22T09:00:00', keep_summary=True)        # ночью записей нет — блока нет
    s.ev("openShiftSummary()")
    assert s.page.is_hidden('#shiftSummaryJournalBox')


@test('J')
def j05_search_journal_and_from_tasks(s):
    """Поиск по журналу (в том числе по прошлому тексту записи) и подсказка из общего поиска на экране задач."""
    s.open('2026-10-21T09:00:00')
    jwrite(s, 'Ремонт насоса на линии 3')
    jwrite(s, 'Приход сырья')
    jrow(s, 'Ремонт насоса').locator('[data-journal-edit]').click()
    s.page.fill('#journalText', 'Насос заменён'); s.page.click('#journalAdd')
    s.page.fill('#journalSearch', 'ремонт')
    assert s.page.locator('.journal-entry').count() == 1 and 'Насос заменён' in s.page.inner_text('#journalList')
    s.page.fill('#journalSearch', 'нет такого')
    assert 'ничего не найдено' in s.page.inner_text('#journalList')
    s.page.click('nav [data-screen="tasks"]')
    s.page.fill('#search', 'сырья')
    assert s.page.is_visible('#journalHint') and 'найдено записей: 1' in s.page.inner_text('#journalHint')
    s.page.click('#journalHintOpen')
    assert s.page.is_visible('#screen-journal') and s.page.input_value('#journalSearch') == 'сырья'
    assert s.page.locator('.journal-entry').count() == 1
    s.page.click('nav [data-screen="tasks"]'); s.page.fill('#search', 'zzz')
    assert s.page.is_hidden('#journalHint')


# ======================= K: лента комментариев (1.7.6, п. 26) =======================

def feed_texts(s):
    return s.ev("[...document.querySelectorAll('#commentFeed .comment-text')].map(x=>x.textContent)")


@test('K')
def k01_comment_appends_not_replaces(s):
    """Новый комментарий добавляется в ленту, старый остаётся; в карточке — последний; пустое поле не трогает комментарий."""
    s.open('2026-10-21T09:00:00')
    p = s.page
    s.create_task('Насос Н-3', comment='давление 4 бар')
    be(s, 'Егоров Е.В.')
    s.edit_task('Насос Н-3', comment='заменили уплотнение')
    s.edit_task('Насос Н-3', status='Не в работе')                 # без комментария — лента та же
    t = s.ev("db.tasks[0]")
    assert t['comment'] == 'заменили уплотнение', t
    assert [(c['text'], c['author']) for c in t['comments']] == [('давление 4 бар', 'Носиков А.Ю.'), ('заменили уплотнение', 'Егоров Е.В.')], t['comments']
    card = p.inner_text(f'#tasks .task[data-id="{t["id"]}"]')
    assert 'заменили уплотнение' in card and 'давление 4 бар' not in card and '💬 2' in card, card
    p.click(f'#tasks .task[data-id="{t["id"]}"]')
    assert feed_texts(s) == ['давление 4 бар', 'заменили уплотнение'] and p.input_value('#comment') == ''
    assert p.inner_text('#commentLabel') == 'Новый комментарий'
    p.fill('#comment', 'заменили уплотнение'); p.click('#form button.add')   # повтор последнего — не дублируется
    assert len(s.ev("db.tasks[0].comments")) == 2
    s.open('2026-10-21T10:00:00')
    assert [c['text'] for c in s.ev("db.tasks[0].comments")] == ['давление 4 бар', 'заменили уплотнение']
    s.page.fill('#search', 'давление')                                # поиск по всем комментариям
    assert s.page.locator('#tasks .task').count() == 1


@test('K')
def k02_old_task_comment_becomes_first(s):
    """Задача до 1.7.6 (без ленты): её комментарий — первая запись ленты с автором из истории; быстрые кнопки комментарий не трогают."""
    s.open('2026-10-21T09:00:00')
    s.create_task('Старая', comment='из прошлой версии')
    s.ev("(()=>{const t=db.tasks[0];delete t.comments;save();})()")
    s.open('2026-10-21T09:10:00')
    assert s.ev("db.tasks[0].comments") is None
    p = s.page
    tid = s.task_id('Старая')
    p.click(f'#tasks .task[data-id="{tid}"]')
    assert feed_texts(s) == ['из прошлой версии']
    assert 'Носиков А.Ю.' in p.inner_text('#commentFeed .comment-meta')
    p.click('#close')
    s.ev(f"quickAction('{tid}','take')")
    assert s.ev("db.tasks[0].comment") == 'из прошлой версии' and s.ev("db.tasks[0].comments") is None
    s.edit_task('Старая', comment='второй')
    assert [c['text'] for c in s.ev("db.tasks[0].comments")] == ['из прошлой версии', 'второй']


# ======================= Q: статистика «Скорость и сроки» (1.7.6, п. 28) =======================

@test('Q')
def q01_speed_shifts_ontime_by_priority(s):
    """Среднее время до выполнения, сколько смен прошла задача, доля в срок, разбивка по приоритетам, фильтр по технологу."""
    s.open('2026-10-21T09:00:00')
    s.create_task('Быстрая', deadline='2026-10-21T12:00')
    s.create_task('Долгая', deadline='2026-10-21T12:00')
    be(s, 'Егоров Е.В.')
    s.create_task('Висит')
    set_priority(s, 'Висит', 'Высокий')
    be(s, 'Носиков А.Ю.')
    s.open('2026-10-21T10:00:00'); s.edit_task('Быстрая', status='Выполнена')
    s.open('2026-10-22T10:00:00'); s.edit_task('Долгая', status='Выполнена')
    p = s.page
    p.click('nav [data-screen="stats"]')
    txt = p.inner_text('#statsQuality')
    for part in ('13 ч', 'медиана 13 ч · выполнено 2', 'дольше всех: Долгая — 3 смены', '50%', '1 из 2 со сроком', 'дольше всех висит: Висит — 3 смены'):
        assert part in txt, (part, txt)
    row = lambda pr: p.inner_text(f'#statsQuality tr[data-prio="{pr}"]').split('\t')
    assert row('Обычный') == ['Обычный', '2', '2', '13 ч', '2', '50%', '0', '0'], row('Обычный')
    assert row('Высокий') == ['Высокий', '1', '0', '—', '—', '—', '1', '0'], row('Высокий')
    p.select_option('#statsTechFilter', 'Егоров Е.В.')
    assert 'выполнено 0' in p.inner_text('#statsQuality') and row('Высокий')[6] == '1'


# ======================= P: график смен в Настройках (1.7.6, п. 29) =======================

def set_schedule(x, day_start=None, order=None, anchor=None):
    p = x.page
    p.click('nav [data-screen="settings"]')
    if day_start:
        p.fill('#schedDayStart', day_start)
    for i, l in enumerate(order or []):
        p.select_option(f'#schedOrder{i}', l)
    if anchor:
        p.fill('#schedAnchor', anchor)


@test('P')
def p01_schedule_preview_save_history(s):
    """График по умолчанию как раньше; превью сегодня/завтра; неверный не сохраняется; сохранение спрашивает, меняет смены и пишется в историю."""
    s.open('2026-10-21T09:00:00')
    p = s.page
    p.click('nav [data-screen="settings"]')
    assert p.input_value('#schedDayStart') == '08:30' and p.input_value('#schedAnchor') == '2026-09-02'
    assert [p.input_value(f'#schedOrder{i}') for i in range(4)] == ['A', 'D', 'B', 'C']
    assert p.is_disabled('#schedSave')                                  # ничего не меняли
    assert 'Сегодня 21.10: день — смена A (08:30–20:30), ночь — смена C (20:30–08:30)' in p.inner_text('#schedPreview')
    set_schedule(s, day_start='13:00')
    assert '04:00' in p.inner_text('#schedPreview') and p.is_disabled('#schedSave')
    set_schedule(s, order=['A', 'A', 'B', 'C'])
    set_schedule(s, day_start='08:00', order=['B', 'C', 'A', 'D'], anchor='2026-10-21')
    assert 'Сегодня 21.10: день — смена B (08:00–20:00)' in p.inner_text('#schedPreview')
    assert p.inner_text('#schedNight') == 'ночь с 20:00'
    p.click('#schedSave')
    assert 'Сегодня 21.10: день — смена B' in p.inner_text('#askDlg')
    p.click('#askCancel')
    assert s.ev("GrassShifts.current().dayStart") == '08:30' and s.ev("shift") == 'A'
    p.click('#schedSave'); p.click('#askOk')
    assert s.ev("shift") == 'B' and s.ev("GrassShifts.windowAt(new Date()).start.getMinutes()") == 0
    assert 'Смена B · День · 08:00–20:00' in p.inner_text('#currentShiftInfo')
    h = s.ev("db.history.filter(h=>h.taskId==='__schedule__').map(h=>[h.action,h.author,h.details])")
    assert len(h) == 1 and h[0][:2] == ['Изменён график смен', 'Носиков А.Ю.'] and 'начало дня 08:30' in h[0][2] and 'начало дня 08:00' in h[0][2], h
    assert 'изменения графика' in p.inner_text('#schedLog').lower() and 'Носиков А.Ю.' in p.inner_text('#schedLog')
    stored = json.loads(sql(s, "SELECT value FROM settings WHERE key='shiftSchedule'")[0][0])
    assert stored['dayStart'] == '08:00' and stored['order'] == ['B', 'C', 'A', 'D'] and len(stored['log']) == 1
    s.open('2026-10-21T19:59:00')                                       # после перезапуска график тот же
    assert s.ev("shift") == 'B'
    s.open('2026-10-21T20:01:00')
    assert s.ev("GrassShifts.windowAt(new Date()).mode") == 'Ночь'
    p = s.page
    p.click('nav [data-screen="history"]')
    assert 'График смен' not in p.inner_text('#history')
    p.click('nav [data-screen="settings"]'); p.click('#schedDefault')
    assert p.input_value('#schedDayStart') == '08:30' and not p.is_disabled('#schedSave')


@test('P')
def p02_schedule_shared_for_sites_and_copies(s):
    """График общий: на другой площадке и в другой копии программы он применяется сам, смена переключается."""
    a, b, v = team(s, 3, sites={2: 'VOLZHSKY'})
    for x in (a, b, v):
        x.open('2026-10-21T09:00:00')
    set_schedule(a, order=['D', 'A', 'B', 'C'], anchor='2026-10-21')
    a.page.click('#schedSave'); a.page.click('#askOk')
    assert a.ev("shift") == 'D'
    for x in (b, v):
        pull(x)
        x.run_for('00:00:04')
        assert x.ev("GrassShifts.current().order") == ['D', 'A', 'B', 'C'], x.ev("GrassShifts.current()")
        assert x.ev("shift") == 'D'
    v.open('2026-10-21T10:00:00')
    assert v.ev("shift") == 'D'


# ======================= W: уведомления (1.7.6, п. 23) =======================

def notes(s):
    return s.state()['notifications']


@test('W')
def w01_deadline_notification_personal(s):
    """Уведомление за 30 минут до срока (по умолчанию), один раз; настройка личная; «Не уведомлять» — тишина."""
    s.open('2026-10-21T09:00:00')
    p = s.page
    s.create_task('Проверить pH', deadline='2026-10-21T09:50')
    s.run_for('00:00:31')
    assert notes(s) == [], notes(s)                       # до срока 50 минут
    s.at('2026-10-21T09:21:00'); s.run_for('00:00:31')
    n = notes(s)
    assert len(n) == 1 and n[0]['title'].startswith('Срок через') and 'Проверить pH' in n[0]['body'] and '09:50' in n[0]['body'], n
    s.run_for('00:01:30')
    assert len(notes(s)) == 1                             # без повторов
    p.click('nav [data-screen="settings"]')
    assert p.input_value('#notifyBefore') == '30'
    p.select_option('#notifyBefore', '0')
    be(s, 'Егоров Е.В.')
    assert p.input_value('#notifyBefore') == '30'         # у другого технолога своя настройка
    p.select_option('#notifyBefore', '60')
    be(s, 'Носиков А.Ю.')
    assert p.input_value('#notifyBefore') == '0'
    s.create_task('Без уведомления', deadline='2026-10-21T10:00')
    s.run_for('00:01:00')
    assert len(notes(s)) == 1, notes(s)
    s.open('2026-10-21T09:45:00')                         # перезапуск: старое напоминание не повторяется
    assert len(notes(s)) == 0, notes(s)


@test('W')
def w02_new_handover_notifies_and_flashes(s):
    """Передача моей смене: уведомление и мигание кнопки в панели задач, один раз."""
    s.open('2026-10-21T19:00:00')
    s.create_task('Насос Н-3 на контроле', status='Передать по смене')
    assert notes(s) == []                                 # своя смена — не мне
    s.open('2026-10-21T20:40:00')                         # пришла ночная смена C
    n = notes(s)
    assert len(n) == 1 and n[0]['title'] == 'Новая передача смене C от смены A' and 'Насос Н-3 на контроле' in n[0]['body'], n
    assert True in s.state()['flashes']
    s.open('2026-10-21T20:45:00')
    assert notes(s) == []


@test('W')
def w03_overdue_count_on_taskbar(s):
    """Число просроченных задач — на значке программы; выполнили — значок убран."""
    s.open('2026-10-21T09:00:00')
    s.create_task('Просрочится', deadline='2026-10-21T09:10')
    s.at('2026-10-21T09:11:00'); s.run_for('00:00:31')
    ov = s.state()['overlay']
    assert ov and ov[-1] and ov[-1]['desc'] == 'Просрочено задач: 1' and ov[-1]['img'].startswith('data:image/png'), ov
    s.edit_task('Просрочится', status='Выполнена')
    assert s.state()['overlay'][-1] is None


# ======================= X: выгрузка в Excel и PDF (1.7.6, п. 27) =======================

def exports_dir(s):
    return os.path.join(s.user_data, '__exports')


def read_xlsx(path):
    """Лист → строки (только inlineStr и числа, как пишет программа)."""
    import zipfile
    import xml.etree.ElementTree as ET
    ns = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
    out = {}
    with zipfile.ZipFile(path) as z:
        assert z.testzip() is None
        wb = ET.fromstring(z.read('xl/workbook.xml'))
        for i, sh in enumerate(wb.find('m:sheets', ns)):
            root = ET.fromstring(z.read(f'xl/worksheets/sheet{i + 1}.xml'))
            rows = []
            for r in root.iter('{%s}row' % ns['m']):
                row = []
                for c in r:
                    t = c.find('.//m:t', ns); v = c.find('m:v', ns)
                    row.append(t.text if t is not None else (float(v.text) if v is not None else ''))
                rows.append(row)
            out[sh.get('name')] = rows
    return out


def wait_file(path, timeout=8.0):
    wait_until(lambda: os.path.exists(path) and os.path.getsize(path) > 0, timeout)
    return path


@test('X')
def x01_summary_to_excel_and_pdf(s):
    """Сводка смены в Excel: итоги, задачи, комментарии, журнал; в PDF — те же таблицы."""
    s.open('2026-10-21T10:00:00')
    s.create_task('Насос Н-3', comment='давление 4 бар')
    s.create_task('Передаю', status='Передать по смене')
    jwrite(s, 'Линия 1 стояла', '10:00', '10:30')
    s.open('2026-10-21T21:00:00')
    p = s.page
    s.ev("openShiftSummary()")
    p.click('#summaryXlsx')
    f = wait_file(os.path.join(exports_dir(s), 'Сводка смены A 21.10.2026 Ахтуба.xlsx'))
    assert wait_until(lambda: 'Сохранено' in toast_text(s))
    x = read_xlsx(f)
    assert list(x) == ['Итоги', 'Задачи смены', 'Комментарии', 'Журнал смены'], list(x)
    itog = {r[0]: r[1] for r in x['Итоги'][1:]}
    assert itog['Передано'] == 1 and itog['В работе'] == 1 and itog['Площадка'] == 'Ахтуба', itog
    assert sorted(r[0] for r in x['Задачи смены'][1:]) == ['Насос Н-3', 'Передаю']
    assert x['Комментарии'][1] == ['Насос Н-3', 'давление 4 бар']
    assert x['Журнал смены'][1][:3] == ['10:00–10:30', 'Линия 1 стояла', 'Носиков А.Ю.']
    p.click('#summaryPdf')
    pdf = wait_file(os.path.join(exports_dir(s), 'Сводка смены A 21.10.2026 Ахтуба.pdf'))
    body = open(pdf, encoding='utf-8').read()
    assert body.startswith('%PDF') and '<h2>Журнал смены</h2>' in body and 'Насос Н-3' in body and 'Смена A · День · 21.10' in body


@test('X')
def x02_stats_to_excel_and_pdf(s):
    """Статистика в Excel и PDF: по дням, скорость и сроки, по приоритетам, по технологам — как на экране."""
    s.open('2026-10-21T09:00:00')
    s.create_task('Быстрая', deadline='2026-10-21T12:00')
    s.open('2026-10-21T10:00:00'); s.edit_task('Быстрая', status='Выполнена')
    p = s.page
    p.click('nav [data-screen="stats"]')
    p.click('#statsXlsx')
    wait_until(lambda: os.path.isdir(exports_dir(s)) and any(n.endswith('.xlsx') for n in os.listdir(exports_dir(s))))
    f = [os.path.join(exports_dir(s), n) for n in os.listdir(exports_dir(s)) if n.endswith('.xlsx')][0]
    assert os.path.basename(f).startswith('Статистика Ахтуба 2026-10-21'), f
    x = read_xlsx(f)
    assert list(x) == ['По дням', 'Скорость и сроки', 'По приоритетам', 'По технологам'], list(x)
    assert x['По дням'][0] == ['Дата', 'Создано', 'Выполнено', 'Просрочено'] and len(x['По дням']) == 8
    assert x['По дням'][-1] == ['21.10.2026', 1, 1, 0], x['По дням'][-1]
    q = {r[0]: r[1] for r in x['Скорость и сроки'][1:]}
    assert q['Выполнено за период'] == 1 and q['Среднее время до выполнения, ч'] == 1 and q['Выполнено в срок, %'] == 100, q
    assert x['По технологам'][0][0] == 'Технолог' and any(r[0] == 'Носиков А.Ю.' for r in x['По технологам'][1:])
    p.click('#statsPdf')
    wait_until(lambda: any(n.endswith('.pdf') for n in os.listdir(exports_dir(s))))
    pdf = [os.path.join(exports_dir(s), n) for n in os.listdir(exports_dir(s)) if n.endswith('.pdf')][0]
    body = open(pdf, encoding='utf-8').read()
    assert '<h2>По приоритетам</h2>' in body and 'Ахтуба · за неделю' in body  # 1.7.7: подпись периода «за неделю» вместо «за 7 дней»


# ---------- 1.7.7: мелочи статистики (п. 45–51) ----------
def stats_go(s):
    s.page.click('nav [data-screen="stats"]')


def stats_list(s):
    """Открытое окно «Задачи за цифрой»: заголовок и тексты задач."""
    p = s.page
    assert p.is_visible('#statsListDlg'), 'окно со списком задач не открылось'
    return p.inner_text('#statsListTitle'), s.ev("[...document.querySelectorAll('#statsListItems .stats-list-item b')].map(b=>b.textContent)")


def close_list(s):
    s.page.click('#statsListClose')


def stats_state(s):
    return s.ev("({period:statsPeriod,brigade:statsBrigade,tech:statsTech,sort:statsTechSort.key+':'+statsTechSort.dir,"
                "active:document.querySelector('[data-stats-period].active')?.dataset.statsPeriod,"
                "br:document.querySelector('[data-stats-brigade].active')?.dataset.statsBrigade,"
                "sel:document.getElementById('statsTechFilter')?.value})")


@test('T')
def t01_quick_periods(s):
    """Быстрые периоды: «Моя смена», «Сутки», «Неделя», «Месяц», «Прошлый месяц», «Всё время» — считают ровно свои задачи."""
    s.open('2026-09-15T10:00:00'); s.create_task('Сентябрьская')
    s.open('2026-10-14T10:00:00'); s.create_task('Две недели назад')
    s.open('2026-10-20T10:00:00'); s.create_task('Вчерашняя')
    s.open('2026-10-21T09:00:00'); s.create_task('Утренняя A')
    s.open('2026-10-21T21:00:00'); s.create_task('Ночная C')
    assert s.ev("shift") == 'C'
    stats_go(s)
    p = s.page
    labels = s.ev("[...document.querySelectorAll('[data-stats-period]')].map(b=>b.textContent)")
    assert labels == ['Моя смена', 'Сутки', 'Неделя', 'Месяц', 'Прошлый месяц', 'Всё время'], labels
    want = {'shift': 1, 'day': 2, '7d': 3, '30d': 4, 'prevMonth': 1, 'all': 5}
    for key, n in want.items():
        p.click(f'[data-stats-period="{key}"]')
        assert stats_state(s)['active'] == key
        assert period_totals(s)['created'] == n, (key, period_totals(s))
        assert {r['name']: r['created'] for r in tech_table(s)}['Носиков А.Ю.'] == n, key
    p.click('[data-stats-period="shift"]')
    note = p.inner_text('.stats-range-note')
    assert 'смену C' in note and '21.10.2026' in note, note
    assert 'за смену C' in p.inner_text('.stats-kpi-card.total small')
    p.click('[data-stats-period="prevMonth"]')
    assert 'сентябрь 2026' in p.inner_text('.stats-range-note') and s.ev("document.querySelectorAll('.stats-day').length") == 30
    assert not s.page_errors, s.page_errors


@test('T')
def t02_brigade_filter(s):
    """Фильтр по бригаде: цифры, график, таблица и «Скорость и сроки» — только по сменам выбранной бригады."""
    N, E = 'Носиков А.Ю.', 'Егоров Е.В.'
    s.open('2026-10-21T09:00:00'); be(s, N)
    s.create_task('Дневная A')
    s.open('2026-10-21T21:00:00'); be(s, E)
    s.create_task('Ночная C')
    s.edit_task('Дневная A', status='Выполнена')          # выполнена ночью — это смена C
    stats_go(s)
    p = s.page
    assert period_totals(s) == {'created': 2, 'completed': 1, 'overdue': 0}
    kpi = lambda: int(p.inner_text('.stats-kpi-card.total strong'))
    rows = lambda: {r['name']: r for r in tech_table(s)}
    assert kpi() == 2
    p.click('[data-stats-brigade="A"]')
    assert stats_state(s)['br'] == 'A'
    assert period_totals(s) == {'created': 1, 'completed': 0, 'overdue': 0}, period_totals(s)
    assert kpi() == 1 and int(p.inner_text('.stats-kpi-card.work strong')) == 0
    assert (rows()[N]['created'], rows()[E]['created'], rows()[E]['completed']) == (1, 0, 0)
    assert 'выполнено 0' in p.inner_text('#statsQuality')
    assert 'бригада A' in p.inner_text('.stats-kpi-card.total small')
    p.click('[data-stats-brigade="C"]')
    assert period_totals(s) == {'created': 1, 'completed': 1, 'overdue': 0}, period_totals(s)
    assert (rows()[N]['created'], rows()[E]['created'], rows()[E]['completed']) == (0, 1, 1)
    assert 'выполнено 1' in p.inner_text('#statsQuality')
    p.click('[data-stats-brigade="B"]')
    assert period_totals(s) == {'created': 0, 'completed': 0, 'overdue': 0} and kpi() == 0
    # бригада вместе с технологом
    p.click('[data-stats-brigade="C"]'); p.select_option('#statsTechFilter', N)
    assert period_totals(s) == {'created': 0, 'completed': 0, 'overdue': 0}
    p.select_option('#statsTechFilter', E)
    assert period_totals(s) == {'created': 1, 'completed': 1, 'overdue': 0}
    p.click('[data-stats-brigade=""]'); p.select_option('#statsTechFilter', '')
    assert period_totals(s) == {'created': 2, 'completed': 1, 'overdue': 0} and kpi() == 2
    assert not s.page_errors, s.page_errors


@test('T')
def t03_click_number_shows_tasks(s):
    """Клик по цифре или столбику — список задач, из которых она сложилась; клик по задаче её открывает."""
    s.open('2026-10-21T10:00:00')
    for t in ('Первая', 'Вторая', 'В архив'):
        s.create_task(t)
    s.edit_task('Вторая', status='Выполнена')
    tid = s.task_id('В архив')
    s.page.click(f'#tasks .task[data-id="{tid}"] .task-delete'); s.page.click('#deleteConfirm')
    stats_go(s)
    p = s.page
    # «Итого за период» → Создано
    p.locator('.stats-summary-row strong').nth(0).click()
    title, items = stats_list(s)
    assert 'Создано' in title and sorted(items) == ['В архив', 'Вторая', 'Первая'], (title, items)
    assert '3 задачи' in p.inner_text('#statsListHint')
    assert s.ev("document.querySelector('#statsListItems .stats-list-item.archive b').textContent") == 'В архив'
    # клик по активной задаче — открывается она сама
    p.locator('#statsListItems .stats-list-item', has_text='Первая').click()
    assert p.is_visible('#dlg') and not p.is_visible('#statsListDlg') and p.input_value('#text') == 'Первая'
    p.click('#close')
    # карточка «Выполнено»
    p.click('.stats-kpi-card.done strong')
    assert stats_list(s)[1] == ['Вторая']; close_list(s)
    # столбик графика «Выполнено» за 21.10
    p.click('.stats-day[data-date="21.10.2026"] .stats-bar-col:nth-child(2)')
    title, items = stats_list(s)
    assert items == ['Вторая'] and '21.10.2026' in title and 'Выполнено' in title, (title, items)
    close_list(s)
    # ячейка таблицы технологов — список, а не фильтр по технологу
    p.click('#techTable tbody tr[data-tech-row="Носиков А.Ю."] td[data-col="created"]')
    assert len(stats_list(s)[1]) == 3 and s.ev("statsTech") == ''
    close_list(s)
    # нули не кликаются, по имени технолога фильтр работает как раньше
    assert s.ev("document.querySelector('#techTable tr[data-tech-row=\"Покусаев Е.С.\"] td[data-col=\"created\"]').hasAttribute('data-stats-list')") is False
    p.click('#techTable tbody tr[data-tech-row="Носиков А.Ю."] td[data-col="name"]')
    assert s.ev("statsTech") == 'Носиков А.Ю.'
    p.click('#techTable tbody tr[data-tech-row="Носиков А.Ю."] td[data-col="name"]')
    # приоритеты: «Обычный · создано»
    p.click('#statsQuality tr[data-prio="Обычный"] td:nth-child(2)')
    assert len(stats_list(s)[1]) == 3; close_list(s)
    # архивная задача — переход в «Архив» к её карточке
    p.locator('.stats-summary-row strong').nth(0).click()
    p.locator('#statsListItems .stats-list-item', has_text='В архив').click()
    assert p.is_visible('#screen-archive')
    assert s.ev(f"document.querySelector('[data-archive-id=\"{tid}\"]').classList.contains('flash')")
    # клавиатура: Enter на цифре
    stats_go(s)
    p.focus('.stats-kpi-card.done strong'); p.keyboard.press('Enter')
    assert stats_list(s)[1] == ['Вторая']; close_list(s)
    assert not s.page_errors, s.page_errors


@test('T')
def t04_total_row_and_sort(s):
    """Строка «Всего» под таблицей технологов: сумма по каждому столбцу, при сортировке остаётся внизу."""
    N, E = 'Носиков А.Ю.', 'Егоров Е.В.'
    s.open('2026-10-21T10:00:00'); be(s, N)
    s.create_task('Н1'); s.create_task('Н2', status='Передать по смене'); s.create_task('Н3', status='Выполнена')
    s.open('2026-10-21T21:00:00'); be(s, E)
    assert s.accept_all()
    s.create_task('Е1'); s.edit_task('Н1', status='Выполнена')
    stats_go(s)
    p = s.page
    cols = ['created', 'completed', 'passed', 'accepted', 'returned', 'assigned', 'overdue']
    total = lambda: s.ev("Object.fromEntries([...document.querySelectorAll('#techTable tfoot td')].map(td=>[td.dataset.col,td.textContent]))")
    def check():
        body = tech_table(s)
        t = total()
        assert t['name'] == 'Всего', t
        for c in cols:
            assert int(t[c]) == sum(r[c] for r in body), (c, t, body)
        assert s.ev("[...document.querySelectorAll('#techTable tr')].pop().parentElement.tagName") == 'TFOOT'
    check()
    assert total()['created'] == '4' and total()['completed'] == '2'
    for c in ['name'] + cols:
        for _ in range(2):
            p.click(f'[data-tech-sort="{c}"]'); check()
    p.click('#techTable tfoot td[data-col="created"]')
    assert sorted(stats_list(s)[1]) == ['Е1', 'Н1', 'Н2', 'Н3']; close_list(s)
    assert not s.page_errors, s.page_errors


@test('T')
def t05_chart_tooltip(s):
    """Подсказка при наведении на столбик: над ним дата и точная цифра."""
    s.open('2026-10-21T10:00:00')
    s.create_task('Раз'); s.create_task('Два')
    stats_go(s)
    p = s.page
    p.add_style_tag(content='*{transition:none!important}')
    assert s.ev("document.querySelector('.stats-day').hasAttribute('title')") is False, 'старая подсказка браузера не должна дублировать новую'
    col = p.locator('.stats-day[data-date="21.10.2026"] .stats-bar-col').nth(0)
    col.hover()
    assert p.is_visible('#statsTip')
    tip = p.inner_text('#statsTip')
    assert '21.10.2026' in tip and 'Создано: 2' in tip, tip
    tb, bar = p.locator('#statsTip').bounding_box(), col.locator('.stats-bar').bounding_box()
    assert tb['y'] + tb['height'] <= bar['y'] + 1, (tb, bar)
    p.locator('.stats-day[data-date="21.10.2026"] .stats-bar-col').nth(2).hover()
    assert 'Просрочено: 0' in p.inner_text('#statsTip')
    p.hover('#statsQuality h2')
    assert not p.is_visible('#statsTip')
    assert not s.page_errors, s.page_errors


@test('T')
def t06_choice_remembered_per_user(s):
    """Статистика запоминает период, бригаду, технолога и сортировку — у каждого технолога свои."""
    N, E = 'Носиков А.Ю.', 'Егоров Е.В.'
    s.open('2026-10-21T10:00:00'); be(s, N)
    s.create_task('Для статистики')
    stats_go(s)
    p = s.page
    assert stats_state(s) == {'period': '7d', 'brigade': '', 'tech': '', 'sort': 'created:-1', 'active': '7d', 'br': '', 'sel': ''}
    p.click('[data-stats-period="30d"]'); p.click('[data-stats-brigade="B"]')
    p.select_option('#statsTechFilter', E); p.click('[data-tech-sort="name"]')
    mine = {'period': '30d', 'brigade': 'B', 'tech': E, 'sort': 'name:1', 'active': '30d', 'br': 'B', 'sel': E}
    assert stats_state(s) == mine
    s.open('2026-10-21T11:00:00')                      # перезапуск программы
    stats_go(s)
    assert stats_state(s) == mine, stats_state(s)
    be(s, E); stats_go(s)                               # у другого технолога — свой выбор
    assert stats_state(s)['period'] == '7d' and stats_state(s)['br'] == '' and stats_state(s)['sel'] == ''
    s.page.click('[data-stats-period="day"]')
    be(s, N); stats_go(s)
    assert stats_state(s) == mine, stats_state(s)
    be(s, E); stats_go(s)
    assert stats_state(s)['active'] == 'day'
    # испорченная настройка не ломает экран
    s.ev("localStorage.setItem(viewPrefKey('statsPeriod'),'чепуха');localStorage.setItem(viewPrefKey('statsTechSort'),'{bad')")
    s.open('2026-10-21T12:00:00'); stats_go(s)
    assert stats_state(s)['active'] == '7d' and stats_state(s)['sort'] == 'created:-1'
    assert not s.page_errors, s.page_errors


@test('T')
def t07_export_follows_period_and_brigade(s):
    """Excel и PDF статистики — за выбранный период и бригаду, со строкой «Всего» по технологам."""
    s.open('2026-10-21T09:00:00'); s.create_task('Дневная')
    s.open('2026-10-21T21:00:00'); s.create_task('Ночная')
    p = s.page
    stats_go(s)
    p.click('[data-stats-period="day"]'); p.click('[data-stats-brigade="C"]')
    p.click('#statsXlsx')
    wait_until(lambda: os.path.isdir(exports_dir(s)) and any(n.endswith('.xlsx') for n in os.listdir(exports_dir(s))))
    f = [os.path.join(exports_dir(s), n) for n in os.listdir(exports_dir(s)) if n.endswith('.xlsx')][0]
    x = read_xlsx(f)
    assert x['По дням'][1:] == [['21.10.2026', 1, 0, 0]], x['По дням']
    last = x['По технологам'][-1]
    assert last[0] == 'Всего' and last[1] == 1, last
    p.click('#statsPdf')
    wait_until(lambda: any(n.endswith('.pdf') for n in os.listdir(exports_dir(s))))
    pdf = [os.path.join(exports_dir(s), n) for n in os.listdir(exports_dir(s)) if n.endswith('.pdf')][0]
    body = open(pdf, encoding='utf-8').read()
    assert 'за сутки' in body and 'бригада C' in body, body[:400]
    assert not s.page_errors, s.page_errors


# ---------- 1.7.8: срок в истории на момент события, смена автоархива, дата при восстановлении, срок в прошлом ----------
def history_minis(s, text):
    """Полная история задачи на экране «История»: [(действие, смена, строка срока)], новые сверху."""
    p = s.page
    p.click('nav [data-screen="history"]')
    card = p.locator('.history-task-card', has_text=text)
    card.locator('summary').click()
    # история дорисовывается по событию раскрытия — ждём все записи, сколько написано на кнопке
    n = int(re.search(r'\((\d+)\)', card.locator('summary').inner_text()).group(1))
    assert wait_until(lambda: card.locator('.history-mini').count() == n), card.inner_text()
    return card.evaluate("""el=>[...el.querySelectorAll('.history-mini')].map(m=>[m.querySelector('b').textContent,
        (m.textContent.match(/смена ([A-D])/)||[])[1]||'', m.querySelector('.deadline')?.textContent||''])""")


@test('V')
def v01_history_deadline_frozen_at_event(s):
    """Срок в истории — на момент события: у выполненной не растёт «Просрочено на…», автоархив — от смены на дежурстве."""
    s.open('2026-10-26T08:31:00')
    enable_auto_archive(s)
    s.create_task('Еще тест', deadline='2026-10-26T09:00')
    s.open('2026-10-26T10:00:00')
    s.edit_task('Еще тест', status='Выполнена')                  # на час позже срока
    s.open('2026-11-03T21:50:00')
    # таймер автоархива проверяет n01–n03; здесь важна запись в истории, поэтому проверку вызываем сразу
    s.ev("autoArchiveCompleted()&&(render(),renderArchive())")
    assert texts(s, 'archive') == ['Еще тест'], texts(s, 'archive')
    arch = s.ev("db.history.find(h=>h.action==='Задача автоматически перемещена в архив')")
    duty = s.ev("at=>activeShiftAt(new Date(at))", arch['at'])
    assert arch['shift'] == duty and s.ev("db.archive[0].archivedShift") == duty, (arch['shift'], duty)
    assert s.ev("db.archive[0].shift") != duty, 'в этом сценарии смена создания и смена на дежурстве разные'
    tid = s.ev("db.archive[0].id")
    s.page.click('nav [data-screen="archive"]')
    s.page.click(f'[data-restore="{tid}"]')
    s.page.fill('#restoreDeadline', '2026-11-03T22:52')
    s.page.click('#restoreForm button.add')
    rest = s.ev("db.history.find(h=>h.action==='Задача восстановлена').details")
    assert 'Новый срок: 03.11.2026 22:52' in rest and 'T22:52' not in rest, rest
    s.edit_task('Еще тест', status='Выполнена')
    want = None
    for ts in ['2026-11-03T21:56:00', '2026-11-08T10:00:00']:      # и через пять дней — те же надписи
        s.open(ts)
        assert s.task_id('Еще тест'), (texts(s, 'tasks'), texts(s, 'archive'))
        m = history_minis(s, 'Еще тест')
        acts = [a for a, _, _ in m]
        assert acts == ['Изменён статус', 'Задача восстановлена', 'Задача автоматически перемещена в архив', 'Изменён статус', 'Создана задача'], acts
        dl = {a + str(i): d for i, (a, _, d) in enumerate(m)}
        assert 'выполнена в срок' in m[0][2], m[0]
        assert m[1][2].strip() == '⏱ Срок 03.11.2026 22:52', m[1]
        assert 'выполнена с опозданием на 1 час' in m[2][2] and 'выполнена с опозданием на 1 час' in m[3][2], m
        assert m[4][2].strip() == '⏱ Срок 26.10.2026 09:00', m[4]
        assert m[2][1] == duty
        assert not any('Просрочено на' in d or 'через' in d for d in dl.values()), dl
        card = s.page.locator('.history-task-card', has_text='Еще тест').locator(':scope > .deadline').inner_text()
        assert 'выполнена в срок' in card, card
        if want is None:
            want = m
        assert m == want, (m, want)
    assert not s.page_errors, s.page_errors


@test('V')
def v02_open_task_deadline_stays_live(s):
    """У открытой задачи срок в карточке «Истории» по-прежнему живой; у записи истории — на тот момент."""
    s.open('2026-10-21T10:00:00')
    s.create_task('Висит', deadline='2026-10-21T11:00')
    s.open('2026-10-21T12:30:00')
    s.page.click('nav [data-screen="history"]')
    card = s.page.locator('.history-task-card', has_text='Висит').locator(':scope > .deadline').inner_text()
    assert 'Просрочено на 1 час 30 минут' in card, card
    s.edit_task('Висит', comment='смотрим')
    m = history_minis(s, 'Висит')
    assert 'на тот момент просрочено на 1 час 30 минут' in m[0][2] and m[1][2].strip() == '⏱ Срок 21.10.2026 11:00', m
    assert not s.page_errors, s.page_errors


@test('V')
def v03_past_deadline_asks(s):
    """Срок в прошлом: программа переспрашивает; «Исправить срок» — окно остаётся, ничего не сохранено."""
    s.open('2026-10-21T10:00:00')
    p = s.page
    p.click('#addBtn'); p.fill('#text', 'Со старым сроком'); p.fill('#deadline', '2026-10-21T09:00')
    p.click('#form button.add')
    assert p.is_visible('#askDlg') and 'Срок уже прошёл' in p.inner_text('#askTitle')
    assert '21.10.2026 09:00' in p.inner_text('#askText')
    p.click('#askCancel')
    assert p.is_visible('#dlg') and s.task_id('Со старым сроком') is None
    p.click('#form button.add'); p.click('#askOk')
    assert s.task_id('Со старым сроком') and s.ev("db.tasks[0].deadline") == '2026-10-21T09:00'
    # срок не меняли — не спрашиваем; сразу «Выполнена» — не спрашиваем; будущий срок — не спрашиваем
    s.edit_task('Со старым сроком', comment='ещё раз')
    assert not p.is_visible('#askDlg') and not p.is_visible('#dlg')
    for text, st, dl in [('Сделано задним числом', 'Выполнена', '2026-10-21T08:00'), ('Нормальный срок', None, '2026-10-21T18:00')]:
        p.click('#addBtn'); p.fill('#text', text); p.fill('#deadline', dl)
        if st:
            p.select_option('#status', st)
        p.click('#form button.add')
        assert not p.is_visible('#askDlg'), text
    assert s.task_id('Сделано задним числом') and s.task_id('Нормальный срок')
    assert not s.page_errors, s.page_errors


# ---------- 1.7.9: часы компьютера отстают от базы, склонения ----------
@test('Y')
def y01_clock_rolled_back(s):
    """Часы перевели назад: новые записи — по настоящему времени, плашка предупреждает; вернулись часы — плашки нет."""
    s.open('2026-11-03T13:54:00')
    s.create_task('Из будущего')
    s.open('2026-10-25T16:15:00')
    p = s.page
    assert p.is_visible('#grass-clock-warn'), 'нет плашки про часы'
    assert '03.11.2026 13:54' in p.inner_text('#grass-clock-warn'), p.inner_text('#grass-clock-warn')
    s.create_task('Сегодняшняя', deadline='2026-10-25T16:13')
    h = s.ev("db.history.find(h=>h.text==='Сегодняшняя')")
    assert h['at'].startswith('2026-10-25T13:15'), h['at']           # 16:15 по Волгограду
    m = history_minis(s, 'Сегодняшняя')
    assert 'на тот момент просрочено на 2 минуты' in m[0][2], m
    card = p.locator('.history-task-card', has_text='Сегодняшняя').inner_text()
    assert '25.10' in card and '03.11' not in card, card
    # порядок событий в одну и ту же миллисекунду по-прежнему строгий
    a, b = s.ev("(()=>{const d=new Date();return [eventIso(d),eventIso(d)]})()")
    assert a < b, (a, b)
    # скрыть до перезапуска
    p.click('#grass-clock-warn-close')
    assert not p.is_visible('#grass-clock-warn')
    s.run_for('00:01:00')
    assert not p.is_visible('#grass-clock-warn')
    s.open('2026-10-25T16:20:00')
    assert s.page.is_visible('#grass-clock-warn')
    # часы догнали базу — плашки нет
    s.open('2026-11-03T13:56:00')
    assert not s.page.is_visible('#grass-clock-warn')
    assert not s.page_errors, s.page_errors


@test('Y')
def y02_no_warning_normally(s):
    """При нормальных часах плашки нет, в том числе на пустой базе и сразу после записи."""
    s.open('2026-10-21T10:00:00')
    assert not s.page.is_visible('#grass-clock-warn')
    s.create_task('Обычная')
    s.run_for('00:00:31')
    assert not s.page.is_visible('#grass-clock-warn')
    assert not s.page_errors, s.page_errors


@test('Y')
def y03_plural_forms(s):
    """Склонения: 0 минут, 1 минуту, 2 минуты, 11 минут, 21 час, 22 часа, 21 день, 1 задача / 2 задачи / 5 задач."""
    s.open('2026-10-21T10:00:00')
    M, H, D = 60000, 3600000, 86400000
    cases = {0: '0 минут', M: '1 минуту', 2 * M: '2 минуты', 11 * M: '11 минут', 21 * M: '21 минуту',
             21 * H: '21 час', 22 * H: '22 часа', 25 * H: '1 день 1 час', 21 * D: '21 день', 8 * D + 21 * H + 41 * M: '8 дней 21 час 41 минуту'}
    for ms, want in cases.items():
        assert s.ev(f"durationText({ms})") == want, (ms, s.ev(f"durationText({ms})"), want)
    assert s.ev("deadlineText(new Date().toISOString()).text") == 'Просрочено на 0 минут'
    assert s.ev("deadlineText(new Date(Date.now()+21*3600000+30000).toISOString()).text").endswith('(через 21 час)')
    got = s.ev("[1,2,5,11,21,22,111,112].map(n=>n+' '+plural(n,'задача','задачи','задач'))")
    assert got == ['1 задача', '2 задачи', '5 задач', '11 задач', '21 задача', '22 задачи', '111 задач', '112 задач'], got
    assert not s.page_errors, s.page_errors


# ---------- 1.7.11: вёрстка, ничего не пропало, надёжность, подпункты, объявления, «Слежу», «Что нового» ----------

HERE = os.path.dirname(os.path.abspath(__file__))
LAYOUT_JS = open(os.path.join(HERE, 'layout_check.js'), encoding='utf-8').read()
WIDTHS = [(1280, 800), (1600, 900), (1920, 1080)]


def screens_of(s):
    return s.ev("[...document.querySelectorAll('#sidebar nav [data-screen]')].map(b=>b.dataset.screen)")


@test('Z')
def z01_layout_three_widths(s):
    """Все экраны на 1280, 1600 и 1920 px: текст не наезжает на текст, нет горизонтальной прокрутки.
    Воскресенье — самое длинное название дня (на нём время наезжало на дату), среда — обычный день."""
    for day in ('2026-10-21T10:00:00', '2026-10-25T18:03:46'):
        s.open(day)
        if not s.ev("db.tasks.length"):
            s.create_task('Проверить pH партии 1245 после перемешивания в реакторе номер два', comment='длинный комментарий ' * 5, deadline='2026-10-26T12:00')
            s.create_task('Передать насос', status='Передать по смене')
        bad = []
        for w, h in WIDTHS:
            s.page.set_viewport_size({'width': w, 'height': h})
            for scr in screens_of(s):
                s.page.click(f'nav [data-screen="{scr}"]')
                s.page.wait_for_timeout(150)
                bad += [f'{day[:10]} {w}px {scr}: {p}' for p in s.page.evaluate(LAYOUT_JS)]
        assert not bad, '\n'.join(bad[:10])
    # карточка часов: дата, время и день недели видны целиком и не пересекаются
    s.page.set_viewport_size({'width': 1280, 'height': 800})
    s.page.click('nav [data-screen="tasks"]')
    r = s.ev("['dateMain','time','weekdayName'].map(i=>{const b=document.getElementById(i).getBoundingClientRect();return [b.left,b.right]})")
    assert r[0][1] <= r[1][0] and r[1][1] <= r[2][0], r
    assert s.ev("(()=>{const b=document.getElementById('weekdayName');return b.scrollWidth<=b.clientWidth})()"), 'название дня обрезано'


@test('Z')
def z02_nothing_lost_from_1710(s):
    """Правило Сани: ни одна кнопка, поле, окно и экран 1.7.10 не пропали (список ids_1.7.10.txt снят с 1.7.10)."""
    s.open('2026-10-21T10:00:00')
    want = open(os.path.join(HERE, 'ids_1.7.10.txt'), encoding='utf-8').read().split()
    have = set()
    for scr in screens_of(s):
        s.page.click(f'nav [data-screen="{scr}"]')
        have |= set(s.ev("[...document.querySelectorAll('[id]')].map(e=>e.id)"))
    missing = [i for i in want if i not in have]
    assert not missing, 'пропали: ' + ', '.join(missing)
    assert screens_of(s) == ['tasks', 'journal', 'history', 'stats', 'archive', 'settings'], screens_of(s)
    # каждый файл, который грузит окно, попадает в установщик (список files в package.json — явный)
    files = json.load(open(os.path.join(s.app_dir, 'package.json'), encoding='utf-8'))['build']['files']
    html = open(os.path.join(s.app_dir, 'index.html'), encoding='utf-8').read()
    used = set(re.findall(r'<script src="([^"]+)"', html)) | set(re.findall(r'<link[^>]+href="([^"]+\.css)"', html))
    lost = sorted(f for f in used if f not in files)
    assert not lost, 'не попадут в установщик: ' + ', '.join(lost)


# Действия в окне запускаются в самой странице без ожидания (через MessageChannel — его не подменяют часы стенда),
# поэтому 10 копий делают их одновременно, а не по очереди.
PAGE_JOB = """steps => { window.__job = (async () => {
  const tick = () => new Promise(r => { const c = new MessageChannel(); c.port1.onmessage = r; c.port2.postMessage(0); });
  await tick();
  const $ = id => document.getElementById(id);
  const set = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', {bubbles: true})); el.dispatchEvent(new Event('change', {bubbles: true})); };
  try {
    for (const st of steps) {
      if (st.create) { document.querySelector('nav [data-screen="tasks"]').click(); $('addBtn').click(); set($('text'), st.create);
        if (st.status) set($('status'), st.status); document.querySelector('#form button.add').click(); }
      if (st.remove) { const t = db.tasks.find(x => x.text === st.remove); document.querySelector(`#tasks .task[data-id="${t.id}"] .task-delete`).click(); $('deleteConfirm').click(); }
      if (st.acceptAll) { pullRemoteChanges(); render(); if ($('acceptHandover') && $('acceptHandover').offsetParent) $('acceptHandover').click(); }
      await tick(); await tick();                     // форма сохраняет асинхронно — дать ей закончить
    }
    return 'ok';
  } catch (e) { return 'ошибка: ' + (e && e.stack || e); }
})(); }"""


def run_together(team_, steps_of):
    for i, x in enumerate(team_):
        x.page.evaluate(PAGE_JOB, steps_of(i))
    out = []
    for x in team_:
        out.append(x.page.evaluate("async()=>await window.__job"))
    return out


@test('Z')
def z03_ten_people_handover_delete_accept(s):
    """10 копий на одной базе одновременно: создают, передают по смене, удаляют; ночью все десять разом жмут
    «Принять все» на одни и те же передачи. Ничего не теряется и не дублируется, каждая передача принята ровно один раз."""
    team_ = team(s, 10)
    for x in team_:
        x.open('2026-10-21T10:00:00')                                     # день, смена A
    res = run_together(team_, lambda i: [{'create': f'К{i} передать 1', 'status': 'Передать по смене'},
                                         {'create': f'К{i} передать 2', 'status': 'Передать по смене'},
                                         {'create': f'К{i} удалить'}, {'remove': f'К{i} удалить'}])
    assert res == ['ok'] * 10, res
    assert ssql(s, "SELECT COUNT(*) FROM tasks WHERE state='active'")[0][0] == 20
    assert ssql(s, "SELECT COUNT(*) FROM tasks WHERE state='archive'")[0][0] == 10
    assert ssql(s, "SELECT COUNT(*), COUNT(DISTINCT id) FROM tasks") == [(30, 30)]
    for x in team_:
        x.open('2026-10-21T21:00:00')                                     # ночь, смена C
    res = run_together(team_, lambda i: [{'acceptAll': True}])
    assert res == ['ok'] * 10, res
    for x in team_:
        pull(x)
    rows = ssql(s, "SELECT text, status, to_shift FROM tasks WHERE state='active' ORDER BY text")
    assert len(rows) == 20 and all(r[1] == 'В работе' and r[2] is None for r in rows), rows
    hist = ssql(s, "SELECT text, action, COUNT(*) FROM task_history GROUP BY text, action")
    per = {(t, a): n for t, a, n in hist}
    for i in range(10):
        for k in (1, 2):
            name = f'К{i} передать {k}'
            assert per.get((name, 'Создана задача')) == 1, (name, per)
            assert per.get((name, 'Задача принята')) == 1, (name, per)
    for x in team_:
        assert x.ev("db.tasks.length") == 20 and x.ev("db.archive.length") == 10
        assert not x.page.is_visible('#acceptHandover')


def backups_dir(s):
    return os.path.join(s.user_data, 'data', 'backups')


def check_backup_now(s):
    s.page.click('nav [data-screen="settings"]')
    s.page.click('#checkBackupBtn')
    s.page.wait_for_function("!document.getElementById('dbInfoBackupCheck').textContent.includes('Проверяем')")
    return s.page.inner_text('#dbInfoBackupCheck')


@test('Z')
def z04_backup_check_daily_and_by_button(s):
    """Проверка последней копии: целая — «✓ цела», испорченная — «⚠ не годится» и жёлтая плашка;
    каждый день после дневной копии проверка сама; рядом с копиями не остаётся служебных файлов."""
    s.open('2026-10-21T10:00:00')
    s.create_task('Есть в копии')
    assert 'grass-daily-' in check_backup_now(s) and '✓ цела' in s.page.inner_text('#dbInfoBackupCheck')   # дневная копия при запуске уже проверена
    s.page.click('#createBackupBtn')
    s.page.wait_for_function("document.getElementById('backupStatus').textContent.includes('Создано')")
    name = s.page.inner_text('#backupStatus').replace('Создано:', '').strip()
    text = check_backup_now(s)
    assert text.startswith('✓ цела') and name in text, text
    assert not s.page.is_visible('#grass-health')
    with open(os.path.join(backups_dir(s), name), 'r+b') as f:   # копию испортили (диск, антивирус, обрыв копирования)
        f.write(b'\xA5' * 4096)
    text = check_backup_now(s)
    assert text.startswith('⚠') and name in text and 'не годится' in text, text
    assert s.page.is_visible('#grass-health') and 'не годится для восстановления' in s.page.inner_text('#grass-health')
    assert s.ev("document.getElementById('dbInfoBackupCheck').classList.contains('bad')")
    # результат проверки хранится в базе: после перезапуска «Состояние» показывает его же
    s.open('2026-10-21T10:30:00')
    s.page.click('nav [data-screen="settings"]'); s.page.click('#refreshDbInfoBtn')
    s.page.wait_for_function("document.getElementById('dbInfoBackupCheck').textContent.startsWith('⚠')")
    # следующий день (main.js на стенде живёт по настоящим часам — день сбрасываем в базе, как в тестах H):
    # новая дневная копия проверена сама — снова «цела», плашки нет
    s.stop_main()
    con = sqlite3.connect(db_file(s)); con.execute("UPDATE app_meta SET value='2000-01-01' WHERE key='daily_backup_date'"); con.commit(); con.close()
    s.open('2026-10-22T10:00:00')
    s.page.wait_for_timeout(1500)                              # дневная работа идёт сразу после запуска
    s.page.click('nav [data-screen="settings"]'); s.page.click('#refreshDbInfoBtn')
    s.page.wait_for_function("document.getElementById('dbInfoBackupCheck').textContent.startsWith('✓')")
    assert 'grass-daily-' in s.page.inner_text('#dbInfoBackupCheck')
    assert not s.page.is_visible('#grass-health')
    assert not [n for n in os.listdir(backups_dir(s)) if n.endswith(('-wal', '-shm'))], os.listdir(backups_dir(s))


def fake_session(s, version, ago_s=0):
    at = time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime(time.time() - ago_s))
    swrite(s, "INSERT INTO sessions(session_id,os_user,technologist,site_id,app_version,started_at,last_seen) VALUES(?,?,?,?,?,?,?)",
           f'fake-{version}', 'server', 'Рычков С.С.', 'AHTUBA', version, at, at)


@test('Z')
def z05_soft_update_old_copy_stops_writing(s):
    """Мягкое обновление в терминале: пока с базой работает копия новее, эта не пишет и просит перезайти.
    Копия старее не мешает; личные настройки (кто я) не блокируются; после перезапуска без новой копии — работа как обычно."""
    a, b = team(s, 2)
    a.open('2026-10-21T10:00:00'); b.open('2026-10-21T10:00:00')
    fake_session(a, '1.0.0')                                   # кто-то на старой версии — не помеха
    a.create_task('При старой рядом')
    assert ssql(a, "SELECT text FROM tasks") == [('При старой рядом',)]
    assert not a.page.is_visible('#grass-save-error')
    fake_session(a, '99.0.0')                                  # администратор поставил новую, кто-то её уже открыл
    a.run_for('00:00:04')                                      # опрос изменений раз в 3 с
    assert 'Вышла новая версия программы 99.0.0' in bar_text(a), bar_text(a)
    a.create_task('Не сохранится')
    assert ssql(a, "SELECT COUNT(*) FROM tasks")[0][0] == 1
    a.page.keyboard.press('Escape')
    # запись в обход окна тоже не проходит
    r = bridge_sync(a, 'grass-db-patch', 'grass_v02', json.dumps({'tasks': [{'state': 'active', 'task': {'id': 'x1', 'text': 'обход'}, 'baseRev': None}]}))
    assert not r['ok'] and r['outdated'] and r['newer'] == '99.0.0', r
    be(a, 'Егоров Е.В.')                                      # личное — в профиле, не в базе: работает
    # вторая копия тоже узнаёт сама, без попытки сохранить
    b.run_for('00:00:04')
    assert 'Вышла новая версия программы 99.0.0' in bar_text(b), bar_text(b)
    swrite(a, "DELETE FROM sessions WHERE session_id='fake-99.0.0'")
    a.open('2026-10-21T10:10:00')                              # перезашёл — новой копии уже нет
    a.create_task('После перезапуска')
    assert sorted(r[0] for r in ssql(a, "SELECT text FROM tasks")) == ['После перезапуска', 'При старой рядом']
    assert not a.page.is_visible('#grass-save-error')
    # давно закрытая новая копия (сессия старше 90 с) не блокирует
    fake_session(a, '99.0.0', ago_s=300)
    a.run_for('00:00:04')
    a.create_task('Старая сессия не мешает')
    assert ssql(a, "SELECT COUNT(*) FROM tasks")[0][0] == 3


@test('Z')
def z06_unknown_task_fields_survive_edits(s):
    """Поля, которых эта версия не знает (их добавит более новая), переживают правку, передачу, архив и восстановление.
    Так же ведёт себя 1.7.10 (тот же код сохранения) — поэтому новые поля 1.7.11 не теряются при откате или старой копии рядом."""
    s.open('2026-10-21T10:00:00')
    s.create_task('С будущим полем')
    tid = s.task_id('С будущим полем')
    s.stop_main()
    extra = json.loads(sql(s, "SELECT extra_json FROM tasks WHERE id=?", tid)[0][0])
    extra['futureField'] = {'items': [1, 2, 3]}
    con = sqlite3.connect(db_file(s)); con.execute("UPDATE tasks SET extra_json=? WHERE id=?", (json.dumps(extra), tid)); con.commit(); con.close()
    s.open('2026-10-21T10:10:00')
    s.edit_task('С будущим полем', status='Передать по смене', comment='правка')
    s.page.click(f'#tasks .task[data-id="{tid}"] .task-delete'); s.page.click('#deleteConfirm')
    s.page.click('nav [data-screen="archive"]'); s.page.click(f'[data-restore="{tid}"]')
    s.page.click('#restoreForm button.add')
    s.open('2026-10-21T10:20:00')
    assert s.ev("db.tasks.length") == 1, 'задача не восстановилась'
    got = json.loads(sql(s, "SELECT extra_json FROM tasks WHERE id=?", tid)[0][0])
    assert got.get('futureField') == {'items': [1, 2, 3]}, got
    assert s.ev("db.tasks[0].comment") == 'правка'


def open_task_dlg(s, text):
    s.page.click('nav [data-screen="tasks"]')
    s.show_task(s.task_id(text))
    s.page.click(f'#tasks .task[data-id="{s.task_id(text)}"]')
    s.page.wait_for_selector('#dlg[open]')


def add_subtask(s, text):
    s.page.fill('#subtaskText', text)
    s.page.click('#subtaskAdd')


def sub_box(s, text):
    return s.page.locator('#subtasksList .subtask', has_text=text).locator('input[type=checkbox]')


@test('Z')
def z07_subtasks_who_and_when(s):
    """Подпункты: у новой задачи сохраняются вместе с созданием; у существующей отметка сохраняется сразу,
    с тем, кто и в какую смену сделал; всё в истории; в карточке «☑ 1/3»; после перезапуска на месте; окно не ругается на «чужую» правку."""
    s.open('2026-10-21T10:00:00')                                  # день, смена A
    be(s, 'Носиков А.Ю.')
    p = s.page
    p.click('nav [data-screen="tasks"]'); p.click('#addBtn'); p.fill('#text', 'Заменить уплотнение насоса')
    add_subtask(s, 'Снять насос'); add_subtask(s, 'Заказать уплотнение'); add_subtask(s, 'Поставить')
    assert p.inner_text('#subtasksProgress') == '0 из 3'
    p.click('#form button.add')
    t = s.ev("db.tasks[0]")
    assert [x['text'] for x in t['subtasks']] == ['Снять насос', 'Заказать уплотнение', 'Поставить'], t
    acts = s.ev("db.history.map(h=>h.action+'|'+h.details)")
    assert any(a.startswith('Добавлены подпункты|«Снять насос»') for a in acts), acts
    # ночь, смена C, другой технолог отмечает первый пункт — сохраняется сразу, без «Сохранить»
    s.open('2026-10-21T21:00:00')
    p = s.page                                                     # после перезапуска — новая страница
    be(s, 'Егоров Е.В.')
    open_task_dlg(s, 'Заменить уплотнение насоса')
    sub_box(s, 'Снять насос').check()
    who = p.locator('#subtasksList .subtask', has_text='Снять насос').inner_text()
    assert 'Егоров Е.В.' in who and 'смена C' in who, who
    assert p.inner_text('#subtasksProgress') == '1 из 3'
    st = json.loads(sql(s, "SELECT extra_json FROM tasks")[0][0])['subtasks']
    assert st[0]['done'] and st[0]['doneBy'] == 'Егоров Е.В.' and st[0]['doneShift'] == 'C', st
    p.fill('#comment', 'начали'); p.click('#form button.add')       # «Сохранить» после отметки — без «задачу изменил …»
    assert not p.is_visible('#dlg'), p.inner_text('#dlgNotice')
    assert s.ev("db.tasks[0].comment") == 'начали' and s.ev("db.tasks[0].subtasks[0].done")
    h = s.ev("db.history.find(h=>h.action==='Подпункт выполнен')")
    assert h['details'] == '«Снять насос»' and h['author'] == 'Егоров Е.В.' and h['shift'] == 'C', h
    card = p.locator(f'#tasks .task[data-id="{s.task_id("Заменить уплотнение насоса")}"]')
    assert '☑ 1/3' in card.inner_text(), card.inner_text()
    # снять отметку, удалить пункт, добавить пункт — всё в истории, после перезапуска на месте
    open_task_dlg(s, 'Заменить уплотнение насоса')
    sub_box(s, 'Снять насос').uncheck()
    p.locator('#subtasksList .subtask', has_text='Поставить').locator('[data-sub-del]').click()
    add_subtask(s, 'Проверить на утечку')
    p.click('#cancel')
    s.open('2026-10-21T21:30:00')
    p = s.page
    assert '☑ 0/3' in p.locator(f'#tasks .task[data-id="{s.task_id("Заменить уплотнение насоса")}"]').inner_text()   # значок и сразу после запуска
    assert [(x['text'], x['done']) for x in s.ev("db.tasks[0].subtasks")] == [('Снять насос', False), ('Заказать уплотнение', False), ('Проверить на утечку', False)]
    acts = s.ev("db.history.map(h=>h.action)")
    for a in ('Подпункт снова открыт', 'Удалён подпункт', 'Добавлен подпункт'):
        assert a in acts, (a, acts)
    # история задачи на экране «История» показывает подпункты (с тем, кто и в какую смену)
    m = history_minis(s, 'Заменить уплотнение насоса')
    assert ('Подпункт выполнен', 'C', '') in [(a, sh, '') for a, sh, _ in m], m
    for a in ('Добавлены подпункты', 'Подпункт снова открыт', 'Удалён подпункт', 'Добавлен подпункт'):
        assert a in [x[0] for x in m], (a, m)


@test('Z')
def z08_subtasks_shared_two_copies(s):
    """Общая база: два технолога одновременно отмечают разные подпункты одной задачи — обе отметки сохранились."""
    a, b = team(s, 2)
    a.open('2026-10-21T10:00:00'); b.open('2026-10-21T10:00:00')
    be(a, 'Носиков А.Ю.'); be(b, 'Егоров Е.В.')
    a.page.click('#addBtn'); a.page.fill('#text', 'Общая с подпунктами')
    add_subtask(a, 'Первый'); add_subtask(a, 'Второй'); a.page.click('#form button.add')
    pull(b)
    open_task_dlg(a, 'Общая с подпунктами'); open_task_dlg(b, 'Общая с подпунктами')   # оба открыли окно одновременно
    sub_box(a, 'Первый').check()
    sub_box(b, 'Второй').check()                                    # у b устаревшая версия — программа берёт свежую
    pull(a)
    got = {x['text']: (x['done'], x['doneBy']) for x in json.loads(ssql(s, "SELECT extra_json FROM tasks")[0][0])['subtasks']}
    assert got == {'Первый': (True, 'Носиков А.Ю.'), 'Второй': (True, 'Егоров Е.В.')}, got
    assert a.ev("db.tasks[0].subtasks.filter(x=>x.done).length") == 2


@test('Z')
def z09_pinned_announcement(s):
    """Объявление площадки: сверху у всех смен этой площадки до даты включительно, потом пропадает само;
    снять раньше можно (у всех); у Волжского своих объявлений Ахтубы нет; видно другим копиям на общей базе."""
    a, b, v = team(s, 3, sites={2: 'VOLZHSKY'})
    for x in (a, b, v):
        x.open('2026-10-21T10:00:00')
    be(a, 'Носиков А.Ю.')
    p = a.page
    p.click('#announceAddBtn'); p.wait_for_selector('#announceDlg[open]')
    p.fill('#announceText', 'Линия 3 на ремонте')
    assert p.get_attribute('#announceUntil', 'min') == '2026-10-21'
    p.fill('#announceUntil', '2026-10-20')                         # прошедшая дата — не сохраняется
    p.click('#announceSave')
    assert p.is_visible('#announceDlg') and s.ev("GrassAnnounce.active().length") == 0
    p.fill('#announceUntil', '2026-10-23'); p.click('#announceSave')
    assert not p.is_visible('#announceDlg')
    assert 'Линия 3 на ремонте' in p.inner_text('#announceBar') and 'до 23.10.2026' in p.inner_text('#announceBar')
    b.run_for('00:00:04')                                          # вторая копия Ахтубы — увидела сама
    assert b.page.is_visible('#announceBar') and 'Линия 3 на ремонте' in b.page.inner_text('#announceBar')
    v.run_for('00:00:04')
    assert not v.page.is_visible('#announceBar'), 'у Волжского не должно быть объявлений Ахтубы'
    # другая смена (ночь) и последний день — видно; на следующий день — пропало само
    b.open('2026-10-23T22:00:00')
    assert 'Линия 3 на ремонте' in b.page.inner_text('#announceBar')
    b.open('2026-10-24T08:40:00')
    assert not b.page.is_visible('#announceBar')
    # второе объявление снимают раньше срока — пропадает у всех
    a.open('2026-10-24T09:00:00')
    p = a.page
    p.click('#announceAddBtn'); p.fill('#announceText', 'Не включать мешалку 2'); p.fill('#announceUntil', '2026-10-30'); p.click('#announceSave')
    b.run_for('00:00:04')
    assert 'мешалку 2' in b.page.inner_text('#announceBar')
    b.page.click('[data-announce-close]'); b.page.click('#askOk')
    assert not b.page.is_visible('#announceBar')
    a.run_for('00:00:04')
    assert not a.page.is_visible('#announceBar')
    a.open('2026-10-24T09:10:00')
    assert not a.page.is_visible('#announceBar')


@test('Z')
def z10_watch_task_notifications(s):
    """«Слежу за задачей»: изменила или закрыла другая смена — уведомление Windows; своя правка — без уведомления;
    список личный (у другого технолога нет); в карточке «👁»."""
    a, b = team(s, 2)
    a.open('2026-10-21T10:00:00'); b.open('2026-10-21T10:00:00')
    be(a, 'Носиков А.Ю.'); be(b, 'Егоров Е.В.')
    a.create_task('Слежу за этой')
    open_task_dlg(a, 'Слежу за этой')
    assert a.page.inner_text('#watchToggle') == '👁 Следить'
    a.page.click('#watchToggle')
    assert a.page.inner_text('#watchToggle') == '👁 Слежу'
    a.page.click('#cancel')
    assert '👁' in a.page.locator(f'#tasks .task[data-id="{a.task_id("Слежу за этой")}"] .task-meta-right').inner_text()
    notes = lambda x: [n for n in x.state()['notifications']]
    base = len(notes(a))
    a.edit_task('Слежу за этой', comment='своя правка')                 # своё — молчим
    a.run_for('00:00:31')
    assert len(notes(a)) == base, notes(a)[base:]
    pull(b)
    b.edit_task('Слежу за этой', status='Передать по смене')           # чужая правка
    a.run_for('00:00:04')
    new = notes(a)[base:]
    assert len(new) == 1 and 'Задача изменена' in json.dumps(new, ensure_ascii=False) and 'Егоров Е.В.' in json.dumps(new, ensure_ascii=False), new
    pull(b)
    b.edit_task('Слежу за этой', status='Выполнена')
    a.run_for('00:00:04')
    assert 'Задача закрыта' in json.dumps(notes(a)[base + 1:], ensure_ascii=False), notes(a)
    # у Егорова (b) своего списка нет: он не следит
    assert not b.ev("GrassWatch.isWatched(db.tasks[0].id)")
    # после перезапуска «Слежу» сохраняется, повтор уже показанного не приходит
    a.open('2026-10-21T10:30:00')
    count = len(notes(a))
    a.run_for('00:00:31')
    assert len(notes(a)) == count
    assert a.ev("GrassWatch.isWatched(db.tasks[0].id)")


@test('Z')
def z11_whats_new_once(s):
    """«Что нового» при первом запуске новой версии: 3–5 строк, один раз на пользователя; на новой установке не показывается."""
    s.seed_whatsnew = False                                        # честный путь, без подсказки стенда
    s.open('2026-10-21T10:00:00')
    assert not s.page.is_visible('#whatsNewDlg')                   # новая установка (стенд — как новая)
    s.create_task('Была до обновления')
    s.ev("localStorage.removeItem('grass_whatsnew_seen')")         # как после обновления с 1.7.10: отметки ещё нет
    s.open('2026-10-21T10:10:00', keep_summary=True)
    s.page.evaluate("(()=>{const d=document.getElementById('shiftSummaryDlg');if(d&&d.open)d.close();})()")
    s.run_for('00:00:02')                                          # окно ждёт, пока закроют сводку смены
    assert s.page.is_visible('#whatsNewDlg')
    ver = json.load(open(os.path.join(s.app_dir, 'package.json'), encoding='utf-8'))['version']
    assert ver in s.page.inner_text('#whatsNewDlg h2')
    n = s.ev("document.querySelectorAll('#whatsNewDlg li').length")
    assert 3 <= n <= 5, n
    s.page.click('#whatsNewOk')
    assert not s.page.is_visible('#whatsNewDlg')
    s.open('2026-10-21T10:20:00')
    s.run_for('00:00:02')
    assert not s.page.is_visible('#whatsNewDlg')
    assert s.ev("localStorage.getItem('grass_whatsnew_seen')") == ver


# ======================= E: 1.7.12 «Безопасность» =======================

def accounts_team(s, accounts, admins=None, sites=None, extra_cfg=None):
    """Копии программы на одной общей базе, у каждой своя учётка Windows (GRASS_TEST_OS_USER).
    admins — список администраторов в grass-config.json (с ним включается закрепление технологов)."""
    root = tempfile.mkdtemp(prefix='grass-shared-')
    data = os.path.join(root, 'data')
    cfg = os.path.join(root, 'grass-config.json')
    body = {'dataDir': data}
    if admins is not None:
        body['admins'] = admins
    body.update(extra_cfg or {})
    with open(cfg, 'w', encoding='utf-8') as f:
        json.dump(body, f, ensure_ascii=False)
    env = {'GRASS_CONFIG_FILE': cfg, 'GRASS_TEST_FIRSTRUN': '0'}
    s.extra_env.update(env, GRASS_TEST_OS_USER=accounts[0])
    s.shared_data = data
    s.config_file = cfg
    out = [s]
    for i, acc in enumerate(accounts[1:], start=1):
        x = Stand(s.browser, s.app_dir, tempfile.mkdtemp(prefix='grass-ud-'), site=(sites or {}).get(i, 'AHTUBA'),
                  extra_env=dict(env, GRASS_TEST_OS_USER=acc))
        x.shared_data = data
        x.config_file = cfg
        s.extras.append(x)
        out.append(x)
    return out


def bind_names(x):
    return x.ev("[...document.querySelectorAll('#bindList [data-bind-name]')].map(b=>b.dataset.bindName)")


def bind_as(x, name, new=False):
    """Окно «Кто вы?»: выбрать себя (или вписать, если нет в списке) и подтвердить."""
    p = x.page
    p.wait_for_selector('#bindDlg[open]')
    if new:
        p.fill('#bindNewName', name)
        p.click('#bindAddBtn')
    else:
        p.click(f'#bindList [data-bind-name="{name}"]')
    assert 'только администратор' in p.inner_text('#bindConfirmText'), p.inner_text('#bindConfirmText')
    p.click('#bindOk')
    p.wait_for_selector('#bindDlg', state='hidden')
    assert x.ev("technologist") == name, x.ev("technologist")


def bindings(x):
    rows = ssql(x, "SELECT value FROM settings WHERE key='techBindings'")
    return {k: v['name'] for k, v in json.loads(rows[0][0]).items()} if rows else {}


def tech_list_db(x):
    return json.loads(ssql(x, "SELECT value FROM settings WHERE key='technologists'")[0][0])


def delete_tech(x, name):
    x.page.click('nav [data-screen="settings"]')
    x.page.locator('#technologistsList .technologist-item', has_text=name).locator('.technologist-delete').click()
    x.page.click('#askOk')


@test('E')
def e00_nothing_lost_from_1711(s):
    """Правило Сани: ни одна кнопка, поле, окно и экран 1.7.11 не пропали (список ids_1.7.11.txt снят с настоящей 1.7.11)."""
    s.open('2026-10-21T10:00:00')
    want = open(os.path.join(HERE, 'ids_1.7.11.txt'), encoding='utf-8').read().split()
    have = set()
    for scr in screens_of(s):
        s.page.click(f'nav [data-screen="{scr}"]')
        have |= set(s.ev("[...document.querySelectorAll('[id]')].map(e=>e.id)"))
    missing = [i for i in want if i not in have]
    assert not missing, 'пропали: ' + ', '.join(missing)
    assert screens_of(s) == ['tasks', 'journal', 'history', 'stats', 'archive', 'settings'], screens_of(s)


@test('E')
def e01_os_user_in_every_history_record(s):
    """Учётка Windows пишется в каждую запись истории (её ставит main.js — из окна не подделать),
    видна подсказкой у автора в истории задачи; дома всё остальное как раньше (окна «Кто вы?» нет)."""
    s.extra_env['GRASS_TEST_OS_USER'] = 'tech.ivanov'
    s.open('2026-10-21T10:00:00')
    assert not s.page.is_visible('#bindDlg') and not s.ev("techBinding.enabled")
    s.create_task('С учёткой', status='Передать по смене')
    s.edit_task('С учёткой', comment='правка')
    be(s, 'Егоров Е.В.')                                           # дома технолога по-прежнему выбирают в списке
    s.edit_task('С учёткой', comment='правка 2')
    rows = sql(s, "SELECT action, author, os_user FROM task_history")
    assert len(rows) >= 3 and all(r[2] == 'tech.ivanov' for r in rows), rows
    assert {r[1] for r in rows} == {'Носиков А.Ю.', 'Егоров Е.В.'}, rows
    # подделка из окна: в событии чужая учётка — в базу всё равно ложится настоящая
    tid = s.task_id('С учёткой')
    r = bridge_sync(s, 'grass-db-patch', 'grass_v02', json.dumps({'historyAdd': [{'id': 'fake-h1', 'taskId': tid, 'text': 'С учёткой', 'action': 'Изменена задача', 'osUser': 'hacker', 'at': '2026-10-21T07:00:00.000Z'}]}))
    assert r['ok'], r
    assert sql(s, "SELECT os_user, extra_json FROM task_history WHERE id='fake-h1'") == [('tech.ivanov', '{}')]
    s.open('2026-10-21T10:10:00')
    s.page.click('nav [data-screen="history"]')
    s.page.locator('.history-task-card summary').first.click()
    s.page.wait_for_selector('.history-mini')
    titles = s.ev("[...document.querySelectorAll('.history-mini .hist-osuser')].map(e=>e.title)")
    assert titles and all(t == 'Учётка Windows: tech.ivanov' for t in titles), titles


@test('E')
def e02_technologist_bound_to_account(s):
    """Общая база с администраторами: при первом запуске «Вы вошли как <учётка>. Кто вы?» только со свободными именами,
    подтверждение «поменять сможет только администратор»; дальше программа сама под этим технологом, чужое имя не выбрать
    (ни в окне, ни в обход окна); «Меня нет в списке»; удалить технолога и перепривязать может только администратор."""
    a, b, boss = accounts_team(s, ['ivanov', 'petrov', 'boss'], admins=['SERVER\\Boss'])
    a.open('2026-10-21T10:00:00')
    p = a.page
    assert p.is_visible('#bindDlg') and 'Вы вошли как ivanov' in p.inner_text('#bindTitle')
    assert bind_names(a) == ['Носиков А.Ю.', 'Егоров Е.В.', 'Покусаев Е.С.', 'Рычков С.С.', 'Никулин О.В.', 'Степуро О.В.']
    p.keyboard.press('Escape')
    assert p.is_visible('#bindDlg'), 'окно «Кто вы?» не закрывается без выбора'
    p.click('#bindList [data-bind-name="Егоров Е.В."]')
    assert 'Закрепить «Егоров Е.В.» за собой' in p.inner_text('#bindConfirmText')
    p.click('#bindBack')
    assert len(bind_names(a)) == 6
    bind_as(a, 'Егоров Е.В.')
    assert bindings(a) == {'ivanov': 'Егоров Е.В.'}
    p.click('#techBtn')
    assert a.ev("[...document.querySelectorAll('#techMenu button')].map(b=>b.textContent)") == ['Егоров Е.В.']
    assert 'Закреплён за учёткой ivanov' in p.inner_text('#techMenu')
    p.click('#techBtn')
    a.create_task('Создал Егоров')
    assert ssql(a, "SELECT author, os_user FROM task_history") == [('Егоров Е.В.', 'ivanov')]
    # вторая учётка: Егорова в списке уже нет; вписывает себя сам
    b.open('2026-10-21T10:00:00')
    assert 'Егоров Е.В.' not in bind_names(b) and len(bind_names(b)) == 5
    r = bridge_sync(b, 'grass-bind-claim', 'Егоров Е.В.')           # в обход окна — тоже нельзя
    assert not r['ok'] and r.get('taken'), r
    bind_as(b, 'Петров П.П.', new=True)
    assert 'Петров П.П.' in tech_list_db(b)
    assert bindings(b) == {'ivanov': 'Егоров Е.В.', 'petrov': 'Петров П.П.'}
    # перезапуск — без вопроса, сразу под своим
    a.open('2026-10-21T10:10:00')
    assert not a.page.is_visible('#bindDlg') and a.ev("technologist") == 'Егоров Е.В.'
    r = bridge_sync(a, 'grass-db-set', 'technologist', 'Носиков А.Ю.')
    assert not r['ok'] and 'только администратор' in r['error'], r
    r = bridge_sync(a, 'grass-db-set', 'techBindings', json.dumps({'ivanov': {'name': 'Носиков А.Ю.'}}))
    assert not r['ok'], r
    assert bridge_sync(a, 'grass-db-remove', 'techBindings') is False
    r = bridge_sync(a, 'grass-bind-release', 'petrov')
    assert not r['ok'] and r.get('adminOnly'), r
    r = bridge_sync(a, 'grass-bind-claim', 'Носиков А.Ю.')          # второй раз закрепиться нельзя
    assert not r['ok'] and 'уже закреплена' in r['error'], r
    # удалить технолога может только администратор — проверка в main.js, кнопка на месте
    delete_tech(a, 'Степуро О.В.')
    assert 'только администратор' in a.page.inner_text('#askText'), a.page.inner_text('#askText')
    a.page.click('#askOk')
    assert 'Степуро О.В.' in tech_list_db(a)
    r = bridge_sync(a, 'grass-db-set', 'technologists', json.dumps(['Егоров Е.В.']))   # в обход окна — тоже нет
    assert not r['ok'] and 'только администратор' in r['error'], r
    assert 'учётка: petrov' in a.page.locator('#technologistsList .technologist-item', has_text='Петров П.П.').inner_text()
    # администратор: закрепляется сам, отвязывает Петрова и удаляет технологов
    boss.open('2026-10-21T10:20:00')
    bind_as(boss, 'Носиков А.Ю.')
    boss.page.click('nav [data-screen="settings"]')
    boss.page.locator('#technologistsList .technologist-item', has_text='Петров П.П.').locator('.technologist-unbind').click()
    boss.page.click('#askOk')
    assert bindings(boss) == {'ivanov': 'Егоров Е.В.', 'boss': 'Носиков А.Ю.'}
    delete_tech(boss, 'Степуро О.В.')
    assert 'Степуро О.В.' not in tech_list_db(boss)
    delete_tech(boss, 'Егоров Е.В.')                                # удаление само отвязывает от учётки
    assert bindings(boss) == {'boss': 'Носиков А.Ю.'}
    # Петров после перепривязки: снова «Кто вы?», выбирает другое свободное имя
    b.open('2026-10-21T10:30:00')
    assert b.page.is_visible('#bindDlg') and 'Носиков А.Ю.' not in bind_names(b) and 'Петров П.П.' in bind_names(b)
    bind_as(b, 'Рычков С.С.')
    # ivanov отвязан (его технолога удалили) — может закрепиться заново, но не на занятое имя
    r = bridge_sync(a, 'grass-bind-claim', 'Рычков С.С.')
    assert not r['ok'] and r.get('taken'), r
    r = bridge_sync(a, 'grass-bind-claim', 'Покусаев Е.С.')
    assert r['ok'], r
    assert bindings(a) == {'boss': 'Носиков А.Ю.', 'petrov': 'Рычков С.С.', 'ivanov': 'Покусаев Е.С.'}


@test('E')
def e03_no_admins_list_works_as_before(s):
    """Общая база без списка администраторов (как настроено сейчас): окна «Кто вы?» нет, технолога выбирают в списке,
    удалять технологов можно, как в 1.7.11. Учётка в историю всё равно пишется."""
    a, b = accounts_team(s, ['ivanov', 'petrov'])
    a.open('2026-10-21T10:00:00')
    b.open('2026-10-21T10:00:00')
    assert not a.page.is_visible('#bindDlg') and not b.page.is_visible('#bindDlg')
    be(a, 'Егоров Е.В.')
    be(b, 'Егоров Е.В.')
    a.create_task('Без админов')
    assert ssql(a, "SELECT author, os_user FROM task_history") == [('Егоров Е.В.', 'ivanov')]
    delete_tech(a, 'Степуро О.В.')
    assert 'Степуро О.В.' not in tech_list_db(a)


@test('E')
def e04_ten_people_bound_handover(s):
    """10 человек под своими учётками на одной базе: каждый закрепляется за своим именем (6 из списка, 4 вписывают себя),
    одновременно создают, передают, удаляют; ночью все разом «Принять все». Ничего не теряется и не дублируется,
    у каждой записи истории — учётка того, кто её сделал."""
    accs = [f'user{i}' for i in range(10)]
    team_ = accounts_team(s, accs, admins=['admin'])
    names = ['Носиков А.Ю.', 'Егоров Е.В.', 'Покусаев Е.С.', 'Рычков С.С.', 'Никулин О.В.', 'Степуро О.В.'] + [f'Новый{i} Н.Н.' for i in range(6, 10)]
    for i, x in enumerate(team_):
        x.open('2026-10-21T10:00:00')
        bind_as(x, names[i], new=i >= 6)
    assert bindings(s) == dict(zip(accs, names))
    res = run_together(team_, lambda i: [{'create': f'К{i} передать 1', 'status': 'Передать по смене'},
                                         {'create': f'К{i} передать 2', 'status': 'Передать по смене'},
                                         {'create': f'К{i} удалить'}, {'remove': f'К{i} удалить'}])
    assert res == ['ok'] * 10, res
    assert ssql(s, "SELECT COUNT(*), COUNT(DISTINCT id) FROM tasks") == [(30, 30)]
    for x in team_:
        x.open('2026-10-21T21:00:00')
        assert not x.page.is_visible('#bindDlg')
    res = run_together(team_, lambda i: [{'acceptAll': True}])
    assert res == ['ok'] * 10, res
    for x in team_:
        pull(x)
    rows = ssql(s, "SELECT text, status, to_shift FROM tasks WHERE state='active' ORDER BY text")
    assert len(rows) == 20 and all(r[1] == 'В работе' and r[2] is None for r in rows), rows
    per = {(t, a): n for t, a, n in ssql(s, "SELECT text, action, COUNT(*) FROM task_history GROUP BY text, action")}
    for i in range(10):
        for k in (1, 2):
            assert per.get((f'К{i} передать {k}', 'Создана задача')) == 1 and per.get((f'К{i} передать {k}', 'Задача принята')) == 1, per
        created = ssql(s, "SELECT author, os_user FROM task_history WHERE text=? AND action='Создана задача'", f'К{i} передать 1')
        assert created == [(names[i], accs[i])], created
    acc_of = dict(zip(names, accs))
    accepted = ssql(s, "SELECT author, os_user FROM task_history WHERE action='Задача принята'")
    assert len(accepted) == 20 and all(acc_of[a] == u for a, u in accepted), accepted


def bridge_invoke(x, channel, *args):
    req = urllib.request.Request(f'http://127.0.0.1:{x.port}/__invoke', data=json.dumps({'channel': channel, 'args': list(args)}).encode(),
                                 headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())['value']


@test('E')
def e05_dangerous_attachments_blocked(s):
    """Опасные файлы (exe, bat, js, ярлыки, макросы и т.п.) не прикрепляются — с понятной причиной, обычные — как раньше.
    У уже прикреплённого раньше опасного файла «Открыть» не запускает его (проверка в main.js, в обход окна тоже),
    а «Показать в папке» работает."""
    s.open('2026-10-21T10:00:00')
    files = make_files(s, [('Протокол.pdf', b'%PDF-1.4'), ('setup.exe', b'MZ'), ('Отчёт.XLSM', b'PK'), ('run.bat', b'@echo'),
                           ('script.js', b'x'), ('ярлык.lnk', b'L'), ('policy.reg', b'R'), ('заметка.txt', b'ok'), ('архив.zip', b'PK')])
    p = s.page
    p.click('#addBtn'); p.fill('#text', 'С опасными')
    pick(s, files); p.click('#attachAdd')
    p.wait_for_function("document.querySelectorAll('#attachList .attach-item').length===3")
    msg = p.inner_text('#attachMsg')
    for bad, ext in (('setup.exe', 'exe'), ('Отчёт.XLSM', 'xlsm'), ('run.bat', 'bat'), ('script.js', 'js'), ('ярлык.lnk', 'lnk'), ('policy.reg', 'reg')):
        assert f'{bad} (файлы .{ext} прикреплять нельзя' in msg, (bad, msg)
    p.click('#form button.add')
    assert sorted(a['name'] for a in s.ev("db.tasks[0].attachments")) == ['Протокол.pdf', 'архив.zip', 'заметка.txt']
    folder = os.path.join(s.user_data, 'data', 'attachments', 'AHTUBA', s.ev("db.tasks[0].id"))
    assert sorted(n.split('__', 1)[1] for n in os.listdir(folder)) == ['Протокол.pdf', 'архив.zip', 'заметка.txt'], os.listdir(folder)
    # у обычного вложения — только «Открыть», как раньше
    assert s.ev("document.querySelectorAll('#tasks .task').length") == 1
    # опасный файл, прикреплённый до 1.7.12
    tid = s.ev("db.tasks[0].id")
    s.stop_main()
    stored = f'AHTUBA/{tid}/abcd1234__старый.exe'
    open(os.path.join(s.user_data, 'data', 'attachments', stored), 'wb').write(b'MZ old')
    extra = json.loads(sql(s, "SELECT extra_json FROM tasks WHERE id=?", tid)[0][0])
    extra['attachments'].append({'id': 'old1', 'name': 'старый.exe', 'size': 6, 'stored': stored, 'addedAt': '2026-10-01T10:00:00.000Z'})
    con = sqlite3.connect(db_file(s)); con.execute("UPDATE tasks SET extra_json=? WHERE id=?", (json.dumps(extra, ensure_ascii=False), tid)); con.commit(); con.close()
    s.open('2026-10-21T10:10:00')
    p = s.page
    p.click('#tasks .task')
    p.wait_for_function("document.querySelectorAll('#attachList .attach-item').length===4")
    item = p.locator('#attachList .attach-item', has_text='старый.exe')
    assert item.locator('[data-attach-open]').count() == 1, 'кнопка «Открыть» пропала'
    assert p.locator('#attachList [data-attach-reveal]').count() == 1, '«Показать в папке» только у опасного'
    opened0 = len(s.state()['opened'])
    item.locator('[data-attach-open]').click()
    p.wait_for_function("(document.getElementById('grass-toast')||{}).textContent?.includes('не открывается')")
    assert len(s.state()['opened']) == opened0, 'опасный файл запущен'
    r = bridge_invoke(s, 'grass-attach-open', stored)                # в обход окна
    assert not r['ok'] and r['blocked'], r
    assert len(s.state()['opened']) == opened0
    item.locator('[data-attach-reveal]').click()
    p.wait_for_timeout(300)
    assert os.path.abspath(s.state()['revealed'][-1]) == os.path.abspath(os.path.join(s.user_data, 'data', 'attachments', stored))
    # обычное по-прежнему открывается
    p.locator('#attachList .attach-item', has_text='Протокол.pdf').locator('[data-attach-open]').click()
    p.wait_for_timeout(300)
    assert s.state()['opened'][-1].endswith('Протокол.pdf'), s.state()['opened']


@test('E')
def e06_admin_only_actions(s):
    """Права админа (список учёток в grass-config.json): восстановление из копии, удаление файлов очищенного архива —
    только администраторам, проверка в main.js (кнопки на месте, в обход окна тоже нельзя). Вторая папка для копий из
    grass-config.json: в Настройках её не поменять и не отключить, копии идут туда. Повреждённая база при запуске:
    восстановить предлагают только администратору."""
    mirror = tempfile.mkdtemp(prefix='grass-cfg-mirror-')
    a, boss = accounts_team(s, ['ivanov', 'boss'], admins=['boss'], extra_cfg={'backupMirrorDir': mirror})
    a.open('2026-10-21T10:00:00')
    bind_as(a, 'Егоров Е.В.')
    a.create_task('Есть в копии')
    made = a.page.evaluate("async()=>await grassAdmin.createBackup()")   # копию делать может каждый
    assert made['ok'], made
    a.create_task('После копии')
    # восстановление из Настроек: кнопка есть, main.js отказывает
    p = a.page
    p.click('nav [data-screen="settings"]')
    p.click('#restoreFromBackupBtn')
    p.wait_for_selector('#restoreDbDlg[open]')
    p.select_option('#restoreDbSelect', made['name'])
    p.click('#restoreDbConfirm')
    assert wait_until(lambda: 'только администратор' in p.inner_text('#updateStatus')), p.inner_text('#updateStatus')
    r = bridge_invoke(a, 'grass-admin-restore-backup', made['name'])
    assert not r['ok'] and r['adminOnly'], r
    assert sorted(x[0] for x in ssql(a, "SELECT text FROM tasks")) == ['Есть в копии', 'После копии']
    r = bridge_invoke(a, 'grass-admin-purge-cleared-attachments')
    assert not r['ok'] and r['adminOnly'] and 'ivanov' in r['error'], r
    # вторая папка из файла настройки
    p.keyboard.press('Escape')
    p.click('#refreshDbInfoBtn')
    assert wait_until(lambda: mirror in p.inner_text('#mirrorDirText') and 'задана администратором' in p.inner_text('#mirrorDirText')), p.inner_text('#mirrorDirText')
    r = bridge_sync(a, 'grass-db-set', 'backupMirrorDir', 'C:\\elsewhere')
    assert not r['ok'] and 'grass-config.json' in r['error'], r
    p.click('#mirrorClear')
    assert wait_until(lambda: 'grass-config.json' in p.inner_text('#mirrorStatus')), p.inner_text('#mirrorStatus')
    p.click('#mirrorNow')
    assert wait_until(lambda: os.path.isdir(os.path.join(mirror, 'GRASS-backup', 'db')) and os.listdir(os.path.join(mirror, 'GRASS-backup', 'db')))
    info = a.page.evaluate("async()=>await grassAdmin.getDatabaseInfo()")
    assert info['mirrorDir'] == os.path.abspath(mirror) and info['mirrorFromConfig'] and not info['admin'], info
    # администратор: удаление файлов и восстановление проходят (когда больше никто не работает)
    a.stop_main()
    boss.open('2026-10-21T10:10:00')
    bind_as(boss, 'Носиков А.Ю.')
    r = bridge_invoke(boss, 'grass-admin-purge-cleared-attachments')
    assert r['ok'], r
    r = bridge_invoke(boss, 'grass-admin-restore-backup', made['name'])
    assert r['ok'], r
    assert [x[0] for x in ssql(boss, "SELECT text FROM tasks")] == ['Есть в копии']
    boss.stop_main()
    # база повреждена: обычному технологу — понятная ошибка без предложения восстановить, администратору — предложение
    with open(shared_db(s), 'r+b') as f:
        f.write(b'\x00' * 100)
    for ext in ('-wal', '-shm'):
        try:
            os.remove(shared_db(s) + ext)
        except OSError:
            pass
    env = dict(a.extra_env)
    x = Stand(s.browser, s.app_dir, tempfile.mkdtemp(prefix='grass-ud-'), extra_env=env)
    s.extras.append(x)
    x.start_main()
    st = x.state()
    x.stop_main()
    assert st['quit'] and st['messageBoxes'] == [] and 'может администратор' in ' '.join(st['errorBoxes']), st
    assert not [n for n in os.listdir(s.shared_data) if n.startswith('grass-broken-')]
    y = Stand(s.browser, s.app_dir, tempfile.mkdtemp(prefix='grass-ud-'), extra_env=dict(boss.extra_env))
    s.extras.append(y)
    y.open('2026-10-21T10:30:00')
    assert any('не удалось открыть' in m for m in y.state()['messageBoxes']), y.state()['messageBoxes']
    assert [n for n in os.listdir(s.shared_data) if n.startswith('grass-broken-')]
    assert y.ev("db.tasks.length") >= 1


def security_state(x):
    with urllib.request.urlopen(f'http://127.0.0.1:{x.port}/__security') as r:
        return json.loads(r.read())


@test('E')
def e07_window_hardening(s):
    """Защита окна: sandbox, CSP (скрипт окна — отдельным файлом, встроенные скрипты и обработчики не выполняются),
    запрет переходов на чужие страницы и новых окон, все запросы разрешений отклоняются. Всё остальное работает —
    это же проверяют все тесты стенда: окно на нём открывается с той же CSP, и её нарушение считается ошибкой.
    «Открыть выгрузку» — только для файла, который программа сама только что сохранила."""
    s.open('2026-10-21T10:00:00')
    sec = security_state(s)
    wp = sec['webPreferences']
    assert wp['sandbox'] is True and wp['contextIsolation'] is True and wp['nodeIntegration'] is False and wp.get('webviewTag') is False, wp
    assert (sec['navigateAway'], sec['navigateSame'], sec['redirectAway'], sec['webview']) == ('запрещено', 'разрешено', 'запрещено', 'запрещено'), sec
    assert sec['windowOpen'] == 'deny' and sec['permission'] == 'запрещено' and sec['permissionCheck'] is False, sec
    html = open(os.path.join(s.app_dir, 'index.html'), encoding='utf-8').read()
    assert re.search(r'<meta http-equiv="Content-Security-Policy" content="[^"]*script-src \'self\';', html)
    assert not re.search(r'<script>', html) and not re.search(r'\son[a-z]+="', html), 'встроенный скрипт или обработчик в index.html'
    for f in ('app.js',):
        assert f in json.load(open(os.path.join(s.app_dir, 'package.json'), encoding='utf-8'))['build']['files']
    # чужой встроенный скрипт и встроенный обработчик окно не выполняет
    got = s.ev("""(()=>{window.__x=0;const sc=document.createElement('script');sc.textContent='window.__x=1';document.body.appendChild(sc);
        const b=document.createElement('button');b.setAttribute('onclick','window.__x=2');document.body.appendChild(b);b.click();b.remove();return window.__x;})()""")
    assert got == 0, got
    s.page.wait_for_timeout(200)
    assert any(e.startswith('CSP:') for e in s.page_errors), s.page_errors
    s.page_errors.clear()                                          # это ожидаемые отказы, а не ошибка программы
    # кнопка «в архив» (раньше — встроенный onclick) работает
    s.create_task('В архив без onclick')
    s.page.click(f'#tasks .task[data-id="{s.task_id("В архив без onclick")}"] .task-delete')
    assert s.page.is_visible('#deleteDlg')
    s.page.click('#deleteConfirm')
    assert s.ev("db.archive.length") == 1 and not s.page.is_visible('#dlg')
    # выгрузка: открыть можно только что сохранённый файл, а любой другой — нет
    r = bridge_invoke(s, 'grass-export-xlsx', 'Сводка', 'UEsDBA==')
    assert r['ok'], r
    opened0 = len(s.state()['opened'])
    assert bridge_invoke(s, 'grass-export-open', r['path']) is True
    other = os.path.join(s.user_data, '__exports', 'чужой.xlsx')
    open(other, 'wb').write(b'PK')
    assert bridge_invoke(s, 'grass-export-open', other) is False
    assert bridge_invoke(s, 'grass-export-open', db_file(s)) is False
    assert bridge_invoke(s, 'grass-export-open', os.path.join(s.app_dir, 'package.json')) is False
    opened = s.state()['opened'][opened0:]
    assert [os.path.abspath(x) for x in opened] == [os.path.abspath(r['path'])], opened


@test('E')
def e08_config_only_from_programdata(s):
    """Файл настройки читается только из C:\\ProgramData\\GRASS-Peredacha-smeny: рядом с exe больше не ищется
    (на 1.7.11 там его можно было подложить и включить общую базу со своими администраторами);
    тестовые переменные (свой файл настройки, своя учётка) установленная программа не слушает — это проверяет
    живая проверка на собранном exe, здесь — что код берёт их только через TEST_ENV."""
    exe_dir = os.path.join(s.user_data, '__exe')
    os.makedirs(exe_dir, exist_ok=True)
    data = tempfile.mkdtemp(prefix='grass-planted-')
    json.dump({'dataDir': data, 'admins': [os.environ.get('USERNAME', 'x')]}, open(os.path.join(exe_dir, 'grass-config.json'), 'w'))
    s.open('2026-10-21T10:00:00')
    assert not s.ev("GRASS_MODE.shared"), 'подложенный рядом с exe файл настройки сработал'
    s.create_task('Дома')
    assert os.path.exists(db_file(s)) and not os.path.exists(os.path.join(data, 'grass.db'))
    src = open(os.path.join(s.app_dir, 'main.js'), encoding='utf-8').read()
    assert "'C:\\\\ProgramData\\\\GRASS-Peredacha-smeny\\\\grass-config.json'" in src
    assert "getPath('exe')" not in src, 'main.js снова ищет настройку рядом с exe'
    # переменные окружения — только через TEST_ENV (у установленной программы он пустой)
    envs = set(re.findall(r'process\.env\.(\w+)', src))
    assert envs <= {'ProgramData', 'USERNAME'}, envs
    assert "const TEST_ENV = !app.isPackaged || app.__grassStand === true ? process.env : {};" in src


@test('E')
def e09_no_autoupdate_on_server(s):
    """На сервере (есть grass-config.json) автообновления нет совсем: ни проверки при запуске, ни событий, ни кнопки.
    Дома установленная программа, как раньше, сама проверяет обновления после запуска."""
    s.extra_env.update(GRASS_TEST_PACKAGED='1', GRASS_UPDATE_DELAY_MS='300')
    s.open('2026-10-21T10:00:00')
    s.page.wait_for_timeout(800)
    home = s.updater()
    assert s.updater(emit='update-available')['emitted'], 'дома обновление должно настраиваться'
    a, = accounts_team(s, ['ivanov'])
    a.extra_env.update(GRASS_TEST_PACKAGED='1', GRASS_UPDATE_DELAY_MS='300')
    a.open('2026-10-21T10:00:00')
    a.page.wait_for_timeout(800)
    assert a.ev("GRASS_MODE.shared")
    up = a.updater(emit='update-available')
    assert not up['emitted'] and up.get('autoDownload') is None and up['checks'] == 0, up
    r = a.page.evaluate("async()=>await grassAdmin.checkForUpdates()")
    assert not r['ok'] and 'администратор' in r['error'], r
    r = a.page.evaluate("async()=>await grassAdmin.installUpdate()")
    assert not r['ok'] and 'администратор' in r['error'], r
    assert home.get('checks', 0) >= 1, home


@test('E')
def e10_fuses_and_ci(s):
    """Предохранители Electron в сборке: нельзя запустить exe как Node.js, нет NODE_OPTIONS и --inspect, проверяется
    целостность app.asar и программа грузится только из него. Сборка на GitHub — npm ci по package-lock.json."""
    pkg = json.load(open(os.path.join(s.app_dir, 'package.json'), encoding='utf-8'))
    assert pkg['build']['electronFuses'] == {'runAsNode': False, 'enableNodeOptionsEnvironmentVariable': False, 'enableNodeCliInspectArguments': False,
                                            'enableEmbeddedAsarIntegrityValidation': True, 'onlyLoadAppFromAsar': True}, pkg['build'].get('electronFuses')
    assert pkg['build'].get('asar', True) is not False
    wf = open(os.path.join(s.app_dir, '.github', 'workflows', 'build-windows.yml'), encoding='utf-8').read()
    assert 'run: npm ci' in wf and 'npm install' not in wf
    html = open(os.path.join(s.app_dir, 'index.html'), encoding='utf-8').read()
    for f in re.findall(r'<script src="([^"]+)"', html):
        assert f'node --check {f}' in wf, f'{f} не проверяется в сборке GitHub'
    lock = json.load(open(os.path.join(s.app_dir, 'package-lock.json'), encoding='utf-8'))
    assert lock['version'] == pkg['version'] and lock['packages']['']['version'] == pkg['version']
    # у каждой версии свой RELEASE-BAT с её номером внутри, старого нет; он проверяет все скрипты окна
    bats = [f for f in os.listdir(s.app_dir) if f.startswith('RELEASE_') and f.endswith('.bat')]
    assert bats == [f"RELEASE_{pkg['version']}_GITHUB.bat"], bats
    bat = open(os.path.join(s.app_dir, bats[0]), encoding='utf-8').read()
    assert f"p.version!=='{pkg['version']}'" in bat and f"git tag -f v{pkg['version']}" in bat
    assert not re.findall(r'1\.\d+\.\d+', bat.replace(pkg['version'], '')), re.findall(r'1\.\d+\.\d+', bat.replace(pkg['version'], ''))
    for f in re.findall(r'<script src="([^"]+)"', html) + ['main.js', 'preload.js']:
        assert f'node --check {f}' in bat, f'{f} не проверяется в {bats[0]}'


def db_snapshot(s):
    """Всё, что видит технолог: задачи, архив, история, журнал, настройки, технологи."""
    return {
        'tasks': sorted(s.ev("db.tasks.map(t=>[t.text,t.status,t.comment,t.deadline,t.author,t.shift,t.assignee||''])")),
        'archive': sorted(s.ev("db.archive.map(t=>[t.text,t.status])")),
        'history': sorted(s.ev("db.history.map(h=>[h.taskId,h.action,h.details,h.author,h.shift,h.at])")),
        'technologists': s.ev("technologists"),
        'settings': sorted(r for r in sql(s, "SELECT key, value FROM settings") if r[0] not in ('daily_backup_date',)),
    }


@test('L')
def l01_prev_version_base_opens_and_rollback(s, prev=None):
    """База прошлой версии (--prev <папка>) открывается новой без потерь; новые поля (подпункты) пишутся;
    откат на прошлую версию открывает ту же базу и не теряет подпункты (их хранит задача)."""
    new_app = s.app_dir
    s.app_dir = prev
    s.open('2026-10-21T10:00:00')
    s.create_task('Старая: в работе', comment='комментарий', deadline='2026-10-25T12:00')
    s.create_task('Старая: передать', status='Передать по смене')
    s.create_task('Старая: в архив')
    s.page.click(f'#tasks .task[data-id="{s.task_id("Старая: в архив")}"] .task-delete'); s.page.click('#deleteConfirm')
    s.page.click('nav [data-screen="journal"]'); s.page.fill('#journalText', 'Остановка линии 2 с 9:10 до 9:40'); s.page.click('#journalAdd')
    s.page.click('nav [data-screen="settings"]'); s.page.fill('#newTechnologist', 'Новиков П.П.'); s.page.click('#addTechnologist')
    before = db_snapshot(s)
    old_ver = s.ev("GRASS_MODE.version||''") or json.load(open(os.path.join(prev, 'package.json'), encoding='utf-8'))['version']
    s.stop_main()
    s.app_dir = new_app                                            # обновились
    s.open('2026-10-21T10:30:00')
    s.run_for('00:00:02')
    assert s.page.is_visible('#whatsNewDlg'), 'после обновления — окно «Что нового»'
    s.page.click('#whatsNewOk')
    after = db_snapshot(s)
    for k in before:
        assert after[k] == before[k], (k, before[k], after[k])
    assert s.ev("db.tasks.length") == 2 and s.ev("db.archive.length") == 1
    open_task_dlg(s, 'Старая: в работе')
    add_subtask(s, 'Подпункт новой версии')
    s.page.click('#cancel')
    s.stop_main()
    # 1.7.12: новая версия только добавила колонку учётки в историю — её записи с учёткой, старые без
    cols = [r[1] for r in sql(s, "PRAGMA table_info(task_history)")]
    has_os = 'os_user' in cols
    if has_os:
        assert sql(s, "SELECT COUNT(*) FROM task_history WHERE os_user<>''")[0][0] >= 1
    n_hist = sql(s, "SELECT COUNT(*) FROM task_history")[0][0]
    s.app_dir = prev                                               # откат на прошлую версию
    s.open('2026-10-21T11:00:00')
    s.ev("(()=>{const d=document.getElementById('whatsNewDlg');if(d&&d.open)d.close();})()")   # у старой версии — её «Что нового»
    assert s.ev("db.tasks.length") == 2
    s.edit_task('Старая: в работе', comment='правка в старой версии')
    s.stop_main()
    assert sql(s, "SELECT COUNT(*) FROM task_history")[0][0] > n_hist, 'старая версия не записала историю в обновлённую базу'
    if has_os:
        assert sql(s, "SELECT COUNT(*) FROM task_history WHERE os_user=''")[0][0] >= 1
    s.app_dir = new_app
    s.open('2026-10-21T11:30:00')
    sub = s.ev("db.tasks.find(t=>t.text==='Старая: в работе').subtasks")
    assert sub and sub[0]['text'] == 'Подпункт новой версии', (old_ver, sub)
    assert s.ev("db.tasks.find(t=>t.text==='Старая: в работе').comment") == 'правка в старой версии'


@test('L')
def l02_shared_bound_base_rollback(s, prev=None):
    """1.7.12: общая база с закреплёнными технологами и учётками в истории открывается прошлой версией (откат):
    она работает как раньше; после возврата на новую закрепления и записи на месте."""
    new_app = s.app_dir
    a, = accounts_team(s, ['ivanov'], admins=['boss'])
    a.open('2026-10-21T10:00:00')
    bind_as(a, 'Егоров Е.В.')
    a.create_task('Новая версия')
    a.stop_main()
    a.app_dir = prev
    a.open('2026-10-21T10:10:00')
    a.ev("(()=>{const d=document.getElementById('whatsNewDlg');if(d&&d.open)d.close();})()")
    assert not a.page.locator('#bindDlg').count()
    a.create_task('Старая версия')
    assert sorted(r[0] for r in ssql(a, "SELECT text FROM tasks")) == ['Новая версия', 'Старая версия']
    a.stop_main()
    a.app_dir = new_app
    a.open('2026-10-21T10:20:00')
    assert not a.page.is_visible('#bindDlg') and a.ev("technologist") == 'Егоров Е.В.'
    assert bindings(a) == {'ivanov': 'Егоров Е.В.'}
    assert sorted(a.ev("db.tasks.map(t=>t.text)")) == ['Новая версия', 'Старая версия']
    assert dict(ssql(a, "SELECT text, os_user FROM task_history WHERE action='Создана задача'")) == {'Новая версия': 'ivanov', 'Старая версия': ''}


def main():
    args = sys.argv[1:]
    base161 = None
    if '--base161' in args:
        i = args.index('--base161'); base161 = args[i + 1]; del args[i:i + 2]
    prev = None                                     # 1.7.11: папка прошлой версии для тестов L
    if '--prev' in args:
        i = args.index('--prev'); prev = os.path.abspath(args[i + 1]); del args[i:i + 2]
    app = os.path.abspath(args[0])
    flt = args[1] if len(args) > 1 else ''
    results = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for kind, fn in TESTS:
            name = fn.__name__
            if flt and flt not in name and flt != kind:
                continue
            if kind == 'U' and not base161:
                continue
            if kind == 'L' and not prev:
                continue
            s = Stand(browser, app, tempfile.mkdtemp(prefix='grass-ud-'))
            t0 = time.time()
            try:
                fn(s, base161=base161) if kind == 'U' else fn(s, prev=prev) if kind == 'L' else fn(s)
                for x in [s] + s.extras:
                    if x.page_errors:
                        raise AssertionError('ошибки JS на странице: ' + '; '.join(x.page_errors[:3]))
                    st = x.state() if x.proc else {'mainErrors': []}
                    bad = [e for e in st['mainErrors'] if 'ExperimentalWarning' not in e]
                    if bad:
                        raise AssertionError('ошибки main.js: ' + '; '.join(bad[:3]))
                results.append((kind, name, True, '', time.time() - t0))
            except Exception as e:
                msg = str(e) or f'{e.__class__.__name__} (строка {traceback.extract_tb(e.__traceback__)[-1].lineno})'
                if not isinstance(e, AssertionError):
                    msg = traceback.format_exc(limit=2).strip().splitlines()[-1]
                results.append((kind, name, False, msg[:900], time.time() - t0))
            finally:
                s.close()
        browser.close()
    for kind, name, ok, msg, dt in results:
        print(f"{'✅' if ok else '❌'} {kind} {name} ({dt:.1f}s){'' if ok else ' — ' + msg}")
    by = {}
    for kind, _, ok, _, _ in results:
        by.setdefault(kind, [0, 0])[0 if ok else 1] += 1
    print('ИТОГ: ' + ', '.join(f'{k}: прошло {v[0]}, упало {v[1]}' for k, v in sorted(by.items())))
    sys.exit(0 if all(r[2] for r in results) else 1)


if __name__ == '__main__':
    main()
