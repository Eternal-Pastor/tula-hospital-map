(function(){
  'use strict';
  const $=id=>document.getElementById(id),A=window.HospitalAccessibility,O=window.HospitalRoutingOSRM,V=window.HospitalViewer,J=window.HospitalZoneJobs;
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmt=v=>Number.isFinite(v)?v.toLocaleString('ru-RU',{maximumFractionDigits:1}):'нет данных';
  const records=new Map(),rendered=new Set();
  let snapshot,hospitals,zones,destinations,baseline,cells=[],times=new Map(),map,ym,layer,markers,mode='travel',transport='auto',step=5000,selected=null,drawToken=0,controller=null,dbPromise,gridVersion=0,cancelGrid,ready=false;
  const storageKey='hospital-map-viewer-settings-v1';
  function fail(message,retry){$('viewer-error-text').textContent=message;$('viewer-error').hidden=false;$('viewer-retry').onclick=()=>{$('viewer-error').hidden=true;retry();};}
  async function unpack(){
    const pack=window.HospitalViewerData;if(!pack||pack.encoding!=='gzip-base64')throw new Error('Не удалось открыть сохранённую карту.');
    const bytes=Uint8Array.from(atob(pack.data),c=>c.charCodeAt(0));
    const json=await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
    const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(json));
    if([...new Uint8Array(digest)].map(v=>v.toString(16).padStart(2,'0')).join('')!==pack.checksum)throw new Error('Не удалось проверить сохранённую карту.');
    return JSON.parse(json);
  }
  function database(){
    if(!dbPromise)dbPromise=new Promise((resolve,reject)=>{const request=indexedDB.open('hospital-map-viewer-routes-v1-'+window.HospitalViewerData.checksum.slice(0,16),1);request.onupgradeneeded=()=>request.result.createObjectStore('routes',{keyPath:'key'});request.onsuccess=()=>resolve(request.result);request.onerror=()=>{dbPromise=null;reject(request.error);};});
    return dbPromise;
  }
  async function local(read,batch=[]){
    const db=await database();return new Promise((resolve,reject)=>{const transaction=db.transaction('routes',read?'readonly':'readwrite'),store=transaction.objectStore('routes'),request=read?store.getAll():null;if(!read)for(const item of batch)store.put(item);transaction.oncomplete=()=>resolve(request?.result);transaction.onerror=transaction.onabort=()=>reject(transaction.error||new Error('Не удалось сохранить расчёт.'));});
  }
  function save(){try{localStorage.setItem(storageKey,JSON.stringify({mode,transport,step,checksum:window.HospitalViewerData.checksum}));}catch(_){}}
  function fill(){times=V.complete(A,cells,baseline,destinations,records,snapshot.services);}
  function polygon(coordinates,properties,options){return new ym.Polygon(coordinates.map(r=>r.map(([lon,lat])=>[lat,lon])),properties,options);}
  const org=id=>hospitals.find(h=>h.id===id);
  const color=h=>mode==='load'?V.COLORS[V.loadBand(h.per1000)]:h.color;
  function showHospital(id){
    selected=id;const h=org(id);if(!h)return;
    $('viewer-detail').innerHTML=`<button class="icon-button detail-close" id="viewer-close-detail" aria-label="Закрыть карточку">×</button><h2>${esc(h.name)}</h2><dl class="viewer-metrics"><div><dt>Прикреплено на 1 000 жителей</dt><dd>${fmt(h.per1000)}</dd></div><div><dt>Зона обслуживания</dt><dd>${fmt(h.areaKm2)} км²</dd></div><div><dt>Плановая пропускная способность</dt><dd>${fmt(h.capacity)}${Number.isFinite(h.capacity)?' посещений / смену':''}</dd></div></dl>`;
    $('viewer-detail').hidden=false;$('viewer-close-detail').onclick=()=>{selected=null;$('viewer-detail').hidden=true;};
  }
  function legend(){
    $('viewer-calculation').hidden=mode!=='travel';$('viewer-travel-modes').hidden=mode!=='travel';
    $('viewer-legend-title').textContent={travel:'Среднее время пути',zones:'Зоны прикрепления больниц',load:'Прикреплено на 1 000 жителей'}[mode];
    const bands=mode==='travel'?[[A.COLORS[0],'≤ 15 мин'],[A.COLORS[1],'15–30 мин'],[A.COLORS[2],'30–60 мин'],[A.COLORS[3],'> 60 мин']]:mode==='load'?[[V.COLORS.low,'0–<700'],[V.COLORS.middle,'700–1 000'],[V.COLORS.high,'> 1 000'],[V.COLORS.missing,'нет данных']]:[];
    $('viewer-legend-bands').innerHTML=bands.map(([c,label])=>`<span class="legend-band"><i class="dot" style="background:${c}"></i>${label}</span>`).join('');
    document.querySelectorAll('[data-mode]').forEach(b=>{const active=b.dataset.mode===mode;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));});
    document.querySelectorAll('[data-transport]').forEach(b=>{const active=b.dataset.transport===transport;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));});
    $('viewer-hospitals').innerHTML=hospitals.map(h=>`<button data-hospital="${esc(h.id)}"><i class="dot" style="background:${color(h)}"></i><span>${esc(h.name)}</span></button>`).join('');
    $('viewer-hospitals').querySelectorAll('button').forEach(b=>b.onclick=()=>showHospital(b.dataset.hospital));
  }
  async function draw(){
    if(!map||!ready)return;const token=++drawToken;legend();
    await J.chunks([...rendered],shape=>{layer.remove(shape);rendered.delete(shape);},{budget:4,cancelled:()=>token!==drawToken});if(token!==drawToken)return;
    markers.removeAll();
    for(const h of hospitals){const marker=new ym.Placemark(h.coords,{hintContent:esc(h.name)},{preset:'islands#dotIcon',iconColor:color(h),zIndex:500});marker.events.add('click',()=>showHospital(h.id));markers.add(marker);}
    const items=mode==='travel'?cells:[...zones].flatMap(([organizationId,parts])=>parts.map(geometry=>({organizationId,geometry})));
    await J.chunks(items,item=>{
      const h=org(item.organizationId),seconds=mode==='travel'?times.get(item.id)?.[transport]?.seconds:null,c=mode==='travel'?A.COLORS[A.band(seconds)]:color(h);
      const shape=polygon(item.geometry,{hintContent:esc(mode==='travel'?V.label(h.name,seconds):h.name)},{fillColor:c,fillOpacity:mode==='travel'?.5:.4,strokeColor:c,strokeWidth:mode==='travel'?.4:1,strokeOpacity:.8,zIndex:100});
      shape.events.add('click',()=>showHospital(h.id));layer.add(shape);rendered.add(shape);
    },{budget:4,cancelled:()=>token!==drawToken});
  }
  function fit(){if(map)map.setBounds([[52.7,35.8],[54.85,38.6]],{checkZoomRange:true,zoomMargin:45});}
  async function connect(){
    if(map)return;
    try{
      const ns='hospitalViewerMaps';ym=window[ns]||await new Promise((resolve,reject)=>{
        const script=document.createElement('script');script.src='https://api-maps.yandex.ru/2.1/?'+new URLSearchParams({apikey:window.HospitalViewerConfig.mapKey,lang:'ru_RU',ns});
        const timer=setTimeout(()=>{script.remove();reject(new Error('timeout'));},20000);
        script.onerror=()=>{clearTimeout(timer);script.remove();reject(new Error('network'));};script.onload=()=>{clearTimeout(timer);window[ns]?resolve(window[ns]):reject(new Error('API'));};document.head.append(script);
      });
      await new Promise(resolve=>ym.ready(resolve));map=new ym.Map('map',{center:[53.95,37.2],zoom:8,controls:['zoomControl','typeSelector']},{suppressMapOpenBlock:true});
      layer=new ym.GeoObjectCollection();markers=new ym.GeoObjectCollection();map.geoObjects.add(layer).add(markers);$('viewer-fit').disabled=false;$('viewer-fit').onclick=fit;$('viewer-loading').hidden=true;fit();await draw();
    }catch(_){$('viewer-loading').hidden=true;fail('Не удалось подключить карту. Проверьте подключение к интернету.',connect);}
  }
  async function changeGrid(next){
    const version=++gridVersion;step=next;$('viewer-step').value=step;$('viewer-calculate').disabled=true;save();
    cancelGrid?.();cancelGrid=null;
    try{
      if(step===snapshot.step)cells=snapshot.cells;
      else{
        const url=URL.createObjectURL(new Blob([window.HospitalAccessibilityWorkerSource],{type:'text/javascript'}));
        const result=await new Promise((resolve,reject)=>{const worker=new Worker(url),clean=()=>{worker.terminate();URL.revokeObjectURL(url);if(version===gridVersion)cancelGrid=null;};cancelGrid=()=>{clean();reject(new DOMException('Cancelled','AbortError'));};worker.onmessage=e=>{clean();e.data.error?reject(new Error(e.data.error)):resolve(e.data.result);};worker.onerror=()=>{clean();reject(new Error('grid'));};worker.postMessage({id:version,task:'grid',payload:{zones,step}});});
        if(version!==gridVersion)return;cells=result.cells;
      }
      fill();await draw();
    }catch(error){if(error.name!=='AbortError'&&version===gridVersion)fail('Не удалось построить сетку. Повторите попытку.',()=>changeGrid(next));}
    finally{if(version===gridVersion)$('viewer-calculate').disabled=false;}
  }
  function progress(count,total){$('viewer-progress-bar').max=Math.max(total,1);$('viewer-progress-bar').value=count;$('viewer-status').textContent=`${count.toLocaleString('ru-RU')} / ${total.toLocaleString('ru-RU')} · ${Math.round(count/Math.max(total,1)*100)}%`;}
  async function calculate(){
    if(controller)return;controller=new AbortController();const signal=controller.signal;$('viewer-calculate').disabled=true;$('viewer-step').disabled=true;$('viewer-stop').hidden=false;$('viewer-progress').hidden=false;
    const all=A.pending(cells,destinations,new Map(),['auto','pedestrian'],snapshot.services),queue=all.filter(j=>!records.has(j.key));let count=all.length-queue.length,cursor=0,error=null,buffer=[],saving=Promise.resolve();progress(count,all.length);
    const flush=()=>{if(!buffer.length)return;const batch=buffer;buffer=[];saving=saving.then(()=>local(false,batch)).catch(e=>{error=e;controller.abort();});};
    try{
      // Retry in-memory results after a previous local-storage failure too.
      await local(false,[...records.values()]);
      async function worker(){while(!signal.aborted){const job=queue[cursor++];if(!job)return;
        try{const result=await O.requestRoute(snapshot.services[job.mode],job,signal),record=A.record({type:'route',organizationId:job.cell.organizationId,origin:job.cell.origin,destination:job.destination,mode:job.mode,...result,lines:[],at:new Date().toISOString()},new Set(hospitals.map(h=>h.id)));
          if(!record)throw new Error('result');records.set(record.key,record);buffer.push(record);count++;if(buffer.length>=50)flush();progress(count,all.length);
        }catch(e){if(e.name!=='AbortError')error=e;controller.abort();}
      }}
      await Promise.all(Array.from({length:4},worker));flush();await saving;
      if(error)throw error;$('viewer-status').textContent=signal.aborted?'Остановлено':'Готово · 100%';
    }catch(_){$('viewer-status').textContent='Расчёт приостановлен. Результаты доступны на карте.';fail('Не удалось завершить расчёт. Проверьте, что локальный расчёт запущен.',calculate);}
    finally{fill();controller=null;$('viewer-calculate').disabled=false;$('viewer-step').disabled=false;$('viewer-stop').hidden=true;await draw().catch(()=>fail('Не удалось обновить карту.',draw));}
  }
  function tables(){
    $('viewer-table').innerHTML=hospitals.map(h=>`<tr><td><button data-table-hospital="${esc(h.id)}">${esc(h.name)}</button></td><td class="numeric">${fmt(h.per1000)}</td><td class="numeric">${fmt(h.areaKm2)}</td><td class="numeric">${fmt(h.capacity)}</td></tr>`).join('');
    $('viewer-table').querySelectorAll('button').forEach(b=>b.onclick=()=>{page('map');showHospital(b.dataset.tableHospital);});
  }
  function page(next){$('viewer-map-page').hidden=next!=='map';$('viewer-table-page').hidden=next!=='table';document.querySelectorAll('[data-page]').forEach(b=>{const active=b.dataset.page===next;b.classList.toggle('active',active);if(active)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');});if(next==='map'&&map)requestAnimationFrame(()=>map.container.fitToViewport());}
  async function init(){
    try{
      snapshot=await unpack();hospitals=snapshot.hospitals.slice().sort((a,b)=>a.name.localeCompare(b.name,'ru'));zones=new Map(snapshot.zones);destinations=new Map(hospitals.map(h=>[h.id,h.coords]));baseline=snapshot.cells;
      for(const r of snapshot.routes)records.set(r.key,r);
      try{for(const r of await local(true)){const valid=A.record(r,new Set(hospitals.map(h=>h.id)));if(valid&&Object.values(snapshot.services).includes(valid.routingService)&&destinations.get(valid.organizationId)?.every((v,i)=>v===valid.destination[i]))records.set(valid.key,valid);}}catch(_){}
      try{const saved=JSON.parse(localStorage.getItem(storageKey)||'null');if(saved?.checksum===window.HospitalViewerData.checksum){if(['travel','zones','load'].includes(saved.mode))mode=saved.mode;if(['auto','pedestrian'].includes(saved.transport))transport=saved.transport;if([5000,10000,20000].includes(saved.step))step=saved.step;}}catch(_){}
      ready=true;cells=snapshot.cells;fill();legend();tables();
      document.querySelectorAll('[data-mode]').forEach(b=>b.onclick=()=>{mode=b.dataset.mode;save();draw().catch(()=>fail('Не удалось обновить карту.',draw));legend();});
      document.querySelectorAll('[data-transport]').forEach(b=>b.onclick=()=>{transport=b.dataset.transport;save();draw().catch(()=>fail('Не удалось обновить карту.',draw));});
      document.querySelectorAll('[data-page]').forEach(b=>b.onclick=()=>page(b.dataset.page));
      $('viewer-step').onchange=()=>changeGrid(Number($('viewer-step').value));$('viewer-calculate').onclick=calculate;$('viewer-stop').onclick=()=>controller?.abort();
      if(step!==snapshot.step)await changeGrid(step);else $('viewer-calculate').disabled=false;
      await connect();
    }catch(_){$('viewer-loading').hidden=true;fail('Не удалось открыть сохранённую карту. Перезагрузите страницу.',()=>location.reload());}
  }
  init();
})();
