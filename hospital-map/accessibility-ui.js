(function(root){
  'use strict';
  const A=root.HospitalAccessibility,O=root.HospitalRoutingOSRM;
  const $=id=>document.getElementById(id),esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const minutes=s=>s===null?'нет данных':(s/60).toLocaleString('ru-RU',{maximumFractionDigits:1})+' мин';
  const LOCAL_SERVICES={auto:'http://localhost:5000/route/v1/driving',pedestrian:'http://localhost:5001/route/v1/foot'};
  function validateSettings(s={}){
    if(!s||typeof s!=='object')throw new Error('Некорректные настройки доступности.');
    let servers={...LOCAL_SERVICES};
    try{const next=O.config(s.osrm);if(Object.values(next).every(url=>['localhost','127.0.0.1','[::1]'].includes(new URL(url).hostname)))servers=next;}catch(_){}
    return {gridPreset:'full-region-v2',routingPreset:'local-full-v2',source:'osrm',osrm:servers,model:{...A.MODEL},enabled:true,mode:s.mode==='pedestrian'?'pedestrian':'auto',step:[5000,10000,20000].includes(s.step)?s.step:5000,scope:'all',shape:'cells',lines:false,fillMissing:'same-hospital-idw4-v1'};
  }
  function resourceName(value){try{const url=new URL(value);return url.hostname+url.pathname;}catch(_){return '';}}
  function routeError(error,resource,mode){
    const raw=String(error?.message||'ошибка доступа или сети').replace(/https?:\/\/[^\s)]+/gi,url=>resourceName(url)).replace(/[a-f0-9]{8}-[a-f0-9-]{27,}/gi,'[скрыто]');
    const status=Number(error?.status||error?.statusCode||error?.code);
    const prefix='Яндекс не построил маршрут ('+(A.LABELS[mode]||mode)+'): ';
    if(status===401||status===403)return prefix+'сервис отклонил доступ (HTTP '+status+'). Проверьте ключ JavaScript API, разрешённый адрес сайта и доступ к маршрутизации.';
    if(status===429)return prefix+'превышен лимит маршрутизации (HTTP 429). Дождитесь восстановления квоты.';
    if(/scriptError/i.test(raw))return prefix+'scriptError — не удалось загрузить скрипт ответа маршрутизатора.'+(resource?' Ресурс: '+resource+'.':'')+' Откройте F12 → Консоль: нужен текст красной ошибки загрузки. В «Сети» проверяйте исходный запрос с типом script/js и причину блокировки. Не передавайте URL, Cookie, ключ или token. Лимит геокодера не подтверждает причину этого сбоя.';
    return prefix+raw+(resource?' Ресурс: '+resource+'.':'');
  }
  // Coordinate-only routing explicitly disables reverse geocoding, including waypoints.
  function requestRoute(ym,job,signal){
    return new Promise((resolve,reject)=>{
      let model,done=false,failedResource='',resourceDetails=null;
      const captureResource=event=>{const src=event.target?.src;if(src&&/route|router|routing/i.test(src)){failedResource=resourceName(src);try{const url=new URL(src);resourceDetails={resource:failedResource,parameters:[...url.searchParams.keys()],query:Object.fromEntries([...url.searchParams].filter(([key])=>['lang','rll','rtm','results'].includes(key)))};}catch(_){}}};
      const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);root.removeEventListener?.('error',captureResource,true);try{model?.destroy();}catch(_){}error?reject(error):resolve(value);};
      const abort=()=>finish(Object.assign(new Error('Расчёт остановлен.'),{name:'AbortError'}));
      const timer=setTimeout(()=>finish(new Error('Маршрутизатор не ответил за 30 секунд. Порция остановлена; её можно продолжить.')),30000);
      if(signal?.aborted)return abort();signal?.addEventListener('abort',abort,{once:true});
      root.addEventListener?.('error',captureResource,true);
      try{
        model=new ym.multiRouter.MultiRouteModel([job.cell.origin,job.destination],{routingMode:job.mode,reverseGeocoding:false,searchCoordOrder:'latlong',results:1,avoidTrafficJams:job.mode==='auto'});
        model.events.add('requestfail',event=>{if(resourceDetails)root.console?.warn('Диагностика маршрутизации (без ключей): '+JSON.stringify(resourceDetails));finish(new Error(routeError(event.get('error'),failedResource,job.mode)));});
        model.events.add('requestsuccess',()=>{
          try{
            const candidates=model.getRoutes().map(route=>({route,seconds:(job.mode==='auto'?route.properties.get('durationInTraffic')?.value:null)??route.properties.get('duration')?.value})).filter(v=>Number.isFinite(v.seconds)&&v.seconds>=0).sort((a,b)=>a.seconds-b.seconds);
            const best=candidates[0];
            if(!best){if(model.getRoutes().length)throw new Error('Ответ маршрутизатора не содержит времени пути.');return finish(null,{status:'unreachable',seconds:null,lines:[]});}
            const lines=best.route.getPaths().map(path=>path.properties.get('coordinates')).filter(l=>Array.isArray(l)&&l.length>1&&l.every(A.validPoint));
            if(!lines.length)throw new Error('Ответ маршрутизатора не содержит линии пути.');
            finish(null,{status:'found',seconds:best.seconds,lines});
          }catch(error){finish(error);}
        });
      }catch(error){finish(error);}
    });
  }
  function create({context,persist,notify,onChange,beforeRun=async()=>{}}){
    const records=new Map(),unsaved=new Map(),knownIds=new Set(context().organizations.map(o=>o.id));
    let options=validateSettings(),cells=[],gridStamp='',failedStamp='',gridPromise=null,gridError='',recordRevision=0,fillStamp='',filled=null;
    let running=false,controller=null,message='',stage='',done=0,total=0,lastRun=false,worker=null,workerId=0;
    let mapRef=null,cellLayer=null,lineLayer=null,drawStamp='',drawToken=0,selectedCell=null;const rendered=new Set();
    try{options=validateSettings(JSON.parse(localStorage.getItem('hospital-map-accessibility')||'{}'));}catch(_){}
    const save=()=>{try{localStorage.setItem('hospital-map-accessibility',JSON.stringify(options));}catch(_){}};
    const destinations=()=>new Map([...context().destinations].filter(([,p])=>A.validPoint(p)));
    const wantedGrid=()=>JSON.stringify([context().revision,options.step]);
    const jobs=()=>[...new Map(A.pending(cells,destinations(),records,O.MODES,options.osrm).map(j=>[j.key,j])).values()];
    function completedTimes(){
      const stamp=JSON.stringify([gridStamp,recordRevision,[...destinations()]]);
      if(stamp!==fillStamp){filled=A.completeTimes(cells,destinations(),records,options.osrm);fillStamp=stamp;}
      return filled;
    }
    function workerGrid(zones,step){
      const id=++workerId,url=URL.createObjectURL(new Blob([root.HospitalAccessibilityWorkerSource],{type:'text/javascript'}));
      return new Promise((resolve,reject)=>{
        try{worker=new Worker(url);}catch(error){URL.revokeObjectURL(url);return reject(error);}
        const own=worker,finish=()=>{URL.revokeObjectURL(url);own.terminate();if(worker===own)worker=null;};
        own.onerror=event=>{event.preventDefault?.();finish();reject(new Error('Не удалось построить сетку в фоне. Перезагрузите страницу через localhost.'));};
        own.onmessage=event=>{if(event.data.id!==id)return;finish();event.data.error?reject(new Error(event.data.error)):resolve(event.data.result);};
        own.postMessage({id,task:'grid',payload:{zones,step}});
      });
    }
    async function ensureGrid(){
      if(gridPromise){await gridPromise;return gridStamp===wantedGrid()?true:ensureGrid();}
      const stamp=wantedGrid(),c=context();if(gridStamp===stamp)return true;
      if(c.pending||!c.zones.size)return false;
      gridError='';sync();
      gridPromise=(async()=>{
        try{
          const result=await workerGrid(c.zones,options.step);if(stamp!==wantedGrid())return false;
          cells=result.cells;gridStamp=stamp;failedStamp='';selectedCell=null;fillStamp='';drawStamp='';return true;
        }catch(error){failedStamp=stamp;gridError=error.message;throw error;}
      })();
      try{return await gridPromise;}finally{gridPromise=null;sync();draw();}
    }
    function sync(){
      $('access-step').value=options.step;$('access-step').disabled=running;
      $('access-calculate').disabled=running||!context().zones.size&&!context().pending;
      $('access-calculate').textContent=running?'Выполняется полный расчёт…':'Рассчитать всю область';
      $('access-stop').hidden=!running;$('access-progress').hidden=!running&&!lastRun;
      const bar=$('access-progress');if(running&&['coverage','grid'].includes(stage))bar.removeAttribute('value');else{bar.max=Math.max(total,1);bar.value=done;}
      const result=completedTimes(),s=result.summary;
      $('access-summary').textContent=cells.length?`Ячеек: ${cells.length.toLocaleString('ru-RU')} · больниц: ${new Set(cells.map(c=>c.organizationId)).size}`:'Готовим сетку по сохранённым зонам…';
      $('access-results').innerHTML=O.MODES.map(mode=>{const a=s[mode],count=a.measured+a.neighbor+a.distance;return `<div class="travel-result"><span>${A.LABELS[mode]}</span><strong>${count.toLocaleString('ru-RU')} / ${cells.length.toLocaleString('ru-RU')}</strong><small>OSRM: ${a.measured.toLocaleString('ru-RU')} · ≈ ${a.neighbor+a.distance}${a.missing?' · нет координат: '+a.missing:''}</small></div>`;}).join('');
      const missing=jobs().length;
      $('access-status').textContent=gridError||message||(gridPromise?'Строим сетку в фоне…':!cells.length?'Загрузите копию проекта с адресами и зонами.':missing?`Не запрошено маршрутов: ${missing.toLocaleString('ru-RU')}. Показаны предварительные оценки.`:'Все маршруты проверены. Пропуски заполнены оценками.');
      $('access-fill-note').textContent='≈ — оценка по ближайшим рассчитанным ячейкам той же больницы. Если таких ячеек нет, используется оценка по расстоянию. Это не подтверждение наличия маршрута.';
      $('access-legend').hidden=!cells.length;
      $('access-legend-mode').textContent=A.LABELS[options.mode];
      const active=s[options.mode];$('access-legend-detail').textContent=`OSRM: ${active.measured} · по соседям: ≈ ${active.neighbor}${active.distance?' · по расстоянию: ≈ '+active.distance:''}`;
      $('access-legend-method').textContent='Время до закреплённой больницы. Нажмите на ячейку, чтобы увидеть источник значения.';
      document.querySelector('.map-workspace').classList.add('access-active');
      document.querySelectorAll('[data-travel-mode]').forEach(button=>{const active=button.dataset.travelMode===options.mode;button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));});
    }
    function refresh(){
      const c=context();if(mapRef!==c.map){mapRef=c.map;cellLayer=null;lineLayer=null;rendered.clear();drawStamp='';drawToken++;if(mapRef){cellLayer=new c.ym.GeoObjectCollection();lineLayer=new c.ym.GeoObjectCollection();mapRef.geoObjects.add(cellLayer).add(lineLayer);}}
      sync();
      if(!running&&!c.pending&&c.zones.size&&gridStamp!==wantedGrid()&&failedStamp!==wantedGrid())ensureGrid().then(()=>{if(gridStamp!==wantedGrid())refresh();}).catch(()=>sync());
      draw();
    }
    function draw(){drawNow().catch(error=>{message='Не удалось показать время на карте: '+error.message;sync();});}
    async function drawNow(){
      if(!mapRef||!cellLayer)return;
      const c=context(),stamp=JSON.stringify([c.epoch,gridStamp,recordRevision,options.mode,[...destinations()]]);
      if(stamp===drawStamp)return;drawStamp=stamp;const token=++drawToken,layer=cellLayer;lineLayer.removeAll();
      // Removing thousands of SDK polygons at once blocks the browser too.
      await root.HospitalZoneJobs.chunks([...rendered],polygon=>{layer.remove(polygon);rendered.delete(polygon);},{budget:4,cancelled:()=>token!==drawToken});
      if(token!==drawToken)return;
      if(gridStamp!==wantedGrid())return;
      const result=completedTimes();
      await root.HospitalZoneJobs.chunks(cells,cell=>{
        const value=result.values.get(cell.id)[options.mode],name=c.organizations.find(o=>o.id===cell.organizationId)?.shortName,color=A.COLORS[A.band(value.seconds)];
        const polygon=new c.ym.Polygon(cell.geometry.map(r=>r.map(([lon,lat])=>[lat,lon])),{hintContent:esc(name)+' · '+(value.source==='osrm'?'':'≈ ')+minutes(value.seconds)},{fillColor:color,fillOpacity:.48,strokeColor:color,strokeOpacity:.6,strokeWidth:1,zIndex:240});
        polygon.events.add('click',()=>{selectedCell=cell;showCell();});layer.add(polygon);rendered.add(polygon);
      },{cancelled:()=>token!==drawToken});
    }
    function showCell(){
      if(!selectedCell)return;
      const c=context(),name=c.organizations.find(o=>o.id===selectedCell.organizationId)?.shortName,result=completedTimes().values.get(selectedCell.id);
      $('access-cell-title').textContent=name;$('access-cell-origin').textContent=`Точка ячейки: ${selectedCell.origin.map(v=>v.toFixed(5)).join(', ')}`;
      const source=value=>value.source==='osrm'?'Маршрут OSRM':value.source==='neighbor'?`Оценка по ${value.donors.length} соседним ячейкам той же больницы; ближайшая — ${(value.nearestMeters/1000).toLocaleString('ru-RU',{maximumFractionDigits:1})} км`:value.source==='distance'?'Резервная оценка по расстоянию':'Нет координат больницы';
      $('access-cell-times').innerHTML=O.MODES.map(mode=>{const v=result[mode];return `<tr><th>${A.LABELS[mode]}</th><td>${v.source==='osrm'?'':'≈ '}${minutes(v.seconds)}</td><td>${esc(source(v))}${v.routeStatus==='unreachable'?'<br>OSRM не нашёл путь.':''}</td></tr>`;}).join('');
      $('access-cell-method').textContent='Оценки заполняют цветовую карту и не подменяют исходные ответы OSRM. Для ненайденного пути линия маршрута не создаётся.';
      lineLayer?.removeAll();const raw=A.cellRoutes(selectedCell,destinations().get(selectedCell.organizationId),records,options.osrm)[options.mode];
      if(mapRef&&raw?.status==='found')for(const line of raw.lines)lineLayer.add(new c.ym.Polyline(line,{hintContent:name},{strokeColor:'#243f36',strokeWidth:4,strokeOpacity:.9,zIndex:400}));
      if(!$('access-cell-dialog').open)$('access-cell-dialog').showModal();
    }
    async function calculate(){
      if(running)return;
      running=true;controller=new AbortController();const signal=controller.signal;stage='coverage';message='Готовим полное покрытие области…';done=0;total=0;lastRun=false;sync();
      try{
        await beforeRun(signal);if(signal.aborted)throw new DOMException('Остановлено','AbortError');
        stage='grid';message='Строим сетку для всей области…';sync();
        if(!await ensureGrid())throw new Error('Дождитесь восстановления зон или загрузите резервную копию.');
        const dest=destinations();if(cells.some(c=>!dest.has(c.organizationId)))throw new Error('Для части больниц не заданы координаты места приёма.');
        if(unsaved.size){if(await persist([...unsaved.values()])===false)throw new Error('Не удалось сохранить результаты в браузере.');unsaved.clear();}
        const all=[...new Map(A.pending(cells,dest,new Map(),O.MODES,options.osrm).map(j=>[j.key,j])).values()],queue=all.filter(j=>!records.has(j.key));
        total=all.length;done=total-queue.length;stage='routes';let cursor=0,failure=null,buffer=[],saving=Promise.resolve(),lastPaint=0;
        const flush=()=>{if(!buffer.length)return;const batch=buffer;buffer=[];saving=saving.then(async()=>{if(await persist(batch)===false)throw new Error('Не удалось сохранить результаты в браузере. Скачайте резервную копию.');for(const item of batch)unsaved.delete(item.key);}).catch(error=>{failure=failure||error;controller.abort();});};
        const progress=()=>{message=`Маршруты: ${done.toLocaleString('ru-RU')} / ${total.toLocaleString('ru-RU')} · ${Math.floor(done/Math.max(total,1)*100)}%`;sync();};progress();
        async function routeWorker(){while(!signal.aborted){const job=queue[cursor++];if(!job)return;
          try{
            const result=await O.requestRoute(options.osrm[job.mode],job,signal);
            const item=A.record({type:'route',organizationId:job.cell.organizationId,origin:job.cell.origin,destination:job.destination,mode:job.mode,...result,at:new Date().toISOString()},knownIds);
            if(!item)throw new Error('Некорректный ответ маршрутизатора.');records.set(item.key,item);unsaved.set(item.key,item);buffer.push(item);recordRevision++;done++;
            if(buffer.length>=50)flush();if(Date.now()-lastPaint>250){lastPaint=Date.now();progress();}
          }catch(error){if(error.name!=='AbortError')failure=failure||error;controller.abort();}
        }}
        await Promise.all(Array.from({length:4},routeWorker));flush();await saving;
        if(failure)throw failure;if(signal.aborted)throw new DOMException('Остановлено','AbortError');
        stage='fill';message='Заполняем оставшиеся ячейки по соседям…';fillStamp='';sync();
        const result=completedTimes();if(O.MODES.some(mode=>result.summary[mode].missing))throw new Error('Для полного заполнения нужны координаты всех больниц.');
        lastRun=true;done=total;message='Полный расчёт завершён. Все ячейки заполнены; результаты сохранены локально.';
      }catch(error){message=error.name==='AbortError'?'Расчёт остановлен. Найденные маршруты сохранены; повторный запуск продолжит оставшиеся.':'Расчёт приостановлен: '+error.message;}
      finally{running=false;controller=null;fillStamp='';drawStamp='';save();refresh();onChange();}
    }
    $('access-calculate').onclick=calculate;$('access-stop').onclick=()=>controller?.abort();
    $('access-step').onchange=()=>{options.step=Number($('access-step').value);gridError='';failedStamp='';lastRun=false;message='';selectedCell=null;save();refresh();onChange();};
    $('access-cell-close').onclick=()=>{$('access-cell-dialog').close();selectedCell=null;lineLayer?.removeAll();};
    document.querySelectorAll('[data-travel-mode]').forEach(button=>button.onclick=()=>{options.mode=button.dataset.travelMode;save();drawStamp='';refresh();if($('access-cell-dialog').open)showCell();});
    sync();
    return {refresh,stop:()=>controller?.abort(),get enabled(){return true;},get busy(){return running;},settings:()=>validateSettings(options),restoreSettings(value){controller?.abort();options=validateSettings(value);failedStamp='';gridError='';fillStamp='';save();refresh();},records:()=>[...records.values()],restore(values,{replace=false}={}){if(replace){records.clear();unsaved.clear();}for(const value of values||[]){const r=A.record(value,knownIds);if(r)records.set(r.key,r);}recordRevision++;fillStamp='';refresh();}};
  }
  root.HospitalAccessibilityUI={create,validateSettings,requestRoute,routeError,resourceName};
})(typeof window!=='undefined'?window:globalThis);
