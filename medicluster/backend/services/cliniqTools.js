/** Role-scoped app tools. Model arguments never choose actor, token, origin or role. */
const Profile = require('../models/PatientProfile');
const Media = require('../models/PatientMedia');
const Reminder = require('../models/Reminder');
const Dataset = require('../models/Dataset');
const {denormalizePatientRows}=require('../utils/rowSerializer');
const fail = (status, message) => Object.assign(new Error(message), { status });
const str = (description, extra = {}) => ({ type:'string', description, maxLength:500, ...extra });
const choice = (...values) => ({ type:'string', enum:values });
const obj = (properties, required = []) => ({ type:'object', properties, required, additionalProperties:false });
const patientId = str('Exact patient ID. Omit for signed-in patient.');
const id = str('Exact resource ID obtained from a tool result.');
const number = { type:'number' };
const FEATURES = {
  clinician: {
    dashboard:['Dashboard','/dashboard','Datasets, clustering and population risk'], alerts:['Alerts','/alerts','Patient risk alerts'],
    imaging:['Imaging','/imaging','Upload chest X-rays or brain slices; analyze findings and heatmaps'],
    brain:['3D Tumor Explorer','/brain-explorer','NIfTI studies, point-guided segmentation, meshes, volumes and comparisons'],
    radar:['Deterioration Radar','/deterioration-radar','Vital sessions, scores and forecasts'],
    patients:['Patients','/patient','Patient records, names, readings and history'], reminders:['Reminders','/reminders','Medication reminders and dose logs'],
    reports:['Reports','/reports','Clinical reports and exports'], cliniq:['CliniQ','/ask-ai','Clinical app assistant'],
    clinical:['Clinical AI','/clinical-ai','Clinical notes, risk scoring and analysis'], hospitals:['Hospitals','/hospitals','Nearby facilities and registry information'],
    dispatch:['Dispatch','/dispatch','Dispatch workspace; separate dispatch sign-in may be required']
  },
  patient: {
    today:['Today','/app','Your health overview'], health:['My health','/app/health','Your readings and health trends'],
    readings:['Log a reading','/app/health/log','Record glucose, blood pressure or weight'], visits:['Visits','/app/visits','Your appointment requests'],
    reports:['Reports','/app/reports','Your documents and reports'], emergency:['Emergency','/app/emergency','Request SOS and track your emergency'],
    reminders:['Medication reminders','/app','View your medication schedule and mark doses taken'],
    profile:['Profile','/app/profile','Your profile and emergency contact'], cliniq:['CliniQ','/app/cliniq','Your health and patient app assistant']
  }
};
function validate(value, schema, path='arguments') {
  if (schema.type==='object') {
    if (!value || typeof value!=='object' || Array.isArray(value)) throw fail(400,`${path} must be an object`);
    if(schema.additionalProperties===true){
      if(JSON.stringify(value).length>24000)throw fail(400,'Analysis input is too large');
      const check=(v,depth=0)=>{if(depth>8)throw fail(400,'Analysis input is too deeply nested');if(v===null)return;if(typeof v==='number'&&!Number.isFinite(v))throw fail(400,'Analysis numbers must be finite');if(v&&typeof v==='object'){if(Object.keys(v).length>2000)throw fail(400,'Too many analysis input values');for(const [key,item]of Object.entries(v)){if(['__proto__','constructor','prototype'].includes(key))throw fail(400,'Invalid analysis field');check(item,depth+1);}}};
      check(value);return;
    }
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(schema.properties,key)) throw fail(400,`Unknown ${path} field`);
      validate(value[key],schema.properties[key],`${path}.${key}`);
    }
    for (const key of schema.required||[]) if (!Object.hasOwn(value,key)) throw fail(400,`${path}.${key} is required`);
  } else if (schema.type==='array') {
    if (!Array.isArray(value)||value.length>(schema.maxItems||30)) throw fail(400,`${path} must be a bounded array`);
    value.forEach(v=>validate(v,schema.items,path));
  } else if (typeof value!==schema.type || schema.type==='number'&&!Number.isFinite(value)) throw fail(400,`Invalid ${path}`);
  if (schema.type==='string' && value.length>(schema.maxLength||500)) throw fail(400,`${path} is too long`);
  if (schema.enum && !schema.enum.includes(value)) throw fail(400,`Unsupported ${path}`);
}
const safeId = value => {
  if(typeof value!=='string'||! /^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw fail(400,'Valid resource ID required');
  return encodeURIComponent(value);
};
function target(session, args) {
  if(session.kind==='patient') {
    if(args.patientId!==undefined&&args.patientId!==session.patientId)throw fail(403,'Not your record');
    return session.patientId;
  }
  if(!args.patientId)throw fail(400,'Select an exact patient ID first');
  safeId(args.patientId);return args.patientId;
}
const resource = choice('readings','appointments','documents','reminders','emergencies');
function createTools({request, hospitals = nearbyHospitals, recoverEmergency = repairEmergency} = {}) {
  const definitions = [];
  const add = (name, description, parameters, roles, run, write=false) => definitions.push({ name,description,parameters,roles,run,write });
  const both=['patient','clinician'], staff=['clinician'];
  const api=(p,m='GET',body,ctx={},headers={})=>request(p,{method:m,body,headers,context:ctx});
  add('features','List features available in the current app and how to use them.',obj({reason:str('Optional reason for looking up available features')}),both,async(s)=>({features:Object.entries(FEATURES[s.kind]).map(([feature,[title,href,description]])=>({feature,title,href,description}))}));
  add('navigate','Open a feature in the current app. Use features to discover supported names.',obj({feature:str('Feature key from features tool')},['feature']),both,async(s,a)=>{
    const f=FEATURES[s.kind][a.feature];if(!f)throw fail(403,'Feature unavailable in this app');return {links:[{title:f[0],href:f[1]}]};
  });
  add('find_patients','Find patients by name or exact patient ID. Multiple matches require user selection; never guess.',obj({query:str('Name or patient ID',{maxLength:100})},['query']),staff,async(_s,a)=>{
    if(!a.query.trim())throw fail(400,'Enter a patient name or ID');
    const q=a.query.trim().toLowerCase();const matches=[];
    const profiles=await Profile.find({}).limit(300).lean();
    for(const p of profiles)if(p.patientId.toLowerCase()===q||p.name?.toLowerCase().includes(q))matches.push({patientId:p.patientId,name:p.name||p.patientId,source:'profile'});
    if(matches.length<20){
      const datasets=await Dataset.find({}).sort({createdAt:-1}).limit(20).lean();
      for(const d of datasets) for(const row of d.rawData||[]){
        const texts=row.textFeatures||{};const name=texts.name||texts.patient_name||texts.full_name||'';
        if(row.patient_id?.toLowerCase()===q||name.toLowerCase().includes(q))matches.push({patientId:row.patient_id,name:name||row.patient_id,datasetId:d._id,source:'dataset'});
        if(matches.length>=20)break;
      }
    }
    return {matches:matches.slice(0,20),requiresSelection:matches.length>1,note:'Search covers at most 300 profiles and 20 recent datasets. Dataset identities retain dataset context.'};
  });
  add('patient_record','Read an authorized patient profile. Clinicians may select an exact dataset match from find_patients; patients cannot read datasets.',obj({patientId,datasetId:id}),both,async(s,a,c)=>{
    if(s.kind==='patient'&&a.datasetId)throw fail(403,'Datasets are clinician-only');
    const selected=target(s,a);
    if(a.datasetId){
      safeId(a.datasetId);const dataset=await Dataset.findById(a.datasetId).lean();
      const rows=dataset?.rawData?.filter(r=>r.patient_id===selected)||[];
      if(rows.length!==1)throw fail(409,'Select an unambiguous patient and dataset');
      return {data:{patientId:selected,datasetId:a.datasetId,record:denormalizePatientRows(rows)[0]}};
    }
    return {data:await api(`/api/patient-app/${safeId(selected)}/profile`,'GET',null,c)};
  });
  add('patient_resources','List readings, appointments, documents, reminders or emergency status for one patient.',obj({patientId,resource},['resource']),both,async(s,a,c)=>{
    const p=safeId(target(s,a));const path=a.resource==='reminders'?`/api/reminders/${p}`:`/api/patient-app/${p}/${a.resource}`;
    return {resource:a.resource,data:await api(path,'GET',null,c)};
  });
  add('nearby_hospitals','Find actual nearby hospitals using shared coordinates, or a user-provided city. Never invent location or services.',obj({city:str('City explicitly supplied by user',{maxLength:120}),radiusKm:number}),both,async(_s,a,c)=>hospitals(a,c));
  add('dashboard','Read clinical dashboard resources. This tool is never available to patients.',obj({resource:choice('datasets','results','alerts','hospitals','ambulances','dispatch_history')},['resource']),staff,async(_s,a,c)=>{
    const paths={datasets:'/api/data',results:'/api/cluster/results',alerts:'/api/alerts',hospitals:'/api/dispatch/hospitals',ambulances:'/api/dispatch/ambulances',dispatch_history:'/api/dispatch/history'};
    return {resource:a.resource,data:await api(paths[a.resource],'GET',null,c)};
  });
  async function ownedMedia(s,a) {
    const p=target(s,a);const media=await Media.findOne({gridfs_id:a.fileId,patient_id:p}).lean();
    if(!media)throw fail(404,'Image not found for selected patient');return media;
  }
  add('imaging_records','List images and actual model findings for the selected patient.',obj({patientId},['patientId']),staff,async(s,a,c)=>({data:await api(`/api/media/${safeId(target(s,a))}`,'GET',null,c)}));
  add('analyze_image','Analyze an existing selected-patient image with a registered chest or MRI model.',obj({patientId,fileId:id,model:str('Registered model ID from imaging_models')},['patientId','fileId','model']),staff,async(s,a,c)=>{
    safeId(a.fileId);await ownedMedia(s,a);
    const models=await api('/api/media/models','GET',null,c);
    if(!models.models?.some(m=>m.id===a.model))throw fail(400,'Unsupported imaging model');
    return {data:await api(`/api/media/analyze/${safeId(a.fileId)}`,'POST',{model_name:a.model},c),links:[{title:'Open Imaging',href:'/imaging'}]};
  },true);
  add('imaging_models','List available imaging models.',obj({reason:str('Optional reason for looking up imaging models')}),staff,async(_s,_a,c)=>({data:await api('/api/media/models','GET',null,c)}));
  add('imaging_action','Record an analyzed image, request review, or generate a Grad-CAM heatmap for selected patient.',obj({patientId,fileId:id,operation:choice('record','review','gradcam'),model:str('Registered imaging model ID'),targetLabel:str('Finding label for Grad-CAM')},['patientId','fileId','operation']),staff,async(s,a,c)=>{
    await ownedMedia(s,a);
    if(a.operation==='gradcam'&&(!a.model||!a.targetLabel))throw fail(400,'Model and finding label required');
    const data=await api(`/api/media/${a.operation}/${safeId(a.fileId)}`,'POST',a.operation==='gradcam'?{model_name:a.model,target_label:a.targetLabel}:{},c);
    // Heatmap pixels stay in the imaging view; do not put large base64 blobs in model context.
    return {data:a.operation==='gradcam'?{gradcam_available:!!data.gradcam_available}:data,links:[{title:'Open Imaging',href:'/imaging'}]};
  },true);
  const points={type:'array',maxItems:30,items:obj({x:number,y:number,z:number,label:{type:'number',enum:[0,1]}},['x','y','z','label'])};
  add('brain_action','Create research demo MRI, segment an actor-owned study using supplied points, or classify a selected slice.',obj({operation:choice('create_demo','segment','classify'),patientId,caseId:choice('0350','0172','0153','0005','0465'),studyId:id,studyDate:str('YYYY-MM-DD'),points,axis:choice('axial','coronal','sagittal'),index:number},['operation']),staff,async(s,a,c)=>{
    let path,body;
    if(a.operation==='create_demo'){
      if(!a.caseId)throw fail(400,'Choose a demo case');
      if(a.patientId&&a.patientId!=='research-demo')throw fail(400,'Research demo studies cannot be linked to real patients');
      path='/api/intelligence/brain/demo';body={caseId:a.caseId,patientId:'research-demo',studyDate:a.studyDate||''};
    }else{
      const study=await api(`/api/intelligence/brain/studies/${safeId(a.studyId)}`,'GET',null,c);
      const expected=a.patientId||c.selectedPatient?.patientId;
      if(expected&&(study.patientId!==expected||study.patientId==='research-demo'))throw fail(403,'Study is not associated with selected patient');
      path=`/api/intelligence/brain/studies/${safeId(a.studyId)}/${a.operation}`;
      body=a.operation==='segment'?{points:a.points}:{axis:a.axis||'axial',index:a.index};
    }
    return {data:await api(path,'POST',body,c),links:[{title:'Open Brain Explorer',href:'/brain-explorer'}]};
  },true);
  add('brain','Read actor-owned MRI studies, study details or compare two studies. Requires existing study IDs for details/comparison.',obj({operation:choice('studies','demo','study','compare'),studyId:id,otherId:id},['operation']),staff,async(_s,a,c)=>{
    const suffix=a.operation==='studies'?'studies':a.operation==='demo'?'demo':a.operation==='study'?`studies/${safeId(a.studyId)}`:`studies/${safeId(a.studyId)}/compare/${safeId(a.otherId)}`;
    const expected=c.selectedPatient?.patientId;
    if(expected&&a.operation==='compare')for(const studyId of [a.studyId,a.otherId]){
      const study=await api(`/api/intelligence/brain/studies/${safeId(studyId)}`,'GET',null,c);
      if(study.patientId!==expected)throw fail(403,'Study is not associated with selected patient');
    }
    const data=await api(`/api/intelligence/brain/${suffix}`,'GET',null,c);
    if(expected&&a.operation==='study'&&data.patientId!==expected)throw fail(403,'Study is not associated with selected patient');
    if(expected&&a.operation==='studies'&&Array.isArray(data.studies))data.studies=data.studies.filter(s=>s.patientId===expected);
    return {data,links:[{title:'Open Brain Explorer',href:'/brain-explorer'}]};
  });
  add('radar','Read actor-owned vital sessions and deterioration reference scores.',obj({sessionId:id}),staff,async(_s,a,c)=>{
    const data=await api(`/api/intelligence/radar/sessions${a.sessionId?'/'+safeId(a.sessionId):''}`,'GET',null,c);
    if(a.sessionId&&c.selectedPatient&&data.patientId!==c.selectedPatient.patientId)throw fail(403,'Session is not associated with selected patient');
    if(!a.sessionId&&c.selectedPatient&&Array.isArray(data.sessions))data.sessions=data.sessions.filter(s=>s.patientId===c.selectedPatient.patientId);
    return {data,links:[{title:'Open Radar',href:'/deterioration-radar'}]};
  });
  const vital= obj({timestamp:str('ISO timestamp'),heart_rate:number,spo2:number,systolic_bp:number,diastolic_bp:number,respiratory_rate:number,temperature:number},['timestamp','heart_rate','spo2','systolic_bp','diastolic_bp','respiratory_rate','temperature']);
  add('radar_action','Create an observation session, append supplied vital readings, advance a demo, or forecast an actor-owned session.',obj({operation:choice('create','readings','step','forecast'),patientId,sessionId:id,source:choice('demo','manual'),scenario:choice('stable','deteriorating','recovering'),readings:{type:'array',maxItems:30,items:vital},cursor:number,steps:number},['operation']),staff,async(_s,a,c)=>{
    let path,body;
    if(a.operation==='create'){path='/api/intelligence/radar/sessions';body={patientId:a.patientId||c.selectedPatient?.patientId||'research-demo',source:a.source||'manual',...(a.source==='demo'?{scenario:a.scenario||'stable'}:{})};}
    else{
      const session=await api(`/api/intelligence/radar/sessions/${safeId(a.sessionId)}`,'GET',null,c);
      const expected=a.patientId||c.selectedPatient?.patientId;
      if(expected&&session.patientId!==expected)throw fail(403,'Session is not associated with selected patient');
      path=`/api/intelligence/radar/sessions/${safeId(a.sessionId)}/${a.operation}`;body=a.operation==='readings'?{readings:a.readings}:a.operation==='forecast'?{cursor:a.cursor,steps:a.steps||12}:{};
    }
    return {data:await api(path,'POST',body,c),links:[{title:'Open Radar',href:'/deterioration-radar'}]};
  },true);
  add('run_clustering','Run a clustering algorithm against an existing selected dataset.',obj({datasetId:id,algorithm:choice('kmeans','dbscan','hierarchical','gmm'),k:number,eps:number,min_samples:number,n_clusters:number,n_components:number},['datasetId','algorithm']),staff,async(_s,a,c)=>{
    const {datasetId,algorithm,...params}=a;return {data:await api('/api/cluster','POST',{datasetId,algorithm,params},c),links:[{title:'Open Dashboard',href:'/dashboard'}]};
  },true);
  add('clinical_analysis','Use existing Clinical AI for notes, symptoms, drug interactions, or supplied vital signs. Inputs must be supplied or retrieved, never invented.',obj({operation:choice('analyze-notes','extract-symptoms','drug-interactions','mews','news2'),text:str('Clinical notes supplied by user',{maxLength:6000}),medications:{type:'array',items:str('Medication name'),maxItems:30},heart_rate:number,spo2:number,systolic_bp:number,diastolic_bp:number,respiratory_rate:number,temperature:number,consciousness:number,spo2_scale:{type:'number',enum:[1,2]},air_or_oxygen:{type:'number',enum:[0,1]}},['operation']),staff,async(_s,a,c)=>{
    const {operation,...body}=a;
    if(operation==='analyze-notes'){body.notes=body.text;delete body.text;}
    if(['mews','news2'].includes(operation)&&!['heart_rate','systolic_bp','respiratory_rate','temperature','consciousness',...(operation==='news2'?['spo2','spo2_scale','air_or_oxygen']:[])].every(k=>a[k]!==undefined))throw fail(400,'Provide all score observations; do not assume omitted clinical values');
    return {data:await api(`/api/ml/${operation}`,'POST',body,c),links:[{title:'Open Clinical AI',href:'/clinical-ai'}]};
  });
  add('advanced_analysis','Run an existing Clinical AI analysis on explicitly supplied or retrieved data. Do not invent input observations. User reviews input before execution.',obj({operation:choice('risk-profile','population-risk','compare-visits','patient-timeline','similar-patients','forecast-vitals','train-predictive-model','optimal-k','feature-importance','reduce-dimensions','detect-anomalies','explain','ask'),input:{type:'object',properties:{},additionalProperties:true,description:'Existing endpoint JSON payload using supplied or retrieved clinical data'}},['operation','input']),staff,async(_s,a,c)=>({data:await api(`/api/ml/${a.operation}`,'POST',a.input,c),links:[{title:'Open Clinical AI',href:'/clinical-ai'}]}),true);
  add('update_profile','Update permitted profile details from user input. Does not change identity, login contact or role.',obj({patientId,name:str('Display name'),emergencyName:str('Emergency contact name'),emergencyPhone:str('Emergency contact phone'),emergencyRelation:str('Relationship')},[]),both,async(s,a,c)=>{
    const body={};if(a.name!==undefined)body.name=a.name;
    if(a.emergencyName!==undefined||a.emergencyPhone!==undefined||a.emergencyRelation!==undefined){
      const current=await api(`/api/patient-app/${safeId(target(s,a))}/profile`,'GET',null,c);
      body.emergencyContact={...current.emergencyContact,...(a.emergencyName!==undefined?{name:a.emergencyName}:{}),...(a.emergencyPhone!==undefined?{phone:a.emergencyPhone}:{}),...(a.emergencyRelation!==undefined?{relation:a.emergencyRelation}:{})};
    }
    if(!Object.keys(body).length)throw fail(400,'Provide a profile field to update');
    return {data:await api(`/api/patient-app/${safeId(target(s,a))}/profile`,'PUT',body,c)};
  },true);
  add('book_appointment','Request an appointment using details supplied by user. Creates REQUESTED status, not a confirmed booking.',obj({patientId,at:str('Future ISO date/time'),doctor:str('Doctor name supplied by user'),department:str('Department'),location:str('Clinic/hospital supplied by user'),reason:str('Reason')},['at','doctor','location']),both,async(s,a,c)=>{
    const {patientId:_,...body}=a;return {data:await api(`/api/patient-app/${safeId(target(s,a))}/appointments`,'POST',body,c)};
  },true);
  add('change_appointment','Reschedule or cancel an existing patient appointment; provide exactly one of at or status.',obj({patientId,appointmentId:id,at:str('New future ISO timestamp'),status:choice('CANCELLED')},['appointmentId']),both,async(s,a,c)=>{
    if((a.at!==undefined)===(a.status!==undefined))throw fail(400,'Provide either a new appointment time or cancellation, not both');
    return {data:await api(`/api/patient-app/${safeId(target(s,a))}/appointments/${safeId(a.appointmentId)}`,'PATCH',a.at?{at:a.at}:{status:a.status},c)};
  },true);
  add('appointment_status','Clinician-only appointment confirmation or completion. Existing appointment rules remain enforced.',obj({patientId,appointmentId:id,status:choice('CONFIRMED','COMPLETED')},['patientId','appointmentId','status']),staff,async(s,a,c)=>({data:await api(`/api/patient-app/${safeId(target(s,a))}/appointments/${safeId(a.appointmentId)}`,'PATCH',{status:a.status},c)}),true);
  add('log_reading','Record a user-supplied glucose, blood pressure or weight measurement. Never invent measurements.',obj({patientId,type:choice('glucose','bp','weight'),value:number,diastolic:number,context:str('Reading context')},['type','value']),both,async(s,a,c)=>{
    const {patientId:_,...body}=a;return {data:await api(`/api/patient-app/${safeId(target(s,a))}/readings`,'POST',body,c,{'Idempotency-Key':c.operationId})};
  },true);
  add('create_reminder','Create a reminder from user-provided prescribed medicine and schedule; do not invent treatment.',obj({patientId,medicationName:str('Existing prescribed medication name'),dosage:str('Prescribed dosage'),times:{type:'array',items:str('HH:MM'),maxItems:12},frequency:choice('daily','weekly','as-needed'),days:{type:'array',items:choice('Mon','Tue','Wed','Thu','Fri','Sat','Sun'),maxItems:7},notes:str('Reminder notes')},['medicationName','times']),both,async(s,a,c)=>{
    if(!a.times.length||a.times.some(t=>! /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(t)))throw fail(400,'Provide valid HH:MM reminder times');
    if(a.frequency==='weekly'&&!a.days?.length)throw fail(400,'Choose weekdays for a weekly reminder');
    return {data:await api('/api/reminders','POST',{...a,patientId:target(s,a)},c)};
  },true);
  add('change_reminder','Mark an authorized reminder active/inactive or delete it.',obj({patientId,reminderId:id,operation:choice('activate','deactivate','delete')},['reminderId','operation']),both,async(s,a,c)=>{
    const reminder=await Reminder.findOne({_id:a.reminderId,patientId:target(s,a)}).lean();if(!reminder)throw fail(404,'Reminder not found');
    return {data:await api(`/api/reminders/${safeId(a.reminderId)}`,a.operation==='delete'?'DELETE':'PATCH',a.operation==='delete'?undefined:{active:a.operation==='activate'},c)};
  },true);
  add('edit_reminder','Edit a reminder using prescribed medication details and a user-supplied schedule.',obj({patientId,reminderId:id,medicationName:str('Prescribed medication name'),dosage:str('Prescribed dosage'),times:{type:'array',items:str('HH:MM'),maxItems:12},frequency:choice('daily','weekly','as-needed'),days:{type:'array',items:choice('Mon','Tue','Wed','Thu','Fri','Sat','Sun'),maxItems:7},notes:str('Reminder notes')},['reminderId']),both,async(s,a,c)=>{
    const reminder=await Reminder.findOne({_id:a.reminderId,patientId:target(s,a)}).lean();if(!reminder)throw fail(404,'Reminder not found');
    const {patientId:_,reminderId,...body}=a;if(!Object.keys(body).length)throw fail(400,'Provide reminder changes');
    if(a.times&&(!a.times.length||a.times.some(t=>! /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(t))))throw fail(400,'Provide valid HH:MM reminder times');
    if(['times','frequency','days'].some(key=>Object.hasOwn(a,key))&&(a.frequency||reminder.frequency)==='weekly'&&!(a.days||reminder.days)?.length)throw fail(400,'Choose weekdays for a weekly reminder');
    return {data:await api(`/api/reminders/${safeId(reminderId)}`,'PATCH',body,c)};
  },true);
  add('log_dose','Mark one scheduled dose as taken for an authorized reminder.',obj({patientId,reminderId:id,date:str('YYYY-MM-DD'),time:str('HH:MM')},['reminderId','date','time']),both,async(s,a,c)=>{
    const reminder=await Reminder.findOne({_id:a.reminderId,patientId:target(s,a)}).lean();if(!reminder)throw fail(404,'Reminder not found');
    return {data:await api(`/api/reminders/${safeId(a.reminderId)}/doses`,'POST',{date:a.date,time:a.time},c)};
  },true);
  add('send_sos','Request SOS for signed-in patient using current verified pickup coordinates. Reuse active incidents. Never call from inferred symptoms or previous messages.',obj({description:str('Patient-provided emergency description',{maxLength:2000})},['description']),['patient'],async(s,a,c)=>{
    const location=c.location;if(!validLocation(location))throw fail(400,'Share or verify pickup location before sending SOS');
    const base=`/api/patient-app/${safeId(s.patientId)}/emergencies`;
    let incidents;
    try{incidents=await api(base,'GET',null,c);}
    catch(error){
      if(error.status<500)throw error;
      const repaired=await recoverEmergency(s.patientId);
      if(!repaired)throw error;
      if(!['RESOLVED','CANCELLED','COMPLETED'].includes(repaired.status))return {data:repaired,reused:true,repaired:true,links:[{title:'Track emergency',href:'/app/emergency'}]};
      incidents=[];
    }
    const active=incidents.find(e=>!['RESOLVED','CANCELLED','COMPLETED'].includes(e.status));
    if(active)return {data:active,reused:true,links:[{title:'Track emergency',href:'/app/emergency'}]};
    return {data:await api(base,'POST',{...location,description:a.description},c,{'Idempotency-Key':c.operationId}),links:[{title:'Track emergency',href:'/app/emergency'}]};
  },true);
  return {
    catalog:session=>definitions.filter(d=>d.roles.includes(session.kind)).map(d=>({type:'function',function:{name:d.name,description:d.description,parameters:d.parameters}})),
    definition(name){return definitions.find(d=>d.name===name);},
    async execute(session,name,args={},context={}) {
      const d=definitions.find(d=>d.name===name);
      if(!d||!d.roles.includes(session.kind))throw fail(403,'Tool unavailable for this app role');
      validate(args,d.parameters);
      if(Object.hasOwn(args,'patientId'))target(session,args);
      if(d.write&&!context.approved)throw fail(409,'Action needs authorization');
      return d.run(session,args,context);
    },
    validate(session,name,args){const d=definitions.find(d=>d.name===name);if(!d||!d.roles.includes(session.kind))throw fail(403,'Tool unavailable for this app role');validate(args,d.parameters);if(Object.hasOwn(args,'patientId'))target(session,args);return d;}
  };
}
async function repairEmergency(patientId){
  const Emergency=require('../models/PatientEmergency'),cad=require('./patientCad');
  const rows=await Emergency.find({patientId}).sort({createdAt:-1}).limit(20).lean();
  if(!rows.length)return null;
  // ensureIncident uses ON CONFLICT DO NOTHING: existing dispatch state is never reset.
  for(const row of rows){await cad.ensureIncident(row);const state=await cad.track(row);if(!['RESOLVED','CANCELLED','COMPLETED'].includes(state.status))return state;}
  return {status:'RESOLVED'};
}
function validLocation(v){return v&&Number.isFinite(v.latitude)&&v.latitude>=-90&&v.latitude<=90&&Number.isFinite(v.longitude)&&v.longitude>=-180&&v.longitude<=180;}
async function nearbyHospitals(args,context){
  const supplied=context.location;
  let latitude,longitude,source;
  if(validLocation(supplied)){({latitude,longitude}=supplied);source='Shared location';}
  else if(args.city?.trim()){
    const url=new URL('https://nominatim.openstreetmap.org/search');url.search=new URLSearchParams({q:args.city.trim(),format:'json',limit:'1'});
    const r=await fetch(url,{headers:{'User-Agent':'MediCluster/1.0 (facility lookup)'},signal:AbortSignal.timeout(6000)});
    if(!r.ok)throw fail(503,'City lookup unavailable');const rows=await r.json();if(!rows[0])throw fail(404,'City not found');latitude=Number(rows[0].lat);longitude=Number(rows[0].lon);source=`City centre: ${args.city}`;
  }else return {needsLocation:true,message:'Share location or enter your city to find nearby hospitals.'};
  const radius=Math.max(1,Math.min(args.radiusKm||10,30))*1000;
  const query=`[out:json][timeout:3];nwr["amenity"~"^(hospital|clinic)$"](around:${radius},${latitude},${longitude});out center tags 30;`;
  let data;
  for(const endpoint of ['https://overpass-api.de/api/interpreter','https://overpass.private.coffee/api/interpreter']){
    try{
      const r=await fetch(endpoint,{method:'POST',headers:{'User-Agent':'MediCluster/1.0 (local healthcare application; hospital directory lookup)','Accept':'application/json','Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({data:query}),signal:AbortSignal.timeout(3500)});
      if(!r.ok)continue;const result=await r.json();
      if(!Array.isArray(result.elements)||result.remark)continue;
      data=result;break;
    }catch{ /* Try the independent public instance before reporting unavailability. */ }
  }
  let lookupSource='OpenStreetMap / Overpass';
  if(!data){
    // Bounded amenity-only search is supported by the Nominatim search API.
    // https://nominatim.org/release-docs/latest/api/Search/#result-restriction
    const dy=radius/111000,dx=Math.min(180,dy/Math.max(0.01,Math.cos(latitude*Math.PI/180)));
    const url=new URL('https://nominatim.openstreetmap.org/search');
    url.search=new URLSearchParams({q:'[hospital]',format:'jsonv2',bounded:'1',viewbox:[Math.max(-180,longitude-dx),Math.min(90,latitude+dy),Math.min(180,longitude+dx),Math.max(-90,latitude-dy)].join(','),limit:'10',extratags:'1'});
    try{
      const r=await fetch(url,{headers:{'User-Agent':'MediCluster/1.0 (local healthcare application; hospital directory lookup)','Accept':'application/json'},signal:AbortSignal.timeout(6000)});
      if(r.ok){
        const rows=await r.json();
        if(Array.isArray(rows))data={elements:rows.filter(row=>['hospital','clinic'].includes(row.type||row.addresstype)).map(row=>({lat:Number(row.lat),lon:Number(row.lon),tags:{name:row.name||row.display_name?.split(',')[0]||'Unnamed hospital','addr:full':row.display_name||'',phone:row.extratags?.phone||row.extratags?.['contact:phone']||'',emergency:row.extratags?.emergency||''}}))};
      }
    }catch{ /* All sources unavailable is reported below; results are never fabricated. */ }
    lookupSource='OpenStreetMap / Nominatim fallback';
  }
  if(!data)throw fail(503,'Hospital lookup unavailable. Try Hospitals page.');
  const rad=x=>x*Math.PI/180;
  const hospitals=data.elements.map(e=>{const lat=e.lat??e.center?.lat,lon=e.lon??e.center?.lon;if(!Number.isFinite(lat)||!Number.isFinite(lon))return null;const t=e.tags||{};const a=Math.sin(rad(lat-latitude)/2)**2+Math.cos(rad(latitude))*Math.cos(rad(lat))*Math.sin(rad(lon-longitude)/2)**2;return {name:t.name||'Unnamed facility',latitude:lat,longitude:lon,distanceKm:Math.round(6371*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a))*100)/100,phone:t.phone||t['contact:phone']||'',address:t['addr:full']||t['addr:street']||'',emergencyListed:t.emergency==='yes',source:'OpenStreetMap',mapUrl:`https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=16/${lat}/${lon}`};}).filter(Boolean).sort((a,b)=>a.distanceKm-b.distanceKm).slice(0,10);
  return {locationSource:source,lookupSource,hospitals:hospitals.filter(h=>h.distanceKm<=radius/1000),note:`${lookupSource.includes('fallback')?'Main map service unavailable; showing partial hospital search results. ':''}Facility listings do not confirm specialist coverage, current beds or ambulance availability.`};
}
module.exports={createTools,FEATURES,validLocation,validate,fail};
