// GRASS — Передача смены · график смен в Настройках (1.7.6, п. 29 плана).
// График общий для обеих площадок (общая настройка shiftSchedule). Правила смен — shifts.js (GrassShifts.configure).
// Перед сохранением видно, какая смена получится сегодня и завтра; каждая правка пишется в журнал графика
// (виден на обеих площадках) и событием в историю площадки, где её сделали.
(function(){
'use strict';
const S=GrassShifts;
const SCHEDULE_TASK_ID='__schedule__';

function stored(){try{const v=JSON.parse(grassStorage.getItem('shiftSchedule')||'null');return v&&typeof v==='object'?v:null;}catch(_){return null;}}
const fmtDay=d=>d.toLocaleDateString('ru-RU',{day:'2-digit',month:'2-digit'});
const fmtAt=iso=>{const d=new Date(iso);return isNaN(d)?'':d.toLocaleString('ru-RU',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});};
const describe=c=>`начало дня ${c.dayStart}, порядок ${c.order.join(' → ')}, отсчёт с ${c.anchor.split('-').reverse().join('.')}`;

function readForm(){
  return {dayStart:$('schedDayStart').value,order:[0,1,2,3].map(i=>$('schedOrder'+i).value),anchor:$('schedAnchor').value};
}
function fillForm(c){
  $('schedDayStart').value=c.dayStart;
  c.order.forEach((l,i)=>{$('schedOrder'+i).value=l;});
  $('schedAnchor').value=c.anchor;
  renderPreview();
}
function previewText(c){
  return S.preview(c,new Date()).map((x,i)=>`${i?'Завтра':'Сегодня'} ${fmtDay(x.date)}: день — смена ${x.day} (${x.dayTimes.join('–')}), ночь — смена ${x.night} (${x.nightTimes.join('–')})`).join('\n');
}
function renderPreview(){
  const c=readForm(),problem=S.validate(c),el=$('schedPreview');
  const m=/^(\d{2}):(\d{2})$/.exec(c.dayStart||'');
  $('schedNight').textContent=m?`ночь с ${String((Number(m[1])+12)%24).padStart(2,'0')}:${m[2]}`:'';
  el.classList.toggle('bad',!!problem);
  el.textContent=problem||previewText(c);
  const same=!problem&&S.sameSchedule(c,S.current());
  $('schedSave').disabled=!!problem||same||readOnly;
}
function renderLog(){
  const box=$('schedLog');if(!box)return;
  const log=(stored()?.log||[]).slice().reverse();
  box.innerHTML=log.length?`<div class="sched-log-head">Изменения графика</div>`+log.slice(0,10).map(x=>`<div class="sched-log-row"><b>${esc(fmtAt(x.at))}</b> · ${esc(x.author||'')}${x.site?` (${esc(SITE_LABELS[x.site]||x.site)})`:''}<br><span>${esc(describe(x.from))} → ${esc(describe(x.to))}</span></div>`).join(''):'';
}
function renderCard(){fillForm(S.current());renderLog();}

async function saveSchedule(){
  if(readOnly)return;
  const c=readForm(),problem=S.validate(c);
  if(problem){renderPreview();return;}
  const before=S.current();
  if(S.sameSchedule(c,before))return;
  if(!await askDialog({title:'Сохранить график смен?',text:`${previewText(c)}\n\nГрафик общий для Ахтубы и Волжского. Смена в программе переключится по новому графику у всех.`,ok:'Сохранить'}))return;
  const prev=stored();
  const log=[...((prev&&Array.isArray(prev.log))?prev.log:[]),{at:new Date().toISOString(),author:technologist,site:currentSite(),from:before,to:c}].slice(-50);
  grassStorage.setItem('shiftSchedule',JSON.stringify({...c,log}));
  apply();
  const at=eventIso(new Date());
  db.history.unshift({id:crypto.randomUUID(),taskId:SCHEDULE_TASK_ID,text:'График смен',action:'Изменён график смен',
    details:`${describe(before)} → ${describe(c)}`,when:at,at,author:technologist,shift,deadline:'',status:'',comment:'',v:17,
    scheduleFrom:before,scheduleTo:c});
  save();
  toast('График смен сохранён');
}
// Поставить график из настроек и переключить смену, если по новому графику сейчас работает другая.
function apply(){
  const before=S.current();
  const now=S.configure(stored());
  renderCard();
  if(S.sameSchedule(before,now))return;
  const a=activeShiftAt(new Date());
  if(a){autoShiftSeen=a;setCurrentShift(a);}
  renderShiftInfo();render();
}

$('schedForm')?.addEventListener('input',renderPreview);
$('schedForm')?.addEventListener('change',renderPreview);
$('schedSave')?.addEventListener('click',saveSchedule);
$('schedDefault')?.addEventListener('click',()=>fillForm(S.DEFAULT_SCHEDULE));
document.querySelector('nav [data-screen="settings"]')?.addEventListener('click',renderCard);
settingsReloadHooks.push(apply);
renderCard();
window.GrassScheduleUi={apply,render:renderCard};
})();
