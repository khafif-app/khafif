const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const WebSocket = require('ws');
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const chrome = spawn('google-chrome-stable', ['--headless=new','--disable-gpu','--no-sandbox','--remote-debugging-port=9349',
    '--user-data-dir=/tmp/chrome-probe-' + Date.now(), '--window-size=390,844',
    '--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','about:blank'],
    { stdio: ['ignore','ignore', fs.openSync('chrome-probe.log','w')] });
  const put = (p) => new Promise((res, rej) => { const req = http.request({ host: '127.0.0.1', port: 9349, path: p, method: 'PUT' }, (r) => { let d=''; r.on('data',cc=>d+=cc); r.on('end',()=>res(d)); }); req.on('error', rej); req.setTimeout(5000, () => req.destroy(new Error('x'))); req.end(); });
  let cdp = null;
  for (let i = 0; i < 60 && !cdp; i++) { await sleep(500); try { const d = await put('/json/new?' + encodeURIComponent('https://khafif-signal.onrender.com/?calls=1')); const t2 = JSON.parse(d); if (t2.webSocketDebuggerUrl) { cdp = new WebSocket(t2.webSocketDebuggerUrl); await new Promise(r => cdp.on('open', r)); } } catch (e) {} }
  let mid = 0; const pend = {};
  cdp.on('message', dd => { const m = JSON.parse(dd); if (m.id && pend[m.id]) { pend[m.id](m); delete pend[m.id]; } });
  const cmd = (method, params) => new Promise(res => { const id = ++mid; pend[id] = res; cdp.send(JSON.stringify({ id, method, params })); });
  const evl = async (expr) => { const r = await cmd('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return JSON.stringify(r.result).slice(0, 300); };
  await sleep(15000);
  console.log('TITLE:', await evl('document.title'));
  console.log('URL:', await evl('location.href'));
  console.log('HAS USERNAME:', await evl(`!!document.getElementById('username')`));
  console.log('BODY HEAD:', await evl('document.body ? document.body.innerText.slice(0,150) : "no body"'));
  console.log('READYSTATE:', await evl('document.readyState'));
  chrome.kill('SIGKILL'); process.exit(0);
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
