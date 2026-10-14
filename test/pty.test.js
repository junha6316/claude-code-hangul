// T2 시험: node-pty로 프로그램 띄우기(startClaude).
// node로 돌리면 Electron(ELECTRON_RUN_AS_NODE=1) 안에서도 같은 확인을 한 번 더 한다.
// Electron으로 이 파일 전체를 돌리려면: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --test test/pty.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { startClaude, ensureSpawnHelperExecutable } = require('../src/main/pty');
const { buildClaudeEnv, findClaude } = require('../src/main/env');
const { createFakeClaudeHome } = require('./helpers/fakeClaudeHome');

const APP_DIR = path.resolve(__dirname, '..');
const OUT = path.join(APP_DIR, '.test-tmp', 'T2');
const RUNTIME = process.versions.electron ? 'electron' : 'node';
const VERSION_RE = /\d+\.\d+\.\d+ \(Claude Code\)/;

fs.mkdirSync(OUT, { recursive: true });

// 띄운 프로세스를 모아 두었다가 시험이 끝나면 모두 끈다.
const started = [];
test.after(() => { for (const term of started) term.kill(); });

function run(opts) {
  const term = startClaude({ cwd: OUT, cols: 80, rows: 24, ...opts });
  started.push(term);
  let out = '';
  let exit = null;
  const waiters = [];
  term.onData((d) => { out += d; });
  term.onExit((e) => { exit = e; waiters.splice(0).forEach((w) => w(e)); });
  return {
    term,
    get out() { return out; },
    waitFor(re, timeoutMs) {
      return new Promise((resolve, reject) => {
        const t0 = Date.now();
        const tick = () => {
          if (re.test(out)) return resolve(out);
          if (Date.now() - t0 > timeoutMs) return reject(new Error(`${timeoutMs}ms 안에 ${re}가 안 보입니다. 출력: ${JSON.stringify(out)}`));
          setTimeout(tick, 20);
        };
        tick();
      });
    },
    waitExit(timeoutMs) {
      if (exit) return Promise.resolve(exit);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${timeoutMs}ms 안에 onExit가 안 불렸습니다`)), timeoutMs);
        waiters.push((e) => { clearTimeout(timer); resolve(e); });
      });
    },
  };
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// 실제 claude는 가짜 설정 폴더와 가짜 키로만 띄운다(공통 규칙 1).
function realClaudeSetup(name) {
  const { env: fakeEnv } = createFakeClaudeHome({ dir: path.join(OUT, name) });
  const env = buildClaudeEnv({}, fakeEnv);
  const work = path.join(OUT, `${name}-work`);
  fs.mkdirSync(work, { recursive: true });
  return { env, work, claude: findClaude({ ...env, KCT_CLAUDE_PATH: '' }) };
}

function realProjectKeys() {
  const file = path.join(os.homedir(), '.claude.json');
  for (let i = 0; i < 5; i++) {
    try { return Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).projects || {}); } catch (e) {
      if (e.code === 'ENOENT') return [];
    }
  }
  return [];
}

test(`[${RUNTIME}] 실제 claude --version을 띄우면 "x.y.z (Claude Code)"가 나온다`, { timeout: 30000 }, async (t) => {
  const { env, work, claude } = realClaudeSetup(`claude-version-${RUNTIME}`);
  if (!claude.exists) return t.skip('실제 claude가 없습니다');
  const r = run({ claudePath: claude.path, args: ['--version'], cwd: work, env });
  const { exitCode } = await r.waitExit(20000);
  fs.writeFileSync(path.join(OUT, `claude-version-${RUNTIME}.txt`), r.out);
  assert.match(r.out, VERSION_RE);
  assert.equal(exitCode, 0);
  assert.equal(realProjectKeys().some((k) => k.includes(work)), false, '실제 ~/.claude.json에 시험 폴더가 생겼습니다');
});

test(`[${RUNTIME}] .js 경로는 지금 도는 node/Electron으로 띄우고, Electron이면 ELECTRON_RUN_AS_NODE=1을 붙인다`, { timeout: 15000 }, async () => {
  const probe = path.join(OUT, 'runtime-probe.js');
  fs.writeFileSync(probe, [
    "console.log('RUNTIME electron=' + (process.versions.electron || 'none')",
    "  + ' runAsNode=' + (process.env.ELECTRON_RUN_AS_NODE || '') + ' args=' + JSON.stringify(process.argv.slice(2)));",
    '',
  ].join('\n'));
  const env = buildClaudeEnv({}, process.env); // ELECTRON_RUN_AS_NODE는 여기서 빠진다
  const r = run({ claudePath: probe, args: ['--settings', 'a b.json'], env });
  await r.waitExit(10000);
  const expected = process.versions.electron
    ? `RUNTIME electron=${process.versions.electron} runAsNode=1`
    : 'RUNTIME electron=none runAsNode=';
  assert.ok(r.out.includes(`${expected} args=["--settings","a b.json"]`), r.out);
});

test(`[${RUNTIME}] /bin/cat에 "한글 입력\\r"을 쓰면 돌아오고, resize가 되고, kill 뒤 2초 안에 onExit가 불린다`, { timeout: 15000 }, async (t) => {
  if (process.platform === 'win32') return t.skip('맥·리눅스 전용');
  const r = run({ claudePath: '/bin/cat', args: [], env: buildClaudeEnv({}, process.env) });
  r.term.write('한글 입력\r');
  await r.waitFor(/한글 입력/, 5000);
  assert.doesNotThrow(() => r.term.resize(100, 30));
  assert.doesNotThrow(() => r.term.resize(0, 0)); // 숨긴 창에서 오는 0은 무시
  const t0 = Date.now();
  r.term.kill();
  await r.waitExit(2000);
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(alive(r.term.pid), false);
  // 끝난 뒤의 write·resize·kill은 조용히 무시한다.
  assert.doesNotThrow(() => { r.term.write('x'); r.term.resize(80, 24); r.term.kill(); });
});

test(`[${RUNTIME}] SIGHUP을 무시하는 프로그램도 kill하면 강제로 끄고 onExit가 불린다`, { timeout: 15000 }, async () => {
  const stubborn = path.join(OUT, 'ignore-hup.js');
  fs.writeFileSync(stubborn, "process.on('SIGHUP', () => {}); console.log('HUP_IGNORED'); setInterval(() => {}, 1000);\n");
  const r = run({ claudePath: stubborn, env: buildClaudeEnv({}, process.env) });
  await r.waitFor(/HUP_IGNORED/, 10000);
  const t0 = Date.now();
  r.term.kill();
  const e = await r.waitExit(3000);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 1000, `SIGHUP에 바로 꺼졌습니다(${elapsed}ms): 시험 전제가 틀렸습니다`);
  assert.equal(alive(r.term.pid), false);
  if (process.platform !== 'win32') assert.equal(e.signal, 9);
});

test('spawn-helper에 실행 권한이 없으면 처음 띄울 때 준다', (t) => {
  if (process.platform === 'win32') return t.skip('Windows에는 spawn-helper가 없습니다');
  const root = path.join(OUT, 'fake-node-pty');
  const dir = path.join(root, 'prebuilds', `${process.platform}-${process.arch}`);
  fs.mkdirSync(dir, { recursive: true });
  const helper = path.join(dir, 'spawn-helper');
  fs.writeFileSync(helper, '');
  fs.chmodSync(helper, 0o644);
  assert.deepEqual(ensureSpawnHelperExecutable(root), [helper]);
  assert.equal(fs.statSync(helper).mode & 0o111, 0o111);
  assert.deepEqual(ensureSpawnHelperExecutable(root), [], '이미 실행 권한이 있으면 건드리지 않습니다');
});

test('Electron(ELECTRON_RUN_AS_NODE=1) 안에서도 startClaude로 실제 claude --version이 된다', { timeout: 60000 }, async (t) => {
  if (process.versions.electron) return t.skip('이미 Electron 안에서 돌고 있습니다(위 시험이 Electron 확인)');
  let electronBin;
  try { electronBin = require('electron'); } catch { return t.skip('electron이 없습니다'); }
  const { env, work, claude } = realClaudeSetup('claude-version-in-electron');
  if (!claude.exists) return t.skip('실제 claude가 없습니다');

  const script = `
    const { startClaude } = require(${JSON.stringify(path.join(APP_DIR, 'src', 'main', 'pty.js'))});
    const term = startClaude({ claudePath: ${JSON.stringify(claude.path)}, args: ['--version'],
      cwd: ${JSON.stringify(work)}, env: ${JSON.stringify(env)}, cols: 80, rows: 24 });
    let out = '';
    term.onData((d) => { out += d; });
    term.onExit(({ exitCode }) => {
      process.stdout.write(JSON.stringify({ electron: process.versions.electron, out, exitCode }));
    });`;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(electronBin, ['-e', script], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let so = '';
    let se = '';
    child.stdout.on('data', (d) => { so += d; });
    child.stderr.on('data', (d) => { se += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      try { resolve(JSON.parse(so)); } catch { reject(new Error(`Electron 실행 실패 code=${code} stdout=${so} stderr=${se}`)); }
    });
  });
  fs.writeFileSync(path.join(OUT, 'claude-version-in-electron.txt'), JSON.stringify(result, null, 2));
  assert.ok(result.electron, 'Electron으로 돌지 않았습니다');
  assert.match(result.out, VERSION_RE);
  assert.equal(result.exitCode, 0);
});
