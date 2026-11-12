import {test,expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';
const tokenFor=(sub,kind='patient')=>`${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({sub,kind,role:'authenticated',exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')}.fixture`;
test('patient map follows assigned crew fixes and stops sharing after completion',async({page})=>{
 await page.emulateMedia({reducedMotion:'reduce'});await page.clock.install();
 await page.addInitScript(token=>{localStorage.setItem('medicluster.patientToken',token);localStorage.setItem('medicluster.patientId',JSON.stringify('patient-fixture'));},tokenFor('patient-fixture'));
 const first={id:'incident-fixture',status:'EN_ROUTE_TO_SCENE',createdAt:new Date().toISOString(),location:{latitude:12.98,longitude:77.60},ambulance:{callSign:'Fixture Crew',latitude:12.97,longitude:77.59,lastPing:new Date().toISOString()}};let reads=0;
 await page.route(u=>u.pathname.startsWith('/api/'),async route=>{
  const p=new URL(route.request().url()).pathname;let json=[];
  if(p.endsWith('/profile'))json={patientId:'patient-fixture',name:'Synthetic Patient'};
  if(p.endsWith('/emergencies'))json=[first];
  if(p.endsWith('/emergencies/incident-fixture')){reads++;json=reads===1?first:reads===2?{...first,ambulance:{...first.ambulance,latitude:12.975,longitude:77.595,lastPing:new Date().toISOString()}}:{...first,status:'RESOLVED'};}
  await route.fulfill({json});
 });
 await page.goto('/app/emergency');await page.getByRole('tab',{name:'Tracking',exact:true}).click();
 await expect(page.locator('.pt-tracking-pin.ambulance')).toHaveAttribute('title','Fixture Crew · 12.97000, 77.59000');
 await page.clock.fastForward(5000);
 await expect(page.locator('.pt-tracking-pin.ambulance')).toHaveAttribute('title','Fixture Crew · 12.97500, 77.59500');
 await page.clock.fastForward(5000);await expect(page.getByText('Live tracking ended',{exact:true})).toBeVisible();
 await expect(page.locator('.pt-tracking-pin.ambulance')).toHaveCount(0);await page.clock.fastForward(10000);expect(reads).toBe(3);
});
test('crew GPS is persisted to server-owned vehicle and failed uploads are never labelled live',async({page})=>{
 const env=await readFile(new URL('../../../../ambulance-dispatch/frontend/dispatcher-dashboard/.env',import.meta.url),'utf8');
 const origin=new URL(env.match(/^VITE_SUPABASE_URL=(.*)$/m)[1].trim());
 const token=tokenFor('driver-fixture','crew'),unit={id:'crew-fixture',assigned_driver_id:'driver-fixture',call_sign:'Fixture Unit',latitude:12.97,longitude:77.59,status:'AVAILABLE',type:'ALS'};
 await page.addInitScript(({key,token})=>{
  const user={id:'driver-fixture',email:'synthetic@example.test',aud:'authenticated',role:'authenticated'};
  localStorage.setItem(key,JSON.stringify({access_token:token,refresh_token:'fixture-refresh',expires_at:Math.floor(Date.now()/1000)+3600,expires_in:3600,token_type:'bearer',user}));
  localStorage.setItem('medicluster.driver.vehicleId','stale-device-vehicle');localStorage.setItem('medicluster.driver.shiftStart',String(Date.now()));
  navigator.geolocation.watchPosition=(success,error)=>{window.__crewGps={success,error};return 1;};navigator.geolocation.clearWatch=()=>{};
 },{key:`sb-${origin.hostname.split('.')[0]}-auth-token`,token});
 if(page.routeWebSocket)await page.routeWebSocket('**/realtime/v1/websocket**',ws=>ws.close());
 await page.route(u=>u.hostname===origin.hostname,async route=>{
  const u=new URL(route.request().url());let data=[];
  if(u.pathname.includes('/profiles'))data=[{id:'driver-fixture',role:'DRIVER',full_name:'Synthetic Crew'}];
  if(u.pathname.includes('/ambulances'))data=[unit];
  if(route.request().headers().accept?.includes('vnd.pgrst.object'))data=data[0]||null;
  await route.fulfill({json:data});
 });
 const uploads=[];let fail=true;
 await page.route(u=>u.port==='3001',async route=>{
  if(route.request().method()==='OPTIONS')return route.fulfill({status:204,headers:{'access-control-allow-origin':'http://localhost:5174','access-control-allow-headers':'authorization,content-type','access-control-allow-methods':'PATCH,OPTIONS'}});
  uploads.push({path:new URL(route.request().url()).pathname,body:route.request().postDataJSON(),auth:route.request().headers().authorization});
  await route.fulfill({status:fail?503:200,headers:{'access-control-allow-origin':'http://localhost:5174'},json:fail?{error:'Synthetic offline'}:unit});
 });
 await page.goto('http://localhost:5174/#/driver');
 await expect.poll(()=>page.evaluate(()=>!!window.__crewGps)).toBe(true);
 await page.evaluate(()=>window.__crewGps.success({coords:{latitude:12.971,longitude:77.591},timestamp:Date.now()}));
 await expect(page.getByText(/GPS SYNC FAILED/)).toBeVisible();expect(uploads[0].path).toBe('/api/ambulances/crew-fixture/location');expect(uploads[0].auth).toBe(`Bearer ${token}`);
 fail=false;await page.evaluate(()=>window.__crewGps.success({coords:{latitude:12.972,longitude:77.592},timestamp:Date.now()}));
 await expect(page.getByText(/GPS LIVE/)).toBeVisible({timeout:10000});expect(uploads.at(-1).body.latitude).toBe(12.972);expect(uploads.at(-1).body.recordedAt).toBeTruthy();
 unit.id='crew-next';unit.call_sign='Fixture Unit Two';
 await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
 await expect(page.getByText(/Fixture Unit Two/).first()).toBeVisible();
 await page.evaluate(()=>window.__crewGps.success({coords:{latitude:12.973,longitude:77.593},timestamp:Date.now()}));
 await expect.poll(()=>uploads.at(-1).path).toBe('/api/ambulances/crew-next/location');
});
