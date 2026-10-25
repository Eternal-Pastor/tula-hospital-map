(function () {
  'use strict';
  const data=window.HOSPITAL_DATA, C=window.HospitalCore, T=window.HospitalTerritories, L=window.HospitalLocalCache, J=window.HospitalZoneJobs, B=window.HospitalBackup;
  const $=id=>document.getElementById(id);
  const esc=v=>String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmt=(v,d=0)=>v===null||v===undefined?'нет данных':Number(v).toLocaleString('ru-RU',{maximumFractionDigits:d});
  const defaults={selectedOrganization:null,showZones:true,showAddressPoints:false,fullCoverage:false,mapColor:'organization',metric:'per1000',includeMixed:false,showEmpty:false,populationLinks:{},populationValues:{},coordinates:{},coordinateVersions:{},geojson:[]};
  let settings={...defaults}, selected=null, map=null, ym=null, sessionKey='', geoKey='', routingKey='', loadedKey='', busy=false, cancelRequested=false, toastTimer,bulkActive=false,cacheProblem=null,cacheReady=Promise.resolve();
  let orgLayer,ruleLayer,geometryLayer,zoneLayer, bounds;
  const zoneGeometryCache=new Map();let addressRevision=0,requestedRevision=-1,requestedGeometry=null,partitionRevision=0,fitPending=false,mapEpoch=0,zoneDrawing=false,mapDrawError='';
  let partitionResult={zones:new Map(),sharedAnchors:0,importedConflicts:0};
  let savedZoneSnapshot=null,zoneSnapshotInput=null,zoneStorageState='loading',zoneSource='',localLoaded=false;
  let savedCoverageSnapshot=null,coverageResult=null,coverageInput=null,coverageSignature='',coverageError='',coverageProgress=null,coverageStarted=0,coverageUpdated=0,coverageTimer=null,coverageSaving=false,coverageResetting=false;
  let mapLoadState='waiting',restoreDrawn=0,restoreTotal=0,restoreVectorsReady=false;
  let calculationProgress=null,calculationStarted=0,calculationUpdated=0,calculationTimer=null;
  const layerStamps={},layerTokens={},layerPromises={},activeRequests=new Set();
  const orgLocations=new Map(), geocodeCache=new Map(), ruleLocations=new Map(), ruleAttempts=new Set(), ruleFailures=new Map();
  const territoryIndex=T.index(data),organizationColors=T.colors(data.organizations.map(o=>o.id));
  const partitionJobs=J.create({
    makeWorker:()=>{
      const url=URL.createObjectURL(new Blob([window.HospitalZoneWorkerSource],{type:'text/javascript'}));
      const worker=new Worker(url);const release=()=>URL.revokeObjectURL(url);
      worker.addEventListener('message',release,{once:true});worker.addEventListener('error',release,{once:true});return worker;
    },
    onResult:async message=>{
      partitionResult=message.error?{...partitionResult,error:message.error}:message.result;partitionRevision++;
      if(zoneSnapshotInput?.key===message.key)restoreVectorsReady=!message.error;
      if(!message.error&&zoneSnapshotInput?.key===message.key){
        savedZoneSnapshot=L.zoneSnapshot(zoneSnapshotInput.signature,message.result);zoneSource='calculated';zoneStorageState='saving';
        persistLocal([savedZoneSnapshot]).then(ok=>{zoneStorageState=ok?'saved':'failed';showCacheStatus();updateTopologyNote();});
      }
      if(!$('bulk-progress').hidden)updateBulkProgress();
      if(selected)renderDetail(getOrg(selected));await renderMap();
      if(fitPending){fitPending=false;fitMap(false);}
    },
    onProgress:message=>{if(zoneSnapshotInput?.key!==message.key)return;calculationProgress=message.progress;calculationUpdated=Date.now();updateRestoreProgress();},
    onError:error=>{partitionResult={...partitionResult,error:String(error.message||error)};partitionRevision++;renderMap();},
    onStatus:()=>{updateTopologyNote();if(!$('bulk-progress').hidden)updateBulkProgress();accessibility.refresh();
      if(partitionJobs.busy&&!calculationTimer){calculationStarted=calculationUpdated=Date.now();calculationTimer=setInterval(updateRestoreProgress,1000);}
      if(!partitionJobs.busy&&calculationTimer){clearInterval(calculationTimer);calculationTimer=null;}
      updateRestoreProgress();if(localLoaded&&!partitionJobs.busy)renderMap();}
  });
  const coverageJobs=J.create({
    makeWorker:()=>{const url=URL.createObjectURL(new Blob([window.HospitalZoneWorkerSource],{type:'text/javascript'})),worker=new Worker(url);worker.addEventListener('message',()=>URL.revokeObjectURL(url),{once:true});worker.addEventListener('error',()=>URL.revokeObjectURL(url),{once:true});return worker;},
    onResult:async message=>{
      if(message.key!==coverageInput?.key)return;
      if(message.error){coverageError=message.error;return;}
      coverageResult=message.result;partitionRevision++;
      savedCoverageSnapshot={...L.zoneSnapshot(coverageInput.signature,coverageResult),key:'geometry:coverage-v1'};
      coverageSaving=true;await persistLocal([savedCoverageSnapshot]);coverageSaving=false;
      if(!$('bulk-progress').hidden)updateBulkProgress();
      if(selected)renderDetail(getOrg(selected));await renderMap();
      if(map)fitMap(false);
    },
    onProgress:message=>{if(message.key===coverageInput?.key){coverageProgress=message.progress;coverageUpdated=Date.now();updateCoverageStatus();}},
    onError:error=>{coverageError=String(error.message||error);updateCoverageStatus();},
    onStatus:()=>{
      if(coverageJobs.busy&&!coverageTimer)coverageTimer=setInterval(updateCoverageStatus,1000);
      if(!coverageJobs.busy&&coverageTimer){clearInterval(coverageTimer);coverageTimer=null;}
      updateCoverageStatus();if(localLoaded&&!coverageJobs.busy&&!coverageResetting)renderMap();
    }
  });
  const PAGE_SIZE=75;let page=0,currentTable={headers:[],rows:[],description:''};
  try {const saved=JSON.parse(localStorage.getItem('hospital-map-settings')||'null');if(saved) settings=validateSettings(saved);} catch (_) {}
  selected=settings.selectedOrganization;
  settings.showEmpty=true;settings.showZones=true;settings.showAddressPoints=false;selected=null;settings.selectedOrganization=null;

  const accessibility=window.HospitalAccessibilityUI.create({
    context:()=>({map,ym,routingKey,epoch:mapEpoch,zones:activePartition().zones,revision:partitionRevision,pending:partitionJobs.busy||settings.fullCoverage&&coverageJobs.busy,organizations:data.organizations,selected,visible:listed().map(o=>o.id),destinations:new Map(data.organizations.map(o=>[o.id,locationFor(o.id)?.coords]))}),
    persist:persistLocal,notify:toast,onChange:()=>renderMap(),download,beforeRun:prepareFullCalculation,
    onRoutingKeyRequired:()=>{$('access-cell-dialog').close();openSettings();$('key-status').textContent='Для расчёта маршрутов заполните третье поле: «Ключ API получения деталей маршрута». Ключ карты и ключ геокодера его не заменяют.';$('routing-key').focus();}
  });
  async function prepareFullCalculation(signal){
    await cacheReady;
    settings.showEmpty=true;settings.showZones=true;$('org-search').value='';selected=null;$('detail-panel').hidden=true;
    if(!settings.fullCoverage)await enableCoverage({forCalculation:true});
    if(!settings.fullCoverage)throw new Error('Не удалось подготовить полное покрытие. Проверьте локальное сохранение.');
    const started=Date.now();renderMap();
    while(partitionJobs.busy||coverageJobs.busy||!coverageResult){
      if(signal.aborted)throw new DOMException('Остановлено','AbortError');
      if(coverageError||partitionResult.error)throw new Error(coverageError||partitionResult.error);
      if(Date.now()-started>180000)throw new Error('Подготовка границ занимает слишком много времени. Можно повторить запуск без потери данных.');
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    save();render();
  }

  function validateSettings(s) {
    if(!s || typeof s!=='object')throw new Error('Некорректный файл настроек.');
    const out={...defaults,populationLinks:{},populationValues:{},coordinates:{},coordinateVersions:{},geojson:[]};
    if(data.organizations.some(o=>o.id===s.selectedOrganization))out.selectedOrganization=s.selectedOrganization;
    if(['absolute','perArea','per1000'].includes(s.metric))out.metric=s.metric;
    if(['load','organization'].includes(s.mapColor))out.mapColor=s.mapColor;
    out.showZones=s.showZones!==false;out.showAddressPoints=s.showAddressPoints===true;
    out.fullCoverage=s.fullCoverage===true;
    out.includeMixed=s.includeMixed===true;out.showEmpty=s.showEmpty===true;
    for(const [id,value] of Object.entries(s.populationValues||{})) {
      if(!data.populations.some(p=>p.id===id)||C.number(value)===null||value<=0)throw new Error('Недопустимая численность населения.');
      out.populationValues[id]=value;
    }
    for(const [id,value] of Object.entries(s.populationLinks||{})) {
      if(!data.organizations.some(o=>o.id===id)||value!==''&&!data.populations.some(p=>p.id===value))throw new Error('Неизвестная связь территории.');
      out.populationLinks[id]=value;
    }
    for(const [id,value] of Object.entries(s.coordinates||{})) {
      if(!data.organizations.some(o=>o.id===id)||!Array.isArray(value)||value.length!==2||value.some(v=>C.number(v)===null)||Math.abs(value[0])>90||Math.abs(value[1])>180)throw new Error('Некорректные координаты организации.');
      out.coordinates[id]=value;
      if(typeof s.coordinateVersions?.[id]==='string')out.coordinateVersions[id]=s.coordinateVersions[id];
    }
    if(s.geojson?.length)out.geojson=C.validateGeoJSON({type:'FeatureCollection',features:s.geojson},data.organizations.map(o=>o.id));
    return out;
  }
  function save() {settings.selectedOrganization=selected;try{localStorage.setItem('hospital-map-settings',JSON.stringify(settings));}catch(_){toast('Браузер не сохранил настройки. Можно скачать их в разделе «О данных».');}}
  function toast(message) {$('toast').textContent=message;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,6500);}
  function setMessage(message) {$('map-message').textContent=message;}
  function updateRestoreProgress(){
    const panel=$('restore-progress'),bar=$('restore-progress-bar');if(!panel)return;
    const error=cacheProblem||partitionResult.error||mapDrawError;
    let title,label,complete=0,indeterminate=false;
    if(error){title='Восстановление приостановлено';label=String(error);}
    else if(!localLoaded){title='Восстановление · этап 1 из 4';label='Читаем сохранённые адреса и векторы из IndexedDB…';indeterminate=true;}
    else if(!restoreVectorsReady||requestedRevision!==addressRevision){
      title='Восстановление · этап 2 из 4';indeterminate=true;complete=1;
      const names={prepare:'Подготовка больниц',imports:'Проверка загруженных границ',overlaps:'Поиск перекрывающихся зон',triangulation:'Построение триангуляции адресов',cells:'Построение адресных ячеек',merge:'Объединение фрагментов больниц',cleanup:'Удаление остаточных пересечений',gap:'Разделение границ',verify:'Итоговая проверка отсутствия наложений',done:'Подготовка готовых векторов'};
      const p=calculationProgress,elapsed=calculationStarted?Math.floor((Date.now()-calculationStarted)/1000):0,quiet=calculationUpdated?Math.floor((Date.now()-calculationUpdated)/1000):0;
      label=p?(names[p.stage]||'Расчёт зон')+(p.organizationId?' · '+(getOrg(p.organizationId)?.shortName||p.organizationId):'')+(p.total?' · '+fmt(p.completed)+' / '+fmt(p.total):''):'Запускаем построение векторов по сохранённым адресам…';
      if(p?.operation==='clip-cells')label+=` · обрезка ячеек ${fmt(p.fragmentCompleted)} / ${fmt(p.fragmentTotal)}`;
      if(p?.operation==='trace-edges')label+=` · сборка границ: ячейки ${fmt(p.fragmentCompleted)} / ${fmt(p.fragmentTotal)}`;
      if(p?.operation==='trace-rings')label+=` · сшивание рёбер ${fmt(p.edgeCompleted)} / ${fmt(p.edgeTotal)}`;
      if(p?.operation==='clip-outline')label+=' · обрезка готовой границы';
      if(p?.operation==='batch-union')label+=` · проход ${p.pass}, пакеты ${fmt(p.batchCompleted)} / ${fmt(p.batchTotal)}`;
      label+=` · прошло ${elapsed} с · без обновлений ${quiet} с.`;
      if(quiet>=30)label+=' Новых сообщений от расчёта нет; текущая операция может ещё выполняться. Можно перезапустить её без потери адресов.';
    }
    else if(!map||mapLoadState==='loading'){title='Восстановление · этап 3 из 4';label=mapLoadState==='loading'?'Подключаем Яндекс Карты…':mapLoadState==='error'?'Карта не подключена. Повторите подключение в настройках.':'Локальные данные готовы. Подключите карту для отображения векторов.';complete=2;indeterminate=mapLoadState==='loading';}
    else if(zoneDrawing){title='Восстановление · этап 4 из 4';label=`Отрисовка фрагментов зон: ${fmt(restoreDrawn)} / ${fmt(restoreTotal)}${restoreTotal?' · '+Math.floor(restoreDrawn/restoreTotal*100)+'%':''}`;complete=3;}
    else {title='Восстановление завершено · 100%';label=!settings.showZones?'Векторы восстановлены. Слой «Векторные зоны» выключен.':!restoreTotal&&partitionResult.zones.size?'Нет видимых зон: проверьте фильтры организаций.':!partitionResult.zones.size?'Сохранённых векторных зон пока нет.':`На карту добавлено фрагментов: ${fmt(restoreDrawn)} / ${fmt(restoreTotal)}. Геокодер не вызывался.`;complete=4;}
    $('restore-progress-title').textContent=title;$('restore-progress-label').textContent=label;
    $('restore-progress-counts').textContent=localLoaded?`Адресов: ${fmt(ruleLocations.size)} · векторных зон: ${fmt(activePartition().zones.size)}`:'';
    panel.classList.toggle('restore-complete',complete===4);panel.classList.toggle('restore-error',Boolean(error)||mapLoadState==='error');
    $('restart-zone-calculation').hidden=!(localLoaded&&(partitionResult.error||!restoreVectorsReady&&calculationStarted&&Date.now()-calculationUpdated>=30000));
    if(complete===1&&['clip-cells','trace-edges'].includes(calculationProgress?.operation)){bar.max=Math.max(calculationProgress.fragmentTotal,1);bar.value=calculationProgress.fragmentCompleted;indeterminate=false;}
    else if(complete===1&&calculationProgress?.operation==='trace-rings'){bar.max=Math.max(calculationProgress.edgeTotal,1);bar.value=calculationProgress.edgeCompleted;indeterminate=false;}
    else if(complete===1&&calculationProgress?.operation==='clip-outline'){indeterminate=true;}
    else if(complete===1&&calculationProgress?.operation==='batch-union'){bar.max=Math.max(calculationProgress.batchTotal,1);bar.value=calculationProgress.batchCompleted;indeterminate=false;}
    else if(complete===1&&calculationProgress?.total>0&&calculationProgress.stage!=='triangulation'){bar.max=calculationProgress.total;bar.value=calculationProgress.completed;indeterminate=false;}
    if(indeterminate)bar.removeAttribute('value');
    else if(complete!==1||!calculationProgress?.total){bar.max=zoneDrawing?Math.max(restoreTotal,1):4;bar.value=zoneDrawing?restoreDrawn:complete;}
    bar.setAttribute('aria-valuetext',title+'. '+label);
  }
  function localRecords() {
    const records=[];
    for(const groups of territoryIndex.byOrganization.values())for(const group of groups){
      const record=L.recordForGroup(group,ruleLocations,ruleAttempts,ruleFailures);if(record)records.push(record);
    }
    for(const organization of data.organizations){const record=L.recordForOrganization(organization,orgLocations.get(organization.id));if(record)records.push(record);}
    return [...records,...accessibility.records(),...(savedZoneSnapshot?[savedZoneSnapshot]:[]),...(savedCoverageSnapshot?[savedCoverageSnapshot]:[])];
  }
  function showCacheStatus() {
    const vectorStatus=(zoneStorageState==='saved'?` Готовых исходных векторных зон: ${savedZoneSnapshot?.zones.length||0}.`:zoneStorageState==='saving'?' Сохраняем готовые векторы…':zoneStorageState==='failed'?' Готовые векторы не удалось сохранить.':'')+(savedCoverageSnapshot?` Зон полного покрытия: ${savedCoverageSnapshot.zones.length}.`:'');
    const message=(cacheProblem?'Локальное сохранение недоступно: '+cacheProblem+'. Скачайте резервную копию данных.':`Сохранено в этом браузере: ${fmt(ruleLocations.size)} адресов, ${fmt(ruleAttempts.size)} неподтверждённых. Положений больниц: ${fmt(data.organizations.filter(o=>locationFor(o.id)).length)}; из файла пользователя: ${fmt(data.organizations.filter(o=>o.location).length)}.`)+vectorStatus;
    $('local-data-status').textContent=message;$('local-cache-status').textContent=message;$('retry-cache').hidden=!cacheProblem;
    updateRestoreProgress();
  }
  async function persistLocal(records) {
    try {await L.write(records.filter(Boolean));showCacheStatus();return true;}
    catch(error){if(!cacheProblem)toast('Не удалось сохранить результаты локально. Подробности в разделе «О данных».');cacheProblem=String(error.message||error);showCacheStatus();return false;}
  }
  function persistGroup(group){if(ruleLocations.has(group.id))addressRevision++;return persistLocal([L.recordForGroup(group,ruleLocations,ruleAttempts,ruleFailures)]);}
  function applyLocal(restored) {
    if(restored.locations.size)addressRevision++;
    for(const [id,result] of restored.locations){ruleLocations.set(id,result);ruleAttempts.delete(id);ruleFailures.delete(id);geocodeCache.set(T.normalizeAddress('Тульская область, '+result.address),result);}
    for(const id of restored.attempts)if(!ruleLocations.has(id)){ruleAttempts.add(id);ruleFailures.set(id,restored.failures.get(id));}
    for(const [id,result] of restored.orgLocations){orgLocations.set(id,result);geocodeCache.set(T.normalizeAddress(getOrg(id).mapQuery),result);}
  }
  async function restoreLocal() {
    updateRestoreProgress();
    $('local-data-status').textContent='Загружаем сохранённые адреса…';
    try {const records=await L.read();savedZoneSnapshot=records.find(r=>r.key==='geometry:zones-v1')||null;savedCoverageSnapshot=records.find(r=>r.key==='geometry:coverage-v1')||null;applyLocal(L.restore(records,data,territoryIndex));accessibility.restore(records);zoneStorageState=savedZoneSnapshot?'saved':'missing';}
    catch(error){cacheProblem=String(error.message||error);}
    localLoaded=true;showCacheStatus();render();showCacheStatus();
    if(ruleLocations.size||ruleAttempts.size||orgLocations.size){
      updateBulkProgress('Восстановлено. ');
      $('cached-placeholder').textContent=`Восстановлено локально: ${fmt(ruleLocations.size)} адресов. Положений больниц: ${fmt(data.organizations.filter(o=>locationFor(o.id)).length)}. Подключите Яндекс Карты — зоны появятся без повторного поиска.`;
      setMessage(`Восстановлено ${fmt(ruleLocations.size)} адресов из локального хранилища. Повторный поиск для них не нужен.`);
    }
  }
  async function retryLocalSave(){
    await cacheReady;
    try {await L.write(localRecords());cacheProblem=null;if(savedZoneSnapshot)zoneStorageState='saved';showCacheStatus();toast('Все текущие результаты сохранены локально.');}
    catch(error){cacheProblem=String(error.message||error);showCacheStatus();}
  }
  function metricLabel() {return {absolute:'прикреплённых',perArea:'прикреплённых на запись участка',per1000:'прикреплённых на 1 000 жителей'}[settings.metric];}
  function value(o) {return C.metric(o,settings.metric,data,settings);}
  function band(o) {return C.band(value(o),bounds);}
  function colorFor(o) {return settings.mapColor==='organization'?organizationColors[o.id]:C.COLORS[band(o)];}
  function getOrg(id) {return data.organizations.find(o=>o.id===id);}
  function listed() {
    const query=$('org-search').value.trim().toLocaleLowerCase('ru');
    return data.organizations.filter(o=>(settings.showEmpty||o.attached!==null)&&(!query||[o.name,o.shortName,...o.aliases].join(' ').toLocaleLowerCase('ru').includes(query))).sort((a,b)=>(value(b)??-1)-(value(a)??-1)||a.shortName.localeCompare(b.shortName,'ru'));
  }
  function showView(name) {
    for(const n of ['map','table','about'])$(n+'-view').hidden=n!==name;
    document.querySelectorAll('[data-view]').forEach(b=>{b.classList.toggle('active',b.dataset.view===name);if(b.dataset.view===name)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');});
    if(name==='map'&&map)requestAnimationFrame(()=>map.container.fitToViewport());
    if(name==='table')renderTable();
  }
  function render() {
    bounds=C.scale(data,settings);
    $('detail-panel').hidden=!selected;
    $('show-zones').checked=settings.showZones;$('show-address-points').checked=settings.showAddressPoints;$('map-color').value=settings.mapColor;$('metric').value=settings.metric;$('include-mixed').checked=settings.includeMixed;$('show-empty').checked=settings.showEmpty;
    $('metric-description').textContent=settings.metric==='per1000'?'Взрослые прикреплённые / всё население территории × 1 000. Население справочное, границы требуют проверки.':settings.metric==='perArea'?'Среднее по записям терапевтических участков. Число работающих врачей неизвестно.':'Сумма численности из исходной книги. Показатель не учитывает мощность приёма.';
    const orgs=listed();$('org-count').textContent=orgs.length;
    $('org-list').innerHTML=orgs.length?orgs.map(o=>`<button class="org-item ${selected===o.id?'selected':''}" data-org="${esc(o.id)}"><span class="dot" style="background:${colorFor(o)}"></span><span><span class="org-name">${esc(o.shortName)}</span><span class="org-meta"><span>${o.areas.length?fmt(C.attachedFor(o,settings.includeMixed))+' чел.':'Численность не указана'}</span><span class="org-value">${fmt(value(o),1)}</span></span></span></button>`).join(''):'<p class="empty">Организации не найдены. Измените поиск или фильтры.</p>';
    document.querySelectorAll('[data-org]').forEach(b=>b.addEventListener('click',()=>selectOrg(b.dataset.org)));
    const items=bounds.count?[['low','≤ '+fmt(bounds.low,2)],['middle','> '+fmt(bounds.low,2)+' — ≤ '+fmt(bounds.high,2)],['high','> '+fmt(bounds.high,2)],['missing','нет данных']]:[['missing','нет данных']];
    $('legend-bands').innerHTML=items.map(([b,t])=>`<span class="legend-band"><i class="dot" style="background:${C.COLORS[b]}"></i>${esc(t)}</span>`).join('');
    $('legend-note').textContent=`${metricLabel()}. Границы по ${bounds.count} организациям. ${settings.includeMixed?'Смешанные категории включены.':'Категория «взрослые, дети» исключена.'}`;
    $('legend-heading').textContent=settings.mapColor==='organization'?'Больница закрепления':'Относительная численность';
    $('legend-caption').textContent=settings.mapColor==='organization'?'Один цвет — одна организация':'Цвет не означает перегрузку';
    if(settings.mapColor==='organization') {
      const o=selected?getOrg(selected):null;
      $('legend-bands').innerHTML=o?`<span class="legend-band"><i class="dot" style="background:${organizationColors[o.id]}"></i>${esc(o.shortName)}</span>`:'';
      $('legend-note').textContent='Цвет различает больницы. Контур строится по найденным адресам. Выберите больницу и загрузите её адреса.';
    }
    $('territory-summary').textContent=`В источнике: ${territoryIndex.organizationCount} зон больниц. В списке: ${orgs.filter(o=>o.territories.length).length}. Для остальных включите организации без численности.`;
    if(selected)renderDetail(getOrg(selected));
    renderMap();renderTable();save();
  }
  function selectOrg(id) {selected=id;render();const loc=locationFor(id);if(map&&loc)map.setCenter(loc.coords,['manual','provided'].includes(loc.kind)?14:12,{duration:250});}
  function populationOptions(id) {return '<option value="">Не выбрана</option>'+data.populations.map(p=>`<option value="${p.id}" ${p.id===id?'selected':''}>${esc(p.type+': '+p.name)}</option>`).join('');}
  function renderDetail(o) {
    if(!o)return;
    const panel=$('detail-panel');panel.hidden=false;
    const p=C.populationFor(o,data,settings),loc=locationFor(o.id),mixed=o.mixedAttached||0;
    const colocated=loc?data.organizations.filter(other=>other.id!==o.id&&locationFor(other.id)?.coords.every((v,i)=>v===loc.coords[i])):[];
    const groups=territoryIndex.byOrganization.get(o.id)||[],zone=T.coverage(groups,ruleLocations,ruleAttempts);
    const plannedCapacity=o.capacity.length&&o.capacity.every(b=>C.number(b.total)!==null)?o.capacity.reduce((sum,b)=>sum+b.total,0):null;
    const ring=zoneRing(o.id);
    const importedOutline=settings.geojson.some(f=>f.properties.organizationId===o.id&&f.geometry.type!=='Point');
    const partition=zonePartition(),hasZone=partition.zones.has(o.id);
    const outlineStatus=partition.pending?'Границы обновляются в фоне. Уже построенная версия остаётся на карте.':partition.coverage?'Единая расширенная зона: пустые территории добавлены по ближайшей больнице. Внутренняя граница расширения не показывается. Дополнительное население не приписывается.':partition.error?'Контуры временно скрыты: '+partition.error:importedOutline?(hasZone?'Загруженный контур показан без пересечений с другими зонами.':'Загруженный контур полностью попал в спорную область и не окрашен.'):hasZone?`Зона без наложений: по ${zone.found} из ${zone.total} адресов (${fmt(zone.found/zone.total*100,1)}%). Граница разделена по закреплённым адресным ориентирам.`:ring?'Контур не окрашен: найденных координат недостаточно для однозначного разделения с соседями. Адресные правила сохранены.':'Для векторного контура нужны минимум 3 найденных адреса, не лежащие на одной прямой.';
    const sharedCount=groups.filter(g=>territoryIndex.byAddress.get(g.key).length>1).length;
    const metricValue=value(o),warning=[];
    if(p && C.attachedFor(o,settings.includeMixed)>p.value)warning.push('Прикреплённых больше, чем жителей выбранной территории. Проверьте границы, дату населения и привязку организации: показатель не является долей охвата.');
    if(o.duplicateAreaCount)warning.push(`${o.duplicateAreaCount} записей с повторяющимися номерами участков — требуют уточнения.`);
    if(mixed&&!settings.includeMixed)warning.push(`${fmt(mixed)} прикреплённых из смешанных категорий исключены из показателя.`);
    if(o.attached===null)warning.push('В исходной книге нет записей терапевтических участков для этой организации. Это не означает нулевое прикрепление.');
    panel.innerHTML=`<button class="icon-button detail-close" id="close-detail" aria-label="Закрыть карточку">×</button><p class="eyebrow">ОРГАНИЗАЦИЯ</p><h2>${esc(o.shortName)}</h2><span class="badge"><i class="dot" style="background:${colorFor(o)};margin:0 5px 0 0"></i>${fmt(metricValue,1)} ${esc(metricLabel())}</span><div class="stats-grid"><div><div class="stat-value">${fmt(C.attachedFor(o,settings.includeMixed))}</div><div class="stat-label">прикреплено по выбранным категориям</div></div><div><div class="stat-value">${o.areas.length?o.areas.filter(a=>settings.includeMixed||a.category==='Взрослые').length:'—'}</div><div class="stat-label">записей терапевтических участков</div></div></div>${warning.length?'<p class="notice">'+warning.map(esc).join('<br>')+'</p>':''}
      <div class="detail-section"><h3>Территория для поправки на население</h3><label for="detail-population">Город или район</label><select id="detail-population">${populationOptions(p?.id||'')}</select>${p?`<label for="population-value">Население территории, человек</label><input id="population-value" type="number" min="1" step="1" value="${p.value||''}"><button id="save-population" class="button secondary">Применить численность</button><p class="coordinate-note">Данные пользователя, дата не указана. Привязка территории предварительная. Город и район не суммируются.</p>`:'<p class="small muted">Выберите территорию, чтобы включить организацию в относительную шкалу.</p>'}</div>
      <div class="detail-section"><h3>Зона обслуживания больницы</h3><p>${fmt(o.territoryRuleCount)} правил домов · ${fmt(zone.total)} улиц и населённых пунктов</p><p class="coordinate-note">По адресным спискам DOCX для взрослого и смешанного населения. Полигональных границ в источнике нет.</p><p id="polygon-status" class="coordinate-note">${esc(outlineStatus)}</p><p class="zone-progress">Найдено ${zone.found} из ${zone.total}. Не подтверждено: ${zone.failed}. Осталось: ${zone.remaining}.</p>${sharedCount?`<p class="notice">${sharedCount} адресов встречаются и у других больниц. Дома могут быть разделены диапазонами или чётностью; список сохраняет эти правила.</p>`:''}<div class="button-row"><button id="show-rules" class="button secondary" ${!map||!zone.remaining||busy||!$('allow-geocoder').checked?'disabled':''}>Найти следующие 20 адресов</button><button id="fit-zone" class="button secondary" ${!map||!zone.found?'disabled':''}>Показать найденную часть зоны</button><button id="open-addresses" class="button secondary">Улицы и дома зоны</button>${zone.failed?`<button id="review-rules" class="button secondary">Неподтверждённые адреса</button><button id="retry-rules" class="button secondary" ${busy?'disabled':''}>Повторить ненайденные</button>`:''}</div></div>
      <div class="detail-section"><h3>Положение на карте</h3><p class="small">${esc(o.mapQueryType)}</p><p class="coordinate-note">${esc(o.mapQuery||'Адрес не указан в файле; положение задано координатами.')}</p>${loc?`<p class="coordinate-note">${esc(loc.label)}<br>${fmt(loc.coords[0],6)}, ${fmt(loc.coords[1],6)}</p><p class="coordinate-note">Эта точка используется для маркера и конечной точки маршрутов.</p>`:'<p class="coordinate-note">Координаты ещё не получены.</p>'}${colocated.length?`<p class="notice">Та же точка указана для: ${colocated.map(other=>esc(other.shortName)).join('; ')}. Организации и их зоны сохранены отдельно.</p>`:''}<button id="locate-one" class="button secondary" ${!map||busy||!loc&&!$('allow-geocoder').checked?'disabled':''}>${loc?'Показать больницу':'Найти на карте'}</button><details style="margin-top:12px"><summary>Указать проверенные координаты</summary><div class="inline-fields"><div><label for="manual-lat">Широта</label><input id="manual-lat" type="number" step="any" min="-90" max="90" value="${loc?.coords[0]??''}"></div><div><label for="manual-lon">Долгота</label><input id="manual-lon" type="number" step="any" min="-180" max="180" value="${loc?.coords[1]??''}"></div></div><button id="save-coordinates" class="button secondary">Применить координаты</button>${o.location&&loc?.kind==='manual'?'<button id="reset-coordinates" class="button secondary">Вернуть координаты из файла</button>':''}</details></div>
      <div class="detail-section"><h3>Плановая пропускная способность</h3><p><strong>${fmt(plannedCapacity)} посещений / смену</strong></p>${o.capacity.length?'<ul class="mini-list">'+o.capacity.map(b=>`<li><span>${esc(b.branch)}</span><strong>${fmt(b.total)} / смену</strong></li>`).join('')+'</ul>':'<p class="small muted">Однозначного сопоставления с формой мощности нет.</p>'}<p class="coordinate-note">Для обобщённой модели: сумма плановой мощности сопоставленных подразделений по всем профилям, форма 30 на 01.01.2026. Число смен и спрос пока не заданы, загрузка не рассчитана. Проверьте состав филиалов и соответствие зоне обслуживания.</p></div>
      <div class="detail-section"><h3>Записи участков</h3>${o.areas.length?'<ul class="mini-list">'+o.areas.slice(0,6).map(a=>`<li><span>${esc(a.number)}${a.duplicate?' · повтор номера':''}</span><strong>${fmt(a.attached)}</strong></li>`).join('')+'</ul><button id="open-areas" class="link-button">Все записи участков</button>':'<p class="small muted">Нет записей терапевтических участков.</p>'}<p class="coordinate-note">ID организации для импорта: ${esc(o.id)}</p></div>`;
    $('close-detail').onclick=()=>{selected=null;panel.hidden=true;render();};
    $('detail-population').onchange=e=>{settings.populationLinks[o.id]=e.target.value;render();};
    if($('save-population'))$('save-population').onclick=()=>{const v=Number($('population-value').value);if(!Number.isSafeInteger(v)||v<=0)return toast('Введите положительное целое число жителей.');settings.populationValues[p.id]=v;render();toast('Численность изменена. Цветовые границы пересчитаны.');};
    $('open-addresses').onclick=()=>openTable('territories',o.id);
    if($('open-areas'))$('open-areas').onclick=()=>openTable('areas',o.id);
    $('locate-one').onclick=()=>locateOrganizations([o]);
    $('show-rules').onclick=()=>locateRules(o);
    $('fit-zone').onclick=()=>fitZone(o.id);
    if($('review-rules'))$('review-rules').onclick=()=>{openTable('territories',o.id);$('table-search').value='Не подтверждено';renderTable();};
    if($('retry-rules'))$('retry-rules').onclick=async()=>{
      if(busy)return;setBusy(true);
      const pending=groups.filter(g=>ruleAttempts.has(g.id)&&!ruleLocations.has(g.id));
      await persistLocal(pending.map(g=>({key:'rule:'+g.id,type:'rule',id:g.id,status:'pending'})));
      pending.forEach(g=>{ruleAttempts.delete(g.id);ruleFailures.delete(g.id);});showCacheStatus();setBusy(false);locateRules(o);
    };
    $('save-coordinates').onclick=()=>{const a=$('manual-lat').value,b=$('manual-lon').value,lat=Number(a),lon=Number(b);if(!a||!b||!Number.isFinite(lat)||!Number.isFinite(lon)||Math.abs(lat)>90||Math.abs(lon)>180)return toast('Укажите корректные широту и долготу.');settings.coordinates[o.id]=[lat,lon];if(o.location)settings.coordinateVersions[o.id]=o.location.version;render();if(map)map.setCenter([lat,lon],14);toast('Сохранены координаты, введённые пользователем.');};
    if($('reset-coordinates'))$('reset-coordinates').onclick=()=>{delete settings.coordinates[o.id];delete settings.coordinateVersions[o.id];render();if(map)map.setCenter(o.location.coords,14);};
  }
  function openTable(kind,id='') {$('table-kind').value=kind;$('table-org').value=id;$('table-search').value='';page=0;showView('table');}
  function tableData() {
    const kind=$('table-kind').value,orgId=$('table-org').value;
    const orgs=data.organizations.filter(o=>!orgId||o.id===orgId);
    let headers,rows,description;
    if(kind==='organizations') {
      headers=['Организация','Прикреплено','Записей участков','Территория населения','Население','Показатель','ID','Широта','Долгота','Адрес объекта'];
      rows=orgs.map(o=>{const p=C.populationFor(o,data,settings),loc=locationFor(o.id);return [o.shortName,C.attachedFor(o,settings.includeMixed),o.areas.length||null,p?.name||'Не выбрана',p?.value??null,value(o),o.id,loc?.coords[0]??null,loc?.coords[1]??null,o.location?.address||'Не указан'];});
      description='Показатель: '+metricLabel()+'. Отсутствующая численность не заменяется нулём. Числа отражают записи исходной книги; повторы номеров не удалены.';
    } else if(kind==='areas') {
      headers=['Организация','Участок','Категория','Прикреплено','Замечание','Источник'];
      rows=orgs.flatMap(o=>o.areas.map(a=>[o.shortName,a.number,a.category,a.attached,a.duplicate?'Повтор номера внутри организации':'',`Исходные данные.xlsx · Лист1 · строка ${a.sourceRow}`]));
      description='Все 560 исходных записей терапевтических участков, включая смешанные категории. Фильтр категорий влияет на окраску карты, но не удаляет исходные строки из этой таблицы.';
    } else if(kind==='territories') {
      headers=['Больница','Улица / населённый пункт','Правила домов','Также в зоне других больниц','Проверка координат','Источник'];
      rows=orgs.flatMap(o=>(territoryIndex.byOrganization.get(o.id)||[]).map(g=>[o.shortName,g.address,[...new Set(g.rules.map(r=>r.houses))].join('; '),territoryIndex.byAddress.get(g.key).filter(other=>other.organizationId!==o.id).map(other=>getOrg(other.organizationId).shortName).join('; '),ruleLocations.has(g.id)?'Найдено: '+ruleLocations.get(g.id).kind:ruleAttempts.has(g.id)?'Не подтверждено: '+(ruleFailures.get(g.id)||'нужна проверка адреса'):'Ещё не проверено',g.rules.map(r=>`DOCX · таблица ${r.table} · строка ${r.sourceRow}`).join('; ')]));
      description=`${territoryIndex.organizationCount} зон обслуживания. ${territoryIndex.shared.length} текстов адресов встречаются у разных больниц; это не доказывает пересечение домов. Чётность и диапазоны сохранены. Строки одной улицы объединены только для отображения.`;
    } else if(kind==='addresses') {
      headers=['Организация','Адрес / улица','Дома','Категория','Источник'];
      rows=orgs.flatMap(o=>o.territories.flatMap(t=>t.rules.map(r=>[o.shortName,r.address,r.houses,t.category,`_прикрепление новое.docx · таблица ${t.table} · строка ${r.sourceRow}`])));
      description='Адресные правила для взрослого и смешанного населения. Диапазоны, чётность и формулировки «все дома» сохранены. Это не перечень индивидуально проверенных домов и не номерные терапевтические участки.';
    } else if(kind==='capacity') {
      headers=['Организация в форме','Филиал','План, всего / смену','Взрослая / смешанная поликлиника','Источник'];
      const blocks=orgId?orgs.flatMap(o=>o.capacity):data.capacityBlocks;
      rows=blocks.map(b=>[b.organization,b.branch,b.total,b.adultMixed,`30_1010_МОЩНОСТЬ.xls · Лист1 · строка ${b.sourceRow}`]);
      description='На 01.01.2026. Общая амбулаторная плановая мощность по разным профилям. Не используется для расчёта загрузки терапевтов. Итоговая строка «ВСЕГО» исключена, чтобы не считать её вместе с деталями.';
    } else {
      headers=['Территория','Тип','Население','Статус','Дата'];
      rows=data.populations.map(p=>[p.name,p.type,settings.populationValues[p.id]??p.value,'Предоставлено пользователем; не проверено','Не указана']);
      description='Города и районы не складываются. Для изменения значения выберите соответствующую территорию в карточке организации. Повторяющиеся значения 67 754 сохранены как предоставлено.';
    }
    const q=$('table-search').value.trim().toLocaleLowerCase('ru');
    if(q)rows=rows.filter(row=>row.some(v=>String(v??'').toLocaleLowerCase('ru').includes(q)));
    return {headers,rows,description};
  }
  function renderTable() {
    currentTable=tableData();const {headers,rows,description}=currentTable;
    page=Math.min(page,Math.max(0,Math.ceil(rows.length/PAGE_SIZE)-1));
    $('table-head').innerHTML='<tr>'+headers.map(h=>'<th scope="col">'+esc(h)+'</th>').join('')+'</tr>';
    $('table-body').innerHTML=rows.length?rows.slice(page*PAGE_SIZE,(page+1)*PAGE_SIZE).map(row=>'<tr>'+row.map((v,i)=>`<td class="${typeof v==='number'?'numeric':''}">${v===null?'нет данных':typeof v==='number'?fmt(v,['Широта','Долгота'].includes(headers[i])?6:2):esc(v)}</td>`).join('')+'</tr>').join(''):`<tr><td colspan="${headers.length}" class="empty">Нет строк по выбранным условиям.</td></tr>`;
    $('table-description').textContent=description;$('table-count').textContent=fmt(rows.length)+' строк';$('page-number').textContent=`${rows.length?page+1:0} / ${Math.ceil(rows.length/PAGE_SIZE)}`;
    $('prev-page').disabled=page===0;$('next-page').disabled=(page+1)*PAGE_SIZE>=rows.length;$('table-org').disabled=$('table-kind').value==='population';
  }
  function download(content,name,type) {const url=URL.createObjectURL(new Blob([content],{type}));const a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  function csvCell(v) {let s=v===null?'':String(v);if(/^[=+@\-]/.test(s)&&typeof v!=='number')s="'"+s;return '"'+s.replace(/"/g,'""')+'"';}
  function locationFor(id) {return C.locationFor(getOrg(id),settings,orgLocations.get(id));}
  function promiseTimeout(p,ms=15000,signal){
    return new Promise((resolve,reject)=>{
      const clean=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);};
      const abort=()=>{clean();reject(Object.assign(new Error('Поиск остановлен пользователем.'),{name:'AbortError',code:'SEARCH_CANCELLED'}));};
      const timer=setTimeout(()=>{clean();reject(Object.assign(new Error('Время ожидания ответа Яндекса истекло.'),{name:'TimeoutError'}));},ms);
      if(signal?.aborted){abort();return;}signal?.addEventListener('abort',abort,{once:true});
      Promise.resolve(p).then(value=>{clean();resolve(value);},error=>{clean();reject(error);});
    });
  }
  function explainApiError(error, service) {
    const raw=String(error?.message||error||'Ответ сервиса не получен.');
    let message;
    if(/Invalid api key|HTTP 40[13]/i.test(raw)) {
      message=service+': Яндекс отклонил ключ. Проверьте в кабинете, что ключ относится к этому продукту, продукт подключён, ключ активен и ограничения разрешают текущий адрес. Ответ: '+raw;
    } else if(/scriptError/i.test(raw)) {
      message=service+': запрос не выполнен. Проверьте сообщения Яндекса в консоли, активацию ключа JavaScript API и его ограничения. Появление подложки не подтверждает действительность ключа. Ответ: '+raw;
    } else if(/Failed to fetch|NetworkError|Load failed/i.test(raw)) {
      message=service+': браузер не получил ответ. Возможны сетевая ошибка или ограничение браузера. Проверьте доступ к Яндексу и сообщение в консоли. Ответ: '+raw;
    } else {
      message=service+': '+raw;
    }
    if(location.protocol==='file:')message+=' Страница открыта как файл (file://), без обычного HTTP Referer. Ключ с ограничением по домену может отклонять такой запуск.';
    return message;
  }
  const networkGate=T.paceRequests({interval:200,shouldStop:()=>busy&&cancelRequested});
  const requestCache=T.createGeocoderCache(requestGeocode,{values:geocodeCache});
  function geocode(query,options){if(!$('allow-geocoder').checked)return Promise.reject(new Error('Новый поиск адресов выключен. Используйте сохранённые данные.'));return requestCache.get(query,options);}
  async function requestGeocode(query){
    try {
      return await T.retryRequest(()=>networkGate(()=>requestGeocodeOnce(query)),{
        shouldStop:()=>busy&&cancelRequested,
        onRetry:(attempt,total)=>setMessage(`Геокодер отвечает медленно или связь прервалась. Повтор запроса ${attempt} из ${total}. Уже найденные адреса сохранены.`)
      });
    } catch(error){
      if(!(busy&&cancelRequested)&&T.transientError(error))throw Object.assign(new Error(error.status>=500?`Геокодер временно недоступен (HTTP ${error.status}) после трёх попыток. Продолжите поиск позже.`:'Не удалось получить ответ геокодера после трёх попыток: соединение прервалось или истекло время ожидания. Продолжите поиск позже.'),{name:'NetworkError',status:error.status});
      throw error;
    }
  }
  async function requestGeocodeOnce(query){
    let result;
    if(geoKey){
      let timedOut=false;
      const controller=new AbortController(),timer=setTimeout(()=>{timedOut=true;controller.abort();},30000);activeRequests.add(controller);
      try {
        const u=new URL('https://geocode-maps.yandex.ru/v1');u.search=new URLSearchParams({apikey:geoKey,geocode:query,format:'json',lang:'ru_RU',results:'1',bbox:'35.6,52.7~38.9,55.0',rspn:'1'});
        const response=await fetch(u,{signal:controller.signal});
        if(!response.ok){let reason='';try{const failure=await response.json();reason=typeof failure.message==='string'?failure.message:typeof failure.error==='string'?failure.error:'';}catch(_){}throw Object.assign(new Error(`Геокодер отклонил запрос (HTTP ${response.status})${reason?': '+reason:''}.`),{status:response.status});}
        const body=await response.json(),g=body.response?.GeoObjectCollection?.featureMember?.[0]?.GeoObject;
        if(!g)throw new Error('Адрес не найден в пределах области.');
        const pos=g.Point.pos.split(/\s+/).map(Number),meta=g.metaDataProperty.GeocoderMetaData;
        result={coords:[pos[1],pos[0]],kind:meta.kind,precision:meta.precision||'',label:meta.text};
      } catch(error){
        if(controller.signal.aborted){
          if(busy&&cancelRequested)throw Object.assign(new Error('Поиск остановлен пользователем.'),{name:'AbortError',code:'SEARCH_CANCELLED'});
          if(timedOut)throw Object.assign(new Error('Геокодер не ответил за 30 секунд. Попробуйте продолжить поиск позже.'),{name:'TimeoutError',code:'GEOCODER_TIMEOUT'});
        }
        throw error;
      } finally {clearTimeout(timer);activeRequests.delete(controller);}
    } else {
      const controller=new AbortController();activeRequests.add(controller);
      try {
        const response=await promiseTimeout(ym.geocode(query,{results:1,boundedBy:[[52.7,35.6],[55.0,38.9]],strictBounds:true}),30000,controller.signal);
        const o=response.geoObjects.get(0);if(!o)throw new Error('Адрес не найден в пределах области.');
        result={coords:o.geometry.getCoordinates(),kind:o.properties.get('metaDataProperty.GeocoderMetaData.kind'),precision:o.properties.get('metaDataProperty.GeocoderMetaData.precision')||'',label:o.getAddressLine()};
      } finally {activeRequests.delete(controller);}
    }
    if(!result.coords.every(Number.isFinite)||result.coords[0]<52.7||result.coords[0]>55||result.coords[1]<35.6||result.coords[1]>38.9)throw new Error('Результат вне области проверки; координаты не добавлены.');
    return result;
  }
  function setBusy(v) {busy=v;if(v)cancelRequested=false;$('stop-loading').hidden=!v;$('locate-all').disabled=v||!map||!$('allow-geocoder').checked;$('locate-all-addresses').disabled=v||!map||!$('allow-geocoder').checked;$('open-settings').disabled=v;if(selected)renderDetail(getOrg(selected));}
  async function locateOrganizations(orgs) {
    if(!map||busy)return;
    setBusy(true);let found=0,errors=0;
    try {
      for(const [i,o] of orgs.entries()) {
        if(cancelRequested)break;
        setMessage(`Поиск организаций: ${i+1} из ${orgs.length}. Найдено ${found}.`);
        if(locationFor(o.id)){found++;continue;}
        try {
          const r=await geocode(o.mapQuery);
          orgLocations.set(o.id,{...r,label:o.mapQueryType+' · '+r.label+' · точность: '+r.kind});await persistLocal([L.recordForOrganization(o,orgLocations.get(o.id))]);found++;
          renderMap();
        } catch(e) {
          errors++;
          if(/403|401|key|denied|forbidden|отклонил|Failed to fetch/i.test(String(e.message||e)))throw e;
        }
        await new Promise(resolve=>setTimeout(resolve,300));
      }
      setMessage(`Положений больниц: ${found} из ${orgs.length}. Без результата: ${errors}. Координаты из файла используются без геокодера.`);
      if(orgs.length===1&&locationFor(orgs[0].id))map.setCenter(locationFor(orgs[0].id).coords,13);
      else fitMap();
    } catch(e) {setMessage('Поиск остановлен: '+(e.message||'геокодирование отклонено. Проверьте активацию и ограничения ключа.'));toast('Геокодирование не завершено. Подробности над картой.');}
    finally {setBusy(false);renderMap();}
  }
  function fitZone(organizationId) {
    if(!map)return;
    const points=anchorsFor(organizationId),b=T.fitBounds(points);
    if(!b)return;
    if(b[0][0]===b[1][0]&&b[0][1]===b[1][1])map.setCenter(b[0],13);
    else map.setBounds(b,{checkZoomRange:true,zoomMargin:65});
  }
  async function locateRules(o) {
    if(!map||busy)return;
    const groups=territoryIndex.byOrganization.get(o.id)||[];
    const batch=groups.filter(g=>!ruleLocations.has(g.id)&&!ruleAttempts.has(g.id)).slice(0,20);
    if(!batch.length)return toast('Новых адресов нет. Ненайденные можно проверить повторно.');
    setBusy(true);let found=0,failed=0,lastDraw=0;const started=performance.now();
    try {
      await T.searchAddressGroups(batch,{
        lookup:g=>geocode('Тульская область, '+g.address),locations:ruleLocations,attempts:ruleAttempts,failures:ruleFailures,
        shouldStop:()=>cancelRequested,onResult:persistGroup,concurrency:4,minInterval:200,
        onProgress:(progress,g)=>{found=progress.found;failed=progress.failed;setMessage(`${o.shortName}: проверено ${progress.processed} из ${batch.length}. Найдено: ${found}. Не подтверждено: ${failed}. ${searchSpeed(progress.processed,batch.length,started)}`);if(performance.now()-lastDraw>750){renderMap();lastDraw=performance.now();}},
      });
      const progress=T.coverage(groups,ruleLocations,ruleAttempts);
      setMessage(`${cancelRequested?'Поиск остановлен. ':''}${o.shortName}: найдено ${progress.found} из ${progress.total} адресных ориентиров. Не подтверждено: ${progress.failed}. Осталось: ${progress.remaining}. Контуры разделены без наложений; спорные фрагменты не окрашены. Время запуска: ${fmt((performance.now()-started)/1000,1)} с.`);
      if(selected===o.id)fitZone(o.id);
    } catch(e){setMessage('Поиск зоны остановлен: '+(e.message||'проверьте доступ к геокодеру.'));}
    finally{setBusy(false);renderMap();renderTable();}
  }
  function searchSpeed(processed,total,started){
    const seconds=(performance.now()-started)/1000,rate=seconds>0?processed/seconds:0;
    if(seconds<2||processed<4)return 'До 4 запросов одновременно.';
    const left=rate>0?Math.ceil((total-processed)/rate/60):0;
    return `${fmt(rate,1)} адреса/с · осталось около ${left} мин.`;
  }
  function anchorsFor(id){return (territoryIndex.byOrganization.get(id)||[]).map(group=>ruleLocations.get(group.id)).filter(Boolean);}
  function zoneRing(id,anchors=anchorsFor(id)){
    const signature=anchors.map(anchor=>anchor.coords.join(',')).join('|'),cached=zoneGeometryCache.get(id);
    if(cached&&cached.signature===signature)return cached.ring;
    const ring=T.coverageRing(anchors);zoneGeometryCache.set(id,{signature,ring});return ring;
  }
  function baseZonePartition(){
    if(!localLoaded)return {...partitionResult,pending:false};
    if(requestedRevision!==addressRevision||requestedGeometry!==settings.geojson){
      restoreVectorsReady=false;
      requestedRevision=addressRevision;requestedGeometry=settings.geojson;
      const organizations=data.organizations.map(o=>({id:o.id,anchors:anchorsFor(o.id).map(a=>({coords:a.coords})),geometries:settings.geojson.filter(f=>f.properties.organizationId===o.id&&f.geometry.type!=='Point').map(f=>f.geometry)}));
      const signature=JSON.stringify(organizations),cached=L.restoreZones(savedZoneSnapshot,signature,data.organizations.map(o=>o.id));
      if(cached){partitionResult=cached;partitionRevision++;zoneSource='local';zoneStorageState='saved';restoreVectorsReady=true;}
      else {zoneSource='calculated';calculationProgress=null;calculationStarted=calculationUpdated=Date.now();zoneSnapshotInput={key:++partitionRequestSequence,signature};partitionJobs.request(zoneSnapshotInput.key,organizations);}
    }
    return {...partitionResult,pending:partitionJobs.busy};
  }
  let partitionRequestSequence=0;
  function activePartition(){return settings.fullCoverage&&coverageResult?coverageResult:partitionResult;}
  function zonePartition(){
    const base=baseZonePartition();
    if(settings.fullCoverage&&!coverageResetting&&localLoaded&&!base.pending&&!base.error&&savedZoneSnapshot){
      const organizations=data.organizations.map(o=>({id:o.id,coords:locationFor(o.id)?.coords}));
      const signature=JSON.stringify({algorithm:1,base:savedZoneSnapshot.signature,hospitals:organizations,boundary:window.HOSPITAL_REGION.properties.id});
      if(signature!==coverageSignature){
        coverageSignature=signature;coverageError='';coverageResult=null;partitionRevision++;
        const cached=L.restoreZones(savedCoverageSnapshot,signature,data.organizations.map(o=>o.id));
        if(cached?.coverage)coverageResult=cached;
        else {coverageProgress=null;coverageStarted=coverageUpdated=Date.now();coverageInput={key:++partitionRequestSequence,signature};coverageJobs.request(coverageInput.key,organizations,{task:'coverage',boundary:window.HOSPITAL_REGION,baseZones:base.zones});}
      }
    }
    updateCoverageStatus();
    return {...activePartition(),pending:base.pending||settings.fullCoverage&&coverageJobs.busy};
  }
  function resetCoverage(){coverageResetting=true;coverageInput=null;coverageSignature='';coverageResult=null;coverageError='';coverageProgress=null;coverageJobs.restart();coverageResetting=false;partitionRevision++;}
  function updateCoverageStatus(){
    if(!$('coverage-status'))return;
    $('full-coverage').checked=settings.fullCoverage;
    document.body.classList.toggle('coverage-organization',settings.fullCoverage&&Boolean(coverageResult)&&settings.mapColor==='organization');
    $('fill-coverage').disabled=!localLoaded||busy||coverageJobs.busy||coverageSaving||backupWorking;
    $('fill-coverage').textContent=coverageJobs.busy?'Заполняем пробелы…':coverageError?'Повторить заполнение':'Заполнить пробелы';
    $('coverage-progress').hidden=!settings.fullCoverage||!coverageJobs.busy;
    $('coverage-source').hidden=!settings.fullCoverage;
    let note='Пустые территории будут отданы ближайшей больнице по прямой. Существующие зоны сохранятся; перед расчётом создаётся локальная копия.';
    if(settings.fullCoverage){
      if(coverageError)note='Заполнение приостановлено: '+coverageError;
      else if(coverageJobs.busy){
        const p=coverageProgress,names={'coverage-boundary':'Граница области','coverage-clip':'Сохранение исходных зон','coverage-fill':'Распределение пустых территорий','coverage-mask':'Проверка покрытия области','coverage-verify':'Проверка наложений'};
        note=(names[p?.stage]||'Подготовка заполнения')+(p?.total?` · ${fmt(p.completed)} / ${fmt(p.total)}`:'')+` · прошло ${Math.floor((Date.now()-coverageStarted)/1000)} с · без обновлений ${Math.floor((Date.now()-coverageUpdated)/1000)} с.`;
        const bar=$('coverage-progress');bar.max=Math.max(p?.total||1,1);bar.value=p?.completed||0;
      }else if(coverageResult){
        note=`Полное покрытие готово · ${coverageResult.zones.size} зон. Расчётно добавлено ${fmt(coverageResult.coverage.addedArea/coverageResult.coverage.regionArea*100,1)}% площади. ${coverageSaving?'Сохраняем…':cacheProblem?'Сохранение недоступно — скачайте копию.':'Готовые контуры сохраняются локально.'}`;
        if(settings.mapColor==='organization')$('legend-note').textContent='Каждая больница показана единым расширенным контуром. Расширение рассчитано локально; адресные правила сохранены.';
        if(coverageResult.coverage.coLocated.length)note+=' При совпадении координат пустая территория отдана первой больнице по ID; исходные зоны каждой сохранены.';
        if(listed().length<data.organizations.length)note+=' Часть зон скрыта фильтрами: для сплошного отображения очистите поиск и включите организации без численности.';
      }else note='Ожидаем готовые исходные векторы…';
    }
    $('coverage-status').textContent=note;
    $('zone-layer-description').textContent=settings.fullCoverage&&coverageResult?'Единый расширенный контур каждой больницы; пустые территории — по ближайшей больнице.':'Пунктир — приблизительная граница по найденным адресам. Пробелы означают неопределённость.';
  }
  function updateTopologyNote(){
    if(!$('zone-topology-note'))return;
    const error=mapDrawError||partitionResult.error||settings.fullCoverage&&coverageError;
    if(settings.fullCoverage&&coverageResult&&!error){$('zone-topology-note').textContent='Покрытие проверено с учётом сантиметрового округления стыков. Численность прикреплённых не изменена.';return;}
    $('zone-topology-note').textContent=error?'Ошибка обновления границ: '+error:partitionJobs.busy?'Границы пересчитываются в фоне. Поиск адресов и управление страницей доступны.':(zoneSource==='local'?`Восстановлено готовых векторных зон локально: ${partitionResult.zones.size}. Без повторного построения. `:'')+'Зоны не накладываются. Неопределённые фрагменты не окрашены.'+(partitionResult.sharedAnchors?` Общих координат адресов: ${partitionResult.sharedAnchors}.`:'')+(partitionResult.importedConflicts?` Конфликтов в загруженных границах: ${partitionResult.importedConflicts}.`:'');
  }
  const allAddressGroups=[...territoryIndex.byOrganization.values()].flat();
  function bulkSummary() {
    const stats=T.coverage(allAddressGroups,ruleLocations,ruleAttempts);
    const zones=zonePartition().zones.size;
    return {stats,zones};
  }
  function updateBulkProgress(prefix='') {
    const {stats,zones}=bulkSummary(),checked=stats.found+stats.failed;
    $('bulk-progress').hidden=false;$('bulk-progress-bar').max=stats.total;$('bulk-progress-bar').value=checked;
    $('bulk-progress-label').textContent=`${prefix}Проверено ${fmt(checked)} / ${fmt(stats.total)}. Найдено: ${fmt(stats.found)}. Не подтверждено: ${fmt(stats.failed)}. Зон: ${zones} / ${settings.fullCoverage&&coverageResult?data.organizations.length:territoryIndex.organizationCount}.${partitionJobs.busy?' Границы обновляются в фоне.':''}`;
    return {stats,zones};
  }
  async function locateAllAddresses() {
    if(!map||busy)return;
    settings.mapColor='organization';settings.showZones=true;settings.showEmpty=true;$('org-search').value='';
    selected=null;$('detail-panel').hidden=true;showView('map');render();
    const queue=T.pendingAddressGroups(territoryIndex,ruleLocations,ruleAttempts);
    if(!queue.length){setMessage(updateBulkProgress('Все адреса проверены. ').stats.failed?'Все адреса проверены. Неподтверждённые адреса можно повторить в карточках больниц.':'Все адреса найдены; зоны построены.');fitMap();return;}
    bulkActive=true;setBusy(true);updateBulkProgress();const started=performance.now();let lastDraw=0,overviewShown=false;
    $('locate-all-addresses').textContent='Поиск всех адресов…';
    setMessage(`Поиск всех больниц: осталось ${fmt(queue.length)} адресов. Зоны строятся автоматически, у каждой больницы свой цвет.`);
    try {
      await T.searchAddressGroups(queue,{
        lookup:g=>geocode('Тульская область, '+g.address),locations:ruleLocations,attempts:ruleAttempts,failures:ruleFailures,
        shouldStop:()=>cancelRequested,onResult:persistGroup,concurrency:4,minInterval:200,
        onProgress:(progress,g)=>{
          setMessage(`Все больницы: ${fmt(progress.processed)} / ${fmt(queue.length)} в текущем запуске. ${getOrg(g.organizationId).shortName} · ${g.address}. ${searchSpeed(progress.processed,queue.length,started)}`);
          if(performance.now()-lastDraw>750){updateBulkProgress();renderMap();if(selected)renderDetail(getOrg(selected));if(!overviewShown&&progress.processed>=50){overviewShown=true;fitMap();}lastDraw=performance.now();}
        }
      });
      const {stats,zones}=updateBulkProgress(cancelRequested?'Поиск остановлен. ':'Поиск завершён. ');
      setMessage(`${cancelRequested?'Поиск остановлен. Нажмите кнопку ещё раз, чтобы продолжить.':'Все адреса проверены.'} Найдено ${fmt(stats.found)} / ${fmt(stats.total)}; не подтверждено ${fmt(stats.failed)}; осталось ${fmt(stats.remaining)}. Построено зон: ${zones}. Время запуска: ${fmt((performance.now()-started)/1000,1)} с.`);
    } catch(error) {
      updateBulkProgress('Поиск приостановлен. ');
      setMessage('Поиск приостановлен: '+(error.message||'геокодер недоступен.')+' Уже найденные адреса доступны локально; статус сохранения показан под кнопкой поиска. После устранения причины нажмите кнопку ещё раз, чтобы продолжить.');
    } finally {
      bulkActive=false;setBusy(false);renderMap();renderTable();fitMap();
      $('locate-all-addresses').textContent='Найти все адреса и построить зоны';
    }
  }
  function renderChunked(kind,stamp,layer,items,make,total=0){
    if(layerStamps[kind]===stamp)return layerPromises[kind]||Promise.resolve();
    layerStamps[kind]=stamp;const token=(layerTokens[kind]||0)+1;layerTokens[kind]=token;
    const epoch=mapEpoch;layer.removeAll();if(kind==='zone'){zoneDrawing=true;restoreDrawn=0;restoreTotal=total;updateRestoreProgress();}
    layerPromises[kind]=J.chunks(items,item=>layer.add(make(item)),{cancelled:()=>epoch!==mapEpoch||layerTokens[kind]!==token||!map,onProgress:count=>{if(kind==='zone'&&epoch===mapEpoch&&layerTokens[kind]===token){restoreDrawn=count;updateRestoreProgress();}}}).catch(error=>{mapDrawError=String(error.message||error);updateTopologyNote();}).finally(()=>{
      if(kind==='zone'&&layerTokens[kind]===token){zoneDrawing=false;if(fitPending&&!partitionJobs.busy){fitPending=false;fitMap(false);}updateRestoreProgress();}
    });
    return layerPromises[kind];
  }
  function renderMap(){
    const partition=zonePartition();
    accessibility.refresh();updateTopologyNote();updateRestoreProgress();
    if(!map||!ym)return Promise.resolve();
    const organizations=listed(),visible=new Set(organizations.map(o=>o.id));
    const colors=organizations.map(o=>[o.id,colorFor(o),value(o)]);
    const orgStamp=JSON.stringify([mapEpoch,colors,organizations.map(o=>locationFor(o.id))]);
    if(layerStamps.org!==orgStamp){
      layerStamps.org=orgStamp;orgLayer.removeAll();
      for(const o of organizations){const loc=locationFor(o.id);if(!loc)continue;
        const samePoint=organizations.filter(other=>other.id!==o.id&&locationFor(other.id)?.coords.every((v,i)=>v===loc.coords[i]));
        const marker=new ym.Placemark(loc.coords,{hintContent:esc([o,...samePoint].map(other=>other.shortName).join('; ')),balloonContent:`<strong>${esc(o.shortName)}</strong><br>${fmt(value(o),1)} ${esc(metricLabel())}<br><small>${esc(loc.label)}</small>${samePoint.length?'<p>Та же точка: '+samePoint.map(other=>esc(other.shortName)).join('; ')+'. Выберите организацию в списке слева.</p>':''}`},{preset:['manual','house','provided'].includes(loc.kind)?'islands#dotIcon':'islands#circleDotIcon',iconColor:colorFor(o)});
        marker.events.add('click',()=>selectOrg(o.id));orgLayer.add(marker);
      }
    }
    const zoneStamp=JSON.stringify([mapEpoch,partitionRevision,settings.showZones,accessibility.enabled,selected,colors]);
    function* zoneItems(){if(settings.showZones)for(const o of organizations)for(const coordinates of partition.zones.get(o.id)||[])yield {o,coordinates};}
    const zonePromise=renderChunked('zone',zoneStamp,zoneLayer,zoneItems(),({o,coordinates})=>{
      const total=(territoryIndex.byOrganization.get(o.id)||[]).length,count=partition.anchorCounts?.get(o.id)??anchorsFor(o.id).length;
      const label=partition.coverage?'Расширенная зона больницы':'Зона по адресным ориентирам';
      const balloon=`<strong>${esc(o.shortName)}</strong><p>${label}. ${partition.coverage?'Пустые территории добавлены по ближайшей больнице по прямой. Расширение расчётное; численность прикреплённых не меняется.':`Основа: ${count} из ${total} адресных ориентиров. Исходные правила домов сохранены.`}</p><p>${fmt(value(o),1)} ${esc(metricLabel())}</p>`;
      return new ym.Polygon(C.yandexGeometry({type:'Polygon',coordinates}).coordinates,{hintContent:esc(o.shortName)+' · '+label,balloonContent:balloon},{fillColor:colorFor(o),fillOpacity:accessibility.enabled?0.035:(selected&&selected!==o.id)?0.09:0.24,strokeColor:colorFor(o),strokeWidth:selected===o.id?2:1,strokeStyle:partition.coverage?'solid':'dash',zIndex:selected===o.id?200:50});
    },settings.showZones?organizations.reduce((sum,o)=>sum+(partition.zones.get(o.id)?.length||0),0):0);
    renderZoneKey(settings.showZones?organizations.filter(o=>partition.zones.has(o.id)):[]);
    const rules=settings.showAddressPoints?[...ruleLocations.values()].filter(r=>visible.has(r.organizationId)&&(!selected||r.organizationId===selected)):[];
    const ruleStamp=JSON.stringify([mapEpoch,selected,colors,rules.map(r=>[r.id,r.coords])]);
    const rulePromise=renderChunked('rule',ruleStamp,ruleLayer,rules,r=>{
      const o=getOrg(r.organizationId),rules=r.rules.map(rule=>`<li>Дома: ${esc(rule.houses)}<br><small>DOCX · таблица ${rule.table}, строка ${rule.sourceRow}</small></li>`).join('');
      return new ym.Placemark(r.coords,{hintContent:esc(o.shortName+' · '+r.address),balloonContent:`<strong>${esc(r.address)}</strong><br>${esc(o.shortName)}<ul>${rules}</ul><small>Ориентир: ${esc(r.kind)} · ${esc(r.precision)}<br>${esc(r.label)}</small>`},{preset:'islands#circleIcon',iconColor:colorFor(o)});
    });
    const points=settings.geojson.filter(f=>f.geometry.type==='Point'&&visible.has(f.properties.organizationId));
    const geoPromise=renderChunked('geo',JSON.stringify([mapEpoch,colors,points]),geometryLayer,points,f=>{
      const o=getOrg(f.properties.organizationId),shape=new ym.GeoObject({geometry:C.yandexGeometry(f.geometry),properties:{hintContent:esc(f.properties.name||o.shortName),balloonContent:esc(f.properties.source)}},{iconColor:colorFor(o)});
      shape.events.add('click',()=>selectOrg(o.id));return shape;
    });
    return Promise.all([zonePromise,rulePromise,geoPromise]);
  }
  function renderZoneKey(zones) {
    $('zone-key').hidden=!zones.length;$('zone-key-summary').textContent=`Цвета построенных зон (${zones.length})`;
    $('zone-key-items').innerHTML=zones.map(o=>`<button class="zone-key-item" data-zone="${esc(o.id)}"><i class="dot" style="background:${colorFor(o)}"></i><span>${esc(o.shortName)}</span></button>`).join('');
    document.querySelectorAll('[data-zone]').forEach(button=>button.onclick=()=>{selectOrg(button.dataset.zone);fitZone(button.dataset.zone);});
  }
  function fitMap(track=true) {
    if(!map)return;
    if(track===true&&(partitionJobs.busy||coverageJobs.busy||zoneDrawing))fitPending=true;
    const corners=[orgLayer,ruleLayer,geometryLayer,zoneLayer].map(layer=>layer.getBounds()).filter(Boolean).flat().map(coords=>({coords}));
    const b=T.fitBounds(corners);
    if(b)map.setBounds(b,{checkZoomRange:true,zoomMargin:80});
    else map.setBounds([[52.95,35.8],[54.95,38.75]],{checkZoomRange:true});
  }
  async function connect(key,geocoderKey,{verify=false,routingKey:nextRoutingKey=routingKey}={}) {
    if(busy||accessibility.busy)return;
    await cacheReady;
    if(!key.trim())return $('key-status').textContent='Введите ключ JavaScript API.';
    sessionKey=key.trim();geoKey=geocoderKey.trim();routingKey=String(nextRoutingKey||'').trim();$('submit-key').disabled=true;$('key-status').textContent='Подключение API…';
    mapLoadState='loading';updateRestoreProgress();
    try {
      {
        if(map){map.destroy();map=null;}mapEpoch++;for(const key of Object.keys(layerStamps))delete layerStamps[key];mapDrawError='';
        const ns='hospitalYmaps'+Date.now();
        ym=await promiseTimeout(new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='https://api-maps.yandex.ru/2.1/?'+new URLSearchParams({apikey:sessionKey,lang:'ru_RU',ns});script.onerror=()=>reject(new Error('Не удалось загрузить API. Проверьте сеть и ключ.'));script.onload=()=>{const api=window[ns];if(!api)return reject(new Error('API не инициализирован.'));api.ready(()=>resolve(api));};document.head.append(script);}),20000);
        loadedKey=sessionKey;
      }
      if(!map) {
        map=new ym.Map('map',{center:[54.1,37.5],zoom:8,controls:['zoomControl','typeSelector','fullscreenControl']},{suppressMapOpenBlock:false});
        orgLayer=new ym.GeoObjectCollection();ruleLayer=new ym.GeoObjectCollection();geometryLayer=new ym.GeoObjectCollection();zoneLayer=new ym.GeoObjectCollection();map.geoObjects.add(zoneLayer).add(geometryLayer).add(orgLayer).add(ruleLayer);
        $('map-placeholder').hidden=true;$('fit-map').disabled=false;$('locate-all').disabled=!$('allow-geocoder').checked;$('locate-all-addresses').disabled=!$('allow-geocoder').checked;$('open-settings').textContent='Настройки карты';
      }
      mapLoadState='ready';
      render();fitMap();
      if(verify)try {
        const result=await geocode('Тульская область, Тула, улица Первомайская, дом 13',{refresh:true});
        $('key-status').textContent='Карта и геокодирование работают. Тестовый адрес найден: '+result.label;
        setMessage(ruleLocations.size?`Яндекс Карты подключены. Показаны сохранённые адреса: ${fmt(ruleLocations.size)}. Зоны восстановлены без повторного поиска.`:'Яндекс Карты подключены. Нажмите «Найти все адреса и построить зоны».');
        $('settings-dialog').close();toast('Карта подключена, геокодирование проверено.');
      } catch(e) {
        const service=geoKey?'API Геокодера':'Геокодирование через JavaScript API';
        $('key-status').textContent=explainApiError(e,service);
        setMessage('Подложка загружена, но доступ к поиску адресов не подтверждён. Откройте «Настройки карты», чтобы увидеть ответ Яндекса.');
      }
      if(!verify){setMessage(`Карта подключена без проверки геокодера. Восстановлено локально: ${fmt(ruleLocations.size)} адресов. Положений больниц: ${fmt(data.organizations.filter(o=>locationFor(o.id)).length)}. Повторный поиск не выполнялся.${zoneSource==='local'?` Готовые векторные зоны загружены локально: ${partitionResult.zones.size}.`:''}`);$('settings-dialog').close();}
      if($('remember-key').checked){try{localStorage.setItem('hospital-map-keys',JSON.stringify({map:sessionKey,geocoder:geoKey,routing:routingKey}));}catch(_){toast('Не удалось сохранить ключи в браузере.');}}
      render();
    } catch(e){mapLoadState='error';$('key-status').textContent=explainApiError(e,'JavaScript API карты');setMessage('Не удалось подключить подложку карты. Сохранённые адреса доступны в таблицах; откройте настройки карты для повторного подключения.');}
    finally{$('submit-key').disabled=false;updateRestoreProgress();}
  }

  // Bind controls. All source data loads from a classic script, so file:// needs no fetch.
  document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>showView(b.dataset.view));
  $('org-search').addEventListener('input',()=>{render();});
  for(const id of ['show-zones','show-address-points','map-color','metric','include-mixed','show-empty'])$(id).onchange=()=>{settings.showZones=$('show-zones').checked;settings.showAddressPoints=$('show-address-points').checked;settings.mapColor=bulkActive?'organization':$('map-color').value;settings.metric=$('metric').value;settings.includeMixed=$('include-mixed').checked;settings.showEmpty=$('show-empty').checked;render();};
  $('table-org').innerHTML='<option value="">Все организации</option>'+data.organizations.slice().sort((a,b)=>a.shortName.localeCompare(b.shortName,'ru')).map(o=>`<option value="${esc(o.id)}">${esc(o.shortName)}</option>`).join('');
  for(const id of ['table-kind','table-org','table-search'])$(id).addEventListener(id==='table-search'?'input':'change',()=>{page=0;renderTable();});
  $('prev-page').onclick=()=>{page--;renderTable();};$('next-page').onclick=()=>{page++;renderTable();};
  $('export-csv').onclick=()=>download('\ufeff'+[currentTable.headers,...currentTable.rows].map(r=>r.map(csvCell).join(';')).join('\r\n'),'hospital-'+$('table-kind').value+'.csv','text/csv;charset=utf-8');
  $('stop-loading').onclick=()=>{cancelRequested=true;for(const controller of activeRequests)controller.abort();setMessage('Останавливаем поиск. Уже полученные результаты сохраняются…');};
  $('restart-zone-calculation').onclick=()=>{
    partitionJobs.restart();calculationProgress=null;calculationStarted=calculationUpdated=0;
    partitionResult={...partitionResult,error:null};mapDrawError='';requestedRevision=-1;requestedGeometry=null;
    renderMap();setMessage('Расчёт векторов перезапущен по сохранённым адресам. Геокодер не используется, найденные точки сохранены.');
  };
  $('allow-geocoder').onchange=()=>{if(busy&&!$('allow-geocoder').checked){cancelRequested=true;for(const controller of activeRequests)controller.abort();}else if(!busy)setBusy(false);render();};
  $('fit-map').onclick=()=>fitMap();$('locate-all').onclick=()=>locateOrganizations(listed());$('locate-all-addresses').onclick=locateAllAddresses;
  const openSettings=()=>{$('settings-dialog').showModal();$('api-key').focus();};
  $('open-settings').onclick=openSettings;$('connect-map').onclick=openSettings;$('close-settings').onclick=()=>$('settings-dialog').close();
  const geocoderLabel=document.createElement('label');geocoderLabel.htmlFor='geocoder-key';geocoderLabel.textContent='Ключ API Геокодера (если выдан отдельно)';geocoderLabel.style.marginTop='12px';
  const geocoderInput=document.createElement('input');geocoderInput.id='geocoder-key';geocoderInput.type='password';geocoderInput.autocomplete='off';geocoderInput.placeholder='Отдельный ключ геокодера, необязательно';$('api-key').after(geocoderLabel,geocoderInput);
  geocoderLabel.hidden=true;geocoderInput.hidden=true;
  const routingLabel=document.createElement('label');routingLabel.htmlFor='routing-key';routingLabel.textContent='Ключ API получения деталей маршрута';routingLabel.style.marginTop='12px';
  const routingInput=document.createElement('input');routingInput.id='routing-key';routingInput.type='password';routingInput.autocomplete='off';routingInput.placeholder='Отдельный ключ HTTP API маршрутов';geocoderInput.after(routingLabel,routingInput);
  routingLabel.hidden=true;routingInput.hidden=true;
  $('remember-key').parentElement.lastChild.textContent='Сохранить ключ карты на этом устройстве и подключать её автоматически';$('forget-key').textContent='Удалить сохранённый ключ карты';
  routingInput.addEventListener('input',()=>{$('remember-key').checked=false;});
  $('key-form').onsubmit=e=>{e.preventDefault();connect($('api-key').value,$('geocoder-key').value,{routingKey:routingInput.value});};
  $('forget-key').onclick=()=>{try{localStorage.removeItem('hospital-map-keys');}catch(_){}accessibility.stop();routingKey='';$('api-key').value='';$('geocoder-key').value='';routingInput.value='';$('remember-key').checked=false;accessibility.refresh();$('key-status').textContent='Сохранённые ключи удалены. Для смены текущего подключения введите новые ключи или перезагрузите страницу.';};
  $('geojson-file').onchange=async e=>{const file=e.target.files[0];if(!file)return;try{if(file.size>25*1024*1024)throw new Error('Максимальный размер — 25 МБ.');const features=C.validateGeoJSON(JSON.parse(await file.text()),data.organizations.map(o=>o.id));settings.geojson=features;save();renderMap();toast('Загружено '+features.length+' объектов. Этот импорт заменил предыдущий.');if(map)fitMap();}catch(error){toast(error.message||'Не удалось прочитать GeoJSON.');}finally{e.target.value='';}};
  $('export-settings').onclick=()=>download(JSON.stringify({version:1,...settings},null,2),'hospital-map-settings.json','application/json');
  $('settings-file').onchange=async e=>{const file=e.target.files[0];if(!file)return;try{if(file.size>25*1024*1024)throw new Error('Слишком большой файл.');settings=validateSettings(JSON.parse(await file.text()));render();toast('Настройки проекта загружены.');}catch(error){toast(error.message||'Некорректные настройки.');}finally{e.target.value='';}};
  $('retry-cache').onclick=retryLocalSave;
  let pendingBackup=null,backupWorking=false;
  $('full-coverage').onchange=async e=>{
    if(e.target.checked)await enableCoverage();
    else {settings.fullCoverage=false;partitionRevision++;render();}
  };
  $('fill-coverage').onclick=enableCoverage;
  async function enableCoverage({forCalculation=false}={}){
    if(backupWorking||busy||accessibility.busy&&!forCalculation||coverageJobs.busy)return;
    backupLock(true);$('coverage-status').textContent='Сохраняем текущие зоны перед заполнением…';
    try{
      const previous=await makeProjectBackup();await L.install([],{checkpoint:previous});
      if(coverageError)resetCoverage();
      settings.fullCoverage=true;settings.showEmpty=true;settings.showZones=true;settings.mapColor='organization';$('org-search').value='';selected=null;$('detail-panel').hidden=true;
      partitionRevision++;render();showView('map');toast('Копия до заполнения сохранена в браузере. Её можно скачать в разделе «Резервные копии».');
    }catch(error){toast('Не удалось сохранить копию перед заполнением: '+error.message);$('full-coverage').checked=settings.fullCoverage;}
    finally{backupLock(false);updateCoverageStatus();}
  }
  const projectDataset=B.digest({organizations:data.organizations.map(o=>({id:o.id,location:o.location})),groups:[...territoryIndex.byOrganization].map(([id,groups])=>[id,groups.map(g=>[g.id,g.address])])});
  const backupText=counts=>`Адресов: ${fmt(counts.addresses)}; неподтверждённых: ${fmt(counts.failed)}; готовых зон: ${fmt(counts.zones)}; зон полного покрытия: ${fmt(counts.coverageZones)}; маршрутов: ${fmt(counts.routes)}.`;
  async function makeProjectBackup(){await cacheReady;return B.create({settings:validateSettings({...settings,selectedOrganization:selected}),routing:accessibility.settings(),records:localRecords(),dataset:await projectDataset});}
  function backupLock(value){backupWorking=value;for(const id of ['backup-export','backup-apply','backup-file'])$(id).disabled=value;}
  async function openBackup(){await cacheReady;$('backup-current').textContent='Текущий проект. '+backupText(B.summary(localRecords()));$('backup-previous').disabled=!await L.checkpoint().catch(()=>null);if(!$('backup-dialog').open)$('backup-dialog').showModal();}
  async function exportBackup(){
    if(backupWorking)return;
    backupLock(true);$('backup-status').textContent='Готовим полную копию и контрольную сумму…';
    try{const backup=await makeProjectBackup();download(JSON.stringify(backup),`hospital-project-${backup.createdAt.replace(/[:.]/g,'-')}.json`,'application/json');$('backup-status').textContent='Копия подготовлена для скачивания. '+backupText(backup.summary);}
    catch(error){$('backup-status').textContent=error.message;toast(error.message);}finally{backupLock(false);}
  }
  async function previewBackup(event){
    const file=event.target.files[0];if(!file)return;
    await openBackup();pendingBackup=null;$('backup-preview').hidden=true;backupLock(true);$('backup-status').textContent='Читаем файл и проверяем контрольную сумму…';
    try{
      if(file.size>B.MAX_BYTES)throw new Error('Максимальный размер резервной копии — 100 МБ.');
      const input=JSON.parse(await file.text());
      pendingBackup=await B.prepare(input,{data,index:territoryIndex,validateSettings,validateRouting:window.HospitalAccessibilityUI.validateSettings,dataset:await projectDataset});
      $('backup-preview-summary').textContent=backupText(pendingBackup.summary)+(pendingBackup.createdAt?' Дата: '+new Date(pendingBackup.createdAt).toLocaleString('ru-RU')+'.':'');
      $('backup-warning').textContent=(pendingBackup.legacy?'Старая версия копии: без контрольной суммы и настроек маршрутизации. ':'')+(pendingBackup.datasetMismatch?'Исходный набор проекта отличается. Известные записи сопоставлены; несовместимые контуры будут пересчитаны. ':'')+(pendingBackup.invalid?'Пропущено или объединено записей: '+fmt(pendingBackup.invalid)+'. ':'')+'Данные ещё не изменены. Настройки выбранной копии применятся при восстановлении.';
      $('backup-preview').hidden=false;$('backup-status').textContent='Файл проверен. Выберите способ восстановления.';
    }catch(error){$('backup-status').textContent=error.message||'Не удалось прочитать копию.';}finally{backupLock(false);event.target.value='';}
  }
  $('open-backup').onclick=openBackup;$('close-backup').onclick=()=>$('backup-dialog').close();
  $('backup-export').onclick=exportBackup;$('export-local-data').onclick=async()=>{await openBackup();await exportBackup();};
  $('export-local-data').textContent='Скачать полную копию проекта';
  $('backup-file').onchange=previewBackup;$('local-data-file').onchange=previewBackup;
  $('backup-previous').onclick=async()=>{try{const previous=await L.checkpoint();if(!previous)throw new Error('Предыдущая копия ещё не создана.');download(JSON.stringify(previous),'hospital-project-before-change.json','application/json');}catch(error){$('backup-status').textContent=error.message;}};
  $('backup-apply').onclick=async()=>{
    if(!pendingBackup||backupWorking)return;
    backupLock(true);$('backup-status').textContent='Сохраняем текущую версию и восстанавливаем данные…';
    try{
      if(busy||accessibility.busy)throw new Error('Остановите поиск и расчёт маршрутов перед восстановлением.');
      const plan=pendingBackup,previous=await makeProjectBackup(),replace=$('backup-mode').value==='replace';
      const records=replace?plan.records:B.merge(localRecords(),plan.records);
      await L.install(records,{replace:true,checkpoint:previous});
      settings.fullCoverage=false;resetCoverage();partitionJobs.restart();ruleLocations.clear();ruleAttempts.clear();ruleFailures.clear();orgLocations.clear();geocodeCache.clear();zoneGeometryCache.clear();
      settings=plan.settings;selected=settings.selectedOrganization;addressRevision++;requestedRevision=-1;requestedGeometry=null;
      savedZoneSnapshot=records.find(r=>r.key==='geometry:zones-v1')||null;zoneStorageState=savedZoneSnapshot?'saved':'missing';
      savedCoverageSnapshot=records.find(r=>r.key==='geometry:coverage-v1')||null;
      applyLocal(L.restore(records,data,territoryIndex));accessibility.restore(records,{replace:true});if(plan.routing)accessibility.restoreSettings(plan.routing);
      save();cacheProblem=null;render();showCacheStatus();updateBulkProgress('Восстановлено. ');
      $('backup-status').textContent='Проект восстановлен. '+backupText(B.summary(records))+' Предыдущая версия доступна для скачивания.';
      $('backup-current').textContent='Текущий проект. '+backupText(B.summary(records));
      pendingBackup=null;$('backup-preview').hidden=true;$('backup-previous').disabled=false;
    }catch(error){$('backup-status').textContent=error.message||'Не удалось восстановить проект.';}finally{backupLock(false);}
  };
  $('source-list').innerHTML=data.sources.map(s=>`<div class="source-item"><strong>${esc(s.file)}</strong><span>${esc(s.description)}</span></div>`).join('');
  $('quality-notes').innerHTML=data.notes.map(n=>'<li>'+esc(n)+'</li>').join('')+'<li>У ГКБ № 2 повторяются номера терапевтических участков 13, 17 и 18. Строки сохранены отдельно.</li><li>В смешанных категориях Щёкинской больницы 15 451 прикреплённый без разделения по возрасту.</li>';
  let savedKeys=null;
  try{const keys=JSON.parse(localStorage.getItem('hospital-map-keys')||'null');if(keys?.map){savedKeys=keys;$('api-key').value=keys.map;$('geocoder-key').value=keys.geocoder||'';routingInput.value=keys.routing||'';$('remember-key').checked=true;}}catch(_){}
  render();cacheReady=restoreLocal();
  cacheReady.then(()=>{if(savedKeys?.map)return connect(savedKeys.map,savedKeys.geocoder||'',{verify:false,routingKey:savedKeys.routing||''});});
})();
