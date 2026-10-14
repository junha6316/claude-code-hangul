// T7 화면 시험 + T11 영어 줄 덮개 시험. Playwright `_electron`으로 scripts/ui-main.js(test/fixtures/ui-main.js에
// 가짜 번역 함수 바꿔치기를 더한 것)를 띄우고, main → renderer 이벤트를 넣어 화면을 확인하고,
// renderer → main으로 나간 이벤트를 확인한다.
// 화면 캡처는 app/.test-tmp/T7/(화면 배치)과 app/.test-tmp/T11/(덮개)에 남긴다.
// 앱은 .test-tmp/T11/ 아래 별도 userData로 띄운다(사용자가 띄운 앱과 겹치지 않게, 기억한 선택이 남지 않게).
//
//   npm run e2e:ui
const nodeTest = require('node:test');
const { before, after } = nodeTest;
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { _electron } = require('playwright');

const APP_DIR = path.resolve(__dirname, '..');
const OUT = path.join(APP_DIR, '.test-tmp', 'T7');
const OUT_T11 = path.join(APP_DIR, '.test-tmp', 'T11');
const UI_MAIN = path.join(APP_DIR, 'scripts', 'ui-main.js');
const FAKE_TERM_KOREAN = path.join(OUT_T11, 'fake-termKorean.js');

// ── 시험용 가짜 번역 함수(T11) ──
// 정해진 영어 줄(앞뒤 공백과 앞의 ❯·⚠ 표시를 뺀 글)만 한국어로 바꾼다. 커서 줄도 일부러 덮개를 낸다.
// 커서 줄을 빼는 일은 overlay.js가 하는지 보려고.
const FAKE_LINES = {
  'Claude Code v2.1.299': ['header', 'Claude Code 버전 2.1.299'],
  'Opus 5.5 (1M context) with xhigh effort · Claude Team': ['header', '모델 Opus 5.5 · 생각 깊이 아주 깊게 · Team 요금제'],
  'Your login expires in 3 days · run /login to renew': ['banner', '로그인이 3일 뒤에 끝나요 · /login으로 다시 로그인해요'],
  'Accessing workspace:': ['dialog', '이 작업 폴더를 열려고 해요:'],
  'Security guide': ['dialog', '보안 안내'],
  'No, exit': ['option', '아니요, 나갈래요'],
  'Yes, I trust this folder': ['option', '네, 이 폴더를 믿어요'],
  'Enter to confirm · Esc to cancel': ['footer', 'Enter 키로 고르고, Esc 키로 그만둬요'],
  '? for shortcuts': ['hint', '? 키를 누르면 단축키를 보여 줘요'],
};
// 여러 줄을 한 덮개로 덮는 것. 800×600(56칸)에서도 줄이 접히지 않게 영어를 55칸 안으로 나눠 둔다.
const FAKE_BLOCKS = [
  {
    kind: 'dialog',
    en: [
      'Quick safety check: Is this a project you created or',
      'one you trust? (Like your own code, a well-known open',
      'source project, or work from your team). If not, take',
      "a moment to review what's in this folder first.",
    ],
    ko: '안전 확인: 직접 만들었거나 믿을 수 있는 폴더인가요?\n(내 코드, 잘 알려진 공개 프로젝트, 팀의 작업 같은 것)\n아니라면 먼저 이 폴더에 무엇이 있는지 잠깐 살펴보세요.',
  },
  {
    kind: 'dialog',
    en: ["Claude Code'll be able to read, edit, and execute", 'files here.'],
    ko: 'Claude Code가 이 폴더의 파일을 읽고, 고치고,\n실행할 수 있게 돼요.',
  },
];

// 브라우저와 Node 양쪽에서 쓴다(브라우저에는 toString()으로 넣는다). 바깥 이름을 쓰지 않는다.
function fakeTranslate(lines, cols, LINES, BLOCKS) {
  const out = [];
  for (let row = 0; row < lines.length; row++) {
    const line = lines[row];
    let col = line.search(/\S/);
    if (col < 0) continue;
    const block = BLOCKS.find((b) => b.en.every((en, i) => row + i < lines.length && lines[row + i].trim() === en));
    if (block) {
      out.push({ row, col, rows: block.en.length, width: cols - col, text: block.ko, kind: block.kind });
      row += block.en.length - 1;
      continue;
    }
    let body = line.slice(col).trimEnd();
    for (const mark of ['❯ ', '⚠ ']) {
      if (body.startsWith(mark)) { body = body.slice(mark.length); col += mark.length; break; }
    }
    const hit = Object.prototype.hasOwnProperty.call(LINES, body) ? LINES[body] : null;
    if (hit) out.push({ row, col, rows: 1, width: cols - col, text: hit[1], kind: hit[0] });
  }
  return out;
}

function fakeTermKoreanSource() {
  return [
    '// e2e-ui.test.js가 만든 시험용 가짜 번역 함수입니다. scripts/ui-main.js가 src/shared/termKorean.js 대신 줍니다.',
    "'use strict';",
    '(() => {',
    `  const LINES = ${JSON.stringify(FAKE_LINES)};`,
    `  const BLOCKS = ${JSON.stringify(FAKE_BLOCKS)};`,
    `  const fakeTranslate = ${fakeTranslate.toString()};`,
    '  const calls = { count: 0, last: null };',
    '  function translateScreen(lines, { cursorRow, cols }) {',
    '    calls.count += 1;',
    '    calls.last = { cursorRow, cols, lineCount: lines.length };',
    '    return fakeTranslate(lines, cols, LINES, BLOCKS);',
    '  }',
    '  window.KctTermKorean = { translateScreen, RULES: [], calls };',
    '})();',
    '',
  ].join('\n');
}

// 한글·한자 같은 넓은 글자는 2칸으로 센다(시험 자료가 칸 안에 드는지 보는 데만 쓴다).
function displayWidth(s) {
  let w = 0;
  for (const ch of s) w += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1;
  return w;
}

// 어떤 시험도 멈춰 있지 않게 기본 시간 제한을 둔다.
const test = (name, opts, fn) => (typeof opts === 'function'
  ? nodeTest(name, { timeout: 30000 }, opts)
  : nodeTest(name, { timeout: 30000, ...opts }, fn));

let app;
let page;
const pageErrors = [];

// ── 도우미 ──
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const send = (channel, payload) => app.evaluate((_e, [c, p]) => { globalThis.kctTest.ipc.send(c, p); }, [channel, payload]);
const clearReceived = () => app.evaluate(() => { globalThis.kctTest.received.length = 0; });
const received = () => app.evaluate(() => globalThis.kctTest.received.map(({ channel, payload }) => ({ channel, payload })));

async function waitReceived(channel, pred = () => true, ms = 5000) {
  const end = Date.now() + ms;
  let last = [];
  while (Date.now() < end) {
    last = await received();
    const hit = last.find((r) => r.channel === channel && pred(r.payload));
    if (hit) return hit;
    await sleep(50);
  }
  throw new Error(`${channel}이 ${ms}ms 안에 오지 않았습니다. 받은 것: ${JSON.stringify(last)}`);
}

const termText = () => page.evaluate(() => document.querySelector('#terminal .xterm-rows').textContent.replace(/ /g, ' '));
const terminalFocused = () => page.evaluate(() => !!document.activeElement && document.activeElement.classList.contains('xterm-helper-textarea'));
async function waitTerminalFocused() {
  await page.waitForFunction(() => !!document.activeElement && document.activeElement.classList.contains('xterm-helper-textarea'), null, { timeout: 3000 });
  assert.equal(await terminalFocused(), true);
}

async function setSize(width, height) {
  await app.evaluate((_e, [w, h]) => { globalThis.kctTest.win.setContentSize(w, h); }, [width, height]);
  await page.waitForFunction(([w, h]) => window.innerWidth === w && window.innerHeight === h, [width, height], { timeout: 5000 });
  await sleep(300); // ResizeObserver → fit이 끝나기를 기다린다
}

async function setScheme(scheme) {
  await page.emulateMedia({ colorScheme: scheme });
  await sleep(200);
}

// 앱이 그리는 글(버튼·제목·안내 문구)에 영어 단어가 없는지 본다. 시험이 넣은 기록·카드 내용과 터미널은 뺀다.
function chromeTexts() {
  return page.evaluate(() => {
    const visible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };
    const sel = [
      '#topbar .folder-icon', '#topbar .context-label', '#context-text', '#context-hint', '#topbar button',
      '.panel-title', '#log-empty', '.card-label', '.card button', '.card .answered',
      '#install-overlay h1', '#install-overlay .install-desc', '#install-phase', '#btn-install',
    ];
    const out = [];
    for (const s of sel) for (const el of document.querySelectorAll(s)) if (visible(el)) out.push(el.textContent.trim());
    for (const el of document.querySelectorAll('[title],[aria-label]')) {
      if (el.closest('#terminal')) continue;
      for (const a of ['title', 'aria-label']) if (el.getAttribute(a)) out.push(el.getAttribute(a));
    }
    out.push(document.title);
    return out.filter(Boolean);
  });
}

async function layoutReport() {
  return page.evaluate(() => {
    const rect = (q) => {
      const el = document.querySelector(q);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    };
    return {
      vw: window.innerWidth,
      vh: window.innerHeight,
      scrollW: document.documentElement.scrollWidth,
      scrollH: document.documentElement.scrollHeight,
      topbar: rect('#topbar'),
      folder: rect('#topbar .folder'),
      context: rect('#context'),
      btnNew: rect('#btn-new'),
      btnFolder: rect('#btn-folder'),
      terminal: rect('#terminal-wrap'),
      xterm: rect('#terminal .xterm-screen'),
      panel: rect('#panel'),
      perm: rect('#perm-area .card'),
      guide: rect('#guide-area .card'),
      log: rect('#log-area'),
    };
  });
}

function assertLayout(L, label) {
  const inside = (r, name) => {
    assert.ok(r, `${label}: ${name}이 없습니다`);
    assert.ok(r.left >= 0 && r.top >= 0 && r.right <= L.vw + 0.5 && r.bottom <= L.vh + 0.5, `${label}: ${name}이 화면 밖으로 나갑니다 ${JSON.stringify(r)}`);
  };
  assert.ok(L.scrollW <= L.vw && L.scrollH <= L.vh, `${label}: 화면이 넘칩니다 ${JSON.stringify(L)}`);
  for (const k of ['topbar', 'folder', 'context', 'btnNew', 'btnFolder', 'terminal', 'panel', 'perm', 'guide', 'log']) inside(L[k], k);
  // 위 막대 안에서 겹치지 않는다
  assert.ok(L.folder.right <= L.context.left + 0.5, `${label}: 폴더 이름과 대화 길이가 겹칩니다`);
  assert.ok(L.context.right <= L.btnNew.left + 0.5, `${label}: 대화 길이와 버튼이 겹칩니다`);
  assert.ok(L.btnNew.right <= L.btnFolder.left + 0.5, `${label}: 두 버튼이 겹칩니다`);
  for (const k of ['folder', 'context', 'btnNew', 'btnFolder']) {
    assert.ok(L[k].bottom <= L.topbar.bottom + 0.5, `${label}: ${k}이 위 막대 아래로 넘칩니다`);
  }
  // 터미널과 패널이 나란히, 쓸 만한 크기로
  assert.ok(L.terminal.right <= L.panel.left + 0.5, `${label}: 터미널과 패널이 겹칩니다`);
  assert.ok(L.xterm.width >= 400 && L.xterm.height >= 300, `${label}: 터미널이 너무 작습니다 ${JSON.stringify(L.xterm)}`);
  assert.ok(L.panel.width >= 250, `${label}: 패널이 너무 좁습니다`);
  // 허락 카드는 패널 맨 위, 안내 카드와 기록은 그 아래
  assert.ok(L.perm.top < L.guide.top && L.guide.top < L.log.top, `${label}: 패널 순서가 다릅니다`);
}

function assertKorean(texts, label) {
  const bad = texts.filter((t) => /[A-Za-z]{2,}/.test(t));
  assert.deepEqual(bad, [], `${label}: 앱이 그리는 글에 영어가 있습니다`);
  assert.ok(texts.some((t) => /[가-힣]/.test(t)));
}

// ── 띄우기·끄기 ──
// termKorean: 화면이 src/shared/termKorean.js 대신 읽을 파일. userData는 매번 비우고 시작한다.
function launchUi({ userDataName, termKorean }) {
  const userData = path.join(OUT_T11, userDataName);
  fs.rmSync(userData, { recursive: true, force: true });
  const env = { ...process.env, KCT_TEST: '1', KCT_TEST_TERM_KOREAN: termKorean };
  delete env.ELECTRON_RUN_AS_NODE;
  return _electron.launch({
    executablePath: require('electron'),
    args: [UI_MAIN, `--user-data-dir=${userData}`],
    cwd: APP_DIR,
    env,
    timeout: 30000,
  });
}

before(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(OUT_T11, { recursive: true });
  fs.writeFileSync(FAKE_TERM_KOREAN, fakeTermKoreanSource());
  app = await launchUi({ userDataName: 'user-data', termKorean: FAKE_TERM_KOREAN });
  page = await app.firstWindow();
  page.on('pageerror', (e) => pageErrors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(`console: ${m.text()}`); });
  await page.waitForFunction(() => document.documentElement.dataset.ready === '1', null, { timeout: 15000 });
}, { timeout: 60000 });

after(async () => {
  if (!app) return;
  const proc = app.process();
  await Promise.race([app.close().catch(() => {}), sleep(10000)]);
  if (proc && proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
}, { timeout: 30000 });

// ── 시험 ──
test('창 설정이 보안 조건을 지킨다(contextIsolation 켬, nodeIntegration 끔, sandbox 켬, preload만 노출)', async () => {
  const prefs = await app.evaluate(() => {
    const w = globalThis.kctTest.win;
    const p = w.webContents.getLastWebPreferences();
    return {
      contextIsolation: p.contextIsolation,
      nodeIntegration: p.nodeIntegration,
      nodeIntegrationInSubFrames: p.nodeIntegrationInSubFrames,
      nodeIntegrationInWorker: p.nodeIntegrationInWorker,
      sandbox: p.sandbox,
      webSecurity: p.webSecurity,
      webviewTag: p.webviewTag,
      title: w.getTitle(),
    };
  });
  assert.deepEqual(prefs, {
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    nodeIntegrationInWorker: false,
    sandbox: true,
    webSecurity: true,
    webviewTag: false,
    title: '클로드 코드 한글판 (비공식)',
  });
  // preload가 붙었는지는 아래 window.kct로 확인한다(getLastWebPreferences에는 preload 경로가 나오지 않는다).
  const r = await page.evaluate(() => ({
    require: typeof window.require,
    process: typeof window.process,
    kct: Object.keys(window.kct).sort(),
  }));
  assert.deepEqual(r, { require: 'undefined', process: 'undefined', kct: ['on', 'send'] });
});

test('처음 뜰 때 터미널 크기를 pty:resize로 알린다', async () => {
  const hit = await waitReceived('pty:resize');
  assert.ok(Number.isInteger(hit.payload.cols) && hit.payload.cols > 40, JSON.stringify(hit.payload));
  assert.ok(Number.isInteger(hit.payload.rows) && hit.payload.rows > 10, JSON.stringify(hit.payload));
});

test('pty:data로 온 글이 터미널에 보인다', async () => {
  await send('pty:data', '\x1b[1m굵은 글\x1b[0m hello 한글 터미널\r\n');
  await page.waitForFunction(() => document.querySelector('#terminal .xterm-rows').textContent.replace(/ /g, ' ').includes('hello 한글 터미널'), null, { timeout: 5000 });
  assert.match(await termText(), /굵은 글 hello 한글 터미널/);
});

test('터미널의 한글은 두 칸 폭을 거의 채워서 글자 사이가 벌어지지 않는다(한글 글꼴 대체 지정)', async () => {
  const r = await page.evaluate(async () => {
    await document.fonts.load('15px "KCT Hangul"', '가');
    const c = document.createElement('canvas').getContext('2d');
    const rows = getComputedStyle(document.querySelector('#terminal .xterm-rows'));
    const font = `${rows.fontSize} ${rows.fontFamily}`;
    c.font = font;
    return { font, cell: c.measureText('W').width, hangul: c.measureText('가').width,
      loaded: [...document.fonts].some((f) => f.family.replace(/"/g, '') === 'KCT Hangul' && f.status === 'loaded') };
  });
  assert.match(r.font, /KCT Hangul/);
  assert.equal(r.loaded, true, '한글 글꼴(KCT Hangul)이 OS 글꼴을 찾지 못했습니다');
  const fill = r.hangul / (2 * r.cell);
  assert.ok(fill >= 0.85 && fill <= 1.0, `한글 한 자가 두 칸의 ${(fill * 100).toFixed(0)}%를 채웁니다 ${JSON.stringify(r)}`);
});

test('터미널에 keyboard.insertText(한글)을 하면 pty:input으로 한글이 나간다', async () => {
  await clearReceived();
  await page.click('#terminal');
  await waitTerminalFocused();
  await page.keyboard.insertText('한글');
  await waitReceived('pty:input', (p) => p === '한글');
  const inputs = (await received()).filter((r) => r.channel === 'pty:input').map((r) => r.payload);
  assert.equal(inputs.join(''), '한글');
});

test('log:add가 진행 기록에 최근 것부터 보이고 200개까지만 남는다', async () => {
  assert.equal(await page.isVisible('#log-empty'), true);
  await send('log:add', { icon: '📄', text: '회의록 파일을 읽었어요', time: Date.now() });
  await page.waitForSelector('#log li');
  assert.equal(await page.isVisible('#log-empty'), false);
  assert.match(await page.textContent('#log li:first-child'), /📄회의록 파일을 읽었어요/);
  for (let i = 1; i <= 205; i++) await send('log:add', { icon: '•', text: `기록 ${i}`, time: Date.now() });
  await page.waitForFunction(() => document.querySelector('#log li:first-child .text').textContent === '기록 205');
  assert.equal(await page.locator('#log li').count(), 200);
  assert.equal(await page.textContent('#log li:last-child .text'), '기록 6');
  assert.match(await page.textContent('#log li:first-child time'), /\d/);
});

test('perm:show가 한국어 제목과 두 버튼으로 보이고, "허락"을 누르면 perm:decide(allow)가 나가고 포커스가 터미널로 돌아간다', async () => {
  await clearReceived();
  await send('perm:show', { id: 'p1', title: '파일을 만들어도 될까요?', detail: '작업실 폴더에 정리본 파일을 새로 만들어요.', danger: false });
  const card = page.locator('#perm-area .card[data-id="p1"]');
  await card.waitFor({ state: 'visible' });
  assert.equal(await card.locator('h3').textContent(), '파일을 만들어도 될까요?');
  assert.match(await card.locator('h3').textContent(), /[가-힣]/);
  assert.equal(await card.locator('.detail').textContent(), '작업실 폴더에 정리본 파일을 새로 만들어요.');
  assert.deepEqual(await card.locator('button').allTextContents(), ['허락', '거절']);
  // 기록이 200개 쌓여 있어도 허락 카드는 패널 맨 위에서 다 보인다
  const box = await card.boundingBox();
  const panel = await page.locator('#panel').boundingBox();
  const vh = await page.evaluate(() => window.innerHeight);
  assert.ok(box.y >= panel.y && box.y + box.height <= vh, `카드가 다 보이지 않습니다 ${JSON.stringify(box)}`);
  assert.ok(box.y < (await page.locator('#log-area').boundingBox()).y);

  await card.getByRole('button', { name: '허락' }).click();
  const hit = await waitReceived('perm:decide');
  assert.deepEqual(hit.payload, { id: 'p1', decision: 'allow' });
  await waitTerminalFocused();
  assert.equal((await received()).filter((r) => r.channel === 'perm:decide').length, 1);
  await card.waitFor({ state: 'detached', timeout: 5000 }); // 잠깐 "허락했어요"를 보인 뒤 사라진다
});

test('"거절"을 누르면 perm:decide(deny)가 나가고, 위험한 일은 조심 표시로 보인다', async () => {
  await clearReceived();
  await send('perm:show', { id: 'p2', title: '이 명령을 실행해도 될까요?', detail: '폴더 하나를 통째로 지워요.', danger: true });
  const card = page.locator('#perm-area .card[data-id="p2"]');
  await card.waitFor({ state: 'visible' });
  assert.match(await card.getAttribute('class'), /\bdanger\b/);
  assert.match(await card.locator('.card-label').textContent(), /조심/);
  await card.getByRole('button', { name: '거절' }).click();
  const hit = await waitReceived('perm:decide');
  assert.deepEqual(hit.payload, { id: 'p2', decision: 'deny' });
  await waitTerminalFocused();
});

test('perm:clear로 허락 카드가 사라진다(다른 카드는 남는다)', async () => {
  await send('perm:show', { id: 'p3', title: '파일을 고쳐도 될까요?', detail: '', danger: false });
  await send('perm:show', { id: 'p4', title: '웹 페이지를 읽어도 될까요?', detail: '', danger: false });
  await page.locator('#perm-area .card[data-id="p4"]').waitFor({ state: 'visible' });
  await send('perm:clear', { id: 'p3' });
  await page.locator('#perm-area .card[data-id="p3"]').waitFor({ state: 'detached', timeout: 3000 });
  assert.equal(await page.locator('#perm-area .card[data-id="p4"]').isVisible(), true);
  await send('perm:clear', { id: 'p4' });
  await send('perm:clear', { id: '없는-번호' }); // 없는 카드는 조용히 넘어간다
  await page.locator('#perm-area .card').first().waitFor({ state: 'detached', timeout: 3000 });
  assert.equal(await page.locator('#perm-area .card').count(), 0);
});

test('guide:show의 버튼을 누르면 guide:action(keys)이 나가고, null이면 안내가 사라진다', async () => {
  await clearReceived();
  const keys = '\x1b[B\r';
  await send('guide:show', {
    id: 'trust',
    title: '이 폴더를 믿을까요?',
    body: '클로드가 이 폴더의 파일을 읽고 고칠 수 있게 할지 묻고 있어요.',
    actions: [{ label: '믿고 시작하기', keys, primary: true }, { label: '그만두기', keys: '\r' }],
  });
  const card = page.locator('#guide-area .card');
  await card.waitFor({ state: 'visible' });
  assert.equal(await card.locator('h3').textContent(), '이 폴더를 믿을까요?');
  assert.deepEqual(await card.locator('button').allTextContents(), ['믿고 시작하기', '그만두기']);
  assert.match(await card.locator('button', { hasText: '믿고 시작하기' }).getAttribute('class'), /\bprimary\b/);
  await card.getByRole('button', { name: '믿고 시작하기' }).click();
  const hit = await waitReceived('guide:action');
  assert.deepEqual(hit.payload, { keys });
  await waitTerminalFocused();
  // 두 번 눌려 키가 두 번 가지 않게 잠깐 막는다
  assert.equal(await card.getByRole('button', { name: '믿고 시작하기' }).isDisabled(), true);

  await send('guide:show', null);
  await page.locator('#guide-area').waitFor({ state: 'hidden', timeout: 3000 });
  assert.equal(await page.locator('#guide-area .card').count(), 0);
});

test('status:update가 위 막대에 폴더 이름과 대화 길이로 보이고, 80% 이상이면 새 대화를 권한다', async () => {
  await send('status:update', { text: '📁 작업실 · 대화 길이 24%', folderName: '작업실', contextPercent: 24 });
  await page.waitForFunction(() => document.getElementById('context-text').textContent === '24%');
  assert.equal(await page.textContent('#folder-name'), '작업실');
  assert.equal(await page.getAttribute('#context-meter', 'aria-valuenow'), '24');
  assert.equal(await page.isVisible('#context-hint'), false);
  const topbar = await page.textContent('#topbar');
  assert.match(topbar, /작업실/);
  assert.match(topbar, /대화 길이/);
  assert.match(topbar, /24%/);

  await send('status:update', { text: '📁 보고서 · 대화 길이 85% · 새 대화를 권해요', folderName: '보고서', contextPercent: 85 });
  await page.waitForFunction(() => document.getElementById('context-text').textContent === '85%');
  assert.equal(await page.textContent('#folder-name'), '보고서');
  assert.equal(await page.isVisible('#context-hint'), true);
  assert.equal(await page.textContent('#context-hint'), '새 대화를 권해요');

  await send('status:update', { text: '📁 작업실', folderName: '', contextPercent: null }); // 값이 빠져도 깨지지 않는다
  await page.waitForFunction(() => document.getElementById('context-text').textContent === '0%');
  assert.equal(await page.textContent('#folder-name'), '작업실');
  assert.equal(await page.isVisible('#context-hint'), false);
});

test('install:state(installed=false)면 설치 덮개가 보이고 버튼이 install:start를 내며, 설치되면 사라진다', async () => {
  await clearReceived();
  assert.equal(await page.isVisible('#install-overlay'), false);
  await send('install:state', { installed: false, version: null, phase: 'missing', log: '' });
  await page.locator('#install-overlay').waitFor({ state: 'visible' });
  assert.match(await page.textContent('#install-title'), /설치/);
  const btn = page.locator('#btn-install');
  assert.equal(await btn.textContent(), '설치하기');
  assert.equal(await btn.isEnabled(), true);
  assert.equal(await page.isVisible('#install-log'), false);
  await btn.click();
  await waitReceived('install:start');

  await send('install:state', { installed: false, version: null, phase: 'installing', log: ['설치 파일을 받고 있어요…', '거의 다 됐어요…'] });
  await page.waitForFunction(() => document.getElementById('install-log').textContent.includes('거의 다 됐어요'));
  assert.equal(await btn.isDisabled(), true);
  assert.equal(await page.isVisible('#install-log'), true);

  await send('install:state', { installed: false, version: null, phase: 'failed', log: '설치 파일을 받지 못했어요' });
  await page.waitForFunction(() => document.getElementById('btn-install').textContent === '다시 설치하기');
  assert.equal(await btn.isEnabled(), true);
  await clearReceived();
  await btn.click();
  await waitReceived('install:start');

  await send('install:state', { installed: true, version: '2.1.296', phase: 'done', log: '' });
  await page.locator('#install-overlay').waitFor({ state: 'hidden', timeout: 3000 });
});

test('"새 대화"·"폴더 열기"는 session:new·folder:open을 내고 포커스를 터미널로 돌린다', async () => {
  await clearReceived();
  await send('perm:show', { id: 'old', title: '앞 대화의 허락 요청', detail: '', danger: false });
  await page.locator('#perm-area .card[data-id="old"]').waitFor({ state: 'visible' });
  await page.click('#btn-new');
  await waitReceived('session:new');
  await waitTerminalFocused();
  assert.equal(await page.locator('#perm-area .card').count(), 0, '앞 대화의 허락 카드가 남았습니다');
  await page.click('#btn-folder');
  await waitReceived('folder:open');
  await waitTerminalFocused();
});

// ── 화면 캡처(1100×720, 800×600, 어두운 화면, 설치 덮개) ──
const SAMPLE_TERMINAL = [
  '\x1b[2J\x1b[H',
  ' \x1b[38;5;209m▐▛███▜▌\x1b[0m   \x1b[1mClaude Code\x1b[0m v2.1.296',
  '\x1b[38;5;209m▝▜█████▛▘\x1b[0m  \x1b[2m~/Documents/작업실\x1b[0m',
  '',
  '\x1b[2m안녕하세요! 하고 싶은 일을 한국어로 편하게 적어 주세요.\x1b[0m',
  '',
  '\x1b[2m> \x1b[0m회의록 파일을 읽고 할 일만 정리해서 새 파일로 만들어 줘',
  '',
  '\x1b[38;5;114m⏺\x1b[0m \x1b[1mRead\x1b[0m(회의록.md)',
  '  ⎿  Read 42 lines',
  '',
  '\x1b[38;5;209m⏺\x1b[0m \x1b[1mWrite\x1b[0m(할일.md)',
  '',
  '\x1b[38;5;209m✻\x1b[0m 정리하는 중… \x1b[2m(esc to interrupt)\x1b[0m',
  '',
  '\x1b[2m────────────────────────────────────────────────\x1b[0m',
  '❯ ',
  '\x1b[2m────────────────────────────────────────────────\x1b[0m',
  '  📁 작업실 · 대화 길이 24%',
].join('\r\n');

async function fillSampleState() {
  await page.reload();
  await page.waitForFunction(() => document.documentElement.dataset.ready === '1', null, { timeout: 15000 });
  await send('pty:data', SAMPLE_TERMINAL);
  await send('status:update', { text: '📁 작업실 · 대화 길이 24%', folderName: '작업실', contextPercent: 24 });
  const now = Date.now();
  const logs = [
    ['💬', '요청을 받았어요', now - 60000],
    ['📄', '회의록 파일을 읽었어요', now - 40000],
    ['🔍', '"할 일"이 들어간 줄을 찾았어요', now - 20000],
    ['✋', '파일을 만들어도 되는지 묻고 있어요', now],
  ];
  for (const [icon, text, time] of logs) await send('log:add', { icon, text, time });
  await send('perm:show', { id: 'shot', title: '파일을 만들어도 될까요?', detail: '작업실 폴더에 "할일" 파일을 새로 만들어요.', danger: false });
  await send('guide:show', {
    id: 'permission',
    title: '허락을 묻고 있어요',
    body: '오른쪽 위 카드에서 "허락"이나 "거절"을 눌러 주세요.',
    actions: [{ label: '허락하기', keys: '1', primary: true }, { label: '거절하기', keys: '\x1b' }],
  });
  await page.locator('#perm-area .card').waitFor({ state: 'visible' });
  await page.locator('#guide-area .card').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('#terminal .xterm-rows').textContent.includes('정리하는 중'));
}

test('1100×720과 800×600에서 배치가 깨지지 않고, 앱이 그리는 글은 모두 한국어다(캡처를 남긴다)', { timeout: 60000 }, async () => {
  await fillSampleState();
  const shots = [];
  for (const [w, h] of [[1100, 720], [800, 600]]) {
    await setScheme('light');
    await setSize(w, h);
    const L = await layoutReport();
    assertLayout(L, `${w}×${h}`);
    assertKorean(await chromeTexts(), `${w}×${h}`);
    const file = path.join(OUT, `ui-${w}x${h}.png`);
    await page.screenshot({ path: file });
    shots.push(file);
    fs.writeFileSync(path.join(OUT, `ui-${w}x${h}.layout.json`), JSON.stringify(L, null, 2));
  }
  // 창 크기가 바뀌면 터미널 크기도 다시 알린다
  const sizes = (await received()).filter((r) => r.channel === 'pty:resize').map((r) => `${r.payload.cols}x${r.payload.rows}`);
  assert.ok(new Set(sizes).size >= 2, `크기가 바뀌었는데 pty:resize가 한 가지뿐입니다: ${sizes}`);

  // OS가 어두운 화면이면 어둡게 따른다
  await setSize(1100, 720);
  await setScheme('dark');
  const dark = await page.evaluate(() => ({
    body: getComputedStyle(document.body).backgroundColor,
    term: getComputedStyle(document.querySelector('#terminal .xterm-viewport')).backgroundColor,
  }));
  assert.equal(dark.body, 'rgb(27, 28, 31)');
  assert.equal(dark.term, 'rgb(22, 23, 26)');
  const darkFile = path.join(OUT, 'ui-1100x720-dark.png');
  await page.screenshot({ path: darkFile });
  shots.push(darkFile);
  await setScheme('light');
  const light = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  assert.equal(light, 'rgb(246, 246, 243)');

  for (const f of shots) assert.ok(fs.statSync(f).size > 10000, `${f} 캡처가 비었습니다`);
});

test('설치 덮개도 두 크기에서 화면 안에 들어오고 글이 모두 한국어다(캡처를 남긴다)', { timeout: 30000 }, async () => {
  await send('install:state', { installed: false, version: null, phase: 'installing', log: ['설치 파일을 받고 있어요…', '압축을 풀고 있어요…'] });
  await page.locator('#install-overlay').waitFor({ state: 'visible' });
  for (const [w, h] of [[1100, 720], [800, 600]]) {
    await setSize(w, h);
    const r = await page.evaluate(() => {
      const b = document.querySelector('#install-overlay .install-card').getBoundingClientRect();
      const btn = document.getElementById('btn-install').getBoundingClientRect();
      return { card: { left: b.left, right: b.right, top: b.top, bottom: b.bottom }, btn: { top: btn.top, bottom: btn.bottom }, vw: innerWidth, vh: innerHeight };
    });
    assert.ok(r.card.left >= 0 && r.card.right <= r.vw && r.card.top >= 0 && r.card.bottom <= r.vh, `${w}×${h}: 설치 카드가 화면 밖으로 나갑니다 ${JSON.stringify(r)}`);
    assert.ok(r.btn.top >= r.card.top && r.btn.bottom <= r.card.bottom, `${w}×${h}: 설치 버튼이 보이지 않습니다`);
    assertKorean(await chromeTexts(), `설치 덮개 ${w}×${h}`);
    await page.screenshot({ path: path.join(OUT, `install-${w}x${h}.png`) });
  }
  await send('install:state', { installed: true, version: '2.1.296', phase: 'done', log: '' });
  await page.locator('#install-overlay').waitFor({ state: 'hidden', timeout: 3000 });
});

test('창이 좁아지면 터미널 글자를 줄여 한 줄 칸 수를 거의 그대로 지키고, 다시 넓히면 원래 크기로 돌아온다', { timeout: 30000 }, async () => {
  const at = {};
  for (const [w, h] of [[1100, 720], [950, 650], [800, 600], [1100, 720]]) {
    await setSize(w, h);
    const fontSize = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('#terminal .xterm-rows')).fontSize));
    const sizes = (await received()).filter((r) => r.channel === 'pty:resize');
    at[`${w}`] = { fontSize, cols: sizes[sizes.length - 1].payload.cols };
  }
  const report = JSON.stringify(at);
  // 기본 창은 기본 글자 크기 그대로다
  assert.equal(at['1100'].fontSize, 15, report);
  assert.ok(at['1100'].cols >= 78, report);
  // 좁히면 글자가 줄고 칸 수는 거의 그대로다(글자를 안 줄이면 800×600은 약 57칸)
  assert.ok(at['950'].fontSize < 15 && at['950'].fontSize >= 11, report);
  assert.ok(at['800'].fontSize <= at['950'].fontSize && at['800'].fontSize >= 11, report);
  for (const w of ['950', '800']) assert.ok(at[w].cols >= 74, `${w}: 칸 수가 너무 줄었습니다 ${report}`);
});

// ── 영어 줄 덮개(T11) ──
// 덮개 층(#kct-overlay)과 보이는 덮개(.kct-ko), 터미널 줄(.xterm-rows의 줄마다 div)의 위치·글을 한 번에 읽는다.
function overlayState() {
  return page.evaluate(() => {
    const layer = document.getElementById('kct-overlay');
    const s = document.querySelector('#terminal .xterm-screen').getBoundingClientRect();
    const rows = [...document.querySelector('#terminal .xterm-rows').children].map((d) => {
      const r = d.getBoundingClientRect();
      return { top: r.top, height: r.height, text: d.textContent.replace(/ /g, ' ') };
    });
    const ko = [...document.querySelectorAll('#kct-overlay .kct-ko')].filter((e) => e.getClientRects().length > 0).map((e) => {
      const r = e.getBoundingClientRect();
      const cs = getComputedStyle(e);
      return {
        row: Number(e.dataset.row), col: Number(e.dataset.col), rows: Number(e.dataset.rows), width: Number(e.dataset.width),
        kind: e.dataset.kind, text: e.textContent,
        left: r.left, top: r.top, w: r.width, h: r.height,
        scrollW: e.scrollWidth, clientW: e.clientWidth, scrollH: e.scrollHeight, clientH: e.clientHeight,
        bg: cs.backgroundColor, pointerEvents: cs.pointerEvents,
      };
    });
    return {
      hidden: !layer || layer.hidden,
      cols: Number(layer && layer.dataset.cols),
      cursorRow: Number(layer && layer.dataset.cursorRow),
      termBg: getComputedStyle(document.querySelector('#terminal .xterm-viewport')).backgroundColor,
      screen: { left: s.left, top: s.top, width: s.width, height: s.height },
      rows,
      ko,
    };
  });
}

const visibleOverlayCount = () => page.evaluate(() => [...document.querySelectorAll('#kct-overlay .kct-ko')].filter((e) => e.getClientRects().length > 0).length);
const pick = ({ row, col, rows, width, text, kind }) => ({ row, col, rows, width, text, kind });

// 지금 터미널 줄에 가짜 번역 함수를 돌리고, 커서 줄을 뺀 것이 그려져야 할 덮개다.
function expectedOverlays(st) {
  return fakeTranslate(st.rows.map((r) => r.text), st.cols, FAKE_LINES, FAKE_BLOCKS)
    .filter((o) => !(st.cursorRow >= o.row && st.cursorRow < o.row + o.rows))
    .map(pick);
}

function near(a, b, what) {
  assert.ok(Math.abs(a - b) <= 1, `${what}: ${a.toFixed(1)}px이어야 할 곳이 ${b.toFixed(1)}px입니다`);
}

// 덮개가 지금 화면의 영어 줄과 같은 줄·같은 칸에 있는지 본다.
function assertOverlaysFollow(st, label) {
  assert.equal(st.hidden, false, `${label}: 덮개 층이 꺼져 있습니다`);
  const actual = st.ko.map(pick).sort((a, b) => a.row - b.row);
  assert.deepEqual(actual, expectedOverlays(st), `${label}: 덮개가 화면의 영어 줄과 맞지 않습니다`);
  const cw = st.screen.width / st.cols;
  for (const k of st.ko) {
    const first = st.rows[k.row];
    const lastRow = st.rows[k.row + k.rows - 1];
    near(first.top, k.top, `${label}: ${k.row}번 줄 덮개 위쪽`);
    near(lastRow.top + lastRow.height, k.top + k.h, `${label}: ${k.row}번 줄 덮개 아래쪽`);
    near(st.screen.left + k.col * cw, k.left, `${label}: ${k.row}번 줄 덮개 왼쪽`);
    near(k.width * cw, k.w, `${label}: ${k.row}번 줄 덮개 너비`);
  }
}

async function eventually(fn, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      if (Date.now() > end) throw e;
    }
    await sleep(50);
  }
}

// 덮개가 화면을 따라가고, check(새 화면이 그려졌는지 등)도 맞을 때까지 기다린다.
// 쓰기 직후에는 앞 화면과 앞 덮개가 서로 맞는 채로 남아 있을 수 있어서 check로 새 화면인지 함께 본다.
const settledFollow = (label, check = () => {}) => eventually(async () => {
  const st = await overlayState();
  assertOverlaysFollow(st, label);
  check(st);
  return st;
});
const koRows = (st) => st.ko.map((k) => k.row);

// 덮개 시험은 깨끗한 화면에서 시작한다(앞 시험의 카드·크기·밝기를 지운다).
async function freshPage() {
  await setScheme('light');
  await setSize(1100, 720);
  await page.reload();
  await page.waitForFunction(() => document.documentElement.dataset.ready === '1', null, { timeout: 15000 });
}

const CLEAR = '\x1b[2J\x1b[3J\x1b[H';
const TRUST_LINES = ' Accessing workspace:\r\n\r\n Some English line nobody translated\r\n Enter to confirm · Esc to cancel\r\n\r\n';

// pty:data를 보내고 조건이 맞을 때까지 걸린 시간(ms)
async function timeUntil(data, fn, arg) {
  const t0 = Date.now();
  await send('pty:data', data);
  await page.waitForFunction(fn, arg, { timeout: 3000, polling: 'raf' });
  return Date.now() - t0;
}

test('pty:data로 쓴 영어 줄은 300ms 안에 같은 줄 위치에 한국어 덮개로 덮이고, 모르는 줄은 영어 그대로 둔다', async () => {
  await freshPage();
  assert.equal(await page.isVisible('#btn-original'), true);
  assert.equal(await page.textContent('#btn-original'), '영어 원문 보기');
  const ms = await timeUntil(CLEAR + TRUST_LINES, () => document.querySelectorAll('#kct-overlay .kct-ko').length === 2);
  assert.ok(ms < 300, `덮개가 ${ms}ms 뒤에 생겼습니다`);

  const st = await settledFollow('처음', (s) => assert.equal(s.cursorRow, 5));
  assert.deepEqual(st.ko.map((k) => [k.row, k.col, k.kind, k.text]), [
    [0, 1, 'dialog', '이 작업 폴더를 열려고 해요:'],
    [3, 1, 'footer', 'Enter 키로 고르고, Esc 키로 그만둬요'],
  ]);
  assert.match(st.rows[2].text, /Some English line nobody translated/); // 모르는 줄은 덮지 않는다
  assert.equal(st.cursorRow, 5);
  // 덮개는 터미널 배경색으로 칠해 밑의 영어가 비치지 않고, 마우스를 받지 않는다
  for (const k of st.ko) {
    assert.equal(k.bg, st.termBg);
    assert.equal(k.pointerEvents, 'none');
  }
  // 번역 함수는 보이는 줄 전부와 커서 줄·칸 수를 받는다
  const last = await page.evaluate(() => window.KctTermKorean.calls.last);
  assert.deepEqual(last, { cursorRow: 5, cols: st.cols, lineCount: st.rows.length });
});

test('덮인 줄을 지우거나(\\x1b[2K) 다른 글로 바꾸면 300ms 안에 덮개가 사라진다', async () => {
  await send('pty:data', CLEAR + TRUST_LINES);
  await settledFollow('쓴 뒤', (s) => assert.deepEqual(koRows(s), [0, 3]));
  const noRow = (row) => ![...document.querySelectorAll('#kct-overlay .kct-ko')].some((e) => e.dataset.row === row);

  // 0번 줄을 지우고 커서를 원래 자리(5번 줄)로 돌려놓는다. 커서 줄이라서 안 덮이는 것과 섞이지 않게.
  let ms = await timeUntil('\x1b[1;1H\x1b[2K\x1b[6;1H', noRow, '0');
  assert.ok(ms < 300, `지운 줄의 덮개가 ${ms}ms 뒤에 사라졌습니다`);
  await settledFollow('지운 뒤', (s) => assert.deepEqual(koRows(s), [3]));

  ms = await timeUntil('\x1b[4;1H\x1b[2K Enter something else entirely\x1b[6;1H', noRow, '3');
  assert.ok(ms < 300, `바꾼 줄의 덮개가 ${ms}ms 뒤에 사라졌습니다`);
  await settledFollow('다른 글로 바꾼 뒤', (s) => {
    assert.match(s.rows[3].text, /Enter something else entirely/);
    assert.equal(s.ko.length, 0);
  });

  // 아는 다른 문구로 바꾸면 그 번역이 덮인다
  await send('pty:data', '\x1b[4;1H\x1b[2K Security guide\x1b[6;1H');
  await settledFollow('아는 문구로 바꾼 뒤', (s) => assert.deepEqual(s.ko.map((k) => [k.row, k.text]), [[3, '보안 안내']]));
});

test('커서가 있는 줄은 아는 영어 문구여도 덮지 않고, 커서가 떠나면 덮는다', async () => {
  // 커서를 0번 줄 글 끝에 둔다. 가짜 번역 함수는 커서 줄도 덮개를 내므로, 빼는 것은 overlay.js다.
  await send('pty:data', `${CLEAR}\x1b[3;1H Accessing workspace:\x1b[1;1H Enter to confirm · Esc to cancel`);
  await settledFollow('커서가 0번 줄', (s) => {
    assert.equal(s.cursorRow, 0);
    assert.deepEqual(koRows(s), [2]);
  });
  await sleep(300);
  assert.deepEqual((await overlayState()).ko.map((k) => k.row), [2], '커서 줄이 덮였습니다');
  const last = await page.evaluate(() => window.KctTermKorean.calls.last);
  assert.equal(last.cursorRow, 0);

  const ms = await timeUntil('\x1b[6;1H', () => [...document.querySelectorAll('#kct-overlay .kct-ko')].some((e) => e.dataset.row === '0'));
  assert.ok(ms < 300, `커서가 떠난 줄이 ${ms}ms 뒤에 덮였습니다`);
  await settledFollow('커서가 5번 줄', (s) => assert.deepEqual(koRows(s), [0, 2]));
});

test('창 크기를 바꾸거나 화면을 올리고 내려도 덮개가 줄을 따라간다', { timeout: 60000 }, async () => {
  const lines = [];
  for (let i = 1; i <= 120; i++) {
    if (i % 9 === 0) lines.push(' Enter to confirm · Esc to cancel');
    else if (i % 13 === 0) lines.push(' ❯ No, exit');
    else lines.push(`line ${i}: nothing to translate here`);
  }
  await send('pty:data', `${CLEAR}${lines.join('\r\n')}\r\n`);
  const check = (label) => settledFollow(label, (s) => {
    assert.ok(s.rows.some((r) => /line \d+: nothing to translate here/.test(r.text)), `${label}: 새 화면이 아직 안 그려졌습니다`);
    assert.ok(s.ko.length >= 2, `${label}: 덮개가 ${s.ko.length}개뿐입니다`);
  });

  const wide = await check('1100×720');
  await setSize(800, 600);
  const narrow = await check('800×600');
  assert.notEqual(narrow.cols, wide.cols);
  assert.ok(narrow.ko[0].w < wide.ko[0].w, '창을 줄였는데 덮개 너비가 그대로입니다');

  // 마우스 휠로 위로 올린다. 커서 줄(맨 아래)이 화면 밖으로 나가므로 cursorRow는 -1이다.
  const box = await page.locator('#terminal .xterm-screen').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const bottomTop = narrow.rows[0].text;
  await page.mouse.wheel(0, -400);
  await eventually(async () => assert.notEqual((await overlayState()).rows[0].text, bottomTop, '화면이 올라가지 않았습니다'));
  const up = await check('올린 뒤');
  assert.equal(up.cursorRow, -1);
  assert.notDeepEqual(up.ko.map((k) => k.row), narrow.ko.map((k) => k.row), '올렸는데 덮개 줄이 그대로입니다');

  await page.mouse.wheel(0, 4000);
  await eventually(async () => assert.equal((await overlayState()).rows[0].text, bottomTop, '맨 아래로 돌아오지 않았습니다'));
  const down = await check('내린 뒤');
  assert.deepEqual(down.ko.map(pick), narrow.ko.map(pick));

  await setSize(1100, 720);
  await check('다시 1100×720');
});

test('"영어 원문 보기"를 누르면 덮개가 모두 사라지고, 다시 누르면 돌아오며, 고른 것을 기억한다', async () => {
  await send('pty:data', CLEAR + TRUST_LINES);
  await settledFollow('누르기 전', (s) => assert.deepEqual(koRows(s), [0, 3]));
  assert.equal(await visibleOverlayCount(), 2);
  const btn = page.locator('#btn-original');
  assert.equal(await btn.textContent(), '영어 원문 보기');

  await btn.click();
  await page.waitForFunction(() => document.getElementById('kct-overlay').hidden, null, { timeout: 300 });
  assert.equal(await visibleOverlayCount(), 0);
  assert.equal(await btn.textContent(), '한국어로 보기');
  await waitTerminalFocused();
  assert.equal(await page.evaluate(() => localStorage.getItem('kct:overlay')), 'off');
  // 끈 동안 새로 쓴 영어 줄도 덮지 않는다
  await send('pty:data', `${CLEAR} Security guide\r\n Enter to confirm · Esc to cancel\r\n\r\n`);
  await page.waitForFunction(() => document.querySelector('#terminal .xterm-rows').textContent.includes('Security guide'));
  await sleep(300);
  assert.equal(await visibleOverlayCount(), 0);

  // 다시 읽어도(앱을 다시 켠 것과 같다) 끈 채로 시작한다
  await page.reload();
  await page.waitForFunction(() => document.documentElement.dataset.ready === '1', null, { timeout: 15000 });
  await send('pty:data', CLEAR + TRUST_LINES);
  await page.waitForFunction(() => document.querySelector('#terminal .xterm-rows').textContent.includes('Accessing workspace'));
  await sleep(300);
  assert.equal(await visibleOverlayCount(), 0);
  assert.equal(await btn.textContent(), '한국어로 보기');

  const t0 = Date.now();
  await btn.click();
  await page.waitForFunction(() => document.querySelectorAll('#kct-overlay:not([hidden]) .kct-ko').length === 2, null, { timeout: 3000 });
  assert.ok(Date.now() - t0 < 1000);
  await settledFollow('다시 켠 뒤', (s) => assert.deepEqual(koRows(s), [0, 3]));
  assert.equal(await btn.textContent(), '영어 원문 보기');
  assert.equal(await page.evaluate(() => localStorage.getItem('kct:overlay')), 'on');
  await waitTerminalFocused();
});

test('덮개 자리를 클릭하면 터미널에 포커스가 가고, 덮개가 있어도 insertText(한글)이 pty:input으로 간다', async () => {
  await send('pty:data', CLEAR + TRUST_LINES);
  await send('pty:data', `${CLEAR} Security guide\r\n`);
  await settledFollow('다른 화면', (s) => assert.deepEqual(koRows(s), [0]));
  await send('pty:data', CLEAR + TRUST_LINES);
  const st = await settledFollow('클릭 전', (s) => assert.deepEqual(koRows(s), [0, 3]));
  await page.evaluate(() => { if (document.activeElement) document.activeElement.blur(); });
  assert.equal(await terminalFocused(), false);

  const k = st.ko.find((o) => o.row === 0);
  const x = k.left + 40;
  const y = k.top + k.h / 2;
  // 그 자리에서 마우스를 받는 것은 덮개가 아니라 터미널이다
  const hit = await page.evaluate(([px, py]) => {
    const el = document.elementFromPoint(px, py);
    return { inOverlay: !!el.closest('#kct-overlay'), inTerminal: !!el.closest('#terminal .xterm-screen') };
  }, [x, y]);
  assert.deepEqual(hit, { inOverlay: false, inTerminal: true });

  await page.mouse.click(x, y);
  await waitTerminalFocused();
  await clearReceived();
  await page.keyboard.insertText('한글');
  await waitReceived('pty:input', (p) => p === '한글');
  const inputs = (await received()).filter((r) => r.channel === 'pty:input').map((r) => r.payload);
  assert.equal(inputs.join(''), '한글');
  assert.equal(await visibleOverlayCount(), 2, '클릭한 뒤 덮개가 사라졌습니다');
});

test('alternate 버퍼(\\x1b[?1049h)에서도 덮개가 그려지고, 돌아오면 원래 화면의 줄을 따라간다', async () => {
  await send('pty:data', `${CLEAR}plain line A\r\n Enter to confirm · Esc to cancel\r\n\r\n`);
  await settledFollow('보통 화면', (s) => assert.deepEqual(koRows(s), [1]));

  await send('pty:data', '\x1b[?1049h\x1b[2J\x1b[H Security guide\r\n\r\n ❯ No, exit\r\n   Yes, I trust this folder\r\n\r\n');
  const st = await settledFollow('alternate 버퍼', (s) => assert.deepEqual(koRows(s), [0, 2, 3]));
  assert.deepEqual(st.ko.map((k) => [k.row, k.col, k.text]), [
    [0, 1, '보안 안내'],
    [2, 3, '아니요, 나갈래요'],
    [3, 3, '네, 이 폴더를 믿어요'],
  ]);
  assert.match(st.rows[2].text, /^ ❯ No, exit/); // 고르기 표시 ❯는 덮지 않는다(덮개는 3번 칸부터)

  await send('pty:data', '\x1b[?1049l');
  await settledFollow('보통 화면으로 돌아온 뒤', (s) => {
    assert.match(s.rows[0].text, /plain line A/);
    assert.deepEqual(koRows(s), [1]);
  });
});

test('2,000줄을 한 번에 써도 덮개를 켠 때의 처리 시간이 끈 때의 1.3배 이하다', { timeout: 120000 }, async () => {
  let n = 0;
  // 2,000줄을 쓰고, 마지막 줄이 화면에 그려지고 두 프레임(덮개 그리기 포함)이 지날 때까지의 시간
  async function writeOnce() {
    n += 1;
    const marker = `끝-${n}-끝`;
    const lines = [];
    for (let i = 0; i < 2000; i++) {
      lines.push(i % 25 === 0 ? ' Enter to confirm · Esc to cancel' : `${String(i).padStart(4, '0')} The quick brown fox jumps over the lazy dog ${'-'.repeat(30)}`);
    }
    const data = `${lines.join('\r\n')}\r\n Enter to confirm · Esc to cancel\r\n${marker}\r\n`;
    const t0 = performance.now();
    await send('pty:data', data);
    await page.waitForFunction((m) => document.querySelector('#terminal .xterm-rows').textContent.includes(m), marker, { polling: 'raf', timeout: 10000 });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    return performance.now() - t0;
  }
  const isOn = () => page.evaluate(() => !document.getElementById('kct-overlay').hidden);
  assert.equal(await isOn(), true);
  await writeOnce();
  await writeOnce(); // 데우기

  const times = { on: [], off: [] };
  for (let i = 0; i < 10; i++) {
    const on = await isOn();
    const ms = await writeOnce();
    times[on ? 'on' : 'off'].push(ms);
    if (on) assert.ok(await visibleOverlayCount() >= 1, '덮개를 켰는데 마지막 화면에 덮개가 없습니다');
    else assert.equal(await visibleOverlayCount(), 0);
    await page.click('#btn-original'); // 켜고 끄기를 번갈아 한다
  }
  assert.equal(await isOn(), true);
  const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const on = median(times.on);
  const off = median(times.off);
  const ratio = on / off;
  fs.writeFileSync(path.join(OUT_T11, 'perf.json'), JSON.stringify({ lines: 2000, medianOnMs: on, medianOffMs: off, ratio, times }, null, 2));
  assert.ok(ratio <= 1.3, `켠 때 ${on.toFixed(1)}ms, 끈 때 ${off.toFixed(1)}ms로 ${ratio.toFixed(2)}배입니다`);
});

// 캡처용 화면. 사용자 화면(test/fixtures/term/user/)의 머리말·신뢰 창 문구를 56칸 안에 들게 나눴다.
const OVERLAY_SAMPLE_LINES = [
  ' \x1b[1mClaude Code\x1b[0m v2.1.299',
  '  \x1b[2mOpus 5.5 (1M context) with xhigh effort · Claude Team\x1b[0m',
  '',
  '\x1b[33m⚠ Your login expires in 3 days · run /login to renew\x1b[0m',
  '',
  ' \x1b[1mAccessing workspace:\x1b[0m',
  ' /Users/tester/Documents/작업실',
  '',
  ...FAKE_BLOCKS[0].en.map((l) => ` ${l}`),
  '',
  ...FAKE_BLOCKS[1].en.map((l) => ` ${l}`),
  ' \x1b[4mSecurity guide\x1b[0m',
  '',
  ' \x1b[38;5;69m❯ No, exit\x1b[0m',
  '   Yes, I trust this folder',
  '',
  ' \x1b[2mEnter to confirm · Esc to cancel\x1b[0m',
];

test('덮개 화면 캡처: 1100×720·800×600 밝은 화면과 1100×720 어두운 화면에서 영어가 비치지 않고 글이 칸을 넘치지 않는다', { timeout: 90000 }, async () => {
  // eslint-disable-next-line no-control-regex
  const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
  for (const l of OVERLAY_SAMPLE_LINES) assert.ok(displayWidth(plain(l)) <= 55, `캡처용 줄이 56칸에서 접힙니다: ${plain(l)}`);
  const sample = CLEAR + OVERLAY_SAMPLE_LINES.join('\r\n') + '\r\n';

  for (const [w, h, scheme] of [[1100, 720, 'light'], [800, 600, 'light'], [1100, 720, 'dark']]) {
    const label = `${w}×${h}${scheme === 'dark' ? ' 어두운 화면' : ''}`;
    const name = `${w}x${h}${scheme === 'dark' ? '-dark' : ''}`;
    await setScheme(scheme);
    await setSize(w, h);
    await send('pty:data', sample);
    const st = await eventually(async () => {
      const s = await overlayState();
      assertOverlaysFollow(s, label);
      assert.equal(s.ko.length, 10, `${label}: 덮개가 ${s.ko.length}개입니다`);
      return s;
    });
    for (const k of st.ko) {
      assert.equal(k.bg, st.termBg, `${label}: "${k.text}" 덮개 배경이 터미널 배경과 다릅니다`);
      assert.match(k.bg, /^rgb\(/, `${label}: 덮개 배경이 비칩니다(${k.bg})`);
      assert.ok(k.scrollW <= k.clientW + 1 && k.scrollH <= k.clientH + 1, `${label}: "${k.text}" 글이 덮개 칸을 넘칩니다 ${JSON.stringify(k)}`);
      for (const line of k.text.split('\n')) assert.ok(displayWidth(line) <= k.width, `${label}: "${line}"이 ${k.width}칸보다 깁니다`);
    }
    if (scheme === 'dark') assert.equal(st.termBg, 'rgb(22, 23, 26)');
    fs.writeFileSync(path.join(OUT_T11, `overlay-${name}.json`), JSON.stringify(st, null, 2));
    await page.screenshot({ path: path.join(OUT_T11, `overlay-${name}.png`) });

    // 비교용: 같은 화면의 영어 원문
    await page.click('#btn-original');
    await page.waitForFunction(() => document.getElementById('kct-overlay').hidden);
    await page.screenshot({ path: path.join(OUT_T11, `original-${name}.png`) });
    await page.click('#btn-original');
    await page.waitForFunction(() => document.querySelectorAll('#kct-overlay:not([hidden]) .kct-ko').length === 10, null, { timeout: 3000 });
  }
  for (const f of ['overlay-1100x720.png', 'overlay-800x600.png', 'overlay-1100x720-dark.png']) {
    assert.ok(fs.statSync(path.join(OUT_T11, f)).size > 10000, `${f} 캡처가 비었습니다`);
  }
  await setScheme('light');
  await setSize(1100, 720);
});

test('번역 규칙 파일(termKorean.js)이 없어도 화면은 뜨고, 덮개와 "영어 원문 보기" 버튼만 꺼진다', { timeout: 60000 }, async () => {
  const other = await launchUi({ userDataName: 'user-data-missing', termKorean: path.join(OUT_T11, '없는-termKorean.js') });
  const proc = other.process();
  try {
    const p = await other.firstWindow();
    const errors = [];
    p.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    p.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
    await p.waitForFunction(() => document.documentElement.dataset.ready === '1', null, { timeout: 15000 });
    const info = await p.evaluate(() => ({
      termKorean: typeof window.KctTermKorean,
      overlay: typeof window.KctOverlay,
      button: document.getElementById('btn-original').hidden,
    }));
    assert.deepEqual(info, { termKorean: 'undefined', overlay: 'object', button: true });
    await other.evaluate((_e, d) => { globalThis.kctTest.ipc.send('pty:data', d); }, CLEAR + TRUST_LINES);
    await p.waitForFunction(() => document.querySelector('#terminal .xterm-rows').textContent.includes('Enter to confirm'), null, { timeout: 5000 });
    await sleep(300);
    const shown = await p.evaluate(() => [...document.querySelectorAll('.kct-ko')].filter((e) => e.getClientRects().length > 0).length);
    assert.equal(shown, 0);
    // 파일을 읽지 못했다는 알림 말고 다른 오류는 없다
    assert.deepEqual(errors.filter((e) => !/Failed to load resource/.test(e)), []);
  } finally {
    await Promise.race([other.close().catch(() => {}), sleep(10000)]);
    if (proc && proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
  }
});

test('화면에서 오류가 나지 않았다', () => {
  assert.deepEqual(pageErrors, []);
});

// 이 시험은 페이지에서 주소 이동을 시도하므로(막히지만 Playwright가 이동을 기다리게 된다) 맨 끝에 둔다.
test('다른 주소로 넘어가거나 새 창을 열지 못한다', async () => {
  const nav = await app.evaluate(async ({ BrowserWindow }) => {
    const wc = globalThis.kctTest.win.webContents;
    const before = wc.getURL();
    wc.executeJavaScript("window.open('https://example.com/'); location.href = 'https://example.com/'; 1").catch(() => {});
    await new Promise((r) => setTimeout(r, 800));
    return { same: wc.getURL() === before, windows: BrowserWindow.getAllWindows().length };
  });
  assert.deepEqual(nav, { same: true, windows: 1 });
});
