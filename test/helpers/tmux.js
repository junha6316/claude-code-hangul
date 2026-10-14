// 시험용 tmux 도우미. 작업마다 고유한 소켓(-L)으로 서버를 따로 띄우고, 끝나면 kill-server 한다.
// 사용자 ~/.tmux.conf는 읽지 않는다(-f 로 전용 설정 파일).
//
//   const tmux = require('./helpers/tmux');
//   const t = tmux.start({ socket: 'kct-T3', command: claudePath, args: [], cwd: work, env, cols: 120, rows: 40 });
//   await t.waitFor(/Yes, I trust this folder/, { timeoutMs: 15000 });
//   t.send('Down', 'Enter');          // tmux 키 이름 (Enter, Escape, Down, C-c ...)
//   t.sendLiteral('한글 입력');        // 글자 그대로
//   const screen = t.capture(file);   // 보이는 화면 문자열. file을 주면 그 파일에도 쓴다
//   t.kill();                         // 서버째 끈다
//
// 옵션
//   command, args  pane에서 띄울 프로그램과 인자. 셸을 거치지 않고 바로 실행한다
//   env            pane 프로그램의 환경 전체. `env -i`로 이것만 넘기므로 부모 환경이 섞이지 않는다
//   socket         -L 소켓 이름. 기본은 kct-<pid>-<번호>. 작업 ID를 넣어 쓰는 것을 권한다
//   tmpDir         소켓을 둘 폴더(TMUX_TMPDIR). 기본은 app/.test-tmp/tmux (/tmp를 쓰지 않는다)
//   cols, rows     화면 크기
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const APP_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_TMPDIR = path.join(APP_ROOT, '.test-tmp', 'tmux');
let counter = 0;

function findTmux() {
  const dirs = (process.env.PATH || '').split(path.delimiter).concat(['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']);
  for (const d of dirs) {
    const p = path.join(d, 'tmux');
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* 다음 */ }
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function start({
  command,
  args = [],
  cwd = process.cwd(),
  env = process.env,
  cols = 120,
  rows = 40,
  socket = `kct-${process.pid}-${++counter}`,
  session = 'main',
  tmpDir = DEFAULT_TMPDIR,
} = {}) {
  if (!command) throw new Error('tmux.start: command가 필요합니다');
  const bin = findTmux();
  if (!bin) throw new Error('tmux를 찾지 못했습니다');

  fs.mkdirSync(tmpDir, { recursive: true });
  const conf = path.join(tmpDir, `${socket}.conf`); // 소켓마다 따로 둬서 동시에 도는 시험끼리 겹치지 않게 한다
  // remain-on-exit: 프로그램이 끝나도 마지막 화면을 캡처할 수 있게 pane을 남긴다.
  fs.writeFileSync(conf, [
    'set -g remain-on-exit on',
    'set -g status off',
    'set -g history-limit 10000',
    '',
  ].join('\n'));

  const clientEnv = { ...process.env, TMUX_TMPDIR: tmpDir };
  delete clientEnv.TMUX;
  delete clientEnv.TMUX_PANE;
  const tm = (...a) => execFileSync(bin, ['-u', '-L', socket, '-f', conf, ...a], {
    env: clientEnv,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const paneEnv = { ...env };
  if (!paneEnv.TERM) paneEnv.TERM = 'xterm-256color';
  const kv = Object.entries(paneEnv)
    .filter(([k, v]) => v !== undefined && k && !k.includes('='))
    .map(([k, v]) => `${k}=${v}`);

  // 인자를 여러 개로 주면 tmux는 셸 없이 바로 실행한다.
  tm('new-session', '-d', '-s', session, '-x', String(cols), '-y', String(rows), '-c', cwd,
    '/usr/bin/env', '-i', ...kv, command, ...args);

  const target = `${session}:0.0`;
  let killed = false;

  const handle = {
    socket,
    session,
    tmpDir,
    capture(outFile) {
      const text = tm('capture-pane', '-p', '-t', target);
      if (outFile) {
        fs.mkdirSync(path.dirname(outFile), { recursive: true });
        fs.writeFileSync(outFile, text);
      }
      return text;
    },
    send(...keys) {
      tm('send-keys', '-t', target, ...keys);
    },
    sendLiteral(text) {
      tm('send-keys', '-t', target, '-l', text);
    },
    async waitFor(pattern, { timeoutMs = 15000, intervalMs = 200 } = {}) {
      const re = pattern instanceof RegExp ? pattern : new RegExp(pattern);
      const end = Date.now() + timeoutMs;
      let last = '';
      while (Date.now() < end) {
        try { last = handle.capture(); } catch { /* 서버가 아직 준비 안 됨 */ }
        if (re.test(last)) return last;
        await sleep(intervalMs);
      }
      const err = new Error(`tmux 화면에서 ${re} 를 ${timeoutMs}ms 안에 찾지 못했습니다\n--- 마지막 화면 ---\n${last}`);
      err.screen = last;
      throw err;
    },
    panePid() {
      try { return Number(tm('display-message', '-p', '-t', target, '#{pane_pid}').trim()) || null; } catch { return null; }
    },
    isDead() {
      try { return tm('display-message', '-p', '-t', target, '#{pane_dead}').trim() === '1'; } catch { return true; }
    },
    kill() {
      if (killed) return;
      killed = true;
      const pid = handle.panePid();
      let sockPath = '';
      try { sockPath = tm('display-message', '-p', '#{socket_path}').trim(); } catch { /* 이미 꺼짐 */ }
      try { tm('kill-server'); } catch { /* 이미 꺼짐 */ }
      if (pid) {
        try { process.kill(pid, 'SIGTERM'); } catch { /* 이미 끝남 */ }
      }
      // kill-server 뒤에도 소켓 파일이 남으므로 지운다.
      if (sockPath) fs.rmSync(sockPath, { force: true });
      fs.rmSync(conf, { force: true });
    },
  };
  return handle;
}

module.exports = { start, findTmux, DEFAULT_TMPDIR };
