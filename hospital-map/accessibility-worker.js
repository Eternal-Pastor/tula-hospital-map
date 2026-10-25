self.onmessage=function(event){
  const {id,task,payload}=event.data;
  try{self.postMessage({id,result:task==='grid'?self.HospitalAccessibility.grid(payload.zones,payload.step):self.HospitalAccessibility.bands(payload.items)});}
  catch(error){self.postMessage({id,error:String(error.message||error)});}
};
