const { spawn } = require('child_process');
const http = require('http'); const https = require('https'); const fs = require('fs'); const WebSocket = require('ws');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let chrome = null;
function cleanup(code) { try { if (chrome) chrome.kill('SIGKILL'); } catch (e) {} process.exit(code); }
setTimeout(() => { console.log('TIMEOUT'); cleanup(1); }, 150000);
process.on('SIGTERM', () => cleanup(1));
const SFX = Date.now().toString().slice(-6);
const UA = 'ph' + SFX + 'a', UB = 'ph' + SFX + 'b', PW = 'shotpass123';
function wsClient(name) {
  const ws = new WebSocket('wss://khafif-signal.onrender.com/ws');
  const msgs = []; const waiters = [];
  ws.on('message', d => { const m = JSON.parse(d); msgs.push(m); for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i].p(m)) { waiters[i].res(m); waiters.splice(i, 1); } });
  return { ws, send: o => ws.send(JSON.stringify(o)), waitFor: (p, ms = 25000) => new Promise((res, rej) => { const f = msgs.find(p); if (f) return res(f); waiters.push({ p, res }); setTimeout(() => rej(new Error(name + ' timeout')), ms); }), open: new Promise((r, j) => { ws.on('open', r); ws.on('error', j); }) };
}
(async () => {
  await new Promise(r => { const req = https.get('https://khafif-signal.onrender.com/', res => { res.resume(); r(); }); req.on('error', () => r()); req.setTimeout(40000, () => { req.destroy(); r(); }); });
  const A = wsClient('A'); await A.open;
  A.send({ t: 'register', username: UA, password: PW });
  await A.waitFor(m => m.t === 'registered');
  const B = wsClient('B'); await B.open;
  B.send({ t: 'register', username: UB, password: PW });
  await B.waitFor(m => m.t === 'registered');
  A.send({ t: 'friend_add', username: UB });
  await B.waitFor(m => m.t === 'friend_request');
  B.send({ t: 'friend_accept', username: UA });
  await A.waitFor(m => m.t === 'friend_added');
  A.ws.close(); B.ws.close(); await sleep(1500);
  console.log('users ready', UA, UB);
  chrome = spawn('google-chrome-stable', ['--headless=new','--disable-gpu','--no-sandbox','--remote-debugging-port=9343',
    '--user-data-dir=/tmp/chrome-live2-' + Date.now(), '--window-size=390,844', '--hide-scrollbars',
    '--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','about:blank'],
    { stdio: ['ignore','ignore', fs.openSync('chrome-live2.log','w')] });
  const put = (p) => new Promise((res, rej) => { const req = http.request({ host: '127.0.0.1', port: 9343, path: p, method: 'PUT' }, (r) => { let d=''; r.on('data',cc=>d+=cc); r.on('end',()=>res(d)); }); req.on('error', rej); req.setTimeout(5000, () => req.destroy(new Error('put timeout'))); req.end(); });
  let target = null;
  for (let i = 0; i < 90 && !target; i++) { await sleep(500); try { const d = await put('/json/new?' + encodeURIComponent('https://khafif-signal.onrender.com/')); const t2 = JSON.parse(d); if (t2 && t2.webSocketDebuggerUrl) target = t2; } catch (e) {} }
  if (!target) throw new Error('no CDP target');
  const cdp = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
  await new Promise(r => cdp.on('open', r));
  let mid = 0; const pend = {};
  cdp.on('message', d => { const m = JSON.parse(d); if (m.id && pend[m.id]) { pend[m.id](m); delete pend[m.id]; } });
  const cmd = (method, params) => new Promise(res => { const id = ++mid; pend[id] = res; cdp.send(JSON.stringify({ id, method, params })); });
  const evl = async (expr) => { const r = await cmd('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return r.result && r.result.result && r.result.result.value; };
  await sleep(6000);
  await evl(`document.getElementById('username').value='${UA}'; document.getElementById('password').value='${PW}'; document.querySelectorAll('#onboard button')[0].click(); 'login'`);
  for (let i = 0; i < 4; i++) {
    await sleep(12000);
    const v = await evl(`document.querySelector('.view.active').id`);
    console.log('VIEW', i, v);
    if (v === 'home') break;
    await evl(`document.querySelectorAll('#onboard button')[0].click(); 'retry'`);
  }
  await evl(`Array.from(document.querySelectorAll('.row')).find(r=>r.textContent.includes('${UB}')).click(); 'open'`);
  await sleep(4000);
  const B2 = wsClient('B2'); await B2.open;
  B2.send({ t: 'login', username: UB, password: PW });
  await B2.waitFor(m => m.t === 'logged_in');
  B2.send({ t: 'chat', to: UA, text: 'عامل ايه يا صاحبي؟' });
  await sleep(500);
  B2.send({ t: 'voice', to: UA, data: Buffer.alloc(24000, 3).toString('base64'), mime: 'audio/webm' });
  await sleep(500);
  B2.send({ t: 'media', to: UA, data: fs.readFileSync('/tmp/shotimg.jpg').toString('base64'), mime: 'image/jpeg' });
  await sleep(800);
  await evl(`document.getElementById('text').value='تمام الحمد لله، التطبيق شغال'; sendChat(); 'sent'`);
  await sleep(1500);
  const state = await evl(`JSON.stringify({view: document.querySelector('.view.active').id, msgs: document.getElementById('msgs').children.length, media: document.getElementById('msgs').querySelectorAll('img,video').length, audio: document.getElementById('msgs').querySelectorAll('audio').length})`);
  console.log('STATE:', state);
  const shot = await cmd('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('/tmp/phone-live.png', Buffer.from(shot.result.data, 'base64'));
  console.log('SHOT SAVED', fs.statSync('/tmp/phone-live.png').size);
  B2.ws.close();
  cleanup(0);
})().catch(e => { console.log('ERR', e.message); cleanup(1); });
