# Standard AI Training Harness v1 — 設計

作成: 2026-08 / branch `feature/v2-standard-ai-training-harness`

## 1. 目的

ゲーム環境（世界）を一切変更せずに、Standard AI だけを反復的に評価・改善するための計測基盤。

このハーネスが成立するための前提はただ一つで、**「AIが良くなった」と「世界が変わった」を後から必ず区別できること**である。この前提が崩れると、Before/After 比較の結論はすべて無意味になる。そのため設計の中心は評価ロジックではなく、環境の同一性を機械的に証明する fingerprint 層に置いている。

## 2. 構成

| 層 | ファイル | 責務 |
|---|---|---|
| 環境同一性 | `app/lib/v2/companyLab/standardAi/training/fingerprint.ts` | ゲームエンジン実装（standardAi配下を除く）の内容ハッシュを算出 |
| ベンチマーク | `.../training/benchmark.ts` | 独立したin-memoryシミュレーションを回し、全 company × quarter の decision / result を記録 |
| 監査 | `.../training/audit.ts` | 記録に対して監査ルール A01–A14 / Level B を適用し findings を生成 |
| CLI | `scripts/standardAiTraining.ts` | 上記を実行し `analysis_output/standard_ai_training/` へ JSON / CSV を出力 |
| 自己検証 | `.../training/__tests__/trainingHarness.test.ts` | ハーネス自体の前提（環境分離・決定論性・非永続化）を固定 |

## 3. 環境 fingerprint の設計

`computeEnvironmentFingerprint()` は 2 つの独立したハッシュを返す。

- **`environmentFingerprint`** — market / sales / rawMaterials / production / finance / financing / capex / quality / scenario / turn / core の各ディレクトリと、companyLab のゲームルール側ファイル（fixtures, parameters, runner, types, workforce, salesForceHiring, salesBase, marketEvolution, externalDemand, domesticReferencePrice）の内容から算出する。**`standardAi/**` は意図的に含めない。**
- **`standardAiFingerprint`** — `standardAi/**` から算出する（`training/` は除く。ハーネス自体の変更でAI版が動いたと誤解しないため）。

`__tests__` はどちらからも除外する（テストを足しただけで環境が変わったと誤判定しないため）。

この設計により、**AI のファイルだけを変更した2回のベンチマークでは `environmentFingerprint` が必ず一致する**。今回の Cycle 1 でも実際に一致した（後述）。この性質自体をテストで固定している。

## 4. ベンチマークプロファイル

| profile | quarters | seeds | 用途 |
|---|---|---|---|
| quick | 8 | 3 | 実装中の高速確認（5社×8Q×3seed = 120 company-quarter） |
| standard | 32 | 10 | 正式な Before/After 比較（1,600 company-quarter） |
| deep | 32 | 50 | 最終確認用（8,000 company-quarter） |

seed は `sai-train-<profile>-001…` として profile から導出する（ハードコードしない）。

## 5. 記録するもの

`CompanyQuarterRecordRow` = `{ seed, companyId, turn, period, decision, result }`。

- `decision` — 販売計画（市場×商品×数量×価格調整×営業人員）、市場別営業配置、営業採用/減員、生産計画、ワーカー配置、国内買付・輸入・養殖、借入・期限前返済、capex提案、VAP開発費、理由コード、primary/secondary制約、各種診断ステート
- `result` — 成約量・平均価格、履行・未履行・延滞、市場×商品別配分、生産量、完成品/原料在庫、原料・設備・労働の不足量、設備/労働稼働率、残業率、臨時比率、現金、売掛買掛、借入残高、営業CF、営業利益、純利益、遊休労務費、承認借入、緊急借入、支払不能、債務超過、建設中案件

## 6. 隔離条件（守っていること）

- **Test15 の保存データに触れない** — ベンチマークは `initializeCompanyLab` / `advanceCompanyLabQuarter` を in-memory で呼ぶだけで、Redis / Repository / 永続化層を一切 import しない（テストで固定）。Test15 のターンを進めることもない。
- **ゲーム環境を変更しない** — 変更したのは `standardAi/**` とハーネスのみ。`environmentFingerprint` の不変がその機械的な証明になる。
- **決定論的** — 同一 seed の2回実行はバイト単位で一致する（テストで固定）。これが無いと Before/After の差が改善なのかノイズなのか区別できない。

## 7. 使い方

```bash
npx tsx scripts/standardAiTraining.ts --profile standard --label baseline
npx tsx scripts/standardAiTraining.ts --profile standard --label after-cycle-1
```

出力（`analysis_output/standard_ai_training/`）:

- `<label>_<profile>_records.json` — 全 company-quarter の decision / result（生データ）
- `<label>_<profile>_findings.json` — 監査 findings
- `<label>_<profile>_summary.json` — fingerprint・severity/rule別集計・経営指標の集計
- `<label>_<profile>_findings.csv` — 表計算で見るための一覧

## 8. このハーネスがやらないこと

- ゲームルール・パラメータの変更提案を自動で適用しない。環境側の変更が必要に見えた場合は**停止して報告する**。
- 経営哲学（どの市場を狙うか、どれだけ攻めるか等）を自ら決めない。該当する指摘は `MANAGEMENT_JUDGMENT_REVIEW` として分類し、判断を仰ぐ。
- 環境側の不具合を修正しない。`ENVIRONMENT_ISSUE_CANDIDATE` として報告するに留める。
