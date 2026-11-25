// Khafif merged server (single free service):
// - Chat app: accounts, friend requests, 1:1 text + voice notes, store-and-forward for
//   offline friends, Web Push notifications. WebSocket path: /ws
// - Call signaling: stateless 1:1 rooms for the call/screenshare APK. Any other WS path.
// Security model: accounts/friendships and UNDELIVERED messages are stored on the server
// (Postgres when DATABASE_URL is set, JSON file for accounts only in dev). Stored messages
// are deleted on delivery. NOT end-to-end encrypted: the server operator can read
// relayed/stored content. Push payloads carry only sender name + "new message", never content.
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
// Store-and-forward and push subscriptions need Postgres; file mode stays relay-only.
const usePg = !!process.env.DATABASE_URL;
let pool = null;
let db = { users: {} }; // username -> { salt, hash, friends: [], requests: [] }

// Web Push: active only when VAPID keys are configured (env, never in the repo).
let webpush = null;
if (process.env.VAPID_PUBLIC && process.env.VAPID_PRIVATE) {
  webpush = require('web-push');
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@localhost', process.env.VAPID_PUBLIC, process.env.VAPID_PRIVATE);
}

async function loadDb() {
  if (usePg) {
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    await pool.query('CREATE TABLE IF NOT EXISTS users (username text PRIMARY KEY, salt text, hash text, friends jsonb, requests jsonb)');
    await pool.query('CREATE TABLE IF NOT EXISTS messages (id bigserial PRIMARY KEY, sender text, recipient text, kind text, text text, data text, mime text, ts bigint)');
    await pool.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS delivered_at bigint');
    await pool.query('CREATE TABLE IF NOT EXISTS push_subs (endpoint text PRIMARY KEY, username text, p256dh text, auth text)');
    const r = await pool.query('SELECT * FROM users');
    for (const row of r.rows) db.users[row.username] = { salt: row.salt, hash: row.hash, friends: row.friends || [], requests: row.requests || [] };
  } else {
    try { db = JSON.parse(fs.readFileSync(DATA, 'utf8')); } catch (e) { console.error('pg-error:', e.message); }
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
    try { fs.writeFileSync(DATA, JSON.stringify(db)); } catch (e) { console.error('pg-error:', e.message); }
  }
}

const server = http.createServer((req, res) => {
  let p = req.url === '/' ? '/index.html' : decodeURIComponent(req.url.split('?')[0]);
  if (p === '/vapid-public') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(process.env.VAPID_PUBLIC || ''); return; }
  const file = path.join(__dirname, 'public', path.normalize(p).replace(/^(\.\.[\/\\])+/, ''));
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

const chatWss = new WebSocketServer({ noServer: true, maxPayload: 6 * 1024 * 1024 });
const sigWss = new WebSocketServer({ noServer: true, maxPayload: 262144 });
server.on('upgrade', (req, socket, head) => {
  const p = req.url.split('?')[0];
  if (p === '/ws') chatWss.handleUpgrade(req, socket, head, (ws) => chatWss.emit('connection', ws, req));
  else sigWss.handleUpgrade(req, socket, head, (ws) => sigWss.emit('connection', ws, req));
});

// ---------------- Signaling (call rooms; contract unchanged for the delivered APK) ----------------
const rooms = new Map(); // code -> Set<ws>
function ssend(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function broadcast(room, obj, exclude) {
  const set = rooms.get(room);
  if (!set) return;
  for (const c of set) if (c !== exclude) ssend(c, obj);
}
// Heartbeat: proxies can swallow close frames; ping every 15s and drop peers that miss a pong,
// so the remaining peer gets peer-left within ~30s even when a clean close never arrives.
const sigInterval = setInterval(() => {
  for (const ws of sigWss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 15000);
sigWss.on('close', () => clearInterval(sigInterval));
sigWss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (buf) => {
    let msg;
    try { msg = JSON.parse(buf); } catch { return; }
    if (msg.t === 'join' && !ws.room) {
      ws.room = String(msg.room || '').slice(0, 32).trim();
      if (!ws.room) return;
      if (!rooms.has(ws.room)) rooms.set(ws.room, new Set());
      const set = rooms.get(ws.room);
      if (set.size >= 2) { ssend(ws, { t: 'error', text: 'full' }); return; }
      set.add(ws);
      ssend(ws, { t: 'joined', room: ws.room, peers: set.size });
      broadcast(ws.room, { t: 'peer-joined' }, ws);
    } else if (!ws.room) {
      return;
    } else if (msg.t === 'signal') {
      broadcast(ws.room, { t: 'signal', data: msg.data }, ws);
    }
  });
  ws.on('close', () => {
    if (ws.room && rooms.has(ws.room)) {
      rooms.get(ws.room).delete(ws);
      broadcast(ws.room, { t: 'peer-left' }, null);
      if (rooms.get(ws.room).size === 0) rooms.delete(ws.room);
    }
  });
});

// ---------------- Chat ----------------
const online = new Map(); // username -> ws

function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function toUser(name, obj) { const w = online.get(name); if (w) send(w, obj); }
function bind(ws, u) { ws.me = u; online.set(u, ws); }
async function sendState(ws) {
  const me = db.users[ws.me];
  if (!me) return;
  let unread = {};
  if (usePg) {
    try {
      const r = await pool.query('SELECT sender, count(*)::int AS n FROM messages WHERE recipient=$1 AND delivered_at IS NULL GROUP BY sender', [ws.me]);
      for (const row of r.rows) unread[row.sender] = row.n;
    } catch (e) { console.error('pg-error:', e.message); }
  }
  send(ws, { t: 'state', friends: me.friends.map(f => ({ name: f, online: online.has(f) })), requests: me.requests, unread });
  for (const f of me.friends) toUser(f, { t: 'presence', user: ws.me, online: true });
}

async function pushNotify(to, from) {
  if (!webpush || !usePg) return;
  try {
    const r = await pool.query('SELECT endpoint, p256dh, auth FROM push_subs WHERE username=$1', [to]);
    for (const row of r.rows) {
      const sub = { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } };
      webpush.sendNotification(sub, JSON.stringify({ title: 'خفيف', body: 'رسالة جديدة من ' + from }))
        .catch((e) => {
          if (e.statusCode === 404 || e.statusCode === 410) pool.query('DELETE FROM push_subs WHERE endpoint=$1', [row.endpoint]).catch(() => {});
        });
    }
  } catch (e) { console.error('pg-error:', e.message); }
}

// Chat heartbeat: Render's proxy can swallow close frames, leaving stale "online"
// entries that block re-login. Ping every 15s; terminate clients that miss a pong.
const chatInterval = setInterval(() => {
  for (const ws of chatWss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 15000);
chatWss.on('close', () => clearInterval(chatInterval));

chatWss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.rate = { count: 0, reset: Date.now() + 5000 };
  ws.on('message', async (buf) => {
    let msg;
    try { msg = JSON.parse(buf); } catch { return; }
    if (msg.t === 'chat' || msg.t === 'voice' || msg.t === 'media') {
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
        if (online.has(u)) { send(ws, { t: 'error', code: 'online_elsewhere', text: 'الحساب مفتوح من جهاز تاني دلوقتي' }); return; }
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
    } else if (msg.t === 'chat' || msg.t === 'voice' || msg.t === 'media') {
      const to = String(msg.to || '');
      const me = db.users[ws.me];
      if (!me || !me.friends.includes(to)) { send(ws, { t: 'error', text: 'لازم تكونوا أصحاب الأول' }); return; }
      const MEDIA_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm'];
      if (msg.t === 'media' && !MEDIA_MIMES.includes(msg.mime)) { send(ws, { t: 'error', text: 'نوع الملف ده مش مدعوم' }); return; }
      const w2 = online.get(to);
      const ts = Date.now();
      const text = msg.t === 'chat' ? String(msg.text || '').slice(0, 4000) : null;
      const data = msg.t === 'voice' ? String(msg.data || '').slice(0, 400000)
                 : msg.t === 'media' ? String(msg.data || '').slice(0, 4200000) : null;
      const mime = msg.mime || (msg.t === 'voice' ? 'audio/webm' : null);
      if (usePg) {
        try {
          await pool.query('INSERT INTO messages (sender, recipient, kind, text, data, mime, ts) VALUES ($1,$2,$3,$4,$5,$6,$7)',
            [ws.me, to, msg.t, text, data, mime, ts]);
        } catch (e) { console.error('pg-error:', e.message); }
      }
      if (!w2) {
        if (usePg) {
          send(ws, { t: 'info', text: to + ' مش متصل، هتوصله الرسالة لما يفتح' });
          pushNotify(to, ws.me);
        } else {
          send(ws, { t: 'info', text: to + ' مش متصل دلوقتي' });
        }
        return;
      }
      if (msg.t === 'chat') send(w2, { t: 'chat', from: ws.me, text: text, ts });
      else send(w2, { t: msg.t, from: ws.me, data: data, mime: mime, ts });
    } else if (msg.t === 'open_chat') {
      const u = String(msg.with || '');
      const me = db.users[ws.me];
      if (!me || !me.friends.includes(u) || !usePg) return;
      try {
        // Bounded conversation history: newest 100 messages between the pair, both directions.
        const r = await pool.query(
          'SELECT id, sender, kind, text, data, mime, ts FROM messages WHERE (sender=$1 AND recipient=$2) OR (sender=$2 AND recipient=$1) ORDER BY ts DESC LIMIT 100',
          [ws.me, u]);
        const rows = r.rows.reverse();
        for (const row of rows) {
          if (row.kind === 'chat') send(ws, { t: 'chat', from: row.sender, text: row.text, ts: Number(row.ts) });
          else send(ws, { t: row.kind, from: row.sender, data: row.data, mime: row.mime, ts: Number(row.ts) });
        }
        // Nothing is deleted on delivery. The client acks after rendering; the ack
        // only marks rows seen. A dropped socket therefore cannot discard messages:
        // the next open_chat replays them (the client clears and re-renders on open).
        send(ws, { t: 'backlog_done', with: u, count: rows.length });
      } catch (e) { console.error('pg-error:', e.message); }
    } else if (msg.t === 'backlog_ack') {
      const u = String(msg.with || '');
      if (!usePg || !ws.me) return;
      try {
        await pool.query('UPDATE messages SET delivered_at=$3 WHERE recipient=$1 AND sender=$2 AND delivered_at IS NULL', [ws.me, u, Date.now()]);
        sendState(ws);
      } catch (e) { console.error('pg-error:', e.message); }
    } else if (msg.t === 'push_sub') {
      if (!usePg) return;
      const sub = msg.sub || {};
      const endpoint = String(sub.endpoint || '');
      const keys = sub.keys || {};
      if (!/^https:\/\//.test(endpoint) || endpoint.length > 500 || !keys.p256dh || !keys.auth) return;
      pool.query('INSERT INTO push_subs (endpoint, username, p256dh, auth) VALUES ($1,$2,$3,$4) ON CONFLICT (endpoint) DO UPDATE SET username=$2, p256dh=$3, auth=$4',
        [endpoint, ws.me, String(keys.p256dh), String(keys.auth)]).catch(() => {});
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

// Bounded retention: messages are kept 30 days, and at most 500 per friend pair.
// Beyond that the oldest are deleted. Accounts/friendships have no expiry.
async function runRetention() {
  if (!usePg) return;
  try {
    await pool.query('DELETE FROM messages WHERE ts < $1', [Date.now() - 30 * 24 * 3600 * 1000]);
    await pool.query(`DELETE FROM messages WHERE id IN (
      SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY LEAST(sender, recipient), GREATEST(sender, recipient) ORDER BY ts DESC) AS rn FROM messages) t WHERE t.rn > 500)`);
    await pool.query(`DELETE FROM messages WHERE kind='media' AND id IN (
      SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY LEAST(sender, recipient), GREATEST(sender, recipient) ORDER BY ts DESC) AS rn FROM messages WHERE kind='media') t WHERE t.rn > 50)`);
  } catch (e) { console.error('pg-error:', e.message); }
}
setInterval(runRetention, 6 * 3600 * 1000);

loadDb().then(() => {
  runRetention();
  server.listen(PORT, () => console.log('listening on ' + PORT + (usePg ? ' (postgres)' : ' (file)') + (webpush ? ' (push)' : '')));
});
