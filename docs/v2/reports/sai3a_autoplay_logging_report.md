# Phase SAI-3A レポート — 標準AI自動テストプレイ・判断記録基盤

対象: `feature/v2-sai3a-autoplay-logging`（`develop/v2`の`5c1d62e`起点。SAI-2マージ後）
本Markdownは`docs/v2/reports/sai3a_autoplay_logging_report.md`としてgit管理下にあります。
サンプル出力（1社×2四半期）は同ディレクトリの`sai3a_sample_fixture/`にコミット済みです。
実行生成物（`artifacts/sai3a/<run-id>/`）自体はgit管理対象外です（`.gitignore`参照）。

---

## 1. 目的とスコープ

SAI-3Aは、**標準AIを「テストプレイヤー」として5社×複数seedで自動運転し、判断過程を
構造化データとして記録する再利用可能な基盤**を構築するフェーズです。今回はExcel分析
ブック自体（SAI-3B）・Vercel自動運転ボタン・ゲームバランス評価・標準AIの大幅改造は
**行いません**。作るのは「四半期開始時状態→標準AIの事前希望案→各種制約による調整→
最終意思決定→四半期結果」を1本の再現可能なログとして保存する実行基盤そのものです。

**変更していないもの**: ゲームルール・standard AIの判断ロジック自体（意思決定の中身）・
既存のシミュレーション実行系（`companyLab/runner.ts`・`report/decomposeHarness.ts`）。
本フェーズの変更は、(a) 既存コードに元々あった「AIの事前希望量」を捨てずに外へ出す
最小限の追加フィールド2件と、(b) それらを読み取って構造化ログへ組み立てるだけの新規
モジュール群（`autoplay/`）です。

## 2. アーキテクチャ — 既存実装の再利用ポイント

新しいシミュレーション実行系・新しい標準AIロジックは一切作っていません。すべて既存の
部品を組み合わせているだけです。

| 既存の部品 | 役割 | 変更有無 |
|---|---|---|
| `standardAi/policy.ts`の`createStandardAiProvider()` | AIの意思決定＋診断情報（`StandardAiQuarterDiagnostics`）を副作用なしで収集する既存フック（SAI-1.5で追加済み） | 変更なし（そのまま利用） |
| `standardAi/report/decomposeHarness.ts`の`initializeUnifiedCompanyLabFromTemplate` + `runFromInit` | 5社を同一初期条件で複製し、Nターン回す既存ハーネス（SAI-2で確立） | 変更なし（そのまま利用） |
| `standardAi/report/standardBaseline.ts` | SAI-2で選定した標準初期条件（`moderate-pressure`、標準営業人員80人） | 変更なし |
| `companyLab/runner.ts`の`record.financingResults[].procurementConstraint` | 国内買付・輸入・養殖入れの「希望→資金制約後の最終値」（既に計算・保存済み） | 変更なし（そのまま読み取る） |
| `sales/marketEffort.ts`の`MarketSalesEffortAdjustment`・`computeMarketSalesEffort`・`salesEffortWeightedQuantity` | 営業工数制約のbefore/after/scaleFactor、および営業工数換算数量の計算式 | 変更なし（計算式を再利用） |
| `companyLab/types.ts`の`companySummaries[].reasonCodes`・`standardAi/reasonCodes.ts` | 会社側・AI側それぞれの既存reason code | 変更なし（コード自体は増やさない） |
| `decision/sales.ts`の`desiredByMarketProduct` | 営業工数制約を適用する**前**の、AIの希望販売数量。既存コードには計算されていたが**外部へ返されていなかった**唯一のギャップ | **追加のみ**: `SalesWishEntry`/`salesWishByMarketProduct`として`SalesPlanResult`に追加 |
| `standardAi/policy.ts`の`StandardAiQuarterDiagnostics` | 上記の`salesWishByMarketProduct`を診断情報へ追加転記 | **追加のみ**: フィールド1件追加 |

新規に追加したのは`app/lib/v2/companyLab/standardAi/autoplay/`配下のみです。

```
app/lib/v2/companyLab/standardAi/autoplay/
  schema.ts          # ログのスキーマ定義（型のみ。SAI3A_LOG_SCHEMA_VERSION = "1.0.0"）
  capture.ts         # 意思決定生成「直前」の(fixture, ownState, publicInfo)を副作用として記録するデコレータ
  runCase.ts         # 1 seed×指定会社群×指定クォーター数を実行する（既存ハーネスの薄いラッパー）
  reasonTaxonomy.ts  # 既存reason code → 集計用カテゴリ（AdjustmentCategory）の対応表（新コードは作らない）
  buildLog.ts        # 実行結果を読み取り、A〜Eの構造化ログへ組み立てる純粋関数群
  runBatch.ts        # 複数seedのバッチ実行（1件の失敗を隔離し、残りを継続する）
  output.ts          # バッチ結果を7種類のファイル内容（JSON/CSV/JSONL）へ整形する純粋関数群
  cli/
    types.ts / argParser.ts / runCli.ts / index.ts   # 引数解析・実行オーケストレーション（副作用なし）
  __tests__/, cli/__tests__/                          # テスト（下記§9参照）
scripts/sai3aAutoplay.ts   # 唯一の副作用（fs書き込み・標準出力・終了コード）を持つ薄いエントリポイント
```

### 2.1 データフロー

```
runAutoplayCase（1 seed）
  → initializeUnifiedCompanyLabFromTemplate + runFromInit（既存ハーネス）
  → createInstrumentedStandardAiRun（既存providerを薄くラップし、意思決定生成直前の
     入力もキャプチャする。返り値=意思決定そのものは一切変更しない）
  → { history, diagnostics, quarterStartCaptures }

buildAutoplayCaseLogs（1ケースぶん）
  → buildQuarterStartState        … セクションA（四半期開始時状態）
  → buildQuarterDecisionLog       … セクションB/D（希望案・最終意思決定）
  → buildAdjustmentTrace          … セクションC（調整過程のbefore/after/delta/reason code）
  → buildSalesQuantityTrace       … 市場×商品別の希望→最終数量トレース
  → buildQuarterResultLog         … セクションE（四半期結果）
  → buildCaseSummaryRow           … ケース単位の最終集計行

runAutoplayBatch（複数seed）
  → 各seedをtry/catchで実行し、失敗は握りつぶさずCaseErrorとして記録、残りを継続
  → buildRunSummary               … run全体の集計

output.ts
  → manifest.json / case-summary.csv / quarter-summary.csv / decision-trace.jsonl /
     adjustment-trace.csv / warnings.csv / run-summary.json への整形（fsには触れない）

scripts/sai3aAutoplay.ts
  → 実際のfs.writeFileSync・標準出力・終了コード（唯一の副作用）
```

## 3. ログの構造（A〜E）

セクション名は三宅さんの指示の構成（A. 四半期開始時状態／B. 事前希望案／C. 調整過程／
D. 最終意思決定／E. 四半期結果）にそのまま対応します。**既存コードの実際の処理順序に
存在しない段階は作っていません**（例: 販売の「希望→営業工数調整後→財務・信用調整後→
最終計画」のうち、財務・信用調整は生産・調達（国内買付・輸入・養殖）にのみ存在し、
販売数量自体には財務・信用調整の段階が存在しないため、販売のトレースは
「希望→営業工数調整後（=最終）」の2段階のみで止めています）。

### 3.1 セクションA: `QuarterStartState`（四半期開始時状態）

会社×turnごとに1件。現金・売掛/買掛・借入残高・追加借入余力・信用区分・
`paymentDefault`/`underwritingFrozen`関連状態・原料/完成品在庫・生産能力・
ワーカー数・営業人員数・営業工数換算能力（参考値）・品質/顧客信頼/納期信頼性・
主要pressure・前四半期からの変化、を保持します。

**信用スコア・借入余力・underwritingFrozenの扱いに関する設計判断**: これらは
「四半期処理の一部として」計算される値であり、四半期開始（意思決定生成）の時点では
その四半期分はまだ存在しません。したがって「前四半期末のFinancingQuarterResult」
（＝AIが実際にこの四半期の意思決定を行った時点で参照可能だった直近の確定値）を
`buildQuarterStartState`の`previousFinancing`引数として渡し、それをそのまま転記します。
turn=1（run開始時点、前四半期が存在しない）だけは、存在しない値を捏造せず
`creditTier: "unscored"` / `creditScore0to100: NaN`（JSON上はnull）のままにしています。

`salesEffortCapacityHosoEqTons`（セクションA）は「会社の総営業人員を単一市場に
集中投入したと仮定した場合の参考値」であり、四半期開始時点では市場別の人員配分が
まだ決まっていない（配分自体がAIの意思決定の一部）ため、真の「今期使える能力」は
一意に定まりません。実際に使われた市場別配分に基づく正確な値はセクションE
（`QuarterResultLog.salesEffortCapacityHosoEqTons`）を参照してください。

### 3.2 セクションB/D: `QuarterDecisionLog`（事前希望案・最終意思決定）

`wish`（AIが提出した意思決定。国内買付/輸入/養殖の希望数量・生産希望数量・
ワーカー配置・借入希望・設備投資提案件数）と、`final`（quarter runnerへ実際に
渡された最終値。資金制約適用後の国内買付・輸入停止有無・輸入数量・養殖入れ数量）を
分離して保持します。`final`は`record.financingResults[].procurementConstraint`
（既存コードに既に計算・保存済み）をそのまま転記しているだけで、新しい判定は
一切行っていません。

販売（sales）については、AIが提出する時点で既に営業工数制約を内部で織り込んで
縮小提出するため、`wish`/`final`の構造には含めず、市場×商品別の粒度で別途
`SalesQuantityTraceEntry`（§3.4）としてトレースしています。

### 3.3 セクションC: `AdjustmentTraceEntry`（調整過程）

`before`/`after`/`delta`/`reason code`/簡潔な説明/関連pressure・閾値を持つ1件ずつの
記録です。reason codeは既存の2つのregistry（`StandardAiReasonCode`・
`CompanyReasonCode`）をそのまま再利用し、新しいコードは一切作っていません
（§5参照）。`category`（`AdjustmentCategory`、10種類）は、既存コードの上に被せる
集計用の分類ラベルにすぎず、reason code自体の意味を変えるものではありません。

**既知の制約**: 標準AI側の診断エントリ（`diagnostics.entries`、例:
`SALES_REDUCED_FOR_SUPPLY_LIMIT`）は、市場ごとの構造化されたbefore/after数量を
`StandardAiDiagnosticEntry`型自体が持たない（`keyValues`はコードごとに異なる
キー集合を持つ自由形式のRecordであり、汎用的に「市場」「before数量」「after数量」を
安全に抽出できない）ため、これらのエントリは`before`/`after`/`delta`が
`undefined`のままです。市場×商品別の正確なbefore/after数量は、`before`/`after`を
無理に捏造するのではなく、専用の`salesQuantityTrace`（§3.4）側で正確にトレース
しています。一方、`record.financingResults[].procurementConstraint`由来
（`PROCUREMENT_CASH_CONSTRAINED`）・`record.salesRecord.salesEffortAdjustments`由来
（`SALES_PLAN_REDUCED_FOR_EFFORT_CAPACITY`）・`borrowingCapacity.underwritingFrozen`由来
（`UNDERWRITING_FROZEN`）の3種類は、いずれも既存データ自体が構造化された数値を
持つため、`before`/`after`/`delta`を正確に埋めています。

### 3.4 `SalesQuantityTraceEntry`（市場×商品別の販売数量トレース）

`desiredQuantityBeforeEffortConstraint`（営業工数制約前の希望数量、今回新規に
外部公開した`salesWishByMarketProduct`由来）→ `finalPlannedQuantity`
（営業工数制約後、AIが最終的に提出した計画数量）を、会社×turn×市場×商品の
粒度で保持します。実際に成約・履行した数量（`newContractedQuantity`等）は
市場×商品単位に分解されないため（既存の`CompanyQuarterSummary`が会社単位でしか
持たない）、存在しない粒度を無理に作らず、会社単位のみセクションEで保持します。

### 3.5 セクションE: `QuarterResultLog`（四半期結果）

売上高・粗利・営業利益・純利益・営業/投資/財務CF・期末現金・借入残高・追加借入余力・
市場/商品別販売数量・生産数量・原料/完成品在庫・廃棄/格落ち・営業工数換算能力/使用量/
制約による削減量・成約/履行/未履行/延滞数量・顧客信頼/品質/納期信頼性・
`paymentDefault`/`underwritingFrozen`（新規発生フラグ含む）・reason code・
警告件数、を保持します。

`salesEffortCapacityHosoEqTons`/`salesEffortUsedHosoEqTons`（セクションE）は、
**当四半期に実際に使われた市場別営業人員配分**から`sales/marketEffort.ts`の
`processingCapacity`・`salesEffortWeightedQuantity`を再利用して積み上げた値です
（単位は「営業工数換算トン」＝ HOSO数量+1.2×PD数量+3.0×VAP数量。物理数量の
単純合計ではありません）。実装の過程で、会社全体のsalesForceHeadcountTotalに
対して1回だけ`processingCapacity()`を呼ぶ素朴な実装では、市場ごとに独立して
積み上がる基礎能力フロア（`processingCapacity(0)=200t`）を考慮できず、
「使用量が能力を大きく超える」という不自然な値になることを実行時の検証で発見し、
市場別配分から正しく再計算する方式へ修正済みです（§8「発見した設計課題」参照）。

## 4. reason code設計（既存コードの再利用）

新しいreason codeは作っていません。既存の2つのregistryをそのまま`code`として使います。

### 4.1 `StandardAiReasonCode`（AI側、`standardAi/reasonCodes.ts`、20種）

`CONTRACT_FULFILLMENT_PRIORITY` / `FINISHED_GOODS_EXCESS` / `CAPACITY_CONSTRAINT` /
`RAW_MATERIAL_SHORTAGE` / `PROCUREMENT_INCREASED_FOR_SHORTAGE` /
`PROCUREMENT_REDUCED_FOR_EXCESS` / `PROCUREMENT_CASH_CONSTRAINED` /
`PRICE_REDUCTION_FOR_EXCESS_STOCK` / `SALES_REDUCED_FOR_SUPPLY_LIMIT` /
`LOW_ORDER_BOOK_PREMIUM_FLOOR` / `SALES_HEADCOUNT_INSUFFICIENT_TOTAL` /
`VAP_MIX_INCREASES_SALES_EFFORT_NEED` / `WORKER_CAPACITY_SHORTAGE` /
`OVERTIME_TEMP_FOR_TRANSIENT_SHORTAGE` / `HIRING_FOR_SUSTAINED_SHORTAGE` /
`HEADCOUNT_REDUCED_FOR_SUSTAINED_EXCESS` / `CASH_BUFFER_SHORTAGE` /
`DEBT_REPAYMENT_SURPLUS` / `CAPEX_DEFERRED` / `CAPEX_PROPOSED`

### 4.2 `CompanyReasonCode`（エンジン側、`companyLab/types.ts`、14種）

`LOW_PRICE_WON_SHARE` / `SALES_FORCE_SHORTAGE` / `DOMESTIC_COMPETITION_INTENSE` /
`RAW_MATERIAL_SHORTAGE` / `IMPORT_IN_TRANSIT` / `EQUIPMENT_CAPACITY_SHORTAGE` /
`LABOR_SHORTAGE` / `OVERTIME_CAP_REACHED` / `VAP_SUPPLY_INCREASE_LOWERS_PREMIUM` /
`PD_SUPPLY_INCREASE_LOWERS_PREMIUM` / `OVER_CONTRACTED_OVERDUE` /
`DISEASE_HARVEST_LOSS` / `AQUACULTURE_HARVEST_ON_TRACK` /
`SALES_PLAN_REDUCED_FOR_EFFORT_CAPACITY`

### 4.3 `AdjustmentCategory`（集計用の分類ラベル、10種。reason codeの代替ではない）

`sales_effort_capacity` / `production_capacity` / `raw_material` / `labor` /
`inventory` / `cash_constraint` / `borrowing_capacity` / `underwriting` /
`market_demand_or_contract` / `rounding_or_unit_conversion` / `other`

対応表は`autoplay/reasonTaxonomy.ts`の`STANDARD_AI_REASON_CATEGORY`・
`COMPANY_REASON_CATEGORY`に集約しています。今回実行した60ケースの範囲では、
`rounding_or_unit_conversion`に該当する既存コードは見つからなかったため
（丸め処理自体は`roundHosoEqTons`等で行われるが、専用のreason codeは今のところ
存在しない）、このカテゴリは現時点で空です。将来、丸め由来の既存コードが
追加された場合にそのまま分類できるよう、カテゴリ自体は残しています。

## 5. 実行設定・再現性（`AutoplayRunManifest`）

`schemaVersion`・`runId`・`scenarioId`・`standardBaselineId`・`seeds`・`quarters`・
`companyIds`・`aiPolicyVersion`（固定文字列`"STANDARD_AI_PARAMETERS_V1"`）・
`salesForceHeadcountTotal`（実際に実行された1ケース目から観測した値。override
指定の有無に関わらず、実際に使われた値を正とする）・`keyParameters`・
`outputFormats`を保持します。`executedAtIso`（実行日時）・`appCommitId`（実行時の
git commit ID）だけは再現性の対象外の参考情報であり、`scripts/sai3aAutoplay.ts`が
`Date`・`git rev-parse HEAD`から値を作って渡します（`runAutoplayCli`自体・
`autoplay/`配下の全モジュールは`Date`・`Math.random`・`fs`・`process`のいずれにも
触れない純粋関数のみで構成しており、同一引数なら常に同一の戻り値を返します）。

`schemaVersion`は現在`"1.0.0"`固定です。将来項目を追加する場合は、既存フィールドの
意味を変えずにoptionalフィールドとして追加し、既存フィールドの削除・意味変更・
型変更があった場合のみ上げる方針です（`schema.ts`冒頭コメント参照）。

## 6. 出力ファイル

巨大な一つのJSONにはせず、用途別に7ファイルへ分割しています
（`artifacts/sai3a/<run-id>/`以下、`scripts/sai3aAutoplay.ts`が書き出す）。

| ファイル | 形式 | 内容 |
|---|---|---|
| `manifest.json` | JSON | 実行条件（§5） |
| `case-summary.csv` | CSV | 1社×1seedぶんの最終集計（5社×12seedなら60行） |
| `quarter-summary.csv` | CSV | 会社×seed×turnぶんの開始状態＋結果の主要スカラー値（品質/顧客信頼等のネスト値は列展開せず、decision-trace.jsonl側を参照） |
| `decision-trace.jsonl` | JSONL（1行1JSON） | 会社×seed×turnぶんの「開始状態→希望→最終決定→市場別販売数量トレース」の完全な記録（SAI-3Bの主要な入力） |
| `adjustment-trace.csv` | CSV | 希望→最終決定までの全調整エントリ（before/after/delta/reason code） |
| `warnings.csv` | CSV | 四半期結果に記録されたreason codeの一覧（`companyLab`側・警告集計向け） |
| `run-summary.json` | JSON | run全体の集計（完了/エラーケース数・paymentDefault率・underwritingFrozen率・平均財務指標・頻出reason code）＋失敗ケースの診断情報（`CaseError`） |

大量の実行生成物（`artifacts/sai3a/<run-id>/`）はgit管理対象外です
（`.gitignore`に`/artifacts/sai3a/`を追加済み）。サンプルとして1社×2四半期分だけ、
`docs/v2/reports/sai3a_sample_fixture/`にコミットしています（§10参照）。

## 7. CLI 実行方法

```bash
# 標準構成: 5社×12seed×8Q（headcountは標準候補の既定値=80のまま）
npx tsx scripts/sai3aAutoplay.ts --seed-count 12 --quarters 8 --run-id standard-h80-12seed-8q

# npmスクリプト経由でも同じ
npm run sai3a:autoplay -- --seed-count 12 --quarters 8 --run-id standard-h80-12seed-8q

# 営業人員を85人へ上書きして比較（§9の85人異常値の再診断で使用）
npx tsx scripts/sai3aAutoplay.ts --seed-count 12 --quarters 8 --headcount 85 --run-id headcount-85-12seed-8q

# 明示的なseed一覧・特定会社のみ・32Q
npx tsx scripts/sai3aAutoplay.ts --seeds sai3a-a,sai3a-b --quarters 32 --companies BAL,MASS --run-id custom-run

# 使用方法一覧
npx tsx scripts/sai3aAutoplay.ts --help
```

主な引数: `--scenario`（既定"baseline"）・`--baseline-id`（既定は選定済み標準候補
"moderate-pressure"）・`--seeds`/`--seed-count`+`--seed-prefix`（seed数は
ハードコードしない、実行時指定）・`--quarters`（既定8。32も指定可）・
`--companies`（既定5社すべて）・`--headcount`（省略時は候補既定値=80のまま）・
`--out-dir`（既定"artifacts/sai3a"）・`--run-id`。

## 8. 発見した設計課題（修正済み・修正せず報告のみ、の別）

### 8.1 修正済み（本フェーズの新規コードのみが対象。ゲームエンジン本体は無変更）

営業工数換算能力・使用量（セクションE）を、会社全体のsalesForceHeadcountTotalに
対して1回だけ`processingCapacity()`を呼ぶ素朴な実装にしたところ、
「使用量が能力の2〜3倍になる」という値が実行結果に現れました。原因を調査した結果、
`processingCapacity(headcount=0)=200t`という既存仕様（市場ごとに独立した基礎能力
フロア）により、5市場へ分割配分した場合の実際の合計能力は、会社全体人員に対して
1回だけ計算した値より大きくなることが判明しました。これは**ゲームエンジン側の
バグではなく、本フェーズで新設した集計ロジック側の実装ミス**だったため、実際に
使われた市場別配分（`decision.salesPlans`）から`processingCapacity`・
`salesEffortWeightedQuantity`を市場ごとに正しく積み上げる方式へ修正しました
（§3.5）。修正後、標準12seed実行での平均使用率はちょうど100%になり（AIが
自己制約により常に能力上限ぴったりまで販売計画を組んでいることと整合）、
不自然な値は解消しています。

### 8.2 候補として報告のみ（ゲーム設計判断を伴うため、今回は変更しない）

1. **標準AIの自己制約により、エンジン側の営業工数制約（`salesEffortAdjustments`）が
   ほとんど発火しない**: 標準AIは`buildStandardAiSalesPlans`内部で、営業工数制約を
   織り込んだ数量を最初から提出するため、5社同時実行では
   `record.salesRecord.salesEffortAdjustments`（エンジン側の実測調整）自体が
   空になることが多いシードが存在します（今回の標準12seed実行では
   `SALES_PLAN_REDUCED_FOR_EFFORT_CAPACITY`は110件のみ発火、対して標準AI自身の
   `SALES_REDUCED_FOR_SUPPLY_LIMIT`は2,400件）。ログ基盤としては両方を正しく
   区別して記録済みですが、「エンジン側の制約がほぼ発火しない」こと自体が
   設計として意図どおりかどうかは、ゲームバランス上の判断であり本フェーズでは
   評価していません。
2. **営業人員headcountを80→85→90と変化させると、生産商品ミックス
   （HOSO/PD/VAP desired quantity）が単調ではなく大きく不連続に変化する**
   （§9.3参照）。これがAIの生産優先度ロジック内の閾値分岐によるものか、
   市場別価格プレミアム閾値との相互作用によるものかは未特定であり、
   標準AIの大幅改造を伴う調査になるため、今回は候補として報告するに留めます。

## 9. 標準実行結果（5社×12seed×8Q、営業人員80人）

実行コマンド: `npx tsx scripts/sai3aAutoplay.ts --seed-count 12 --quarters 8 --run-id standard-h80-12seed-8q`
（`run-summary.json`・`case-summary.csv`等は`artifacts/sai3a/standard-h80-12seed-8q/`に生成。git管理対象外）

### 9.1 集計サマリー

- 完了ケース: 60/60（エラー0件）
- `paymentDefault`発生率（8Q中に一度でも発生）: **48.3%**（29/60）
- `underwritingFrozen`到達率: **0%**（0/60。今回の12seed×8Qでは一度も到達していない）
- 平均累計売上高: 約3.67億USD
- 平均累計粗利: 約2,672万USD
- 平均累計営業利益: 約720万USD
- 平均最終現金: 約540万USD
- 頻出reason code（adjustment-trace全体）: `SALES_REDUCED_FOR_SUPPLY_LIMIT`(2,400件) >
  `RAW_MATERIAL_SHORTAGE`(1,841件) > `CONTRACT_FULFILLMENT_PRIORITY`(809件) >
  `PROCUREMENT_CASH_CONSTRAINED`(615件) > `LABOR_SHORTAGE`(548件)

### 9.2 5社間の差異（同一初期条件からの出発点であるにもかかわらず生じる差の説明）

| 会社 | 平均累計売上高 | 平均累計営業利益 | 平均最終現金 | `paymentDefault`発生率 |
|---|---|---|---|---|
| BAL | 3.663億 | 673万 | 425万 | 66.7% |
| MASS | 3.686億 | 793万 | 605万 | 41.7% |
| JPQ | 3.674億 | 769万 | 639万 | 41.7% |
| VAP | 3.652億 | 653万 | 367万 | 50.0% |
| CONSV | 3.665億 | 712万 | 665万 | 41.7% |

5社は初期のfixture・財務・契約はすべて完全同一（SAI-2で確立済みの前提）ですが、
**companyId自体が原料ロット・生産バッチ・契約・市場競争ロジックのキーとして使われる**
ため、市場内の「他社との価格競争」「原料ロットの識別」「契約の割当順序」などが
companyId文字列やその生成順序に依存する箇所（例: 会社間のシェア争いにおける
tie-break、`ALL_COMPANY_IDS`の並び順に依存する処理）を通じて、同一seedでも
会社ごとに異なる結果になります。BALがやや高いdefault率・低い最終現金を示すのは、
`ALL_COMPANY_IDS = ["BAL", "MASS", "JPQ", "VAP", "CONSV"]`の並びで**先頭に
位置することが多い処理**（例: 限られた資源・市場シェアの割当における提示順）で
やや不利な扱いを受けている可能性がありますが、これは会社間の非対称性の一因の
候補であり、本フェーズで因果を確定させたわけではありません。

### 9.3 希望数量と最終計画数量のギャップ（営業工数制約の実質的な影響）

全会社×seed×turn×市場×商品ぶんの`salesQuantityTrace`（7,200件）を集計すると、
希望数量の合計は約910.9万トン、最終計画数量の合計は約456.4万トンで、
**ギャップは約49.9%**（希望の約半分が営業工数制約により最終計画へ届かない）でした。
営業工数換算での使用率は、実際の市場別配分に基づいて再計算した結果、**ちょうど
100%**（標準AIが常に能力上限ぴったりまで販売計画を組んでいることと整合）でした。

## 10. 標準AI・headcount 80/85/90比較による85人異常値の再診断

対象: develop/v2統合時に申し送った「営業人員85人だけが8Q `paymentDefault`率100%に
なる」という異常値（§7参照: SAI-2レポート§11.10.2）。**今回は`underwritingFrozen`が
原因と断定せず、85人だけを正常に見せるための個別補正も行っていません。**

実行コマンド（同一12seed・同一5社・8Q、headcountのみ変更）:
```bash
npx tsx scripts/sai3aAutoplay.ts --seed-count 12 --quarters 8 --headcount 80 --run-id headcount-80-12seed-8q
npx tsx scripts/sai3aAutoplay.ts --seed-count 12 --quarters 8 --headcount 85 --run-id headcount-85-12seed-8q
npx tsx scripts/sai3aAutoplay.ts --seed-count 12 --quarters 8 --headcount 90 --run-id headcount-90-12seed-8q
```

### 10.1 結果

| headcount | `paymentDefault`発生率 | `underwritingFrozen`到達率 |
|---|---|---|
| 80 | 48.3%（29/60） | 0% |
| **85** | **96.7%（58/60）** | 0% |
| 90 | 43.3%（26/60） | 0% |

**今回の12seedでは、旧SAI-2調査時の「ちょうど100%」は再現せず、96.7%（60件中2件は
発生せず）でした。** これは三宅さんの指示（「100%が再現しない場合は旧実行条件との差を
調べる」）に対応する重要な観測事実です。差分の候補として、(a) 今回のseed生成方式
（`sai3a-001`〜`sai3a-012`という文字列）が旧SAI-2調査時のseed文字列と異なる、
(b) 本フェーズで追加した`salesWishByMarketProduct`等の**非侵襲的な追加フィールド**は
既存の意思決定出力自体を変えていないことをテストで確認済み（§9のtsc/lintテストが
全て既存挙動を変えていないことを保証）である、という2点が挙げられます。したがって
「85人が突出して高い」という定性的な傾向自体は非常に強く再現しており（80%pt以上の
差）、100%ちょうどという数値は12seedのサンプルによる違いの範囲内と考えられます
（`underwritingFrozen`到達率はいずれも0%であり、明確に**`underwritingFrozen`が
原因ではない**ことが確認できました）。

### 10.2 defaultの直接的な引き金（同一seed・同一会社での80/85/90比較）

seed`sai3a-002`・会社`MASS`は、headcount 80/90では8Q中一度もdefaultしませんが、
headcount 85ではturn 6でdefaultします。turn 5→6の推移を比較すると:

| headcount | turn6期末現金 | turn6期末借入残高 | turn6期末追加借入余力 | turn6 `paymentDefault` |
|---|---|---|---|---|
| 80 | $0（下限） | $35,039,408 | $2,004,264 | false |
| 85 | **-$3,665,691（マイナス）** | $35,766,287 | $2,525,027 | **true** |

直接的な引き金は、headcount 85のケースだけturn 6の期末現金が実際にマイナスへ
落ち込んでいることです（80・90はいずれも$0が下限で踏みとどまる）。

### 10.3 生産商品ミックスの不連続な変化（候補メカニズム、未確定）

同じseed`sai3a-002`・会社`MASS`のturn 6の生産希望数量（`productionDesiredQuantityByProduct`）を比較すると:

| headcount | HOSO希望 | PD希望 | VAP希望 |
|---|---|---|---|
| 80 | 6,547 | 3,948 | 5,400 |
| 85 | 4,674 | **7,000（上限に見える丸い数値）** | 4,919 |
| 90 | 9,124 | 5,493 | 3,217 |

headcountが80→85→90と単調に増えているにもかかわらず、商品ミックスは単調ではなく
大きく不連続に切り替わっています（85人だけPD希望が7,000という区切りの良い値に
張り付き、HOSO希望が最も低くなる）。これは、営業人員配分の変化に応じて
市場別・商品別の優先度スコアがどこかの閾値をまたぐことで、生産計画のドミナントな
商品が離散的に切り替わっている可能性を示唆します。この商品ミックスの切り替わりが
turn 6のキャッシュフロー（原材料調達費・生産コストの配分）に影響し、85人のケースだけ
その四半期の現金収支をマイナス側へ押し出した、というのが最も有力な仮説ですが、
**標準AIの生産優先度ロジック（`decision/production.ts`等）の閾値分岐の詳細解析を
伴うため、本フェーズでは確定させず、候補メカニズムとして報告するに留めます。**
標準AIの大幅な改造・ゲームバランス評価は今回のスコープ外です。

### 10.4 まとめ

- `underwritingFrozen`が原因ではないことを、80/85/90いずれの実行でも到達率0%という
  形で確認した（断定の否定材料として明確）。
- 85人だけpaymentDefault率が突出して高い（96.7% vs 48.3%/43.3%）という**定性的な
  傾向は今回の新しい12seedデータでも強く再現**したが、旧調査時の「ちょうど100%」は
  再現しなかった（96.7%）。100%という数値そのものはseedサンプルに依存する可能性が
  高い。
- 直接的な引き金は、該当四半期の期末現金が実際にマイナスへ落ち込むことである
  （80・90は同じ四半期で$0に留まる）。
- その背景として、生産商品ミックスがheadcountに対して単調ではなく閾値的に
  切り替わる現象を確認したが、根本原因の確定には標準AIの生産・営業優先度ロジックの
  詳細解析が必要であり、候補メカニズムとして報告するに留める（今回は特定・修正しない）。

## 11. SAI-3Bへの引き継ぎ事項

- **入力データ**: `decision-trace.jsonl`が最も情報量の多い唯一の完全な記録です
  （state→wish→final→市場別販売数量トレースが1行1JSONで揃っています）。Excel化は
  この`decision-trace.jsonl`を主入力とし、`quarter-summary.csv`・
  `case-summary.csv`・`adjustment-trace.csv`・`warnings.csv`をシート別に取り込む
  想定で列構造を設計しています（配列・列構造は既にExcelへ変換しやすい形にフラット化
  済みです。§6参照）。
- **schema version**: `SAI3A_LOG_SCHEMA_VERSION`（現在`"1.0.0"`）を`manifest.json`から
  必ず読み取り、Excel変換ロジック側でバージョン不一致を検出できるようにしてください。
- **未実装のフィールド**: `AdjustmentTraceEntry`のうち、標準AI側診断エントリ由来の
  行は`before`/`after`/`delta`が`undefined`です（§3.3）。市場別の正確な数値が
  必要な場合は`salesQuantityTrace`（`decision-trace.jsonl`内）を参照してください。
- **既知の設計課題**（§8.2）: エンジン側営業工数制約がほぼ発火しないこと、
  headcount変化による生産ミックスの不連続な変化は、SAI-3B側で可視化する際に
  「異常値」ではなく「既知の未解決事項」として扱ってください。

## 12. テスト・検証結果

- SAI-3A関連の新規テスト: `autoplay/__tests__/`・`autoplay/cli/__tests__/`
  配下、計32件（`runCase.test.ts`・`buildLog.test.ts`・`runBatch.test.ts`・
  `output.test.ts`・`cli/__tests__/argParser.test.ts`・`cli/__tests__/runCli.test.ts`）、
  全件成功。三宅さんの指示§10の13項目すべてをカバー（同一seed再現性・異なるseedでの
  変化・ログ件数の正しさ・希望と最終決定の区別・調整ログの内部整合性・営業工数制約の
  トレース可能性・最終決定ログとrunner入力の一致・四半期結果ログと実結果の一致・
  default発生後もログが欠落しないこと・1件の失敗が残りを止めないこと・schema
  versionの保持・出力の再読み込み可能性・既存標準AI挙動の不変性）。
- 既存標準AI・companyLab・sales・financeテストを含む全体スイート:
  `npm test` **1,719/1,719件成功**（SAI-2マージ時点の1,687件＋今回追加の32件）。
- `npx tsc --noEmit`: エラー0件。
- `npm run lint`: エラー0件（既存の無関係な警告2件のみ、`redis/__tests__/`）。
- `npx next build`: 成功。

## 13. 変更・新規ファイル一覧

**既存ファイルへの追加のみの変更**（挙動は変えていない。上記全テスト・全既存テスト
成功で確認済み）:
- `app/lib/v2/companyLab/standardAi/decision/sales.ts`: `SalesWishEntry`型・
  `salesWishByMarketProduct`フィールドを追加
- `app/lib/v2/companyLab/standardAi/policy.ts`: `StandardAiQuarterDiagnostics`へ
  `salesWishByMarketProduct`フィールドを追加

**新規ファイル**:
- `app/lib/v2/companyLab/standardAi/autoplay/{schema,capture,runCase,reasonTaxonomy,buildLog,runBatch,output}.ts`
- `app/lib/v2/companyLab/standardAi/autoplay/cli/{types,argParser,runCli,index}.ts`
- `app/lib/v2/companyLab/standardAi/autoplay/__tests__/{runCase,buildLog,runBatch,output}.test.ts`
- `app/lib/v2/companyLab/standardAi/autoplay/cli/__tests__/{argParser,runCli}.test.ts`
- `scripts/sai3aAutoplay.ts`
- `docs/v2/reports/sai3a_autoplay_logging_report.md`（本ファイル）
- `docs/v2/reports/sai3a_sample_fixture/`（1社×2四半期のサンプル出力、§14参照）

**その他**:
- `package.json`: `"sai3a:autoplay": "tsx scripts/sai3aAutoplay.ts"`を追加
- `.gitignore`: `/artifacts/sai3a/`を追加

## 14. サンプル出力（1社×2四半期の追跡例）

`docs/v2/reports/sai3a_sample_fixture/`に、`--seed-count 1 --seed-prefix sai3a-sample
--quarters 2 --companies BAL`で生成した実際の出力一式（7ファイル）をコミットしています。
再生成コマンド:

```bash
npx tsx scripts/sai3aAutoplay.ts --seed-count 1 --seed-prefix sai3a-sample --quarters 2 --companies BAL --run-id sample --out-dir /tmp/sai3a_sample
```

`decision-trace.jsonl`のturn 1（BAL、市場CN・商品hoso）を例に、state→wish→final→
実測のつながりを示します:

1. **state（開始時）**: `salesForceHeadcountTotal=80`、`rawMaterialInventoryHosoEqTons=3200`、`cashUsd=20,000,000`
2. **wish（希望、営業工数制約前）**: 市場CN・商品hosoの`desiredQuantityBeforeEffortConstraint=4,400`トン（`salesQuantityTrace`より）
3. **調整（C節、営業工数制約）**: 市場CNの営業人員40人による処理能力不足により、市場全体（hoso/pd/vap合算の営業工数換算）が縮小（`adjustment-trace.csv`の`SALES_HEADCOUNT_INSUFFICIENT_TOTAL`/`SALES_REDUCED_FOR_SUPPLY_LIMIT`）
4. **final（最終計画）**: 同市場・同商品の`finalPlannedQuantity=1,248.31`トン（希望の28.4%相当）
5. **result（四半期結果、セクションE）**: `quarter-summary.csv`のturn1行に、実際の売上高・粗利・期末現金・在庫等が記録されている

この1行（company×turn）だけで、「四半期開始時にAIが何を知っていたか」→「制約前に
何を望んだか」→「どの制約でどれだけ削られたか」→「最終的に何を実行したか」→
「その結果どうなったか」までを単一のJSON行として追跡できます。
