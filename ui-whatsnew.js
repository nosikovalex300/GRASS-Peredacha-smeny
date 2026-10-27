// GRASS — Передача смены · окно «Что нового» (1.7.11).
//   При первом запуске новой версии — 3–5 строк о главном, один раз на пользователя Windows (запоминается в профиле).
//   На совсем новой установке (пустая база, программой ещё не пользовались) не показывается.
//   Если при запуске открыта сводка смены — окно ждёт, пока её закроют.
(function(){
'use strict';
const VERSION=String(GRASS_MODE.version||'');
const NOTES={
  '1.7.11':[
    'Подпункты внутри задачи: мини-чек-лист, у каждого пункта видно, кто и в какую смену его сделал.',
    'Объявление площадки (кнопка «📌 Объявление» вверху главного экрана): висит у всех смен до нужной даты.',
    '«👁 Следить» в окне задачи: уведомление, когда задачу изменит или закроет другой технолог.',
    'В Настройках: проверка последней резервной копии и кто сейчас в программе с какой версией.',
    'Время на главном экране больше не наезжает на дату.'
  ]
};
const SEEN='grass_whatsnew_seen';
function seen(){try{return localStorage.getItem(SEEN)||'';}catch(_){return '';}}
function markSeen(){try{localStorage.setItem(SEEN,VERSION);}catch(_){}}
const lines=NOTES[VERSION];
if(!VERSION||!lines||seen()===VERSION)return;
// новая установка: базой ещё не пользовались — рассказывать «что изменилось» некому
if(!seen()&&!(db.tasks||[]).length&&!(db.archive||[]).length&&!(db.history||[]).length){markSeen();return;}

const dlg=document.createElement('dialog');
dlg.id='whatsNewDlg';dlg.className='whatsnew-dlg';
dlg.innerHTML=`<form method="dialog"><div class="dlghead"><h2>Что нового в версии ${esc(VERSION)}</h2><button type="submit" id="whatsNewClose" aria-label="Закрыть">×</button></div>`
  +`<ul class="whatsnew-list">${lines.map(l=>`<li>${esc(l)}</li>`).join('')}</ul>`
  +'<div class="buttons"><button type="submit" id="whatsNewOk" class="add">Понятно</button></div></form>';
document.body.appendChild(dlg);
function showWhenFree(){
  if(document.querySelector('dialog[open]'))return false;
  dlg.showModal();markSeen();   // показали — больше не показываем, даже если программу закроют, не нажав «Понятно»
  return true;
}
if(!showWhenFree()){
  const timer=setInterval(()=>{if(showWhenFree())clearInterval(timer);},1000);
}
})();
