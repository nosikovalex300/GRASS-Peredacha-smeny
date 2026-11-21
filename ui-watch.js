// GRASS — Передача смены · «Слежу за задачей» (1.7.11).
//   Кнопка «👁 Следить» в окне задачи. Когда задачу, за которой я слежу, поменял или закрыл кто-то другой
//   (другая смена, другой технолог), — уведомление Windows через тот же механизм, что напоминания о сроке.
//   Список личный: у каждого технолога свой (как плотность списка), в базу не пишется.
//   В карточке — «👁».
(function(){
'use strict';
const api=window.grassNotify;

// id задачи → {p: отпечаток задачи на момент последней проверки, text}
function load(){try{const m=JSON.parse(viewPref('watch','{}'));return m&&typeof m==='object'&&!Array.isArray(m)?m:{};}catch(_){return {};}}
function store(m){setViewPref('watch',JSON.stringify(m));}
function print(loc){return loc?[loc.state,loc.t.status,loc.t.lastActionAt||''].join('|'):'gone';}
function isWatched(id){return Object.prototype.hasOwnProperty.call(load(),String(id));}
function show(title,body){try{api?.show(title,body)?.catch?.(()=>{});}catch(_){}}

const btn=document.createElement('button');
btn.type='button';btn.id='watchToggle';btn.className='watch-toggle';
$('dlgTitle').after(btn);
function syncBtn(){
  const on=!!editId&&isWatched(editId);
  btn.hidden=!editId||!technologist;
  btn.textContent=on?'👁 Слежу':'👁 Следить';
  btn.classList.toggle('on',on);btn.setAttribute('aria-pressed',String(on));
  btn.title=on?'Не следить за задачей':'Уведомлять, когда задачу изменит или закроет другой технолог';
}
btn.addEventListener('click',()=>{
  if(!editId)return;
  const m=load(),id=String(editId);
  if(m[id])delete m[id];
  else{const loc=findTaskAny(id);m[id]={p:print(loc),text:loc?.t.text||''};}
  store(m);syncBtn();render();
});
dlgLoadHooks.push(()=>syncBtn());

function check(){
  if(!technologist||readOnly)return;
  const m=load();let changed=false;
  for(const [id,w] of Object.entries(m)){
    const loc=findTaskAny(id),p=print(loc);
    if(p===w.p)continue;
    changed=true;
    if(!loc){delete m[id];show('Задача удалена',`${w.text}\nЗа ней больше не следите.`);continue;}
    m[id]={p,text:loc.t.text};
    const t=loc.t;
    if(!t.lastActionBy||t.lastActionBy===technologist)continue;   // своё не сообщаем
    const title=loc.state==='archive'?'Задача перенесена в архив':t.status==='Выполнена'?'Задача закрыта':'Задача изменена';
    show(title,`${t.text}\n${t.lastActionBy}${t.lastActionShift?` · смена ${t.lastActionShift}`:''}: «${t.status}»`);
  }
  if(changed)store(m);
}
renderHooks.push(check);   // после подтягивания чужих изменений окно перерисовывается — проверяем сразу
setInterval(check,30000);
taskBadgeHooks.push(t=>isWatched(t.id)?'<span class="watch-badge" title="Вы следите за задачей">👁</span>':'');
window.GrassWatch={check,isWatched};
render();   // список уже нарисован до загрузки модулей — дорисовать значки «👁» и «☑ 2/5»
})();
