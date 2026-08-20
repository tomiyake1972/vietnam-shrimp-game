# SAI-GROW-3B-2 — Fundable Operations / Survival & Recovery

base commit: `09e6a8f`（3B-1.1）。Liquidity SSoT / Growth Financing はすべて維持。

## 1. 解決した構造

資金危機に入った会社が
`調達縮小 → 生産縮小 → Cash悪化 → 調達0 → 生産0 → Worker固定費だけ残る → 永久崩壊`
となる原因は、Standard AIが「今いくらぶんの原料しか買えないか」を**判断前に**把握していなかったこと。

生産計画は納品需要と設備能力だけで満額立ち、engine側の `computeProcurementConstraint` が
事後的に調達を0へ削る。生産計画が満額のままなので `labor.ts` の `sustainedExcess` は
永久に false になり（PRE-AUDIT F-5）、生産0でもWorkerが1人も減らない。

実測（DS1 seed ds1-benchmark の MASS、修正前）:
T11以降 生産0が固定、調達希望は毎期7,716tのままengine側で0へ削られ、
Worker 4,948人が32Turn一切減らず、OP −10.5M/期、T32のCashは −164.2M。

## 2. 導入したもの — `decision/fundableOperations.ts`

### 2.1 Fundable Procurement Volume（PRE-AUDIT S-2）

engineと**同一の式**で、意思決定の前に評価する（別のeconomic modelを作らない）。

```
expectedBorrowingForOperations = realisticallyAvailableBorrowingUsd(...)   // 3B-1/3B-1.1をそのまま再利用
procurementFundingUsd          = max(0, cash) × domesticPurchaseCashAllocationRatio
                                 + expectedBorrowingForOperations
fundableDomesticProcurementTons = procurementFundingUsd / (前期国内参照価格 × 1000)
fundableRawMaterialTons         = pressures.rawMaterialInventoryPosition   // 手持ち + パイプライン×0.5
                                 + fundableDomesticProcurementTons
```

`domesticPurchaseCashAllocationRatio` は `FINANCING_PARAMETERS_V1` の実値をそのまま参照する。
借入見込みは3B-1の関数をそのまま呼ぶため、`underwritingFrozen` / 信用悪化tier / SEVERE_DISTRESS /
LOW financialRiskTolerance では **0**（借りられない会社に借入を捏造しない）。

前期参照価格が未知（Turn1等）のときは資金換算ができないため cap を掛けない。

### 2.2 Fundable Production

```
FundableProduction = min(生産必要量, fundableRawMaterialTons)
```

商品別には同一比率で縮小するだけで、優先度付け（未履行契約優先）は既存ロジックがそのまま行う。
`buildStandardAiProductionPlans` の追加引数は **optional** で、渡さなければ挙動は完全に同一
（G3B2-4 が bit-identical を固定）。

### 2.3 縮退を掛ける条件（段階的）

| 状態 | 新規成長投資 | ハードな生産cap | 営業縮小 |
|------|-------------|----------------|---------|
| NORMAL | 継続 | なし | なし |
| LIQUIDITY_STRESS（単発） | 停止 | **なし**（既存Crisis Gateのみ） | なし |
| LIQUIDITY_STRESS（痕跡あり） | 停止 | あり | なし |
| SEVERE_DISTRESS（単発） | 停止 | あり | なし |
| SEVERE_DISTRESS（痕跡あり） | 停止 | あり | **あり** |
| 明確なfunding shortfall | 停止 | あり | なし |
| RECOVERY | 停止 | **なし**（規模の再拡大を許す） | なし |

* 「明確なfunding shortfall」= 原料不足 **かつ** `cashPressure >= severeCashPressureThreshold`
  **かつ** 前四半期にも痕跡あり。
* 「痕跡（sustainedDistress）」= 前四半期に 調達scaleRatio ≤ `severeScaleRatioThreshold` /
  審査凍結 / 輸入停止 / 生産実質ゼズ のいずれか。

### 2.4 新しい閾値を1つも作っていない

| 使った判定 | 出所（既存・較正済み） |
|-----------|---------------------|
| 調達資金の式 | `financing/liquidityClose.ts::computeProcurementConstraint` |
| 資金配分比 | `FINANCING_PARAMETERS_V1.liquidity.domesticPurchaseCashAllocationRatio` |
| 借入見込み | 3B-1 `realisticallyAvailableBorrowingUsd` |
| 在庫ポジション | `pressures.rawMaterialInventoryPosition` |
| 「実質ゼロ調達」 | `crisisState.ts::severeScaleRatioThreshold`（0.02） |
| 「深刻な現金圧力」 | `parameters.ts::severeCashPressureThreshold`（0.7、procurement.tsと同じ） |
| Worker縮小の刻み | `regularHeadcountAdjustmentDamping`（既存） |
| 営業縮小の刻み | `applySalesHireRampLimit`（増員と同じ組織ランプ比率） |

新しい永続stateも持たない（すべてobservationの確定値からの純粋関数＝決定論・resume安全）。
company IDのhardcodeも0件（G3B2-11でソースを走査して固定）。

## 3. Labor / Sales

* **Labor**: 生産計画がfundable levelへ縮退すると `requiredRegular` が下がり、
  既存の `sustainedExcess` が初めて成立して `regularHeadcountAdjustmentDamping` の範囲で段階縮小する。
  **labor.ts のロジックは1行も変更していない**（F-5は生産計画側の欠陥だった）。
* **Sales**: 既存の減員ロジックを再利用する。survival時だけ
  (a) 在庫制約による減員ブロックを外し、(b) `lostTotal ≈ 0`（この1人が何も生んでいない）を
  「情報不足なので止める」ではなく「最も明確な減員候補」として扱う。
  1四半期の減員幅は増員と同じ組織ランプ上限で抑える（一度に営業組織を破壊しない）。

## 4. Recovery（bounded / hysteresis）

`RECOVERY` は crisisState が NORMAL に戻り、かつ前四半期にはまだ痕跡がある状態。
このあいだ **規模（調達・生産・Worker・営業）は再拡大できる**が、
新規CAPEX・新工場・営業増員は再開しない。痕跡が消えて初めて NORMAL へ戻る。
痕跡判定が1Turn遅延しているため、追加のカウンタ無しに1Turnのhysteresisが自然に成立する。

## 5. Reason codes / diagnostics

`SURVIVAL_MODE` / `RECOVERY_MODE` / `GROWTH_PAUSED_FOR_RECOVERY` /
`PRODUCTION_REDUCED_BY_LIQUIDITY` / `PROCUREMENT_REDUCED_BY_LIQUIDITY` /
`WORKFORCE_REDUCED_FOR_SURVIVAL` / `SALES_FORCE_REDUCED_FOR_SURVIVAL`

1件の診断（`SURVIVAL_MODE`/`RECOVERY_MODE`）に、crisisState・posture・sustainedDistress・
procurementFunding・fundableProcurement/Production・planned procurement/production・
worker current/planned/change・sales headcount/change・liquidity headroom・available borrowing・
growthPaused をすべて載せている。`diagnostics.fundableOperations` からも同じ評価を読める。

## 6. 実測

### 6.1 DS1 MASS（既存collapse。seed ds1-benchmark）

| | before (09e6a8f) | after (3B-2) |
|---|---|---|
| 生産0の固定 | T11以降 恒久 | T14以降（それまでは縮小しつつ生産継続） |
| 調達希望 | 毎期7,716t（engine側で0へ） | fundable量へ追従（0のときは0） |
| Worker | 4,948人で32Turn固定 | 9,000 → 3,331(T7) → 359(T12) → 0(T22) 段階縮小 |
| 営業減員 | 0人（32Turn一切動かず） | T7以降 −18/−13/−9/−6/−5/−3… と段階縮小 |
| OP | −10.5M/期 | −5.1M/期 |
| T32 Cash | −164.2M | **−47.1M** |
| T25-32累計損益 | −89,741,000 | **−40,853,000** |

Survival Modeは正しく発火し、固定費を落として現金流出を約71%削減した。
ただし**MASSは救えていない**（§8 Stop Condition I）。

### 6.2 BAL（DS3 seed ds3-a、32Turn）

posture: NORMAL 31Turn / SURVIVAL 1Turn（T5、LIQUIDITY_STRESS単発のため生産capは掛からず、
生産13,997tは不変）。Worker 4,151 → 15,010、T32生産44,512t、Cash 641.4M、CAPEX累計80.1M。
**成長は一切損なわれていない。**

### 6.3 DS3 5社（seed ds3-a、T8/16/24/32）

3B-1.1と **bit-identical**（CAPEX累計・能力・生産・Cash・Debt・liquidity headroom すべて一致）。
DS3ではどの会社も持続的distressへ入らないため、本phaseの経路が発火しない。

### 6.4 DS2（8seed × 5社。3B-1.1 → 3B-2）

| 会社 | avg OP (M) | avg 生産 (t) | 資金不足T計 |
|------|-----------|-------------|------------|
| BAL | 1031.8 → 1030.8 | 654,062 → 654,022 | 0 → 0 |
| MASS | 951.5 → 950.7 | 690,805 → 690,841 | 0 → 0 |
| JPQ | 764.3 → 764.3 | 600,617 → 600,619 | 0 → 0 |
| CONSV | 745.0 → 744.9 | 559,511 → **560,385** | 1 → 1 |
| VAP | 644.8 → 644.7 | 512,280 → 512,276 | 0 → 0 |

差はいずれも0.5%未満。**縮小型になった会社は1社も無い。**

CONSV ds2-s8（1Tだけ資金不足がある seed）は32Turnすべて posture=NORMAL で、
縮退・防御行動を一切取っていない（過剰反応なし）。

### 6.5 DS1（seed ds1-benchmark、T25-32）

BAL 632.6M → 633.2M、JPQ 391.3M → 391.7M、VAP 356.3M → 356.6M、CONSV 385.8M → 379.5M（−1.6%）。
MASS −89.7M → −40.9M。成長会社の悪化は無い。

## 7. 受入テスト

`app/lib/v2/companyLab/standardAi/__tests__/fundableOperationsG3B2.test.ts`（15件）

G3B2-1 NORMAL+資金十分でcapなし / -2 危機で生産縮退 / -3 生産縮退に必要原料が追従 /
-4 NORMAL時bit-identical / -5 一時Stressで営業を縮小しない / -6 深刻かつ持続で営業縮小可 /
-7 underwritingFrozenで借入を捏造せず縮小で生存 / -8 健全なら当期借入見込みを算入 /
-9 資金回復でRECOVERY（規模は戻せる・成長は再開しない） / -10 痕跡が消えればNORMAL /
-11 会社IDのhardcodeなし・profileだけで差が出る / -12 決定論 / -13 参照価格未知ならcapなし /
**-14 DS1 MASS実測でWorker/営業が段階縮小し固定費が落ちる（一括解雇でない）** /
**-15 健全な成長会社（DS1 BAL 16Turn）で生産capが1度も掛からない**

全社suite 3,679 tests / 3,679 pass / 0 fail。

## 8. Stop Conditions

| id | 判定 | 実測 |
|----|------|------|
| A. Survival Modeが通常会社にも頻発 | **なし** | DS3 BAL 32Turn中SURVIVAL 1Turn（capは非適用）。DS1 BAL 16Turnでcap 0回 |
| B. 全社が縮小型になる | **なし** | DS2 8seed×5社で生産・OPの差 <0.5% |
| C. 危機から戻れない | 構造上は戻れる | RECOVERY→NORMALの経路をG3B2-9/-10で固定。ただしDS1 MASSは§Iにより実際には戻れない |
| D. Worker削減が強すぎて回復不能 | **なし** | 1四半期の減少は既存damping内（テストで75%上限を固定）。0人からの再採用は既存 `isBootstrapFromZero` 経路で可能 |
| E. Sales削減が強すぎて市場再参入不能 | **なし** | 1四半期の減員は組織ランプ上限内（実測 最大18人）。DS1 MASSでも0人には至らない |
| F. DS3 MASS/JPQ/VAPのGrowthが悪化 | **なし** | DS3はbit-identical |
| G. CONSVの軽微stressで過剰縮小 | **なし** | ds2-s8で32Turn全てNORMAL、縮退0回 |
| H. DS1/DS2 regression | **なし**（CONSVのDS1 −1.6%のみ） | §6.4 / §6.5 |
| I. Standard AIだけでは救えない危機 | **あり（報告事項）** | 下記 |

### Stop Condition I — engine側の不可逆性（実測）

DS1 MASS T32の損益内訳（Worker 0人・生産0・売上0の状態）:

```
grossRevenue                       0.00M
unabsorbedFixedManufacturingCost   4.17M   ← 工場を保有しているだけで発生する固定製造費
totalCostOfSales                   4.17M
sellingGeneralAdmin                1.42M
operatingProfit                   -5.59M
interestExpense                    1.52M   ← 借入44.6M（信用凍結で返済も借換もできない）
netIncome                         -7.11M
```

Standard AIが縮小できるのは Worker・営業・調達・生産・投資までであり、
**保有工場の固定製造費（4.17M/期）と既存借入の利息（1.52M/期）は意思決定で消せない**。
資産売却・工場閉鎖・債務再編に相当するengine機能が存在しないため、
一度この状態に入った会社はStandard AI側の判断だけでは黒字化できない。
本phaseで達成できたのは「崩壊の速度を約1/3に落とし、規模を資金に合わせること」までである。

## 9. 次のbinding constraint

1. **固定製造費の不可逆性（最優先）**: 工場閉鎖・遊休化・資産売却に相当するengine機能が無い。
   `unabsorbedFixedManufacturingCost` が生産0でも満額計上されるため、真のRecoveryが成立しない。
2. **信用凍結下の債務**: 借入が返済も借換もできず利息だけが積み上がる。
3. **MASSのbacklog**（3B-3の対象。本phaseでは未着手）。
4. CONSVのDS2 ds2-s8 1T資金不足（LOW risk toleranceのため借入では解決しない）。
