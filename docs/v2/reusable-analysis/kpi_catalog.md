# KPIカタログ（SAI-3B-2時点）

このドキュメントは、SAI-3B-1/SAI-3B-2のExcel経営分析ブックで実際に描画している
KPI（経営指標）を一覧化したものである。将来、別のシミュレーション/ゲームへ
本ブック生成の仕組みを転用する際、「どのKPIが一般的な会社経営分析として
汎用化できるか」「どのKPIがShrimpX固有の概念に依存しているか」を切り分ける
ための土台として作成する（三宅さんの指示§9・§10）。

**注意**: これはSAI-3B-2完了時点のスナップショットであり、まだ正式な
skill（再利用可能な定義済み手順）としては確定していない（§10「スキルとして
まだ確定させない」の指示どおり）。skill化する場合の草案は
`skill_candidate_spec.md` を参照。

## 1. 分類の考え方

| 分類 | 意味 |
| --- | --- |
| 汎用（domain-agnostic） | 「会社×四半期」の財務・業績指標であり、商品/市場の具体的な種類に関係なく、他の経営シミュレーションにも転用できる。 |
| ShrimpX固有 | エビ養殖・加工・輸出という業界固有の商品区分（hoso/pd/vap）・市場区分（CN/US/EU/JP/OTHER）・工数換算係数などに依存する。 |

## 2. 汎用KPI（会社×四半期の財務・業績）

`CompanyQuarterKpiSpec`（`workbook/dashboardCharts.ts`）で定義されているKPIは、
「どのフィールドを・どの単位で・どの中央値/平均で・どのグラフ種別で表示するか」
という構造そのものが汎用的である。ShrimpX固有なのは`extract`関数が参照する
フィールド名だけであり、レジストリの型自体（`title`/`format`/`chartType`/
`note`/`extract`）は他ドメインへそのまま転用できる。

| KPI ID | 名称 | 単位 | 集計方法 | ソース | 備考 |
| --- | --- | --- | --- | --- | --- |
| A | 会社別売上高推移 | USD | seed横断中央値 | quarter-summary.csv `netRevenueUsd` | 汎用 |
| B | 会社別販売数量推移（実績） | HOSO換算トン | seed横断中央値 | market-allocation-trace.csv `allocatedQuantityHosoEqTons`合算 | ShrimpX固有の単位換算（HOSO換算）を除けば汎用パターン |
| D-1 | 会社別売上総利益推移 | USD | seed横断中央値 | quarter-summary.csv `grossProfitUsd` | 汎用 |
| D-2 | 会社別粗利益率推移 | % | seed横断中央値 | grossProfitUsd÷netRevenueUsd | 汎用（比率KPIは金額KPIと必ず別グラフにする、§7参照） |
| D-3 | 会社別営業利益推移 | USD | seed横断中央値 | quarter-summary.csv `operatingProfitUsd` | 汎用 |
| D-4 | 会社別純利益推移 | USD | seed横断中央値 | quarter-summary.csv `netIncomeUsd` | 汎用 |
| E | 会社別期末現金残高推移 | USD | seed横断中央値 | quarter-summary.csv `closingCashUsd` | 汎用。マイナス値も実額表示 |
| F-1/F-2/F-3 | 営業/投資/財務キャッシュフロー推移 | USD | seed横断中央値 | quarter-summary.csv 追加列（SAI-3B-2で追加） | 汎用（3区分CFは会計の標準概念） |
| G-1/G-2 | 短期/長期借入推移 | USD | seed横断中央値 | quarter-summary.csv | 汎用 |
| G-3 | 追加融資余力推移 | USD | seed横断中央値 | quarter-summary.csv `endingAvailableAdditionalCapacityUsd` | 汎用だが「追加融資余力」という与信モデル自体はShrimpXのunderwriting設計に依存 |
| H-1/H-2 | 原料/製品在庫推移 | 物理数量 | seed横断中央値 | quarter-summary.csv | 汎用パターンだがHOSO換算トンという単位はShrimpX固有 |
| H-3/H-4 | 売掛金/買掛金推移（期首） | USD | seed横断中央値 | quarter-summary.csv | 汎用。ただし「期首のみ取得可・期末残高は取得不能」という制約はSAI-3Aログ設計に依存 |
| H-5 | 運転資金の部分指標 | USD | seed横断中央値 | AR-AP（期首） | 汎用の会計指標だが、在庫評価額が無いための「部分指標」である旨の注記が必須 |

## 3. ShrimpX固有KPI

| KPI ID | 名称 | 単位 | ソース | 固有性の理由 |
| --- | --- | --- | --- | --- |
| C | 市場別シェア推移（quantityShare） | 比率（会社別配分数量÷市場内合計配分数量） | market-allocation-trace.csv | 「市場」（CN/US/EU/JP/OTHER）という固定enumと、「配分数量」という市場清算モデル自体がShrimpX固有。汎用化する場合は「エンティティ×グループでの構成比シェア」という一般パターンへ抽象化できる。 |
| 80/85/90人比較・乖離検出 | 営業人数別の乖離開始点 | turn（四半期番号） | headcountComparison由来 | 「営業人数（salesForceHeadcount）」というパラメータ自体はShrimpX固有だが、「同一パラメータの複数値を横断比較し、KPIが乖離し始める最初の時点を検出する」というロジック（`buildHeadcountDivergence`, `DIVERGENCE_KPI_CANDIDATES`, `DIVERGENCE_THRESHOLD=0.05`）は、他の「Aシナリオ vs Bシナリオ」比較にも転用できる汎用パターンである。 |

## 4. 「作成不能」として明示的に扱っているKPI（捏造しない）

以下は三宅さんの指示（欠損データの捏造禁止）に従い、実装していない、または
条件付きでのみ実装している：

- 市場別の実現収益（revenueShare）: askPrice（自社提示価格）からの逆算は
  実際の市場清算価格ではないため捏造になる。意図的に未実装。
- 四半期末時点の売掛金・買掛金残高: SAI-3Aのいずれの出力にも無いため、
  期首値のみで代替し、その旨をnoteで明示。
- 生産の実績値（生産能力制約後）: AI提出計画のみ取得可能。実績ではない旨を明示。
- 完全な運転資金（売掛金＋在庫評価額−買掛金）: 在庫のUSD評価額が無いため、
  H-5は「部分指標（在庫除く）」として明示的に区別して提供。

## 5. 未実装のP1候補（次ラウンドへ持ち越し）

三宅さんの指示§4「P1 KPIは可能な範囲で」に対応する、次ラウンド候補：

- 生産・調達推移ダッシュボードシート（原料調達wish/final、生産計画の商品別
  内訳の時系列可視化。データ自体はprocurementProduction/salesAnalysisシートに
  既に存在するが、専用ダッシュボードシートとしては未作成）。
- 品質・信用推移ダッシュボードシート（quality score・customer trust・
  delivery reliability・信用区分(creditTier)の会社別時系列。SAI-3B-2で
  quarter-summary.csvへ商品別/市場別の値を追加済みだが、ダッシュボード
  シート化は本ラウンドのスコープ外とした）。

これらはSAI-3B-2完了後、三宅さんのレビュー結果を踏まえて次ラウンドで
着手するかどうかを判断する（本ラウンドでは「作成不能」ではなく「未着手・
次ラウンド候補」として区別する）。
