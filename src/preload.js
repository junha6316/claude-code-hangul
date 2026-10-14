// renderer에 window.kct = { on, send }만 노출한다. 약속된 채널 말고는 거절한다.
// sandbox가 켜진 preload는 'electron' 같은 일부 모듈만 require할 수 있어서
// src/shared/contracts.js를 불러오지 못한다. 그래서 같은 목록을 여기 둔다.
// 두 목록이 같은지는 test/smoke.test.js가 확인한다.
const { contextBridge, ipcRenderer } = require('electron');

const MAIN_TO_RENDERER = [
  'pty:data', 'pty:exit', 'log:add', 'perm:show', 'perm:clear',
  'status:update', 'guide:show', 'install:state',
];
const RENDERER_TO_MAIN = [
  'pty:input', 'pty:resize', 'perm:decide', 'guide:action',
  'session:new', 'folder:open', 'install:start',
];

function reject(kind, channel) {
  throw new Error(`허용되지 않은 ${kind} 채널입니다: ${String(channel)}`);
}

const api = {
  // main에서 온 값만 넘기고 IpcRendererEvent는 넘기지 않는다. 돌려주는 함수를 부르면 구독을 끊는다.
  on(channel, cb) {
    if (!MAIN_TO_RENDERER.includes(channel)) reject('받기', channel);
    if (typeof cb !== 'function') throw new TypeError('cb는 함수여야 합니다');
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  send(channel, payload) {
    if (!RENDERER_TO_MAIN.includes(channel)) reject('보내기', channel);
    ipcRenderer.send(channel, payload);
  },
};

contextBridge.exposeInMainWorld('kct', api);
