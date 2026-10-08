#!/usr/bin/env bash
# 【BW-1】隔離環境での検証を1コマンドで通す。
#
# 立ち上げるもの（すべて 127.0.0.1 のみ）
#   1. redis-server            : 検証専用の空の Redis（このスクリプトのデータだけ）
#   2. upstashRestShim.ts      : 製品コードの @upstash/redis が話す REST を上の Redis へ中継
#   3. next dev                : 本物の API route
#   4. verifyBw1Propagation.ts : 実際の HTTP で順番に確かめる
#
# 停止中の共有 DB（Staging / Production）へは一切接続しない。
set -uo pipefail
cd "$(dirname "$0")/../.."

REDIS_PORT="${INT1_REDIS_PORT:-6406}"
SHIM_PORT="${INT1_SHIM_PORT:-6407}"
APP_PORT="${INT1_APP_PORT:-3401}"
SHIM_TOKEN="${INT1_SHIM_TOKEN:-shim-token}"
ADMIN_TOKEN="${STAGING_ADMIN_TOKEN:?STAGING_ADMIN_TOKEN を環境変数で渡してください}"
LOG_DIR="${INT1_LOG_DIR:-/tmp/bw1}"
mkdir -p "$LOG_DIR"

# 【片付けの確実さ】npx/npm は子プロセス（tsx・next-server）を別PIDで起動するため、
# 起動したPIDを kill しただけでは port が解放されずに残る。前回の残骸が残っていると
# 次の実行が古い shim へ繋がって黙って嘘の結果を出すので、使う port を実行前後で
# 必ず空にする。
free_port() {
  local port="$1"
  fuser -k -9 "${port}/tcp" >/dev/null 2>&1
  return 0
}

cleanup() {
  free_port "$SHIM_PORT"
  free_port "$APP_PORT"
  redis-cli -p "$REDIS_PORT" shutdown nosave 2>/dev/null
}
trap cleanup EXIT

echo "== 0. 使う port を空にする（前回の残骸があると古い接続先へ繋がるため）"
free_port "$SHIM_PORT"
free_port "$APP_PORT"
redis-cli -p "$REDIS_PORT" shutdown nosave 2>/dev/null
sleep 1

echo "== 1. 隔離 Redis を起動（port ${REDIS_PORT}・保存なし・空の状態から）"
redis-server --port "$REDIS_PORT" --bind 127.0.0.1 --save '' --appendonly no --daemonize yes --logfile "$LOG_DIR/redis.log"
for _ in $(seq 1 30); do redis-cli -p "$REDIS_PORT" ping >/dev/null 2>&1 && break; sleep 0.2; done
redis-cli -p "$REDIS_PORT" ping || { echo "Redis が起動しませんでした"; exit 1; }
redis-cli -p "$REDIS_PORT" flushall >/dev/null

echo "== 2. Upstash REST 互換シムを起動（port ${SHIM_PORT} -> ${REDIS_PORT}）"
INT1_REDIS_PORT="$REDIS_PORT" INT1_SHIM_PORT="$SHIM_PORT" INT1_SHIM_TOKEN="$SHIM_TOKEN" \
  npx tsx scripts/int1/upstashRestShim.ts > "$LOG_DIR/shim.log" 2>&1 &
for _ in $(seq 1 60); do curl -sf "http://127.0.0.1:${SHIM_PORT}/__shim/log" >/dev/null && break; sleep 0.3; done
curl -sf "http://127.0.0.1:${SHIM_PORT}/__shim/log" >/dev/null || { echo "シムが起動しませんでした"; cat "$LOG_DIR/shim.log"; exit 1; }

echo "== 3. dev server を起動（port ${APP_PORT}・保存先はシムのみ）"
APP_ENV=staging \
APP_VERSION="${APP_VERSION:-2.0.0}" \
STAGING_ADMIN_TOKEN="$ADMIN_TOKEN" \
STAGING_KV_REST_API_URL="http://127.0.0.1:${SHIM_PORT}" \
STAGING_KV_REST_API_TOKEN="$SHIM_TOKEN" \
  npx next dev -p "$APP_PORT" > "$LOG_DIR/dev.log" 2>&1 &
for _ in $(seq 1 200); do curl -sf -o /dev/null "http://127.0.0.1:${APP_PORT}/api/v2/company-lab/session-status" && break; sleep 0.5; done

echo "== 4. 検証を実行"
INT1_APP_URL="http://127.0.0.1:${APP_PORT}" \
INT1_SHIM_URL="http://127.0.0.1:${SHIM_PORT}" \
STAGING_ADMIN_TOKEN="$ADMIN_TOKEN" \
  npx tsx scripts/int1/verifyBw1Propagation.ts
STATUS=$?

echo "== 5. 片付け（隔離 Redis は FLUSHALL して停止）"
redis-cli -p "$REDIS_PORT" flushall >/dev/null 2>&1
exit $STATUS
