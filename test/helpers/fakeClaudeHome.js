// 실제 ~/.claude, ~/.claude.json을 건드리지 않고 claude를 띄우기 위한 가짜 설정 폴더.
// 근거: review/korean-input/exp/paste_probe.js (CLAUDE_CONFIG_DIR 아래 .claude.json + 가짜 API 키)
//
//   const { env, configDir } = createFakeClaudeHome({ dir, trustedPaths: [work] });
//   // env를 그대로 claude 프로세스에 넘긴다.
//
// 옵션
//   dir           가짜 설정을 만들 폴더. app/.test-tmp/<작업 ID>/ 아래를 쓴다.
//   trustedPaths  폴더 신뢰 창을 건너뛸 폴더 목록
//   onboarded     false면 첫 실행 화면(테마 고르기)부터 나온다
//   withKey       false면 API 키를 넣지 않는다(로그인 방법 고르기 화면이 나온다)
//   approveKey    withKey일 때 false면 키를 승인하지 않은 상태로 둔다(키를 쓸지 묻는 화면이 나온다)
const fs = require('fs');
const path = require('path');

// 실제 Anthropic 키가 아닌 형식만 맞춘 가짜 키. 요청을 보내도 인증 오류로 끝난다.
const FAKE_API_KEY = 'sk-ant-api03-' + 'k'.repeat(80) + 'AAAAAAAAAAAAAAAAAAAA';
const KNOWN_VERSION = '2.1.296';

// 부모 프로세스(예: Claude Code 안에서 도는 시험)의 Claude 관련 변수는 모두 지운다.
// 세션 변수가 남으면 자식 claude가 중첩 세션으로 동작하고, 인증 변수가 남으면 실제 계정을 쓸 수 있다.
const STRIP = /^(CLAUDE|ANTHROPIC)/;

function realOrResolved(p) {
  const abs = path.resolve(p);
  try { return fs.realpathSync(abs); } catch { return abs; }
}

// 상위 폴더의 .mcp.json(예: 이 Mac의 ~/.mcp.json)이 있으면 claude가 "New MCP server found" 창을 띄운다.
// 시험 화면이 이 Mac 사정에 흔들리지 않게, 찾은 서버 이름을 가짜 사용자 설정의 disabledMcpjsonServers에 넣는다.
function ancestorMcpServerNames(starts) {
  const names = new Set();
  for (const start of starts) {
    let d = path.resolve(start);
    for (;;) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(d, '.mcp.json'), 'utf8'));
        for (const n of Object.keys((j && j.mcpServers) || {})) names.add(n);
      } catch { /* 없거나 깨진 파일 */ }
      const up = path.dirname(d);
      if (up === d) break;
      d = up;
    }
  }
  return [...names].sort();
}

function createFakeClaudeHome({ dir, trustedPaths = [], onboarded = true, withKey = true, approveKey = true } = {}) {
  if (!dir) throw new Error('createFakeClaudeHome: dir가 필요합니다');
  const configDir = path.join(path.resolve(dir), 'claude-config');
  fs.mkdirSync(configDir, { recursive: true });

  const projects = {};
  for (const p of trustedPaths) {
    projects[realOrResolved(p)] = {
      hasTrustDialogAccepted: true,
      hasCompletedProjectOnboarding: true,
      allowedTools: [],
    };
  }

  const claudeJson = {
    numStartups: 50,
    lastReleaseNotesSeen: KNOWN_VERSION,
    projects,
  };
  if (onboarded) {
    claudeJson.hasCompletedOnboarding = true;
    claudeJson.theme = 'dark';
  }
  if (withKey) {
    // claude는 키의 마지막 20글자로 승인 여부를 기억한다.
    const tail = FAKE_API_KEY.slice(-20);
    claudeJson.customApiKeyResponses = approveKey
      ? { approved: [tail], rejected: [] }
      : { approved: [], rejected: [] };
  }
  const claudeJsonPath = path.join(configDir, '.claude.json');
  fs.writeFileSync(claudeJsonPath, JSON.stringify(claudeJson, null, 2));

  const mcpNames = ancestorMcpServerNames([dir, ...trustedPaths]);
  if (mcpNames.length) {
    fs.writeFileSync(path.join(configDir, 'settings.json'),
      JSON.stringify({ disabledMcpjsonServers: mcpNames }, null, 2));
  }

  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!STRIP.test(k) && v !== undefined) env[k] = v;
  }
  env.CLAUDE_CONFIG_DIR = configDir;
  // 시험 중 사용자의 실제 claude 설치본이 자동 업데이트되지 않게 한다(앱 설정에는 넣지 않는다).
  env.DISABLE_AUTOUPDATER = '1';
  if (withKey) env.ANTHROPIC_API_KEY = FAKE_API_KEY;

  return { env, configDir, claudeJsonPath };
}

module.exports = { createFakeClaudeHome, FAKE_API_KEY };
