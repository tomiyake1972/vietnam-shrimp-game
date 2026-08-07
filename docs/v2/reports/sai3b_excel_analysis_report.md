# Phase SAI-3B-1 レポート — Excel経営分析ブック第1版

対象: `feature/v2-sai3b-excel-analysis`（`develop/v2`の`b1733e1`起点。SAI-3A統合後）
本Markdownは`docs/v2/reports/sai3b_excel_analysis_report.md`としてgit管理下にあります。
生成物（`artifacts/sai3b/*.xlsx`）自体はgit管理対象外です（`.gitignore`参照）。

---

## 1. 目的とスコープ

SAI-3Bは、SAI-3Aが出力したJSON/CSV/JSONLログを、人間が実際に分析できるExcelブックへ
変換する層です。今回のSAI-3B-1で最優先したのは、三宅さんのご指示どおり「見栄え」では
なく、**会社間・seed間の差、AIの希望と最終計画の差、defaultの発生過程、営業人数
80・85・90人の非連続な結果を追跡できる分析道具**を作ることです。

SAI-3Bは読み取り専用の分析・表示層であり、ゲームエンジン・標準AIのロジックを一切
変更していません。財務・販売・生産の結果を独自に再計算することもせず、SAI-3Aのログ
値をそのまま真実の値として扱っています。存在しないデータは捏造せず、空欄／N/Aと明記し
（§7「不足しているログ項目」参照）、集計方法は本レポート§4・§5に明記した通り
再現可能なロジックのみを用いています。

## 2. 実装構成

新規ファイルはすべて`app/lib/v2/companyLab/standardAi/sai3b/`配下と、薄いエントリ
ポイント`scripts/sai3bExcel.ts`のみです。ゲームエンジン本体・標準AIのロジックファイル
は一切変更していません（SAI-3Aで追加された2フィールドも今回は変更なし）。

```
app/lib/v2/companyLab/standardAi/sai3b/
  schema.ts              # SAI-3B内部型定義一式。SAI3B_VERSION = "1.0.0"
  parse.ts               # SAI-3Aの7ファイル（manifest/csv/jsonl/json）のパーサー（手書き、外部CSVライブラリ不使用）
  loadRun.ts              # 1 run分の読み込み・必須ファイル検証・スキーマバージョン検証
  compareRuns.ts           # 複数run比較時の整合性検証（共通seed/会社/quarter）
  reasonCodeCatalog.ts     # 既存reason codeレジストリの参照のみ（新規コード定義なし）
  aggregate.ts             # 各シート用の集計ビルダー一式（12種類）
  buildAnalysis.ts          # 上記すべてを束ねた最終分析データ（Sai3bAnalysis）の組み立て
  workbook/
    styles.ts               # 共通スタイル定義
    writeWorkbook.ts          # 18シート分のExcelJSブック組み立て
    chartInjector.ts           # exceljsが未対応のネイティブグラフを手書きOOXMLで注入
  cli/
    types.ts / argParser.ts / runCli.ts / index.ts   # 引数解析・実行オーケストレーション（fs非依存）
  __tests__/, workbook/__tests__/, cli/__tests__/     # テスト（§9参照）
scripts/sai3bExcel.ts       # 唯一の副作用（fs読み書き・標準出力・終了コード）を持つ薄いエントリポイント
```

### 2.1 データフロー

```
loadSai3aRun（--inputごとに1回）
  → 7ファイルの存在・スキーマバージョン検証 → parse.tsで型付きデータへ

validateComparableRuns（複数run時）
  → 共通seed・共通会社ID・共通quarter数を算出し、比較可否を判定
  → 不整合があれば「比較条件が不整合」エラーで停止（黙って進めない）

buildSai3bAnalysis（全runまとめて1回）
  → aggregate.tsの12個のbuild関数を呼び出し、Sai3bAnalysis（18シート分のデータ）を組み立て

buildSai3bWorkbook / renderSai3bWorkbookToBuffer
  → ExcelJSでシート一式を書き込み（表・書式・オートフィルター・ウィンドウ枠固定・条件付き書式）
  → xlsx.writeBuffer()後、chartInjector.tsでグラフ4種をOOXMLとして直接注入
```

## 3. Excelライブラリの選定

**`exceljs`（v4.4.0、既存の依存関係）をそのまま採用しました。** 新規npm依存は追加して
いません。既にプロジェクト内の`companyLabAdminExcelBuilder.ts`で使われており、保守性・
学習コストの観点で最も合理的です。

一方、exceljsはネイティブExcelグラフの書き込みに対応していません（`node_modules/exceljs/
lib/xlsx/xform/book/workbook-xform.js`内に「we don't have the infrastructure to
support chartsheets」という開発者コメントがあり、ソースコード確認により確定）。この
制約への対処として、既存の依存関係である`jszip`（新規追加ではない）を使い、exceljsが
生成したxlsx（実体はzipアーカイブ）に対して、最小限のOOXMLグラフパーツ
（`xl/charts/chartN.xml`・`xl/drawings/drawing1.xml`＋rels・`[Content_Types].xml`の
追加・対象シートXMLへの`<drawing>`参照追加）を手書きで後注入する`chartInjector.ts`を
実装しました。

この手法は「破損しないこと」が絶対条件だったため、本体パイプラインに組み込む前に
単体で検証しています。検証には`openpyxl`（Pythonで生成物のグラフオブジェクトが正しく
`BarChart`として解析できること）と、実際にインストールされている`/usr/bin/soffice`
（LibreOffice headless、`--convert-to pdf/png`で実際に開けて描画されることの確認）の
両方を使いました。今回、実物の2ブック（§8）についても同じ手法で最終検証済みです
（§12）。

## 4. ワークブック構成（18シート）

Excelのシート名31文字制限に対応するため、一部略称・アンダースコア区切りを使用して
います。

| # | シート名 | 内容 |
|---|---|---|
| 1 | README | ブック生成日時・SAI-3Bバージョン・SAI-3Aスキーマバージョン・入力run一覧・実行条件・各シート説明・希望/最終の意味論・不足ログ項目 |
| 2 | 全体サマリー | run単位（複数runは行で横並び）のダッシュボード：完走/エラーケース数、default率、UWフローズン率、重大警告件数、売上/利益、販売数量、工数制約削減量、希望-最終差、能力使用率、最頻reason code |
| 3 | グラフ | ネイティブグラフ4種＋描画用データ表 |
| 4 | 会社別業績 | 会社×seed単位の業績（フィルター・ソート・ウィンドウ枠固定対応） |
| 5 | 四半期業績 | 会社×seed×四半期のPL/BS/CF/KPI（捏造なし） |
| 6 | 販売分析 | 市場×商品×会社×seed×四半期の希望/工数調整後/最終/数量・reason code |
| 7 | 調達_生産_在庫 | 取得可能な範囲での調達・生産・在庫データ |
| 8 | 営業能力分析 | 営業人数・能力・使用率・削減量（会社全体） |
| 9 | 営業能力_市場別 | 市場別の物理数量ベースの希望/最終/削減量（換算能力の市場別内訳はログ非搭載、§7参照） |
| 10 | 計画調整分析 | 希望→調整→最終のドメイン別before/after/delta/reason code、ログ参照ID付き |
| 11 | Default_信用_警告 | default/UWフローズンの発生前後、警告一覧 |
| 12 | ReasonCode集計 | 既存reason codeレジストリのみを参照した集計（新規コード定義なし） |
| 13 | 80_85_90人比較 | 複数run時のみ生成。同一会社・同一seedの対応をとった80/85/90人比較、「中間人数だけdefault」の機械検出フラグ |
| 14 | 四半期判断トレース | 期首状態→AI提出案→制約調整→最終決定→四半期結果→警告のロングフォーマット |
| 15-18 | Raw_Case / Raw_Quarter / Raw_Decision / Raw_Adjustment / Raw_Warnings | SAI-3Aの生ログをほぼそのまま（Excel行数上限を考慮） |

すべてのシートでヘッダー行の書式統一・オートフィルター・ウィンドウ枠固定・列幅調整を
実施し、default/重大警告/現金マイナスに対する条件付き書式、入力データと集計データの
色分けを適用しています。過度な装飾は避けています。

### 4.1 希望・最終の意味論（三宅さんのご指示を反映）

ドメインごとに異なる意味を持つため、README・各シートの列見出し・注記で明確に区別
しています。

- **販売**: `desiredQuantityBeforeEffortConstraint`は営業工数制約**前**のAI希望量。
  `finalPlannedSalesQuantityTotal`は工数調整後の最終計画数量。
- **調達**: AI提出希望量 vs 資金制約適用後の`final`。
- **生産・労務・財務**: AIが提出した計画値（`productionPlanQuantityTotal`等）であり、
  標準AI内部の全調整前の値ではない点に注意。
- **数値化できない標準AI診断**: reason codeのみで表現し、存在しないbefore/afterを
  作らない。

## 5. KPI・集計単位の定義

- **default率（ケース単位）**: `default発生数 ÷ 全ケース数`。四半期単位の発生率では
  ない（README・§4-2ダッシュボードに明記）。
- **平均値**: 完走・エラーを問わず値が存在する行のみで算出。欠損値は0として扱わず、
  分母から除外（ゼロ補完なし）。
- **削減率**: `削減量 ÷ 制約前希望量`（会社全体・累計ベース）。
- **能力使用率**: SAI-3Aのquarter-summary.csvが会社全体合計でのみ提供する値をそのまま
  転記（市場別内訳は非搭載、§7参照）。
- **会社・seed・quarter・run-IDキー**: すべての集計行・生ログ行に保持し、Excel値と
  SAI-3A原本を相互参照できるようにしている。

## 6. 単一run本 vs 複数run（比較）本の違い

- 単一run: 80_85_90人比較シートは生成しない（比較対象がないため）。全体サマリーは
  1行のみ。
- 複数run: `--input`を複数回指定すると、`validateComparableRuns`が共通seed・共通会社
  ID・共通quarter数を検証する。不整合（例：共通seedが皆無）があれば**exitCode=1で
  明示的エラーとし、黙って進めない**。整合していれば全体サマリーが行ごとに横並びと
  なり、80_85_90人比較シートが追加される（run数が3でなくても、2run以上なら生成）。

## 7. 不足しているログ項目（今回取得できなかったもの・捏造していないもの）

SAI-3Aの既存7ファイルの範囲内で取得できなかった項目を、README「不足しているログ
項目」セクションおよびExcel生成コード内の`MISSING_FIELD_NOTES`に明記しています。
SAI-3Aのログスキーマ自体は変更していません（三宅さんのご指示「なるべく変更しない」
に従い、今回は追加なしで対応可能と判断しました）。

1. 四半期結果側の実際の生産量（生産能力制約後の実績値）はいずれの出力にも含まれて
   おらず取得不可。四半期業績・調達生産在庫シートの生産量はAI提出計画値。
2. 実際に成約・履行された販売数量（新規成約・履行・未成約・延滞）も同様に非搭載。
   販売分析・四半期業績シートの販売数量は営業工数制約適用後の「最終計画数量」。
3. 四半期末時点の売掛金・買掛金残高は非搭載。四半期業績シートの値は「四半期開始
   時点」の値。
4. 市場別の営業工数換算能力・使用率（HOSO×1.0+PD×1.2+VAP×3.0の係数使用）は会社
   全体合計のみ搭載。営業能力_市場別シートは係数使用の再計算を避け、物理数量
   （トン）ベースの希望量・最終計画量・削減量のみを提供。
5. 売上総利益・営業利益の商品別・市場別内訳（三宅さんの指示4-5「可能なら」）は非搭載
   のため未対応。

## 8. CLIと実行結果（第1回実行）

### 8.1 CLI仕様

```
npx tsx scripts/sai3bExcel.ts --input <SAI-3Aのrunディレクトリ> --output <出力xlsxパス>
npx tsx scripts/sai3bExcel.ts --input <run1> --input <run2> --input <run3> --output <出力xlsxパス>
npx tsx scripts/sai3bExcel.ts --help
```

- `--input`を複数回指定すると複数run比較。ヘッドカウント等はハードコードせず、各
  runのmanifest.jsonから読み取る。
- 出力ディレクトリが存在しなければ自動作成。既存ファイルは上書きし、上書き時は
  その旨を標準出力に明示。
- 生成されたxlsxはGit管理対象外（`.gitignore`に`/artifacts/sai3b/`を追加済み）。

### 8.2 入力（既存run、新規生成なし）

12 seed（`sai3a-001`〜`sai3a-012`）×5社（BAL/MASS/JPQ/VAP/CONSV）×8四半期という
指定条件に一致する既存run4本がディスク上に存在することを確認し、再利用しました
（SAI-3A側で以前に生成済み）。

- `artifacts/sai3a/standard-h80-12seed-8q`（`salesForceHeadcountOverrideSpecified: false`、
  営業人数80人＝標準ベースライン）
- `artifacts/sai3a/headcount-80-12seed-8q`（80人、明示override）
- `artifacts/sai3a/headcount-85-12seed-8q`（85人、明示override）
- `artifacts/sai3a/headcount-90-12seed-8q`（90人、明示override）

### 8.3 生成結果

```
npx tsx scripts/sai3bExcel.ts --input artifacts/sai3a/standard-h80-12seed-8q \
  --output artifacts/sai3b/standard-h80.xlsx

npx tsx scripts/sai3bExcel.ts \
  --input artifacts/sai3a/headcount-80-12seed-8q \
  --input artifacts/sai3a/headcount-85-12seed-8q \
  --input artifacts/sai3a/headcount-90-12seed-8q \
  --output artifacts/sai3b/headcount-80-85-90-comparison.xlsx
```

| ファイル | サイズ | run数 |
|---|---|---|
| `artifacts/sai3b/standard-h80.xlsx` | 20,661,914 bytes（約19.7MB） | 1（standard-h80-12seed-8q） |
| `artifacts/sai3b/headcount-80-85-90-comparison.xlsx` | 73,265,319 bytes（約69.9MB） | 3（headcount-80/85/90-12seed-8q） |

両ファイルとも生データ行数が多いシート（計画調整分析：単一run 10,183行／比較本
37,718行、販売分析：単一run 7,202行／比較本21,602行など）を含むため、比較本は
単一run本のおよそ3.5倍のサイズになっています。行数はrun数にほぼ比例しており、
異常な重複は確認されませんでした。

### 8.4 実物との値の突き合わせ（キー・値クロスチェック）

生成されたExcelの値を、SAI-3Aの元CSVから独立に再計算した値と突き合わせました。

- **全体サマリーのdefault率**（standard-h80）: Excel上`29/60 = 0.48333...`。
  `case-summary.csv`から`paymentDefaultEverByRequestedTurns == true`の行を独立に
  カウントした結果も29件、60件中 → **完全一致**。
- **総売上・総粗利益**（standard-h80）: Excel上`$22,007,237,107.539463` /
  `$1,603,233,797.0578878`。`case-summary.csv`の`cumulativeRevenueUsd` /
  `cumulativeGrossProfitUsd`列を独立にPythonで合計した結果も同一値（浮動小数点
  完全一致）→ **一致**。
- **80_85_90人比較の「85人だけdefaultフラグ」**: Excel上「はい」の行は17件
  （BAL×2、CONSV×4、JPQ×4、MASS×4、VAP×3の会社×seed組み合わせ）。3本のCSVを
  独立に読み込み、`80人・90人はfalse かつ 85人はtrue`となる会社×seedの組を
  Pythonで独立集計した結果も17件で、内訳（seed/会社の組）も完全一致 →
  **一致**。

## 9. 「85人問題」の追加診断（新たに確認できた事実 vs 依然推測の域を出ない事項）

### 9.1 新たに確認できた事実（実データのクロスチェック済み）

- 全体の`default率（ケース単位）`は headcount 80人=48.3%（29/60）、
  **85人=96.7%（58/60）**、90人=43.3%（26/60）であり、85人だけが際立って
  高い。80→85→90は単調な変化ではなく、85人だけが不連続に悪化している
  （三宅さんが指摘された非連続性の存在を、今回実データで再確認）。
- 80_85_90人比較シートで機械的に検出された「80人・90人ではdefaultしないが
  85人だけdefaultする」会社×seedの組は17件（60件中）存在する。これは
  CSV原本からの独立再計算でも同数・同一内訳が確認できている（§8.4）。
- 上記17件について`default初回turn`はすべて**第6四半期（turn=6）**で一致
  していた。
- 詳細トレース例（BAL・sai3a-003・85人）: 期首現金はQ1=2,000万→Q5末に
  ちょうど0まで低下→Q6末に-2,706,203（初めてdefault発動、
  `paymentDefaultNewlyTriggered=true`）→Q7・Q8は現金がプラスに回復し
  defaultフラグはfalseに戻る。営業工数使用率はQ1〜Q8を通じて終始
  ほぼ100.0%（1.0000021592748614〜）に張り付いている。
- 17件のうち一部（例：seed `sai3a-002`のMASS/JPQ/VAP/CONSVの4社）は、
  85人runにおける期末現金・期末借入・累計売上が会社間で**完全に同一の値**
  になっている（例：期末現金 -2,698,092.4457747303 USD が4社とも一致）。
  同じseed内でBAL社のみ異なる値（期末現金 ≈ 0）を示している。この
  「同一seed内での複数会社の値の完全一致」は、SAI-3Aの生ログ
  （`headcount-85-12seed-8q/case-summary.csv`）に実際に存在するパターン
  であり、SAI-3B側での加工・誤りではないことを確認済み。ただし、これが
  標準AI・ゲームエンジン側のどのような挙動に起因するかは、SAI-3Bの
  スコープ外（読み取り専用の分析層）であるため特定していない。

### 9.2 依然推測の域を出ない事項（今回は断定していない）

- なぜ85人という中間の営業人数だけが、80人・90人よりも顕著に高いdefault率
  になるのか、という**因果関係そのもの**（標準AI・ゲームエンジン内部の
  どの計算式・閾値がこの非連続性を生んでいるか）。
- 上記9.1の「同一seed内で複数会社の値が完全一致する」現象の原因（標準AI
  パラメータの何らかの共有、あるいは偶然の収束か）。
- default発動直前（Q5→Q6）の現金急減の直接要因（在庫評価・借入コスト・
  販売未達のどれが支配的か）を、既存ログの範囲内で完全に切り分けること。
  ログに商品別・市場別の粗利益内訳がないため（§7-5）、これ以上の分解は
  今回のログ範囲では不可能。

いずれについても、三宅さんのご指示どおり**標準AIロジックの変更・85人専用の
補正は一切行っていません**。上記は既存ログの追加集計・トレースのみで確認
できた事実の整理であり、根本原因の断定はしていません。

## 10. テスト結果

新規63件（すべて成功）。内訳: parse.ts、loadRun.ts、compareRuns.ts、
reasonCodeCatalog.ts、aggregate.ts、buildAnalysis.ts、CLI引数解析、CLI結合
テスト（runCli.ts）、writeWorkbook.ts、chartInjector.tsをカバーしており、
以下を検証しています。

- 単一run読み込み・複数run読み込み・manifest/スキーマバージョン検証
- 必須ファイル欠落時の明確なエラー、malformed CSV/JSON/JSONLの検出
- 会社×seed×quarterキーの保持、原本ログとExcelセルの値一致
- 集計値と独立再計算値の一致、default率の分母分子の正しさ
- 希望/最終/差分の正しさ、reason code集計件数の正しさ
- 80/85/90人の同一seed・同一会社対応、比較不整合の検出
- 欠損値のゼロ補完がないこと、生成xlsxの再読み込み可能性
- 必須シート・列の存在、数値セルが文字列化されていないこと
- default無しrun・エラーありrunでの生成成功
- 既存SAI-3A・標準AIの挙動に変更がないこと

プロジェクト全体のテスト（既存1,719件＋SAI-3B新規63件 = **1,782件**、SAI-3A・
標準AI・会社ラボ・産業ラボ・財務/販売/在庫/営業工数関連の既存テストすべてを
含む）を実行し、**全1,782件成功、失敗0件**を確認しました。

## 11. 最終検証結果

- `npx tsc --noEmit`: エラー0件。
- `npm test`（プロジェクト全体）: 1,782 / 1,782件成功。
- `npm run lint`: エラー0件。既知の無関係な警告2件のみ（`app/lib/v2/redis/
  __tests__/companyLabExportAuditLog.test.ts`の`'_value'`・`'_options'`未使用
  引数、SAI-3A以前から存在する既知事象で今回のスコープ外）。
- `npx next build`: 成功、全ルート生成。
- 実物2ブックの機械的再読み込み（`exceljs`・`openpyxl`）: 破損なし、全シート
  名・行数を確認。
- 実物2ブックのLibreOffice headless (`soffice --convert-to pdf`) による実際の
  変換・レンダリング: 両ファイルとも正常に変換完了。PDFページを画像化して
  目視確認した結果、日本語シート名・見出し・注記に文字化けなし。
- グラフオブジェクトの検証: 両ブックとも「グラフ」シートにネイティブグラフ
  4件（`BarChart`として`openpyxl`で正しく解析）が存在し、タイトルも正しい
  （営業人数別default率／売上・粗利益・営業利益・期末現金／希望販売量vs最終
  計画数量／平均営業能力使用率）。
- 80/85/90人比較の対応関係: §8.4の通り、同一会社・同一seedの対応が正しいこと
  を独立再計算で確認済み。

## 12. SAI-3B-2への改善候補

- グラフ種類の拡充: 今回は4種（default率／財務指標／希望vs最終数量／能力
  使用率）に絞った。§8「default-case cash/loan/inventory trends」「company/
  seed distribution」は今回未実装（v1では優先度を絞った）。
- §9.1で見つかった「同一seed内での複数会社の値の完全一致」現象は、SAI-3A側
  ログの拡充（会社別の中間計算値の追加）がなければこれ以上の切り分けが
  難しく、SAI-3A側との連携候補。
- LibreOffice PDF変換では、印刷範囲の都合でグラフが複数ページにまたがって
  表示される（Excel上での閲覧・スクリーン表示では問題なし）。印刷レイアウト
  の調整はv2候補。
- 現状Raw_*シートは行数が多い（比較本で計画調整分析37,718行など）。GM分析
  ブックとの関係整理も含め、SAI-3B-2でシート構成・行数の扱いを見直す。
- §7で列挙した5件の非搭載ログ項目のうち、実績生産量・実績販売数量・商品別
  利益内訳は、SAI-3A側のログスキーマに項目を追加すれば取得可能になる見込み
  （三宅さんの承認が前提、今回は見送り）。

## 13. スコープ外（今回実施していないこと）

三宅さんのご指示どおり、以下は一切行っていません: Web/Vercel上でのExcel
ダウンロード機能、ゲームへの書き戻し、VBA/マクロ、Power Query、Claude API・
生成AIによる自然言語分析、AI取締役会・経営会議AI、標準AIの大幅改造、
ゲームバランス調整、営業人数85人専用の補正、`main`へのマージ、
`develop/v2`へのマージ。
