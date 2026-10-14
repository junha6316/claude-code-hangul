# 클로드 코드 한글판 (비공식)

> Anthropic과 관계없는 개인 프로젝트입니다. Anthropic이 만들거나 보증한 앱이 아닙니다. "Claude"와 "Claude Code"는 Anthropic의 상표입니다.

터미널과 영어가 낯선 사람도 Claude Code를 쓸 수 있게 돕는 macOS 앱 시제품입니다. 공식 `claude` 프로그램을 고치지 않고 그대로 띄우고, 그 위에 한국어 안내를 더합니다.

## 하는 일

- 앱 창 안의 터미널에서 공식 Claude Code를 실행합니다. 깔려 있지 않으면 공식 설치 스크립트로 설치합니다.
- 터미널에 뜨는 영어 안내(폴더 신뢰 확인, 시작 머리말, 모드 줄, 허락 창, 흔한 오류)를 같은 자리에 한국어로 덮어 보여 줍니다. "영어 원문 보기" 버튼으로 끌 수 있습니다.
- 파일 수정이나 명령 실행 허락을 옆 패널에 한국어 카드로 보여 주고, 진행 기록을 한국어로 남깁니다.
- 창이 좁아지면 글자를 줄여 한 줄 칸 수를 지킵니다.

## 하지 않는 일

- `claude` 프로그램을 고치거나 이 앱에 넣어 배포하지 않습니다.
- 로그인 정보를 받거나 저장하지 않습니다. 로그인은 Claude Code의 공식 화면에서 각자 합니다.
- 사용자의 `~/.claude/settings.json`을 고치지 않습니다. 앱 설정은 `--settings`로 따로 넘깁니다.

## 필요한 것

- macOS. Windows는 아직 시험하지 않았습니다.
- Claude Pro 이상 요금제나 Anthropic API 키. 무료 요금제로는 Claude Code를 쓸 수 없습니다.
- Node.js와 npm(지금은 설치 파일 없이 소스로 실행합니다)

## 빠른 실행

```sh
npm ci      # 처음 한 번. Electron 실행 파일도 이때 받습니다
npm start
```

## 알려진 문제

- 상태 줄의 📁 뒤에 지난 글자가 남을 때가 있습니다(이모지 폭 차이).
- 도구 실행 줄(`⏺ Write(…)`, `⎿ Wrote…`)은 아직 영어로 보입니다.
- 설치 파일(.dmg)은 아직 없습니다.

## 라이선스

이 저장소의 코드는 MIT 라이선스입니다. Claude Code 자체는 Anthropic의 약관을 따릅니다.

# 개발자용

## 의존성 버전

모두 정확한 버전으로 고정했고, 2026-09-30 이전에 배포된 판만 씁니다.

| 패키지 | 버전 | 배포일 | 고른 이유 |
|---|---|---|---|
| electron | 44.5.0 | 2026-09-29 | 44.x 중 기준일 이전 마지막 판. 44.7.0은 2026-10-07 배포라 제외 |
| node-pty | 1.2.0-beta.15 | 2026-08-03 | 첫 줄 참고. VS Code main과 같은 줄 |
| @xterm/xterm | 6.1.0-beta.304 | 2026-08-30 | 한글 조합 수정(#5759, #5698, #5747)이 6.1 beta에만 있음. VS Code 1.140과 같은 판 |
| @xterm/addon-fit | 0.12.0-beta.301 | 2026-08-30 | 위 xterm과 같은 커밋(c58ea36) |
| @xterm/headless | 6.1.0-beta.303 | 2026-08-30 | 위 xterm과 같은 커밋(c58ea36) |
| playwright | 1.63.0 | 2026-09-04 | 기준일 이전 마지막 판. 1.64.0은 2026-10-07 배포라 제외 |

node-pty는 `1.2.0-beta.15`를 씁니다. Electron 44.5.0 main 프로세스와 `ELECTRON_RUN_AS_NODE=1` 양쪽에서 다시 빌드 없이 돌았고(`npm run smoke`), 이 판은 `spawn-helper`에 실행 권한이 들어 있어 따로 권한을 줄 필요가 없습니다(1.1.0은 권한이 빠져 `posix_spawnp failed`가 났습니다).

Electron 44는 설치할 때 실행 파일을 받지 않고 처음 실행할 때 받습니다. `npm ci` 직후 바로 쓸 수 있게 `postinstall`에서 `install-electron`을 부릅니다.

## 명령

- `npm start`: 앱 실행
- `npm test`: 단위 시험(`test/*.test.js`, 단 `e2e-*` 제외)
- `npm run smoke`: 숨긴 창으로 Electron과 node-pty 연기 시험
- `npm run e2e:ui`, `npm run e2e:app`: 화면·통합 시험

시험 산출물은 `.test-tmp/<작업 ID>/`에 남고 git에서 빠집니다.

## 실행 방법

```sh
npm ci
npm start
```

켜지면 이 순서로 준비합니다(`src/main/app.js`).

1. 작업 폴더 `~/Documents/작업실`을 만듭니다.
2. 로그인 셸(`$SHELL -ilc`)의 환경을 읽습니다. Finder에서 켜도 Homebrew 같은 도구 경로가 claude에 넘어갑니다.
3. claude가 깔려 있는지 봅니다. 없으면 설치 화면이 뜨고, "설치하기"를 누르면 공식 설치 스크립트(stable)를 돌립니다.
4. 훅·상태 줄을 받을 서버를 `127.0.0.1`에 엽니다.
5. 한국어 설정 파일 `kct-settings.json`을 앱 데이터 폴더(macOS는 `~/Library/Application Support/클로드 코드 한글판 (비공식)`)에 씁니다.
6. 작업 폴더에서 `claude --settings <설정 파일>`을 띄웁니다. 사용자의 `~/.claude/settings.json`은 건드리지 않습니다.

"새 대화"는 claude를 끄고 같은 설정으로 다시 띄웁니다. 창을 닫으면 claude와 서버를 정리하고 끝납니다.

### 환경 변수

| 이름 | 하는 일 |
|---|---|
| `KCT_WORKDIR` | 작업 폴더를 바꿉니다. 기본은 `~/Documents/작업실` |
| `KCT_CLAUDE_PATH` | 띄울 claude를 바꿉니다. `.js`면 node로 돌립니다(시험용 `test/fixtures/fake-claude.js`) |
| `KCT_TEST` | `1`이면 창을 포커스 없이 띄웁니다 |

앱 데이터 폴더는 Electron의 `--user-data-dir=<폴더>`로 바꿀 수 있습니다. 통합 시험은 이것으로 `.test-tmp/T9/` 아래를 씁니다.

가짜 claude로 화면만 보려면:

```sh
KCT_CLAUDE_PATH="$PWD/test/fixtures/fake-claude.js" KCT_WORKDIR="$PWD/.test-tmp/manual/work" \
  npx electron . --user-data-dir="$PWD/.test-tmp/manual/user-data"
```

### 통합 시험(`npm run e2e:app`)

실제 claude 시험은 `.test-tmp/T9/` 아래의 가짜 설정 폴더(`CLAUDE_CONFIG_DIR`)와 가짜 API 키로만 돌고, 모델을 부르지 않습니다. `~/.local/bin/claude`가 없으면 그 시험은 건너뜁니다. 시험 전후로 실제 `~/.claude/settings.json` 수정 시각이 그대로인지도 확인합니다.
