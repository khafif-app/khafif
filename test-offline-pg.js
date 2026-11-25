// Offline store-and-forward pipeline against the real Neon DB (live protocol).
const WebSocket = require('ws');
const { Pool } = require('pg');
const fs = require('fs');
const PORT = 3459;
const pool = new Pool({ connectionString: fs.readFileSync('/tmp/neon-dburl.txt', 'utf8').trim(), ssl: { rejectUnauthorized: false } });
const voiceB64 = fs.readFileSync('voice-fixture.b64.txt', 'utf8').trim();
let pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) { pass++; console.log('PASS', name); } else { fail++; console.log('FAIL', name, extra || ''); } }
function conn() { const ws = new WebSocket('ws://127.0.0.1:' + PORT + '/ws'); ws.inbox = []; ws.on('message', (d) => { ws.inbox.push(JSON.parse(d.toString())); }); ws.send2 = (o) => ws.send(JSON.stringify(o)); return ws; }
const wait = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 15000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await wait(60); } return null; }
(async () => {
  await pool.query(`DELETE FROM messages WHERE sender LIKE 'pgt%' OR recipient LIKE 'pgt%'`);
  await pool.query(`DELETE FROM push_subs WHERE username LIKE 'pgt%'`);
  await pool.query(`DELETE FROM users WHERE username LIKE 'pgt%'`);
  const A = conn(), B = conn();
  await until(() => A.readyState === 1 && B.readyState === 1);
  A.send2({ t: 'register', username: 'pgta', password: 'password-one' });
  B.send2({ t: 'register', username: 'pgtb', password: 'password-two' });
  ok('A registered', !!(await until(() => A.inbox.some(m => m.t === 'registered'))), JSON.stringify(A.inbox));
  ok('B registered', !!(await until(() => B.inbox.some(m => m.t === 'registered'))), JSON.stringify(B.inbox));
  B.send2({ t: 'friend_add', username: 'pgta' });
  ok('A got friend_request', !!(await until(() => A.inbox.some(m => m.t === 'friend_request' && m.from === 'pgtb'))), JSON.stringify(A.inbox));
  A.send2({ t: 'friend_accept', username: 'pgtb' });
  ok('both friend_added', !!(await until(() => A.inbox.some(m => m.t === 'friend_added' && m.user === 'pgtb') && B.inbox.some(m => m.t === 'friend_added' && m.user === 'pgta'))));
  const stateA = await until(() => { const st = A.inbox.filter(m => m.t === 'state').pop(); return st && st.friends.some(f => f.name === 'pgtb') ? st : null; });
  ok('A state lists pgtb', !!stateA, JSON.stringify(A.inbox.filter(m=>m.t==='state')));
  B.send2({ t: 'push_sub', sub: { endpoint: 'https://push.example/sub123', keys: { p256dh: 'k1', auth: 'k2' } } });
  let subRow = { rows: [] };
  for (let i = 0; i < 40 && subRow.rows.length !== 1; i++) { await wait(150); subRow = await pool.query(`SELECT endpoint FROM push_subs WHERE username='pgtb'`); }
  ok('push_sub persisted', subRow.rows.length === 1 && subRow.rows[0].endpoint === 'https://push.example/sub123', JSON.stringify(subRow.rows));
  B.close(); await wait(500);
  A.send2({ t: 'chat', to: 'pgtb', text: 'تجربة تخزين' });
  A.send2({ t: 'voice', to: 'pgtb', data: voiceB64, mime: 'audio/webm' });
  ok('A told x2 will-deliver', !!(await until(() => A.inbox.filter(m => m.t === 'info' && /هتوصله/.test(m.text || '')).length >= 2)), JSON.stringify(A.inbox.filter(m=>m.t==='info')));
  const dbCount = await pool.query(`SELECT count(*)::int c FROM messages WHERE sender='pgta' AND recipient='pgtb'`);
  ok('2 messages stored in Neon', dbCount.rows[0].c === 2, JSON.stringify(dbCount.rows));
  const B2 = conn();
  await until(() => B2.readyState === 1);
  B2.send2({ t: 'login', username: 'pgtb', password: 'password-two' });
  ok('B re-login', !!(await until(() => B2.inbox.some(m => m.t === 'logged_in'))), JSON.stringify(B2.inbox));
  const stateB = await until(() => { const st = B2.inbox.filter(m => m.t === 'state').pop(); return st && st.unread && st.unread.pgta === 2 ? st : null; });
  ok('B state unread pgta=2', !!stateB, JSON.stringify(B2.inbox.filter(m=>m.t==='state')));
  B2.send2({ t: 'open_chat', with: 'pgta' });
  const got = await until(() => { const ms = B2.inbox.filter(m => m.t === 'chat' || m.t === 'voice'); return ms.length >= 2 ? ms : null; });
  ok('backlog delivered on open_chat', !!got, JSON.stringify(B2.inbox));
  ok('text verbatim + ordered', !!got && got[0].t === 'chat' && got[0].text === 'تجربة تخزين' && got[0].from === 'pgta');
  ok('voice verbatim', !!got && got[1].t === 'voice' && got[1].data === voiceB64 && got[1].mime === 'audio/webm', got && got[1] ? String(got[1].data||'').length : 'none');
  const stillThere = await pool.query(`SELECT count(*)::int c FROM messages WHERE sender='pgta' AND recipient='pgtb' AND delivered_at IS NULL`);
  ok('rows retained unseen until ack (no silent loss)', stillThere.rows[0].c === 2, JSON.stringify(stillThere.rows));
  ok('backlog_done received', !!(await until(() => B2.inbox.some(m => m.t === 'backlog_done' && m.with === 'pgta'))), JSON.stringify(B2.inbox.filter(m=>m.t==='backlog_done')));
  B2.close(); await wait(400);
  const B3 = conn();
  await until(() => B3.readyState === 1);
  B3.send2({ t: 'login', username: 'pgtb', password: 'password-two' });
  await until(() => B3.inbox.some(m => m.t === 'logged_in'));
  B3.send2({ t: 'open_chat', with: 'pgta' });
  const got3 = await until(() => { const ms = B3.inbox.filter(m => m.t === 'chat' || m.t === 'voice'); return ms.length >= 2 ? ms : null; });
  ok('history replay after reconnect (still unseen)', !!got3 && got3[0].text === 'تجربة تخزين' && got3[1].data === voiceB64);
  B3.send2({ t: 'backlog_ack', with: 'pgta' });
  await wait(700);
  const seenRows = await pool.query(`SELECT count(*)::int c, count(delivered_at)::int d FROM messages WHERE sender='pgta' AND recipient='pgtb'`);
  ok('ack marks seen, rows kept (history retained)', seenRows.rows[0].c === 2 && seenRows.rows[0].d === 2, JSON.stringify(seenRows.rows));
  // sender-side history: A reopens the chat and sees the conversation including own messages
  A.send2({ t: 'open_chat', with: 'pgtb' });
  const gotA = await until(() => { const ms = A.inbox.filter(m => (m.t === 'chat' || m.t === 'voice') && m.from === 'pgta'); return ms.length >= 2 ? ms : null; });
  ok('sender sees own history on open_chat', !!gotA && gotA[0].text === 'تجربة تخزين');
  await pool.query(`DELETE FROM messages WHERE sender LIKE 'pgt%' OR recipient LIKE 'pgt%'`);
  await pool.query(`DELETE FROM push_subs WHERE username LIKE 'pgt%'`);
  await pool.query(`DELETE FROM users WHERE username LIKE 'pgt%'`);
  console.log(fail === 0 ? 'ALL OFFLINE-PG TESTS PASSED (' + pass + ')' : 'FAILURES: ' + fail + ' of ' + (pass + fail));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('ERROR', e); process.exit(1); });
