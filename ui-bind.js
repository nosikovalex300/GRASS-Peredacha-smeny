// GRASS — Передача смены · окно «Кто вы?» (1.7.12).
//   На общей базе, где в grass-config.json заданы администраторы, технолог закрепляется за учёткой Windows.
//   При первом запуске под учёткой — окно только со свободными именами (или «Меня нет в списке») и подтверждение.
//   Дальше программа сама открывается под этим технологом; чужое имя выбрать нельзя, перепривязка — только администратор.
//   Закрепление пишет main.js (проверяет, что имя свободно), окно его только показывает.
(function(){
'use strict';
if(!bindPending())return;

const dlg=document.createElement('dialog');
dlg.id='bindDlg';dlg.className='stage4-dialog bind-dlg';
dlg.innerHTML=`<div class="bind-body">
  <h3 id="bindTitle">Вы вошли как <b id="bindAccount"></b>. Кто вы?</h3>
  <div id="bindChoose">
    <p class="muted">Выберите себя. Дальше программа будет сама открываться под этим именем.</p>
    <div id="bindList" class="bind-list"></div>
    <div class="bind-add"><input id="bindNewName" type="text" maxlength="80" placeholder="Меня нет в списке: Фамилия И.О."><button type="button" id="bindAddBtn">Это я</button></div>
  </div>
  <div id="bindConfirm" hidden>
    <p id="bindConfirmText"></p>
    <div class="buttons"><button type="button" id="bindBack">Назад</button><button type="button" id="bindOk" class="add">Закрепить за собой</button></div>
  </div>
  <p id="bindProblem" class="bind-problem" aria-live="polite"></p>
</div>`;
document.body.appendChild(dlg);
const el=id=>document.getElementById(id);
el('bindAccount').textContent=techBinding.osUser||'';
// окно нельзя закрыть, не выбрав себя: иначе работа шла бы под чужим именем
dlg.addEventListener('cancel',e=>e.preventDefault());
let chosen='';

function freeNames(){
  reloadTechnologistsFromDb();refreshTechBinding();
  const taken=techBinding.taken||{};
  return technologists.filter(n=>!taken[n]);
}
function showList(problem=''){
  chosen='';
  el('bindChoose').hidden=false;el('bindConfirm').hidden=true;
  el('bindProblem').textContent=problem;
  const list=el('bindList');list.innerHTML='';
  const free=freeNames();
  if(!free.length){const p=document.createElement('p');p.className='muted';p.textContent='Свободных имён нет — впишите себя ниже.';list.appendChild(p);}
  for(const name of free){
    const b=document.createElement('button');b.type='button';b.className='bind-name';b.dataset.bindName=name;b.textContent=name;
    b.onclick=()=>askConfirm(name);
    list.appendChild(b);
  }
}
function askConfirm(name){
  chosen=name;
  el('bindChoose').hidden=true;el('bindConfirm').hidden=false;el('bindProblem').textContent='';
  el('bindConfirmText').textContent=`Закрепить «${name}» за собой (учётка ${techBinding.osUser||''})? Поменять потом сможет только администратор.`;
}
el('bindBack').onclick=()=>showList();
el('bindAddBtn').onclick=()=>{
  const name=el('bindNewName').value.trim().replace(/\s+/g,' ');
  if(!name){el('bindNewName').focus();return;}
  reloadTechnologistsFromDb();
  const same=technologists.find(x=>x.toLowerCase()===name.toLowerCase());
  if(same){
    if((techBinding.taken||{})[same]){el('bindProblem').textContent=`«${same}» уже закреплён за другой учёткой. Если это вы — обратитесь к администратору.`;return;}
    askConfirm(same);return;
  }
  askConfirm(name);
};
el('bindNewName').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();el('bindAddBtn').click();}});
el('bindOk').onclick=()=>{
  const name=chosen;if(!name)return;
  reloadTechnologistsFromDb();
  if(!technologists.includes(name)){   // «Меня нет в списке» — сначала добавляем в общий список
    technologists.push(name);
    const r=grassStorage.setItem('technologists',JSON.stringify(technologists));
    if(r&&r.ok===false){reloadTechnologistsFromDb();showList(r.error||'Не удалось добавить в список.');return;}
  }
  const r=grassStorage.bindClaim?.(name)||{ok:false,error:'Нет связи с программой'};
  if(!r.ok){showList(r.error||'Не удалось закрепить.');return;}
  refreshTechBinding();
  technologist=techBinding.bound||name;
  grassStorage.setItem('technologist',technologist);
  dlg.close();
  renderTechnologistMenu();renderSettingsTechnologists();loadViewPrefs();render();
};
showList();
dlg.showModal();
})();
