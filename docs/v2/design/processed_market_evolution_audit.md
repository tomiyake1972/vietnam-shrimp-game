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
