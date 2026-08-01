# ShrimpX V2 Company Lab — パラメータ仕様書（Parameter Document）

**文書ID**: ShrimpX-KB-03
**版**: v1.0
**作成日**: 2026-07-26
**対象読者**: エンジンの挙動を数値レベルで理解・変更する必要がある開発者、およびゲームバランスを調整する GM
**位置づけ**: Claude Project Knowledge 常設資料。全モジュールの係数を、実値・出典ファイル・校正状態つきで一覧する唯一の参照資料。

関連文書:

- ShrimpX-KB-01 開発引き継ぎ書
- ShrimpX-KB-02 ゲームマニュアル
- ShrimpX-KB-04 開発ログ

---

## 0. 本書の読み方

### 0.1 パラメータ集約の原則

本プロジェクトには一貫した規約がある。**計算ロジックにマジックナンバーを直接書かず、すべての係数をモジュールごとの `parameters.ts` に集約する。** したがって、エンジンの挙動を変えたければ触るべきファイルは常に `parameters.ts` である。

各モジュールのパラメータオブジェクトは `parametersVersion` を持ち、係数を変更する場合は**旧バージョンを削除せず新バージョンとして追加する**（全体実装計画書 v0.1 §20 に準拠）。

### 0.2 校正状態の表記

各値には出所と信頼度がある。本書では次の3段階で表記する。

| 表記 | 意味 |
|---|---|
| **確定** | 仕様書または実装指示に明示された数値。勝手に変えてはならない |
| **仮置き** | 仕様書自身が暫定と位置づけている値 |
| **要校正** | 仕様書に記載がなく、実装者が「効果の方向性」を満たす最小限の暫定値として置いた値 |

大半の値は「要校正」である。これは欠陥ではなく、設計文書自身が「文書状態: 設計仮説。実装前に試算・感度分析・実データ照合を行う」と宣言しているためである。

### 0.3 パラメータファイル一覧

| # | ファイル | エクスポート名 | バージョン |
|---|---|---|---|
| 1 | `app/lib/v2/market/parameters.ts` | `MARKET_PARAMETERS_V1` | `market-params-2015-baseline-v0.1` |
| 2 | `app/lib/v2/scenario/parameters.ts` | `SCENARIO_ENGINE_PARAMETERS_V1` 他 | `scenario-engine-params-v0.1` |
| 3 | `app/lib/v2/sales/parameters.ts` | `SALES_PARAMETERS_V1` | `sales-v0.1` |
| 4 | `app/lib/v2/rawMaterials/parameters.ts` | `RAW_MATERIALS_PARAMETERS_V1` | `raw-materials-v0.1` |
| 5 | `app/lib/v2/production/parameters.ts` | `PRODUCTION_PARAMETERS_V1` | `production-v0.2` |
| 6 | `app/lib/v2/quality/parameters.ts` | `QUALITY_PARAMETERS_V1` | `quality-v0.1` |
| 7 | `app/lib/v2/finance/parameters.ts` | `FINANCE_PARAMETERS_V1` | `finance-v0.1` |
| 8 | `app/lib/v2/financing/parameters.ts` | `FINANCING_PARAMETERS_V1` | `financing-v0.1` |
| 9 | `app/lib/v2/capex/parameters.ts` | `CAPEX_PARAMETERS_V1` | `capex-v0.3` |
| 10 | `app/lib/v2/companyLab/parameters.ts` | `EXTERNAL_PROCESSOR_DEMAND_ASSUMPTIONS_V1` 他 | （個別） |
| 11 | `app/lib/v2/companyLab/fixtures.ts` | 5社フィクスチャ | （個別） |

### 0.4 実行時アサーション

一部のファイルはモジュール読み込み時に値の整合性を検証し、不整合なら例外を投げる。**バランス調整で値を変えるときはこれらを壊さないこと。**

| ファイル | アサーション | 検証内容 |
|---|---|---|
| `finance/parameters.ts` | `assertValidExistingAssetRatios` | `buildingOpeningRatio + machineryOpeningRatio = 1`（誤差 1e-9）。違反時 `FinanceValidationError` |
| `capex/parameters.ts` | `assertValidComponentRatios` | 全テンプレートの `buildingRatio + machineryRatio = 1`（誤差 1e-9）。違反時 `CapexValidationError` |

---

## 1. 市場・価格形成（`market/parameters.ts`）

`MARKET_PARAMETERS_V1` / `parametersVersion: "market-params-2015-baseline-v0.1"`

出典は「市場価格形成モジュール仕様書 v0.2」。2015年基準。

### 1.1 国際HOSO FOB初期価格（§4.1・仮置き）

| 国 | USD/kg |
|---|---|
| EC（エクアドル） | 4.70 |
| IN（インド） | 5.25 |
| ID（インドネシア） | 5.45 |
| VN（ベトナム） | 5.60 |

実データ取得後に再校正する前提。

### 1.2 簡易国際連動式（§9.2・プロトタイプ用と仕様書に明記）

世界影響ウェイト `worldInfluenceWeight`:

| 国 | ウェイト |
|---|---|
| EC | 0.45 |
| IN | 0.25 |
| VN | 0.18 |
| ID | 0.12 |

```
R_i = localPressureWeight × L_i + worldPressureWeight × G
localPressureWeight = 0.60
worldPressureWeight = 0.40
```

国別圧力 L_i の内訳ウェイト（Phase1新規・要校正）:

| 要素 | ウェイト |
|---|---|
| `supplyDemandPressureWeight`（需給不均衡） | 0.70 |
| `costPressureWeight`（養殖コスト変化） | 0.30 |

需給不均衡を主要因、コスト変化を副次要因とする配分。仕様書 §9.3・§17 の「供給ショックは数量を介して価格へ影響し、価格への直接加算は例外扱い」という不変条件に対応している。

### 1.3 価格制約（§9.3・Phase1新規・要校正）

| パラメータ | 値 | 意味 |
|---|---|---|
| `maxQuarterlyPriceChangeRatio` | 0.20 | 四半期あたりHOSO価格変化率の上限・下限（絶対値） |
| `priceFloorUsdPerKg` | 0.50 | 価格の絶対下限（非正化防止） |
| `marketShockMagnitude` | 0.02 | 決定論的な小ショックの振幅（±2%の一様乱数を変化率へ加算） |

### 1.4 HOSO価格の自己修正機構（Phase 6.3新規・要校正）

**背景**: Phase 6.2 の診断で、baseline シナリオでも IN・ID・VN の HOSO 価格が絶対下限 $0.50 へ張り付く問題が確認された。原因は2点。

1. 需要配分が固定シェア（`worldInfluenceWeight`）のため、供給シェアとの不一致（EC は需要45%対供給27%等）が恒常的な国別需給不均衡として残る
2. 価格式が「不均衡の水準」を「価格変化率」に直結する積分器構造のため、恒常的な不均衡が毎四半期価格を削り続け、下限まで発散する

**対応**: 価格式全体は書き直さず、次の最小限の修正を加えた。

| パラメータ | 値 | 効果 |
|---|---|---|
| `demandReallocationPriceSensitivity` | 2.0 | 需要配分を前期価格に応答させる。`share_i ∝ weight_i × exp(-感度 × 相対価格乖離)`。0で従来の固定シェア |
| `meanReversionRate` | 0.8 | 長期アンカー価格（初期FOB価格 × 養殖コスト指数）への平均回帰率（四半期あたり）。恒常的な需給圧力 P に対する定常価格乖離は P / 回帰率 に収束する |
| `maxCountryDeviationRatioFromReference` | 0.35 | 国別価格のグローバル基準価格（需要ウェイト平均）からの最大乖離比率 |

baseline の恒常的な供給過剰（世界供給 1.8M トン対需要 1.2M トン/四半期）の下でも、価格がアンカー比 −30〜−40% 程度の**有限なディスカウントへ収束**し、絶対下限に張り付かない水準として校正されている。

### 1.5 ベトナム国内原料価格（Phase1新規・要校正、Phase 6.3で拡張）

| パラメータ | 値 | 意味 |
|---|---|---|
| `baseMultiplier` | 0.92 | 需給均衡時の乗数（買付上限に対する比率） |
| `demandSensitivity` | 0.35 | 供給過不足1単位あたりの乗数感応度 |
| `floorMultiplier` | 0.40 | 乗数の下限 |
| `imbalanceClamp` | 3 | 需給不均衡比率のクランプ範囲（ゼロ割り近傍の暴発防止） |
| `absolutePriceFloorUsdPerKg` | 0.05 | 数値エラー防止用バックストップのみ。**経済的下限は農家留保価格が担う** |

`baseMultiplier` は Phase 6.3 で再校正された。買付上限式から物理歩留まり 0.62 を除去したことに伴う。

**農家の販売留保価格**（Phase 6.3新規・要校正、実装指示 §4）:

```
farmerReservationPrice = farmingCost + diseaseRiskAllowance + minimumFarmerMargin
```

| 構成要素 | USD/HOSO換算kg |
|---|---|
| `farmingCostUsdPerHosoEqKg` | 1.90 |
| `diseaseRiskAllowanceUsdPerHosoEqKg` | 0.15 |
| `minimumFarmerMarginUsdPerHosoEqKg` | 0.20 |
| **合計** | **2.25** |

ベトナムのバナメイ養殖の実務水準を念頭に置いた暫定値。国内原料価格が $1/kg を下回る領域を経済的に成立しない領域として排除しつつ、通常時の需給価格（2.4〜3.0程度）が留保価格の上に位置して買付希望量の増減が価格へ反映される余地を残す設計。`VietnamDomesticInput.farmerEconomics` で上書き可能。

**数量調整（quantityRationing、Phase 6.3）**: 買付上限が留保価格を下回る局面では取引数量そのものが縮小する。

```
severity   = (reservation - ceiling) / reservation
tradeRatio = clamp(1 - severity × severitySensitivity, minTradeRatio, 1)
```

| パラメータ | 値 |
|---|---|
| `severitySensitivity` | 2.0 |
| `minTradeRatio` | 0.0 |

買付上限が留保価格を10%下回ると取引量が2割減る程度の感応度。

### 1.6 PD/VAPプレミアム（Phase1新規・要校正）

仕様書・全体実装計画書のいずれにも具体的な金額水準の記載がないため、HOSO価格に対する比率として設定されている（原価連動性を確保するため）。

| パラメータ | 値 | 意味 |
|---|---|---|
| `pdBasePremiumRatio` | 0.18 | PDのベースプレミアム比率 |
| `vapBasePremiumRatio` | 0.55 | VAPのベースプレミアム比率 |
| `referenceUtilization` | 0.85 | 「基準」とみなす世界稼働率（需要/能力） |
| `utilizationSensitivity` | 0.8 | 稼働率が基準から1単位ずれた時の倍率感応度 |
| `utilizationMultiplierFloor` | 0.5 | 倍率の下限 |
| `utilizationMultiplierCap` | 1.8 | 倍率の上限 |
| `referenceQualityScore` | 50 | 品質スコアの中立基準（これを上回る分だけ加点） |
| `qualityPremiumSensitivity` | 0.3 | 品質スコア100点分がHOSO価格の何%の加算になるか |
| `minPremiumUsdPerKg` | 0.05 | プレミアムの絶対下限（非正化防止） |

### 1.7 理由コード発火の閾値（Phase1新規・要校正）

| パラメータ | 値 | 発火条件 |
|---|---|---|
| `supplyDemandImbalance` | 0.03 | \|不均衡\| がこれを超えたら供給不足/過剰の理由コード |
| `capacityTightUtilization` | 1.00 | 稼働率がこれを超えたら能力逼迫 |
| `capacityLooseUtilization` | 0.75 | 稼働率がこれを下回ったら能力過剰 |
| `costChangeRatio` | 0.02 | コスト指数変化率がこれを超えたらコスト要因 |
| `demandGrowthRatio` | 0.02 | 需要側成長率がこれを超えたら需要要因 |
| `ecuadorIndiaPdShareTightness` | 0.40 | EC+IN の合算PD能力シェアがこれを超えたら `ECUADOR_PD_CAPACITY_EXPANSION` |

### 1.8 参照専用の値（現時点で未使用）

| パラメータ | 値 | 状態 |
|---|---|---|
| `costTierComposition` | low 0.25 / mid 0.50 / high 0.25 | 養殖コストカーブの層構成比（§5.2・仮置き）。入力側の `aquacultureCostIndex` が既に集計値のため参照専用 |
| `expectedPriceWeights` | current 0.5 / prior 0.3 / twoPriorsAgo 0.2 | 農家の期待原料価格ウェイト（§6.2・仮置き）。現在は直近期のみ参照のため未使用 |
| `minimumOfftakeRatio` | 0.20 | プロラタ最低引取ルール（§10.1・**確定値**として仕様書に明記）。過去4Q平均買付量に対する最低引取比率 |

---

## 2. シナリオ・イベント（`scenario/parameters.ts`）

`SCENARIO_ENGINE_PARAMETERS_V1` / `parametersVersion: "scenario-engine-params-v0.1"`

すべて Phase2新規・要校正。シナリオ定義が特定の（変数, 対象）に対して明示的な長期トレンドを持たない場合に `scenarioEngine.ts` が使うフォールバック既定値。

### 2.1 基礎変数の既定値

| パラメータ | 値 | 意味 |
|---|---|---|
| `defaultUtilizationRate` | 0.85 | 能力稼働率（放養能力に対する実際の放養・収穫の比率） |
| `defaultSurvivalRate` | 0.85 | 生残率 |
| `defaultProductivity` | 1.0 | 養殖生産性倍率（1.0＝基準） |
| `defaultExportEligibilityRate` | 0.90 | 輸出適格率 |
| `defaultQualityScore` | 60 | 品質評価（Score0to100） |
| `defaultReliabilityScore` | 60 | 供給信頼性評価 |
| `defaultDiseasePressure` | 0 | 疾病圧力（0＝平常時） |
| `defaultLogisticsCapacityRatio` | 1.0 | 物流能力比率（1.0＝制約なし） |
| `defaultTradeRestrictionSeverity` | 0 | 貿易規制強度（0＝規制なし） |
| `defaultEconomicIndex` | 1.0 | 景気指数（1.0＝横ばい） |
| `defaultConsumptionGrowthRate` | 0 | 消費成長率 |
| `defaultFeedEnergyLaborCostMultiplier` | 1.0 | 飼料・エネルギー・労務コスト乗数 |

### 2.2 能力・需要の導出比率

| パラメータ | 値 | 意味 |
|---|---|---|
| `defaultPdCapacityRatioOfProduction` | 0.30 | PD加工能力トレンドが無い場合、生産量に対する比率で導出 |
| `defaultVapCapacityRatioOfProduction` | 0.10 | VAP加工能力トレンドが無い場合の同上 |
| `pdDemandShareOfTotalConsumption` | 0.28 | 世界PD需要を地域別潜在需要合計から按分する比率 |
| `vapDemandShareOfTotalConsumption` | 0.12 | 同 VAP |
| `domesticPurchaseTrailingWindowTurns` | 4 | `vietnamTrailingAverageDomesticPurchase` の算出に使う直近ターン数 |

PD/VAP の専用需要という基礎変数は実装指示の18項目一覧に含まれていないため、既存の地域別需要から按分する簡略化を採っている（`docs/v2/SCENARIO_EVENT_ARCHITECTURE_v0.1.md` 参照）。

### 2.3 前史（`SCENARIO_PREHISTORY_BASELINE_V1`）

5シナリオ共通。前史期間は **3年**。実装指示 §12「B と c の初期条件はできる限り揃える」を、全シナリオで前史を共有することにより満たしている。数値はすべて Phase2新規・要校正の仮置き（実データ照合は未実施）。

**前史HOSO FOB価格**（`market/parameters.ts` の初期価格と整合）:

| 国 | USD/kg |
|---|---|
| EC | 4.70 |
| IN | 5.25 |
| ID | 5.45 |
| VN | 5.60 |

`priorVietnamDomesticPriceUsdPerKg` = **4.90**

**前史の市場別消費量**（HOSO換算トン）:

| 市場 | 消費量 |
|---|---|
| CN | 380,000 |
| US | 320,000 |
| EU | 260,000 |
| JP | 90,000 |
| OTHER | 150,000 |
| **合計** | **1,200,000** |

この合計 1,200,000 が `REFERENCE_WORLD_CONSUMPTION_TONS`（`companyLab/parameters.ts`）と一致しており、世界需要指数の基準になっている。

```
worldDemandIndex = Σ(前期消費 × 景気指数) / 1,200,000
```

**前史の国別供給・在庫・コスト**:

| 国 | 供給(t) | 育成在庫(t) | 冷凍在庫(t) | 養殖コスト指数 | 農家期待価格($/kg) |
|---|---|---|---|---|---|
| EC | 550,000 | 120,000 | 40,000 | 1.0 | 4.50 |
| IN | 650,000 | 140,000 | 45,000 | 1.0 | 5.00 |
| ID | 350,000 | 80,000 | 25,000 | 1.0 | 5.20 |
| VN | 450,000 | 100,000 | 35,000 | 1.0 | 5.30 |

`priorWorldDemandTrendNote`: 「2012〜2014年（前史期間）は世界需要が年率2〜3%で緩やかに拡大。中国・米国が牽引し、日欧はほぼ横ばい」

`carriedOverEvents`: 空配列。

### 2.4 初期状態オーバーライド（`SCENARIO_INITIAL_STATE_OVERRIDES_V1`）

**ベトナム加工経済**:

| パラメータ | 値 | 備考 |
|---|---|---|
| `hosoEqRecoveryRatio` | **1.0** | Phase 6.3 修正。旧 `hosoYieldRatio = 0.62`（HLSO相当の物理歩留まり）は買付上限のHOSO換算計算に物理重量換算を混入させていたため是正 |
| `processingExportCostUsdPerKg` | 0.85 | 加工・輸出費用 |
| `requiredMarginUsdPerKg` | 0.25 | 必要マージン |

`vietnamTrailingAverageDomesticPurchaseHosoEqTons` = 90,000
`initialDomesticProcurementIntentHosoEqTons` = 95,000

### 2.5 シナリオ設定

| 定数 | 値 |
|---|---|
| `SCENARIO_VARIATION_SETTINGS_STANDARD.allowedModes` | `["canonical", "variation"]` |
| `SCENARIO_VARIATION_SETTINGS_STANDARD.defaultMode` | `"canonical"` |
| `STANDARD_SCENARIO_DURATION_TURNS` | **32**（8年・実装指示 §12） |

---

## 3. 販売・営業・成約（`sales/parameters.ts`）

`SALES_PARAMETERS_V1` / `parametersVersion: "sales-v0.1"`

すべて Phase4新規・要校正。ChatGPT側の指示に数値そのものの指定はなく、要求された「効果の方向性」（逓減する、価格が高いほど不利になる）を満たす最小限の暫定値として置かれている。

### 3.1 営業人員（`salesForce`）

```
salesCoverageScore(h) = baselineCoverageAtZeroHeadcount
                 + (1 - baselineCoverageAtZeroHeadcount) × h / (h + coverageSaturationHeadcount)

processingCapacity(h) = baselineCapacityTons
                      + capacityMaxIncrementTons × h / (h + capacitySaturationHeadcount)
```

| パラメータ | 値 | 意味 |
|---|---|---|
| `baselineCoverageAtZeroHeadcount` | 0.15 | h=0 でも既存顧客による最低限の成約力を残す |
| `coverageSaturationHeadcount` | 6 | カバレッジ曲線の半飽和点 |
| `baselineCapacityTons` | 200 | h=0 のときの成約処理能力（HOSO換算トン） |
| `capacityMaxIncrementTons` | 4800 | 成約能力の漸近的な増分上限 |
| `capacitySaturationHeadcount` | 10 | 成約能力曲線の半飽和点 |

**導出値（頻繁に参照するため掲載）**:

| 人数 | カバレッジ | 成約能力(t) |
|---|---|---|
| 0 | 0.1500 | 200.00 |
| 1 | 0.2714 | 636.36 |
| 2 | 0.3625 | 1,000.00 |
| 3 | 0.4333 | 1,307.69 |
| 4 | 0.4900 | 1,571.43 |
| 5 | 0.5364 | 1,800.00 |
| 6 | 0.5750 | 2,000.00 |
| 8 | 0.6357 | 2,333.33 |
| 10 | 0.6813 | 2,600.00 |
| 12 | 0.7167 | 2,818.18 |
| 18 | 0.7875 | 3,285.71 |

### 3.2 成約競争力の合成ウェイト（合計1.0）

| 要素 | ウェイト |
|---|---|
| `price` | 0.35 |
| `coverage` | 0.25 |
| `relationship` | 0.15 |
| `quality` | 0.15 |
| `deliveryReliability` | 0.10 |

### 3.3 価格競争力

```
priceScore = exp( -priceSensitivity × (askPrice - basePrice) / basePrice )
```

| パラメータ | 値 |
|---|---|
| `priceSensitivity` | 3.0 |
| `minimumPriceCompetitiveness` | 0.5 |
| `maximumPriceCompetitiveness` | 1.6 |

`priceScore` はこの範囲にクランプされたのち `maximumPriceCompetitiveness` で割って [0, 1] 程度へ正規化される。

**設計意図**（ファイル内コメントより）: `priceSensitivity = 3.0` のとき、約10%値下げで `priceScore ≈ 1.35`、約20%を超える値下げで概ね上限 1.6 に到達する。クランプの目的は「値下げすればするほど際限なく成約力が伸びる抜け道」を防ぐこと。

**導出値**:

| 基準価格からの乖離 | priceScore |
|---|---|
| +20% | 0.549 |
| +10% | 0.741 |
| +5% | 0.861 |
| 0% | 1.000 |
| −5% | 1.162 |
| −10% | 1.350 |
| −15% | 1.568 |
| −20%以下 | 1.600（クランプ） |

### 3.4 シェア上限・外部選択肢

| パラメータ | 値 | 意味 |
|---|---|---|
| `maximumSupplierShare` | 0.35 | 市場×商品区分×四半期ごとに、1社が対象需要から成約できる最大比率 |
| `externalOptionWeight` | 0.35 | 5社以外の外部選択肢（他産地供給者・非購入）の競争力ウェイト |
| `neutralScore` | 50 | 顧客関係・品質・納期信頼性が未接続の場合の中立値 |

`maximumSupplierShare` は現段階では固定値だが、将来的に顧客関係・供給実績・納期信頼性に応じて会社別に変化させられる構造を想定している。**将来の拡張ポイントは `allocation.ts` の `maximumSupplierShareFor()`**。

### 3.5 リードタイム・入力検証

| パラメータ | 値 |
|---|---|
| `standardLeadTimeTurns` | 1（仕様上、成約の翌四半期が納期） |
| `minAskPriceRatioOfBase` | 0.5 |
| `maxAskPriceRatioOfBase` | 2.0 |

---

## 4. 原料調達（`rawMaterials/parameters.ts`）

`RAW_MATERIALS_PARAMETERS_V1` / `parametersVersion: "raw-materials-v0.1"`

すべて Phase5新規・要校正（Phase 6.3 で調達能力方式を変更）。

### 4.1 国内買付の価格競争力

```
priceScore = exp( +purchasePriceSensitivity × (bidPrice - marketPrice) / marketPrice )
```

Phase4 の販売側と**対称（符号が逆）**。高値を提示するほど 1 を超えて買付が有利になる。

| パラメータ | 値 |
|---|---|
| `purchasePriceSensitivity` | 3.0 |
| `minimumBuyerPriceCompetitiveness` | 0.5 |
| `maximumBuyerPriceCompetitiveness` | 1.6 |

### 4.2 調達カバレッジ

販売側と同形。

| パラメータ | 値 |
|---|---|
| `baselineCoverageAtZeroHeadcount` | 0.15 |
| `coverageSaturationHeadcount` | 6 |

### 4.3 調達処理能力 — 2方式

**（A）フォールバック絶対値カーブ**。工場能力情報が無い呼び出し（industryLab の小規模テスト会社等）向け。

| パラメータ | 値 |
|---|---|
| `baselineCapacityTons` | 150 |
| `capacityMaxIncrementTons` | 3600 |
| `capacitySaturationHeadcount` | 10 |

**（B）工場能力連動方式**（Phase 6.3新規、実装指示 §6）。`DomesticPurchasePlanEntry.factoryCommonProcessingCapacityTons` が指定されている会社ではこちらが優先される。

```
調達能力 = 工場共通原料処理能力 × ( baseRatioAtZeroHeadcount
                                  + ratioMaxIncrement × 人員 / (人員 + saturationHeadcount) )
```

| パラメータ | 値 |
|---|---|
| `baseRatioAtZeroHeadcount` | 0.5 |
| `ratioMaxIncrement` | 1.2 |
| `saturationHeadcount` | 10 |

**校正の根拠**（ファイル内コメントより）: 5社フィクスチャの工場能力（1.5万〜3.6万トン/四半期）に対し、人員8〜20人で調達能力が工場能力の約 1.03〜1.30倍 となる。狙いは3点。

- 通常操業では頻繁に制約になりすぎない（調達構成6〜7割の国内買付は余裕内）
- 急増産・買い占め（工場能力を大きく超える買付）では制約になる
- 調達人員を増やす効果は残るが飽和する

**旧方式の廃止**: Phase 6.2 以前の company-lab には約100倍の一律補正があったが、明確な経済的根拠のないテスト専用倍率であり、補正後の調達能力が工場能力の7〜11倍と過大で制約として一度も機能していなかった。Phase 6.3 で廃止。

**導出値（BAL: 工場共通能力22,000t、調達人員12人）**:
```
22,000 × (0.5 + 1.2 × 12/22) = 22,000 × 1.1545 = 25,400 t
```

### 4.4 買付競争力の合成ウェイト（合計1.0）

| 要素 | ウェイト |
|---|---|
| `price` | 0.40 |
| `coverage` | 0.25 |
| `farmerRelationship` | 0.20 |
| `paymentReliability` | 0.15 |

`neutralScore` = 50。

### 4.5 買付シェア上限

| パラメータ | 値 | 用途 |
|---|---|---|
| `maximumBuyerShare` | 0.35 | 実配分（`allocateDomesticPurchase`）の cap |
| `maximumPriceInfluenceShare` | 0.35 | 国内価格形成へ渡す「有効買付意向」の上限 |

**この2つを分離している理由**（Task E差分）: 「実際に買える上限」と「価格シグナルとして認める上限」は将来別々に調整したい場合があるため。現段階では同値。

これにより **「実際には買えない希望量を過大申告して国内価格だけを押し上げる」抜け道を防いでいる**。会社の有効買付意向は次の最小値に制限される。

```
min( desiredQuantity, procurementCapacity, approvedPurchaseCap, 基準供給量 × 0.35 )
```

### 4.6 入力検証

| パラメータ | 値 |
|---|---|
| `minBidPriceRatioOfMarket` | 0.5 |
| `maxBidPriceRatioOfMarket` | 2.0 |

### 4.7 輸入（`imports`）

| パラメータ | 値 | 意味 |
|---|---|---|
| `freightUsdPerHosoEqKg` | 0.15 | 運賃 |
| `dutyRatio` | 0.05 | 関税・諸税（起点価格に対する比率） |
| `insuranceHandlingUsdPerHosoEqKg` | 0.05 | 保険・取扱費 |
| `originCountryAdjustmentUsdPerHosoEqKg` | **全国 0** | 原産国別の着地価格調整額 |
| `standardLeadTimeTurns` | **2** | 発注四半期から到着四半期までのターン数 |
| `importAvailableSupplyRatio` | 0.10 | 各原産国の `exportableSupply` に対する輸入上限比率 |

`importAvailableSupplyRatio` の目的は、5社の輸入が国際基準価格そのものへ直接影響しないようにすること。

**着地原価の計算**:
```
着地価格 = 起点FOB価格 × (1 + 0.05) + 0.15 + 0.05 + 原産国調整(0)
```

### 4.8 自社養殖（`aquaculture`）

| パラメータ | 値 | 意味 |
|---|---|---|
| `intensityYieldBonusMax` | 0.5 | 養殖強度による予定生産量への最大上乗せ比率（intensity=1で+50%） |
| `intensityDiseaseVulnerabilityMax` | 0.8 | 養殖強度による疾病脆弱性への最大上乗せ比率（intensity=1で+80%） |
| `bioSecurityMitigationMax` | 0.7 | バイオセキュリティによる疾病影響の最大緩和比率 |
| `minSurvivalRatio` | 0.1 | 生残率の下限（壊滅的な疾病でも0にはしない） |
| `aquacultureUnitCostUsdPerHosoEqKg` | **3.2** | 自社養殖の単位取得原価。会計処理を簡略化するための固定値 |

$3.2/kg は、通常時の国内買付価格（$2.4〜3.0）と比較すると**割高**である。

### 4.9 原料在庫

| パラメータ | 値 |
|---|---|
| `defaultShelfLifeTurns` | **undefined**（期限を設けない運用） |

原料の鮮度管理は簡略化されており、期限切れの経済的帰結（廃棄損の会計計上等）は Phase8 で接続する前提。ただし品質モジュールは独自に4四半期を実務的な鮮度限界として扱っている（第6章参照）。

---

## 5. 生産（`production/parameters.ts`）

`PRODUCTION_PARAMETERS_V1` / `parametersVersion: "production-v0.2"`

### 5.1 歩留まり（`yield`）— 最重要の設計事項

```
physicalYieldRatio    : { hoso: 1.0, pd: 0.54 }        ← 参考値。換算には使わない
saleableRecoveryRatio : { hoso: 1.0, pd: 1.0, vap: 1.0 }  ← HOSO換算上の真の回収率
```

**歴史的経緯**: Phase 6 の初期実装には `baseYieldRatio`（HOSO 0.92 / PD 0.80 / VAP 0.70）があったが、これは**殻・頭の除去による通常の重量減を二重に計上していた**。HOSO換算トンという単位が既にその物理的減量を織り込んでいるためである。

Phase 6.1 / 6.3 で次のように分離した。

- **`physicalYieldRatio`** — 参考値・非換算用。`yieldConversion.ts` の `calculatePhysicalOutputTons` だけが参照し、**永続化されない**。VAP には単一の物理歩留まりが存在しないため値を持たない。
- **`saleableRecoveryRatio`** — HOSO換算上の真の回収率。通常操業の基準値は 1.00。品質モジュールが不適合・廃棄に応じてこれを引き下げる（下限 0.90）。

**換算の基準**:
```
HOSO原料 100t → 冷凍HOSO 約100 物理t（1.00）
              → HLSO      約 60      （0.60。商品enumに無いため値を保持しない）
              → PD        約 54      （0.54）
```

詳細は `docs/v2/PRODUCTION_ARCHITECTURE_v0.1.md` §6。

**適用位置**: 5段階制約の ②工場共通処理能力 と ③冷凍・包装能力 のあいだで**一度だけ**適用される。

### 5.2 能力

| パラメータ | 値 |
|---|---|
| `capacity.epsilon` | 1e-6 |

**工場の実効能力**（`production/capacity.ts:30` の `calculateFactoryEffectiveCapacity`）は、内部関数 `applyRates(nominal, baseUtilizationRate, equipmentAvailabilityRate)` により:

```
実効能力 = 公称能力 × baseUtilizationRate × equipmentAvailabilityRate
        = 公称能力 × 0.90 × 0.95
        = 公称能力 × 0.855
```

`roundHosoEqTons` で小数2桁に丸める。**補正係数はこの2つだけ**で、1工場の5つの能力プールすべてに一律で掛かる。`factory.status !== "active"` ならすべて 0。

これら2つの値は `fixtures.ts` の `factory()` 既定値として設定されている（第11章参照）。

### 5.3 労働（`labor`）

| パラメータ | 値 | 意味 |
|---|---|---|
| `regularEfficiencyPerHeadTons` | 6 | 正社員1人あたりの基準処理能力（トン、商品非依存の基礎値） |
| `temporaryEfficiencyPerHeadTons` | 3.5 | 臨時工1人あたり（正社員の約58%、商品非依存の基礎値） |
| `overtimeRateCap` | 0.3 | 残業率の上限（所定の30%まで） |
| `overtimeEfficiencyFactor` | 0.5 | 残業時間の能力換算効率 |
| `laborIntensityCoefficientByProduct` | hoso 1.0 / pd 1.2 / vap 3.0 | **【2026-08-01追加】製品別労務負荷係数** |

**【2026-08-01・製品別労務負荷係数の追加】** 以前は正社員・臨時工の基礎処理能力（上記2値）が商品非依存であり、会社別skillの差だけが商品間の労務負荷差を表していた。これはゲーム設計上の意図（同じHOSO換算生産量を処理するときの労務負荷はHOSO:PD:VAP = 1.0:1.2:3.0であるべき）と一致しておらず、結果として6,000人規模のWorkerに対して必要人数が極端に少なくなる、巨額の遊休人件費が恒常的に発生する等の不具合を引き起こしていた（詳細はブランチ`feature/v2-product-labor-intensity`の完了報告を参照）。

この係数は「同じHOSO換算生産量を処理するときに要する労務量」の相対比であり、**歩留まり係数（`yield.saleableRecoveryRatio`、原料→完成品の物理的回収率）とも、管理会計上の固定費配賦係数（`finance/parameters.ts` `managementAccounting.fixedCostAllocationCoefficientByProduct`、hoso 1.0/pd 1.5/vap 2.4）とも、営業工数係数（`sales/parameters.ts` `salesEffortCoefficients`、hoso 1.0/pd 1.2/vap 3.0、営業活動専用）とも別系統の、労務専用の係数である**。数値がsalesEffortCoefficientsとたまたま同じであっても意味も適用箇所も異なるため混同しないこと。

適用箇所は `production/labor.ts` の `calculateLaborCapacityFromAssignedHeadcount`（配分人数→有効労働能力）と `requiredHeadcountForQuantity`（数量→必要人数）の2関数に一元化されており、UI表示（`investmentPlanningViewModel.ts`）・Standard AI判断（`companyLab/workforce.ts`経由）・生産エンジン（`allocation.ts`）はすべてこの2関数を共有するため、単一の設定値を変えるだけで全体に一貫して反映される。skill・attendance・overtimeの各補正とは独立した乗数（除数）として適用され、二重計上しない。

```
1人あたり有効能力（商品pごと） = regularEfficiencyPerHeadTons × 出勤率 × 技能レベル(p) × 残業係数 ÷ laborIntensityCoefficientByProduct[p]

必要人数（商品pの数量qを処理するため） = q × laborIntensityCoefficientByProduct[p] ÷ (regularEfficiencyPerHeadTons × 出勤率 × 技能レベル(p) × 残業係数)
```

端数処理は、商品ごとに算出した有効労働能力・必要人数をその都度丸める（`allocateWorkersToPlans`が返す`laborCapacity`は`roundHosoEqTons`で商品別エントリごとに早期丸めしてから合算する）。商品を合算してから丸める実装にはなっていないため、混合生産時に大きな誤差が生じない。

**導出値（BAL: 出勤率0.95、技能 h0.85/p0.80/v0.75、製品別労務負荷係数を適用後）**:

| 商品 | 1人あたり(t)（旧・商品非依存） | 1人あたり(t)（新・労務負荷係数適用後） |
|---|---|---|
| HOSO | 4.845 | 4.845（÷1.0） |
| PD | 4.560 | 3.800（÷1.2） |
| VAP | 4.275 | 1.425（÷3.0） |

### 5.4 加工原価（`cost`）

| 商品 | `baseProcessingCostUsdPerTon` |
|---|---|
| HOSO | 350 |
| PD | 520 |
| VAP | 780 |

`hosoEqKgPerTon` = 1000。

これは業界標準の基準値であり、会社ごとの実際の加工費は `fixtures.ts` の `productEconomics` で個別に設定される（第11章）。

### 5.5 製品在庫・供給シグナル

| パラメータ | 値 |
|---|---|
| `finishedGoods.defaultShelfLifeTurns` | 4 |
| `supplySignal.preserveExistingWhenNoSignal` | true |

---

## 6. 品質・信頼性（`quality/parameters.ts`）

`QUALITY_PARAMETERS_V1` / `parametersVersion: "quality-v0.1"`

**このファイルは他と性質が異なる。** 大半の値は**三宅さんの実装指示に明示された数値をそのまま採用**しており、実装者が補ったのは限られた項目だけである。ファイル冒頭コメントに明記されている。

**指示由来（変更に際して指示元の確認を要する）**: utilization の閾値 0.80・帯域 0.20・指数 2、operationalRisk の各重み、`maximumNonConformanceRatio = 0.08`、downgrade/rework/discardShare、`minimumSaleableRecoveryRatio = 0.90`、majorIncident の各確率、品質・納期・顧客信頼の更新 alpha。

**実装者が補った要校正値**: 重大事故の重大度→追加廃棄率／品質減点／信頼減点の換算係数、継続納期超過への小さなペナルティ、`baselineOperationalQuality`。

### 6.1 操業リスク（`operationalRisk`）

```
utilizationStress = clamp( (rate - utilizationThreshold) / utilizationBand, 0, 1 ) ^ utilizationExponent
```

| パラメータ | 値 |
|---|---|
| `utilizationThreshold` | 0.8 |
| `utilizationBand` | 0.2 |
| `utilizationExponent` | 2 |
| `rawMaterialUsableShelfLifeQuarters` | 4 |

`rawMaterialUsableShelfLifeQuarters` は品質モジュール独自の参考基準である。`rawMaterials` 側は `defaultShelfLifeTurns: undefined`（期限なし運用）のため、原料経過期間ストレスの分母としてここで定義している。

**重みの合成**（合計1.0、実装指示の値をそのまま採用）:

| 要素 | ウェイト |
|---|---|
| `utilization` | 0.35 |
| `overtime` | 0.20 |
| `temporaryWorker` | 0.15 |
| `complexity` | 0.10 |
| `rawMaterialAge` | 0.10 |
| `productionRamp` | 0.10 |

### 6.2 品質の帰結（`qualityOutcome`）

```
nonConformanceRatio   = maximumNonConformanceRatio × operationalRisk ^ nonConformanceExponent
saleableRecoveryRatio = clamp( 1 - discardRatio, minimumSaleableRecoveryRatio, 1 )
observedQualityScore  = clamp( baselineOperationalQuality
                             - qualityRiskPenaltyPerUnitRisk × operationalRisk
                             - 重大事故減点, 0, 100 )
```

| パラメータ | 値 |
|---|---|
| `maximumNonConformanceRatio` | 0.08 |
| `nonConformanceExponent` | 1.5 |
| `downgradeShare` | 0.45 |
| `reworkShare` | 0.25 |
| `discardShare` | 0.30 |
| `minimumSaleableRecoveryRatio` | 0.90 |
| `baselineOperationalQuality` | 85 |
| `qualityRiskPenaltyPerUnitRisk` | 30 |

`baselineOperationalQuality = 85` は、既存フィクスチャに品質能力の値がなかったため全社共通の中立値として採用したもの（要校正）。

**導出値**:

| operationalRisk | 不適合率 | 品質スコア |
|---|---|---|
| 0.0 | 0.00% | 85.0 |
| 0.2 | 0.72% | 79.0 |
| 0.4 | 2.02% | 73.0 |
| 0.56625 | 3.41% | 68.0 |
| 0.6 | 3.72% | 67.0 |
| 0.8 | 5.72% | 61.0 |
| 1.0 | 8.00% | 55.0 |

### 6.3 重大事故（`majorIncident`）

```
事故確率 = baseIncidentProbability
         + maximumRiskIncidentProbability × operationalRisk ^ riskExponent
         （上限 maximumIncidentProbability）
```

| パラメータ | 値 |
|---|---|
| `baseIncidentProbability` | 0.002 |
| `maximumRiskIncidentProbability` | 0.08 |
| `riskExponent` | 2 |
| `maximumIncidentProbability` | 0.10 |
| `severityToAdditionalDiscardRatio` | 0.5 |
| `severityToQualityPenalty` | 40 |
| `severityToTrustPenalty` | 25 |

換算係数の3つは**要校正**。設計方針は「事故一発で会社が再起不能にならない」こと。数量影響は `minimumSaleableRecoveryRatio = 0.90` のフロアによりバッチ単位10%までに既に制限され、品質・信頼スコアは alpha 付き更新により単発事故でも即座にゼロへ張り付かない。

### 6.4 スコアの更新（平滑化）

いずれも**悪化は速く、回復は遅い**という非対称設計。

| 対象 | alphaDown（悪化） | alphaUp（回復） |
|---|---|---|
| `qualityScoreUpdate` | 0.20 | 0.08 |
| `deliveryReliabilityUpdate` | 0.25 | 0.08 |
| `customerTrustUpdate` | 0.18 | 0.06 |

**納期信頼性の継続超過ペナルティ**（要校正）:

| パラメータ | 値 |
|---|---|
| `continuingOverduePenaltyPerRatio` | 10 |
| `continuingOverduePenaltyCap` | 8 |

過年度から持ち越された継続納期超過数量に対し、`dueQuantity` に対する継続超過量の比率にこの係数を掛けた分だけ `observedOnTimeScore` を追加減点する。継続分を「毎期新しい失敗」として無制限に重複加算しないよう上限を設けている。

**顧客信頼の合成**:

| 要素 | ウェイト |
|---|---|
| `qualityWeight` | 0.5 |
| `deliveryWeight` | 0.5 |

`neutralScore` = 50。

### 6.5 実装上の既知の癖（パラメータではない）

`laborUtilizationRate = totalProduced / totalLaborCapacityAllocated`（`production/loadMetrics.ts:59`）は構造的にほぼ 1.0 になるため、`utilizationStress` が 1.0 に張り付く。**人員を削減しても品質は悪化しない。** また `productionRampStress` は生産量が減少すると 0 になる。

これは指標定義の副作用であり、パラメータの校正では解決しない。将来の実装変更対象。

---

## 7. 財務・決算（`finance/parameters.ts`）

`FINANCE_PARAMETERS_V1` / `parametersVersion: "finance-v0.1"`

### 7.1 労務（`labor`）

| パラメータ | 値 |
|---|---|
| `regularWorkerSalaryUsdPerQuarter` | 1,000 |
| `temporaryWorkerCostUsdPerQuarter` | 800 |
| `overtimePremiumFactor` | 1.5 |

ベトナムの工場労働者賃金 $250〜400/月 + 社会保険 を四半期換算した水準。

**遊休人件費**（`quarterClose.ts:307-310`）:
```
productiveRegularHeadcount = min(総配置正社員数, actuals.regularHeadcount)
idleRegularHeadcount       = max(0, actuals.regularHeadcount - productiveRegularHeadcount)
idleLaborCost              = idleRegularHeadcount × regularWorkerSalaryUsdPerQuarter
```

`actuals.regularHeadcount` はプレイヤーが提出した `workerAssignments` からそのまま来る（`companyLabAdapter.ts:256`）。**上限バリデーションは無く、解雇費用・採用費用もモデル化されていない**（`WorkerLifecycleStatus` は `production/types.ts:87` に型として存在するが未使用）。

### 7.2 製造（`manufacturing`）

| パラメータ | 値 |
|---|---|
| `reworkCostUsdPerTon` | 200 |
| `factoryFixedCostUsdPerQuarter` | 1,200,000 |
| `factoryUtilityFixedUsdPerQuarter` | 250,000 |
| `factoryUtilityVariableUsdPerTon` | 25 |

### 7.3 販管費（`sellingGeneralAdmin`）

| パラメータ | 値 |
|---|---|
| `salesForceSalaryUsdPerQuarter` | 8,000 |
| `procurementSalaryUsdPerQuarter` | 7,000 |
| `adminFixedUsdPerQuarter` | 800,000 |
| `sellingLogisticsUsdPerTon` | 100 |

```
SG&A = 8,000 × 営業人員数 + 7,000 × 調達人員数 + 800,000 + 100 × 販売トン数
```

**検証例（BAL Turn 2）**: 営業18人・調達12人・販売12,372.5t
```
144,000 + 84,000 + 800,000 + 1,237,250 = $2,265,250 ✓
```

### 7.4 運転資本（`workingCapital`）

| パラメータ | 値 | 意味 |
|---|---|---|
| `arCollectionQuarters` | 1 | 売掛金は翌四半期回収 |
| `apImportPaymentQuarters` | 1 | 輸入買掛は翌四半期支払 |
| `apDomesticPaymentQuarters` | **0** | 国内買付は当期現金払い |

**この非対称性がゲームの資金繰りを決定づけている。**

### 7.5 金融（`finance`）

| パラメータ | 値 |
|---|---|
| `shortTermInterestRatePerQuarter` | 0.022 |
| `longTermInterestRatePerQuarter` | 0.018 |
| `incomeTaxRate` | 0.20 |

### 7.6 既存資産の減価償却（`existingAssetDepreciation`）

| パラメータ | 値 |
|---|---|
| `buildingOpeningRatio` | 0.35 |
| `machineryOpeningRatio` | 0.65 |
| `buildingRemainingLifeQuartersAtGameStart` | 80 |
| `machineryRemainingLifeQuartersAtGameStart` | 32 |

**Phase 8B-2C の変更**: 旧 `depreciationRatePerQuarter`（一律2.5%/四半期。「定率法」と誤ラベルされていたが実質は取得原価一律10年均等）を廃止し、建物・機械の2区分による定額法へ置き換えた。

モジュール読み込み時に `assertValidExistingAssetRatios` が2つの比率の合計が 1（誤差 1e-9 以内）であることを検証し、違反すれば `FinanceValidationError` を投げる。

### 7.7 品質

| パラメータ | 値 |
|---|---|
| `quality.downgradePriceDiscountRatio` | 0.25 |

格下げ品は 25% 引きで販売される。

### 7.8 誤差許容

| パラメータ | 値 |
|---|---|
| `epsilonUsd` | 0.01 |

### 7.9 スケール校正の根拠（ファイル内コメントより）

baseline / canonical の8ターン実行に対して校正されている。

| 指標 | 校正時の観測範囲 |
|---|---|
| 5社の四半期売上 | $28M〜$76M |
| 正社員数 | 4,500〜9,000人 |
| 生産量 | 6,000〜16,000 t/四半期 |
| 原料単価 | $2.9〜3.2/kg |
| 販売単価 | $4.0〜5.8/kg |

目標としているのは **Minh Phu 型の経済構造**（原料費が売上原価の60〜70%、営業利益率は一桁）。

---

## 8. 資金調達・信用（`financing/parameters.ts`）

`FINANCING_PARAMETERS_V1` / `parametersVersion: "financing-v0.1"`

### 8.1 金利（`interestRate`）

```
適用年率 = baseRateAnnual + creditSpreadAnnualByTier[格付け] + 各種サーチャージ
```

| パラメータ | 値 |
|---|---|
| `baseRateAnnual` | 0.04 |

**格付け別スプレッド（年率）**:

| 格付け | スプレッド |
|---|---|
| A | 0.020 |
| B | 0.035 |
| C | 0.050 |
| D | 0.070 |
| E | 0.090 |

**サーチャージ（年率）**:

| 種別 | 値 |
|---|---|
| `emergencyLoanSurchargeAnnual` | 0.100 |
| `covenantBreachSurchargeAnnual` | 0.015 |
| `arrearsHistorySurchargeAnnual` | 0.020 |
| `refinanceSurchargeAnnual` | 0.005 |
| `termLoanDurationSurchargeAnnual` | 0.005 |

**導出値**: Tier B・通常借入なら 4% + 3.5% = **年7.5%**。Tier E で条項違反・延滞履歴ありなら 4% + 9% + 1.5% + 2% = **年16.5%**。

### 8.2 信用スコア（`creditScore`）

**重みの合成**（合計1.0）:

| 要素 | ウェイト |
|---|---|
| `cashRunway` | 0.15 |
| `operatingCashFlow` | 0.15 |
| `profitability` | 0.15 |
| `leverage` | 0.15 |
| `interestCoverage` | 0.10 |
| `equityRatio` | 0.10 |
| `repaymentTrackRecord` | 0.10 |
| `arrearsHistory` | 0.05 |
| `customerTrustAndDelivery` | 0.05 |

**格付け閾値**:

| 格付け | 下限スコア |
|---|---|
| A | 80 |
| B | 65 |
| C | 50 |
| D | 35 |
| E | （35未満） |

`neutralInitialScore` = 65（初期はTier B）。

**検証例（BAL Turn 2）**: 9要素のうち profitability 0、interestCoverage 0、その他は 100 または 65。加重合計 **73.25 → Tier B**。

### 8.3 借入余力（`borrowingCapacity`）

**担保掛け目**:

| 担保 | 掛け目 |
|---|---|
| `receivablesHaircut` | 0.70 |
| `rawMaterialInventoryHaircut` | 0.40 |
| `rawMaterialInTransitHaircut` | 0.15 |
| `finishedGoodsInventoryHaircut` | 0.30 |

| パラメータ | 値 |
|---|---|
| `earningsMultiple` | 2.0 |

**格付け別の自己資本倍率**:

| 格付け | 倍率 |
|---|---|
| A | 1.50 |
| B | 1.10 |
| C | 0.75 |
| D | 0.40 |
| E | 0 |

3方式（担保ベース・利益ベース・格付けベース）のうち**最も厳しいものが総枠**になり、そこから既存借入を差し引いた残りが追加借入余力。

**検証例（BAL Turn 2）**: 担保 $14,395,173.77 / 利益 $0 / 格付け $157,834,145.69 → 総枠 $14,395,173.77。既存借入 $52,540,000 → **追加余力 $0**、拘束要因 `collateralBased`、`underwritingFrozen: false`。

### 8.4 財務制限条項（`covenant`）

| パラメータ | 値 |
|---|---|
| `minEquityRatio` | 0.15 |
| `maxDebtToAssetsRatio` | 0.85 |
| `minInterestCoverageRatio` | 1.0 |
| `breachCreditScorePenalty` | 8 |
| `consecutiveBreachFreezeThresholdQuarters` | 2 |

2四半期連続で違反すると新規融資が凍結される。

### 8.5 緊急融資（`emergencyLoan`）

| パラメータ | 値 |
|---|---|
| `standardAnnualRateRange.min` | 0.15 |
| `standardAnnualRateRange.max` | 0.20 |
| `capRatioOfCollateral` | 0.5 |
| `absoluteCapUsd` | 30,000,000 |
| `termQuarters` | 2 |

### 8.6 流動性（`liquidity`）

| パラメータ | 値 | 意味 |
|---|---|---|
| `domesticPurchaseCashAllocationRatio` | 0.6 | 国内買付へ充当する現金の比率 |
| `severeArrearsRatioThreshold` | 0.5 | 深刻な延滞と判定する比率 |
| `paymentDefaultConsecutiveQuartersThreshold` | 3 | 支払不能を深刻と判定する連続四半期数 |
| `targetCashBufferMultipleOfFixedCost` | 1.0 | 目標現金バッファ（固定費の倍数） |
| `voluntaryPrepaymentCashBufferMultiple` | 2.5 | 任意期限前返済を行う現金水準の倍数 |

`epsilonUsd` = 0.01。

---

## 9. 設備投資（`capex/parameters.ts`）

`CAPEX_PARAMETERS_V1` / `parametersVersion: "capex-v0.3"`

### 9.1 案件テンプレート一覧

| 案件種別 | 表示名 | 標準予算(USD) | 支払比率 | 工期(Q) | 資産区分 | 稼働待ち(Q) | 建物比率 | 機械比率 | 保守費率/Q |
|---|---|---|---|---|---|---|---|---|---|
| `hosoLineExpansion` | HOSO加工ライン増設 | 3,000,000 | 0.3/0.4/0.3 | 3 | productionEquipment | 1 | 0.20 | 0.80 | 0.0075 |
| `pdLineExpansion` | PD加工ライン増設 | 4,000,000 | 0.3/0.4/0.3 | 3 | productionEquipment | 1 | 0.20 | 0.80 | 0.0075 |
| `vapLineExpansion` | VAP加工ライン増設 | 6,000,000 | 0.25/0.35/0.25/0.15 | 4 | productionEquipment | 2 | 0.25 | 0.75 | 0.0100 |
| `coldStorageExpansion` | 冷凍・冷蔵保管庫増設 | 2,500,000 | 0.5/0.5 | 2 | storageEquipment | 1 | 0.40 | 0.60 | 0.0050 |
| `commonProcessingExpansion` | 共通前処理能力増設 | 5,000,000 | 0.3/0.4/0.3 | 3 | productionEquipment | 1 | 0.20 | 0.80 | 0.0075 |
| `qualityControlEquipment` | 品質管理設備 | 1,200,000 | 0.6/0.4 | 2 | qualityEquipment | 0 | 0.00 | 1.00 | 0.0125 |
| `environmentalEquipment` | 排水・環境設備 | 1,800,000 | 0.5/0.5 | 2 | environmentalEquipment | 0 | 0.30 | 0.70 | 0.0100 |

`standardConstructionQuarters` は `paymentRatios.length` と必ず一致する（実装指示 §16 の設計上の単純化）。

### 9.2 能力効果（`futureCapacityEffect`）

| 案件種別 | 対象 | 増分(t/Q) | 完成後の稼働待ち(Q) |
|---|---|---|---|
| `hosoLineExpansion` | hoso | 500 | 1 |
| `pdLineExpansion` | pd | 350 | 1 |
| `vapLineExpansion` | vap | 250 | 2 |
| `coldStorageExpansion` | freezingPackaging | 500 | 1 |
| `commonProcessingExpansion` | commonProcessing | 700 | 1 |
| `qualityControlEquipment` | （なし） | **0** | 0 |
| `environmentalEquipment` | （なし） | **0** | 0 |

**稼働開始四半期** = 完成四半期の翌四半期 + `readinessQuartersAfterCompletion`。この時点から能力増加・減価償却・固定保守費がすべて同時に発生する（Phase 8B-2B、実装指示 §3.2「原則として同じ `operationalStartPeriod` に統一」）。

**VAP ラインの総リードタイム**: 工期4Q + 翌期1Q + 稼働待ち2Q = **発注から7四半期**。

### 9.3 品質管理設備・環境設備の重要な注意

実装指示 §7 により、この2種別は**生産能力を増加させない**（`targetProduct` 省略・`capacityIncreaseTonsPerQuarter = 0`）。固定資産振替・減価償却・固定保守費は他の案件種別と同様に適用される。

**品質・環境面の実際の効果（品質スコア・事故率・規制遵守等への接続）は対象外であり、現時点ではコスト（減価償却＋保守費）のみが発生し操業上の便益が無い。** ファイル内コメントは「通常のプレイヤー向け提案候補として安易に推奨される投資ではないことに留意」と明記している（`docs/v2/CAPITAL_INVESTMENT_ARCHITECTURE_v0.1.md` 参照）。

### 9.4 共通前処理能力増設の設計意図

Phase 8B-2B で新設された。実装指示 §3.1「HOSO・PD・VAP増設によって共通前処理能力を自動的に増加させない」を満たすため、**ボトルネック管理を独立した投資判断として学べる構造**にしている。予算・工期・保守費率・建物/機械構成比は HOSO/PD ライン増設と同水準（前工程も本質的には同種の加工設備であるため）。

### 9.5 新規資産の減価償却（`componentUsefulLifeQuarters`）

| 区分 | 耐用年数 |
|---|---|
| `building` | 100四半期（25年） |
| `machinery` | 40四半期（10年） |

**Phase 8B-2C の変更**: 単一の `usefulLifeQuarters`（案件種別ごとの耐用年数）による定額法から、建物・機械2区分のコンポーネント別定額法へ置き換えた。`usefulLifeQuarters` フィールドは削除されている（新規案件の永続フィールドではなくテンプレート専用の値だったため、後方互換の都合で残す必要がなかった）。

新規 capex 資産の耐用年数は**コンポーネントの種類だけで決まり、案件種別には依存しない**。

### 9.6 スナップショットとライブ参照の非対称性（重要）

| フィールド | 扱い |
|---|---|
| `futureCapacityEffect`（能力増分・対象商品・稼働待ち） | 承認時に `CapitalProject` へ**スナップショットコピー**され、以後不変 |
| `buildingRatio` / `machineryRatio` / `maintenanceRatePerQuarter` | **スナップショットせず、毎期テンプレートをライブ参照** |

つまり将来の経済校正でこれらの値を変更すると、**既存の進行中案件にも遡って新しい値が適用される**。この非対称性は実装指示の要求どおりであり意図的である。

### 9.7 制約

| パラメータ | 値 |
|---|---|
| `minimumCashReserveUsd` | 10,000,000 |
| `maxConcurrentActiveProjectsPerCompany` | 3 |
| `epsilonUsd` | 0.01 |

`minimumCashReserveUsd` は、5社の初期現金 $22M〜$35M（`finance/initialState.ts`）に対し通常の事業運営に必要な現金を圧迫しない水準として設定された暫定値。設備投資可能額算出の基準となり、実装指示 §14 の6段階配分の起点になる。

`maxConcurrentActiveProjectsPerCompany` の対象は `approved` / `underConstruction` / `suspended` の合計（`proposed` は含まない）。

### 9.8 実行時アサーション

```typescript
assertValidComponentRatios(CAPEX_PARAMETERS_V1.templatesByType);
```

全テンプレートについて `buildingRatio + machineryRatio` が 1（誤差 1e-9 以内）であることをモジュール読み込み時に検証し、違反すれば `CapexValidationError` を投げる。

---

## 10. Company Lab 固有の前提値（`companyLab/parameters.ts`）

このファイルには **companyLab テスト環境固有の前提値のみ**が集約されている。本番の業界モデルではなく、後から交換可能なテスト用フィクスチャの一部である。

### 10.1 外部加工業者需要（`EXTERNAL_PROCESSOR_DEMAND_ASSUMPTIONS_V1`）

すべて要校正。実装指示 §5 に対応。

| パラメータ | 値 |
|---|---|
| `referenceDomesticSupplyTons` | 450,000 |
| `baseShareOfReferenceSupply` | 0.7 |
| `priceElasticity` | 0.4 |
| `referencePriceUsdPerHosoEqKg` | 2.6 |
| `worldDemandElasticity` | 0.5 |
| `minShareOfReferenceSupply` | 0.4 |
| `maxShareOfReferenceSupply` | 0.9 |

**スケールの根拠**（ファイル内コメントより）:

- シナリオ baseline のベトナム国内原料供給は約 450,000 HOSO換算トン/四半期
- 5社フィクスチャの通常時国内買付需要は合計 6万〜9万トン/四半期程度（調達構成の再校正後）
- 「5社がベトナム加工業界の20〜30%、外部加工業者が70〜80%」という暫定設定に合わせ、外部需要の基準を **0.70 × 450,000 = 315,000トン/四半期** とする
- 総需要 約37万〜40万トンに対する5社シェアは約 **15〜23%**

### 10.2 世界需要指数の基準値

```
REFERENCE_WORLD_CONSUMPTION_TONS = 1,200,000
```

シナリオ前史の需要市場別前期消費の合計（CN 380,000 + US 320,000 + EU 260,000 + JP 90,000 + OTHER 150,000）。

```
worldDemandIndex = Σ(前期消費 × 景気指数) / 1,200,000
```

### 10.3 自動資金調達方針（`AUTO_FINANCING_POLICY_PARAMETERS_V1`）

Phase 8B-1、実装指示 §5.6。プレイヤー以外の4社が使う単純な方針の閾値。会社ごとの高度な財務戦略は Phase 9 の対象であり、ここでは「最低必要現金を下回れば借入申請、十分あれば借入しない、返済可能なら高金利借入を優先返済」という単純なルールだけを持つ。

| パラメータ | 値 |
|---|---|
| `targetMinimumCashUsd` | 40,000,000 |
| `voluntaryPrepaymentThresholdCashUsd` | 100,000,000 |
| `desiredTermQuarters` | 4 |
| `emergencyAcceptable` | true |

**校正の根拠**: 5社フィクスチャの1四半期あたりの国内買付必要現金は概ね $1,000万〜7,000万 規模であるため、最低現金目標をその規模に合わせている。$15M 等の小さすぎる目標では、四半期内の資金需要に対して早期の借入申請が間に合わず資金不足を防げない（要将来校正）。

`emergencyAcceptable: true` は固定値。通常融資が利用可能なら緊急融資を選ばないが、通常融資が不足した場合の最後の手段としては受け入れる。

### 10.4 廃止された値（Phase 6.3）

旧 `COMPANY_LAB_RAW_MATERIALS_PARAMETERS`（調達処理能力の約100倍一律補正）は**廃止された**。明確な経済的根拠のないテスト専用倍率であり、補正後は調達能力が工場能力の7〜11倍と過大で、制約として一度も機能していなかった（Phase 6.2 診断）。第4.3節の工場能力連動方式へ置き換えられている。

---

## 11. 5社フィクスチャ（`companyLab/fixtures.ts`）

**重要な位置づけ**: ファイル冒頭コメントに明記されているとおり、これは**統合テスト用フィクスチャであり、本番の会社設定ではない**。ゲームバランス調整の対象としても位置づけられていない。ただし `Test12` を含む実際のプレイセッションはこのフィクスチャで動いているため、実質的にゲーム設定として機能している。

```typescript
export const COMPANY_LAB_COMPANY_IDS: readonly CompanyId[] = ["BAL", "MASS", "JPQ", "VAP", "CONSV"];
```

### 11.1 ヘルパー関数の既定値

**`factory()`**:

| フィールド | 既定値 |
|---|---|
| `status` | `"active"` |
| 各能力 | `hosoEqTons(0)` |
| `baseUtilizationRate` | `ratio(0.9)` |
| `equipmentAvailabilityRate` | `ratio(0.95)` |

**実効能力係数 0.855 はここに由来する。**

**`workerBaseline(factoryId, companyId, regularHeadcount, skillLevels, attendanceRate = 0.95)`**

**`initialLot(...)`**:

| フィールド | 既定値 |
|---|---|
| `source` | `"domestic"` |
| `status` | `"available"` |
| `availableFromPeriod` | `inboundPeriod` |

### 11.2 会社別の能力・人員（公称値、HOSO換算トン/四半期）

| 会社 | 表示名 | archetype | 共通前処理 | HOSO | PD | VAP | 冷凍包装 | 正社員 | 技能(h/p/v) | 出勤率 | 養殖能力 | 営業上限 | 調達上限 | 初期原料 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **BAL** | バランス型水産 | balanced | 22,000 | 10,000 | 8,000 | 6,000 | 20,000 | 6,000 | .85/.80/.75 | 0.95 | 15,000 | 18 | 12 | 3,000t @$4.2 |
| **MASS** | 大量生産・価格競争水産 | massMarket | 36,000 | 30,000 | 6,000 | 2,000 | 34,000 | 9,000 | .90/.60/.50 | 0.95 | 18,000 | 22 | 20 | 5,000t @$4.0 |
| **JPQ** | 日本・品質志向水産 | japanQuality | 16,000 | 4,000 | 11,000 | 3,000 | 15,000 | 5,500 | .60/.95/.70 | 0.95 | 9,000 | 14 | 10 | 2,500t @$4.3 |
| **VAP** | VAP特化水産 | vapSpecialist | 18,000 | 3,000 | 4,000 | 12,000 | 17,000 | 6,500 | .50/.65/.95 | 0.95 | 10,000 | 14 | 10 | 2,500t @$4.3 |
| **CONSV** | 保守的・財務慎重水産 | conservative | 15,000 | 8,000 | 6,000 | 4,000 | 14,000 | 4,500 | .80/.75/.70 | **0.97** | 10,000 | 10 | 8 | 3,000t @$4.1 |

CONSV だけ出勤率が 0.97 と高い。

### 11.3 実効能力（公称 × 0.855）

| 会社 | 共通前処理 | HOSO | PD | VAP | 冷凍包装 |
|---|---|---|---|---|---|
| BAL | 18,810 | 8,550 | 6,840 | **5,130** | 17,100 |
| MASS | 30,780 | 25,650 | 5,130 | 1,710 | 29,070 |
| JPQ | 13,680 | 3,420 | 9,405 | 2,565 | 12,825 |
| VAP | 15,390 | 2,565 | 3,420 | 10,260 | 14,535 |
| CONSV | 12,825 | 6,840 | 5,130 | 3,420 | 11,970 |

### 11.4 労働能力（1人あたり、トン）

```
6 × 出勤率 × 技能レベル
```

| 会社 | HOSO | PD | VAP |
|---|---|---|---|
| BAL | 4.845 | 4.560 | 4.275 |
| MASS | 5.130 | 3.420 | 2.850 |
| JPQ | 3.420 | 5.415 | 3.990 |
| VAP | 2.850 | 3.705 | 5.415 |
| CONSV | 4.656 | 4.365 | 4.074 |

### 11.5 営業人員上限（`salesForceHeadcountTotal`）

| 会社 | 上限 |
|---|---|
| BAL | 18 |
| MASS | 22 |
| JPQ | 14 |
| VAP | 14 |
| CONSV | 10 |

**これはハードな上限であり、増員できない。** `runner.ts:522` の `validateSalesForceHeadcountBudget(d.salesPlans, f.salesForceHeadcountTotal)` が検証する。BAL の定義は `fixtures.ts:142`。

### 11.6 加工費とプレミアム方針

**`productEconomics(processingCost{hoso, pd, vap}, pdPremium, vapPremium)`**

**`premiumEconomics(variable, fixed, selling, targetMargin, incrementalSelling, minimumContribution)`** — `avoidableVariableProcessingCost` は `variable` と同値に設定される。

| 会社 | 加工費 h/p/v | PD premium 引数 | VAP premium 引数 | コメント記載の目標/最低 |
|---|---|---|---|---|
| BAL | 0.50 / 0.75 / 1.20 | (0.17, 0.15, 0.05, 0.15, 0.03, 0.05) | (0.43, 0.35, 0.10, 0.30, 0.06, 0.10) | PD 0.52/0.25、VAP 1.18/0.59 |
| MASS | 0.45 / 0.85 / 1.60 | (0.22, 0.18, 0.05, 0.12, 0.03, 0.05) | (0.78, 0.45, 0.10, 0.25, 0.06, 0.10) | PD 0.57/0.30、VAP 1.58/0.94 |
| JPQ | 0.60 / 0.68 / 1.25 | (0.14, 0.13, 0.06, 0.18, 0.03, 0.06) | (0.48, 0.36, 0.11, 0.33, 0.06, 0.12) | PD 0.51/0.23、VAP 1.28/0.66 |
| VAP | 0.62 / 0.78 / 1.00 | (0.18, 0.15, 0.05, 0.15, 0.03, 0.05) | (0.34, 0.28, 0.09, 0.28, 0.05, 0.08) | PD 0.53/0.26、VAP 0.99/0.47 |
| CONSV | 0.52 / 0.80 / 1.30 | (0.18, 0.16, 0.05, 0.17, 0.03, 0.07) | (0.50, 0.38, 0.10, 0.35, 0.06, 0.14) | PD 0.56/0.28、VAP 0.70 |

加工費の単位は USD/HOSO換算kg。得意商品ほど加工費が安いという設計になっている（JPQ の PD 0.68、VAP社の VAP 1.00 が各社中最安）。

### 11.7 初期原料ロット

| 会社 | 数量(t) | 単価($/kg) |
|---|---|---|
| BAL | 3,000 | 4.2 |
| MASS | 5,000 | 4.0 |
| JPQ | 2,500 | 4.3 |
| VAP | 2,500 | 4.3 |
| CONSV | 3,000 | 4.1 |

いずれも `source: "domestic"`、`status: "available"`。

---

## 12. パラメータ変更のチェックリスト

バランス調整で値を変更する際に確認すべき事項。

**変更前**:

1. 変更対象が「確定」値でないか確認する（仕様書・実装指示に明示された数値は勝手に変えない）
2. その値が他モジュールから参照されていないか確認する（例: `REFERENCE_WORLD_CONSUMPTION_TONS` は前史の消費量合計と一致している必要がある）
3. 実行時アサーションに引っかからないか確認する（比率の合計 = 1 の制約）

**変更方法**:

4. 既存の `*_PARAMETERS_V1` を書き換えるのではなく、**新バージョンとして追加する**（全体実装計画書 v0.1 §20）
5. 変更理由・校正の根拠をファイル内コメントに残す（既存のコメントがすべてそうしている）

**変更後**:

6. `npx tsc --noEmit -p .` — 型チェック（`npm test` では代替できない）
7. `npx eslint <変更ファイル>`
8. `npm test` — 1,474テストが通ること
9. `npm run build`
10. `npm run v2:company-simulate` で8ターン実行し、経済スケールが 7.9節の校正範囲から逸脱していないか確認する
11. commit → push → Vercel Preview が READY

**変更してはならないもの**:

- `Test12` の確定履歴（再実行・初期化の禁止）
- 永続化スキーマ

---

## 付録　パラメータ横断インデックス

同じ値・似た値が複数のファイルに現れるものを一覧する。整合性を壊さないための参照。

| 値 | 出現箇所 | 備考 |
|---|---|---|
| 0.15（カバレッジ基準値） | `sales`, `rawMaterials` | 販売と調達で同形の曲線 |
| 6（カバレッジ半飽和点） | `sales`, `rawMaterials` | 同上 |
| 10（能力半飽和点） | `sales`, `rawMaterials`（両方式） | 同上 |
| 3.0（価格感度） | `sales.priceSensitivity`, `rawMaterials.purchasePriceSensitivity` | 符号が逆で対称 |
| 0.5 / 1.6（競争力クランプ） | `sales`, `rawMaterials` | 同上 |
| 0.35（シェア上限） | `sales.maximumSupplierShare`, `sales.externalOptionWeight`, `rawMaterials.maximumBuyerShare`, `rawMaterials.maximumPriceInfluenceShare` | 4箇所。用途は異なる |
| 0.5 / 2.0（価格入力検証） | `sales`, `rawMaterials` | 同上 |
| 50（中立スコア） | `sales`, `rawMaterials`, `quality`, `market.referenceQualityScore` | 全モジュール共通の中立値 |
| 4,700 / 5,250 / 5,450 / 5,600（初期FOB） | `market.initialHosoFobPriceUsdPerKg`, `scenario.SCENARIO_PREHISTORY_BASELINE_V1.priorHosoFobPriceUsdPerKg` | **両者は一致していなければならない** |
| 1,200,000（世界消費基準） | `companyLab.REFERENCE_WORLD_CONSUMPTION_TONS`, `scenario` 前史の消費量合計 | **両者は一致していなければならない** |
| 450,000（VN供給） | `companyLab.referenceDomesticSupplyTons`, `scenario.countrySupplyHosoEqTons.VN` | 一致 |
| 4（期間） | `quality.rawMaterialUsableShelfLifeQuarters`, `production.finishedGoods.defaultShelfLifeTurns`, `scenario.domesticPurchaseTrailingWindowTurns`, `companyLab.desiredTermQuarters` | 偶然の一致。相互依存はない |
| 1.0（HOSO換算回収率） | `production.saleableRecoveryRatio.hoso`, `scenario.hosoEqRecoveryRatio` | **どちらも Phase 6.x の歩留まり二重計上是正の結果** |
| 0.01（epsilonUsd） | `finance`, `financing`, `capex` | 金額の誤差許容 |

---

*本書に記載したすべての値は、2026-07-26 時点のリポジトリ `feature/v2-export-download-ui` ブランチの各 `parameters.ts` および `fixtures.ts` を全文読解して転記したものである。導出値（カバレッジ表・成約能力表・実効能力表・労働能力表・priceScore表など）は上記の実値から本書作成時に計算したものであり、その旨を各表で明示している。*
