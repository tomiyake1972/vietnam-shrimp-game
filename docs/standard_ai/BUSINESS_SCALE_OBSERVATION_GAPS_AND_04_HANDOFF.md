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

## 2. RawMaterial軸のsupportedScaleTonsをnullとした理由（2026-08-04修正）

**修正前の設計の問題（三宅さんの指摘、2026-08-04）**: 当初、Business Scale ProfileのRawMaterial軸は`certainSecuredRawTons`（期首在庫＋当期確実な入荷）を直接`supportedScaleTons`として使っていた。5社×4Q回帰で確認したとおり、turn2（原料パイプラインがまだ立ち上がっていない期）でほぼ全社0tになり、turn3〜4でも数千t程度の低い値に留まる。これを「Raw軸がbinding」と読むと、ShrimpXのように毎期市場から原料を買って加工する会社（原料在庫を大量に持つ会社ではない）では、正常な状態でもRaw軸が常に最も厳しい制約に見えてしまう。三宅さんの指摘どおり、これは「保守的な推計」ではなく「分からない」を「0tしかできない」という数値で表現してしまう設計上の誤りだった。

**修正内容**: RawMaterial軸を`securedRawScaleTons`（今すぐ確実に使える下限）／`procurementNeededScaleTons`（他4軸の最小値まで届くために必要な追加調達量）／`publicMarketAvailabilityState`（市場全体の余剰・タイト判定）／`companyPurchasableScaleTons`（会社固有の追加購入可能上限、常にunknown=null）へ分解した。`companyPurchasableScaleTons`が観測構造上恒常的にunknownである以上、RawMaterial軸の`supportedScaleTons`自体をnull（confidence=UNKNOWN）とし、Business Scaleのbinding判定（他4軸のmin()比較）から自動的に除外するようにした。

この結果、RawMaterial軸は「原料が事業規模の上限を決めている」という誤った印象を与えなくなった。ただし根本原因（会社固有の調達可能上限がゲームルールとして未定義）は解消していない。#04確認事項として、会社固有の調達可能上限をゲームルールとして定義するかどうかを判断いただきたい。定義されれば、`companyPurchasableScaleTons`に実際の値が入り、この軸も他4軸と同様にbinding判定に参加できるようになる。

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
