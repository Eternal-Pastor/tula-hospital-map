self.onmessage=function(event){
  const {id,key,organizations}=event.data,started=performance.now();
  try {
    let lastStage='',lastAt=0,lastOrganization='',lastOperation='',lastPass=0;
    const compute=event.data.task==='coverage'?self.HospitalZones.completeCoverage:self.HospitalZones.partition;
    const result=compute(organizations,{boundary:event.data.boundary,baseZones:event.data.baseZones,onProgress:progress=>{
      const finishedPart=progress.fragmentTotal>0&&progress.fragmentCompleted===progress.fragmentTotal||progress.batchTotal>0&&progress.batchCompleted===progress.batchTotal||progress.edgeTotal>0&&progress.edgeCompleted===progress.edgeTotal;
      const now=performance.now();if(progress.stage!==lastStage||progress.organizationId!==lastOrganization||progress.operation!==lastOperation||progress.pass!==lastPass||progress.completed===progress.total||finishedPart||now-lastAt>250){
        lastStage=progress.stage;lastOrganization=progress.organizationId;lastOperation=progress.operation;lastPass=progress.pass;lastAt=now;self.postMessage({id,key,type:'progress',progress,elapsed:now-started});
      }
    }});
    result.anchorCounts=new Map(organizations.map(o=>[o.id,(o.anchors||[]).length]));
    self.postMessage({id,key,result,elapsed:performance.now()-started});
  } catch(error){self.postMessage({id,key,error:String(error.message||error)});}
};
