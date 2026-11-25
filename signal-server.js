// Khafif signaling server: minimal stateless rooms for 1:1 call setup. No accounts, no storage.
const { WebSocketServer } = require('ws');
const http = require('http');
const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => { res.writeHead(200); res.end('khafif-signal ok'); });
const wss = new WebSocketServer({ server, maxPayload: 262144 });
const rooms = new Map(); // code -> Set<ws>

function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function broadcast(room, obj, exclude) {
  const set = rooms.get(room);
  if (!set) return;
  for (const c of set) if (c !== exclude) send(c, obj);
}

wss.on('connection', (ws) => {
  ws.on('message', (buf) => {
    let msg;
    try { msg = JSON.parse(buf); } catch { return; }
    if (msg.t === 'join' && !ws.room) {
      ws.room = String(msg.room || '').slice(0, 32).trim();
      if (!ws.room) return;
      if (!rooms.has(ws.room)) rooms.set(ws.room, new Set());
      const set = rooms.get(ws.room);
      if (set.size >= 2) { send(ws, { t: 'error', text: 'full' }); return; }
      set.add(ws);
      send(ws, { t: 'joined', room: ws.room, peers: set.size });
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

server.listen(PORT, () => console.log('signaling on ' + PORT));
