#!/usr/bin/env node
// 시험용 가짜 claude(T7). 실제 모델을 부르지 않고, 파일도 만들지 않는다.
//
//   node test/fixtures/fake-claude.js --settings <kct-settings.json>   화면 시험·통합 시험용
//   node test/fixtures/fake-claude.js --version                        "2.1.296 (Claude Code)"
//   node test/fixtures/fake-claude.js --self-test                      시험 서버를 띄워 스스로 확인
//
// 하는 일
//   1. 시작할 때 FAKE_PID=<pid>, FAKE_PATH=<PATH>를 출력한다.
//   2. 실제 claude 2.1.296의 폴더 신뢰 창과 같은 문구를 출력한다(app/.test-tmp/T1/claude-untrusted.txt 캡처와 같은 글).
//      실제처럼 처음 고른 칸은 "No, exit"이다. ↓/↑로 고르고 Enter로 정한다. 1·2 숫자는 그 칸을 바로 고른다.
//      "Yes, I trust this folder"로 정하면 화면을 지우고 `❯ ` 입력 대기를 보인다. "No, exit"나 Esc면 끝난다(종료 코드 1).
//   3. 한 줄을 받으면 Write 도구를 흉내 내어 아래 순서로 훅을 보낸다.
//      PreToolUse → PermissionRequest(응답을 기다려 `FAKE: allow`·`FAKE: deny`, 빈 응답이면 `FAKE: none`)
//      → PostToolUse → statusLine 명령 실행 결과 출력 → Stop
//   훅 주소와 statusLine 명령은 --settings 파일(또는 JSON 문자열)에서 읽는다. 형식은 hooks·statusline 문서를 따른다.
'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const FAKE_VERSION = '2.1.296';
const DEFAULT_HOOK_TIMEOUT_S = 600; // hooks 문서: http 훅 기본 600초
const STATUS_TIMEOUT_MS = 5000;

// ── 인자·설정 ──
function parseArgs(argv) {
  const r = { settings: null, version: false, selfTest: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--settings') r.settings = argv[++i];
    else if (a.startsWith('--settings=')) r.settings = a.slice('--settings='.length);
    else if (a === '--version' || a === '-v') r.version = true;
    else if (a === '--self-test') r.selfTest = true;
  }
  return r;
}

// --settings는 파일 경로나 JSON 문자열을 받는다(cli-reference).
function loadSettings(arg) {
  if (!arg) return {};
  const raw = arg.trim().startsWith('{') ? arg : fs.readFileSync(arg, 'utf8');
  return JSON.parse(raw);
}

function matcherMatches(matcher, toolName) {
  if (matcher === undefined || matcher === null || matcher === '' || matcher === '*') return true;
  if (!toolName) return false;
  try { return new RegExp(`^(?:${matcher})$`).test(toolName); } catch { return false; }
}

// 설정에서 이 이벤트에 걸린 http 훅들을 꺼낸다.
function hookTargets(settings, event, toolName) {
  const groups = (settings.hooks && settings.hooks[event]) || [];
  const out = [];
  for (const g of groups) {
    if (!matcherMatches(g.matcher, toolName)) continue;
    for (const h of g.hooks || []) {
      if (h.type !== 'http' || !h.url) continue;
      out.push({
        url: h.url,
        headers: interpolateHeaders(h.headers, h.allowedEnvVars),
        timeoutMs: (Number(h.timeout) > 0 ? Number(h.timeout) : DEFAULT_HOOK_TIMEOUT_S) * 1000,
      });
    }
  }
  return out;
}

// hooks 문서: header 값의 $VAR·${VAR}는 allowedEnvVars에 있는 것만 풀고, 나머지는 빈 문자열.
function interpolateHeaders(headers, allowed = []) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    out[k] = String(v).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, a, b) => {
      const name = a || b;
      return allowed.includes(name) ? (process.env[name] || '') : '';
    });
  }
  return out;
}

function postJson(url, body, { headers = {}, timeoutMs = 10000 } = {}) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch (e) { resolve({ status: 0, text: '', error: e.message }); return; }
    const data = Buffer.from(JSON.stringify(body));
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', 'Content-Length': data.length },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', (e) => resolve({ status: res.statusCode || 0, text: '', error: e.message }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ status: 0, text: '', error: e.message }));
    req.end(data);
  });
}

// ── 글자 폭(한글 2칸) ──
function charWidth(ch) {
  const c = ch.codePointAt(0);
  if (c < 0x20) return 0;
  if ((c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3)
    || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60)
    || (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1faff)) return 2;
  return 1;
}
const strWidth = (s) => [...s].reduce((n, ch) => n + charWidth(ch), 0);

// 단어 단위로 접는다. 한 단어가 너무 길면(경로 등) 글자 단위로 자른다.
function wrap(text, width) {
  const lines = [];
  let line = '';
  const pushWord = (word) => {
    const sep = line ? ' ' : '';
    if (strWidth(line + sep + word) <= width) { line += sep + word; return; }
    if (line) { lines.push(line); line = ''; }
    while (strWidth(word) > width) {
      let cut = '';
      for (const ch of word) { if (strWidth(cut + ch) > width) break; cut += ch; }
      lines.push(cut);
      word = word.slice(cut.length);
    }
    line = word;
  };
  for (const word of text.split(' ')) pushWord(word);
  if (line) lines.push(line);
  return lines;
}

// ── 대화형 가짜 ──
function runInteractive(settings) {
  const out = (s) => process.stdout.write(s);
  const cwd = process.cwd();
  const sessionId = crypto.randomUUID();
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const cols = () => Math.max(40, process.stdout.columns || 80);
  let mode = 'trust'; // trust → prompt → busy → prompt …
  let selected = 0; // 0 = No, exit / 1 = Yes, I trust this folder
  let line = '';
  let turn = 0;

  const header = () => `FAKE_PID=${process.pid}\r\nFAKE_PATH=${process.env.PATH || ''}\r\n`;

  function drawTrust() {
    const w = cols() - 2;
    const L = [''];
    L.push('─'.repeat(cols()));
    L.push(' Accessing workspace:');
    L.push('');
    for (const l of wrap(cwd, w)) L.push(` ${l}`);
    L.push('');
    for (const l of wrap('Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what\'s in this folder first.', w)) L.push(` ${l}`);
    L.push('');
    L.push(" Claude Code'll be able to read, edit, and execute files here.");
    L.push('');
    L.push(' Security guide');
    L.push('');
    L.push(` ${selected === 0 ? '❯' : ' '} No, exit`);
    L.push(` ${selected === 1 ? '❯' : ' '} Yes, I trust this folder`);
    L.push('');
    L.push(' Enter to confirm · Esc to cancel');
    // 화면 전체를 지우고 다시 그린다. FAKE_PID 줄은 늘 맨 위에 남긴다.
    out(`\x1b[2J\x1b[3J\x1b[H${header()}${L.join('\r\n')}\r\n`);
  }

  function drawPromptScreen() {
    out(`\x1b[2J\x1b[3J\x1b[H${header()}`);
    out(`\r\n * 가짜 Claude Code v${FAKE_VERSION} (시험용)\r\n   ${cwd}\r\n\r\n`);
    prompt();
  }

  function prompt() {
    line = '';
    out(`${'─'.repeat(cols())}\r\n❯ `);
  }

  function finish(code) {
    if (process.stdin.isTTY) { try { process.stdin.setRawMode(false); } catch { /* 이미 닫힘 */ } }
    process.exit(code);
  }

  function common(event) {
    return {
      session_id: sessionId,
      transcript_path: path.join(configDir, 'projects', 'fake', `${sessionId}.jsonl`),
      cwd,
      permission_mode: 'default',
      hook_event_name: event,
    };
  }

  async function sendHook(event, toolName, extra) {
    const body = { ...common(event), ...extra };
    const results = [];
    for (const t of hookTargets(settings, event, toolName)) {
      results.push(await postJson(t.url, body, t));
    }
    return results;
  }

  function permissionDecision(results) {
    for (const r of results) {
      if (r.error || r.status < 200 || r.status >= 300) continue;
      const text = (r.text || '').trim();
      if (!text) continue;
      try {
        const d = JSON.parse(text).hookSpecificOutput.decision;
        if (d && (d.behavior === 'allow' || d.behavior === 'deny')) return d;
      } catch { /* 형식이 아니면 다음 훅 */ }
    }
    return results.some((r) => r.error) ? { behavior: 'error' } : { behavior: 'none' };
  }

  function statusInput(percent) {
    // statusline 문서 "Full JSON schema"의 일부 필드.
    return {
      cwd,
      session_id: sessionId,
      transcript_path: path.join(configDir, 'projects', 'fake', `${sessionId}.jsonl`),
      model: { id: 'claude-fake', display_name: 'Fake' },
      workspace: { current_dir: cwd, project_dir: cwd, added_dirs: [] },
      version: FAKE_VERSION,
      output_style: { name: 'default' },
      cost: { total_cost_usd: 0, total_duration_ms: 1000, total_api_duration_ms: 0, total_lines_added: 0, total_lines_removed: 0 },
      context_window: {
        total_input_tokens: percent * 2000,
        total_output_tokens: 100,
        context_window_size: 200000,
        used_percentage: percent,
        remaining_percentage: 100 - percent,
      },
      exceeds_200k_tokens: false,
    };
  }

  function runStatusLine(percent) {
    const cmd = settings.statusLine && settings.statusLine.command;
    if (!cmd) return Promise.resolve(null);
    return new Promise((resolve) => {
      const env = { ...process.env, COLUMNS: String(cols()), LINES: String(process.stdout.rows || 24) };
      const child = spawn(cmd, { shell: true, cwd, env, stdio: ['pipe', 'pipe', 'ignore'] });
      let stdout = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), STATUS_TIMEOUT_MS);
      child.stdout.on('data', (d) => { stdout += d; });
      child.on('error', () => { clearTimeout(timer); resolve(null); });
      child.on('close', () => { clearTimeout(timer); resolve(stdout); });
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify(statusInput(percent)));
    });
  }

  async function runTurn(text) {
    turn += 1;
    const toolUseId = `toolu_fake_${process.pid}_${turn}`;
    const filePath = path.join(cwd, `fake-${turn}.txt`);
    const toolInput = { file_path: filePath, content: text };
    out(`⏺ Write(${path.basename(filePath)})\r\n`);

    await sendHook('PreToolUse', 'Write', { tool_name: 'Write', tool_input: toolInput, tool_use_id: toolUseId });

    out('  ⎿  FAKE: waiting for permission\r\n');
    const decision = permissionDecision(await sendHook('PermissionRequest', 'Write', {
      tool_name: 'Write',
      tool_input: toolInput,
      permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
    }));
    out(`FAKE: ${decision.behavior}\r\n`);
    if (decision.behavior === 'deny' && decision.message) out(`  ⎿  ${decision.message}\r\n`);

    await sendHook('PostToolUse', 'Write', {
      tool_name: 'Write',
      tool_input: toolInput,
      tool_response: { type: 'create', filePath, content: text, structuredPatch: [], originalFile: null, userModified: false },
      tool_use_id: toolUseId,
      duration_ms: 5,
    });

    const percent = Math.min(95, 8 + 16 * turn);
    const status = await runStatusLine(percent);
    if (status !== null) out(`${status.replace(/\r?\n$/, '').replace(/\r?\n/g, '\r\n')}\r\n`);

    await sendHook('Stop', null, { stop_hook_active: false, last_assistant_message: '가짜 응답을 마쳤어요.' });
  }

  // 입력: 붙여넣기 표시를 걷어 내고, 화살표 같은 이스케이프 열은 키 이름으로 바꾼다.
  function tokenize(data) {
    const s = data.replace(/\x1b\[20[01]~/g, '');
    const tokens = [];
    let i = 0;
    while (i < s.length) {
      if (s[i] === '\x1b') {
        const m = /^\x1b(?:\[[0-9;?]*[ -/]*[@-~]|O.)/.exec(s.slice(i));
        if (m) {
          const seq = m[0];
          tokens.push(seq === '\x1b[A' || seq === '\x1bOA' ? 'UP' : seq === '\x1b[B' || seq === '\x1bOB' ? 'DOWN' : 'SEQ');
          i += seq.length;
          continue;
        }
        tokens.push('ESC');
        i += 1;
        continue;
      }
      const ch = String.fromCodePoint(s.codePointAt(i));
      tokens.push(ch);
      i += ch.length;
    }
    return tokens;
  }

  function onTrustKey(tok) {
    if (tok === 'UP' || tok === 'DOWN' || tok === '\t') {
      selected = tok === 'UP' ? 0 : tok === 'DOWN' ? 1 : 1 - selected;
      drawTrust();
    } else if (tok === '1' || tok === '2') {
      selected = tok === '1' ? 0 : 1;
      confirmTrust();
    } else if (tok === '\r' || tok === '\n') {
      confirmTrust();
    } else if (tok === 'ESC' || tok === '\x03') {
      finish(1);
    }
  }

  function confirmTrust() {
    if (selected !== 1) finish(1);
    mode = 'prompt';
    drawPromptScreen();
  }

  function onPromptKey(tok) {
    if (tok === '\r' || tok === '\n') {
      const text = line;
      out('\r\n');
      if (!text.trim()) { prompt(); return; }
      mode = 'busy';
      runTurn(text)
        .catch((e) => out(`FAKE: error ${e && e.message}\r\n`))
        .then(() => { mode = 'prompt'; prompt(); });
    } else if (tok === '\x7f' || tok === '\b') {
      const chars = [...line];
      const last = chars.pop();
      if (last) {
        line = chars.join('');
        const w = charWidth(last);
        out('\b'.repeat(w) + ' '.repeat(w) + '\b'.repeat(w));
      }
    } else if (tok === '\x03') {
      if (line) { line = ''; out('\r\n'); prompt(); } else finish(0);
    } else if (tok === '\x04') {
      finish(0);
    } else if (tok.length >= 1 && tok.codePointAt(0) >= 0x20 && !['UP', 'DOWN', 'SEQ', 'ESC'].includes(tok)) {
      line += tok;
      out(tok);
    }
  }

  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (data) => {
    for (const tok of tokenize(data)) {
      if (mode === 'trust') onTrustKey(tok);
      else if (mode === 'prompt') onPromptKey(tok);
      // busy일 때 들어온 키는 버린다.
    }
  });
  process.stdin.on('end', () => finish(0));

  drawTrust();
}

// ── 스스로 확인(--self-test) ──
// 시험 서버(훅·statusline)를 띄우고, 가짜 claude를 파이프와 pty 두 가지로 띄워 순서를 확인한다.
async function selfTest() {
  const APP_DIR = path.resolve(__dirname, '..', '..');
  const OUT = path.join(APP_DIR, '.test-tmp', 'T7', 'self-test');
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT, 'work'), { recursive: true });
  const report = { startedAt: new Date().toISOString(), checks: [] };
  const check = (name, ok, info) => {
    report.checks.push({ name, ok: !!ok, info });
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info !== undefined ? ` ${typeof info === 'string' ? info : JSON.stringify(info)}` : ''}`);
    return !!ok;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const children = [];

  // 시험 서버
  const token = crypto.randomBytes(8).toString('hex');
  const events = [];
  const held = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const m = new RegExp(`^/${token}/(?:hook/([A-Za-z]+)|(statusline))$`).exec(req.url);
      if (req.method !== 'POST' || !m) { res.writeHead(404).end(); return; }
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* 빈 몸 */ }
      const name = m[1] || 'statusline';
      events.push({ name, body, at: Date.now() });
      if (name === 'statusline') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end('한글상태');
      } else if (name === 'PermissionRequest') {
        held.push(res); // 시험이 결정을 줄 때까지 붙잡는다
      } else {
        res.writeHead(200).end();
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}/${token}`;
  const settings = {
    statusLine: {
      type: 'command',
      command: `curl -sf --max-time 1 --noproxy 127.0.0.1 -H 'Content-Type: application/json' --data-binary @- '${base}/statusline' || echo '작업실'`,
    },
    hooks: {
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'http', url: `${base}/hook/PreToolUse` }] }],
      PostToolUse: [{ matcher: '*', hooks: [{ type: 'http', url: `${base}/hook/PostToolUse` }] }],
      PermissionRequest: [{ matcher: '*', hooks: [{ type: 'http', url: `${base}/hook/PermissionRequest`, timeout: 600 }] }],
      Stop: [{ hooks: [{ type: 'http', url: `${base}/hook/Stop` }] }],
    },
  };
  const settingsFile = path.join(OUT, 'kct-settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2), { mode: 0o600 });

  const childEnv = { ...process.env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  if (process.versions.electron) childEnv.ELECTRON_RUN_AS_NODE = '1';

  function startPipe() {
    const p = spawn(process.execPath, [__filename, '--settings', settingsFile], { cwd: path.join(OUT, 'work'), env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    const h = { out: '', code: undefined, write: (s) => p.stdin.write(s), kill: () => p.kill('SIGTERM'), pid: p.pid };
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (d) => { h.out += d; });
    p.stderr.on('data', (d) => { h.out += d; });
    h.exited = new Promise((r) => p.on('exit', (code, signal) => { h.code = code === null ? signal : code; r(h.code); }));
    children.push(h);
    return h;
  }

  function startPty() {
    let pty;
    try { pty = require(path.join(APP_DIR, 'node_modules', 'node-pty')); } catch { return null; }
    const p = pty.spawn(process.execPath, [__filename, '--settings', settingsFile], {
      name: 'xterm-256color', cols: 100, rows: 30, cwd: path.join(OUT, 'work'), env: childEnv,
    });
    const h = { out: '', code: undefined, write: (s) => p.write(s), kill: () => p.kill(), pid: p.pid };
    p.onData((d) => { h.out += d; });
    h.exited = new Promise((r) => p.onExit(({ exitCode }) => { h.code = exitCode; r(exitCode); }));
    children.push(h);
    return h;
  }

  async function waitFor(fn, ms, what) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(25);
    }
    throw new Error(`${ms}ms 안에 오지 않았습니다: ${what}`);
  }

  // 한 번의 요청을 보내고 순서·결정 출력을 확인한다.
  async function oneTurn(h, label, text, reply, expectOut) {
    const from = events.length;
    const outFrom = h.out.length;
    h.write(`${text}\r`);
    await waitFor(() => held.length > 0, 5000, `${label} PermissionRequest`);
    await sleep(400); // 붙잡힌 동안 다음 이벤트가 오지 않고, 결정도 출력되지 않아야 한다
    const during = events.slice(from).map((e) => e.name);
    check(`${label}: 허락 대기 중에는 PreToolUse·PermissionRequest까지만 왔다`, JSON.stringify(during) === JSON.stringify(['PreToolUse', 'PermissionRequest']), during);
    check(`${label}: 대기 중에는 결정을 출력하지 않았다`, !/FAKE: (allow|deny|none)/.test(h.out.slice(outFrom)));
    const res = held.shift();
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(reply);
    await waitFor(() => events.slice(from).some((e) => e.name === 'Stop'), 8000, `${label} Stop`);
    await waitFor(() => /❯ $/.test(h.out), 3000, `${label} 다음 입력 대기`);
    const seq = events.slice(from).map((e) => e.name);
    check(`${label}: 순서가 PreToolUse → PermissionRequest → PostToolUse → statusline → Stop`,
      JSON.stringify(seq) === JSON.stringify(['PreToolUse', 'PermissionRequest', 'PostToolUse', 'statusline', 'Stop']), seq);
    const after = h.out.slice(outFrom);
    check(`${label}: 받은 결정을 "${expectOut}"로 출력했다`, after.includes(expectOut));
    check(`${label}: statusLine 명령의 결과(한글상태)를 결정 뒤에 출력했다`, after.indexOf('한글상태') > after.indexOf(expectOut));
    const [pre, perm, post, status, stop] = events.slice(from).map((e) => e.body);
    check(`${label}: PreToolUse와 PostToolUse의 tool_use_id가 같고 PermissionRequest에는 없다`,
      pre.tool_use_id && pre.tool_use_id === post.tool_use_id && perm.tool_use_id === undefined, pre.tool_use_id);
    check(`${label}: 네 훅이 모두 같은 session_id와 이벤트 이름을 담았다`,
      [pre, perm, post, stop].every((b) => b.session_id === pre.session_id)
      && pre.hook_event_name === 'PreToolUse' && perm.hook_event_name === 'PermissionRequest'
      && post.hook_event_name === 'PostToolUse' && stop.hook_event_name === 'Stop');
    check(`${label}: tool_input에 보낸 글이 들어 있다`, pre.tool_input.content === text && perm.tool_input.content === text);
    check(`${label}: statusLine 입력에 cwd와 context_window.used_percentage가 있다`,
      status && status.cwd === fs.realpathSync(path.join(OUT, 'work')) && Number.isFinite(status.context_window.used_percentage), status && status.cwd);
  }

  const allowJson = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
  const denyJson = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: '사용자가 거절했어요', interrupt: true } } });

  let ok = true;
  try {
    // 1) 파이프: 시작 출력과 신뢰 창
    const a = startPipe();
    await waitFor(() => /Yes, I trust this folder/.test(a.out) && /Enter to confirm/.test(a.out), 5000, '신뢰 창');
    check('시작할 때 FAKE_PID=<pid>를 출력한다', a.out.includes(`FAKE_PID=${a.pid}`), a.pid);
    check('시작할 때 FAKE_PATH=<PATH>를 출력한다', a.out.includes(`FAKE_PATH=${childEnv.PATH}`));
    check('신뢰 창은 실제 2.1.296과 같은 문구이고 처음 고른 칸은 No, exit다',
      /Accessing workspace:/.test(a.out) && /Quick safety check: Is this a project you created or one you trust\?/.test(a.out)
      && /❯ No, exit/.test(a.out) && /  Yes, I trust this folder/.test(a.out));

    // 2) ↓ Enter로 믿기 → 입력 대기
    a.write('\x1b[B');
    await waitFor(() => /❯ Yes, I trust this folder/.test(a.out), 3000, '↓로 Yes 고르기');
    const before = a.out.length;
    a.write('\r');
    await waitFor(() => /❯ $/.test(a.out.slice(before)), 3000, '입력 대기');
    check('Yes를 고르고 Enter를 누르면 화면을 지우고 ❯ 입력 대기를 보인다',
      a.out.slice(before).includes('\x1b[2J') && !/trust this folder/.test(a.out.slice(before)));

    // 3) allow·deny 두 번
    await oneTurn(a, '파이프·허락', '안녕 가짜 클로드', allowJson, 'FAKE: allow');
    await oneTurn(a, '파이프·거절', '두 번째 요청', denyJson, 'FAKE: deny');
    check('거절 message를 출력한다', a.out.includes('사용자가 거절했어요'));
    a.kill();
    await Promise.race([a.exited, sleep(2000)]);
    check('끝내면 2초 안에 프로세스가 끝난다', a.code !== undefined, a.code);

    // 4) 기본 칸(No, exit)에서 Enter면 끝난다(실제와 같음)
    const b = startPipe();
    await waitFor(() => /Enter to confirm/.test(b.out), 5000, '두 번째 신뢰 창');
    b.write('\r');
    await Promise.race([b.exited, sleep(3000)]);
    check('기본 칸 No, exit에서 Enter를 누르면 종료 코드 1로 끝난다', b.code === 1, b.code);

    // 5) pty: 실제 터미널처럼 raw 모드로 돈다(T9 통합 시험이 쓰는 방식). 숫자 2로 바로 믿기.
    const c = startPty();
    if (c) {
      await waitFor(() => /Enter to confirm/.test(c.out), 5000, 'pty 신뢰 창');
      const pb = c.out.length;
      c.write('2');
      await waitFor(() => /❯ $/.test(c.out.slice(pb)), 3000, 'pty 입력 대기');
      check('pty: 숫자 2를 누르면 Yes로 정하고 입력 대기를 보인다', true);
      c.write('한글 ');
      await waitFor(() => c.out.slice(pb).includes('한글 '), 3000, 'pty 한글 메아리');
      const eb = c.out.length;
      c.write('\x7f\x7f\x7f'); // 한글 두 자와 빈칸을 지운다(한글은 2칸씩 지운다)
      await waitFor(() => c.out.slice(eb) === '\b \b' + '\b\b  \b\b'.repeat(2), 3000, 'pty 지우기');
      check('pty: 입력한 한글을 지우면 2칸씩 지운다', true);
      await oneTurn(c, 'pty·허락', '한글 요청', allowJson, 'FAKE: allow');
      c.kill();
      await Promise.race([c.exited, sleep(2000)]);
      check('pty: kill하면 2초 안에 끝난다', c.code !== undefined, c.code);
    } else {
      check('pty 시험(node-pty가 없어 건너뜀)', true);
    }

    // 6) --version
    const v = await new Promise((resolve) => {
      const p = spawn(process.execPath, [__filename, '--version'], { env: childEnv });
      let s = '';
      p.stdout.on('data', (d) => { s += d; });
      p.on('exit', (code) => resolve({ code, s }));
    });
    check('--version은 실제와 같은 모양(<버전> (Claude Code))으로 출력하고 끝난다', v.code === 0 && /^\d+\.\d+\.\d+ \(Claude Code\)\n$/.test(v.s), v.s.trim());
  } catch (e) {
    check('예상한 흐름대로 진행', false, e.message);
  } finally {
    for (const h of children) { if (h.code === undefined) { try { h.kill(); } catch { /* 이미 끝남 */ } } }
    for (const res of held) { try { res.end(); } catch { /* 이미 끝남 */ } }
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }

  ok = report.checks.every((c) => c.ok);
  report.ok = ok;
  report.events = events.map((e) => ({ name: e.name, body: e.body }));
  report.outputs = children.map((h) => ({ pid: h.pid, code: h.code, out: h.out }));
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  console.log(ok ? 'SELF_TEST_OK' : 'SELF_TEST_FAIL');
  console.log(`기록: ${path.relative(process.cwd(), path.join(OUT, 'report.json'))}`);
  process.exit(ok ? 0 : 1);
}

// ── 시작 ──
const args = parseArgs(process.argv.slice(2));
if (args.version) {
  process.stdout.write(`${FAKE_VERSION} (Claude Code)\n`);
} else if (args.selfTest) {
  const killer = setTimeout(() => { console.log('SELF_TEST_FAIL 60초 안에 끝나지 않았습니다'); process.exit(1); }, 60000);
  killer.unref();
  selfTest();
} else {
  let settings = {};
  try { settings = loadSettings(args.settings); } catch (e) {
    process.stderr.write(`FAKE: settings를 읽지 못했습니다: ${e.message}\n`);
  }
  runInteractive(settings);
}
