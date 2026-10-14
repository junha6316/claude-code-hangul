// T9 통합 시험. 실제 앱(src/main/main.js)을 Playwright `_electron`으로 띄워 처음부터 끝까지 확인한다.
//
//   npm run e2e:app
//
// 시험 목록
//   1. 가짜 claude: 신뢰 안내 → 버튼 → 요청 → 허락 카드 → "허락" → FAKE: allow → 기록 → 대화 길이 → 새 대화(FAKE_PID 바뀜)
//      PATH를 /usr/bin:/bin으로 띄워도 claude를 찾고, 가짜 claude가 받은 PATH에 /opt/homebrew/bin이 있다
//   2. 실제 claude(가짜 설정, 믿지 않는 작업 폴더 .test-tmp/T9/work): 한국어 신뢰 안내 → 기본 버튼 → 입력 대기,
//      한국어 시작 인사와 상태 줄, 20초 동안 살아 있음, 앱을 끄면 claude·electron 프로세스가 남지 않음
//   3. claude가 없으면 설치 덮개가 뜬다(설치 버튼은 누르지 않는다. 실제 설치는 T8 컨테이너 시험에서만)
//   4. 영어 허락 창이 떠 있어도 허락 카드가 있으면 같은 안내 카드를 겹쳐 띄우지 않는다(Electron 없이 app.js로)
//   5. (T12) 안내 버튼 뒤 claude가 화면을 갈아 끼우는 동안 온 포커스 알림은 다시 받을 준비가 될 때까지 붙잡는다(Electron 없이)
//   6. (T12) 실제 claude, 믿지 않는 작업 폴더: 신뢰 창의 영어 줄이 한국어 덮개로 덮이고, 넘어가면 머리말 버전·모델 줄과
//      아래 모드 줄이 덮이고, 머리말에 작업 폴더 경로가 없고(CLAUDE_CODE_HIDE_CWD), 입력 줄에 친 한글은 덮이지 않는다
//   7. (T12) 실제 claude, 작업 폴더의 부모 폴더에 .mcp.json: 새 MCP 서버 창이 덮이고, Enter(기본 선택 Continue without…)로
//      넘어간다. 실제 ~/.mcp.json과 저장소의 .claude/settings.local.json은 바뀌지 않는다
//   8. (T12) 사용자가 붙여 넣은 화면(test/fixtures/term/user/)을 가짜 claude로 앱에 그리면 기대한 줄이 덮인다
//   9. 실제 ~/.claude/settings.json 수정 시각이 그대로이고, ~/.claude.json projects에 이 앱 경로·시험 경로가 없다
//
// 9번에 쓸 값은 환경 변수로 넘길 수 있다. 넘기지 않으면 이 파일을 읽은 때의 수정 시각과 비교한다.
//   KCT_T9_WORKFLOW_START=2026-10-14T00:07:50Z   workflow 시작 시각(ISO 또는 epoch 초)
//   KCT_T9_SETTINGS_MTIME=1790734618             시작 때 ~/.claude/settings.json 수정 시각(epoch 초)
//
// 산출물(화면 캡처, 터미널 글, 덮개 표, main 로그)은 1~4번은 app/.test-tmp/T9/, 5~8번은 app/.test-tmp/T12/에 남는다.
const nodeTest = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { _electron } = require('playwright');

const { createFakeClaudeHome } = require('./helpers/fakeClaudeHome');
const { createKctApp } = require('../src/main/app');
const { buildSettings } = require('../src/main/settings');
const { displayWidth } = require('../src/shared/termKorean');

const APP_DIR = path.resolve(__dirname, '..');
const OUT = path.join(APP_DIR, '.test-tmp', 'T9');
const OUT12 = path.join(APP_DIR, '.test-tmp', 'T12');
const USER_SCREENS = path.join(__dirname, 'fixtures', 'term');
// claude는 MCP 서버 창의 답을 git 저장소 맨 위 폴더의 .claude/settings.local.json에 적는다(실측 2.1.299).
// 시험 폴더가 이 저장소 안에 있으므로, 6번 시험은 부모 폴더를 따로 git init 해서 그 안에 적히게 하고 이 파일이 그대로인지 본다.
const REPO_LOCAL_SETTINGS = path.join(APP_DIR, '..', '.claude', 'settings.local.json');
const REAL_MCP_JSON = path.join(os.homedir(), '.mcp.json');
const FAKE_CLAUDE = path.join(__dirname, 'fixtures', 'fake-claude.js');
const PERMISSION_SCREEN = path.join(__dirname, 'fixtures', 'screens', 'permission-write.txt');
const REAL_CLAUDE = path.join(os.homedir(), '.local', 'bin', 'claude');
const REAL_SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const REAL_CLAUDE_JSON = path.join(os.homedir(), '.claude.json');
const GREETING = buildSettings({ port: 1, token: 'x' }).companyAnnouncements[0];
const HANGUL = /[가-힣]/;

const mtimeSec = (file) => Math.floor(fs.statSync(file).mtimeMs / 1000);
const SETTINGS_MTIME_AT_LOAD = fs.existsSync(REAL_SETTINGS) ? mtimeSec(REAL_SETTINGS) : null;

// 모든 시험에 기본 시간 제한을 둔다. test(name, fn)과 test(name, opts, fn) 둘 다 받는다.
const test = (name, opts, fn) => (typeof opts === 'function'
  ? nodeTest(name, { timeout: 60000 }, opts)
  : nodeTest(name, { timeout: 60000, ...opts }, fn));
let realReadyScreen = null; // 2번 시험의 입력 대기 화면(아래 todo 시험이 본다)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`${ms}ms 안에 되지 않았습니다: ${what}`);
    await sleep(100);
  }
}

// ── 프로세스 ──
// pgrep -f는 명령줄 전체에서 찾는다. 시험 프로세스 자신은 뺀다.
function pgrep(pattern) {
  const r = spawnSync('pgrep', ['-f', pattern], { encoding: 'utf8' });
  return (r.stdout || '').split('\n').filter(Boolean).map(Number).filter((p) => p !== process.pid);
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// 부모 프로세스(예: Claude Code 안에서 도는 시험)의 Claude 변수를 지우고 가짜 설정·가짜 키를 쓰는 환경.
// homeOpts는 createFakeClaudeHome에 그대로 넘긴다(예: trustedPaths).
function testEnv(dir, extra, homeOpts = {}) {
  const { env } = createFakeClaudeHome({ dir: path.join(dir, 'home'), ...homeOpts });
  const out = { ...env, KCT_TEST: '1', ...extra };
  delete out.ELECTRON_RUN_AS_NODE;
  for (const [k, v] of Object.entries(out)) if (v === undefined) delete out[k];
  return out;
}

// ── 앱 띄우기·끄기 ──
async function launchApp(dir, env) {
  const userData = path.join(dir, 'user-data');
  const mainLog = path.join(dir, 'main-log.txt');
  const electronApp = await _electron.launch({
    executablePath: require('electron'),
    args: [APP_DIR, `--user-data-dir=${userData}`],
    cwd: APP_DIR,
    env,
    timeout: 30000,
  });
  const proc = electronApp.process();
  for (const s of [proc.stdout, proc.stderr]) if (s) s.on('data', (d) => fs.appendFileSync(mainLog, d));
  const page = await electronApp.firstWindow();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(`console: ${m.text()}`); });
  await page.waitForFunction(() => document.documentElement.dataset.ready === '1', null, { timeout: 15000 });
  // renderer에 오는 pty:data를 그대로 모아 둔다(preload가 노출한 window.kct.on을 쓴다).
  await page.evaluate(() => {
    window.__ptyTap = '';
    window.kct.on('pty:data', (d) => { window.__ptyTap += d; });
  });
  return { electronApp, page, proc, dir, userData, mainLog, pageErrors };
}

// 사용자가 창을 닫는 것처럼 끈다. 스스로 끝나면 true, SIGKILL로 끝내야 했으면 false.
async function closeApp(h) {
  const exited = new Promise((r) => {
    if (h.proc.exitCode !== null || h.proc.signalCode !== null) r();
    else h.proc.once('exit', r);
  });
  await h.electronApp.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) w.close(); }).catch(() => {});
  const ok = await Promise.race([exited.then(() => true), sleep(15000).then(() => false)]);
  if (!ok) h.proc.kill('SIGKILL');
  await Promise.race([h.electronApp.close().catch(() => {}), sleep(5000)]);
  return ok;
}

// 끈 뒤 이 실행의 폴더를 명령줄에 가진 프로세스(electron 본체·도우미, claude --settings <userData>/…)가 남지 않는다.
async function assertNoProcesses(h, extraPids = []) {
  let left = [];
  for (let i = 0; i < 50; i++) {
    left = [...pgrep(h.dir), ...extraPids.filter(alive)];
    if (!left.length) break;
    await sleep(100);
  }
  const detail = left.map((p) => spawnSync('ps', ['-o', 'pid=,command=', '-p', String(p)], { encoding: 'utf8' }).stdout.trim());
  assert.deepEqual(detail, [], '앱을 끈 뒤에도 프로세스가 남았습니다');
}

// ── 화면 읽기 ──
const termText = (page) => page.evaluate(() => [...document.querySelectorAll('#terminal .xterm-rows > div')]
  .map((d) => d.textContent.replace(/ /g, ' ').replace(/\s+$/, '')).join('\n'));

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
const tapText = async (page) => (await page.evaluate(() => window.__ptyTap)).replace(ANSI, '');

function waitTerm(page, pred, ms, what) {
  return waitFor(async () => { const t = await termText(page); return pred(t) ? t : null; }, ms, `터미널: ${what}`);
}

async function shot(h, name) {
  await h.page.screenshot({ path: path.join(h.dir, `${name}.png`) });
  fs.writeFileSync(path.join(h.dir, `${name}.terminal.txt`), await termText(h.page));
}

function freshDir(name, base = OUT) {
  const dir = path.join(base, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function assertNoAppErrors(h) {
  assert.deepEqual(h.pageErrors, [], '화면에서 오류가 났습니다');
  const log = fs.existsSync(h.mainLog) ? fs.readFileSync(h.mainLog, 'utf8') : '';
  assert.doesNotMatch(log, /\[app\] 처리 중 오류|\[ipc\] .* 처리 중 오류|\[main\]/, `main 로그에 오류가 있습니다\n${log}`);
}

// ── 시험 ──

test('가짜 claude: 신뢰 안내 → 허락 카드 → FAKE: allow → 한국어 기록 → 대화 길이 → 새 대화면 FAKE_PID가 바뀐다(PATH는 /usr/bin:/bin)', { timeout: 120000 }, async () => {
  const dir = freshDir('fake');
  const work = path.join(dir, '시험작업실');
  const env = testEnv(dir, { PATH: '/usr/bin:/bin', KCT_CLAUDE_PATH: FAKE_CLAUDE, KCT_WORKDIR: work });
  const h = await launchApp(dir, env);
  const fakePids = [];
  let closed = false;
  try {
    const { page } = h;
    const main = await h.electronApp.evaluate(({ BrowserWindow }) => ({
      path: process.env.PATH,
      title: BrowserWindow.getAllWindows()[0].getTitle(),
    }));
    assert.equal(main.path, '/usr/bin:/bin', 'main 프로세스는 PATH가 /usr/bin:/bin인 채로 떠야 합니다');
    assert.equal(main.title, '클로드 코드 한글판 (비공식)');

    // 1) 신뢰 안내 카드가 뜬다
    const guide = page.locator('#guide-area .card.guide[data-guide-id="trust"]');
    await guide.waitFor({ state: 'visible', timeout: 20000 });
    assert.ok(fs.statSync(work).isDirectory(), '작업 폴더를 만들어야 합니다');
    assert.equal(await page.locator('#folder-name').textContent(), '시험작업실', '위 막대에 처음부터 작업 폴더 이름이 보여야 합니다');
    assert.match(await guide.locator('h3').textContent(), HANGUL);
    assert.match(await termText(page), /Yes, I trust this folder/);
    await shot(h, 'fake-01-trust-guide');

    // 2) 버튼을 누르면 가짜가 입력 대기로 넘어가고 안내 카드가 사라진다
    await guide.locator('button', { hasText: '믿어요, 시작하기' }).click();
    await waitTerm(page, (t) => t.includes('가짜 Claude Code') && /^❯/m.test(t) && !t.includes('trust this folder'), 10000, '입력 대기');
    await page.locator('#guide-area').waitFor({ state: 'hidden', timeout: 5000 });
    await shot(h, 'fake-02-prompt');

    const tap1 = await tapText(page);
    const pid1 = Number(/FAKE_PID=(\d+)/.exec(tap1)[1]);
    fakePids.push(pid1);
    // 3) PATH가 /usr/bin:/bin이어도 로그인 셸 PATH를 넘긴다
    const fakePath = /FAKE_PATH=([^\r\n]*)/.exec(tap1)[1];
    fs.writeFileSync(path.join(dir, 'fake-path.txt'), `${fakePath}\n`);
    if (fs.existsSync('/opt/homebrew/bin')) {
      assert.ok(fakePath.split(':').includes('/opt/homebrew/bin'), `FAKE_PATH에 /opt/homebrew/bin이 없습니다: ${fakePath}`);
    }
    assert.notEqual(fakePath, '/usr/bin:/bin');

    // 4) 요청을 치면 허락 카드가 뜬다
    await page.focus('#terminal .xterm-helper-textarea');
    await page.keyboard.insertText('메모 파일 하나 만들어 줘');
    await page.keyboard.press('Enter');
    const perm = page.locator('#perm-area .card.perm');
    await perm.waitFor({ state: 'visible', timeout: 10000 });
    const permTitle = await perm.locator('h3').textContent();
    assert.match(permTitle, HANGUL);
    assert.doesNotMatch(await perm.textContent(), /\/Users\//);
    await shot(h, 'fake-03-permission-card');

    // 5) "허락"을 누르면 터미널에 FAKE: allow
    await perm.locator('button', { hasText: '허락' }).click();
    await waitTerm(page, (t) => t.includes('FAKE: allow'), 10000, 'FAKE: allow');

    // 6) 기록에 한국어 줄이 쌓인다(도구 시작·끝, 답 마침)
    const logs = await waitFor(async () => {
      const l = await page.locator('#log li .text').allTextContents();
      return l.length >= 3 ? l : null;
    }, 10000, '기록 3줄');
    for (const line of logs) {
      assert.match(line, HANGUL, `기록이 한국어가 아닙니다: ${line}`);
      assert.doesNotMatch(line, /\/Users\//);
    }

    // 7) 위 막대에 대화 길이, 터미널 아래 상태 줄도 한국어
    await page.waitForFunction(() => document.querySelector('#context-text').textContent === '24%', null, { timeout: 10000 });
    assert.equal(await page.locator('.context-label').textContent(), '대화 길이');
    assert.equal(await page.locator('#folder-name').textContent(), '시험작업실');
    await waitTerm(page, (t) => t.includes('📁 시험작업실 · 대화 길이 24%'), 5000, '상태 줄');
    await shot(h, 'fake-04-allowed');

    // 8) 한 번 더 요청하고 "거절"을 누르면 FAKE: deny
    await page.focus('#terminal .xterm-helper-textarea');
    await page.keyboard.insertText('두 번째 요청');
    await page.keyboard.press('Enter');
    await perm.waitFor({ state: 'visible', timeout: 10000 });
    await perm.locator('button', { hasText: '거절' }).click();
    await waitTerm(page, (t) => t.includes('FAKE: deny'), 10000, 'FAKE: deny');
    await page.waitForFunction(() => document.querySelector('#context-text').textContent === '40%', null, { timeout: 10000 });

    // 9) "새 대화"를 누르면 가짜 claude를 새로 띄운다(FAKE_PID가 바뀌고 앞 프로세스는 끝난다)
    await page.evaluate(() => { window.__ptyTap = ''; });
    await page.click('#btn-new');
    const tap2 = await waitFor(async () => { const t = await tapText(page); return /FAKE_PID=\d+/.test(t) ? t : null; }, 10000, '새 FAKE_PID');
    const pid2 = Number(/FAKE_PID=(\d+)/.exec(tap2)[1]);
    fakePids.push(pid2);
    assert.notEqual(pid2, pid1, '새 대화 뒤에도 FAKE_PID가 같습니다');
    await waitFor(() => !alive(pid1), 5000, '앞 가짜 claude 끝남');
    assert.doesNotMatch(await termText(page), /대화가 끝났어요/, '새 대화로 끈 claude를 끝났다고 알리면 안 됩니다');
    await guide.waitFor({ state: 'visible', timeout: 10000 });
    assert.equal(await page.locator('#context-text').textContent(), '0%', '새 대화면 대화 길이가 0%로 돌아가야 합니다');
    await shot(h, 'fake-05-new-session');
    fs.writeFileSync(path.join(dir, 'fake-pids.txt'), `before=${pid1}\nafter=${pid2}\n`);
    assertNoAppErrors(h);
  } finally {
    closed = await closeApp(h);
  }
  assert.ok(closed, '창을 닫으면 앱이 스스로 끝나야 합니다');
  await assertNoProcesses(h, fakePids);
});

test('실제 claude(가짜 설정, 믿지 않는 작업 폴더): 한국어 신뢰 안내 → 입력 대기, 한국어 시작 인사와 상태 줄, 20초 생존, 끄면 프로세스가 남지 않는다', { timeout: 180000 }, async (t) => {
  if (!fs.existsSync(REAL_CLAUDE)) return t.skip(`실제 claude가 없습니다: ${REAL_CLAUDE}`);
  const dir = freshDir('real');
  const work = path.join(OUT, 'work');
  fs.rmSync(work, { recursive: true, force: true });
  const env = testEnv(dir, { PATH: '/usr/bin:/bin', KCT_WORKDIR: work, BROWSER: '/usr/bin/true' });
  delete env.KCT_CLAUDE_PATH;
  const h = await launchApp(dir, env);
  let claudePids = [];
  let closed = false;
  try {
    const { page } = h;
    // 1) 한국어 신뢰 안내
    const guide = page.locator('#guide-area .card.guide[data-guide-id="trust"]');
    await guide.waitFor({ state: 'visible', timeout: 45000 });
    assert.ok(fs.statSync(work).isDirectory(), '작업 폴더를 만들어야 합니다');
    assert.equal(await page.locator('#folder-name').textContent(), 'work');
    for (const text of [await guide.locator('h3').textContent(), ...(await guide.locator('button').allTextContents())]) {
      assert.match(text, HANGUL, `안내 글이 한국어가 아닙니다: ${text}`);
    }
    assert.match(await termText(page), /Yes, I trust this folder/);
    await shot(h, 'real-01-trust-guide');

    // 2) 기본 버튼 → 입력 대기, 터미널에 한국어 시작 인사와 한국어 상태 줄
    await guide.locator('button.primary').click();
    const screen = await waitTerm(page, (s) => s.includes(GREETING) && /^❯/m.test(s) && s.includes('📁 work · 대화 길이 0%') && !s.includes('trust this folder'),
      30000, '시작 인사·상태 줄·입력 대기');
    assert.doesNotMatch(screen, /Settings Error|Invalid settings|settings.*(invalid|error)/i);
    // 안내 버튼 뒤 포커스 알림이 메아리로 찍히면 "^[[I"가 보이고 첫 줄이 밀린다(app.js FOCUS_HOLD_MS)
    assert.doesNotMatch(screen, /\^\[/, '터미널에 이스케이프 글자가 그대로 찍혔습니다');
    // 머리말 경로를 숨기면(CLAUDE_CODE_HIDE_CWD) 글이 두 줄이 돼서 버전 줄이 로고 둘째 줄(▝▜██████▀) 옆으로 내려온다.
    assert.match(screen, /^.*█.* +Claude Code v\d+\.\d+\.\d+$/m);
    await page.locator('#guide-area').waitFor({ state: 'hidden', timeout: 5000 });
    await page.waitForFunction(() => document.querySelector('#context-text').textContent === '0%' && document.querySelector('#folder-name').textContent === 'work', null, { timeout: 10000 });
    await shot(h, 'real-02-ready');
    realReadyScreen = await termText(page);

    // 3) 20초 동안 claude가 살아 있다
    claudePids = pgrep(path.join(h.userData, 'kct-settings.json'));
    assert.ok(claudePids.length >= 1, 'claude 프로세스를 찾지 못했습니다');
    const until = Date.now() + 20000;
    while (Date.now() < until) {
      assert.ok(claudePids.every(alive), 'claude가 20초 안에 끝났습니다');
      await sleep(1000);
    }
    const after20 = await termText(page);
    assert.doesNotMatch(after20, /대화가 끝났어요/);
    assert.ok(after20.includes('대화 길이'), '20초 뒤에도 상태 줄이 보여야 합니다');
    await shot(h, 'real-03-after-20s');
    fs.writeFileSync(path.join(dir, 'claude-pids.txt'), `${claudePids.join('\n')}\n`);
    assertNoAppErrors(h);
  } finally {
    closed = await closeApp(h);
  }
  assert.ok(closed, '창을 닫으면 앱이 스스로 끝나야 합니다');
  await assertNoProcesses(h, claudePids);
});

// 알려진 문제: xterm.js는 기본(Unicode 6) 폭표에서 📁를 1칸으로, claude는 2칸으로 센다. 그래서 claude가 상태 줄을
// 고쳐 쓸 때 한 칸씩 어긋나 앞 글자가 남는다(예: "대화 길이 0%         s"). @xterm/addon-unicode11을 renderer(T7)와
// app.js의 가상 화면에 붙이거나(T1이 설치), 상태 줄에서 이모지를 빼면(T5) 풀린다. 고쳐지면 todo를 뗀다.
test('실제 claude 화면의 상태 줄 줄에 지난 글자가 남지 않는다', { todo: 'TODO 알려진 문제(종료 코드에 영향 없음): 이모지 폭 차이(📁). addon-unicode11 또는 상태 줄 이모지 빼기 필요' }, (t) => {
  if (!realReadyScreen) return t.skip('2번 시험의 화면이 없습니다');
  const row = realReadyScreen.split('\n').find((l) => l.includes('대화 길이'));
  assert.match(row, /대화 길이 \d+%\s+(◐.*)?$/, `상태 줄 줄: ${JSON.stringify(row)}`);
});

test('claude가 없으면 설치 덮개가 뜨고 claude를 띄우지 않는다(설치 버튼은 누르지 않는다)', { timeout: 60000 }, async () => {
  const dir = freshDir('missing');
  const env = testEnv(dir, { PATH: '/usr/bin:/bin', KCT_CLAUDE_PATH: path.join(dir, 'no-such', 'claude'), KCT_WORKDIR: path.join(dir, 'work') });
  const h = await launchApp(dir, env);
  let closed = false;
  try {
    const { page } = h;
    await page.locator('#install-overlay').waitFor({ state: 'visible', timeout: 20000 });
    assert.equal(await page.locator('#btn-install').textContent(), '설치하기');
    assert.match(await page.locator('#install-title').textContent(), HANGUL);
    await sleep(2500); // 늦게라도 claude를 띄우지 않는지 본다
    assert.equal(await tapText(page), '');
    assert.equal(await page.locator('#install-overlay').isVisible(), true);
    assert.deepEqual(pgrep(path.join(h.userData, 'kct-settings.json')), []);
    await shot(h, 'missing-01-install-overlay');
    assertNoAppErrors(h);
  } finally {
    closed = await closeApp(h);
  }
  assert.ok(closed);
  await assertNoProcesses(h);
});

// 영어 허락 창을 그대로 보여 주고, 키를 받으면 PreToolUse·PermissionRequest 훅을 보내 결정을 기다리는 작은 가짜.
function writeDialogFake(file) {
  fs.writeFileSync(file, `'use strict';
const fs = require('fs');
const http = require('http');
const args = process.argv.slice(2);
if (args.includes('--version')) { process.stdout.write('2.1.296 (Claude Code)\\n'); process.exit(0); }
const settings = JSON.parse(fs.readFileSync(args[args.indexOf('--settings') + 1], 'utf8'));
const url = (ev) => settings.hooks[ev][0].hooks[0].url;
const post = (ev, body) => new Promise((resolve) => {
  const req = http.request(url(ev), { method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
    let t = ''; res.on('data', (d) => { t += d; }); res.on('end', () => resolve(t));
  });
  req.on('error', () => resolve(''));
  req.end(JSON.stringify(body));
});
const screen = fs.readFileSync(${JSON.stringify(PERMISSION_SCREEN)}, 'utf8');
process.stdout.write('\\x1b[2J\\x1b[H' + screen.replace(/\\n/g, '\\r\\n'));
if (process.stdin.isTTY) process.stdin.setRawMode(true);
let started = false;
process.stdin.on('data', async () => {
  if (started) return;
  started = true;
  const base = { session_id: 'dialog-session', cwd: process.cwd(), permission_mode: 'default' };
  const tool = { tool_name: 'Write', tool_input: { file_path: process.cwd() + '/a.txt', content: 'hello' } };
  await post('PreToolUse', { ...base, hook_event_name: 'PreToolUse', ...tool, tool_use_id: 'toolu_dialog_1' });
  const answer = await post('PermissionRequest', { ...base, hook_event_name: 'PermissionRequest', ...tool });
  let behavior = 'none';
  try { behavior = JSON.parse(answer).hookSpecificOutput.decision.behavior; } catch {}
  process.stdout.write('\\x1b[2J\\x1b[HDECISION=' + behavior + '\\r\\n\\r\\n> ');
});
`);
}

test('터미널에 영어 허락 창이 떠 있어도, 훅으로 받은 허락 카드가 있으면 같은 일을 묻는 안내 카드는 띄우지 않는다', { timeout: 60000 }, async () => {
  const dir = freshDir('perm-guide');
  const script = path.join(dir, 'fake-dialog.js');
  writeDialogFake(script);
  const events = [];
  let out = '';
  const kct = createKctApp({
    send: (channel, payload) => {
      events.push({ channel, payload });
      if (channel === 'pty:data') out += payload;
    },
    settingsDir: path.join(dir, 'settings'),
    env: testEnv(dir, { KCT_CLAUDE_PATH: script, KCT_WORKDIR: path.join(dir, 'work') }),
  });
  const guides = () => events.filter((e) => e.channel === 'guide:show');
  const lastGuide = () => { const g = guides(); return g.length ? g[g.length - 1].payload : undefined; };
  let pid = null;
  try {
    kct.handlers['pty:resize']({ cols: 150, rows: 40 }); // 캡처 화면이 접히지 않는 폭
    await kct.start();
    pid = kct.claudePid();
    assert.ok(pid, '가짜를 띄워야 합니다');

    // 훅이 오기 전에는 화면만 보고 허락 안내를 띄운다(훅이 늦거나 오지 않을 때의 대비)
    await waitFor(() => lastGuide() && lastGuide().id === 'permission', 10000, '허락 안내');

    // 훅으로 허락 요청이 오면 허락 카드를 띄우고 안내 카드는 내린다
    kct.handlers['pty:input']('g');
    const show = await waitFor(() => events.find((e) => e.channel === 'perm:show'), 10000, 'perm:show');
    assert.match(show.payload.title, HANGUL);
    assert.equal(lastGuide(), null);
    const afterShow = events.indexOf(show);
    assert.ok(events.slice(afterShow).some((e) => e.channel === 'guide:show' && e.payload === null));

    // 허락하면 카드를 지우고, 허락 창이 사라진 화면을 다시 읽어 안내도 띄우지 않는다
    kct.handlers['perm:decide']({ id: show.payload.id, decision: 'allow' });
    await waitFor(() => out.includes('DECISION=allow'), 10000, '가짜가 allow를 받음');
    const clear = await waitFor(() => events.find((e) => e.channel === 'perm:clear'), 5000, 'perm:clear');
    assert.equal(clear.payload.id, show.payload.id);
    await sleep(1000);
    const later = events.slice(afterShow).filter((e) => e.channel === 'guide:show').map((e) => e.payload && e.payload.id);
    assert.ok(!later.includes('permission'), `허락 뒤에 허락 안내가 다시 떴습니다: ${JSON.stringify(later)}`);
    assert.equal(lastGuide(), null);
    fs.writeFileSync(path.join(dir, 'events.json'), JSON.stringify(events.filter((e) => e.channel !== 'pty:data'), null, 2));
  } finally {
    await kct.shutdown();
  }
  assert.equal(kct.claudePid(), null);
  await waitFor(() => !alive(pid), 3000, '가짜 끝남');
});

// 신뢰 창에서 Enter를 받으면 claude처럼 포커스 알림을 끄고(ESC [?1004l) 입력 모드를 잠깐 풀었다가(그동안 받은 글은
// 터미널이 그대로 메아리친다) switchMs 뒤에 다시 켜는(ESC [?1004h) 가짜. 다시 켠 뒤 포커스 알림을 받으면 GOT_FOCUS_IN을 찍는다.
function writeSwitchingFake(file, switchMs) {
  fs.writeFileSync(file, `'use strict';
if (process.argv.includes('--version')) { process.stdout.write('2.1.299 (Claude Code)\\n'); process.exit(0); }
const out = (s) => process.stdout.write(s);
let phase = 'dialog';
process.stdin.setRawMode(true);
out('\\x1b[?1004hDIALOG\\r\\n');
process.stdin.on('data', (d) => {
  const s = String(d);
  if (phase === 'dialog' && s.includes('\\r')) {
    phase = 'switching';
    out('\\x1b[?1004l');
    process.stdin.setRawMode(false);
    setTimeout(() => { process.stdin.setRawMode(true); phase = 'ready'; out('\\x1b[?1004hREADY\\r\\n'); }, ${switchMs});
  } else if (phase === 'ready' && s.includes('\\x1b[I')) {
    out('GOT_FOCUS_IN\\r\\n');
  }
});
`);
}

test('안내 버튼 뒤 claude가 화면을 갈아 끼우는 동안 온 포커스 알림은 다시 받을 준비(ESC [?1004h)가 될 때까지 붙잡아서 ^[[I로 찍히지 않는다', { timeout: 30000 }, async () => {
  const dir = freshDir('focus-switch', OUT12);
  const script = path.join(dir, 'fake-switching.js');
  // 안내 버튼 뒤 붙잡는 시간(app.js FOCUS_HOLD_MS 500ms)보다 오래 갈아 끼운다(무거울 때의 실제 claude처럼).
  writeSwitchingFake(script, 1200);
  let out = '';
  const kct = createKctApp({
    send: (channel, payload) => { if (channel === 'pty:data') out += payload; },
    settingsDir: path.join(dir, 'settings'),
    env: testEnv(dir, { KCT_CLAUDE_PATH: script, KCT_WORKDIR: path.join(dir, 'work') }),
  });
  let pid = null;
  try {
    kct.handlers['pty:resize']({ cols: 80, rows: 24 });
    await kct.start();
    pid = kct.claudePid();
    await waitFor(() => out.includes('DIALOG'), 10000, '가짜의 첫 화면');
    // 안내 버튼(Enter) → 터미널로 포커스가 돌아오며 xterm.js가 포커스 알림(ESC [ I)을 보낸다
    kct.handlers['guide:action']({ keys: '\r' });
    kct.handlers['pty:input']('\x1b[I');
    await waitFor(() => out.includes('READY'), 5000, '가짜가 입력 모드를 다시 켬');
    await sleep(500);
    assert.doesNotMatch(out, /\^\[/, `포커스 알림이 글자로 찍혔습니다: ${JSON.stringify(out)}`);
    assert.match(out, /GOT_FOCUS_IN/, `다시 켠 뒤에 포커스 알림을 받아야 합니다: ${JSON.stringify(out)}`);
  } finally {
    fs.writeFileSync(path.join(dir, 'pty-out.txt'), out);
    await kct.shutdown();
  }
  await waitFor(() => !alive(pid), 3000, '가짜 끝남');
});

// ── 영어 줄 덮개(T12) ──
// 화면의 덮개는 renderer가 src/shared/termKorean.js(T10)의 translateScreen으로 만들고 overlay.js(T11)가 그린다.
// 시험은 터미널 줄(.xterm-rows의 줄마다 div, 덮개 밑의 원래 글)과 보이는 덮개(.kct-ko)를 읽어 대 본다.

function overlayState(page) {
  return page.evaluate(() => {
    const layer = document.getElementById('kct-overlay');
    const rows = [...document.querySelectorAll('#terminal .xterm-rows > div')]
      .map((d) => d.textContent.replace(/\u00a0/g, ' ').replace(/\s+$/, ''));
    const ko = [...document.querySelectorAll('#kct-overlay .kct-ko')]
      .filter((e) => e.getClientRects().length > 0)
      .map((e) => ({
        row: Number(e.dataset.row), col: Number(e.dataset.col), rows: Number(e.dataset.rows), width: Number(e.dataset.width),
        kind: e.dataset.kind, text: e.textContent, bg: getComputedStyle(e).backgroundColor,
      }));
    return {
      on: !!layer && !layer.hidden,
      cols: Number(layer && layer.dataset.cols),
      cursorRow: Number(layer && layer.dataset.cursorRow),
      // xterm.js는 커서를 숨기면(ESC [?25l) 커서 칸(.xterm-cursor)을 그리지 않는다.
      cursorShown: !!document.querySelector('#terminal .xterm-rows .xterm-cursor'),
      termBg: getComputedStyle(document.querySelector('#terminal .xterm-viewport')).backgroundColor,
      rows,
      ko,
    };
  });
}

// 덮개가 그대로 둬도 되는 앞부분: 줄 앞 공백, 고르기 표시(❯)와 번호, 안내 줄 앞 그림(⚠ ⏺ ▎ ⏸ ⎿).
const LEAD_KEEP = /^\s*(?:[❯⚠⏺▎⏸⏵⎿]+\s*)?(?:\d+\.\s*)?/;
// 머리말 로고 글자
const LOGO_KEEP = /^[\s▐▛█▜▀▝▘▌▙▟▄▗▖]*/;

const rowOf = (rows, re, from = 0) => {
  for (let i = Math.max(0, from); i < rows.length; i++) if (re.test(rows[i])) return i;
  return -1;
};
// re에 맞는 줄부터 빈 줄 앞까지(화면 폭 때문에 접힌 문단).
function paragraphRows(rows, re) {
  const start = rowOf(rows, re);
  if (start < 0) return [-1];
  const out = [];
  for (let r = start; r < rows.length && rows[r].trim(); r++) out.push(r);
  return out;
}

// 줄에서 덮개가 덮어야 하는 칸 범위 [from, to). keep에 맞는 앞부분은 빼고, 끝은 줄 글의 끝.
function spanOf(line, keep = LEAD_KEEP) {
  const m = keep.exec(line);
  return [displayWidth(m && m.index === 0 ? m[0] : ''), displayWidth(line)];
}
const touching = (st, r) => st.ko.filter((o) => o.row <= r && r < o.row + o.rows);
const covering = (st, r, [from, to]) => touching(st, r).find((o) => o.col <= from && to <= o.col + o.width);

// 덮여야 하는 줄 목록([{ what, row, keep }])에서 문제를 찾는다. 덮개 글은 한국어이고 배경은 터미널 배경과 같아야 한다.
function coverProblems(st, lines) {
  const problems = [];
  if (!st.on) problems.push('덮개 층이 꺼져 있습니다');
  for (const l of lines) {
    if (l.row < 0) { problems.push(`${l.what}: 화면에서 줄을 찾지 못했습니다`); continue; }
    const span = spanOf(st.rows[l.row], l.keep);
    const o = covering(st, l.row, span);
    if (!o) {
      problems.push(`${l.what}: ${l.row}번 줄 ${span[0]}~${span[1]}칸을 덮는 덮개가 없습니다 ${JSON.stringify(st.rows[l.row])}`);
      continue;
    }
    if (!HANGUL.test(o.text)) problems.push(`${l.what}: 덮개 글이 한국어가 아닙니다 ${JSON.stringify(o.text)}`);
    if (o.bg !== st.termBg || /rgba\(.*, 0\)$/.test(o.bg)) problems.push(`${l.what}: 덮개 배경(${o.bg})이 터미널 배경(${st.termBg})과 달라 밑의 영어가 비칠 수 있습니다`);
  }
  return problems;
}

// find(rows)가 돌려준 줄이 모두 덮일 때까지 기다린다. 시간이 지나면 마지막 화면과 문제를 돌려준다.
async function waitCovered(page, find, ms) {
  const end = Date.now() + ms;
  for (;;) {
    const st = await overlayState(page);
    const lines = find(st.rows);
    const problems = coverProblems(st, lines);
    if (!problems.length || Date.now() > end) return { st, lines, problems };
    await sleep(100);
  }
}

// 검증자가 읽을 덮개 표: 줄마다 원래 글, 그 줄에서 시작하는 덮개의 자리와 한국어.
function overlayTable(st) {
  const out = [`칸 ${st.cols} · 커서 줄 ${st.cursorRow}${st.cursorShown ? '' : '(커서 숨김)'} · 덮개 ${st.on ? '켬' : '끔'} ${st.ko.length}개`];
  st.rows.forEach((line, r) => {
    out.push(`${String(r).padStart(2)} ${touching(st, r).length ? '#' : ' '} ${line}`);
    for (const o of st.ko.filter((k) => k.row === r)) {
      out.push(`       └ ${o.col}칸부터 ${o.width}칸 × ${o.rows}줄 [${o.kind}] ${o.text.replace(/\n/g, ' ⏎ ')}`);
    }
  });
  return `${out.join('\n')}\n`;
}

async function shotOverlay(h, name) {
  const st = await overlayState(h.page);
  await h.page.screenshot({ path: path.join(h.dir, `${name}.png`) });
  fs.writeFileSync(path.join(h.dir, `${name}.overlay.txt`), overlayTable(st));
  return st;
}

// 덮개 문제는 모아 두었다가 시험 끝에 한꺼번에 알린다(한 화면이 어긋나도 다음 화면까지 확인하게).
function collectCover(failures, result, label) {
  for (const p of result.problems) failures.push(`${label} · ${p}`);
  if (result.problems.length) failures.push(`${label} 화면\n${overlayTable(result.st)}`);
}

function fileStamp(file) {
  try {
    const s = fs.statSync(file);
    return { mtimeMs: s.mtimeMs, text: fs.readFileSync(file, 'utf8') };
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

const trustLines = (rows) => [
  { what: '"Accessing workspace:" 줄', row: rowOf(rows, /^\s*Accessing workspace:$/) },
  ...paragraphRows(rows, /^\s*Quick safety check:/).map((row) => ({ what: `안전 확인 문단(${row}번 줄)`, row })),
  { what: '"Claude Code\'ll be able to …" 줄', row: rowOf(rows, /^\s*Claude Code'll be able to read, edit, and execute files here\.$/) },
  { what: '고르기 "Yes, I trust this folder"', row: rowOf(rows, /^\s*(?:❯\s*)?(?:\d+\.\s*)?Yes, I trust this folder$/), keep: LEAD_KEEP },
  { what: '고르기 "No, exit"', row: rowOf(rows, /^\s*(?:❯\s*)?(?:\d+\.\s*)?No, exit$/), keep: LEAD_KEEP },
  { what: '"Enter to confirm" 줄', row: rowOf(rows, /^\s*Enter to confirm · Esc to cancel$/) },
];

// 입력 대기 화면: 머리말 버전·모델 줄, 입력 칸 아래 모드 줄, 생각 깊이(◐ medium · /effort).
function readyLines(rows) {
  const version = rowOf(rows, /Claude Code v\d+\.\d+\.\d+$/);
  const input = rowOf(rows, /^❯/);
  return [
    { what: '머리말 버전 줄', row: version, keep: /^.*?(?=Claude Code v)/ },
    { what: '머리말 모델 줄', row: version < 0 || !(rows[version + 1] || '').replace(LOGO_KEEP, '') ? -1 : version + 1, keep: LOGO_KEEP },
    { what: '아래 모드 줄', row: input < 0 ? -1 : rowOf(rows, /mode on|for shortcuts|for agents/, input + 1), keep: LEAD_KEEP },
    { what: '생각 깊이', row: rowOf(rows, /[○◐●◉◈] \S+ · \/effort$/), keep: /^.*?(?=[○◐●◉◈] )/ },
  ];
}

const isReady = (s) => s.includes(GREETING) && /^❯/m.test(s) && s.includes('대화 길이');

test('실제 claude(믿지 않는 작업 폴더): 신뢰 창 영어 줄이 한국어로 덮이고, 넘어가면 머리말·모드 줄이 덮이고, 머리말에 경로가 없고, 친 한글은 덮이지 않는다', { timeout: 180000 }, async (t) => {
  if (!fs.existsSync(REAL_CLAUDE)) return t.skip(`실제 claude가 없습니다: ${REAL_CLAUDE}`);
  const dir = freshDir('real-trust', OUT12);
  const work = path.join(dir, 'work');
  const env = testEnv(dir, { PATH: '/usr/bin:/bin', KCT_WORKDIR: work, BROWSER: '/usr/bin/true' });
  delete env.KCT_CLAUDE_PATH;
  const repoBefore = fileStamp(REPO_LOCAL_SETTINGS);
  const h = await launchApp(dir, env);
  const failures = [];
  let claudePids = [];
  let closed = false;
  try {
    const { page } = h;
    // 1) 신뢰 창: Accessing workspace, 안전 확인 문단, 고르기 두 줄, Enter to confirm이 덮인다
    const guide = page.locator('#guide-area .card.guide[data-guide-id="trust"]');
    await guide.waitFor({ state: 'visible', timeout: 45000 });
    await waitTerm(page, (s) => s.includes('Enter to confirm'), 10000, '신뢰 창');
    const trust = await waitCovered(page, trustLines, 5000);
    await shotOverlay(h, 'real-trust-01-dialog');
    claudePids = pgrep(path.join(h.userData, 'kct-settings.json'));
    // 영어 원문과 견줘 볼 수 있게 덮개를 끈 화면도 남긴다
    await page.click('#btn-original');
    await page.waitForFunction(() => document.getElementById('kct-overlay').hidden, null, { timeout: 3000 });
    await shotOverlay(h, 'real-trust-01-dialog-original');
    await page.click('#btn-original');
    await page.waitForFunction(() => !document.getElementById('kct-overlay').hidden, null, { timeout: 3000 });
    collectCover(failures, trust, '신뢰 창');
    // 덮개 밑 원래 글(터미널 버퍼)은 영어 그대로다
    assert.match(await termText(page), /Yes, I trust this folder/);

    // 2) 안내 카드 버튼으로 넘어가면 머리말 버전·모델 줄과 아래 모드 줄이 덮인다
    await guide.locator('button.primary').click();
    const screen = await waitTerm(page, (s) => isReady(s) && !s.includes('trust this folder'), 30000, '입력 대기');
    const ready = await waitCovered(page, readyLines, 5000);
    await shotOverlay(h, 'real-trust-02-ready');
    collectCover(failures, ready, '입력 대기');

    // 3) 머리말에 작업 폴더 경로가 없다(CLAUDE_CODE_HIDE_CWD=1)
    const rows = screen.split('\n');
    const header = rows.slice(0, Math.max(0, rowOf(rows, /^─{10,}/))).join('\n');
    assert.ok(header.includes('Claude Code v'), `머리말을 찾지 못했습니다\n${screen}`);
    assert.ok(!header.includes(work) && !/\.test-tmp|~\/|\/Users\//.test(header), `머리말에 작업 폴더 경로가 보입니다\n${header}`);

    // 4) 입력 줄에 친 한글은 덮이지 않는다
    await page.focus('#terminal .xterm-helper-textarea');
    await page.keyboard.insertText('한글 입력 시험');
    await waitTerm(page, (s) => /^❯ 한글 입력 시험$/m.test(s), 10000, '입력 줄의 한글');
    await sleep(500); // 덮개는 다음 그리기 때 바뀐다
    const typed = await shotOverlay(h, 'real-trust-03-typed');
    const inputRow = rowOf(typed.rows, /^❯ 한글 입력 시험$/);
    assert.deepEqual(touching(typed, inputRow), [], `입력 줄이 덮였습니다\n${overlayTable(typed)}`);
    assert.ok(typed.ko.length > 0, '입력하는 동안에도 머리말 덮개는 남아 있어야 합니다');
    assertNoAppErrors(h);
  } finally {
    closed = await closeApp(h);
  }
  assert.ok(closed, '창을 닫으면 앱이 스스로 끝나야 합니다');
  await assertNoProcesses(h, claudePids);
  assert.deepEqual(fileStamp(REPO_LOCAL_SETTINGS), repoBefore, '저장소의 .claude/settings.local.json이 바뀌었습니다');
  assert.deepEqual(failures, [], '덮여야 하는 줄이 덮이지 않았습니다');
});

test('실제 claude(작업 폴더의 부모 폴더에 .mcp.json): 새 MCP 서버 창이 한국어로 덮이고, Enter(기본 선택 Continue without…)로 넘어간다', { timeout: 180000 }, async (t) => {
  if (!fs.existsSync(REAL_CLAUDE)) return t.skip(`실제 claude가 없습니다: ${REAL_CLAUDE}`);
  const dir = freshDir('real-mcp', OUT12);
  const parent = path.join(dir, 'parent');
  const work = path.join(parent, 'work');
  fs.mkdirSync(work, { recursive: true });
  // 부모 폴더를 따로 git 저장소로 만들어, claude가 MCP 창의 답을 이 저장소가 아니라 시험 폴더 안에 적게 한다.
  const git = spawnSync('git', ['init', '-q', parent], { encoding: 'utf8' });
  assert.equal(git.status, 0, `git init 실패: ${git.stderr}`);
  // 가짜 설정을 먼저 만든다. createFakeClaudeHome은 그때 보이는 상위 .mcp.json 서버(이 Mac의 ~/.mcp.json)를 꺼 둔다.
  const env = testEnv(dir, { PATH: '/usr/bin:/bin', KCT_WORKDIR: work, BROWSER: '/usr/bin/true' }, { trustedPaths: [work] });
  delete env.KCT_CLAUDE_PATH;
  // 서버 명령은 실행되지 않는다(쓸지 묻는 창에서 고르지 않으므로). 혹시 몰라 아무것도 안 하는 /usr/bin/false로 둔다.
  fs.writeFileSync(path.join(parent, '.mcp.json'),
    JSON.stringify({ mcpServers: { 'demo-server': { command: '/usr/bin/false', args: [] } } }, null, 2));
  const before = { mcpJson: fileStamp(REAL_MCP_JSON), repoLocal: fileStamp(REPO_LOCAL_SETTINGS) };
  const h = await launchApp(dir, env);
  const failures = [];
  let claudePids = [];
  let closed = false;
  try {
    const { page } = h;
    // 1) 새 MCP 서버 창이 덮인다
    await waitTerm(page, (s) => s.includes('New MCP server found in this project: demo-server') && s.includes('Enter to confirm'), 45000, '새 MCP 서버 창');
    claudePids = pgrep(path.join(h.userData, 'kct-settings.json'));
    const mcp = await waitCovered(page, (rows) => [
      { what: '"New MCP server found" 줄', row: rowOf(rows, /New MCP server found in this project: demo-server$/) },
      ...paragraphRows(rows, /^\s*MCP servers may execute code/).map((row) => ({ what: `경고 문단(${row}번 줄)`, row })),
      { what: '고르기 "Use this MCP server"', row: rowOf(rows, /Use this MCP server$/), keep: LEAD_KEEP },
      { what: '고르기 "Use this and all future …"', row: rowOf(rows, /Use this and all future MCP servers in this project$/), keep: LEAD_KEEP },
      { what: '고르기 "Continue without …"(기본 선택)', row: rowOf(rows, /Continue without using this MCP server$/), keep: LEAD_KEEP },
      { what: '"Enter to confirm" 줄', row: rowOf(rows, /^\s*Enter to confirm · Esc to cancel$/) },
    ], 5000);
    await shotOverlay(h, 'real-mcp-01-dialog');
    collectCover(failures, mcp, '새 MCP 서버 창');

    // 2) 기본 선택(Continue without using this MCP server)으로 넘어간다. 사람처럼 창을 읽을 틈을 둔 뒤 Enter를 친다
    //    (창이 그려지자마자 친 Enter를 claude가 놓쳐 30초 동안 창이 그대로인 적이 있었다. 원인은 확인하지 못했다).
    await page.focus('#terminal .xterm-helper-textarea');
    await sleep(1000);
    await page.keyboard.press('Enter');
    await waitTerm(page, (s) => isReady(s) && !s.includes('New MCP server found'), 30000, '입력 대기');
    const ready = await waitCovered(page, readyLines, 5000);
    await shotOverlay(h, 'real-mcp-02-ready');
    collectCover(failures, ready, 'MCP 창 뒤 입력 대기');
    const local = JSON.parse(fs.readFileSync(path.join(parent, '.claude', 'settings.local.json'), 'utf8'));
    fs.writeFileSync(path.join(dir, 'parent-settings.local.json'), `${JSON.stringify(local, null, 2)}\n`);
    assert.deepEqual(local.disabledMcpjsonServers, ['demo-server'], '연결 없이 계속하기로 기록돼야 합니다');
    assert.ok(!(local.enabledMcpjsonServers || []).includes('demo-server'));
    assertNoAppErrors(h);
  } finally {
    closed = await closeApp(h);
  }
  assert.ok(closed, '창을 닫으면 앱이 스스로 끝나야 합니다');
  await assertNoProcesses(h, claudePids);
  assert.deepEqual(fileStamp(REAL_MCP_JSON), before.mcpJson, '실제 ~/.mcp.json이 바뀌었습니다');
  assert.deepEqual(fileStamp(REPO_LOCAL_SETTINGS), before.repoLocal, '저장소의 .claude/settings.local.json이 바뀌었습니다');
  assert.deepEqual(failures, [], '덮여야 하는 줄이 덮이지 않았습니다');
});

// 사용자가 붙여 넣은 화면을 차례로 그리는 가짜 claude. 'n'을 받을 때마다 다음 화면을 그린다(처음에는 빈 화면).
// 커서는 화면 글 아래 빈 줄에 둔다(커서 줄은 덮지 않는 약속이라 화면 글과 겹치지 않게).
function writeScreensFake(file, screenFiles) {
  fs.writeFileSync(file, `'use strict';
const fs = require('fs');
if (process.argv.includes('--version')) { process.stdout.write('2.1.299 (Claude Code)\\n'); process.exit(0); }
const screens = ${JSON.stringify(screenFiles)}.map((f) => fs.readFileSync(f, 'utf8').replace(/\\s+$/, ''));
let i = -1;
const draw = () => process.stdout.write('\\x1b[2J\\x1b[H' + screens[i].replace(/\\n/g, '\\r\\n') + '\\r\\n');
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.on('data', (d) => {
  if (String(d).includes('n') && i < screens.length - 1) { i += 1; draw(); }
});
process.stdout.write('\\x1b[2J\\x1b[H'); // 떴다는 표시(시험은 pty 출력에서 이것을 기다린다)
`);
}

test('사용자가 붙여 넣은 화면(신뢰 창, 새 MCP 서버 창, 머리말·로그인 만료·회사 안내·조직 정책 줄)을 앱에 그리면 기대한 줄이 덮인다', { timeout: 120000 }, async () => {
  const dir = freshDir('user-screens', OUT12);
  const names = ['01-trust', '02-mcp-new-server', '03-header-team'];
  const script = path.join(dir, 'fake-user-screens.js');
  writeScreensFake(script, names.map((n) => path.join(USER_SCREENS, 'user', `${n}.txt`)));
  const env = testEnv(dir, { KCT_CLAUDE_PATH: script, KCT_WORKDIR: path.join(dir, 'work') });
  const h = await launchApp(dir, env);
  const failures = [];
  let closed = false;
  try {
    const { page } = h;
    const wants = names.map((name) => JSON.parse(fs.readFileSync(path.join(USER_SCREENS, `user-${name}.expected.json`), 'utf8')));
    // 사용자 화면은 120칸까지 넓었다. 터미널이 그보다 좁으면 긴 줄이 터미널에서 단어 중간에 접히므로 창을 넓힌다.
    const needCols = Math.max(...wants.map((w) => w.cols));
    await h.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1700, 820));
    await page.waitForFunction((n) => Number(document.getElementById('kct-overlay').dataset.cols) >= n, needCols, { timeout: 5000 });
    await page.waitForFunction(() => window.__ptyTap.includes('\x1b[2J'), null, { timeout: 15000 });
    for (const [i, name] of names.entries()) {
      const want = wants[i];
      const first = fs.readFileSync(path.join(USER_SCREENS, 'user', `${name}.txt`), 'utf8').split('\n')[0].trim();
      await page.focus('#terminal .xterm-helper-textarea');
      await page.keyboard.type('n');
      await waitTerm(page, (s) => s.split('\n')[0].trim() === first, 10000, `사용자 화면 ${name}`);
      const result = await waitCovered(page, () => want.mustCover.map((row) => ({ what: `${row}번 줄`, row })), 5000);
      const st = await shotOverlay(h, `user-${name}`);
      collectCover(failures, result, `사용자 화면 ${name}`);
      for (const row of want.mustNotCover) {
        if (touching(st, row).length) failures.push(`사용자 화면 ${name} · 덮으면 안 되는 ${row}번 줄이 덮였습니다\n${overlayTable(st)}`);
      }
    }
    assertNoAppErrors(h);
  } finally {
    closed = await closeApp(h);
  }
  assert.ok(closed, '창을 닫으면 앱이 스스로 끝나야 합니다');
  await assertNoProcesses(h);
  assert.deepEqual(failures, [], '사용자 화면에서 기대와 다르게 덮였습니다');
});

test('실제 ~/.claude/settings.json 수정 시각이 그대로이고, 실제 ~/.claude.json projects에 이 앱 경로가 없다', () => {
  const report = { settings: REAL_SETTINGS, mtimeAtLoad: SETTINGS_MTIME_AT_LOAD };
  if (SETTINGS_MTIME_AT_LOAD !== null) {
    const now = mtimeSec(REAL_SETTINGS);
    report.mtimeNow = now;
    assert.equal(now, SETTINGS_MTIME_AT_LOAD, '시험하는 동안 ~/.claude/settings.json이 바뀌었습니다');
    if (process.env.KCT_T9_SETTINGS_MTIME) {
      report.mtimeGiven = Number(process.env.KCT_T9_SETTINGS_MTIME);
      assert.equal(now, report.mtimeGiven, 'workflow 시작 때의 수정 시각과 다릅니다');
    }
    if (process.env.KCT_T9_WORKFLOW_START) {
      const raw = process.env.KCT_T9_WORKFLOW_START;
      const start = /^\d+$/.test(raw) ? Number(raw) : Math.floor(Date.parse(raw) / 1000);
      report.workflowStart = start;
      assert.ok(Number.isFinite(start), `KCT_T9_WORKFLOW_START를 읽지 못했습니다: ${raw}`);
      assert.ok(now < start, '~/.claude/settings.json이 workflow 시작 뒤에 바뀌었습니다');
    }
  }
  // 다른 Claude Code 세션이 동시에 쓰는 중이면 깨진 JSON을 읽을 수 있어 몇 번 다시 읽는다.
  let keys = null;
  for (let i = 0; i < 5 && keys === null; i++) {
    try { keys = Object.keys(JSON.parse(fs.readFileSync(REAL_CLAUDE_JSON, 'utf8')).projects || {}); } catch (e) {
      if (e.code === 'ENOENT') keys = [];
    }
  }
  assert.ok(keys, '~/.claude.json을 읽지 못했습니다');
  report.appKeys = keys.filter((k) => k.includes('korean-claude-terminal/app') || k.includes('.test-tmp'));
  report.projectCount = keys.length;
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'real-config-check.json'), JSON.stringify(report, null, 2));
  assert.deepEqual(report.appKeys, [], '실제 ~/.claude.json에 이 앱 경로가 생겼습니다');
});
