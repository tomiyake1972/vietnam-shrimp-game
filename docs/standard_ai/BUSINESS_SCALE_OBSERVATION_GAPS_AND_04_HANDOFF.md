# Business Scale Profile — Observation Gap一覧 ＆ #04 Handoff

2026-08-04 Cowork #05（AI設定）実施

## 1. Observation Gap 一覧（4分類）

| 項目 | 分類 | 詳細 |
|---|---|---|
| 市場別絶対需要（market absolute demand） | **engine側にもエンジン出力には存在しない（Phase F-4で(b)に確定分類）** | `market/globalDemand.ts`の`calculateWorldDemand`が`byMarket`を内部で計算しているが、`market/index.ts`の`calculateMarketQuarter`がこれを`MarketQuarterResult`へ含めていない。既存計算の転記のみで公開可能（低リスク）。 |
| 会社固有の国内原料購入可能上限 | **公開すべきか#04判断が必要** | 市場全体の余剰・タイト判定（`DOMESTIC_MARKET_PUBLIC_SURPLUS/TIGHT`）はあるが、会社固有の上限はゲームルールとして未定義（存在しないものを配線しようとしている可能性がある。#04でルール自体の要否を判断すべき）。 |
| 追加借入可能額（borrowing capacity） | **既にengineにあるがAIへ未配線** | `computeBorrowingCapacity`（既存関数）と`planQuarterFinancing`の入力（`prevFinanceState`等、いずれも前四半期末の確定値）から計算可能。Phase F-9で「配線のみで解決可能、新財務ルール不要」と分類済み。 |
| Future salesforce（次期の営業人員数） | **#05だけで安全に配線可能（未実施）** | `regularHeadcountAdjustmentDamping`と同種のロジックが営業人員側にも存在すると推定されるが、次期の予定採用人数を事前観測する仕組みは今回確認していない。 |
| Future labor（次期の正社員人数） | **#05だけで安全に配線可能（未実施）** | 同上。`decision/labor.ts`のロジックから、次期の目標headcountを事前計算する関数を切り出せば配線可能と推定される。 |
| Capex activation timing（設備投資の稼働開始時期） | **既にengineにあるがAIへ部分的に未配線** | `capex/parameters.ts`の`standardConstructionQuarters`+`postCompletionReadinessQuarters`は既存だが、「現在進行中のcapexプロジェクトが実際に何四半期後に稼働するか」という進行中プロジェクトごとの動的な残り期間は、`observation.activeCapexProjectTargets`（対象商品の集合のみ）からは直接読み取れない。 |

## 2. Raw-material-supported Scaleが常に低くなりがちな理由（今回判明した設計上の限界）

Business Scale ProfileのRawMaterial軸は、5社×4Q回帰で確認したとおり、turn2（原料パイプラインがまだ立ち上がっていない期）でほぼ全社0tになり、turn3〜4でも数千t程度の低い値に留まる。これは以下の複合的な理由による。

1. `certainSecuredRawTons`の定義（期首在庫＋当期確実な入荷）が意図的に保守的である（三宅さんの指示どおり、市場全体の余剰から会社固有の値を推計しない）。
2. このゲームの原料調達は「毎期新規に決める」運転資金型のフローであり、複数四半期分の原料を事前に確保しておくという設計になっていない（本モジュールの計算誤りではなく、ゲームのビジネスモデル自体の反映）。

この結果、RawMaterial軸は「典型的に持続可能な原料規模」ではなく「今すぐ確実に使える原料の下限」を表す値になっている。#04確認事項として、会社固有の調達可能上限をゲームルールとして定義するかどうかを判断いただきたい（上記1の項目と同じ）。定義されれば、この軸の診断価値は大きく向上する。

## 3. #04 Handoff（変更せず引き渡し）

### Worker
VAP labor intensity。現行V2モデル（`regularEfficiencyPerHeadTons=6`、商品を問わず同一）の下では、VAPの必要人数が三宅さんの理解（≈0.702人/t）の約1/3（≈0.234人/t）になっている（`WORKER_MODEL_COMPARISON_FOR_04.md`で既報）。Business Scale ProfileのLabor軸は、この現行ルールをそのまま「ゲームルール上の値」として使用しており、現実性の疑問とは別に扱っている。

### Market
市場別絶対需要をどこまで会社/AIへ公開するか。エンジンは内部で既に計算している（`calculateWorldDemand`の`byMarket`）ため、公開自体は低リスクだが、公開範囲（会社全体か、会社×市場別か）はゲームデザイン判断が必要。

### Raw
会社固有国内調達上限がゲームルールとして必要か。上記§1・§2で詳述。

### Finance
Phase F-9で検証中の`computeBorrowingCapacity`を`StandardAiObservation`へ渡せる正式な公開値にするかどうか。必要な入力（信用区分・EBITDA相当・担保USD評価・重大延滞/債務超過フラグ）はいずれも前四半期末の確定値であり、当期意思決定に依存しないため、配線自体は技術的に安全と判断している。

### Capex
HOSO専用ラインを含め、どの設備投資テンプレートが存在し、どの工程を増強できるか。`TEST14_TURN2_CAPEX_AND_BOTTLENECK_ANALYSIS.md`で指摘したとおり、人間案の生産候補ではHOSO専用ラインが既に不足気味だが、検討中のcapex案（共通前処理・凍結包装）はこれを直接解消しない可能性がある。`capex/parameters.ts`の全テンプレート一覧の網羅確認が必要。
