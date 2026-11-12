import test from 'node:test';import assert from 'node:assert/strict';
import {createEmergencyPoller} from '../src/patient-app/emergencyTracking.js';
test('tracking follows subsequent GPS fixes without overlapping requests',async()=>{
 const timers=[],seen=[];let reads=0,release;
 const poller=createEmergencyPoller({fetchCurrent:async()=>{reads++;if(reads===1)await new Promise(r=>release=r);return {status:'EN_ROUTE_TO_SCENE',ambulance:{latitude:12+reads/100}};},onUpdate:r=>seen.push(r.ambulance.latitude),setTimer:fn=>{timers.push(fn);return timers.length;},clearTimer:()=>{}});
 assert.equal(reads,1);assert.equal(timers.length,0);release();await new Promise(setImmediate);assert.equal(seen[0],12.01);assert.equal(timers.length,1);
 timers.shift()();await new Promise(setImmediate);assert.equal(seen[1],12.02);poller.stop();
});
test('stopped tracking ignores late responses, and completed requests stop GPS refresh',async()=>{
 let resolve;const seen=[];const p=createEmergencyPoller({fetchCurrent:()=>new Promise(r=>resolve=r),onUpdate:r=>seen.push(r),setTimer:()=>{throw Error('Unexpected timer');},clearTimer:()=>{}});
 p.stop();resolve({status:'EN_ROUTE_TO_SCENE'});await new Promise(setImmediate);assert.equal(seen.length,0);
 createEmergencyPoller({fetchCurrent:async()=>({status:'RESOLVED'}),onUpdate:r=>seen.push(r),setTimer:()=>{throw Error('Closed response must not poll');},clearTimer:()=>{}});await new Promise(setImmediate);assert.equal(seen.length,1);
});
