# 훅 시험 자료

`review/hook/runs/rB/requests/`에 남은 실제 요청(claude 2.1.296)에서 `body`만 꺼낸 것입니다. 파일 이름은 원본과 같습니다(`<순서>-<이벤트>-<도구>.json`).

- 요청을 받은 사람의 홈 폴더 경로는 `/Users/tester`로, 그 경로를 줄표로 바꾼 폴더 이름(`-Users-…`)은 `-Users-tester`로 바꿨습니다. 나머지 값은 원본 그대로입니다.
- `001-SessionStart`는 command 훅(curl)으로, 나머지는 http 훅으로 받은 요청입니다.
- `UserPromptSubmit` 요청은 원본에 없어서 시험에서 hooks 문서의 입력 예시 모양으로 만들어 씁니다.

만든 명령(원본 요청을 받은 Mac 계정으로, 저장소 루트에서):

```sh
node -e '
const fs = require("fs"), path = require("path");
const home = require("os").homedir();          // 예: /Users/<이름>
const dashed = home.replace(/[\/.]/g, "-");    // 예: -Users-<이름>
const src = "review/hook/runs/rB/requests", dst = "app/test/fixtures/hooks";
for (const f of fs.readdirSync(src).filter((n) => n.endsWith(".json")).sort()) {
  const { body } = JSON.parse(fs.readFileSync(path.join(src, f), "utf8"));
  const text = JSON.stringify(body, null, 2)
    .replaceAll(home, "/Users/tester")
    .replaceAll(dashed, "-Users-tester");
  fs.writeFileSync(path.join(dst, f), text + "\n");
}'
```
