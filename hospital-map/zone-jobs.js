(function(root){
  'use strict';
  function create({makeWorker,onResult,onProgress=()=>{},onError=()=>{},onStatus=()=>{},cooldown=1000}){
    let worker=null,running=null,queued=null,delivering=false,timer=null,disabled=false,sequence=0,lastKey=null;
    function fail(error){disabled=true;running=null;queued=null;if(worker)worker.terminate();worker=null;onError(error);onStatus(false);}
    function dispatch(){
      if(disabled||running||delivering||timer||!queued)return;
      try {
        if(!worker){
          worker=makeWorker();
          worker.onerror=event=>{event.preventDefault?.();fail(new Error('Фоновый расчёт недоступен. Перезагрузите страницу через localhost.'));};
          worker.onmessage=async event=>{
            if(!running||event.data.id!==running.id)return;
            if(event.data.type==='progress'){onProgress(event.data);return;}
            running=null;delivering=true;
            try {await onResult(event.data);}
            catch(error){onError(error);}
            finally {
              delivering=false;
              if(queued){timer=setTimeout(()=>{timer=null;dispatch();},cooldown);}
              onStatus(Boolean(queued));
            }
          };
        }
        running={id:++sequence,...queued};queued=null;onStatus(true);
        worker.postMessage(running);
      } catch(error){fail(error);}
    }
    return {
      request(key,organizations,options={}){if(disabled||key===lastKey)return;lastKey=key;queued={...options,key,organizations};dispatch();},
      get busy(){return Boolean(running||queued||delivering||timer);},
      restart(){clearTimeout(timer);timer=null;queued=null;running=null;delivering=false;lastKey=null;disabled=false;if(worker)worker.terminate();worker=null;onStatus(false);},
      dispose(){disabled=true;clearTimeout(timer);timer=null;queued=null;running=null;if(worker)worker.terminate();worker=null;}
    };
  }
  function chunks(items,visit,{cancelled=()=>false,onProgress=()=>{},budget=8,now=()=>performance.now(),schedule=callback=>setTimeout(callback,0)}={}){
    const iterator=items[Symbol.iterator]();
    let completed=0;
    return new Promise((resolve,reject)=>{
      function step(){
        if(cancelled())return resolve(false);
        const start=now();let count=0;
        try {
          while(!count||now()-start<budget){
            if(cancelled())return resolve(false);
            const next=iterator.next();if(next.done){onProgress(completed);return resolve(true);}
            visit(next.value);count++;completed++;
          }
          onProgress(completed);
          schedule(step);
        } catch(error){reject(error);}
      }
      schedule(step);
    });
  }
  const api={create,chunks};root.HospitalZoneJobs=api;
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
