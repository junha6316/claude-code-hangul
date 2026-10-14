// 로그인 셸 환경 읽기, claude에 넘길 환경 만들기, claude 찾기(PLAN.md 공통 약속 env.js).
//
// Finder에서 띄운 앱은 PATH가 /usr/bin:/bin:/usr/sbin:/sbin뿐이라 brew·node 같은 도구가 안 보인다.
// 그래서 사용자 셸을 로그인·대화형(-ilc)으로 한 번 띄워 그 환경을 읽어 온다.
// 셸 설정이 화면 표시 문자(iTerm 셸 통합 이스케이프 등)를 찍어도 깨지지 않게,
// 앞뒤 표시 문자열 사이의 `env -0` 출력만 읽는다.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const { ENV_VARS } = require('../shared/contracts');

const ELECTRON_ONLY = /^ELECTRON_/;

function copyWithoutElectronVars(env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && !ELECTRON_ONLY.test(k)) out[k] = v;
  }
  return out;
}

function parseEnvZero(text) {
  const env = {};
  for (const entry of text.split('\0')) {
    const eq = entry.indexOf('=');
    if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return env;
}

// Finder에서 띄우면 SHELL이 없을 수 있어 계정에 적힌 셸을 쓴다.
function defaultShell() {
  let accountShell = null;
  try { accountShell = os.userInfo().shell; } catch { /* 계정 정보를 못 읽음 */ }
  return process.env.SHELL || accountShell || '/bin/sh';
}

// 로그인 셸($SHELL -ilc)의 환경. 실패하거나 timeoutMs보다 늦으면 process.env 사본.
function getLoginShellEnv({ shell, timeoutMs = 5000 } = {}) {
  const fallback = () => ({ ...process.env });
  if (process.platform === 'win32') return Promise.resolve(fallback());

  const id = crypto.randomBytes(8).toString('hex');
  const start = Buffer.from(`__KCT_ENV_START_${id}__`);
  const end = Buffer.from(`__KCT_ENV_END_${id}__`);
  // 표시 문자열을 두 조각으로 나눠 찍어, 명령 글자 자체가 출력에 섞여도 표시로 잘못 읽지 않게 한다.
  const command = `printf '%s%s' '__KCT_ENV_' 'START_${id}__'; /usr/bin/env -0; printf '%s%s' '__KCT_ENV_' 'END_${id}__'`;

  return new Promise((resolve) => {
    let settled = false;
    let child;
    const chunks = [];
    let timer;
    let exitTimer;

    // 셸이 먼저 끝났어도 같은 무리에 남은 백그라운드 프로세스까지 끈다. 무리가 비었으면 ESRCH로 끝난다.
    const killGroup = () => {
      if (!child || !child.pid) return;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 이미 모두 끝남 */ }
    };

    // 표시 문자열 사이를 읽는다. 끝 표시가 아직 없으면 null.
    const extract = () => {
      const buf = Buffer.concat(chunks);
      const s = buf.indexOf(start);
      if (s < 0) return null;
      const e = buf.indexOf(end, s + start.length);
      if (e < 0) return null;
      return parseEnvZero(buf.subarray(s + start.length, e).toString('utf8'));
    };

    const finish = (env) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(exitTimer);
      killGroup();
      resolve(env && env.PATH ? env : fallback());
    };

    try {
      child = spawn(shell || defaultShell(), ['-ilc', command], {
        env: copyWithoutElectronVars(process.env),
        cwd: os.homedir(),
        stdio: ['ignore', 'pipe', 'ignore'],
        detached: true, // 새 세션: 셸 설정이 앱의 터미널을 건드리지 않고, 무리째 끌 수 있다
      });
    } catch {
      resolve(fallback());
      return;
    }

    timer = setTimeout(() => finish(null), timeoutMs);
    child.on('error', () => finish(null));
    child.stdout.on('data', (d) => {
      chunks.push(d);
      const env = extract();
      if (env) finish(env);
    });
    child.stdout.on('close', () => finish(extract()));
    // 셸이 끝났는데 자식이 출력을 붙잡고 있으면 close가 늦어지므로 잠깐만 더 기다린다.
    child.on('exit', () => { exitTimer = setTimeout(() => finish(extract()), 200); });
  });
}

function findPathKey(env) {
  return Object.keys(env).find((k) => k.toUpperCase() === 'PATH');
}

// claude에 넘길 환경. PATH는 로그인 셸 것을 쓰고, 나머지는 processEnv가 이긴다(TERM·COLORTERM·CLAUDE_CODE_HIDE_CWD는 앱이 정한다).
function buildClaudeEnv(loginEnv, processEnv = process.env) {
  const env = copyWithoutElectronVars({ ...loginEnv, ...processEnv });

  const loginPathKey = findPathKey(loginEnv || {});
  if (loginPathKey && loginEnv[loginPathKey]) {
    // Windows에서는 Path·PATH처럼 대소문자만 다른 키가 같이 있을 수 있어 하나로 맞춘다.
    for (const k of Object.keys(env)) if (k.toUpperCase() === 'PATH') delete env[k];
    env[loginPathKey] = loginEnv[loginPathKey];
  }

  if (!env.LANG && !env.LC_ALL) env.LANG = 'ko_KR.UTF-8';
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  // claude 머리말에서 작업 폴더 경로를 숨긴다(경로는 앱 위 막대에 폴더 이름으로만 보인다).
  // 근거: review/tech-stack-deploy/docs/env-vars.md 317행
  env.CLAUDE_CODE_HIDE_CWD = '1';
  return env;
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function isRunnable(p, platform) {
  if (!isFile(p)) return false;
  if (platform === 'win32') return true;
  try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; }
}

// KCT_CLAUDE_PATH → ~/.local/bin/claude(Windows는 %USERPROFILE%\.local\bin\claude.exe) → PATH 순서.
// 못 찾으면 공식 설치 위치를 exists: false로 돌려준다.
// 근거: review/tech-stack-deploy/docs/troubleshoot-install.md 127행(설치 위치)
function findClaude(env, platform = process.platform) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const exe = platform === 'win32' ? 'claude.exe' : 'claude';

  const override = env[ENV_VARS.CLAUDE_PATH];
  if (override) return { path: override, exists: isFile(override) };

  const home = (platform === 'win32' ? env.USERPROFILE : env.HOME) || os.homedir();
  const local = p.join(home, '.local', 'bin', exe);
  if (isRunnable(local, platform)) return { path: local, exists: true };

  const pathKey = findPathKey(env);
  const dirs = pathKey ? env[pathKey].split(platform === 'win32' ? ';' : ':') : [];
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = p.join(dir, exe);
    if (isRunnable(candidate, platform)) return { path: candidate, exists: true };
  }
  return { path: local, exists: false };
}

module.exports = { getLoginShellEnv, buildClaudeEnv, findClaude };
