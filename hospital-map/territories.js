(function(root){
  'use strict';
  function normalizeAddress(value){return String(value||'').toLocaleLowerCase('ru').replace(/ё/g,'е').replace(/\s+/g,' ').trim();}
  function index(data){
    const byOrganization=new Map(),byAddress=new Map();
    for(const organization of data.organizations){
      const groups=new Map();
      for(const territory of organization.territories)for(const rule of territory.rules){
        const key=normalizeAddress(rule.address);
        if(!groups.has(key))groups.set(key,{id:organization.id+'::'+key,organizationId:organization.id,address:rule.address,key,rules:[]});
        groups.get(key).rules.push({...rule,table:territory.table,category:territory.category});
      }
      const entries=[...groups.values()];
      byOrganization.set(organization.id,entries);
      for(const group of entries){
        if(!byAddress.has(group.key))byAddress.set(group.key,[]);
        byAddress.get(group.key).push(group);
      }
    }
    const shared=[...byAddress.values()].filter(groups=>groups.length>1);
    return {byOrganization,byAddress,shared,organizationCount:[...byOrganization.values()].filter(groups=>groups.length).length,addressCount:byAddress.size};
  }
  function coverage(groups,locations,attempts){
    const found=groups.filter(group=>locations.has(group.id)).length;
    const failed=groups.filter(group=>attempts.has(group.id)&&!locations.has(group.id)).length;
    return {total:groups.length,found,failed,remaining:groups.length-found-failed};
  }
  // Round-robin ordering gives every hospital a turn before large address lists.
  function pendingAddressGroups(index,locations,attempts){
    const lists=[...index.byOrganization.values()].map(groups=>groups.filter(g=>!locations.has(g.id)&&!attempts.has(g.id)));
    const queue=[];
    for(let i=0;lists.some(list=>i<list.length);i++)for(const list of lists)if(list[i])queue.push(list[i]);
    return queue;
  }
  function serviceError(error){
    return /403|401|429|key|denied|forbidden|отклонил|quota|limit|квот|лимит|Failed to fetch|NetworkError|AbortError|Время ожидания|timed? ?out/i.test(String(error.name||'')+' '+String(error.message||error));
  }
  function transientError(error){
    if([401,403,429].includes(error.status)||/HTTP (401|403|429)|Invalid api key/i.test(error.message||''))return false;
    return error.status>=500||/TimeoutError|AbortError|NetworkError|Failed to fetch|Load failed|Время ожидания|не ответил за/i.test(String(error.name||'')+' '+String(error.message||error));
  }
  async function retryRequest(request,{attempts=3,shouldStop=()=>false,onRetry=()=>{},pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
    for(let attempt=1;attempt<=attempts;attempt++){
      if(shouldStop())throw Object.assign(new Error('Поиск остановлен пользователем.'),{name:'AbortError',code:'SEARCH_CANCELLED'});
      try {return await request();}
      catch(error){
        if(shouldStop()||!transientError(error)||attempt===attempts)throw error;
        const delay=attempt*700;onRetry(attempt+1,attempts,error);await pause(delay);
      }
    }
  }
  function paceRequests({interval=200,shouldStop=()=>false}={}){
    let gate=Promise.resolve(),last=0;
    return async request=>{
      const turn=gate.then(async()=>{
        const delay=last+interval-Date.now();if(delay>0)await new Promise(resolve=>setTimeout(resolve,delay));
        if(shouldStop())throw Object.assign(new Error('Поиск остановлен пользователем.'),{name:'AbortError',code:'SEARCH_CANCELLED'});
        last=Date.now();
      });
      gate=turn.catch(()=>{});await turn;return request();
    };
  }
  function createGeocoderCache(lookup,{values=new Map()}={}){
    const pending=new Map();
    function get(query,{refresh=false}={}){
      const key=normalizeAddress(query);
      if(!refresh&&values.has(key))return Promise.resolve(values.get(key));
      if(!refresh&&pending.has(key))return pending.get(key);
      let request;
      request=Promise.resolve().then(()=>lookup(query)).then(result=>{values.set(key,result);return result;}).finally(()=>{if(pending.get(key)===request)pending.delete(key);});
      if(!refresh)pending.set(key,request);
      return request;
    }
    return {get};
  }
  async function searchAddressGroups(groups,{lookup,locations,attempts,failures,shouldStop=()=>false,onResult=async()=>{},onProgress=()=>{},concurrency=1,minInterval=0,wait,pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))}){
    const result={processed:0,found:0,failed:0,stopped:false};
    const workers=Math.min(8,Math.max(1,Math.floor(concurrency)||1)),interval=Math.max(0,Number(minInterval)||0);
    let cursor=0,fatal=null,lastStart=0,scheduler=Promise.resolve(),commits=Promise.resolve();
    function claim(){
      const task=scheduler.then(async()=>{
        if(fatal||shouldStop())return null;
        while(cursor<groups.length&&(locations.has(groups[cursor].id)||attempts.has(groups[cursor].id)))cursor++;
        if(cursor>=groups.length)return null;
        const delay=lastStart+interval-Date.now();if(delay>0)await pause(delay);
        if(fatal||shouldStop())return null;
        lastStart=Date.now();return groups[cursor++];
      });
      scheduler=task.catch(()=>{});return task;
    }
    async function worker(){
      try {
        while(true){
          const group=await claim();if(!group)break;
          let location,error;
          try {location=await lookup(group);if(!suitableLocation(group.address,location))throw new Error('Геокодер не подтвердил нужную улицу или населённый пункт.');}
          catch(failure){if(shouldStop()&&(failure.name==='AbortError'||failure.code==='SEARCH_CANCELLED')){result.stopped=true;break;}if(serviceError(failure)||transientError(failure)){fatal=fatal||failure;break;}error=failure;}
          // Serialize commits so visible progress follows durable per-address writes.
          const commit=commits.then(async()=>{
            if(error){attempts.add(group.id);failures.set(group.id,String(error.message||error));result.failed++;}
            else {locations.set(group.id,{...location,...group});failures.delete(group.id);result.found++;}
            await onResult(group);result.processed++;onProgress({...result},group);
          });
          commits=commit.catch(()=>{});await commit;
          if(shouldStop()){result.stopped=true;break;}
          if(wait&&result.processed<groups.length)await wait();
        }
      } catch(error){fatal=fatal||error;}
    }
    // Drain already started requests before reporting stop/error or enabling a new run.
    await Promise.all(Array.from({length:workers},worker));
    result.stopped=result.stopped||shouldStop();
    if(fatal&&!result.stopped)throw fatal;
    return result;
  }
  function suitableLocation(address,location){
    const street=/(?:^|[\s,])(?:ул(?:ица)?|пер(?:еулок)?|пр-?кт|проспект|проезд|пр-д|шоссе|площадь|пл|бульвар|б-р|наб(?:ережная)?)\.?[\s,]/i.test(address);
    return (street?['street','house']:['locality','street','house']).includes(location.kind);
  }
  // Convex hull of address anchors; [latitude, longitude] in and out.
  // Fewer than three distinct, non-collinear anchors cannot define a polygon.
  function coverageRing(locations){
    const unique=new Map();
    for(const {coords} of locations){
      if(!Array.isArray(coords)||coords.length!==2||!coords.every(Number.isFinite)||Math.abs(coords[0])>90||Math.abs(coords[1])>180)continue;
      unique.set(coords.join(','),[coords[1],coords[0]]);
    }
    const points=[...unique.values()].sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
    if(points.length<3)return null;
    const cross=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
    function half(sequence){
      const result=[];
      for(const p of sequence){while(result.length>1&&cross(result[result.length-2],result[result.length-1],p)<=0)result.pop();result.push(p);}
      return result;
    }
    const lower=half(points),upper=half(points.slice().reverse());
    const hull=lower.slice(0,-1).concat(upper.slice(0,-1));
    if(hull.length<3)return null;
    const ring=hull.map(([lon,lat])=>[lat,lon]);
    ring.push(ring[0].slice());
    return ring;
  }
  function fitBounds(locations){
    const points=locations.map(location=>location.coords).filter(coords=>Array.isArray(coords)&&coords.length===2&&coords.every(Number.isFinite));
    if(!points.length)return null;
    return [[Math.min(...points.map(p=>p[0])),Math.min(...points.map(p=>p[1]))],[Math.max(...points.map(p=>p[0])),Math.max(...points.map(p=>p[1]))]];
  }
  function colors(ids){
    const out={};
    [...ids].sort().forEach((id,index)=>{
      const hue=((index*137.508)%360)/60,chroma=.6*(1-Math.abs(2*.42-1)),x=chroma*(1-Math.abs(hue%2-1)),m=.42-chroma/2;
      const rgb=hue<1?[chroma,x,0]:hue<2?[x,chroma,0]:hue<3?[0,chroma,x]:hue<4?[0,x,chroma]:hue<5?[x,0,chroma]:[chroma,0,x];
      out[id]='#'+rgb.map(v=>Math.round((v+m)*255).toString(16).padStart(2,'0')).join('');
    });
    return out;
  }
  const api={normalizeAddress,index,coverage,pendingAddressGroups,serviceError,transientError,retryRequest,paceRequests,createGeocoderCache,searchAddressGroups,suitableLocation,coverageRing,fitBounds,colors};
  root.HospitalTerritories=api;
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
