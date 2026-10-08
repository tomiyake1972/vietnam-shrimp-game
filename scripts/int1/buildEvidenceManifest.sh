#!/usr/bin/env bash
# ShrimpX V2 — INT-1 証拠マニフェスト（SHA-256＋由来）の生成
#
# 件数は必ず実ファイルから集計する（文書に書いた数を転記しない）。
#
# 【対象外にする2ファイルとその理由（自己参照の回避）】
#   docs/int1/evidence_manifest.txt          自分のハッシュを自分に書くと確定しない
#   docs/int1/logs/restore-verification.log  このマニフェストを読んで照合した結果の
#                                            出力であり、マニフェスト生成より後に
#                                            書かれる（含めると毎回1件ずれる）
# それ以外のログ・文書・スクリプトはすべてマニフェストの対象に含める。
# 候補の識別子として使う tree も docs/int1・scripts/int1 を除いた
# 「製品コード＋テスト tree」だけを使う（監査資料を書き換えるたびに
# 全体treeが変わり、識別子として機能しないため）。
set -euo pipefail

RC="728b3416028dabd44556a55de3f8abd84726817d"
D1_REF="origin/feature/v2-player-admin-dividend-settlement"
O1_REF="origin/feature/v2-player-submit-persistence-race-fix"
CR_REF="origin/feature/v2-eng-crowding-markdown-1"

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
MANIFEST="docs/int1/evidence_manifest.txt"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

git diff --name-only "$RC..$D1_REF" | sort > "$TMP/d1.txt"
git diff --name-only "$RC..$O1_REF" | sort > "$TMP/o1.txt"
git diff --name-only "$RC..$CR_REF" | sort > "$TMP/cr.txt"
SELF_EXCLUDE="docs/int1/logs/restore-verification.log"
{ git diff --name-only "$RC"; git ls-files --others --exclude-standard; } |
  sort -u | grep -v "^${MANIFEST}$" | grep -v "^${SELF_EXCLUDE}$" > "$TMP/all.txt"

: > "$TMP/inv.txt"
while read -r f; do
  case "$f" in
    docs/int1/attachments/*) origin="INT1-ATTACH";;
    docs/int1/*|scripts/int1/*) origin="INT1-EVIDENCE";;
    *)
      origin=""
      grep -qx "$f" "$TMP/d1.txt" && origin="${origin}D1+"
      grep -qx "$f" "$TMP/o1.txt" && origin="${origin}O1+"
      grep -qx "$f" "$TMP/cr.txt" && origin="${origin}CR+"
      [ -z "$origin" ] && origin="INT1-FIX+"
      ;;
  esac
  echo "${origin%+}|$f" >> "$TMP/inv.txt"
done < "$TMP/all.txt"

# 製品コード＋テスト tree（docs/int1・scripts/int1 を除く）
export GIT_INDEX_FILE="$TMP/code.idx"
git read-tree HEAD
git add -A . >/dev/null 2>&1 || true
git rm --cached -q -r docs/int1 scripts/int1 2>/dev/null || true
CODE_TREE="$(git write-tree)"
unset GIT_INDEX_FILE

TOTAL="$(wc -l < "$TMP/inv.txt" | tr -d ' ')"
ATTACH="$(grep -c '^INT1-ATTACH|' "$TMP/inv.txt" || true)"
EVIDENCE="$(grep -c '^INT1-EVIDENCE|' "$TMP/inv.txt" || true)"

{
  echo "# INT-1 統合候補 — 証拠マニフェスト（SHA-256・64桁）"
  echo "#"
  echo "# 生成: scripts/int1/buildEvidenceManifest.sh"
  echo "# 更新: $(TZ=Asia/Tokyo date '+%Y-%m-%d %H:%M JST')"
  echo "# 自己参照を避けるため、次の2ファイルだけ対象外:"
  echo "#   docs/int1/evidence_manifest.txt（このファイル自身）"
  echo "#   docs/int1/logs/restore-verification.log（このマニフェストで照合した結果の出力）"
  echo "#"
  echo "# 候補の識別子（commit SHA ではない）:"
  echo "#   製品コード＋テスト tree（docs/int1・scripts/int1 を除く）  $CODE_TREE"
  echo "#   基点 commit                                              $(git rev-parse HEAD)"
  echo "#   ローカル branch                                          $(git rev-parse --abbrev-ref HEAD)（追加commit 0本）"
  echo "#"
  echo "# 取り込み元（full SHA）:"
  echo "#   基準RC    integration/v2-rc-20260830                    $RC"
  echo "#   D1        feature/v2-player-admin-dividend-settlement    $(git rev-parse "$D1_REF")"
  echo "#   O1        feature/v2-player-submit-persistence-race-fix  $(git rev-parse "$O1_REF")"
  echo "#   Crowding  feature/v2-eng-crowding-markdown-1             $(git rev-parse "$CR_REF")"
  echo "#   ※ Git ancestry に含まれるのは Crowding の5commitのみ。"
  echo "#     D1・O1 は差分として適用した成果であり、元commitはancestryに含まれない"
  echo "#     （区別と対応表は docs/int1/contribution_map.md）。"
  echo "#"
  echo "# 復元手順（適用元と順序。詳細は scripts/int1/rebuildAuditDiffs.sh）:"
  echo "#   1. git archive $RC | tar -x -C <空ディレクトリ>"
  echo "#   2. git apply docs/int1/attachments/candidate_tracked.diff"
  echo "#   3. git apply docs/int1/attachments/candidate_untracked.diff"
  echo "#   Crowding HEAD へ RC 比の差分を重ねないこと（Crowding分が二重になる）。"
  echo "#"
  echo "# 列: SHA-256(64桁)  由来  パス"
  echo "#   CR / O1 / D1      その成果branchの差分として取り込んだファイル"
  echo "#   D1+O1 / D1+CR     2成果が触り、統合候補で手統合したファイル"
  echo "#   INT1-FIX          INT-1で手を入れた製品コードとその受入テスト（commit 1 対象）"
  echo "#   INT1-EVIDENCE     検証スクリプト・運用文書・ログ（commit 2 対象。製品コードではない）"
  echo "#   INT1-ATTACH       別添。巨大な生成物のためどちらの commit にも含めない"
  echo "#"
  echo "# 秘密情報・認証トークン・環境変数の値は含まれていない。"
  echo "# 唯一のトークン文字列は candidate_untracked.diff / e2e 内の \"e2e-test-token\" で、"
  echo "# 隔離テスト環境専用の既存ダミー値（実環境の認証情報ではない）。"
  echo ""
  while IFS='|' read -r origin f; do
    [ -f "$f" ] || continue
    printf "%s  %-14s %s\n" "$(sha256sum "$f" | cut -d' ' -f1)" "$origin" "$f"
  done < "$TMP/inv.txt"
  echo ""
  echo "# 合計 $TOTAL ファイル（INT1-ATTACH $ATTACH 件は commit 対象外 / INT1-EVIDENCE $EVIDENCE 件は commit 2）"
} > "$MANIFEST"

echo "   $MANIFEST  $(grep -c '^[0-9a-f]\{64\}' "$MANIFEST") entries (tree $CODE_TREE)"
