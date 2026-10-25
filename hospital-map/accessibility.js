(function(root,factory){
  'use strict';
  const api=factory(typeof module!=='undefined'&&module.exports?require('./zones.js'):root.HospitalZones);
  root.HospitalAccessibility=api;if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof window!=='undefined'?window:globalThis,function(Z){
  'use strict';
  const MODES=['auto','pedestrian','masstransit'];
  const LABELS={auto:'На машине',pedestrian:'Пешком',masstransit:'Общественный транспорт',average:'Среднее трёх способов'};
  const COLORS=['#2f9e62','#d8b42a','#e48335','#d64a4a','#9ba6aa'];
  const METERS=111195,COS=Math.cos(54*Math.PI/180);
  const xy=([lon,lat])=>[(lon-37)*METERS*COS,(lat-54)*METERS];
  const ll=([x,y])=>[37+x/METERS/COS,54+y/METERS];
  function inRing([x,y],ring){let inside=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){
    const a=ring[i],b=ring[j];if((a[1]>y)!==(b[1]>y)&&x<(b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0])inside=!inside;
  }return inside;}
  const inside=(point,polygon)=>inRing(point,polygon[0])&&!polygon.slice(1).some(r=>inRing(point,r));
  // Find a point strictly inside a polygon, including concave and holed fragments.
  function interior(polygon){
    const ring=polygon[0],ys=[...new Set(ring.map(p=>p[1]))].sort((a,b)=>a-b),candidates=[];
    for(let i=1;i<ys.length;i++)candidates.push((ys[i]+ys[i-1])/2);
    let best=null,width=-1;
    for(const y of candidates){const xs=[];for(const r of polygon)for(let i=1;i<r.length;i++){
      const a=r[i-1],b=r[i];if((a[1]>y)!==(b[1]>y))xs.push(a[0]+(y-a[1])*(b[0]-a[0])/(b[1]-a[1]));
    }xs.sort((a,b)=>a-b);for(let i=1;i<xs.length;i++){const p=[(xs[i]+xs[i-1])/2,y],w=xs[i]-xs[i-1];if(w>width&&inside(p,polygon)){best=p;width=w;}}}
    if(!best)throw new Error('Не удалось найти точку внутри ячейки.');return best;
  }
  function grid(zones,step=1000,maxCells=2500){
    if(![250,500,1000,2000,5000,10000,20000].includes(step))throw new Error('Недопустимый размер ячейки.');
    const cells=[];let checks=0;
    for(const [organizationId,geometry] of zones)for(let p=0;p<geometry.length;p++){
      const polygon=geometry[p],points=polygon[0].map(xy),xs=points.map(p=>p[0]),ys=points.map(p=>p[1]);
      const a=Math.floor(Math.min(...xs)/step),b=Math.floor(Math.max(...xs)/step),c=Math.floor(Math.min(...ys)/step),d=Math.floor(Math.max(...ys)/step);
      if((b-a+1)*(d-c+1)>150000)throw new Error('Слишком мелкая сетка для этой зоны. Выберите больший шаг.');
      for(let x=a;x<=b;x++)for(let y=c;y<=d;y++){
        if(++checks>300000)throw new Error('Слишком мелкая сетка. Увеличьте шаг или выберите одну больницу.');
        const box=[[x*step,y*step],[(x+1)*step,y*step],[(x+1)*step,(y+1)*step],[x*step,(y+1)*step],[x*step,y*step]].map(ll);
        const cut=Z.intersection([polygon],[[box]]);
        for(let q=0;q<cut.length;q++)if(Z.area([cut[q]])>1e-12){
          if(cells.length>=maxCells)throw new Error('Больше '+maxCells+' ячеек. Увеличьте шаг или выберите одну больницу.');
          const center=ll([(x+.5)*step,(y+.5)*step]),origin=inside(center,cut[q])?center:interior(cut[q]);
          cells.push({id:[organizationId,step,x,y,p,q].join(':'),organizationId,origin:[origin[1],origin[0]],geometry:cut[q]});
        }
      }
    }
    return {cells,step};
  }
  const validPoint=p=>Array.isArray(p)&&p.length===2&&p.every(Number.isFinite)&&Math.abs(p[0])<=90&&Math.abs(p[1])<=180;
  const pointKey=p=>p.map(v=>Number(v).toFixed(6)).join(',');
  function routeKey(organizationId,origin,destination,mode,service=''){return [service?'route-external-v1|'+encodeURIComponent(service):'route-v1',organizationId,pointKey(origin),pointKey(destination),mode].join('|');}
  function record(value,knownIds){
    if(!value||value.type!=='route'||!knownIds.has(value.organizationId)||!MODES.includes(value.mode)||!validPoint(value.origin)||!validPoint(value.destination)||!['found','unreachable'].includes(value.status)||!Number.isFinite(Date.parse(value.at)))return null;
    if(value.status==='found'&&(!Number.isFinite(value.seconds)||value.seconds<0||value.seconds>604800))return null;
    const lines=value.lines||[];if(!Array.isArray(lines)||lines.length>500||lines.some(l=>!Array.isArray(l)||l.length>30000||l.some(p=>!validPoint(p))))return null;
    const provider=['http','osrm'].includes(value.provider)?value.provider:'jsapi';let service='';
    if(provider==='osrm'){
      if(!['auto','pedestrian'].includes(value.mode)||typeof value.routingService!=='string'||value.routingService.length>500)return null;
      try{const u=new URL(value.routingService);if(!['https:','http:'].includes(u.protocol)||u.username||u.password||u.search||u.hash||!/\/route\/v1\/[^/]+$/.test(u.pathname))return null;service=u.href;}catch(_){return null;}
    }
    const key=routeKey(value.organizationId,value.origin,value.destination,value.mode,service);
    return {key,type:'route',organizationId:value.organizationId,origin:value.origin.slice(),destination:value.destination.slice(),mode:value.mode,status:value.status,seconds:value.status==='found'?value.seconds:null,lines,at:new Date(value.at).toISOString(),provider,trafficType:service?'disabled':['realtime','forecast','disabled'].includes(value.trafficType)?value.trafficType:'unknown',...(service?{routingService:service,routeReason:['NoSegment','NoRoute'].includes(value.routeReason)?value.routeReason:'',snapDistances:Array.isArray(value.snapDistances)&&value.snapDistances.length===2&&value.snapDistances.every(v=>Number.isFinite(v)&&v>=0&&v<=1001)?value.snapDistances.slice():[]}: {})};
  }
  function cellRoutes(cell,destination,records,services=null){return Object.fromEntries(MODES.map(mode=>[mode,destination&&(!services||services[mode])?records.get(routeKey(cell.organizationId,cell.origin,destination,mode,services?.[mode])):null]));}
  function time(routes,mode){
    if(mode==='average'){const values=MODES.map(m=>routes[m]);return values.every(v=>v?.status==='found')?values.reduce((sum,v)=>sum+v.seconds,0)/3:null;}
    return routes[mode]?.status==='found'?routes[mode].seconds:null;
  }
  function band(seconds){return seconds===null||!Number.isFinite(seconds)?4:seconds<=900?0:seconds<=1800?1:seconds<=3600?2:3;}
  function bands(items){
    const groups=new Map();for(const item of items){const key=item.organizationId+'|'+item.band;if(!groups.has(key))groups.set(key,{organizationId:item.organizationId,band:item.band,parts:[]});groups.get(key).parts.push([item.geometry]);}
    return [...groups.values()].map(g=>({organizationId:g.organizationId,band:g.band,geometry:Z.union(...g.parts)}));
  }
  function pending(cells,destinations,records,modes=MODES,services=null){const jobs=[];for(const cell of cells){const destination=destinations.get(cell.organizationId);if(!destination)continue;for(const mode of modes){if(services&&!services[mode])continue;const key=routeKey(cell.organizationId,cell.origin,destination,mode,services?.[mode]);if(!records.has(key))jobs.push({key,cell,destination:destination.slice(),mode});}}return jobs;}
  const MODEL={auto:35,pedestrian:4.5,masstransit:18,detour:1.3,wait:10};
  function modelOptions(input={}){const out={...MODEL};for(const key of Object.keys(MODEL)){const v=Number(input[key]);if(Number.isFinite(v)&&(key==='wait'?v>=0&&v<=180:key==='detour'?v>=1&&v<=5:v>0&&v<=200))out[key]=v;}return out;}
  function estimate(origin,destination,parameters=MODEL){
    if(!validPoint(origin)||!validPoint(destination))return {};
    const p=modelOptions(parameters),rad=Math.PI/180,a=origin.map(v=>v*rad),b=destination.map(v=>v*rad),h=Math.sin((b[0]-a[0])/2)**2+Math.cos(a[0])*Math.cos(b[0])*Math.sin((b[1]-a[1])/2)**2,km=6371*2*Math.asin(Math.sqrt(Math.min(1,h)));
    return Object.fromEntries(MODES.map(mode=>[mode,{status:'found',seconds:km*p.detour/p[mode]*3600+(mode==='masstransit'&&km>.005?p.wait*60:0),lines:[[origin,destination]],model:true}]));
  }
  function completeTimes(cells,destinations,records,services){
    const modes=['auto','pedestrian'],values=new Map(),donors=new Map(),summary=Object.fromEntries(modes.map(mode=>[mode,{measured:0,neighbor:0,distance:0,missing:0}]));
    for(const cell of cells){
      const routes=cellRoutes(cell,destinations.get(cell.organizationId),records,services),entry={};values.set(cell.id,entry);
      for(const mode of modes){
        const r=routes[mode];if(r?.status!=='found')continue;
        entry[mode]={seconds:r.seconds,source:'osrm',routeStatus:'found',donors:[]};summary[mode].measured++;
        const key=cell.organizationId+'|'+mode;if(!donors.has(key))donors.set(key,[]);donors.get(key).push({cell,seconds:r.seconds});
      }
    }
    // Only measured values are donors: inferred cells never amplify each other.
    for(const cell of cells)for(const mode of modes){
      const entry=values.get(cell.id);if(entry[mode])continue;
      const raw=cellRoutes(cell,destinations.get(cell.organizationId),records,services)[mode],routeStatus=raw?.status||'missing';
      const nearby=(donors.get(cell.organizationId+'|'+mode)||[]).map(d=>({...d,d2:((cell.origin[0]-d.cell.origin[0])*METERS)**2+((cell.origin[1]-d.cell.origin[1])*METERS*COS)**2})).sort((a,b)=>a.d2-b.d2||a.cell.id.localeCompare(b.cell.id)).slice(0,4);
      if(nearby.length){
        const exact=nearby[0].d2<.01,chosen=exact?nearby.slice(0,1):nearby,weights=chosen.map(d=>1/Math.max(d.d2,.01)),total=weights.reduce((a,b)=>a+b,0);
        entry[mode]={seconds:chosen.reduce((sum,d,i)=>sum+d.seconds*weights[i]/total,0),source:'neighbor',routeStatus,routeReason:raw?.routeReason||'',nearestMeters:Math.sqrt(chosen[0].d2),donors:chosen.map((d,i)=>({id:d.cell.id,weight:weights[i]/total}))};summary[mode].neighbor++;
      }else{
        const fallback=estimate(cell.origin,destinations.get(cell.organizationId))[mode];
        entry[mode]={seconds:fallback?.seconds??null,source:fallback?'distance':'missing',routeStatus,routeReason:raw?.routeReason||'',donors:[]};summary[mode][fallback?'distance':'missing']++;
      }
    }
    return {values,summary,method:'same-hospital-idw4-v1'};
  }
  return {MODES,LABELS,COLORS,MODEL,modelOptions,estimate,completeTimes,grid,interior,inside,validPoint,routeKey,record,cellRoutes,time,band,bands,pending};
});
