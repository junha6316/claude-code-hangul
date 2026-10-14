// npm run smoke (= electron scripts/smoke.js)
// 숨긴 Electron 창으로 index.html을 읽어 preload가 붙는지 보고(READY),
// Electron main 프로세스에서 node-pty로 /bin/echo 한글을 띄워 출력을 확인한다(PTY_OK 한글).
const path = require('path');
const { app, BrowserWindow } = require('electron');

const APP_DIR = path.resolve(__dirname, '..');
const TIMEOUT_MS = 50000;
let done = false;

function fail(msg) {
  done = true;
  console.error(`SMOKE_FAIL ${msg}`);
  app.exit(1);
}

const timer = setTimeout(() => fail(`${TIMEOUT_MS}ms 안에 끝나지 않았습니다`), TIMEOUT_MS);

async function checkWindow() {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(APP_DIR, 'src', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  await win.loadFile(path.join(APP_DIR, 'src', 'renderer', 'index.html'));
  const info = await win.webContents.executeJavaScript(`(() => {
    const r = { ready: document.readyState, on: typeof (window.kct && window.kct.on),
                send: typeof (window.kct && window.kct.send), nodeRequire: typeof require };
    try { window.kct.send('not:allowed'); r.reject = 'no-throw'; } catch (e) { r.reject = 'threw'; }
    try { window.kct.on('pty:data', () => {}); r.allow = 'ok'; } catch (e) { r.allow = String(e && e.message); }
    return r;
  })()`);
  win.destroy();
  if (info.on !== 'function' || info.send !== 'function') throw new Error(`window.kct가 없습니다 ${JSON.stringify(info)}`);
  if (info.nodeRequire !== 'undefined') throw new Error(`renderer에서 require가 보입니다 ${JSON.stringify(info)}`);
  if (info.reject !== 'threw' || info.allow !== 'ok') throw new Error(`preload 채널 검사가 틀렸습니다 ${JSON.stringify(info)}`);
  console.log(`READY electron=${process.versions.electron} preload=${JSON.stringify(info)}`);
}

function checkPty() {
  const pty = require('node-pty');
  return new Promise((resolve, reject) => {
    let out = '';
    const p = pty.spawn('/bin/echo', ['한글'], { name: 'xterm-256color', cols: 80, rows: 24, env: process.env });
    p.onData((d) => { out += d; });
    p.onExit(({ exitCode }) => {
      // onExit가 마지막 onData보다 먼저 올 수 있어 잠깐 기다린다.
      setTimeout(() => {
        if (exitCode === 0 && out.includes('한글')) {
          console.log('PTY_OK 한글');
          resolve();
        } else {
          reject(new Error(`pty 출력이 다릅니다 exit=${exitCode} out=${JSON.stringify(out)}`));
        }
      }, 50);
    });
  });
}

if (process.platform === 'darwin' && app.dock) app.dock.hide();
// 창을 닫아도 앱이 저절로 꺼지지 않게 한다(꺼지면 PTY 확인 전에 0으로 끝나 버린다).
app.on('window-all-closed', () => {});
app.on('will-quit', () => {
  if (!done) {
    console.error('SMOKE_FAIL 확인이 끝나기 전에 앱이 꺼졌습니다');
    process.exitCode = 1;
  }
});

app.whenReady()
  .then(checkWindow)
  .then(checkPty)
  .then(() => { done = true; clearTimeout(timer); app.exit(0); })
  .catch((e) => fail(e && e.stack ? e.stack : String(e)));
