# ShrimpX V2 — SAI-GROW-2: Observable Opportunity Headroom / Adaptive Opportunity Share

**前提**: SAI-GROW-1（commit `b5cb35e`）。**base integration**: `0400c4a`
**今回Decisionへ接続した範囲**: Commercial Ambition / Commercial Commitment の
**機会share（0.35 / 0.5）のみ**。sales hiring / production / procurement / labor /
CAPEX / finance / dividend / Sales Capacity Engine / Scenario / TSV は無変更。

---

## 1. Opportunity Headroom（非循環化・実装指示§2）

```
currentRelevantScaleTons = max(能力 × salesUtilizationTarget, 前期実績生産)   // = Commercial Ambitionのbaselineと同じ量
orientationWeightedOpportunityTons = Σ_{採算セル} 観測需要 × maximumSupplierShare(0.35) × orientation重み

observableOpportunityHeadroomTons  = max(0, orientationWeightedOpportunityTons − currentRelevantScaleTons)
observableOpportunityHeadroomRatio = headroomTons / currentRelevantScaleTons
opportunitySupport                 = clamp01( headroomRatio / opportunityHeadroomSaturationRatio(4.0) )
```

**なぜ非循環か**: 分母 `currentRelevantScaleTons` は「生産能力 × 稼働率目標」と
「前期の実績生産」だけで決まり、**提出量にも 0.35 / 0.5 にも依存しない**。
GROW-1では分母が `currentSubmissionCeiling`（＝shareの関数）だったため、
shareを動かすと信号が動く循環があった。GROW-2ではshareを動かしてもheadroomは動かない
（テスト GROW2-1 で固定）。

**飽和の解消（GROW-1 Known limitation / Stop Condition A）**:
GROW-1では `opportunitySupport` が全社・全Turnで 1.00 に張り付いていた。
GROW-2では headroomRatio が実測 **0.3〜5.5** の範囲で変動し、支持度も 0.08〜1.00 で動く。

## 2. Orientation-aware opportunity（§3・§4）

`decision/sales.ts::computeOrientationWeightedOpportunity()` を新設。
市場×商品セルごとの観測採算需要に、既存の orientation 倍率
（`marketOrientationMultipliers` × `productOrientationMultipliers`、総合 0.70〜1.35 clamp、
按分側と同一の範囲）を掛けて合計する。新しい市場・商品のhardcodeは作っていない。
倍率が全て1（既定）の場合は重み付けなし＝観測機会そのもの。

**A/B/Cの分離（§3）**: A（市場で観測できる採算需要）だけをOpportunity Signalに使い、
B（AI側の控えめ係数 0.35 / 0.5）とC（現在の提出量）はSignalに再投入していない。

## 3. Adaptive Opportunity Share（§8〜§13・§18〜§20）

```
rawExpansion = clamp01( (score − moderateThreshold 0.08) / (1 − 0.08) )
shareExpansionRatio = rawExpansion
                    × conversionFeedback        // 成約率 0.35→0.75 で 0→1（§11）
                    × marginFeedback            // 期待貢献 0.05→0.20 で 0→1（§12）
                    × inventoryFeedback         // 1 − inventoryBrake（§13）
                    × valueOrientationGate      // VALUE_FIRSTの会社のみ marginSignal を追加適用（§19）
                    × financialDisciplineGate   // (margin×finance×crisis)^k, k = HIGH 0 / MEDIUM 1 / LOW 2（§20）

effectiveAmbitionShare   = 0.35 + (0.60 − 0.35) × shareExpansionRatio
effectiveCommitmentShare = 0.50 + (0.85 − 0.50) × shareExpansionRatio
```

- **Growth Pressure LOW ⇒ shareExpansionRatio = 0 ⇒ 現行値と完全に同一**（§9、テスト GROW2-3）。
- 上限（0.60 / 0.85）は §10 の share ceiling。他社の非公開decisionは一切参照せず、
  自社が観測できる成約率・需要・採算・在庫・財務だけで決まる。
- profile差は既存フィールドのみ（growthAmbition の ambitionSensitivity、
  strategicPosture、financialRiskTolerance）。会社別のVolume値は一切書いていない（§32）。

## 4. 実測結果（DS1/DS2 × 3seed・GROW-1 baseline vs GROW-2）

| Scenario | 会社 | 合計desired | 最大desired | distress | zeroProd | 平均margin | 平均conversion |
|---|---|---|---|---|---|---|---|
| DS2 | BAL | 1,703,105 → 1,704,895 (+0.1%) | 27,367 → 27,367 | 9→9 | 0→0 | 15.9→16.0% | 97→97% |
| DS2 | MASS | 2,070,826 → 2,083,469 (**+0.6%**) | 40,562 → 40,562 | 12→12 | 0→0 | 14.0→14.2% | 98→98% |
| DS2 | JPQ | 1,829,808 → 1,830,218 (+0.0%) | 27,384 → **28,312** | 8→7 | 0→0 | 15.7→15.8% | 97→97% |
| DS2 | VAP | 1,679,005 → 1,679,005 (**+0.0%**) | 27,040 → 27,040 | 7→7 | 0→0 | 15.1→15.1% | 98→98% |
| DS2 | CONSV | 1,688,115 → 1,682,879 (−0.3%) | 27,440 → 27,440 | 5→5 | 0→0 | 17.5→17.5% | 97→97% |
| DS1 | 5社 | いずれも ±0.1% 以内 | 変化なし | 変化なし | 変化なし | ±0.1pt | 変化なし |

**share拡張の会社差（DS2 seed g2-s1・T8/T16/T24/T32のshareExpansionRatio）**

| 会社 | T8 | T16 | T24 | T32 | 解釈 |
|---|---|---|---|---|---|
| MASS | 0.33 | 0.32 | 0.00 | 0.00 | 最も大きく開放。後半は自社規模が市場headroomに追いつきLOWへ |
| JPQ | 0.22 | 0.10 | 0.00 | 0.00 | 中程度 |
| BAL | 0.08 | 0.23 | 0.45 | 0.29 | 標準 |
| CONSV | 0.09 | 0.05 | 0.01 | 0.00 | 財務規律ゲートで小さい（§20） |
| VAP | 0.01 | 0.00 | 0.00 | 0.00 | value志向ゲートでほぼ開かない（§19） |

## 5. 30kt ceiling は破れていない（Stop Condition B）

**理由: binding constraintが移動しただけで、上限自体は別の式が決めている。**

GROW-2適用後の limiter 分布（DS2 seed g2-s1・5社×32Q=160）:

```
Ambition limiter  : STEP_LIMIT=74  VISION_ON_TRACK=56  MARKET_WEAK=25  INVENTORY_EXCESS=4  OPPORTUNITY_CEILING=1
Commitment limiter: NONE=115  CRISIS=18  MARKET_OPPORTUNITY=18  RECENT_CONVERSION=5  SALES_CAPACITY=4
```

GROW-1では Commitment の `MARKET_OPPORTUNITY` が 28/160 だったのが 18/160 へ減り、
Ambition の `OPPORTUNITY_CEILING` は 4→1 へ。**機会capはほぼ外れた**。
代わりに残った上限は次の2つで、いずれも**opportunity-based ceilingではない**ため
GROW-2の変更許可範囲（§15）の外にある。

1. **STEP_LIMIT（74/160）** — `ambition ≤ baseline × (1 + maxStep × intensity)`。
   maxStep は HIGH 0.12 / MEDIUM 0.07 / LOW 0.03、intensity は pressure段階で 0〜1。
   実測: MASS T8 baseline 15,600 → ambition 17,098（+9.6%）。機会は 51,408 あるのに
   1四半期の伸び幅で止まっている。
2. **VISION_ON_TRACK / MARKET_WEAK（81/160）** — `ambition ≤ visionReferenceScale` および
   `realisticOpportunity(= attainable × effectiveShare) ≤ baseline` で据え置き。
   実測: MASS T24/T32 は baseline 41,960 に対し realisticOpportunity 27,009 / 19,025
   （DS2の観測採算需要が自社規模の1.3倍程度しかない）。

## 6. Known limitation / 次の一手

- DS2 の観測採算需要は T32 で 55,407t（5社合計の市場側）に対し MASS 単独の規模が
  41,960t あり、**市場側headroom自体が小さい**。DS3で市場が大きくなれば
  headroom信号は自然に強くなる（GROW-2の式はそのまま使える）。
- GROW-3では、Constraint Routing（COMMERCIAL / PRODUCTION_CAPACITY …）をDecisionへ
  接続すると同時に、**STEP_LIMIT と Vision ceiling の扱い**を決める必要がある。
  現状ではこの2つが実効的な成長速度の上限である。
