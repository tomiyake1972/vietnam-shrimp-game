#!/usr/bin/env bash
# ShrimpX V2 — INT-1 監査用差分・マニフェストの再生成と、復元の自己検証
#
# 【なぜ必要か】監査で、提出した差分と最終候補が一致しない箇所が見つかった
# （SalesPlanningScreen.tsx のhunkが古く、e2e/salesPriceReference.e2e.ts が差分に無かった）。
# 原因は、差分を生成した後にその2ファイルを修正し、マニフェストだけを再生成したこと。
# 以後は必ずこのスクリプトで「差分 → マニフェスト → 復元検証」を一括で行う。
#
# 【適用元と順序（復元手順）】
#   1. 基準RC（integration/v2-rc-20260830）を取り出す
#        git archive <RC_SHA> | tar -x -C <空ディレクトリ>
#      ※ Crowding HEAD（a79ec99…）へ重ねないこと。
#        candidate_tracked.diff は RC からの差分であり、Crowding の変更も既に含む。
#        Crowding HEAD へ適用すると Crowding 分が二重になる。
#   2. 追跡済み差分を適用   git apply candidate_tracked.diff
#   3. 未追跡ファイル差分を適用 git apply candidate_untracked.diff
#   順序を入れ替えてはいけない（3は新規ファイル作成のみなので独立だが、2の前に
#   docs/int1 を置くと 1 の取り出しと衝突する）。
#
# 【docs/int1 の扱い】docs/int1/** は監査資料そのもので、差分には含めない
# （ZIP内の実ファイルとして配布する）。scripts/int1/** は commit 2 の対象なので
# candidate_untracked.diff に含める。
#
# 【実行順序が重要】マニフェストはログも含めてハッシュを取るため、
# 全てのログを docs/int1/logs/ へ置き終えた後に生成する必要がある。
# 正しい順序:
#   1. ゲート（npm test / E2E / tsc / eslint）を実行し、ログを docs/int1/logs/ へ置く
#   2. bash scripts/int1/rebuildAuditDiffs.sh
#      （差分再生成 → マニフェスト再生成 → 復元照合）
# 復元照合の出力 docs/int1/logs/restore-verification.log は
# マニフェスト対象外（マニフェストを読んだ結果なので、含めると毎回1件ずれる）。
#
# 【このスクリプト自身の出力はログとして保存しない】保存するとマニフェスト生成後に
# 追記が確定するため、同じ自己参照のずれが起きる。再生成の結果（適用ファイル数・
# 照合件数・可否）はすべて restore-verification.log と evidence_manifest.txt の
# ヘッダに残るので、証拠としてはそれで足りる。
#
# 使い方: bash scripts/int1/rebuildAuditDiffs.sh
set -euo pipefail

RC="728b3416028dabd44556a55de3f8abd84726817d"
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

TRACKED="docs/int1/attachments/candidate_tracked.diff"
UNTRACKED="docs/int1/attachments/candidate_untracked.diff"
MANIFEST="docs/int1/evidence_manifest.txt"

echo "== 0. 基準の確認 =="
test "$(git rev-parse "$RC")" = "$RC"
echo "   RC            $RC"
echo "   基点 commit   $(git rev-parse HEAD)"
echo "   branch        $(git rev-parse --abbrev-ref HEAD)"

echo "== 1. 追跡済み差分を再生成（基準 = RC）=="
git diff "$RC" > "$TRACKED"
echo "   $TRACKED  $(grep -c '^diff --git' "$TRACKED") files"

echo "== 2. 未追跡ファイル差分を再生成（docs/int1 を除く）=="
git ls-files --others --exclude-standard | grep -v '^docs/int1/' | sort > "$TMP/untracked.txt"
GIT_INDEX_FILE="$TMP/idx" git read-tree "$RC"
# shellcheck disable=SC2046
GIT_INDEX_FILE="$TMP/idx" git add -N $(tr '\n' ' ' < "$TMP/untracked.txt")
# shellcheck disable=SC2046
GIT_INDEX_FILE="$TMP/idx" git diff -- $(tr '\n' ' ' < "$TMP/untracked.txt") > "$UNTRACKED"
echo "   $UNTRACKED  $(grep -c '^diff --git' "$UNTRACKED") files"

echo "== 3. マニフェストを再生成（差分2本のハッシュも確定後に取る）=="
bash scripts/int1/buildEvidenceManifest.sh

echo "== 4. 別の一時ディレクトリへ復元して全ハッシュを照合 =="
bash scripts/int1/verifyRestore.sh
