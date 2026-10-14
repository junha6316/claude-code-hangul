// T8 설치 확인 시험(이 Mac에서 도는 부분). 실제 설치는 하지 않는다.
// 실제 설치는 test/container/run-installer-test.sh가 Linux 컨테이너 안에서만 한다.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

// 완성 조건 4: installer.js가 띄우는 명령을 모두 적어 두고, 설치 스크립트가 한 번도 돌지 않았는지 마지막에 확인한다.
// installer.js·env.js가 spawn을 꺼내 쓰기 전에 바꿔야 해서 require보다 먼저 둔다.
const spawned = [];
const realSpawn = childProcess.spawn;
childProcess.spawn = function recordingSpawn(cmd, args, ...rest) {
  spawned.push([cmd, ...(Array.isArray(args) ? args : [])].join(' '));
  return realSpawn.call(this, cmd, args, ...rest);
};

const { checkClaude, installCommand, installClaude } = require('../src/main/installer');

const APP = path.resolve(__dirname, '..');
const OUT = path.join(APP, '.test-tmp', 'T8', 'host');
const DOC = path.resolve(APP, '..', 'review', 'tech-stack-deploy', 'docs', 'setup.md');

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// 문서 사본에서 heading 아래 <Tabs> 묶음의 탭별 명령을 꺼낸다.
function docCommands(heading) {
  const text = fs.readFileSync(DOC, 'utf8');
  const start = text.indexOf(heading);
  assert.ok(start >= 0, `문서 사본에 "${heading}"이 없어요`);
  const block = text.slice(start, text.indexOf('</Tabs>', start));
  const out = {};
  for (const m of block.matchAll(/<Tab title="([^"]+)">\s*```[^\n]*\n\s*(.+?)\n\s*```/g)) out[m[1]] = m[2].trim();
  return out;
}

// 실제 사용자 설정을 건드리지 않게 가짜 CLAUDE_CONFIG_DIR을 붙이고, KCT_CLAUDE_PATH는 뺀다.
function hostEnv(extra = {}) {
  const env = { ...process.env, CLAUDE_CONFIG_DIR: path.join(OUT, 'claude-config') };
  delete env.KCT_CLAUDE_PATH;
  return { ...env, ...extra };
}

function writeScript(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, { mode: 0o755 });
  return file;
}

function emptyDir(name) {
  const dir = path.join(OUT, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const NO_DOC = !fs.existsSync(DOC) && '저장소 밖 검토 자료(review/)가 없어 건너뜁니다(공개 저장소)';
const STABLE = NO_DOC ? {} : docCommands('To install the stable version:');
const LATEST = NO_DOC ? {} : docCommands('To install the latest version (default):');
const results = {};

test('문서 사본에서 stable·latest 명령을 탭마다 꺼낼 수 있다', { skip: NO_DOC }, () => {
  for (const cmds of [STABLE, LATEST]) {
    assert.deepEqual(Object.keys(cmds).sort(), ['Windows CMD', 'Windows PowerShell', 'macOS, Linux, WSL']);
  }
  assert.equal(STABLE['macOS, Linux, WSL'], 'curl -fsSL https://claude.ai/install.sh | bash -s stable');
});

test('macOS·Linux 설치 명령이 문서의 stable 명령과 글자 하나까지 같다', { skip: NO_DOC }, () => {
  for (const platform of ['darwin', 'linux']) {
    const { cmd, args } = installCommand(platform);
    assert.equal(cmd, '/bin/sh');
    assert.deepEqual(args, ['-c', STABLE['macOS, Linux, WSL']]);
    results[platform] = { cmd, args };
  }
});

test('Windows 설치 명령이 문서의 PowerShell stable 명령과 글자 하나까지 같다', { skip: NO_DOC }, () => {
  const { cmd, args } = installCommand('win32');
  assert.equal(cmd, 'powershell.exe');
  assert.equal(args[args.length - 1], STABLE['Windows PowerShell']);
  results.win32 = { cmd, args };
});

test('채널을 안 주면 stable이고, latest는 문서의 기본 설치 명령이다', { skip: NO_DOC }, () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    assert.deepEqual(installCommand(platform), installCommand(platform, 'stable'));
  }
  assert.equal(installCommand('linux', 'latest').args.at(-1), LATEST['macOS, Linux, WSL']);
  assert.equal(installCommand('win32', 'latest').args.at(-1), LATEST['Windows PowerShell']);
});

test('모르는 채널은 오류를 낸다', () => {
  assert.throws(() => installCommand('darwin', 'beta'));
});

test('설치 명령에 관리자 권한(sudo·runas)이 없다', () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    const line = [installCommand(platform).cmd, ...installCommand(platform).args].join(' ');
    assert.doesNotMatch(line, /\bsudo\b|RunAs|-Verb/i);
  }
});

const HOST_CLAUDE = path.join(os.homedir(), '.local', 'bin', 'claude');
test('이 Mac의 ~/.local/bin/claude를 installed: true, 2.1.x로 알아본다', { skip: process.platform !== 'darwin' || (!fs.existsSync(HOST_CLAUDE) && '이 Mac에 claude가 깔려 있지 않습니다(CI 등)') }, async () => {
  const r = await checkClaude(hostEnv({ HOME: os.homedir() }), 'darwin');
  results.thisMac = r;
  assert.equal(r.installed, true);
  assert.match(r.version, /^2\.1\.\d+$/);
  assert.equal(r.path, path.join(os.homedir(), '.local', 'bin', 'claude'));
});

test('KCT_CLAUDE_PATH가 없는 경로면 오류 없이 installed: false', async () => {
  const missing = path.join(OUT, 'none', 'claude');
  const r = await checkClaude(hostEnv({ KCT_CLAUDE_PATH: missing }), process.platform);
  results.missingOverride = r;
  assert.deepEqual(r, { installed: false, version: null, path: missing });
});

test('어디에도 없으면 공식 설치 위치를 installed: false로 알려 준다', async () => {
  const home = emptyDir('empty-home');
  const r = await checkClaude(hostEnv({ HOME: home, PATH: emptyDir('empty-path') }), 'linux');
  results.notInstalled = r;
  assert.deepEqual(r, { installed: false, version: null, path: path.join(home, '.local', 'bin', 'claude') });
});

test('Windows에서 없으면 claude.exe 위치를 installed: false로 알려 준다', async () => {
  const r = await checkClaude({ USERPROFILE: 'C:\\Users\\tester', Path: '' }, 'win32');
  assert.deepEqual(r, { installed: false, version: null, path: 'C:\\Users\\tester\\.local\\bin\\claude.exe' });
});

test('"X.Y.Z (Claude Code)"로 답하는 claude는 installed: true', async () => {
  const home = emptyDir('fake-home');
  const bin = writeScript(path.join(home, '.local', 'bin', 'claude'), '#!/bin/sh\necho "9.9.9 (Claude Code)"\n');
  const r = await checkClaude(hostEnv({ HOME: home, PATH: '/usr/bin:/bin' }), 'linux');
  assert.deepEqual(r, { installed: true, version: '9.9.9', path: bin });
});

test('PATH에서 찾은 claude도 알아본다', async () => {
  const dir = emptyDir('path-bin');
  const bin = writeScript(path.join(dir, 'claude'), '#!/bin/sh\necho "1.2.3 (Claude Code)"\n');
  const r = await checkClaude(hostEnv({ HOME: emptyDir('empty-home'), PATH: `${dir}:/usr/bin:/bin` }), 'linux');
  assert.deepEqual(r, { installed: true, version: '1.2.3', path: bin });
});

test('이름만 같은 다른 프로그램이면 installed: false', async () => {
  const bin = writeScript(path.join(OUT, 'other', 'claude'), '#!/bin/sh\necho "claude 1.0"\n');
  const r = await checkClaude(hostEnv({ KCT_CLAUDE_PATH: bin }), process.platform);
  assert.deepEqual(r, { installed: false, version: null, path: bin });
});

test('.js 가짜 claude는 node로 돌려 버전을 읽는다', async () => {
  const js = path.join(OUT, 'fake-claude.js');
  fs.writeFileSync(js, "console.log('0.0.1 (Claude Code)');\n"); // 실행 권한 없음
  const r = await checkClaude(hostEnv({ KCT_CLAUDE_PATH: js }), process.platform);
  assert.deepEqual(r, { installed: true, version: '0.0.1', path: js });
});

test('--version에 답하지 않고 멈추면 timeoutMs 뒤 installed: false로 끝나고 남는 프로세스가 없다', async () => {
  const marker = `kct-t8-hang-${process.pid}`;
  // 손자 프로세스까지 남지 않는지 보려고, 표시 글자가 든 sh를 뒤에서 띄우고 기다린다.
  // (마지막 명령으로 두면 sh가 exec로 갈아타서 손자가 생기지 않는다)
  const bin = writeScript(path.join(OUT, 'hang', 'claude'), `#!/bin/sh\n/bin/sh -c 'sleep 30; : ${marker}' &\nwait\n`);
  const start = Date.now();
  const r = await checkClaude(hostEnv({ KCT_CLAUDE_PATH: bin }), process.platform, { timeoutMs: 1000 });
  assert.ok(Date.now() - start < 2000, `너무 늦게 끝났어요: ${Date.now() - start}ms`);
  assert.deepEqual(r, { installed: false, version: null, path: bin });
  await new Promise((res) => setTimeout(res, 200));
  const left = childProcess.spawnSync('pgrep', ['-f', marker], { encoding: 'utf8' }).stdout.trim();
  assert.equal(left, '', `남은 프로세스: ${left}`);
});

test('호스트 시험은 installClaude를 부르지 않고 설치 스크립트도 띄우지 않는다', () => {
  assert.equal(typeof installClaude, 'function');
  const installs = spawned.filter((line) => /install\.(sh|ps1|cmd)/.test(line));
  fs.writeFileSync(path.join(OUT, 'host-check.json'), JSON.stringify({ results, spawned }, null, 2));
  assert.deepEqual(installs, []);
  assert.ok(spawned.length > 0, 'spawn 기록이 비었어요(기록 장치가 안 붙었을 수 있어요)');
});
