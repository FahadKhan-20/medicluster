const test=require('node:test'),assert=require('node:assert/strict');
const express=require('express');
async function listen(t,app){const s=app.listen(0,'127.0.0.1');await new Promise(r=>s.once('listening',r));t.after(()=>{s.closeAllConnections();s.close();});return `http://127.0.0.1:${s.address().port}`;}
test('crew GPS uploads become the assigned patient tracking position, and older fixes cannot overwrite them',async t=>{
 const unit={id:'fixture-unit',call_sign:'FIXTURE-1',latitude:12,longitude:77,last_ping:'2026-01-01T00:00:00Z'};
 const incident={id:'fixture-incident',status:'EN_ROUTE_TO_SCENE',assigned_ambulance_id:unit.id,location_lat:12.2,location_lng:77.2};
 const upstream=express();upstream.use(express.json());
 upstream.get('/auth/v1/user',(_q,r)=>r.json({id:'fixture-driver'}));
 upstream.get('/rest/v1/profiles',(_q,r)=>r.json([{id:'fixture-driver',role:'DRIVER'}]));
 upstream.get('/rest/v1/incidents',(_q,r)=>r.json([incident]));
 let locationReads=0;
 upstream.get('/rest/v1/ambulances',(_q,r)=>{locationReads++;r.json([unit]);});
 upstream.patch('/rest/v1/ambulances',(q,r)=>{
  assert.equal(q.get('Authorization'),'Bearer fixture-driver-token');
  if(q.query.id!=='eq.fixture-unit')return r.status(403).json({message:'Wrong vehicle'});
  if(q.query.or&&Date.parse(q.body.last_ping)<Date.parse(unit.last_ping))return r.json([]);
  Object.assign(unit,q.body);r.json([unit]);
 });
 const origin=await listen(t,upstream),old={SUPABASE_URL:process.env.SUPABASE_URL,SUPABASE_SECRET_KEY:process.env.SUPABASE_SECRET_KEY};
 process.env.SUPABASE_URL=origin;process.env.SUPABASE_SECRET_KEY='fixture-server-secret';t.after(()=>{for(const[k,v]of Object.entries(old))if(v===undefined)delete process.env[k];else process.env[k]=v;});
 const {createApp}=require('../../../ambulance-dispatch/backend/api/server');
 const api=await listen(t,createApp({url:origin,key:'fixture-public-key'}));const {track}=require('../services/patientCad');
 const first=await track({incidentId:incident.id});assert.equal(first.ambulance.latitude,12);
 const stamp=new Date(Date.now()-1000).toISOString();
 const upload=await fetch(api+'/api/ambulances/fixture-unit/location',{method:'PATCH',headers:{Authorization:'Bearer fixture-driver-token','Content-Type':'application/json'},body:JSON.stringify({latitude:12.1,longitude:77.1,recordedAt:stamp})});
 assert.equal(upload.status,200);
 const next=await track({incidentId:incident.id});assert.equal(next.ambulance.latitude,12.1);assert.equal(next.ambulance.lastPing,stamp);
 await fetch(api+'/api/ambulances/fixture-unit/location',{method:'PATCH',headers:{Authorization:'Bearer fixture-driver-token','Content-Type':'application/json'},body:JSON.stringify({latitude:10,longitude:75,recordedAt:'2026-01-01T00:00:00Z'})});
 assert.equal((await track({incidentId:incident.id})).ambulance.latitude,12.1);
 await t.test('closed emergencies do not expose current crew GPS from later missions',async()=>{
  incident.status='RESOLVED';locationReads=0;
  const closed=await track({incidentId:incident.id});assert.equal(closed.ambulance,null);assert.equal(locationReads,0);
 });
});
