'use strict';

// T5 한국어 문구 시험.
// 입력 형식 근거
// - 도구별 tool_input 필드: review/tech-stack-deploy/docs/hooks.md "PreToolUse input" 절
//   (Bash·PowerShell·Write·Edit·Read·Glob·Grep·WebFetch·WebSearch·Agent 표)
// - NotebookEdit(notebook_path, edit_mode)·TodoWrite(todos)·Agent의 옛 이름 Task:
//   https://code.claude.com/docs/en/agent-sdk/typescript "Tool Input Types"
// - Skill(skill), MultiEdit(file_path, edits): 공식 문서 목록에 입력 표가 없어 Claude Code 도구 정의를 따름
// - PostToolUse의 tool_response.type(create/update), Bash의 interrupted: 위 typescript 문서 "Tool Output Types"
// - Notification의 notification_type 값: hooks.md "Notification" 절의 matcher 표
// - 상태 줄 입력: https://code.claude.com/docs/en/statusline "Available data"의 "Full JSON schema"
//   예시를 그대로 test/fixtures/statusline/doc-sample.json에 옮김(2026-10-14 받음)
// 실제 요청: review/hook/runs/rB/requests/ (claude 2.1.296이 HTTP 훅으로 보낸 것)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const korean = require('../src/main/korean');

const {
  describeToolStart,
  describeToolEnd,
  describePermission,
  describeNotification,
  describeStop,
  formatStatusLine,
} = korean;

const APP_DIR = path.join(__dirname, '..');
const OUT_DIR = path.join(APP_DIR, '.test-tmp', 'T5');
const RB_DIR = path.join(APP_DIR, '..', 'review', 'hook', 'runs', 'rB', 'requests');
const NO_RB = !fs.existsSync(RB_DIR) && '저장소 밖 검토 자료(review/)가 없어 건너뜁니다(공개 저장소)';
const DOC_SAMPLE = path.join(__dirname, 'fixtures', 'statusline', 'doc-sample.json');

const HOME = '/Users/tester';
const WORK = `${HOME}/Documents/작업실`;
const WIN_WORK = 'C:\\Users\\tester\\Documents\\작업실';

// ── 시험 도우미 ──

// 한글·이모지는 2칸, 이모지 뒤 모양 고르개(VS16)는 0칸, 나머지는 1칸으로 센다.
function columns(s) {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp === 0xfe0f || cp === 0x200d) continue;
    const wide =
      (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0x1100 && cp <= 0x11ff) || (cp >= 0x3130 && cp <= 0x318f) || cp >= 0x1f000;
    w += wide ? 2 : 1;
  }
  return w;
}

const HANGUL = /[\uac00-\ud7a3]/;
const ABSOLUTE = [/\/Users\//, /\/home\//, /[A-Za-z]:\\/];

function assertNoAbsolutePath(text, where) {
  for (const re of ABSOLUTE) assert.ok(!re.test(text), `${where}: 절대 경로가 보여요 → ${JSON.stringify(text)}`);
}

// 넘겨받은 말(허용 목록)에 없는 4글자 이상 영어 단어를 찾는다.
function foreignEnglish(text, allow) {
  const allowed = allow.filter(Boolean).join('\n');
  return (text.match(/[A-Za-z]{4,}/g) || []).filter((w) => !allowed.includes(w));
}

const LOG_ENDING = /요(?:: .+| \(.+\))?$/;

function pre(tool_name, tool_input, cwd = WORK) {
  return {
    session_id: 's1',
    cwd,
    hook_event_name: 'PreToolUse',
    tool_name,
    tool_input,
    tool_use_id: 'toolu_1',
  };
}

function post(tool_name, tool_input, tool_response = {}, cwd = WORK) {
  return { ...pre(tool_name, tool_input, cwd), hook_event_name: 'PostToolUse', tool_response };
}

function perm(tool_name, tool_input, cwd = WORK) {
  const b = { ...pre(tool_name, tool_input, cwd), hook_event_name: 'PermissionRequest' };
  delete b.tool_use_id;
  return b;
}

function runCase(c) {
  const start = describeToolStart(pre(c.tool, c.input, c.cwd));
  const end = describeToolEnd(post(c.tool, c.input, c.response, c.cwd));
  const permission = describePermission(perm(c.tool, c.input, c.cwd));
  return { start, end, permission };
}

// ── 도구 표 ──
// kind: 도구 종류(16종 이상 세기), allow: 넘겨받은 파일 이름·사이트·명령 등, expect: 꼭 들어갈 문구

const LONG_CMD = `python3 scripts/convert.py --input ${WORK}/data/2026-원본.csv --output ${WORK}/data/결과.csv --verbose --encoding utf-8`;

const CASES = [
  {
    kind: 'Read',
    tool: 'Read',
    input: { file_path: `${WORK}/메모.txt` },
    allow: ['메모.txt'],
    expect: {
      start: '메모.txt 파일을 읽고 있어요',
      end: '메모.txt 파일을 읽었어요',
      title: '파일을 읽어도 될까요?',
      detail: '작업실 폴더에 있는 메모.txt 파일',
    },
  },
  {
    kind: 'Write',
    tool: 'Write',
    input: { file_path: `${WORK}/report.txt`, content: 'hello world' },
    response: { type: 'create', filePath: `${WORK}/report.txt` },
    allow: ['report.txt'],
    expect: {
      start: 'report.txt 파일을 저장하고 있어요',
      end: 'report.txt 파일을 만들었어요',
      title: '파일을 만들어도 될까요?',
      detail: '작업실 폴더에 report.txt 파일을 만들어요',
    },
  },
  {
    kind: 'Write',
    name: 'Write(덮어쓰기)',
    tool: 'Write',
    input: { file_path: `${WORK}/report.txt`, content: 'again' },
    response: { type: 'update', filePath: `${WORK}/report.txt` },
    allow: ['report.txt'],
    expect: { end: 'report.txt 파일을 새 내용으로 바꿨어요' },
  },
  {
    kind: 'Edit',
    tool: 'Edit',
    input: { file_path: `${WORK}/site/index.html`, old_string: 'Hello', new_string: '안녕', replace_all: true },
    allow: ['site/index.html'],
    expect: {
      start: 'index.html 파일을 고치고 있어요',
      end: 'index.html 파일을 고쳤어요',
      title: '파일을 고쳐도 될까요?',
      detail: 'site 폴더에 있는 index.html 파일에서 같은 내용을 모두 바꿔요.',
    },
  },
  {
    kind: 'MultiEdit',
    tool: 'MultiEdit',
    input: {
      file_path: `${WORK}/style.css`,
      edits: [
        { old_string: 'red', new_string: 'blue' },
        { old_string: 'bold', new_string: 'normal' },
        { old_string: 'left', new_string: 'right' },
      ],
    },
    allow: ['style.css'],
    expect: { start: 'style.css 파일 여러 곳을 고치고 있어요', detail: 'style.css 파일에서 3군데를 바꿔요.' },
  },
  {
    kind: 'NotebookEdit',
    tool: 'NotebookEdit',
    input: { notebook_path: `${WORK}/analysis.ipynb`, new_source: 'print(1)', cell_type: 'code', edit_mode: 'insert' },
    allow: ['analysis.ipynb'],
    expect: {
      start: 'analysis.ipynb 노트 파일을 고치고 있어요',
      title: '노트 파일을 고쳐도 될까요?',
      detail: '칸을 하나 더해요.',
    },
  },
  {
    kind: 'Bash',
    name: 'Bash(한국어 설명)',
    tool: 'Bash',
    input: { command: `touch ${WORK}/b.txt`, description: '빈 파일 b.txt 만들기' },
    response: { stdout: '', stderr: '', interrupted: false },
    allow: [`touch ${WORK}/b.txt`],
    expect: {
      start: '명령을 실행하고 있어요: 빈 파일 b.txt 만들기',
      end: '명령을 마쳤어요: 빈 파일 b.txt 만들기',
      title: '이 명령을 실행해도 될까요?',
      detail: '할 일: 빈 파일 b.txt 만들기\n실행할 명령: touch ~/…/작업실/b.txt',
    },
  },
  {
    kind: 'Bash',
    name: 'Bash(영어 설명은 숨김)',
    tool: 'Bash',
    input: { command: 'npm install express', description: 'Install the express package' },
    allow: ['npm install express'],
    expect: {
      start: '명령을 실행하고 있어요: npm install express',
      detail: '아래 명령을 컴퓨터에서 실행해요.\n실행할 명령: npm install express',
    },
  },
  {
    kind: 'Bash',
    name: 'Bash(설명 없음, 긴 명령)',
    tool: 'Bash',
    input: { command: LONG_CMD },
    allow: [LONG_CMD.replaceAll(`${WORK}/`, '')],
    expect: { start: '명령을 실행하고 있어요: python3 scripts/convert.py --input ~/…/data/2026-원본.csv' },
  },
  {
    kind: 'PowerShell',
    tool: 'PowerShell',
    input: { command: 'Get-ChildItem C:\\Users\\tester\\Documents', description: 'List documents' },
    cwd: WIN_WORK,
    allow: ['Get-ChildItem C:\\Users\\tester\\Documents'],
    expect: {
      start: '명령을 실행하고 있어요: Get-ChildItem ~\\Documents',
      title: '이 명령을 실행해도 될까요?',
    },
  },
  {
    kind: 'Glob',
    tool: 'Glob',
    input: { pattern: '**/*.md', path: WORK },
    allow: ['**/*.md'],
    expect: { start: '파일 이름으로 찾고 있어요: **/*.md', detail: '찾을 곳: 작업실' },
  },
  {
    kind: 'Grep',
    tool: 'Grep',
    input: { pattern: 'TODO', path: HOME, output_mode: 'content' },
    allow: ['TODO'],
    expect: { start: '파일 내용에서 찾고 있어요: TODO', detail: '찾을 곳: 내 폴더' },
  },
  {
    kind: 'WebFetch',
    tool: 'WebFetch',
    input: { url: 'https://www.example.com/docs/page?x=1', prompt: 'Summarize this page' },
    allow: ['example.com'],
    expect: {
      start: 'example.com 사이트를 읽고 있어요',
      end: 'example.com 사이트를 읽었어요',
      title: '이 사이트를 열어 봐도 될까요?',
    },
  },
  {
    kind: 'WebSearch',
    tool: 'WebSearch',
    input: { query: '서울 날씨 내일' },
    allow: [],
    expect: { start: '인터넷에서 찾고 있어요: 서울 날씨 내일', detail: '찾을 말: 서울 날씨 내일' },
  },
  {
    kind: 'Task',
    tool: 'Task',
    input: { description: 'Find API endpoints', prompt: 'Find all API endpoints', subagent_type: 'Explore' },
    allow: [],
    expect: { start: '도우미에게 일을 맡기고 있어요', end: '도우미가 일을 마쳤어요' },
  },
  {
    kind: 'Agent',
    tool: 'Agent',
    input: { description: '자료 정리하기', prompt: 'Organize files' },
    response: { status: 'async_launched', agentId: 'a1' },
    allow: [],
    expect: {
      start: '도우미에게 일을 맡기고 있어요: 자료 정리하기',
      end: '도우미가 뒤에서 일을 시작했어요: 자료 정리하기',
    },
  },
  {
    kind: 'TodoWrite',
    tool: 'TodoWrite',
    input: {
      todos: [
        { content: 'Read docs', status: 'completed', activeForm: 'Reading docs' },
        { content: 'Write code', status: 'in_progress', activeForm: 'Writing code' },
        { content: 'Test', status: 'pending', activeForm: 'Testing' },
      ],
    },
    allow: [],
    expect: { start: '할 일 목록을 정리하고 있어요 (3개 중 1개 끝)' },
  },
  {
    kind: 'Skill',
    tool: 'Skill',
    input: { skill: 'pdf' },
    allow: ['pdf'],
    expect: { start: 'pdf 기능을 불러오고 있어요', title: '이 기능을 써도 될까요?' },
  },
  {
    kind: 'mcp__*',
    tool: 'mcp__slack__send_message',
    input: { channel: '#general', text: 'Deploy finished' },
    allow: ['mcp__slack__send_message'],
    expect: { start: 'slack 서비스의 send_message 기능을 쓰고 있어요', title: '연결된 서비스를 써도 될까요?' },
  },
  {
    kind: '모르는 도구',
    tool: 'FancyNewTool',
    input: { anything: 'Something else' },
    allow: ['FancyNewTool'],
    expect: { start: 'FancyNewTool 도구를 쓰고 있어요', title: '이 도구를 써도 될까요?' },
  },
  {
    kind: 'Write',
    name: 'Write(윈도우 경로)',
    tool: 'Write',
    input: { file_path: `${WIN_WORK}\\보고서.docx`, content: 'x' },
    cwd: WIN_WORK,
    allow: ['보고서.docx'],
    expect: { detail: '작업실 폴더에 보고서.docx 파일을 만들어요.' },
  },
  {
    kind: 'Read',
    name: 'Read(작업 폴더 밖)',
    tool: 'Read',
    input: { file_path: `${HOME}/.zshrc` },
    allow: ['.zshrc'],
    expect: { detail: '내 폴더에 있는 .zshrc 파일의 내용을 읽어요.\n작업 폴더 밖에 있는 파일이에요.' },
  },
];

test('도구 16종 이상을 표로 다루고, 넘겨받은 말 말고는 4글자 이상 영어 단어가 없다', () => {
  const kinds = new Set(CASES.map((c) => c.kind));
  assert.ok(kinds.size >= 16, `도구 종류가 ${kinds.size}개뿐이에요`);

  for (const c of CASES) {
    const label = c.name || c.kind;
    const { start, end, permission } = runCase(c);

    assert.equal(typeof start.icon, 'string');
    assert.ok(start.icon.length > 0, `${label}: 시작 아이콘이 비었어요`);
    assert.equal(typeof end.ok, 'boolean');
    assert.equal(typeof permission.danger, 'boolean');

    const texts = { start: start.text, end: end.text, title: permission.title, detail: permission.detail };
    for (const [k, text] of Object.entries(texts)) {
      assert.equal(typeof text, 'string', `${label}.${k}`);
      assert.ok(HANGUL.test(text), `${label}.${k}: 한국어가 아니에요 → ${text}`);
      assert.deepEqual(foreignEnglish(text, c.allow), [], `${label}.${k}: 영어 단어가 보여요 → ${text}`);
    }
    assert.match(start.text, LOG_ENDING, `${label}: 시작 문구가 해요체가 아니에요`);
    assert.match(end.text, LOG_ENDING, `${label}: 끝 문구가 해요체가 아니에요`);
    assert.match(permission.title, /요\?$/, `${label}: 허락 제목이 묻는 말이 아니에요`);

    for (const [k, want] of Object.entries(c.expect)) {
      assert.ok(texts[k].includes(want), `${label}.${k}: "${want}"가 없어요 → ${texts[k]}`);
    }
  }
});

test('Bash 시작 문구는 긴 명령을 짧게 줄인다', () => {
  const { start } = runCase(CASES.find((c) => c.name === 'Bash(설명 없음, 긴 명령)'));
  assert.ok(start.text.endsWith('…'), start.text);
  assert.ok(Array.from(start.text).length <= 80, start.text);
});

test('어떤 출력에도 절대 경로가 없고, 홈 폴더는 내 폴더라고 쓴다', () => {
  const extra = [
    { tool: 'Read', input: { file_path: HOME } },
    { tool: 'Glob', input: { pattern: '*', path: '/home/tester' } },
    { tool: 'Bash', input: { command: 'cat /Users/tester/a.txt > C:\\Users\\tester\\b.txt; ls /Users/' } },
    { tool: 'Bash', input: { command: 'export PATH=/usr/bin:/Users/tester/.local/bin', description: '경로 /Users/tester/bin 추가' } },
    { tool: 'Bash', input: { command: 'open file:///Users/tester/a.html' } },
    { tool: 'PowerShell', input: { command: 'Remove-Item C:\\ -Recurse' } },
    { tool: 'Edit', input: { file_path: 'C:/Users/tester/x.txt' } },
    { tool: 'Agent', input: { description: '/Users/tester/Documents 폴더 정리' } },
  ];
  const all = [...CASES, ...extra];
  for (const c of all) {
    const { start, end, permission } = runCase(c);
    for (const text of [start.text, end.text, permission.title, permission.detail]) {
      assertNoAbsolutePath(text, c.name || c.tool);
    }
  }
  assert.equal(describeToolStart(pre('Read', { file_path: HOME })).text, '내 폴더 파일을 읽고 있어요');
  assert.ok(describePermission(perm('Read', { file_path: `${HOME}/a.txt` })).detail.startsWith('내 폴더에 있는 a.txt'));
  const win = describePermission(perm('Read', { file_path: 'C:\\Users\\tester\\a.txt' }, WIN_WORK)).detail;
  assert.ok(win.startsWith('내 폴더에 있는 a.txt'), win);
});

test('파일 이름과 상위 폴더 하나만 보인다', () => {
  const p = describePermission(perm('Write', { file_path: `${WORK}/보고서/2026/10월.txt`, content: 'x' }));
  assert.ok(p.detail.startsWith('2026 폴더에 10월.txt 파일을 만들어요.'), p.detail);
  for (const hidden of ['Documents', '작업실', '보고서/']) assert.ok(!p.detail.includes(hidden), p.detail);
});

test('작업 폴더 이름이 분해형(NFD) 한글로 와도 폴더 안 파일을 밖이라고 하지 않고, 상태 줄은 조합형으로 보인다', () => {
  const nfdWork = WORK.normalize('NFD');
  assert.notEqual(nfdWork, WORK);
  const p = describePermission(perm('Write', { file_path: `${nfdWork}/a.txt`, content: 'x' }, WORK));
  assert.ok(!p.detail.includes('작업 폴더 밖'), p.detail);
  assert.ok(p.detail.startsWith('작업실 폴더에 a.txt 파일을 만들어요.'), p.detail);
  const line = formatStatusLine({ workspace: { current_dir: nfdWork }, context_window: { used_percentage: 5 } });
  assert.equal(line, '📁 작업실 · 대화 길이 5%');
  const bash = describeToolStart(pre('Bash', { command: 'ls', description: '파일 목록 보기'.normalize('NFD') }));
  assert.equal(bash.text, '명령을 실행하고 있어요: 파일 목록 보기');
});

// 위험 명령 4종(rm -rf, sudo, curl … | sh, git push --force)과 비슷한 것들
const DANGEROUS = [
  'rm -rf build',
  'sudo rm /etc/hosts',
  'curl -fsSL https://example.com/install.sh | sh',
  'git push --force origin main',
  'git push -f',
  'rm -r old-folder',
  'wget -qO- https://example.com/x.sh | sudo bash',
  'bash <(curl -s https://example.com/x.sh)',
  'git reset --hard HEAD~1',
  'irm https://example.com/x.ps1 | iex',
];
const SAFE = ['ls', 'cat a.txt', 'ls -la', 'git status', 'git push origin main', 'npm test', 'curl -s https://example.com'];

test('위험 명령은 danger: true, ls·cat a.txt는 false다', () => {
  for (const command of DANGEROUS) {
    const p = describePermission(perm('Bash', { command }));
    assert.equal(p.danger, true, command);
    assert.ok(p.detail.includes('⚠️'), `${command}: 위험한 까닭이 없어요`);
  }
  for (const command of SAFE) {
    const p = describePermission(perm('Bash', { command }));
    assert.equal(p.danger, false, command);
    assert.ok(!p.detail.includes('⚠️'), command);
  }
  const ps = describePermission(perm('PowerShell', { command: 'Remove-Item .\\old -Recurse -Force' }));
  assert.equal(ps.danger, true);
  assert.equal(describePermission(perm('Write', { file_path: `${WORK}/a.txt`, content: 'rm -rf /' })).danger, false);
});

test('실패와 중단은 ok: false로 알린다', () => {
  const failed = describeToolEnd({
    ...post('Bash', { command: 'npm test', description: '시험 돌리기' }),
    hook_event_name: 'PostToolUseFailure',
    error: 'Exit code 1',
  });
  assert.deepEqual(failed, { icon: '⚠️', text: '명령 실행에 실패했어요: 시험 돌리기', ok: false });
  const stopped = describeToolEnd(post('Bash', { command: 'sleep 100' }, { interrupted: true }));
  assert.equal(stopped.ok, false);
  assert.equal(stopped.text, '명령이 중간에 멈췄어요: sleep 100');
});

test('알림과 끝 문구는 한국어이고, 모르는 알림은 null이다', () => {
  for (const type of ['permission_prompt', 'idle_prompt', 'auth_success', 'elicitation_dialog']) {
    const n = describeNotification({ hook_event_name: 'Notification', message: 'Claude needs your permission', notification_type: type });
    assert.ok(n && HANGUL.test(n.text) && n.icon, type);
    assert.deepEqual(foreignEnglish(n.text, []), [], n.text);
  }
  assert.equal(describeNotification({ notification_type: 'something_new', message: 'Hello there' }), null);
  assert.equal(describeNotification({}), null);
  assert.deepEqual(describeStop({ hook_event_name: 'Stop', last_assistant_message: `Created ${WORK}/a.txt` }), {
    icon: '✅',
    text: '답을 마쳤어요. 다음 할 일을 적어 주세요',
  });
  assert.match(describeStop({ background_tasks: [{ id: 't1' }, { id: 't2' }] }).text, /뒤에서 하는 일 2개/);
});

test('깨진 입력에도 오류 없이 기본 문구를 낸다', () => {
  const inputs = [undefined, null, 42, 'x', [], {}, { tool_name: 'Bash' }, { tool_name: 'Read', tool_input: null }, { tool_name: 'Edit', tool_input: { file_path: 7 } }];
  for (const b of inputs) {
    const s = describeToolStart(b);
    const e = describeToolEnd(b);
    const p = describePermission(b);
    assert.ok(HANGUL.test(s.text) && HANGUL.test(e.text) && HANGUL.test(p.title) && HANGUL.test(p.detail), JSON.stringify(b));
    assert.equal(typeof p.danger, 'boolean');
    assert.ok(describeNotification(b) === null || HANGUL.test(describeNotification(b).text));
    assert.ok(HANGUL.test(describeStop(b).text));
    assert.equal(typeof formatStatusLine(b), 'string');
  }
});

// ── 상태 줄 ──

const STATUS_RE = /^📁 .+ · 대화 길이 \d+%/;
const docSample = JSON.parse(fs.readFileSync(DOC_SAMPLE, 'utf8'));

function withStatus(dir, percent) {
  return {
    ...docSample,
    cwd: dir,
    workspace: { ...docSample.workspace, current_dir: dir },
    context_window: { ...docSample.context_window, used_percentage: percent },
  };
}

test('상태 줄은 문서 예시에서 폴더 이름과 대화 길이만 보인다', () => {
  const line = formatStatusLine(docSample);
  assert.equal(line, '📁 directory · 대화 길이 8%');
  assert.match(line, STATUS_RE);
  for (const hidden of ['Opus', 'opus', 'claude', '/', 'ctx', 'context', '토큰', 'token', '비용', 'cost', '$', '0.01234', 'high']) {
    assert.ok(!line.includes(hidden), `"${hidden}"가 보여요 → ${line}`);
  }
  assert.equal(formatStatusLine(JSON.stringify(docSample)), line);
});

test('대화 길이 80% 이상이면 새 대화를 권한다', () => {
  // 40칸에 맞추느라 80% 이상에서는 폴더 이름이 '…'로 줄어든다.
  assert.equal(formatStatusLine(withStatus(WORK, 85)), '📁 … · 대화 길이 85% · 새 대화를 권해요');
  assert.equal(formatStatusLine(withStatus(`${HOME}/a`, 85)), '📁 a · 대화 길이 85% · 새 대화를 권해요');
  assert.match(formatStatusLine(withStatus(WORK, 80)), /새 대화/);
  assert.match(formatStatusLine(withStatus(WORK, 100)), /새 대화/);
  const below = formatStatusLine(withStatus(WORK, 79.9));
  assert.equal(below, '📁 작업실 · 대화 길이 79%');
  assert.doesNotMatch(below, /새 대화/);
});

test('필드가 빠져도 오류 없이 📁 작업실을 낸다', () => {
  for (const s of [undefined, null, {}, '', '{', 'garbage', 42, [], { context_window: null }, { workspace: null, cwd: 7 }]) {
    assert.equal(formatStatusLine(s), '📁 작업실', JSON.stringify(s));
  }
  assert.equal(formatStatusLine({ cwd: WORK }), '📁 작업실');
  assert.equal(formatStatusLine({ workspace: { current_dir: HOME }, context_window: { used_percentage: null } }), '📁 내 폴더');
  assert.equal(formatStatusLine({ context_window: { used_percentage: 24 } }), '📁 작업실 · 대화 길이 24%');
});

test('상태 줄은 언제나 40칸 이하다(한글 2칸)', () => {
  const dirs = [
    '/current/working/directory',
    WORK,
    HOME,
    `/Users/tester/${'a'.repeat(80)}`,
    `/Users/tester/${'아주긴한글폴더이름'.repeat(4)}`,
    'C:\\Users\\tester\\my-very-long-project-folder-name-2026',
  ];
  const percents = [null, 0, 8, 24, 79, 80, 99, 100, 150, -5];
  for (const dir of dirs) {
    for (const percent of percents) {
      const line = formatStatusLine(withStatus(dir, percent));
      assert.ok(columns(line) <= 40, `${columns(line)}칸 → ${line}`);
      assertNoAbsolutePath(line, dir);
      if (percent !== null) assert.match(line, STATUS_RE);
      if (percent !== null && percent >= 80) assert.match(line, /새 대화/);
    }
  }
  assert.match(formatStatusLine(withStatus(WORK, 150)), /대화 길이 100%/);
  assert.match(formatStatusLine(withStatus(WORK, -5)), /대화 길이 0%/);
});

// ── 실제 요청 → samples.txt ──

function rbRequests() {
  return fs
    .readdirSync(RB_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => ({ file: f, body: JSON.parse(fs.readFileSync(path.join(RB_DIR, f), 'utf8')).body }));
}

function describeEvent(body) {
  switch (body.hook_event_name) {
    case 'PreToolUse':
      return { kind: 'start', out: describeToolStart(body) };
    case 'PostToolUse':
    case 'PostToolUseFailure':
      return { kind: 'end', out: describeToolEnd(body) };
    case 'PermissionRequest':
      return { kind: 'perm', out: describePermission(body) };
    case 'Notification':
      return { kind: 'notification', out: describeNotification(body) };
    case 'Stop':
      return { kind: 'stop', out: describeStop(body) };
    default:
      return { kind: 'none', out: null };
  }
}

function outTexts(out) {
  if (!out) return [];
  return [out.text, out.title, out.detail].filter((t) => typeof t === 'string');
}

function sampleLine(out) {
  if (!out) return '(보일 문구 없음)';
  if ('title' in out) return `[허락 카드] ${out.title}\n      ${out.detail.split('\n').join('\n      ')}\n      위험 표시: ${out.danger ? '예' : '아니요'}`;
  return `${out.icon} ${out.text}${'ok' in out ? (out.ok ? '' : '  (실패)') : ''}`;
}

test('실제 요청(rB)을 넣은 결과에 절대 경로·영어 설명이 없고, samples.txt로 남긴다', { skip: NO_RB }, () => {
  const reqs = rbRequests();
  assert.ok(reqs.length >= 30, `요청이 ${reqs.length}개뿐이에요`);
  const lines = [
    '# T5 한국어 문구 표본',
    '',
    `만든 때: ${new Date().toISOString()}`,
    '만든 곳: app/test/korean.test.js',
    '',
    '## 1. 실제 요청 (review/hook/runs/rB/requests, claude 2.1.296)',
    '',
  ];

  for (const { file, body } of reqs) {
    const { kind, out } = describeEvent(body);
    const input = body.tool_input || {};
    const allow = [input.command, input.file_path, input.url, input.query, input.pattern];
    for (const text of outTexts(out)) {
      assertNoAbsolutePath(text, file);
      assert.ok(HANGUL.test(text), `${file}: 한국어가 아니에요 → ${text}`);
      assert.deepEqual(foreignEnglish(text, allow), [], `${file}: 영어 단어가 보여요 → ${text}`);
    }
    if (kind === 'none') continue;
    lines.push(`${file.slice(0, 3)} ${body.hook_event_name}${body.tool_name ? `(${body.tool_name})` : ''}`);
    lines.push(`      ${sampleLine(out)}`);
  }

  const writePerm = describePermission(reqs.find((r) => r.file.startsWith('003-')).body);
  assert.equal(writePerm.title, '파일을 만들어도 될까요?');
  assert.ok(writePerm.detail.startsWith('kct-hook-ws 폴더에 a.txt 파일을 만들어요.'), writePerm.detail);
  const bashStart = describeToolStart(reqs.find((r) => r.file.startsWith('007-')).body);
  assert.equal(bashStart.text, '명령을 실행하고 있어요: touch b.txt');

  lines.push('', '## 2. 도구별 표 (시험 자료)', '');
  for (const c of CASES) {
    const { start, end, permission } = runCase(c);
    lines.push(`${c.name || c.kind}  (${c.tool})`);
    lines.push(`      시작: ${sampleLine(start)}`);
    lines.push(`      끝:   ${sampleLine(end)}`);
    lines.push(`      ${sampleLine(permission)}`);
  }

  lines.push('', '## 3. 위험 명령과 보통 명령', '');
  for (const command of [...DANGEROUS, ...SAFE]) {
    const p = describePermission(perm('Bash', { command }));
    lines.push(`${command}`);
    lines.push(`      ${sampleLine(p)}`);
  }

  lines.push('', '## 4. 알림·끝·실패', '');
  for (const type of ['permission_prompt', 'idle_prompt', 'auth_success', 'elicitation_dialog', 'agent_needs_input', 'quota_auto_resume_stale']) {
    lines.push(`Notification(${type})  →  ${sampleLine(describeNotification({ notification_type: type }))}`);
  }
  lines.push(`Stop  →  ${sampleLine(describeStop({}))}`);
  lines.push(`Stop(뒤에서 하는 일 1개)  →  ${sampleLine(describeStop({ background_tasks: [{ id: 't' }] }))}`);
  lines.push(
    `PostToolUseFailure(Bash)  →  ${sampleLine(
      describeToolEnd({ ...post('Bash', { command: 'npm test' }), hook_event_name: 'PostToolUseFailure' }),
    )}`,
  );

  lines.push('', '## 5. 상태 줄', '');
  lines.push(`문서 예시(doc-sample.json)  →  ${formatStatusLine(docSample)}`);
  for (const [dir, percent] of [
    [WORK, 24],
    [WORK, 79],
    [WORK, 85],
    [HOME, 50],
    [`${HOME}/my-very-long-project-folder-name-2026`, 30],
    [WORK, null],
  ]) {
    const line = formatStatusLine(withStatus(dir, percent));
    lines.push(`폴더 ${path.basename(dir)}, ${percent === null ? '대화 길이 모름' : `${percent}%`}  →  ${line}  (${columns(line)}칸)`);
  }
  lines.push(`필드 없음({})  →  ${formatStatusLine({})}`);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outFile = path.join(OUT_DIR, 'samples.txt');
  fs.writeFileSync(outFile, `${lines.join('\n')}\n`);
  const written = fs.readFileSync(outFile, 'utf8');
  assertNoAbsolutePath(written.split('## 2.')[0], 'samples.txt 1절');
});
