#!/usr/bin/env bash
# T8 완성 조건 3: 깨끗한 Linux arm64 컨테이너(node 24 + curl, 호스트 ~/.claude를 붙이지 않음)에서
# installClaude로 실제 설치하고, checkClaude와 ~/.local/bin/claude --version으로 확인한다.
# 덤으로 인터넷이 끊긴 컨테이너에서 설치가 실패로 보고되는지도 본다.
# 끝나면(실패해도) 컨테이너와 이미지 태그를 지운다. 로그: .test-tmp/T8/container/run.log
#
# 쓰는 법: cd app && bash test/container/run-installer-test.sh
set -euo pipefail

APP="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$APP/.test-tmp/T8/container"
CTX="$OUT/context"
TAG="kct-installer-test:t8-$$"
NAME="kct-installer-t8-$$"
OFFLINE="kct-installer-t8-offline-$$"
PLATFORM="linux/arm64"

cleanup() {
  docker rm -f "$NAME" "$OFFLINE" >/dev/null 2>&1 || true
  docker rmi -f "$TAG" >/dev/null 2>&1 || true
}
trap cleanup EXIT

rm -rf "$OUT"
mkdir -p "$CTX/src/main" "$CTX/src/shared"
exec > >(tee "$OUT/run.log") 2>&1

step() { printf '\n== %s\n' "$*"; }
fail() { echo "FAIL: $*"; exit 1; }

cp "$APP/src/main/installer.js" "$APP/src/main/env.js" "$CTX/src/main/"
cp "$APP/src/shared/contracts.js" "$CTX/src/shared/"

# 컨테이너 안에서 도는 확인 스크립트. online: 실제 설치, offline: 인터넷 없이 실패 보고.
cat > "$CTX/driver.js" <<'EOF'
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { checkClaude, installCommand, installClaude } = require('./src/main/installer');

const mode = process.argv[2];
const home = os.homedir();
const launcher = path.join(home, '.local', 'bin', 'claude');

(async () => {
  console.log('ENV', JSON.stringify({ mode, arch: os.arch(), node: process.version, home, uid: process.getuid() }));
  assert.equal(os.arch(), 'arm64', 'arm64 컨테이너가 아니에요');
  assert.match(process.version, /^v24\./, 'node 24가 아니에요');
  assert.notEqual(process.getuid(), 0, 'root로 돌고 있어요');
  assert.equal(fs.existsSync(path.join(home, '.claude')), false, '~/.claude가 이미 있어요(깨끗하지 않음)');

  const before = await checkClaude(process.env, 'linux');
  console.log('BEFORE', JSON.stringify(before));
  assert.deepEqual(before, { installed: false, version: null, path: launcher });
  console.log('COMMAND', JSON.stringify(installCommand('linux')));

  const logs = [];
  const onLog = (line) => { logs.push(line); console.log(`[install] ${line}`); };
  const t0 = Date.now();
  const first = installClaude({ platform: 'linux', env: process.env, onLog });
  const again = installClaude({ platform: 'linux', env: process.env, onLog });
  assert.equal(first, again, '설치 중에 다시 부르면 같은 설치를 돌려줘야 해요');
  const result = await first;
  console.log('RESULT', JSON.stringify(result), `${Date.now() - t0}ms`);

  const after = await checkClaude(process.env, 'linux');
  console.log('AFTER', JSON.stringify(after));

  if (mode === 'offline') {
    assert.deepEqual(result, { ok: false, version: null });
    assert.equal(after.installed, false);
    assert.equal(logs.at(-1), '설치하지 못했어요. 인터넷 연결을 확인하고 다시 눌러 주세요.');
    console.log('OFFLINE_OK');
    return;
  }

  assert.equal(result.ok, true);
  assert.match(result.version, /^\d+\.\d+\.\d+/);
  assert.deepEqual(after, { installed: true, version: result.version, path: launcher });
  assert.ok(logs.some((l) => /Installation complete|successfully installed/i.test(l)), '설치 프로그램 출력이 onLog로 오지 않았어요');
  assert.equal(logs.at(-1), `설치를 마쳤어요 (버전 ${result.version})`);

  // 이미 깔려 있으면 설치하지 않는다
  const logs2 = [];
  const t1 = Date.now();
  const second = await installClaude({ platform: 'linux', env: process.env, onLog: (l) => logs2.push(l) });
  console.log('SECOND', JSON.stringify(second), JSON.stringify(logs2), `${Date.now() - t1}ms`);
  assert.deepEqual(second, result);
  assert.deepEqual(logs2, [`이미 설치돼 있어요 (버전 ${result.version})`]);

  console.log(`INSTALLED_VERSION=${result.version}`);
  console.log('INSTALL_OK');
})().catch((e) => { console.error('DRIVER_FAIL', (e && e.stack) || e); process.exit(1); });
EOF

step "docker 확인"
docker version --format 'server {{.Server.Version}} {{.Server.Os}}/{{.Server.Arch}}' || fail "docker를 쓸 수 없어요"

step "이미지 빌드 ($TAG, $PLATFORM)"
docker build --platform "$PLATFORM" -t "$TAG" -f "$APP/test/container/Dockerfile.installer" "$CTX"

step "컨테이너 띄우기 ($NAME, 붙인 폴더 없음)"
docker run -d --platform "$PLATFORM" --name "$NAME" "$TAG" >/dev/null
mounts="$(docker inspect -f '{{len .Mounts}}' "$NAME")"
echo "mounts=$mounts"
[ "$mounts" = "0" ] || fail "컨테이너에 붙은 폴더가 있어요"
docker exec "$NAME" sh -c 'id; uname -m; node --version; curl --version | head -1; command -v sudo || echo "sudo 없음"; ls -la ~'

step "installClaude 실제 설치 (online)"
docker exec "$NAME" node driver.js online | tee "$OUT/online.log"
grep -q '^INSTALL_OK$' "$OUT/online.log" || fail "설치 확인 실패"
installed="$(sed -n 's/^INSTALLED_VERSION=//p' "$OUT/online.log")"

step "~/.local/bin/claude --version"
cli="$(docker exec "$NAME" sh -c '~/.local/bin/claude --version')"
echo "$cli"
echo "$cli" | grep -Eq "^${installed//./\\.} \(Claude Code\)$" || fail "--version 출력이 설치 버전($installed)과 달라요"

step "stable 채널 버전과 같은지"
stable="$(docker exec "$NAME" curl -fsS https://downloads.claude.ai/claude-code-releases/stable)"
latest="$(docker exec "$NAME" curl -fsS https://downloads.claude.ai/claude-code-releases/latest)"
echo "stable=$stable latest=$latest installed=$installed"
[ "$installed" = "$stable" ] || fail "stable($stable)이 아니라 $installed이 깔렸어요"
docker exec "$NAME" sh -c 'ls -la ~/.local/bin ~/.local/share/claude/versions; cat ~/.claude/settings.json 2>/dev/null || true'

step "인터넷 없는 컨테이너에서 실패 보고 (offline)"
docker run --rm --platform "$PLATFORM" --network none --name "$OFFLINE" "$TAG" node driver.js offline | tee "$OUT/offline.log"
grep -q '^OFFLINE_OK$' "$OUT/offline.log" || fail "인터넷 없을 때 실패로 보고하지 않았어요"

step "정리"
cleanup
left="$(docker ps -a --filter "name=kct-installer-t8-$$" --format '{{.Names}}')"
[ -z "$left" ] || fail "남은 컨테이너: $left"
if docker image inspect "$TAG" >/dev/null 2>&1; then fail "이미지 태그가 남았어요: $TAG"; fi
echo "컨테이너와 이미지 태그($TAG)를 지웠어요"

echo
echo "T8_CONTAINER_PASS installed=$installed stable=$stable"
