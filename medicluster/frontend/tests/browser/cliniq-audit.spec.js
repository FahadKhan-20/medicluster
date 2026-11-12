import {test,expect} from '@playwright/test';
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
const action={id:'aaaaaaaaaaaaaaaaaaaaaaaa',tool:'create_reminder',arguments:{medicationName:'Synthetic medicine',times:['08:00']},status:'PROPOSED'};
const answer=(extra={})=>({reply:'Synthetic verified answer.',results:[],actions:[],...extra});
async function setup(page,handler){
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.addInitScript(()=>{
    const payload=btoa(JSON.stringify({sub:'synthetic-patient',kind:'patient',exp:Math.floor(Date.now()/1000)+3600}));
    localStorage.setItem('medicluster.token','synthetic-clinician');localStorage.setItem('medicluster.patientToken',`e30.${payload}.synthetic`);localStorage.setItem('medicluster.patientId',JSON.stringify('synthetic-patient'));
    Object.defineProperty(navigator,'geolocation',{configurable:true,value:{getCurrentPosition:(success,error)=>{window.__geo={success,error};}}});
  });
  const requests=[];
  await page.route(url=>url.pathname.startsWith('/api/'),async route=>{
    const path=new URL(route.request().url()).pathname;
    if(path==='/api/cliniq/chat'||path.startsWith('/api/cliniq/actions/')){requests.push({path,body:route.request().postDataJSON(),headers:route.request().headers()});return handler(route,requests);}
    let json=[];
    if(path==='/api/auth/me')json={user:{id:'synthetic-clinician',name:'Synthetic clinician',onboarded:true}};
    if(path.endsWith('/profile'))json={patientId:'synthetic-patient',name:'Synthetic patient'};
    if(path==='/api/health/ml')json={online:true};
    await route.fulfill({json});
  });
  return requests;
}
async function send(page,text,patient=true){await page.getByRole('textbox',{name:patient?'Message':'Prompt',exact:true}).fill(text);await page.getByRole('button',{name:patient?'Send':'Send prompt',exact:true}).click();}

test('patient repeated questions preserve ordered history and distinct completed request IDs',async({page})=>{
  const requests=await setup(page,route=>route.fulfill({json:answer()}));await page.goto('/app/cliniq');
  await send(page,'Show my reminders');await expect(page.getByText('Synthetic verified answer.',{exact:true})).toBeVisible();
  await send(page,'Show my reminders');await expect(page.getByText('Synthetic verified answer.',{exact:true})).toHaveCount(2);
  expect(requests[1].body.history).toEqual([{role:'user',content:'Show my reminders'},{role:'assistant',content:'Synthetic verified answer.'}]);
  expect(requests[1].body.requestId).not.toBe(requests[0].body.requestId);expect(requests[1].body.conversationId).toBe(requests[0].body.conversationId);
});
test('patient retry after uncertain network failure reuses operation request ID',async({page})=>{
  const requests=await setup(page,(route,seen)=>seen.length===1?route.abort('failed'):route.fulfill({json:answer()}));await page.goto('/app/cliniq');
  await send(page,'Create my prescribed reminder');await expect(page.getByRole('alert')).toBeVisible();
  await send(page,'Create my prescribed reminder');await expect(page.getByText('Synthetic verified answer.',{exact:true})).toBeVisible();
  expect(requests[1].body.requestId).toBe(requests[0].body.requestId);expect(requests[1].body.history).toEqual(requests[0].body.history);
});
test('clinician retry after uncertain failure reuses request ID and clean history',async({page})=>{
  const requests=await setup(page,(route,seen)=>seen.length===1?route.abort('failed'):route.fulfill({json:answer()}));await page.goto('/ask-ai');
  await send(page,'Show patient P100',false);await expect(page.getByRole('alert')).toBeVisible();
  await send(page,'Show patient P100',false);await expect(page.getByText('Synthetic verified answer.',{exact:true})).toBeVisible();
  expect(requests[1].body.requestId).toBe(requests[0].body.requestId);expect(requests[1].body.history).toEqual([]);
});
test('clinician patient selection submits explicit dataset scope',async({page})=>{
  const requests=await setup(page,(route,seen)=>route.fulfill({json:answer(seen.length===1?{results:[{tool:'find_patients',data:{matches:[{name:'Synthetic match',patientId:'P100',datasetId:'synthetic-dataset'}]}}]}:{})}));await page.goto('/ask-ai');
  await send(page,'Find Synthetic match',false);await page.getByRole('button',{name:'Synthetic match · P100 · dataset synthetic-dataset',exact:true}).click();
  await expect(page.getByText('Synthetic verified answer.',{exact:true})).toHaveCount(2);expect(requests[1].body.selectedPatient).toEqual({patientId:'P100',datasetId:'synthetic-dataset'});
});
test('clinician location retry retains attached medical image',async({page})=>{
  const requests=await setup(page,(route,seen)=>route.fulfill({json:answer(seen.length===1?{needsLocation:true}:{})}));await page.goto('/ask-ai');
  await page.locator('input[type="file"]').setInputFiles({name:'synthetic.png',mimeType:'image/png',buffer:PNG});await send(page,'Look at this photo and find hospitals nearby',false);
  await page.getByRole('button',{name:'Share location and retry',exact:true}).click();await page.evaluate(()=>window.__geo.success({coords:{latitude:12,longitude:77}}));
  await expect(page.getByText('Synthetic verified answer.',{exact:true})).toHaveCount(2);expect(requests[1].body.images).toEqual(requests[0].body.images);expect(requests[1].body.location).toEqual({latitude:12,longitude:77});
});
test('image-only patient prompt can retry after sharing location',async({page})=>{
  const requests=await setup(page,(route,seen)=>route.fulfill({json:answer(seen.length===1?{needsLocation:true}:{})}));await page.goto('/app/cliniq');
  await page.locator('input[type="file"]').setInputFiles({name:'synthetic.png',mimeType:'image/png',buffer:PNG});await page.getByRole('button',{name:'Send',exact:true}).click();
  await page.getByRole('button',{name:'Share location and retry',exact:true}).click();await page.evaluate(()=>window.__geo.success({coords:{latitude:12,longitude:77}}));
  await expect.poll(()=>requests.length).toBe(2);expect(requests[1].body.images).toEqual(requests[0].body.images);
});
test('pending action can fail then retry and show verified result',async({page})=>{
  let attempts=0;const requests=await setup(page,route=>{
    if(new URL(route.request().url()).pathname==='/api/cliniq/chat')return route.fulfill({json:answer({actions:[action]})});
    attempts++;return attempts===1?route.fulfill({status:503,json:{error:'Synthetic temporary error'}}):route.fulfill({json:{result:{data:{id:'synthetic-reminder',active:true}}}});
  });await page.goto('/app/cliniq');await send(page,'Create reminder');
  await page.getByRole('button',{name:'Approve action',exact:true}).click();await expect(page.getByText('Synthetic temporary error',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Approve action',exact:true}).click();await expect(page.getByText('Completed. See verified result below.')).toBeVisible();
  expect(requests.slice(1).map(r=>r.body)).toEqual([{decision:'approve'},{decision:'approve'}]);
});
test('cancel reflects server outcome if action already succeeded',async({page})=>{
  await setup(page,route=>route.fulfill({json:new URL(route.request().url()).pathname==='/api/cliniq/chat'?answer({actions:[action]}):{result:{data:{id:'already-created-reminder',active:true}}}}));await page.goto('/app/cliniq');await send(page,'Create reminder');
  await page.getByRole('button',{name:'Cancel',exact:true}).click();await expect(page.getByText('Cancelled.',{exact:true})).toHaveCount(0);await expect(page.getByText('Completed. See verified result below.')).toBeVisible();
});
test('patient signout removes prior private conversation and actions',async({page})=>{
  await setup(page,route=>route.fulfill({json:answer({actions:[action]})}));await page.goto('/app/cliniq');await send(page,'Show private reminders');await expect(page.getByRole('button',{name:'Approve action',exact:true})).toBeVisible();
  await page.evaluate(()=>window.dispatchEvent(new Event('medicluster:patient-signed-out')));await expect(page.getByRole('button',{name:'Approve action',exact:true})).toHaveCount(0);await expect(page.getByText('Synthetic verified answer.',{exact:true})).toHaveCount(0);
});

async function mountPrivateMedia(page,component,props){
  await page.evaluate(async({component,props})=>{
    const [{default:React},{default:ReactDOM},media]=await Promise.all([import('/node_modules/.vite/deps/react.js'),import('/node_modules/.vite/deps/react-dom_client.js'),import('/src/components/PrivateMedia.jsx')]);
    const target=document.createElement('div');document.body.append(target);window.__mediaRoot=ReactDOM.createRoot(target);
    window.__renderMedia=(next)=>window.__mediaRoot.render(React.createElement(media[component],next));window.__renderMedia(props);
  },{component,props});
}
test('private image uses patient auth and discards source after token change',async({page})=>{
  await setup(page,route=>route.fulfill({json:answer()}));let authorization;
  await page.route('**/api/media/file/aaaaaaaaaaaaaaaaaaaaaaaa',async route=>{authorization=route.request().headers().authorization;await route.fulfill({body:PNG,contentType:'image/png'});});
  await page.goto('/app/cliniq');await mountPrivateMedia(page,'PrivateImage',{source:'/api/media/file/aaaaaaaaaaaaaaaaaaaaaaaa',alt:'Synthetic protected photo'});
  const img=page.getByRole('img',{name:'Synthetic protected photo',exact:true});await expect(img).toHaveAttribute('src',/^blob:/);expect(authorization).toMatch(/^Bearer e30\./);
  await page.evaluate(()=>{localStorage.setItem('medicluster.patientToken','replacement-token');window.__renderMedia({source:'/invalid',alt:'Synthetic protected photo'});});await expect(img).not.toHaveAttribute('src');
});
test('private file failure allows safe download retry with patient auth',async({page})=>{
  await setup(page,route=>route.fulfill({json:answer()}));let attempts=0,authorization;
  await page.route('**/api/media/file/aaaaaaaaaaaaaaaaaaaaaaaa',async route=>{
    authorization=route.request().headers().authorization;attempts++;return attempts===1?route.fulfill({status:503,json:{error:'Synthetic unavailable'}}):route.fulfill({body:Buffer.from('Synthetic report'),contentType:'application/pdf'});
  });await page.goto('/app/cliniq');await mountPrivateMedia(page,'PrivateFileLink',{source:'/api/media/file/aaaaaaaaaaaaaaaaaaaaaaaa',filename:'synthetic.pdf',children:'Synthetic private report'});
  await page.getByRole('button',{name:'Synthetic private report',exact:true}).click();await expect(page.getByText('File unavailable. Check sign-in and retry.',{exact:true})).toBeVisible();
  const downloadPromise=page.waitForEvent('download');await page.getByRole('button',{name:'Synthetic private report',exact:true}).click();const download=await downloadPromise;
  expect(download.suggestedFilename()).toBe('synthetic.pdf');expect(authorization).toMatch(/^Bearer e30\./);await expect(page.getByText('File unavailable. Check sign-in and retry.',{exact:true})).toHaveCount(0);
});
test('pending cancellation sends cancel and removes approval controls',async({page})=>{
  const requests=await setup(page,route=>route.fulfill({json:new URL(route.request().url()).pathname==='/api/cliniq/chat'?answer({actions:[action]}):{result:{cancelled:true}}}));
  await page.goto('/app/cliniq');await send(page,'Create reminder');await page.getByRole('button',{name:'Cancel',exact:true}).click();
  await expect(page.getByText('Cancelled.',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Approve action',exact:true})).toHaveCount(0);expect(requests[1].body).toEqual({decision:'cancel'});
});
test('patient image follows subsequent text query without reattaching',async({page})=>{
  const requests=await setup(page,route=>route.fulfill({json:answer()}));await page.goto('/app/cliniq');
  await page.locator('input[type="file"]').setInputFiles({name:'synthetic.png',mimeType:'image/png',buffer:PNG});await send(page,'Explain this image');await expect(page.getByText('Synthetic verified answer.',{exact:true})).toBeVisible();
  await send(page,'Explain prevention');await expect(page.getByText('Synthetic verified answer.',{exact:true})).toHaveCount(2);expect(requests[1].body.images).toEqual(requests[0].body.images);
});
test('denied location shows error without submitting a new request',async({page})=>{
  const requests=await setup(page,route=>route.fulfill({json:answer({needsLocation:true})}));await page.goto('/app/cliniq');await send(page,'Find nearby hospitals');
  await page.getByRole('button',{name:'Share location and retry',exact:true}).click();await page.evaluate(()=>window.__geo.error({code:1,message:'Synthetic denied'}));
  await expect(page.getByText('Location permission denied. Open Emergency to set pickup location, or enter your city.',{exact:true})).toBeVisible();expect(requests).toHaveLength(1);
});
test('clinician new chat clears actions and creates new conversation scope',async({page})=>{
  const requests=await setup(page,route=>route.fulfill({json:answer({actions:[action]})}));await page.goto('/ask-ai');await send(page,'Create reminder',false);await expect(page.getByRole('button',{name:'Approve action',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'New chat',exact:true}).click();await expect(page.getByRole('button',{name:'Approve action',exact:true})).toHaveCount(0);
  await send(page,'Show appointments',false);await expect(page.getByText('Synthetic verified answer.',{exact:true})).toBeVisible();expect(requests[1].body.history).toEqual([]);expect(requests[1].body.conversationId).not.toBe(requests[0].body.conversationId);
});
