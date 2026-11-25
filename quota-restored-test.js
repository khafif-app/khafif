const fs = require('fs'); const WebSocket = require('ws');
const SFX = Date.now().toString().slice(-6);
const UA = 'qr' + SFX + 'a', UB = 'qr' + SFX + 'b', PW = 'shotpass123';
function wsClient(name) {
  const ws = new WebSocket('wss://khafif-signal.onrender.com/ws');
  const msgs = []; const waiters = [];
  ws.on('message', d => { const m = JSON.parse(d); msgs.push(m); for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i].p(m)) { waiters[i].res(m); waiters.splice(i, 1); } });
  return { ws, msgs, send: o => ws.send(JSON.stringify(o)), waitFor: (p, ms = 30000) => new Promise((res, rej) => { const f = msgs.find(p); if (f) return res(f); waiters.push({ p, res }); setTimeout(() => rej(new Error(name + ' timeout')), ms); }), open: new Promise((r, j) => { ws.on('open', r); ws.on('error', j); }) };
}
(async () => {
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
  B.send({ t: 'media', to: UA, data: fs.readFileSync('/tmp/shotimg.jpg').toString('base64'), mime: 'image/jpeg' });
  const got = await A.waitFor(m => m.t === 'media');
  const err = B.msgs.find(m => m.t === 'error');
  console.log('MEDIA ACCEPTED, bytes:', got.data.length, '| unexpected error:', err ? err.text : 'none');
  A.ws.close(); B.ws.close();
  process.exit(0);
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
