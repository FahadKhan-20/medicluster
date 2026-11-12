import {test,expect} from '@playwright/test';
async function setup(page,role){
  await page.emulateMedia({reducedMotion:'reduce'});
  const patientId='patient-own';
  const patientToken=`${btoa('{}')}.${btoa(JSON.stringify({sub:patientId,kind:'patient',exp:Math.floor(Date.now()/1000)+3600}))}.fixture`;
  await page.addInitScript(({patientToken,patientId})=>{
    localStorage.setItem('medicluster.token','clinician-fixture');
    localStorage.setItem('medicluster.patientToken',patientToken);
    localStorage.setItem('medicluster.patientId',JSON.stringify(patientId));
  },{patientToken,patientId});
  let submitted,approval;
  await page.route(u=>u.pathname.startsWith('/api/'),async route=>{
    const path=new URL(route.request().url()).pathname;let json=[];
    if(path==='/api/auth/me')json={user:{id:'staff-fixture',name:'Clinician Fixture',onboarded:true}};
    if(path.endsWith('/profile'))json={patientId,name:'Own Patient'};
    if(path==='/api/health/ml')json={online:true};
    if(path==='/api/cliniq/chat'){
      submitted=route.request();
      json={role,reply:role==='patient'?'Your name is Own Patient. Review your reminder.':'Matching clinical record found.',model:'fixture-model',provider:'fixture',results:role==='clinician'?[{tool:'find_patients',data:{matches:[{name:'Clinical Patient',patientId:'P100'}]}}]:[{tool:'patient_record',data:{data:{patientId,name:'Own Patient'}}}],actions:role==='patient'?[{id:'aaaaaaaaaaaaaaaaaaaaaaaa',tool:'create_reminder',arguments:{medicationName:'Prescribed fixture medicine',times:['08:00']},status:'PROPOSED'}]:[],links:[{title:role==='patient'?'My health':'Patients',href:role==='patient'?'/app/health':'/patient'}]};
    }
    if(path.startsWith('/api/cliniq/actions/')){approval=route.request();json={result:{data:{_id:'reminder-fixture',patientId,active:true}}};}
    await route.fulfill({json});
  });
  return {patientToken,getSubmitted:()=>submitted,getApproval:()=>approval};
}
test('patient chat uses patient token even with clinician session present, and approves structured actions',async({page})=>{
  const fixture=await setup(page,'patient');await page.goto('/app/cliniq');
  await page.getByRole('textbox',{name:'Message',exact:true}).fill('Show my profile and reminder');
  await page.getByRole('button',{name:'Send',exact:true}).click();
  await expect(page.getByText('Your name is Own Patient. Review your reminder.',{exact:true})).toBeVisible();
  expect(fixture.getSubmitted().headers().authorization).toBe(`Bearer ${fixture.patientToken}`);
  expect(fixture.getSubmitted().postDataJSON().patientId).toBeUndefined();
  await expect(page.getByRole('link',{name:'My health',exact:true})).toHaveAttribute('href','/app/health');
  await expect(page.getByText('Clinical Patient',{exact:false})).toHaveCount(0);
  await page.getByRole('button',{name:'Approve action',exact:true}).click();
  await expect(page.getByText('Completed. See verified result below.')).toBeVisible();
  expect(fixture.getApproval().postDataJSON()).toEqual({decision:'approve'});
  expect(fixture.getApproval().headers().authorization).toBe(`Bearer ${fixture.patientToken}`);
});
test('clinician chat uses clinician session and provides patient selection from grounded results',async({page})=>{
  const fixture=await setup(page,'clinician');await page.goto('/ask-ai');
  await page.getByRole('button',{name:/Skin & rashes/}).click();
  await expect(page.getByText('Matching clinical record found.',{exact:true})).toBeVisible();
  expect(fixture.getSubmitted().headers().authorization).toBe('Bearer clinician-fixture');
  await expect(page.getByRole('button',{name:'Clinical Patient · P100',exact:true})).toBeVisible();
  await expect(page.getByRole('link',{name:'Patients',exact:true}).last()).toHaveAttribute('href','/patient');
});

test('late location retry cannot restore a cleared clinician conversation',async({page})=>{
  await page.addInitScript(()=>{
    Object.defineProperty(navigator,'geolocation',{configurable:true,value:{getCurrentPosition:success=>{window.__locationSuccess=success;}}});
  });
  await setup(page,'clinician');let requests=0;
  await page.route(u=>u.pathname==='/api/cliniq/chat',async route=>{requests++;await route.fulfill({json:{reply:'Share location to find hospitals.',needsLocation:true,results:[],actions:[]}});});
  await page.goto('/ask-ai');await page.getByRole('button',{name:/Skin & rashes/}).click();
  await page.getByRole('button',{name:'Share location and retry'}).click();
  await page.getByRole('button',{name:'New chat',exact:true}).click();
  await page.evaluate(async()=>{window.__locationSuccess({coords:{latitude:12,longitude:77}});await new Promise(requestAnimationFrame);});
  await expect(page.locator('.mc-cliniq-category')).toHaveCount(4);expect(requests).toBe(1);
});
