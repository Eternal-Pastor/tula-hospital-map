(function(){
  'use strict';
  const form=document.getElementById('developer-login'),field=document.getElementById('developer-code'),error=document.getElementById('developer-error');
  form.addEventListener('submit',async event=>{
    event.preventDefault();error.textContent='';
    if(field.value!=='immortaL'){error.textContent='Неверный код доступа.';field.select();return;}
    const button=form.querySelector('button[type=submit]');button.disabled=true;
    document.getElementById('developer-workspace').hidden=false;
    try{
      for(const source of document.querySelectorAll('script[data-developer-src]'))await new Promise((resolve,reject)=>{
        const script=document.createElement('script');script.src=source.dataset.developerSrc;script.onload=resolve;script.onerror=()=>reject(new Error('Не удалось загрузить страницу. Повторите вход.'));document.head.append(script);
      });
      document.getElementById('developer-gate').remove();document.getElementById('developer-workspace').hidden=false;
      field.value='';window.dispatchEvent(new Event('resize'));
    }catch(e){error.textContent=e.message;button.disabled=false;}
  });
})();
