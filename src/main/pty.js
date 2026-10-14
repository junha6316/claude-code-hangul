// node-pty로 claude 띄우기(PLAN.md 공통 약속 pty.js).
//
//   const term = startClaude({ claudePath, args, cwd, env, cols, rows });
//   term.onData((text) => ...);                     // 문자열
//   term.onExit(({ exitCode, signal }) => ...);     // 한 번만 불린다
//   term.write('한글\r'); term.resize(120, 40); term.kill();
const fs = require('fs');
const path = require('path');
const pty = require('node-pty');

// kill 뒤 이 시간 안에 안 끝나면 SIGKILL로 끈다.
const KILL_GRACE_MS = 1500;

let helperChecked = false;

// node-pty는 맥·리눅스에서 spawn-helper 실행 파일로 자식을 띄운다. npm 묶음에 실행 권한이
// 빠진 판이 있어(1.1.0) 처음 띄울 때 권한을 준다. 찾는 위치는 node-pty lib/utils.js의
// loadNativeModule, lib/unixTerminal.js의 helperPath와 같다.
function ensureSpawnHelperExecutable(ptyRoot = path.dirname(require.resolve('node-pty/package.json'))) {
  if (process.platform === 'win32') return [];
  const fixed = [];
  const dirs = ['build/Release', 'build/Debug', `prebuilds/${process.platform}-${process.arch}`];
  for (const d of dirs) {
    const helper = path.join(ptyRoot, d, 'spawn-helper')
      .replace('app.asar', 'app.asar.unpacked')
      .replace('node_modules.asar', 'node_modules.asar.unpacked');
    try {
      const { mode } = fs.statSync(helper);
      if ((mode & 0o111) !== 0o111) {
        fs.chmodSync(helper, mode | 0o755);
        fixed.push(helper);
      }
    } catch { /* 없는 위치이거나 읽기 전용 */ }
  }
  return fixed;
}

function startClaude({ claudePath, args = [], cwd, env = process.env, cols = 80, rows = 24 }) {
  if (!helperChecked) {
    ensureSpawnHelperExecutable();
    helperChecked = true;
  }

  let file = claudePath;
  let argv = args;
  let childEnv = { ...env };
  // 시험용 가짜 claude(.js)는 지금 도는 node 또는 Electron으로 띄운다.
  if (/\.js$/i.test(claudePath)) {
    file = process.execPath;
    argv = [claudePath, ...args];
    if (process.versions.electron) childEnv.ELECTRON_RUN_AS_NODE = '1';
  }

  const p = pty.spawn(file, argv, {
    name: childEnv.TERM || 'xterm-256color',
    cols,
    rows,
    cwd,
    env: childEnv,
  });

  let exited = false;
  let killTimer = null;
  p.onExit(() => {
    exited = true;
    clearTimeout(killTimer);
  });

  return {
    pid: p.pid,
    onData(cb) { return p.onData(cb); },
    onExit(cb) { return p.onExit(cb); },
    write(data) {
      if (!exited) p.write(data);
    },
    resize(c, r) {
      // 창이 숨겨질 때 0이 올 수 있다. node-pty는 0 이하에서 예외를 던지므로 무시한다.
      if (exited || !(c >= 1 && r >= 1)) return;
      p.resize(Math.floor(c), Math.floor(r));
    },
    kill() {
      if (exited || killTimer) return;
      p.kill(); // 맥·리눅스는 SIGHUP
      if (process.platform === 'win32') return;
      killTimer = setTimeout(() => {
        if (exited) return;
        // claude가 띄운 자식까지 같이 끈다. node-pty 자식은 새 세션의 무리 대장이다.
        try { process.kill(-p.pid, 'SIGKILL'); } catch {
          try { process.kill(p.pid, 'SIGKILL'); } catch { /* 이미 끝남 */ }
        }
      }, KILL_GRACE_MS);
    },
  };
}

module.exports = { startClaude, ensureSpawnHelperExecutable };
