# SAI-GROW Volume Scale vs Economic Value Scale PRE-AUDIT

**監査のみ。実装していない。** base: `2244f18`。

## 1. D-1 — 現在の scale 定義の棚卸し

| scale | 単位 | 定義箇所 | 使われている判断 |
|-------|------|---------|-----------------|
| production tons | HOSO換算t/Q | `decision/production.ts` productionPlans | 生産計画・原料逆算・Worker逆算 |
| sales effort tons | HOSO換算t/Q | `decision/sales.ts` realisticSalesByProduct | 販売計画・提出量 |
| HOSO equivalent tons | HOSO換算t | `core/units` 全体 | **すべての規模判断の共通単位** |
| labor workload tons | HOSO換算t（労働集約度で重み付け） | `production/parameters.ts` `labor.laborIntensityCoefficient` = HOSO 1.0 / PD 1.2 / VAP 3.0 | `computeRequiredRegularHeadcount` のみ |
| capacity tons | HOSO換算t/Q | `production/capacity.ts` / `capex/capacityEffect.ts` | binding capacity・deliverable capacity |
| revenue | USD | `finance/quarterClose.ts` profitAndLoss.grossRevenue | **事後の会計のみ** |
| contribution | USD/HOSO換算kg | `decision/sales.ts` `observableOpportunityCell.contributionPerKg` | `weightedContributionUsdPerKg` → **拡大するか否かの閾値判定（0.05）のみ** |
| gross profit / operating profit | USD | `finance/quarterClose.ts` | **事後の会計のみ。意思決定に入らない** |

### 決定的な非対称

**「どれだけ拡大するか」を決める値はすべて HOSO換算トンのスカラーであり、
経済価値（USD）は「拡大するか否か」の boolean 判定にしか入らない。**

* `Commercial Ambition` … トン
* `Commercial Commitment` … トン
* `Deliverable Capacity` … トン
* `Growth Routing`（GROW-3C） … トン
* `Executable Workforce Target`（3C.1） … トン
* `weightedContributionUsdPerKg` … `< minimumContributionUsdPerKg(0.05)` の**閾値判定だけ**
* `orientationWeightedOpportunityTons` … 算出されるが Ambition へ渡らない（3D §12）

労働集約度だけは例外的にトンへ重みが入る（`laborIntensityCoefficient`）が、
それは Worker 逆算の内部だけであり、Ambition / Commitment / Routing のトン数には反映されない。

## 2. D-2 — 同じ 10kt の Growth が商品別にどう違うか（既存parameterのみ）

DS3 seed ds3-a T24 の実測参照価格・加工費。`regularEfficiencyPerHeadTons = 6`、
`laborIntensityCoefficient = { hoso: 1, pd: 1.2, vap: 3 }`。

| 商品 | 必要Worker /10kt | 参照価格 USD/kg | 加工費 USD/kg | 貢献 USD/kg | 貢献 /10kt | 貢献 / Worker |
|------|-----------------:|----------------:|--------------:|------------:|-----------:|--------------:|
| HOSO | 1,667 | 5.40 | 0.62 | **4.78** | 47.8M USD | 28,702 USD |
| PD | 2,000 | 6.44 | 0.78 | **5.66** | 56.6M USD | 28,282 USD |
| VAP | **5,000** | 10.90 | 1.00 | **9.90** | **99.0M USD** | **19,806 USD** |

### CAPEX 単価（`capex/parameters.ts` の futureCapacityEffect）

| 案件 | 予算 | 追加能力 | **USD / 追加t（/Q）** |
|------|-----:|---------:|----------------------:|
| hosoLineExpansion | 8.0M | +4,000 t/Q | **2,000** |
| pdLineExpansion | 4.0M | +350 t/Q | **11,429**（HOSO の 5.7倍） |
| vapLineExpansion | 6.0M | +250 t/Q | **24,000**（HOSO の **12倍**） |
| commonProcessingExpansion | 5.0M | +1,250 t/Q | 4,000 |
| newFactoryConstruction | 22.0M | 商品別ライン一式 | — |

### CAPEX 1M USD あたりの貢献（＝投資効率）

| 商品 | 追加能力 /1M | 貢献 /Q |
|------|-------------:|--------:|
| HOSO | 500 t | **2.39M USD** |
| PD | 87.5 t | 0.50M USD |
| VAP | 41.7 t | 0.41M USD |

**HOSO は VAP の約 5.8倍、投資効率が高い。**

## 3. 所見

### 3.1 volume と value の混同は実在する

VAP 10kt は HOSO 10kt の **2.07倍の貢献**を生む。
しかし Ambition・Commitment・Deliverable Capacity・Routing はすべてトンで測るため、
VAP が「30kt の会社」として BAL の「44kt の会社」より小さく扱われる。
経済価値で見れば VAP 30kt（≈297M USD/Q の貢献ポテンシャル）は
BAL 44kt（≈210M USD/Q）より**大きい**。

### 3.2 ただし「VAPを伸ばすべき」とは即断できない

CAPEX 単価が HOSO の 12倍、Worker が 3倍であるため、
**投資効率（貢献/CAPEX）では HOSO が VAP の 5.8倍**である。
つまり現行パラメータ下では

* **トンで測ると VAP は不当に小さく見える**（value を無視している）
* **USD/CAPEX で測ると VAP の量的拡大は実際に不利**（value を入れても結論は変わらない）

の両方が同時に成り立つ。VAP の Vision が 17kt と小さいことは、
`vapLineExpansion` の単価（24,000 USD/t）を前提とすれば**経済的に整合している**可能性がある。
VAP を 45–55kt へ伸ばすには、トン当たり CAPEX が HOSO の 12倍必要になる。

これは Standard AI の欠陥ではなく **scenario / capex parameter の設計判断**である。
「VAPを45–55ktにしたい」のであれば、Vision ではなく
`vapLineExpansion` の予算対能力比、または VAP の価格前提を見直す必要がある。

### 3.3 単一スカラーへまとめてはいけない

貢献/トンで重み付けした「価値換算トン」を1つ作ると、
VAP 会社の Ambition が 2.07倍に見え、**CAPEX 12倍という制約が隠れる**。
逆にトンのままだと value が見えない。**どちらの単一スカラーも誤誘導する。**

## 4. D-3 — 将来案（実装しない。設計案のみ）

### 推奨: 2軸を**別diagnostic**として持ち、単一スカラーへまとめない

```
StrategicGrowthOpportunity {
  volume:  { headroomTons, bindingConstraint }          ← 現行の延長（トン）
  value:   { headroomContributionUsd, contributionPerTonUsd }
  cost:    { capexUsdPerAddedTon, workerPerAddedTon }   ← 拡大の「値段」
}
```

判断ルールの案（いずれも既存値のみで算出可能）:

| 診断 | 式（既存値のみ） | 用途 |
|------|-----------------|------|
| volume headroom | 現行 `deliverabilityGrowthGapTons`（GROW-3C） | 何トン足りないか |
| value headroom | `Σ cell.attainableDemand × cell.contributionPerKg − 現在の貢献` | いくら儲け損ねているか |
| growth cost | `capex/parameters.ts` の `standardBudgetUsd / capacityIncreaseTonsPerQuarter`、`laborIntensityCoefficient` | 1トン増やす値段 |
| routing 優先度 | `value headroom / growth cost`（＝投資効率） | どの商品から増やすか |

**利点**: 現行の GROW-3C routing に「どの商品ラインへ投資すべきか」を
経済効率で並べる根拠を与えられる（現在は志の商品構成比で配っているだけ）。

**注意**: `contributionPerKg` は前四半期の公開参照価格由来であり将来価格ではない。
value 軸を導入しても「未来を知らない」原則は保てる。

## 5. 報告事項（volume/value 混同が実害を出している箇所）

1. `computeCommercialAmbition` が `attainableProfitableTons`（トン）だけを ceiling に使い、
   `weightedContributionUsdPerKg` を閾値判定にしか使っていない（`commercialAmbition.ts` L174-179）。
2. `orientationWeightedOpportunityTons` が算出されるのに Ambition へ渡らない
   （`policy.ts` L463-468 → `growthCore` のみ）。しかも現行パラメータでは
   `attainableProfitableTons` と完全一致するため、渡しても差は出ない（MASS監査 §3）。
3. `growthRouting.routedGrowthByProduct` が志の商品構成比でトンを配るだけで、
   商品別の CAPEX 単価（HOSO 2,000 / PD 11,429 / VAP 24,000 USD/t）を見ていない。
   **VAP偏重の会社に vapLineExpansion を提案すると、同じ金額で HOSO の 1/12 の能力しか買えない。**
