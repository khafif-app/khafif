const fs = require('fs'); const WebSocket = require('ws');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SFX = Date.now().toString().slice(-6);
const UA = 'qz' + SFX + 'a', UB = 'qz' + SFX + 'b', PW = 'shotpass123';
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
  // 1. text delivery still works under tiny budget
  B.send({ t: 'chat', to: UA, text: 'quota text check' });
  await A.waitFor(m => m.t === 'chat' && m.text === 'quota text check');
  console.log('TEXT OK');
  // 2. media rejected with readable error
  B.send({ t: 'media', to: UA, data: fs.readFileSync('/tmp/shotimg.jpg').toString('base64'), mime: 'image/jpeg' });
  const err = await B.waitFor(m => m.t === 'error');
  console.log('MEDIA REJECT code:', err.code || '(none)', '| text:', err.text);
  // 3. history intact: reopen conversation, expect replay + backlog_done
  A.send({ t: 'open_chat', with: UB });
  const done = await A.waitFor(m => m.t === 'backlog_done');
  const kinds = A.msgs.filter(m => ['chat','voice','media'].includes(m.t)).map(m => m.t);
  console.log('BACKLOG count:', done.count, 'kinds seen:', JSON.stringify(kinds));
  A.ws.close(); B.ws.close();
  process.exit(0);
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
