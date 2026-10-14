// T1 뼈대 시험: 공통 약속(contracts.js·preload.js), 의존성 고정, Electron+node-pty 연기 시험,
// 가짜 설정(fakeClaudeHome)과 tmux 도우미로 실제 claude 화면 확인.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const APP_DIR = path.resolve(__dirname, '..');
const PLAN = path.resolve(APP_DIR, '..', 'PLAN.md');
const NO_PLAN = !fs.existsSync(PLAN) && '저장소 밖 계획서(PLAN.md)가 없어 건너뜁니다(공개 저장소)';
const OUT = path.join(APP_DIR, '.test-tmp', 'T1');

const contracts = require('../src/shared/contracts');
const { createFakeClaudeHome, FAKE_API_KEY } = require('./helpers/fakeClaudeHome');
const tmux = require('./helpers/tmux');

// PLAN.md "### IPC 채널" 절에서 방향별 채널 목록을 뽑는다.
function planChannels() {
  const text = fs.readFileSync(PLAN, 'utf8');
  const pick = (label) => {
    const line = text.split('\n').find((l) => l.startsWith(`- ${label}:`));
    assert.ok(line, `PLAN.md에서 "${label}" 줄을 찾지 못했습니다`);
    return [...line.matchAll(/`([a-z]+:[a-z]+)`/g)].map((m) => m[1]);
  };
  return { toRenderer: pick('main → renderer'), toMain: pick('renderer → main') };
}

function planEnvVars() {
  const text = fs.readFileSync(PLAN, 'utf8');
  const section = text.split('### 환경 변수')[1].split('###')[0];
  return [...section.matchAll(/^- `([A-Z_]+)[`=]/gm)].map((m) => m[1]);
}

// preload.js를 가짜 electron으로 불러서 노출한 API와 채널 목록을 꺼낸다.
function loadPreload() {
  const src = fs.readFileSync(path.join(APP_DIR, 'src', 'preload.js'), 'utf8');
  const exposed = {};
  const sent = [];
  const listeners = new Map();
  const fakeElectron = {
    contextBridge: { exposeInMainWorld: (name, api) => { exposed[name] = api; } },
    ipcRenderer: {
      send: (channel, payload) => sent.push([channel, payload]),
      on: (channel, fn) => listeners.set(channel, [...(listeners.get(channel) || []), fn]),
      removeListener: (channel, fn) => listeners.set(channel, (listeners.get(channel) || []).filter((f) => f !== fn)),
    },
  };
  const fakeRequire = (name) => {
    if (name === 'electron') return fakeElectron;
    throw new Error(`preload에서 electron 말고 다른 모듈을 불렀습니다: ${name}`);
  };
  // eslint-disable-next-line no-new-func
  const lists = new Function('require', `${src}\nreturn { MAIN_TO_RENDERER, RENDERER_TO_MAIN };`)(fakeRequire);
  const emit = (channel, payload) => (listeners.get(channel) || []).forEach((fn) => fn({ sender: 'event' }, payload));
  return { api: exposed.kct, exposed, lists, sent, emit };
}

function findRealClaude() {
  const candidates = [path.join(os.homedir(), '.local', 'bin', 'claude')];
  for (const d of (process.env.PATH || '').split(path.delimiter)) candidates.push(path.join(d, 'claude'));
  return candidates.find((p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } }) || null;
}

// 다른 Claude Code 세션이 동시에 ~/.claude.json을 쓰고 있을 수 있어 몇 번 다시 읽는다.
function realProjectKeys() {
  const file = path.join(os.homedir(), '.claude.json');
  for (let i = 0; i < 5; i++) {
    try { return Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).projects || {}); } catch (e) {
      if (e.code === 'ENOENT') return [];
    }
  }
  throw new Error('~/.claude.json을 읽지 못했습니다');
}

test('contracts.js의 IPC 채널 문자열이 PLAN.md 목록과 빠짐·추가 없이 같다', { skip: NO_PLAN }, () => {
  const plan = planChannels();
  assert.deepEqual(Object.values(contracts.MAIN_TO_RENDERER), plan.toRenderer);
  assert.deepEqual(Object.values(contracts.RENDERER_TO_MAIN), plan.toMain);
  assert.equal(plan.toRenderer.length, 8);
  assert.equal(plan.toMain.length, 7);
});

test('contracts.js의 환경 변수 이름이 PLAN.md 목록과 같다', { skip: NO_PLAN }, () => {
  assert.deepEqual(Object.values(contracts.ENV_VARS), planEnvVars());
  assert.deepEqual(planEnvVars(), ['KCT_CLAUDE_PATH', 'KCT_WORKDIR', 'KCT_TEST']);
});

test('preload.js는 contracts.js와 같은 채널 목록을 들고 electron만 불러온다', () => {
  const { lists, exposed } = loadPreload();
  assert.deepEqual(lists.MAIN_TO_RENDERER, Object.values(contracts.MAIN_TO_RENDERER));
  assert.deepEqual(lists.RENDERER_TO_MAIN, Object.values(contracts.RENDERER_TO_MAIN));
  assert.deepEqual(Object.keys(exposed), ['kct']);
  assert.deepEqual(Object.keys(exposed.kct).sort(), ['on', 'send']);
});

test('preload의 send는 renderer → main 채널만 통과시키고 나머지는 거절한다', () => {
  const { api, sent } = loadPreload();
  for (const ch of Object.values(contracts.RENDERER_TO_MAIN)) api.send(ch, { x: 1 });
  assert.deepEqual(sent.map(([c]) => c), Object.values(contracts.RENDERER_TO_MAIN));
  for (const bad of ['pty:data', 'perm:show', 'evil:channel', '', undefined]) {
    assert.throws(() => api.send(bad, 1), /허용되지 않은/);
  }
  assert.equal(sent.length, Object.values(contracts.RENDERER_TO_MAIN).length);
});

test('preload의 on은 main → renderer 채널만 받고, 이벤트 객체 없이 값만 넘기며, 구독을 끊을 수 있다', () => {
  const { api, emit } = loadPreload();
  const got = [];
  const off = api.on('log:add', (...args) => got.push(args));
  emit('log:add', { icon: '📄', text: '읽었어요', time: 1 });
  assert.deepEqual(got, [[{ icon: '📄', text: '읽었어요', time: 1 }]]);
  off();
  emit('log:add', { text: '두 번째' });
  assert.equal(got.length, 1);
  for (const ch of Object.values(contracts.MAIN_TO_RENDERER)) assert.equal(typeof api.on(ch, () => {}), 'function');
  for (const bad of ['pty:input', 'perm:decide', 'evil:channel']) {
    assert.throws(() => api.on(bad, () => {}), /허용되지 않은/);
  }
});

test('package.json의 의존성은 모두 정확한 버전이다(^ ~ 범위 없음)', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8'));
  const all = { ...pkg.dependencies, ...pkg.devDependencies };
  for (const name of ['electron', 'node-pty', '@xterm/xterm', '@xterm/addon-fit', '@xterm/headless', 'playwright']) {
    assert.ok(all[name], `${name}이 없습니다`);
  }
  for (const [name, v] of Object.entries(all)) {
    assert.match(v, /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/, `${name}@${v}는 정확한 버전이 아닙니다`);
  }
  const lock = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package-lock.json'), 'utf8'));
  for (const [name, v] of Object.entries(all)) {
    assert.equal(lock.packages[`node_modules/${name}`].version, v, `${name} 잠금 버전이 다릅니다`);
  }
  for (const s of ['start', 'test', 'smoke', 'e2e:ui', 'e2e:app']) assert.ok(pkg.scripts[s], `${s} 스크립트가 없습니다`);
});

test('npm run smoke: 숨긴 Electron 창과 node-pty가 60초 안에 READY와 PTY_OK 한글을 낸다', { timeout: 70000 }, async () => {
  const electronBin = require('electron'); // node에서 부르면 실행 파일 경로를 준다
  const started = Date.now();
  const { code, out } = await new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const p = spawn(electronBin, [path.join(APP_DIR, 'scripts', 'smoke.js')], { cwd: APP_DIR, env });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`60초 넘게 걸렸습니다\n${out}`)); }, 60000);
    p.on('exit', (code) => { clearTimeout(t); resolve({ code, out }); });
  });
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'smoke-output.txt'), out);
  assert.equal(code, 0, out);
  assert.match(out, /^READY/m);
  assert.match(out, /^PTY_OK 한글$/m);
  assert.ok(Date.now() - started < 60000);
});

test('fakeClaudeHome은 가짜 설정 폴더·.claude.json·가짜 키를 만들고 부모의 Claude 변수를 지운다', () => {
  const dir = path.join(OUT, 'unit-home');
  fs.rmSync(dir, { recursive: true, force: true });
  const trusted = path.join(OUT, 'unit-trusted');
  fs.mkdirSync(trusted, { recursive: true });
  const saved = { CLAUDECODE: process.env.CLAUDECODE, ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN };
  process.env.CLAUDECODE = '1';
  process.env.ANTHROPIC_AUTH_TOKEN = 'real-looking-token';
  try {
    const { env, configDir, claudeJsonPath } = createFakeClaudeHome({ dir, trustedPaths: [trusted] });
    assert.ok(configDir.startsWith(path.resolve(dir)));
    assert.equal(env.CLAUDE_CONFIG_DIR, configDir);
    assert.equal(env.ANTHROPIC_API_KEY, FAKE_API_KEY);
    assert.equal(env.CLAUDECODE, undefined);
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
    const j = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
    assert.equal(j.hasCompletedOnboarding, true);
    assert.deepEqual(j.customApiKeyResponses.approved, [FAKE_API_KEY.slice(-20)]);
    assert.equal(j.projects[fs.realpathSync(trusted)].hasTrustDialogAccepted, true);

    const bare = createFakeClaudeHome({ dir: path.join(OUT, 'unit-home-bare'), onboarded: false, withKey: false });
    const bj = JSON.parse(fs.readFileSync(bare.claudeJsonPath, 'utf8'));
    assert.equal(bj.hasCompletedOnboarding, undefined);
    assert.equal(bare.env.ANTHROPIC_API_KEY, undefined);
    assert.deepEqual(bj.projects, {});

    const unapproved = createFakeClaudeHome({ dir: path.join(OUT, 'unit-home-unapproved'), approveKey: false });
    assert.deepEqual(JSON.parse(fs.readFileSync(unapproved.claudeJsonPath, 'utf8')).customApiKeyResponses.approved, []);
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('tmux 도우미: 고유 소켓으로 띄우고 한글을 그대로 보내고 kill하면 프로세스와 소켓이 남지 않는다', { timeout: 20000 }, async (t) => {
  if (!tmux.findTmux()) return t.skip('tmux가 없습니다');
  const h = tmux.start({ socket: `kct-T1-cat-${process.pid}`, command: '/bin/cat', cwd: OUT, env: { PATH: '/usr/bin:/bin', LANG: 'ko_KR.UTF-8' }, cols: 60, rows: 10 });
  try {
    h.sendLiteral('한글 입력');
    h.send('Enter');
    const screen = await h.waitFor(/한글 입력\n한글 입력/, { timeoutMs: 5000 });
    assert.match(screen, /한글 입력/);
  } finally {
    const pid = h.panePid();
    h.kill();
    await new Promise((r) => setTimeout(r, 300));
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
    const sockDir = path.join(h.tmpDir, `tmux-${process.getuid()}`);
    const left = fs.existsSync(sockDir) ? fs.readdirSync(sockDir).filter((f) => f === h.socket) : [];
    assert.deepEqual(left, []);
  }
});

test('실제 claude: 믿지 않는 폴더에서는 신뢰 창이, 믿는 폴더에서는 입력 프롬프트가 보이고, 실제 설정에는 흔적이 없다', { timeout: 90000 }, async (t) => {
  const claude = findRealClaude();
  if (!claude) return t.skip('실제 claude가 없습니다');
  if (!tmux.findTmux()) return t.skip('tmux가 없습니다');

  const realHome = os.homedir();
  const before = realProjectKeys().filter((k) => k.includes('.test-tmp'));
  const live = path.join(OUT, 'live');
  fs.rmSync(live, { recursive: true, force: true });
  const untrusted = path.join(live, 'untrusted');
  const trusted = path.join(live, 'trusted');
  fs.mkdirSync(untrusted, { recursive: true });
  fs.mkdirSync(trusted, { recursive: true });
  const { env, configDir, claudeJsonPath } = createFakeClaudeHome({ dir: path.join(live, 'home'), trustedPaths: [trusted] });

  const handles = [];
  const pids = [];
  let trustedPid = null;
  try {
    const u = tmux.start({ socket: `kct-T1-untrusted-${process.pid}`, command: claude, cwd: untrusted, env, cols: 120, rows: 36 });
    handles.push(u);
    const uScreen = await u.waitFor(/Yes, I trust this folder/, { timeoutMs: 30000 });
    u.capture(path.join(OUT, 'claude-untrusted.txt'));
    assert.match(uScreen, /Accessing workspace/);
    assert.match(uScreen, /No, exit/);

    const tr = tmux.start({ socket: `kct-T1-trusted-${process.pid}`, command: claude, cwd: trusted, env, cols: 120, rows: 36 });
    handles.push(tr);
    // 입력 줄은 "❯" 뒤에 보통 공백이 아니라 U+00A0(줄바꿈 없는 공백)이 온다. \s는 둘 다 잡는다.
    const tScreen = await tr.waitFor(/^❯\s.*$[\s\S]*for shortcuts/m, { timeoutMs: 30000 });
    tr.capture(path.join(OUT, 'claude-trusted.txt'));
    assert.doesNotMatch(tScreen, /trust this folder/);
    assert.match(tScreen, /Claude Code v\d+\.\d+\.\d+/);

    // 떠 있는 동안: 세션 파일이 가짜 설정 폴더에만 생긴다.
    trustedPid = tr.panePid();
    assert.ok(fs.existsSync(path.join(configDir, 'sessions', `${trustedPid}.json`)), '가짜 설정에 세션 파일이 있어야 합니다');
    assert.ok(!fs.existsSync(path.join(realHome, '.claude', 'sessions', `${trustedPid}.json`)), '실제 ~/.claude/sessions에 세션 파일이 생겼습니다');
  } finally {
    for (const h of handles) { pids.push(h.panePid()); h.kill(); }
  }

  // 끝난 뒤: claude가 가짜 .claude.json에 남긴 세션 ID가 실제 ~/.claude.json에는 없다.
  let sessionIds = [];
  for (let i = 0; i < 25 && sessionIds.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 200));
    let fake = {};
    try { fake = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8')); } catch { /* claude가 쓰는 중 */ }
    sessionIds = Object.values(fake.projects || {}).map((v) => v.lastSessionId).filter(Boolean);
  }
  assert.ok(sessionIds.length > 0, '가짜 .claude.json에 claude가 쓴 세션 기록이 있어야 합니다');
  const realText = fs.readFileSync(path.join(realHome, '.claude.json'), 'utf8');
  for (const id of sessionIds) assert.ok(!realText.includes(id), `실제 ~/.claude.json에 시험 세션 ${id}가 있습니다`);

  const after = realProjectKeys().filter((k) => k.includes('.test-tmp'));
  assert.deepEqual(after.filter((k) => !before.includes(k)), [], '실제 ~/.claude.json에 시험 폴더가 생겼습니다');
  // SIGHUP 뒤 claude가 끝내는 데 시간이 걸릴 수 있어 5초까지 기다린다.
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  for (let i = 0; i < 50 && pids.some(alive); i++) await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(pids.filter(alive), [], '시험 claude 프로세스가 남아 있습니다');
  assert.equal(pids.length, 2);
});
