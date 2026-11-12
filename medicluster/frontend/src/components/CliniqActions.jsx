import { useRef, useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { cliniqAction } from '../api/apiClient';
import { DISPATCH_URL } from '../navigation';
const labels={send_sos:'Request emergency help',book_appointment:'Request appointment',change_appointment:'Change appointment',log_reading:'Save reading',create_reminder:'Create medication reminder',change_reminder:'Change reminder',analyze_image:'Analyze image'};
const friendly = value => value.replaceAll('_',' ').replace(/([a-z])([A-Z])/g,'$1 $2');
function AppLink({link}){
  if(typeof link?.href!=='string')return null;
  if(link.href==='/dispatch')return <a className="underline text-sm" href={DISPATCH_URL} target="_blank" rel="noopener noreferrer">{link.title}</a>;
  if(/^\/(?!\/)[a-z][a-z0-9/-]*(?:\?[a-zA-Z0-9_=%&.-]*)?$/.test(link.href))return <Link className="underline text-sm" to={link.href}>{link.title}</Link>;
  try { const url=new URL(link.href);if(url.protocol==='https:'&&url.hostname==='www.openstreetmap.org')return <a className="underline text-sm" href={url.href} target="_blank" rel="noopener noreferrer">{link.title}</a>; }catch{}
  return null;
}
function Action({action}){
  const [state,setState]=useState(action.status==='SUCCEEDED'?'succeeded':action.status==='PROPOSED'||!action.status?'pending':action.status.toLowerCase());
  const [error,setError]=useState(''),[result,setResult]=useState(null);const controller=useRef(null);
  useEffect(()=>()=>controller.current?.abort(),[]);
  const decide=async decision=>{
    if(state!=='pending')return;setState('working');setError('');controller.current=new AbortController();
    try{const data=await cliniqAction(action.id,decision,controller.current.signal);setResult(data.result);setState(data.result?.cancelled===true?'cancelled':'succeeded');}
    catch(e){if(e.code!=='ERR_CANCELED'){setState('pending');setError(e.response?.data?.error||'Action did not return a verified success. Check app state before retrying.');}}
  };
  return <section className="rounded-2xl border border-line bg-white p-4 space-y-3 text-sm" aria-label={labels[action.tool]||friendly(action.tool)}>
    <strong>{labels[action.tool]||friendly(action.tool)}</strong>
    {action.selectedPatient&&<p>Patient: {action.selectedPatient.name||action.selectedPatient.patientId} · {action.selectedPatient.patientId}</p>}
    <dl className="space-y-1">{Object.entries(action.arguments||{}).map(([key,value])=><div key={key} className="flex flex-wrap gap-2"><dt className="text-slate-500">{friendly(key)}:</dt><dd className="break-words">{Array.isArray(value)?value.join(', '):String(value)}</dd></div>)}</dl>
    {action.location&&<p>Pickup: {action.location.latitude.toFixed(5)}, {action.location.longitude.toFixed(5)}. Verify before sending.</p>}
    <p role="status">{state==='pending'?'Not performed. Review details before approving.':state==='working'?'Working…':state==='succeeded'?'Completed. See verified result below.':state==='cancelled'?'Cancelled.':friendly(state)}</p>
    {state==='pending'&&<div className="flex gap-3"><button type="button" className="rounded-full bg-ink text-paper px-4 py-2" onClick={()=>decide('approve')}>Approve action</button><button type="button" className="underline" onClick={()=>decide('cancel')}>Cancel</button></div>}
    {error&&<p role="alert" className="text-red-700">{error}</p>}
    {result&&<ToolResult result={{tool:action.tool,data:result}}/>}
  </section>;
}
function ToolResult({result,onSelect}){
  if(result.error)return <p role="status" className="text-sm text-red-700">{friendly(result.tool)}: {result.error}</p>;
  const data=result.data;if(!data||data.pending)return null;
  if(data.hospitals)return <div className="space-y-3"><p className="text-xs text-slate-500">{data.locationSource} · OpenStreetMap</p>{data.hospitals.length===0&&<p>No facilities returned in this radius.</p>}{data.hospitals.map((h,i)=><div key={i} className="border border-line rounded-xl p-3 text-sm"><strong>{h.name}</strong><p>{h.distanceKm} km · {h.address}</p>{h.phone&&<p>{h.phone}</p>}<AppLink link={{title:'Open map',href:h.mapUrl}}/></div>)}<p className="text-xs text-slate-500">{data.note}</p></div>;
  if(data.matches)return <div className="space-y-2"><p className="text-sm">{data.matches.length?'Select patient to continue:':'No matching patient found.'}</p>{data.matches.map((p,i)=><button key={i} type="button" className="block text-left underline text-sm" onClick={()=>onSelect?.(`Use patient ID ${p.patientId}${p.datasetId?` from dataset ${p.datasetId}`:''}. Please show their record.`,{patientId:p.patientId,...(p.datasetId?{datasetId:p.datasetId}:{})})}>{p.name} · {p.patientId}{p.datasetId?` · dataset ${p.datasetId}`:''}</button>)}</div>;
  if(data.features)return <div className="flex flex-wrap gap-3">{data.features.map(f=><AppLink key={f.feature} link={f}/>)}</div>;
  if(data.needsLocation)return <p className="text-sm">{data.message}</p>;
  if(data.data!==undefined)return <details className="text-sm"><summary className="cursor-pointer">{friendly(result.tool)} · verified result</summary><pre className="whitespace-pre-wrap break-words max-h-64 overflow-auto text-xs mt-2">{JSON.stringify(data.data,null,2)}</pre></details>;
  return null;
}
export default function CliniqActions({data,onSelect,onLocation}){
  if(!data)return null;
  const links=[...(data.links||[]),...(data.results||[]).flatMap(r=>r.data?.links||[])].filter((l,i,all)=>all.findIndex(x=>x.href===l.href)===i);
  return <div className="mt-3 space-y-3 min-w-0">
    {(data.results||[]).map((r,i)=><ToolResult key={i} result={r} onSelect={onSelect}/>)}
    {(data.actions||[]).map(a=><Action key={a.id} action={a}/>)}
    {data.needsLocation&&onLocation&&<button type="button" className="rounded-full border border-line px-4 py-2 text-sm" onClick={onLocation}>Share location and retry</button>}
    {links.length>0&&<div className="flex flex-wrap gap-3">{links.map((l,i)=><AppLink key={i} link={l}/>)}</div>}
    {data.model&&<p className="text-[10px] text-slate-500">{data.provider} · {data.model}</p>}
  </div>;
}
