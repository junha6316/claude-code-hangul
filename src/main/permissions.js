// 허락 요청(PermissionRequest 훅)을 붙잡고 푸는 규칙. HTTP는 모르고, 응답은 hold()에 넘긴 reply 함수로 보낸다.
//
// 근거(hooks 문서 사본 review/tech-stack-deploy/docs/hooks.md):
// - "PermissionRequest input": tool_name·tool_input은 오지만 tool_use_id는 오지 않는다.
// - "PermissionRequest decision control": decision.behavior(allow/deny), deny일 때만 message·interrupt.
// - "HTTP response handling": 2xx 빈 본문은 결정 없음이라 터미널의 영어 허락 창이 그대로 남는다.
// 실제 동작(review/hook/runs/rB, claude 2.1.296): 터미널에서 먼저 거절하면 claude가 연결을 끊고(012·018),
// 먼저 허락하면 연결은 둔 채 PostToolUse가 온다(014·015).
const { randomUUID } = require('crypto');
const { isDeepStrictEqual } = require('util');

// 훅 timeout(600초, T3 설정)보다 먼저 풀어서 claude 쪽에 시간 초과가 나지 않게 한다.
const PERMISSION_TIMEOUT_MS = 590 * 1000;

// deny와 함께 Claude에게 가는 이유. interrupt: true라 Claude는 멈추고 다음 말을 기다린다.
const DENY_MESSAGE = '사용자가 한국어 화면에서 거절했어요. 이 작업은 하지 말고 다음 지시를 기다려 주세요.';

// 'permission-cleared'(id, reason)의 reason
const CLEAR_REASONS = Object.freeze({
  DECIDED: 'decided', // 앱에서 허락·거절을 골랐다
  ANSWERED_IN_TERMINAL: 'answered-in-terminal', // 터미널이 먼저 넘어갔다(PostToolUse, 다음 PreToolUse·UserPromptSubmit·Stop)
  CLIENT_CLOSED: 'client-closed', // claude가 연결을 끊었다(터미널에서 먼저 거절했거나 claude가 꺼졌다)
  TIMEOUT: 'timeout', // PERMISSION_TIMEOUT_MS가 지났다
  SERVER_CLOSED: 'server-closed', // 훅 서버를 닫았다
});

// 세션마다 기억해 둘 최근 PreToolUse 수
const RECENT_LIMIT = 50;

// 사용자의 답이 있어야 하는 도구(질문에 답 고르기, 계획 승인). claude는 이 도구의 PermissionRequest에
// updatedInput(고른 답) 없이 allow가 오면 결정으로 치지 않고 터미널 창에서 답을 기다린다
// (claude 2.1.296 runHooks: `!updatedInput && tool.requiresUserInteraction()`이면 null. deny는 그대로 받는다).
// 앱의 "허락"이 아무 일도 하지 않으므로 이 요청은 붙잡지 않고 곧바로 빈 본문으로 답한다.
const TERMINAL_ANSWER_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);
const needsTerminalAnswer = (body) => TERMINAL_ANSWER_TOOLS.has(body.tool_name);

function permissionResponse(decision) {
  if (decision === 'allow') {
    return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } };
  }
  if (decision === 'deny') {
    return {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny', message: DENY_MESSAGE, interrupt: true },
      },
    };
  }
  throw new TypeError(`decision은 'allow' 또는 'deny'여야 합니다: ${decision}`);
}

const sessionKey = (body) => String(body.session_id ?? '');
// 같은 세션 안에서도 하위 에이전트(agent_id)는 따로 움직이므로 "다음 PreToolUse" 규칙은 같은 갈래끼리만 적용한다.
const laneKey = (body) => `${sessionKey(body)}\u0000${body.agent_id ?? ''}`;

// onPermission(pending), onCleared(id, reason)은 던지지 않아야 한다(hookServer가 감싸서 넘긴다).
function createPermissions({
  timeoutMs = PERMISSION_TIMEOUT_MS,
  onPermission = () => {},
  onCleared = () => {},
} = {}) {
  const held = new Map(); // id → { pending, session, lane, reply, timer }
  const recentPreToolUse = new Map(); // session → [{ toolUseId, toolName, toolInput, lane }] (오래된 것부터)

  function release(id, reason, replyText = '') {
    const entry = held.get(id);
    if (!entry) return false;
    held.delete(id);
    clearTimeout(entry.timer);
    entry.reply(replyText);
    onCleared(id, reason);
    return true;
  }

  function releaseWhere(match, reason) {
    for (const [id, entry] of [...held]) {
      if (match(entry)) release(id, reason);
    }
  }

  // 끝난 도구의 PreToolUse는 더 짝지을 일이 없다. Write는 파일 내용 전체를 들고 있어 세션이 바뀌어도 쌓이지 않게 지운다.
  function forgetPreToolUse(session, toolUseId) {
    const list = recentPreToolUse.get(session);
    if (!list) return;
    const i = list.findIndex((e) => e.toolUseId === toolUseId);
    if (i >= 0) list.splice(i, 1);
    if (!list.length) recentPreToolUse.delete(session);
  }

  // PermissionRequest가 아닌 훅을 받을 때마다 부른다.
  function observe(eventName, body) {
    const session = sessionKey(body);
    if (eventName === 'PreToolUse') {
      const lane = laneKey(body);
      releaseWhere((e) => e.lane === lane, CLEAR_REASONS.ANSWERED_IN_TERMINAL);
      if (typeof body.tool_use_id === 'string') {
        const list = recentPreToolUse.get(session) || [];
        list.push({ toolUseId: body.tool_use_id, toolName: body.tool_name, toolInput: body.tool_input, lane });
        if (list.length > RECENT_LIMIT) list.shift();
        recentPreToolUse.set(session, list);
      }
    } else if (eventName === 'PostToolUse') {
      const toolUseId = body.tool_use_id;
      if (typeof toolUseId === 'string') {
        releaseWhere((e) => e.pending.toolUseId === toolUseId, CLEAR_REASONS.ANSWERED_IN_TERMINAL);
        forgetPreToolUse(session, toolUseId);
      }
    } else if (eventName === 'UserPromptSubmit' || eventName === 'Stop') {
      releaseWhere((e) => e.session === session, CLEAR_REASONS.ANSWERED_IN_TERMINAL);
    }
  }

  // PermissionRequest를 붙잡는다. reply(text)는 정확히 한 번 불린다(text가 ''이면 빈 본문).
  function hold(body, reply) {
    const session = sessionKey(body);
    const list = recentPreToolUse.get(session) || [];
    let match = null;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].toolName === body.tool_name && isDeepStrictEqual(list[i].toolInput, body.tool_input)) {
        match = list.splice(i, 1)[0];
        if (!list.length) recentPreToolUse.delete(session);
        break;
      }
    }
    const pending = {
      id: randomUUID(),
      sessionId: body.session_id ?? null,
      toolName: body.tool_name ?? null,
      toolInput: body.tool_input ?? null,
      toolUseId: match ? match.toolUseId : null,
      receivedAt: Date.now(),
    };
    const timer = setTimeout(() => release(pending.id, CLEAR_REASONS.TIMEOUT), timeoutMs);
    timer.unref();
    held.set(pending.id, { pending, session, lane: match ? match.lane : laneKey(body), reply, timer });
    onPermission(pending);
    return pending;
  }

  function decide(id, decision) {
    const text = JSON.stringify(permissionResponse(decision));
    return release(id, CLEAR_REASONS.DECIDED, text);
  }

  return {
    observe,
    hold,
    decide,
    cancel: (id, reason) => release(id, reason),
    releaseAll: (reason) => releaseWhere(() => true, reason),
  };
}

module.exports = {
  createPermissions,
  needsTerminalAnswer,
  permissionResponse,
  PERMISSION_TIMEOUT_MS,
  DENY_MESSAGE,
  CLEAR_REASONS,
};
