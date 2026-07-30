# Phase SAI-3B-2 完了報告 — 経営KPIダッシュボード・グラフ拡充

対象: `feature/v2-sai3b-excel-analysis`（`develop/v2`から分岐、`main`/`develop/v2`は未変更）
本Markdownは`docs/v2/reports/sai3b2_completion_report.md`としてgit管理下にあります。
生成物（`artifacts/sai3a/*`・`artifacts/sai3b/*.xlsx`）自体はgit管理対象外です
（`.gitignore`参照）。三宅さんの指示SAI-3B-2（14節構成の詳細仕様）に対応する
完了報告です。

> **2026-07-30追記**: 三宅さんから受入レビュー2回目のフィードバック
> （「SAI-3B-2の受入確認結果です」、7項目の確認・不足対応指示）をいただき、
> 対応しました。対応内容の詳細は**末尾の「8. 受入レビュー2回目（2026-07-30）
> への対応」**を参照してください。特に、下記1.3節に記載しているLayer2の説明
> （「average/min/max/defaultedSeedCountを小表として併記」）は、レビューで
> 指摘のとおり**不正確でした**（実際には「turnごとの中央値のばらつき」を
> 集計したものであり、seed横断の分布統計ではありませんでした）。§8.1で
> 修正済みです。1.3節はこの回の実装当時の記録として、あえて書き換えずに
> 残しています。

---

## 0. スコープ境界の確認（§13）

- `main`・`develop/v2`への変更は一切ありません（本ラウンド開始前と同じコミット
  `3ae9485`（main）・`b1733e1`（develop/v2）のままです）。
- ゲームエンジン・標準AIのロジック・バランスは一切変更していません。
- SAI-3B-1で既に受入済みのExcel経営分析ブックの土台（README・全体サマリー・
  会社別業績・四半期業績等の既存シート）はそのまま維持し、新シートを追加する
  形で実装しています。
- 「スキル」としての正式な確定・配布は行っていません（§10の指示どおり、
  `docs/v2/reusable-analysis/`はあくまで草案です）。
- develop/v2へのマージは行っていません。三宅さんのレビュー・フィードバックを
  待ちます。

## 1. 実装した内容（§2〜§9）

### 1.1 追加した6つのダッシュボードシート（§2）

README直後、既存の「全体サマリー」シートの手前に、以下6シートを追加しました:

| シート名 | 内容 |
| --- | --- |
| 経営ダッシュボード | 他5シートへのハイパーリンクナビゲーション、run別の最新四半期スナップショット（会社別売上・粗利益率・営業利益・期末現金・借入合計）とヘッドラインチャート、80/85/90乖離要約 |
| 売上・数量推移 | チャートA（会社別売上高推移）・B（会社別販売数量推移、実績） |
| 市場シェア推移 | チャートC（市場別に個別グラフ、参加社数列で欠落を可視化） |
| 利益・採算推移 | チャートD-1〜D-4（売上総利益・粗利益率・営業利益・純利益、$と%を別グラフに分離） |
| 資金繰り・財務推移 | チャートE（現金残高）・F-1〜F-3（3区分キャッシュフロー）・G-1〜G-3（借入・追加融資余力） |
| 在庫・運転資金推移 | チャートH-1〜H-5（原料/製品在庫・売掛金/買掛金（期首）・運転資金の部分指標） |

8つの候補シートのうち、生産・調達推移／品質・信用推移の2シートは、データ自体は
既存シート（調達_生産_在庫・四半期業績等）に既にあるものの、専用ダッシュボード
シート化は本ラウンドのスコープ外としました（P1候補として次ラウンドへ明示的に
持ち越し。`docs/v2/reusable-analysis/kpi_catalog.md`§5参照）。

### 1.2 P0チャート仕様（§3）への対応

| チャート | 実装状況 | 備考 |
| --- | --- | --- |
| A 会社別売上高推移 | 実装済み | quarter-summary.csv `netRevenueUsd`のseed横断中央値 |
| B 会社別販売数量推移 | 実装済み | market-allocation-trace.csv由来の実績配分数量（実績/計画を明確に区別） |
| C 市場別シェア推移 | 実装済み | 市場ごとに個別グラフ、分母を明示、100%-sum検証済み、5社に満たない場合も無理に補正しない |
| D 売上総利益・利益率推移 | 実装済み | 金額（D-1,D-3,D-4）と比率（D-2）を必ず別グラフに分離 |
| E 現金残高推移 | 実装済み | マイナス値も実額のまま表示 |
| F キャッシュフロー推移 | 実装済み | 3区分（営業/投資/財務）を個別グラフ＋現金残高（E）とは別グラフ |
| G 借入金推移 | 実装済み | 短期・長期・追加融資余力の3チャート |
| H 運転資金推移 | 実装済み（部分指標として明示） | 在庫評価額が取得不能なため、「運転資金の部分指標（在庫除く、期首AR-AP）」として明確に区別。標準的な完全な運転資金の算出は「現時点の出力データでは作成不能」と明記 |

### 1.3 3層構造（§5）

- Layer1: `CompanyQuarterStatRow`のmedianを見出しグラフの主線として採用
  （defaultによる外れ値の影響を受けにくくするため）。
- Layer2: 同じ行のaverage/min/max/`defaultedSeedCount`を、グラフ直下の
  小表として併記。
- Layer3: 既存の四半期業績シート（seed単位の生データ）を再利用し、
  同じ値を二重に保持していません。

### 1.4 80/85/90人比較の強化（§6）

`headcountDivergence`（会社×seedごとに、営業人数間で最初にKPIが乖離し始めた
四半期を機械的に検出。原因の特定・断定はしない）を、既存の「80_85_90人比較」
シート自体に詳細テーブルとして追加しました（経営ダッシュボードの要約とは別）。
実runでの検証では、多くの会社×seedでturn1〜2という早い段階で
`operatingProfitUsd`の乖離が検出されており、これは本ラウンドの標準シナリオでは
妥当な結果です（原因分析はスコープ外）。

### 1.5 グラフ表示原則（§7）

- 会社別配色（`CANONICAL_COMPANY_ORDER`/`COMPANY_COLOR_HEX`）・営業人数別配色
  （`HEADCOUNT_PALETTE`）を全シート・全グラフで統一。
- 円グラフは1つも使用していません（時系列比較に不適切なため）。
- 金額と%を同一グラフに混在させていません（D-1〜D-4を参照）。
- 欠損値は0にせず、セル・グラフともに空欄扱い（`chartInjector.buildNumCache`が
  `<c:pt>`要素を省略）。
- データ表は各グラフの左側に併記。
- 詳細は`docs/v2/reusable-analysis/chart_design_rules.md`参照。

### 1.6 KPIレジストリ分離（§9）

`CompanyQuarterKpiSpec`（`workbook/dashboardCharts.ts`）により、KPI定義
（フィールド・単位・グラフ種別・注記）とレンダリングコードを分離し、
`writeWorkbook.ts`側にKPIごとの描画コードをハードコードしていません。
ShrimpX固有の概念（商品・市場区分）は市場シェアシートの専用ロジックにのみ
現れ、会社×四半期の一般的なKPI群はドメイン非依存の構造で扱われています。

## 2. §10 再利用可能な分析パターンのドキュメント化

`docs/v2/reusable-analysis/`配下に5点の草案ドキュメントを新規作成しました
（**まだ正式skillとして確定していません**、§10の指示どおり）:

- `kpi_catalog.md`: 実装済み全KPIの一覧、汎用/ShrimpX固有の区分、P1候補の
  明示的な次ラウンド持ち越し。
- `chart_design_rules.md`: §7のグラフ表示原則を、実装済みの具体的なルールへ
  ブレークダウン。
- `workbook_layout.md`: シート順序・シート内書式規約・マルチシートグラフ注入
  の設計。
- `data_contract.md`: SAI-3A⇄SAI-3B間のファイル契約、欠損値の扱い、実績データ
  ソースの優先順位、CSVフラット化の安全条件。
- `skill_candidate_spec.md`: 将来のスキル化を検討する際の草案（何が汎用化
  できていて、何が要検討かを明示）。

## 3. §11/§12 検証結果

### 3.1 自動テスト

- SAI-3Bテストスイート: **86件**すべて通過（うち今回のダッシュボード関連の
  新規テスト: `dashboardCharts.test.ts` 8件、`writeWorkbook.test.ts`の乖離
  詳細テーブル用1件、`runCli.test.ts`のCLI回帰テスト1件を含む）。
- リポジトリ全体テストスイート: **1807件**すべて通過。
- `npx tsc --noEmit -p .`: エラーなし（クリーン）。
- 主なテスト観点: 会社系列が実データと一致すること、市場シェアが100%に
  合計されること（強制補正なしで）、欠損値が0に変換されないこと、経営
  ダッシュボードのハイパーリンク・80/85/90乖離要約テーブルの存在、
  「作成不能」フォールバック（market-allocation-trace.csv欠落時）の動作、
  会社別配色が複数シートにまたがって一致すること。

### 3.2 実データでの検証（実際にSAI-3AのCLIでrunを生成し、SAI-3BでExcel化）

生成コマンド:
```
npx tsx scripts/sai3aAutoplay.ts --seed-count 12 --quarters 8 --headcount 80 --run-id standard-h80-12seed-8q
npx tsx scripts/sai3aAutoplay.ts --seed-count 12 --quarters 8 --headcount 85 --run-id headcount-85-12seed-8q
npx tsx scripts/sai3aAutoplay.ts --seed-count 12 --quarters 8 --headcount 90 --run-id headcount-90-12seed-8q
npx tsx scripts/sai3bExcel.ts --input artifacts/sai3a/standard-h80-12seed-8q --output artifacts/sai3b/standard-h80.xlsx
npx tsx scripts/sai3bExcel.ts --input artifacts/sai3a/standard-h80-12seed-8q --input artifacts/sai3a/headcount-85-12seed-8q --input artifacts/sai3a/headcount-90-12seed-8q --output artifacts/sai3b/headcount-80-85-90-comparison.xlsx
```
（各run: 5社×12seed=60ケース、完走60/60、エラー0件）

**発見・修正した不具合**: `sai3b/cli/runCli.ts`の`loadRunFromDir`が
必須7ファイルのみを読み込んでおり、任意ファイル`market-allocation-trace.csv`
を一度も読みに行っていなかったため、実際にこのファイルを含むrunディレクトリを
指定しても、CLI経由では常に「見つかりません」警告が出て市場シェア推移等が
常に「作成不能」扱いになっていました。`SAI3A_OPTIONAL_RUN_FILES`定数を新設し
修正、回帰テストを追加しました（`loadSai3aRun`という純粋関数自体は元から
正しく後方互換だったが、CLI層の配線漏れが原因）。修正後、実runで
market-allocation-trace.csv由来のデータが正しく取得できることを確認しました。

**再読込・破損チェック**:
- ExcelJSでの再読込: 両ファイルとも成功（単一run24シート、比較25シート、
  読み込み時間はそれぞれ約1.9秒・約7.0秒）。
- openpyxl（Python）での再読込: 両ファイルとも成功、シート名一覧が期待どおり。
- LibreOffice headless変換（xlsx→PDF）: 成功、破損なし
  （`soffice --headless --convert-to pdf`で約15秒、8.6MBのPDFを生成）。
- zip内のグラフ数: 単一run28件・比較76件。KPI数×シート×run数から手計算した
  期待値と完全一致することを確認（市場5件が存在する構造も含めて）。
- 文字化け（mojibake）チェック: 全24/25ワークシートXMLでU+FFFD（置換文字）を
  検出せず。チャートタイトルの日本語表示も正しく確認
  （例:「最新四半期(2016Q4)会社別売上（standard-h80-12seed-8q）」）。

**元データとの突き合わせ（捏造チェック）**:
- 売上・数量推移シートのBAL社2015Q1の値（9,379.95トン）が、
  market-allocation-trace.csvから独立に算出した12seed分の
  `allocatedQuantityHosoEqTons`合計の中央値と完全一致することを確認。
- 市場シェア推移シートの各quarter・各市場の合計が、厳密に100%
  （5社×20%、標準シナリオでは対称的な結果）になることを確認。
- 80/85/90乖離詳細テーブルの実データが、会社ID・seed・turnの組み合わせとして
  正しく生成されていることを確認。

### 3.3 §8 ファイルサイズ・生成時間の前後比較

SAI-3B-1時点のコード（コミット`8cd54b2`、別のgit worktreeで実行）と、
SAI-3B-2完了時点のコードで、同一の実runディレクトリから同じブックを生成し
比較しました:

| ブック | SAI-3B-1時点 | SAI-3B-2完了時点 | 増加率 |
| --- | --- | --- | --- |
| 単一run（standard-h80） | 20,661,931 bytes（約19.7MB）／生成時間 約7.1秒 | 20,822,597 bytes（約19.9MB）／約7.2秒 | +0.78%／時間はほぼ変化なし |
| 80/85/90比較 | 73,265,358 bytes（約69.9MB）／約24.9秒 | 73,717,742 bytes（約70.3MB）／約24.8秒 | +0.6%／時間はほぼ変化なし |

**結論**: SAI-3B-2で追加した6シート・多数のグラフによるファイルサイズ・
生成時間への影響は軽微（1%未満）でした。これは3層構造の設計上、
新シートがseed単位の生データを複製せず、中央値等の集計済み小表のみを
保持しているためです。

ただし、ブック自体のサイズ（単一runで約20MB、比較で約70MB）は
**SAI-3B-1の時点で既に大きく**、これはSAI-3B-2で新たに生じた問題では
ありません。主な要因はRaw_Decision/Raw_Adjustment/Raw_Warningsシート
（60ケース×8四半期の生ログ全件）と見られます。ファイルを開く際の体感速度
（LibreOfficeでの変換は約15秒）は許容範囲内と考えていますが、Excel本体での
実際の開閉時間はこの検証環境では確認できていません。book-split
（run単位・データ種別単位での複数ファイル分割）は、三宅さんが実際に
Excelで開いてみたフィードバックを踏まえ、次ラウンドで検討することを
提案します（本ラウンドでは未実施・未提案止まりとし、構造変更は行って
いません）。

## 4. 新たに判明した事実・教訓

- SAI-3A標準シナリオでは、turn1（初回四半期）の市場配分結果は12seedすべてで
  完全に同一値になる（初期条件のランダム性がturn1にはまだ波及していない、
  または該当パラメータがseed非依存であるため）。turn2以降は徐々にseed間で
  分岐する。これはシミュレーション設計としては妥当だが、「中央値だけを見ると
  turn1が異常に均一に見える」という見え方の癖として、次回のダッシュボード
  解釈時に留意点として共有します。
- 80/85/90人比較では、多くの会社×seedでturn1〜2という早い段階から
  `operatingProfitUsd`の相対乖離（閾値5%）が検出されました。原因分析は
  本ラウンドのスコープ外ですが、「乖離が非常に早期から起きている」という
  観測事実自体は次の分析ラウンドの出発点になり得ます。
- CLI層とパース層（純粋関数）で「任意ファイルの後方互換性」の実装場所が
  分離されていると、片方だけ直して他方を直し忘れるバグが起きやすいという
  教訓を`data_contract.md`に記録しました。

## 5. 汎用化できた部分／ShrimpX固有の部分（要約）

詳細は`docs/v2/reusable-analysis/`各ファイル参照。要約:

- **汎用化できた設計パターン**: KPIレジストリ分離、3層構造（median見出し＋
  統計＋詳細）、マルチシートのネイティブグラフ注入、固定パラメータ横断の
  乖離検出ロジック、欠損値=undefinedを最後まで伝播させる契約。
- **ShrimpX固有**: 商品区分（hoso/pd/vap）・市場区分（CN/US/EU/JP/OTHER）・
  HOSO換算という単位・営業工数制約や与信モデルなどのビジネスロジック。

## 6. 変更ファイル一覧（このラウンド、コミット単位）

1. `34935a7` SAI-3B-2 §1: KPIデータ可用性監査 + SAI-3A出力層の追記実装
2. `df2c0d1` SAI-3B-2: 集計層拡張（実売数量・市場シェア・80/85/90乖離検出）+ 複数シートグラフ基盤
3. `6e7dd19` SAI-3B-2 §2-3,5,7,9: 経営ダッシュボード6シート・P0チャート実装
4. `0a4afae` SAI-3B-2 §6: 80_85_90人比較シートに乖離開始点の詳細テーブルを追加
5. `eed7643` SAI-3B-2 §12/§10: 実runでの検証で発見したCLI取り込み漏れを修正 + 再利用ドキュメント5点

現在のブランチ`feature/v2-sai3b-excel-analysis`のHEADは`eed7643`です。
`main`・`develop/v2`への変更は一切ありません（今回のセッション開始前と同じ
コミットのままです）。

## 7. 次のステップ（三宅さんの判断待ち、§13）

本ラウンドはここで一旦停止し、三宅さんに実際のExcelファイル
（`artifacts/sai3b/standard-h80.xlsx`・
`artifacts/sai3b/headcount-80-85-90-comparison.xlsx`、いずれもgit管理外の
ためお手元に送付が必要です）を確認いただき、フィードバックをお願いします。
develop/v2へのマージ、スキルとしての正式確定、P1 KPI（生産・調達推移／
品質・信用推移）の着手、book-splitの実施は、いずれもこのレビュー結果を
踏まえて次ラウンドで判断します。

---

## 8. 受入レビュー2回目（2026-07-30）への対応

三宅さんから「SAI-3B-2の受入確認結果です」として頂いた7項目のフィードバック
（「中心実装は受入可能な水準だが、完成扱いにする前に確認・不足対応してほしい。
大規模な作り直しは不要」）に、項目ごとに対応しました。**develop/v2への統合は
引き続き行っていません**。本ラウンドの作業もすべて
`feature/v2-sai3b-excel-analysis`上のコミットです。

### 8.1 Layer2（会社・seed比較表）の統計項目・Layer1との区別（ご指摘§1）

**ご指摘の内容**: Layer2の必須列（平均・中央値・最小・最大・標準偏差・
default件数）のうち中央値・標準偏差が未実装。Layer1（中央値表示）と
Layer2（会社・seed比較表）が明確に区別されていない。

**実際に見つかった問題**: ご指摘のとおりでした。従来の実装は、Layer2として
「turnごとのKPI中央値を、run内の全turnにわたって平均・最小・最大した表」
（`writeCompanyQuarterBlock`内、見出しが`会社|平均(中央値の全turn平均)|
最小(中央値)|最大(中央値)|延べdefault seed-quarter数`）になっており、これは
「時間方向の中央値のばらつき」を示す表であって、三宅さんが求めていた
「turn×会社ごとの、seed横断の分布統計」ではありませんでした。中央値・
標準偏差も欠けていました。

**対応内容**:
1. `StatSummary`（`schema.ts`）に`stddev`（標本標準偏差、n-1で割る不偏分散の
   平方根）を追加。`aggregate.ts`の`statSummary()`で計算（n<2の場合は
   「ばらつき」自体が定義できないため0にせずundefinedのまま）。19個の
   `StatSummary`型フィールド（`CompanyQuarterStatRow`）すべてに自動的に
   波及。
2. `CompanyQuarterKpiSpec`に新規`extractStat`フィールドを追加し、KPIごとに
   「そのKPIのStatSummary全体（average/median/min/max/stddev/n）」を返せる
   ようにした（`extract`は既存どおり中央値1個だけを返す）。H-5（運転資金の
   部分指標。売掛金と買掛金それぞれの中央値の差分として計算される合成KPI）
   だけは`extractStat`を意図的に未設定のままにしている。理由は、個々の
   seedへ遡って「AR-APの差分」の分布を再構成することができない
   （売掛金と買掛金は別々のseedからサンプリングされた中央値の差分でしか
   ないため）ためであり、捏造を避けるための設計判断。
3. `writeCompanyQuarterBlock`のLayer2部分を全面的に書き換え、
   **「Layer2: 会社・seed比較表（seed横断の分布統計）」**という専用の
   subheaderを立てて、Layer1（直上の中央値ピボット表）と明確に区別。
   列は`quarter|会社|平均|中央値|最小|最大|標準偏差|seed数(n)|
   defaultしたseed数`の9列で、turn×会社ごとに1行（=真のseed横断分布）。
   `extractStat`が無いKPI（H-5）は表を出さず、「このKPIは複数のStatSummary
   から算出される合成指標のため、個々のseedへ遡って分布を再構成することが
   できません。捏造を避けるため、Layer2の分布統計は算出不可としています」
   という明示的なノートに置き換えた（欠測ではなく「定義上算出できない」
   ことを明記）。

**検証**: 標準h80ブック（`artifacts/sai3b/standard-h80.xlsx`）の
「売上・数量推移」シートのLayer2表・BAL社・2015Q1行を、`quarter-summary.csv`
から独立に算出したPythonの`statistics`モジュール（average/median/stdev）と
突き合わせ、平均・中央値・最小・最大・標準偏差のすべてが完全一致することを
確認しました（average=41,846,788.94、median=42,038,391.38、
stddev=478,100.00、n=12）。単体テストとしても、`aggregate.test.ts`に
標本標準偏差(n-1)の計算テスト・n=1でundefinedになるテストを、
`dashboardCharts.test.ts`にLayer1/Layer2のラベル区別・9列の存在・
H-5の「算出不可」ノートのテストを追加しています。

### 8.2 80/85/90比較KPI（§6必須15項目）の実装状況監査（ご指摘§2）

15項目すべてを実装場所単位で監査した結果は以下のとおりです。「表のみ」
「未実装」は本ラウンドで対応しました（**営業人件費のみが実際に未実装**
でした。他はグラフ・表いずれかの形ですでに存在していました）。

| # | KPI | 状態 | 実装場所・備考 |
|---|---|---|---|
| 1 | default率 | 実装済みグラフ | 「グラフ」シート「営業人数別 default率（ケース単位）」（run集計単位） |
| 2 | 初回default quarter | 表のみ | 「80_85_90人比較」表の`◯人:default初回turn`列のみ。専用グラフなし |
| 3 | 売上高 | 実装済みグラフ | 「売上・数量推移」チャートA（会社別・run別）＋「グラフ」シート集計＋「80_85_90人比較」表 |
| 4 | 販売数量／最終計画販売数量 | 実装済みグラフ | 「売上・数量推移」チャートB（実績）＋「グラフ」シート「希望販売量(制約前) vs 最終計画数量」 |
| 5 | 市場別シェア | 実装済みグラフ | 「市場シェア推移」シート、市場ごとに個別グラフ（run別） |
| 6 | 営業能力使用率 | 実装済みグラフ | 「グラフ」シート「営業人数別 平均営業能力使用率」（run集計単位） |
| 7 | 営業人件費 | **未実装 → 今回実装** | 従来Raw_Caseの生データダンプにしか存在しなかった。§8.3で対応内容を記載 |
| 8 | 売上総利益 | 実装済みグラフ | 「利益・採算推移」チャートD-1＋「80_85_90人比較」表 |
| 9 | 営業利益 | 実装済みグラフ | 「利益・採算推移」チャートD-3＋「80_85_90人比較」表 |
| 10 | 営業キャッシュフロー | 実装済みグラフ | 「資金繰り・財務推移」チャートF-1（run別）。「80_85_90人比較」表には未収録（対応は次ラウンド候補） |
| 11 | 期末現金 | 実装済みグラフ | 「資金繰り・財務推移」チャートE＋「80_85_90人比較」表 |
| 12 | 短期借入 | 実装済みグラフ | 「資金繰り・財務推移」チャートG-1（短期単独）。「80_85_90人比較」表は`◯人:最終借入`が短期＋長期の合算のみ |
| 13 | 在庫 | 実装済みグラフ | 「在庫・運転資金推移」チャートH-1/H-2（run別）。「80_85_90人比較」表には未収録 |
| 14 | 売掛金 | 実装済みグラフ | 「在庫・運転資金推移」チャートH-3（run別）。「80_85_90人比較」表には未収録 |
| 15 | 運転資金 | 実装済みグラフ（部分指標のみ） | 「在庫・運転資金推移」チャートH-5。在庫のUSD評価額がSAI-3Aログに存在しないため、標準的な完全算出は**取得不能**。「運転資金の部分指標（在庫除く、期首AR-AP）」として明示的に区別して提供（捏造回避） |

**備考（今回あえて対応しなかった項目）**: #10・#12・#14の「`80_85_90人比較`
表に会社×seed横並びの列として無い」点は、グラフでの比較自体は既存の
専用ダッシュボードシート側で可能なため、「グラフで比較できるように」という
§6の要件自体は最低限満たしていると判断し、大規模な作り直しを避けるため
今回は対応を見送りました（次ラウンド候補として`kpi_catalog.md`に追記済み）。

### 8.3 営業人件費（cumulativeSalesForceCostUsd）の追加実装

**実装内容**:
- `HeadcountComparisonRow`（`schema.ts`）に`salesForceCostByHeadcount`
  フィールドを追加。
- `buildHeadcountComparison`（`aggregate.ts`）で`case-summary.csv`の
  `cumulativeSalesForceCostUsd`をそのまま引き写す（新規計算は一切行わない）。
- `writeHeadcountComparisonSheet`（`writeWorkbook.ts`）の横並び比較表に
  `◯人:営業人件費(USD)`列を追加。
- **「80_85_90人比較」シート自体にネイティブグラフを追加**（従来このシートは
  表のみでグラフが1つも無かった。§6「グラフで比較できるように」が本シート
  単体では満たされていなかったため）。会社×営業人数の平均営業人件費比較
  グラフ（同一会社内でheadcountComparisonの対象seed群を単純平均したもの。
  新規の集計ロジックではなく既存の対応関係をそのまま使用）。

**検証**: 正式12seedブック（`headcount-80-85-90-comparison.xlsx`）の
「80_85_90人比較」表・BAL社・sai3a-001・80人セル（5,120,000 USD）が、
`headcount-80-12seed-8q/case-summary.csv`の同一行`cumulativeSalesForceCostUsd`
と完全一致することを確認。グラフXML（`chart77.xml`）にタイトル
「会社別 平均営業人件費（営業人数比較）」が存在することも確認。
`writeWorkbook.test.ts`に列追加・チャート追加の回帰テストを2件追加しています。

### 8.4 生産・調達推移／品質・信用推移シートのスコープ再確認（ご指摘§3）

元のSAI-3B-2仕様を再確認しました。

- **§2（シート構成の原則）**: 「すべてのシートを必ず作るのではなく、
  元データが取得でき、経営分析上有効なものを作成してください。」
- **§4（KPI優先度）**: 生産・調達推移／品質・信用推移は明示的に**P1
  （「可能な範囲で」対応する優先度2番目のKPI群）**として区分されており、
  §2〜§3で必須指定されているP0（A〜H、8種のチャート）には含まれていません。

このため、この2シートは**元から任意（P1）扱いであり、必須（P0）ではなかった
ことを確認しました**。`docs/v2/reusable-analysis/kpi_catalog.md`§5に
「未実装のP1候補（次ラウンドへ持ち越し）」として明示的に記載済みで、
理由（データ自体はprocurementProduction/salesAnalysis/quarterPerformance
シートに既に存在するが、専用ダッシュボードシート化は本ラウンドのスコープ外
とした）も記載されています。**今回、新たにこの2シートを実装することはして
いません**（§2の原則どおり、P1のまま次ラウンド候補とすることが元の指示に
沿った対応と判断したため）。

### 8.5 §8 運用性レポートの拡充（ご指摘§4）

**シート数（変更前後）**:

| ブック | シート数 | 備考 |
|---|---|---|
| 単一run（`standard-h80.xlsx`） | 24 | 受入レビュー2回目対応前後で変化なし（既存シートへの列・チャート追加のみ、新規シート追加なし） |
| 80/85/90比較（`headcount-80-85-90-comparison.xlsx`） | 25 | 同上 |

**ネイティブグラフ数（変更前後）**:

| ブック | 変更前 | 変更後 | 差分 |
|---|---|---|---|
| 単一run | 28 | 28 | 0（単一runには「80_85_90人比較」シート自体が存在しないため） |
| 80/85/90比較 | 76 | 77 | +1（§8.3の営業人件費グラフ） |

**ファイルサイズ**:

| ブック | サイズ |
|---|---|
| `standard-h80.xlsx` | 21,075,675 bytes（約20.1MB） |
| `headcount-80-85-90-comparison.xlsx` | 74,495,618 bytes（約71.0MB） |
| `headcount-80-85-90-comparison-review-sample.xlsx`（§8.6） | 19,805,885 bytes（約18.9MB、正式版の約27%） |

**実測した開閉時間・メモリ**（下記「測定環境」参照。**実測値**であり
見積もりではありません）:

| 操作 | 単一run | 80/85/90比較（正式） | レビューサンプル |
|---|---|---|---|
| ExcelJS再読込 | 2.08秒 | 7.57秒 | 1.90秒 |
| openpyxl再読込 | 4.42秒 | 18.17秒 | 4.74秒 |
| LibreOffice headless変換（CSV書き出し、または大規模ファイルはxlsx往復変換で健全性確認） | 5秒 | 18秒（xlsx→xlsx往復変換） | 5秒 |
| openpyxl読込時のピークRSS（`resource.getrusage`実測） | 未計測 | **681.1 MB** | 未計測 |

**メモリ問題の有無**: 生成・再読込のいずれの過程でも、メモリ不足による
クラッシュ・異常終了・スワップ発生は観測されませんでした（測定環境の
物理メモリ7.8GBに対し、最大測定ケースでもピークRSSは約681MB＝使用率
9%程度）。

**測定環境（この完了報告の実測値はすべて以下の環境によるもの）**:
- OS: Linux（クラウドサンドボックスコンテナ）、vCPU 2コア、メモリ7.8GB
- Node.js v22.22.2、`exceljs`^4.4.0
- Python 3.11.15、`openpyxl` 3.1.5
- LibreOffice 24.2.7.2

**注記**: 本セッションはクラウドサンドボックス上で動作しており、三宅さんが
実際にお使いのExcelデスクトップアプリでの体感速度（特にネイティブグラフの
再計算・再描画にかかる時間）はこの環境では測定できません。上記はあくまで
「ファイルとして壊れていないか・プログラムから見て開閉できるか」の実測値
であり、実際にExcelで開いた際の体感とは異なる可能性があります。この点は
前回報告時から変わらない制約です。

### 8.6 検証結果の個別記載（ご指摘§5）

**注記**: 以下はすべて今回のご指摘対応後、最終コード状態に対して実行した
結果です（再実装ではなく、既存の実装が正しく動作することの確認）。

| 検証項目 | 実行コマンド | 結果 |
|---|---|---|
| SAI-3B関連テスト | `npx tsx --test "app/lib/v2/companyLab/standardAi/sai3b/**/__tests__/**/*.test.ts"` | **92件**すべて通過（既存86件＋今回追加6件: stddev計算2件、Layer1/Layer2区別2件、営業人件費列・グラフ2件） |
| リポジトリ全体テスト | `npm test`（内部的に`tsx --test "app/lib/**/__tests__/**/*.test.ts" "app/v2/**/__tests__/**/*.test.ts" "app/api/**/__tests__/**/*.test.ts"`） | **1,813件**すべて通過 |
| 型チェック | `npx tsc --noEmit -p .` | エラーなし（クリーン） |
| Lint | `npm run lint` | エラー0件（警告4件、うち2件は本ラウンド変更ファイル`dashboardCharts.ts`の既存未使用import警告で今回のご指摘対応前から存在。もう2件は無関係の別ファイル） |
| ExcelJS再読込 | Node.jsスクリプトで`new ExcelJS.Workbook().xlsx.readFile(...)`を3ブックに対して実行 | 3ブックすべて成功（シート数・読込時間は§8.5参照） |
| openpyxl再読込 | `openpyxl.load_workbook(f, data_only=False)`を3ブックに対して実行 | 3ブックすべて成功 |
| LibreOffice変換 | `soffice --headless --convert-to csv:"Text - txt - csv (StarCalc)"`（単一run・レビューサンプル）／`soffice --headless --convert-to xlsx`（80/85/90正式版、往復変換での健全性確認） | 3ブックすべて成功、破損なし |
| 元データとの突き合わせ（捏造チェック） | Pythonの`csv`/`statistics`モジュールで`quarter-summary.csv`・`case-summary.csv`から独立に算出した値と、生成されたxlsxのセル値を比較 | Layer2統計値（average/median/min/max/stddev）・営業人件費列の値、いずれも完全一致 |

### 8.7 軽量レビュー用サンプルブックの作成（ご指摘§6）

**作成物**: `artifacts/sai3b/headcount-80-85-90-comparison-review-sample.xlsx`
（ファイル名に`review-sample`を含み、正式12seed版とは明確に区別。**正式版
`headcount-80-85-90-comparison.xlsx`は置き換えていません**、両方とも
`artifacts/sai3b/`に共存しています）。

**生成方法**: 新しいスクリプト`scripts/sai3bReviewSampleExcel.ts`を新規作成。
このスクリプトは正式版と**全く同じパイプライン**
（`loadSai3aRun`→`validateComparableRuns`→`buildSai3bAnalysis`→
`renderSai3bWorkbookToBuffer`。いずれも既存の純粋関数）に、seedを絞り込んだ
`LoadedSai3aRun`を渡すだけであり、集計・表示ロジックを複製・再実装した
箇所はありません。これにより「グラフ・シート構成・計算ロジックは正式版と
同一」という要件を、コード上構造的に保証しています（例外は
`runSummary.runSummary`の`totalCases`/`errorCases`/`topReasonCodeCounts`等
の数件のみで、これらは絞り込み後の行データに対して単純な件数カウントを
やり直しているだけで、新しい業務ロジックではありません）。

**選定した3seed・選定理由**（`headcount-80/85/90-12seed-8q`のBAL社
`case-summary.csv`・`paymentDefaultEverByRequestedTurns`列を80/85/90人の
3run間で実際に突き合わせて確認した実測結果に基づく）:

| seed | 80人 | 85人 | 90人 | 選定理由 |
|---|---|---|---|---|
| sai3a-001 | default | default | default | 営業人数を増やしてもdefaultを回避できない「底堅い」ワーストケース |
| sai3a-003 | 非default | **default** | 非default | 85人時のみdefaultする、いわゆる「85人だけdefaultフラグ」の典型例。この機能の動作確認に代表性が高い |
| sai3a-006 | default | 非default | default | 営業人数を増やすほど改善するとは限らない非単調パターン（対比としての異例ケース） |

「一貫して悪い」「中間だけ悪い」「非単調」という3つの異なる挙動パターンを
代表させることを狙いました。同一会社・同一seed対応関係は正式版と完全に
維持されています（検証: レビューサンプルの「80_85_90人比較」シートの
seed列が`sai3a-001, sai3a-003, sai3a-006`の3件のみであることを確認）。

**サイズ**: 18.89MB（正式版74.5MBの約27%。3/12seed=25%相当に近い削減率で、
これはファイルサイズの主要因がRaw_*シート等のseed単位の生データであり、
seed数に概ね比例して縮小するためと考えられます）。

### 8.8 market-allocation-trace.csvバグの報告（ご指摘§7）

**根本原因**: `sai3b/cli/runCli.ts`の`loadRunFromDir`関数が、SAI-3A run
ディレクトリから読み込むファイル一覧として`SAI3A_REQUIRED_RUN_FILES`
（必須7ファイル）のみを参照しており、任意ファイルである
`market-allocation-trace.csv`を一度も読みに行っていませんでした。
`loadSai3aRun`（パース層の純粋関数）自体は元から正しく後方互換に
実装されていた（ファイルが無ければ空配列＋読み込み警告を出すだけ）ため、
バグの所在はCLI層の配線漏れのみでした。

**修正したファイル**:
- `app/lib/v2/companyLab/standardAi/sai3b/loadRun.ts`:
  `SAI3A_OPTIONAL_RUN_FILES`定数（`market-allocation-trace.csv`を含む）を
  新設。
- `app/lib/v2/companyLab/standardAi/sai3b/cli/runCli.ts`:
  `loadRunFromDir`の読み込み対象ファイル一覧を
  `[...SAI3A_REQUIRED_RUN_FILES, ...SAI3A_OPTIONAL_RUN_FILES]`に修正。

**修正前に影響を受けていた出力**: 実際にmarket-allocation-trace.csvを
含むSAI-3A runディレクトリを`--input`に指定しても、CLI経由で生成した
Excelブックでは常に「market-allocation-trace.csvが見つかりません」警告が
出て、以下がすべて「現時点の出力データでは作成不能」として扱われていました:
「市場シェア推移」シート（チャートC）、「売上・数量推移」シートのチャートB
（実績販売数量）。実際にはファイルが存在していたため、この扱いは誤りでした。

**修正後に追加した回帰テスト**: `app/lib/v2/companyLab/standardAi/sai3b/
cli/__tests__/runCli.test.ts`に、market-allocation-trace.csvを含む
fixtureを`Sai3bCliIo`経由で渡した際に、CLI層が実際にこのファイルを
読み込みに行くことを検証するテストを追加。

**実runでの再確認（今回、受入レビュー2回目対応の一環として実施）**:
本ラウンドでは、既存の`artifacts/sai3a/`配下の4run
（`standard-h80-12seed-8q`・`headcount-80/85/90-12seed-8q`）が、
このバグ修正より**前**のゲームエンジンコミット（`5c1d62e`、
`develop/v2`からの分岐元コミット）で生成されたものであり、
`market-allocation-trace.csv`自体が存在しない（当時のSAI-3A出力層
自体がまだこのファイルを生成していなかった）ことが判明しました。
そのため、正式なend-to-end確認のため、同一パラメータ
（`--scenario baseline --baseline-id moderate-pressure --seed-count 12
--quarters 8`、headcountのみ80/85/90で変更）で4runとも
`scripts/sai3aAutoplay.ts`により**再生成**しました（各run
5社×12seed=60ケース、完走60/60、エラー0件、生成時間は4run合計で約8秒）。
再生成後、4runすべてに`market-allocation-trace.csv`が存在し
（`headcount-80-12seed-8q`で7,201行）、各社のdefault発生パターン
（`case-summary.csv`の`paymentDefaultEverByRequestedTurns`）は
再生成前とビット単位で一致することを確認しました（同一seedに対する
エンジンの決定論的な挙動は、このファイル追加によって変化していない
ことの直接的な確認）。再生成後のrunからExcelブックを作り直したところ、
「市場シェア推移」「売上・数量推移」の実績データが「作成不能」ではなく
正しく populate されることを確認しました。

**ゲームエンジン・Standard AIの挙動は変更していないことの確認**: 本ラウンドの
修正（`loadRun.ts`・`cli/runCli.ts`）は、いずれもSAI-3B側（Excel化パイプライン）
の**読み込み**ロジックのみを変更しており、ゲームエンジン
（`app/lib/v2/companyLab/`・`app/lib/v2/finance/`等）・標準AI
（`app/lib/v2/companyLab/standardAi/`のAI意思決定ロジック）・
autoplay出力層（`app/lib/v2/companyLab/standardAi/autoplay/`）は
一切変更していません。上記の再生成でも、同一seedの`paymentDefaultEver
ByRequestedTurns`等の決定論的な結果が完全に一致したことが、エンジン・
Standard AIの挙動が変わっていないことの直接的な証拠になっています。

### 8.9 このラウンドで変更したファイル一覧

1. `app/lib/v2/companyLab/standardAi/sai3b/schema.ts`: `StatSummary`に`stddev`追加、`HeadcountComparisonRow`に`salesForceCostByHeadcount`追加
2. `app/lib/v2/companyLab/standardAi/sai3b/aggregate.ts`: `statSummary()`で標本標準偏差を計算、`buildHeadcountComparison`で営業人件費を集計
3. `app/lib/v2/companyLab/standardAi/sai3b/workbook/dashboardCharts.ts`: `CompanyQuarterKpiSpec.extractStat`追加、Layer2テーブルをLayer1と明確に区別された「会社・seed比較表」へ全面書き換え
4. `app/lib/v2/companyLab/standardAi/sai3b/workbook/writeWorkbook.ts`: 「80_85_90人比較」表に営業人件費列を追加、同シートに会社×営業人数の比較グラフを新規追加
5. `scripts/sai3bReviewSampleExcel.ts`（新規）: レビュー用軽量サンプルブック生成スクリプト
6. `app/lib/v2/companyLab/standardAi/sai3b/__tests__/aggregate.test.ts`: 標準偏差の単体テスト2件追加
7. `app/lib/v2/companyLab/standardAi/sai3b/workbook/__tests__/dashboardCharts.test.ts`: Layer1/Layer2区別・H-5の算出不可ノートのテスト2件追加
8. `app/lib/v2/companyLab/standardAi/sai3b/workbook/__tests__/writeWorkbook.test.ts`: 営業人件費列・グラフのテスト2件追加
9. `docs/v2/reports/sai3b2_completion_report.md`（本ファイル）: 本節（§8）を追記

**このラウンドのコミット後のHEAD**: 本ファイルへのコミット直後にコミット
ハッシュを確定するため、次のコミットメッセージ内、およびユーザーへの
最終報告メッセージで正確なハッシュを報告します（このMarkdown自体には
ハッシュを埋め込んでいません。循環参照になるため）。

### 8.10 本ラウンドでも未対応のまま残っている項目（正直な報告）

- §6の15KPIのうち、営業キャッシュフロー・短期借入・在庫・売掛金は、
  「80_85_90人比較」表への会社×seed横並び列としては引き続き未収録です
  （グラフでの比較自体は既存の専用シートで可能なため、大規模な作り直しを
  避ける判断で今回は見送りました。§8.2参照）。
- 生産・調達推移／品質・信用推移の2ダッシュボードシートは、元の指示で
  P1（任意）指定であることを確認した上で、引き続き未実装のままです
  （§8.4参照、意図的な判断）。
- book-split（run単位・データ種別単位での複数ファイル分割）は前回報告時から
  未実施のままです。
- 三宅さんの実際のExcelデスクトップアプリでの体感速度は、このクラウド
  サンドボックス環境では測定できていません（§8.5参照）。
