# ファイル数・テスト数の整合性（実ファイル集計による確定値）

更新: 2026-10-08 JST（最終監査でのJSON送信時の検証漏れ修正を反映）

本文書の数値はすべて**実ファイルと実行ログから集計**している（文書から転記していない）。
集計コマンドは `scripts/int1/buildEvidenceManifest.sh` と
`scripts/int1/verifyRestore.sh` に埋め込んであり、再実行すれば同じ値が出る。

## 1. 確定値（この版で統一する数値）

| 項目 | 確定値 | 集計方法 |
| --- | --- | --- |
| 証拠マニフェスト件数 | **143** | `grep -c '^[0-9a-f]\{64\}' docs/int1/evidence_manifest.txt` |
| RC比・追跡済み変更ファイル | **68** | `git diff --name-only <RC> \| wc -l` |
| 未追跡ファイル合計 | **77** | `git ls-files --others --exclude-standard \| wc -l` |
| `candidate_tracked.diff` に含まれるファイル | **68** | `grep -c '^diff --git'` |
| `candidate_untracked.diff` に含まれるファイル | **39** | `grep -c '^diff --git'`（`docs/int1/**` を除く） |
| commit 1 対象（製品コード＋テスト） | **90** | 追跡済み変更＋未追跡から `docs/int1/**`・`scripts/int1/**` を除く |
| commit 2 対象 | **51** | `docs/int1`（attachments 3 件と照合ログ 1 件を除く）34 ＋ `scripts/int1` 17 |
| 別添（どちらの commit にも含めない） | **3** | `docs/int1/attachments/` |
| 製品コード＋テスト tree | **`3c5a616897e28ece9dab09b4d2c037f2a86a10d7`** | `docs/int1/evidence_manifest.txt` ヘッダ |

### マニフェスト件数の内訳（合計 143）

| 由来 | 件数 |
| --- | --- |
| CR（Crowding のみ） | 37 |
| O1 のみ | 15 |
| D1 のみ | 13 |
| D1＋O1（手統合） | 1 |
| D1＋CR（3way auto-merge 結果とバイト一致） | 1 |
| INT1-FIX（製品コード＋受入テスト） | 23 |
| INT1-EVIDENCE（検証スクリプト・運用文書・ログ） | 50 |
| INT1-ATTACH（別添） | 3 |

### 件数の突き合わせ

```
追跡済み変更 68 ＋ 未追跡 77 − 自己参照で対象外 2 = 143 ＝ マニフェスト件数
```

対象外の 2 件は自己参照を避けるためで、理由はマニフェストのヘッダにも書いてある。

| 対象外ファイル | 理由 |
| --- | --- |
| `docs/int1/evidence_manifest.txt` | 自分のハッシュを自分に書くと確定しない |
| `docs/int1/logs/restore-verification.log` | マニフェストを読んで照合した結果の出力であり、マニフェスト生成より後に書かれる |

## 2. 前回報告の訂正

| 項目 | 前回の報告 | 正 | 原因 |
| --- | --- | --- | --- |
| E2E ファイル数 | 「13ファイル / 30 tests」 | 報告時点は **11ファイル / 30 tests**。その後 E2E を追加し、最終は **14ファイル / 37 tests** | ファイル数を実行ログから数えず、見込みで書いた |
| 候補ファイル総数 | 67 → 92 → 125 と推移を報告 | 最終は **143**（マニフェスト件数） | 検証成果物とログを追加した分が反映されていなかった |
| commit 1 の対象 | 85 → 86 | **90** | 監査後修正で `WorkforcePanel.tsx` / `WorkforcePlanningScreen.tsx` / `decisionStudioViewModel.ts` / `e2e/int1BlankInputGuard.e2e.ts` が増えた |
| commit 2 の対象 | 34 | **51** | 検証シェル 3 本（`rebuildAuditDiffs.sh` / `buildEvidenceManifest.sh` / `verifyRestore.sh`）と最終ゲートのログを追加 |
| INT-1 テスト件数 | 48 | **unit 56 ＋ E2E 8 = 64** | 下記 §3 |
| 製品コード＋テスト tree | `b14adb0c65f1…` → `95a82d0450d9…` | **`3c5a616897e2…`** | 監査後修正、さらに最終監査での JSON 送信時の検証漏れ修正でコードが変わったため |
| 全体 lint の警告数 | 「0 errors / 警告 2」 | **0 errors / 警告 14** | 前回は対象パスが狭い実行の結果を「全体」と書いていた。今回の `npx eslint app e2e scripts` が全体。14 件はすべて既存の未使用変数・未使用importで、候補に含まれる `app/lib/v2/companyLab/runner.ts` の1件も RC 版の同ファイルを lint すると同じ警告が出ることを実測した（INT-1 が持ち込んだ警告は 0 件） |

### tree 識別子の自己参照（前回の訂正を維持）

作業 tree 全体のハッシュ（前回 `2d0fd23a…` と報告）は識別子に使えない。
その値を `candidate_identity.md` に書いた時点でファイル内容が変わり tree も変わる。
識別子は `docs/int1`・`scripts/int1` を除いた**製品コード＋テスト tree** のみを使う。

## 3. テスト件数（実行ログからの集計）

| 区分 | ファイル数 | 実行件数 | 結果 | ログ |
| --- | --- | --- | --- | --- |
| 全体 unit（`npm test`） | — | 4454 | 4454 pass / 0 fail | `logs/npm-test.log`（全出力は `attachments/npm-test-full.log`） |
| 全体 E2E（Playwright） | 14 | 38 | 37 passed（直前の実行）＋ INT1-BLANK-4 を追加して計 38。INT-1 分 4 件は今回 `logs/e2e-blank-input-guard.log` で 4 passed を再実測 | `logs/e2e.log` / `logs/e2e-blank-input-guard.log` |
| 型チェック | — | — | `npx tsc --noEmit -p .` 0 errors | `logs/tsc.log` |
| lint（全体） | — | — | 0 errors / 14 warnings（すべて既存） | `logs/eslint-project.log` |
| lint（監査後修正9ファイル） | 9 | — | 0 errors / 0 warnings | `logs/eslint-changed.log` |
| 32Turn 技術回帰 | — | — | 保存済み出力とバイト単位で一致 | `logs/run32turn-unchanged.log` |
| 差分からの復元照合 | — | 143 | 一致 143 / 不一致 0 / 欠落 0 | `logs/restore-verification.log` |
| うち INT-1 unit | 7 | 56 | 56 pass | `logs/int1-unit-tests.log` |
| うち INT-1 E2E | 3 | 8 | 8 passed | `logs/e2e-blank-input-guard.log` ほか |

### 静的な `test(` 出現数と実行件数が一致しない理由

`int1DraftValidation.test.ts` と `int1CrossCuttingIntegration.test.ts` は
ループでテストを生成するため、ソース上の `test(` の数より実行件数が多くなる。
**報告には実行件数を使う**（静的な出現数は使わない）。

## 4. INT-1 のテストファイル（unit 7 / E2E 3）

| ファイル | 実行件数 |
| --- | --- |
| `app/v2/company-lab/__tests__/int1NewFactoryCardDisclosure.test.ts` | 4 |
| `app/v2/company-lab/__tests__/int1DraftValidation.test.ts` | 13 |
| `app/v2/company-lab/__tests__/int1BacklogByProduct.test.ts` | 4 |
| `app/v2/company-lab/__tests__/int1FinancingDisclosure.test.ts` | 3 |
| `app/v2/company-lab/__tests__/int1InputPathIntegrity.test.ts` | 18 |
| `app/lib/v2/companyLab/simulation/__tests__/int1CrossCuttingIntegration.test.ts` | 10 |
| `app/lib/v2/companyLab/__tests__/int1SalesForceHiringValidation.test.ts` | 4 |
| `e2e/int1PlayerInputIntegrity.e2e.ts` | 2 |
| `e2e/int1AuthExpiryAndInput.e2e.ts` | 2 |
| `e2e/int1BlankInputGuard.e2e.ts` | 4 |

`int1InputPathIntegrity` は監査後修正で 6 件 → 12 件、最終監査での JSON 送信時の検証漏れ修正で 12 件 → 18 件に増えた。
`int1BlankInputGuard`（E2E）は 3 件 → 4 件（INT1-BLANK-4 を追加）。

## 5. 「取り込んだ commit」と「差分として含めた成果」の区別

Git ancestry（`git merge-base --is-ancestor` で実測）に含まれるのは
**Crowding の 5 commit のみ**。D1 と O1 は差分として適用した成果であり、
元 commit は候補の ancestry に含まれない。
ファイル単位の対応表は `docs/int1/contribution_map.md`、
由来区分は `docs/int1/evidence_manifest.txt` の第2列にある。
