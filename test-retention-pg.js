// Retention: rows older than 30 days are swept; a pair keeps at most 500 messages.
const { Pool } = require('pg');
const fs = require('fs');
const pool = new Pool({ connectionString: fs.readFileSync('/tmp/neon-dburl.txt', 'utf8').trim(), ssl: { rejectUnauthorized: false } });
let fail = 0;
function ok(name, cond, extra) { if (cond) console.log('PASS', name); else { fail++; console.log('FAIL', name, extra || ''); } }
(async () => {
  if (process.argv[2] !== 'check') {
    const old31 = Date.now() - 31 * 24 * 3600 * 1000;
    await pool.query(`DELETE FROM messages WHERE sender LIKE 'pgt-%'`);
    await pool.query(`INSERT INTO messages (sender, recipient, kind, text, ts) VALUES ('pgt-old', 'pgt-old', 'chat', 'old', $1)`, [old31]);
    await pool.query(`INSERT INTO messages (sender, recipient, kind, text, ts) SELECT 'pgt-cap', 'pgt-cap', 'chat', 'x', $1::bigint + g::bigint FROM generate_series(1, 505) g`, [Date.now() - 1000000]);
    console.log('seeded');
    process.exit(0);
  }
  {
    const oldRows = await pool.query(`SELECT count(*)::int c FROM messages WHERE sender='pgt-old'`);
    ok('30-day-old message swept', oldRows.rows[0].c === 0, JSON.stringify(oldRows.rows));
    const capRows = await pool.query(`SELECT count(*)::int c FROM messages WHERE sender='pgt-cap'`);
    ok('pair capped at 500', capRows.rows[0].c === 500, JSON.stringify(capRows.rows));
    await pool.query(`DELETE FROM messages WHERE sender LIKE 'pgt-%'`);
    console.log(fail === 0 ? 'RETENTION TESTS PASSED' : 'RETENTION FAILURES: ' + fail);
    process.exit(fail ? 1 : 0);
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
