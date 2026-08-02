# PD価値ベース価格モデル — 現行コードの因果トレースと単位分析（Phase B-1）

**文書状態**: 調査・分析。**本Phaseでは製品コードを一切変更していない。**
価格・需要・永続化のいずれの挙動も変えていない。以下はすべて現行実装の読み取りと、
設計上の指摘である。

**対象ブランチ**: `feature/v2-product-labor-and-pd-mechanization`
**調査日**: 2026-08-02

---

## §1 解こうとしている問題（前提の確認）

現行モデルでは、PD加工コストを現実的に引き上げても、それがPD販売プレミアム側へ
反映されない。**消費地市場における経済価値が表現されていない**ためである。
結果、コストだけが上がってPD戦略が成立しなくなる。

**絶対に避けるべき構造（オーナー指示の厳密な再掲）**:
自社の加工コスト上昇が、自動的に市場価格を引き上げて自社を救済してはならない。
市場価格へ入力される加工コストは、**世界市場における効率的／限界供給者の
競争的加工コスト**でなければならず、プレイヤー各社個別のコストであってはならない。
個社の利益は「市場で決まる Actual Premium」と「自社コスト」の差である。

---

## §2 現行の四半期あたり計算順序（実コードの呼び出し順）

`app/lib/v2/companyLab/runner.ts` の1ターン処理を起点に、価格が決まるまでの経路を
実際の呼び出し順で並べる。（opt-in）は `config.marketEvolution` のフラグで
有効化されたラボでのみ通る経路。

| # | 呼び出し | ファイル | 出力 |
| --- | --- | --- | --- |
| 1 | `getScenarioTurnInput(state, turn)` | `scenario/scenarioEngine.ts` | 国別変数（生産量・養殖コスト指数・品質スコア・PD/VAP加工能力）、市場別変数（前期消費量・景気指数・人口増加率）、`pdVapDemand` |
| 2 | `toMarketQuarterInput(...)` | `scenario/marketAdapter.ts` | `MarketQuarterInput` |
| 3 |（opt-in）`applyProcessingCapacityEvolution` | `market/processingCapacityEvolution.ts` | `countries[*].pdProcessingCapacity` を産地別S字カーブで置換 |
| 4 |（opt-in）`computeMarketProductMix` → `applyProductSubstitution` → `applyLifecycleDemandToMarketInput` | `market/productLifecycle.ts`, `companyLab/marketEvolution.ts` | 市場×商品構成比、`pdVapDemand` を構成比由来値で置換 |
| 5 | `calculateMarketQuarter(input, params, rng)` | `market/index.ts` | 下記5a〜5f |
| 5a | `summarizeCountrySupply` | `market/countrySupply.ts` | 国別輸出可能供給量・コスト変化率 |
| 5b | `calculateWorldDemand` | `market/globalDemand.ts` | 世界**総**エビ需要（HOSO換算トン） |
| 5c | `openHosoMarket` | `market/hosoPricing.ts` | 世界需給バランス、国別需要配分 |
| 5d | `clearHosoMarket` | `market/hosoPricing.ts` | **国別HOSO FOB価格**（USD/HOSO換算kg） |
| 5e | `clearVietnamRawMarket` | `market/vietnamRawMarket.ts` | ベトナム国内原料価格 |
| 5f | `calculateProductPremium("pd", ...)` | `market/productPremium.ts` | **PDプレミアム**（下記§3） |
| 6 | `decomposeVietnamProductPrices` | `market/destinationPricing.ts` | `pdProcessingPremium = pdPrice_VN − hosoPrice_VN` |
| 7 | `computeMarketReferencePrice` | `market/destinationPricing.ts` | 仕向市場×商品の参照価格 |
| 8 | `deriveVietnamMarketReferencePrices` → `allocateMarketProduct` | `sales/marketAdapter.ts`, `sales/allocation.ts` | 成約数量・**成約単価**（契約時に凍結） |
| 9 | `allocateProductionPlans` → `createProductionBatches` | `production/*` | 自社の生産量・必要労働・バッチ原価 |
| 10 | `closeFinancialQuarter` | `finance/quarterClose.ts` | 自社の加工費・売上原価・PL |
| 11 | `updateMarketEvolutionState` | `companyLab/marketEvolution.ts` | **翌期**の `premiumRatioMultiplier`・`affordabilitySignalEwma` |

**時間順序の規約**: 手順11の状態更新は必ず「前期までの実績 → 当期の市場入力」の
片方向であり、当期の決定・結果が当期の価格へ再帰する経路は存在しない
（`marketEvolution.ts` 冒頭コメントが明示。`consumerInventory.ts` も同じ規約）。
B-3で導入する経路もこの規約を守る必要がある。

---

## §3 PDプレミアムの現行の式（`market/productPremium.ts`）

```
globalCapacity(t)   = Σ_{c ∈ {EC,IN,ID,VN}} countries[c].pdProcessingCapacity
globalUtilization(t)= pdDemand(t) / globalCapacity(t)

utilizationMultiplier(t) = clamp(1 + (globalUtilization(t) − 0.85) × 0.8, 0.5, 1.8)

basePremiumRatio(t) = 0.18 × premiumRatioMultiplier(t)   ← （opt-in）SAI-5E由来
                           × utilizationMultiplier(t)

各国 c について:
  qualityAdjustmentRatio(c) = ((qualityScore(c) − 50) / 100) × 0.3
  premium(c,t) = max( hosoPrice(c,t) × basePremiumRatio(t)
                    + hosoPrice(c,t) × qualityAdjustmentRatio(c),
                      0.05 )                                ← 【ハード床】
  finalPrice(c,t) = hosoPrice(c,t) + premium(c,t)
```

パラメータ実値（`market/parameters.ts` `MARKET_PARAMETERS_V1.pdVapPremium`）:

| パラメータ | 値 |
| --- | --- |
| `pdBasePremiumRatio` | 0.18 |
| `vapBasePremiumRatio` | 0.55 |
| `referenceUtilization` | 0.85 |
| `utilizationSensitivity` | 0.8 |
| `utilizationMultiplierFloor` / `Cap` | 0.5 / 1.8 |
| `referenceQualityScore` | 50 |
| `qualityPremiumSensitivity` | 0.3 |
| `minPremiumUsdPerKg` | 0.05 |

### §3-1 ここが問題の核心

**価格形成の経路上に、加工コストがどこにも入っていない。**
PDプレミアムは「HOSO価格 × 稼働率と品質だけで決まる比率」であり、
加工の対価という意味を持っていない。したがって:

- 加工コストを上げても、プレミアムは1セントも動かない。コストだけが増える。
- 逆にHOSO価格（原料価格）が上がると、加工プレミアムが**絶対額で自動的に増える**
  （比率式のため）。加工の経済実態と無関係な連動である。

これはオーナーの診断（「消費地市場の経済価値が表現されていないので、
コストだけが上がってPD戦略が成立しない」）と完全に一致する。

### §3-2 仕向市場係数（手順7）が加える意味

```
PD市場参照価格(m) = hosoBasePrice × baseValueCoefficient(m)
                  + pdProcessingPremium × pdPremiumCoefficient(m)
```

`pdPremiumCoefficient` 実値: CN 0.9395 / US 1.0104 / EU 1.0710 / JP 1.0963 / OTHER 0.9498。

**この係数は、市場別の「PD加工価値の評価差」を表現しようとした唯一の既存機構である。**
ただし乗算係数であり、乗じられる対象（`pdProcessingPremium`）が供給側の稼働率から
導かれた値なので、「消費地が幾ら払ってもよいか」という潜在価値の絶対水準は
どこにも存在しない。B-2 の Layer 1（Potential PD Premium）は、この係数が担っていた
役割を**絶対額の市場別パラメータへ格上げする**位置づけになる。

---

## §4 各要素の所在（B-1指定項目の一覧）

| 項目 | 実装場所 | 現状 |
| --- | --- | --- |
| HOSO基準価格 | `market/hosoPricing.ts` `clearHosoMarket` | 国別・需給圧力＋コストアンカー平均回帰＋乱数ショック |
| PDプレミアム | `market/productPremium.ts` | §3のとおり。**加工コスト非依存** |
| 仕向市場別価格 | `market/destinationPricing.ts` | HOSO基礎／PDプレミアム／VAP追加の3部分に分解し、部分ごとに市場係数を乗算 |
| 世界PD需要 | `scenario/scenarioEngine.ts`（固定シェア）／（opt-in）`market/productLifecycle.ts` | 固定: 総消費×`pdDemandShareOfTotalConsumption`。opt-in: 市場別S字普及曲線×前期消費 |
| 産地別PD加工能力 | `scenario/parameters.ts` 固定比率 ／（opt-in）`market/processingCapacityEvolution.ts` | 固定: 生産量×0.30。opt-in: 産地別参入S字カーブ |
| 世界PD加工能力 | `market/productPremium.ts` 内で4か国合算 | 上記の単純和 |
| 稼働率 | `market/productPremium.ts` | `pdDemand / globalCapacity`。**国別稼働率は世界値をそのまま代入**（コメントで明示） |
| PD加工労務・コスト | `production/labor.ts`（係数）、`production/parameters.ts` `baseProcessingCostUsdPerTon`、`finance/quarterClose.ts` | **自社側のみ**。市場価格へは一切入らない |
| 市場別商品ライフサイクル | `market/productLifecycle.ts` | S字（smoothstep）。`adoptionTurnShift` で時間軸を±4Qシフト可 |
| HOSO→PD代替 | `companyLab/marketEvolution.ts` `applyProductSubstitution` | **PD⇔VAPのみ**。HOSO⇔PDの直接代替は未実装（HOSOは動かさない） |
| 5社供給圧力EWMA | `companyLab/marketEvolution.ts` | `completed_supply` 定義。翌期の `premiumRatioMultiplier` へ |
| 消費国在庫 | `market/consumerInventory.ts` | 消費遅行弾力性・在庫キャリー |
| 契約価格の凍結 | `sales/types.ts` `ContractCostSnapshot` | 成約時に `unitPrice` と予想原料費・予想加工費・予想貢献利益を凍結。以後改定しない |
| Standard AIのPD収益性観測 | `standardAi/decision/marketEvolutionInvestment.ts` | `pdPremiumErosionDetected`（プレミアム低下局面の検知）、`pdUtilization` |
| Excel/CSV/JSON出力 | `app/api/v2/exports/_lib/dto/marketDto.ts` | `pdPremium.basePremium`、国別 `premium` / `finalPrice` / `qualityAdjustment` / `capacityUtilization` |
| 永続化スキーマ | `companyLab/persistence/schema.ts` | `marketEvolutionState`（`supplyPressureEwma` / `premiumRatioMultiplier` / `affordabilitySignalEwma` / `supplyRatioBaselineEwma`）。**価格そのものは履歴レコード側** |

### §4-1 産地別加工コストは存在しない（重要）

`CountrySupplyInput`（`market/types.ts`）が持つのは
`production` / `exportCapacityRatio` / `aquacultureCostIndex` / `qualityScore` /
`reliabilityScore` / `pdProcessingCapacity` / `vapProcessingCapacity` のみである。

**産地別の加工コストというデータは、現行コードのどこにも存在しない。**
`aquacultureCostIndex` は養殖（原料生産）コストであって加工コストではない。
B-2 Layer 2 はこの最小追加を必要とする（§B-2で提案）。存在しない数値を
現状の事実として提示しない、というのが本節の要点である。

---

## §5 単位表（B-1の必須成果物）

### §5-1 数量

| 概念 | 単位 | 実装 | 備考 |
| --- | --- | --- | --- |
| 契約数量・原料数量・完成品在庫・加工能力・供給シグナル | **HOSO換算トン**（`HosoEqTons`） | 全モジュール共通 | ゲーム内の唯一の数量単位 |
| 商品の物理重量 | 物理トン | `production/yieldConversion.ts` `calculatePhysicalOutputTons` | **参考情報専用**。永続フィールドに一切書き込まれない |
| `physicalYieldRatio` | 無次元（PD ≈ 0.54） | `production/parameters.ts` | HOSO換算済み数量へ**掛けてはならない**（正常加工の二重計上になる）。`yieldConversion.ts` 冒頭が明記 |
| `saleableRecoveryRatio` | 無次元 | `production/allocation.ts`, `batches.ts` | HOSO換算量側の**異常**損失（不適合・破損・廃棄）。`physicalYieldRatio` とは完全に独立した計算経路 |

**結論**: 「商品実重量kg」と「HOSO換算kg」は明確に分離されており、
数量は常にHOSO換算。物理重量は表示・分析専用。

### §5-2 価格・プレミアム

| 概念 | 単位 | 実装 |
| --- | --- | --- |
| HOSO FOB価格 | **USD/HOSO換算kg**（`UsdPerHosoEqKg`） | `hosoPricing.ts` |
| PDプレミアム | **USD/HOSO換算kg** | `productPremium.ts` |
| PD最終価格 | USD/HOSO換算kg | `hosoPrice + premium` |
| 仕向市場参照価格 | USD/HOSO換算kg | `destinationPricing.ts` |
| 成約単価 `unitPrice` | USD/HOSO換算kg | `sales/contracts.ts` |
| 物理重量あたり価格 | USD/物理kg | `yieldConversion.toPhysicalWeightPrice`（**参考専用**） |

**プレミアムは「商品kgあたり」ではなく「HOSO換算kgあたり」である。**
例: PDプレミアム $0.30/HOSO換算kg は、物理PD重量あたりでは
$0.30 / 0.54 ≈ **$0.556/物理kg** に相当する。
B-2で Potential Premium を「消費地の買い手が余分に払う額」として置くとき、
現実の感覚（物理kgあたり）と実装の単位（HOSO換算kg）がずれる。
**設計文書では必ず HOSO換算kg で定義し、物理kg換算値は括弧で併記する**方針とする。

### §5-3 加工コスト

| 概念 | 単位 | 値 | 実装 |
| --- | --- | --- | --- |
| `baseProcessingCostUsdPerTon` | **USD/HOSO換算トン** | hoso 350 / pd 520 / vap 780 | `production/parameters.ts` |
| 同（kg換算） | USD/HOSO換算kg | hoso 0.35 / pd 0.52 / vap 0.78 | — |
| PD追加加工費 | USD/HOSO換算kg | 0.52 − 0.35 = **0.17** | `finance/quarterClose.ts` が基準（HOSO水準）＋追加分に分解 |
| `processingExportCostUsdPerKg` | USD/HOSO換算kg | **0.85** | `scenario/parameters.ts` `vietnamProcessingEconomics` |
| `expectedProcessingCostUsdPerHosoEqKg` | USD/HOSO換算kg | 契約ごと | `sales/types.ts` `PlanCostExpectation` |

**加工コストは歩留まり損失を含むか → 含まない。**
HOSO換算という単位変換が既に殻・頭の除去という通常の物理的重量減少を織り込んで
おり、加工費は HOSO換算トン（`b.originalTons` / `finishedGoodsQuantity`）に対して
乗じられる。異常損失は `saleableRecoveryRatio` が別経路で扱う。

### §5-4 PD価格がHOSO価格に何を上乗せしているのか

現行: **稼働率と品質で決まるHOSO価格の一定比率**であり、加工の対価ではない。
`pdProcessingPremium` という変数名は `destinationPricing.ts` の逆算で付けられて
いるが、その中身に加工コストは入っていない。**名前と実体が乖離している。**

### §5-5 仕向市場係数の前後で意味が変わるか → 変わる

| 段階 | 値の意味 |
| --- | --- |
| 係数適用**前** `pdProcessingPremium` | 産地（VN起点）の供給側事情（世界稼働率・VN品質）で決まる、市場非依存のPD上乗せ |
| 係数適用**後** `pdPremiumPart(m)` | それに仕向市場 m の評価差（0.94〜1.10）を乗じた、市場別のPD上乗せ |

意味は「供給側で決まった上乗せ」→「その市場での評価後の上乗せ」へ変わる。
どちらも単位は USD/HOSO換算kg で同じなので、**単位では区別がつかない**。
B-2 では Layer 1（Potential、市場別・需要側）と Layer 2（CompetitiveCost、世界・供給側）を
**別々の変数として明示的に持ち**、乗算係数で暗黙に意味を切り替えないようにする。

---

## §6 発見した単位・整合性の問題（**製品コードは修正しない**。設計上の要修正事項として記録）

### U-1 加工費テーブルが二重に存在し、片方が古い

`finance/parameters.ts` の `fixedCostAllocationCoefficientByProduct = {hoso 1.0, pd 1.5, vap 2.4}` は、
コメントで「既存の加工費想定単価 $0.50(HOSO) / $0.75(PD) / $1.20(VAP) の比から導出」と
明記されている。しかし実際に原価計算で使われている
`baseProcessingCostUsdPerTon = {350, 520, 780}`（= $0.35 / $0.52 / $0.78 per HOSO換算kg）
から比を取ると **{1.0, 1.486, 2.229}** であり、一致しない。

- PDでは 1.5 vs 1.486（誤差1%、実害小）
- **VAPでは 2.4 vs 2.229（誤差7.7%）** — 共通固定費の配賦がVAPへ過大に寄る

つまり「加工費の想定単価」が2つの異なる世代の値としてコード内に共存し、
固定費配賦係数だけが古い世代を参照している。
**要修正（設計レベル）**: 配賦係数を `baseProcessingCostUsdPerTon` から導出するか、
そうしない理由を明記する。

### U-2 「加工コスト」を名乗る値が3つあり、相互参照がない

| 値 | 場所 | USD/HOSO換算kg | 用途 |
| --- | --- | --- | --- |
| `baseProcessingCostUsdPerTon.pd` | `production/parameters.ts` | 0.52 | 実際の原価計算 |
| `baseProcessingCostUsdPerTon.hoso` | 同 | 0.35 | 同 |
| `processingExportCostUsdPerKg` | `scenario/parameters.ts` | 0.85 | **ベトナム国内原料の買付上限計算のみ** |

0.85 は輸出諸掛りを含む混合値で、0.35/0.52 とは母集団が違う。しかし名前からは
区別がつかず、どこにも「この2つは別物である」という注記がない。
**要修正（設計レベル）**: B-2 Layer 2 で「競争的加工コスト」を導入する際、
この3つのどれとも混同されない命名と、相互関係の明記が必須。

### U-3 プレミアムがHOSO価格の比率であるため、原料高が自動的にプレミアムを押し上げる

`premium = hosoPrice × basePremiumRatio + hosoPrice × qualityAdjustmentRatio`。
原料（HOSO）価格が $4.00 → $5.00 に上がると、加工の経済実態が何も変わらなくても
PDプレミアムは絶対額で25%増える。「プレミアム＝加工の付加価値」という
意味づけと矛盾する。
**要修正（設計レベル）**: B-2 では Potential も CompetitiveCost も
**HOSO価格に対する比率ではなく絶対額（USD/HOSO換算kg）**で定義する。

### U-4 `minPremiumUsdPerKg = 0.05` は既にハード床である

オーナーが B-2 で要求している「ソフト床（供給過剰時に競争的総コストを一時的に
下回れること）」に対し、現行は `Math.max(..., 0.05)` という**ハード床**を
国別に無条件適用している。B-2 の Layer 3 を導入する際、この既存ハード床が
ソフト床の効果を打ち消す位置関係にあることに注意が必要。
（現行値0.05は極めて低いので実務上ほぼ発火しないが、構造としては存在する。）

### U-5 国別稼働率が世界稼働率のコピーである

`productPremium.ts` は `capacityUtilization: globalUtilization` を全4か国へ同じ値で
入れている（Phase1の簡略化としてコメントに明記済み）。
産地別の逼迫度が表現できないため、「効率的供給者 vs 限界供給者」という
B-2 Layer 2 の区別を現行データの上に素直には乗せられない。

### U-6 HOSO⇔PD の直接代替が存在しない

`applyProductSubstitution` は PD⇔VAP のみを動かし、HOSOは明示的に固定している
（「HOSO⇔VAPの直接代替はPD⇔VAPより弱いという指示を保守的に0として開始」）。
B-3 が要求する「HOSO→PD転換」は、既存の代替関数ではなく
`productLifecycle` の `adoptionTurnShift`（普及の時間軸シフト）経路の拡張として
設計するのが、既存構造との整合が最も良い（§B-3で詳述）。

---

## §7 B-2以降へ引き継ぐ制約の要約

1. 価格形成の経路に加工コストが**一切ない**ため、Layer 2 は新規の入力を必要とする。
   産地別加工コストのデータは存在しない（§4-1）。
2. 数量・価格の単位は HOSO換算で完全に統一されている。新モデルもこれに従う
   （物理kg換算は併記のみ）。
3. 当期の結果が当期の価格へ戻る経路は現行に存在しない。B-3 もこの規約を守る。
4. `adoptionTurnShift`（±4四半期、EWMA遅行）という「価格→普及速度」の
   注入口が既に存在する。B-3 はこれを再利用できる。
5. 契約単価は成約時に凍結される。市場価格の変動は**新規成約にのみ**効く。
6. 既存のプレミアムは比率ベース。新モデルは絶対額ベース（§U-3）。

---

# Phase B-2〜B-5: 3層価格形成の設計と、プロトタイプによる評価

**製品コードは引き続き一切変更していない。** 以下の数値はすべて
`scripts/pdValueBasedPricingPrototype.ts`（スタンドアロン・決定論・乱数不使用）の実測である。
パラメータはすべて暫定値であり、確定値ではない。

## §8 Layer 1 — Potential PD Premium

### §8-1 採用する形

```
Potential(m,t) = clamp(
    [ P0(m) + (Pmax(m) − P0(m)) × smoothstep((t − (mid(m) − w(m)/2)) / w(m)) ]
      × (1 + (economicIndex(m,t) − 1) × econSens(m)),
    floor(m), ceiling(m) )
```

市場別パラメータ: 初期潜在値 `P0`、成熟潜在値 `Pmax`、上下限 `floor`/`ceiling`、
成熟中点 `mid`、成熟幅 `w`、経済発展感応度 `econSens`。
`smoothstep` は既存 `market/productLifecycle.ts` と同一関数（式の一貫性のため）。

### §8-2 設計判断と理由

1. **HOSO価格の比率ではなく絶対額（USD/HOSO換算kg）にする。**
   B-1 §U-3 のとおり、比率式だと原料高が加工の経済実態と無関係にプレミアムを
   押し上げる。Potential は「消費地の買い手が、HOSOではなくPDを受け取ることに
   余分に払ってよい額」であり、原料価格とは独立に定義されるべきである。
2. **初期実装ではマクロ変数を積み上げない。** 市場別の6パラメータで閉じる。
3. **将来の分解に備える。** 所得・人件費・外食/中食比率・簡便志向・加工労働の希少性・
   廃棄物処理コストへの分解は、`P0(m)` をこれらの重み付き和へ置き換えるだけで済む。
   そのために **Potential を絶対額の単一スカラーとして閉じておく**ことが重要である
   （比率や係数の積として持つと、後から分解できなくなる）。

### §8-3 暫定初期値（要校正）

| 市場 | 初期 | 成熟 | 下限 | 上限 | 中点turn | 幅 | 経済感応度 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| JP | 1.30 | 1.75 | 0.60 | 2.20 | 8 | 8 | 0.4 |
| EU | 1.10 | 1.55 | 0.55 | 2.00 | 12 | 10 | 0.5 |
| US | 1.00 | 1.40 | 0.50 | 1.90 | 10 | 8 | 0.5 |
| OTHER | 0.70 | 1.00 | 0.35 | 1.50 | 14 | 10 | 0.6 |
| CN | 0.42 | 0.72 | 0.25 | 1.20 | 18 | 10 | 0.7 |

水準の置き方: 現行モデルが暗黙に与えているPDプレミアム
（HOSO 5.3 × 0.18 = **0.954**、稼働率倍率の帯で 0.477〜1.717）を含む帯に置いた。
順序の根拠は「消費地側で剥き作業をせずに済むこと」の価値であり、
人件費・加工労働の確保しやすさ・廃棄物処理規制の厳しさで JP > EU > US > OTHER > CN とした。

## §9 Layer 2 — Competitive PD Processing Cost

### §9-1 必要になる最小の追加（現行データには存在しない）

B-1 §4-1 のとおり、産地別の加工コストは現行コードに存在しない。
必要な追加は `CountrySupplyInput` への **1フィールドだけ** である。

```ts
readonly pdProcessingUnitCostUsdPerHosoEqKg: number;   // 新規
```

能力（`pdProcessingCapacity`）は既に存在するので、加重に必要なもう一方は追加不要。

**以下の産地別コストはプロトタイプのための仮定値であり、現状の事実ではない。**

| 産地 | 能力(t/Q) | PD増分加工単価(USD/HOSO換算kg) | 位置づけ |
| --- | --- | --- | --- |
| VN | 260,000 | 0.26 | 効率的供給者（剥き身加工の集積地） |
| IN | 120,000 | 0.30 | |
| ID | 90,000 | 0.34 | |
| EC | 60,000 | 0.46 | 限界供給者（加工の集積がない） |

### §9-2 3手法の比較（実測）

| 世界稼働率 | (a) 能力加重平均 | (b) 能力加重中央値 | (c) 需給連動分位点 |
| --- | --- | --- | --- |
| 0.40 | 0.305 | 0.300 | **0.260** |
| 0.60 | 0.305 | 0.300 | **0.260** |
| 0.80 | 0.305 | 0.300 | 0.300 |
| 0.95 | 0.305 | 0.300 | **0.340** |
| 1.10 | 0.305 | 0.300 | **0.340** |

### §9-3 採用: (c) 需給連動分位点

```
q(t) = q_slack + (q_tight − q_slack) × clamp((u(t) − u_slack)/(u_tight − u_slack), 0, 1)
CompetitiveCost(t) = 能力加重 q(t) 分位点の産地単価
暫定値: q_slack = 0.25, q_tight = 0.85, u_slack = 0.55, u_tight = 1.00
```

理由:

- (a)(b) は稼働率にまったく反応しない（表のとおり定数）。「過剰なら低コスト供給者へ、
  逼迫なら限界供給者へ寄る」という要求そのものが表現できない。
- (c) は過剰時 0.260（＝最効率のVN）、逼迫時 0.340（＝中位より上の限界供給者）へ動く。
  経済学的にも「余っているときは最も安い供給者が価格を決め、足りないときは
  最後に呼び出される高コスト供給者が価格を決める」という標準的な描像と一致する。
- (a) は診断・説明用の補助指標としては有用なので、**併記して出力する**ことを提案する
  （どの水準に対して分位点が動いたのかが見えないと説明できないため）。

### §9-4 個社との分離（構造的保証）

`competitiveCost()` の引数は `産地の状態 / 稼働率 / 手法 / パラメータ` のみであり、
**プレイヤー各社のコストを受け取る口が型として存在しない。**
個社コストは `companyMargins`（＝ Actual − 自社コスト）の計算にしか現れない。
自社コスト上昇が市場価格を押し上げる経路は、実装上作れない。

## §10 Layer 3 — Actual PD Premium

### §10-1 オーナー提案の原型を、そのままでは採用しない（理由つき）

提案された形:

```
Gap(m,t)           = max(0, Potential(m,t) − CompetitiveCost(t))
ActualPremium(m,t) = CompetitiveCost(t) + Gap(m,t) × ScarcityCapture(t)
```

**この形は構造的に `CompetitiveCost` がハード床になる。** `Gap ≥ 0` かつ
`ScarcityCapture ≥ 0` なので、`Actual ≥ CompetitiveCost` が恒等的に成り立つ。
オーナー自身が「ソフト床を使い、供給過剰時には Actual が競争的総コストを
一時的に下回れるようにせよ」と指示している要件と、直接矛盾する。

実測（Potential = 1.30、CompetitiveCost = 0.30 に固定して稼働率だけを動かす）:

| 稼働率 | Capture | オーナー原案 | 採用案 | 差 | 原案は競争コストを下回れるか |
| --- | --- | --- | --- | --- | --- |
| 0.30 | 0.00 | **0.300** | 0.234 | −0.066 | **いいえ（ハード床）** |
| 0.45 | 0.00 | **0.300** | 0.254 | −0.046 | **いいえ** |
| 0.60 | 0.11 | 0.411 | 0.385 | −0.026 | **いいえ** |
| 0.75 | 0.44 | 0.744 | 0.738 | −0.007 | **いいえ** |
| 0.85 | 0.67 | 0.967 | 0.967 | 0.000 | — |
| 0.95 | 0.89 | 1.189 | 1.189 | 0.000 | — |
| 1.05 | 1.00 | 1.300 | 1.300 | 0.000 | — |

稼働率0.30という深刻な供給過剰でも、原案では価格が競争コストちょうどで止まる。

### §10-2 採用する形（原案からの変更は1項のみ）

```
Gap(m,t)        = max(0, Potential(m,t) − CompetitiveCost(t))
ScarcityCapture(t) = clamp((u(t) − u_lo) / (u_hi − u_lo), 0, 1)
Undercut(t)     = −maxUndercut × clamp(1 − u(t)/u_ref, 0, 1)          （≤ 0）

Target(m,t)     = CompetitiveCost(t) × (1 + Undercut(t))   ←【追加した項はここだけ】
                + Gap(m,t) × ScarcityCapture(t)

Actual(m,t)     = Actual(m,t−1) + speed × (Target(m,t) − Actual(m,t−1))
Actual(m,t)     = max(absoluteBackstop, Actual(m,t))       ← 数値的バックストップのみ
```

暫定値: `u_lo = 0.55`, `u_hi = 1.00`, `maxUndercut = 0.35`, `u_ref = 0.80`,
`speed = 0.35`, `absoluteBackstop = 0.02`。

`absoluteBackstop` は経済的な床ではなく、負値・ゼロ価格を防ぐ数値上の保険である
（この点は B-1 §U-4 の既存ハード床 `minPremiumUsdPerKg = 0.05` とは役割が異なる。
新モデルを入れる場合、既存のハード床は**外す**必要がある）。

### §10-3 出てはならない4構造の確認（実測）

| 禁止構造 | 判定 | 根拠 |
| --- | --- | --- |
| PDが常に儲かる | **出ていない** | 能力1.8倍の供給過剰下で Actual = 0.209。未機械化(コスト0.303)は −0.094、非効率(0.460)は −0.251 の赤字 |
| 高Potentialが供給過剰の効果を打ち消す | **出ていない** | 供給過剰下でPotentialを1.0→3.0倍にしても Actual は 0.209→0.211（**+0.002のみ**）。Capture≈0のため潜在価値を取れない |
| 自社コストが市場価格へ伝播 | **構造的に不可能** | `actualPremiumTarget` の引数は `potential / cost(産地) / utilization` のみ |
| 機械化が市場価格を上げる | **構造的に不可能** | 機械化は `companyMargins.ownCost` にしか現れない |

**ただし1点、校正上の論点を明示しておく。** 上記の供給過剰テストで、
機械化済の社（自社コスト 0.2033）はマージン **+0.006** とかろうじて黒字を維持した。
これは私が置いた仮定値で「機械化後のプレイヤーのコスト(0.2033)＜世界最効率産地の
コスト(0.26)」となっているためである。**プレイヤーの機械化後コストと、世界の効率的
供給者のコストのどちらを低く置くかは、オーナーが決めるべき校正判断**である。
前者を低くすると、完全に機械化した会社はPDで決して赤字にならない。

## §11 B-3 — HOSO→PD 需要転換の設計

### §11-1 既存機構の再利用

| 既存 | 再利用のしかた |
| --- | --- |
| `market/productLifecycle.ts` `adoptionShare(curve, turn, shift, maxShift)` | そのまま。`shift` の入力元だけを差し替える |
| `companyLab/marketEvolution.ts` `affordabilitySignalEwma`・`deriveAdoptionTurnShift` | 信号の**定義**を差し替えて再利用（EWMA α=0.35、感度8四半期、±4Qクランプはそのまま） |
| `applyProductSubstitution` | **使わない**。B-1 §U-6 のとおりこれはPD⇔VAP専用であり、HOSO⇔PDには触らない設計になっている |

### §11-2 中心信号と、実測でわかった限界

オーナー指示の中心信号:

```
AffordabilityRatio(m,t) = ActualPremium(m,t) / PotentialPremium(m,t)
```

**この信号だけでは、低価値市場でPD普及が限定的にとどまることを再現できなかった。**
ケースD（Potentialを最低水準にそろえた低価値市場）の実測:

| 版 | 初期PDシェア | 最終PDシェア | 最終 Act/Pot | 最終 絶対余剰 |
| --- | --- | --- | --- | --- |
| 比率のみ（オーナー指示どおり） | 0.300 | **0.410** | 0.62 | 0.158 |
| 絶対余剰ゲート追加（提案） | 0.300 | **0.273** | 0.53 | 0.198 |

原因: 比率は低価値市場でも中庸な値（0.62）を取るため割安シグナルが立たない。
その結果、基礎ライフサイクル曲線がそのまま走ってPDシェアが伸びてしまう。
**比率は「いつ普及するか（時間軸）」は制御できるが「そもそも普及するか（水準）」を
制御できない**（時間軸シフトの上限が±4四半期しかないため、原理的に水準を止められない）。

一方、**絶対余剰**（`Potential − Actual`、USD/HOSO換算kg）で見ると
低価値市場 0.158 vs 通常市場 0.726 と明確に差がつく。

### §11-3 提案する形（比率と絶対余剰の併用）

```
[時間軸]  cheapness(m,t)  = clamp((affRef − AffordabilityRatio(m,t)) / affRef, −1, 1)
          signal(m,t)     = signal(m,t−1) + α × (cheapness(m,t) − signal(m,t−1))
          shift(m,t)      = clamp(signal(m,t) × sens, −4, +4)          ← 既存と同じ

[水 準]  surplus(m,t)    = Potential(m,t) − Actual(m,t)
          gate(m,t)       = smoothstep((surplus(m,t) − s_lo) / (s_hi − s_lo))
          ceiling'(m,t)   = floor(m) + (ceiling(m) − floor(m)) × gate(m,t)
```

暫定値: `affRef = 0.62`, `α = 0.35`, `sens = 8`, `s_lo = 0.10`, `s_hi = 0.80`。

### §11-4 計算順序と状態更新のタイミング（当期内の循環を作らない）

```
turn t:
  ① pdShare(t)          ← 前期末に確定済み（当期は読むだけ）
  ② worldPdDemand(t)    = Σ_m consumption(m,t) × pdShare(m,t)
  ③ utilization(t)      = worldPdDemand(t) / worldPdCapacity(t)
  ④ CompetitiveCost(t)  ← 産地コスト・utilization(t)
  ⑤ Potential(m,t)      ← 市場カーブ・景気
  ⑥ Actual(m,t)         ← 平滑化（Actual(m,t−1) を起点）
  ⑦ signal(m,t) / gate(m,t) を更新
  ⑧ pdShare(m,t+1) を確定  ←【翌期にしか効かない】
turn t+1: ①へ
```

**当期の価格 Actual(m,t) が当期の構成比 pdShare(m,t) を変える経路は存在しない。**
価格は必ず翌期の構成比にしか効かない。これは既存 `marketEvolution.ts` /
`consumerInventory.ts` の規約と同一である。

### §11-5 二重計上・VAP吸収の防止

- 動かすのは **HOSO と PD の間だけ**。`vapShare(m)` には一切触れない。
  `hosoShare = 1 − vapShare − pdShare` として毎期再計算する。
  実測: 全8ケース・全turnで `|hoso + pd + vap − 1|` の最大が **2.22e-16**（浮動小数点誤差のみ）。
- 市場合計需要（`consumption(m,t)`）は本モデルが一切変更しない。構成比だけを動かす。
- 四半期あたりのPDシェア変化を `maxShareStepPerQuarter = 0.02` で制限し、急変を防ぐ。
- 市場別の下限・上限（文化・用途・成熟度）: 例 JP 0.30〜0.52 / CN 0.08〜0.34。

### §11-6 産業発展ループが成立していること（ケースEの実測）

turn6で世界PD能力を 413,400 → 768,500 t に急増させたときの時間発展（市場=US）:

| turn | 世界PD能力(t) | 稼働率 | Actual | 絶対余剰 | PDシェア | 世界PD需要(t) |
| --- | --- | --- | --- | --- | --- | --- |
| 5 | 413,400 | 0.67 | 0.434 | 0.566 | 0.317 | 277,720 |
| 6 | **768,500** | 0.37 | 0.356 | 0.644 | 0.333 | 285,596 |
| 7 | 768,500 | 0.39 | 0.306 | 0.711 | 0.353 | 296,358 |
| 9 | 768,500 | 0.41 | 0.254 | 0.873 | 0.393 | 318,819 |
| 12 | 768,500 | 0.45 | 0.229 | 1.109 | 0.420 | 343,190 |
| 16 | 768,500 | 0.47 | 0.223 | 1.177 | 0.420 | 361,851 |

**供給増 → プレミアム低下 → 遅れてPD需要増 → 新しい需給均衡**が、
指示どおりの時間差（価格は即座、普及は数四半期遅れ）で成立している。

## §12 B-4 — PD省人化との関係

### §12-1 個社側にとどまるもの

機械化が変えてよいのは、**自社の**PD加工コスト・必要人員・残業/臨時・スループット・
生産未達・成熟期のPD利益・競争力・供給可能量である。
プロトタイプでは `CompanyCost.incrementalPdCost` の1変数として表現し、
`companyMargins = Actual − ownCost` にしか現れない。

実測（ケースG、同一市場・同一需給）:

| | 自社コスト | 市場価格 Actual | 単位マージン |
| --- | --- | --- | --- |
| 機械化済 | 0.2033 | **0.533** | 0.329 |
| 未機械化 | 0.3033 | **0.533**（同一） | 0.229 |

市場価格は完全に同一で、利益だけが違う。要求どおり。

### §12-2 世界側を経由する正当な経路（設計する）

複数社・競合国の機械化が、**世界の加工能力と競争的加工コストを通じて**
Actual を下げるのは正当であり、これは設計すべき経路である。
産地の `unitCost` が下がり、同じ人手でより多く処理できるので `capacity` が増える。

実測（機械化普及度を0→1へ。単価 −33%、能力 +50% を上限とした場合）:

| 機械化普及度 | 競争コスト | 世界PD能力(t) | 稼働率 | Actual |
| --- | --- | --- | --- | --- |
| 0.00 | 0.260 | 530,000 | 0.64 | **0.400** |
| 0.25 | 0.239 | 596,250 | 0.58 | 0.253 |
| 0.50 | 0.217 | 662,500 | 0.53 | 0.190 |
| 0.75 | 0.196 | 728,750 | 0.48 | 0.167 |
| 1.00 | 0.174 | 795,000 | 0.45 | **0.146** |

産業全体の機械化が進むと Actual は 0.400 → 0.146 へ下がる。
**個社の機械化は価格を1セントも動かさないが、業界全体の機械化は価格を下げる。**
これが要求されている非対称性そのものである。

### §12-3 実装上の注意

産地の `unitCost` を機械化で動かすとき、**プレイヤー5社の機械化状態を直接
産地コストへ流し込んではならない**（それをすると自社コスト→市場価格の経路が
裏口から復活する）。産地の機械化普及は、シナリオ側の外生カーブか、
あるいは「業界全体の集計値のうちプレイヤーの寄与を十分に希釈した形」でのみ扱うべきである。
ベトナムの加工能力に対する5社のシェアは小さくない可能性があるため、
**この点は実装前にオーナー確認が必要な論点**として記録する。

## §13 B-5 — VAPへの拡張境界（実装も校正もしない）

エンジン（3層構造・時間順序・単位）はそのままVAPへ再利用できる。
ただし以下の区別を設計に残す。**本Phaseではモデルを実装も校正もしない。**

| 論点 | PD | VAP |
| --- | --- | --- |
| Potential の中心 | 消費地で**剥き作業をせずに済む**こと（回避される加工コスト） | **調理労働の節約・簡便性・製品開発・差別化** |
| 価値の積み上がり | HOSOの上 | **PDの上にさらに積み上がる** |
| 会社間の能力差 | 相対的に小さい（工程が標準的） | **強く反映される** |
| 実現価格を左右する要素 | 加工コストと需給がほぼすべて | **製品開発・品質・CTS・販売関係・納品能力が強く効く** |

**絶対に避ける構造**: VAPの総プレミアムをHOSOから直接算出すること。
それをするとPDの価値を二重計上する。VAPは必ず

```
VAP価格 = HOSO価格 + PD Actual Premium + VAP増分 Actual Premium
```

という積み上げで持ち、VAP側は**増分**のみを計算する。
これは既存 `market/destinationPricing.ts` の分解構造
（`hosoBasePrice` / `pdProcessingPremium` / `vapIncrementalPremium`）と同じ形であり、
既存構造をそのまま踏襲すればよい。

## §14 感度分析（市場=US、16四半期、最終turnの値）

| 軸 | 値 | Actual | Act/Pot | 最終PDシェア | 稼働率 | 競争コスト | Actual四半期変化の最大 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Potential水準 | ×0.6 | 0.389 | 0.46 | 0.385 | 0.67 | 0.260 | 0.022 |
| Potential水準 | ×1.0 | 0.659 | 0.47 | 0.420 | 0.73 | 0.260 | 0.038 |
| Potential水準 | ×1.5 | 1.027 | 0.49 | 0.420 | 0.76 | 0.300 | 0.064 |
| 世界能力 | ×0.6 | **1.086** | 0.78 | 0.318 | 0.88 | 0.300 | 0.066 |
| 世界能力 | ×0.9 | 0.659 | 0.47 | 0.420 | 0.73 | 0.260 | 0.038 |
| 世界能力 | ×1.4 | 0.223 | 0.16 | 0.420 | 0.49 | 0.260 | 0.001 |
| 世界能力 | ×1.8 | **0.211** | 0.15 | 0.420 | 0.38 | 0.260 | 0.001 |
| 競争コスト | ×0.6 (=0.180) | 0.641 | 0.46 | 0.420 | 0.74 | 0.180 | 0.040 |
| 競争コスト | ×1.6 (=0.416) | 0.714 | 0.51 | 0.420 | 0.71 | 0.416 | 0.036 |
| S字中点turn | 4 | 0.755 | 0.54 | 0.420 | 0.75 | 0.300 | 0.055 |
| S字中点turn | 20 | 0.490 | 0.49 | 0.413 | 0.70 | 0.260 | 0.027 |
| S字幅 | 4Q | 0.653 | 0.47 | 0.420 | 0.73 | 0.260 | 0.047 |
| S字幅 | 30Q | 0.633 | 0.48 | 0.420 | 0.73 | 0.260 | 0.036 |
| 調整速度 | 0.10 | 0.515 | 0.37 | 0.420 | 0.74 | 0.300 | 0.028 |
| 調整速度 | 1.00 | 0.686 | 0.49 | 0.420 | 0.72 | 0.260 | 0.042 |
| ソフト床割込率 | 0.00 | **0.260** | 0.19 | 0.420 | 0.42 | 0.260 | 0.000 |
| ソフト床割込率 | 0.35 | 0.216 | 0.15 | 0.420 | 0.43 | 0.260 | 0.001 |
| ソフト床割込率 | 0.70 | **0.175** | 0.12 | 0.420 | 0.43 | 0.260 | 0.002 |

### §14-1 感度分析からの結論（都合の良いケースだけを見せない）

1. **最も強い軸は世界能力**（Actual 1.086 → 0.211、5.1倍の幅）。設計意図どおり。
   能力1.4倍以上ではソフト床に張り付き、それ以上増やしても価格は下がらない（飽和）。
2. **Potential水準を変えても Act/Pot はほぼ一定（0.46〜0.49）。** 系は比例的で、
   Potentialを上げても「取り分の割合」は変わらない。暴走はしない。
3. **競争コストの転嫁率は低い（実測で約31%）。** コスト 0.180 → 0.416（+131%）に対し
   Actual は 0.641 → 0.714（+11%）にとどまる。
   これは `d(Actual)/d(cost) = 1 − ScarcityCapture` という構造から来る。
   **逼迫時ほど転嫁されず（Capture→1で転嫁率→0）、過剰時ほど転嫁される（Capture→0で転嫁率→1）。**
   経済的には正しい（逼迫時は需要側が価格を決め、過剰時はコストが価格を決める）が、
   「PD加工コストを上げれば売値も上がる」という素朴な期待は**逼迫時には満たされない**。
   これは設計上意図した挙動として明記すべきであり、隠すべきではない。
4. **S字の幅はほとんど効かない**（0.653 → 0.633、3%）。校正の労力を割く価値が低い軸。
   S字の中点は効く（0.755 → 0.490）。
5. **調整速度は発振を生まない。** 0.10〜1.00 のどこでも四半期変化の最大は 0.028〜0.042 で、
   速度1.0（＝平滑化なし）でも発振しない。ショック時（ケースF）の最大変化が 0.162 で
   これが全体の最大値。**発散も激しい発振も観測されなかった。**
6. **ソフト床は素直に効く。** 割込率 0→0.70 で Actual 0.260 → 0.175 と単調。
   割込率0では原案どおり競争コストちょうどで止まる（＝§10-1の再確認）。

## §15 8ケースの最終turn要約（市場=US）

| ケース | Potential | 競争コスト | 稼働率 | Capture | Actual | Act/Pot | PDシェア | HOSOシェア |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A 導入期（能力不足） | 1.337 | 0.300 | 0.88 | 0.73 | **0.941** | 0.70 | 0.353 | 0.587 |
| B 成長期（能力増加） | 1.400 | 0.260 | 0.59 | 0.08 | 0.364 | 0.26 | 0.420 | 0.520 |
| C 成熟期（能力過剰） | 1.337 | 0.260 | 0.42 | 0.00 | **0.215** | 0.16 | 0.420 | 0.520 |
| D 低価値市場 | 0.420 | 0.260 | 0.46 | 0.00 | 0.222 | 0.53 | **0.273** | 0.667 |
| E 供給ショック | 1.400 | 0.260 | 0.47 | 0.00 | 0.223 | 0.16 | 0.420 | 0.520 |
| F 需要ショック | 1.400 | 0.300 | 0.87 | 0.70 | **1.058** | 0.76 | 0.330 | 0.610 |
| G 機械化比較 | 1.337 | 0.260 | 0.70 | 0.33 | 0.533 | 0.40 | 0.420 | 0.520 |
| H 非効率企業 | 1.337 | 0.260 | 0.42 | 0.00 | 0.215 | 0.16 | 0.420 | 0.520 |

期待された観測との対応:

- A 高Actual・高PD利益 → Actual 0.941（8ケース中2位）、機械化済マージン 0.738。○
- B プレミアム低下・PD普及拡大 → Actual 1.0前後 → 0.364、PDシェア 0.300 → 0.420。○
- C プレミアムがコスト近傍・コスト競争 → Actual 0.215 対 競争コスト 0.260（ソフト床で下回る）。○
- D PD普及が限定的 → PDシェア 0.273（**絶対余剰ゲートを足して初めて成立**。§11-2）。○（条件つき）
- E プレミアム崩壊・後の四半期でPD需要増 → §11-6 のとおり。○
- F 稼働率とプレミアムが上昇 → 稼働率 0.62 → 0.88、Actual 0.353 → 1.058。○
- G 同一市場価格・利益だけ違う → §12-1。○
- H 高コスト社が赤字 → 非効率(0.460)のマージン −0.245。○

## §16 望ましい挙動の判定（10項目すべて成立）

| # | 挙動 | 判定 | 根拠 |
| --- | --- | --- | --- |
| D1 | 稼働率↑ → Actual↑ | ○ | u=0.60→0.385 / u=1.00→1.300 |
| D2 | Potential↑ → 取れる余地↑ | ○ | Pot=0.90→0.767 / Pot=1.60→1.311 |
| D3 | 能力↑ → Actual↓ | ○ | A(能力不足)0.941 vs C(能力過剰)0.215 |
| D4 | Act/Pot↓ → 遅れてPD普及↑ | ○ | B: Act/Pot 0.76→0.26、PDシェア 0.300→0.420 |
| D5 | PD普及↑ → PD需要↑ | ○ | B: 世界PD需要 278,000→355,699t |
| D6 | 機械化有無で同一価格・別利益 | ○ | 同一 Actual=0.533、マージン 0.329 vs 0.229 |
| D7 | 供給過剰下で非効率企業が赤字 | ○ | Actual=0.215、非効率コスト0.460 → −0.245 |
| D8 | 総需要が自発的に膨らまない | ○ | 全ケース全turnで \|和−1\| 最大 = 2.22e-16 |
| D9 | 発散も激しい発振もない | ○ | Actual四半期変化の最大 = 0.162（ケースFのショック時） |
| D10 | 自社コストが価格へ伝播しない | ○ | 式の引数に個社コストが存在しない（型で保証） |

## §17 Phase C（設計文書・テスト仕様）へ引き継ぐ論点

1. **オーナー案のハード床問題**（§10-1）。修正の採否。
2. **B-3の中心信号を比率だけにするか、絶対余剰ゲートを併用するか**（§11-2）。
   比率だけでは低価値市場が再現できないという実測がある。
3. **競争コストの転嫁率が需給で変わること**（§14-1-3）。これを仕様として明記するか。
4. **プレイヤーの機械化後コストと世界最効率産地コストの大小関係**（§10-3）。
   校正判断。完全機械化企業がPDで赤字になりうるかを決める。
5. **産地の機械化普及にプレイヤーの寄与を混ぜない方法**（§12-3）。
   ベトナム加工能力に対する5社シェアが小さくない場合の扱い。
6. **既存ハード床 `minPremiumUsdPerKg = 0.05` の撤去**（§10-2、B-1 §U-4）。
7. **B-1で見つかった単位・整合性の問題6件（U-1〜U-6）の扱い。**
   特に U-1（固定費配賦係数が古い加工費テーブル由来。VAPで7.7%乖離）は
   本モデルとは独立に修正が要る。

---

**【Phase C】** 本書（分析・調査）を受けた**正式設計書とテスト仕様**は
`docs/v2/design/pd_value_based_pricing_design.md` にある。
実装に着手する場合はそちらを参照すること。本書は根拠となる実測データの参照先として残す。
