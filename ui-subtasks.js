// GRASS — Передача смены · подпункты внутри задачи (1.7.11).
//   Мини-чек-лист в окне задачи: каждый пункт отмечает тот, кто сделал, — со сменой и временем; всё пишется в историю.
//   Хранится в самой задаче (task.subtasks): структура базы та же, 1.7.10 такие поля сохраняет нетронутыми.
//   У существующей задачи отметка сохраняется сразу (как быстрые кнопки), у новой — вместе с созданием задачи.
//   В карточке — «☑ 2/5».
(function(){
'use strict';
const MAX=30;
let pending=[];   // подпункты новой задачи — до «Создать задачу»

function subsOf(t){return Array.isArray(t?.subtasks)?t.subtasks:[];}
function current(){return editId?db.tasks.find(x=>x.id===editId)||null:null;}
function items(){const t=current();return t?subsOf(t):pending;}
function fmt(iso){const d=iso?new Date(iso):null;return d&&!isNaN(d)?d.toLocaleString('ru-RU',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}):'';}

const block=document.createElement('div');
block.className='subtasks-block';block.id='subtasksBlock';
block.innerHTML='<div class="subtasks-head"><b>Подпункты</b><span id="subtasksProgress" class="subtasks-progress"></span></div>'
  +'<div id="subtasksList" class="subtasks-list"></div>'
  +'<div class="subtasks-add"><input id="subtaskText" type="text" maxlength="200" placeholder="Новый подпункт, например «заказать уплотнение»"><button type="button" id="subtaskAdd" class="attach-add">+ Подпункт</button></div>';
$('attachBlock').before(block);

function renderList(){
  const list=items();
  $('subtasksList').innerHTML=list.map(s=>`<div class="subtask${s.done?' done':''}" data-sub="${esc(s.id)}">`
    +`<input type="checkbox" data-sub-toggle="${esc(s.id)}" aria-label="Выполнен: ${esc(s.text)}"${s.done?' checked':''}${readOnly?' disabled':''}>`
    +`<span class="subtask-text">${esc(s.text)}</span>`
    +`<span class="subtask-who">${s.done?esc(`✓ ${s.doneBy||''} · смена ${s.doneShift||''} · ${fmt(s.doneAt)}`):''}</span>`
    +(readOnly?'':`<button type="button" class="subtask-del" data-sub-del="${esc(s.id)}" title="Удалить подпункт" aria-label="Удалить подпункт ${esc(s.text)}">×</button>`)
    +'</div>').join('');
  const done=list.filter(x=>x.done).length;
  $('subtasksProgress').textContent=list.length?`${done} из ${list.length}`:'';
  $('subtaskText').disabled=$('subtaskAdd').disabled=readOnly||list.length>=MAX;
}

// Существующая задача: свежие данные из базы → правка → событие в историю → сохранение (одним пакетом).
function change(fn){
  if(readOnly)return;
  if(SHARED_MODE)pullRemoteChanges();
  const t=current();
  if(!t){toast('Эту задачу уже перенесли в архив или удалили.');render();return;}
  const ev=fn(t);
  if(!ev)return;
  inBatch(()=>logEvent(t,ev.action,ev.details,{subtask:ev.text}));
  dlgBaseRev=savedState?.revs.get(String(t.id))??dlgBaseRev;   // своя правка — не «кто-то изменил задачу»
  render();renderHistory();renderList();
}

$('subtaskAdd').addEventListener('click',()=>{
  const text=$('subtaskText').value.trim().replace(/\s+/g,' ');
  if(!text)return;
  const n=now(),item={id:crypto.randomUUID(),text,done:false,addedBy:technologist,addedShift:shift,addedAt:n.d.toISOString()};
  $('subtaskText').value='';
  if(!editId){pending.push(item);renderList();return;}
  change(t=>{t.subtasks=[...subsOf(t),item];return {action:'Добавлен подпункт',details:`«${text}»`,text};});
});
$('subtaskText').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();$('subtaskAdd').click();}});

$('subtasksList').addEventListener('change',e=>{
  const id=e.target.closest('[data-sub-toggle]')?.dataset.subToggle;
  if(!id)return;
  const on=e.target.checked,n=now();
  const mark=s=>on?{...s,done:true,doneBy:technologist,doneShift:shift,doneAt:n.d.toISOString()}:{...s,done:false,doneBy:'',doneShift:'',doneAt:''};
  if(!editId){pending=pending.map(s=>s.id===id?mark(s):s);renderList();return;}
  change(t=>{
    const s=subsOf(t).find(x=>x.id===id);
    if(!s||!!s.done===on){renderList();return null;}   // уже отметил кто-то другой
    t.subtasks=subsOf(t).map(x=>x.id===id?mark(x):x);
    return {action:on?'Подпункт выполнен':'Подпункт снова открыт',details:`«${s.text}»`,text:s.text};
  });
});
$('subtasksList').addEventListener('click',e=>{
  const id=e.target.closest('[data-sub-del]')?.dataset.subDel;
  if(!id)return;
  if(!editId){pending=pending.filter(s=>s.id!==id);renderList();return;}
  change(t=>{
    const s=subsOf(t).find(x=>x.id===id);
    if(!s)return null;
    t.subtasks=subsOf(t).filter(x=>x.id!==id);
    return {action:'Удалён подпункт',details:`«${s.text}»`,text:s.text};
  });
});

dlgLoadHooks.push(t=>{pending=[];$('subtaskText').value='';renderList();});
// Новая задача: подпункты — вместе с созданием, одним событием в истории.
taskSavedHooks.push((task,old)=>{
  if(old||!pending.length)return;
  task.subtasks=pending.slice();
  logEvent(task,'Добавлены подпункты',pending.map(s=>`«${s.text}»`).join(', '));
  pending=[];
});
taskBadgeHooks.push(t=>{
  const s=subsOf(t);if(!s.length)return '';
  const done=s.filter(x=>x.done).length;
  return `<span class="subtask-badge${done===s.length?' all':''}" title="Подпункты: выполнено ${done} из ${s.length}">☑ ${done}/${s.length}</span>`;
});
window.GrassSubtasks={subsOf};
})();
