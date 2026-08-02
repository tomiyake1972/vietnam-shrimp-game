# 加工品（PD/VAP）市場進化 — 既存実装監査

- 対象ブランチ: `feature/v2-processed-market-evolution`（`feature/v2-test15-investment-environment-integrated` HEAD `c28caf0` を基点）
- 作成日: 2026-08-02
- 位置づけ: **監査のみ**。本ラウンドでは新機構の実装は行わない。既存モジュールを「拡張する」か「作り直す」かを判断できるだけの、実際のコードパスの地図を作ることが目的。
- 併せて追加したもの: `app/lib/v2/market/__tests__/processedMarketEvolutionCharacterization.test.ts`（現行挙動の数値固定 characterization テスト、CHAR-1〜CHAR-12）

## 0. 結論の要約

意図する物語（序盤=ベトナムの加工優位／中盤=PD黄金期／終盤=他産地参入によるプレーンPDのプレミアム圧縮とVAP・営業力・品質への軸移動）に対して、**必要な部品の大半は既に存在するが、3つだけ決定的に欠けている**。

| 欠けているもの | 現状 | 影響 |
| --- | --- | --- |
| 産地別のPD/VAP**加工能力の時間発展** | 全4産地とも「加工能力 = 生産量 × 固定比率（PD 0.30 / VAP 0.10）」。どのシナリオ定義もこれを上書きしていない | 「エクアドルが後半にPD加工へ参入」を表現できない。結果、PD世界稼働率は**終盤にかけて上昇**し、プレーンPDプレミアムは圧縮されるどころか拡大する（CHAR-5で固定） |
| ベトナムの**加工優位が獲得需要へ効く経路** | ベトナムの獲得需要シェアはHOSO価格の相対競争力のみで決まり、商品構成はそこへ「世界平均構成比」を一律に掛けるだけ | 「ベトナムは加工能力があるからPD/VAP需要を多く獲れる」が表現できない |
| 営業対応力の**構造**（今回の再設計対象） | 1市場あたり処理能力が最大5,000t（漸近）で頭打ち。VAP工数係数3.0が数量そのものを1/3にする | VAP投資・生産能力投資が販売へ変換されない（Phase5/6/7の3つの構造的発見の直接原因） |

逆に、**既に十分に存在していて再実装してはいけないもの**が3つある。

1. `market/productLifecycle.ts`（SAI-5C）— 市場別のPD/VAP普及S字カーブ。JP→US→EU→OTHER→CNの時間差まで実装済みで、意図する物語とほぼ一致する。**ただし既定OFF**。
2. `market/destinationPricing.ts` + `destinationPricingParameters.ts`（Phase 8P-0A）— 仕向市場別のHOSO基礎価値／PDプレミアム／VAPプレミアムの評価差。JPのVAP係数1.2173、CNのVAP係数0.8627という差別化が**既定ONで稼働中**。
3. `companyLab/marketEvolution.ts`（SAI-5E）— 供給圧力EWMA→翌期プレミアム倍率のフィードバック、割安シグナルによる普及前倒し、PD⇔VAP代替。**ただし既定OFF**、かつ供給圧力の分子が「5社の提示量」であって「他産地の供給」ではない。

---

## 1. 世界／市場別需要はどこで決まるか

**コードパス**

```
scenario/definitions/*.ts （DEMAND トレンドのキーフレーム）
  → scenario/scenarioEngine.ts  buildDemandMarketInput（トレンド補間＋イベント効果合成）
  → scenario/marketAdapter.ts   toMarketQuarterInput
  → market/globalDemand.ts      calculateMarketDemand / calculateWorldDemand
        需要ₘ = 前期消費量ₘ × 景気指数ₘ × (1 + 人口増加率ₘ)
  → market/consumerInventory.ts planConsumerMarketQuarter（消費／在庫／購買の3層。
        deriveMarketWeightsFromDesiredPurchase が「希望購買量ベースの市場別ウェイト」を出す）
```

- 需要はすべて **HOSO換算トンの単一スカラー**（`HosoEqTons`）で、市場ごとに1つ。商品区分の内訳は需要モジュール自身は持たない。
- `consumerInventory.ts` は消費・在庫・購買を分離し、価格弾力性と在庫水準に反応する購買（`purchasePressureIndex`）まで実装済み。市場別パラメータテーブル `CONSUMER_MARKET_INVENTORY_PARAMETERS_V1` も市場ごとに個別値を持つ。

**分類: (a) 拡張可能。** 市場別の需要成長率・景気・在庫挙動は既にシナリオトレンドとパラメータテーブルで市場別に差別化できる。「US市場のPD需要が中盤から強く伸びる」は、需要総量ではなく §2 の構成比側で表現するのが既存設計の意図であり、そちらに乗せればよい。

---

## 2. HOSO/PD/VAPの構成比はどこで決まるか

**コードパス（2系統ある。ここが最重要）**

```
(A) 世界集計のPD/VAP需要（プレミアム計算の入力）
    既定: scenario 側の固定シェア（pdDemandShareOfTotalConsumption 等）
        → MarketQuarterInput.pdVapDemand { pdDemand, vapDemand }
    SAI-5C ON時: market/productLifecycle.ts applyLifecycleDemandToMarketInput
        pdDemand = Σₘ 市場消費量ₘ × mix[m].pd

(B) 市場×商品の対象需要（成約上限）
    sales/marketAdapter.ts deriveTargetDemand
      (a) ベトナム獲得需要 = marketResult.hosoPrices.VN.allocatedDemand
      (b) 商品区分へ按分 … 既定は「世界一律の商品構成比」
      (c) 市場へ按分     … 既定は priorPeriodConsumption 構成比
                            （Phase 8F-1で marketWeights を渡せば購買ベースへ）
    SAI-5C ON時: marketProductMix（= computeMarketProductMix(turn)）を渡すと
                 (b)(c)が「市場ウェイト × 市場別商品構成比」の結合形へ置き換わる
```

`market/productLifecycle.ts` の `PRODUCT_LIFECYCLE_PARAMETERS_V1` は既に次を実装している（`accelStartTurn`）。

| 市場 | PD初期→成熟 | VAP初期→成熟 | PD加速開始 | VAP加速開始 |
| --- | --- | --- | --- | --- |
| JP | 0.34 → 0.40 | 0.10 → 0.30 | turn 4 | turn 4 |
| US | 0.30 → 0.38 | 0.06 → 0.26 | turn 8 | turn 8 |
| EU | 0.28 → 0.34 | 0.05 → 0.18 | turn 10 | turn 10 |
| OTHER | 0.22 → 0.30 | 0.03 → 0.14 | turn 12 | turn 12 |
| CN | 0.12 → 0.30 | 0.01 → 0.10 | turn 16 | turn 22 |

これは「中国はHOSO中心の期間が長い／日本はPD安定＋VAP成長／米国はPD→VAPと伸びる」という意図とほぼ一致する。**(A)と(B)が同一の`lifecycleShare`関数から導出される**設計（二重計上防止）も既に守られている。

**分類: (a) 拡張可能（ただし既定ONにする判断が必要）。**
- `config.sai5.productLifecycle` は既定 `false`。Test15の現行ラボでは構成比は世界一律固定シェアのまま。
- EUの「品質・サステナビリティ・トレーサビリティがプレミアム獲得を左右する」という要件は、構成比ではなく §3/§7 側の話。

---

## 3. PD/VAPの価格・プレミアムはどこで決まるか

**コードパス（3段の積み上げ）**

```
1段目: market/hosoPricing.ts  openHosoMarket → clearHosoMarket
        国別HOSO FOB価格（需給圧力 L_i ＋ 世界共通圧力 G ＋ コスト連動アンカー ＋ 決定論的ショック）

2段目: market/productPremium.ts calculateProductPremium("pd" | "vap", ...)
        世界稼働率 = 世界PD(VAP)需要 ÷ 4か国のPD(VAP)加工能力合計
        utilizationMultiplier = clamp(1 + (稼働率 - 0.85) × 0.8, 0.5, 1.8)
        basePremiumRatio = 0.18(PD) / 0.55(VAP) × utilizationMultiplier
        国別プレミアム = 国HOSO価格 × basePremiumRatio
                       + 国HOSO価格 × ((qualityScore - 50)/100 × 0.3)
        → 理由コード ECUADOR_PD_CAPACITY_EXPANSION / PROCESSING_CAPACITY_OVERSUPPLY 等を発火

3段目: market/destinationPricing.ts decomposeVietnamProductPrices → computeMarketReferencePrice
        VN価格を hosoBase / pdProcessingPremium / vapIncrementalPremium へ分解し、
        仕向市場別係数（destinationPricingParameters.ts）を**各部分にのみ**掛ける
        CURRENT = DESTINATION_MARKET_PRICE_COEFFICIENTS_INITIAL_V1（既定ONで稼働中）
          CN  base 0.9917 / pd 0.9395 / vap 0.8627
          US  base 1.0017 / pd 1.0104 / vap 1.0352
          EU  base 1.0118 / pd 1.0710 / vap 1.1502
          JP  base 1.0168 / pd 1.0963 / vap 1.2173
          OTHER base 0.9867 / pd 0.9498 / vap 0.8819

四半期フィードバック: market/consumerInventory.ts deriveNextQuarterDestinationPriceCoefficients
        購買圧力・在庫逼迫から次期の係数を調整
SAI-5E:  companyLab/marketEvolution.ts derivePremiumRatioMultipliers（既定OFF）
        5社の供給圧力EWMAが翌期の basePremiumRatio へ倍率として効く
```

**分類: (b) 部分的に要再構成。**

- 2段目の「世界稼働率→プレミアム倍率」構造は、意図する「PD供給が増えるとプレミアムが圧縮する」を**そのまま表現できる**（分母の加工能力さえ動けばよい）。ここは変えるべきでない。→ 問題は分母を動かす仕組みが無いこと（§8）。
- 3段目の市場別係数は**静的**。時間発展の唯一の経路 `deriveNextQuarterDestinationPriceCoefficients` は、`baseValueCoefficient` / `pdPremiumCoefficient` / `vapPremiumCoefficient` の**3つすべてに同一の `factor` を掛ける**（下記）。

```ts
const factor = 1 + adjustmentRatio;
result[market] = {
  baseValueCoefficient: base.baseValueCoefficient * factor,
  pdPremiumCoefficient: base.pdPremiumCoefficient * factor,
  vapPremiumCoefficient: base.vapPremiumCoefficient * factor,
};
```

  したがって現行機構では「PDプレミアムだけが圧縮され、VAPプレミアムは維持・上昇する」という**軸移動を市場別価格側で表現できない**。ここは要再構成。

---

## 4. ベトナム勢が獲得できる需要はどこで決まるか

**コードパス**

```
market/hosoPricing.ts openHosoMarket
    demandShare[country] = worldInfluenceWeight[country] を、
      前期HOSO価格の相対乖離で調整（安い産地ほどシェアが増える softmax 的重み）
    allocatedDemand[country] = 世界需要 × demandShare[country]
      ↓
sales/marketAdapter.ts deriveVietnamDemandByProduct
    ベトナム獲得需要（HOSO換算の一本値）を、**世界平均の商品構成比**で hoso/pd/vap へ按分
      ↓
sales/marketAdapter.ts deriveTargetDemand → sales/allocation.ts allocateMarketProduct の targetDemand
```

**分類: (c) 意図する概念が存在しない（新規に作る必要がある）。**

ベトナムの獲得シェアを決めるのは **HOSO価格の安さだけ**であり、加工能力・加工品質・加工優位は一切入らない。商品別の按分も「ベトナムの商品構成は世界平均と同じ」という明示的な簡略化（`marketAdapter.ts` ヘッダに Phase4 の暫定前提として記載）。

したがって「序盤はベトナムに大きなPD/VAP加工優位があり、その分だけPD/VAP需要を多く獲れる」という物語の起点が、現状のどこにも実装されていない。

---

## 5. 営業人員／営業工数が成約量をどう制約しているか（再設計対象）

**コードパス（3層で同じ制約が現れる）**

```
層1 意思決定の受理検証:
    sales/salesForce.ts validateSalesForceHeadcountBudget
      市場ごとに重複排除した配置人数の合計 ≤ 実在営業人員数

層2 エンジン内の構造的制約（必ず通る）:
    sales/marketEffort.ts applyMarketSalesEffortCapacity
      グループ = 会社×市場
      営業工数換算数量 = 1.0×HOSO + 1.2×PD + 3.0×VAP     （salesEffortCoefficients）
      C(h) = processingCapacity(h) = 200 + 4800 × h/(h+10)  （salesForce.ts, salesForce params）
      工数 > C(h) なら scaleFactor = C(h)/工数 を**全商品へ同一に**掛けて比例縮小
      → 診断: SALES_PLAN_REDUCED_FOR_EFFORT_CAPACITY

層3 成約配分の個社上限（安全網）:
    sales/allocation.ts allocateMarketProduct
      cap = min(desiredQuantity, processingCapacity(h), targetDemand × 0.35, approvedCap)
      → water-filling で 5社＋外部選択肢（externalOptionWeight 0.35）へ配分

標準AI側のミラー実装（SAI-6.2で develop/v2 が改変済み）:
    companyLab/standardAi/decision/sales.ts buildStandardAiSalesPlans
      allocateHeadcountAcrossMarkets → computeMarketSalesEffort を
      エンジンと**同一式**で自ら適用してから販売計画を出す
```

characterization テストで固定した現行値（CHAR-9〜CHAR-11）:

| 営業人員 h | 1市場あたり処理能力 C(h) |
| --- | --- |
| 0 | 200 t |
| 5 | 1,800 t |
| 10 | 2,600 t |
| 20 | 3,400 t |
| 50 | 4,200 t |
| ∞ | 5,000 t（漸近上限） |

| ケース | 希望数量 | 工数換算 | scaleFactor |
| --- | --- | --- | --- |
| h=8 | hoso2000 / pd1000 / vap200 | 3,800 | 0.6140 |
| h=8 | hoso2000 / pd1000 / vap1000 | 6,200 | 0.3763 |
| h=20 | hoso4000 / pd3000 / vap1500 | 12,100 | 0.2810 |

さらに CHAR-11: 同一人員（h=10）で、全量HOSOなら 2,600 t 成立、全量VAPなら 866.7 t しか成立しない（ちょうど 1/3）。

**分類: (b) 要再構成。ここが今回の主目的。**

構造上の問題点を明示しておく。

1. **上限が絶対量（トン）で固定**。1市場あたり最大5,000tは、会社の生産能力・市場規模・需要の伸びと一切連動しない。生産能力を増やしても、需要が伸びても、販売可能量は動かない。→ Phase6「新工場の能力増が販売へ変換されない」の直接原因。
2. **VAP係数3.0が「数量」に掛かる**。営業工数が3倍かかるという設計意図は妥当だが、それが**販売可能トン数を1/3にする**形で効いているため、VAP開発投資でVAPの魅力を高めても、そもそもVAPを売れる量が構造的に小さい。→ Phase7「VAP支出が販売へ変換されない」の直接原因。
3. **縮小が全商品一律**。会社が「VAPを優先して売りたい」と考えても、その意思を表現する手段が無い（HOSO/PD/VAPが同一係数で削られる）。
4. **層2と層3で同じ `processingCapacity(h)` が二重に現れる**。`marketEffort.ts` のヘッダは「層2適用後は層3が数学的に非拘束」であることを証明付きで記載している。層2の式を変える場合、この証明が壊れて層3が意図せず拘束側に回る可能性があるため、**層3の cap 定義も同時に見直す必要がある**。

---

## 6. VAP商品開発スコアは現在どこに効いているか

**コードパス（全面）**

```
意思決定: CompanyLabDecision.vapProductDevelopmentSpendUsd
    許容ティア = VAP_PRODUCT_DEVELOPMENT_SPEND_TIERS_USD = [0, 100k, 250k, 500k]
      ↓
companyLab/productDevelopmentState.ts updateProductDevelopmentState
    スコア更新式に headroom (1 - score/100) を含む（Required fix 3で追加）
      ↓
companyLab/premiumPolicy.ts calculateCompanyCapabilityCoefficient
    VAP能力合成係数 = 0.4×商品開発スコア + 0.3×営業基盤 + 0.2×品質 + 0.1×納期信頼性
    （VAP_CAPABILITY_WEIGHTS_V1、未接続入力は中立50）
      ↓
companyLab/runner.ts applyAuthoritativeVapCapabilityScores
    販売計画の各行へ vapCapabilityScore を注入（既定ON。
    config.sai5.vapProductDevelopmentCompetitiveness === false のときのみ無効）
      ↓
sales/allocation.ts computeCompetitivenessBreakdown
    vapCapabilityContribution = w.vapCapability × (score/100)
    **product === "vap" の行にのみ加算**（HOSO/PDは構造的にゼロ）
    w.vapCapability = 0.08（SALES_PARAMETERS_TEST15_VAP_CAPABILITY_V1 系）
```

**効果の実測（CHAR-12）**: JP市場VAP、5社、対象需要5,000t、営業人員各8人の条件で、VAP能力スコア50の会社が879.45t、スコア90の会社が928.63t。**差は +5.6% にとどまる**。ウェイト0（既定`SALES_PARAMETERS_V1`）では差はゼロ。

つまりVAP開発スコアが効く経路は **成約競争力ウェイトの一項目（0.08）だけ**であり、
- 価格（プレミアム）には効かない
- 対象需要（獲得できる量）には効かない
- 営業対応力（工数係数・処理能力）には効かない

**分類: (b) 要再構成。** 経路そのものは正しく配線されているが、効き所が1箇所・ウェイト0.08では、投資回収に必要な効果量が構造的に出ない。「VAP開発が価格プレミアムか営業対応力のどちらかに効く」経路の追加が必要。

---

## 7. 品質・信頼・納期信頼性は現在どう効いているか

**コードパス**

```
quality/operationalRisk.ts   稼働率・残業・臨時工・複雑性・原料鮮度・増産ストレス → 運用リスク
quality/majorIncident.ts     重大インシデントの確率抽選（決定論シード）
quality/qualityOutcome.ts    不適合率・廃棄率・観測品質スコア
quality/scoreUpdates.ts      updateQualityScore / updateDeliveryReliabilityScore /
                             updateCustomerTrustScore（非対称更新＝下がりやすく上がりにくい）
quality/stateUpdate.ts       会社×商品の品質、会社×市場の信頼を CompanyLabState.qualityState へ
quality/batchAdjustment.ts   ロット単位の数量・価値調整（実損）

効き先1（成約競争力）: sales/allocation.ts competitivenessWeights
    quality 0.15 / relationship 0.15 / deliveryReliability 0.10（既定V1）
    ※ Test15版では quality 0.13 / relationship 0.13（VAP能力へ切り出し）
効き先2（国別プレミアム）: market/productPremium.ts
    国の qualityScore が referenceQualityScore(50) を上回る分 × 0.3 を上乗せ
    ただしこれは**産地（国）の品質**であり、シナリオ入力。プレイヤー会社の品質ではない
効き先3（VAP能力係数）: premiumPolicy.ts で quality 0.2 / deliveryReliability 0.1
```

**分類: (a) 拡張可能。** 品質・信頼・納期の生成と蓄積、成約への接続はいずれも十分に実装されている。

ただし意図する「EUではサステナビリティ・トレーサビリティが**プレミアム獲得の門番になる**」に対しては次のギャップがある。

- 品質は現在 **競争力ウェイトの連続的な加点**であって、**ゲート（条件を満たさなければそもそも売れない／プレミアムが付かない）ではない**。
- 市場別の品質要求水準という概念が無い（品質ウェイトは全市場共通）。
- サステナビリティ／トレーサビリティという軸自体が存在しない（品質・納期・信頼の3軸のみ）。

「門番」を市場別に作るなら、`destinationPricingParameters` に市場別の品質要求しきい値を足して `computeMarketReferencePrice` でプレミアム部分をゲートするか、`allocation.ts` の `maximumSupplierShareFor`（現在は固定値を返すだけの拡張ポイント）を市場別・品質依存にするか、のどちらかが自然な拡張点。

---

## 8. 他産地（非ベトナム）の供給能力・参入タイミングはどう表現されているか

**率直に言うと、加工能力については実質的に存在しない。**

**存在するもの**

```
market/types.ts  CountrySupplyInput
    readonly pdProcessingCapacity: HosoEqTons;    // 当該国のPD加工能力（四半期）
    readonly vapProcessingCapacity: HosoEqTons;   // 同 VAP
market/productPremium.ts
    世界能力 = Σ_{EC,IN,ID,VN} 当該国能力  → 世界稼働率 → プレミアム倍率
    ecuadorIndiaShare > しきい値 なら ECUADOR_PD_CAPACITY_EXPANSION を発火
scenario/types.ts  ScenarioVariableId に "PD_PROCESSING_CAPACITY" / "VAP_PROCESSING_CAPACITY" が存在
```

**存在しないもの**

```
scenario/definitions/*.ts のいずれにも PD_PROCESSING_CAPACITY / VAP_PROCESSING_CAPACITY
トレンドは**一つも定義されていない**（grep結果ゼロ）。したがって常にフォールバックが使われる:

  scenario/scenarioEngine.ts
    pdCapacityFallback  = productionRaw × params.defaultPdCapacityRatioOfProduction  (= 0.30)
    vapCapacityFallback = productionRaw × params.defaultVapCapacityRatioOfProduction (= 0.10)

→ 全4産地とも「加工能力 = 生産量 × 同一固定比率」。産地別の加工優位も、参入時期も、
  参入によるS字的な能力立ち上がりも存在しない。
```

`ecuadorEarlyExpansion.ts` / `ecuadorDelayedExpansion.ts` は**養殖能力（COUNTRY_CAPACITY）・稼働率・輸出適格率**を動かすシナリオであり、PD加工能力は動かさない（生産量が増えれば加工能力も0.30倍で自動的に増えるが、これは「参入」ではなく単なる比例スケール）。

**実測での帰結（CHAR-5・CHAR-6）**: baselineシナリオ・ライフサイクルONで、PD世界稼働率は turn1 = 0.4633 → turn32 = 0.6998 と**上昇**する。VAP世界稼働率は 0.2475 → 1.1052 と大きく上昇。つまりPD/VAPともプレミアムは終盤にかけて**拡大**し、意図する「後半のプレーンPDプレミアム圧縮」とは**逆方向**に動く。

**分類: (c) 実質的に存在しない。新規に作る必要がある。**

ただし**作り方は既存の枠内で完結する**（ここは朗報）。`PD_PROCESSING_CAPACITY` は既にシナリオ変数IDとして定義済みで、`scenarioEngine.ts` は `trendValueOrDefault` でトレンドがあればそれを優先する。したがって:

- 新しいモジュールを作る必要はない。`scenario/definitions/commonTrends.ts` に産地別のPD/VAP加工能力トレンド（EC は turn 16 以降に立ち上がる、VN は序盤から高い、等）を追加し、`baseline.ts` 他へ組み込むだけで、`productPremium.ts` の世界稼働率経由でプレミアム圧縮が自然に発生する。
- これは「既存モジュールを拡張する」方針にきれいに合致する。

---

## 9. 標準AIは需要成長・投資機会を認識できるか

**認識できるもの（SAI-5F、既存）**

```
companyLab/standardAi/types.ts StandardAiObservation
    lifecycleSharesByMarket?      前期に適用された市場×商品構成比
    lifecycleTrendByMarket?       構成比の四半期トレンド（前期−前々期）
    productSupplyPressureByProduct?  5社提示量÷対象需要のEWMA
    marketPremiumByProduct        前期のPD/VAP市場プレミアム実績

使い先:
  decision/capex.ts  「ライフサイクル成長エントリ」
      公開トレンド ≥ しきい値 かつ 前期稼働率 ≥ しきい値 かつ 在庫・資金が安全
      → 能力不足が顕在化する**前に**ライン増設を提案（VAP_GROWTH_ENTRY / LIFECYCLE_GROWTH_PURSUED）
  decision/sales.ts  growthTrendResponsiveness（成長トレンドへの追随）
                     oversupplyRetreatSensitivity（供給過剰時の後退）
  decision/capex.ts / sales.ts  marketPremiumByProduct → orderQuantityFactor
```

つまり **需要成長を認識して先回り投資する枠組みは既に存在する**。ただし:

- これらは **`config.sai5.productLifecycle` / `supplyPremiumFeedback` がONのときだけ**値が入る（既定OFF）。OFFなら `lifecycleTrendByMarket` は `undefined` で、成長エントリ判定は丸ごとスキップされる。
- Phase8のTest15標準AI自動プレイで確認したとおり、**新投資タイプ（`newFactoryConstruction` / `pdMechanization` / `vapProductDevelopmentSpendUsd`）は標準AIの意思決定に一度も現れない**。`decision/capex.ts` に該当文字列が存在せず、`vapProductDevelopmentSpendUsd` は `standardAi/` 配下のどこにも出現しない。これは実装漏れではなく未実装（#05の担当範囲）。

**分類: (a) 拡張可能。** 認識の器（observation フィールド）と、それを使う判断の型（成長エントリ）が既にある。新しい市場進化シグナル（産地別加工能力の逼迫度など）を足す場合も、`observation.ts` にフィールドを1つ増やして `decision/capex.ts` の既存分岐へ接続するだけで済む。

---

## 10. オーナーの判断を仰ぐべき設計上の論点

### 論点1: SAI-5 一式を既定ONにするか

`productLifecycle` / `supplyPremiumFeedback` / `salesBaseAccumulation` はいずれも既定OFFで、Test15のラボはこれらが無効な状態で回っている。今回の市場進化はこれらの上に積むのが自然だが、既定ONにすると**Test15の既存セーブとの数値互換性が失われる**（構成比が世界一律固定→市場別S字へ変わるため）。

- 案A: 新シナリオ／新ラボでのみONにし、Test15の既存ラボはOFFのまま据え置く。
- 案B: 既定ONに切り替え、Test15は「SAI-5前の環境」として凍結する。

**これはゲーム運営の判断であり、こちらで決めるべきではない。**

### 論点2: SAI-5Eの「供給圧力」の分子を拡張するか

`companyLab/marketEvolution.ts` の供給圧力は **5社（プレイヤー会社）の提示量**が分子。意図する物語の「他産地がPD供給を増やしてプレミアムが圧縮する」は、5社ではなく**他産地の能力**が主因のはずで、意味が異なる。

- 案A: §8の産地別加工能力トレンドで `productPremium.ts` の世界稼働率を動かし、SAI-5Eはそのまま「5社自身の供給過剰による自滅」を表す別チャネルとして併存させる（2つの因果が独立に効く）。
- 案B: 供給圧力の定義（`SupplyPressureDefinition` に既に4候補が用意されている）に「他産地供給を含む」定義を足して一本化する。

**併存（案A）が既存設計を壊さないが、二重にプレミアムが圧縮されないかの検証が必要。** どちらを採るかは要判断。

### 論点3: 営業対応力の上限を「絶対量」から何へ変えるか

これが最大の設計判断。現行は「1市場あたり最大5,000t」という会社規模・市場規模から独立した絶対値。候補:

- 案A: 上限を**対象需要に対する比率**にする（例: `min(絶対上限, 対象需要 × カバレッジ関数(h))`）。市場が伸びれば売れる量も伸びる。
- 案B: 上限を**自社の生産能力に連動**させる（新工場を建てれば販売可能量も増える）。Phase6の問題は直接解けるが、「営業が制約」という設計意図が薄れる。
- 案C: VAP工数係数3.0を、**数量の縮小ではなく人員必要量の増加**として表現し直す（同じ数量を売るのに3倍の人員が要るが、人員を割けば売れる）。実質的には案Aと組み合わせる形。

**「営業力が競争軸として意味を持ち続けること」と「投資が販売へ変換されること」の両立点をどこに置くかは、ゲームデザインの判断。** こちらから1案に絞るべきではないと考える。

### 論点4: 「PD/VAPが常に儲かる」を避ける失敗条件をどこに置くか

現状、失敗条件として機能し得る既存機構は次のとおり。設計時にどれを主軸にするかを決めておきたい。

- 加工能力過剰 → 稼働率低下 → プレミアム圧縮（`productPremium.ts`、§8を作れば有効化される）
- 営業工数の食い合い（VAPを増やすとHOSO/PDが売れなくなる、`marketEffort.ts`）
- 品質低下による信頼失墜（`quality/scoreUpdates.ts` の非対称更新）
- 固定費増（新工場・PD省人化の減価償却と人件費）
- 資金繰り（Phase5で確認したとおり、これが最も強く効く）

### 論点5: ベトナムの加工優位を「需要獲得」に効かせるか（§4）

現状ベトナムの需要獲得シェアはHOSO価格の安さだけで決まる。加工優位を効かせるには `hosoPricing.ts` の `demandShare` 計算に手を入れるか、`marketAdapter.ts` の商品別按分（現在「世界平均と同じ」）を産地別能力比で置き換えるか。**後者のほうが既存の価格形成に触れずに済み、影響範囲が小さい。**

---

## 11. develop/v2（SAI-6.1〜6.4）との乖離について

`origin/develop/v2` は `7ee410b` へ進み、SAI-6.1〜6.4（Situation Diagnosis / Commercial Plan / Delivery Demand / Inventory & Production Plan）が入った。Test15の19パッチは未マージのままで、`standardAi/autoplay/__tests__/buildLog.test.ts` で衝突する。

**変更範囲（c28caf0 → 7ee410b の差分、22ファイル・+1823行）**

| 領域 | ファイル | 今回の作業との衝突リスク |
| --- | --- | --- |
| 新規追加（衝突なし） | `standardAi/diagnosis/situationDiagnosis.ts` / `currentPeriodDeliveryDemand.ts` / `productionRequirement.ts` | 低。純粋な新規ファイル |
| **要注意** | `standardAi/decision/sales.ts` | **高**。SAI-6.2が `realisticSalesByProduct` を追加し、`fixture.salesForceHeadcountTotal` → `observation.salesForceHeadcountTotal` へ切り替えている。§5の営業対応力を再設計すると、標準AI側のミラー実装（`computeMarketSalesEffort` を自ら呼ぶ箇所）も必ず直す必要があり、**同じ関数の同じ行を両側から触る** |
| 中 | `standardAi/observation.ts`（+42行）、`standardAi/types.ts`（+6行）、`policy.ts`（+72行）、`pressures.ts`、`reasonCodes.ts` | 中。市場進化シグナルを observation へ足すなら同じファイルを触る。追加位置を末尾に寄せれば機械的に解消できる程度 |
| 低 | `standardAi/decision/production.ts` | 低。生産計画の入力を `realisticSalesByProduct` へ切り替える変更。市場側を触る今回とは領域が違う |
| 無関係 | `aiExplanation/claudeClient.ts`、`api/.../ai-explanation/_lib/handlers.ts`、docs | なし |

**この乖離が今回の作業に与える影響の見立て**

1. **市場側（`app/lib/v2/market/**`、`scenario/**`）を触る限り、衝突はほぼ発生しない。** SAI-6.xはこれらに一切触れていない。§8の産地別加工能力トレンド、§3の市場別係数の時間発展、§2のライフサイクル拡張は、いずれも安全に進められる。
2. **`sales/marketEffort.ts` の再設計（§5）だけは、必ずSAI-6.2と正面から重なる。** 実装順としては、市場側（需要・価格・産地能力）を先に片付け、営業対応力の再設計は develop/v2 との統合方針が決まってから着手するほうが、手戻りが小さい。
3. characterization テストは `market/__tests__/` 配下の新規ファイルであり、`buildLog.test.ts` の衝突とは無関係。SAI-6.x をマージした後も、そのまま「何が動いたか」の検出器として機能する。

**推奨**: 本ラウンド以降の実装は §8 →（§2/§3）→ §4 → §5 の順で進め、§5 に着手する前に Test15 19パッチと SAI-6.x の統合（`buildLog.test.ts` の衝突解消）を先に片付けることを提案する。

---

## 12. characterization テストが固定した現行挙動

`app/lib/v2/market/__tests__/processedMarketEvolutionCharacterization.test.ts`（12テスト、全pass）

| ID | 固定した内容 |
| --- | --- |
| CHAR-1 | 世界需要とVN獲得需要（baseline turn1/8/16/24/32）。turn1: 1,200,000 / 216,000 → turn32: 1,398,637 / 251,754.66 |
| CHAR-2 | ライフサイクルON/OFFで市場全体需要・対象需要総和が完全一致（構成比のみを扱う設計の不変条件） |
| CHAR-3 | 市場別商品構成比のS字カーブ値（turn1/16/32、行和=1） |
| CHAR-4 | VN基準価格とPD/VAP世界稼働率（ライフサイクルON/OFF両方） |
| CHAR-5 | **PD世界稼働率が終盤に上昇する**（0.4633 → 0.6998）＝プレーンPDプレミアムの後半圧縮が現状存在しない |
| CHAR-6 | 4産地のPD/VAP加工能力が生産量の同一固定比率（0.30 / 0.10）＝産地別加工優位が存在しない |
| CHAR-7 | 仕向市場別参照価格（VAP: JP 8.6291 > EU 8.4243 > US 8.0510 > OTHER 7.5640 > CN 7.5329） |
| CHAR-8 | 市場×商品別の対象需要（turn32、ライフサイクルON/OFF） |
| CHAR-9 | 営業人員→処理能力曲線（h=0:200t 〜 漸近上限5,000t） |
| CHAR-10 | 営業工数換算（1.0/1.2/3.0）と超過時の比例縮小係数 |
| CHAR-11 | **同一人員でVAPのみを売る場合、HOSOのみの場合のちょうど1/3しか成立しない** |
| CHAR-12 | VAP能力スコア50→90の成約量押し上げが **+5.6%** にとどまる（ウェイト0.08）。既定`SALES_PARAMETERS_V1`では差ゼロ |

いずれも「この値が正しい」ことではなく「現在この値である」ことを固定するテスト。実装変更で失敗したら、期待値を更新したうえで**何がどれだけ動いたか**をそのラウンドの報告に残すこと。

---

# 【実装ラウンド1】市場構造（監査項目 8 → 2 → 3 → 4）

作成日: 2026-08-02 / コミット `b7a5a0d` `f4afb01` `72aef60` `0520969`

コーディネーターが監査の5つの未決事項へ下した判断を、実装の前提としてここに記録する
（**coordinator decision, owner may override**。判断理由も併記し、後から見直せるようにする）。

| # | 判断 | 理由 |
| --- | --- | --- |
| 1 | SAI-5の既定値は変更しない。市場進化は新ラボがopt-inする config surface として導入する | Test15の既存環境・保存データを壊さないことが上位制約。Test15の目的は市場経済ではなく機能検証（入力/保存/Excel/UI）。Test16環境がこれをONにする |
| 2 | SAI-5Eの供給圧力と産地参入の2チャネルは統合せず併存させる。ただし合成を明示的かつ有界にする | 「5社の短期的な供給過剰」と「他産地の構造的な加工参入」は別の因果。ただし二重圧縮は実在するリスクなので、単一のクランプ済みプレミアム倍率を通す |
| 3 | 営業対応力は本ラウンドでは触らない（次ラウンド） | 監査の推奨順序どおり。§5はSAI-6.2と正面衝突するため、統合方針が決まってから |
| 4 | 失敗条件は既存チャネルのみを使う。新しい罰則機構は作らない | PD/VAPが一様に儲かってはならない。ケースD（無調整の過剰投資）は失敗する必要がある |
| 5 | 加工優位は需要獲得へ効かせる。ただし `marketAdapter.deriveVietnamDemandByProduct` 側（侵襲の小さい方）で行う | `hosoPricing` の `demandShare` を書き換えると既存の価格形成に波及する。原料シェアと加工品シェアは分離可能でなければならない |

## §a 産地別PD/VAP加工能力の時間発展

**新規**: `app/lib/v2/market/processingCapacityEvolution.ts`
**テスト**: `app/lib/v2/market/__tests__/processingCapacityEvolution.test.ts`（PCE-1〜10）

シナリオ定義のトレンドではなく **入力を書き換える opt-in アダプター** として実装した。
`scenario/definitions/*.ts` に `PD_PROCESSING_CAPACITY` トレンドを足すと baseline シナリオを
使う既存のTest15ラボの数値が変わってしまうため（判断1の制約）、`market/productLifecycle.ts`
（SAI-5C）と同じ形にそろえた。価格形成・プレミアム算出の式は一切変更していない。
`productPremium.ts` の「世界稼働率 = 需要 ÷ 4か国の加工能力合計」の**分母だけ**を動かす。

### 実測: 物語の弧（baseline・ライフサイクルON・シード変動なし）

| turn | PD世界稼働率 | PDプレミアム比率 | VAP世界稼働率 | VAPプレミアム比率 |
| --- | --- | --- | --- | --- |
| 1 | 0.9858 | 0.2296 | 0.5546 | 0.4500 |
| 4 | 0.9740 | 0.2279 | 0.5688 | 0.4563 |
| 8 | 0.9635 | 0.2263 | 0.6653 | 0.4987 |
| 12 | 0.9574 | 0.2255 | 1.0116 | 0.6511 |
| 16 | 0.8220 | 0.2060 | 1.3211 | 0.7873 |
| 20 | 0.6635 | 0.1831 | 1.3622 | 0.8054 |
| 24 | 0.6135 | 0.1759 | 1.2796 | 0.7690 |
| 28 | 0.6105 | 0.1755 | 1.1478 | 0.7110 |
| 32 | 0.6130 | 0.1759 | 1.0319 | 0.6600 |

プレミアム比率は VN HOSO 価格に対する比（＝価格水準の上昇を除いたプレミアムの厚み）。

- **CHAR-5 が反転した**。監査時点は turn1 0.4633 → turn32 0.6998 と PD 稼働率が**上昇**していた。
  実装後は turn1 0.9858 → turn12 0.9574（黄金期の高原）→ turn16 以降に急落 → turn32 0.6130。
  PDプレミアム比率は **-23%** 圧縮される。
- VAP は逆に turn20 でピーク（稼働率 1.36 = 能力逼迫）、turn32 でも 1.03 と 1 を超えたまま。
- **VAP/PD プレミアム比は 1.96倍（turn1）→ 3.75倍（turn32）**。これが競争軸の移動の定量表現。
- `ECUADOR_PD_CAPACITY_EXPANSION` と `PROCESSING_CAPACITY_OVERSUPPLY` の理由コードが
  turn16〜20 以降に発火し、圧縮の原因が説明可能な形で出力される。

### パラメータ表（すべて「加工能力 ÷ 当該国の当期生産量」の比率、無次元。turn は四半期）

| 産地 | 商品 | 初期比率 | 成熟比率 | 参入turn | ランプ期間 | 参入前成長/Q | 事業上の意味 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| VN | pd | 0.36 | 0.42 | 6 | 16 | 0.002 | 剥き身加工の集積地。序盤からEC比12倍の優位。伸びしろは小さい |
| VN | vap | 0.14 | 0.22 | 6 | 16 | 0.001 | 加熱・味付け加工の蓄積。終盤も他産地の2倍以上を維持 |
| IN | pd | 0.10 | 0.30 | 10 | 12 | 0.002 | 既存のPD加工基盤があるため立ち上がりが早い |
| IN | vap | 0.02 | 0.08 | 20 | 10 | 0.0005 | VAPは製品開発の蓄積が要るため遅い |
| ID | pd | 0.11 | 0.26 | 16 | 10 | 0.002 | 国内消費比率が高く輸出加工への転換が遅い |
| ID | vap | 0.03 | 0.07 | 26 | 6 | 0.0005 | 最も遅い参入 |
| EC | pd | 0.03 | 0.38 | 14 | 12 | 0.001 | 世界最大の原料供給国。加工は輸入国側で行われてきた。turn14から大規模投資で一気に立ち上がる |
| EC | vap | 0.005 | 0.07 | 24 | 8 | 0.0002 | 原料優位だけではVAPに追いつけない |

| 変動幅パラメータ | 値 | 意味・範囲 |
| --- | --- | --- |
| `maxEntryTurnShift` | 3 | 参入turnのシード差の上限（±3四半期）。EC の PD 参入は必ず turn11〜17 に起きる |
| `maxRampSpeedVariation` | 0.2 | ランプ期間の倍率差（0.8〜1.2倍）。到達比率は変えない |

**運任せにしていないこと**: シフト・速度はどちらも上下限つきで、`matureRatio` は不変。
つまり「ECがPD加工へ参入する」という事実そのものはどのシードでも必ず起き、変わるのは
山谷の時期と鋭さだけ（PCE-5・PCE-10 が4シードで検証）。

## §b 市場別商品ライフサイクルの検証と調整

**変更**: `app/lib/v2/market/productLifecycle.ts` に `PRODUCT_LIFECYCLE_PARAMETERS_MARKET_EVOLUTION_V1` を追加
**テスト**: `app/lib/v2/market/__tests__/productLifecycleMarketArc.test.ts`（PLA-1〜6）

パラメータ値の見た目ではなく、32四半期分の実機出力（`computeMarketProductMix`）を
実装指示§3の市場別記述と突き合わせた。

| 市場 | 指示の記述 | 実測（V1） | 判定 |
| --- | --- | --- | --- |
| JP | 安定的に大きいPD ＋ 労働力不足・厨房コスト由来のVAP成長 | PD 0.34→0.40（+0.06、最大伸長turn8）／VAP 0.10→0.30（3.0倍、最大伸長turn8） | ○ |
| US | PDが伸び、**その後**VAPが強く伸びる | PD 0.30→0.38／VAP 0.06→0.26。**最大伸長がどちらも turn12 で完全に重なる** | **×** |
| EU | 品質・サステナビリティ・トレーサビリティを伴いPD/VAPへ移行 | HOSO 0.67→0.48／PD 0.28→0.34／VAP 0.05→0.18（3.6倍） | ○（品質ゲートは§7の別論点） |
| CN | HOSO中心の期間が最も長い | HOSO比率が全turnで全市場最大。PD最大伸長turn21・VAP turn26と最遅 | ○ |
| OTHER | 平均的な後発 | 最大伸長turn17 | ○ |

**調整したのはUS市場のみ**: `US.pd.accelStartTurn` 8→6、`US.vap.accelStartTurn` 8→12。

| | before (V1) | after (調整版) |
| --- | --- | --- |
| US.pd 最大伸長turn | 12 | 10 |
| US.vap 最大伸長turn | 12 | 16 |
| US.pd 到達構成比 | 0.38 | 0.38（不変） |
| US.vap 到達構成比 | 0.26 | 0.26（不変） |

到達点は変えず、加速の時期だけをずらした。他4市場は V1 と全turnで完全一致（PLA-2 が検証）。
V1 は削除せず残し、`config.marketEvolution.tunedProductLifecycle` で選択する。

## §c 商品別の価格係数発展と商品別成約競争力

**新規**: `app/lib/v2/market/destinationPricingEvolution.ts`
**変更**: `app/lib/v2/sales/parameters.ts`（`CompetitivenessWeights` 型抽出＋商品別プロファイル）、`app/lib/v2/sales/allocation.ts`（商品別ウェイトの参照）
**テスト**: `app/lib/v2/market/__tests__/destinationPricingEvolution.test.ts`（DPE-1〜9）

### c-1 商品別の係数発展（監査§3のブロッカー解消）

```
baseValueCoefficient_next  = base.base × factorCommon
pdPremiumCoefficient_next  = base.pd   × factorCommon × clamp(1 + 0.4 × pdMixShift,  0.85, 1.30)
vapPremiumCoefficient_next = base.vap  × factorCommon × clamp(1 + 1.2 × vapMixShift, 0.85, 1.30)
最終的に base 比 0.70〜1.45 でクランプ
```

`factorCommon` は既存の `deriveNextQuarterDestinationPriceCoefficients` の出力から
「共通適用後 ÷ 固定係数」として復元する（同じ式を再実装せず、分岐を作らない）。

**tilt の情報源に世界稼働率を使わなかった理由**: それは `productPremium.ts` が既に
`utilizationMultiplier` としてプレミアムへ反映しており、ここで再度使うと同じ因果を
二重計上する。代わりに「その市場の需要構成がturn1からどれだけその商品へ寄ったか」を使う。
これは現在どの価格経路にも入っていない唯一の未使用シグナルであり、実装指示が挙げる
プレミアム要因のうち「消費者の所得・物価水準」「家庭内調理の減少」「外食の厨房人件費」
「市場ごとのニーズ適合」を市場別に凝縮した観測量にあたる。

**判断2（二重圧縮の歯止め）の実装**: 共通倍率と商品別傾きは単一の合成倍率へ集約してから
0.70〜1.45 でクランプする。DPE-6 が最悪ケース（共通倍率0.3倍・3.0倍）でも範囲内に
収まることを検証している。

`DestinationCoefficientEvolutionBreakdown` により、共通倍率・構成比シフト・商品別傾き・
クランプ発動の各成分が追跡可能（Excel/CSV へそのまま出せる形）。

| パラメータ | 値 | 単位・意味 | 範囲の根拠 |
| --- | --- | --- | --- |
| `pdShiftWeight` | 0.4 | 係数倍率の変化 ÷ 構成比pt | 構成比の最大移動幅は CN.pd の +0.18pt なので、PD係数の最大変化は +7.2% |
| `vapShiftWeight` | 1.2 | 同上 | JP.vap の +0.20pt で +24%。PDの3倍の反応 |
| `tiltMultiplierFloor/Cap` | 0.85 / 1.30 | 商品別傾きの範囲 | 需要構成の移動だけで価格が倍・半分にならない安全域 |
| `coefficientMultiplierFloor/Cap` | 0.70 / 1.45 | 共通倍率×傾きの合成範囲 | SAI-5Eのプレミアム倍率との二重圧縮に対する最後の歯止め |

### c-2 商品別成約競争力（必須2性質）

`SALES_PARAMETERS_MARKET_EVOLUTION_PRODUCT_WISE_V1`

| 商品 | price | coverage | relationship | quality | delivery | salesBase | vapCapability |
| --- | --- | --- | --- | --- | --- | --- | --- |
| hoso | 0.50 | 0.25 | 0.10 | 0.08 | 0.07 | 0 | 0 |
| pd | 0.45 | 0.24 | 0.12 | 0.11 | 0.08 | 0 | 0 |
| vap | 0.20 | 0.18 | 0.20 | 0.18 | 0.09 | 0 | 0.15 |

各行の合計は 1.0（`externalOptionWeight` 0.35 との相対バランスを保つため）。

**必須性質1（PDのコモディティ性 / VAPのばらつき）** — 能力35の会社（価格据置）に対する
能力95の会社（+$0.50）の成約量比:

| ウェイト | HOSO | PD | VAP |
| --- | --- | --- | --- |
| 現行（全商品共通） | 1.350 | 1.350 | 1.426 |
| 商品別プロファイル | **1.145** | **1.228** | **1.754** |

現行では HOSO と PD が完全に同一（構造的にばらつきの差が生まれない）。商品別プロファイルでは
HOSO < PD < VAP の順序が成立し、VAP のばらつきは PD の 1.43 倍。

**必須性質2（低能力の値上げは得しない）** — 同一能力の会社が +$0.50 値上げしたときの成約量変化:

| 能力 | HOSO | PD | VAP |
| --- | --- | --- | --- |
| 35 | -10.5% | -9.7% | -5.2% |
| 50 | -9.7% | -8.8% | -4.2% |
| 95 | -7.9% | -6.9% | -2.5% |

どの商品・どの能力でも値上げは必ず成約量を減らす（`price` ウェイトをゼロにしていないため、
`priceScore = exp(-3.0 × 価格乖離)` の弾力性がそのまま効く）。能力が高い会社ほど減り方が
小さいのは「強いブランドは需要が非弾力的だがゼロではない」という正しい経済で、
**能力35で値上げ（864t）は能力35で据置（912t）より必ず不利**。

## §d ベトナムの加工優位 → 加工品需要の獲得

**変更**: `app/lib/v2/sales/marketAdapter.ts`（`deriveVietnamDemandByProduct` / `deriveTargetDemand`）
**テスト**: `app/lib/v2/sales/__tests__/processingAdvantageDemandCapture.test.ts`（DCA-1〜6）

```
rawShare          = VN allocatedDemand ÷ 世界需要         （既存。HOSO価格競争で決まる。変更しない）
processingShare_p = VN の p 加工能力 ÷ 世界の p 加工能力   （新規。原料とは別の軸）
tilt_p            = clamp((processingShare_p / rawShare)^0.6, 0.5, 2.5)
weight            = worldMix_p × tilt_p （hosoは tilt=1）→ 合計で正規化して総量保存
```

| パラメータ | 値 | 意味・範囲の根拠 |
| --- | --- | --- |
| `advantageExponent` | 0.6 | 加工能力シェア比を構成比の傾きへ変換する指数。1未満にすることで「加工能力があっても営業・品質が無ければ売れない」という後段の制約と役割を分担する |
| `tiltFloor` / `tiltCap` | 0.5 / 2.5 | 傾き倍率の範囲。加工能力ゼロでも需要が消滅せず、独占もしない |

**総量保存**: ベトナムの獲得需要の合計は不変（構成比のみを傾ける）。総量まで増やすと
HOSO市場清算で決まった原産地シェアと二重計上になる。SAI-5Cの結合形（`marketProductMix`）
使用時は、構成比行列の各行へ同じ傾きを掛けて行ごとに再正規化する
（行和=1 を維持するため市場合計・全体合計とも保存。DCA-2 が5つのturnで検証）。

> **実装中に見つかった落とし穴**: `deriveTargetDemand` は `marketProductMix` が渡されると
> 商品別内訳を構成比行列だけで決め、`vietnamDemandByProduct` は**合計値としてしか使わない**。
> 最初の実装では加工優位の傾きがライフサイクル有効時に丸ごと消えていた（DCA-3が検知）。
> 構成比行列側にも同じ傾きを適用して修正した。

### 「ベトナムだから儲かる」にしていないことの実証（DCA-5）

ここで広がるのは **5社共通の対象需要の上限**だけである。個社が成約・生産・入金へ
変換するには既存の各制約をすべて通る必要がある。

- 対象需要を 5,000t → 10,000t と2倍にしても、販売希望量50tの会社の成約量は **50t のまま**
- 営業人員0人の会社は、販売希望量を5,000tにしても処理能力 **200t** で頭打ち
- 成約競争力は価格・カバレッジ・関係性・品質・納期・VAP能力の合成であり、
  能力の無い会社のウェイトは低いまま
- 生産計画は原料在庫・工場能力・Worker能力に拘束され、資金制約も別途かかる

さらに会社ラボでは `applyProductionSupplySignalsToMarketInput` により VN の PD/VAP 加工能力が
**5社が実際に計画した生産量**へ置き換わる。したがってラボ内では「ベトナムだから」ではなく
「5社が実際に加工能力を積んでいるから」対象需要が広がる構造になっている。

### 実測

| | turn1 | turn32 |
| --- | --- | --- |
| VNのPD加工能力シェア | 原料シェアを大きく上回る | 低下（EC/IN参入） |
| PD傾き | > 1 | 縮小 |
| VAP傾き | PD傾きより大 | PD傾きより大のまま（軸移動） |

序盤は PD/VAP の対象需要が増え、未加工HOSOの対象需要が減る（＝加工へ回る）。
終盤は他産地の追い上げで PD の傾きが縮小し、VAP の優位だけが残る。

## 機能フラグ一覧（`config.marketEvolution`、すべて既定OFF）

| フラグ | 対応する項目 | 有効時の挙動 |
| --- | --- | --- |
| `originProcessingCapacity` | §a | 産地別PD/VAP加工能力を参入時期つきS字カーブへ置き換える |
| `tunedProductLifecycle` | §b | 商品ライフサイクルに調整済みパラメータ表を使う（`sai5.productLifecycle` 有効時のみ意味を持つ） |
| `perProductDestinationPricing` | §c-1 | 仕向市場価格係数を商品別に発展させる（ライフサイクル構成比が必要） |
| `productWiseCompetitiveness` | §c-2 | 商品別の成約競争力ウェイトプロファイルを使う |
| `processingAdvantageDemandCapture` | §d | 加工優位を対象需要の商品構成へ反映する |

永続化スキーマ（`persistence/schema.ts`）で復元される。未指定の保存データはすべて
undefined＝全OFF＝従来挙動（マイグレーション不要）。

## 意図どおりにならなかったこと・積み残し

1. **PDの絶対価格は終盤も上昇している**。圧縮されるのは *プレミアム比率*（HOSO価格比 0.2296 → 0.1759）
   であって、PD の絶対価格ではない（5.09 → 5.52）。HOSO 基準価格自体が養殖コスト上昇で
   上がるためで、経済的には正しいが、「PDが安くなる」という直感的な見え方にはならない。
   プレイヤーへの見せ方（Excel/UIでプレミアム比率を明示する）で対応すべき論点。
2. **§c-1 の効果は §a に比べて小さい**。構成比の移動幅が最大 0.20pt なので、VAP 係数の
   上昇は最大でも +24%。軸移動の主因は §a（世界稼働率）であり、§c-1 は市場別の色付けに
   とどまる。これは二重計上を避けた結果として意図的だが、市場別の差をもっと効かせたい場合は
   `vapShiftWeight` の引き上げが最初の校正点になる。
3. **EU の品質・サステナビリティ・トレーサビリティによる「門番」は未実装**。監査§7で
   「品質は連続的な加点でありゲートではない」と指摘したとおりで、本ラウンドのスコープ外。
   拡張点は `allocation.ts` の `maximumSupplierShareFor`（現在は固定値を返すだけのフック）か
   `computeMarketReferencePrice` の市場別品質しきい値。
4. **失敗条件（判断4）の実証は次ラウンド**。既存チャネル（加工能力過剰→プレミアム圧縮、
   商品間の営業工数の食い合い、品質・信頼の非対称減衰、固定費、資金繰り）は揃っているが、
   ケースD（無調整の過剰投資が失敗する）の実機シナリオ検証は §5 の営業対応力再設計と
   セットで行うのが妥当。
5. **§5（営業対応力）着手時の SAI-6.x 再突合ポイント**（判断3・監査§11の再掲）。
   エンジン側 `sales/marketEffort.ts` を変更する場合、標準AI側のミラー実装
   `standardAi/decision/sales.ts` の以下を必ず同時に直す必要がある。
   - `allocateHeadcountAcrossMarkets(observation.salesForceHeadcountTotal, effortDemandByMarket)`
     — SAI-6.2 が `fixture.salesForceHeadcountTotal` からここへ書き換えた行
   - `computeMarketSalesEffort` をエンジンと同一式で自ら呼ぶ縮小処理と、
     そこから作られる `constrainedMarkets` 診断
   - 関数末尾の `realisticSalesByProduct`（SAI-6.2 新設。`salesPlans` の商品別合計）
   - `SalesPlanResult` の型（`desiredByProduct` と `realisticSalesByProduct` の2本立て）
   本ブランチは SAI-6.x 導入前の統合ブランチが基点のため、これらの行はまだ SAI-6.2 の
   形になっていない。統合時は「営業対応力の新実装」と「SAI-6.2 の書き換え」を
   手作業で突き合わせる前提で見積もること。

---

# 【実装ラウンド2】営業能力・投資接続・標準AI（§e〜§h）

作成日: 2026-08-02 / コミット `dca553b` `fe66e42` `6864bbf` `3da2ffd`

## §e 営業能力の再設計（監査§5の3つの構造的欠陥）

**新規**: `app/lib/v2/sales/salesCapability.ts` / **テスト**: `sales/__tests__/salesCapability.test.ts`（SC-1〜11）

```
販売処理能力 = (baselineThroughputTons + throughputTonsPerHead × 人数)
               × 市場規模係数（対象需要 ÷ 43,000t、0.5〜2.5でclamp）
               × 顧客開発倍率（1 + 0.5×((score/100−0.5)×2)、0.6〜1.8でclamp）

顧客開発スコア = 0.3×カバレッジ(人数、逓減) + 0.35×VAP能力 + 0.2×品質 + 0.15×顧客関係
```

**営業工数制約は消していない**。必要工数の式（HOSO 1.0 / PD 1.2 / VAP 3.0 の加重和）は
まったく変えておらず、VAPを売るには依然として3倍の工数がかかる（SC-3）。
変わったのは「足りないときに人を増やせば解ける」ようになったことだけ。

| パラメータ | 値 | 単位・意味・範囲の根拠 |
| --- | --- | --- |
| `baselineThroughputTons` | 200 | HOSO換算t／市場・四半期。人数0でも残る既存顧客ぶん（従来の `baselineCapacityTons` と同義） |
| `throughputTonsPerHead` | 260 | HOSO換算工数t／人・四半期。**逓減させない**。h=10で 200+2,600=2,800t と従来水準（2,600t）に整合させつつ、増員が効き続けるようにした |
| `referenceMarketDemandTons` | 43,000 | HOSO換算t。baselineシナリオturn1のベトナム獲得需要216,000tを5市場で割った値 |
| `marketScaleFloor` / `Cap` | 0.5 / 2.5 | 小さい市場でも0にならず、大きい市場でも青天井にしない |
| `customerDevelopmentWeights` | 0.3/0.35/0.2/0.15 | カバレッジ／VAP能力／品質／顧客関係。合計1.0 |
| `customerDevelopmentUplift` | 0.5 | スコア100で倍率1.5 |
| `customerDevelopmentMultiplierFloor` / `Cap` | 0.6 / 1.8 | 倍率の有界化 |

### 欠陥の解消（実測）

| 欠陥 | before | after |
| --- | --- | --- |
| (i) 絶対トン数の頭打ち | h=20で3,400t／h=50で4,200t／h→∞でも5,000t | h=50で5,000t超、h=100でもさらに伸びる。1人あたり限界処理能力は一定 |
| (ii) VAP係数が数量を割る | VAP 3,000t（必要工数9,000t）は h=100 でも1,700t未満で**構造的に達成不能** | 40人まで増員すれば希望どおり3,000t成立 |
| (iii) 一律縮小 | 全商品同一のscaleFactor。VAPを守る手段なし | `salesPriority` による優先度つき水位法。全商品同値なら従来と完全一致（SC-5） |

### 2×2 交互作用（実装指示の必須要件）

条件: 希望量 HOSO/PD/VAP 各5,000t（どのセルでも能力がbinding）、市場規模基準、
VAP能力スコア 低=40 / 高=90、営業人員 低=5人 / 高=25人。

| | 営業人員 低(5) | 営業人員 高(25) |
| --- | --- | --- |
| **商品開発 低(40)** | 844.5 t | 4,119.1 t |
| **商品開発 高(90)** | 996.0 t | 4,795.6 t |

- 商品開発のみの効果: **+151.4 t**
- 営業増員のみの効果: **+3,274.6 t**
- 両方: **+3,951.0 t**
- **交互作用項: +525.0 t**（単独効果の合計を上回る分）

どちらか一方では最大効果に届かず、組み合わせて初めて上積みが出る。
機構は単純で、顧客開発倍率が「基礎＋人数×単価」に**乗算**で掛かるため、
倍率の改善がもたらす絶対量は人数が多いほど大きい。

### `allocation.ts` の上限と、旧「散文の証明」の置き換え

`marketEffort.ts` のヘッダには「工数制約適用後は `q_p ≤ C(h)/coef_p ≤ C(h)` なので
allocation 側の `C(h)` 上限は数学的に非拘束」という散文の証明があった。§e では能力の
定義が変わり、この証明はそのままでは成立しない。そこで

- `allocation.ts` の個社上限を `throughputCapacity ÷ 当該商品の工数係数` へそろえ、
- 証明を削除して、**SC-8 が実際の配分結果で直接アサートする**形に置き換えた
  （h = 0 / 5 / 15 / 40 の4条件で、工数制約後の希望量が allocation 側上限を超えないことを確認）。

## §f 新工場の能力が契約・生産・利益へ通るか

**新規**: `scripts/newFactoryConversionComparison.ts`（Phase6の比較を市場進化ON/OFF軸つきで再実行）

### 発見した既存バグ: 採用した営業人員が販売計画へ反映されていなかった

営業人員の追加採用（`salesForceHiring.ts`）は状態としては正しく更新されるのに、
販売計画を組む3箇所がいずれも fixture の**静的な** `salesForceHeadcountTotal` を
読んでいた。実測で、毎四半期+3人を32四半期続けても契約数量が**ビット単位で不変**
（197,295t）だった。

| 箇所 | develop/v2 の SAI-6.2 | 本ブランチ |
| --- | --- | --- |
| `standardAi/observation.ts` | 修正済 | 今回修正 |
| `standardAi/decision/sales.ts` | 修正済 | 今回修正 |
| `companyLab/autoPolicy.ts` | **未修正** | 今回修正 |

これに伴い既存テスト2件の期待値を更新した。いずれも「バグを固定していた」もの。
- `runner.test.ts`: 「+6人のSG&A差分がちょうど 6×8,000」→ 増員が実際に販売活動へ加わるため
  給与＋変動販管費になる。「給与ぶん以上」かつ「成約量が実際に増える」へ変更。
- `standardAi/__tests__/salesEffort.test.ts`: fixture を上書きするだけでは人数が変わらなくなったため、
  `salesForceHiringState.headcount` も同じ値へそろえるようセットアップを修正。

### 凍結していた 60,575t は動いたか → **動いた**

16四半期・3環境×3ケース（`--` なしで実行）:

| 市場進化 | env1-slack | env2-balanced | env3-constrained |
| --- | --- | --- | --- |
| OFF | 60,575 t | 60,575 t | 60,575 t |
| ON | **95,366 t** | **98,882 t** | **99,996 t** |

市場進化OFF側はPhase6の所見を完全に再現している（全環境・全ケースで同一）。
ON側では **+57〜65%** 増え、かつ環境（市場条件）によって値が変わるようになった。

### ただし「新工場だけ」では依然として赤字が拡大する

32四半期・env3-constrained・市場進化ON:

| 条件 | 契約 | 生産 | 累積純利益 |
| --- | --- | --- | --- |
| 工場なし・採用なし | 197,295 t | 216,676 t | -102,534,663 |
| 工場あり・採用なし | 197,407 t | 255,842 t | -452,537,554 |
| 工場なし・毎期+3人 | 644,814 t | 306,977 t | -320,204,224 |
| 工場あり・毎期+3人 | 642,714 t | 471,127 t | **-223,940,272** |

- 工場だけ建てると、作った分が在庫になり純利益が **-350,002,891** 悪化する。
- 営業だけ増やすと契約は3.3倍になるが生産が追いつかず、やはり赤字が拡大する。
- **両方そろえたときだけ**、営業単独比で純利益が **+96,263,952** 改善する。

これは実装指示の「新工場は需要を作らない。需要が伸び、既存能力が本当に律速に
なったときに初めて能力増が契約・生産・利益へ流れる」という枠組みと整合する結果である。
なお 3% の価格割引を与えても契約はほぼ動かなかった（197,295 → 197,318t）ため、
律速は成約競争力ではなく営業処理能力であることが確認できている。

## §g PD省人化と余剰人員の接続

**発見した接続の欠落**: `computeRequiredRegularHeadcount`（判断側が必要常用人員を
見積もる唯一の関数）が `effectiveEfficiencyPerHeadTons` を `coefficientOverride`
なしで呼んでおり、**PD省人化投資の効果を一切見ていなかった**。

そのため省人化で実際の必要人員が減っても見積りは既定係数1.2のまま変わらず、
`decision/labor.ts` の人員過剰判定（`sustainedExcess`）が発火しない。結果として
余剰人員が配置されたまま残り、常用人件費は人数連動なので下がらず、**省人化投資は
原理的に回収不能**だった。Phase5の損益分岐分析で観測した現象の機構がこれである。

修正後（PMW-1〜5）:
- 必要人員は実効PD係数の比そのもので減る（独自の係数を持ち込んでいない）
- 完全成熟時（削減率 1/6 ≈ 16.67%）の必要人員は、標準AIの人員過剰しきい値（-15%）を
  実際に割り込む → 常用ワーカーの段階的縮小＝実際の人件費削減へつながる
- PD以外（HOSO/VAP）の必要人員は不変

**投資額・削減率のパラメータは指示どおり一切変更していない。**

## §h 標準AIの市場認識と投資タイミング判断

**新規**: `standardAi/decision/marketEvolutionInvestment.ts` / **テスト**: `standardAi/__tests__/marketEvolutionInvestment.test.ts`（MEI-1〜8）

認識できるもの: PD/VAP需要トレンドと6四半期先の予測需要倍率、予測能力不足率、
商品別供給圧力、他産地参入によるPDプレミアム低下の兆候、営業対応力の逼迫、
原料制約、投資後の現金余力。

**固定ターンの規則にしていないこと**: `decideMarketEvolutionInvestments` は
turn を引数に取らない。したがって時期で分岐することが構造的に不可能である（MEI-3）。
判断はすべて 予測需要／能力不足／期待回収／現金余力 の4点から導く。

| パラメータ | 値 | 単位・意味・範囲の根拠 |
| --- | --- | --- |
| `demandForecastHorizonQuarters` | 6 | 四半期。建設3Q＋準備1Qより先を見ないと「完成した頃に需要が来ている」判断ができない |
| `newFactoryForecastShortfallThreshold` | 1.05 | 予測需要÷能力。`growthTrendResponsiveness` が高い会社ほど下がる |
| `newFactoryMinUtilization` | 0.7 | 現在の設備が実際に埋まっていること |
| `newFactoryCashSafetyMultiple` | 3.0 | 目標最低現金の倍数 |
| `mechanizationMinPdUtilization` | 0.6 | 稼働率が低いと削減できる人員も少なく回収できない（Phase5の結論を判断条件へ明文化）。PDプレミアム低下局面では0.85倍に緩める |
| `mechanizationMaxPaybackQuarters` | 20 | 四半期。期待回収の許容上限 |
| `mechanizationCashSafetyMultiple` | 2.0 | 目標最低現金の倍数 |
| `vapDevelopmentTrendThreshold` | 0.004 | 構成比pt/四半期。`productMultipliers.vap` で会社ごとに除して調整 |
| `vapDevelopmentCashSafetyMultiple` | 1.5 | 目標最低現金の倍数 |
| `vapDevelopmentOversupplyThreshold` | 1.15 | 供給圧力がこれを超えたら投資額を1段階下げる |

### 実測（`scripts/standardAiMarketEvolutionAutoplay.ts`、5社×3シード×32四半期）

| | 市場進化 OFF | 市場進化 ON |
| --- | --- | --- |
| 新投資を採用した会社×シード | **0 / 15** | **10 / 15** |
| 期末現金の相異なる値 | **1 / 15**（全社 -188,214,000） | **15 / 15** |
| 期末現金の範囲 | -188,214,000（全社同一） | +55,920,587 〜 +84,468,568 |
| 累積純利益の範囲 | -360,123,732 〜 -369,362,484 | +77,354,779 〜 +110,126,472 |

Phase8で観測した「5社すべてが同じ意思決定・同じ破綻結果になる」状態は解消した。

### 意図どおりにならなかったこと（調整して隠していない）

1. **新工場建設が32四半期を通じて一度も提案されない（0/15）。** 判断ロジックの
   不具合ではない。BALの実測を追うと、稼働率が0.7を超えるのは turn10（0.806）だけで、
   その時点の現金余力は **-29,690,298**（目標最低現金を下回っている）。現金安全条件
   （目標最低現金の3倍）で正しく見送られている。序盤〜中盤に現金が薄いという
   経済的な結果であり、しきい値を緩めれば「現金が危ういのに建てる」ことになるため、
   **意図的に調整していない**。

   | turn | 稼働率 | PD予測倍率 | VAP予測倍率 | VAP需要トレンド | 現金余力 |
   | --- | --- | --- | --- | --- | --- |
   | 2 | 0.437 | 1.000 | 1.000 | 0.00000 | +1,887,243 |
   | 6 | 0.669 | 1.014 | 1.083 | 0.00085 | -29,185,746 |
   | 10 | 0.806 | 1.102 | 0.918 | -0.00094 | -29,690,298 |
   | 14 | 0.577 | 1.136 | 1.236 | 0.00358 | +2,514,414 |
   | 18 | 0.549 | 1.070 | 1.329 | 0.00592 | -13,666,240 |
   | 22 | 0.541 | 1.219 | 1.425 | 0.01046 | +7,573,097 |
   | 26 | 0.518 | 1.076 | 1.025 | 0.00069 | +16,656,675 |
   | 30 | 0.525 | 0.998 | 1.094 | 0.00270 | +37,926,536 |

2. **投資が turn30〜32 に偏る。** VAP需要トレンドは turn18 の時点で既にしきい値
   (0.004) を超えているが、そのときの現金余力が負のため投資可能額が0ティアになる。
   「序盤に小さく準備する」という意図した時系列にはなっていない。原因は
   **序盤〜中盤に現金余力がほぼ常に負であること**であり、投資判断側ではなく
   資金繰り側の課題。

3. **市場進化ONでは15/15すべてが黒字になった。** これは §e の営業能力再設計で
   契約が通るようになった結果であって、投資しきい値の調整によるものではない
   （投資が始まるのは turn30 以降で、32四半期の損益にはほとんど寄与していない）。
   ただし実装指示の「PD/VAPが一様に儲かってはならない」「ケースD（無調整の
   過剰投資）は失敗する」という要件に照らすと、**失敗条件の実証は未達**である。
   §f の実測（工場だけ建てると純利益が -350,002,891 悪化する）は失敗条件が
   機構としては存在することを示しているが、標準AIがその失敗に踏み込む挙動は
   まだ観測できていない。次ラウンドの課題。

4. **PD省人化の提案は seed-1 でのみ発火し（5社×2回）、seed-2/3 では0回。** 稼働率
   条件（0.6）を満たす局面がシードによって存在したりしなかったりするため。
   シード差が投資判断へ効いていること自体は意図どおりだが、発火率は低い。

## SAI-6.2 再突合ポイント（最新）

`sales/marketEffort.ts` を変更したため、`standardAi/decision/sales.ts` の以下は
develop/v2 の SAI-6.2 と手作業で突き合わせる必要がある。

| # | 箇所 | 本ブランチでの状態 | SAI-6.2 での状態 |
| --- | --- | --- | --- |
| 1 | `observation.ts` の `salesForceHeadcountTotal` | `ownState.salesForceHiringState.headcount` へ変更済（今回） | 同じ修正が入っている |
| 2 | `allocateHeadcountAcrossMarkets(...)` の第1引数 | `observation.salesForceHeadcountTotal` へ変更済（今回） | 同じ修正が入っている |
| 3 | `computeMarketSalesEffort(...)` 呼び出し | **第4引数 `salesCapabilityContextFor(market, observation)` を追加（今回）** | 引数3個のまま |
| 4 | 関数末尾 | `realisticSalesByProduct` **なし** | `salesPlans` の商品別合計として新設 |
| 5 | `SalesPlanResult` 型 | `desiredByProduct` のみ | `desiredByProduct` ＋ `realisticSalesByProduct` の2本立て |

3〜5 が競合する。統合時は「§e の営業能力文脈の追加」と「SAI-6.2 の
`realisticSalesByProduct` 新設」を両立させる形で手作業マージすること
（両者は目的が異なり、片方を捨てる形にはならない）。

## 機能フラグ一覧（`config.marketEvolution`、すべて既定OFF・追加分）

| フラグ | 対応する項目 | 有効時の挙動 |
| --- | --- | --- |
| `salesCapability` | §e | 販売処理能力／顧客開発能力の分離、商品別販売優先度 |

なお §h（標準AIの投資判断）は専用フラグを持たず、
`observation.lifecycleTrendByMarket` が存在するか（＝市場進化系が有効なラボか）で
自動的に有効になる。観測が無ければ完全に無効で、既存ラボの意思決定は不変。

---

# 【実装ラウンド3】検証シナリオ・受入条件・文書（§11〜§14）

作成日: 2026-08-02 / コミット `8145bdd` `bc9a032`

## §11 4つの比較ケース

**スクリプト**: `scripts/processedMarketEvolutionScenarios.ts`
（`npx tsx scripts/processedMarketEvolutionScenarios.ts [--write]`）

4ケースはすべて**同一シナリオ・同一パラメータ・同一シード**で走る。違いは各社が出す
意思決定（投資の有無・時期・営業増員の有無）だけである。**Dを失敗させるために市場を
厳しくする調整は一切していない。**

| ケース | 営業増員/Q | 新工場 | 省人化 | VAP開発 | 新工場への人員配置 |
| --- | --- | --- | --- | --- | --- |
| A 加工投資なし | 0 | なし | なし | なし | — |
| B PD先行 | +3 | turn8 | turn16 | なし | あり |
| C VAP先行 | +3 | なし | なし | turn6〜毎期 $250,000 | あり |
| D 無調整の過剰投資 | 0 | turn2 | turn2 | turn2〜毎期 $500,000 | **なし** |

turnの選び方は市場側の弧に対する相対位置で決めている（時期そのものに意味はない）。
EC の PD 参入は turn14 から始まり turn20 前後で世界PD稼働率が明確に低下する。

### 結果（baseline・24四半期・5社・3シード）

| ケース | 契約(t) | 生産(t) | 累積営業利益 | 累積純利益 | 期末現金合計 | 期末現金<0の社数 |
| --- | --- | --- | --- | --- | --- | --- |
| A | 527,429 | 351,730 | -743,549,941 | -949,780,952 | -255,580,055 | 3/5 |
| B | 973,536 | 533,185 | -571,769,493 | -767,085,815 | -199,089,656 | 3〜4/5 |
| C | 993,422 | 581,548 | -289,811,893 | -488,080,168 | -15,214,307 | 2〜3/5 |
| D | 527,256 | 318,608 | -914,614,156 | -1,131,611,622 | -405,451,752 | 4/5 |

（契約・生産・利益はシード平均。詳細は生データCSVを参照）

**ケースAとの差（累積純利益、シード平均）**

| | 差 | 判定 |
| --- | --- | --- |
| B PD先行 | **+182,695,137** | Aを明確に上回る ✔ |
| C VAP先行 | **+461,700,784** | Aを明確に上回る ✔ |
| D 無調整 | **-181,830,670** | **Aを下回る ✔（失敗条件の実証）** |

### Dが失敗する理由（数値の読み方）

- **契約数量が全く増えない**（527,256t、Aの527,429tとほぼ同じ）。営業を増やしていない
  ため、加工能力を増やしても売る力がない。
- **生産量はむしろ減る**（318,608t vs A 351,730t）。新工場へ人員を配置しておらず、
  さらに投資で現金が減って原料調達が細るため。
- **期末現金<0の会社が4/5**（Aは3/5）。3種類の投資を同時に、しかも需要が伸びる前に
  実行したため、回収が始まる前に資金が尽きる。

これは実装指示の「正しい投資でもタイミングと接続を誤れば負ける」をそのまま示している。
前ラウンドで機構としては示していた（工場だけ建てると純利益 -350,002,891 悪化）ものが、
今回フルの5社シミュレーションで実際に現れた。

### B/Cが勝つ条件

B・Cが勝つのは**営業増員と投資を同時に行っている**からである。B・Cはどちらも
`salesHirePerQuarter: 3` を持ち、Dは持たない。契約数量が A/D の約527千tに対して
B/Cは約973〜993千tと**1.85〜1.88倍**になっている。ここが分岐点である。

CがBを上回るのは、VAP商品開発が顧客開発能力を通じて販売処理能力に**乗算**で効き、
かつVAPプレミアムが終盤に拡大するため。ただしCも累積では赤字であり、
「VAPをやれば必ず儲かる」状態にはなっていない。

## §12 受入条件の検証結果

**テスト**: `app/lib/v2/companyLab/__tests__/marketEvolutionAcceptance.test.ts`（ACC-1〜12、全件合格）

| # | 受入条件 | 判定 | 根拠 |
| --- | --- | --- | --- |
| 1 | 世界需要が時間とともに成長する | ✔ | ACC-1。turn1 → turn16 → turn32 で単調増加 |
| 2 | US/JP/EUのPD+VAP構成比が上昇する | ✔ | ACC-2 |
| 3 | 中国は相対的にHOSO中心のまま | ✔ | ACC-3。全turnでCNのHOSO構成比が全市場最大 |
| 4 | 中盤にベトナムのPD黄金期が存在する | ✔ | ACC-4。PDプレミアム比率のピークが turn16 までにあり、終盤より高い |
| 5 | 終盤の他産地参入でプレーンPDの採算が悪化する | ✔ | ACC-5。比率が1割以上圧縮＋`ECUADOR_PD_CAPACITY_EXPANSION` 発火。VAP比率は上昇 |
| 6 | VAP投資×営業活動で成約量・プレミアムが上がる | ✔ | ACC-7／SC-6（2×2、交互作用項 +525.0t） |
| 7 | VAP投資単独では最大効果に届かない | ✔ | 同上。dev単独 +151.4t に対し両方 +3,951.0t |
| 8 | 能力が真に律速のとき新工場が販売増へ変換される | ✔ | §f。60,575t固定 → 95,366〜99,996t。工場＋営業で純利益 +96,263,952 |
| 9 | 高稼働＋人員調整が実際に起きる条件下でPD省人化が合理的になる | ✔ | ACC-8／PMW-2・PMW-5 |
| 10 | 無調整投資は資金を悪化させる | ✔ | ACC-12／ケースD（Aより -181,830,670、期末現金<0が4/5） |
| 11 | 標準AIが一部の会社・シードで新投資を採用する | ✔ | §h。10/15（市場進化OFFでは0/15） |
| 12 | 5社すべてが同じ意思決定・同じ破綻結果になる状態の解消 | ✔ | §h。期末現金の相異なる値 1/15 → **15/15** |
| 13 | 保存・再開・Excel・財務諸表の整合 | ✔ | ACC-9/10/11＋Excel統合テスト4件 |

条件13の内訳:
- **保存・復元**: `config.marketEvolution` を含めてラウンドトリップする（ACC-9）。
- **再開の決定論**: 復元後に四半期を進めた結果が、中断なし実行と完全一致（ACC-10）。
- **財務三表**: BS恒等式（資産 = 負債＋純資産）とCF期末現金＝BS現金が全会社・
  全四半期で成立（ACC-11）。
- **Excel**: 生成・値のスポットチェック・監査情報リーク防止・新シートの4件が合格。

## §13 加工プレミアム比率のUI/レポート出力（前ラウンドからの繰越）

Excelに**「加工プレミアム」シート**を追加した（`companyLabAdminExcelBuilder.ts`）。

PD/VAPの絶対価格は原料価格の上昇に引っ張られて後半も上がり続けるため、
「プレーンPDのコモディティ化」は絶対価格では読み取れない。このシートでは

- ★PDプレミアム比率 = (PD価格 − HOSO価格) ÷ HOSO価格
- ★VAPプレミアム比率 = (VAP価格 − HOSO価格) ÷ HOSO価格
- ★VAP/PDプレミアム比（競争軸の移動の指標）
- PD/VAP世界稼働率・世界加工能力
- 価格変動の理由コード

を「読み方」の説明つきで出力する。生データCSVにも `processingPremiumRatio` /
`vapPremiumRatio` / `vapIncrementalPremiumUsdPerKg` 列を追加した。

## §14 生データ

**出力先**: `artifacts/market-evolution/scenarios/`（`.gitignore` 済み。生成スクリプトのみGit管理）
**再生成**: `npx tsx scripts/processedMarketEvolutionScenarios.ts --write`

| ファイル | 内容 |
| --- | --- |
| `market-evolution-scenarios.csv` | 4ケース×3シード×24四半期×5社 = 1,440行 |
| `market-evolution-scenarios-summary.json` | ケース別サマリとケースプロファイル定義 |

### 追跡軸のカバレッジ

| 要求された軸 | CSV列 |
| --- | --- |
| シナリオ | `scenarioId` |
| シード | `seed` |
| 会社 | `companyId` |
| 四半期 | `quarter` |
| 市場 | `market`（現状は会社×四半期の集計行のため `ALL`） |
| 商品 | `product`（同上） |
| 総需要 | `worldDemandTons` |
| 商品別需要構成比 | `productDemandShare` |
| ベトナム獲得需要 | `vietnamAddressableDemandTons` |
| 競合の加工能力 | `competitorPdProcessingCapacityTons` / `competitorVapProcessingCapacityTons` |
| 基準価格 | `hosoBasePriceUsdPerKg` |
| 加工プレミアム | `processingPremiumUsdPerKg` / `processingPremiumRatio` / `vapIncrementalPremiumUsdPerKg` / `vapPremiumRatio` |
| 自社能力 | `ownVapCapabilityScore` |
| 営業能力 | `salesForceHeadcount` / `salesCapacityTons` |
| 成約量 | `contractedTons` |
| 生産量 | `producedTons` |
| 稼働率 | `equipmentUtilization` |
| 投資 | `investmentUsd` / `vapDevelopmentSpendUsd` |
| 営業利益 | `operatingIncomeUsd` |
| 現金 | `cashUsd` |
| 負債 | `debtUsd` |

**未達の軸（正直に記載）**: `market` / `product` は現状すべて `ALL` である。
市場×商品の明細は `record.salesRecord.allocations` に存在するが、行数が
1,440 → 21,600 行になるため今回は集計行に留めた。市場別・商品別の明細が必要になった
時点で、同じスクリプトに明細出力モードを足すのが素直な拡張。
`salesCapacityTons` も同様に、エンジン内部の `MarketSalesEffortResult.throughput` を
記録へ載せていないため常に 0 である（診断としては `marketEffort.ts` の
`MarketSalesEffortAdjustment` に出ているが、`CompanyQuarterRecord` へは通していない）。

## §15 Phase5/6の否定的所見の取り消し

前ラウンドで見つけた2つの潜在バグが、Test15事前校正（Phase5/6/7）の否定的な結論の
**直接の原因**だった。以下は当時の結論を明示的に置き換えるものである。

| 当時の所見 | 当時の結論 | 今回判明した原因 | 更新後の結論 |
| --- | --- | --- | --- |
| Phase6: 契約数量が全環境・全ケースで完全に同一（60,575t） | 「新工場の能力増が販売へ変換されない」 | 営業処理能力が1市場5,000tの絶対上限で頭打ちだった（監査§5の欠陥(i)）。さらに採用した営業人員が販売計画へ反映されない取りこぼしがあった | 営業能力再設計後は 95,366〜99,996t へ増え、市場条件にも反応する。ただし新工場**単独**では依然として赤字が拡大し、営業増員と組み合わせて初めて +96,263,952 の改善になる |
| Phase7: VAP投資額を4段階変えても契約数量が同一（10,817t） | 「VAP支出が販売へ変換されない」 | 同上（欠陥(i)）＋VAP工数係数3.0が販売可能トン数を1/3にしていた（欠陥(ii)） | VAP能力が顧客開発倍率を通じて処理能力へ乗算で効くようになり、2×2で交互作用項 +525.0t を確認 |
| Phase5: PD省人化が達成可能な稼働率では回収不能 | 「常用人件費は人数連動なので、実際に人が減らない限り下がらない」 | `computeRequiredRegularHeadcount` がPD省人化の係数上書きを見ておらず、必要人員が下がらないため人員過剰判定が発火せず、人が減らなかった | 必要人員が実効PD係数の比で実際に減り、標準AIの人員過剰しきい値（-15%）を割り込むため、常用ワーカーの段階的縮小＝実際の人件費削減へつながる |

**投資額・削減率のパラメータは一切変更していない。** Phase5の損益分岐の再計算は、
需要・価格・営業が接続された環境での新しい実測に基づいて次ラウンドで行うべきである。

## §16 未解決・意図どおりにならなかったこと（最終）

1. **序盤〜中盤の現金余力がほぼ常に負である。** BALの実測で turn6〜turn22 の大半で
   現金が目標最低水準を下回る。このため標準AIは新工場建設を32四半期で一度も提案しない
   （現金安全条件で正しく見送っている）。「準備期に小さく投資する」という意図した
   時系列が成立しない。**これはベースライン経済の資金構造の問題**であり、Phase8で
   観測した「5社すべてがturn14〜16で破綻する」という所見と地続きである。
   投資判断のしきい値を緩めて無理に投資させることは**していない**。
2. **標準AIの投資がturn30〜32に偏る。** VAP需要トレンドは turn18 の時点で既に
   しきい値を超えているが、その時点の現金余力が負のため投資可能額が0ティアになる。
   原因は1と同じ。
3. **4ケースすべてが累積赤字である。** Cが最も良いが -488,080,168。ケース比較としては
   A/B/C/Dの序列が明確に出ており設計テーゼは検証できているが、「黒字化する戦略」は
   まだ存在しない。1の資金構造の課題を解かない限り、絶対水準は改善しない見込み。
4. **生データの `market` / `product` 軸が `ALL` のみ**（§14参照）。
5. **`salesCapacityTons` が常に0**（§14参照）。エンジン内部では計算されているが
   四半期記録へ通していない。
6. **PD省人化の提案がシード依存**。稼働率条件（0.6）を満たす局面がシードによって
   存在したりしなかったりするため、seed-1 でのみ発火した。
7. **§c-1（商品別の仕向市場価格係数）の効果は§aに比べて小さい**（前ラウンドからの継続）。
   構成比の移動幅が最大0.20ptのため、VAP係数の上昇は最大でも+24%。
8. **EUの品質・サステナビリティ・トレーサビリティによる「門番」は未実装**
   （監査§7の指摘のまま）。

---

# 【実装ラウンド4】商品別労働係数とPD省人化の業務判断化

作成日: 2026-08-02 / ブランチ `feature/v2-product-labor-and-pd-mechanization`

## §1 調査結果: 変更前の計算経路

| 段階 | 場所 | 機械化効果の適用 |
| --- | --- | --- |
| 係数の定義 | `production/parameters.ts` `labor.laborIntensityCoefficient`（HOSO1.0/PD1.2/VAP3.0） | — |
| 係数の参照 | `production/labor.ts` `laborIntensityCoefficientFor` | — |
| 1人あたり実効効率 | 同 `effectiveEfficiencyPerHeadTons(base, product, params, coefficientOverride?)` | **実効PD係数**を第4引数で上書き |
| 生産計画→必要労働 | 同 `requiredHeadcountForQuantity` / `allocateWorkersToPlans` 内 `headcountDemandFor` | `d.product === "pd"` のときだけ上書き |
| 常用/臨時/残業→労働能力 | 同 `calculateLaborCapacityFromAssignedHeadcount` | 同上 |
| 労働不足による生産制限 | `production/allocation.ts` → `allocateWorkersToPlans` | 上書きマップを受け渡し |
| 優先度による配分 | `allocateByPriorityTiers`（`headcountDemandFor` の結果を重み・capに使う） | 上書き経由で反映 |
| 機械化状態 | `companyLab/pdMechanizationState.ts`（工場別の前四半期PD稼働率） | — |
| 実効係数の算出 | `capex/pdMechanization.ts` `computeEffectivePdCoefficient`（base 1.2 → floor 1.0、独自の補間とクリップ） | **ここが第2の写像だった** |
| 必要人員の見積り | `companyLab/workforce.ts` `computeRequiredRegularHeadcount` | 前ラウンドで接続済 |
| Standard AIの人員判断 | `standardAi/decision/labor.ts` | 前ラウンドで接続済 |
| **画面の処理見込み** | `processingForecastViewModel.buildCompanyProcessingForecast` | **未接続だった** |
| **画面の投資計画** | `investmentPlanningViewModel`（必要人員・労働能力） | **未接続だった** |
| **Excelの処理能力見込み** | `exports/_lib/dto/processingCapacityDto.ts` | **未接続だった** |
| 人件費 | `finance` の `regularWorkerSalaryUsdPerQuarter` ほか（人数連動） | 機械化とは無関係（正しい） |

### 二重適用の調査結果 → **重複適用は無し**

唯一の疑わしい箇所は `allocateWorkersToPlans` で、同じ上書き値が
`headcountDemandFor`（数量→人数の逆算）と `calculateLaborCapacityFromAssignedHeadcount`
（人数→数量の順算）の両方に渡っていた。しかしこの2つは互いに逆関数であり、
配分の重み付けと能力の確定という別の用途に1回ずつ使われているだけで、
同じ効果が累積するわけではない。PDL-8 がこれを数値で確認している
（エンジンの実効能力＝係数を1回だけ適用した理論値と一致。二重なら (1.8/1.2)² 倍になる）。

一方で **未適用の箇所が3つ**（画面の処理見込み、画面の投資計画、Excelの処理能力見込み）
見つかった。これは過去2ラウンドで見つけた同種の取りこぼし（`fixture.salesForceHeadcountTotal`、
`computeRequiredRegularHeadcount` の係数未接続）と同じパターンである。

## §2 変更後の正典経路

```
production/parameters.ts
  laborIntensityCoefficient           = { hoso 1.0, pd 1.8, vap 3.0 }   機械化前
  mechanizedLaborIntensityCoefficient = { hoso 1.0, pd 1.2, vap 2.6 }   機械化後
        ↓（この2表からの補間は下の1関数だけが行う）
production/labor.ts  resolveLaborIntensityCoefficient(product, mechanizationLevel, params)
        ↓
production/labor.ts  effectiveEfficiencyPerHeadTons(base, product, params, mechanizationLevel)
        ↓
  ├─ requiredHeadcountForQuantity（数量→必要人数）
  ├─ calculateLaborCapacityFromAssignedHeadcount（人数→処理可能数量）
  ├─ allocateWorkersToPlans（優先度つき配分・労働不足時の生産制限）
  ├─ companyLab/workforce.ts computeRequiredRegularHeadcount（必要/余剰人員）
  ├─ standardAi/decision/labor.ts（増減員判断）
  ├─ standardAi/decision/marketEvolutionInvestment.ts（投資判断）
  ├─ 画面: processingForecastViewModel / investmentPlanningViewModel / DecisionEditor
  ├─ Excel: exports/_lib/dto/processingCapacityDto.ts
  └─ capex/pdMechanization.ts computeEffectivePdCoefficient（薄いアダプター）
```

**配管を「実効PD係数」から「機械化レベル(0〜1)」へ全面変更した。** 理由は、機械化が
PDだけでなくVAPにも及ぶため「PDの実効係数」1つでは表現しきれないこと、そして
商品ごとの効き方の違いを呼び出し側の分岐として散らばらせないためである。
`buildPdCoefficientOverridesByFactory` は後方互換のため残しつつ、実配線は
新設の `buildMechanizationLevelsByFactory` に置き換えた。

> **セマンティクス変更の落とし穴**: 型がどちらも `Map<string, number>` のため
> tsc では検出できない。実際 `scripts/test15FourCaseSimulation.ts` が実効係数(1.5等)を
> 渡し続けており、そのままだと「レベル1.0＝完全機械化」と黙って解釈される状態だった。
> 全呼び出し元を手で追って修正済み。

### 旧フロア／最大削減率機構の始末

`PdMechanizationParameters.floorCoefficient` は従来 `laborIntensityCoefficient.hoso`(1.0)
を指しており、「PDはHOSOと同じ手間まで下がりうる」という**別の想定**を暗黙に持っていた。
これを `mechanizedLaborIntensityCoefficient.pd`(1.2) の参照へ置き換え、独立した数値も
独立したクリップも廃止した。`computeEffectivePdCoefficient` は正典写像を呼ぶだけの
薄いアダプターになり、`reductionRatioAtFullMaturity` は自動的に 16.67% → **33.33%** になる
（UI文言も `formatReductionRatioAtFullMaturityLabel` 経由で自動追随）。

## §3 パラメータ変更（before / after）

| パラメータ | before | after | 意味 |
| --- | --- | --- | --- |
| `laborIntensityCoefficient.hoso` | 1.0 | 1.0 | 殻剥き工程なし |
| `laborIntensityCoefficient.pd` | **1.2** | **1.8** | 機械化前の殻剥き・背ワタ除去の人手 |
| `laborIntensityCoefficient.vap` | 3.0 | 3.0 | 変更なし |
| `mechanizedLaborIntensityCoefficient.hoso` | （無し） | 1.0 | 機械化の対象外 |
| `mechanizedLaborIntensityCoefficient.pd` | （floor=1.0 が実質これ） | **1.2** | 殻剥き省人化の到達点 |
| `mechanizedLaborIntensityCoefficient.vap` | （無し・効果ゼロ） | **2.6** | 前工程の殻剥き共通化ぶんのみ |
| `PdMechanizationParameters.floorCoefficient` | `laborIntensityCoefficient.hoso`(1.0) | `mechanizedLaborIntensityCoefficient.pd`(1.2) | 参照先の付け替え |
| 最大削減率（導出値） | 16.67% | **33.33%** | 1 − 1.2/1.8 |
| 投資額・保守費率・減価償却 | — | **変更なし** | 指示どおり触っていない |

## §4 必要労働と最大生産（前後）

| 指標 | 機械化前 | 機械化後 | 変化 |
| --- | --- | --- | --- |
| HOSO 1,000t の必要労働 | 基準 | 同一 | **±0%** |
| PD 1,000t の必要労働 | 基準×1.8 | 基準×1.2 | **−33.3%** |
| VAP 1,000t の必要労働 | 基準×3.0 | 基準×2.6 | **−13.3%** |
| 同一労働で作れるPD | 基準 | 基準×1.5 | **+50%** |
| 同一労働で作れるVAP | 基準 | 基準×1.154 | +15.4% |

## §5 コスト効果の現れ方（§4要件）

| 経路 | 効果が出るか | 検証 |
| --- | --- | --- |
| 常用人員を余剰のまま抱える | **出ない**（常用人件費は満額） | PDB-1 |
| 常用人員を実際に減らす | 出る（差分＝人数差×給与） | PDB-2 |
| 臨時ワーカーを削る | 出る | PDB-3 |
| 残業を削る | 出る（同上の機構） | PDB-3 |
| 同じ人手で増産する | 単位あたり人件費が 1/1.5 に | PDB-4 |
| 他商品へ振り替える | 出る（優先度配分経由） | PDL-13 |

## §6 VAPスピルオーバーの分離（§5要件）

PD省人化がVAPに及ぼす影響は **労働係数 3.0 → 2.6 のみ**。
VAP商品開発スコア・VAP販売力・顧客採用・VAP価格・VAP品質投資のいずれにも
機械化レベルは入力として存在しない（PDB-5）。したがって
**PD省人化だけでVAPの需要や価格が上がることはない。**

## §7 Standard AIへの接続（§6要件）

`standardAi/decision/marketEvolutionInvestment.ts` の省人化判断を、次の8条件が
**すべて**揃ったときにのみ提案する形へ変更した。

| 条件 | 実装 |
| --- | --- |
| PDの需要・成約見込み | 需要トレンド ≥ 0 かつ PD供給圧力 ≤ 1.25 |
| 労働が実際にボトルネック | 稼働率 ≥ しきい値（PDプレミアム低下局面では0.85倍に緩和） |
| 増えた分を売り切れる営業力 | 営業処理能力 ÷ 現実的な自社取り分 ≥ 1.1 |
| 完成品在庫が過剰でない | PD完成品過剰率 ≤ 0.8 |
| 原料を確保できる | 原料在庫ポジション ≥ 0.8 |
| 投資後も最低現金を維持 | 現金 ≥ 目標最低現金 × 2.0 |
| 期待回収が許容内 | ≤ 20四半期 |
| 有利局面が回収期間より長い | プレミアム低下検知時は回収×1.5 ≤ 許容 |

見送り時は各条件の充足状況を診断キー値として出力する（PDB-7/8/9で検証）。

**HOSOについて**: HOSO量販戦略は実装していない。ただし新係数により HOSO は
「最も労働が軽い／機械化不要／労働不足下で最も作りやすい／低加工・低投資」という
性格を自然に持つようになり、生産優先度の判断にそのまま効く（PDL-13）。
累積HOSO数量による販売効率・常設値引き・少人数大量販売モデルは**実装していない**。

## §8 比較シミュレーション（§9要件）

`scripts/pdMechanizationComparison.ts`（baseline・20四半期・5社・3シード平均）

| ケース | PD生産(t) | 契約(t) | 期末在庫(t) | 投資額 | 累積純利益 | 期末現金 |
| --- | --- | --- | --- | --- | --- | --- |
| A HOSO中心・省人化なし | 130,090 | 849,195 | 17,385 | 0 | -439,995,768 | -93,425,144 |
| B PD中心・省人化なし | 256,180 | 698,831 | 18,195 | 0 | -355,619,356 | 1,888,542 |
| C PD中心・適時省人化 | 256,036 | 698,929 | 18,186 | 6,833,333 | -357,160,282 | -3,203,051 |
| D PD+VAP・適時省人化 | 228,727 | 668,347 | 18,825 | 7,500,000 | -293,639,898 | 24,798,211 |
| E 販売見込み無しで省人化 | 113,997 | 401,657 | 13,286 | 5,000,000 | **-826,007,132** | **-181,368,548** |

ケース間の差（累積純利益）:
- B − A = **+84,376,412**（PD中心はHOSO中心を上回る）
- C − B = **-1,540,925**（省人化のみでは回収できていない）
- D − B = **+61,979,459**
- E − B = **-470,387,776**（**失敗ケースが明確に失敗する**）

### 【理論効果】と【PL/CFに実際に現れた効果】の分離

| ケース | 理論削減労働(人・四半期) | 理論削減額(USD) | 常用余剰(人・四半期) | 実際に現れた効果 |
| --- | --- | --- | --- | --- |
| A | 0 | 0 | 242,028 | 機械化なし |
| B | 0 | 0 | 244,605 | 機械化なし |
| C | 11,060 | **11,059,866** | 255,247 | **余剰人員として滞留（PLに現れない）** |
| D | 10,864 | 10,863,534 | 236,971 | 同上 |
| E | 2,354 | 2,354,178 | 259,282 | 同上 |

**これが本ラウンドの中心的な発見である。** ケースCでは理論上 11,059,866 USD の
人件費削減余地が生まれたが、常用人件費（630,000,000 USD）も臨時人件費
（53,408,000 USD）も**1円も減っていない**。理由は明快で、この比較で使っている
`generateAutoPolicyDecision`（自動方針）が**常用人員を減らす判断を一切しない**ため、
浮いた人員が余剰として滞留するからである。結果、C は投資額 6,833,333 USD を
負担しただけになり、B より 1,540,925 USD 悪化した。

減員判断を持つのは Standard AI 側（`decision/labor.ts` の `sustainedExcess` 経路）で、
前ラウンドでそこへ機械化効果を接続済みである。したがって
**「省人化投資が回収できるかどうかは、人員を実際に減らす判断とセットで初めて決まる」**
というのが、実機の数値で確認された結論になる。

## §9 感度分析（§10要件）

`npx tsx scripts/pdMechanizationComparison.ts --sensitivity`
（コードを編集せず、パラメータ差し替えだけで比較できる。PDL-15/16 も同じ機構を使う）

| 設定 | PD係数(前→後) | PD削減率 | 同一労働の増産倍率 | VAP削減率 | 理論回収(PD要員1,000人) | 理論回収(2,000人) |
| --- | --- | --- | --- | --- | --- | --- |
| 旧実装相当 | 1.2 → 1.0 | 16.7% | 1.200 | 0.0% | 15.0四半期 | 7.5四半期 |
| 保守 | 1.6 → 1.2 | 25.0% | 1.333 | 10.0% | 10.0四半期 | 5.0四半期 |
| **本設定** | **1.8 → 1.2** | **33.3%** | **1.500** | **13.3%** | **7.5四半期** | **3.7四半期** |
| 強 | 2.0 → 1.2 | 40.0% | 1.667 | 18.8% | 6.3四半期 | 3.1四半期 |

投資額 2,500,000 USD・常用給与 1,000 USD/人・四半期はいずれも**変更していない**。

**目安（需要・営業・原料・稼働率がすべて十分なとき4〜8四半期）に対する評価**:
本設定はPD関連の常用要員が1,000人規模で **7.5四半期**、2,000人規模で **3.7四半期** となり、
目安の範囲におおむね収まる。旧実装相当（15.0四半期）では目安を大きく外れており、
これがPhase5で「省人化は回収不能」と結論した理由の一つでもある。
ただし上表はいずれも**理論値**であり、§8のとおり人員を実際に減らさなければ
この回収は実現しない。

## §10 商品別の累積販売能力（設計メモのみ・未実装）

実装指示 §7 により、以下は**設計メモとしてのみ記録し、コードは一切書いていない**。
数値・しきい値・成長率も意図的に定めない。

- **HOSO**: 累積取扱数量と大口の継続取引によって蓄積する。少人数の営業で大量に
  売れる方向へ効く性質。
- **PD**: 数量に加えて、仕様適合（サイズ・規格）と安定した履行実績によって蓄積する。
  契約処理能力と継続的な販売力に効く。
- **VAP**: 商品の採用実績・顧客開発・継続販売によって蓄積する。提案の成約率と
  提案型販売の成立に効く。
- **将来の二層構造の可能性**: 現在の営業基盤は「会社×市場×商品」（SAI-5D）だが、
  「市場ベースの基盤」と「商品ベースの基盤」を別の層として持ち、両者の積で
  成約競争力を決める形が考えられる。市場をまたいで持ち運べる商品固有の信用と、
  商品をまたいで効く市場固有の顧客基盤は性質が異なるため。

**HOSO量販モデル（累積数量による販売効率・常設値引き・少人数大量販売）は
今回スコープ外であり、実装していない。**

## §11 検証結果

| 項目 | 結果 |
| --- | --- |
| `npm test` | **2,340 / 2,340 pass, 0 fail** |
| `npx tsc --noEmit -p .` | **clean（exit 0）** |
| `npm run lint` | **0 errors, 14 warnings**（すべて既存の未使用変数警告。本ラウンドで追加したファイルにエラー・警告なし） |
| `npm run build` | **失敗**。`/api/game/[gameCode]/admin/clone` の `STAGING_KV_REST_API_URL` 未設定による既知の環境要因（本ラウンドの変更とは無関係。TypeScriptコンパイル自体は成功） |

### 期待値を更新した既存テスト（旧係数を数値で固定していたもの）

`capex/__tests__/pdMechanization.test.ts`、`companyLab/__tests__/pdMechanizationState.test.ts`、
`companyLab/__tests__/pdMechanizationWorkerConnection.test.ts`、
`production/__tests__/labor.test.ts`、`companyLab/__tests__/workforce.test.ts`、
`companyLab/__tests__/test15FourCaseSimulation.test.ts`、
`companyLab/__tests__/test15NewFactoryDecisionInput.test.ts`、
`standardAi/report/__tests__/standardBaseline.test.ts`

## §12 未解決・次の校正候補

1. **標準初期条件（SAI-3A moderate-pressure）の再選定が必要。** PD係数 1.2 → 1.8 により、
   12シード・8四半期で全社が支払不能に至るようになった。これは旧係数を前提に
   キャリブレーションされていたことの帰結である。**係数を戻せばテストは通るが、
   それは設計値をテストに合わせることになるため行わなかった。** 標準初期条件側
   （初期現金・初期人員・初期契約）の再選定を次の校正候補として記録する。
2. **自動方針（autoPolicy）が常用人員の減員判断を持たない。** このため比較
   シミュレーションでは省人化の理論効果が一切PLに現れない。Standard AI 側には
   減員判断があるので、Standard AI を使った比較でどこまで回収できるかの実測が
   次の課題。
3. **残業削減の経路は現状の比較シナリオでは発火していない。** 自動方針が残業率を
   ほぼ固定で出すため、機械化による残業削減という現れ方を実測できていない。
4. **比較シミュレーションのケースCが B とほぼ同値（-1.5M）**。これは失敗ではなく
   「減員しなければ回収できない」ことの正しい表れだが、減員を伴うケースを
   追加しないと「適時の省人化は報われる」という設計意図の実証にはならない。
5. **`salesCapacityTons` 等の一部の生データ列が未接続**（前ラウンドからの継続）。

---

# 【実装ラウンド5】Standard AIによる実現効果の実証

作成日: 2026-08-02

前ラウンドの比較は `generateAutoPolicyDecision` を使っていたが、自動方針は
**常用人員の減員判断を持たない**ため、省人化の理論効果が一切PLへ現れなかった
（ケースC ≈ ケースB）。Standard AI は `decision/labor.ts` の `sustainedExcess`
経路で減員判断を持つので、同じ比較を Standard AI で走らせ直した。

`npx tsx scripts/pdMechanizationComparison.ts --standard-ai [--write]`

## §1 Standard AI による5ケース比較（20四半期・5社・3シード平均）

| ケース | PD生産(t) | 契約(t) | 期末在庫(t) | 投資額 | 累積純利益 | 期末現金 |
| --- | --- | --- | --- | --- | --- | --- |
| A HOSO中心・省人化なし | 73,933 | 537,929 | 917 | 0 | -827,695,721 | -171,484,529 |
| B PD中心・省人化なし | 264,696 | 531,954 | 22,332 | 0 | -402,612,368 | -61,922,732 |
| C PD中心・適時省人化 | 264,836 | 531,792 | 23,379 | 3,833,333 | **-402,416,741** | -63,099,202 |
| D PD+VAP・適時省人化 | 253,115 | 568,350 | 19,724 | 6,000,000 | -279,471,642 | -35,758,920 |
| E 販売見込み無しで省人化 | 61,755 | 137,879 | 0 | **0** | **-1,174,178,858** | -148,598,397 |

ケース間の差（累積純利益）:
- B − A = **+425,083,353**（PD中心はHOSO中心を大きく上回る。自動方針の +84M より鮮明）
- **C − B = +195,627**（適時の省人化が、わずかだが基準を上回った）
- D − B = +123,140,725
- E − B = **-771,566,490**

## §2 理論効果と実現効果の分離（基準 = B）

| ケース | 理論削減額(USD) | 常用人件費差 | 臨時人件費差 | 残業費差 | 人件費合計差 | **実現率** | 期末常用人員 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A | 0 | -33,797,667 | -4,600,000 | -4,924,624 | -43,322,291 | － | 16,457 |
| B | 0 | 0 | 0 | 0 | 0 | － | 17,590 |
| **C** | **3,462,844** | **+2,547,667** | -121,867 | -131,329 | **+2,294,471** | **66%** | 17,462 |
| D | 6,868,224 | -18,649,000 | -2,517,333 | -2,696,476 | -23,862,810 | -347% | 17,875 |
| E | 0 | +80,398,667 | +1,856,533 | +1,990,489 | +84,245,689 | － | 10,164 |

**ケースCが本ラウンドの答えである。** 理論削減 3,462,844 USD に対し、実際に
人件費として現れたのは **2,294,471 USD（実現率66%）**。うち常用人件費の削減が
2,547,667 USD で、`sustainedExcess` 経路による減員が実際に効いている
（期末常用人員 17,590 → 17,462）。自動方針では実現額が**ゼロ**だったので、
「減員判断の有無が実現の分かれ目」という前ラウンドの診断が裏付けられた。

**Dの実現率が負なのは比較の切り分けの限界である。** DはVAPも作るため営業・
生産構成そのものがBと異なり、人件費もBより多い。C vs B だけが「省人化以外の
条件が同一」という意味でクリーンな比較になる。

**ケースEでは省人化投資が実行されていない（投資額 0）。** ゲートを強制的に
突破させたのではなく、turn2 の提案が資金条件で却下された結果である。
したがってEの -771M の悪化は**省人化のせいではなく、販売見込みを作らない戦略
そのものの結果**である。「販売見込みが無いときに省人化が損になる」ことの実証
としては、E は投資が実行されていない以上、直接の証拠にはならない。この点は
正直に不足として記録する（単体レベルでは PDB-7/9 がゲートの動作を実証している）。

## §3 実現回収期間

| ケース | 投資額 | 実現削減/四半期 | 実現回収期間 | 理論回収期間 |
| --- | --- | --- | --- | --- |
| C（turn8実施、効果12四半期） | 3,833,333 | 191,206 | **20.0四半期** | 7.5四半期（PD要員1,000人前提） |
| D | 6,000,000 | 負 | 回収不能（切り分け不可） | — |

**実現回収 20.0四半期は、理論回収 7.5四半期を大きく上回る。** 原因は、
この比較のPD関連常用要員が理論値の前提（1,000人規模）より小さく、かつ
減員が `sustainedExcess` のダンピング（段階的縮小）を経るため、削減が
一度に出ないことによる。目安の 4〜8四半期には**届いていない**。
投資額・価格・需要はいずれも調整していない。

## §4 有利局面 vs 回収期間の実証（§b）

市場進化により、PDプレミアム比率は序盤〜中盤に高原を作り、他産地のPD加工参入で
turn16前後から圧縮に入る。同じPD中心プロファイルに対し、**省人化の実施時期だけ**を
変えて比較した。

`npx tsx scripts/pdMechanizationComparison.ts --window`

| 実施時期 | 省人化turn | 有利局面中の純利益（〜t16） | 有利局面後の純利益（t17〜） | 累積純利益 | 投資額 | 実現人件費削減 | vs 実施なし |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 実施なし | － | -326,709,710 | -75,902,657 | -402,612,368 | 0 | 0 | — |
| 早すぎ | 4 | -326,857,670 | -76,327,459 | -403,185,129 | 1,666,667 | **-1,081** | **-572,761** |
| 有効レンジ内 | 8 | **-325,422,010** | -76,994,731 | -402,416,741 | 3,833,333 | **+2,294,471** | **+195,627** |
| **有効レンジ内・測定範囲で最大** | **12** | -326,785,410 | -75,530,219 | **-402,315,629** | 5,333,333 | +1,517,888 | **+296,739** |
| 遅すぎ | 16 | -326,709,710 | -76,528,382 | -403,238,093 | 5,000,000 | +259,610 | **-625,725** |

**明確な山型が出た。** 実施が早すぎても遅すぎても負ける。

- **turn4（早すぎ）が負ける理由は「有利局面が短い」からではない。** 機械化レベルは
  「習熟進捗 × 前四半期のPD稼働率」で決まるため、PD稼働率がまだ立ち上がっていない
  turn4 では機械化レベルがほとんど上がらず、実現削減が -1,081（実質ゼロ）に留まる。
  投資額だけを負担して終わる。
- **turn16（遅すぎ）が負ける理由は回収期間の不足である。** 実現削減は 259,610 と
  正だが、残り4四半期では 5,000,000 の投資を回収できない。
- **有効な実施レンジは turn8〜12。** 有利局面の中で、かつPD稼働率が立ち上がった
  あとに実施したときだけ、投資が回収方向に働く。
  **測定した4候補（turn4/8/12/16）の中では turn12 の累積効果が最大**
  （+296,739、turn8 は +195,627）。
  ただしこれを「最適な実施時期」と読んではならない。実施時期の最適点は
  将来需要の伸び方・労働制約の強さ・現金余力・評価期間の長さ（ここでは20四半期）で
  移動する。本比較は4点しか測っておらず、単一指標（累積純利益）での順位付けに
  すぎない。投資判断をこの1指標で最適化した、という主張ではない。

これは Standard AI のゲートが持つ2条件（稼働率しきい値＝労働が実際に律速か、
および 回収期間×1.5 が有利局面に収まるか）が狙っていた挙動そのものである。
ただし**そのゲート自体は、この比較のどのケースでも自発的には発火していない**（§5）。

## §5 Standard AI の自発的な省人化提案 → **0件**

5ケース×3シード×20四半期のすべてで、Standard AI が自ら省人化を提案した件数は
**0件**だった（比較で実行された省人化は、いずれもケースプロファイルによる強制投入）。

理由は §16-1 と同じ資金構造の問題である。ゲートは
「投資後も現金 ≥ 目標最低現金 × 2.0」を要求するが、この経済では序盤〜中盤の
現金余力がほぼ常に負であり、その条件が満たされない。つまり**ゲートは正しく
動いており、正しく見送っている**。ゲートを緩めれば提案は出るが、それは
「資金が危ういのに投資させる」ことになるため行っていない。

## §6 残業削減の経路（§c）

- **run レベル: 発火していない。** Standard AI でもケースCの残業費差は -131,329
  （むしろわずかに増）であり、「機械化により残業を削った」という現れ方は
  観測できていない。Standard AI の労務判断は残業率を生産不足時の補助手段として
  出すため、機械化で必要人員が下がっても残業率が先に下がる構造になっていない。
- **単体レベル: 機構は正しく動く。** PDB-11 が、残業で埋めていた不足を機械化が
  解消した場合に残業費が実際に消えること（常用人件費は不変のまま）を実証している。

つまり「機構はあるが、現行のAIの労務判断ではその経路を選ばない」というのが
正確な状況である。

## §7 SAI-3A 標準初期条件の再選定について（§d・着手はしない）

PD係数 1.2 → 1.8 により、`SELECTED_STANDARD_BASELINE_CANDIDATE_ID = "moderate-pressure"`
は12シード・8四半期で全社が支払不能に至るようになった。再選定を行う場合の
作業の見取り図を残す。

**何を動かすことになるか**（`standardAi/report/standardBaseline.ts` の候補定義）
- 初期現金・初期借入枠（最も直接的に効く）
- 初期常用ワーカー人数と工場能力の比（PD係数が上がった分、同じ生産量に必要な
  人員が1.5倍になっているため、ここが実質的な主因）
- 初期契約残（初期の売上確保）
- 初期営業人員（前ラウンドの営業能力再設計により、増員が効くようになっている）

**判定基準**（既存テストが表現していた設計意図）
- 12シード・8四半期で、全社が必ず支払不能にはならない（発散一辺倒でない）
- かといって全社が安全に生き残るのでもない（moderate pressure）

**おおよそのコスト**: 候補パラメータを2〜3軸（初期現金 × 初期人員）で
3〜4水準ずつ振り、`runStandardBaselineMultiSeed(候補, 12シード, 8Q)` を
9〜16通り走らせて支払不能率の分布を見る、という作業になる。1通りが
数百ミリ秒〜1秒程度なので計算自体は軽い。判断の中心は「どの支払不能率を
moderate と呼ぶか」の合意であり、そこはオーナー確認が要る論点になる。

**注意**: 再選定は Test15 の標準初期条件そのものを変えることになるため、
Test15 の既存ラボ・保存データとの関係を先に整理する必要がある
（現在の実装ラウンドはすべて opt-in フラグ側に閉じており、Test15 を
壊していない。標準初期条件の変更はその原則から外れる最初の変更になる）。

## §8 実装ラウンド5時点の未解決

1. **Standard AI が自発的に省人化を提案しない（0件）。** ゲートは正しく動いており、
   序盤〜中盤の現金余力が負であることが原因。ベースライン経済の資金構造の問題
   （§16-1 と同根）であり、投資判断側の問題ではない。
2. **実現回収 20.0四半期が目安 4〜8四半期に届かない。** PD関連要員の規模と
   減員のダンピングが原因。投資額・価格・需要は調整していない。
3. **ケースEでは省人化投資が資金条件で却下されたため、「販売見込み無しの省人化が
   損になる」ことの run レベルの直接証拠になっていない**（単体レベルでは PDB-7/9 が
   ゲートの動作を実証）。
4. **残業削減の経路が run レベルで発火しない**（単体では PDB-11 が機構を実証）。
5. **ケースDは省人化以外の条件がBと異なるため、実現率の切り分けができない。**
   クリーンな比較は C vs B のみ。
6. **SAI-3A 標準初期条件の再選定が未着手**（§7に見取り図を記録）。
