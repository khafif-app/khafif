const WebSocket = require('ws');
const url = 'wss://khafif-signal.onrender.com';
let failures = 0;
function check(name, ok) { console.log((ok ? 'PASS' : 'FAIL') + ' ' + name); if (!ok) failures++; }

const a = new WebSocket(url);
const b = new WebSocket(url);
const c = new WebSocket(url);
let aPeers = 0, bPeers = 0, aGotSignal = false, bGotPeerJoined = false, cFull = false, aGotPeerLeft = false;

let bOpen = false;
b.on('open', () => { bOpen = true; });
a.on('open', () => {
  const t = setInterval(() => { if (bOpen) { clearInterval(t); a.send(JSON.stringify({ t: 'join', room: 'live28173' })); } }, 50);
});
a.on('message', (raw) => {
  const m = JSON.parse(raw);
  if (m.t === 'joined') { aPeers = m.peers; b.send(JSON.stringify({ t: 'join', room: 'live28173' })); }
  if (m.t === 'signal') aGotSignal = true;
  if (m.t === 'peer-left') aGotPeerLeft = true;
});
b.on('message', (raw) => {
  const m = JSON.parse(raw);
  if (m.t === 'joined') {
    bPeers = m.peers;
    c.send(JSON.stringify({ t: 'join', room: 'live28173' }));
    b.send(JSON.stringify({ t: 'signal', data: { description: { type: 'offer', sdp: 'x' } } }));
  }
  if (m.t === 'peer-joined') bGotPeerJoined = true;
});
c.on('message', (raw) => {
  const m = JSON.parse(raw);
  if (m.t === 'error' && m.text === 'full') { cFull = true; b.close(); }
});

setTimeout(() => {
  check('A joined first peers=1', aPeers === 1);
  check('B joined second peers=2', bPeers === 2);
  check('third rejected (room full)', cFull);
  check('signal relayed to A', aGotSignal);
  check('A notified when B left', aGotPeerLeft);
  a.close(); c.close();
  process.exit(failures ? 1 : 0);
}, 4000);
