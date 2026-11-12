/** Synthetic tool contract audit. No model calls or real clinical storage. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestDatabase } = require('./helpers/supabaseTestDb');
const { createTools } = require('../services/cliniqTools');
const Profile = require('../models/PatientProfile');
const Dataset = require('../models/Dataset');
const Media = require('../models/PatientMedia');
const Reminder = require('../models/Reminder');
const { normalizePatientRows } = require('../utils/rowSerializer');

const patient = { kind:'patient', patientId:'AUDIT-P1' };
const clinician = { kind:'clinician', userId:'audit-staff' };
const FILE = '111111111111111111111111';
const STUDY = 'a'.repeat(32), OTHER = 'b'.repeat(32), SESSION = 'c'.repeat(32);
const approved = { approved:true, operationId:'audit-operation-0001', location:{latitude:12,longitude:77} };
const vitals = { timestamp:'2030-01-01T10:00:00Z',heart_rate:75,spo2:98,systolic_bp:120,diastolic_bp:80,respiratory_rate:16,temperature:36.8 };

test('all CliniQ tool names, both role catalogs, and endpoint operation variants', async t => {
  await createTestDatabase(t);
  await Profile.create({patientId:patient.patientId,name:'Audit Registered Person',emergencyContact:{name:'Old contact',phone:'111',relation:'Parent'}});
  const [row] = normalizePatientRows([{patient_id:patient.patientId,name:'Audit Dataset Person',age:62,respiratory_rate:36,temperature:40,creatinine:4}]);
  const dataset = await Dataset.create({name:'Synthetic audit dataset',rowCount:1,rawData:[row]});
  await Media.create({patient_id:patient.patientId,gridfs_id:FILE,original_name:'audit.png',mimetype:'image/png',file_type:'image'});
  const reminder = await Reminder.create({patientId:patient.patientId,medicationName:'Prescribed fixture medicine',times:['08:00']});
  const rid = String(reminder._id), did = String(dataset._id);
  let calls = [], responses = [];
  const tools = createTools({
    request:async(path,options)=>{calls.push({path,method:options.method,body:options.body,headers:options.headers});return responses.shift() ?? {fixture:true};},
    hospitals:async()=>({hospitals:[{name:'Synthetic Hospital',source:'Synthetic fixture'}]}),
    recoverEmergency:async()=>({id:'fixture-repair',status:'ASSIGNED'})
  });
  const covered = new Set();
  let scenarios = 0;
  async function exercise(role,name,args,expected=[],returns=[],check=()=>{}) {
    scenarios++;
    await t.test(`${role.kind}: ${name} ${args.operation || args.resource || ''}`,async()=>{
      calls=[];responses=[...returns];
      const result=await tools.execute(role,name,args,approved);
      assert.deepEqual(calls.map(({path,method,body})=>({path,method,body})),expected);
      await check(result,calls);
      covered.add(name);
    });
  }
  const get=path=>({path,method:'GET',body:null});
  const post=(path,body)=>({path,method:'POST',body});
  const patch=(path,body)=>({path,method:'PATCH',body});
  for (const role of [patient,clinician]) {
    const identity=role.kind==='patient'?{}:{patientId:patient.patientId};
    const p=`/api/patient-app/${patient.patientId}`;
    await exercise(role,'features',{},[],[],r=>assert.ok(r.features.length));
    await exercise(role,'navigate',{feature:role.kind==='patient'?'health':'imaging'},[],[],r=>assert.ok(r.links[0].href.startsWith('/')));
    await exercise(role,'patient_record',identity,[get(p+'/profile')],[{patientId:patient.patientId,name:'Synthetic'}]);
    for(const resource of ['readings','appointments','documents','reminders','emergencies'])
      await exercise(role,'patient_resources',{...identity,resource},[get(resource==='reminders'?`/api/reminders/${patient.patientId}`:p+'/'+resource)],[[]]);
    await exercise(role,'nearby_hospitals',{city:'Fixture City'},[],[],r=>assert.equal(r.hospitals[0].source,'Synthetic fixture'));
    await exercise(role,'update_profile',{...identity,name:'New fixture name'},[{path:p+'/profile',method:'PUT',body:{name:'New fixture name'}}]);
    await exercise(role,'update_profile',{...identity,emergencyPhone:'222'},[get(p+'/profile'),{path:p+'/profile',method:'PUT',body:{emergencyContact:{name:'Old contact',phone:'222',relation:'Parent'}}}],[{emergencyContact:{name:'Old contact',phone:'111',relation:'Parent'}}]);
    const appointment={at:'2030-01-01T10:00:00Z',doctor:'Fixture doctor',location:'Fixture clinic',reason:'Fixture review'};
    await exercise(role,'book_appointment',{...identity,...appointment},[post(p+'/appointments',appointment)]);
    await exercise(role,'change_appointment',{...identity,appointmentId:FILE,at:appointment.at},[patch(p+'/appointments/'+FILE,{at:appointment.at})]);
    await exercise(role,'change_appointment',{...identity,appointmentId:FILE,status:'CANCELLED'},[patch(p+'/appointments/'+FILE,{status:'CANCELLED'})]);
    for(const reading of [{type:'glucose',value:101,context:'Fasting'},{type:'bp',value:120,diastolic:80},{type:'weight',value:72}])
      await exercise(role,'log_reading',{...identity,...reading},[post(p+'/readings',reading)],[],(_r,requests)=>assert.equal(requests[0].headers['Idempotency-Key'],approved.operationId));
    const schedule={medicationName:'Prescribed fixture medicine',times:['08:00'],frequency:'weekly',days:['Mon']};
    await exercise(role,'create_reminder',{...identity,...schedule},[post('/api/reminders',{...identity,...schedule,patientId:patient.patientId})]);
    for(const operation of ['activate','deactivate','delete'])
      await exercise(role,'change_reminder',{...identity,reminderId:rid,operation},[{path:'/api/reminders/'+rid,method:operation==='delete'?'DELETE':'PATCH',body:operation==='delete'?undefined:{active:operation==='activate'}}]);
    await exercise(role,'edit_reminder',{...identity,reminderId:rid,times:['09:00']},[patch('/api/reminders/'+rid,{times:['09:00']})]);
    await exercise(role,'log_dose',{...identity,reminderId:rid,date:'2030-01-01',time:'08:00'},[post('/api/reminders/'+rid+'/doses',{date:'2030-01-01',time:'08:00'})]);
  }
  await exercise(clinician,'find_patients',{query:'Audit'},[],[],r=>{assert.equal(r.matches.length,2);assert.equal(r.requiresSelection,true);assert.ok(r.matches.some(m=>String(m.datasetId)===did));});
  await exercise(clinician,'patient_record',{patientId:patient.patientId,datasetId:did},[],[],r=>assert.equal(r.data.record.respiratory_rate,36));
  for(const [resource,path] of Object.entries({datasets:'/api/data',results:'/api/cluster/results',alerts:'/api/alerts',hospitals:'/api/dispatch/hospitals',ambulances:'/api/dispatch/ambulances',dispatch_history:'/api/dispatch/history'}))
    await exercise(clinician,'dashboard',{resource},[get(path)]);
  await exercise(clinician,'imaging_records',{patientId:patient.patientId},[get('/api/media/'+patient.patientId)]);
  await exercise(clinician,'imaging_models',{},[get('/api/media/models')],[{models:[{id:'fixture-model'}]}]);
  await exercise(clinician,'analyze_image',{patientId:patient.patientId,fileId:FILE,model:'fixture-model'},[get('/api/media/models'),post('/api/media/analyze/'+FILE,{model_name:'fixture-model'})],[{models:[{id:'fixture-model'}]},{findings:[{label:'Fixture finding',confidence:0.8}]}]);
  for(const operation of ['record','review','gradcam']) {
    const extra=operation==='gradcam'?{model:'fixture-model',targetLabel:'Fixture finding'}:{};
    await exercise(clinician,'imaging_action',{patientId:patient.patientId,fileId:FILE,operation,...extra},[post(`/api/media/${operation}/${FILE}`,operation==='gradcam'?{model_name:extra.model,target_label:extra.targetLabel}:{})],[{gradcam_available:true,heatmap_b64:'DO_NOT_EXPOSE_PIXELS'}],r=>{if(operation==='gradcam')assert.deepEqual(r.data,{gradcam_available:true});});
  }
  for(const [operation,suffix,args] of [['studies','studies',{}],['demo','demo',{}],['study','studies/'+STUDY,{studyId:STUDY}],['compare',`studies/${STUDY}/compare/${OTHER}`,{studyId:STUDY,otherId:OTHER}]])
    await exercise(clinician,'brain',{operation,...args},[get('/api/intelligence/brain/'+suffix)]);
  await exercise(clinician,'brain_action',{operation:'create_demo',caseId:'0350'},[post('/api/intelligence/brain/demo',{caseId:'0350',patientId:'research-demo',studyDate:''})]);
  for(const operation of ['segment','classify']) {
    const extra=operation==='segment'?{points:[{x:1,y:2,z:3,label:1}]}:{axis:'axial',index:3};
    await exercise(clinician,'brain_action',{operation,patientId:patient.patientId,studyId:STUDY,...extra},[get('/api/intelligence/brain/studies/'+STUDY),post(`/api/intelligence/brain/studies/${STUDY}/${operation}`,extra)],[{patientId:patient.patientId},{id:STUDY}]);
  }
  await exercise(clinician,'radar',{},[get('/api/intelligence/radar/sessions')]);
  await exercise(clinician,'radar',{sessionId:SESSION},[get('/api/intelligence/radar/sessions/'+SESSION)]);
  for(const source of ['manual','demo'])
    await exercise(clinician,'radar_action',{operation:'create',patientId:patient.patientId,source},[post('/api/intelligence/radar/sessions',{patientId:patient.patientId,source,...(source==='demo'?{scenario:'stable'}:{})})]);
  for(const [operation,extra] of [['readings',{readings:[vitals]}],['step',{}],['forecast',{cursor:12,steps:6}]])
    await exercise(clinician,'radar_action',{operation,patientId:patient.patientId,sessionId:SESSION,...extra},[get(`/api/intelligence/radar/sessions/${SESSION}`),post(`/api/intelligence/radar/sessions/${SESSION}/${operation}`,extra)],[{id:SESSION,patientId:patient.patientId},{id:SESSION,patientId:patient.patientId}]);
  for(const algorithm of ['kmeans','dbscan','hierarchical','gmm'])
    await exercise(clinician,'run_clustering',{datasetId:did,algorithm},[post('/api/cluster',{datasetId:did,algorithm,params:{}})]);
  for(const [operation,args,body] of [['analyze-notes',{text:'Fixture clinical notes'},{notes:'Fixture clinical notes'}],['extract-symptoms',{text:'Fixture cough'},{text:'Fixture cough'}],['drug-interactions',{medications:['aspirin','warfarin']},{medications:['aspirin','warfarin']}]])
    await exercise(clinician,'clinical_analysis',{operation,...args},[post('/api/ml/'+operation,body)]);
  for(const operation of ['mews','news2']) {
    const args={heart_rate:75,systolic_bp:120,respiratory_rate:16,temperature:36.8,consciousness:0,...(operation==='news2'?{spo2:98,spo2_scale:1,air_or_oxygen:0}:{})};
    await exercise(clinician,'clinical_analysis',{operation,...args},[post('/api/ml/'+operation,args)]);
  }
  const clinical={patient_id:'SYNTHETIC',age:62,heart_rate:75};
  const advancedInputs={
    'risk-profile':{patient:clinical},'population-risk':{data:[clinical]},'compare-visits':{previous:clinical,current:{...clinical,heart_rate:78}},
    'patient-timeline':{events:[{...clinical,date:'2030-01-01'}]},'similar-patients':{patient:clinical,candidates:[clinical],top_k:1},
    'forecast-vitals':{vitals_history:{heart_rate:[72,73,74]},steps:3,method:'linear'},
    'train-predictive-model':{data:[{...clinical,risk_label:'low'}],target:'risk_label',task:'classification'},
    'optimal-k':{data:[clinical],k_min:2,k_max:3},'feature-importance':{data:[clinical],algorithm:'kmeans',params:{}},
    'reduce-dimensions':{data:[clinical],method:'pca'},'detect-anomalies':{data:[clinical],contamination:0.05},
    explain:{data:[clinical],algorithm:'kmeans',params:{}},ask:{query:'Show synthetic patients',patients:[clinical]}
  };
  for(const [operation,input] of Object.entries(advancedInputs))
    await exercise(clinician,'advanced_analysis',{operation,input},[post('/api/ml/'+operation,input)]);
  await exercise(clinician,'appointment_status',{patientId:patient.patientId,appointmentId:FILE,status:'CONFIRMED'},[patch(`/api/patient-app/${patient.patientId}/appointments/${FILE}`,{status:'CONFIRMED'})]);
  await exercise(patient,'send_sos',{description:'Synthetic only'},[get(`/api/patient-app/${patient.patientId}/emergencies`),post(`/api/patient-app/${patient.patientId}/emergencies`,{...approved.location,description:'Synthetic only'})],[[],{id:'synthetic-sos',status:'PENDING'}]);
  await exercise(patient,'send_sos',{description:'Synthetic only'},[get(`/api/patient-app/${patient.patientId}/emergencies`)],[ [{id:'synthetic-active',status:'ASSIGNED'}] ],r=>assert.equal(r.reused,true));
  const names=new Set([...tools.catalog(patient),...tools.catalog(clinician)].map(d=>d.function.name));
  assert.deepEqual([...covered].sort(),[...names].sort());
  t.diagnostic(`Covered ${covered.size} distinct tools, ${scenarios} role/operation scenarios; 13 advanced endpoint payload shapes.`);

  await t.test('scope guards reject another patient, foreign media, foreign reminder, and wrong brain study',async()=>{
    await assert.rejects(tools.execute(patient,'patient_record',{patientId:'AUDIT-P2'}),e=>e.status===403);
    await assert.rejects(tools.execute(clinician,'analyze_image',{patientId:'AUDIT-P2',fileId:FILE,model:'fixture-model'},approved),e=>e.status===404);
    await assert.rejects(tools.execute(clinician,'edit_reminder',{patientId:'AUDIT-P2',reminderId:rid,notes:'x'},approved),e=>e.status===404);
    responses=[{patientId:'AUDIT-P2'}];
    await assert.rejects(tools.execute(clinician,'brain_action',{operation:'segment',patientId:patient.patientId,studyId:STUDY,points:[{x:1,y:2,z:3,label:1}]},approved),e=>e.status===403);
  });

  await t.test('existing radar session is checked against explicitly selected patient',async()=>{
    calls=[];responses=[{patientId:'AUDIT-P2',id:SESSION}];
    await assert.rejects(tools.execute(clinician,'radar_action',{operation:'readings',patientId:patient.patientId,sessionId:SESSION,readings:[vitals]},approved),e=>e.status===403);
  });
  await t.test('conflicting appointment reschedule and cancellation is rejected',async()=>{
    await assert.rejects(tools.execute(patient,'change_appointment',{appointmentId:FILE,at:'2030-01-01T10:00:00Z',status:'CANCELLED'},approved),e=>e.status===400);
  });
  await t.test('dataset record returns flattened clinical fields for ML contracts',async()=>{
    const result=await tools.execute(clinician,'patient_record',{patientId:patient.patientId,datasetId:did},approved);
    assert.equal(result.data.record.respiratory_rate,36);
    assert.equal(result.data.record.creatinine,4);
  });
  await t.test('selecting a dataset identity cannot propose a registered patient mutation by shared ID',async()=>{
    let round=0;
    const {createAgent}=require('../services/cliniqAgent');
    const agent=createAgent({tools,propose:async(_session,name,args)=>({id:'synthetic-proposal',tool:name,arguments:args}),complete:async()=>({message:{tool_calls:[{
      id:`synthetic-${round}`,
      function:round++===0
        ?{name:'find_patients',arguments:JSON.stringify({query:'Audit Dataset Person'})}
        :{name:'update_profile',arguments:JSON.stringify({patientId:patient.patientId,name:'Changed through dataset identity'})}
    }]}})});
    const result=await agent.chat(clinician,{question:'Rename Audit Dataset Person to Changed through dataset identity'},{});
    assert.equal(result.actions.length,0,'Dataset record and registered profile have distinct names and no verified identity linkage');
  });

  const express=require('express');
  const oldSecret=process.env.JWT_SECRET;
  process.env.JWT_SECRET='audit-only-fixture-secret-at-least-32-characters';
  t.after(()=>{if(oldSecret===undefined)delete process.env.JWT_SECRET;else process.env.JWT_SECRET=oldSecret;});
  const app=express();app.use(express.json());app.use('/api/reminders',require('../routes/reminderRoutes'));
  app.use((e,_req,res,_next)=>res.status(e.status||500).json({error:e.message}));
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  t.after(()=>{server.closeAllConnections();server.close();});
  const token=require('../middleware/auth').signPatientToken(patient.patientId);
  const localTools=createTools({request:async(path,{method,body})=>{
    const response=await fetch(`http://127.0.0.1:${server.address().port}${path}`,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:body==null?undefined:JSON.stringify(body)});
    const result=await response.json();if(!response.ok)throw Object.assign(new Error(result.error),{status:response.status});return result;
  }});
  await t.test('editing daily reminder to weekly requires selected weekdays',async()=>{
    await assert.rejects(localTools.execute(patient,'edit_reminder',{reminderId:rid,frequency:'weekly'},approved),e=>e.status===400);
  });
  await t.test('log_dose rejects impossible or unscheduled slots and invalid calendar dates',async()=>{
    await assert.rejects(localTools.execute(patient,'log_dose',{reminderId:rid,date:'2030-01-01',time:'99:99'},approved),e=>e.status===400);
    await assert.rejects(localTools.execute(patient,'log_dose',{reminderId:rid,date:'2030-01-01',time:'09:00'},approved),e=>e.status===400);
    await assert.rejects(localTools.execute(patient,'log_dose',{reminderId:rid,date:'2030-02-30',time:'08:00'},approved),e=>e.status===400);
    assert.equal((await Reminder.findById(rid).lean()).doseLog.length,0);
    await localTools.execute(patient,'log_dose',{reminderId:rid,date:'2030-01-01',time:'08:00'},approved);
    await localTools.execute(patient,'log_dose',{reminderId:rid,date:'2030-01-01',time:'08:00'},approved);
    assert.equal((await Reminder.findById(rid).lean()).doseLog.length,1);
  });
});
