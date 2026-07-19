# ShrimpX V2 — 品質・顧客信頼・納期信頼性（Phase 7A） アーキテクチャ v0.1

## 0. 本モジュールの位置づけ

`app/lib/v2/quality/` は、Phase6（`production/`、工場・ワーカー・生産・完成品在庫・契約履行）が出力する操業負荷指標（`production/loadMetrics.ts`）と契約履行実績から、次の6項目をターンをまたいで蓄積する、UI・Redis・生成AIから完全に独立した純粋関数群である。

1. 商品別品質（会社×商品）
2. 市場別顧客信頼（会社×市場）
3. 市場別納期信頼性（会社×市場）
4. 無理な増産による品質悪化（会社×工場×商品の増産履歴）
5. 低頻度の重大品質事故（市場価格等とは独立した乱数ストリーム）
6. 次四半期の販売競争力への反映（`sales/types.ts`の既存フィールドへの接続）

対象外（本Phaseでは扱わない）: Phase 7Bの本格UI・グラフ、品質管理設備投資、QA人員の独立意思決定、再加工費・廃棄損・格落ち値引きの財務計上、リコール・訴訟・認証停止、独立したブランド価値、Phase 8財務三表、Phase 9 AI会社、生成AIによる説明文、Redis/API実配線、世界需給・5社シェアの再校正、V1/Vercelの既知課題の修正。

**数量設計（Phase 6.1/6.3から継続、変更しない）**: 頭・殻の除去はHOSO換算数量を減らさない。通常時の`saleableRecoveryRatio`は1.00。品質問題による規格外・破損・廃棄だけが販売可能数量を減らす。物理重量換算は経営数量・契約数量・在庫数量には一切使わない。本モジュールが算出する`saleableRecoveryRatio`は、Phase6の通常操業基準1.00に対する「当期の品質による追加的な廃棄」だけを表し、`production/parameters.ts`の`physicalYieldRatio`（頭・殻等の物理歩留まり）の意味・値は一切変更しない。

## 1. 調査した既存データと再利用箇所

実装前に次を調査し、すべて既存の公開関数・型をそのまま再利用した（重複実装なし）。

- **`production/loadMetrics.ts`（`FactoryLoadMetrics`）**: 設備稼働率・労働稼働率・残業率・臨時ワーカー比率・商品構成複雑度（`productMixComplexity`）・消費原料の平均経過期間（`averageRawMaterialAgeQuarters`）が、Phase6ですでに工場×四半期単位で算出済みだった。操業リスクの入力はすべてこれをそのまま使う。
- **`production/capacity.ts`（`calculateFactoryEffectiveCapacity`）**: 急増産ストレスの分母フォールバック（`0.25 * productCapacity`）に使う商品別有効設備能力の算出に、そのまま再利用した。
- **`production/batches.ts`／`production/finishedGoods.ts`／`production/fulfillment.ts`の公開関数**（`createFinishedGoodsLots`・`planContractFulfillment`・`applyFinishedGoodsExpiryForQuarterEnd`）: いずれも書き換えず、品質調整後のバッチ配列に対して**再度呼び出す**アダプター方式を採用した（§2参照）。
- **`sales/types.ts`の`CompanySalesPlanEntry.customerRelationship`／`qualityReputation`／`deliveryReliability`**、および`sales/allocation.ts`の`computeCompetitivenessWeight`: Phase4時点ですでに「将来Phase7で実データに置き換える想定」として型・配線が用意されていた。本Phaseはこの3フィールドへ値を渡すだけで、`sales/allocation.ts`自体は一切変更していない。
- **`companyLab/fixtures.ts`**: 5社のフィクスチャに品質能力・顧客関係・納期信頼性に相当する既存値がないかを確認したが、**該当する値は存在しなかった**（調達・生産・価格方針の係数のみ）。そのため初期値はすべて中立的な暫定値を採用した（§9参照）。
- **`companyLab`の永続化**: `companyLab`自体はいかなる永続化層にも接続されていない（`LabBanner.tsx`等の既存コメント「Redis保存なし・ブラウザ内のみの決定論的計算」で確認）。永続化layerが実在するのは無印`/v2`ゲーム用の`PersistedGameStateV2`（`app/lib/v2/persistence/`）のみ（§10で詳述）。
- **`core/random.ts`（`createRandomStream`）**: シード文字列から独立したミュータブルストリームを生成する既存実装をそのまま利用。重大事故用の乱数分離（§5）は、この「シードごとに完全に独立したインスタンス」という既存の性質だけで構造的に満たされる。

## 2. 追加した状態型と粒度（三宅さん指定、固定）

`app/lib/v2/quality/types.ts`に定義。

| 状態 | 粒度 | 型 |
|---|---|---|
| 品質 | 会社×商品 | `CompanyProductQualityState { companyId, product, qualityScore: Score0to100 }` |
| 顧客信頼・納期信頼性 | 会社×市場 | `CompanyMarketTrustState { companyId, market, customerTrustScore: Score0to100, deliveryReliabilityScore: Score0to100 }` |
| 増産履歴 | 会社×工場×商品 | `CompanyFactoryProductRampState { companyId, factoryId, product, lastQuarterProductionQuantity: HosoEqTons }` |

3つを束ねた`QualityReliabilityState { qualityByCompanyProduct[], trustByCompanyMarket[], rampHistory[] }`が、`CompanyLabState.qualityState`としてターンをまたいで保持される唯一の新規蓄積状態である。既存状態から安全に導出できる履歴（例: 過去の観測品質そのもの）は重複保存していない——増産履歴は「前四半期の実生産量」1個のスカラーだけを保持し、それ以前の履歴は保持しない（急増産ストレスの計算に必要なのは直前四半期の値だけであるため）。すべてのスコアは既存の`Score0to100`（`core/units.ts`）を使い、常に[0,100]にクランプされる。

## 3. ターン内の正確な処理順（`companyLab/runner.ts`の`advanceCompanyLabQuarter`内）

1. Phase6の既存処理で、品質調整前の生産バッチ（`saleableRecoveryRatio=1.00`基準）を得る（`advanceProductionQuarter`、変更なし）。
2. `applyQualityToBatches`（新規）: 工場別操業負荷指標（`FactoryLoadMetrics`）・前四半期実績（`rampHistory`）・独立乱数シードから、バッチごとに操業リスク→品質結果→数量調整を1回だけ適用する。`finishedGoodsQuantity`を減らし`processingLoss`へ同量を足すだけで、`rawMaterialConsumedTotal`は一切変更しない。
3. `createFinishedGoodsLots`（Phase6既存、**再呼び出し**）を品質調整後のバッチへ適用し、完成品ロットを生成する。
4. `attachQualityInfoToFinishedGoodsLots`（新規）: 生成されたロットへ、対応するバッチの品質調整結果から`qualityInfo`（品質スコア・格落ち率・重大事故ID・生産四半期）を位置対応で付与する。
5. `planContractFulfillment`・`applyFinishedGoodsExpiryForQuarterEnd`（Phase6既存、**再呼び出し**）を品質情報付きロットへ適用し、契約充当計画・在庫期限処理をやり直す。
6. `applyFulfillments`・`updateContractStatusesForQuarterEnd`（Phase4既存）を、やり直した充当計画で適用する。
7. `computeMarketDeliveryObservations`（新規）: 履行後の契約状態から、会社×市場の当期納期観測を集計する。
8. `computeMarketTrustObservations`（新規）: 当期の履行実績（`FinishedGoodsUsageRecord`）と、ロットの`qualityInfo`・上記納期観測から、会社×市場の顧客信頼観測を組み立てる。
9. `updateQualityByCompanyProduct`・`updateTrustByCompanyMarket`（新規）: 前四半期末の`QualityReliabilityState`へ、当期観測を非対称alphaで反映し、`qualityStateAfter`を作る。
10. `buildCompanyQualitySummary`（新規、`companyLab/qualitySummary.ts`）: 当期の`CompanyQuarterSummary`へ品質・信頼・納期関連フィールドを追加する。
11. 次ターンの`CompanyLabState.qualityState`として`qualityStateAfter`を返す。

**重要**: 当期の意思決定（販売計画）を組み立てる`buildCompanyOwnState(state, fixture)`は、`advanceCompanyLabQuarter`が上記10で`qualityStateAfter`を計算する**前**に、常に「まだ更新されていない`state.qualityState`」（＝前四半期末時点の状態）を参照する。この呼び出し順序だけで、「今期の品質結果を今期の成約へ遡及適用しない」という要件を特別な分岐なしに満たしている（`runner.ts`該当箇所にコメントで明記済み）。

## 4. 操業リスクの計算式（`operationalRisk.ts`）

```
utilizationStress        = clamp((max(equipUtil, laborUtil) - 0.80) / 0.20, 0, 1) ^ 2
overtimeStress            = clamp(actualOvertimeRatio / allowedOvertimeRatio, 0, 1)
temporaryWorkerStress     = clamp(temporaryWorkerRatio, 0, 1)
complexityStress          = clamp(productMixComplexity, 0, 1)   // 既存FactoryLoadMetricsの値をそのまま使用
rawMaterialAgeStress      = clamp(weightedAverageAgeQuarters / usableShelfLifeQuarters(=4), 0, 1)  // データがなければ0
productionRampStress      = clamp((currentProduction - previousActualProduction) / max(previousActualProduction, 0.25 * productCapacity), 0, 1)
                            // previousActualProductionがundefinedまたは0以下なら常に0（初回ターン）
operationalRisk = clamp(0.35*utilization + 0.20*overtime + 0.15*temporaryWorker
                        + 0.10*complexity + 0.10*rawMaterialAge + 0.10*productionRamp, 0, 1)
```

設備稼働ストレスは設備・労働のうち大きい方（`max(equipmentUtilizationRate, laborUtilizationRate)`）を使う。複雑度は既存`productMixComplexity`をそのまま使う（すでにPhase6側で同時扱い商品区分数から決定論的に算出済みのため、本モジュールでの再算出は行っていない）。すべての係数は`quality/parameters.ts`の`QUALITY_PARAMETERS_V1`に集約（§9）。

## 5. 品質不適合・格落ち・再加工・廃棄の扱いと数量保存（`qualityOutcome.ts`・`batchAdjustment.ts`）

```
nonConformanceRatio = 0.08 * operationalRisk ^ 1.5          // maximumNonConformanceRatio, 指数とも要校正
downgradeRatio = nonConformanceRatio * 0.45
reworkRatio    = nonConformanceRatio * 0.25
discardRatio   = nonConformanceRatio * 0.30 + majorIncidentDiscardRatio
saleableRecoveryRatio = clamp(1 - discardRatio, 0.90, 1)
```

格落ち（downgrade）・再加工（rework）はPhase 7Aでは`finishedGoodsQuantity`を一切減らさない——`downgradeRatio`・`reworkRatio`は記録用（観測品質スコア算出・CLI/サマリー表示）にのみ使われ、数量へは反映しない。**廃棄（discard）だけが真の数量損失**であり、`saleableRecoveryRatio`を通じてバッチの`finishedGoodsQuantity`から差し引かれる。

数量保存の検証（`batchAdjustment.ts`の実装、テストで確認済み）: 品質調整前のバッチが持つ`rawMaterialConsumedTotal`は一切変更しない。調整後バッチは`finishedGoodsQuantity`を`original * saleableRecoveryRatio`（HOSO換算トンへ丸め）へ置き換え、その差分（`discardQuantity`）をそのまま`processingLoss`へ加算する。したがって

```
調整前: rawMaterialConsumedTotal = originalFinishedGoodsQuantity + originalProcessingLoss
調整後: rawMaterialConsumedTotal = adjustedFinishedGoodsQuantity + adjustedProcessingLoss
       (adjustedProcessingLoss = originalProcessingLoss + discardQuantity)
```

が常に成立し、「原料消費 = 完成品 + 加工損失」という既存の数量保存則をPhase6と同じ形のまま維持する（物理歩留まりの二重適用も行わない）。無負荷（`operationalRisk=0`）・重大事故なしでは`saleableRecoveryRatio=1.00`が厳密に維持される。

## 6. 重大事故の確率式・重大度・シードの導出方式（`majorIncident.ts`）

```
majorIncidentProbability = clamp(0.002 + 0.08 * operationalRisk^2, 0, 0.10)
```

事故発生時の重大度は独立した決定論的乱数から0〜1で算出し、追加廃棄率（`severity * 0.5`）・観測品質スコア減点（`severity * 40`）・顧客信頼へのペナルティ（`severity * 25`）へ反映する（換算係数はすべて要校正、§9）。

**乱数シード**: `{gameSeed}::quality::turn{turn}::company{companyId}::factory{factoryId}::product{product}`。市場価格用のシード（`${seed}::${period}`形式）やシナリオイベント用のシードとは`::quality::`という専用の名前空間で完全に分離されている。会社×工場×商品の組み合わせごとに`createRandomStream(seed)`で**都度新しいストリームインスタンス**を生成するため、

- 同じシード・同じ意思決定なら事故結果まで完全一致する（同じ入力→同じシード文字列→同じストリーム）。
- 会社・工場・商品の入力順を変えても結果が変わらない（各組み合わせが他の組み合わせの乱数消費と一切共有状態を持たない）。
- 品質乱数の追加によって、既存の国際価格・シナリオイベント乱数系列は一切変わらない（異なる名前空間のシード文字列から生成される、完全に別のストリームインスタンスであるため）。

の3点が構造的に保証される（`quality/__tests__/majorIncident.test.ts`でテスト、シード探索ではなく`probability=0/1`の境界値直接テストを中心に構成）。1回の判定につき「発生判定（`chance`）」「重大度（`next`）」を必ずこの順で2回消費し、発生しなかった場合でも重大度用の乱数は消費する（消費順序を結果に依存させないため）。

## 7. 品質・納期信頼性・顧客信頼の更新式（`qualityOutcome.ts`・`scoreUpdates.ts`）

**四半期品質スコア**:
```
observedQualityScore = clamp(baselineOperationalQuality - 30*operationalRisk - severity*40(事故時), 0, 100)
```
`baselineOperationalQuality`は既存フィクスチャに品質能力の値がなかったため、全社共通の中立的な暫定値85を採用（§1・§9）。

**品質状態更新**（会社×商品、当期複数工場ぶんを数量加重平均してから適用）:
```
alpha = (observed < previous) ? 0.20 : 0.08
nextQualityScore = previous + alpha * (observed - previous)
```
生産実績がない商品（当期`operationalRisk`計算対象外）はスコアを変化させない。

**納期信頼性**（会社×市場）: 当期dueDate=当期の契約だけを評価対象コホート（`dueQuantity`）とし、
```
observedOnTimeScore = 100 * onTimeQuantity / dueQuantity - continuingOverduePenalty
continuingOverduePenalty = min(8, 10 * continuingOverdueQuantity / dueQuantity)   // 要校正
alpha = 悪化時0.25 / 改善時0.08
```
過年度からの持ち越し未履行（`dueDate < 当期 && status="overdue"`）は`continuingOverdueQuantity`として別集計し、毎期の`dueQuantity`コホートには二重計上しない——小さく上限付きの追加ペナルティのみに使う。当期に評価対象となる納期数量（`dueQuantity`）がない市場は据え置く。

**顧客信頼**（会社×市場）:
```
customerExperienceScore = 0.50*deliveredQualityScore + 0.50*observedDeliveryScore - severity*25(事故時)
alpha = 悪化時0.18 / 改善時0.06
```
対象市場に当期の履行実績がない場合は据え置く。顧客信頼のalpha（0.18/0.06）は品質（0.20/0.08）・納期信頼性（0.25/0.08）のいずれよりも小さく、「品質・納期よりも回復（および悪化）が遅い」という設計を係数の大小関係で表現している。

重大事故の影響市場は、`FinishedGoodsUsageRecord.lotId`→`FinishedGoodsLot.qualityInfo`のトレーサビリティにより、**事故対象ロットを実際に受領した市場だけへ正確に**反映される。既存のロット・履行追跡構造でこの追跡が可能だったため、実装指示が許容していた「追跡できない場合の全市場への限定的フォールバック」は使用していない。

## 8. 販売配分への接続方法（`companyLab/autoPolicy.ts`）

```
qualityScore         = 会社×商品の蓄積品質（state.qualityState.qualityByCompanyProduct）
relationshipScore     = 会社×市場の顧客信頼（state.qualityState.trustByCompanyMarket.customerTrustScore）
deliveryReliabilityScore = 会社×市場の納期信頼性（同.deliveryReliabilityScore）
```

`buildSalesPlans`（`autoPolicy.ts`）が、`buildCompanyOwnState`経由で受け取ったこれらの値を、`sales/types.ts`の`CompanySalesPlanEntry.qualityReputation`／`customerRelationship`／`deliveryReliability`へそのまま渡す。**`sales/allocation.ts`の`computeCompetitivenessWeight`・水位法配分ロジック自体は一切変更していない**——Phase4時点ですでに用意されていた既存の接続点へ値を渡すだけの配線である。

価格競争力（`priceContribution`）は`sales/parameters.ts`の`minimumPriceCompetitiveness`(0.5)〜`maximumPriceCompetitiveness`(1.6)で既にクランプされているため、極端な安値でも品質・顧客関係・納期信頼性の重み（合計0.15+0.15+0.1=0.40、価格0.35・カバレッジ0.25と並ぶ比重）を無限に打ち消すことはできない（Phase 6.3の最低受注プレミアムと価格競争力上下限は本Phaseで一切変更していない）。5社構成で品質・信頼・納期が高い会社ほど成約量が多くなることをテストで確認済み（§11・テスト21・22）。

「前四半期末までの状態を使う」制約は、§3で述べた呼び出し順序のみによって満たされ、追加の特別な分岐は実装していない。

## 9. 永続化schemaと後方互換（`persistence/`）

**§1の調査結果、および仕様との対応関係（重要な既存アーキテクチャ上の制約、報告事項）**: `companyLab`自体はいかなる永続化層（Redis・API・`PersistedGameStateV2`のいずれ）にも接続されていない。永続化状態を持つのは無印`/v2`ゲーム（`app/lib/v2/turn`・`turnState`が扱う`PersistedGameStateV2`）だけであり、この無印ゲームの`runTurn`はPhase 7Aの品質ロジックを一切呼び出さない。

この状況で「永続化schemaをv3へ上げる」という指示を満たすため、次の方針を採用した（矛盾点として報告し、三宅さんの判断を仰ぐ）:

- `PersistedGameStateV2`（`persistence/types.ts`）へ、`quality/types.ts`の`QualityReliabilityState`をそのまま再利用した`qualityReliability`フィールドを追加し、`CURRENT_PERSISTED_GAME_STATE_VERSION`を3へ上げた。
- v1/v2データ（`qualityReliability`キー自体が存在しない）を読む際は、`qualityByCompanyProduct`/`trustByCompanyMarket`/`rampHistory`すべて空配列の安全な初期値を補う（宣言された`schemaVersion`の値に関わらず、キーの有無だけで判定する）。
- `costSnapshot`（schemaVersion 2）は無変更のまま維持される。
- 不正なスコア（範囲外・NaN・Infinity）・不正な比率・負の数量はすべて`PersistedStateValidationError`として拒否する（`score0to100`・`hosoEqTons`の既存スマートコンストラクタを経由、`as`キャストのみでの復元はしていない）。
- v3のencode/decode往復一致・v1/v2後方互換・不正値拒否を、`persistence/__tests__/persistence.test.ts`へ7件追加（テスト43〜49）して確認済み。

ただし、**この`qualityReliability`フィールドへ実際に非空の値が書き込まれることは現時点ではない**（無印`/v2`ゲームが品質ロジックを呼ばないため）。companyLabの計算結果をこの永続化状態へ実際に書き込む配線は、実装指示の明示的な対象外（「Redis/API実配線」）にあたるため本Phaseでは行っていない。Phase 7Bまたはそれ以降で、companyLabをRedis等へ接続する際に、①companyLab専用の永続化状態を新設するか、②本フィールドをcompanyLab用に転用するかを判断する必要がある——これは将来課題として報告する（ブロッカーではない）。

## 10. 暫定係数（すべて`quality/parameters.ts`の`QUALITY_PARAMETERS_V1`に集約、要校正）

三宅さんの実装指示に明示された数値（utilizationThreshold=0.80・band=0.20・exponent=2、操業リスクの重み、`maximumNonConformanceRatio`=0.08、downgrade/rework/discard按分（0.45/0.25/0.30）、`minimumSaleableRecoveryRatio`=0.90、重大事故の各確率係数、品質/納期/顧客信頼の更新alpha）はそのまま採用した。指示に具体的な数値がなかった箇所は次の暫定値を置いた（すべて「事故一発で会社が再起不能にならない」設計方針を満たす範囲での仮置き）。

| 係数 | 暫定値 | 用途 |
|---|---|---|
| `rawMaterialUsableShelfLifeQuarters` | 4 | 原料経過期間ストレスの分母 |
| `qualityRiskPenaltyPerUnitRisk` | 30 | `observedQualityScore`のリスク減点係数 |
| `severityToAdditionalDiscardRatio` | 0.5 | 重大度→追加廃棄率 |
| `severityToQualityPenalty` | 40 | 重大度→品質減点 |
| `severityToTrustPenalty` | 25 | 重大度→顧客信頼減点 |
| `continuingOverduePenaltyPerRatio` / `Cap` | 10 / 8 | 継続納期超過への小さな追加ペナルティ |
| `baselineOperationalQuality` | 85（全社共通） | 既存フィクスチャに品質能力の値がなかったための中立的な暫定初期値 |

## 11. テスト総数・実行結果

- `app/lib/v2/quality/__tests__/`: 73件（操業リスク・品質結果・重大事故・スコア更新・納期観測・バッチ調整・完成品ロット品質情報・顧客信頼観測・状態更新・販売競争力接続）。
- `app/lib/v2/companyLab/__tests__/qualityIntegration.test.ts`: 7件（前期状態のみが成約へ反映されること、全スコア/比率/数量の範囲確認、5シナリオ×canonical/variation×32ターン完走、決定論性、重大事故発生の実在確認）。
- `app/lib/v2/persistence/__tests__/persistence.test.ts`: 既存37件+新規7件=44件（schemaVersion 3往復・後方互換・不正値拒否）。
- `app/lib/v2/companyLab/cli/__tests__/`: 既存21件（無変更、CLI出力拡張後も回帰なし）。
- 上記を含むリポジトリ全体: **710件、すべて成功**（既存623件+Phase 7A新規87件、既存テストの回帰なし）。

代表的な実行結果（5社×8/16/32ターン、`scripts/_verify_tmp/smoke_quality.ts`で確認、コミット前に削除済み）:

- 無負荷に近いターンでは`saleableRecoveryRatio≈0.993〜0.996`、観測品質70台後半、重大事故なし。
- 重大事故あり実行（`incident-search-*`シードで20シード中に発見）では、当該会社×工場×商品のみ`discardRatio`が一時的に跳ね上がり（`saleableRecoveryRatio`は最低0.90でフロア）、`majorIncidentTrustPenalty`により当該市場の顧客信頼が一時的に低下するが、翌期以降alpha=0.06（改善時）で緩やかに回復する——事故なし実行と比較して、単発事故で会社が恒久的に機能不全にならないことを確認した。
- 顧客信頼は品質・納期信頼性より変化幅が小さく、悪化後の回復に要するターン数が長い（alpha比較で構造的に保証、§7）。

## 12. TypeScript・ESLint・build結果

- `npx tsc --noEmit`: エラーなし（クリーン）。
- `npx eslint app/lib/v2/quality app/lib/v2/companyLab app/lib/v2/production app/lib/v2/persistence app/v2/company-lab`: エラー・警告なし（クリーン）。
- `npm run build`: TypeScriptコンパイルは成功（`Finished TypeScript`まで到達）。既知のV1 Redis環境変数未設定によるページデータ収集エラー（`/api/game/[gameCode]/admin/clone`、`STAGING_KV_REST_API_URL`未設定）が発生するが、これはPhase 7A着手前から存在する既知の問題であり、本Phaseの変更と無関係（V1コードは一切変更していない）。標準の受入条件（TypeScriptコンパイルまで成功し従来と同一）によりブロッカー扱いしない。

## 13. Phase 7Bで実装する予定のUI項目（対象外・申し送り）

- 会社ラボ画面（`/v2/company-lab`）への品質・顧客信頼・納期信頼性のグラフ・推移表示。
- 増産警告（`rampWarnings`）・重大事故発生のUI通知・アラート表示。
- 品質・信頼・納期信頼性の会社間比較ビュー。
- プレイヤーが品質・顧客関係へ影響する意思決定（例: QA投資、営業訪問強化）を行うための入力UI（本Phaseでは自動方針が既存の生産・販売方針からのみ決定する）。

本Phaseで行った最小限のUI追従（型追加に伴う必須変更のみ）: `app/v2/company-lab/decisionDraft.ts`の`SalesPlanDraftRow`へ`qualityReputation`/`customerRelationship`/`deliveryReliability`の3フィールドをパススルーとして追加（`costExpectation`と同じパターン、UI編集ロジックの追加は一切なし）。CLI（`companyLab/cli/output.ts`）のsummary/csv出力へ、品質・操業リスク・格落ち/再加工/廃棄量・重大事故件数・納期遵守率・顧客信頼・納期信頼性・増産警告を追加した（`npm run v2:company-simulate`で確認可能）。

## 14. Phase 8へ送る財務影響（対象外・申し送り）

- 廃棄量（`discardQuantity`）・再加工量（`reworkQuantity`）・格落ち量（`downgradeQuantity`）の財務計上（原価・評価損）。
- 重大事故発生時の追加費用（品質検査強化費・廃棄処分費・顧客対応費）の損益計上。
- 顧客信頼・納期信頼性の低下による、将来の価格プレミアム喪失・与信条件悪化等の財務的波及。
- QA・品質管理設備への投資意思決定と、その投資が`operationalRisk`・`baselineOperationalQuality`へ与える影響のモデル化。

いずれも本Phaseでは数量・スコアの追跡のみを行い、財務諸表・会計処理には一切接続していない（「再加工費・廃棄損・格落ち値引きの財務計上」は実装指示の明示的対象外）。

## 15. ブランド価値をまだ実装しない理由

三宅さんの事前検討（Phase 7A着手前の2段階提案）で「ブランド価値はまだ独立変数として実装しない」旨が明示的に確認されている。本Phaseはこの方針に従い、品質・顧客信頼・納期信頼性の3スコアのみを実装し、これらとは独立した「ブランド価値」という第4のスコア・状態は一切追加していない。会社アーキタイプによる差異（BAL/MASS/JPQ/VAP/CONSVの生産品質能力・既存関係の潜在的な差）についても、`baselineOperationalQuality`は全社共通の中立値（85）を採用し、アーキタイプ間の差別化は行っていない（§1で述べた通り、既存フィクスチャに参照できる品質能力・顧客関係の値が存在しなかったため）。理由: (1) ブランド価値の経済的意味（プレミアム価格の正当化、乗り換えコスト等）を、品質・顧客信頼・納期信頼性と独立に定義するには、価格形成モジュール（`sales/`・`market/`）側の追加設計が必要であり、Phase 7Aの純粋ロジック範囲を超える。(2) 現時点でアーキタイプ別の品質能力差を数値化する根拠（既存フィクスチャの値・ゲームデザイン上の意図）が確認できておらず、恣意的な係数を追加しないという開発ルール（「暫定係数は要校正と明記する」）に照らし、確認できない差は「作らない」方を選んだ。アーキタイプ別の生産品質能力差・既存関係差を導入する場合は、ゲームバランス調整フェーズ（またはPhase 7B以降）で、三宅さんの意図を確認したうえで`baselineOperationalQuality`・初期`trustByCompanyMarket`の会社別上書きとして追加できる構造にしてある（`QualityAdjustmentInput.baselineQualityOverride`が拡張点として既に用意されている）。
