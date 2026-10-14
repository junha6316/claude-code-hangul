// 창 만들기와 IPC 등록(T7).
//
//   const win = createMainWindow({ test });
//   const ipc = registerIpc(win, { 'pty:input': (s) => …, 'perm:decide': ({ id, decision }) => … });
//   ipc.send('pty:data', '…');
//
// 보안: contextIsolation 켬, nodeIntegration 끔, sandbox 켬. renderer는 preload가 노출한 window.kct만 쓴다.
const path = require('path');
const { BrowserWindow, ipcMain, nativeTheme } = require('electron');
const { MAIN_TO_RENDERER, RENDERER_TO_MAIN } = require('../shared/contracts');

const WINDOW_TITLE = '클로드 코드 한글판 (비공식)';
const PRELOAD_PATH = path.join(__dirname, '..', 'preload.js');
const INDEX_PATH = path.join(__dirname, '..', 'renderer', 'index.html');

// renderer가 아직 안 떴을 때 보낸 것을 잠깐 모아 둔다. 너무 많으면 오래된 것부터 버린다.
const MAX_QUEUE = 2000;

const SEND_CHANNELS = new Set(Object.values(MAIN_TO_RENDERER));

function createMainWindow({ test = false } = {}) {
  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 800,
    minHeight: 600,
    useContentSize: true,
    title: WINDOW_TITLE,
    show: false,
    // 시험 모드에서는 화면보다 큰 크기도 허락한다(CI 러너 화면이 작으면 1100×720까지 늘어나지 못한다).
    enableLargerThanScreen: test,
    // 창이 뜰 때 흰 화면이 번쩍이지 않게 OS 밝기 설정에 맞춘 바탕색을 쓴다(styles.css의 --bg와 같은 값).
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1b1c1f' : '#f6f6f3',
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });

  // 창 제목은 늘 같은 이름으로 둔다.
  win.on('page-title-updated', (e) => e.preventDefault());
  // 새 창을 열거나 다른 주소로 넘어가지 않는다(파일을 끌어다 놓아도 화면이 바뀌지 않게).
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  // 시험 모드에서는 포커스를 가져가지 않는다.
  win.once('ready-to-show', () => (test ? win.showInactive() : win.show()));
  win.loadFile(INDEX_PATH);
  return win;
}

function registerIpc(win, handlers = {}) {
  const wc = win.webContents;
  const wcId = wc.id;
  const listeners = [];

  for (const channel of Object.values(RENDERER_TO_MAIN)) {
    const listener = (event, payload) => {
      if (!event.sender || event.sender.id !== wcId) return; // 이 창에서 온 것만 받는다
      const fn = handlers[channel];
      if (typeof fn !== 'function') return;
      try {
        const r = fn(payload);
        if (r && typeof r.catch === 'function') r.catch((e) => console.error(`[ipc] ${channel} 처리 중 오류`, e));
      } catch (e) {
        console.error(`[ipc] ${channel} 처리 중 오류`, e);
      }
    };
    ipcMain.on(channel, listener);
    listeners.push([channel, listener]);
  }
  win.once('closed', () => {
    for (const [channel, listener] of listeners) ipcMain.removeListener(channel, listener);
  });

  // renderer.js는 페이지를 읽을 때 바로 구독하므로, did-finish-load 뒤에 보내면 놓치지 않는다.
  let ready = !wc.isLoading() && wc.getURL() !== '';
  const queue = [];
  wc.on('did-finish-load', () => {
    ready = true;
    while (queue.length) {
      const [channel, payload] = queue.shift();
      if (!wc.isDestroyed()) wc.send(channel, payload);
    }
  });

  function send(channel, payload) {
    if (!SEND_CHANNELS.has(channel)) throw new Error(`허용되지 않은 보내기 채널입니다: ${String(channel)}`);
    if (win.isDestroyed() || wc.isDestroyed()) return false;
    if (!ready) {
      queue.push([channel, payload]);
      if (queue.length > MAX_QUEUE) queue.shift();
      return true;
    }
    wc.send(channel, payload);
    return true;
  }

  return { send };
}

module.exports = {
  createMainWindow,
  registerIpc,
  WINDOW_TITLE,
};
