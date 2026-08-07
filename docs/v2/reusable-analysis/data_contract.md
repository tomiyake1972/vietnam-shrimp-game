# データ契約（SAI-3A出力 ⇄ SAI-3B入力、SAI-3B-2時点）

SAI-3A（自動テストプレイ・ログ出力）とSAI-3B（Excel経営分析ブック生成）の
境界における、ファイル形式・スキーマバージョニング・欠損値の扱いに関する
契約をまとめたもの。

## 1. runディレクトリの必須ファイル・任意ファイル

`app/lib/v2/companyLab/standardAi/sai3b/loadRun.ts`:

- `SAI3A_REQUIRED_RUN_FILES`（7ファイル、欠落時は起動時エラー）:
  `manifest.json`, `case-summary.csv`, `quarter-summary.csv`,
  `decision-trace.jsonl`, `adjustment-trace.csv`, `warnings.csv`,
  `run-summary.json`
- `SAI3A_OPTIONAL_RUN_FILES`（SAI-3B-2で追加、欠落しても致命的エラーに
  しない、代わりに`loadWarnings`へ警告を積む）:
  `market-allocation-trace.csv`

**§12検証で発見した教訓**: `loadSai3aRun`（純粋関数）自体は任意ファイルの
欠落を正しく後方互換的に扱えるよう最初から設計されていたが、CLI層
（`sai3b/cli/runCli.ts`の`loadRunFromDir`）が`SAI3A_REQUIRED_RUN_FILES`
のみをファイルシステムから読み込んでおり、`SAI3A_OPTIONAL_RUN_FILES`を
一切読もうとしていなかったため、実際にmarket-allocation-trace.csvを含む
runディレクトリを指定しても、CLI経由では常に「見つかりません」警告が出て
しまうバグがあった。**「純粋関数がoptionalに対応している」ことと「CLI層が
実際にそのファイルを読みに行く」ことは別の契約であり、両方をテストで
カバーする必要がある**（`runCli.test.ts`に回帰テストを追加済み）。今後
任意ファイルを追加する際は、`SAI3A_OPTIONAL_RUN_FILES`定数へ追加するだけで
CLI層も自動的に読みに行くようにしてあるため、同種のバグは再発しにくい。

## 2. スキーマバージョニング方針

- `SAI3A_LOG_SCHEMA_VERSION`（`autoplay/schema.ts`）は"1.0.0"のまま
  据え置き。SAI-3B-2で追加したフィールド（`marketAllocationTrace`、
  quarter-summary.csvの追加列群）はすべて**追加のみ（additive-only）**
  であり、既存フィールドの意味・型を変更していないため、非破壊的な
  マイナー拡張としてバージョンを上げていない。
- `SUPPORTED_SAI3A_SCHEMA_VERSIONS`（`sai3b/schema.ts`）でSAI-3Bが
  読み込み可能なバージョンを明示し、対応外のバージョンは起動時エラーに
  する。

## 3. 欠損値の扱い（全レイヤー共通の契約）

**「取得できない値は`undefined`のままにし、`0`や捏造した推定値に
変換しない」**という原則を、パース層・集計層・表示層すべてで一貫させる。

- パース層（`parse.ts`）: CSV列が空文字列の場合は`undefined`を返す
  （`0`にparseしない）。
- 集計層（`aggregate.ts`）: `pickDefined`ヘルパーで`undefined`を除外して
  から統計量（average/median/min/max）を計算する。全件`undefined`なら
  `StatSummary`のすべてのフィールドが`undefined`のまま（`n: 0`）。
- 表示層（`writeWorkbook.ts`/`dashboardCharts.ts`）: セルには空文字列
  `""`を書き込み（`0`ではない）、ネイティブグラフのnumCacheでは該当
  `<c:pt>`要素そのものを省略する（`chartInjector.buildNumCache`）。

この契約が破られていないことは、`writeWorkbook.test.ts`の
「営業能力使用率が欠損しているrunでも、表・グラフ用データが0に変換され
ない」という回帰テスト（三宅さんのご指摘・受入レビュー由来）で固定化
されている。

## 4. 「実績」データソースの優先順位（重要な設計判断）

SAI-3A側には、同じ「販売数量」に対応する複数のデータソースが存在する。
それぞれ意味が異なるため、混同しないよう明示的に区別している:

| データソース | 意味 | SAI-3Bでの用途 |
| --- | --- | --- |
| `salesQuantityTrace.desiredQuantityBeforeEffortConstraint` | 営業工数制約適用前の真の希望販売数量 | 販売分析シートの「希望販売量(制約前)」 |
| `salesQuantityTrace.finalPlannedQuantity` | 営業工数制約適用後、engineへ提出された最終計画数量（実際の成約結果ではない） | 販売分析シート・四半期業績シートの「最終計画数量/販売量」 |
| `salesRecord.allocations[].companies[].allocatedQuantity`（= market-allocation-trace.csv） | 市場清算で実際に配分を得た数量（実績に相当） | ダッシュボードKPI B「会社別販売数量推移（実績）」 |
| `summary.hosoProduced`等 | 生産量（販売量ではない） | **販売量として使ってはいけない**（SAI-3B-2で発見・修正した`salesQuantityByProduct`のバグの原因） |

**教訓**: 「実績」という言葉だけでフィールドを選ぶと、生産量と販売量を
取り違えるなどの誤りが起きやすい。フィールド名だけでなく、そのフィールドが
「何によって、いつ計算された値か」（提出時点か、清算後かなど）を必ず
ソースコード側のコメントで確認してから採用する。

## 5. CSVフラット化の安全条件

`Record<string, T>`型のフィールド（商品別・市場別の値）をCSVの固定列へ
フラット化する場合、キー集合が**固定・小規模なenumであること**を事前に
ソースコードで確認してから行う（本ラウンドでは`Product`
（`"hoso"|"pd"|"vap"`）と`DemandMarketId`
（`"CN"|"US"|"EU"|"JP"|"OTHER"`）が共に`market/types.ts`で固定enumで
あることを確認済み）。キー集合が可変・無制限な場合はフラット化せず、
JSONL側にのみ保持する。
