// GRASS — Передача смены · выгрузка сводки смены и статистики в Excel и PDF (1.7.6, п. 27 плана; 1.7.7 — периоды и бригада).
// Таблицы собираются здесь из тех же данных, что на экране; файл пишет export.js, сохраняет main.js.
(function(){
'use strict';
const E=GrassExport;
const api=window.grassExport;
const siteName=()=>SITE_LABELS[currentSite()]||'';
const fmtDate=d=>d.toLocaleDateString('ru-RU',{day:'2-digit',month:'2-digit',year:'numeric'});
const fmtTime=d=>d?d.toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'}):'';
const stamp=()=>{const d=new Date(),p=n=>String(n).padStart(2,'0');return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}`;};

function toBase64(bytes){
  let s='';for(let i=0;i<bytes.length;i+=0x8000)s+=String.fromCharCode.apply(null,bytes.subarray(i,i+0x8000));
  return btoa(s);
}

// ---------- сводка смены ----------
function summaryExport(){
  const data=shiftSummaryData(),info=data.info;
  const title='Сводка смены';
  const subtitle=`${info?formatSummaryShift(info):'Нет данных о предыдущей смене'} · ${siteName()} · выгружено ${new Date().toLocaleString('ru-RU')}`;
  const journal=info?GrassJournal.inWindow(GrassJournal.fold(taskHistoryNewestFirst(GrassJournal.TASK_ID)),info).filter(e=>!e.deleted).reverse():[];
  const tables=[
    {name:'Итоги',rows:[['Показатель','Значение'],['Смена',info?formatSummaryShift(info):'—'],['Площадка',siteName()],
      ['Выполнено',data.stats.done],['Передано',data.stats.pass],['В работе',data.stats.work],['Не в работе',data.stats.off],['Просрочено',data.stats.overdue]]},
    {name:'Задачи смены',rows:[['Задача','Статус в ту смену','Сейчас','Что было','Технолог','Последнее действие','Исполнитель','Просрочена'],
      ...data.rows.map(r=>[r.text||'',r.statusThen||'',r.nowStatus||'',r.action||'',r.author||'',r.lastBy||'',r.assignee||'',r.overdue?'да':''])]},
    {name:'Комментарии',rows:[['Задача','Комментарий'],...data.notes.map(n=>[n.task,n.comment])]},
    {name:'Журнал смены',rows:[['Время','Запись','Технолог','Записано'],...journal.map(e=>[GrassJournal.range(e)||fmtTime(e.at),e.text,e.author,e.at?e.at.toLocaleString('ru-RU'):''])]}
  ];
  const fname=E.fileName(`Сводка смены ${info?info.shift+' '+fmtDate(info.start):''} ${siteName()}`);
  return {title,subtitle,tables,fname};
}

// ---------- статистика (период, бригада и технолог — как на экране) ----------
function statsExport(){
  const r=statsRange(),opts=statsOpts(),start=r.start,n=r.end;
  const rows=statsTech?techActivity(start,n,opts).rowsOf(statsTech):statsDataRange(start,n,opts);
  const q=qualityData(start,n,statsTechMatch(),opts&&opts.when,statsBrigadeMatch());
  const nf=v=>v==null?'':v;
  const techRows=sortTechTable(techTable(start,n,opts));
  const tables=[
    {name:'По дням',rows:[['Дата','Создано','Выполнено','Просрочено'],...rows.map(r=>[fmtDate(new Date(r.date)),r.created,r.completed,r.overdue])]},
    {name:'Скорость и сроки',rows:[['Показатель','Значение'],
      ['Выполнено за период',q.completed],['Среднее время до выполнения, ч',nf(q.avgHours)],['Медиана, ч',nf(q.medianHours)],
      ['Сколько смен прошла задача (в среднем)',nf(q.avgShifts)],['Дольше всех',q.maxShifts?`${q.maxShifts.text} — ${q.maxShifts.count}`:''],
      ['Выполнено в срок, %',nf(q.onTimePct)],['Выполнено в срок',q.withDeadline?`${q.onTime} из ${q.withDeadline}`:''],
      ['Открыто сейчас',q.open],['Просрочено сейчас',q.overdueNow]]},
    {name:'По приоритетам',rows:[['Приоритет','Создано','Выполнено','Среднее время, ч','Смен в среднем','В срок, %','Открыто','Просрочено сейчас'],
      ...q.byPriority.map(r=>[r.priority,r.created,r.completed,nf(r.avgHours),nf(r.avgShifts),nf(r.onTimePct),r.open,r.overdueNow])]},
    {name:'По технологам',rows:[TECH_STAT_COLS.map(c=>c[1]),...techRows.map(r=>TECH_STAT_COLS.map(([k])=>r[k])),
      TECH_STAT_COLS.map(([k])=>GrassStats.techTotals(techRows)[k])]}
  ];
  const title='Статистика';
  const subtitle=`${siteName()} · ${r.caption} (${fmtDate(start)} — ${fmtDate(n)})${statsBrigade?' · бригада '+statsBrigade:''}${statsTech?' · технолог '+statsTech:''} · выгружено ${new Date().toLocaleString('ru-RU')}`;
  return {title,subtitle,tables,fname:E.fileName(`Статистика ${siteName()} ${stamp()}`)};
}

async function run(kind,build){
  if(!api){toast('Выгрузка работает только в программе');return;}
  let r;
  try{
    const x=build();
    r=kind==='xlsx'?await api.xlsx(x.fname,toBase64(E.xlsx(x.tables))):await api.pdf(x.fname,E.printHtml(x.title,x.subtitle,x.tables));
  }catch(e){r={ok:false,error:String(e&&e.message||e)};}
  if(r&&r.ok){toast(`Сохранено: ${r.path}`);lastExport=r.path;}
  else if(r&&!r.canceled)toast(`Не удалось сохранить: ${r?.error||'ошибка'}`);
}
let lastExport='';
$('summaryXlsx')?.addEventListener('click',()=>run('xlsx',summaryExport));
$('summaryPdf')?.addEventListener('click',()=>run('pdf',summaryExport));
$('statsXlsx')?.addEventListener('click',()=>run('xlsx',statsExport));
$('statsPdf')?.addEventListener('click',()=>run('pdf',statsExport));
window.GrassExportUi={summaryExport,statsExport,last:()=>lastExport};
})();
