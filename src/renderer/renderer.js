// 화면(T7). preload가 노출한 window.kct = { on, send }만 쓴다.
// 위 막대(폴더·대화 길이·새 대화·폴더 열기), 가운데 터미널(xterm.js), 오른쪽 패널(허락 카드·안내 카드·진행 기록),
// 설치 덮개로 이뤄진다. 화면에 넣는 글은 모두 textContent로 넣는다(HTML로 해석하지 않음).
'use strict';

(() => {
  const kct = window.kct;
  const $ = (id) => document.getElementById(id);

  const MAX_LOG = 200;
  const ANSWERED_HOLD_MS = 1200; // 허락·거절을 누른 뒤 "허락했어요"를 보여 주는 시간
  const GUIDE_REENABLE_MS = 2000; // 안내 버튼을 누른 뒤 다시 누를 수 있게 되기까지

  // ── 터미널 ──
  // 한글은 styles.css의 "KCT Hangul"(한글 글자만, 조금 키운 OS 한글 글꼴)로, 나머지는 영문 고정폭 글꼴로 그린다.
  // "KCT Hangul"을 못 찾는 OS에서는 뒤쪽 한글 글꼴로 넘어간다.
  const TERMINAL_FONT = [
    '"KCT Hangul"', '"SF Mono"', 'Menlo', 'Monaco', '"Cascadia Mono"', 'Consolas', '"DejaVu Sans Mono"',
    '"D2Coding"', '"Apple SD Gothic Neo"', '"Noto Sans Mono CJK KR"', '"Noto Sans CJK KR"',
    '"Malgun Gothic"', '"맑은 고딕"', 'monospace',
  ].join(', ');

  const LIGHT_ANSI = {
    black: '#1d1d1f', red: '#c0262d', green: '#1e7a3c', yellow: '#8a6100', blue: '#1f5fd6',
    magenta: '#8e2bb0', cyan: '#00707a', white: '#5c6066',
    brightBlack: '#6b7077', brightRed: '#d93a3a', brightGreen: '#2f8f4f', brightYellow: '#9c6f00',
    brightBlue: '#2f6fe4', brightMagenta: '#a23fc4', brightCyan: '#00808c', brightWhite: '#3a3d42',
  };

  const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

  function terminalTheme() {
    const css = getComputedStyle(document.documentElement);
    const v = (name) => css.getPropertyValue(name).trim();
    const base = {
      background: v('--term-bg'),
      foreground: v('--term-fg'),
      cursor: v('--term-cursor'),
      cursorAccent: v('--term-bg'),
      selectionBackground: v('--term-selection'),
    };
    return darkQuery.matches ? base : { ...base, ...LIGHT_ANSI };
  }

  const term = new window.Terminal({
    fontFamily: TERMINAL_FONT,
    fontSize: 15,
    lineHeight: 1.2,
    cursorBlink: true,
    scrollback: 5000,
    minimumContrastRatio: 4.5,
    theme: terminalTheme(),
  });
  const fitAddon = new window.FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open($('terminal'));

  darkQuery.addEventListener('change', () => { term.options.theme = terminalTheme(); });

  // 창이 좁아지면 글자를 줄여 한 줄 칸 수를 지킨다. claude가 이미 끊어 그린 줄이 다시 접혀 들쭉날쭉해지지 않게 한다.
  // 넓어져도 기본 크기보다 키우지 않고, 최소 크기에 닿으면 그때부터 칸 수가 줄어든다.
  const FONT_MAX = 15;
  const FONT_MIN = 11;
  const TARGET_COLS = 80;
  const charRatio = (() => {
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.font = `100px ${TERMINAL_FONT}`;
    return ctx.measureText('W').width / 100;
  })();

  function fit() {
    const width = $('terminal').clientWidth;
    if (width > 0) {
      const size = Math.max(FONT_MIN, Math.min(FONT_MAX, Math.floor(width / (TARGET_COLS * charRatio))));
      if (term.options.fontSize !== size) term.options.fontSize = size;
    }
    try { fitAddon.fit(); } catch { /* 화면이 아직 0 크기일 때 */ }
  }
  let fitQueued = false;
  new ResizeObserver(() => {
    if (fitQueued) return;
    fitQueued = true;
    requestAnimationFrame(() => { fitQueued = false; fit(); });
  }).observe($('terminal-wrap'));

  term.onData((data) => kct.send('pty:input', data));
  let lastSize = '';
  function sendSize(cols, rows) {
    const key = `${cols}x${rows}`;
    if (key === lastSize) return;
    lastSize = key;
    kct.send('pty:resize', { cols, rows });
  }
  term.onResize(({ cols, rows }) => sendSize(cols, rows));

  function focusTerminal() {
    requestAnimationFrame(() => term.focus());
  }

  // ── 영어 줄 덮개 ──
  // 알아본 영어 줄 위에 한국어를 겹쳐 그린다(overlay.js). 번역 규칙(../shared/termKorean.js)이 없으면
  // 덮개를 끄고 "영어 원문 보기" 버튼도 숨긴다. 켜고 끈 선택은 이 컴퓨터에 기억한다(저장이 안 돼도 동작).
  const OVERLAY_PREF_KEY = 'kct:overlay';
  const termKorean = window.KctTermKorean;
  const translate = termKorean && typeof termKorean.translateScreen === 'function'
    ? (lines, opts) => termKorean.translateScreen(lines, opts)
    : null;
  const overlay = window.KctOverlay ? window.KctOverlay.attach(term, { translate }) : null;
  const btnOriginal = $('btn-original');

  function showKorean(on) {
    overlay.setEnabled(on);
    btnOriginal.textContent = on ? '영어 원문 보기' : '한국어로 보기';
    btnOriginal.title = on
      ? '터미널의 영어 문구를 한국어로 덮지 않고 원래 영어로 보여 줘요'
      : '터미널의 영어 문구를 다시 한국어로 덮어서 보여 줘요';
  }

  if (overlay && translate) {
    let on = true;
    try { on = localStorage.getItem(OVERLAY_PREF_KEY) !== 'off'; } catch { /* 저장소를 못 쓰면 켠 채로 */ }
    showKorean(on);
    btnOriginal.hidden = false;
    btnOriginal.addEventListener('click', () => {
      const next = !overlay.isEnabled();
      showKorean(next);
      try { localStorage.setItem(OVERLAY_PREF_KEY, next ? 'on' : 'off'); } catch { /* 기억하지 못해도 지금 화면은 바뀐다 */ }
      focusTerminal();
    });
  } else {
    if (overlay) overlay.setEnabled(false);
    btnOriginal.hidden = true;
  }

  kct.on('pty:data', (data) => {
    if (typeof data === 'string' && data) term.write(data);
  });
  kct.on('pty:exit', () => {
    term.write('\r\n\x1b[2m대화가 끝났어요. 위쪽 "새 대화" 버튼을 누르면 다시 시작해요.\x1b[0m\r\n');
  });

  // ── 위 막대 ──
  function clampPercent(n) {
    const x = Number(n);
    if (!Number.isFinite(x)) return null;
    return Math.max(0, Math.min(100, Math.round(x)));
  }

  kct.on('status:update', (s) => {
    const st = s || {};
    $('folder-name').textContent = (typeof st.folderName === 'string' && st.folderName.trim()) || '작업실';
    const pct = clampPercent(st.contextPercent);
    const shown = pct === null ? 0 : pct;
    $('context-fill').style.width = `${shown}%`;
    $('context-meter').setAttribute('aria-valuenow', String(shown));
    $('context-text').textContent = pct === null ? '0%' : `${pct}%`;
    const warn = pct !== null && pct >= 80;
    $('context').classList.toggle('warn', warn);
    $('context-hint').hidden = !warn;
    if (typeof st.text === 'string' && st.text) $('context').title = st.text;
  });

  // ── 진행 기록 ──
  function formatTime(t) {
    const d = t === undefined || t === null ? new Date() : new Date(t);
    const ok = !Number.isNaN(d.getTime());
    return (ok ? d : new Date()).toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' });
  }

  kct.on('log:add', (entry) => {
    const e = entry || {};
    if (!e.text) return;
    const li = document.createElement('li');
    const icon = document.createElement('span');
    icon.className = 'icon';
    icon.textContent = e.icon || '•';
    const text = document.createElement('span');
    text.className = 'text';
    text.textContent = String(e.text);
    const time = document.createElement('time');
    time.textContent = formatTime(e.time);
    li.append(icon, text, time);
    const log = $('log');
    log.prepend(li); // 최근 것이 위로
    while (log.children.length > MAX_LOG) log.lastElementChild.remove();
    $('log-empty').hidden = true;
  });

  // ── 허락 카드 ──
  function button(label, className, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `btn ${className}`;
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  function findPermCard(id) {
    return [...$('perm-area').children].find((el) => el.dataset.id === String(id)) || null;
  }

  kct.on('perm:show', (p) => {
    if (!p || p.id === undefined || p.id === null) return;
    const id = String(p.id);
    const old = findPermCard(id);
    if (old) old.remove();

    const card = document.createElement('div');
    card.className = `card perm${p.danger ? ' danger' : ''}`;
    card.dataset.id = id;
    card.setAttribute('role', 'alertdialog');

    const label = document.createElement('div');
    label.className = 'card-label';
    label.textContent = p.danger ? '⚠️ 조심해야 하는 일이에요' : '허락이 필요해요';
    const title = document.createElement('h3');
    title.textContent = p.title || '이 일을 해도 될까요?';
    card.append(label, title);
    if (p.detail) {
      const detail = document.createElement('p');
      detail.className = 'detail';
      detail.textContent = String(p.detail);
      card.append(detail);
    }

    const actions = document.createElement('div');
    actions.className = 'actions';
    const decide = (decision) => {
      kct.send('perm:decide', { id: p.id, decision });
      const done = document.createElement('div');
      done.className = 'answered';
      done.textContent = decision === 'allow' ? '허락했어요' : '거절했어요';
      actions.replaceWith(done);
      setTimeout(() => card.remove(), ANSWERED_HOLD_MS);
      focusTerminal();
    };
    actions.append(
      button('허락', 'primary allow', () => decide('allow')),
      button('거절', 'deny', () => decide('deny')),
    );
    card.append(actions);
    $('perm-area').append(card); // 먼저 온 것이 위
  });

  kct.on('perm:clear', (p) => {
    const card = p ? findPermCard(p.id) : null;
    if (card) card.remove();
  });

  // ── 안내 카드 ──
  kct.on('guide:show', (g) => {
    const area = $('guide-area');
    area.textContent = '';
    if (!g) {
      area.hidden = true;
      return;
    }
    const card = document.createElement('div');
    card.className = 'card guide';
    card.dataset.guideId = g.id || '';
    const label = document.createElement('div');
    label.className = 'card-label';
    label.textContent = '화면 안내';
    const title = document.createElement('h3');
    title.textContent = g.title || '';
    card.append(label, title);
    if (g.body) {
      const body = document.createElement('p');
      body.textContent = String(g.body);
      card.append(body);
    }
    const actions = document.createElement('div');
    actions.className = 'actions';
    const buttons = [];
    for (const a of Array.isArray(g.actions) ? g.actions : []) {
      if (!a || typeof a.keys !== 'string') continue;
      const b = button(a.label || '확인', a.primary ? 'primary' : '', () => {
        kct.send('guide:action', { keys: a.keys });
        // 두 번 눌려 키가 두 번 가지 않게 잠깐 막는다. 화면이 바뀌면 main이 새 안내를 보낸다.
        for (const x of buttons) x.disabled = true;
        setTimeout(() => { for (const x of buttons) x.disabled = false; }, GUIDE_REENABLE_MS);
        focusTerminal();
      });
      buttons.push(b);
      actions.append(b);
    }
    if (buttons.length) card.append(actions);
    area.append(card);
    area.hidden = false;
  });

  // ── 설치 덮개 ──
  const PHASE_TEXT = {
    checking: '설치돼 있는지 확인하고 있어요…',
    installing: '설치하고 있어요. 끝날 때까지 창을 닫지 말아 주세요.',
    failed: '설치하지 못했어요. 인터넷 연결을 확인하고 다시 눌러 주세요.',
    error: '설치하지 못했어요. 인터넷 연결을 확인하고 다시 눌러 주세요.',
    done: '설치를 마쳤어요.',
  };

  kct.on('install:state', (s) => {
    const st = s || {};
    const overlay = $('install-overlay');
    if (st.installed === true) {
      overlay.hidden = true;
      focusTerminal();
      return;
    }
    overlay.hidden = false;
    const phase = typeof st.phase === 'string' ? st.phase : '';
    const phaseEl = $('install-phase');
    phaseEl.textContent = PHASE_TEXT[phase] || '';
    phaseEl.classList.toggle('error', phase === 'failed' || phase === 'error');
    phaseEl.classList.toggle('ok', phase === 'done');

    const btn = $('btn-install');
    const busy = phase === 'installing' || phase === 'checking';
    btn.disabled = busy;
    btn.textContent = busy ? '설치하는 중…' : (phase === 'failed' || phase === 'error') ? '다시 설치하기' : '설치하기';

    const logEl = $('install-log');
    const text = Array.isArray(st.log) ? st.log.join('\n') : (typeof st.log === 'string' ? st.log : '');
    logEl.textContent = text;
    logEl.hidden = !text;
    logEl.scrollTop = logEl.scrollHeight;
  });

  $('btn-install').addEventListener('click', () => {
    $('btn-install').disabled = true;
    $('install-phase').textContent = PHASE_TEXT.installing;
    kct.send('install:start');
  });

  // ── 위 막대 버튼 ──
  $('btn-new').addEventListener('click', () => {
    // 앞 대화의 화면·카드는 새 대화와 상관없으니 비운다.
    term.reset();
    $('perm-area').textContent = '';
    $('guide-area').textContent = '';
    $('guide-area').hidden = true;
    kct.send('session:new');
    focusTerminal();
  });
  $('btn-folder').addEventListener('click', () => {
    kct.send('folder:open');
    focusTerminal();
  });

  // ── 시작 ──
  fit();
  sendSize(term.cols, term.rows);
  term.focus();
  document.documentElement.dataset.ready = '1';
})();
