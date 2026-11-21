"""
Замер сохранения на большой базе: 5000 задач и 40 000 событий истории (площадка Ахтуба).

Запуск: python dev-tests/e2e/perf_save.py <папка приложения> [ещё папка для сравнения ...]
Печатает время запуска с такой базой, медиану времени одной правки (изменить комментарий + событие в историю + сохранение)
и сколько байт ушло из окна в main.js за одно сохранение.
С 1.7.4 ещё время отрисовки экранов История и Архив (1500 задач в архиве) и поиска по главному списку.
"""
import os
import statistics
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from stand import Stand  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

TASKS, EVENTS, EDITS = 5000, 40000, 15

FILL = """([nt,ne])=>{
  const base=Date.parse('2026-01-01T06:00:00Z');
  db.tasks=[];db.history=[];
  for(let i=0;i<nt;i++){
    const at=new Date(base+i*60000).toISOString();
    db.tasks.push({id:'perf-'+i,text:'Задача номер '+i+' про насос и реактор',status:i%3?'В работе':'Выполнена',priority:'Обычный',
      comment:'комментарий '+i,deadline:'',deadlineStoppedAt:'',author:'Носиков А.Ю.',shift:'A',date:at,toShift:null,fromShift:null,
      holderShift:'A',lastActionBy:'Носиков А.Ю.',lastActionShift:'A',lastActionAt:at,lastActionAtIso:at,createdAt:at,assignee:'',attachments:[]});
  }
  for(let j=0;j<ne;j++){
    const at=new Date(base+j*1000).toISOString();
    db.history.unshift({id:'ev-'+j,taskId:'perf-'+(j%nt),text:'Задача номер '+(j%nt),action:'Изменена задача',details:'Изменено описание или комментарий',
      when:at,at,author:'Носиков А.Ю.',shift:'A',deadline:'',status:'В работе',comment:'',v:17});
  }
  lastEventMs=Date.parse(db.history[0].at);
  for(let i=0;i<1500;i++){const t=db.tasks.pop();t.archivedAt=t.lastActionAt;t.archivedBy='Носиков А.Ю.';t.archivedShift='A';t.archivedFromStatus=t.status;db.archive.push(t);}
  save();
}"""

MEASURE = """(i)=>{
  let bytes=0;
  const wrap=(name)=>{const f=grassStorage[name];if(!f)return null;grassStorage[name]=(k,v)=>{bytes+=String(v).length;return f.call(grassStorage,k,v)};return f;};
  const o1=wrap('setItem'),o2=wrap('patch');
  const t=db.tasks[(i*37)%db.tasks.length];
  const t0=performance.now();
  t.comment='правка '+i;
  logEvent(t,'Изменена задача','Изменено описание или комментарий');
  const ms=performance.now()-t0;
  if(o1)grassStorage.setItem=o1; if(o2)grassStorage.patch=o2;
  return {ms,bytes};
}"""


SCREENS = """()=>{
  const t=(f)=>{const t0=performance.now();f();return performance.now()-t0;};
  const history=t(()=>renderHistory()), archive=t(()=>renderArchive());
  const search=t(()=>{$('search').value='подшипник';render();});
  $('search').value='';render();
  return {history,archive,search};
}"""


def measure(browser, app):
    s = Stand(browser, app, tempfile.mkdtemp(prefix='grass-perf-'))
    try:
        s.open('2026-10-21T10:00:00')
        s.ctx.set_default_timeout(600000)
        s.page.evaluate(FILL, [TASKS, EVENTS])
        t0 = time.time()
        s.open('2026-10-21T10:05:00')
        load = time.time() - t0
        assert s.ev("db.tasks.length") + s.ev("db.archive.length") == TASKS and s.ev("db.history.length") == EVENTS
        s.page.evaluate(SCREENS)                       # прогрев
        scr = s.page.evaluate(SCREENS)
        s.page.evaluate(MEASURE, 0)                    # прогрев
        runs = [s.page.evaluate(MEASURE, i + 1) for i in range(EDITS)]
        s.open('2026-10-21T10:10:00')
        assert s.ev("db.history.length") == EVENTS + EDITS + 1, 'не все правки дошли до базы'
        return load, statistics.median(r['ms'] for r in runs), statistics.median(r['bytes'] for r in runs), scr
    finally:
        s.close()


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for app in sys.argv[1:]:
            load, ms, b, scr = measure(browser, os.path.abspath(app))
            print(f'{os.path.basename(os.path.abspath(app))}: запуск {load:.1f} с, правка ~{ms:.0f} мс, в main.js ушло ~{b/1024:.0f} КБ, '
                  f'История {scr["history"]:.0f} мс, Архив {scr["archive"]:.0f} мс, поиск {scr["search"]:.0f} мс', flush=True)
        browser.close()


if __name__ == '__main__':
    main()
