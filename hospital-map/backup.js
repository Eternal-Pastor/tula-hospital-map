(function(root,factory){
  'use strict';
  const api=factory(typeof module!=='undefined'&&module.exports?require('./cache.js'):root.HospitalLocalCache,typeof module!=='undefined'&&module.exports?require('./accessibility.js'):root.HospitalAccessibility);
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.HospitalBackup=api;
})(typeof window!=='undefined'?window:globalThis,function(L,A){
  'use strict';
  const TYPE='hospital-map-local-data',MAX_BYTES=100*1024*1024;
  async function digest(value){
    if(!globalThis.crypto?.subtle)throw new Error('Для проверки копии откройте сайт через localhost или HTTPS.');
    const result=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value)));
    return [...new Uint8Array(result)].map(v=>v.toString(16).padStart(2,'0')).join('');
  }
  function summary(records){return {addresses:records.filter(r=>r.type==='rule'&&r.status==='found').length,failed:records.filter(r=>r.type==='rule'&&r.status==='failed').length,hospitals:records.filter(r=>r.type==='org').length,routes:records.filter(r=>r.type==='route').length,zones:records.find(r=>r.key==='geometry:zones-v1')?.zones.length||0,coverageZones:records.find(r=>r.key==='geometry:coverage-v1')?.zones.length||0};}
  function merge(current,incoming){
    const records=new Map();for(const r of [...current,...incoming]){
      const previous=records.get(r.key);
      if(previous?.type==='rule'&&previous.status==='found'&&r.status==='failed')continue;
      if(previous?.type==='route'&&Date.parse(previous.at)>Date.parse(r.at))continue;
      records.set(r.key,r);
    }return [...records.values()];
  }
  async function create({settings,routing,records,dataset}){
    // Callers supply only validated settings and canonical records, never localStorage wholesale.
    const payload=JSON.parse(JSON.stringify({settings,routing,records,dataset}));
    return {type:TYPE,version:2,createdAt:new Date().toISOString(),summary:summary(records),checksum:await digest(payload),payload};
  }
  async function prepare(input,{data,index,validateSettings,validateRouting,dataset}){
    if(!input||input.type!==TYPE||![1,2].includes(input.version))throw new Error('Нужен файл резервной копии проекта версии 1 или 2.');
    const payload=input.version===2?input.payload:input;
    if(input.version===2&&(!payload||input.checksum!==await digest(payload)))throw new Error('Контрольная сумма не совпала. Файл повреждён или изменён; данные не загружены.');
    if(!Array.isArray(payload.records)||payload.records.length>100000)throw new Error('Некорректный список данных резервной копии.');
    const settings=validateSettings(payload.settings||{}),routing=payload.routing?validateRouting(payload.routing):null;
    const restored=L.restore(payload.records,data,index),ids=new Set(data.organizations.map(o=>o.id)),records=[...restored.records];
    let invalid=0;
    for(const value of payload.records){
      if(value?.type==='route'){const r=A.record(value,ids);if(r)records.push(r);else invalid++;}
      else if(value?.type==='zone-snapshot'){
        if(!['geometry:zones-v1','geometry:coverage-v1'].includes(value.key)||typeof value.signature!=='string'||value.signature.length>8*1024*1024)throw new Error('Некорректный снимок векторов.');
        const result=L.restoreZones(value,value.signature,[...ids]);if(!result||value.key==='geometry:coverage-v1'&&!result.coverage)throw new Error('В резервной копии повреждены векторные зоны.');
        records.push({...L.zoneSnapshot(value.signature,result),key:value.key});
      }else if(value?.type!=='rule'&&value?.type!=='org')invalid++;
    }
    const clean=merge([],records);invalid+=payload.records.filter(r=>r?.type==='rule'||r?.type==='org').length-restored.records.length;
    if(payload.records.length&&!clean.length)throw new Error('В копии нет подходящих данных для этого проекта.');
    return {settings,routing,records:clean,createdAt:input.createdAt||null,summary:summary(clean),invalid,datasetMismatch:input.version===2&&payload.dataset!==dataset,legacy:input.version===1};
  }
  return {MAX_BYTES,digest,summary,merge,create,prepare};
});
