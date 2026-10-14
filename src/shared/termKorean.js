// 터미널에 그려진 claude 영어 줄을 알아보고, 같은 자리에 겹쳐 그릴 한국어 덮개를 만든다(T10).
//
//   translateScreen(lines, { cursorRow, cols }) → Overlay[]
//     lines   화면에 보이는 줄의 글자(xterm translateToString(true)). 0번이 맨 위 줄.
//     Overlay = { row, col, rows, width, text, kind }
//       row부터 rows줄, col부터 width칸을 덮는다. text는 한국어이고 여러 줄이면 \n으로 나눈다.
//       kind: 'header' | 'banner' | 'dialog' | 'option' | 'hint' | 'footer' | 'permission' | 'status'
//   RULES: [{ id, kind, sample, evidence }]
//     sample    이 규칙이 덮는 화면 예(이 글을 translateScreen에 넣으면 이 규칙의 덮개가 나온다)
//     evidence  claude 2.1.299 바이너리에서 찾은 문구, 또는 실제 캡처 파일 경로(test/…, review/…)
//
// 지키는 것(PLAN.md "공통 약속 (3판)")
// - 순수 함수다. DOM·Node API를 쓰지 않는다. Node(require)와 renderer(<script>, window.KctTermKorean) 양쪽에서 쓴다.
// - 커서 줄은 덮지 않는다. 덮개끼리 겹치지 않는다. col + width ≤ cols, row + rows ≤ lines.length.
// - text의 각 줄은 표시 폭(한글 2칸)이 width 이하이고 줄 수는 rows 이하다.
// - 고르기 줄은 앞의 ❯ 표시와 번호(1. 2. …), 고른 표시(✔)를 그대로 두고 글만 덮는다.
// - 아는 문구만 덮는다. 모르는 줄, 사용자가 친 글, Claude의 답, 파일 내용·명령 출력, 도구 실행 줄은 그대로 둔다.
//   claude가 바뀌어 문구가 달라지면 그 줄만 영어로 돌아간다.
//
// 어디서 무엇을 찾는지
// - 입력 칸(가로줄 / ❯ 또는 ! … / 가로줄)이 있으면 그 아래 줄(과 바로 위 생각 깊이 줄)만 '아래 모드 줄'로 읽는다.
// - 입력 칸이 없으면 마지막 가로줄(─) 아래를 대화 상자로 읽는다(가로줄이 없으면 화면 전체).
//   그 안에 대화 기록 줄(⏺ 답, 맨 앞 ❯ 사용자 글, ⎿ 도구 결과)이 있으면 위로 올려 본 기록이므로 대화 상자로 읽지 않는다.
//   신뢰 창·MCP 창·테마·로그인·허락 창의 문단, 고르기 목록, 아래 안내 줄은 대화 상자 안에서만 덮는다.
// - 머리말(버전·모델 줄), 시작 안내 줄(⚠ ⏺ ▎로 시작), 오류·상태 줄(⎿ 뒤)은 입력 칸·아래 줄을 뺀 어디서나 찾는다.
// - 문단이 화면 폭 때문에 여러 줄로 접혀 있으면 같은 들여쓰기의 다음 줄을 이어 붙여 통째로 맞춰 본다.
//   그래서 80칸·120칸 어느 폭에서도 같은 규칙이 맞는다.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else root.KctTermKorean = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ── 글자 폭: xterm.js UnicodeV6(기본값)과 같은 표 ──
  // 근거: node_modules/@xterm/xterm/lib/xterm.js 의 UnicodeV6.wcwidth. 이모지는 1칸, 한글·한자는 2칸, 결합 문자는 0칸.

  const ZERO_BMP = [[768, 879], [1155, 1158], [1160, 1161], [1425, 1469], [1471, 1471], [1473, 1474], [1476, 1477], [1479, 1479],
    [1536, 1539], [1552, 1557], [1611, 1630], [1648, 1648], [1750, 1764], [1767, 1768], [1770, 1773], [1807, 1807], [1809, 1809],
    [1840, 1866], [1958, 1968], [2027, 2035], [2305, 2306], [2364, 2364], [2369, 2376], [2381, 2381], [2385, 2388], [2402, 2403],
    [2433, 2433], [2492, 2492], [2497, 2500], [2509, 2509], [2530, 2531], [2561, 2562], [2620, 2620], [2625, 2626], [2631, 2632],
    [2635, 2637], [2672, 2673], [2689, 2690], [2748, 2748], [2753, 2757], [2759, 2760], [2765, 2765], [2786, 2787], [2817, 2817],
    [2876, 2876], [2879, 2879], [2881, 2883], [2893, 2893], [2902, 2902], [2946, 2946], [3008, 3008], [3021, 3021], [3134, 3136],
    [3142, 3144], [3146, 3149], [3157, 3158], [3260, 3260], [3263, 3263], [3270, 3270], [3276, 3277], [3298, 3299], [3393, 3395],
    [3405, 3405], [3530, 3530], [3538, 3540], [3542, 3542], [3633, 3633], [3636, 3642], [3655, 3662], [3761, 3761], [3764, 3769],
    [3771, 3772], [3784, 3789], [3864, 3865], [3893, 3893], [3895, 3895], [3897, 3897], [3953, 3966], [3968, 3972], [3974, 3975],
    [3984, 3991], [3993, 4028], [4038, 4038], [4141, 4144], [4146, 4146], [4150, 4151], [4153, 4153], [4184, 4185], [4448, 4607],
    [4959, 4959], [5906, 5908], [5938, 5940], [5970, 5971], [6002, 6003], [6068, 6069], [6071, 6077], [6086, 6086], [6089, 6099],
    [6109, 6109], [6155, 6157], [6313, 6313], [6432, 6434], [6439, 6440], [6450, 6450], [6457, 6459], [6679, 6680], [6912, 6915],
    [6964, 6964], [6966, 6970], [6972, 6972], [6978, 6978], [7019, 7027], [7616, 7626], [7678, 7679], [8203, 8207], [8234, 8238],
    [8288, 8291], [8298, 8303], [8400, 8431], [12330, 12335], [12441, 12442], [43014, 43014], [43019, 43019], [43045, 43046],
    [64286, 64286], [65024, 65039], [65056, 65059], [65279, 65279], [65529, 65531]];
  const ZERO_ASTRAL = [[68097, 68099], [68101, 68102], [68108, 68111], [68152, 68154], [68159, 68159], [119143, 119145],
    [119155, 119170], [119173, 119179], [119210, 119213], [119362, 119364], [917505, 917505], [917536, 917631], [917760, 917999]];

  let bmp = null;
  function buildTable() {
    bmp = new Uint8Array(65536);
    bmp.fill(1);
    bmp[0] = 0;
    bmp.fill(0, 1, 32);
    bmp.fill(0, 127, 160);
    bmp.fill(2, 4352, 4448);
    bmp[9001] = 2;
    bmp[9002] = 2;
    bmp.fill(2, 11904, 42192);
    bmp[12351] = 1;
    bmp.fill(2, 44032, 55204);
    bmp.fill(2, 63744, 64256);
    bmp.fill(2, 65040, 65050);
    bmp.fill(2, 65072, 65136);
    bmp.fill(2, 65280, 65377);
    bmp.fill(2, 65504, 65511);
    for (const [a, b] of ZERO_BMP) bmp.fill(0, a, b + 1);
  }

  function charWidth(cp) {
    if (cp < 32) return 0;
    if (cp < 127) return 1;
    if (cp < 65536) {
      if (!bmp) buildTable();
      return bmp[cp];
    }
    for (const [a, b] of ZERO_ASTRAL) if (cp >= a && cp <= b) return 0;
    return (cp >= 131072 && cp <= 196605) || (cp >= 196608 && cp <= 262141) ? 2 : 1;
  }

  // 화면에서 차지하는 칸 수(한글 2칸)
  function displayWidth(s) {
    let w = 0;
    for (const ch of String(s)) w += charWidth(ch.codePointAt(0));
    return w;
  }

  // ── 글 맞추기 ──

  function breakChars(word, width) {
    const out = [];
    let cur = '';
    let w = 0;
    for (const ch of word) {
      const cw = charWidth(ch.codePointAt(0));
      if (w + cw > width && cur) {
        out.push(cur);
        cur = '';
        w = 0;
      }
      cur += ch;
      w += cw;
    }
    out.push(cur);
    return out;
  }

  // 띄어쓰기에서 줄을 바꾼다. 한 낱말이 폭보다 길면 그 낱말만 글자 단위로 자른다.
  function wrapWords(text, width) {
    const out = [];
    for (const para of text.split('\n')) {
      let cur = '';
      let cw = 0;
      for (const word of para.split(' ')) {
        if (word === '') continue;
        const ww = displayWidth(word);
        if (cur && cw + 1 + ww <= width) {
          cur += ` ${word}`;
          cw += 1 + ww;
          continue;
        }
        if (cur) out.push(cur);
        if (ww <= width) {
          cur = word;
          cw = ww;
        } else {
          const pieces = breakChars(word, width);
          out.push(...pieces.slice(0, -1));
          cur = pieces[pieces.length - 1];
          cw = displayWidth(cur);
        }
      }
      out.push(cur);
    }
    return out;
  }

  // 글자 단위로 꽉 채워 자른다(띄어쓰기로는 줄 수가 모자랄 때).
  function wrapChars(text, width) {
    const out = [];
    for (const para of text.split('\n')) {
      const lines = breakChars(para, width).map((l) => l.replace(/^ +/, ''));
      out.push(...lines);
    }
    return out;
  }

  function ellipsize(s, width) {
    if (displayWidth(s) <= width) return s;
    let out = '';
    let w = 0;
    for (const ch of s) {
      const cw = charWidth(ch.codePointAt(0));
      if (w + cw + 1 > width) break;
      out += ch;
      w += cw;
    }
    return `${out}…`;
  }

  // width 칸, rows 줄 안에 넣는다. 넘치면 마지막 줄을 …로 줄이고 truncated를 표시한다.
  function fitText(text, width, rows) {
    if (width <= 0 || rows <= 0) return { lines: [], truncated: true };
    let lines = wrapWords(text, width);
    if (lines.length <= rows) return { lines, truncated: false };
    lines = wrapChars(text, width);
    if (lines.length <= rows) return { lines, truncated: false };
    lines = lines.slice(0, rows);
    lines[rows - 1] = ellipsize(`${lines[rows - 1]}…`, width);
    return { lines, truncated: true };
  }

  // ── 쉬운 말로 풀기 ──

  const EFFORT_KO = { low: '가볍게', medium: '보통', high: '깊게', xhigh: '아주 깊게', max: '최대' };
  const PROVIDERS = ['Amazon Bedrock', 'Google Vertex AI', 'Microsoft Foundry', 'Claude Platform on AWS'];

  // 머리말의 요금 방식. "Claude Team" → "Team 요금제", "API Usage Billing" → "쓴 만큼 내는 요금"
  function billingKo(b) {
    if (b === 'API Usage Billing') return { text: '쓴 만큼 내는 요금', vars: [] };
    if (PROVIDERS.includes(b)) return { text: `${b} 이용`, vars: [b] };
    const m = /^Claude (.+)$/.exec(b);
    if (m) return { text: `${m[1]} 요금제`, vars: [m[1]] };
    return null;
  }

  const DAYS_KO = { mon: '월요일', tue: '화요일', wed: '수요일', thu: '목요일', fri: '금요일', sat: '토요일', sun: '일요일' };

  // "3:45pm" → "오후 3시 45분", "Mon 12am" → "월요일 오전 12시". 모르는 모양이면 그대로 둔다.
  function timeKo(s) {
    const m = /^(?:at\s+)?(?:(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\w*\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)(?:\s+\([^)]*\))?$/i.exec(s.trim());
    if (!m) return { text: s, vars: [s] };
    const h = Number(m[2]) % 12 || 12;
    const min = m[3] && m[3] !== '00' ? ` ${Number(m[3])}분` : '';
    const day = m[1] ? `${DAYS_KO[m[1].slice(0, 3).toLowerCase()]} ` : '';
    return { text: `${day}${m[4].toLowerCase() === 'am' ? '오전' : '오후'} ${h}시${min}`, vars: [] };
  }

  const LIMIT_KO = { session: '이번 사용', weekly: '이번 주 사용', daily: '오늘 사용', monthly: '이번 달 사용', '5-hour': '5시간 사용' };

  const REMOTE_REASON_KO = [
    [/^authentication rejected \((\d+)\)$/, (m) => `인증 거절 ${m[1]}`],
    [/^access denied \((\d+)\)$/, (m) => `접근 거부 ${m[1]}`],
    [/^request timed out$/, () => '시간 초과'],
    [/^network error$/, () => '네트워크 오류'],
    [/^no credentials available$/, () => '로그인 정보 없음'],
    [/^server error(?: \((\d+)\))?$/, (m) => `서버 오류${m[1] ? ` ${m[1]}` : ''}`],
    [/^client error(?: \((\d+)\))?$/, (m) => `요청 오류${m[1] ? ` ${m[1]}` : ''}`],
  ];

  // ── 규칙 ──
  // where
  //   'dialog'  대화 상자 안의 문단·줄(여러 줄로 접힐 수 있음)
  //   'title'   대화 상자 맨 위 제목 줄(가로줄 바로 아래 첫 줄)
  //   'option'  고르기 목록의 항목 글(❯·번호·✔ 뒤)
  //   'hint'    대화 상자 아래 안내 줄의 조각(" · "로 나뉜 조각이 모두 아는 것일 때만 덮는다)
  //   'banner'  ⚠ ⏺ ▎로 시작하는 시작 안내 줄(prefix를 남기고 덮는다)
  //   'status'  ⎿ 뒤의 오류·상태 줄, 또는 그 자체로 한 줄인 상태 줄
  //   'footer'  입력 칸 아래 모드 줄의 조각
  //   'header'  머리말(버전·모델·요금 줄)
  // re: 줄(또는 이어 붙인 문단) 전체와 맞아야 한다. 이름 붙은 묶음 c가 있으면 그 부분만 덮는다.
  // ko: 한국어 글. 함수면 (m) → string 또는 { text, vars }. vars는 화면에서 넘겨받아 그대로 쓴 이름(파일·서버·조직 등).

  const LINE = '─'.repeat(60);
  const dlg = (...rows) => ['', LINE, ...rows].join('\n');
  const idle = (above, footer) => [...above, '', LINE, '❯ ', LINE, footer].join('\n');
  const FOOT = '  ⏸ manual mode on · ? for shortcuts · ← for agents';
  const CAP = 'test/fixtures/term/v2.1.299';

  const DEFS = [];
  const def = (d) => { DEFS.push(d); return d; };

  // 시작 머리말
  def({ id: 'header-version', kind: 'header', where: 'header', re: /^Claude Code v(\d+\.\d+\.\d+\S*)$/,
    ko: (m) => `Claude Code 버전 ${m[1]}`,
    sample: ' ▐▛███▛█   Claude Code v2.1.299\n▝▜██████▀  Opus 5.5 · API Usage Billing\n ▝▝   ▝▝   ~/Documents/작업실',
    evidence: 'Claude Code v' });
  def({ id: 'header-welcome', kind: 'header', where: 'header', re: /^Welcome to Claude Code v(\d+\.\d+\.\d+\S*)$/,
    ko: (m) => `Claude Code에 오신 걸 환영해요 · 버전 ${m[1]}`,
    sample: 'Welcome to Claude Code v2.1.299\n' + '.'.repeat(58), evidence: 'Welcome to Claude Code' });
  def({ id: 'header-model', kind: 'header', where: 'header', re: null,
    sample: ' Claude Code v2.1.299\n  Opus 5.5 (1M context) with xhigh effort · Claude Team\n  ~/Documents/작업실',
    evidence: 'test/fixtures/term/user/03-header-team.txt' });
  def({ id: 'header-billing', kind: 'header', where: 'header', re: null,
    sample: ' ▐▛███▛█   Claude Code v2.1.299\n▝▜██████▀  Opus 5.5 (1M context) with xhigh effort\n ▝▝   ▝▝   Claude Team',
    evidence: 'API Usage Billing' });

  // 시작 안내 줄
  def({ id: 'banner-login-expires', kind: 'banner', where: 'banner', prefix: '⚠', maxRows: 2,
    re: /^Your login expires in (\d+) days? · run \/login to renew$/,
    ko: (m) => `로그인이 ${m[1]}일 뒤 끝나요 · /login으로 다시 로그인하세요`,
    sample: '⚠ Your login expires in 3 days · run /login to renew', evidence: 'Your login expires in ' });
  def({ id: 'banner-message-from', kind: 'banner', where: 'banner', prefix: '▎', maxRows: 2,
    re: /^Message from (.+):$/, ko: (m) => ({ text: `${m[1]}에서 온 안내:`, vars: [m[1]] }),
    sample: '▎ Message from Acme:\n▎ 안녕하세요!', evidence: 'Message from ' });
  def({ id: 'banner-remote-control-disabled', kind: 'banner', where: 'banner', prefix: '⏺', maxRows: 4,
    re: /^Remote Control is disabled by your organization's policy\. Contact your organization admin for access\.$/,
    ko: '원격 조종 기능은 조직 정책으로 꺼져 있어요. 쓰려면 조직 관리자에게 물어보세요.',
    sample: "⏺ Remote Control is disabled by your organization's policy. Contact your organization admin for access.",
    evidence: "Remote Control is disabled by your organization's policy. Contact your organization admin for access." });
  def({ id: 'banner-remote-control-off', kind: 'banner', where: 'banner', prefix: '⏺', maxRows: 2,
    re: /^Remote Control was turned off by your organization's policy\.$/,
    ko: '조직 정책으로 원격 조종 기능이 꺼졌어요.',
    sample: "⏺ Remote Control was turned off by your organization's policy.",
    evidence: "Remote Control was turned off by your organization's policy." });
  def({ id: 'banner-remote-settings-failed', kind: 'banner', where: 'banner', prefix: '⚠', maxRows: 4,
    re: /^Remote managed settings failed to load \((.+)\) · (no remote policy applied|using cached policy(?: \(proxy\/CA\/provider env withheld\))?) · \/status for details$/,
    ko: (m) => {
      const r = REMOTE_REASON_KO.find(([re]) => re.test(m[1]));
      const reason = r ? r[1](r[0].exec(m[1])) : m[1];
      const tail = m[2] === 'no remote policy applied' ? '원격 정책 없이 시작해요'
        : /withheld/.test(m[2]) ? '전에 받아 둔 정책을 써요(일부 연결 설정은 빼고)' : '전에 받아 둔 정책을 써요';
      return { text: `조직이 관리하는 원격 설정을 불러오지 못했어요(${reason}) · ${tail} · 자세히 보려면 /status`, vars: r ? [] : [m[1]] };
    },
    sample: '⚠ Remote managed settings failed to load (authentication rejected (401)) · no remote policy applied · /status for\n  details',
    evidence: 'Remote managed settings failed to load (' });
  def({ id: 'banner-auto-default-title', kind: 'banner', where: 'banner', prefix: '▎',
    re: /^Auto mode is now Claude Code's default permission mode\.$/,
    ko: '이제 자동 모드가 Claude Code의 기본 허락 방식이에요.',
    sample: "▎ Auto mode is now Claude Code's default permission mode.",
    evidence: "Auto mode is now Claude Code's default permission mode." });
  def({ id: 'banner-auto-default-desc', kind: 'banner', where: 'banner', prefix: '▎', maxRows: 5,
    re: /^Auto mode lets Claude handle permission prompts automatically\. Claude checks each tool call for risky actions and prompt injection before executing, runs the ones it assesses as lower-risk, and blocks the rest\.$/,
    ko: '자동 모드에서는 Claude가 허락 질문을 알아서 처리해요. 실행하기 전에 도구를 쓸 때마다 위험한 동작이나 숨은 지시(프롬프트 주입)가 있는지 살펴서, 덜 위험하다고 본 것은 실행하고 나머지는 막아요.',
    sample: '▎ Auto mode lets Claude handle permission prompts automatically. Claude checks each tool call for risky actions and\n▎ prompt injection before executing, runs the ones it assesses as lower-risk, and blocks the rest.',
    evidence: 'Auto mode lets Claude handle permission prompts automatically. Claude checks each tool call' });
  def({ id: 'banner-auto-mode-desc', kind: 'banner', where: 'banner', prefix: '⏺', maxRows: 14,
    re: /^Auto mode lets Claude handle permission prompts automatically — Claude checks each tool call for risky actions and prompt injection before executing\. Actions Claude identifies as safe are executed, while actions Claude identifies as risky are blocked and Claude may try a different approach\. Ideal for long-running tasks\.( Sessions are slightly more expensive\.)? Claude can make mistakes that allow harmful commands to run, it's recommended to only use in isolated environments\. Shift\+Tab to change mode\.$/,
    ko: (m) => '자동 모드에서는 Claude가 허락 질문을 알아서 처리해요. 실행하기 전에 도구를 쓸 때마다 위험한 동작이나 숨은 지시(프롬프트 주입)가 있는지 살펴요. '
      + '안전하다고 본 것은 실행하고, 위험하다고 본 것은 막은 뒤 다른 방법을 찾을 수 있어요. 오래 걸리는 일에 알맞아요. '
      + (m[1] ? '사용량이 조금 더 들어요. ' : '')
      + 'Claude가 실수해서 해로운 명령이 실행될 수도 있으니, 다른 것과 분리된 환경에서만 쓰기를 권해요. 모드를 바꾸려면 Shift+Tab을 누르세요.',
    sample: '⏺ Auto mode lets Claude handle permission prompts automatically — Claude\n  checks each tool call for risky actions and prompt injection before\n  executing. Actions Claude identifies as safe are executed, while\n  actions Claude identifies as risky are blocked and Claude may try a\n  different approach. Ideal for long-running tasks. Sessions are\n  slightly more expensive. Claude can make mistakes that allow harmful\n  commands to run, it\'s recommended to only use in isolated\n  environments. Shift+Tab to change mode.',
    evidence: 'Ideal for long-running tasks.' });

  // 신뢰 창
  def({ id: 'trust-accessing', kind: 'dialog', where: 'dialog', re: /^Accessing workspace:$/, ko: '작업할 폴더:',
    sample: dlg(' Accessing workspace:', '', ' /Users/tester/Documents/작업실'), evidence: 'Accessing workspace:' });
  def({ id: 'trust-safety-check', kind: 'dialog', where: 'dialog', maxRows: 6,
    re: /^Quick safety check: Is this a project you created or one you trust\? \(Like your own code, a well-known open source project, or work from your team\)\. If not, take a moment to review what's in this folder first\.$/,
    ko: '안전 확인: 직접 만들었거나 믿을 수 있는 프로젝트인가요? (내 코드, 잘 알려진 공개 프로젝트, 우리 팀이 만든 것처럼요.) 아니라면 먼저 이 폴더에 무엇이 들어 있는지 살펴보세요.',
    sample: dlg(' Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source', " project, or work from your team). If not, take a moment to review what's in this folder first."),
    evidence: 'Quick safety check: Is this a project you created or one you trust?' });
  def({ id: 'trust-will-access', kind: 'dialog', where: 'dialog', maxRows: 3,
    re: /^Claude Code'll be able to read, edit, and execute files here\.$/,
    ko: 'Claude Code가 이 폴더의 파일을 읽고, 고치고, 실행할 수 있게 돼요.',
    sample: dlg(" Claude Code'll be able to read, edit, and execute files here."), evidence: 'll be able to read, edit, and execute files here.' });
  def({ id: 'trust-security-guide', kind: 'dialog', where: 'dialog', re: /^Security guide$/, ko: '보안 안내',
    sample: dlg(' Security guide', '', ' ❯ No, exit', '   Yes, I trust this folder'), evidence: 'Security guide' });
  def({ id: 'trust-pre-approves', kind: 'dialog', where: 'dialog', maxRows: 3,
    re: /^(?:⚠ )?(?<c>This folder pre-approves (\d+) tool permissions? in (.+):)$/d,
    ko: (m) => ({ text: `이 폴더는 ${m[3]}에서 도구 허락 ${m[2]}개를 미리 해 뒀어요:`, vars: [m[3]] }),
    sample: dlg(' ⚠ This folder pre-approves 2 tool permissions in .claude/settings.json:', '   Bash(npm test), Read'), evidence: 'This folder pre-approves ' });
  def({ id: 'trust-adds-dirs', kind: 'dialog', where: 'dialog', maxRows: 3,
    re: /^(?:⚠ )?(?<c>This folder adds (\d+) (?:directory|directories) to the workspace in (.+):)$/d,
    ko: (m) => ({ text: `이 폴더는 ${m[3]}에서 작업 폴더 ${m[2]}개를 더해요:`, vars: [m[3]] }),
    sample: dlg(' ⚠ This folder adds 1 directory to the workspace in .claude/settings.json:', '   ../shared'), evidence: 'This folder adds ' });
  def({ id: 'trust-headers-helper', kind: 'dialog', where: 'dialog', maxRows: 3,
    re: /^(?:⚠ )?(?<c>This folder runs commands to mint HTTP headers \(headersHelper\), declared in (.+))$/d,
    ko: (m) => ({ text: `이 폴더는 ${m[2]}에 적힌 명령을 실행해서 요청 머리글을 만들어요(headersHelper)`, vars: [m[2], 'headersHelper'] }),
    sample: dlg(' ⚠ This folder runs commands to mint HTTP headers (headersHelper), declared in .claude/settings.json'),
    evidence: 'This folder runs commands to mint HTTP headers (headersHelper), declared in ' });
  def({ id: 'trust-apply-warning', kind: 'dialog', where: 'dialog', maxRows: 3,
    re: /^These will apply without asking\. Only proceed if you trust this configuration\.$/,
    ko: '이 설정은 묻지 않고 바로 적용돼요. 이 설정을 믿을 때만 계속하세요.',
    sample: dlg(' These will apply without asking. Only proceed if you trust this configuration.'),
    evidence: 'These will apply without asking. Only proceed if you trust this configuration.' });

  // 새 MCP 서버 창
  def({ id: 'mcp-new-server', kind: 'dialog', where: 'dialog', maxRows: 2,
    re: /^New MCP server found in this project: (.+)$/,
    ko: (m) => ({ text: `이 프로젝트에서 새 외부 도구 연결(MCP)을 찾았어요: ${m[1]}`, vars: [m[1]] }),
    sample: dlg('  New MCP server found in this project: bigquery'), evidence: 'New MCP server found in this project:' });
  def({ id: 'mcp-new-servers', kind: 'dialog', where: 'dialog', re: /^(\d+) new MCP servers found in this project$/,
    ko: (m) => `이 프로젝트에서 새 외부 도구 연결(MCP) ${m[1]}개를 찾았어요`,
    sample: dlg('  2 new MCP servers found in this project', '  Select any you wish to enable.'), evidence: 'new MCP servers found in this project' });
  def({ id: 'mcp-select-any', kind: 'dialog', where: 'dialog', re: /^Select any you wish to enable\.$/, ko: '켜고 싶은 것을 고르세요.',
    sample: dlg('  2 new MCP servers found in this project', '  Select any you wish to enable.'), evidence: 'Select any you wish to enable.' });
  def({ id: 'mcp-warning', kind: 'dialog', where: 'dialog', maxRows: 4,
    re: /^MCP servers may execute code or access system resources\. All tool calls require approval\. Learn more in the MCP documentation\.$/,
    ko: '외부 도구 연결(MCP)은 코드를 실행하거나 컴퓨터 자원에 접근할 수 있어요. 도구를 쓸 때마다 허락을 받아요. 자세한 건 MCP 설명서를 보세요.',
    sample: dlg('  MCP servers may execute code or access system resources. All tool calls', '  require approval. Learn more in the MCP documentation.'),
    evidence: 'MCP servers may execute code or access system resources. All tool calls require approval.' });

  // 테마 고르기
  def({ id: 'theme-start', kind: 'dialog', where: 'dialog', re: /^Let's get started\.$/, ko: '시작해 볼게요.',
    sample: dlg(" Let's get started."), evidence: "Let's get started." });
  def({ id: 'theme-choose', kind: 'dialog', where: 'dialog', maxRows: 2,
    re: /^Choose the text style that looks best with your terminal$/, ko: '내 터미널에서 가장 잘 보이는 글자 색을 고르세요',
    sample: dlg(' Choose the text style that looks best with your terminal'), evidence: 'Choose the text style that looks best with your terminal' });
  def({ id: 'theme-later', kind: 'dialog', where: 'dialog', re: /^To change this later, run \/theme$/, ko: '나중에 바꾸려면 /theme을 입력하세요',
    sample: dlg(' To change this later, run /theme'), evidence: 'To change this later, run /theme' });
  def({ id: 'theme-syntax', kind: 'dialog', where: 'dialog', re: /^Syntax theme: (.+) \(ctrl\+t to (disable|enable)\)$/,
    ko: (m) => ({ text: `코드 색 테마: ${m[1]} (ctrl+t로 ${m[2] === 'disable' ? '끄기' : '켜기'})`, vars: [m[1]] }),
    sample: dlg('  Syntax theme: Monokai Extended (ctrl+t to disable)'), evidence: 'Syntax theme:' });
  def({ id: 'theme-syntax-off', kind: 'dialog', where: 'dialog', re: /^Syntax highlighting disabled \(ctrl\+t to enable\)$/,
    ko: '코드 색칠 꺼짐 (ctrl+t로 켜기)',
    sample: dlg('  Syntax highlighting disabled (ctrl+t to enable)'), evidence: 'Syntax highlighting disabled' });

  // 로그인
  def({ id: 'login-intro', kind: 'dialog', where: 'dialog', maxRows: 3,
    re: /^Claude Code can be used with your Claude subscription or billed based on API usage through your Console account\.$/,
    ko: 'Claude Code는 Claude 구독으로 쓰거나, Console 계정에서 쓴 만큼 낼 수 있어요.',
    sample: dlg(' Claude Code can be used with your Claude subscription or billed based on API', ' usage through your Console account.'),
    evidence: 'Claude Code can be used with your Claude subscription or billed based on API usage through your Console account.' });
  def({ id: 'login-select', kind: 'dialog', where: 'dialog', re: /^Select login method:$/, ko: '로그인 방법을 고르세요:',
    sample: dlg(' Select login method:'), evidence: 'Select login method:' });
  def({ id: 'login-title', kind: 'dialog', where: 'title', re: /^Login$/, ko: '로그인',
    sample: dlg('  Login', '', '  Select login method:'), evidence: `${CAP}/login-slash-120.txt` });
  def({ id: 'login-browser', kind: 'dialog', where: 'dialog', maxRows: 2,
    re: /^Browser didn't open\? Use the url below to sign in \(c to copy\)$/,
    ko: '브라우저가 안 열렸나요? 아래 주소로 로그인하세요 (c를 누르면 복사)',
    sample: dlg(" Browser didn't open? Use the url below to sign in (c to copy)"), evidence: 'Use the url below to sign in' });
  def({ id: 'login-paste-code', kind: 'dialog', where: 'dialog', noExtend: true,
    re: /^(?<c>Paste code here if prompted >)(?: .*)?$/d, ko: '코드가 나오면 붙여 넣기 >',
    sample: dlg(' Paste code here if prompted >'), evidence: 'Paste code here if prompted' });

  // 키 승인
  def({ id: 'api-key-detected', kind: 'dialog', where: 'dialog', re: /^Detected a custom API key in your environment$/,
    ko: '컴퓨터 환경 설정에 따로 넣은 API 키가 있어요',
    sample: dlg('  Detected a custom API key in your environment'), evidence: 'Detected a custom API key in your environment' });
  def({ id: 'api-key-question', kind: 'dialog', where: 'dialog', re: /^Do you want to use this API key\?$/, ko: '이 API 키를 쓸까요?',
    sample: dlg('  Do you want to use this API key?'), evidence: 'Do you want to use this API key?' });

  // 처음 실행 보안 안내
  def({ id: 'security-notes', kind: 'dialog', where: 'dialog', re: /^Security notes:$/, ko: '보안 안내:',
    sample: dlg(' Security notes:'), evidence: 'Security notes:' });
  def({ id: 'security-mistakes', kind: 'dialog', where: 'dialog', re: /^\d+\. (?<c>Claude can make mistakes\.)$/d,
    ko: 'Claude도 실수할 수 있어요.', sample: dlg(' 1. Claude can make mistakes.'), evidence: 'Claude can make mistakes.' });
  def({ id: 'security-responsible', kind: 'dialog', where: 'dialog', maxRows: 3,
    re: /^You're responsible for Claude's actions and should always review them, especially when running code\.$/,
    ko: 'Claude가 한 일은 내 책임이에요. 늘 확인하고, 특히 코드를 실행할 때는 꼭 확인하세요.',
    sample: dlg(' 1. Claude can make mistakes.', "    You're responsible for Claude's actions and should always", '    review them, especially when running code.'),
    evidence: "responsible for Claude's actions and should always" });
  def({ id: 'security-injection', kind: 'dialog', where: 'dialog', maxRows: 2,
    re: /^\d+\. (?<c>Due to prompt injection risks, only use it with code you trust)$/d,
    ko: '숨은 지시(프롬프트 주입) 위험이 있어 믿는 코드에서만 쓰세요',
    sample: dlg(' 2. Due to prompt injection risks, only use it with code you trust'), evidence: 'Due to prompt injection risks, only use it with code you trust' });
  def({ id: 'security-learn-more', kind: 'dialog', where: 'dialog', re: /^(?<c>Learn more:) https?:\/\/\S+$/d, ko: '더 보기:',
    sample: dlg('    Learn more: https://code.claude.com/docs/en/security'), evidence: 'Learn more:' });
  def({ id: 'press-enter', kind: 'dialog', where: 'dialog', re: /^Press Enter to continue…$/, ko: '계속하려면 Enter를 누르세요…',
    sample: dlg(' Press Enter to continue…'), evidence: `${CAP}/security-notes-120.txt` });

  // 허락 창
  const PERM_TITLES = [
    ['bash', 'Bash command', '명령 실행'], ['create', 'Create file', '파일 만들기'], ['edit', 'Edit file', '파일 고치기'],
    ['overwrite', 'Overwrite file', '파일 덮어쓰기'], ['notebook', 'Edit notebook', '노트북 고치기'], ['read', 'Read file', '파일 읽기'],
    ['tool', 'Tool use', '도구 사용'], ['fetch', 'Fetch', '인터넷에서 가져오기'],
  ];
  for (const [id, en, ko] of PERM_TITLES) {
    def({ id: `perm-title-${id}`, kind: 'permission', where: 'title', re: new RegExp(`^${en}$`), ko,
      sample: dlg(` ${en}`, ' a.txt', '', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No'), evidence: en });
  }
  def({ id: 'perm-tip-auto', kind: 'permission', where: 'dialog', maxRows: 2,
    re: /^Tip: auto mode handles these prompts for you — choose "switch to auto mode" below$/,
    ko: "도움말: 자동 모드로 바꾸면 이런 질문을 대신 처리해요. 아래에서 '자동 모드로 바꾸기'를 고르세요",
    sample: dlg(' Bash command', ' Tip: auto mode handles these prompts for you — choose "switch to auto mode" below'),
    evidence: 'Tip: auto mode handles these prompts for you' });
  def({ id: 'perm-fetch-desc', kind: 'permission', where: 'dialog', re: /^Claude wants to fetch content from (\S+)$/,
    ko: (m) => ({ text: `Claude가 ${m[1]}에서 내용을 가져오려고 해요`, vars: [m[1]] }),
    sample: dlg(' Fetch', ' Claude wants to fetch content from example.org'), evidence: 'Claude wants to fetch content from' });
  def({ id: 'perm-about-tool', kind: 'permission', where: 'dialog', re: /^About the (.+):$/,
    ko: (m) => ({ text: `${m[1]} 설명:`, vars: [m[1]] }),
    sample: dlg(' Tool use', ' About the Notion — Notion-Search Tool:'), evidence: 'About the ' });
  def({ id: 'perm-expand-desc', kind: 'permission', where: 'dialog', re: /^\(ctrl\+o to expand description\)$/,
    ko: '(ctrl+o로 설명 펼치기)', sample: dlg(' (ctrl+o to expand description)'), evidence: 'review/hook/runs/rD/caps/31-mcp-holding.txt' });
  def({ id: 'perm-q-proceed', kind: 'permission', where: 'dialog', re: /^Do you want to proceed\?$/, ko: '계속할까요?',
    sample: dlg(' Do you want to proceed?', ' ❯ 1. Yes', '   2. No'), evidence: 'Do you want to proceed?' });
  def({ id: 'perm-q-create', kind: 'permission', where: 'dialog', maxRows: 2, re: /^Do you want to create (\S+)\?$/,
    ko: (m) => ({ text: `${m[1]} 파일을 만들까요?`, vars: [m[1]] }),
    sample: dlg(' Do you want to create a.txt?', ' ❯ 1. Yes', '   2. No'), evidence: 'test/fixtures/screens/permission-write.txt' });
  def({ id: 'perm-q-edit', kind: 'permission', where: 'dialog', maxRows: 2, re: /^Do you want to make this edit to (\S+)\?$/,
    ko: (m) => ({ text: `${m[1]} 파일을 이렇게 고칠까요?`, vars: [m[1]] }),
    sample: dlg(' Do you want to make this edit to a.txt?', ' ❯ 1. Yes', '   2. No'), evidence: 'make this edit to' });
  def({ id: 'perm-q-fetch', kind: 'permission', where: 'dialog', re: /^Do you want to allow Claude to fetch this content\?$/,
    ko: 'Claude가 이 내용을 가져와도 될까요?',
    sample: dlg(' Do you want to allow Claude to fetch this content?', ' ❯ 1. Yes', '   2. No'), evidence: 'Do you want to allow Claude to fetch this content?' });
  def({ id: 'perm-q-connection', kind: 'permission', where: 'dialog', re: /^Do you want to allow this connection\?$/,
    ko: '이 연결을 허락할까요?',
    sample: dlg(' Do you want to allow this connection?', ' ❯ 1. Yes', '   2. No'), evidence: 'Do you want to allow this connection?' });

  // 고르기 항목
  const opt = (...rows) => dlg(' Do you want to proceed?', ...rows);
  def({ id: 'option-yes', kind: 'option', where: 'option', re: /^Yes$/, ko: '네', sample: opt(' ❯ 1. Yes', '   2. No'), evidence: 'review/hook/runs/rD/caps/10-write-after-hook-timeout.txt' });
  def({ id: 'option-no', kind: 'option', where: 'option', re: /^No$/, ko: '아니요', sample: opt('   1. Yes', ' ❯ 2. No'), evidence: 'review/hook/runs/rD/caps/10-write-after-hook-timeout.txt' });
  def({ id: 'option-no-recommended', kind: 'option', where: 'option', re: /^No \(recommended\)$/, ko: '아니요(권장)',
    sample: dlg('  Do you want to use this API key?', '', '    Yes', '  ❯ No (recommended)'), evidence: `${CAP}/api-key-120.txt` });
  def({ id: 'option-trust-yes', kind: 'option', where: 'option', re: /^Yes, I trust this folder$/, ko: '네, 이 폴더를 믿어요',
    sample: dlg(' ❯ No, exit', '   Yes, I trust this folder'), evidence: 'Yes, I trust this folder' });
  def({ id: 'option-trust-exit', kind: 'option', where: 'option', re: /^No, exit$/, ko: '아니요, 나가기',
    sample: dlg('   No, exit', ' ❯ Yes, I trust this folder'), evidence: 'No, exit' });
  def({ id: 'option-trust-continue', kind: 'option', where: 'option', re: /^No, continue without these permissions$/, ko: '아니요, 이 권한 없이 계속하기',
    sample: dlg(' ❯ No, continue without these permissions', '   Yes, I trust this folder'), evidence: 'No, continue without these permissions' });
  def({ id: 'option-mcp-use', kind: 'option', where: 'option', re: /^Use this MCP server$/, ko: '이 연결 쓰기',
    sample: dlg('  ❯ Use this MCP server', '    Continue without using this MCP server'), evidence: 'Use this MCP server' });
  def({ id: 'option-mcp-use-all', kind: 'option', where: 'option', re: /^Use this and all future MCP servers in this project$/,
    ko: '이 연결과 앞으로 이 프로젝트에 생길 연결 모두 쓰기',
    sample: dlg('    Use this and all future MCP servers in this project', '  ❯ Continue without using this MCP server'),
    evidence: 'Use this and all future MCP servers in this project' });
  def({ id: 'option-mcp-skip', kind: 'option', where: 'option', re: /^Continue without using this MCP server$/, ko: '이 연결 없이 계속하기',
    sample: dlg('  ❯ Continue without using this MCP server', '    Use this MCP server'), evidence: 'Continue without using this MCP server' });
  def({ id: 'option-mcp-enable-selected', kind: 'option', where: 'option', re: /^Enable selected$/, ko: '고른 것 켜기',
    sample: dlg('  ❯ [✔] demo-server', '       Enable selected'), evidence: 'Enable selected' });
  const THEME_KO = { 'Dark mode': '어두운 화면', 'Light mode': '밝은 화면' };
  def({ id: 'option-theme', kind: 'option', where: 'option',
    re: /^(?:Auto \(match terminal\)|(Dark mode|Light mode)(?: \((colorblind-friendly|ANSI colors only)\))?)$/,
    ko: (m) => (m[1] ? `${THEME_KO[m[1]]}${m[2] ? (m[2] === 'colorblind-friendly' ? '(색약용)' : '(기본 색만)') : ''}` : '자동(터미널에 맞춤)'),
    sample: dlg('     Auto (match terminal)', ' ❯ ✔ Dark mode', '     Light mode (colorblind-friendly)'), evidence: 'colorblind-friendly' });
  def({ id: 'option-login-subscription', kind: 'option', where: 'option', re: /^Claude account with subscription · Pro, Max, Team, or Enterprise$/,
    ko: '구독 중인 Claude 계정 · Pro, Max, Team, Enterprise',
    sample: dlg(' ❯ 1. Claude account with subscription · Pro, Max, Team, or Enterprise', '   2. Anthropic Console account · API usage billing'),
    evidence: 'Pro, Max, Team, or Enterprise' });
  def({ id: 'option-login-console', kind: 'option', where: 'option', re: /^Anthropic Console account · API usage billing$/,
    ko: 'Anthropic Console 계정 · 쓴 만큼 내는 요금',
    sample: dlg(' ❯ 1. Claude account with subscription · Pro, Max, Team, or Enterprise', '   2. Anthropic Console account · API usage billing'),
    evidence: 'Anthropic Console account' });
  def({ id: 'option-login-3p', kind: 'option', where: 'option', re: /^3rd-party platform · (.+)$/,
    ko: (m) => ({ text: `다른 회사 플랫폼 · ${m[1]}`, vars: [m[1]] }),
    sample: dlg(' ❯ 1. Claude account with subscription · Pro, Max, Team, or Enterprise', '   3. 3rd-party platform · Amazon Bedrock, Microsoft Foundry, Google Vertex AI'),
    evidence: '3rd-party platform' });
  def({ id: 'option-perm-accept-edits', kind: 'option', where: 'option', maxRows: 3,
    re: /^Yes, and switch to accept edits \(auto-approve file edits and common file commands\) for this session \(shift\+tab\)$/,
    ko: '네, 그리고 이번 대화 동안 파일 고치기 자동 허락으로 바꾸기 (파일 고치기와 흔한 파일 명령은 묻지 않아요) (Shift+Tab)',
    sample: opt(' ❯ 1. Yes', '   2. Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)', '   3. No'),
    evidence: 'review/hook/runs/rD/caps/10-write-after-hook-timeout.txt' });
  def({ id: 'option-perm-always-dir', kind: 'option', where: 'option', maxRows: 4,
    re: /^Yes, and always allow access to (.+) from this project$/,
    ko: (m) => ({ text: `네, 그리고 이 프로젝트에서는 ${m[1]} 접근을 늘 허락하기`, vars: [m[1]] }),
    sample: opt(' ❯ 1. Yes', '   2. Yes, and always allow access to /Users/tester/Projects/demo from this project', '   3. No'),
    evidence: 'Yes, and always allow access to ' });
  def({ id: 'option-perm-auto', kind: 'option', where: 'option', maxRows: 2,
    re: /^Yes, and switch to auto mode(?<more> · auto mode handles these prompts for you)?$/,
    ko: (m) => `네, 그리고 자동 모드로 바꾸기${m.groups.more ? ' · 이런 질문을 자동 모드가 대신 처리해요' : ''}`,
    sample: opt(' ❯ 1. Yes', '   3. Yes, and switch to auto mode · auto mode handles these prompts for you', '   4. No'),
    evidence: 'Yes, and switch to auto mode' });
  def({ id: 'option-perm-dont-ask-commands', kind: 'option', where: 'option', maxRows: 3,
    re: /^Yes, and don't ask again for (.+) commands in (.+)$/,
    ko: (m) => ({ text: `네, 그리고 ${m[2]}에서 ${m[1]} 명령은 다시 묻지 않기`, vars: [m[1], m[2]] }),
    sample: opt(' ❯ 1. Yes', "   2. Yes, and don't ask again for Notion — Notion-Search commands in /Users/tester/Projects/demo", '   3. No'),
    evidence: "Yes, and don't ask again for" });
  def({ id: 'option-perm-dont-ask', kind: 'option', where: 'option', maxRows: 3,
    re: /^Yes, and don't ask again for (?!.* commands in )(.+)$/,
    ko: (m) => ({ text: `네, 그리고 앞으로 ${m[1]}에는 다시 묻지 않기`, vars: [m[1]] }),
    sample: opt(' ❯ 1. Yes', "   2. Yes, and don't ask again for example.org", '   3. No'), evidence: "Yes, and don't ask again for" });
  def({ id: 'option-perm-claude-folder', kind: 'option', where: 'option', maxRows: 3,
    re: /^Yes, and allow Claude to edit files in this project's \.claude folder for this session$/,
    ko: '네, 그리고 이번 대화 동안 이 프로젝트의 .claude 폴더 파일도 고치게 허락하기',
    sample: opt(' ❯ 1. Yes', "   2. Yes, and allow Claude to edit files in this project's .claude folder for this session", '   3. No'),
    evidence: "Yes, and allow Claude to edit files in this project's .claude folder for this session" });
  def({ id: 'option-perm-tell-claude', kind: 'option', where: 'option', maxRows: 2,
    re: /^No, and tell Claude what to do differently \(esc\)$/, ko: '아니요, Claude에게 다르게 할 일을 알려 주기 (Esc)',
    sample: opt(' ❯ 1. Yes', '   2. No, and tell Claude what to do differently (esc)'), evidence: 'No, and tell Claude what to do differently' });

  // 대화 상자 아래 안내 줄(조각마다)
  const HINTS = [
    ['enter-confirm', 'Enter to confirm', 'Enter로 확인', `${CAP}/trust-120.txt`],
    ['esc-cancel', 'Esc to cancel', 'Esc로 취소', 'Esc to cancel'],
    ['tab-amend', 'Tab to amend', 'Tab으로 말 덧붙이기', 'to amend'],
    ['space-select', 'Space to select', 'Space로 고르기', `${CAP}/mcp-new-servers-120.txt`],
    ['esc-reject-all', 'Esc to reject all', 'Esc로 모두 거절', 'reject all'],
    ['enter-select', 'Enter to select', 'Enter로 고르기', 'review/policy-alternatives/mod-poc/tmux-05-auto-mode.txt'],
    ['arrows-navigate', '↑/↓ to navigate', '↑/↓로 움직이기', 'review/policy-alternatives/mod-poc/tmux-05-auto-mode.txt'],
  ];
  for (const [id, en, ko, evidence] of HINTS) {
    def({ id: `hint-${id}`, kind: 'hint', where: 'hint', part: en, ko,
      sample: dlg(` ${en}${en === 'Esc to cancel' ? '' : ' · Esc to cancel'}`), evidence });
  }
  def({ id: 'hint-press-again-exit', kind: 'hint', where: 'dialog', re: /^Press (\S+) again to exit$/,
    ko: (m) => ({ text: `나가려면 ${m[1]}를 한 번 더 누르세요`, vars: [m[1]] }),
    sample: dlg(' Press Ctrl-C again to exit'), evidence: 'again to exit' });

  // 오류·상태 줄
  def({ id: 'status-interrupted', kind: 'status', where: 'status', re: /^Interrupted · What should Claude do instead\?$/,
    ko: '멈췄어요 · Claude가 대신 무엇을 할까요?', sample: '  ⎿  Interrupted · What should Claude do instead?', evidence: 'What should Claude do instead?' });
  def({ id: 'status-not-logged-in', kind: 'status', where: 'status', re: /^Not logged in · Please run \/login$/,
    ko: '로그인이 안 돼 있어요 · /login을 입력하세요', sample: '  ⎿  Not logged in · Please run /login', evidence: 'Not logged in' });
  def({ id: 'status-invalid-key-fix', kind: 'status', where: 'status', re: /^Invalid API key · Fix external API key$/,
    ko: 'API 키가 맞지 않아요 · 따로 넣은 API 키를 고쳐 주세요', sample: '  ⎿  Invalid API key · Fix external API key', evidence: 'Fix external API key' });
  def({ id: 'status-invalid-key-login', kind: 'status', where: 'status', re: /^Invalid API key · Please run \/login$/,
    ko: 'API 키가 맞지 않아요 · /login을 입력하세요', sample: '  ⎿  Invalid API key · Please run /login', evidence: 'Invalid API key' });
  def({ id: 'status-login-expired', kind: 'status', where: 'status', re: /^Login expired · Please run \/login$/,
    ko: '로그인이 끝났어요 · /login을 입력하세요', sample: '  ⎿  Login expired · Please run /login', evidence: 'Login expired' });
  def({ id: 'status-hit-limit', kind: 'status', where: 'status', re: /^You've hit your (?:(.+?) )?limit(?: · resets (.+))?$/,
    ko: (m) => {
      const vars = [];
      let kind = '사용';
      if (m[1]) {
        kind = LIMIT_KO[m[1]] || `${m[1]} 사용`;
        if (!LIMIT_KO[m[1]]) vars.push(m[1]);
      }
      let text = `${kind} 한도를 다 썼어요`;
      if (m[2]) {
        const t = timeKo(m[2]);
        vars.push(...t.vars);
        text += ` · ${t.text}에 다시 채워져요`;
      }
      return { text, vars };
    },
    sample: "  ⎿  You've hit your session limit · resets 3:45pm", evidence: "You've hit your " });
  def({ id: 'status-limit-reached', kind: 'status', where: 'status', re: /^Usage limit reached(?: · limit resets (.+))?$/,
    ko: (m) => {
      if (!m[1]) return '사용 한도에 닿았어요';
      const t = timeKo(m[1]);
      return { text: `사용 한도에 닿았어요 · ${t.text}에 다시 채워져요`, vars: t.vars };
    },
    sample: 'Usage limit reached · limit resets 3:45pm', evidence: 'Usage limit reached' });
  def({ id: 'status-limit-continuing', kind: 'status', where: 'status',
    re: /^(?:(Usage limit reached(?: again)?) · c|C)ontinuing automatically (.+?) · esc to cancel$/,
    ko: (m) => {
      const t = timeKo(m[2]);
      const when = t.vars.length ? t.text : `${t.text}에`;
      return { text: `${m[1] ? '사용 한도에 닿았어요 · ' : ''}${when} 저절로 이어서 해요 · Esc로 취소`, vars: t.vars };
    },
    sample: 'Continuing automatically at 3:45pm · esc to cancel', evidence: 'Continuing automatically' });

  // 입력 칸 아래 모드 줄(조각마다)
  const MODES = [
    ['manual', 'manual mode on', '하나씩 묻는 모드', 'manual mode'],
    ['accept-edits', 'accept edits on', '파일 고치기 자동 허락', 'accept edits on'],
    ['plan', 'plan mode on', '계획 모드', 'plan mode on'],
    ['auto', 'auto mode on', '자동 모드', 'auto mode on'],
    ['bypass', 'bypass permissions on', '묻지 않고 모두 실행 모드', 'bypass permissions'],
  ];
  for (const [id, en, ko, evidence] of MODES) {
    def({ id: `footer-mode-${id}`, kind: 'footer', where: 'footer', part: en, ko, sample: idle([], `  ⏵⏵ ${en} · ← for agents`), evidence });
  }
  def({ id: 'footer-cycle', kind: 'footer', where: 'footer', part: '(shift+tab to cycle)', ko: '(Shift+Tab으로 바꾸기)',
    sample: idle([], '  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents'), evidence: 'to cycle' });
  def({ id: 'footer-shortcuts', kind: 'footer', where: 'footer', part: '? for shortcuts', ko: '? 단축키', sample: idle([], FOOT), evidence: '? for shortcuts' });
  def({ id: 'footer-interrupt', kind: 'footer', where: 'footer', part: 'esc to interrupt', ko: 'Esc로 멈추기',
    sample: idle([], '  ⏸ manual mode on · esc to interrupt · ← 2 agents'), evidence: 'esc to interrupt' });
  def({ id: 'footer-agents', kind: 'footer', where: 'footer', partRe: /^← (?:for agents|(\d+) agents?)$/,
    ko: (m) => (m[1] ? `← 에이전트 ${m[1]}개` : '← 에이전트'), sample: idle([], '  ⏸ manual mode on · ? for shortcuts · ← 2 agents'), evidence: ' for agents' });
  def({ id: 'footer-not-logged-in', kind: 'footer', where: 'footer', part: 'Not logged in', ko: '로그인 안 됨',
    sample: idle([], `${FOOT}                    Not logged in · Run /login`), evidence: 'Not logged in' });
  def({ id: 'footer-run-login', kind: 'footer', where: 'footer', part: 'Run /login', ko: '/login 입력',
    sample: idle([], `${FOOT}                    Not logged in · Run /login`), evidence: 'Run /login' });
  def({ id: 'footer-rc-connecting', kind: 'footer', where: 'footer', part: '/rc connecting…', ko: '/rc 연결하는 중…',
    sample: idle([], `${FOOT}\n${' '.repeat(60)}/rc connecting…`), evidence: '/rc connecting' });
  def({ id: 'footer-effort', kind: 'footer', where: 'effort', re: /^([○◐●◉◈]) (low|medium|high|xhigh|max)(?<u> · ultracode)? · \/effort$/,
    ko: (m) => ({
      text: `${m[1]} 생각 깊이 ${EFFORT_KO[m[2]]}${m.groups.u ? ' · ultracode' : ''} · /effort`,
      alts: [`${m[1]} 생각 ${EFFORT_KO[m[2]]}${m.groups.u ? ' · ultracode' : ''} · /effort`, `${m[1]} ${EFFORT_KO[m[2]]}${m.groups.u ? ' · ultracode' : ''} · /effort`],
      vars: m.groups.u ? ['ultracode'] : [],
    }),
    sample: [`${' '.repeat(40)}◐ medium · /effort`, LINE, '❯ ', LINE, FOOT].join('\n'), evidence: `${CAP}/idle-120.txt` });

  const byId = new Map(DEFS.map((d) => [d.id, d]));
  const RULES = Object.freeze(DEFS.map((d) => Object.freeze({ id: d.id, kind: d.kind, sample: d.sample, evidence: d.evidence })));

  // 대화 상자 규칙을 정규식의 첫 낱말로 묶어 둔다. 줄마다 첫 낱말이 같은 규칙만 맞춰 보므로 여러 줄을 이어 붙이는 일이 줄어든다.
  // 낱말로 시작하지 않는 규칙(번호·괄호로 시작)은 모든 줄에서 본다. 모든 규칙이 실제로 걸리는지는 시험이 sample로 확인한다.
  const firstWord = (s) => s.slice(0, s.search(/[\s:,.?]|$/));
  function indexByFirstWord(defs) {
    const map = new Map();
    const any = [];
    for (const d of defs) {
      const src = d.re.source.replace(/^\^/, '').replace(/^\(\?:⚠ \)\?/, '').replace(/^\(\?<c>/, '');
      const m = /^([A-Za-z][A-Za-z'-]*)/.exec(src.replace(/\\/g, ''));
      // "\d+\. …" 처럼 낱말로 시작하지 않는 규칙은 모든 줄에서 본다.
      if (!m || /^\\d|^\(|^\[/.test(src)) { any.push(d); continue; }
      if (!map.has(m[1])) map.set(m[1], []);
      map.get(m[1]).push(d);
    }
    return (text) => {
      const w = firstWord(text.replace(/^(?:⚠ |\d+\. )/, ''));
      return (map.get(w) || []).concat(any);
    };
  }
  const where = (w) => DEFS.filter((d) => d.where === w && d.re);
  const dialogRules = indexByFirstWord(where('dialog'));
  const titleRules = where('title');
  const optionRules = where('option');
  const bannerRules = { '⚠': [], '⏺': [], '▎': [] };
  for (const d of where('banner')) bannerRules[d.prefix].push(d);
  const statusRules = where('status');
  const hintParts = new Map(DEFS.filter((d) => d.where === 'hint' && d.part).map((d) => [d.part, d]));
  const footerParts = new Map(DEFS.filter((d) => d.where === 'footer' && d.part).map((d) => [d.part, d]));
  const footerPartRes = DEFS.filter((d) => d.where === 'footer' && d.partRe);
  const effortRule = byId.get('footer-effort');

  function applyKo(d, m) {
    const r = typeof d.ko === 'function' ? d.ko(m) : d.ko;
    return typeof r === 'string' ? { text: r, vars: [] } : { text: r.text, vars: r.vars || [], alts: r.alts };
  }

  // ── 화면 읽기 ──

  const H_RULE = /^\s*─{8,}\s*$/;
  const DASH_RULE = /^\s*╌{8,}\s*$/;
  // 대화 기록 줄: Claude 답·도구 줄(⏺), 사용자가 보낸 글(맨 앞 ❯, 질문 창의 "❯ 1." 번호 목록은 빼고), 도구 결과(⎿)
  const HISTORY_ROW = /^(?:⏺|❯ (?!\d+\. )|\s+⎿ )/;

  function analyze(L) {
    const n = L.length;
    let inputRow = -1;
    let inputBottom = -1;
    // 입력 줄 앞 표시는 ❯, 명령 모드(맨 앞에 !를 쳤을 때)는 !다(2.1.299 바이너리: mode==="bash"?"!":…pointer).
    for (let i = n - 1; i > 0 && inputRow < 0; i--) {
      if (!/^[❯!](\s|$)/.test(L[i]) || !H_RULE.test(L[i - 1])) continue;
      let j = i + 1;
      while (j < n && !H_RULE.test(L[j])) j++;
      // 아래 가로줄이 화면 밖이면(위로 올려 봄) 그 아래는 모두 입력 칸으로 친다(사용자 글을 덮느니 영어로 둔다).
      inputRow = i;
      inputBottom = j < n ? j : n - 1;
    }
    let dialogStart = -1;
    if (inputRow < 0) {
      dialogStart = 0;
      for (let i = n - 1; i >= 0; i--) if (H_RULE.test(L[i])) { dialogStart = i + 1; break; }
      // 그 아래에 대화 기록 줄이 있으면 대화 상자가 아니라 위로 올려 본 기록이거나 claude가 끝난 뒤 화면이다.
      // 대화 상자 규칙을 쓰지 않는다(사용자 글·Claude 답·명령 출력을 덮느니 영어로 둔다).
      for (let i = dialogStart; i < n; i++) if (HISTORY_ROW.test(L[i])) { dialogStart = -1; break; }
    }
    return { inputRow, inputTop: inputRow - 1, inputBottom, dialogStart };
  }

  const indentOf = (s) => s.length - s.trimStart().length;

  // 첫 줄과 들여쓰기가 같은 다음 줄들을 이어 붙인다. cont(line) → 이어지는 줄이면 그 줄에서 글이 시작하는 위치.
  function gatherRows(L, r, startIdx, maxRows, free, cont) {
    const rows = [{ row: r, a: startIdx, b: L[r].length }];
    for (let k = 1; k < maxRows; k++) {
      const rr = r + k;
      if (rr >= L.length || !free(rr)) break;
      const a = cont(L[rr]);
      if (a < 0) break;
      rows.push({ row: rr, a, b: L[rr].length });
    }
    return rows;
  }

  // rows의 글을 띄어쓰기 하나로 이어 붙이고, 이은 글의 위치 → (줄, 위치)를 돌려줄 수 있게 한다.
  function joinRows(L, rows) {
    let text = '';
    const offs = [];
    for (const p of rows) {
      if (text) text += ' ';
      offs.push(text.length);
      text += L[p.row].slice(p.a, p.b);
    }
    return { text, offs };
  }

  // 이어 붙인 글 [s, e)에 해당하는 줄별 덮을 범위
  function spansFor(L, rows, offs, s, e) {
    const spans = [];
    rows.forEach((p, k) => {
      const ls = offs[k];
      const le = ls + (p.b - p.a);
      const from = Math.max(s, ls);
      const to = Math.min(e, le);
      if (to <= from) return;
      const line = L[p.row];
      const ia = p.a + (from - ls);
      const ib = p.a + (to - ls);
      const col = displayWidth(line.slice(0, ia));
      spans.push({ row: p.row, start: col, end: col + displayWidth(line.slice(ia, ib)) });
    });
    return spans;
  }

  // 한 규칙을 이어 붙인 문단에 맞춰 본다. 가장 적은 줄로 맞는 것을 쓴다.
  function tryRules(L, rules, rows) {
    for (let k = 1; k <= rows.length; k++) {
      const part = rows.slice(0, k);
      const { text, offs } = joinRows(L, part);
      for (const d of rules) {
        if ((d.maxRows || 1) < k) continue;
        const m = d.re.exec(text);
        if (!m) continue;
        let s = 0;
        let e = text.length;
        if (m.indices && m.indices.groups && m.indices.groups.c) [s, e] = m.indices.groups.c;
        const { text: ko, vars } = applyKo(d, m);
        return { d, ko, vars, spans: spansFor(L, part, offs, s, e), rows: part.map((p) => p.row) };
      }
    }
    return null;
  }

  // ── 덮을 곳 모으기 ──

  // alts: 자리가 모자랄 때 대신 쓸 더 짧은 글(뜻은 같게)
  function seg(d, ko, vars, spans, alts) {
    return { rule: d.id, kind: d.kind, text: ko, vars, spans, noExtend: !!d.noExtend, alts: alts || [] };
  }

  // 머리말: 버전 줄과 그 아래 두 줄(모델·요금). 앞의 로고 글자(▐▛█▝▘…)는 건너뛴다.
  const LOGO = /^[\s\u2580-\u259F~*.]*/;
  const MODEL_RE = /^((?:Opus|Sonnet|Haiku|Fable|Mythos)\b[\w. -]*?|claude-[\w.-]+)(?: \(([\d.]+[KMk]) context\))?(?: with (low|medium|high|xhigh|max) effort)?$/;

  function modelKo(s) {
    const m = MODEL_RE.exec(s);
    if (!m) return null;
    return { text: `모델 ${m[1]}${m[3] ? ` · 생각 깊이 ${EFFORT_KO[m[3]]}` : ''}`, vars: [m[1]] };
  }

  function headerSegs(L, r, out, used) {
    const line = L[r];
    if (!line.includes('Claude Code v')) return LOGO_BLOCK.test(line) ? modelLine(L, r, out, used) : false;
    const a = LOGO.exec(line)[0].length;
    const text = line.slice(a);
    for (const id of ['header-version', 'header-welcome']) {
      const d = byId.get(id);
      const m = d.re.exec(text);
      if (!m) continue;
      const { text: ko, vars } = applyKo(d, m);
      const col = displayWidth(line.slice(0, a));
      out.push(seg(d, ko, vars, [{ row: r, start: col, end: col + displayWidth(text) }]));
      used.add(r);
      // 모델·요금 줄: 바로 아래 두 줄 안에서 찾는다(로고만 있는 줄은 건너뛴다).
      for (let rr = r + 1; rr <= r + 2 && rr < L.length; rr++) if (!used.has(rr)) modelLine(L, rr, out, used);
      return true;
    }
    return false;
  }

  // 모델·요금 줄 하나. "Opus 5.5 (1M context) with xhigh effort · Claude Team", 좁으면 "Opus 5.5 …"와 "Claude Team"이 두 줄로 나뉜다.
  function modelLine(L, rr, out, used) {
    const l2 = L[rr];
    const a2 = LOGO.exec(l2)[0].length;
    const t2 = l2.slice(a2);
    if (!t2) return false;
    const parts = t2.split(' · ');
    let res = null;
    let ruleId = 'header-model';
    if (parts.length >= 2) {
      const mk = modelKo(parts.slice(0, -1).join(' · '));
      const bk = billingKo(parts[parts.length - 1]);
      if (mk && bk) res = { text: `${mk.text} · ${bk.text}`, vars: [...mk.vars, ...bk.vars] };
    } else {
      res = modelKo(t2);
      if (!res) { res = billingKo(t2); ruleId = 'header-billing'; }
    }
    if (!res) return false;
    const c2 = displayWidth(l2.slice(0, a2));
    out.push(seg(byId.get(ruleId), res.text, res.vars, [{ row: rr, start: c2, end: c2 + displayWidth(t2) }]));
    used.add(rr);
    return true;
  }

  // 머리말 로고 글자(▐▛█▝▜▀▘▗▟▄▂)로 시작하는 줄: 버전 줄이 화면 위로 밀려 나가도 모델 줄을 알아본다.
  const LOGO_BLOCK = /^[\s~*]*[\u2580-\u259F][\s\u2580-\u259F~*]*\S/;

  // 시작 안내 줄: ⚠·⏺ 뒤 문단(다음 줄은 두 칸 들여쓰기), ▎ 묶음(줄마다 ▎).
  function bannerSegs(L, r, free, out, used) {
    const ch = L[r][0];
    const rules = bannerRules[ch];
    if (!rules || L[r][1] !== ' ' || !rules.length) return;
    const cont = ch === '▎'
      ? (l) => (/^▎ \S/.test(l) ? 2 : -1)
      : (l) => (/^ {2}\S/.test(l) ? 2 : -1);
    const maxRows = Math.max(...rules.map((d) => d.maxRows || 1));
    const rows = gatherRows(L, r, 2, maxRows, free, cont);
    const hit = tryRules(L, rules, rows);
    if (!hit) return;
    out.push(seg(hit.d, hit.ko, hit.vars, hit.spans));
    for (const rr of hit.rows) used.add(rr);
  }

  // 오류·상태 줄: "  ⎿  …" 또는 줄 그대로
  function statusSegs(L, r, out, used) {
    const line = L[r];
    const m = /^(\s*⎿\s+|\s*)(\S.*)$/.exec(line);
    if (!m) return;
    const text = m[2];
    for (const d of statusRules) {
      const mm = d.re.exec(text);
      if (!mm) continue;
      const { text: ko, vars } = applyKo(d, mm);
      const col = displayWidth(m[1]);
      out.push(seg(d, ko, vars, [{ row: r, start: col, end: col + displayWidth(text) }]));
      used.add(r);
      return;
    }
  }

  // " · "로 나뉜 조각들을 표에서 찾아, 이웃한 아는 조각끼리 한 덮개로 묶는다.
  function partSegs(line, r, startIdx, text, lookup, out) {
    const pieces = text.split(' · ');
    let idx = startIdx;
    let run = null;
    const flush = () => {
      if (!run) return;
      const col = displayWidth(line.slice(0, run.a));
      out.push({ rule: run.ids.join('+'), kind: run.kind, text: run.kos.join(' · '), vars: run.vars,
        spans: [{ row: r, start: col, end: col + displayWidth(line.slice(run.a, run.b)) }], noExtend: false });
      run = null;
    };
    for (const p of pieces) {
      const hit = lookup(p);
      if (hit) {
        if (!run) run = { a: idx, b: idx, ids: [], kos: [], vars: [], kind: hit.d.kind };
        run.b = idx + p.length;
        run.ids.push(hit.d.id);
        if (hit.also) run.ids.push(hit.also);
        run.kos.push(hit.text);
        run.vars.push(...hit.vars);
      } else {
        flush();
      }
      idx += p.length + 3;
    }
    flush();
  }

  function lookupFooter(p) {
    // 모드 조각은 "(shift+tab to cycle)"이 붙을 수 있다.
    const cyc = / \(shift\+tab to cycle\)$/.exec(p);
    const core = cyc ? p.slice(0, cyc.index) : p;
    const d = footerParts.get(core);
    if (d) {
      if (!cyc) return { d, text: d.ko, vars: [] };
      const c = footerParts.get('(shift+tab to cycle)');
      return { d, also: c.id, text: `${d.ko} ${c.ko}`, vars: [] };
    }
    for (const dr of footerPartRes) {
      const m = dr.partRe.exec(p);
      if (m) return { d: dr, ...applyKo(dr, m) };
    }
    return null;
  }

  // 아래 모드 줄: 두 칸 이상 빈칸으로 덩어리를 나누고, 덩어리마다 아이콘(⏸ ⏵⏵)을 남긴 채 조각을 덮는다.
  function footerSegs(L, r, out, used) {
    const line = L[r];
    const re = /\S+(?: \S+)*/g;
    let m;
    while ((m = re.exec(line))) {
      const chunk = m[0];
      const e = effortRule.re.exec(chunk);
      if (e) {
        const { text, vars, alts } = applyKo(effortRule, e);
        const col = displayWidth(line.slice(0, m.index));
        out.push(seg(effortRule, text, vars, [{ row: r, start: col, end: col + displayWidth(chunk) }], alts));
        used.add(r);
        continue;
      }
      const icon = /^[⏸⏵⏯▶]+ /.exec(chunk);
      const skip = icon ? icon[0].length : 0;
      const before = out.length;
      partSegs(line, r, m.index + skip, chunk.slice(skip), lookupFooter, out);
      if (out.length > before) used.add(r);
    }
  }

  // 고르기 목록: ❯ 줄과 그 위아래로 들여쓰기가 ❯보다 깊은 줄들.
  const CURSOR_ITEM = /^(\s*)❯ /;
  const ITEM_HEAD = /^(\s*)(?:❯ +)?(\d+\. +)?(✔ +)?/;

  function optionSegs(L, from, to, out, used) {
    for (let r = from; r < to; r++) {
      const cm = CURSOR_ITEM.exec(L[r]);
      if (!cm || used.has(r)) continue;
      const cc = cm[1].length;
      const numbered = /^\s*❯ +\d+\. /.test(L[r]);
      if (cc === 0 && !numbered) continue; // 맨 앞 ❯는 사용자 입력 줄일 수 있다
      const inBlock = (l) => l.trim() !== '' && !CURSOR_ITEM.test(l) && indentOf(l) >= cc + 2;
      let s = r;
      while (s - 1 >= from && inBlock(L[s - 1]) && !used.has(s - 1)) s--;
      let e = r;
      while (e + 1 < to && inBlock(L[e + 1]) && !used.has(e + 1)) e++;
      // 항목 나누기: 번호 목록이면 번호 줄이 새 항목이고 나머지는 앞 항목이 접혀 내려온 줄이다.
      const items = [];
      for (let i = s; i <= e; i++) {
        const isHead = !numbered || i === r || /^\s*\d+\. /.test(L[i]);
        if (isHead || !items.length) items.push([i]);
        else items[items.length - 1].push(i);
      }
      // 맨 앞 "❯ 1. …"이 혼자면 고르기 목록(질문 창)이 아니라 사용자가 보낸 글이다.
      if (cc === 0 && items.length < 2) { r = e; continue; }
      for (const rowsOfItem of items) {
        const head = L[rowsOfItem[0]];
        const a = ITEM_HEAD.exec(head)[0].length;
        if (a >= head.length) continue;
        const rows = [{ row: rowsOfItem[0], a, b: head.length }];
        for (const rr of rowsOfItem.slice(1)) rows.push({ row: rr, a: indentOf(L[rr]), b: L[rr].length });
        const { text, offs } = joinRows(L, rows);
        for (const d of optionRules) {
          if ((d.maxRows || 1) < rows.length) continue;
          const m = d.re.exec(text);
          if (!m) continue;
          const { text: ko, vars } = applyKo(d, m);
          out.push(seg(d, ko, vars, spansFor(L, rows, offs, 0, text.length)));
          for (const rr of rowsOfItem) used.add(rr);
          break;
        }
      }
      r = e;
    }
  }

  function dialogSegs(L, from, to, free, out, used) {
    optionSegs(L, from, to, out, used);
    // 제목 줄: 가로줄 바로 아래 첫 글 줄
    if (from > 0) {
      for (let r = from; r < to; r++) {
        if (L[r].trim() === '') continue;
        if (!used.has(r)) {
          const a = indentOf(L[r]);
          const text = L[r].slice(a);
          for (const d of titleRules) {
            const m = d.re.exec(text);
            if (!m) continue;
            const { text: ko, vars } = applyKo(d, m);
            const col = displayWidth(L[r].slice(0, a));
            out.push(seg(d, ko, vars, [{ row: r, start: col, end: col + displayWidth(text) }]));
            used.add(r);
            break;
          }
        }
        break;
      }
    }
    for (let r = from; r < to; r++) {
      if (used.has(r) || !free(r)) continue;
      const line = L[r];
      if (line.trim() === '') continue;
      const a = indentOf(line);
      const text = line.slice(a);
      // 안내 줄: 조각이 모두 아는 것일 때만
      const pieces = text.split(' · ');
      if (pieces.every((p) => hintParts.has(p))) {
        const ds = pieces.map((p) => hintParts.get(p));
        const col = displayWidth(line.slice(0, a));
        out.push({ rule: ds.map((d) => d.id).join('+'), kind: 'hint', text: ds.map((d) => d.ko).join(' · '), vars: [],
          spans: [{ row: r, start: col, end: col + displayWidth(text) }], noExtend: false });
        used.add(r);
        continue;
      }
      const rules = dialogRules(text);
      if (!rules.length) continue;
      const maxRows = Math.max(...rules.map((d) => d.maxRows || 1));
      const rows = gatherRows(L, r, a, maxRows, (rr) => free(rr) && !used.has(rr), (l) => (l.trim() !== '' && indentOf(l) === a ? a : -1));
      const hit = tryRules(L, rules, rows);
      if (!hit) continue;
      out.push(seg(hit.d, hit.ko, hit.vars, hit.spans));
      for (const rr of hit.rows) used.add(rr);
      r = hit.rows[hit.rows.length - 1];
    }
  }

  // ── 덮개 크기 정하기 ──

  // 줄마다 칸 점유 표: 글자가 있는 칸과 이미 정한 덮개 칸
  function makeGrid(L, cols) {
    const grids = new Map();
    return {
      row(r) {
        let g = grids.get(r);
        if (!g) {
          g = { text: new Uint8Array(cols + 2), owner: new Int32Array(cols + 2).fill(-1) };
          let c = 0;
          for (const ch of L[r] || '') {
            const w = charWidth(ch.codePointAt(0));
            if (ch !== ' ' && w > 0) for (let k = 0; k < w && c + k < cols; k++) g.text[c + k] = 1;
            c += w;
          }
          grids.set(r, g);
        }
        return g;
      },
    };
  }

  // 한 줄에서 [s, e)를 넘어 글을 더 쓸 수 있는 오른쪽·왼쪽 끝(다른 글자·덮개 앞에 한 칸을 비운다)
  function limits(g, idx, s, e, cols) {
    const busy = (c) => (g.owner[c] !== -1 && g.owner[c] !== idx) || (g.text[c] && g.owner[c] !== idx);
    let r = e;
    while (r < cols && !busy(r)) r++;
    const right = r >= cols ? cols : Math.max(e, r - 1);
    let l = s;
    while (l > 0 && !busy(l - 1)) l--;
    const left = l <= 0 ? 0 : Math.min(s, l + 1);
    return { left, right };
  }

  function layout(segs, L, cols, cursorRow, debug) {
    const grid = makeGrid(L, cols);
    // 커서 줄이 들어간 것, 화면 밖으로 나간 것은 버린다.
    const live = segs.filter((sg) => sg.spans.length
      && sg.spans.every((sp) => sp.row !== cursorRow && sp.row >= 0 && sp.row < L.length && sp.start < cols && sp.end > sp.start));
    // 영어 글 자리를 먼저 맡아 둔다.
    live.forEach((sg, i) => {
      for (const sp of sg.spans) {
        const g = grid.row(sp.row);
        for (let c = sp.start; c < Math.min(sp.end, cols); c++) if (g.owner[c] === -1) g.owner[c] = i;
      }
    });
    const out = [];
    live.forEach((sg, i) => {
      const rowsSorted = sg.spans.map((sp) => sp.row);
      const top = Math.min(...rowsSorted);
      const rows = Math.max(...rowsSorted) - top + 1;
      let col = Math.min(...sg.spans.map((sp) => sp.start));
      let end = Math.min(cols, Math.max(...sg.spans.map((sp) => sp.end)));
      let fit;
      if (rows === 1) {
        // 영어 자리보다 길면 오른쪽(오른쪽 끝에 붙은 줄이면 왼쪽) 빈칸으로 넓힌다. 그래도 모자라면 짧은 글을 쓴다.
        const { left, right } = sg.noExtend ? { left: col, right: end } : limits(grid.row(top), i, col, end, cols);
        const text = [sg.text, ...(sg.alts || [])].find((t) => displayWidth(t) <= right - left) || sg.text;
        const kw = displayWidth(text);
        if (kw > end - col) {
          if (col + kw <= right) end = col + kw;
          else if (right - kw >= left) { end = right; col = right - kw; } else { col = left; end = right; }
        }
        fit = fitText(text, end - col, 1);
      } else {
        fit = fitText(sg.text, end - col, rows);
        if (fit.truncated && !sg.noExtend) {
          let right = cols;
          for (const sp of sg.spans) right = Math.min(right, limits(grid.row(sp.row), i, sp.start, Math.max(sp.end, end), cols).right);
          if (right > end) {
            const wider = fitText(sg.text, right - col, rows);
            if (!wider.truncated) {
              fit = wider;
              end = col + Math.max(end - col, ...wider.lines.map(displayWidth));
            }
          }
        }
      }
      // 맡은 칸 표시(뒤 덮개가 넘보지 않게)
      for (let r = top; r < top + rows; r++) {
        const g = grid.row(r);
        for (let c = col; c < end; c++) g.owner[c] = i;
      }
      const ov = { row: top, col, rows, width: end - col, text: fit.lines.join('\n'), kind: sg.kind };
      if (debug) Object.assign(ov, { rule: sg.rule, vars: sg.vars, truncated: fit.truncated, source: sg.spans });
      out.push(ov);
    });
    // 마지막 확인: 겹치거나 범위를 벗어난 것은 뺀다(약속을 어기느니 영어로 둔다).
    const ok = [];
    for (const ov of out) {
      if (ov.width <= 0 || ov.col < 0 || ov.col + ov.width > cols || ov.row + ov.rows > L.length) continue;
      if (cursorRow >= ov.row && cursorRow < ov.row + ov.rows) continue;
      const clash = ok.some((o) => o.row < ov.row + ov.rows && ov.row < o.row + o.rows && o.col < ov.col + ov.width && ov.col < o.col + o.width);
      if (!clash) ok.push(ov);
    }
    return ok.sort((a, b) => a.row - b.row || a.col - b.col);
  }

  // ── 바깥에 내놓는 함수 ──

  function translateScreen(lines, opts) {
    const o = opts || {};
    if (!Array.isArray(lines) || !lines.length) return [];
    // 줄 끝 공백은 trimEnd로 지운다(정규식 /\s+$/는 줄 가운데 긴 빈칸에서 칸 수의 제곱만큼 걸린다).
    const L = lines.map((l) => String(l == null ? '' : l).replace(/\u00a0/g, ' ').trimEnd());
    const cursorRow = Number.isInteger(o.cursorRow) ? o.cursorRow : -1;
    let cols = Number.isInteger(o.cols) && o.cols > 0 ? o.cols : 0;
    if (!cols) for (const l of L) cols = Math.max(cols, displayWidth(l));
    if (!cols) return [];

    const z = analyze(L);
    const n = L.length;
    const blocked = new Set();
    const footer = [];
    if (z.inputRow >= 0) {
      for (let r = z.inputTop; r <= z.inputBottom; r++) blocked.add(r);
      for (let r = z.inputBottom + 1; r < n; r++) { blocked.add(r); footer.push(r); }
    }
    const free = (r) => !blocked.has(r) && r !== cursorRow;
    const used = new Set();
    const segs = [];
    // 허락 창의 미리보기(╌ 줄 사이: 실행할 명령, 만들 파일 내용, 도구 인자)는 아는 문구가 들어 있어도 덮지 않는다.
    // 위쪽 ╌ 줄이 화면 밖으로 밀려나도 맞게, 아래에서부터 ╌ 줄을 만날 때마다 안팎을 바꾼다.
    if (z.dialogStart >= 0) {
      let inside = false;
      for (let r = n - 1; r >= z.dialogStart; r--) {
        const dash = DASH_RULE.test(L[r]);
        if (dash) inside = !inside;
        if (dash || inside) used.add(r);
      }
    }

    if (z.dialogStart >= 0) dialogSegs(L, z.dialogStart, n, free, segs, used);
    for (let r = 0; r < n; r++) {
      if (used.has(r) || !free(r) || L[r] === '') continue;
      const before = segs.length;
      headerSegs(L, r, segs, used);
      if (segs.length === before) bannerSegs(L, r, (rr) => free(rr) && !used.has(rr), segs, used);
      if (segs.length === before && L[r].length > 10) statusSegs(L, r, segs, used);
    }
    for (const r of footer) footerSegs(L, r, segs, used);
    // 생각 깊이 줄은 입력 칸 바로 위에 따로 올 때도 있다.
    if (z.inputRow >= 2 && !used.has(z.inputTop - 1)) {
      const r = z.inputTop - 1;
      const t = L[r].trim();
      const e = effortRule.re.exec(t);
      if (e) {
        const { text, vars, alts } = applyKo(effortRule, e);
        const col = displayWidth(L[r].slice(0, indentOf(L[r])));
        segs.push(seg(effortRule, text, vars, [{ row: r, start: col, end: col + displayWidth(t) }], alts));
      }
    }
    return layout(segs, L, cols, cursorRow, !!o.debug);
  }

  return Object.freeze({ translateScreen, RULES, displayWidth, charWidth });
}));
