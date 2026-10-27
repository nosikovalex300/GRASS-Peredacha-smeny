// GRASS — Передача смены · журнал смены в окне программы (1.7.6, п. 25 плана).
// Записи — события истории площадки (taskId '__journal__'), свёртку и правила считает journal.js.
// Технолог, смена и площадка подставляются сами; своё можно править и удалять только в свою смену.
(function(){
'use strict';
const J=GrassJournal;
let editId=null;
let limit=PAGE_SIZE;
let cache=null;

function entries(){
  const list=taskHistoryNewestFirst(J.TASK_ID);
  const sig=list.length+'|'+(list[0]?.id||'');
  if(!cache||cache.list!==list||cache.sig!==sig)cache={list,sig,entries:J.fold(list)};
  return cache.entries;
}
const curWindow=()=>GrassShifts.windowAt(new Date());
const fmtDay=d=>d?d.toLocaleDateString('ru-RU',{day:'2-digit',month:'2-digit'}):'';
const fmtTime=d=>d?d.toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'}):'';
const fmtAt=d=>d?`${fmtDay(d)} ${fmtTime(d)}`:'';
function shiftHead(e){
  const w=GrassShifts.windowAt(e.at||new Date());
  return `Смена ${e.shift||w.shift||'—'} · ${w.mode||''} · ${fmtDay(w.start)}`;
}

function addEvent(action,extra){
  const nowD=new Date(),at=eventIso(nowD);
  db.history.unshift({id:crypto.randomUUID(),taskId:J.TASK_ID,action,when:at,at,author:technologist,shift,
    deadline:'',status:'',comment:'',v:17,...extra});
  save();
}

function readForm(){return {text:J.cleanText($('journalText').value),from:$('journalFrom').value,to:$('journalTo').value};}
function resetForm(){
  editId=null;
  $('journalText').value='';$('journalFrom').value='';$('journalTo').value='';
  $('journalAdd').textContent='Записать';$('journalCancelEdit').hidden=true;
  $('journalProblem').textContent='';
}
function submit(){
  if(readOnly){toast('Программа открыта только для чтения');return;}
  if(!technologist){$('journalProblem').textContent='Сначала выберите технолога.';return;}
  const f=readForm(),problem=J.checkEntry(f.text,f.from,f.to);
  if(problem){$('journalProblem').textContent=problem;return;}
  if(SHARED_MODE){try{pullRemoteChanges();}catch(_){}}
  if(editId){
    const e=entries().find(x=>x.id===editId);
    if(!J.canEdit(e,technologist,curWindow())){$('journalProblem').textContent='Эту запись уже нельзя изменить: править можно только свою запись и только в свою смену.';return;}
    if(e.text!==f.text||e.from!==f.from||e.to!==f.to)
      addEvent(J.EDIT,{entryId:e.id,text:f.text,from:f.from,to:f.to,details:`Было: ${e.text}`});
  }else{
    addEvent(J.ADD,{entryId:crypto.randomUUID(),text:f.text,from:f.from,to:f.to,shiftStart:curWindow().start.toISOString(),
      details:J.range(f)?`${J.range(f)} · ${f.text}`:f.text});
  }
  resetForm();renderJournal();
}

function entryHtml(e,cw){
  const mine=J.canEdit(e,technologist,cw);
  const r=J.range(e);
  const edits=e.edits.length?`<details class="journal-edits"><summary>изменено ${e.edits.length} ${plural(e.edits.length,'раз','раза','раз')}, последний раз ${esc(fmtAt(e.edits[e.edits.length-1].at))}</summary>${
    e.edits.slice().reverse().map(x=>`<div>Было (до ${esc(fmtTime(x.at))}): ${x.from||x.to?esc(J.range(x))+' · ':''}${esc(x.text)}</div>`).join('')}</details>`:'';
  const del=e.deleted?`<div class="journal-deleted-note">Удалено: ${esc(e.deleted.author)}, ${esc(fmtAt(e.deleted.at))}</div>`:'';
  return `<article class="journal-entry${e.deleted?' deleted':''}" data-journal-id="${esc(e.id)}">
    <div class="journal-time">${r?esc(r):esc(fmtTime(e.at))}</div>
    <div class="journal-body"><div class="journal-text">${esc(e.text)}</div>
      <div class="journal-meta">${esc(e.author)} · смена ${esc(e.shift)} · записано ${esc(fmtAt(e.at))}</div>${edits}${del}</div>
    <div class="journal-actions">${mine?`<button type="button" class="backup-btn" data-journal-edit="${esc(e.id)}">Изменить</button><button type="button" class="archive-clear-btn" data-journal-del="${esc(e.id)}">Удалить</button>`:''}</div>
  </article>`;
}
function renderJournal(){
  const box=$('journalList');if(!box)return;
  const q=($('journalSearch')?.value||'').trim();
  const all=entries().filter(e=>J.matches(e,q));
  const shown=all.slice(0,limit),cw=curWindow();
  let html='',head='';
  for(const e of shown){
    const h=shiftHead(e);
    if(h!==head){html+=`<div class="journal-shift-head">${esc(h)}</div>`;head=h;}
    html+=entryHtml(e,cw);
  }
  box.innerHTML=all.length?html+(all.length>shown.length?`<div class="list-more"><button type="button" class="list-more-btn" id="journalMore">Ещё ${Math.min(PAGE_SIZE,all.length-shown.length)} из ${all.length-shown.length}</button></div>`:'')
    :`<div class="empty">${q?'В журнале ничего не найдено.':'Записей пока нет. Пишите сюда всё, что важно по смене: остановки, ремонты, приход сырья, замечания.'}</div>`;
  const ro=readOnly||!technologist;
  ['journalText','journalFrom','journalTo','journalAdd'].forEach(id=>{if($(id))$(id).disabled=ro;});
  const lbl=$('journalWho');if(lbl)lbl.textContent=technologist?`${technologist} · смена ${shift} · ${currentSiteName()}`:'Выберите технолога';
}
function currentSiteName(){try{return SITE_LABELS[currentSite()]||'';}catch(_){return '';}}

$('journalAdd')?.addEventListener('click',submit);
$('journalText')?.addEventListener('keydown',e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();submit();}});
$('journalCancelEdit')?.addEventListener('click',resetForm);
$('journalSearch')?.addEventListener('input',()=>{limit=PAGE_SIZE;renderJournal();});
$('journalList')?.addEventListener('click',async ev=>{
  const b=ev.target.closest('button');if(!b)return;
  if(b.id==='journalMore'){limit+=PAGE_SIZE;renderJournal();return;}
  const e=entries().find(x=>x.id===(b.dataset.journalEdit||b.dataset.journalDel));
  if(!e)return;
  if(!J.canEdit(e,technologist,curWindow())){toast('Править можно только свою запись и только в свою смену');renderJournal();return;}
  if(b.dataset.journalEdit){
    editId=e.id;$('journalText').value=e.text;$('journalFrom').value=e.from;$('journalTo').value=e.to;
    $('journalAdd').textContent='Сохранить правку';$('journalCancelEdit').hidden=false;$('journalText').focus();
    return;
  }
  if(!await askDialog({title:'Удалить запись журнала?',text:'Запись останется в журнале зачёркнутой с пометкой, кто и когда её удалил.',ok:'Удалить',danger:true}))return;
  addEvent(J.DEL,{entryId:e.id,text:e.text,details:`Удалена запись: ${e.text}`});
  if(editId===e.id)resetForm();
  renderJournal();
});
document.querySelector('nav [data-screen="journal"]')?.addEventListener('click',()=>{limit=PAGE_SIZE;renderJournal();});

// Поиск на экране задач: если что-то нашлось в журнале — строка со ссылкой на журнал.
function renderSearchHint(){
  const el=$('journalHint');if(!el)return;
  const q=($('search')?.value||'').trim();
  const n=q?entries().filter(e=>!e.deleted&&J.matches(e,q)).length:0;
  el.hidden=!n;
  if(n)el.innerHTML=`В журнале смены найдено записей: <b>${n}</b> <button type="button" id="journalHintOpen" class="link-btn">Открыть журнал</button>`;
}
document.addEventListener('click',e=>{
  if(!e.target.closest('#journalHintOpen'))return;
  $('journalSearch').value=$('search').value.trim();
  document.querySelector('nav [data-screen="journal"]')?.click();
});
renderHooks.push(()=>{renderSearchHint();if($('screen-journal')?.classList.contains('active'))renderJournal();});

// Сводка смены: записи журнала той смены.
function summaryEntries(info){return J.inWindow(entries(),info).filter(e=>!e.deleted);}
summaryHooks.push(info=>{
  const box=$('shiftSummaryJournalBox'),list=$('shiftSummaryJournal');if(!box||!list)return;
  const rows=summaryEntries(info).slice().reverse();
  box.hidden=!rows.length;
  $('shiftSummaryJournalCount').textContent=rows.length?String(rows.length):'';
  list.innerHTML=rows.map(e=>`<div class="journal-summary-row"><span class="journal-time">${esc(J.range(e)||fmtTime(e.at))}</span><span>${esc(e.text)}</span><em>${esc(e.author)}</em></div>`).join('');
});

renderJournal();
if($('shiftSummaryDlg')?.open)renderShiftSummary();   // сводка открылась сама при запуске — дорисовываем журнал
window.GrassJournalUi={render:renderJournal,entries,summaryCount:info=>summaryEntries(info).length};
})();
