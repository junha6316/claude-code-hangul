# 영어 화면 시험 자료

`src/main/screenGuide.js`의 `detectScreen`이 알아봐야 하는 화면과, 안내를 띄우면 안 되는 화면을 모은 것입니다. 파일마다 기대하는 `id`(안내를 띄우면 안 되면 `null`)와 만든 방법은 `manifest.json`에 있습니다.

## 실제 캡처

claude 2.1.296을 가짜 설정 폴더로 띄우고 tmux 화면을 캡처했습니다. 저장소의 `app` 폴더에서 다시 캡처할 수 있습니다.

```sh
cd app && node test/screenGuide.live.js --capture
```

- 가짜 설정은 `test/helpers/fakeClaudeHome.js`로 만듭니다. 실제 `~/.claude`, `~/.claude.json`은 쓰지 않습니다.
- claude를 띄우는 tmux 명령의 모양: `tmux -u -L <고유 소켓> new-session -d -x <칸> -y <줄> -c <작업 폴더> /usr/bin/env -i <가짜 설정 환경> ~/.local/bin/claude`. 칸·줄과 가짜 설정 선택지는 `manifest.json`의 `launch`에 있습니다.
- 앞 화면에서 보낸 키는 `before`에 있습니다. 키는 `tmux send-keys -H`로 바이트 그대로 보냈습니다(`0d`는 Enter).
- 환경 변수에 `BROWSER=/usr/bin/true`를 넣어 로그인 화면에서 실제 브라우저가 열리지 않게 했습니다.
- 캡처한 글에서 홈 폴더 경로는 `/Users/tester`로 바꾸고 끝의 빈 줄은 뺐습니다. 나머지는 그대로입니다.

`permission-*.txt`, `idle-after-work.txt`, `idle-hook-errors.txt`는 훅 시험 때 실제 claude 2.1.296에서 캡처한 `review/hook/runs/rB/caps/` 파일을 같은 방식으로 옮긴 것입니다. 허락 창은 실제 모델 요청이 있어야 떠서 이 방법으로만 구했습니다.

## 손으로 만든 자료(`*.synthetic.txt`)

실제 캡처가 아닙니다. 가짜 설정으로는 띄울 수 없는 사용 한도 화면과, 안내가 뜨면 안 되는 경우를 시험하려고 `auth-error.txt` 캡처의 배치에 몇 줄만 바꿔 만들었습니다. 문구는 공식 문서 예시를 그대로 옮겼습니다.

- 사용 한도 문구: https://code.claude.com/docs/en/errors#youve-hit-your-session-limit
- 한도가 풀리기를 기다리는 줄: https://code.claude.com/docs/en/interactive-mode#wait-for-a-usage-limit-to-reset (실제 화면에서 이 줄이 놓이는 자리는 확인하지 못했습니다)
