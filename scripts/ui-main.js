// e2e:ui 시험용 main(T11). test/fixtures/ui-main.js(T7)를 그대로 띄우고 두 가지만 더한다.
//   1. KCT_TEST_TERM_KOREAN에 파일 경로를 주면, 화면이 불러오는 src/shared/termKorean.js 대신 그 파일을 준다.
//      시험은 정해진 영어 줄만 바꾸는 가짜 번역 함수를 넣는다. 없는 경로를 주면 파일이 없을 때처럼 실패한다.
//   2. 창이 다른 창에 가려져도 그리기(requestAnimationFrame)를 멈추지 않게 한다. 덮개와 터미널이 프레임마다 그려지므로.
//
//   KCT_TEST_TERM_KOREAN=<가짜 termKorean.js> electron scripts/ui-main.js --user-data-dir=<.test-tmp 아래>
const path = require('path');
const { pathToFileURL, fileURLToPath } = require('url');
const { app, protocol, net } = require('electron');

const TERM_KOREAN = path.resolve(__dirname, '..', 'src', 'shared', 'termKorean.js');
const replacement = process.env.KCT_TEST_TERM_KOREAN;

// test/fixtures/ui-main.js도 whenReady 뒤에 창을 만든다. 이 등록이 먼저라서 창이 읽기 전에 바꿔치기가 걸린다.
app.whenReady().then(() => {
  if (!replacement) return;
  protocol.handle('file', (req) => {
    let file = null;
    try { file = fileURLToPath(req.url); } catch { /* file 주소가 아니면 그대로 넘긴다 */ }
    if (file && path.resolve(file) === TERM_KOREAN) {
      return net.fetch(pathToFileURL(path.resolve(replacement)).href, { bypassCustomProtocolHandlers: true });
    }
    return net.fetch(req, { bypassCustomProtocolHandlers: true });
  });
});

app.on('browser-window-created', (_e, win) => win.webContents.setBackgroundThrottling(false));

require('../test/fixtures/ui-main');
