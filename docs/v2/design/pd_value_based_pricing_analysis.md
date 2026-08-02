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
