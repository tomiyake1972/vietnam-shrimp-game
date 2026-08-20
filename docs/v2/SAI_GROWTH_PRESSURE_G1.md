# ShrimpX V2 — SAI-GROW-1: Shadow Growth Pressure / Constraint Routing

**種別**: Standard AI 診断層の新設（**Decisionには一切接続しない Shadow**）
**前段監査**: `docs/v2/SAI_GROWTH_EXPANSION_DIV5_AUDIT.md`（commit `0d851b5`）
**base integration**: `origin/integration/v2-current-20260818` HEAD `0400c4a`

---

## 1. Architecture

```
policy.ts :: generateStandardAiDecisionWithDiagnostics()
  ├─ 既存の全意思決定（販売・生産・調達・労働・財務・CAPEX・営業採用・配当）… 変更なし
  │     ↓ すべて確定した後で
  └─ assessGrowthPressure()  ← standardAi/growth/growthPressure.ts（純粋関数）
        └─ diagnostics.growthPressure に格納（decision には現れない）
```

**Decisionへ影響し得ない構造的理由**: Growth Pressureの評価は、すべての意思決定が
確定した**後**に、確定済みの値だけを入力として1回だけ呼ばれる。評価より上流のコードは
この結果を参照しない。したがって「Shadowを外すとDecisionが変わる」ことは構造上起こらない
（テスト SAI-GROW-18/19/20 で固定）。

| ファイル | 役割 |
|---|---|
| `standardAi/growth/types.ts` | `GrowthPressureAssessment` / `GrowthConstraintCategory` / `GrowthPressureDestination` |
| `standardAi/growth/growthPressure.ts` | パラメータと `assessGrowthPressure()`（純粋関数） |
| `standardAi/growth/index.ts` | 公開API |
| `standardAi/reasonCodes.ts` | Growth系reason codeを既存の語彙へ追加（型・一覧の両方） |
| `standardAi/policy.ts` | 診断への配線のみ（`diagnostics.growthPressure`） |
| `scripts/saiGrow1Benchmark.ts` | DS1/DS2 × 3seed のShadowベンチマーク／候補Vision sweep |

---

## 2. Formula（実装指示§31: 巨大な多変量scoreにしない）

```
currentRelevantScale = commercialAmbition.baselineTons            // = max(能力×0.8, 前期実績生産)
strategicScaleGapRatio = clamp01( (visionRef − currentRelevantScale) / visionRef )

observedOpportunityTons      = attainableProfitableTons           // Σ 採算セル観測需要 × maximumSupplierShare(0.35)
currentSubmissionCeilingTons = commercialCommitment.submissionTargetTons
observableOpportunityRatio   = observedOpportunityTons / max(currentSubmissionCeilingTons, ε)
opportunitySupport           = clamp01( (ratio − 1) / (opportunitySupportSaturationRatio(2.0) − 1) )

core = strategicScaleGapRatio × opportunitySupport                 ← 中心の2項はこれだけ

modifierSum = 0.10×conversionSignal + 0.10×forwardDemandSignal
            + 0.05×marketLifecycleSignal − 0.10×supplyPressureBrake

baseScore = clamp01( core × (1 + modifierSum) )
          × marginSignal × (1 − inventoryBrake) × crisisGate × financeGate

score = clamp01( baseScore × profileSensitivity )                   // profileSensitivity = 既存 ambitionSensitivity
level = score ≥ 0.50 → URGENT / ≥ 0.25 → HIGH / ≥ 0.08 → MODERATE / それ以外 LOW
```

**modifierを加算ではなく乗算にした理由**: 加算にすると、Vision gapが無い（志に追いついた）
会社や市場機会が無い会社でも「成約率が良い」だけで圧力が発生してしまう。成長圧力の定義
（§3）は「Visionまで余地があり、**かつ**市場機会があるとき」なので、中心項が0なら圧力も0に
なる形にした（テスト SAI-GROW-2 が固定）。

---

## 3. Inputs（すべて observable / 既存診断の再利用）

| 入力 | 出所 | 備考 |
|---|---|---|
| `visionReferenceScaleTons` | `strategicGrowth.visionTargetScaleAtCurrentTurn` | **数値で受け取る**＝候補Visionへの差し替え（§30 sweep）が可能 |
| `commercialAmbition.baselineTons` | `vision/commercialAmbition.ts` | 現在規模の定義を既存と一致させる（§6。独自指標を作らない） |
| `commercialCommitment.submissionTargetTons` | `vision/commercialCommitment.ts` | 「現在この会社が取りに行っている量」 |
| `attainableProfitableTons` ほか | `decision/sales.ts::computeObservableCommercialOpportunity` | 2四半期遅行の公開需要のみ |
| `observedConversionRatio` | `commercialHistory.ts::observeContractConversion` | |
| `contracts` | `ownState.contracts` | Healthy Forward Backlogの分離に使用 |
| `finishedGoodsExcessRatioByProduct` | `pressures.ts` | 商品別。最大値でbrakeを判定 |
| `crisisState` | `crisisState.ts` | |
| `lastQuarterFinancialHealthTier` | `observation` | 新しいcredit modelは作らない |
| `unservedOpportunity` | `vision/unservedOpportunity.ts` | Constraint Routingの一次情報 |
| `salesHiringZeroReason` | `decision/salesForceHiring.ts` | 営業deadlock診断（§21） |
| `observation.lifecycleTrendByMarket` / `productSupplyPressureByProduct` | 公開情報 | |

**取れない／使わないもの**: ScenarioDefinitionの未公開将来イベント（T25 Ecuador・T29 India 等）、
TRUE需要・TRUE価格。`GrowthPressureInput` のキー集合はテスト SAI-GROW-15 で固定してあり、
将来これらを混入させると落ちる。

---

## 4. Gates / Modifiers の詳細

| 名称 | 型 | 定義 | 既定値の出所 |
|---|---|---|---|
| `conversionSignal` | modifier −1〜+1 | 目標成約率下限(0.75)を基準に上回れば+・下回れば− | `COMMERCIAL_COMMITMENT_PARAMETERS_V1.targetConversionFloor` |
| `forwardDemandSignal` | modifier 0〜1 | `healthyForwardTons / currentRelevantScale` | M2.5 `computeBacklogSemantics`（**Overdueは含めない**） |
| `marketLifecycleSignal` | modifier −1〜+1 | 公開ライフサイクルトレンド平均 ÷ 0.01/期 | 新規（GROW-1初期値） |
| `supplyPressureBrake` | modifier 0〜1 | `(supplyPressure − 1) / (1.5 − 1)` | 既存 `capexOversupplyPressureThreshold`(1.2)より上に設定 |
| `marginSignal` | gate 0〜1 | `(貢献 − 0.05) / (0.20 − 0.05)`。参照売価未観測なら1（断定しない） | 下限は `COMMERCIAL_AMBITION_PARAMETERS_V1.minimumContributionUsdPerKg` |
| `inventoryBrake` | gate 0〜1 | 過剰比 1.3 で開始、1.5 で完全抑制 | `excessInventoryRatioForDiscount`(1.3) / `inventoryExcessHoldRatio`(1.5) |
| `crisisGate` | gate | NORMAL 1.0 / LIQUIDITY_STRESS 0.4 / SEVERE_DISTRESS 0 | 新規（GROW-1初期値） |
| `financeGate` | gate | healthy 1.0 / watch 0.7 / stressed 0.3 / covenantBreach 0.2 / paymentArrears 0.1 / insolvent・paymentDefault 0 | 既存 `FinancialHealthTier` をそのまま使用 |
| `profileSensitivity` | 乗数 | HIGH 1.2 / MEDIUM 1.0 / LOW 0.7 | **既存** `STRATEGIC_GROWTH_PARAMETERS_V1.ambitionSensitivity`（新parameterを作らない＝§17） |

---

## 5. Company profile handling（§16・§17）

会社別のハードコードは存在しない。差は次の2つからのみ生じる。

1. **Vision**（人間が与える志）— 参照規模とgrowthAmbition。
2. **既存のambitionSensitivity**（growthAmbition由来）— 同じ状況でも焦り方が違う。

したがって「MASSだから100,000t」のような固定目標は一切書かれていない（§32）。

---

## 6. Constraint Routing（§18〜§20）

判定は既存診断のみから行い、優先順位は次のとおり（先に該当したものがprimary）。

```
1 NO_MARKET_OPPORTUNITY … 観測機会が無い / 現在の提出量を上回る機会が無い
2 FINANCE              … crisisGate<1 または financeGate<1
3 INVENTORY            … inventoryBrake>0
4 MARGIN               … marginSignal=0
5 RAW_MATERIAL         … unservedOpportunity.blockedByRawMaterialTons>0
6 LABOR                … unservedOpportunity.blockedByLaborTons>0
7 PRODUCTION_CAPACITY  … unservedOpportunity.blockedByProductionCapacityTons>0
8 COMMERCIAL           … unservedOpportunity.blockedBySalesCapacityTons>0
                         または §21 の営業deadlock（下記）
9 NONE
```

destination（§20）: COMMERCIAL→SALES_HIRING / PRODUCTION_CAPACITY→CAPEX /
RAW_MATERIAL→PROCUREMENT_EXPANSION / LABOR→WORKFORCE_EXPANSION /
FINANCE・INVENTORY・NO_MARKET_OPPORTUNITY→HOLD_GROWTH / MARGIN→IMPROVE_MIX_OR_PRICE /
NONE→SALES_EXPANSION。

### 6.1 Sales Hiring Deadlock（§21）

`salesHiringZeroReason === "SALES_HIRING_BLOCKED_BY_PRODUCTION"` かつ 市場機会があり、
かつ **生産能力起因の未充足が無い**（＝能力には余力がある）場合、
`COMMERCIAL_CAPACITY_CONSTRAINED_BY_CURRENT_PRODUCTION` を立て、primaryをCOMMERCIALにする。
これは「能力が足りない」のではなく「能力が余って見えるから営業を増やせない」状態であり、
GROW-3で営業先行採用を許す根拠になる。

### 6.2 CAPEX Deadlock（§22）

Growth PressureがHIGH/URGENTで、現行の提出cap が観測機会を捨てており、かつ
生産能力起因の未充足が出ていない場合、
`GROWTH_PRESSURE_BLOCKED_BY_SELF_REFERENTIAL_CAPACITY_GATE` を立てる。
新工場 Gate I（需要/能力 ≥ 0.95）が自社販売目標の自己参照で低くなっている状態を示す。

---

## 7. Engine hard-cap の扱い（§23）

営業能力式 `capacity(h) = 1,000 + 95,000×h/(h+190)` は**変更しない**。
Shadowは、Vision参照規模を現在の商品構成（前期実績の商品比）で営業工数へ換算し、
漸近上限 `1,000 + 95,000 = 96,000` 工数トン/四半期 の95%を超える場合に
`GROWTH_BLOCKED_BY_ENGINE_CAP` と `EXTERNAL_ENGINE_CAPACITY_LIMIT` を立てる。
これは診断のみで、Standard AI側では解消できない（#04/#05判断事項）。

---

## 8. 現行 0.35 / 0.5 cap が捨てている機会（§24）

`maximumSupplierShare = 0.35`（engine共有）と提出係数 `0.5`（AI側）は**変更していない**。
Shadowは機会評価にAI側の控えめ係数を**使わず**、engineのsupplier shareまでを機会として数える。

- `observedOpportunityTons` … 制度上取りうる採算つき需要
- `currentSubmissionCeilingTons` … 現在この会社が実際に取りに行っている量
- `ceilingSuppressedOpportunityTons` … その差＝現行capで捨てている観測機会

GROW-2（opportunityShareの可変化）の主要判断材料である。

---

## 9. Diagnostics（§27）

`GrowthPressureAssessment.reasonCodes` に格納する（既存 `StandardAiReasonCode` 型へ追加済み）。
**`diagnostics.entries` には混ぜていない** — 既存のレポート・Excel・集計の出力を
1件も変えないため（Decision非干渉と同じ理由）。

```
GROWTH_PRESSURE_LOW / _MODERATE / _HIGH / _URGENT
GROWTH_OPPORTUNITY_AVAILABLE
GROWTH_OPPORTUNITY_SUPPRESSED_BY_SUBMISSION_CAP
GROWTH_BLOCKED_BY_COMMERCIAL / _PRODUCTION_CAPACITY / _RAW_MATERIAL / _LABOR
GROWTH_BLOCKED_BY_FINANCE / _MARGIN / _INVENTORY
GROWTH_NO_MARKET_OPPORTUNITY
GROWTH_BLOCKED_BY_ENGINE_CAP / EXTERNAL_ENGINE_CAPACITY_LIMIT
COMMERCIAL_CAPACITY_CONSTRAINED_BY_CURRENT_PRODUCTION
GROWTH_PRESSURE_BLOCKED_BY_SELF_REFERENTIAL_CAPACITY_GATE
```

---

## 10. Vision shadow comparison（§7・§30）

候補Visionは、既存Visionの参考成長軌道の**形をそのまま保ったまま**Q32値だけを差し替える
（新しい成長曲線を発明しない）。**候補Visionは正式値ではなく、Decisionにも一切使わない。**

| 会社 | 現行Q32 | 候補Q32 |
|---|---|---|
| MASS | 80,000 | 100,000 |
| BAL | 34,000 | 65,000 |
| JPQ | 30,000 | 55,000 |
| VAP | 17,000 | 55,000 |
| CONSV | 27,000 | 50,000 |

`scripts/saiGrow1Benchmark.ts` が両方のShadowを並べ、HIGH/URGENTのturn数・onset turn・
primary constraint分布を会社別に出力する。

---

## 11. Benchmark

`npx tsx scripts/saiGrow1Benchmark.ts`（DS1/DS2 × seed `grow1-s1/s2/s3`）。
DS3はintegration branchに存在しないため対象外（fixtureを捏造しない）。

### 11.1 Growth Pressure levelの分布（3 seed合計・各社96 turn-obs）

**DS2**

| 会社 | 現行Vision L/M/H/U | 候補Vision L/M/H/U | HIGH以上のonset（現行 / 候補） | engine cap診断 現/候 | 営業deadlock | 自己参照capacity gate | 平均suppressed機会 |
|---|---|---|---|---|---|---|---|
| BAL | 41/43/12/0 | 13/13/37/33 | T2 / T2 | 0 / 0 | 39 | 12 | 45,340t |
| MASS | 21/17/**44/14** | 11/15/30/40 | T7,T4,T6 / T3 | 13 / 23 | 45 | **58** | 43,150t |
| JPQ | 44/36/16/0 | 10/10/28/48 | T8,T9,T9 / T4,T4,T3 | 0 / 0 | 63 | 16 | 46,869t |
| VAP | 79/17/**0/0** | 4/22/**70**/0 | なし / T8,T7,T7 | 0 / 0 | 30 | 0 | 49,216t |
| CONSV | 40/49/7/0 | 11/19/48/18 | なし,T13,T13 / T6 | 0 / 0 | 29 | 6 | 49,009t |

**DS1**

| 会社 | 現行Vision L/M/H/U | 候補Vision L/M/H/U | HIGH以上のonset（現行 / 候補） | engine cap診断 現/候 | 営業deadlock | 自己参照 | 平均suppressed |
|---|---|---|---|---|---|---|---|
| BAL | 25/60/11/0 | 4/7/30/55 | T2 / T2 | 0 / 0 | 56 | 11 | 46,133t |
| MASS | **90/6/0/0** | 80/13/3/0 | なし / T3 | 24 / 36 | 3 | 0 | 64,679t |
| JPQ | 33/47/16/0 | 3/5/35/53 | T8,T9,T9 / T4,T4,T3 | 0 / 0 | 47 | 16 | 46,911t |
| VAP | 78/18/0/0 | 3/16/77/0 | なし / T8,T7,T7 | 0 / 0 | 27 | 0 | 49,386t |
| CONSV | 34/49/13/0 | 4/18/52/22 | なし,T13,T13 / T6 | 0 / 0 | 28 | 13 | 48,345t |

DS1のMASSは32Turnを通じてprimary constraintが `FINANCE`（87/96）である。これはGROW-1の
追加によるものではなく、DS1でMASSが早期に資金繰り破綻して生産0になる**既存の挙動**
（`scripts/dynamicScenario1ZeroProductionDiagnostic.ts` 等で既知）をShadowが正しく
「成長どころではない」と診断しているものである。

### 11.2 会社差（§29の確認・現行Vision・DS2）

HIGH以上の四半期数: **MASS 58 > JPQ 16 > BAL 12 > CONSV 7 > VAP 0**。
MASSが最も早く・最も強く、VAPは一度もHIGHにならない。CONSVはBALより控えめ。
会社別のハードコードは無く、この差はVisionと既存ambitionSensitivityだけから生じている。

---

## 12. Future GROW-2/3/4 connection

| Phase | 本ShadowのどのフィールドをDecisionへ接続するか |
|---|---|
| GROW-2 | `score` / `opportunitySupport` → `realisticShareOfProfitableOpportunity`(0.35) と `realisticShareOfOpportunity`(0.5) の可変化。判断材料は `ceilingSuppressedOpportunityTons` |
| GROW-3 | `primaryGrowthConstraint === "COMMERCIAL"` かつ `COMMERCIAL_CAPACITY_CONSTRAINED_BY_CURRENT_PRODUCTION` → 営業先行採用の許容（`productionSupportedScale` の緩和） |
| GROW-4 | `GROWTH_PRESSURE_BLOCKED_BY_SELF_REFERENTIAL_CAPACITY_GATE` → 新工場 Gate I の需要根拠拡張 |
| DIV-5 | `level` / `recommendedPressureDestination` / `nearTermGrowthActionExists` → Required Cash Reserve の厚み（§33） |

いずれもGROW-1では**接続していない**。

---

## 13. Known limitation（GROW-1時点の実測所見）

1. **`opportunitySupport` が常時1.0に飽和する。** 現行の提出cap（観測機会の17.5%）に対し、
   観測機会は3〜6倍あるため、比率は常に飽和比率2.0を超える。結果として現状のscoreは
   実質的に「Vision gap × 各brake」で決まっている。これはGROW-2で0.35/0.5を可変化すると
   自然に解消する見込みだが、GROW-1の時点では**opportunity項は感度を持っていない**。
2. **候補VisionはVAP・CONSVの性格を変えうる**（§29・Stop Condition D/E）。詳細は最終報告。
3. `crisisGate` / `lifecycleWeight` 等の新規係数は未校正（Decisionに影響しないため、
   GROW-1では校正済みであることを主張しない）。
