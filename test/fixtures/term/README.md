# 터미널 영어 줄 시험 자료 (T10)

`src/shared/termKorean.js`의 `translateScreen`이 덮어야 하는 줄과 덮으면 안 되는 줄을 모은 것입니다. 시험은 `test/termKorean.test.js`입니다.

## 자료마다 붙는 기대값

화면 파일 옆(또는 이 폴더)에 `<이름>.expected.json`이 있습니다.

```json
{ "file": "…(다른 곳의 화면을 가리킬 때만)", "cols": 120, "cursorRow": 13, "mustCover": [2, 6], "mustNotCover": [4], "source": "…" }
```

- `cols`는 화면 폭, `cursorRow`는 커서가 있던 줄입니다. 커서 위치를 모르는 자료는 -1입니다.
- `mustCover`·`mustNotCover`의 줄 번호는 `make-expected.js`의 줄 글 표로 정했습니다. 번역 함수의 결과를 보고 정하지 않았습니다. 화면을 다시 캡처하면 `node test/fixtures/term/make-expected.js`로 다시 채웁니다.
- 커서 줄은 `mustCover`에 넣지 않습니다. 커서 줄은 덮지 않는 것이 공통 약속입니다.

## 폴더

| 폴더 | 내용 | 만든 방법 |
| --- | --- | --- |
| `v2.1.299/` | 실제 claude 2.1.299 화면 35개(80칸·120칸 16쌍, 덮으면 안 되는 / 메뉴·? 도움말·/help 120칸 3개) | `cd app && node test/fixtures/term/capture.js`. 캡처 방법, 화면마다 찍은 시각과 커서 위치는 `v2.1.299/manifest.json` |
| `review/` | 실제 모델 요청이 있어야 뜨는 화면 9개(허락 창, 중단됨, 일하는 중 모드 줄) | 저장소 `review/`의 10/13 캡처(claude 2.1.296)를 `capture.js --copy-review`로 옮김 |
| `user/` | 사용자가 실제 계정으로 띄워 붙여 넣은 화면 3개 | 읽기만 합니다. 기대값은 이 폴더의 `user-*.expected.json` |
| `t6/` | T6의 2.1.296 캡처(`test/fixtures/screens/`)에 대한 기대값 22개 | 화면은 T6 폴더 것을 그대로 가리킵니다 |
| `negative-lines.json` | 덮으면 안 되는 영어 줄 44개 | 손으로 씀. 시험이 줄마다 세 자리(홀로, 대화 기록 안, 대화 상자 안)에 넣어 봅니다 |

## 캡처 규칙

- 실제 `~/.claude`, `~/.claude.json`은 쓰지 않습니다. `test/helpers/fakeClaudeHome.js`의 가짜 설정 폴더와 가짜 키만 씁니다. 캡처가 끝나면 실제 `~/.claude.json`의 `projects`와 `~/.claude/settings.json` 수정 시각이 그대로인지 확인합니다.
- 가짜 `.claude.json`의 `lastReleaseNotesSeen`을 지금 버전으로 바꿔 "새로 바뀐 점" 화면이 끼어들지 않게 합니다.
- 새 MCP 서버 창은 작업 폴더에 `.mcp.json`(명령 `/usr/bin/false`)을 두고 띄웁니다. 창에서 멈추므로 명령은 실행되지 않습니다.
- 모드 줄은 입력 대기에서 shift+tab(`1b 5b 5a`)을 보내며 바뀔 때마다 찍습니다.
- `auth-error-*`만 가짜 키로 요청을 보냅니다. 인증 오류로 끝나고 실제 모델은 부르지 않습니다.
- 화면 글에서 실제 홈 폴더 경로는 `/Users/tester`로 바꾸고, 줄 끝 공백만 지웁니다. 줄 수는 화면 그대로입니다.

## 알아 둘 것

- 커서 위치는 화면을 찍는 바로 그 tmux 호출에서 같이 읽습니다(`capture.js`의 `shot`). 예전에는 시나리오가 끝난 뒤에 읽어서 한 시나리오의 화면들이 마지막 화면의 커서를 같이 썼고, 그 탓에 커서 줄이 틀린 자료 8개가 있었습니다. 지금 자료는 고친 `capture.js`로 다시 찍은 것입니다.
- claude 2.1.299가 커서를 두는 자리는 이렇습니다. 시험(`캡처 기록의 커서가 그 화면에서 말이 된다`)이 캡처 기록의 커서를 이 규칙과 맞춰 봅니다.
  - 입력 칸(가로줄 바로 아래 `❯` 줄)이 있으면 그 입력 줄. `/` 메뉴나 `?` 도움말이 열려 있어도 입력 줄입니다.
  - 입력 칸이 없고 고르기 목록이 있으면 고른 줄의 `❯` 표시 위(예: 신뢰 창의 `❯ No, exit`, 테마 창의 `❯ ✔ Dark mode`). 커서는 숨겨져 있습니다.
  - 둘 다 없으면 그린 글 아래 빈 줄(보안 안내, 브라우저 로그인 대기). `/help`에서는 고른 탭 이름(`General`) 위입니다.
- 약속대로 커서 줄은 덮지 않으므로, 앱이 커서가 숨었을 때도 그 줄 번호를 넘기면 고른 줄만 영어로 남습니다. xterm의 `term.modes.showCursor`가 거짓이면 `cursorRow: -1`을 넘기면 됩니다.
- 사용자 화면(`user/`)은 붙여 넣으면서 로고 글자와 앞뒤 공백이 빠졌습니다. 폭은 줄이 접힌 자리로 짐작했습니다(신뢰·MCP 창 82칸, 머리말 120칸).
