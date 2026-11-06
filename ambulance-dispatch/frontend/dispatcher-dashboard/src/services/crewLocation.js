/** Serial, bounded GPS publication for one authenticated crew vehicle. */
export function resolveCrewVehicle({profile,ambulances,deviceVehicleId}){
  if(!profile?.id)return null;
  const current=ambulances.find(a=>a.assigned_driver_id===profile?.id);
  if(current)return current;
  if(profile?.role==='DRIVER')return null;
  return ambulances.find(a=>a.id===deviceVehicleId)||null;
}
export function createCrewLocationPublisher({vehicleId,send,onStatus=()=>{},intervalMs=5000,now=Date.now,setTimeoutFn=setTimeout,clearTimeoutFn=clearTimeout}){
  if(!vehicleId)throw new Error('Select a crew vehicle before sharing GPS');
  let pending=null,inFlight=false,stopped=false,timer=null,nextAt=0,latestAt=-Infinity,controller;
  const schedule=()=>{
    if(stopped||inFlight||!pending||timer!==null)return;
    const wait=Math.max(0,nextAt-now());
    if(wait){timer=setTimeoutFn(()=>{timer=null;flush();},wait);return;}
    void flush();
  };
  async function flush(){
    if(stopped||inFlight||!pending)return;
    const fix=pending;pending=null;
    if(now()-Date.parse(fix.recordedAt)>120000){onStatus('waiting');return;}
    inFlight=true;controller=new AbortController();onStatus('syncing');
    try{await send(vehicleId,fix,controller.signal);if(!stopped)onStatus('live');}
    catch(error){if(!stopped&&error.code!=='ERR_CANCELED'&&error.name!=='AbortError'){if(!pending)pending=fix;onStatus('sync-error');}}
    finally{inFlight=false;nextAt=now()+intervalMs;schedule();}
  }
  return {
    push(position){
      const {latitude,longitude}=position?.coords||{};
      const timestamp=Number.isFinite(position?.timestamp)?position.timestamp:now();
      if(stopped||!Number.isFinite(latitude)||Math.abs(latitude)>90||!Number.isFinite(longitude)||Math.abs(longitude)>180||timestamp<latestAt||timestamp>now()+30000)return false;
      latestAt=timestamp;pending={latitude,longitude,recordedAt:new Date(timestamp).toISOString()};schedule();return true;
    },
    stop(){stopped=true;pending=null;if(timer!==null)clearTimeoutFn(timer);timer=null;controller?.abort();}
  };
}
