# ShrimpX 32Q Analysis — Navigation / Quick Add

Analysis を「巨大 dashboard」から「必要な分析へすぐ移動する索引 ＋ 独立した分析画面群」へ
作り替えた記録。ゲームルール・Standard AI の判断ロジックは変更していない（観察画面のみ）。

---

## 1. 何を変えたか

| | 変更前（Phase 2） | 変更後 |
|---|---|---|
| Analysis | 1ページ内のアプリ内タブ | **1分析＝1URL**（10ルート） |
| Analysis トップ | Overview を即描画 | **索引**。既定で全カテゴリ折りたたみ、チャート0個 |
| 同時比較 | 不可（1画面で1タブのみ） | ブラウザタブで**同時に何枚でも**並べられる |
| 選択状態 | 画面のローカル state | **URL の query が唯一の情報源** |
| Console | 情報が縦に積まれる | 詳細を折りたたみ ＋ Quick Navigation |

---

## 2. ルート構成

```
/v2/management/analysis                      索引（Analysis Home）
/v2/management/analysis/prices               市場別 × 商品別 価格      ?run= &market=
/v2/management/analysis/contribution         各社 × 商品別 限界利益率  ?run= &company= &product= &mode=
/v2/management/analysis/fixed-cost           各社 固定費               ?run= &company=
/v2/management/analysis/sales-headcount      各社 総営業人員数         ?run=
/v2/management/analysis/sales-allocation     各社 市場別 営業配置      ?run= &company=
/v2/management/analysis/overview             Overview（全指標）        ?run=
/v2/management/analysis/market               需要 TRUE/OBSERVABLE ＋ 産地国データ  ?run=
/v2/management/analysis/bottleneck           律速                      ?run=
/v2/management/analysis/ai-trace             Standard AI Trace         ?run=
```

すべての遷移は通常の `<a href>`（`next/link`）で描いている。したがって
**Ctrl+Click / 中クリック / 右クリック → 新しいタブで開く** がそのまま使える。
Analysis Home の各項目には「新しいタブ ↗」も併置した。

---

## 3. Simulation Run の分離（複数タブが互いを壊さない）

- 各画面は `?run=` を**読むだけ**で、active run（localStorage）へは**書き込まない**。
- Run の切り替えも画面 state ではなくリンク（`?run=` が変わる）。
- 選択状態（market / company / product / mode）も URL に載る。

この2点により、

```
タブ1: /prices?run=R&market=JP
タブ2: /prices?run=R&market=CN
タブ3: /sales-allocation?run=R&company=BAL
タブ4: /sales-allocation?run=R&company=MASS
```

を同時に開いても、どのタブの操作も他のタブの run・選択を変えない。

実装は `useQueryParam`（`useSyncExternalStore` で URL を購読）に一本化してある。
画面のローカル state に選択を二重に持たないため、リロードしても選択が保たれる。

**Analysis 画面は Simulation を実行しない。** これは規約ではなくテストで担保しており、
`app/v2/management/analysis/` 配下の import に `simulation/engine` /
`companyLab/runner` / `standardAi/policy` が現れないこと、および
`setActiveSimulationRunId` を呼ばないことを機械的に検査している（P3-7 / P3-8）。

---

## 4. Analysis Home（索引）

- カテゴリ: 市場 / 収益性 / 営業 / 生産・オペレーション / 投資 / 財務 / Standard AI / Scenario
- **初期状態はすべて閉じている**（実測: `aria-expanded="false"` × 8）
- **チャートは0個**。カテゴリを開いてもリンク一覧が出るだけで、チャートは描かれない
  （実測: 開いた後も `svg[role=img]` は 0 個）
- 折りたたみ部品は閉じている間 children をマウントしないため、dataset の先読みも起きない
- 上部に Quick Navigation（商品別価格 / 商品別限界利益 / 固定費 / 営業人数 / 営業配置）

未実装の分析項目は索引に「（未実装）」と明記し、リンクを張らない
（中身があるように見せない）。

---

## 5. データ定義の監査結果

### 5.1 限界利益（新しい独自式を作っていない）

出所は財務モジュールが既に出している管理会計レポート
`CompanyFinancialQuarterResult.contributionMargin.byProduct` そのもの。

- 商品別の変動費配賦は **finance/quarterClose.ts 側で確定済み**であり、analytics で推測配賦していない
- 純売上高が0の四半期は engine が比率を返さない → **0で埋めず「－」**
- `directFixedCost` は管理会計専用の並行配賦（財務会計の在庫評価・COGSには影響しない）であり、
  限界利益率の計算には使っていない

テスト P3-11 が、全社・全ターンの `contributionMargin` / `netRevenue` / `variableCost` が
財務モジュールの値と一致することを検証する。

### 5.2 固定費（勝手な費用分類をしていない）

正式区分は3つだけ：**固定製造費 / 固定人件費（営業・調達） / 固定販管費**。
この3つの合計が「固定費合計」と一致する（テスト P3-15）。

さらに細かい内訳として出しているのは `ManufacturingCostBreakdown` に**実在する**項目のみ：
工場固定費 / 固定ユーティリティ費 / 減価償却費 / 正社員労務費（総額）。

`HQ/Admin` のような分類はゲームエンジンに存在しないため作っていない。
また、この製造原価側の内訳は固定製造費の中身であって固定人件費・固定販管費を含まないため、
「3区分の合計と一致するかのような見せ方」をしない旨を画面にも明記した。

### 5.3 営業人員配置

engine の意味論をそのまま使っている：

- `salesForceHeadcount` は**会社×市場**の値で、同一市場内の全商品が同じ人数を共有する
  （`sales/salesForce.ts` の `validateSalesForceHeadcountBudget` が検証している）
- したがって市場ごとに1回だけ数える（商品ぶん重複加算しない。テスト P3-17）
- engine が要求するのは「市場別配置の合計 **≤** 実在人数」だけであり、
  **下回ること（未配置が出ること）は正常**

そこで差分を `UNALLOCATED`（未配置）という独立した項目として積み、
**画面側で辻褄合わせの補正はしない**。突き合わせ表と、全ターン一致したかどうかの明示を置いた。

### 5.4 時点の扱い（重要な修正）

営業人員の採用・減員は**次の四半期から反映される**ゲームルールのため、
当期の市場別配置と突き合わせるべき総人数は「当期処理**前**」の値である。
Phase 2 では処理後の値を記録していたので、採用した四半期だけ配置合計と総人数が
食い違って見える状態だった。今回、記録時点を当期処理前へ修正した。

実測: 32Q × 5社の全ターンで「配置合計 ＋ 未配置 ＝ 当期に配分可能だった総人員数」が成立（P3-18）。

---

## 6. Management Console の軽量化

常時表示は Run Control / Simulation Run / Revenue・Operating Profit トレンド /
会社セレクター（5社サマリー表）/ Company Inspector の見出しのみ。

- Market Summary は折りたたみ（既定: 閉）
- Company Inspector の詳細8セクション（Mission・Strategy・財務・操業・ボトルネック・
  AI診断・AI意思決定・判断根拠）はすべて折りたたみ（既定: 閉、実測で確認）
- ヘッダーに Quick Navigation（通常リンク）

---

## 7. チャートの共通仕様

- tooltip（各点に当たり判定を置き、ブラウザ標準のツールチップで `系列 / Qn: 値 単位` を出す）
- legend（実線／破線の区別つき）
- 単位の明示
- Q ラベルは間引く（Q1・4Qごと・最終Q。32本すべては描かない）
- 会社は固定色、市場・商品も固定色
- 積み上げ面グラフ（営業配置・固定費内訳）は、値が無いターンを0として積まず面を途切れさせる

---

## 8. 途中停止した実行

16/32 で STOP した Simulation Run は、各分析ページも完了ターンまでしか表示しない。
足りないターンをゼロや架空値で埋めない（テスト P3-22 で 5/32 の実行を検証）。

---

## 9. 品質ゲートの結果

| 項目 | 結果 |
|---|---|
| `npm test` | **2,612 pass / 0 fail**（Phase 2 時点 2,590 → 新規22件） |
| `tsc --noEmit` | 0 error |
| `eslint .` | 0 error（既存 warning 7件のみ） |
| `next build` | 成功（Analysis 10ルート＋Home がすべて生成） |

### ブラウザ検証（Playwright / production build）

| 確認項目 | 結果 |
|---|---|
| Analysis Home 初期状態 | 8カテゴリすべて `aria-expanded="false"` |
| Analysis Home のチャート数 | **0**（カテゴリを開いた後も 0） |
| Quick Navigation | 5項目すべて `<a href>`、`?run=` 付き |
| 5分析を別タブで同時に開く | 5枚すべてが同じ `simulationRunId` を表示（同時10タブ） |
| 片方のタブで市場を CN に変更 | そのタブの URL だけが `&market=CN` に変わり、他タブは不変 |
| リロード後 | `market=CN` が保たれタイトルも「（CN）」のまま |
| active run | 分析タブを操作しても書き換わらない |
| 数値表 | 全ページで既定は閉 |
| 営業配置の突き合わせ | 全ターン一致（不一致表示なし） |
| Console の詳細 | Inspector 8セクション・Market Summary すべて既定で閉 |
| 既存画面の回帰 | Overview / Bottleneck / AI Trace すべて描画 |
| `pageerror` | 0件 |

---

## 10. 実装していないこと（正直な残り）

- Sales Capacity / Hiring Diagnostics の専用画面（営業工数換算能力の内訳）
- 工場別オペレーション詳細、投資回収、PL/BS/CF 明細、Scenario イベント
- xlsx exporter（analytics layer は long-format のまま流し込める形にしてある）
- 限界利益の `Contribution $/kg`（数量ベースの単価。現行レポートは金額と比率のみを持つため、
  数量で割る独自計算を追加しないという判断で見送った。金額は数値表で確認できる）
