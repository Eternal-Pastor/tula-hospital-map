(function(root,factory){
  const api=factory();if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.HospitalViewer=api;
})(typeof window!=='undefined'?window:globalThis,function(){
  'use strict';
  const COLORS={low:'#27835c',middle:'#bd8a24',high:'#ca5252',missing:'#8b939c'};
  function loadBand(value){return !Number.isFinite(value)||value<0?'missing':value<700?'low':value<=1000?'middle':'high';}
  // Spherical surface area; rings are longitude/latitude, holes subtract.
  function areaKm2(polygons){
    const rad=Math.PI/180,R=6371.0088;
    const ringArea=ring=>{let sum=0;for(let i=1;i<ring.length;i++){const a=ring[i-1],b=ring[i];sum+=(b[0]-a[0])*rad*(2+Math.sin(a[1]*rad)+Math.sin(b[1]*rad));}return Math.abs(sum*R*R/2);};
    return polygons.reduce((sum,p)=>sum+Math.max(0,ringArea(p[0])-p.slice(1).reduce((a,r)=>a+ringArea(r),0)),0);
  }
  function minutes(seconds){return Number.isFinite(seconds)?Math.max(0,Math.round(seconds/60)).toLocaleString('ru-RU')+' мин':'нет данных';}
  function label(name,seconds){return name+' - '+minutes(seconds);}
  function complete(A,cells,baseline,destinations,records,services){
    // Measured baseline cells remain donors after changing grid size. Inferred
    // values never become donors and ownership always stays with the hospital.
    const all=new Map(baseline.map(c=>[c.id,c]));for(const cell of cells)all.set(cell.id,cell);
    const result=A.completeTimes([...all.values()],destinations,records,services);
    return new Map(cells.map(c=>[c.id,result.values.get(c.id)]));
  }
  return {COLORS,loadBand,areaKm2,minutes,label,complete};
});
