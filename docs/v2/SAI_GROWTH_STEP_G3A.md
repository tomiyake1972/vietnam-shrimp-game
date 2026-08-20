# ShrimpX V2 — SAI-GROW-3A: Adaptive Growth Step

**前提**: SAI-GROW-2（commit `8f0e2cd`）。**base integration**: `0400c4a`（本作業開始時点の
current integration HEADも `0400c4a` で、GROW-2以降にintegration側の変更は無い）。
**今回変更した唯一の判断**: Commercial Ambition の **1四半期の伸び幅上限（step limit）に
掛ける倍率**のみ。Sales Hiring / Production / Procurement / Labor / CAPEX / Finance /
Dividend / Scenario / Market Engine / Sales Capacity Engine / TSV / 正式Vision値は無変更。
VISION_ON_TRACK・MARKET_WEAK の early return も変更していない。

---

## 1. Adaptive Growth Step の式

```
baseStepLimit      = maxStepRatioByAmbition{HIGH .12 / MEDIUM .07 / LOW .03}
                   × stepIntensityByPressure{LOW 0 / MODERATE .5 / HIGH .8 / URGENT 1}
growthEvidenceMultiplier = 1 + (maxGrowthStepMultiplier − 1) × growthStepExpansionRatio
effectiveStepLimit = baseStepLimit × growthEvidenceMultiplier
stepped            = baseline × (1 + effectiveStepLimit)
ambition           = min(stepped, visionCeiling, realisticOpportunity)   ← 構造は無変更
```

**growthStepExpansionRatio は GROW-2 の `shareExpansionRatio` をそのまま再利用**している
（新しい閾値体系を増やさないため）。その合成内容は:

```
rawExpansion(Growth Pressure score) × conversionFeedback × marginFeedback
× inventoryFeedback × valueOrientationGate(VALUE_FIRSTのみ) × financialDisciplineGate(riskTolerance別)
```

したがって Growth Pressure LOW / 機会なし / 成約悪化 / 採算悪化 / 在庫過剰 / crisis /
finance distress のいずれでも倍率は 1.0（＝**現行step limitと完全同一**）になる。

## 2. maxGrowthStepMultiplier の候補比較（DS1/DS2 × 3seed）

DS2・3seed合計の実測（desired合計 / 最大desired / distress / 平均margin / 期末FG）:

| 会社 | mult=1 | mult=2 | **mult=3（採用）** | mult=5 |
|---|---|---|---|---|
| MASS | 2,084,496 / 40,550 / 11 / 13.7% / 4,626 | 2,115,501 / 40,527 / 10 / 13.8% | **2,129,719 / 40,416 / 8 / 14.2% / 2,625** | 2,148,563 / 40,562 / 4 / 16.2% / 4,934 |
| JPQ | 1,842,582 / 28,292 / 7 / 15.9% | 1,864,844 / 28,312 / 4 / 16.1% | **1,866,081 / 28,313 / 4 / 16.2%** | 1,908,495 / 28,313 / 1 / 16.5% |
| BAL | 1,862,809 / 27,367 / 12 / 14.2% | 1,864,031 / 27,367 / 12 / 13.9% | **1,862,338 / 26,532 / 12 / 14.0%** | 1,881,558 / 29,248 / 12 / 14.0% |
| CONSV | 1,765,834 / 27,440 / **2** / 17.3% | 1,733,571 / 30,088 / 3 / 17.5% | **1,761,639 / 30,056 / 3 / 17.3%** | 1,775,098 / 27,440 / **7** / **16.7%** |
| VAP | 1,663,775 / 26,840 / 12 / 14.5% | 1,663,791 / 26,840 / 12 | **1,666,506 / 27,120 / 12 / 14.6%** | 1,666,169 / 27,120 / 12 / 14.5% |

**採用値 = 3.0**。理由:
- MASS・JPQ で desired と margin が改善し、distress が減る（MASS 11→8、JPQ 7→4）。
- mult=5 は MASS/JPQ をさらに伸ばすが、**CONSV の distress が 2→7 に悪化し margin も
  17.3%→16.7% へ低下**する（財務規律の会社が過剰に取りに行く）。§CONSV protection に反する。
- zero production は全候補で 0。FG は mult=3 が最も低い（MASS 4,626→2,625）。

## 3. 実際に発火した倍率（会社差・DS2 3seed）

| 会社 | step拡大が起きたturn | 拡大時の平均倍率 |
|---|---|---|
| MASS | 55/96 | **1.35** |
| JPQ | 44/96 | 1.24 |
| BAL | 58/96 | 1.15 |
| CONSV | 45/96 | 1.13 |
| VAP | **11/96** | **1.03** |

会社別のhardcodeは無い。差は growthAmbition（ambitionSensitivity）・strategicPosture
（VALUE_FIRST）・financialRiskTolerance（規律ゲート）だけから生じている。
上限3.0に対して実際は1.03〜1.35しか出ていない＝**evidenceの強さ自体が律速**である。

## 4. step limitを解いた後に何が成長を止めているか（DS2 3seed・96 turn-obs）

| 会社 | ambition limiter（GROW-3A適用後） | commitment limiter |
|---|---|---|
| MASS | STEP_LIMIT=36 / **MARKET_WEAK=35** / VISION_ON_TRACK=15 / INVENTORY_EXCESS=7 | NONE=47 / **MARKET_OPPORTUNITY=29** / SALES_CAPACITY=12 |
| BAL | STEP_LIMIT=42 / MARKET_WEAK=29 / VISION_ON_TRACK=18 | NONE=60 / CRISIS=12 / SALES_CAPACITY=10 / MARKET_OPPORTUNITY=10 |
| JPQ | STEP_LIMIT=39 / **VISION_ON_TRACK=28** / MARKET_WEAK=16 | NONE=66 / MARKET_OPPORTUNITY=15 |
| CONSV | STEP_LIMIT=49 / **VISION_ON_TRACK=44** | NONE=79 / MARKET_OPPORTUNITY=14 |
| VAP | **VISION_ON_TRACK=84** / STEP_LIMIT=12 | NONE=71 / CRISIS=12 / MARKET_OPPORTUNITY=12 |

- STEP_LIMITは依然として最多だが、**もはや「固定+12%」ではなく「evidenceが弱いから
  倍率が1.1〜1.35止まり」という意味**に変わっている。
- 次の主要limiterは **VISION_ON_TRACK / MARKET_WEAK**（VAP 84/96、CONSV 44/96、JPQ 28/96、
  MASS 35/96）。MASS T24/T32 では baseline 41,960 に対し
  `min(visionCeiling, realisticOpportunity)` が 27,270 / 20,278 まで下がっており、
  **自社規模が観測可能な市場機会を上回っている**。
- Sales Capacity は BAL 4→10、MASS 6→12（/96）へ増えたが支配的ではない。
- MASS のみ engine cap 診断 12/96（DS1では24/96）。

## 5. Diagnostics（実装指示の必須項目）

`diagnostics.growthPressure` に以下を出力:
`baseStepLimit` / `effectiveStepLimit` / `growthEvidenceMultiplier` /
`growthStepExpansionRatio` / `score` / `observableOpportunityHeadroomRatio` /
`conversionFeedback` / `marginFeedback` / `inventoryFeedback` / `crisisBrake` /
`financeBrake` / `ambitionBeforeStepLimit` / `ambitionAfterStepLimit` /
`incrementalDesiredSalesFromAdaptiveStep` / `ambitionLimiter`
reasonCode: `GROWTH_STEP_LIMIT_EXPANDED` / `GROWTH_STEP_LIMIT_BINDING`

## 6. GROW-3Bへの申し送り

1. **Sales Hiring先行許容（当初GROW-3スコープ）は依然として保留が妥当**。
   submissionは今もSTEP_LIMIT（＝evidence不足）とVISION/MARKET_WEAKで止まっており、
   営業だけ増やすと余剰になる。ただしSALES_CAPACITY bindingがBAL/MASSで倍増した
   （4→10 / 6→12）ため、GROW-3B時点では再測定が必要。
2. **次に解くべきはVISION_ON_TRACK / MARKET_WEAK の early return**（Stop Condition I）。
   現状 VAP は 84/96、CONSV は 44/96 がここで止まっており、step側をこれ以上開けても動かない。
3. DS2ではT24以降、観測採算需要（55k前後）が上位企業の自社規模（42k）に近く、
   **Scenario側の機会不足**が効き始めている。DS3投入後に再測定が必要。
