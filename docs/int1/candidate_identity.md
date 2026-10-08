# INT-1 ローカル統合候補 識別情報

更新: 2026-10-08 JST（最終監査でのJSON送信時の検証漏れ修正を反映）

**この識別情報は commit SHA ではない。** 新しい commit は作っていない（承認前）。
commit 承認後に、ここに記録した tree hash とファイル一覧が確定 commit SHA へ対応付けられる。

## 基点 commit

```
base commit : a79ec99a477c0f13765856cf63666436fac8e014
base subject: feat(sales): 正式P1 Crowding を salesModelId へ接続し診断を Persistence v9 で保存する
worktree    : /home/user/vietnam-shrimp-game/.worktrees/int1
local branch: local/int1-candidate-20261006  (ローカルのみ・remoteに同名なし)
追加commit  : 0 本
```

## 取り込んだ3成果の full SHA

```
基準RC    integration/v2-rc-20260830                    728b3416028dabd44556a55de3f8abd84726817d
D1        feature/v2-player-admin-dividend-settlement    c55b81ec23c9396e420c90ed59f2770d44da5003
O1        feature/v2-player-submit-persistence-race-fix  408c3ddf5116cbce6bb8740b1d6cdb2e52511636
Crowding  feature/v2-eng-crowding-markdown-1             a79ec99a477c0f13765856cf63666436fac8e014
```

Git ancestry に含まれるのは Crowding の 5 commit のみ。D1 と O1 は差分として適用している。
詳細な対応表は `docs/int1/contribution_map.md`。

## 候補の tree 識別子

```
製品コード＋テスト tree（docs/int1・scripts/int1 を除く）
  3c5a616897e28ece9dab09b4d2c037f2a86a10d7

  ※ 最終監査での JSON 送信時の検証漏れ修正でコードが変わったため、
    b14adb0c65f17283b7da8203dea49f4ccab94355（監査前）と
    95a82d0450d9ebe64c11946bdb9d09364ab011c3（監査後修正時点）はいずれも無効。

参照
  RC tree       fcc69d31cd714edee7e683c929b70f3a95a097cc
  Crowding tree 5ddb81ea2bbdce18bde2ef523ee35bb5d292f7b5
```

### 【訂正】前回報告した「作業tree全体 2d0fd23a…」は識別子として使えない
前回の報告では作業tree全体のハッシュも識別子として挙げたが、その値を
この `candidate_identity.md` 自身へ書き込んだ時点でファイル内容が変わり、
tree ハッシュも変わってしまう（自己参照）。実際に `2d0fd23a…` は
値を書き込む前の tree を指しており、書き込み後は別の値になっていた。
**以後は「製品コード＋テスト tree」を唯一の識別子とする。** このtreeは
`docs/int1` を含まないため、文書を更新しても値が動かない。
全ファイルの SHA-256 は `docs/int1/evidence_manifest.txt` にあり、
こちらもマニフェスト自身を対象外にして自己参照を避けている。

## 変更ファイル内訳（RC比・未追跡含む）

| 由来 | 件数 | 内容 |
| --- | --- | --- |
| Crowding のみ | 37 | 市場集中価格低下（正式P1）＋ 保存形式 v9 |
| O1 のみ | 15 | 提出・保存の競合対策（revision/CAS）＋ staging TTL 昇格修正 |
| D1 のみ | 13 | 管理者指定の年間配当を PLAYER / Standard AI 共通で Q4 精算 |
| D1 × Crowding | 1 | `app/lib/v2/companyLab/runner.ts` |
| D1 × O1 | 1 | `app/v2/management/player/PlayerWorkspace.tsx` |
| INT-1 の最小修正＋受入テスト | 23 | UI修正 11 ファイル＋受入テスト 10 ファイル＋配線等 |
| INT-1 の検証用スクリプト・運用文書・ログ | 50 | 製品コードではない |
| 別添（どちらの commit にも含めない） | 3 | 巨大な生成物。再生成可能。チェックサムで対応付け |

非重複ファイル（Crowding 36 / O1 15 / D1 13）は出所 branch の内容と `cmp` でバイト単位一致を確認済み（不一致 0 件）。

## INT-1 で手を入れた製品コード（11）

| ファイル | 内容 |
| --- | --- |
| `app/v2/company-lab/investmentPlanningViewModel.ts` | 新工場建設カードの能力説明を Engine の newFactoryEffect から作る |
| `app/v2/management/analysis/commercial-growth/CommercialGrowthView.tsx` | AI参考値とPLAYER実績の区別・決定者列・注意書き |
| `app/v2/company-lab/decisionDraft.ts` | `validateDecisionDraftNumbers` を追加（サニタイズ自体は無変更）。最終監査後、省略可能な項目の検証を「キーが無ければ省略／キーがあれば検証」へ変え、JSON送信で `null` になった空欄の検証漏れを閉じた |
| `app/v2/company-lab/components/InputCells.tsx` | 空欄・不正値を0へ変換せず、負数・範囲外も丸めない（監査後修正） |
| `app/v2/company-lab/components/WorkforcePanel.tsx` | 独自の`<input>`3つを共通セルへ置換し、下書きの生値にバインド（監査後修正） |
| `app/v2/company-lab/decisionStudioViewModel.ts` | 申請額が非有限のとき見込み支払額の表示が NaN になるのを回避（監査後修正） |
| `app/lib/v2/companyLab/salesForceHiring.ts` | `validateSalesForceHiringDecision` を追加（engine と同じ上限関数を使う） |
| `app/lib/v2/player/submit.ts` | 提出前に営業人員制約を検証して拒否 |
| `app/v2/company-lab/components/BacklogByProductPanel.tsx` | 商品別受注残の表示（集計は既存SSoTのみ） |
| `app/v2/company-lab/components/LastQuarterFinancingResultPanel.tsx` | 前Turnの借入結果・緊急融資の表示 |

配線のみ: `DecisionStudio.tsx` / `SalesPlanningScreen.tsx` / `ProductionPlanningScreen.tsx` /
`FinancePlanningScreen.tsx` / `PlayerWorkspace.tsx` / `app/v2/play/workspace/page.tsx` /
`app/lib/v2/player/decisionContext.ts`。

## 統合・整合のための既存ファイル手修正（4）

| ファイル | 内容 |
| --- | --- |
| `app/v2/management/player/PlayerWorkspace.tsx` | D1×O1 の競合解消＋提出前検証の呼び出し＋`workspace-turn` testid＋未確定下書きの注意書き |
| `app/lib/v2/companyLab/runner.ts` | D1×Crowding（git の3way auto-merge 結果とバイト一致。手修正なし） |
| `e2e/managementSalesModelSelector.e2e.ts` | O1の非同期確定に合わせた待機追加 |
| `e2e/salesPriceReference.e2e.ts` ＋ `SalesPlanningScreen.tsx` | 受注残パネル追加で壊れた位置指定ロケータを `sales-plan-table` 指定へ変更 |
| `app/v2/company-lab/components/decisionStudio/WorkforcePlanningScreen.tsx` | `WorkforcePanel` へ下書き行を渡す配線（監査後修正） |
| `app/v2/play/workspace/page.tsx` | Independent Player の提出前に同じ検証関数を通す（最終監査後修正） |

## 成果物の場所

```
統合候補のworktree      /home/user/vietnam-shrimp-game/.worktrees/int1
証拠マニフェスト         docs/int1/evidence_manifest.txt   全ファイルのSHA-256(64桁)と由来
commit構成・承認対象     docs/int1/commit_plan.md
取り込み元の対応表       docs/int1/contribution_map.md
機能と既知の制限         docs/int1/candidate_release_notes.md
操作手順                docs/int1/operating_procedures.md
研修前チェックリスト      docs/int1/pre_training_checklist.md
マニュアル反映点         docs/int1/manual_change_points.md
UI課題の調査と対処       docs/int1/ui_issues.md
Staging配備・復旧計画    docs/int1/staging_deployment_plan.md
32Turn技術回帰の出力     docs/int1/run32turn_regression.txt
実行ログ（CMD/EXIT付き） docs/int1/logs/*.log
差分とマニフェストの再生成 scripts/int1/rebuildAuditDiffs.sh（→ buildEvidenceManifest.sh → verifyRestore.sh）
復元照合の結果           docs/int1/logs/restore-verification.log
検証スクリプト           scripts/int1/*.ts
別添（commit対象外）     docs/int1/attachments/
```
