# ShrimpX V2 — Standard AI 32Q Audit Workbook

Standard AIの32Q行動ログ・各Turnの会社状態・最終事業成績を、1つのExcel Workbookとして
Management Consoleからダウンロードできるようにした機能の仕様書。

## 1. 目的

ChatGPT / Claude / ChatSense等のAIが、このExcel 1冊を読むだけで

> Standard AIは32Turnでどのような戦略を取り、どの判断をし、その結果どのような経営業績になったか

を5社比較・Turn別・機能別に分析できるようにする。特に
**Decision → Reason → Actual Result → Business Performance** を同一Workbook内で追跡できることを狙う。
人間向けの見栄えより、AIが正確に読み取れる構造を優先する。

## 2. ダウンロード導線

Management Console（GM専用）の2箇所にボタンがある。**Player Workspaceには置かない**
（5社横断の監査資料であり、他社データがPlayerへ漏れてはならないため）。

1. Management Console のメイン列（AI Analysis Pack ボタンの直下）
2. ゲーム終了後の Final Results セクション

ボタン文言: 「Standard AI分析Excelをダウンロード」
（途中Turnでは「Standard AI分析Excel（途中経過）をダウンロード」）

### 既存exportとの区別

| 出力物 | 対象 | 形式 | 用途 |
| --- | --- | --- | --- |
| Company Databook | PLAYER 1社 | Excel | プレイヤーの運転資料 |
| AI Analysis Pack | Run全体 | ZIP（md/json/xlsx/csv） | Run全体の分析パック |
| **Standard AI Audit Workbook** | **5社横断** | **単独 .xlsx** | **Standard AI判断の監査・AI分析** |

既存2つは無変更である。

### ファイル名

- 完了時: `ShrimpX_StandardAI_Audit_{simulationRunId}_32Q.xlsx`
- 途中Turn: `ShrimpX_StandardAI_Audit_{simulationRunId}_Turn18_PARTIAL.xlsx`

「32Q」の部分はハードコードせず、実際に出力した最終Turn数を書く。

## 3. Workbook構成（20シート）

| Sheet | 粒度 | 主な内容 |
| --- | --- | --- |
| 00_README | key/value | 目的・Run識別子・意味論・AI向け分析指示・欠損データの理由 |
| 01_RUN_SUMMARY | key/value | Run metadata・status・出力Turn範囲 |
| 01b_COMPANY_PROFILE | 1社1行 | Management Profile / Orientation Profile / Vision / decisionOwner |
| 02_COMPANY_SUMMARY | 1社1行 | 全Turn累計KPI・期末財務・TSV |
| 03_TURN_KPI | 会社×Turn（160行） | 損益・BS・受注/納品/backlog・生産・稼働率・人員・配当・TSV |
| 04_STANDARD_AI_DECISIONS | 会社×Turn×領域（long） | 提案値と実適用値を別カラムで保持 |
| 05_DECISION_DIAGNOSTICS | 診断イベント（long） | 6段階トレース・reasonCode・severity |
| 06_SALES_DETAIL | 会社×Turn×市場×商品 | 希望量→提出量→成約量・価格・信頼度 |
| 07_PRODUCTION_DETAIL | 会社×Turn×工場×商品 | 計画/実績/不足・制約段階の中間値 |
| 08_PROCUREMENT_DETAIL | 会社×Turn×調達源 | DOMESTIC / IMPORT / AQUACULTURE |
| 09_WORKFORCE_DETAIL | 会社×Turn×工場 | 人員・残業・稼働率・遊休労務費 |
| 10_CAPEX_DETAIL | 案件1件1行 | projectType・状態遷移Turn・予算・支払 |
| 11_FINANCE_DETAIL | 会社×Turn | P&L / BS / CF |
| 12_BACKLOG_DETAIL | 会社×市場×商品×dueStatus | OVERDUE / DUE_THIS_TURN / FUTURE_DUE |
| 13_MARKET_DETAIL | Turn×scope×key×商品 | 市場・産地国・消費国在庫 |
| 14_DIVIDEND_DETAIL | 会社×Turn | DIV-4 の全ゲートと配当額 |
| 15_FACTORY_CAPACITY | 会社×Turn×工場 | 工場別能力・会社実効能力・稼働率 |
| 16_FINAL_RESULTS | 1社1行 | 最終順位・TSV・Company Value・Dividend Value |
| 17_DATA_DICTIONARY | field 1件1行 | 型・単位・説明・出所・nullable・semanticNotes |
| 18_EVENT_LOG | イベント（long） | CAPEX状態遷移・配当・財務健全性・シナリオイベント |
| 19_AI_PROFILE_VISION | 会社×Turn | Vision・成長圧力・Ambition→Commitment→Contract の因果 |

## 4. AI-readable設計

- 各シート Row1 = 単一ヘッダー行、Row2 からデータ
- 結合セル・装飾用空行・複数ヘッダー行・色だけで意味を表す表現を使わない
- Excel数式を使わない（確定値のみ）
- 一つの列に数字と単位文字列を混ぜない（`revenueUsd = 62500000`。`"$62.5M"` としない）
- 単位は列名の接尾辞（`Usd` / `UsdPerKg` / `HosoEqTons` / `Ratio` / `Headcount` / `Turn`）と 17_DATA_DICTIONARY で示す
- **空セル = 取得できなかった / 該当しない**。0とは構造的に区別する
- 人間向けには 先頭行固定・オートフィルタ・列幅・数値書式のみ付与

## 5. 数値の出所（重要）

Excel内の数字をAIに推測・再計算させないため、すべて既存の確定データからの**転記**である。
Excel用にゲームロジックを再実装した箇所は無い。

| 系統 | 出所 | Turn網羅性 |
| --- | --- | --- |
| 確定事実表 | `StoredSimulationRun.dataset`（SimulationAnalyticsDataset） | **全Turn** |
| 会社×Turnの期首/期末・投資案件・Vision・商業成長 | `StoredSimulationRun.packCapture` | **全Turn** |
| 会社実効能力・営業人員 | `resumePayload.capacityByTurn` / `salesHeadcountByTurn` | **全Turn** |
| 完全なエンジン記録（詳細P&L・契約明細・生産配分内訳） | `resumePayload.state.history` | **直近windowのみ**（下記§6） |
| 株主価値（Company Value / Dividend Value / TSV） | `evaluation/evaluationSemantics.ts`（既存service） | history依存 |

評価式（TSV / DCF / 15%複利）はこのexportのために一切変更していない。

## 6. 既知の制約

### 6.1 保存済みRunのhistoryは直近数Turnだけ

`persistence/resume.ts` は保存量を抑えるため、`resumePayload.state.history` と
`aiTurnTraces` を直近 `ROLLING_RESUME_HISTORY_WINDOW`（=4）Turnぶんへ間引く。

そのため**保存済みRunだけから出力した場合**、以下は直近4Turnぶんしか埋まらない:
- 11_FINANCE_DETAIL の P&L 明細行（原料費・加工費・SGA・利息・税・CF）
- 07_PRODUCTION_DETAIL の工場×商品の内訳
- 03_TURN_KPI の `companyValueUsd` / `dividendValueUsd` / `totalShareholderValueUsd`

**これは Final Results / TSV履歴が終盤Turnからしか値を持たない現象の原因でもある**
（実装指示§23の監査対象）。株主価値サービスは確定CF計算書を必要とし、それが
間引きwindowの中にしか無いため。valuation engine側の不具合ではない。

**対策**: Management Console は live session を保持しているため、ボタンは
`liveHistory` としてその確定履歴を渡す。これにより Console から出力する限り
全32Turnの詳細シートとTurn別TSVが埋まる。渡せない場合もexportは失敗せず、
欠損理由が 00_README の `missingDataNote` 行へ必ず記録される。

### 6.2 Standard AI diagnostics の構造化フィールド

`StandardAiDiagnosticEntry` のうち Run に永続化されるのは6段階トレース
（label / value / unit / text）であり、`thresholdValue` / `keyValues` / `domain` /
`targetFactoryId` / `gateName` は保存されない。**reasonCodeとseverityは全件保持される**
（実測107種類）が、上記の列は空欄になる。

### 6.3 Turn別 × dueStatus の backlog

契約ごとの残高スナップショットはTurn別に保存されていないため、12_BACKLOG_DETAIL は
asOfTurn時点のsnapshotである。Turn別の backlog / overdue 合計は 03_TURN_KPI に確定値として存在する。

### 6.4 Run中に建った工場の能力

Turn別・工場別の能力は保存されていない。15_FACTORY_CAPACITY の能力列は初期fixture由来で
埋め、Run中に建った工場は `factorySource=BUILT_DURING_RUN` かつ能力列は空欄になる
（会社レベルの実効能力は全Turnぶん同シートにある）。

### 6.5 legacy run

古い保存物（packCapture / resumePayload 無し）でもexportは失敗しない。該当fieldは空欄になり、
理由が 00_README へ記録される。

## 7. AI分析の使い方

00_README の `aiAnalysisInstruction` に以下を明記している。

> Use source fields directly. Do not infer missing values. Distinguish facts, diagnostics, and interpretation.

**Decision → Reason → Actual Result → Business Performance** を辿るには、
`companyId` + `turn` をキーに次を結合する。

1. 04_STANDARD_AI_DECISIONS … 何を決めたか（提案値と実適用値）
2. 05_DECISION_DIAGNOSTICS … なぜそう決めたか（reasonCode / severity / 6段階）
3. 06〜15 の該当detailシート … 実際に何が起きたか
4. 03_TURN_KPI … その結果の業績

分析例と、それを追える列:

| 問い | 使う列 |
| --- | --- |
| MASSはなぜ大量生産型と評価できるか | 03_TURN_KPI の生産量/稼働率、19_AI_PROFILE_VISION の Vision・Ambition、01b の Management Profile |
| VAPはどのTurnから他社に遅れたか | 03_TURN_KPI の revenueUsd / operatingProfitUsd をTurn別に比較、19 の primaryGrowthConstraint |
| CAPEX判断とTSVの関係 | 10_CAPEX_DETAIL の completionTurn と 03_TURN_KPI の totalShareholderValueUsd |
| 終盤Cashが積み上がった理由 | 11_FINANCE_DETAIL の CF三区分、14_DIVIDEND_DETAIL のゲート、10_CAPEX_DETAIL の投資有無 |

## 8. 実装ファイル

```
app/lib/v2/companyLab/simulation/auditWorkbook/
  types.ts        行の型定義（null と 0 の区別を型で表す）
  rows.ts         保存済みRunからの転記（ゲーム計算は一切しない）
  dictionary.ts   17_DATA_DICTIONARY の内容
  workbook.ts     ExcelJS による .xlsx 生成
  index.ts        buildStandardAiAuditExport / ファイル名規則
app/v2/management/components/StandardAiAuditWorkbookButton.tsx
```

Excel生成基盤は既存の ExcelJS（AI Analysis Pack・SAI-3B workbook と同じ依存）を再利用しており、
新しいライブラリも新しい生成基盤も追加していない。

## 9. テスト

`app/lib/v2/companyLab/simulation/auditWorkbook/__tests__/standardAiAuditWorkbook.test.ts`
に SAI-AUDIT-XLSX-1〜18。実際に32Qを走らせた実データで検証する（fixtureの偽データではない）。
