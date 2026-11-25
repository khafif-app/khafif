const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const WebSocket = require('ws');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let server = null, chrome = null;
function cleanup(code) { try { if (chrome) chrome.kill('SIGKILL'); } catch (e) {} try { if (server) server.kill('SIGKILL'); } catch (e) {} process.exit(code); }
setTimeout(() => { console.log('TIMEOUT'); cleanup(1); }, 90000);
process.on('SIGTERM', () => cleanup(1));
function wsClient(name) {
  const ws = new WebSocket('ws://127.0.0.1:3464/ws');
  const msgs = []; const waiters = [];
  ws.on('message', d => { const m = JSON.parse(d); msgs.push(m); for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i].p(m)) { waiters[i].res(m); waiters.splice(i, 1); } });
  return { ws, send: o => ws.send(JSON.stringify(o)), waitFor: (p, ms = 8000) => new Promise((res, rej) => { const f = msgs.find(p); if (f) return res(f); waiters.push({ p, res }); setTimeout(() => rej(new Error(name + ' timeout')), ms); }), open: new Promise(r => ws.on('open', r)) };
}
(async () => {
  server = spawn('node', ['server.js'], { env: { ...process.env, PORT: '3464' } });
  await new Promise(r => server.stdout.on('data', d => { if (String(d).includes('listening')) r(); }));
  const A = wsClient('A'); await A.open;
  A.send({ t: 'register', username: 'tharwat', password: 'shotpass123' });
  await A.waitFor(m => m.t === 'registered');
  const B = wsClient('B'); await B.open;
  B.send({ t: 'register', username: 'karim', password: 'shotpass123' });
  await B.waitFor(m => m.t === 'registered');
  A.send({ t: 'friend_add', username: 'karim' });
  await B.waitFor(m => m.t === 'friend_request');
  B.send({ t: 'friend_accept', username: 'tharwat' });
  await A.waitFor(m => m.t === 'friend_added');
  // populate conversation: text both ways, a voice note, an image
  const pngB64 = fs.readFileSync('/tmp/shotimg.jpg').toString('base64');
  A.ws.close(); B.ws.close(); await sleep(800);
  chrome = spawn('google-chrome-stable', ['--headless=new','--disable-gpu','--no-sandbox','--remote-debugging-port=9339',
    '--user-data-dir=/tmp/chrome-shot-' + Date.now(), '--window-size=390,844', '--hide-scrollbars',
    '--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','about:blank'],
    { stdio: ['ignore','ignore', fs.openSync('chrome-shot.log','w')] });
  const put = (p) => new Promise((res, rej) => { const req = http.request({ host: '127.0.0.1', port: 9339, path: p, method: 'PUT' }, (r) => { let d=''; r.on('data',cc=>d+=cc); r.on('end',()=>res(d)); }); req.on('error', rej); req.setTimeout(3000, () => req.destroy(new Error('put timeout'))); req.end(); });
  let target = null;
  for (let i = 0; i < 60 && !target; i++) { await sleep(400); try { const d = await put('/json/new?' + encodeURIComponent('http://127.0.0.1:3464/')); const t2 = JSON.parse(d); if (t2 && t2.webSocketDebuggerUrl) target = t2; } catch (e) {} }
  if (!target) throw new Error('no CDP target');
  const cdp = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
  await new Promise(r => cdp.on('open', r));
  let mid = 0; const pend = {};
  cdp.on('message', d => { const m = JSON.parse(d); if (m.id && pend[m.id]) { pend[m.id](m); delete pend[m.id]; } });
  const cmd = (method, params) => new Promise(res => { const id = ++mid; pend[id] = res; cdp.send(JSON.stringify({ id, method, params })); });
  const evl = async (expr) => { const r = await cmd('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return r.result && r.result.result && r.result.result.value; };
  await sleep(2000);
  await evl(`document.getElementById('username').value='tharwat'; document.getElementById('password').value='shotpass123'; document.querySelectorAll('#onboard button')[0].click(); 'login'`);
  await sleep(2000);
  await evl(`Array.from(document.querySelectorAll('.row')).find(r=>r.textContent.includes('karim')).click(); 'open'`);
  await sleep(2500);
  // live-populate: karim comes back online and sends; tharwat (page) replies via UI
  const B2 = wsClient('B2'); await B2.open;
  B2.send({ t: 'login', username: 'karim', password: 'shotpass123' });
  await B2.waitFor(m => m.t === 'logged_in');
  B2.send({ t: 'chat', to: 'tharwat', text: 'عامل ايه يا ثروت؟' });
  await sleep(400);
  B2.send({ t: 'voice', to: 'tharwat', data: Buffer.alloc(24000, 3).toString('base64'), mime: 'audio/webm' });
  await sleep(400);
  B2.send({ t: 'media', to: 'tharwat', data: pngB64, mime: 'image/jpeg' });
  await sleep(600);
  await evl(`document.getElementById('text').value='تمام الحمد لله، التطبيق شغال'; sendChat(); 'sent'`);
  await sleep(900);
  const state = await evl(`JSON.stringify({view: document.querySelector('.view.active').id, msgs: document.getElementById('msgs').children.length, media: document.getElementById('msgs').querySelectorAll('img').length, audio: document.getElementById('msgs').querySelectorAll('audio').length})`);
  console.log('STATE:', state);
  const shot = await cmd('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('/tmp/phone-chat.png', Buffer.from(shot.result.data, 'base64'));
  console.log('SHOT SAVED', fs.statSync('/tmp/phone-chat.png').size);
  cleanup(0);
})().catch(e => { console.log('ERR', e.message); cleanup(1); });
