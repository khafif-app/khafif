// SIMULATED two-endpoint call test over the LIVE signaling server.
// Chrome --use-fake-device-for-media-stream supplies fake mic tone; this proves
// signaling + WebRTC transport, NOT physical phone/mic behavior.
const { spawn } = require('child_process');
const http = require('http'); const https = require('https'); const fs = require('fs'); const WebSocket = require('ws');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const t0=Date.now(); const log=(...a)=>console.log(((Date.now()-t0)/1000).toFixed(0)+'s',...a);
let chrome = null, server = null;
function cleanup(code) { try { if (chrome) chrome.kill('SIGKILL'); } catch (e) {} try { if (server) server.kill('SIGKILL'); } catch (e) {} process.exit(code); }
setTimeout(() => { log('TIMEOUT'); cleanup(1); }, 240000);
const SFX = Date.now().toString().slice(-6);
const UA = 'va' + SFX + 'a', UB = 'va' + SFX + 'b', PW = 'shotpass123';
function wsClient(name) {
  const ws = new WebSocket('ws://127.0.0.1:3470/ws');
  const msgs = []; const waiters = [];
  ws.on('message', d => { const m = JSON.parse(d); msgs.push(m); for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i].p(m)) { waiters[i].res(m); waiters.splice(i, 1); } });
  return { ws, send: o => ws.send(JSON.stringify(o)), waitFor: (p, ms = 30000) => new Promise((res, rej) => { const f = msgs.find(p); if (f) return res(f); waiters.push({ p, res }); setTimeout(() => rej(new Error(name + ' timeout')), ms); }), open: new Promise((r, j) => { ws.on('open', r); ws.on('error', j); }) };
}
(async () => {
  server = spawn('node', ['server.js'], { env: { ...process.env, PORT: '3470' } });
  await new Promise(r => server.stdout.on('data', d => { if (String(d).includes('listening')) r(); }));
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
  A.ws.close(); B.ws.close(); await sleep(1000);
  log('pair ready', UA, UB);
  chrome = spawn('google-chrome-stable', ['--headless=new','--disable-gpu','--no-sandbox','--remote-debugging-port=9347',
    '--user-data-dir=/tmp/chrome-video-' + Date.now(), '--window-size=390,844',
    '--autoplay-policy=no-user-gesture-required','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--auto-select-desktop-capture-source=Entire screen','about:blank'],
    { stdio: ['ignore','ignore', fs.openSync('chrome-video.log','w')] });
  const put = (p) => new Promise((res, rej) => { const req = http.request({ host: '127.0.0.1', port: 9347, path: p, method: 'PUT' }, (r) => { let d=''; r.on('data',cc=>d+=cc); r.on('end',()=>res(d)); }); req.on('error', rej); req.setTimeout(5000, () => req.destroy(new Error('put timeout'))); req.end(); });
  async function newTab(url) {
    for (let i = 0; i < 90; i++) { await sleep(500); try { const d = await put('/json/new?' + encodeURIComponent(url)); const t2 = JSON.parse(d); if (t2 && t2.webSocketDebuggerUrl) {
      const cdp = new WebSocket(t2.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
      await new Promise(r => cdp.on('open', r));
      let mid = 0; const pend = {};
      cdp.on('message', dd => { const m = JSON.parse(dd); if (m.id && pend[m.id]) { pend[m.id](m); delete pend[m.id]; } });
      const cmd = (method, params) => new Promise(res => { const id = ++mid; pend[id] = res; cdp.send(JSON.stringify({ id, method, params })); });
      const evl = async (expr) => { const r = await cmd('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); const res = r.result || {}; if (res.exceptionDetails) return 'EXC: ' + JSON.stringify(res.exceptionDetails).slice(0, 150); return res.result ? res.result.value : undefined; };
      return { cmd, evl };
    } } catch (e) {} }
    throw new Error('no tab');
  }
  const URLQ = 'http://127.0.0.1:3470/?calls=1';
  const tA = await newTab(URLQ);
  const tB = await newTab('http://127.0.0.1:3470/');
  await sleep(3000);
  async function login(t, u, other) {
    for (let i = 0; i < 25; i++) { const ok = await t.evl(`!!document.getElementById('username')`); if (ok === true) break; await sleep(1000); }
    await t.evl(`document.getElementById('username').value='${u}'; document.getElementById('password').value='${PW}'; document.querySelectorAll('#onboard button')[0].click(); 'login'`);
    for (let i = 0; i < 2; i++) {
      await sleep(5000);
      const v = await t.evl(`document.querySelector('.view.active').id`);
      if (v === 'home') break;
      await t.evl(`document.querySelectorAll('#onboard button')[0].click(); 'retry'`);
    }
    const v = await t.evl(`document.querySelector('.view.active').id`);
    log(u, 'view:', v);
    await t.evl(`Array.from(document.querySelectorAll('.row')).find(r=>r.textContent.includes('${other}')).click(); 'open'`);
    await sleep(2500);
  }
  await login(tA, UA, UB);
  await login(tB, UB, UA);
  // A calls
  await tA.evl(`toggleCall(); 'calling'`);
  // B waits for incoming banner then accepts
  let banner = false;
  for (let i = 0; i < 15 && !banner; i++) { await sleep(1000); banner = await tB.evl(`document.getElementById('incomingCall').style.display === 'flex'`); }
  log('B incoming banner:', banner);
  if (!banner) { log('FAIL no banner'); cleanup(1); }
  log('B pre-accept callBtn hidden:', await tB.evl(`getComputedStyle(document.getElementById('callBtn')).display === 'none'`));
  const acc = await tB.evl(`acceptCall().then(()=>'acc-ok').catch(e=>'acc-err: '+e.message)`);
  log('B post-accept callBtn visible:', await tB.evl(`getComputedStyle(document.getElementById('callBtn')).display !== 'none'`));
  log('accept result:', acc);
  log('B status:', await tB.evl(`document.getElementById('ostatus').textContent`));
  log('B callState:', await tB.evl(`typeof callState !== 'undefined' ? callState : 'undef'`));
  // poll connection state on both
  let stA = '', stB = '';
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    stA = await tA.evl(`typeof pc !== 'undefined' && pc ? pc.connectionState + '/' + pc.iceConnectionState + '/' + pc.iceGatheringState + '/' + pc.signalingState : 'none'`);
    stB = await tB.evl(`typeof pc !== 'undefined' && pc ? pc.connectionState + '/' + pc.iceConnectionState + '/' + pc.iceGatheringState + '/' + pc.signalingState : 'none'`);
    if ((stA + stB).includes('checking')) log('progress', stA, stB);
    if ((stA||'').startsWith('connected') && (stB||'').startsWith('connected')) break;
  }
  log('STATE A:', stA, 'B:', stB);
  // now A shares screen through the app's own toggleShare() -> B's real ontrack recipient path
  log('A sharing screen...');
  const shr = await tA.evl(`toggleShare().then(()=>'share-ok').catch(e=>'share-err: '+e.message)`);
  log('share result:', shr);
  // B: verify actual recipient rendering path (remoteWrap shown, video track live)
  let vinfo = null;
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    vinfo = await tB.evl(`(async () => {
      const w = document.getElementById('remoteWrap'), v = document.getElementById('remoteVideo');
      const so = v.srcObject; const vt = so ? so.getVideoTracks() : [];
      let bytes = null;
      if (pc) { const s = await pc.getStats(); s.forEach(r => { if (r.type === 'inbound-rtp' && r.kind === 'video') bytes = r.bytesReceived; }); }
      return JSON.stringify({ wrap: getComputedStyle(w).display, hasVideoTrack: vt.length, trackState: vt.length ? vt[0].readyState : 'none', videoWidth: v.videoWidth, readyState: v.readyState, videoBytes: bytes });
    })()`);
    try { const o = JSON.parse(vinfo); if (o.wrap !== 'none' && o.hasVideoTrack > 0 && o.videoWidth > 0 && o.videoBytes > 0) break; } catch (e) {}
  }
  log('B recipient video path:', vinfo);
  // audio bytes flowing?
  const stats = await tA.evl(`(async () => {
    if (!pc) return 'no pc';
    const s = await pc.getStats(); let inA = null, outA = null;
    s.forEach(r => { if (r.type === 'inbound-rtp' && r.kind === 'audio') inA = r.bytesReceived; if (r.type === 'outbound-rtp' && r.kind === 'audio') outA = r.bytesSent; });
    return JSON.stringify({ inboundAudioBytes: inA, outboundAudioBytes: outA, remoteAudioSet: !!document.getElementById('remoteAudio').srcObject });
  })()`);
  const statsB = await tB.evl(`(async () => {
    if (!pc) return 'no pc';
    const s = await pc.getStats(); let inA = null;
    s.forEach(r => { if (r.type === 'inbound-rtp' && r.kind === 'audio') inA = r.bytesReceived; });
    return JSON.stringify({ inboundAudioBytes: inA, remoteAudioSet: !!document.getElementById('remoteAudio').srcObject });
  })()`);
  log('STATS A:', stats);
  log('STATS B:', statsB);
  await tA.evl(`endCall(true); 'ended'`);
  await sleep(1500);
  log('B post-end callBtn hidden again:', await tB.evl(`getComputedStyle(document.getElementById('callBtn')).display === 'none'`));
  cleanup(0);
})().catch(e => { log('ERR', e.message); cleanup(1); });
