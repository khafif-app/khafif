const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const WebSocket = require('ws');
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const chrome = spawn('google-chrome', ['--headless=new','--disable-gpu','--no-sandbox',
    '--remote-debugging-port=9334','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required','about:blank'], { stdio: 'ignore' });
  const put = (p) => new Promise((res, rej) => {
    const req = http.request({ host: '127.0.0.1', port: 9334, path: p, method: 'PUT' }, (r) => {
      let d=''; r.on('data',c=>d+=c); r.on('end',()=>res(d));
    });
    req.on('error', rej); req.end();
  });
  let target=null;
  for (let i=0;i<40;i++){ await sleep(300);
    try { const d=await put('/json/new?'+encodeURIComponent('about:blank')); target=JSON.parse(d); if(target&&target.webSocketDebuggerUrl) break; } catch(e){} }
  if(!target) { console.log('FAIL no target'); chrome.kill(); process.exit(1); }
  const ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 256*1024*1024 });
  await new Promise(r=>ws.on('open',r));
  let id=0; const pend={};
  const send=(method,params)=>new Promise((res)=>{ const i=++id; pend[i]=res; ws.send(JSON.stringify({id:i,method,params})); });
  const frames=[]; let n=0;
  ws.on('message',(raw)=>{ const m=JSON.parse(raw);
    if(m.id&&pend[m.id]){ pend[m.id](m.result); delete pend[m.id]; }
    else if(m.method==='Page.screencastFrame'){
      const f='frames/f'+String(++n).padStart(4,'0')+'.jpg';
      fs.writeFileSync(f,Buffer.from(m.params.data,'base64'));
      frames.push({file:f,ts:m.params.metadata.timestamp});
      send('Page.screencastFrameAck',{sessionId:m.params.sessionId});
    } });
  const ev=(expression)=>send('Runtime.evaluate',{expression,returnByValue:true});
  await send('Page.enable',{});
  await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:2,mobile:true});
  await send('Page.navigate',{url:'http://127.0.0.1:3457/'});
  await sleep(2500);
  await send('Page.startScreencast',{format:'jpeg',quality:75,maxWidth:780,maxHeight:1688,everyNthFrame:1});
  await sleep(1500); // onboard visible
  await ev("document.getElementById('username').value='tharwat'; document.getElementById('password').value='tharwat123'; 'ok'");
  await sleep(700);
  await ev("document.querySelector('#onboard button').click(); 'ok'");
  await sleep(3000); // home, lists render
  await ev("[...document.querySelectorAll('#lists .row')].find(r=>r.textContent.includes('سارة')).click(); 'ok'");
  await sleep(2000); // chat open animation
  await ev("document.getElementById('text').value='أهلا يا سارة'; sendChat(); 'ok'");
  await sleep(1800); // bubble pop-in
  await ev("toggleRec(); 'ok'");
  await sleep(3500); // recording pulse
  await ev("toggleRec(); 'ok'");
  await sleep(2500); // voice bubble appears
  await ev("showView('home'); 'ok'");
  await sleep(1800); // navigate back
  await send('Page.stopScreencast',{});
  fs.writeFileSync('frames/manifest.json',JSON.stringify(frames));
  console.log('frames:',frames.length);
  chrome.kill(); process.exit(0);
})().catch(e=>{ console.log('ERR',e.message); process.exit(1); });
