'use strict';

// 훅·상태 줄 입력(JSON)을 화면에 보일 짧은 한국어로 바꾼다.
// 입력 형식 근거
// - 도구별 tool_input: review/tech-stack-deploy/docs/hooks.md "PreToolUse input"
//   (Bash·PowerShell·Write·Edit·Read·Glob·Grep·WebFetch·WebSearch·Agent)
// - NotebookEdit·TodoWrite·Agent(옛 이름 Task): https://code.claude.com/docs/en/agent-sdk/typescript "Tool Input Types"
// - PostToolUse·PostToolUseFailure·Notification·Stop 입력: hooks.md의 같은 이름 절
// - 상태 줄 입력: https://code.claude.com/docs/en/statusline "Available data"
// 출력에는 절대 경로, 모델 이름, 비용, 토큰 수를 넣지 않는다. Bash 설명(description)은
// 한글이 들어 있을 때만 쓴다. 영어 설명은 이 앱 사용자가 읽지 못하므로 명령을 대신 보인다.

const os = require('node:os');

const DEFAULT_FOLDER = '작업실';
const STATUS_MAX_WIDTH = 40;
const NEW_CHAT_PERCENT = 80;
const SHORT_TEXT = 60;
const LONG_TEXT = 200;

// ── 글자 폭: 한글·한자·이모지는 2칸 ──

function charWidth(cp) {
  if (cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0x0300 && cp <= 0x036f)) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

function textWidth(s) {
  let w = 0;
  for (const ch of s) w += charWidth(ch.codePointAt(0));
  return w;
}

function fitWidth(s, max) {
  if (textWidth(s) <= max) return s;
  let out = '';
  let w = 0;
  for (const ch of s) {
    const cw = charWidth(ch.codePointAt(0));
    if (w + cw + 1 > max) break;
    out += ch;
    w += cw;
  }
  return `${out}…`;
}

// ── 글 다듬기 ──

const HANGUL = /[가-힣]/;

// 디스크에 분해형(NFD)으로 저장된 한글 폴더 이름은 claude의 cwd·경로에도 NFD로 온다.
// 조합형(NFC)인 작업 폴더와 비교하고 한글로 알아보고 터미널에 보이려면 먼저 NFC로 맞춘다.
function str(v) {
  return typeof v === 'string' ? v.normalize('NFC') : '';
}

function obj(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

// 첫 줄만 남기고 max 글자로 자른다. 터미널 제어 문자는 뺀다.
function clip(s, max) {
  // eslint-disable-next-line no-control-regex
  const lines = str(s).replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').trim().split(/\r?\n/);
  const line = lines[0].trim();
  const chars = Array.from(line);
  if (chars.length > max) return `${chars.slice(0, max - 1).join('')}…`;
  return lines.length > 1 ? `${line} …` : line;
}

function koreanOnly(s) {
  return HANGUL.test(str(s)) ? str(s) : '';
}

function withWhat(text, what) {
  return what ? `${text}: ${what}` : text;
}

// ── 경로 ──

function splitPath(p) {
  return str(p).split(/[\\/]+/).filter(Boolean);
}

function isWindowsAbs(p) {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\');
}

function isAbs(p) {
  return p.startsWith('/') || isWindowsAbs(p);
}

const HOME_SEGS = (() => {
  try {
    return splitPath(os.homedir());
  } catch {
    return [];
  }
})();

function sameSegs(prefix, segs, win) {
  if (prefix.length > segs.length) return false;
  return prefix.every((s, i) => (win ? s.toLowerCase() === segs[i].toLowerCase() : s === segs[i]));
}

// 절대 경로가 홈 폴더 안이면 홈 폴더까지의 조각 수를, 아니면 0을 돌려준다.
function homeDepth(p) {
  if (!isAbs(p)) return 0;
  const segs = splitPath(p);
  const win = isWindowsAbs(p);
  if (HOME_SEGS.length > 1 && sameSegs(HOME_SEGS, segs, win)) return HOME_SEGS.length;
  if (win) return segs.length >= 3 && /^users$/i.test(segs[1]) ? 3 : 0;
  if ((segs[0] === 'Users' || segs[0] === 'home') && segs.length >= 2) return 2;
  if (segs[0] === 'root') return 1;
  return 0;
}

// 파일·폴더 이름만. 홈 폴더 자체는 '내 폴더'.
function baseName(p) {
  const segs = splitPath(p);
  if (!segs.length) return '';
  const hd = homeDepth(str(p));
  if (hd && hd === segs.length) return '내 폴더';
  return clip(segs[segs.length - 1], SHORT_TEXT);
}

// 파일이 든 폴더를 '작업실 폴더', '내 폴더'처럼 부른다. 알 수 없으면 ''.
function parentLabel(p) {
  const segs = splitPath(p);
  if (segs.length < 2) return '';
  const hd = homeDepth(str(p));
  if (hd && hd === segs.length - 1) return '내 폴더';
  const name = segs[segs.length - 2];
  if (/^[A-Za-z]:$/.test(name)) return '';
  return `${clip(name, SHORT_TEXT)} 폴더`;
}

function outsideFolder(p, folder) {
  const file = str(p);
  const dir = str(folder);
  if (!isAbs(file) || !isAbs(dir)) return false;
  const dirSegs = splitPath(dir);
  const fileSegs = splitPath(file);
  return !(dirSegs.length < fileSegs.length && sameSegs(dirSegs, fileSegs, isWindowsAbs(file)));
}

// 명령 속 절대 경로를 '~/…/폴더/파일'처럼 줄인다.
function shortPathToken(p) {
  const win = isWindowsAbs(p);
  const sep = win ? '\\' : '/';
  const segs = splitPath(p);
  const hd = homeDepth(p);
  if (hd) {
    const rest = segs.slice(hd);
    return (rest.length <= 2 ? ['~', ...rest] : ['~', '…', ...rest.slice(-2)]).join(sep);
  }
  const rest = win ? segs.slice(1) : segs;
  if (win && rest.length === 0) return segs[0] || '…';
  if (!win && rest.length <= 2) return `/${rest.join('/')}`;
  return ['…', ...rest.slice(-2)].join(sep);
}

const POSIX_PATH = /(^|[\s'"=(,:<>])(\/(?!\/)[^\s'"`;|&<>(),]*)/g;
const WINDOWS_PATH = /(^|[\s'"=(,:<>])([A-Za-z]:[\\/][^\s'"`;|&<>(),]*)/g;

function shortenPaths(text) {
  return str(text)
    .replace(POSIX_PATH, (_, pre, p) => pre + shortPathToken(p))
    .replace(WINDOWS_PATH, (_, pre, p) => pre + shortPathToken(p));
}

// 마지막 안전망: 어떤 출력에도 사용자 폴더 경로나 드라이브 경로가 남지 않게 한다.
function scrub(s) {
  return str(s)
    .replace(/\/(?:Users|home)\/[^/\s'"`]+/g, '~')
    .replace(/[A-Za-z]:\\+/g, '…\\');
}

function site(url) {
  const u = str(url).trim();
  try {
    return new URL(u).hostname.replace(/^www\./, '') || '인터넷';
  } catch {
    const host = u.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[/?#\s]/)[0];
    return clip(host.replace(/^www\./, ''), SHORT_TEXT) || '인터넷';
  }
}

// ── 위험한 명령 ──

const WHY_ADMIN = '관리자 권한으로 실행해요. 컴퓨터 설정까지 바꿀 수 있어요.';
const WHY_DELETE = '폴더째 지우거나 묻지 않고 지워요. 지운 것은 되돌릴 수 없어요.';
const WHY_DOWNLOAD_RUN = '인터넷에서 받은 것을 확인하지 않고 바로 실행해요.';

const DANGER_RULES = [
  { re: /(^|[\s;&|(`])(sudo|doas)(\s|$)/, why: WHY_ADMIN },
  { re: /-Verb\s+RunAs\b/i, why: WHY_ADMIN },
  {
    re: /(^|[\s;&|(`])rm\s+(?:[^;&|\n]*\s)?(?:-[a-zA-Z]*[rRf][a-zA-Z]*|--recursive|--force)(?=\s|$)/,
    why: WHY_DELETE,
  },
  { re: /\b(?:Remove-Item|ri|rmdir|rd|del|erase)\b[^;|\n]*\s-(?:Recurse|Force)\b/i, why: WHY_DELETE },
  {
    re: /\b(?:curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^;\n]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|dash|ksh|fish|python[0-9.]*|node|perl|ruby|iex|Invoke-Expression)\b/i,
    why: WHY_DOWNLOAD_RUN,
  },
  { re: /\b(?:sh|bash|zsh)\b[^;\n]*(?:<\(|\$\(|`)\s*(?:curl|wget)\b/, why: WHY_DOWNLOAD_RUN },
  {
    re: /\b(?:iex|Invoke-Expression)\b[^;\n]*\b(?:irm|iwr|Invoke-WebRequest|Invoke-RestMethod|DownloadString)\b/i,
    why: WHY_DOWNLOAD_RUN,
  },
  {
    re: /\bgit\b[^;&|\n]*\bpush\b[^;&|\n]*(?:--force|\s-[a-zA-Z]*f[a-zA-Z]*(?=\s|$)|\s\+\S)/,
    why: '온라인 저장소의 기록을 덮어써요. 다른 사람의 작업이 사라질 수 있어요.',
  },
  { re: /\bgit\b[^;&|\n]*\breset\b[^;&|\n]*--hard\b/, why: '저장하지 않은 변경 내용을 지워요. 되돌릴 수 없어요.' },
  {
    re: /\bgit\b[^;&|\n]*\bclean\b[^;&|\n]*(?:\s-[a-zA-Z]*f|--force)/,
    why: '기록되지 않은 파일을 지워요. 되돌릴 수 없어요.',
  },
  {
    re: /(^|[\s;&|(])(?:mkfs(?:\.\w+)?|diskutil\s+(?:erase\w*|zeroDisk|randomDisk|secureErase))\b|\bdd\b[^;&|\n]*\bof=\/dev\/|\b(?:Format-Volume|Clear-Disk)\b/i,
    why: '디스크 전체를 지우거나 덮어쓸 수 있어요.',
  },
];

function dangerReasons(command) {
  const cmd = str(command);
  const reasons = [];
  for (const { re, why } of DANGER_RULES) {
    if (re.test(cmd) && !reasons.includes(why)) reasons.push(why);
  }
  return reasons;
}

// ── 도구별 문구 ──
// 각 항목: icon, start(c), end(c), noun(c)(실패 문구용), perm(c) → { title, detail }

function filePath(c) {
  return str(c.input.file_path) || str(c.input.notebook_path);
}

function fileName(c) {
  return baseName(filePath(c)) || '이름 모를';
}

// '작업실 폴더에 있는 ' 또는 ''
function placeIn(c, suffix) {
  const label = parentLabel(filePath(c));
  return label ? `${label}${suffix}` : '';
}

function outsideNote(c) {
  return outsideFolder(filePath(c), c.cwd) ? '\n작업 폴더 밖에 있는 파일이에요.' : '';
}

function shellWhat(c, max) {
  const desc = koreanOnly(c.input.description);
  return clip(shortenPaths(desc || c.input.command), max);
}

function todoCount(c) {
  const todos = Array.isArray(c.input.todos) ? c.input.todos : [];
  if (!todos.length) return '';
  const done = todos.filter((t) => t && t.status === 'completed').length;
  return ` (${todos.length}개 중 ${done}개 끝)`;
}

function agentWhat(c) {
  return clip(shortenPaths(koreanOnly(c.input.description)), SHORT_TEXT);
}

function searchPlace(c) {
  const where = baseName(c.input.path);
  return where ? `\n찾을 곳: ${where}` : '';
}

const SHELL = {
  icon: '⚙️',
  start: (c) => withWhat('명령을 실행하고 있어요', shellWhat(c, SHORT_TEXT)),
  end: (c) =>
    c.response.interrupted === true
      ? withWhat('명령이 중간에 멈췄어요', shellWhat(c, SHORT_TEXT))
      : withWhat('명령을 마쳤어요', shellWhat(c, SHORT_TEXT)),
  failed: (c) => c.response.interrupted === true,
  noun: (c) => withWhat('명령 실행에 실패했어요', shellWhat(c, SHORT_TEXT)),
  perm: (c) => {
    const desc = clip(shortenPaths(koreanOnly(c.input.description)), LONG_TEXT);
    const cmd = clip(shortenPaths(c.input.command), LONG_TEXT);
    const lines = [desc ? `할 일: ${desc}` : '아래 명령을 컴퓨터에서 실행해요.', `실행할 명령: ${cmd || '(비어 있어요)'}`];
    for (const why of dangerReasons(c.input.command)) lines.push(`⚠️ ${why}`);
    return { title: '이 명령을 실행해도 될까요?', detail: lines.join('\n') };
  },
};

const AGENT = {
  icon: '🤝',
  start: (c) => withWhat('도우미에게 일을 맡기고 있어요', agentWhat(c)),
  end: (c) =>
    c.response.status === 'async_launched'
      ? withWhat('도우미가 뒤에서 일을 시작했어요', agentWhat(c))
      : withWhat('도우미가 일을 마쳤어요', agentWhat(c)),
  noun: (c) => withWhat('도우미에게 맡긴 일이 잘 안 됐어요', agentWhat(c)),
  perm: (c) => ({
    title: '도우미에게 맡겨도 될까요?',
    detail: agentWhat(c) ? `맡길 일: ${agentWhat(c)}` : '다른 도우미가 이 일을 나눠 맡아요.',
  }),
};

const TASK_LIST = {
  icon: '📋',
  start: () => '할 일 목록을 정리하고 있어요',
  end: () => '할 일 목록을 정리했어요',
  noun: () => '할 일 목록 정리에 실패했어요',
  perm: () => ({ title: '할 일 목록을 고쳐도 될까요?', detail: '할 일 목록에 적어 둔 내용을 바꿔요.' }),
};

const NOTEBOOK_MODE = { insert: '칸을 하나 더해요', delete: '칸을 하나 지워요' };

const TOOLS = {
  Read: {
    icon: '📖',
    start: (c) => `${fileName(c)} 파일을 읽고 있어요`,
    end: (c) => `${fileName(c)} 파일을 읽었어요`,
    noun: (c) => `${fileName(c)} 파일 읽기에 실패했어요`,
    perm: (c) => ({
      title: '파일을 읽어도 될까요?',
      detail: `${placeIn(c, '에 있는 ')}${fileName(c)} 파일의 내용을 읽어요.${outsideNote(c)}`,
    }),
  },
  Write: {
    icon: '📝',
    start: (c) => `${fileName(c)} 파일을 저장하고 있어요`,
    end: (c) =>
      c.response.type === 'update'
        ? `${fileName(c)} 파일을 새 내용으로 바꿨어요`
        : `${fileName(c)} 파일을 만들었어요`,
    noun: (c) => `${fileName(c)} 파일 저장에 실패했어요`,
    perm: (c) => ({
      title: '파일을 만들어도 될까요?',
      detail:
        `${placeIn(c, '에 ')}${fileName(c)} 파일을 만들어요. 같은 이름의 파일이 있으면 새 내용으로 바꿔요.` +
        outsideNote(c),
    }),
  },
  Edit: {
    icon: '✏️',
    start: (c) => `${fileName(c)} 파일을 고치고 있어요`,
    end: (c) => `${fileName(c)} 파일을 고쳤어요`,
    noun: (c) => `${fileName(c)} 파일 고치기에 실패했어요`,
    perm: (c) => ({
      title: '파일을 고쳐도 될까요?',
      detail:
        `${placeIn(c, '에 있는 ')}${fileName(c)} 파일에서 ` +
        (c.input.replace_all === true ? '같은 내용을 모두 바꿔요.' : '내용 한 곳을 바꿔요.') +
        outsideNote(c),
    }),
  },
  MultiEdit: {
    icon: '✏️',
    start: (c) => `${fileName(c)} 파일 여러 곳을 고치고 있어요`,
    end: (c) => `${fileName(c)} 파일 여러 곳을 고쳤어요`,
    noun: (c) => `${fileName(c)} 파일 고치기에 실패했어요`,
    perm: (c) => {
      const n = Array.isArray(c.input.edits) ? c.input.edits.length : 0;
      return {
        title: '파일을 고쳐도 될까요?',
        detail: `${placeIn(c, '에 있는 ')}${fileName(c)} 파일에서 ${n > 0 ? `${n}군데를` : '여러 곳을'} 바꿔요.${outsideNote(c)}`,
      };
    },
  },
  NotebookEdit: {
    icon: '📓',
    start: (c) => `${fileName(c)} 노트 파일을 고치고 있어요`,
    end: (c) => `${fileName(c)} 노트 파일을 고쳤어요`,
    noun: (c) => `${fileName(c)} 노트 파일 고치기에 실패했어요`,
    perm: (c) => ({
      title: '노트 파일을 고쳐도 될까요?',
      detail:
        `${placeIn(c, '에 있는 ')}${fileName(c)} 노트 파일에서 ` +
        `${NOTEBOOK_MODE[c.input.edit_mode] || '칸 하나의 내용을 바꿔요'}.${outsideNote(c)}`,
    }),
  },
  Bash: SHELL,
  PowerShell: SHELL,
  Glob: {
    icon: '🔎',
    start: (c) => withWhat('파일 이름으로 찾고 있어요', clip(c.input.pattern, SHORT_TEXT)),
    end: (c) => withWhat('파일 찾기를 마쳤어요', clip(c.input.pattern, SHORT_TEXT)),
    noun: () => '파일 찾기에 실패했어요',
    perm: (c) => ({
      title: '파일을 찾아봐도 될까요?',
      detail: `이름이 맞는 파일을 찾아요.\n찾을 이름: ${clip(c.input.pattern, LONG_TEXT)}${searchPlace(c)}`,
    }),
  },
  Grep: {
    icon: '🔎',
    start: (c) => withWhat('파일 내용에서 찾고 있어요', clip(c.input.pattern, SHORT_TEXT)),
    end: (c) => withWhat('내용 찾기를 마쳤어요', clip(c.input.pattern, SHORT_TEXT)),
    noun: () => '내용 찾기에 실패했어요',
    perm: (c) => ({
      title: '파일 내용을 찾아봐도 될까요?',
      detail: `파일 안에서 글을 찾아요.\n찾을 말: ${clip(c.input.pattern, LONG_TEXT)}${searchPlace(c)}`,
    }),
  },
  WebFetch: {
    icon: '🌐',
    start: (c) => `${site(c.input.url)} 사이트를 읽고 있어요`,
    end: (c) => `${site(c.input.url)} 사이트를 읽었어요`,
    noun: (c) => `${site(c.input.url)} 사이트 읽기에 실패했어요`,
    perm: (c) => ({
      title: '이 사이트를 열어 봐도 될까요?',
      detail: `${site(c.input.url)} 사이트의 내용을 읽어 와요.`,
    }),
  },
  WebSearch: {
    icon: '🌐',
    start: (c) => withWhat('인터넷에서 찾고 있어요', clip(c.input.query, SHORT_TEXT)),
    end: (c) => withWhat('인터넷 검색을 마쳤어요', clip(c.input.query, SHORT_TEXT)),
    noun: () => '인터넷 검색에 실패했어요',
    perm: (c) => ({
      title: '인터넷에서 찾아봐도 될까요?',
      detail: `찾을 말: ${clip(c.input.query, LONG_TEXT)}`,
    }),
  },
  Agent: AGENT,
  Task: AGENT,
  TodoWrite: {
    icon: '📋',
    start: (c) => `할 일 목록을 정리하고 있어요${todoCount(c)}`,
    end: (c) => `할 일 목록을 정리했어요${todoCount(c)}`,
    noun: () => '할 일 목록 정리에 실패했어요',
    perm: (c) => ({ title: '할 일 목록을 고쳐도 될까요?', detail: `할 일 목록을 새로 적어요.${todoCount(c)}` }),
  },
  TaskCreate: TASK_LIST,
  TaskUpdate: TASK_LIST,
  TaskList: TASK_LIST,
  TaskGet: TASK_LIST,
  Skill: {
    icon: '🧩',
    start: (c) => `${clip(c.input.skill, SHORT_TEXT) || '준비된'} 기능을 불러오고 있어요`,
    end: (c) => `${clip(c.input.skill, SHORT_TEXT) || '준비된'} 기능을 불러왔어요`,
    noun: (c) => `${clip(c.input.skill, SHORT_TEXT) || '준비된'} 기능 불러오기에 실패했어요`,
    perm: (c) => ({
      title: '이 기능을 써도 될까요?',
      detail: `미리 준비된 ${clip(c.input.skill, SHORT_TEXT) || '이름 모를'} 기능을 불러와 써요.`,
    }),
  },
  AskUserQuestion: {
    icon: '❓',
    start: () => '물어볼 것이 있어요. 터미널에서 답을 골라 주세요',
    end: () => '질문에 답을 받았어요',
    noun: () => '질문하기에 실패했어요',
    perm: () => ({ title: '질문해도 될까요?', detail: '터미널에 질문과 고를 답을 보여 줘요.' }),
  },
  ExitPlanMode: {
    icon: '🗺️',
    start: () => '계획을 다 세웠어요. 터미널에서 읽어 봐 주세요',
    end: () => '계획대로 일을 시작해요',
    noun: () => '계획 보여 주기에 실패했어요',
    perm: () => ({
      title: '계획대로 시작할까요?',
      detail: '세운 계획을 터미널에 보여 드렸어요. 허락하면 계획대로 일을 시작해요.',
    }),
  },
};

const MCP = {
  icon: '🔌',
  start: (c) => `${c.server} 서비스의 ${c.tool} 기능을 쓰고 있어요`,
  end: (c) => `${c.server} 서비스의 ${c.tool} 기능을 썼어요`,
  noun: (c) => `${c.server} 서비스 사용에 실패했어요`,
  perm: (c) => ({ title: '연결된 서비스를 써도 될까요?', detail: `${c.server} 서비스의 ${c.tool} 기능을 써요.` }),
};

const UNKNOWN = {
  icon: '🔧',
  start: (c) => `${c.label} 도구를 쓰고 있어요`,
  end: (c) => `${c.label} 도구를 다 썼어요`,
  noun: (c) => `${c.label} 도구 사용에 실패했어요`,
  perm: (c) => ({ title: '이 도구를 써도 될까요?', detail: `${c.label} 도구를 써요.` }),
};

function toolOf(body) {
  const b = obj(body);
  const name = str(b.tool_name);
  const c = {
    name,
    input: obj(b.tool_input),
    response: obj(b.tool_response),
    cwd: str(b.cwd),
    event: str(b.hook_event_name),
    label: clip(name, SHORT_TEXT) || '이름 모를',
  };
  if (Object.prototype.hasOwnProperty.call(TOOLS, name)) return { entry: TOOLS[name], c };
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp) {
    c.server = clip(mcp[1], SHORT_TEXT);
    c.tool = clip(mcp[2], SHORT_TEXT);
    return { entry: MCP, c };
  }
  return { entry: UNKNOWN, c };
}

// ── 내보내는 함수 ──

function describeToolStart(body) {
  try {
    const { entry, c } = toolOf(body);
    return { icon: entry.icon, text: scrub(entry.start(c)) };
  } catch {
    return { icon: '🔧', text: '도구를 쓰고 있어요' };
  }
}

function describeToolEnd(body) {
  try {
    const { entry, c } = toolOf(body);
    if (c.event === 'PostToolUseFailure') return { icon: '⚠️', text: scrub(entry.noun(c)), ok: false };
    if (entry.failed && entry.failed(c)) return { icon: '⚠️', text: scrub(entry.end(c)), ok: false };
    return { icon: '✅', text: scrub(entry.end(c)), ok: true };
  } catch {
    return { icon: '✅', text: '도구를 다 썼어요', ok: true };
  }
}

function describePermission(body) {
  try {
    const { entry, c } = toolOf(body);
    const { title, detail } = entry.perm(c);
    const danger = entry === SHELL && dangerReasons(c.input.command).length > 0;
    return { title: scrub(title), detail: scrub(detail), danger };
  } catch {
    return { title: '허락이 필요해요', detail: '터미널 화면에서 무엇을 하려는지 확인해 주세요.', danger: false };
  }
}

const NOTIFICATIONS = {
  permission_prompt: ['🙋', '허락을 기다리고 있어요'],
  idle_prompt: ['💬', '다음 할 일을 기다리고 있어요'],
  auth_success: ['🔑', '로그인을 마쳤어요'],
  elicitation_dialog: ['❓', '연결된 서비스가 답을 기다려요. 터미널을 봐 주세요'],
  elicitation_url_dialog: ['🌐', '연결된 서비스가 웹 페이지를 열어 달라고 해요. 터미널을 봐 주세요'],
  agent_needs_input: ['❓', '도우미가 답을 기다려요. 터미널을 봐 주세요'],
  quota_auto_resume_fired: ['🔄', '사용 한도가 풀려서 하던 일을 이어서 해요'],
  quota_auto_resume_stale: ['⏸️', '사용 한도가 풀렸어요. 터미널에서 엔터 키를 누르면 이어서 해요'],
  quota_auto_resume_disabled: ['⏸️', '사용 한도 때문에 하던 일을 멈췄어요'],
};

function describeNotification(body) {
  try {
    const type = str(obj(body).notification_type);
    if (!Object.prototype.hasOwnProperty.call(NOTIFICATIONS, type)) return null;
    const [icon, text] = NOTIFICATIONS[type];
    return { icon, text };
  } catch {
    return null;
  }
}

function describeStop(body) {
  try {
    const tasks = obj(body).background_tasks;
    const n = Array.isArray(tasks) ? tasks.length : 0;
    if (n > 0) return { icon: '⏳', text: `답을 마쳤어요. 뒤에서 하는 일 ${n}개는 아직 돌아가요` };
    return { icon: '✅', text: '답을 마쳤어요. 다음 할 일을 적어 주세요' };
  } catch {
    return { icon: '✅', text: '답을 마쳤어요' };
  }
}

// 상태 줄 입력에서 폴더 이름과 대화 길이(%)만 꺼낸다. 대화 길이를 모르면 contextPercent는 null.
function statusParts(statusJson) {
  let s = statusJson;
  if (typeof s === 'string') {
    try {
      s = JSON.parse(s);
    } catch {
      s = null;
    }
  }
  s = obj(s);
  const ws = obj(s.workspace);
  const dir = str(ws.current_dir) || str(s.cwd) || str(ws.project_dir);
  const folderName = baseName(dir) || DEFAULT_FOLDER;
  const raw = obj(s.context_window).used_percentage;
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  const contextPercent = Number.isFinite(n) ? Math.max(0, Math.min(100, Math.floor(n))) : null;
  return { folderName, contextPercent };
}

function formatStatusLine(statusJson) {
  try {
    const { folderName, contextPercent } = statusParts(statusJson);
    let tail = '';
    if (contextPercent !== null) {
      tail = ` · 대화 길이 ${contextPercent}%`;
      if (contextPercent >= NEW_CHAT_PERCENT) tail += ' · 새 대화를 권해요';
    }
    const head = '📁 ';
    const room = STATUS_MAX_WIDTH - textWidth(head) - textWidth(tail);
    return head + fitWidth(folderName, room) + tail;
  } catch {
    return `📁 ${DEFAULT_FOLDER}`;
  }
}

module.exports = {
  describeToolStart,
  describeToolEnd,
  describePermission,
  describeNotification,
  describeStop,
  formatStatusLine,
  statusParts,
};
