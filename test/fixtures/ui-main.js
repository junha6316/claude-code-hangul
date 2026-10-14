// 시험용 main(T7). window.js로 창을 만들고, 시험이 main → renderer 이벤트를 넣고(send)
// renderer → main 이벤트를 받아 볼 수 있게(received) globalThis.kctTest에 둔다.
// Playwright의 electronApp.evaluate()가 main 프로세스에서 globalThis.kctTest를 쓴다.
//
//   electron test/fixtures/ui-main.js
const { app } = require('electron');
const { createMainWindow, registerIpc } = require('../../src/main/window');
const { RENDERER_TO_MAIN } = require('../../src/shared/contracts');

const received = [];

app.whenReady().then(() => {
  const win = createMainWindow({ test: true });
  const handlers = {};
  for (const channel of Object.values(RENDERER_TO_MAIN)) {
    handlers[channel] = (payload) => { received.push({ channel, payload, at: Date.now() }); };
  }
  const ipc = registerIpc(win, handlers);
  globalThis.kctTest = { win, ipc, received };
});

app.on('window-all-closed', () => app.quit());
