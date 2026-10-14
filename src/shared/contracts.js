// 공통 약속: IPC 채널 이름과 환경 변수 이름 (PLAN.md "공통 약속"과 글자 하나까지 같게 둔다).
// preload.js는 sandbox에서 이 파일을 require할 수 없어 같은 목록을 따로 들고 있다.
// 두 목록이 같은지는 test/smoke.test.js가 확인한다.

// main → renderer
const MAIN_TO_RENDERER = Object.freeze({
  PTY_DATA: 'pty:data', // 문자열
  PTY_EXIT: 'pty:exit', // { code }
  LOG_ADD: 'log:add', // { icon, text, time }
  PERM_SHOW: 'perm:show', // { id, title, detail, danger }
  PERM_CLEAR: 'perm:clear', // { id }
  STATUS_UPDATE: 'status:update', // { text, folderName, contextPercent }
  GUIDE_SHOW: 'guide:show', // guide 또는 null
  INSTALL_STATE: 'install:state', // { installed, version, phase, log }
});

// renderer → main
const RENDERER_TO_MAIN = Object.freeze({
  PTY_INPUT: 'pty:input', // 문자열
  PTY_RESIZE: 'pty:resize', // { cols, rows }
  PERM_DECIDE: 'perm:decide', // { id, decision }
  GUIDE_ACTION: 'guide:action', // { keys }
  SESSION_NEW: 'session:new',
  FOLDER_OPEN: 'folder:open',
  INSTALL_START: 'install:start',
});

const ENV_VARS = Object.freeze({
  CLAUDE_PATH: 'KCT_CLAUDE_PATH', // 띄울 claude 경로(시험에서 가짜 claude)
  WORKDIR: 'KCT_WORKDIR', // 작업 폴더. 기본은 ~/Documents/작업실
  TEST: 'KCT_TEST', // '1'이면 시험 모드(창을 포커스 없이 띄움)
});

module.exports = {
  MAIN_TO_RENDERER,
  RENDERER_TO_MAIN,
  ENV_VARS,
};
