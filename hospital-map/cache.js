(function(root){
  'use strict';
  const DATABASE='hospital-map-local-data',STORE='results';
  let connection;
  function open(){
    if(!connection)connection=new Promise((resolve,reject)=>{
      if(typeof indexedDB==='undefined')return reject(new Error('Браузер не поддерживает локальное хранилище IndexedDB.'));
      const request=indexedDB.open(DATABASE,1);
      request.onupgradeneeded=()=>request.result.createObjectStore(STORE,{keyPath:'key'});
      request.onsuccess=()=>{const db=request.result;db.onversionchange=()=>{db.close();connection=null;};resolve(db);};
      request.onerror=()=>{connection=null;reject(request.error);};
      request.onblocked=()=>{connection=null;reject(new Error('Закройте старые вкладки карты и повторите сохранение.'));};
    });
    return connection;
  }
  async function read(){
    const db=await open();
    return new Promise((resolve,reject)=>{
      const transaction=db.transaction(STORE,'readonly'),request=transaction.objectStore(STORE).getAll();
      transaction.oncomplete=()=>resolve(request.result);
      transaction.onerror=transaction.onabort=()=>reject(transaction.error||new Error('Не удалось прочитать локальные данные.'));
    });
  }
  async function write(records){
    const db=await open();
    if(!records.length)return;
    return new Promise((resolve,reject)=>{
      const transaction=db.transaction(STORE,'readwrite'),store=transaction.objectStore(STORE);
      transaction.oncomplete=()=>resolve();
      transaction.onerror=transaction.onabort=()=>reject(transaction.error||new Error('Не удалось сохранить локальные данные.'));
      for(const record of records)store.put(record);
    });
  }
  async function install(records,{replace=false,checkpoint}={}){
    const db=await open();
    return new Promise((resolve,reject)=>{
      const transaction=db.transaction(STORE,'readwrite'),store=transaction.objectStore(STORE);
      transaction.oncomplete=()=>resolve();transaction.onerror=transaction.onabort=()=>reject(transaction.error||new Error('Не удалось восстановить проект. Предыдущие данные сохранены.'));
      try{
        if(replace)store.clear();
        if(checkpoint)store.put({key:'backup:previous',type:'project-checkpoint',backup:checkpoint});
        for(const record of records)store.put(record);
      }catch(error){transaction.abort();reject(error);}
    });
  }
  async function checkpoint(){const db=await open();return new Promise((resolve,reject)=>{const transaction=db.transaction(STORE,'readonly'),request=transaction.objectStore(STORE).get('backup:previous');transaction.oncomplete=()=>resolve(request.result?.backup||null);transaction.onerror=transaction.onabort=()=>reject(transaction.error);});}
  function location(value){
    if(!value||!Array.isArray(value.coords)||value.coords.length!==2||!value.coords.every(Number.isFinite)||value.coords[0]<52.7||value.coords[0]>55||value.coords[1]<35.6||value.coords[1]>38.9)return null;
    if(typeof value.kind!=='string'||!value.kind||value.kind.length>40)return null;
    return {coords:value.coords.slice(),kind:value.kind,precision:String(value.precision||'').slice(0,100),label:String(value.label||'').slice(0,1500)};
  }
  function recordForGroup(group,locations,attempts,failures){
    const found=location(locations.get(group.id));
    if(!found&&!attempts.has(group.id))return null;
    return {key:'rule:'+group.id,type:'rule',id:group.id,status:found?'found':'failed',...(found?{location:found}:{error:String(failures.get(group.id)||'Нужна проверка адреса').slice(0,1500)})};
  }
  function recordForOrganization(organization,result){
    if(organization.location)return null;
    const found=location(result);
    return found?{key:'org:'+organization.id,type:'org',id:organization.id,query:organization.mapQuery,location:found}:null;
  }
  // Reattach canonical source rules; persisted files cannot replace hospital ownership.
  function restore(records,data,index){
    if(!Array.isArray(records)||records.length>100000)throw new Error('Некорректный список локальных данных.');
    const groups=new Map([...index.byOrganization.values()].flat().map(g=>[g.id,g]));
    const organizations=new Map(data.organizations.map(o=>[o.id,o]));
    const locations=new Map(),attempts=new Set(),failures=new Map(),orgLocations=new Map(),accepted=new Map();
    for(const record of records){
      if(!record||typeof record.id!=='string')continue;
      if(record.type==='rule'){
        const group=groups.get(record.id);if(!group)continue;
        const found=location(record.location);
        if(record.status==='found'&&found&&root.HospitalTerritories.suitableLocation(group.address,found)){
          locations.set(group.id,{...found,...group});attempts.delete(group.id);failures.delete(group.id);
          accepted.set('rule:'+group.id,recordForGroup(group,locations,attempts,failures));
        } else if(record.status==='failed'&&!locations.has(group.id)){
          attempts.add(group.id);failures.set(group.id,String(record.error||'Нужна проверка адреса').slice(0,1500));
          accepted.set('rule:'+group.id,recordForGroup(group,locations,attempts,failures));
        }
      } else if(record.type==='org'){
        const organization=organizations.get(record.id),found=location(record.location);
        if(!organization||organization.location||organization.mapQuery!==record.query||!found)continue;
        orgLocations.set(organization.id,found);accepted.set('org:'+organization.id,recordForOrganization(organization,found));
      }
    }
    return {locations,attempts,failures,orgLocations,records:[...accepted.values()]};
  }
  function zoneSnapshot(signature,result){
    return {key:'geometry:zones-v1',type:'zone-snapshot',version:1,signature,
      zones:[...result.zones],adjusted:[...(result.adjusted||[])],anchorCounts:[...(result.anchorCounts||[])],
      sharedAnchors:result.sharedAnchors||0,importedConflicts:result.importedConflicts||0,
      ...(result.coverage?{coverage:result.coverage,baseZones:[...result.baseZones],inferred:[...result.inferred]}:{})};
  }
  function restoreZones(record,signature,organizationIds){
    if(!record||record.type!=='zone-snapshot'||record.version!==1||record.signature!==signature||!Array.isArray(record.zones)||record.zones.length>organizationIds.length)return null;
    const zones=new Map();let points=0;
    for(const entry of record.zones){
      if(!Array.isArray(entry)||entry.length!==2||!organizationIds.includes(entry[0])||zones.has(entry[0]))return null;
      const geometry=entry[1];if(!Array.isArray(geometry)||!geometry.length)return null;
      for(const polygon of geometry){if(!Array.isArray(polygon)||!polygon.length)return null;
        for(const ring of polygon){if(!Array.isArray(ring)||ring.length<4)return null;
          for(const p of ring){if(++points>500000||!Array.isArray(p)||p.length!==2||!p.every(Number.isFinite)||Math.abs(p[0])>180||Math.abs(p[1])>90)return null;}
          if(ring[0][0]!==ring.at(-1)[0]||ring[0][1]!==ring.at(-1)[1])return null;
        }
      }
      zones.set(entry[0],geometry);
    }
    const adjusted=new Set((Array.isArray(record.adjusted)?record.adjusted:[]).filter(id=>organizationIds.includes(id)));
    const anchorCounts=new Map((Array.isArray(record.anchorCounts)?record.anchorCounts:[]).filter(v=>Array.isArray(v)&&organizationIds.includes(v[0])&&Number.isSafeInteger(v[1])&&v[1]>=0));
    const count=v=>Number.isSafeInteger(v)&&v>=0?v:0;
    const result={zones,adjusted,anchorCounts,sharedAnchors:count(record.sharedAnchors),importedConflicts:count(record.importedConflicts)};
    if(record.coverage){
      const c=record.coverage;
      if(c.method!=='nearest-hospital-projected-v1'||typeof c.boundaryId!=='string'||c.boundaryId.length>200||!['regionArea','addedArea','missingArea','outsideArea','overlapArea'].every(k=>Number.isFinite(c[k])&&c[k]>=0)||c.regionArea<=0||c.addedArea>c.regionArea+1e-7||c.missingArea>1e-7||c.outsideArea>1e-7||c.overlapArea>1e-7)return null;
      const part=entries=>restoreZones({type:'zone-snapshot',version:1,signature,zones:entries},signature,organizationIds);
      const original=part(record.baseZones),inferred=part(record.inferred);if(!original||!inferred)return null;
      result.baseZones=original.zones;result.inferred=inferred.zones;result.coverage={...Object.fromEntries(['boundaryId','regionArea','addedArea','missingArea','outsideArea','overlapArea','method'].map(k=>[k,c[k]])),numericalTolerance:1e-7,coLocated:Array.isArray(c.coLocated)?c.coLocated.filter(ids=>Array.isArray(ids)&&ids.every(id=>organizationIds.includes(id))):[]};
    }
    return result;
  }
  const api={read,write,install,checkpoint,location,recordForGroup,recordForOrganization,restore,zoneSnapshot,restoreZones};
  root.HospitalLocalCache=api;
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
