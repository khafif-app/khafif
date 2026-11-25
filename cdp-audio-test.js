// Drives headless Chrome via CDP: loads audiotest.html, waits for document.title RESULT:...
const { spawn } = require('child_process');
const http = require('http');
const WebSocket = require('ws');

(async () => {
  const chrome = spawn('google-chrome', [
    '--headless=new', '--disable-gpu', '--no-sandbox',
    '--remote-debugging-port=9333',
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    'about:blank',
  ], { stdio: 'ignore' });

  const put = (p) => new Promise((res, rej) => {
    const req = http.request({ host: '127.0.0.1', port: 9333, path: p, method: 'PUT' }, (r) => {
      let d = '';
      r.on('data', (c) => d += c);
      r.on('end', () => res(d));
    });
    req.on('error', rej);
    req.end();
  });

  let target = null;
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 300));
    try {
      const d = await put('/json/new?' + encodeURIComponent('http://127.0.0.1:3457/audiotest.html'));
      target = JSON.parse(d);
      if (target && target.webSocketDebuggerUrl) break;
    } catch (e) {}
  }
  if (!target || !target.webSocketDebuggerUrl) {
    console.log('FAIL: no CDP target');
    chrome.kill();
    process.exit(1);
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
  await new Promise(r => ws.on('open', r));
  let id = 0;
  const evalJs = (expression) => new Promise((res) => {
    const i = ++id;
    const h = (raw) => {
      const m = JSON.parse(raw);
      if (m.id === i) { ws.off('message', h); res(m.result); }
    };
    ws.on('message', h);
    ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
  });

  let result = null;
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 500));
    const r = await evalJs('document.title');
    const t = r && r.result && r.result.value;
    if (t && t.startsWith('RESULT:')) { result = t.slice(7); break; }
  }
  console.log(result ? 'AUDIO_TEST ' + result : 'AUDIO_TEST TIMEOUT');
  ws.close();
  chrome.kill();
  process.exit(0);
})();
