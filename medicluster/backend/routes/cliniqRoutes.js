const express=require('express');
const {requirePatientOrClinician}=require('../middleware/auth');
const {createTools,fail,validLocation}=require('../services/cliniqTools');
const {createAgent}=require('../services/cliniqAgent');
const {createActions}=require('../services/cliniqActions');
const {complete}=require('../services/cliniqProvider');
const Selection=require('../models/CliniqSelection');
const crypto=require('node:crypto');
function createRouter(options={}){
  const router=express.Router();router.use(requirePatientOrClinician);
  router.use((req,res,next)=>{res.set('Cache-Control','private, no-store');next();});
  function services(req,signal){
    const request=options.request||async function(path,{method='GET',body,headers={}}={}){
      if(!path.startsWith('/api/')||path.includes('://')||path.includes('..'))throw fail(400,'Invalid app operation');
      const port=req.socket.localPort;
      const r=await fetch(`http://127.0.0.1:${port}${path}`,{method,headers:{Authorization:req.get('Authorization'),'Content-Type':'application/json',...headers},body:body==null?undefined:JSON.stringify(body),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(120000)]):AbortSignal.timeout(120000),redirect:'error'});
      const data=await r.json().catch(()=>null);
      if(!r.ok)throw fail(r.status,r.status>=500?'App service unavailable':data?.error||'App operation rejected');
      return data;
    };
    const tools=createTools({request,...(options.hospitals?{hospitals:options.hospitals}:{})});
    const context={signal};const actions=createActions({tools,context});
    const selectionKey=(s,c)=>crypto.createHash('sha256').update(JSON.stringify([s.userId,c.conversationId])).digest('hex').slice(0,24);
    return {tools,actions,agent:createAgent({tools,complete:options.complete||complete,propose:actions.propose,perform:actions.perform,
      loadSelection:async(s,c)=>{const row=await Selection.findOne({_id:selectionKey(s,c),actor:s.userId}).lean();return row&&new Date(row.expiresAt)>new Date()?row.value:null;},
      saveSelection:async(s,c,value)=>{await Selection.findOneAndUpdate({_id:selectionKey(s,c),actor:s.userId},{$set:{value,expiresAt:new Date(Date.now()+30*60*1000)}},{new:true,upsert:true});}
    })};
  }
  router.get('/capabilities',(req,res)=>{const {tools}=services(req);res.json({role:req.session.kind,tools:tools.catalog(req.session).map(t=>({name:t.function.name,description:t.function.description}))});});
  router.post('/chat',async(req,res,next)=>{
    const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),90000);
    const close=()=>{if(!res.writableEnded)controller.abort();};res.on('close',close);
    try{
      const {question,history,language,images,location,requestId,conversationId=requestId,selectedPatient}=req.body||{};
      if(typeof requestId!=='string'||! /^[a-zA-Z0-9_-]{8,128}$/.test(requestId))throw fail(400,'Valid request ID required');
      if(typeof conversationId!=='string'||! /^[a-zA-Z0-9_-]{8,128}$/.test(conversationId))throw fail(400,'Valid conversation ID required');
      if(location!==undefined&&location!==null&&!validLocation(location))throw fail(400,'Invalid shared location');
      const {agent}=services(req,controller.signal);
      const result=await agent.chat(req.session,{question,history,language,images,selectedPatient},{requestId,conversationId,location,signal:controller.signal});
      if(!res.destroyed)res.json({...result,role:req.session.kind});
    }catch(e){next(e);}finally{clearTimeout(timer);res.off('close',close);}
  });
  router.post('/actions/:id',async(req,res,next)=>{
    try{
      if(!['approve','cancel'].includes(req.body?.decision))throw fail(400,'Choose approve or cancel');
      const {actions}=services(req);
      res.json({result:await actions.perform(req.session,req.params.id,req.body.decision==='cancel')});
    }catch(e){next(e);}
  });
  return router;
}
module.exports=createRouter();module.exports.createRouter=createRouter;
