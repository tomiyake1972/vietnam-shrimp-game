#!/usr/bin/env bash
# ShrimpX V2 — BW-1 監査資料の生成（差分・マニフェスト・ZIP・復元の自己検証）
#
# 【基準】受入済み INT-1 の commit。古い feature branch を基準にしない。
#   BASE = e7c92839ab26b21bf98d029cdd52e37e7c34c419
#          integration-prep/v2-int1-training-candidate
#
# 【復元手順（適用元と順序）】
#   1. git archive <BASE> | tar -x -C <空ディレクトリ>
#   2. git apply diffs/bw1_tracked.diff     （既存ファイルの変更）
#   3. git apply diffs/bw1_untracked.diff   （新規ファイルの追加）
#   順序を入れ替えないこと。他の branch へ重ねないこと。
#
# 【実行順序】マニフェストはログも含めてハッシュを取るため、ゲートのログを
# docs/int1/logs/ へ置き終えた後に実行する。
#   1. npx tsc --noEmit -p . / npx eslint / npm test / runBw1Propagation.sh を実行し、
#      ログを docs/int1/logs/bw1-*.log へ置く
#   2. bash scripts/int1/buildBw1Bundle.sh
#
# 【自己参照の回避】ZIP 自身と BW1_MANIFEST.txt、復元検証ログはマニフェスト対象外。
# （自分のハッシュを自分に書くと確定しないため。）
set -euo pipefail

BASE="e7c92839ab26b21bf98d029cdd52e37e7c34c419"
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

OUT="docs/int1/attachments"
MANIFEST="$OUT/BW1_MANIFEST.txt"
README="$OUT/BW1_README.md"
BASISLOG="$OUT/BW1_GIT_BASIS.txt"
TRACKED="$OUT/bw1_tracked.diff"
UNTRACKED="$OUT/bw1_untracked.diff"
ZIP="$OUT/shrimpx-bw1-audit.zip"
mkdir -p "$OUT"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "== 0. 基点の確認（受入済み基準の上で作業していること）=="
HEAD_SHA="$(git rev-parse HEAD)"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
MB="$(git merge-base HEAD "$BASE")"
{
  echo "# BW-1 基点確認  $(TZ=Asia/Tokyo date '+%Y-%m-%d %H:%M JST')"
  echo ""
  echo "受入済み基準       $BASE"
  echo "                   integration-prep/v2-int1-training-candidate"
  echo "ローカル HEAD      $HEAD_SHA"
  echo "ローカル branch    $BRANCH"
  echo "merge-base         $MB"
  echo "基準に無い commit  $(git rev-list --count "$BASE"..HEAD) 本"
  echo "HEAD に無い commit $(git rev-list --count HEAD.."$BASE") 本"
  echo ""
  echo "→ HEAD は受入済み基準そのもの。BW-1 は追加 commit 0 本の未commit差分として"
  echo "  この基準の上に載っている。"
  echo ""
  echo "# 使ってはいけない古い branch との関係（参考）"
  if git rev-parse --verify --quiet refs/remotes/origin/claude/shrimpx-v2-ui-audit-aypqr4 >/dev/null; then
    OLD="$(git rev-parse refs/remotes/origin/claude/shrimpx-v2-ui-audit-aypqr4)"
  elif git rev-parse --verify --quiet FETCH_HEAD >/dev/null; then
    OLD="$(git rev-parse FETCH_HEAD)"
  else
    OLD=""
  fi
  if [ -n "$OLD" ]; then
    echo "claude/shrimpx-v2-ui-audit-aypqr4  $OLD"
    echo "  基準に無い commit  $(git rev-list --count "$BASE".."$OLD") 本"
    echo "  これに無い commit  $(git rev-list --count "$OLD".."$BASE") 本"
    echo "  → 受入済み基準より大きく遅れている。push・配備には使わない。"
  else
    echo "（この環境では取得できなかった）"
  fi
} > "$BASISLOG"
test "$HEAD_SHA" = "$BASE" || { echo "!! HEAD が受入済み基準と一致しない。中止する。"; exit 1; }
test "$MB" = "$BASE" || { echo "!! merge-base が受入済み基準と一致しない。中止する。"; exit 1; }
echo "   HEAD = BASE = $BASE  ($BRANCH)"

echo "== 1. 追跡済み差分を生成（基準 = 受入済み INT-1）=="
git diff "$BASE" > "$TRACKED"
echo "   $TRACKED  $(grep -c '^diff --git' "$TRACKED") files"

echo "== 2. 新規ファイル差分を生成（docs/int1 は実ファイルで同梱するため除く）=="
git ls-files --others --exclude-standard | grep -v '^docs/int1/' | sort > "$TMP/untracked.txt"
GIT_INDEX_FILE="$TMP/idx" git read-tree "$BASE"
# shellcheck disable=SC2046
GIT_INDEX_FILE="$TMP/idx" git add -N $(tr '\n' ' ' < "$TMP/untracked.txt")
# shellcheck disable=SC2046
GIT_INDEX_FILE="$TMP/idx" git diff -- $(tr '\n' ' ' < "$TMP/untracked.txt") > "$UNTRACKED"
echo "   $UNTRACKED  $(grep -c '^diff --git' "$UNTRACKED") files"

echo "== 3. 候補識別子（製品コード＋テスト tree。docs/int1・scripts/int1 を除く）=="
export GIT_INDEX_FILE="$TMP/code.idx"
git read-tree HEAD
git add -A . >/dev/null 2>&1 || true
git rm --cached -q -r docs/int1 scripts/int1 2>/dev/null || true
CODE_TREE="$(git write-tree)"
unset GIT_INDEX_FILE
echo "   code+tests tree  $CODE_TREE"

echo "== 4. マニフェストを生成 =="
{ git diff --name-only "$BASE"; git ls-files --others --exclude-standard; } |
  sort -u | grep -v "^docs/int1/attachments/" > "$TMP/all.txt"
{
  echo "# BW-1 監査資料 — 証拠マニフェスト（SHA-256・64桁）"
  echo "#"
  echo "# 生成: scripts/int1/buildBw1Bundle.sh"
  echo "# 更新: $(TZ=Asia/Tokyo date '+%Y-%m-%d %H:%M JST')"
  echo "#"
  echo "# 基点（受入済み INT-1、full SHA）"
  echo "#   $BASE"
  echo "#   integration-prep/v2-int1-training-candidate"
  echo "#   ローカル HEAD と一致（追加 commit 0 本）"
  echo "#"
  echo "# 候補識別子（commit SHA ではない）"
  echo "#   製品コード＋テスト tree（docs/int1・scripts/int1 を除く）  $CODE_TREE"
  echo "#"
  echo "# 復元手順（適用元と順序）"
  echo "#   1. git archive $BASE | tar -x -C <空ディレクトリ>"
  echo "#   2. git apply diffs/bw1_tracked.diff"
  echo "#   3. git apply diffs/bw1_untracked.diff"
  echo "#   他の branch へ重ねないこと。順序を入れ替えないこと。"
  echo "#"
  echo "# 対象外（自己参照の回避）: BW1_MANIFEST.txt / shrimpx-bw1-audit.zip /"
  echo "#   BW1_RESTORE_VERIFICATION.txt（このマニフェストを読んで照合した結果）"
  echo "#"
  echo "# 秘密情報・認証トークン・環境変数の値は含まれていない。"
  echo "# スクリプト内の \"shim-token\" / \"bw1-local-verify-token\" は、この検証専用に"
  echo "# 起動したローカルプロセス同士の合わせ値であり、実環境の認証情報ではない。"
  echo "#"
  echo "# 列: SHA-256(64桁)  由来  パス"
  echo "#   BW1-FIX        BW-1 で変更/追加した製品コードとそのテスト"
  echo "#   BW1-EVIDENCE   検証スクリプト・文書・ログ（製品コードではない）"
  echo "#   INT1-CARRY     受入済み INT-1 から持ち越した未commitファイル（BW-1 の変更ではない）"
  echo ""
  while read -r f; do
    [ -f "$f" ] || continue
    case "$f" in
      docs/int1/bw1_*|docs/int1/logs/bw1-*|scripts/int1/measureBandwidth.ts|scripts/int1/upstashRestShim.ts|scripts/int1/verifyBw1Propagation.ts|scripts/int1/runBw1Propagation.sh|scripts/int1/buildBw1Bundle.sh) origin="BW1-EVIDENCE";;
      docs/int1/*|scripts/int1/*) origin="INT1-CARRY";;
      *) origin="BW1-FIX";;
    esac
    printf "%s  %-13s %s\n" "$(sha256sum "$f" | cut -d' ' -f1)" "$origin" "$f"
  done < "$TMP/all.txt"
  echo ""
  echo "# 合計 $(grep -c . "$TMP/all.txt") ファイル"
} > "$MANIFEST"
echo "   $MANIFEST  $(grep -c '^[0-9a-f]\{64\}' "$MANIFEST") entries"

echo "== 5. 別ディレクトリへ復元して、差分が候補を再現することを照合 =="
REST="$TMP/restore"
mkdir -p "$REST"
git archive "$BASE" | tar -x -C "$REST"
( cd "$REST" && git apply "$ROOT/$TRACKED" && git apply "$ROOT/$UNTRACKED" )
OK=0; NG=0
{
  echo "# BW-1 復元照合  $(TZ=Asia/Tokyo date '+%Y-%m-%d %H:%M JST')"
  echo "# 手順: git archive $BASE → git apply bw1_tracked.diff → git apply bw1_untracked.diff"
  echo "# 照合: 差分が触る全ファイルの SHA-256 が、この worktree と一致するか"
  echo ""
  while read -r f; do
    case "$f" in docs/int1/*) continue;; esac
    [ -f "$f" ] || continue
    A="$(sha256sum "$f" | cut -d' ' -f1)"
    if [ -f "$REST/$f" ]; then B="$(sha256sum "$REST/$f" | cut -d' ' -f1)"; else B="(missing)"; fi
    if [ "$A" = "$B" ]; then OK=$((OK+1)); else NG=$((NG+1)); echo "MISMATCH  $f"; fi
  done < "$TMP/all.txt"
  echo ""
  echo "一致 $OK 件 / 不一致 $NG 件"
  [ "$NG" -eq 0 ] && echo "RESULT: PASS（差分だけで候補を再現できる）" || echo "RESULT: FAIL"
} > "$OUT/BW1_RESTORE_VERIFICATION.txt"
tail -3 "$OUT/BW1_RESTORE_VERIFICATION.txt"
grep -q "RESULT: PASS" "$OUT/BW1_RESTORE_VERIFICATION.txt" || { echo "!! 復元照合が一致しない。中止する。"; exit 1; }

echo "== 6. README を生成 =="
{
  echo "# BW-1 監査資料（ShrimpX V2 / Redis 帯域対策）"
  echo ""
  echo "生成: $(TZ=Asia/Tokyo date '+%Y-%m-%d %H:%M JST')　scripts/int1/buildBw1Bundle.sh"
  echo ""
  echo "## 基点と識別子"
  echo ""
  echo "| 項目 | 値 |"
  echo "|---|---|"
  echo "| 基点 commit（受入済み INT-1） | \`$BASE\` |"
  echo "| branch | \`integration-prep/v2-int1-training-candidate\` |"
  echo "| ローカル HEAD | \`$HEAD_SHA\`（基点と一致・追加 commit 0 本） |"
  echo "| 候補識別子（製品コード＋テスト tree） | \`$CODE_TREE\` |"
  echo ""
  echo "BW-1 は未commitの作業差分としてこの基点の上に載っている。commit は作っていない。"
  echo ""
  echo "## 復元手順（適用元と順序）"
  echo ""
  echo "1. \`git archive $BASE | tar -x -C <空ディレクトリ>\`"
  echo "2. \`git apply diffs/bw1_tracked.diff\`"
  echo "3. \`git apply diffs/bw1_untracked.diff\`"
  echo ""
  echo "順序を入れ替えないこと。他の branch へ重ねないこと。"
  echo "照合結果は BW1_RESTORE_VERIFICATION.txt。"
  echo ""
  echo "## 証拠の対応（指示の5項目）"
  echo ""
  echo "| 確認したいこと | 証拠 |"
  echo "|---|---|"
  echo "| 更新なしの場合の大容量パート読込み抑止 | logs/bw1-propagation-after.log（変化なし 771 B / 1,161 B）、logs/bw1-propagation-before.log（同条件で 3,251,246 B / 3,251,636 B）、logs/bw1-bandwidth-measure.log、tests bw1PartialLoad BW1-1〜4 |"
  echo "| Seat の発行・参加・失効、提出、Turn 進行の反映 | logs/bw1-propagation-after.log §3〜§7（39/39 PASS）、tests seatsFingerprint BW1-S1〜S8 |"
  echo "| 認証失効時の停止、非表示タブ停止、通信の重複防止 | tests visiblePollingLoop BW1-P1〜P7（偽クロックで時間を進めて確認） |"
  echo "| 保存経路を軽量化しても終了済み Run 保護・CAS が維持 | tests bw1SavePathSafety BW1-SV1〜SV5、既存 handlers.test.ts END-LOCK-1〜5・gate |"
  echo "| 部分読みで省略したパートが既存パートを消さない | tests bw1PartialLoad BW1-7・BW1-8 |"
  echo ""
  echo "## 中身"
  echo ""
  echo "- \`diffs/\` 追跡済み差分・新規ファイル差分（基準は上記 BASE）"
  echo "- \`docs/\` BW-1 の説明文書（別件記録を含む）と全ゲートログ"
  echo "- \`scripts/\` 帯域計測・反映検証・資料生成のスクリプト"
  echo "- \`BW1_MANIFEST.txt\` 全ファイルの SHA-256"
  echo "- \`BW1_GIT_BASIS.txt\` 基点確認の出力"
  echo "- \`BW1_RESTORE_VERIFICATION.txt\` 復元照合の出力"
  echo ""
  echo "## 計測の再現"
  echo ""
  echo "    STAGING_ADMIN_TOKEN=<任意の値> ./scripts/int1/runBw1Propagation.sh"
  echo ""
  echo "隔離したローカル Redis を起動し、その前に Upstash REST 互換シムを置き、"
  echo "本物の API route（next dev）へ実際の HTTP を流して測る。"
  echo "共有 DB（Staging / Production）へは一切接続しない。"
  echo ""
  echo "## 注意"
  echo ""
  echo "- 秘密情報・認証トークン・環境変数の値は含まれていない。"
  echo "- npm test の全体件数は、このバンドルを作った環境での実行結果である"
  echo "  （logs/bw1-npm-test.log）。再実行した値として扱わないこと。"
} > "$README"

echo "== 7. ZIP を作る =="
rm -f "$ZIP"
STAGE="$TMP/zip"
mkdir -p "$STAGE/diffs" "$STAGE/docs/logs" "$STAGE/scripts"
cp "$TRACKED" "$UNTRACKED" "$STAGE/diffs/"
cp "$README" "$MANIFEST" "$BASISLOG" "$OUT/BW1_RESTORE_VERIFICATION.txt" "$STAGE/"
cp docs/int1/bw1_redis_bandwidth.md docs/int1/separate_issue_production_app_env.md "$STAGE/docs/"
cp docs/int1/logs/bw1-*.log "$STAGE/docs/logs/"
cp scripts/int1/measureBandwidth.ts scripts/int1/upstashRestShim.ts scripts/int1/verifyBw1Propagation.ts \
   scripts/int1/runBw1Propagation.sh scripts/int1/buildBw1Bundle.sh scripts/int1/respClient.ts "$STAGE/scripts/"
( cd "$STAGE" && zip -q -r "$ROOT/$ZIP" . )
echo "   $ZIP  $(cd "$STAGE" && find . -type f | wc -l | tr -d ' ') files  $(stat -c%s "$ROOT/$ZIP") bytes"
echo ""
echo "ZIP SHA-256: $(sha256sum "$ZIP" | cut -d' ' -f1)"
