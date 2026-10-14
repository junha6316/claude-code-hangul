// T10 시험 자료 캡처: 실제 claude 화면을 가짜 설정과 tmux로 찍어 v<버전>/ 아래에 둔다.
//
//   cd app && node test/fixtures/term/capture.js           모든 화면을 80칸·120칸으로 캡처
//   cd app && node test/fixtures/term/capture.js trust     이름에 trust가 든 것만
//   cd app && node test/fixtures/term/capture.js --copy-review   review/의 10/13 캡처를 review/ 아래로 옮긴다(claude를 띄우지 않음)
//
// 공통 규칙
// - 실제 ~/.claude, ~/.claude.json은 쓰지 않는다. test/helpers/fakeClaudeHome.js의 가짜 설정 폴더와 가짜 키만 쓴다.
//   끝에 실제 ~/.claude.json의 projects와 ~/.claude/settings.json 수정 시각이 그대로인지 확인한다.
// - 실제 모델을 부르지 않는다. auth-error 화면만 가짜 키로 요청을 보내고, 인증 오류로 끝난다.
// - 브라우저가 열리지 않게 BROWSER=/usr/bin/true를 넣는다.
// - tmux는 고유한 -L 소켓(kctT10-…)을 쓰고 화면마다 kill-server 한다.
// - 산출물: 화면은 test/fixtures/term/v<버전>/<이름>.txt, 캡처 기록은 같은 폴더 manifest.json.
//   커서 위치는 화면을 찍는 바로 그 tmux 호출에서 같이 읽는다(shot). 시나리오가 끝난 뒤에 읽으면 마지막 화면의 커서가 된다.
//   작업 폴더·가짜 설정은 app/.test-tmp/T10/cap/ 아래에 만든다.
// - 화면 글에서 실제 홈 폴더 경로는 /Users/tester로 바꾸고, 줄 끝 공백만 지운다. 줄 수는 화면 그대로 둔다.
// - <이름>.expected.json이 이미 있으면 cols·cursorRow·source만 새로 쓰고 mustCover·mustNotCover는 그대로 둔다.
//   다시 캡처한 뒤에는 node test/fixtures/term/make-expected.js로 mustCover·mustNotCover를 다시 채운다(커서 줄은 mustCover에서 빠진다).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const APP_DIR = path.resolve(__dirname, '..', '..', '..');
const { createFakeClaudeHome } = require(path.join(APP_DIR, 'test', 'helpers', 'fakeClaudeHome'));
const tmux = require(path.join(APP_DIR, 'test', 'helpers', 'tmux'));
const { displayWidth } = require(path.join(APP_DIR, 'src', 'shared', 'termKorean'));

const WORK_BASE = path.join(APP_DIR, '.test-tmp', 'T10', 'cap');
const SANITIZED_HOME = '/Users/tester';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findRealClaude() {
  const candidates = [path.join(os.homedir(), '.local', 'bin', 'claude')];
  for (const d of (process.env.PATH || '').split(path.delimiter)) candidates.push(path.join(d, 'claude'));
  return candidates.find((p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } }) || null;
}

const CLAUDE = findRealClaude();
const VERSION = CLAUDE
  ? execFileSync(CLAUDE, ['--version'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: os.homedir() } }).trim()
  : '';
const SHORT_VERSION = (/^(\d+\.\d+\.\d+)/.exec(VERSION) || [])[1] || 'unknown';
const OUT = path.join(__dirname, `v${SHORT_VERSION}`);

// ── 실제 설정 지키기 ──

function realState() {
  const file = path.join(os.homedir(), '.claude.json');
  let keys = [];
  for (let i = 0; i < 5; i++) {
    try { keys = Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).projects || {}); break; } catch (e) {
      if (e.code === 'ENOENT') break; // 다른 세션이 쓰는 중이면 다시 읽는다
    }
  }
  let settingsMtime = null;
  try { settingsMtime = fs.statSync(path.join(os.homedir(), '.claude', 'settings.json')).mtimeMs; } catch { /* 없음 */ }
  return { keys, settingsMtime };
}

// ── tmux로 띄우기 ──

const handles = [];
let launches = 0;

// 앱이 쓸 설정과 비슷하게: 가짜 설정 + 브라우저 막기. 마지막으로 본 릴리스 노트를 지금 버전으로 둬서
// "새로 바뀐 점" 화면이 끼어들지 않게 한다(가짜 .claude.json만 고친다).
function launch(name, { onboarded = true, withKey = true, approveKey = true, trusted = false, cols, rows, mcp = null, env: extraEnv = {} }) {
  const dir = path.join(WORK_BASE, name);
  fs.rmSync(dir, { recursive: true, force: true });
  const work = path.join(dir, 'work');
  fs.mkdirSync(work, { recursive: true });
  const fake = createFakeClaudeHome({ dir: path.join(dir, 'home'), trustedPaths: trusted ? [work] : [], onboarded, withKey, approveKey });
  const j = JSON.parse(fs.readFileSync(fake.claudeJsonPath, 'utf8'));
  j.lastReleaseNotesSeen = SHORT_VERSION;
  fs.writeFileSync(fake.claudeJsonPath, JSON.stringify(j, null, 2));
  // .mcp.json은 가짜 설정을 만든 뒤에 둔다(fakeClaudeHome은 찾은 .mcp.json 서버를 꺼 두기 때문).
  // 명령은 실행되지 않는다(서버를 쓸지 묻는 화면에서 멈춘다). 그래도 혹시 몰라 아무것도 안 하는 /usr/bin/false로 둔다.
  if (mcp) {
    const servers = {};
    for (const n of mcp) servers[n] = { command: '/usr/bin/false', args: [] };
    fs.writeFileSync(path.join(work, '.mcp.json'), JSON.stringify({ mcpServers: servers }, null, 2));
  }
  const env = { ...fake.env, BROWSER: '/usr/bin/true', ...extraEnv };
  const socket = `kctT10-${process.pid}-${++launches}`;
  const h = tmux.start({ socket, command: CLAUDE, args: [], cwd: work, env, cols, rows });
  handles.push(h);
  return { h, work, info: { onboarded, withKey, approveKey, trusted, cols, rows, mcp, env: Object.keys(extraEnv) } };
}

function tmuxCmd(h, ...args) {
  const env = { ...process.env, TMUX_TMPDIR: h.tmpDir };
  delete env.TMUX;
  delete env.TMUX_PANE;
  return execFileSync(tmux.findTmux(), ['-u', '-L', h.socket, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// 화면 글과 커서 위치를 tmux 한 번 부를 때(capture-pane ; display-message) 같이 읽는다.
// tmux 서버가 두 명령을 이어서 처리하므로 글과 커서 사이에 틈이 거의 없다. 출력의 마지막 줄이 커서 위치다.
function captureWithCursor(h) {
  const target = `${h.session}:0.0`;
  const out = tmuxCmd(h, 'capture-pane', '-p', '-t', target, ';', 'display-message', '-p', '-t', target, '#{cursor_x} #{cursor_y} #{cursor_flag}');
  const body = out.replace(/\n$/, '');
  const nl = body.lastIndexOf('\n');
  const [x, y, visible] = body.slice(nl + 1).trim().split(' ').map(Number);
  return { text: `${body.slice(0, nl)}\n`, cursor: { x, y, visible: visible === 1 } };
}

// 바이트 그대로 보내기(앱이 pty에 쓰는 것과 같게)
function sendBytes(h, keys) {
  const hex = [...Buffer.from(keys, 'utf8')].map((b) => b.toString(16).padStart(2, '0'));
  tmuxCmd(h, 'send-keys', '-t', `${h.session}:0.0`, '-H', ...hex);
}

const RULE = /^\s*─{8,}\s*$/;
function isIdle(text) {
  const lines = text.split('\n');
  return lines.some((l, i) => i > 0 && /^❯(\s|$)/.test(l) && RULE.test(lines[i - 1]));
}

async function waitScreen(h, pred, what, timeoutMs = 30000) {
  const end = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < end) {
    try { last = h.capture(); } catch { /* 아직 준비 안 됨 */ }
    if (pred(last)) {
      await sleep(600); // 다 그려질 때까지 잠깐 더 기다린다
      try { last = h.capture(); } catch { /* 끝남 */ }
      if (pred(last)) return last;
    }
    if (h.isDead() && !pred(last)) break;
    await sleep(200);
  }
  throw new Error(`${what}: ${timeoutMs}ms 안에 기대한 화면이 나오지 않았습니다\n--- 마지막 화면 ---\n${last}`);
}

// 저장할 화면 한 장: 기대한 화면이 나오면 그 순간의 글과 커서 위치를 같이 찍는다 → { text, cursor, at }.
// 커서는 이 화면을 찍을 때 읽어야 한다. 시나리오가 끝난 뒤에 읽으면 마지막 화면의 커서가 된다.
async function shot(h, pred, what, timeoutMs = 30000) {
  await waitScreen(h, pred, what, timeoutMs);
  const end = Date.now() + 5000;
  let s = captureWithCursor(h);
  while (!pred(s.text) && Date.now() < end) {
    await sleep(200);
    s = captureWithCursor(h);
  }
  if (!pred(s.text)) throw new Error(`${what}: 커서와 함께 찍는 사이에 화면이 바뀌었습니다\n--- 마지막 화면 ---\n${s.text}`);
  return { ...s, at: new Date().toISOString() };
}

const keyNote = (keys) => keys.map((k) => ({ keys: k, hex: [...Buffer.from(k, 'utf8')].map((b) => b.toString(16).padStart(2, '0')).join(' ') }));

// ── 저장 ──

const manifest = { claudeVersion: VERSION, capturedAt: null, command: 'cd app && node test/fixtures/term/capture.js', how: '', screens: [] };
const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));

// snap = shot()의 { text, cursor, at }. 커서는 화면을 찍은 그 순간의 것이다.
function save(name, snap, info, before, note) {
  const cur = snap.cursor;
  const lines = snap.text.replace(/\n$/, '').split('\n').map((l) => l.split(os.homedir()).join(SANITIZED_HOME).replace(/\s+$/, ''));
  fs.writeFileSync(path.join(OUT, `${name}.txt`), `${lines.join('\n')}\n`);
  const entry = { file: `${name}.txt`, note, launch: info, before: keyNote(before), cursor: cur, rows: lines.length, capturedAt: snap.at };
  manifest.screens.push(entry);

  const expPath = path.join(OUT, `${name}.expected.json`);
  let exp = { cols: info.cols, cursorRow: cur.y, mustCover: [], mustNotCover: [], source: '' };
  try { exp = { ...exp, ...JSON.parse(fs.readFileSync(expPath, 'utf8')) }; } catch { /* 처음 */ }
  exp.cols = info.cols;
  exp.cursorRow = cur.y;
  exp.source = `claude ${SHORT_VERSION} 실제 캡처: ${manifest.command} (${note})`;
  fs.writeFileSync(expPath, `${JSON.stringify(exp, null, 2)}\n`);
  console.log(`  ${name}.txt  ${lines.length}줄, 커서 (${cur.x}, ${cur.y})${cur.visible ? '' : ' 숨김'}`);
}

// ── 캡처할 화면 ──
// 각 항목: [이름, 띄우는 설정, async(h) → [[이름 덧붙임, shot()의 화면·커서, 보낸 키, 설명], ...]]
// 저장할 화면은 반드시 shot()으로 찍는다(커서를 그 순간에 읽는다). 중간에 기다리기만 할 때는 waitScreen()을 쓴다.

const SIZES = [[80, 30], [120, 36]];

const SCENARIOS = [
  ['first-run', { onboarded: false, withKey: false }, async (h) => {
    const out = [];
    out.push(['theme', await shot(h, (t) => /Choose the text style/.test(t), '테마 화면'), [], '첫 실행 테마 고르기(온보딩 안 함, 키 없음)']);
    sendBytes(h, '\r');
    out.push(['login-method', await shot(h, (t) => /Select login method:/.test(t), '로그인 방법'), ['\r'], '로그인 방법 고르기(테마에서 Enter)']);
    sendBytes(h, '\r');
    out.push(['login-browser', await shot(h, (t) => /Paste code here if prompted/.test(t), '브라우저 로그인 대기'), ['\r', '\r'], '구독 계정 로그인을 고른 뒤 브라우저 로그인 대기']);
    return out;
  }],
  ['key-unapproved', { onboarded: false, approveKey: false }, async (h) => {
    await waitScreen(h, (t) => /Choose the text style/.test(t), '테마 화면');
    sendBytes(h, '\r');
    return [['api-key', await shot(h, (t) => /Do you want to use this API key\?/.test(t), '키 승인'), ['\r'], '가짜 키를 쓸지 묻기(키 미승인, 테마에서 Enter)']];
  }],
  ['key-approved', { onboarded: false }, async (h) => {
    await waitScreen(h, (t) => /Choose the text style/.test(t), '테마 화면');
    sendBytes(h, '\r');
    return [['security-notes', await shot(h, (t) => /Security notes:/.test(t), '보안 안내'), ['\r'], '보안 안내 뒤 Enter로 넘기기(키 승인됨, 테마에서 Enter)']];
  }],
  ['untrusted', {}, async (h) => [['trust', await shot(h, (t) => /Yes, I trust this folder/.test(t), '신뢰 창'), [], '폴더 신뢰 창(믿지 않는 폴더)']]],
  ['mcp-one', { trusted: true, mcp: ['demo-server'] }, async (h) => [['mcp-new-server', await shot(h, (t) => /New MCP server found/.test(t), '새 MCP 서버 창'), [], '믿는 작업 폴더에 .mcp.json(서버 1개)']]],
  ['mcp-two', { trusted: true, mcp: ['demo-server', 'notes-server'] }, async (h) => [['mcp-new-servers', await shot(h, (t) => /new MCP servers found/.test(t), '새 MCP 서버 여러 개 창'), [], '믿는 작업 폴더에 .mcp.json(서버 2개)']]],
  ['idle', { trusted: true }, async (h) => {
    const out = [];
    out.push(['idle', await shot(h, (t) => isIdle(t) && /for shortcuts/.test(t), '입력 대기'), [], '믿는 폴더 입력 대기(머리말, 모드 줄)']);
    const before = [];
    // shift+tab(\x1b[Z)으로 허락 방식을 돌린다. 화면 아래 줄이 바뀔 때마다 캡처한다.
    let prevFooter = '';
    for (let i = 1; i <= 4; i++) {
      const prev = h.capture();
      prevFooter = prev.split('\n').filter((l) => /mode on|for shortcuts|accept edits/.test(l)).join('\n');
      sendBytes(h, '\x1b[Z');
      before.push('\x1b[Z');
      const s = await shot(h, (t) => {
        const f = t.split('\n').filter((l) => /mode on|for shortcuts|accept edits/.test(l)).join('\n');
        return f !== prevFooter && isIdle(t);
      }, `shift+tab ${i}번`, 8000).catch(() => null);
      if (!s) break;
      const m = /(accept edits|plan mode|auto mode|manual mode|bypass permissions|don't ask)/i.exec(s.text);
      const tag = m ? m[1].toLowerCase().replace(/[^a-z]+/g, '-') : `cycle-${i}`;
      if (out.some(([n]) => n === `mode-${tag}`)) break; // 한 바퀴 돌았다
      out.push([`mode-${tag}`, s, [...before], `입력 대기에서 shift+tab ${i}번`]);
    }
    return out;
  }],
  // 덮으면 안 되는 긴 화면: / 명령 메뉴, ? 단축키 도움말, /help
  ['menus', { trusted: true }, async (h) => {
    const out = [];
    await waitScreen(h, (t) => isIdle(t) && /for shortcuts/.test(t), '입력 대기');
    sendBytes(h, '/');
    out.push(['slash-menu', await shot(h, (t) => /❯ \/[a-z-]+ {3,}\S/.test(t), '/ 명령 메뉴'), ['/'], '입력 칸에 / 를 쳐서 연 명령 메뉴']);
    sendBytes(h, '\x7f');
    await waitScreen(h, (t) => isIdle(t) && /for shortcuts/.test(t), '입력 대기로 돌아옴');
    sendBytes(h, '?');
    out.push(['shortcuts-help', await shot(h, (t) => /for bash mode|to undo|shift \+ tab|double tap esc/i.test(t), '? 단축키 도움말'), ['/', '\x7f', '?'], '빈 입력 칸에서 ? 를 눌러 연 단축키 도움말']);
    sendBytes(h, '\x7f');
    await sleep(300);
    sendBytes(h, '/help');
    await sleep(500);
    sendBytes(h, '\r');
    out.push(['help', await shot(h, (t) => /Claude Code v[\d.]+/.test(t) && /(general|commands|custom-commands)/i.test(t) && !/for shortcuts/.test(t), '/help 화면'), ['/', '\x7f', '?', '\x7f', '/help', '\r'], '/help 화면']);
    return out;
  }],
  ['idle-hide-cwd', { trusted: true, env: { CLAUDE_CODE_HIDE_CWD: '1' } }, async (h) => [['idle-hide-cwd', await shot(h, (t) => isIdle(t) && /for shortcuts/.test(t), '입력 대기'), [], 'CLAUDE_CODE_HIDE_CWD=1로 띄운 입력 대기(머리말에 경로 없음)']]],
  ['logged-out', { trusted: true, withKey: false }, async (h) => {
    const out = [];
    out.push(['logged-out', await shot(h, (t) => isIdle(t) && /Not logged in/.test(t), '로그인 안 됨 입력 대기'), [], '로그인 안 한 입력 대기(키 없음)']);
    sendBytes(h, '/login');
    await sleep(500);
    sendBytes(h, '\r');
    out.push(['login-slash', await shot(h, (t) => /Select login method:/.test(t), '/login 화면'), ['/login', '\r'], '/login으로 연 로그인 방법 고르기']);
    return out;
  }],
  ['auth-error', { trusted: true }, async (h) => {
    await waitScreen(h, (t) => isIdle(t) && /for shortcuts/.test(t), '입력 대기');
    sendBytes(h, '안녕하세요');
    await sleep(500);
    sendBytes(h, '\r');
    return [['auth-error', await shot(h, (t) => /Invalid API key/.test(t) && isIdle(t), '인증 오류'), ['안녕하세요', '\r'], '가짜 키로 요청 → 인증 오류(실제 모델은 부르지 않음)']];
  }],
];

// ── review/의 10/13 캡처 옮기기(--copy-review) ──
// 허락 창·중단됨처럼 실제 모델 요청이 있어야 뜨는 화면은 다시 찍지 않고 저장소 review/의 캡처(claude 2.1.296)를 옮긴다.
// 홈 폴더 경로만 /Users/tester로 바꾸고 줄 끝 공백을 지운다. 커서 위치는 기록되지 않아 cursorRow는 -1로 둔다.
const REVIEW = [
  ['perm-write-140', 'review/hook/runs/rD/caps/10-write-after-hook-timeout.txt', '파일 만들기 허락 창(accept edits 선택지)'],
  ['perm-bash-140', 'review/hook/runs/rB/caps/20-bash-hook-holding.txt', '명령 실행 허락 창(도움말 줄, 선택지 4개)'],
  ['perm-mcp-tool-140', 'review/hook/runs/rD/caps/31-mcp-holding.txt', 'MCP 도구 사용 허락 창'],
  ['perm-fetch-140', 'review/hook/runs/rC/caps/10-webfetch-holding.txt', '인터넷에서 가져오기 허락 창(No, and tell Claude …)'],
  ['perm-bash-wrapped-100', 'review/korean-input-refute/out/perm_plain.txt#dialog_screen', '100칸 명령 실행 허락 창(선택지가 세 줄로 접힘)'],
  ['interrupted-140', 'review/hook/runs/rD/caps/33-mcp-english-no.txt', '허락 창에서 No → Interrupted 줄'],
  ['login-expires-interrupted-140', 'review/hook-verify/11-after-esc.txt', '로그인 만료 안내 + Interrupted 줄'],
  ['esc-to-interrupt-140', 'review/hook/runs/rD/caps/30-mcp-holding.txt', '일하는 중 모드 줄(esc to interrupt)'],
  ['start-rc-connecting-140', 'review/hook/runs/rD/caps/01-start.txt', '시작 직후(/rc connecting…, ← 2 agents)'],
];

function copyReview() {
  const repo = path.resolve(APP_DIR, '..');
  const out = path.join(__dirname, 'review');
  fs.mkdirSync(out, { recursive: true });
  for (const [name, src, note] of REVIEW) {
    const [file, section] = src.split('#');
    let text = fs.readFileSync(path.join(repo, file), 'utf8');
    if (section) {
      const m = new RegExp(`## ${section}\\n([\\s\\S]*?)(?:\\n## |$)`).exec(text);
      if (!m) throw new Error(`${src}: ${section} 절이 없습니다`);
      text = m[1];
    }
    const lines = text.replace(/\n+$/, '').split('\n').map((l) => l.split(os.homedir()).join(SANITIZED_HOME).replace(/\s+$/, ''));
    fs.writeFileSync(path.join(out, `${name}.txt`), `${lines.join('\n')}\n`);
    const expPath = path.join(out, `${name}.expected.json`);
    // 화면 폭: 가로줄(─) 길이가 곧 화면 폭이다. 없으면 가장 넓은 줄.
    const rule = lines.find((l) => /^─{8,}$/.test(l));
    const cols = rule ? rule.length : Math.max(...lines.map(displayWidth));
    let exp = { cols, cursorRow: -1, mustCover: [], mustNotCover: [], source: '' };
    try { exp = { ...exp, ...JSON.parse(fs.readFileSync(expPath, 'utf8')) }; } catch { /* 처음 */ }
    exp.source = `${src} (claude 2.1.296, 10/13 캡처, ${note}). 커서 위치는 기록되지 않아 -1`;
    fs.writeFileSync(expPath, `${JSON.stringify(exp, null, 2)}\n`);
    console.log(`  review/${name}.txt ← ${src}`);
  }
}

async function main() {
  if (process.argv.includes('--copy-review')) { copyReview(); return; }
  if (!CLAUDE) throw new Error('실제 claude를 찾지 못했습니다');
  if (!tmux.findTmux()) throw new Error('tmux를 찾지 못했습니다');
  fs.mkdirSync(OUT, { recursive: true });
  const before = realState();
  console.log(`claude ${VERSION} → ${path.relative(APP_DIR, OUT)}`);

  const manifestPath = path.join(OUT, 'manifest.json');
  if (only.length) {
    try { manifest.screens = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).screens; } catch { /* 처음 */ }
  }
  for (const [cols, rows] of SIZES) {
    for (const [scen, opts, run] of SCENARIOS) {
      const name = `${scen}-${cols}`;
      if (only.length && !only.some((o) => name.includes(o))) continue;
      console.log(`■ ${name}`);
      const { h, info } = launch(name, { ...opts, cols, rows });
      try {
        const shots = await run(h);
        for (const [shotName, snap, keys, note] of shots) {
          const file = `${shotName}-${cols}`;
          manifest.screens = manifest.screens.filter((s) => s.file !== `${file}.txt`);
          save(file, snap, info, keys, note);
        }
      } catch (e) {
        console.log(`  실패: ${e.message.split('\n')[0]}`);
        fs.mkdirSync(path.join(WORK_BASE, 'errors'), { recursive: true });
        fs.writeFileSync(path.join(WORK_BASE, 'errors', `${name}.txt`), String(e.message).split(os.homedir()).join(SANITIZED_HOME));
      } finally {
        h.kill();
        handles.splice(handles.indexOf(h), 1);
      }
    }
  }
  manifest.capturedAt = new Date().toISOString();
  manifest.how = 'fakeClaudeHome(가짜 CLAUDE_CONFIG_DIR, 가짜 키, lastReleaseNotesSeen을 지금 버전으로) + tmux(-L 고유 소켓, -u). '
    + 'env에 BROWSER=/usr/bin/true. 키는 tmux send-keys -H로 바이트 그대로 보냄(1b 5b 5a는 shift+tab). '
    + '커서 위치는 화면을 찍는 tmux 호출에서 같이 읽음(capture-pane ; display-message #{cursor_x} #{cursor_y} #{cursor_flag}). '
    + '화면마다 찍은 시각은 screens[].capturedAt. 홈 폴더 경로는 /Users/tester로 바꾸고 줄 끝 공백만 지움.';
  manifest.screens.sort((a, b) => a.file.localeCompare(b.file));
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  await sleep(500);
  const after = realState();
  const ours = after.keys.filter((k) => k.includes('.test-tmp') || k.includes('korean-claude-terminal'));
  const settingsSame = before.settingsMtime === after.settingsMtime;
  console.log(`실제 ~/.claude.json 시험 폴더 ${ours.length}개, ~/.claude/settings.json 수정 시각 ${settingsSame ? '그대로' : '바뀜'}`);
  if (ours.length || !settingsSame) process.exitCode = 1;
}

const cleanup = () => { for (const h of handles.splice(0)) { try { h.kill(); } catch { /* 이미 꺼짐 */ } } };
process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });

main().then(cleanup).catch((e) => { cleanup(); console.error(String(e.stack || e).split(os.homedir()).join(SANITIZED_HOME)); process.exitCode = 1; });
