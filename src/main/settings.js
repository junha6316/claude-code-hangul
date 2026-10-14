// claude에 --settings로 넣을 한국어 설정을 만든다(T3).
// 사용자 설정 파일(~/.claude/settings.json)은 건드리지 않고, 이 파일만 이번 실행에 더한다.
//
// 근거 문서
//   설정 키: https://code.claude.com/docs/en/settings-reference
//            (사본: review/tech-stack-deploy/docs/settings-reference.md)
//   훅 형식: https://code.claude.com/docs/en/hooks (사본: review/tech-stack-deploy/docs/hooks.md)
//   상태 줄: https://code.claude.com/docs/en/statusline
//   --settings: https://code.claude.com/docs/en/cli-reference (사본: review/tech-stack-deploy/docs/cli-reference.md)
// 도움말(spinnerTipsOverride.tips) 하나하나의 근거는 test/settings.test.js의 TIP_EVIDENCE 표에 있다.
//
// 넣지 않는 것: DISABLE_AUTOUPDATER, DISABLE_UPDATES, apiKeyHelper, env(인증 변수 포함).
const fs = require('fs');
const path = require('path');

const SETTINGS_FILE_NAME = 'kct-settings.json';
const FALLBACK_STATUS = '작업실';

// 일하는 중 문구. 화면에는 "생각하는 중…"처럼 보인다.
const SPINNER_VERBS = [
  '생각하는 중',
  '살펴보는 중',
  '찾아보는 중',
  '읽어 보는 중',
  '정리하는 중',
  '만드는 중',
  '고치는 중',
  '다듬는 중',
  '확인하는 중',
  '준비하는 중',
];

// 초보자 도움말. 공식 문서에서 확인한 동작만 쓴다. id는 보여 준 기록을 이어 가는 열쇠다.
const SPINNER_TIPS = [
  { id: 'kct-stop-esc', text: 'Esc 키를 누르면 하던 일을 멈춰요. 한 일은 남아 있어요.' },
  { id: 'kct-queue-message', text: '일하는 중에도 할 말을 적어 Enter를 누르면 기다렸다가 전해져요.' },
  { id: 'kct-newline', text: '줄을 바꾸려면 Ctrl+J를 눌러요. Enter는 보내기예요.' },
  { id: 'kct-history-up', text: '↑ 키를 누르면 전에 보낸 말을 다시 불러와요.' },
  { id: 'kct-rewind', text: '입력 칸이 비었을 때 Esc를 두 번 누르면 되돌리기 메뉴가 열려요.' },
  { id: 'kct-clear', text: '/clear 는 새 대화를 시작해요. 앞 대화는 /resume 으로 다시 열어요.' },
  { id: 'kct-file-mention', text: '@ 를 치고 파일 이름을 쓰면 그 파일을 골라 넣을 수 있어요.' },
];

const GREETING = '안녕하세요! 하고 싶은 일을 한국어로 편하게 적어 주세요.';

// 훅을 보낼 이벤트. 도구 이벤트는 모든 도구(matcher "*")에 건다.
const TOOL_EVENTS = ['PreToolUse', 'PostToolUse', 'PermissionRequest'];
const OTHER_EVENTS = ['Notification', 'Stop', 'UserPromptSubmit'];
// 허락 요청은 사람이 버튼을 누를 때까지 붙잡으므로 10분을 준다(훅 서버는 590초에 푼다).
const PERMISSION_TIMEOUT_SECONDS = 600;

// token은 셸 명령과 주소 안에 그대로 들어가므로 주소에 안전한 글자만 받는다.
function checkEndpoint(port, token) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TypeError(`buildSettings: port가 잘못됐습니다: ${port}`);
  }
  if (typeof token !== 'string' || !/^[A-Za-z0-9._~-]+$/.test(token)) {
    throw new TypeError('buildSettings: token은 영문·숫자·._~- 로만 된 문자열이어야 합니다');
  }
}

// macOS·Linux: Claude Code가 sh -c로 돌린다. 표준 입력(상태 JSON)을 그대로 보내고 응답을 그대로 출력한다.
// -f: 200이 아니면 실패로 보고 기본 문구를 낸다. --noproxy: 프록시 설정이 있어도 127.0.0.1로 바로 간다.
function posixStatusCommand(url) {
  return `curl -sf --max-time 1 --noproxy 127.0.0.1 -H 'Content-Type: application/json' --data-binary @- '${url}' || echo '${FALLBACK_STATUS}'`;
}

// Windows: Claude Code는 Git Bash가 있으면 Git Bash로, 없으면 PowerShell로 돌린다.
// statusline 문서 "Windows configuration"은 powershell로 부르면 두 경우 모두 된다고 한다.
// 두 셸의 따옴표·$ 해석 차이를 피하려고 스크립트를 -EncodedCommand(UTF-16LE base64)로 넘긴다.
// 표준 입력은 바이트 그대로 보내고, 응답은 UTF-8로 읽어 UTF-8 바이트로 쓴다. (시험하지 않음)
function windowsStatusCommand(url) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    '  $ms = New-Object System.IO.MemoryStream',
    '  [Console]::OpenStandardInput().CopyTo($ms)',
    '  $body = $ms.ToArray()',
    `  $req = [System.Net.HttpWebRequest]::Create('${url}')`,
    "  $req.Method = 'POST'",
    "  $req.ContentType = 'application/json'",
    '  $req.Proxy = $null',
    '  $req.Timeout = 1000',
    '  $req.ReadWriteTimeout = 1000',
    '  $rs = $req.GetRequestStream(); $rs.Write($body, 0, $body.Length); $rs.Close()',
    '  $res = $req.GetResponse()',
    '  $out = (New-Object System.IO.StreamReader($res.GetResponseStream(), [System.Text.Encoding]::UTF8)).ReadToEnd()',
    '  $res.Close()',
    `} catch { $out = '${FALLBACK_STATUS}' }`,
    '$bytes = [System.Text.Encoding]::UTF8.GetBytes($out)',
    '$stdout = [Console]::OpenStandardOutput()',
    '$stdout.Write($bytes, 0, $bytes.Length)',
    '$stdout.Flush()',
  ].join('\n');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return `powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`;
}

function buildSettings({ port, token, platform = process.platform } = {}) {
  checkEndpoint(port, token);
  const base = `http://127.0.0.1:${port}/${token}`;
  const httpHook = (event) => ({ type: 'http', url: `${base}/hook/${event}` });

  const hooks = {};
  for (const event of TOOL_EVENTS) {
    const handler = httpHook(event);
    if (event === 'PermissionRequest') handler.timeout = PERMISSION_TIMEOUT_SECONDS;
    hooks[event] = [{ matcher: '*', hooks: [handler] }];
  }
  for (const event of OTHER_EVENTS) {
    hooks[event] = [{ hooks: [httpHook(event)] }];
  }

  const statusUrl = `${base}/statusline`;
  return {
    language: 'korean',
    spinnerVerbs: { mode: 'replace', verbs: [...SPINNER_VERBS] },
    spinnerTipsOverride: {
      label: '도움말',
      excludeDefault: true,
      tips: SPINNER_TIPS.map((t) => ({ ...t })),
    },
    companyAnnouncements: [GREETING],
    statusLine: {
      type: 'command',
      command: platform === 'win32' ? windowsStatusCommand(statusUrl) : posixStatusCommand(statusUrl),
    },
    hooks,
  };
}

// 다른 사용자가 읽지 못하게 0600으로 쓴다. 임시 파일에 쓰고 바꿔 넣어서,
// 이미 있던 파일의 권한이 넓어도 새 내용은 0600 파일에만 들어가고 claude가 반쯤 쓴 파일을 읽지 않는다.
function writeSettingsFile(settings, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, SETTINGS_FILE_NAME);
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, filePath);
  return filePath;
}

function claudeArgs(filePath) {
  return ['--settings', filePath];
}

module.exports = {
  buildSettings,
  writeSettingsFile,
  claudeArgs,
  SETTINGS_FILE_NAME,
  FALLBACK_STATUS,
};
