// T6 영어 화면 안내: 실제 claude로 하는 시험과 시험 자료 캡처.
//
//   node test/screenGuide.live.js            안내 버튼의 키를 실제 claude에 보내 다음 화면으로 넘어가는지 본다.
//                                            tmux로 7가지, 앱과 같은 node-pty + @xterm/headless로 1가지.
//                                            전후 화면과 결과는 .test-tmp/T6/live/에 남는다.
//   node test/screenGuide.live.js --capture  시험 자료(test/fixtures/screens/)를 실제 claude에서 다시 캡처한다.
//
// 공통 규칙
// - 실제 ~/.claude, ~/.claude.json은 건드리지 않는다. 모두 fakeClaudeHome의 가짜 설정 폴더와 가짜 키로 띄운다.
//   끝에 실제 ~/.claude.json의 projects와 ~/.claude/settings.json 수정 시각이 그대로인지 확인한다.
// - 실제 모델을 부르지 않는다. 키가 없거나(로그인 안 됨) 가짜 키라서 요청이 인증 오류로 끝난다.
// - 로그인 방법 화면에서 Enter를 누르면 claude가 브라우저를 열려고 한다. BROWSER=/usr/bin/true로 두어
//   실제 브라우저가 열리지 않게 한다(claude는 BROWSER 값이 있으면 그 명령으로 주소를 연다).
// - tmux는 작업마다 고유한 -L 소켓을 쓰고 끝나면 kill-server 한다.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { createFakeClaudeHome } = require('./helpers/fakeClaudeHome');
const tmux = require('./helpers/tmux');
const { detectScreen } = require('../src/main/screenGuide');

const APP_DIR = path.resolve(__dirname, '..');
const REPO = path.resolve(APP_DIR, '..');
const OUT = path.join(APP_DIR, '.test-tmp', 'T6');
const FIXTURES = path.join(__dirname, 'fixtures', 'screens');
const RB_CAPS = path.join(REPO, 'review', 'hook', 'runs', 'rB', 'caps');
const EXPECT_VERSION = '2.1.296';
const SANITIZED_HOME = '/Users/tester';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 실제 claude ──

function findRealClaude() {
  const candidates = [path.join(os.homedir(), '.local', 'bin', 'claude')];
  for (const d of (process.env.PATH || '').split(path.delimiter)) candidates.push(path.join(d, 'claude'));
  return candidates.find((p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } }) || null;
}

function claudeVersion(bin) {
  return execFileSync(bin, ['--version'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: os.homedir() } }).trim();
}

// ── tmux로 claude 띄우기 ──

const handles = [];
let launches = 0;

function launch(dir, { onboarded = true, withKey = true, approveKey = true, trusted = false, cols = 120, rows = 36, command, args = [] } = {}) {
  fs.rmSync(dir, { recursive: true, force: true });
  const work = path.join(dir, 'work');
  fs.mkdirSync(work, { recursive: true });
  const fake = createFakeClaudeHome({ dir: path.join(dir, 'home'), trustedPaths: trusted ? [work] : [], onboarded, withKey, approveKey });
  const env = { ...fake.env, BROWSER: '/usr/bin/true' };
  // 소켓 경로가 길면(macOS 104바이트 제한) tmux가 못 연다. 이름을 짧게 둔다.
  const socket = `kctT6-${process.pid}-${++launches}`;
  const h = tmux.start({ socket, command: command || CLAUDE, args, cwd: work, env, cols, rows });
  handles.push(h);
  return { h, work, fake, launchInfo: { onboarded, withKey, approveKey, trusted, cols, rows } };
}

// 앱(T9)과 같은 길: node-pty로 띄우고 출력을 @xterm/headless에 그려 화면 글을 읽는다.
// 돌려주는 핸들은 tmux 핸들과 같은 capture/isDead/kill에 write가 더 있다.
function launchHeadless(dir, { onboarded = true, withKey = true, approveKey = true, trusted = false, cols = 100, rows = 30 } = {}) {
  const pty = require('node-pty');
  const { Terminal } = require('@xterm/headless');
  fs.rmSync(dir, { recursive: true, force: true });
  const work = path.join(dir, 'work');
  fs.mkdirSync(work, { recursive: true });
  const fake = createFakeClaudeHome({ dir: path.join(dir, 'home'), trustedPaths: trusted ? [work] : [], onboarded, withKey, approveKey });
  const env = { ...fake.env, BROWSER: '/usr/bin/true', TERM: 'xterm-256color', COLORTERM: 'truecolor' };
  const term = new Terminal({ cols, rows, allowProposedApi: true });
  const p = pty.spawn(CLAUDE, [], { name: 'xterm-256color', cols, rows, cwd: work, env });
  let dead = false;
  p.onData((d) => term.write(d));
  p.onExit(() => { dead = true; });
  term.onData((d) => { if (!dead) p.write(d); }); // 터미널 질의에 대한 답을 돌려준다(화면의 xterm.js와 같게)
  const screen = () => {
    const b = term.buffer.active;
    const out = [];
    for (let i = 0; i < term.rows; i++) {
      const line = b.getLine(b.viewportY + i);
      out.push(line ? line.translateToString(true) : '');
    }
    return out.join('\n');
  };
  const h = {
    pid: p.pid,
    capture(file) {
      const t = screen();
      if (file) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, t); }
      return t;
    },
    isDead: () => dead,
    write: (k) => p.write(k),
    kill() {
      if (!dead) { try { p.kill(); } catch { /* 이미 끝남 */ } }
      term.dispose();
    },
  };
  handles.push(h);
  return { h, work, fake };
}

// tmux send-keys -H: 안내 버튼의 keys를 바이트 그대로 한 번에 보낸다(앱이 pty에 쓰는 것과 같게).
// node-pty 핸들이면 pty에 그대로 쓴다.
function sendBytes(h, keys) {
  if (h.write) { h.write(keys); return; }
  const hex = [...Buffer.from(keys, 'utf8')].map((b) => b.toString(16).padStart(2, '0'));
  const env = { ...process.env, TMUX_TMPDIR: h.tmpDir };
  delete env.TMUX;
  delete env.TMUX_PANE;
  execFileSync(tmux.findTmux(), ['-L', h.socket, 'send-keys', '-t', `${h.session}:0.0`, '-H', ...hex], { env, stdio: 'ignore' });
}

const RULE = /^\s*─{8,}\s*$/;
function isIdle(text) {
  const lines = text.split('\n').map((l) => l.replace(/\u00a0/g, ' '));
  return lines.some((l, i) => i > 0 && /^❯(\s|$)/.test(l) && RULE.test(lines[i - 1]));
}

async function waitScreen(h, pred, what, timeoutMs = 30000) {
  const end = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < end) {
    try { last = h.capture(); } catch { /* 아직 준비 안 됨 */ }
    if (pred(last)) {
      await sleep(400); // 다 그려질 때까지 잠깐 더 기다린다
      try { last = h.capture(); } catch { /* 끝남 */ }
      if (pred(last)) return last;
    }
    if (h.isDead() && !pred(last)) break;
    await sleep(200);
  }
  const err = new Error(`${what}: ${timeoutMs}ms 안에 기대한 화면이 나오지 않았습니다\n--- 마지막 화면 ---\n${last}`);
  err.screen = last;
  throw err;
}

// tmux 실행이 실패하면 오류 문구에 pane 환경 변수 전체(비밀 키 포함)가 들어 있다. 기록에 남기기 전에 지운다.
const redact = (s) => String(s)
  .replace(/\/usr\/bin\/env -i [\s\S]*? (\/\S+)(\n|$)/g, '/usr/bin/env -i <환경 변수 생략> $1$2')
  .replace(/\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*)=\S+/g, '$1=<생략>');

const keysHex = (k) => [...Buffer.from(k, 'utf8')].map((b) => b.toString(16).padStart(2, '0')).join(' ');
const shown = (k) => JSON.stringify(k);

// ── 실제 설정 지키기 ──

function realState() {
  const file = path.join(os.homedir(), '.claude.json');
  let keys = [];
  for (let i = 0; i < 5; i++) {
    try { keys = Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).projects || {}); break; } catch (e) {
      if (e.code === 'ENOENT') break; // 다른 Claude Code 세션이 쓰는 중이면 다시 읽는다
    }
  }
  let settingsMtime = null;
  try { settingsMtime = fs.statSync(path.join(os.homedir(), '.claude', 'settings.json')).mtimeMs; } catch { /* 없음 */ }
  return { keys, settingsMtime };
}

const isOurs = (k) => k.includes('.test-tmp') || k.includes('korean-claude-terminal');

// ── 시험 자료 캡처(--capture) ──

const sanitize = (text) => text.split(os.homedir()).join(SANITIZED_HOME).replace(/\s+$/, '') + '\n';

async function capture() {
  const version = claudeVersion(CLAUDE);
  const base = path.join(OUT, 'cap');
  fs.mkdirSync(FIXTURES, { recursive: true });
  const real = [];
  const save = (file, text, expect, info) => {
    fs.writeFileSync(path.join(FIXTURES, file), sanitize(text));
    real.push({ file, expect, source: 'real', ...info });
    const got = detectScreen(text);
    console.log(`${file}: 기대 ${expect} / detectScreen ${got ? got.id : null}`);
  };
  const keyNote = (keys) => keys.map((k) => ({ keys: k, hex: keysHex(k) }));

  // 1. 첫 실행(온보딩 안 함, 키 없음): 테마 → 로그인 방법 → 브라우저 로그인 대기
  {
    const { h, launchInfo } = launch(path.join(base, 'first-run'), { onboarded: false, withKey: false });
    const s1 = await waitScreen(h, (t) => /Choose the text style/.test(t), '테마 화면');
    save('theme.txt', s1, 'theme', { note: '첫 실행 테마 고르기(온보딩 안 함, 키 없음)', launch: launchInfo, before: [] });
    sendBytes(h, '\r');
    const s2 = await waitScreen(h, (t) => /Select login method:/.test(t), '로그인 방법 화면');
    save('login-method.txt', s2, 'login-method', { note: '로그인 방법 고르기(테마에서 Enter)', launch: launchInfo, before: keyNote(['\r']) });
    sendBytes(h, '\r');
    const s3 = await waitScreen(h, (t) => /Paste code here if prompted/.test(t), '브라우저 로그인 대기 화면');
    save('login-browser.txt', s3, 'login-method', { note: '구독 계정 로그인을 고른 뒤 브라우저 로그인 대기(가짜 설정으로 갈 수 있는 끝)', launch: launchInfo, before: keyNote(['\r', '\r']) });
    h.kill();
  }
  // 2. 첫 실행(가짜 키 있음, 승인 안 함): 테마 → 키를 쓸지 묻기
  {
    const { h, launchInfo } = launch(path.join(base, 'key-unapproved'), { onboarded: false, approveKey: false });
    await waitScreen(h, (t) => /Choose the text style/.test(t), '테마 화면');
    sendBytes(h, '\r');
    const s = await waitScreen(h, (t) => /Do you want to use this API key\?/.test(t), '키 승인 화면');
    save('api-key.txt', s, 'api-key', { note: '가짜 키를 쓸지 묻기(키 미승인, 테마에서 Enter)', launch: launchInfo, before: keyNote(['\r']) });
    h.kill();
  }
  // 3. 첫 실행(가짜 키 승인됨): 테마 → 주의 사항(Enter로 넘기기)
  {
    const { h, launchInfo } = launch(path.join(base, 'key-approved'), { onboarded: false });
    await waitScreen(h, (t) => /Choose the text style/.test(t), '테마 화면');
    sendBytes(h, '\r');
    const s = await waitScreen(h, (t) => /Press Enter to continue/.test(t), '주의 사항 화면');
    save('press-enter.txt', s, 'press-enter', { note: '주의 사항 뒤 Enter로 넘기기(키 승인됨, 테마에서 Enter)', launch: launchInfo, before: keyNote(['\r']) });
    h.kill();
  }
  // 4. 믿지 않는 폴더(온보딩 끝남, 가짜 키 승인됨): 폴더 신뢰 창. 120칸과 80칸
  for (const [name, cols, rows] of [['trust.txt', 120, 36], ['trust-80cols.txt', 80, 30]]) {
    const { h, launchInfo } = launch(path.join(base, `untrusted-${cols}`), { cols, rows });
    const s = await waitScreen(h, (t) => /Yes, I trust this folder/.test(t), '신뢰 창');
    save(name, s, 'trust', { note: `폴더 신뢰 창(믿지 않는 폴더, ${cols}칸)`, launch: launchInfo, before: [] });
    h.kill();
  }
  // 5. 믿는 폴더: 입력 대기 → 요청 → 가짜 키라 인증 오류
  {
    const { h, launchInfo } = launch(path.join(base, 'trusted'), { trusted: true });
    const s1 = await waitScreen(h, (t) => isIdle(t) && /for shortcuts/.test(t), '입력 대기');
    save('idle.txt', s1, null, { note: '입력 대기(정상, 믿는 폴더)', launch: launchInfo, before: [] });
    sendBytes(h, '안녕하세요');
    await sleep(500);
    sendBytes(h, '\r');
    const s2 = await waitScreen(h, (t) => /Invalid API key/.test(t) && isIdle(t), '인증 오류');
    save('auth-error.txt', s2, 'auth-error', { note: '요청 뒤 인증 오류(가짜 키라 Invalid API key)', launch: launchInfo, before: keyNote(['안녕하세요', '\r']) });
    h.kill();
  }
  // 6. 로그인 안 한 상태(온보딩 끝남, 키 없음): 입력 대기 → 요청 → "Not logged in" → /login
  {
    const { h, launchInfo } = launch(path.join(base, 'logged-out'), { trusted: true, withKey: false });
    const s1 = await waitScreen(h, (t) => isIdle(t) && /Not logged in/.test(t), '로그인 안 됨 입력 대기');
    save('auth-logged-out-idle.txt', s1, 'auth-error', { note: '로그인 안 한 입력 대기(아래 줄에 Not logged in)', launch: launchInfo, before: [] });
    sendBytes(h, '안녕하세요');
    await sleep(500);
    sendBytes(h, '\r');
    const s2 = await waitScreen(h, (t) => /Not logged in · Please run \/login/.test(t) && isIdle(t), '로그인 안 됨 오류');
    save('auth-logged-out.txt', s2, 'auth-error', { note: '로그인 안 한 상태에서 요청(모델 요청 없이 바로 오류)', launch: launchInfo, before: keyNote(['안녕하세요', '\r']) });
    sendBytes(h, '/login\r');
    const s3 = await waitScreen(h, (t) => /Select login method:/.test(t), '/login 화면');
    save('login-method-slash.txt', s3, 'login-method', { note: '/login으로 연 로그인 방법 고르기', launch: launchInfo, before: keyNote(['안녕하세요', '\r', '/login\r']) });
    h.kill();
  }
  // 7. claude가 아닌 실제 프로그램 출력(안내가 뜨면 안 되는 화면)
  for (const [file, command, args, cols, rows] of [
    ['other-claude-help.txt', CLAUDE, ['--help'], 120, 50],
    ['other-ls-root.txt', '/bin/ls', ['-1', '/'], 100, 30],
  ]) {
    const { h } = launch(path.join(base, path.basename(file, '.txt')), { cols, rows, command, args });
    const s = await waitScreen(h, () => h.isDead(), `${path.basename(command)} 끝남`, 15000);
    const shownCommand = `${command === CLAUDE ? 'claude' : command} ${args.join(' ')}`;
    save(file, s.replace(/\n*Pane is dead.*\n?/, '\n'), null, { note: `claude 화면이 아닌 프로그램 출력(${shownCommand})`, launch: { command: shownCommand, cols, rows }, before: [] });
    h.kill();
  }

  // 훅 시험 때 실제 claude 2.1.296에서 캡처한 허락 창과 일이 끝난 화면(review/hook/runs/rB/caps/)
  const rb = [
    ['permission-write.txt', '10-write-hook-holding-2s.txt', 'permission', '파일 만들기 허락 창'],
    ['permission-bash.txt', '60-bash-always-holding.txt', 'permission', '명령 실행 허락 창(선택지 4개)'],
    ['idle-after-work.txt', '12-write-after-hook-allow-2s.txt', null, '일을 마친 뒤 입력 대기'],
    ['idle-hook-errors.txt', '99-before-kill.txt', null, '훅 오류 줄(⎿ connect ECONNREFUSED)이 남은 입력 대기'],
  ];
  const copied = [];
  for (const [file, src, expect, note] of rb) {
    const text = fs.readFileSync(path.join(RB_CAPS, src), 'utf8');
    fs.writeFileSync(path.join(FIXTURES, file), sanitize(text));
    copied.push({ file, expect, source: 'rB', note, from: `review/hook/runs/rB/caps/${src}` });
    const got = detectScreen(text);
    console.log(`${file}: 기대 ${expect} / detectScreen ${got ? got.id : null}`);
  }

  // 손으로 만든 자료는 manifest에 적힌 것을 그대로 둔다.
  const manifestPath = path.join(FIXTURES, 'manifest.json');
  let synthetic = [];
  try { synthetic = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).screens.filter((s) => s.source === 'synthetic'); } catch { /* 처음 */ }
  const manifest = {
    claudeVersion: version,
    capturedAt: new Date().toISOString(),
    command: 'cd app && node test/screenGuide.live.js --capture',
    how: 'fakeClaudeHome(가짜 CLAUDE_CONFIG_DIR, 가짜 키) + tmux(-L 고유 소켓, -u). env에 BROWSER=/usr/bin/true. keys는 tmux send-keys -H로 바이트 그대로 보냄. 홈 폴더 경로는 /Users/tester로 바꾸고 끝의 빈 줄은 뺐음.',
    screens: [...real, ...copied, ...synthetic],
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`\n${real.length}개 캡처, ${copied.length}개 복사, 손으로 만든 것 ${synthetic.length}개 → ${path.relative(APP_DIR, manifestPath)}`);
  if (!version.startsWith(EXPECT_VERSION)) console.log(`주의: claude 버전이 ${version}입니다(기대 ${EXPECT_VERSION})`);
}

// ── 키 넘김 시험(기본) ──

async function live() {
  const base = path.join(OUT, 'live');
  fs.rmSync(base, { recursive: true, force: true });
  fs.mkdirSync(base, { recursive: true });
  const results = [];
  const logLines = [];
  const log = (s) => { logLines.push(s); console.log(s); };

  // 한 단계: 지금 화면을 detectScreen에 넣고, 기대한 id인지 보고, 고른 버튼의 keys를 보내고, 다음 화면을 기다린다.
  async function step(h, dir, n, { expectId, pick = (g) => g.actions.find((a) => a.primary), next, nextWhat }) {
    const before = h.capture(path.join(dir, `${n}-before.txt`));
    const g = detectScreen(before);
    if (!g || g.id !== expectId) throw new Error(`${n}: detectScreen이 ${g ? g.id : null}을 냈습니다(기대 ${expectId})\n${before}`);
    const action = pick(g);
    if (!action) throw new Error(`${n}: 누를 버튼이 없습니다 ${JSON.stringify(g.actions)}`);
    sendBytes(h, action.keys);
    const after = await waitScreen(h, next, `${n} → ${nextWhat}`);
    fs.writeFileSync(path.join(dir, `${n}-after.txt`), after);
    const afterGuide = detectScreen(after);
    log(`  ${n}: [${g.id}] "${g.title}" → 버튼 "${action.label}" keys=${shown(action.keys)} (${keysHex(action.keys)}) → ${nextWhat} (다음 안내: ${afterGuide ? afterGuide.id : 'null'})`);
    return { before, guide: g, action, after, afterGuide };
  }

  async function check(name, title, fn) {
    const dir = path.join(base, name);
    log(`■ ${name}: ${title}`);
    const started = Date.now();
    try {
      const extra = await fn(dir);
      results.push({ name, title, ok: true, ms: Date.now() - started, ...(extra || {}) });
      log(`  → 통과 (${Date.now() - started}ms)`);
    } catch (e) {
      const msg = redact(e.message);
      results.push({ name, title, ok: false, error: msg.split('\n')[0] });
      log(`  → 실패: ${msg}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'error.txt'), redact(e.stack || e));
    } finally {
      for (const h of handles.splice(0)) h.kill();
    }
  }

  const realBefore = realState();
  const version = claudeVersion(CLAUDE);
  log(`claude: ${CLAUDE} (${version})`);

  await check('trust-yes', '신뢰 창의 기본 버튼 → 입력 대기, 가짜 설정에 신뢰가 기록됨', async (dir) => {
    const { h, work, fake } = launch(path.join(dir, 'run'));
    await waitScreen(h, (t) => /Yes, I trust this folder/.test(t), '신뢰 창');
    const r = await step(h, dir, '01-trust', { expectId: 'trust', next: (t) => isIdle(t) && !/trust this folder/.test(t), nextWhat: '입력 대기' });
    if (r.afterGuide !== null) throw new Error(`입력 대기 화면인데 안내가 ${r.afterGuide.id}입니다`);
    const real = fs.realpathSync(work);
    let trusted = [];
    for (let i = 0; i < 25 && trusted.length === 0; i++) {
      await sleep(200);
      try {
        const j = JSON.parse(fs.readFileSync(fake.claudeJsonPath, 'utf8'));
        trusted = Object.entries(j.projects || {}).filter(([k, v]) => v.hasTrustDialogAccepted && (real === k || real.startsWith(`${k}/`))).map(([k]) => k);
      } catch { /* claude가 쓰는 중 */ }
    }
    if (!trusted.length) throw new Error('가짜 .claude.json에 신뢰 기록이 없습니다');
    log(`  가짜 .claude.json의 신뢰 기록: ${trusted.map((k) => k.split(os.homedir()).join('~')).join(', ')}`);
    return { trustedRecordedFor: trusted.map((k) => k.split(os.homedir()).join('~')) };
  });

  await check('trust-no', "신뢰 창의 '아니요, 닫기' → claude가 끝남", async (dir) => {
    const { h } = launch(path.join(dir, 'run'));
    await waitScreen(h, (t) => /Yes, I trust this folder/.test(t), '신뢰 창');
    await step(h, dir, '01-trust', {
      expectId: 'trust', pick: (g) => g.actions.find((a) => !a.primary), next: () => h.isDead(), nextWhat: 'claude 끝남',
    });
  });

  await check('first-run', '테마 기본 버튼 → 로그인 방법, 로그인 방법 기본 버튼 → 브라우저 로그인 대기(가짜 설정으로 갈 수 있는 끝)', async (dir) => {
    const { h } = launch(path.join(dir, 'run'), { onboarded: false, withKey: false });
    await waitScreen(h, (t) => /Choose the text style/.test(t), '테마 화면');
    await step(h, dir, '01-theme', { expectId: 'theme', next: (t) => /Select login method:/.test(t), nextWhat: '로그인 방법 화면' });
    const r = await step(h, dir, '02-login-method', { expectId: 'login-method', next: (t) => /Paste code here if prompted/.test(t), nextWhat: '브라우저 로그인 대기 화면' });
    if (!r.afterGuide || r.afterGuide.id !== 'login-method') throw new Error('브라우저 로그인 대기 화면을 login-method로 알아보지 못했습니다');
  });

  await check('theme-move', '테마 목록에서 커서를 옮긴 뒤에도 "밝은 화면" 버튼이 Light mode를 고름', async (dir) => {
    const { h, fake } = launch(path.join(dir, 'run'), { onboarded: false, withKey: false });
    await waitScreen(h, (t) => /Choose the text style/.test(t), '테마 화면');
    sendBytes(h, '\x1b[B\x1b[B\x1b[B'); // 커서를 아래로 세 칸(Dark → Light → Dark 색약용 → Light 색약용)
    await waitScreen(h, (t) => /❯ +Light mode \(colorblind/.test(t), '커서 이동');
    await step(h, dir, '01-theme', {
      expectId: 'theme', pick: (g) => g.actions.find((a) => a.label === '밝은 화면'), next: (t) => /Select login method:/.test(t), nextWhat: '로그인 방법 화면',
    });
    const settings = JSON.parse(fs.readFileSync(path.join(fake.configDir, 'settings.json'), 'utf8'));
    if (settings.theme !== 'light') throw new Error(`가짜 settings.json의 theme이 ${settings.theme}입니다(기대 light)`);
    log('  가짜 settings.json theme = light');
  });

  await check('api-key', '키 승인 화면 기본 버튼(쓰지 않기) → 로그인 방법', async (dir) => {
    const { h, fake } = launch(path.join(dir, 'run'), { onboarded: false, approveKey: false });
    await waitScreen(h, (t) => /Choose the text style/.test(t), '테마 화면');
    await step(h, dir, '01-theme', { expectId: 'theme', next: (t) => /Do you want to use this API key\?/.test(t), nextWhat: '키 승인 화면' });
    await step(h, dir, '02-api-key', { expectId: 'api-key', next: (t) => /Select login method:/.test(t), nextWhat: '로그인 방법 화면' });
    const j = JSON.parse(fs.readFileSync(fake.claudeJsonPath, 'utf8'));
    if (!(j.customApiKeyResponses && j.customApiKeyResponses.rejected.length === 1)) throw new Error('가짜 설정에 키 거절이 기록되지 않았습니다');
  });

  await check('onboarding', '주의 사항(Enter) → 신뢰 창 → 입력 대기까지 안내 버튼만으로 넘어감', async (dir) => {
    const { h } = launch(path.join(dir, 'run'), { onboarded: false });
    await waitScreen(h, (t) => /Choose the text style/.test(t), '테마 화면');
    await step(h, dir, '01-theme', { expectId: 'theme', next: (t) => /Press Enter to continue/.test(t), nextWhat: '주의 사항 화면' });
    await step(h, dir, '02-press-enter', { expectId: 'press-enter', next: (t) => /Yes, I trust this folder/.test(t), nextWhat: '신뢰 창' });
    const r = await step(h, dir, '03-trust', { expectId: 'trust', next: (t) => isIdle(t) && !/trust this folder/.test(t), nextWhat: '입력 대기' });
    if (r.afterGuide !== null) throw new Error(`입력 대기 화면인데 안내가 ${r.afterGuide.id}입니다`);
  });

  await check('logged-out', "로그인 안 됨 안내의 '로그인하기' → 로그인 방법 화면", async (dir) => {
    const { h } = launch(path.join(dir, 'run'), { trusted: true, withKey: false });
    await waitScreen(h, (t) => isIdle(t) && /Not logged in/.test(t), '로그인 안 됨 입력 대기');
    await step(h, dir, '01-auth-error', { expectId: 'auth-error', next: (t) => /Select login method:/.test(t), nextWhat: '로그인 방법 화면' });
  });

  await check('headless', '앱과 같은 길(node-pty + @xterm/headless 화면, pty.write로 키)로도 테마 → 주의 사항 → 신뢰 창 → 입력 대기', async (dir) => {
    const { h } = launchHeadless(path.join(dir, 'run'), { onboarded: false });
    await waitScreen(h, (t) => /Choose the text style/.test(t), '테마 화면');
    await step(h, dir, '01-theme', { expectId: 'theme', next: (t) => /Press Enter to continue/.test(t), nextWhat: '주의 사항 화면' });
    await step(h, dir, '02-press-enter', { expectId: 'press-enter', next: (t) => /Yes, I trust this folder/.test(t), nextWhat: '신뢰 창' });
    const r = await step(h, dir, '03-trust', { expectId: 'trust', next: (t) => isIdle(t) && !/trust this folder/.test(t), nextWhat: '입력 대기' });
    if (r.afterGuide !== null) throw new Error(`입력 대기 화면인데 안내가 ${r.afterGuide.id}입니다`);
    const pid = h.pid;
    h.kill();
    const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
    for (let i = 0; i < 50 && alive(); i++) await sleep(100);
    if (alive()) throw new Error(`claude(${pid})가 끝나지 않았습니다`);
  });

  for (const h of handles.splice(0)) h.kill();

  // 실제 설정이 그대로인지
  await sleep(500);
  const realAfter = realState();
  const newKeys = realAfter.keys.filter((k) => isOurs(k) && !realBefore.keys.includes(k));
  const ours = realAfter.keys.filter(isOurs);
  const settingsSame = realBefore.settingsMtime === realAfter.settingsMtime;
  const realOk = newKeys.length === 0 && ours.length === 0 && settingsSame;
  log(`■ 실제 설정: ~/.claude.json projects ${realAfter.keys.length}개 중 시험 폴더 ${ours.length}개(새로 생긴 것 ${newKeys.length}개), ~/.claude/settings.json 수정 시각 ${settingsSame ? '그대로' : '바뀜'}`);
  results.push({ name: 'real-config', title: '실제 ~/.claude.json에 시험 폴더가 없고 settings.json이 그대로', ok: realOk, newKeys, ours, settingsMtime: realAfter.settingsMtime });

  const ok = results.every((r) => r.ok);
  const summary = { claude: version, finishedAt: new Date().toISOString(), ok, results };
  fs.writeFileSync(path.join(base, 'result.json'), `${JSON.stringify(summary, null, 2)}\n`);
  fs.writeFileSync(path.join(base, 'result.txt'), `${logLines.join('\n')}\n\n${ok ? '모두 통과' : '실패 있음'}\n`);
  log(`\n${ok ? '모두 통과' : '실패 있음'} → ${path.relative(APP_DIR, path.join(base, 'result.txt'))}`);
  return ok;
}

// ── 시작 ──

const CLAUDE = findRealClaude();

async function main() {
  if (!CLAUDE) { console.error('실제 claude를 찾지 못했습니다'); return false; }
  if (!tmux.findTmux()) { console.error('tmux를 찾지 못했습니다'); return false; }
  fs.mkdirSync(OUT, { recursive: true });
  if (process.argv.includes('--capture')) { await capture(); return true; }
  return live();
}

const cleanup = () => { for (const h of handles.splice(0)) { try { h.kill(); } catch { /* 이미 꺼짐 */ } } };
process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });

main()
  .then((ok) => { cleanup(); process.exitCode = ok ? 0 : 1; })
  .catch((e) => { cleanup(); console.error(redact(e.stack || e)); process.exitCode = 1; });
