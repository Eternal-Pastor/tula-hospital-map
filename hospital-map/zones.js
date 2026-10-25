(function(root,factory){
  'use strict';
  const api=typeof module!=='undefined'&&module.exports?factory(require('./vendor/d3-delaunay.min.js'),require('./vendor/clipper.js'),require('./territories.js')):factory(root.d3,root.ClipperLib,root.HospitalTerritories);
  root.HospitalZones=api;if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof window!=='undefined'?window:globalThis,function(d3,C,T){
  'use strict';
  const SCALE=Math.cos(54*Math.PI/180),EPS=1e-12;
  const boundCache=new WeakMap();
  const snap=([x,y])=>[Math.round(x*1e7)/1e7,Math.round(y*1e7)/1e7];
  const project=([lon,lat])=>snap([lon-37,lat-54]);
  const unproject=([x,y])=>[x+37,y+54];
  const transform=(geometry,point)=>geometry.map(polygon=>polygon.map(ring=>ring.map(point)));
  // Integer clipping at about 1 cm precision avoids floating-point overlay slivers.
  const INTEGER_SCALE=1e7;
  function paths(geometry){
    if(!geometry.length)return [];
    const multi=typeof geometry[0][0][0]==='number'?[geometry]:geometry;
    return multi.flatMap(polygon=>polygon.map((ring,index)=>{
      const path=ring.map(([x,y])=>({X:Math.round(x*INTEGER_SCALE),Y:Math.round(y*INTEGER_SCALE)}));
      if(path.length>1&&path[0].X===path.at(-1).X&&path[0].Y===path.at(-1).Y)path.pop();
      if(C.Clipper.Orientation(path)!==(index===0))path.reverse();return path;
    })).filter(path=>path.length>=3);
  }
  function operation(type,subject,clips=[]){
    return executePaths(type,paths(subject),clips.flatMap(paths));
  }
  function executePaths(type,subjects,clipping=[]){
    const engine=new C.Clipper(C.Clipper.ioStrictlySimple),tree=new C.PolyTree();
    if(!subjects.length)return [];
    engine.AddPaths(subjects,C.PolyType.ptSubject,true);
    if(clipping.length)engine.AddPaths(clipping,C.PolyType.ptClip,true);
    if(!engine.Execute(type,tree,C.PolyFillType.pftNonZero,C.PolyFillType.pftNonZero))throw new Error('Не удалось разделить векторные зоны.');
    return fromTree(tree);
  }
  function fromTree(tree){
    const ring=path=>{const points=path.map(p=>[p.X/INTEGER_SCALE,p.Y/INTEGER_SCALE]);points.push(points[0].slice());return points;};
    return C.JS.PolyTreeToExPolygons(tree).map(polygon=>[ring(polygon.outer),...polygon.holes.map(ring)]);
  }
  function inset(geometry){
    if(!geometry.length)return [];
    const engine=new C.ClipperOffset(2,.25),tree=new C.PolyTree();
    engine.AddPaths(paths(geometry),C.JoinType.jtMiter,C.EndType.etClosedPolygon);
    // A sub-meter display gap also prevents boundary contact and rounding slivers.
    engine.Execute(tree,-30);return fromTree(tree);
  }
  const clip={
    union:(...geometries)=>operation(C.ClipType.ctUnion,geometries.flatMap(geometry=>typeof geometry[0]?.[0]?.[0]==='number'?[geometry]:geometry)),
    intersection:(a,b)=>b.length?operation(C.ClipType.ctIntersection,a,[b]):[],
    difference:(a,...b)=>operation(C.ClipType.ctDifference,a,b)
  };
  function area(geometry){
    function ringArea(ring){let a=0;for(let i=1;i<ring.length;i++)a+=ring[i-1][0]*ring[i][1]-ring[i][0]*ring[i-1][1];return Math.abs(a)/2;}
    return geometry.reduce((sum,polygon)=>sum+ringArea(polygon[0])-polygon.slice(1).reduce((holes,ring)=>holes+ringArea(ring),0),0);
  }
  function bounds(geometry){
    if(boundCache.has(geometry))return boundCache.get(geometry);
    let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
    for(const polygon of geometry)for(const ring of polygon)for(const [x,y] of ring){x0=Math.min(x0,x);y0=Math.min(y0,y);x1=Math.max(x1,x);y1=Math.max(y1,y);}
    const result=x0===Infinity?null:[x0,y0,x1,y1];boundCache.set(geometry,result);return result;
  }
  function intersects(a,b){return a&&b&&a[0]<b[2]&&b[0]<a[2]&&a[1]<b[3]&&b[1]<a[3];}
  function intersection(a,b){return intersects(bounds(a),bounds(b))?clip.intersection(a,b):[];}
  function merge(parts){return parts.length?clip.union(...parts):[];}
  // Voronoi cells tile the plane. Cancel their opposite shared edges before
  // clipping: interior edges need no general-purpose polygon union at all.
  function stitchCells(parts,outline,onProgress){
    const edges=new Map(),key=p=>p.X+','+p.Y;
    for(let i=0;i<parts.length;i++){
      for(const path of paths(parts[i]))for(let j=0;j<path.length;j++){
        const a=path[j],b=path[(j+1)%path.length],ak=key(a),bk=key(b);if(ak===bk)continue;
        const forward=ak+'/'+bk,reverse=bk+'/'+ak;
        if(edges.has(reverse))edges.delete(reverse);
        else if(edges.has(forward))return null;
        else edges.set(forward,{a,b,ak,bk});
      }
      if(i%24===0||i===parts.length-1)onProgress({operation:'trace-edges',fragmentCompleted:i+1,fragmentTotal:parts.length});
    }
    const outgoing=new Map(),incoming=new Map();
    for(const edge of edges.values()){
      if(!outgoing.has(edge.ak))outgoing.set(edge.ak,[]);outgoing.get(edge.ak).push(edge);
      incoming.set(edge.bk,(incoming.get(edge.bk)||0)+1);
    }
    for(const [vertex,list] of outgoing)if(list.length!==incoming.get(vertex))return null;
    const used=new Set(),rings=[],tau=Math.PI*2;let walked=0;
    onProgress({operation:'trace-rings',edgeCompleted:0,edgeTotal:edges.size});
    for(const start of edges.values()){
      if(used.has(start))continue;
      const ring=[];let edge=start;
      while(edge&&!used.has(edge)){
        used.add(edge);ring.push(edge.a);walked++;
        if(walked%128===0)onProgress({operation:'trace-rings',edgeCompleted:walked,edgeTotal:edges.size});
        if(edge.bk===start.ak)break;
        const candidates=(outgoing.get(edge.bk)||[]).filter(e=>!used.has(e));
        const back=Math.atan2(edge.a.Y-edge.b.Y,edge.a.X-edge.b.X);
        let next=null,angle=Infinity;
        for(const candidate of candidates){
          const turn=(back-Math.atan2(candidate.b.Y-candidate.a.Y,candidate.b.X-candidate.a.X)+tau)%tau;
          if(turn<angle){next=candidate;angle=turn;}
        }
        edge=next;
      }
      if(!edge||edge.bk!==start.ak)return null;
      if(ring.length>=3&&Math.abs(C.Clipper.Area(ring))>0)rings.push(ring);
    }
    onProgress({operation:'trace-rings',edgeCompleted:walked,edgeTotal:edges.size});
    onProgress({operation:'clip-outline',fragmentCompleted:parts.length,fragmentTotal:parts.length,boundaryEdges:walked});
    return rings.length?executePaths(C.ClipType.ctIntersection,rings,paths(outline)):[];
  }
  // Prefer boundary stitching. If snapped edges are ambiguous, clip individual
  // cells and dissolve spatially ordered batches instead of one giant union.
  function mergeCells(parts,outline,onProgress=()=>{}){
    if(!outline.length||!parts.length)return [];
    const stitched=stitchCells(parts,outline,onProgress);if(stitched!==null)return stitched;
    const batchSize=24,clipped=[];
    for(let i=0;i<parts.length;i++){
      const shape=clip.intersection(parts[i],outline);if(shape.length)clipped.push(shape);
      if(i%24===0||i===parts.length-1)onProgress({operation:'clip-cells',fragmentCompleted:i+1,fragmentTotal:parts.length});
    }
    let level=clipped,pass=0;
    while(level.length>1){
      const next=[],total=Math.ceil(level.length/batchSize);pass++;
      onProgress({operation:'batch-union',pass,batchCompleted:0,batchTotal:total,fragmentTotal:parts.length});
      for(let i=0;i<level.length;i+=batchSize){
        const group=level.slice(i,i+batchSize);next.push(group.length===1?group[0]:clip.union(...group));
        onProgress({operation:'batch-union',pass,batchCompleted:next.length,batchTotal:total,fragmentTotal:parts.length});
      }
      level=next;
    }
    return level[0]||[];
  }
  function partition(organizations,{onProgress=()=>{}}={}){
    const input=organizations.slice().sort((a,b)=>a.id.localeCompare(b.id)),raw=new Map(),imported=new Set(),adjusted=new Set(),seeds=new Map();
    const report=(stage,completed,total,organizationId,detail={})=>onProgress({stage,completed,total,organizationId,...detail});
    let prepared=0;report('prepare',0,input.length);
    for(const organization of input){
      const supplied=(organization.geometries||[]).filter(g=>g.type==='Polygon'||g.type==='MultiPolygon');
      if(supplied.length){
        raw.set(organization.id,merge(supplied.map(g=>transform(g.type==='Polygon'?[g.coordinates]:g.coordinates,project))));
        imported.add(organization.id);
      } else {
        const ring=T.coverageRing(organization.anchors||[]);
        if(ring)raw.set(organization.id,[[ring.map(([lat,lon])=>project([lon,lat]))]]);
        for(const anchor of organization.anchors||[]){
          if(!Array.isArray(anchor.coords)||anchor.coords.length!==2||!anchor.coords.every(Number.isFinite))continue;
          const point=project([anchor.coords[1],anchor.coords[0]]),key=point.join(',');
          if(!seeds.has(key))seeds.set(key,{point,owners:new Set()});
          seeds.get(key).owners.add(organization.id);
        }
      }
      report('prepare',++prepared,input.length,organization.id);
    }
    const output=new Map(raw),importedIds=[...imported],importCuts=new Map();let importedConflicts=0;
    let checked=0;report('imports',0,importedIds.length*(importedIds.length-1)/2);
    for(let i=0;i<importedIds.length;i++)for(let j=i+1;j<importedIds.length;j++){
      const a=importedIds[i],b=importedIds[j],overlap=intersection(raw.get(a),raw.get(b));
      report('imports',++checked,importedIds.length*(importedIds.length-1)/2);
      if(area(overlap)<=EPS)continue;
      importedConflicts++;
      for(const id of [a,b]){if(!importCuts.has(id))importCuts.set(id,[]);importCuts.get(id).push(overlap);adjusted.add(id);}
    }
    for(const [id,cuts] of importCuts)output.set(id,clip.difference(raw.get(id),...cuts));
    const reserved=merge(importedIds.map(id=>raw.get(id))),generated=[...raw.keys()].filter(id=>!imported.has(id));
    report('overlaps',0,generated.length*(generated.length-1)/2);checked=0;
    for(const id of generated)if(reserved.length){const trimmed=clip.difference(raw.get(id),reserved);if(Math.abs(area(trimmed)-area(raw.get(id)))>EPS)adjusted.add(id);output.set(id,trimmed);}
    const affected=new Set();
    for(let i=0;i<generated.length;i++)for(let j=i+1;j<generated.length;j++){
      const a=generated[i],b=generated[j];
      if(area(intersection(output.get(a),output.get(b)))>EPS){affected.add(a);affected.add(b);}
      report('overlaps',++checked,generated.length*(generated.length-1)/2);
    }
    const sharedAnchors=[...seeds.values()].filter(seed=>seed.owners.size>1).length;
    if(affected.size){
      const entries=[...seeds.values()].sort((a,b)=>a.point[0]-b.point[0]||a.point[1]-b.point[1]);
      const box=bounds([...raw.values()].flat());
      report('triangulation',0,entries.length);
      const voronoi=d3.Delaunay.from(entries,seed=>seed.point[0]*SCALE,seed=>seed.point[1]).voronoi([(box[0]-.01)*SCALE,box[1]-.01,(box[2]+.01)*SCALE,box[3]+.01]);
      const cells=new Map([...affected].map(id=>[id,[]]));
      report('cells',0,entries.length);
      entries.forEach((seed,index)=>{
        if(index%100===0||index===entries.length-1)report('cells',index+1,entries.length);
        // Shared street/locality centers do not establish ownership of individual homes.
        if(seed.owners.size!==1)return;
        const id=[...seed.owners][0];if(!cells.has(id))return;
        const cell=voronoi.cellPolygon(index);if(cell)cells.get(id).push([cell.map(([x,y])=>snap([x/SCALE,y]))]);
      });
      let merged=0;report('merge',0,cells.size);
      for(const [id,parts] of cells){
        report('merge',merged,cells.size,id);
        const owned=mergeCells(parts,output.get(id),detail=>report('merge',merged,cells.size,id,detail));
        output.set(id,owned);adjusted.add(id);
        report('merge',++merged,cells.size,id);
      }
    }
    // Postcondition applies to imports as well; never fall back to overlapping hulls.
    const ids=[...output.keys()],cuts=new Map();
    report('cleanup',0,ids.length*(ids.length-1)/2);checked=0;
    for(let i=0;i<ids.length;i++)for(let j=i+1;j<ids.length;j++){
      const a=ids[i],b=ids[j],overlap=intersection(output.get(a),output.get(b));
      report('cleanup',++checked,ids.length*(ids.length-1)/2);
      if(area(overlap)<=EPS)continue;
      for(const id of [a,b]){if(!cuts.has(id))cuts.set(id,[]);cuts.get(id).push(overlap);adjusted.add(id);}
    }
    for(const [id,parts] of cuts)output.set(id,clip.difference(output.get(id),...parts));
    const separated=new Map();let insetCount=0;report('gap',0,output.size);for(const [id,geometry] of output){const shape=inset(geometry);if(area(shape)>EPS)separated.set(id,shape);report('gap',++insetCount,output.size,id);}
    const separatedIds=[...separated.keys()];
    report('verify',0,separatedIds.length*(separatedIds.length-1)/2);checked=0;
    for(let i=0;i<separatedIds.length;i++)for(let j=i+1;j<separatedIds.length;j++){
      if(area(intersection(separated.get(separatedIds[i]),separated.get(separatedIds[j])))>0)throw new Error('Проверка зон обнаружила наложение; контуры скрыты до уточнения геометрии.');
      report('verify',++checked,separatedIds.length*(separatedIds.length-1)/2);
    }
    const zones=new Map([...separated].map(([id,geometry])=>[id,transform(geometry,unproject)]));
    report('done',zones.size,zones.size);
    return {zones,adjusted,sharedAnchors,importedConflicts};
  }
  function completeCoverage(organizations,{boundary,baseZones=new Map(),onProgress=()=>{}}={}){
    const geometry=boundary?.geometry||boundary;
    if(!geometry||!['Polygon','MultiPolygon'].includes(geometry.type))throw new Error('Нет полигональной границы области.');
    const supplied=geometry.type==='Polygon'?[geometry.coordinates]:geometry.coordinates;
    if(!Array.isArray(supplied)||!supplied.length)throw new Error('Пустая граница области.');
    for(const polygon of supplied)for(const ring of polygon){
      if(!Array.isArray(ring)||ring.length<4||ring.some(p=>!Array.isArray(p)||p.length!==2||!p.every(Number.isFinite)||Math.abs(p[0])>180||Math.abs(p[1])>90)||ring[0][0]!==ring.at(-1)[0]||ring[0][1]!==ring.at(-1)[1])throw new Error('Некорректная граница области.');
    }
    onProgress({stage:'coverage-boundary',completed:0,total:1});
    const region=clip.union(transform(supplied,project)),regionArea=area(region),box=bounds(region);
    if(!box||regionArea<=EPS)throw new Error('Граница области не содержит площади.');
    const centers=new Map(),byId=new Map(organizations.map(o=>[o.id,o]));
    for(const o of organizations.slice().sort((a,b)=>a.id.localeCompare(b.id))){
      const p=o.coords;if(!Array.isArray(p)||p.length!==2||!p.every(Number.isFinite)||Math.abs(p[0])>90||Math.abs(p[1])>180)continue;
      const point=project([p[1],p[0]]),key=point.join(',');
      if(!centers.has(key))centers.set(key,{id:o.id,point,ids:[o.id]});else centers.get(key).ids.push(o.id);
    }
    if(!centers.size)throw new Error('У больниц отсутствуют проверенные координаты.');
    const base=new Map();let n=0;onProgress({stage:'coverage-clip',completed:0,total:baseZones.size});
    for(const [id,shape] of baseZones){if(!byId.has(id))continue;const cut=clip.intersection(transform(shape,project),region);if(area(cut)>EPS)base.set(id,cut);onProgress({stage:'coverage-clip',completed:++n,total:baseZones.size,organizationId:id});}
    const occupied=merge([...base.values()]),gaps=clip.difference(region,occupied),addedArea=area(gaps);
    const seeds=[...centers.values()],voronoi=d3.Delaunay.from(seeds,s=>s.point[0]*SCALE,s=>s.point[1]).voronoi([(box[0]-.01)*SCALE,box[1]-.01,(box[2]+.01)*SCALE,box[3]+.01]);
    const inferred=new Map(),output=new Map(base);onProgress({stage:'coverage-fill',completed:0,total:seeds.length});
    for(let i=0;i<seeds.length;i++){
      const seed=seeds[i],cell=voronoi.cellPolygon(i);
      onProgress({stage:'coverage-fill',completed:i,total:seeds.length,organizationId:seed.id,operation:'intersect'});
      const fill=cell?clip.intersection([[cell.map(([x,y])=>snap([x/SCALE,y]))]],gaps):[];
      onProgress({stage:'coverage-fill',completed:i,total:seeds.length,organizationId:seed.id,operation:'union'});
      if(area(fill)>EPS){inferred.set(seed.id,fill);output.set(seed.id,clip.union(output.get(seed.id)||[],fill));}
      onProgress({stage:'coverage-fill',completed:i+1,total:seeds.length,organizationId:seed.id});
    }
    // Avoid dissolving all touching boundaries into one enormous strict-simple
    // union. Subtracting each owner gives the same coverage check incrementally.
    let remaining=region,outsideArea=0;n=0;
    onProgress({stage:'coverage-mask',completed:0,total:output.size});
    for(const shape of output.values()){
      remaining=clip.difference(remaining,shape);outsideArea+=area(clip.difference(shape,region));
      onProgress({stage:'coverage-mask',completed:++n,total:output.size});
    }
    const missingArea=area(remaining),entries=[...output],total=entries.length*(entries.length-1)/2;let overlapArea=0; n=0;
    onProgress({stage:'coverage-verify',completed:0,total});
    for(let i=0;i<entries.length;i++)for(let j=i+1;j<entries.length;j++){
      overlapArea+=area(intersection(entries[i][1],entries[j][1]));onProgress({stage:'coverage-verify',completed:++n,total});
    }
    // Centimetre integer rounding at polygon intersections produces tiny edge
    // slivers. Reject errors above 1e-7 square degrees (~730 m² region-wide).
    const numericalTolerance=1e-7;
    if(missingArea>numericalTolerance||outsideArea>numericalTolerance||overlapArea>numericalTolerance)throw new Error('Проверка полного покрытия не пройдена: обнаружены пробелы, выход за область или наложения. Исходные зоны сохранены.');
    const geographic=map=>new Map([...map].map(([id,shape])=>[id,transform(shape,unproject)]));
    return {zones:geographic(output),baseZones:geographic(base),inferred:geographic(inferred),adjusted:new Set(inferred.keys()),sharedAnchors:0,importedConflicts:0,
      coverage:{boundaryId:String(boundary?.properties?.id||'custom'),regionArea,addedArea,missingArea,outsideArea,overlapArea,numericalTolerance,coLocated:seeds.filter(s=>s.ids.length>1).map(s=>s.ids),method:'nearest-hospital-projected-v1'}};
  }
  return {partition,completeCoverage,area,intersection:clip.intersection,union:clip.union,difference:clip.difference};
});
