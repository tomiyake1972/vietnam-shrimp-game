#!/usr/bin/env bash
# ShrimpX V2 — INT-1 「提出差分から最終候補を再現できる」ことの照合
#
# docs/int1/evidence_manifest.txt の全件について、
#   製品コード・テスト・検証スクリプト → 基準RCへ差分を適用した復元結果のハッシュ
#   docs/int1 配下の監査資料             → ZIP内の実ファイルのハッシュ
# を比較する。1件でも不一致・欠落があれば異常終了する。
#
# 【適用元と順序】必ず基準RCから始める。Crowding HEAD へ重ねてはいけない
# （candidate_tracked.diff は RC からの差分で、Crowding の変更も既に含むため二重になる）。
#   1. git archive <RC> | tar -x -C <空ディレクトリ>
#   2. git apply docs/int1/attachments/candidate_tracked.diff
#   3. git apply docs/int1/attachments/candidate_untracked.diff
#
# 出力は docs/int1/logs/restore-verification.log にも残す
# （このログはマニフェスト対象外。マニフェストを読んだ結果なので含めると毎回ずれる）。
set -uo pipefail

RC="728b3416028dabd44556a55de3f8abd84726817d"
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

MANIFEST="docs/int1/evidence_manifest.txt"
TRACKED="docs/int1/attachments/candidate_tracked.diff"
UNTRACKED="docs/int1/attachments/candidate_untracked.diff"
OUT="docs/int1/logs/restore-verification.log"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
RESTORE="$TMP/restore"
mkdir -p "$RESTORE"

{
  echo "### CMD: bash scripts/int1/verifyRestore.sh"
  echo "### DATE: $(TZ=Asia/Tokyo date '+%Y-%m-%d %H:%M JST')"
  echo "### NOTE: このログだけはマニフェスト対象外（マニフェストを読んだ結果の出力）"
  echo ""
  echo "適用元 RC   $RC"
  echo "候補 branch $(git rev-parse --abbrev-ref HEAD) / 基点 commit $(git rev-parse HEAD)"
  echo ""
  echo "1. git archive \$RC | tar -x"
  git archive "$RC" | tar -x -C "$RESTORE"
  git -C "$RESTORE" init -q
  echo "2. git apply $TRACKED"
  git -C "$RESTORE" apply "$ROOT/$TRACKED" && echo "   OK ($(grep -c '^diff --git' "$TRACKED") files)"
  echo "3. git apply $UNTRACKED"
  git -C "$RESTORE" apply "$ROOT/$UNTRACKED" && echo "   OK ($(grep -c '^diff --git' "$UNTRACKED") files)"
  echo ""

  ok=0; bad=0; missing=0; docs=0
  while read -r sha _origin path; do
    case "$sha" in \#*|"") continue;; esac
    if [[ "$path" == docs/int1/* ]]; then
      src="$ROOT/$path"; docs=$((docs+1))
    else
      src="$RESTORE/$path"
    fi
    if [ ! -f "$src" ]; then
      echo "MISSING  $path"; missing=$((missing+1)); continue
    fi
    actual="$(sha256sum "$src" | cut -d' ' -f1)"
    if [ "$actual" = "$sha" ]; then ok=$((ok+1)); else
      echo "MISMATCH $path"
      echo "         manifest=$sha"
      echo "         actual  =$actual"
      bad=$((bad+1))
    fi
  done < "$MANIFEST"

  echo "照合件数 $((ok+bad+missing))（うち docs/int1 の監査資料 $docs 件はZIP内実ファイルと照合）"
  echo "一致 $ok / 不一致 $bad / 欠落 $missing"
  if [ "$bad" -ne 0 ] || [ "$missing" -ne 0 ]; then
    echo "### EXIT: 1"
    echo "NG: 提出差分から最終候補を再現できていない"
    exit 1
  fi
  echo "OK: 提出差分から最終候補を完全に再現できる"
  echo "### EXIT: 0"
} 2>&1 | tee "$OUT"

grep -q "^OK:" "$OUT"
