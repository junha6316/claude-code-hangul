// T3 한국어 설정 생성기 시험.
//   단위 시험: buildSettings가 만든 키와 형식, 금지 키, 훅 주소, 파일 쓰기
//   상태 줄 시험: statusLine 명령을 sh -c로 돌려 시험 서버 응답·기본 문구를 확인
//   통합 시험: 실제 claude(가짜 설정, 믿는 폴더, tmux)를 claudeArgs로 띄워 화면을 확인
// 산출물은 app/.test-tmp/T3/ 아래에만 둔다.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const {
  buildSettings, writeSettingsFile, claudeArgs, SETTINGS_FILE_NAME, FALLBACK_STATUS,
} = require('../src/main/settings');
const { createFakeClaudeHome } = require('./helpers/fakeClaudeHome');
const tmux = require('./helpers/tmux');

const APP_DIR = path.resolve(__dirname, '..');
const REPO_DIR = path.resolve(APP_DIR, '..');
const OUT = path.join(APP_DIR, '.test-tmp', 'T3');
// 저장소에 받아 둔 settings 문서 사본
const SETTINGS_DOC = path.join(REPO_DIR, 'review', 'tech-stack-deploy', 'docs', 'settings-reference.md');
const NO_DOC = !fs.existsSync(SETTINGS_DOC) && '저장소 밖 검토 자료(review/)가 없어 건너뜁니다(공개 저장소)';
// 도움말 근거 문서 사본. 저장소에 없는 문서라 여기에 받아 둔다(없으면 인용문 대조 시험을 건너뛴다).
//   curl -fsSL https://code.claude.com/docs/en/<문서>.md -o app/.test-tmp/T3/docs/<문서>.md
const DOCS_COPY = path.join(OUT, 'docs');

// 도움말 근거 표: 도움말 id → 공식 문서 위치와 그대로 옮긴 문장
const TIP_EVIDENCE = {
  'kct-stop-esc': {
    url: 'https://code.claude.com/docs/en/interactive-mode#general-controls',
    doc: 'interactive-mode.md',
    quote: 'Stop the current response or tool call mid-turn so you can redirect. Claude keeps the work done so far.',
  },
  'kct-queue-message': {
    url: 'https://code.claude.com/docs/en/interactive-mode#queue-messages-while-claude-works',
    doc: 'interactive-mode.md',
    quote: 'Type a message and press `Enter` while Claude is working. Claude Code queues the message instead of interrupting the turn',
  },
  'kct-newline': {
    url: 'https://code.claude.com/docs/en/interactive-mode#multiline-input',
    doc: 'interactive-mode.md',
    quote: '| Control sequence | `Ctrl+J` | Works in any terminal without configuration |',
  },
  'kct-history-up': {
    url: 'https://code.claude.com/docs/en/interactive-mode#command-history',
    doc: 'interactive-mode.md',
    quote: 'Claude Code keeps a history of the prompts you type, and Up-arrow recall reaches prompts from past sessions of the same project',
  },
  'kct-rewind': {
    url: 'https://code.claude.com/docs/en/checkpointing#rewind-and-summarize',
    doc: 'checkpointing.md',
    quote: 'Run `/rewind`, or press `Esc` twice when the prompt input is empty, to open the rewind menu.',
  },
  'kct-clear': {
    url: 'https://code.claude.com/docs/en/commands#all-commands',
    doc: 'commands.md',
    quote: 'Start a new conversation with empty context. Pass a name to label the previous conversation in the `/resume` picker. To free up context while continuing the same conversation, use `/compact` instead. Resume the previous conversation with `/resume`',
  },
  'kct-file-mention': {
    url: 'https://code.claude.com/docs/en/interactive-mode#quick-commands',
    doc: 'interactive-mode.md',
    quote: '| `@` | File path mention | Trigger file path autocomplete.',
  },
};

// statusline 문서(https://code.claude.com/docs/en/statusline#available-data)의 "Full JSON schema" 예시 그대로
const DOC_STATUS_SAMPLE = `{
  "cwd": "/current/working/directory",
  "session_id": "abc123...",
  "session_name": "my-session",
  "prompt_id": "550e8400-e29b-41d4-a716-446655440000",
  "transcript_path": "/path/to/transcript.jsonl",
  "model": {
    "id": "claude-opus-5-5",
    "display_name": "Opus"
  },
  "workspace": {
    "current_dir": "/current/working/directory",
    "project_dir": "/original/project/directory",
    "added_dirs": [],
    "git_worktree": "feature-xyz",
    "repo": {
      "host": "github.com",
      "owner": "anthropics",
      "name": "claude-code"
    }
  },
  "version": "2.1.90",
  "output_style": {
    "name": "default"
  },
  "cost": {
    "total_cost_usd": 0.01234,
    "total_duration_ms": 45000,
    "total_api_duration_ms": 2300,
    "total_lines_added": 156,
    "total_lines_removed": 23
  },
  "context_window": {
    "total_input_tokens": 15500,
    "total_output_tokens": 1200,
    "context_window_size": 200000,
    "used_percentage": 8,
    "remaining_percentage": 92,
    "current_usage": {
      "input_tokens": 8500,
      "output_tokens": 1200,
      "cache_creation_input_tokens": 5000,
      "cache_read_input_tokens": 2000
    }
  },
  "exceeds_200k_tokens": false,
  "prompt_cache": {
    "warm": true,
    "caching_observed": true,
    "ttl": "1h",
    "expires_at": 1738429200,
    "requests": 14,
    "misses": 2,
    "expected_rebuilds": 1,
    "hit_ratio": 0.91,
    "cache_write_tokens": 352000,
    "miss_recache_tokens": 310200,
    "last_miss_at": 1738425230,
    "last_miss_cause": {
      "causes": ["tools_changed"],
      "tools_added": 2,
      "tools_removed": 0
    },
    "miss_causes": {
      "tools_changed": 2
    },
    "recache_tokens_if_cold": 45000
  },
  "fast_mode": false,
  "effort": {
    "level": "high"
  },
  "thinking": {
    "enabled": true
  },
  "rate_limits": {
    "five_hour": {
      "used_percentage": 23.5,
      "resets_at": 1738425600
    },
    "seven_day": {
      "used_percentage": 41.2,
      "resets_at": 1738857600
    },
    "spend_limit": {
      "used_percentage": 62.8,
      "resets_at": 1740787200,
      "used_usd": 314.12,
      "limit_usd": 500,
      "period": "monthly"
    }
  },
  "vim": {
    "mode": "NORMAL"
  },
  "agent": {
    "name": "security-reviewer"
  },
  "pr": {
    "number": 1234,
    "url": "https://github.com/anthropics/claude-code/pull/1234",
    "review_state": "pending"
  },
  "worktree": {
    "name": "my-feature",
    "path": "/path/to/.claude/worktrees/my-feature",
    "branch": "worktree-my-feature",
    "original_cwd": "/path/to/project",
    "original_branch": "main"
  }
}
`;

const PORT = 47123;
const TOKEN = 'abcDEF123_-';
const EXPECTED_KEYS = ['companyAnnouncements', 'hooks', 'language', 'spinnerTipsOverride', 'spinnerVerbs', 'statusLine'];
const HOOK_EVENTS = ['PreToolUse', 'PostToolUse', 'PermissionRequest', 'Notification', 'Stop', 'UserPromptSubmit'];
const TOOL_EVENTS = ['PreToolUse', 'PostToolUse', 'PermissionRequest'];
const HANGUL = /[가-힣]/;

// ---------------------------------------------------------------- 도우미

// 상태 줄 시험 서버. statusline 주소에는 reply를, 나머지 주소에는 404를 준다. hang이면 답하지 않는다.
function startStatusServer({ token, reply = '한글상태', hang = false }) {
  const requests = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      requests.push({ method: req.method, url: req.url, contentType: req.headers['content-type'], body });
      if (hang) return;
      if (req.method === 'POST' && req.url === `/${token}/statusline`) {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(reply);
      } else if (req.method === 'POST' && req.url.startsWith(`/${token}/hook/`)) {
        res.writeHead(200);
        res.end();
      } else {
        res.writeHead(404);
        res.end('not found');
      }
    });
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      requests,
      close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }),
    }));
  });
}

// 아무도 듣지 않는 포트를 하나 얻는다.
function freePort() {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

// Claude Code처럼 sh -c로 명령을 돌리고 표준 입력에 JSON을 준다.
function runShell(command, stdin) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn('sh', ['-c', command], { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => err.push(c));
    child.on('error', reject);
    child.on('close', (code) => resolve({
      code,
      stdout: Buffer.concat(out).toString('utf8'),
      stderr: Buffer.concat(err).toString('utf8'),
      elapsedMs: Date.now() - started,
    }));
    child.stdin.end(stdin);
  });
}

function findRealClaude() {
  const candidates = [path.join(os.homedir(), '.local', 'bin', 'claude')];
  for (const d of (process.env.PATH || '').split(path.delimiter)) if (d) candidates.push(path.join(d, 'claude'));
  return candidates.find((p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } }) || null;
}

// 다른 Claude Code 세션이 동시에 ~/.claude.json을 쓰고 있을 수 있어 몇 번 다시 읽는다. 읽기만 한다.
function realProjectKeys() {
  const file = path.join(os.homedir(), '.claude.json');
  for (let i = 0; i < 5; i++) {
    try { return Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).projects || {}); } catch (e) {
      if (e.code === 'ENOENT') return [];
    }
  }
  throw new Error('~/.claude.json을 읽지 못했습니다');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- 단위 시험

test('필요한 키 6개만 있고 형식이 settings 문서와 맞다', () => {
  const s = buildSettings({ port: PORT, token: TOKEN, platform: 'darwin' });
  assert.deepEqual(Object.keys(s).sort(), EXPECTED_KEYS);

  // language: 문자열(언어 이름)
  assert.equal(s.language, 'korean');

  // spinnerVerbs: { mode: "append"|"replace", verbs: string[] }
  assert.deepEqual(Object.keys(s.spinnerVerbs).sort(), ['mode', 'verbs']);

  // spinnerTipsOverride: tips, tipsFile, label, excludeDefault 중 일부
  for (const k of Object.keys(s.spinnerTipsOverride)) {
    assert.ok(['tips', 'tipsFile', 'label', 'excludeDefault'].includes(k), `알 수 없는 필드: ${k}`);
  }

  // companyAnnouncements: 문자열 배열
  assert.ok(Array.isArray(s.companyAnnouncements));
  for (const a of s.companyAnnouncements) assert.equal(typeof a, 'string');

  // statusLine: { type: "command", command: string } (+ 선택 필드 padding, refreshInterval, hideVimModeIndicator)
  assert.equal(s.statusLine.type, 'command');
  assert.equal(typeof s.statusLine.command, 'string');
  for (const k of Object.keys(s.statusLine)) {
    assert.ok(['type', 'command', 'padding', 'refreshInterval', 'hideVimModeIndicator'].includes(k), `알 수 없는 필드: ${k}`);
  }

  // JSON으로 바꿔도 그대로다(함수·undefined 없음)
  assert.deepEqual(JSON.parse(JSON.stringify(s)), s);
});

test('설정 키마다 settings 문서 사본에 같은 이름의 절이 있다', { skip: NO_DOC }, () => {
  const doc = fs.readFileSync(SETTINGS_DOC, 'utf8');
  for (const key of EXPECTED_KEYS) {
    assert.ok(doc.includes(`\n### \`${key}\`\n`), `settings-reference.md에 ${key} 절이 없습니다`);
  }
  // 이 시험이 기대는 문서 문장들
  assert.ok(doc.includes('`"replace"`: Claude Code shows only your verbs'));
  assert.ok(doc.includes('`excludeDefault`: set it to `true` to hide the built-in tips and show only yours.'));
  assert.ok(doc.includes('Claude Code honors tip objects, `tipsFile`, `label`, and `excludeDefault` from user settings, the `--settings` flag, and managed settings'));
  assert.ok(doc.includes('object with `type` set to `"command"` and a `command` string'));
});

test('일하는 중 문구는 replace 모드에 한국어 8개 이상이다', () => {
  const { spinnerVerbs } = buildSettings({ port: PORT, token: TOKEN });
  assert.equal(spinnerVerbs.mode, 'replace');
  assert.ok(spinnerVerbs.verbs.length >= 8, `${spinnerVerbs.verbs.length}개`);
  for (const v of spinnerVerbs.verbs) {
    assert.equal(typeof v, 'string');
    assert.match(v, HANGUL);
    assert.doesNotMatch(v, /[A-Za-z]/, `영어가 섞였습니다: ${v}`);
  }
  assert.equal(new Set(spinnerVerbs.verbs).size, spinnerVerbs.verbs.length, '겹치는 문구가 있습니다');
});

test('도움말은 label "도움말", excludeDefault true, 한국어 5개 이상이고 문서의 tip 형식에 맞는다', () => {
  const { spinnerTipsOverride: o } = buildSettings({ port: PORT, token: TOKEN });
  assert.equal(o.label, '도움말');
  assert.ok(o.label.length <= 40);
  assert.equal(o.excludeDefault, true);
  assert.ok(Array.isArray(o.tips));
  assert.ok(o.tips.length >= 5, `${o.tips.length}개`);
  const ids = new Set();
  for (const tip of o.tips) {
    // 문서: id(필수) 1~64자 영문·숫자·._- , text(필수) 한 줄 500자 이하. 잘못된 항목은 조용히 버려진다.
    assert.deepEqual(Object.keys(tip).sort(), ['id', 'text']);
    assert.match(tip.id, /^[A-Za-z0-9._-]{1,64}$/);
    assert.ok(!ids.has(tip.id), `id가 겹칩니다: ${tip.id}`);
    ids.add(tip.id);
    assert.equal(typeof tip.text, 'string');
    assert.ok(tip.text.length > 0 && tip.text.length <= 500);
    assert.doesNotMatch(tip.text, /[\r\n\t\x00-\x1f\x7f]/, '한 줄이어야 합니다');
    assert.match(tip.text, HANGUL);
    assert.match(tip.text, /요[.!]?$/, `해요체로 끝나야 합니다: ${tip.text}`);
  }
});

test('시작 인사는 한국어 1개다', () => {
  const { companyAnnouncements } = buildSettings({ port: PORT, token: TOKEN });
  assert.equal(companyAnnouncements.length, 1);
  assert.match(companyAnnouncements[0], HANGUL);
  assert.doesNotMatch(companyAnnouncements[0], /[\r\n]/);
});

test('훅 6종을 http로 걸고, 도구 이벤트는 matcher *, PermissionRequest는 timeout 600이다', () => {
  const { hooks } = buildSettings({ port: PORT, token: TOKEN });
  assert.deepEqual(Object.keys(hooks).sort(), [...HOOK_EVENTS].sort());
  for (const event of HOOK_EVENTS) {
    // 문서: 이벤트마다 { matcher, hooks } 묶음의 배열
    assert.ok(Array.isArray(hooks[event]), `${event}는 배열이어야 합니다`);
    assert.equal(hooks[event].length, 1);
    const group = hooks[event][0];
    if (TOOL_EVENTS.includes(event)) assert.equal(group.matcher, '*');
    else assert.ok(!('matcher' in group), `${event}에는 matcher를 두지 않습니다`);
    assert.ok(Array.isArray(group.hooks));
    assert.equal(group.hooks.length, 1);
    const h = group.hooks[0];
    assert.equal(h.type, 'http');
    assert.equal(h.url, `http://127.0.0.1:${PORT}/${TOKEN}/hook/${event}`);
    if (event === 'PermissionRequest') {
      assert.deepEqual(Object.keys(h).sort(), ['timeout', 'type', 'url']);
      assert.equal(h.timeout, 600);
    } else {
      assert.deepEqual(Object.keys(h).sort(), ['type', 'url']);
    }
  }
});

test('모든 훅 주소와 상태 줄 명령에 port와 token이 들어 있다', () => {
  for (const [port, token] of [[PORT, TOKEN], [5, 'x'], [65535, 'Tok.en~9']]) {
    for (const platform of ['darwin', 'linux']) {
      const s = buildSettings({ port, token, platform });
      for (const event of HOOK_EVENTS) {
        const u = new URL(s.hooks[event][0].hooks[0].url);
        assert.equal(u.hostname, '127.0.0.1');
        assert.equal(Number(u.port), port);
        assert.equal(u.pathname, `/${token}/hook/${event}`);
      }
      assert.ok(s.statusLine.command.includes(`'http://127.0.0.1:${port}/${token}/statusline'`));
    }
  }
});

test('금지 키(DISABLE_AUTOUPDATER, DISABLE_UPDATES, apiKeyHelper, env·인증 설정)가 없다', () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    const s = buildSettings({ port: PORT, token: TOKEN, platform });
    for (const k of ['env', 'apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'gcpAuthRefresh', 'forceLoginMethod', 'forceLoginOrgUUID']) {
      assert.ok(!(k in s), `${k} 키가 있습니다`);
    }
    const text = JSON.stringify(s);
    for (const word of ['DISABLE_AUTOUPDATER', 'DISABLE_UPDATES', 'apiKeyHelper', 'ANTHROPIC_', 'CLAUDE_CODE_OAUTH', 'autoUpdates']) {
      assert.ok(!text.includes(word), `${word}가 들어 있습니다`);
    }
  }
});

test('셸 명령에 들어가는 port·token이 이상하면 거절한다', () => {
  const bad = [
    { port: 0, token: 'a' }, { port: 70000, token: 'a' }, { port: '47123', token: 'a' }, { port: 1.5, token: 'a' },
    { port: PORT, token: '' }, { port: PORT, token: "a'b" }, { port: PORT, token: 'a b' }, { port: PORT, token: 'a/b' },
    { port: PORT, token: '$(id)' }, { port: PORT, token: undefined },
  ];
  for (const args of bad) assert.throws(() => buildSettings(args), TypeError, JSON.stringify(args));
});

test('Windows 상태 줄 명령은 powershell -EncodedCommand이고, 풀면 주소·기본 문구·UTF-8 처리가 들어 있다', () => {
  // statusline 문서 "Windows configuration": Git Bash든 PowerShell이든 powershell로 부르면 된다. 실제 실행 시험은 하지 않는다.
  const s = buildSettings({ port: PORT, token: TOKEN, platform: 'win32' });
  const m = s.statusLine.command.match(/^powershell -NoProfile -NonInteractive -EncodedCommand ([A-Za-z0-9+/=]+)$/);
  assert.ok(m, s.statusLine.command.slice(0, 80));
  assert.ok(s.statusLine.command.length < 8000, 'Windows 명령 줄 길이 제한 안');
  const script = Buffer.from(m[1], 'base64').toString('utf16le');
  assert.ok(script.includes(`'http://127.0.0.1:${PORT}/${TOKEN}/statusline'`));
  assert.ok(script.includes(`$out = '${FALLBACK_STATUS}'`));
  assert.ok(script.includes('[Console]::OpenStandardInput()'));
  assert.ok(script.includes('[System.Text.Encoding]::UTF8'));
  assert.ok(script.includes('$req.Timeout = 1000'));
  // 다른 OS의 명령은 curl이다
  assert.match(buildSettings({ port: PORT, token: TOKEN, platform: 'linux' }).statusLine.command, /^curl /);
});

test('writeSettingsFile은 kct-settings.json을 0600으로 쓰고, 이미 있던 넓은 권한 파일도 0600으로 바꾼다', () => {
  const dir = path.join(OUT, 'unit-write');
  fs.rmSync(dir, { recursive: true, force: true });
  const s = buildSettings({ port: PORT, token: TOKEN });

  const file = writeSettingsFile(s, dir);
  assert.equal(file, path.join(dir, SETTINGS_FILE_NAME));
  assert.equal(path.basename(file), 'kct-settings.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), s);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  fs.chmodSync(file, 0o644);
  const s2 = buildSettings({ port: PORT + 1, token: TOKEN });
  writeSettingsFile(s2, dir);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), s2);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(dir), ['kct-settings.json'], '임시 파일이 남으면 안 됩니다');
});

test('claudeArgs는 --settings와 파일 경로를 준다', () => {
  assert.deepEqual(claudeArgs('/x/y/kct-settings.json'), ['--settings', '/x/y/kct-settings.json']);
});

test('도움말마다 공식 문서 근거(주소·인용문)가 표에 있다', () => {
  const { spinnerTipsOverride } = buildSettings({ port: PORT, token: TOKEN });
  const ids = spinnerTipsOverride.tips.map((t) => t.id);
  assert.deepEqual(Object.keys(TIP_EVIDENCE).sort(), [...ids].sort(), '근거 표와 도움말 목록이 다릅니다');
  for (const id of ids) {
    const e = TIP_EVIDENCE[id];
    assert.match(e.url, /^https:\/\/code\.claude\.com\/docs\/en\/[a-z-]+#[a-z0-9-]+$/);
    assert.ok(e.quote.length > 20);
  }
});

test('도움말 근거 인용문이 받아 둔 공식 문서 사본에 그대로 있다', (t) => {
  const needed = [...new Set(Object.values(TIP_EVIDENCE).map((e) => e.doc))];
  const missing = needed.filter((d) => !fs.existsSync(path.join(DOCS_COPY, d)));
  if (missing.length) {
    t.skip(`문서 사본이 없습니다: ${missing.join(', ')} (위 curl 명령으로 받으세요)`);
    return;
  }
  for (const [id, e] of Object.entries(TIP_EVIDENCE)) {
    const doc = fs.readFileSync(path.join(DOCS_COPY, e.doc), 'utf8');
    assert.ok(doc.includes(e.quote), `${id}: ${e.doc}에서 인용문을 찾지 못했습니다`);
    // 주소의 # 뒤 절 제목이 문서에 있다
    const anchor = e.url.split('#')[1];
    const headings = [...doc.matchAll(/^#{2,4} (.+)$/gm)].map((h) => h[1].toLowerCase().replace(/[`/]/g, '').replace(/[^a-z0-9 -]/g, '').trim().replace(/ +/g, '-'));
    assert.ok(headings.includes(anchor), `${id}: ${e.doc}에 #${anchor} 절이 없습니다`);
  }
});

// ---------------------------------------------------------------- 상태 줄 명령 시험(완성 조건 2)

test('상태 줄 명령을 sh -c로 돌리고 문서 예시 JSON을 주면, 시험 서버의 "한글상태"를 정확히 출력한다', async () => {
  const token = 'statusTok123';
  const srv = await startStatusServer({ token, reply: '한글상태' });
  try {
    const { statusLine } = buildSettings({ port: srv.port, token });
    const r = await runShell(statusLine.command, DOC_STATUS_SAMPLE);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, '한글상태');
    assert.equal(srv.requests.length, 1);
    const [req] = srv.requests;
    assert.equal(req.method, 'POST');
    assert.equal(req.url, `/${token}/statusline`);
    assert.equal(req.contentType, 'application/json');
    assert.equal(req.body.toString('utf8'), DOC_STATUS_SAMPLE, '표준 입력이 바이트 그대로 가야 합니다');
  } finally {
    await srv.close();
  }
});

test('상태 줄 명령은 한글 경로가 든 입력도 그대로 보낸다', async () => {
  const token = 'statusTok456';
  const srv = await startStatusServer({ token, reply: '📁 작업실 · 대화 길이 8%' });
  try {
    const input = JSON.stringify({ cwd: '/Users/tester/Documents/작업실', context_window: { used_percentage: 8 } });
    const r = await runShell(buildSettings({ port: srv.port, token }).statusLine.command, input);
    assert.equal(r.stdout, '📁 작업실 · 대화 길이 8%');
    assert.equal(srv.requests[0].body.toString('utf8'), input);
  } finally {
    await srv.close();
  }
});

test('서버가 없으면 2초 안에 작업실을 출력한다', async () => {
  const port = await freePort();
  const r = await runShell(buildSettings({ port, token: 'nobody' }).statusLine.command, DOC_STATUS_SAMPLE);
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), FALLBACK_STATUS);
  assert.equal(FALLBACK_STATUS, '작업실');
  assert.ok(r.elapsedMs < 2000, `${r.elapsedMs}ms`);
});

test('서버가 답하지 않으면 1초에 끊고 2초 안에 작업실을 출력한다', async () => {
  const token = 'hangTok';
  const srv = await startStatusServer({ token, hang: true });
  try {
    const r = await runShell(buildSettings({ port: srv.port, token }).statusLine.command, DOC_STATUS_SAMPLE);
    assert.equal(r.stdout.trim(), '작업실');
    assert.ok(r.elapsedMs >= 900 && r.elapsedMs < 2000, `${r.elapsedMs}ms`);
  } finally {
    await srv.close();
  }
});

test('서버가 오류 상태(404)로 답하면 오류 본문 대신 작업실을 출력한다', async () => {
  const srv = await startStatusServer({ token: 'realToken' });
  try {
    const r = await runShell(buildSettings({ port: srv.port, token: 'wrongToken' }).statusLine.command, DOC_STATUS_SAMPLE);
    assert.equal(srv.requests[0].url, '/wrongToken/statusline');
    assert.equal(r.stdout.trim(), '작업실');
  } finally {
    await srv.close();
  }
});

// ---------------------------------------------------------------- 실제 claude 통합 시험(완성 조건 3)

test('실제 claude를 claudeArgs로 띄우면 15초 안에 한국어 시작 인사와 시험 서버의 한국어 상태 줄이 보이고 설정 오류가 없다', async (t) => {
  const claudePath = findRealClaude();
  if (!claudePath || !tmux.findTmux()) {
    t.skip(`실제 claude(${claudePath})나 tmux가 없습니다`);
    return;
  }
  const live = path.join(OUT, 'live');
  fs.rmSync(live, { recursive: true, force: true });
  const work = path.join(live, 'work');
  fs.mkdirSync(work, { recursive: true });

  const token = `t3${Date.now().toString(36)}`;
  const srv = await startStatusServer({ token, reply: '한글상태' });
  const settings = buildSettings({ port: srv.port, token });
  const settingsFile = writeSettingsFile(settings, path.join(live, 'settings'));
  const { env } = createFakeClaudeHome({ dir: path.join(live, 'home'), trustedPaths: [work] });
  const debugLog = path.join(live, 'claude-debug.log');
  const greeting = settings.companyAnnouncements[0];

  // claudeArgs 뒤에 디버그 기록 파일만 더한다(도움말 항목이 버려졌는지 보려고).
  const args = [...claudeArgs(settingsFile), '--debug-file', debugLog];
  fs.writeFileSync(path.join(OUT, 'claude-command.txt'), `cwd: ${work}\n${claudePath} ${args.join(' ')}\n`);

  const started = Date.now();
  const term = tmux.start({ socket: 'kct-T3', command: claudePath, args, cwd: work, env, cols: 120, rows: 40 });
  let screen = '';
  let elapsedMs = -1;
  try {
    const both = new RegExp(`^(?=[\\s\\S]*${greeting.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(?=[\\s\\S]*한글상태)`);
    try {
      screen = await term.waitFor(both, { timeoutMs: 15000, intervalMs: 200 });
      elapsedMs = Date.now() - started;
    } catch (e) {
      screen = e.screen || '';
      fs.writeFileSync(path.join(OUT, 'claude-screen-failed.txt'), screen);
      throw e;
    }
    fs.writeFileSync(path.join(OUT, 'claude-screen.txt'), screen);
    fs.writeFileSync(path.join(OUT, 'claude-screen-meta.json'), JSON.stringify({
      claudePath, elapsedMs, capturedAt: new Date().toISOString(), settingsFile,
    }, null, 2));

    assert.ok(elapsedMs <= 15000, `${elapsedMs}ms`);
    assert.ok(screen.includes(greeting), '한국어 시작 인사가 화면에 없습니다');
    assert.match(screen, /한글상태/, '시험 서버가 준 상태 줄이 화면에 없습니다');
    // 잘못된 설정 파일이면 claude는 "Settings Error" 창을 띄우고 그 파일을 통째로 건너뛴다(직접 확인한 문구).
    assert.doesNotMatch(screen, /Settings Error|Files with errors are skipped|Invalid value|Expected (array|object|string)|Continue without these settings/);

    // 상태 줄 명령이 claude의 상태 JSON을 그대로 보냈다.
    const statusReqs = srv.requests.filter((r) => r.url === `/${token}/statusline`);
    assert.ok(statusReqs.length >= 1, '상태 줄 요청이 오지 않았습니다');
    const body = JSON.parse(statusReqs[0].body.toString('utf8'));
    assert.equal(typeof body.session_id, 'string');
    assert.ok(body.workspace && typeof body.workspace.current_dir === 'string');
    fs.writeFileSync(path.join(OUT, 'statusline-request.json'), JSON.stringify(body, null, 2));
  } finally {
    term.kill();
    await srv.close();
  }

  // 디버그 기록: 도움말 항목이 버려지거나(문서: "drops an invalid entry with a debug warning") 설정 파일 경고가 없어야 한다.
  await sleep(300);
  const log = fs.existsSync(debugLog) ? fs.readFileSync(debugLog, 'utf8') : '';
  assert.ok(log.length > 0, '디버그 기록이 비었습니다');
  const warnings = log.split('\n').filter((l) => /\[(WARN|ERROR)\]/.test(l)
    && /spinnerTipsOverride|spinnerVerbs|companyAnnouncements|statusLine|kct-settings|127\.0\.0\.1/i.test(l));
  assert.deepEqual(warnings, []);
  assert.match(log, /StatusLine \[curl .*\] completed with status 0/);

  // 실제 ~/.claude.json에 시험 폴더가 생기지 않았다.
  assert.deepEqual(realProjectKeys().filter((k) => k.includes(path.join('.test-tmp', 'T3'))), []);
});
