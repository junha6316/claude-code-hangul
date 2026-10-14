// 앱의 연결(T9). Electron을 직접 부르지 않아서 node에서도 돌릴 수 있다. main.js가 창과 함께 붙인다.
//
//   const kct = createKctApp({ send, openPath, settingsDir });
//   registerIpc(win, kct.handlers);   // renderer → main 채널별 처리
//   await kct.start();                // 작업 폴더 → 로그인 셸 환경 → 설치 확인 → 훅 서버 → 설정 파일 → claude
//   await kct.shutdown();             // claude와 훅 서버 정리
//
// 연결
//   pty 출력 → pty:data, 그리고 main 쪽 가상 화면(@xterm/headless) → 300ms 모아 detectScreen → guide:show
//   훅 → korean.js → log:add·perm:show, perm:decide → decide, permission-cleared → perm:clear, status → status:update
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Terminal } = require('@xterm/headless');

const { MAIN_TO_RENDERER: M, RENDERER_TO_MAIN: R, ENV_VARS } = require('../shared/contracts');
const { getLoginShellEnv, buildClaudeEnv } = require('./env');
const { startClaude } = require('./pty');
const { buildSettings, writeSettingsFile, claudeArgs } = require('./settings');
const { startHookServer } = require('./hookServer');
const korean = require('./korean');
const { detectScreen } = require('./screenGuide');
const { checkClaude, installClaude } = require('./installer');

const GUIDE_DELAY_MS = 300;
// renderer가 터미널 크기를 알려 주기를 이만큼 기다렸다가 claude를 띄운다(첫 화면이 크기에 맞게 그려지게).
const FIRST_SIZE_WAIT_MS = 2000;
const STOP_WAIT_MS = 3000;
const DEFAULT_SIZE = Object.freeze({ cols: 100, rows: 30 });
const MAX_INSTALL_LOG = 200;
// 안내 버튼은 claude가 화면을 갈아 끼우게 한다(예: 신뢰 창 → 입력 칸). 그 사이 claude가 잠깐 터미널 입력 모드를 풀어서,
// 버튼을 누르느라 빠졌던 터미널 포커스가 돌아올 때 xterm.js가 보내는 포커스 알림(ESC [ I)이 화면에 "^[[I"로 찍힌다.
// (실측: Enter 뒤 16·50ms에 오면 찍히고 150ms면 괜찮다.) 그래서 안내 버튼 뒤 잠깐은 포커스 알림을 모았다가 마지막 것만 보낸다.
// 갈아 끼우는 동안 claude는 포커스 알림을 끄고(ESC [?1004l) 다 끼우면 다시 켠다(ESC [?1004h). 2.1.299 실측은 Enter 뒤 58ms에 끄고
// 245ms에 켰지만 컴퓨터가 바쁘면 FOCUS_HOLD_MS보다 늦을 수 있다. 그때는 다시 켤 때까지 기다렸다가 보내고, 끝내 켜지 않으면 버린다.
const FOCUS_HOLD_MS = 500;
const FOCUS_WAIT_MAX_MS = 5000;
// eslint-disable-next-line no-control-regex
const FOCUS_REPORT = /\x1b\[[IO]/g;
// eslint-disable-next-line no-control-regex
const FOCUS_MODE = /\x1b\[\?1004([hl])/g;

// 출력에서 마지막으로 포커스 알림을 켰으면 true, 껐으면 false, 둘 다 없으면 null.
function lastFocusMode(text) {
  let last = null;
  for (const m of text.matchAll(FOCUS_MODE)) last = m[1] === 'h';
  return last;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function workdirOf(env) {
  return env[ENV_VARS.WORKDIR] || path.join(os.homedir(), 'Documents', '작업실');
}

// statusline 문서: context_window.used_percentage는 대화 초반에 null일 수 있다.
// 문서 예시(`.context_window.used_percentage // 0`)처럼 0%로 본다.
function withZeroContext(json) {
  const cw = json && json.context_window;
  if (!cw || typeof cw !== 'object' || cw.used_percentage != null) return json;
  return { ...json, context_window: { ...cw, used_percentage: 0 } };
}

// pty 출력을 가상 화면에 그려 두고, 출력이 오면 delayMs 동안 모았다가 보이는 화면 글을 onScreen에 넘긴다.
// 터미널 질의에 대한 답은 renderer의 xterm.js가 하므로 여기서는 pty에 아무것도 쓰지 않는다.
function createScreenWatcher({ cols, rows, delayMs = GUIDE_DELAY_MS, onScreen }) {
  const term = new Terminal({ cols, rows, scrollback: 100 });
  let timer = null;
  let disposed = false;

  function screenText() {
    const b = term.buffer.active;
    const out = [];
    for (let i = 0; i < term.rows; i++) {
      const line = b.getLine(b.viewportY + i);
      out.push(line ? line.translateToString(true) : '');
    }
    return out.join('\n');
  }

  function schedule() {
    if (timer || disposed) return;
    timer = setTimeout(() => {
      timer = null;
      // 앞서 쓴 출력이 모두 그려진 뒤에 읽는다.
      term.write('', () => { if (!disposed) onScreen(screenText()); });
    }, delayMs);
  }

  return {
    write(data) {
      if (disposed) return;
      term.write(data);
      schedule();
    },
    resize(c, r) {
      if (disposed) return;
      term.resize(c, r);
      schedule();
    },
    // 출력이 없어도 화면을 한 번 더 읽는다.
    refresh: schedule,
    screenText,
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
      term.dispose();
    },
  };
}

function createKctApp({ send, openPath = () => {}, settingsDir, env = process.env, platform = process.platform }) {
  const workdir = workdirOf(env);
  let stage = 'idle'; // idle → booting → (missing ↔ installing) → ready → stopped
  let claudeEnv = null;
  let claudePath = null;
  let server = null;
  let settingsFile = null;
  let session = null; // { term, watcher, exited, exitPromise }
  let switching = null;
  let size = null;
  let gotFirstSize;
  const firstSize = new Promise((r) => { gotFirstSize = r; });
  const installLog = [];
  const pendingPermissions = new Set();
  let lastDetected = null;
  let lastGuideKey = 'null';
  let focusHoldUntil = 0;
  let heldFocus = null;
  let focusWaitTimer = null; // claude가 포커스 알림을 다시 켜기를 기다리는 중이면 버릴 때까지의 타이머

  function dropFocus() {
    heldFocus = null;
    clearTimeout(focusWaitTimer);
    focusWaitTimer = null;
  }

  // 붙잡아 둔 포커스 알림을 보낸다. claude가 포커스 알림을 꺼 둔 동안(ESC [?1004l 뒤)이면 다시 켤 때(onData가 다시 부른다)까지
  // 미루고, FOCUS_WAIT_MAX_MS 안에 켜지 않으면 버린다.
  function flushFocus(s) {
    if (!heldFocus) return;
    if (session !== s || s.exited) {
      dropFocus();
      return;
    }
    if (s.focusMode === false) {
      if (!focusWaitTimer) focusWaitTimer = setTimeout(dropFocus, FOCUS_WAIT_MAX_MS);
      return;
    }
    s.term.write(heldFocus);
    dropFocus();
  }

  function log(entry) {
    if (entry && entry.text) send(M.LOG_ADD, { icon: entry.icon, text: entry.text, time: Date.now() });
  }

  // 허락 요청은 훅으로 받은 허락 카드가 맡는다. 터미널에 같은 영어 허락 창이 떠도 안내 카드를 하나 더 띄우지 않는다.
  function showGuide(detected) {
    lastDetected = detected;
    const guide = detected && detected.id === 'permission' && pendingPermissions.size > 0 ? null : detected;
    const key = JSON.stringify(guide);
    if (key === lastGuideKey) return;
    lastGuideKey = key;
    send(M.GUIDE_SHOW, guide);
  }

  // 위 막대를 작업 폴더 이름과 대화 길이 0%로 맞춘다(켤 때, 새 대화를 열 때).
  function resetStatus() {
    const json = { cwd: workdir, context_window: { used_percentage: 0 } };
    const { folderName, contextPercent } = korean.statusParts(json);
    send(M.STATUS_UPDATE, { text: korean.formatStatusLine(json), folderName, contextPercent });
  }

  function wireHooks(srv) {
    srv.events.on('hook', (eventName, body) => {
      if (eventName === 'PreToolUse') log(korean.describeToolStart(body));
      else if (eventName === 'PostToolUse') log(korean.describeToolEnd(body));
      else if (eventName === 'Notification') log(korean.describeNotification(body));
      else if (eventName === 'Stop') log(korean.describeStop(body));
    });
    srv.events.on('permission', (p) => {
      pendingPermissions.add(p.id);
      const { title, detail, danger } = korean.describePermission({
        hook_event_name: 'PermissionRequest',
        session_id: p.sessionId,
        cwd: workdir,
        tool_name: p.toolName,
        tool_input: p.toolInput,
      });
      send(M.PERM_SHOW, { id: p.id, title, detail, danger });
      showGuide(lastDetected);
    });
    srv.events.on('permission-cleared', (id) => {
      pendingPermissions.delete(id);
      send(M.PERM_CLEAR, { id });
      // 답을 받은 claude는 곧 허락 창을 지운다. 지난 화면으로 안내를 띄우지 않고 화면을 다시 읽는다.
      // (시간이 지나 풀린 경우처럼 허락 창이 남아 있으면 그때 안내 카드가 뜬다.)
      if (session && !session.exited) session.watcher.refresh();
    });
    srv.events.on('status', (json, text) => {
      const { folderName, contextPercent } = korean.statusParts(withZeroContext(json));
      send(M.STATUS_UPDATE, { text, folderName, contextPercent });
    });
  }

  function startSession() {
    const { cols, rows } = size || DEFAULT_SIZE;
    const term = startClaude({ claudePath, args: claudeArgs(settingsFile), cwd: workdir, env: claudeEnv, cols, rows });
    // focusMode: claude가 마지막으로 포커스 알림을 켰는지(ESC [?1004h/l, 모르면 null).
    // outTail: 두 출력 조각에 걸쳐 끊긴 ESC [?1004h/l도 찾으려고 남겨 두는 앞 조각의 끝 7글자.
    const s = { term, exited: false, focusMode: null, outTail: '' };
    s.watcher = createScreenWatcher({
      cols,
      rows,
      onScreen: (text) => { if (session === s && !s.exited) showGuide(detectScreen(text)); },
    });
    s.exitPromise = new Promise((resolve) => {
      term.onExit(({ exitCode }) => {
        s.exited = true;
        s.watcher.dispose();
        // "새 대화"나 앱 끄기로 끈 claude는 화면에 알리지 않는다.
        if (session === s) {
          showGuide(null);
          send(M.PTY_EXIT, { code: exitCode });
        }
        resolve();
      });
    });
    term.onData((data) => {
      if (session !== s) return;
      send(M.PTY_DATA, data);
      s.watcher.write(data);
      const mode = lastFocusMode(s.outTail + data);
      s.outTail = data.slice(-7);
      if (mode !== null) {
        s.focusMode = mode;
        if (mode && focusWaitTimer) flushFocus(s);
      }
    });
    session = s;
  }

  async function stopSession() {
    const s = session;
    session = null;
    dropFocus(); // 끄는 claude에 보내려고 붙잡아 둔 포커스 알림은 버린다
    if (!s) return;
    if (!s.exited) {
      s.term.kill(); // pty.js가 1.5초 뒤에도 남아 있으면 무리째 SIGKILL로 끈다
      await Promise.race([s.exitPromise, sleep(STOP_WAIT_MS)]);
    }
    s.watcher.dispose();
  }

  async function launch(foundPath) {
    claudePath = foundPath;
    if (!server) {
      const srv = await startHookServer({
        formatStatusLine: (json) => korean.formatStatusLine(withZeroContext(json)),
      });
      if (stage === 'stopped') {
        await srv.close();
        return;
      }
      server = srv;
      wireHooks(server);
    }
    settingsFile = writeSettingsFile(buildSettings({ port: server.port, token: server.token, platform }), settingsDir);
    await Promise.race([firstSize, sleep(FIRST_SIZE_WAIT_MS)]);
    if (stage === 'stopped') return;
    stage = 'ready';
    startSession();
  }

  async function boot() {
    fs.mkdirSync(workdir, { recursive: true });
    resetStatus();
    const loginEnv = await getLoginShellEnv();
    claudeEnv = buildClaudeEnv(loginEnv, env);
    const found = await checkClaude(claudeEnv, platform);
    if (stage === 'stopped') return;
    if (!found.installed) {
      stage = 'missing';
      send(M.INSTALL_STATE, { installed: false, version: null, phase: 'missing', log: [] });
      return;
    }
    send(M.INSTALL_STATE, { installed: true, version: found.version, phase: 'done', log: [] });
    await launch(found.path);
  }

  async function install() {
    if (stage !== 'missing') return;
    stage = 'installing';
    installLog.length = 0;
    const state = (phase) => send(M.INSTALL_STATE, { installed: false, version: null, phase, log: [...installLog] });
    state('installing');
    const r = await installClaude({
      platform,
      env: claudeEnv,
      onLog: (line) => {
        installLog.push(line);
        if (installLog.length > MAX_INSTALL_LOG) installLog.shift();
        state('installing');
      },
    });
    if (stage === 'stopped') return;
    const found = r.ok ? await checkClaude(claudeEnv, platform) : null;
    if (stage === 'stopped') return;
    if (!found || !found.installed) {
      stage = 'missing';
      state('failed');
      return;
    }
    send(M.INSTALL_STATE, { installed: true, version: found.version, phase: 'done', log: [...installLog] });
    await launch(found.path);
  }

  function newSession() {
    if (stage !== 'ready') return null;
    if (!switching) {
      switching = (async () => {
        await stopSession();
        showGuide(null);
        resetStatus();
        if (stage === 'ready') startSession();
      })().finally(() => { switching = null; });
    }
    return switching;
  }

  function failed(err) {
    console.error('[app] 처리 중 오류:', err);
    log({ icon: '⚠️', text: '준비하다가 문제가 생겼어요. 앱을 껐다가 다시 켜 주세요.' });
  }

  const handlers = {
    [R.PTY_INPUT]: (data) => {
      if (typeof data !== 'string' || !session) return;
      let text = data;
      const wait = focusHoldUntil - Date.now();
      if (wait > 0) {
        const reports = text.match(FOCUS_REPORT);
        if (reports) {
          if (!heldFocus) {
            const s = session;
            setTimeout(() => flushFocus(s), wait);
          }
          heldFocus = reports[reports.length - 1];
          text = text.replace(FOCUS_REPORT, '');
        }
      }
      if (text) session.term.write(text);
    },
    [R.PTY_RESIZE]: (p) => {
      const cols = Math.floor(Number(p && p.cols));
      const rows = Math.floor(Number(p && p.rows));
      if (!(cols >= 1 && rows >= 1)) return;
      size = { cols, rows };
      gotFirstSize();
      if (session && !session.exited) {
        session.term.resize(cols, rows);
        session.watcher.resize(cols, rows);
      }
    },
    [R.PERM_DECIDE]: (p) => {
      if (server && p && (p.decision === 'allow' || p.decision === 'deny')) server.decide(p.id, p.decision);
    },
    [R.GUIDE_ACTION]: (p) => {
      if (!session || !p || typeof p.keys !== 'string') return;
      session.term.write(p.keys);
      focusHoldUntil = Date.now() + FOCUS_HOLD_MS;
    },
    [R.SESSION_NEW]: () => {
      const p = newSession();
      if (p) p.catch(failed);
    },
    [R.FOLDER_OPEN]: () => openPath(workdir),
    [R.INSTALL_START]: () => install().catch(failed),
  };

  return {
    handlers,
    start() {
      if (stage !== 'idle') return Promise.resolve();
      stage = 'booting';
      return boot().catch(failed);
    },
    claudePid: () => (session && !session.exited ? session.term.pid : null),
    async shutdown() {
      stage = 'stopped';
      if (switching) await switching;
      await stopSession();
      if (server) await server.close();
    },
  };
}

module.exports = { createKctApp };
