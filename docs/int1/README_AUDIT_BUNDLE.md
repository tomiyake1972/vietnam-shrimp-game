# INT-1 統合候補 — 監査資料バンドル

生成: 2026-10-08 JST（最終監査でのJSON送信時の検証漏れ修正を反映）/ 状態: **未commit・未push・未配備**

## 1. この ZIP の中身

```
docs/int1/
  README_AUDIT_BUNDLE.md          このファイル（読む順序の案内）
  evidence_manifest.txt           全143ファイルの SHA-256（64桁）＋由来区分＋復元手順
  candidate_identity.md           候補の識別情報・前回報告の訂正
  contribution_map.md             取り込んだcommit と 差分として含めた成果 の対応表（ancestry実測）
  commit_plan.md                  commit構成・branch・別添・承認対象
  file_count_reconciliation.md    ファイル数・テスト数の整合性（今回の訂正）
  zero_value_handling.md          空欄・不正数値の無言0変換を止めた記録と、前回説明の訂正
  ui_issues.md                    UI課題の再現・原因・対処・残課題
  candidate_release_notes.md      機能と既知の制限
  operating_procedures.md         操作手順
  pre_training_checklist.md       研修前チェックリスト
  manual_change_points.md         マニュアル2冊への反映点
  staging_deployment_plan.md      配備計画・データ分離・v9を考慮した復旧計画
  run32turn_regression.txt        32Turn技術回帰の設定と結果
  logs/                           実行ログ21本（うち20本がマニフェスト対象）（先頭に ### CMD: / ### DATE:、末尾に ### EXIT: を記録）
                                  すべて最終コードに対する実行。古い実行は残していない
    restore-verification.log      差分から最終候補を復元し全ハッシュを照合した結果
  attachments/
    candidate_tracked.diff        追跡ファイルの全差分（RC比）
    candidate_untracked.diff      新規ファイルの全文
    npm-test-full.log             npm test の全出力
scripts/int1/                     検証スクリプト17本（うちシェル3本）
  rebuildAuditDiffs.sh            差分→マニフェスト→復元照合を一括実行（これだけ叩けばよい）
  buildEvidenceManifest.sh        マニフェスト生成（件数は実ファイルから集計）
  verifyRestore.sh                復元照合のみ
```

## 2. 読む順序の提案

1. `candidate_identity.md` — 何を統合した候補なのか、識別子は何か
2. `contribution_map.md` — commit と差分の区別、ancestry の実測
3. `file_count_reconciliation.md` — 前回報告との数値の食い違いの訂正
4. `ui_issues.md` — 各UI課題の再現→原因→対処
5. `zero_value_handling.md` — 0 の扱いについての補足（§6b が最終監査で見つかった JSON 送信時の検証漏れ）
6. `logs/` — 実行コマンドと終了コード、テスト結果
7. `attachments/candidate_tracked.diff` / `candidate_untracked.diff` — コード差分そのもの
8. `commit_plan.md` / `staging_deployment_plan.md` — 承認対象と配備・復旧

## 3. 差分からの復元手順（適用元と順序）

```
基準RC  728b3416028dabd44556a55de3f8abd84726817d   ← 差分の適用元はここ
基点    a79ec99a477c0f13765856cf63666436fac8e014   ← Crowding HEAD（適用元ではない）

1. git archive 728b3416028dabd44556a55de3f8abd84726817d | tar -x -C <空ディレクトリ>
2. git apply docs/int1/attachments/candidate_tracked.diff     （68ファイル）
3. git apply docs/int1/attachments/candidate_untracked.diff   （39ファイル）
```

**Crowding HEAD へ RC 比の差分を重ねないこと。** `candidate_tracked.diff` は
RC からの差分で Crowding の変更も既に含むため、Crowding HEAD に適用すると二重になる。

差分とマニフェストの再生成は次の 1 コマンドで行う（手で `git diff` を打たない）。

```
bash scripts/int1/rebuildAuditDiffs.sh
```

このスクリプトは 差分再生成 → マニフェスト再生成 → 別の一時ディレクトリへ復元して
全ハッシュ照合 までを行い、1 件でも不一致があれば異常終了する。
最終状態での結果は **一致 143 / 不一致 0 / 欠落 0**
（`docs/int1/logs/restore-verification.log`）。

### 監査で指摘された2点の是正

| 指摘 | 原因 | 是正 |
| --- | --- | --- |
| `SalesPlanningScreen.tsx` が不一致（復元結果に `sales-plan-table` の testid が無い） | 差分を生成した**後**にこのファイルを修正し、マニフェストだけを再生成していた | 最終状態から差分とマニフェストを同時に再生成し、復元して照合（一致を確認） |
| `e2e/salesPriceReference.e2e.ts` がマニフェストにあるが差分に無い | 同上。差分生成後に追加した修正 | 同上。現在 `candidate_tracked.diff` に含まれ、復元結果のロケータが `sales-plan-table` になっていることを確認 |

以後この2点が再発しないよう、差分・マニフェスト・照合を 1 スクリプトに束ねた。

## 4. 秘密情報について

- 認証トークン・API キー・環境変数の**値**は含まれていない（全ファイルを grep して確認）。
- `.env` 系・証明書（`certificates/`）・鍵ファイルは一切含まれていない。
- 文書中に現れる `STAGING_ADMIN_TOKEN` / `KV_REST_API_URL` などは**環境変数名**であり、値ではない。
- `attachments/candidate_untracked.diff` には、E2E テストのソースに元から書かれている
  テスト用固定値 `e2e-test-token` が含まれる。これは隔離テスト環境でのみ使う既存のダミー値であり、
  Staging・production の認証情報ではない。差分として有用なため除去せず、ここに明示する。
- build 検証で使ったローカル placeholder の環境変数値はログに出力されていない（grep で 0 件確認）。

## 5. 現在の状態

| 項目 | 状態 |
| --- | --- |
| commit | 0 本（未実施） |
| push | 未実施 |
| 共有RC への merge | 未実施 |
| Preview / production 配備 | 未実施 |
| 共有 Redis への接続・変更 | 未実施（検証は隔離ローカル Redis のみ。全インスタンス停止済み） |
| 製品コード＋テスト tree | `3c5a616897e28ece9dab09b4d2c037f2a86a10d7` |
| 差分からの復元照合 | 一致 143 / 不一致 0 / 欠落 0 |
| 型チェック | `npx tsc --noEmit -p .` 0 errors |
| unit テスト | `npm test` 4454 pass / 0 fail |
| E2E | Playwright 14ファイル。INT-1 分 `int1BlankInputGuard` 4 件を最終コードで再実測し 4 passed（全体 37 passed は直前の実行） |
| lint | `npx eslint app e2e scripts` 0 errors / 14 warnings（すべて既存。候補に含まれる `runner.ts` の1件も、RC版の同ファイルを lint すると同じ警告が出ることを実測） |
