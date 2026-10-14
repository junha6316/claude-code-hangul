// 설치 파일 시험. electron-builder로 포장한 앱(dist/mac-*/…app)을 Playwright `_electron`으로 띄워
// 포장 뒤에도 터미널(node-pty)·훅 서버·한국어 덮개가 동작하는지 가짜 claude로 한 바퀴 확인한다.
// 먼저 `npm run dist`(또는 `npx electron-builder --mac dir`)로 포장해야 한다. KCT_PACKAGED_APP으로 실행 파일을 직접 줄 수 있다.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { _electron } = require('playwright');

const { createFakeClaudeHome } = require('./helpers/fakeClaudeHome');
const pkg = require('../package.json');

const APP_DIR = path.resolve(__dirname, '..');
const OUT = path.join(APP_DIR, '.test-tmp', 'packaged');
const FAKE_CLAUDE = path.join(__dirname, 'fixtures', 'fake-claude.js');
const HANGUL = /[가-힣]/;

// 이 Mac의 아키텍처에 맞는 포장본. electron-builder는 arm64를 mac-arm64/, x64를 mac/에 둔다.
// 묶음 이름은 build.productName(영어)이다. 한국어 묶음 이름이면 Electron이 뜨자마자 SIGTRAP으로 죽는다.
const BUNDLE = pkg.build.productName;
function packagedExecutable() {
  if (process.env.KCT_PACKAGED_APP) return process.env.KCT_PACKAGED_APP;
  const dir = path.join(APP_DIR, 'dist', process.arch === 'arm64' ? 'mac-arm64' : 'mac');
  return path.join(dir, `${BUNDLE}.app`, 'Contents', 'MacOS', BUNDLE);
}

const EXE = packagedExecutable();
// KCT_PACKAGED_APP을 줬으면(CI) 앱이 없을 때 건너뛰지 않고 실패한다.
const NO_APP = !process.env.KCT_PACKAGED_APP && (process.platform !== 'darwin' || !fs.existsSync(EXE)) && `포장된 앱이 없습니다(${EXE}). 먼저 npm run dist`;

const termText = (page) => page.evaluate(() => [...document.querySelectorAll('#terminal .xterm-rows > div')]
  .map((d) => d.textContent.replace(/ /g, ' ').replace(/\s+$/, '')).join('\n'));

async function waitTerm(page, pred, what) {
  const end = Date.now() + 15000;
  for (;;) {
    const t = await termText(page);
    if (pred(t)) return t;
    if (Date.now() > end) throw new Error(`터미널: ${what}\n${t}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

test('포장된 앱에서도 가짜 claude로 신뢰 확인 → 입력 → 허락 카드 → 허락이 된다', { skip: NO_APP, timeout: 90000 }, async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const { env: home } = createFakeClaudeHome({ dir: path.join(OUT, 'home') });
  const env = { ...home, KCT_TEST: '1', KCT_CLAUDE_PATH: FAKE_CLAUDE, KCT_WORKDIR: path.join(OUT, 'work') };
  delete env.ELECTRON_RUN_AS_NODE;

  const app = await _electron.launch({ executablePath: EXE, args: [`--user-data-dir=${path.join(OUT, 'user-data')}`], env, timeout: 30000 });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => document.documentElement.dataset.ready === '1', null, { timeout: 15000 });

    // 포장본에서 돌고 있고, node-pty는 asar 밖(app.asar.unpacked)에서 불러온다
    const main = await app.evaluate(({ app: a, BrowserWindow }) => ({
      packaged: a.isPackaged,
      resources: process.resourcesPath,
      title: BrowserWindow.getAllWindows()[0].getTitle(),
    }));
    assert.equal(main.packaged, true);
    assert.equal(main.title, pkg.productName);
    assert.ok(fs.existsSync(path.join(main.resources, 'app.asar.unpacked', 'node_modules', 'node-pty', 'prebuilds', `darwin-${process.arch}`, 'spawn-helper')));
    assert.equal(await page.evaluate(() => typeof window.KctTermKorean), 'object', '한국어 덮개 규칙(termKorean.js)을 불러오지 못했습니다');

    // 신뢰 창이 터미널에 보이고 한국어 덮개가 그려진다
    await waitTerm(page, (t) => t.includes('Yes, I trust this folder'), '신뢰 창');
    await page.waitForFunction(() => document.querySelectorAll('#kct-overlay .kct-ko').length > 0, null, { timeout: 5000 });

    // 터미널 입력이 pty로 간다: 2를 누르면 신뢰하고 입력 대기로 넘어간다
    await page.focus('#terminal .xterm-helper-textarea');
    await page.keyboard.press('2');
    await waitTerm(page, (t) => t.includes('가짜 Claude Code') && /^❯/m.test(t), '입력 대기');

    // 요청을 치면 훅 서버를 거쳐 허락 카드가 뜨고, 허락하면 터미널에 FAKE: allow
    await page.keyboard.insertText('메모 파일 하나 만들어 줘');
    await page.keyboard.press('Enter');
    const perm = page.locator('#perm-area .card.perm');
    await perm.waitFor({ state: 'visible', timeout: 10000 });
    assert.match(await perm.locator('h3').textContent(), HANGUL);
    await perm.locator('button', { hasText: '허락' }).click();
    await waitTerm(page, (t) => t.includes('FAKE: allow'), 'FAKE: allow');
    await page.screenshot({ path: path.join(OUT, 'packaged.png') });
  } finally {
    await app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) w.close(); }).catch(() => {});
    await Promise.race([app.close().catch(() => {}), new Promise((r) => setTimeout(r, 10000))]);
  }
});
