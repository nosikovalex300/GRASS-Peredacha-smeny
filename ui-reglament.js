// GRASS — Передача смены · регламент в окне программы (1.7.6, п. 24 плана).
// Шаблоны лежат в общих настройках площадки (regTemplates). Расписание считает reglament.js.
// Задачи по расписанию создаёт любая открытая копия программы; id задачи = метка повтора,
// поэтому вторую такую же задачу база не примет (конфликт тихо решается в пользу уже созданной).
(function(){
'use strict';
const R=GrassReglament;
let templates=[];
let regEditId=null;
const handled=new Set();   // повторы, которые эта копия программы уже разобрала

function loadTemplates(){
  let list=[];
  try{list=JSON.parse(grassStorage.getItem('regTemplates')||'[]');}catch(_){}
  templates=(Array.isArray(list)?list:[]).map(R.normalize).filter(t=>t.id);
}
function saveTemplates(){grassStorage.setItem('regTemplates',JSON.stringify(templates));}
function newId(){return Math.random().toString(36).slice(2,10).replace(/[^a-z0-9]/g,'').padEnd(8,'0');}
const pad=n=>String(n).padStart(2,'0');
const localInput=d=>`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const fmtAt=d=>d.toLocaleString('ru-RU',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});
const tplById=id=>templates.find(t=>t.id===id);

// ---------- создание задач по расписанию ----------
function regTick(){
  if(readOnly||!templates.length)return;
  const nowD=new Date();
  const todo=[];
  for(const tpl of templates){
    const o=R.dueOccurrence(tpl,nowD,GrassShifts);
    if(o&&!handled.has(o.taskId))todo.push({tpl,o});
  }
  if(!todo.length)return;
  if(SHARED_MODE){try{pullRemoteChanges();}catch(_){}}   // вдруг другая копия программы уже создала
  let changed=false;
  const gone=new Set([...(db.statsArchive||[]).map(t=>String(t.id)),...(db.clearedArchiveIds||[]).map(String)]);
  for(const {tpl,o} of todo){
    handled.add(o.taskId);
    if(findTaskAny(o.taskId)||gone.has(o.taskId))continue;
    const iso=nowD.toISOString(),at=eventIso(nowD);
    const prev=db.tasks.find(t=>t.regId===tpl.id&&t.status!=='Выполнена');
    if(prev){
      // Прошлый повтор не выполнен — второй не создаём, отмечаем у прошлого.
      if((prev.regMissed||[]).includes(o.key))continue;
      prev.regMissed=[...(prev.regMissed||[]),o.key].slice(-20);
      db.history.unshift({id:crypto.randomUUID(),taskId:prev.id,text:prev.text,action:'Пропущен повтор регламента',
        details:`Повтор ${fmtAt(o.at)} (смена ${o.window.shift}) не создан: прошлая задача ещё не выполнена`,when:at,at,
        author:R.AUTHOR,shift:o.window.shift,deadline:prev.deadline||'',status:prev.status||'',comment:prev.comment||'',v:17,regId:tpl.id});
      changed=true;continue;
    }
    const task={id:o.taskId,text:tpl.title,status:'В работе',priority:tpl.priority,comment:tpl.comment,
      deadline:o.deadline?localInput(o.deadline):'',deadlineStoppedAt:'',author:R.AUTHOR,shift:o.window.shift,date:iso,
      toShift:null,fromShift:null,holderShift:o.window.shift,lastActionBy:R.AUTHOR,lastActionShift:o.window.shift,
      lastActionAt:iso,lastActionAtIso:iso,createdAt:iso,assignee:tpl.assignee||'',attachments:[],regId:tpl.id,regKey:o.key};
    db.tasks.unshift(task);
    db.history.unshift({id:crypto.randomUUID(),taskId:task.id,text:task.text,action:'Создана задача',
      details:`Создана по регламенту (${R.describe(tpl)}), смена ${task.shift}${task.assignee?`, исполнитель ${task.assignee}`:''}`,
      when:at,at,author:R.AUTHOR,shift:task.shift,deadline:task.deadline,status:task.status,comment:task.comment,v:17,regId:tpl.id,
      ...(task.assignee?{assignee:task.assignee}:{})});
    changed=true;
  }
  if(!changed)return;
  conflictQuiet=true;
  try{save();}finally{conflictQuiet=false;}
  render();renderHistory();renderStats();
}

// ---------- настройки: список шаблонов ----------
function renderRegList(){
  const box=$('regList');if(!box)return;
  if(!templates.length){box.innerHTML='<div class="reg-empty">Шаблонов пока нет. Например: «Отбор проб на линии 2» каждую дневную смену.</div>';return;}
  const nowD=new Date();
  box.innerHTML=templates.map(t=>{
    const next=R.upcoming(t,nowD,GrassShifts,1)[0];
    return `<div class="settings-row reg-row${t.paused?' paused':''}" data-reg-row="${t.id}"><div><b>${esc(t.title)}</b><span>${esc(R.describe(t))}${t.paused?' · на паузе':''}${!t.paused&&next?` · следующая: ${esc(fmtAt(next.at))}, смена ${esc(next.shift)}`:''}</span></div>
      <div class="reg-actions"><button type="button" class="backup-btn" data-reg-edit="${t.id}">Изменить</button>${t.rule.kind!=='none'?`<button type="button" class="backup-btn" data-reg-pause="${t.id}">${t.paused?'Включить':'Пауза'}</button>`:''}<button type="button" class="archive-clear-btn" data-reg-del="${t.id}">Удалить</button></div></div>`;
  }).join('');
}
$('regList')?.addEventListener('click',async e=>{
  const b=e.target.closest('button');if(!b)return;
  if(b.dataset.regEdit){openRegDlg(b.dataset.regEdit);return;}
  if(b.dataset.regPause){reloadTemplatesFresh();const t=tplById(b.dataset.regPause);if(!t)return;t.paused=!t.paused;saveTemplates();renderRegList();if(!t.paused)regTick();return;}
  if(b.dataset.regDel){
    const t=tplById(b.dataset.regDel);if(!t)return;
    if(!await askDialog({title:`Удалить шаблон «${t.title}»?`,text:'Новые задачи по нему больше не создадутся. Уже созданные задачи останутся.',ok:'Удалить',danger:true}))return;
    reloadTemplatesFresh();templates=templates.filter(x=>x.id!==t.id);saveTemplates();renderRegList();fillFromTemplate();
  }
});
// Перед правкой берём список из базы: его мог поменять технолог на другом ПК.
function reloadTemplatesFresh(){loadTemplates();}

// ---------- окно шаблона ----------
function fillRegAssignee(cur){
  const sel=$('regAssignee');sel.replaceChildren();
  const add=(v,l)=>{const o=document.createElement('option');o.value=v;o.textContent=l;sel.appendChild(o);};
  add('','Не назначен');
  technologists.forEach(n=>add(n,n));
  if(cur&&!technologists.includes(cur))add(cur,cur);
  sel.value=cur||'';
}
function syncRegFields(){
  const kind=$('regKind').value;
  document.querySelectorAll('#regDlg [data-reg-for]').forEach(el=>{el.hidden=!el.dataset.regFor.split(' ').includes(kind);});
  renderRegPreview();
}
function readRegForm(){
  const md=String($('regMonthDays').value||'').toLowerCase().split(/[,;\s]+/).filter(Boolean).map(x=>x.startsWith('посл')?R.LAST_DAY:Number(x));
  return R.normalize({
    id:regEditId||newId(),title:$('regTitle').value,comment:$('regComment').value,priority:$('regPriority').value,
    assignee:$('regAssignee').value,deadlineHours:$('regDeadline').value,paused:regEditId?!!tplById(regEditId)?.paused:false,
    rule:{kind:$('regKind').value,n:$('regN').value,mode:$('regMode').value,anchor:$('regAnchor').value,
      brigades:[...document.querySelectorAll('[data-reg-brigade]:checked')].map(x=>x.dataset.regBrigade),
      days:[...document.querySelectorAll('[data-reg-day]:checked')].map(x=>Number(x.dataset.regDay)),monthDays:md}
  });
}
function regProblem(t){
  if(!t.title)return 'Напишите, какую задачу создавать.';
  const r=t.rule;
  if((r.kind==='weekdays'||r.kind==='everyNWeeks')&&!r.days.length)return 'Отметьте хотя бы один день недели.';
  if(r.kind==='monthDays'&&!r.monthDays.length)return 'Укажите числа месяца, например: 1, 15, последнее.';
  if((r.kind==='nthShift'||r.kind==='everyNDays'||r.kind==='everyNWeeks')&&!r.anchor)return 'Укажите дату отсчёта.';
  if(r.kind==='hours'&&r.n>12)return 'Смена длится 12 часов — N не больше 12.';
  return '';
}
function renderRegPreview(){
  const t=readRegForm(),el=$('regPreview');if(!el)return;
  const problem=regProblem(t);
  if(problem){el.textContent=problem;el.classList.add('bad');return;}
  el.classList.remove('bad');
  if(t.rule.kind==='none'){el.textContent='Сама не создаётся — выбирается кнопкой «Из шаблона» в окне задачи.';return;}
  const next=R.upcoming(t,new Date(),GrassShifts,3);
  el.textContent=`${R.describe(t)}. Ближайшие: ${next.length?next.map(x=>`${fmtAt(x.at)} (смена ${x.shift})`).join(', '):'в ближайший год не попадает ни одна смена'}.`;
}
function openRegDlg(id=null){
  reloadTemplatesFresh();
  regEditId=id&&tplById(id)?id:null;
  const t=regEditId?tplById(regEditId):R.normalize({rule:{kind:'shift'}});
  $('regDlgTitle').textContent=regEditId?'Изменить шаблон':'Новый шаблон';
  $('regTitle').value=t.title;$('regComment').value=t.comment;$('regPriority').value=t.priority;
  fillRegAssignee(t.assignee);$('regDeadline').value=String(t.deadlineHours);
  $('regKind').value=t.rule.kind;$('regN').value=String(t.rule.n);$('regMode').value=t.rule.mode;
  $('regAnchor').value=t.rule.anchor||R.dayStr(new Date());
  document.querySelectorAll('[data-reg-brigade]').forEach(x=>{x.checked=t.rule.brigades.includes(x.dataset.regBrigade);});
  document.querySelectorAll('[data-reg-day]').forEach(x=>{x.checked=t.rule.days.includes(Number(x.dataset.regDay));});
  $('regMonthDays').value=t.rule.monthDays.map(d=>d===R.LAST_DAY?'последнее':String(d)).join(', ');
  syncRegFields();
  $('regDlg').showModal();
}
$('regAdd')?.addEventListener('click',()=>openRegDlg());
$('regKind')?.addEventListener('change',()=>{
  // для «по дням» по умолчанию — дневная смена, для «каждую смену» — любые
  const k=$('regKind').value;
  if(['weekdays','everyNDays','everyNWeeks','monthDays'].includes(k)&&$('regMode').value==='any')$('regMode').value='day';
  syncRegFields();
});
$('regForm')?.addEventListener('input',renderRegPreview);
$('regForm')?.addEventListener('change',renderRegPreview);
$('regClose').onclick=$('regCancel').onclick=()=>$('regDlg').close();
$('regForm').onsubmit=e=>{
  e.preventDefault();
  const t=readRegForm(),problem=regProblem(t);
  if(problem){renderRegPreview();return;}
  reloadTemplatesFresh();
  const i=templates.findIndex(x=>x.id===t.id);
  if(i>=0)templates[i]=t;else templates.push(t);
  saveTemplates();
  $('regDlg').close();
  renderRegList();fillFromTemplate();
  regTick();
};

// ---------- «Из шаблона» в окне новой задачи ----------
function fillFromTemplate(){
  const sel=$('fromTemplate');if(!sel)return;
  sel.replaceChildren();
  const add=(v,l)=>{const o=document.createElement('option');o.value=v;o.textContent=l;sel.appendChild(o);};
  add('','⧉ Из шаблона…');
  templates.forEach(t=>add(t.id,t.title));
}
dlgLoadHooks.push(t=>{
  const row=$('fromTemplateRow');if(!row)return;
  fillFromTemplate();
  row.hidden=!!t||!templates.length;
  $('fromTemplate').value='';
});
$('fromTemplate')?.addEventListener('change',()=>{
  const t=tplById($('fromTemplate').value);if(!t)return;
  $('text').value=t.title;autoGrow($('text'));
  $('comment').value=t.comment;autoGrow($('comment'));
  priority=t.priority;document.querySelectorAll('.priorities button').forEach(b=>b.classList.toggle('selected',b.dataset.p===priority));
  fillAssignee(t.assignee||'');
  $('deadline').value=t.deadlineHours?localInput(new Date(Date.now()+t.deadlineHours*3600000)):'';
});

settingsReloadHooks.push(()=>{loadTemplates();renderRegList();fillFromTemplate();});
loadTemplates();renderRegList();fillFromTemplate();
regTick();
setInterval(regTick,20000);
setInterval(renderRegList,60000);
window.GrassRegUi={regTick,reload:()=>{loadTemplates();renderRegList();},templates:()=>templates};
})();
