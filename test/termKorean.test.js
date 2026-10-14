'use strict';

// T10 터미널 영어 줄 → 한국어 덮개 규칙 시험.
// 시험 자료: test/fixtures/term/ (만든 방법은 그 폴더의 README.md)
//   v2.1.299/  실제 claude 2.1.299 캡처(80칸·120칸). capture.js로 다시 찍는다.
//   review/    저장소 review/의 10/13 캡처(허락 창·중단됨처럼 실제 모델이 있어야 뜨는 화면)
//   user/      사용자가 붙여 넣은 화면(읽기만). 기대값은 user-*.expected.json
//   t6/        T6의 2.1.296 캡처(test/fixtures/screens/)에 대한 기대값
// 자료마다 <이름>.expected.json = { cols, cursorRow, mustCover, mustNotCover, source }.
// 줄 번호는 make-expected.js의 줄 글 표로 정했다(번역 함수의 결과를 보고 정하지 않았다).
// 덮개 결과 표는 app/.test-tmp/T10/overlays.txt에 남는다.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');

const K = require('../src/shared/termKorean');

const { translateScreen, RULES, displayWidth } = K;
const APP = path.resolve(__dirname, '..');
const TERM = path.join(__dirname, 'fixtures', 'term');
const OUT = path.join(APP, '.test-tmp', 'T10');
const BINARY = path.join(os.homedir(), '.local', 'share', 'claude', 'versions', '2.1.299');
const KINDS = ['header', 'banner', 'dialog', 'option', 'hint', 'footer', 'permission', 'status'];

// ── 시험 자료 읽기 ──

function findExpected(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...findExpected(p));
    else if (e.name.endsWith('.expected.json')) out.push(p);
  }
  return out.sort();
}

const readLines = (file) => fs.readFileSync(file, 'utf8').replace(/\n$/, '').split('\n');

const FIXTURES = findExpected(TERM).map((expPath) => {
  const exp = JSON.parse(fs.readFileSync(expPath, 'utf8'));
  const file = exp.file ? path.resolve(path.dirname(expPath), exp.file) : expPath.replace(/\.expected\.json$/, '.txt');
  return { name: path.relative(TERM, expPath).replace(/\.expected\.json$/, ''), expPath, file, exp, lines: readLines(file) };
});

const run = (f, extra = {}) => translateScreen(f.lines, { cols: f.exp.cols, cursorRow: f.exp.cursorRow, debug: true, ...extra });
const coversRow = (ovs, r) => ovs.some((o) => r >= o.row && r < o.row + o.rows);

// 덮개 약속: 겹침 없음, 범위 안, 줄마다 표시 폭 ≤ width, 줄 수 ≤ rows, 커서 줄 안 덮음
function assertContract(ovs, lines, cols, cursorRow, where) {
  assert.ok(Array.isArray(ovs), `${where}: 배열이 아니에요`);
  for (const o of ovs) {
    const w = `${where} ${JSON.stringify({ row: o.row, col: o.col, rows: o.rows, width: o.width, text: o.text })}`;
    for (const k of ['row', 'col', 'rows', 'width']) assert.ok(Number.isInteger(o[k]), `${w}: ${k}가 정수가 아니에요`);
    assert.ok(o.row >= 0 && o.col >= 0 && o.rows >= 1 && o.width >= 1, `${w}: 크기가 이상해요`);
    assert.ok(o.col + o.width <= cols, `${w}: 오른쪽으로 넘쳐요(cols ${cols})`);
    assert.ok(o.row + o.rows <= lines.length, `${w}: 아래로 넘쳐요(줄 ${lines.length})`);
    assert.ok(KINDS.includes(o.kind), `${w}: 모르는 kind ${o.kind}`);
    assert.equal(typeof o.text, 'string');
    const tl = o.text.split('\n');
    assert.ok(tl.length <= o.rows, `${w}: 글 줄 수가 rows보다 많아요`);
    for (const t of tl) assert.ok(displayWidth(t) <= o.width, `${w}: "${t}" 폭 ${displayWidth(t)} > ${o.width}`);
    assert.ok(!(cursorRow >= o.row && cursorRow < o.row + o.rows), `${w}: 커서 줄(${cursorRow})을 덮어요`);
  }
  for (let i = 0; i < ovs.length; i++) {
    for (let j = i + 1; j < ovs.length; j++) {
      const a = ovs[i];
      const b = ovs[j];
      const clash = a.row < b.row + b.rows && b.row < a.row + a.rows && a.col < b.col + b.width && b.col < a.col + a.width;
      assert.ok(!clash, `${where}: 덮개끼리 겹쳐요 ${JSON.stringify(a)} / ${JSON.stringify(b)}`);
    }
  }
}

// ── 덮개 결과 표(검증자가 읽는 용도) ──

test.before(() => {
  fs.mkdirSync(OUT, { recursive: true });
  const out = [];
  for (const f of FIXTURES) {
    const ovs = run(f);
    out.push(`■ ${f.name}  (cols ${f.exp.cols}, 커서 줄 ${f.exp.cursorRow}, 출처: ${f.exp.source})`);
    f.lines.forEach((l, i) => {
      if (!l.trim()) return;
      const here = ovs.filter((o) => i >= o.row && i < o.row + o.rows);
      out.push(`${String(i).padStart(3)} ${here.length ? '■' : ' '} ${l}`);
      for (const o of here.filter((x) => x.row === i)) {
        out.push(`        → [${o.kind}, ${o.rule}, ${o.col}칸부터 ${o.width}칸 × ${o.rows}줄] ${o.text.replace(/\n/g, ' ⏎ ')}`);
      }
    });
    out.push('');
  }
  fs.writeFileSync(path.join(OUT, 'overlays.txt'), `${out.join('\n')}\n`);
});

// ── 자료 ──

test('자료가 15개 이상이고 사용자 화면 3개, 2.1.299 새 캡처 8개 이상이 들어 있으며 자료마다 출처가 적혀 있다', () => {
  assert.ok(FIXTURES.length >= 15, `자료 ${FIXTURES.length}개`);
  for (const f of FIXTURES) {
    assert.ok(typeof f.exp.source === 'string' && f.exp.source.length > 10, `${f.name}: 출처가 없어요`);
    assert.ok(Number.isInteger(f.exp.cols) && f.exp.cols > 0, `${f.name}: cols`);
    assert.ok(Number.isInteger(f.exp.cursorRow), `${f.name}: cursorRow`);
    assert.ok(Array.isArray(f.exp.mustCover) && Array.isArray(f.exp.mustNotCover), `${f.name}: mustCover·mustNotCover`);
    for (const r of [...f.exp.mustCover, ...f.exp.mustNotCover]) assert.ok(r >= 0 && r < f.lines.length, `${f.name}: 줄 번호 ${r}가 화면 밖이에요`);
  }
  const user = FIXTURES.filter((f) => /^user-/.test(f.name)).map((f) => path.basename(f.file));
  assert.deepEqual(user.sort(), ['01-trust.txt', '02-mcp-new-server.txt', '03-header-team.txt']);

  const manifest = JSON.parse(fs.readFileSync(path.join(TERM, 'v2.1.299', 'manifest.json'), 'utf8'));
  assert.match(manifest.claudeVersion, /^2\.1\.299 /);
  assert.match(manifest.command, /node test\/fixtures\/term\/capture\.js/);
  const caps = FIXTURES.filter((f) => f.name.startsWith('v2.1.299/'));
  assert.ok(caps.length >= 8, `2.1.299 캡처 ${caps.length}개`);
  for (const f of caps) {
    const m = manifest.screens.find((s) => s.file === path.basename(f.file));
    assert.ok(m, `${f.name}: manifest에 캡처 기록이 없어요`);
    assert.ok(m.note && m.launch && Array.isArray(m.before) && m.cursor, `${f.name}: 캡처 방법이 비었어요`);
    assert.equal(m.cursor.y, f.exp.cursorRow, `${f.name}: 커서 줄이 캡처 기록과 달라요`);
  }
  // 계획서가 꼽은 화면을 80칸·120칸 둘 다 캡처했다
  for (const screen of ['theme', 'login-method', 'trust', 'mcp-new-server', 'api-key', 'idle', 'mode-accept-edits', 'mode-plan-mode', 'mode-auto-mode']) {
    for (const cols of [80, 120]) assert.ok(caps.some((f) => path.basename(f.file) === `${screen}-${cols}.txt`), `${screen}-${cols} 캡처가 없어요`);
  }
  // 허락 창·사용량 한도·중단됨은 review/ 캡처(T6 자료 포함)를 쓴다
  const names = FIXTURES.map((f) => f.name);
  for (const n of ['review/perm-write-140', 'review/perm-bash-wrapped-100', 'review/interrupted-140', 't6/usage-limit.synthetic']) assert.ok(names.includes(n), `${n}이 없어요`);
  // 캡처 자료에 실제 홈 폴더 경로가 남지 않았다(사용자 화면은 붙여 넣은 그대로 둔다)
  for (const f of FIXTURES.filter((x) => !x.name.startsWith('user-'))) {
    assert.ok(!fs.readFileSync(f.file, 'utf8').includes(os.homedir()), `${f.name}에 실제 홈 경로가 있어요`);
  }
});

// 캡처 기록의 커서가 그 화면에서 말이 되는지 본다. claude 2.1.299는 커서를
// - 입력 칸(가로줄 바로 아래 ❯ 줄)이 있으면 그 입력 줄에 두고,
// - 입력 칸이 없고 고르기 목록이 있으면 고른 줄의 ❯ 표시 위에 두고,
// - 둘 다 없으면 그린 글 아래 빈 줄이나, 탭이 있는 화면(/help)에서는 고른 탭 이름 위에 둔다.
// manifest와 expected.json의 커서가 서로 같은지만 보면 둘 다 틀려도 통과하므로 화면 글과 맞춰 본다.
const RULE_LINE = /^\s*─{8,}\s*$/;

// 표시 폭 col칸 자리에서 시작하는 글자의 문자열 위치(그 자리가 글자 중간이면 -1)
function indexAtCol(line, col) {
  let w = 0;
  let i = 0;
  for (const ch of line) {
    if (w === col) return i;
    if (w > col) return -1;
    w += displayWidth(ch);
    i += ch.length;
  }
  return w === col ? i : -1;
}

function cursorProblem(lines, { x, y }) {
  const line = lines[y];
  if (line === undefined) return `커서 줄 ${y}가 화면 밖이에요`;
  const show = `${y}번 줄 ${x}칸(${JSON.stringify(line)})`;
  const input = lines.findIndex((l, i) => i > 0 && /^❯(\s|$)/.test(l) && RULE_LINE.test(lines[i - 1]));
  if (input >= 0) return y === input ? null : `입력 칸은 ${input}번 줄인데 커서가 ${show}에 있어요`;
  const picked = lines.flatMap((l, i) => (/^\s+❯ \S/.test(l) ? [i] : []));
  if (picked.length) {
    if (!picked.includes(y)) return `고른 줄은 ${picked.join(', ')}번인데 커서가 ${show}에 있어요`;
    const mark = displayWidth(line.slice(0, line.indexOf('❯')));
    return x === mark ? null : `커서가 ❯ 표시(${mark}칸) 위가 아니라 ${show}에 있어요`;
  }
  if (line.trim() === '') return null;
  const tabs = line.trim().split(/ {2,}/);
  const at = indexAtCol(line, x);
  if (tabs.length >= 3 && at >= 2 && line.slice(at - 2, at) === '  ' && tabs.some((t) => line.startsWith(t, at))) return null;
  return `입력 칸도 고른 줄도 없는 화면인데 커서가 글이 있는 ${show}에 있어요`;
}

test('캡처 기록의 커서가 그 화면에서 말이 된다(입력 칸이면 ❯ 입력 줄, 대화 상자면 ❯ 고른 줄, 둘 다 없으면 빈 줄이나 고른 탭)', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(TERM, 'v2.1.299', 'manifest.json'), 'utf8'));
  const caps = FIXTURES.filter((f) => f.name.startsWith('v2.1.299/'));
  const kinds = { input: 0, picked: 0, other: 0 };
  for (const f of caps) {
    const m = manifest.screens.find((s) => s.file === path.basename(f.file));
    assert.ok(f.exp.cursorRow >= 0, `${f.name}: 실제 캡처인데 커서 줄이 -1이에요`);
    const problem = cursorProblem(f.lines, m.cursor);
    assert.equal(problem, null, `${f.name}: ${problem}`);
    const line = f.lines[m.cursor.y];
    kinds[/^❯/.test(line) ? 'input' : /❯/.test(line) ? 'picked' : 'other']++;
  }
  // 세 경우가 모두 실제 캡처에 있다(확인이 한쪽으로만 돌지 않게)
  assert.ok(kinds.input >= 10 && kinds.picked >= 10 && kinds.other >= 4, JSON.stringify(kinds));

  // 시나리오가 끝난 뒤에 커서를 읽던 capture.js가 남긴 틀린 값(T10 1차 검증에서 찾음)은 이 확인에 걸린다
  const wrong = {
    'theme-120': [0, 26], 'theme-80': [0, 28], 'login-method-120': [0, 26], 'login-method-80': [0, 28],
    'logged-out-120': [2, 18], 'logged-out-80': [2, 20], 'slash-menu-120': [9, 20], 'shortcuts-help-120': [9, 20],
  };
  for (const [name, [x, y]] of Object.entries(wrong)) {
    const f = caps.find((c) => c.name === `v2.1.299/${name}`);
    assert.ok(cursorProblem(f.lines, { x, y }), `${name}: 틀린 커서 (${x}, ${y})를 알아채지 못해요`);
  }
  // 고른 줄이 맞아도 ❯ 표시가 아닌 자리, 입력 칸 대신 고르기 목록(/ 메뉴), 탭이 아닌 글자 위는 걸린다
  const theme = caps.find((c) => c.name === 'v2.1.299/theme-120');
  assert.ok(cursorProblem(theme.lines, { x: 5, y: theme.exp.cursorRow }));
  const slash = caps.find((c) => c.name === 'v2.1.299/slash-menu-120');
  assert.ok(cursorProblem(slash.lines, { x: 2, y: slash.lines.findIndex((l) => /^\s+❯ \//.test(l)) }));
  const help = caps.find((c) => c.name === 'v2.1.299/help-120');
  assert.ok(cursorProblem(help.lines, { x: 10, y: help.exp.cursorRow }));
  assert.ok(cursorProblem(help.lines, { x: 3, y: help.lines.findIndex((l) => /Claude understands/.test(l)) }));
});

test('모든 자료에서 mustCover 줄은 덮이고 mustNotCover 줄과 커서 줄은 덮이지 않는다', () => {
  let covered = 0;
  for (const f of FIXTURES) {
    const ovs = run(f);
    for (const r of f.exp.mustCover) assert.ok(coversRow(ovs, r), `${f.name}:${r} 덮이지 않았어요 → ${f.lines[r]}`);
    for (const r of f.exp.mustNotCover) assert.ok(!coversRow(ovs, r), `${f.name}:${r} 덮였어요 → ${f.lines[r]}`);
    if (f.exp.cursorRow >= 0) assert.ok(!coversRow(ovs, f.exp.cursorRow), `${f.name}: 커서 줄을 덮었어요`);
    covered += f.exp.mustCover.length;
  }
  assert.ok(covered >= 300, `덮어야 할 줄이 ${covered}개뿐이에요`);
});

test('모든 덮개가 크기 약속(겹침 없음, 범위 안, 표시 폭, 줄 수)을 지키고 잘린 글이 없다', () => {
  for (const f of FIXTURES) {
    const ovs = run(f);
    assertContract(ovs, f.lines, f.exp.cols, f.exp.cursorRow, f.name);
    for (const o of ovs) assert.ok(!o.truncated, `${f.name}:${o.row} 글이 잘렸어요 → ${o.text}`);
    // 커서를 빼고(-1) 돌려도 약속을 지킨다
    assertContract(run(f, { cursorRow: -1 }), f.lines, f.exp.cols, -1, `${f.name}(커서 없음)`);
  }
});

test('덮개는 원래 영어 글 자리를 빠짐없이 덮는다(밑의 영어가 비치지 않게)', () => {
  for (const f of FIXTURES) {
    for (const o of run(f)) {
      for (const sp of o.source) {
        assert.ok(sp.row >= o.row && sp.row < o.row + o.rows, `${f.name}: ${o.rule} 줄 밖`);
        assert.ok(sp.start >= o.col && sp.end <= o.col + o.width, `${f.name}:${sp.row} ${o.rule} 영어 ${sp.start}~${sp.end}칸을 다 덮지 못해요(덮개 ${o.col}~${o.col + o.width})`);
      }
    }
  }
});

// ── 글 ──

// 제품·모델·요금제 이름, 키 이름, 고정 폴더 이름. 명령(/login 등)과 화면에서 넘겨받은 이름(vars)은 따로 뺀다.
const ALLOWED_WORDS = new Set([
  'Claude', 'claude', 'Code', 'Opus', 'Sonnet', 'Haiku', 'Fable', 'Team', 'Enterprise', 'Console', 'Anthropic',
  'Amazon', 'Bedrock', 'Microsoft', 'Foundry', 'Google', 'Vertex', 'Enter', 'Shift', 'Space', 'Ctrl', 'ctrl',
]);

function englishWords(o) {
  let t = o.text.replace(/\n/g, ' ');
  for (const v of o.vars || []) t = t.split(v).join(' ');
  t = t.replace(/\/[a-z][a-z-]*/g, ' ');
  return (t.match(/[A-Za-z]{4,}/g) || []).filter((w) => !ALLOWED_WORDS.has(w));
}

test('덮개 글에 4글자 이상 영어 낱말이 없다(허용 목록: 제품·모델·요금제 이름, 명령, 키 이름, 화면에서 넘겨받은 이름)', () => {
  const seen = new Set();
  for (const f of FIXTURES) {
    for (const o of run(f, { cursorRow: -1 })) {
      assert.deepEqual(englishWords(o), [], `${f.name}:${o.row} ${o.rule} → ${o.text}`);
      seen.add(o.rule);
    }
  }
  for (const r of RULES) {
    for (const o of translateScreen(r.sample.split('\n'), { cols: 120, cursorRow: -1, debug: true })) {
      assert.deepEqual(englishWords(o), [], `${r.id} sample → ${o.text}`);
    }
  }
  assert.ok(seen.size >= 30);
});

test('덮개 글은 해요체이고 한글이 들어 있다', () => {
  const texts = new Set();
  for (const f of FIXTURES) for (const o of run(f, { cursorRow: -1 })) texts.add(o.text.replace(/\n/g, ' '));
  for (const r of RULES) for (const o of translateScreen(r.sample.split('\n'), { cols: 120, cursorRow: -1 })) texts.add(o.text.replace(/\n/g, ' '));
  for (const t of texts) {
    assert.match(t, /[가-힣]/, `한글이 없어요 → ${t}`);
    assert.doesNotMatch(t, /니다|한다[.]|이다[.]/, `합쇼체·평서체 → ${t}`);
    // 한글 바로 뒤에 마침표·물음표·느낌표가 오면(문장 끝) 그 글자는 "요"다
    for (const m of t.matchAll(/([가-힣])(?=[.?!](?:\s|\)|$))/g)) assert.equal(m[1], '요', `해요체가 아닌 문장 → ${t}`);
  }
});

// ── 덮지 않는 것 ──

const IDLE_BOTTOM = ['', '─'.repeat(100), '❯ ', '─'.repeat(100), '  ⏸ manual mode on · ? for shortcuts · ← for agents'];

test('덮으면 안 되는 영어 줄 30개 이상에서 덮개가 0개다(홀로, 대화 기록 안, 대화 상자 안)', () => {
  const { lines } = JSON.parse(fs.readFileSync(path.join(TERM, 'negative-lines.json'), 'utf8'));
  assert.ok(lines.length >= 30, `${lines.length}개`);
  for (const line of lines) {
    const contexts = [
      { name: '홀로', screen: [line], row: 0 },
      { name: '대화 기록 안', screen: ['❯ 질문했어요', '', line, '', ...IDLE_BOTTOM], row: 2 },
      { name: '대화 상자 안', screen: ['', '─'.repeat(100), ' Tool use', '', line, '', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', '', ' Esc to cancel · Tab to amend'], row: 4 },
    ];
    for (const c of contexts) {
      const ovs = translateScreen(c.screen, { cols: 120, cursorRow: -1, debug: true });
      assert.ok(!coversRow(ovs, c.row), `${c.name}: 덮였어요 → ${line} ${JSON.stringify(ovs.filter((o) => o.row <= c.row && c.row < o.row + o.rows))}`);
      assertContract(ovs, c.screen, 120, -1, `${c.name}: ${line}`);
    }
    // 홀로 둔 줄은 아무것도 덮지 않는다
    assert.deepEqual(translateScreen([line], { cols: 120, cursorRow: -1 }), [], line);
  }
});

test('Claude의 답 안에 화면 문구를 옮겨 적어도 덮지 않는다(입력 칸이 있으면 대화 상자 규칙을 쓰지 않는다)', () => {
  const screen = [
    '❯ 신뢰 창이 뭐예요?', '',
    '⏺ The trust dialog looks like this:', '   ❯ No, exit', '     Yes, I trust this folder', '',
    ' Enter to confirm · Esc to cancel', ' Do you want to proceed?', '', ...IDLE_BOTTOM,
  ];
  const ovs = translateScreen(screen, { cols: 100, cursorRow: -1, debug: true });
  for (let r = 0; r < 9; r++) assert.ok(!coversRow(ovs, r), `${r}: ${screen[r]}`);
  assert.ok(coversRow(ovs, screen.length - 1), '아래 모드 줄은 덮어요');
});

test('사용자가 친 글과 입력 칸은 덮지 않는다', () => {
  const screen = ['', '─'.repeat(80), '❯ Do you want to proceed?', '  Yes, I trust this folder', '─'.repeat(80), '  ⏸ manual mode on · ? for shortcuts · ← for agents'];
  const ovs = translateScreen(screen, { cols: 80, cursorRow: -1, debug: true });
  for (const r of [1, 2, 3, 4]) assert.ok(!coversRow(ovs, r), `${r}: ${screen[r]}`);
  assert.ok(coversRow(ovs, 5));
});

test('명령 모드(맨 앞에 !)의 입력 칸도 입력 칸으로 알아보고 사용자가 친 글을 덮지 않는다', () => {
  const R = '─'.repeat(80);
  const screen = ['⏺ 다 했어요.', '', R, '! echo hi', '  Usage limit reached', '  Claude Code v2.1.299', R, '  ⏸ manual mode on · ? for shortcuts'];
  const ovs = translateScreen(screen, { cols: 80, cursorRow: -1, debug: true });
  for (let r = 0; r < screen.length - 1; r++) assert.ok(!coversRow(ovs, r), `${r}: ${screen[r]}`);
  assert.ok(coversRow(ovs, screen.length - 1), '아래 모드 줄은 덮어요');
});

test('입력 칸 아래 가로줄이 화면 밖이거나 입력이 길어도 사용자가 친 글은 덮지 않는다', () => {
  const R = '─'.repeat(80);
  // 화면을 위로 조금 올려 입력 칸 아래 가로줄과 모드 줄이 안 보인다
  const half = ['⏺ 다 했어요.', '', R, '❯ 1. Yes', '  Do you want to proceed?', '  Usage limit reached'];
  assert.deepEqual(translateScreen(half, { cols: 80, cursorRow: -1 }), []);
  // 입력이 15줄을 넘는다
  const tall = ['', R, '❯ 첫 줄', ...Array.from({ length: 16 }, (_, i) => `  ${i}번째 줄`), '  Usage limit reached', R, '  ⏸ manual mode on · ? for shortcuts'];
  const ovs = translateScreen(tall, { cols: 80, cursorRow: -1, debug: true });
  for (let r = 0; r < tall.length - 1; r++) assert.ok(!coversRow(ovs, r), `${r}: ${tall[r]}`);
  assert.ok(coversRow(ovs, tall.length - 1), '아래 모드 줄은 덮어요');
});

test('입력 칸이 안 보이는 화면에서 맨 앞 "❯ 1. …" 한 줄은 사용자가 보낸 글로 보고 덮지 않는다(질문 창의 번호 목록은 덮는다)', () => {
  // 화면을 위로 올렸거나 claude가 끝나 입력 칸이 없는 대화 기록
  const history = ['⏺ Pick one:', '', '  1. Yes', '  2. No', '', '❯ 1. Yes', '', '⏺ OK, going with Yes.'];
  assert.deepEqual(translateScreen(history, { cols: 80, cursorRow: -1 }), []);
  // AskUserQuestion 창은 고르기 줄이 맨 앞 ❯와 번호로 시작한다(review/policy-alternatives/mod-poc/tmux-05-auto-mode.txt)
  const ask = ['', '─'.repeat(80), ' ☐ Pick', 'Which one?', '❯ 1. Yes', '  2. No', '', 'Enter to select · ↑/↓ to navigate · Esc to cancel'];
  const ovs = translateScreen(ask, { cols: 80, cursorRow: -1, debug: true });
  assert.deepEqual(ovs.filter((o) => o.kind === 'option').map((o) => [o.row, o.col, o.text]), [[4, 5, '네'], [5, 5, '아니요']]);
  assert.ok(coversRow(ovs, 7));
});

test('입력 칸이 안 보여도 대화 기록 줄(⏺ 답, 맨 앞 ❯ 사용자 글, ⎿ 도구 결과)이 보이면 대화 상자 문구로 덮지 않는다(위로 올려 보기, claude 종료 뒤)', () => {
  // 명령 출력에 대화 상자 문구가 찍혔다
  const tool = ['⏺ Bash(./ask.sh)', '  ⎿  Do you want to proceed?', '     Esc to cancel', '     Security notes:', '     Enter to confirm · Esc to cancel', '', '⏺ Done.'];
  assert.deepEqual(translateScreen(tool, { cols: 80, cursorRow: -1 }), []);
  // 사용자가 영어 화면 문구를 붙여 넣어 물었다
  const user = ['❯ 이 문구들 무슨 뜻이에요?', '  Security notes:', '  Do you want to proceed?', '  Esc to cancel', '', '⏺ 하나씩 설명할게요.'];
  assert.deepEqual(translateScreen(user, { cols: 80, cursorRow: -1 }), []);
  // 머리말은 기록 안에서도 덮는다
  const scrolled = [' ▐▛███▛█   Claude Code v2.1.299', '▝▜██████▀  Opus 5.5 · Claude Team', '', '❯ hi', '', '⏺ Hello!', '  Security notes:'];
  assert.deepEqual(translateScreen(scrolled, { cols: 80, cursorRow: -1, debug: true }).map((o) => o.rule), ['header-version', 'header-model']);
});

test('허락 창의 미리보기(╌ 줄 사이의 명령·파일 내용)는 아는 문구가 들어 있어도 덮지 않는다', () => {
  const D = '╌'.repeat(100);
  const body = [D, " cat > notes.txt <<'EOF'", ' Do you want to proceed?', ' Security notes:', ' Esc to cancel', '  Usage limit reached', ' Claude Code v2.1.299', ' EOF', D];
  const tail = [' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', '', ' Esc to cancel · Tab to amend'];
  const screen = ['', '─'.repeat(100), ' Bash command', ' Write notes', ...body, ...tail];
  const ovs = translateScreen(screen, { cols: 100, cursorRow: -1, debug: true });
  const first = 4;
  for (let r = first; r < first + body.length; r++) assert.ok(!coversRow(ovs, r), `${r}: ${screen[r]}`);
  assert.deepEqual(ovs.map((o) => o.rule), ['perm-title-bash', 'perm-q-proceed', 'option-yes', 'option-no', 'hint-esc-cancel+hint-tab-amend']);
  // 창이 길어 위쪽(가로줄·제목·미리보기 위 ╌ 줄)이 화면 밖으로 밀려나도 미리보기는 덮지 않고 그 아래만 덮는다
  const cut = screen.slice(first + 2);
  const ovs2 = translateScreen(cut, { cols: 100, cursorRow: -1, debug: true });
  for (let r = 0; r < body.length - 2; r++) assert.ok(!coversRow(ovs2, r), `${r}: ${cut[r]}`);
  assert.deepEqual(ovs2.map((o) => o.rule), ['perm-q-proceed', 'option-yes', 'option-no', 'hint-esc-cancel+hint-tab-amend']);
});

// ── 커서, 고르기 줄 ──

test('커서 줄은 덮지 않고, 커서를 빼면 같은 고르기 줄을 ❯와 번호를 남긴 채 덮는다', () => {
  const trust = FIXTURES.find((f) => f.name === 'v2.1.299/trust-120');
  assert.equal(trust.lines[trust.exp.cursorRow], ' ❯ No, exit');
  assert.ok(!coversRow(run(trust), trust.exp.cursorRow));
  const free = run(trust, { cursorRow: -1 });
  const o = free.find((x) => x.row === trust.exp.cursorRow);
  assert.ok(o, '커서가 없으면 덮어요');
  assert.equal(o.text, '아니요, 나가기');
  assert.equal(o.col, 3, '❯ 표시(1칸)와 띄어쓰기 뒤부터 덮어요');

  const perm = FIXTURES.find((f) => f.name === 'review/perm-bash-140');
  const ovs = run(perm);
  const yes = ovs.find((x) => perm.lines[x.row] === ' ❯ 1. Yes');
  assert.ok(yes && yes.col === 6 && yes.text === '네', JSON.stringify(yes));
  const no = ovs.find((x) => perm.lines[x.row] === '   4. No');
  assert.ok(no && no.col === 6 && no.text === '아니요', JSON.stringify(no));
});

test('모든 고르기 덮개는 앞의 ❯ 표시, 번호, ✔ 표시를 덮지 않는다', () => {
  let n = 0;
  for (const f of FIXTURES) {
    for (const o of run(f, { cursorRow: -1 })) {
      if (o.kind !== 'option') continue;
      const line = f.lines[o.row];
      const head = /^(\s*(?:❯ +)?(?:\d+\. +)?(?:✔ +)?)/.exec(line)[1];
      assert.equal(o.col, displayWidth(head), `${f.name}:${o.row} ${line}`);
      n++;
    }
  }
  assert.ok(n >= 40, `고르기 덮개 ${n}개`);
});

test('좁은 화면에서 여러 줄로 접힌 고르기·문단도 한 덮개로 덮는다', () => {
  const f = FIXTURES.find((x) => x.name === 'review/perm-bash-wrapped-100');
  const o = run(f).find((x) => x.rule === 'option-perm-always-dir');
  assert.ok(o, '접힌 선택지를 알아봐요');
  assert.equal(o.rows, 3);
  assert.match(o.text.replace(/\n/g, ' '), /^네, 그리고 이 프로젝트에서는 \/Users\/tester\/.+work_plain 접근을 늘 허락하기$/);
  for (const cols of [80, 120]) {
    const t = FIXTURES.find((x) => x.name === `v2.1.299/trust-${cols}`);
    const s = run(t).find((x) => x.rule === 'trust-safety-check');
    assert.equal(s.rows, cols === 80 ? 3 : 2);
  }
});

test('claude 문구가 하나 바뀌면 그 줄만 영어로 남고 나머지는 그대로 덮인다', () => {
  const f = FIXTURES.find((x) => x.name === 'v2.1.299/trust-120');
  const before = run(f);
  const i = f.lines.indexOf(' Security guide');
  const changed = f.lines.slice();
  changed[i] = ' Security handbook';
  const after = translateScreen(changed, { cols: 120, cursorRow: f.exp.cursorRow, debug: true });
  assert.ok(!coversRow(after, i));
  assert.equal(after.length, before.length - 1);
  for (const r of f.exp.mustCover.filter((x) => x !== i)) assert.ok(coversRow(after, r), `${r}: ${f.lines[r]}`);
});

// ── 번역 ──

test('모델 줄은 쉬운 말로 푼다(모델·생각 깊이·요금제), effort 다섯 단계', () => {
  const user = FIXTURES.find((x) => x.name === 'user-03-header-team');
  const o = run(user).find((x) => x.row === 1);
  assert.equal(o.text, '모델 Opus 5.5 · 생각 깊이 아주 깊게 · Team 요금제');
  const ko = { low: '가볍게', medium: '보통', high: '깊게', xhigh: '아주 깊게', max: '최대' };
  for (const [level, word] of Object.entries(ko)) {
    const ovs = translateScreen([' Claude Code v2.1.299', `  Sonnet 4.6 with ${level} effort · Claude Max`], { cols: 80, cursorRow: -1 });
    assert.equal(ovs[1].text, `모델 Sonnet 4.6 · 생각 깊이 ${word} · Max 요금제`);
  }
  const api = translateScreen([' ▐▛███▛█   Claude Code v2.1.299', '▝▜██████▀  Opus 5.5 · API Usage Billing'], { cols: 80, cursorRow: -1 });
  assert.equal(api[1].text, '모델 Opus 5.5 · 쓴 만큼 내는 요금');
  assert.equal(api[0].col, 11, '로고 글자는 덮지 않아요');
  // 머리말이 아닌 곳의 "Opus 5.5 · Claude Team"은 덮지 않는다
  assert.deepEqual(translateScreen(['  Opus 5.5 · Claude Team'], { cols: 80, cursorRow: -1 }), []);
});

test('신뢰 창·허락 창의 안전 경고는 뜻을 빼지 않고 옮긴다', () => {
  const t = run(FIXTURES.find((x) => x.name === 'v2.1.299/trust-80'), { cursorRow: -1 });
  const all = t.map((o) => o.text.replace(/\n/g, ' ')).join(' / ');
  for (const must of ['안전 확인', '믿을 수 있는', '살펴보세요', '읽고, 고치고, 실행', '나가기', '이 폴더를 믿어요']) assert.ok(all.includes(must), `${must} → ${all}`);
  const sec = run(FIXTURES.find((x) => x.name === 'v2.1.299/security-notes-120')).map((o) => o.text.replace(/\n/g, ' ')).join(' / ');
  for (const must of ['실수할 수', '내 책임', '늘 확인', '확인하세요', '프롬프트 주입', '믿는 코드에서만']) assert.ok(sec.includes(must), `${must} → ${sec}`);
  const helper = RULES.find((r) => r.id === 'trust-headers-helper');
  assert.match(translateScreen(helper.sample.split('\n'), { cols: 120, cursorRow: -1 })[0].text, /명령을 실행/);
  const auto = run(FIXTURES.find((x) => x.name === 'v2.1.299/mode-auto-mode-80')).find((o) => o.rule === 'banner-auto-mode-desc');
  for (const must of ['위험', '프롬프트 주입', '해로운 명령', '분리된 환경', 'Shift+Tab']) assert.ok(auto.text.replace(/\n/g, ' ').includes(must), must);
  const mcp = run(FIXTURES.find((x) => x.name === 'user-02-mcp-new-server')).map((o) => o.text.replace(/\n/g, ' ')).join(' / ');
  for (const must of ['외부 도구 연결(MCP)', '코드를 실행', '허락을 받아요', 'bigquery']) assert.ok(mcp.includes(must), must);
  const dirOpt = run(FIXTURES.find((x) => x.name === 'review/perm-bash-140')).find((o) => o.rule === 'option-perm-always-dir');
  assert.match(dirOpt.text, /늘 허락/);
});

test('사용량 한도 시각은 오전·오후로 바꾸고, 모르는 모양은 그대로 둔다', () => {
  const one = (line) => translateScreen([line], { cols: 100, cursorRow: -1 })[0].text;
  assert.equal(one("  ⎿  You've hit your session limit · resets 3:45pm"), '이번 사용 한도를 다 썼어요 · 오후 3시 45분에 다시 채워져요');
  assert.equal(one("  ⎿  You've hit your weekly limit · resets Mon 12am"), '이번 주 사용 한도를 다 썼어요 · 월요일 오전 12시에 다시 채워져요');
  assert.equal(one("  ⎿  You've hit your Opus limit"), 'Opus 사용 한도를 다 썼어요');
  assert.equal(one('Usage limit reached · continuing automatically at 9am · esc to cancel'), '사용 한도에 닿았어요 · 오전 9시에 저절로 이어서 해요 · Esc로 취소');
  assert.match(one("  ⎿  You've hit your session limit · resets Oct 20, 9am"), /Oct 20, 9am/);
});

// ── RULES ──

test('RULES마다 id·kind·sample·evidence가 있고, sample을 넣으면 그 규칙의 덮개가 나온다', () => {
  const ids = new Set();
  assert.ok(RULES.length >= 40);
  for (const r of RULES) {
    assert.deepEqual(Object.keys(r).sort(), ['evidence', 'id', 'kind', 'sample']);
    assert.ok(!ids.has(r.id), `id가 겹쳐요: ${r.id}`);
    ids.add(r.id);
    assert.ok(KINDS.includes(r.kind), `${r.id}: kind ${r.kind}`);
    assert.ok(r.sample && r.evidence, r.id);
    const lines = r.sample.split('\n');
    const ovs = translateScreen(lines, { cols: 120, cursorRow: -1, debug: true });
    assertContract(ovs, lines, 120, -1, `${r.id} sample`);
    assert.ok(ovs.some((o) => o.rule.split('+').includes(r.id)), `${r.id}: sample에서 덮개가 안 나와요 ${JSON.stringify(ovs.map((o) => o.rule))}`);
  }
  for (const kind of KINDS) assert.ok(RULES.some((r) => r.kind === kind), `${kind} 규칙이 없어요`);
});

// grep -a -c -F와 같은 셈: 바이너리를 줄바꿈으로 나눴을 때 문구가 든 줄 수
function grepCount(buf, phrase) {
  const needle = Buffer.from(phrase, 'utf8');
  let count = 0;
  let pos = buf.indexOf(needle);
  while (pos !== -1) {
    count++;
    const nl = buf.indexOf(0x0a, pos + needle.length);
    if (nl === -1) break;
    pos = buf.indexOf(needle, nl + 1);
  }
  return count;
}

test('규칙마다 근거가 있다: 바이너리 문구는 claude 2.1.299에 있고(grep -a -c), 캡처 경로는 그 규칙이 덮는 화면이다', (t) => {
  const files = [];
  const phrases = [];
  for (const r of RULES) (/^(?:test|review)\//.test(r.evidence) ? files : phrases).push(r);
  // 캡처 경로: 저장소 안의 파일이고, 그 화면을 넣으면 이 규칙의 덮개가 나온다
  const repo = path.resolve(APP, '..');
  for (const r of files) {
    const file = r.evidence.startsWith('test/') ? path.join(APP, r.evidence) : path.join(repo, r.evidence);
    if (r.evidence.startsWith('review/') && !fs.existsSync(path.join(repo, 'review'))) continue; // 공개 저장소에는 review/가 없다
    assert.ok(fs.existsSync(file), `${r.id}: ${r.evidence}가 없어요`);
    const lines = readLines(file);
    const ovs = translateScreen(lines, { cursorRow: -1, debug: true });
    assert.ok(ovs.some((o) => o.rule.split('+').includes(r.id)), `${r.id}: ${r.evidence}에서 이 규칙이 안 나와요`);
  }
  if (!fs.existsSync(BINARY)) {
    t.skip(`claude 2.1.299 바이너리가 없어요(${BINARY}). 바이너리 문구 ${phrases.length}개는 확인하지 못했어요`);
    return;
  }
  const buf = fs.readFileSync(BINARY);
  const counts = {};
  for (const r of phrases) {
    counts[r.id] = grepCount(buf, r.evidence);
    assert.ok(counts[r.id] >= 1, `${r.id}: "${r.evidence}"가 2.1.299 바이너리에 없어요`);
  }
  // 위 셈이 grep -a -c -F와 같은지 하나를 실제 grep으로 맞춰 본다(BSD grep은 한 번에 4초쯤 걸린다)
  const sample = RULES.find((r) => r.id === 'trust-accessing');
  const real = Number(execFileSync('/usr/bin/grep', ['-a', '-c', '-F', '--', sample.evidence, BINARY], { encoding: 'utf8' }).trim());
  assert.equal(real, grepCount(buf, sample.evidence));
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'evidence.txt'), `${RULES.map((r) => `${r.id.padEnd(34)} ${counts[r.id] !== undefined ? `grep -a -c ${String(counts[r.id]).padStart(3)}` : '캡처      '}  ${r.evidence}`).join('\n')}\n`);
  assert.ok(phrases.length >= 50, `바이너리 근거 ${phrases.length}개`);
});

// ── 2.1.296 캡처 ──

test('T6의 2.1.296 캡처에서도 같은 화면이 덮인다', () => {
  const t6 = FIXTURES.filter((f) => f.name.startsWith('t6/'));
  assert.ok(t6.length >= 20);
  const want = {
    'theme': 'option-theme', 'login-method': 'option-login-subscription', 'login-browser': 'login-browser', 'api-key': 'api-key-question',
    'press-enter': 'press-enter', 'trust': 'trust-safety-check', 'trust-80cols': 'trust-safety-check', 'idle': 'header-model',
    'auth-error': 'status-invalid-key-fix', 'auth-logged-out': 'status-not-logged-in', 'login-method-slash': 'login-title',
    'permission-write': 'perm-q-create', 'permission-bash': 'option-perm-always-dir', 'idle-after-work': 'banner-remote-control-disabled',
    'usage-limit.synthetic': 'status-hit-limit', 'usage-limit-waiting.synthetic': 'status-limit-continuing',
  };
  for (const [name, rule] of Object.entries(want)) {
    const f = t6.find((x) => x.name === `t6/${name}`);
    assert.ok(f, name);
    assert.ok(run(f).some((o) => o.rule.split('+').includes(rule)), `${name}: ${rule}이 안 나와요`);
  }
  for (const name of ['other-claude-help', 'other-ls-root']) assert.deepEqual(run(t6.find((x) => x.name === `t6/${name}`)), [], name);
});

// ── 폭 계산 ──

test('표시 폭 계산이 xterm(@xterm/headless, 유니코드 6)과 같다', async () => {
  const { Terminal } = require('@xterm/headless');
  const term = new Terminal({ cols: 300, rows: 5, allowProposedApi: true });
  const write = (s) => new Promise((res) => term.write(s, res));
  const lines = new Set(['📁 작업실 · 대화 길이 24%', '작업실'.normalize('NFD'), '⏺⎿❯◐○●◉◈⏸⏵⚠▎✻✽…·—←↑↓✔╌─│▐▛█▝▜▀▘▗▟▄▂', 'é'.normalize('NFD'), '가\u200b나', '한글 English 漢字 ｶﾀｶﾅ ＡＢ']);
  for (const f of FIXTURES) for (const l of f.lines) lines.add(l);
  for (const r of RULES) for (const o of translateScreen(r.sample.split('\n'), { cols: 120, cursorRow: -1 })) lines.add(o.text.split('\n')[0]);
  let checked = 0;
  for (const l of lines) {
    const w = displayWidth(l);
    if (w >= 299) continue;
    await write(`\x1b[H\x1b[2K${l}`);
    assert.equal(term.buffer.active.cursorX, w, `폭이 달라요: ${JSON.stringify(l)}`);
    checked++;
  }
  term.dispose();
  assert.ok(checked >= 300, `${checked}줄`);
});

// ── 속도 ──

function bigScreen(kind) {
  const W = 200;
  const long = 'The quick brown fox jumps over the lazy dog while Claude explains why the build failed and how to fix the failing test in src/index.ts quickly. ';
  const fill = (s) => (s + long.repeat(3)).slice(0, W - 2);
  if (kind === 'dialog') {
    const lines = [' ▐▛███▛█   Claude Code v2.1.299', '▝▜██████▀  Opus 5.5 (1M context) with xhigh effort · Claude Team', ' ▝▝   ▝▝   ~/Documents/작업실', ''];
    for (let i = 0; lines.length < 38; i++) lines.push(i % 3 ? `  ${fill('')}` : `⏺ ${fill('')}`);
    lines.push('─'.repeat(W), ' Accessing workspace:', '', ' /Users/tester/Documents/작업실', '',
      " Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what's in this folder first.".slice(0, W),
      '', " Claude Code'll be able to read, edit, and execute files here.", '', ' Security guide', '', ' ❯ No, exit', '   Yes, I trust this folder', '', ' Enter to confirm · Esc to cancel');
    while (lines.length < 60) lines.push('');
    return lines;
  }
  const lines = [' ▐▛███▛█   Claude Code v2.1.299', '▝▜██████▀  Opus 5.5 (1M context) with xhigh effort · Claude Team', ' ▝▝   ▝▝   ~/Documents/작업실', '',
    '⚠ Your login expires in 3 days · run /login to renew', '', '▎ Message from Acme:', '▎ 안녕하세요!', '',
    "⏺ Remote Control is disabled by your organization's policy. Contact your organization admin for access.", ''];
  for (let i = 0; lines.length < 54; i++) {
    const k = i % 6;
    lines.push(k === 0 ? `❯ ${fill('')}` : k === 1 ? `⏺ ${fill('')}` : k === 2 ? '  ⎿  Interrupted · What should Claude do instead?' : k === 3 ? `  ${fill('')}` : k === 4 ? '      1 const answer = 42;' : '');
  }
  lines.push(`${' '.repeat(W - 20)}◐ medium · /effort`, '─'.repeat(W), '❯ 한글 입력', '─'.repeat(W), `  ⏸ manual mode on · ? for shortcuts · ← 2 agents${' '.repeat(W - 70)}Not logged in · Run /login`, `${' '.repeat(W - 20)}/rc connecting…`);
  return lines;
}

test('200칸×60줄 화면에서 translateScreen 한 번이 평균 2ms 이하다', () => {
  for (const kind of ['conversation', 'dialog']) {
    const lines = bigScreen(kind);
    assert.equal(lines.length, 60);
    const opts = { cols: 200, cursorRow: kind === 'dialog' ? -1 : 56 };
    const ovs = translateScreen(lines, opts);
    assertContract(ovs, lines, 200, opts.cursorRow, kind);
    assert.ok(ovs.length >= 8, `${kind}: 덮개 ${ovs.length}개`);
    for (let i = 0; i < 50; i++) translateScreen(lines, opts); // 데우기
    const N = 400;
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < N; i++) translateScreen(lines, opts);
    const avg = Number(process.hrtime.bigint() - t0) / 1e6 / N;
    fs.mkdirSync(OUT, { recursive: true });
    fs.appendFileSync(path.join(OUT, 'speed.txt'), `${new Date().toISOString()} ${kind} 200x60 평균 ${avg.toFixed(3)}ms (${N}번)\n`);
    assert.ok(avg <= 2, `${kind}: 평균 ${avg.toFixed(3)}ms`);
  }
});

test('줄 가운데 빈칸이 긴 넓은 화면(400칸×100줄)도 translateScreen 한 번이 평균 5ms 이하다(줄 끝 공백 지우기가 칸 수의 제곱으로 늘지 않는다)', () => {
  const W = 400;
  const lines = Array.from({ length: 100 }, (_, i) => (i % 2
    ? `  ⏸ manual mode on${' '.repeat(W - 60)}Not logged in · Run /login`
    : `${' '.repeat(W - 20)}◐ medium · /effort`));
  for (let i = 0; i < 10; i++) translateScreen(lines, { cols: W, cursorRow: -1 }); // 데우기
  const N = 50;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) translateScreen(lines, { cols: W, cursorRow: -1 });
  const avg = Number(process.hrtime.bigint() - t0) / 1e6 / N;
  assert.ok(avg <= 5, `평균 ${avg.toFixed(3)}ms`);
});

// ── 섞인 화면, 이상한 입력 ──

test('자료 줄을 마구 섞은 화면에서도 약속을 지키고 오류가 나지 않는다', () => {
  const pool = [];
  for (const f of FIXTURES) pool.push(...f.lines);
  let seed = 7;
  const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let k = 0; k < 300; k++) {
    const rows = 5 + rand(50);
    const cols = [40, 60, 80, 100, 120, 140][rand(6)];
    const lines = [];
    for (let i = 0; i < rows; i++) {
      const l = pool[rand(pool.length)];
      lines.push(displayWidth(l) > cols ? l.slice(0, cols) : l);
    }
    const cursorRow = rand(rows + 2) - 1;
    const ovs = translateScreen(lines, { cols, cursorRow });
    assertContract(ovs, lines, cols, cursorRow, `섞은 화면 ${k}`);
  }
});

test('이상한 입력에도 오류 없이 빈 배열을 돌려준다', () => {
  for (const bad of [undefined, null, 42, 'Accessing workspace:', {}, []]) assert.deepEqual(translateScreen(bad), [], String(bad));
  assert.deepEqual(translateScreen([null, undefined, 3]), []);
  assert.deepEqual(translateScreen(['', '', '']), []);
  // cols를 안 주면 가장 넓은 줄 폭을 쓴다
  const ovs = translateScreen([' Accessing workspace:']);
  assert.equal(ovs.length, 1);
  assertContract(ovs, [' Accessing workspace:'], displayWidth(' Accessing workspace:'), -1, 'cols 없음');
  // 줄 끝 공백·NBSP가 섞여도 같다
  assert.deepEqual(
    translateScreen(['  ⎿\u00a0 Interrupted · What should Claude do instead?   '], { cols: 80 }).map((o) => o.text),
    ['멈췄어요 · Claude가 대신 무엇을 할까요?'],
  );
});

// ── renderer에서 쓰기 ──

test('renderer(<script>)에서도 window.KctTermKorean으로 쓸 수 있고 DOM·Node API를 쓰지 않는다', () => {
  const src = fs.readFileSync(path.join(APP, 'src', 'shared', 'termKorean.js'), 'utf8');
  const code = src.replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(code, /\brequire\s*\(|\bprocess\.|\bdocument\b|\bBuffer\b|\bwindow\./);
  const win = {};
  win.window = win;
  vm.runInNewContext(src, win, { filename: 'termKorean.js' });
  assert.equal(typeof win.KctTermKorean.translateScreen, 'function');
  const ovs = win.KctTermKorean.translateScreen([' Accessing workspace:'], { cols: 40, cursorRow: -1 });
  assert.equal(ovs.length, 1);
  assert.equal(ovs[0].text, '작업할 폴더:');
  assert.ok(Array.isArray(win.KctTermKorean.RULES) && win.KctTermKorean.RULES.length === RULES.length);
});
