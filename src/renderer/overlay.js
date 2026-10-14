// 터미널 영어 줄 덮개(T11). claude가 보낸 출력은 그대로 xterm.js에 그리고, 화면에 보이는 줄을 읽어 번역 함수에 넘긴 뒤
// 돌려받은 덮개마다 .kct-ko 요소를 같은 자리에 겹쳐 그린다. 덮개는 보이기만 한다(pointer-events: none이라
// 클릭·선택·한글 입력은 그대로 터미널로 간다).
//
//   const overlay = window.KctOverlay.attach(term, { translate });
//   overlay.setEnabled(false);   // 영어 원문 보기
//
// translate(lines, { cursorRow, cols }) → Overlay[]  (PLAN.md "공통 약속 (3판)", src/shared/termKorean.js)
//   lines: 보이는 줄의 글자. 0번이 맨 위 줄. cursorRow: 커서가 있는 줄(화면 밖이거나 커서를 숨겼으면 -1).
//   Overlay = { row, col, rows, width, text, kind }
// 약속을 어긴 덮개(범위 밖, 커서 줄, 다른 덮개와 겹침)는 그리지 않는다.
// 위치는 .xterm-screen 크기를 cols·rows로 나눈 칸 크기로 정한다(xterm 비공개 API는 쓰지 않는다).
'use strict';

(() => {
  const LAYER_ID = 'kct-overlay';

  function sameLines(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  // 약속을 지킨 덮개만 앞에서부터 받는다.
  function acceptOverlays(list, lineCount, cols, cursorRow) {
    const out = [];
    if (!Array.isArray(list)) return out;
    for (const o of list) {
      if (!o || typeof o.text !== 'string') continue;
      const { row, col, rows, width } = o;
      if (![row, col, rows, width].every(Number.isInteger)) continue;
      if (row < 0 || col < 0 || rows < 1 || width < 1) continue;
      if (row + rows > lineCount || col + width > cols) continue;
      if (cursorRow >= row && cursorRow < row + rows) continue;
      const overlaps = out.some((p) => row < p.row + p.rows && p.row < row + rows && col < p.col + p.width && p.col < col + width);
      if (overlaps) continue;
      out.push({ row, col, rows, width, text: o.text, kind: typeof o.kind === 'string' ? o.kind : '' });
    }
    return out;
  }

  function attach(term, { translate } = {}) {
    const screen = term && term.element ? term.element.querySelector('.xterm-screen') : null;
    if (!screen) throw new Error('터미널을 먼저 화면에 붙여야 해요(term.open)');

    const canDraw = typeof translate === 'function';
    const layer = document.createElement('div');
    layer.id = LAYER_ID;
    layer.setAttribute('aria-hidden', 'true'); // 화면 읽기 프로그램은 터미널 글을 읽는다
    screen.appendChild(layer);

    let enabled = canDraw;
    let disposed = false;
    let frame = 0;
    let force = true;
    let warned = false;
    let last = { lines: [], cursorRow: -2, cols: 0, list: [] };
    const els = []; // 그려 둔 .kct-ko (재사용)
    const applied = []; // els[i]에 마지막으로 넣은 값

    function readScreen() {
      const buf = term.buffer.active;
      const rows = term.rows;
      const top = buf.viewportY;
      const lines = new Array(rows);
      for (let y = 0; y < rows; y++) {
        const line = buf.getLine(top + y);
        lines[y] = line ? line.translateToString(true) : '';
      }
      const c = buf.baseY + buf.cursorY - top;
      // claude는 신뢰 창·MCP 창에서 커서를 숨긴 채(ESC [?25l) 고른 줄(❯)에 둔다. 숨긴 커서는 커서 줄로 치지 않는다.
      const shown = !term.modes || term.modes.showCursor !== false;
      return { lines, cursorRow: shown && c >= 0 && c < rows ? c : -1 };
    }

    function paint(list, cols, rows, cursorRow) {
      const rect = screen.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const cw = rect.width / cols;
      const ch = rect.height / rows;
      const ls = layer.style;
      const font = `${term.options.fontSize}px`;
      if (ls.fontFamily !== term.options.fontFamily) ls.fontFamily = term.options.fontFamily;
      if (ls.fontSize !== font) ls.fontSize = font;
      if (ls.lineHeight !== `${ch}px`) ls.lineHeight = `${ch}px`;
      layer.dataset.cols = String(cols);
      layer.dataset.rows = String(rows);
      layer.dataset.cursorRow = String(cursorRow);

      for (let i = 0; i < list.length; i++) {
        const o = list[i];
        let el = els[i];
        if (!el) {
          el = document.createElement('div');
          el.className = 'kct-ko';
          layer.appendChild(el);
          els.push(el);
          applied.push('');
        }
        const key = `${o.row},${o.col},${o.rows},${o.width},${o.kind},${cw},${ch}\n${o.text}`;
        if (applied[i] === key) continue;
        applied[i] = key;
        const s = el.style;
        s.left = `${o.col * cw}px`;
        s.top = `${o.row * ch}px`;
        s.width = `${o.width * cw}px`;
        s.height = `${o.rows * ch}px`;
        el.dataset.row = String(o.row);
        el.dataset.col = String(o.col);
        el.dataset.rows = String(o.rows);
        el.dataset.width = String(o.width);
        el.dataset.kind = o.kind;
        el.textContent = o.text;
      }
      while (els.length > list.length) {
        els.pop().remove();
        applied.pop();
      }
    }

    function draw() {
      frame = 0;
      if (disposed || !enabled) return;
      const cols = term.cols;
      const rows = term.rows;
      const { lines, cursorRow } = readScreen();
      let list = last.list;
      if (force || cols !== last.cols || cursorRow !== last.cursorRow || !sameLines(lines, last.lines)) {
        let raw = [];
        try {
          raw = translate(lines, { cursorRow, cols });
        } catch (e) {
          // 번역 함수가 실패해도 터미널은 영어 그대로 쓸 수 있게 둔다. 매 장면마다 남기지 않게 한 번만 알린다.
          if (!warned) { warned = true; console.warn('[overlay] 번역 함수가 실패해서 이 화면은 덮지 않아요', e); }
        }
        list = acceptOverlays(raw, rows, cols, cursorRow);
        last = { lines, cursorRow, cols, list };
      }
      force = false;
      layer.hidden = false;
      paint(list, cols, rows, cursorRow);
    }

    // 한 프레임에 한 번만 그린다.
    function schedule() {
      if (disposed || !enabled || frame) return;
      frame = requestAnimationFrame(draw);
    }

    const subs = [
      term.onRender(schedule),
      term.onScroll(schedule),
      term.onResize(schedule),
    ];

    // 버튼으로 켜고 끌 때는 다음 프레임을 기다리지 않고 바로 바꾼다.
    function setEnabled(on) {
      enabled = !!on && canDraw;
      if (!enabled) {
        layer.hidden = true;
        return;
      }
      if (frame) cancelAnimationFrame(frame);
      force = true;
      draw();
    }

    function refresh() {
      force = true;
      schedule();
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      for (const d of subs) d.dispose();
      layer.remove();
    }

    layer.hidden = !enabled;
    schedule();
    return { setEnabled, isEnabled: () => enabled, refresh, dispose };
  }

  window.KctOverlay = Object.freeze({ attach });
})();
