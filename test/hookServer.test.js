// T4 훅 서버·허락 처리 시험.
// 자료: test/fixtures/hooks/ (review/hook/runs/rB의 실제 요청, claude 2.1.296에서 body만 꺼냄).
// 응답 형식 근거: review/tech-stack-deploy/docs/hooks.md의 "PermissionRequest decision control"과 "HTTP response handling".
// korean.js(T5)와 따로 만들어지므로 formatStatusLine은 가짜를 쓴다.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { once } = require('events');

const { startHookServer, STATUS_FALLBACK } = require('../src/main/hookServer');
const { PERMISSION_TIMEOUT_MS, DENY_MESSAGE } = require('../src/main/permissions');

const FIXTURES = path.join(__dirname, 'fixtures', 'hooks');
const OUT = path.join(__dirname, '..', '.test-tmp', 'T4');
fs.mkdirSync(OUT, { recursive: true });

const fixture = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
const withSession = (body, sessionId, extra = {}) => ({ ...body, session_id: sessionId, ...extra });

// hooks 문서의 PermissionRequest 응답 형식을 글자 그대로 적은 기대값
const ALLOW_JSON = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}';
const DENY_JSON =
  '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny",' +
  '"message":"사용자가 한국어 화면에서 거절했어요. 이 작업은 하지 말고 다음 지시를 기다려 주세요.","interrupt":true}}}';

// statusline 문서의 입력 JSON 중 상태 줄에 쓰는 부분
const STATUS_SAMPLE = {
  cwd: '/Users/tester/Documents/작업실',
  session_id: 'abc123',
  model: { id: 'claude-opus-5-5', display_name: 'Opus' },
  workspace: { current_dir: '/Users/tester/Documents/작업실', project_dir: '/Users/tester/Documents/작업실' },
  context_window: { context_window_size: 200000, used_percentage: 24, remaining_percentage: 76 },
};
const fakeFormatStatusLine = (json) =>
  `📁 ${path.basename(json.workspace.current_dir)} · 대화 길이 ${json.context_window.used_percentage}%`;

// 결과: { status, headers, body }. payload가 문자열이면 그대로 보낸다.
function post(port, urlPath, payload, { agent = false, method = 'POST', onRequest } = {}) {
  const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: urlPath,
        method,
        agent,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    if (onRequest) onRequest(req);
    req.end(data);
  });
}

async function start(t, options = {}) {
  const srv = await startHookServer({ formatStatusLine: fakeFormatStatusLine, ...options });
  const agent = new http.Agent({ keepAlive: true }); // claude(axios)처럼 연결을 다시 쓴다
  t.after(async () => {
    agent.destroy();
    await srv.close();
  });
  const log = [];
  srv.events.on('hook', (name, body) => log.push(['hook', name, body]));
  srv.events.on('permission', (pending) => log.push(['permission', pending]));
  srv.events.on('permission-cleared', (id, reason) => log.push(['permission-cleared', id, reason]));
  srv.events.on('status', (json, text) => log.push(['status', json, text]));
  const request = (urlPath, payload, opts) => post(srv.port, urlPath, payload, { agent, ...opts });
  return {
    srv,
    log,
    request,
    hook: (eventName, body, opts) => request(`/${srv.token}/hook/${eventName}`, body, opts),
    status: (body, opts) => request(`/${srv.token}/statusline`, body, opts),
  };
}

// 허락 요청을 보내고 'permission' 이벤트까지 기다린다. response는 붙잡힌 HTTP 응답.
async function holdPermission(ctx, body, opts) {
  const seen = once(ctx.srv.events, 'permission');
  const response = ctx.hook('PermissionRequest', body, opts);
  const [pending] = await seen;
  return { pending, response };
}

// p가 ms 안에 끝나면 true
function settlesWithin(p, ms) {
  return Promise.race([p.then(() => true, () => true), new Promise((r) => setTimeout(() => r(false), ms))]);
}

async function waitFor(fn, ms = 2000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() > end) throw new Error('기다리는 일이 일어나지 않았습니다');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const cleared = (log) => log.filter((e) => e[0] === 'permission-cleared').map((e) => e.slice(1));

test('시험 자료는 rB 실제 요청 34개의 body이고 사용자 경로가 /Users/tester로 바뀌어 있다', () => {
  const files = fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.json'));
  assert.equal(files.length, 34);
  for (const f of files) {
    const text = fs.readFileSync(path.join(FIXTURES, f), 'utf8');
    const body = JSON.parse(text);
    assert.equal(body.hook_event_name, f.split('-')[1], f);
    assert.equal(typeof body.session_id, 'string', f);
    assert.ok(!('headers' in body) && !('body' in body), `${f}: 요청 전체가 아니라 body만 있어야 합니다`);
    for (const m of text.matchAll(/\/Users\/([^/"]+)/g)) assert.equal(m[1], 'tester', f);
    for (const m of text.matchAll(/-Users-([^-"/]+)/g)) assert.equal(m[1], 'tester', f);
  }
});

test('PreToolUse 다음 PermissionRequest(Write)를 붙잡고, 허락을 고르면 allow JSON으로 답한다', { timeout: 10000 }, async (t) => {
  const ctx = await start(t);
  assert.match(ctx.srv.token, /^[0-9a-f]{48}$/);
  const pre = fixture('002-PreToolUse-Write.json');
  const req = fixture('003-PermissionRequest-Write.json');
  assert.equal(req.tool_use_id, undefined, '문서대로 PermissionRequest에는 tool_use_id가 없습니다');

  const preRes = await ctx.hook('PreToolUse', pre);
  assert.deepEqual([preRes.status, preRes.body], [200, '']);

  const { pending, response } = await holdPermission(ctx, req);
  assert.deepEqual(Object.keys(pending).sort(), ['id', 'receivedAt', 'sessionId', 'toolInput', 'toolName', 'toolUseId']);
  assert.equal(pending.toolUseId, pre.tool_use_id);
  assert.equal(pending.sessionId, req.session_id);
  assert.equal(pending.toolName, 'Write');
  assert.deepEqual(pending.toolInput, req.tool_input);
  assert.equal(typeof pending.id, 'string');
  assert.equal(typeof pending.receivedAt, 'number');
  assert.equal(await settlesWithin(response, 300), false, '고르기 전에는 응답하지 않아야 합니다');

  assert.equal(ctx.srv.decide(pending.id, 'allow'), true);
  const res = await response;
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /^application\/json/);
  assert.equal(res.body, ALLOW_JSON);
  assert.equal(ctx.srv.decide(pending.id, 'allow'), false, '이미 푼 요청은 다시 고를 수 없습니다');

  assert.deepEqual(cleared(ctx.log), [[pending.id, 'decided']]);
  const hooks = ctx.log.filter((e) => e[0] === 'hook');
  assert.deepEqual(hooks.map((e) => e[1]), ['PreToolUse', 'PermissionRequest']);
  assert.deepEqual(hooks[0][2], pre);
  assert.deepEqual(hooks[1][2], req);
  fs.writeFileSync(path.join(OUT, 'allow-response.json'), `${res.body}\n`);
});

test('거절을 고르면 interrupt: true와 한국어 message가 든 deny JSON으로 답한다', { timeout: 10000 }, async (t) => {
  const ctx = await start(t);
  const pre = fixture('007-PreToolUse-Bash.json');
  await ctx.hook('PreToolUse', pre);
  const { pending, response } = await holdPermission(ctx, fixture('008-PermissionRequest-Bash.json'));
  assert.equal(pending.toolUseId, pre.tool_use_id);
  assert.equal(pending.toolName, 'Bash');

  assert.throws(() => ctx.srv.decide(pending.id, 'yes'), TypeError);
  assert.equal(ctx.srv.decide(pending.id, 'deny'), true);
  const res = await response;
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /^application\/json/);
  assert.equal(res.body, DENY_JSON);
  const decision = JSON.parse(res.body).hookSpecificOutput.decision;
  assert.equal(decision.interrupt, true);
  assert.equal(decision.message, DENY_MESSAGE);
  assert.match(decision.message, /[가-힣]/);
  assert.deepEqual(cleared(ctx.log), [[pending.id, 'decided']]);
  fs.writeFileSync(path.join(OUT, 'deny-response.json'), `${res.body}\n`);
});

test('붙잡힌 동안 같은 tool_use_id의 PostToolUse가 오면 빈 본문 200으로 풀고 answered-in-terminal을 낸다', { timeout: 10000 }, async (t) => {
  const ctx = await start(t);
  const pre = fixture('013-PreToolUse-Write.json');
  const post = fixture('015-PostToolUse-Write.json');
  await ctx.hook('PreToolUse', pre);
  const { pending, response } = await holdPermission(ctx, fixture('014-PermissionRequest-Write.json'));
  assert.equal(pending.toolUseId, post.tool_use_id);

  // 터미널 허락 창이 떠 있다는 알림과 다른 도구의 PostToolUse로는 풀지 않는다
  await ctx.hook('Notification', fixture('019-Notification--.json'));
  await ctx.hook('PostToolUse', { ...post, tool_use_id: 'toolu_other' });
  assert.equal(await settlesWithin(response, 200), false);

  const postRes = await ctx.hook('PostToolUse', post);
  assert.deepEqual([postRes.status, postRes.body], [200, '']);
  const res = await response;
  assert.deepEqual([res.status, res.body, res.headers['content-length']], [200, '', '0']);
  assert.deepEqual(cleared(ctx.log), [[pending.id, 'answered-in-terminal']]);
  assert.equal(ctx.srv.decide(pending.id, 'allow'), false);
});

test('같은 세션의 UserPromptSubmit·Stop은 붙잡은 요청을 풀고, 다른 세션의 요청은 그대로 둔다', { timeout: 10000 }, async (t) => {
  const ctx = await start(t);
  const A = fixture('017-PreToolUse-Write.json').session_id;
  const B = 'b0000000-0000-4000-8000-00000000000b';

  // 다른 세션(B)의 허락 요청을 먼저 붙잡아 둔다
  await ctx.hook('PreToolUse', withSession(fixture('011-PreToolUse-Write.json'), B));
  const b = await holdPermission(ctx, withSession(fixture('012-PermissionRequest-Write.json'), B));
  assert.equal(b.pending.toolUseId, fixture('011-PreToolUse-Write.json').tool_use_id);

  // A: UserPromptSubmit으로 풀림(rB에 없는 이벤트라 hooks 문서의 입력 예시 모양으로 만든다)
  await ctx.hook('PreToolUse', fixture('017-PreToolUse-Write.json'));
  const a1 = await holdPermission(ctx, fixture('018-PermissionRequest-Write.json'));
  const prompt = {
    session_id: A,
    transcript_path: fixture('017-PreToolUse-Write.json').transcript_path,
    cwd: '/Users/tester/Projects/kct-hook-ws',
    permission_mode: 'default',
    hook_event_name: 'UserPromptSubmit',
    prompt: '파일 하나 만들어 줘',
  };
  assert.deepEqual((await ctx.hook('UserPromptSubmit', prompt)).status, 200);
  assert.deepEqual(await a1.response.then((r) => [r.status, r.body]), [200, '']);

  // A: Stop으로 풀림
  await ctx.hook('PreToolUse', fixture('029-PreToolUse-Write.json'));
  const a2 = await holdPermission(ctx, fixture('030-PermissionRequest-Write.json'));
  assert.equal((await ctx.hook('Stop', fixture('032-Stop--.json'))).status, 200);
  assert.deepEqual(await a2.response.then((r) => [r.status, r.body]), [200, '']);

  // B는 그대로 붙잡혀 있다가 고르면 답한다
  assert.equal(await settlesWithin(b.response, 200), false);
  assert.deepEqual(cleared(ctx.log), [
    [a1.pending.id, 'answered-in-terminal'],
    [a2.pending.id, 'answered-in-terminal'],
  ]);
  assert.equal(ctx.srv.decide(b.pending.id, 'allow'), true);
  assert.equal((await b.response).body, ALLOW_JSON);
});

test('같은 세션의 다음 PreToolUse가 오면 풀고, 하위 에이전트의 PreToolUse로는 풀지 않는다', { timeout: 10000 }, async (t) => {
  const ctx = await start(t);
  // 같은 명령의 PreToolUse가 두 번 오면 바로 앞(가장 최근) 것의 tool_use_id를 붙인다
  await ctx.hook('PreToolUse', fixture('020-PreToolUse-Bash.json'));
  await ctx.hook('PreToolUse', fixture('024-PreToolUse-Bash.json'));
  const p = await holdPermission(ctx, fixture('021-PermissionRequest-Bash.json'));
  assert.equal(p.pending.toolUseId, fixture('024-PreToolUse-Bash.json').tool_use_id);

  await ctx.hook('PreToolUse', { ...fixture('027-PreToolUse-Bash.json'), agent_id: 'agent-abc123', agent_type: 'Explore' });
  assert.equal(await settlesWithin(p.response, 200), false);

  await ctx.hook('PreToolUse', fixture('027-PreToolUse-Bash.json'));
  assert.deepEqual(await p.response.then((r) => [r.status, r.body]), [200, '']);
  assert.deepEqual(cleared(ctx.log), [[p.pending.id, 'answered-in-terminal']]);
});

// claude 2.1.296은 이 두 도구의 PermissionRequest에 updatedInput 없는 allow가 오면 결정으로 치지 않는다(permissions.js 주석).
// 입력 모양은 hooks 문서 "AskUserQuestion"·"ExitPlanMode" 절을 따른다.
test('질문 고르기·계획 승인처럼 터미널에서 답해야 하는 도구의 허락 요청은 붙잡지 않고 곧바로 빈 본문 200으로 답한다', { timeout: 10000 }, async (t) => {
  const ctx = await start(t);
  const base = fixture('002-PreToolUse-Write.json');
  const tools = [
    ['AskUserQuestion', {
      questions: [{
        question: '어떤 모양으로 만들까요?',
        header: '모양',
        options: [{ label: '표', description: '표로 정리해요' }, { label: '글', description: '글로 정리해요' }],
        multiSelect: false,
      }],
    }],
    ['ExitPlanMode', { plan: '## 계획\n1. 메모 파일 만들기', planFilePath: '/Users/tester/.claude/plans/memo.md' }],
  ];
  for (const [toolName, toolInput] of tools) {
    const common = {
      session_id: base.session_id,
      transcript_path: base.transcript_path,
      cwd: base.cwd,
      permission_mode: 'default',
      tool_name: toolName,
      tool_input: toolInput,
    };
    await ctx.hook('PreToolUse', { ...common, hook_event_name: 'PreToolUse', tool_use_id: `toolu_${toolName}` });
    const response = ctx.hook('PermissionRequest', { ...common, hook_event_name: 'PermissionRequest' });
    assert.equal(await settlesWithin(response, 1000), true, `${toolName}: 붙잡지 말아야 합니다`);
    const res = await response;
    assert.deepEqual([res.status, res.body, res.headers['content-length']], [200, '', '0'], toolName);
  }
  assert.deepEqual(ctx.log.filter((e) => e[0] === 'permission'), [], '허락 카드를 띄우지 않아야 합니다');
  assert.deepEqual(cleared(ctx.log), []);
  assert.deepEqual(ctx.log.map((e) => [e[1], e[2].tool_name]), [
    ['PreToolUse', 'AskUserQuestion'], ['PermissionRequest', 'AskUserQuestion'],
    ['PreToolUse', 'ExitPlanMode'], ['PermissionRequest', 'ExitPlanMode'],
  ]);

  // 다른 도구는 그대로 붙잡는다
  await ctx.hook('PreToolUse', fixture('002-PreToolUse-Write.json'));
  const p = await holdPermission(ctx, fixture('003-PermissionRequest-Write.json'));
  assert.equal(await settlesWithin(p.response, 200), false);
  ctx.srv.decide(p.pending.id, 'allow');
  assert.equal((await p.response).body, ALLOW_JSON);
});

test('끝난 도구(PostToolUse)의 PreToolUse는 뒤에 오는 허락 요청의 짝으로 쓰지 않는다', { timeout: 10000 }, async (t) => {
  const ctx = await start(t);
  const pre = fixture('020-PreToolUse-Bash.json');
  const post = fixture('022-PostToolUse-Bash.json');
  assert.equal(post.tool_use_id, pre.tool_use_id);
  await ctx.hook('PreToolUse', pre);
  await ctx.hook('PostToolUse', post);
  const p = await holdPermission(ctx, fixture('021-PermissionRequest-Bash.json'));
  assert.equal(p.pending.toolUseId, null);
  ctx.srv.decide(p.pending.id, 'deny');
  await p.response;

  // 같은 명령을 다시 하면 새 PreToolUse와 짝짓는다
  await ctx.hook('PreToolUse', fixture('024-PreToolUse-Bash.json'));
  const q = await holdPermission(ctx, fixture('021-PermissionRequest-Bash.json'));
  assert.equal(q.pending.toolUseId, fixture('024-PreToolUse-Bash.json').tool_use_id);
  ctx.srv.decide(q.pending.id, 'allow');
  await q.response;
});

test('정해진 시간(기본 590초)이 지나면 빈 본문 200으로 풀고 timeout을 낸다', { timeout: 10000 }, async (t) => {
  assert.equal(PERMISSION_TIMEOUT_MS, 590 * 1000);
  const ctx = await start(t, { permissionTimeoutMs: 300 }); // 590초를 기다릴 수 없어 시간만 줄인다
  await ctx.hook('PreToolUse', fixture('033-PreToolUse-Write.json'));
  const t0 = Date.now();
  const p = await holdPermission(ctx, fixture('034-PermissionRequest-Write.json'));
  const res = await p.response;
  assert.deepEqual([res.status, res.body], [200, '']);
  assert.ok(Date.now() - t0 >= 250, `${Date.now() - t0}ms 만에 풀렸습니다`);
  assert.deepEqual(cleared(ctx.log), [[p.pending.id, 'timeout']]);
});

test('claude가 연결을 끊으면(터미널에서 먼저 거절) client-closed로 풀어 둔다', { timeout: 10000 }, async (t) => {
  const ctx = await start(t);
  await ctx.hook('PreToolUse', fixture('011-PreToolUse-Write.json'));
  let clientReq = null;
  const p = await holdPermission(ctx, fixture('012-PermissionRequest-Write.json'), {
    onRequest: (r) => {
      clientReq = r;
    },
  });
  p.response.catch(() => {});
  const gone = once(ctx.srv.events, 'permission-cleared');
  clientReq.destroy();
  assert.deepEqual(await gone, [p.pending.id, 'client-closed']);
  assert.equal(ctx.srv.decide(p.pending.id, 'allow'), false);
});

test('토큰이 틀리거나 주소·방법이 다르면 404를 준다', { timeout: 10000 }, async (t) => {
  const ctx = await start(t);
  const pre = fixture('002-PreToolUse-Write.json');
  const wrong = 'f'.repeat(48);
  assert.equal((await ctx.request(`/${wrong}/hook/PreToolUse`, pre)).status, 404);
  assert.equal((await ctx.request(`/${wrong}/hook/PermissionRequest`, fixture('003-PermissionRequest-Write.json'))).status, 404);
  assert.equal((await ctx.request(`/${wrong}/statusline`, STATUS_SAMPLE)).status, 404);
  assert.equal((await ctx.request('/hook/PreToolUse', pre)).status, 404);
  assert.equal((await ctx.request(`/${ctx.srv.token}/hook/`, pre)).status, 404);
  assert.equal((await ctx.request(`/${ctx.srv.token}/hook/Pre-Tool`, pre)).status, 404);
  assert.equal((await ctx.request(`/${ctx.srv.token}/hook/PreToolUse/x`, pre)).status, 404);
  assert.equal((await ctx.request(`/${ctx.srv.token}/other`, pre)).status, 404);
  assert.equal((await ctx.request(`/${ctx.srv.token}/hook/PreToolUse`, pre, { method: 'GET' })).status, 404);
  assert.equal((await ctx.request(`/${ctx.srv.token}/hook/PreToolUse?x=1`, pre)).status, 200);
  assert.deepEqual(ctx.log.map((e) => e[0]), ['hook']);
});

test('JSON이 깨지면 붙잡지 않고 빈 본문 200으로 답한다', { timeout: 10000 }, async (t) => {
  const ctx = await start(t);
  for (const eventName of ['PreToolUse', 'PermissionRequest', 'Stop']) {
    for (const raw of ['{"session_id": ', '', 'not json', '[]', 'null', '"문자열"']) {
      const res = await ctx.hook(eventName, raw);
      assert.deepEqual([res.status, res.body], [200, ''], `${eventName} ${JSON.stringify(raw)}`);
    }
  }
  assert.equal(ctx.log.length, 0);
});

test('본문을 다 보내기 전에 연결이 끊겨도 서버는 계속 답한다', { timeout: 10000 }, async (t) => {
  const ctx = await start(t);
  const errors = t.mock.method(console, 'error', () => {});
  await new Promise((resolve, reject) => {
    const socket = net.connect(ctx.srv.port, '127.0.0.1', () => {
      socket.write(`POST /${ctx.srv.token}/hook/PermissionRequest HTTP/1.1\r\nHost: x\r\nContent-Length: 500\r\n\r\n{"session_id":`);
      setTimeout(() => {
        socket.destroy();
        resolve();
      }, 100);
    });
    socket.on('error', reject);
  });
  await new Promise((r) => setTimeout(r, 100));
  const res = await ctx.hook('Stop', fixture('006-Stop--.json'));
  assert.deepEqual([res.status, res.body], [200, '']);
  assert.deepEqual(ctx.log.map((e) => [e[0], e[1]]), [['hook', 'Stop']]);
  assert.equal(errors.mock.callCount(), 0);
});

test('동시 요청 50개를 오류 없이 처리한다', { timeout: 20000 }, async (t) => {
  const ctx = await start(t);
  const decisions = new Map();
  ctx.srv.events.on('permission', (p) => {
    const decision = decisions.size % 2 === 0 ? 'allow' : 'deny';
    decisions.set(p.sessionId, decision);
    setImmediate(() => ctx.srv.decide(p.id, decision));
  });

  const jobs = [];
  for (let i = 0; i < 50; i++) {
    const session = `concurrent-${i}`;
    const opts = { agent: false }; // 요청마다 새 연결
    const kind = ['perm', 'perm', 'pre', 'status', 'post'][i % 5];
    if (kind === 'perm') jobs.push([kind, session, ctx.hook('PermissionRequest', withSession(fixture('003-PermissionRequest-Write.json'), session), opts)]);
    if (kind === 'pre') jobs.push([kind, session, ctx.hook('PreToolUse', withSession(fixture('002-PreToolUse-Write.json'), session), opts)]);
    if (kind === 'status') jobs.push([kind, session, ctx.status({ ...STATUS_SAMPLE, session_id: session }, opts)]);
    if (kind === 'post') jobs.push([kind, session, ctx.hook('PostToolUse', withSession(fixture('005-PostToolUse-Write.json'), session), opts)]);
  }
  const results = await Promise.all(jobs.map((j) => j[2]));
  assert.equal(results.length, 50);
  results.forEach((res, i) => {
    const [kind, session] = jobs[i];
    assert.equal(res.status, 200, `${i} ${kind}`);
    if (kind === 'perm') assert.equal(res.body, decisions.get(session) === 'allow' ? ALLOW_JSON : DENY_JSON);
    else if (kind === 'status') assert.equal(res.body, '📁 작업실 · 대화 길이 24%');
    else assert.equal(res.body, '');
  });
  assert.equal(decisions.size, 20);
  assert.equal(cleared(ctx.log).length, 20);
  assert.ok(cleared(ctx.log).every(([, reason]) => reason === 'decided'));
});

test('/statusline은 formatStatusLine 결과를 text/plain으로 주고, 함수가 오류를 내면 작업실을 준다', { timeout: 10000 }, async (t) => {
  assert.equal(STATUS_FALLBACK, '작업실');
  const ctx = await start(t);
  const res = await ctx.status(STATUS_SAMPLE);
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'text/plain; charset=utf-8');
  assert.equal(res.body, '📁 작업실 · 대화 길이 24%');
  assert.deepEqual(ctx.log, [['status', STATUS_SAMPLE, '📁 작업실 · 대화 길이 24%']]);

  // 깨진 JSON
  const broken = await ctx.status('{"workspace": ');
  assert.deepEqual([broken.status, broken.body], [200, '작업실']);

  // 함수가 오류를 낼 때
  const errors = t.mock.method(console, 'error', () => {});
  const failing = await start(t, {
    formatStatusLine: () => {
      throw new Error('상태 줄 오류');
    },
  });
  const failed = await failing.status(STATUS_SAMPLE);
  assert.deepEqual([failed.status, failed.headers['content-type'], failed.body], [200, 'text/plain; charset=utf-8', '작업실']);
  assert.deepEqual(failing.log, [['status', STATUS_SAMPLE, '작업실']]);
  assert.equal(errors.mock.callCount(), 1);

  // 함수가 문자열이 아닌 값을 주거나 없을 때
  const odd = await start(t, { formatStatusLine: () => undefined });
  assert.equal((await odd.status(STATUS_SAMPLE)).body, '작업실');
  const none = await start(t, { formatStatusLine: undefined });
  assert.equal((await none.status(STATUS_SAMPLE)).body, '작업실');
});

test('화면 쪽 처리에서 오류가 나도 claude에게는 그대로 답한다', { timeout: 10000 }, async (t) => {
  const ctx = await start(t);
  const errors = t.mock.method(console, 'error', () => {});
  for (const name of ['hook', 'permission', 'permission-cleared', 'status']) {
    ctx.srv.events.on(name, () => {
      throw new Error('화면 쪽 오류');
    });
  }
  assert.deepEqual(await ctx.hook('PreToolUse', fixture('002-PreToolUse-Write.json')).then((r) => [r.status, r.body]), [200, '']);
  assert.equal((await ctx.status(STATUS_SAMPLE)).body, '📁 작업실 · 대화 길이 24%');

  const response = ctx.hook('PermissionRequest', fixture('003-PermissionRequest-Write.json'));
  const [, pending] = await waitFor(() => ctx.log.find((e) => e[0] === 'permission'));
  assert.equal(ctx.srv.decide(pending.id, 'allow'), true);
  assert.equal((await response).body, ALLOW_JSON);
  assert.ok(errors.mock.callCount() >= 4, `console.error ${errors.mock.callCount()}번`);
});

test('서버를 닫으면 붙잡은 요청을 빈 본문 200으로 풀고 더는 받지 않는다', { timeout: 10000 }, async (t) => {
  const ctx = await start(t);
  await ctx.hook('PreToolUse', fixture('002-PreToolUse-Write.json'));
  const p = await holdPermission(ctx, fixture('003-PermissionRequest-Write.json'));
  await ctx.srv.close();
  assert.deepEqual(await p.response.then((r) => [r.status, r.body]), [200, '']);
  assert.deepEqual(cleared(ctx.log), [[p.pending.id, 'server-closed']]);
  await assert.rejects(post(ctx.srv.port, `/${ctx.srv.token}/hook/Stop`, fixture('006-Stop--.json')), { code: 'ECONNREFUSED' });
  await ctx.srv.close(); // 두 번 불러도 된다
});

test('127.0.0.1에만 열려 바깥 주소로는 붙지 않는다', { timeout: 10000 }, async (t) => {
  const ctx = await start(t);
  assert.equal((await ctx.hook('Notification', fixture('004-Notification--.json'))).status, 200);
  const lan = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal);
  if (!lan) {
    t.skip('바깥 IPv4 주소가 없어 건너뜁니다');
    return;
  }
  const connect = () =>
    new Promise((resolve, reject) => {
      const socket = net.connect({ host: lan.address, port: ctx.srv.port, timeout: 2000 });
      socket.once('connect', () => {
        socket.destroy();
        resolve('connected');
      });
      socket.once('timeout', () => {
        socket.destroy();
        reject(new Error('timeout'));
      });
      socket.once('error', reject);
    });
  await assert.rejects(connect(), { code: 'ECONNREFUSED' });
});
