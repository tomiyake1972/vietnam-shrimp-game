# ShrimpX V2 消費国在庫・購買循環モデル Phase 8F-1（v0.1）

`feature/v2-consumer-market-inventory` ブランチ（`origin/develop/v2` HEAD `0c22d37` から分岐）で実装した、消費市場（CN/US/EU/JP/OTHER）ごとに「最終消費 → 消費国在庫 → 輸入・購買」の3層を分離するモデル（`app/lib/v2/market/consumerInventory.ts`）の設計記録。

## 1. このPhaseが解決する問題

Phase 8F-1以前、市場別「需要」は実質的に「購買量」であり、最終消費・在庫・購買という3つの異なる概念が1本の数字に混同されていた。現実の水産物輸入では、消費（実際に食べられる量）はゆっくり動く一方、購買（輸入業者の発注）は在庫水準・価格に反応して消費より先に・より大きく動く。この違いを表現できないと、「なぜ消費が横ばいなのに輸入だけ急増/急減するのか」という現実の市況変動（積み増し・在庫調整サイクル）を再現できない。

本Phaseは、既存の産地間競争由来のHOSO/PD/VAP国際価格形成（`market/hosoPricing.ts`・`market/productPremium.ts`・`market/globalDemand.ts`）を一切変更せず、その**上位**に消費国側の在庫・購買循環層を追加する。

```
産地間競争（既存、変更なし）→ ベトナム産地の商品別基準価格・仕向市場参照価格（Phase 8P-0A、既存）
                                          ↓
                  消費国在庫・購買循環モデル（本Phaseで追加。市場別の最終消費・在庫・希望購買を計算）
                                          ↓
        希望購買量（市場別ウェイト）→ sales/marketAdapter.ts の対象需要按分へ接続（二重計上の解消）
                                          ↓
        実購買・在庫確定 → 購買圧力・在庫逼迫度 → 翌四半期の仕向市場価格係数（動的化）
```

## 2. 状態モデルと計算の分離（planning／settlement）

会社別の実際の成約量（`actualPurchaseTons`）は、営業配分（水位法 `waterFillAllocate`）が終わるまで確定しない。そこで本モジュールは計算を2段階に分離した。

- `planConsumerMarketQuarter`（実購買量が未確定でも呼べる）: 当四半期の最終消費・目標在庫・希望購買量・購買圧力指数を計算する。
- `settleConsumerMarketQuarter`（実購買量確定後に呼ぶ）: 在庫恒等式を守って期末在庫・実消費・在庫逼迫度・市場局面（`marketPhase`）を確定する。

これにより、「希望購買量→会社別按分→世界市場清算→実購買量確定→在庫更新」という一方向の依存関係になり、同一四半期内の連立方程式を解く必要がない。

## 3. 四半期をまたいで保持する状態（`ConsumerMarketCarryState`）

派生値（目標在庫・希望購買量・局面等）は一切保存せず、毎期この最小限の状態から再計算する。

- `openingInventoryTons`: 前四半期末の在庫（＝当四半期の期首在庫）
- `priorConsumptionTons`: 前四半期の実現消費量（消費成長率算出の基礎）
- `priceHistoryUsdPerHosoEqKg`: 直近の市場参照価格履歴（最大3件、古い順）

初期状態は `buildInitialConsumerMarketCarryState` が、初期の期待消費量（`priorPeriodConsumption`）と目標在庫月数から決定論的に導出する（`初期在庫 = 初期消費 × 目標在庫月数 / 3`）。ゲーム開始直後に大規模な在庫調整が起きないよう、目標付近から開始する設計（実装指示§13）。

## 4. 計算式

### 4.1 最終消費（`planConsumerMarketQuarter` 内 §1）

```
laggedPrice = priceHistory[長さ-1-consumptionPriceLagQuarters]（1〜2四半期前の価格。無ければ平常価格）
laggedDeviation = (laggedPrice - 平常価格) / 平常価格
laggedPriceFactor = max(0, 1 + consumptionPriceElasticity × laggedDeviation)

plannedConsumption = 前期消費実績
                    × max(0, economicIndex)                 … 景気
                    × 季節係数（四半期番号ごと）
                    × laggedPriceFactor                       … 遅行価格効果
                    × demandShockFactor                       … シナリオ入力の需要ショック（既定1）
                    × max(0, 1 + populationGrowthRate)        … 人口成長

consumptionGrowthRate = (plannedConsumption - 前期消費実績) / 前期消費実績
```

消費は**遅行価格**（1〜2四半期前）にのみ反応する。これが「購買は消費より先に動く」という要件の裏側（消費は意図的に遅らせる）。

### 4.2 目標在庫（`planConsumerMarketQuarter` §2）

```
currentDeviation = (currentPrice - 平常価格) / 平常価格   … currentPrice = priceHistoryの最新値（前四半期に確定した価格）
cheapnessSignal  = max(0, -currentDeviation)              … 割安なほど正
sustainedDecline = sustainedDeclineDampingFactor（直近2四半期とも価格が平常より安く、かつ下落継続中の場合のみ）／それ以外は1

targetCoverageMonths = clamp(
  (targetCoverageMonthsBase + supplyRiskCoverageMonthsAddOn)
    × (1 + restockingSensitivity × max(0, consumptionGrowthRate))     … 消費成長→積み増し
    × (1 + discountRestockingSensitivity × cheapnessSignal)           … 割安→積み増し意欲
    × carryingCostDampingFactor                                      … 金利・保管費による減衰
    × sustainedDecline,                                               … 際限ない買い急ぎの抑制
  targetCoverageMonthsMin, targetCoverageMonthsMax
)

targetInventoryTons = max(0, plannedConsumption × targetCoverageMonths / 3)
```

### 4.3 希望購買量（`planConsumerMarketQuarter` §3）

```
inventoryGapRatio      = (targetInventory - openingInventory) / targetInventory
inventoryAdjustmentTons = inventoryAdjustmentSpeed × (targetInventory - openingInventory)   … 符号付き。過剰在庫時は負

shortTermPriceReactivity = purchasePriceElasticity × max(0, -currentDeviation)              … 当期価格に「即時」反応（消費と異なりラグ無し）

desiredPurchase = clamp(
  plannedConsumption + inventoryAdjustmentTons + shortTermPriceReactivity × plannedConsumption,
  desiredPurchaseMinRatioOfConsumption × plannedConsumption,
  desiredPurchaseMaxRatioOfConsumption × plannedConsumption
)

purchasePressureIndex = (desiredPurchase - plannedConsumption) / plannedConsumption
```

`inventoryAdjustmentTons` は在庫調整のたった1四半期分（`inventoryAdjustmentSpeed`、市場ごとに0.3〜0.55）だけを反映し、全量を1四半期で埋め合わせない（実装指示§8の明示的な要件）。

### 4.4 実購買量（VN＋非VN原産国の合算。`computeActualPurchaseByMarket`）

```
非VN原産国（EC/IN/ID）ごとの世界配分需要・輸出可能供給量を合計し、
VNと同じ市場別ウェイト（希望購買量の構成比）で市場別に按分したうえで、
各国自身の輸出可能供給量で頭打ちする。

市場別実購買 = VN実購買（5社の実際の成約配分。既に処理能力・営業体制の制約を反映済み）
             + min(非VN配分需要 × ウェイト, 非VN輸出可能供給 × ウェイト)

さらに、実購買量は希望購買量を上回らない（希望購買量自体がその四半期の
上限的な意思決定であるため。企業配分・非VN按分の丸め誤差の吸収も兼ねる）。
```

既存モデルには「原産国×消費市場」の内訳が存在しないため、新たに複雑な原産国別・市場別シェアモデルを作る代わりに、VNの按分と同じ市場別ウェイトを使うという最小限の仮定を置いている（監査結果§5・実装指示§9への対応）。この仮定により「世界供給が不足すれば実購買量が希望購買量を下回る」という要件を、既存の`exportableSupply`（新規追加ではない既存値）だけで満たせる。

### 4.5 決算（`settleConsumerMarketQuarter`。在庫恒等式）

```
availableForConsumption = openingInventory + actualPurchase
realizedConsumption     = min(plannedConsumption, availableForConsumption)   … 供給不足なら消費が縮小
endingInventory          = max(0, availableForConsumption - realizedConsumption)

inventoryTightnessIndex = clamp((targetInventory - endingInventory) / targetInventory, -1, 1)
inventoryCoverageMonths = endingInventory × 3 / realizedConsumption
```

未充足の消費需要は**繰り越さず失われた需要として扱う**（実装指示§10）。在庫は`max(0, …)`により常に非負であることが構造的に保証される。

`marketPhase`（`restocking`/`balanced`/`destocking`/`tight`）は、`inventoryCoverageMonths < targetCoverageMonths × tightCoverageRatio` なら`tight`、それ以外は`purchasePressureIndex`の符号・しきい値超過で`restocking`/`destocking`/`balanced`を判定する。

## 5. 価格形成への接続（二重計上の回避）

購買圧力・在庫逼迫度は**当四半期の価格には反映しない**。当四半期の購買はすでに確定した前四半期の価格（`currentPrice`）に反応しているため、同一四半期内で「価格が購買を動かし、購買が同じ価格を動かす」循環参照になることを避けるためである。

```
adjustmentRatioRaw = purchasePressurePriceWeight × clamp(purchasePressureIndex, ±purchasePressureClampForPricing)
                    + inventoryTightnessPriceWeight × inventoryTightnessIndex     … 主因は購買圧力、在庫逼迫度は補助的（重みを小さく）
adjustmentRatio    = clamp(adjustmentRatioRaw, ±maxQuarterlyPriceAdjustmentRatio)

次四半期のbaseValueCoefficient = 静的な基準係数（destinationPricingParameters.ts） × (1 + adjustmentRatio)
```

**重要**: 調整は毎四半期、静的な基準係数に対して新規に計算し直す（前四半期の調整後係数に重ねてさらに調整する「複利」にはしない）。これにより、市場ごとの価格乖離が構造的に有界（`maxQuarterlyPriceAdjustmentRatio`、市場ごとに6〜9%）に保たれ、発散しない。

`purchasePressurePriceWeight`（0.4〜0.55）を`inventoryTightnessPriceWeight`（0.12〜0.18）より大きく設定することで、「購買圧力が主要因、在庫逼迫度は補助的」という要件（実装指示§11。両者は同じ在庫循環モデルから導かれるため、単純合算すると二重計上になる懸念があった）を、重み付けの差で表現している。

## 6. 市場別の性格づけ（実装指示§12）

全市場で共通の計算式・共通のパラメータ構造を使い、市場ごとに異なるのは`CONSUMER_MARKET_INVENTORY_PARAMETERS_V1`の係数値のみ（市場別にロジックを分岐・複製している箇所はない）。

| 市場 | 性格 | 主な反映先 |
|---|---|---|
| US | 景気・価格・販促への反応が大きい。安値での積み増し・在庫調整も大きい | `purchasePriceElasticity=0.6`・`discountRestockingSensitivity=1.2`・`inventoryAdjustmentSpeed=0.45` を高めに |
| JP | 消費変化が緩やか、計画的に多めの在庫を持つ。在庫調整も穏やか | `consumptionPriceElasticity=-0.15`・`inventoryAdjustmentSpeed=0.3` を低めに、`targetCoverageMonthsBase=3.2` を高めに |
| CN | 価格感応度・季節性が高い。買い急ぎ・買い控えの振幅が大きい | `purchasePriceElasticity=0.8`・`restockingSensitivity=2.2`・季節係数の振れ幅を大きめに |
| EU | 金利・保管費を意識し慎重 | `carryingCostDampingFactor=0.75` を低めに（在庫意欲を強く減衰） |
| OTHER | 上記4市場の平均的な性格（残余市場） | 中庸値 |

具体的な数値は32四半期シミュレーションを見ながら設定した暫定値であり、今後の校正対象（コメントに明記済み）。

## 7. companyLabへの配線順序（`companyLab/runner.ts` `advanceCompanyLabQuarter`）

```
1. marketInput確定後、planConsumerMarketQuarterTable で市場別・希望購買量等を計画
2. deriveMarketWeightsFromDesiredPurchase で市場別ウェイトを導出
3. 前四半期のconsumerMarketRecordsがあれば deriveNextQuarterDestinationPriceCoefficients で
   当期の仕向市場価格係数（動的）を算出。無ければ静的な基準係数をそのまま使う
4. turnInput に marketWeights・parameters.destinationMarketPricing として渡す
   （sales/marketAdapter.ts の deriveTargetDemand・deriveVietnamMarketReferencePricesへ接続）
5. runTurn（既存の会社別成約配分等）を実行
6. VN実購買（成約配分の実績から市場別に集計）＋非VN原産国の按分 から
   computeActualPurchaseByMarket で市場別実購買量を確定
7. settleConsumerMarketQuarter で在庫・局面を確定 → consumerMarketRecords
8. rollCarryStateForward で次四半期のcarry state（在庫・前期消費・価格履歴）を更新
```

`advanceSalesQuarter`の既存の4番目の引数（`destinationMarketPriceCoefficients`。Phase 8P-0Aで既に存在）をそのまま再利用しており、`TurnOrchestratorParameters`に新しい引数スロットは追加していない。

## 8. 永続化・後方互換性

`CompanyLabState.consumerMarketState`（`ConsumerMarketCarryStateTable`）を新規の永続状態として追加し、`CURRENT_COMPANY_LAB_PERSISTED_STATE_VERSION`を2→3へ加算的に更新した（既存のPhase 8D-4 `workforceState`と全く同じ「キー有無ベースの既定値補完」パターン）。

- Phase 8F-1より前に保存されたデータには`consumerMarketState`キー自体が存在しない。`schema.ts`の`validateConsumerMarketState`はキーが無い場合、全市場ゼロ値の状態を返す。
- `isConsumerMarketStateEmpty`がこの「全市場ゼロ値」を検知すると、`restoreCompanyLabStateFromRuntimeSnapshot`が確定履歴の直近四半期の`demandMarkets`入力から`buildInitialConsumerMarketCarryStateTable`で決定論的に再構築する（推測値を作らない）。履歴が一切無い場合のみ、全市場需要ゼロのフォールバック初期値を使う。
- 同一seed・同一入力なら常に同じ結果になる（決定論性はテストで確認済み）。

## 9. 二重計上の防止（監査で判明した箇所への対応）

二重計上が実際に起きていたのは`sales/marketAdapter.ts`の`deriveTargetDemand`（市場別の対象需要を、静的な「前期消費量」の構成比だけで按分していた箇所）。本モジュールが計算する`desiredPurchaseTons`の構成比（`deriveMarketWeightsFromDesiredPurchase`）が、その唯一の入れ替え先になる。`marketWeights`が渡されない場合（後方互換）は既存の前期消費ベース按分にフォールバックする。

価格形成側では、購買圧力指数と在庫逼迫度の両方が同じ在庫循環モデルから導かれるため、両方を等しい重みで単純合算すると同じ現象を二重に価格へ反映してしまう懸念があった。§5の通り、購買圧力を主要因（重み大）・在庫逼迫度を補助的（重み小）として扱うことで、この懸念を回避している。

## 10. スコープ外（Phase 8F-1で意図的に扱わない範囲）

- 商品別（HOSO/PD/VAP）・サイズ別・原産国別・顧客別の在庫細分化（実装指示§4。市場別・全商品合計のみ）
- 供給不安指標の新規開発（`supplyRiskCoverageMonthsAddOn`は市場別の中立〜小さな固定値。架空の指標は作らない）
- 金利指標の新規開発（`carryingCostDampingFactor`も市場別定数）
- `market/globalDemand.ts`・`hosoPricing.ts`・`productPremium.ts`（原産国側の国際価格形成）の変更
