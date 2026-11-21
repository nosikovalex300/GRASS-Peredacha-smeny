// GRASS — Передача смены · закреплённое объявление площадки (1.7.11).
//   «Линия 3 на ремонте до 30.10» — сверху главного экрана у всех смен этой площадки до указанной даты включительно,
//   потом пропадает само; закрыть раньше может любой технолог (крестик, с подтверждением).
//   Хранится в общих настройках площадки (у Ахтубы и Волжского свои), в общей базе видно всем копиям программы.
(function(){
'use strict';
const KEY='announcements',KEEP_DAYS=60;

function todayIso(){const d=now().d;return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;}
function load(){try{const v=JSON.parse(grassStorage.getItem(KEY)||'[]');return Array.isArray(v)?v.filter(a=>a&&a.id&&a.text&&a.until):[];}catch(_){return [];}}
function active(){const today=todayIso();return load().filter(a=>!a.closed&&a.until>=today);}
function fmtDay(iso){const [y,m,d]=String(iso).split('-');return d&&m?`${d}.${m}.${y}`:iso;}
// Правка списка — по свежему значению из базы прямо перед записью: две копии программы не затрут объявления друг друга.
function update(fn){
  if(readOnly)return false;
  const cutoff=new Date(now().d.getTime()-KEEP_DAYS*86400000).toISOString().slice(0,10);
  const list=fn(load()).filter(a=>a.until>=cutoff);   // давно прошедшие не копим
  const r=grassStorage.setItem(KEY,JSON.stringify(list));
  if(r&&r.ok===false){toast('Объявление не сохранено: '+(r.error||'база недоступна'));return false;}
  renderBar();return true;
}

const bar=document.createElement('div');
bar.id='announceBar';bar.className='announce-bar';bar.setAttribute('aria-live','polite');bar.hidden=true;
document.querySelector('#screen-tasks .page-head').after(bar);
function renderBar(){
  const list=active().sort((a,b)=>a.until.localeCompare(b.until));
  bar.hidden=!list.length;
  bar.innerHTML=list.map(a=>`<div class="announce" data-announce="${esc(a.id)}"><span class="announce-pin" aria-hidden="true">📌</span>`
    +`<div class="announce-body"><b class="announce-text">${esc(a.text)}</b><span class="announce-meta">до ${esc(fmtDay(a.until))} включительно · ${esc(a.author||'')}${a.shift?` · смена ${esc(a.shift)}`:''}</span></div>`
    +(readOnly?'':`<button type="button" class="announce-close" data-announce-close="${esc(a.id)}" title="Снять объявление для всех" aria-label="Снять объявление">×</button>`)+'</div>').join('');
}
bar.addEventListener('click',async e=>{
  const id=e.target.closest('[data-announce-close]')?.dataset.announceClose;
  if(!id)return;
  const a=load().find(x=>x.id===id);
  if(!a)return renderBar();
  if(!await askDialog({title:'Снять объявление?',text:`«${a.text}» пропадёт у всех смен площадки.`,ok:'Снять',cancel:'Оставить'}))return;
  update(list=>list.map(x=>x.id===id?{...x,closed:true,closedBy:technologist,closedAt:now().d.toISOString()}:x));
});

const addBtn=document.createElement('button');
addBtn.type='button';addBtn.id='announceAddBtn';addBtn.className='announce-add';addBtn.textContent='📌 Объявление';
addBtn.title='Закрепить объявление сверху у всех смен площадки до даты';
document.querySelector('#screen-tasks .page-head > div').appendChild(addBtn);   // в шапке: видна и при пустом списке задач

const dlg=document.createElement('dialog');
dlg.id='announceDlg';
dlg.innerHTML='<form id="announceForm" method="dialog"><div class="dlghead"><h2>Объявление площадки</h2><button type="button" id="announceClose">×</button></div>'
  +'<label>Текст *<textarea id="announceText" rows="2" maxlength="200" required placeholder="Например: Линия 3 на ремонте"></textarea></label>'
  +'<label>Показывать до (включительно) *<input id="announceUntil" type="date" required></label>'
  +'<div id="announceProblem" class="dlg-notice" hidden></div>'
  +'<div class="buttons"><button type="button" id="announceCancel">Отмена</button><button type="submit" id="announceSave" class="add">📌 Закрепить</button></div></form>';
document.body.appendChild(dlg);
addBtn.addEventListener('click',()=>{
  if(readOnly)return;
  const d=now().d,next=new Date(d.getFullYear(),d.getMonth(),d.getDate()+1);
  $('announceText').value='';$('announceProblem').hidden=true;
  $('announceUntil').min=todayIso();
  $('announceUntil').value=`${next.getFullYear()}-${String(next.getMonth()+1).padStart(2,'0')}-${String(next.getDate()).padStart(2,'0')}`;
  dlg.showModal();
});
$('announceClose').onclick=$('announceCancel').onclick=()=>dlg.close();
$('announceForm').addEventListener('submit',e=>{
  e.preventDefault();
  const text=$('announceText').value.trim().replace(/\s+/g,' '),until=$('announceUntil').value;
  const problem=!text?'Напишите текст объявления.':!technologist?'Сначала выберите технолога.':!/^\d{4}-\d{2}-\d{2}$/.test(until)?'Укажите дату.':until<todayIso()?'Дата уже прошла — укажите сегодня или позже.':'';
  if(problem){$('announceProblem').textContent=problem;$('announceProblem').hidden=false;return;}
  const item={id:crypto.randomUUID(),text,until,author:technologist,shift,at:now().d.toISOString()};
  if(update(list=>[...list,item]))dlg.close();
});

settingsReloadHooks.push(renderBar);   // объявление добавили или сняли в другой копии программы
renderHooks.push(renderBar);
setInterval(renderBar,60000);          // в полночь прошедшие пропадают сами
renderBar();
window.GrassAnnounce={active,renderBar};
})();
