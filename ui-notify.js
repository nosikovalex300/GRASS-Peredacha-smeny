// GRASS — Передача смены · уведомления (1.7.6, п. 23 плана).
//   - Уведомление Windows за N минут до срока (30 мин, 1 ч или выкл.) — настройка личная, у каждого технолога своя.
//     Напоминаем о задачах технолога: где он исполнитель, а без исполнителя — о задачах его смены.
//   - Уведомление о новой передаче моей смене и мигание кнопки в панели задач.
//   - Число просроченных задач площадки — на значке программы в панели задач.
// Крестик по-прежнему закрывает программу (в трей не сворачиваем).
(function(){
'use strict';
const api=window.grassNotify;
const BEFORE_OPTIONS=[30,60,0];

function notifyBefore(){const v=Number(viewPref('notifyBefore','30'));return BEFORE_OPTIONS.includes(v)?v:30;}
function seenKey(kind){return `grass_notified|${kind}|${currentSite()}|${technologist}`;}
function loadSeen(kind){try{return new Set(JSON.parse(localStorage.getItem(seenKey(kind))||'[]'));}catch(_){return new Set();}}
function saveSeen(kind,set){try{localStorage.setItem(seenKey(kind),JSON.stringify([...set].slice(-500)));}catch(_){}}
function show(title,body){try{api?.show(title,body)?.catch?.(()=>{});}catch(_){}}

// Мои задачи для напоминаний о сроке.
function isMineForDeadline(t){
  if(t.status==='Выполнена'||!t.deadline)return false;
  if(t.assignee)return t.assignee===technologist;
  return holderShiftOf(t)===shift;
}
function fmtTime(d){return d.toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'});}

function checkDeadlines(){
  const before=notifyBefore();
  if(!before||!technologist||readOnly)return;
  const nowMs=Date.now(),seen=loadSeen('deadline');let changed=false;
  for(const t of db.tasks){
    if(!isMineForDeadline(t))continue;
    const dl=new Date(t.deadline);if(isNaN(dl))continue;
    const left=(dl-nowMs)/60000;
    if(left<=0||left>before)continue;
    const key=t.id+'|'+t.deadline;
    if(seen.has(key))continue;
    seen.add(key);changed=true;
    show(`Срок через ${Math.max(1,Math.round(left))} мин`,`${t.text}\nСрок: ${fmtTime(dl)}${t.assignee?` · исполнитель ${t.assignee}`:''}`);
  }
  if(changed)saveSeen('deadline',seen);
}

// Новые передачи моей смене: по одному уведомлению на передачу.
function checkHandovers(){
  if(!technologist||readOnly)return false;
  const incoming=db.tasks.filter(t=>t.toShift===shift&&t.status==='Передать по смене');
  const seen=loadSeen('handover'),fresh=[];
  for(const t of incoming){const key=t.id+'|'+(t.lastActionAt||t.lastActionAtIso||'');if(!seen.has(key)){seen.add(key);fresh.push(t);}}
  if(!fresh.length)return false;
  saveSeen('handover',seen);
  const from=fresh[0].fromShift?` от смены ${fresh[0].fromShift}`:'';
  show(fresh.length===1?`Новая передача смене ${shift}${from}`:`Новые передачи смене ${shift}: ${fresh.length}`,
    fresh.slice(0,5).map(t=>'• '+t.text).join('\n')+(fresh.length>5?`\n… и ещё ${fresh.length-5}`:''));
  return true;
}

// Значок: красный кружок с числом просроченных.
let lastBadge=null;
function badgePng(n){
  try{
    const c=document.createElement('canvas');c.width=c.height=32;
    const g=c.getContext('2d');if(!g)return '';
    g.fillStyle='#e5383b';g.beginPath();g.arc(16,16,15,0,Math.PI*2);g.fill();
    g.fillStyle='#fff';g.font=`bold ${n>99?13:n>9?17:20}px Segoe UI, Arial, sans-serif`;g.textAlign='center';g.textBaseline='middle';
    g.fillText(n>99?'99+':String(n),16,17);
    return c.toDataURL('image/png');
  }catch(_){return '';}
}
function overdueCount(){
  const nowMs=Date.now();
  return db.tasks.filter(t=>t.status!=='Выполнена'&&t.deadline&&!isNaN(new Date(t.deadline))&&new Date(t.deadline).getTime()<nowMs).length;
}
function updateTaskbar(flash){
  if(!api)return;
  const n=overdueCount();
  if(n===lastBadge&&!flash)return;
  lastBadge=n;
  try{api.taskbar(n,n?badgePng(n):'',!!flash)?.catch?.(()=>{});}catch(_){}
}

function tick(){
  checkDeadlines();
  const flash=checkHandovers();
  updateTaskbar(flash);
}

// Настройка в «Внешний вид»: личная.
const sel=$('notifyBefore');
if(sel){
  sel.value=String(notifyBefore());
  sel.addEventListener('change',()=>{setViewPref('notifyBefore',sel.value);sel.value=String(notifyBefore());});
}
settingsReloadHooks.push(()=>{if(sel)sel.value=String(notifyBefore());});
renderHooks.push(()=>{if(sel&&document.activeElement!==sel)sel.value=String(notifyBefore());updateTaskbar(false);});

tick();
setInterval(tick,30000);
window.GrassNotifyUi={tick,overdueCount,notifyBefore};
})();
