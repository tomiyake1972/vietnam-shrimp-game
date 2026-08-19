# SAI Growth Architecture Final Audit

base: `2244f18`（SAI-GROW-3C.1）＋ `135147c`（minimumMarketPresenceRatio tech debt cleanup）。
**Vision / opportunity share / MARKET_WEAK / VISION_ON_TRACK / step multiplier / Scenario は未変更。**

## F-1 — 実際の call order（`standardAi/policy.ts` の行番号つき）

```
[観測]
  L428  assessStandardAiCrisisState                  … Crisis State（前Turnの確定値のみ）
  L445  computeObservableCommercialOpportunity       … attainableProfitableTons / contribution
  L463  computeOrientationWeightedOpportunity        … ★Ambitionへは渡らない（GrowthPressureのみ）
  L469  computeGrowthPressureCore                    … effectiveOpportunityShare / growthEvidenceMultiplier
[志]
  L491  commercialAmbitionInput 組み立て
        （capacityAnchorTons = Σ能力 × salesUtilizationTarget、recentActualScaleTons = 前期実績生産）
  L509  computeCommercialAmbition                    → ambitionTons / limiter
[今受けてよい量]
  L521  observeContractConversion
  L527  computeCommercialCommitment                  → submissionTargetTons（提出量）
  L546  computeFundableRawMaterial                   … 3B-2と同一式（engine準拠）
  L558  computeDeliverableCommitment                 … 3B-3 Deliverability cap
  L580  Deliverability cap 適用（crisisState === NORMAL のときだけ）
  L594  applyCrisisGateToCommercialCommitment        … 危機時の縮小（0.7倍 / 0）
[実行計画]
  L599  buildStandardAiSalesPlans
  L625  buildCurrentPeriodDeliveryDemand
  L638  computeFinalProductionRequirement
  L644  assessFundableOperations                     … 3B-2 Survival / Recovery posture
  L654  buildStandardAiProductionPlans               … posture=SURVIVAL時のみ fundable cap
  L668  buildStandardAiProcurementPlan               … 縮退後の生産計画へ自動追従
  L669  buildStandardAiWorkerAssignments（1回目）
[資金]
  L687  assessCommittedCashRequirement               … 3B-1 Liquidity SSoT
[成長の回付]
  L720  assessGrowthRouting                          … 3C / 3C.1
        → route === WORKFORCE のとき L669 の labor を
          workerRequirementForExecutableTarget で再評価（3C.1）
[投資]
  L796  buildStandardAiCapexDecision                 … route === PRODUCTION_CAPEX のとき growth demand を注入
  L904  evaluateNewFactoryDecision
  L926  buildStandardAiSalesForceHiringDecision      … route === LIQUIDITY のとき採用停止
[財務]
  L1017 buildStandardAiFinancingRequest              … 承認済み投資＋growth borrowing を申請
  L1035 buildStandardAiDividendDecision
```

**順序上の要点**

* Deliverability cap（L580）は Crisis Gate（L594）**より前**。危機時は cap を適用しないことで二重抑制を避ける。
* Liquidity SSoT（L687）は CAPEX（L796）**より前**、Financing（L1017）**より後ろに来ない**——
  投資可否は Liquidity で決め、借入額は投資確定後に決める（3B-1の選択A+B）。
* Growth Routing（L720）は Liquidity の後。よって `liquidityBlocked` を根拠に投資を止められる。
* Labor は 1回計算した後、WORKFORCE route のときだけ**再計算**される（L669 → L720以降）。

## F-2 — SSoT の実態

| 概念 | SSoT モジュール | 本当にSSoTか | 重複／残存する定義 |
|------|----------------|--------------|-------------------|
| Liquidity | `decision/liquidity.ts`（3B-1） | **はい** | 旧 L1〜L4（targetMinimumCash単独判定・案件単位cash gate）は撤去済み |
| Fundable Operations | `decision/fundableOperations.ts`（3B-2） | **はい** | `computeFundableRawMaterial` を 3B-3 / 3C も共有 |
| Deliverability | `decision/deliverableCommitment.ts`（3B-3） | **はい** | routing側の `sustainableDeliverableCapacityTons` は **min にWorker/原料を追加した別値**（cap本体には影響しない。§意図的） |
| Growth Routing | `decision/growthRouting.ts`（3C/3C.1） | **はい** | — |
| Vision | `vision/defaults.ts` + `vision/overrides.ts` | **はい** | ただし override は `targetScaleTonsPerQuarterAtQ32` と `strategicPosture` のみ対応。`growthAmbition` / `willingnessToBuildFactories` は override できない |
| Opportunity | `decision/sales.ts::computeObservableCommercialOpportunity` | **いいえ（重複あり）** | **0.35 が2か所**: `sales/parameters.ts::maximumSupplierShare`（cell単位・engineも使う） と `commercialAmbition.ts::realisticShareOfProfitableOpportunity`（aggregate単位）。さらに `computeOrientationWeightedOpportunity` が同じcellを再走査して別値を作るが、Ambitionへは渡らない |
| Worker requirement | `companyLab/workforce.ts::computeRequiredRegularHeadcount` | **はい** | 労働集約度係数の唯一の情報源 |
| Binding capacity | `standardAi/bindingCapacity.ts` | **はい** | Phase 6D-1 で3箇所の重複を統合済み |

**残る重複はOpportunity層だけ**である。

## F-3 — Remaining known issues

| # | issue | 影響 | 根拠 | scope |
|---|-------|------|------|-------|
| 1 | **Vision 旧設定**（VAP 17k / JPQ 30k / CONSV 27k / BAL 34k が評価レンジの0.34〜0.60倍） | T32で5社とも `ambition == baseline`、Visionのpull効果ゼロ | 3D §7 / VISION1 §1 | #05（データ判断） |
| 2 | **MASS opportunity share 0.35** | `realisticOpportunity 59.5kt < baseline 63.6kt` → MARKET_WEAK。**ただし share を上げても生産は増えず backlog が増えるだけ**（実測） | MASS監査 §5-§6 | #05 |
| 3 | **5社の attainableProfitableTons が完全同一（166,828t）** | market orientation / customer trust / quality / sales capability / product mix のいずれも機会評価に入っていない | MASS監査 §2 | #05 + #04（cell share拡張） |
| 4 | **volume / value scale 混同** | 拡大量の判断は全てトン。contribution は閾値判定のみ。CAPEX単価（HOSO 2,000 / PD 11,429 / VAP 24,000 USD/t）が routing に入らない | VALUE_SCALE監査 §1-§3 | #05 |
| 5 | **Factory sale / closure が engine に無い** | 生産0・Worker0でも `unabsorbedFixedManufacturingCost 4.17M/Q` ＋ 利息 1.52M/Q が消えず、DS1 MASSは黒字化不能 | 3B-2 Stop Condition I | **#04** |
| 6 | **DS2 MASS funding shortfall 2T**（ds2-s5 / ds2-s6） | 3C.1で新規発生。seed別OP・現金はいずれも改善しており単一四半期のタイミング差 | 3C.1 §9-F | #05 |
| 7 | **CONSV ds2-s8 funding shortfall 1T** | 3B-3以降ずっと1T。CONSVはLOW risk toleranceで借入を成長原資にしないため share/Visionでは解けない | 3B-3以降 | #05 |
| 8 | **minimumMarketPresenceRatio tech debt** | **解消済み**（commit `135147c`。値0.2のまま参照先のみ sales domain へ移動、bit-identical test付き） | 本作業 | 完了 |
| 9 | **VAPの32kt天井は3段重ね** | Vision ceiling ＋ growthPressure早期return ＋ LOW step 0.03。さらに T1-T18 の資金制約でCAPEXが0 | 3D §6 / VISION1 §3 | #05 |
| 10 | **Vision override が growthAmbition / willingness を扱えない** | Vision candidate の shadow 評価に fixture 直接差し替えが必要（本作業でもそうした） | 本作業 §再現方法 | #05（優先度低） |

## F-4 — Next 3 recommended implementation phases

### 1位: **Vision Case A1 の正式採用（Q32 target scale のみ）**

* **目的**: BAL / JPQ / CONSV の Vision pull を回復させ、`ambition == baseline` 状態から脱する。
* **expected benefit**（DS3 8seed T32実測）:
  JPQ 生産 38.2 → 53.8kt・overdue 19,232 → **0**、CONSV 39.8 → 50.6kt・overdue 220 → **0**、
  BAL 43.8 → 44.8kt・backlog 206 → **0**。3社とも評価レンジへ大きく近づく。
* **risk**: 低。T8のCAPEX/cash/debtは Case 0 と同一で早期投資集中は起きず、CONSVはdebt 0のまま。
* **dependencies**: なし。`growthAmbition` / `willingnessToBuildFactories` は**変更不要**（挙動不変を実測）。
* **scope**: **#05**（Vision値の承認）。実装は defaults.ts の5行。
* **注意**: VAP と MASS はこれでは解けない（下記2位・3位）。

### 2位: **MASS / VAP の execution bottleneck 監査（capacity utilisation と backlog 消化）**

* **目的**: MASS は T32 で能力 66.8kt に対し生産 53.3kt・sales 33.2kt・backlog 58.0kt。
  opportunity share を上げても生産が 0.04% しか動かないことは実測済みであり、
  **真の binding は「能力の80%しか回らない」「backlogを捌けない」側にある。**
  VAP も T1-T18 に CAPEX が 0 で、能力が動くのは最後の8Turnだけ。
* **expected benefit**: 2社の生産を能力に近づけられれば、Vision も share も動かさずに
  MASS 53 → 60kt台、VAP 30 → 35kt台が見込める（上限は能力そのもの）。
* **risk**: 中。原因が原料・労務・配分アルゴリズムのどこにあるかまだ分からない（監査が先）。
* **dependencies**: 1位とは独立。並行可。
* **scope**: **#05**（Standard AI 側）だが、原因が `production/allocation.ts` にある場合は **#04**。

### 3位: **Growth Routing への「拡大単価」導入（volume/value 2軸診断）**

* **目的**: `growthRouting.routedGrowthByProduct` が志の商品構成比でトンを配るだけで、
  CAPEX単価（HOSO 2,000 / PD 11,429 / VAP 24,000 USD/t）を見ていない。
  VAP偏重の会社に vapLineExpansion を提案すると同じ金額で HOSO の 1/12 の能力しか買えない。
* **expected benefit**: 投資効率（value headroom / growth cost）で商品ラインを並べられる。
  VAP の「量を追うなら12倍のCAPEXが要る」という事実が診断に出る。
* **risk**: 中。単一スカラーへまとめると CAPEX 12倍という制約が隠れるため、
  **必ず volume / value / cost を別diagnosticとして持つこと**（VALUE_SCALE監査 §4）。
* **dependencies**: 2位の結論（能力が回らない原因）を待つのが安全。
* **scope**: **#05**。ただし `vapLineExpansion` の予算対能力比そのものの妥当性は **#04 / scenario設計**。

## 付録: 今夜の再現方法（一時scriptは残していない）

| 目的 | 方法 |
|------|------|
| Vision Case A1/A2 | `DEFAULT_COMPANY_VISION_DOCUMENTS`（`vision/defaults.ts`）を実行時に `Map.set` で差し替え。開始規模は現行 `referenceGrowthPath[0]` を保ち Q32 まで線形補間 |
| opportunity share 感度 | `COMMERCIAL_AMBITION_PARAMETERS_V1.realisticShareOfProfitableOpportunity` を実行時に代入 |
| Ambition shadow分解 | `computeCommercialAmbition` を diagnostics から再構成した入力で再呼び出し（3D PRE-AUDIT で入力の完全一致を確認済み） |
| 商品別経済性 | `PRODUCTION_PARAMETERS_V1.labor` ＋ `CAPEX_PARAMETERS_V1.templatesByType[*].futureCapacityEffect` ＋ `observation.markets[].referencePriceByProduct` |

いずれも **production code の変更を必要としない**。
