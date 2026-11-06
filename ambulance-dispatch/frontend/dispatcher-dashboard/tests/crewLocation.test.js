import test from 'node:test';
import assert from 'node:assert/strict';
import {createCrewLocationPublisher} from '../src/services/crewLocation.js';
function clock(){let time=1000;const timers=new Map();let id=0;return {now:()=>time,setTimeoutFn:fn=>{timers.set(++id,fn);return id;},clearTimeoutFn:key=>timers.delete(key),tick:async ms=>{time+=ms;const work=[...timers.values()];timers.clear();work.forEach(fn=>fn());await new Promise(setImmediate);}};}
test('crew fixes reach bound ambulance and latest fix is throttled, not discarded',async()=>{
 const c=clock(),sent=[],status=[];const p=createCrewLocationPublisher({vehicleId:'own-unit',send:async(id,fix)=>sent.push({id,...fix}),onStatus:s=>status.push(s),...c});
 p.push({coords:{latitude:12,longitude:77},timestamp:c.now()});await new Promise(setImmediate);
 assert.equal(sent[0].id,'own-unit');assert.equal(sent[0].latitude,12);assert.equal(status.at(-1),'live');
 p.push({coords:{latitude:12.1,longitude:77.1},timestamp:1100});p.push({coords:{latitude:12.2,longitude:77.2},timestamp:1200});
 assert.equal(sent.length,1);await c.tick(5000);assert.equal(sent.length,2);assert.equal(sent[1].latitude,12.2);p.stop();
});
test('failed upload reports sync failure and retries newest real coordinates',async()=>{
 const c=clock(),sent=[],states=[];let fail=true;const p=createCrewLocationPublisher({vehicleId:'own-unit',send:async(_id,fix)=>{sent.push(fix);if(fail)throw Error('offline');},onStatus:s=>states.push(s),...c});
 p.push({coords:{latitude:0,longitude:0},timestamp:c.now()});await new Promise(setImmediate);assert.equal(states.at(-1),'sync-error');
 fail=false;p.push({coords:{latitude:0.1,longitude:0.2},timestamp:1200});await c.tick(5000);assert.equal(sent.at(-1).latitude,0.1);assert.equal(states.at(-1),'live');p.stop();
});
test('invalid, older and stopped fixes never publish another vehicle location',async()=>{
 const c=clock(),sent=[];const p=createCrewLocationPublisher({vehicleId:'own-unit',send:async(id,fix)=>sent.push({id,...fix}),...c});
 assert.equal(p.push({coords:{latitude:91,longitude:10}}),false);
 p.push({coords:{latitude:12,longitude:77},timestamp:1000});await new Promise(setImmediate);
 assert.equal(p.push({coords:{latitude:11,longitude:77},timestamp:900}),false);
 p.stop();assert.equal(p.push({coords:{latitude:13,longitude:77},timestamp:1200}),false);await c.tick(5000);assert.equal(sent.length,1);
});
test('current assignment replaces stale login/device vehicle and unassignment stops sharing',async()=>{
 const {resolveCrewVehicle}=await import('../src/services/crewLocation.js');
 const profile={id:'driver-fixture',role:'DRIVER'},old={id:'old-unit',assigned_driver_id:profile.id},current={id:'new-unit',assigned_driver_id:profile.id};
 const common={profile,assignedAmbulance:old,deviceVehicleId:'old-unit'};
 assert.equal(resolveCrewVehicle({...common,loading:false,ambulances:[{...old,assigned_driver_id:'other-driver'},current]}).id,'new-unit');
 assert.equal(resolveCrewVehicle({...common,loading:false,ambulances:[]}),null);
 assert.equal(resolveCrewVehicle({...common,loading:true,ambulances:[]}),null);
});
