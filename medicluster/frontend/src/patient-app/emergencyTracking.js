export const isClosedEmergency=status=>['RESOLVED','CANCELLED','CLOSED','COMPLETED'].includes(status);
/** Wait for each read before scheduling the next; discard results after cleanup. */
export function createEmergencyPoller({fetchCurrent,onUpdate,onError=()=>{},intervalMs=5000,setTimer=setTimeout,clearTimer=clearTimeout}){
  let stopped=false,timer,controller;
  async function update(){
    controller=new AbortController();let done=false;
    try{const item=await fetchCurrent(controller.signal);if(stopped)return;if(item){onUpdate(item);done=isClosedEmergency(item.status);}}
    catch(error){if(!stopped&&error.code!=='ERR_CANCELED'&&error.name!=='AbortError')onError(error);}
    if(!stopped&&!done&&intervalMs!==null)timer=setTimer(update,intervalMs);
  }
  void update();
  return {stop(){stopped=true;clearTimer(timer);controller?.abort();}};
}
