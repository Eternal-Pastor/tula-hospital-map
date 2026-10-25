(function(root,factory){
  'use strict';
  const api=factory(typeof module!=='undefined'&&module.exports?require('./accessibility.js'):root.HospitalAccessibility);
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.HospitalRoutingHTTP=api;
})(typeof window!=='undefined'?window:globalThis,function(A){
  'use strict';
  const MODES={auto:'driving',pedestrian:'walking',masstransit:'transit'};
  function safeMessage(value,key=''){
    let text=Array.isArray(value)?value.join('; '):String(value||'');
    if(key)text=text.split(key).join('[скрыто]');
    return text.replace(/https?:\/\/[^\s"<>]+/gi,url=>{try{const u=new URL(url);return u.hostname+u.pathname;}catch(_){return '[URL]';}}).replace(/[a-f0-9]{8}-[a-f0-9-]{27,}/gi,'[скрыто]').slice(0,500);
  }
  function httpError(status,body,key){
    const detail=safeMessage(body?.errors||body?.message||body?.error,key);
    const reason=status===401||status===403?'API получения деталей маршрута отклонил ключ. Проверьте активацию, доступ к продукту и ограничения ключа.':status===429?'Исчерпан лимит API маршрутов. Автоматических повторов нет.':status>=500?'API маршрутов временно недоступен.':'API маршрутов не принял запрос.';
    return new Error(reason+' HTTP '+status+(detail?': '+detail:'.'));
  }
  function parseResponse(body){
    const route=body?.route,legs=route?.legs;
    if(!Array.isArray(legs)||!legs.length)throw new Error('API маршрутов вернул ответ без участков пути.');
    if(legs.some(leg=>!leg||typeof leg!=='object'))throw new Error('API маршрутов вернул некорректные участки пути.');
    if(legs.some(leg=>leg.status==='FAIL'))return {status:'unreachable',seconds:null,lines:[],provider:'http'};
    if(legs.some(leg=>leg.status!=='OK'))throw new Error('Неизвестный статус участка маршрута.');
    let seconds=0;const lines=[];
    for(const leg of legs){
      if(!Array.isArray(leg.steps)||!leg.steps.length)throw new Error('API маршрутов вернул участок без шагов.');
      for(const step of leg.steps){
        if(!Number.isFinite(step?.duration)||step.duration<0)throw new Error('API маршрутов не вернул корректное время шага.');
        seconds+=step.duration;
        const points=step.polyline?.points;
        if(points===undefined&&step.duration>0)throw new Error('API маршрутов вернул шаг без геометрии пути.');
        if(points!==undefined){
          if(!Array.isArray(points)||points.length<2||!points.every(A.validPoint))throw new Error('API маршрутов вернул некорректную линию пути.');
          lines.push(points.map(point=>point.slice()));
        }
      }
    }
    if(!lines.length||seconds>604800)throw new Error('API маршрутов не вернул пригодную геометрию или время пути.');
    return {status:'found',seconds,lines,provider:'http',trafficType:['realtime','forecast','disabled'].includes(body.traffic_type)?body.traffic_type:'unknown'};
  }
  async function requestRoute(key,job,signal,fetcher=fetch){
    key=String(key||'').trim();
    if(!key)throw new Error('Укажите ключ API получения деталей маршрута в настройках карты.');
    if(!MODES[job?.mode]||!A.validPoint(job.cell?.origin)||!A.validPoint(job.destination))throw new Error('Некорректные точки или способ передвижения.');
    if(signal?.aborted)throw new DOMException('Расчёт остановлен.','AbortError');
    // Omit departure_time to request the situation at processing time; no paid optional parameters.
    const query=new URLSearchParams({apikey:key,waypoints:job.cell.origin.join(',')+'|'+job.destination.join(','),mode:MODES[job.mode]});
    const controller=new AbortController(),abort=()=>controller.abort();let timedOut=false;
    signal?.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(()=>{timedOut=true;controller.abort();},30000);
    try{
      let response;
      try{response=await fetcher('https://api.routing.yandex.net/v2/route?'+query,{method:'GET',credentials:'omit',cache:'no-store',signal:controller.signal});}
      catch(error){if(error instanceof TypeError)throw new Error('Браузер не получил ответ API маршрутов: проверьте сеть и сообщение CORS в консоли.');throw error;}
      let body;try{body=await response.json();}catch(error){if(!response.ok)throw httpError(response.status,null,key);throw new Error('API маршрутов вернул ответ, который не является JSON.');}
      if(!response.ok)throw httpError(response.status,body,key);
      return parseResponse(body);
    }catch(error){
      if(timedOut)throw new Error('API маршрутов не ответил за 30 секунд. Полученные ранее результаты сохранены.');
      if(signal?.aborted)throw new DOMException('Расчёт остановлен.','AbortError');
      throw error;
    }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
  }
  return {requestRoute,parseResponse,httpError,safeMessage};
});
