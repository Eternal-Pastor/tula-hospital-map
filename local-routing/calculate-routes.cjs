/* Batch routing to loopback OSRM only; emits a normal transferable project backup. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const site=[path.resolve(__dirname,'../outputs/hospital-map'),path.resolve(__dirname,'../hospital-map')].find(folder=>fs.existsSync(path.join(folder,'data.js')));
if(!site)throw new Error('Cannot locate the hospital-map site next to local-routing.');
const A=require(path.join(site,'accessibility.js')),O=require(path.join(site,'routing-osrm.js')),B=require(path.join(site,'backup.js')),C=require(path.join(site,'core.js')),L=require(path.join(site,'cache.js')),T=require(path.join(site,'territories.js'));
const DEFAULTS={auto:'http://localhost:5000/route/v1/driving',pedestrian:'http://localhost:5001/route/v1/foot'};
const metadata=name=>{try{return fs.readFileSync(path.join(__dirname,name),'utf8').trim();}catch(_){return null;}};
const graphIdentity=()=>({image:metadata('runtime/osrm-image.txt'),source:metadata('osrm/region.source')});
function localServices(value=DEFAULTS){
 const result=O.config(value);
 for(const url of Object.values(result))if(!['localhost','127.0.0.1','[::1]'].includes(new URL(url).hostname))throw new Error('Mass routing is restricted to local OSRM. Public servers are not allowed.');
 return result;
}
function settingsFor(s,data){
 const ids=new Set(data.organizations.map(o=>o.id)),populations=new Set(data.populations.map(p=>p.id));
 const out={selectedOrganization:ids.has(s.selectedOrganization)?s.selectedOrganization:null,showZones:s.showZones!==false,showAddressPoints:s.showAddressPoints===true,fullCoverage:s.fullCoverage===true,mapColor:s.mapColor==='load'?'load':'organization',metric:['absolute','perArea','per1000'].includes(s.metric)?s.metric:'per1000',includeMixed:s.includeMixed===true,showEmpty:s.showEmpty===true,populationLinks:{},populationValues:{},coordinates:{},coordinateVersions:{},geojson:[]};
 for(const [id,v] of Object.entries(s.populationLinks||{}))if(ids.has(id)&&(v===''||populations.has(v)))out.populationLinks[id]=v;
 for(const [id,v] of Object.entries(s.populationValues||{}))if(populations.has(id)&&Number.isFinite(v)&&v>0)out.populationValues[id]=v;
 for(const [id,v] of Object.entries(s.coordinates||{}))if(ids.has(id)&&A.validPoint(v)){out.coordinates[id]=v;if(typeof s.coordinateVersions?.[id]==='string')out.coordinateVersions[id]=s.coordinateVersions[id];}
 if(s.geojson?.length)out.geojson=C.validateGeoJSON({type:'FeatureCollection',features:s.geojson},[...ids]);
 return out;
}
async function loadProject(file){
 if(fs.statSync(file).size>B.MAX_BYTES)throw new Error('Project backup exceeds the 100 MiB import limit.');
 const context={window:{}};vm.runInNewContext(fs.readFileSync(path.join(site,'data.js'),'utf8'),context);const data=context.window.HOSPITAL_DATA,index=T.index(data);
 const dataset=await B.digest({organizations:data.organizations.map(o=>({id:o.id,location:o.location})),groups:[...index.byOrganization].map(([id,groups])=>[id,groups.map(g=>[g.id,g.address])])});
 const raw=JSON.parse(fs.readFileSync(file,'utf8'));
 const plan=await B.prepare(raw,{data,index,dataset,validateSettings:s=>settingsFor(s,data),validateRouting:s=>s});
 if(plan.datasetMismatch||plan.invalid)throw new Error('Backup does not exactly match the current project dataset.');
 const base=plan.records.find(r=>r.key==='geometry:zones-v1'),coverage=plan.records.find(r=>r.key==='geometry:coverage-v1');
 if(!plan.settings.fullCoverage||!base||!coverage?.coverage)throw new Error('Use a backup with full regional coverage enabled.');
 const restored=L.restore(plan.records,data,index),hospitals=data.organizations.map(o=>({id:o.id,coords:C.locationFor(o,plan.settings,restored.orgLocations.get(o.id))?.coords}));
 vm.runInNewContext(fs.readFileSync(path.join(site,'region.js'),'utf8'),context);const region=context.window.HOSPITAL_REGION;
 const signature=JSON.stringify({algorithm:1,base:base.signature,hospitals,boundary:region.properties.id});
 if(coverage.signature!==signature)throw new Error('Coverage is stale for these hospital coordinates. Rebuild it before routing.');
 const inputs=data.organizations.map(o=>({id:o.id,anchors:(index.byOrganization.get(o.id)||[]).map(g=>restored.locations.get(g.id)).filter(Boolean).map(a=>({coords:a.coords})),geometries:plan.settings.geojson.filter(f=>f.properties.organizationId===o.id&&f.geometry.type!=='Point').map(f=>f.geometry)}));
 if(JSON.stringify(inputs)!==base.signature)throw new Error('Base vectors do not match saved addresses.');
 return {data,index,dataset,plan,coverage,hospitals,raw};
}
async function run({input,output,concurrency=4,step=5000,services=DEFAULTS,fetcher=fetch,signal,onProgress=()=>{},limit=Infinity}){
 input=path.resolve(input);output=path.resolve(output);
 if(input===output)throw new Error('Input backup must remain unchanged; choose a separate output file.');
 fs.mkdirSync(path.dirname(output),{recursive:true});
 if(!Number.isInteger(concurrency)||concurrency<1||concurrency>8)throw new Error('Concurrency must be 1..8.');
 services=localServices(services);
 const project=await loadProject(input),{data,index,dataset,plan,coverage,hospitals}=project,ids=new Set(data.organizations.map(o=>o.id));
 const graph=graphIdentity(),targetServices=new Set(Object.values(services));
 // Resume only this output's verified graph, not unversioned local answers from an input backup.
 const routes=new Map(plan.records.filter(r=>r.type==='route'&&!targetServices.has(r.routingService)).map(r=>[r.key,r])),fixed=plan.records.filter(r=>r.type!=='route');
 if(fs.existsSync(output)){
  const previous=await loadProject(output);
  if(previous.coverage.signature!==coverage.signature)throw new Error('Output belongs to another coverage; choose a new output file.');
  const previousReceipt=JSON.parse(fs.readFileSync(output.replace(/\.json$/i,'')+'.receipt.json','utf8'));
  if(JSON.stringify(previousReceipt.graph)!==JSON.stringify(graph))throw new Error('OSRM graph has changed. Use a new output file instead of resuming old routes.');
  for(const r of B.merge([...routes.values()],previous.plan.records.filter(r=>r.type==='route')))routes.set(r.key,r);
 }
 const cells=A.grid(new Map(coverage.zones),step).cells,destinations=new Map(hospitals.map(o=>[o.id,o.coords]));
 const allJobs=[...new Map(A.pending(cells,destinations,new Map(),O.MODES,services).map(j=>[j.key,j])).values()];
 const queue=allJobs.filter(j=>!routes.has(j.key)).slice(0,limit),initial=allJobs.filter(j=>routes.has(j.key)).length;
 const controller=new AbortController(),abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
 const started=Date.now(),lock=output+'.lock';let lockFd,completed=0,cursor=0,failure=null,checkpointAt=Date.now(),checkpointCount=0,checkpoint=Promise.resolve();
 const stats=()=>({cells:cells.length,total:allJobs.length,completed:initial+completed,cached:initial,found:allJobs.filter(j=>routes.get(j.key)?.status==='found').length,unreachable:allJobs.filter(j=>routes.get(j.key)?.status==='unreachable').length,elapsedSeconds:Math.round((Date.now()-started)/1000)});
 async function persist(){
  if(JSON.stringify(graphIdentity())!==JSON.stringify(graph))throw new Error('OSRM graph changed during routing. Last valid checkpoint is preserved.');
  const backup=await B.create({settings:{...plan.settings,selectedOrganization:null,showZones:true,showEmpty:true},routing:{gridPreset:'5km-current-v1',routingPreset:'osrm-trial-v1',source:'osrm',osrm:services,model:A.modelOptions(plan.routing?.model),enabled:true,mode:'auto',step,scope:'all',shape:'cells',lines:false},records:[...fixed,...routes.values()],dataset});
  const text=JSON.stringify(backup);if(Buffer.byteLength(text)>B.MAX_BYTES)throw new Error('Backup exceeds 100 MiB. Last valid checkpoint is preserved.');
  const temp=output+'.writing';await fs.promises.writeFile(temp,text);await fs.promises.rename(temp,output);
  const summary=stats(),receipt={...summary,complete:summary.completed===summary.total,input,output,inputChecksum:project.raw.checksum,checksum:backup.checksum,services,step,graph,at:new Date().toISOString(),results:Object.fromEntries(O.MODES.map(mode=>[mode,Object.fromEntries(['found','NoRoute','NoSegment'].map(status=>[status,allJobs.filter(j=>j.mode===mode).map(j=>routes.get(j.key)).filter(r=>r&&(status==='found'?r.status==='found':r.routeReason===status)).length]))]))};
  await fs.promises.writeFile(output.replace(/\.json$/i,'')+'.receipt.json',JSON.stringify(receipt,null,2));
  return receipt;
 }
 function scheduleCheckpoint(){
  if(completed-checkpointCount<100&&Date.now()-checkpointAt<10000)return;
  checkpointCount=completed;checkpointAt=Date.now();
  checkpoint=checkpoint.then(persist).catch(error=>{failure=failure||error;controller.abort();});
 }
 try{
  lockFd=fs.openSync(lock,'wx');onProgress(stats());
  async function worker(){while(!controller.signal.aborted){const job=queue[cursor++];if(!job)return;
   try{
    const value=await O.requestRoute(services[job.mode],job,controller.signal,fetcher);
    const item=A.record({type:'route',organizationId:job.cell.organizationId,origin:job.cell.origin,destination:job.destination,mode:job.mode,...value,at:new Date().toISOString()},ids);
    if(!item)throw new Error('Route did not pass project validation.');routes.set(item.key,item);completed++;
    if(completed%50===0)onProgress(stats());scheduleCheckpoint();
   }catch(error){if(!signal?.aborted&&!failure)failure=error;controller.abort();}
  }}
  await Promise.all(Array.from({length:concurrency},worker));await checkpoint;
  const receipt=await persist();onProgress(receipt);
  if(failure)throw failure;if(signal?.aborted)throw new DOMException('Batch routing stopped; checkpoint saved.','AbortError');return receipt;
 }finally{signal?.removeEventListener('abort',abort);if(lockFd!==undefined){fs.closeSync(lockFd);fs.unlinkSync(lock);}}
}
module.exports={run,loadProject,localServices};
if(require.main===module){
 const args=process.argv.slice(2),options={};
 for(let i=0;i<args.length;i+=2){const key=args[i];if(!['--input','--output','--concurrency','--step'].includes(key)||!args[i+1])throw new Error('Usage: node calculate-routes.cjs --input backup.json --output result.json [--concurrency 4] [--step 5000]');options[key.slice(2)]=['--step','--concurrency'].includes(key)?Number(args[i+1]):args[i+1];}
 if(!options.input||!options.output)throw new Error('Specify separate --input and --output backups.');
 const controller=new AbortController();process.on('SIGINT',()=>controller.abort());
 run({...options,signal:controller.signal,onProgress:s=>console.log(JSON.stringify(s))}).catch(error=>{console.error(error.message);process.exitCode=error.name==='AbortError'?130:1;});
}
