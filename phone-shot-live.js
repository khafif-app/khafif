const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const WebSocket = require('ws');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let chrome = null;
function cleanup(code) { try { if (chrome) chrome.kill('SIGKILL'); } catch (e) {} process.exit(code); }
setTimeout(() => { console.log('TIMEOUT'); cleanup(1); }, 120000);
process.on('SIGTERM', () => cleanup(1));
(async () => {
  // wake the Render service first
  await new Promise(r => { https = require('https'); const req = https.get('https://khafif-signal.onrender.com/', res => { res.resume(); r(); }); req.on('error', () => r()); req.setTimeout(30000, () => { req.destroy(); r(); }); });
  chrome = spawn('google-chrome-stable', ['--headless=new','--disable-gpu','--no-sandbox','--remote-debugging-port=9341',
    '--user-data-dir=/tmp/chrome-live-' + Date.now(), '--window-size=390,844', '--hide-scrollbars',
    '--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','about:blank'],
    { stdio: ['ignore','ignore', fs.openSync('chrome-live.log','w')] });
  const put = (p) => new Promise((res, rej) => { const req = http.request({ host: '127.0.0.1', port: 9341, path: p, method: 'PUT' }, (r) => { let d=''; r.on('data',cc=>d+=cc); r.on('end',()=>res(d)); }); req.on('error', rej); req.setTimeout(5000, () => req.destroy(new Error('put timeout'))); req.end(); });
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
  await evl(`document.getElementById('username').value='meda34967'; document.getElementById('password').value='mediapass123'; document.querySelectorAll('#onboard button')[0].click(); 'login'`);
  for (let i = 0; i < 4; i++) {
    await sleep(15000);
    const v = await evl(`document.querySelector('.view.active').id`);
    console.log('VIEW', i, v, 'OSTATUS:', await evl(`document.getElementById('ostatus').textContent`));
    if (v === 'home') break;
    await evl(`document.querySelectorAll('#onboard button')[0].click(); 'retry'`);
  }
  await evl(`Array.from(document.querySelectorAll('.row')).find(r=>r.textContent.includes('medb34967')).click(); 'open'`);
  await sleep(6000);
  const state = await evl(`JSON.stringify({view: document.querySelector('.view.active').id, msgs: document.getElementById('msgs').children.length, media: document.getElementById('msgs').querySelectorAll('img,video').length, audio: document.getElementById('msgs').querySelectorAll('audio').length})`);
  console.log('STATE:', state);
  const shot = await cmd('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('/tmp/phone-live.png', Buffer.from(shot.result.data, 'base64'));
  console.log('SHOT SAVED', fs.statSync('/tmp/phone-live.png').size);
  cleanup(0);
})().catch(e => { console.log('ERR', e.message); cleanup(1); });
