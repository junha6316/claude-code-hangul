// 앱 진입점(T9). 창을 만들고 app.js의 연결을 붙인다. 앱을 끌 때 claude와 훅 서버를 정리한 뒤 끝낸다.
// 켜질 때 순서와 연결은 app.js에 있다.
const { app, shell } = require('electron');
const { ENV_VARS } = require('../shared/contracts');
const { createMainWindow, registerIpc } = require('./window');
const { createKctApp } = require('./app');

let kct = null;
let win = null;
let quitting = false;
let cleaned = false;

// 두 번 켜면 둘이 같은 설정 파일(kct-settings.json)을 덮어써서, "새 대화"로 다시 띄운 claude가
// 다른 창의 훅 서버로 훅을 보낸다. 하나만 켜 두고, 또 켜면 떠 있는 창을 앞으로 가져온다.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
app.on('second-instance', () => {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

app.whenReady().then(() => {
  if (!gotLock) return undefined;
  let ipc = null;
  kct = createKctApp({
    send: (channel, payload) => { if (ipc) ipc.send(channel, payload); },
    openPath: (dir) => shell.openPath(dir),
    settingsDir: app.getPath('userData'),
  });
  win = createMainWindow({ test: process.env[ENV_VARS.TEST] === '1' });
  ipc = registerIpc(win, kct.handlers);
  return kct.start();
});

app.on('window-all-closed', () => app.quit());

// 끄기 전에 claude(pty)와 훅 서버를 정리한다. 정리가 끝나면 다시 quit을 불러 그대로 끝낸다.
app.on('before-quit', (event) => {
  if (cleaned || !kct) return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  kct.shutdown()
    .catch((err) => console.error('[main] 정리하다가 오류가 났습니다:', err))
    .finally(() => {
      cleaned = true;
      app.quit();
    });
});
