# 市場需要観測の Standard AI への接続

Batch 002。設計の全体像は `docs/v2/design/MARKET_INFORMATION_LAG_DESIGN.md` を参照。

## 1. 接続経路

```
sales/runner.ts  advanceSalesQuarter
  → MarketProductAllocationResult.targetDemand（既に保存済み）
  → CompanyLabState.history[].salesRecord.allocations
      ↓ 2四半期lagで読み出し（新規: marketDemandObservation.ts）
  → PublicMarketInfo.observedMarketDemand
      ├─→ プレイヤー画面（ObservedMarketDemandPanel）
      └─→ StandardAiObservation.markets[].observedDemandByProduct
              ↓
          decision/sales.ts  buildMarketOpportunityWeights
```

両者は**同一のオブジェクト**から分岐するため、片方だけが違う値を見ることは構造上あり得ない。

## 2. Sales decision の旧ロジックと新ロジック

### 旧（Batch 002以前）

```ts
const markets = pressures.marketPriceRanking;          // 前期参照価格の合計だけで降順ソート
markets.forEach((market, idx) => {
  const weight = idx === 0 ? 0.5 : 0.5 / (markets.length - 1 || 1);   // 首位50%、残り均等
  ...
});
```

市場規模を一切参照しない。単価が最高の市場が自動的に「営業力の半分を投じる市場」になる。

### 新（Batch 002）

```ts
opportunityScore[市場][商品]
  = observedDemand[市場][商品] × salesParams.maximumSupplierShare    // 獲得可能需要
  × max(0, referencePrice[市場][商品] − expectedProcessingCost[商品]) // 期待貢献利益

weight[市場] = opportunityScore[市場] / Σ opportunityScore
```

- `maximumSupplierShare` は共有パラメータ参照（AI側に 0.35 を直書きしない）
- 参照売価が未観測（turn1等）のときは貢献利益を中立（1）とし、規模のみで按分する（価格を推測して捏造しない）
- 全市場のスコアが0（どこも採算が合わない）の場合は均等配分へフォールバック（販売をゼロにする判断はここではしない）
- 観測需要が公開されていない場合（旧スナップショット等）は**従来の重みへフォールバック**する（既存挙動を壊さない）
- 市場志向倍率（SAI-5A）の再配分パスは、基礎重みが新しくなっただけでロジックは従来どおり

**hard cap は置いていない。** 特定市場の人数上限・単一市場シェア上限のような恣意的な制限は無く、観測需要が変われば重みも連続的に変わる。

## 3. 情報リーク防止（§13）

Standard AI が参照しないことを構造で保証している項目:

| 禁止項目 | 保証の方法 |
|---|---|
| current true demand | `buildObservedMarketDemand` は `history[length - 2]` より新しい記録を読まない。当期の記録はそもそも history に無い |
| future demand / future shock / future price | `CompanyDecisionProvider` のシグネチャに将来情報が存在しない（引数は fixture / ownState / publicInfo / period / turn の5つのみ） |
| competitors' unpublished decision | `publicInfo` は前四半期までの公開結果のみ。他社の当期計画は渡らない |
| engine internal allocation result before decision | 意思決定は `advanceCompanyLabQuarter` の**前**に生成される |

テスト「3: 当期の真の需要はAIへ漏れない」が、観測値と当期実需要が実際に異なることを確認している。

## 4. 新しい監査ルール

### A15_STALE_MARKET_INFORMATION_OVERREACTION（P2）

連続する四半期で、いずれかの市場の営業人員シェアが25ポイントを超えて動いた場合に発火。2四半期遅れの情報へ毎期フル追随すると、実市場が動いていないのに配置だけが揺れ、営業基盤・顧客関係の蓄積を自ら壊す。

実測: 1,600 company-quarter 中 **10件**。過剰反応は限定的。

### A16_MARKET_SIZE_IGNORED（P1）

観測需要が利用可能なのに、最も人員を置いた市場が観測需要の最大市場ではなく、かつその市場の需要シェアが人員シェアの半分未満の場合に発火。**配線した観測を判断側が実際に使っているか**を検出するためのルール。

実測: **0件**。観測は実際に判断へ効いている。

### A01 の改善

A01 は元々「営業人員シェア ≥ 30% かつ機会シェアの2倍以上 かつ他市場に1,000t超の未充足機会」で発火していた。Batch 002 では発火が 1,550 → **0件**。

## 5. Constraint Chain（§H）

各 company-quarter の primary / secondary ボトルネックを、Standard AI 自身の診断から共通語彙へ写像して記録する（新しい診断ロジックは作らず、既存の診断結果を読み替えるだけ）。

語彙: `MARKET / SALES_FORCE / PRODUCTION_CAPACITY / RAW_MATERIAL / LABOR / CASH / BORROWING / INVENTORY / NONE`

Batch 002 実測（1,600 company-quarter）:

| 主ボトルネック | 件数 |
|---|---|
| LABOR | 730 |
| PRODUCTION_CAPACITY | 354 |
| SALES_FORCE | 325 |
| NONE | 162 |
| INVENTORY | 29 |

主な遷移:

| 遷移 | 回数 |
|---|---|
| SALES_FORCE → LABOR | 73 |
| NONE → LABOR | 39 |
| LABOR → NONE | 36 |
| INVENTORY → SALES_FORCE | 29 |
| LABOR → SALES_FORCE | 23 |
| LABOR → PRODUCTION_CAPACITY | 21 |

**SALES_FORCE → LABOR が最多**であり、営業制約が解けた結果として労働制約が前面に出る「制約の移動」が実際に起きていることを裏づけている。これは A08・A14 の件数変化を解釈するうえで決定的な材料になる（`BATCH_002_RESULTS.md` §A・§F）。
