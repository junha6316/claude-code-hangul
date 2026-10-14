// 시험 자료마다 <이름>.expected.json의 mustCover·mustNotCover 줄 번호를 채운다.
//
//   cd app && node test/fixtures/term/make-expected.js
//
// 줄 번호는 아래 COVER·NOT_COVER 표(줄 글로 고른 것)에서 정한다. 번역 함수(termKorean.js)의 결과를 보고 정하지 않는다.
// - COVER: PLAN.md 3판 "범위"의 덮는 것(머리말, 시작 안내 줄, 처음 실행 창, 모드 줄, 허락 창, 자주 보는 오류·상태 줄)
// - NOT_COVER: 덮지 않는 것(사용자가 친 글, Claude의 답, 도구 실행 줄, 파일 내용·명령 출력, 경로, 주소, 서버 이름)
// - 커서 줄은 mustCover에 넣지 않는다(커서 줄은 덮지 않는 것이 약속이다).
// - 두 표에 함께 걸리는 줄이 있으면 멈춘다.
// 자료 목록
// - v2.1.299/*.txt, review/*.txt: 같은 폴더에 <이름>.expected.json이 있다(capture.js가 cols·cursorRow·source를 쓴다).
// - 사용자 화면(user/, 읽기만): user-<이름>.expected.json을 이 폴더에 두고 file로 가리킨다.
// - T6의 2.1.296 캡처(test/fixtures/screens/): t6/<이름>.expected.json이 file로 가리킨다.
'use strict';

const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const SCREENS = path.join(DIR, '..', 'screens');

const COVER = [
  // 머리말
  /Claude Code v\d+\.\d+\.\d+$/,
  /(?:Opus|Haiku|Sonnet) \d[\d.]*(?: \(1M context\))?(?: with \w+ effort)? · (?:Claude \w+|API Usage Billing)$/,
  // 시작 안내 줄
  /^⚠ Your login expires in /,
  /^▎ Message from .+:$/,
  /^⏺ Remote Control is disabled by your organization's policy/,
  /^⚠ Remote managed settings failed to load/,
  /^ {2}(?:details|remote policy applied · \/status for details)$/,
  /^▎ Auto mode is now Claude Code's default permission mode\.$/,
  /^▎ (?:Auto mode lets Claude handle permission prompts automatically\.|prompt injection before executing, runs|each tool call for risky actions|the ones it assesses as lower-risk)/,
  /^⏺ Auto mode lets Claude handle permission prompts automatically —/,
  /^ {2}(?:checks each tool call|executing\. Actions Claude|actions Claude identifies as risky|different approach\. Ideal|slightly more expensive\. Claude|commands to run, it's recommended|environments\. Shift\+Tab)/,
  // 신뢰 창
  /^ Accessing workspace:$/,
  /^ Quick safety check: /,
  /^ (?:own code, a well-known open source|project, or work from your team\)|take a moment to review what's in this folder first\.)/,
  /^ Claude Code'll be able to read, edit, and execute files here\.$/,
  /^ Security guide$/,
  /^ +(?:❯ )?(?:No, exit|Yes, I trust this folder)$/,
  /^ +Enter to confirm · Esc to cancel$/,
  // MCP 창
  /^ +New MCP server found in this project: /,
  /^ +\d+ new MCP servers found in this project$/,
  /^ +Select any you wish to enable\.$/,
  /^ +MCP servers may execute code or access system resources/,
  /^ {2}(?:require approval\. Learn more in the MCP documentation\.|documentation\.)$/,
  /^ +(?:❯ )?(?:Use this MCP server|Use this and all future MCP servers in this project|Continue without using this MCP server)$/,
  /^ +Enable selected$/,
  /^ +Space to select · Esc to reject all$/,
  // 테마
  /^ Let's get started\.$/,
  /^ Choose the text style that looks best with your terminal$/,
  /^ To change this later, run \/theme$/,
  /^ +(?:❯ )?(?:✔ )?(?:Auto \(match terminal\)|(?:Dark|Light) mode(?: \(.+\))?)$/,
  /^ +Syntax theme: .+ \(ctrl\+t to disable\)$/,
  // 로그인
  /^ +Claude Code can be used with your Claude subscription/,
  /^ +usage through your Console account\.$/,
  /^ +Select login method:$/,
  /^ +(?:❯ )?\d\. (?:Claude account with subscription|Anthropic Console account|3rd-party platform) · /,
  /^ {2}Login$/,
  /^ +Esc to cancel$/,
  /^ Browser didn't open\? Use the url below to sign in/,
  /^ Paste code here if prompted >$/,
  // 키 승인
  /^ +Detected a custom API key in your environment$/,
  /^ +Do you want to use this API key\?$/,
  /^ +(?:❯ )?(?:Yes|No \(recommended\))$/,
  // 처음 실행 보안 안내
  /^ Security notes:$/,
  /^ \d\. Claude can make mistakes\.$/,
  /^ {4}You're responsible for Claude's actions/,
  /^ {4}review them, especially when running code\.$/,
  /^ \d\. Due to prompt injection risks/,
  /^ {4}Learn more: https:/,
  /^ Press Enter to continue…$/,
  // 허락 창
  /^ (?:Bash command|Create file|Tool use|Fetch)$/,
  /^ Tip: auto mode handles these prompts for you/,
  /^ Claude wants to fetch content from /,
  /^ About the .+:$/,
  /^ \(ctrl\+o to expand description\)$/,
  /^ Do you want to (?:proceed|create .+|allow Claude to fetch this content)\?$/,
  /^ +(?:❯ )?\d\. (?:Yes|No)$/,
  /^ +(?:❯ )?\d\. (?:Yes, and |No, and tell Claude)/,
  /^ {6}\/Users\/tester\/Projects\/korean-claude-terminal\/review\/korean-input-refute\/work_plain from$/,
  /^ {6}this project$/,
  /^ +Esc to cancel · Tab to amend$/,
  // 오류·상태 줄
  /^ +⎿ {2}(?:Interrupted · What should Claude do instead\?|Not logged in · Please run \/login|Invalid API key · Fix external API key|You've hit your )/,
  /^Usage limit reached/,
  /^Continuing automatically /,
  // 아래 모드 줄
  /^ {2}(?:⏸|⏵⏵) (?:manual mode|accept edits|plan mode|auto mode) on/,
  /^ +◐ medium · \/effort$/,
  /^ +Not logged in · Run \/login$/,
  /^ +\/rc connecting…$/,
];

const NOT_COVER = [
  /^❯/, // 사용자 입력 칸, 대화 기록에 남은 사용자 글
  /^⏺ (?!Remote Control is disabled|Auto mode lets Claude)/, // Claude의 답, 도구 실행 줄
  /^ +⎿ {2}(?:Wrote|User rejected|Waiting|Done|Allowed by|Denied by|PreToolUse|PostToolUse|connect ECONNREFUSED|Stop hook|"hello"|\$ touch|Received)/,
  /^ {2}(?:Called|Calling) Notion/,
  /^ {4,6}\d (?:hello|kay|ell|eye|jay|eee|cee|dee)$/, // 파일 내용
  /^ {2}\d (?:hello|kay|ell)$/,
  /^ +\d +(?:[-+] +)?(?:function greet|console\.log|\})/, // 테마 창의 코드 예
  /^[✻✽] /, // 일한 시간 줄
  /^ +(?:[▐▛▜▝▘▗▟▄▂█~]+ +)*~\//, // 머리말 경로
  /^ \/Users\/|^ (?:ted-80\/work)$/, // 신뢰 창 경로
  /^ {2}ANTHROPIC_API_KEY: /,
  /^https:\/\/|^[A-Za-z0-9%_&=.+-]{40,}$/, // 로그인 주소
  /^ (?:touch [a-z_]+\.txt|Create empty file|Create probe file|query: |url: |prompt: |Notion — Notion-Search Tool: \(MCP\)|[a-z]\.txt)$/,
  /^ (?:query|url|prompt): /,
  /^ │ /, // 도구 설명(외부 글)
  /^▎ (?:안녕하세요|https:)/,
  /\[✔\] [a-z-]+$/, // 서버 이름 고르기 줄
  /^ +(?:❯ )?\/[a-z-]+ {3,}\S/, // / 명령 메뉴
  /^ +(?:[!/@] for |\/btw for )|double tap esc|ctrl \+ |shift \+ |opt \+ p|\/keybindings to customize/, // ? 단축키 도움말
  /^ {3}(?:Help {2}General|Claude understands your codebase|terminal\.$|Shortcuts$|For more help: )/, // /help 화면
];

// Claude의 답 묶음: "⏺ …"(시작 안내 줄은 빼고)부터 빈 줄·가로줄·다음 ❯ ⏺ ✻ 줄 전까지. 답 안에 화면 문구를 그대로 옮겨 적어도 덮지 않는다.
// 도구 실행 줄 아래의 오류·상태 줄(중단됨 등)은 답이 아니라 claude가 붙인 줄이라 덮는다.
const BANNER_DOT = /^⏺ (?:Remote Control is disabled|Auto mode lets Claude)/;
const STATUS_IN_ANSWER = /^ +⎿ {2}(?:Interrupted · |Not logged in · |Invalid API key · |You've hit your )/;
function answerRows(lines) {
  const rows = new Set();
  for (let i = 0; i < lines.length; i++) {
    if (!/^⏺ /.test(lines[i]) || BANNER_DOT.test(lines[i])) continue;
    for (let j = i; j < lines.length && lines[j].trim() !== '' && !/^\s*─{8,}\s*$/.test(lines[j]) && (j === i || !/^[❯⏺✻]/.test(lines[j])); j++) {
      if (!STATUS_IN_ANSWER.test(lines[j])) rows.add(j);
    }
  }
  return rows;
}

function classify(raw, file) {
  const lines = raw.map((l) => l.replace(/\u00a0/g, ' ')); // 화면의 NBSP는 띄어쓰기로 본다(번역 함수도 같게 읽는다)
  const mustCover = [];
  const mustNotCover = [];
  const answer = answerRows(lines);
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    const c = !answer.has(i) && COVER.some((re) => re.test(line));
    const n = answer.has(i) || NOT_COVER.some((re) => re.test(line));
    if (c && n) throw new Error(`${file}:${i} 두 표에 함께 걸립니다: ${line}`);
    if (c) mustCover.push(i);
    if (n) mustNotCover.push(i);
  });
  return { mustCover, mustNotCover };
}

const readLines = (file) => fs.readFileSync(file, 'utf8').replace(/\n$/, '').split('\n');

function update(expPath, screenPath, base) {
  const exp = { ...base, ...(fs.existsSync(expPath) ? JSON.parse(fs.readFileSync(expPath, 'utf8')) : {}) };
  const lines = readLines(screenPath);
  const { mustCover, mustNotCover } = classify(lines, path.relative(DIR, screenPath));
  exp.mustCover = mustCover.filter((r) => r !== exp.cursorRow);
  exp.mustNotCover = mustNotCover;
  const ordered = { ...(exp.file ? { file: exp.file } : {}), cols: exp.cols, cursorRow: exp.cursorRow, mustCover: exp.mustCover, mustNotCover: exp.mustNotCover, source: exp.source };
  for (const k of Object.keys(exp)) if (!(k in ordered)) ordered[k] = exp[k];
  fs.writeFileSync(expPath, `${JSON.stringify(ordered, null, 2)}\n`);
  return ordered;
}

// 사용자 화면: 붙여 넣은 글이라 커서 위치를 모른다(-1). 폭은 줄 접힘으로 짐작한다(README 참고).
const USER = [
  ['01-trust', 82, '사용자가 실제 계정(Team, claude 2.1.299)으로 앱을 띄워 붙여 넣은 신뢰 창. 80칸 언저리에서 접힘'],
  ['02-mcp-new-server', 82, '사용자가 붙여 넣은 새 MCP 서버 창(~/.mcp.json의 bigquery)'],
  ['03-header-team', 120, '사용자가 붙여 넣은 머리말·로그인 만료·회사 안내·조직 정책 줄(앞의 로고 글자는 붙여 넣을 때 빠짐)'],
];

// T6 캡처(claude 2.1.296): 화면 폭은 가로줄 길이, 커서 위치는 기록되지 않아 -1
const T6 = {
  'theme.txt': 120, 'login-method.txt': 120, 'login-browser.txt': 120, 'api-key.txt': 120, 'press-enter.txt': 120,
  'trust.txt': 120, 'trust-80cols.txt': 80, 'idle.txt': 120, 'auth-error.txt': 120, 'auth-logged-out-idle.txt': 120,
  'auth-logged-out.txt': 120, 'login-method-slash.txt': 120, 'permission-write.txt': 140, 'permission-bash.txt': 140,
  'idle-after-work.txt': 140, 'idle-hook-errors.txt': 140, 'usage-limit.synthetic.txt': 120,
  'usage-limit-waiting.synthetic.txt': 120, 'stale-auth-error.synthetic.txt': 120, 'assistant-quotes.synthetic.txt': 120,
  'other-claude-help.txt': 120, 'other-ls-root.txt': 100,
};

function main() {
  const done = [];
  for (const sub of ['v2.1.299', 'review']) {
    const d = path.join(DIR, sub);
    for (const f of fs.readdirSync(d).filter((x) => x.endsWith('.txt')).sort()) {
      const exp = update(path.join(d, f.replace(/\.txt$/, '.expected.json')), path.join(d, f), {});
      done.push([`${sub}/${f}`, exp]);
    }
  }
  for (const [name, cols, note] of USER) {
    const file = `user/${name}.txt`;
    const exp = update(path.join(DIR, `user-${name}.expected.json`), path.join(DIR, file),
      { file, cols, cursorRow: -1, source: `${file} (${note}). 붙여 넣은 글이라 커서 위치를 모름` });
    done.push([file, exp]);
  }
  const t6dir = path.join(DIR, 't6');
  fs.mkdirSync(t6dir, { recursive: true });
  for (const [f, cols] of Object.entries(T6)) {
    const name = f.replace(/\.txt$/, '');
    const exp = update(path.join(t6dir, `${name}.expected.json`), path.join(SCREENS, f),
      { file: `../../screens/${f}`, cols, cursorRow: -1, source: `test/fixtures/screens/${f} (T6 캡처, claude 2.1.296. 만든 방법은 그 폴더의 manifest.json). 커서 위치는 기록되지 않아 -1` });
    done.push([`screens/${f}`, exp]);
  }
  for (const [f, e] of done) console.log(`${f.padEnd(48)} 덮을 줄 ${String(e.mustCover.length).padStart(2)}  덮지 않을 줄 ${String(e.mustNotCover.length).padStart(2)}  커서 ${e.cursorRow}`);
}

main();
