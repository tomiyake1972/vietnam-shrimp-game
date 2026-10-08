# INT-1 統合候補 — commit 構成と承認対象

更新: 2026-10-08 JST（最終監査でのJSON送信時の検証漏れ修正を反映）/ 状態: **未commit・未push**。実行には承認が必要。

## 1. branch

| 項目 | 値 |
| --- | --- |
| 作業中のローカルbranch | `local/int1-candidate-20261006`（基点 `a79ec99a477c0f13765856cf63666436fac8e014`、追加commit 0本） |
| push 先として提案された branch | `integration-prep/v2-int1-training-candidate` |
| 同名 branch の有無（実測） | ローカル・remote どちらにも**存在しない**（`git branch -a` / `git ls-remote --heads origin` で確認） |

同名が無いため上書きの懸念はない。push は normal push（force push はしない）。

## 2. commit 1 — 製品コード・テスト

```
feat(v2): prepare integrated training trial candidate
```

対象 **90 ファイル**。内訳:

| 由来 | 件数 | 内容 |
| --- | --- | --- |
| Crowding | 37 | 市場集中価格低下（正式P1）＋ 保存形式 v9 |
| O1 | 15 | 提出・保存の競合対策（revision/CAS）＋ staging TTL 昇格修正 |
| D1 | 13 | 管理者指定の年間配当を PLAYER / Standard AI 共通で Q4 精算 |
| D1 × Crowding | 1 | `app/lib/v2/companyLab/runner.ts`（3way auto-merge 結果とバイト一致） |
| D1 × O1 | 1 | `app/v2/management/player/PlayerWorkspace.tsx`（手統合） |
| INT-1 の最小修正＋受入テスト | 23 | 下記 |

### INT-1 の最小修正（製品コード 11 ファイル）

| ファイル | 内容 |
| --- | --- |
| `app/v2/company-lab/investmentPlanningViewModel.ts` | 新工場建設カードの能力説明を Engine の `newFactoryEffect` から作る |
| `app/v2/management/analysis/commercial-growth/CommercialGrowthView.tsx` | AI参考値と PLAYER実績の区別・決定者列・注意書き |
| `app/v2/company-lab/decisionDraft.ts` | `validateDecisionDraftNumbers` を追加（サニタイズ自体は無変更）。省略可能な項目の検証を「キーが無ければ省略／キーがあれば検証」へ変え、JSON送信で `null` になった空欄の検証漏れを閉じた（最終監査後） |
| `app/v2/company-lab/components/InputCells.tsx` | 空欄・不正値を0へ変換せず、負数・範囲外も丸めない（監査後修正。詳細は `zero_value_handling.md`） |
| `app/v2/company-lab/components/WorkforcePanel.tsx` | 独自の`<input>`3つを共通セルへ置換し、サニタイズ後のview-modelではなく下書きの生値にバインド（監査後修正） |
| `app/v2/company-lab/decisionStudioViewModel.ts` | 申請額が非有限のとき見込み支払額の表示が NaN になるのを回避（監査後修正） |
| `app/lib/v2/companyLab/salesForceHiring.ts` | `validateSalesForceHiringDecision` を追加（engine と同じ上限関数を使う） |
| `app/lib/v2/player/submit.ts` | 提出前に営業人員制約を検証して拒否 |
| `app/v2/company-lab/components/BacklogByProductPanel.tsx` | 商品別受注残の表示（集計は既存SSoTのみ） |
| `app/v2/company-lab/components/LastQuarterFinancingResultPanel.tsx` | 前Turnの借入結果・緊急融資の表示 |

配線のみの変更: `DecisionStudio.tsx` / `SalesPlanningScreen.tsx` / `ProductionPlanningScreen.tsx` /
`FinancePlanningScreen.tsx` / `PlayerWorkspace.tsx` / `app/lib/v2/player/decisionContext.ts`。
`app/v2/play/workspace/page.tsx` は配線に加えて、提出前に同じ検証関数を通す処理を追加した（最終監査後）。

### INT-1 の受入テスト（10 ファイル）

`int1NewFactoryCardDisclosure` / `int1DraftValidation` / `int1BacklogByProduct` /
`int1FinancingDisclosure` / `int1InputPathIntegrity` / `int1SalesForceHiringValidation` /
`int1CrossCuttingIntegration` と、E2E `int1PlayerInputIntegrity` / `int1AuthExpiryAndInput` /
`int1BlankInputGuard`（監査後追加・実ブラウザで空欄と不正値を確認。最終監査後に
Independent Player の JSON 送信経路を確認する INT1-BLANK-4 を追加）、
および統合に伴い待機を追加した `e2e/managementSalesModelSelector.e2e.ts`、
受注残パネル追加に合わせてロケータを直した `e2e/salesPriceReference.e2e.ts`。

## 3. commit 2 — 検証用スクリプト・運用文書・レビューに必要な証拠

```
docs(v2): record training trial validation and operations
```

対象 **51 ファイル**。

| 区分 | 内容 |
| --- | --- |
| `scripts/int1/` 17 本（うちシェル 3 本） | 隔離Redis用RESPクライアント、TTL試験と対照実験、32Turn技術回帰、復旧経路検証、入力経路監査、各再現スクリプト |
| `docs/int1/*.md` 8 本 | 識別情報・機能と既知の制限・操作手順・研修前チェックリスト・マニュアル反映点・UI課題・配備と復旧計画・取り込み対応表 |
| `docs/int1/run32turn_regression.txt` | 32Turn 技術回帰の出力 |
| `docs/int1/logs/` 21 本（うち `restore-verification.log` はマニフェスト対象外） | 実行コマンド・終了コード付きのログ（`### CMD:` / `### EXIT:` を各ファイル先頭と末尾に記録） |
| `docs/int1/evidence_manifest.txt` | 全ファイルの SHA-256（64桁）と由来 |
| `docs/int1/commit_plan.md` | 本文書 |

## 4. 別添（どちらの commit にも含めない）

巨大な生成物であり、いずれも手元の情報から再生成できる。チェックサムで対応付ける。

| ファイル | サイズ | 再生成方法 |
| --- | --- | --- |
| `docs/int1/attachments/candidate_tracked.diff` | 68 ファイル分 | `bash scripts/int1/rebuildAuditDiffs.sh`（基準は RC `728b3416…`） |
| `docs/int1/attachments/candidate_untracked.diff` | 39 ファイル分 | 同上 |
| `docs/int1/attachments/npm-test-full.log` | — | `npm test`（要約は `docs/int1/logs/npm-test.log` に収録） |

サイズは版ごとに変わるため記載しない。確定値は `evidence_manifest.txt` の SHA-256 で対応付ける。

### 復元手順（適用元と順序）

```
1. git archive 728b3416028dabd44556a55de3f8abd84726817d | tar -x -C <空ディレクトリ>
2. git apply docs/int1/attachments/candidate_tracked.diff
3. git apply docs/int1/attachments/candidate_untracked.diff
```

**Crowding HEAD（`a79ec99a…`）へ重ねてはいけない。** `candidate_tracked.diff` は
RC からの差分であり Crowding の変更も既に含むため、Crowding HEAD に適用すると二重になる。
この手順で復元した結果とマニフェスト全 143 件のハッシュが一致することを
`scripts/int1/verifyRestore.sh` で確認済み（`docs/int1/logs/restore-verification.log`）。

SHA-256 は `docs/int1/evidence_manifest.txt` の `INT1-ATTACH` 行に記載。

## 5. 秘密情報の扱い

- 差分・ログに認証トークン・環境変数の値は含まれていない（`grep` で確認済み）。
- build は隔離環境でローカル placeholder の環境変数を使って実行しており、その値はログに出力されていない（`grep` で 0 件を確認）。
- E2E が使う `STAGING_ADMIN_TOKEN` は既存のテスト用固定値（`e2e-test-token`）であり、本番・Staging の値ではない。

## 6. 承認が必要な操作（この順）

1. commit 1 と commit 2 を `local/int1-candidate-20261006` の上に作る。
2. `integration-prep/v2-int1-training-candidate` へ normal push する。
   - **push に伴い Vercel の自動 Preview が作られる可能性がある。** Preview を作らない運用が必要な場合は、push 前に Vercel 側の Git 連携設定（当該 branch の Preview 生成）を確認する。
3. Staging へ配備する（`docs/int1/staging_deployment_plan.md` の手順）。
4. 共有RC（`integration/v2-rc-20260830`）への merge は本計画の範囲外。別途判断。
