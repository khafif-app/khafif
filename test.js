const WebSocket = require('ws');
const url = 'ws://127.0.0.1:3457/ws';
let failures = 0;
function check(name, ok) { console.log((ok ? 'PASS' : 'FAIL') + ' ' + name); if (!ok) failures++; }

const suf = Math.random().toString(36).slice(2, 8);
const UA = 'ta' + suf, UB = 'tb' + suf, US = 'ts' + suf;
const a = new WebSocket(url);
const b = new WebSocket(url);
const s = new WebSocket(url);
let aGotChat = false, bGotChat = false, bGotVoice = false, aGotSignal = false;
let sBlocked = false, aRateLimited = false, bGotRequest = false, aGotFriendAdded = false, bGotFriendAdded = false;
let wrongPassRejected = false, bRegistered = false, aState = false;
let shortPassRejected = false, dupRegisterRejected = false, ghostLoginRejected = false, concurrentRejected = false;

a.on('open', () => a.send(JSON.stringify({ t: 'register', username: UA, password: 'password1' })));
a.on('message', (raw) => {
  const m = JSON.parse(raw);
  if (m.t === 'registered') {
    b.send(JSON.stringify({ t: 'register', username: UB, password: 'password2' }));
    s.send(JSON.stringify({ t: 'register', username: US, password: 'password3' }));
  }
  if (m.t === 'state') aState = true;
  if (m.t === 'friend_added' && m.user === UB) aGotFriendAdded = true;
  if (m.t === 'chat' && m.from === UB) aGotChat = true;
  if (m.t === 'signal' && m.from === UB) aGotSignal = true;
  if (m.t === 'error' && /كتير/.test(m.text)) aRateLimited = true;
});
b.on('message', (raw) => {
  const m = JSON.parse(raw);
  if (m.t === 'registered') {
    bRegistered = true;
    const probes = [
      { t: 'register', username: UB, password: 'password9' },      // duplicate register
      { t: 'register', username: 'tshort' + suf, password: 'short' }, // too short
      { t: 'login', username: 'ghost' + suf, password: 'password0' }, // login nonexistent
      { t: 'login', username: UB, password: 'wrongpass1' },        // wrong password
      { t: 'login', username: UB, password: 'password2' },         // concurrent second session
    ];
    let i = 0;
    const fire = () => {
      if (i >= probes.length) { a.send(JSON.stringify({ t: 'friend_add', username: UB })); return; }
      const c = new WebSocket(url);
      const probe = probes[i++];
      c.on('open', () => c.send(JSON.stringify(probe)));
      c.on('message', (r2) => {
        const m2 = JSON.parse(r2);
        if (m2.t === 'error' && /محجوز/.test(m2.text)) dupRegisterRejected = true;
        if (m2.t === 'error' && /8 حروف/.test(m2.text)) shortPassRejected = true;
        if (m2.t === 'error' && /مفيش حساب/.test(m2.text)) ghostLoginRejected = true;
        if (m2.t === 'error' && /الباسورد غلط/.test(m2.text)) wrongPassRejected = true;
        if (m2.t === 'error' && /جهاز تاني/.test(m2.text)) concurrentRejected = true;
        c.close();
        fire();
      });
    };
    fire();
  }
  if (m.t === 'friend_request' && m.from === UA) {
    bGotRequest = true;
    b.send(JSON.stringify({ t: 'friend_accept', username: UA }));
  }
  if (m.t === 'friend_added' && m.user === UA) {
    bGotFriendAdded = true;
    a.send(JSON.stringify({ t: 'chat', to: UB, text: 'أهلا' }));
    setTimeout(() => {
      b.send(JSON.stringify({ t: 'chat', to: UA, text: 'أهلا أحمد' }));
      b.send(JSON.stringify({ t: 'voice', to: UA, data: 'SGVsbG8', mime: 'audio/webm' }));
      b.send(JSON.stringify({ t: 'signal', to: UA, data: { description: { type: 'offer', sdp: 'x' } } }));
      a.send(JSON.stringify({ t: 'voice', to: UB, data: 'V29ybGQ', mime: 'audio/webm' }));
      s.send(JSON.stringify({ t: 'chat', to: UA, text: 'اختراق' }));
      for (let j = 0; j < 20; j++) a.send(JSON.stringify({ t: 'chat', to: UB, text: 'spam' + j }));
    }, 200);
  }
  if (m.t === 'chat' && m.from === UA) bGotChat = true;
  if (m.t === 'voice' && m.from === UA) bGotVoice = true;
});
s.on('message', (raw) => {
  const m = JSON.parse(raw);
  if (m.t === 'error' && /أصحاب/.test(m.text)) sBlocked = true;
});

setTimeout(() => {
  check('A registered', aState);
  check('B registered', bRegistered);
  check('duplicate register rejected (no typo-takeover)', dupRegisterRejected);
  check('password <8 rejected', shortPassRejected);
  check('login of nonexistent account rejected', ghostLoginRejected);
  check('wrong password rejected', wrongPassRejected);
  check('concurrent second session rejected', concurrentRejected);
  check('B got friend request', bGotRequest);
  check('A notified friend_added', aGotFriendAdded);
  check('B notified friend_added', bGotFriendAdded);
  check('B received A chat', bGotChat);
  check('A received B chat', aGotChat);
  check('B received A voice', bGotVoice);
  check('A received B signal', aGotSignal);
  check('stranger blocked (not friends)', sBlocked);
  check('rate limiter fired', aRateLimited);
  a.close(); b.close(); s.close();
  process.exit(failures ? 1 : 0);
}, 4000);
