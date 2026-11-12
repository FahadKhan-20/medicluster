const test=require('node:test'),assert=require('node:assert/strict');
const {createTestDatabase}=require('./helpers/supabaseTestDb');
const {createTools}=require('../services/cliniqTools');
const {createActions}=require('../services/cliniqActions');
const {createAgent}=require('../services/cliniqAgent');
const patient={kind:'patient',patientId:'audit-own'},staff={kind:'clinician',userId:'audit-staff'};
test('same action payload with reordered JSON keys preserves retry identity',async t=>{
  await createTestDatabase(t);const tools=createTools({request:async()=>({})});const actions=createActions({tools,context:{}}),ctx={requestId:'reordered-arguments-audit'};
  const first=await actions.propose(patient,'create_reminder',{medicationName:'Synthetic',times:['08:00'],dosage:'as prescribed'},ctx);
  const second=await actions.propose(patient,'create_reminder',{times:['08:00'],dosage:'as prescribed',medicationName:'Synthetic'},ctx);
  assert.equal(first.id,second.id);
});
test('empty-argument lookup tools accept optional native provider rationale but reject URLs',async()=>{
  const tools=createTools({request:async()=>({models:[]})});
  assert.ok((await tools.execute(patient,'features',{reason:'Show app features'})).features.length);
  assert.deepEqual((await tools.execute(staff,'imaging_models',{reason:'List available models'})).data,{models:[]});
  await assert.rejects(tools.execute(patient,'features',{url:'https://attacker'}),e=>e.status===400);
});
test('dataset identity cannot be silently converted to a profile by model-only lookup',async()=>{
  let calls=0,saved,reads=0;
  const tools={catalog:()=>[],validate:(_s,name,args)=>({name,write:false}),execute:async()=>{reads++;return {matches:[{patientId:'P001',name:'Different registered person',source:'profile'}],requiresSelection:false};}};
  const agent=createAgent({tools,loadSelection:async()=>({selected:{patientId:'P001',datasetId:'dataset-fixture',source:'dataset'}}),saveSelection:async(_s,_c,value)=>{saved=value;},complete:async()=>{calls++;return {message:{tool_calls:[{id:'x',function:{name:'find_patients',arguments:'{"query":"Different registered person"}'}}]}};}});
  const result=await agent.chat(staff,{question:'Show the dataset record'},{});
  assert.equal(calls,1);assert.equal(reads,1);assert.equal(saved.matches.length,1);assert.equal(result.actions.length,0);
});
test('stored selected patient scope is enforced for radar mutations even when model omits patientId',async()=>{
  const calls=[];const tools=createTools({request:async(path,options)=>{calls.push({path,method:options.method});return {patientId:'other-patient'};}});
  await assert.rejects(tools.execute(staff,'radar_action',{operation:'step',sessionId:'session-fixture'},{approved:true,selectedPatient:{patientId:'chosen-patient'}}),e=>e.status===403);
  assert.equal(calls.length,1);assert.equal(calls[0].method,'GET');
});
test('hospital lookup falls back to bounded OSM search without inventing nearby facilities',async t=>{
  const calls=[];
  t.mock.method(global,'fetch',async(url,options={})=>{
    const u=new URL(url);calls.push({url:u,options});
    if(u.hostname.includes('overpass'))return Response.json({error:'Synthetic busy provider'},{status:503});
    assert.equal(u.searchParams.get('q'),'[hospital]');assert.equal(u.searchParams.get('bounded'),'1');
    return Response.json([{type:'hospital',name:'Synthetic hospital',display_name:'Synthetic hospital, Fixture Road',lat:'12.971',lon:'77.591',extratags:{phone:'fixture-phone'}}]);
  });
  const tools=createTools({request:async()=>({})});
  const result=await tools.execute(patient,'nearby_hospitals',{radiusKm:5},{location:{latitude:12.97,longitude:77.59}});
  assert.equal(calls.length,3);assert.match(calls[0].options.headers['User-Agent'],/MediCluster/);
  assert.equal(calls[0].options.body.get('data').startsWith('[out:json]'),true);
  assert.equal(result.hospitals[0].name,'Synthetic hospital');assert.match(result.lookupSource,/Nominatim/);assert.match(result.note,/partial/);
});
