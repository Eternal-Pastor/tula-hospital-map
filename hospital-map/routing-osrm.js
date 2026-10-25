(function(root,factory){
  'use strict';
  const api=factory(typeof module!=='undefined'&&module.exports?require('./accessibility.js'):root.HospitalAccessibility);
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.HospitalRoutingOSRM=api;
})(typeof window!=='undefined'?window:globalThis,function(A){
  'use strict';
  const MODES=['auto','pedestrian'];
  const DEFAULTS={auto:'https://routing.openstreetmap.de/routed-car/route/v1/driving',pedestrian:'https://routing.openstreetmap.de/routed-foot/route/v1/foot'};
  let lastStart=0;
  function endpoint(value){
    let u;try{u=new URL(value);}catch(_){throw new Error('Укажите полный URL сервиса OSRM.');}
    if((u.protocol!=='https:'&&!(u.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(u.hostname)))||u.username||u.password||u.search||u.hash||!/\/route\/v1\/[^/]+\/?$/.test(u.pathname))throw new Error('URL OSRM должен оканчиваться на /route/v1/профиль, без ключей и параметров; HTTP разрешён для localhost.');
    return u.href.replace(/\/$/,'');
  }
  function config(values={}){return Object.fromEntries(MODES.map(mode=>[mode,endpoint(values[mode]||DEFAULTS[mode]) ]));}
  function isPublic(values){return MODES.some(mode=>['routing.openstreetmap.de','router.project-osrm.org'].includes(new URL(values[mode]).hostname));}
  function parseResponse(body){
    if(['NoRoute','NoSegment'].includes(body?.code))return {status:'unreachable',seconds:null,lines:[],provider:'osrm',trafficType:'disabled',routeReason:body.code};
    if(body?.code!=='Ok')throw new Error('OSRM отклонил запрос: '+String(body?.code||'неизвестный ответ').replace(/[^a-zA-Z0-9_-]/g,'').slice(0,80));
    const route=body.routes?.[0],points=route?.geometry?.coordinates;
    if(!Number.isFinite(route?.duration)||route.duration<0||route.duration>604800||route?.geometry?.type!=='LineString'||!Array.isArray(points)||points.length<2||points.length>30000||!points.every(p=>Array.isArray(p)&&p.length===2&&A.validPoint([p[1],p[0]])))throw new Error('OSRM не вернул корректное время или линию маршрута.');
    const snapDistances=body.waypoints?.map(p=>p?.distance);
    if(!Array.isArray(snapDistances)||snapDistances.length!==2||!snapDistances.every(v=>Number.isFinite(v)&&v>=0&&v<=1001))throw new Error('OSRM вернул некорректную привязку к дорожной сети.');
    return {status:'found',seconds:route.duration,lines:[points.map(([lon,lat])=>[lat,lon])],provider:'osrm',trafficType:'disabled',snapDistances};
  }
  async function requestRoute(service,job,signal,fetcher=fetch){
    if(!MODES.includes(job?.mode)||!A.validPoint(job.cell?.origin)||!A.validPoint(job.destination))throw new Error('OSRM поддерживает здесь только машину и пешие маршруты.');
    service=endpoint(service);
    if(signal?.aborted)throw new DOMException('Расчёт остановлен.','AbortError');
    const coordinates=[job.cell.origin,job.destination].map(([lat,lon])=>lon+','+lat).join(';');
    const query=new URLSearchParams({overview:'full',geometries:'geojson',steps:'false',alternatives:'false',generate_hints:'false',radiuses:'1000;1000'});
    const controller=new AbortController(),abort=()=>controller.abort();let timedOut=false;
    signal?.addEventListener('abort',abort,{once:true});const timer=setTimeout(()=>{timedOut=true;controller.abort();},30000);
    try{
      const loopback=['localhost','127.0.0.1','[::1]'].includes(new URL(service).hostname);
      const wait=loopback?0:Math.max(0,1100-(Date.now()-lastStart));
      if(wait)await new Promise((resolve,reject)=>{const stop=()=>{clearTimeout(pause);controller.signal.removeEventListener('abort',stop);reject(new DOMException('Расчёт остановлен.','AbortError'));},pause=setTimeout(()=>{controller.signal.removeEventListener('abort',stop);resolve();},wait);controller.signal.addEventListener('abort',stop,{once:true});});
      if(controller.signal.aborted)throw new DOMException('Расчёт остановлен.','AbortError');if(!loopback)lastStart=Date.now();
      let response;try{response=await fetcher(service+'/'+coordinates+'?'+query,{credentials:'omit',cache:'no-store',signal:controller.signal});}
      catch(error){if(error instanceof TypeError)throw new Error('Нет ответа OSRM: проверьте сеть, доступность сервера и разрешение CORS.');throw error;}
      if(!response.ok){if(response.status===429)throw new Error('OSRM: превышен лимит запросов (HTTP 429). Порция остановлена без повторов.');if(response.status!==400)throw new Error('OSRM недоступен: HTTP '+response.status+'.');}
      let body;try{body=await response.json();}catch(_){throw new Error('OSRM вернул ответ, который не является JSON.');}
      if(!response.ok&&!['NoRoute','NoSegment'].includes(body?.code))throw new Error('OSRM не принял запрос: HTTP '+response.status+'.');
      return {...parseResponse(body),routingService:service};
    }catch(error){if(signal?.aborted)throw new DOMException('Расчёт остановлен.','AbortError');if(timedOut)throw new Error('OSRM не ответил за 30 секунд.');throw error;}
    finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
  }
  return {MODES,DEFAULTS,endpoint,config,isPublic,parseResponse,requestRoute};
});
