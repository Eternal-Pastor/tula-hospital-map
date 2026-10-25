(function (root) {
  'use strict';
  const COLORS = {low:'#27835c', middle:'#bd8a24', high:'#ca5252', missing:'#8b939c'};
  function number(value) { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
  function locationFor(org,settings,cached) {
    const supplied=org?.location,manual=settings.coordinates?.[org?.id];
    // A previous manual/search result must not override newly supplied facility coordinates.
    if(manual&&(!supplied||settings.coordinateVersions?.[org.id]===supplied.version))return {coords:manual,kind:'manual',label:'Координаты введены пользователем'};
    if(supplied)return {coords:supplied.coords,kind:'provided',label:'Координаты из файла пользователя · строка '+supplied.sourceRow};
    return cached;
  }
  function populationFor(org, data, settings) {
    const id = Object.prototype.hasOwnProperty.call(settings.populationLinks || {}, org.id) ? settings.populationLinks[org.id] : org.populationId;
    const entry = data.populations.find(p => p.id === id);
    if (!entry) return null;
    const value = Object.prototype.hasOwnProperty.call(settings.populationValues || {}, id) ? settings.populationValues[id] : entry.value;
    return {...entry, value: number(value)};
  }
  function attachedFor(org, includeMixed) {
    return number(includeMixed ? org.attached : org.adultAttached);
  }
  function metric(org, mode, data, settings) {
    const attached = attachedFor(org, settings.includeMixed);
    if (attached === null) return null;
    if (mode === 'absolute') return attached;
    if (mode === 'perArea') {
      const count = org.areas.filter(a => settings.includeMixed || a.category === 'Взрослые').length;
      return count ? attached / count : null;
    }
    const p = populationFor(org, data, settings);
    return p && p.value > 0 ? attached / p.value * 1000 : null;
  }
  function quantile(values, p) {
    const a = values.filter(v => number(v) !== null).sort((x,y) => x-y);
    if (!a.length) return null;
    const i = (a.length-1)*p, lo = Math.floor(i), hi = Math.ceil(i);
    return a[lo]+(a[hi]-a[lo])*(i-lo);
  }
  function scale(data, settings) {
    const values = data.organizations.map(o => metric(o, settings.metric, data, settings)).filter(v => v !== null);
    const q1=quantile(values,1/3),q2=quantile(values,2/3);
    return {low:q1===null?null:Math.round(q1*100)/100, high:q2===null?null:Math.round(q2*100)/100, count:values.length};
  }
  function band(value, bounds) {
    if (value === null || bounds.low === null) return 'missing';
    if (value <= bounds.low) return 'low';
    if (value <= bounds.high) return 'middle';
    return 'high';
  }
  function validateGeoJSON(input, orgIds) {
    if (!input || input.type !== 'FeatureCollection' || !Array.isArray(input.features)) throw new Error('Нужен GeoJSON FeatureCollection.');
    if (input.features.length > 30000) throw new Error('В одном файле допускается до 30 000 объектов.');
    function coord(c) {return Array.isArray(c) && c.length >= 2 && number(c[0]) !== null && number(c[1]) !== null && c[0]>=-180 && c[0]<=180 && c[1]>=-90 && c[1]<=90;}
    function ring(r) {return Array.isArray(r) && r.length >= 4 && r.every(coord) && r[0][0]===r[r.length-1][0] && r[0][1]===r[r.length-1][1];}
    function poly(p) {return Array.isArray(p) && p.length > 0 && p.every(ring);}
    return input.features.map((f,i) => {
      if (!f || f.type!=='Feature' || !f.geometry || !f.properties || !orgIds.includes(f.properties.organizationId)) throw new Error(`Объект ${i+1}: неизвестный organizationId.`);
      const g=f.geometry;
      const valid=g.type==='Point'?coord(g.coordinates):g.type==='Polygon'?poly(g.coordinates):g.type==='MultiPolygon'?Array.isArray(g.coordinates)&&g.coordinates.length>0&&g.coordinates.every(poly):false;
      if(!valid) throw new Error(`Объект ${i+1}: некорректная геометрия или незамкнутое кольцо.`);
      return {type:'Feature',properties:{organizationId:f.properties.organizationId,name:String(f.properties.name||''),kind:String(f.properties.kind||'territory'),source:String(f.properties.source||'Импорт пользователя')},geometry:g};
    });
  }
  function yandexGeometry(g) {
    function swap(c, depth) {return depth===0?[c[1],c[0]]:c.map(x=>swap(x,depth-1));}
    return {type:g.type, coordinates:swap(g.coordinates,{Point:0,Polygon:2,MultiPolygon:3}[g.type])};
  }
  const api={COLORS,number,locationFor,populationFor,attachedFor,metric,quantile,scale,band,validateGeoJSON,yandexGeometry};
  if(typeof module!=='undefined' && module.exports) module.exports=api;
  else root.HospitalCore=api;
})(typeof window!=='undefined'?window:this);
