const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const WebSocket = require('ws');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let server = null, chrome = null, failures = 0, phase = 'start';
const check = (name, ok, extra) => { console.log((ok ? 'PASS' : 'FAIL') + ' ' + name + (extra ? ' | ' + extra : '')); if (!ok) failures++; };
const watchdog = setTimeout(() => { console.log('WATCHDOG TIMEOUT at phase: ' + phase); cleanup(1); }, 75000);
function cleanup(code) { try { if (chrome) chrome.kill('SIGKILL'); } catch (e) {} try { if (server) server.kill('SIGKILL'); } catch (e) {} try { fs.renameSync('data.json.bak-test', 'data.json'); } catch (e) {} process.exit(code); }
process.on('SIGTERM', () => cleanup(1));

function wsClient(name) {
  const ws = new WebSocket('ws://127.0.0.1:3462');
  const msgs = []; const waiters = [];
  ws.on('message', d => { const m = JSON.parse(d); msgs.push(m); for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i].p(m)) { waiters[i].res(m); waiters.splice(i, 1); } });
  const send = o => ws.send(JSON.stringify(o));
  const waitFor = (p, ms = 8000) => new Promise((res, rej) => { const found = msgs.find(p); if (found) return res(found); waiters.push({ p, res }); setTimeout(() => rej(new Error(name + ' timeout waiting')), ms); });
  return { ws, send, waitFor, open: new Promise(r => ws.on('open', r)) };
}

(async () => {
  fs.copyFileSync('data.json', 'data.json.bak-test');
  server = spawn('node', ['server.js'], { env: { ...process.env, PORT: '3462' } });
  await new Promise(r => server.stdout.on('data', d => { if (String(d).includes('listening')) r(); }));
  phase = 'ws-flow';
  const A = wsClient('A'), B = wsClient('B');
  await A.open; await B.open;
  A.send({ t: 'register', username: 'vtesta', password: 'vtestpass1' });
  await A.waitFor(m => m.t === 'registered');
  B.send({ t: 'register', username: 'vtestb', password: 'vtestpass1' });
  await B.waitFor(m => m.t === 'registered');
  check('register both', true);
  A.send({ t: 'friend_add', username: 'vtestb' });
  await B.waitFor(m => m.t === 'friend_request' && m.from === 'vtesta');
  B.send({ t: 'friend_accept', username: 'vtesta' });
  await A.waitFor(m => m.t === 'friend_added' && m.user === 'vtestb');
  check('friend request + accept', true);
  A.send({ t: 'chat', to: 'vtestb', text: 'أهلا يا صاحبي 👋' });
  const cm = await B.waitFor(m => m.t === 'chat');
  check('text chat delivered verbatim', cm.from === 'vtesta' && cm.text === 'أهلا يا صاحبي 👋' && cm.ts > 0, cm.text);

  phase = 'chrome-launch';
  chrome = spawn('google-chrome', ['--headless=new','--disable-gpu','--no-sandbox','--remote-debugging-port=9335',
    '--user-data-dir=/tmp/chrome-prof-' + Date.now(),
    '--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--autoplay-policy=no-user-gesture-required','about:blank'],
    { stdio: ['ignore','ignore', fs.openSync('chrome-test.log','w')] });
  const put = (p) => new Promise((res, rej) => { const req = http.request({ host: '127.0.0.1', port: 9335, path: p, method: 'PUT' }, (r) => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>res(d)); }); req.on('error', rej); req.setTimeout(3000, () => req.destroy(new Error('put timeout'))); req.end(); });
  let target = null;
  for (let i = 0; i < 100 && !target; i++) { await sleep(400); try { const d = await put('/json/new?' + encodeURIComponent('http://127.0.0.1:3462/audiotest.html')); const t2 = JSON.parse(d); if (t2 && t2.webSocketDebuggerUrl) target = t2; } catch (e) {} }
  if (!target) throw new Error('no CDP target after 40s');
  phase = 'cdp-connect';
  const cdp = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
  await Promise.race([new Promise((r, j) => { cdp.on('open', r); cdp.on('error', j); }), sleep(10000).then(() => { throw new Error('cdp open timeout'); })]);
  let id = 0; const pend = {};
  cdp.on('message', raw => { const m = JSON.parse(raw); if (m.id && pend[m.id]) { pend[m.id](m); delete pend[m.id]; } });
  const ev = (expression) => new Promise((res, rej) => { const i = ++id; const to = setTimeout(() => rej(new Error('eval timeout')), 30000); pend[i] = m => { clearTimeout(to); const r = m.result && m.result.result; if (m.result && m.result.exceptionDetails) rej(new Error(JSON.stringify(m.result.exceptionDetails).slice(0, 300))); else res(r && r.value); }; cdp.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } })); });
  phase = 'record-fixture';
  const rec = await ev(`(async()=>{ const s=await navigator.mediaDevices.getUserMedia({audio:true}); const r=new MediaRecorder(s); const ch=[]; r.ondataavailable=e=>ch.push(e.data); r.start(); await new Promise(x=>setTimeout(x,1800)); r.stop(); await new Promise(x=>r.onstop=x); s.getTracks().forEach(t=>t.stop()); const b=new Blob(ch,{type:r.mimeType}); const fr=new FileReader(); const d=await new Promise(x=>{fr.onload=()=>x(fr.result);fr.readAsDataURL(b);}); return {mime:r.mimeType, b64:String(d).split(',')[1], size:b.size}; })()`);
  check('real voice fixture recorded', rec && rec.size > 3000 && rec.b64.length > 4000, rec && (rec.mime + ' ' + rec.size + ' bytes'));
  fs.writeFileSync('voice-fixture.b64.txt', rec.b64);

  phase = 'voice-send-receive';
  A.send({ t: 'voice', to: 'vtestb', data: rec.b64, mime: rec.mime });
  const vm = await B.waitFor(m => m.t === 'voice');
  check('voice note delivered to friend verbatim', vm.from === 'vtesta' && vm.data === rec.b64 && vm.mime === rec.mime, 'b64 len ' + vm.data.length);

  phase = 'decode-check';
  const play = await ev(`(async()=>{ const a=new Audio(); a.src='data:${vm.mime};base64,${vm.data}'; await new Promise((res,rej)=>{a.onloadedmetadata=res; a.onerror=()=>rej(new Error('audio element error')); setTimeout(()=>rej(new Error('metadata timeout')),8000);}); return {duration:a.duration, readyState:a.readyState}; })()`);
  check('received voice note playable (real duration)', play && play.duration > 1.2 && play.duration < 3.5, play && ('duration ' + play.duration.toFixed(2) + 's'));
  const dec = await ev(`(async()=>{ const ctx=new AudioContext(); const buf=Uint8Array.from(atob('${vm.data}'),c=>c.charCodeAt(0)).buffer; const ab=await ctx.decodeAudioData(buf); return {dur:ab.duration, ch:ab.numberOfChannels, sr:ab.sampleRate}; })()`);
  check('received voice note decodes (Web Audio)', dec && dec.dur > 1.2 && dec.ch >= 1, dec && (dec.dur.toFixed(2) + 's ' + dec.ch + 'ch ' + dec.sr + 'Hz'));

  phase = 'offline-info';
  B.ws.close(); await sleep(500);
  A.send({ t: 'voice', to: 'vtestb', data: rec.b64, mime: rec.mime });
  const im = await A.waitFor(m => m.t === 'info' && /مش متصل/.test(m.text));
  check('offline recipient: server says not-online (no silent loss)', /مش متصل/.test(im.text), im.text);

  console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURES');
  clearTimeout(watchdog); cleanup(failures ? 1 : 0);
})().catch(e => { console.log('ERROR at ' + phase + ': ' + e.message); clearTimeout(watchdog); cleanup(1); });
