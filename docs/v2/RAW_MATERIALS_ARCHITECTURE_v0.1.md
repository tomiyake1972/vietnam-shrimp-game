# ShrimpX V2 — 国内原料・輸入・養殖・原料在庫モジュール アーキテクチャ v0.1（Phase 5）

## 1. 本モジュールの責務・非責務

Phase5「国内原料・輸入・養殖・原料在庫」は、Phase4の約定残（成約）から「必要な原料量」を可視化しつつ、5社それぞれが国内買付・輸入・自社養殖のどの手段でどれだけ原料を確保するかを、会社の入力に基づいて決定する純粋関数群である。

**重要な設計方針（実装指示の核）**: 必要原料量の集計は意思決定支援情報にとどまり、自動発注・自動調達は一切行わない。契約を取りすぎた会社が、原料高・供給不足に直面する余地をそのまま残す（安値契約→大量成約→原料調達の後工程リスクという、Phase4→Phase5の意図された接続）。

責務に含まれるもの:
- Phase4約定残からの必要原料量集計（会社×納期×商品区分）
- 国内原料買付計画の受付・Phase3ベトナム国内原料価格への希望量集計の接続・国内供給の5社への配分
- 輸入注文の受付・着地価格計算・原産国別供給上限の適用・輸送中パイプライン管理
- 自社養殖の池入れ・収穫（養殖強度・バイオセキュリティ・疾病圧力を反映）
- 原料ロット単位での在庫管理・FIFO消費・期限切れ処理

責務に含まれないもの（対象外・将来課題は§12）:
- 工場・加工・製品生産、原料を製品へ変換する処理
- 売上・原価・棚卸資産・買掛金・PL/BS/CF
- 借入・資金制約・支払不能
- 品質・顧客信頼の動的変化、養殖場の新規投資・能力増設
- AI会社の調達判断、プレイヤー画面・CLI、Redis・API・Vercel、Phase6以降

## 2. 既存の型・モジュールの再利用

- 数量: `HosoEqTons`（`core/units.ts`）に統一。
- 価格: `UsdPerHosoEqKg`（`core/units.ts`）に統一。ただし内訳・調整額（原産国別調整額等）はマイナス値もあり得るためプレーンnumberで保持する（Phase4の`priceAdjustmentUsdPerHosoEqKg`と同じ理由）。
- 会社ID: `CompanyId`（Phase4 `sales/types.ts`）をそのまま再利用。
- 産地: `CountryId`（Phase1 `market/types.ts`、`"EC"|"IN"|"ID"|"VN"`）をそのまま再利用。輸入原産国・国内/養殖の`originCountry="VN"`表現の両方に使う。
- Period: `PeriodV2`（`core/period.ts`）をそのまま再利用。
- Phase4の約定残型（`SalesContract`）をそのまま読み取り、必要原料量集計の入力とする（Phase4のコードは一切変更しない）。
- Phase1の`MarketQuarterResult`（`hosoPrices[country].price`・`.exportableSupply`、`vietnamDomestic.price`・`.supply`）、`MarketQuarterInput`（`vietnamDomestic.domesticProcurementIntent`）をそのまま読み書きする。Phase1/3の計算式自体は一切変更・再実装しない。
- Phase2/3のシナリオが持つ疾病圧力（`ScenarioTurnCountryVariables.diseasePressure`、`scenarioTurnInput.countries.VN.diseasePressure`）を、養殖の疾病計算へそのまま外部入力として渡す。新しいシナリオ判定・疾病発生ロジックは一切重複実装しない。

## 3. 必要原料量の集計（`requirements.ts`）

`summarizeRawMaterialRequirements(contracts)` は、Phase4の`SalesContract[]`のうち`status`が`fulfilled`・`cancelled`以外（open/partiallyFulfilled/overdue）の契約について、`outstandingQuantity`を会社×`dueDate`×`product`ごとに合計する。

この関数は読み取り専用であり、戻り値（`RawMaterialRequirementEntry[]`）は他のどの調達関数の入力にもならない。国内買付・輸入・養殖はすべて会社の入力（`DomesticPurchasePlanEntry`・`ImportOrderInput`・`AquacultureStockingPlanEntry`）のみで決まる。これにより、実装指示「必要量を自動調達しない」を型・関数構成のレベルで保証している。

## 4. 国内原料買付（`domesticPurchase.ts`）

### 4.1 希望量集計とPhase3への接続 — 「有効買付意向」による価格操作防止【Task E差分】

`aggregateDomesticPurchaseIntent(plans, referenceSupply, params)` は5社の`desiredQuantity`をそのまま単純合計しない。実際には買えない・調達できない希望量だけを申告して国内価格（延いては競合他社の取得原価）を際限なく押し上げる「抜け道」を防ぐため、各社ごとに`calculateEffectivePurchaseIntent`で信認上限を掛けた「有効買付意向」を算出してから合計する。

```
procurementCapacity(headcount)   = baselineCapacityTons + capacityMaxIncrementTons * headcount / (headcount + capacitySaturationHeadcount)
                                    （Phase4のprocessingCapacityと同じ逓減曲線）

effectivePurchaseIntent = min(
  desiredQuantity,
  procurementCapacity(procurementHeadcount),
  approvedPurchaseCap ?? Infinity,
  referenceSupply * maximumPriceInfluenceShare
)

aggregatedIntent = Σ effectivePurchaseIntent（5社分）
```

`referenceSupply`には、当期のベトナム国内原料の基準供給量（`MarketQuarterInput.vietnamDomestic.domesticRawSupply`等、収穫量ベースの外生値で価格計算の結果に依存しない）を渡す。これにより、ある会社が実際には買えない100万トン等の希望量を入力しても、その会社の有効買付意向は「調達処理能力」「承認済み買付枠」「基準供給量×最大価格影響シェア」のうち最小のものを超えられない（極端な例：調達人員0の会社はbaselineCapacityTonsのみが上限になる）。一方、5社全体の有効買付意向（信認された需要）が正当に増えれば`aggregatedIntent`もそのぶん増えるため、「全社の信認された需要増加ではPhase3の国内価格が適切に上昇する」関係は維持される。

`maximumPriceInfluenceShare`は、実配分の上限に使う`maximumBuyerShare`（§4.2）とは意図的に別係数にしている。実際に買える上限（配分cap）と、価格シグナルとして認める上限（意向cap）は将来別々に調整したい可能性があるための分離であり、現段階ではどちらも同じ暫定値（0.35）を置いている。

`applyDomesticPurchaseIntentOverride(marketInput, aggregatedIntent)` は、`MarketQuarterInput.vietnamDomestic.domesticProcurementIntent`だけを置き換えた新しい`MarketQuarterInput`を返す純粋関数（信認上限適用後の`aggregatedIntent`を渡す）。

会社行動がない場合（単体テスト等）はこの関数を呼ばなければ、Phase3（industryLab）が使用している暫定買付量（trailingAverage×仮置き比率、`industryLab/simulationRunner.ts`の`buildPreviousMarketContext`が算出）がそのまま残る。会社行動がある統合ゲームでは、呼び出し側がこの関数で実際の5社の有効買付意向合計へ置き換えてから`calculateMarketQuarter`（Phase1）へ渡す。**この置き換えの配線自体は本Phaseの対象外**（画面・APIの実装はPhase5に含まない）で、純粋関数として用意するところまでが本Phaseの範囲。

### 4.2 国内供給の配分（水位法）

処理順は実装指示のとおり: 各社買付計画 → 希望量集計 → Phase3国内原料価格（呼び出し側の責務） → `allocateDomesticPurchase`による5社への配分 → `createDomesticPurchaseLots`による在庫追加。

配分アルゴリズムはPhase4の`allocateMarketProduct`と同じ水位法（`rawMaterials/waterFill.ts`に切り出した独立実装。Phase4の内部非公開関数とは別実体だが、考え方は完全に同一の再利用）。

競争力ウェイトは、提示買付価格・調達カバレッジ・養殖業者との関係・支払信頼性の4要素からなる加重和（実装済み。提示価格だけで配分が決まる構造にはなっていない）:

```
weight = w.price * priceContribution
       + w.coverage * coverageScore
       + w.farmerRelationship * (farmerRelationship / 100)
       + w.paymentReliability * (paymentReliability / 100)

priceScore        = exp(purchasePriceSensitivity * (bidPrice - marketPrice) / marketPrice)
priceContribution = clamp(priceScore, minimumBuyerPriceCompetitiveness, maximumBuyerPriceCompetitiveness) / maximumBuyerPriceCompetitiveness

coverageScore    = procurementCoverageScore(procurementHeadcount)（0〜1の逓減曲線。Phase4のsalesCoverageScoreと同じ形）
farmerRelationship・paymentReliability は entry未指定時 neutralScore（50点）を使う
```

Phase4の価格競争力式と符号が逆（bidPriceがmarketPriceを上回るほど有利）だが、上限付き飽和型で「法外な高値提示による独占」を防ぐ構造はPhase4と同じ設計思想。既定の重み配分は`price=0.4, coverage=0.25, farmerRelationship=0.2, paymentReliability=0.15`（合計1.0、暫定値・要校正）。

個社配分上限【Task E差分でprocurementCapacityを追加】:
```
cap = min(
  desiredQuantity,
  procurementCapacity(procurementHeadcount),
  availableSupply * maximumBuyerShareFor(entry, params),
  entry.approvedPurchaseCap ?? Infinity
)
```
`procurementCapacity`（§4.1参照）を実配分の上限にも反映することで、調達人員がゼロ・少数の会社は希望量だけを大きくしても実配分量が増えない。`maximumBuyerShareFor()`は現段階では`params.domesticPurchase.maximumBuyerShare`を固定で返すのみだが、将来、養殖業者との関係・実績に応じて会社別に変化させる拡張ポイントとして独立した関数にしている（Phase4の`maximumSupplierShareFor`と対称。動的計算は未実装）。

配分の合計は`availableSupply`（Phase3の`VietnamDomesticResult.supply`）を超えない。5社の希望量合計が供給を下回る場合は残余が`unallocatedSupply`として残る（外部の競合参加者は存在しない。国内供給市場は5社だけが競う閉じた市場という前提）。

### 4.3 実際の買付単価・取得原価の下限【Task E差分】

実際の買付単価（提示価格）は会社の入力（`bidPrice = marketPrice + priceAdjustmentUsdPerHosoEqKg`）をそのまま使う。提示価格の入力検証（`minBidPriceRatioOfMarket`〜`maxBidPriceRatioOfMarket`、既定0.5〜2.0倍）により、市場価格を著しく外れる提示（市場価格の0.5倍未満・2.0倍超）は`RawMaterialsValidationError`で拒否する。

ただし、許容範囲内（市場価格の0.5〜1.0倍）の低い提示価格をそのままロットの取得原価にしてしまうと、「市場価格より安く自動的に原料を確保できる」ことになる。そこで`createDomesticPurchaseLots`が生成するロットの`unitCost`は、`bidPrice`をそのまま使うのではなく次の式で確定する。

```
unitCost = max(domesticMarketPrice, bidPrice)
```

高値を提示して優先的に確保した会社は、その提示価格をそのまま取得原価として保持する（後の市場価格変動で自動改定されない。Phase4の安値契約保持と対称）。一方、市場価格を下回る低い提示価格を入力しても、取得原価は市場価格そのものが下限になる。

## 5. 輸入原料（`imports.ts`）

### 5.1 着地価格

```
landedPrice = max(0, originPrice × (1 + dutyRatio) + freight + insuranceAndHandling + originCountryAdjustment)
```
`originPrice`はPhase1の`MarketQuarterResult.hosoPrices[originCountry].price`をそのまま使う（国際HOSO基準価格は変更しない）。`freight`・`insuranceAndHandling`・`originCountryAdjustment`（マイナス値も許容）・`dutyRatio`はすべて`RawMaterialsParameters.imports`に集約した設定可能な係数。`maxLandedPriceUsdPerHosoEqKg`が注文に指定され、算出した着地価格がそれを超える場合は`RawMaterialsValidationError`で注文自体を拒否する（注文条件不成立）。

### 5.2 輸送中パイプラインと到着処理

`createImportLots`が生成するロットは`status="inTransitImport"`で、発注時点では在庫に計上されない。`availableFromPeriod`（到着四半期 = `orderedPeriod` + `leadTimeTurns`回の`nextPeriod`適用、既定`standardLeadTimeTurns`）に到達するまで消費対象にならない。`receiveArrivedImports(lots, currentPeriod)`が到着済みロットを`status="available"`へ遷移させる。

### 5.3 原産国別供給上限と決定論的配分

5社の原産国別注文合計が`originExportableSupply[country] × importAvailableSupplyRatio`（Phase1の`exportableSupply`を流用し、設定可能な比率で「5社が調達可能な枠」を切り出す。既定10%）を超える場合、`rawMaterials/waterFill.ts`の水位法で決定論的に按分する（参加者=各社の注文、重み=cap=希望数量の比例配分）。この配分結果はPhase1の`exportableSupply`・`allocatedDemand`へ一切書き戻さないため、5社の輸入量は国際基準価格を直接変更しない。

## 6. 自社養殖（`aquaculture.ts`）

```
expectedProduction        = plannedStockingQuantity × (1 + intensityYieldBonusMax × aquacultureIntensity)
vulnerabilityMultiplier   = 1 + intensityDiseaseVulnerabilityMax × aquacultureIntensity
biosecurityMitigation     = bioSecurityMitigationMax × bioSecurityLevel
effectiveDiseaseImpact    = clamp(diseasePressure × vulnerabilityMultiplier × (1 - biosecurityMitigation), 0, 1)
survivalRatio             = max(minSurvivalRatio, 1 - effectiveDiseaseImpact)
actualHarvestQuantity     = expectedProduction × survivalRatio
```

単純で説明可能な線形式のみを使う（実装指示「計算式は単純で説明可能なものにし」）。高い養殖強度（`aquacultureIntensity`）は`expectedProduction`を増やすが、同時に`vulnerabilityMultiplier`も増やすため、疾病圧力が高い局面では損失が大きくなる（テストで確認済み。`aquaculture.test.ts`）。バイオセキュリティ水準は`effectiveDiseaseImpact`を最大`bioSecurityMitigationMax`（既定70%）まで緩和する。

池入れ計画は`aquacultureCapacity`を超えられない（`assertValidStockingPlan`が超過時に`RawMaterialsValidationError`）。標準では池入れの翌四半期（`nextPeriod`1回）に収穫する。疾病圧力はPhase2/3のシナリオ（`ScenarioTurnCountryVariables.diseasePressure`）から呼び出し側が読み取り、`harvestAquacultureLots`へそのまま渡す外部入力として扱う（新しいシナリオ判定は一切実装しない）。

`createGrowingLots`は池入れ時点で`status="growingAquaculture"`のロットを生成し、疾病計算に必要な`aquacultureIntensity`・`bioSecurityLevel`・`plannedStockingQuantity`をロット自身へ`pendingAquaculture*`フィールドとして保持する（四半期をまたいでも別途状態を持ち回す必要がないようにするための設計）。`harvestAquacultureLots`が収穫四半期到達時にこれらを読み、実際の収穫量を計算して`status="available"`へ確定させる。養殖投資・支出の会計処理は行わない（収穫量・取得原価はロットとして在庫へ追加するのみ）。

## 7. 原料在庫（`inventory.ts` / `inventoryIds.ts`）

原料は調達源（国内・輸入・養殖）を問わず同じ`RawMaterialLot`型・同じFIFO消費関数で管理する。次の5状態を区別する。

| status | 意味 |
|---|---|
| `available` | 使用可能在庫 |
| `inTransitImport` | 輸送中輸入原料（消費対象外） |
| `growingAquaculture` | 養殖中（消費対象外） |
| `consumed` | 消費済み（remainingQuantity=0） |
| `expired` | 期限切れ・廃棄（消費対象外） |

`consumeRawMaterials(lots, instructions)`はPhase6から渡される会社別消費指示を、`availableFromPeriod → inboundPeriod → lotId`の順（古い順）でFIFO適用する純粋関数。1社の消費可能合計（`status="available"`のロットの`remainingQuantity`合計）を超える指示は`RawMaterialsValidationError`（過剰消費拒否）。`originalQuantity`は常に不変で、`remainingQuantity`のみが減少するため、入庫・消費・廃棄を通じて数量が保存される。

`applyExpiryForQuarterEnd(lots, asOfPeriod)`は、`expiryPeriod`が設定されており、かつそれを過ぎた`available`ロットを`expired`へ遷移させる（`remainingQuantity`はそのまま保持。廃棄損の会計計上はPhase8）。`RawMaterialsParameters.inventory.defaultShelfLifeTurns`が未設定の場合、期限は一切設けない（既定は未設定）。

ロットIDは`inventoryIds.ts`の`buildLotId(source, companyId, period, originCountry, sequence)`で決定論的に生成する（`RM-{source}-{period}-{originCountry}-{companyId}-{sequence}`形式）。調達源をIDへ含めるため、国内・輸入・養殖のロットが衝突することはない。

## 8. 四半期ランナー（`runner.ts`）

Phase3・Phase4のランナーと同じ構造（`initializeX` / `advanceX` / 複数四半期テスト用ランナー）。

```
initializeRawMaterialsState(startPeriod) → RawMaterialsState（ロット・履歴なし）
advanceRawMaterialsQuarter(state, input, contracts) → RawMaterialsState
  // 必要量集計 → 国内買付配分 → 輸入注文作成 → 養殖池入れ →
  // 輸入到着処理 → 養殖収穫処理 → 期限切れ処理、までを1四半期分まとめて行う
runRawMaterialsQuartersForTesting(startPeriod, quarterInputs[]) → RawMaterialsState
  // 複数四半期を再現可能に実行するテスト用ランナー
```

FIFO消費（`consumeRawMaterials`）は`advanceRawMaterialsQuarter`から独立した別関数として提供する。Phase6が実際の生産・消費量を計算した後、呼び出し側が明示的に呼ぶ設計であり、`advanceRawMaterialsQuarter`自身が消費を行うことはない（Phase4の`applyFulfillments`と同じ設計思想）。

## 9. 暫定値・要校正の一覧

| 項目 | 扱い |
|---|---|
| `domesticPurchase.purchasePriceSensitivity`・`minimumBuyerPriceCompetitiveness`（0.5）・`maximumBuyerPriceCompetitiveness`（1.6） | 【暫定値・要校正】Phase4の価格競争力上下限と同じ考え方・同じ値をそのまま採用。ゲームバランス調整フェーズで再検討する前提 |
| `domesticPurchase.maximumBuyerShare`（0.35） | 【暫定値・要校正】実配分（allocateDomesticPurchase）のcapに使う最大買付シェア。Phase4の`maximumSupplierShare`と対称。固定ルールではなく、将来会社別（養殖業者との関係・実績）に変化させられる構造（`maximumBuyerShareFor()`）にしているが、動的計算自体は未実装 |
| `domesticPurchase.maximumPriceInfluenceShare`（0.35）【Task E新規】 | 【暫定値・要校正】有効買付意向（国内価格形成へ渡す値）の信認上限に使う最大価格影響シェア。`maximumBuyerShare`とは意図的に別係数（現段階では同値）。実際には買えない希望量だけで国内価格を操作する抜け道を防ぐ |
| `domesticPurchase.baselineCapacityTons`（150）・`capacityMaxIncrementTons`（3600）・`capacitySaturationHeadcount`（10）【Task E新規】 | 【暫定値・要校正】調達人員から調達処理能力（HOSO換算トン）を導出する逓減曲線係数。Phase4のsalesForce係数と同じ形の最小限の値 |
| `domesticPurchase.competitivenessWeights`（price=0.4, coverage=0.25, farmerRelationship=0.2, paymentReliability=0.15）・`coverageSaturationHeadcount`等 | 【暫定値・要校正】Phase4の営業人員係数と同じ形の逓減曲線・重み付けを踏襲した最小限の値 |
| `imports.freightUsdPerHosoEqKg`・`dutyRatio`・`insuranceHandlingUsdPerHosoEqKg`・`originCountryAdjustmentUsdPerHosoEqKg` | 【暫定値・要校正】着地価格の内訳係数。すべて0（原産国別調整額）または小さな固定値を仮置き |
| `imports.standardLeadTimeTurns`（2） | 【暫定値・要校正】発注から到着までの標準ターン数 |
| `imports.importAvailableSupplyRatio`（0.1） | 【暫定値・要校正】原産国のexportableSupplyのうち5社が輸入で調達可能な比率。国際基準価格へ影響させないための、Phase5固有の切り出し比率 |
| `aquaculture.intensityYieldBonusMax`（0.5）・`intensityDiseaseVulnerabilityMax`（0.8）・`bioSecurityMitigationMax`（0.7）・`minSurvivalRatio`（0.1） | 【暫定値・要校正】養殖強度・バイオセキュリティ・疾病影響の線形係数。「方向性」（強度↑で増産だが脆弱性も↑、バイオセキュリティ↑で緩和）を満たす最小限の値 |
| `aquaculture.aquacultureUnitCostUsdPerHosoEqKg`（3.2） | 【暫定値・要校正】養殖投資・支出の会計処理を行わないための簡易固定単位原価 |
| `inventory.defaultShelfLifeTurns`（未設定） | 【暫定値】原料の鮮度管理は簡略化しており、期限切れの経済的帰結（廃棄損の会計計上等）はPhase8で接続する前提 |

## 10. テスト

`app/lib/v2/rawMaterials/__tests__/`に6ファイル、合計65件のテストを追加した（既存353件と合わせて418件）。Task E差分（有効買付意向の信認上限・調達処理能力・取得原価下限）で`domesticPurchase.test.ts`に7件、`inventory.test.ts`に1件を追加した。

- `requirements.test.ts` — 会社×納期×商品区分ごとの集計、fulfilled/cancelledの除外、overdue/partiallyFulfilledの包含、副作用がないこと、決定論的なソート順。
- `domesticPurchase.test.ts` — 希望量集計、Phase3入力への不変更新での接続、全社合計が供給を超えないこと、個社上限（希望量・調達処理能力・最大買付シェア・承認済み買付枠）、入力順不変性、価格↔配分量トレードオフ、高値提示の飽和、価格検証エラー、重複計画エラー。**【Task E追加】** 有効買付意向が信認上限（調達処理能力・承認済み買付枠・基準供給量×最大価格影響シェア）を超えないこと、100万トン等の非現実的希望量でも価格操作に使える増加量が有界であること、調達人員ゼロの会社が大きな価格影響力を持てないこと、承認済み買付枠が有効買付意向にも適用されること、全社の信認された需要増加では有効買付意向合計が上昇すること、実配分量が調達処理能力を超えないこと。
- `imports.test.ts` — 着地価格の内訳計算、輸送中→到着の状態遷移、標準/カスタムリードタイム、最大許容着地価格による注文拒否、原産国別供給上限の決定論的配分、入力順不変性、国際基準価格への非影響、複数原産国の独立上限。
- `aquaculture.test.ts` — 養殖能力超過の拒否、強度による予定生産量増加、標準収穫四半期、疾病圧力による生残率低下、高強度養殖の疾病時損失拡大、バイオセキュリティによる緩和、収穫時期未到達時の非変化、収穫時の状態遷移・数量確定、会計フィールドの不在。
- `inventory.test.ts` — 初期化、国内配分からのロット生成、FIFO消費順序、部分/完全消費、過剰消費拒否、他社ロットの非対象、輸送中/養殖中ロットの消費対象外、数量保存、期限切れ処理、高値取得原価の保持、ロットIDの非重複。**【Task E追加】** 国内原料ロットの取得単価が市場価格を下回らないこと（低い提示価格でも市場価格が下限になること）。
- `runner.test.ts` — Phase3・Phase4の実出力を使った必要量集計の正確性、自動発注されないことの確認、5社×複数四半期の完走、再現性（同一入力→完全一致）、輸入/養殖の在庫化タイミング、金額フィールドの不在。

## 11. TypeScript・ESLint・ビルド

`npx tsc --noEmit`：0エラー。`npx eslint app/lib/v2 app/v2 scripts`：0エラー・0警告。`npm run build`：TypeScriptコンパイルは成功（"Finished TypeScript" まで到達）。ページデータ収集段階で既知の`/api/game/[gameCode]/admin/clone`（V1既存ルート、Redis環境変数`STAGING_KV_REST_API_URL`未設定）が失敗するのは、Phase1〜4から一貫して報告している既存の環境問題であり、今回のブロッカーとはしていない。

## 12. 未実装項目（対象外・将来課題）

- プレイヤー用調達入力画面（Phase5は純粋ロジックのみ）
- Redis・API Route・Vercel設定、`applyDomesticPurchaseIntentOverride`を実際にPhase1/3の呼び出しへ配線する統合コード（画面・APIの責務）
- 工場・加工・製品生産、原料を製品へ自動変換する処理（Phase6）
- 売上・原価・棚卸資産・買掛金・PL/BS/CF（未計上。廃棄損・高値取得原価の採算影響もPhase8へ接続する情報として保持するのみ）
- 借入・資金制約・支払不能
- 品質・顧客信頼の動的変化、養殖場の新規投資・能力増設
- `maximumBuyerShare`の会社別可変化（`maximumBuyerShareFor()`は拡張ポイントとして用意済みだが、動的計算自体は未実装）
- AI会社の調達判断・生成AI

## 13. 今後Phase6以降と接続する際の接点

- `consumeRawMaterials`は、Phase6が実際の生産投入量を計算した後、`RawMaterialConsumptionInstruction`（会社×数量）を渡すだけで接続できる。「原料が足りず契約通りに生産できない」という状況は、単に`quantity`を必要量より少なく渡す（＝在庫に残す）ことで自然に表現できる。
- `summarizeRawMaterialRequirements`の出力は、Phase6・プレイヤー画面がそのまま「今期あとどれだけ調達すべきか」の参考情報として表示できる（本モジュール自体はこの情報を使って何かを決定しない）。
- 高値契約・高値取得原価は、いずれもロット・契約に保持されたまま自動改定されないため、Phase8のPL/BS/CF実装時に「安値契約×原料高騰」の低採算がそのまま損益へ反映できる。
- `RawMaterialLot`の`status="expired"`一覧は、Phase8の廃棄損計上にそのまま使える形で保持している。

## 14. ターン・オーケストレーター（`app/lib/v2/turn/`）【Phase 5後続差分】

**背景（調査結果と方針転換）**: 当初の作業指示は「V2の実際のターン実行経路がある」ことを前提に、`applyDomesticPurchaseIntentOverride`をそこへ配線するというものだった。しかし調査の結果、**V2には本番ターン実行経路・意思決定保存スキーマ・APIルートが現時点で一切存在しない**ことが判明した（`calculateMarketQuarter`の唯一の呼び出し元は`industryLab/simulationRunner.ts`というPhase3の合成シナリオ・テスト環境であり、Phase4の販売モジュールも同様に本番配線を持たない。`app/api/`配下に`app/lib/v2/`をimportするファイルは1つも存在しない。`GameSessionV2`もPhase0のプレースホルダ型のままである）。この状態でPhase5だけを無理にV1のAPI/Redis/`CompanyDecision`型へ接続すると、V2の設計境界（永続化・API非依存の純粋ドメインモジュール群という一貫した設計）を崩しかねない。そのため、本番APIを新設する代わりに、**Phase1・Phase4・Phase5を接続する、永続化・API非依存の純粋なアプリケーション層**を新設する方針へ切り替えた。

**位置づけ**: `app/lib/v2/turn/`（`types.ts`・`runner.ts`・`index.ts`）は、Phase1〜5のそれぞれの「1四半期分だけを進める」ランナー（`calculateMarketQuarter`・`advanceSalesQuarter`・`advanceRawMaterialsQuarter`）を、決定論的な順序で束ねて呼び出す合成関数`runTurn(input): TurnOrchestratorResult`のみを提供する。Redis・API Route・UIには一切依存しない。**将来のV2 API実装は、この`runTurn`を呼び出すことを想定している**（意思決定の永続化・会社別提出状態の管理・冪等性キー等は、将来のAPI/Redis層の責務として本モジュールの外側に置く）。

**`industryLab/simulationRunner.ts`との役割の違い**: `simulationRunner.ts`はPhase3の「シナリオ駆動の合成テスト環境」であり、会社の実際の入力（販売計画・買付計画等）を一切扱わず、`ScenarioTurnInput`から機械的に導出した市場入力のみで`calculateMarketQuarter`を回す（Phase4・Phase5を呼び出さない）。対して`turn/runner.ts`の`runTurn`は、会社別の実際の計画（販売・国内買付・輸入・養殖）を入力として受け取り、Phase1・Phase4・Phase5を通しで実行する「ゲームの1ターン」を表す合成関数である。両者は独立しており、`runTurn`は`simulationRunner.ts`を呼び出さない（テストのフィクスチャ生成にのみ`runIndustrySimulation`を利用している）。

**入力・結果の型**（`types.ts`）:
- `TurnOrchestratorInput`: 当期`PeriodV2`、Phase1市場入力（`MarketQuarterInput`）、シナリオ変数（疾病圧力等、必要な値のみの最小限の型）、会社別販売計画、国内買付意向のソース（後述）、会社別輸入注文、会社別養殖池入れ計画、既存契約、既存原料ロット、決定論的乱数シード、各Phaseパラメータのオーバーライド。`GameSessionV2`へは埋め込まない。Phase0のプレースホルダ型は一切変更していない。
- `DomesticPurchaseIntentSource`（判別可能型）: `{ type: "phase3Fallback" }`（会社別買付計画が一切取得できない場合。`marketInput.vietnamDomestic.domesticProcurementIntent`をそのまま使う＝一切上書きしない）と`{ type: "companyPlans"; plans: DomesticPurchasePlanEntry[] }`（会社別買付計画から`aggregateDomesticPurchaseIntent`で集計した値を使う。計画を提出していない会社はこの配列に含まれない＝希望量ゼロと同義）の2択。**「未提出の会社（companyPlans内で該当companyIdの要素がない）」と「会社別データが一切ない（phase3Fallback）」は明確に別の型として扱い、暗黙の推測はしない**。
- `TurnOrchestratorResult`: 市場結果・販売記録・更新後契約一覧・必要原料量集計・国内買付配分結果・更新後ロット一覧・新規輸入ロット/到着輸入ロット/新規養殖ロット/収穫済みロット/期限切れロット・養殖収穫内訳（`AquacultureHarvestResult[]`）・次ターンへの`pendingState`（次期`PeriodV2`・契約・ロット）・監査用`debug`情報（会社別有効買付意向、集計買付意向、上書き前後の`domesticProcurementIntent`、清算後の国内価格・供給量、会社別配分量）。

**実行順序**（`runner.ts`）:
1. 各社の有効買付意向を算出（`calculateEffectivePurchaseIntent`。`companyPlans`モードのみ。`phase3Fallback`では空配列）
2. 有効買付意向を集計（`aggregateDomesticPurchaseIntent`）
3. `applyDomesticPurchaseIntentOverride`で市場入力へ上書き適用（`phase3Fallback`では上書きしない）
4. 決定論的乱数ストリーム（シード = `` `${seed}::${currentPeriod}` ``）で`calculateMarketQuarter`を実行
5. Phase4販売処理（`advanceSalesQuarter`）を実行し、当期契約を生成
6. Phase4が生成した当期契約を含む最新の約定残から、Phase5`summarizeRawMaterialRequirements`で必要原料量を集計
7. Phase5国内買付配分（`allocateDomesticPurchase`）を実行
8. 国内買付ロットを生成
9. 輸入注文・到着処理
10. 養殖池入れ・収穫処理
11. 期限切れ・在庫状態遷移処理
12. `TurnOrchestratorResult`として統合結果を返す

手順6〜11は、Phase5の`advanceRawMaterialsQuarter`（既存の四半期ランナー）へそのまま委譲している（手順7〜11の内部順序を`advanceRawMaterialsQuarter`が既に正しくエンコードしているため、二重実装・ロジックの乖離を避けた）。手順5（Phase4）を手順6（必要原料量集計）より先に置いているのは、**当期に新規成約した契約の未履行数量も、当期のうちに必要原料量として可視化するため**（Phase4の契約生成を後回しにすると、その四半期の新規契約分の必要量が1期遅れて見えることになり、「販売の裏付けとして必要な原料量を都度把握する」という設計意図とずれる）。

**`phase3Fallback` / `companyPlans`の切り替え**: `TurnOrchestratorInput.domesticPurchaseIntentSource`の判別可能型で明示的に選ぶ。`phase3Fallback`を選ぶと、`marketInput.vietnamDomestic.domesticProcurementIntent`（Phase3の暫定買付量、`trailingAverageDomesticPurchase × domesticProcurementIntentToTrailingAverageRatio`）がそのまま`calculateMarketQuarter`へ渡る（`applyDomesticPurchaseIntentOverride`を一切呼ばない）。`companyPlans`を選ぶと、渡された`plans`から`aggregateDomesticPurchaseIntent`で信認上限付きの集計値を算出し、上書きしてから`calculateMarketQuarter`へ渡す。

**国内買付意向→価格→配分→ロットのデータフロー**: `plans`（会社別`desiredQuantity`・`procurementHeadcount`・`approvedPurchaseCap`等）→（各社ごと）`calculateEffectivePurchaseIntent`で信認上限付きの有効買付意向→合計して`aggregateDomesticPurchaseIntent`→`applyDomesticPurchaseIntentOverride`で市場入力の`domesticProcurementIntent`を置換→`calculateMarketQuarter`が国内原料価格・供給量（`vietnamDomestic.price`/`.supply`）を清算→その価格・供給量を基準に`allocateDomesticPurchase`が会社別配分量を決定（提示価格・調達カバレッジ・関係スコア等の競争力ウェイトに基づく水位法配分、供給量を超えない）→`createDomesticPurchaseLots`が配分結果から国内買付ロットを生成（取得原価は`max(marketPrice, bidPrice)`で市場価格を下限とする）。

**決定論の担保**: `runTurn`は純粋関数であり、`Math.random()`・`Date.now()`・グローバル可変状態を一切使わない。乱数はすべて`createRandomStream(` `${seed}::${currentPeriod}` `)`（文字列シードのみに依存する`RandomStream`）経由で消費する。入力オブジェクト（`marketInput`・`existingContracts`・`existingLots`・`salesPlans`等）はいずれも不変更新（スプレッド）でのみ扱い、破壊的変更は一切行わない。同一`input`（同一`seed`・同一`currentPeriod`を含む）を渡せば常に同一の`TurnOrchestratorResult`を返す（`assert.deepEqual`によるテストで確認済み）。

**今回保証した重複防止と、永続化層の課題として残るもの**: `runTurn`自体は、渡された`existingContracts`/`existingLots`を土台に「この1ターン分の新規契約・新規ロットだけ」を追加した結果を返す。ターンを1つだけ進めるには、呼び出し側が**前回呼び出しの`pendingState`（`nextPeriod`/`contracts`/`lots`）だけ**を次の`currentPeriod`/`existingContracts`/`existingLots`として渡せばよい。同じ`input`を誤って2回呼び出しても、`runTurn`自身は同じ結果を返すだけで内部状態を進めない（副作用がないため、「同じターンの入力を再送すると契約・ロットが2重に増える」という事態はこの関数の外側、すなわち「同じ`TurnOrchestratorResult`を2回、状態へ反映してしまう」呼び出し側のミスでしか起こり得ない）。ロットIDは`buildLotId(source, companyId, period, originCountry, sequence)`（Phase5既存）に基づき、同一入力からは常に同一IDが決定論的に生成される。一方、**Redisの冪等性キー（同じAPIリクエストが再送されても二重反映しないための仕組み）・会社別の意思決定提出状態の管理・ターン進行のロック**は、いずれも将来の永続化・API層の責務として今回は実装していない（本モジュールが呼び出される前提でAPI層が設計されるべき、という設計指針を示すに留める）。

**未提出会社の扱い**: 国内買付計画を提出していない会社は`companyPlans`の`plans`配列に含めない（＝希望量ゼロと同義）。輸入計画・養殖計画を提出していない会社は、それぞれ`importOrders`/`aquacultureStockingPlans`に含めない（＝新規注文・新規池入れゼロ）。販売計画がない会社の扱いはPhase4の既存`advanceSalesQuarter`の仕様に従う。これらは、**会社別データが一切取得できない場合の`phase3Fallback`モード**とは明確に別の状態であり、`DomesticPurchaseIntentSource`の判別可能型がこの区別を型レベルで強制する。

**テスト**: `app/lib/v2/turn/__tests__/runner.test.ts`に18件のテストを追加した（既存418件と合わせて436件）。会社買付計画の国内価格への反映、`phase3Fallback`と直接呼び出しの一致、買付意向増加が国際価格へ波及しないこと、極端な希望量の頭打ち、取得原価の市場価格下限、供給量超過の禁止、個社上限の遵守、輸入のリードタイム、養殖の収穫タイミング、期限切れの翌ターン遷移、再現性、入力不変性、ターン間の計画非混入、Phase4→Phase5の必要量集計連携、`pendingState`の整合性、Phase1+4+5通しの複数ターン統合テスト（`companyPlans`・`phase3Fallback`の両モード）を確認している。

**`tsc`/ESLint/ビルド**: `npx tsc --noEmit`：0エラー。`npx eslint app/lib/v2 app/v2 scripts`：0エラー・0警告。`npm run build`：TypeScriptコンパイルは成功。ページデータ収集段階の既知の`/api/game/[gameCode]/admin/clone`エラー（§11参照）以外の新規エラーは発生していない。

**Phase5自身への副次的な変更**: `RawMaterialsQuarterRecord`（`rawMaterials/types.ts`）へ`harvestResults: readonly AquacultureHarvestResult[]`フィールドを追加した（`advanceRawMaterialsQuarter`が内部で捨てていた`harvestAquacultureLots`の詳細内訳を、そのまま記録として保持するようにした）。これは`TurnOrchestratorResult.aquacultureHarvestResults`（養殖処理結果の内訳）を、`advanceRawMaterialsQuarter`の重複実装なしにそのまま転記するための、Phase5自身への後方互換な加筆（既存フィールドの変更・削除なし）である。Phase1〜4・`GameSessionV2`プレースホルダ型には一切影響しない。

**対象外（今回のスコープ外）**: V2 APIルート、Redisスキーマ・キー設計、V2 UI、`GameSessionV2`の完全な状態モデル化、V1 APIへの接続、V1意思決定型（`CompanyDecision`等）の再利用、Phase6以降のロジック、`develop/v2`へのマージ・PR作成。

## 15. ターン状態遷移層（`app/lib/v2/turnState/`）【Phase 5.5】

**なぜ必要か**: `runTurn`（§14）は「1ターン分の入力→1ターン分の結果」だけを扱う純粋関数であり、「結果から次ターンの入力を組み立てる」責務を意図的に持たない（そこまで持たせると、Phase1〜5の計算ロジックと状態引き継ぎロジックが同じ関数に混在してしまう）。しかし、`runTurn`を繰り返し呼んでゲームを進行させるには、「`TurnOrchestratorResult`のうち何を次ターンへ引き継ぎ、何を引き継がないか」を毎回同じルールで機械的に決める層が必要になる。これを`runTurn`の外・将来のRedis/API層の内側に置くことで、Redis保存・V2 API・`GameSessionV2`・Replay（過去ターンの再生）・Save/Load（途中終了・再開）のすべてが**同じ状態遷移ロジックを共有**できるようにする。この層を固定しないまま複数の呼び出し元（API・Replay・テスト等）がそれぞれ独自に「次ターン入力の組み立て方」を実装すると、「Replayでは養殖ロットの引き継ぎ漏れがある」「Save/Loadでは契約のステータスが欠落する」といった実装間の食い違いが将来発生しうる。

**`runTurn`との責務分離**: `runTurn`はPhase1・4・5の計算そのもの（市場清算・成約配分・原料調達処理）を担い、`buildNextTurnInput`は計算を一切行わず、`TurnOrchestratorResult`の中身を「次ターンへ生きたまま持ち越すもの」と「毎ターン新規に決まるべきもの（提出計画等）」に仕分けるだけの、純粋なデータ変換関数である。`buildNextTurnInput`は`calculateMarketQuarter`・`advanceSalesQuarter`・`advanceRawMaterialsQuarter`のいずれも呼び出さない。

```
TurnOrchestratorInput（ターンN）
        │
        ▼
    runTurn(...)
        │
        ▼
TurnOrchestratorResult（ターンN）
        │
        ▼
buildNextTurnInput(previousInput, turnResult)
        │
        ▼
TurnOrchestratorInput（ターンN+1の骨格。marketInput本体・各種提出計画は
呼び出し側が上書きしてからrunTurnへ渡す）
```

**新設モジュール**: `app/lib/v2/turnState/`に`types.ts`・`builder.ts`・`index.ts`を作成した。

```
buildNextTurnInput(previousInput, turnResult) → TurnOrchestratorInput
  // turnResult.periodがpreviousInput.currentPeriodと一致しない場合は
  // TurnStateValidationErrorを投げる（組み合わせ誤りの検出）
```

**builderの責務**: `TurnOrchestratorResult`から`TurnOrchestratorInput`を組み立てる、それだけ。API呼び出し・Redis読み書き・UI描画・Phase1〜5の計算ロジックの再実行は一切行わない。`previousInput`・`turnResult`のいずれも変更しない（deep mutation禁止。テストで`JSON.stringify`による不変性を確認済み）。

**次ターンへ引き継ぐ情報一覧**:
- **Period**: `turnResult.pendingState.nextPeriod`（Phase5の`advanceRawMaterialsQuarter`が`core/period.ts`の`nextPeriod()`で既に算出済みの値をそのまま使う。本層で独自にperiod計算をやり直さない）。
- **販売契約（約定残）**: `turnResult.pendingState.contracts`を`existingContracts`へそのまま引き継ぐ。更新済み契約・未履行の契約残（open/partiallyFulfilled）・overdueをすべて含む、Phase4自身が管理する約定残の状態そのもの。ステータスによる取捨選択は行わない（fulfilled/cancelledも含め丸ごと引き継ぐ。理由は下記「今回の設計判断」参照）。
- **原料ロット**: `turnResult.pendingState.lots`のうち、`status`が`"available"`・`"inTransitImport"`・`"growingAquaculture"`のものだけを`existingLots`へ引き継ぐ。

**次ターンへ引き継がない情報一覧（意図的に空へ初期化）**:
- `salesPlans`（空配列） — 販売計画は毎ターン会社が新規提出するもの。
- `domesticPurchaseIntentSource`（`{ type: "companyPlans", plans: [] }`） — 国内買付計画も毎ターン提出制。「今のところ誰も提出していない」状態で初期化する（`phase3Fallback`へは切り替えない。理由は下記）。
- `importOrders`（空配列） — 輸入注文も毎ターン提出制。
- `aquacultureStockingPlans`（空配列） — 養殖池入れ計画も毎ターン提出制。
- `scenarioVariables`（`undefined`） — 次期の疾病圧力等のシナリオ由来値。`runTurn`側の既定値（疾病なし）にフォールバックする。
- `debug`（`TurnOrchestratorInput`にそもそもフィールドが存在しない） — 監査用の中間集計値であり、次ターンの入力には一切含まれない。

**引き継がれるが、呼び出し側が明示的に上書きする必要があるもの**: `marketInput`（次期の市場入力本体。`period`フィールドだけは`nextPeriod`に機械的に合わせておくが、収穫量・需要成長率等の中身は前ターンの結果からは決まらない外生値であり、本層は生成しない）。`seed`・`parameters`は`previousInput`の値をそのまま踏襲する（ゲーム全体を通じて変えない想定の値のため）。

**今回の設計判断（契約を全ステータスのまま引き継ぐ理由）**: 指示にある「更新済契約・契約残・overdueを引き継ぐ」を、契約配列を「生きている契約だけに絞り込む」という意味ではなく、「Phase4自身が管理する約定残の状態（ステータスがopen/partiallyFulfilled/overdue/fulfilled/cancelledのいずれであっても）をそのまま次ターンへ渡す」という意味で実装した。fulfilled/cancelledの契約を本層が独自に除外すると、Phase4の約定残管理（`updateContractStatusesForQuarterEnd`等）と二重管理になり、どちらが正であるかが曖昧になるため、フィルタは一切行わない。

**今回の設計判断（`domesticPurchaseIntentSource`を`companyPlans`（空plans）にリセットする理由）**: 「引き継がない＝毎ターン提出制」という点では`salesPlans`・`importOrders`・`aquacultureStockingPlans`と同じ扱いにすべきと判断し、`phase3Fallback`（会社別データが一切ない場合の別モード）へ切り替えるのではなく、`companyPlans`モードのまま`plans`を空にする（＝今のところ誰も提出していない、として扱う）ことで、4つの「会社別提出計画」系フィールドの扱いを統一した。

**原料ロットを`available`/`inTransitImport`/`growingAquaculture`だけに絞る理由（consumed/expiredを引き継がない）**: Phase5の`advanceRawMaterialsQuarter`自身は、`consumed`・`expired`になったロットも履歴として配列に保持し続ける設計だが（§8参照）、次ターンの「生きている在庫」としてはもはや意味を持たない（消費済み・廃棄済みのロットが再びavailableとして扱われることは物理的にありえない）。本層はこれらを次ターン入力から除外することで、①誤って復活する余地を完全に無くし、②`existingLots`がターンを重ねるごとに無限に肥大化することを防ぐ。除外されたロットの記録自体は、各ターンの`TurnOrchestratorResult.expiredLots`等に残るため失われない。

**`pendingState`の扱い**: `runTurn`が既に返している`TurnOrchestratorResult.pendingState`（`nextPeriod`/`contracts`/`lots`）を、`buildNextTurnInput`が読み取る唯一の入力源とした。`pendingState.contracts`・`pendingState.lots`は`turnResult.contracts`・`turnResult.lots`と同じ値（`runTurn`内部で同一の変数を代入しているため）であり、`buildNextTurnInput`は`pendingState`経由でのみアクセスする（`turnResult.contracts`/`turnResult.lots`を直接読まない）ことで、「次ターンへの引き継ぎ専用の窓口は`pendingState`である」という規約を型・実装の両方で明確にしている。型自体の変更は不要だった（既存の`TurnOrchestratorPendingState`をそのまま利用）。

**Replayとの関係**: 過去のゲームを最初から再生する（Replay）場合、各ターンの`TurnOrchestratorInput`の「毎ターン提出される部分」（`marketInput`・`salesPlans`・`domesticPurchaseIntentSource`・`importOrders`・`aquacultureStockingPlans`・`scenarioVariables`）さえ保存されていれば、`buildNextTurnInput`が「引き継ぐ部分」（Period・契約・在庫）を毎回同じルールで機械的に再構成するため、Replayエンジンは「保存された提出データ＋前ターンの`runTurn`結果」だけを追いかければよく、独自の状態引き継ぎロジックを別途実装する必要がない。

**Save/Loadとの関係**: 途中セーブは「ある時点の`TurnOrchestratorResult`（または`pendingState`）を保存する」ことに相当し、ロードは「保存された`pendingState`を土台に`buildNextTurnInput`相当の処理で次ターン入力の骨格を作り、そこへ実際の次ターンの提出データを重ねてから`runTurn`を呼ぶ」ことに相当する。`buildNextTurnInput`がこの変換を1箇所に集約しているため、Save/Loadの実装（将来のRedis層）は「何を保存すべきか」を`TurnOrchestratorPendingState`の3フィールドだけに絞り込める。

**永続化との責務分離**: `buildNextTurnInput`はメモリ上のオブジェクト変換のみを行い、Redisへの読み書き・JSON直列化・APIレスポンスの整形は一切行わない。「次ターン入力の骨格をどう組み立てるか」（本層）と「その骨格・提出データをどこにどう保存するか」（将来のRedis/API層）は完全に別の関心事として分離されている。

**決定論**: `buildNextTurnInput`自体は乱数・時刻を一切使わない純粋なデータ変換であり、`runTurn`が担保する決定論（`createRandomStream(` `${seed}::${currentPeriod}` `)`のみに依存する乱数消費）をそのまま素通しする。`runTurn → buildNextTurnInput → runTurn`を同一`seed`で2回実行すると、1ターン目・2ターン目とも完全に同一の結果になることをテストで確認した。異なる`seed`では、乱数に依存する国際HOSO価格のショックにのみ差異が生じ、会社別計画から決定論的に導かれる国内配分の会社一覧等は変わらないことも確認した。

**テスト**: `app/lib/v2/turnState/__tests__/builder.test.ts`に15件のテストを追加した（既存436件と合わせて451件）。Periodの前進、契約の引き継ぎ、available/inTransitImport/growingAquacultureロットの保持、consumed/expiredロットの非引き継ぎ（復活しないこと）、販売計画・国内買付計画・輸入計画・養殖計画の非コピー、debug情報の非引き継ぎ、builderの入力不変性、`runTurn→buildNextTurnInput→runTurn`の2ターン統合テスト、同一seedでの再現性、異なるseedでの差異範囲、`previousInput`と`turnResult`の組み合わせ誤り検出（`TurnStateValidationError`）を確認している。

**`tsc`/ESLint/ビルド**: `npx tsc --noEmit`：0エラー。`npx eslint app/lib/v2 app/v2 scripts`：0エラー・0警告。`npm run build`：TypeScriptコンパイルは成功。ページデータ収集段階の既知の`/api/game/[gameCode]/admin/clone`エラー（§11参照）以外の新規エラーは発生していない。

**対象外（今回のスコープ外）**: V2 APIルート、Redis、`GameSessionV2`の全面改修、V2 UI、Phase6以降のロジック、`develop/v2`へのマージ・PR作成。
