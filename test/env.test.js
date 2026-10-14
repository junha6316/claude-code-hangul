// T2 시험: 로그인 셸 환경 읽기(getLoginShellEnv), claude 환경 만들기(buildClaudeEnv), claude 찾기(findClaude).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const { getLoginShellEnv, buildClaudeEnv, findClaude } = require('../src/main/env');

const APP_DIR = path.resolve(__dirname, '..');
const OUT = path.join(APP_DIR, '.test-tmp', 'T2');
const ENV_JS = path.join(APP_DIR, 'src', 'main', 'env.js');

fs.mkdirSync(OUT, { recursive: true });

// Finder에서 띄운 앱처럼 PATH가 /usr/bin:/bin뿐인 환경(SHELL도 없음).
function finderLikeEnv() {
  const env = { HOME: os.homedir(), PATH: '/usr/bin:/bin' };
  for (const k of ['USER', 'LOGNAME', 'TMPDIR']) if (process.env[k]) env[k] = process.env[k];
  return env;
}

function writeScript(name, body) {
  const file = path.join(OUT, name);
  fs.writeFileSync(file, body);
  fs.chmodSync(file, 0o755);
  return file;
}

function groupAlive(pgid) {
  try { process.kill(-pgid, 0); return true; } catch { return false; }
}

test('PATH가 /usr/bin:/bin뿐인 프로세스에서도 로그인 셸 PATH(zsh -ilc)를 모두 가져온다', { timeout: 30000 }, async (t) => {
  if (process.platform === 'win32' || !fs.existsSync('/bin/zsh')) return t.skip('zsh가 없습니다');

  // 기준: 같은 환경에서 zsh -ilc 'echo $PATH'. 셸 통합 이스케이프가 섞이므로 앞 표시로 줄을 찾는다.
  const ref = execFileSync('/bin/zsh', ['-ilc', 'echo "__REF_PATH__$PATH"'], {
    env: finderLikeEnv(), cwd: os.homedir(), stdio: ['ignore', 'pipe', 'ignore'], timeout: 20000,
  }).toString();
  const refPath = ref.match(/__REF_PATH__([^\n]*)/)[1];

  const out = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', `
      require(${JSON.stringify(ENV_JS)}).getLoginShellEnv().then((e) => {
        process.stdout.write(JSON.stringify({ PATH: e.PATH, parentPath: process.env.PATH }));
      });`], { env: finderLikeEnv(), stdio: ['ignore', 'pipe', 'inherit'] });
    let s = '';
    child.stdout.on('data', (d) => { s += d; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(JSON.parse(s)) : reject(new Error(`exit ${code}`))));
  });
  fs.writeFileSync(path.join(OUT, 'login-path.txt'),
    `부모 PATH: ${out.parentPath}\n기준(zsh -ilc): ${refPath}\n결과: ${out.PATH}\n`);

  assert.equal(out.parentPath, '/usr/bin:/bin');
  const got = new Set(out.PATH.split(':'));
  const missing = refPath.split(':').filter((d) => d && !got.has(d));
  assert.deepEqual(missing, [], `로그인 셸 PATH에서 빠진 경로: ${missing.join(', ')}`);
  if (fs.existsSync('/opt/homebrew/bin')) assert.ok(got.has('/opt/homebrew/bin'), '/opt/homebrew/bin이 없습니다');
});

test('셸 설정이 표시 문자를 앞뒤로 찍어도 표시 문자열 사이의 env -0 출력만 읽는다(줄바꿈·한글 값 유지)', { timeout: 10000 }, async () => {
  const shell = writeScript('noisy-shell.sh', [
    '#!/bin/sh',
    // iTerm 셸 통합처럼 이스케이프와 잡문을 앞뒤로 찍는다.
    "printf '\\033]1337;RemoteHost=tester@mac\\007junk=line\\n'",
    "export KCT_PROBE=\"$(printf '한글 값\\n둘째 줄')\"",
    'export PATH="/kct/login/bin:$PATH"',
    '/bin/sh -c "$2"', // getLoginShellEnv가 넘긴 -ilc 명령
    "printf 'AFTER=junk\\n'",
    '',
  ].join('\n'));
  const env = await getLoginShellEnv({ shell });
  assert.equal(env.KCT_PROBE, '한글 값\n둘째 줄');
  assert.ok(env.PATH.startsWith('/kct/login/bin:'), env.PATH);
  assert.equal(env.AFTER, undefined);
  assert.equal(env.junk, undefined);
});

for (const timeoutMs of [1000, undefined]) {
  const limit = (timeoutMs || 5000) + 1000;
  const label = timeoutMs ? `timeoutMs=${timeoutMs}` : '기본 timeoutMs(5000)';
  test(`30초 멈추는 가짜 셸이면 ${label} + 1초 안에 process.env 사본을 돌려주고 셸 무리를 정리한다`, { timeout: limit + 5000 }, async () => {
    const pidFile = path.join(OUT, `stall-${timeoutMs || 'default'}.pid`);
    fs.rmSync(pidFile, { force: true });
    const shell = writeScript(`stall-shell-${timeoutMs || 'default'}.sh`,
      `#!/bin/sh\necho $$ > '${pidFile}'\nsleep 30\n`);
    const started = Date.now();
    const env = await getLoginShellEnv(timeoutMs ? { shell, timeoutMs } : { shell });
    const elapsed = Date.now() - started;
    assert.ok(elapsed < limit, `${elapsed}ms 걸렸습니다(한도 ${limit}ms)`);
    assert.ok(elapsed >= (timeoutMs || 5000) - 50, `너무 일찍 끝났습니다: ${elapsed}ms`);
    assert.deepEqual(env, { ...process.env });
    assert.notEqual(env, process.env, '사본이 아니라 process.env 그 자체를 돌려줬습니다');

    const pgid = Number(fs.readFileSync(pidFile, 'utf8'));
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(groupAlive(pgid), false, '가짜 셸(sleep 포함)이 남아 있습니다');
  });
}

test('셸 설정이 띄운 백그라운드 프로세스는 환경을 읽은 뒤 셸 무리째 정리한다', { timeout: 10000 }, async () => {
  const pidFile = path.join(OUT, 'bg-sleep.pid');
  fs.rmSync(pidFile, { force: true });
  const shell = writeScript('bg-shell.sh', [
    '#!/bin/sh',
    'sleep 30 &',
    `echo $! > '${pidFile}'`,
    '/bin/sh -c "$2"',
    '',
  ].join('\n'));
  const env = await getLoginShellEnv({ shell });
  assert.ok(env.PATH);
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  await new Promise((r) => setTimeout(r, 200));
  let alive = true;
  try { process.kill(pid, 0); } catch { alive = false; }
  assert.equal(alive, false, '백그라운드 sleep이 남아 있습니다');
});

test('셸이 없거나 바로 실패하면 process.env 사본을 돌려준다', async () => {
  const missing = await getLoginShellEnv({ shell: path.join(OUT, 'no-such-shell') });
  assert.deepEqual(missing, { ...process.env });
  const failing = writeScript('fail-shell.sh', '#!/bin/sh\nexit 3\n');
  const started = Date.now();
  assert.deepEqual(await getLoginShellEnv({ shell: failing }), { ...process.env });
  assert.ok(Date.now() - started < 2000);
});

test('buildClaudeEnv: PATH는 로그인 셸 것, 나머지는 processEnv가 이기고 CLAUDE_CONFIG_DIR을 지킨다', () => {
  const login = { PATH: '/opt/homebrew/bin:/usr/bin:/bin', HOME: '/Users/login', SHELL: '/bin/zsh', ONLY_LOGIN: 'yes', LANG: 'en_US.UTF-8' };
  const proc = { PATH: '/usr/bin:/bin', HOME: '/Users/tester', CLAUDE_CONFIG_DIR: '/x/.test-tmp/claude-config', LANG: 'ko_KR.UTF-8' };
  const env = buildClaudeEnv(login, proc);
  assert.equal(env.PATH, '/opt/homebrew/bin:/usr/bin:/bin');
  assert.equal(env.HOME, '/Users/tester');
  assert.equal(env.CLAUDE_CONFIG_DIR, '/x/.test-tmp/claude-config');
  assert.equal(env.ONLY_LOGIN, 'yes');
  assert.equal(env.SHELL, '/bin/zsh');
  assert.equal(env.LANG, 'ko_KR.UTF-8');
  assert.equal(env.TERM, 'xterm-256color');
  assert.equal(env.COLORTERM, 'truecolor');
  // 넘겨받은 객체는 바꾸지 않는다.
  assert.equal(proc.TERM, undefined);
});

test('buildClaudeEnv: LANG·LC_ALL이 없을 때만 LANG=ko_KR.UTF-8을 넣고, 있는 LANG은 바꾸지 않는다', () => {
  assert.equal(buildClaudeEnv({ PATH: '/bin' }, {}).LANG, 'ko_KR.UTF-8');
  assert.equal(buildClaudeEnv({ PATH: '/bin' }, { LANG: 'en_US.UTF-8' }).LANG, 'en_US.UTF-8');
  assert.equal(buildClaudeEnv({ PATH: '/bin', LANG: 'C.UTF-8' }, {}).LANG, 'C.UTF-8');
  const withLcAll = buildClaudeEnv({ PATH: '/bin' }, { LC_ALL: 'en_US.UTF-8' });
  assert.equal(withLcAll.LANG, undefined);
  assert.equal(withLcAll.LC_ALL, 'en_US.UTF-8');
});

// 근거: review/tech-stack-deploy/docs/env-vars.md 317행(`CLAUDE_CODE_HIDE_CWD`: 1이면 시작 로고에서 작업 폴더를 숨김)
test('buildClaudeEnv: 머리말에서 작업 폴더 경로를 숨기게 CLAUDE_CODE_HIDE_CWD=1을 넣는다(셸에서 다른 값을 줘도 1)', () => {
  assert.equal(buildClaudeEnv({ PATH: '/bin' }, {}).CLAUDE_CODE_HIDE_CWD, '1');
  assert.equal(buildClaudeEnv({ PATH: '/bin', CLAUDE_CODE_HIDE_CWD: '0' }, {}).CLAUDE_CODE_HIDE_CWD, '1');
  assert.equal(buildClaudeEnv({ PATH: '/bin' }, { CLAUDE_CODE_HIDE_CWD: '0' }).CLAUDE_CODE_HIDE_CWD, '1');
});

test('buildClaudeEnv: Electron 전용 변수(ELECTRON_RUN_AS_NODE 등)를 뺀다', () => {
  const env = buildClaudeEnv(
    { PATH: '/bin', ELECTRON_NO_ATTACH_CONSOLE: '1' },
    { ELECTRON_RUN_AS_NODE: '1', ELECTRON_ENABLE_LOGGING: '1', KEEP: 'ok' },
  );
  assert.deepEqual(Object.keys(env).filter((k) => k.startsWith('ELECTRON_')), []);
  assert.equal(env.KEEP, 'ok');
});

test('buildClaudeEnv: 로그인 셸에 PATH가 없으면 processEnv의 PATH를 쓰고, Windows식 Path 키도 하나로 맞춘다', () => {
  assert.equal(buildClaudeEnv({}, { PATH: '/usr/bin:/bin' }).PATH, '/usr/bin:/bin');
  const win = buildClaudeEnv({ Path: 'C:\\login' }, { PATH: 'C:\\proc', USERPROFILE: 'C:\\Users\\tester' });
  assert.equal(win.Path, 'C:\\login');
  assert.equal(win.PATH, undefined);
});

test('findClaude는 KCT_CLAUDE_PATH를 가장 먼저 따른다', () => {
  const fake = path.join(OUT, 'fake-claude.js');
  fs.writeFileSync(fake, 'console.log("fake")\n');
  const env = { HOME: os.homedir(), PATH: process.env.PATH, KCT_CLAUDE_PATH: fake };
  assert.deepEqual(findClaude(env), { path: fake, exists: true });
  const missing = path.join(OUT, 'no-such-claude');
  assert.deepEqual(findClaude({ ...env, KCT_CLAUDE_PATH: missing }), { path: missing, exists: false });
});

test('findClaude는 이 Mac에서 ~/.local/bin/claude를 찾는다(PATH가 /usr/bin:/bin뿐이어도)', (t) => {
  const local = path.join(os.homedir(), '.local', 'bin', 'claude');
  if (!fs.existsSync(local)) return t.skip('~/.local/bin/claude가 없습니다');
  assert.deepEqual(findClaude({ HOME: os.homedir(), PATH: '/usr/bin:/bin' }), { path: local, exists: true });
});

test('findClaude는 ~/.local/bin에 없으면 PATH 순서대로 실행 가능한 claude를 찾고, 못 찾으면 설치 위치를 exists:false로 준다', (t) => {
  if (process.platform === 'win32') return t.skip('맥·리눅스 전용');
  const home = path.join(OUT, 'find-home');
  const noExec = path.join(OUT, 'find-path-noexec');
  const first = path.join(OUT, 'find-path-first');
  const second = path.join(OUT, 'find-path-second');
  for (const d of [home, noExec, first, second]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(noExec, 'claude'), '#!/bin/sh\n');
  fs.chmodSync(path.join(noExec, 'claude'), 0o644);
  for (const d of [first, second]) {
    fs.writeFileSync(path.join(d, 'claude'), '#!/bin/sh\n');
    fs.chmodSync(path.join(d, 'claude'), 0o755);
  }
  const env = { HOME: home, PATH: [noExec, first, second].join(':') };
  assert.deepEqual(findClaude(env, 'darwin'), { path: path.join(first, 'claude'), exists: true });
  assert.deepEqual(findClaude({ HOME: home, PATH: noExec }, 'linux'),
    { path: path.join(home, '.local', 'bin', 'claude'), exists: false });
});

test('findClaude는 Windows에서 %USERPROFILE%\\.local\\bin\\claude.exe를 기본 위치로 본다', () => {
  assert.deepEqual(
    findClaude({ USERPROFILE: 'C:\\Users\\tester', Path: 'C:\\Windows\\System32' }, 'win32'),
    { path: 'C:\\Users\\tester\\.local\\bin\\claude.exe', exists: false },
  );
});
