// 영어 화면 알아보기(T6).
// 터미널에 보이는 글(한 화면)을 받아, claude가 띄운 영어 화면이 무엇인지 알아보고
// 한국어 설명과 버튼을 돌려준다. 버튼의 keys는 그대로 pty에 쓰면 되는 바이트 문자열이다.
//
//   detectScreen(text) → null | { id, title, body, actions: [{ label, keys, primary? }] }
//   id: 'trust' | 'theme' | 'login-method' | 'api-key' | 'permission' | 'press-enter' | 'auth-error' | 'usage-limit'
//
// 화면 문구는 claude 2.1.296을 실제로 띄워 캡처한 것(test/fixtures/screens/)을 기준으로 맞췄다.
// 고르기 목록은 "❯"가 놓인 줄을 읽어 지금 커서 위치에서 원하는 줄까지 ↑/↓를 몇 번 누를지 계산한다.
// (신뢰 창은 맨 끝에서 ↓를 누르면 맨 위로 돌아가므로, 커서 위치를 모르고 ↓를 보내면 엉뚱한 줄이 골라진다.)
// 오류 문구의 근거: https://code.claude.com/docs/en/errors (Usage limits, Authentication errors 절)
'use strict';

const KEY = Object.freeze({ ENTER: '\r', UP: '\x1b[A', DOWN: '\x1b[B' });

const RULE = /^\s*─{8,}\s*$/; // 입력 칸 위아래, 대화 상자 위의 가로줄
const CURSOR_LINE = /^( +)❯ +(\S.*)$/; // 고르기 목록의 커서 줄. 입력 칸(❯가 맨 앞)과 구분하려고 앞 칸을 요구한다
const NUMBERED = /^\d+\.\s/;
const USER_ECHO = /^❯\s*\S/; // 대화 기록에 남은 사용자 입력 줄
const ASSISTANT = /^⏺/;
const RESULT_LINE = /^\s*⎿\s+(.*)$/;

// ── 화면 글 다듬기 ──

function toLines(text) {
  const lines = String(text)
    .split(/\r?\n/)
    .map((l) => l.replace(/\u00a0/g, ' ').replace(/\s+$/, ''));
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

const has = (lines, re) => lines.some((l) => re.test(l));

// 입력 칸(가로줄 / ❯ … / 가로줄)의 ❯ 줄 위치. 없으면 -1.
function findInputBox(lines) {
  for (let i = lines.length - 1; i > 0; i--) {
    if (!/^❯(\s|$)/.test(lines[i]) || !RULE.test(lines[i - 1])) continue;
    for (let j = i + 1; j < Math.min(lines.length, i + 15); j++) {
      if (RULE.test(lines[j])) return i;
    }
  }
  return -1;
}

// ── 고르기 목록 읽기 ──

function cleanLabel(s) {
  return s.replace(NUMBERED, '').replace(/^✔\s*/, '').replace(/\s*✔$/, '').trim();
}

// 아래에서부터 커서 줄을 찾고, 같은 들여쓰기로 이어지는 줄들을 항목으로 묶는다.
// 번호 목록이면 번호가 붙은 줄만 항목이고, 더 깊이 들여쓴 줄은 앞 항목이 접혀 내려온 것이다.
function parseOptions(lines) {
  let c = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (CURSOR_LINE.test(lines[i])) { c = i; break; }
  }
  if (c < 0) return null;
  const m = CURSOR_LINE.exec(lines[c]);
  const textCol = m[1].length + 2; // "❯ " 뒤 글자가 시작하는 칸
  const numbered = NUMBERED.test(m[2]);
  const kind = (line) => {
    if (line === '' || CURSOR_LINE.test(line)) return null;
    const indent = line.length - line.trimStart().length;
    if (indent < textCol) return null;
    if (numbered && !NUMBERED.test(line.trimStart())) return 'more';
    return 'item';
  };
  let start = c;
  while (start > 0 && kind(lines[start - 1])) start--;
  let end = c;
  while (end + 1 < lines.length && kind(lines[end + 1])) end++;
  const options = [];
  let cursor = -1;
  for (let i = start; i <= end; i++) {
    if (i === c) {
      cursor = options.length;
      options.push(cleanLabel(m[2]));
    } else if (kind(lines[i]) === 'item') {
      options.push(cleanLabel(lines[i].trimStart()));
    } else if (options.length) {
      options[options.length - 1] += ` ${lines[i].trim()}`;
    }
  }
  return { options, cursor };
}

// 커서에서 matcher에 맞는 항목까지 옮기고 Enter. 못 찾으면 null.
function keysFor(sel, matcher) {
  if (!sel) return null;
  const t = sel.options.findIndex((o) => matcher.test(o));
  if (t < 0) return null;
  const d = t - sel.cursor;
  return (d > 0 ? KEY.DOWN.repeat(d) : KEY.UP.repeat(-d)) + KEY.ENTER;
}

// keys를 못 구한 버튼은 뺀다(잘못된 키를 보내느니 버튼을 안 보인다).
function guide(id, title, body, actions) {
  return { id, title, body, actions: actions.filter((a) => typeof a.keys === 'string') };
}

// ── 대화 상자 ──

function trust(lines) {
  if (!has(lines, /Yes, I trust this folder/)) return null;
  const sel = parseOptions(lines);
  const noLabel = sel && sel.options.find((o) => /^No\b/.test(o));
  const exits = !noLabel || /exit/i.test(noLabel);
  return guide('trust', '폴더를 믿어도 될지 물어요',
    'Claude가 이 폴더의 파일을 읽고 고치고 실행해도 되는지 묻는 화면이에요. '
      + (exits ? "'믿어요'를 누르면 시작하고, '아니요'를 누르면 Claude가 꺼져요."
        : "'믿어요'를 누르면 폴더 설정까지 써서 시작하고, '아니요'를 누르면 그 설정 없이 시작해요."),
    [
      { label: '믿어요, 시작하기', keys: keysFor(sel, /trust this folder/i), primary: true },
      { label: exits ? '아니요, 닫기' : '아니요', keys: keysFor(sel, /^No\b/) },
    ]);
}

function apiKey(lines) {
  if (!has(lines, /Do you want to use this API key\?|Detected a custom API key/)) return null;
  const sel = parseOptions(lines);
  return guide('api-key', '저장된 키를 쓸지 물어요',
    "이 컴퓨터에 Claude 이용 키(API 키)가 설정돼 있어서, 이 키로 쓸지 묻는 화면이에요. 잘 모르면 '쓰지 않기'를 누르고 로그인하세요.",
    [
      { label: '쓰지 않기(권장)', keys: keysFor(sel, /^No\b/), primary: true },
      { label: '이 키 쓰기', keys: keysFor(sel, /^Yes\b/) },
    ]);
}

function loginMethod(lines) {
  if (has(lines, /Select login method:/)) {
    const sel = parseOptions(lines);
    return guide('login-method', '로그인 방법을 골라요',
      "Claude를 쓰려면 로그인해야 해요. Pro·Max 같은 Claude 구독이 있으면 '구독 계정으로'를 누르세요. 브라우저가 열리면 거기서 로그인해요.",
      [
        { label: '구독 계정으로', keys: keysFor(sel, /^Claude account with subscription/), primary: true },
        { label: '쓴 만큼 내는 계정으로', keys: keysFor(sel, /^Anthropic Console account/) },
      ]);
  }
  if (has(lines, /How do you want to sign in\?/)) {
    const sel = parseOptions(lines);
    return guide('login-method', '로그인 방식을 골라요',
      "쓴 만큼 내는 계정(Console)으로 로그인하는 방식을 고르는 화면이에요. 잘 모르면 '권장 방식으로'를 누르세요.",
      [
        { label: '권장 방식으로', keys: keysFor(sel, /recommended/i), primary: true },
        { label: '뒤로 가기', keys: keysFor(sel, /^Go back/i) },
      ]);
  }
  if (has(lines, /Browser didn't open\?|Paste code here if prompted|Opening browser to sign in/)) {
    return guide('login-method', '브라우저에서 로그인해요',
      '열린 브라우저 창에서 로그인을 마치면 저절로 넘어가요. 브라우저가 코드를 보여 주면 복사해서 터미널에 붙여 넣고 Enter를 누르세요.',
      []);
  }
  return null;
}

const THEME_KO = [
  [/^Dark mode$/, '어두운 화면'],
  [/^Light mode$/, '밝은 화면'],
  [/^Auto/, '터미널에 맞춤'],
  [/colorblind/i, '색약용 화면'],
  [/ANSI/, '기본 색만 쓰는 화면'],
];

function theme(lines) {
  if (!has(lines, /Choose the text style/)) return null;
  const sel = parseOptions(lines);
  const current = sel && sel.cursor >= 0 ? sel.options[sel.cursor] : '';
  const currentKo = (THEME_KO.find(([re]) => re.test(current)) || [])[1];
  const actions = [{ label: '이대로 계속', keys: KEY.ENTER, primary: true }];
  if (!/^Light mode$/.test(current)) actions.push({ label: '밝은 화면', keys: keysFor(sel, /^Light mode$/) });
  if (!/^Dark mode$/.test(current)) actions.push({ label: '어두운 화면', keys: keysFor(sel, /^Dark mode$/) });
  return guide('theme', '화면 색을 골라요',
    `글자와 바탕 색을 고르는 화면이에요. ${currentKo ? `지금은 '${currentKo}'이 골라져 있어요. ` : ''}나중에 바꿀 수도 있으니 잘 모르면 '이대로 계속'을 누르세요.`,
    actions);
}

const baseName = (p) => p.replace(/^["'`]|["'`]$/g, '').split(/[\\/]/).filter(Boolean).pop() || p;

function permission(lines) {
  let q = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s*Do you want to .+\?$/.test(lines[i])) { q = i; break; }
  }
  if (q < 0) return null;
  const sel = parseOptions(lines.slice(q));
  if (!sel || !sel.options.some((o) => /^Yes\b/.test(o)) || !sel.options.some((o) => /^No\b/.test(o))) return null;
  const ask = /Do you want to (.+)\?$/.exec(lines[q])[1].trim();
  // 대화 상자 맨 위 제목 줄(예: "Bash command", "Create file")
  let header = '';
  for (let i = q - 1; i > 0; i--) {
    if (RULE.test(lines[i - 1])) { header = lines[i].trim(); break; }
  }
  let what;
  let m;
  if ((m = /^create (.+)$/i.exec(ask))) what = `'${baseName(m[1])}' 파일을 새로 만들어도 될지`;
  else if ((m = /^make this edit to (.+)$/i.exec(ask))) what = `'${baseName(m[1])}' 파일을 고쳐도 될지`;
  else if ((m = /^overwrite (.+)$/i.exec(ask))) what = `'${baseName(m[1])}' 파일을 덮어써도 될지`;
  else if (/^Bash|^PowerShell/i.test(header)) what = '명령을 실행해도 될지';
  else if (/^Fetch/i.test(header)) what = '인터넷 주소를 열어도 될지';
  else what = '이 일을 해도 될지';
  return guide('permission', '허락을 기다리고 있어요',
    `Claude가 ${what} 묻고 있어요. '허락'을 누르면 진행하고, '거절'을 누르면 멈춰요.`,
    [
      { label: '허락', keys: keysFor(sel, /^Yes$/), primary: true },
      { label: '거절', keys: keysFor(sel, /^No\b/) },
    ]);
}

function pressEnter(lines) {
  if (!has(lines, /Press Enter to continue/i)) return null;
  const go = [{ label: '계속', keys: KEY.ENTER, primary: true }];
  if (has(lines, /Security notes:/)) {
    return guide('press-enter', '주의할 점을 알려 줘요',
      "Claude도 실수할 수 있으니 한 일을 꼭 확인하고, 믿을 수 있는 파일에서만 쓰라는 안내예요. 다 읽었으면 '계속'을 누르세요.", go);
  }
  if (has(lines, /Login successful/)) {
    return guide('press-enter', '로그인됐어요', "로그인이 끝났어요. '계속'을 누르면 다음으로 넘어가요.", go);
  }
  if (has(lines, /usage limit has reset/i)) {
    return guide('press-enter', '다시 쓸 수 있어요', "사용 한도가 다시 채워졌어요. '계속'을 누르면 하던 일을 이어서 해요.", go);
  }
  return guide('press-enter', '읽고 넘어가는 화면이에요', "화면의 안내를 다 읽었으면 '계속'을 눌러 넘어가요.", go);
}

const DIALOGS = [trust, apiKey, loginMethod, theme, permission, pressEnter];

// ── 대화 기록에 남은 오류 ──

const AUTH = [
  [/^Invalid API key\b/, 'bad-key'],
  [/^Not logged in\b/, 'logged-out'],
  [/^Login expired\b/, 'expired'],
  [/^OAuth token (revoked|has expired)/, 'expired'],
  [/^Failed to authenticate\b/, 'expired'],
  [/Please run \/login/, 'expired'],
];
const LIMIT = /You've hit your .*(limit|budget)|You've reached your .*limit|You're out of usage credits|Usage limit reached|Credit balance is too low/;
// 기다리는 동안 아래쪽에 뜨는 줄(⎿ 없이 나온다)
const LIMIT_STATUS = /Usage limit reached · (limit resets|continuing automatically)|Continuing automatically at .+ · esc to cancel/;

const DAYS = { mon: '월요일', tue: '화요일', wed: '수요일', thu: '목요일', fri: '금요일', sat: '토요일', sun: '일요일' };

// "resets 3:45pm", "resets Mon 12:00am" → "오후 3시 45분", "월요일 오전 12시"
function resetTimeKo(text) {
  const m = /resets\s+(?:at\s+)?(?:(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\w*\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.exec(text);
  if (!m) return null;
  const h = Number(m[2]) % 12 || 12;
  const min = m[3] && m[3] !== '00' ? ` ${Number(m[3])}분` : '';
  const day = m[1] ? `${DAYS[m[1].slice(0, 3).toLowerCase()]} ` : '';
  return `${day}${m[4].toLowerCase() === 'am' ? '오전' : '오후'} ${h}시${min}`;
}

function promptIsEmpty(lines, box) {
  const t = lines[box].replace(/^❯\s*/, '');
  return t === '' || /^Try "/.test(t); // 빈 입력 칸에는 흐린 예시 문장이 보인다
}

function messages(lines) {
  const box = findInputBox(lines);
  const turnEnd = box >= 0 ? box - 1 : lines.length;
  let turnStart = 0;
  for (let i = turnEnd - 1; i >= 0; i--) {
    if (USER_ECHO.test(lines[i])) { turnStart = i + 1; break; }
  }
  // 가장 최근 대화 차례에서, 뒤에 Claude의 새 출력(⏺)이 없는 마지막 오류 줄을 찾는다.
  let found = null;
  for (let i = turnStart; i < turnEnd; i++) {
    const r = RESULT_LINE.exec(lines[i]);
    const content = r ? r[1] : null;
    if (content && LIMIT.test(content)) found = { kind: 'limit' };
    else if (!r && LIMIT_STATUS.test(lines[i])) found = { kind: 'limit' };
    else if (content) {
      const a = AUTH.find(([re]) => re.test(content));
      if (a) found = { kind: 'auth', sub: a[1] };
    } else if (ASSISTANT.test(lines[i])) found = null;
  }
  // 입력 칸 아래 줄: "Not logged in · Run /login", 한도가 풀리기를 기다리는 줄
  const below = box >= 0 ? lines.slice(box + 1) : [];
  if (!found && has(below, /Not logged in · (Please )?[Rr]un \/login/)) found = { kind: 'auth', sub: 'logged-out' };
  if (!found && has(below, LIMIT_STATUS)) found = { kind: 'limit' };
  if (!found) return null;

  if (found.kind === 'limit') {
    const all = lines.slice(turnStart).join('\n');
    const when = resetTimeKo(all);
    const auto = /continuing automatically/i.test(all);
    return guide('usage-limit', '사용 한도에 닿았어요',
      '지금 계정으로 쓸 수 있는 사용량을 다 썼어요. '
        + (when ? `${when}에 다시 쓸 수 있어요.` : '한도가 다시 채워지면 쓸 수 있어요.')
        + (auto ? ' 그때 하던 일을 저절로 이어서 해요.' : ''),
      []);
  }
  const login = box >= 0 && promptIsEmpty(lines, box) ? [{ label: '로그인하기', keys: `/login${KEY.ENTER}`, primary: true }] : [];
  if (found.sub === 'bad-key') {
    return guide('auth-error', '이용 키가 맞지 않아요',
      '컴퓨터에 설정된 Claude 이용 키(API 키)가 맞지 않아서 답을 받지 못했어요. 키를 고치거나 지운 뒤 앱을 다시 켜 주세요.',
      []);
  }
  if (found.sub === 'logged-out') {
    return guide('auth-error', '로그인이 필요해요',
      "아직 로그인하지 않아서 Claude가 답할 수 없어요. '로그인하기'를 누르고 안내를 따라 주세요.", login);
  }
  return guide('auth-error', '다시 로그인해 주세요',
    "로그인이 풀려서 Claude가 답하지 못했어요. '로그인하기'를 눌러 다시 로그인해 주세요.", login);
}

function detectScreen(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const lines = toLines(text);
  if (findInputBox(lines) < 0) {
    for (const d of DIALOGS) {
      const g = d(lines);
      if (g) return g;
    }
  } else if (has(lines, /usage limit has reset/i) && has(lines, /Press Enter to continue/i)) {
    return pressEnter(lines);
  }
  return messages(lines);
}

module.exports = { detectScreen };
