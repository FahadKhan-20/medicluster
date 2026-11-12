const crypto=require('node:crypto');
const Operation=require('../models/CliniqOperation');
const {fail,validLocation}=require('./cliniqTools');
const actor=s=>`${s.kind}:${s.kind==='patient'?s.patientId:s.userId}`;
const canonical=value=>JSON.stringify((function ordered(v){return Array.isArray(v)?v.map(ordered):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,ordered(v[k])])):v;})(value));
function createActions({tools,context}){
  return {
    async propose(session,tool,args,ctx){
      const d=tools.validate(session,tool,args);if(!d.write)throw fail(400,'Not an action');
      if(tool==='send_sos'&&!validLocation(ctx.location))throw fail(400,'Share and verify pickup location before proposing SOS');
      if(typeof ctx.requestId!=='string'||! /^[a-zA-Z0-9_-]{8,128}$/.test(ctx.requestId))throw fail(400,'Valid request ID required');
      const who=actor(session);const id=crypto.createHash('sha256').update(JSON.stringify([who,ctx.requestId,tool])).digest('hex').slice(0,24);
      let row=await Operation.findOne({_id:id,actor:who}).lean();
      if(!row){
        try{row=(await Operation.create({_id:id,actor:who,tool,arguments:args,selectedPatient:ctx.selectedPatient,location:validLocation(ctx.location)?{latitude:ctx.location.latitude,longitude:ctx.location.longitude}:undefined,status:'PROPOSED',expiresAt:new Date(Date.now()+10*60*1000)})).toObject();}
        catch(e){if(e.code!==11000)throw e;row=await Operation.findOne({_id:id,actor:who}).lean();}
      }
      if(!row||canonical(row.arguments)!==canonical(args)||canonical(row.selectedPatient||null)!==canonical(ctx.selectedPatient||null))throw fail(409,'Request already has different action details');
      return {id:row._id,tool:row.tool,arguments:row.arguments,selectedPatient:row.selectedPatient,location:row.location,status:row.status,expiresAt:row.expiresAt};
    },
    async perform(session,id,cancel=false){
      if(! /^[a-f0-9]{24}$/.test(id))throw fail(404,'Action not found');
      const who=actor(session);let row=await Operation.findOne({_id:id,actor:who}).lean();
      if(!row)throw fail(404,'Action not found');
      if(row.status==='SUCCEEDED')return row.result;
      if(row.status==='CANCELLED'&&cancel)return {cancelled:true};
      if(new Date(row.expiresAt)<=new Date())throw fail(409,'Action expired. Request a new action.');
      if(row.status!=='PROPOSED'&&!(row.tool==='send_sos'&&row.status==='FAILED'&&!cancel))throw fail(409,`Action ${row.status.toLowerCase()}. Check current app state before requesting another action.`);
      row=await Operation.findOneAndUpdate({_id:id,actor:who,status:row.status},{$set:{status:cancel?'CANCELLED':'RUNNING'}},{new:true}).lean();
      if(!row)throw fail(409,'Action already handled');
      if(cancel)return {cancelled:true};
      let sosGuard;
      try{
        if(row.tool==='send_sos'){
          sosGuard=crypto.createHash('sha256').update(`cliniq-sos-lock:${who}`).digest('hex').slice(0,24);
          const expiresAt=new Date(Date.now()+10*60*1000);
          let guard;
          try{guard=await Operation.create({_id:sosGuard,actor:who,tool:'__sos_lock',arguments:{operationId:id},status:'RUNNING',expiresAt});}
          catch(e){
            if(e.code!==11000)throw e;
            guard=await Operation.findOneAndUpdate({_id:sosGuard,actor:who,$or:[{status:'SUCCEEDED'},{expiresAt:{$lt:new Date()}}]},{$set:{status:'RUNNING',arguments:{operationId:id},expiresAt}},{new:true}).lean();
          }
          if(!guard){sosGuard=null;throw fail(409,'Another SOS request is in progress. Open Emergency to track it.');}
        }
        const result=await tools.execute(session,row.tool,row.arguments,{...context,selectedPatient:row.selectedPatient,location:row.location,approved:true,operationId:row._id});
        await Operation.findOneAndUpdate({_id:id,actor:who,status:'RUNNING'},{$set:{status:'SUCCEEDED',result}},{new:true});return result;
      }catch(e){
        await Operation.findOneAndUpdate({_id:id,actor:who,status:'RUNNING'},{$set:{status:'FAILED',error:'Action did not return a verified success. Check app state before retrying.'}},{new:true});
        throw e;
      }finally{
        if(sosGuard)await Operation.findOneAndUpdate({_id:sosGuard,actor:who,'arguments.operationId':id},{$set:{status:'SUCCEEDED'}},{new:true});
      }
    }
  };
}
module.exports={createActions};
