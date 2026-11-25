// Khafif: friend-based lightweight chat. Username identity + add-friend + 1:1 conversations.
// Security model: users/friendships stored in data.json (server operator can read them);
// messages are relay-only, never written to disk; chat/voice NOT end-to-end encrypted;
// WebRTC media encrypted in transit but peer identity is not authenticated.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const DATA = path.join(__dirname, 'data.json');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
};

// Storage: Postgres when DATABASE_URL is set (deployment), local JSON file otherwise (dev/test).
const usePg = !!process.env.DATABASE_URL;
let pool = null;
let db = { users: {} }; // username -> { salt, hash, friends: [], requests: [] }

async function loadDb() {
  if (usePg) {
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    await pool.query('CREATE TABLE IF NOT EXISTS users (username text PRIMARY KEY, salt text, hash text, friends jsonb, requests jsonb)');
    const r = await pool.query('SELECT * FROM users');
    for (const row of r.rows) db.users[row.username] = { salt: row.salt, hash: row.hash, friends: row.friends || [], requests: row.requests || [] };
  } else {
    try { db = JSON.parse(fs.readFileSync(DATA, 'utf8')); } catch (e) {}
  }
}

function save(u) {
  const rec = db.users[u];
  if (!rec) return;
  if (usePg) {
    pool.query(
      'INSERT INTO users (username, salt, hash, friends, requests) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (username) DO UPDATE SET salt=$2, hash=$3, friends=$4, requests=$5',
      [u, rec.salt, rec.hash, JSON.stringify(rec.friends), JSON.stringify(rec.requests)]
    ).catch(() => {});
  } else {
    try { fs.writeFileSync(DATA, JSON.stringify(db)); } catch (e) {}
  }
}

const server = http.createServer((req, res) => {
  let p = req.url === '/' ? '/index.html' : decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(__dirname, 'public', path.normalize(p).replace(/^(\.\.[\/\\])+/, ''));
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, maxPayload: 512 * 1024 });
const online = new Map(); // username -> ws

function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function toUser(name, obj) { const w = online.get(name); if (w) send(w, obj); }
function bind(ws, u) { ws.me = u; online.set(u, ws); }
function sendState(ws) {
  const me = db.users[ws.me];
  if (!me) return;
  send(ws, { t: 'state', friends: me.friends.map(f => ({ name: f, online: online.has(f) })), requests: me.requests });
  for (const f of me.friends) toUser(f, { t: 'presence', user: ws.me, online: true });
}

wss.on('connection', (ws) => {
  ws.rate = { count: 0, reset: Date.now() + 5000 };
  ws.on('message', (buf) => {
    let msg;
    try { msg = JSON.parse(buf); } catch { return; }
    if (msg.t === 'chat' || msg.t === 'voice') {
      const now = Date.now();
      if (now > ws.rate.reset) { ws.rate.count = 0; ws.rate.reset = now + 5000; }
      if (++ws.rate.count > 12) { send(ws, { t: 'error', text: 'رسايل كتير بسرعة، استنى لحظة' }); return; }
    }
    if ((msg.t === 'register' || msg.t === 'login') && !ws.me) {
      const u = String(msg.username || '').trim();
      const p = String(msg.password || '');
      if (!/^[\w\u0600-\u06FF]{3,20}$/.test(u)) { send(ws, { t: 'error', text: 'اسم المستخدم من 3 لـ 20 حرف أو رقم، من غير مسافات' }); return; }
      if (msg.t === 'register') {
        if (p.length < 8) { send(ws, { t: 'error', text: 'الباسورد 8 حروف على الأقل' }); return; }
        if (db.users[u]) { send(ws, { t: 'error', text: 'الاسم ده محجوز. لو ده حسابك، اضغط تسجيل دخول' }); return; }
        const salt = crypto.randomBytes(16).toString('hex');
        const hash = crypto.scryptSync(p, salt, 64).toString('hex');
        db.users[u] = { salt, hash, friends: [], requests: [] };
        save(u);
        bind(ws, u);
        send(ws, { t: 'registered', username: u });
        sendState(ws);
      } else {
        const rec = db.users[u];
        if (!rec) { send(ws, { t: 'error', text: 'مفيش حساب بالاسم ده. لو أول مرة، اضغط إنشاء حساب' }); return; }
        const h = crypto.scryptSync(p, rec.salt, 64);
        if (!crypto.timingSafeEqual(h, Buffer.from(rec.hash, 'hex'))) { send(ws, { t: 'error', text: 'الباسورد غلط' }); return; }
        if (online.has(u)) { send(ws, { t: 'error', text: 'الحساب مفتوح من جهاز تاني دلوقتي' }); return; }
        bind(ws, u);
        send(ws, { t: 'logged_in', username: u });
        sendState(ws);
      }
    } else if (!ws.me) {
      return;
    } else if (msg.t === 'friend_add') {
      const target = String(msg.username || '').trim();
      const me = db.users[ws.me];
      if (target === ws.me) { send(ws, { t: 'error', text: 'مينفعش تضيف نفسك' }); return; }
      const rec = db.users[target];
      if (!rec) { send(ws, { t: 'error', text: 'مفيش مستخدم بالاسم ده' }); return; }
      if (me.friends.includes(target)) { send(ws, { t: 'error', text: 'ده صديقك بالفعل' }); return; }
      if (rec.requests.includes(ws.me)) { send(ws, { t: 'info', text: 'الطلب اتبعت قبل كده، مستني قبوله' }); return; }
      if (me.requests.includes(target)) { // mutual: accept directly
        me.requests = me.requests.filter(x => x !== target);
        me.friends.push(target);
        if (!rec.friends.includes(ws.me)) rec.friends.push(ws.me);
        save(ws.me); save(target);
        send(ws, { t: 'friend_added', user: target });
        toUser(target, { t: 'friend_added', user: ws.me });
        sendState(ws);
        const w2 = online.get(target); if (w2) sendState(w2);
        return;
      }
      rec.requests.push(ws.me);
      save(target);
      toUser(target, { t: 'friend_request', from: ws.me });
      send(ws, { t: 'info', text: 'اتبعت طلب صداقة لـ ' + target });
    } else if (msg.t === 'friend_accept') {
      const target = String(msg.username || '').trim();
      const me = db.users[ws.me], rec = db.users[target];
      if (!me || !rec || !me.requests.includes(target)) return;
      me.requests = me.requests.filter(x => x !== target);
      if (!me.friends.includes(target)) me.friends.push(target);
      if (!rec.friends.includes(ws.me)) rec.friends.push(ws.me);
      save(ws.me); save(target);
      send(ws, { t: 'friend_added', user: target });
      toUser(target, { t: 'friend_added', user: ws.me });
      sendState(ws);
      const w2 = online.get(target); if (w2) sendState(w2);
    } else if (msg.t === 'chat' || msg.t === 'voice') {
      const to = String(msg.to || '');
      const me = db.users[ws.me];
      if (!me || !me.friends.includes(to)) { send(ws, { t: 'error', text: 'لازم تكونوا أصحاب الأول' }); return; }
      const w2 = online.get(to);
      if (!w2) { send(ws, { t: 'info', text: to + ' مش متصل دلوقتي' }); return; }
      if (msg.t === 'chat') send(w2, { t: 'chat', from: ws.me, text: String(msg.text || '').slice(0, 4000), ts: Date.now() });
      else send(w2, { t: 'voice', from: ws.me, data: String(msg.data || '').slice(0, 400000), mime: String(msg.mime || 'audio/webm'), ts: Date.now() });
    } else if (msg.t === 'signal') {
      const to = String(msg.to || '');
      const me = db.users[ws.me];
      if (!me || !me.friends.includes(to)) return;
      const w2 = online.get(to);
      if (w2) send(w2, { t: 'signal', from: ws.me, data: msg.data });
    }
  });
  ws.on('close', () => {
    if (ws.me && online.get(ws.me) === ws) {
      online.delete(ws.me);
      const me = db.users[ws.me];
      if (me) for (const f of me.friends) toUser(f, { t: 'presence', user: ws.me, online: false });
    }
  });
});

loadDb().then(() => {
  server.listen(PORT, () => console.log('listening on ' + PORT + (usePg ? ' (postgres)' : ' (file)')));
}).catch((e) => { console.error('storage init failed', e); process.exit(1); });
