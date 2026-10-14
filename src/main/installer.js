// 설치 확인·설치(PLAN.md 공통 약속 installer.js).
//
// 설치 명령은 공식 설치 문서 "To install the stable version"의 명령과 글자 하나까지 같다.
// 근거: https://code.claude.com/docs/en/setup#install-a-specific-version
//       사본 review/tech-stack-deploy/docs/setup.md 325~345행(stable), 303~323행(latest)
// 설치 스크립트는 $HOME 아래(~/.local/bin/claude)에만 깔고 sudo를 쓰지 않는다(문서 "You do not need to run as Administrator").
const os = require('os');
const { spawn } = require('child_process');

const { findClaude } = require('./env');

const DOC_COMMANDS = Object.freeze({
  posix: Object.freeze({
    stable: 'curl -fsSL https://claude.ai/install.sh | bash -s stable',
    latest: 'curl -fsSL https://claude.ai/install.sh | bash',
  }),
  win32: Object.freeze({
    stable: '& ([scriptblock]::Create((irm https://claude.ai/install.ps1))) stable',
    latest: 'irm https://claude.ai/install.ps1 | iex',
  }),
});

const VERSION_TIMEOUT_MS = 15000;
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
// 문서: "A working installation prints a version number such as `2.1.211 (Claude Code)`."
const VERSION_RE = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?) \(Claude Code\)/;
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

// macOS·Linux는 문서의 bash 명령을 sh로, Windows는 문서의 PowerShell 명령을 powershell로 돌린다.
function installCommand(platform = process.platform, channel = 'stable') {
  const family = platform === 'win32' ? 'win32' : 'posix';
  const command = DOC_COMMANDS[family][channel];
  if (!command) throw new Error(`알 수 없는 채널이에요: ${channel}`);
  if (family === 'win32') return { cmd: 'powershell.exe', args: ['-NoProfile', '-Command', command] };
  return { cmd: '/bin/sh', args: ['-c', command] };
}

// .js(시험용 가짜 claude)는 pty.js와 같은 방식으로 node로 돌린다.
function versionInvocation(claudePath, env) {
  if (claudePath.toLowerCase().endsWith('.js')) {
    const nodeEnv = process.versions.electron ? { ...env, ELECTRON_RUN_AS_NODE: '1' } : env;
    return { cmd: process.execPath, args: [claudePath, '--version'], env: nodeEnv };
  }
  return { cmd: claudePath, args: ['--version'], env };
}

// POSIX에서는 무리째 띄워, 멈추면 손자 프로세스까지 끈다.
function killTree(child) {
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
    else child.kill();
  } catch { /* 이미 끝남 */ }
}

function readVersion(claudePath, env, timeoutMs) {
  const { cmd, args, env: runEnv } = versionInvocation(claudePath, env);
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn(cmd, args, {
        env: runEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    } catch {
      resolve(null);
      return;
    }
    let settled = false;
    const finish = (version) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(version);
    };
    // 늦으면 출력이 덜 닫혀도 기다리지 않고 끝낸다.
    const timer = setTimeout(() => { killTree(child); finish(null); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', () => finish(null)); // ENOENT·EACCES
    child.on('close', () => {
      const m = out.match(VERSION_RE);
      finish(m ? m[1] : null);
    });
  });
}

// 찾은 claude가 `--version`에 "X.Y.Z (Claude Code)"로 답할 때만 installed: true.
// 파일은 있지만 버전을 못 읽으면(깨진 설치, 이름만 같은 다른 프로그램) installed: false.
async function checkClaude(env = process.env, platform = process.platform, { timeoutMs = VERSION_TIMEOUT_MS } = {}) {
  const found = findClaude(env, platform);
  if (!found.exists) return { installed: false, version: null, path: found.path };
  const version = await readVersion(found.path, env, timeoutMs);
  return { installed: version !== null, version, path: found.path };
}

function splitLines(text) {
  return text.replace(ANSI_RE, '').split(/\r\n|\n|\r/).map((l) => l.trimEnd()).filter((l) => l.trim());
}

function homeOf(env, platform) {
  return (platform === 'win32' ? env.USERPROFILE : env.HOME) || os.homedir();
}

function runInstall({ platform = process.platform, env = process.env, onLog = () => {}, channel = 'stable', timeoutMs = INSTALL_TIMEOUT_MS }) {
  const log = (line) => { try { onLog(line); } catch { /* 화면 쪽 오류가 설치를 막지 않게 */ } };

  return (async () => {
    const before = await checkClaude(env, platform);
    if (before.installed) {
      log(`이미 설치돼 있어요 (버전 ${before.version})`);
      return { ok: true, version: before.version };
    }

    const { cmd, args } = installCommand(platform, channel);
    log('설치를 시작해요. 몇 분 걸릴 수 있어요.');

    const result = await new Promise((resolve) => {
      let child;
      try {
        child = spawn(cmd, args, {
          env,
          cwd: homeOf(env, platform),
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: process.platform !== 'win32', // 늦으면 curl·bash까지 무리째 끌 수 있게
          windowsHide: true,
        });
      } catch {
        resolve({ code: -1, timedOut: false });
        return;
      }
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
      const pending = { stdout: '', stderr: '' };
      const pump = (name) => (d) => {
        const text = pending[name] + d.toString('utf8');
        const cut = Math.max(text.lastIndexOf('\n'), text.lastIndexOf('\r'));
        pending[name] = cut < 0 ? text : text.slice(cut + 1);
        if (cut >= 0) splitLines(text.slice(0, cut + 1)).forEach(log);
      };
      child.stdout.on('data', pump('stdout'));
      child.stderr.on('data', pump('stderr'));
      child.on('error', () => {});
      child.on('close', (code) => {
        clearTimeout(timer);
        splitLines(pending.stdout + '\n' + pending.stderr).forEach(log);
        resolve({ code, timedOut });
      });
    });

    // 문서 명령은 `curl … | bash`라서 내려받기가 실패해도 종료 코드가 0일 수 있다. 그래서 다시 확인한다.
    const after = await checkClaude(env, platform);
    const ok = result.code === 0 && after.installed;
    if (ok) log(`설치를 마쳤어요 (버전 ${after.version})`);
    else if (result.timedOut) log('설치가 너무 오래 걸려서 멈췄어요. 다시 눌러 주세요.');
    else log('설치하지 못했어요. 인터넷 연결을 확인하고 다시 눌러 주세요.');
    return { ok, version: ok ? after.version : null };
  })();
}

// 버튼을 여러 번 눌러도 설치는 한 번만 돈다.
let running = null;
function installClaude(options = {}) {
  if (!running) running = runInstall(options).finally(() => { running = null; });
  return running;
}

module.exports = { checkClaude, installCommand, installClaude };
