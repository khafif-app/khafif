const WebSocket = require('ws');
const url = 'wss://khafif-signal.onrender.com/ws';
const suf = Math.random().toString(36).slice(2,8);
const UA='wa'+suf, UB='wb'+suf, P='mediapass123';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const conn=(u)=>new Promise(res=>{const w=new WebSocket(url);w.on('open',()=>w.send(JSON.stringify({t:'register',username:u,password:P})));w.on('message',d=>{const m=JSON.parse(d);if(m.t==='registered'||m.t==='logged_in')res(w); if(m.t==='error')console.log(u,'ERR',m.text);});w.on('error',e=>console.log(u,'WSERR',e.message));});
(async()=>{
  const a=await conn(UA), b=await conn(UB);
  a.send(JSON.stringify({t:'friend_add',username:UB}));
  b.send(JSON.stringify({t:'friend_add',username:UA}));
  await sleep(800);
  const b64 = Buffer.alloc(150000, 7).toString('base64'); // ~150KB binary photo-sized payload
  let gotLive=false;
  b.on('message',d=>{const m=JSON.parse(d); if(m.t==='media'&&m.from===UA&&m.data.length===b64.length) gotLive=true;});
  a.send(JSON.stringify({t:'media', to:UB, data:b64, mime:'image/jpeg'}));
  await sleep(1500);
  console.log('LIVE RELAY:', gotLive?'PASS':'FAIL');
  b.close(); await sleep(1000);
  // reconnect as UB and replay history
  const b2 = await new Promise(res=>{const w=new WebSocket(url);w.on('open',()=>w.send(JSON.stringify({t:'login',username:UB,password:P})));w.on('message',d=>{const m=JSON.parse(d);if(m.t==='logged_in')res(w); if(m.t==='error')console.log('UB relogin ERR',m.text);});});
  let gotHist=false, backlogCount=-1;
  b2.on('message',d=>{const m=JSON.parse(d); if(m.t==='media'&&m.from===UA&&m.data.length===b64.length) gotHist=true; if(m.t==='backlog_done')backlogCount=m.count;});
  b2.send(JSON.stringify({t:'open_chat',with:UA}));
  await sleep(2500);
  console.log('HISTORY REPLAY:', gotHist?'PASS':'FAIL', 'backlog count:', backlogCount);
  process.exit(0);
})();
setTimeout(()=>{console.log('TIMEOUT');process.exit(1);}, 30000);
