'use strict';

// T6 영어 화면 안내 시험.
// 시험 자료: test/fixtures/screens/ (만든 방법은 manifest.json과 README.md)
// 오류 문구 근거: https://code.claude.com/docs/en/errors (Usage limits, Authentication errors 절),
//   https://code.claude.com/docs/en/interactive-mode#wait-for-a-usage-limit-to-reset
// 실제 claude에 키를 보내 보는 시험은 test/screenGuide.live.js에 있다.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { detectScreen } = require('../src/main/screenGuide');

const DIR = path.join(__dirname, 'fixtures', 'screens');
const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));
const read = (file) => fs.readFileSync(path.join(DIR, file), 'utf8');

const ENTER = '\r';
const UP = '\x1b[A';
const DOWN = '\x1b[B';
const IDS = ['trust', 'theme', 'login-method', 'api-key', 'permission', 'press-enter', 'auth-error', 'usage-limit'];
const NB = '\u00a0';

const byLabel = (g, label) => g.actions.find((a) => a.label === label);
const primary = (g) => g.actions.find((a) => a.primary);

// auth-error.txt 배치에서 오류 줄만 바꾼다.
function withErrorLine(line) {
  const src = read('auth-error.txt');
  const out = src.replace(/ {2}⎿[ \u00a0]+Invalid API key · Fix external API key/, `  ⎿ ${NB}${line}`);
  assert.notEqual(out, src);
  return out;
}

// 안내 문구 형식: 제목 20자 이하, 본문은 짧은 해요체, 버튼은 짧은 한국어.
function assertWording(g, where) {
  assert.ok(IDS.includes(g.id), `${where}: 모르는 id ${g.id}`);
  assert.ok([...g.title].length <= 20, `${where}: 제목이 20자를 넘어요 → ${g.title}`);
  assert.match(g.title, /[가-힣]/, `${where}: 제목에 한글이 없어요`);
  assert.match(g.title, /요$/, `${where}: 제목이 해요체가 아니에요 → ${g.title}`);
  const sentences = g.body.split(/(?<=[.?!])\s+/);
  assert.ok(sentences.length <= 3, `${where}: 본문이 3문장을 넘어요 → ${g.body}`);
  assert.ok([...g.body].length <= 120, `${where}: 본문이 120자를 넘어요(${[...g.body].length}) → ${g.body}`);
  for (const s of sentences) assert.match(s, /요[.?!]$/, `${where}: 해요체로 끝나지 않는 문장 → ${s}`);
  assert.doesNotMatch(g.body, /니다|[^요]\.$/, `${where}: 합쇼체·평서체가 섞였어요 → ${g.body}`);
  assert.ok(Array.isArray(g.actions));
  assert.ok(g.actions.filter((a) => a.primary).length <= 1, `${where}: 기본 버튼이 둘 이상이에요`);
  for (const a of g.actions) {
    assert.match(a.label, /[가-힣]/, `${where}: 버튼 이름에 한글이 없어요 → ${a.label}`);
    assert.ok([...a.label].length <= 12, `${where}: 버튼 이름이 길어요 → ${a.label}`);
    assert.equal(typeof a.keys, 'string');
    assert.match(a.keys, /^(?:(?:\x1b\[[AB])*\r|\/login\r)$/, `${where}: 예상 밖의 키 ${JSON.stringify(a.keys)}`);
  }
}

// ── 시험 자료와 캡처 기록 ──

test('실제 claude 2.1.296에서 캡처한 화면 자료가 6개 이상이고 캡처 명령이 기록돼 있다', () => {
  assert.match(manifest.claudeVersion, /^2\.1\.296\b/);
  assert.match(manifest.command, /node test\/screenGuide\.live\.js --capture/);
  const real = manifest.screens.filter((s) => s.source === 'real');
  assert.ok(real.length >= 6, `실제 캡처 ${real.length}개`);
  for (const s of real) {
    assert.ok(s.launch && s.note && Array.isArray(s.before), `${s.file}: 캡처 방법이 비었어요`);
    assert.ok(fs.existsSync(path.join(DIR, s.file)), `${s.file}이 없어요`);
  }
  // 계획서가 요구한 여섯 화면: 테마, 로그인 방법, 키 승인, 신뢰 창, 입력 대기, 요청 뒤 인증 오류
  const files = real.map((s) => s.file);
  for (const f of ['theme.txt', 'login-method.txt', 'api-key.txt', 'trust.txt', 'idle.txt', 'auth-error.txt']) assert.ok(files.includes(f), `${f}가 없어요`);
  assert.ok(manifest.screens.some((s) => s.file === 'permission-write.txt' && s.from === 'review/hook/runs/rB/caps/10-write-hook-holding-2s.txt'));
  // 캡처 자료에 실제 홈 폴더 경로가 남지 않았다
  const home = require('node:os').homedir();
  for (const s of manifest.screens) assert.ok(!read(s.file).includes(home), `${s.file}에 실제 홈 경로가 있어요`);
});

test('detectScreen이 시험 자료마다 manifest에 적힌 id를 낸다', () => {
  const seen = new Set();
  for (const s of manifest.screens) {
    const g = detectScreen(read(s.file));
    assert.equal(g ? g.id : null, s.expect, `${s.file}`);
    if (g) {
      assertWording(g, s.file);
      seen.add(g.id);
    }
  }
  for (const id of IDS) assert.ok(seen.has(id), `${id} 화면 자료가 없어요`);
});

test('입력 대기 화면과 claude가 아닌 출력 5개 이상에는 null을 낸다', () => {
  const nullFiles = manifest.screens.filter((s) => s.expect === null).map((s) => s.file);
  assert.ok(nullFiles.includes('idle.txt'));
  const others = [
    '',
    '   \n\n  ',
    '오늘 회의록을 정리했어요.\n1. 예산 확정\n2. 일정 조정\n',
    '$ git status\nOn branch main\nnothing to commit, working tree clean\n$ ',
    'FAKE_PID=123\r\nFAKE_PATH=/usr/bin:/bin\r\n\r\n * 가짜 Claude Code v0.0.0 (시험용)\r\n   /tmp/x\r\n\r\n❯ ',
    'Do you want to proceed?\nPress any key.\n',
  ];
  for (const t of others) assert.equal(detectScreen(t), null, JSON.stringify(t));
  for (const bad of [undefined, null, 42, {}, ['❯ No, exit']]) assert.equal(detectScreen(bad), null);
  assert.ok(nullFiles.length + others.length >= 5);
  for (const f of nullFiles) assert.equal(detectScreen(read(f)), null, f);
});

// ── 화면별 버튼 키 ──

test('신뢰 창: 커서가 "No, exit"에 있으면 믿어요는 ↓+Enter, 닫기는 Enter', () => {
  for (const f of ['trust.txt', 'trust-80cols.txt']) {
    const g = detectScreen(read(f));
    assert.equal(g.id, 'trust');
    assert.equal(primary(g).label, '믿어요, 시작하기');
    assert.equal(primary(g).keys, DOWN + ENTER);
    assert.equal(byLabel(g, '아니요, 닫기').keys, ENTER);
  }
});

test('신뢰 창: 커서가 이미 "Yes"에 있으면 믿어요는 Enter, 닫기는 ↑+Enter (CRLF 줄바꿈도 읽는다)', () => {
  const moved = read('trust.txt').replace(' ❯ No, exit', '   No, exit').replace('   Yes, I trust this folder', ' ❯ Yes, I trust this folder');
  const g = detectScreen(moved.replace(/\n/g, '\r\n'));
  assert.equal(g.id, 'trust');
  assert.equal(primary(g).keys, ENTER);
  assert.equal(byLabel(g, '아니요, 닫기').keys, UP + ENTER);
});

test('신뢰 창: 폴더 설정 경고가 있는 변형("No, continue without these permissions")은 닫기 대신 아니요', () => {
  const v = read('trust.txt').replace('No, exit', 'No, continue without these permissions');
  const g = detectScreen(v);
  assert.equal(g.id, 'trust');
  assert.equal(byLabel(g, '아니요').keys, ENTER);
  assert.match(g.body, /설정 없이/);
});

test('가짜 claude(T7)가 그리는 신뢰 창 모양도 알아본다', () => {
  const fake = [
    'FAKE_PID=4242', 'FAKE_PATH=/usr/bin:/bin', '', '─'.repeat(80), ' Accessing workspace:', '', ' /Users/tester/Documents/작업실', '',
    " Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what's in this folder first.",
    '', " Claude Code'll be able to read, edit, and execute files here.", '', ' Security guide', '',
    ' ❯ No, exit', '   Yes, I trust this folder', '', ' Enter to confirm · Esc to cancel', '',
  ].join('\r\n');
  const g = detectScreen(fake);
  assert.equal(g.id, 'trust');
  assert.equal(primary(g).keys, DOWN + ENTER);
});

test('테마: 기본은 Enter(이대로 계속), 밝은 화면은 커서 위치에서 계산한다', () => {
  const g = detectScreen(read('theme.txt'));
  assert.equal(g.id, 'theme');
  assert.equal(primary(g).keys, ENTER);
  assert.equal(byLabel(g, '밝은 화면').keys, DOWN + ENTER); // Dark mode(1) → Light mode(2)
  assert.equal(byLabel(g, '어두운 화면'), undefined); // 이미 어두운 화면
  assert.match(g.body, /'어두운 화면'이 골라져/);

  const moved = read('theme.txt')
    .replace(' ❯ ✔ Dark mode', '   ✔ Dark mode')
    .replace('     Light mode (colorblind-friendly)', ' ❯   Light mode (colorblind-friendly)');
  const m = detectScreen(moved);
  assert.equal(byLabel(m, '밝은 화면').keys, UP + UP + ENTER);
  assert.equal(byLabel(m, '어두운 화면').keys, UP + UP + UP + ENTER);
});

test('로그인 방법: 구독 계정은 Enter, 쓴 만큼 내는 계정은 ↓+Enter. /login으로 연 화면도 같다', () => {
  for (const f of ['login-method.txt', 'login-method-slash.txt']) {
    const g = detectScreen(read(f));
    assert.equal(g.id, 'login-method', f);
    assert.equal(primary(g).label, '구독 계정으로');
    assert.equal(primary(g).keys, ENTER);
    assert.equal(byLabel(g, '쓴 만큼 내는 계정으로').keys, DOWN + ENTER);
  }
});

test('로그인 방법: 브라우저 로그인 대기 화면은 설명만 하고 버튼은 없다', () => {
  const g = detectScreen(read('login-browser.txt'));
  assert.equal(g.id, 'login-method');
  assert.equal(g.title, '브라우저에서 로그인해요');
  assert.deepEqual(g.actions, []);
});

test('키 승인: 기본은 "쓰지 않기(권장)" Enter, "이 키 쓰기"는 ↑+Enter', () => {
  const g = detectScreen(read('api-key.txt'));
  assert.equal(g.id, 'api-key');
  assert.equal(primary(g).label, '쓰지 않기(권장)');
  assert.equal(primary(g).keys, ENTER);
  assert.equal(byLabel(g, '이 키 쓰기').keys, UP + ENTER);
});

test('주의 사항(Press Enter to continue): 계속은 Enter', () => {
  const g = detectScreen(read('press-enter.txt'));
  assert.equal(g.id, 'press-enter');
  assert.deepEqual(g.actions, [{ label: '계속', keys: ENTER, primary: true }]);
});

test('허락 창: 허락은 "1. Yes"까지, 거절은 "No"까지 커서 위치에서 계산한다', () => {
  const w = detectScreen(read('permission-write.txt'));
  assert.equal(w.id, 'permission');
  assert.match(w.body, /'a\.txt' 파일을 새로 만들어도 될지/);
  assert.equal(byLabel(w, '허락').keys, ENTER);
  assert.equal(byLabel(w, '거절').keys, DOWN + DOWN + ENTER);

  const b = detectScreen(read('permission-bash.txt'));
  assert.equal(b.id, 'permission');
  assert.match(b.body, /명령을 실행해도 될지/);
  assert.equal(byLabel(b, '허락').keys, ENTER);
  assert.equal(byLabel(b, '거절').keys, DOWN + DOWN + DOWN + ENTER);
  assert.doesNotMatch(b.body, /\/Users\//);
});

test('허락 창: 좁은 화면에서 선택지가 두 줄로 접혀도 항목 수를 맞게 센다', () => {
  const narrow = read('permission-bash.txt').replace(
    '   2. Yes, and always allow access to /Users/tester/Projects/kct-hook-ws from this project',
    '   2. Yes, and always allow access to /Users/tester/Projects/kct-hook-ws\n      from this project',
  );
  assert.notEqual(narrow, read('permission-bash.txt'));
  assert.equal(byLabel(detectScreen(narrow), '거절').keys, DOWN + DOWN + DOWN + ENTER);
});

test('인증 오류: 가짜 키(Invalid API key)는 키를 고치라고 안내하고 /login 버튼은 두지 않는다', () => {
  const g = detectScreen(read('auth-error.txt'));
  assert.equal(g.id, 'auth-error');
  assert.equal(g.title, '이용 키가 맞지 않아요');
  assert.deepEqual(g.actions, []);
});

test('인증 오류: 로그인 안 됨(오류 줄, 아래 줄 모두)은 /login 버튼을 준다', () => {
  for (const f of ['auth-logged-out.txt', 'auth-logged-out-idle.txt']) {
    const g = detectScreen(read(f));
    assert.equal(g.id, 'auth-error', f);
    assert.equal(g.title, '로그인이 필요해요');
    assert.deepEqual(g.actions, [{ label: '로그인하기', keys: `/login${ENTER}`, primary: true }]);
  }
});

test('인증 오류: 입력 칸에 쓰던 글이 있으면 /login을 덧붙여 보내지 않게 버튼을 뺀다', () => {
  const typing = read('auth-logged-out.txt').replace(/^❯[ \u00a0]$/m, '❯ 보고서 정리해');
  assert.notEqual(typing, read('auth-logged-out.txt'));
  const g = detectScreen(typing);
  assert.equal(g.id, 'auth-error');
  assert.deepEqual(g.actions, []);
});

test('인증 오류: 문서에 나온 로그인 만료 문구들을 알아본다', () => {
  for (const line of [
    'Login expired · Please run /login',
    'OAuth token revoked · Please run /login',
    'Please run /login · API Error: 401 OAuth token has expired ...',
    'Please run /login · API Error: 401 Invalid authentication credentials',
    'Not logged in · Please run /login',
  ]) {
    const g = detectScreen(withErrorLine(line));
    assert.equal(g && g.id, 'auth-error', line);
    assertWording(g, line);
    assert.equal(primary(g).keys, `/login${ENTER}`);
  }
});

test('사용 한도: 문서에 나온 문구들을 알아보고 풀리는 시각을 한국어로 바꾼다', () => {
  const cases = [
    ["You've hit your session limit · resets 3:45pm", '오후 3시 45분에 다시 쓸 수 있어요'],
    ["You've hit your weekly limit · resets Mon 12:00am", '월요일 오전 12시에 다시 쓸 수 있어요'],
    ["You've hit your Opus limit · resets 3:45pm", '오후 3시 45분'],
    ["You've hit your monthly spend limit · raise it at https://claude.ai/settings/usage?from=cc_cli_limit_message", '한도가 다시 채워지면'],
    ["You've hit your team's shared budget · ask your admin to raise it at https://claude.ai/admin-settings/usage", '한도가 다시 채워지면'],
    ["You're out of usage credits. /model to switch models.", '한도가 다시 채워지면'],
    ['Credit balance is too low', '한도가 다시 채워지면'],
  ];
  for (const [line, want] of cases) {
    const g = detectScreen(withErrorLine(line));
    assert.equal(g && g.id, 'usage-limit', line);
    assert.ok(g.body.includes(want), `${line} → ${g.body}`);
    assertWording(g, line);
  }
  const waiting = detectScreen(read('usage-limit-waiting.synthetic.txt'));
  assert.match(waiting.body, /저절로 이어서/);
});

test('사용 한도가 풀린 뒤 "Press enter to continue"는 계속 버튼을 준다', () => {
  const t = read('idle.txt').replace(/\n(─+)\n❯/, '\nYour usage limit has reset\nPress enter to continue\n$1\n❯');
  assert.notEqual(t, read('idle.txt'));
  const g = detectScreen(t);
  assert.equal(g.id, 'press-enter');
  assert.equal(g.title, '다시 쓸 수 있어요');
  assert.equal(primary(g).keys, ENTER);
});

test('지난 차례의 오류나 Claude의 답 속 인용에는 안내를 띄우지 않는다', () => {
  assert.equal(detectScreen(read('stale-auth-error.synthetic.txt')), null);
  assert.equal(detectScreen(read('assistant-quotes.synthetic.txt')), null);
  // 오류 뒤에 Claude가 새 답(⏺)을 이어서 낸 경우
  const answered = read('auth-error.txt').replace(/(⎿[ \u00a0]+Invalid API key · Fix external API key\n)/, '$1\n⏺ 다시 해 볼게요.\n');
  assert.equal(detectScreen(answered), null);
});

test('모든 안내 문구가 제목 20자 이하, 짧은 해요체다', () => {
  for (const s of manifest.screens) {
    const g = detectScreen(read(s.file));
    if (g) assertWording(g, s.file);
  }
});
