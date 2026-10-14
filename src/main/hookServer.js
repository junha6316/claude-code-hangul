// 훅·상태 줄 HTTP 서버. 127.0.0.1에만 열고, 주소에 토큰이 맞아야 받는다.
//   POST /<token>/hook/<EventName>  claude의 http 훅(T3 설정)
//   POST /<token>/statusline        statusLine 명령(curl)이 표준 입력을 그대로 보낸다
//
// 응답 규칙(hooks 문서 사본 review/tech-stack-deploy/docs/hooks.md "HTTP response handling"):
// - PermissionRequest만 앱의 결정(또는 permissions.js의 풀기 규칙)까지 붙잡는다.
//   단, 사용자의 답이 있어야 하는 도구(permissions.needsTerminalAnswer)는 터미널에서 답하므로 붙잡지 않는다.
// - 그 밖의 훅, 깨진 JSON, 앱 쪽 오류는 모두 곧바로 빈 본문 200. 빈 본문은 "결정 없음"이라 claude 작업을 막지 않는다.
//
// events
//   'hook'(eventName, body)          받은 훅마다(PermissionRequest 포함, 깨진 JSON 제외)
//   'permission'(pending)            pending = { id, sessionId, toolName, toolInput, toolUseId | null, receivedAt }
//   'permission-cleared'(id, reason) 붙잡은 요청을 풀었을 때. reason은 permissions.CLEAR_REASONS 값('decided' 포함)
//   'status'(statusJson, text)       상태 줄 요청마다(깨진 JSON 제외). text는 claude에게 돌려준 글
const http = require('http');
const { randomBytes } = require('crypto');
const { EventEmitter } = require('events');
const { createPermissions, needsTerminalAnswer, CLEAR_REASONS, PERMISSION_TIMEOUT_MS } = require('./permissions');

const HOST = '127.0.0.1';
const STATUS_FALLBACK = '작업실';
const EVENT_NAME = /^[A-Za-z]+$/;

function parseRoute(req, token) {
  if (req.method !== 'POST') return null;
  const parts = req.url.split('?')[0].split('/'); // ['', token, 'hook', EventName]
  if (parts[1] !== token) return null;
  if (parts.length === 4 && parts[2] === 'hook' && EVENT_NAME.test(parts[3])) {
    return { kind: 'hook', eventName: parts[3] };
  }
  if (parts.length === 3 && parts[2] === 'statusline') return { kind: 'statusline' };
  return null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// JSON 객체가 아니면 null
function parseObject(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function send(res, status, text = '', contentType = null) {
  if (res.headersSent || res.writableEnded || res.destroyed) return;
  const headers = { 'Content-Length': Buffer.byteLength(text) };
  if (contentType) headers['Content-Type'] = contentType;
  res.writeHead(status, headers);
  res.end(text);
}

function startHookServer({ formatStatusLine, permissionTimeoutMs = PERMISSION_TIMEOUT_MS } = {}) {
  const token = randomBytes(24).toString('hex');
  const events = new EventEmitter();

  // 화면 쪽 처리에서 난 오류가 응답을 막지 않게 한다.
  const emit = (name, ...args) => {
    try {
      events.emit(name, ...args);
    } catch (err) {
      console.error(`[hookServer] '${name}' 처리 중 오류:`, err);
    }
  };

  const permissions = createPermissions({
    timeoutMs: permissionTimeoutMs,
    onPermission: (pending) => emit('permission', pending),
    onCleared: (id, reason) => emit('permission-cleared', id, reason),
  });

  function statusText(statusJson) {
    if (typeof formatStatusLine !== 'function') return STATUS_FALLBACK;
    try {
      const text = formatStatusLine(statusJson);
      return typeof text === 'string' && text !== '' ? text : STATUS_FALLBACK;
    } catch (err) {
      console.error('[hookServer] formatStatusLine 오류:', err);
      return STATUS_FALLBACK;
    }
  }

  async function handle(req, res, route) {
    // 연결이 먼저 끊기는 경우를 놓치지 않게 본문을 읽기 전에 건다.
    let closedEarly = false;
    let heldId = null;
    res.on('close', () => {
      if (res.writableEnded) return;
      closedEarly = true;
      if (heldId) permissions.cancel(heldId, CLEAR_REASONS.CLIENT_CLOSED);
    });

    const body = parseObject(await readBody(req));

    if (route.kind === 'statusline') {
      const text = body ? statusText(body) : STATUS_FALLBACK;
      send(res, 200, text, 'text/plain; charset=utf-8');
      if (body) emit('status', body, text);
      return;
    }

    if (!body) {
      send(res, 200);
      return;
    }

    if (route.eventName !== 'PermissionRequest') {
      send(res, 200);
      permissions.observe(route.eventName, body);
      emit('hook', route.eventName, body);
      return;
    }

    emit('hook', route.eventName, body);
    if (needsTerminalAnswer(body)) {
      send(res, 200);
      return;
    }
    const pending = permissions.hold(body, (text) => send(res, 200, text, text ? 'application/json' : null));
    heldId = pending.id;
    if (closedEarly) permissions.cancel(pending.id, CLEAR_REASONS.CLIENT_CLOSED);
  }

  const server = http.createServer((req, res) => {
    const route = parseRoute(req, token);
    if (!route) {
      send(res, 404);
      return;
    }
    handle(req, res, route).catch((err) => {
      // ECONNRESET은 본문을 다 보내기 전에 claude가 끊은 경우라 답할 곳이 없다.
      if (err.code !== 'ECONNRESET') console.error('[hookServer] 요청 처리 중 오류:', err);
      send(res, 200);
    });
  });
  // claude는 keep-alive 연결을 다시 쓴다(rB 요청 헤더). 서버가 놀고 있는 연결을 끊는 순간 claude가 그 연결로
  // 훅을 보내면 요청이 실패할 수 있어, 기본 5초보다 길게 둔다.
  server.keepAliveTimeout = 120 * 1000;

  let closing = null;
  function close() {
    if (!closing) {
      permissions.releaseAll(CLEAR_REASONS.SERVER_CLOSED);
      closing = new Promise((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections();
        setTimeout(() => server.closeAllConnections(), 1000).unref();
      });
    }
    return closing;
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, HOST, () => {
      server.off('error', reject);
      server.on('error', (err) => console.error('[hookServer] 서버 오류:', err));
      resolve({
        port: server.address().port,
        token,
        events,
        decide: (id, decision) => permissions.decide(id, decision),
        close,
      });
    });
  });
}

module.exports = { startHookServer, STATUS_FALLBACK };
