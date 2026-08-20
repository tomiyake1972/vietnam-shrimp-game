# ShrimpX V2 — SAI Growth Expansion / DIV-5 Excess Cash Distribution 事前監査

**種別**: 実装前監査・設計提案（**コード変更なし**）
**対象コード**: `origin/integration/v2-current-20260818` HEAD `0400c4a`
（作業ブランチ `claude/nifty-faraday-q3y7gs` の直前commit `eabb9bf` はAI Meeting層のみの変更で、
`app/lib/v2/companyLab/standardAi/**` および `app/lib/v2/companyLab/vision/**` に差分は無い。
`git diff 0400c4a HEAD -- app/lib/v2/companyLab/standardAi` は空）
**実測環境**: Dynamic Scenario 2（`dynamic-scenario-2-v0.1`）5社×32Turn、seed `ds2-full-a` / `ds2-full-b`
**注記**: Dynamic Scenario 3はまだリポジトリに存在しない（`app/lib/v2/scenario/definitions/` にDS1・DS2のみ）。
本監査は「現行Standard AIが観測可能な世界に対してどう振る舞うか」の構造監査であり、
DS3側のパラメータは一切前提にしていない。

---

## Part A — Current growth architecture（成長チェーンの全段）

Standard AIの1四半期の意思決定順序は `standardAi/policy.ts` の
`generateStandardAiDecisionWithDiagnostics()` に一本化されている。実際の呼び出し順に並べる。

| # | 段階 | 実装 | 入力 | 式 / cap / floor | 診断reasonCode |
|---|---|---|---|---|---|
| 1 | Target Scale Band | `targetScale.ts` | 実効能力・前期実績 | `currentSustainableScale = 直近実績×(1−w) + bindingCapacity×w`、**w=`targetScaleCapacityWeightInBaseline`=1.0**（＝実質**能力そのもの**）。band = ×{min 1.0, pref 1.15, **max 1.35**}（BALANCED_GROWTH） | `SALES_CAPACITY_BELOW/WITHIN/ABOVE_TARGET_SCALE` |
| 2 | Vision解決 | `vision/overrides.ts` `defaults.ts` | companyId・turn | Q32参照規模: MASS 80,000 / BAL 34,000 / JPQ 30,000 / CONSV 27,000 / VAP 17,000 t/期。waypoint線形補間 | — |
| 3 | Strategic Growth | `vision/strategicGrowth.ts` | Vision参照規模・`currentSustainableScale` | `gapRatio=(ref−current)/ref`、`adjusted=gapRatio×sensitivity{HIGH 1.2/MED 1.0/LOW 0.7}`、pressure閾値 0.05 / 0.18 / 0.35 → LOW / MODERATE / HIGH / URGENT | — |
| 4 | 観測商業機会 | `decision/sales.ts::computeObservableCommercialOpportunity` | `observation.markets`（**2四半期遅行の公開実績**） | `attainable = Σ_{market×product} observedDemand × maximumSupplierShare(0.35)`、ただし **参照売価が観測でき、かつ 参照売価−加工費>0 のセルのみ** | — |
| 5 | Commercial Ambition | `vision/commercialAmbition.ts` | 上記＋在庫＋貢献 | `baseline = max(能力×0.8, 前期実績生産)`<br>`stepped = baseline×(1 + maxStep{HIGH .12/MED .07/LOW .03} × intensity{LOW 0/MOD .5/HIGH .8/URG 1})`<br>`ambition = min(stepped, visionRef, attainable×**0.35**)`<br>早期return: pressure<MODERATE / 在庫過剰比>1.5 / 機会観測不能 / 貢献<0.05 USD/kg → **baselineで据え置き** | limiter: `VISION_ON_TRACK` / `MARKET_WEAK` / `MARGIN_WEAK` / `INVENTORY_EXCESS` / `STEP_LIMIT` / `OPPORTUNITY_CEILING` |
| 6 | Crisis Gate | `crisisState.ts` | 前Turnの調達スケール比・underwriting凍結・health tier | commitmentのみ縮小/停止（ambitionは不変） | `CRISIS_*` |
| 7 | Commercial Commitment | `vision/commercialCommitment.ts` | ambition・転換率観測・営業能力 | `conversionAdj = ambition / expectedConversion`（expected は観測×0.7 + 0.825×0.3、下限0.35、履歴無しは0.90）<br>`submission = min(conversionAdj, ambition×1.25, attainable×**0.5**, salesCapacityCeiling)` | limiter: `NONE`/`RECENT_CONVERSION`/`STRETCH_LIMIT`/`MARKET_OPPORTUNITY`/`SALES_CAPACITY`/`CRISIS` |
| 8 | 販売計画 | `decision/sales.ts::buildStandardAiSalesPlans` | 上記 | `potential[p] = totalCapacity[p] × salesUtilizationTarget(0.8) × ambitionMultiplier`（商品志向×0.85〜1.20、ライフサイクル前傾は能力の98%上限）<br>`desired[p] = potential[p] × orderFactor[p]`、市場配分後に営業工数制約と`submissionTarget`で上から抑える | `LOW_ORDER_BOOK_PREMIUM_FLOOR` 等 |
| 9 | 当期納品需要 | `diagnosis/currentPeriodDeliveryDemand.ts` | 現実的販売可能量・受注残 | `demand = realisticSales × productionExpectedConversion + outstandingContract` | — |
| 10 | 生産必要量 | `diagnosis/productionRequirement.ts` | 上記 | `需要 + 通常在庫目標(参照生産×`finishedGoodsTargetQuarters`=0.35) − 期首FG`、下限0 | — |
| 11 | 生産計画 | `decision/production.ts` | 上記 | 工場別・商品別能力でcap、複数工場は能力比按分 | `CONTRACT_FULFILLMENT_PRIORITY` / `FINISHED_GOODS_EXCESS` |
| 12 | 原料調達 | `decision/procurement.ts` | **生産計画合計のみ** | 養殖 ≤ 必要量×0.35、輸入 = 必要量×`importMixRatio`、国内 = 残余＋在庫補正（下限 base×0.2、上限 base×2+目標在庫） | `PROCUREMENT_*` |
| 13 | 労働 | `decision/labor.ts` | 生産計画 | `newRegular = current + 0.5×(required − current)`（`regularHeadcountAdjustmentDamping`=0.5）、一時不足は残業・臨時 | `LABOR_*` |
| 14 | 財務 | `decision/finance.ts` | 現金圧力・調達計画 | 最低現金バッファ＋当期調達所要 | `FINANCING_*` |
| 15 | CAPEX（既存増設） | `decision/capex.ts` | 稼働率・トレンド | 持続稼働率 ≥ **0.92**（`capexSustainedUtilizationThreshold`）、成長参入は稼働率 ≥ **0.85** かつ トレンド ≥ 0.004/期、資金ゲート（`capexCashSafetyMultiple`=1.75 等） | `CAPEX_*` |
| 16 | CAPEX（新工場） | `decision/newFactory.ts` | Vision・gap・稼働率・需要・原料・労働・財務 | Gate A〜L（後述Part A-2） | `NEW_FACTORY_*` |
| 17 | 営業採用 | `decision/salesForceHiring.ts` | 販売希望・能力・経済性 | `target = min( max(targetScaleBand.max, ambitionTons), productionSupportedScale )`<br>`productionSupportedScale = 4Q以内完成のCAPEXがあれば targetScaleBand.max、無ければ **現在の実効生産能力**`<br>採用速度 `max(3, ceil(現員×0.30))/期` | `SALES_HIRING_BLOCKED_BY_PRODUCTION` 他 |
| 18 | 配当 | `decision/dividend.ts` | Period・財務・CAPEX提案 | Gate A〜G（Part F） | `DIVIDEND_*` |

### A-2. 新工場 Gate 一覧（`decision/newFactory.ts`）

| Gate | 内容 | 閾値（`STRATEGIC_POSTURE_PARAMETERS`） |
|---|---|---|
| A | Visionが存在するか | — |
| B | 志に対して遅れているか | `strategicScaleGap > 0` |
| C | 検討/提案に必要な成長圧力 | 検討: willingness HIGH/MED → MODERATE、LOW → HIGH。提案: HIGH/MED → **HIGH**、LOW → **URGENT** |
| D | 既に新工場案件が進行中か | `pendingNewFactoryProjectCount == 0` |
| E | 工場数上限 | `maxFactoriesPerCompany` |
| F | 既存工場の増設余地を先に使う | 残スペース > **3,000 units** かつ gapRatio ≤ **0.30** なら**保留** |
| G | 当期すでに既存増設を提案済みか | gapRatio ≤ 0.30 なら保留 |
| H | 既存能力が使われているか | binding稼働率 ≥ **0.75** |
| I | 需要の裏づけ | `生産必要量 / binding能力 ≥ **0.95**` **または** 生産能力起因の未充足機会が持続 |
| J | 原料供給の裏づけ | 観測diagnosis |
| K | 労働力の裏づけ | `laborStrainCeiling` 1.15 |
| L | 財務 | `upfrontCoverageRatioByRiskTolerance` HIGH .6 / MED .85 / LOW 1.1 |
| （別route） | Forward Capacity Gap（AGGRESSIVE_EARLY_CAPACITY） | `forwardCapacityGap = max(0, min(vision参照規模@完成turn, 現能力×(1+観測成長率)^lead) − 現能力)` |

---

## Part B — 30kt ceiling root cause

### B-1. 実測（DS2 / seed ds2-full-a / 32Q）

Turn32時点の提出販売希望量と、各capの値：

| 会社 | 希望販売量 | ambition | ambition limiter | submission | commitment limiter | `attainable×0.5` | 営業能力上限 | Vision参照 |
|---|---|---|---|---|---|---|---|---|
| BAL | 26,400 | 26,400 | MARKET_WEAK | 27,704 | **MARKET_OPPORTUNITY** | **27,704** | 31,993 | 34,000 |
| MASS | 27,704 | 41,960 | MARKET_WEAK | 27,704 | **MARKET_OPPORTUNITY** | **27,704** | 51,542 | 80,000 |
| JPQ | 27,704 | 27,760 | MARKET_WEAK | 27,704 | **MARKET_OPPORTUNITY** | **27,704** | 37,961 | 30,000 |
| VAP | 26,840 | 26,840 | VISION_ON_TRACK | 27,704 | MARKET_OPPORTUNITY | 27,704 | 36,820 | 17,000 |
| CONSV | 27,240 | 27,240 | VISION_ON_TRACK | 27,704 | MARKET_OPPORTUNITY | 27,704 | 37,586 | 27,000 |

**5社すべてが同一の値 27,704 に張り付いている。** これは会社状態に依存しない量だからである：

```
submissionCap = attainableProfitableTons × realisticShareOfOpportunity
              = ( Σ_{採算セル} observedDemand × maximumSupplierShare(0.35) ) × 0.5
              = 0.175 × 観測採算需要合計
T32: 55,407 × 0.5 = 27,704
```

`observedDemand` は **公開情報（2四半期遅行の市場実績）** であり全社共通、`maximumSupplierShare` も
`0.5` も全社共通定数なので、**このcapは会社を区別しない**。したがって
「BAL / MASS / JPQ / CONSV が揃って約29,827t」という報告された観測と、
本監査の再現（揃って27,704t）は**同一の構造**である
（数値差はシナリオ／seedによる `observedDemand` の違いだけ）。
**VAPだけ低い（報告値15,561t）のも構造的に説明できる**：VAPは `growthAmbition=LOW` かつ
Vision参照規模が小さいため `growthPressure=LOW` になり、Commercial Ambitionが
`VISION_ON_TRACK` で **baseline（能力×0.8 と前期実績の大きい方）に据え置かれる**。
すなわちVAPのcapはmarket capではなく**自社Vision**である。

### B-2. limiterの出現頻度（2 seed × 5社 × 32Q）

| limiter | 全期(160×2) | T17以降(80×2) |
|---|---|---|
| Ambition: `VISION_ON_TRACK`（志に追いついたので伸ばさない） | 58 / 63 | **43 / 48** |
| Ambition: `MARKET_WEAK`（`attainable×0.35 ≤ baseline`） | 32 / 32 | 23 / 21 |
| Ambition: `STEP_LIMIT`（1期の伸び上限） | 62 / 59 | 9 / 7 |
| Commitment: `MARKET_OPPORTUNITY`（`attainable×0.5`） | 28 / 28 | **28 / 28** |
| Commitment: `SALES_CAPACITY` | 4 / 3 | 4 / 3 |
| 採用0の理由: `SALES_HIRING_BLOCKED_BY_PRODUCTION` | **67 / 77** | — |
| 採用0の理由: `SALES_HIRING_NOT_ECONOMIC` | 46 / 49 | — |

### B-3. 30kt ceilingを作っている式（明示・暗黙の全件）

| # | 種別 | 式 / 値 | 効果 |
|---|---|---|---|
| **RC-1** | **市場機会cap（明示）** | `submission ≤ attainableProfitable × 0.5`、`ambition ≤ attainableProfitable × 0.35`。`attainableProfitable = Σ observedDemand × 0.35` | **全社が同一値へ収束する主因**。実効的に「観測採算需要の17.5%」が販売上限 |
| **RC-2** | **Vision参照規模cap（明示）** | `ambition ≤ visionTargetScaleAtCurrentTurn`。Q32値 17,000〜34,000（MASS除く） | 4社は**自分のVisionに追いつくと成長を止める**（`VISION_ON_TRACK`が最頻） |
| RC-3 | 供給側アンカー（暗黙） | `baseline = max(能力×`salesUtilizationTarget`(0.8), 前期実績)` | 能力を増やさない限りbaselineが上がらない。**Vision導入前はこれ単独が全ceilingだった**（`commercialAmbition.ts` 冒頭の実測記録: 5社全32Qで誤差0） |
| RC-4 | 段階成長cap | `stepped = baseline × (1 + maxStep × intensity)`、最大 `+12%/期`（HIGH×URGENT） | 32Qで理論上 `1.12^32 ≈ 36倍` なので**単独ではceilingにならない**が、上の各capと組み合わさると効く |
| RC-5 | 採算セルfilter | 参照売価未観測 or 貢献≤0 のセルは `attainable` から**全落ち** | `attainable` が 83,126（T8）→41,627（T12)→35,201（T20)→55,407（T32）と乱高下し、cap自体が不安定 |
| RC-6 | 営業採用の生産能力cap | `target = min(max(band.max, ambition), 実効生産能力)`（4Q以内完成CAPEXが無い場合） | 採用0の**最頻理由**（67〜77件/160）。営業増員が生産能力に従属 |
| RC-7 | Target Scale Band | `band.max = bindingCapacity × 1.35`、`capacityWeight = 1.0` | Target Scale自体が能力の関数（＝独立した成長目標になっていない） |
| RC-8 | CAPEXゲート | 既存増設 稼働率 ≥ 0.92（成長参入0.85＋トレンド0.004）、新工場 Gate H 0.75 / Gate I `需要/能力 ≥ 0.95` | 販売希望が能力×0.8で作られる限り `需要/能力` は 0.8 前後から動かない（`newFactory.ts` §21/§22のコメントが同じ指摘をしている） |
| RC-9 | 在庫brake | `ambition` 早期return: `maxFinishedGoodsExcessRatio > 1.5`。`excessInventoryRatioForDiscount = 1.3` | 実測では稀（INVENTORY_EXCESS 3/160・2/160）。**過剰brakeにはなっていない** |
| RC-10 | 転換率学習 | `submission ≤ ambition × 1.25`、`expectedConversion` 下限0.35 | 実測 `RECENT_CONVERSION` 6/160・3/160。副次的 |

### B-4. Historical anchoring（§5）の確認

「前期売上×(1+5%)」のような**明示的な履歴アンカーは存在しない**。ただし実質的な履歴依存が2つある：

1. `baseline = max(能力×0.8, **前期実績生産**)` — 実績が能力を上回るときだけ実績が基準になる。
2. `targetScale.currentSustainableScale` は `capacityWeight=1.0` により**実績を使っていない**（能力のみ）。

到達可能量の上界（他capが効かない理想ケース）：

```
32Q後 = baseline_Q1 × (1 + maxStep × intensity)^31
  HIGH ambition × URGENT   : 1.12^31 = 32.0 倍  → BAL 16,000t → 512,000t（理論値）
  MEDIUM ambition × MODERATE: 1.035^31 = 2.9 倍 → 46,400t
  LOW ambition × MODERATE   : 1.015^31 = 1.58倍 → 25,300t
```

つまり**段階成長率そのものはDS3規模を阻害しない**。阻害しているのは RC-1 と RC-2 である。

### B-5. 営業能力側の算術（§11）

現行モデル `SALES_CAPACITY_MODEL_COMPANY_ORGANIZATION_V1`（`kind: companyWide`、市場分割ペナルティ無し）：

```
capacity(h) = 1,000 + 95,000 × h/(h+190)   [営業工数トン/四半期]
商品別実トン数 = capacity(h) / 工数係数（HOSO 1.0 / PD 1.2 / VAP 3.0）
```

| 営業人数 h | 工数能力 | HOSOのみ | PDのみ | VAPのみ |
|---|---|---|---|---|
| 60 | 23,800 | 23,800 | 19,833 | 7,933 |
| 100 | 33,759 | 33,759 | 28,132 | 11,253 |
| 150 | 42,912 | 42,912 | 35,760 | 14,304 |
| 200 | 49,718 | 49,718 | 41,432 | 16,573 |
| 300 | 59,163 | 59,163 | 49,303 | 19,721 |
| 500 | 69,841 | 69,841 | 58,200 | 23,280 |
| 1,000 | 80,832 | 80,832 | 67,360 | 26,944 |
| **h→∞（漸近上限）** | **96,000** | **96,000** | **80,000** | **32,000** |

**DS3想定規模との突合（重要・Stop Condition §34-2該当）**

| 会社 | DS3想定 | 必要営業工数 | 判定 |
|---|---|---|---|
| MASS 90,000〜100,000t（HOSO主体） | 90,000〜100,000 | 90,000→h≈1,610 / **100,000 は漸近上限96,000を超え到達不能** | ⚠ 90ktでも営業1,600人規模、100ktは**数学的に不可能** |
| BAL 55,000〜65,000t（3品目混合） | 混合係数≈1.3 なら 71,500〜84,500 | h≈340〜1,300 | 到達可能だが極端な増員 |
| JPQ 45,000〜55,000t（PD主体） | ×1.2 = 54,000〜66,000 | h≈230〜460 | 到達可能 |
| **VAP 45,000〜55,000t（VAP主体）** | ×3.0 = **135,000〜165,000** | **漸近上限96,000を大幅超過** | ⚠ **数学的に到達不能** |
| CONSV 45,000〜50,000t | 混合 ≈ 50,000〜65,000 | h≈240〜460 | 到達可能 |

---

## Part C — Growth deadlock

§16で提示された循環は**現在も部分的に存在する**が、Phase 6のVision層によって完全な閉ループではなくなっている。実測に基づく現状の因果は次のとおり。

```
              ┌───────────────────────────────────────────────┐
              │                                               │
      生産能力（binding capacity）                             │
              │                                               │
    ┌─────────┼───────────────┬───────────────┐               │
    ▼         ▼               ▼               ▼               │
targetScale  baseline      営業採用cap      CAPEXゲート分母      │
band.max     =能力×0.8    =実効生産能力      需要/能力≥0.95     │
    │         │               │             稼働率≥0.92        │
    └────┬────┘               │               ▲               │
         ▼                    │               │               │
   Commercial Ambition ───────┘               │               │
         │  ▲                                 │               │
         │  └── Vision参照規模 / attainable×0.35（外生cap）      │
         ▼                                                    │
   Commercial Commitment ≤ attainable×0.5（外生cap）            │
         ▼                                                    │
   販売提出 → 成約 → 当期納品需要 → 生産必要量 ──────────────────┘
                                      │
                                      ▼
                              原料調達（生産計画のみを見る）
```

**現存するdeadlock（実測で確認）**

1. **営業↔生産のdeadlock（最強・実測67〜77件）**
   `salesForceHiring.ts:345` — `productionSupportedScale = hasNearTermCapexUnderConstruction ? band.max : 実効生産能力`。
   一方CAPEXは「稼働率が高い」ことを要求する。**能力が余っている限り営業を増やせず、
   営業が増えないと能力が埋まらない。** 4Q以内完成のCAPEXがあるときだけ先行採用が許される、
   という抜け道が1つあるだけである。

2. **CAPEX需要ゲートの自己参照（`newFactory.ts` 自身がコメントで指摘）**
   販売希望が `能力×0.8` から作られるため `需要/能力` は構造的に0.8前後 → `≥0.95` に届かない。
   Phase 6で「生産能力起因の未充足機会が持続する場合」という第2根拠を足して緩和済みだが、
   その未充足機会は `ambition − 提出量` から導かれるので、**ambitionがcapされていると未充足も出ない**。

3. **procurement → 実績 → baseline の弱いループ**
   調達は生産計画のみを見る（`procurement.ts` の入力は `requiredRawMaterial` 単独）。
   生産が小さいと実績が小さく、`baseline = max(能力×0.8, 前期実績)` の実績側が上がらない。
   ただし能力側が下限として効くため**自己強化ループとしては弱い**（実測でも支配的ではない）。

**deadlockではないもの（誤診しないための明示）**
- 在庫brake（`INVENTORY_EXCESS` 3/160）— 過剰brakeになっていない。
- backlog — `commercialCommitment.ts §12` が明示的に「在庫を理由に提出を減らさない」としており、
  backlogは `outstandingContractByProduct` として**生産必要量へ100%加算**される。
  **backlogがsales targetを抑える設計にはなっていない**（§8の懸念は現行コードには当てはまらない）。
  ただし **backlogを「将来の需要可視性」として成長根拠に使ってもいない**（Part D参照）。

---

## Part D — Market opportunity の使用/未使用（§7）

Standard AIが観測できる事実（`standardAi/types.ts::StandardAiObservation`）と、
それが**現在のsales target計算に使われているか**の一覧。

| 観測可能な事実 | フィールド | sales target計算での使用 |
|---|---|---|
| 市場別・商品別 観測需要（2Q遅行） | `markets[].observedDemandByProduct` | ✅ `attainable` の基礎、市場配分重み |
| 市場別・商品別 参照売価 | `markets[].referencePriceByProduct` | ✅ 採算判定・機会スコア |
| 期待加工コスト | `productEconomics.expectedProcessingCostUsdPerHosoEqKg` | ✅ 貢献利益 |
| 需要観測の遅行期数・出所 | `marketDemandObservationLagQuarters` / `Source` | ❌ 未使用 |
| ライフサイクル構成比・トレンド | `lifecycleSharesByMarket` / `lifecycleTrendByMarket` | △ PD/VAPの小幅前傾のみ（`growthTrendResponsiveness`、既定0で**不活性**）。CAPEX成長参入でも使用 |
| 商品別供給圧力 | `productSupplyPressureByProduct` | △ 抑制方向のみ（`oversupplyRetreatSensitivity`、既定0で不活性） |
| 市場の未消化供給・成約量 | `MarketConditionObservation.unsoldSupply` / `transactedVolume` | ❌ 未使用 |
| 顧客信頼・納期信頼性 | `customerTrustByMarket` / `deliveryReliabilityByMarket` | ❌ sales targetには未使用 |
| 品質スコア | `qualityScoreByProduct` | ❌ sales targetには未使用 |
| 自社の受注残 | `outstandingContractByProduct` | △ **生産**必要量には100%使用。**成長判断には未使用** |
| 完成品在庫 | `finishedGoodsByProduct` | △ 抑制方向のみ（ambition据え置き・値引き） |
| 提出→成約 転換率 | `commercialHistory.ts::observeContractConversion` | ✅ commitment（抑制方向） |
| 未充足機会の原因分解 | `vision/unservedOpportunity.ts` | △ **新工場Gate Iのみ**。sales targetには未接続 |
| 市場シェア | — | ❌ 観測に存在しない |
| 失注量（lost opportunity） | — | ❌ 観測に存在しない（提出−成約の差分は算出可能） |

**要点**: 成長を**加速**する方向に効いている観測は
「観測需要 × 0.35 × (0.35 or 0.5)」の1本だけであり、
`unservedOpportunity`・`backlog`・`trust`・`unsoldSupply`・`conversion>目標帯` といった
「もっと取りに行ってよい」という証拠は、いずれも sales target へ配線されていない。

---

## Part E — SAI Growth Expansion 代替案（§17・§18）

### E-0. 共通前提

- 会社別の固定Volume Targetは作らない（§2）。
- 判断は必ず observable facts から。未公開の将来イベントは使わない（Part K）。
- 追加するのは**係数ではなく「圧力（0〜1）」**であり、既存の各ゲートを免除しない。

### E-1. 案A: Opportunity-driven growth pressure（機会ドリブン）

`attainable` に掛かる2つの控えめ係数（0.35 / 0.5）を**固定値から観測駆動の可変値**へ置き換える。

```
opportunityShare = base + span × f(observable evidence)
  evidence 例: 直近の転換率が目標帯上限を超えている / 未充足機会が生産能力起因でない /
               在庫が過少 / 市場のunsoldSupplyが小さい（＝取り合いが緩い）
```

| 観点 | 評価 |
|---|---|
| メリット | 変更点が2定数に閉じる。実装量最小。市場が弱ければ自動的に止まる（機会そのものに比例するため） |
| リスク | **全社が同時に同じだけ上がる**（機会は公開情報＝会社差が出ない）。5社の同時提出が市場総需要を超え、成約率崩壊→在庫増（Phase 6Bで実測済みの崩壊パターン）を再現しうる |
| DS1/DS2 regression | 中〜高（全社の提出量が一律増える） |
| profile differentiation | ❌ ほぼ出ない |
| bounded rationality | ○（観測のみ） |
| parameter複雑性 | 低 |

### E-2. 案B: Vision-distance × observable opportunity（志との距離 × 機会）

`growthPressure`（既存）と観測機会を**掛け合わせて**成長圧力を作り、
`ambition` の step だけでなく **opportunityShare・営業採用先行・CAPEX検討** にも同じ圧力を流す。

```
growthPressureScore ∈ [0,1]
  = w1 × visionDistance      (= clamp(strategicScaleGapRatio × ambitionSensitivity, 0, 1))
  × w2 × opportunityEvidence (= 観測機会に対する自社提出比の不足度)
  × w3 × economicsGate       (= 貢献利益・margin trend が正のときのみ >0)
```

| 観点 | 評価 |
|---|---|
| メリット | **既存の Vision / growthPressure 構造をそのまま使える**（新概念の追加が最小）。会社ごとにVisionが違うので**自然に差が出る**。市場・採算が悪ければ0になる |
| リスク | Vision参照規模が実質的な上限として残るため、**Vision calibrationの品質にDS3到達性が依存**する（現行Q32値のままでは30kt前後で止まる＝RC-2） |
| DS1/DS2 regression | 中（VisionはDS非依存なので、機会が乏しいDSでは自動的に抑制される） |
| profile differentiation | ✅ 高（growthAmbition・willingness・emphasisProductsが既に会社別） |
| bounded rationality | ○ |
| parameter複雑性 | 中 |

### E-3. 案C: Completion-horizon forward demand pressure（完成時点需要ドリブン）

既存 `forwardCapacityGap.ts` の思想（「工場が完成する時点で必要になる規模」）を
**販売・営業採用側へも拡張**する。今の稼働率ではなく「lead time後に必要な規模」で
営業採用・CAPEX・調達を先行させる。

| 観点 | 評価 |
|---|---|
| メリット | 営業採用↔生産能力のdeadlock（Part C-1）に**直接効く**（先行採用の根拠が「完成時点需要」になる）。既存モジュールの再利用 |
| リスク | 予測に基づく先行投資であり、外れたときのdownsideが大きい（在庫・遊休人件費）。`observedGrowthRatio` の観測欠落時に楽観へ倒れやすい |
| DS1/DS2 regression | 中〜高（先行投資が増えるため、不況シナリオで財務が痛む） |
| profile differentiation | ✅ 高（`strategicPosture` が既に AGGRESSIVE_EARLY_CAPACITY / DEMAND_CONFIRMED / VALUE_FIRST で分岐） |
| bounded rationality | △（「完成時点の需要」は推定値） |
| parameter複雑性 | 中〜高 |

### E-4. 案D（追加提案）: Constraint-routing pressure（制約ルーティング）

上記のいずれとも直交する補助案。`unservedOpportunity` の**原因分解を成長圧力の行き先の決定に使う**。

```
成長圧力の総量は A/B/C いずれかで決め、その圧力を「どこへ流すか」は
unservedOpportunity の原因（SALES_CAPACITY / PRODUCTION_CAPACITY / LABOR / RAW_MATERIAL）で決める
```

- メリット: 「営業が足りないのに工場を建てる」「工場が足りないのに営業だけ増やす」を構造的に防ぐ。
  §18の「raw/capacity constraintなら供給投資へ圧力が移る」要件をそのまま満たす。
- リスク: 原因分解の精度に依存（現状 `OTHER` に落ちる量がある）。
- 単独では成長を起こせない（**AまたはBまたはCと必ず併用**）。

---

## Part E-5 — 推奨設計（§18）

**推奨: 案B（Vision-distance × observable opportunity）を主軸に、案D（constraint routing）を併用。
案Cは `strategicPosture = AGGRESSIVE_EARLY_CAPACITY` の会社にのみ限定適用。**

理由：
1. §18の停止条件（機会なし・margin悪化・在庫過多・cash/debt stress）が、**既存のgateをそのまま使って**すべて満たせる。
2. 会社差がVision由来で自然に出る（固定Volume Targetを作らない §2 を満たす）。
3. DS非依存（同じAIがDS1/DS2/DS3の観測環境の違いで自然に速度を変える §20 を満たす）。
4. 案Aの「全社同時膨張 → 成約率崩壊」という**実測済みの失敗モード**を避けられる。

### Growth Pressure の入力候補と意味（係数は未確定）

| 入力 | 出所（既存・observable） | 向き | 意味 |
|---|---|---|---|
| `strategicScaleGapRatio × ambitionSensitivity` | `strategicGrowth.ts` | + | 志に対する遅れ（会社別） |
| `attainableProfitableTons / 直近提出量` | `sales.ts` | + | 取りに行けていない機会の倍率 |
| 観測転換率 − 目標帯上限 | `commercialHistory.ts` | + | 出せば決まっている＝もっと出してよい |
| `unservedOpportunity.blockedBySalesCapacityTons` | `unservedOpportunity.ts` | +（営業採用へルーティング） | 営業が足りない |
| `unservedOpportunity.blockedByProductionCapacityTons` | 同上 | +（CAPEXへルーティング） | 能力が足りない |
| `weightedContributionUsdPerKg` | `sales.ts` | ×ゲート | 採算が薄ければ0 |
| `finishedGoodsExcessRatio` | `pressures.ts` | − | 在庫過多で停止 |
| `crisisState` / `lastQuarterFinancialHealthTier` | `crisisState.ts` | ×ゲート | 危機時は0 |
| `lifecycleTrendByMarket` | observation | + | 公開ライフサイクルが成長局面 |
| `productSupplyPressureByProduct` | observation | − | 供給過多局面では抑制 |
| Scenario公開シグナル（ニュース・構造トレンド） | Part K の A分類 | + / − | 公開済みのものだけ |

### 併せて必要になる構造変更（設計提案・未実装）

| # | 変更点 | 理由 |
|---|---|---|
| G-1 | `commercialAmbition.realisticShareOfProfitableOpportunity`(0.35) と `commercialCommitment.realisticShareOfOpportunity`(0.5) を **growth pressureの関数**にする | RC-1の解消。**この2定数を触らない限り30kt ceilingは絶対に破れない** |
| G-2 | Vision Q32参照規模の再calibration（DS3規模と整合させる） | RC-2の解消。**AI側の変更では破れない**（Visionはデータ） |
| G-3 | `salesForceHiring` の `productionSupportedScale` に、案Cの forward demand（またはgrowth pressure）に基づく先行採用許容を追加 | Part C-1 deadlockの解消（採用0の最頻理由） |
| G-4 | `targetScaleCapacityWeightInBaseline`(1.0) の見直し | Target Scaleが能力の関数である限り、能力以外の成長根拠を持てない |
| G-5 | 新工場 Gate I の需要根拠に `attainable × growthPressure` を追加 | 需要/能力 が構造的に0.8前後に張り付く問題 |
| G-6 | 営業能力モデル（`companyCapacityMaxIncrementTons` = 95,000）の見直し | **Part B-5のStop Condition。DS3のMASS/VAP規模は現行漸近上限で到達不能** |

### Profile differentiation（§19）

| 会社 | orientation（現行維持） | growth pressureへの作用（設計案） |
|---|---|---|
| BAL | balanced generalist | 標準感度。3品目・多市場に分散。投資閾値は中庸 |
| MASS | China / HOSO / volume | `growthAmbition=HIGH` + `AGGRESSIVE_EARLY_CAPACITY` → 感度最大、先行投資route許容、HOSO偏重の商品志向倍率 |
| JPQ | Japan / quality / PD | `DEMAND_CONFIRMED` → 実績確認後にのみ圧力を投資へ流す。品質スコア低下時は圧力を減衰 |
| VAP | US / VAP / processed | `growthAmbition=LOW` + `VALUE_FIRST` → 量の圧力は最小。圧力は**単価・付加価値（VAP tier）投資**へルーティング |
| CONSV | Europe / margin discipline | `financialRiskTolerance=LOW` → cash/debt gateを厳しく。margin低下で即停止 |

**禁止事項の担保**: 圧力が高くても市場・商品の選択は `marketOrientationMultipliers` /
`productOrientationMultipliers`（会社別）と観測機会重みが決めるため、全社が同一市場・同一商品へ
収束する構造にはならない。

---

## Part F — DIV-4 audit（現行配当の全ゲート）

`decision/dividend.ts`（`ANNUAL_DIVIDEND_QUARTER = 4`）

| Gate | 条件 | 不成立時のreasonCode |
|---|---|---|
| A | `quarter === 4`（年度末のみ） | `DIVIDEND_SKIPPED_NOT_ANNUAL_PERIOD` |
| A2 | 財務入力がすべて有限数 | `DIVIDEND_SKIPPED_INVALID_FINANCIAL_INPUT` |
| B | `lastQuarterFinancialHealthTier === "healthy"`（nullも不可） | `DIVIDEND_SKIPPED_NOT_HEALTHY` |
| C | `crisisState === "NORMAL"` | `DIVIDEND_SKIPPED_CRISIS` |
| D | `newCapexProposalCount === 0`（当期の新規設備投資提案がゼロ） | `DIVIDEND_SKIPPED_CAPEX_PLANNED` |
| E | 直近確定四半期の `netIncome > 0` | `DIVIDEND_SKIPPED_NO_CURRENT_EARNINGS` |
| F | `distributableEarnings > 0` | `DIVIDEND_SKIPPED_NO_DISTRIBUTABLE_EARNINGS` |
| G | `maxDividendUsd = min(cash, distributableEarnings) > 0` | `DIVIDEND_SKIPPED_NO_CAPACITY` |
| 額 | `base = max(0, 直近確定四半期NI) × dividendBasePayoutRatio(**0.15**)`、`min(base, maxDividendUsd)` へクランプ | `DIVIDEND_LIMITED_BY_*` / `DIVIDEND_PROPOSED` |

profile bias: `managementProfile.ts` の `dividendPropensityRatio`
（balanced 0 / growth −0.05 / opportunistic 0 / valueAdded −0.05 / conservative +0.05、
±5%・最大±10%ルール）が `dividendBasePayoutRatio` に乗る。

---

## Part G — Cash accumulation root cause（§22）

### G-1. 実測（DS2 / seed ds2-full-a / 32Q）

| 会社 | 配当回数 | 累計配当 | 32Q累計NI | 期末現金 | 期末借入 | 実効配当性向 | T32の`maxDividend` |
|---|---|---|---|---|---|---|---|
| BAL | 4 | 16.1M | 558.2M | **376.3M** | 0.0M | **2.9%** | 351.1M |
| MASS | 3 | 19.6M | 720.7M | **496.0M** | 0.0M | **2.7%** | 440.2M |
| JPQ | 2 | 8.6M | 593.6M | **369.0M** | 0.0M | **1.4%** | 197.6M（T28） |
| VAP | 2 | 6.9M | 505.0M | **275.8M** | 0.0M | **1.4%** | 173.4M（T28） |
| CONSV | **1** | **1.9M** | 607.0M | **384.9M** | 0.0M | **0.3%** | 25.6M（T8） |

Q4ごとのゲート通過状況（同run）：

| 会社 | T4 | T8 | T12 | T16 | T20 | T24 | T28 | T32 |
|---|---|---|---|---|---|---|---|---|
| BAL | E | ✅ | D(2) | D(1) | E | ✅ | ✅ | ✅ |
| MASS | E | F | D(2) | D(2) | D(1) | ✅ | ✅ | ✅ |
| JPQ | E | ✅ | D(3) | D(1) | E | D(4) | ✅ | D(2) |
| VAP | E | ✅ | D(2) | D(2) | E | D(1) | ✅ | D(1) |
| CONSV | E | ✅ | D(2) | D(1) | E | D(3) | D(1) | D(2) |

（E = Gate E 当期純利益が正でない、F = Gate F 分配可能利益なし、D(n) = Gate D 新規CAPEX提案n件）

### G-2. 原因分解（数式で）

現行設計の**構造的上限**は次のとおりである。

```
年間配当 = 0.15 × （1四半期分のNI）          ← 年間NIの約1/4が基数
        ≈ 0.15 × 0.25 × 年間NI = 年間NIの 3.75%
32Q（8年）全年で全ゲートを通過しても、累計配当は累計NIの **3.75%** が上限
実測はさらに低い（0.3〜2.9%）＝ ゲート落ちの分
```

| 原因 | 寄与 | 根拠 |
|---|---|---|
| **年1回 × 四半期NI基数**（構造上限3.75%） | **最大** | Gate A + 算定基数がflow 1四半期分 |
| **Gate D（当期CAPEX提案があれば無配）** | **大** | 実測でQ4 40件（5社×8年）中 **18件** がD落ち。Standard AIは32Qで19〜31件のCAPEXを承認しており、Q4に提案が無い年の方が少ない |
| Gate E（直近確定四半期の赤字） | 中 | 実測9件（T4は全社、T20はMASS以外）。**年間では黒字でも直近確定四半期が赤字なら無配** |
| payout ratio 15%の水準 | 中 | 基数が小さいため、比率を上げても効果は限定的 |
| Gate B/C（health / crisis） | 小 | 実測ではT8のMASS（Gate F）以外ほぼ非拘束 |
| `distributableEarnings` cap | 小 | T24以降は 92M〜440M あり非拘束 |
| **cash cap** | **非拘束** | 期末現金 276〜496M に対し配当は 2〜12M |

**結論**: 現金が数百M残る主因は「配当性向が低い」ことではなく、
**(1) 算定基数が年間ではなく1四半期のflowであること、(2) Gate Dが投資の多い成長期に恒常的に無配にすること**
の2点である。cash・distributable earnings は制約になっていない。

---

## Part H — Required Cash Reserve に使えるデータ（§24・§25）

`StandardAiObservation` / `CompanyOwnState` から**決定論的に取得できるか**の一覧。
（Standard AI・Claudeによる自由推測は禁止＝§25）

| 項目 | フィールド | 取得可否 | 精度 |
|---|---|---|---|
| 現金 | `observation.cashUsd` / `financeState.cash` | ✅ | **exact** |
| 分配可能利益 | `financeState.distributableEarnings` | ✅ | exact |
| 当期決済予定の売掛金 | `receivablesDueThisPeriodUsd` | ✅ | exact |
| 未到来の売掛金 | `receivablesNotYetDueUsd` | ✅ | exact（期別scheduleも `financeState.receivables[].dueSettlementPeriod` から算出可） |
| 当期決済予定の買掛金 | `payablesDueThisPeriodUsd` | ✅ | exact |
| 未到来の買掛金 | `payablesNotYetDueUsd` | ✅ | exact |
| 既存借入の当期利息 | `existingLoanInterestUsdThisQuarterEstimate` | ✅ | estimated（決算と同じ `computeLoanQuarterlyInterest` を適用） |
| 既存借入の当期予定元本 | `existingLoanScheduledPrincipalDueUsdThisQuarterEstimate` | ✅ | estimated（同 `computeScheduledPrincipalDue`） |
| 借入残高 | `existingLoanBalanceUsd` | ✅ | exact |
| **確定済CAPEXの残コミットメント** | `capexState.portfolio.projects[].approvedBudgetUsd − cumulativePaidUsd`（`aiManagementMeeting/financeSemantics.ts` が既に同式で算出） | ✅ | **exact** |
| **次四半期のCAPEX支払予定額** | `CapitalProject.paymentSchedule`（`PaymentScheduleStage[]`）＋ `completedPaymentStagesCount` | ✅ | **exact**（stage別の予定額が保持されている） |
| 常用ワーカー人件費 | `regularHeadcountTotal` × `FINANCE_PARAMETERS_V1...regularWorkerSalaryUsdPerQuarter`(1,000) | ✅ | exact（決定論的に計算可） |
| 営業人件費 | `salesForceHeadcountTotal` × `salesForceSalaryUsdPerQuarter`(8,000) | ✅ | exact |
| 調達人件費 | `procurementHeadcountTotal` × `procurementSalaryUsdPerQuarter`(7,000) | ✅ | exact |
| 工場固定費・SG&A | `finance/parameters.ts::managementAccounting`（配賦係数）＋ 工場数 | △ | **estimated**（配賦係数からの再構成が必要。専用の観測フィールドは無い） |
| 当期の原料調達所要現金 | 当期の `procurementResult`（同一turn内で確定済み）× 参照価格 | ✅ | estimated（数量は確定、単価は参照価格ベース） |
| 原料在庫・入荷予定 | `rawMaterialAvailable` / `rawMaterialPipeline` / `rawMaterialInTransitImportQuantity` / `rawMaterialCertainInboundThisPeriod` | ✅ | exact |
| 完成品在庫 | `finishedGoodsByProduct` | ✅ | exact |
| 受注残 | `outstandingContractByProduct`（契約は `ownState.contracts` に納期つき） | ✅ | exact |
| 危機状態 | `crisisState` / `lastQuarterFinancialHealthTier` / `lastQuarterProcurementScaleRatio` / `lastQuarterUnderwritingFrozen` | ✅ | exact |
| **借入余力（borrowing headroom）** | `availableBorrowingHeadroomUsd` | ❌ **恒常的にundefined** | **取得不能**（`types.ts` に「捏造しない」と明記。`computeBorrowingCapacity` が要求する信用スコア・EBITDA・担保評価が観測へ未配線） |
| 将来の市場価格・需要 | — | ❌ | 未来（使用禁止） |
| Scenario未公開イベント | — | ❌ | 使用禁止（Part K） |

**§34-4 判定**: Required Reserveの中核（運転資金・確定投資・債務）は**すべて取得可能**。
唯一の欠落は **borrowing headroom** であり、これは §30（配当直後の借入round-trip防止）に必要な入力である。
→ **Stop Conditionには至らないが、DIV-5実装前に「観測への配線」または「代替指標の合意」が必要**。

---

## Part I — DIV-5 代替案（§23）

共通形：

```
ExcessCash        = max(0, Cash − RequiredCashReserve)
DividendCandidate = min( ExcessCash, distributableEarnings, computeMaxDividendUsd(financeState) )
```

### 案1: Working-capital-only reserve（最小主義）

```
RequiredReserve = 次期運転資金（買掛決済 + 人件費 + 固定費 + 当期調達所要 − 当期AR回収）
                + 確定CAPEX次期支払 + 債務元利
                + 最低現金バッファ（既存 finance decision の値を流用）
```
- メリット: 全項目がexact。説明可能性が最も高い。余剰の掃き出し量が最大。
- リスク: 成長局面で「これから必要になる」現金まで出してしまい、翌期に借入し直す（§30のround-trip）。

### 案2: Working capital + Growth reserve（推奨ベース）

案1に、**確定または高確度の成長所要**を加算する。

```
GrowthReserve = 承認済み/進行中CAPEXの今後4Qの支払予定（exact）
              + 進行中の新工場案件がある場合の立ち上げ運転資金（能力増分 × 単位運転資金）
              + 計画済み営業採用の人件費（当期decisionで確定した採用数 × 給与 × ramp期間）
              + 成長圧力に比例した調達拡大分（growth pressure × 当期調達額の増分）
```
- メリット: §26の要件（承認済み案件・拡大計画があるときだけ厚くする）を満たす。
- リスク: 「たぶん投資する」で永久に貯めないよう、**未提案の将来CAPEXは一切含めない**必要がある。

### 案3: Volatility-scaled reserve（危機bufferつき）

案2に、観測ボラティリティに比例したbufferを加える。

```
CrisisBuffer = k × 観測ボラティリティ × 四半期営業支出
  観測ボラティリティ = 直近N期の営業CF標準偏差 / 平均（すべて自社確定実績から算出）
  crisisState !== NORMAL または health tier ≠ healthy のとき係数を引き上げる
```
- メリット: §29（固定で巨大なCashを残さない）を満たす。DS1/DS2の不況期に自動的に厚くなる。
- リスク: パラメータが増える。ボラティリティ推定が短期履歴に過敏。

### 案4: Payout-ratio hybrid（現行との折衷）

`min(ExcessCashベース, 年間NI × 上限性向)` として**上限性向でも縛る**。
- メリット: 「利益を伴わない資本の払い戻し」を防ぎ、TSV上の支配戦略化を抑制（§32）。
- リスク: 余剰現金が利益を大きく超えて積み上がった局面（現状がまさにそれ）では掃き出しきれない。

---

## Part J — 推奨DIV-5設計（§23・§26・§29・§30・§31）

**推奨: 案2（Working capital + Growth reserve）を土台に、案3のCrisis Bufferを条件付きで加え、
案4の上限性向を「初年度のみのsafety rail」として持つ。**

```
RequiredCashReserve =
    WorkingCapitalReserve      // 次期の買掛決済 + 人件費 + 固定費 + 調達所要 − 確定AR回収（すべてexact/決定論的）
  + CommittedInvestmentReserve // 承認済みCAPEXの今後4Qの支払予定（paymentScheduleから exact）
  + DebtServiceReserve         // 当期・次期の利息 + 予定元本（既存の estimate をそのまま使用）
  + GrowthReserve              // 当期decisionで確定した採用・調達拡大の追加所要のみ（未提案の投資は含めない）
  + CrisisBuffer               // observable volatility × 営業支出。crisis/health非healthyで増加。上限を必ず設ける

ExcessCash        = max(0, Cash − RequiredCashReserve)
DividendCandidate = min(ExcessCash, distributableEarnings, computeMaxDividendUsd(financeState))
```

### 既存ゲートの扱い（DIV-4からの変更提案）

| Gate | DIV-4 | DIV-5案 | 理由 |
|---|---|---|---|
| A（Q4のみ） | 維持 | **維持**（年1回） | 配当タイミング最適化AIを作らない方針を維持 |
| B（healthy） | 維持 | **維持** | 財務再建優先 |
| C（crisis NORMAL） | 維持 | **維持** | |
| **D（CAPEX提案があれば無配）** | 全面ブロック | **廃止し、Reserveへ吸収** | 承認済み/提案中の投資に必要な現金は `CommittedInvestmentReserve` で先に確保されるため、二重に止める必要がない。**Part G-2でGate Dが無配の最大要因**であり、これを残すとDIV-5の効果が出ない |
| E（当期NI>0） | 必須 | **緩和**（年間NI>0 または ExcessCash>0 かつ distributableEarnings>0） | 「1四半期の赤字で年間無配」は資本配分として不自然。ただし分配可能利益ゼロでの資本払い戻しは引き続き禁止（Gate F/Gで担保） |
| F/G（分配可能利益・上限） | 維持 | **維持** | 会計上の上限。engine側と同じ `computeMaxDividendUsd` を使用 |
| 額 | `NI × 0.15` | `min(ExcessCash, ...)`、**profile biasはExcessCashの掃き出し率へ適用** | 会社性格を残す（conservativeは掃き出し率低め＝reserve厚め） |

### §30（debt round-trip防止）

- `RequiredCashReserve` に **次期の調達所要と債務元利を必ず含める**ことで、配当直後の借入を構造的に減らす。
- 追加ガード案: `existingLoanBalanceUsd > 0` のとき、ExcessCashの一部（または全部）を
  **配当より先に債務返済へ回す**（借入コスト > 株主への時間価値、という単純規則）。
- **前提となる欠落**: `availableBorrowingHeadroomUsd` が観測に無い（Part H）。
  headroomを見ずに「借りられるから配ってよい」とは判断できないため、
  **DIV-5では headroom を使わない設計**（＝自己資金だけでReserveを満たす）を推奨する。

### §31（Growth × Dividend の接続点）

```
GrowthPressure 高 → 採用・調達・CAPEXが増える → GrowthReserve / CommittedInvestmentReserve 増 → ExcessCash 減
GrowthPressure 低 かつ 投資pipelineなし かつ debt低 → Reserve = 運転資金のみ → ExcessCash 最大 → 大きなsweep
```
この接続は**同じ observable から両方が導かれる**ため、二重管理にならない。
唯一の注意点は、Growth Pressureが「未提案の将来投資」を理由にReserveを厚くしないこと（§26）。

---

## Part K — Future signal legality（§27・§28）

| 分類 | 内容 | Standard AI の使用 | 現行コードでの位置 |
|---|---|---|---|
| **A** current public / game-visible signal | 観測需要（2Q遅行）・参照売価・ライフサイクル構成比/トレンド・供給圧力・公開ニュース | ✅ 許可 | `observation.markets` / `lifecycleTrendByMarket` / `productSupplyPressureByProduct` |
| **B** confirmed contractual future obligation | 自社の受注残（納期つき契約）・買掛/売掛の決済予定期 | ✅ 許可 | `ownState.contracts` / `receivables[].dueSettlementPeriod` |
| **C** already approved CAPEX schedule | 承認済み案件の支払スケジュール・完成予定 | ✅ 許可 | `CapitalProject.paymentSchedule` / `requiredConstructionQuarters` |
| **D** known settlement / arrival schedule | 輸入の到着予定（lead time 2Q）・養殖の収穫予定（+1Q）・借入の返済予定 | ✅ 許可 | `rawMaterialPipeline` / `rawMaterialInTransitImportQuantity` / loan schedule |
| **E** scenario internal future event | T25 Ecuador災害・T29 India災害等の**未公開**イベント、TRUE需要・TRUE価格 | ❌ **禁止** | 現行の関数シグネチャ上そもそも受け取れない（`policy.ts` の情報境界コメント参照）。**現状violationなし** |

**§28**: DS3担当が「ニュース・構造トレンド・警告シグナル・公開市場データ」として**事前公開**した情報は
A分類として利用可能。ただし利用してよいのは公開された内容そのものだけであり、
**イベントの正確なturn・正確な規模・隠れた将来状態を読んではならない**。
Growth Pressureの入力にscenario signalを使う場合は、
`observation` に「公開済みシグナル」として載せる経路を新設し、
**scenarioId分岐でも将来イベント直読でもない**ことを構造で保証すること。

**現行監査結果**: Standard AIの意思決定関数はいずれも `CompanyFixture` / `CompanyOwnState` /
`PublicMarketInfo` / `PeriodV2` / `turn` しか受け取らず、`ScenarioDefinition` の将来イベントには
到達できない。**E分類の漏洩は現時点で存在しない。**

---

## Part L — DS1 / DS2 regression strategy（§20）

**原則: `scenarioId` による分岐・DS3専用のvolume targetは作らない。**

| 手段 | 可否 | 備考 |
|---|---|---|
| `scenarioId` で成長率を切り替える | ❌ 禁止（§20） | |
| observable（観測需要・採算・トレンド）から自動的に速度が変わる | ✅ 推奨 | DS1/DS2は観測需要が小さいので圧力も小さくなる |
| parameter化（`STANDARD_AI_PARAMETERS_V1` に新パラメータを追加し、既定値は現行挙動と同一） | ✅ 可 | DIV-3/DIV-4と同じ手順。既定OFFで既存テストを守る |
| feature flag（`growthPressureEnabled` 等） | △ 可（移行期のみ） | ベンチマーク比較のために一時的に持ち、収束後に削除 |

**regression手順の提案**
1. 新パラメータの既定値を**現行と完全に同一の挙動**になる値（例: `opportunityShareSpan = 0`）にして実装。
   → この時点で既存3,590件のテストとDS1/DS2ベンチマークは**ビット単位で不変**であること。
2. 有効値でDS1/DS2/DS3 × 複数seedを実行し、Part Mのベンチマークで比較。
3. DS1/DS2で悪化する指標（distress turn数・zero production・在庫・営業利益率）に閾値を置き、
   悪化した場合は係数を下げる（DS3のためにDS1/DS2を犠牲にしない）。

---

## Part M — Benchmark plan（§33）

### M-1. SAI Growth ベンチマーク

対象: DS1 / DS2 / DS3 × seed 3本以上 × 5社。取得点: **T8 / T16 / T24 / T32**。

| 指標 | 取得元 |
|---|---|
| 希望販売量（desired sales） | `decision.salesPlans[].desiredQuantity` の合計 |
| Commercial Ambition / Commitment と各limiter | `diagnostics.commercialAmbition` / `commercialCommitment` |
| 実成約量 | `companySummaries[].newContractedQuantity` |
| 営業人数・採用数・採用0理由 | `diagnostics.salesHiring` |
| 生産量・binding capacity・稼働率 | `companySummaries` / `observation` |
| 原料調達量 | `companySummaries[].domesticPurchaseQuantity` ＋ 輸入・養殖 |
| 工場数・ライン能力・工場スペース残 | `observation.factoryCount` / `factorySpaceRemainingUnits` |
| 受注残・完成品在庫 | `outstandingQuantity` / `finishedGoodsInventory` |
| 営業利益率 | `financialResults[].profitAndLoss` |
| 現金・借入・distress turn数 | `balanceSheet` / `financialHealth` |
| TSV | `computeCompanyEvaluationSnapshot` |

**合否の目安（案）**
- DS3で MASS が終盤に他社より明確に大きい（**固定目標ではなく結果として**）。
- DS1/DS2では成長速度が上がりすぎない（現行比で distress turn数・在庫が悪化しない）。
- 5社が同一の数値へ収束**しない**（B-1の27,704現象が解消していること）。

### M-2. DIV-5 ベンチマーク

| 指標 | 目的 |
|---|---|
| 年次配当額・配当回数・ゲート落ち理由の内訳 | Gate設計の妥当性 |
| 期末現金 / **32Qの最小現金** | 出しすぎていないか |
| 借入残高・配当直後の新規借入額（round-trip検出） | §30 |
| CAPEX承認件数・完成件数 | 成長を止めていないか |
| distress turn数・zero production turn数 | 安全性 |
| Company Value / Dividend Value / TSV | §32 |

**dominance test（§32）の設計案**

現行TSVの構造（実測・DS2 T32）：

| 会社 | TSV | 配当価値 | EV | Cash | Debt |
|---|---|---|---|---|---|
| BAL | 1,570.5M | 20.3M (1.3%) | 1,173.9M | 376.3M | 0 |
| MASS | 2,930.7M | 22.5M (0.8%) | 2,412.2M | 496.0M | 0 |
| JPQ | 1,578.6M | 11.8M (0.7%) | 1,197.8M | 369.0M | 0 |
| VAP | 1,288.3M | 8.4M (0.7%) | 1,004.1M | 275.8M | 0 |
| CONSV | 1,543.5M | 4.4M (0.3%) | 1,154.2M | 384.9M | 0 |

TSVの限界代替率（`tsv-dcf-v1`、`DIVIDEND_COMPOUND_ANNUAL_RATE=0.15`、
`ENTERPRISE_VALUE_DISCOUNT_RATE=0.10`・10年・年金現価係数 6.144567）：

```
現金を1ドル保持        → TSV +1.00
Turn t に1ドル配当     → TSV +1.15^((32−t)/4)      … T24: 1.32 / T16: 1.75 / T8: 2.31 / T32: 1.00
1ドル投資して四半期OCFがΔ増える → TSV +(4 × 6.144567 × Δ) − 1.00 = 24.58Δ − 1.00
```

したがって：
- **配当は t<32 で必ず現金保持を上回る**（早いほど有利）。
- 投資が T16 配当に勝つ条件は `24.58Δ ≥ 1.75` → **Δ ≥ 0.0712 /四半期 = 年28.5%のキャッシュ利回り**。

⚠ **これは §34-6（DIV-5がTSV上ほぼ常に100%配当を支配戦略にする）に該当する構造である。**
必ずしも「配当禁止」ではなく、次のいずれかで抑制する設計提案：

1. **Reserveを経済的に意味のある水準にする**（配れる額の上限をExcessCashに厳格に縛る）。
   → 現金が「必要」であるほど配当できないので、無条件100%配当にはならない。
2. **dominance testを benchmark に組み込む**: 「Reserve係数を極端に緩めた配当最大化AI」を
   対照群として走らせ、TSVが常に上回るなら**TSV式側の問題**として#04/#05へ報告する
   （AI側で誤魔化さない）。
3. 配当がdistress・zero productionを誘発した場合は TSV が下がることを確認する
   （EV = 24.58 × 四半期OCF なので、操業が止まればEVが激減し、配当の +0.75 程度では埋まらない）。

---

## Stop Conditions（§34）— 該当状況の報告

| # | 条件 | 判定 | 内容 |
|---|---|---|---|
| 1 | 30kt ceilingがScenario側に存在するか | **該当しない（AI側）** | ceilingはAI側の3定数（`maximumSupplierShare` 0.35 は engine共有、`realisticShareOfProfitableOpportunity` 0.35、`realisticShareOfOpportunity` 0.5）とVision参照規模で作られている。市場側から拒否された結果ではない（実測: 提出＝ほぼ成約） |
| 2 | **Standard AIだけでは突破不能なengine hard capがある** | ⚠ **該当** | **営業能力モデルの漸近上限 `1,000 + 95,000 = 96,000` 工数トン/四半期。** VAP 45,000〜55,000t（工数係数3.0 → 135,000〜165,000工数トン）と MASS 100,000t は **営業人数を無限に増やしても到達不能**。DS3の想定規模を成立させるには `sales/salesCapacityModel.ts` の `companyCapacityMaxIncrementTons`（または商品別工数係数）の見直しが必要 → **#04/#05の判断事項** |
| 3 | Growth Pressure導入にengine変更が必須か | **原則不要**（例外あり） | Part E-5のG-1〜G-5はすべて Standard AI / vision層のパラメータ・式で完結する。ただしG-6（営業能力モデル）とVision再calibration（G-2、データ）はAI外 |
| 4 | Required Reserveに必要なデータが取得不能か | **概ね取得可能** | 中核はすべてexact。唯一 `availableBorrowingHeadroomUsd` が恒常的にundefined（§30の設計に影響）。工場固定費・SG&Aは配賦係数からの再構成が必要 |
| 5 | future signalがhidden scenario truthしかないか | **該当しない** | A〜D分類の観測が十分に存在し、E分類は関数シグネチャ上そもそも到達不能 |
| 6 | **DIV-5がTSV上ほぼ常に100%配当を支配戦略にするか** | ⚠ **該当（構造上）** | 上記 dominance test の算術のとおり、`1.15^((32−t)/4) > 1.0` により早期配当は常に現金保持を上回り、投資が勝つには年28.5%の利回りが必要。Reserve設計と benchmark でのdominance testが必須 |

---

## 実装分解（提案・未着手）

| Phase | 内容 | 依存 |
|---|---|---|
| SAI-GROW-0 | 本監査の受入。§34-2（営業能力上限）と Vision 再calibration の方針決定 | #05判断 |
| SAI-GROW-1 | Growth Pressure（案B）を診断専用（shadow）で実装。既存挙動は不変 | — |
| SAI-GROW-2 | `opportunityShare` を圧力の関数へ（G-1）。既定値は現行と同値 | GROW-1 |
| SAI-GROW-3 | 営業採用の先行許容（G-3）＋ constraint routing（案D） | GROW-2 |
| SAI-GROW-4 | CAPEX Gate I の需要根拠拡張（G-5）・Target Scale基準見直し（G-4） | GROW-3 |
| SAI-GROW-5 | DS1/DS2/DS3 × 複数seed ベンチマーク・regression判定 | GROW-4 |
| DIV-5-1 | `RequiredCashReserve` の決定論的算出（診断専用・配当額は変えない） | Part H |
| DIV-5-2 | ExcessCashベースの配当額算定・Gate D廃止/Gate E緩和 | DIV-5-1 |
| DIV-5-3 | Crisis Buffer・debt優先返済ガード | DIV-5-2 |
| DIV-5-4 | dominance test を含むベンチマーク | DIV-5-3・SAI-GROW-5 |

**受入推奨**: Part E-5（案B＋案D）と Part J（案2＋案3＋案4のsafety rail）を設計として承認し、
**その前に §34-2（営業能力の漸近上限）と Vision Q32再calibration の2点を#05が決定すること**を推奨する。
この2点が未決のままGrowth Pressureだけを実装しても、DS3の想定規模には構造的に到達しない。
