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
